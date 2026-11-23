// Thin, lifecycle-owning wrapper around one zcash.js wallet database.
// Exactly one engine is open at a time (the unlocked wallet). Closing it stops
// sync and releases the database; the encryption key is never retained here.
import {
	accountIndex,
	addresses,
	createLightClient,
	createWalletClient,
	resolveBirthday,
	type AccountId,
	type HistoryEntry,
	type MemorySigner,
	type PaymentState,
	type PendingPayment,
	type Proposal,
	type SyncStatus,
	type TransactionPolicy,
	type WalletBalance,
	type WalletClient,
	type WalletTransaction,
} from "@zcashlabs/zcash.js";
import type { BalanceView, NetworkName, SyncState } from "../../shared/types";
import { describeError, EngineError, isSdkError } from "./errors";

export { describeError, EngineError };
import { networkFor, nu7Height } from "./networks";

export interface EngineOptions {
	readonly path: string;
	readonly network: NetworkName;
	readonly server: string;
	readonly encryptionKey: Uint8Array;
	/** "migration" spends only older pools (transparent, Sapling) with change into Ironwood. */
	readonly policy?: "default" | "migration";
}

const MIGRATION_POLICY: TransactionPolicy = {
	spendPools: ["transparent", "sapling"],
	transparent: "allow-owned",
	changePool: "ironwood",
	feeRule: "zip317-standard",
	confirmations: { trusted: 3, untrusted: 3, allowZeroConfirmationShielding: false },
	expiry: { kind: "offset", blocks: 80 },
	lockExpiryBlocks: 20,
	shieldingThreshold: 10_000n,
	freshness: { mode: "require-synced", maxLagBlocks: 0 },
};

export interface MigrationStep {
	readonly pool: "transparent" | "sapling";
	readonly amount: bigint;
	readonly fee: bigint;
	readonly proposal: Proposal;
}

const RECEIVE_REQUEST = { format: "unified", transparent: "omit", sapling: "omit", ironwood: "require" } as const;

export class Engine {
	private syncAbort: AbortController | null = null;
	private syncTask: Promise<void> | null = null;
	private closed = false;
	private listeners = new Set<(state: SyncState) => void>();
	private lastSync: SyncState = {
		phase: "connecting",
		tipHeight: null,
		scannedHeight: null,
		progress: null,
		error: null,
		updatedAt: new Date().toISOString(),
	};
	private scanStartHeight: number | null = null;

	private constructor(
		readonly wallet: WalletClient,
		readonly networkName: NetworkName,
		readonly server: string,
		private account: AccountId | null,
	) {}

	static async open(options: EngineOptions): Promise<Engine> {
		const network = await networkFor(options.network);
		let wallet: WalletClient;
		try {
			wallet = await createWalletClient(options.server, {
				network,
				storage: { kind: "node-filesystem", path: options.path, encryptionKey: options.encryptionKey },
				recovery: { mode: "online", timeoutMs: 15_000 },
				// watchSync holds a job for its lifetime; reconciliation and view refreshes overlap.
				runtime: { maxQueuedJobs: 32 },
				...(options.policy === "migration" ? { transactionPolicy: MIGRATION_POLICY } : {}),
			});
		} catch (error) {
			throw describeError(error);
		}
		const accounts = await wallet.accounts.list();
		return new Engine(wallet, options.network, options.server, accounts[0]?.id ?? null);
	}

	get accountId(): AccountId {
		if (!this.account) throw new EngineError("The wallet has no account yet.", "NO_ACCOUNT");
		return this.account;
	}

	get hasAccount() {
		return this.account !== null;
	}

	/** New wallet: anchor the birthday at the current tip. */
	async createAccount(mnemonic: Uint8Array) {
		const status = await this.wallet.sync();
		if (!status.targetReached) throw new EngineError("Could not reach the network to create the wallet.", "SYNC_REQUIRED", true);
		const created = await this.wallet.accounts.create({ mnemonic, name: "Treasury" });
		await created.signer.dispose();
		this.account = created.account.id;
		return created.account;
	}

	/** Restored wallet: scan from a birthday derived from an approximate creation date. */
	async importAccount(mnemonic: Uint8Array, createdAfter: Date | null) {
		let birthday: Awaited<ReturnType<typeof resolveBirthday>> | "fullScan" = "fullScan";
		if (createdAfter) {
			const height = await this.estimateHeight(createdAfter);
			if (height !== null) {
				const light = await createLightClient(this.server, { network: this.wallet.network });
				birthday = await resolveBirthday({ light, firstScanHeight: height });
			}
		}
		const imported = await this.wallet.accounts.import({
			mnemonic,
			accountIndex: accountIndex(0),
			birthday,
			name: "Treasury",
		});
		await imported.signer.dispose();
		this.account = imported.account.id;
		return imported.account;
	}

