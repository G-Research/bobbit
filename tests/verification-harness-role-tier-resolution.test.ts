/**
 * CLF-W1c (F5-read verify): does `VerificationHarness.resolveRoleForGoal` —
 * the shared lookup behind all three role-tier-aware spawn sites (reviewer
 * `runLlmReviewStep`, QA `runAgentQaStep`, and the legacy sub-session path) —
 * actually resolve a PROJECT-scoped role `model`/`thinkingLevel` override via
 * `configCascade`, and does a goal-scoped `inlineRoles` override win over it?
 *
 * This was previously uncovered by any test: `tests/builtin-role-thinking-tiers.test.ts`
 * pins the builtin tier VALUES, but nothing exercised
 * `resolveRoleForGoal`'s cascade/inline-role precedence itself. Reading the
 * method (verification-harness.ts, private `resolveRoleForGoal`) shows it
 * already does the right thing — this test pins that so a future refactor
 * can't silently regress it back to a flat/server-only roleStore lookup
 * (the class of bug fixed for team-manager.ts in this same lane — see
 * tests/team-manager.test.ts "role model/thinking-level overrides").
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "verif-role-tier-test-"));
fs.mkdirSync(path.join(TEST_DIR, "state"), { recursive: true });

const { VerificationHarness } = await import("../src/server/agent/verification-harness.ts");

type FakeRole = { name: string; model?: string; thinkingLevel?: string };

function makeCascade(rolesByProject: Record<string, FakeRole[]>): any {
	return {
		resolveRoles: (projectId?: string) =>
			(rolesByProject[projectId ?? "__none__"] ?? []).map(r => ({ item: r, origin: "project", overrides: undefined })),
	};
}

function makeContextManager(opts: {
	goalId: string;
	projectId?: string;
	inlineRoles?: Record<string, FakeRole>;
}): any {
	return {
		getContextForGoal: (id: string) =>
			id === opts.goalId
				? {
					project: opts.projectId ? { id: opts.projectId, name: "test-project" } : undefined,
					goalStore: { get: (gid: string) => (gid === opts.goalId ? { id: opts.goalId, inlineRoles: opts.inlineRoles } : undefined) },
				}
				: null,
	};
}

/** Server/builtin-only RoleStore stand-in — deliberately DIFFERENT from any
 *  project-cascade value below, so a passing assertion proves the cascade
 *  (not this flat store) was actually consulted. */
function makeFlatRoleStore(roles: Record<string, FakeRole>): any {
	return { get: (name: string) => roles[name] };
}

function makeHarness(opts: { roleStore: any; projectContextManager?: any; configCascade?: any }): any {
	return new VerificationHarness(
		path.join(TEST_DIR, "state"),
		undefined,
		() => {},
		opts.roleStore,
		undefined,
		undefined,
		undefined,
		undefined,
		opts.projectContextManager,
		opts.configCascade,
	);
}

describe("VerificationHarness.resolveRoleForGoal — CLF-W1c (reviewer/QA/legacy-sub-session spawn sites)", () => {
	it("resolves a PROJECT-scoped role override via configCascade, not the flat server/builtin roleStore", () => {
		const flatStore = makeFlatRoleStore({ "security-reviewer": { name: "security-reviewer", model: "flat/stale-model", thinkingLevel: "medium" } });
		const cascade = makeCascade({
			"proj-a": [{ name: "security-reviewer", model: "acme/proj-a-model", thinkingLevel: "high" }],
		});
		const pcm = makeContextManager({ goalId: "goal-1", projectId: "proj-a" });
		const harness = makeHarness({ roleStore: flatStore, projectContextManager: pcm, configCascade: cascade });

		const resolved = harness.resolveRoleForGoal("security-reviewer", "goal-1");
		assert.deepEqual(resolved, { model: "acme/proj-a-model", thinkingLevel: "high" });
	});

	it("resolves a DIFFERENT project's override for the same role name (proves projectId is actually threaded, not dropped)", () => {
		const flatStore = makeFlatRoleStore({});
		const cascade = makeCascade({
			"proj-a": [{ name: "qa-tester", thinkingLevel: "medium" }],
			"proj-b": [{ name: "qa-tester", thinkingLevel: "low" }],
		});

		const harnessA = makeHarness({ roleStore: flatStore, projectContextManager: makeContextManager({ goalId: "goal-1", projectId: "proj-a" }), configCascade: cascade });
		const harnessB = makeHarness({ roleStore: flatStore, projectContextManager: makeContextManager({ goalId: "goal-1", projectId: "proj-b" }), configCascade: cascade });

		assert.equal(harnessA.resolveRoleForGoal("qa-tester", "goal-1")?.thinkingLevel, "medium");
		assert.equal(harnessB.resolveRoleForGoal("qa-tester", "goal-1")?.thinkingLevel, "low");
	});

	it("a goal-scoped inlineRoles override wins over the project/server/builtin cascade", () => {
		const cascade = makeCascade({
			"proj-a": [{ name: "reviewer", model: "acme/cascade-model", thinkingLevel: "medium" }],
		});
		const pcm = makeContextManager({
			goalId: "goal-1",
			projectId: "proj-a",
			inlineRoles: { reviewer: { name: "reviewer", model: "acme/inline-model", thinkingLevel: "high" } },
		});
		const harness = makeHarness({ roleStore: makeFlatRoleStore({}), projectContextManager: pcm, configCascade: cascade });

		const resolved = harness.resolveRoleForGoal("reviewer", "goal-1");
		assert.deepEqual(resolved, { model: "acme/inline-model", thinkingLevel: "high" });
	});

	it("falls back to the flat server/builtin roleStore when no configCascade is wired (e.g. unit-test harness construction)", () => {
		const flatStore = makeFlatRoleStore({ "test-engineer": { name: "test-engineer", model: "flat/model", thinkingLevel: "medium" } });
		const harness = makeHarness({ roleStore: flatStore });

		const resolved = harness.resolveRoleForGoal("test-engineer", "goal-1");
		assert.deepEqual(resolved, { model: "flat/model", thinkingLevel: "medium" });
	});

	it("returns undefined for a role that exists nowhere", () => {
		const harness = makeHarness({ roleStore: makeFlatRoleStore({}) });
		assert.equal(harness.resolveRoleForGoal("nonexistent-role", "goal-1"), undefined);
	});
});
