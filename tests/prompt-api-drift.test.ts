/**
 * Pinning test — prompt-advertised REST endpoints must actually exist.
 *
 * `defaults/system-prompt.md` (and sibling prompt/tool-description templates
 * under `defaults/`) tell agents to call specific `GET`/`POST`/etc.
 * `/api/...` endpoints. If the server's route matcher in
 * `src/server/server.ts` ever stops serving one of those paths — or never
 * did — agents burn turns hitting 404s. This has already happened once:
 * the prompt advertised `GET /api/skills`, but the server only ever served
 * `GET /api/slash-skills`.
 *
 * This test extracts every `METHOD /api/...` reference from the prompt
 * templates and every route the server actually dispatches (by scanning
 * `server.ts` source for its three route-matching idioms — exact
 * `url.pathname === "..."`, regex `url.pathname.match(/.../ )`, and prefix
 * `url.pathname.startsWith("...")` — mirroring the source-pinning approach
 * in tests/tool-description-budget.test.ts), then asserts every advertised
 * `METHOD path` pair is actually routed.
 *
 * Method awareness (best-effort, conservative): each extracted route also
 * gets the set of HTTP methods its dispatch is gated on, parsed from
 * `req.method === "X"` checks that appear in the same statement as the
 * path match, or — for the `const fooMatch = url.pathname.match(...)` /
 * `const fooFlag = url.pathname === "..."` idioms — in the `if (fooMatch &&
 * req.method === "X")` usages of that variable. LIMITATION: when a route's
 * method cannot be attributed with confidence (e.g. `if (goalMatch) {`
 * blocks that branch on `req.method` internally, or the pass-through
 * `/api/marketplace/` and `/api/aigw/v1/` dispatch blocks), the route is
 * treated as accepting ANY method — so method drift is only caught on
 * routes with same-statement/same-variable method gating (the vast
 * majority; see the coverage line the test prints). Path drift is always
 * caught.
 *
 * Keep this in sync with reality by fixing the *prompt* when the server's
 * route shape changes, not by loosening this test's matching.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SERVER_SRC = fs.readFileSync(path.join(REPO_ROOT, "src/server/server.ts"), "utf8");

// Prompt/template files that are shown to in-session agents and may mention
// gateway REST endpoints. Add new agent-facing templates here as they gain
// `/api/` references.
const PROMPT_FILES = [
	"defaults/system-prompt.md",
	"defaults/tools/agent/session_prompt.yaml",
	"defaults/tools/team/team_prompt.yaml",
];

// ── 1. Extract every advertised "METHOD /api/..." reference from the prompt files ──

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type AdvertisedEndpoint = { method: string; path: string; file: string };

/**
 * Matches `` `GET /api/foo/:id` `` style references — a backtick-quoted HTTP
 * method followed by an /api path, optionally with :param segments. This
 * intentionally requires the method prefix so bare `/api/...` mentions in
 * prose (e.g. inside curl examples already covered by other patterns) don't
 * spuriously count as a second, method-less endpoint claim.
 */
const ADVERTISED_RE = new RegExp(
	String.raw`\b(${METHODS.join("|")})\s+(/api/[A-Za-z0-9_\-/:{}]+)`,
	"g",
);