	/** Conservative block height for a date: one week earlier than the estimate. */
	private async estimateHeight(date: Date): Promise<number | null> {
		const tip = await this.tipFromServer();
		if (!tip) return null;
		const nu7 = nu7Height(this.networkName);
		let seconds = Math.max(0, (Date.now() - date.getTime()) / 1000) + 7 * 86_400;
		// Walk back from the tip: 25 s blocks after NU7, 75 s before it.
		const afterNu7 = Math.max(0, tip - nu7);
		const fast = Math.min(afterNu7, Math.floor(seconds / 25));
		seconds -= fast * 25;
		const height = tip - fast - Math.floor(seconds / 75);
		const sapling = this.networkName === "mainnet" ? 419_200 : 280_000;
		return Math.max(sapling + 1, height);
	}

	private async tipFromServer(): Promise<number | null> {
		try {
			const light = await createLightClient(this.server, { network: this.wallet.network });
			const tip = await light.getTip({ signal: AbortSignal.timeout(15_000) });
			return tip.height;
		} catch {
			return null;
		}
	}

	onSync(listener: (state: SyncState) => void) {
		this.listeners.add(listener);
		listener(this.lastSync);
		return () => this.listeners.delete(listener);
	}

	get syncState() {
		return this.lastSync;
	}

	private emit(state: Partial<SyncState>) {
		this.lastSync = { ...this.lastSync, ...state, updatedAt: new Date().toISOString() };
		for (const listener of this.listeners) listener(this.lastSync);
	}

	private mapStatus(status: SyncStatus) {
		const tip = status.scan.tipHeight;
		const scanned = status.scan.fullyScannedHeight;
		if (this.scanStartHeight === null && scanned !== null) this.scanStartHeight = scanned;
		let progress: number | null = null;
		if (tip !== null && scanned !== null) {
			const start = this.scanStartHeight ?? scanned;
			progress = tip <= start ? 1 : Math.min(1, Math.max(0, (scanned - start) / (tip - start)));
		}
		// Following the tip a few blocks behind is still "synced"; avoids flicker on every new block.
		const nearTip = tip !== null && scanned !== null && tip - scanned <= 3 && this.lastSync.phase === "synced";
		const synced = (status.targetReached && status.activity !== "running") || (nearTip && status.activity !== "failed");
		this.emit({
			phase: status.activity === "failed" ? "error" : synced ? "synced" : "syncing",
			tipHeight: tip,
			scannedHeight: scanned,
			progress: synced ? 1 : progress,
			error: status.lastError ? describeError(Object.assign(new Error(status.lastError.message), status.lastError)).message : null,
		});
	}

