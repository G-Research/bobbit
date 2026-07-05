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

	it("server.ts exposes registerPackRuntimeSupervisorFactory (restored by the w2-pack-runtimes-restore fix)", () => {
		const text = read("src/server/server.ts");
		assert.ok(
			text.includes("export function registerPackRuntimeSupervisorFactory(factory: PackRuntimeSupervisorFactory | null): void {"),
			"src/server/server.ts must export registerPackRuntimeSupervisorFactory() — the\n" +
			"test-only seam that injects a fully-mocked PackRuntimeSupervisor (no Docker\n" +
			"daemon) so the /api/pack-runtimes/* routes and the marketplace managed-runtime\n" +
			"activation/uninstall paths can be exercised end-to-end in E2E. Without it every\n" +
			"caller of `mod.registerPackRuntimeSupervisorFactory(...)` in\n" +
			"tests/e2e/marketplace-runtime-activation.spec.ts throws \"is not a function\" and\n" +
			"the whole P2/P3 managed-runtime surface is untestable. The underlying\n" +
			"PackRuntimeSupervisor class (src/server/runtimes/pack-runtime-supervisor.ts) was\n" +
			"NEVER dropped — only this server.ts wiring (interfaces, factory seam, REST\n" +
			"routes, activation/uninstall threading) vanished. Originally added by 4a48eb9b;\n" +
			"silently dropped by merge commit b687d93d (first parent 06498f81 had it, merge\n" +
			"result did not); restored by the w2-pack-runtimes-restore fix. DO NOT delete this\n" +
			"pin — restore the dropped wiring instead. Independently pinned end-to-end by\n" +
			"tests/e2e/pack-runtimes-api.spec.ts, tests/e2e/marketplace-runtime-activation.spec.ts,\n" +
			"tests/e2e/pack-runtimes-start-config.spec.ts, and tests/e2e/hindsight-config-write.spec.ts.",
		);
	});

	it("server.ts exposes the sessionless /api/ext/pack-route/:packId/:routeName seam (restored by the w2-pack-runtimes-restore fix)", () => {
		const text = read("src/server/server.ts");
		assert.ok(
			text.includes("url.pathname.match(/^\\/api\\/ext\\/pack-route\\/([^/]+)\\/([^/]+)$/)"),
			"src/server/server.ts must handle GET/POST /api/ext/pack-route/:packId/:routeName —\n" +
			"the sessionless, admin-bearer, BUILT-IN-pack-only seam the Marketplace uses to\n" +
			"read/write a built-in pack's route (e.g. Hindsight config) when `#/market` has no\n" +
			"active chat session to mint a surface token. Without it\n" +
			"tests/e2e/hindsight-config-write.spec.ts's POST returns 404 and the inline\n" +
			"Marketplace Configure form cannot persist. Originally added by e3f31960; silently\n" +
			"dropped by merge commit b687d93d; restored by the w2-pack-runtimes-restore fix.\n" +
			"DO NOT delete this pin — restore the dropped route instead. Independently pinned\n" +
			"end-to-end by tests/e2e/hindsight-config-write.spec.ts.",
		);
	});

	it("api.ts exposes the pack-runtimes client fetch wrappers (restored by the w2-pack-runtimes-restore fix)", () => {
		const text = read("src/app/api.ts");
		assertTextInOrder(
			text,
			[
				"export function getPackRuntimeCapabilities(",
				"export function downPackRuntime(",
				"export function purgePackRuntime(",
				"export function listPackRuntimes(",
				"export function startPackRuntime(",
				"export function stopPackRuntime(",
				"export function getPackRuntimeLogs(",
			],
			"src/app/api.ts must expose the pack-runtimes client fetch wrappers\n" +
			"(getPackRuntimeCapabilities/downPackRuntime/purgePackRuntime/listPackRuntimes/\n" +
			"startPackRuntime/stopPackRuntime/getPackRuntimeLogs). Without them\n" +
			"marketplace-page.ts has no client to the restored /api/pack-runtimes/* REST\n" +
			"surface and the managed-runtime consent card + start/stop controls cannot\n" +
			"function even though the server routes exist. Originally added alongside the\n" +
			"server REST routes; silently dropped by merge commit b687d93d; restored by the\n" +
			"w2-pack-runtimes-restore fix. DO NOT delete this pin — restore the dropped\n" +
			"wrappers instead. Independently pinned by tests/marketplace-runtime-consent.spec.ts.",
		);
	});

	it("marketplace-page.ts exposes the managed-runtime consent-card exports (restored by the w2-pack-runtimes-restore fix)", () => {
		const text = read("src/app/marketplace-page.ts");
		assertTextInOrder(
			text,
			[
				'runtime: "runtimes",',
				"export function masterToggleDisabledRefs(",
				"export function runtimeRestPackId(",
				"export function runtimeCapabilityCacheKey(",
				"export function invalidateRuntimeCapabilities(",
				"export function ensureRuntimeCapabilities(",
				"export function renderRuntimeRow(",
				"export function renderRuntimeConsentCard(",
				"export function renderRuntimeConsentCardView(",
				"export function activationEntityTotal(",
				"export function activationEntityEnabledCount(",
			],
			"src/app/marketplace-page.ts must export the managed-runtime consent-card\n" +
			"pipeline (runtimeRestPackId/runtimeCapabilityCacheKey/ensureRuntimeCapabilities/\n" +
			"invalidateRuntimeCapabilities/renderRuntimeRow/renderRuntimeConsentCard/\n" +
			"renderRuntimeConsentCardView), the schema-v2-aware activation helpers\n" +
			"(masterToggleDisabledRefs/activationEntityTotal/activationEntityEnabledCount),\n" +
			"and map `runtime: \"runtimes\"` in ACTIVATION_KIND_KEY. Without them\n" +
			"tests/marketplace-runtime-consent.spec.ts's fixture bundle fails to build\n" +
			"(\"No matching export\"), the pre-start consent disclosure (design §8) cannot\n" +
			"render, individual runtime toggles cannot address DisabledRefs.runtimes, and\n" +
			"the master OFF toggle silently leaves a managed runtime enabled (Docker keeps\n" +
			"running while the pack reads Disabled). Originally added alongside the P3\n" +
			"consent design (26b87339); silently dropped by merge commit b687d93d; restored\n" +
			"by the w2-pack-runtimes-restore fix (the row/kind-key/master-payload half was\n" +
			"initially missed and caught by adversarial review of PR #25 — the consent card\n" +
			"alone renders nothing without renderRuntimeRow mounting it). DO NOT delete this\n" +
			"pin — restore the dropped exports instead. Independently pinned by\n" +
			"tests/marketplace-runtime-consent.spec.ts.",
		);
	});

	it("server.ts exports resolveManagedRuntimeContext + PackRuntimeSupervisorLike (restored by the w2-managed-runtime-context-restore fix, Finding W2.K)", () => {
		const text = read("src/server/server.ts");
		assertTextInOrder(
			text,
			[
				"export interface PackRuntimeSupervisorLike {",
				"export async function resolveManagedRuntimeContext(",
			],
			"src/server/server.ts must export both `PackRuntimeSupervisorLike` and\n" +
			"`resolveManagedRuntimeContext()` — the SINGLE source of truth shared by the\n" +
			"LifecycleHub provider-hook path (`runtimeResolver`) and the pack-ROUTE dispatch\n" +
			"path (`/api/ext/route/:name` and the sessionless `/api/ext/pack-route/:packId/\n" +
			":routeName`), so a managed provider and its sibling routes always agree on the\n" +
			"runtime linkage (`{ baseUrl, headers, status }`) they receive. Without it every\n" +
			"managed-mode pack route (Hindsight status/recall/retain/reflect/banks) sees\n" +
			"ctx.runtime undefined and stays dormant, unable to reach a running managed\n" +
			"runtime. Originally added by be12d016 (\"fix(ext-host): inject managed runtime\n" +
			"context into pack route calls\"); silently dropped end-to-end by merge commit\n" +
			"b687d93d (b687d93d^1 has both symbols, b687d93d has neither); restored\n" +
			"alongside the rest of the /api/pack-runtimes REST family by the\n" +
			"w2-pack-runtimes-restore fix (PR #25), which this w2-managed-runtime-context-\n" +
			"restore fix (Finding W2.K) confirmed and wired the remaining worker-boundary\n" +
			"delta on top of (see the module-host-worker.ts pin below). DO NOT delete this\n" +
			"pin — restore the dropped symbols instead. Independently pinned end-to-end by\n" +
			"tests/server-managed-runtime-context.test.ts (10 assertions).",
		);
	});

	it("module-host-worker.ts forwards ctx.runtime across the route worker boundary (restored by the w2-managed-runtime-context-restore fix, Finding W2.K)", () => {
		const text = read("src/server/extension-host/module-host-worker.ts");
		assert.ok(
			/runtime:\s*\(req\.ctx as \{ runtime\?: unknown \} \| undefined\)\?\.runtime,/.test(text),
			"src/server/extension-host/module-host-worker.ts::ModuleHost must serialize\n" +
			"`req.ctx.runtime` onto the route worker's `serCtx` alongside sessionId/tool/\n" +
			"projectId/workingDir. Without this line the managed-runtime linkage that\n" +
			"resolveManagedRuntimeContext() resolves in server.ts for a routed pack (e.g.\n" +
			"Hindsight status/recall) never crosses the MessagePort into the confined route\n" +
			"module — module-host-bootstrap.ts's `...(msg.ctx.runtime ? { runtime:\n" +
			"msg.ctx.runtime } : {})` reconstruction receives ctx.runtime === undefined even\n" +
			"though the host resolved a live runtime, so every managed-mode route silently\n" +
			"stays dormant. Originally added by be12d016; silently dropped end-to-end by\n" +
			"merge commit b687d93d; the w2-pack-runtimes-restore fix (PR #25) restored\n" +
			"resolveManagedRuntimeContext() and both server.ts call sites but missed this\n" +
			"worker-boundary forwarding line, since server-managed-runtime-context.test.ts\n" +
			"exercises the resolver in isolation and cannot see across the worker boundary.\n" +
			"Restored by the w2-managed-runtime-context-restore fix (Finding W2.K). DO NOT\n" +
			"delete this pin — restore the dropped forwarding instead. Independently pinned\n" +
			"end-to-end by the \"forwards ctx.runtime to the route handler across the worker\n" +
			"boundary\" test in tests/extension-host-route-dispatcher.test.ts.",
		);
	});

	it("module-host-worker.ts forwards ctx.goalId/ctx.roleName across the route worker boundary (restored by the w2-ctx-goalid-forwarding fix, Finding W2.L)", () => {
		const text = read("src/server/extension-host/module-host-worker.ts");
		assert.ok(
			/goalId:\s*\(req\.ctx as \{ goalId\?: unknown \} \| undefined\)\?\.goalId,/.test(text)
			&& /roleName:\s*\(req\.ctx as \{ roleName\?: unknown \} \| undefined\)\?\.roleName,/.test(text),
			"src/server/extension-host/module-host-worker.ts::ModuleHost must serialize\n" +
			"`req.ctx.goalId` and `req.ctx.roleName` onto the route worker's `serCtx`\n" +
			"alongside sessionId/tool/projectId/runtime/workingDir. Without these two lines\n" +
			"the trusted goal/role context that action-dispatcher.ts's ActionHandlerCtx\n" +
			"carries (goalId derived from session state, then teamGoalId; roleName from the\n" +
			"calling session) never crosses the MessagePort into the confined route module —\n" +
			"module-host-bootstrap.ts's `goalId: msg.ctx.goalId, roleName: msg.ctx.roleName`\n" +
			"reconstruction receives both as undefined even though the host resolved trusted\n" +
			"values, so a route handler (e.g. Hindsight manual retain auto-tagging) can never\n" +
			"tag a retained memory with the calling goal/role. Originally added by eba1ee3d\n" +
			"(\"Auto-tag Hindsight retain route context\"); silently dropped end-to-end by the\n" +
			"same merge that dropped the sibling ctx.runtime forwarding line (see the\n" +
			"pin above) — same class of loss, same file, same worker-boundary blind spot.\n" +
			"Restored by the w2-ctx-goalid-forwarding fix (Finding W2.L). DO NOT delete this\n" +
			"pin — restore the dropped forwarding instead. Independently pinned end-to-end by\n" +
			"the \"forwards trusted goal and role context to route handlers\" test in\n" +
			"tests/extension-host-route-dispatcher.test.ts.",
		);
	});

	it("config-cascade.ts exposes resolveRoleModelResolution + RoleModelResolution (restored by the w2-role-model-resolution-restore fix)", () => {
		const text = read("src/server/agent/config-cascade.ts");
		assert.ok(
			text.includes("resolveRoleModelResolution(roleName: string, projectId?: string): RoleModelResolution {")
			&& text.includes("export interface RoleModelResolution {")
			&& text.includes("export type RoleFieldSourceKind = \"role\" | \"inherited-role\" | \"default\";"),
			"src/server/agent/config-cascade.ts must expose ConfigCascade.resolveRoleModelResolution()\n" +
			"plus the RoleFieldSourceKind/RoleFieldSource/RoleModelResolution types. Without this the\n" +
			"Roles UI cannot render source badges (Project/Server/Built-in/pack name) or gate inline\n" +
			"edit affordances for a role's model/thinkingLevel fields. Originally added by 1fe14164\n" +
			"(\"Add role model/thinking source metadata to /api/roles\") with fixes c68ce4b6, d9325dc6,\n" +
			"c1581647; silently dropped by merge commit b687d93d (first parent had it, merge result\n" +
			"did not — same merge that dropped getRawPack, activeWhenConfig, and the goalCompletedDispatcher\n" +
			"wiring above); restored by the w2-role-model-resolution-restore fix. DO NOT delete this pin —\n" +
			"restore the dropped types/method instead. Independently pinned by the 6\n" +
			"resolveRoleModelResolution tests in tests/config-cascade.test.ts.",
		);
	});

	it("server.ts wires modelResolution into the /api/roles GET routes (restored by the w2-role-model-resolution-restore fix)", () => {
		const text = read("src/server/server.ts");
		assertTextInOrder(
			text,
			[
				"const withRoleResolution = (",
				"modelResolution: configCascade.resolveRoleModelResolution(String(r.item.name), projectId),",
				"json({ roles: resolved.map(r => withRoleResolution(r as any, projectId)) });",
				"json(withRoleResolution(found as any, qProjectId));",
			],
			"src/server/server.ts must serialize /api/roles (list) and /api/roles/:name (detail)\n" +
			"responses through withRoleResolution(), not the plain withOrigin() helper, so each role\n" +
			"carries a `modelResolution` field (model/thinkingLevel source hierarchy + editability).\n" +
			"Without this wiring the Roles UI has no way to render accurate source badges or decide\n" +
			"whether the inline model/thinking controls are editable at the current scope — it silently\n" +
			"falls back to guessing from the plain model/thinkingLevel strings. Originally added by\n" +
			"1fe14164, silently dropped by merge commit b687d93d alongside the config-cascade.ts\n" +
			"types/method (same merge, same hunk-loss pattern as getRawPack/activeWhenConfig above);\n" +
			"restored by the w2-role-model-resolution-restore fix. DO NOT delete this pin — restore\n" +
			"the dropped wiring instead.",
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
	it("session-setup.ts resolves and gates on resolvePreExistingTranscriptSetupMode (restored by the w2-transcript-recovery-restore fix)", () => {
		const text = read("src/server/agent/session-setup.ts");
		assert.ok(
			text.includes("export function resolvePreExistingTranscriptSetupMode(")
			&& text.includes('if (plan.bridgeOptions.claudeCodeSessionId || plan.claudeCodeSessionId) return "claude-code-resume";')
			&& (text.match(/const preExistingMode = resolvePreExistingTranscriptSetupMode\(plan\);/g) ?? []).length === 2
			&& (text.match(/\{ type: "switch_session"/g) ?? []).length === 2,
			"src/server/agent/session-setup.ts must export resolvePreExistingTranscriptSetupMode()\n" +
			"and gate both switch_session call sites (executeWorktreeAsync, spawnAgent) behind\n" +
			"its 'switch-session' result, with an explicit 'claude-code-resume' branch that skips\n" +
			"the Pi-only switch_session RPC. Without this a Claude Code continue/fork session\n" +
			"silently issues a switch_session command the Claude Code runtime cannot honor. \n" +
			"Originally added by 58f720cf; silently dropped by merge commit b687d93d (first\n" +
			"parent 06498f81 had 1 reference, second parent 61f0e62 had 0, merge result had 0 —\n" +
			"the same merge conflict resolution also reverted the createSessionBridge migration\n" +
			"in this file back to `new RpcBridge`, since both hunks sit in the same region);\n" +
			"restored by the w2-transcript-recovery-restore fix. DO NOT delete this pin — restore\n" +
			"the dropped gating instead. Independently pinned by the behavioural tests in\n" +
			"tests/session-setup-claude-code-preexisting.test.ts.",
		);
	});
	it("verification-harness.ts filters claude-code review models before set_model/initialModel (restored by the w2-review-model-filter-restore fix, Finding W2.N-b)", () => {
		const text = read("src/server/agent/verification-harness.ts");
		assert.ok(
			text.includes("export function isClaudeCodeReviewModel(")
			&& text.includes("export function resolvePiBackedReviewInitialModel(")
			&& text.includes("export function filterPiBackedReviewModelForSetModel(")
			&& (text.match(/const _pre\w*InitialModel = resolvePiBackedReviewInitialModel\(/g) ?? []).length === 3
			&& (text.match(/const piRoleModel_[rqs] = filterPiBackedReviewModelForSetModel\(roleModel_[rqs]\);/g) ?? []).length === 3
			&& (text.match(/const reviewModelPref = filterPiBackedReviewModelForSetModel\(this\.preferencesStore\.get\("default\.reviewModel"\) as string \| undefined\);/g) ?? []).length === 3,
			"src/server/agent/verification-harness.ts must filter claude-code/* runtime model\n" +
			"selections out of every Pi-backed review/QA spawn path (reviewer, agent-qa, and\n" +
			"the legacy direct sub-session) before they reach spawn-time initialModel,\n" +
			"applyModelString, or applyReviewModelOverrides. Without this filter a\n" +
			"claude-code/* role model or default.reviewModel preference silently spawns the\n" +
			"Claude Code runtime for a verification session or sends Pi an unsupported\n" +
			"`set_model claude-code/*` command, hard-failing the gate. Originally added by\n" +
			"58f720cf alongside the resolvePreExistingTranscriptSetupMode hunk pinned above\n" +
			"(same commit, session-setup.ts); silently dropped by the same merge commit\n" +
			"b687d93d, but in this file (verification-harness.ts had 7 references to\n" +
			"filterPiBackedReviewModelForSetModel on the first parent, 0 on the merge\n" +
			"result); restored by the w2-review-model-filter-restore fix (Finding W2.N-b, the\n" +
			"second half of the 58f720cf silent merge-drop, W2.N-a being the session-setup.ts\n" +
			"restore above). DO NOT delete this pin — restore the dropped filtering instead.\n" +
			"Independently pinned by the behavioural tests in\n" +
			"tests/verification-runtime-filter.test.ts.",
		);
	});
});
