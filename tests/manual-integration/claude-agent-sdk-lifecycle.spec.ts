/**
 * Opt-in smoke for the official Claude Agent SDK runtime.
 *
 * This deliberately runs against the user's Bobbit Anthropic OAuth
 * subscription. It never copies auth files or credential values into the test
 * gateway, SDK options, assertions, or logs. The SDK receives only a current
 * access token from Bobbit's OAuth resolver and a Bobbit-owned config root.
 * A native Claude CLI login alone is insufficient.
 *
 * Run only when Bobbit Anthropic OAuth is connected:
 *   BOBBIT_RUN_CLAUDE_AGENT_SDK_SMOKE=1 npm run test:manual -- --grep "Claude Agent SDK lifecycle"
 */
import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { manualTmpRoot } from "./manual-test-paths.ts";

const smokeEnvironmentKeys = [
	"BOBBIT_DIR",
	"BOBBIT_SECRETS_DIR",
	"BOBBIT_AGENT_DIR",
	"MANUAL_CLAUDE_AGENT_SDK_AUTH_DIR",
	"BOBBIT_SKIP_MCP",
	"BOBBIT_SKIP_AIGW_DISCOVERY",
	"BOBBIT_SKIP_TITLE_GEN",
	"BOBBIT_SKIP_WORKTREE_POOL",
	"BOBBIT_NO_OPEN",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
] as const;

function captureSmokeEnvironment(): Map<string, string | undefined> {
	return new Map(smokeEnvironmentKeys.map(key => [key, process.env[key]]));
}