	/** Starts continuous background sync; restarts after transient failures. */
	startSync() {
		if (this.syncTask || this.closed) return;
		const abort = new AbortController();
		this.syncAbort = abort;
		this.syncTask = (async () => {
			let delay = 5_000;
			while (!abort.signal.aborted) {
				try {
					this.emit({ phase: this.lastSync.phase === "synced" ? "synced" : "syncing", error: null });
					for await (const status of this.wallet.watchSync({ signal: abort.signal })) {
						this.mapStatus(status);
						delay = 5_000;
					}
				} catch (error) {
					if (abort.signal.aborted) break;
					this.emit({ phase: "error", error: describeError(error).message });
				}
				if (abort.signal.aborted) break;
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, delay);
					abort.signal.addEventListener("abort", () => {
						clearTimeout(timer);
						resolve();
					}, { once: true });
				});
				delay = Math.min(delay * 2, 120_000);
			}
		})().finally(() => {
			this.syncTask = null;
		});
	}

	async stopSync(quiet = false) {
		this.syncAbort?.abort();
		await this.syncTask?.catch(() => {});
		this.syncAbort = null;
		if (!quiet) this.emit({ phase: "stopped" });
	}

	private pauseDepth = 0;
	/**
	 * Proposals require a wallet synced to the tip it last observed. The continuous
	 * watcher observes new tips (every ~25 s) while work is in flight, so proposing
	 * and sending run with background sync paused after a finite catch-up.
	 */
	private async paused<T>(fn: () => Promise<T>): Promise<T> {
		const resume = this.pauseDepth === 0 && this.syncTask !== null;
		this.pauseDepth++;
		try {
			if (resume) await this.stopSync(true);
			return await fn();
		} finally {
			this.pauseDepth--;
			if (resume && !this.closed) this.startSync();
		}
	}

	private inflight = new Map<string, Promise<unknown>>();
	/**
	 * Concurrent identical reads share one wallet call. Every change event makes each
	 * open view refetch at once, and the wallet admits a bounded number of jobs.
	 */
	private shared<T>(key: string, load: () => Promise<T>): Promise<T> {
		const existing = this.inflight.get(key) as Promise<T> | undefined;
		if (existing) return existing;
		const promise = load().finally(() => this.inflight.delete(key));
		this.inflight.set(key, promise);
		return promise;
	}

	balance(): Promise<{ view: BalanceView; raw: WalletBalance }> {
		return this.shared("balance", () => this.loadBalance());
	}

	private async loadBalance(): Promise<{ view: BalanceView; raw: WalletBalance }> {
		const raw = await this.wallet.getBalance({ accountId: this.accountId });
		const a = raw.amounts;
		if (!a) {
			return {
				raw,
				view: { available: false, total: "0", spendable: "0", pending: "0", locked: "0", unshielded: "0" },
			};
		}
		const pools = [a.sapling, a.ironwood, a.transparent.regular];
		const sum = (pick: (b: (typeof pools)[number]) => bigint) => pools.reduce((n, b) => n + pick(b), 0n);
		const unshielded = a.transparent.regular.total + a.transparent.coinbase.total;
		const legacy = a.unsupportedLegacy?.balance.total ?? 0n;
		return {
			raw,
			view: {
				available: true,
				total: a.total.toString(),
				// Spending is Ironwood-only under the default policy.
				spendable: a.ironwood.spendable.toString(),
				pending: sum((b) => b.changePendingConfirmation + b.pendingSpendability).toString(),
				locked: sum((b) => b.locked).toString(),
				unshielded: (unshielded + a.sapling.total + legacy).toString(),
			},
		};
	}

	history(): Promise<HistoryEntry[]> {
		return this.shared("history", () => this.loadHistory());
	}

	private async loadHistory(): Promise<HistoryEntry[]> {
		const out: HistoryEntry[] = [];
		let cursor: string | undefined;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				out.length = 0;
				cursor = undefined;
				do {
					const page = await this.wallet.getHistory({ accountId: this.accountId, limit: 200, ...(cursor ? { cursor } : {}) });
					out.push(...page.items);
					cursor = page.nextCursor ?? undefined;
				} while (cursor);
				return out;
			} catch (error) {
				if (!(isSdkError(error) && error.code === "CURSOR_STALE")) throw describeError(error);
			}
		}
		throw new EngineError("Wallet history kept changing; try again.", "CURSOR_STALE", true);
	}

	transaction(txid: string): Promise<WalletTransaction | null> {
		return this.wallet.getTransaction({ txid: txid as WalletTransaction["txid"] });
	}

	/** The current receiving address; allocates the first one if none exists. */
	async receiveAddress(fresh = false): Promise<string> {
		const accountId = this.accountId;
		if (!fresh) {
			const current = await this.wallet.addresses.current({ accountId, request: RECEIVE_REQUEST });
			if (current) return current;
		}
		return (await this.wallet.addresses.next({ accountId, request: RECEIVE_REQUEST })).address;
	}

	async validateAddress(address: string): Promise<{ valid: boolean; shielded: boolean; transparent: boolean }> {
		try {
			const decoded = await addresses.decode({ network: this.wallet.network, address });
			const shielded = decoded.knownReceivers.some((r) => r === "sapling" || r === "orchard");
			const transparent = decoded.knownReceivers.some((r) => r === "p2pkh" || r === "p2sh");
			return { valid: decoded.knownReceivers.length > 0, shielded, transparent };
		} catch {
			return { valid: false, shielded: false, transparent: false };
		}
	}

	/** Keeps background sync paused while `fn` proposes, signs and broadcasts. Re-entrant. */
	holdSync<T>(fn: () => Promise<T>): Promise<T> {
		return this.paused(fn);
	}

	propose(args: { to: string; amount: bigint; memo: string | null; idempotencyKey: string }): Promise<Proposal> {
		return this.paused(() => this.proposeSynced(args));
	}

	private async proposeSynced(args: { to: string; amount: bigint; memo: string | null; idempotencyKey: string }): Promise<Proposal> {
		try {
			return await this.fresh(() => this.proposeOnce(args));
		} catch (error) {
			throw describeError(error);
		}
	}

	/**
	 * Runs a proposal, catching up when the wallet is not fresh. Freshness also
	 * requires pending transaction enhancement to be resolved, which a finite sync
	 * may leave for its next pass (zcashlabs/zcashjs#35). Other errors pass through raw.
	 */
	private async fresh<T>(propose: () => Promise<T>): Promise<T> {
		for (let round = 0; ; round++) {
			try {
				return await propose();
			} catch (error) {
				if (!(isSdkError(error) && error.code === "SYNC_REQUIRED") || round >= 4) throw error;
			}
			try {
				await this.wallet.sync({ signal: AbortSignal.timeout(90_000) });
			} catch {
				// A failed catch-up surfaces as SYNC_REQUIRED on the next attempt.
			}
			if (round > 0) await Bun.sleep(1_000 * round);
		}
	}

	private async proposeOnce(args: { to: string; amount: bigint; memo: string | null; idempotencyKey: string }): Promise<Proposal> {
		{
			return await this.wallet.propose({
				accountId: this.accountId,
				to: args.to,
				amount: args.amount,
				...(args.memo ? { memo: { text: args.memo } } : {}),
				idempotencyKey: args.idempotencyKey,
			});
		}
	}

	/**
	 * Proposes moving funds from older pools into Ironwood (requires an engine
	 * opened with the migration policy): shield transparent funds, then send
	 * Sapling funds to the wallet's own Ironwood address.
	 */
	async proposeMigration(key: string): Promise<MigrationStep[]> {
		const steps: MigrationStep[] = [];
		const balance = (await this.balance()).raw.amounts;
		if (!balance) throw new EngineError("Balances are not available yet; wait for sync to finish.", "SYNC_REQUIRED", true);
		if (balance.transparent.regular.spendable > 0n) {
			try {
				const proposal = await this.fresh(() => this.wallet.propose({ kind: "shield", accountId: this.accountId, toPool: "ironwood", idempotencyKey: `${key}-t` }));
				const amount = proposal.steps.reduce((n, s) => n + s.inputs.reduce((m, i) => m + i.value, 0n), 0n) - proposal.totalFee;
				steps.push({ pool: "transparent", amount, fee: proposal.totalFee, proposal });
			} catch (error) {
				if (!(isSdkError(error) && error.code === "NOTHING_TO_SHIELD")) throw describeError(error);
			}
		}
		const sapling = balance.sapling.spendable;
		if (sapling > 0n) {
			const to = await this.receiveAddress();
			let fee = 10_000n;
			for (let attempt = 0; attempt < 5; attempt++) {
				if (sapling <= fee) break;
				let proposal: Proposal;
				try {
					proposal = await this.fresh(() => this.wallet.propose({ accountId: this.accountId, to, amount: sapling - fee, idempotencyKey: `${key}-s${attempt}` }));
				} catch (error) {
					if (isSdkError(error) && error.code === "INSUFFICIENT_FUNDS") {
						fee += 5_000n;
						continue;
					}
					throw describeError(error);
				}
				if (proposal.totalFee === fee) {
					steps.push({ pool: "sapling", amount: sapling - fee, fee, proposal });
					break;
				}
				await this.abandon(proposal.operationId);
				fee = proposal.totalFee;
			}
		}
		return steps;
	}

	async abandon(operationId: string) {
		try {
			await this.wallet.operations.abandon({ operationId });
		} catch {
			// Already built or finalized operations cannot be abandoned; reconciliation handles them.
		}
	}

	/** Executes exactly the reviewed proposal with a signer restored for this authorization only. */
	execute(proposal: Proposal, mnemonic: Uint8Array): Promise<PendingPayment> {
		return this.paused(() => this.executeNow(proposal, mnemonic));
	}

	private async executeNow(proposal: Proposal, mnemonic: Uint8Array): Promise<PendingPayment> {
		let signer: MemorySigner | null = null;
		try {
			signer = await this.wallet.accounts.restoreSigner({ accountId: this.accountId, mnemonic });
			return await this.wallet.send({ proposal, signer });
		} finally {
			await signer?.dispose();
		}
	}

	operation(operationId: string): Promise<PaymentState | null> {
		return this.wallet.operations.get({ operationId });
	}

	/** Finite catch-up to the current tip; callers hold background sync (holdSync). */
	async catchUp(): Promise<void> {
		await this.wallet.sync({ signal: AbortSignal.timeout(90_000) });
	}

	async broadcast(operationId: string): Promise<PaymentState> {
		return this.wallet.broadcast({ operationId });
	}

	async close() {
		if (this.closed) return;
		this.closed = true;
		await this.stopSync();
		this.listeners.clear();
		await this.wallet.close();
	}
}
