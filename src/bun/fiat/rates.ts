// Exchange rates for secondary fiat valuation. ZEC amounts are always the
// source of truth; a missing or stale rate never blocks a payment.
//
// Sources (keyless, no embedded secrets):
// - CoinGecko public API: spot prices for major fiat currencies and daily
//   history for the past 365 days.
// - Kraken public OHLC: daily closes for ZEC/USD and ZEC/EUR up to ~720 days,
//   used when CoinGecko history does not reach far enough.
import type { Database } from "bun:sqlite";
import type { FiatQuote } from "../../shared/types";
import { now } from "../domain/util";

export const SUPPORTED_CURRENCIES = [
	"USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "CNY", "INR", "BRL", "KRW", "SGD", "HKD", "SEK",
	"NOK", "DKK", "PLN", "MXN", "ZAR", "NZD", "TRY", "ILS", "AED", "CZK",
] as const;

const COINGECKO = "https://api.coingecko.com/api/v3";
const KRAKEN = "https://api.kraken.com/0/public/OHLC";
const SPOT_TTL_MS = 5 * 60_000;

export function defaultCurrency(locale = Intl.DateTimeFormat().resolvedOptions().locale): string {
	const region = new Intl.Locale(locale).maximize().region ?? "US";
	const byRegion: Record<string, string> = {
		US: "USD", GB: "GBP", JP: "JPY", CA: "CAD", AU: "AUD", CH: "CHF", CN: "CNY", IN: "INR", BR: "BRL",
		KR: "KRW", SG: "SGD", HK: "HKD", SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN", MX: "MXN", ZA: "ZAR",
		NZ: "NZD", TR: "TRY", IL: "ILS", AE: "AED", CZ: "CZK",
	};
	const euro = ["AT", "BE", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PT", "SI", "SK"];
	if (euro.includes(region)) return "EUR";
	return byRegion[region] ?? "USD";
}

function checkCurrency(currency: string) {
	if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(currency)) throw new Error("Unsupported currency");
}

const decimal = (n: number) => {
	if (!Number.isFinite(n) || n <= 0) throw new Error("Invalid rate");
	return n.toPrecision(12).replace(/\.?0+$/, "");
};

export class RateService {
	private spot = new Map<string, { quote: FiatQuote; fetchedAt: number }>();
	private historyRequests = new Map<string, Promise<void>>();

	constructor(private readonly fetcher: typeof fetch = fetch) {}

