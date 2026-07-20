/**
 * Stateless Bobbit session cookie authentication.
 *
 * Wire format (ASCII): `v1.<iat>.<exp>.<nonce>.<signature>`.
 * `iat` and `exp` are canonical Unix seconds, `nonce` is 16 random bytes
 * encoded as unpadded base64url, and `signature` is HMAC-SHA-256 over the
 * preceding four fields. The admin Bearer token is never part of the key or
 * payload.
 *
 * This module deliberately has no filesystem capability. The stable 32-byte
 * signing key must be loaded once at gateway startup and passed to
 * {@link CookieStore}.
 */

import { createHmac, randomBytes as cryptoRandomBytes, timingSafeEqual } from "node:crypto";
import type http from "node:http";

export const COOKIE_NAME = "bobbit_session";
export const COOKIE_SIGNING_KEY_BYTES = 32;
export const COOKIE_NONCE_BYTES = 16;
export const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
export const COOKIE_FUTURE_SKEW_SECONDS = 5 * 60;
export const COOKIE_RENEWAL_WINDOW_SECONDS = 60 * 60 * 24 * 7;

const COOKIE_VERSION = "v1";
const COOKIE_MAX_WIRE_LENGTH = 103;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const UNSIGNED_DECIMAL_RE = /^(?:0|[1-9][0-9]*)$/;

export interface CookieClock {
	/** Current Unix time in milliseconds, matching `Date.now()`. */
	now(): number;
}

export interface CookieVerification {
	/** Canonical `iat` value from the cookie, in Unix seconds. */
	issuedAt: number;
	/** Canonical `exp` value from the cookie, in Unix seconds. */
	expiresAt: number;
	/** True when expiry is at or within the inclusive seven-day renewal window. */
	needsRenewal: boolean;
}

export interface CookieStoreOptions {
	clock?: CookieClock;
	randomBytes?: (size: number) => Buffer;
}

const systemClock: CookieClock = { now: () => Date.now() };

function canonicalUint(raw: string): number | undefined {
	if (!UNSIGNED_DECIMAL_RE.test(raw)) return undefined;
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== raw) return undefined;
	return parsed;
}

function canonicalBase64Url(raw: string, expectedBytes: number): Buffer | undefined {
	if (!BASE64URL_RE.test(raw)) return undefined;
	const decoded = Buffer.from(raw, "base64url");
	if (decoded.length !== expectedBytes || decoded.toString("base64url") !== raw) return undefined;
	return decoded;
}

function unixSeconds(clock: CookieClock): number {
	const now = Math.floor(clock.now() / 1_000);
	if (!Number.isSafeInteger(now) || now < 0) {
		throw new Error("Cookie clock returned an invalid Unix time");
	}
	return now;
}

function secureRandomBytes(randomBytes: (size: number) => Buffer, size: number): Buffer {
	const value = randomBytes(size);
	if (!Buffer.isBuffer(value) || value.length !== size) {
		throw new Error(`Cookie random source must return exactly ${size} bytes`);
	}
	return value;
}

function appendSetCookie(res: http.ServerResponse, value: string): void {
	const previous = res.getHeader("Set-Cookie");
	if (Array.isArray(previous)) {
		res.setHeader("Set-Cookie", [...previous, value]);
	} else if (typeof previous === "string") {
		res.setHeader("Set-Cookie", [previous, value]);
	} else {
		res.setHeader("Set-Cookie", value);
	}
}

export class CookieStore {
	private readonly signingKey: Buffer;
	private readonly clock: CookieClock;
	private readonly randomBytes: (size: number) => Buffer;

	constructor(signingKey: Buffer, options: CookieStoreOptions = {}) {
		if (!Buffer.isBuffer(signingKey) || signingKey.length !== COOKIE_SIGNING_KEY_BYTES) {
			throw new Error(`Cookie signing key must be exactly ${COOKIE_SIGNING_KEY_BYTES} bytes`);
		}
		// Keep our own immutable copy so a caller cannot rotate the key by mutating
		// the Buffer after construction.
		this.signingKey = Buffer.from(signingKey);
		this.clock = options.clock ?? systemClock;
		this.randomBytes = options.randomBytes ?? cryptoRandomBytes;
	}

