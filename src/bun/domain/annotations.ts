// Private local notes and tags attached to payments ("payment:<id>") and
// on-chain transactions ("tx:<txid>"). Never sent anywhere.
import type { Database } from "bun:sqlite";
import { cleanTags, cleanText, now } from "./util";

export type Subject = `payment:${string}` | `tx:${string}` | `schedule:${string}`;

export function getNote(db: Database, subject: Subject): string | null {
	const row = db.query("SELECT note FROM notes WHERE subject = ?").get(subject) as { note: string } | null;
	return row?.note ?? null;
}

export function setNote(db: Database, subject: Subject, note: string | null) {
	const clean = cleanText(note, "Note", 2000);
	if (clean === null) db.run("DELETE FROM notes WHERE subject = ?", [subject]);
	else {
		db.run(
			"INSERT INTO notes (subject, note, updated_at) VALUES (?, ?, ?) ON CONFLICT(subject) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at",
			[subject, clean, now()],
		);
	}
}

export function getTags(db: Database, subject: Subject): string[] {
	return (db.query("SELECT tag FROM tags WHERE subject = ? ORDER BY tag COLLATE NOCASE").all(subject) as { tag: string }[]).map((r) => r.tag);
}

export function setTags(db: Database, subject: Subject, tags: readonly string[]) {
	const clean = cleanTags(tags);
	db.run("DELETE FROM tags WHERE subject = ?", [subject]);
	const insert = db.prepare("INSERT INTO tags (subject, tag) VALUES (?, ?)");
	for (const tag of clean) insert.run(subject, tag);
}

/** Every tag in use, with usage counts, for pickers and filters. */
export function allTags(db: Database): { tag: string; count: number }[] {
	return db
		.query(
			`SELECT tag, COUNT(*) AS count FROM (
				SELECT tag FROM tags UNION ALL SELECT tag FROM contact_tags
			) GROUP BY tag COLLATE NOCASE ORDER BY count DESC, tag COLLATE NOCASE`,
		)
		.all() as { tag: string; count: number }[];
}

export function annotationMaps(db: Database) {
	const notes = new Map<string, string>();
	for (const row of db.query("SELECT subject, note FROM notes").all() as { subject: string; note: string }[]) {
		notes.set(row.subject, row.note);
	}
	const tags = new Map<string, string[]>();
	for (const row of db.query("SELECT subject, tag FROM tags ORDER BY tag COLLATE NOCASE").all() as { subject: string; tag: string }[]) {
		const list = tags.get(row.subject) ?? [];
		list.push(row.tag);
		tags.set(row.subject, list);
	}
	return { notes, tags };
}
