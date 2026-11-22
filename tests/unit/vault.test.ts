import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TEST_SCRYPT } from "../../src/bun/security/crypto";
import {
	IncorrectPasswordError,
	changeVaultPassword,
	createVault,
	openSeed,
	unlockVault,
} from "../../src/bun/security/vault";

const phrase = new TextEncoder().encode("abandon ".repeat(23) + "art");

describe("vault", () => {
	test("unlocks with the password and keeps the seed separately sealed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "zarca-vault-"));
		const path = join(dir, "vault.json");
		const created = await createVault(path, "w1", "correct horse", phrase, TEST_SCRYPT);
		const unlocked = await unlockVault(path, "w1", "correct horse");
		expect(unlocked).toEqual(created);
		expect(await openSeed(path, "w1", "correct horse")).toEqual(phrase);
		const text = readFileSync(path, "utf8");
		expect(text).not.toContain("abandon");
		expect(JSON.parse(text).kdf.N).toBe(TEST_SCRYPT.N);
	});

	test("rejects wrong passwords, foreign wallet ids and short passwords", async () => {
		const dir = mkdtempSync(join(tmpdir(), "zarca-vault-"));
		const path = join(dir, "vault.json");
		await createVault(path, "w1", "correct horse", phrase, TEST_SCRYPT);
		await expect(unlockVault(path, "w1", "wrong horse")).rejects.toBeInstanceOf(IncorrectPasswordError);
		await expect(openSeed(path, "w1", "wrong horse")).rejects.toBeInstanceOf(IncorrectPasswordError);
		await expect(unlockVault(path, "w2", "correct horse")).rejects.toThrow();
		await expect(createVault(join(dir, "v2.json"), "w2", "short", phrase, TEST_SCRYPT)).rejects.toThrow();
	});

	test("password change preserves the data key and seed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "zarca-vault-"));
		const path = join(dir, "vault.json");
		const key = await createVault(path, "w1", "first password", phrase, TEST_SCRYPT);
		await changeVaultPassword(path, "w1", "first password", "second password", TEST_SCRYPT);
		await expect(unlockVault(path, "w1", "first password")).rejects.toBeInstanceOf(IncorrectPasswordError);
		expect(await unlockVault(path, "w1", "second password")).toEqual(key);
		expect(await openSeed(path, "w1", "second password")).toEqual(phrase);
	});
});
