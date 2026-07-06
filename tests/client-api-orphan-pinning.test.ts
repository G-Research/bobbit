/**
 * Pinning test — Finding W2.F (systemic merge-integrity countermeasure).
 *
 * BACKGROUND: forensic review of tonight's three integration merges
 * (b687d93d, eef210f3, a34f27e6) found at least 6 shipped features where the
 * SERVER route silently vanished during a merge while the CLIENT caller and
 * its TESTS survived as orphans — e.g. `src/app/settings-page.ts` still
 * calling `/api/claude-code/status` after the route was dropped, and
 * `tests/e2e/pack-runtimes-api.spec.ts` still exercising `/api/pack-runtimes`
 * with no server route left to hit. In every case the client side (and its
 * test coverage) kept "working" right up until a real request 404'd — no
 * build error, no type error, just a silent runtime break discovered late.
 *
 * This test is the durable countermeasure: it extracts every `/api/...`
 * path literally referenced from CLIENT code (`src/app/`, `src/ui/`) and
 * asserts each one resolves against the server's actual route surface
 * (`src/server/server.ts` + the delegate route modules it calls into — see
 * tests/helpers/server-route-surface.ts). If a future integration merge
 * drops a server route out from under a live client caller, this test goes
 * red immediately instead of waiting for a user to hit the 404.
 *
 * SCOPE — CLIENT CODE ONLY, not test files: an early prototype of this test
 * also scanned `tests/**` for `/api/...` literals and found ~638 unique
 * strings with ~268 "orphans" — the overwhelming majority were prose inside
 * `describe(...)`/`it(...)` test-description strings (e.g. a test titled
 * `"/api/goals — data-only child auto-start"`) or intentionally-bogus paths
 * used to assert 404s, not real client calls. That signal-to-noise ratio
 * makes a test-file burn-down list unworkable without a much smarter
 * "is this actually a fetch call" extractor. Scoping to `src/app/`/`src/ui/`
 * avoids that noise entirely — every literal found there is, in practice, a
 * real endpoint reference (route-building helper, fetch call, or
 * EventSource URL), not test prose.
 *
 * METHOD-BLIND BY DESIGN: unlike tests/prompt-api-drift.test.ts (method-aware
 * because prompt text always states a method, e.g. "GET /api/foo"), client
 * call sites don't reliably state their HTTP method next to the path
 * (`gatewayFetch(path, init)` — `init.method` is a separate, often-omitted
 * argument). This test only asserts the PATH resolves to some route,
 * regardless of method — which is the exact shape of the incident it guards
 * against (the whole route family vanishing), not method-level drift.
 *
 * EXTRACTION APPROACH: a small hand-rolled tokenizer (not a single regex)
 * walks each (comment-stripped) client file character-by-character to find
 * every backtick template literal and quoted string containing "/api/",
 * handling `${...}` interpolation per this codebase's conventions:
 *   - `${expr}` immediately preceded by `/` → a path param → normalized to
 *     the digit "0" (chosen over a letter so it also satisfies server
 *     routes matched by a `(\d+)` regex group, e.g. the tool-content
 *     endpoint's message/block indices — a letter placeholder would have
 *     failed that regex and misreported a live route as an orphan).
 *   - `${expr}` NOT preceded by `/`, before "/api/" has appeared in the
 *     literal yet → a base-URL prefix (e.g. `` `${window.location.origin}/api/health` ``)
 *     → dropped, scanning continues into the literal path after it.
 *   - `${expr}` NOT preceded by `/`, AFTER "/api/" has appeared → a dynamic
 *     query-string/suffix per this codebase's `${qs}` / `${suffix}`
 *     convention (e.g. `` `/api/search/stats${qs}` ``) → truncates the
 *     literal there; everything after is dropped rather than guessed at.
 * A naive single alternation regex over the whole file was tried first and
 * rejected: an escaped backtick or a nested template literal elsewhere in a
 * large file (e.g. `` `${qs ? `?${qs}` : ""}` `` in src/app/api.ts) desyncs
 * a global-regex scan, silently swallowing unrelated literals between the
 * mismatched delimiters. The tokenizer above parses nesting properly instead.
 *
 * See tests/helpers/server-route-surface.ts for what this test found (and
 * fixed) in the *server*-side extractor while validating this test's
 * results: single-quoted route matchers, multi-line `.match(...)` calls, and
 * whole delegate route modules that server.ts calls into — all previously
 * unhandled, all of which would have produced false-positive "orphans" here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, getServerRoutes, isRouted } from "./helpers/server-route-surface.ts";

const CLIENT_DIRS = ["src/app", "src/ui"];

// ── 1. Extract every `/api/...` literal referenced from client code ──

function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function listClientFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listClientFiles(p));
		else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) out.push(p);
	}
	return out;
}

type TemplateExpr = { start: number; end: number };

/**
 * Find the end of a backtick template literal starting at `src[start] === '`'`.
 * Handles `${...}` interpolations — including nested template literals
 * inside them — by recursing, so a nested backtick can never be mistaken
 * for the outer literal's closing delimiter. Returns the closing backtick's
 * index (-1 if unterminated) and the top-level `${...}` spans.
 */
