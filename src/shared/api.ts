// The complete request surface the webview can call on the Bun process.
// Every handler re-validates its input: the webview is treated as untrusted.
import type {
	ActivityItem,
	AppSettings,
	AssetView,
	Contact,
	ContactInput,
	LockReason,
	NetworkName,
	OverviewView,
	PaymentView,
	RecipientSnapshot,
	RecurrenceRule,
	ReportView,
	ScheduleView,
	SendDraft,
	SendReview,
	SessionState,
	SyncState,
	ThemePreference,
	WalletSettings,
} from "./types";

export interface ImportCandidateView {
	readonly index: number;
	readonly name: string;
	readonly destinationCount: number;
	readonly status: "new" | "duplicate" | "conflict";
	readonly reasons: readonly string[];
}

export interface Api {
	"session.get": { params: void; result: SessionState };
	"session.unlock": { params: { walletId: string; password: string }; result: SessionState };
	"session.lock": { params: { reason?: LockReason }; result: SessionState };
	"session.sync": { params: void; result: SyncState | null };

	"wallet.generatePhrase": { params: void; result: { token: string; words: string[] } };
	"wallet.discardPhrase": { params: { token: string }; result: void };
	"wallet.create": {
		params: { token: string; name: string; network: NetworkName; password: string; confirmation: Record<number, string> };
		result: SessionState;
	};
	"wallet.import": {
		params: {
			name: string;
			network: NetworkName;
			password: string;
			phrase: string;
			createdAfter: string | null;
			backupPath: string | null;
			backupPassword: string | null;
		};
		result: SessionState;
	};
	"wallet.rename": { params: { walletId: string; name: string }; result: SessionState };
	"wallet.delete": { params: { walletId: string; password: string; confirmName: string }; result: SessionState };
	"wallet.changePassword": { params: { current: string; next: string }; result: void };

	"settings.update": {
		params: { theme?: ThemePreference; autoLockMinutes?: number };
		result: AppSettings;
	};
	"settings.server": { params: { network: NetworkName; url: string }; result: SessionState };
	"settings.wallet": { params: Partial<WalletSettings>; result: SessionState };
	"settings.currencies": { params: void; result: readonly string[] };

	"overview.get": { params: void; result: OverviewView };
	"activity.list": { params: void; result: ActivityItem[] };
	"payment.get": { params: { id: string }; result: PaymentView };
	"payment.annotate": { params: { id: string; note: string | null; tags: string[] }; result: PaymentView };
	"payment.skip": { params: { id: string }; result: PaymentView };
	"payment.recheck": { params: { id: string }; result: PaymentView };
	"tx.annotate": { params: { txid: string; note: string | null; tags: string[] }; result: void };
	"tags.list": { params: void; result: { tag: string; count: number }[] };

	"send.checkAddress": {
		params: { address: string };
		result: { valid: boolean; shielded: boolean; transparent: boolean; network: NetworkName };
	};
	"send.prepare": { params: SendDraft; result: SendReview };
	"send.authorize": { params: { reviewId: string; password: string }; result: PaymentView };
	"send.discard": { params: { reviewId: string }; result: void };
	"receive.address": { params: { fresh: boolean }; result: { address: string; network: NetworkName } };

	"contacts.list": { params: void; result: Contact[] };
	"contacts.save": { params: { id: string | null; input: ContactInput }; result: Contact };
	"contacts.delete": { params: { id: string }; result: void };
	"contacts.export": { params: void; result: { path: string } | null };
	"contacts.importPreview": { params: void; result: { path: string; candidates: ImportCandidateView[] } | null };
	"contacts.importApply": {
		params: { path: string; decisions: Record<number, "skip" | "add" | "merge"> };
		result: { added: number; merged: number; skipped: number };
	};

	"schedules.list": { params: void; result: ScheduleView[] };
	"schedules.create": {
		params: {
			name: string | null;
			recipient: RecipientSnapshot;
			amountZat: string;
			memo: string | null;
			note: string | null;
			tags: string[];
			rule: RecurrenceRule;
			startDate: string;
			endDate: string | null;
		};
		result: ScheduleView;
	};
	"schedules.cancel": { params: { id: string }; result: { cancelledOccurrences: number } };
	"schedules.outstanding": { params: { id: string }; result: { outstanding: number } };

	"reports.get": { params: { from: string; to: string }; result: ReportView };
	"reports.exportCsv": { params: { from: string; to: string; includeNotes: boolean }; result: { path: string } | null };
	"backup.export": { params: { password: string; backupPassword: string }; result: { path: string } | null };
	"files.chooseBackup": { params: void; result: { path: string } | null };

	"near.assets": { params: void; result: AssetView[] };
	"system.openExternal": { params: { url: string }; result: void };
	"system.copy": { params: { text: string }; result: void };
}

export type Method = keyof Api;
export type Params<M extends Method> = Api[M]["params"];
export type Result<M extends Method> = Api[M]["result"];

export type InvokeResponse = { ok: true; value: unknown } | { ok: false; error: string; code?: string };

/** Electrobun RPC schema: one generic request plus push messages. */
export interface ZarcaRPCSchema {
	bun: {
		requests: {
			invoke: { params: { method: string; params: unknown }; response: InvokeResponse };
		};
		messages: {
			activity: { at: number };
		};
	};
	webview: {
		requests: Record<never, never>;
		messages: {
			session: SessionState;
			sync: SyncState;
			changed: { revision: number };
		};
	};
}
