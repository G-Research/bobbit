/**
 * Shared server route-surface extractor.
 *
 * Scans `src/server/server.ts` (plus the delegate route modules it imports —
 * see DELEGATE_ROUTE_MODULES below) for its three route-matching idioms —
 * exact `url.pathname === "..."`, regex `url.pathname.match(/.../)`, and
 * prefix `url.pathname.startsWith("...")` — with best-effort HTTP-method
 * attribution, mirroring the source-pinning approach in
 * tests/tool-description-budget.test.ts.
 *
 * Originally written for tests/prompt-api-drift.test.ts (PR #12, since
 * merged to aj-current). Factored out here so
 * tests/client-api-orphan-pinning.test.ts can reuse the same extraction
 * logic without duplicating it. prompt-api-drift.test.ts still carries its
 * own inline copy; refactoring it to import from this module is a trivial
 * follow-up (intentionally not done on this branch to keep it
 * self-contained). Note this module's copy has diverged for the better —
 * single-quoted matchers, multi-line `.match()` calls, delegate route
 * modules (see comments below) — so that refactor should keep THIS version.
 *
 * DELEGATE MODULES: `handleApiRoute` in server.ts is not the only place
 * `url.pathname` gets matched against `/api/...` — it delegates to sibling
 * modules for whole route families (each imported and called conditionally
 * from within `handleApiRoute`). Discovered while building
 * tests/client-api-orphan-pinning.test.ts: scanning server.ts alone silently
 * dropped ~9 real, live goal routes (pause/resume/policy/mutations/etc. in
 * nested-goal-routes.ts), the side-panel-workspace routes, and the
 * PR-walkthrough routes — all real, none orphaned — which would have made
 * that test misreport them as new orphans. `grep -rl 'url\.pathname\.match(\|
 * url\.pathname === "\|url\.pathname\.startsWith('  src/server/` is how
 * these were found; re-run that if a future refactor adds another delegate.
 *
 * REGISTRY MODULES (STR-01, docs/design/route-registry.md): routes migrated
 * into the core route registry (src/server/routes/route-table.ts) don't use
 * ANY of the three idioms above — they're declared as data via
 * `table.register("METHOD", "pattern", handler)` calls in a dedicated route
 * module (e.g. src/server/routes/projects-routes.ts). Those calls are
 * scanned by `extractRegistryRoutes` below and merged into the same route
 * list; `:param` pattern segments compile to a "regex" ServerRoute (reusing
 * the existing regex matcher) so the rest of this module — and every
 * consumer of `getServerRoutes()` — needs no changes to understand them.
 * Add a new module here whenever a future cohort's routes are registered in
 * a new file (existing cohorts extend `projects-routes.ts` in place and need
 * no change here).
 */

import fs from "node:fs";
import path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
export const SERVER_SRC_PATH = path.join(REPO_ROOT, "src/server/server.ts");

/** Sibling modules that `handleApiRoute` delegates whole route families to (see DELEGATE MODULES above). */
export const DELEGATE_ROUTE_MODULE_PATHS = [
	"src/server/side-panel-workspace-routes.ts",
	"src/server/agent/nested-goal-routes.ts",
	"src/server/pr-walkthrough/routes.ts",
	// SWARM-W1: the fixed best-of-N REST surface (create/status/verify/confirm).
	"src/server/agent/swarm-routes.ts",
].map((rel) => path.join(REPO_ROOT, rel));

