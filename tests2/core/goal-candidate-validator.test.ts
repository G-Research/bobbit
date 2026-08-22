import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateInlineRoles } from "../../src/server/agent/inline-role-validator.js";
import {
	GoalManager,
	GoalPreflightStaleError,
	GOAL_PREFLIGHT_STALE_CODE,
	GOAL_PREFLIGHT_STALE_MESSAGE,
} from "../../src/server/agent/goal-manager.js";
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

function fakeGitRunner(onFirstProbe?: () => Promise<void>) {
	let probes = 0;
	const probeCwds: string[] = [];
	return {
		get probes() { return probes; },
		probeCwds,
		runner: {
			async execFile(_file: string, args: readonly string[], options?: { cwd?: string | URL }) {
				if (args.join(" ") === "rev-parse --show-toplevel") {
					probes++;
					const cwd = String(options?.cwd ?? "");
					probeCwds.push(cwd);
					if (probes === 1) await onFirstProbe?.();
					return { stdout: `${cwd}\n`, stderr: "" };
				}
				if (args.join(" ") === "rev-parse --verify HEAD") return { stdout: "head\n", stderr: "" };
				throw new Error(`unexpected git call: ${args.join(" ")}`);
			},
		},
	};
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

			const goal = await manager.createGoalFromPreflight("Canonical alias", canonicalCwd, {
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

			await expect(manager.createGoalFromPreflight("Stale cwd", second, {
				preflight,
				worktree: false,
			})).rejects.toThrow(GoalPreflightStaleError);
			expect(store.getAll()).toEqual([]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it.each(["components", "projectRoot", "baseRef"] as const)(
		"retries the whole repository probe when %s changes and commits the retained tuple",
		async (changedField) => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "goal-preflight-config-"));
			const rootA = path.join(root, "project-a");
			const rootB = path.join(root, "project-b");
			for (const dir of [path.join(rootA, "repo-a"), path.join(rootA, "repo-b"), path.join(rootB, "repo-a")]) {
				fs.mkdirSync(dir, { recursive: true });
			}
			const entered = deferred();
			const release = deferred();
			const fakeGit = fakeGitRunner(async () => {
				entered.resolve();
				await release.promise;
			});
			let components = [{ name: "repo-a", repo: "repo-a" }];
			let projectRoot = rootA;
			let baseRef = "origin/main";
			const store = new GoalStore(path.join(root, "state"), undefined, { persistence: "json" });
			const manager = new GoalManager(store, undefined, undefined, { commandRunner: fakeGit.runner });
			manager.setComponentsResolver(() => components);
			manager.setProjectRootResolver(() => projectRoot);
			manager.setBaseRefResolver(() => baseRef);
			try {
				const pending = manager.preflightGoalCreation(rootA, { projectId: "project" });
				await entered.promise;
				if (changedField === "components") components = [{ name: "repo-b", repo: "repo-b" }];
				if (changedField === "projectRoot") projectRoot = rootB;
				if (changedField === "baseRef") baseRef = "origin/release";
				release.resolve();

				const preflight = await pending;
				expect(fakeGit.probes).toBe(2);
				expect(preflight.componentsFingerprint).toBe(JSON.stringify(components));
				expect(preflight.projectRoot).toBe(projectRoot);
				expect(preflight.configuredBaseRef).toBe(baseRef);
				expect(preflight.repoPath).toBe(projectRoot);
				expect(fakeGit.probeCwds.at(-1)).toBe(path.join(projectRoot, components[0].repo));

				const goal = await manager.createGoalFromPreflight("Retained tuple", rootA, {
					projectId: "project",
					preflight,
					worktree: false,
				});
				expect(goal.repoPath).toBe(projectRoot);
				expect(store.getAll()).toHaveLength(1);
			} finally {
				release.resolve();
				fs.rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it("returns a bounded structured stale error after continuous repository config churn", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "goal-preflight-churn-"));
		fs.mkdirSync(path.join(root, "repo-a"), { recursive: true });
		fs.mkdirSync(path.join(root, "repo-b"), { recursive: true });
		const fakeGit = fakeGitRunner();
		const store = new GoalStore(path.join(root, "state"), undefined, { persistence: "json" });
		const manager = new GoalManager(store, undefined, undefined, { commandRunner: fakeGit.runner });
		let reads = 0;
		manager.setComponentsResolver(() => {
			const repo = reads++ % 2 === 0 ? "repo-a" : "repo-b";
			return [{ name: repo, repo }];
		});
		manager.setProjectRootResolver(() => root);
		manager.setBaseRefResolver(() => "origin/main");
		try {
			const error = await manager.preflightGoalCreation(root, { projectId: "project" }).catch(value => value);
			expect(error).toBeInstanceOf(GoalPreflightStaleError);
			expect(error).toMatchObject({
				status: 409,
				code: GOAL_PREFLIGHT_STALE_CODE,
				message: GOAL_PREFLIGHT_STALE_MESSAGE,
				details: { retryable: true },
			});
			expect(fakeGit.probes).toBe(2);
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

	it("maps a stale verification preflight to a normal structured failed result", async () => {
		const fixture = await buildFixture();
		const manager = fixture.goalManager as any;
		const originalPreflight = manager.preflightGoalCreation.bind(manager);
		manager.preflightGoalCreation = async () => { throw new GoalPreflightStaleError(); };
		try {
			const step = buildSubgoalStep({ planId: "stale-preflight-child" });
			const { signal, active, stepIndex } = buildActive(fixture.parent.id);
			const result = await fixture.harness.runSubgoalStep(step, signal, active, stepIndex);

			expect(result).toEqual({
				passed: false,
				output: `runSubgoalStep: candidate validation failed (${GOAL_PREFLIGHT_STALE_CODE}): ${GOAL_PREFLIGHT_STALE_MESSAGE}`,
			});
			expect(fixture.goalStore.getAll().filter(goal => goal.parentGoalId === fixture.parent.id)).toEqual([]);
			expect(fixture.calls.filter(call => call.kind === "createGoal")).toEqual([]);
		} finally {
			manager.preflightGoalCreation = originalPreflight;
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
