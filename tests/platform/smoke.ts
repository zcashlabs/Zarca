// Platform smoke test: does the zcash.js engine run under Bun on this OS?
// Usage: bun tests/platform/smoke.ts   (needs network access to testnet)
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Engine } from "../../src/bun/engine/engine";
import { randomKey } from "../../src/bun/security/crypto";
import { createWalletClient } from "@zcashlabs/zcash.js";
import { networkFor, DEFAULT_SERVERS } from "../../src/bun/engine/networks";

const results: Record<string, string> = { platform: `${process.platform}-${process.arch}`, bun: Bun.version };

async function step(name: string, fn: () => Promise<string>) {
	const started = performance.now();
	try {
		results[name] = `ok (${await fn()}, ${Math.round(performance.now() - started)} ms)`;
	} catch (error) {
		results[name] = `FAILED: ${error instanceof Error ? `${(error as { code?: string }).code ?? error.name}: ${error.message}` : String(error)}`;
	}
}

await step("memory-wallet-sync", async () => {
	const wallet = await createWalletClient(DEFAULT_SERVERS.testnet, { network: await networkFor("testnet"), storage: { kind: "memory" } });
	try {
		const status = await wallet.sync();
		return `tip ${status.scan.tipHeight}`;
	} finally {
		await wallet.close();
	}
});

await step("encrypted-filesystem-wallet", async () => {
	const options = {
		path: mkdtempSync(join(tmpdir(), "zarca-smoke-")),
		network: "testnet" as const,
		server: DEFAULT_SERVERS.testnet,
		encryptionKey: randomKey(),
	};
	await (await Engine.open(options)).close();
	// Reopening an existing database exercises read-only opens and the owner lease
	// release (a Windows-only failure before jp4g/zakura-wasm-bindings#43).
	await (await Engine.open(options)).close();
	return "opened, closed and reopened";
});

console.log(JSON.stringify(results, null, 2));
if (Object.values(results).some((v) => v.startsWith("FAILED"))) process.exitCode = 1;
