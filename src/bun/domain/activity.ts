// Merges on-chain history with Zarca's payment records into one activity list.
// Transactions that belong to a Zarca payment attempt are represented by that
// payment; everything else is an incoming receipt or an external outgoing
// transaction. Sender identity is never inferred.
import type { HistoryEntry } from "@zcashlabs/zcash.js";
import type { ActivityItem, ExternalOutgoingView, IncomingView, PaymentView, ValuationView } from "../../shared/types";
import type { TreasuryStore } from "../storage/treasury-store";
import { annotationMaps } from "./annotations";
import { listPayments } from "./payments";

export interface ChainActivity {
	readonly incoming: IncomingView[];
	readonly external: ExternalOutgoingView[];
}

function valuationMap(store: TreasuryStore, currency: string) {
	const map = new Map<string, ValuationView>();
	const rows = store.read((db) =>
		db.query("SELECT subject, currency, rate, source, observed_at FROM valuations ORDER BY currency = ? DESC").all(currency),
	) as { subject: string; currency: string; rate: string; source: string; observed_at: string }[];
	for (const row of rows) {
		if (!map.has(row.subject)) {
			map.set(row.subject, { currency: row.currency, rate: row.rate, source: row.source, observedAt: row.observed_at });
		}
	}
	return map;
}

export function classifyHistory(
	store: TreasuryStore,
	history: readonly HistoryEntry[],
	payments: readonly PaymentView[],
	memos: ReadonlyMap<string, string[]>,
	receivedAt: ReadonlyMap<string, readonly string[]>,
	tipHeight: number | null,
	currency: string,
): ChainActivity {
	const ours = new Set(payments.flatMap((p) => p.attempts.flatMap((a) => a.txids)));
	// Each cross-chain quote uses a fresh refund address of ours; map it back to its payment.
	const refundAddresses = new Map<string, string>();
	for (const p of payments) for (const a of p.attempts) if (a.near?.quote.refundTo) refundAddresses.set(a.near.quote.refundTo, p.id);
	const { notes, tags } = store.read((db) => annotationMaps(db));
	const valuations = valuationMap(store, currency);
	const incoming: IncomingView[] = [];
	const external: ExternalOutgoingView[] = [];
	for (const entry of history) {
		const txid = String(entry.txid);
		if (ours.has(txid)) continue;
		if (entry.expiredAtMaxScannedHeight) continue;
		const subject = `tx:${txid}`;
		const blockTime = entry.blockTime ? new Date(entry.blockTime * 1000).toISOString() : null;
		const confirmations = entry.minedHeight !== null && tipHeight !== null ? Math.max(0, tipHeight - entry.minedHeight + 1) : null;
		if (entry.isShielding || (entry.balanceDelta <= 0n && entry.totalReceived > 0n && entry.totalSpent > 0n && entry.balanceDelta === -(entry.fee ?? 0n))) {
			// Internal movement (shielding or self-transfer): only the fee leaves the treasury.
			incoming.push({
				txid,
				amountZat: entry.balanceDelta.toString(),
				minedHeight: entry.minedHeight,
				blockTime,
				confirmations,
				memos: [],
				note: notes.get(subject) ?? null,
				tags: tags.get(subject) ?? [],
				valuation: valuations.get(subject) ?? null,
				kind: entry.isShielding ? "shielding" : "change",
				refundFor: null,
			});
		} else if (entry.balanceDelta > 0n) {
			const refundFor = (receivedAt.get(txid) ?? []).map((a) => refundAddresses.get(a)).find(Boolean) ?? null;
			incoming.push({
				txid,
				amountZat: entry.balanceDelta.toString(),
				minedHeight: entry.minedHeight,
				blockTime,
				confirmations,
				memos: memos.get(txid) ?? [],
				note: notes.get(subject) ?? null,
				tags: tags.get(subject) ?? [],
				valuation: valuations.get(subject) ?? null,
				kind: refundFor ? "refund" : "received",
				refundFor,
			});
		} else if (entry.balanceDelta < 0n) {
			const fee = entry.fee;
			external.push({
				txid,
				amountZat: (-(entry.balanceDelta) - (fee ?? 0n)).toString(),
				feeZat: fee === null ? null : fee.toString(),
				minedHeight: entry.minedHeight,
				blockTime,
				note: notes.get(subject) ?? null,
				tags: tags.get(subject) ?? [],
				valuation: valuations.get(subject) ?? null,
			});
		}
	}
	return { incoming, external };
}

/**
 * Marks completed payments whose transactions only cost the treasury their fee
 * (the recipient was this wallet) as internal transfers.
 */
export function markInternal(payments: readonly PaymentView[], history: readonly HistoryEntry[]): PaymentView[] {
	const byTxid = new Map(history.map((h) => [String(h.txid), h]));
	return payments.map((p) => {
		const txids = p.attempts.filter((a) => a.status === "confirmed").flatMap((a) => a.txids);
		if (!txids.length || p.recipient.route !== "zcash") return p;
		const entries = txids.map((t) => byTxid.get(t));
		const internal = entries.every((e) => e !== undefined && e.fee !== null && e.balanceDelta === -e.fee);
		return internal ? { ...p, internal: true } : p;
	});
}

export function buildActivity(payments: readonly PaymentView[], chain: ChainActivity): ActivityItem[] {
	const items: ActivityItem[] = [
		...payments.map((payment): ActivityItem => ({
			kind: "payment",
			at: payment.settledAt ?? (payment.dueDate ? `${payment.dueDate}T12:00:00.000Z` : payment.createdAt),
			payment,
		})),
		...chain.incoming.map((incoming): ActivityItem => ({ kind: "incoming", at: incoming.blockTime ?? new Date().toISOString(), incoming })),
		...chain.external.map((external): ActivityItem => ({ kind: "external", at: external.blockTime ?? new Date().toISOString(), external })),
	];
	return items.sort((a, b) => b.at.localeCompare(a.at));
}

export function paymentsFor(store: TreasuryStore, currency: string) {
	return store.read((db) => listPayments(db, currency));
}
