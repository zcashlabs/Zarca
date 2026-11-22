// Cryptographic primitives for Zarca's local vaults. All secrets stay in the Bun
// main process; nothing here is reachable from the webview.
import {
	createCipheriv,
	createDecipheriv,
	hkdfSync,
	randomBytes,
	scrypt as scryptCallback,
	timingSafeEqual,
} from "node:crypto";

export const KEY_BYTES = 32;
const NONCE = 12;
const TAG = 16;

export interface ScryptParams {
	readonly name: "scrypt";
	readonly N: number;
	readonly r: number;
	readonly p: number;
	readonly salt: string; // base64
}

/** ~128 MiB, ~0.3-0.6 s on a modern desktop: password unlocks are deliberately slow. */
export const DEFAULT_SCRYPT = { N: 2 ** 17, r: 8, p: 1 } as const;
/** Fast parameters for tests only. */
export const TEST_SCRYPT = { N: 2 ** 10, r: 8, p: 1 } as const;

export function newScryptParams(
	cost: { N: number; r: number; p: number } = DEFAULT_SCRYPT,
): ScryptParams {
	return { name: "scrypt", ...cost, salt: randomBytes(32).toString("base64") };
}

export function deriveKey(
	password: string,
	params: ScryptParams,
): Promise<Uint8Array> {
	if (params.name !== "scrypt") throw new Error("Unsupported key derivation");
	if (
		!Number.isSafeInteger(params.N) ||
		params.N < 2 ** 10 ||
		params.N > 2 ** 22 ||
		(params.N & (params.N - 1)) !== 0 ||
		params.r < 1 ||
		params.r > 32 ||
		params.p < 1 ||
		params.p > 16
	) {
		throw new Error("Invalid key derivation parameters");
	}
	const salt = Buffer.from(params.salt, "base64");
	if (salt.length < 16) throw new Error("Invalid key derivation salt");
	const passwordBytes = Buffer.from(password.normalize("NFKC"), "utf8");
	return new Promise((resolve, reject) => {
		scryptCallback(
			passwordBytes,
			salt,
			KEY_BYTES,
			{ N: params.N, r: params.r, p: params.p, maxmem: 512 * 1024 * 1024 },
			(error, key) => {
				passwordBytes.fill(0);
				if (error) reject(error);
				else {
					const out = new Uint8Array(key);
					key.fill(0);
					resolve(out);
				}
			},
		);
	});
}

/** Domain-separated subkey. */
export function subkey(master: Uint8Array, purpose: string): Uint8Array {
	return new Uint8Array(
		hkdfSync(
			"sha256",
			master,
			new Uint8Array(0),
			new TextEncoder().encode(`zarca/v1/${purpose}`),
			KEY_BYTES,
		),
	);
}

export function randomKey(): Uint8Array {
	return new Uint8Array(randomBytes(KEY_BYTES));
}

export interface Sealed {
	readonly nonce: string; // base64
	readonly data: string; // base64 ciphertext || tag
}

export function sealBytes(
	key: Uint8Array,
	plain: Uint8Array,
	aad: string,
): Uint8Array {
	const nonce = randomBytes(NONCE);
	const cipher = createCipheriv("aes-256-gcm", key, nonce, {
		authTagLength: TAG,
	});
	cipher.setAAD(Buffer.from(aad, "utf8"));
	const body = Buffer.concat([cipher.update(plain), cipher.final()]);
	const out = new Uint8Array(NONCE + body.length + TAG);
	out.set(nonce, 0);
	out.set(body, NONCE);
	out.set(cipher.getAuthTag(), NONCE + body.length);
	body.fill(0);
	return out;
}

export class DecryptionError extends Error {
	constructor() {
		super("Decryption failed");
		this.name = "DecryptionError";
	}
}

export function openBytes(
	key: Uint8Array,
	sealed: Uint8Array,
	aad: string,
): Uint8Array {
	if (sealed.length < NONCE + TAG) throw new DecryptionError();
	try {
		const decipher = createDecipheriv(
			"aes-256-gcm",
			key,
			sealed.subarray(0, NONCE),
			{ authTagLength: TAG },
		);
		decipher.setAAD(Buffer.from(aad, "utf8"));
		decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
		const plain = Buffer.concat([
			decipher.update(sealed.subarray(NONCE, sealed.length - TAG)),
			decipher.final(),
		]);
		const out = new Uint8Array(plain);
		plain.fill(0);
		return out;
	} catch {
		throw new DecryptionError();
	}
}

export function seal(key: Uint8Array, plain: Uint8Array, aad: string): Sealed {
	const bytes = sealBytes(key, plain, aad);
	return {
		nonce: Buffer.from(bytes.subarray(0, NONCE)).toString("base64"),
		data: Buffer.from(bytes.subarray(NONCE)).toString("base64"),
	};
}

export function open(key: Uint8Array, sealed: Sealed, aad: string): Uint8Array {
	const nonce = Buffer.from(sealed.nonce, "base64");
	const data = Buffer.from(sealed.data, "base64");
	if (nonce.length !== NONCE) throw new DecryptionError();
	const bytes = new Uint8Array(nonce.length + data.length);
	bytes.set(nonce, 0);
	bytes.set(data, nonce.length);
	return openBytes(key, bytes, aad);
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && timingSafeEqual(a, b);
}

export function wipe(...buffers: (Uint8Array | undefined | null)[]) {
	for (const buffer of buffers) buffer?.fill(0);
}
