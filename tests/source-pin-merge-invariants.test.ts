/**
 * Source-pin tests for known silent merge-loss regressions.
 *
 * Each test here pins a single load-bearing symbol or substring that has
 * previously vanished from the codebase via silent merge-conflict
 * resolution. The pins are deliberately blunt — they read the owning file
 * as text and assert a unique substring exists. A behavioural unit test
 * would not catch the bug class because the surrounding code is intact;
 * only the wiring is dropped.
 *
 * If one of these tests fails: DO NOT delete the test. The fix is to
 * restore the dropped block from the referenced restoration commit and
 * keep the pin in place. Each pin includes the original-add commit and
 * the most recent restoration commit so future agents can see how many
 * times the same hunk has been silently dropped.
 *
 * See docs/audit/silent-merge-loss-2026-05-15.md for the full audit.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(REPO_ROOT, p), "utf-8");

function assertTextInOrder(text: string, needles: string[], message: string): void {
	let from = 0;
	for (const needle of needles) {
		const idx = text.indexOf(needle, from);
		assert.notEqual(idx, -1, `${message}\nMissing or out-of-order substring: ${needle}`);
		from = idx + needle.length;
	}
}

describe("Source pin — merge-loss invariants", () => {
	it("server.ts dispatches tryHandleNestedGoalRoute (restored by ea921d7b)", () => {
		const text = read("src/server/server.ts");
		assert.ok(
			text.includes("tryHandleNestedGoalRoute("),
			"src/server/server.ts must call tryHandleNestedGoalRoute() in handleApiRoute.\n" +
			"Without this dispatch every nested-goal REST route (descendants, subgoal\n" +
			"CRUD, plan endpoints) returns 404 silently. Team-leads then fail to spawn\n" +
			"children with no actionable error. Originally added in the nested-goal\n" +
			"routes change; restored by ea921d7b after a silent merge loss.\n" +
			"DO NOT delete this pin — restore the dropped dispatch instead.",
		);
	});

	it("server.ts wires groupPolicyStore.setSubgoalsEnabledGetter (restored by 415acda6)", () => {
		const text = read("src/server/server.ts");
		assert.ok(
			text.includes("groupPolicyStore.setSubgoalsEnabledGetter("),
			"src/server/server.ts must call groupPolicyStore.setSubgoalsEnabledGetter\n" +
			"during boot to inject the preferences getter that gates the Children\n" +
			"tool group (goal_spawn_child, goal_plan_propose, goal_decide_mutation).\n" +
			"Without this call the getter stays undefined, getSubgoalsEnabled() returns\n" +
			"false unconditionally, and every team-lead loses those tools silently.\n" +
			"This regression has hit the codebase repeatedly — restored by 415acda6\n" +
			"most recently. DO NOT delete this pin.\n" +
			"Independently pinned by tests/server-subgoals-getter-wired.test.ts.",
		);
	});

	it("server.ts exposes /api/goals/:id/descendants route (restored by 2c08b07e)", () => {
		const text = read("src/server/server.ts");
		assert.ok(
			text.includes("/^\\/api\\/goals\\/([^/]+)\\/descendants$/"),
			"src/server/server.ts must contain the /api/goals/:goalId/descendants\n" +
			"GET handler. Without it the Plan tab silently drops all archived\n" +
			"children from the descendant list. Restored by 2c08b07e after a silent\n" +
			"merge loss that broke the Plan tab archived rollup for a full UI session.\n" +
			"DO NOT delete this pin — restore the dropped route instead.",
		);
	});

	it("server.ts exposes /api/goals/:id/tree-cost route (restored by 2c08b07e)", () => {
		const text = read("src/server/server.ts");
		assert.ok(
			text.includes("/^\\/api\\/goals\\/([^/]+)\\/tree-cost$/"),
			"src/server/server.ts must contain the /api/goals/:goalId/tree-cost GET\n" +
			"handler. Without it the cost rollup shows zero archived spend and the\n" +
			"Plan tab dashboard silently underreports total cost. Restored by 2c08b07e\n" +
			"alongside the descendants route. DO NOT delete this pin.",
		);
	});

	it("server.ts wires goalCompletedDispatcher into the TeamManager construction (restored by this EXT-01 fix)", () => {
		const text = read("src/server/server.ts");
		assertTextInOrder(
			text,
			[
				"new TeamManager(sessionManager, {",
				"goalCompletedDispatcher:",
				"dispatchGoalCompleted(",
				"hasGoalCompletedProviders:",
				"resolveGoalPullRequest:",
			],
			"src/server/server.ts must pass goalCompletedDispatcher (bridging to\n" +
			"LifecycleHub.dispatchGoalCompleted), hasGoalCompletedProviders and\n" +
			"resolveGoalPullRequest into the TeamManager construction. Without this\n" +
			"wiring TeamManager.dispatchGoalCompletedOnce() returns immediately and\n" +
			"the `goalCompleted` provider hook (e.g. the Hindsight memory pack's\n" +
			"outcome retention) NEVER fires in production, even though the loader\n" +
			"accepts the hook and team-manager unit tests pass — only the server.ts\n" +
			"wiring is dropped. Originally added in 00301569, silently dropped by\n" +
			"merge b687d93d (origin/master into aj-current took master's side of the\n" +
			"hunk), restored by this EXT-01 fix. The same merge also dropped the\n" +
			"loader allowlist entry, which is behaviourally pinned by\n" +
			"tests/pack-providers-loader.test.ts. DO NOT delete this pin — restore\n" +
			"the dropped wiring instead.",
		);
	});

	it("proposal-panels.ts contains goal-form-subgoals-toggle testid (restored by a35d7f34)", () => {
		const text = read("src/app/proposal-panels.ts");
		assert.ok(
			text.includes("goal-form-subgoals-toggle"),
			"src/app/proposal-panels.ts::renderGoalForm must render the 'Allow subgoals'\n" +
			"checkbox with data-testid=\"goal-form-subgoals-toggle\" in the goal\n" +
			"proposal modal. Originally shipped in 492d88e1, silently dropped during\n" +
			"a later merge, restored by a35d7f34. Without it operators cannot\n" +
			"disable subgoal spawning per-goal at creation time.\n" +
			"DO NOT delete this pin — keep it alongside\n" +
			"tests/proposal-form-controls-source-pinned.test.ts.",
		);
	});

	it("proposal-panels.ts contains goal-form-max-depth testid (restored by a35d7f34)", () => {
		const text = read("src/app/proposal-panels.ts");
		assert.ok(
			text.includes("goal-form-max-depth"),
			"src/app/proposal-panels.ts::renderGoalForm must render the 'Max depth' number\n" +
			"input with data-testid=\"goal-form-max-depth\". Originally shipped in\n" +
			"492d88e1, silently dropped during a later merge, restored by a35d7f34.\n" +
			"Without it operators cannot tighten the per-goal nesting cap at\n" +
			"creation time. DO NOT delete this pin.",
		);
	});

	// ----------------------------------------------------------------------
	// Proposal-modal Workflow/Roles tabs pins (this proposal-modal-tabs fix).
	//
	// Regression commit: 46e21256 "Merge child: plan-propose UX + dependsOn
	// fallback (d4be2150)" silently dropped the entire inline-workflow +
	// inline-roles editor surface from src/app/render.ts. The pre-merge
	// parent (46e21256^1) had 13 references to `inlineWorkflowYaml` and 11
	// to `inlineRolesYaml`; the merge result has zero of either. The merge
	// took the trunk side of render.ts wholesale (-617 net lines) without
	// preserving the proposal-modal customisation surface.
	//
	// The replacement landed by this proposal-modal-tabs fix is NOT the old
	// YAML <details>+textarea UX — it is a tabbed surface that reuses the
	// main Workflows/Roles page renderers (see
	// docs/audit/silent-merge-loss-2026-05-15.md and the gated design doc).
	// The pins below assert the *new* user-facing surface exists; deleting
	// them or weakening them to allow the old YAML textareas is a hard fail.
	// ----------------------------------------------------------------------

	it("proposal-panels.ts wires draft inlineWorkflow state into the proposal modal (this proposal-modal-tabs fix)", () => {
		const text = read("src/app/proposal-panels.ts");
		assert.ok(
			text.includes("inlineWorkflow"),
			"src/app/proposal-panels.ts must reference `inlineWorkflow` somewhere in the\n" +
			"goal proposal modal — it is the draft-scoped customised-workflow\n" +
			"snapshot the Workflow tab edits and the submit path forwards as the\n" +
			"`workflow` field of createGoal. Regression commit 46e21256 silently\n" +
			"dropped the entire inline-workflow editor surface from render.ts (13\n" +
			"`inlineWorkflowYaml` refs at 46e21256^1 → 0 at 46e21256). Restored\n" +
			"by this proposal-modal-tabs fix as a tabbed surface reusing the\n" +
			"Workflows page renderers — NOT the old YAML textarea. If this pin\n" +
			"fails, restore the proposal modal's Workflow tab rather than the old\n" +
			"<details>+textarea block. DO NOT delete this pin.",
		);
	});

	it("proposal-panels.ts wires draft inlineRoles state into the proposal modal (this proposal-modal-tabs fix)", () => {
		const text = read("src/app/proposal-panels.ts");
		assert.ok(
			text.includes("inlineRoles"),
			"src/app/proposal-panels.ts must reference `inlineRoles` somewhere in the\n" +
			"goal proposal modal — it is the draft-scoped per-role customisation\n" +
			"map the Roles tab edits and the submit path forwards to createGoal.\n" +
			"Regression commit 46e21256 silently dropped the entire inline-roles\n" +
			"editor surface from render.ts (11 `inlineRolesYaml` refs at 46e21256^1\n" +
			"→ 0 at 46e21256). Restored by this proposal-modal-tabs fix as a\n" +
			"tabbed surface reusing the Roles page renderers — NOT the old YAML\n" +
			"textarea. If this pin fails, restore the proposal modal's Roles tab\n" +
			"rather than the old <details>+textarea block. DO NOT delete this pin.",
		);
	});

	it("proposal-panels.ts renders the proposal-modal Workflow tab (this proposal-modal-tabs fix)", () => {
		const text = read("src/app/proposal-panels.ts");
		assert.ok(
			text.includes('data-testid="goal-proposal-tab-workflow"'),
			"src/app/proposal-panels.ts must render the proposal modal's Workflow tab\n" +
			"button with data-testid=\"goal-proposal-tab-workflow\". This is the\n" +
			"user-visible affordance that lets operators inspect/customise the\n" +
			"selected workflow for a goal at creation time. Regression commit\n" +
			"46e21256 silently dropped the entire inline-workflow editor surface\n" +
			"from render.ts; this proposal-modal-tabs fix restores it as a tab\n" +
			"alongside Goal and Roles. DO NOT delete this pin — restore the\n" +
			"dropped tab button instead.",
		);
	});

	it("proposal-panels.ts renders the proposal-modal Roles tab (this proposal-modal-tabs fix)", () => {
		const text = read("src/app/proposal-panels.ts");
		assert.ok(
			text.includes('data-testid="goal-proposal-tab-roles"'),
			"src/app/proposal-panels.ts must render the proposal modal's Roles tab button\n" +
			"with data-testid=\"goal-proposal-tab-roles\". This is the user-visible\n" +
			"affordance that lets operators inspect/customise per-goal role\n" +
			"overrides at creation time. Regression commit 46e21256 silently\n" +
			"dropped the entire inline-roles editor surface from render.ts; this\n" +
			"proposal-modal-tabs fix restores it as a tab alongside Goal and\n" +
			"Workflow. DO NOT delete this pin — restore the dropped tab button\n" +
			"instead.",
		);
	});

	it("proposal-panels.ts renders the proposal-modal Metadata tab stable IDs (metadata-tab fix)", () => {
		const text = read("src/app/proposal-panels.ts");
		for (const required of [
			'id="goal-proposal-tab-metadata"',
			'data-testid="goal-proposal-tab-metadata"',
			'aria-controls="goal-proposal-panel-metadata"',
			'id="goal-proposal-panel-metadata"',
			'data-testid="goal-proposal-panel-metadata"',
			'aria-labelledby="goal-proposal-tab-metadata"',
		]) {
			assert.ok(
				text.includes(required),
				"src/app/proposal-panels.ts must render the proposal modal's Metadata\n" +
				"tab and panel with stable IDs/test IDs: " + required + "\n" +
				"The Metadata tab owns the per-goal metadata key/value editor;\n" +
				"without these stable selectors accessibility wiring, keyboard focus,\n" +
				"and browser E2E coverage silently regress. DO NOT delete this pin —\n" +
				"restore the dropped Metadata tab/panel wiring instead.",
			);
		}
	});

	it("proposal-panels.ts orders proposal tabs Goal, Workflow, Roles, Metadata, Sub-goals (metadata-tab fix)", () => {
		const text = read("src/app/proposal-panels.ts");
		assertTextInOrder(
			text,
			[
				'id="goal-proposal-tab-goal"',
				'id="goal-proposal-tab-workflow"',
				'id="goal-proposal-tab-roles"',
				'id="goal-proposal-tab-metadata"',
				'id="goal-proposal-tab-subgoals"',
			],
			"src/app/proposal-panels.ts must render proposal tabs in the order\n" +
			"Goal → Workflow → Roles → Metadata → Sub-goals. The Metadata tab\n" +
			"must sit immediately after Roles and before Sub-goals when the\n" +
			"Sub-goals tab is visible.",
		);

		const keydownBlock = text.match(/const onTabKey = \(e: KeyboardEvent\) => \{[\s\S]*?\n\t\};/)?.[0] ?? "";
		assertTextInOrder(
			keydownBlock,
			['"goal"', '"workflow"', '"roles"', '"metadata"'],
			"src/app/proposal-panels.ts::onTabKey must include Metadata in\n" +
			"ArrowLeft/ArrowRight/Home/End keyboard navigation after Roles.",
		);
		assert.ok(
			keydownBlock.includes('"subgoals"'),
			"src/app/proposal-panels.ts::onTabKey must continue to include\n" +
			"Sub-goals after Metadata when that tab is visible.",
		);
	});

	it("api.ts createGoal opts include `workflow` (this proposal-modal-tabs fix)", () => {
		const text = read("src/app/api.ts");
		// Pin the opts-field name `workflow` on the createGoal signature. We
		// match the parameter declaration shape so the pin doesn't false-fire
		// on incidental uses of the word "workflow" elsewhere in the file.
		assert.ok(
			/createGoal\([\s\S]*?workflow\?\s*:/.test(text),
			"src/app/api.ts::createGoal opts must declare a `workflow?: …` field.\n" +
			"This is the wire field the proposal modal uses to send a draft-scoped\n" +
			"customised inline workflow (snapshotted onto the goal). Regression\n" +
			"commit 46e21256 silently dropped the UI that fed this field; this\n" +
			"proposal-modal-tabs fix restores the UI and depends on the wire\n" +
			"field staying in the createGoal signature. DO NOT delete this pin —\n" +
			"restore the dropped opts field instead.",
		);
	});

	it("api.ts createGoal opts include `inlineRoles` (this proposal-modal-tabs fix)", () => {
		const text = read("src/app/api.ts");
		assert.ok(
			/createGoal\([\s\S]*?inlineRoles\?\s*:/.test(text),
			"src/app/api.ts::createGoal opts must declare an `inlineRoles?: …`\n" +
			"field. This is the wire field the proposal modal uses to send\n" +
			"draft-scoped per-role customisations (snapshotted onto the goal).\n" +
			"Regression commit 46e21256 silently dropped the UI that fed this\n" +
			"field; this proposal-modal-tabs fix restores the UI and depends on\n" +
			"the wire field staying in the createGoal signature. DO NOT delete\n" +
			"this pin — restore the dropped opts field instead.",
		);
	});

	it("pack-contributions.ts parses activation.activeWhenConfig (restored by the w2-activewhenconfig-restore fix)", () => {
		const text = read("src/server/agent/pack-contributions.ts");
		assert.ok(
			text.includes("activeWhenConfig?: Record<string, string[]>;") && text.includes("isPlainObject(raw.activeWhenConfig)"),
			"src/server/agent/pack-contributions.ts must declare `ProviderActivation.activeWhenConfig`\n" +
			"and parse it in parseProviderActivation(). Without this OR escape hatch a managed\n" +
			"deployment-mode provider (e.g. Hindsight memory) can never activate without an\n" +
			"externalUrl, even in managed mode. Originally added by 21994f37; silently dropped\n" +
			"by merge commit b687d93d (first parent 06498f81 had 7 references, merge result had\n" +
			"0); restored by the w2-activewhenconfig-restore fix. DO NOT delete this pin — restore\n" +
			"the dropped parsing instead. Independently pinned by the two activeWhenConfig tests\n" +
			"in tests/pack-providers-loader.test.ts.",
		);
	});

	it("pack-contribution-registry.ts consumes activation.activeWhenConfig (restored by the w2-activewhenconfig-restore fix)", () => {
		const text = read("src/server/extension-host/pack-contribution-registry.ts");
		assert.ok(
			text.includes("const { activeWhenConfig, requiresConfig } = activation;"),
			"src/server/extension-host/pack-contribution-registry.ts::providerActivationSatisfied\n" +
			"must check `activation.activeWhenConfig` as an OR escape hatch before falling back to\n" +
			"`requiresConfig`. Without this the parsed activeWhenConfig gate is dead data — a\n" +
			"managed-mode provider stays dormant despite declaring the linkage. Originally added\n" +
			"by 21994f37; silently dropped by the same merge (b687d93d) that dropped the parsing\n" +
			"in pack-contributions.ts; restored by the w2-activewhenconfig-restore fix. DO NOT\n" +
			"delete this pin — restore the dropped gating logic instead.",
		);
	});

	it("pack-contribution-registry.ts exposes getRawPack (restored by the w2-getrawpack-restore fix)", () => {
		const text = read("src/server/extension-host/pack-contribution-registry.ts");
		assert.ok(
			text.includes("getRawPack(projectId: string | undefined, packId: string): PackContributions | undefined {"),
			"src/server/extension-host/pack-contribution-registry.ts must expose\n" +
			"PackContributionRegistry.getRawPack() — the activation-UNFILTERED winning-pack\n" +
			"contributions lookup. Without it the managed-runtime REST surface\n" +
			"(/api/pack-runtimes/:id/{capabilities,start,restart}) cannot classify the\n" +
			"deployment mode from a pack whose provider is still dormant (e.g. Hindsight's\n" +
			"external-mode `memory` provider before `externalUrl` is configured), and\n" +
			"misclassifies fresh/default installs as provider-less. Originally added by\n" +
			"6552422c; silently dropped by merge commit b687d93d (first parent 06498f81 had\n" +
			"it, merge result did not); restored by the w2-getrawpack-restore fix. DO NOT\n" +
			"delete this pin — restore the dropped method instead. Independently pinned by\n" +
			"the \"getRawPack returns a DORMANT provider\" test in tests/pack-contributions.test.ts.",
		);
	});

	it("pack-contribution-registry.ts filters disabled runtimes by listName (restored by the w2-getrawpack-restore fix)", () => {
		const text = read("src/server/extension-host/pack-contribution-registry.ts");
		assert.ok(
			text.includes("private readonly disabledRuntimes?: DisabledEntrypointsLookup,")
			&& text.includes("contrib.runtimes.filter((r) => !disabledRuntimes.has(r.listName))"),
			"src/server/extension-host/pack-contribution-registry.ts must accept a\n" +
			"`disabledRuntimes` activation-override lookup (DisabledRefs.runtimes) and filter\n" +
			"`contrib.runtimes` by listName in build(). Without this a runtime disabled via\n" +
			"pack_activation stays visible in getPack()/getRuntime(), so the supervisor never\n" +
			"404s it and runtime listings never omit it — the kill-switch is dead data.\n" +
			"Originally added by d0bc4358; silently dropped by the same merge (b687d93d) that\n" +
			"dropped getRawPack; restored by the w2-getrawpack-restore fix. DO NOT delete this\n" +
			"pin — restore the dropped filtering logic instead.",
		);
	});

	it("server-host-api.ts exposes host.agents.spawnGoal, the experiment-runner seam (restored by W2.G)", () => {
		const text = read("src/server/extension-host/server-host-api.ts");
		assertTextInOrder(
			text,
			[
				"import type { SpawnChildGoalOpts } from \"../agent/experiment-spawn-goal.js\";",
				"spawnGoal(opts: {",
				"spawnChildGoal?: (ownerSessionId: string, opts: SpawnChildGoalOpts) => Promise<{ goalId: string }>;",
				"spawnGoal: async (goalOpts) => {",
			],
			"src/server/extension-host/server-host-api.ts must declare the `spawnGoal`\n" +
			"verb on ServerHostAgentsApi, the `spawnChildGoal` injection seam on\n" +
			"CreateServerHostApiOptions, and implement `spawnGoal` on the `agents`\n" +
			"namespace (recursion denial via assertCanSpawn, backend-unavailable,\n" +
			"spec/title/runKey validation, forwarding to the injected closure).\n" +
			"Originally added by ebf72707 \"feat(extension-host): add\n" +
			"host.agents.spawnGoal experiment-runner seam\"; silently dropped by merge\n" +
			"b687d93d (first parent had 7 references to spawnChildGoal, the merge\n" +
			"result had 0) while the implementation (experiment-spawn-goal.ts), its\n" +
			"unit tests, and the experiment-runner pack all survived — a pure wiring\n" +
			"drop. Restored by finding W2.G. DO NOT delete this pin — restore the\n" +
			"dropped surface instead. Independently pinned behaviourally by\n" +
			"tests/host-agents-spawn-goal.test.ts and tests/host-agents-scope.test.ts.",
		);
	});

	it("server.ts injects spawnChildGoal into the route/action host.agents surface (restored by W2.G)", () => {
		const text = read("src/server/server.ts");
		assert.ok(
			text.includes('import { spawnExperimentChildGoal } from "./agent/experiment-spawn-goal.js";'),
			"src/server/server.ts must import spawnExperimentChildGoal.",
		);
		const injectionCount = (text.match(/spawnChildGoal: \(ownerSessionId: string, spawnOpts\) => spawnExperimentChildGoal\(\{/g) ?? []).length;
		assert.equal(
			injectionCount,
			2,
			"src/server/server.ts must inject `spawnChildGoal` (backed by\n" +
			"spawnExperimentChildGoal) into BOTH the action and route\n" +
			"createServerHostApi() call sites, so host.agents.spawnGoal has a live\n" +
			"backend wherever a pack handler can reach it. Originally added by\n" +
			"ebf72707; silently dropped by merge b687d93d alongside the\n" +
			"server-host-api.ts surface; restored by finding W2.G. DO NOT delete this\n" +
			"pin — restore the dropped injection instead.",
		);
		// Least privilege: the masked provider-hook host (capabilities.store-only)\n" +
		// must NEVER receive the spawnGoal backend — pinned by the masked-namespace\n" +
		// denial test in tests/host-agents-spawn-goal.test.ts.
		const providerHostMatch = text.match(/providerHostApi: \(\{ sessionId, packId \}\) => createServerHostApi\(\{[\s\S]*?\}\),/);
		assert.ok(providerHostMatch, "src/server/server.ts must still define providerHostApi via createServerHostApi.");
		assert.ok(
			!providerHostMatch[0].includes("spawnChildGoal"),
			"the masked provider-hook host must NOT inject spawnChildGoal — it stays\n" +
			"least-privilege (capabilityMask: { store: true }) with agents denied.",
		);
	});
});
