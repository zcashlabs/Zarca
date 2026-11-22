// Recurring payment schedules. A schedule never sends anything by itself: each
// due occurrence becomes a payment that the user reviews and authorizes.
//
// Occurrences are identified by (schedule id, date). Due occurrences are
// materialized as "scheduled" payment rows; the UNIQUE(schedule_id,
// occurrence_date) constraint makes regeneration after a restart, missed days
// or a restored backup idempotent. Missed occurrences stay separate payments.
import type { Database } from "bun:sqlite";
import type { RecipientSnapshot, RecurrenceRule, ScheduleView } from "../../shared/types";
import { addDays, nextOccurrence, occurrences, parseDate, todayIn, validateRule } from "../../shared/recurrence";
import { getNote, getTags, setNote, setTags } from "./annotations";
import { createPayment, listPayments, setPaymentStatus } from "./payments";
import { cleanText, newId, now, parseZat } from "./util";

interface ScheduleData {
	readonly name: string;
	readonly recipient: RecipientSnapshot;
	readonly amountZat: string;
	readonly memo: string | null;
	readonly rule: RecurrenceRule;
	readonly timezone: string;
	readonly startDate: string;
	readonly endDate: string | null;
	/** Occurrences before this date are never generated (set when created). */
	readonly generateFrom: string;
}
interface ScheduleRow {
	id: string;
	data: string;
	created_at: string;
	cancelled_at: string | null;
}

/** How far ahead scheduled occurrences appear as upcoming payments. */
export const LOOKAHEAD_DAYS = 31;

export interface ScheduleInput {
	readonly name: string | null;
	readonly recipient: RecipientSnapshot;
	readonly amountZat: string;
	readonly memo: string | null;
	readonly note: string | null;
	readonly tags: readonly string[];
	readonly rule: RecurrenceRule;
	readonly timezone: string;
	readonly startDate: string;
	readonly endDate: string | null;
}

function validTimezone(timezone: string) {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone });
		return timezone;
	} catch {
		throw new Error("Unknown timezone");
	}
}

export function listSchedules(db: Database): ScheduleView[] {
	const rows = db.query("SELECT * FROM schedules ORDER BY created_at DESC").all() as ScheduleRow[];
	return rows.map((row) => {
		const data = JSON.parse(row.data) as ScheduleData;
		const today = todayIn(data.timezone);
		const taken = new Set(
			(db.query("SELECT occurrence_date FROM payments WHERE schedule_id = ? AND status NOT IN ('scheduled')").all(row.id) as {
				occurrence_date: string;
			}[]).map((r) => r.occurrence_date),
		);
		let nextDue: string | null = null;
		if (!row.cancelled_at) {
			let from = data.generateFrom > today ? data.generateFrom : today;
			for (let i = 0; i < 50 && from; i++) {
				const candidate = nextOccurrence(data.rule, data.startDate, data.endDate, from);
				if (!candidate || !taken.has(candidate)) {
					nextDue = candidate;
					break;
				}
				from = addDays(candidate, 1);
			}
		}
		return {
			id: row.id,
			name: data.name,
			recipient: data.recipient,
			amountZat: data.amountZat,
			memo: data.memo,
			note: getNote(db, `schedule:${row.id}`),
			tags: getTags(db, `schedule:${row.id}`),
			rule: data.rule,
			timezone: data.timezone,
			startDate: data.startDate,
			endDate: data.endDate,
			createdAt: row.created_at,
			cancelledAt: row.cancelled_at,
			nextDue,
		};
	});
}

