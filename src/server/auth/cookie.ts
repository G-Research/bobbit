/**
 * Stateless Bobbit session cookie authentication.
 *
 * Legacy wire format (ASCII): `v1.<iat>.<exp>.<nonce>.<signature>`.
 * Gateway-issued format: `v1.2.<iat>.<exp>.<nonce>.<baseHash>.<originHash>.<signature>`.
 * `iat`/`exp` are canonical Unix seconds, the nonce is 16 random bytes, and
 * the fixed-width hashes bind the normalized mount and exact bootstrapping UI
 * origin. The signature is HMAC-SHA-256 over every preceding field. The admin
 * Bearer token is never part of the key or payload.
 *
 * This module deliberately has no filesystem capability. The stable 32-byte
 * signing key must be loaded once at gateway startup and passed to
 * {@link CookieStore}.
 */

import { createHash, createHmac, randomBytes as cryptoRandomBytes, timingSafeEqual } from "node:crypto";
import type http from "node:http";

export const COOKIE_NAME = "bobbit_session";
export const COOKIE_SIGNING_KEY_BYTES = 32;
export const COOKIE_NONCE_BYTES = 16;
export const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
export const COOKIE_FUTURE_SKEW_SECONDS = 5 * 60;
export const COOKIE_RENEWAL_WINDOW_SECONDS = 60 * 60 * 24 * 7;

const COOKIE_VERSION = "v1";
const BOUND_COOKIE_SUBVERSION = "2";
const LEGACY_COOKIE_PARTS = 5;
const BOUND_COOKIE_PARTS = 8;
const COOKIE_MAX_WIRE_LENGTH = 256;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const CANONICAL_BASE_PATH_RE = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;
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
	/** Present only for the path- and browser-origin-bound `v1.2` wire format. */
	binding?: Readonly<{ basePath: true; origin: true }>;
}

export interface CookieBinding {
	/** Canonical deployment mount: empty for root, otherwise leading slash/no trailing slash. */
	basePath: string;
	/** Canonical serialized HTTP(S) UI origin that authenticated the bootstrap. */
	origin: string;
}

