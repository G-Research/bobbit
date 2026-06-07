/**
 * Source-pin test for the goal-proposal modal subgoal controls.
 *
 * `renderGoalForm` in `src/app/proposal-panels.ts` renders two per-goal controls in
 * the proposal modal when `config.subgoalsEnabled` is true:
 *   - the "Allow subgoals" checkbox (data-testid="goal-form-subgoals-toggle")
 *   - the "Max depth" number input  (data-testid="goal-form-max-depth")
 *
 * Both controls shipped originally in commit 492d88e1 and were silently
 * dropped during a later merge-conflict resolution — operators lost the
 * ability to disable subgoal spawning per-goal or tighten the nesting cap
 * at creation time. The regression went unnoticed because nothing pinned
 * the controls' presence in the rendered form.
 *
 * This is a SOURCE-PIN: we read proposal-panels.ts as text and assert the two
 * test-id strings exist. It mirrors `tests/server-subgoals-getter-wired.test.ts`.
 * The bug-class is "the UI element disappeared from the form during a
 * merge" — a behavioural assertion would still pass when the controls
 * have been silently dropped because the surrounding form code is intact.
 *
 * Runtime behaviour (toggle, clamp, submission wiring, server persistence)
 * is independently pinned by:
 *   - tests/e2e/ui/goal-proposal-form.spec.ts (browser E2E + REST round-trip)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDER_TS = path.join(__dirname, "..", "src", "app", "proposal-panels.ts");

describe("Goal proposal modal — subgoal controls source-pin", () => {
	it("proposal-panels.ts contains goal-form-subgoals-toggle test id", () => {
		const text = fs.readFileSync(RENDER_TS, "utf-8");
		assert.ok(
			text.includes("goal-form-subgoals-toggle"),
			"src/app/proposal-panels.ts must render the per-goal 'Allow subgoals' checkbox\n" +
			"with data-testid=\"goal-form-subgoals-toggle\" in the proposal modal.\n" +
			"Without it, operators cannot disable subgoal spawning for a specific\n" +
			"goal at creation time — a regression that has hit this codebase via\n" +
			"silent merge-conflict resolution before. See goal spec for context.",
		);
	});

	it("proposal-panels.ts contains goal-form-max-depth test id", () => {
		const text = fs.readFileSync(RENDER_TS, "utf-8");
		assert.ok(
			text.includes("goal-form-max-depth"),
			"src/app/proposal-panels.ts must render the per-goal 'Max depth' number input\n" +
			"with data-testid=\"goal-form-max-depth\" in the proposal modal,\n" +
			"shown when the Allow-subgoals checkbox is enabled. Without it,\n" +
			"operators cannot tighten the per-goal nesting cap at creation time.",
		);
	});

	it("gates the controls via the default-on isSubgoalsEnabled() helper, not a default-off dataset read", () => {
		const text = fs.readFileSync(RENDER_TS, "utf-8");
		// The controls render only when `subgoalsEnabled` is truthy. That value
		// MUST come from the shared `isSubgoalsEnabled()` helper (default-ON when
		// the dataset is unset) — matching the rest of the UI and the server's
		// unset → enabled default. A literal `dataset.subgoalsEnabled === "true"`
		// read here is default-OFF and silently hides the controls on a fresh
		// install, contradicting the G1 fix. Do not reintroduce it.
		assert.ok(
			text.includes("isSubgoalsEnabled()"),
			"proposal-panels.ts must compute `subgoalsEnabled` via the shared\n" +
			"isSubgoalsEnabled() helper from ./subgoals-flag.js (default-on),\n" +
			"so the Allow-subgoals toggle + Max-depth control render when the\n" +
			"system Subgoals preference is unset.",
		);
		assert.ok(
			!text.includes('dataset.subgoalsEnabled === "true"'),
			"proposal-panels.ts must NOT gate the subgoal controls on a literal\n" +
			"`document.documentElement.dataset.subgoalsEnabled === \"true\"` read —\n" +
			"that is default-OFF and hides the controls on a fresh install.\n" +
			"Use the shared default-on isSubgoalsEnabled() helper instead.",
		);
		assert.ok(
			text.includes("getSystemMaxNestingDepth()"),
			"proposal-panels.ts must read the system max-nesting-depth default via\n" +
			"the shared getSystemMaxNestingDepth() helper, not an ad-hoc parseInt of\n" +
			"document.documentElement.dataset.maxNestingDepth.",
		);
	});

	it("Allow-subgoals checkbox uses the shared toggle-switch pill style", () => {
		const text = fs.readFileSync(RENDER_TS, "utf-8");
		// Find the line introducing the subgoals checkbox and assert its class.
		// The toggle must live in the shared toggle row alongside Sandbox /
		// Auto-start team / Enable QA Testing, all of which use class="toggle-switch".
		// A raw <input type="checkbox"> without this class is the visual
		// inconsistency the UX-consistency subgoal was created to fix.
		const idx = text.indexOf("goal-form-subgoals-toggle");
		assert.ok(idx >= 0, "goal-form-subgoals-toggle not found");
		// Look back ~400 chars for the enclosing <input> tag declaration.
		const window = text.slice(Math.max(0, idx - 400), idx);
		assert.ok(
			window.includes("class=\"toggle-switch\""),
			"The Allow-subgoals checkbox must use class=\"toggle-switch\" to match\n" +
			"the Sandbox / Auto-start team / Enable QA Testing peer toggles in the\n" +
			"same shared row. A raw checkbox here is the exact visual inconsistency\n" +
			"that the UX-consistency subgoal restored — do not delete this pin.",
		);
	});
});