function findTemplateSpan(src: string, start: number): { end: number; exprs: TemplateExpr[] } {
	let i = start + 1;
	const exprs: TemplateExpr[] = [];
	while (i < src.length) {
		const c = src[i];
		if (c === "\\") { i += 2; continue; }
		if (c === "`") return { end: i, exprs };
		if (c === "$" && src[i + 1] === "{") {
			const exprStart = i;
			i += 2;
			let depth = 1;
			while (i < src.length && depth > 0) {
				const cc = src[i];
				if (cc === "\\") { i += 2; continue; }
				if (cc === "`") {
					const nested = findTemplateSpan(src, i);
					i = nested.end === -1 ? src.length : nested.end + 1;
					continue;
				}
				if (cc === "{") depth++;
				else if (cc === "}") depth--;
				i++;
			}
			exprs.push({ start: exprStart, end: i });
			continue;
		}
		i++;
	}
	return { end: -1, exprs };
}

/** See module-header EXTRACTION APPROACH for the three interpolation cases handled here. */
function normalizeTemplateLiteral(src: string, contentStart: number, contentEnd: number, exprs: TemplateExpr[]): string {
	let out = "";
	let cursor = contentStart;
	for (const e of exprs) {
		const precedingChar = src[e.start - 1];
		out += src.slice(cursor, e.start);
		if (precedingChar === "/") {
			out += "0"; // path-param placeholder — digit so `(\d+)`-style server regexes still match
			cursor = e.end;
		} else if (!out.includes("/api/")) {
			cursor = e.end; // base-URL prefix before the path proper — drop it, keep scanning
		} else {
			return out; // dynamic query-string/suffix convention — truncate here
		}
	}
	out += src.slice(cursor, contentEnd);
	return out;
}

/** Find the end of a `"..."` / `'...'` literal starting at `src[start] === quoteChar`, honoring backslash escapes. */
function findQuotedSpan(src: string, start: number, quoteChar: string): number {
	let i = start + 1;
	while (i < src.length) {
		const c = src[i];
		if (c === "\\") { i += 2; continue; }
		if (c === quoteChar) return i;
		i++;
	}
	return -1;
}

/** Every string/template literal in a (comment-stripped) source file that contains "/api/", already normalized to a path-shaped string (or null if normalization couldn't locate "/api/" — see toConcretePath). */
function extractApiLiterals(src: string): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (c === "`") {
			const { end, exprs } = findTemplateSpan(src, i);
			if (end === -1) break; // unterminated — malformed source, not our concern here
			const raw = src.slice(i + 1, end);
			if (raw.includes("/api/")) out.push(normalizeTemplateLiteral(src, i + 1, end, exprs));
			i = end + 1;
			continue;
		}
		if (c === '"' || c === "'") {
			const end = findQuotedSpan(src, i, c);
			if (end === -1) { i++; continue; }
			const raw = src.slice(i + 1, end);
			if (raw.includes("/api/")) out.push(raw);
			i = end + 1;
			continue;
		}
		i++;
	}
	return out;
}

