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

// This project-local role directive makes the native helper journey unambiguous
// without modifying a shared/default role or exposing any private session data.
const manualNativeAgentDirective = "When the user explicitly requests native `Agent`, call the retained native `Agent` tool exactly as requested. Never substitute an MCP or Bobbit helper and never claim completion without that tool.";
const manualHelperRoleName = "backend-parity-reviewer";
const manualHelperRolePrompt = "You are a read-only helper. Execute the assigned task exactly. When asked, use Bobbit read on README.md. Use no other tool. Then report completion.";

type ManualRole = {
	name?: string;
	label?: string;
	accessory?: string;
	promptTemplate?: string;
	toolPolicies?: Record<string, string>;
};

/** Reload through the session's owning project rather than the default manager. */
function manualTranscriptReloadPath(sessionId: string, projectId: string): string {
	return `/api/sessions/${encodeURIComponent(sessionId)}/transcript?projectId=${encodeURIComponent(projectId)}`;
}

/** Isolate the constrained native helper from its normal gate-review prompt. */
async function configureManualHelperRole(
	api: (path: string, init?: RequestInit) => Promise<Response>,
	projectId: string,
): Promise<void> {
	const roleScope = `projectId=${encodeURIComponent(projectId)}`;
	const rolePath = `/api/roles/${manualHelperRoleName}?${roleScope}`;
	const customize = await api(`/api/roles/${manualHelperRoleName}/customize?scope=project&${roleScope}`, { method: "POST" });
	expect(customize.status).toBe(201);
	const beforeResponse = await api(rolePath);
	expect(beforeResponse.status).toBe(200);
	const before = await beforeResponse.json() as ManualRole;
	expect(before.name).toBe(manualHelperRoleName);
	const update = await api(rolePath, {
		method: "PUT",
		body: JSON.stringify({ promptTemplate: manualHelperRolePrompt, toolPolicies: before.toolPolicies }),
	});
	expect(update.status).toBe(200);
	const afterResponse = await api(rolePath);
	expect(afterResponse.status).toBe(200);
	const after = await afterResponse.json() as ManualRole;
	// Persisted configuration only: do not surface role text in test diagnostics.
	expect(after.promptTemplate).toBe(manualHelperRolePrompt);
	expect({
		name: after.name,
		label: after.label,
		accessory: after.accessory,
		toolPolicies: after.toolPolicies,
	}).toEqual({
		name: before.name,
		label: before.label,
		accessory: before.accessory,
		toolPolicies: before.toolPolicies,
	});
}

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

type ManualNestedHelperPhase = "pending" | "running" | "completed" | "error" | "aborted" | "unknown" | "other";
type ManualNestedHelperFacts = {
	rootAgentCall: boolean;
	subagentWorkCount: number;
	phase: ManualNestedHelperPhase;
	nestedMessagePresent: boolean;
	childReadCallPresent: boolean;
	childReadResultPresent: boolean;
	childReadResultError: boolean;
	successfulChildRead: boolean;
};

/** Evaluate exact-parent helper completion without retaining IDs or model data in diagnostics. */
function manualNestedHelperFacts(snapshot: unknown): ManualNestedHelperFacts {
	if (!snapshot || typeof snapshot !== "object") return {
		rootAgentCall: false, subagentWorkCount: 0, phase: "other", nestedMessagePresent: false,
		childReadCallPresent: false, childReadResultPresent: false, childReadResultError: false, successfulChildRead: false,
	};
	const value = snapshot as { messages?: unknown; subagentWork?: unknown };
	const subagentWork = Array.isArray(value.subagentWork) ? value.subagentWork : [];
	const helper = subagentWork.length === 1 && subagentWork[0] && typeof subagentWork[0] === "object"
		? subagentWork[0] as { parentToolUseId?: unknown; phase?: unknown; messages?: unknown }
		: undefined;
	const parentToolUseId = typeof helper?.parentToolUseId === "string" ? helper.parentToolUseId : undefined;
	const phase = ["pending", "running", "completed", "error", "aborted", "unknown"].includes(helper?.phase as string)
		? helper!.phase as Exclude<ManualNestedHelperPhase, "other">
		: "other";
	const rootAgentCall = !!parentToolUseId && Array.isArray(value.messages) && value.messages.some((message: any) =>
		Array.isArray(message?.content) && message.content.some((part: any) =>
			part?.type === "toolCall" && part?.name === "Agent" && part?.id === parentToolUseId,
		),
	);
	const childMessages = Array.isArray(helper?.messages) ? helper.messages : [];
	const nestedMessagePresent = childMessages.length > 0;
	const readCallIds = new Set(childMessages.flatMap((message: any) => Array.isArray(message?.content)
		? message.content.flatMap((part: any) => part?.type === "toolCall" && part?.name === "read" && typeof part?.id === "string" ? [part.id] : [])
		: []));
	const childReadCallPresent = readCallIds.size > 0;
	const readResults = childMessages.filter((message: any) =>
		message?.role === "toolResult" && message?.toolName === "read"
		&& typeof message?.toolCallId === "string" && readCallIds.has(message.toolCallId),
	);
	const childReadResultPresent = readResults.length > 0;
	const childReadResultError = readResults.some((message: any) => message?.isError === true);
	const successfulChildRead = childReadResultPresent && !childReadResultError;
	return {
		rootAgentCall,
		subagentWorkCount: Math.min(subagentWork.length, 1_000_000),
		phase,
		nestedMessagePresent,
		childReadCallPresent,
		childReadResultPresent,
		childReadResultError,
		successfulChildRead,
	};
}

