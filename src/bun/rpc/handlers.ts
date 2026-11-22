import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Api, ImportCandidateView, Method, Params, Result } from "../../shared/api";
import type {
	ActivityItem,
	Contact,
	ContactInput,
	Destination,
	NetworkName,
	OverviewView,
	PaymentView,
	RecipientSnapshot,
	ScheduleView,
} from "../../shared/types";
import { addDays, todayIn } from "../../shared/recurrence";
import { buildActivity, classifyHistory } from "../domain/activity";
import { allTags, setNote, setTags } from "../domain/annotations";
import { createBackup } from "../domain/backup";
import {
	createContact,
	deleteContact,
	exportContacts,
	getContact,
	listContacts,
	parseContactExport,
	previewImport,
	updateContact,
	validateContactInput,
} from "../domain/contacts";
import { buildCsv } from "../domain/csv";
import { getPayment, listPayments, updateAnnotations } from "../domain/payments";
import { buildReport, localDate } from "../domain/reports";
import { cancelSchedule, createSchedule, listSchedules, outstandingForSchedule, skipOccurrence } from "../domain/schedules";
import { cleanText } from "../domain/util";
import { recordValuation, SUPPORTED_CURRENCIES } from "../fiat/rates";
import { validateForeignAddress } from "../near/intents";
import { readFileIfExists, writeFileAtomic } from "../storage/files";
import type { Controller } from "../app/controller";

/** Native capabilities the handlers need; provided by the Electrobun host. */
export interface Host {
	chooseFolder(): Promise<string | null>;
	chooseFile(extension: string): Promise<string | null>;
	openExternal(url: string): void;
	copy(text: string): void;
}

type Handler<M extends Method> = (params: Params<M>) => Promise<Result<M>> | Result<M>;
type Handlers = { [M in Method]: Handler<M> };

const str = (value: unknown, field: string, max = 2000): string => {
	if (typeof value !== "string" || value.length > max) throw new Error(`Invalid ${field}`);
	return value;
};
const network = (value: unknown): NetworkName => {
	if (value !== "mainnet" && value !== "testnet") throw new Error("Invalid network");
	return value;
};
const date = (value: unknown, field: string) => {
	const text = str(value, field, 10);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`Invalid ${field}`);
	return text;
};

