// src/app/pr-walkthrough-trust.ts
//
// CLIENT trust-prompt for PR-walkthrough launches against a NON-default GitHub
// remote host (design docs/design/pr-walkthrough-gh-posting.md §4b.3). This module
// is LAZY-imported by `pack-entrypoints.ts::runSpawnLauncher` ONLY when the pack
// `run` route returns `HOST_NOT_TRUSTED`, so non-walkthrough packs never load it.
//
// The server-side effective-host resolver remains the REAL gate (the confined
// worker cannot read gateway trust state). This module asks that same resolver
// whether the host is already trusted. Only an unknown host reaches the prompt;
// acceptance persists the decision to the `githubTrustedHosts` preference and
// lets the launch re-invoke `run` with a `trustedHostAck`.
//
// Node-safe at import time: it imports the dependency-free `gatewayFetch` and the
// type-only/lazy `dialogs-lazy` wrapper — neither touches the DOM until CALLED —
// so the unit tests can import + drive it with injected seams (`deps`).

import { normalizeTrustedHost, normalizeTrustedHosts, isTrustedExternalHost } from "../shared/pr-walkthrough/url-safety.js";
import { gatewayFetch } from "./gateway-fetch.js";
import { confirmAction } from "./dialogs-lazy.js";

/** Injectable seams so the (node) unit tests can drive the flow without the DOM
 *  confirm dialog or a live gateway. Production callers omit `deps`. */
export interface EnsureGithubHostTrustedDeps {
	fetch?: typeof gatewayFetch;
	confirm?: (title: string, message: string, confirmLabel?: string) => Promise<boolean>;
}

/**
 * Returns `true` when `host` is trusted by the server's effective-host decision,
 * or after the user accepts the prompt and the host is persisted. A false or
 * unavailable server decision fails closed to the existing prompt flow.
 */
export async function ensureGithubHostTrusted(host: string, deps?: EnsureGithubHostTrustedDeps): Promise<boolean> {
	const request = deps?.fetch ?? gatewayFetch;
	const confirm = deps?.confirm ?? confirmAction;
	const normalized = normalizeTrustedHost(host);
	if (!normalized) return false;
	// Baseline hosts are immutable server trust and need no round trip.
	if (isTrustedExternalHost(normalized, [])) return true;

	// This boolean endpoint is the client trust source of truth. It includes hosts
	// discovered from token-free gh configuration as well as managed preferences.
	// Malformed responses and lookup failures must never silently authorize a host.
	try {
		const res = await request(`/api/github/trusted-hosts/check?host=${encodeURIComponent(normalized)}`);
		if (res.ok && (await res.json())?.trusted === true) return true;
	} catch { /* fail closed to prompt */ }

	// Read preferences only to preserve existing managed entries if the user accepts;
	// do not use this client-side list as a second trust authority.
	let managed: string[] = [];
	try {
		const res = await request("/api/preferences");
		if (res.ok) managed = normalizeTrustedHosts((await res.json()).githubTrustedHosts);
	} catch { /* prompt with an empty append base; the server normalizes the PUT */ }

	const ok = await confirm(
		"Trust this domain?",
		`Add \u201c${normalized}\u201d to your trusted GitHub hosts so this walkthrough can read and post to its pull requests? You can remove it later in Settings.`,
		"Trust domain",
	);
	if (!ok) return false;

	const next = normalizeTrustedHosts([...managed, normalized]);
	try {
		const put = await request("/api/preferences", { method: "PUT", body: JSON.stringify({ githubTrustedHosts: next }) });
		return put.ok;
	} catch {
		return false;
	}
}

/** The subset of a spawn `run` route result the trust flow reads/returns. */
export interface SpawnRouteOutcome {
	ok?: boolean;
	childSessionId?: string;
	error?: string;
	code?: string;
	host?: string;
	prUrl?: string;
}

export interface CallSpawnRouteWithTrustOptions {
	route: string;
	body: Record<string, unknown>;
	/** The FIRST `run` result (already dispatched by the caller). */
	first: SpawnRouteOutcome | undefined;
	/** The pack-scoped route dispatcher (bound to the owning session's Host API). */
	callRoute: (route: string, init: { method: "POST"; body: Record<string, unknown> }) => Promise<SpawnRouteOutcome | undefined>;
	/** Test seam — defaults to {@link ensureGithubHostTrusted}. */
	ensureTrusted?: (host: string) => Promise<boolean>;
}

/**
 * Handle a `HOST_NOT_TRUSTED` result from a spawn `run` route: prompt to trust the
 * resolved host, persist it, and re-invoke `callRoute` EXACTLY ONCE with
 * `trustedHostAck` + the resolved `prUrl` (so the server short-circuits a second
 * `gh pr view`). When `first` is not `HOST_NOT_TRUSTED` (or carries no host) it is
 * returned unchanged. On decline, returns `{ cancelledHost }` and does NOT
 * re-invoke — nothing is spawned.
 */
export async function callSpawnRouteWithTrust(
	opts: CallSpawnRouteWithTrustOptions,
): Promise<{ res?: SpawnRouteOutcome; cancelledHost?: string }> {
	const first = opts.first;
	if (!first || first.code !== "HOST_NOT_TRUSTED" || typeof first.host !== "string") {
		return { res: first };
	}
	const host = first.host;
	const ensure = opts.ensureTrusted ?? ensureGithubHostTrusted;
	const trusted = await ensure(host);
	if (!trusted) return { cancelledHost: host };
	const res = await opts.callRoute(opts.route, {
		method: "POST",
		body: {
			...opts.body,
			...(typeof first.prUrl === "string" ? { prUrl: first.prUrl } : {}),
			trustedHostAck: host,
		},
	});
	return { res };
}
