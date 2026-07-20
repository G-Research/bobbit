/** Startup-only persistence for the stateless cookie signing key. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { COOKIE_SIGNING_KEY_BYTES } from "./cookie.js";

export const COOKIE_SIGNING_KEY_FILE = "cookie-signing-key";

export type CookieSigningKeyFileSystem = Pick<
	typeof fs,
	| "chmodSync"
	| "closeSync"
	| "fstatSync"
	| "fsyncSync"
	| "linkSync"
	| "lstatSync"
	| "mkdirSync"
	| "openSync"
	| "readFileSync"
	| "unlinkSync"
	| "writeSync"
>;

export interface CookieSigningKeyLoaderOptions {
	fileSystem?: CookieSigningKeyFileSystem;
	randomBytes?: (size: number) => Buffer;
	/** Test seam for permission behavior. */
	platform?: NodeJS.Platform;
}

function isErrno(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error
		&& (error as NodeJS.ErrnoException).code === code;
}

function secureRandomBytes(randomBytes: (size: number) => Buffer, size: number): Buffer {
	const value = randomBytes(size);
	if (!Buffer.isBuffer(value) || value.length !== size) {
		throw new Error(`Cookie signing-key random source must return exactly ${size} bytes`);
	}
	return value;
}

function enforceMode(
	fileSystem: CookieSigningKeyFileSystem,
	target: string,
	mode: number,
	platform: NodeJS.Platform,
): void {
	// Windows does not implement Unix owner/group/other mode semantics.
	if (platform === "win32") return;
	fileSystem.chmodSync(target, mode);
	const actual = fileSystem.lstatSync(target).mode & 0o777;
	if (actual !== mode) {
		throw new Error(`Cookie signing-key permissions are not restrictive: expected ${mode.toString(8)}, got ${actual.toString(8)}`);
	}
}

function ensureSecretsDirectory(
	secretsDir: string,
	fileSystem: CookieSigningKeyFileSystem,
	platform: NodeJS.Platform,
): void {
	fileSystem.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
	const stat = fileSystem.lstatSync(secretsDir);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error("Cookie signing-key secrets path must be a real directory");
	}
	enforceMode(fileSystem, secretsDir, 0o700, platform);
}

function readAndValidateKey(
	keyPath: string,
	fileSystem: CookieSigningKeyFileSystem,
	platform: NodeJS.Platform,
): Buffer {
	const stat = fileSystem.lstatSync(keyPath);
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new Error("Cookie signing key must be a regular file");
	}

	// Read before chmod so unreadable existing material fails closed instead of
	// being silently made readable and accepted.
	const key = fileSystem.readFileSync(keyPath);
	if (!Buffer.isBuffer(key) || key.length !== COOKIE_SIGNING_KEY_BYTES) {
		throw new Error(`Cookie signing key must contain exactly ${COOKIE_SIGNING_KEY_BYTES} bytes`);
	}
	enforceMode(fileSystem, keyPath, 0o600, platform);
	return Buffer.from(key);
}

function readExistingKey(
	keyPath: string,
	fileSystem: CookieSigningKeyFileSystem,
	platform: NodeJS.Platform,
): Buffer | undefined {
	try {
		return readAndValidateKey(keyPath, fileSystem, platform);
	} catch (error) {
		if (isErrno(error, "ENOENT")) return undefined;
		throw error;
	}
}

function writeAll(fileSystem: CookieSigningKeyFileSystem, fd: number, value: Buffer): void {
	let offset = 0;
	while (offset < value.length) {
		const written = fileSystem.writeSync(fd, value, offset, value.length - offset, null);
		if (!Number.isSafeInteger(written) || written <= 0) {
			throw new Error("Failed to write complete cookie signing key");
		}
		offset += written;
	}
}

