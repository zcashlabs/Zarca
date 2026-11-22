import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { TEST_SCRYPT } from "../../src/bun/security/crypto";
import { migrate } from "../../src/bun/storage/treasury-schema";
import { BackupMismatchError, backupSnapshot, createBackup, openBackup, walletFingerprint } from "../../src/bun/domain/backup";
import { createContact } from "../../src/bun/domain/contacts";

test("backups round-trip records, contain no phrase and only restore onto the matching wallet", async () => {
	const phrase = generateMnemonic(wordlist, 256);
	const mnemonic = new TextEncoder().encode(phrase);
	const db = new Database(":memory:");
	migrate(db);
	createContact(db, {
		name: "Alice",
		photo: "data:image/png;base64,AAAA",
		tags: ["Vendor"],
		destinations: [{ label: "Zcash", route: "zcash", chain: "zcash", asset: null, assetSymbol: "ZEC", address: "u1alice", isDefault: true }],
	});
	const snapshot = new Uint8Array(db.serialize());
	const bytes = await createBackup(
		{ snapshot, fingerprint: walletFingerprint(mnemonic), network: "mainnet", walletName: "Ops", password: "backup password" },
		TEST_SCRYPT,
	);
	const text = new TextDecoder().decode(bytes);
	for (const word of phrase.split(" ")) expect(text.includes(` ${word} `)).toBe(false);
	expect(text).not.toContain("Alice");

	await expect(openBackup(bytes, "wrong password")).rejects.toThrow("incorrect");
	const payload = await openBackup(bytes, "backup password");
	const restored = Database.deserialize(backupSnapshot(payload, mnemonic, "mainnet"));
	expect(restored.query("SELECT name, photo FROM contacts").all()).toEqual([{ name: "Alice", photo: "data:image/png;base64,AAAA" }]);
	expect(restored.query("SELECT tag FROM contact_tags").all()).toEqual([{ tag: "Vendor" }]);

	const other = new TextEncoder().encode(generateMnemonic(wordlist, 256));
	expect(() => backupSnapshot(payload, other, "mainnet")).toThrow(BackupMismatchError);
	expect(() => backupSnapshot(payload, mnemonic, "testnet")).toThrow(BackupMismatchError);
});
