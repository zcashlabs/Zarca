// Payment intents and their execution attempts.
//
// A payment is what the treasury intends to pay (recipient snapshot, amount,
// memo). Attempts are concrete executions: a zcash.js operation or a NEAR
// Intents deposit. Intent and attempts are separate so a failed or uncertain
// attempt is never confused with the obligation itself, and a retry can only
// start after every earlier attempt is known not to have paid.
import type { Database } from "bun:sqlite";
import type {
	AttemptView,
	NearQuoteView,
	PaymentStatus,
	PaymentView,
	RecipientSnapshot,
	ValuationView,
} from "../../shared/types";
import { annotationMaps, getNote, getTags, setNote, setTags } from "./annotations";
import { newId, now } from "./util";

export interface PaymentData {
	readonly recipient: RecipientSnapshot;
	readonly amountZat: string;
	readonly memo: string | null;
	readonly dueDate: string | null;
}

export interface AttemptData {
	readonly operationId: string | null;
	readonly txids: readonly string[];
	readonly feeZat: string | null;
	readonly error: string | null;
	readonly near: AttemptView["near"];
	/** Last block height at which the transaction(s) can be mined; 0/null when unknown. */
	readonly expiryHeight?: number | null;
}

interface PaymentRow {
	id: string;
	route: string;
	status: PaymentStatus;
	data: string;
	schedule_id: string | null;
	occurrence_date: string | null;
	created_at: string;
	updated_at: string;
	settled_at: string | null;
}
interface AttemptRow {
	id: string;
	payment_id: string;
	status: AttemptView["status"];
	data: string;
	created_at: string;
	updated_at: string;
}

const ACTIVE_ATTEMPT = new Set<AttemptView["status"]>(["preparing", "submitted", "unknown"]);

