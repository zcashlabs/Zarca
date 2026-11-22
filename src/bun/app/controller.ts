// Owns the single unlocked wallet session. Locking or switching closes the
// engine (stopping sync), closes the treasury store and wipes the data key.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import type {
	LockReason,
	NetworkName,
	SessionState,
	SyncState,
	WalletEntry,
	WalletSettings,
} from "../../shared/types";
import { generateOccurrences } from "../domain/schedules";
import { backupSnapshot, openBackup, walletFingerprint } from "../domain/backup";
import { Engine, type MigrationStep } from "../engine/engine";
import { defaultCurrency, NoRates, RateService, SUPPORTED_CURRENCIES } from "../fiat/rates";
import { NearIntents } from "../near/intents";
import { PaymentService } from "../payments/service";
import { subkey, wipe } from "../security/crypto";
import { changeVaultPassword, createVault, openSeed, unlockVault, validatePassword, verifyPassword } from "../security/vault";
import { ensurePrivateDir } from "../storage/files";
import { TreasuryStore } from "../storage/treasury-store";
import { Registry, validateWalletName } from "./registry";

export interface Session {
	readonly entry: WalletEntry;
	readonly dir: string;
	readonly store: TreasuryStore;
	readonly engine: Engine;
	readonly payments: PaymentService;
	readonly memos: Map<string, string[]>;
	/** txid -> our receiving addresses, used to recognize refunds. */
	readonly receivedAt: Map<string, string[]>;
	/** Cached chain history, invalidated when the scan advances. */
	history: { at: number; entries: Awaited<ReturnType<Engine["history"]>> } | null;
	/** Exchange rates for this wallet's network (none on testnet). */
	readonly rates: RateService;
	settings: WalletSettings;
	dataKey: Uint8Array;
}

export interface ControllerEvents {
	session(state: SessionState): void;
	sync(state: SyncState): void;
	changed(): void;
}

const PHRASE_TTL_MS = 30 * 60_000;

export class Controller {
	readonly registry: Registry;
	private readonly mainnetRates = new RateService();
	private readonly testnetRates = new NoRates();
	readonly near = new NearIntents();
	private current: Session | null = null;
	private pending = new Map<string, { phrase: Uint8Array; expires: number }>();
	private lockReason: LockReason | null = null;
	private busy: Promise<unknown> = Promise.resolve();
	private migration: { session: Session; engine: Engine; steps: MigrationStep[]; expires: number } | null = null;

	constructor(private readonly events: ControllerEvents, registry = new Registry()) {
		this.registry = registry;
	}

	get session(): Session {
		if (!this.current) throw new Error("No wallet is unlocked");
		return this.current;
	}

	get unlocked() {
		return this.current !== null;
	}

	state(): SessionState {
		return {
			wallets: this.registry.wallets,
			unlocked: this.current?.entry ?? null,
			settings: this.registry.settings,
			walletSettings: this.current?.settings ?? null,
			lockReason: this.current ? null : this.lockReason,
		};
	}

	private emitSession() {
		this.events.session(this.state());
	}

