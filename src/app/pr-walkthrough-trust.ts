// src/app/pr-walkthrough-trust.ts
//
// CLIENT trust-prompt for PR-walkthrough launches against a NON-default GitHub
// remote host (design docs/design/pr-walkthrough-gh-posting.md §4b.3). This module
// is LAZY-imported by `pack-entrypoints.ts::runSpawnLauncher` ONLY when the pack
// `run` route returns `HOST_NOT_TRUSTED`, so non-walkthrough packs never load it.
//
// The server-side, prefs-backed `assertTrustedBindingTarget` remains the REAL gate
// (the confined worker cannot read prefs). This module is a UX affordance that
// persists the user's decision to the same `githubTrustedHosts` preference the
// Settings page manages (`PUT /api/preferences`), then lets the launch re-invoke
// `run` with a `trustedHostAck` so the reviewer child is spawned.
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
 * Returns `true` when `host` is trusted — already (the default baseline or in the
 * managed list) or after the user accepts the prompt AND the host is persisted;
 * `false` when the user declines or `host` is not a valid bare hostname.
 *
 * Persistence contract (design [medium] fix): a PUT failure/error aborts (returns
 * `false`); a readback failure AFTER a successful PUT does NOT abort — the host is
 * already persisted, so trust the PUT and return `true`.
 */
export async function ensureGithubHostTrusted(host: string, deps?: EnsureGithubHostTrustedDeps): Promise<boolean> {
	const fetch = deps?.fetch ?? gatewayFetch;
	const confirm = deps?.confirm ?? confirmAction;
	const normalized = normalizeTrustedHost(host);
	if (!normalized) return false;
	// Default baseline hosts (github.com / www.github.com) are always trusted — never
	// prompt or touch the network for them.
	if (isTrustedExternalHost(normalized, [])) return true;

	// Current managed list (authoritative server copy). A read failure falls through
	// to the prompt — we never silently trust an unknown host on a transient error.
	let managed: string[] = [];
	try {
		const res = await fetch("/api/preferences");
		if (res.ok) managed = normalizeTrustedHosts((await res.json()).githubTrustedHosts);
	} catch { /* fall through — prompt anyway */ }
	if (isTrustedExternalHost(normalized, managed)) return true; // baseline or already trusted

	const ok = await confirm(
		"Trust this domain?",
		`Add \u201c${normalized}\u201d to your trusted GitHub hosts so this walkthrough can read and post to its pull requests? You can remove it later in Settings.`,
		"Trust domain",
	);
	if (!ok) return false;

	const next = normalizeTrustedHosts([...managed, normalized]);
	// The PUT is the persist step — only a PUT failure/error aborts.
	try {
		const put = await fetch("/api/preferences", { method: "PUT", body: JSON.stringify({ githubTrustedHosts: next }) });
		if (!put.ok) return false;
	} catch { return false; }
	// Best-effort readback to catch a server-side normalize drop; on a readback error
	// the PUT already succeeded, so trust it.
	try {
		const res = await fetch("/api/preferences");
		if (res.ok) return isTrustedExternalHost(normalized, normalizeTrustedHosts((await res.json()).githubTrustedHosts));
	} catch { /* readback failed but PUT succeeded */ }
	return true;
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
