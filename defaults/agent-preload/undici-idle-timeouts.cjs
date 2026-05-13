/**
 * Bobbit-injected undici preload — restore idle-gap timeouts for remote LLM origins.
 *
 * Why this exists:
 *   `@earendil-works/pi-coding-agent/dist/cli.js` calls
 *     setGlobalDispatcher(new EnvHttpProxyAgent({ bodyTimeout: 0, headersTimeout: 0 }))
 *   at startup. That globally disables undici's idle-gap timeout for every
 *   outbound HTTP request from the agent subprocess — including remote LLM
 *   SSE streams. When a remote stream goes silent, the agent hangs forever.
 *
 * What we do:
 *   Monkey-patch `undici.setGlobalDispatcher` so whatever dispatcher
 *   pi-coding-agent installs (EnvHttpProxyAgent) gets wrapped in an
 *   `IdleTimeoutDispatcher`. That wrapper injects `bodyTimeout` and
 *   `headersTimeout` on per-request `opts` *only* when the origin is
 *   remote (i.e. not localhost / RFC1918 / Tailscale CGNAT / .local) and
 *   not on a user-configured trusted-no-timeout allowlist.
 *
 * Loaded via `node --require=<this file>` from rpc-bridge.ts for both
 * direct-spawn and Docker-exec agent processes.
 *
 * Env vars (read once at preload time):
 *   BOBBIT_REMOTE_BODY_TIMEOUT_MS         default 120000
 *   BOBBIT_REMOTE_HEADERS_TIMEOUT_MS      default 60000
 *   BOBBIT_TRUSTED_NO_TIMEOUT_ORIGINS     default "" (comma-separated origins)
 *
 * Exported helpers are for the unit test (`tests/undici-idle-timeouts.test.ts`).
 */

"use strict";

const net = require("node:net");

const DEFAULT_BODY_MS = 120_000;
const DEFAULT_HEADERS_MS = 60_000;

function parsePositiveInt(value, fallback) {
	if (value == null) return fallback;
	const n = Number.parseInt(String(value), 10);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return n;
}

const bodyMs = parsePositiveInt(process.env.BOBBIT_REMOTE_BODY_TIMEOUT_MS, DEFAULT_BODY_MS);
const headersMs = parsePositiveInt(process.env.BOBBIT_REMOTE_HEADERS_TIMEOUT_MS, DEFAULT_HEADERS_MS);

// ── IP / origin classification ─────────────────────────────────────────

function ipv4ToInt(ip) {
	const parts = ip.split(".");
	if (parts.length !== 4) return null;
	let acc = 0;
	for (const p of parts) {
		const n = Number(p);
		if (!Number.isInteger(n) || n < 0 || n > 255) return null;
		acc = (acc * 256) + n;
	}
	return acc;
}

function inCidr4(ip, baseStr, prefixBits) {
	const ipInt = ipv4ToInt(ip);
	const baseInt = ipv4ToInt(baseStr);
	if (ipInt == null || baseInt == null) return false;
	if (prefixBits === 0) return true;
	const mask = (~0 << (32 - prefixBits)) >>> 0;
	return (ipInt & mask) === (baseInt & mask);
}

function isPrivateIPv4(ip) {
	// Loopback 127.0.0.0/8
	if (inCidr4(ip, "127.0.0.0", 8)) return true;
	// RFC1918
	if (inCidr4(ip, "10.0.0.0", 8)) return true;
	if (inCidr4(ip, "192.168.0.0", 16)) return true;
	if (inCidr4(ip, "172.16.0.0", 12)) return true;
	// Tailscale CGNAT 100.64.0.0/10
	if (inCidr4(ip, "100.64.0.0", 10)) return true;
	// 0.0.0.0 sentinel
	if (ip === "0.0.0.0") return true;
	return false;
}

function isPrivateIPv6(ip) {
	const lower = ip.toLowerCase();
	if (lower === "::" || lower === "::1") return true;
	// fc00::/7 — ULA. First byte 0xFC or 0xFD.
	// Expand the first hextet.
	const firstHextet = lower.split(":")[0] || "";
	if (firstHextet.length > 0) {
		const n = Number.parseInt(firstHextet, 16);
		if (Number.isInteger(n)) {
			const firstByte = (n >> 8) & 0xff;
			if (firstByte === 0xfc || firstByte === 0xfd) return true;
		}
	}
	// IPv4-mapped loopback (::ffff:127.x.x.x)
	if (lower.startsWith("::ffff:")) {
		const tail = lower.substring("::ffff:".length);
		if (net.isIPv4(tail) && isPrivateIPv4(tail)) return true;
	}
	return false;
}

/**
 * Returns true when the origin hostname should be treated as local —
 * preserving pi-coding-agent's `bodyTimeout: 0` behaviour for buffered
 * vLLM/Ollama/LM Studio backends. Public-DNS AI gateways always return false.
 */
function isLocalOrigin(originStr) {
	let url;
	try {
		url = new URL(originStr);
	} catch {
		return false;
	}
	// URL.hostname keeps IPv6 brackets ("[fc00::1]") — strip them for net.isIP.
	let host = (url.hostname || "").toLowerCase();
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	if (!host) return false;

	if (host === "localhost") return true;
	if (host.endsWith(".local") || host.endsWith(".localhost")) return true;

	const ipv = net.isIP(host);
	if (ipv === 4) return isPrivateIPv4(host);
	if (ipv === 6) return isPrivateIPv6(host);

	return false;
}

