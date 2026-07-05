/**
 * BYTE-PARITY PIN — goal-nesting prompt stanzas (EXTENSION-SEAM-AUDIT.md S6).
 *
 * `buildNestingContextSection` (src/server/agent/system-prompt.ts, backed by
 * the declarative stanza table in src/server/agent/goal-nesting-stanzas.ts)
 * assembles a PRODUCT PROMPT SURFACE — text the model actually reads. This
 * test asserts the function's output is byte-identical, for the full input
 * matrix below, to `tests/fixtures/goal-nesting-stanzas.snapshot.json` — a
 * fixture captured from the pre-refactor imperative implementation (the
 * nested if/else chain that used to live directly in
 * `buildNestingContextSection`) before it was converted to the declarative
 * table.
 *
 * The matrix covers every branch + fallback expression the original code
 * had:
 *  - `ctx.team` false → no section at all (checked first, short-circuits
 *    everything else).
 *  - `ctx.parent` absent vs present → Stanza A (root) vs Stanza B (child).
 *  - `ctx.subGoalsEnabled` true / false / omitted (undefined must behave
 *    like false — never a third state) → gates Stanza A entirely, gates the
 *    child's "deeper nesting" bullet, and gates Stanza C (decision table).
 *  - Stanza B's per-field fallbacks: `parent.title || parent.id`,
 *    `root.title || root.id || parentTitle`, `root.id || parentId`,
 *    `parent.branch || "parent's branch"`, `goalBranch || "your branch"` —
 *    each exercised both "present" and "absent" to hit both sides of every
 *    `||`.
 *  - Extraneous fields on a root ctx (e.g. a stray `root`/`goalBranch`) must
 *    be ignored — they only apply to the child stanza.
 *
 * DO NOT "fix" a failure here by editing the fixture unless the stanza
 * change is INTENTIONAL. If you intentionally change stanza copy, regenerate
 * the fixture from the new implementation and note the change in the PR
 * description — this test's entire job is to make that an explicit,
 * reviewed decision rather than silent prompt drift.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildNestingContextSection, type NestingContext } from "../src/server/agent/system-prompt.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_PATH = path.join(__dirname, "fixtures", "goal-nesting-stanzas.snapshot.json");
const SNAPSHOT: Record<string, string | null> = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

// The exact input matrix used to generate the fixture. Keep in lockstep with
// the generation script's matrix — if you add a case here, regenerate the
// fixture (do NOT hand-write an expected value).
const MATRIX: Record<string, NestingContext> = {
	"non-team": { team: false, subGoalsEnabled: true, parent: { id: "p1", title: "Parent" }, goalBranch: "goal-child" },
	"root-subgoals-off": { team: true, subGoalsEnabled: false },
	"root-subgoals-flag-undefined": { team: true },
	"root-subgoals-on": { team: true, subGoalsEnabled: true },
	"root-extraneous-fields-ignored": { team: true, subGoalsEnabled: true, goalBranch: "ignored-branch", root: { id: "ignored" } },
	"child-subgoals-on-full": {
		team: true,
		subGoalsEnabled: true,
		parent: { id: "p1", title: "Parent Goal", branch: "goal-parent" },
		root: { id: "r1", title: "Root Goal", branch: "goal-root" },
		goalBranch: "goal-child",
	},
	"child-subgoals-off": {
		team: true,
		subGoalsEnabled: false,
		parent: { id: "p1", title: "Parent Goal", branch: "goal-parent" },
		root: { id: "r1", title: "Root Goal", branch: "goal-root" },
		goalBranch: "goal-child",
	},
	"child-no-title-branch-fallback": {
		team: true,
		subGoalsEnabled: true,
		parent: { id: "p2" },
		goalBranch: "goal-child2",
	},
	"child-root-set-parent-title-only": {
		team: true,
		subGoalsEnabled: true,
		parent: { id: "p3", title: "P3" },
		root: { id: "r3" },
	},
	"child-subgoals-flag-undefined": {
		team: true,
		parent: { id: "p4", title: "P4", branch: "goal-p4" },
		goalBranch: "goal-c4",
	},
};

describe("buildNestingContextSection — byte-parity snapshot (S6 declarative-table refactor)", () => {
	it("fixture covers exactly the matrix declared here (no drift either direction)", () => {
		assert.deepEqual(Object.keys(SNAPSHOT).sort(), Object.keys(MATRIX).sort());
	});

	for (const [name, ctx] of Object.entries(MATRIX)) {
		it(`case "${name}" — byte-identical to pre-refactor snapshot`, () => {
			const actual = buildNestingContextSection(ctx) ?? null;
			const expected = SNAPSHOT[name];
			assert.equal(actual, expected, `stanza output for case "${name}" diverged from the pinned snapshot`);
		});
	}
});
