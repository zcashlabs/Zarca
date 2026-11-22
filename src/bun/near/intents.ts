// NEAR Intents 1Click API client (keyless). Zarca funds a swap by sending ZEC
// from the treasury to a quote's deposit address; the provider swaps and
// delivers the destination asset. Funding is not completion: a payment stays
// pending until the provider reports SUCCESS, and a refund is never shown as paid.
import type { AssetView, NearQuoteView } from "../../shared/types";

const BASE = "https://1click.chaindefuser.com/v0";
export const ZEC_ASSET = "nep141:zec.omft.near";
const QUOTE_TTL_MS = 20 * 60_000;
const SLIPPAGE_BPS = 100; // 1%

export type ProviderStatus =
	| "PENDING_DEPOSIT"
	| "KNOWN_DEPOSIT_TX"
	| "PROCESSING"
	| "SUCCESS"
	| "INCOMPLETE_DEPOSIT"
	| "REFUNDED"
	| "FAILED";

export interface ProviderStatusReport {
	readonly status: ProviderStatus | string;
	readonly destinationTxids: string[];
	readonly refundTxids: string[];
	readonly originTxids: string[];
	readonly refundedAmount: string | null;
	readonly refundReason: string | null;
	readonly amountOutFormatted: string | null;
}

export class NearIntentsError extends Error {
	constructor(message: string, readonly retryable = true) {
		super(message);
		this.name = "NearIntentsError";
	}
}

type Fetch = typeof fetch;

async function request<T>(fetcher: Fetch, path: string, init?: RequestInit): Promise<T> {
	let response: Response;
	try {
		response = await fetcher(`${BASE}${path}`, {
			...init,
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			signal: AbortSignal.timeout(30_000),
		});
	} catch {
		throw new NearIntentsError("NEAR Intents could not be reached. Your funds have not moved.");
	}
	const text = await response.text();
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new NearIntentsError(`NEAR Intents returned an unexpected response (${response.status}).`);
	}
	if (!response.ok) {
		const message = (body as { message?: unknown })?.message;
		throw new NearIntentsError(
			typeof message === "string" ? `NEAR Intents: ${message}` : `NEAR Intents request failed (${response.status}).`,
			response.status >= 500 || response.status === 429,
		);
	}
	return body as T;
}

interface TokenRecord {
	assetId: string;
	decimals: number;
	blockchain: string;
	symbol: string;
	price?: number | string | null;
}

export class NearIntents {
	private tokens: { at: number; list: AssetView[] } | null = null;

	constructor(private readonly fetcher: Fetch = fetch) {}

	async assets(): Promise<AssetView[]> {
		if (this.tokens && Date.now() - this.tokens.at < 10 * 60_000) return this.tokens.list;
		const raw = await request<TokenRecord[]>(this.fetcher, "/tokens");
		if (!Array.isArray(raw)) throw new NearIntentsError("Unexpected token list from NEAR Intents.");
		const list = raw
			.filter((t) => typeof t.assetId === "string" && typeof t.symbol === "string" && Number.isInteger(t.decimals))
			.filter((t) => t.assetId !== ZEC_ASSET)
			.map((t) => ({
				assetId: t.assetId,
				symbol: t.symbol,
				chain: t.blockchain,
				decimals: t.decimals,
				priceUsd: t.price === null || t.price === undefined ? null : String(t.price),
			}))
			.sort((a, b) => a.chain.localeCompare(b.chain) || a.symbol.localeCompare(b.symbol));
		this.tokens = { at: Date.now(), list };
		return list;
	}

	async asset(assetId: string): Promise<AssetView> {
		const found = (await this.assets()).find((a) => a.assetId === assetId);
		if (!found) throw new NearIntentsError("This destination asset is no longer offered by NEAR Intents.", false);
		return found;
	}

