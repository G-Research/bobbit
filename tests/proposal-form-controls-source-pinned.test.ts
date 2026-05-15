/**
 * Source-pin test for the goal-proposal modal subgoal controls.
 *
 * `renderGoalForm` in `src/app/render.ts` renders two per-goal controls in
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
 * This is a SOURCE-PIN: we read render.ts as text and assert the two
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
const RENDER_TS = path.join(__dirname, "..", "src", "app", "render.ts");

describe("Goal proposal modal — subgoal controls source-pin", () => {
	it("render.ts contains goal-form-subgoals-toggle test id", () => {
		const text = fs.readFileSync(RENDER_TS, "utf-8");
		assert.ok(
			text.includes("goal-form-subgoals-toggle"),
			"src/app/render.ts must render the per-goal 'Allow subgoals' checkbox\n" +
			"with data-testid=\"goal-form-subgoals-toggle\" in the proposal modal.\n" +
			"Without it, operators cannot disable subgoal spawning for a specific\n" +
			"goal at creation time — a regression that has hit this codebase via\n" +
			"silent merge-conflict resolution before. See goal spec for context.",
		);
	});

	it("render.ts contains goal-form-max-depth test id", () => {
		const text = fs.readFileSync(RENDER_TS, "utf-8");
		assert.ok(
			text.includes("goal-form-max-depth"),
			"src/app/render.ts must render the per-goal 'Max depth' number input\n" +
			"with data-testid=\"goal-form-max-depth\" in the proposal modal,\n" +
			"shown when the Allow-subgoals checkbox is enabled. Without it,\n" +
			"operators cannot tighten the per-goal nesting cap at creation time.",
		);
	});
});
