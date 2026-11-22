// Payment preparation, authorization and reconciliation.
//
// Safety rules:
// - Every payment is reviewed and authorized individually with the wallet
//   password; the recovery phrase exists in memory only during execution.
// - The intent and attempt are persisted (encrypted) before anything can be
//   broadcast, so a crash at any point is recoverable.
// - An attempt whose outcome is uncertain blocks any retry until reconciled.
// - Cross-chain funding is not completion; refunds are never shown as paid.
import { isZcashError, type PaymentState, type Proposal } from "@zcashlabs/zcash.js";
import type { FiatQuote, NearQuoteView, PaymentView, RecipientSnapshot, SendDraft, SendReview } from "../../shared/types";
import {
	activeAttempts,
	assertRetryAllowed,
	createPayment,
	getAttempt,
	getPayment,
	setPaymentStatus,
	updateAnnotations,
	updateAttempt,
	updatePaymentTerms,
} from "../domain/payments";
import { cleanTags, cleanText, newId, now, parseZat } from "../domain/util";
import { describeError, type Engine } from "../engine/engine";
import { recordValuation, type RateService } from "../fiat/rates";
import { NearIntents, validateForeignAddress } from "../near/intents";
import type { TreasuryStore } from "../storage/treasury-store";

const REVIEW_TTL_MS = 10 * 60_000;
const NEAR_SAFETY_MS = 5 * 60_000;
const REQUIRED_CONFIRMATIONS = 3;

interface Review {
	readonly id: string;
	readonly paymentId: string | null;
	readonly attemptId: string;
	readonly draft: SendDraft & { recipient: RecipientSnapshot };
	readonly amountZat: bigint;
	readonly proposal: Proposal;
	readonly near: NearQuoteView | null;
	readonly expiresAt: number;
}

export interface PaymentServiceDeps {
	readonly store: TreasuryStore;
	readonly engine: Engine;
	readonly rates: RateService;
	readonly near: NearIntents;
	readonly currency: () => string;
	readonly openSeed: (password: string) => Promise<Uint8Array>;
	/** txid -> mined height (null while unmined) for the wallet's chain history. */
	readonly chainHistory: () => Promise<Map<string, number | null>>;
	readonly changed: () => void;
}

export class PaymentService {
	private reviews = new Map<string, Review>();
	private authorizing = false;
	private reconciling: Promise<void> | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(private readonly deps: PaymentServiceDeps) {}

	start() {
		void this.reconcile();
		this.timer = setInterval(() => void this.reconcile(), 20_000);
	}

	async stop() {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		for (const review of this.reviews.values()) await this.deps.engine.abandon(review.proposal.operationId);
		this.reviews.clear();
		await this.reconciling?.catch(() => {});
	}

	// ---- Validation ----

	async validateRecipient(recipient: RecipientSnapshot, memo: string | null) {
		if (recipient.route === "zcash") {
			const check = await this.deps.engine.validateAddress(recipient.address);
			if (!check.valid) throw new Error(`This is not a valid ${this.deps.engine.networkName} Zcash address.`);
			if (memo && !check.shielded) throw new Error("Transparent addresses cannot receive memos. Remove the memo or use a shielded address.");
		} else if (recipient.route === "near-intents") {
			if (this.deps.engine.networkName !== "mainnet") throw new Error("Cross-chain payments are only available on mainnet.");
			if (!recipient.asset) throw new Error("Choose the asset the recipient should receive.");
			const problem = validateForeignAddress(recipient.chain, recipient.address);
			if (problem) throw new Error(problem);
			if (memo) throw new Error("Cross-chain payments cannot carry a Zcash memo.");
		} else {
			throw new Error("Unknown payment route");
		}
	}

	// ---- Review ----

