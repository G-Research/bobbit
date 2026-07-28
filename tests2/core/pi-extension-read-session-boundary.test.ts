// v2-native — Pi-extension read_session activation and fail-closed boundary coverage.
import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

import {
	computeToolActivationArgs,
	type EffectiveTool,
} from "../../src/server/agent/tool-activation.ts";
import type { ToolManager } from "../../src/server/agent/tool-manager.ts";
import {
	prependToolResultErrorBridge,
	resetToolResultErrorBridgeExtensionCache,
} from "../../src/server/agent/tool-result-error-bridge-extension.ts";
import { withEnv } from "../harness/with-env.js";

const PI_READ_SESSION: EffectiveTool[] = [{ kind: "pi-extension", name: "read_session" }];
const PI_NON_READ: EffectiveTool[] = [{ kind: "pi-extension", name: "pi_demo" }];

function mockToolManager(): ToolManager {
	return {
		getToolProviders: () => new Map(),
		getExtensionPath: (groupDir: string, filename: string) => path.join("/mock/tools", groupDir, filename),
	} as unknown as ToolManager;
}

function withoutConsoleWarning<T>(fn: () => T): T {
	const originalWarn = console.warn;
	console.warn = () => {};
	try {
		return fn();
	} finally {
		console.warn = originalWarn;
	}
}

describe("Pi-extension read_session boundary activation", () => {
	it("marks explicit Pi read_session available with and without ToolManager", () => {
		assert.equal(computeToolActivationArgs(PI_READ_SESSION, mockToolManager()).readSessionAvailable, true);
		assert.equal(
			withoutConsoleWarning(() => computeToolActivationArgs(PI_READ_SESSION).readSessionAvailable),
			true,
		);
	});

	it("keeps disabled Pi read_session unavailable with and without ToolManager", () => {
		const disabled = new Set(["read_session"]);
		assert.equal(
			computeToolActivationArgs(PI_READ_SESSION, mockToolManager(), undefined, undefined, disabled).readSessionAvailable,
			false,
		);
		assert.equal(
			withoutConsoleWarning(() => computeToolActivationArgs(PI_READ_SESSION, undefined, undefined, undefined, disabled).readSessionAvailable),
			false,
		);
	});

	it("leaves non-read Pi activation args and env unchanged", () => {
		const toolManager = mockToolManager();
		const resolved = computeToolActivationArgs(PI_NON_READ, toolManager);
		const resolvedBaseline = computeToolActivationArgs([], toolManager);
		assert.equal(resolved.readSessionAvailable, false);
		assert.deepEqual(resolved.args, resolvedBaseline.args);
		assert.deepEqual(resolved.env, resolvedBaseline.env);

		withoutConsoleWarning(() => {
			const fallback = computeToolActivationArgs(PI_NON_READ);
			const fallbackBaseline = computeToolActivationArgs([]);
			assert.equal(fallback.readSessionAvailable, false);
			assert.deepEqual(fallback.args, fallbackBaseline.args);
			assert.deepEqual(fallback.env, fallbackBaseline.env);
		});
	});

	it("fails closed on bridge materialization failure only for Pi read_session", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pi-read-session-boundary-"));
		const blockedBobbitDir = path.join(root, "not-a-directory");
		fs.writeFileSync(blockedBobbitDir, "block generated state writes", "utf8");

		try {
			withEnv({ BOBBIT_DIR: blockedBobbitDir, BOBBIT_PI_DIR: undefined }, () => {
				const readActivation = computeToolActivationArgs(PI_READ_SESSION, mockToolManager());
				resetToolResultErrorBridgeExtensionCache();
				assert.throws(
					() => prependToolResultErrorBridge(readActivation.args, readActivation.readSessionAvailable),
					/read_session safety boundary could not be written or verified/,
				);

				const nonReadActivation = computeToolActivationArgs(PI_NON_READ, mockToolManager());
				resetToolResultErrorBridgeExtensionCache();
				assert.deepEqual(
					prependToolResultErrorBridge(nonReadActivation.args, nonReadActivation.readSessionAvailable),
					nonReadActivation.args,
				);
			});
		} finally {
			resetToolResultErrorBridgeExtensionCache();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
