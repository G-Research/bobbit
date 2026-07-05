/**
 * Pinning test — prompt-advertised REST endpoints must actually exist.
 *
 * `defaults/system-prompt.md` (and sibling prompt/tool-description templates
 * under `defaults/`) tell agents to call specific `GET`/`POST`/etc.
 * `/api/...` endpoints. If the server's route matcher ever stops serving one
 * of those paths — or never did — agents burn turns hitting 404s. This has
 * already happened once: the prompt advertised `GET /api/skills`, but the
 * server only ever served `GET /api/slash-skills`.
 *
 * This test extracts every `METHOD /api/...` reference from the prompt
 * templates and every route the server actually dispatches — both the
 * legacy `handleApiRoute` if/else chain in `src/server/server.ts` (scanned
 * for its three route-matching idioms: exact `url.pathname === "..."`,
 * regex `url.pathname.match(/.../ )`, and prefix
 * `url.pathname.startsWith("...")`) AND the STR-01 core route registry's
 * data-driven `table.register("METHOD", "pattern", handler)` calls in
 * `src/server/routes/*-routes.ts` (see docs/design/route-registry.md) — then
 * asserts every advertised `METHOD path` pair is actually routed.
 *
 * This used to carry its own separate inline copy of the extraction logic
 * that only scanned server.ts and never learned about registry-migrated
 * routes; that copy silently went stale the moment a route referenced here
 * (`GET /api/workflows`) migrated out of server.ts in STR-01 cohort 6, which
 * would have made this test falsely report a live, working endpoint as
 * missing. Refactored to import the shared, registry-aware extractor from
 * tests/helpers/server-route-surface.ts (already used by
 * tests/orient-api-route-families.test.ts and
 * tests/client-api-orphan-pinning.test.ts) instead of duplicating it — this
 * was a pre-existing TODO noted in docs/design/route-registry.md's cohort 1
 * section, now paid down by the first cohort whose migrated routes are
 * actually prompt-advertised.
 *
 * Method awareness (best-effort for legacy routes, exact for registry
 * routes; see server-route-surface.ts's module header for the legacy
 * heuristic's LIMITATION on routes that branch on `req.method` inside an
 * unconditional `if` block).
 *
 * Keep this in sync with reality by fixing the *prompt* when the server's
 * route shape changes, not by loosening this test's matching.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, getServerRoutes, concretize, isRouted, type ServerRoute } from "./helpers/server-route-surface.ts";

// Prompt/template files that are shown to in-session agents and may mention
// gateway REST endpoints. Add new agent-facing templates here as they gain
// `/api/` references.
const PROMPT_FILES = [
	"defaults/system-prompt.md",
	"defaults/tools/agent/session_prompt.yaml",
	"defaults/tools/team/team_prompt.yaml",
];

// ── Extract every advertised "METHOD /api/..." reference from the prompt files ──

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

const serverRoutes: ServerRoute[] = getServerRoutes();

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
			`expected 100+ server routes scanned, found ${serverRoutes.length}`,
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
				misses.push(`  ${file}: \`${method} ${p}\` (checked as ${method} ${concrete}) — ${res.reason}`);
			}
		}
		assert.equal(
			misses.length,
			0,
			`${misses.length} prompt-advertised endpoint(s) do not exist in the server's route surface:\n${misses.join("\n")}\n\n` +
				`Fix the prompt to point at the real route/method (adjust the prompt to the code, not vice versa).`,
		);
	});
});