	async prepare(draft: SendDraft): Promise<SendReview> {
		const memo = draft.recipient.route === "zcash" ? cleanText(draft.memo, "Memo", 512) : null;
		if (memo && new TextEncoder().encode(memo).length > 512) throw new Error("Memos are limited to 512 bytes.");
		const clean = { ...draft, memo, note: cleanText(draft.note, "Note", 2000), tags: cleanTags(draft.tags) };
		if (draft.paymentId) assertRetryAllowed(this.deps.store.read((db) => getPayment(db, draft.paymentId!)));
		await this.validateRecipient(draft.recipient, memo);

		const { engine } = this.deps;
		const spendable = BigInt((await engine.balance()).view.spendable);
		const attemptId = newId();
		let amount: bigint;
		let proposal: Proposal;
		let near: NearQuoteView | null = null;

		if (draft.recipient.route === "zcash") {
			if (draft.amountZat === "max") {
				({ amount, proposal } = await this.proposeMax(spendable, draft.recipient.address, memo, attemptId));
			} else {
				amount = parseZat(draft.amountZat);
				if (amount <= 0n) throw new Error("Enter an amount greater than zero.");
				proposal = await engine.propose({ to: draft.recipient.address, amount, memo, idempotencyKey: attemptId });
			}
		} else {
			const refundTo = await engine.receiveAddress();
			if (draft.amountZat === "max") {
				// Size the deposit by estimating the fee against our own address, then quote the remainder.
				const estimate = await this.proposeMax(spendable, refundTo, null, `${attemptId}-estimate`);
				await engine.abandon(estimate.proposal.operationId);
				amount = estimate.amount;
			} else {
				amount = parseZat(draft.amountZat);
			}
			if (amount <= 0n) throw new Error("Enter an amount greater than zero.");
			near = await this.deps.near.quote({
				amountZat: amount,
				destinationAsset: draft.recipient.asset!,
				recipient: draft.recipient.address,
				refundTo,
			});
			const deposit = await engine.validateAddress(near.depositAddress);
			if (!deposit.valid) throw new Error("NEAR Intents returned a deposit address Zarca cannot verify.");
			try {
				proposal = await engine.propose({ to: near.depositAddress, amount, memo: null, idempotencyKey: attemptId });
			} catch (error) {
				if (draft.amountZat === "max") {
					throw new Error("The fee for the deposit transaction changed. Enter an amount slightly below your balance.");
				}
				throw error;
			}
		}

		const fee = proposal.totalFee;
		if (amount + fee > spendable) {
			await engine.abandon(proposal.operationId);
			throw new Error("Not enough spendable funds for this payment and its fee.");
		}
		const expiresAt = near
			? Math.min(Date.now() + REVIEW_TTL_MS, Date.parse(near.deadline) - NEAR_SAFETY_MS)
			: Date.now() + REVIEW_TTL_MS;
		const review: Review = {
			id: newId(),
			paymentId: draft.paymentId ?? null,
			attemptId,
			draft: clean,
			amountZat: amount,
			proposal,
			near,
			expiresAt,
		};
		this.reviews.set(review.id, review);
		setTimeout(() => void this.discard(review.id), Math.max(0, expiresAt - Date.now()) + 60_000);

		let fiat: FiatQuote | null = null;
		try {
			fiat = await this.deps.rates.current(this.deps.currency(), this.deps.store.db);
		} catch {
			fiat = null;
		}
		return {
			reviewId: review.id,
			paymentId: review.paymentId ?? "",
			recipient: draft.recipient,
			amountZat: amount.toString(),
			feeZat: fee.toString(),
			totalZat: (amount + fee).toString(),
			memo,
			fiat,
			near,
			expiresAt: new Date(expiresAt).toISOString(),
			spendableZat: spendable.toString(),
		};
	}

	private async proposeMax(spendable: bigint, to: string, memo: string | null, key: string) {
		let fee = 10_000n;
		for (let attempt = 0; attempt < 6; attempt++) {
			const amount = spendable - fee;
			if (amount <= 0n) throw new Error("The balance is too small to cover the network fee.");
			let proposal: Proposal;
			try {
				proposal = await this.deps.engine.propose({ to, amount, memo, idempotencyKey: `${key}-${attempt}` });
			} catch (error) {
				if (isZcashError(error) && error.code === "INSUFFICIENT_FUNDS") {
					fee += 5_000n;
					continue;
				}
				throw error;
			}
			if (proposal.totalFee === fee) return { amount, proposal };
			await this.deps.engine.abandon(proposal.operationId);
			fee = proposal.totalFee;
		}
		throw new Error("Could not size a maximum payment. Enter an amount instead.");
	}

	async discard(reviewId: string) {
		const review = this.reviews.get(reviewId);
		if (!review) return;
		this.reviews.delete(reviewId);
		await this.deps.engine.abandon(review.proposal.operationId);
	}

	// ---- Authorization ----

