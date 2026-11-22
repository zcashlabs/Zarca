// Live testnet. Run with: ZARCA_INTEGRATION=1 bun test tests/integration
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Controller } from "../../src/bun/app/controller";
import { Registry } from "../../src/bun/app/registry";

test.skipIf(process.env.ZARCA_INTEGRATION !== "1")("migration engine opens with its policy and restores the session", async () => {
	const controller = new Controller({ session() {}, sync() {}, changed() {} }, new Registry(mkdtempSync(join(tmpdir(), "zarca-mig-"))));
	const { token, words } = controller.generatePhrase();
	await controller.createWallet({ token, name: "Mig", network: "testnet", password: "migration password", confirmation: { 0: words[0]!, 1: words[1]!, 2: words[2]! } });
	const before = controller.session;
	// A brand-new wallet may not have balance accounting yet; either way the
	// normal session must be restored.
	let plan: unknown = null;
	try {
		plan = await controller.prepareMigration();
	} catch (error) {
		expect((error as { code?: string }).code).toBe("SYNC_REQUIRED");
	}
	if (plan !== null) {
		expect(plan).toEqual([]);
		await expect(controller.authorizeMigration("migration password")).resolves.toEqual([]);
	}
	const after = controller.session;
	expect(after).not.toBe(before);
	expect(after.store).toBe(before.store);
	await after.engine.balance();
	await controller.prepareMigration().catch(() => {});
	await controller.cancelMigration();
	expect(controller.unlocked).toBe(true);
	await controller.shutdown();
}, 300_000);
