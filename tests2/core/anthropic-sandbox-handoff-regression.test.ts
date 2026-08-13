import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { resetAgentDirStateForTests } from "../../src/server/bobbit-dir.js";
import { SessionManager } from "../../src/server/agent/session-manager.js";
import { ToolManager } from "../../src/server/agent/tool-manager.js";
import {
	ClaudeAgentSdkUnavailableError,
	claudeAgentSdkUnavailableDiagnostic,
	SDK_SESSION_UNAVAILABLE,
} from "../../src/server/agent/claude-agent-sdk-error.js";
import {
	buildSandboxAgentAuthJson,
	detectHostTokens,
	refreshSandboxAnthropicOAuthCredential,
	recoverAnthropicApiKeyRuntime,
	resolveHostTokenValue,
	sandboxAgentAuthPath,
	sandboxTokenPolicyAllowsAnthropicAuth,
} from "../../src/server/agent/host-tokens.js";

const originalBobbitAgentDir = process.env.BOBBIT_AGENT_DIR;
const originalBobbitDir = process.env.BOBBIT_DIR;
const originalBobbitSecretsDir = process.env.BOBBIT_SECRETS_DIR;
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
const originalAnthropicOAuthToken = process.env.ANTHROPIC_OAUTH_TOKEN;
let root: string | undefined;
let agentDir: string | undefined;
const SYNTHETIC_PI_REFRESH = "synthetic-pi-refresh";

/** A renewable host row must use Pi's complete OAuth credential shape. */
function completePiOAuthCredential(access: string, expires: number): { type: "oauth"; access: string; refresh: string; expires: number } {
	return { type: "oauth", access, refresh: SYNTHETIC_PI_REFRESH, expires };
}

function useHostAuth(auth: unknown): void {
	root = mkdtempSync(path.join(tmpdir(), "bobbit-anthropic-sandbox-"));
	agentDir = path.join(root, "agent");
	process.env.BOBBIT_AGENT_DIR = agentDir;
	process.env.BOBBIT_DIR = root;
	process.env.BOBBIT_SECRETS_DIR = path.join(root, "secrets");
	resetAgentDirStateForTests();
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(path.join(root, "secrets"), { recursive: true });
	mkdirSync(path.join(root, "state"), { recursive: true });
	writeFileSync(path.join(root, "state", "gateway-url"), "http://127.0.0.1:3001\n");
	writeFileSync(path.join(root, "secrets", "token"), `${"a".repeat(64)}\n`);
	writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({
		anthropic: auth,
		"openai-codex": { type: "oauth", access: "unrelated-codex-access" },
		"google-gemini-cli": { type: "oauth", access: "unrelated-google-access" },
	}), { encoding: "utf-8", flag: "w" });
}