	async authorize(reviewId: string, password: string): Promise<PaymentView> {
		if (this.authorizing) throw new Error("Another payment is being authorized.");
		const review = this.reviews.get(reviewId);
		if (!review) throw new Error("This review is no longer valid. Review the payment again.");
		if (Date.now() > review.expiresAt) {
			await this.discard(reviewId);
			throw new Error(review.near ? "The quote expired. Get a new quote and review again." : "This review expired. Review the payment again.");
		}
		this.authorizing = true;
		let seed: Uint8Array | null = null;
		try {
			seed = await this.deps.openSeed(password); // throws on a wrong password; the review stays valid
			this.reviews.delete(reviewId);
			const { draft, amountZat, proposal, near } = review;

			// Persist intent and attempt before anything can reach the network.
			const paymentId = this.deps.store.write((db) => {
				let id = review.paymentId;
				if (id) {
					updatePaymentTerms(db, id, { recipient: draft.recipient, amountZat: amountZat.toString(), memo: draft.memo });
					updateAnnotations(db, id, draft.note, draft.tags);
				} else {
					id = createPayment(db, {
						recipient: draft.recipient,
						amountZat: amountZat.toString(),
						memo: draft.memo,
						dueDate: null,
						status: "submitting",
						note: draft.note,
						tags: draft.tags,
					});
				}
				db.run(
					"INSERT INTO attempts (id, payment_id, status, data, created_at, updated_at) VALUES (?, ?, 'preparing', ?, ?, ?)",
					[
						review.attemptId,
						id,
						JSON.stringify({
							operationId: proposal.operationId,
							txids: [],
							feeZat: proposal.totalFee.toString(),
							expiryHeight: Math.max(...proposal.steps.map((step) => step.expiryHeight)) || null,
							error: null,
							near: near ? { quote: near, providerStatus: null, destinationTxids: [], refundTxids: [], checkedAt: null } : null,
						}),
						now(),
						now(),
					],
				);
				setPaymentStatus(db, id, "submitting");
				return id;
			});
			this.deps.changed();

			try {
				const pending = await this.deps.engine.execute(proposal, seed);
				const snapshot = await pending.snapshot();
				const txids = snapshot.steps.map((s) => s.txid).filter((t): t is NonNullable<typeof t> => t !== null).map(String);
				this.deps.store.write((db) => {
					updateAttempt(db, review.attemptId, "submitted", { txids });
					setPaymentStatus(db, paymentId, "pending");
				});
				if (near && txids[0]) void this.deps.near.notifyDeposit(near.depositAddress, txids[0]);
			} catch (error) {
				await this.recordExecutionFailure(review.attemptId, paymentId, proposal.operationId, error);
			}
			this.deps.changed();
			return this.deps.store.read((db) => getPayment(db, paymentId, this.deps.currency()));
		} finally {
			seed?.fill(0);
			this.authorizing = false;
		}
	}

	private async recordExecutionFailure(attemptId: string, paymentId: string, operationId: string, error: unknown) {
		const described = describeError(error);
		let state: PaymentState | null = null;
		try {
			state = (isZcashError(error) && error.paymentState) || (await this.deps.engine.operation(operationId));
		} catch {
			state = null;
		}
		const dispatched = state?.steps.some((s) => s.attempts.length > 0) ?? true;
		const allRejected = state?.steps.every((s) => s.attempts.length > 0 && s.attempts.every((a) => a.outcome === "rejected")) ?? false;
		const txids = state?.steps.map((s) => s.txid).filter((t): t is NonNullable<typeof t> => t !== null).map(String) ?? [];
		this.deps.store.write((db) => {
			if (dispatched && !allRejected) {
				// Something may have reached the network: never allow a blind retry.
				updateAttempt(db, attemptId, "unknown", { error: described.message, txids });
				setPaymentStatus(db, paymentId, "unknown");
			} else {
				updateAttempt(db, attemptId, "failed", { error: described.message, txids });
				setPaymentStatus(db, paymentId, "failed");
			}
		});
		if (!dispatched) await this.deps.engine.abandon(operationId);
	}

	// ---- Reconciliation ----

	reconcile(): Promise<void> {
		this.reconciling ??= this.reconcileOnce().finally(() => {
			this.reconciling = null;
		});
		return this.reconciling;
	}

	private async reconcileOnce() {
		const attempts = this.deps.store.read((db) => activeAttempts(db));
		let changed = false;
		for (const attempt of attempts) {
			try {
				changed = (await this.reconcileAttempt(attempt.id)) || changed;
			} catch {
				// Leave the attempt as is; the next pass retries.
			}
		}
		if (changed) this.deps.changed();
	}

