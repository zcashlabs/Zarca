// SDK error mapping without a runtime dependency on zcash.js (unit tests load this).
import type { ZcashError } from "@zcashlabs/zcash.js";

/** Structural check equivalent to zcash.js isZcashError for errors crossing module boundaries. */
export function isSdkError(error: unknown): error is ZcashError {
	return (
		error instanceof Error &&
		typeof (error as { code?: unknown }).code === "string" &&
		typeof (error as { stage?: unknown }).stage === "string" &&
		typeof (error as { retryable?: unknown }).retryable === "boolean"
	);
}

export class EngineError extends Error {
	constructor(
		message: string,
		readonly code: string,
		readonly retryable = false,
	) {
		super(message);
		this.name = "EngineError";
	}
}

/** Maps SDK failures to user-facing text without leaking raw payloads. */
export function describeError(error: unknown): EngineError {
	if (error instanceof EngineError) return error;
	if (isSdkError(error)) {
		const text: Record<string, string> = {
			INSUFFICIENT_FUNDS: "Not enough spendable funds for this payment and its fee.",
			SYNC_REQUIRED: "The wallet needs to finish syncing before it can do this.",
			TRANSPORT_ERROR: "The Zcash server could not be reached.",
			NETWORK_MISMATCH: "The configured server is on a different network or consensus version.",
			PROTOCOL_MISMATCH: "The configured server speaks an unsupported protocol version.",
			STORAGE_BUSY: "This wallet is already open in another process.",
			STORAGE_KEY_MISMATCH: "The wallet database could not be decrypted.",
			INVALID_ARGUMENT: "Check the address, amount and memo.",
			UNSUPPORTED_POOL: "This recipient address type is not supported.",
			FEE_LIMIT_EXCEEDED: "The fee for this payment is unexpectedly high.",
			INPUT_LOCKED: "Funds are reserved by another payment in progress.",
			IDEMPOTENCY_CONFLICT: "This payment was already prepared with different terms.",
			SUBMISSION_UNKNOWN: "The network did not confirm whether the transaction was received.",
			SUBMISSION_REJECTED: "The network rejected the transaction.",
			TRANSACTION_EXPIRED: "The transaction expired before it was mined.",
			TIMEOUT: "The operation timed out.",
		};
		return new EngineError(text[error.code] ?? error.message, error.code, error.retryable);
	}
	return new EngineError(error instanceof Error ? error.message : "Unexpected wallet error", "UNKNOWN");
}