function fsyncDirectory(
	secretsDir: string,
	fileSystem: CookieSigningKeyFileSystem,
	platform: NodeJS.Platform,
): void {
	let fd: number | undefined;
	try {
		fd = fileSystem.openSync(secretsDir, "r");
		fileSystem.fsyncSync(fd);
	} catch (error) {
		// Directory handles/fsync are not supported by Node on Windows and by a
		// small set of filesystems. Publication remains atomic via the hard link.
		const unsupported = platform === "win32"
			|| ["EACCES", "EINVAL", "EISDIR", "ENOSYS", "ENOTSUP", "EPERM"].some((code) => isErrno(error, code));
		if (!unsupported) throw error;
	} finally {
		if (fd !== undefined) fileSystem.closeSync(fd);
	}
}

/**
 * Load or safely create the stable 32-byte HMAC key in `secretsDir`.
 *
 * A fully written and fsynced same-directory temporary file is published with
 * a hard link, giving create-if-absent semantics without ever exposing a
 * partial final file. An `EEXIST` publisher loses the race and loads the
 * winner. Existing malformed, unreadable, or non-regular material is fatal.
 */
export function loadOrCreateCookieSigningKey(
	secretsDir: string,
	options: CookieSigningKeyLoaderOptions = {},
): Buffer {
	const fileSystem = options.fileSystem ?? fs;
	const randomBytes = options.randomBytes ?? crypto.randomBytes;
	const platform = options.platform ?? process.platform;

	ensureSecretsDirectory(secretsDir, fileSystem, platform);
	const keyPath = path.join(secretsDir, COOKIE_SIGNING_KEY_FILE);
	const existing = readExistingKey(keyPath, fileSystem, platform);
	if (existing) return existing;

	const generated = secureRandomBytes(randomBytes, COOKIE_SIGNING_KEY_BYTES);
	const suffix = secureRandomBytes(randomBytes, 12).toString("base64url");
	const tempPath = path.join(secretsDir, `.${COOKIE_SIGNING_KEY_FILE}.${process.pid}.${suffix}.tmp`);
	let tempCreated = false;
	let result: Buffer | undefined;
	let failure: unknown;

	try {
		const fd = fileSystem.openSync(tempPath, "wx", 0o600);
		tempCreated = true;
		try {
			writeAll(fileSystem, fd, generated);
			fileSystem.fsyncSync(fd);
			const tempStat = fileSystem.fstatSync(fd);
			if (!tempStat.isFile() || tempStat.size !== COOKIE_SIGNING_KEY_BYTES) {
				throw new Error("Cookie signing-key temporary file failed validation");
			}
		} finally {
			fileSystem.closeSync(fd);
		}

		enforceMode(fileSystem, tempPath, 0o600, platform);
		const staged = readAndValidateKey(tempPath, fileSystem, platform);
		if (!crypto.timingSafeEqual(staged, generated)) {
			throw new Error("Cookie signing-key temporary file did not preserve generated material");
		}

		let published = false;
		try {
			fileSystem.linkSync(tempPath, keyPath);
			published = true;
		} catch (error) {
			if (!isErrno(error, "EEXIST")) throw error;
		}
		if (published) fsyncDirectory(secretsDir, fileSystem, platform);

		// Read the final path even when this process won, so publication and final
		// permissions are validated through the same fail-closed path on every boot.
		result = readAndValidateKey(keyPath, fileSystem, platform);
	} catch (error) {
		failure = error;
	}

	let cleanupFailure: unknown;
	if (tempCreated) {
		try {
			fileSystem.unlinkSync(tempPath);
		} catch (error) {
			if (!isErrno(error, "ENOENT")) cleanupFailure = error;
		}
	}

	if (failure && cleanupFailure) {
		throw new AggregateError([failure, cleanupFailure], "Cookie signing-key publication and temporary cleanup failed");
	}
	if (failure) throw failure;
	if (cleanupFailure) throw cleanupFailure;
	if (!result) throw new Error("Cookie signing-key publication produced no key");
	return result;
}