	/** Returns true if anything changed. */
	async reconcileAttempt(attemptId: string): Promise<boolean> {
		const { store, engine } = this.deps;
		const attempt = store.read((db) => getAttempt(db, attemptId));
		const before = JSON.stringify(attempt);
		if (!attempt.operationId) {
			store.write((db) => {
				updateAttempt(db, attemptId, "failed", { error: "The attempt was interrupted before a transaction was created." });
				setPaymentStatus(db, attempt.paymentId, "failed");
			});
			return true;
		}
		const state = await this.observe(attempt.operationId);
		if (!state) return this.reconcileFromChain(attempt, before);
		const txids = state.steps.map((s) => s.txid).filter((t): t is NonNullable<typeof t> => t !== null).map(String);
		const dispatched = state.steps.some((s) => s.attempts.length > 0);
		const mined = state.steps.length > 0 && state.steps.every((s) => s.inclusion !== null);
		const confirmed = state.phase === "complete" || (mined && state.steps.every((s) => (s.inclusion?.confirmations ?? 0) >= REQUIRED_CONFIRMATIONS));
		const expired = state.steps.some((s) => s.inclusion === null && s.expiry.reached === true);
		const rejected = dispatched && state.steps.every((s) => s.attempts.length > 0 && s.attempts.every((a) => a.outcome === "rejected"));

		if (attempt.status === "preparing" && !dispatched) {
			// Crashed between persisting the intent and sending: nothing left the wallet.
			await engine.abandon(attempt.operationId);
			store.write((db) => {
				updateAttempt(db, attemptId, "failed", { error: "Zarca stopped before this payment was sent. Nothing was broadcast." });
				setPaymentStatus(db, attempt.paymentId, "failed");
			});
			return true;
		}

		if (attempt.near) {
			return this.reconcileNear(attempt, state, { txids, mined, confirmed, expired, rejected }, before);
		}

		store.write((db) => {
			if (confirmed) {
				updateAttempt(db, attemptId, "confirmed", { txids, error: null });
				setPaymentStatus(db, attempt.paymentId, "completed", true);
			} else if (expired || rejected) {
				updateAttempt(db, attemptId, "failed", { txids, error: expired ? "The transaction expired without being mined. It can be sent again." : "The network rejected the transaction." });
				setPaymentStatus(db, attempt.paymentId, "failed");
			} else {
				// Evidence that the network has the transaction resolves an uncertain submission.
				const seen = state.steps.some(
					(s) =>
						s.inclusion !== null ||
						s.observation?.state === "mempool" ||
						s.observation?.state === "mined" ||
						s.attempts.some((a) => a.outcome === "acknowledged"),
				);
				const status = attempt.status === "unknown" && !seen ? "unknown" : "submitted";
				updateAttempt(db, attemptId, status, { txids });
				setPaymentStatus(db, attempt.paymentId, status === "unknown" ? "unknown" : "pending");
			}
		});
		if (confirmed) await this.recordSettlementValue(attempt.paymentId);
		return JSON.stringify(store.read((db) => getAttempt(db, attemptId))) !== before;
	}

	private async reconcileNear(
		attempt: ReturnType<typeof getAttempt>,
		_state: PaymentState | null,
		funding: { txids: string[]; mined: boolean; confirmed: boolean; expired: boolean; rejected: boolean },
		before: string,
	): Promise<boolean> {
		const { store } = this.deps;
		const near = attempt.near!;
		if (funding.expired || funding.rejected) {
			store.write((db) => {
				updateAttempt(db, attempt.id, "failed", {
					txids: funding.txids,
					error: "The funding transaction was never mined, so no ZEC reached NEAR Intents. It can be sent again with a new quote.",
				});
				setPaymentStatus(db, attempt.paymentId, "failed");
			});
			return true;
		}
		let report: Awaited<ReturnType<NearIntents["status"]>> | null = null;
		try {
			report = await this.deps.near.status(near.quote.depositAddress);
		} catch {
			report = null; // provider outage: keep the attempt pending, never invite a duplicate deposit
		}
		store.write((db) => {
			const nextNear = report
				? {
						...near,
						providerStatus: report.status,
						destinationTxids: report.destinationTxids.length ? report.destinationTxids : near.destinationTxids,
						refundTxids: report.refundTxids.length ? report.refundTxids : near.refundTxids,
						checkedAt: now(),
					}
				: near;
			if (report?.status === "SUCCESS") {
				updateAttempt(db, attempt.id, "confirmed", { txids: funding.txids, near: nextNear, error: null });
				setPaymentStatus(db, attempt.paymentId, "completed", true);
			} else if (report?.status === "REFUNDED") {
				updateAttempt(db, attempt.id, "failed", {
					txids: funding.txids,
					near: nextNear,
					error: `Refunded to the treasury${report.refundReason ? `: ${report.refundReason}` : ""}. The recipient was not paid.`,
				});
				setPaymentStatus(db, attempt.paymentId, "refunded");
			} else {
				const needsAttention = report?.status === "INCOMPLETE_DEPOSIT" || report?.status === "FAILED";
				updateAttempt(db, attempt.id, funding.txids.length ? "submitted" : attempt.status, {
					txids: funding.txids,
					near: nextNear,
					error: needsAttention ? `NEAR Intents reports ${report!.status.replace(/_/g, " ").toLowerCase()}; a refund is expected.` : null,
				});
				setPaymentStatus(db, attempt.paymentId, needsAttention ? "unknown" : "pending");
			}
		});
		if (report?.status === "SUCCESS") await this.recordSettlementValue(attempt.paymentId);
		return JSON.stringify(store.read((db) => getAttempt(db, attempt.id))) !== before;
	}