export interface CookieVerificationBinding {
	basePath?: string;
	origin?: string;
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

function bindingDigest(value: string): Buffer {
	return createHash("sha256").update(value, "utf8").digest();
}

function canonicalCookieBinding(binding: CookieBinding): CookieBinding {
	const baseSegments = binding.basePath === "" ? [] : binding.basePath.slice(1).split("/");
	if (
		(binding.basePath !== "" && !CANONICAL_BASE_PATH_RE.test(binding.basePath))
		|| baseSegments.some((segment) => segment === "." || segment === "..")
	) {
		throw new Error("Cookie base path must be canonical");
	}
	let parsed: URL;
	try {
		parsed = new URL(binding.origin);
	} catch {
		throw new Error("Cookie browser origin must be a canonical HTTP(S) origin");
	}
	if (
		(parsed.protocol !== "http:" && parsed.protocol !== "https:")
		|| parsed.origin !== binding.origin
		|| parsed.username
		|| parsed.password
		|| parsed.pathname !== "/"
		|| parsed.search
		|| parsed.hash
	) {
		throw new Error("Cookie browser origin must be a canonical HTTP(S) origin");
	}
	return binding;
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

	/**
	 * Mint a signed cookie with the fixed 30-day lifetime. Calls without a
	 * binding retain the historical v1 format for compatibility helpers and
	 * root-migration tests. Gateway issuance always supplies a binding and emits
	 * the path/origin-bound `v1.2` format.
	 */
	mint(binding?: CookieBinding): string {
		const issuedAt = unixSeconds(this.clock);
		const expiresAt = issuedAt + COOKIE_MAX_AGE_SECONDS;
		if (!Number.isSafeInteger(expiresAt)) throw new Error("Cookie expiry exceeds the safe integer range");

		const nonce = secureRandomBytes(this.randomBytes, COOKIE_NONCE_BYTES).toString("base64url");
		const payload = binding === undefined
			? `${COOKIE_VERSION}.${issuedAt}.${expiresAt}.${nonce}`
			: (() => {
				const canonical = canonicalCookieBinding(binding);
				const basePathHash = bindingDigest(canonical.basePath).toString("base64url");
				const originHash = bindingDigest(canonical.origin).toString("base64url");
				return `${COOKIE_VERSION}.${BOUND_COOKIE_SUBVERSION}.${issuedAt}.${expiresAt}.${nonce}.${basePathHash}.${originHash}`;
			})();
		const signature = createHmac("sha256", this.signingKey).update(payload, "ascii").digest("base64url");
		return `${payload}.${signature}`;
	}

	/**
	 * Verify and describe a signed cookie. Malformed, unsupported, tampered,
	 * future-issued, expired, or overlong-lifetime values return `undefined`.
	 * Supplying a deployment binding rejects legacy v1 cookies outside root and
	 * checks every available v1.2 path/origin claim in constant time.
	 */
	verify(value: string, binding: CookieVerificationBinding = {}): CookieVerification | undefined {
		if (typeof value !== "string" || value.length > COOKIE_MAX_WIRE_LENGTH) return undefined;
		const parts = value.split(".");
		const legacy = parts.length === LEGACY_COOKIE_PARTS;
		const bound = parts.length === BOUND_COOKIE_PARTS;
		if (!legacy && !bound) return undefined;
		if (parts[0] !== COOKIE_VERSION) return undefined;
		if (bound && parts[1] !== BOUND_COOKIE_SUBVERSION) return undefined;

		const issuedAtIndex = bound ? 2 : 1;
		const rawIssuedAt = parts[issuedAtIndex]!;
		const rawExpiresAt = parts[issuedAtIndex + 1]!;
		const rawNonce = parts[issuedAtIndex + 2]!;
		const rawSignature = parts.at(-1)!;
		const issuedAt = canonicalUint(rawIssuedAt);
		const expiresAt = canonicalUint(rawExpiresAt);
		const nonce = canonicalBase64Url(rawNonce, COOKIE_NONCE_BYTES);
		const signature = canonicalBase64Url(rawSignature, COOKIE_SIGNING_KEY_BYTES);
		if (issuedAt === undefined || expiresAt === undefined || !nonce || !signature) return undefined;

		let rawBasePathHash: string | undefined;
		let rawOriginHash: string | undefined;
		if (bound) {
			rawBasePathHash = parts[5]!;
			rawOriginHash = parts[6]!;
			const basePathHash = canonicalBase64Url(rawBasePathHash, COOKIE_SIGNING_KEY_BYTES);
			const originHash = canonicalBase64Url(rawOriginHash, COOKIE_SIGNING_KEY_BYTES);
			if (!basePathHash || !originHash) return undefined;
		}

		const payload = parts.slice(0, -1).join(".");
		const expected = createHmac("sha256", this.signingKey).update(payload, "ascii").digest();
		// Both buffers are fixed at 32 bytes before this point. Never compare the
		// authentication tag or binding digests with ordinary string equality.
		if (!timingSafeEqual(expected, signature)) return undefined;

		if (legacy) {
			if (binding.basePath !== undefined && binding.basePath !== "") return undefined;
		} else {
			if (binding.basePath !== undefined) {
				const presented = Buffer.from(rawBasePathHash!, "base64url");
				if (!timingSafeEqual(bindingDigest(binding.basePath), presented)) return undefined;
			}
			if (binding.origin !== undefined) {
				const presented = Buffer.from(rawOriginHash!, "base64url");
				if (!timingSafeEqual(bindingDigest(binding.origin), presented)) return undefined;
			}
		}

		if (expiresAt <= issuedAt || expiresAt - issuedAt > COOKIE_MAX_AGE_SECONDS) return undefined;
		const now = unixSeconds(this.clock);
		if (issuedAt > now + COOKIE_FUTURE_SKEW_SECONDS || now >= expiresAt) return undefined;

		return {
			issuedAt,
			expiresAt,
			needsRenewal: expiresAt - now <= COOKIE_RENEWAL_WINDOW_SECONDS,
			...(bound ? { binding: { basePath: true as const, origin: true as const } } : {}),
		};
	}
}

function decodeCookieValue(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/** Collect all values for one cookie name without comma folding or shadowing duplicates. */
export function collectCookieValues(req: http.IncomingMessage, wantedName: string): string[] {
	const header = req.headers.cookie;
	if (!header || typeof header !== "string") return [];
	const values: string[] = [];
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		const name = part.slice(0, eq).trim();
		if (name !== wantedName) continue;
		values.push(decodeCookieValue(part.slice(eq + 1).trim()));
	}
	return values;
}

/** Parse the `Cookie` request header into a flat compatibility record. */
export function parseCookies(req: http.IncomingMessage): Record<string, string> {
	const header = req.headers.cookie;
	if (!header || typeof header !== "string") return {};
	const out: Record<string, string> = {};
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		const name = part.slice(0, eq).trim();
		if (!name) continue;
		out[name] = decodeCookieValue(part.slice(eq + 1).trim());
	}
	return out;
}

