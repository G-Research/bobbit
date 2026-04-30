import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	assembleSystemPrompt,
	buildTopLevelTeamLeadStanza,
	buildChildTeamLeadStanza,
	buildMidGoalNestingStanza,
	initPromptDirs,
	type PromptParts,
} from "../src/server/agent/system-prompt.js";

/**
 * Snapshot + structural tests for the three nested-goal stanzas
 * (design doc §14.1.1 / §14.1.2 / §14.1.3 / §14.1.4 / §14.1.5).
 *
 * The literal markdown text lives in the helpers below — the snapshot
 * tests assert the spliced prompt contains the canonical phrases and
 * splices them in the spec-mandated order. They are not byte-for-byte
 * snapshots: they verify the load-bearing prose so refactors that
 * preserve meaning don't trip them, but a stanza that drops a critical
 * sentence (e.g. the "Restate acceptance criteria verbatim" rule) does.
 */
describe("system-prompt nesting stanzas (§14.1)", () => {
	let tmpDir: string;
	let cwdDir: string;

	before(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-nest-test-"));
		initPromptDirs(tmpDir);
		cwdDir = path.join(tmpDir, "cwd");
		fs.mkdirSync(cwdDir, { recursive: true });
	});

	after(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function makeParts(overrides: Partial<PromptParts> = {}): PromptParts {
		return { cwd: cwdDir, ...overrides };
	}

	// ── buildTopLevelTeamLeadStanza ────────────────────────────────────

	describe("buildTopLevelTeamLeadStanza (§14.1.1)", () => {
		it("includes the Goal Decomposition heading and master-PR reminder", () => {
			const text = buildTopLevelTeamLeadStanza({});
			assert.ok(text.includes("## Goal Decomposition"), "missing heading");
			assert.ok(text.includes("top-level goal"), "missing 'top-level goal'");
			assert.ok(text.includes("merge to\n`master`"), "missing master-PR reminder");
		});

		it("includes the multi-version-delivery heuristic + agent-memory worked example", () => {
			const text = buildTopLevelTeamLeadStanza({});
			// Heuristic
			assert.ok(text.includes("when to decompose"), "missing 'when to decompose' heuristic header");
			assert.ok(text.includes("5,000 characters"), "missing 5,000-char heuristic");
			assert.ok(text.includes("versions, milestones, or phases"), "missing versions/milestones heuristic");
			assert.ok(text.includes("5+ acceptance criteria"), "missing 5+ acceptance criteria heuristic");
			// Worked example
			assert.ok(text.includes("agent-memory v0.1→v1.0"), "missing agent-memory worked example anchor");
			assert.ok(text.includes("v0.1 — schema + persistence"), "missing v0.1 plan node");
			assert.ok(text.includes("v0.2 — recall API"), "missing v0.2 plan node");
			assert.ok(text.includes("v0.3 — semantic similarity"), "missing v0.3 plan node");
			assert.ok(text.includes("v1.0 — production hardening"), "missing v1.0 plan node");
		});

		it("interpolates concurrency cap and divergence policy", () => {
			const text = buildTopLevelTeamLeadStanza({ maxConcurrentChildren: 5, divergencePolicy: "balanced" });
			assert.ok(text.includes("currently 5"), "missing interpolated concurrency cap");
			assert.ok(text.includes("Divergence policy: balanced"), "missing interpolated divergence policy");
		});

		it("appends planning-loop one-liner when goalWorkflowId === 'parent'", () => {
			const without = buildTopLevelTeamLeadStanza({});
			const withParent = buildTopLevelTeamLeadStanza({ goalWorkflowId: "parent" });
			assert.ok(!without.includes("Planning loop (because your workflow is `parent`)"));
			assert.ok(withParent.includes("Planning loop (because your workflow is `parent`)"));
			assert.ok(withParent.includes("charter → plan-review → goal-plan → execution → integration →\nready-to-merge"));
		});

		it("does NOT append the planning-loop hint for non-parent workflows", () => {
			const text = buildTopLevelTeamLeadStanza({ goalWorkflowId: "feature" });
			assert.ok(!text.includes("Planning loop (because your workflow is `parent`)"));
		});
	});

	// ── buildChildTeamLeadStanza ───────────────────────────────────────

	describe("buildChildTeamLeadStanza (§14.1.2)", () => {
		const parent = {
			title: "Build agent-memory v0.1",
			branch: "goal/agent-memory-v01",
			specExcerpt: "Implement schema + persistence for agent memory.",
			rootTitle: "Ship agent-memory v0.1 → v1.0",
		};

		it("renders parent + root titles, branch, and spec excerpt", () => {
			const text = buildChildTeamLeadStanza(parent);
			assert.ok(text.includes("## You Are A Child Goal"), "missing heading");
			assert.ok(text.includes("_Build agent-memory v0.1_"), "missing parent title");
			assert.ok(text.includes("`goal/agent-memory-v01`"), "missing parent branch");
			assert.ok(text.includes("_Ship agent-memory v0.1 → v1.0_"), "missing root title");
			assert.ok(
				text.includes("> Implement schema + persistence for agent memory."),
				"missing parent spec excerpt blockquote",
			);
		});

		it("forbids gh pr create and explains the local-merge contract", () => {
			const text = buildChildTeamLeadStanza(parent);
			assert.ok(text.includes("local"), "missing 'local' merge phrasing");
			assert.ok(text.includes("git merge --no-ff"), "missing local merge command reference");
			assert.ok(text.includes("**You do not raise a PR.**"), "missing PR prohibition");
			assert.ok(text.includes("`gh pr create`"), "missing gh pr create reference");
			assert.ok(text.includes("`gh pr merge`"), "missing gh pr merge reference");
			assert.ok(
				text.includes("ready-to-merge"),
				"missing ready-to-merge reference",
			);
		});

		it("preserves multi-line spec excerpts as blockquote", () => {
			const text = buildChildTeamLeadStanza({
				...parent,
				specExcerpt: "Line one.\nLine two.\nLine three.",
			});
			assert.ok(text.includes("> Line one.\n> Line two.\n> Line three."), "missing multi-line blockquote");
		});
	});

	// ── buildMidGoalNestingStanza ──────────────────────────────────────

	describe("buildMidGoalNestingStanza (§14.1.3 + §14.1.5)", () => {
		it("names all three decomposition primitives", () => {
			const text = buildMidGoalNestingStanza({});
			assert.ok(text.includes("## Mid-Goal Decomposition"), "missing heading");
			assert.ok(text.includes("`task_create`"), "missing task_create");
			assert.ok(text.includes("`team_spawn`"), "missing team_spawn");
			assert.ok(text.includes("`goal_spawn_child`"), "missing goal_spawn_child");
		});

		it("includes the literal 'Restate acceptance criteria verbatim' rule", () => {
			const text = buildMidGoalNestingStanza({});
			assert.ok(
				text.includes(
					"Restate acceptance criteria verbatim in at least one subgoal spec — paraphrasing risks losing adherence-check coverage.",
				),
				"missing the literal verbatim-restatement sentence",
			);
			// And it must explain why (substring matching).
			assert.ok(text.includes("substring matching"), "missing substring-matching explanation");
			assert.ok(text.includes("`## Covers`"), "missing `## Covers` heading suggestion");
		});

		it("explains the criteria-drop hard rejection", () => {
			const text = buildMidGoalNestingStanza({});
			assert.ok(text.includes("`criteria-drop` is always rejected"), "missing criteria-drop hard rule");
			assert.ok(text.includes("regardless of policy"), "missing 'regardless of policy' clause");
		});

		it("interpolates the divergence policy and names all three values", () => {
			const text = buildMidGoalNestingStanza({ divergencePolicy: "autonomous" });
			assert.ok(text.includes("Divergence policy: `autonomous`"), "missing interpolated policy");
			assert.ok(text.includes("`strict`"), "missing strict explanation");
			assert.ok(text.includes("`balanced`"), "missing balanced explanation");
			assert.ok(text.includes("`autonomous`"), "missing autonomous explanation");
			// §14.1.3 binding: expansion always prompts under autonomous too.
			assert.ok(
				text.includes("Expansion still\n  prompts the user under autonomous"),
				"missing the 'expansion still prompts under autonomous' clarification (binding from §4.3)",
			);
		});

		it("includes the replanCount cap reminder", () => {
			const text = buildMidGoalNestingStanza({});
			assert.ok(text.includes("`replanCount` cap"), "missing replanCount cap heading");
			assert.ok(text.includes("After 5 post-freeze mutations"), "missing the 5-mutation cap value");
		});
	});

	// ── _assembleSystemPrompt: splice order (§14.1.4) ──────────────────

	describe("assembleSystemPrompt splice order (§14.1.4)", () => {
		it("top-level goal: spec → top-level → mid-goal stanza, no child stanza", () => {
			const promptPath = assembleSystemPrompt(
				"test-toplevel",
				makeParts({
					goalTitle: "Top Level Test",
					goalState: "in-progress",
					goalSpec: "This is the top-level goal spec.",
					rolePrompt: "You are the team lead.",
					roleName: "team-lead",
					isTeamLead: true,
					isTopLevelTeamLead: true,
					divergencePolicy: "strict",
					maxConcurrentChildren: 3,
				}),
			);
			assert.ok(promptPath);
			const content = fs.readFileSync(promptPath!, "utf-8");

			assert.ok(content.includes("## Goal Decomposition"), "top-level stanza missing");
			assert.ok(content.includes("## Mid-Goal Decomposition"), "mid-goal stanza missing");
			assert.ok(!content.includes("## You Are A Child Goal"), "child stanza must not appear for top-level goal");

			// Splice order: spec ⟶ top-level ⟶ mid-goal.
			const specIdx = content.indexOf("# Goal");
			const topIdx = content.indexOf("## Goal Decomposition");
			const midIdx = content.indexOf("## Mid-Goal Decomposition");
			assert.ok(specIdx >= 0 && topIdx > specIdx, "top-level stanza must follow spec");
			assert.ok(midIdx > topIdx, "mid-goal stanza must follow top-level stanza");
		});

		it("child goal: child → spec → mid-goal stanza, no top-level stanza", () => {
			const promptPath = assembleSystemPrompt(
				"test-child",
				makeParts({
					goalTitle: "Child Goal Test",
					goalState: "in-progress",
					goalSpec: "Implement schema + persistence.",
					rolePrompt: "You are the team lead.",
					roleName: "team-lead",
					isTeamLead: true,
					parentGoal: {
						id: "parent-id",
						title: "Build agent-memory v0.1",
						branch: "goal/agent-memory-v01",
						specExcerpt: "Build a memory subsystem with semantic recall.",
						rootTitle: "Ship agent-memory v0.1 → v1.0",
					},
					divergencePolicy: "balanced",
				}),
			);
			assert.ok(promptPath);
			const content = fs.readFileSync(promptPath!, "utf-8");

			assert.ok(content.includes("## You Are A Child Goal"), "child stanza missing");
			assert.ok(content.includes("## Mid-Goal Decomposition"), "mid-goal stanza missing");
			assert.ok(
				!content.includes("## Goal Decomposition\n\nThis is a **top-level goal**"),
				"top-level stanza must not appear for child goal",
			);

			// Splice order: child ⟶ spec ⟶ mid-goal.
			const childIdx = content.indexOf("## You Are A Child Goal");
			const specIdx = content.indexOf("# Goal\n\n**Child Goal Test**");
			const midIdx = content.indexOf("## Mid-Goal Decomposition");
			assert.ok(childIdx >= 0, "child stanza index");
			assert.ok(specIdx > childIdx, "spec must follow child stanza");
			assert.ok(midIdx > specIdx, "mid-goal stanza must follow spec");

			// Policy interpolated into mid-goal stanza.
			assert.ok(content.includes("Divergence policy: `balanced`"), "policy not interpolated for child goal");
		});

		it("parent-workflow goal: top-level stanza shows planning-loop hint", () => {
			const promptPath = assembleSystemPrompt(
				"test-parent-wf",
				makeParts({
					goalTitle: "Big Multi-Phase Goal",
					goalState: "in-progress",
					goalSpec: "Coordinate v0.1 → v1.0.",
					rolePrompt: "You are the team lead.",
					roleName: "team-lead",
					isTeamLead: true,
					isTopLevelTeamLead: true,
					divergencePolicy: "strict",
					maxConcurrentChildren: 4,
					goalWorkflowId: "parent",
				}),
			);
			assert.ok(promptPath);
			const content = fs.readFileSync(promptPath!, "utf-8");

			assert.ok(content.includes("## Goal Decomposition"), "top-level stanza missing");
			assert.ok(
				content.includes("Planning loop (because your workflow is `parent`)"),
				"planning-loop hint missing for parent-workflow goal",
			);
			assert.ok(content.includes("currently 4"), "concurrency cap not interpolated");
		});

		it("non-team-lead role: no nesting stanzas at all", () => {
			const promptPath = assembleSystemPrompt(
				"test-coder",
				makeParts({
					goalTitle: "Some Goal",
					goalState: "in-progress",
					goalSpec: "Do the work.",
					rolePrompt: "You are a coder.",
					roleName: "coder",
					isTeamLead: false,
				}),
			);
			assert.ok(promptPath);
			const content = fs.readFileSync(promptPath!, "utf-8");

			assert.ok(!content.includes("## Goal Decomposition"), "top-level stanza must not appear for coder");
			assert.ok(!content.includes("## Mid-Goal Decomposition"), "mid-goal stanza must not appear for coder");
			assert.ok(!content.includes("## You Are A Child Goal"), "child stanza must not appear for coder");
		});
	});
});
