// Treasury records (contacts, payments, schedules, notes, tags, valuations).
//
// The working database is an in-memory SQLite instance. Every committed write
// serializes the whole database, seals it with AES-256-GCM under a key derived
// from the wallet data key, and atomically replaces `treasury.bin`. Nothing
// unencrypted ever touches the disk: there is no journal, WAL or temp file, and
// a crash leaves either the previous or the new snapshot.
import { Database } from "bun:sqlite";
import { openBytes, sealBytes, subkey, wipe } from "../security/crypto";
import { readFileIfExists, writeFileAtomic } from "./files";
import { migrate } from "./treasury-schema";

const MAGIC = new TextEncoder().encode("ZARCATR1");

export class TreasuryStore {
	private key: Uint8Array | null;
	private depth = 0;

	private constructor(
		readonly db: Database,
		private readonly path: string,
		private readonly walletId: string,
		key: Uint8Array,
	) {
		this.key = key;
	}

	static open(path: string, walletId: string, dataKey: Uint8Array): TreasuryStore {
		const key = subkey(dataKey, "treasury");
		const aad = `zarca treasury ${walletId}`;
		const stored = readFileIfExists(path);
		let db: Database;
		if (stored) {
			if (stored.length < MAGIC.length || !MAGIC.every((b, i) => stored[i] === b)) {
				throw new Error("Treasury records are unreadable");
			}
			const plain = openBytes(key, stored.subarray(MAGIC.length), aad);
			db = Database.deserialize(plain);
			plain.fill(0);
		} else {
			db = new Database(":memory:");
		}
		db.exec("PRAGMA foreign_keys = ON; PRAGMA temp_store = MEMORY;");
		const store = new TreasuryStore(db, path, walletId, key);
		const changed = migrate(db);
		if (changed || !stored) store.persist();
		return store;
	}

	/** Runs `fn` in a transaction and persists the snapshot before returning. */
	write<T>(fn: (db: Database) => T): T {
		if (!this.key) throw new Error("Treasury is locked");
		if (this.depth > 0) return fn(this.db);
		this.depth++;
		this.db.exec("BEGIN IMMEDIATE");
		let result: T;
		try {
			result = fn(this.db);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			this.depth--;
			throw error;
		}
		this.depth--;
		this.persist();
		return result;
	}

	read<T>(fn: (db: Database) => T): T {
		if (!this.key) throw new Error("Treasury is locked");
		return fn(this.db);
	}

	/** Plaintext snapshot for encrypted app-data backups. */
	snapshot(): Uint8Array {
		if (!this.key) throw new Error("Treasury is locked");
		return new Uint8Array(this.db.serialize());
	}

	private persist() {
		if (!this.key) throw new Error("Treasury is locked");
		const plain = this.db.serialize();
		try {
			const sealed = sealBytes(this.key, plain, `zarca treasury ${this.walletId}`);
			const out = new Uint8Array(MAGIC.length + sealed.length);
			out.set(MAGIC, 0);
			out.set(sealed, MAGIC.length);
			writeFileAtomic(this.path, out);
		} finally {
			plain.fill(0);
		}
	}

	/** Replaces all records with a restored snapshot and persists it. */
	static replace(path: string, walletId: string, dataKey: Uint8Array, plain: Uint8Array) {
		const db = Database.deserialize(plain);
		try {
			migrate(db);
			const key = subkey(dataKey, "treasury");
			const sealed = sealBytes(key, db.serialize(), `zarca treasury ${walletId}`);
			wipe(key);
			const out = new Uint8Array(MAGIC.length + sealed.length);
			out.set(MAGIC, 0);
			out.set(sealed, MAGIC.length);
			writeFileAtomic(path, out);
		} finally {
			db.close();
		}
	}

	close() {
		if (!this.key) return;
		wipe(this.key);
		this.key = null;
		this.db.close();
	}
}