function restoreSmokeEnvironment(environment: Map<string, string | undefined>): void {
	for (const [key, value] of environment) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

/** Configure an opt-in SDK smoke without allowing ambient API credentials. */
function configureManualSdkSmokeEnvironment(authDir: string): void {
	process.env.BOBBIT_AGENT_DIR = authDir;
	delete process.env.ANTHROPIC_API_KEY;
	delete process.env.ANTHROPIC_AUTH_TOKEN;
	process.env.BOBBIT_SKIP_MCP = "1";
	process.env.BOBBIT_SKIP_AIGW_DISCOVERY = "1";
	process.env.BOBBIT_SKIP_TITLE_GEN = "1";
	process.env.BOBBIT_SKIP_WORKTREE_POOL = "1";
	process.env.BOBBIT_NO_OPEN = "1";
}

/** Reduce OAuth status to diagnostic-safe booleans for manual smoke assertions. */
function classifyAnthropicOAuthStatus(status: unknown): {
	authenticated: boolean;
	stored: boolean;
	rejected: boolean;
	refreshable: boolean;
	expiresFinite: boolean;
	providerExact: boolean;
} {
	const value = status && typeof status === "object" && !Array.isArray(status)
		? status as Record<string, unknown>
		: {};
	return {
		authenticated: value.authenticated === true,
		stored: value.stored === true,
		rejected: value.rejected === true,
		refreshable: value.refreshable === true,
		expiresFinite: typeof value.expires === "number" && Number.isFinite(value.expires),
		providerExact: value.provider === "anthropic",
	};
}

/** Keep assertions diagnostic-safe: never stringify SDK-owned transcript rows. */
function rootMessages(snapshot: unknown): Record<string, unknown>[] {
	const messages = Array.isArray(snapshot)
		? snapshot
		: snapshot && typeof snapshot === "object" && Array.isArray((snapshot as { messages?: unknown }).messages)
			? (snapshot as { messages: unknown[] }).messages
			: [];
	return messages.filter((message): message is Record<string, unknown> => !!message && typeof message === "object" && !Array.isArray(message));
}

function hasRootCanonicalToolCall(snapshot: unknown, toolName: string): boolean {
	return rootMessages(snapshot).some((message) =>
		Array.isArray(message.content) && message.content.some((part: unknown) =>
			!!part && typeof part === "object" && (part as Record<string, unknown>).type === "toolCall" && (part as Record<string, unknown>).name === toolName,
		),
	);
}

function hasSuccessfulRootToolResult(snapshot: unknown, toolName: string): boolean {
	const callIds = new Set(rootMessages(snapshot).flatMap((message) =>
		Array.isArray(message.content)
			? message.content.flatMap((part: unknown) => {
				const row = part && typeof part === "object" ? part as Record<string, unknown> : undefined;
				return row?.type === "toolCall" && row.name === toolName && typeof row.id === "string" ? [row.id] : [];
			})
			: [],
	));
	return callIds.size > 0 && rootMessages(snapshot).some((message) =>
		message.role === "toolResult"
		&& message.toolName === toolName
		&& message.isError !== true
		&& typeof message.toolCallId === "string"
		&& callIds.has(message.toolCallId),
	);
}

function hasOneNestedHelper(snapshot: unknown): boolean {
	if (!snapshot || typeof snapshot !== "object") return false;
	const value = snapshot as { messages?: unknown; subagentWork?: unknown };
	if (!Array.isArray(value.subagentWork) || value.subagentWork.length !== 1) return false;
	const helper = value.subagentWork[0] as { parentToolUseId?: unknown; agentType?: unknown; phase?: unknown };
	if (typeof helper.parentToolUseId !== "string" || typeof helper.agentType !== "string") return false;
	if (!Array.isArray(value.messages)) return false;
	return value.messages.some((message: any) => Array.isArray(message?.content) && message.content.some((part: any) =>
		part?.type === "toolCall" && part?.name === "Agent" && part?.id === helper.parentToolUseId,
	));
}

function hasDurableSubscriptionUsage(cost: unknown): boolean {
	if (!cost || typeof cost !== "object") return false;
	const value = cost as Record<string, unknown>;
	const context = value.context;
	const isNullableNumber = (entry: unknown): boolean => entry === null || typeof entry === "number";
	const has = (record: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);
	if (!context || typeof context !== "object" || Array.isArray(context)) return false;
	const contextValue = context as Record<string, unknown>;
	return value.costBasis === "subscription-notional"
		&& value.totalCost === null
		&& has(value, "notionalCostUsd")
		&& isNullableNumber(value.notionalCostUsd)
		&& has(value, "inputTokens") && typeof value.inputTokens === "number"
		&& has(value, "outputTokens") && typeof value.outputTokens === "number"
		&& has(value, "cacheReadTokens") && typeof value.cacheReadTokens === "number"
		&& has(value, "cacheWriteTokens") && typeof value.cacheWriteTokens === "number"
		&& has(value, "context")
		&& has(contextValue, "highWaterTokens") && isNullableNumber(contextValue.highWaterTokens)
		&& has(contextValue, "currentTokens") && isNullableNumber(contextValue.currentTokens);
}

function sameTranscriptProjection(before: unknown, after: unknown): boolean {
	const rows = (value: unknown): Array<{ id: unknown; role: unknown }> | undefined => {
		if (Array.isArray(value)) return value.map(row => ({ id: (row as any)?.id, role: (row as any)?.role }));
		if (value && typeof value === "object" && Array.isArray((value as any).messages)) return rows((value as any).messages);
		return undefined;
	};
	const left = rows(before);
	const right = rows(after);
	return !!left && !!right && left.length === right.length
		&& left.every((row, index) => typeof row.id === "string" && row.id === right[index]?.id && row.role === right[index]?.role);
}

function manualSdkModel(): string {
	const configuredModel = process.env.MANUAL_CLAUDE_AGENT_SDK_MODEL?.trim();
	if (!configuredModel || configuredModel.startsWith("claude-agent-sdk/")) {
		throw new Error("Claude Agent SDK smoke requires MANUAL_CLAUDE_AGENT_SDK_MODEL without the provider prefix.");
	}
	return configuredModel;
}

function manualSdkAuthDir(): string {
	const authDir = process.env.MANUAL_CLAUDE_AGENT_SDK_AUTH_DIR?.trim();
	if (!authDir) throw new Error("Missing required environment variable: MANUAL_CLAUDE_AGENT_SDK_AUTH_DIR.");
	return authDir;
}

const manualTurnEventTypes = [
	"agent_start",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_end",
	"agent_end",
	"process_exit",
	"subagent_work",
	"compaction_start",
	"compaction_end",
	"auto_compaction_start",
	"auto_compaction_end",
	"other",
] as const;
type ManualTurnEventType = typeof manualTurnEventTypes[number];

function createManualTurnEventCounts(): Record<ManualTurnEventType, number> {
	return Object.fromEntries(manualTurnEventTypes.map(type => [type, 0])) as Record<ManualTurnEventType, number>;
}

/** Record only fixed event categories; never include an event payload in smoke output. */
function countManualTurnEvent(counts: Record<ManualTurnEventType, number>, event: unknown): void {
	const rawType = event && typeof event === "object" ? (event as { type?: unknown }).type : undefined;
	const type = typeof rawType === "string" && (manualTurnEventTypes as readonly string[]).includes(rawType)
		? rawType as ManualTurnEventType
		: "other";
	counts[type] = Math.min(counts[type] + 1, 1_000_000);
}

function diagnosticBoolean(read: () => unknown): boolean {
	try { return read() === true; } catch { return false; }
}

function diagnosticValue(read: () => unknown): unknown {
	try { return read(); } catch { return undefined; }
}

function normalizeManualSessionStatus(value: unknown): "starting" | "preparing" | "idle" | "streaming" | "aborting" | "terminated" | "other" {
	return ["starting", "preparing", "idle", "streaming", "aborting", "terminated"].includes(value as string)
		? value as "starting" | "preparing" | "idle" | "streaming" | "aborting" | "terminated"
		: "other";
}

function normalizeManualBridgeState(value: unknown): "new" | "starting" | "ready" | "running" | "interrupting" | "failed" | "stopped" | "other" {
	return ["new", "starting", "ready", "running", "interrupting", "failed", "stopped"].includes(value as string)
		? value as "new" | "starting" | "ready" | "running" | "interrupting" | "failed" | "stopped"
		: "other";
}

test("Claude Agent SDK manual timeout event diagnostics retain only fixed event categories", () => {
	const counts = createManualTurnEventCounts();
	countManualTurnEvent(counts, { type: "agent_start", privatePayload: "must-not-appear" });
	countManualTurnEvent(counts, { type: "provider_detail", privatePayload: "must-not-appear" });
	expect(Object.keys(counts)).toEqual(manualTurnEventTypes);
	expect(counts.agent_start).toBe(1);
	expect(counts.other).toBe(1);
});

test("Claude Agent SDK manual terminal diagnostics expose only route-safe categories", async () => {
	const { ClaudeAgentSdkUnavailableError, claudeAgentSdkUnavailableRouteDiagnostic } = await import("../../dist/server/agent/claude-agent-sdk-error.js");
	const providerLookingDetail = "provider response token=private-token request_id=private-request /private/provider/path CLAUDE_AGENT_SDK_RATE_LIMITED";
	const diagnostic = claudeAgentSdkUnavailableRouteDiagnostic(new ClaudeAgentSdkUnavailableError(providerLookingDetail));
	expect(diagnostic).toBe("SDK_SESSION_UNAVAILABLE: CLAUDE_AGENT_SDK_RATE_LIMITED");
	expect(diagnostic).toMatch(/^SDK_SESSION_UNAVAILABLE(?:: CLAUDE_AGENT_SDK_RATE_LIMITED)?$/);
	expect(diagnostic).not.toContain("private-token");
	expect(diagnostic).not.toContain("private-request");
	expect(diagnostic).not.toContain("/private/provider/path");
});

test("Claude Agent SDK provider-unavailable failure is bounded and sanitized without an alternative runtime", async () => {
	test.setTimeout(15_000);
	const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const root = join(manualTmpRoot(), `bobbit-claude-agent-sdk-unavailable-${nonce}`);
	const originalEnvironment = captureSmokeEnvironment();
	try {
		mkdirSync(join(root, ".bobbit", "state"), { recursive: true });
		process.env.BOBBIT_DIR = join(root, ".bobbit");
		process.env.BOBBIT_SECRETS_DIR = join(root, ".secrets");
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_AUTH_TOKEN;
		const { ClaudeAgentSdkBridge } = await import("../../dist/server/agent/claude-agent-sdk-bridge.js");
		let sdkQueryAttempts = 0;
		const bridge = new ClaudeAgentSdkBridge({ runtime: "claude-agent-sdk", cwd: root }, {
			query: (async () => {
				sdkQueryAttempts++;
				throw new Error("provider unavailable");
			}) as any,
			clock: { now: () => Date.now(), setTimeout, clearTimeout, setInterval, clearInterval } as any,
		});
		await expect(bridge.start()).rejects.toMatchObject({ code: "SDK_SESSION_UNAVAILABLE", message: "SDK_SESSION_UNAVAILABLE" });
		expect(sdkQueryAttempts).toBe(1);
		expect(bridge.running).toBe(false);
		await expect(bridge.prompt("bounded unavailable lifecycle check")).rejects.toMatchObject({ code: "SDK_SESSION_UNAVAILABLE", message: "SDK_SESSION_UNAVAILABLE" });
	} finally {
		if (existsSync(root)) rmSync(root, { recursive: true, force: true });
		restoreSmokeEnvironment(originalEnvironment);
	}
});

test("Claude Agent SDK manual smoke setup installs the explicit auth directory and removes ambient API credentials", () => {
	const originalEnvironment = captureSmokeEnvironment();
	try {
		const explicitManualAuthDir = join(manualTmpRoot(), `manual-sdk-auth-dir-${process.pid}`);
		process.env.MANUAL_CLAUDE_AGENT_SDK_AUTH_DIR = explicitManualAuthDir;
		process.env.BOBBIT_AGENT_DIR = join(manualTmpRoot(), `playwright-worker-agent-dir-${process.pid}`);
		process.env.ANTHROPIC_API_KEY = "ambient-api-key";
		process.env.ANTHROPIC_AUTH_TOKEN = "ambient-auth-token";
		configureManualSdkSmokeEnvironment(manualSdkAuthDir());
		expect({
			explicitManualDirWins: process.env.BOBBIT_AGENT_DIR === explicitManualAuthDir,
			apiKeyRemoved: process.env.ANTHROPIC_API_KEY === undefined,
			authTokenRemoved: process.env.ANTHROPIC_AUTH_TOKEN === undefined,
		}).toEqual({ explicitManualDirWins: true, apiKeyRemoved: true, authTokenRemoved: true });
	} finally {
		restoreSmokeEnvironment(originalEnvironment);
	}
});

test.describe("Claude Agent SDK lifecycle (manual subscription smoke)", () => {
	test("uses Bobbit OAuth and supports ready, prompt, steer, soft interrupt, and termination", async () => {
		test.skip(
			process.env.BOBBIT_RUN_CLAUDE_AGENT_SDK_SMOKE !== "1",
			"Set BOBBIT_RUN_CLAUDE_AGENT_SDK_SMOKE=1 to use a local Claude subscription.",
		);
		test.setTimeout(420_000);
		const manualAuthDir = manualSdkAuthDir();

		const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const root = join(manualTmpRoot(), `bobbit-claude-agent-sdk-smoke-${nonce}`);
		const bobbitDir = join(root, ".bobbit");
		const secretsDir = join(root, ".secrets");
		const projectRoot = join(root, "project");
		let gateway: { shutdown(): Promise<void>; sessionManager: any } | undefined;
		let token = "";
		let baseURL = "";
		const originalEnvironment = captureSmokeEnvironment();

		try {
			mkdirSync(projectRoot, { recursive: true });
			mkdirSync(join(bobbitDir, "state"), { recursive: true });
			writeFileSync(join(bobbitDir, "state", "projects.json"), "[]");
			writeFileSync(join(bobbitDir, "state", "setup-complete"), "manual-sdk-smoke\n");

			// Do not use seedManualTestModelPreferences: that helper can explicitly
			// copy authentication/config files for Pi manual tests. The SDK bridge
			// must instead use Bobbit's locked OAuth resolver without copying config.
			process.env.BOBBIT_DIR = bobbitDir;
			process.env.BOBBIT_SECRETS_DIR = secretsDir;
			// Use the explicit manual OAuth root, never Playwright's worker-owned
			// BOBBIT_AGENT_DIR. Do not copy it into this isolated gateway or SDK root.
			configureManualSdkSmokeEnvironment(manualAuthDir);

			// Reset and set the directory before loading anything that can import the
			// OAuth credential boundary. Those modules may cache startup-derived state.
			const { getAgentDirState, globalAgentDir, normalizeAgentDirInput, resetAgentDirStateForTests, setProjectRoot } = await import("../../dist/server/bobbit-dir.js");
			resetAgentDirStateForTests();
			setProjectRoot(bobbitDir);
			const { scaffoldBobbitDir } = await import("../../dist/server/scaffold.js");
			const { loadOrCreateToken } = await import("../../dist/server/auth/token.js");
			const { createGateway } = await import("../../dist/server/server.js");
			scaffoldBobbitDir(bobbitDir);
			token = loadOrCreateToken();
			gateway = createGateway({
				host: "127.0.0.1",
				port: 0,
				portExplicit: true,
				authToken: token,
				defaultCwd: root,
				forceAuth: true,
			});
			const port = await (gateway as any).start();
			baseURL = `http://127.0.0.1:${port}`;

			// Keep diagnostics boolean-only so no local directory is exposed.
			expect({
				startupSourceIsExplicit: getAgentDirState().startup.source === "BOBBIT_AGENT_DIR",
				startupResolvesToManualDir: globalAgentDir() === normalizeAgentDirInput(manualAuthDir, bobbitDir),
			}).toEqual({ startupSourceIsExplicit: true, startupResolvesToManualDir: true });

			const api = (path: string, init: RequestInit = {}) => fetch(`${baseURL}${path}`, {
				...init,
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					...(init.headers as Record<string, string> | undefined),
				},
			});
			const waitFor = async <T>(read: () => T | undefined, label: string, timeoutMs = 90_000): Promise<T> => {
				const deadline = Date.now() + timeoutMs;
				while (Date.now() < deadline) {
					const value = read();
					if (value !== undefined) return value;
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				throw new Error(`Timed out waiting for ${label}`);
			};

			// Fail before session creation when the isolated gateway cannot see a
			// current Bobbit OAuth login. Compare the route with its production source
			// module and retain only boolean diagnostics; never expose auth details.
			const { oauthStatus } = await import("../../dist/server/auth/oauth.js");
			const { resolveDirectClaudeAgentSdkOAuthAccessToken } = await import("../../dist/server/agent/host-tokens.js");
			const resolverSucceeded = await resolveDirectClaudeAgentSdkOAuthAccessToken()
				.then(() => true)
				.catch(() => false);
			const directOAuthStatus = classifyAnthropicOAuthStatus(oauthStatus("anthropic"));
			const oauthStatusResponse = await api("/api/oauth/status?provider=anthropic");
			const httpOAuthStatus = classifyAnthropicOAuthStatus(await oauthStatusResponse.json());
			const healthyOAuthStatus = {
				authenticated: true,
				stored: false,
				rejected: false,
				refreshable: false,
				expiresFinite: true,
				providerExact: true,
			};
			expect({
				resolverSucceeded,
				httpStatusOk: oauthStatusResponse.status === 200,
				direct: directOAuthStatus,
				http: httpOAuthStatus,
			}).toEqual({
				resolverSucceeded: true,
				httpStatusOk: true,
				direct: healthyOAuthStatus,
				http: healthyOAuthStatus,
			});

			const projectResponse = await api("/api/projects", {
				method: "POST",
				body: JSON.stringify({ name: `sdk-smoke-${nonce}`, rootPath: projectRoot, acceptCanonical: true }),
			});
			expect(projectResponse.status).toBe(201);
			const project = await projectResponse.json() as { id: string };
			const goalResponse = await api("/api/goals", {
				method: "POST",
				body: JSON.stringify({
					title: `sdk-smoke-goal-${nonce}`,
					cwd: projectRoot,
					projectId: project.id,
					workflowId: "general",
					spec: "Isolated Claude Agent SDK manual lifecycle smoke.",
					worktree: false,
					autoStartTeam: false,
				}),
			});
			expect(goalResponse.status).toBe(201);
			const goal = await goalResponse.json() as { id: string };
			// Configure an isolated role before session setup: one harmless tool must
			// ask so the real SessionManager permission-card lifecycle is exercised,
			// while the read-only gate query remains non-interactive. Role reads and
			// mutations require an explicit scope; customize first so this never
			// changes the headquarters/server configuration.
			const roleScope = `projectId=${encodeURIComponent(project.id)}`;
			const roleCustomize = await api(`/api/roles/general/customize?scope=project&${roleScope}`, { method: "POST" });
			expect(roleCustomize.status).toBe(201);
			const roleResponse = await api(`/api/roles/general?${roleScope}`);
			expect(roleResponse.status).toBe(200);
			const role = await roleResponse.json() as { toolPolicies?: Record<string, string> };
			const roleUpdate = await api(`/api/roles/general?${roleScope}`, {
				method: "PUT",
				body: JSON.stringify({ toolPolicies: { ...(role.toolPolicies ?? {}), Gates: "allow", ask_user_choices: "ask" } }),
			});
			expect(roleUpdate.status).toBe(200);

			const configuredModel = manualSdkModel();
			const sessionModel = `claude-agent-sdk/${configuredModel}`;
			const { claudeAgentSdkUnavailableRouteDiagnostic } = await import("../../dist/server/agent/claude-agent-sdk-error.js");
			const providerResponse = await api("/api/custom-providers", {
				method: "POST",
				body: JSON.stringify({
					id: "claude-agent-sdk",
					name: "claude-agent-sdk",
					type: "manual",
					baseUrl: "http://127.0.0.1:9",
					models: [{ id: configuredModel, name: "Manual Claude Agent SDK smoke" }],
				}),
			});
			expect(providerResponse.status).toBe(200);
			const preferencesResponse = await api("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ "default.sessionModel": sessionModel, "default.sessionThinkingLevel": "off" }),
			});
			expect(preferencesResponse.status).toBe(200);
			const createResponse = await api("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ projectId: project.id, goalId: goal.id, cwd: projectRoot, worktree: false }),
			});
			expect(createResponse.status).toBe(201);
			const created = await createResponse.json() as { id: string };
			let session = await waitFor(
				() => gateway!.sessionManager.getSession(created.id),
				"SDK bridge installation",
			);
			expect(session.runtime, `default session model ${sessionModel} must select the Claude Agent SDK runtime`).toBe("claude-agent-sdk");
			await session.rpcClient.waitForReady(90_000);
			expect(session.rpcClient.running, "SDK query must remain usable after readiness").toBe(true);
			expect(gateway.sessionManager.getPersistedSession(created.id)?.claudeAgentSdkSessionId).toBeUndefined();
			const runTurn = async (text: string, label: string, options: Record<string, unknown> = {}) => {
				const before = session.agentObservedTurnVersion ?? 0;
				const eventTypeCounts = createManualTurnEventCounts();
				const bridge = session.rpcClient as unknown as Record<string, unknown>;
				const terminalDiagnostic = () => claudeAgentSdkUnavailableRouteDiagnostic(diagnosticValue(() => bridge.terminalError));
				const unsubscribe = session.rpcClient.onEvent(event => countManualTurnEvent(eventTypeCounts, event));
				try {
					await gateway!.sessionManager.enqueuePrompt(created.id, text, { source: "user", ...options });
					await waitFor(() => (session.agentObservedTurnVersion ?? 0) > before ? true : undefined, label, 120_000);
					await waitFor(() => {
						const sessionStatus = normalizeManualSessionStatus(diagnosticValue(() => gateway!.sessionManager.getSession(created.id)?.status));
						if (sessionStatus === "terminated") throw new Error(terminalDiagnostic());
						return sessionStatus === "idle" ? true : undefined;
					}, `${label} to settle`, 120_000);
				} catch (error) {
					if (error instanceof Error && (
						error.message === `Timed out waiting for ${label}`
						|| error.message === `Timed out waiting for ${label} to settle`
					)) {
						const input = diagnosticValue(() => bridge.input) as Record<string, unknown> | undefined;
						throw new Error(JSON.stringify({
							label,
							eventTypeCounts,
							agentObservedTurnVersionAdvanced: (session.agentObservedTurnVersion ?? 0) > before,
							sessionManagerStatus: normalizeManualSessionStatus(diagnosticValue(() => gateway!.sessionManager.getSession(created.id)?.status)),
							bridgeRunning: diagnosticBoolean(() => session.rpcClient.running),
							bridgeLifecycleState: normalizeManualBridgeState(diagnosticValue(() => bridge.state)),
							sdkTerminalDiagnostic: terminalDiagnostic(),
							pendingToolPermission: diagnosticBoolean(() => gateway!.sessionManager.getPendingToolPermission(created.id) !== undefined),
							bridgeInputQueue: {
								hasQueuedRows: diagnosticBoolean(() => Array.isArray(input?.rows) && input.rows.length > 0),
								hasWaitingReader: diagnosticBoolean(() => input?.reader !== undefined),
							},
							initializationComplete: diagnosticBoolean(() => bridge.initializationComplete),
							queryHandlePresent: diagnosticBoolean(() => bridge.queryHandle !== undefined),
						}));
					}
					throw error;
				} finally {
					unsubscribe();
				}
			};

			// Use the same SessionManager queue/steer path as the gateway. This keeps
			// the smoke on the production IRpcBridge boundary while avoiding a second
			// browser protocol and never recording model output in test diagnostics.
			const firstTurnVersion = session.agentObservedTurnVersion ?? 0;
			await gateway.sessionManager.enqueuePrompt(created.id, "Reply with exactly: SDK_SMOKE_READY", { source: "user" });
			await waitFor(
				() => (session.agentObservedTurnVersion ?? 0) > firstTurnVersion ? true : undefined,
				"translated SDK prompt output",
				120_000,
			);
			await waitFor(
				() => gateway!.sessionManager.getSession(created.id)?.status === "idle" ? true : undefined,
				"first SDK prompt to settle",
				120_000,
			);
			const persistedSdkSessionId = await waitFor(
				() => {
					const id = gateway!.sessionManager.getPersistedSession(created.id)?.claudeAgentSdkSessionId;
					return typeof id === "string" ? id : undefined;
				},
				"persisted SDK session identity after first prompt",
			);

			// A project-local exact skill proves Bobbit owns expansion before a prompt
			// crosses the SDK boundary. The test never records the expanded text.
			const skillDir = join(projectRoot, ".claude", "skills", "sdk-dogfood");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(join(skillDir, "SKILL.md"), "---\nname: sdk-dogfood\ndescription: isolated lifecycle proof\n---\nReply with exactly SDK_DOGFOOD_SLASH_COMPLETE. Do not use tools.\n");
			const { resolveSkillExpansions } = await import("../../dist/server/skills/resolve-skill-expansions.js");
			const slash = resolveSkillExpansions("/sdk-dogfood", projectRoot);
			expect(slash.expansions.length === 1 && slash.unknown.length === 0 && slash.modelText !== slash.originalText).toBe(true);
			const { createComposerSlashRegistry, resolveComposerSlashDispatch } = await import("../../src/app/composer-slash-dispatch.ts");
			const slashRegistry = createComposerSlashRegistry({
				runtime: "claude-agent-sdk",
				skills: [{ name: "sdk-dogfood", description: "isolated lifecycle proof", source: "project" }],
				launchers: [],
			});
			expect(resolveComposerSlashDispatch("/sdk-dogfood", { runtime: "claude-agent-sdk", registry: slashRegistry })?.kind).toBe("skill");
			expect(resolveComposerSlashDispatch("/compact", { runtime: "claude-agent-sdk", registry: slashRegistry })?.kind).toBe("unsupported-compact");
			await runTurn(slash.originalText, "Bobbit-owned slash prompt", { modelText: slash.modelText, skillExpansions: slash.expansions });

			// The model is asked to make one safe allowed canonical call and one ask
			// call. Settle the manager-owned card without exposing arguments/results.
			const toolTurnVersion = session.agentObservedTurnVersion ?? 0;
			await gateway.sessionManager.enqueuePrompt(created.id, "Use Bobbit read on README.md, then use Bobbit ask_user_choices for one harmless lifecycle confirmation.", { source: "user" });
			const permission = await waitFor(
				() => gateway!.sessionManager.getPendingToolPermission(created.id),
				"canonical ask-tool permission card",
				90_000,
			);
			expect(permission.toolName === "ask_user_choices" && permission.group === "Ask").toBe(true);
			await gateway.sessionManager.grantToolPermission(created.id, "ask_user_choices", "tool", "Ask", "one-time", permission.id);
			await waitFor(() => (session.agentObservedTurnVersion ?? 0) > toolTurnVersion ? true : undefined, "canonical Bobbit tool turn", 120_000);
			await waitFor(() => gateway!.sessionManager.getSession(created.id)?.status === "idle" ? true : undefined, "canonical Bobbit tool turn to settle", 120_000);
			let transcript = await gateway.sessionManager.getMessagesSnapshotBase(session);
			expect(transcript.success && hasRootCanonicalToolCall(gateway.sessionManager.buildVisibleMessageSnapshot(created.id, transcript.data), "read")).toBe(true);
			expect(transcript.success && hasRootCanonicalToolCall(gateway.sessionManager.buildVisibleMessageSnapshot(created.id, transcript.data), "ask_user_choices")).toBe(true);

			// This is read-only: it observes workflow state without signaling a real gate.
			await runTurn("Use only Bobbit gate_list to inspect the current workflow state; do not signal or modify any gate.", "read-only workflow-gate tool action");
			transcript = await gateway.sessionManager.getMessagesSnapshotBase(session);
			const visibleTranscript = transcript.success
				? gateway.sessionManager.buildVisibleMessageSnapshot(created.id, transcript.data)
				: undefined;
			expect(transcript.success && hasRootCanonicalToolCall(visibleTranscript, "gate_list")).toBe(true);
			expect(transcript.success && hasSuccessfulRootToolResult(visibleTranscript, "gate_list")).toBe(true);

			await runTurn("Use exactly one foreground bobbit-backend-parity-reviewer helper to read README.md. Do not create a Bobbit task, team, worktree, or another helper.", "constrained foreground helper");
			transcript = await gateway.sessionManager.getMessagesSnapshotBase(session);
			expect(transcript.success && hasOneNestedHelper(gateway.sessionManager.buildVisibleMessageSnapshot(created.id, transcript.data))).toBe(true);

			// Only exercise a live SDK-advertised thinking level. When none is
			// advertised, verify the explicit unsupported path rather than guessing.
			const { applyRuntimeSessionThinkingSelection } = await import("../../dist/server/ws/runtime-model-selection.js");
			const liveState = await session.rpcClient.getState();
			const model = liveState?.data?.model as { thinkingLevelMap?: Record<string, string | null>; reasoning?: boolean } | undefined;
			const supportedThinking = model?.reasoning === true
				? Object.entries(model.thinkingLevelMap ?? {}).find(([level, value]) => level !== "off" && typeof value === "string")?.[0]
				: undefined;
			if (supportedThinking) {
				const effective = await applyRuntimeSessionThinkingSelection(gateway.sessionManager, session, supportedThinking);
				expect(effective.thinkingLevel === supportedThinking).toBe(true);
			} else {
				await expect(applyRuntimeSessionThinkingSelection(gateway.sessionManager, session, "low")).rejects.toThrow(/unavailable/i);
			}

			const beforeRestart = await gateway.sessionManager.getMessagesSnapshotBase(session);
			expect(beforeRestart.success && hasDurableSubscriptionUsage(gateway.sessionManager.getSessionCost(created.id))).toBe(true);
			// Automatic SDK compaction is intentionally observation-only: this smoke
			// never invokes a manual/fabricated compaction command.
			await gateway.shutdown();
			gateway = createGateway({ host: "127.0.0.1", port: 0, portExplicit: true, authToken: token, defaultCwd: root, forceAuth: true });
			const restartedPort = await (gateway as any).start();
			baseURL = `http://127.0.0.1:${restartedPort}`;
			session = await waitFor(() => gateway!.sessionManager.getSession(created.id), "SDK gateway restart/resume", 120_000);
			await session.rpcClient.waitForReady(90_000);
			expect(gateway.sessionManager.getPersistedSession(created.id)?.claudeAgentSdkSessionId).toBe(persistedSdkSessionId);
			const reloaded = await api(`/api/sessions/${created.id}/transcript`);
			expect(reloaded.status).toBe(200);
			const afterRestart = await gateway.sessionManager.getMessagesSnapshotBase(session);
			expect(beforeRestart.success && afterRestart.success && sameTranscriptProjection(beforeRestart.data, afterRestart.data)).toBe(true);
			expect(hasDurableSubscriptionUsage(gateway.sessionManager.getSessionCost(created.id))).toBe(true);

			await gateway.sessionManager.enqueuePrompt(
				created.id,
				"Count from 1 to 1000 slowly, one number per line, until you receive a new instruction.",
				{ source: "user" },
			);
			await waitFor(
				() => gateway!.sessionManager.getSession(created.id)?.status === "streaming" ? true : undefined,
				"SDK streaming turn",
			);
			await gateway.sessionManager.deliverLiveSteer(created.id, "Stop counting now and briefly acknowledge this steer.");
			await gateway.sessionManager.abortSessionTurn(created.id);
			expect(session.rpcClient.running, "soft interrupt must not close the SDK query").toBe(true);
			await waitFor(
				() => gateway!.sessionManager.getSession(created.id)?.status === "idle" ? true : undefined,
				"soft interrupt to settle",
				120_000,
			);

			const terminated = await gateway.sessionManager.terminateSession(created.id);
			expect(terminated).toBe(true);
			expect(gateway.sessionManager.getSession(created.id)?.status).toBe("terminated");
		} finally {
			if (gateway) await gateway.shutdown().catch(() => {});
			restoreSmokeEnvironment(originalEnvironment);
			const { resetAgentDirStateForTests } = await import("../../dist/server/bobbit-dir.js");
			resetAgentDirStateForTests();
			if (existsSync(root)) rmSync(root, { recursive: true, force: true });
		}
	});
});

