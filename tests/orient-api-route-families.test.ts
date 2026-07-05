/**
 * Pinning test — the `orient` tool's `apiRouteFamilies` list must not drift
 * from the server's actual routes (Finding W2.15).
 *
 * `ORIENT_API_ROUTE_FAMILIES` (src/server/agent/orient.ts) is a small,
 * hand-curated pointer into the REST surface — not a generated catalog (see
 * that module's docblock for why). The exact same failure mode
 * tests/prompt-api-drift.test.ts guards against for `defaults/system-prompt.md`
 * (the live `/api/skills` vs `/api/slash-skills` drift) is possible here too,
 * so this test reuses the SAME extraction idiom, via the shared
 * tests/helpers/server-route-surface.ts module, to assert every `example`
 * route in the curated list actually resolves against the server's live
 * route-matching code.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ORIENT_API_ROUTE_FAMILIES } from "../src/server/agent/orient.ts";
import { getServerRoutes, concretize, isRouted } from "./helpers/server-route-surface.ts";

const METHOD_RE = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/[A-Za-z0-9_\-/:{}]+)$/;

describe("orient(self) apiRouteFamilies stay in sync with the live server route surface", () => {
	it("declares at least a handful of route families (sanity)", () => {
		assert.ok(
			ORIENT_API_ROUTE_FAMILIES.length >= 5,
			`expected several curated route families, found ${ORIENT_API_ROUTE_FAMILIES.length}`,
		);
	});

	it("every family name is unique", () => {
		const names = ORIENT_API_ROUTE_FAMILIES.map((f) => f.family);
		assert.equal(new Set(names).size, names.length, `duplicate family name(s) in: ${names.join(", ")}`);
	});

	it("every curated example route is actually routed by the server", () => {
		const routes = getServerRoutes();
		const misses: string[] = [];
		for (const { family, example } of ORIENT_API_ROUTE_FAMILIES) {
			const m = example.match(METHOD_RE);
			assert.ok(m, `orient family "${family}" example "${example}" is not a "METHOD /api/..." string`);
			const [, method, p] = m;
			const concrete = concretize(p);
			const res = isRouted(method, concrete, routes);
			if (!res.ok) {
				misses.push(`  ${family}: \`${example}\` (checked as ${method} ${concrete}) — ${res.reason}`);
			}
		}
		assert.equal(
			misses.length,
			0,
			`${misses.length} orient-advertised route family example(s) do not exist in src/server/server.ts:\n${misses.join("\n")}\n\n` +
				`Fix src/server/agent/orient.ts's ORIENT_API_ROUTE_FAMILIES to point at a real route/method (adjust the list to the code, not vice versa).`,
		);
	});
});
