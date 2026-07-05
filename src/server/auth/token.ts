import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bobbitStateDir, serverSecretsDir } from "../bobbit-dir.js";

function tokenDir(): string {
	return serverSecretsDir();
}

function tokenFile(): string {
	return path.join(tokenDir(), "token");
}

/**
 * Legacy token location under the Headquarters state dir. Read as a fallback
 * so a server that boots before the relocation migration still authenticates
 * with the existing token. Writes always go to the new `serverSecretsDir()`.
 */
function legacyTokenFile(): string {
	return path.join(bobbitStateDir(), "token");
}

export function generateToken(): string {
	return crypto.randomBytes(32).toString("hex"); // 256 bits = 64 hex chars
}

export function loadOrCreateToken(forceNew = false): string {
	const file = tokenFile();
	if (!forceNew) {
		// Prefer the new secrets-dir location, then fall back to the legacy
		// Headquarters-state token so a pre-migration boot still authenticates.
		for (const candidate of [file, legacyTokenFile()]) {
			try {
				const token = fs.readFileSync(candidate, "utf-8").trim();
				if (token.length >= 64) return token;
			} catch {
				// Token file doesn't exist at this candidate.
			}
		}
	}

	const token = generateToken();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, token, { mode: 0o600 });
	return token;
}

export function readToken(): string | null {
	for (const candidate of [tokenFile(), legacyTokenFile()]) {
		try {
			const token = fs.readFileSync(candidate, "utf-8").trim();
			if (token.length >= 64) return token;
		} catch {
			// Not present at this candidate.
		}
	}
	return null;
}

/** Constant-time token comparison to prevent timing attacks */
export function validateToken(provided: string, expected: string): boolean {
	if (provided.length !== expected.length) return false;
	return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
