import { describe, expect, test } from "bun:test";
import { describeRule, nextOccurrence, occurrences, todayIn } from "../../src/shared/recurrence";

describe("recurrence", () => {
	test("daily with interval and bounds", () => {
		expect(occurrences({ kind: "daily", interval: 3 }, "2026-01-30", null, "2026-01-01", "2026-02-08")).toEqual([
			"2026-01-30", "2026-02-02", "2026-02-05", "2026-02-08",
		]);
		expect(occurrences({ kind: "daily", interval: 1 }, "2026-01-01", "2026-01-03", "2025-12-01", "2026-12-01")).toEqual([
			"2026-01-01", "2026-01-02", "2026-01-03",
		]);
	});

	test("weekly on several weekdays every other week", () => {
		// 2026-01-05 is a Monday.
		const rule = { kind: "weekly", interval: 2, weekdays: [1, 5] } as const;
		expect(occurrences(rule, "2026-01-05", null, "2026-01-01", "2026-02-01")).toEqual([
			"2026-01-05", "2026-01-09", "2026-01-19", "2026-01-23",
		]);
		// A window starting mid-cycle stays aligned to the start week.
		expect(occurrences(rule, "2026-01-05", null, "2026-01-12", "2026-01-24")).toEqual(["2026-01-19", "2026-01-23"]);
	});

	test("monthly day clamps to month end", () => {
		const rule = { kind: "monthly-day", interval: 1, day: 31 } as const;
		expect(occurrences(rule, "2026-01-31", null, "2026-01-01", "2026-05-31")).toEqual([
			"2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31",
		]);
		expect(occurrences({ kind: "monthly-day", interval: 1, day: 29 }, "2028-01-01", null, "2028-02-01", "2028-02-29")).toEqual(["2028-02-29"]);
	});

	test("first Friday and last Monday of the month", () => {
		const first = { kind: "monthly-weekday", interval: 1, weekday: 5, ordinal: 1 } as const;
		expect(occurrences(first, "2026-01-01", null, "2026-01-01", "2026-04-30")).toEqual([
			"2026-01-02", "2026-02-06", "2026-03-06", "2026-04-03",
		]);
		const last = { kind: "monthly-weekday", interval: 3, weekday: 1, ordinal: -1 } as const;
		expect(occurrences(last, "2026-01-15", null, "2026-01-01", "2026-12-31")).toEqual([
			"2026-01-26", "2026-04-27", "2026-07-27", "2026-10-26",
		]);
	});

	test("start after the first matching day skips it", () => {
		const first = { kind: "monthly-weekday", interval: 1, weekday: 5, ordinal: 1 } as const;
		expect(nextOccurrence(first, "2026-01-03", null, "2026-01-01")).toBe("2026-02-06");
	});

	test("timezone-aware today and descriptions", () => {
		const instant = new Date("2026-03-01T03:00:00Z");
		expect(todayIn("UTC", instant)).toBe("2026-03-01");
		expect(todayIn("America/Los_Angeles", instant)).toBe("2026-02-28");
		expect(describeRule({ kind: "monthly-weekday", interval: 1, weekday: 5, ordinal: 1 })).toBe("Every month on the first Friday");
	});

	test("rejects invalid rules and dates", () => {
		expect(() => occurrences({ kind: "daily", interval: 0 }, "2026-01-01", null, "2026-01-01", "2026-01-02")).toThrow();
		expect(() => occurrences({ kind: "weekly", interval: 1, weekdays: [] }, "2026-01-01", null, "2026-01-01", "2026-01-02")).toThrow();
		expect(() => occurrences({ kind: "daily", interval: 1 }, "2026-02-30", null, "2026-01-01", "2026-03-01")).toThrow();
	});
});