/** Modules that register core routes via `RouteTable.register(...)` (see REGISTRY MODULES above). */
export const REGISTRY_ROUTE_MODULE_PATHS = [
	// STR-01 cohort 1.
	"src/server/routes/projects-routes.ts",
	// STR-01 cohort 2 (per-project config family).
	"src/server/routes/project-config-routes.ts",
	// STR-01 cohort 3 (marketplace).
	"src/server/routes/marketplace-routes.ts",
	// STR-01 cohort 5 (staff inbox).
	"src/server/routes/staff-inbox-routes.ts",
	// STR-01 cohort 4 (pack-runtimes; server-scope project-config trio).
	"src/server/routes/pack-runtimes-routes.ts",
	"src/server/routes/project-config-server-routes.ts",
	// STR-01 cohort 6 (workflows; review-annotations).
	"src/server/routes/workflows-routes.ts",
	"src/server/routes/review-annotations-routes.ts",
	// STR-01 cohort 7 (session utility routes).
	"src/server/routes/session-utility-routes.ts",
	// STR-01 cohort 8 (maintenance + search-admin routes).
	"src/server/routes/maintenance-routes.ts",
	// STR-01 cohort 9 (server/system routes).
	"src/server/routes/server-system-routes.ts",
	// STR-01 cohort 10 (staff CRUD + MCP operator/internal-MCP routes).
	"src/server/routes/staff-mcp-operator-routes.ts",
	// STR-01 cohort 11 (OAuth account routes).
	"src/server/routes/oauth-account-routes.ts",
	// STR-01 cohort 12 (preferences routes).
	"src/server/routes/preferences-routes.ts",
	// STR-01 cohort 13 (config-directories routes).
	"src/server/routes/config-directories-routes.ts",
	// STR-05 route-handler hoist (roles routes).
	"src/server/routes/roles-routes.ts",
	// STR-01 cohort 14 (Add Project directory browser/create routes).
	"src/server/routes/directory-browser-routes.ts",
	// Skills write path (propose_skill acceptance, PR #195).
	"src/server/routes/skills-routes.ts",
	// STR-01 cohort 15 (model/provider settings routes).
	"src/server/routes/model-provider-routes.ts",
	// Wave 1 LSP product tools (docs/design/lsp-product-tools.md, F6).
	"src/server/routes/lsp-routes.ts",
	// STR-01 cohort 16a (cost endpoints).
	"src/server/routes/cost-routes.ts",
	// STR-01 cohort 16b (preview mount/artifact/SSE endpoints).
	"src/server/routes/preview-routes.ts",
	// STR-01 cohort 17 (editable proposal REST endpoints).
	"src/server/routes/session-proposal-routes.ts",
	// STR-01 cohort 18 (host configuration routes).
	"src/server/routes/host-config-routes.ts",
	// STR-01 cohort 19 (session control/provider-hook routes).
	"src/server/routes/session-control-routes.ts",
	// STR-01 cohort 20 (session discovery/read routes).
	"src/server/routes/session-discovery-routes.ts",
	// STR-01 cohort 21 (session mutation/lifecycle routes).
	"src/server/routes/session-mutation-routes.ts",
	// STR-01 cohort 22 (POST /api/sessions creation route).
	"src/server/routes/session-creation-routes.ts",
	// STR-01 cohort 23 (session git read/status routes).
	"src/server/routes/session-git-read-routes.ts",
	// STR-01 cohort 24 (session git write/PR mutation routes).
	"src/server/routes/session-git-write-routes.ts",
	// STR-01 cohort 25 (session content/readback routes).
	"src/server/routes/session-content-routes.ts",
].map((rel) => path.join(REPO_ROOT, rel));

/** Regex-literal body: escaped chars, character classes (which may contain unescaped `/`), or any non-slash/backslash char. */
const REGEX_LITERAL_BODY = String.raw`(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\])*`;

export type ServerRoute = {
	kind: "exact" | "prefix" | "regex";
	value: string | RegExp;
	/** HTTP methods this dispatch is gated on; null = could not attribute → treat as any (documented limitation). */
	methods: string[] | null;
	/** Extra same-statement pathname constraints (prefix routes only), e.g. `.endsWith("/review/annotations")`. */
	endsWith?: string[];
	includes?: string[];
};

/**
 * The single statement around `idx`: from the start of its line to the first
 * `;` or `{` that follows (multi-line `if (...)` conditions included), capped
 * at 400 chars. For `const x = ...;` assignments the `;` terminator matters —
 * without it the window would run past the assignment into the next line's
 * `if (...) {` and swallow a sibling statement.
 */
