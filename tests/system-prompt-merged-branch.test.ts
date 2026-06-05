/**
 * Pinning test for the "Never push to a merged PR" procedure in
 * defaults/system-prompt.md.
 *
 * The system prompt is loaded into every agent turn. This procedure replaced a
 * vague one-liner with a concrete, mechanical detection + fresh-branch recovery
 * sequence. Agents kept skipping the old wording; if the concrete commands or
 * key phrases regress, this test fails loudly so the guidance can't silently
 * rot back into hand-waving.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const SYSTEM_PROMPT = path.resolve(import.meta.dirname, "..", "defaults", "system-prompt.md");

describe("system-prompt merged-branch procedure", () => {
	const text = readFileSync(SYSTEM_PROMPT, "utf8");

	// Isolate the Pull requests section so we assert tokens appear in the
	// relevant area, not somewhere incidental elsewhere in the prompt.
	const prSectionMatch = text.match(/## Pull requests[\s\S]*?(?=\n## |\n# |$)/);
	assert.ok(prSectionMatch, "system-prompt.md must contain a `## Pull requests` section");
	const prSection = prSectionMatch![0];

	const requiredTokens: Array<[string, string]> = [
		["gh pr list --head", "primary `gh` detector command must be present"],
		["merge-base --is-ancestor", "git fallback detector command must be present"],
		["MERGED", "must mention the MERGED PR state agents look for"],
		["CLOSED", "must mention the CLOSED PR state agents look for"],
		["fresh branch off", "must describe the fresh-branch recovery path"],
	];

	for (const [token, why] of requiredTokens) {
		it(`Pull requests section contains "${token}"`, () => {
			assert.ok(
				prSection.includes(token),
				`Missing "${token}" in the ## Pull requests section — ${why}. ` +
					`The merged-PR procedure must stay concrete and mechanical.`,
			);
		});
	}

	it("still keeps the 'Never push to a merged PR' header", () => {
		assert.ok(
			prSection.includes("**Never push to a merged PR.**"),
			"The merged-PR guidance header must remain in the Pull requests section.",
		);
	});
});
