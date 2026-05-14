/**
 * Pins the labeled-divider callsite in render-helpers.ts.
 *
 * The `archivedDivider(owner?)` function renders `ARCHIVED · <owner>` when an
 * owner is supplied. The critical callsite is in `renderTeamGroup`, which must
 * pass `teamLead.title` so each team-lead's archived section carries its
 * owner's name. Without this, multiple "ARCHIVED" dividers rendered at similar
 * indentation inside a nested subtree are visually indistinguishable.
 *
 * Because `render-helpers.ts` imports browser-specific modules (`state`, `api`,
 * `session-manager`, …) it cannot be imported in a bare Node unit-test. This
 * test pins the callsite by asserting the exact source pattern is present.
 * If someone regresses `archivedDivider(teamLead.title)` back to
 * `archivedDivider()`, this test will fail immediately.
 *
 * The `archivedDivider` function itself is exercised visually; the unit tests
 * in `bucket-active-archived.test.ts` cover `bucketActiveArchived` (the helper
 * that controls whether the divider is emitted at all).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "../src/app/render-helpers.ts");

describe("archivedDivider ownership labeling — callsite pin", () => {
	it("renderTeamGroup passes teamLead.title to archivedDivider", () => {
		const source = fs.readFileSync(SRC, "utf-8");
		assert.match(
			source,
			/archivedDivider\(\s*teamLead\.title\s*\)/,
			"render-helpers.ts::renderTeamGroup must call archivedDivider(teamLead.title) — " +
			"removing this regresses the ownership-labeled divider feature (bug: multiple " +
			"indistinguishable ARCHIVED dividers in a team-lead subtree)",
		);
	});

	it("archivedDivider accepts an optional owner parameter (signature check)", () => {
		const source = fs.readFileSync(SRC, "utf-8");
		assert.match(
			source,
			/archivedDivider\s*=\s*\(\s*owner\s*\?/,
			"archivedDivider must have an optional owner parameter",
		);
	});

	it("data-owner attribute is emitted by archivedDivider", () => {
		const source = fs.readFileSync(SRC, "utf-8");
		assert.match(
			source,
			/data-owner/,
			"archivedDivider must emit a data-owner attribute for test selectors",
		);
	});
});