function statementWindow(src: string, idx: number): string {
	const lineStart = src.lastIndexOf("\n", idx) + 1;
	const brace = src.indexOf("{", idx);
	const semi = src.indexOf(";", idx);
	const candidates = [brace, semi].filter((i) => i !== -1 && i - lineStart <= 400);
	const lineEnd = src.indexOf("\n", idx);
	let end = candidates.length > 0 ? Math.min(...candidates) + 1 : lineEnd === -1 ? src.length : lineEnd;
	if (end - lineStart > 400) end = lineStart + 400;
	return src.slice(lineStart, end);
}

function methodsInWindow(w: string): string[] {
	const out = new Set<string>();
	// Both quote styles appear in server.ts (e.g. the session git/PR endpoints
	// at ~line 12920+ use `req.method === 'GET'` with single quotes while most
	// of the file uses double quotes) — both must be recognized or those
	// routes' methods (and, via the callers below, their very existence)
	// silently fail to attribute.
	for (const m of w.matchAll(/req\.method === "([A-Z]+)"/g)) out.add(m[1]);
	for (const m of w.matchAll(/req\.method === '([A-Z]+)'/g)) out.add(m[1]);
	return [...out];
}

/**
 * For the `const fooMatch = url.pathname.match(...)` / `const fooFlag =
 * url.pathname === "..."` idioms: find every `if (...)` that references the
 * variable and union the `req.method === "X"` checks found in those
 * conditions. If ANY dispatching `if` uses the variable without a
 * same-statement method check (e.g. `if (goalMatch) {` with method branching
 * inside the block), give up and return null — conservative: any method.
 */