	/**
	 * A binding quote with a deposit address. Exact input: the treasury sends
	 * `amountZat`; the recipient receives at least `minAmountOut`.
	 */
	async quote(args: {
		amountZat: bigint;
		destinationAsset: string;
		recipient: string;
		refundTo: string;
		dry?: boolean;
	}): Promise<NearQuoteView> {
		const asset = await this.asset(args.destinationAsset);
		const deadline = new Date(Date.now() + QUOTE_TTL_MS).toISOString();
		const body = {
			dry: Boolean(args.dry),
			swapType: "EXACT_INPUT",
			slippageTolerance: SLIPPAGE_BPS,
			originAsset: ZEC_ASSET,
			depositType: "ORIGIN_CHAIN",
			destinationAsset: args.destinationAsset,
			amount: args.amountZat.toString(),
			refundTo: args.refundTo,
			refundType: "ORIGIN_CHAIN",
			recipient: args.recipient,
			recipientType: "DESTINATION_CHAIN",
			deadline,
		};
		const response = await request<{
			quote?: {
				depositAddress?: string;
				depositMemo?: string;
				amountIn?: string;
				amountOut?: string;
				amountOutFormatted?: string;
				minAmountOut?: string;
				timeEstimate?: number;
				deadline?: string;
				amountInUsd?: string;
				amountOutUsd?: string;
			};
			timestamp?: string;
		}>(this.fetcher, "/quote", { method: "POST", body: JSON.stringify(body) });
		const q = response.quote;
		if (!q || q.amountIn !== body.amount || typeof q.amountOut !== "string" || typeof q.minAmountOut !== "string") {
			throw new NearIntentsError("NEAR Intents returned an incomplete quote.");
		}
		if (!args.dry && (typeof q.depositAddress !== "string" || !q.depositAddress)) {
			throw new NearIntentsError("NEAR Intents did not return a deposit address.");
		}
		if (q.depositMemo) {
			// Zcash deposits are identified by address; a memo requirement would be unexpected and unsafe to ignore.
			throw new NearIntentsError("This route requires a deposit memo, which Zarca does not support.", false);
		}
		const quoted = response.timestamp ?? new Date().toISOString();
		const provider = q.deadline ? Date.parse(q.deadline) : Infinity;
		const expires = Math.min(Date.parse(deadline), Number.isFinite(provider) ? provider : Infinity);
		const fee = q.amountInUsd && q.amountOutUsd ? Math.max(0, Number(q.amountInUsd) - Number(q.amountOutUsd)) : null;
		return {
			depositAddress: q.depositAddress ?? "",
			amountIn: q.amountIn,
			amountOut: q.amountOut,
			amountOutFormatted: q.amountOutFormatted ?? formatUnits(q.amountOut, asset.decimals),
			minAmountOut: q.minAmountOut,
			assetSymbol: asset.symbol,
			deadline: new Date(expires).toISOString(),
			quotedAt: quoted,
			timeEstimateSeconds: typeof q.timeEstimate === "number" ? q.timeEstimate : null,
			feeUsd: fee === null || !Number.isFinite(fee) ? null : fee.toFixed(2),
			refundTo: args.refundTo,
		};
	}

	async status(depositAddress: string): Promise<ProviderStatusReport> {
		const response = await request<{
			status?: string;
			swapDetails?: {
				destinationChainTxHashes?: { hash: string }[];
				originChainTxHashes?: { hash: string }[];
				refundedAmount?: string | null;
				refundReason?: string | null;
				amountOutFormatted?: string | null;
			};
		}>(this.fetcher, `/status?depositAddress=${encodeURIComponent(depositAddress)}`);
		if (typeof response.status !== "string") throw new NearIntentsError("Unexpected status from NEAR Intents.");
		const details = response.swapDetails ?? {};
		const hashes = (list: { hash: string }[] | undefined) =>
			(list ?? []).map((h) => h?.hash).filter((h): h is string => typeof h === "string");
		const refunded = details.refundedAmount && details.refundedAmount !== "0" ? details.refundedAmount : null;
		return {
			status: response.status,
			destinationTxids: response.status === "REFUNDED" ? [] : hashes(details.destinationChainTxHashes),
			refundTxids: response.status === "REFUNDED" ? hashes(details.destinationChainTxHashes) : [],
			originTxids: hashes(details.originChainTxHashes),
			refundedAmount: refunded,
			refundReason: details.refundReason ?? null,
			amountOutFormatted: details.amountOutFormatted ?? null,
		};
	}

	/** Optional: tells the provider about the funding transaction to speed up detection. */
	async notifyDeposit(depositAddress: string, txid: string) {
		await request(this.fetcher, "/deposit/submit", {
			method: "POST",
			body: JSON.stringify({ txHash: txid, depositAddress }),
		}).catch(() => {});
	}
}

export function formatUnits(value: string, decimals: number): string {
	if (!/^\d+$/.test(value)) return value;
	const padded = value.padStart(decimals + 1, "0");
	const whole = padded.slice(0, padded.length - decimals);
	const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
	return fraction ? `${whole}.${fraction}` : whole;
}

/** Basic per-chain address shape checks; the provider performs the authoritative validation at quote time. */
export function validateForeignAddress(chain: string, address: string): string | null {
	const evm = /^0x[0-9a-fA-F]{40}$/;
	const checks: Record<string, RegExp> = {
		eth: evm, arb: evm, base: evm, op: evm, pol: evm, bsc: evm, avax: evm, gnosis: evm, bera: evm,
		scroll: evm, monad: evm, xlayer: evm, abs: evm,
		sol: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
		btc: /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
		near: /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$|^[0-9a-f]{64}$/,
		tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
		sui: /^0x[0-9a-fA-F]{64}$/,
		aptos: /^0x[0-9a-fA-F]{1,64}$/,
		ton: /^[A-Za-z0-9_-]{48}$|^-?\d:[0-9a-fA-F]{64}$/,
		stellar: /^G[A-Z2-7]{55}$/,
		doge: /^D[1-9A-HJ-NP-Za-km-z]{25,34}$/,
		xrp: /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/,
		ltc: /^(ltc1[02-9ac-hj-np-z]{11,71}|[LM3][1-9A-HJ-NP-Za-km-z]{26,33})$/,
	};
	const check = checks[chain];
	if (!address.trim()) return "Enter the recipient address";
	if (/\s/.test(address)) return "Addresses cannot contain spaces";
	if (check && !check.test(address)) return `This does not look like a ${chain.toUpperCase()} address`;
	return null;
}
