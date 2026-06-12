// Shared helpers for resolving Bobbit gateway URL + auth token from the on-disk
// state directory (or env overrides), and calling back into the gateway from
// tool extensions.
//
// CREDENTIAL PRECEDENCE: disk first, env vars as fallback. The gateway rewrites
// the on-disk file on every start, so a session that survives a `./run` restart
// picks up the new token + URL on the next tool call. Env vars (BOBBIT_TOKEN /
// BOBBIT_GATEWAY_URL) are set once at agent spawn and become stale across
// restarts. A 1-second TTL cache keeps per-tool-call disk reads cheap.
//
// Two surfaces are exported:
//
//   - `getGatewayUrl()` / `getGatewayToken()` — original loud-on-missing helpers
//     used by image-generation, MCP discovery, etc.
//
//   - `readGatewayCreds()` / `apiCall()` — soft-fail helpers used by team-lead
//     and children tool extensions. `apiCall` retries transient TCP errors
//     (ECONNRESET, EPIPE, socket hang up, UND_ERR_SOCKET, opaque "fetch failed")
//     with 250 / 500 / 1000 ms exponential back-off, and refreshes credentials
//     once per call on HTTP 401 to handle gateway-restart token rotation.

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

function diskStateDir(): string {
	return process.env.BOBBIT_DIR
		? path.join(process.env.BOBBIT_DIR, "state")
		: path.join(homedir(), ".pi");
}

function diskTokenPath(): string {
	const tokenFile = process.env.BOBBIT_DIR ? "token" : "gateway-token";
	return path.join(diskStateDir(), tokenFile);
}

function diskUrlPath(): string {
	return path.join(diskStateDir(), "gateway-url");
}

export function getGatewayUrl(): string {
	try {
		return fs.readFileSync(diskUrlPath(), "utf-8").trim().replace(/\/+$/, "");
	} catch {
		// Disk read failed; fall back to env.
	}
	if (process.env.BOBBIT_GATEWAY_URL) {
		return process.env.BOBBIT_GATEWAY_URL.replace(/\/+$/, "");
	}
	throw new Error("BOBBIT gateway URL not found on disk or in env");
}

export function getGatewayToken(): string {
	try {
		return fs.readFileSync(diskTokenPath(), "utf-8").trim();
	} catch {
		// Disk read failed; fall back to env.
	}
	if (process.env.BOBBIT_TOKEN) return process.env.BOBBIT_TOKEN;
	throw new Error("BOBBIT token not found on disk or in env");
}

/**
 * Soft credential resolver — returns either the resolved token+baseUrl pair or
 * a structured `{ error }` so callers can early-return without throwing.
 *
 * Resolution order: disk first (always-fresh source — gateway rewrites the
 * file on every start), env vars as fallback when disk read fails.
 */
export function readGatewayCreds(): { token: string; baseUrl: string } | { error: string } {
	try {
		const token = fs.readFileSync(diskTokenPath(), "utf-8").trim();
		const baseUrl = fs.readFileSync(diskUrlPath(), "utf-8").trim().replace(/\/+$/, "");
		return { token, baseUrl };
	} catch {
		// Disk-read failed (e.g. running under a sandboxed test harness without
		// a state dir). Fall through to env.
	}
	const envToken = process.env.BOBBIT_TOKEN;
	const envUrl = process.env.BOBBIT_GATEWAY_URL;
	if (envToken && envUrl) {
		return { token: envToken, baseUrl: envUrl.replace(/\/+$/, "") };
	}
	return { error: "BOBBIT credentials not found on disk or in env" };
}

// 1-second TTL cache. An agent making tens of tool calls per second pays one
// readFileSync per second; a stale token after a gateway restart self-heals on
// the next second (or sooner via clearCredsCache() on 401).
let _credsCache: { creds: { token: string; baseUrl: string } | { error: string }; ts: number } | null = null;
const CREDS_TTL_MS = 1_000;

function readGatewayCredsCached(): { token: string; baseUrl: string } | { error: string } {
	const now = Date.now();
	if (_credsCache && now - _credsCache.ts < CREDS_TTL_MS) return _credsCache.creds;
	const fresh = readGatewayCreds();
	_credsCache = { creds: fresh, ts: now };
	return fresh;
}

