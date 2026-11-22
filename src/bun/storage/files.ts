import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
	constants,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";

/** Application data root. Owner-only permissions; never world readable. */
export function dataRoot(): string {
	const override = process.env.ZARCA_DATA_DIR;
	if (override) return override;
	const xdg = process.env.XDG_DATA_HOME;
	return join(xdg && xdg.startsWith("/") ? xdg : join(homedir(), ".local", "share"), "zarca");
}

export function ensurePrivateDir(path: string) {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const stat = statSync(path);
	if (!stat.isDirectory()) throw new Error(`Not a directory: ${path}`);
	if (process.getuid && stat.uid !== process.getuid()) {
		throw new Error(`Data directory is owned by another user: ${path}`);
	}
	if ((stat.mode & 0o077) !== 0) {
		// Tighten directories we created earlier or that the user created by hand.
		require("node:fs").chmodSync(path, 0o700);
	}
}

function fsyncDirectory(path: string) {
	const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/**
 * Crash-safe replacement: write a new file, fsync it, rename over the target,
 * then fsync the directory. Readers see either the old or the new content.
 */
export function writeFileAtomic(path: string, data: Uint8Array) {
	const directory = dirname(path);
	const temporary = join(directory, `.${randomBytes(8).toString("hex")}.tmp`);
	const fd = openSync(
		temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		let written = 0;
		while (written < data.length) {
			written += writeSync(fd, data, written, data.length - written);
		}
		fsyncSync(fd);
	} catch (error) {
		closeSync(fd);
		rmSync(temporary, { force: true });
		throw error;
	}
	closeSync(fd);
	try {
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
	fsyncDirectory(directory);
}

export function readFileIfExists(path: string): Uint8Array | null {
	try {
		return new Uint8Array(readFileSync(path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export function writeJsonAtomic(path: string, value: unknown) {
	writeFileAtomic(path, new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`));
}

export function readJson<T>(path: string): T | null {
	const bytes = readFileIfExists(path);
	return bytes === null ? null : (JSON.parse(new TextDecoder().decode(bytes)) as T);
}
