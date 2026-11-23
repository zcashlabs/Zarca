import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomKey } from "../../src/bun/security/crypto";
import { TreasuryStore } from "../../src/bun/storage/treasury-store";
import { PaymentService } from "../../src/bun/payments/service";
import { IncorrectPasswordError } from "../../src/bun/security/vault";
import { createAttempt, createPayment, getPayment, listPayments, updateAttempt } from "../../src/bun/domain/payments";
import { NoRates } from "../../src/bun/fiat/rates";
import type { Engine } from "../../src/bun/engine/engine";
import type { NearIntents } from "../../src/bun/near/intents";
import type { RecipientSnapshot } from "../../src/shared/types";

type Step = {
	txid: string | null;
	attempts: { outcome: "started" | "acknowledged" | "rejected" | "unknown" }[];
	inclusion: { height: number; confirmations: number | null } | null;
	observation: { state: string } | null;
	expiry: { reached: boolean | null };
};
type Op = { operationId: string; phase: string; steps: Step[] };

class FakeEngine {
	networkName = "testnet" as const;
	spendable = 10_000_000n;
	ops = new Map<string, Op>();
	abandoned: string[] = [];
	executeImpl: (operationId: string) => Promise<void> = async () => {};
	onExecute: () => void = () => {};
	syncState = { phase: "synced", scannedHeight: 1000, tipHeight: 1000, progress: 1, error: null, updatedAt: "" };
	private next = 0;
	async validateAddress(address: string) {
		return { valid: address.startsWith("utest") || address.startsWith("tm"), shielded: address.startsWith("utest"), transparent: address.startsWith("tm") };
	}
	async balance() {
		return { view: { available: true, total: String(this.spendable), spendable: String(this.spendable), pending: "0", locked: "0", unshielded: "0" } };
	}
	async receiveAddress() {
		return "utest-own";
	}
	async propose(args: { amount: bigint; idempotencyKey: string }) {
		if (args.amount + 10_000n > this.spendable) {
			throw Object.assign(new Error("insufficient"), { code: "INSUFFICIENT_FUNDS", name: "ZcashError", stage: "proposal", retryable: false, recovery: "correct-input" });
		}
		const operationId = `op-${++this.next}`;
		this.ops.set(operationId, { operationId, phase: "proposed", steps: [] });
		return { operationId, totalFee: 10_000n, steps: [{ expiryHeight: 1080 }] };
	}
	holdDepth = 0;
	async holdSync<T>(fn: () => Promise<T>) {
		this.holdDepth++;
		try {
			return await fn();
		} finally {
			this.holdDepth--;
		}
	}
	async abandon(operationId: string) {
		this.abandoned.push(operationId);
		const op = this.ops.get(operationId);
		if (op && op.phase === "proposed") op.phase = "abandoned";
	}
	async execute(proposal: { operationId: string }) {
		this.onExecute();
		await this.executeImpl(proposal.operationId);
		const op = this.ops.get(proposal.operationId)!;
		op.phase = "observing";
		op.steps = [{ txid: `tx-${proposal.operationId}`, attempts: [{ outcome: "acknowledged" }], inclusion: null, observation: { state: "mempool" }, expiry: { reached: false } }];
		return { snapshot: async () => op };
	}
	async operation(operationId: string) {
		return this.ops.get(operationId) ?? null;
	}
	wallet = {
		operations: {
			resume: async ({ operationId }: { operationId: string }) => ({
				wait: async () => {
					const op = this.ops.get(operationId)!;
					if (op.phase === "complete") return { snapshot: op };
					throw Object.assign(new Error("timeout"), { code: "TIMEOUT", paymentState: op });
				},
			}),
			list: async () => ({ items: [...this.ops.values()], nextCursor: null }),
		},
	};
}

const recipient: RecipientSnapshot = {
	contactId: null, contactName: "Alice", destinationLabel: null, route: "zcash", chain: "zcash", asset: null, assetSymbol: "ZEC", address: "utest1alice",
};

let store: TreasuryStore;
let engine: FakeEngine;
let service: PaymentService;
let near: { status: (address: string) => Promise<unknown>; quote: () => Promise<unknown>; notifyDeposit: () => Promise<void> };
let history: Map<string, number | null>;

function make() {
	return new PaymentService({
		store,
		engine: engine as unknown as Engine,
		rates: new NoRates(),
		near: near as unknown as NearIntents,
		currency: () => "USD",
		openSeed: async (password) => {
			if (password !== "pw") throw new IncorrectPasswordError();
			return new Uint8Array([1, 2, 3]);
		},
		chainHistory: async () => history,
		changed: () => {},
	});
}

beforeEach(() => {
	store = TreasuryStore.open(join(mkdtempSync(join(tmpdir(), "zarca-pay-")), "t.bin"), "w", randomKey());
	engine = new FakeEngine();
	near = { status: async () => ({ status: "PENDING_DEPOSIT", destinationTxids: [], refundTxids: [], originTxids: [], refundedAmount: null, refundReason: null, amountOutFormatted: null }), quote: async () => { throw new Error("unused"); }, notifyDeposit: async () => {} };
	history = new Map();
	service = make();
});