/** Force-clear the cache. Used internally on 401 to re-read disk before retrying. */
function clearCredsCache(): void {
	_credsCache = null;
}

const TRANSIENT_RE = /ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|UND_ERR_SOCKET|fetch failed/i;

function isTransientFetchError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const cause = (err as { cause?: unknown }).cause;
	const causeMsg = cause instanceof Error ? cause.message : "";
	const causeCode = cause && typeof cause === "object" && "code" in cause
		? String((cause as { code?: unknown }).code)
		: "";
	const composite = [err.message, causeMsg, causeCode].filter(Boolean).join(" ");
	return TRANSIENT_RE.test(composite);
}

export interface ApiCallOpts {
	/** Extra headers merged on top of `Authorization` + `Content-Type`. */
	extraHeaders?: Record<string, string>;
	/** Number of retries for transient errors. Default 3 (4 total attempts). 0 to disable. */
	retries?: number;
}

/**
 * Authenticated JSON fetch against the gateway. Throws on non-2xx with the
 * server-provided `error` field when present, else `HTTP <status>: <body>`.
 *
 * Resilience:
 *  - Transient TCP errors retried up to `opts.retries` times (default 3) with
 *    exponential back-off: 250 / 500 / 1000 ms.
 *  - HTTP 401 triggers ONE creds refresh (clearCredsCache + re-read disk) and
 *    one retry, not consuming a transient retry slot. If the refresh fails
 *    or the second 401 lands, the auth error is propagated.
 *  - Non-401 4xx/5xx responses are NOT retried — those are real outcomes.
 */
export async function apiCall(
	creds: { token: string; baseUrl: string },
	method: string,
	urlPath: string,
	body?: unknown,
	opts?: ApiCallOpts,
): Promise<unknown> {
	const maxAttempts = (opts?.retries ?? 3) + 1;
	let lastErr: unknown;
	let usedCreds = creds;
	let didCredsRefresh = false;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			const headers: Record<string, string> = {
				Authorization: `Bearer ${usedCreds.token}`,
				"Content-Type": "application/json",
				...(opts?.extraHeaders ?? {}),
			};
			const resp = await fetch(`${usedCreds.baseUrl}${urlPath}`, {
				method,
				headers,
				body: body !== undefined ? JSON.stringify(body) : undefined,
			});
			// 401 → one creds-refresh + retry, then fall through to normal error handling.
			if (resp.status === 401 && !didCredsRefresh) {
				didCredsRefresh = true;
				clearCredsCache();
				const fresh = readGatewayCredsCached();
				if (!("error" in fresh)) {
					usedCreds = fresh;
					console.warn(`[gateway] 401 on ${method} ${urlPath} — refreshed creds from disk and retrying`);
					continue; // retry without consuming a transient-retry slot
				}
				// Disk gone — propagate the 401 below.
			}
			const text = await resp.text();
			let data: unknown;
			try { data = JSON.parse(text); } catch { data = text; }
			if (!resp.ok) {
				const msg = typeof data === "object" && data !== null && "error" in data
					? String((data as Record<string, unknown>).error)
					: `HTTP ${resp.status}: ${text}`;
				throw new Error(msg);
			}
			return data;
		} catch (err) {
			lastErr = err;
			const transient = isTransientFetchError(err);
			const isFinal = attempt === maxAttempts - 1;
			if (!transient || isFinal) {
				if (isFinal && transient) {
					const diskPath = diskUrlPath();
					throw new Error(
						`Gateway request failed after ${maxAttempts} attempts: ${method} ${usedCreds.baseUrl}${urlPath} — ` +
						`last error: ${err instanceof Error ? err.message : String(err)}. ` +
						`Cached gateway-url: ${usedCreds.baseUrl}; on-disk: ${diskPath}.`,
					);
				}
				throw err;
			}
			const backoff = 250 * Math.pow(2, attempt); // 250 / 500 / 1000 ms
			console.warn(
				`[gateway] ${method} ${urlPath} transient error (attempt ${attempt + 1}/${maxAttempts}): ` +
				`${err instanceof Error ? err.message : String(err)} — retrying in ${backoff}ms`,
			);
			await new Promise(r => setTimeout(r, backoff));
		}
	}
	throw lastErr;
}

// Test-only: allow tests to reset module-level cache between cases.
export function __clearCredsCacheForTesting(): void {
	clearCredsCache();
}
