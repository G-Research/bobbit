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
});