const draft = { recipient, amountZat: "100000", memo: "hello", note: "private", tags: ["Ops"] };

describe("payment authorization", () => {
	test("intent and attempt are durable before execution; result is pending with txids", async () => {
		const review = await service.prepare(draft);
		expect(review.totalZat).toBe("110000");
		engine.onExecute = () => {
			const [payment] = store.read((db) => listPayments(db));
			expect(payment!.status).toBe("submitting");
			expect(payment!.attempts[0]!.status).toBe("preparing");
			// The reviewed proposal (op-1) is rebuilt with identical terms right before signing.
			expect(payment!.attempts[0]!.operationId).toBe("op-2");
		};
		const payment = await service.authorize(review.reviewId, "pw");
		expect(payment.status).toBe("pending");
		expect(payment.attempts[0]!.txids).toEqual(["tx-op-2"]);
		expect(engine.abandoned).toContain("op-1");
		expect(payment.note).toBe("private");
		expect(payment.memo).toBe("hello");
	});

	test("reconciliation never touches an attempt that is executing", async () => {
		engine.executeImpl = async () => {
			// The 20 s reconciliation timer fires while proving is still running.
			await service.reconcile();
		};
		const payment = await service.authorize((await service.prepare(draft)).reviewId, "pw");
		expect(payment.status).toBe("pending");
		expect(payment.attempts[0]!.error).toBeNull();
		expect(engine.abandoned).not.toContain(payment.attempts[0]!.operationId);
	});

	test("a wrong password keeps the review usable and sends nothing", async () => {
		const review = await service.prepare(draft);
		await expect(service.authorize(review.reviewId, "nope")).rejects.toBeInstanceOf(IncorrectPasswordError);
		expect(store.read((db) => listPayments(db))).toHaveLength(0);
		expect((await service.authorize(review.reviewId, "pw")).status).toBe("pending");
		await expect(service.authorize(review.reviewId, "pw")).rejects.toThrow("no longer valid");
	});

	test("memos are refused for transparent recipients", async () => {
		await expect(service.prepare({ ...draft, recipient: { ...recipient, address: "tmTransparent" } })).rejects.toThrow("memo");
	});

	test("failure before dispatch is retryable; uncertain dispatch blocks retry", async () => {
		engine.executeImpl = async () => {
			throw Object.assign(new Error("proving failed"), { code: "PROOF_FAILED" });
		};
		const first = await service.authorize((await service.prepare(draft)).reviewId, "pw");
		expect(first.status).toBe("failed");
		expect(engine.abandoned).toContain("op-1");
		// Retry the same payment.
		engine.executeImpl = async (operationId) => {
			engine.ops.get(operationId)!.steps = [{ txid: "tx-x", attempts: [{ outcome: "unknown" }], inclusion: null, observation: null, expiry: { reached: false } }];
			throw Object.assign(new Error("lost response"), { code: "SUBMISSION_UNKNOWN" });
		};
		const second = await service.authorize((await service.prepare({ ...draft, paymentId: first.id })).reviewId, "pw");
		expect(second.id).toBe(first.id);
		expect(second.status).toBe("unknown");
		await expect(service.prepare({ ...draft, paymentId: first.id })).rejects.toThrow("still unknown");
	});

	test("expired reviews cannot be authorized", async () => {
		const review = await service.prepare(draft);
		const internal = (service as unknown as { reviews: Map<string, { expiresAt: number }> }).reviews.get(review.reviewId)!;
		internal.expiresAt = Date.now() - 1;
		await expect(service.authorize(review.reviewId, "pw")).rejects.toThrow("expired");
		expect(engine.abandoned).toContain("op-1");
	});
});

describe("stale proposals", () => {
	test("a block arriving before signing is retried with identical terms", async () => {
		let stale = 1;
		engine.executeImpl = async () => {
			if (stale-- > 0) throw Object.assign(new Error("stale"), { code: "STALE_PROPOSAL", stage: "proposal", retryable: false });
		};
		const payment = await service.authorize((await service.prepare(draft)).reviewId, "pw");
		expect(payment.status).toBe("pending");
		expect(payment.attempts).toHaveLength(1);
		expect(payment.attempts[0]!.operationId).toBe("op-3");
		expect(engine.abandoned).toEqual(expect.arrayContaining(["op-1", "op-2"]));
	});

	test("a wallet that fell behind at signing catches up and sends once, with sync held throughout", async () => {
		let behind = 1;
		const heldDuringExecute: number[] = [];
		engine.executeImpl = async () => {
			heldDuringExecute.push(engine.holdDepth);
			if (behind-- > 0) throw Object.assign(new Error("behind"), { code: "SYNC_REQUIRED", stage: "proposal", retryable: true });
		};
		const payment = await service.authorize((await service.prepare(draft)).reviewId, "pw");
		expect(payment.status).toBe("pending");
		expect(payment.attempts).toHaveLength(1);
		expect(heldDuringExecute).toEqual([1, 1]);
		expect(engine.holdDepth).toBe(0);
	});

	test("a changed fee requires a new review and sends nothing", async () => {
		const review = await service.prepare(draft);
		const original = engine.propose.bind(engine);
		engine.propose = async (args) => ({ ...(await original(args)), totalFee: 20_000n });
		await expect(service.authorize(review.reviewId, "pw")).rejects.toThrow("fee changed");
		expect(store.read((db) => listPayments(db))).toHaveLength(0);
	});
});