// This intentionally has a separate gate: the direct SDK smoke above remains
// useful on hosts without Docker, while this proof requires the rebuilt image.
test.describe("Claude Agent SDK Docker sandbox lifecycle (manual subscription smoke)", () => {
	test("uses the pooled Docker container with an explicit OAuth policy and resumes after replacement", async () => {
		test.skip(
			process.env.BOBBIT_RUN_CLAUDE_AGENT_SDK_SANDBOX_SMOKE !== "1",
			"Set BOBBIT_RUN_CLAUDE_AGENT_SDK_SANDBOX_SMOKE=1 with Docker, a rebuilt bobbit-agent image, and a local Claude subscription.",
		);
		test.setTimeout(600_000);
		const manualAuthDir = manualSdkAuthDir();
		try {
			execFileSync("docker", ["image", "inspect", "bobbit-agent"], { stdio: "ignore", timeout: 10_000 });
		} catch {
			throw new Error("Claude Agent SDK sandbox smoke requires Docker and a rebuilt bobbit-agent image.");
		}
		const configuredModel = manualSdkModel();
		const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const root = join(manualTmpRoot(), `bobbit-claude-agent-sdk-sandbox-${nonce}`);
		const bobbitDir = join(root, ".bobbit");
		const projectRoot = join(root, "project");
		let gateway: { shutdown(): Promise<void>; sessionManager: any } | undefined;
		let token = "";
		const originalEnvironment = captureSmokeEnvironment();
		try {
			mkdirSync(projectRoot, { recursive: true });
			// A remote-less checkout exercises Bobbit's mounted clone without copying
			// any credentials, settings, or authentication files into the sandbox.
			execFileSync("git", ["init"], { cwd: projectRoot, stdio: "ignore" });
			execFileSync("git", ["config", "user.email", "manual-smoke@example.invalid"], { cwd: projectRoot });
			execFileSync("git", ["config", "user.name", "Manual SDK Smoke"], { cwd: projectRoot });
			writeFileSync(join(projectRoot, "README.md"), "sandbox SDK manual smoke\n");
			execFileSync("git", ["add", "README.md"], { cwd: projectRoot, stdio: "ignore" });
			execFileSync("git", ["commit", "-m", "manual sandbox smoke"], { cwd: projectRoot, stdio: "ignore" });
			mkdirSync(join(bobbitDir, "state"), { recursive: true });
			writeFileSync(join(bobbitDir, "state", "projects.json"), "[]");
			writeFileSync(join(bobbitDir, "state", "setup-complete"), "manual-sdk-sandbox-smoke\n");
			process.env.BOBBIT_DIR = bobbitDir;
			process.env.BOBBIT_SECRETS_DIR = join(root, ".secrets");
			// Use the explicit manual OAuth root, never Playwright's worker-owned
			// BOBBIT_AGENT_DIR. Do not copy it into the gateway, sandbox, or SDK root.
			configureManualSdkSmokeEnvironment(manualAuthDir);
			// Reset and set the directory before loading anything that can import the
			// OAuth credential boundary. Those modules may cache startup-derived state.
			const { resetAgentDirStateForTests, setProjectRoot } = await import("../../dist/server/bobbit-dir.js");
			resetAgentDirStateForTests();
			setProjectRoot(bobbitDir);
			const { scaffoldBobbitDir } = await import("../../dist/server/scaffold.js");
			const { loadOrCreateToken } = await import("../../dist/server/auth/token.js");
			const { createGateway } = await import("../../dist/server/server.js");
			scaffoldBobbitDir(bobbitDir);
			token = loadOrCreateToken();
			gateway = createGateway({ host: "127.0.0.1", port: 0, portExplicit: true, authToken: token, defaultCwd: root, forceAuth: true });
			let port = await (gateway as any).start();
			const api = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
				...init,
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) },
			});
			const waitFor = async <T>(read: () => T | undefined, label: string, timeoutMs = 120_000): Promise<T> => {
				const deadline = Date.now() + timeoutMs;
				while (Date.now() < deadline) {
					const value = read();
					if (value !== undefined) return value;
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				throw new Error(`Timed out waiting for ${label}`);
			};
			const projectResponse = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `sdk-sandbox-${nonce}`, rootPath: projectRoot, acceptCanonical: true }) });
			expect(projectResponse.status).toBe(201);
			const project = await projectResponse.json() as { id: string };
			const goalResponse = await api("/api/goals", {
				method: "POST",
				body: JSON.stringify({
					title: `sdk-sandbox-goal-${nonce}`,
					cwd: projectRoot,
					projectId: project.id,
					workflowId: "general",
					spec: "Isolated Claude Agent SDK Docker manual lifecycle smoke.",
					worktree: false,
					autoStartTeam: false,
				}),
			});
			expect(goalResponse.status).toBe(201);
			const goal = await goalResponse.json() as { id: string };
			// Keep the permission-card role override inside this temporary project.
			// The role API requires an explicit scope for both reads and mutations.
			const roleScope = `projectId=${encodeURIComponent(project.id)}`;
			const roleCustomize = await api(`/api/roles/general/customize?scope=project&${roleScope}`, { method: "POST" });
			expect(roleCustomize.status).toBe(201);
			const roleResponse = await api(`/api/roles/general?${roleScope}`);
			expect(roleResponse.status).toBe(200);
			const role = await roleResponse.json() as { toolPolicies?: Record<string, string> };
			const roleUpdate = await api(`/api/roles/general?${roleScope}`, {
				method: "PUT",
				body: JSON.stringify({ toolPolicies: { ...(role.toolPolicies ?? {}), Gates: "allow", ask_user_choices: "ask" } }),
			});
			expect(roleUpdate.status).toBe(200);
			const config = await api(`/api/projects/${project.id}/config`, {
				method: "PUT",
				body: JSON.stringify({ sandbox: "docker", sandbox_tokens: [{ key: "ANTHROPIC_OAUTH_TOKEN", enabled: true }] }),
			});
			expect(config.status).toBe(200);
			const savedConfigResponse = await api(`/api/projects/${project.id}/config`);
			expect(savedConfigResponse.status).toBe(200);
			const savedConfig = await savedConfigResponse.json() as { sandbox_tokens?: Array<{ key: string; enabled: boolean; value: string }> };
			expect(savedConfig.sandbox_tokens).toEqual([{ key: "ANTHROPIC_OAUTH_TOKEN", enabled: true, value: "" }]);
			const sessionModel = `claude-agent-sdk/${configuredModel}`;
			const providerResponse = await api("/api/custom-providers", {
				method: "POST",
				body: JSON.stringify({
					id: "claude-agent-sdk",
					name: "claude-agent-sdk",
					type: "manual",
					baseUrl: "http://127.0.0.1:9",
					models: [{ id: configuredModel, name: "Manual Claude Agent SDK sandbox smoke" }],
				}),
			});
			expect(providerResponse.status).toBe(200);
			const preferencesResponse = await api("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ "default.sessionModel": sessionModel, "default.sessionThinkingLevel": "off" }),
			});
			expect(preferencesResponse.status).toBe(200);
			const createdResponse = await api("/api/sessions", { method: "POST", body: JSON.stringify({ projectId: project.id, goalId: goal.id, cwd: projectRoot, worktree: false }) });
			expect(createdResponse.status).toBe(201);
			const created = await createdResponse.json() as { id: string };
			let session = await waitFor(() => gateway!.sessionManager.getSession(created.id), "sandbox SDK bridge installation");
			expect(session.runtime).toBe("claude-agent-sdk");
			expect(session.sandboxed).toBe(true);
			expect(session.cwd).toBe("/workspace");
			await session.rpcClient.waitForReady(120_000);
			const persistedSdkSessionId = gateway.sessionManager.getPersistedSession(created.id)?.claudeAgentSdkSessionId;
			expect(typeof persistedSdkSessionId).toBe("string");
			const runSandboxTurn = async (text: string, label: string, options: Record<string, unknown> = {}) => {
				const before = session.agentObservedTurnVersion ?? 0;
				await gateway!.sessionManager.enqueuePrompt(created.id, text, { source: "user", ...options });
				await waitFor(() => (session.agentObservedTurnVersion ?? 0) > before ? true : undefined, label, 120_000);
				await waitFor(() => gateway!.sessionManager.getSession(created.id)?.status === "idle" ? true : undefined, `${label} to settle`, 120_000);
			};
			const skillDir = join(projectRoot, ".claude", "skills", "sdk-sandbox-dogfood");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(join(skillDir, "SKILL.md"), "---\nname: sdk-sandbox-dogfood\ndescription: isolated sandbox lifecycle proof\n---\nUse only the Bobbit sandbox dogfood procedure.\n");
			const { resolveSkillExpansions } = await import("../../dist/server/skills/resolve-skill-expansions.js");
			const sandboxSlash = resolveSkillExpansions("/sdk-sandbox-dogfood", projectRoot);
			expect(sandboxSlash.expansions.length === 1 && sandboxSlash.unknown.length === 0).toBe(true);
			const { createComposerSlashRegistry, resolveComposerSlashDispatch } = await import("../../src/app/composer-slash-dispatch.ts");
			const sandboxRegistry = createComposerSlashRegistry({ runtime: "claude-agent-sdk", skills: [{ name: "sdk-sandbox-dogfood", description: "isolated sandbox lifecycle proof", source: "project" }], launchers: [] });
			expect(resolveComposerSlashDispatch("/sdk-sandbox-dogfood", { runtime: "claude-agent-sdk", registry: sandboxRegistry })?.kind).toBe("skill");
			expect(resolveComposerSlashDispatch("/compact", { runtime: "claude-agent-sdk", registry: sandboxRegistry })?.kind).toBe("unsupported-compact");
			await runSandboxTurn(sandboxSlash.originalText, "sandbox Bobbit-owned slash prompt", { modelText: sandboxSlash.modelText, skillExpansions: sandboxSlash.expansions });

			const firstVersion = session.agentObservedTurnVersion ?? 0;
			await gateway.sessionManager.enqueuePrompt(created.id, "Reply with exactly: SDK_SANDBOX_READY", { source: "user" });
			await waitFor(() => (session.agentObservedTurnVersion ?? 0) > firstVersion ? true : undefined, "sandbox SDK prompt output");
			await waitFor(() => gateway!.sessionManager.getSession(created.id)?.status === "idle" ? true : undefined, "sandbox SDK prompt to settle", 120_000);

			const toolTurnVersion = session.agentObservedTurnVersion ?? 0;
			await gateway.sessionManager.enqueuePrompt(created.id, "Use Bobbit read on README.md, then use Bobbit ask_user_choices for one harmless sandbox lifecycle confirmation.", { source: "user" });
			const permission = await waitFor(() => gateway!.sessionManager.getPendingToolPermission(created.id), "sandbox canonical ask-tool permission card", 90_000);
			expect(permission.toolName === "ask_user_choices" && permission.group === "Ask").toBe(true);
			await gateway.sessionManager.grantToolPermission(created.id, "ask_user_choices", "tool", "Ask", "one-time", permission.id);
			await waitFor(() => (session.agentObservedTurnVersion ?? 0) > toolTurnVersion ? true : undefined, "sandbox canonical Bobbit tool turn", 120_000);
			await waitFor(() => gateway!.sessionManager.getSession(created.id)?.status === "idle" ? true : undefined, "sandbox canonical Bobbit tool turn to settle", 120_000);
			let sandboxTranscript = await gateway.sessionManager.getMessagesSnapshotBase(session);
			expect(sandboxTranscript.success && hasRootCanonicalToolCall(gateway.sessionManager.buildVisibleMessageSnapshot(created.id, sandboxTranscript.data), "read")).toBe(true);
			expect(sandboxTranscript.success && hasRootCanonicalToolCall(gateway.sessionManager.buildVisibleMessageSnapshot(created.id, sandboxTranscript.data), "ask_user_choices")).toBe(true);
			await runSandboxTurn("Use only Bobbit gate_list to inspect current workflow state. Do not signal or modify any gate.", "sandbox read-only workflow-gate tool action");
			sandboxTranscript = await gateway.sessionManager.getMessagesSnapshotBase(session);
			const visibleSandboxTranscript = sandboxTranscript.success
				? gateway.sessionManager.buildVisibleMessageSnapshot(created.id, sandboxTranscript.data)
				: undefined;
			expect(sandboxTranscript.success && hasRootCanonicalToolCall(visibleSandboxTranscript, "gate_list")).toBe(true);
			expect(sandboxTranscript.success && hasSuccessfulRootToolResult(visibleSandboxTranscript, "gate_list")).toBe(true);
			await runSandboxTurn("Use exactly one foreground bobbit-backend-parity-reviewer helper to read README.md. Do not create a Bobbit task, team, worktree, or another helper.", "sandbox constrained foreground helper");
			sandboxTranscript = await gateway.sessionManager.getMessagesSnapshotBase(session);
			expect(sandboxTranscript.success && hasOneNestedHelper(gateway.sessionManager.buildVisibleMessageSnapshot(created.id, sandboxTranscript.data))).toBe(true);
			const { applyRuntimeSessionThinkingSelection } = await import("../../dist/server/ws/runtime-model-selection.js");
			const sandboxState = await session.rpcClient.getState();
			const sandboxModel = sandboxState?.data?.model as { thinkingLevelMap?: Record<string, string | null>; reasoning?: boolean } | undefined;
			const sandboxThinking = sandboxModel?.reasoning === true ? Object.entries(sandboxModel.thinkingLevelMap ?? {}).find(([level, value]) => level !== "off" && typeof value === "string")?.[0] : undefined;
			if (sandboxThinking) {
				const effective = await applyRuntimeSessionThinkingSelection(gateway.sessionManager, session, sandboxThinking);
				expect(effective.thinkingLevel === sandboxThinking).toBe(true);
			} else {
				await expect(applyRuntimeSessionThinkingSelection(gateway.sessionManager, session, "low")).rejects.toThrow(/unavailable/i);
			}
			const beforeReplacement = await gateway.sessionManager.getMessagesSnapshotBase(session);
			expect(beforeReplacement.success && hasDurableSubscriptionUsage(gateway.sessionManager.getSessionCost(created.id))).toBe(true);
			// Automatic compaction remains SDK-managed and is only observed if it occurs.
			await gateway.sessionManager.enqueuePrompt(created.id, "Count slowly until told to stop.", { source: "user" });
			await waitFor(() => gateway!.sessionManager.getSession(created.id)?.status === "streaming" ? true : undefined, "sandbox SDK streaming turn");
			await gateway.sessionManager.deliverLiveSteer(created.id, "Stop now and acknowledge this steer.");
			await gateway.sessionManager.abortSessionTurn(created.id);
			await waitFor(() => gateway!.sessionManager.getSession(created.id)?.status === "idle" ? true : undefined, "sandbox SDK interrupt to settle");
			await gateway.sessionManager.forceAbort(created.id);
			session = await waitFor(() => gateway!.sessionManager.getSession(created.id)?.rpcClient?.running ? gateway!.sessionManager.getSession(created.id) : undefined, "sandbox SDK replacement");
			expect(session.runtime).toBe("claude-agent-sdk");
			expect(gateway.sessionManager.getPersistedSession(created.id)?.claudeAgentSdkSessionId).toBe(persistedSdkSessionId);
			// Rebuild the gateway against the same isolated state. This exercises the
			// persisted SDK UUID, fresh container wiring, and subscription handoff a
			// second time without exposing any credential material to the test.
			await gateway.shutdown();
			gateway = createGateway({ host: "127.0.0.1", port: 0, portExplicit: true, authToken: token, defaultCwd: root, forceAuth: true });
			port = await (gateway as any).start();
			session = await waitFor(() => gateway!.sessionManager.getSession(created.id), "sandbox SDK gateway restart");
			await session.rpcClient.waitForReady(120_000);
			expect(gateway.sessionManager.getPersistedSession(created.id)?.claudeAgentSdkSessionId).toBe(persistedSdkSessionId);
			const sandboxReload = await api(`/api/sessions/${created.id}/transcript`);
			expect(sandboxReload.status).toBe(200);
			const afterRestart = await gateway.sessionManager.getMessagesSnapshotBase(session);
			expect(beforeReplacement.success && afterRestart.success && sameTranscriptProjection(beforeReplacement.data, afterRestart.data)).toBe(true);
			expect(hasDurableSubscriptionUsage(gateway.sessionManager.getSessionCost(created.id))).toBe(true);
			await gateway.sessionManager.terminateSession(created.id);
			expect(gateway.sessionManager.getSession(created.id)?.status).toBe("terminated");
		} finally {
			if (gateway) await gateway.shutdown().catch(() => {});
			restoreSmokeEnvironment(originalEnvironment);
			const { resetAgentDirStateForTests } = await import("../../dist/server/bobbit-dir.js");
			resetAgentDirStateForTests();
			if (existsSync(root)) rmSync(root, { recursive: true, force: true });
		}
	});
});
