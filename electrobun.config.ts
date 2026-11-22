import type { ElectrobunConfig } from "electrobun";

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
		},
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
		},
		watchIgnore: ["dist/**"],
		mac: { bundleCEF: false },
		linux: { bundleCEF: false },
		win: { bundleCEF: false },
	},
} satisfies ElectrobunConfig;