afterEach(() => {
	vi.restoreAllMocks();
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
	agentDir = undefined;
	if (originalBobbitAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
	else process.env.BOBBIT_AGENT_DIR = originalBobbitAgentDir;
	if (originalBobbitDir === undefined) delete process.env.BOBBIT_DIR;
	else process.env.BOBBIT_DIR = originalBobbitDir;
	if (originalBobbitSecretsDir === undefined) delete process.env.BOBBIT_SECRETS_DIR;
	else process.env.BOBBIT_SECRETS_DIR = originalBobbitSecretsDir;
	if (originalAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
	else process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
	if (originalAnthropicOAuthToken === undefined) delete process.env.ANTHROPIC_OAUTH_TOKEN;
	else process.env.ANTHROPIC_OAUTH_TOKEN = originalAnthropicOAuthToken;
	resetAgentDirStateForTests();
});

describe("Anthropic sandbox OAuth handoff regressions", () => {
	it.each([
		"CLAUDE_AGENT_SDK_SANDBOX_UNAVAILABLE",
		"CLAUDE_AGENT_SDK_SANDBOX_AUTH_UNAVAILABLE",
	] as const)("preserves the safe %s reason code while redacting embedded credentials and config paths", (category) => {
		const secret = "sk-sandbox-diagnostic-secret";
		const configPath = `/Users/operator/${category}/credentials.json`;
		const error = new ClaudeAgentSdkUnavailableError(new Error(
			`${category}: Authorization: Bearer ${secret}; credential source ${configPath}`,
		));
		const diagnostic = claudeAgentSdkUnavailableDiagnostic(error);

		assert.equal(error.code, SDK_SESSION_UNAVAILABLE);
		assert.equal(error.message, SDK_SESSION_UNAVAILABLE);
		assert.match(diagnostic, new RegExp(`\\b${category}\\b`));
		assert.doesNotMatch(diagnostic, new RegExp(secret));
		assert.doesNotMatch(diagnostic, new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	});

	it("exports only a sanctioned, current non-renewable Anthropic OAuth credential", () => {
		const expires = Date.now() + 60_000;
		useHostAuth({
			...completePiOAuthCredential("sandbox-current-access", expires),
			email: "must-not-copy@example.test",
			scope: "must-not-copy",
		});

		assert.equal(sandboxTokenPolicyAllowsAnthropicAuth([{ key: "ANTHROPIC_OAUTH_TOKEN", enabled: true }]), true);
		assert.equal(sandboxTokenPolicyAllowsAnthropicAuth([{ key: "ANTHROPIC_OAUTH_TOKEN", enabled: false }]), false);
		assert.equal(sandboxTokenPolicyAllowsAnthropicAuth([{ key: "ANTHROPIC_API_KEY", enabled: true }]), false);
		assert.deepEqual(buildSandboxAgentAuthJson({ includeAnthropicAuth: true }), {
			anthropic: { type: "oauth", access: "sandbox-current-access", expires },
		});
		assert.deepEqual(buildSandboxAgentAuthJson({ includeAnthropicAuth: false }), {});
	});

	it("does not hand an expired host OAuth access token to a sandbox when refresh cannot run", () => {
		useHostAuth(completePiOAuthCredential("expired-access", Date.now() - 1));

		assert.deepEqual(buildSandboxAgentAuthJson({ includeAnthropicAuth: true }), {});
		assert.equal(resolveHostTokenValue("ANTHROPIC_OAUTH_TOKEN", undefined, undefined as any, { allowStoredAnthropicOAuth: false }), undefined);
	});

	it.each([
		["missing refresh", { type: "oauth", access: "partial-access", expires: Date.now() + 60_000 }],
		["missing expiry", { type: "oauth", access: "partial-access", refresh: "partial-refresh" }],
	])("does not advertise, refresh, or export a host OAuth credential %s", async (_caseName, credential) => {
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_OAUTH_TOKEN;
		useHostAuth(credential);

		assert.equal(detectHostTokens().find(token => token.envVar === "ANTHROPIC_OAUTH_TOKEN")?.available, false);
		assert.equal(await refreshSandboxAnthropicOAuthCredential(), false);
		assert.deepEqual(buildSandboxAgentAuthJson({ includeAnthropicAuth: true }), {});
		assert.equal(resolveHostTokenValue("ANTHROPIC_OAUTH_TOKEN", undefined, undefined as any, { allowStoredAnthropicOAuth: true }), undefined);
	});

	it("refreshes before producing the minimal sandbox auth entry", async () => {
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		useHostAuth(completePiOAuthCredential("expired-access", now - 1));
		const refreshRequest = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			assert.equal(String(input), "https://platform.claude.com/v1/oauth/token");
			assert.equal(init?.method, "POST");
			const body = JSON.parse(String(init?.body));
			assert.equal(body.grant_type, "refresh_token");
			assert.equal(body.refresh_token, SYNTHETIC_PI_REFRESH);
			assert.equal(typeof body.client_id, "string");
			return new Response(JSON.stringify({
				access_token: "rotated-access",
				refresh_token: "rotated-refresh",
				expires_in: 3_600,
			}), { status: 200, headers: { "Content-Type": "application/json" } });
		});
		const refreshedExpiry = now + 3_600_000 - 300_000;

		assert.equal(await refreshSandboxAnthropicOAuthCredential(), true);
		assert.equal(refreshRequest.mock.calls.length, 1);
		assert.deepEqual(buildSandboxAgentAuthJson({ includeAnthropicAuth: true }), {
			anthropic: { type: "oauth", access: "rotated-access", expires: refreshedExpiry },
		});
	});

	it("refreshes an explicitly opted-in host credential during wiring and exports only its minimal entry", async () => {
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		useHostAuth(completePiOAuthCredential("expired-access", now - 1));
		const refreshRequest = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
			access_token: "rotated-access",
			refresh_token: "rotated-refresh",
			expires_in: 3_600,
		}), { status: 200, headers: { "Content-Type": "application/json" } }));
		const manager: any = new SessionManager();
		manager.projectContextManager = null;
		manager.projectConfigStore = {
			get: (key: string) => key === "sandbox" ? "docker" : undefined,
			getSandboxTokens: () => [{ key: "ANTHROPIC_OAUTH_TOKEN", enabled: true }],
		};
		manager.sandboxTokenStore = null;
		manager.sandboxManager = {
			ensureForProject: async () => {},
			get: () => ({ getContainerId: async () => "container-test" }),
		};
		const bridgeOptions: any = { cwd: "/workspace", env: {} };

		assert.equal(await manager.applySandboxWiring(bridgeOptions, "session-test", { projectId: "project-test" }), true);
		assert.equal(refreshRequest.mock.calls.length, 1);
		assert.deepEqual(bridgeOptions.sandboxCredentials, {}, "host OAuth must not also cross through the raw env handoff");
		assert.deepEqual(JSON.parse(readFileSync(sandboxAgentAuthPath("project-test"), "utf-8")), {
			anthropic: { type: "oauth", access: "rotated-access", expires: now + 3_600_000 - 300_000 },
		});
	});

	it("keeps an explicit project credential ahead of host OAuth during wiring", async () => {
		useHostAuth(completePiOAuthCredential("expired-access", Date.now() - 1));
		const refreshRequest = vi.spyOn(globalThis, "fetch");
		const manager: any = new SessionManager();
		manager.projectContextManager = null;
		manager.projectConfigStore = {
			get: (key: string) => key === "sandbox" ? "docker" : undefined,
			getSandboxTokens: () => [{ key: "ANTHROPIC_API_KEY", enabled: true, value: "project-provided-key" }],
		};
		manager.sandboxTokenStore = null;
		manager.sandboxManager = {
			ensureForProject: async () => {},
			get: () => ({ getContainerId: async () => "container-test" }),
		};
		const bridgeOptions: any = { cwd: "/workspace", env: {} };

		assert.equal(await manager.applySandboxWiring(bridgeOptions, "session-test", { projectId: "project-test" }), true);
		assert.equal(refreshRequest.mock.calls.length, 0, "project credentials must suppress host OAuth refresh");
		assert.deepEqual(bridgeOptions.sandboxCredentials, { ANTHROPIC_API_KEY: "project-provided-key" });
		assert.deepEqual(JSON.parse(readFileSync(sandboxAgentAuthPath("project-test"), "utf-8")), {});
	});

	it("serializes handoffs and rechecks policy after a host refresh", async () => {
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		useHostAuth(completePiOAuthCredential("expired-access", now - 1));
		let entries: Array<{ key: string; enabled: boolean; value?: string }> = [
			{ key: "ANTHROPIC_OAUTH_TOKEN", enabled: true },
		];
		let resolveRefresh!: (response: Response) => void;
		let refreshStarted!: () => void;
		const refreshStartedPromise = new Promise<void>((resolve) => { refreshStarted = resolve; });
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			refreshStarted();
			return await new Promise<Response>((resolve) => { resolveRefresh = resolve; });
		});
		const manager: any = new SessionManager();
		manager.projectContextManager = null;
		manager.projectConfigStore = {
			get: (key: string) => key === "sandbox" ? "docker" : undefined,
			getSandboxTokens: () => entries,
		};
		manager.sandboxTokenStore = null;
		manager.sandboxManager = {
			ensureForProject: async () => {},
			get: () => ({ getContainerId: async () => "container-test" }),
		};
		const firstOptions: any = { cwd: "/workspace", env: {} };
		const secondOptions: any = { cwd: "/workspace", env: {} };

		const first = manager.applySandboxWiring(firstOptions, "session-one", { projectId: "project-test" });
		await refreshStartedPromise;
		entries = [{ key: "ANTHROPIC_API_KEY", enabled: true, value: "project-provided-key" }];
		const second = manager.applySandboxWiring(secondOptions, "session-two", { projectId: "project-test" });
		let secondSettled = false;
		void second.then(() => { secondSettled = true; });
		await Promise.resolve();
		assert.equal(secondSettled, false, "a second handoff must wait for the pending shared auth-file decision");

		resolveRefresh(new Response(JSON.stringify({
			access_token: "rotated-access",
			refresh_token: "rotated-refresh",
			expires_in: 3_600,
		}), { status: 200, headers: { "Content-Type": "application/json" } }));
		await Promise.all([first, second]);

		assert.deepEqual(firstOptions.sandboxCredentials, { ANTHROPIC_API_KEY: "project-provided-key" });
		assert.deepEqual(secondOptions.sandboxCredentials, { ANTHROPIC_API_KEY: "project-provided-key" });
		assert.deepEqual(JSON.parse(readFileSync(sandboxAgentAuthPath("project-test"), "utf-8")), {});
	});

	it("keeps shared Pi auth byte-identical while SDK wiring uses an isolated OAuth descriptor", async () => {
		const hostAccess = "sdk-current-access";
		useHostAuth(completePiOAuthCredential(hostAccess, Date.now() + 60_000));
		let entries: Array<{ key: string; enabled: boolean; value?: string }> = [
			{ key: "ANTHROPIC_OAUTH_TOKEN", enabled: true },
		];
		const piAuthPath = sandboxAgentAuthPath("project-sdk");
		mkdirSync(path.dirname(piAuthPath), { recursive: true });
		const piAuth = JSON.stringify({ anthropic: { type: "oauth", access: "pi-access", refresh: "pi-refresh", expires: 2 }, "openai-codex": { type: "oauth", access: "pi-codex" } });
		writeFileSync(piAuthPath, piAuth, "utf8");
		const hasClaudeAgentSdkCapability = vi.fn(async () => true);
		const prepareClaudeAgentSdkSession = vi.fn(async () => undefined);
		const manager: any = new SessionManager();
		manager.projectContextManager = null;
		manager.projectConfigStore = {
			get: (key: string) => key === "sandbox" ? "docker" : undefined,
			getSandboxTokens: () => entries,
		};
		const scopedToken = "minted-sdk-sandbox-authority";
		const scopedStore = {
			register: vi.fn(() => scopedToken),
			addSession: vi.fn(),
			addGoal: vi.fn(),
		};
		manager.sandboxTokenStore = scopedStore;
		manager.sandboxManager = {
			ensureForProject: async () => {},
			get: () => ({ getContainerId: async () => "container-sdk", hasClaudeAgentSdkCapability, prepareClaudeAgentSdkSession }),
		};
		const bridgeOptions: any = {
			runtime: "claude-agent-sdk",
			cwd: "/workspace-wt/sdk",
			env: { BOBBIT_SESSION_SECRET: "session-secret", BOBBIT_GOAL_ID: "goal-sdk" },
			sandboxCredentials: { SHOULD_BE_REMOVED: "legacy-generic-secret" },
		};

		assert.equal(await manager.applySandboxWiring(bridgeOptions, "session-sdk", { projectId: "project-sdk" }), true);
		assert.equal(hasClaudeAgentSdkCapability.mock.calls.length, 1);
		assert.deepEqual(prepareClaudeAgentSdkSession.mock.calls, [["/workspace-wt/sdk", "session-sdk"]]);
		assert.deepEqual(scopedStore.register.mock.calls, [["project-sdk"]]);
		assert.deepEqual(scopedStore.addSession.mock.calls, [["project-sdk", "session-sdk"]]);
		assert.deepEqual(scopedStore.addGoal.mock.calls, [["project-sdk", "goal-sdk"]]);
		assert.equal("sandboxCredentials" in bridgeOptions, false);
		assert.deepEqual(bridgeOptions.claudeSdkSandboxLaunch, {
			containerId: "container-sdk",
			cwd: "/workspace-wt/sdk",
			sessionId: "session-sdk",
			sessionSecret: "session-secret",
			goalId: "goal-sdk",
			gatewayToken: scopedToken,
			gatewayUrl: "http://127.0.0.1:3001",
			oauthAccessToken: hostAccess,
		});
		assert.equal(readFileSync(piAuthPath, "utf8"), piAuth, "SDK wiring must not rewrite Pi's shared auth state");

		entries = [{ key: "ANTHROPIC_OAUTH_TOKEN", enabled: true, value: "project-credential" }];
		await assert.rejects(
			() => manager.applySandboxWiring({ runtime: "claude-agent-sdk", cwd: "/workspace", env: {} }, "session-sdk-denied", { projectId: "project-sdk" }),
			(error: any) => error?.code === "CLAUDE_AGENT_SDK_SANDBOX_AUTH_UNAVAILABLE",
		);
		assert.equal(readFileSync(piAuthPath, "utf8"), piAuth, "rejected SDK wiring must not mutate Pi auth state");
	});

	it("fails closed before SDK launch or goal dispatch when scoped gateway authority is absent", async () => {
		useHostAuth(completePiOAuthCredential("sdk-current-access", Date.now() + 60_000));
		const createWorktree = vi.fn(async () => "/workspace-wt/should-not-exist");
		const dispatchGoalProvisioned = vi.fn();
		const manager: any = new SessionManager();
		manager.projectContextManager = null;
		manager.projectConfigStore = {
			get: (key: string) => key === "sandbox" ? "docker" : undefined,
			getSandboxTokens: () => [{ key: "ANTHROPIC_OAUTH_TOKEN", enabled: true }],
		};
		// The valid admin token created by useHostAuth must never become SDK authority.
		manager.sandboxTokenStore = null;
		manager.sandboxManager = {
			ensureForProject: async () => {},
			get: () => ({
				getContainerId: async () => "container-sdk",
				hasClaudeAgentSdkCapability: async () => true,
				createWorktree,
			}),
		};
		manager.dispatchGoalProvisionedForWorktree = dispatchGoalProvisioned;
		const bridgeOptions: any = { runtime: "claude-agent-sdk", cwd: "/host/worktree", env: {} };

		await assert.rejects(
			() => manager.applySandboxWiring(bridgeOptions, "session-sdk", {
				projectId: "project-sdk",
				goalId: "goal-sdk",
				sandboxBranch: "goal/sdk",
			}),
			(error: any) => error?.code === "SDK_SESSION_UNAVAILABLE"
				&& error?.message === "SDK_SESSION_UNAVAILABLE"
				&& /scoped sandbox gateway authority/.test(claudeAgentSdkUnavailableDiagnostic(error)),
		);
		assert.equal(bridgeOptions.gatewayToken, undefined, "the admin token must not be assigned to an SDK sandbox");
		assert.equal(bridgeOptions.claudeSdkSandboxLaunch, undefined, "missing scoped authority must prevent SDK launch descriptor creation");
		assert.equal(createWorktree.mock.calls.length, 0, "missing scoped authority must stop before launch preparation");
		assert.equal(dispatchGoalProvisioned.mock.calls.length, 0, "missing scoped authority must stop before goal dispatcher execution");
	});

	it("wires SDK role and force-abort replacements before constructing their dispatcher", () => {
		const source = readFileSync(path.resolve("src/server/agent/session-manager.ts"), "utf8");
		const roleStart = source.indexOf("private async _assignRoleStaged(");
		const roleEnd = source.indexOf("\n\ttryGenerateTitleFromPrompt(", roleStart);
		const roleBody = source.slice(roleStart, roleEnd);
		const forceStart = source.indexOf("private async _forceAbortOwned(");
		const forceEnd = source.indexOf("\n\t/**\n\t * One-shot migration", forceStart);
		const forceBody = source.slice(forceStart, forceEnd);

		for (const [label, body] of [["role assignment", roleBody], ["force abort", forceBody]] as const) {
			const runtime = body.indexOf("bridgeOptions.runtime = requireReplacementRuntime(");
			const sandbox = body.indexOf("const sandboxApplied = await this.applySandboxWiring(");
			const dispatcher = body.indexOf("await resolveToolActivation({");
			assert.ok(runtime >= 0, `${label} must select the durable runtime`);
			assert.ok(sandbox > runtime, `${label} must wire the SDK sandbox after runtime selection`);
			assert.ok(dispatcher > sandbox, `${label} must not construct the dispatcher before sandbox authority exists`);
			assert.ok(body.indexOf("bridgeOptions.claudeAgentSdkSessionId", runtime) < sandbox, `${label} must preserve the persisted opaque SDK resume id before wiring`);
		}
		assert.match(roleBody, /roleName:\s*role\.name/, "role dispatcher must use the newly assigned role policy");
		assert.match(roleBody, /catch \(err\) \{\n\t\t\tunsub\(\);\n\t\t\tawait rpcClient\.stop\(\)\.catch/, "failed staged role candidates must be disposed without replacing the original bridge");
	});

	it("runs real SDK sandbox dispatch for role and force-abort replacements", async () => {
		const dispatcherRoot = mkdtempSync(path.join(tmpdir(), "bobbit-sdk-replacement-dispatch-"));
		const configRoot = path.join(dispatcherRoot, "config");
		mkdirSync(path.join(configRoot, "tools"), { recursive: true });
		const dockerExecs: Array<{ args: string[]; options: any }> = [];
		const sdkLaunches: any[] = [];
		const sdkQueryOptions: any[] = [];
		const queries: Array<{ close: ReturnType<typeof vi.fn> }> = [];
		const fakeChild = () => {
			const child = new EventEmitter() as any;
			child.stdin = new PassThrough();
			child.stdout = new PassThrough();
			child.stderr = new PassThrough();
			child.killed = false;
			child.exitCode = null;
			child.signalCode = null;
			child.kill = vi.fn(() => {
				if (child.killed) return false;
				child.killed = true;
				child.exitCode = 0;
				child.stdin.end();
				child.stdout.end();
				child.stderr.end();
				queueMicrotask(() => child.emit("exit", 0, null));
				return true;
			});
			return child;
		};
		const dispatcherSpawn = vi.fn((_command: string, args: string[], options: any) => {
			const child = fakeChild();
			dockerExecs.push({ args: [...args], options });
			child.stdin.on("data", (chunk: Buffer) => {
				const line = chunk.toString();
				if (!line.startsWith("BOBBIT_SDK_DISPATCH:")) return;
				const init = JSON.parse(line.slice("BOBBIT_SDK_DISPATCH:".length));
				const schemas = (init.manifest ?? []).flatMap((entry: any) =>
					(entry.selectedToolNames ?? []).map((name: string) => ({
						name,
						inputSchema: { type: "object", properties: {} },
					})),
				);
				queueMicrotask(() => child.stdout.write(`BOBBIT_SDK_DISPATCH:${JSON.stringify({ type: "ready", schemas })}\n`));
			});
			return child;
		});
		try {
			const manager: any = new SessionManager();
			const resumeId = "00000000-0000-4000-8000-000000000031";
			const records = new Map<string, any>();
			manager._testStore = {
				get: vi.fn((id: string) => records.get(id)),
				update: vi.fn((id: string, patch: any) => Object.assign(records.get(id), patch)),
				put: vi.fn(), archive: vi.fn(),
			};
			manager.toolManager = new ToolManager(configRoot, path.resolve("defaults/tools"));
			manager.assemblePrompt = vi.fn(() => undefined);
			manager.resolveSessionRole = vi.fn((name: string | undefined) => name ? { name, promptTemplate: `${name} prompt`, accessory: "none", toolPolicies: {} } : undefined);
			manager.resolveEffectiveAllowedTools = vi.fn(() => []);
			manager.ensureMcpManagerForContext = vi.fn(async () => {});
			const sdkRoleManager = {
				getRole: (name: string) => ({ name, promptTemplate: `${name} prompt`, accessory: "none", toolPolicies: {} }),
			};
			manager.buildPipelineContext = vi.fn(() => ({
				toolManager: manager.toolManager,
				mcpManager: null,
				roleManager: sdkRoleManager,
				groupPolicyStore: null,
				configCascade: null,
				projectConfigStore: null,
				requestToolGrant: async () => ({ granted: false }),
			}));
			manager.applyDirectProviderEnv = vi.fn(async () => {});
			manager.requireCurrentCatalogSpawnModel = vi.fn(async (model: string) => model);
			manager.resolveCurrentCatalogThinkingLevel = vi.fn(async () => "off");
			manager.tryAutoSelectModel = vi.fn(async () => ({ provider: "claude-agent-sdk", modelId: "sandbox-sonnet", thinkingLevel: "off" }));
			manager.tryApplyDefaultThinkingLevel = vi.fn(async () => undefined);
			manager.finalizeSpawnOptions = vi.fn(async () => {});
			manager.drainQueue = vi.fn();
			manager._writeModelNameFile = vi.fn();
			manager.handleAgentLifecycle = vi.fn();
			manager._reconcileAfterAbort = vi.fn();
			let failCandidate = false;
			manager.claudeAgentSdkBridgeDepsFactory = () => {
				const ownedChildren: any[] = [];
				return {
					sessionAccess: {
						loadSdk: async () => { throw new Error("sandbox history must use its injected accessor"); },
						sandboxSdk: {
							getSessionInfo: vi.fn(async () => ({ sessionId: resumeId, summary: "replacement", lastModified: 1 })),
							getSessionMessages: vi.fn(async () => []),
						},
					},
					createDockerSpawn: (input: any) => (options: any) => {
						const child = fakeChild();
						sdkLaunches.push({ input, options, child });
						ownedChildren.push(child);
						return child;
					},
					query: (request: any) => {
						sdkQueryOptions.push(request.options);
						request.options.spawnClaudeCodeProcess({ args: ["--sdk-protocol"], env: {}, signal: new AbortController().signal });
						let finishIterator!: () => void;
						const iteratorFinished = new Promise<void>((resolve) => { finishIterator = resolve; });
						const query = {
							close: vi.fn(async () => {
								finishIterator();
								for (const child of ownedChildren.splice(0)) child.kill("SIGTERM");
							}),
							initializationResult: async () => {
								if (failCandidate) throw new Error("candidate startup failed");
								return { session_id: resumeId, models: [{ value: "sandbox-sonnet" }] };
							},
							async *[Symbol.asyncIterator]() {
								yield { type: "system", subtype: "init", session_id: resumeId };
								await iteratorFinished;
							},
						};
						queries.push(query);
						return query;
					},
					clock: { now: () => 0, setTimeout, setInterval, clearTimeout, clearInterval },
				};
			};
			const wiring = vi.fn(async (options: any, id: string) => {
				assert.equal(options.runtime, "claude-agent-sdk");
				assert.equal(options.claudeAgentSdkSessionId, resumeId);
				options.sandboxed = true;
				options.cwd = `/workspace-wt/${id}`;
				options.containerId = `container-${id}`;
				options.gatewayToken = `scoped-${id}`;
				options.gatewayUrl = "http://sandbox.gateway.test";
				options.claudeSdkSandboxLaunch = {
					containerId: `container-${id}`,
					cwd: `/workspace-wt/${id}`,
					sessionId: id,
					gatewayToken: `scoped-${id}`,
					gatewayUrl: "http://sandbox.gateway.test",
					oauthAccessToken: "current-oauth",
				};
				options.claudeSdkDispatcherTestDeps = { spawn: dispatcherSpawn, workerSource: "void 0" };
				return true;
			});
			manager.applySandboxWiring = wiring;
			const oldBridge = () => ({
				start: vi.fn(async () => {}), stop: vi.fn(async () => {}), abort: vi.fn(async () => ({ success: true })),
				onEvent: vi.fn(() => vi.fn()), getState: vi.fn(async () => ({ success: true, data: {} })),
				getMessages: vi.fn(async () => ({ success: true, data: { messages: [] } })),
			});
			const live = (id: string, rpcClient: any, status: "idle" | "streaming" = "idle") => ({
				id, title: id, cwd: "/workspace", projectId: "project-sdk", sandboxed: true,
				runtime: "claude-agent-sdk", status, statusVersion: 0, clients: new Set(),
				promptQueue: { toArray: () => [], enqueue: vi.fn() }, eventBuffer: { size: 0, push: vi.fn(() => ({ seq: 1, ts: 1 })) },
				inFlightSteerTexts: [], unsubscribe: vi.fn(), rpcClient, lastActivity: Date.now(),
			});
			const persisted = (id: string) => ({
				id, title: id, cwd: "/workspace", projectId: "project-sdk", sandboxed: true,
				runtime: "claude-agent-sdk", modelProvider: "claude-agent-sdk", modelId: "sandbox-sonnet",
				effectiveThinkingLevel: "off", claudeAgentSdkSessionId: resumeId, createdAt: Date.now(), lastActivity: Date.now(),
			});

			const roleId = "sdk-role-replacement";
			records.set(roleId, persisted(roleId));
			const roleOld = oldBridge();
			manager.sessions.set(roleId, live(roleId, roleOld));
			await expect(manager.assignRole(roleId, { name: "sandbox-role", promptTemplate: "role", accessory: "none" })).resolves.toBe(true);

			const forceId = "sdk-force-replacement";
			records.set(forceId, persisted(forceId));
			const forceOld = oldBridge();
			forceOld.abort = vi.fn(() => new Promise(() => {}));
			manager.sessions.set(forceId, live(forceId, forceOld, "streaming"));
			// Drive the grace expiry as an explicit lifecycle edge, not a wall-clock sleep.
			manager.clock = {
				now: () => Date.now(),
				setTimeout: (callback: () => void) => { queueMicrotask(callback); return 1; },
				clearTimeout: vi.fn(),
				setInterval,
				clearInterval,
			};
			await expect(manager.forceAbort(forceId, 1)).resolves.toBeUndefined();

			assert.equal(wiring.mock.calls.length, 2);
			for (const id of [roleId, forceId]) {
				const exec = dockerExecs.find(candidate => candidate.args.includes(`container-${id}`));
				const sdk = sdkLaunches.find(candidate => candidate.input.containerId === `container-${id}`);
				assert.ok(exec, `${id} must start its dispatcher with docker exec`);
				assert.ok(sdk, `${id} must start its SDK query through the Docker spawn seam`);
				assert.ok(exec.args.includes("-w"));
				assert.ok(exec.args.includes(`/workspace-wt/${id}`));
				assert.ok(exec.args.includes(`BOBBIT_TOKEN=scoped-${id}`));
				assert.ok(!exec.args.some(arg => /admin/i.test(arg)));
				assert.equal(sdk.input.cwd, `/workspace-wt/${id}`);
				assert.equal(sdk.input.env.BOBBIT_TOKEN, `scoped-${id}`);
				assert.equal(sdk.input.env.CLAUDE_CODE_OAUTH_TOKEN, "current-oauth");
				const queryOptions = sdkQueryOptions.find(candidate => candidate.env.BOBBIT_SESSION_ID === id);
				assert.equal(queryOptions?.resume, resumeId);
				assert.equal(sdk.options.args.includes("switch_session"), false);
			}
			assert.equal(roleOld.stop.mock.calls.length, 1);
			assert.equal(forceOld.stop.mock.calls.length, 1);
			await manager.sessions.get(roleId).rpcClient.stop();
			await manager.sessions.get(forceId).rpcClient.stop();

			const failedId = "sdk-role-candidate-failure";
			records.set(failedId, persisted(failedId));
			const failedOld = oldBridge();
			manager.sessions.set(failedId, live(failedId, failedOld));
			failCandidate = true;
			const queryCount = queries.length;
			await assert.rejects(
				() => manager.assignRole(failedId, { name: "sandbox-role", promptTemplate: "role", accessory: "none" }),
				(error: any) => error?.code === "SDK_SESSION_UNAVAILABLE"
					&& error?.message === "SDK_SESSION_UNAVAILABLE"
					&& /candidate startup failed/.test(claudeAgentSdkUnavailableDiagnostic(error)),
			);
			assert.ok(queries[queryCount]?.close.mock.calls.length, "failed SDK candidate must be disposed");
			const failedSdk = sdkLaunches.find(candidate => candidate.input.containerId === `container-${failedId}`);
			const failedDispatcher = dockerExecs.find(candidate => candidate.args.includes(`container-${failedId}`));
			assert.equal(failedSdk?.child.killed, true, "failed SDK subprocess must be killed");
			assert.ok(failedDispatcher, "failed candidate must have completed real dispatcher preflight");
			assert.equal(failedOld.stop.mock.calls.length, 0);
			assert.equal(manager.sessions.get(failedId)?.rpcClient, failedOld);
		} finally {
			rmSync(dispatcherRoot, { recursive: true, force: true });
		}
	});

	it("maps malformed persisted SDK sandbox CWD history to the unavailable stub", async () => {
		const manager: any = new SessionManager();
		manager.sandboxManager = { get: () => ({ getStatus: () => ({ containerId: "container-sdk" }) }) };
		const deps = manager.getSdkSessionAccessDeps({
			id: "session-invalid-cwd",
			projectId: "project-sdk",
			sandboxed: true,
			cwd: "/workspace/../../host",
			claudeAgentSdkSessionId: "00000000-0000-4000-8000-000000000021",
		});
		await assert.rejects(
			() => deps.sandboxSdk.getSessionMessages("00000000-0000-4000-8000-000000000021"),
			(error: any) => error?.code === "SDK_SESSION_UNAVAILABLE"
				&& error?.message === "SDK_SESSION_UNAVAILABLE"
				&& /invalid working directory/.test(claudeAgentSdkUnavailableDiagnostic(error)),
		);
	});

	it("leaves non-Anthropic startup untouched and makes API-key tombstone recovery best effort", async () => {
		useHostAuth({ type: "oauth_rejected", rejected: "a".repeat(64), version: 1 });
		process.env.ANTHROPIC_API_KEY = "test-api-key";

		await recoverAnthropicApiKeyRuntime(undefined, false);
		assert.equal(JSON.parse(readFileSync(path.join(agentDir!, "auth.json"), "utf-8")).anthropic.type, "oauth_rejected");

		await recoverAnthropicApiKeyRuntime({ ANTHROPIC_API_KEY: "test-api-key" });
		const recovered = JSON.parse(readFileSync(path.join(agentDir!, "auth.json"), "utf-8"));
		assert.equal("anthropic" in recovered, false);
		assert.equal(recovered["openai-codex"].access, "unrelated-codex-access");

		writeFileSync(path.join(agentDir!, "auth.json"), "{ malformed", "utf-8");
		await assert.doesNotReject(() => recoverAnthropicApiKeyRuntime({ ANTHROPIC_API_KEY: "test-api-key" }));
	});

	it("prefers a host Anthropic API key over an opted-in stored OAuth credential", async () => {
		useHostAuth(completePiOAuthCredential("current-host-access", Date.now() + 60_000));
		process.env.ANTHROPIC_API_KEY = "host-api-key";
		const refreshRequest = vi.spyOn(globalThis, "fetch");
		const manager: any = new SessionManager();
		manager.projectContextManager = null;
		manager.projectConfigStore = {
			get: (key: string) => key === "sandbox" ? "docker" : undefined,
			getSandboxTokens: () => [{ key: "ANTHROPIC_OAUTH_TOKEN", enabled: true }],
		};
		manager.sandboxTokenStore = null;
		manager.sandboxManager = {
			ensureForProject: async () => {},
			get: () => ({ getContainerId: async () => "container-test" }),
		};
		const bridgeOptions: any = { cwd: "/workspace", env: {} };

		assert.equal(await manager.applySandboxWiring(bridgeOptions, "session-test", { projectId: "project-test" }), true);
		assert.equal(refreshRequest.mock.calls.length, 0, "the API key makes host OAuth refresh unnecessary");
		assert.deepEqual(bridgeOptions.sandboxCredentials, { ANTHROPIC_OAUTH_TOKEN: "host-api-key" });
		assert.deepEqual(JSON.parse(readFileSync(sandboxAgentAuthPath("project-test"), "utf-8")), {});
	});

	it("denies host OAuth by default during sandbox wiring", async () => {
		useHostAuth(completePiOAuthCredential("current-host-access", Date.now() + 60_000));
		const refreshRequest = vi.spyOn(globalThis, "fetch");
		const manager: any = new SessionManager();
		manager.projectContextManager = null;
		manager.projectConfigStore = {
			get: (key: string) => key === "sandbox" ? "docker" : undefined,
			getSandboxTokens: () => [],
		};
		manager.sandboxTokenStore = null;
		manager.sandboxManager = {
			ensureForProject: async () => {},
			get: () => ({ getContainerId: async () => "container-test" }),
		};
		const bridgeOptions: any = { cwd: "/workspace", env: {} };

		assert.equal(await manager.applySandboxWiring(bridgeOptions, "session-test", { projectId: "project-test" }), true);
		assert.equal(refreshRequest.mock.calls.length, 0, "default sandbox setup must not inspect host OAuth");
		assert.deepEqual(bridgeOptions.sandboxCredentials, {});
		const sandboxAuth = JSON.parse(readFileSync(sandboxAgentAuthPath("project-test"), "utf-8"));
		assert.equal(sandboxAuth.anthropic, undefined);
	});
});
