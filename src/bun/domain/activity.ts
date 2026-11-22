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
	tipHeight: number | null,
	currency: string,
): ChainActivity {
	const ours = new Set(payments.flatMap((p) => p.attempts.flatMap((a) => a.txids)));
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
			});
		} else if (entry.balanceDelta > 0n) {
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
				kind: "received",
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