	/** Serializes lifecycle transitions (unlock/lock/switch/create/delete). */
	private exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.busy.then(fn, fn);
		this.busy = run.catch(() => {});
		return run;
	}

	// ---- Creation ----

	/** Generates a 24-word phrase held in memory until creation completes or it expires. */
	generatePhrase(): { token: string; words: string[] } {
		for (const [token, entry] of this.pending) if (entry.expires < Date.now()) this.discardPhrase(token);
		const phrase = generateMnemonic(wordlist, 256);
		const token = randomUUID();
		this.pending.set(token, { phrase: new TextEncoder().encode(phrase), expires: Date.now() + PHRASE_TTL_MS });
		return { token, words: phrase.split(" ") };
	}

	discardPhrase(token: string) {
		const entry = this.pending.get(token);
		entry?.phrase.fill(0);
		this.pending.delete(token);
	}

	createWallet(args: { token: string; name: string; network: NetworkName; password: string; confirmation: Record<number, string> }) {
		return this.exclusive(async () => {
			const entry = this.pending.get(args.token);
			if (!entry || entry.expires < Date.now()) throw new Error("The recovery phrase expired. Start again.");
			const words = new TextDecoder().decode(entry.phrase).split(" ");
			const indices = Object.keys(args.confirmation).map(Number);
			if (indices.length < 3 || indices.some((i) => words[i] !== args.confirmation[i]?.trim().toLowerCase())) {
				throw new Error("The confirmation words do not match your recovery phrase.");
			}
			await this.provision({ name: args.name, network: args.network, password: args.password, mnemonic: entry.phrase, mode: { kind: "create" } });
			this.discardPhrase(args.token);
		});
	}

	importWallet(args: {
		name: string;
		network: NetworkName;
		password: string;
		phrase: string;
		createdAfter: string | null;
		backup: { bytes: Uint8Array; password: string } | null;
	}) {
		return this.exclusive(async () => {
			const phrase = args.phrase.trim().toLowerCase().split(/\s+/).join(" ");
			if (!validateMnemonic(phrase, wordlist)) throw new Error("This recovery phrase is not valid. Check each word and its order.");
			const mnemonic = new TextEncoder().encode(phrase);
			try {
				// Validate the backup before anything is written.
				let snapshot: Uint8Array | null = null;
				if (args.backup) {
					const payload = await openBackup(args.backup.bytes, args.backup.password);
					snapshot = backupSnapshot(payload, mnemonic, args.network);
				}
				const createdAfter = args.createdAfter ? new Date(`${args.createdAfter}T00:00:00Z`) : null;
				if (createdAfter && Number.isNaN(createdAfter.getTime())) throw new Error("Invalid wallet creation date");
				await this.provision({
					name: args.name,
					network: args.network,
					password: args.password,
					mnemonic,
					mode: { kind: "import", createdAfter, snapshot },
				});
			} finally {
				mnemonic.fill(0);
			}
		});
	}

	private async provision(args: {
		name: string;
		network: NetworkName;
		password: string;
		mnemonic: Uint8Array;
		mode: { kind: "create" } | { kind: "import"; createdAfter: Date | null; snapshot: Uint8Array | null };
	}) {
		const name = validateWalletName(args.name);
		validatePassword(args.password);
		if (args.network !== "mainnet" && args.network !== "testnet") throw new Error("Unknown network");
		if (this.registry.wallets.some((w) => w.name.toLowerCase() === name.toLowerCase())) throw new Error("A wallet with this name already exists");
		await this.lockInternal("switch");

		const id = randomUUID();
		const dir = this.registry.walletDir(id);
		ensurePrivateDir(dir);
		let dataKey: Uint8Array | null = null;
		let engine: Engine | null = null;
		let store: TreasuryStore | null = null;
		try {
			dataKey = await createVault(join(dir, "vault.json"), id, args.password, args.mnemonic);
			if (args.mode.kind === "import" && args.mode.snapshot) {
				TreasuryStore.replace(join(dir, "treasury.bin"), id, dataKey, args.mode.snapshot);
			}
			store = TreasuryStore.open(join(dir, "treasury.bin"), id, dataKey);
			const fingerprint = walletFingerprint(args.mnemonic);
			store.write((db) => {
				db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('fingerprint', ?)", [fingerprint]);
				db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('fiatCurrency', ?)", [defaultCurrency()]);
				db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('timezone', ?)", [Intl.DateTimeFormat().resolvedOptions().timeZone]);
			});
			const engineDir = join(dir, "engine");
			mkdirSync(engineDir, { mode: 0o700 });
			engine = await this.openEngine(engineDir, args.network, dataKey);
			if (args.mode.kind === "create") await engine.createAccount(args.mnemonic);
			else await engine.importAccount(args.mnemonic, args.mode.createdAfter);
			const entry: WalletEntry = { id, name, network: args.network, createdAt: new Date().toISOString() };
			this.registry.addWallet(entry);
			this.activate(entry, dir, dataKey, store, engine);
		} catch (error) {
			await engine?.close().catch(() => {});
			store?.close();
			if (dataKey) wipe(dataKey);
			rmSync(dir, { recursive: true, force: true });
			throw error;
		}
	}

	private async openEngine(path: string, network: NetworkName, dataKey: Uint8Array) {
		const key = subkey(dataKey, "engine");
		try {
			return await Engine.open({ path, network, server: this.registry.settings.servers[network], encryptionKey: key });
		} finally {
			wipe(key);
		}
	}

	private activate(entry: WalletEntry, dir: string, dataKey: Uint8Array, store: TreasuryStore, engine: Engine) {
		const settings = readWalletSettings(store);
		const memos = new Map<string, string[]>();
		const rates = entry.network === "mainnet" ? this.mainnetRates : this.testnetRates;
		const session: Session = {
			entry,
			dir,
			store,
			engine,
			memos,
			receivedAt: new Map(),
			history: null,
			rates,
			settings,
			dataKey,
			payments: new PaymentService({
				store,
				engine,
				rates,
				near: this.near,
				currency: () => session.settings.fiatCurrency,
				openSeed: (password) => openSeed(join(dir, "vault.json"), entry.id, password),
				chainHistory: async () => new Map((await engine.history()).map((h) => [String(h.txid), h.minedHeight])),
				changed: () => this.events.changed(),
			}),
		};
		this.current = session;
		this.lockReason = null;
		store.write((db) => generateOccurrences(db));
		let lastScanned: number | null = null;
		let lastPhase: string | null = null;
		engine.onSync((state) => {
			if (this.current !== session) return;
			this.events.sync(state);
			// Data only changes when new blocks were scanned or a sync completed.
			const advanced = state.scannedHeight !== lastScanned && state.phase === "synced";
			const finished = state.phase === "synced" && lastPhase !== "synced";
			lastScanned = state.scannedHeight;
			lastPhase = state.phase;
			if (advanced || finished) {
				session.history = null;
				this.events.changed();
			}
		});
		engine.startSync();
		session.payments.start();
		void session.payments.sweepStrayProposals().catch(() => {});
		this.emitSession();
	}

	// ---- Unlock / lock ----

	unlock(walletId: string, password: string) {
		return this.exclusive(async () => {
			const entry = this.registry.wallet(walletId);
			const dir = this.registry.walletDir(walletId);
			if (this.current?.entry.id === walletId) return;
			const dataKey = await unlockVault(join(dir, "vault.json"), walletId, password);
			await this.lockInternal("switch");
			let store: TreasuryStore | null = null;
			try {
				store = TreasuryStore.open(join(dir, "treasury.bin"), walletId, dataKey);
				const engine = await this.openEngine(join(dir, "engine"), entry.network, dataKey);
				this.activate(entry, dir, dataKey, store, engine);
			} catch (error) {
				store?.close();
				wipe(dataKey);
				throw error;
			}
		});
	}

	lock(reason: LockReason) {
		return this.exclusive(() => this.lockInternal(reason));
	}

	private async lockInternal(reason: LockReason) {
		const session = this.current;
		if (!session) return;
		if (this.migration) {
			const m = this.migration;
			this.migration = null;
			for (const step of m.steps) await m.engine.abandon(step.proposal.operationId);
			await m.engine.close().catch(() => {});
		}
		this.current = null;
		this.lockReason = reason;
		// Locking must always complete: graceful steps are bounded so a stalled
		// network call can never keep keys in memory or the treasury open.
		const bounded = (work: Promise<unknown>) =>
			Promise.race([work.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 10_000))]);
		try {
			await bounded(session.payments.stop());
		} finally {
			try {
				await bounded(session.engine.close());
			} finally {
				session.store.close();
				wipe(session.dataKey);
				session.memos.clear();
				session.receivedAt.clear();
				this.emitSession();
			}
		}
	}

	// ---- Moving older funds into Ironwood (#10) ----

	/** Reopens the engine with the migration policy and returns proposals for review. */
	prepareMigration() {
		return this.exclusive(async () => {
			const session = this.session;
			if (this.migration) await this.endMigration(true);
			const active = session.store.read((db) => db.query("SELECT COUNT(*) AS n FROM attempts WHERE status IN ('preparing', 'submitted', 'unknown')").get() as { n: number }).n;
			if (active) throw new Error("Wait until payments in progress have settled before moving funds.");
			await session.payments.stop();
			await session.engine.close();
			const key = subkey(session.dataKey, "engine");
			let engine: Engine;
			try {
				engine = await Engine.open({ path: join(session.dir, "engine"), network: session.entry.network, server: this.registry.settings.servers[session.entry.network], encryptionKey: key, policy: "migration" });
			} finally {
				wipe(key);
			}
			try {
				const status = await engine.wallet.sync({ signal: AbortSignal.timeout(120_000) });
				if (!status.targetReached) throw new Error("Could not finish syncing; try again shortly.");
				const steps = await engine.proposeMigration(randomUUID());
				this.migration = { session, engine, steps, expires: Date.now() + 10 * 60_000 };
				return steps.map((s) => ({ pool: s.pool, amountZat: s.amount.toString(), feeZat: s.fee.toString() }));
			} catch (error) {
				this.migration = { session, engine, steps: [], expires: 0 };
				await this.endMigration(true);
				throw error;
			}
		});
	}

	authorizeMigration(password: string) {
		return this.exclusive(async () => {
			const migration = this.migration;
			if (!migration || migration.session !== this.current) throw new Error("Review the move again.");
			if (Date.now() > migration.expires) {
				await this.endMigration(true);
				throw new Error("This review expired. Review the move again.");
			}
			const seed = await openSeed(join(migration.session.dir, "vault.json"), migration.session.entry.id, password);
			const results: { pool: string; txids: string[]; error: string | null }[] = [];
			try {
				for (const step of migration.steps) {
					try {
						const pending = await migration.engine.execute(step.proposal, seed);
						const snapshot = await pending.snapshot();
						results.push({ pool: step.pool, txids: snapshot.steps.map((s) => s.txid).filter((t): t is NonNullable<typeof t> => t !== null).map(String), error: null });
					} catch (error) {
						results.push({ pool: step.pool, txids: [], error: error instanceof Error ? error.message : String(error) });
					}
				}
			} finally {
				seed.fill(0);
				migration.steps = [];
				await this.endMigration(false);
			}
			return results;
		});
	}

	cancelMigration() {
		return this.exclusive(() => this.endMigration(true));
	}

	/** Closes the migration engine and restores the normal session. */
	private async endMigration(abandon: boolean) {
		const migration = this.migration;
		if (!migration) return;
		this.migration = null;
		if (abandon) for (const step of migration.steps) await migration.engine.abandon(step.proposal.operationId);
		await migration.engine.close();
		const { session } = migration;
		if (this.current !== session) return;
		const engine = await this.openEngine(join(session.dir, "engine"), session.entry.network, session.dataKey);
		this.activate(session.entry, session.dir, session.dataKey, session.store, engine);
	}

	// ---- Wallet management ----

	renameWallet(walletId: string, name: string) {
		this.registry.renameWallet(walletId, name);
		if (this.current?.entry.id === walletId) {
			(this.current as { entry: WalletEntry }).entry = this.registry.wallet(walletId);
		}
		this.emitSession();
	}

	async changePassword(current: string, next: string) {
		const session = this.session;
		await changeVaultPassword(join(session.dir, "vault.json"), session.entry.id, current, next);
	}

	async verifyPassword(password: string) {
		const session = this.session;
		await verifyPassword(join(session.dir, "vault.json"), session.entry.id, password);
	}

	deleteWallet(walletId: string, password: string, confirmName: string) {
		return this.exclusive(async () => {
			const entry = this.registry.wallet(walletId);
			if (confirmName.trim() !== entry.name) throw new Error("Type the wallet name exactly to confirm deletion.");
			const dir = this.registry.walletDir(walletId);
			await verifyPassword(join(dir, "vault.json"), walletId, password);
			if (this.current?.entry.id === walletId) await this.lockInternal("deleted");
			this.registry.removeWallet(walletId);
			rmSync(dir, { recursive: true, force: true });
			this.emitSession();
		});
	}

	updateWalletSettings(patch: Partial<WalletSettings>) {
		const session = this.session;
		if (patch.fiatCurrency !== undefined && !(SUPPORTED_CURRENCIES as readonly string[]).includes(patch.fiatCurrency)) {
			throw new Error("Unsupported currency");
		}
		if (patch.timezone !== undefined) new Intl.DateTimeFormat("en-US", { timeZone: patch.timezone });
		session.store.write((db) => {
			for (const [key, value] of Object.entries(patch)) {
				db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, String(value)]);
			}
		});
		session.settings = readWalletSettings(session.store);
		this.emitSession();
		this.events.changed();
	}

	/** Server changes apply on the next unlock of each wallet. */
	async updateServer(network: NetworkName, url: string) {
		this.registry.updateSettings({ server: { network, url } });
		const session = this.current;
		if (session && session.entry.network === network) {
			const id = session.entry.id;
			const dataKey = Uint8Array.from(session.dataKey);
			await this.exclusive(async () => {
				await this.lockInternal("switch");
				const dir = this.registry.walletDir(id);
				const store = TreasuryStore.open(join(dir, "treasury.bin"), id, dataKey);
				const engine = await this.openEngine(join(dir, "engine"), network, dataKey);
				this.activate(this.registry.wallet(id), dir, dataKey, store, engine);
			});
		}
		this.emitSession();
	}

	async shutdown() {
		await this.lock("quit");
		for (const token of [...this.pending.keys()]) this.discardPhrase(token);
	}
}

function readWalletSettings(store: TreasuryStore): WalletSettings {
	const rows = store.read((db) => db.query("SELECT key, value FROM settings").all()) as { key: string; value: string }[];
	const map = new Map(rows.map((r) => [r.key, r.value]));
	return {
		fiatCurrency: map.get("fiatCurrency") ?? defaultCurrency(),
		timezone: map.get("timezone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
	};
}
