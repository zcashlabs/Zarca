// Application-wide, non-secret state: settings and the wallet picker list.
// Balances, activity and records never live here.
import { join } from "node:path";
import type { AppSettings, NetworkName, ThemePreference, WalletEntry } from "../../shared/types";
import { DEFAULT_SERVERS } from "../engine/networks";
import { dataRoot, ensurePrivateDir, readJson, writeJsonAtomic } from "../storage/files";

interface AppFile {
	readonly format: "zarca-app/1";
	readonly settings: AppSettings;
	readonly wallets: WalletEntry[];
}

export const DEFAULT_SETTINGS: AppSettings = {
	theme: "system",
	autoLockMinutes: 10,
	servers: DEFAULT_SERVERS,
};

export class Registry {
	private file: AppFile;

	constructor(readonly root: string = dataRoot()) {
		ensurePrivateDir(root);
		ensurePrivateDir(join(root, "wallets"));
		const stored = readJson<AppFile>(this.path);
		this.file = stored?.format === "zarca-app/1"
			? { ...stored, settings: { ...DEFAULT_SETTINGS, ...stored.settings, servers: { ...DEFAULT_SERVERS, ...stored.settings?.servers } } }
			: { format: "zarca-app/1", settings: DEFAULT_SETTINGS, wallets: [] };
	}

	private get path() {
		return join(this.root, "app.json");
	}

	private save() {
		writeJsonAtomic(this.path, this.file);
	}

	walletDir(id: string) {
		if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid wallet id");
		return join(this.root, "wallets", id);
	}

	get settings(): AppSettings {
		return this.file.settings;
	}

	get wallets(): readonly WalletEntry[] {
		return this.file.wallets;
	}

	wallet(id: string): WalletEntry {
		const entry = this.file.wallets.find((w) => w.id === id);
		if (!entry) throw new Error("Wallet not found");
		return entry;
	}

	addWallet(entry: WalletEntry) {
		this.file = { ...this.file, wallets: [...this.file.wallets, entry] };
		this.save();
	}

	renameWallet(id: string, name: string) {
		const clean = validateWalletName(name);
		this.wallet(id);
		this.file = { ...this.file, wallets: this.file.wallets.map((w) => (w.id === id ? { ...w, name: clean } : w)) };
		this.save();
	}

	removeWallet(id: string) {
		this.file = { ...this.file, wallets: this.file.wallets.filter((w) => w.id !== id) };
		this.save();
	}

	updateSettings(patch: Partial<{ theme: ThemePreference; autoLockMinutes: number; server: { network: NetworkName; url: string } }>) {
		let settings = this.file.settings;
		if (patch.theme !== undefined) {
			if (!["system", "light", "dark"].includes(patch.theme)) throw new Error("Invalid theme");
			settings = { ...settings, theme: patch.theme };
		}
		if (patch.autoLockMinutes !== undefined) {
			const minutes = patch.autoLockMinutes;
			if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) throw new Error("Auto-lock must be between 1 and 240 minutes");
			settings = { ...settings, autoLockMinutes: minutes };
		}
		if (patch.server !== undefined) {
			settings = { ...settings, servers: { ...settings.servers, [patch.server.network]: validateServer(patch.server.url) } };
		}
		this.file = { ...this.file, settings };
		this.save();
	}
}

export function validateWalletName(name: string): string {
	const clean = name.trim().replace(/\s+/g, " ");
	if (!clean) throw new Error("Give the wallet a name");
	if (clean.length > 60) throw new Error("Wallet names can be at most 60 characters");
	return clean;
}

/** Lightwallet (gRPC) endpoints only: https://host[:port]. */
export function validateServer(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url.trim());
	} catch {
		throw new Error("Enter a server URL such as https://zec.rocks:443");
	}
	if (parsed.protocol !== "https:") throw new Error("The server must use https:// (TLS gRPC)");
	if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
		throw new Error("Use only the scheme, host and port of a lightwalletd gRPC server");
	}
	return `https://${parsed.host}${parsed.port ? "" : ":443"}`;
}
