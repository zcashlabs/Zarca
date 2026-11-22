import type { ActivityItem, PaymentView, ReportView, ValuationView } from "../../shared/types";
import { fiatValue } from "../fiat/rates";

export interface RateLookup {
	/** Recorded valuation in the report currency, or a daily rate for the date; null when unknown. */
	(valuation: ValuationView | null, at: string): string | null;
}

const OPEN_STATUSES = new Set(["scheduled", "draft", "failed"]);

/** Local calendar date of an ISO instant in a timezone. */
export function localDate(iso: string, timezone: string): string {
	const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
	const get = (t: string) => parts.find((p) => p.type === t)!.value;
	return `${get("year")}-${get("month")}-${get("day")}`;
}

class Sum {
	zat = 0n;
	cents = 0n;
	priced = 0;
	missing = 0;
	add(zat: bigint, rate: string | null) {
		this.zat += zat;
		if (rate === null) {
			this.missing++;
			return;
		}
		this.priced++;
		const value = fiatValue(zat, rate);
		this.cents += BigInt(value.replace("-", "").replace(".", "")) * (value.startsWith("-") ? -1n : 1n);
	}
	/** Fiat total, or null when no item in the sum had a rate. */
	fiat(): string | null {
		if (this.priced === 0 && this.missing > 0) return null;
		const abs = this.cents < 0n ? -this.cents : this.cents;
		return `${this.cents < 0n ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
	}
	view() {
		return { zat: this.zat.toString(), fiat: this.fiat(), missingRates: this.missing };
	}
}

export function buildReport(args: {
	items: readonly ActivityItem[];
	from: string;
	to: string;
	today: string;
	timezone: string;
	currency: string;
	spendableZat: bigint;
	currentRate: string | null;
	rate: RateLookup;
}): ReportView {
	const { items, from, to, timezone } = args;
	const inRange = (iso: string) => {
		const day = localDate(iso, timezone);
		return day >= from && day <= to;
	};
	const received = new Sum();
	const spent = new Sum();
	const fees = new Sum();
	const byTag = new Map<string, { tag: string; sum: Sum; count: number }>();
	const untagged = new Sum();
	let upcoming = 0n;
	let overdue = 0n;

	const spend = (zat: bigint, fee: bigint, tags: readonly string[], valuation: ValuationView | null, at: string) => {
		const rate = args.rate(valuation, at);
		spent.add(zat, rate);
		fees.add(fee, rate);
		if (!tags.length) untagged.add(zat, rate);
		for (const tag of tags) {
			const key = tag.toLowerCase();
			const entry = byTag.get(key) ?? { tag, sum: new Sum(), count: 0 };
			entry.sum.add(zat, rate);
			entry.count++;
			byTag.set(key, entry);
		}
	};

	for (const item of items) {
		if (item.kind === "payment") {
			const p: PaymentView = item.payment;
			if (OPEN_STATUSES.has(p.status) && p.dueDate) {
				if (p.dueDate < args.today) overdue += BigInt(p.amountZat);
				else upcoming += BigInt(p.amountZat);
			}
			// Spending counts once, when the payment completed. Refunded swaps never paid the recipient.
			if (p.status === "completed" && p.settledAt && inRange(p.settledAt)) {
				spend(BigInt(p.amountZat), BigInt(p.feeZat ?? "0"), p.tags, p.valuation, p.settledAt);
			}
		} else if (item.kind === "incoming") {
			const i = item.incoming;
			if (!i.blockTime || !inRange(i.blockTime)) continue;
			const zat = BigInt(i.amountZat);
			if (i.kind === "received") received.add(zat, args.rate(i.valuation, i.blockTime));
			else if (zat < 0n) fees.add(-zat, args.rate(i.valuation, i.blockTime));
		} else {
			const e = item.external;
			if (!e.blockTime || !inRange(e.blockTime)) continue;
			spend(BigInt(e.amountZat), BigInt(e.feeZat ?? "0"), e.tags, e.valuation, e.blockTime);
		}
	}

	const tagRows = [...byTag.values()]
		.map(({ tag, sum, count }) => ({ tag, zat: sum.zat.toString(), fiat: sum.fiat(), count }))
		.sort((a, b) => (BigInt(b.zat) > BigInt(a.zat) ? 1 : BigInt(b.zat) < BigInt(a.zat) ? -1 : a.tag.localeCompare(b.tag)));
	return {
		from,
		to,
		currency: args.currency,
		received: received.view(),
		spent: spent.view(),
		fees: fees.view(),
		byTag: tagRows,
		untaggedSpent: untagged.zat.toString(),
		upcoming: upcoming.toString(),
		overdue: overdue.toString(),
		spendable: args.spendableZat.toString(),
		spendableFiat: args.currentRate ? fiatValue(args.spendableZat, args.currentRate) : null,
	};
}