function extractAdvertised(file: string, text: string): AdvertisedEndpoint[] {
	const out: AdvertisedEndpoint[] = [];
	let m: RegExpExecArray | null;
	const re = new RegExp(ADVERTISED_RE.source, "g");
	while ((m = re.exec(text))) {
		out.push({ method: m[1], path: m[2].replace(/[.,;`)]+$/, ""), file });
	}
	return out;
}

const advertised: AdvertisedEndpoint[] = [];
for (const rel of PROMPT_FILES) {
	const abs = path.join(REPO_ROOT, rel);
	if (!fs.existsSync(abs)) continue;
	advertised.push(...extractAdvertised(rel, fs.readFileSync(abs, "utf8")));
}

// ── 2. Build the set of routes the server actually dispatches, by scanning its three route-matching idioms ──

/** Regex-literal body: escaped chars, character classes (which may contain unescaped `/`), or any non-slash/backslash char. */
const REGEX_LITERAL_BODY = String.raw`(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\])*`;

type ServerRoute = {
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
	for (const m of w.matchAll(/req\.method === "([A-Z]+)"/g)) out.add(m[1]);
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
 * Empty/unattributable → null (any method — see header LIMITATION).
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

function extractServerRoutes(src: string): ServerRoute[] {
	const routes: ServerRoute[] = [];

	const exactRe = /url\.pathname === "(\/api\/[^"]+)"/g;
	let m: RegExpExecArray | null;
	while ((m = exactRe.exec(src))) {
		routes.push({ kind: "exact", value: m[1], methods: attributeMethods(src, m.index) });
	}

	// NOTE: the auth guard `url.pathname.startsWith("/api/")` (bare "/api/")
	// must never be captured as a route — it would make the whole test
	// vacuous. The `[^"]+` after `\/api\/` excludes it; the sanity assert
	// below pins that.
	const startsRe = /url\.pathname\.startsWith\("(\/api\/[^"]+)"\)/g;
	while ((m = startsRe.exec(src))) {
		const w = statementWindow(src, m.index);
		const endsWith = [...w.matchAll(/url\.pathname\.endsWith\("([^"]+)"\)/g)].map((x) => x[1]);
		const includes = [...w.matchAll(/url\.pathname\.includes\("([^"]+)"\)/g)].map((x) => x[1]);
		routes.push({
			kind: "prefix",
			value: m[1],
			methods: attributeMethods(src, m.index),
			...(endsWith.length ? { endsWith } : {}),
			...(includes.length ? { includes } : {}),
		});
	}

	const matchRe = new RegExp(String.raw`url\.pathname\.match\(\/(${REGEX_LITERAL_BODY})\/\)`, "g");
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

const serverRoutes = extractServerRoutes(SERVER_SRC);

// ── 3. Match advertised METHOD+path (with :param placeholders) against the server's routes ──

/**
 * Turn a prompt-advertised path template (e.g. `/api/goals/:id/gates/:gateId`)
 * into one concrete example path (e.g. `/api/goals/X/gates/X`) by substituting
 * a slash-free dummy for every `:param` / `{param}` segment. The concrete path
 * can then be tested against the server's exact/prefix/regex matchers exactly
 * as a real request path would be.
 */
function concretize(pathTemplate: string): string {
	return pathTemplate.replace(/:[A-Za-z0-9_]+|\{[A-Za-z0-9_]+\}/g, "X");
}

function pathMatches(r: ServerRoute, concretePath: string): boolean {
	if (r.kind === "exact") return r.value === concretePath;
	if (r.kind === "prefix") {
		if (!concretePath.startsWith(r.value as string)) return false;
		if (r.endsWith && !r.endsWith.every((s) => concretePath.endsWith(s))) return false;
		if (r.includes && !r.includes.every((s) => concretePath.includes(s))) return false;
		return true;
	}
	return (r.value as RegExp).test(concretePath);
}

type RouteCheck = { ok: true } | { ok: false; reason: string };

function isRouted(method: string, concretePath: string, routes: ServerRoute[]): RouteCheck {
	const matching = routes.filter((r) => pathMatches(r, concretePath));
	if (matching.length === 0) return { ok: false, reason: "no matching route" };
	if (matching.some((r) => r.methods === null || r.methods.includes(method))) return { ok: true };
	const allowed = [...new Set(matching.flatMap((r) => r.methods ?? []))].sort();
	return { ok: false, reason: `path exists but not for ${method} (allowed: ${allowed.join(", ")})` };
}

describe("prompt-advertised API endpoints match real routes", () => {
	it("found at least one advertised endpoint (sanity — regex isn't silently matching nothing)", () => {
		assert.ok(
			advertised.length >= 5,
			`expected several advertised /api endpoints across ${PROMPT_FILES.join(", ")}, found ${advertised.length}`,
		);
	});

	it("found a substantial number of server routes (sanity — extraction isn't broken)", () => {
		assert.ok(
			serverRoutes.length >= 100,
			`expected 100+ server routes scanned from server.ts, found ${serverRoutes.length}`,
		);
		// The bare "/api/" auth-guard prefix must never be captured — it would
		// path-match everything and make the drift assertion vacuous.
		assert.ok(
			!serverRoutes.some((r) => r.kind === "prefix" && r.value === "/api/"),
			`the bare "/api/" auth-guard prefix leaked into the route set`,
		);
		// Method-attribution coverage — decoration for PR-review visibility,
		// plus a floor so a parser regression that silently downgrades most
		// routes to any-method fails loudly instead of passing vacuously.
		const withMethods = serverRoutes.filter((r) => r.methods !== null).length;
		// eslint-disable-next-line no-console
		console.log(
			`[prompt-api-drift] ${serverRoutes.length} routes scanned, ${withMethods} method-attributed, ${serverRoutes.length - withMethods} any-method (unattributable)`,
		);
		assert.ok(
			withMethods / serverRoutes.length >= 0.8,
			`method attribution collapsed: only ${withMethods}/${serverRoutes.length} routes have methods — parser regression?`,
		);
	});

	it("every advertised endpoint is actually routed by the server (method-aware)", () => {
		const misses: string[] = [];
		for (const { method, path: p, file } of advertised) {
			const concrete = concretize(p);
			const res = isRouted(method, concrete, serverRoutes);
			if (!res.ok) {
				misses.push(`  ${file}: \`${method} ${p}\` (checked as ${method} ${concrete}) — ${res.reason} in src/server/server.ts`);
			}
		}
		assert.equal(
			misses.length,
			0,
			`${misses.length} prompt-advertised endpoint(s) do not exist in src/server/server.ts:\n${misses.join("\n")}\n\n` +
				`Fix the prompt to point at the real route/method (adjust the prompt to the code, not vice versa).`,
		);
	});
});