	/** Mint a signed cookie with the fixed 30-day lifetime. */
	mint(): string {
		const issuedAt = unixSeconds(this.clock);
		const expiresAt = issuedAt + COOKIE_MAX_AGE_SECONDS;
		if (!Number.isSafeInteger(expiresAt)) throw new Error("Cookie expiry exceeds the safe integer range");

		const nonce = secureRandomBytes(this.randomBytes, COOKIE_NONCE_BYTES).toString("base64url");
		const payload = `${COOKIE_VERSION}.${issuedAt}.${expiresAt}.${nonce}`;
		const signature = createHmac("sha256", this.signingKey).update(payload, "ascii").digest("base64url");
		return `${payload}.${signature}`;
	}

	/**
	 * Verify and describe a signed cookie. Malformed, unsupported, tampered,
	 * future-issued, expired, or overlong-lifetime values return `undefined`.
	 */
	verify(value: string): CookieVerification | undefined {
		if (typeof value !== "string" || value.length > COOKIE_MAX_WIRE_LENGTH) return undefined;
		const parts = value.split(".");
		if (parts.length !== 5) return undefined;

		const [version, rawIssuedAt, rawExpiresAt, rawNonce, rawSignature] = parts;
		if (version !== COOKIE_VERSION) return undefined;

		const issuedAt = canonicalUint(rawIssuedAt);
		const expiresAt = canonicalUint(rawExpiresAt);
		const nonce = canonicalBase64Url(rawNonce, COOKIE_NONCE_BYTES);
		const signature = canonicalBase64Url(rawSignature, COOKIE_SIGNING_KEY_BYTES);
		if (issuedAt === undefined || expiresAt === undefined || !nonce || !signature) return undefined;

		const payload = `${version}.${rawIssuedAt}.${rawExpiresAt}.${rawNonce}`;
		const expected = createHmac("sha256", this.signingKey).update(payload, "ascii").digest();
		// Both buffers are fixed at 32 bytes before this point. Never compare the
		// authentication tag with ordinary string or Buffer equality.
		if (!timingSafeEqual(expected, signature)) return undefined;

		if (expiresAt <= issuedAt || expiresAt - issuedAt > COOKIE_MAX_AGE_SECONDS) return undefined;
		const now = unixSeconds(this.clock);
		if (issuedAt > now + COOKIE_FUTURE_SKEW_SECONDS || now >= expiresAt) return undefined;

		return {
			issuedAt,
			expiresAt,
			needsRenewal: expiresAt - now <= COOKIE_RENEWAL_WINDOW_SECONDS,
		};
	}
}

/** Parse the `Cookie` request header into a flat record. */
export function parseCookies(req: http.IncomingMessage): Record<string, string> {
	const header = req.headers.cookie;
	if (!header || typeof header !== "string") return {};
	const out: Record<string, string> = {};
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		const name = part.slice(0, eq).trim();
		const value = part.slice(eq + 1).trim();
		if (!name) continue;
		try {
			out[name] = decodeURIComponent(value);
		} catch {
			out[name] = value;
		}
	}
	return out;
}

/** Return true when the request carries a valid signed Bobbit session cookie. */
export function tryAuth(req: http.IncomingMessage, store: CookieStore): boolean {
	const value = parseCookies(req)[COOKIE_NAME];
	return value !== undefined && Boolean(store.verify(value));
}

/**
 * Mint and append a response cookie. Callers that already verified the request
 * once can use this after the centralized browser-eligibility decision.
 */
export function issueCookie(
	res: http.ServerResponse,
	store: CookieStore,
	opts: { localhost?: boolean } = {},
): string {
	const value = store.mint();
	const attrs = [
		`${COOKIE_NAME}=${value}`,
		"HttpOnly",
		"SameSite=Lax",
		"Path=/",
		`Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
	];
	if (!opts.localhost) attrs.push("Secure");
	appendSetCookie(res, attrs.join("; "));
	return value;
}

/**
 * Mint or refresh the response cookie when it is absent, invalid, or within
 * the inclusive renewal window. The caller is responsible for applying the
 * centralized browser-eligibility policy before invoking this helper.
 *
 * `localhost` controls `Secure`: localhost HTTP mode must omit it because the
 * browser would otherwise discard the cookie.
 */
export function issueIfMissing(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	store: CookieStore,
	opts: { localhost?: boolean } = {},
): string | undefined {
	const existing = parseCookies(req)[COOKIE_NAME];
	const verification = existing === undefined ? undefined : store.verify(existing);
	if (verification && !verification.needsRenewal) return undefined;
	return issueCookie(res, store, opts);
}

/** Extract the raw Bobbit session cookie, useful for SSE re-authentication. */
export function extractCookieValue(req: http.IncomingMessage): string | undefined {
	return parseCookies(req)[COOKIE_NAME];
}