/** Trim to the concrete request path: from "/api/" to the first "?" (query string) or trailing punctuation that isn't part of the path. */
function toConcretePath(literal: string): string | null {
	const idx = literal.indexOf("/api/");
	if (idx === -1) return null; // e.g. the whole literal was consumed as a base-URL prefix before "/api/" appeared
	let rest = literal.slice(idx);
	const qIdx = rest.indexOf("?");
	if (qIdx !== -1) rest = rest.slice(0, qIdx);
	return rest.replace(/[).,;]+$/, "");
}

type ClientReference = { path: string; files: string[] };

function collectClientReferences(): ClientReference[] {
	const found = new Map<string, Set<string>>();
	for (const dir of CLIENT_DIRS) {
		for (const file of listClientFiles(path.join(REPO_ROOT, dir))) {
			const src = stripComments(fs.readFileSync(file, "utf8"));
			for (const literal of extractApiLiterals(src)) {
				const p = toConcretePath(literal);
				if (p === null) continue;
				const rel = path.relative(REPO_ROOT, file);
				if (!found.has(p)) found.set(p, new Set());
				found.get(p)!.add(rel);
			}
		}
	}
	return [...found.entries()]
		.map(([p, files]) => ({ path: p, files: [...files].sort() }))
		.sort((a, b) => a.path.localeCompare(b.path));
}

// ── 2. False-positive allowlist — non-endpoint or structurally-ambiguous strings ──

/**
 * `config-scope.ts`'s `customizeItem`/`revertOverride` helpers take a
 * `type: "roles" | "workflows" | "tools"` parameter and build
 * `` `/api/${type}/${name}/customize` `` / `.../override` generically. The
 * resource-TYPE segment itself is interpolated (immediately after "/api/",
 * so this test's placeholder rule treats it as a path param → "0"),
 * producing the unrouteable "/api/0/0/customize" shape. The three real
 * concrete routes all exist server-side as per-resource-type regexes (not a
 * generic wildcard) — verified directly:
 *   - /api/roles/:name/customize|override     — server.ts:9427, :9456
 *   - /api/tools/:name/customize|override     — src/server/routes/tools-routes.ts
 *   - /api/workflows/:name/customize|override — server.ts:13718, :13739
 * Allowlisted rather than special-cased because resolving the finite
 * `type` union at the call site would require real type-flow analysis,
 * disproportionate for two call sites.
 */
/**
 * `src/app/pi-ai-lazy.ts` dynamically imports pi-ai 0.80's per-API lazy
 * stream factories, e.g. `import("@earendil-works/pi-ai/api/anthropic-messages.lazy")`.
 * The extractor's tokenizer has no concept of `import()` vs `fetch()` — it
 * flags any quoted literal containing "/api/", so these npm subpath
 * specifiers get misread as server route paths ("/api/anthropic-messages.lazy"
 * etc.) once the "/api/" prefix inside the specifier is sliced off. They are
 * not HTTP routes at all — verified against src/app/pi-ai-lazy.ts's 8
 * `case "..."` branches (one per pi-ai API id).
 */
const ALLOWLIST = new Set<string>([
	"/api/0/0/customize",
	"/api/0/0/override",
	"/api/anthropic-messages.lazy",
	"/api/azure-openai-responses.lazy",
	"/api/google-generative-ai.lazy",
	"/api/google-vertex.lazy",
	"/api/mistral-conversations.lazy",
	"/api/openai-codex-responses.lazy",
	"/api/openai-completions.lazy",
	"/api/openai-responses.lazy",
]);

// ── 3. Known-missing burn-down list — real orphans pending restoration on open PRs ──

