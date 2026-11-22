// Encrypted app-data backups. A backup holds the treasury records (contacts,
// photos, tags, schedules, payment metadata, valuations) and NEVER any secret
// that can spend funds: the vault (recovery phrase, data key) and the engine
// database are not included. Restoring needs the recovery phrase (to rebuild
// spending access and chain history) plus this file and its backup password.
import { createHash } from "node:crypto";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Database } from "bun:sqlite";
import { DEFAULT_SCRYPT, deriveKey, newScryptParams, open, seal, subkey, wipe, type Sealed, type ScryptParams } from "../security/crypto";
import { validatePassword } from "../security/vault";

export const BACKUP_FORMAT = "zarca-backup/1";

interface BackupFile {
	readonly format: typeof BACKUP_FORMAT;
	readonly createdAt: string;
	readonly kdf: ScryptParams;
	readonly payload: Sealed;
}

interface Payload {
	readonly fingerprint: string;
	readonly network: string;
	readonly walletName: string;
	readonly treasury: string; // base64 SQLite snapshot
}

/** Identifies the wallet a backup belongs to without revealing the phrase. */
export function walletFingerprint(mnemonic: Uint8Array): string {
	const seed = mnemonicToSeedSync(new TextDecoder().decode(mnemonic));
	try {
		return createHash("sha256").update("zarca wallet fingerprint v1").update(seed).digest("hex");
	} finally {
		seed.fill(0);
	}
}

const AAD = "zarca app-data backup v1";

export async function createBackup(
	args: { snapshot: Uint8Array; fingerprint: string; network: string; walletName: string; password: string },
	cost = DEFAULT_SCRYPT,
): Promise<Uint8Array> {
	validatePassword(args.password);
	// Defense in depth: refuse to export anything that looks like key material.
	assertNoSecrets(args.snapshot);
	const kdf = newScryptParams(cost);
	const key = await deriveKey(args.password, kdf);
	const wrap = subkey(key, "backup");
	try {
		const payload: Payload = {
			fingerprint: args.fingerprint,
			network: args.network,
			walletName: args.walletName,
			treasury: Buffer.from(args.snapshot).toString("base64"),
		};
		const file: BackupFile = {
			format: BACKUP_FORMAT,
			createdAt: new Date().toISOString(),
			kdf,
			payload: seal(wrap, new TextEncoder().encode(JSON.stringify(payload)), AAD),
		};
		return new TextEncoder().encode(JSON.stringify(file));
	} finally {
		wipe(key, wrap);
	}
}

export class BackupMismatchError extends Error {}

export async function openBackup(bytes: Uint8Array, password: string): Promise<Payload> {
	let file: BackupFile;
	try {
		file = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new Error("This is not a Zarca backup file.");
	}
	if (file?.format !== BACKUP_FORMAT) throw new Error("This is not a Zarca backup file.");
	const key = await deriveKey(password, file.kdf);
	const wrap = subkey(key, "backup");
	try {
		const plain = open(wrap, file.payload, AAD);
		return JSON.parse(new TextDecoder().decode(plain)) as Payload;
	} catch {
		throw new Error("The backup password is incorrect or the file is damaged.");
	} finally {
		wipe(key, wrap);
	}
}

/** Validates that a restored backup belongs to the recovered wallet and returns its snapshot. */
export function backupSnapshot(payload: Payload, mnemonic: Uint8Array, network: string): Uint8Array {
	if (payload.fingerprint !== walletFingerprint(mnemonic)) {
		throw new BackupMismatchError("This backup belongs to a different wallet than the recovery phrase you entered.");
	}
	if (payload.network !== network) throw new BackupMismatchError(`This backup is for ${payload.network}, not ${network}.`);
	const snapshot = new Uint8Array(Buffer.from(payload.treasury, "base64"));
	const db = Database.deserialize(snapshot);
	try {
		const ok = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'payments'").get();
		if (!ok) throw new Error("The backup does not contain treasury records.");
	} finally {
		db.close();
	}
	return snapshot;
}

function assertNoSecrets(snapshot: Uint8Array) {
	const db = Database.deserialize(snapshot);
	try {
		const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
		const forbidden = tables.filter((t) => /seed|mnemonic|vault|secret|key/i.test(t));
		if (forbidden.length) throw new Error("Refusing to export: unexpected secret-bearing tables.");
	} finally {
		db.close();
	}
}