export function createSchedule(db: Database, input: ScheduleInput): string {
	validateRule(input.rule);
	parseDate(input.startDate);
	if (input.endDate) {
		parseDate(input.endDate);
		if (input.endDate < input.startDate) throw new Error("The end date is before the start date");
	}
	const amount = parseZat(input.amountZat);
	if (amount <= 0n) throw new Error("Enter an amount greater than zero");
	const timezone = validTimezone(input.timezone);
	const memo = input.recipient.route === "zcash" ? cleanText(input.memo, "Memo", 512) : null;
	if (memo && new TextEncoder().encode(memo).length > 512) throw new Error("Memos are limited to 512 bytes");
	const id = newId();
	const today = todayIn(timezone);
	const data: ScheduleData = {
		name: cleanText(input.name, "Name", 80) ?? input.recipient.contactName ?? "Recurring payment",
		recipient: input.recipient,
		amountZat: amount.toString(),
		memo,
		rule: input.rule,
		timezone,
		startDate: input.startDate,
		endDate: input.endDate,
		// Never back-fill occurrences that fell before the schedule existed.
		generateFrom: input.startDate > today ? input.startDate : today,
	};
	db.run("INSERT INTO schedules (id, data, created_at) VALUES (?, ?, ?)", [id, JSON.stringify(data), now()]);
	setNote(db, `schedule:${id}`, input.note);
	setTags(db, `schedule:${id}`, input.tags);
	generateOccurrences(db);
	return id;
}

/**
 * Materializes every due or upcoming occurrence (through the lookahead window)
 * that does not exist yet. Safe to call any number of times.
 */
export function generateOccurrences(db: Database, at: Date = new Date()): number {
	const rows = db.query("SELECT * FROM schedules WHERE cancelled_at IS NULL").all() as ScheduleRow[];
	let created = 0;
	for (const row of rows) {
		const data = JSON.parse(row.data) as ScheduleData;
		const today = todayIn(data.timezone, at);
		const dates = occurrences(data.rule, data.startDate, data.endDate, data.generateFrom, addDays(today, LOOKAHEAD_DAYS), 400);
		const existing = new Set(
			(db.query("SELECT occurrence_date FROM payments WHERE schedule_id = ?").all(row.id) as { occurrence_date: string }[]).map(
				(r) => r.occurrence_date,
			),
		);
		const note = getNote(db, `schedule:${row.id}`);
		const tags = getTags(db, `schedule:${row.id}`);
		for (const date of dates) {
			if (existing.has(date)) continue;
			createPayment(db, {
				recipient: data.recipient,
				amountZat: data.amountZat,
				memo: data.memo,
				dueDate: date,
				status: "scheduled",
				note,
				tags,
				scheduleId: row.id,
				occurrenceDate: date,
			});
			created++;
		}
	}
	return created;
}

/** Skips one occurrence. Already-submitted payments cannot be skipped. */
export function skipOccurrence(db: Database, paymentId: string) {
	const payment = listPayments(db, null, "WHERE id = ?", [paymentId])[0];
	if (!payment?.scheduleId) throw new Error("This is not a scheduled payment");
	if (payment.status !== "scheduled" && payment.status !== "failed") throw new Error("Only unsent occurrences can be skipped");
	if (payment.attempts.some((a) => a.status === "submitted" || a.status === "unknown")) {
		throw new Error("An attempt for this payment may have been sent");
	}
	setPaymentStatus(db, paymentId, "skipped");
}

/**
 * Stops future occurrences. Outstanding occurrences that were never submitted
 * (overdue or upcoming) are cancelled too; anything already submitted is kept
 * and continues to be tracked.
 */
export function cancelSchedule(db: Database, scheduleId: string): { cancelledOccurrences: number } {
	const row = db.query("SELECT * FROM schedules WHERE id = ?").get(scheduleId) as ScheduleRow | null;
	if (!row) throw new Error("Schedule not found");
	if (row.cancelled_at) return { cancelledOccurrences: 0 };
	db.run("UPDATE schedules SET cancelled_at = ? WHERE id = ?", [now(), scheduleId]);
	const outstanding = listPayments(db, null, "WHERE schedule_id = ? AND status IN ('scheduled', 'draft', 'failed')", [scheduleId]).filter(
		(p) => !p.attempts.some((a) => a.status === "submitted" || a.status === "unknown" || a.status === "confirmed"),
	);
	for (const payment of outstanding) setPaymentStatus(db, payment.id, "cancelled");
	return { cancelledOccurrences: outstanding.length };
}

export function outstandingForSchedule(db: Database, scheduleId: string) {
	return listPayments(db, null, "WHERE schedule_id = ? AND status IN ('scheduled', 'draft', 'failed')", [scheduleId]).length;
}