/**
 * Real, currently-orphaned client-referenced paths. Each entry is removed
 * the moment its route is restored (test below asserts a listed entry must
 * STILL be unrouted — this makes the list self-cleaning: forget to remove a
 * restored entry and the test fails, forcing the update).
 *
 * Burn-down history (proof the discipline works): the list originally also
 * carried `/api/claude-code/status`, `/api/claude-code/status/refresh`, and
 * `/api/preferences/claude-code/confirmation` (the W2 forensic finding's
 * headline orphans). Their restoring PRs (#16/#18) merged into aj-current
 * mid-flight — and this test's burn-down assertion failed on rebase exactly
 * as designed, forcing their removal here. `/api/sessions/0/notify`
 * (W2.G(a) — src/app/api.ts's `notifyProposalDecision()`) was the next entry;
 * its restoring PR added the missing `POST /api/sessions/:id/notify` route
 * to server.ts, so it's removed here too.
 *
 * `/api/pack-runtimes` and its `/:id/start|stop|restart|logs|capabilities|down`
 * family (restoration W2.E) needed NO burn-down entry: the server route family
 * and the client call sites (src/app/api.ts's `listPackRuntimes`,
 * `startPackRuntime`, `stopPackRuntime`, `getPackRuntimeLogs`,
 * `getPackRuntimeCapabilities`, `downPackRuntime`, `purgePackRuntime`) were
 * restored together in the same PR, so this test never observed an orphaned
 * state for them.
 */
const KNOWN_ORPHANS: string[] = [];

// ── 4. Assertions ──

const clientRefs = collectClientReferences();
const serverRoutes = getServerRoutes();

describe("client-referenced API endpoints are not orphaned (Finding W2.F)", () => {
	it("found a substantial number of client /api/ references (sanity — extraction isn't silently matching nothing)", () => {
		assert.ok(
			clientRefs.length >= 100,
			`expected 100+ unique /api/ path references across ${CLIENT_DIRS.join(", ")}, found ${clientRefs.length}`,
		);
	});

	it("found a substantial number of server routes (sanity — shared extractor isn't broken)", () => {
		assert.ok(serverRoutes.length >= 200, `expected 200+ server routes (incl. delegate modules), found ${serverRoutes.length}`);
	});

	it("every KNOWN_ORPHANS entry is a real client reference (list hygiene — no stale/typo'd entries)", () => {
		const refPaths = new Set(clientRefs.map((r) => r.path));
		const stale = KNOWN_ORPHANS.filter((p) => !refPaths.has(p));
		assert.equal(
			stale.length,
			0,
			`KNOWN_ORPHANS entries no longer referenced by any client file (remove them): ${stale.join(", ")}`,
		);
	});

	it("every KNOWN_ORPHANS entry is still actually orphaned (burn-down discipline — restored routes must be removed from the list)", () => {
		const prematurelyFixed = KNOWN_ORPHANS.filter((p) => isRouted(null, p, serverRoutes).ok);
		assert.equal(
			prematurelyFixed.length,
			0,
			`These KNOWN_ORPHANS routes now resolve server-side — remove them from the list (burn-down complete for): ${prematurelyFixed.join(", ")}`,
		);
	});

	it("every client-referenced /api/ path resolves to a real server route (or is an allowlisted false-positive, or a tracked KNOWN_ORPHANS entry)", () => {
		const knownOrphanSet = new Set(KNOWN_ORPHANS);
		const newOrphans: string[] = [];
		for (const ref of clientRefs) {
			if (ALLOWLIST.has(ref.path)) continue;
			if (knownOrphanSet.has(ref.path)) continue;
			const res = isRouted(null, ref.path, serverRoutes);
			if (!res.ok) {
				newOrphans.push(`  ${ref.path}  <=  ${ref.files.join(", ")} — ${res.reason}`);
			}
		}
		assert.equal(
			newOrphans.length,
			0,
			`${newOrphans.length} client-referenced /api/ path(s) have no matching server route and are NOT in KNOWN_ORPHANS:\n${newOrphans.join("\n")}\n\n` +
				`Either the server route was just dropped (this is the W2.F bug class — restore the route) or this is a ` +
				`genuinely new feature awaiting a server-side counterpart (add it to KNOWN_ORPHANS with a restoring-PR comment), ` +
				`or it's a false positive from the extraction heuristics (add it to ALLOWLIST with a justification comment).`,
		);
	});
});
