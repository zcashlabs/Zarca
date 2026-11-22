import type { Database } from "bun:sqlite";

// Each entry upgrades the schema by one version. Never edit a released entry.
const migrations: string[] = [
	`
	CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

	CREATE TABLE contacts (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		photo TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);
	CREATE TABLE contact_tags (
		contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
		tag TEXT NOT NULL,
		PRIMARY KEY (contact_id, tag)
	);
	CREATE TABLE destinations (
		id TEXT PRIMARY KEY,
		contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
		label TEXT NOT NULL,
		route TEXT NOT NULL,
		chain TEXT NOT NULL,
		asset TEXT,
		asset_symbol TEXT,
		address TEXT NOT NULL,
		is_default INTEGER NOT NULL DEFAULT 0,
		position INTEGER NOT NULL
	);
	CREATE INDEX destinations_contact ON destinations(contact_id, position);

	-- Payment intents. 'data' holds the immutable recipient snapshot and terms.
	CREATE TABLE payments (
		id TEXT PRIMARY KEY,
		route TEXT NOT NULL,
		status TEXT NOT NULL,
		data TEXT NOT NULL,
		schedule_id TEXT,
		occurrence_date TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		settled_at TEXT,
		UNIQUE (schedule_id, occurrence_date)
	);
	CREATE INDEX payments_status ON payments(status);
	-- Each execution attempt (zcash.js operation or NEAR Intents deposit).
	CREATE TABLE attempts (
		id TEXT PRIMARY KEY,
		payment_id TEXT NOT NULL REFERENCES payments(id),
		status TEXT NOT NULL,
		data TEXT NOT NULL,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);
	CREATE INDEX attempts_payment ON attempts(payment_id, created_at);

	CREATE TABLE schedules (
		id TEXT PRIMARY KEY,
		data TEXT NOT NULL,
		created_at TEXT NOT NULL,
		cancelled_at TEXT
	);

	-- Local notes and tags for payments and on-chain transactions.
	CREATE TABLE notes (
		subject TEXT PRIMARY KEY,
		note TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);
	CREATE TABLE tags (
		subject TEXT NOT NULL,
		tag TEXT NOT NULL,
		PRIMARY KEY (subject, tag)
	);
	CREATE INDEX tags_tag ON tags(tag);

	-- Recorded historical valuation evidence. Never overwritten by display changes.
	CREATE TABLE valuations (
		subject TEXT NOT NULL,
		currency TEXT NOT NULL,
		rate TEXT NOT NULL,
		source TEXT NOT NULL,
		observed_at TEXT NOT NULL,
		recorded_at TEXT NOT NULL,
		PRIMARY KEY (subject, currency)
	);
	-- Cached daily rates used for valuation lookups.
	CREATE TABLE rate_cache (
		currency TEXT NOT NULL,
		day TEXT NOT NULL,
		rate TEXT NOT NULL,
		source TEXT NOT NULL,
		fetched_at TEXT NOT NULL,
		PRIMARY KEY (currency, day)
	);

	CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	`,
];

export const SCHEMA_VERSION = migrations.length;

/** Applies pending migrations. Returns true when the schema changed. */
export function migrate(db: Database): boolean {
	const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
	if (current > migrations.length) {
		throw new Error("Treasury records were written by a newer version of Zarca");
	}
	if (current === migrations.length) return false;
	db.exec("BEGIN IMMEDIATE");
	try {
		for (let version = current; version < migrations.length; version++) {
			db.exec(migrations[version]!);
		}
		db.exec(`PRAGMA user_version = ${migrations.length}`);
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
	return true;
}