function methodsForVar(src: string, varName: string, defIdx: number): string[] | null {
	const defWindow = statementWindow(src, defIdx);
	const defStart = src.lastIndexOf("\n", defIdx) + 1;
	// `const isX = url.pathname === "..." && req.method === "GET";` — the
	// method gate is baked into the boolean itself; trust it directly.
	const defMethods = methodsInWindow(defWindow);
	if (defMethods.length > 0) return defMethods;
	const usageRe = new RegExp(String.raw`\b${varName}\b`, "g");
	const methods = new Set<string>();
	let sawMethodless = false;
	let sawUsage = false;
	let m: RegExpExecArray | null;
	while ((m = usageRe.exec(src))) {
		// Skip the definition statement itself.
		if (m.index >= defStart && m.index < defStart + defWindow.length) continue;
		const w = statementWindow(src, m.index);
		// Only `if (...)` conditions count as dispatch; skip destructuring,
		// comments, negated guards (`if (!fooMatch)`).
		if (!/\b(?:if|else if)\s*\(/.test(w)) continue;
		if (new RegExp(String.raw`!\s*${varName}\b`).test(w)) continue;
		sawUsage = true;
		const ms = methodsInWindow(w);
		if (ms.length === 0) sawMethodless = true;
		else for (const x of ms) methods.add(x);
	}
	if (!sawUsage || sawMethodless) return null;
	return [...methods];
}

/**
 * Methods for a path-match found at `idx`: if the match sits inside an
 * `if (...)` condition, read `req.method === "X"` from that same statement;
 * if it's a `const NAME = ...` assignment, chase NAME's `if` usages.
 * Empty/unattributable → null (any method — see module-header LIMITATION).
 */
function attributeMethods(src: string, idx: number): string[] | null {
	const w = statementWindow(src, idx);
	const assign = w.match(/^\s*const (\w+) =/);
	if (assign) return methodsForVar(src, assign[1], idx);
	if (/\b(?:if|else if)\s*\(/.test(w)) {
		const ms = methodsInWindow(w);
		return ms.length > 0 ? ms : null;
	}
	return null;
}

export function extractServerRoutes(src: string): ServerRoute[] {
	const routes: ServerRoute[] = [];

	// Both quote styles appear in server.ts. Discovered while building the
	// client-orphan pinning test: the then-legacy session git/PR/commits
	// endpoints (git-pull, git-push, git-status, pr-merge, pr-status,
	// commits, ...) were written as `url.pathname.startsWith('/api/sessions/')
	// && url.pathname.endsWith('/git-pull')` with SINGLE quotes, unlike the
	// rest of the file's double-quoted idiom. An extractor that only matched
	// double quotes silently dropped all of them, which would have made
	// tests/client-api-orphan-pinning.test.ts misreport ~10 real, live routes
	// as new orphans. Matching both quote styles here fixes that for every
	// consumer of this module.
	const exactRe = /url\.pathname === "(\/api\/[^"]+)"|url\.pathname === '(\/api\/[^']+)'/g;
	let m: RegExpExecArray | null;
	while ((m = exactRe.exec(src))) {
		routes.push({ kind: "exact", value: m[1] ?? m[2], methods: attributeMethods(src, m.index) });
	}

	// NOTE: the auth guard `url.pathname.startsWith("/api/")` (bare "/api/")
	// must never be captured as a route — it would make any drift assertion
	// vacuous. The `[^"]+`/`[^']+` after `\/api\/` excludes it; callers
	// should assert that too (see prompt-api-drift.test.ts's sanity check).
	const startsRe = /url\.pathname\.startsWith\("(\/api\/[^"]+)"\)|url\.pathname\.startsWith\('(\/api\/[^']+)'\)/g;
	while ((m = startsRe.exec(src))) {
		const w = statementWindow(src, m.index);
		const endsWith = [
			...w.matchAll(/url\.pathname\.endsWith\("([^"]+)"\)/g),
			...w.matchAll(/url\.pathname\.endsWith\('([^']+)'\)/g),
		].map((x) => x[1]);
		const includes = [
			...w.matchAll(/url\.pathname\.includes\("([^"]+)"\)/g),
			...w.matchAll(/url\.pathname\.includes\('([^']+)'\)/g),
		].map((x) => x[1]);
		routes.push({
			kind: "prefix",
			value: m[1] ?? m[2],
			methods: attributeMethods(src, m.index),
			...(endsWith.length ? { endsWith } : {}),
			...(includes.length ? { includes } : {}),
		});
	}

	// `\(\s*\/...\/\s*,?\s*\)` (not the tighter `\(\/...\/\)`): some call
	// sites wrap onto multiple lines, e.g.
	//   url.pathname.match(
	//     /^\/api\/sessions\/([^/]+)\/transcript\/before-compaction$/,
	//   )
	// — discovered because the tighter form silently dropped this route
	// (misreporting a live endpoint as an orphan) while building
	// tests/client-api-orphan-pinning.test.ts.
	const matchRe = new RegExp(String.raw`url\.pathname\.match\(\s*\/(${REGEX_LITERAL_BODY})\/\s*,?\s*\)`, "g");
	while ((m = matchRe.exec(src))) {
		if (!m[1].includes("/api/") && !m[1].includes("\\/api\\/")) continue;
		let re: RegExp;
		try {
			re = new RegExp(m[1]);
		} catch {
			continue; // unparsable literal — not our concern here, would fail elsewhere
		}
		routes.push({ kind: "regex", value: re, methods: attributeMethods(src, m.index) });
	}

	return routes;
}

/** Escape a literal `RouteTable` pattern segment for embedding in a `RegExp` (mirrors src/server/routes/route-table.ts's own escaper). */
function escapeRegexLiteral(segment: string): string {
	return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract routes declared via the core route registry's data-driven
 * `table.register("METHOD", "pattern", handler)` calls (STR-01 — see the
 * REGISTRY MODULES module-header note). Unlike the legacy idioms above,
 * method attribution here is exact (the method is the call's first
 * argument), not a heuristic.
 *
 * A `:param` pattern segment compiles to a "regex" `ServerRoute` (`[^/]+`),
 * and a `/*` suffix compiles to a "prefix" route — matching
 * src/server/routes/route-table.ts's own `register()` semantics exactly, so
 * a pattern that would be rejected or misrouted there is represented
 * identically here.
 */
export function extractRegistryRoutes(src: string): ServerRoute[] {
	const routes: ServerRoute[] = [];
	const registerRe = /\.register\(\s*"([A-Z]+)"\s*,\s*"([^"]+)"/g;
	let m: RegExpExecArray | null;
	while ((m = registerRe.exec(src))) {
		const [, method, pattern] = m;
		if (pattern.endsWith("/*")) {
			routes.push({ kind: "prefix", value: pattern.slice(0, -1), methods: [method] });
			continue;
		}
		if (pattern.includes(":")) {
			const regexBody = pattern
				.split("/")
				.map((seg) => (seg.startsWith(":") ? "([^/]+)" : escapeRegexLiteral(seg)))
				.join("/");
			routes.push({ kind: "regex", value: new RegExp(`^${regexBody}$`), methods: [method] });
			continue;
		}
		routes.push({ kind: "exact", value: pattern, methods: [method] });
	}
	return routes;
}

