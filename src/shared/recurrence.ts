// Calendar recurrence on plain dates (YYYY-MM-DD) in the schedule's timezone.
// Occurrences are identified by schedule id + date, so regenerating them after
// a restart, restore or missed period never produces duplicates.
import type { RecurrenceRule, Weekday } from "./types";

const DAY = 86_400_000;

export function parseDate(value: string): number {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) throw new Error(`Invalid date: ${value}`);
	const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	if (formatDate(time) !== value) throw new Error(`Invalid date: ${value}`);
	return time;
}

export function formatDate(time: number): string {
	return new Date(time).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
	return formatDate(parseDate(date) + days * DAY);
}

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/** Today's date in a timezone, e.g. "America/New_York". */
export function todayIn(timezone: string, now: Date = new Date()): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(now);
	const get = (type: string) => parts.find((p) => p.type === type)!.value;
	return `${get("year")}-${get("month")}-${get("day")}`;
}

export function validateRule(rule: RecurrenceRule) {
	if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 366) {
		throw new Error("Repeat interval must be a whole number between 1 and 366");
	}
	if (rule.kind === "weekly") {
		if (!rule.weekdays.length || rule.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
			throw new Error("Choose at least one weekday");
		}
	}
	if (rule.kind === "monthly-day" && (!Number.isInteger(rule.day) || rule.day < 1 || rule.day > 31)) {
		throw new Error("Day of month must be between 1 and 31");
	}
	if (rule.kind === "monthly-weekday") {
		if (![1, 2, 3, 4, -1].includes(rule.ordinal)) throw new Error("Invalid week of month");
		if (!Number.isInteger(rule.weekday) || rule.weekday < 0 || rule.weekday > 6) throw new Error("Invalid weekday");
	}
}

function nthWeekday(year: number, month: number, weekday: Weekday, ordinal: 1 | 2 | 3 | 4 | -1): number {
	if (ordinal === -1) {
		const last = Date.UTC(year, month, daysInMonth(year, month));
		const back = (new Date(last).getUTCDay() - weekday + 7) % 7;
		return last - back * DAY;
	}
	const first = Date.UTC(year, month, 1);
	const forward = (weekday - new Date(first).getUTCDay() + 7) % 7;
	return first + (forward + (ordinal - 1) * 7) * DAY;
}

/**
 * Occurrence dates in [from, to] (inclusive), never before `start` or after `end`.
 * `limit` bounds work for very long ranges.
 */
export function occurrences(
	rule: RecurrenceRule,
	start: string,
	end: string | null,
	from: string,
	to: string,
	limit = 2000,
): string[] {
	validateRule(rule);
	const startTime = parseDate(start);
	const lower = Math.max(startTime, parseDate(from));
	const upper = Math.min(end ? parseDate(end) : Infinity, parseDate(to));
	const out: string[] = [];
	if (lower > upper) return out;
	const push = (time: number) => {
		if (time >= lower && time <= upper && time >= startTime) out.push(formatDate(time));
	};

	switch (rule.kind) {
		case "daily": {
			const step = rule.interval * DAY;
			let time = startTime + Math.max(0, Math.ceil((lower - startTime) / step)) * step;
			for (; time <= upper && out.length < limit; time += step) push(time);
			break;
		}
		case "weekly": {
			const days = [...new Set(rule.weekdays)].sort();
			// Weeks start on Sunday; the start date's week is week zero.
			const week0 = startTime - new Date(startTime).getUTCDay() * DAY;
			const stride = 7 * rule.interval * DAY;
			let week = week0 + Math.max(0, Math.floor((lower - week0) / stride)) * stride;
			for (; week <= upper && out.length < limit; week += stride) {
				for (const day of days) {
					if (out.length >= limit) break;
					push(week + day * DAY);
				}
			}
			break;
		}
		case "monthly-day":
		case "monthly-weekday": {
			const s = new Date(startTime);
			const base = s.getUTCFullYear() * 12 + s.getUTCMonth();
			const l = new Date(lower);
			let index = l.getUTCFullYear() * 12 + l.getUTCMonth() - base;
			index = Math.max(0, Math.floor(index / rule.interval) * rule.interval);
			for (; out.length < limit; index += rule.interval) {
				const month = base + index;
				const year = Math.floor(month / 12), m = month % 12;
				if (Date.UTC(year, m, 1) > upper) break;
				const time = rule.kind === "monthly-day"
					? Date.UTC(year, m, Math.min(rule.day, daysInMonth(year, m)))
					: nthWeekday(year, m, rule.weekday, rule.ordinal);
				push(time);
			}
			break;
		}
	}
	return out;
}

export function nextOccurrence(
	rule: RecurrenceRule,
	start: string,
	end: string | null,
	onOrAfter: string,
): string | null {
	// A monthly rule with interval 366 spans ~30 years; look a little further.
	const horizon = addDays(onOrAfter, 366 * 32);
	return occurrences(rule, start, end, onOrAfter, horizon, 1)[0] ?? null;
}

const ORDINALS = { 1: "first", 2: "second", 3: "third", 4: "fourth", [-1]: "last" } as const;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function describeRule(rule: RecurrenceRule): string {
	const every = (unit: string) => (rule.interval === 1 ? `Every ${unit}` : `Every ${rule.interval} ${unit}s`);
	switch (rule.kind) {
		case "daily":
			return every("day");
		case "weekly":
			return `${every("week")} on ${[...rule.weekdays].sort().map((d) => WEEKDAYS[d]).join(", ")}`;
		case "monthly-day":
			return `${every("month")} on day ${rule.day}${rule.day > 28 ? " (or the last day)" : ""}`;
		case "monthly-weekday":
			return `${every("month")} on the ${ORDINALS[rule.ordinal]} ${WEEKDAYS[rule.weekday]}`;
	}
}
