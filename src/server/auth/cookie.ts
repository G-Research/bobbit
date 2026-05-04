/**
 * Bobbit session cookie auth.
 *
 * Issued on successful Bearer-token authentication so subsequent UI traffic
 * (and especially `/preview/<sid>/*` content origin requests, which can't
 * carry an Authorization header from an iframe `src=`) authenticate via a
 * standard browser cookie.
 *
 * Cookie value is an opaque 32-byte hex string; the bearer token itself is
 * never embedded. Values are stored at `<stateDir>/auth-cookies.json` so
 * they survive gateway restarts. Sandbox tokens DO NOT mint cookies — they
 * keep their scoped allow-list flow.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type http from "node:http";

export const COOKIE_NAME = "bobbit_session";

/** Max-Age 30 days (in seconds). */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

interface CookieFile {
	version: 1;
	issuedAt: number;
	values: Record<string, { issuedAt: number }>;
}

export class CookieStore {
	private filePath: string;
	private data: CookieFile = { version: 1, issuedAt: Date.now(), values: {} };
	private loaded = false;
	private writeTimer: NodeJS.Timeout | null = null;

	constructor(stateDir: string) {
		this.filePath = path.join(stateDir, "auth-cookies.json");
	}

	private ensureLoaded(): void {
		if (this.loaded) return;
		this.loaded = true;
		try {
			if (fs.existsSync(this.filePath)) {
				const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
				if (raw && raw.version === 1 && raw.values && typeof raw.values === "object") {
					this.data = {
						version: 1,
						issuedAt: typeof raw.issuedAt === "number" ? raw.issuedAt : Date.now(),
						values: {},
					};
					for (const [k, v] of Object.entries(raw.values)) {
						if (typeof k === "string" && /^[0-9a-f]{64}$/i.test(k) && v && typeof v === "object") {
							const issuedAt = (v as { issuedAt?: number }).issuedAt;
							this.data.values[k] = { issuedAt: typeof issuedAt === "number" ? issuedAt : Date.now() };
						}
					}
				}
			}
		} catch {
			/* ignore — start with empty store */
		}
	}

	private scheduleWrite(): void {
		if (this.writeTimer) return;
		this.writeTimer = setTimeout(() => {
			this.writeTimer = null;
			this.flush();
		}, 100);
		// Don't keep the event loop alive solely for the debounced write.
		if (typeof this.writeTimer.unref === "function") this.writeTimer.unref();
	}

	private flush(): void {
		try {
			const dir = path.dirname(this.filePath);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			const json = JSON.stringify(this.data, null, 2) + "\n";
			fs.writeFileSync(this.filePath, json, { encoding: "utf-8", mode: 0o600 });
			// Tighten mode on platforms where writeFileSync didn't apply it.
			try { fs.chmodSync(this.filePath, 0o600); } catch { /* ignore */ }
		} catch (err) {
			console.error("[cookie-store] write failed:", err);
		}
	}

	/** True if `value` is a known issued cookie. */
	verify(value: string): boolean {
		this.ensureLoaded();
		if (!value || typeof value !== "string") return false;
		if (!/^[0-9a-f]{64}$/i.test(value)) return false;
		return Object.prototype.hasOwnProperty.call(this.data.values, value);
	}

	/** Mint a new cookie value, persist it, return the value. */
	mint(): string {
		this.ensureLoaded();
		const value = crypto.randomBytes(32).toString("hex");
		this.data.values[value] = { issuedAt: Date.now() };
		this.scheduleWrite();
		return value;
	}

	/** Revoke a cookie value. */
	revoke(value: string): void {
		this.ensureLoaded();
		if (Object.prototype.hasOwnProperty.call(this.data.values, value)) {
			delete this.data.values[value];
			this.scheduleWrite();
		}
	}

	/** Test-only: synchronously flush pending writes. */
	flushNow(): void {
		if (this.writeTimer) {
			clearTimeout(this.writeTimer);
			this.writeTimer = null;
		}
		this.flush();
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

/**
 * Module-level helper: returns true if the request carries a valid bobbit
 * session cookie known to `store`.
 */
export function tryAuth(req: http.IncomingMessage, store: CookieStore): boolean {
	const value = parseCookies(req)[COOKIE_NAME];
	if (!value) return false;
	return store.verify(value);
}

/**
 * Mint and Set-Cookie if no valid cookie is already present.
 *
 * `localhost` controls the `Secure` flag — localhost mode (HTTP) cannot use
 * `Secure` because the browser would discard the cookie.
 */
export function issueIfMissing(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	store: CookieStore,
	opts: { localhost?: boolean } = {},
): void {
	const existing = parseCookies(req)[COOKIE_NAME];
	if (existing && store.verify(existing)) return;

	const value = store.mint();
	const attrs = [
		`${COOKIE_NAME}=${value}`,
		"HttpOnly",
		"SameSite=Lax",
		"Path=/",
		`Max-Age=${MAX_AGE_SECONDS}`,
	];
	if (!opts.localhost) attrs.push("Secure");
	const setCookie = attrs.join("; ");

	const prev = res.getHeader("Set-Cookie");
	if (Array.isArray(prev)) {
		res.setHeader("Set-Cookie", [...prev, setCookie]);
	} else if (typeof prev === "string") {
		res.setHeader("Set-Cookie", [prev, setCookie]);
	} else {
		res.setHeader("Set-Cookie", setCookie);
	}
}

/** Helper: extract cookie value from req, useful for SSE re-auth. */
export function extractCookieValue(req: http.IncomingMessage): string | undefined {
	return parseCookies(req)[COOKIE_NAME];
}