	private async json(url: string): Promise<unknown> {
		const response = await this.fetcher(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
		if (!response.ok) throw new Error(`Rate source returned ${response.status}`);
		return response.json();
	}

	/** Current rate; falls back to the last known rate, marked stale. */
	async current(currency: string, db?: Database): Promise<FiatQuote | null> {
		checkCurrency(currency);
		const cached = this.spot.get(currency);
		if (cached && Date.now() - cached.fetchedAt < SPOT_TTL_MS) return cached.quote;
		try {
			const body = (await this.json(
				`${COINGECKO}/simple/price?ids=zcash&vs_currencies=${currency.toLowerCase()}&include_last_updated_at=true`,
			)) as { zcash?: Record<string, number> };
			const value = body.zcash?.[currency.toLowerCase()];
			const updated = body.zcash?.last_updated_at;
			if (typeof value !== "number") throw new Error("Missing rate");
			const quote: FiatQuote = {
				currency,
				rate: decimal(value),
				source: "CoinGecko",
				observedAt: typeof updated === "number" ? new Date(updated * 1000).toISOString() : now(),
				stale: false,
			};
			this.spot.set(currency, { quote, fetchedAt: Date.now() });
			return quote;
		} catch {
			if (cached) return { ...cached.quote, stale: true };
			if (db) {
				const row = db
					.query("SELECT rate, source, day, fetched_at FROM rate_cache WHERE currency = ? ORDER BY day DESC LIMIT 1")
					.get(currency) as { rate: string; source: string; day: string; fetched_at: string } | null;
				if (row) return { currency, rate: row.rate, source: row.source, observedAt: `${row.day}T00:00:00.000Z`, stale: true };
			}
			return null;
		}
	}

	/** Daily rate for a UTC date, from cache or by filling the cache from the history sources. */
	async daily(db: Database, currency: string, day: string, persist: (fn: (db: Database) => void) => void): Promise<FiatQuote | null> {
		checkCurrency(currency);
		const read = () =>
			db.query("SELECT rate, source FROM rate_cache WHERE currency = ? AND day = ?").get(currency, day) as
				| { rate: string; source: string }
				| null;
		let row = read();
		if (!row) {
			const key = `${currency}`;
			let pending = this.historyRequests.get(key);
			if (!pending) {
				pending = this.fillHistory(currency, persist).finally(() => {
					setTimeout(() => this.historyRequests.delete(key), 60 * 60_000);
				});
				this.historyRequests.set(key, pending);
			}
			await pending.catch(() => {});
			row = read();
		}
		return row ? { currency, rate: row.rate, source: row.source, observedAt: `${day}T00:00:00.000Z`, stale: false } : null;
	}

	private async fillHistory(currency: string, persist: (fn: (db: Database) => void) => void) {
		const rows: { day: string; rate: string; source: string }[] = [];
		if (currency === "USD" || currency === "EUR") {
			try {
				const body = (await this.json(`${KRAKEN}?pair=ZEC${currency}&interval=1440`)) as {
					error?: unknown[];
					result?: Record<string, unknown>;
				};
				const series = Object.entries(body.result ?? {}).find(([k]) => k !== "last")?.[1];
				if (Array.isArray(series)) {
					for (const candle of series as [number, string, string, string, string][]) {
						rows.push({ day: new Date(candle[0] * 1000).toISOString().slice(0, 10), rate: decimal(Number(candle[4])), source: "Kraken daily close" });
					}
				}
			} catch {
				// CoinGecko below is still tried.
			}
		}
		try {
			const body = (await this.json(
				`${COINGECKO}/coins/zcash/market_chart?vs_currency=${currency.toLowerCase()}&days=365&interval=daily`,
			)) as { prices?: [number, number][] };
			for (const [time, value] of body.prices ?? []) {
				rows.push({ day: new Date(time).toISOString().slice(0, 10), rate: decimal(value), source: "CoinGecko daily" });
			}
		} catch {
			if (!rows.length) throw new Error("No rate history available");
		}
		const fetched = now();
		persist((db) => {
			const insert = db.prepare(
				"INSERT INTO rate_cache (currency, day, rate, source, fetched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(currency, day) DO UPDATE SET rate = excluded.rate, source = excluded.source, fetched_at = excluded.fetched_at",
			);
			// CoinGecko rows come last so they win for overlapping days, keeping one source per recent period.
			for (const row of rows) insert.run(currency, row.day, row.rate, row.source, fetched);
		});
	}
}

/** Testnet coins have no market value: valuation is always unavailable. */
export class NoRates extends RateService {
	override async current(): Promise<FiatQuote | null> {
		return null;
	}
	override async daily(): Promise<FiatQuote | null> {
		return null;
	}
}

/** Records valuation evidence once per subject and currency; never overwrites it. */
export function recordValuation(db: Database, subject: string, quote: FiatQuote) {
	db.run(
		"INSERT OR IGNORE INTO valuations (subject, currency, rate, source, observed_at, recorded_at) VALUES (?, ?, ?, ?, ?, ?)",
		[subject, quote.currency, quote.rate, quote.source, quote.observedAt, now()],
	);
}

/** Fiat value of a zatoshi amount, as a decimal string with 2 places. */
export function fiatValue(zat: bigint, rate: string): string {
	const negative = zat < 0n;
	const amount = negative ? -zat : zat;
	const [whole, fraction = ""] = rate.split(".");
	const scale = 10n ** BigInt(fraction.length);
	const rateScaled = BigInt(whole! + fraction);
	// amount * rate / 1e8 in cents, rounded half up.
	const denominator = 100_000_000n * scale;
	const cents = (amount * rateScaled * 100n * 2n + denominator) / (denominator * 2n);
	return `${negative && cents > 0n ? "-" : ""}${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}
