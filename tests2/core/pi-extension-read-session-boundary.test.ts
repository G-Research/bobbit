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
import {
	ToolManager,
	__resetToolScanCache,
	type ToolProvider,
} from "../../src/server/agent/tool-manager.ts";
import {
	resolveToolActivation,
	type PipelineContext,
	type SessionSetupPlan,
} from "../../src/server/agent/session-setup.ts";
import { SessionManager } from "../../src/server/agent/session-manager.ts";
import {
	prependToolResultErrorBridge,
	resetToolResultErrorBridgeExtensionCache,
} from "../../src/server/agent/tool-result-error-bridge-extension.ts";
import { withEnv } from "../harness/with-env.js";

const PI_READ_SESSION: EffectiveTool[] = [{ kind: "pi-extension", name: "read_session" }];
const PI_NON_READ: EffectiveTool[] = [{ kind: "pi-extension", name: "pi_demo" }];
const TEAM_WAIT: EffectiveTool[] = [{ kind: "yaml", name: "team_wait" }];
const WEB_FETCH: EffectiveTool[] = [{ kind: "yaml", name: "web_fetch" }];

type ProviderWithLocation = ToolProvider & { groupDir: string; baseDir: string };

function mockToolManager(): ToolManager {
	return {
		getToolProviders: () => new Map(),
		getExtensionPath: (groupDir: string, filename: string) => path.join("/mock/tools", groupDir, filename),
	} as unknown as ToolManager;
}

function multiToolManager(): ToolManager {
	const agentProvider: ProviderWithLocation = {
		type: "bobbit-extension",
		extension: "extension.ts",
		groupDir: "agent",
		baseDir: "/mock/tools",
	};
	const webProvider: ProviderWithLocation = {
		type: "bobbit-extension",
		extension: "extension.ts",
		groupDir: "web",
		baseDir: "/mock/tools",
	};
	const providers = new Map<string, ProviderWithLocation>([
		["read_session", agentProvider],
		["team_wait", agentProvider],
		["web_fetch", webProvider],
	]);
	const tools = [
		{ name: "read_session", description: "Read session", group: "Agent", hasRenderer: false },
		{ name: "team_wait", description: "Wait for children", group: "Agent", hasRenderer: false },
		{ name: "web_fetch", description: "Fetch URL", group: "Web", hasRenderer: false },
	];
	return {
		getToolProviders: () => providers,
		getAvailableTools: () => tools,
		getToolByName: (name: string) => tools.find(tool => tool.name === name),
		getExtensionPath: (groupDir: string, filename: string) => path.join("/mock/tools", groupDir, filename),
	} as unknown as ToolManager;
}

function extensionPaths(args: string[]): string[] {
	return args.filter((_arg, index) => index > 0 && args[index - 1] === "--extension");
}

const readDeniedRole = { toolPolicies: { read_session: "never" as const } };

function initialPlan(allowedTools: EffectiveTool[]): SessionSetupPlan {
	return {
		id: "initial-read-boundary",
		mode: "normal",
		title: "Initial activation",
		cwd: process.cwd(),
		roleName: "read-denied",
		effectiveAllowedTools: allowedTools,
		bridgeOptions: {},
	} as SessionSetupPlan;
}

function initialContext(toolManager: ToolManager): PipelineContext {
	return {
		toolManager,
		roleManager: { getRole: () => readDeniedRole },
		mcpManager: null,
		groupPolicyStore: null,
		configCascade: null,
		marketplacePiExtensionResolver: null,
	} as unknown as PipelineContext;
}

function blockResultBoundary(root: string): void {
	const stateDir = path.join(root, "state");
	fs.mkdirSync(stateDir, { recursive: true });
	fs.writeFileSync(path.join(stateDir, "tool-result-error-bridge"), "block boundary directory", "utf8");
}

function assertGuardProtectsDeniedReadSession(args: string[]): void {
	const guardPath = extensionPaths(args).find(candidate => candidate.includes("tool-guard") && candidate.endsWith("guard.ts"));
	assert.ok(guardPath, `expected tool guard in ${JSON.stringify(args)}`);
	const source = fs.readFileSync(guardPath, "utf8");
	assert.match(source, /const readSessionProtected = true;/);
	assert.match(source, /"read_session":\{"policy":"never","group":"Agent"\}/);
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

	it("detects read_session registered by a selected sibling in the bundled Agent extension", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-bundled-agent-extension-"));
		try {
			fs.mkdirSync(path.join(root, "tools"), { recursive: true });
			__resetToolScanCache();
			const toolManager = new ToolManager(root, path.resolve("defaults", "tools"));
			const agentActivation = computeToolActivationArgs(TEAM_WAIT, toolManager);
			assert.equal(agentActivation.readSessionAvailable, true);
			assert.ok(extensionPaths(agentActivation.args).some(candidate => candidate.endsWith(path.join("agent", "extension.ts"))));

			const webActivation = computeToolActivationArgs(WEB_FETCH, toolManager);
			assert.equal(webActivation.readSessionAvailable, false);
			assert.ok(extensionPaths(webActivation.args).some(candidate => candidate.endsWith(path.join("web", "extension.ts"))));
		} finally {
			__resetToolScanCache();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("threads implicit registration safety through initial and restore activation without widening policy", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-implicit-read-session-success-"));
		try {
			withEnv({ BOBBIT_DIR: root, BOBBIT_PI_DIR: undefined }, () => {
				const toolManager = multiToolManager();
				resetToolResultErrorBridgeExtensionCache();
				const plan = initialPlan(TEAM_WAIT);
				resolveToolActivation(plan, initialContext(toolManager));
				assert.deepEqual(plan.effectiveAllowedTools, TEAM_WAIT);
				assertGuardProtectsDeniedReadSession(plan.bridgeOptions.args ?? []);

				const manager: any = new SessionManager({ toolManager });
				const restored = manager.buildToolActivationArgs(
					"restored-read-boundary",
					TEAM_WAIT,
					readDeniedRole,
					process.cwd(),
				);
				assertGuardProtectsDeniedReadSession(restored.args);
			});
		} finally {
			resetToolResultErrorBridgeExtensionCache();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails initial and restore activation closed when an implicit read boundary cannot materialize", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-implicit-read-session-failure-"));
		blockResultBoundary(root);
		try {
			withEnv({ BOBBIT_DIR: root, BOBBIT_PI_DIR: undefined }, () => {
				const toolManager = multiToolManager();
				resetToolResultErrorBridgeExtensionCache();
				assert.throws(
					() => resolveToolActivation(initialPlan(TEAM_WAIT), initialContext(toolManager)),
					/read_session safety boundary could not be written or verified/,
				);

				const manager: any = new SessionManager({ toolManager });
				resetToolResultErrorBridgeExtensionCache();
				assert.throws(
					() => manager.buildToolActivationArgs(
						"restored-read-boundary-failure",
						TEAM_WAIT,
						readDeniedRole,
						process.cwd(),
					),
					/read_session safety boundary could not be written or verified/,
				);

				resetToolResultErrorBridgeExtensionCache();
				assert.doesNotThrow(() => resolveToolActivation(initialPlan(WEB_FETCH), initialContext(toolManager)));
				resetToolResultErrorBridgeExtensionCache();
				assert.doesNotThrow(() => manager.buildToolActivationArgs(
					"restored-non-read-boundary",
					WEB_FETCH,
					readDeniedRole,
					process.cwd(),
				));
			});
		} finally {
			resetToolResultErrorBridgeExtensionCache();
			fs.rmSync(root, { recursive: true, force: true });
		}
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
