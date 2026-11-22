import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../src/bun/storage/treasury-schema";
import { cancelSchedule, createSchedule, generateOccurrences, listSchedules, skipOccurrence } from "../../src/bun/domain/schedules";
import { createAttempt, listPayments, updateAttempt } from "../../src/bun/domain/payments";
import { todayIn, addDays } from "../../src/shared/recurrence";

const recipient = {
	contactId: null, contactName: "Alice", destinationLabel: "Zcash", route: "zcash" as const,
	chain: "zcash", asset: null, assetSymbol: "ZEC", address: "utest1example",
};

function setup() {
	const db = new Database(":memory:");
	migrate(db);
	return db;
}

test("daily schedule generates the lookahead window once, missed days stay separate", () => {
	const db = setup();
	const today = todayIn("UTC");
	const id = createSchedule(db, {
		name: "Payroll", recipient, amountZat: "100000", memo: "hi", note: "n", tags: ["Payroll"],
		rule: { kind: "daily", interval: 7 }, timezone: "UTC", startDate: addDays(today, -30), endDate: null,
	});
	const first = listPayments(db).filter((p) => p.scheduleId === id);
	// No back-fill before creation; weekly cadence over a 31-day window.
	expect(first.every((p) => p.occurrenceDate! >= today)).toBe(true);
	expect(first.length).toBeGreaterThanOrEqual(4);
	expect(first.length).toBeLessThanOrEqual(5);
	expect(first[0]!.tags).toEqual(["Payroll"]);
	expect(first[0]!.note).toBe("n");
	expect(generateOccurrences(db)).toBe(0);

	// Two months later: earlier unpaid occurrences remain individual overdue payments.
	const later = new Date(Date.now() + 60 * 86_400_000);
	const added = generateOccurrences(db, later);
	expect(added).toBeGreaterThan(5);
	expect(generateOccurrences(db, later)).toBe(0);
	const all = listPayments(db).filter((p) => p.scheduleId === id);
	expect(new Set(all.map((p) => p.occurrenceDate)).size).toBe(all.length);
	expect(listSchedules(db)[0]!.nextDue).toBe(all.map((p) => p.occurrenceDate!).sort()[0]!);
});

test("skip one occurrence; cancelling keeps submitted payments and cancels the rest", () => {
	const db = setup();
	const today = todayIn("UTC");
	const id = createSchedule(db, {
		name: null, recipient, amountZat: "5", memo: null, note: null, tags: [],
		rule: { kind: "daily", interval: 1 }, timezone: "UTC", startDate: today, endDate: addDays(today, 3),
	});
	const [a, b, c, d] = listPayments(db).filter((p) => p.scheduleId === id).sort((x, y) => x.occurrenceDate!.localeCompare(y.occurrenceDate!));
	skipOccurrence(db, a!.id);
	const attempt = createAttempt(db, b!.id, { operationId: "op" });
	updateAttempt(db, attempt, "submitted");
	db.run("UPDATE payments SET status = 'pending' WHERE id = ?", [b!.id]);
	expect(cancelSchedule(db, id)).toEqual({ cancelledOccurrences: 2 });
	const status = new Map(listPayments(db).map((p) => [p.id, p.status]));
	expect(status.get(a!.id)).toBe("skipped");
	expect(status.get(b!.id)).toBe("pending");
	expect(status.get(c!.id)).toBe("cancelled");
	expect(status.get(d!.id)).toBe("cancelled");
	expect(generateOccurrences(db, new Date(Date.now() + 10 * 86_400_000))).toBe(0);
	expect(listSchedules(db)[0]!.nextDue).toBeNull();
});