	/**
	 * Restored records reference operations from a previous wallet database.
	 * Without that journal, only chain evidence can settle them: a mined txid
	 * means paid; an expiry height that has passed without the txid means it can
	 * never be mined. Anything else stays unknown and blocks retries.
	 */
	private async reconcileFromChain(attempt: ReturnType<typeof getAttempt>, before: string): Promise<boolean> {
		const { store, engine } = this.deps;
		const sync = engine.syncState;
		if (sync.phase !== "synced" || sync.scannedHeight === null) return false;
		const history = await this.deps.chainHistory();
		const mined = attempt.txids.map((t) => history.get(t)).filter((h) => h !== undefined);
		const expiry = attempt.expiryHeight ?? null;
		store.write((db) => {
			if (attempt.txids.length && mined.length === attempt.txids.length && mined.every((h) => h !== null)) {
				if (attempt.near) {
					updateAttempt(db, attempt.id, "submitted", {});
					setPaymentStatus(db, attempt.paymentId, "pending");
				} else {
					updateAttempt(db, attempt.id, "confirmed", {});
					setPaymentStatus(db, attempt.paymentId, "completed", true);
				}
			} else if (attempt.status === "preparing" && !attempt.txids.length && expiry !== null && sync.scannedHeight! > expiry) {
				updateAttempt(db, attempt.id, "failed", { error: "Never mined before its expiry height. It can be sent again." });
				setPaymentStatus(db, attempt.paymentId, "failed");
			} else if (expiry !== null && sync.scannedHeight! > expiry + 10 && mined.length === 0) {
				updateAttempt(db, attempt.id, "failed", { error: "Not found on chain and past its expiry height, so it can no longer be mined." });
				setPaymentStatus(db, attempt.paymentId, "failed");
			} else {
				updateAttempt(db, attempt.id, "unknown", {
					error: "Restored from backup: waiting for chain evidence before this payment can be retried.",
				});
				setPaymentStatus(db, attempt.paymentId, "unknown");
			}
		});
		if (attempt.near && mined.length) return this.reconcileNear(store.read((db) => getAttempt(db, attempt.id)), null, {
			txids: attempt.txids as string[], mined: true, confirmed: true, expired: false, rejected: false,
		}, before);
		return JSON.stringify(store.read((db) => getAttempt(db, attempt.id))) !== before;
	}

	/** Refreshes network observation for an operation, bounded in time. */
	private async observe(operationId: string): Promise<PaymentState | null> {
		const { engine } = this.deps;
		const local = await engine.operation(operationId);
		if (!local) return null;
		if (local.phase === "complete" || local.phase === "abandoned" || !local.steps.some((s) => s.attempts.length > 0)) return local;
		try {
			const pending = await engine.wallet.operations.resume({ operationId });
			const confirmation = await pending.wait({ confirmations: REQUIRED_CONFIRMATIONS, timeoutMs: 8_000 });
			return confirmation.snapshot;
		} catch (error) {
			if (isZcashError(error) && error.paymentState) return error.paymentState;
			return engine.operation(operationId);
		}
	}

	private async recordSettlementValue(paymentId: string) {
		try {
			const quote = await this.deps.rates.current(this.deps.currency(), this.deps.store.db);
			if (quote && !quote.stale) this.deps.store.write((db) => recordValuation(db, `payment:${paymentId}`, quote));
		} catch {
			// Valuation is secondary; a missing rate is shown as unavailable.
		}
	}

	/** Abandons proposals left behind by a crash that never got an attempt record. */
	async sweepStrayProposals() {
		const { engine, store } = this.deps;
		const known = new Set(
			store.read((db) => (db.query("SELECT data FROM attempts").all() as { data: string }[]).map((r) => JSON.parse(r.data).operationId as string)),
		);
		let cursor: string | undefined;
		do {
			const page = await engine.wallet.operations.list({ limit: 200, ...(cursor ? { cursor } : {}) });
			for (const op of page.items) {
				if (op.phase === "proposed" && !known.has(op.operationId)) await engine.abandon(op.operationId);
			}
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
	}
}

