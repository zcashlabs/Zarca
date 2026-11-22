// Formatting helpers. Zatoshi amounts are strings/bigints end to end; no floats.
export const ZAT = 100_000_000n;

export function formatZec(zat: string | bigint, options: { sign?: boolean; decimals?: number } = {}): string {
	let value = typeof zat === "bigint" ? zat : BigInt(zat);
	const negative = value < 0n;
	if (negative) value = -value;
	const whole = value / ZAT;
	let fraction = (value % ZAT).toString().padStart(8, "0");
	const max = options.decimals ?? 8;
	fraction = fraction.slice(0, max).replace(/0+$/, "");
	if (fraction.length < 2 && max >= 2) fraction = fraction.padEnd(2, "0");
	const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	const sign = negative ? "−" : options.sign && value > 0n ? "+" : "";
	return `${sign}${grouped}${fraction ? `.${fraction}` : ""}`;
}

/** Parses a user-entered ZEC amount into zatoshis; null when invalid. */
export function parseZecInput(text: string): bigint | null {
	const clean = text.trim().replace(/,/g, "");
	if (!/^\d{0,8}(\.\d{0,8})?$/.test(clean) || clean === "" || clean === ".") return null;
	const [whole = "0", fraction = ""] = clean.split(".");
	return BigInt(whole || "0") * ZAT + BigInt(fraction.padEnd(8, "0"));
}

export function zatToInput(zat: string | bigint): string {
	const value = typeof zat === "bigint" ? zat : BigInt(zat);
	const fraction = (value % ZAT).toString().padStart(8, "0").replace(/0+$/, "");
	return `${value / ZAT}${fraction ? `.${fraction}` : ""}`;
}

export function fiat(zat: string | bigint, rate: string | null | undefined, currency: string): string | null {
	if (!rate) return null;
	const value = (Number(typeof zat === "bigint" ? zat : BigInt(zat)) / 1e8) * Number(rate);
	return formatFiat(value, currency);
}

export function formatFiat(value: number | string, currency: string): string {
	const n = typeof value === "string" ? Number(value) : value;
	try {
		return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
	} catch {
		return `${n.toFixed(2)} ${currency}`;
	}
}

export function shortAddress(address: string, head = 10, tail = 8): string {
	return address.length <= head + tail + 1 ? address : `${address.slice(0, head)}…${address.slice(-tail)}`;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const shortDateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

export function formatDate(value: string | null | undefined): string {
	if (!value) return "—";
	const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
	return dateFormat.format(date);
}
export function formatShortDate(value: string): string {
	const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
	return shortDateFormat.format(date);
}
export function formatDateTime(value: string | null | undefined): string {
	return value ? dateTimeFormat.format(new Date(value)) : "—";
}

export function relativeTime(value: string): string {
	const diff = Date.now() - new Date(value).getTime();
	const abs = Math.abs(diff);
	const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	const units: [Intl.RelativeTimeFormatUnit, number][] = [["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000]];
	for (const [unit, ms] of units) if (abs >= ms) return rtf.format(-Math.round(diff / ms), unit);
	return "just now";
}

export function today(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDaysLocal(date: string, days: number): string {
	const d = new Date(`${date}T12:00:00`);
	d.setDate(d.getDate() + days);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts.at(-1)![0] : parts[0]?.[1] ?? "")).toUpperCase() || "?";
}
