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
 * path is actually routed.
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

type ExactRoute = { kind: "exact"; value: string };
type PrefixRoute = { kind: "prefix"; value: string };
type RegexRoute = { kind: "regex"; value: RegExp };
type ServerRoute = ExactRoute | PrefixRoute | RegexRoute;

function extractServerRoutes(src: string): ServerRoute[] {
	const routes: ServerRoute[] = [];

	const exactRe = /url\.pathname === "(\/api\/[^"]+)"/g;
	let m: RegExpExecArray | null;
	while ((m = exactRe.exec(src))) routes.push({ kind: "exact", value: m[1] });

	const startsRe = /url\.pathname\.startsWith\("(\/api\/[^"]+)"\)/g;
	while ((m = startsRe.exec(src))) routes.push({ kind: "prefix", value: m[1] });

	const matchRe = new RegExp(String.raw`url\.pathname\.match\(\/(${REGEX_LITERAL_BODY})\/\)`, "g");
	while ((m = matchRe.exec(src))) {
		if (!m[1].includes("/api/") && !m[1].includes("\\/api\\/")) continue;
		let re: RegExp;
		try {
			re = new RegExp(m[1]);
		} catch {
			continue; // unparsable literal — not our concern here, would fail elsewhere
		}
		routes.push({ kind: "regex", value: re });
	}

	return routes;
}

const serverRoutes = extractServerRoutes(SERVER_SRC);

// ── 3. Match advertised paths (with :param placeholders) against the server's routes ──

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

function isRouted(concretePath: string, routes: ServerRoute[]): boolean {
	for (const r of routes) {
		if (r.kind === "exact" && r.value === concretePath) return true;
		if (r.kind === "prefix" && concretePath.startsWith(r.value)) return true;
		if (r.kind === "regex" && r.value.test(concretePath)) return true;
	}
	return false;
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
	});

	it("every advertised endpoint is actually routed by the server", () => {
		const misses: string[] = [];
		for (const { method, path: p, file } of advertised) {
			const concrete = concretize(p);
			if (!isRouted(concrete, serverRoutes)) {
				misses.push(`  ${file}: \`${method} ${p}\` (checked as ${concrete}) — no matching route in src/server/server.ts`);
			}
		}
		assert.equal(
			misses.length,
			0,
			`${misses.length} prompt-advertised endpoint(s) do not exist in src/server/server.ts:\n${misses.join("\n")}\n\n` +
				`Fix the prompt to point at the real route (adjust the prompt to the code, not vice versa).`,
		);
	});
});
