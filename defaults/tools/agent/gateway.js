// Group-local gateway helpers for the bundled Agent tool extension.
//
// Keep this file inside defaults/tools/agent/ so project-level copies of the
// whole Agent tool group remain self-contained. Tool metadata edits copy only
// the edited group into .bobbit/config/tools/<group>; importing ../_shared/*
// from here would make copied Agent overrides fail during agent startup.

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

function diskStateDir() {
	return process.env.BOBBIT_DIR
		? path.join(process.env.BOBBIT_DIR, "state")
		: path.join(homedir(), ".pi");
}

function diskTokenPath() {
	const tokenFile = process.env.BOBBIT_DIR ? "token" : "gateway-token";
	return path.join(diskStateDir(), tokenFile);
}

function diskUrlPath() {
	return path.join(diskStateDir(), "gateway-url");
}

export function readGatewayCreds() {
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

let credsCache = null;
const CREDS_TTL_MS = 1_000;

function readGatewayCredsCached() {
	const now = Date.now();
	if (credsCache && now - credsCache.ts < CREDS_TTL_MS) return credsCache.creds;
	const fresh = readGatewayCreds();
	credsCache = { creds: fresh, ts: now };
	return fresh;
}

function clearCredsCache() {
	credsCache = null;
}

const TRANSIENT_RE = /ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|UND_ERR_SOCKET|fetch failed/i;

function isTransientFetchError(err) {
	if (!(err instanceof Error)) return false;
	const cause = err.cause;
	const causeMsg = cause instanceof Error ? cause.message : "";
	const causeCode = cause && typeof cause === "object" && "code" in cause
		? String(cause.code)
		: "";
	const composite = [err.message, causeMsg, causeCode].filter(Boolean).join(" ");
	return TRANSIENT_RE.test(composite);
}

export async function apiCallDetailed(creds, method, urlPath, body, opts) {
	const maxAttempts = (opts?.retries ?? 3) + 1;
	let lastErr;
	let usedCreds = creds;
	let didCredsRefresh = false;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			const headers = {
				Authorization: `Bearer ${usedCreds.token}`,
				"Content-Type": "application/json",
				...(opts?.extraHeaders ?? {}),
			};
			const resp = await fetch(`${usedCreds.baseUrl}${urlPath}`, {
				method,
				headers,
				body: body !== undefined ? JSON.stringify(body) : undefined,
			});
			if (resp.status === 401 && !didCredsRefresh) {
				didCredsRefresh = true;
				clearCredsCache();
				const fresh = readGatewayCredsCached();
				if (!("error" in fresh)) {
					usedCreds = fresh;
					console.warn(`[gateway] 401 on ${method} ${urlPath} — refreshed creds from disk and retrying`);
					attempt--;
					continue;
				}
			}
			const text = await resp.text();
			let data;
			try { data = JSON.parse(text); } catch { data = text; }
			return { ok: resp.ok, status: resp.status, body: data, text };
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
			const backoff = 250 * Math.pow(2, attempt);
			console.warn(
				`[gateway] ${method} ${urlPath} transient error (attempt ${attempt + 1}/${maxAttempts}): ` +
				`${err instanceof Error ? err.message : String(err)} — retrying in ${backoff}ms`,
			);
			await new Promise(r => setTimeout(r, backoff));
		}
	}
	throw lastErr;
}

export async function apiCall(creds, method, urlPath, body, opts) {
	const result = await apiCallDetailed(creds, method, urlPath, body, opts);
	if (!result.ok) {
		const msg = typeof result.body === "object" && result.body !== null && "error" in result.body
			? String(result.body.error)
			: `HTTP ${result.status}: ${result.text}`;
		throw new Error(msg);
	}
	return result.body;
}

export function __clearCredsCacheForTesting() {
	clearCredsCache();
}
