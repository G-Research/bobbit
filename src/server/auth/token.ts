import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";

function tokenDir(): string {
	return bobbitStateDir();
}

function tokenFile(): string {
	return path.join(tokenDir(), "token");
}

export function generateToken(): string {
	return crypto.randomBytes(32).toString("hex"); // 256 bits = 64 hex chars
}

export function loadOrCreateToken(forceNew = false): string {
	const file = tokenFile();
	if (!forceNew) {
		try {
			const token = fs.readFileSync(file, "utf-8").trim();
			if (token.length >= 64) return token;
		} catch {
			// Token file doesn't exist yet
		}
	}

	const token = generateToken();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, token, { mode: 0o600 });
	return token;
}

export function readToken(): string | null {
	try {
		const token = fs.readFileSync(tokenFile(), "utf-8").trim();
		return token.length >= 64 ? token : null;
	} catch {
		return null;
	}
}

/** Constant-time token comparison to prevent timing attacks */
export function validateToken(provided: string, expected: string): boolean {
	if (provided.length !== expected.length) return false;
	return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
