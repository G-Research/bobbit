/**
 * Marketplace MVP — shared git-URL credential redaction.
 *
 * Extracted into its own module so every code path that surfaces or logs a git
 * URL (the source registry's DTOs/labels, provenance records, AND sync-error
 * messages) redacts identically. Sync errors previously used only
 * `stripTokenFromGitUrl` (userinfo only), so a `?token=`/`#token=` credential
 * could leak into `lastSyncError`; routing every path through `redactGitUrl`
 * closes that gap.
 */

import { stripTokenFromGitUrl } from "../skills/git.js";

/**
 * Query-param / fragment keys that may carry a credential and must be redacted
 * from any surfaced/logged git URL (case-insensitive).
 */
export const SENSITIVE_URL_KEYS = /^(?:token|access_token|private_token|personal_access_token|oauth_token|api[_-]?key|key|auth|authorization|password|passwd|secret)$/i;

/**
 * Fully redact credentials from a git URL for display/logging:
 *  - userinfo (`user:token@host`) via the shared `stripTokenFromGitUrl` helper;
 *  - sensitive query-string params (`?token=…`, `?access_token=…`, …);
 *  - a fragment that carries a token assignment (`#access_token=…`).
 * Non-URL forms (scp-like `git@host:path`, local paths) are returned unchanged.
 */
export function redactGitUrl(url: string): string {
	const stripped = stripTokenFromGitUrl(url);
	let parsed: URL;
	try {
		parsed = new URL(stripped);
	} catch {
		return stripped; // not a parseable URL (ssh shorthand / local path)
	}
	let changed = false;
	for (const key of [...parsed.searchParams.keys()]) {
		if (SENSITIVE_URL_KEYS.test(key)) {
			parsed.searchParams.delete(key);
			changed = true;
		}
	}
	// Fragments are meaningless to git remotes; drop one that looks like it
	// smuggles a credential (`#token=…`, `#access_token=…`, …).
	if (parsed.hash) {
		const frag = parsed.hash.replace(/^#/, "");
		const fragKey = frag.split("=")[0];
		if (SENSITIVE_URL_KEYS.test(fragKey)) {
			parsed.hash = "";
			changed = true;
		}
	}
	return changed ? parsed.toString() : stripped;
}

/**
 * Secret substrings embedded in a git url: the userinfo password/token, and the
 * values of sensitive query-string params / a sensitive fragment assignment.
 * Both the raw and percent-decoded forms are returned so a value can be matched
 * however it happens to appear in a tool's output.
 */
export function gitUrlSecrets(url: string): string[] {
	const secrets = new Set<string>();
	const add = (v: string | undefined): void => {
		if (!v) return;
		secrets.add(v);
		try { secrets.add(decodeURIComponent(v)); } catch { /* malformed escape — keep raw only */ }
	};
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return [];
	}
	add(parsed.password);
	for (const [key, value] of parsed.searchParams.entries()) {
		if (SENSITIVE_URL_KEYS.test(key)) add(value);
	}
	if (parsed.hash) {
		const frag = parsed.hash.replace(/^#/, "");
		const eq = frag.indexOf("=");
		if (eq > 0 && SENSITIVE_URL_KEYS.test(frag.slice(0, eq))) add(frag.slice(eq + 1));
	}
	return [...secrets].filter((s) => s.length > 0);
}

/**
 * Redact a git url AND any secret substrings it carries from a free-text
 * message (e.g. a git stderr). git rewrites the url form in its error output
 * (drops the scheme, moves the query into the path, etc.), so replacing only
 * the exact url string is not enough — the raw token value must also be scrubbed
 * wherever it surfaces. Used to sanitise sync errors before they reach
 * `lastSyncError`.
 */
export function redactGitUrlInText(text: string, url: string): string {
	if (!url) return text;
	let out = text.split(url).join(redactGitUrl(url));
	for (const secret of gitUrlSecrets(url)) {
		out = out.split(secret).join("***");
	}
	return out;
}