function toAttempt(row: AttemptRow): AttemptView {
	const data = JSON.parse(row.data) as AttemptData;
	return {
		id: row.id,
		status: row.status,
		operationId: data.operationId,
		txids: data.txids,
		feeZat: data.feeZat,
		error: data.error,
		near: data.near,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function valuationFor(db: Database, subject: string, currency: string | null): ValuationView | null {
	const row = (currency
		? db.query("SELECT * FROM valuations WHERE subject = ? AND currency = ?").get(subject, currency)
		: db.query("SELECT * FROM valuations WHERE subject = ? ORDER BY recorded_at LIMIT 1").get(subject)) as
		| { currency: string; rate: string; source: string; observed_at: string }
		| null;
	if (!row && currency) return valuationFor(db, subject, null);
	return row ? { currency: row.currency, rate: row.rate, source: row.source, observedAt: row.observed_at } : null;
}

export function listPayments(db: Database, currency: string | null = null, where = "", params: (string | null)[] = []): PaymentView[] {
	const rows = db.query(`SELECT * FROM payments ${where} ORDER BY created_at DESC`).all(...params) as PaymentRow[];
	if (!rows.length) return [];
	const attempts = db.query("SELECT * FROM attempts ORDER BY created_at").all() as AttemptRow[];
	const byPayment = new Map<string, AttemptView[]>();
	for (const a of attempts) {
		const list = byPayment.get(a.payment_id) ?? [];
		list.push(toAttempt(a));
		byPayment.set(a.payment_id, list);
	}
	const { notes, tags } = annotationMaps(db);
	return rows.map((row) => {
		const data = JSON.parse(row.data) as PaymentData;
		const list = byPayment.get(row.id) ?? [];
		const confirmed = list.find((a) => a.status === "confirmed");
		return {
			id: row.id,
			status: row.status,
			recipient: data.recipient,
			amountZat: data.amountZat,
			memo: data.memo,
			note: notes.get(`payment:${row.id}`) ?? null,
			tags: tags.get(`payment:${row.id}`) ?? [],
			scheduleId: row.schedule_id,
			occurrenceDate: row.occurrence_date,
			dueDate: data.dueDate ?? row.occurrence_date,
			attempts: list,
			feeZat: confirmed?.feeZat ?? null,
			valuation: valuationFor(db, `payment:${row.id}`, currency),
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			settledAt: row.settled_at,
		};
	});
}

export function getPayment(db: Database, id: string, currency: string | null = null): PaymentView {
	const payment = listPayments(db, currency, "WHERE id = ?", [id])[0];
	if (!payment) throw new Error("Payment not found");
	return payment;
}

export function createPayment(
	db: Database,
	input: PaymentData & {
		readonly status: PaymentStatus;
		readonly note: string | null;
		readonly tags: readonly string[];
		readonly scheduleId?: string | null;
		readonly occurrenceDate?: string | null;
	},
): string {
	const id = newId();
	const at = now();
	const data: PaymentData = { recipient: input.recipient, amountZat: input.amountZat, memo: input.memo, dueDate: input.dueDate };
	db.run(
		"INSERT INTO payments (id, route, status, data, schedule_id, occurrence_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		[id, input.recipient.route, input.status, JSON.stringify(data), input.scheduleId ?? null, input.occurrenceDate ?? null, at, at],
	);
	setNote(db, `payment:${id}`, input.note);
	setTags(db, `payment:${id}`, input.tags);
	return id;
}

/** Terms can change only before any attempt has been submitted. */
export function updatePaymentTerms(db: Database, id: string, terms: Pick<PaymentData, "recipient" | "amountZat" | "memo">) {
	const payment = getPayment(db, id);
	if (payment.attempts.some((a) => a.status !== "abandoned" && a.status !== "failed")) {
		throw new Error("This payment already has an attempt in progress");
	}
	if (!["draft", "scheduled", "failed"].includes(payment.status)) throw new Error("This payment can no longer be edited");
	const data: PaymentData = { ...terms, dueDate: payment.dueDate };
	db.run("UPDATE payments SET data = ?, route = ?, updated_at = ? WHERE id = ?", [JSON.stringify(data), terms.recipient.route, now(), id]);
}

export function updateAnnotations(db: Database, id: string, note: string | null, tags: readonly string[]) {
	getPayment(db, id);
	setNote(db, `payment:${id}`, note);
	setTags(db, `payment:${id}`, tags);
}

export function setPaymentStatus(db: Database, id: string, status: PaymentStatus, settled = false) {
	db.run("UPDATE payments SET status = ?, updated_at = ?, settled_at = CASE WHEN ? THEN ? ELSE settled_at END WHERE id = ?", [
		status,
		now(),
		settled ? 1 : 0,
		now(),
		id,
	]);
}

export function createAttempt(db: Database, paymentId: string, data: Partial<AttemptData> = {}): string {
	const id = newId();
	const at = now();
	const full: AttemptData = { operationId: null, txids: [], feeZat: null, error: null, near: null, ...data };
	db.run("INSERT INTO attempts (id, payment_id, status, data, created_at, updated_at) VALUES (?, ?, 'preparing', ?, ?, ?)", [
		id,
		paymentId,
		JSON.stringify(full),
		at,
		at,
	]);
	return id;
}

export function getAttempt(db: Database, id: string): AttemptView & { paymentId: string; expiryHeight: number | null } {
	const row = db.query("SELECT * FROM attempts WHERE id = ?").get(id) as AttemptRow | null;
	if (!row) throw new Error("Attempt not found");
	return { ...toAttempt(row), paymentId: row.payment_id, expiryHeight: (JSON.parse(row.data) as AttemptData).expiryHeight ?? null };
}

export function updateAttempt(db: Database, id: string, status: AttemptView["status"], patch: Partial<AttemptData> = {}) {
	const row = db.query("SELECT * FROM attempts WHERE id = ?").get(id) as AttemptRow | null;
	if (!row) throw new Error("Attempt not found");
	const data = { ...(JSON.parse(row.data) as AttemptData), ...patch };
	db.run("UPDATE attempts SET status = ?, data = ?, updated_at = ? WHERE id = ?", [status, JSON.stringify(data), now(), id]);
}

export function updateNearQuote(db: Database, attemptId: string, quote: NearQuoteView) {
	const attempt = getAttempt(db, attemptId);
	updateAttempt(db, attemptId, attempt.status, {
		near: { quote, providerStatus: null, destinationTxids: [], refundTxids: [], checkedAt: null },
	});
}

/** Attempts whose outcome may still change; reconciled on unlock and while unlocked. */
export function activeAttempts(db: Database): (AttemptView & { paymentId: string })[] {
	const rows = db.query("SELECT * FROM attempts WHERE status IN ('preparing', 'submitted', 'unknown') ORDER BY created_at").all() as AttemptRow[];
	return rows.map((r) => ({ ...toAttempt(r), paymentId: r.payment_id }));
}

/**
 * A new attempt may start only when no earlier attempt could still pay:
 * everything before must be abandoned (never authorized) or definitively failed.
 */
export function assertRetryAllowed(payment: PaymentView) {
	const blocking = payment.attempts.find((a) => ACTIVE_ATTEMPT.has(a.status) && a.status !== "preparing");
	if (blocking) {
		throw new Error(
			blocking.status === "unknown"
				? "The previous attempt's outcome is still unknown. Check its status before sending again."
				: "A previous attempt is still in progress.",
		);
	}
	if (payment.attempts.some((a) => a.status === "confirmed")) throw new Error("This payment has already been paid.");
	// A refunded swap never reached the recipient, so it may be sent again.
	if (!["draft", "scheduled", "failed", "refunded"].includes(payment.status)) {
		throw new Error("This payment cannot be sent again.");
	}
}

export function paymentNote(db: Database, id: string) {
	return { note: getNote(db, `payment:${id}`), tags: getTags(db, `payment:${id}`) };
}