function assertManualNestedHelper(snapshot: unknown): void {
	const facts = manualNestedHelperFacts(snapshot);
	if (facts.rootAgentCall && facts.subagentWorkCount === 1 && facts.phase === "completed" && facts.nestedMessagePresent) return;
	throw new Error(JSON.stringify(facts));
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

type ManualTranscriptPrefixFacts = {
	beforeArray: boolean;
	afterArray: boolean;
	beforeCount: number;
	afterCount: number;
	beforeNonempty: boolean;
	afterHasAtLeastBeforeRows: boolean;
	beforeRowsHaveNonemptySdkIdAndRole: boolean;
	prefixIdsAndRolesPreserved: boolean;
};

/** Preserve finalized history while allowing the SDK to append shutdown-tail rows. */
function manualTranscriptPrefixFacts(before: unknown, after: unknown): ManualTranscriptPrefixFacts {
	const rows = (value: unknown): Array<Record<string, unknown> | undefined> | undefined => {
		if (Array.isArray(value)) {
			return value.map(row => row && typeof row === "object" && !Array.isArray(row)
				? row as Record<string, unknown>
				: undefined);
		}
		if (value && typeof value === "object" && Array.isArray((value as { messages?: unknown }).messages)) {
			return rows((value as { messages: unknown }).messages);
		}
		return undefined;
	};
	const left = rows(before);
	const right = rows(after);
	const beforeCount = left?.length ?? 0;
	const afterCount = right?.length ?? 0;
	const hasNonemptySdkIdAndRole = (row: Record<string, unknown> | undefined): boolean =>
		typeof row?.id === "string" && row.id.length > 0 && typeof row.role === "string" && row.role.length > 0;
	const beforeRowsHaveNonemptySdkIdAndRole = !!left && left.every(hasNonemptySdkIdAndRole);
	const prefixIdsAndRolesPreserved = !!left && !!right
		&& left.every((row, index) => hasNonemptySdkIdAndRole(row)
			&& hasNonemptySdkIdAndRole(right[index])
			&& row?.id === right[index]?.id
			&& row?.role === right[index]?.role);
	return {
		beforeArray: !!left,
		afterArray: !!right,
		beforeCount,
		afterCount,
		beforeNonempty: beforeCount > 0,
		afterHasAtLeastBeforeRows: afterCount >= beforeCount,
		beforeRowsHaveNonemptySdkIdAndRole,
		prefixIdsAndRolesPreserved,
	};
}

/** Emit only counts and fixed booleans if restart/reload violates prefix preservation. */
function assertManualTranscriptPrefixProjection(before: unknown, after: unknown): void {
	const facts = manualTranscriptPrefixFacts(before, after);
	if (
		facts.beforeArray
		&& facts.afterArray
		&& facts.beforeNonempty
		&& facts.afterHasAtLeastBeforeRows
		&& facts.beforeRowsHaveNonemptySdkIdAndRole
		&& facts.prefixIdsAndRolesPreserved
	) return;
	throw new Error(JSON.stringify(facts));
}

function manualSdkModel(): string {
	const configuredModel = process.env.MANUAL_CLAUDE_AGENT_SDK_MODEL?.trim();
	if (!configuredModel || configuredModel.startsWith("claude-agent-sdk/")) {
		throw new Error("Claude Agent SDK smoke requires MANUAL_CLAUDE_AGENT_SDK_MODEL without the provider prefix.");
	}
	return configuredModel;
}

/** SDK-supported wire aliases make the live control target deterministic. */
function alternateManualSdkModel(configuredModel: string): string {
	const normalized = configuredModel.trim().toLowerCase();
	return /(?:^|[-_])haiku(?:$|[-_])/.test(normalized) ? "sonnet" : "haiku";
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

/**
 * Correlate one queued prompt with its root lifecycle without retaining event
 * payloads. Claude SDK child events are partitioned from root events, but keep
 * the parent guard explicit so an admitted helper cannot settle its parent.
 */
function observeManualRootTurnLifecycle(source: { onEvent(listener: (event: unknown) => void): () => void }): {
	started(): boolean;
	completed(): boolean;
	diagnostics(): { rootAgentStarted: boolean; rootAgentTerminal: boolean };
	unsubscribe(): void;
} {
	let rootAgentStarted = false;
	let rootAgentTerminal = false;
	const unsubscribe = source.onEvent(event => {
		if (!event || typeof event !== "object") return;
		const lifecycle = event as { type?: unknown; parentToolUseId?: unknown; willRetry?: unknown };
		if (lifecycle.parentToolUseId !== undefined) return;
		if (lifecycle.type === "agent_start") rootAgentStarted = true;
		if (rootAgentStarted && lifecycle.type === "agent_end" && lifecycle.willRetry !== true) rootAgentTerminal = true;
	});
	return {
		started: () => rootAgentStarted,
		completed: () => rootAgentStarted && rootAgentTerminal,
		diagnostics: () => ({ rootAgentStarted, rootAgentTerminal }),
		unsubscribe,
	};
}

type ManualCanonicalToolCategory = "read" | "grep" | "other";
type ManualCanonicalToolExecutionCounts = Record<ManualCanonicalToolCategory, { starts: number; ends: number }>;

function createManualCanonicalToolExecutionCounts(): ManualCanonicalToolExecutionCounts {
	return {
		read: { starts: 0, ends: 0 },
		grep: { starts: 0, ends: 0 },
		other: { starts: 0, ends: 0 },
	};
}

/** Classify tool names to fixed diagnostic categories without retaining tool data. */
function manualCanonicalToolCategory(toolName: unknown): ManualCanonicalToolCategory {
	return toolName === "read" || toolName === "grep" ? toolName : "other";
}

/** Count only canonical tool boundaries; never inspect arguments, results, content, or IDs. */
function countManualCanonicalToolExecution(counts: ManualCanonicalToolExecutionCounts, event: unknown): void {
	if (!event || typeof event !== "object") return;
	const { type, toolName } = event as { type?: unknown; toolName?: unknown };
	if (type !== "tool_execution_start" && type !== "tool_execution_end") return;
	const category = manualCanonicalToolCategory(toolName);
	const boundary = type === "tool_execution_start" ? "starts" : "ends";
	counts[category][boundary] = Math.min(counts[category][boundary] + 1, 1_000_000);
}

/**
 * Durable visible history is the execution oracle. Stream boundaries are only
 * fixed-category diagnostics because official SDK frames may arrive late.
 */
function assertManualDurableCanonicalToolExecution(
	snapshot: unknown,
	toolName: Exclude<ManualCanonicalToolCategory, "other">,
	counts?: ManualCanonicalToolExecutionCounts,
): void {
	const hasCall = hasRootCanonicalToolCall(snapshot, toolName);
	const hasSuccessfulResult = hasSuccessfulRootToolResult(snapshot, toolName);
	if (!hasCall || !hasSuccessfulResult) {
		throw new Error(JSON.stringify({ hasCall, hasSuccessfulResult, ...(counts ? { counts } : {}) }));
	}
}

function diagnosticBoolean(read: () => unknown): boolean {
	try { return read() === true; } catch { return false; }
}

function diagnosticValue(read: () => unknown): unknown {
	try { return read(); } catch { return undefined; }
}

function normalizeManualBridgeState(value: unknown): "new" | "starting" | "ready" | "running" | "interrupting" | "failed" | "stopped" | "other" {
	return ["new", "starting", "ready", "running", "interrupting", "failed", "stopped"].includes(value as string)
		? value as "new" | "starting" | "ready" | "running" | "interrupting" | "failed" | "stopped"
		: "other";
}

/** Build terminal smoke facts without retaining turn, provider, or bridge payloads. */
function manualTerminalTurnFacts({
	eventTypeCounts,
	lifecycle,
	bridge,
	bridgeRunning,
	pendingToolPermission,
	routeDiagnostic,
}: {
	eventTypeCounts: Record<ManualTurnEventType, number>;
	lifecycle: { diagnostics(): { rootAgentStarted: boolean; rootAgentTerminal: boolean } };
	bridge: Record<string, unknown>;
	bridgeRunning: boolean;
	pendingToolPermission: boolean;
	routeDiagnostic(error: unknown): string;
}): {
	eventTypeCounts: Record<ManualTurnEventType, number>;
	rootLifecycle: { rootAgentStarted: boolean; rootAgentTerminal: boolean };
	bridgeRunning: boolean;
	bridgeLifecycleState: ReturnType<typeof normalizeManualBridgeState>;
	sdkTerminalDiagnostic: string;
	pendingToolPermission: boolean;
	bridgeInputQueue: { hasQueuedRows: boolean; hasWaitingReader: boolean };
	initializationComplete: boolean;
	queryHandlePresent: boolean;
} {
	const input = diagnosticValue(() => bridge.input) as Record<string, unknown> | undefined;
	return {
		eventTypeCounts,
		rootLifecycle: lifecycle.diagnostics(),
		bridgeRunning,
		bridgeLifecycleState: normalizeManualBridgeState(diagnosticValue(() => bridge.state)),
		sdkTerminalDiagnostic: routeDiagnostic(diagnosticValue(() => bridge.terminalError)),
		pendingToolPermission,
		bridgeInputQueue: {
			hasQueuedRows: diagnosticBoolean(() => Array.isArray(input?.rows) && input.rows.length > 0),
			hasWaitingReader: diagnosticBoolean(() => input?.reader !== undefined),
		},
		initializationComplete: diagnosticBoolean(() => bridge.initializationComplete),
		queryHandlePresent: diagnosticBoolean(() => bridge.queryHandle !== undefined),
	};
}

/**
 * Initial Docker bridge startup can fail before a prompt subscribes to its
 * lifecycle. Replace that raw rejection with the same safe terminal schema
 * used by prompt turns, without changing the readiness timeout or retry path.
 */
async function waitForManualDockerInitialReadiness(
	rpcClient: { waitForReady(timeoutMs: number): Promise<void>; readonly running: boolean },
	routeDiagnostic: (error: unknown) => string,
): Promise<void> {
	const bridge = rpcClient as unknown as Record<string, unknown>;
	try {
		await rpcClient.waitForReady(120_000);
	} catch {
		throw new Error(JSON.stringify(manualTerminalTurnFacts({
			eventTypeCounts: createManualTurnEventCounts(),
			lifecycle: { diagnostics: () => ({ rootAgentStarted: false, rootAgentTerminal: false }) },
			bridge,
			bridgeRunning: diagnosticBoolean(() => rpcClient.running),
			pendingToolPermission: false,
			routeDiagnostic,
		})));
	}
}

test("Claude Agent SDK manual timeout event diagnostics retain only fixed event categories", () => {
	const counts = createManualTurnEventCounts();
	countManualTurnEvent(counts, { type: "agent_start", privatePayload: "must-not-appear" });
	countManualTurnEvent(counts, { type: "provider_detail", privatePayload: "must-not-appear" });
	expect(Object.keys(counts)).toEqual(manualTurnEventTypes);
	expect(counts.agent_start).toBe(1);
	expect(counts.other).toBe(1);
});

test("Claude Agent SDK manual lifecycle waits for a root start followed by its terminal", () => {
	let listener: ((event: unknown) => void) | undefined;
	const lifecycle = observeManualRootTurnLifecycle({
		onEvent: next => {
			listener = next;
			return () => { listener = undefined; };
		},
	});
	listener?.({ type: "agent_end" });
	listener?.({ type: "agent_start", parentToolUseId: "child" });
	listener?.({ type: "agent_end", parentToolUseId: "child" });
	expect(lifecycle.completed()).toBe(false);
	listener?.({ type: "agent_start" });
	listener?.({ type: "agent_end", willRetry: true });
	expect(lifecycle.diagnostics()).toEqual({ rootAgentStarted: true, rootAgentTerminal: false });
	listener?.({ type: "agent_end" });
	expect(lifecycle.completed()).toBe(true);
	lifecycle.unsubscribe();
	expect(listener).toBeUndefined();
});

test("Claude Agent SDK manual helper oracle requires completed nested work, not child tool choice", () => {
	const complete = {
		messages: [{ content: [{ type: "toolCall", name: "Agent", id: "private-root-agent-id" }] }],
		subagentWork: [{
			parentToolUseId: "private-root-agent-id", phase: "completed",
			messages: [
				{ content: [{ type: "toolCall", name: "read", id: "private-child-read-id" }] },
				{ role: "toolResult", toolName: "read", toolCallId: "private-child-read-id", isError: false },
			],
		}],
	};
	expect(manualNestedHelperFacts(complete)).toEqual({
		rootAgentCall: true, subagentWorkCount: 1, phase: "completed", nestedMessagePresent: true,
		childReadCallPresent: true, childReadResultPresent: true, childReadResultError: false, successfulChildRead: true,
	});
	const completedWithoutChildTool = {
		messages: [{ content: [{ type: "toolCall", name: "Agent", id: "private-root-agent-id" }] }],
		subagentWork: [{ parentToolUseId: "private-root-agent-id", phase: "completed", messages: [{}] }],
	};
	expect(manualNestedHelperFacts(completedWithoutChildTool)).toEqual({
		rootAgentCall: true, subagentWorkCount: 1, phase: "completed", nestedMessagePresent: true,
		childReadCallPresent: false, childReadResultPresent: false, childReadResultError: false, successfulChildRead: false,
	});
	expect(() => assertManualNestedHelper(completedWithoutChildTool)).not.toThrow();
	let diagnostic = "";
	try { assertManualNestedHelper({ messages: [], subagentWork: [] }); }
	catch (error) { diagnostic = error instanceof Error ? error.message : ""; }
	expect(JSON.parse(diagnostic)).toEqual({
		rootAgentCall: false, subagentWorkCount: 0, phase: "other", nestedMessagePresent: false,
		childReadCallPresent: false, childReadResultPresent: false, childReadResultError: false, successfulChildRead: false,
	});
	for (const privateValue of ["private-root-agent-id", "private-child-read-id"]) expect(diagnostic).not.toContain(privateValue);
});

test("Claude Agent SDK manual durable tool oracle retains only fixed booleans and event counts", () => {
	const counts = createManualCanonicalToolExecutionCounts();
	countManualCanonicalToolExecution(counts, { type: "tool_execution_start", toolName: "read", args: { private: "must-not-appear" } });
	countManualCanonicalToolExecution(counts, { type: "tool_execution_end", toolName: "read", result: { private: "must-not-appear" } });
	countManualCanonicalToolExecution(counts, { type: "tool_execution_start", toolName: "grep", toolCallId: "must-not-appear" });
	countManualCanonicalToolExecution(counts, { type: "tool_execution_end", toolName: "unexpected_tool", content: "must-not-appear" });
	expect(counts).toEqual({
		read: { starts: 1, ends: 1 },
		grep: { starts: 1, ends: 0 },
		other: { starts: 0, ends: 1 },
	});
	const successfulReadHistory = {
		messages: [
			{ content: [{ type: "toolCall", name: "read", id: "read-call" }] },
			{ role: "toolResult", toolName: "read", toolCallId: "read-call", isError: false },
		],
	};
	const successfulGrepHistory = {
		messages: [
			{ content: [{ type: "toolCall", name: "grep", id: "grep-call" }] },
			{ role: "toolResult", toolName: "grep", toolCallId: "grep-call", isError: false },
		],
	};
	expect(() => assertManualDurableCanonicalToolExecution(successfulReadHistory, "read")).not.toThrow();
	expect(() => assertManualDurableCanonicalToolExecution(successfulGrepHistory, "grep", counts)).not.toThrow();
	let diagnostic = "";
	try {
		assertManualDurableCanonicalToolExecution(undefined, "grep", counts);
	} catch (error) {
		diagnostic = error instanceof Error ? error.message : "";
	}
	expect(JSON.parse(diagnostic)).toEqual({
		hasCall: false,
		hasSuccessfulResult: false,
		counts,
	});
	expect(diagnostic).not.toContain("must-not-appear");
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

test("Claude Agent SDK manual Docker terminal facts retain only safe schema and route category", async () => {
	const { ClaudeAgentSdkUnavailableError, claudeAgentSdkUnavailableRouteDiagnostic } = await import("../../dist/server/agent/claude-agent-sdk-error.js");
	const privateValue = "must-not-appear";
	const eventTypeCounts = createManualTurnEventCounts();
	countManualTurnEvent(eventTypeCounts, { type: "agent_start", prompt: privateValue });
	const facts = manualTerminalTurnFacts({
		eventTypeCounts,
		lifecycle: { diagnostics: () => ({ rootAgentStarted: true, rootAgentTerminal: true }) },
		bridge: {
			state: "failed",
			terminalError: new ClaudeAgentSdkUnavailableError(`provider body=${privateValue} CLAUDE_AGENT_SDK_SANDBOX_AUTH_UNAVAILABLE`),
			input: { rows: [{ prompt: privateValue }], reader: { id: privateValue } },
			initializationComplete: true,
			queryHandle: { id: privateValue },
		},
		bridgeRunning: false,
		pendingToolPermission: true,
		routeDiagnostic: claudeAgentSdkUnavailableRouteDiagnostic,
	});
	expect(facts).toEqual({
		eventTypeCounts,
		rootLifecycle: { rootAgentStarted: true, rootAgentTerminal: true },
		bridgeRunning: false,
		bridgeLifecycleState: "failed",
		sdkTerminalDiagnostic: "SDK_SESSION_UNAVAILABLE: CLAUDE_AGENT_SDK_SANDBOX_AUTH_UNAVAILABLE",
		pendingToolPermission: true,
		bridgeInputQueue: { hasQueuedRows: true, hasWaitingReader: true },
		initializationComplete: true,
		queryHandlePresent: true,
	});
	const serialized = JSON.stringify(facts);
	for (const secret of [privateValue, "provider body"]) expect(serialized).not.toContain(secret);
});

test("Claude Agent SDK manual Docker terminal facts normalize unknown bridge data", async () => {
	const { claudeAgentSdkUnavailableRouteDiagnostic } = await import("../../dist/server/agent/claude-agent-sdk-error.js");
	const facts = manualTerminalTurnFacts({
		eventTypeCounts: createManualTurnEventCounts(),
		lifecycle: { diagnostics: () => ({ rootAgentStarted: false, rootAgentTerminal: false }) },
		bridge: { state: "private-state", terminalError: new Error("private provider failure") },
		bridgeRunning: false,
		pendingToolPermission: false,
		routeDiagnostic: claudeAgentSdkUnavailableRouteDiagnostic,
	});
	expect(facts.bridgeLifecycleState).toBe("other");
	expect(facts.sdkTerminalDiagnostic).toBe("SDK_SESSION_UNAVAILABLE");
	const serialized = JSON.stringify(facts);
	for (const secret of ["private-state", "private provider failure"]) expect(serialized).not.toContain(secret);
});

test("Claude Agent SDK manual Docker readiness failure emits safe pre-turn terminal facts", async () => {
	const { ClaudeAgentSdkUnavailableError, claudeAgentSdkUnavailableRouteDiagnostic } = await import("../../dist/server/agent/claude-agent-sdk-error.js");
	const privateValue = "must-not-appear";
	let readinessTimeout: number | undefined;
	const rpcClient = {
		running: false,
		state: "failed",
		terminalError: new ClaudeAgentSdkUnavailableError(`provider body=${privateValue} CLAUDE_AGENT_SDK_SANDBOX_AUTH_UNAVAILABLE`),
		async waitForReady(timeoutMs: number): Promise<void> {
			readinessTimeout = timeoutMs;
			throw new Error(`raw error ${privateValue}`);
		},
	};
	let diagnostic = "";
	try {
		await waitForManualDockerInitialReadiness(rpcClient, claudeAgentSdkUnavailableRouteDiagnostic);
	} catch (error) {
		diagnostic = error instanceof Error ? error.message : "";
	}
	expect(readinessTimeout).toBe(120_000);
	expect(JSON.parse(diagnostic)).toEqual({
		eventTypeCounts: createManualTurnEventCounts(),
		rootLifecycle: { rootAgentStarted: false, rootAgentTerminal: false },
		bridgeRunning: false,
		bridgeLifecycleState: "failed",
		sdkTerminalDiagnostic: "SDK_SESSION_UNAVAILABLE: CLAUDE_AGENT_SDK_SANDBOX_AUTH_UNAVAILABLE",
		pendingToolPermission: false,
		bridgeInputQueue: { hasQueuedRows: false, hasWaitingReader: false },
		initializationComplete: false,
		queryHandlePresent: false,
	});
	for (const secret of [privateValue, "provider body", "raw error"]) expect(diagnostic).not.toContain(secret);
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

test("Claude Agent SDK manual live controls choose a distinct SDK wire alias", () => {
	expect({
		fullHaiku: alternateManualSdkModel("claude-haiku-4-5"),
		aliasHaiku: alternateManualSdkModel("HaIkU"),
		sonnet: alternateManualSdkModel("claude-sonnet-4-5"),
	}).toEqual({ fullHaiku: "sonnet", aliasHaiku: "sonnet", sonnet: "haiku" });
});

test("Claude Agent SDK manual restart transcript oracle preserves a nonempty finalized prefix and permits an additive tail", () => {
	const before = {
		messages: [
			{ id: "private-user-id", role: "user" },
			{ id: "private-assistant-id", role: "assistant" },
		],
	};
	const exact = {
		messages: [
			{ id: "private-user-id", role: "user" },
			{ id: "private-assistant-id", role: "assistant" },
		],
	};
	const additiveTail = {
		messages: [
			...exact.messages,
			{ id: "private-finalized-tail-id", role: "toolResult" },
		],
	};
	expect(() => assertManualTranscriptPrefixProjection(before, exact)).not.toThrow();
	expect(() => assertManualTranscriptPrefixProjection(before, additiveTail)).not.toThrow();
	expect(manualTranscriptPrefixFacts(before, additiveTail)).toEqual({
		beforeArray: true,
		afterArray: true,
		beforeCount: 2,
		afterCount: 3,
		beforeNonempty: true,
		afterHasAtLeastBeforeRows: true,
		beforeRowsHaveNonemptySdkIdAndRole: true,
		prefixIdsAndRolesPreserved: true,
	});
});

test("Claude Agent SDK manual restart transcript oracle rejects removed, reordered, changed, and empty history", () => {
	const before = {
		messages: [
			{ id: "private-user-id", role: "user" },
			{ id: "private-assistant-id", role: "assistant" },
		],
	};
	const invalidSnapshots = [
		{ messages: [{ id: "private-user-id", role: "user" }] },
		{ messages: [{ id: "private-assistant-id", role: "assistant" }, { id: "private-user-id", role: "user" }] },
		{ messages: [{ id: "private-changed-id", role: "user" }, { id: "private-assistant-id", role: "assistant" }] },
		{ messages: [{ id: "private-user-id", role: "toolResult" }, { id: "private-assistant-id", role: "assistant" }] },
		{ messages: [] },
		{ messages: [{ id: "", role: "user" }, { id: "private-assistant-id", role: "assistant" }] },
	];
	for (const after of invalidSnapshots) {
		let diagnostic = "";
		try {
			assertManualTranscriptPrefixProjection(before, after);
		} catch (error) {
			diagnostic = error instanceof Error ? error.message : "";
		}
		expect(diagnostic).not.toBe("");
		const facts = JSON.parse(diagnostic) as ManualTranscriptPrefixFacts;
		expect(Object.keys(facts)).toEqual([
			"beforeArray", "afterArray", "beforeCount", "afterCount", "beforeNonempty", "afterHasAtLeastBeforeRows",
			"beforeRowsHaveNonemptySdkIdAndRole", "prefixIdsAndRolesPreserved",
		]);
		expect(
			facts.beforeNonempty
			&& facts.afterHasAtLeastBeforeRows
			&& facts.beforeRowsHaveNonemptySdkIdAndRole
			&& facts.prefixIdsAndRolesPreserved,
		).toBe(false);
		for (const privateValue of ["private-user-id", "private-assistant-id", "private-changed-id"]) {
			expect(diagnostic).not.toContain(privateValue);
		}
	}
});

test("Claude Agent SDK manual transcript reload scopes and encodes its project", () => {
	expect(manualTranscriptReloadPath("session/id", "project & id")).toBe(
		"/api/sessions/session%2Fid/transcript?projectId=project%20%26%20id",
	);
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
			writeFileSync(join(projectRoot, "README.md"), "Bobbit SDK manual smoke\n");
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
			// while the read-only gate query remains non-interactive. Deny the
			// canonical delegate tool so native Agent remains the only helper path.
			// Role reads and mutations require an explicit scope; customize first so
			// this never changes the headquarters/server configuration.
			const roleScope = `projectId=${encodeURIComponent(project.id)}`;
			const roleCustomize = await api(`/api/roles/general/customize?scope=project&${roleScope}`, { method: "POST" });
			expect(roleCustomize.status).toBe(201);
			const roleResponse = await api(`/api/roles/general?${roleScope}`);
			expect(roleResponse.status).toBe(200);
			const role = await roleResponse.json() as { promptTemplate?: string; toolPolicies?: Record<string, string> };
			expect(typeof role.promptTemplate).toBe("string");
			if (typeof role.promptTemplate !== "string") throw new Error("Manual SDK role is missing its prompt template.");
			const configuredRolePrompt = `${role.promptTemplate}\n\n${manualNativeAgentDirective}`;
			const roleUpdate = await api(`/api/roles/general?${roleScope}`, {
				method: "PUT",
				body: JSON.stringify({
					promptTemplate: configuredRolePrompt,
					toolPolicies: { ...(role.toolPolicies ?? {}), Gates: "allow", grep: "ask", team_delegate: "never" },
				}),
			});
			expect(roleUpdate.status).toBe(200);
			const configuredRoleResponse = await api(`/api/roles/general?${roleScope}`);
			expect(configuredRoleResponse.status).toBe(200);
			const configuredRole = await configuredRoleResponse.json() as { promptTemplate?: string; toolPolicies?: Record<string, string> };
			expect({
				promptPreservedAndAppended: configuredRole.promptTemplate === configuredRolePrompt,
				promptIncludesNativeAgentDirective: configuredRole.promptTemplate?.includes(manualNativeAgentDirective) === true,
				promptEndsWithNativeAgentDirective: configuredRole.promptTemplate?.endsWith(manualNativeAgentDirective) === true,
				existingPoliciesPreserved: Object.entries(role.toolPolicies ?? {}).every(([tool, policy]) => ["Gates", "grep", "team_delegate"].includes(tool) || configuredRole.toolPolicies?.[tool] === policy),
				gates: configuredRole.toolPolicies?.Gates,
				grep: configuredRole.toolPolicies?.grep,
				teamDelegate: configuredRole.toolPolicies?.team_delegate,
			}).toEqual({
				promptPreservedAndAppended: true,
				promptIncludesNativeAgentDirective: true,
				promptEndsWithNativeAgentDirective: true,
				existingPoliciesPreserved: true,
				gates: "allow",
				grep: "ask",
				teamDelegate: "never",
			});

			// Keep the normal role override above separate from the constrained helper
			// role. Its production gate-review prompt invokes tools not exposed to the
			// native child, so replace it only in this temporary project.
			await configureManualHelperRole(api, project.id);

			const configuredModel = manualSdkModel();
			const alternateModel = alternateManualSdkModel(configuredModel);
			expect(alternateModel).not.toBe(configuredModel);
			const sessionModel = `claude-agent-sdk/${configuredModel}`;
			const { claudeAgentSdkUnavailableRouteDiagnostic } = await import("../../dist/server/agent/claude-agent-sdk-error.js");
			const providerResponse = await api("/api/custom-providers", {
				method: "POST",
				body: JSON.stringify({
					id: "claude-agent-sdk",
					name: "claude-agent-sdk",
					type: "manual",
					baseUrl: "http://127.0.0.1:9",
					models: [
						{ id: configuredModel, name: "Manual Claude Agent SDK smoke" },
						{ id: alternateModel, name: "Manual Claude Agent SDK live-control target" },
					],
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
				const eventTypeCounts = createManualTurnEventCounts();
				const bridge = session.rpcClient as unknown as Record<string, unknown>;
				const terminalDiagnostic = () => claudeAgentSdkUnavailableRouteDiagnostic(diagnosticValue(() => bridge.terminalError));
				// Subscribe before enqueue: a synchronous accepted turn can otherwise emit
				// both lifecycle boundaries before a post-enqueue observer is installed.
				const lifecycle = observeManualRootTurnLifecycle(session.rpcClient);
				const unsubscribeCounts = session.rpcClient.onEvent(event => countManualTurnEvent(eventTypeCounts, event));
				try {
					await gateway!.sessionManager.enqueuePrompt(created.id, text, { source: "user", ...options });
					await waitFor(() => lifecycle.completed() ? true : undefined, `${label} root terminal`, 120_000);
				} catch (error) {
					if (error instanceof Error && error.message === `Timed out waiting for ${label} root terminal`) {
						const input = diagnosticValue(() => bridge.input) as Record<string, unknown> | undefined;
						throw new Error(JSON.stringify({
							label,
							eventTypeCounts,
							rootLifecycle: lifecycle.diagnostics(),
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
					unsubscribeCounts();
					lifecycle.unsubscribe();
				}
			};

			// Use the same SessionManager queue/steer path as the gateway. This keeps
			// the smoke on the production IRpcBridge boundary while avoiding a second
			// browser protocol and never recording model output in test diagnostics.
			await runTurn("Reply with exactly: SDK_SMOKE_READY", "first SDK prompt");
			const persistedSdkSessionId = await waitFor(
				() => {
					const id = gateway!.sessionManager.getPersistedSession(created.id)?.claudeAgentSdkSessionId;
					return typeof id === "string" ? id : undefined;
				},
				"persisted SDK session identity after first prompt",
			);

			// Keep this tool-free control turn before slash expansion to distinguish a
			// generic multi-turn lifecycle failure from a slash payload failure.
			await runTurn("Reply with exactly: SDK_SMOKE_SECOND_TURN. Do not use tools.", "plain second SDK turn");

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

			// An allowed read is one complete turn before the permission-gated grep.
			await runTurn("Use only Bobbit read on README.md. Do not use any other tools.", "canonical Bobbit read turn");
			let transcript = await gateway.sessionManager.getMessagesSnapshotBase(session);
			const visibleCanonicalReadTranscript = transcript.success
				? gateway.sessionManager.buildVisibleMessageSnapshot(created.id, transcript.data)
				: undefined;
			assertManualDurableCanonicalToolExecution(visibleCanonicalReadTranscript, "read");

			// Count only fixed tool categories for the separate permission-card turn.
			const canonicalGrepExecution = createManualCanonicalToolExecutionCounts();
			const canonicalGrepLifecycle = observeManualRootTurnLifecycle(session.rpcClient);
			const unsubscribeCanonicalGrepExecution = session.rpcClient.onEvent(event => countManualCanonicalToolExecution(canonicalGrepExecution, event));
			try {
				await gateway.sessionManager.enqueuePrompt(created.id, "Use exactly one Bobbit grep with pattern Bobbit, path README.md, and literal true. Do not use any other tools.", { source: "user" });
				const permission = await waitFor(
					() => {
						const pending = gateway!.sessionManager.getPendingToolPermission(created.id);
						return pending?.toolName === "grep" && pending.group === "File System" ? pending : undefined;
					},
					"canonical grep permission card",
					90_000,
				);
				expect(permission.toolName === "grep" && permission.group === "File System").toBe(true);
				await gateway.sessionManager.grantToolPermission(created.id, "grep", "tool", "File System", "one-time", permission.id);
				await waitFor(() => canonicalGrepLifecycle.completed() ? true : undefined, "canonical Bobbit grep root terminal", 120_000);
			} finally {
				unsubscribeCanonicalGrepExecution();
				canonicalGrepLifecycle.unsubscribe();
			}
			// Fetch durable visible history before evaluating fixed boundary diagnostics.
			transcript = await gateway.sessionManager.getMessagesSnapshotBase(session);
			const visibleCanonicalGrepTranscript = transcript.success
				? gateway.sessionManager.buildVisibleMessageSnapshot(created.id, transcript.data)
				: undefined;
			assertManualDurableCanonicalToolExecution(visibleCanonicalGrepTranscript, "grep", canonicalGrepExecution);

			// This is read-only: it observes workflow state without signaling a real gate.
			await runTurn("Use only Bobbit gate_list to inspect the current workflow state; do not signal or modify any gate.", "read-only workflow-gate tool action");
			transcript = await gateway.sessionManager.getMessagesSnapshotBase(session);
			const visibleTranscript = transcript.success
				? gateway.sessionManager.buildVisibleMessageSnapshot(created.id, transcript.data)
				: undefined;
			expect(transcript.success && hasRootCanonicalToolCall(visibleTranscript, "gate_list")).toBe(true);
			expect(transcript.success && hasSuccessfulRootToolResult(visibleTranscript, "gate_list")).toBe(true);

			await runTurn("Call the native Agent tool exactly once with run_in_background: false and subagent_type: \"bobbit-backend-parity-reviewer\". Its task must be: use the Bobbit read tool on README.md. Do not call any other root tool. Do not create or invoke an additional helper.", "constrained foreground helper");
			transcript = await gateway.sessionManager.getMessagesSnapshotBase(session);
			if (!transcript.success) throw new Error(JSON.stringify(manualNestedHelperFacts(undefined)));
			assertManualNestedHelper(gateway.sessionManager.buildVisibleMessageSnapshot(created.id, transcript.data));
			// A native helper is rendered beneath its root Agent card, not as a Bobbit session.
			expect(gateway.sessionManager.listSessions()).toHaveLength(1);

			// Use the production live-control transaction with the same isolated
			// preferences store as the session. This must not retry or fall back.
			const { applyRuntimeSessionModelSelection } = await import("../../dist/server/ws/runtime-model-selection.js");
			const beforeModelChange = await session.rpcClient.getState();
			const currentThinking = beforeModelChange?.data?.thinkingLevel;
			expect({
				provider: beforeModelChange?.data?.model?.provider,
				id: beforeModelChange?.data?.model?.id,
				thinkingLevel: currentThinking,
			}).toEqual({ provider: "claude-agent-sdk", id: configuredModel, thinkingLevel: "off" });
			const selectedModel = await applyRuntimeSessionModelSelection(
				gateway.sessionManager,
				session,
				"claude-agent-sdk",
				alternateModel,
				currentThinking,
				gateway.sessionManager.preferencesStore,
			);
			expect(selectedModel).toEqual({ provider: "claude-agent-sdk", id: alternateModel, thinkingLevel: currentThinking });
			const afterModelChange = await session.rpcClient.getState();
			expect({
				provider: afterModelChange?.data?.model?.provider,
				id: afterModelChange?.data?.model?.id,
				thinkingLevel: afterModelChange?.data?.thinkingLevel,
			}).toEqual(selectedModel);

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

			const expectedResumeTuple = await session.rpcClient.getState();
			expect(expectedResumeTuple?.data?.model?.id).toBe(alternateModel);
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
			const resumedModel = await session.rpcClient.getState();
			expect({
				provider: resumedModel?.data?.model?.provider,
				id: resumedModel?.data?.model?.id,
				thinkingLevel: resumedModel?.data?.thinkingLevel,
			}).toEqual({
				provider: expectedResumeTuple?.data?.model?.provider,
				id: expectedResumeTuple?.data?.model?.id,
				thinkingLevel: expectedResumeTuple?.data?.thinkingLevel,
			});
			const reloaded = await api(manualTranscriptReloadPath(created.id, project.id));
			expect(reloaded.status).toBe(200);
			const afterRestart = await gateway.sessionManager.getMessagesSnapshotBase(session);
			expect(beforeRestart.success && afterRestart.success).toBe(true);
			assertManualTranscriptPrefixProjection(beforeRestart.data, afterRestart.data);
			expect(hasDurableSubscriptionUsage(gateway.sessionManager.getSessionCost(created.id))).toBe(true);

			const interruptedTurnLifecycle = observeManualRootTurnLifecycle(session.rpcClient);
			try {
				await gateway.sessionManager.enqueuePrompt(
					created.id,
					"Count from 1 to 1000 slowly, one number per line, until you receive a new instruction.",
					{ source: "user" },
				);
				await waitFor(() => interruptedTurnLifecycle.started() ? true : undefined, "SDK streaming turn");
				await gateway.sessionManager.deliverLiveSteer(created.id, "Stop counting now and briefly acknowledge this steer.");
				await gateway.sessionManager.abortSessionTurn(created.id);
				expect(session.rpcClient.running, "soft interrupt must not close the SDK query").toBe(true);
				await waitFor(() => interruptedTurnLifecycle.completed() ? true : undefined, "soft interrupt root terminal", 120_000);
			} finally {
				interruptedTurnLifecycle.unsubscribe();
			}

			const terminated = await gateway.sessionManager.terminateSession(created.id);
			expect(terminated).toBe(true);
			expect(gateway.sessionManager.getSession(created.id)).toBeUndefined();
			expect(gateway.sessionManager.getPersistedSession(created.id)?.archived).toBe(true);
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
		const alternateModel = alternateManualSdkModel(configuredModel);
		expect(alternateModel).not.toBe(configuredModel);
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
			writeFileSync(join(projectRoot, "README.md"), "Bobbit SDK manual smoke\n");
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
			// Keep the grep permission-card role override inside this temporary project.
			// Deny the canonical delegate tool so native Agent remains the only helper
			// path. The role API requires an explicit scope for reads and mutations.
			const roleScope = `projectId=${encodeURIComponent(project.id)}`;
			const roleCustomize = await api(`/api/roles/general/customize?scope=project&${roleScope}`, { method: "POST" });
			expect(roleCustomize.status).toBe(201);
			const roleResponse = await api(`/api/roles/general?${roleScope}`);
			expect(roleResponse.status).toBe(200);
			const role = await roleResponse.json() as { promptTemplate?: string; toolPolicies?: Record<string, string> };
			expect(typeof role.promptTemplate).toBe("string");
			if (typeof role.promptTemplate !== "string") throw new Error("Manual SDK role is missing its prompt template.");
			const configuredRolePrompt = `${role.promptTemplate}\n\n${manualNativeAgentDirective}`;
			const roleUpdate = await api(`/api/roles/general?${roleScope}`, {
				method: "PUT",
				body: JSON.stringify({
					promptTemplate: configuredRolePrompt,
					toolPolicies: { ...(role.toolPolicies ?? {}), Gates: "allow", grep: "ask", team_delegate: "never" },
				}),
			});
			expect(roleUpdate.status).toBe(200);
			const configuredRoleResponse = await api(`/api/roles/general?${roleScope}`);
			expect(configuredRoleResponse.status).toBe(200);
			const configuredRole = await configuredRoleResponse.json() as { promptTemplate?: string; toolPolicies?: Record<string, string> };
			expect({
				promptPreservedAndAppended: configuredRole.promptTemplate === configuredRolePrompt,
				promptIncludesNativeAgentDirective: configuredRole.promptTemplate?.includes(manualNativeAgentDirective) === true,
				promptEndsWithNativeAgentDirective: configuredRole.promptTemplate?.endsWith(manualNativeAgentDirective) === true,
				existingPoliciesPreserved: Object.entries(role.toolPolicies ?? {}).every(([tool, policy]) => ["Gates", "grep", "team_delegate"].includes(tool) || configuredRole.toolPolicies?.[tool] === policy),
				gates: configuredRole.toolPolicies?.Gates,
				grep: configuredRole.toolPolicies?.grep,
				teamDelegate: configuredRole.toolPolicies?.team_delegate,
			}).toEqual({
				promptPreservedAndAppended: true,
				promptIncludesNativeAgentDirective: true,
				promptEndsWithNativeAgentDirective: true,
				existingPoliciesPreserved: true,
				gates: "allow",
				grep: "ask",
				teamDelegate: "never",
			});

			// Keep the normal role override above separate from the constrained helper
			// role. Its production gate-review prompt invokes tools not exposed to the
			// native child, so replace it only in this temporary project.
			await configureManualHelperRole(api, project.id);
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
			const { claudeAgentSdkUnavailableRouteDiagnostic } = await import("../../dist/server/agent/claude-agent-sdk-error.js");
			const providerResponse = await api("/api/custom-providers", {
				method: "POST",
				body: JSON.stringify({
					id: "claude-agent-sdk",
					name: "claude-agent-sdk",
					type: "manual",
					baseUrl: "http://127.0.0.1:9",
					models: [
						{ id: configuredModel, name: "Manual Claude Agent SDK sandbox smoke" },
						{ id: alternateModel, name: "Manual Claude Agent SDK sandbox live-control target" },
					],
				}),
			});
			expect(providerResponse.status).toBe(200);
			const preferencesResponse = await api("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ "default.sessionModel": sessionModel, "default.sessionThinkingLevel": "off" }),
			});
			expect(preferencesResponse.status).toBe(200);
			const createdResponse = await api("/api/sessions", { method: "POST", body: JSON.stringify({ projectId: project.id, goalId: goal.id, cwd: projectRoot, sandboxed: true, worktree: false }) });
			expect(createdResponse.status).toBe(201);
			const created = await createdResponse.json() as { id: string };
			let session = await waitFor(() => gateway!.sessionManager.getSession(created.id), "sandbox SDK bridge installation");
			expect(session.runtime).toBe("claude-agent-sdk");
			expect(session.sandboxed).toBe(true);
			expect(session.cwd).toBe("/workspace");
			await waitForManualDockerInitialReadiness(session.rpcClient, claudeAgentSdkUnavailableRouteDiagnostic);
			// The SDK establishes its persistent identity from the first accepted real
			// user turn; readiness alone must not synthesize a bootstrap session.
			expect(gateway.sessionManager.getPersistedSession(created.id)?.claudeAgentSdkSessionId).toBeUndefined();
			const runSandboxTurn = async (text: string, label: string, options: Record<string, unknown> = {}) => {
				const eventTypeCounts = createManualTurnEventCounts();
				const bridge = session.rpcClient as unknown as Record<string, unknown>;
				// Subscribe before enqueue to correlate this accepted prompt rather than
				// treating the prior idle status as proof of completion.
				const lifecycle = observeManualRootTurnLifecycle(session.rpcClient);
				const unsubscribeCounts = session.rpcClient.onEvent(event => countManualTurnEvent(eventTypeCounts, event));
				try {
					await gateway!.sessionManager.enqueuePrompt(created.id, text, { source: "user", ...options });
					await waitFor(() => lifecycle.completed() ? true : undefined, `${label} root terminal`, 120_000);
				} catch {
					// Terminal failures can happen before a root lifecycle terminal arrives.
					// Retain only fixed facts and the route-safe bridge category.
					throw new Error(JSON.stringify(manualTerminalTurnFacts({
						eventTypeCounts,
						lifecycle,
						bridge,
						bridgeRunning: diagnosticBoolean(() => session.rpcClient.running),
						pendingToolPermission: diagnosticBoolean(() => gateway!.sessionManager.getPendingToolPermission(created.id) !== undefined),
						routeDiagnostic: claudeAgentSdkUnavailableRouteDiagnostic,
					})));
				} finally {
					unsubscribeCounts();
					lifecycle.unsubscribe();
				}
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
			const persistedSdkSessionId = gateway.sessionManager.getPersistedSession(created.id)?.claudeAgentSdkSessionId;
			expect(typeof persistedSdkSessionId).toBe("string");
			if (typeof persistedSdkSessionId !== "string") throw new Error("SDK session identity was not persisted after the first accepted sandbox turn.");

			await runSandboxTurn("Reply with exactly: SDK_SANDBOX_READY", "first sandbox SDK prompt");

			// An allowed read is one complete turn before the permission-gated grep.
			await runSandboxTurn("Use only Bobbit read on README.md. Do not use any other tools.", "sandbox canonical Bobbit read turn");
			let sandboxTranscript = await gateway.sessionManager.getMessagesSnapshotBase(session);
			const visibleSandboxCanonicalReadTranscript = sandboxTranscript.success
				? gateway.sessionManager.buildVisibleMessageSnapshot(created.id, sandboxTranscript.data)
				: undefined;
			assertManualDurableCanonicalToolExecution(visibleSandboxCanonicalReadTranscript, "read");

			// Count only fixed tool categories for the separate permission-card turn.
			const sandboxCanonicalGrepExecution = createManualCanonicalToolExecutionCounts();
			const sandboxCanonicalGrepLifecycle = observeManualRootTurnLifecycle(session.rpcClient);
			const unsubscribeSandboxCanonicalGrepExecution = session.rpcClient.onEvent(event => countManualCanonicalToolExecution(sandboxCanonicalGrepExecution, event));
			try {
				await gateway.sessionManager.enqueuePrompt(created.id, "Use exactly one Bobbit grep with pattern Bobbit, path README.md, and literal true. Do not use any other tools.", { source: "user" });
				const permission = await waitFor(() => {
					const pending = gateway!.sessionManager.getPendingToolPermission(created.id);
					return pending?.toolName === "grep" && pending.group === "File System" ? pending : undefined;
				}, "sandbox canonical grep permission card", 90_000);
				expect(permission.toolName === "grep" && permission.group === "File System").toBe(true);
				await gateway.sessionManager.grantToolPermission(created.id, "grep", "tool", "File System", "one-time", permission.id);
				await waitFor(() => sandboxCanonicalGrepLifecycle.completed() ? true : undefined, "sandbox canonical Bobbit grep root terminal", 120_000);
			} finally {
				unsubscribeSandboxCanonicalGrepExecution();
				sandboxCanonicalGrepLifecycle.unsubscribe();
			}
			// Fetch durable visible history before evaluating fixed boundary diagnostics.
			sandboxTranscript = await gateway.sessionManager.getMessagesSnapshotBase(session);
			const visibleSandboxCanonicalGrepTranscript = sandboxTranscript.success
				? gateway.sessionManager.buildVisibleMessageSnapshot(created.id, sandboxTranscript.data)
				: undefined;
			assertManualDurableCanonicalToolExecution(visibleSandboxCanonicalGrepTranscript, "grep", sandboxCanonicalGrepExecution);
			await runSandboxTurn("Use only Bobbit gate_list to inspect current workflow state. Do not signal or modify any gate.", "sandbox read-only workflow-gate tool action");
			sandboxTranscript = await gateway.sessionManager.getMessagesSnapshotBase(session);
			const visibleSandboxTranscript = sandboxTranscript.success
				? gateway.sessionManager.buildVisibleMessageSnapshot(created.id, sandboxTranscript.data)
				: undefined;
			expect(sandboxTranscript.success && hasRootCanonicalToolCall(visibleSandboxTranscript, "gate_list")).toBe(true);
			expect(sandboxTranscript.success && hasSuccessfulRootToolResult(visibleSandboxTranscript, "gate_list")).toBe(true);
			await runSandboxTurn("Call the native Agent tool exactly once with run_in_background: false and subagent_type: \"bobbit-backend-parity-reviewer\". Its task must be: use the Bobbit read tool on README.md. Do not call any other root tool. Do not create or invoke an additional helper.", "sandbox constrained foreground helper");
			sandboxTranscript = await gateway.sessionManager.getMessagesSnapshotBase(session);
			if (!sandboxTranscript.success) throw new Error(JSON.stringify(manualNestedHelperFacts(undefined)));
			assertManualNestedHelper(gateway.sessionManager.buildVisibleMessageSnapshot(created.id, sandboxTranscript.data));
			// A native helper is rendered beneath its root Agent card, not as a Bobbit session.
			expect(gateway.sessionManager.listSessions()).toHaveLength(1);
			const { applyRuntimeSessionModelSelection } = await import("../../dist/server/ws/runtime-model-selection.js");
			const beforeSandboxModelChange = await session.rpcClient.getState();
			const sandboxThinking = beforeSandboxModelChange?.data?.thinkingLevel;
			expect({
				provider: beforeSandboxModelChange?.data?.model?.provider,
				id: beforeSandboxModelChange?.data?.model?.id,
				thinkingLevel: sandboxThinking,
			}).toEqual({ provider: "claude-agent-sdk", id: configuredModel, thinkingLevel: "off" });
			const selectedSandboxModel = await applyRuntimeSessionModelSelection(
				gateway.sessionManager,
				session,
				"claude-agent-sdk",
				alternateModel,
				sandboxThinking,
				gateway.sessionManager.preferencesStore,
			);
			expect(selectedSandboxModel).toEqual({ provider: "claude-agent-sdk", id: alternateModel, thinkingLevel: sandboxThinking });
			const afterSandboxModelChange = await session.rpcClient.getState();
			expect({
				provider: afterSandboxModelChange?.data?.model?.provider,
				id: afterSandboxModelChange?.data?.model?.id,
				thinkingLevel: afterSandboxModelChange?.data?.thinkingLevel,
			}).toEqual(selectedSandboxModel);
			const { applyRuntimeSessionThinkingSelection } = await import("../../dist/server/ws/runtime-model-selection.js");
			const sandboxState = await session.rpcClient.getState();
			const sandboxModel = sandboxState?.data?.model as { thinkingLevelMap?: Record<string, string | null>; reasoning?: boolean } | undefined;
			const supportedSandboxThinking = sandboxModel?.reasoning === true ? Object.entries(sandboxModel.thinkingLevelMap ?? {}).find(([level, value]) => level !== "off" && typeof value === "string")?.[0] : undefined;
			if (supportedSandboxThinking) {
				const effective = await applyRuntimeSessionThinkingSelection(gateway.sessionManager, session, supportedSandboxThinking);
				expect(effective.thinkingLevel === supportedSandboxThinking).toBe(true);
			} else {
				await expect(applyRuntimeSessionThinkingSelection(gateway.sessionManager, session, "low")).rejects.toThrow(/unavailable/i);
			}
			const expectedSandboxResumeTuple = await session.rpcClient.getState();
			expect(expectedSandboxResumeTuple?.data?.model?.id).toBe(alternateModel);
			const beforeReplacement = await gateway.sessionManager.getMessagesSnapshotBase(session);
			expect(beforeReplacement.success && hasDurableSubscriptionUsage(gateway.sessionManager.getSessionCost(created.id))).toBe(true);
			// Automatic compaction remains SDK-managed and is only observed if it occurs.
			const interruptedSandboxTurnLifecycle = observeManualRootTurnLifecycle(session.rpcClient);
			try {
				await gateway.sessionManager.enqueuePrompt(created.id, "Count slowly until told to stop.", { source: "user" });
				await waitFor(() => interruptedSandboxTurnLifecycle.started() ? true : undefined, "sandbox SDK streaming turn");
				await gateway.sessionManager.deliverLiveSteer(created.id, "Stop now and acknowledge this steer.");
				await gateway.sessionManager.abortSessionTurn(created.id);
				await waitFor(() => interruptedSandboxTurnLifecycle.completed() ? true : undefined, "sandbox SDK interrupt root terminal");
			} finally {
				interruptedSandboxTurnLifecycle.unsubscribe();
			}
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
			const resumedSandboxModel = await session.rpcClient.getState();
			expect({
				provider: resumedSandboxModel?.data?.model?.provider,
				id: resumedSandboxModel?.data?.model?.id,
				thinkingLevel: resumedSandboxModel?.data?.thinkingLevel,
			}).toEqual({
				provider: expectedSandboxResumeTuple?.data?.model?.provider,
				id: expectedSandboxResumeTuple?.data?.model?.id,
				thinkingLevel: expectedSandboxResumeTuple?.data?.thinkingLevel,
			});
			const sandboxReload = await api(manualTranscriptReloadPath(created.id, project.id));
			expect(sandboxReload.status).toBe(200);
			const afterRestart = await gateway.sessionManager.getMessagesSnapshotBase(session);
			expect(beforeReplacement.success && afterRestart.success).toBe(true);
			assertManualTranscriptPrefixProjection(beforeReplacement.data, afterRestart.data);
			expect(hasDurableSubscriptionUsage(gateway.sessionManager.getSessionCost(created.id))).toBe(true);
			const terminated = await gateway.sessionManager.terminateSession(created.id);
			expect(terminated).toBe(true);
			expect(gateway.sessionManager.getSession(created.id)).toBeUndefined();
			expect(gateway.sessionManager.getPersistedSession(created.id)?.archived).toBe(true);
		} finally {
			if (gateway) await gateway.shutdown().catch(() => {});
			restoreSmokeEnvironment(originalEnvironment);
			const { resetAgentDirStateForTests } = await import("../../dist/server/bobbit-dir.js");
			resetAgentDirStateForTests();
			if (existsSync(root)) rmSync(root, { recursive: true, force: true });
		}
	});
});
