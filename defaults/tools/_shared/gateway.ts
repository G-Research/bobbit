// Shared helpers for resolving Bobbit gateway URL + auth token from the on-disk
// state directory (or env overrides), and calling back into the gateway from
// tool extensions.
//
// Two surfaces are exported:
//
//   - `getGatewayUrl()` / `getGatewayToken()` — original loud-on-missing helpers
//     used by image-generation, MCP discovery, etc.
//
//   - `readGatewayCreds()` / `apiCall()` — soft-fail helpers used by team-lead
//     and children tool extensions that gracefully no-op when credentials are
//     missing (e.g. tests, sandboxes without gateway access). These mirror the
//     pre-existing duplicated bodies in `team/extension.ts` and
//     `children/extension.ts`.

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

function stateDirStrict(): string {
	if (process.env.BOBBIT_DIR) return path.join(process.env.BOBBIT_DIR, "state");
	// No silent fallback to ~/.pi: tool extensions run inside an agent process
	// whose env is set up by the gateway. If BOBBIT_DIR is missing, the caller
	// is mis-configured and we want a loud error rather than guessing a path.
	throw new Error("BOBBIT_DIR not set; cannot resolve gateway");
}

export function getGatewayUrl(): string {
	if (process.env.BOBBIT_GATEWAY_URL) {
		return process.env.BOBBIT_GATEWAY_URL.replace(/\/+$/, "");
	}
	return fs.readFileSync(path.join(stateDirStrict(), "gateway-url"), "utf-8").trim().replace(/\/+$/, "");
}

export function getGatewayToken(): string {
	if (process.env.BOBBIT_TOKEN) return process.env.BOBBIT_TOKEN;
	return fs.readFileSync(path.join(stateDirStrict(), "token"), "utf-8").trim();
}

/**
 * Soft credential resolver — returns either the resolved token+baseUrl pair or
 * a structured `{ error }` so callers can early-return without throwing.
 *
 * Resolution order:
 *   1. `BOBBIT_TOKEN` + `BOBBIT_GATEWAY_URL` env vars (preferred — set by the
 *      gateway when spawning agents).
 *   2. State-dir files. When `BOBBIT_DIR` is set: `<BOBBIT_DIR>/state/token` +
 *      `gateway-url`. Otherwise legacy `~/.pi/gateway-token` + `gateway-url`.
 */
export function readGatewayCreds(): { token: string; baseUrl: string } | { error: string } {
	const envToken = process.env.BOBBIT_TOKEN;
	const envUrl = process.env.BOBBIT_GATEWAY_URL;
	if (envToken && envUrl) {
		return { token: envToken, baseUrl: envUrl.replace(/\/+$/, "") };
	}
	try {
		const stateDir = process.env.BOBBIT_DIR
			? path.join(process.env.BOBBIT_DIR, "state")
			: path.join(homedir(), ".pi");
		const tokenFile = process.env.BOBBIT_DIR ? "token" : "gateway-token";
		const urlFile = "gateway-url";
		const token = fs.readFileSync(path.join(stateDir, tokenFile), "utf-8").trim();
		const baseUrl = fs.readFileSync(path.join(stateDir, urlFile), "utf-8").trim().replace(/\/+$/, "");
		return { token, baseUrl };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

export interface ApiCallOpts {
	/** Extra headers merged on top of `Authorization` + `Content-Type`. */
	extraHeaders?: Record<string, string>;
}

/**
 * Authenticated JSON fetch against the gateway. Throws on non-2xx with the
 * server-provided `error` field when present, else `HTTP <status>: <body>`.
 *
 * Both the team-lead and children tool extensions use this — keeping a single
 * implementation means retry/backoff or auth-refresh changes land in one place.
 */
export async function apiCall(
	creds: { token: string; baseUrl: string },
	method: string,
	urlPath: string,
	body?: unknown,
	opts?: ApiCallOpts,
): Promise<unknown> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${creds.token}`,
		"Content-Type": "application/json",
		...(opts?.extraHeaders ?? {}),
	};
	const resp = await fetch(`${creds.baseUrl}${urlPath}`, {
		method,
		headers,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
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
}
