// Live testnet lifecycle. Run with: ZARCA_INTEGRATION=1 bun test tests/integration
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { Controller } from "../../src/bun/app/controller";
import { Registry } from "../../src/bun/app/registry";
import { createBackup } from "../../src/bun/domain/backup";
import { createContact, listContacts } from "../../src/bun/domain/contacts";
import { createSchedule, listSchedules } from "../../src/bun/domain/schedules";
import { todayIn } from "../../src/shared/recurrence";

const enabled = process.env.ZARCA_INTEGRATION === "1";

function walk(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

test.skipIf(!enabled)("create, lock, switch, back up, delete and restore a testnet wallet", async () => {
	const root = mkdtempSync(join(tmpdir(), "zarca-it-"));
	const controller = new Controller({ session() {}, sync() {}, changed() {} }, new Registry(root));
	const password = "integration password";

	// Create with phrase confirmation.
	const { token, words } = controller.generatePhrase();
	await expect(controller.createWallet({ token, name: "Ops", network: "testnet", password, confirmation: { 0: "wrong", 5: words[5]!, 9: words[9]! } })).rejects.toThrow("do not match");
	await controller.createWallet({ token, name: "Ops", network: "testnet", password, confirmation: { 0: words[0]!, 5: words[5]!, 9: words[9]! } });
	const ops = controller.state().unlocked!;
	expect(ops.name).toBe("Ops");
	const phrase = words.join(" ");

	// Records.
	const session = controller.session;
	session.store.write((db) => {
		createContact(db, {
			name: "Northwind", photo: "data:image/png;base64,AAAA", tags: ["Vendor"],
			destinations: [{ label: "Main", route: "zcash", chain: "zcash", asset: null, assetSymbol: "ZEC", address: "utest1example", isDefault: true }],
		});
		createSchedule(db, {
			name: "Retainer", recipient: { contactId: null, contactName: "Northwind", destinationLabel: "Main", route: "zcash", chain: "zcash", asset: null, assetSymbol: "ZEC", address: "utest1example" },
			amountZat: "250000", memo: null, note: "monthly", tags: ["Retainers"], rule: { kind: "monthly-day", interval: 1, day: 1 },
			timezone: "UTC", startDate: todayIn("UTC"), endDate: null,
		});
	});
	const fingerprint = session.store.read((db) => (db.query("SELECT value FROM meta WHERE key = 'fingerprint'").get() as { value: string }).value);
	const backup = await createBackup({ snapshot: session.store.snapshot(), fingerprint, network: "testnet", walletName: "Ops", password: "backup password" });
	expect(new TextDecoder().decode(backup)).not.toContain(words[0]!.length > 3 ? ` ${words[0]} ` : "\u0000");

	// Nothing readable at rest.
	for (const file of walk(join(root, "wallets", ops.id))) {
		const bytes = readFileSync(file);
		expect(bytes.includes(Buffer.from("SQLite format 3"))).toBe(false);
		expect(bytes.includes(Buffer.from("Northwind"))).toBe(false);
		expect(bytes.includes(Buffer.from(phrase))).toBe(false);
	}
	expect(readFileSync(join(root, "app.json"), "utf8")).not.toContain("Northwind");

	// Lock and unlock.
	await controller.lock("manual");
	expect(controller.unlocked).toBe(false);
	expect(() => session.store.read(() => 1)).toThrow("locked");
	await expect(controller.unlock(ops.id, "not the password")).rejects.toThrow("Incorrect password");
	await controller.unlock(ops.id, password);
	expect(controller.session.store.read((db) => listContacts(db))).toHaveLength(1);

	// Creating a second wallet locks the first (one unlocked wallet at a time).
	const second = controller.generatePhrase();
	await controller.createWallet({ token: second.token, name: "Grants", network: "testnet", password: "another password", confirmation: { 1: second.words[1]!, 2: second.words[2]!, 3: second.words[3]! } });
	expect(controller.state().unlocked!.name).toBe("Grants");
	expect(controller.session.store.read((db) => listContacts(db))).toHaveLength(0);

	// Delete the first wallet (password + typed name).
	await expect(controller.deleteWallet(ops.id, password, "ops")).rejects.toThrow("exactly");
	await controller.deleteWallet(ops.id, password, "Ops");
	expect(existsSync(join(root, "wallets", ops.id))).toBe(false);

	// A backup never restores onto a different phrase, and nothing is written when it is refused.
	const backupPath = join(root, "ops.zarca-backup");
	await Bun.write(backupPath, backup);
	const before = readdirSync(join(root, "wallets")).length;
	await expect(controller.importWallet({
		name: "Wrong", network: "testnet", password, phrase: generateMnemonic(wordlist, 256), createdAfter: null,
		backup: { bytes: backup, password: "backup password" },
	})).rejects.toThrow("different wallet");
	expect(readdirSync(join(root, "wallets")).length).toBe(before);

	// Restore with phrase + backup + a new local password.
	await controller.importWallet({
		name: "Ops restored", network: "testnet", password: "new local password", phrase, createdAfter: todayIn("UTC"),
		backup: { bytes: backup, password: "backup password" },
	});
	const restored = controller.session;
	expect(restored.entry.name).toBe("Ops restored");
	const contacts = restored.store.read((db) => listContacts(db));
	expect(contacts.map((c) => [c.name, c.photo, c.tags])).toEqual([["Northwind", "data:image/png;base64,AAAA", ["Vendor"]]]);
	const schedules = restored.store.read((db) => listSchedules(db));
	expect(schedules.map((s) => [s.name, s.note, s.tags])).toEqual([["Retainer", "monthly", ["Retainers"]]]);
	// Restored occurrences are not duplicated.
	const occurrences = restored.store.read((db) => db.query("SELECT COUNT(*) AS n FROM payments").get() as { n: number }).n;
	await controller.lock("manual");
	await controller.unlock(restored.entry.id, "new local password");
	expect(controller.session.store.read((db) => db.query("SELECT COUNT(*) AS n FROM payments").get() as { n: number }).n).toBe(occurrences);

	await controller.shutdown();
}, 300_000);
