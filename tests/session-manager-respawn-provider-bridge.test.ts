/**
 * Regression test for Extension Platform G1.4: provider-bridge must survive
 * respawn/restore.
 *
 * The bridge extension is added at initial session setup
 * (session-setup.ts::resolveToolActivation). The live-session respawn/restore
 * paths (restore, role reassignment, force-abort respawn) rebuild spawn args via
 * SessionManager.buildToolActivationArgs(). If that shared helper doesn't
 * re-attach the bridge, provider-enabled sessions silently lose per-turn
 * `before_agent_start` / `session_before_compact` hooks after a gateway
 * restart/respawn.
 *
 * These tests pin that buildToolActivationArgs re-attaches `--extension <bridge>`
 * when the project has a provider declaring a per-turn hook, and adds nothing
 * (zero overhead) otherwise.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "respawn-bridge-test-"));
process.env.BOBBIT_DIR = tmpRoot;

const { SessionManager } = await import("../src/server/agent/session-manager.ts");

const managers: any[] = [];

function makeManager(): any {
	const manager: any = new SessionManager();
	managers.push(manager);
	return manager;
}

afterEach(() => {
	for (const m of managers.splice(0)) {
		m.sessions?.clear?.();
	}
});

/** Pull the `--extension <path>` values out of a flat args array. */
function extensionPaths(args: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--extension" && typeof args[i + 1] === "string") out.push(args[i + 1]);
	}
	return out;
}

describe("buildToolActivationArgs provider-bridge re-attachment (respawn/restore)", () => {
	it("appends the provider-bridge extension when the project declares a per-turn hook", () => {
		const manager = makeManager();
		const seen: Array<{ projectId?: string; hooks: readonly string[] }> = [];
		manager.lifecycleHub = {
			hasProvidersForHooks(projectId: string | undefined, hooks: readonly string[]) {
				seen.push({ projectId, hooks });
				return true;
			},
		};

		const { args } = manager.buildToolActivationArgs("sess-respawn", undefined, undefined, tmpRoot, "proj-1");
		const exts = extensionPaths(args);

		assert.ok(
			exts.some((p) => p.includes("provider-bridge")),
			`expected a provider-bridge --extension, got: ${JSON.stringify(exts)}`,
		);
		// The hub was consulted with the restored/respawned session's project id.
		assert.ok(seen.some((s) => s.projectId === "proj-1"), "expected hub queried with project id");
	});

	it("adds no provider-bridge extension when no provider declares a per-turn hook", () => {
		const manager = makeManager();
		manager.lifecycleHub = {
			hasProvidersForHooks() { return false; },
		};

		const { args } = manager.buildToolActivationArgs("sess-respawn-none", undefined, undefined, tmpRoot, "proj-2");
		const exts = extensionPaths(args);

		assert.ok(
			!exts.some((p) => p.includes("provider-bridge")),
			`expected NO provider-bridge --extension, got: ${JSON.stringify(exts)}`,
		);
	});

	it("adds no provider-bridge extension when no lifecycle hub is wired (zero overhead)", () => {
		const manager = makeManager();
		manager.lifecycleHub = undefined;

		const { args } = manager.buildToolActivationArgs("sess-no-hub", undefined, undefined, tmpRoot, "proj-3");
		const exts = extensionPaths(args);

		assert.ok(
			!exts.some((p) => p.includes("provider-bridge")),
			`expected NO provider-bridge --extension without a hub, got: ${JSON.stringify(exts)}`,
		);
	});

	it("forwards the session's effective goal id to the hub so disabled providers filter after respawn", () => {
		const manager = makeManager();
		const seen: Array<{ projectId?: string; goalId?: string }> = [];
		manager.lifecycleHub = {
			hasProvidersForHooks(projectId: string | undefined, _hooks: readonly string[], goalId?: string) {
				seen.push({ projectId, goalId });
				return false;
			},
		};

		manager.buildToolActivationArgs("sess-goal", undefined, undefined, tmpRoot, "proj-4", "goal-xyz");

		assert.ok(
			seen.some((s) => s.projectId === "proj-4" && s.goalId === "goal-xyz"),
			`expected hub queried with (projectId, goalId); got ${JSON.stringify(seen)}`,
		);
	});
});

describe("disabledToolsForGoal — effective-goal metadata resolution (respawn/restore)", () => {
	function seedGoal(manager: any, goal: Record<string, unknown>) {
		const store = manager._testGoalManager.getGoalStore();
		store.put({
			cwd: tmpRoot, state: "in-progress", spec: "", title: "g",
			createdAt: Date.now(), updatedAt: Date.now(), ...goal,
		});
	}

	it("returns the lower-cased disabled-tool set from bobbit.disabledTools", () => {
		const manager = makeManager();
		seedGoal(manager, { id: "g-disabled", metadata: { "bobbit.disabledTools": ["Browser_Navigate", "bash"] } });
		const set = manager.disabledToolsForGoal("g-disabled");
		assert.ok(set instanceof Set);
		assert.ok(set.has("browser_navigate"));
		assert.ok(set.has("bash"));
	});

	it("inherits a parent's disabled tools through the ancestry walk", () => {
		const manager = makeManager();
		seedGoal(manager, { id: "g-parent", metadata: { "bobbit.disabledTools": ["browser_navigate"] } });
		seedGoal(manager, { id: "g-child", parentGoalId: "g-parent", metadata: { other: 1 } });
		const set = manager.disabledToolsForGoal("g-child");
		assert.ok(set?.has("browser_navigate"), "child must inherit parent's disabled tool");
	});

	it("returns undefined when the goal has no disabled tools (byte-identical default)", () => {
		const manager = makeManager();
		seedGoal(manager, { id: "g-none", metadata: { other: 1 } });
		assert.equal(manager.disabledToolsForGoal("g-none"), undefined);
		assert.equal(manager.disabledToolsForGoal(undefined), undefined);
	});
});
