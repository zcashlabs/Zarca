import { BrowserView, BrowserWindow, Tray, Updater, Utils } from "electrobun/main";
import type { InvokeResponse, ZarcaRPCSchema } from "../shared/api";
import { Controller } from "./app/controller";
import { IncorrectPasswordError } from "./security/vault";
import { createHandlers, dispatch, type Host } from "./rpc/handlers";
import { watchSleep } from "./system/sleep";
import { startAutomation } from "./dev/automation";

const DEV_SERVER = "http://localhost:5173";

let window: BrowserWindow<ReturnType<typeof createRpc>> | null = null;
let revision = 0;
let lastActivity = Date.now();

const controller = new Controller({
	session: (state) => send((rpc) => rpc.send.session(state)),
	sync: (state) => send((rpc) => rpc.send.sync(state)),
	changed: () => send((rpc) => rpc.send.changed({ revision: ++revision })),
});

function send(fn: (rpc: ReturnType<typeof createRpc>) => void) {
	const rpc = window?.webview?.rpc;
	if (!rpc) return;
	try {
		fn(rpc);
	} catch {
		// The view may be reloading; it re-reads state on load.
	}
}

const host: Host = {
	async chooseFolder() {
		const paths = await Utils.openFileDialog({ canChooseFiles: false, canChooseDirectory: true, allowsMultipleSelection: false });
		return paths[0] || null;
	},
	async chooseFile(extension) {
		const paths = await Utils.openFileDialog({
			canChooseFiles: true,
			canChooseDirectory: false,
			allowsMultipleSelection: false,
			allowedFileTypes: extension,
		});
		return paths[0] || null;
	},
	openExternal: (url) => Utils.openExternal(url),
	copy: (text) => Utils.clipboardWriteText(text),
};

const handlers = createHandlers(controller, host);

function createRpc() {
	return BrowserView.defineRPC<ZarcaRPCSchema>({
		maxRequestTime: 10 * 60_000, // proving and syncing first blocks can take a while
		handlers: {
			requests: {
				invoke: async ({ method, params }): Promise<InvokeResponse> => {
					lastActivity = Date.now();
					try {
						return { ok: true, value: await dispatch(handlers, method, params) };
					} catch (error) {
						const code = error instanceof IncorrectPasswordError ? "INCORRECT_PASSWORD" : (error as { code?: string })?.code;
						const message = error instanceof Error ? error.message : "Something went wrong";
						if (!(error instanceof IncorrectPasswordError)) console.error(`[rpc] ${method} failed: ${message}`);
						return { ok: false, error: message, ...(typeof code === "string" ? { code } : {}) };
					}
				},
			},
			messages: {
				activity: () => {
					lastActivity = Date.now();
				},
			},
		},
	});
}

async function viewUrl() {
	if ((await Updater.localInfo.channel()) === "dev") {
		try {
			await fetch(DEV_SERVER, { method: "HEAD", signal: AbortSignal.timeout(500) });
			return DEV_SERVER;
		} catch {
			// Fall back to the bundled view.
		}
	}
	return "views://mainview/index.html";
}

async function openWindow() {
	if (window) {
		window.show();
		window.focus();
		return;
	}
	const rpc = createRpc();
	const url = await viewUrl();
	window = new BrowserWindow({
		title: "Zarca",
		url,
		// Fits a 1366×768 laptop work area (taskbar/menu bar included).
		frame: { width: 1200, height: 700, x: 80, y: 40 },
		rpc,
	});
	// The view may only show bundled pages (and the local dev server during development).
	window.webview.setNavigationRules(["^*", "views://*", ...(url.startsWith(DEV_SERVER) ? [`${DEV_SERVER}/*`] : [])]);
	window.on("close", () => {
		window = null;
		// The app keeps running (and syncing) until the wallet locks.
		if (!controller.unlocked) void quit();
	});
}

async function quit() {
	await controller.shutdown().catch(() => {});
	Utils.quit();
}

// ---- Locking: inactivity and sleep ----

setInterval(() => {
	if (!controller.unlocked) return;
	const limit = controller.registry.settings.autoLockMinutes * 60_000;
	if (Date.now() - lastActivity > limit) {
		void controller.lock("idle").then(() => {
			if (!window) void quit();
		});
	}
}, 15_000);

watchSleep(() => {
	if (controller.unlocked) {
		void controller.lock("sleep").then(() => {
			if (!window) void quit();
		});
	}
});

// ---- Tray ----

try {
	const tray = new Tray({ title: "Zarca", template: false });
	tray.setMenu([
		{ type: "normal", label: "Open Zarca", action: "open" },
		{ type: "normal", label: "Lock wallet", action: "lock" },
		{ type: "divider" },
		{ type: "normal", label: "Quit", action: "quit" },
	]);
	tray.on("tray-clicked", (event) => {
		const action = (event as { data?: { action?: string } }).data?.action;
		if (action === "lock") void controller.lock("manual");
		else if (action === "quit") void quit();
		else void openWindow();
	});
} catch {
	// Tray support depends on the desktop environment; the app works without it.
}

process.on("SIGTERM", () => void quit());
process.on("SIGINT", () => void quit());

await openWindow();

if (process.env.ZARCA_AUTOMATION_SOCKET && (await Updater.localInfo.channel()) === "dev") {
	startAutomation(async (script) => {
		const rpc = window?.webview?.rpc as unknown as { request: { evaluateJavascriptWithResponse(args: { script: string }): Promise<unknown> } } | undefined;
		if (!rpc) throw new Error("No window");
		return rpc.request.evaluateJavascriptWithResponse({ script });
	});
}