/**
 * Turn a path template containing `:param` / `{param}` placeholders (or
 * already-substituted `${...}` client template-literal segments normalized
 * to a placeholder) into one concrete example path by substituting a
 * slash-free dummy for every placeholder segment. The concrete path can then
 * be tested against the server's exact/prefix/regex matchers exactly as a
 * real request path would be.
 */
export function concretize(pathTemplate: string): string {
	return pathTemplate.replace(/:[A-Za-z0-9_]+|\{[A-Za-z0-9_]+\}/g, "X");
}

export function pathMatches(r: ServerRoute, concretePath: string): boolean {
	if (r.kind === "exact") return r.value === concretePath;
	if (r.kind === "prefix") {
		if (!concretePath.startsWith(r.value as string)) return false;
		if (r.endsWith && !r.endsWith.every((s) => concretePath.endsWith(s))) return false;
		if (r.includes && !r.includes.every((s) => concretePath.includes(s))) return false;
		return true;
	}
	return (r.value as RegExp).test(concretePath);
}

export type RouteCheck = { ok: true } | { ok: false; reason: string };

/**
 * Method-aware: pass `method: null` to check "is this path routed for ANY
 * method" (used by the client-orphan pinning test, which doesn't know which
 * HTTP method a given client call site uses without deeper parsing).
 */
export function isRouted(method: string | null, concretePath: string, routes: ServerRoute[]): RouteCheck {
	const matching = routes.filter((r) => pathMatches(r, concretePath));
	if (matching.length === 0) return { ok: false, reason: "no matching route" };
	if (method === null) return { ok: true };
	if (matching.some((r) => r.methods === null || r.methods.includes(method))) return { ok: true };
	const allowed = [...new Set(matching.flatMap((r) => r.methods ?? []))].sort();
	return { ok: false, reason: `path exists but not for ${method} (allowed: ${allowed.join(", ")})` };
}

let cachedRoutes: ServerRoute[] | null = null;

/**
 * Cached: `src/server/server.ts` is large (~16k lines); avoid re-parsing it
 * (plus the delegate modules) per test file within a run. Concatenates
 * server.ts with every DELEGATE_ROUTE_MODULE_PATHS file (joined by blank
 * lines, which is harmless for the line/statement-window-relative regexes
 * above) so routes registered in those sibling modules are part of the same
 * surface — see the DELEGATE MODULES module-header note. Registry-module
 * routes (STR-01 — see REGISTRY MODULES above) are extracted separately
 * (their own idiom, not the three legacy ones) and appended.
 */
export function getServerRoutes(): ServerRoute[] {
	if (!cachedRoutes) {
		const parts = [SERVER_SRC_PATH, ...DELEGATE_ROUTE_MODULE_PATHS].map((p) => fs.readFileSync(p, "utf8"));
		const legacyRoutes = extractServerRoutes(parts.join("\n\n"));
		const registryRoutes = REGISTRY_ROUTE_MODULE_PATHS.flatMap((p) => extractRegistryRoutes(fs.readFileSync(p, "utf8")));
		cachedRoutes = [...legacyRoutes, ...registryRoutes];
	}
	return cachedRoutes;
}
