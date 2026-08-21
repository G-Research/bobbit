import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateInlineRoles } from "../../src/server/agent/inline-role-validator.js";
import { GoalManager } from "../../src/server/agent/goal-manager.js";
import { GoalStore } from "../../src/server/agent/goal-store.js";
import { executionPathIdentity } from "../../src/server/agent/resolve-project.js";
import { buildActive, buildFixture, buildSubgoalStep } from "../../tests/helpers/run-subgoal-step-fixture.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

function role(overrides: Record<string, unknown> = {}) {
	return { name: "reviewer", label: "Reviewer", promptTemplate: "Review {{GOAL_BRANCH}}", ...overrides };
}

describe("canonical goal candidate primitives", () => {
	it("normalizes a valid inline role without mutating input", () => {
		const input = { reviewer: role({ toolPolicies: { bash: "always-ask" }, model: "openai/gpt-5", thinkingLevel: "high" }) };
		const result = validateInlineRoles(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.roles?.reviewer).toMatchObject({ accessory: "none", toolPolicies: { bash: "ask" }, createdAt: 0, updatedAt: 0 });
		expect(input.reviewer).not.toHaveProperty("accessory");
	});

	it.each([
		[{ "Bad Name": role({ name: "Bad Name" }) }, "lowercase alphanumeric"],
		[{ reviewer: role({ name: "other" }) }, "matching name"],
		[{ reviewer: role({ model: "malformed" }) }, "provider/model"],
		[{ reviewer: role({ thinkingLevel: "maximum" }) }, "unsupported"],
		[{ reviewer: role({ toolPolicies: { bash: "sometimes" } }) }, "invalid tool policy"],
	])("rejects invalid inline role contracts", (input, message) => {
		const result = validateInlineRoles(input);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain(message);
	});
});

describe("canonical goal commit boundary", () => {
	it("binds preflight to a realpath-equivalent alias with a nonexistent suffix", async (context) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "goal-preflight-alias-"));
		const target = path.join(root, "target");
		const alias = path.join(root, "alias");
		const stateDir = path.join(root, "state");
		fs.mkdirSync(target);
		fs.mkdirSync(stateDir);
		try {
			try {
				fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EPERM") {
					context.skip();
					return;
				}
				throw error;
			}
			const store = new GoalStore(stateDir, undefined, { persistence: "json" });
			const manager = new GoalManager(store);
			const aliasedCwd = path.join(alias, "future");
			const canonicalCwd = path.join(target, "future");
			const preflight = await manager.preflightGoalCreation(aliasedCwd);

			const goal = manager.createGoalFromPreflight("Canonical alias", canonicalCwd, {
				preflight,
				worktree: false,
			});

			expect(goal.cwd).toBe(canonicalCwd);
			expect(store.getAll()).toHaveLength(1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a materially different cwd without persisting a goal", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "goal-preflight-stale-"));
		const first = path.join(root, "first");
		const second = path.join(root, "second");
		const stateDir = path.join(root, "state");
		fs.mkdirSync(first);
		fs.mkdirSync(second);
		fs.mkdirSync(stateDir);
		try {
			const store = new GoalStore(stateDir, undefined, { persistence: "json" });
			const manager = new GoalManager(store);
			const preflight = await manager.preflightGoalCreation(first);

			expect(() => manager.createGoalFromPreflight("Stale cwd", second, {
				preflight,
				worktree: false,
			})).toThrow(/preflight no longer matches/i);
			expect(store.getAll()).toEqual([]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it.runIf(process.platform === "win32")("treats Windows case and separator aliases as one preflight identity", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "goal-preflight-windows-"));
		try {
			const alternate = root.toUpperCase().replace(/\\/g, "/");
			expect(executionPathIdentity(alternate)).toBe(executionPathIdentity(root));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts a realpath-equivalent cwd in the verification harness", async (context) => {
		const fixture = await buildFixture();
		const target = path.join(fixture.tmpRoot, "alias-target");
		const alias = path.join(fixture.tmpRoot, "alias");
		fs.mkdirSync(target);
		try {
			try {
				fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EPERM") {
					context.skip();
					return;
				}
				throw error;
			}
			fixture.goalStore.update(fixture.parent.id, { cwd: path.join(alias, "future") });
			const step = buildSubgoalStep({ planId: "verification-alias-child" });
			const { signal, active, stepIndex } = buildActive(fixture.parent.id);

			const result = await fixture.harness.runSubgoalStep(step, signal, active, stepIndex);

			expect(result.passed).toBe(true);
			const child = fixture.goalStore.getAll().find(goal => goal.parentGoalId === fixture.parent.id);
			expect(child?.cwd).toBe(path.join(target, "future"));
		} finally {
			fixture.cleanup();
		}
	});

	it("revalidates a verification child after held repository preflight", async () => {
		const fixture = await buildFixture();
		const entered = deferred();
		const release = deferred();
		const manager = fixture.goalManager as any;
		const originalPreflight = manager.preflightGoalCreation.bind(manager);
		manager.preflightGoalCreation = async (...args: unknown[]) => {
			const result = await originalPreflight(...args);
			entered.resolve();
			await release.promise;
			return result;
		};
		try {
			const step = buildSubgoalStep({ planId: "held-preflight-child" });
			const { signal, active, stepIndex } = buildActive(fixture.parent.id);
			const pending = fixture.harness.runSubgoalStep(step, signal, active, stepIndex);
			await entered.promise;
			fixture.goalStore.update(fixture.parent.id, { subgoalsAllowed: false });
			release.resolve();
			const result = await pending;
			expect(result.passed).toBe(false);
			expect(result.output).toMatch(/doesn't allow sub-goals/i);
			expect(fixture.goalStore.getAll().filter(goal => goal.parentGoalId === fixture.parent.id)).toEqual([]);
			expect(fixture.calls.filter(call => call.kind === "createGoal")).toEqual([]);
		} finally {
			manager.preflightGoalCreation = originalPreflight;
			release.resolve();
			fixture.cleanup();
		}
	});
});