/** Return true when any duplicate-name Bobbit cookie verifies for the requested binding. */
export function tryAuth(
	req: http.IncomingMessage,
	store: CookieStore,
	binding: CookieVerificationBinding = {},
): boolean {
	return collectCookieValues(req, COOKIE_NAME).some((value) => Boolean(store.verify(value, binding)));
}

/**
 * True for any cryptographically valid cookie scoped to the root deployment.
 * This includes historical unbound v1 and current bound v1.2 values; both were
 * emitted with Path=/ and must be expired when the installation moves below a
 * mount.
 */
export function hasRootScopedCookie(req: http.IncomingMessage, store: CookieStore): boolean {
	return collectCookieValues(req, COOKIE_NAME).some((value) => Boolean(
		store.verify(value, { basePath: "" }),
	));
}

/**
 * Mint and append a response cookie. Callers that already verified the request
 * once can use this after the centralized browser-eligibility decision.
 */
export function issueCookie(
	res: http.ServerResponse,
	store: CookieStore,
	opts: { localhost?: boolean; basePath?: string; origin?: string } = {},
): string {
	if (opts.basePath && opts.origin === undefined) {
		throw new Error("Mounted browser cookies require an origin binding");
	}
	const value = opts.origin === undefined
		? store.mint()
		: store.mint({ basePath: opts.basePath ?? "", origin: opts.origin });
	// The gateway normalizes this process-level deployment value before it can
	// reach cookie issuance; keeping this crypto/auth module filesystem- and
	// application-dependency-free is an existing security boundary.
	const cookiePath = opts.basePath ? `${opts.basePath}/` : "/";
	const attrs = [
		`${COOKIE_NAME}=${value}`,
		"HttpOnly",
		"SameSite=Lax",
		`Path=${cookiePath}`,
		`Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
	];
	if (!opts.localhost) attrs.push("Secure");
	appendSetCookie(res, attrs.join("; "));
	return value;
}

/** Expire one path-scoped cookie without trusting forwarded TLS headers. */
export function expireCookie(
	res: http.ServerResponse,
	opts: { localhost?: boolean; basePath?: string } = {},
): void {
	const cookiePath = opts.basePath ? `${opts.basePath}/` : "/";
	const attrs = [
		`${COOKIE_NAME}=`,
		"HttpOnly",
		"SameSite=Lax",
		`Path=${cookiePath}`,
		"Max-Age=0",
		"Expires=Thu, 01 Jan 1970 00:00:00 GMT",
	];
	if (!opts.localhost) attrs.push("Secure");
	appendSetCookie(res, attrs.join("; "));
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
	opts: { localhost?: boolean; basePath?: string; origin?: string } = {},
): string | undefined {
	const binding = {
		...(opts.basePath !== undefined ? { basePath: opts.basePath } : {}),
		...(opts.origin !== undefined ? { origin: opts.origin } : {}),
	};
	const verified = collectCookieValues(req, COOKIE_NAME)
		.map((value) => ({ verification: store.verify(value, binding) }))
		.find((candidate) => candidate.verification !== undefined);
	if (verified?.verification && !verified.verification.needsRenewal) return undefined;
	return issueCookie(res, store, opts);
}

/**
 * Extract a Bobbit session cookie. With a store, only a value verified by that
 * store is returned, so a stale root cookie cannot shadow a valid mounted one.
 */
export function extractCookieValue(
	req: http.IncomingMessage,
	store?: CookieStore,
	binding: CookieVerificationBinding = {},
): string | undefined {
	const values = collectCookieValues(req, COOKIE_NAME);
	if (!store) return values[values.length - 1];
	return values.find((value) => Boolean(store.verify(value, binding)));
}
