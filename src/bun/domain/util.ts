import { randomUUID } from "node:crypto";

export const now = () => new Date().toISOString();
export const newId = () => randomUUID();

export function cleanText(value: unknown, field: string, max: number, required = false): string | null {
	if (value === null || value === undefined) {
		if (required) throw new Error(`${field} is required`);
		return null;
	}
	if (typeof value !== "string") throw new Error(`${field} must be text`);
	const text = value.trim();
	if (!text) {
		if (required) throw new Error(`${field} is required`);
		return null;
	}
	if (text.length > max) throw new Error(`${field} can be at most ${max} characters`);
	return text;
}

export function cleanTags(tags: unknown): string[] {
	if (!Array.isArray(tags)) throw new Error("Tags must be a list");
	const out = new Map<string, string>();
	for (const raw of tags) {
		if (typeof raw !== "string") throw new Error("Tags must be text");
		const tag = raw.trim().replace(/\s+/g, " ");
		if (!tag) continue;
		if (tag.length > 40) throw new Error("Tags can be at most 40 characters");
		// Case-insensitive uniqueness, first spelling wins.
		if (!out.has(tag.toLowerCase())) out.set(tag.toLowerCase(), tag);
	}
	if (out.size > 20) throw new Error("Use at most 20 tags");
	return [...out.values()];
}

export function parseZat(value: unknown, field = "Amount"): bigint {
	if (typeof value !== "string" || !/^\d{1,16}$/.test(value)) throw new Error(`${field} is invalid`);
	const amount = BigInt(value);
	if (amount > 21_000_000n * 100_000_000n) throw new Error(`${field} exceeds the ZEC supply`);
	return amount;
}
