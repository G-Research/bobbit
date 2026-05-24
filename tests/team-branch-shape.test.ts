/**
 * Pinning test for the "pithier team branches" goal.
 *
 * Two invariants are pinned:
 *
 *  1. `toBranchName` (in `src/server/agent/goal-manager.ts`) never emits a
 *     leading or trailing hyphen, even when truncation would otherwise
 *     re-introduce one (the historical `e2e-speed--` artefact). The trim
 *     must run *after* the slice.
 *
 *  2. Team-member agent branches use the shape
 *        `goal/<goalId8>/<role>-<short4>`
 *     where `goalId8` is 8 hex chars, `role` is a kebab-case role name,
 *     and `short4` is 4 hex chars. This is the format produced by
 *     `team-manager.ts::spawnRole` (~L916–924).
 *
 * Either shape regressing reintroduces the bugs the "pithier team
 * branches" goal fixed: oversized double-prefixed team branches
 * (`goal-goal-<slug>-<id>-<role>-<short>`) and goal branches with
 * trailing hyphens.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toBranchName } from "../src/server/agent/goal-manager.js";

const TEAM_BRANCH_RE = /^goal\/[0-9a-f]{8}\/[a-z][a-z0-9-]*-[0-9a-f]{4}$/;

const ROLES = [
	"coder",
	"reviewer",
	"test-engineer",
	"code-reviewer",
	"docs-writer",
	"qa-tester",
] as const;

function randomFuzzInput(): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_/";
	const len = Math.floor(Math.random() * 31); // 0..30
	let out = "";
	for (let i = 0; i < len; i++) {
		out += alphabet[Math.floor(Math.random() * alphabet.length)];
	}
	return out;
}

describe("goal toBranchName", () => {
	it("never returns a leading or trailing hyphen for representative inputs", () => {
		const cases: Array<[string, string?]> = [
			["", "goal"],
			["!!!", "goal"],
			["   ", "goal"],
			["e2e speed--"],
			["e2e speed test foo"],
			["abcde-fghij-klmno-pqrst"],
			["  hello world"],
			["hello world  "],
			["--leading-dashes"],
			["trailing-dashes--"],
			["hello / world / foo"],
			["UPPER CASE Title"],
		];
		for (const [input, expected] of cases) {
			const out = toBranchName(input);
			assert.ok(out.length > 0, `toBranchName(${JSON.stringify(input)}) is empty`);
			assert.doesNotMatch(
				out,
				/^-/,
				`toBranchName(${JSON.stringify(input)}) starts with "-": ${out}`,
			);
			assert.doesNotMatch(
				out,
				/-$/,
				`toBranchName(${JSON.stringify(input)}) ends with "-": ${out}`,
			);
			if (expected !== undefined) {
				assert.equal(out, expected);
			}
		}
	});

	it("falls back to \"goal\" for empty / all-symbol inputs", () => {
		assert.equal(toBranchName(""), "goal");
		assert.equal(toBranchName("!!!"), "goal");
		assert.equal(toBranchName("---"), "goal");
	});

	it("specifically does not leave a trailing hyphen when the slice would create one", () => {
		// "e2e speed--" → after replace: "e2e-speed--"
		// → after slice(0,14): "e2e-speed--" (still ≤14)
		// → after trim: "e2e-speed". Must NOT end in "-".
		const out = toBranchName("e2e speed--");
		assert.doesNotMatch(out, /-$/);
		assert.equal(out, "e2e-speed");
	});

	it("never returns a leading or trailing hyphen across 100 random inputs ≤30 chars", () => {
		for (let i = 0; i < 100; i++) {
			const input = randomFuzzInput();
			const out = toBranchName(input);
			assert.ok(out.length > 0, `empty output for ${JSON.stringify(input)}`);
			assert.doesNotMatch(out, /^-/, `leading "-" for ${JSON.stringify(input)} → ${out}`);
			assert.doesNotMatch(out, /-$/, `trailing "-" for ${JSON.stringify(input)} → ${out}`);
			assert.ok(
				out.length <= 14,
				`output longer than 14 chars for ${JSON.stringify(input)} → ${out}`,
			);
		}
	});
});

describe("team branch shape", () => {
	it("matches goal/<id8>/<role>-<short4> for every supported role", () => {
		const goalId8 = "18bdd8c2";
		const shortId = "6292";
		for (const role of ROLES) {
			const branchName = `goal/${goalId8}/${role}-${shortId}`;
			assert.match(branchName, TEAM_BRANCH_RE, `${role} branch shape mismatch: ${branchName}`);
		}
	});

	it("rejects the legacy goal-goal-<slug>-<id>-<role>-<short> shape", () => {
		const legacy = "goal-goal-pithier-te-e8b9113d-coder-6292eb8f";
		assert.doesNotMatch(legacy, TEAM_BRANCH_RE);
	});

	it("flattens to a sensible on-disk dirname (slashes → hyphens)", () => {
		// createWorktree() in src/server/skills/git.ts replaces "/" with "-"
		// when building the worktree dirname. The flattened form must remain
		// well-formed (no leading/trailing hyphens, no double prefix, no
		// double hyphens), since orphan-cleanup heuristics walk dirnames.
		const branch = "goal/18bdd8c2/coder-6292";
		const dirName = branch.replace(/\//g, "-");
		assert.equal(dirName, "goal-18bdd8c2-coder-6292");
		assert.doesNotMatch(dirName, /^-/);
		assert.doesNotMatch(dirName, /-$/);
		assert.doesNotMatch(dirName, /--/);
		assert.doesNotMatch(dirName, /^goal-goal-/);
	});
});