function normalizeOrigin(str) {
	try {
		return new URL(str).origin.toLowerCase();
	} catch {
		return "";
	}
}

/**
 * Parse the BOBBIT_TRUSTED_NO_TIMEOUT_ORIGINS env var.
 * Comma-separated origins, case-insensitive, URL.origin normalisation.
 */
function parseTrustedOrigins(envValue) {
	if (!envValue) return new Set();
	const out = new Set();
	for (const raw of String(envValue).split(",")) {
		const t = raw.trim();
		if (!t) continue;
		const norm = normalizeOrigin(t);
		if (norm) out.add(norm);
	}
	return out;
}

/**
 * Match the given origin against the BOBBIT_TRUSTED_NO_TIMEOUT_ORIGINS env var.
 * Reads the env var on every call so tests can mutate process.env freely.
 */
function isTrustedNoTimeout(originStr) {
	const trusted = parseTrustedOrigins(process.env.BOBBIT_TRUSTED_NO_TIMEOUT_ORIGINS || "");
	if (trusted.size === 0) return false;
	const norm = normalizeOrigin(originStr);
	if (!norm) return false;
	return trusted.has(norm);
}

// ── Dispatcher wrapper ─────────────────────────────────────────────────

/**
 * Lazily require undici. Resolves from the agent subprocess's node_modules
 * (in-container: /node_modules/undici; host: bobbit's own node_modules).
 * Failure is non-fatal — the preload simply no-ops, preserving the agent's
 * existing behaviour.
 */
let undici = null;
let undiciLoadError = null;
try {
	undici = require("undici");
} catch (err) {
	undiciLoadError = err;
}

class IdleTimeoutDispatcher {
	constructor(inner, bodyMsArg, headersMsArg) {
		this.inner = inner;
		this.bodyMs = bodyMsArg;
		this.headersMs = headersMsArg;
	}

	dispatch(opts, handler) {
		try {
			const originStr = opts && opts.origin != null ? String(opts.origin) : "";
			if (originStr && !isLocalOrigin(originStr) && !isTrustedNoTimeout(originStr)) {
				const next = Object.assign({}, opts);
				// Only overwrite when caller didn't provide a positive value.
				if (!next.bodyTimeout || next.bodyTimeout <= 0) next.bodyTimeout = this.bodyMs;
				if (!next.headersTimeout || next.headersTimeout <= 0) next.headersTimeout = this.headersMs;
				return this.inner.dispatch(next, handler);
			}
		} catch {
			// Fall through to forwarding the original opts unchanged.
		}
		return this.inner.dispatch(opts, handler);
	}

	close(...args) {
		if (typeof this.inner.close === "function") return this.inner.close(...args);
		return Promise.resolve();
	}

	destroy(...args) {
		if (typeof this.inner.destroy === "function") return this.inner.destroy(...args);
		return Promise.resolve();
	}

	// Forward optional Dispatcher hooks if the inner implements them.
	// pi-coding-agent's EnvHttpProxyAgent inherits these from undici.Dispatcher
	// and they ultimately route through dispatch(), but forward defensively
	// in case anything calls them directly.
	compose(...args) {
		if (typeof this.inner.compose === "function") return this.inner.compose(...args);
		return undefined;
	}

	on(...args) { if (typeof this.inner.on === "function") this.inner.on(...args); return this; }
	once(...args) { if (typeof this.inner.once === "function") this.inner.once(...args); return this; }
	off(...args) { if (typeof this.inner.off === "function") this.inner.off(...args); return this; }
	removeListener(...args) { if (typeof this.inner.removeListener === "function") this.inner.removeListener(...args); return this; }
	emit(...args) { if (typeof this.inner.emit === "function") return this.inner.emit(...args); return false; }
}

function wrapWithIdleTimeouts(dispatcher) {
	if (!dispatcher) return dispatcher;
	if (dispatcher instanceof IdleTimeoutDispatcher) return dispatcher;
	return new IdleTimeoutDispatcher(dispatcher, bodyMs, headersMs);
}

// ── Install monkey-patch ───────────────────────────────────────────────

if (undici && typeof undici.setGlobalDispatcher === "function") {
	const origSet = undici.setGlobalDispatcher.bind(undici);
	undici.setGlobalDispatcher = function patchedSetGlobalDispatcher(d) {
		return origSet(wrapWithIdleTimeouts(d));
	};

	// Defensive belt-and-braces: if some module already ran and installed a
	// dispatcher before this preload (shouldn't happen with --require, but
	// cheap insurance), re-install it through the wrapped setter so it gets
	// wrapped too.
	try {
		if (typeof undici.getGlobalDispatcher === "function") {
			const cur = undici.getGlobalDispatcher();
			if (cur && !(cur instanceof IdleTimeoutDispatcher)) {
				undici.setGlobalDispatcher(cur);
			}
		}
	} catch {
		// Non-fatal — pi-coding-agent's setGlobalDispatcher call will still trip
		// the wrapped setter.
	}
} else if (undiciLoadError) {
	// Best-effort diagnostic to stderr; do not crash the agent process.
	try {
		process.stderr.write(
			`[bobbit-preload] undici unavailable — idle-stream timeouts will not be enforced: ${undiciLoadError.message}\n`,
		);
	} catch { /* ignore */ }
}

module.exports = {
	isLocalOrigin,
	isTrustedNoTimeout,
	IdleTimeoutDispatcher,
	wrapWithIdleTimeouts,
	// Exposed for tests / diagnostics.
	_bodyMs: bodyMs,
	_headersMs: headersMs,
};
