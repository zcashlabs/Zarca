// Bookkeeping CSV (RFC 4180). One row per payment or chain transaction with a
// stable reference. Tags and recurring schedules are deliberately excluded;
// private notes only when the user explicitly asks for them.
import type { ActivityItem, ValuationView } from "../../shared/types";
import { fiatValue } from "../fiat/rates";

export const CSV_COLUMNS = [
	"reference",
	"date",
	"type",
	"status",
	"counterparty",
	"destination_network",
	"destination_asset",
	"address",
	"amount_zec",
	"fee_zec",
	"net_zec",
	"txids",
	"recipient_memo",
	"fiat_currency",
	"fiat_rate",
	"fiat_value",
	"rate_source",
	"rate_observed_at",
] as const;

const ZEC = (zat: bigint) => {
	const negative = zat < 0n;
	const abs = negative ? -zat : zat;
	return `${negative ? "-" : ""}${abs / 100_000_000n}.${(abs % 100_000_000n).toString().padStart(8, "0")}`;
};

const zatOf = (zec: string) => {
	const negative = zec.startsWith("-");
	const [whole, fraction] = zec.replace("-", "").split(".");
	const zat = BigInt(whole!) * 100_000_000n + BigInt(fraction!.padEnd(8, "0"));
	return negative ? -zat : zat;
};

/** Quotes when needed and neutralizes spreadsheet formula injection in text cells. */
export function csvCell(value: string | null | undefined, text = true): string {
	let cell = value ?? "";
	if (text && /^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
	return /[",\r\n]|^\s|\s$/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

export function buildCsv(items: readonly ActivityItem[], options: { includeNotes: boolean }): string {
	const columns = options.includeNotes ? [...CSV_COLUMNS, "private_note"] : [...CSV_COLUMNS];
	const lines = [columns.join(",")];
	const sorted = [...items].sort((a, b) => a.at.localeCompare(b.at));
	for (const item of sorted) {
		let row: Record<string, string | null>;
		let valuation: ValuationView | null;
		let amount: bigint;
		let note: string | null;
		if (item.kind === "payment") {
			const p = item.payment;
			// Unsent scheduled occurrences are commitments, not bookkeeping records.
			if (p.status === "scheduled" || p.status === "draft") continue;
			const fee = BigInt(p.feeZat ?? p.attempts.at(-1)?.feeZat ?? "0");
			amount = -BigInt(p.amountZat);
			const charged = p.status === "completed" || p.status === "pending";
			valuation = p.valuation;
			note = p.note;
			row = {
				reference: `payment:${p.id}`,
				date: p.settledAt ?? p.updatedAt,
				type: p.internal ? "internal_transfer" : p.recipient.route === "near-intents" ? "cross_chain_payment" : "payment",
				status: p.status,
				counterparty: p.recipient.contactName,
				destination_network: p.recipient.chain,
				destination_asset: p.recipient.assetSymbol,
				address: p.recipient.address,
				amount_zec: p.internal ? ZEC(0n) : ZEC(amount),
				fee_zec: charged ? ZEC(-fee) : ZEC(0n),
				net_zec: !charged ? ZEC(0n) : p.internal ? ZEC(-fee) : ZEC(amount - fee),
				txids: p.attempts.flatMap((a) => a.txids).join(" "),
				recipient_memo: p.memo,
			};
		} else if (item.kind === "incoming") {
			const i = item.incoming;
			amount = BigInt(i.amountZat);
			valuation = i.valuation;
			note = i.note;
			const internal = i.kind === "shielding" || i.kind === "change" || i.kind === "other";
			row = {
				reference: `tx:${i.txid}`,
				date: i.blockTime ?? item.at,
				type: i.kind === "refund" ? "refund" : internal ? "internal_transfer" : "receipt",
				status: i.minedHeight === null ? "pending" : "confirmed",
				counterparty: null,
				destination_network: "zcash",
				destination_asset: "ZEC",
				address: null,
				amount_zec: internal ? ZEC(0n) : ZEC(amount),
				// Refunds return the treasury's own funds: shown as such, never as revenue.
				fee_zec: internal ? ZEC(amount) : ZEC(0n),
				net_zec: ZEC(amount),
				txids: i.txid,
				recipient_memo: i.memos.join(" | ") || null,
			};
		} else {
			const e = item.external;
			const fee = BigInt(e.feeZat ?? "0");
			amount = -BigInt(e.amountZat);
			valuation = e.valuation;
			note = e.note;
			row = {
				reference: `tx:${e.txid}`,
				date: e.blockTime ?? item.at,
				type: "external_payment",
				status: e.minedHeight === null ? "pending" : "confirmed",
				counterparty: null,
				destination_network: "zcash",
				destination_asset: "ZEC",
				address: null,
				amount_zec: ZEC(amount),
				fee_zec: ZEC(-fee),
				net_zec: ZEC(amount - fee),
				txids: e.txid,
				recipient_memo: null,
			};
		}
		row.fiat_currency = valuation?.currency ?? null;
		row.fiat_rate = valuation?.rate ?? null;
		row.fiat_value = valuation ? fiatValue(zatOf(row.net_zec!), valuation.rate) : null;
		row.rate_source = valuation?.source ?? null;
		row.rate_observed_at = valuation?.observedAt ?? null;
		if (options.includeNotes) row.private_note = note;
		const numeric = new Set(["amount_zec", "fee_zec", "net_zec", "fiat_rate", "fiat_value"]);
		lines.push(columns.map((c) => csvCell(row[c], !numeric.has(c))).join(","));
	}
	return `${lines.join("\r\n")}\r\n`;
}
