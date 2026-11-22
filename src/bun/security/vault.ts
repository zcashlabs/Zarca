// Per-wallet vault. A random data key protects the wallet's synced engine
// database and treasury records. The recovery phrase is sealed separately and
// can only be opened with the password, so unlocking a wallet never makes the
// spending secret available: every payment authorization re-derives it.
import {
	DEFAULT_SCRYPT,
	DecryptionError,
	deriveKey,
	newScryptParams,
	open,
	randomKey,
	seal,
	subkey,
	wipe,
	type Sealed,
	type ScryptParams,
} from "./crypto";
import { readJson, writeJsonAtomic } from "../storage/files";

export const VAULT_FORMAT = "zarca-vault/1";

export interface VaultFile {
	readonly format: typeof VAULT_FORMAT;
	readonly walletId: string;
	readonly kdf: ScryptParams;
	readonly dataKey: Sealed;
	readonly seed: Sealed;
}

export class IncorrectPasswordError extends Error {
	constructor() {
		super("Incorrect password");
		this.name = "IncorrectPasswordError";
	}
}

const dataAad = (walletId: string) => `zarca vault data-key ${walletId}`;
const seedAad = (walletId: string) => `zarca vault seed ${walletId}`;

export const MIN_PASSWORD_LENGTH = 8;

export function validatePassword(password: string) {
	if (typeof password !== "string" || [...password].length < MIN_PASSWORD_LENGTH) {
		throw new Error(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
	}
	if (password.length > 1024) throw new Error("Password is too long.");
}

function sealVault(
	walletId: string,
	kek: Uint8Array,
	kdf: ScryptParams,
	dataKey: Uint8Array,
	seed: Uint8Array,
): VaultFile {
	const dataWrap = subkey(kek, "wrap/data-key");
	const seedWrap = subkey(kek, "wrap/seed");
	try {
		return {
			format: VAULT_FORMAT,
			walletId,
			kdf,
			dataKey: seal(dataWrap, dataKey, dataAad(walletId)),
			seed: seal(seedWrap, seed, seedAad(walletId)),
		};
	} finally {
		wipe(dataWrap, seedWrap);
	}
}

export async function createVault(
	path: string,
	walletId: string,
	password: string,
	mnemonic: Uint8Array,
	cost: { N: number; r: number; p: number } = DEFAULT_SCRYPT,
): Promise<Uint8Array> {
	validatePassword(password);
	const kdf = newScryptParams(cost);
	const kek = await deriveKey(password, kdf);
	const dataKey = randomKey();
	try {
		writeJsonAtomic(path, sealVault(walletId, kek, kdf, dataKey, mnemonic));
		return Uint8Array.from(dataKey);
	} finally {
		wipe(kek, dataKey);
	}
}

function load(path: string, walletId: string): VaultFile {
	const vault = readJson<VaultFile>(path);
	if (!vault || vault.format !== VAULT_FORMAT || vault.walletId !== walletId) {
		throw new Error("Wallet vault is missing or unreadable");
	}
	return vault;
}

async function unwrap(path: string, walletId: string, password: string) {
	const vault = load(path, walletId);
	const kek = await deriveKey(password, vault.kdf);
	return { vault, kek };
}

/** Returns the wallet data key. The caller owns and must wipe it on lock. */
export async function unlockVault(
	path: string,
	walletId: string,
	password: string,
): Promise<Uint8Array> {
	const { vault, kek } = await unwrap(path, walletId, password);
	const wrap = subkey(kek, "wrap/data-key");
	try {
		return open(wrap, vault.dataKey, dataAad(walletId));
	} catch (error) {
		if (error instanceof DecryptionError) throw new IncorrectPasswordError();
		throw error;
	} finally {
		wipe(kek, wrap);
	}
}

/** Opens the recovery phrase for one authorization; the caller wipes it immediately after use. */
export async function openSeed(
	path: string,
	walletId: string,
	password: string,
): Promise<Uint8Array> {
	const { vault, kek } = await unwrap(path, walletId, password);
	const wrap = subkey(kek, "wrap/seed");
	try {
		return open(wrap, vault.seed, seedAad(walletId));
	} catch (error) {
		if (error instanceof DecryptionError) throw new IncorrectPasswordError();
		throw error;
	} finally {
		wipe(kek, wrap);
	}
}

export async function changeVaultPassword(
	path: string,
	walletId: string,
	current: string,
	next: string,
	cost: { N: number; r: number; p: number } = DEFAULT_SCRYPT,
) {
	validatePassword(next);
	const dataKey = await unlockVault(path, walletId, current);
	const seed = await openSeed(path, walletId, current);
	const kdf = newScryptParams(cost);
	const kek = await deriveKey(next, kdf);
	try {
		writeJsonAtomic(path, sealVault(walletId, kek, kdf, dataKey, seed));
	} finally {
		wipe(dataKey, seed, kek);
	}
}

/** Checks a password without retaining any key. */
export async function verifyPassword(path: string, walletId: string, password: string) {
	wipe(await unlockVault(path, walletId, password));
}
