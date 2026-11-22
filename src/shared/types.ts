// Types shared by the Bun main process and the webview. Everything here must be
// JSON-serializable: zatoshi amounts travel as decimal strings.

export type Zat = string;
export type NetworkName = "mainnet" | "testnet";
export type ThemePreference = "system" | "light" | "dark";

export interface WalletEntry {
	readonly id: string;
	readonly name: string;
	readonly network: NetworkName;
	readonly createdAt: string;
}

export interface AppSettings {
	readonly theme: ThemePreference;
	readonly autoLockMinutes: number;
	readonly servers: Record<NetworkName, string>;
}

export interface WalletSettings {
	readonly fiatCurrency: string;
	readonly timezone: string;
}

export type SyncPhase = "connecting" | "syncing" | "synced" | "error" | "stopped";
export interface SyncState {
	readonly phase: SyncPhase;
	readonly tipHeight: number | null;
	readonly scannedHeight: number | null;
	readonly progress: number | null; // 0..1
	readonly error: string | null;
	readonly updatedAt: string;
}

export interface BalanceView {
	readonly available: boolean;
	readonly total: Zat;
	readonly spendable: Zat;
	readonly pending: Zat; // awaiting confirmations or change
	readonly locked: Zat; // reserved by in-flight operations
	readonly unshielded: Zat; // transparent funds that need shielding before spending
}

export interface FiatQuote {
	readonly currency: string;
	readonly rate: string; // fiat per 1 ZEC, decimal string
	readonly source: string;
	readonly observedAt: string;
	readonly stale: boolean;
}

export type Route = "zcash" | "near-intents";

/** A saved place to pay. Captured into each payment as an immutable snapshot. */
export interface Destination {
	readonly id: string;
	readonly label: string;
	readonly route: Route;
	readonly chain: string; // "zcash" or a NEAR Intents blockchain id ("eth", "sol", ...)
	readonly asset: string | null; // NEAR Intents asset id for cross-chain routes
	readonly assetSymbol: string | null;
	readonly address: string;
	readonly isDefault: boolean;
}