describe("reconciliation", () => {
	test("confirmation completes the payment; expiry fails it safely", async () => {
		const ok = await service.authorize((await service.prepare(draft)).reviewId, "pw");
		const op = engine.ops.get("op-2")!;
		op.phase = "complete";
		op.steps[0]!.inclusion = { height: 990, confirmations: 11 };
		await service.reconcile();
		const done = store.read((db) => getPayment(db, ok.id));
		expect(done.status).toBe("completed");
		expect(done.settledAt).not.toBeNull();

		const second = await service.authorize((await service.prepare(draft)).reviewId, "pw");
		const op2 = engine.ops.get("op-4")!;
		op2.steps[0]!.expiry = { reached: true };
		op2.steps[0]!.observation = { state: "notSeen" };
		await service.reconcile();
		expect(store.read((db) => getPayment(db, second.id)).status).toBe("failed");
	});

	test("a crash between persisting intent and sending leaves a failed, retryable payment", async () => {
		const id = store.write((db) => {
			const paymentId = createPayment(db, { recipient, amountZat: "5", memo: null, dueDate: null, status: "submitting", note: null, tags: [] });
			createAttempt(db, paymentId, { operationId: "op-crash" });
			return paymentId;
		});
		engine.ops.set("op-crash", { operationId: "op-crash", phase: "proposed", steps: [] });
		await service.reconcile();
		const payment = store.read((db) => getPayment(db, id));
		expect(payment.status).toBe("failed");
		expect(engine.abandoned).toContain("op-crash");
	});

	test("restored attempts settle only on chain evidence", async () => {
		const ids = store.write((db) =>
			["tx-mined", "tx-gone", "tx-wait"].map((txid, i) => {
				const paymentId = createPayment(db, { recipient, amountZat: "5", memo: null, dueDate: null, status: "pending", note: null, tags: [] });
				const attempt = createAttempt(db, paymentId, { operationId: `old-${i}`, txids: [txid], expiryHeight: i === 2 ? 2000 : 900 });
				updateAttempt(db, attempt, "submitted");
				return paymentId;
			}),
		);
		history.set("tx-mined", 950);
		await service.reconcile();
		const status = ids.map((id) => store.read((db) => getPayment(db, id)).status);
		expect(status).toEqual(["completed", "failed", "unknown"]);
	});

	test("cross-chain: funding is not completion; refunds are never paid", async () => {
		const ids = store.write((db) =>
			["SUCCESS", "REFUNDED", "PROCESSING"].map((providerStatus, i) => {
				const paymentId = createPayment(db, { recipient: { ...recipient, route: "near-intents", chain: "eth", asset: "nep141:usdc", assetSymbol: "USDC", address: "0x" + "1".repeat(40) }, amountZat: "5", memo: null, dueDate: null, status: "pending", note: null, tags: [] });
				const attempt = createAttempt(db, paymentId, {
					operationId: `near-${i}`,
					txids: [`f-${i}`],
					near: { quote: { depositAddress: providerStatus, amountIn: "5", amountOut: "1", amountOutFormatted: "1", minAmountOut: "1", assetSymbol: "USDC", deadline: "", quotedAt: "", timeEstimateSeconds: null, feeUsd: null, refundTo: "utest-own" }, providerStatus: null, destinationTxids: [], refundTxids: [], checkedAt: null },
				});
				updateAttempt(db, attempt, "submitted");
				engine.ops.set(`near-${i}`, { operationId: `near-${i}`, phase: "complete", steps: [{ txid: `f-${i}`, attempts: [{ outcome: "acknowledged" }], inclusion: { height: 990, confirmations: 10 }, observation: { state: "mined" }, expiry: { reached: false } }] });
				return paymentId;
			}),
		);
		near.status = async (address) => ({ status: address, destinationTxids: address === "SUCCESS" ? ["0xabc"] : [], refundTxids: address === "REFUNDED" ? ["r1"] : [], originTxids: [], refundedAmount: null, refundReason: null, amountOutFormatted: null });
		await service.reconcile();
		const result = ids.map((id) => store.read((db) => getPayment(db, id)));
		expect(result.map((p) => p.status)).toEqual(["completed", "refunded", "pending"]);
		expect(result[0]!.attempts[0]!.near!.destinationTxids).toEqual(["0xabc"]);
		// A refunded payment may be sent again.
		await expect(service.prepare({ ...draft, paymentId: result[1]!.id, memo: null })).resolves.toBeDefined();
	});
});
