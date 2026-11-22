import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomKey } from "../../src/bun/security/crypto";
import { TreasuryStore } from "../../src/bun/storage/treasury-store";

test("treasury snapshots are encrypted, durable per write and rolled back on error", () => {
	const dir = mkdtempSync(join(tmpdir(), "zarca-store-"));
	const path = join(dir, "treasury.bin");
	const key = randomKey();
	const store = TreasuryStore.open(path, "w1", key);
	store.write((db) =>
		db.run("INSERT INTO notes (subject, note, updated_at) VALUES (?, ?, ?)", ["tx:abc", "secret payroll note", "now"]),
	);
	expect(() =>
		store.write((db) => {
			db.run("INSERT INTO notes (subject, note, updated_at) VALUES (?, ?, ?)", ["tx:def", "rolled back", "now"]);
			throw new Error("boom");
		}),
	).toThrow("boom");
	store.close();

	const bytes = readFileSync(path);
	expect(bytes.includes(Buffer.from("secret payroll note"))).toBe(false);
	expect(bytes.includes(Buffer.from("SQLite format 3"))).toBe(false);
	expect(readdirSync(dir)).toEqual(["treasury.bin"]);

	const reopened = TreasuryStore.open(path, "w1", key);
	const rows = reopened.read((db) => db.query("SELECT subject, note FROM notes").all());
	expect(rows).toEqual([{ subject: "tx:abc", note: "secret payroll note" }]);
	reopened.close();

	expect(() => TreasuryStore.open(path, "w1", randomKey())).toThrow();
	expect(() => TreasuryStore.open(path, "w2", key)).toThrow();
});