function uniqueFile(folder: string, base: string, extension: string) {
	for (let i = 0; i < 1000; i++) {
		const path = join(folder, `${base}${i ? `-${i}` : ""}.${extension}`);
		try {
			statSync(path);
		} catch {
			return path;
		}
	}
	throw new Error("Could not choose a file name");
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "wallet";

export function createHandlers(controller: Controller, host: Host): Handlers {
	const session = () => controller.session;

	async function validateDestination(destination: Omit<Destination, "id">): Promise<string | null> {
		const { engine } = session();
		if (destination.route === "zcash") {
			const check = await engine.validateAddress(destination.address);
			return check.valid ? null : `Not a valid ${engine.networkName} Zcash address`;
		}
		if (engine.networkName !== "mainnet") return "Cross-chain destinations are only available on mainnet wallets";
		const asset = (await controller.near.assets()).find((a) => a.assetId === destination.asset);
		if (!asset) return "Choose a supported asset";
		if (asset.chain !== destination.chain) return "The asset does not match the destination network";
		return validateForeignAddress(destination.chain, destination.address);
	}

	function validateRecipient(raw: RecipientSnapshot): RecipientSnapshot {
		if (!raw || typeof raw !== "object") throw new Error("Choose a recipient");
		return {
			contactId: raw.contactId ? str(raw.contactId, "contact", 64) : null,
			contactName: cleanText(raw.contactName, "Contact name", 80),
			destinationLabel: cleanText(raw.destinationLabel, "Destination label", 60),
			route: raw.route === "near-intents" ? "near-intents" : raw.route === "zcash" ? "zcash" : (() => { throw new Error("Invalid route"); })(),
			chain: raw.route === "zcash" ? "zcash" : str(raw.chain, "network", 40),
			asset: raw.route === "zcash" ? null : str(raw.asset, "asset", 200),
			assetSymbol: raw.route === "zcash" ? "ZEC" : cleanText(raw.assetSymbol, "asset symbol", 20),
			address: str(raw.address, "address", 600).trim(),
		};
	}

	/** Memos for received transactions, fetched lazily and cached for the session. */
	async function loadMemos(txids: string[]) {
		const s = session();
		const missing = txids.filter((t) => !s.memos.has(t)).slice(0, 40);
		await Promise.all(
			missing.map(async (txid) => {
				try {
					const tx = await s.engine.transaction(txid);
					const accountId = s.engine.accountId;
					const received = (tx?.outputs ?? []).filter((o) => o.receivingAccountIds.includes(accountId) && o.isChange !== true);
					const memos = received
						.filter((o) => o.memo.kind === "text")
						.map((o) => (o.memo as { text: string }).text.trim())
						.filter(Boolean);
					s.memos.set(txid, memos);
					s.receivedAt.set(txid, received.map((o) => o.address).filter((a): a is string => typeof a === "string"));
				} catch {
					// Leave uncached and retry later.
				}
			}),
		);
	}

	/** Records historical valuation evidence for settled chain activity that lacks it. */
	async function recordMissingValuations(items: ActivityItem[]) {
		const s = session();
		const currency = s.settings.fiatCurrency;
		for (const item of items) {
			const subject = item.kind === "incoming" ? `tx:${item.incoming.txid}` : item.kind === "external" ? `tx:${item.external.txid}` : null;
			const at = item.kind === "incoming" ? item.incoming.blockTime : item.kind === "external" ? item.external.blockTime : null;
			const existing = item.kind === "incoming" ? item.incoming.valuation : item.kind === "external" ? item.external.valuation : null;
			if (!subject || !at || existing) continue;
			const quote = await s.rates
				.daily(s.store.db, currency, at.slice(0, 10), (fn) => s.store.write(fn))
				.catch(() => null);
			if (!quote) return; // rates unavailable; try again later
			if (controller.session !== s) return;
			s.store.write((db) => recordValuation(db, subject, { ...quote, observedAt: at }));
		}
	}

	let valuating = false;
	async function activity(): Promise<ActivityItem[]> {
		const s = session();
		const currency = s.settings.fiatCurrency;
		const payments = s.store.read((db) => listPayments(db, currency));
		const history = s.engine.hasAccount ? await s.engine.history() : [];
		const incomingTxids = history.filter((h) => h.balanceDelta > 0n).map((h) => String(h.txid));
		await loadMemos(incomingTxids);
		const chain = classifyHistory(s.store, history, payments, s.memos, s.receivedAt, s.engine.syncState.tipHeight, currency);
		const items = buildActivity(payments, chain);
		if (!valuating) {
			valuating = true;
			void recordMissingValuations(items).finally(() => {
				valuating = false;
			});
		}
		return items;
	}

	const sum = (payments: PaymentView[]) => payments.reduce((n, p) => n + BigInt(p.amountZat), 0n).toString();

	const handlers: Handlers = {
		"session.get": () => controller.state(),
		"session.unlock": async (p) => {
			await controller.unlock(str(p.walletId, "wallet", 64), str(p.password, "password", 1024));
			return controller.state();
		},
		"session.lock": async (p) => {
			await controller.lock(p?.reason === "idle" ? "idle" : "manual");
			return controller.state();
		},
		"session.sync": () => (controller.unlocked ? session().engine.syncState : null),

		"wallet.generatePhrase": () => controller.generatePhrase(),
		"wallet.discardPhrase": (p) => controller.discardPhrase(str(p.token, "token", 64)),
		"wallet.create": async (p) => {
			const confirmation: Record<number, string> = {};
			for (const [k, v] of Object.entries(p.confirmation ?? {})) confirmation[Number(k)] = str(v, "word", 20);
			await controller.createWallet({
				token: str(p.token, "token", 64),
				name: str(p.name, "name", 200),
				network: network(p.network),
				password: str(p.password, "password", 1024),
				confirmation,
			});
			return controller.state();
		},
		"wallet.import": async (p) => {
			let backup: { bytes: Uint8Array; password: string } | null = null;
			if (p.backupPath) {
				const bytes = readFileIfExists(str(p.backupPath, "backup", 4096));
				if (!bytes) throw new Error("The backup file could not be read");
				backup = { bytes, password: str(p.backupPassword ?? "", "backup password", 1024) };
			}
			await controller.importWallet({
				name: str(p.name, "name", 200),
				network: network(p.network),
				password: str(p.password, "password", 1024),
				phrase: str(p.phrase, "recovery phrase", 1000),
				createdAfter: p.createdAfter ? date(p.createdAfter, "date") : null,
				backup,
			});
			return controller.state();
		},
		"wallet.rename": (p) => {
			controller.renameWallet(str(p.walletId, "wallet", 64), str(p.name, "name", 200));
			return controller.state();
		},
		"wallet.delete": async (p) => {
			await controller.deleteWallet(str(p.walletId, "wallet", 64), str(p.password, "password", 1024), str(p.confirmName, "name", 200));
			return controller.state();
		},
		"wallet.changePassword": (p) => controller.changePassword(str(p.current, "password", 1024), str(p.next, "password", 1024)),

		"settings.update": (p) => {
			controller.registry.updateSettings({
				...(p.theme !== undefined ? { theme: p.theme } : {}),
				...(p.autoLockMinutes !== undefined ? { autoLockMinutes: Number(p.autoLockMinutes) } : {}),
			});
			return controller.registry.settings;
		},
		"settings.server": async (p) => {
			await controller.updateServer(network(p.network), str(p.url, "server", 300));
			return controller.state();
		},
		"settings.wallet": (p) => {
			controller.updateWalletSettings({
				...(p.fiatCurrency !== undefined ? { fiatCurrency: str(p.fiatCurrency, "currency", 3) } : {}),
				...(p.timezone !== undefined ? { timezone: str(p.timezone, "timezone", 64) } : {}),
			});
			return controller.state();
		},
		"settings.currencies": () => SUPPORTED_CURRENCIES,

		"overview.get": async (): Promise<OverviewView> => {
			const s = session();
			const today = todayIn(s.settings.timezone);
			const horizon = addDays(today, 7);
			const [balance, fiat, items] = await Promise.all([
				s.engine.hasAccount
					? s.engine.balance().then((b) => b.view)
					: Promise.resolve({ available: false, total: "0", spendable: "0", pending: "0", locked: "0", unshielded: "0" }),
				s.rates.current(s.settings.fiatCurrency, s.store.db).catch(() => null),
				activity(),
			]);
			const payments = items.flatMap((i) => (i.kind === "payment" ? [i.payment] : []));
			const open = payments.filter((p) => p.status === "scheduled" && p.dueDate);
			const overdue = open.filter((p) => p.dueDate! < today);
			const upcoming = open.filter((p) => p.dueDate! >= today);
			const attention = payments.filter((p) => p.status === "unknown" || p.status === "failed" || p.status === "refunded" || (p.status === "scheduled" && p.dueDate! <= today));
			return {
				balance,
				fiat,
				sync: s.engine.syncState,
				upcomingTotal: sum(upcoming),
				overdueTotal: sum(overdue),
				attention: attention.sort((a, b) => (a.dueDate ?? a.createdAt).localeCompare(b.dueDate ?? b.createdAt)).slice(0, 8),
				upcoming: upcoming.filter((p) => p.dueDate! <= horizon).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!)).slice(0, 6),
				recent: items.filter((i) => !(i.kind === "payment" && ["scheduled", "draft"].includes(i.payment.status))).slice(0, 8),
			};
		},
		"activity.list": () => activity(),
		"payment.get": (p) => session().store.read((db) => getPayment(db, str(p.id, "payment", 64), session().settings.fiatCurrency)),
		"payment.annotate": (p) => {
			const s = session();
			s.store.write((db) => updateAnnotations(db, str(p.id, "payment", 64), p.note, Array.isArray(p.tags) ? p.tags : []));
			return s.store.read((db) => getPayment(db, p.id, s.settings.fiatCurrency));
		},
		"payment.skip": (p) => {
			const s = session();
			s.store.write((db) => skipOccurrence(db, str(p.id, "payment", 64)));
			return s.store.read((db) => getPayment(db, p.id, s.settings.fiatCurrency));
		},
		"payment.recheck": async (p) => {
			const s = session();
			const payment = s.store.read((db) => getPayment(db, str(p.id, "payment", 64)));
			for (const attempt of payment.attempts) {
				if (["preparing", "submitted", "unknown"].includes(attempt.status)) await s.payments.reconcileAttempt(attempt.id);
			}
			return s.store.read((db) => getPayment(db, p.id, s.settings.fiatCurrency));
		},
		"tx.annotate": (p) => {
			const txid = str(p.txid, "transaction", 64);
			if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error("Invalid transaction id");
			session().store.write((db) => {
				setNote(db, `tx:${txid}`, p.note);
				setTags(db, `tx:${txid}`, Array.isArray(p.tags) ? p.tags : []);
			});
		},
		"tags.list": () => session().store.read((db) => allTags(db)),

		"send.checkAddress": async (p) => {
			const s = session();
			return { ...(await s.engine.validateAddress(str(p.address, "address", 600).trim())), network: s.engine.networkName };
		},
		"send.prepare": (p) => {
			const amount = p.amountZat === "max" ? "max" : str(p.amountZat, "amount", 20);
			return session().payments.prepare({
				recipient: validateRecipient(p.recipient),
				amountZat: amount,
				memo: p.memo === null ? null : str(p.memo, "memo", 2048),
				note: p.note === null ? null : str(p.note, "note", 4000),
				tags: Array.isArray(p.tags) ? p.tags.map((t) => str(t, "tag", 80)) : [],
				...(p.paymentId ? { paymentId: str(p.paymentId, "payment", 64) } : {}),
			});
		},
		"send.authorize": (p) => session().payments.authorize(str(p.reviewId, "review", 64), str(p.password, "password", 1024)),
		"send.discard": (p) => session().payments.discard(str(p.reviewId, "review", 64)),
		"receive.address": async (p) => {
			const s = session();
			return { address: await s.engine.receiveAddress(Boolean(p.fresh)), network: s.engine.networkName };
		},

		"contacts.list": () => session().store.read((db) => listContacts(db)),
		"contacts.save": async (p) => {
			const s = session();
			const input = await validateContactInput(p.input as ContactInput, validateDestination);
			const id = s.store.write((db) => {
				if (p.id) {
					updateContact(db, str(p.id, "contact", 64), input);
					return p.id;
				}
				return createContact(db, input);
			});
			return s.store.read((db) => getContact(db, id));
		},
		"contacts.delete": (p) => {
			session().store.write((db) => deleteContact(db, str(p.id, "contact", 64)));
		},
		"contacts.export": async () => {
			const s = session();
			const folder = await host.chooseFolder();
			if (!folder) return null;
			const path = uniqueFile(folder, `${slug(s.entry.name)}-contacts-${todayIn(s.settings.timezone)}`, "json");
			const data = s.store.read((db) => exportContacts(db));
			writeFileAtomic(path, new TextEncoder().encode(`${JSON.stringify(data, null, 2)}\n`));
			return { path };
		},
		"contacts.importPreview": async () => {
			const path = await host.chooseFile("json");
			if (!path) return null;
			const text = readFileSync(path, "utf8");
			const data = parseContactExport(text);
			const candidates = session().store.read((db) => previewImport(db, data));
			return {
				path,
				candidates: candidates.map(
					(c): ImportCandidateView => ({ index: c.index, name: c.name, destinationCount: c.destinations.length, status: c.status, reasons: c.reasons }),
				),
			};
		},
		"contacts.importApply": async (p) => {
			const s = session();
			const data = parseContactExport(readFileSync(str(p.path, "file", 4096), "utf8"));
			const candidates = s.store.read((db) => previewImport(db, data));
			const toAdd: { input: ContactInput; mergeInto: string | null }[] = [];
			let skipped = 0;
			for (const candidate of candidates) {
				const decision = candidate.status === "duplicate" ? "skip" : p.decisions?.[candidate.index] ?? (candidate.status === "new" ? "add" : "skip");
				if (decision === "skip") {
					skipped++;
					continue;
				}
				const input = await validateContactInput(
					{ name: candidate.name, photo: null, tags: [], destinations: candidate.destinations },
					validateDestination,
				);
				toAdd.push({ input, mergeInto: decision === "merge" ? candidate.matchContactId : null });
			}
			let added = 0;
			let merged = 0;
			s.store.write((db) => {
				for (const { input, mergeInto } of toAdd) {
					if (mergeInto) {
						const existing = getContact(db, mergeInto);
						const keys = new Set(existing.destinations.map((d) => `${d.route}|${d.chain}|${d.asset}|${d.address}`));
						const extra = input.destinations.filter((d) => !keys.has(`${d.route}|${d.chain}|${d.asset}|${d.address}`)).map((d) => ({ ...d, isDefault: false }));
						updateContact(db, mergeInto, {
							name: existing.name,
							photo: existing.photo,
							tags: existing.tags,
							destinations: [...existing.destinations.map(({ id: _id, ...d }) => d), ...extra],
						});
						merged++;
					} else {
						createContact(db, input);
						added++;
					}
				}
			});
			return { added, merged, skipped };
		},

		"schedules.list": () => session().store.read((db) => listSchedules(db)),
		"schedules.create": async (p) => {
			const s = session();
			const recipient = validateRecipient(p.recipient);
			await s.payments.validateRecipient(recipient, p.memo);
			const id = s.store.write((db) =>
				createSchedule(db, {
					name: p.name,
					recipient,
					amountZat: str(p.amountZat, "amount", 20),
					memo: p.memo,
					note: p.note,
					tags: Array.isArray(p.tags) ? p.tags : [],
					rule: p.rule,
					timezone: s.settings.timezone,
					startDate: date(p.startDate, "start date"),
					endDate: p.endDate ? date(p.endDate, "end date") : null,
				}),
			);
			return s.store.read((db) => listSchedules(db).find((x) => x.id === id) as ScheduleView);
		},
		"schedules.cancel": (p) => session().store.write((db) => cancelSchedule(db, str(p.id, "schedule", 64))),
		"schedules.outstanding": (p) => ({ outstanding: session().store.read((db) => outstandingForSchedule(db, str(p.id, "schedule", 64))) }),

		"reports.get": async (p) => {
			const s = session();
			const from = date(p.from, "start date");
			const to = date(p.to, "end date");
			const currency = s.settings.fiatCurrency;
			const [items, balance, current] = await Promise.all([
				activity(),
				s.engine.hasAccount ? s.engine.balance() : Promise.resolve(null),
				s.rates.current(currency, s.store.db).catch(() => null),
			]);
			const cache = new Map<string, string | null>();
			const days = new Set<string>();
			for (const item of items) {
				const at = item.kind === "payment" ? item.payment.settledAt : item.kind === "incoming" ? item.incoming.blockTime : item.external.blockTime;
				if (at) days.add(at.slice(0, 10));
			}
			for (const day of days) {
				const quote = await s.rates.daily(s.store.db, currency, day, (fn) => s.store.write(fn)).catch(() => null);
				cache.set(day, quote?.rate ?? null);
			}
			return buildReport({
				items,
				from,
				to,
				today: todayIn(s.settings.timezone),
				timezone: s.settings.timezone,
				currency,
				spendableZat: BigInt(balance?.view.spendable ?? "0"),
				currentRate: current?.rate ?? null,
				// Prefer recorded evidence in this currency; otherwise the daily rate for that day.
				rate: (valuation, at) => (valuation && valuation.currency === currency ? valuation.rate : cache.get(at.slice(0, 10)) ?? null),
			});
		},
		"reports.exportCsv": async (p) => {
			const s = session();
			const from = date(p.from, "start date");
			const to = date(p.to, "end date");
			const folder = await host.chooseFolder();
			if (!folder) return null;
			const items = (await activity()).filter((item) => {
				const at = item.kind === "payment" ? item.payment.settledAt ?? item.payment.updatedAt : item.at;
				const day = localDate(at, s.settings.timezone);
				return day >= from && day <= to;
			});
			const path = uniqueFile(folder, `${slug(s.entry.name)}-bookkeeping-${from}-to-${to}`, "csv");
			writeFileAtomic(path, new TextEncoder().encode(buildCsv(items, { includeNotes: Boolean(p.includeNotes) })));
			return { path };
		},
		"backup.export": async (p) => {
			const s = session();
			await controller.verifyPassword(str(p.password, "password", 1024));
			if (p.backupPassword === p.password) throw new Error("Choose a backup password that differs from the wallet password.");
			const folder = await host.chooseFolder();
			if (!folder) return null;
			const fingerprint = s.store.read((db) => (db.query("SELECT value FROM meta WHERE key = 'fingerprint'").get() as { value: string } | null)?.value);
			if (!fingerprint) throw new Error("This wallet has no fingerprint; unlock it again and retry.");
			const bytes = await createBackup({
				snapshot: s.store.snapshot(),
				fingerprint,
				network: s.entry.network,
				walletName: s.entry.name,
				password: str(p.backupPassword, "backup password", 1024),
			});
			const path = uniqueFile(folder, `${slug(s.entry.name)}-backup-${todayIn(s.settings.timezone)}`, "zarca-backup");
			writeFileAtomic(path, bytes);
			return { path };
		},
		"files.chooseBackup": async () => {
			const path = await host.chooseFile("zarca-backup");
			return path ? { path } : null;
		},

		"near.assets": () => controller.near.assets(),
		"system.openExternal": (p) => {
			const url = new URL(str(p.url, "url", 2000));
			if (url.protocol !== "https:") throw new Error("Only https links can be opened");
			host.openExternal(url.toString());
		},
		"system.copy": (p) => host.copy(str(p.text, "text", 4000)),
	};
	return handlers;
}

export async function dispatch(handlers: Handlers, method: string, params: unknown) {
	if (!Object.hasOwn(handlers, method)) throw new Error(`Unknown method ${method}`);
	const handler = handlers[method as Method] as (p: unknown) => unknown;
	return handler(params ?? {});
}

export type { Api, Contact };