export interface Contact {
	readonly id: string;
	readonly name: string;
	readonly photo: string | null; // data: URL, small WebP/PNG
	readonly tags: readonly string[];
	readonly destinations: readonly Destination[];
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface ContactInput {
	readonly name: string;
	readonly photo: string | null;
	readonly tags: readonly string[];
	readonly destinations: readonly Omit<Destination, "id">[];
}

export interface RecipientSnapshot {
	readonly contactId: string | null;
	readonly contactName: string | null;
	readonly destinationLabel: string | null;
	readonly route: Route;
	readonly chain: string;
	readonly asset: string | null;
	readonly assetSymbol: string | null;
	readonly address: string;
}

export type PaymentStatus =
	| "scheduled" // generated from a schedule, awaiting review
	| "draft" // prepared but not yet authorized
	| "submitting" // authorized; intent persisted, execution in progress
	| "pending" // broadcast or funded; awaiting confirmation / delivery
	| "completed"
	| "failed" // definitively failed; may be retried after reconciliation
	| "unknown" // outcome uncertain; must reconcile before any retry
	| "refunded" // cross-chain swap refunded to the treasury
	| "skipped"
	| "cancelled";

export interface NearQuoteView {
	readonly depositAddress: string;
	readonly amountIn: Zat;
	readonly amountOut: string; // base units of the destination asset
	readonly amountOutFormatted: string;
	readonly minAmountOut: string;
	readonly assetSymbol: string;
	readonly deadline: string;
	readonly quotedAt: string;
	readonly timeEstimateSeconds: number | null;
	readonly feeUsd: string | null;
	readonly refundTo: string;
}

export interface AttemptView {
	readonly id: string;
	readonly status: "preparing" | "submitted" | "confirmed" | "failed" | "unknown" | "abandoned";
	readonly operationId: string | null;
	readonly txids: readonly string[];
	readonly feeZat: Zat | null;
	readonly error: string | null;
	readonly near: null | {
		readonly quote: NearQuoteView;
		readonly providerStatus: string | null;
		readonly destinationTxids: readonly string[];
		readonly refundTxids: readonly string[];
		readonly checkedAt: string | null;
	};
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface ValuationView {
	readonly currency: string;
	readonly rate: string;
	readonly source: string;
	readonly observedAt: string;
}

export interface PaymentView {
	readonly id: string;
	readonly status: PaymentStatus;
	readonly recipient: RecipientSnapshot;
	readonly amountZat: Zat;
	readonly memo: string | null; // on-chain recipient memo (Zcash route only)
	readonly note: string | null; // private local note
	readonly tags: readonly string[];
	readonly scheduleId: string | null;
	readonly occurrenceDate: string | null;
	readonly dueDate: string | null;
	readonly attempts: readonly AttemptView[];
	readonly feeZat: Zat | null;
	readonly valuation: ValuationView | null;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly settledAt: string | null;
}

export interface IncomingView {
	readonly txid: string;
	readonly amountZat: Zat;
	readonly minedHeight: number | null;
	readonly blockTime: string | null;
	readonly confirmations: number | null;
	readonly memos: readonly string[];
	readonly note: string | null;
	readonly tags: readonly string[];
	readonly valuation: ValuationView | null;
	/** "refund": funds returned by a cross-chain provider for one of our payments; never revenue. */
	readonly kind: "received" | "refund" | "shielding" | "change" | "other";
	readonly refundFor: string | null; // payment id when kind === "refund"
}

/** Outgoing chain transactions not created through Zarca (e.g. from another wallet with the same seed). */
export interface ExternalOutgoingView {
	readonly txid: string;
	readonly amountZat: Zat;
	readonly feeZat: Zat | null;
	readonly minedHeight: number | null;
	readonly blockTime: string | null;
	readonly note: string | null;
	readonly tags: readonly string[];
	readonly valuation: ValuationView | null;
}

export type ActivityItem =
	| { readonly kind: "payment"; readonly at: string; readonly payment: PaymentView }
	| { readonly kind: "incoming"; readonly at: string; readonly incoming: IncomingView }
	| { readonly kind: "external"; readonly at: string; readonly external: ExternalOutgoingView };

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // Sunday = 0

export type RecurrenceRule =
	| { readonly kind: "daily"; readonly interval: number }
	| { readonly kind: "weekly"; readonly interval: number; readonly weekdays: readonly Weekday[] }
	| { readonly kind: "monthly-day"; readonly interval: number; readonly day: number } // 1..31, clamped to month end
	| {
			readonly kind: "monthly-weekday";
			readonly interval: number;
			readonly weekday: Weekday;
			readonly ordinal: 1 | 2 | 3 | 4 | -1; // -1 = last
	  };

export interface ScheduleView {
	readonly id: string;
	readonly name: string;
	readonly recipient: RecipientSnapshot;
	readonly amountZat: Zat;
	readonly memo: string | null;
	readonly note: string | null;
	readonly tags: readonly string[];
	readonly rule: RecurrenceRule;
	readonly timezone: string;
	readonly startDate: string; // YYYY-MM-DD in the schedule timezone
	readonly endDate: string | null;
	readonly createdAt: string;
	readonly cancelledAt: string | null;
	readonly nextDue: string | null;
}

export interface OverviewView {
	readonly balance: BalanceView;
	readonly fiat: FiatQuote | null;
	readonly sync: SyncState;
	readonly upcomingTotal: Zat;
	readonly overdueTotal: Zat;
	readonly attention: readonly PaymentView[];
	readonly upcoming: readonly PaymentView[];
	readonly recent: readonly ActivityItem[];
}

export interface ReportView {
	readonly from: string;
	readonly to: string;
	readonly currency: string;
	readonly received: { readonly zat: Zat; readonly fiat: string | null; readonly missingRates: number };
	readonly spent: { readonly zat: Zat; readonly fiat: string | null; readonly missingRates: number };
	readonly fees: { readonly zat: Zat; readonly fiat: string | null; readonly missingRates: number };
	readonly byTag: readonly { readonly tag: string; readonly zat: Zat; readonly fiat: string | null; readonly count: number }[];
	readonly untaggedSpent: Zat;
	readonly upcoming: Zat;
	readonly overdue: Zat;
	readonly spendable: Zat;
	readonly spendableFiat: string | null;
}

export interface AssetView {
	readonly assetId: string;
	readonly symbol: string;
	readonly chain: string;
	readonly decimals: number;
	readonly priceUsd: string | null;
}

export interface SendDraft {
	readonly recipient: RecipientSnapshot;
	readonly amountZat: Zat | "max";
	readonly memo: string | null;
	readonly note: string | null;
	readonly tags: readonly string[];
	readonly paymentId?: string; // existing scheduled/failed payment being reviewed
}

/** What the user reviews and authorizes. */
export interface SendReview {
	readonly reviewId: string;
	readonly paymentId: string;
	readonly recipient: RecipientSnapshot;
	readonly amountZat: Zat;
	readonly feeZat: Zat;
	readonly totalZat: Zat;
	readonly memo: string | null;
	readonly fiat: FiatQuote | null;
	readonly near: NearQuoteView | null;
	readonly expiresAt: string | null;
	readonly spendableZat: Zat;
}

export type LockReason = "manual" | "idle" | "sleep" | "switch" | "quit" | "deleted";

export interface SessionState {
	readonly wallets: readonly WalletEntry[];
	readonly unlocked: WalletEntry | null;
	readonly settings: AppSettings;
	readonly walletSettings: WalletSettings | null;
	readonly lockReason: LockReason | null;
}
