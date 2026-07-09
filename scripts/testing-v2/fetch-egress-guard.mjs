/**
 * fetch-egress-guard.mjs — external-service-free verification probe (task 7862db76).
 *
 * Preloaded into EVERY node process of an e2e:v2 run via
 *   NODE_OPTIONS="--import <this file>"
 * so it covers the in-process gateway (same process as the Playwright worker),
 * the node relocate specs, and any node child (npm/npx, bg-runner helper, …).
 *
 * It wraps globalThis.fetch AND node:http/node:https request/get and records any
 * outbound request whose host is NOT loopback/link-local/private to
 * $EGRESS_LOG (JSONL, append). Loopback-only is the external-free contract: the
 * test gateway binds 127.0.0.1, agent callbacks use loopback, and the in-process
 * MOCK bridge means agent turns never hit a real LLM. A non-empty log ⇒ a spec
 * reached a real external service (LLM / GitHub / npm registry / DNS-update / …)
 * and must be flagged.
 *
 * NON-BLOCKING by default (records only) so it never changes pass/fail — the
 * point is to observe, not to alter the suite. Set EGRESS_GUARD_THROW=1 to make
 * it fail-closed instead.
 */
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { appendFileSync } from "node:fs";

const LOG = process.env.EGRESS_LOG || null;
const THROW = process.env.EGRESS_GUARD_THROW === "1";

/** Loopback / link-local / RFC1918 private / CGNAT — i.e. never a real external service. */
function isLocalHost(host) {
	if (!host) return true; // no host ⇒ unix socket / same-process; treat as local
	let h = String(host).trim().toLowerCase();
	// strip brackets from IPv6 literals and any zone id
	h = h.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
	if (h === "localhost" || h.endsWith(".localhost")) return true;
	if (h === "::1" || h === "::" || h === "0.0.0.0") return true;
	if (h.startsWith("::ffff:")) h = h.slice("::ffff:".length); // IPv4-mapped IPv6
	const v4 = net.isIPv4(h) ? h : null;
	if (v4) {
		const [a, b] = v4.split(".").map(Number);
		if (a === 127) return true;                    // loopback
		if (a === 10) return true;                      // private
		if (a === 192 && b === 168) return true;        // private
		if (a === 172 && b >= 16 && b <= 31) return true; // private
		if (a === 169 && b === 254) return true;        // link-local
		if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (NordLynx mesh etc.)
		return false;
	}
	if (net.isIPv6(h)) {
		if (h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd")) return true; // link-local / ULA
		return false;
	}
	// A bare hostname (not an IP): the gateway never uses hostnames for local
	// callbacks, so any real hostname here (api.github.com, registry.npmjs.org,
	// api.anthropic.com, …) is by definition an external service.
	return false;
}

function record(kind, host, port, detail) {
	if (isLocalHost(host)) return;
	const entry = {
		kind,
		host: String(host || ""),
		port: port ?? null,
		detail: detail ? String(detail).slice(0, 300) : undefined,
		pid: process.pid,
		argv2: process.argv[2] ? String(process.argv[2]).slice(-80) : undefined,
		at: new Date().toISOString(),
	};
	const line = JSON.stringify(entry);
	if (LOG) { try { appendFileSync(LOG, line + "\n"); } catch { /* best-effort */ } }
	else console.error("[egress-guard] EXTERNAL:", line);
	if (THROW) throw new Error(`[egress-guard] blocked external ${kind} to ${host}:${port}`);
}

// ── globalThis.fetch (undici) ─────────────────────────────────────────
if (typeof globalThis.fetch === "function") {
	const realFetch = globalThis.fetch;
	globalThis.fetch = function guardedFetch(input, init) {
		try {
			const urlStr = typeof input === "string" ? input : (input?.url ?? String(input));
			const u = new URL(urlStr);
			record("fetch", u.hostname, u.port || (u.protocol === "https:" ? 443 : 80), u.href);
		} catch { /* unparseable ⇒ ignore */ }
		return realFetch.call(this, input, init);
	};
}

// ── node:http / node:https request+get ───────────────────────────────
function wrap(mod, name, defaultPort) {
	const realRequest = mod.request;
	const realGet = mod.get;
	function hostOf(args) {
		try {
			if (typeof args[0] === "string") { const u = new URL(args[0]); return [u.hostname, u.port || defaultPort, u.href]; }
			if (args[0] instanceof URL) return [args[0].hostname, args[0].port || defaultPort, args[0].href];
			if (args[0] && typeof args[0] === "object") {
				const o = args[0];
				return [o.hostname || o.host || "", o.port || defaultPort, o.path || ""];
			}
		} catch { /* ignore */ }
		return ["", defaultPort, ""];
	}
	mod.request = function guardedRequest(...args) {
		const [h, p, d] = hostOf(args);
		record(`${name}.request`, h, p, d);
		return realRequest.apply(this, args);
	};
	mod.get = function guardedGet(...args) {
		const [h, p, d] = hostOf(args);
		record(`${name}.get`, h, p, d);
		return realGet.apply(this, args);
	};
}
wrap(http, "http", 80);
wrap(https, "https", 443);
