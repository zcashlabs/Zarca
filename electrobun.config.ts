import type { ElectrobunConfig } from "electrobun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir;

// zcash.js locates its WASM engine, workers and proving parameters relative to
// its own modules, so it must ship as an unbundled package next to the main
// process bundle, together with its runtime dependencies.
const EXTERNAL = ["@zcashlabs/zcash.js"];
const TYPES_ONLY = new Set(["@types/node", "undici-types"]);

function runtimeClosure(roots: string[]): string[] {
	const seen = new Set<string>();
	const visit = (name: string) => {
		if (seen.has(name) || TYPES_ONLY.has(name)) return;
		seen.add(name);
		const manifest = JSON.parse(readFileSync(join(ROOT, "node_modules", name, "package.json"), "utf8"));
		for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency);
	};
	roots.forEach(visit);
	return [...seen].sort();
}

const packages = Object.fromEntries(runtimeClosure(EXTERNAL).map((name) => [`node_modules/${name}`, `node_modules/${name}`]));

export default {
	app: {
		name: "Zarca",
		identifier: "dev.zcashlabs.zarca",
		version: "0.1.0",
	},
	runtime: {
		// The treasury keeps syncing after its window closes, until the wallet locks.
		exitOnLastWindowClosed: false,
	},
	build: {
		mainProcess: "bun",
		bun: {
			entrypoint: "src/bun/index.ts",
			external: EXTERNAL,
		},
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
			...packages,
		},
		watchIgnore: ["dist/**"],
		mac: {
			bundleCEF: false,
			// Camera access is requested only when the user opens the QR scanner.
			entitlements: {
				"com.apple.security.device.camera": "Zarca uses the camera only to scan payment QR codes.",
			},
		},
		linux: { bundleCEF: false },
		win: { bundleCEF: false },
	},
} satisfies ElectrobunConfig;
