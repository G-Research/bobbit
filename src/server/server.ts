import { exec } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import { getRegisteredRpcBridgeFactory, registerRpcBridgeFactory } from "./agent/rpc-bridge.js";
import { resolveGatewayDeps, realCommandRunner, type Clock, type CommandRunner, type FsLike, type GatewayDeps } from "./gateway-deps.js";
import { resolveLegacyTestRuntimeFlags } from "./legacy-test-runtime-flags.js";
export type { Clock, CommandRunner, ExecFileResult, FsLike, GatewayDeps, ResolvedGatewayDeps, TimerHandle } from "./gateway-deps.js";
export { defaultRpcBridgeFactory, realClock, realCommandRunner, realFetch, realFs, resolveGatewayDeps } from "./gateway-deps.js";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

import os from "node:os";
import { parse as parseYaml } from "yaml";
import { fileURLToPath } from "node:url";
import {
	bobbitStateDir,
	serverSecretsDir,
	bobbitConfigDir,
	bobbitDir,
	headquartersDir,
	getProjectRoot,
	globalAgentDir,
	getAgentDirApiState,
	validateAgentDirTarget,
	refreshAgentDirNextStart,
	migrateAgentDirData,
	isKnownAgentDir,
	isPendingAgentDir,
	buildAgentDirRestartGuidance,
	normalizeAgentDirInput,
} from "./bobbit-dir.js";
import { recordBootTiming, readBootTimings, BOOT_TIMING_FILE } from "./dev-boot-timing.js";
import { bootLog, bootMark, makePhaseTimer, SLOW_PHASE_MS } from "./boot-profile.js";
import { touchGatewayRestartSentinel } from "./harness-signal.js";
import { isSetupComplete } from "./setup-status.js";
export { isSetupComplete };
import { WebSocketServer, type WebSocket } from "ws";
import { ColorStore } from "./agent/color-store.js";
import { bfsEnrichArchivedIndexed } from "./agent/archived-session-bfs.js";
import { PrStatusStore, type PrStatusEntry } from "./agent/pr-status-store.js";
import { SessionManager, type ExtensionChannelServices } from "./agent/session-manager.js";
import { WorktreeInventoryService } from "./agent/worktree-inventory.js";
import { executeCleanupWorktreesRequest } from "./maintenance/cleanup-worktrees-request.js";
import { RateLimiter } from "./auth/rate-limit.js";
import { readToken, validateToken } from "./auth/token.js";
import { oauthComplete, oauthFlowStatus, oauthLogout, oauthStart, oauthStatus } from "./auth/oauth.js";
import { handleWebSocketConnection } from "./ws/handler.js";
import type { GateResetReopenOutcome, ServerMessage } from "./ws/protocol.js";
import { paceAndSend, PACE_TIMEOUT_MS } from "./replay-pacing.js";
import { DEFAULT_OVERFLOW_GUARD, describeWsPayload, guardWebSocketOverflow } from "./ws-overflow-guard.js";
import { discoverSlashSkills, discoverSlashSkillsResolved, getSkillDirectories, getSlashSkill, buildSlashSkillPrompt, invalidateSlashSkillsCache, type SkillMarketContext } from "./skills/slash-skills.js";
import { enumerateFiles } from "./skills/file-enumeration.js";
import { TeamManager, GateDependencyError } from "./agent/team-manager.js";
import { OrchestrationCore, OrchestrationCoreError, dismissHttpStatus, isSettledStatus, type WaitResult } from "./agent/orchestration-core.js";
import { tryHandleNestedGoalRoute, listDescendants } from "./agent/nested-goal-routes.js";
import { walkGoalSubtree, cascadeSubtree as cascadeGoalSubtree } from "./agent/goal-subtree.js";
import type { Workflow } from "./agent/workflow-store.js";
import { freezeWorkflowDefinition } from "./agent/workflow-validator.js";
import { buildDefaultWorkflows, buildParentWorkflow } from "./state-migration/seed-default-workflows.js";
import { readSubgoalNestingPrefs, checkCanSpawnChild, inheritedChildOverrides, clampMaxDepth } from "./agent/subgoal-nesting-limit.js";
import { GoalPausedError, requireAncestorsNotPaused } from "./agent/goal-paused-guard.js";
import { collectDescendants, enrichDescendantsForPlan } from "./agent/goal-descendants.js";
import { computeTreeCost } from "./agent/cost-tracker.js";
import { backfillLegacyCostGoalIds, backfillLegacyCostGoalIdsFromTranscripts } from "./agent/cost-backfill.js";
import { checkGateDependencies } from "./agent/gate-dependency-check.js";
import { deliverSessionPrompt, parseSessionPromptMode, SessionPromptDeliveryError } from "./agent/session-prompt-delivery.js";
import { shouldCreateWorktree } from "./agent/worktree-decision.js";
import { resolveWorktreeSupport } from "./agent/worktree-support.js";
import { RoleStore, type Role } from "./agent/role-store.js";
import { RoleManager } from "./agent/role-manager.js";
import { ToolManager, copyToolGroupWithSharedDependencies, __resetToolScanCache, type MarketToolRoot, type PiExtensionExternalTool, type ScopedToolContext } from "./agent/tool-manager.js";
import { ActionDispatcher, ActionError, resolveActionToolManager } from "./extension-host/action-dispatcher.js";
import { RouteDispatcher, RouteRegistry } from "./extension-host/route-dispatcher.js";
import { ModuleHost } from "./extension-host/module-host-worker.js";
import { authorizeActionRequest, authorizeScopedRequest, transcriptHasToolUse, type ActionGuardSession } from "./extension-host/action-guard.js";
import { getPackStore, withStoreTimeout, PackStoreTimeoutError, PackStoreQuotaError } from "./extension-host/pack-store.js";
import { createServerHostApi } from "./extension-host/server-host-api.js";
import { transcriptToHostMessages, transcriptToToolCall, buildTranscriptEnvelope } from "./extension-host/contract-adapter.js";
import { resolvePackIdentityForTool } from "./extension-host/pack-identity.js";
import { mintSurfaceToken, resolveSurfaceIdentity } from "./extension-host/surface-binding.js";
import type { StorePutOptions } from "../shared/extension-host/host-api.js";
import { PackContributionRegistry } from "./extension-host/pack-contribution-registry.js";
import { loadPackContributions, providerConfigStoreKey, PROVIDER_CONFIG_KEY_PREFIX } from "./agent/pack-contributions.js";
import { loadPiExtensionContributions, loadPiExtensionContributionsWithDiscoverySync } from "./agent/pi-extension-contributions.js";
import { LifecycleHub, type HookCtx } from "./agent/lifecycle-hub.js";
import { ContextTraceStore } from "./agent/context-trace-store.js";
import { fenceBlock } from "./agent/context-blocks.js";
import { DYNAMIC_CONTEXT_START, DYNAMIC_CONTEXT_END } from "./agent/provider-bridge-extension.js";
import { isPackPathWithinRoot } from "./extension-host/path-guard.js";
import { buildGateStatusSummary, projectGateForList } from "./gate-status-summary.js";
import { broadcastGateStatusChanged, wireGateStatusGenerationInvalidation } from "./gate-status-broadcast.js";
import { buildRunningGateSignalResponse, reuseCachedGateSignal } from "./gate-signal-response.js";
import { buildGateVerificationSnapshot, UnknownVerificationStepError } from "./gate-verification-snapshot.js";
import {
	GateArtifactResolutionError,
	buildArtifactLookup,
	isTextInspectableArtifact,
	resolveArtifactFromLookup,
	stripPlaywrightErrorContextBoilerplate,
	validateRetainedArtifactPath,
} from "./gate-artifacts.js";
import { handleSidePanelWorkspaceRoute, openSidePanelWorkspaceTab } from "./side-panel-workspace-routes.js";
import {
	TextSelectionError,
	selectText,
	type TextSelectionMode,
	type TextSelectionOptions,
} from "./utils/text-selection.js";

import { getPromptSections, initPromptDirs, loadPersistedPromptSections, persistPromptSections } from "./agent/system-prompt.js";
import { configureProfilingRuntime, recordElapsed } from "./agent/profiling.js";
import { cpuDiagnosticsEnabled, getCpuDiagnostics } from "./agent/cpu-diagnostics.js";
import { resolveGrantPolicy, computeEffectiveAllowedTools } from "./agent/tool-activation.js";
import { parseMcpToolName } from "./mcp/mcp-meta.js";
import { initSkillSidecarDir } from "./skills/skill-sidecar.js";
import {
	initCompactionSidecarDir,
	findCompactionSidecarEntry,
} from "./agent/compaction-sidecar.js";
import { readOrphanedBeforeCompaction } from "./agent/transcript-reader.js";
import { buildActivationHeader } from "./skills/skill-manifest.js";
import type { PersistedTask, TaskState } from "./agent/task-store.js";
import { TaskManager } from "./agent/task-manager.js";
import { TaskStore } from "./agent/task-store.js";
import { BgProcessManager } from "./agent/bg-process-manager.js";
import { streamBgWaitResponse } from "./agent/bg-wait-response.js";
import { sessionFileRead, sessionFsContextForAgentFile } from "./agent/session-fs.js";
import { readTranscript, TranscriptReaderError } from "./agent/transcript-reader.js";

import { isGitRepo, getRepoRoot, resolveSandboxMountRoot, shouldSkipRemotePush, stripTokenFromGitUrl, detectPrimaryBranch, parseBaseRef, detectBaseRefFromRemote, resolveBaseRef, refExistsInRepo, type RemoteGitPolicy } from "./skills/git.js";
import {
	baseRefMissingInReposError,
	baseRefSkippedRepoWarning,
	baseRefTagError,
	isValidBaseRefBranchGrammar,
	normalizeBaseRefValue,
	validateBaseRefShape,
} from "./base-ref-validation.js";

/**
 * Render the `team_wait` result text (orchestration-core design §9). Returns on
 * the first SETTLED child (idle or terminal); enumerates every awaited child's
 * status and instructs the agent to call `team_wait` again for the remainder.
 */
function formatWaitText(result: WaitResult): string {
	const lines: string[] = [];
	const first = result.firstIdle;
	if (first) {
		const fh = result.statuses.find(s => s.sessionId === first);
		const header = result.firstIsTerminal ? "First settled child" : "First idle child";
		lines.push(`${header}: ${first}${fh?.title ? ` ("${fh.title}")` : ""}`);
		if (result.outputTail) {
			lines.push("--- output tail ---");
			lines.push(result.outputTail);
		}
		lines.push("");
	}
	lines.push(`Awaited children (${result.statuses.length}):`);
	for (const s of result.statuses) {
		lines.push(`  • ${s.sessionId}${s.title ? ` "${s.title}"` : ""} — ${s.status}`);
	}
	if (result.remaining === 0) {
		lines.push("All awaited children are settled.");
	} else {
		// Enumerate the REMAINING (non-settled) child ids so a literal re-call of
		// team_wait awaits ONLY them — otherwise an omitted child_session_ids
		// defaults to ALL tracked children and re-returns the same already-idle
		// child. The agent should pass exactly these ids on the next call.
		const remainingIds = result.statuses.filter(s => !isSettledStatus(s.status)).map(s => s.sessionId);
		lines.push(`Remaining: ${result.remaining} child(ren) not yet settled.`);
		lines.push(`➜ Process this result now, then call team_wait again to await the remaining children — pass child_session_ids: [${remainingIds.join(", ")}].`);
	}
	return lines.join("\n");
}

function isMissingOptionalExtensionChannelModule(err: unknown): boolean {
	const code = (err as { code?: unknown } | null)?.code;
	const message = err instanceof Error ? err.message : String(err);
	return code === "ERR_MODULE_NOT_FOUND" && (message.includes("channel-registry") || message.includes("channel-open-permits"));
}

function extensionChannelAuditSink(event: Record<string, unknown>): void {
	const type = typeof event.type === "string" ? event.type : "unknown";
	if ((type === "channel.frame.in" || type === "channel.frame.out") && process.env.BOBBIT_DEBUG !== "1") return;
	const session = typeof event.sessionId === "string" ? event.sessionId : "-";
	const packId = typeof event.packId === "string" ? event.packId : "-";
	const channelName = typeof event.channelName === "string" ? event.channelName : "-";
	const channelId = typeof event.channelId === "string" ? event.channelId : "-";
	const reason = typeof event.reason === "string" ? event.reason : undefined;
	const error = typeof event.error === "string" ? event.error : undefined;
	const quota = typeof event.quota === "string" ? event.quota : undefined;
	const frameKind = typeof event.frameKind === "string" ? event.frameKind : undefined;
	const frameBytes = typeof event.frameBytes === "number" ? event.frameBytes : undefined;
	const extras = [reason && `reason=${reason}`, error && `error=${error}`, quota && `quota=${quota}`, frameKind && `frameKind=${frameKind}`, frameBytes !== undefined && `frameBytes=${frameBytes}`].filter(Boolean).join(" ");
	console.log(`[ext-channel-audit] type=${type} session=${session} packId=${packId} channel=${channelName} channelId=${channelId}${extras ? ` ${extras}` : ""}`);
}

async function instantiateExtensionChannelServices(deps: {
	packContributionRegistry: PackContributionRegistry;
	sessionManager: SessionManager;
	projectContextManager: ProjectContextManager;
	toolManager: ToolManager;
}): Promise<ExtensionChannelServices | undefined> {
	try {
		const [registryModule, grantsModule, channelModuleHostModule, channelPtyModule] = await Promise.all([
			import("./extension-host/" + "channel-registry.js"),
			import("./extension-host/" + "channel-open-permits.js"),
			import("./extension-host/" + "channel-module-host.js"),
			import("./extension-host/" + "channel-pty-helper.js"),
		]);
		const OpenPermitsCtor = (grantsModule as any).ChannelOpenPermitService
			?? (grantsModule as any).ChannelOpenPermits
			?? (grantsModule as any).ChannelOpenPermitStore
			?? (grantsModule as any).OpenGrantStore;
		const RegistryCtor = (registryModule as any).ChannelRegistry;
		if (typeof OpenPermitsCtor !== "function" || typeof RegistryCtor !== "function") {
			throw new Error("Extension channel modules must export ChannelRegistry and a channel open-permit service");
		}
		const ChannelModuleHostCtor = (channelModuleHostModule as any).WorkerChannelModuleHost
			?? (channelModuleHostModule as any).ChannelModuleHost
			?? (channelModuleHostModule as any).LocalChannelModuleHost;
		const openPermits = new OpenPermitsCtor({ audit: extensionChannelAuditSink });
		const ChannelPtyServiceCtor = (channelPtyModule as any).ChannelPtyService;
		const channelPtyService = typeof ChannelPtyServiceCtor === "function"
			? new ChannelPtyServiceCtor({ sessionManager: deps.sessionManager, audit: extensionChannelAuditSink })
			: undefined;
		const channelModuleHost = typeof ChannelModuleHostCtor === "function" ? new ChannelModuleHostCtor({
			buildHost: channelPtyService
				? (contribution: any, ctx: any) => channelPtyService.buildHost(contribution, ctx.sessionId)
				: undefined,
		}) : undefined;
		const registry = new RegistryCtor({
			openPermits,
			openPermitService: openPermits,
			grants: openPermits,
			packContributionRegistry: deps.packContributionRegistry,
			contributionRegistry: deps.packContributionRegistry,
			contributions: deps.packContributionRegistry,
			moduleHost: channelModuleHost,
			audit: extensionChannelAuditSink,
			auditLog: { write: extensionChannelAuditSink },
			sessionManager: deps.sessionManager,
			projectContextManager: deps.projectContextManager,
			toolManager: deps.toolManager,
			getPackStore,
		});
		return { registry, openPermits };
	} catch (err) {
		if (isMissingOptionalExtensionChannelModule(err)) return undefined;
		throw err;
	}
}

function resolveChannelContributionForGrant(
	registry: PackContributionRegistry,
	projectId: string | undefined,
	packId: string,
	name: string,
): unknown {
	const direct = (registry as any).getChannel;
	if (typeof direct === "function") return direct.call(registry, projectId, packId, name);
	const pack = registry.getPack(projectId, packId) as unknown as { channels?: unknown } | undefined;
	const channels = Array.isArray(pack?.channels) ? pack.channels : [];
	return channels.find((channel: any) => channel && channel.name === name);
}

async function mintExtensionChannelOpenGrant(openPermits: unknown, binding: {
	sessionId: string;
	packId: string;
	contributionId: string;
	channelName: string;
	singletonKey?: string;
}): Promise<string> {
	const issuer = openPermits as any;
	const mint = issuer?.mint ?? issuer?.mintGrant ?? issuer?.createGrant ?? issuer?.issue;
	if (typeof mint !== "function") throw new Error("channel open-permit service is unavailable");
	const result = await mint.call(issuer, binding);
	if (typeof result === "string") return result;
	if (result && typeof result.grant === "string") return result.grant;
	if (result && typeof result.openGrant === "string") return result.openGrant;
	if (result && typeof result.token === "string") return result.token;
	throw new Error("channel open-permit service returned no grant");
}

function authorizePackBoundScopedChannelOpenRequest(
	headerSid: string | undefined,
	bodySid: unknown,
	resolveSession: (id: string) => ActionGuardSession | undefined,
): { ok: true; sessionId: string } | { ok: false; status: number; error: string } {
	if (!headerSid) return { ok: false, status: 403, error: "missing session" };
	if (bodySid !== undefined && bodySid !== null && bodySid !== headerSid) {
		return { ok: false, status: 403, error: "session mismatch" };
	}
	if (!resolveSession(headerSid)) return { ok: false, status: 403, error: "unknown session" };
	return { ok: true, sessionId: headerSid };
}

export type ScopedExtensionChannelOpenPermitResult =
	| { ok: true; openGrant: string; sessionId: string; packId: string; contributionId: string; channelName: string; singletonKey?: string }
	| { ok: false; status: number; error: string };

export async function mintScopedExtensionChannelOpenPermit(input: {
	openPermits: unknown;
	packContributionRegistry: PackContributionRegistry;
	projectId?: string;
	resolver: any;
	headerSessionId: string | undefined;
	rawHeaderSessionId?: string | string[] | undefined;
	bodySessionId?: unknown;
	surfaceToken: unknown;
	name: unknown;
	init?: unknown;
	singletonKey?: unknown;
	resolveSession: (id: string) => ActionGuardSession | undefined;
}): Promise<ScopedExtensionChannelOpenPermitResult> {
	const surf = resolveSurfaceIdentity({
		token: input.surfaceToken,
		headerSessionId: input.headerSessionId,
		resolver: input.resolver,
		contributions: input.packContributionRegistry,
		projectId: input.projectId,
	});
	if (!surf.ok) return { ok: false, status: surf.status, error: surf.error };
	if (surf.tool !== undefined) {
		return { ok: false, status: 403, error: "channel open permits require a pack-bound surface token" };
	}
	const guard = authorizePackBoundScopedChannelOpenRequest(input.headerSessionId, input.bodySessionId, input.resolveSession);
	if (!guard.ok) return { ok: false, status: guard.status, error: guard.error };
	const name = typeof input.name === "string" ? input.name.trim() : "";
	if (!name) return { ok: false, status: 400, error: "missing channel name" };
	const init = input.init;
	const singletonKey = init && typeof init === "object" && typeof (init as { singletonKey?: unknown }).singletonKey === "string"
		? (init as { singletonKey: string }).singletonKey
		: typeof input.singletonKey === "string" ? input.singletonKey : undefined;
	if (!resolveChannelContributionForGrant(input.packContributionRegistry, input.projectId, surf.packId, name)) {
		return { ok: false, status: 404, error: "channel is not declared by this pack" };
	}
	try {
		const openGrant = await mintExtensionChannelOpenGrant(input.openPermits, {
			sessionId: guard.sessionId,
			packId: surf.packId,
			contributionId: surf.contributionId,
			channelName: name,
			...(singletonKey !== undefined ? { singletonKey } : {}),
		});
		return { ok: true, openGrant, sessionId: guard.sessionId, packId: surf.packId, contributionId: surf.contributionId, channelName: name, ...(singletonKey !== undefined ? { singletonKey } : {}) };
	} catch (err) {
		return { ok: false, status: 400, error: err instanceof Error ? err.message : String(err) };
	}
}

async function disposeExtensionChannelServices(services: ExtensionChannelServices | undefined, reason: string): Promise<void> {
	const dispose = services?.registry?.dispose;
	if (!dispose) return;
	try {
		await dispose.call(services.registry, reason);
	} catch (err) {
		console.warn(`[extension-channels] dispose failed:`, err);
	}
}

function collectVisibleSessionWorktreeReferences(projectContextManager: ProjectContextManager): WorktreeReferenceRecord[] {
	const sessions: WorktreeReferenceRecord[] = [];
	for (const ctx of projectContextManager.visible()) {
		sessions.push(...ctx.sessionStore.getAll());
	}
	return sessions;
}

function wireGoalManagerResolvers(
	ctx: ProjectContext,
	deps: {
		sessionManager: SessionManager;
		projectContextManager: ProjectContextManager;
		projectRegistry: ProjectRegistry;
	},
): void {
	const projectId = ctx.project.id;
	ctx.goalManager.setPoolResolver(() => deps.sessionManager.getWorktreePool(projectId));
	ctx.goalManager.setComponentsResolver((pid: string) => {
		const c = deps.projectContextManager.getOrCreate(pid);
		return c ? c.projectConfigStore.getComponents() : [];
	});
	ctx.goalManager.setProjectRootResolver((pid: string) => deps.projectRegistry.get(pid)?.rootPath);
	ctx.goalManager.setWorktreeRootResolver((pid: string) => {
		const c = deps.projectContextManager.getOrCreate(pid);
		return c?.projectConfigStore.get("worktree_root") || undefined;
	});
	ctx.goalManager.setBaseRefResolver((pid: string) => {
		const c = deps.projectContextManager.getOrCreate(pid);
		return c?.projectConfigStore.get("base_ref") || undefined;
	});
	ctx.goalManager.setWorktreeSetupTimeoutResolver((pid: string) => {
		const c = deps.projectContextManager.getOrCreate(pid);
		return c?.projectConfigStore.get("worktree_setup_timeout_ms") || undefined;
	});
	ctx.goalManager.setLiveSessionResolver(() => collectVisibleSessionWorktreeReferences(deps.projectContextManager));
}

// Best-effort guard for add-time `base_ref` pinning: a detected `origin/<branch>`
// must exist in EVERY configured component repo before it is persisted — mirroring
// the save-time validator (which rejects a ref missing in any component). Without
// this, a multi-repo project whose primary repo's remote HEAD differs from another
// component's available refs would persist a value that breaks worktree creation
// for that component. Returns true only if at least one repo was checked AND every
// checked git repo has the ref. Never throws. See docs/design/base-ref.md.
async function detectedRefExistsInAllComponents(
	rootPath: string,
	comps: Array<{ repo: string }>,
	ref: string,
	commandRunner: CommandRunner = realCommandRunner,
): Promise<boolean> {
	try {
		const seen = new Set<string>();
		let checked = 0;
		for (const c of comps.length > 0 ? comps : [{ repo: "." }]) {
			if (seen.has(c.repo)) continue;
			seen.add(c.repo);
			const repoPath = path.join(rootPath, c.repo);
			if (!(await isGitRepo(repoPath, commandRunner).catch(() => false))) continue;
			checked++;
			if (!(await refExistsInRepo(repoPath, ref, commandRunner))) return false;
		}
		return checked > 0;
	} catch {
		return false;
	}
}

async function resolveBaseRefDetectRepoPath(rootPath: string, comps: Array<{ repo: string }>, commandRunner: CommandRunner = realCommandRunner): Promise<string | null> {
	const isMultiRepo = comps.some(c => c.repo !== ".");
	const primaryRepoPath = isMultiRepo
		? path.join(rootPath, comps.find(c => c.repo !== ".")?.repo ?? ".")
		: rootPath;
	if (!(await isGitRepo(primaryRepoPath, commandRunner).catch(() => false))) return null;
	return isMultiRepo ? primaryRepoPath : await getRepoRoot(primaryRepoPath, commandRunner);
}

function normalizeApiRouteLabel(method: string | undefined, pathname: string): string {
	const normalizedPath = pathname
		.replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, "/:id")
		.replace(/\/\d+(?=\/|$)/g, "/:id")
		.replace(/\/[A-Za-z0-9_-]{20,}(?=\/|$)/g, "/:id");
	return `${method || "GET"} ${normalizedPath}`;
}

function wsEventType(event: unknown): string {
	return event && typeof event === "object" && typeof (event as { type?: unknown }).type === "string"
		? (event as { type: string }).type
		: "unknown";
}

function responseChunkByteLength(chunk: unknown, encoding?: unknown): number {
	if (chunk == null || typeof chunk === "function") return 0;
	if (typeof chunk === "string") {
		return Buffer.byteLength(chunk, typeof encoding === "string" ? encoding as BufferEncoding : undefined);
	}
	if (Buffer.isBuffer(chunk)) return chunk.length;
	if (chunk instanceof Uint8Array) return chunk.byteLength;
	return Buffer.byteLength(String(chunk));
}

function attachResponseByteCounter(res: http.ServerResponse): () => number {
	let bytes = 0;
	const originalWrite = res.write;
	const originalEnd = res.end;
	res.write = function patchedWrite(this: http.ServerResponse, chunk: any, encodingOrCb?: any, cb?: any): boolean {
		bytes += responseChunkByteLength(chunk, encodingOrCb);
		return originalWrite.call(this, chunk, encodingOrCb, cb);
	} as typeof res.write;
	res.end = function patchedEnd(this: http.ServerResponse, chunk?: any, encodingOrCb?: any, cb?: any): http.ServerResponse {
		bytes += responseChunkByteLength(chunk, encodingOrCb);
		return originalEnd.call(this, chunk, encodingOrCb, cb);
	} as typeof res.end;
	return () => bytes;
}

function viewerSubscribedToGoal(ws: any, goalId: string): boolean {
	if (!ws?.isViewer) return false;
	const goalIds = ws.viewerGoalIds;
	return goalIds instanceof Set && goalIds.has(goalId);
}

import { runBatchGitStatusNative } from "./skills/git-status-native.js";
import { VerificationHarness, goalBranchContainer } from "./agent/verification-harness.js";
import { validateAnswers, crossValidate, type UserQuestion } from "./agent/ask-user-choices-validation.js";
import { buildAskResponseEnvelope, findAskResponseAnswers } from "../shared/ask-envelope.js";
import { isKnownThinkingLevel } from "../shared/thinking-levels.js";
import { clampThinkingLevelForModel } from "./agent/thinking-level-clamp.js";
import { isSessionSelectableModelString } from "./agent/google-code-assist.js";

// In-memory dedup guard for ask_user_choices /submit. Keyed by
// `${sessionId}::${toolUseId}`. Populated synchronously before enqueuing the
// response envelope so a concurrent duplicate /submit returns alreadySubmitted
// even when the transcript hasn't yet reflected the first envelope.
// Entries are also refilled from the transcript check, so survive process
// restarts via the transcript fallback in findAskResponseAnswers.
const askSubmittedToolUseIds = new Set<string>();
import { inlineFileImages } from "./agent/inline-file-images.js";
import { StaffManager } from "./agent/staff-manager.js";
import { buildStaffSystemPrompt } from "./agent/role-prompt.js";
import { TriggerEngine } from "./agent/staff-trigger-engine.js";
import { GoalTriggerDispatcher } from "./agent/goal-trigger-dispatcher.js";
import { InboxManager, type InboxEntry } from "./agent/inbox-manager.js";
import { InboxNudger } from "./agent/inbox-nudger.js";
import type { InboxStore } from "./agent/inbox-store.js";
import { PreferencesStore } from "./agent/preferences-store.js";
import { ProjectConfigStore, type PackOrderScope } from "./agent/project-config-store.js";
import { ToolGroupPolicyStore } from "./agent/tool-group-policy-store.js";
import { getAllConfigDirectories, removeBuiltinDirectory, resetConfigDirectories } from "./agent/config-directories.js";
import { checkDockerAvailability, buildSandboxImage, isBuildingImage, ensureImageAgentVersion, resolveSandboxDockerContext } from "./agent/sandbox-status.js";
import { SandboxManager, type SandboxBootstrap } from "./agent/sandbox-manager.js";
import { prepareSanitizedSandboxCloneSource, resolveSandboxCloneSource, type SandboxCloneSource } from "./agent/sandbox-clone-source.js";
import { validateSandboxMounts } from "./agent/sandbox-mounts.js";
import { SandboxTokenStore, type SandboxScope } from "./auth/sandbox-token.js";
import { CookieStore, extractCookieValue, issueCookie, tryAuth as cookieTryAuth } from "./auth/cookie.js";
import { loadOrCreateCookieSigningKey } from "./auth/cookie-signing-key.js";
import { classifyBrowserCookieEligibility, type BrowserCookieAuthentication } from "./auth/browser-cookie.js";
import { authorizeChildrenMutation } from "./auth/children-mutation-authz.js";
import { handlePreviewRequest } from "./preview/content-route.js";
import { handlePrWalkthroughApiRoute } from "./pr-walkthrough/routes.js";
import { normalizeTrustedHosts } from "../shared/pr-walkthrough/url-safety.js";
import { progressBus as searchProgressBus } from "./search/progress-bus.js";
import { isSandboxAllowed } from "./auth/sandbox-guard.js";
import { getGoogleAccessToken, ensureCodeAssistProject, hasGoogleCodeAssistCredential } from "./agent/google-code-assist.js";
import * as previewMount from "./preview/mount.js";
import * as previewArtifacts from "./preview/artifacts.js";
import { broadcastPreviewChanged, subscribePreviewChanged } from "./preview/events.js";
import { configureAigw, removeAigw, getAigwUrl, discoverAigwModels, proxyRequest, startupAigwCheck, writeContextWindowOverrides, configureAigwRuntimeFlags, normalizeAigwModelString } from "./agent/aigw-manager.js";
import { aigwUserAgentHeaders } from "./agent/aigw-user-agent.js";
import { writeOpenAIModelAdditions } from "./agent/openai-model-additions.js";
import { ReviewAnnotationStore, type ReviewAnnotation } from "./review-annotation-store.js";
import { getAvailableModels, discoverModelsForConfig, invalidateModelCache, getBuiltInProviderIds } from "./agent/model-registry.js";
import { testModelPreference, testProviderApiKey } from "./agent/model-completion.js";
import type { CustomProviderConfig } from "./agent/model-registry.js";
import { canonicalImageModelPref, defaultImageModelPref, generateImage, getAvailableImageModels } from "./agent/image-generation.js";
import {
	ProjectRegistry,
	SymlinkProjectRootError,
	PreflightFailedError,
	SYSTEM_PROJECT_ID,
	HEADQUARTERS_PROJECT_ID,
	ProjectOrderError,
	SpecialProjectMutationError,
	assertNormalMutableProject,
	isHeadquartersProject,
	isSystemProject,
	type RegisteredProject,
} from "./agent/project-registry.js";
import { runPreflight } from "./agent/project-preflight.js";
import { archiveProjectBobbitDir, ArchiveError, GATEWAY_OWNED_FILES } from "./agent/bobbit-archive.js";
import { ProjectContextManager } from "./agent/project-context-manager.js";
import type { ProjectContext } from "./agent/project-context.js";
import { resolveProjectForRequest, validateExecutionCwd, type CwdOwnershipSource } from "./agent/resolve-project.js";
import { GoalManager } from "./agent/goal-manager.js";
import { cleanupGateDiagnosticsForGoal } from "./agent/gate-diagnostics-cleanup.js";
import type { WorktreeReferenceRecord } from "./agent/worktree-reference-guard.js";
import { computePlanFreezeUpdate } from "./agent/parent-workflow-freeze.js";
import { detectHostTokens, resolveHostTokenValue, resolveSandboxAgentAuthPolicy } from "./agent/host-tokens.js";
import type { PersistedGoal } from "./agent/goal-store.js";
import type { GateResetResult, GateStatus } from "./agent/gate-store.js";
import type { GateResetIntent } from "./agent/gate-reset-intent.js";
import { launchSidebarSessionFork, resolveGoalGithubLink } from "./sidebar-actions.js";
import { migrateLegacyHeadquartersDirectory, migrateToPerProjectState, recoverPreMigrationData, seedModelDefaultsFromLegacy } from "./agent/state-migration.js";
import { migrateAllProjects as migrateAllProjectYaml } from "./state-migration/migrate-project-yaml.js";
import { resolveScalarConfig } from "./agent/config-resolver.js";
import { BuiltinConfigProvider } from "./agent/builtin-config.js";
import { ConfigCascade, normalizeConfigProjectId, type MarketPackProvider } from "./agent/config-cascade.js";
import { MarketplaceSourceStore, isValidSourceId, type MarketplaceSource } from "./agent/marketplace-source-store.js";
import { BUILTIN_PACK_SCOPE, activeBuiltinFirstPartyPackEntries, builtinFirstPartyPackEntries, isPackEffectivelyEnabled, resolveBuiltinPacksDir } from "./agent/builtin-packs.js";
import { MarketplaceInstaller, MarketplaceError, readPackEntityDescriptions, type InstallScope, type PackOrderStore, type PackEntityDescriptions, type BrowsePack } from "./agent/marketplace-install.js";
import type { MarketplaceMcpResolver, McpReloadResult, McpToolRouteSnapshot, ResolvedMcpContribution } from "./mcp/mcp-manager.js";
import type { MarketplacePiExtensionResolver, ResolvedPiExtensionContribution, PiExtensionDiagnostic } from "./agent/session-setup.js";
import { scopeMarketPackEntries } from "./agent/pack-list.js";
import { buildConflictsFor, type ConflictWire, type PackScope, type PackEntry } from "./agent/pack-types.js";
import { isSafeBasename } from "./agent/pack-manifest.js";
import { gatewayMcpActivationContributionId, gatewayMcpRuntimeKey } from "./agent/mcp-gateway-runtime-identity.js";

import { initAssistantRegistry, assistantRoleForType } from "./agent/assistant-registry.js";
import {
	deleteProposalFile,
	editProposalFile,
	isProposalType,
	latestRev,
	listProposalFiles,
	parseProposalFile,
	readProposalFile,
	readSnapshot,
	restoreSnapshot,
	writeProposalFile,
	getProposalTypePlugin,
	type ProposalType,
} from "./proposals/proposal-files.js";
import { prepareGoalProposalSeed } from "./proposals/goal-proposal-seed.js";

const VALID_TASK_STATES = new Set<string>(["todo", "in-progress", "blocked", "complete", "skipped"]);

/** Max WebSocket frame the gateway will accept (S31). The ws default is 100 MiB;
 *  a multi-image prompt frame carries ~3x base64 per image and could silently
 *  trip a close-1009 teardown. Set an explicit, generous cap ABOVE the composer's
 *  aggregate-send guard (src/ui/components/MessageEditor.ts) so the composer
 *  rejects an oversized send with a clear error BEFORE it can tear down the socket. */
export const WS_MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;

const _goalPendingOverflowCheck = new WeakSet<WebSocket>();
const _goalWarnedClients = new WeakSet<WebSocket>();

const execAsync = promisify(exec);
let serverCommandRunner: CommandRunner = realCommandRunner;
let serverRemoteGitPolicy: RemoteGitPolicy = {};
export function __setServerRemoteGitPolicy(p: RemoteGitPolicy): RemoteGitPolicy { const prev = serverRemoteGitPolicy; serverRemoteGitPolicy = p; return prev; }
let serverRuntimeFlags = { e2e: false, testNoExternal: false };

function oneLineDescription(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const t = value.replace(/\s+/g, " ").trim();
	return t.length > 0 ? t : undefined;
}

function readYamlMapping(file: string): Record<string, unknown> | null {
	try {
		const data = parseYaml(fs.readFileSync(file, "utf-8"));
		return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function safeString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

type McpOperationMetadataEntry = { name: string; label?: string; description?: string; inputSchema?: unknown };

function normaliseMcpOperationMetadata(raw: unknown): McpOperationMetadataEntry[] {
	if (!Array.isArray(raw)) return [];
	const out: McpOperationMetadataEntry[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const obj = item as Record<string, unknown>;
		const name = safeString(obj.name ?? obj.operation ?? obj.id);
		if (!name || seen.has(name)) continue;
		seen.add(name);
		out.push({
			name,
			...(safeString(obj.label ?? obj.title ?? obj.displayName) ? { label: safeString(obj.label ?? obj.title ?? obj.displayName) } : {}),
			...(safeString(obj.description) ? { description: safeString(obj.description) } : {}),
			...(obj.inputSchema !== undefined ? { inputSchema: obj.inputSchema } : {}),
		});
	}
	return out;
}

function operationMetadataForMcpContribution(
	mcp: { listName: string; sourceFile?: string; operationMetadata?: unknown },
	metaDetails: Record<string, unknown>,
): McpOperationMetadataEntry[] {
	const gatewayOps = metaDetails.gatewayOperations;
	if (gatewayOps && typeof gatewayOps === "object" && !Array.isArray(gatewayOps)) {
		const normalised = normaliseMcpOperationMetadata((gatewayOps as Record<string, unknown>)[mcp.listName]);
		if (normalised.length > 0) return normalised;
	}
	const fromContribution = normaliseMcpOperationMetadata(mcp.operationMetadata);
	if (fromContribution.length > 0) return fromContribution;
	const raw = mcp.sourceFile ? readYamlMapping(mcp.sourceFile)?.operations : undefined;
	return normaliseMcpOperationMetadata(raw);
}

function activationMcpContributionId(
	entry: PackEntry,
	mcp: { listName: string; serverName: string; subNamespace?: string },
	metaDetails: Record<string, unknown>,
	fallbackSourceId?: string,
): string {
	if (metaDetails.sourceType === "mcp-gateway") {
		return gatewayMcpActivationContributionId(entry, mcp, metaDetails, fallbackSourceId);
	}
	return mcp.listName;
}

/**
 * Expand manifest-declared tool GROUP directories into concrete tool names.
 * Runtime tool loading scans `.yaml` files only, so activation uses the same
 * extension filter. `DisabledRefs.tools` is keyed by tool name, while pack.yaml
 * keeps declaring tool groups for manifest compatibility.
 */
export function readConcretePackToolsFromGroups(
	packDir: string,
	toolGroups: readonly string[],
): { tools: string[]; descriptions: Record<string, string> } {
	const tools: string[] = [];
	const descriptions: Record<string, string> = {};
	const seen = new Set<string>();
	const toolsDir = path.join(packDir, "tools");
	if (!isPackPathWithinRoot(packDir, toolsDir)) return { tools, descriptions };

	for (const group of toolGroups) {
		if (!isSafeBasename(group)) continue;
		const groupDir = path.join(toolsDir, group);
		if (!isPackPathWithinRoot(toolsDir, groupDir)) continue;
		let files: fs.Dirent[];
		try {
			files = fs.readdirSync(groupDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.isFile() || !file.name.endsWith(".yaml")) continue;
			const yamlPath = path.join(groupDir, file.name);
			if (!isPackPathWithinRoot(groupDir, yamlPath)) continue;
			const data = readYamlMapping(yamlPath);
			const name = typeof data?.name === "string" ? data.name : "";
			if (!name || seen.has(name)) continue;
			seen.add(name);
			tools.push(name);
			const desc = oneLineDescription(data?.description);
			if (desc) descriptions[name] = desc;
		}
	}
	return { tools, descriptions };
}

export function buildMarketToolRootsForProject(options: {
	projectId?: string;
	builtinEntries: readonly PackEntry[];
	/** Raw built-in entries filtered out of active contribution resolution. */
	inactiveBuiltinEntries?: readonly PackEntry[];
	marketEntries: (scope: InstallScope, projectId?: string) => readonly PackEntry[];
	disabledTools: (scope: InstallScope, projectId: string | undefined, packName: string) => readonly string[] | undefined;
}): MarketToolRoot[] {
	const roots: MarketToolRoot[] = [];
	const seenActive = new Set<string>();
	const seenInactive = new Set<string>();
	const push = (entry: PackEntry, activationScope: InstallScope): void => {
		const toolsDir = path.join(entry.path, "tools");
		const key = path.resolve(toolsDir);
		if (seenActive.has(key)) return;
		seenActive.add(key);
		const packName = entry.manifest?.name;
		const disabledTools = packName ? options.disabledTools(activationScope, options.projectId, packName) : undefined;
		roots.push({ dir: toolsDir, disabledTools: disabledTools ? [...disabledTools] : undefined });
	};
	const pushInactiveBuiltin = (entry: PackEntry): void => {
		const toolsDir = path.join(entry.path, "tools");
		const key = path.resolve(toolsDir);
		if (seenActive.has(key) || seenInactive.has(key)) return;
		seenInactive.add(key);
		roots.push({ dir: toolsDir, inactiveReason: "disabled-market-pack" });
	};

	// Built-in first-party packs are toggleable at server scope and sit below all
	// user-installed market scopes, mirroring ConfigCascade.resolveEntities().
	for (const entry of options.builtinEntries) push(entry, "server");
	for (const scope of ["server", "global-user", "project"] as const) {
		for (const entry of options.marketEntries(scope, options.projectId)) push(entry, scope);
	}
	for (const entry of options.inactiveBuiltinEntries ?? []) pushInactiveBuiltin(entry);
	return roots;
}

function loadPiExtensionContributionsFromRuntime(packRoot: string, manifest: NonNullable<PackEntry["manifest"]>): ResolvedPiExtensionContribution[] {
	return loadPiExtensionContributions(packRoot, manifest);
}

function loadPiExtensionContributionsWithDiscoverySyncFromRuntime(
	packRoot: string,
	manifest: NonNullable<PackEntry["manifest"]>,
	opts: { trustAccepted: boolean; origin?: Partial<ResolvedPiExtensionContribution["origin"]>; disabledRefs?: Iterable<string> },
): ResolvedPiExtensionContribution[] {
	return loadPiExtensionContributionsWithDiscoverySync(packRoot, manifest, opts);
}

function piExtensionDiagnostic(status: PiExtensionDiagnostic["status"], code: string, message: string): PiExtensionDiagnostic {
	return { status, code, message, updatedAt: new Date().toISOString() };
}

export function piExtensionCatalogueRef(entry: string | Record<string, unknown>): string {
	return typeof entry === "string"
		? entry
		: String(entry.ref ?? entry.listName ?? "");
}

export function normalisePiExtensionCatalogueRefs(entries: readonly (string | Record<string, unknown>)[] | undefined): Set<string> {
	return new Set((entries ?? []).map(piExtensionCatalogueRef).filter(Boolean));
}

export function buildPiExtensionToolRows(contributions: readonly ResolvedPiExtensionContribution[]): Array<Record<string, unknown>> {
	annotatePiExtensionToolNameCollisions(contributions);
	const byName = new Map<string, Record<string, unknown>>();
	for (const contribution of contributions) {
		if (contribution.diagnostic.status === "disabled" || contribution.diagnostic.status === "unresolved") continue;
		for (const tool of contribution.discovery?.tools ?? []) {
			if (!tool.name) continue;
			const provider = {
				providerKey: `pi-ext:${contribution.origin.scope}:${contribution.origin.packId}:${contribution.listName}:${tool.name}`,
				packName: contribution.origin.packName,
				listName: contribution.listName,
				scope: contribution.origin.scope,
				...(contribution.entryPath ? { sourcePath: contribution.entryPath } : {}),
			};
			const existing = byName.get(tool.name);
			if (existing) {
				(existing.providers as Array<Record<string, unknown>>).push(provider);
				continue;
			}
			byName.set(tool.name, {
				name: tool.name,
				description: tool.description ?? "Pi extension tool",
				inputSchema: tool.inputSchema,
				providerType: "pi-extension",
				origin: "marketplace-pi-extension",
				originPackName: contribution.origin.packName,
				originPackId: contribution.origin.packId,
				group: "Pi Extension",
				readOnly: true,
				...(contribution.entryPath ? { sourcePath: contribution.entryPath } : {}),
				providers: [provider],
			});
		}
	}
	return [...byName.values()];
}

export function appendPiExtensionToolRows(tools: Array<Record<string, unknown>>, piRows: readonly Record<string, unknown>[]): void {
	const byName = new Map(tools.map((tool) => [String(tool.name), tool]));
	for (const row of piRows) {
		const name = String(row.name ?? "");
		if (!name) continue;
		const existing = byName.get(name);
		if (!existing) {
			tools.push({ ...row });
			byName.set(name, tools[tools.length - 1]);
			continue;
		}
		const providers = Array.isArray(existing.providers) ? existing.providers : [];
		existing.providers = [...providers, ...((row.providers as Array<Record<string, unknown>> | undefined) ?? [])];
		existing.piExtensionCollision = true;
		existing.piExtensionPolicyScope = "name";
	}
}

function piExtensionToolScopeContext(scope: { projectId?: string; cwd?: string }): ScopedToolContext {
	const projectId = normalizeConfigProjectId(scope.projectId);
	const cwd = scope.projectId === HEADQUARTERS_PROJECT_ID ? undefined : scope.cwd;
	const scopeKey = projectId ? `project:${projectId}` : cwd ? `cwd:${path.resolve(cwd)}` : "default";
	return { ...(projectId ? { projectId } : {}), ...(cwd ? { cwd } : {}), scopeKey };
}

function annotatePiExtensionToolNameCollisions(contributions: readonly ResolvedPiExtensionContribution[]): void {
	const byName = new Map<string, ResolvedPiExtensionContribution[]>();
	for (const contribution of contributions) {
		if (contribution.diagnostic.status === "disabled" || contribution.diagnostic.status === "unresolved") continue;
		for (const tool of contribution.discovery?.tools ?? []) {
			if (!tool.name) continue;
			const providers = byName.get(tool.name) ?? [];
			providers.push(contribution);
			byName.set(tool.name, providers);
		}
	}
	for (const [name, providers] of byName) {
		const unique = new Set(providers.map((provider) => `${provider.origin.scope}:${provider.origin.packId}:${provider.listName}`));
		if (unique.size < 2) continue;
		for (const contribution of providers) {
			if (contribution.diagnostic.status !== "ok") continue;
			contribution.diagnostic = piExtensionDiagnostic("ok", "tool_name_collision", `Multiple pi extensions expose runtime tool name "${name}" in this scope; one name-based policy applies to all providers.`);
		}
	}
}

function piExtensionExternalTools(contributions: readonly ResolvedPiExtensionContribution[]): PiExtensionExternalTool[] {
	annotatePiExtensionToolNameCollisions(contributions);
	const out: PiExtensionExternalTool[] = [];
	for (const contribution of contributions) {
		if (contribution.diagnostic.status === "disabled" || contribution.diagnostic.status === "unresolved") continue;
		for (const tool of contribution.discovery?.tools ?? []) {
			if (!tool.name) continue;
			out.push({
				name: tool.name,
				runtimeName: tool.name,
				description: tool.description ?? "Pi extension tool",
				group: "Pi Extensions",
				inputSchema: tool.inputSchema,
				providerKey: `pi-ext:${contribution.origin.scope}:${contribution.origin.packId}:${contribution.listName}:${tool.name}`,
				packName: contribution.origin.packName,
				packId: contribution.origin.packId,
				listName: contribution.listName,
				scope: contribution.origin.scope,
				...(contribution.entryPath ? { sourcePath: contribution.entryPath } : {}),
			});
		}
	}
	return out;
}

const piExtensionDiscoveryCache = new Map<string, { rows?: ResolvedPiExtensionContribution[]; pending?: Promise<ResolvedPiExtensionContribution[]> }>();

/**
 * Clamp a thinking-level token against a role's pinned model (if any).
 * - Validates that the token is in the canonical set; returns undefined otherwise.
 * - When `modelStr` is set in canonical `provider/modelId` form, clamps the
 *   level against that model's inferred reasoning/family.
 * - When `modelStr` is empty (role inherits), returns the validated token as-is
 *   — the per-session clamp at spawn time will handle model resolution.
 */
function clampRoleThinking(value: unknown, modelStr: string | undefined): string | undefined {
	const known = isKnownThinkingLevel(value);
	if (!known) return undefined;
	if (!modelStr) return known;
	const slash = modelStr.indexOf("/");
	if (slash <= 0) return known;
	const provider = modelStr.slice(0, slash);
	const modelId = modelStr.slice(slash + 1);
	return clampThinkingLevelForModel(known, provider, modelId);
}

export function isMissingRemoteRefDeleteError(err: unknown): boolean {
	const texts: string[] = [];
	const addText = (value: unknown) => {
		if (typeof value === "string") texts.push(value);
		else if (Buffer.isBuffer(value)) texts.push(value.toString("utf-8"));
	};

	addText(err);
	if (err instanceof Error) addText(err.message);
	if (err && typeof err === "object") {
		const record = err as Record<string, unknown>;
		addText(record.stderr);
		addText(record.message);
	}

	return texts.some(text => /\bremote\s+ref\s+does\s+not\s+exist\b/i.test(text));
}

export function isIgnorableRemoteBranchDeleteError(err: unknown): boolean {
	if (isMissingRemoteRefDeleteError(err)) return true;
	if (!err || typeof err !== "object") return false;
	const record = err as Record<string, unknown>;
	return record.code === "ENOENT"
		&& record.path === "git"
		&& typeof record.syscall === "string"
		&& record.syscall.startsWith("spawn");
}

/**
 * Delete remote branches associated with a goal (integration + agent worktree branches).
 * Fire-and-forget — idempotent cleanup misses are ignored; other errors are logged but never block the archive flow.
 */
async function deleteRemoteGoalBranches(
	goal: PersistedGoal,
	extraBranches: readonly string[],
	repoPath: string,
	commandRunner: CommandRunner,
	remotePolicy: RemoteGitPolicy = {},
): Promise<void> {
	const branches = new Set<string>();
	if (goal.branch) branches.add(goal.branch);
	for (const b of extraBranches) {
		if (b) branches.add(b);
	}
	if (branches.size === 0) return;
	if (shouldSkipRemotePush(remotePolicy)) return;

	// Multi-repo: iterate all configured repos and run `git push --delete` in
	// each one in parallel. Single-repo collapses to a single repoPath.
	const goalRepoWorktrees = (goal as { repoWorktrees?: Record<string, string> }).repoWorktrees;
	const repoPaths: string[] = goalRepoWorktrees && Object.keys(goalRepoWorktrees).length > 0
		? Object.keys(goalRepoWorktrees).map(repo => repo === "." ? repoPath : path.join(repoPath, repo))
		: [repoPath];

	await Promise.allSettled(repoPaths.flatMap(rp => Array.from(branches).map(async (branch) => {
		try {
			await commandRunner.execFile("git", ["push", "origin", "--delete", branch], {
				cwd: rp,
				timeout: 15_000,
			});
			console.log(`[api] Deleted remote branch: ${branch} (repo: ${rp})`);
		} catch (err) {
			if (isIgnorableRemoteBranchDeleteError(err)) return;
			console.warn(`[api] Failed to delete remote branch ${branch} in ${rp}:`, err);
		}
	})));
}

const HEADQUARTERS_NO_WORKTREE_GOAL_GIT_MESSAGE = "This Headquarters goal runs in the Headquarters directory without a git worktree. Git branch, merge, and PR actions are unavailable.";
const GENERIC_NO_WORKTREE_GOAL_GIT_MESSAGE = "This goal runs without a git worktree. Git branch, merge, and PR actions are unavailable.";

function hasGoalGitWorktree<T extends Pick<PersistedGoal, "branch" | "worktreePath">>(goal: T): goal is T & { branch: string; worktreePath: string } {
	return !!goal.branch && !!goal.worktreePath;
}

function noWorktreeGoalGitMessage(goal: Pick<PersistedGoal, "projectId">): string {
	return goal.projectId === HEADQUARTERS_PROJECT_ID
		? HEADQUARTERS_NO_WORKTREE_GOAL_GIT_MESSAGE
		: GENERIC_NO_WORKTREE_GOAL_GIT_MESSAGE;
}

function goalGitUnavailablePayload(goal: Pick<PersistedGoal, "id" | "projectId" | "branch" | "worktreePath">, action: string): Record<string, unknown> {
	return {
		error: `${action} is unavailable. ${noWorktreeGoalGitMessage(goal)}`,
		code: "GOAL_GIT_UNAVAILABLE",
		goalId: goal.id,
		projectId: goal.projectId,
		branch: goal.branch ?? null,
		worktreePath: goal.worktreePath ?? null,
	};
}

// ── Headquarters session git isolation ──
// Headquarters sessions default their cwd to the Headquarters directory
// (`<serverRunDir>/.bobbit/headquarters`), which is physically INSIDE the
// server run directory's git checkout. Running git/gh from there would leak
// the parent repo's state. Headquarters never uses worktrees or git lifecycle,
// so every session git/PR endpoint must short-circuit with an unavailable
// response instead of shelling out from cwd. See design "Headquarters
// git/worktree behavior".
const HEADQUARTERS_NO_WORKTREE_SESSION_GIT_MESSAGE = "This Headquarters session runs in the Headquarters directory without a git worktree. Git branch, merge, and PR actions are unavailable.";

function isHeadquartersSession(session: { projectId?: string }): boolean {
	return session.projectId === HEADQUARTERS_PROJECT_ID;
}

function sessionGitUnavailablePayload(session: { id: string; projectId?: string }, action: string): Record<string, unknown> {
	return {
		error: `${action} is unavailable. ${HEADQUARTERS_NO_WORKTREE_SESSION_GIT_MESSAGE}`,
		code: "GOAL_GIT_UNAVAILABLE",
		sessionId: session.id,
		projectId: session.projectId ?? HEADQUARTERS_PROJECT_ID,
		branch: null,
		worktreePath: null,
	};
}

/** Cached Docker availability result to avoid running `docker info` per session creation */
let _dockerAvailCache: { available: boolean; error?: string; ts: number } | null = null;

// ── PR status cache (avoids blocking event loop with gh CLI every poll) ──
const _prCache = new Map<string, { data: any; ts: number; ttl: number }>();
const PR_NULL_CACHE_TTL_MS = 30_000; // 30 seconds for null (no-PR) results
const _prInFlight = new Map<string, Promise<any | null>>();
const PR_STATUS_FIELDS = "state,url,number,title,mergeable,headRefName,baseRefName,reviewDecision";
const PR_MERGE_PERMISSIONS_QUERY = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){viewerPermission pullRequest(number:$number){viewerCanMergeAsAdmin}}}";

type GhExecFileForTests = (args: readonly string[], opts: { cwd: string; timeout: number }) => Promise<string>;
let _ghExecFileForTests: GhExecFileForTests | undefined;

export function buildGhPrViewArgs(branch?: string): string[] {
	return branch ? ["pr", "view", branch, "--json", PR_STATUS_FIELDS] : ["pr", "view", "--json", PR_STATUS_FIELDS];
}

export function buildGhPrMergePermissionsArgs(owner: string, name: string, number: number): string[] {
	return [
		"api", "graphql",
		"-f", `query=${PR_MERGE_PERMISSIONS_QUERY}`,
		"-F", `owner=${owner}`,
		"-F", `name=${name}`,
		"-F", `number=${number}`,
	];
}

export function buildGhBranchRulesArgs(owner: string, name: string, branch: string): string[] {
	return ["api", `repos/${owner}/${name}/rules/branches/${encodeURIComponent(branch)}`];
}

export function buildGhRulesetArgs(owner: string, name: string, rulesetId: number): string[] {
	return ["api", `repos/${owner}/${name}/rulesets/${rulesetId}`];
}

export function buildGhPrMergeArgs(branch: string | undefined, method: string, admin: unknown): string[] {
	return ["pr", "merge", ...(branch ? [branch] : []), `--${method}`, ...(admin ? ["--admin"] : [])];
}

async function execGh(args: readonly string[], cwd: string, timeout = 10_000): Promise<string> {
	if (_ghExecFileForTests) return _ghExecFileForTests(args, { cwd, timeout });
	const { stdout } = await serverCommandRunner.execFile("gh", [...args], { cwd, encoding: "utf-8", timeout });
	return String(stdout);
}

export function __setGhExecFileForPrStatusTests(fn: GhExecFileForTests | undefined): void {
	_ghExecFileForTests = fn;
	__resetPrStatusCachesForTests();
}

export function __resetPrStatusCachesForTests(): void {
	_prCache.clear();
	_prInFlight.clear();
	_repoPermCache.clear();
}

// Cache viewer permission per repo (rarely changes, long TTL)
const _repoPermCache = new Map<string, { perm: string; ts: number }>();
const REPO_PERM_CACHE_TTL_MS = 300_000; // 5 minutes

async function getViewerIsAdmin(cwd: string): Promise<boolean> {
	const cached = _repoPermCache.get(cwd);
	if (cached && Date.now() - cached.ts < REPO_PERM_CACHE_TTL_MS) return cached.perm === "ADMIN";
	try {
		const stdout = await execGh(["repo", "view", "--json", "viewerPermission"], cwd);
		const perm = JSON.parse(stdout).viewerPermission ?? "";
		_repoPermCache.set(cwd, { perm, ts: Date.now() });
		return perm === "ADMIN";
	} catch {
		_repoPermCache.set(cwd, { perm: "", ts: Date.now() });
		return false;
	}
}

function parseGithubPrRepo(url: unknown): { owner: string; name: string } | null {
	if (typeof url !== "string" || !url) return null;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return null;
		const [owner, name, pull, number] = parsed.pathname.split("/").filter(Boolean);
		if (!owner || !name || pull !== "pull" || !number || !/^\d+$/.test(number)) return null;
		return { owner, name };
	} catch {
		return null;
	}
}

async function getViewerMergePermissions(
	cwd: string,
	pr: { url?: string; number?: number; baseRefName?: string },
): Promise<{ viewerIsAdmin: boolean; viewerCanMergeAsAdmin: boolean }> {
	const repo = parseGithubPrRepo(pr.url);
	if (repo && typeof pr.number === "number") {
		try {
			const stdout = await execGh(buildGhPrMergePermissionsArgs(repo.owner, repo.name, pr.number), cwd);
			const parsed = JSON.parse(stdout);
			const repository = parsed?.data?.repository;
			const perm = repository?.viewerPermission ?? "";
			_repoPermCache.set(cwd, { perm, ts: Date.now() });

			let viewerCanMergeAsAdmin = repository?.pullRequest?.viewerCanMergeAsAdmin === true;
			if (!viewerCanMergeAsAdmin && typeof pr.baseRefName === "string" && pr.baseRefName) {
				viewerCanMergeAsAdmin = await getViewerCanBypassBranchRules(cwd, repo, pr.baseRefName);
			}

			return { viewerIsAdmin: perm === "ADMIN", viewerCanMergeAsAdmin };
		} catch {
			// Fall through to legacy permission probe.
		}
	}
	return { viewerIsAdmin: await getViewerIsAdmin(cwd), viewerCanMergeAsAdmin: false };
}

async function getViewerCanBypassBranchRules(
	cwd: string,
	repo: { owner: string; name: string },
	branch: string,
): Promise<boolean> {
	try {
		const stdout = await execGh(buildGhBranchRulesArgs(repo.owner, repo.name, branch), cwd);
		const rules = JSON.parse(stdout);
		if (!Array.isArray(rules)) return false;

		if (rules.some((rule) => isBypassMode(rule?.current_user_can_bypass))) return true;

		const rulesetIds = [
			...new Set(rules.map((rule) => rule?.ruleset_id).filter((id): id is number => typeof id === "number")),
		];

		for (const rulesetId of rulesetIds) {
			try {
				const detail = JSON.parse(await execGh(buildGhRulesetArgs(repo.owner, repo.name, rulesetId), cwd));
				if (isBypassMode(detail?.current_user_can_bypass)) return true;
			} catch {
				// Continue checking other matching rulesets.
			}
		}
		return false;
	} catch {
		return false;
	}
}

function isBypassMode(mode: unknown): boolean {
	return mode === "always" || mode === "pull_requests_only";
}

async function _fetchPrStatus(cwd: string, branch?: string, fallbackCwd?: string): Promise<any | null> {
	const cacheKey = branch ? `${cwd}::${branch}` : cwd;
	const args = buildGhPrViewArgs(branch);

	// Try cwd first, then fallback (e.g. main repo when worktree git link is broken)
	const cwdsToTry = [cwd, ...(fallbackCwd && fallbackCwd !== cwd ? [fallbackCwd] : [])];
	for (const dir of cwdsToTry) {
		try {
			const stdout = await execGh(args, dir);
			const pr = JSON.parse(stdout);
			const { viewerIsAdmin, viewerCanMergeAsAdmin } = await getViewerMergePermissions(dir, pr);
			const data = {
				number: pr.number,
				url: pr.url,
				title: pr.title,
				state: pr.state,
				mergeable: pr.mergeable,
				headRefName: pr.headRefName,
				baseRefName: pr.baseRefName,
				reviewDecision: pr.reviewDecision || null,
				viewerIsAdmin,
				viewerCanMergeAsAdmin,
			};
			const ttl = pr.state === "OPEN" ? 10_000 : 900_000; // OPEN: 10s, CLOSED/MERGED: 15min
			_prCache.set(cacheKey, { data, ts: Date.now(), ttl });
			return data;
		} catch {
			// Try next cwd
		}
	}
	_prCache.set(cacheKey, { data: null, ts: Date.now(), ttl: PR_NULL_CACHE_TTL_MS });
	return null;
}

export async function __getCachedPrStatusForTests(cwd: string, branch?: string, fallbackCwd?: string): Promise<any | null> {
	return getCachedPrStatus(cwd, branch, fallbackCwd);
}

async function getCachedPrStatus(cwd: string, branch?: string, fallbackCwd?: string): Promise<any | null> {
	const cacheKey = branch ? `${cwd}::${branch}` : cwd;
	const cached = _prCache.get(cacheKey);
	if (cached && Date.now() - cached.ts < cached.ttl) return cached.data;

	const existing = _prInFlight.get(cacheKey);
	if (existing) return existing;

	const p = _fetchPrStatus(cwd, branch, fallbackCwd);
	_prInFlight.set(cacheKey, p);
	try { return await p; } finally { _prInFlight.delete(cacheKey); }
}

// ── Async git helpers (avoid blocking event loop) ──
function splitGitShellCommand(cmd: string): string[] {
	const trimmed = cmd.trim();
	if (!trimmed.startsWith("git ")) throw new Error(`Unsupported git command: ${cmd}`);
	const body = trimmed.slice(4).trim();
	const matches = body.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
	return matches.map(part => {
		if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) return part.slice(1, -1);
		return part;
	});
}

async function execGit(cmd: string, cwd: string, timeout = 5000, containerId?: string, commandRunner?: CommandRunner): Promise<string> {
	const runner = commandRunner ?? serverCommandRunner;
	if (containerId) {
		const { stdout } = await runner.execFile("docker", [
			"exec", "-w", cwd, containerId, "/bin/sh", "-c", cmd,
		], { encoding: "utf-8", timeout, env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } });
		return String(stdout).trim();
	}
	if (cmd.trim().startsWith("git ")) {
		const { stdout } = await runner.execFile("git", splitGitShellCommand(cmd), { cwd, encoding: "utf-8", timeout });
		return String(stdout).trim();
	}
	const { stdout } = await execAsync(cmd, { cwd, encoding: "utf-8", timeout });
	return stdout.trim();
}
async function execGitSafe(cmd: string, cwd: string, fallback = "", containerId?: string, commandRunner?: CommandRunner): Promise<string> {
	try { return await execGit(cmd, cwd, 5000, containerId, commandRunner); } catch { return fallback; }
}

async function execGitArgs(args: string[], cwd: string, timeout = 5000, containerId?: string, commandRunner?: CommandRunner): Promise<string> {
	const runner = commandRunner ?? serverCommandRunner;
	if (containerId) {
		const { stdout } = await runner.execFile("docker", [
			"exec", "-w", cwd, containerId, "git", ...args,
		], { encoding: "utf-8", timeout, env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } });
		return String(stdout).trim();
	}
	const { stdout } = await runner.execFile("git", args, { cwd, encoding: "utf-8", timeout });
	return String(stdout).trim();
}
// Argument-vector variant of execGitSafe: never passes user input through a shell.
async function execGitArgsSafe(args: string[], cwd: string, fallback = "", containerId?: string, commandRunner?: CommandRunner): Promise<string> {
	try { return await execGitArgs(args, cwd, 5000, containerId, commandRunner); } catch { return fallback; }
}

function branchPublishGitArgs(branch: string): {
	push: string[];
	fetchRemoteTracking: string[];
	setUpstream: string[];
} {
	if (!branch) throw new Error("Cannot push: no current branch");
	return {
		push: ["push", "origin", `HEAD:refs/heads/${branch}`],
		fetchRemoteTracking: ["fetch", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`],
		setUpstream: ["branch", `--set-upstream-to=origin/${branch}`, branch],
	};
}

let _publishCurrentBranchToOriginFake: ((cwd: string, branch: string, opts: { containerId?: string; setUpstream?: boolean }) => Promise<string> | string) | undefined;
export function __setPublishCurrentBranchToOriginFake(fn: typeof _publishCurrentBranchToOriginFake): void { _publishCurrentBranchToOriginFake = fn; }
export function __clearPublishCurrentBranchToOriginFake(): void { _publishCurrentBranchToOriginFake = undefined; }

async function publishCurrentBranchToOrigin(
	cwd: string,
	branch: string,
	opts: { containerId?: string; setUpstream?: boolean } = {},
): Promise<string> {
	if (_publishCurrentBranchToOriginFake) return _publishCurrentBranchToOriginFake(cwd, branch, opts);
	const args = branchPublishGitArgs(branch);
	const output = await execGitArgs(args.push, cwd, 30_000, opts.containerId);
	if (opts.setUpstream) {
		try {
			await execGitArgs(args.fetchRemoteTracking, cwd, 15_000, opts.containerId);
			await execGitArgs(args.setUpstream, cwd, 10_000, opts.containerId);
		} catch {
			// Publishing succeeded; upstream repair is best-effort for compatibility.
		}
	}
	return output;
}

/** Git status result shape (+ optional partial/untrackedIncluded flags). */
export interface GitStatusResult {
	branch: string; primaryBranch: string; isOnPrimary: boolean;
	/**
	 * Actual ref used for `aheadOfPrimary`/`behindPrimary` calculations.
	 * Equals `origin/<primaryBranch>` when the remote ref exists, else the
	 * bare local branch name `<primaryBranch>`. Surfaced separately from
	 * `primaryBranch` so the UI can render the truthful target (a configured
	 * `base_ref` of `MyUpstream` is a LOCAL branch — "Merged into
	 * origin/MyUpstream" is misleading when origin has no such ref).
	 */
	primaryRef: string;
	status: { file: string; status: string }[];
	hasUpstream: boolean; ahead: number; behind: number;
	aheadOfPrimary: number; behindPrimary: number; mergedIntoPrimary: boolean;
	insertionsVsPrimary: number; deletionsVsPrimary: number;
	clean: boolean; summary: string; unpushed: boolean;
	/** true if porcelain (Phase B) was skipped or timed-out */
	partial?: boolean;
	/** true only when ?untracked=1 was passed (-uall); false on default -uno */
	untrackedIncluded?: boolean;
}

// ── Git status cache + single-flight ──
// Short TTL (2000ms) to coalesce the storm of event-driven refreshes (reconnect,
// agent-idle, session-switch, goal-dashboard fan-out across N sessions sharing
// a cwd) into one underlying git invocation. Native parallel execFile typically
// returns in 50-150 ms on Windows / 10-30 ms on Linux, so 2 s of staleness is
// imperceptible to the widget (which polls every 10 s) and high-value for
// coalescing. Errors are NOT cached (so a transient failure doesn't stick).
// Key includes the untracked flag so dropdown (full) and pill-strip (summary)
// responses never cross-contaminate each other.
const GIT_STATUS_TTL_MS = 2000;
interface GitStatusCacheEntry {
	promise: Promise<GitStatusResult | null>;
	resolvedAt: number; // 0 while in flight
	result: GitStatusResult | null | undefined; // undefined while in flight
}
const gitStatusCache = new Map<string, GitStatusCacheEntry>();

/** Test-only invocation counter (underlying git script runs). */
let _runBatchGitStatusCount = 0;
export function __getGitStatusInvocationCount(): number { return _runBatchGitStatusCount; }
export function __resetGitStatusInvocationCount(): void { _runBatchGitStatusCount = 0; }

/** Test-only hook: if set, replaces the real `runBatchGitStatus` git-spawn
 *  path with a fake. Used by `tests/e2e/git-status-caching.spec.ts` to
 *  exercise the TTL/single-flight/coalesce logic deterministically without
 *  spawning Git Bash under CI load (which fails unpredictably). Production
 *  code never sets this. */
let _gitStatusFake: ((cwd: string, containerId?: string, opts?: { untracked?: boolean; configuredBaseRef?: string }) => Promise<GitStatusResult | null>) | undefined;
export function __setGitStatusFake(fn: typeof _gitStatusFake): void { _gitStatusFake = fn; }
export function __clearGitStatusFake(): void { _gitStatusFake = undefined; }

function gitStatusCacheKey(cwd: string, containerId?: string, untracked?: boolean): string {
	return `${containerId ?? 'host'}::${cwd}::${untracked ? 'u' : 's'}`;
}

/** Invalidate both summary and untracked cache entries for a cwd (optionally
 *  scoped to a container). Call after any local git mutation (commit, pull,
 *  push, rebase, merge). */
export function invalidateGitStatusCache(cwd: string, containerId?: string): void {
	gitStatusCache.delete(gitStatusCacheKey(cwd, containerId, true));
	gitStatusCache.delete(gitStatusCacheKey(cwd, containerId, false));
}

/** Test-only: mark all cache entries for a cwd as TTL-expired without
 *  sleeping. Used by `tests/e2e/git-status-caching.spec.ts` to deterministically
 *  exercise the TTL re-run path without inflating wall-clock time. Sets
 *  `resolvedAt` to a timestamp older than `GIT_STATUS_TTL_MS` so the next
 *  call falls through to a fresh invocation. */
export function __forceGitStatusCacheExpiry(cwd: string, containerId?: string): void {
	const staleAt = Date.now() - GIT_STATUS_TTL_MS - 1000;
	for (const untracked of [true, false]) {
		const entry = gitStatusCache.get(gitStatusCacheKey(cwd, containerId, untracked));
		if (entry && entry.result !== undefined) entry.resolvedAt = staleAt;
	}
}

function evictExpired(now: number): void {
	if (gitStatusCache.size <= 200) return;
	for (const [k, v] of gitStatusCache) {
		if (v.resolvedAt !== 0 && now - v.resolvedAt > 5000) gitStatusCache.delete(k);
	}
}

/** Cached wrapper over runBatchGitStatus with TTL + single-flight.
 *
 * `opts.configuredBaseRef` (when set) drives the `primaryBranch` used for
 * `aheadOfPrimary`/`behindPrimary` counters — see
 * `docs/design/base-ref.md` §5. It's not part of the cache key: each
 * (cwd, containerId) is a project-scoped worktree so `base_ref` is constant
 * for the lifetime of an entry, and the 2 s TTL absorbs the corner case of a
 * mid-flight setting change. */
async function batchGitStatus(
	cwd: string,
	containerId?: string,
	opts?: { untracked?: boolean; configuredBaseRef?: string },
): Promise<GitStatusResult | null> {
	const key = gitStatusCacheKey(cwd, containerId, opts?.untracked);
	const now = Date.now();
	evictExpired(now);
	const existing = gitStatusCache.get(key);
	if (existing) {
		if (existing.result === undefined) return existing.promise; // in flight
		if (now - existing.resolvedAt < GIT_STATUS_TTL_MS) return existing.result; // fresh
		// stale — fall through and re-run
	}

	const promise = runBatchGitStatus(cwd, containerId, opts).then(
		(result) => {
			const entry = gitStatusCache.get(key);
			if (entry && entry.promise === promise) {
				entry.result = result;
				entry.resolvedAt = Date.now();
			}
			return result;
		},
		(err) => {
			// Do NOT cache errors — next caller will retry fresh.
			const entry = gitStatusCache.get(key);
			if (entry && entry.promise === promise) gitStatusCache.delete(key);
			throw err;
		},
	);
	gitStatusCache.set(key, { promise, resolvedAt: 0, result: undefined });
	return promise;
}

/** Batched git status — host path uses native parallel execFile (no shell);
 *  container path keeps the legacy `docker exec sh -c <batch>` round-trip.
 *  Implementation lives in `./skills/git-status-native.ts`. Returns null if
 *  not a git repository. `partial` is reserved for a future degraded-mode
 *  flag and is currently always `false` on success. */
async function runBatchGitStatus(
	cwd: string,
	containerId?: string,
	opts?: { untracked?: boolean; configuredBaseRef?: string },
): Promise<GitStatusResult | null> {
	_runBatchGitStatusCount++;
	if (_gitStatusFake) return _gitStatusFake(cwd, containerId, opts);
	return runBatchGitStatusNative(cwd, { ...opts, containerId });
}

// ── Git diff / commit helpers (shared between session and goal endpoints) ──
const DIFF_MAX_BYTES = 500 * 1024; // 500KB
const COMMIT_LOG_FORMAT = "%H%x1f%h%x1f%s%x1f%an%x1f%aI";
const COMMIT_LOG_SEPARATOR = "\x1f";

type CommitChangedFile = {
	path: string;
	oldPath?: string;
	status: string;
	statusLabel: string;
};

type CommitInfo = {
	sha: string;
	shortSha: string;
	message: string;
	author: string;
	timestamp: string;
	filesChanged: number;
	insertions: number;
	deletions: number;
	files: CommitChangedFile[];
};

function isUnsafeGitPath(file: string): boolean {
	return !file
		|| file.includes("..")
		|| path.posix.isAbsolute(file)
		|| path.win32.isAbsolute(file)
		|| /^[a-zA-Z]:/.test(file);
}

function isValidCommitSha(commit: string): boolean {
	return /^[0-9a-fA-F]{4,40}$/.test(commit);
}

function statusLabelForCommitFile(status: string): string {
	switch (status) {
		case "M": return "modified";
		case "A": return "added";
		case "D": return "deleted";
		case "R": return "renamed";
		default: return status ? status.toLowerCase() : "unknown";
	}
}

function parseCommitChangedFiles(output: string): CommitChangedFile[] {
	return output.split("\n").map(line => line.trim()).filter(Boolean).flatMap((line): CommitChangedFile[] => {
		const parts = line.split("\t");
		const rawStatus = parts[0] || "";
		const status = rawStatus.startsWith("R") ? "R" : rawStatus;
		if (status === "R") {
			const oldPath = parts[1];
			const newPath = parts[2];
			if (!oldPath || !newPath) return [];
			return [{ path: newPath, oldPath, status, statusLabel: statusLabelForCommitFile(status) }];
		}
		const filePath = parts[1];
		if (!filePath) return [];
		return [{ path: filePath, status, statusLabel: statusLabelForCommitFile(status) }];
	});
}

async function assertCommitExists(cwd: string, commit: string, containerId?: string, commandRunner?: CommandRunner): Promise<void> {
	if (!isValidCommitSha(commit)) throw new Error("INVALID_COMMIT");
	try {
		await execGitArgs(["cat-file", "-e", `${commit}^{commit}`], cwd, 5000, containerId, commandRunner);
	} catch {
		throw new Error("INVALID_COMMIT");
	}
}

async function getCommitChangedFiles(cwd: string, sha: string, containerId?: string, commandRunner?: CommandRunner): Promise<CommitChangedFile[]> {
	await assertCommitExists(cwd, sha, containerId, commandRunner);
	const out = await execGitArgs(["show", "--format=", "--name-status", "--find-renames", sha], cwd, 10000, containerId, commandRunner);
	return parseCommitChangedFiles(out);
}

function parseCommitLogWithFiles(output: string): CommitInfo[] {
	const commits: CommitInfo[] = [];
	for (const record of output.split("\x1e")) {
		const lines = record.split(/\r?\n/).filter(Boolean);
		const metadata = lines.shift();
		if (!metadata) continue;
		const [sha, shortSha, message, author, timestamp] = metadata.split(COMMIT_LOG_SEPARATOR);
		if (!sha || !shortSha || timestamp === undefined) continue;

		const files: CommitChangedFile[] = [];
		let insertions = 0;
		let deletions = 0;
		for (const line of lines) {
			if (line.startsWith(":")) {
				const [rawMetadata, ...paths] = line.split("\t");
				const rawStatus = rawMetadata.trim().split(/\s+/).at(-1) ?? "";
				const status = rawStatus.startsWith("R") ? "R" : rawStatus;
				if (status === "R" && paths[0] && paths[1]) {
					files.push({ path: paths[1], oldPath: paths[0], status, statusLabel: statusLabelForCommitFile(status) });
				} else if (paths[0]) {
					files.push({ path: paths[0], status, statusLabel: statusLabelForCommitFile(status) });
				}
				continue;
			}
			const numstat = line.match(/^(\d+|-)\t(\d+|-)\t/);
			if (numstat) {
				if (numstat[1] !== "-") insertions += Number(numstat[1]);
				if (numstat[2] !== "-") deletions += Number(numstat[2]);
			}
		}
		commits.push({ sha, shortSha, message, author, timestamp, filesChanged: files.length, insertions, deletions, files });
	}
	return commits;
}

export async function getCommitsWithFiles(
	cwd: string,
	rangeArgs: string[],
	timeout = 5000,
	containerId?: string,
	commandRunner?: CommandRunner,
): Promise<CommitInfo[]> {
	// One real Git process returns metadata, statuses, renames, and numstat for
	// the whole page. The former N-commit fan-out launched `cat-file` + `show`
	// concurrently per commit; under full-suite contention one child could exceed
	// its timeout and turn an otherwise valid commits response into HTTP 500.
	const output = await execGitArgs([
		"log",
		`--format=%x1e${COMMIT_LOG_FORMAT}`,
		"--raw",
		"--numstat",
		"--find-renames",
		...rangeArgs,
	], cwd, timeout, containerId, commandRunner);
	return parseCommitLogWithFiles(output);
}

/**
 * The seven legacy top-level QA keys that have moved to per-component
 * `config:` maps. Rejected on PUT and stripped from GET responses as
 * defence in depth (state-migration removes them on boot).
 */
const LEGACY_QA_TOP_LEVEL_KEYS = [
	"qa_start_command",
	"qa_build_command",
	"qa_health_check",
	"qa_browser_entry",
	"qa_env",
	"qa_max_duration_minutes",
	"qa_max_scenarios",
] as const;

/**
 * Validate the per-component `config:` map (post-migration, opaque
 * key→string). Rules mirror the propose_project tool's runtime validator:
 *   - keys must be non-empty strings
 *   - values must be strings
 *   - max 100 entries per component
 *
 * Returns null on success, or a string error message suitable for HTTP 400.
 */
function validateComponentsConfig(components: unknown): string | null {
	if (!Array.isArray(components)) return null;
	for (const c of components) {
		if (!c || typeof c !== "object") continue;
		const cfg = (c as { config?: unknown }).config;
		if (cfg === undefined || cfg === null) continue;
		if (typeof cfg !== "object" || Array.isArray(cfg)) {
			return `components[${(c as { name?: unknown }).name ?? "?"}].config: must be an object`;
		}
		const entries = Object.entries(cfg as Record<string, unknown>);
		if (entries.length > 100) {
			return `components[${(c as { name?: unknown }).name ?? "?"}].config: too many entries (max 100, got ${entries.length})`;
		}
		for (const [k, v] of entries) {
			if (typeof k !== "string" || k.length === 0) {
				return `components[${(c as { name?: unknown }).name ?? "?"}].config: empty key`;
			}
			if (typeof v !== "string") {
				return `components[${(c as { name?: unknown }).name ?? "?"}].config.${k}: must be string, got ${typeof v}`;
			}
		}
	}
	return null;
}

export async function getGitDiff(cwd: string, file?: string, containerId?: string, commit?: string, commandRunner?: CommandRunner): Promise<string> {
	let hasHead = true;
	try { await execGit("git rev-parse --verify HEAD", cwd, 5000, containerId, commandRunner); } catch { hasHead = false; }

	let diff = "";
	if (commit) {
		if (!file || isUnsafeGitPath(file)) throw new Error("INVALID_PATH");
		await assertCommitExists(cwd, commit, containerId, commandRunner);
		const changedFiles = await getCommitChangedFiles(cwd, commit, containerId, commandRunner);
		const renamedFile = changedFiles.find(f => f.status === "R" && (f.path === file || f.oldPath === file));
		const pathspecs = renamedFile?.oldPath ? [renamedFile.oldPath, renamedFile.path] : [file];
		diff = await execGitArgs(["show", "--format=", "--find-renames", commit, "--", ...pathspecs], cwd, 10000, containerId, commandRunner);
	} else if (file) {
		// Sanitize: reject path traversal, absolute paths, drive letters
		if (isUnsafeGitPath(file)) {
			throw new Error("INVALID_PATH");
		}
		if (containerId) {
			// Run git diff inside container
			// Argument-vector execution — `file` is never parsed by a shell.
			if (hasHead) {
				diff = await execGitArgsSafe(["diff", "HEAD", "--", file], cwd, "", containerId, commandRunner);
			} else {
				diff = await execGitArgsSafe(["diff", "--cached", "--", file], cwd, "", containerId, commandRunner)
					+ await execGitArgsSafe(["diff", "--", file], cwd, "", containerId, commandRunner);
			}
			if (!diff.trim()) {
				diff = await execGitArgsSafe(["diff", "--no-index", "/dev/null", "--", file], cwd, "", containerId, commandRunner);
			}
		} else if (hasHead) {
			diff = await execGitArgs(["diff", "HEAD", "--", file], cwd, 5000, undefined, commandRunner);
		} else {
			diff = await execGitArgs(["diff", "--cached", "--", file], cwd, 5000, undefined, commandRunner)
				+ await execGitArgs(["diff", "--", file], cwd, 5000, undefined, commandRunner);
		}
		// Try untracked if empty (host path only — container path handled above)
		if (!diff.trim() && !containerId) {
			try {
				const devNull = process.platform === "win32" ? "NUL" : "/dev/null";
				diff = await execGitArgs(["diff", "--no-index", devNull, "--", file], cwd, 5000, undefined, commandRunner);
			} catch (e: any) {
				// git diff --no-index exits 1 when there are differences
				if (e.stdout) diff = String(e.stdout);
			}
		}
	} else {
		if (containerId) {
			if (hasHead) {
				diff = await execGitSafe("git diff HEAD", cwd, "", containerId, commandRunner);
			} else {
				diff = await execGitSafe("git diff --cached", cwd, "", containerId, commandRunner)
					+ await execGitSafe("git diff", cwd, "", containerId, commandRunner);
			}
		} else if (hasHead) {
			diff = await execGitArgs(["diff", "HEAD"], cwd, 5000, undefined, commandRunner);
		} else {
			diff = await execGitArgs(["diff", "--cached"], cwd, 5000, undefined, commandRunner)
				+ await execGitArgs(["diff"], cwd, 5000, undefined, commandRunner);
		}
	}

	if (!diff.trim()) throw new Error("NO_DIFF");

	if (Buffer.byteLength(diff, "utf-8") > DIFF_MAX_BYTES) {
		diff = diff.slice(0, DIFF_MAX_BYTES) + "\n\n--- Diff truncated (exceeded 500KB) ---";
	}
	return diff;
}

export interface TlsConfig {
	cert: string;  // path to PEM certificate
	key: string;   // path to PEM private key
	caCert?: string;  // path to CA certificate (for mkcert-based certs)
}

export interface GatewayConfig {
	host: string;
	port: number;
	portExplicit?: boolean;
	authToken: string;
	defaultCwd: string;
	staticDir?: string;
	agentCliPath?: string;
	systemPromptPath?: string;
	tls?: TlsConfig;
	/** Force auth even on localhost (used by E2E tests). */
	forceAuth?: boolean;
	/** Runtime boundary flag for legacy BOBBIT_SKIP_MCP behavior. */
	skipMcp?: boolean;
	/** Runtime boundary flag for legacy BOBBIT_SKIP_WORKTREE_POOL behavior. */
	skipWorktreePool?: boolean;
	/** Runtime boundary flag for legacy BOBBIT_SKIP_TITLE_GEN behavior. */
	skipTitleGeneration?: boolean;
	/** Runtime boundary flag for legacy BOBBIT_TEST_NO_PUSH behavior. */
	skipRemotePush?: boolean;
	/** Runtime boundary flag for legacy BOBBIT_TEST_NO_REMOTE/BOBBIT_TEST_NO_EXTERNAL behavior. */
	skipNonLocalRemoteGit?: boolean;
	/**
	 * Override for the builtin `defaults/` tree. Defaults to undefined, in which
	 * case BuiltinConfigProvider uses its dist-relative default. Used by the v2
	 * test harness to point a src-booted gateway at the repo-root `defaults/`.
	 */
	builtinsDir?: string;
	/**
	 * Override for the builtin packs (`market-packs/`) dir. Defaults to undefined,
	 * in which case resolveBuiltinPacksDir uses its dist-relative default. Used by
	 * the v2 test harness to point a src-booted gateway at repo-root `market-packs/`.
	 */
	builtinPacksDir?: string;
}

export function installGatewayBridgeDeps(deps?: GatewayDeps) {
	const hasExplicitAgentBridgeFactory = !!deps?.agentBridgeFactory;
	const previousRpcBridgeFactory = hasExplicitAgentBridgeFactory ? getRegisteredRpcBridgeFactory() : null;
	if (deps?.agentBridgeFactory) registerRpcBridgeFactory(deps.agentBridgeFactory);
	const registeredRpcBridgeFactory = getRegisteredRpcBridgeFactory();
	const gatewayDeps = resolveGatewayDeps({
		...deps,
		agentBridgeFactory: deps?.agentBridgeFactory ?? registeredRpcBridgeFactory ?? undefined,
	});
	let restored = false;
	return {
		gatewayDeps,
		restoreExplicitRpcBridgeFactory(): void {
			if (!hasExplicitAgentBridgeFactory || restored) return;
			restored = true;
			registerRpcBridgeFactory(previousRpcBridgeFactory);
		},
	};
}

export function createGateway(config: GatewayConfig, deps?: GatewayDeps) {
	// Construction checkpoint timer — createGateway runs fully synchronously
	// before start(), and earlier profiling showed ~19s of unattributed time
	// here. Log cumulative elapsed at each major subsystem so the heavy step is
	// visible. Cheap; best-effort file tee via bootLog.
	const __ckT0 = Date.now();
	let __ckLast = __ckT0;
	const ck = (label: string): void => {
		const now = Date.now();
		const delta = now - __ckLast;
		__ckLast = now;
		if (delta >= SLOW_PHASE_MS) bootLog(`[boot] ctor ${label} +${delta}ms (@${now - __ckT0}ms)`);
	};
	const { gatewayDeps, restoreExplicitRpcBridgeFactory } = installGatewayBridgeDeps(deps);
	serverCommandRunner = gatewayDeps.commandRunner;
	const envRuntimeFlags = resolveLegacyTestRuntimeFlags();
	const gatewayRuntimeFlags = {
		...envRuntimeFlags,
		skipRemotePush: config.skipRemotePush ?? envRuntimeFlags.skipRemotePush,
		skipNonLocalRemoteGit: config.skipNonLocalRemoteGit ?? envRuntimeFlags.skipNonLocalRemoteGit,
		skipMcp: config.skipMcp ?? envRuntimeFlags.skipMcp,
		skipWorktreePool: config.skipWorktreePool ?? envRuntimeFlags.skipWorktreePool,
		skipTitleGeneration: config.skipTitleGeneration ?? envRuntimeFlags.skipTitleGeneration,
	};
	config = {
		...config,
		skipRemotePush: gatewayRuntimeFlags.skipRemotePush,
		skipNonLocalRemoteGit: gatewayRuntimeFlags.skipNonLocalRemoteGit,
		skipMcp: gatewayRuntimeFlags.skipMcp,
		skipWorktreePool: gatewayRuntimeFlags.skipWorktreePool,
		skipTitleGeneration: gatewayRuntimeFlags.skipTitleGeneration,
	};
	const remoteGitPolicy: RemoteGitPolicy = {
		skipRemotePush: gatewayRuntimeFlags.skipRemotePush,
		skipNonLocalRemoteGit: gatewayRuntimeFlags.skipNonLocalRemoteGit,
		e2eTmpRoot: gatewayRuntimeFlags.e2eTmpRoot,
	};
	serverRemoteGitPolicy = remoteGitPolicy;
	serverRuntimeFlags = { e2e: gatewayRuntimeFlags.e2e, testNoExternal: gatewayRuntimeFlags.testNoExternal };
	const worktreeSetupRuntime = {
		skipNpmCi: gatewayRuntimeFlags.skipNpmCi,
		recordSetupPath: gatewayRuntimeFlags.testRecordSetup,
	};
	configureProfilingRuntime({ e2eProfile: gatewayRuntimeFlags.e2eProfile, e2eProfileFlushMs: gatewayRuntimeFlags.e2eProfileFlushMs });
	configureAigwRuntimeFlags({ skipAigwDiscovery: gatewayRuntimeFlags.skipAigwDiscovery, testNoExternal: gatewayRuntimeFlags.testNoExternal, e2e: gatewayRuntimeFlags.e2e });

	const stateDir = bobbitStateDir();
	const configDir = bobbitConfigDir();
	migrateLegacyHeadquartersDirectory({
		serverRunDir: getProjectRoot(),
		headquartersDir: bobbitDir(),
		headquartersStateDir: stateDir,
		headquartersConfigDir: configDir,
		legacyServerBobbitDir: path.join(getProjectRoot(), ".bobbit"),
	});
	// Non-destructively seed model-default preference keys from the legacy
	// .bobbit/state/preferences.json into the headquarters state dir. This
	// covers the case where BOBBIT_DIR points to a fresh directory (the
	// migrateLegacyHeadquartersDirectory call above skips the legacy copy when
	// an override is active) as well as first-ever installs.
	seedModelDefaultsFromLegacy({
		headquartersStateDir: stateDir,
		serverRunDir: getProjectRoot(),
	});
	fs.mkdirSync(stateDir, { recursive: true });
	// Ensure API-only/test gateways also get a startup-resolved agent dir even when
	// they do not enter through cli.ts. This is a no-op after CLI initialization.
	globalAgentDir();
	if (cpuDiagnosticsEnabled()) getCpuDiagnostics(gatewayDeps.clock);

	// Initialize module-level caches for parameterized modules
	initPromptDirs(stateDir);
	initSkillSidecarDir(stateDir);
	initCompactionSidecarDir(stateDir);
	initAssistantRegistry(configDir);

	// Project registry — persisted at server level. Every server exposes the
	// built-in Headquarters project as the user-facing server workspace.
	const projectRegistry = new ProjectRegistry(stateDir);

	// Register the synthetic "system" project so system-scope tool-assistant
	// sessions have a valid persistence anchor without forcing the user to
	// register a real project. Idempotent — hidden from UI listings via the
	// `hidden: true` filter on GET /api/projects.
	//
	// Anchor at a dedicated subdir under bobbitDir so the ProjectContext's
	// derived stateDir (`<rootPath>/.bobbit/state`) cannot collide with any
	// user project rooted at the install dir or with the global stateDir —
	// otherwise the system context would load the same goals.json/sessions.json
	// as a user project rooted at getProjectRoot() (e.g. test fixtures).
	try {
		const systemRoot = path.join(stateDir, "system-project");
		fs.mkdirSync(systemRoot, { recursive: true });
		projectRegistry.registerSystemProject(systemRoot);
	} catch (err) {
		console.warn(`[startup] Failed to register system project: ${err}`);
	}

	try {
		projectRegistry.ensureHeadquartersProject(bobbitDir(), { stateDir, configDir });
	} catch (err) {
		console.warn(`[startup] Failed to register Headquarters project: ${err}`);
	}

	// Run one-time migration from centralized to per-project state
	ck("pre-migration-setup");
	migrateToPerProjectState(stateDir, projectRegistry, getProjectRoot(), { centralConfigDir: configDir });
	ck("migrateToPerProjectState");

	// Recover data lost by the original migration bug (unconditional rename
	// when central dir == default project dir). Must run before stores load.
	recoverPreMigrationData(stateDir);
	ck("recoverPreMigrationData");

	// One-shot project.yaml migration: synthesize components[] for legacy
	// single-repo projects. Idempotent. Must run BEFORE ProjectContext
	// instantiation so ProjectConfigStore.load() picks up the new shape,
	// and BEFORE the worktree pool fills.
	migrateAllProjectYaml(
		projectRegistry.list().map(p => ({ id: p.id, name: p.name, rootPath: p.rootPath })),
	);
	ck("migrateAllProjectYaml");

	const projectConfigStore = new ProjectConfigStore(configDir, gatewayDeps.fsImpl);

	// Initialize per-project contexts. Headquarters shares the server-scope
	// ProjectConfigStore so server/HQ writes cannot stale-read or clobber.
	const projectContextManager = new ProjectContextManager(projectRegistry, {
		headquartersProjectConfigStore: projectConfigStore,
		fsImpl: gatewayDeps.fsImpl,
		clock: gatewayDeps.clock,
		commandRunner: gatewayDeps.commandRunner,
		remotePolicy: remoteGitPolicy,
		worktreeSetupRuntime,
	});
	projectContextManager.initAll();
	ck("initAll");

	// Migrate inline token values from project.yaml → secrets.json (one-time)
	for (const p of projectRegistry.list()) {
		const ctx = projectContextManager.getOrCreate(p.id);
		if (!ctx) continue;
		const tokens = ctx.projectConfigStore.getSandboxTokens();
		// getSandboxTokens() never includes `value` (typed accessor strips it).
		// We need the raw values, which are still on the in-memory side-table
		// after load() but only accessible via the back-compat flat get().
		const tokensRaw = ctx.projectConfigStore.get("sandbox_tokens");
		if (!tokensRaw) continue;
		try {
			const arr = JSON.parse(tokensRaw);
			if (!Array.isArray(arr)) continue;
			const hasValues = arr.some((e: any) => e.value);
			if (!hasValues) {
				// No inline values to migrate. Only force a rewrite when the
				// on-disk format was legacy JSON-string (isDirty() is set during
				// load()). Without this guard we save() on every server start,
				// which re-flows multi-line workflow strings through
				// yaml.stringify and produces a noisy diff every restart.
				if (ctx.projectConfigStore.isDirty()) {
					ctx.projectConfigStore.setSandboxTokens(tokens);
				}
				continue;
			}
			// Move values to secrets store
			const secretUpdates: Record<string, string> = {};
			for (const e of arr) {
				if (e.value) secretUpdates[e.key] = e.value;
			}
			ctx.secretsStore.update(secretUpdates);
			// Strip values from config (write structured form, no JSON-encoded string).
			ctx.projectConfigStore.setSandboxTokens(
				arr.map((e: any) => ({ key: e.key, enabled: e.enabled !== false })),
			);
			console.log(`[migration] Moved ${Object.keys(secretUpdates).length} token secret(s) to secrets.json for project ${ctx.project.id}`);
		} catch { /* ignore parse errors */ }
	}

	ck("token-migration-loop");
	const colorStore = new ColorStore(stateDir);
	const prStatusStore = new PrStatusStore(stateDir, gatewayDeps.fsImpl);
	const preferencesStore = new PreferencesStore(stateDir, gatewayDeps.fsImpl);
	const reviewAnnotationStore = new ReviewAnnotationStore(stateDir, gatewayDeps.fsImpl);
	const savedCwd = preferencesStore.get("defaultCwd");
	if (savedCwd && typeof savedCwd === "string") {
		config.defaultCwd = savedCwd;
	}
	const roleStore = new RoleStore(configDir);
	const roleManager = new RoleManager(roleStore);
	const toolManager = new ToolManager(configDir);
	ck("stores-pre-tooldocs");
	toolManager.generateDetailDocs(stateDir);
	ck("generateDetailDocs");
	// Extension host (design docs/design/extension-host.md §4b): the action
	// dispatcher lives for the gateway process lifetime; its module cache is
	// dropped synchronously by invalidateResolverCaches() on pack mutations.
	// Slice C3: ONE shared confined worker host (server-module isolation, design §9)
	// threaded into BOTH dispatchers — every pack action/route handler runs through
	// `ModuleHost.invoke` in a terminate-able worker with empty env + a module-load
	// deny-hook + memory caps. Isolation is UNCONDITIONAL: there is no config flag or
	// env var that runs a pack server module in-process (no in-process seam exists).
	const moduleHost = new ModuleHost();
	const actionDispatcher = new ActionDispatcher(toolManager, { moduleHost });
	// Slice B3: the route dispatcher (mirrors actionDispatcher) + the pack-level route
	// registry. Both live for the gateway process lifetime; both caches are dropped by
	// invalidateResolverCaches() on pack install/update/uninstall (rebuilds the index).
	const routeDispatcher = new RouteDispatcher({ moduleHost });
	// pack-schema-v1 §5.2/§5.3: the pack-contribution registry + the route registry
	// built off it are constructed AFTER the market-pack provider + activation store
	// wiring below (they enumerate via the same marketPackProvider).
	let routeRegistry!: RouteRegistry;
	let packContributionRegistry!: PackContributionRegistry;
	let extensionChannelServices: ExtensionChannelServices | undefined;
	let extensionChannelServicesInit: Promise<ExtensionChannelServices | undefined> | undefined;
	// Slice B1: warm the process-singleton pack store (file-backed, pack-namespaced
	// persistence behind `host.store.*` + the /api/ext/store/:op endpoint).
	getPackStore();
	ck("getPackStore");
	const groupPolicyStore = new ToolGroupPolicyStore(configDir);
	const sandboxTokenStore = new SandboxTokenStore();
	const cookieSigningKey = loadOrCreateCookieSigningKey(serverSecretsDir());
	const cookieStore = new CookieStore(cookieSigningKey, { clock: gatewayDeps.clock });
	const sessionManager = new SessionManager({
		stateDir,
		agentCliPath: config.agentCliPath,
		systemPromptPath: config.systemPromptPath,
		colorStore,
		roleManager,
		toolManager,
		preferencesStore,
		projectConfigStore,
		groupPolicyStore,
		projectContextManager,
		prStatusStore,
		clock: gatewayDeps.clock,
		commandRunner: gatewayDeps.commandRunner,
		skipTitleGeneration: gatewayRuntimeFlags.skipTitleGeneration,
		remoteGitPolicy,
		testPreparingDelayMs: gatewayRuntimeFlags.testPreparingDelayMs,
		worktreeSetupRuntime,
	});
	sessionManager.sandboxTokenStore = sandboxTokenStore;

	// Wire sessionManager into the project context manager so the search
	// orphan filter can resolve sessions across projects (live, dormant,
	// archived). The registry is already passed via the constructor.
	projectContextManager.setDependencies({ sessionManager });
	// Wire gate status changes to bump goal generation for all project contexts.
	for (const ctx of projectContextManager.all()) {
		wireGateStatusGenerationInvalidation(ctx.gateStore, ctx.goalStore);
	}

	const builtinConfigProvider = new BuiltinConfigProvider(config.builtinsDir);
	ck("stores+SessionManager");
	// Wire builtin defaults into stores (in-memory only, no disk writes).
	// Direct store lookups (roleStore.get()) transparently fall back to
	// builtins, so no seeding to disk is needed. Workflows are project-
	// scoped only — no system layer, no builtin layer.
	roleStore.setBuiltins(builtinConfigProvider.getRoles());
	groupPolicyStore.setBuiltins(builtinConfigProvider.getToolGroupPolicies());
	// Wire the system-scope Subgoals feature gate into the policy cascade.
	// Without this, getSubgoalsEnabled() returns false unconditionally and
	// every tool in the `Children` group (goal_spawn_child, goal_merge_child,
	// goal_pause, goal_resume, goal_plan_propose, goal_set_policy,
	// goal_archive_child, goal_plan_status, goal_decide_mutation) resolves to
	// `never` at policy time — silently dropped from every team-lead's tool
	// surface. See docs/design/subgoals-experimental-toggle.md.
	// Production deviation from PR #497: subgoals default ON — unset reads as enabled.
	groupPolicyStore.setSubgoalsEnabledGetter(() => preferencesStore.get("subgoalsEnabled") === true);

	const configCascade = new ConfigCascade(builtinConfigProvider, {
		getRoles: () => roleStore.getAllLocal(),
		getTools: () => toolManager.getLocalTools(),
		getToolGroupPolicies: () => groupPolicyStore.getAll(),
	}, projectContextManager);
	// Keep the cascade's first-party pack band aligned with the runtime tool loader
	// (buildMarketToolRootsForProject below also resolves via config.builtinPacksDir).
	// Passing the identical resolved dir prevents a split-brain where a shipped pack
	// tool exists at runtime but is missing from the cascade (surfacing as origin
	// "mcp"). Production passes undefined ⇒ same dist default the constructor uses.
	configCascade.setBuiltinPacksDir(resolveBuiltinPacksDir(config.builtinPacksDir));
	sessionManager.configCascade = configCascade;
	const resolveRoleForProject = (roleId: string, projectId?: string): Role | undefined => {
		const cascadeRole = configCascade.resolveRoles(projectId).find(r => r.item.name === roleId)?.item;
		return cascadeRole ?? roleManager.getRole(roleId);
	};
	(roleManager as RoleManager & { resolveRoleForProject?: typeof resolveRoleForProject }).resolveRoleForProject = resolveRoleForProject;

	// ── Pack-Based Marketplace (single resolver over installed packs) ──────
	// Sources are global to the server; the cache + sources file live under
	// the server scope. Install/resolve derive market-pack roots from a per-
	// scope `base` via scopePaths() (design §1.3.1). Server/HQ base is the
	// physical Headquarters directory, global-user is the home dir, project is
	// each project's rootPath.
	const marketplaceSourceStore = new MarketplaceSourceStore(configDir, gatewayDeps.fsImpl);
	const marketplaceInstaller = new MarketplaceInstaller({
		sourceStore: marketplaceSourceStore,
		cacheRoot: path.join(bobbitStateDir(), "marketplace-cache"),
		serverBase: headquartersDir(),
		globalUserBase: os.homedir(),
	});
	// Resolve the on-disk base + pack_order store for an install scope.
	const marketScopeContext = (scope: InstallScope, projectId?: string): { base: string; store: PackOrderStore } | null => {
		const effectiveProjectId = normalizeConfigProjectId(projectId);
		if (scope === "server") return { base: headquartersDir(), store: projectConfigStore };
		if (scope === "global-user") return { base: os.homedir(), store: projectConfigStore };
		// project. Headquarters is the user-facing server scope, so it intentionally
		// has no independent project-scope market pack layer.
		if (!effectiveProjectId) return null;
		const ctx = projectContextManager.getOrCreate(effectiveProjectId);
		if (!ctx) return null;
		return { base: ctx.project.rootPath, store: ctx.projectConfigStore };
	};
	// Feed installed market packs into the roles/tools cascade (design §3.2).
	const marketPackProvider: MarketPackProvider = {
		marketEntries(scope, projectId) {
			const sc = marketScopeContext(scope as InstallScope, projectId);
			if (!sc) return [];
			return scopeMarketPackEntries(scope as PackScope, sc.base, sc.store.getPackOrder(scope));
		},
	};
	configCascade.setMarketPackProvider(marketPackProvider);

	// Ordered installed market-pack `tools/` roots (low→high) for a project, so
	// market-pack tools are listed, documented, provider-loaded, and usable at
	// runtime — not just surfaced by the cascade listing (design §3.2 / finding
	// #1). Mirrors the cascade scope order (server < global-user < project) and
	// dedups self-managed-project path collisions, keeping the FIRST (lowest)
	// scope, exactly as `ConfigCascade.resolveEntities` does.
	// Each root carries its pack's pack_activation `disabledTools` list at the
	// resolving scope (pack-schema-v1 §7), so runtime resolution drops disabled
	// pack tools and reinstates a lower-priority shadow EXACTLY as the cascade
	// listing does — no split-brain between `/api/tools` and the renderer/action/
	// surface-token/prompt-doc paths. `packActivationStore` is the SAME store the
	// cascade reads (defined just below; referenced lazily at request time).
	const marketToolRoots = (projectId?: string): MarketToolRoot[] => {
		const effectiveProjectId = normalizeConfigProjectId(projectId);
		const builtinPacksDir = resolveBuiltinPacksDir(config.builtinPacksDir);
		const activationForBuiltin = (packName: string) =>
			packActivationStore(BUILTIN_PACK_SCOPE, undefined)?.getPackActivation(BUILTIN_PACK_SCOPE, packName);
		const builtinEntries = builtinFirstPartyPackEntries(builtinPacksDir);
		return buildMarketToolRootsForProject({
			projectId: effectiveProjectId,
			// Built-in band feeds CONTRIBUTION resolution — drop ships-disabled packs
			// (e.g. pr-walkthrough default-OFF) so their tool groups never resolve.
			builtinEntries: builtinEntries.filter((entry) =>
				isPackEffectivelyEnabled(entry.manifest, entry.manifest ? activationForBuiltin(entry.manifest.name) : undefined),
			),
			// Keep whole disabled/default-off pack roots classified for quiet activation
			// diagnostics, without registering any contained tools as active providers.
			inactiveBuiltinEntries: builtinEntries.filter((entry) =>
				!isPackEffectivelyEnabled(entry.manifest, entry.manifest ? activationForBuiltin(entry.manifest.name) : undefined),
			),
			marketEntries: (scope, pid) => marketPackProvider.marketEntries(scope, pid),
			disabledTools: (scope, pid, packName) => packActivationStore(scope, pid)?.getPackActivation(scope, packName).tools,
		});
	};
	// Server-level toolManager (used by GET /api/tools/:name without a project)
	// sees server + global-user market packs (project scope needs a projectId).
	toolManager.setMarketToolRootsProvider(() => marketToolRoots(undefined));
	// Every per-project context's toolManager sees its full cross-scope market
	// roots (server < global-user < project) — applied to existing + future ctxs.
	projectContextManager.setContextConfigurator((ctx) => {
		ctx.toolManager.setMarketToolRootsProvider(() => marketToolRoots(ctx.project.id));
		// Goal-metadata lifecycle wiring: connect this project's GoalManager to the
		// shared LifecycleHub `goalProvisioned` dispatcher so every worktree
		// provisioning in the goal subtree fans out to extension providers with the
		// resolved (hierarchically inherited) metadata. Feature-detected on BOTH
		// ends — the setter is contributed by the goal-metadata data/provisioning
		// slice and `dispatchGoalProvisioned` by the lifecycle slice — so this is a
		// no-op until those land, then activates automatically. The hub is read
		// lazily (it is constructed after this configurator is registered).
		const gm = ctx.goalManager as unknown as {
			setGoalProvisionedDispatcher?: (
				fn: (dctx: { goalId: string; projectId?: string; worktreePath: string; cwd: string; branch?: string; metadata: Record<string, unknown> }) => Promise<void>,
			) => void;
		};
		if (typeof gm.setGoalProvisionedDispatcher === "function") {
			gm.setGoalProvisionedDispatcher(async (dctx) => {
				const hub = sessionManager.lifecycleHub as unknown as {
					dispatchGoalProvisioned?: (c: typeof dctx) => Promise<void>;
				} | undefined;
				if (hub && typeof hub.dispatchGoalProvisioned === "function") {
					await hub.dispatchGoalProvisioned(dctx);
				}
			});
		}
	});

	// pack-schema-v1 §6.7: resolve the pack_activation store for a scope+project.
	// `server`/`global-user` overrides live in the server config; `project` in the
	// project config (same split as pack_order).
	const packActivationStore = (scope: PackScope, projectId?: string): ProjectConfigStore | null => {
		const effectiveProjectId = normalizeConfigProjectId(projectId);
		if (scope === "server" || scope === "global-user") return projectConfigStore;
		if (scope === "project") {
			if (!effectiveProjectId) return null;
			return projectContextManager.getOrCreate(effectiveProjectId)?.projectConfigStore ?? null;
		}
		return null;
	};

	// pack-schema-v1 §5.2: enumerate installed market-pack ENTRIES (low→high,
	// deduped-on-path) for a project — the registry collapses to the winning pack
	// per packId before indexing.
	const marketPackEntriesForProject = (projectId?: string): PackEntry[] => {
		const effectiveProjectId = normalizeConfigProjectId(projectId);
		const out: PackEntry[] = [];
		const seen = new Set<string>();
		// Built-in first-party band (built-in-first-party-packs §7.5): the shipped
		// packs are NOT installed, so they must be injected here or their
		// panels/entrypoints/routes never register. Push FIRST (lowest priority),
		// deduped by resolved path with the same `seen` set, so a user-installed
		// same-name pack (pushed later from a scope band) still wins when the
		// registry collapses to one winning pack per packId.
		// Built-in band feeds CONTRIBUTION resolution (providers/entrypoints/routes/
		// mcp/pi) via PackContributionRegistry — drop ships-disabled packs
		// (pr-walkthrough default-OFF) so nothing registers until explicitly enabled.
		for (const e of activeBuiltinFirstPartyPackEntries(
			resolveBuiltinPacksDir(config.builtinPacksDir),
			(packName) => packActivationStore(BUILTIN_PACK_SCOPE, undefined)?.getPackActivation(BUILTIN_PACK_SCOPE, packName),
		)) {
			const key = path.resolve(e.path);
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(e);
		}
		for (const scope of ["server", "global-user", "project"] as const) {
			for (const e of marketPackProvider.marketEntries(scope, effectiveProjectId)) {
				const key = path.resolve(e.path);
				if (seen.has(key)) continue;
				seen.add(key);
				out.push(e);
			}
		}
		return out;
	};
	const marketplaceMcpResolver: MarketplaceMcpResolver = (scope) => {
		const contributions: ResolvedMcpContribution[] = [];
		const projectId = normalizeConfigProjectId(scope.projectId);
		for (const entry of marketPackEntriesForProject(projectId)) {
			if (entry.scope === "builtin" || !entry.manifest || (entry.manifest.contents.mcp ?? []).length === 0) continue;
			const store = packActivationStore(entry.scope, projectId);
			const activation = store?.getPackActivation(entry.scope as PackOrderScope, entry.manifest.name) ?? {};
			const disabled = new Set(activation.mcp ?? []);
			const disabledOperations = activation.mcpOperations ?? {};
			const metaDetails = readYamlMapping(path.join(entry.path, ".pack-meta.yaml")) ?? {};
			const fallbackSourceId = entry.meta?.sourceUrl ? marketplaceSourceStore.getByUrl(entry.meta.sourceUrl)?.id : undefined;
			try {
				for (const mcp of loadPackContributions(entry.path, entry.manifest).mcp ?? []) {
					const contributionId = activationMcpContributionId(entry, mcp, metaDetails, fallbackSourceId);
					if (disabled.has(contributionId) || disabled.has(mcp.listName)) continue;
					const disabledOps = [...new Set([...(disabledOperations[contributionId] ?? []), ...(disabledOperations[mcp.listName] ?? [])])];
					const disabledOpsSet = new Set(disabledOps);
					const operationMetadata = operationMetadataForMcpContribution(mcp, metaDetails);
					const selectedOperations = metaDetails.sourceType === "mcp-gateway" && operationMetadata.length > 0
						? operationMetadata.map((op) => op.name).filter((name) => !disabledOpsSet.has(name))
						: (mcp.selectedOperations ? mcp.selectedOperations.filter((name) => !disabledOpsSet.has(name)) : undefined);
					contributions.push({
						listName: mcp.listName,
						serverName: mcp.serverName,
						...(metaDetails.sourceType === "mcp-gateway" ? { runtimeServerKey: gatewayMcpRuntimeKey(entry, mcp, metaDetails), contributionId } : (mcp.runtimeServerKey ? { runtimeServerKey: mcp.runtimeServerKey } : {})),
						...(mcp.subNamespace ? { subNamespace: mcp.subNamespace } : {}),
						...(selectedOperations !== undefined ? { selectedOperations } : {}),
						...(disabledOps.length > 0 ? { disabledOperations: disabledOps } : {}),
						config: mcp.config,
						origin: {
							scope: entry.scope,
							packName: entry.manifest.name,
							packId: entry.id,
							path: mcp.sourceFile,
							...(entry.meta?.sourceUrl ? { sourceUrl: entry.meta.sourceUrl } : {}),
						},
					});
				}
			} catch (err) {
				console.warn(`[mcp] failed to load Marketplace MCP contributions from ${entry.path}:`, (err as Error).message);
			}
		}
		return contributions;
	};
	const marketplacePiExtensionDiscoveryTrusted = (entry: PackEntry): boolean => {
		if (entry.scope === "builtin") return true;
		const sourceUrl = entry.meta?.sourceUrl;
		if (!sourceUrl) return true;
		const source = marketplaceSourceStore.getByUrl(sourceUrl);
		return typeof source?.trustedAt === "string" && source.trustedAt.trim().length > 0;
	};
	const marketplacePiExtensionResolver: MarketplacePiExtensionResolver = (scope) => {
		const contributions: ResolvedPiExtensionContribution[] = [];
		const projectId = normalizeConfigProjectId(scope.projectId);
		const scopedContext = piExtensionToolScopeContext(scope);
		for (const entry of marketPackEntriesForProject(projectId)) {
			if (!entry.manifest || (entry.manifest.schema ?? 1) < 2 || (entry.manifest.contents.piExtensions ?? []).length === 0) continue;
			const manifest = entry.manifest;
			const store = packActivationStore(entry.scope, projectId);
			const disabled = new Set(store?.getPackActivation(entry.scope as PackOrderScope, manifest.name).piExtensions ?? []);
			const origin = {
				scope: entry.scope,
				packName: manifest.name,
				packId: entry.id,
				...(entry.meta?.sourceUrl ? { sourceUrl: entry.meta.sourceUrl } : {}),
			};
			try {
				const trustAccepted = marketplacePiExtensionDiscoveryTrusted(entry);
				const staticRows = loadPiExtensionContributionsFromRuntime(entry.path, manifest).map((piExtension) => {
					if (disabled.has(piExtension.listName)) {
						return {
							...piExtension,
							origin,
							diagnostic: piExtensionDiagnostic("disabled", "disabled_by_activation", `Pi extension "${piExtension.listName}" is disabled for pack "${manifest.name}".`),
						};
					}
					return { ...piExtension, origin };
				});
				const discoveryKey = [
					scopedContext.scopeKey,
					entry.scope,
					entry.id,
					path.resolve(entry.path),
					entry.meta?.updatedAt ?? entry.meta?.installedAt ?? "",
					entry.meta?.sourceUrl ?? "",
					trustAccepted ? "trusted" : "untrusted",
					[...disabled].sort().join(","),
					staticRows.map((row) => `${row.listName}:${row.entryPath ?? ""}:${row.discovery?.cacheKey ?? ""}:${row.discovery?.diagnostic?.code ?? ""}`).join("|"),
				].join("\0");
				let rows = piExtensionDiscoveryCache.get(discoveryKey)?.rows;
				if (!rows) {
					const shouldResolveDiscovery = staticRows.some((row) => row.entryPath && row.diagnostic.status !== "disabled" && row.diagnostic.status !== "unresolved" && row.discovery.status !== "failed");
					rows = shouldResolveDiscovery
						? loadPiExtensionContributionsWithDiscoverySyncFromRuntime(entry.path, manifest, {
							trustAccepted,
							origin,
							disabledRefs: disabled,
						})
						: staticRows;
					piExtensionDiscoveryCache.set(discoveryKey, { rows });
				}
				for (const resolved of rows) {
					if (!resolved.entryPath || resolved.diagnostic.status === "unresolved") {
						console.warn(`[pi-extension] Marketplace pi extension ${manifest.name}/${resolved.listName} could not be resolved: ${resolved.diagnostic.message}`);
					}
					contributions.push(resolved);
				}
			} catch (err) {
				console.warn(`[pi-extension] failed to load Marketplace pi extension contributions from ${entry.path}:`, (err as Error).message);
			}
		}
		toolManager.setScopedPiExtensionTools(scopedContext, piExtensionExternalTools(contributions));
		return contributions;
	};
	sessionManager.setMarketplaceMcpResolver(marketplaceMcpResolver);
	sessionManager.setMarketplacePiExtensionResolver(marketplacePiExtensionResolver);
	packContributionRegistry = new PackContributionRegistry(
		marketPackEntriesForProject,
		(scope, projectId, packName) => packActivationStore(scope as PackScope, projectId)?.getPackActivation(scope as PackOrderScope, packName).entrypoints ?? [],
		(scope, projectId, packName) => packActivationStore(scope as PackScope, projectId)?.getPackActivation(scope as PackOrderScope, packName).providers ?? [],
		// Config-gated provider activation + effective-config overlay: read the
		// provider's PERSISTED flat config (written by the pack's `config` route to
		// the pack-scoped store under providerConfigStoreKey) synchronously, so a
		// provider declaring `activation.requiresConfig` stays dormant until it is
		// configured. packId scopes the store; scope/project are accepted for parity
		// with the activation lookups (provider config is pack-global in external mode).
		(_scope, _projectId, packId, providerId) => {
			if (!packId) return undefined;
			const persisted = getPackStore().getSync<Record<string, unknown>>(packId, providerConfigStoreKey(providerId));
			return persisted && typeof persisted === "object" ? persisted : undefined;
		},
	);
	sessionManager.lifecycleHub = new LifecycleHub({
		registry: packContributionRegistry,
		moduleHost,
		trace: new ContextTraceStore(bobbitStateDir(), gatewayDeps.fsImpl),
		// Hierarchical goal-metadata resolver. The hub is shared across projects
		// while each GoalStore is per ProjectContext, so route STRICTLY by goalId
		// (never the caller-supplied projectId, which may be stale/cross-project).
		// Resolves to {} for missing/unknown goals so provider/bridge filtering is
		// a guaranteed no-op when metadata is absent.
		goalMetadataResolver: (goalId: string | undefined, _projectId?: string): Record<string, unknown> => {
			if (!goalId) return {};
			const ctx = projectContextManager.getContextForGoal(goalId);
			if (!ctx) {
				console.warn(`[goal-metadata] no project context owns goal ${goalId}; resolving to {}`);
				return {};
			}
			return ctx.goalManager.getEffectiveGoalMetadata(goalId);
		},
		// Least-privilege, store-only host for provider hooks (capabilities.store ===
		// true; session/agents denied) — gives a provider its own pack-scoped durable
		// store via the same parent-authorized path routes use.
		providerHostApi: ({ sessionId, packId }) => createServerHostApi({
			sessionId,
			packId,
			contributionId: "",
			packStore: getPackStore(),
			capabilityMask: { store: true, session: false, agents: false },
		}),
		gatewayInfo: () => {
			try {
				const baseUrl = process.env.BOBBIT_GATEWAY_URL || fs.readFileSync(path.join(bobbitStateDir(), "gateway-url"), "utf-8").trim();
				// Secrets moved to serverSecretsDir() after the S1 relocation; readToken()
				// is relocation-aware (new location + legacy fallback), so a fresh install
				// with no legacy token still resolves instead of ENOENT-ing.
				const token = readToken() ?? "";
				return { baseUrl, token };
			} catch {
				return { baseUrl: "", token: "" };
			}
		},
	});
	routeRegistry = new RouteRegistry(packContributionRegistry);
	const initExtensionChannelsOnce = async (): Promise<ExtensionChannelServices | undefined> => {
		if (extensionChannelServices) return extensionChannelServices;
		if (!extensionChannelServicesInit) {
			extensionChannelServicesInit = instantiateExtensionChannelServices({
				packContributionRegistry,
				sessionManager,
				projectContextManager,
				toolManager,
			}).then((services) => {
				extensionChannelServices = services;
				sessionManager.setExtensionChannelServices(services);
				return services;
			});
		}
		return extensionChannelServicesInit;
	};

	// pack-schema-v1 §7: feed pack_activation into the roles/tools cascade so a
	// disabled entity is dropped BEFORE precedence merge (a shadow may reappear).
	configCascade.setPackActivationProvider({
		disabled(scope, projectId, packName) {
			return packActivationStore(scope as PackScope, projectId)?.getPackActivation(scope as PackOrderScope, packName) ?? {};
		},
	});

	const staffManager = new StaffManager(projectContextManager, { commandRunner: gatewayDeps.commandRunner, remotePolicy: remoteGitPolicy, worktreeSetupRuntime });
	sessionManager.setStaffManager(staffManager);

	// Inbox plumbing: trigger fires now enqueue entries on `inboxManager`,
	// `inboxNudger` ticks every 15s to deliver digests to idle staff.
	//   - `InboxManager` resolves the per-project store via `projectContextManager`.
	//   - `InboxNudger` looks up pending entries via a cross-project store adapter
	//     (its dep type is the single-project `InboxStore`, but staff records are
	//     globally unique so we route `listPending` through the PCM).
	//   - Wiring order: construct InboxManager → construct InboxNudger →
	//     inboxManager.setNudger(inboxNudger) → staffManager.setInboxManager(
	//     inboxManager) → sessionManager.setInboxNudger(inboxNudger) → start.
	const inboxManager = new InboxManager(projectContextManager, staffManager, (event) => broadcastToAll(event));
	const crossProjectInboxStore: InboxStore = {
		listPending: (staffId: string): InboxEntry[] => {
			for (const ctx of projectContextManager.all()) {
				if (ctx.staffStore.get(staffId)) return ctx.inboxStore.listPending(staffId);
			}
			return [];
		},
		// Unused by nudger but required to satisfy the `InboxStore` shape.
		put: () => { /* nudger does not write */ },
		get: () => undefined,
		list: () => [],
		update: () => false,
		remove: () => false,
		removeAll: () => { /* handled by InboxManager.removeAll */ },
	} as unknown as InboxStore;
	const inboxNudger = new InboxNudger({
		sessionManager,
		staffManager,
		inboxStore: crossProjectInboxStore,
		clock: gatewayDeps.clock,
	});
	inboxManager.setNudger(inboxNudger);
	staffManager.setInboxManager(inboxManager);
	sessionManager.setInboxNudger(inboxNudger);

	// One-shot migration: heal sessions that lost their `staffId` association
	// before the staffId-persistence fix landed. Idempotent — sessions that
	// already carry `staffId` are skipped. Logs loudly per backfilled session
	// so the underlying bug doesn't get masked next time.
	try {
		sessionManager.backfillStaffIds(staffManager);
	} catch (err) {
		console.warn("[server] backfillStaffIds failed (non-fatal):", err);
	}

	const triggerEngine = new TriggerEngine(staffManager, sessionManager, inboxManager, gatewayDeps.clock);
	triggerEngine.start();
	inboxNudger.start();

	// Push-based dispatcher for `goal_created` / `goal_archived` staff triggers.
	// Distinct from `TriggerEngine` (which polls schedule/git) — fired
	// synchronously from `GoalStore.put` / `GoalStore.archive` via callbacks
	// wired on every ProjectContext (existing + lazily created).
	const goalTriggerDispatcher = new GoalTriggerDispatcher(staffManager, inboxManager);
	projectContextManager.setGoalTriggerDispatcher(goalTriggerDispatcher);
	// Placeholder task store for TeamManager construction. Real goal/task operations
	// route through the per-project context (see TeamManager.getTasksForSession). The
	// first registered project's store is used when available, otherwise a server-
	// scoped store is instantiated solely so construction doesn't require a project.
	const firstCtxForInit = projectContextManager.all().next().value as import("./agent/project-context.js").ProjectContext | undefined;
	const taskStore = firstCtxForInit ? firstCtxForInit.taskStore : new TaskStore(stateDir);
	// OrchestrationCore (docs/design/orchestration-core.md) — the ONE goal-agnostic
	// child-agent lifecycle implementation. Constructed near teamManager and wired
	// back into sessionManager (boot index rebuild + restart reminder) and into
	// teamManager (goal adapter routes spawn/dismiss through it). The
	// `/api/sessions/:id/orchestrate/*` routes call it in-process; sub-goal C's
	// `host.agents` capability will call the SAME core.
	const orchestrationCore = new OrchestrationCore({
		sessionManager,
		// Inherit the owner's CURRENT model (same shape as the pr-walkthrough
		// resolveParentInitialModel resolver) so a child no longer drops to the
		// system default.
		resolveSessionModel: (sessionId: string) => {
			const persisted = sessionManager.getPersistedSession(sessionId);
			return persisted?.modelProvider && persisted.modelId ? `${persisted.modelProvider}/${persisted.modelId}` : undefined;
		},
		resolveSessionThinking: (sessionId: string) => sessionManager.getSession(sessionId)?.spawnPinnedThinkingLevel,
		// Resolve the owner's FULL effective tool catalogue so the core can
		// synthesize an explicit "all-except-spawn-verbs" allow-list when the owner
		// is unrestricted (orchestration-core §7 — a child must never have a spawn
		// verb registered). Mirrors SessionManager.resolveEffectiveAllowedTools.
		resolveEffectiveTools: (sessionId: string) => {
			const session = sessionManager.getSession(sessionId);
			if (session?.allowedTools && session.allowedTools.length > 0) return session.allowedTools;
			const ps = sessionManager.getPersistedSession(sessionId);
			const roleName = session?.role ?? ps?.role
				?? ((session?.assistantType ?? ps?.assistantType) ? "assistant" : "general");
			const role = resolveRoleForProject(roleName, session?.projectId ?? ps?.projectId);
			if (!role) return undefined;
			const mcpManager = sessionManager.getMcpManagerForSession(sessionId);
			return computeEffectiveAllowedTools(toolManager, role, groupPolicyStore, mcpManager ?? undefined).map(e => e.name);
		},
		// Resolve a ROLE's effective tool grants for role-carrying spawns
		// (orchestration-core Decision A.2 — FAIL CLOSED). Resolves pack-contributed
		// roles (e.g. the pr-walkthrough pack's `pr-reviewer`) via the config cascade
		// FIRST — the same source session-setup uses (session-setup.ts:441) — then
		// falls back to roleManager so EVERY built-in role still resolves (backward
		// compat: a role-carrying team_delegate spawn must not fail closed). Mirrors
		// the resolveEffectiveTools grant pipeline above.
		resolveRoleAllowedTools: (roleName: string, projectId?: string) => {
			const role = resolveRoleForProject(roleName, projectId);
			if (!role) return undefined;
			const mcpManager = projectId ? sessionManager.getMcpManager({ projectId }) : null;
			return computeEffectiveAllowedTools(toolManager, role, groupPolicyStore, mcpManager ?? undefined).map(e => e.name);
		},
	});
	sessionManager.setOrchestrationCore(orchestrationCore);

	ck("pre-TeamManager");
	const teamManager = new TeamManager(sessionManager, {
		colorStore,
		taskManager: new TaskManager(taskStore),
		roleStore,
		resolveRoleForProject,
		resolveRolesForProject: (projectId?: string) => configCascade.resolveRoles(projectId).map(r => r.item),
		projectContextManager,
		toolManager,
		orchestrationCore,
		commandRunner: gatewayDeps.commandRunner,
	}, undefined, gatewayDeps.clock);
	const bgProcessManager = new BgProcessManager(
		(sessionId: string) => {
			const session = sessionManager.getSession(sessionId);
			return session?.clients;
		},
		undefined,
		(sessionId: string) => {
			// Resolve the per-project bg-process store for this session.
			try {
				const projectId = sessionManager.getSession(sessionId)?.projectId
					?? (sessionManager as any).getPersistedSession?.(sessionId)?.projectId;
				return sessionManager.getBgProcessStore(projectId);
			} catch {
				return undefined;
			}
		},
		undefined,
		undefined,
		gatewayDeps.clock,
	);
	// Expose bg process manager for API routes and session cleanup
	(sessionManager as any).bgProcessManager = bgProcessManager;
	const rateLimiter = new RateLimiter();

	const cleanupInterval = gatewayDeps.clock.setInterval(() => {
		rateLimiter.cleanup();
	}, 60_000);

	// Verification harness — assigned after wss is created (closure captures the reference)
	let verificationHarness: VerificationHarness;

	// Sandbox manager — assigned in start() when sandbox=docker
	let sandboxManager: SandboxManager | null = null;

	const requestHandler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
		const url = new URL(req.url || "/", `http://${req.headers.host}`);
		const isLocalhostMode = !config.forceAuth && (config.host === "localhost" || config.host === "127.0.0.1" || config.host === "::1");

		// Content-origin preview route — served before API auth so iframe loads
		// can authenticate via the bobbit_session cookie instead of the bearer
		// token (iframes cannot set Authorization headers).
		if (url.pathname.startsWith("/preview/")) {
			await handlePreviewRequest(req, res, url.pathname, {
				cookieStore,
				isLocalhost: isLocalhostMode,
				adminBearerToken: config.authToken,
			});
			return;
		}

		// API routes
		if (url.pathname.startsWith("/api/")) {
			const _cpuDiagEnabled = cpuDiagnosticsEnabled();
			const _cpuDiagStart = _cpuDiagEnabled ? performance.now() : 0;
			const _cpuDiagLabel = _cpuDiagEnabled ? normalizeApiRouteLabel(req.method, url.pathname) : "";
			const _cpuDiagBytes = _cpuDiagEnabled ? attachResponseByteCounter(res) : undefined;
			if (_cpuDiagEnabled) {
				res.once("finish", () => {
					getCpuDiagnostics().recordRest(_cpuDiagLabel, res.statusCode || 0, performance.now() - _cpuDiagStart, _cpuDiagBytes?.() ?? 0);
				});
			}

			// When serving the UI (same-origin), reflect the request origin; otherwise allow any
			const corsOrigin = config.staticDir ? (req.headers.origin || "*") : "*";
			res.setHeader("Access-Control-Allow-Origin", corsOrigin);
			if (corsOrigin !== "*") res.setHeader("Vary", "Origin");
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
			res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Bobbit-Session-Id, X-Bobbit-Spawning-Session");

			if (req.method === "OPTIONS") {
				res.writeHead(204);
				res.end();
				return;
			}

			// Reject oversized request bodies up front — before auth, dispatch,
			// or any handler buffers/parses the body (Sec-2). A declared
			// Content-Length over the cap is refused with a definitive 413;
			// chunked/streamed bodies without a length are bounded by the
			// streaming cap inside readBody().
			if (bodyLimitExceeded(req.headers["content-length"])) {
				res.writeHead(413, { "Content-Type": "application/json" });
				res.end(JSON.stringify({
					error: "Request body too large",
					code: "BODY_TOO_LARGE",
					limit: MAX_REQUEST_BODY_BYTES,
				}));
				return;
			}

			// Public endpoints — no auth required (CA cert is inherently public).
			const isPublicEndpoint = url.pathname === "/api/ca-cert" && req.method === "GET";

			// Extract and verify the signed cookie exactly once in the global auth
			// flow. The verification result also carries the renewal decision.
			const cookieValue = extractCookieValue(req);
			const cookieVerification = cookieValue === undefined ? undefined : cookieStore.verify(cookieValue);
			const hasValidCookie = cookieVerification !== undefined;
			let authentication: BrowserCookieAuthentication = cookieVerification
				? { source: "signed-cookie", needsRenewal: cookieVerification.needsRenewal }
				: { source: "other" };

			// Inspect every presented Bearer/query credential for sandbox identity,
			// independently of which credential wins the existing auth precedence.
			// This prevents an admin Bearer plus sandbox query token from minting.
			const presentedBearerTokens: string[] = [];
			for (let i = 0; i < req.rawHeaders.length; i += 2) {
				if (req.rawHeaders[i]?.toLowerCase() !== "authorization") continue;
				const value = req.rawHeaders[i + 1];
				if (value?.startsWith("Bearer ")) presentedBearerTokens.push(value.slice(7));
			}
			if (presentedBearerTokens.length === 0) {
				const authorization = req.headers.authorization;
				if (authorization?.startsWith("Bearer ")) presentedBearerTokens.push(authorization.slice(7));
			}
			const presentedTokens = [...presentedBearerTokens, ...url.searchParams.getAll("token")];
			const hasSandboxCredential = presentedTokens.some((token) => sandboxTokenStore.lookup(token) !== undefined);

			// Auth check — skipped in localhost mode (only local processes can connect).
			// Signed-cookie auth retains precedence over any simultaneously presented
			// credential, matching the previous short-circuit behavior.
			let sandboxScope: SandboxScope | undefined;
			if (!isLocalhostMode && !isPublicEndpoint && !hasValidCookie) {
				const authHeader = req.headers.authorization;
				const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7)
					: url.searchParams.get("token"); // Allow token in query param for links opened in new tabs
				const ip = req.socket.remoteAddress || "unknown";

				if (rateLimiter.isRateLimited(ip)) {
					res.writeHead(429);
					res.end();
					return;
				}

				if (!token) {
					res.writeHead(401, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Unauthorized" }));
					return;
				}

				// Admin token first, then sandbox token.
				if (!validateToken(token, config.authToken)) {
					const scope = sandboxTokenStore.lookup(token);
					if (!scope) {
						rateLimiter.recordFailure(ip);
						res.writeHead(401, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "Unauthorized" }));
						return;
					}
					sandboxScope = scope;
				} else {
					authentication = { source: "admin-bearer" };
				}
			} else if (!isPublicEndpoint && isLocalhostMode && !hasValidCookie) {
				authentication = { source: "localhost-trusted" };
			}

			if (!isPublicEndpoint) {
				const isTls = Boolean((req.socket as { encrypted?: boolean }).encrypted);
				const cookieEligibility = classifyBrowserCookieEligibility({
					method: req.method,
					pathname: url.pathname,
					headers: req.headers,
					isTls,
				}, {
					deployment: config.staticDir ? "direct" : "vite",
					configuredHost: config.host,
					authentication,
					hasSandboxCredential,
				});
				if (cookieEligibility.mayBootstrap || cookieEligibility.mayRenew) {
					issueCookie(res, cookieStore, { localhost: isLocalhostMode && !isTls });
				}
			}

			// Enforce sandbox route guard
			if (sandboxScope && !isSandboxAllowed(url.pathname, req.method || "GET", sandboxScope)) {
				res.writeHead(403, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Forbidden: sandbox token cannot access this endpoint" }));
				return;
			}

			// Optional per-request timing for performance profiling.
			// Enable via BOBBIT_TIMING_LOG=1 to print "[timing] METHOD path ms" for each API call.
			const _timingEnabled = process.env.BOBBIT_TIMING_LOG === "1";
			const _timingStart = _timingEnabled ? performance.now() : 0;
			await handleApiRoute(url, req, res, sessionManager, config, colorStore, prStatusStore, teamManager, orchestrationCore, roleManager, toolManager, projectContextManager, bgProcessManager, staffManager, verificationHarness, preferencesStore, projectConfigStore, groupPolicyStore, broadcastToGoal, broadcastToAll, sandboxManager, projectRegistry, configCascade, sandboxScope, sandboxTokenStore, reviewAnnotationStore, broadcastToSession, roleStore, inboxManager, marketplaceSourceStore, marketplaceInstaller, cookieStore, actionDispatcher, routeDispatcher, routeRegistry, packContributionRegistry, extensionChannelServices, gatewayDeps.fetchImpl, gatewayDeps.commandRunner, gatewayDeps.fsImpl, gatewayDeps.clock);
			if (_timingEnabled) {
				const dur = performance.now() - _timingStart;
				if (dur >= 100) console.log(`[timing] ${req.method} ${url.pathname}${url.search} ${dur.toFixed(1)}ms`);
			}

			return;
		}

		// Dynamic PWA manifest — when launched from a tokenized URL, bake the token
		// into start_url so the PWA can relaunch authenticated.
		// Only does so for a *valid* token; invalid tokens fall through to a plain
		// manifest (no token baked in). Works in both dev mode (Vite proxies
		// /manifest.json to us) and prod (staticDir serves public/).
		if (url.pathname === "/manifest.json" && req.method === "GET") {
			try {
				const manifest = loadManifest(config.staticDir);
				const providedToken = url.searchParams.get("token");
				if (providedToken && validateToken(providedToken, config.authToken)) {
					manifest.start_url = `/?token=${encodeURIComponent(providedToken)}`;
				}
				res.writeHead(200, {
					"Content-Type": "application/manifest+json",
					// Don't let the manifest be cached — token-validity may change.
					"Cache-Control": "no-store",
					// Prevent token leakage via Referer when the PWA makes cross-origin requests.
					"Referrer-Policy": "no-referrer",
				});
				res.end(JSON.stringify(manifest));
				return;
			} catch {
				// Fall through to static serving on any error.
			}
		}

		// Static file serving
		if (config.staticDir) {
			serveStatic(url.pathname, config.staticDir, res);
			return;
		}

		res.writeHead(404);
		res.end("Not found");
	};

	const server: http.Server | https.Server = config.tls
		? https.createServer(
			{
				cert: fs.readFileSync(config.tls.cert),
				key: fs.readFileSync(config.tls.key),
			},
			requestHandler,
		)
		: http.createServer(requestHandler);

	// Long-polling endpoints (e.g. /api/sessions/:id/wait) can block for 10+ minutes.
	// Node >= 19 defaults requestTimeout to 300s which would kill those requests.
	// Disable the server-level timeout; individual endpoints manage their own.
	server.requestTimeout = 0;
	server.headersTimeout = 0;

	// WebSocket server (noServer mode — we handle upgrade manually).
	//
	// `perMessageDeflate: false` disables per-message compression. The `ws`
	// library's default enables it, which on loopback (where bandwidth is
	// not the bottleneck) can stall the server's WS write loop under bursty
	// JSON event traffic — zlib serialises sends through a single thread,
	// and during a streaming turn we emit dozens of small frames per second.
	// Empirically this contributed to a 'Reconnecting to server…' E2E flake
	// cluster (RP-18, CT-01-d, S-02) where the WS would briefly disconnect
	// during high-volume mock-agent event bursts. Loopback never benefits
	// from compression in production either, so this is a strict win.
	const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: WS_MAX_PAYLOAD_BYTES });

	// Broadcast a message to WebSocket clients belonging to a specific goal.
	// Recipients are the matching goal's session sockets plus explicit
	// `/ws/viewer` dashboard sockets. Regular non-goal sessions are skipped so
	// gate/team events do not wake unrelated tabs.
	function broadcastToGoal(goalId: string, event: any): void {
		if (!cpuDiagnosticsEnabled()) {
			const data = JSON.stringify(event);
			const baseMeta = describeWsPayload(event, data);
			for (const ws of wss.clients) {
				if (!(ws as any).authenticated || ws.readyState !== 1 /* OPEN */) continue;
				const sid = (ws as any).sessionId as string | undefined;
				if (sid) {
					const session = sessionManager.getSession(sid);
					if (session?.teamGoalId === goalId || session?.goalId === goalId) {
						guardWebSocketOverflow(ws, { ...baseMeta, recipientKind: "goal-session", context: `goalId=${goalId}` }, {
							pendingOverflowCheck: _goalPendingOverflowCheck,
							warnedClients: _goalWarnedClients,
						}, {
							setTimeout: (cb, ms) => setTimeout(cb, ms),
							warn: (message) => console.warn(message),
						}, DEFAULT_OVERFLOW_GUARD);
						ws.send(data);
					}
					continue;
				}
				if (viewerSubscribedToGoal(ws as any, goalId)) {
					guardWebSocketOverflow(ws, { ...baseMeta, recipientKind: "goal-viewer", context: `goalId=${goalId}` }, {
						pendingOverflowCheck: _goalPendingOverflowCheck,
						warnedClients: _goalWarnedClients,
					}, {
						setTimeout: (cb, ms) => setTimeout(cb, ms),
						warn: (message) => console.warn(message),
					}, DEFAULT_OVERFLOW_GUARD);
					ws.send(data);
				}
			}
			return;
		}

		const stringifyStart = performance.now();
		const data = JSON.stringify(event);
		const stringifyMs = performance.now() - stringifyStart;
		const sendStart = performance.now();
		const baseMeta = describeWsPayload(event, data);
		let scanned = 0;
		let recipients = 0;
		let matchedGoal = 0;
		let viewer = 0;
		let fallback = 0;
		let skipped = 0;
		let skippedNonGoalSession = 0;
		let skippedOtherGoal = 0;
		let skippedUnknownSession = 0;
		let skippedUnscoped = 0;
		let skippedViewerUnsubscribed = 0;
		for (const ws of wss.clients) {
			scanned++;
			if (!(ws as any).authenticated || ws.readyState !== 1 /* OPEN */) { skipped++; continue; }
			const sid = (ws as any).sessionId as string | undefined;
			if (sid) {
				const session = sessionManager.getSession(sid);
				if (session?.teamGoalId === goalId || session?.goalId === goalId) {
					guardWebSocketOverflow(ws, { ...baseMeta, recipientKind: "goal-session", context: `goalId=${goalId}` }, {
						pendingOverflowCheck: _goalPendingOverflowCheck,
						warnedClients: _goalWarnedClients,
					}, {
						setTimeout: (cb, ms) => setTimeout(cb, ms),
						warn: (message) => console.warn(message),
					}, DEFAULT_OVERFLOW_GUARD);
					ws.send(data);
					recipients++;
					matchedGoal++;
					continue;
				}
				skipped++;
				if (!session) skippedUnknownSession++;
				else if (session.teamGoalId || session.goalId) skippedOtherGoal++;
				else skippedNonGoalSession++;
				continue;
			}
			if ((ws as any).isViewer) {
				if (viewerSubscribedToGoal(ws as any, goalId)) {
					guardWebSocketOverflow(ws, { ...baseMeta, recipientKind: "goal-viewer", context: `goalId=${goalId}` }, {
						pendingOverflowCheck: _goalPendingOverflowCheck,
						warnedClients: _goalWarnedClients,
					}, {
						setTimeout: (cb, ms) => setTimeout(cb, ms),
						warn: (message) => console.warn(message),
					}, DEFAULT_OVERFLOW_GUARD);
					ws.send(data);
					recipients++;
					viewer++;
				} else {
					skipped++;
					skippedViewerUnsubscribed++;
				}
				continue;
			}
			skipped++;
			skippedUnscoped++;
		}
		getCpuDiagnostics().recordWsBroadcast("server:broadcastToGoal", wsEventType(event), {
			frames: 1,
			scanned,
			recipients,
			matchedGoal,
			viewer,
			fallback,
			skipped,
			skippedNonGoalSession,
			skippedOtherGoal,
			skippedUnknownSession,
			skippedUnscoped,
			skippedViewerUnsubscribed,
			bytes: Buffer.byteLength(data) * recipients,
			stringifyMs,
			sendMs: performance.now() - sendStart,
		});
	}

	/** Broadcast to ALL authenticated WebSocket clients (regardless of session/goal). */
	function broadcastToAll(event: any): void {
		if (!cpuDiagnosticsEnabled()) {
			const data = JSON.stringify(event);
			for (const ws of wss.clients) {
				if ((ws as any).authenticated && ws.readyState === 1 /* OPEN */) {
					ws.send(data);
				}
			}
			return;
		}

		const stringifyStart = performance.now();
		const data = JSON.stringify(event);
		const stringifyMs = performance.now() - stringifyStart;
		const sendStart = performance.now();
		let scanned = 0;
		let recipients = 0;
		let skipped = 0;
		for (const ws of wss.clients) {
			scanned++;
			if ((ws as any).authenticated && ws.readyState === 1 /* OPEN */) {
				ws.send(data);
				recipients++;
			} else {
				skipped++;
			}
		}
		getCpuDiagnostics().recordWsBroadcast("server:broadcastToAll", wsEventType(event), {
			frames: 1,
			scanned,
			recipients,
			skipped,
			bytes: Buffer.byteLength(data) * recipients,
			stringifyMs,
			sendMs: performance.now() - sendStart,
		});
	}

	/**
	 * Broadcast to all authenticated WebSocket clients whose active session
	 * belongs to the given project. Clients with no session association (e.g.
	 * the user viewing the dashboard) also receive the event so the UI can
	 * surface index status in project-agnostic chrome.
	 */
	function broadcastToProject(projectId: string, event: any): void {
		if (!cpuDiagnosticsEnabled()) {
			const data = JSON.stringify(event);
			for (const ws of wss.clients) {
				if (!(ws as any).authenticated || ws.readyState !== 1 /* OPEN */) continue;
				const sid = (ws as any).sessionId as string | undefined;
				if (sid) {
					const session = sessionManager.getSession(sid);
					if (!session) continue;
					if (session.projectId && session.projectId !== projectId) continue;
				}
				ws.send(data);
			}
			return;
		}

		const stringifyStart = performance.now();
		const data = JSON.stringify(event);
		const stringifyMs = performance.now() - stringifyStart;
		const sendStart = performance.now();
		let scanned = 0;
		let recipients = 0;
		let skipped = 0;
		for (const ws of wss.clients) {
			scanned++;
			if (!(ws as any).authenticated || ws.readyState !== 1 /* OPEN */) { skipped++; continue; }
			const sid = (ws as any).sessionId as string | undefined;
			if (sid) {
				const session = sessionManager.getSession(sid);
				if (!session) { skipped++; continue; }
				if (session.projectId && session.projectId !== projectId) { skipped++; continue; }
			}
			ws.send(data);
			recipients++;
		}
		getCpuDiagnostics().recordWsBroadcast("server:broadcastToProject", wsEventType(event), {
			frames: 1,
			scanned,
			recipients,
			skipped,
			bytes: Buffer.byteLength(data) * recipients,
			stringifyMs,
			sendMs: performance.now() - sendStart,
		});
	}


	// Bridge search index progress bus → WS. Progress events are debounced
	// to 500ms per-project (design §9). Complete + error events pass through.
	{
		const progressDebounce = new Map<string, { timer: NodeJS.Timeout; latest: any }>();
		const flushProgress = (projectId: string) => {
			const entry = progressDebounce.get(projectId);
			if (!entry) return;
			const diagEnabled = cpuDiagnosticsEnabled();
			const diagStart = diagEnabled ? performance.now() : 0;
			progressDebounce.delete(projectId);
			clearTimeout(entry.timer);
			broadcastToProject(projectId, entry.latest);
			if (diagEnabled) {
				getCpuDiagnostics().recordTimer("search:progressFlush", performance.now() - diagStart, { flushes: 1 });
			}
		};
		searchProgressBus.on("index:progress", (ev) => {
			const event = { type: "index:progress" as const, ...ev };
			const existing = progressDebounce.get(ev.projectId);
			if (existing) {
				existing.latest = event;
				return;
			}
			const timer = setTimeout(() => flushProgress(ev.projectId), 500);
			timer.unref();
			progressDebounce.set(ev.projectId, { timer, latest: event });
		});
		searchProgressBus.on("index:complete", (ev) => {
			flushProgress(ev.projectId);
			broadcastToProject(ev.projectId, { type: "index:complete" as const, ...ev });
		});
		searchProgressBus.on("index:error", (ev) => {
			broadcastToProject(ev.projectId, { type: "index:error" as const, ...ev });
		});
	}

	teamManager.setBroadcastToGoal(broadcastToGoal);
	// Push session creation to ALL clients so session navigation refreshes promptly
	// for visible sessions created through REST, UI, or host.agents full-lifecycle paths.
	sessionManager.addCreationListener((session) => {
		try {
			broadcastToAll({ type: "session_created", sessionId: session.id, projectId: session.projectId });
		} catch (err) {
			console.error(`[broadcast] session_created failed for ${session.id}:`, err);
		}
	});
	// Push a session_removed broadcast to ALL clients on terminate/archive/purge
	// so sidebars and dashboards update instantly. Replaces a 5s polling tick
	// for a documented class of races (e.g. clicking a stale sidebar entry just
	// after another tab archived the session).
	sessionManager.addTerminationListener((sessionId, info) => {
		try {
			broadcastToAll({ type: "session_removed", sessionId, projectId: info.projectId, reason: info.reason });
		} catch (err) {
			console.error(`[broadcast] session_removed failed for ${sessionId}:`, err);
		}
		if (info.reason === "purged") {
			try { previewArtifacts.removeArtifacts(sessionId); } catch (err) {
				console.error(`[preview/artifacts] remove failed for ${sessionId}:`, err);
			}
		}
	});

	sessionManager.setOnPrCreationDetected((session) => {
		const goalId = session.goalId || session.teamGoalId;
		if (!goalId) return;
		const goalCtx = projectContextManager.getContextForGoal(goalId);
		const goal = goalCtx?.goalStore.get(goalId);
		if (!goal) return;
		_prCache.delete(goal.cwd);
		if (goal.branch) _prCache.delete(`${goal.cwd}::${goal.branch}`);
		broadcastToAll({ type: "pr_status_changed", goalId });
	});
	// Broadcast a message to all WebSocket clients subscribed to a specific session.
	function broadcastToSession(sessionId: string, event: any): void {
		const session = sessionManager.getSession(sessionId);
		if (!session) return;
		if (!cpuDiagnosticsEnabled()) {
			const data = JSON.stringify(event);
			for (const ws of session.clients) {
				if ((ws as any).readyState === 1 /* OPEN */) ws.send(data);
			}
			return;
		}

		const stringifyStart = performance.now();
		const data = JSON.stringify(event);
		const stringifyMs = performance.now() - stringifyStart;
		const sendStart = performance.now();
		let scanned = 0;
		let recipients = 0;
		let skipped = 0;
		for (const ws of session.clients) {
			scanned++;
			if ((ws as any).readyState === 1 /* OPEN */) {
				ws.send(data);
				recipients++;
			} else {
				skipped++;
			}
		}
		getCpuDiagnostics().recordWsBroadcast("server:broadcastToSession", wsEventType(event), {
			frames: 1,
			scanned,
			recipients,
			skipped,
			bytes: Buffer.byteLength(data) * recipients,
			stringifyMs,
			sendMs: performance.now() - sendStart,
		});
	}

	ck("pre-VerificationHarness");
	verificationHarness = new VerificationHarness(stateDir, undefined, broadcastToGoal, roleStore, preferencesStore, sessionManager, teamManager, projectConfigStore, projectContextManager, configCascade, { commandRunner: gatewayDeps.commandRunner, commandStepRunner: gatewayDeps.commandStepRunner, clock: gatewayDeps.clock, skipLlmReview: gatewayRuntimeFlags.skipLlmReview });
	ck("new VerificationHarness");
	teamManager.setVerificationHarness(verificationHarness);
	verificationHarness.setTeamLeadNotifier((goalId, message) => {
		const team = teamManager.getTeamState(goalId);
		if (!team?.teamLeadSessionId) return;
		const teamLeadSession = sessionManager.getSession(team.teamLeadSessionId);
		if (!teamLeadSession || teamLeadSession.status === "terminated") return;
		try {
			// source: "verification" so TeamManager.subscribeTeamLeadEvents preserves
			// idle-nudge backoff counters when the lead replies to this notification
			// (rather than treating it as a fresh user-driven idle cycle).
			if (teamLeadSession.status === "streaming") {
				sessionManager.deliverLiveSteer(team.teamLeadSessionId, message, { source: "verification" });
			} else {
				sessionManager.enqueuePrompt(team.teamLeadSessionId, message, { isSteered: true, source: "verification" });
			}
			// The full verification notification is already surfaced in the team lead transcript.
			// Keep it out of routine server logs unless explicitly debugging.
			if (process.env.BOBBIT_DEBUG) console.log(`[verification] Notified team lead for goal ${goalId} (${message.length} chars)`);
		} catch (err) {
			console.error(`[verification] Failed to notify team lead for goal ${goalId}:`, err);
		}
	});

	const isLocalhostServer = !config.forceAuth && (config.host === "localhost" || config.host === "127.0.0.1" || config.host === "::1");

	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url || "/", `http://${req.headers.host}`);
		const viewerMatch = url.pathname === "/ws/viewer";
		const match = viewerMatch ? null : url.pathname.match(/^\/ws\/([^/]+)$/);

		if (!match && !viewerMatch) {
			socket.destroy();
			return;
		}

		const sessionId = viewerMatch ? "__viewer__" : match![1];

		const ip = req.socket.remoteAddress || "unknown";
		if (!isLocalhostServer && rateLimiter.isRateLimited(ip)) {
			socket.destroy();
			return;
		}

		wss.handleUpgrade(req, socket, head, (ws) => {
			const channels = extensionChannelServices;
			handleWebSocketConnection(ws, sessionId, req, sessionManager, config.authToken, rateLimiter, projectConfigStore, isLocalhostServer, sandboxTokenStore, projectContextManager, toolManager, packContributionRegistry, preferencesStore, channels?.registry as any, channels?.openPermits as any);
		});
	});

	ck("post-VerificationHarness-to-return");
	bootLog(`[boot] ctor total (createGateway body) ${Date.now() - __ckT0}ms`);
	return {
		server,
		deps: gatewayDeps,
		sessionManager,
		/** @internal Exposed for in-process E2E tests to drive supervisor-respawn directly. */
		teamManager,
		/** @internal Exposed for in-process E2E tests to drive restart-survival (rebuildIndexFromPersisted + remindOwnersWithLiveChildren) directly. */
		orchestrationCore,
		bgProcessManager,
		projectContextManager,
		get extensionChannels() { return extensionChannelServices; },
		async start(): Promise<number> {
			// Phase timer for the pre-listen critical path: everything awaited here
			// blocks `server.listen()`, i.e. delays the UI becoming reachable.
			// Log each phase (>=50ms) so a slow cold-start is diagnosable from logs.
			const bootStart = Date.now();
			const bootPhase = makePhaseTimer("[boot] pre-listen");
			// Check internet and auto-configure AI Gateway if offline
			// Runs before session restore so models.json is written before
			// any agent subprocesses start.
			await bootPhase("aigw-check", () => startupAigwCheck(preferencesStore));
			writeContextWindowOverrides();
			writeOpenAIModelAdditions();
			await bootPhase("extension-channels", () => initExtensionChannelsOnce());

			// Initialize MCP servers (skip when disabled by gateway runtime config)
			if (!gatewayRuntimeFlags.skipMcp) {
				try {
					await bootPhase("mcp-init", () => sessionManager.initMcp(headquartersDir()));
				} catch (err) {
					console.error('[mcp] MCP init failed:', (err as Error).message);
				}
			}

			// Wire verification harness before session restore so orphan cleanup can skip resuming sessions
			sessionManager.setVerificationHarness(verificationHarness);

			// ── Sandbox manager ──
			// Sandboxes are initialized lazily per-project on first sandbox use
			// (see SandboxManager.ensureForProject). The bootstrap closure below
			// runs the host-side plumbing (image build/version check, mounts,
			// credentials, sandbox network, GitHub token) the first time each
			// project's sandbox is requested by session/goal/staff creation.
			const sandboxBootstrap: SandboxBootstrap = async (projectId) => {
				const project = projectRegistry.get(projectId);
				if (!project) {
					throw new Error(`[sandbox] bootstrap: project ${projectId} not registered`);
				}
				const ctx = projectContextManager.getOrCreate(projectId);
				if (!ctx) {
					throw new Error(`[sandbox] bootstrap: cannot resolve context for project ${projectId}`);
				}
				const cfg = ctx.projectConfigStore;
				const sandboxCfg = cfg.get("sandbox") || "none";
				if (sandboxCfg !== "docker") return null;

				const projectDir = project.rootPath;
				const imageName = cfg.get("sandbox_image") || "bobbit-agent";

				// Auto-build or rebuild image if missing or stale. Images are
				// shared across projects (Docker image tags) so the first project
				// to request a sandbox pays the build cost.
				const dockerContextRoot = resolveSandboxDockerContext(config.defaultCwd);
				const imageStatus = await checkDockerAvailability(imageName, dockerContextRoot ?? undefined);
				if (imageStatus.imageExists === false) {
					if (!dockerContextRoot) {
						throw new Error(`[sandbox] Docker image "${imageName}" is missing and docker/Dockerfile could not be found`);
					}
					const buildResult = await buildSandboxImage(imageName, dockerContextRoot);
					if (!buildResult.success) {
						throw new Error(`[sandbox] Auto-build failed for project ${projectId}: ${buildResult.error || "unknown error"}`);
					}
				} else if (imageStatus.imageExists === true) {
					const imageReady = await ensureImageAgentVersion(imageName, dockerContextRoot ?? undefined);
					if (!imageReady) {
						throw new Error(`[sandbox] Docker image "${imageName}" is stale and could not be rebuilt`);
					}
				}

				const isRepo = await isGitRepo(projectDir, serverCommandRunner);
				if (!isRepo) {
					console.log(`[sandbox] Project ${projectId} is not a git repo — sandbox disabled (worktrees require git)`);
					return null;
				}
				const repoPath = await getRepoRoot(projectDir, serverCommandRunner);

				// Resolve the clone source for the container. Resolving via
				// `resolveSandboxCloneSource` guarantees we NEVER hand git a raw host
				// path (e.g. a Windows drive-letter path, which git misparses as scp
				// syntax → `cannot run ssh`) or an otherwise-unreachable host path.
				// With an `origin` remote we clone the remote URL (tokens stripped so
				// they don't leak into .git/config — the container's credential helper
				// reads GITHUB_TOKEN from env instead). Without one, the canonical main
				// repo root (resolved via `resolveSandboxMountRoot`, which handles linked
				// worktrees) is copied into a sanitized git source (excluding `.bobbit/` and
				// `auth.json`) before that source is bind-mounted read-only and cloned via
				// `file://`. A LOCAL origin throws here — propagating through the awaited bootstrap so
				// `ensureForProject` rejects on the awaited boundary (no fire-and-forget).
				const resolveOrigin = async (cwd: string): Promise<string | null> => {
					try {
						const { stdout } = await serverCommandRunner.execFile("git", ["remote", "get-url", "origin"], { cwd, timeout: 5000 });
						return String(stdout).trim() || null;
					} catch {
						return null;
					}
				};
				const sandboxStateDir = path.join(projectDir, ".bobbit", "state");
				const originUrl = await resolveOrigin(repoPath);
				const mountSourcePath = originUrl
					? await resolveSandboxMountRoot(repoPath)
					: prepareSanitizedSandboxCloneSource({
						repoPath: await resolveSandboxMountRoot(repoPath),
						stateDir: sandboxStateDir,
						key: "root",
					});
				const cloneSource = resolveSandboxCloneSource({ originUrl, mountSourcePath });
				const repoUrl = cloneSource.cloneUrl;

				let poolMounts: string[] = [];
				try {
					const mountsRaw = cfg.get("sandbox_mounts") || "";
					poolMounts = mountsRaw ? validateSandboxMounts(JSON.parse(mountsRaw), "[sandbox]") : [];
				} catch (err) { console.warn(`[sandbox] Invalid sandbox_mounts JSON for project ${projectId}, ignoring: ${err}`); }

				let poolCredentials: Record<string, string> = {};
				try {
					const credsRaw = cfg.get("sandbox_credentials") || "";
					poolCredentials = credsRaw ? JSON.parse(credsRaw) : {};
				} catch (err) { console.warn(`[sandbox] Invalid sandbox_credentials JSON for project ${projectId}, ignoring: ${err}`); }

				const sandboxNetwork = await sessionManager.ensureSandboxNetwork();

				const githubTokenEnabled = cfg.get("sandbox_github_token") !== "false";
				const githubToken = githubTokenEnabled ? resolveHostTokenValue("GITHUB_TOKEN") : undefined;

				const components = ctx.projectConfigStore.getComponents();
				// Multi-repo: try to resolve each repo's clone URL from `<rootPath>/<repo>/.git/config`.
				// Falls back to the project's primary `repoUrl` for any repo without
				// a remote configured (the bootstrap will then clone the same repo
				// into multiple paths — only useful as a defensive default).
				let repoUrlByName: Record<string, string> | undefined;
				let cloneSourceByName: Record<string, SandboxCloneSource> | undefined;
				if (components.some(c => c.repo !== ".")) {
					repoUrlByName = {};
					cloneSourceByName = {};
					const seen = new Set<string>();
					for (const c of components) {
						if (c.repo === "." || seen.has(c.repo)) continue;
						seen.add(c.repo);
						const rp = path.join(projectDir, c.repo);
						// Same resolution as the single-repo path: never fall back to a
						// raw host path. Remote-less repos copy their canonical main repo
						// root (resolved via `resolveSandboxMountRoot`, which handles linked
						// worktrees) into a sanitized git source, then bind-mount that source
						// at a per-repo container mount path and clone via `file://`. A local
						// origin throws (caller's awaited boundary).
						const perRepoOriginUrl = await resolveOrigin(rp);
						const perRepoMountRoot = await resolveSandboxMountRoot(rp);
						const perRepoMountSource = perRepoOriginUrl
							? perRepoMountRoot
							: prepareSanitizedSandboxCloneSource({
								repoPath: perRepoMountRoot,
								stateDir: sandboxStateDir,
								key: c.repo,
							});
						const perRepoSrc = resolveSandboxCloneSource({
							originUrl: perRepoOriginUrl,
							mountSourcePath: perRepoMountSource,
							mountPath: `/workspace-src/${c.repo}`,
						});
						cloneSourceByName[c.repo] = perRepoSrc;
						repoUrlByName[c.repo] = perRepoSrc.cloneUrl;
					}
				}

				const sandboxTokenEntries = cfg.getSandboxTokens();
				const sandboxAuthPolicy = resolveSandboxAgentAuthPolicy(sandboxTokenEntries);
				return {
					projectId,
					projectDir,
					repoUrl,
					cloneSource,
					image: imageName,
					sandboxNetwork,
					sandboxMounts: poolMounts,
					sandboxCredentials: poolCredentials,
					sandboxAgentAuthAllowed: sandboxAuthPolicy.includeCodexAuth,
					sandboxAgentAuthGoogleAllowed: sandboxAuthPolicy.includeGoogleAuth,
					sandboxAgentAuthPrefs: preferencesStore,
					githubToken,
					toolManager: ctx.toolManager,
					components,
					repoUrlByName,
					cloneSourceByName,
					// Resolver is invoked at worktree-creation time inside the container, so it always
					// reads the current project-config-store value rather than a snapshot taken at
					// sandbox bootstrap. Same shape as the worktree-pool baseRefResolver.
					baseRefResolver: () => cfg.get("base_ref"),
				};
			};
			sandboxManager = new SandboxManager({ bootstrap: sandboxBootstrap, commandRunner: gatewayDeps.commandRunner, clock: gatewayDeps.clock, worktreeSetupRuntime });
			sessionManager.setSandboxManager(sandboxManager);
			sessionManager.subscribeSandboxRecovery();

			// Restore persisted teams before sessions so reconstructed records are available
			// to session revival. Both complete before accepting connections.
			await bootPhase("restore-teams", () => teamManager.waitForRestore());
			await bootPhase("restore-sessions", () => sessionManager.restoreSessions());

			// One-shot legacy cost backfill: stamp `goalId` on cost entries
			// that pre-date the forward-stamp fix (commit a4050f59). Runs
			// once per project context after sessions are restored so the
			// resolver can see live PersistedSession records. Idempotent.
			const agentSessionsRoot = path.join(globalAgentDir(), "sessions");
			const costBackfillStart = Date.now();
			try {
				for (const ctx of projectContextManager.all()) {
					await backfillLegacyCostGoalIds({
						costTracker: ctx.costTracker,
						sessionManager,
						agentSessionsRoot,
					});
				}
			} catch (err) {
				console.warn("[cost-backfill] boot backfill failed (non-fatal):", err);
			}
			{
				const dt = Date.now() - costBackfillStart;
				if (dt >= SLOW_PHASE_MS) bootLog(`[boot] pre-listen cost-backfill in ${dt}ms`);
			}
			bootLog(`[boot] pre-listen phases complete in ${Date.now() - bootStart}ms`);

			// NOTE: Orphaned worktree cleanup and non-interactive session cleanup
			// are no longer automatic on startup. Use the Settings → Maintenance UI
			// or the /api/maintenance/* endpoints to preview and clean up manually.

			await bootPhase("startPurgeSchedule", () => sessionManager.startPurgeSchedule());

			// Initialize worktree pools for all git-repo projects
			// (pre-creates worktrees in the background so new sessions start instantly).
			// E2E / CI can skip this entirely via BOBBIT_SKIP_WORKTREE_POOL=1 — the
			// pool fills worktrees aggressively at boot and replenishes on every
			// claim, which costs real CPU on tests that don't need git at all.
			//
			// Boot sweeper + pool fill run AFTER `server.listen()` as a background
			// chain — the sweeper shells out to `git worktree list/repair` per repo
			// with 10–15s timeouts, and the pool readiness check awaits `isGitRepo`
			// per project. Doing them before listen used to leave the gateway
			// unreachable for many seconds on installs with stale worktrees.
			//
			// Concurrency note: the sweeper and the pool init operate on DISJOINT
			// branch sets — `worktree-sweeper.ts` explicitly skips Bobbit pool
			// branches using the shared inventory classifier helpers, and
			// `WorktreePool.reclaimOrphaned` only inspects pool branches. So the two
			// phases are run concurrently via `Promise.all`, and project-level pool
			// init is also parallelised
			// across projects (each project's pool is independent). This avoids
			// the previous serial chain that left the pool empty for minutes on
			// installs with many stale worktrees, forcing every new session
			// through the cold path (full createWorktree + npm ci).
			const runBootBackgroundTasks = async (): Promise<void> => {
				const t0 = Date.now();

				// Transcript-pass backfill — lazy, fire-and-forget after listen().
				// Runs *after* the pre-listen sidecar pass so it only touches entries
				// that pass could not resolve. Bounded per-project (50 lines / 64 KiB
				// per file, 30s total) and confidence-gated (see extractTranscriptGoalId).
				// Bumps the cost-tracker generation when it stamps anything, which
				// invalidates cached tree-cost rollups for the next request.
				const transcriptBackfillTask = (async () => {
					for (const ctx of projectContextManager.all()) {
						try {
							await backfillLegacyCostGoalIdsFromTranscripts({
								costTracker: ctx.costTracker,
								agentSessionsRoot,
								goals: ctx.goalStore.getAll(),
							});
						} catch (err) {
							console.warn("[cost-backfill] transcript-pass failed (non-fatal):", err);
						}
					}
				})();

				const sweeperTask = (async () => {
					const tStart = Date.now();
					try {
						const { sweepOrphanedWorktrees } = await import("./agent/worktree-sweeper.js");
						const sweepProjects: Array<{ id: string; rootPath: string; repos?: string[]; worktreeRoot?: string }> = [];
						const sweepGoals: Array<{ id: string; branch?: string; worktreePath?: string; cwd?: string; archived?: boolean; repoWorktrees?: Record<string, string> }> = [];
						const sweepSessions: Array<{ id: string; branch?: string; worktreePath?: string; cwd?: string; archived?: boolean; repoWorktrees?: Record<string, string> }> = [];
						const sweepTeams: Array<{ id: string; branch?: string; worktreePath?: string; cwd?: string; archived?: boolean; repoWorktrees?: Record<string, string> }> = [];
						const sweepStaff: Array<{ id: string; branch?: string; worktreePath?: string; cwd?: string; repoWorktrees?: Record<string, string> }> = [];
						// Skip hidden contexts (synthetic system project) — it has
						// no goals/sessions/staff and must never drive worktree work.
						for (const ctx of projectContextManager.visible()) {
							// Headquarters is no-worktree — never enter git discovery or the
							// sweeper. It has no worktrees/branches to reclaim.
							if (ctx.project.id === HEADQUARTERS_PROJECT_ID || ctx.project.kind === "headquarters") continue;
							const repoNames = ctx.projectConfigStore.repoNames();
							const components = ctx.projectConfigStore.getComponents();
							const isMultiRepoProject = components.some(c => c.repo !== ".");
							let sweepRootPath = ctx.project.rootPath;
							if (!isMultiRepoProject && await isGitRepo(ctx.project.rootPath, serverCommandRunner).catch(() => false)) {
								sweepRootPath = await getRepoRoot(ctx.project.rootPath, serverCommandRunner);
							}
							sweepProjects.push({
								id: ctx.project.id,
								rootPath: sweepRootPath,
								repos: repoNames.length > 0 ? repoNames : undefined,
								worktreeRoot: ctx.projectConfigStore.get("worktree_root") || undefined,
							});
							for (const g of ctx.goalStore.getAll()) {
								sweepGoals.push({
									id: g.id, branch: g.branch, worktreePath: g.worktreePath, cwd: g.cwd, archived: !!g.archived,
									repoWorktrees: (g as { repoWorktrees?: Record<string, string> }).repoWorktrees,
								});
							}
							for (const s of ctx.sessionStore.getAll()) {
								sweepSessions.push({
									id: s.id, branch: s.branch, worktreePath: s.worktreePath, cwd: s.cwd, archived: !!s.archived,
									repoWorktrees: s.repoWorktrees,
								});
							}
							for (const team of ctx.teamStore.getAll()) {
								for (const agent of team.agents) {
									sweepTeams.push({
										id: agent.sessionId,
										branch: agent.branch,
										worktreePath: agent.worktreePath,
									});
								}
								const lead = team.teamLeadSessionId ? ctx.sessionStore.get(team.teamLeadSessionId) : undefined;
								if (lead) {
									sweepTeams.push({
										id: lead.id,
										branch: lead.branch,
										worktreePath: lead.worktreePath,
										cwd: lead.cwd,
										repoWorktrees: lead.repoWorktrees,
									});
								}
							}
							for (const st of ctx.staffStore.getAll()) {
								sweepStaff.push({
									id: st.id,
									branch: st.branch,
									worktreePath: st.worktreePath,
									cwd: st.cwd,
									repoWorktrees: st.repoWorktrees,
								});
							}
						}
						bootLog(`[boot] sweeper start (${sweepProjects.length} projects)`);
						const result = await sweepOrphanedWorktrees({
							projects: sweepProjects,
							goals: sweepGoals,
							sessions: sweepSessions,
							teams: sweepTeams,
							staff: sweepStaff,
						});
						bootLog(`[boot] sweeper done in ${Date.now() - tStart}ms (reclaimed=${result.reclaimed} cleaned=${result.cleaned} repaired=${result.repaired})`);
					} catch (err) {
						console.warn(`[boot] sweeper failed in ${Date.now() - tStart}ms (non-fatal):`, err);
					}
				})();

				const poolInitTask = (async () => {
					if (gatewayRuntimeFlags.skipWorktreePool) return;
					// Hidden contexts (synthetic system project) must NOT seed a
					// worktree pool. When bobbit's state dir is nested inside an
					// unrelated git checkout, `isGitRepo(<state>/system-project)`
					// walks up to find the host repo and the pool would allocate
					// `pool/_pool-*` branches there. See
					// `tests/system-project-pool-leak.test.ts`.
					// Headquarters never participates in the worktree pool — filter it
					// out before any git probe or pool init.
					const contexts = Array.from(projectContextManager.visible()).filter(
						(ctx) => ctx.project.id !== HEADQUARTERS_PROJECT_ID && ctx.project.kind !== "headquarters",
					);
					console.log(`[boot] pool init start (${contexts.length} projects)`);
					await Promise.all(contexts.map(async (ctx) => {
						const tStart = Date.now();
						try {
							const repoPath = ctx.project.rootPath;
							const components = ctx.projectConfigStore.getComponents();
							const isMulti = components.some(c => c.repo !== ".");
							let poolReady = false;
							if (isMulti) {
								const seen = new Set<string>();
								poolReady = true;
								for (const c of components) {
									if (c.repo === "." || seen.has(c.repo)) continue;
									seen.add(c.repo);
									if (!(await isGitRepo(path.join(repoPath, c.repo), serverCommandRunner))) { poolReady = false; break; }
								}
							} else {
								poolReady = await isGitRepo(repoPath, serverCommandRunner);
							}
							if (poolReady) {
								const poolSize = parseInt(ctx.projectConfigStore.get("worktree_pool_size") || "2", 10) || 2;
								const wtRoot = ctx.projectConfigStore.get("worktree_root") || undefined;
								const pcs = ctx.projectConfigStore;
								// Single-repo: resolve nested rootPath to the actual git toplevel so
								// pool entries land under <gitRoot>-wt/, not <projectDir>-wt/.
								const poolRepoPath = isMulti ? repoPath : await getRepoRoot(repoPath, serverCommandRunner);
								sessionManager.initWorktreePoolForProject(ctx.project.id, poolRepoPath, () => pcs.getComponents(), poolSize, wtRoot, () => pcs.get("base_ref"), () => pcs.get("worktree_setup_timeout_ms") || undefined, ctx.project.rootPath);
								bootLog(`[boot] pool ready: project=${ctx.project.id} in ${Date.now() - tStart}ms`);
							} else {
								bootLog(`[boot] pool skipped (not a git repo): project=${ctx.project.id} in ${Date.now() - tStart}ms`);
							}
						} catch (err) {
							console.warn(`[boot] pool init failed: project=${ctx.project.id} in ${Date.now() - tStart}ms (non-fatal):`, err);
						}
					}));
				})();
				await Promise.all([transcriptBackfillTask, sweeperTask, poolInitTask]);
				bootLog(`[boot] background tasks complete in ${Date.now() - t0}ms`);
			};

			// Wire goal-manager resolvers so goals claim through the pool first and
			// resolve components / project root for multi-repo goal creation.
			// Hidden contexts (synthetic system project) have no goals to wire.
			await bootPhase("wireGoalManagerResolvers", () => {
				for (const ctx of projectContextManager.visible()) {
					wireGoalManagerResolvers(ctx, { sessionManager, projectContextManager, projectRegistry });
				}
			});

			// Now that sessions are live, re-subscribe to team events
			// (must happen after restoreSessions so session objects exist)
			await bootPhase("resubscribeTeamEvents", () => teamManager.resubscribeTeamEvents());

			// Resume any verifications that were interrupted by a server restart (fire-and-forget)
			await bootPhase("resumeInterruptedVerifications-sync", () => {
				verificationHarness.resumeInterruptedVerifications().catch(err => {
					console.error("[verification] Error resuming interrupted verifications:", err);
				});
			});
			bootLog(`[boot] start() reached listen() at ${Date.now() - bootStart}ms`);

			// Port 0 = let OS assign a free port; skip the auto-increment loop
			if (config.port === 0) {
				await new Promise<void>((resolve, reject) => {
					server.once("error", reject);
					server.listen(0, config.host, () => {
						server.removeListener("error", reject);
						resolve();
					});
				});
				const addr = server.address() as import("node:net").AddressInfo;
				void runBootBackgroundTasks();
				return addr.port;
			}

			const maxPort = config.portExplicit !== false ? config.port : config.port + 9;
			let port = config.port;

			while (port <= maxPort) {
				try {
					await new Promise<void>((resolve, reject) => {
						server.once("error", reject);
						server.listen(port, config.host, () => {
							server.removeListener("error", reject);
							resolve();
						});
					});
					if (port !== config.port) {
						console.log(`Port ${config.port} in use, using port ${port}`);
					}
					void runBootBackgroundTasks();
					return port;
				} catch (err: any) {
					if (err.code === "EADDRINUSE" && port < maxPort) {
						console.log(`Port ${port} in use, trying ${port + 1}...`);
						port++;
						continue;
					}
					throw err;
				}
			}
			throw new Error(`All ports ${config.port}-${maxPort} in use`);
		},
		async shutdown() {
			const shutdownStart = Date.now();
			bootMark(`SHUTDOWN ${new Date().toISOString()}`);
			// Phase timer: log each teardown phase so a slow shutdown is diagnosable
			// from the logs without a profiler. Cheap (Date.now + one appended line).
			const phase = makePhaseTimer("[shutdown]");
			try {
				// Stop accepting NEW connections AND forcibly terminate existing
				// keep-alive connections BEFORE we tear down the state stores.
				// Without this, an HTTP/1.1 keep-alive connection from the client
				// can still deliver a request to handleApiRoute mid-shutdown (e.g.
				// during the awaits below), after projectContextManager.closeAll()
				// has emptied the contexts map — producing spurious `Goal "X" not
				// found in any project` errors. It also matters for the test
				// crash/restart path: a stale keep-alive connection on the OLD
				// server's accept() fd survives port reuse and routes new requests
				// to the OLD (already torn down) handler closure. Forcibly closing
				// connections forces clients to reconnect to the NEW server.
				try { (server as { closeAllConnections?: () => void }).closeAllConnections?.(); } catch { /* best-effort */ }
				server.close();
				gatewayDeps.clock.clearInterval(cleanupInterval);
				triggerEngine.stop();
				inboxNudger.stop();
				wss.close();
				await phase("extension-channels", () => disposeExtensionChannelServices(extensionChannelServices, "gateway-shutdown"));
				try { getCpuDiagnostics().shutdown(); } catch { /* best-effort */ }
				try { verificationHarness?.shutdown(); } catch { /* best-effort */ }
				// Worktree pools are intentionally NOT drained on shutdown.
				//
				// Pool entries are pre-built worktrees on `pool/_pool-*` branches
				// created `pushPolicy: "local-only"` — they never exist on the remote.
				// The old `drain()` here ran, serially across every project's pool,
				// `git worktree remove --force` + `git branch -D` + a pointless
				// `git push origin --delete` (a network round-trip, up to a 15s
				// timeout each, to delete a branch that was never pushed). That both
				// slowed shutdown AND destroyed exactly the worktrees the next boot
				// then had to rebuild from scratch (`git worktree add` + `npm ci`),
				// leaving new sessions on the cold path for minutes after start.
				//
				// Leaving them on disk lets `WorktreePool.reclaimOrphaned` re-adopt
				// them instantly at the next boot (the sweeper skips pool branches,
				// and reclaim is capped at the pool's target size, so they don't
				// accumulate). Explicit teardown still drains: project removal
				// (`removeWorktreePool`) and the Settings → Maintenance cleanup.
				await phase("session-manager", () => sessionManager.shutdown());
				await phase("project-contexts", () => projectContextManager.closeAll());
				if (sandboxManager) {
					await phase("sandbox-manager", () => sandboxManager!.shutdownAll());
				}
				await phase("sandbox-network", () => sessionManager.cleanupSandboxNetwork());
				bootLog(`[shutdown] complete in ${Date.now() - shutdownStart}ms`);
			} catch (err) {
				bootLog(`[shutdown] aborted after ${Date.now() - shutdownStart}ms: ${err instanceof Error ? err.message : String(err)}`);
				throw err;
			} finally {
				restoreExplicitRpcBridgeFactory();
			}
		},
	};
}

// isSetupComplete now lives in ./setup-status.ts (re-exported at top of file).

/** Redact token values in sandbox config for API responses. Never send real secrets to the browser.
 *  `sandbox_tokens` is a structured array (post-native-YAML); other fields stay flat strings. */
function redactSandboxSecrets(config: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...config };
	if (Array.isArray(result.sandbox_tokens)) {
		result.sandbox_tokens = (result.sandbox_tokens as Array<any>).map((e: any) => ({
			...e,
			value: e.value ? "__REDACTED__" : "",
		}));
	}
	if (typeof result.sandbox_credentials === "string" && result.sandbox_credentials) {
		try {
			const obj = JSON.parse(result.sandbox_credentials);
			if (typeof obj === "object" && obj !== null) {
				const redacted: Record<string, string> = {};
				for (const [k, v] of Object.entries(obj)) {
					redacted[k] = v ? "__REDACTED__" : "";
				}
				result.sandbox_credentials = JSON.stringify(redacted);
			}
		} catch { /* leave as-is */ }
	}
	return result;
}

/** Redact token values in resolved config (with source annotations).
 *  `sandbox_tokens.value` is now a structured array; sandbox_credentials remains a JSON string. */
function redactSandboxSecretsResolved(config: Record<string, { value: unknown; source: string }>): Record<string, { value: unknown; source: string }> {
	const result = { ...config };
	if (result.sandbox_tokens && Array.isArray(result.sandbox_tokens.value)) {
		result.sandbox_tokens = {
			...result.sandbox_tokens,
			value: (result.sandbox_tokens.value as Array<any>).map((e: any) => ({
				...e,
				value: e.value ? "__REDACTED__" : "",
			})),
		};
	}
	for (const key of ["sandbox_credentials"] as const) {
		if (!result[key]) continue;
		const entry = { ...result[key] };
		if (key === "sandbox_credentials" && typeof entry.value === "string" && entry.value) {
			try {
				const obj = JSON.parse(entry.value);
				if (typeof obj === "object" && obj !== null) {
					const redacted: Record<string, string> = {};
					for (const [k, v] of Object.entries(obj)) {
						redacted[k] = v ? "__REDACTED__" : "";
					}
					entry.value = JSON.stringify(redacted);
					result[key] = entry;
				}
			} catch { /* leave as-is */ }
		}
	}
	return result;
}

/** Merge secrets into sandbox_tokens for GET responses (adds value from SecretsStore).
 *  Operates on a config object whose `sandbox_tokens` is the structured array (or absent). */
function mergeSecretsIntoTokens(config: Record<string, unknown>, secretsStore: import("./agent/secrets-store.js").SecretsStore): void {
	const tokens = config.sandbox_tokens;
	if (!Array.isArray(tokens)) return;
	const secrets = secretsStore.getAll();
	config.sandbox_tokens = (tokens as Array<any>).map((e: any) => ({
		...e,
		value: secrets[e.key] || e.value || "",
	}));
}

/** Strip redacted sentinel from incoming structured sandbox_tokens, persisting real values
 *  to the SecretsStore. Returns the structured array suitable for setSandboxTokens(). */
function mergeSandboxTokensStructured(
	incoming: Array<{ key: string; enabled?: boolean; value?: string }>,
	secretsStore?: import("./agent/secrets-store.js").SecretsStore | null,
): Array<{ key: string; enabled: boolean }> {
	if (secretsStore) {
		const updates: Record<string, string> = {};
		for (const e of incoming) {
			if (!e || typeof e.key !== "string") continue;
			if (e.value === "__REDACTED__") {
				// Keep existing
			} else if (e.value) {
				updates[e.key] = e.value;
			} else {
				updates[e.key] = "";
			}
		}
		secretsStore.update(updates);
	}
	return incoming
		.filter(e => e && typeof e.key === "string")
		.map(e => ({ key: e.key, enabled: e.enabled !== false }));
}

/** Merge redacted sentinel values with existing stored values before saving. */
function mergeSandboxSecrets(updates: Record<string, string>, configStore: import("./agent/project-config-store.js").ProjectConfigStore, secretsStore?: import("./agent/secrets-store.js").SecretsStore | null): void {
	// sandbox_tokens is now handled via mergeSandboxTokensStructured at the
	// migrated-fields layer in the PUT handler. This helper only handles the
	// remaining legacy flat sandbox_credentials key.
	void configStore;
	void secretsStore;
	if (updates.sandbox_credentials) {
		try {
			const incoming = JSON.parse(updates.sandbox_credentials) as Record<string, string>;
			const existingRaw = configStore.get("sandbox_credentials") || "";
			let existingObj: Record<string, string> = {};
			try { existingObj = existingRaw ? JSON.parse(existingRaw) : {}; } catch { /* ignore */ }
			for (const [k, v] of Object.entries(incoming)) {
				if (v === "__REDACTED__") {
					incoming[k] = existingObj[k] || "";
				}
			}
			updates.sandbox_credentials = JSON.stringify(incoming);
		} catch { /* leave as-is */ }
	}
}

function parseGateInspectIntegerParam(params: URLSearchParams, name: string): number | undefined {
	const raw = params.get(name);
	if (raw === null || raw === "") return undefined;
	if (!/^-?\d+$/.test(raw)) throw new TextSelectionError(`${name} must be an integer`);
	return Number(raw);
}

function parseGateInspectSelectionOptions(params: URLSearchParams): TextSelectionOptions {
	const rawMode = params.get("mode");
	let mode: TextSelectionMode | undefined;
	if (rawMode !== null) {
		if (!["full", "grep", "head", "tail", "slice"].includes(rawMode)) {
			throw new TextSelectionError(`mode must be one of: full, grep, head, tail, slice`);
		}
		mode = rawMode as TextSelectionMode;
	}
	return {
		mode,
		implicitDefault: rawMode === null,
		pattern: params.get("pattern") ?? undefined,
		context: parseGateInspectIntegerParam(params, "context"),
		maxResults: parseGateInspectIntegerParam(params, "max_results"),
		lines: parseGateInspectIntegerParam(params, "lines"),
		from: parseGateInspectIntegerParam(params, "from"),
		to: parseGateInspectIntegerParam(params, "to"),
	};
}

async function handleApiRoute(
	url: URL,
	req: http.IncomingMessage,
	res: http.ServerResponse,
	sessionManager: SessionManager,
	config: GatewayConfig,
	colorStore: ColorStore,
	prStatusStore: PrStatusStore,
	teamManager: TeamManager,
	orchestrationCore: OrchestrationCore,
	roleManager: RoleManager,
	toolManager: ToolManager,
	projectContextManager: ProjectContextManager,
	bgProcessManager: BgProcessManager,
	staffManager: StaffManager,
	verificationHarness: VerificationHarness,
	preferencesStore: PreferencesStore,
	projectConfigStore: ProjectConfigStore,
	groupPolicyStore: ToolGroupPolicyStore,
	broadcastToGoal: (goalId: string, event: any) => void,
	broadcastToAll: (event: any) => void,
	sandboxManager: SandboxManager | null,
	projectRegistry: ProjectRegistry,
	configCascade: ConfigCascade,
	sandboxScope?: SandboxScope,
	sandboxTokenStore?: SandboxTokenStore,
	reviewAnnotationStore?: ReviewAnnotationStore,
	_broadcastToSession?: (sessionId: string, event: any) => void,
	roleStore?: RoleStore,
	inboxManager?: InboxManager,
	marketplaceSourceStore?: MarketplaceSourceStore,
	marketplaceInstaller?: MarketplaceInstaller,
	cookieStore?: CookieStore,
	actionDispatcher?: ActionDispatcher,
	routeDispatcherArg?: RouteDispatcher,
	routeRegistryArg?: RouteRegistry,
	packContributionRegistryArg?: PackContributionRegistry,
	extensionChannelServices?: ExtensionChannelServices,
	fetchImpl: typeof fetch = fetch,
	commandRunner?: CommandRunner,
	fsImpl?: FsLike,
	clock?: Clock,
) {
	// These are always wired by the sole caller; the optional markers are only to avoid
	// touching every existing signature site.
	const serverRoleStore = roleStore!;
	const dispatcher = actionDispatcher!;
	// Slice B3: the route dispatcher + pack-level route registry (always wired by the
	// sole caller alongside actionDispatcher).
	const routeDispatcher = routeDispatcherArg!;
	const routeRegistry = routeRegistryArg!;
	// pack-schema-v1 §5.2: the project-scoped pack-contribution registry (panels /
	// entrypoints / routes), always wired by the sole caller.
	const packContributionRegistry = packContributionRegistryArg!;
	/** Serialize a cascade-resolved item with origin/overrides + market-pack tags (design §5.2). */
	const withOrigin = (r: { item: Record<string, unknown>; origin: unknown; overrides?: unknown; originPackId?: string | null; originPackName?: string | null }): Record<string, unknown> => ({
		...r.item,
		origin: r.origin,
		...(r.overrides ? { overrides: r.overrides } : {}),
		// Always emit originPackId/originPackName (null for builtin/user entities)
		// so roles/tools match the skills wire shape (finding #3).
		originPackId: r.originPackId ?? null,
		originPackName: r.originPackName ?? null,
	});
	const resolveRoleForProject = (roleId: string, projectId?: string): Role | undefined => {
		const cascadeRole = configCascade.resolveRoles(projectId).find(r => r.item.name === roleId)?.item;
		return cascadeRole ?? roleManager.getRole(roleId);
	};
	const broadcastStaffChanged = (event: Extract<ServerMessage, { type: "staff_changed" }>): void => {
		try {
			broadcastToAll(event);
		} catch (err) {
			console.error(`[broadcast] staff_changed failed for ${event.staffId}:`, err);
		}
	};
	type RoleCreateOptions = { rolePrompt?: string; roleName: string; role: string; accessory?: string; initialModel?: string; initialThinkingLevel?: string };
	const roleCreateOptions = (role: Role): RoleCreateOptions => {
		const initialModel = typeof role.model === "string" && /^[^/]+\/.+$/.test(role.model) && isSessionSelectableModelString(role.model)
			? role.model
			: undefined;
		const initialThinkingLevel = clampRoleThinking(role.thinkingLevel, initialModel);
		return {
			rolePrompt: role.promptTemplate,
			roleName: role.name,
			role: role.name,
			accessory: role.accessory,
			...(initialModel ? { initialModel } : {}),
			...(initialThinkingLevel ? { initialThinkingLevel } : {}),
		};
	};
	// Roles/tools resolution is recomputed per call; the slash-skills TTL cache
	// and the ToolManager mtime-keyed scan cache both need busting after a
	// marketplace pack-list mutation (design §9.1 / finding #1) so newly
	// installed/updated/removed market-pack tool roots are re-scanned (Windows
	// coarse-mtime can otherwise serve a stale scan after a re-copy update).
	const closeUnavailableExtensionChannels = (): void => {
		const registry = extensionChannelServices?.registry as any;
		const closeUnavailable = registry?.closeUnavailablePacks;
		if (typeof closeUnavailable !== "function") return;
		void Promise.resolve(closeUnavailable.call(registry)).catch((err) => {
			console.warn("[extension-channels] closeUnavailablePacks failed after resolver invalidation:", err);
		});
	};
	const invalidateResolverCaches = (): void => { invalidateSlashSkillsCache(); __resetToolScanCache(); toolManager.clearScopedPiExtensionTools(); piExtensionDiscoveryCache.clear(); dispatcher.invalidate(); routeDispatcher.invalidate(); routeRegistry.invalidate(); packContributionRegistry.invalidate(); closeUnavailableExtensionChannels(); };
	const refreshMcpExternalTools = (): void => {
		sessionManager.refreshExternalMcpToolRegistrations();
	};
	const reloadMcpAfterMarketplaceMutation = async (scope?: InstallScope, projectId?: string): Promise<McpReloadResult | undefined> => {
		const result = await sessionManager.reloadMcpAfterMarketplaceMutation(scope, projectId);
		refreshMcpExternalTools();
		return result;
	};
	// Host-owned activation-cache invalidation: a pack persisting provider config
	// (key `provider-config:*`) must drop the activation-filtered provider index so
	// a dormant provider (e.g. Hindsight gaining an externalUrl) activates WITHOUT a
	// gateway restart. Wired into every pack store-write path (route `host.store`
	// puts + the `/api/ext/store/:op` endpoint). Non-config keys are ignored.
	const notePackStoreWrite = (key: unknown): void => {
		if (typeof key === "string" && key.startsWith(PROVIDER_CONFIG_KEY_PREFIX)) invalidateResolverCaches();
	};
	// pack-schema-v1 §6.6: scoped-endpoint authorization for a PACK-BOUND surface
	// token (no carrier tool). The token validation already proved installed +
	// active + own-session via the pack-contribution registry, so allowedTools is
	// NOT consulted (the new trust boundary, §4.5); we only re-check that the body
	// session matches the header-canonical session and that the session resolves.
	const packBoundScopedGuard = (
		headerSid: string | undefined,
		bodySid: unknown,
		resolveSession: (id: string) => ActionGuardSession | undefined,
	): { ok: true; sessionId: string } | { ok: false; status: number; error: string } => {
		if (!headerSid) return { ok: false, status: 403, error: "missing session" };
		if (bodySid !== undefined && bodySid !== null && bodySid !== headerSid) {
			return { ok: false, status: 403, error: "session mismatch" };
		}
		if (!resolveSession(headerSid)) return { ok: false, status: 403, error: "unknown session" };
		return { ok: true, sessionId: headerSid };
	};
	const json = (data: unknown, status = 200) => {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(data));
	};
	const noContent = () => {
		res.writeHead(204);
		res.end();
	};
	const jsonError = (status: number, err: unknown, extra?: Record<string, unknown>) => {
		const e = err instanceof Error ? err : new Error(String(err));
		// Log stack trace server-side only; do not send it to clients to avoid
		// leaking host paths, source line numbers, and implementation details.
		console.error(`[api] ${status} error:`, e.stack ?? e.message);
		json({ error: e.message, ...extra }, status);
	};
	const hasPagingParams = (): boolean => ["limit", "offset", "after", "cursor"].some(param => url.searchParams.has(param));
	const parsePagingInt = (value: string | null, fallback: number, min: number, max: number): number => {
		const parsed = value === null ? fallback : parseInt(value, 10);
		const safe = Number.isFinite(parsed) ? parsed : fallback;
		return Math.min(Math.max(min, safe), max);
	};
	const readOffsetPaging = (): { enabled: boolean; limit: number; offset: number } => ({
		enabled: hasPagingParams(),
		limit: parsePagingInt(url.searchParams.get("limit"), 50, 1, 200),
		offset: parsePagingInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER),
	});
	const pageArray = <T>(items: T[], paging = readOffsetPaging()): { items: T[]; total: number; limit: number; offset: number; hasMore: boolean; nextOffset?: number } => {
		const total = items.length;
		const start = Math.min(paging.offset, total);
		const end = start + paging.limit;
		const pagedItems = items.slice(start, end);
		const hasMore = end < total;
		return {
			items: pagedItems,
			total,
			limit: paging.limit,
			offset: paging.offset,
			hasMore,
			...(hasMore ? { nextOffset: end } : {}),
		};
	};

	const canonicalPathForCompare = (inputPath: string): string => {
		let resolved = path.resolve(inputPath);
		try { resolved = path.resolve(fs.realpathSync(resolved)); } catch { /* textual fallback */ }
		const normalized = resolved.replace(/\\/g, "/").replace(/\/+$/, "");
		return process.platform === "win32" ? normalized.toLowerCase() : normalized;
	};
	const samePath = (a: string, b: string): boolean => canonicalPathForCompare(a) === canonicalPathForCompare(b);
	const headquartersProject = (): RegisteredProject | undefined => projectRegistry.get(HEADQUARTERS_PROJECT_ID);
	const isHeadquartersOwnedPath = (candidatePath: string): boolean => {
		const hq = headquartersProject();
		return !!hq && samePath(candidatePath, hq.rootPath);
	};
	const shouldShowHeadquartersInProjectLists = (): boolean => preferencesStore.get("showHeadquartersInProjectLists") !== false;
	const listProjectsForApi = (): RegisteredProject[] => projectRegistry.list().filter(project => {
		if (project.hidden || isSystemProject(project)) return false;
		if (isHeadquartersProject(project) && !shouldShowHeadquartersInProjectLists()) return false;
		return true;
	});
	const writeProjectResolutionError = (resolved: Extract<ReturnType<typeof resolveProjectForRequest>, { ok: false }>): void => {
		json({ error: resolved.error, code: resolved.code }, resolved.status);
	};
	const writeCwdValidationError = (validation: Extract<ReturnType<typeof validateExecutionCwd>, { ok: false }>): void => {
		json({ error: validation.error, code: validation.code }, validation.status);
	};
	const writeSpecialProjectMutationError = (err: unknown): boolean => {
		if (!(err instanceof SpecialProjectMutationError)) return false;
		json({ error: err.message, code: err.code }, err.status);
		return true;
	};

	/** Subgoals feature gate. Writes 403 SUBGOALS_DISABLED + returns false when off. */
	function requireSubgoalsEnabled(): boolean {
		// Subgoals default OFF (aligned with PR #497) — only an explicit `true` enables.
		if (preferencesStore.get("subgoalsEnabled") === true) return true;
		json({ error: "Subgoals are disabled", code: "SUBGOALS_DISABLED" }, 403);
		return false;
	}

	if (await handleSidePanelWorkspaceRoute(url, req, res, {
		sessionManager,
		readBody,
		broadcastToSession: _broadcastToSession,
		packContributionRegistry,
	})) return;

	if (await handlePrWalkthroughApiRoute(url, req, res, {
		defaultCwd: config.defaultCwd,
		readBody,
		sessionManager,
		broadcast: broadcastToAll,
		resolveSessionCwd: (sessionId: string) => {
			const live = sessionManager.getSession(sessionId);
			const persisted = sessionManager.getPersistedSession(sessionId);
			return live?.worktreePath || persisted?.worktreePath || live?.cwd || persisted?.cwd;
		},
		resolveSessionModel: (sessionId: string) => {
			const persisted = sessionManager.getPersistedSession(sessionId);
			return persisted?.modelProvider && persisted.modelId ? `${persisted.modelProvider}/${persisted.modelId}` : undefined;
		},
		preferencesStore,
		sandboxScope,
		// host.agents reviewer migration (design Decisions C/D/E): the binding-routed
		// submit-yaml/bundle paths resolve the jobId from the pack-store binding keyed
		// by the verified caller session id, and submit-yaml server-dismisses the
		// reviewer child on terminal (terminal-synchronous reap).
		orchestrationCore,
		packStore: getPackStore(),
		sessionSecretStore: sessionManager.sessionSecretStore,
		commandRunner: serverCommandRunner,
		noExternal: serverRuntimeFlags.testNoExternal || serverRuntimeFlags.e2e,
	})) return;

	// ── Cross-project helper functions ─────────────────────────────

	/** Retrieve a goal from any project context. */
	function getGoalAcrossProjects(goalId: string): PersistedGoal | undefined {
		const ctx = projectContextManager.getContextForGoal(goalId);
		return ctx?.goalStore.get(goalId);
	}

	/** List live goals across all projects, optionally filtered by projectId. */
	function listGoalsAcrossProjects(opts?: { projectId?: string }): PersistedGoal[] {
		if (opts?.projectId) {
			const ctx = projectContextManager.getOrCreate(opts.projectId);
			return ctx ? ctx.goalStore.getLive() : [];
		}
		return projectContextManager.getAllLiveGoals();
	}

	/** Resolve per-project config store, falling back to the default. */
	function resolveProjectConfigStore(pid: string | null): ProjectConfigStore {
		const effectiveProjectId = normalizeConfigProjectId(pid ?? undefined);
		if (effectiveProjectId && projectContextManager) {
			const ctx = projectContextManager.getOrCreate(effectiveProjectId);
			if (ctx) return ctx.projectConfigStore;
		}
		return projectConfigStore;
	}

	type RoleMutationTarget =
		| { scope: "server"; store: RoleStore; manager: RoleManager }
		| { scope: "project"; store: RoleStore; projectId: string };

	/**
	 * The hidden internal `system` project is compatibility-only and never a
	 * user-facing config scope. Role/tool config mutations that arrive scoped to
	 * `system` — e.g. from server-scope role/tool assistant proposals whose
	 * session resolves to the hidden system project — must instead resolve to
	 * Headquarters (server/global) scope so the config lands in the visible
	 * Headquarters store, not the hidden system role/tool store.
	 */
	function aliasSystemToHeadquartersScope(projectId: string | undefined): string | undefined {
		return projectId === SYSTEM_PROJECT_ID ? HEADQUARTERS_PROJECT_ID : projectId;
	}

	function rawProjectId(value: unknown): string | undefined {
		if (typeof value !== "string") return undefined;
		const trimmed = value.trim();
		return trimmed || undefined;
	}

	function roleMutationProjectId(value: unknown): string | undefined {
		const trimmed = rawProjectId(value);
		return trimmed ? aliasSystemToHeadquartersScope(trimmed) : undefined;
	}

	type RequiredConfigProjectScope = {
		ok: true;
		requestedProjectId: string;
		effectiveProjectId?: string;
		context?: ProjectContext;
	};
	type RequiredConfigProjectScopeError = {
		ok: false;
		status: 400 | 404;
		error: string;
		code: string;
	};

	function resolveRequiredConfigProjectScope(projectIdValue: unknown, opts: { aliasSystem?: boolean } = {}): RequiredConfigProjectScope | RequiredConfigProjectScopeError {
		const requestedProjectId = opts.aliasSystem ? roleMutationProjectId(projectIdValue) : rawProjectId(projectIdValue);
		if (!requestedProjectId) {
			return { ok: false, status: 400, error: "projectId required", code: "PROJECT_ID_REQUIRED" };
		}
		const effectiveProjectId = normalizeConfigProjectId(requestedProjectId);
		if (!effectiveProjectId) {
			return { ok: true, requestedProjectId };
		}
		const resolved = resolveProjectForRequest(projectRegistry, { projectId: effectiveProjectId });
		if (!resolved.ok) return resolved;
		const context = projectContextManager.getOrCreate(effectiveProjectId);
		if (!context) {
			return { ok: false, status: 404, error: `Project not found: ${effectiveProjectId}`, code: "PROJECT_NOT_FOUND" };
		}
		return { ok: true, requestedProjectId, effectiveProjectId, context };
	}

	function writeConfigProjectScopeError(error: RequiredConfigProjectScopeError): void {
		json({ error: error.error, code: error.code }, error.status);
	}

	/**
	 * Non-workflow Headquarters role mutations are server-scope aliases. Normal
	 * project ids still resolve to that project's role store.
	 */
	function resolveRoleMutationTarget(rawProjectId: unknown): { ok: true; target: RoleMutationTarget } | RequiredConfigProjectScopeError {
		const resolved = resolveRequiredConfigProjectScope(rawProjectId, { aliasSystem: true });
		if (!resolved.ok) return resolved;
		if (!resolved.effectiveProjectId) return { ok: true, target: { scope: "server", store: serverRoleStore, manager: roleManager } };
		if (!resolved.context) return { ok: false, status: 404, error: `Project not found: ${resolved.effectiveProjectId}`, code: "PROJECT_NOT_FOUND" };
		return { ok: true, target: { scope: "project", store: resolved.context.roleStore, projectId: resolved.effectiveProjectId } };
	}

	/**
	 * Resolve the host-side cwd for slash-skill discovery.
	 * For sandboxed sessions the cwd is a container-internal path (e.g. /workspace-wt/...)
	 * which doesn't exist on the host. Use the project's rootPath instead so skill
	 * files (.claude/skills/, .bobbit/skills/) are found on the host filesystem.
	 */
	function resolveSkillDiscoveryCwd(cwd: string, projectId: string | null | undefined): string {
		if (projectId === HEADQUARTERS_PROJECT_ID) {
			return headquartersProject()?.rootPath ?? bobbitDir();
		}
		const effectiveProjectId = normalizeConfigProjectId(projectId ?? undefined);
		if (effectiveProjectId && projectContextManager) {
			const ctx = projectContextManager.getOrCreate(effectiveProjectId);
			if (ctx) return ctx.project.rootPath;
		}
		return cwd;
	}

	/**
	 * Explicit market-scope wiring for skill discovery (finding #3) — mirrors
	 * the roles/tools `marketScopeContext` so server-scope market skill packs
	 * resolve even when a project's root != the server cwd, and global-user
	 * `pack_order` is read from the SERVER store (not the project store).
	 */
	function skillMarketContext(projectId: string | null | undefined): SkillMarketContext {
		const effectiveProjectId = normalizeConfigProjectId(projectId ?? undefined);
		const ctx = effectiveProjectId && projectContextManager ? projectContextManager.getOrCreate(effectiveProjectId) : undefined;
		const hqRoot = headquartersProject()?.rootPath ?? bobbitDir();
		return {
			serverBase: hqRoot,
			globalUserBase: os.homedir(),
			projectBase: ctx?.project.rootPath ?? "",
			serverConfigStore: projectConfigStore,
			projectConfigStore: ctx?.projectConfigStore,
			// pack-schema-v1 §7: thread the SAME pack_activation store the roles/tools
			// cascade uses (single source of truth) so disabled market-pack skills are
			// filtered out of /api/slash-skills, /api/slash-skills/details, and the
			// conflicts endpoint before the precedence merge. server/global-user read
			// the server config store; project reads the project's config store — the
			// same scope→store split as the cascade's `packActivationStore`.
			packActivation: (scope, packName) => {
				const store = scope === "project" ? ctx?.projectConfigStore : projectConfigStore;
				return store?.getPackActivation(scope as PackOrderScope, packName) ?? {};
			},
		};
	}

	/** Guard shared by the Fork endpoint: reject source sessions that cannot be
	 * forked. The substrings (archived/terminated/delegate/child/read-only/team/
	 * non-interactive) are load-bearing — the API E2E asserts on them. */
	function isUnsupportedForkSource(session: any, ps: any): string | null {
		if (!session || !ps) return "session not found";
		if (ps.archived) return "archived sessions cannot be forked";
		if (session.status === "terminated") return "terminated sessions cannot be forked";
		if (session.delegateOf || ps.delegateOf) return "delegate sessions cannot be forked";
		if (session.parentSessionId || ps.parentSessionId || session.childKind || ps.childKind) return "child sessions cannot be forked";
		if (session.readOnly || ps.readOnly) return "read-only sessions cannot be forked";
		if (session.nonInteractive || ps.nonInteractive) return "non-interactive sessions cannot be forked";
		if (session.teamGoalId || ps.teamGoalId || session.teamLeadSessionId || ps.teamLeadSessionId || session.role === "team-lead" || ps.role === "team-lead") return "team sessions cannot be forked";
		return null;
	}

	/** Get a GoalManager for the project that owns the given goal. Throws if not found. */
	function getGoalManagerForGoal(goalId: string): GoalManager {
		const ctx = projectContextManager.getContextForGoal(goalId);
		if (!ctx) throw new Error(`Goal "${goalId}" not found in any project`);
		return ctx.goalManager;
	}

	/** Get a TaskManager for the project that owns the given goal. Throws if not found. */
	const taskManagerCache = new Map<string, TaskManager>();
	function getTaskManagerForGoal(goalId: string): TaskManager {
		const ctx = projectContextManager.getContextForGoal(goalId);
		if (!ctx) throw new Error(`Goal "${goalId}" not found in any project`);
		const projectId = ctx.project.id;
		let tm = taskManagerCache.get(projectId);
		if (!tm) {
			tm = new TaskManager(ctx.taskStore);
			taskManagerCache.set(projectId, tm);
		}
		return tm;
	}

	/** Get a task and its manager by looking up which project store owns it. */
	function getTaskRecordForTask(taskId: string): { task: PersistedTask; taskManager: TaskManager; projectId: string } | undefined {
		for (const ctx of projectContextManager.all()) {
			const task = ctx.taskStore.get(taskId);
			if (task) return { task, taskManager: getTaskManagerForGoal(task.goalId), projectId: ctx.project.id };
		}
		return undefined;
	}

	/** Get a TaskManager for a task by looking up which goal it belongs to. Throws if not found. */
	function getTaskManagerForTask(taskId: string): TaskManager {
		const record = getTaskRecordForTask(taskId);
		if (record) return record.taskManager;
		throw new Error(`Task "${taskId}" not found in any project`);
	}

	function sandboxCanAccessTask(task: PersistedTask): boolean {
		if (!sandboxScope) return true;
		if (sandboxScope.goalIds.has(task.goalId)) return true;
		json({ error: "Forbidden: task is outside the sandbox scope", code: "SANDBOX_SCOPE_VIOLATION" }, 403);
		return false;
	}

	// GET /api/harness-status — report whether the dev restart harness is active
	if (url.pathname === "/api/harness-status" && req.method === "GET") {
		json({ restartAvailable: process.env.BOBBIT_DEV_HARNESS === "1" });
		return;
	}

	// POST /api/harness/restart — request a dev harness rebuild/restart
	if (url.pathname === "/api/harness/restart" && req.method === "POST") {
		if (process.env.BOBBIT_DEV_HARNESS !== "1") {
			json({ error: "Restart is only available under the dev harness" }, 403);
			return;
		}
		touchGatewayRestartSentinel();
		json({ ok: true, restartRequested: true }, 202);
		return;
	}

	// POST /api/dev/boot-timing — append one client reload-timing sample to
	// <stateDir>/boot-timing.jsonl. Harness-only (same gate as restart): the
	// perf-instrumentation toggle that drives these POSTs is only shown under
	// the dev harness, and we reject here too as defense-in-depth.
	if (url.pathname === "/api/dev/boot-timing" && req.method === "POST") {
		if (process.env.BOBBIT_DEV_HARNESS !== "1") {
			json({ error: "Perf instrumentation is only available under the dev harness" }, 403);
			return;
		}
		const body = await readBody(req);
		if (!body || typeof body !== "object") { json({ error: "Missing body" }, 400); return; }
		const written = recordBootTiming(body);
		if (!written) { json({ error: "Sample rejected" }, 422); return; }
		json({ ok: true, path: path.join(bobbitStateDir(), BOOT_TIMING_FILE) }, 201);
		return;
	}

	// GET /api/dev/boot-timing — read recent reload-timing samples (newest last)
	// for inspection from the UI or tooling. Harness-only. `?limit=N` caps rows.
	if (url.pathname === "/api/dev/boot-timing" && req.method === "GET") {
		if (process.env.BOBBIT_DEV_HARNESS !== "1") {
			json({ error: "Perf instrumentation is only available under the dev harness" }, 403);
			return;
		}
		const limitParamRaw = url.searchParams.get("limit");
		const limit = limitParamRaw ? Math.max(1, Math.min(500, parseInt(limitParamRaw, 10) || 50)) : 50;
		json({ path: path.join(bobbitStateDir(), BOOT_TIMING_FILE), samples: readBootTimings(limit) });
		return;
	}

	// GET /api/health — unauthenticated so the client can probe localhost mode
	if (url.pathname === "/api/health" && req.method === "GET") {
		const isLocalhost = !config.forceAuth && (config.host === "localhost" || config.host === "127.0.0.1" || config.host === "::1");
		json({
			status: "ok",
			sessions: sessionManager.listSessions().length,
			localhost: isLocalhost,
			aigw: !!getAigwUrl(preferencesStore),
			setupComplete: isSetupComplete(),
			orphanedTranscripts: sessionManager.orphanedTranscriptsCount,
		});
		return;
	}

	// POST /api/internal/test/replay-buffered-events/:sessionId — BOBBIT_E2E-only hook
	// used by ST-DEDUP-01 to reproduce live-streaming duplication. Iterates the
	// session's EventBuffer and re-broadcasts each buffered entry on the SAME
	// wire path production uses, so when the fix adds `seq`/`ts` to the
	// broadcast envelope the endpoint will naturally carry them too (because it
	// inspects the buffer's stored entries — which upgrade from raw events to
	// {seq,ts,event} tuples post-fix). Pre-fix: clients receive duplicate
	// events and dupe-append assistant/toolResult messages. Post-fix: clients
	// dedupe by seq and the message list stays stable.
	const replayMatch = url.pathname.match(/^\/api\/internal\/test\/replay-buffered-events\/([^/]+)$/);
	if (replayMatch && req.method === "POST") {
		if (!serverRuntimeFlags.e2e) { json({ error: "BOBBIT_E2E not enabled" }, 403); return; }
		const sessionId = replayMatch[1];
		const session = sessionManager.getSession(sessionId);
		if (!session) { json({ error: "session not found" }, 404); return; }
		const entries = session.eventBuffer.getAll() as any[];
		let replayed = 0;
		const deadline = Date.now() + PACE_TIMEOUT_MS;
		for (const entry of entries) {
			// Accept both raw-event shape (pre-fix) and {seq,ts,event} (post-fix).
			const isWrapped = entry && typeof entry === "object" && "event" in entry && ("seq" in entry || "ts" in entry);
			const framePayload = isWrapped
				? { type: "event" as const, data: entry.event, seq: entry.seq, ts: entry.ts }
				: { type: "event" as const, data: entry };
			const data = JSON.stringify(framePayload);
			for (const client of session.clients) {
				await paceAndSend(client as any, data, deadline);
			}
			replayed++;
		}
		json({ replayed, bufferSize: session.eventBuffer.size });
		return;
	}

	// GET /api/setup-status — check if project setup has been completed
	if (url.pathname === "/api/setup-status" && req.method === "GET") {
		json({ complete: isSetupComplete() });
		return;
	}

	// POST /api/setup-status/dismiss — mark setup as dismissed (writes sentinel file)
	if (url.pathname === "/api/setup-status/dismiss" && req.method === "POST") {
		const stateDir = bobbitStateDir();
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(path.join(stateDir, "setup-complete"), "dismissed\n");
		json({ ok: true });
		return;
	}

	// GET /api/system-prompt-context — read the project context section from system-prompt.md
	if (url.pathname === "/api/system-prompt-context" && req.method === "GET") {
		const systemPromptPath = path.join(bobbitConfigDir(), "system-prompt.md");
		if (!fs.existsSync(systemPromptPath)) { json({ context: "" }); return; }
		try {
			const content = fs.readFileSync(systemPromptPath, "utf-8");
			// Extract everything after the last "# Project Context" heading, or return empty
			const marker = "# Project Context";
			const idx = content.lastIndexOf(marker);
			if (idx === -1) { json({ context: "" }); return; }
			const context = content.slice(idx + marker.length).trim();
			json({ context });
		} catch { json({ context: "" }); }
		return;
	}

	// PUT /api/system-prompt-context — append/replace the project context section in system-prompt.md
	if (url.pathname === "/api/system-prompt-context" && req.method === "PUT") {
		const body = await readBody(req);
		if (!body || typeof body.context !== "string") { json({ error: "Missing context" }, 400); return; }
		const systemPromptPath = path.join(bobbitConfigDir(), "system-prompt.md");
		try {
			let existing = "";
			if (fs.existsSync(systemPromptPath)) {
				existing = fs.readFileSync(systemPromptPath, "utf-8");
			}
			const marker = "# Project Context";
			const idx = existing.lastIndexOf(marker);
			const base = idx !== -1 ? existing.slice(0, idx).trimEnd() : existing.trimEnd();
			const newContent = base + "\n\n" + marker + "\n\n" + body.context.trim() + "\n";
			fs.mkdirSync(path.dirname(systemPromptPath), { recursive: true });
			fs.writeFileSync(systemPromptPath, newContent);
			json({ ok: true });
		} catch (err: any) {
			jsonError(500, err);
		}
		return;
	}

	// POST /api/system-prompt/customise — copy shipped default to .bobbit/config/system-prompt.md
	//   so the user can edit it. If the file already exists it is left unchanged.
	//   Returns { path, created, content }.
	if (url.pathname === "/api/system-prompt/customise" && req.method === "POST") {
		const userPath = path.join(bobbitConfigDir(), "system-prompt.md");
		// Resolve the shipped default via config.builtinsDir when the gateway was
		// pointed at a repo-root `defaults/` (src-booted test harness); production
		// leaves builtinsDir undefined and falls back to the dist-relative path.
		const defaultsBase = config.builtinsDir
			?? path.join(path.dirname(fileURLToPath(import.meta.url)), "defaults");
		const defaultPath = path.join(defaultsBase, "system-prompt.md");
		let created = false;
		try {
			if (!fs.existsSync(userPath)) {
				if (!fs.existsSync(defaultPath)) {
					json({ error: "Default system-prompt.md not found in install" }, 500);
					return;
				}
				fs.mkdirSync(path.dirname(userPath), { recursive: true });
				fs.copyFileSync(defaultPath, userPath);
				created = true;
			}
			const content = fs.readFileSync(userPath, "utf-8");
			json({ path: userPath, created, content });
		} catch (err: any) {
			jsonError(500, err);
		}
		return;
	}

	// POST /api/shutdown — graceful shutdown (used by coverage teardown to flush V8 coverage)
	if (url.pathname === "/api/shutdown" && req.method === "POST") {
		json({ status: "shutting down" });
		// Defer exit to allow the response to be sent
		setTimeout(() => process.exit(0), 500);
		return;
	}

	// GET /api/ca-cert — download the Bobbit CA certificate for device trust
	if (url.pathname === "/api/ca-cert" && req.method === "GET") {
		const caCertPath = config.tls?.caCert;
		if (!caCertPath || !fs.existsSync(caCertPath)) {
			json({ error: "No CA certificate available. Server is using a self-signed certificate." }, 404);
			return;
		}
		const certData = fs.readFileSync(caCertPath);
		res.writeHead(200, {
			// iOS Safari needs this MIME type to offer the profile-install flow.
			"Content-Type": "application/x-x509-ca-cert",
			"Content-Disposition": "attachment; filename=\"bobbit-ca.crt\"",
			"Content-Length": certData.length,
		});
		res.end(certData);
		return;
	}

	// GET /api/sandbox-pool (deprecated — no longer a real pool, returns basic stats)
	if (url.pathname === "/api/sandbox-pool" && req.method === "GET") {
		if (sandboxManager) {
			const stats = sandboxManager.getStats();
			json({ ...stats, type: "sandbox" });
		} else {
			json({ enabled: false });
		}
		return;
	}

	// GET /api/worktree-pool
	if (url.pathname === "/api/worktree-pool" && req.method === "GET") {
		const projectId = url.searchParams.get("projectId");
		if (projectId) {
			const pool = sessionManager.getWorktreePool(projectId);
			json(pool ? pool.getStatus() : { enabled: false, ready: 0, target: 0, filling: false });
		} else {
			const pools: Record<string, any> = {};
			for (const [pid, pool] of sessionManager.getAllWorktreePools()) {
				pools[pid] = pool.getStatus();
			}
			json({ pools });
		}
		return;
	}

	// GET /api/sandbox-status
	if (url.pathname === "/api/sandbox-status" && req.method === "GET") {
		const projectId = url.searchParams.get("projectId") || undefined;
		const resolved = resolveProjectForRequest(projectRegistry, { projectId });
		if (!resolved.ok) { writeProjectResolutionError(resolved); return; }
		const scopedConfigStore = resolveProjectConfigStore(resolved.projectId);
		const sandboxConfig = scopedConfigStore.get("sandbox") || "none";
		const imageName = scopedConfigStore.get("sandbox_image") || "bobbit-agent";
		const configured = sandboxConfig === "docker";
		const dockerContextRoot = resolveSandboxDockerContext(resolved.project.rootPath);
		const status = await checkDockerAvailability(configured ? imageName : undefined, dockerContextRoot ?? undefined);
		json({ ...status, configured });
		return;
	}

	// POST /api/sandbox-image/build
	if (url.pathname === "/api/sandbox-image/build" && req.method === "POST") {
		const body = await readBody(req).catch(() => null);
		const projectId = (body && typeof body === "object" && typeof (body as any).projectId === "string")
			? (body as any).projectId
			: url.searchParams.get("projectId") || undefined;
		const resolved = resolveProjectForRequest(projectRegistry, { projectId });
		if (!resolved.ok) { writeProjectResolutionError(resolved); return; }
		const scopedConfigStore = resolveProjectConfigStore(resolved.projectId);
		const imageName = scopedConfigStore.get("sandbox_image") || "bobbit-agent";
		const dockerContextRoot = resolveSandboxDockerContext(resolved.project.rootPath);
		if (!dockerContextRoot) {
			json({ error: "Dockerfile not found at docker/Dockerfile" }, 404);
			return;
		}
		if (isBuildingImage()) {
			json({ error: "Build already in progress" }, 409);
			return;
		}
		const result = await buildSandboxImage(imageName, dockerContextRoot);
		if (result.success) {
			json({ success: true });
		} else {
			json({ success: false, error: result.error }, 500);
		}
		return;
	}

	// GET /api/sandbox/host-tokens
	if (url.pathname === "/api/sandbox/host-tokens" && req.method === "GET") {
		const tokens = detectHostTokens(preferencesStore);
		json(tokens);
		return;
	}
	// ── Project Detection & Browse ────────────────────────────────────

	// GET /api/projects/preflight?path=<absolute>
	// Returns a structured PreflightReport — always 200 when path is
	// supplied; the failures are *the* response. 400 only for missing /
	// bad-shape input.
	if (url.pathname === "/api/projects/preflight" && req.method === "GET") {
		const rawPath = url.searchParams.get("path");
		if (!rawPath || typeof rawPath !== "string") {
			json({ error: "Missing path query parameter" }, 400);
			return;
		}
		try {
			const report = runPreflight(rawPath, {
				registeredProjects: projectRegistry.list(),
				gatewayProjectRoot: getProjectRoot(),
				worktreeRootFor: (p) => {
					const ctx = projectContextManager.getOrCreate(p.id);
					return ctx?.projectConfigStore.get("worktree_root") || undefined;
				},
			});
			if (isHeadquartersOwnedPath(rawPath)) {
				for (const check of report.checks) {
					if (check.remediation?.kind === "archive-bobbit") delete check.remediation;
					if (check.id === "bobbit.existing") {
						check.title = "Server .bobbit/ belongs to Headquarters";
						check.detail = "Headquarters already represents this server workspace. Its .bobbit/ state is gateway-owned and cannot be archived from Add Project.";
					}
					if (check.id === "bobbit.gateway-owned") {
						check.title = "Headquarters workspace";
						check.detail = "Headquarters already represents the running gateway's server workspace.";
					}
				}
			}
			json(report);
		} catch (err: any) {
			jsonError(500, err);
		}
		return;
	}

	// POST /api/projects/archive-bobbit
	// Body: { rootPath }. Moves existing project-scoped .bobbit/ content
	// aside into .bobbit-archive-NNN/ — never touching the
	// GATEWAY_OWNED_FILES allowlist. Does NOT mutate the registry; the
	// client re-runs /preflight afterwards.
	if (url.pathname === "/api/projects/archive-bobbit" && req.method === "POST") {
		const body = await readBody(req);
		if (!body || typeof body.rootPath !== "string") {
			json({ error: "Missing rootPath" }, 400);
			return;
		}
		if (!path.isAbsolute(body.rootPath)) {
			json({ error: "rootPath must be absolute" }, 400);
			return;
		}
		if (!fs.existsSync(body.rootPath)) {
			json({ error: "rootPath does not exist" }, 400);
			return;
		}
		if (isHeadquartersOwnedPath(body.rootPath)) {
			json({
				error: "Headquarters is managed by the server and cannot be archived. Hide it from project lists in Settings instead.",
				code: "HEADQUARTERS_IMMUTABLE",
			}, 403);
			return;
		}
		// Compute gateway-owned via canonical paths so a symlink/junction to the
		// server run dir cannot archive Headquarters by dodging a textual compare.
		const sameAsGateway = samePath(body.rootPath, getProjectRoot());
		const hasGwUrl = fs.existsSync(path.join(body.rootPath, ".bobbit", "state", "gateway-url"));
		const hasWatchdog = fs.existsSync(path.join(body.rootPath, ".bobbit", "state", "watchdog.json"));
		const gatewayOwned = sameAsGateway || hasGwUrl || hasWatchdog;
		// Preserve the Headquarters/server workspace directory when it lives
		// inside this project's `.bobbit/`. The default is `.bobbit/headquarters`,
		// but a `BOBBIT_DIR`/`BOBBIT_PI_DIR` override (e.g. `.bobbit/custom-hq`)
		// moves it — archiving a normal same-root project's `.bobbit` must never
		// move or delete server/HQ state, so preserve the ACTUAL directory by its
		// real relative segment, not just the literal `headquarters/` name.
		const rootBobbitDir = path.join(body.rootPath, ".bobbit");
		const preserveEntries: string[] = [];
		if (fs.existsSync(path.join(rootBobbitDir, "headquarters"))) preserveEntries.push("headquarters/");
		try {
			const realRootBobbit = fs.realpathSync(rootBobbitDir);
			const actualHqDir = bobbitDir();
			if (fs.existsSync(actualHqDir)) {
				const rel = path.relative(realRootBobbit, fs.realpathSync(actualHqDir));
				if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
					const entry = rel.replace(/\\/g, "/") + "/";
					if (!preserveEntries.includes(entry)) preserveEntries.push(entry);
				}
			}
		} catch { /* .bobbit or HQ dir missing — fall back to default headquarters/ preservation */ }
		const allowlistEntries = [
			...(gatewayOwned ? GATEWAY_OWNED_FILES : []),
			...preserveEntries,
		];
		const allowlist = allowlistEntries.length > 0 ? allowlistEntries : undefined;
		try {
			const result = archiveProjectBobbitDir(body.rootPath, { gatewayOwned, ...(allowlist ? { allowlist } : {}) });
			json(result);
		} catch (err: any) {
			if (err instanceof ArchiveError) {
				const status = err.code === "empty-bobbit-dir" || err.code === "no-bobbit-dir" ? 409 : 400;
				json({ error: err.message, code: err.code }, status);
				return;
			}
			jsonError(500, err);
		}
		return;
	}

	// POST /api/projects/detect
	if (url.pathname === "/api/projects/detect" && req.method === "POST") {
		const body = await readBody(req);
		if (!body || typeof body.path !== "string") {
			json({ error: "Missing path" }, 400);
			return;
		}
		const dirPath = path.resolve(body.path);
		const exists = fs.existsSync(dirPath);
		let hasBobbit = false;
		let isEmpty = true;
		let hasPackageJson = false;
		let hasCargoToml = false;
		let hasGoMod = false;
		let name = path.basename(dirPath);

		if (exists) {
			try {
				const stat = fs.statSync(dirPath);
				if (stat.isDirectory()) {
					const entries = fs.readdirSync(dirPath);
					isEmpty = entries.length === 0;
					// Source of truth: a configured project is one with .bobbit/config/project.yaml.
					// Mere presence of an empty .bobbit/ (e.g. post-archive shape, ghost dirs) must NOT
					// route the add-project flow to auto-import. See goal: Post-archive → assistant.
					hasBobbit = fs.existsSync(path.join(dirPath, ".bobbit", "config", "project.yaml"));
					hasPackageJson = entries.includes("package.json");
					hasCargoToml = entries.includes("Cargo.toml");
					hasGoMod = entries.includes("go.mod");

					// Try to read name from package.json
					if (hasPackageJson) {
						try {
							const pkg = JSON.parse(fs.readFileSync(path.join(dirPath, "package.json"), "utf-8"));
							if (typeof pkg.name === "string" && pkg.name) {
								name = pkg.name;
							}
						} catch {
							// Ignore parse errors — fall back to directory basename
						}
					}
				} else {
					// Path exists but is not a directory
					json({ error: "Path is not a directory" }, 400);
					return;
				}
			} catch {
				// stat failed — treat as non-existent
				json({ exists: false, hasBobbit: false, isEmpty: true, hasPackageJson: false, hasCargoToml: false, hasGoMod: false, name });
				return;
			}
		}

		json({ exists, hasBobbit, isEmpty, hasPackageJson, hasCargoToml, hasGoMod, name });
		return;
	}

	// POST /api/projects/scan?path=...  → run repo-scan on a folder.
	// Returns { repos: DetectedRepo[] }. Used by the Add-Project flow and
	// Settings → "Re-scan repos". Phase 4b — see docs/design/multi-repo-components.md §8.1.
	if (url.pathname === "/api/projects/scan" && req.method === "POST") {
		const body = await readBody(req).catch(() => ({}));
		const rawPath = url.searchParams.get("path") ?? (body && typeof body.path === "string" ? body.path : "");
		if (!rawPath) { json({ error: "Missing path" }, 400); return; }
		const dirPath = path.resolve(rawPath);
		if (!fs.existsSync(dirPath)) { json({ error: "Path not found" }, 404); return; }
		try {
			const { scanRepos } = await import("./agent/repo-scan.js");
			const { scanMonorepo } = await import("./agent/monorepo-scan.js");
			const repos = await scanRepos(dirPath);
			const monorepo = scanMonorepo(dirPath);
			json({ repos, monorepo });
		} catch (err: any) {
			jsonError(500, err);
		}
		return;
	}

	// GET /api/projects/:id/structured  → returns { components, workflows,
	// worktree_root } in their structured (non-string) shape. Used by the
	// Settings → Components tab so the UI doesn't have to parse YAML.
	// Phase 4b.
	const projectStructuredMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/structured$/);
	if (projectStructuredMatch && req.method === "GET") {
		const ctx = projectContextManager.getOrCreate(projectStructuredMatch[1]);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }
		const components = ctx.projectConfigStore.getComponents();
		const workflows = ctx.projectConfigStore.getWorkflows() ?? {};
		const worktreeRoot = ctx.projectConfigStore.get("worktree_root") ?? "";
		json({ components, workflows, worktree_root: worktreeRoot });
		return;
	}

	// POST /api/projects/:id/rescan-repos  → re-run repo-scan on the
	// project's rootPath; returns the same shape as /api/projects/scan.
	// Settings "Re-scan repos" button. Phase 4b.
	const projectRescanMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/rescan-repos$/);
	if (projectRescanMatch && req.method === "POST") {
		const project = projectRegistry.get(projectRescanMatch[1]);
		if (!project) { json({ error: "Project not found" }, 404); return; }
		try {
			const { scanRepos } = await import("./agent/repo-scan.js");
			const { scanMonorepo } = await import("./agent/monorepo-scan.js");
			const repos = await scanRepos(project.rootPath);
			const monorepo = scanMonorepo(project.rootPath);
			json({ repos, monorepo, rootPath: project.rootPath });
		} catch (err: any) {
			jsonError(500, err);
		}
		return;
	}

	// POST /api/create-directory
	if (url.pathname === "/api/create-directory" && req.method === "POST") {
		const body = await readBody(req).catch(() => null);
		const rawPath = typeof body?.path === "string" ? body.path.trim() : "";
		if (!rawPath || !path.isAbsolute(rawPath)) {
			json({ error: "Enter an absolute directory path.", code: "invalid_path" }, 400);
			return;
		}

		const targetPath = path.resolve(rawPath);
		try {
			const targetStat = fs.statSync(targetPath);
			if (targetStat.isDirectory()) {
				json({ error: "Directory already exists", code: "already_exists" }, 409);
			} else {
				json({ error: "A file already exists at that path", code: "exists_as_file" }, 409);
			}
			return;
		} catch (err: any) {
			if (err?.code && err.code !== "ENOENT") {
				if (err.code === "EACCES" || err.code === "EPERM") {
					json({ error: "Permission denied creating this directory", code: "permission_denied" }, 403);
					return;
				}
				json({ error: err?.message || "Could not check directory", code: "create_failed" }, 500);
				return;
			}
		}

		const parentPath = path.dirname(targetPath);
		try {
			const parentStat = fs.statSync(parentPath);
			if (!parentStat.isDirectory()) {
				json({ error: "The parent directory does not exist", code: "parent_not_found" }, 404);
				return;
			}
		} catch (err: any) {
			if (err?.code === "EACCES" || err?.code === "EPERM") {
				json({ error: "Permission denied creating this directory", code: "permission_denied" }, 403);
			} else {
				json({ error: "The parent directory does not exist", code: "parent_not_found" }, 404);
			}
			return;
		}

		try {
			fs.mkdirSync(targetPath, { recursive: false });
			json({ path: targetPath });
		} catch (err: any) {
			if (err?.code === "EEXIST") {
				json({ error: "Directory already exists", code: "already_exists" }, 409);
			} else if (err?.code === "EACCES" || err?.code === "EPERM") {
				json({ error: "Permission denied creating this directory", code: "permission_denied" }, 403);
			} else if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
				json({ error: "The parent directory does not exist", code: "parent_not_found" }, 404);
			} else {
				json({ error: err?.message || "Could not create directory", code: "create_failed" }, 500);
			}
		}
		return;
	}

	// GET /api/browse-directory
	if (url.pathname === "/api/browse-directory" && req.method === "GET") {
		const rawPath = url.searchParams.get("path");
		const rawPrefix = url.searchParams.get("prefix") ?? "";
		const prefix = rawPrefix.toLowerCase();
		const rawLimit = url.searchParams.get("limit");
		const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : 0;
		const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 200) : 0;
		const dirPath = rawPath ? path.resolve(rawPath) : config.defaultCwd;

		if (!fs.existsSync(dirPath)) {
			json({ error: "Directory not found" }, 404);
			return;
		}

		try {
			const stat = fs.statSync(dirPath);
			if (!stat.isDirectory()) {
				json({ error: "Path is not a directory" }, 400);
				return;
			}
		} catch {
			json({ error: "Cannot access path" }, 400);
			return;
		}

		const entries: Array<{ name: string; path: string }> = [];
		let truncated = false;
		try {
			const items = fs.readdirSync(dirPath)
				.filter((item) => {
					// Skip hidden directories and node_modules
					if (item.startsWith(".") || item === "node_modules") return false;
					return !prefix || item.toLowerCase().startsWith(prefix);
				})
				.sort((a, b) => a.localeCompare(b));
			for (const item of items) {
				const fullPath = path.join(dirPath, item);
				try {
					const stat = fs.lstatSync(fullPath);
					if (stat.isDirectory() && !stat.isSymbolicLink()) {
						entries.push({ name: item, path: fullPath });
						if (limit > 0 && entries.length >= limit) {
							truncated = true;
							break;
						}
					}
				} catch {
					// Skip entries we can't stat
				}
			}
		} catch {
			json({ error: "Cannot read directory" }, 500);
			return;
		}

		const parsed = path.parse(dirPath);
		const parent = parsed.root === dirPath ? null : path.dirname(dirPath);

		json({ current: dirPath, parent, entries, truncated });
		return;
	}

	// ── Project CRUD ──────────────────────────────────────────────────

	// GET /api/projects
	if (url.pathname === "/api/projects" && req.method === "GET") {
		const projects = listProjectsForApi();
		const paging = readOffsetPaging();
		if (paging.enabled) {
			const page = pageArray(projects, paging);
			json({ projects: page.items, total: page.total, limit: page.limit, offset: page.offset, hasMore: page.hasMore, ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}) });
			return;
		}
		json(projects);
		return;
	}

	// POST /api/projects
	if (url.pathname === "/api/projects" && req.method === "POST") {
		const body = await readBody(req);
		if (typeof body?.name !== "string" || typeof body?.rootPath !== "string") {
			json({ error: "Missing name or rootPath" }, 400);
			return;
		}
		// Validate components[].config eagerly (mirrors propose_project tool).
		{
			const err = validateComponentsConfig((body as Record<string, unknown>).components);
			if (err) { json({ error: err }, 400); return; }
		}
		try {
			const upsert = body.upsert === true;
			const color = typeof body.color === "string" ? body.color : undefined;
			const palette = typeof body.palette === "string" ? body.palette : undefined;
			const colorLight = typeof body.colorLight === "string" ? body.colorLight : undefined;
			const colorDark = typeof body.colorDark === "string" ? body.colorDark : undefined;

			if (isHeadquartersOwnedPath(body.rootPath)) {
				const hq = headquartersProject();
				if (hq && upsert) {
					const ctx = projectContextManager.getOrCreate(hq.id);
					if (ctx) {
						ctx.gateStore.onStatusChange = () => {
							ctx.goalStore.bumpGeneration();
						};
						wireGoalManagerResolvers(ctx, { sessionManager, projectContextManager, projectRegistry });
					}
					json(hq, 200);
					return;
				}
				json({
					error: "Headquarters already represents the server workspace. Hide it from project lists in Settings instead of adding it again.",
					code: "HEADQUARTERS_ALREADY_EXISTS",
					projectId: HEADQUARTERS_PROJECT_ID,
				}, 409);
				return;
			}

			// Upsert: if a project already exists at this path, return it
			if (upsert) {
				const existing = projectRegistry.getByPath(body.rootPath);
				if (existing) {
					// Ensure context is initialized
					const ctx = projectContextManager.getOrCreate(existing.id);
					if (ctx) {
						ctx.gateStore.onStatusChange = () => {
							ctx.goalStore.bumpGeneration();
						};
						wireGoalManagerResolvers(ctx, { sessionManager, projectContextManager, projectRegistry });
					}
					json(existing, 200);
					return;
				}
			}

			const acceptCanonical = body.acceptCanonical === true;
			let project;
			try {
				project = projectRegistry.register(body.name, body.rootPath, { color, palette, colorLight, colorDark, acceptCanonical });
			} catch (regErr: any) {
				if (regErr instanceof SymlinkProjectRootError) {
					json({
						error: "Project root is a symlink",
						code: "symlink_root",
						rootPath: regErr.rootPath,
						canonical: regErr.canonical,
					}, 400);
					return;
				}
				if (regErr instanceof PreflightFailedError) {
					json({
						error: regErr.message,
						code: "preflight_failed",
						report: regErr.report,
					}, 400);
					return;
				}
				throw regErr;
			}
			// Initialize project context for the new project
			const newCtx = projectContextManager.getOrCreate(project.id);
			if (newCtx) {
				newCtx.gateStore.onStatusChange = () => {
					newCtx.goalStore.bumpGeneration();
				};
			}

			// Multi-repo: accept optional components / workflows in the create body.
			// Single-repo without components → fill default `[{name: <project name>, repo: "."}]`.
			const createComponents = (body as Record<string, unknown>).components;
			const createWorkflows = (body as Record<string, unknown>).workflows;
			if (newCtx) {
				if (Array.isArray(createComponents) && createComponents.length > 0) {
					if (createWorkflows && typeof createWorkflows === "object" && !Array.isArray(createWorkflows)) {
						try {
							const { validateAllWorkflows } = await import("./agent/workflow-validator.js");
							const errors = validateAllWorkflows(
								createWorkflows as Parameters<typeof validateAllWorkflows>[0],
								createComponents as Parameters<typeof validateAllWorkflows>[1],
							);
							if (errors.length > 0) {
								projectRegistry.remove(project.id);
								json({ error: "Workflow validation failed", details: errors }, 400);
								return;
							}
						} catch { /* best-effort */ }
					}
					const normalized = (createComponents as Array<Record<string, unknown>>).map(c => ({
						name: String(c.name ?? ""),
						repo: typeof c.repo === "string" && c.repo ? c.repo : ".",
						relativePath: typeof c.relative_path === "string" ? c.relative_path : (typeof c.relativePath === "string" ? c.relativePath as string : undefined),
						worktreeSetupCommand: typeof c.worktree_setup_command === "string" ? c.worktree_setup_command : (typeof c.worktreeSetupCommand === "string" ? c.worktreeSetupCommand as string : undefined),
						commands: c.commands && typeof c.commands === "object" && !Array.isArray(c.commands) ? c.commands as Record<string, string> : undefined,
						config: c.config && typeof c.config === "object" && !Array.isArray(c.config) ? c.config as Record<string, string> : undefined,
					}));
					newCtx.projectConfigStore.setComponents(normalized);
					if (createWorkflows && typeof createWorkflows === "object" && !Array.isArray(createWorkflows)) {
						newCtx.projectConfigStore.setWorkflows(createWorkflows as Record<string, import("./agent/project-config-store.js").InlineWorkflowDef>);
					}
				} else {
					// Default single-repo component named after the project.
					if (newCtx.projectConfigStore.getComponents().length === 0) {
						newCtx.projectConfigStore.setComponents([{ name: project.name, repo: "." }]);
					}
				}
				// No default-workflow seeding. Workflows must be designed by the
				// project assistant; a project may legitimately have zero workflows.
			}
			// Pin base_ref from the live remote so new projects never have a blank,
			// silently-resolved base. Best-effort: failures leave it blank (today's
			// behaviour). See docs/design/base-ref.md (add-time pinning).
			//
			// MUST run BEFORE worktree-pool init below: the pool's baseRefResolver
			// reads `base_ref` on each _fill()/startFilling(), so pinning the
			// concrete value first prevents early pool entries from being created
			// off the old `origin/HEAD` fallback.
			try {
				const cfg = newCtx?.projectConfigStore;
				if (cfg && !(cfg.get("base_ref") || "").trim()) {
					const comps = cfg.getComponents();
					const isMultiRepo = comps.some(c => c.repo !== ".");
					const primaryRepoPath = isMultiRepo
						? path.join(body.rootPath, comps.find(c => c.repo !== ".")?.repo ?? ".")
						: await getRepoRoot(body.rootPath, serverCommandRunner);
					const detected = await detectBaseRefFromRemote(primaryRepoPath, serverCommandRunner, serverRemoteGitPolicy);
					// Only pin when the detected ref is grammar-valid AND present in
					// every component repo — otherwise a manual save would reject it
					// and it could break worktree creation for the lacking component.
					if (
						detected
						&& isValidBaseRefBranchGrammar(detected)
						&& (await detectedRefExistsInAllComponents(body.rootPath, comps, detected, serverCommandRunner))
					) {
						cfg.set("base_ref", detected);
					}
				}
			} catch { /* best-effort — leave base_ref blank */ }
			// Initialize worktree pool if the new project is a git repo.
			// Respect gateway runtime config for E2E/CI.
			if (!config.skipWorktreePool) {
				try {
					// Multi-repo: rootPath is a container dir, individual repos sit
					// under <rootPath>/<repo>/. We treat that case as "git-ready" if
					// every declared repo subdir is a git repo.
					const components = newCtx?.projectConfigStore.getComponents() ?? [];
					const isMulti = components.some(c => c.repo !== ".");
					let poolReady = false;
					if (isMulti) {
						const seen = new Set<string>();
						poolReady = true;
						for (const c of components) {
							if (c.repo === "." || seen.has(c.repo)) continue;
							seen.add(c.repo);
							if (!(await isGitRepo(path.join(body.rootPath, c.repo), serverCommandRunner))) { poolReady = false; break; }
						}
					} else {
						poolReady = await isGitRepo(body.rootPath, serverCommandRunner);
					}
					if (poolReady) {
						const poolSize = parseInt(newCtx?.projectConfigStore.get("worktree_pool_size") || "2", 10) || 2;
						const wtRoot = newCtx?.projectConfigStore.get("worktree_root") || undefined;
						const pcs = newCtx?.projectConfigStore;
						// Single-repo: resolve nested rootPath to the actual git toplevel so
						// pool entries land under <gitRoot>-wt/, not <projectDir>-wt/.
						const poolRepoPath = isMulti ? body.rootPath : await getRepoRoot(body.rootPath, serverCommandRunner);
						sessionManager.initWorktreePoolForProject(project.id, poolRepoPath, pcs ? () => pcs.getComponents() : undefined, poolSize, wtRoot, pcs ? () => pcs.get("base_ref") : undefined, pcs ? () => pcs.get("worktree_setup_timeout_ms") || undefined : undefined, project.rootPath);
					}
				} catch { /* best-effort */ }
			}
			// Wire the goal-manager pool resolver for the new project (Phase 3 — goals via pool).
			if (newCtx) {
				wireGoalManagerResolvers(newCtx, { sessionManager, projectContextManager, projectRegistry });
			}
			json(project, 201);
		} catch (err: any) {
			jsonError(400, err);
		}
		return;
	}

	// PUT /api/projects/order
	if (url.pathname === "/api/projects/order" && req.method === "PUT") {
		const body = await readBody(req);
		try {
			// When Headquarters is hidden from project lists it is not part of the
			// client-visible reorder set, so the client cannot include it in the
			// payload. Exclude it from reconciliation so its position is preserved
			// rather than triggering a stale-order rejection.
			const excludeIds = shouldShowHeadquartersInProjectLists() ? [] : [HEADQUARTERS_PROJECT_ID];
			projectRegistry.setVisibleOrder(body?.projectIds, { excludeIds });
			const projects = listProjectsForApi();
			broadcastToAll({ type: "projects_changed", projects });
			json({ projects });
		} catch (err: any) {
			if (err instanceof ProjectOrderError || err?.code === "invalid_project_order" || err?.code === "stale_project_order") {
				const code = err?.code === "stale_project_order" ? "stale_project_order" : "invalid_project_order";
				const payload: Record<string, unknown> = {
					error: err?.message || "Invalid project order",
					code,
				};
				if (Array.isArray(err?.details?.expectedProjectIds)) payload.expectedProjectIds = err.details.expectedProjectIds;
				if (Array.isArray(err?.details?.receivedProjectIds)) payload.receivedProjectIds = err.details.receivedProjectIds;
				json(payload, code === "stale_project_order" ? 409 : 400);
			} else {
				jsonError(400, err);
			}
		}
		return;
	}

	// GET /api/projects/:id
	// Collection-level project endpoints must never fall through to the generic
	// project-id handlers (notably PUT /api/projects/order -> update("order")).
	const projectGetMatch = url.pathname.match(/^\/api\/projects\/(?!(?:preflight|archive-bobbit|detect|scan|order)$)([^/]+)$/);
	if (projectGetMatch && req.method === "GET") {
		const project = projectRegistry.get(projectGetMatch[1]);
		if (!project) { json({ error: "Project not found" }, 404); return; }
		json(project);
		return;
	}

	// PUT /api/projects/:id
	if (projectGetMatch && req.method === "PUT") {
		// Endpoint defense in depth: project-proposal acceptance classifies create
		// versus edit from `fields.projectId` before dispatch. If a mutation still
		// targets an unregistered id, return a clear UNKNOWN_PROJECT response.
		if (!projectRegistry.get(projectGetMatch[1])) {
			json({ ok: false, code: "UNKNOWN_PROJECT", message: `Unknown project: ${projectGetMatch[1]}` }, 422);
			return;
		}
		const body = await readBody(req);
		const updates: { name?: string; color?: string; rootPath?: string; palette?: string; colorLight?: string; colorDark?: string } = {};
		if (typeof body?.name === "string") updates.name = body.name;
		if (typeof body?.color === "string") updates.color = body.color;
		if (typeof body?.rootPath === "string") updates.rootPath = body.rootPath;
		if (typeof body?.palette === "string" || body?.palette === null || body?.palette === "") updates.palette = body.palette ?? "";
		if (typeof body?.colorLight === "string") updates.colorLight = body.colorLight;
		if (typeof body?.colorDark === "string") updates.colorDark = body.colorDark;
		if (updates.rootPath && isHeadquartersOwnedPath(updates.rootPath)) {
			json({
				error: "Headquarters already represents the server workspace. Select Headquarters instead of moving another project to it.",
				code: "HEADQUARTERS_ALREADY_EXISTS",
				projectId: HEADQUARTERS_PROJECT_ID,
			}, 409);
			return;
		}
		try {
			const updated = projectRegistry.update(projectGetMatch[1], updates);
			json(updated);
		} catch (err: any) {
			if (writeSpecialProjectMutationError(err)) return;
			jsonError(400, err);
		}
		return;
	}

	// DELETE /api/projects/:id
	//
	// Any project may be removed, including the last visible one. When zero
	// non-hidden projects remain the UI falls back to the existing
	// zero-project first-run state (see GR-09 / splash-no-projects spec).
	if (projectGetMatch && req.method === "DELETE") {
		const projectId = projectGetMatch[1];
		const project = projectRegistry.get(projectId);
		try {
			if (project) assertNormalMutableProject(project, "removed");
			// Drain the project's worktree pool before removing
			await sessionManager.removeWorktreePool(projectId);
			// Terminate all live sessions belonging to the removed project
			const liveSessions = sessionManager.listSessions().filter(s => s.projectId === projectId);
			for (const s of liveSessions) {
				try { await sessionManager.terminateSession(s.id); } catch {}
			}
			await sessionManager.cleanupScopedMcpManagersForProject(projectId, project?.rootPath);
			projectContextManager.remove(projectId);
			if (project?.provisional) {
				projectRegistry.removeProvisional(projectId);
			} else {
				projectRegistry.remove(projectId);
			}
			json({ ok: true });
		} catch (err: any) {
			if (writeSpecialProjectMutationError(err)) return;
			jsonError(400, err);
		}
		return;
	}

	// POST /api/projects/:id/promote
	const projectPromoteMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/promote$/);
	if (projectPromoteMatch && req.method === "POST") {
		const projectId = projectPromoteMatch[1];
		// Endpoint defense in depth: the acceptance dispatcher selects promotion
		// from `fields.projectId`; this endpoint still reports an unregistered id
		// as UNKNOWN_PROJECT rather than relying on a generic registry error.
		if (!projectRegistry.get(projectId)) {
			json({ ok: false, code: "UNKNOWN_PROJECT", message: `Unknown project: ${projectId}` }, 422);
			return;
		}
		try {
			const body = await readBody(req);
			const name = typeof body?.name === "string" ? body.name : undefined;
			const promoted = projectRegistry.promote(projectId, { name });
			// Pin base_ref from the live remote (best-effort) now that the
			// promoted project's rootPath is a real git repo. Mirrors the
			// add-time pin in POST /api/projects. See docs/design/base-ref.md.
			try {
				const ctx = projectContextManager.getOrCreate(projectId);
				const rootPath = projectRegistry.get(projectId)?.rootPath;
				const cfg = ctx?.projectConfigStore;
				if (cfg && rootPath && !(cfg.get("base_ref") || "").trim()) {
					const comps = cfg.getComponents();
					const isMultiRepo = comps.some(c => c.repo !== ".");
					const primaryRepoPath = isMultiRepo
						? path.join(rootPath, comps.find(c => c.repo !== ".")?.repo ?? ".")
						: await getRepoRoot(rootPath, serverCommandRunner);
					const detected = await detectBaseRefFromRemote(primaryRepoPath, serverCommandRunner, serverRemoteGitPolicy);
					// Pin only if the detected ref exists in every component repo
					// (mirrors save-time validation). See POST /api/projects above.
					if (
						detected
						&& isValidBaseRefBranchGrammar(detected)
						&& (await detectedRefExistsInAllComponents(rootPath, comps, detected, serverCommandRunner))
					) {
						cfg.set("base_ref", detected);
					}
				}
			} catch { /* best-effort — leave base_ref blank */ }
			json(promoted);
		} catch (err: any) {
			if (writeSpecialProjectMutationError(err)) return;
			jsonError(400, err);
		}
		return;
	}

	// GET /api/projects/:id/base-ref/detect — read-only resolver helper.
	// Returns { resolved, detected }:
	//   resolved = what worktrees actually branch off right now
	//              (resolveBaseRef(primaryRepoPath, storedValue).ref)
	//   detected = live `git ls-remote --symref origin HEAD` result, but ONLY
	//              when it is saveable (passes the same grammar + cross-component
	//              existence checks add-time pinning applies); otherwise null
	//              (offline / no remote / not saveable). Guarantees any non-null
	//              `detected` the UI fills can be saved without rejection.
	// Scoped to the project's pool/primary repo (same selection as add-time
	// pinning). No mutation. See docs/design/base-ref.md.
	const baseRefDetectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/base-ref\/detect$/);
	if (baseRefDetectMatch && req.method === "GET") {
		const ctx = projectContextManager.getOrCreate(baseRefDetectMatch[1]);
		const rootPath = projectRegistry.get(baseRefDetectMatch[1])?.rootPath;
		if (!ctx || !rootPath) { json({ error: "Project not found" }, 404); return; }
		try {
			const cfg = ctx.projectConfigStore;
			const comps = cfg.getComponents();
			const primaryRepoPath = await resolveBaseRefDetectRepoPath(rootPath, comps, serverCommandRunner);
			if (!primaryRepoPath) {
				const parsed = parseBaseRef(cfg.get("base_ref") || "");
				json({ resolved: parsed.ref || "", detected: null });
				return;
			}
			const resolved = (await resolveBaseRef(primaryRepoPath, cfg.get("base_ref"), serverCommandRunner)).ref;
			// `detected` must be SAVEABLE — null it out unless it passes the same
			// checks add-time pinning applies (grammar + cross-component existence).
			// The Settings "Detect from remote" button fills this value, so a
			// non-saveable value here would be rejected by the normal Save path.
			let detected = await detectBaseRefFromRemote(primaryRepoPath, serverCommandRunner, serverRemoteGitPolicy);
			if (
				detected
				&& (!isValidBaseRefBranchGrammar(detected)
					|| !(await detectedRefExistsInAllComponents(rootPath, comps, detected, serverCommandRunner)))
			) {
				detected = null;
			}
			json({ resolved, detected });
		} catch (err: any) {
			jsonError(400, err);
		}
		return;
	}

	// GET/PUT /api/projects/:id/config, GET /api/projects/:id/config/defaults, GET /api/projects/:id/config/resolved
	const projectConfigMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/config(?:\/(defaults|resolved))?$/);
	if (projectConfigMatch) {
		const ctx = projectContextManager.getOrCreate(projectConfigMatch[1]);
		if (!ctx) {
			// Endpoint defense in depth: `fields.projectId` drives create-versus-edit
			// acceptance dispatch on the client. A config mutation that nevertheless
			// targets an unregistered id gets UNKNOWN_PROJECT; reads keep the
			// historical 404 shape.
			if (req.method === "PUT") {
				json({ ok: false, code: "UNKNOWN_PROJECT", message: `Unknown project: ${projectConfigMatch[1]}` }, 422);
			} else {
				json({ error: "Project not found" }, 404);
			}
			return;
		}
		const suffix = projectConfigMatch[2]; // undefined | "defaults" | "resolved"

		if (req.method === "GET" && !suffix) {
			const flat = ctx.projectConfigStore.getAll();
			// Upgrade migrated keys to native structured form for the wire response.
			const config: Record<string, unknown> = { ...flat };
			config.config_directories = ctx.projectConfigStore.getConfigDirectories();
			config.sandbox_tokens = ctx.projectConfigStore.getSandboxTokens();
			// Defence in depth: legacy top-level qa_* keys must never appear on
			// the wire. Migration removes them on boot; strip again here in case
			// a stale on-disk value slipped through.
			for (const k of LEGACY_QA_TOP_LEVEL_KEYS) delete config[k];
			mergeSecretsIntoTokens(config, ctx.secretsStore);
			json(redactSandboxSecrets(config));
			return;
		}
		if (req.method === "GET" && suffix === "defaults") {
			json(ctx.projectConfigStore.getDefaults());
			return;
		}
		if (req.method === "GET" && suffix === "resolved") {
			const defaults = ctx.projectConfigStore.getDefaults();
			const result: Record<string, { value: unknown; source: string }> = {};
			// Include all default keys
			for (const key of Object.keys(defaults)) {
				result[key] = resolveScalarConfig(key, ctx.projectConfigStore, projectConfigStore, null, defaults);
			}
			// Also include custom keys from the project's own config that aren't in defaults
			const rawConfig = ctx.projectConfigStore.getAll();
			for (const key of Object.keys(rawConfig)) {
				if (!(key in result)) {
					result[key] = { value: rawConfig[key], source: "project" };
				}
			}
			// Include custom keys from the server-level config that aren't already covered
			const serverRaw = projectConfigStore.getAll();
			for (const key of Object.keys(serverRaw)) {
				if (!(key in result)) {
					result[key] = { value: serverRaw[key], source: "server" };
				}
			}
			// Override migrated fields with structured values (resolveScalarConfig returns flat strings).
			const migratedSource = (key: string): string => {
				return (rawConfig[key] !== undefined && rawConfig[key] !== "") ? "project"
					: (serverRaw[key] !== undefined && serverRaw[key] !== "") ? "server"
					: "default";
			};
			result.config_directories = { value: ctx.projectConfigStore.getConfigDirectories(), source: migratedSource("config_directories") };
			result.sandbox_tokens = { value: ctx.projectConfigStore.getSandboxTokens(), source: migratedSource("sandbox_tokens") };
			// Defence in depth: strip legacy top-level qa_* keys.
			for (const k of LEGACY_QA_TOP_LEVEL_KEYS) delete result[k];
			// Merge secrets into sandbox_tokens (structured) for the resolved response.
			if (Array.isArray(result.sandbox_tokens.value)) {
				const tempConfig: Record<string, unknown> = { sandbox_tokens: result.sandbox_tokens.value };
				mergeSecretsIntoTokens(tempConfig, ctx.secretsStore);
				result.sandbox_tokens = { value: tempConfig.sandbox_tokens, source: result.sandbox_tokens.source };
			}
			json(redactSandboxSecretsResolved(result));
			return;
		}
		if (req.method === "PUT" && !suffix) {
			const body = await readBody(req);
			if (!body || typeof body !== "object") { json({ error: "Missing body" }, 400); return; }

			// Reject legacy top-level qa_* keys — they have moved into
			// `components[<name>].config`. Done before any other parsing so the
			// error is fast and unambiguous.
			for (const key of LEGACY_QA_TOP_LEVEL_KEYS) {
				if (key in (body as Record<string, unknown>)) {
					json({ error: `${key} settings have moved to components[].config[]; set components[<name>].config.${key} instead` }, 400);
					return;
				}
			}

			// Validate components[].config eagerly (mirrors propose_project tool).
			{
				const err = validateComponentsConfig((body as Record<string, unknown>).components);
				if (err) { json({ error: err }, 400); return; }
			}

			// `base_ref` validation — runs only when the field is present in the PUT body.
			// On any failure we return HTTP 400 with `{ field: "base_ref", error, details? }`
			// so the Settings UI can render the error inline. Non-fatal warnings (component
			// paths that aren't git repos) bubble up via `baseRefWarnings` and are attached
			// to the success response below. See docs/design/base-ref.md.
			const baseRefWarnings: string[] = [];
			if ("base_ref" in (body as Record<string, unknown>)) {
				const rawBaseRef = (body as Record<string, unknown>).base_ref;
				const baseRefValue = normalizeBaseRefValue(rawBaseRef);
				if (baseRefValue) {
					const sandboxResolved = ctx.projectConfigStore.getWithDefaults().sandbox || "none";
					const shapeError = validateBaseRefShape({ value: rawBaseRef, sandbox: sandboxResolved });
					if (shapeError) {
						json(shapeError, 400);
						return;
					}
					// Multi-repo ref existence — `git rev-parse --verify` against every
					//    component repo. Also detect tags up-front: a value that resolves
					//    via `refs/tags/<value>` in ANY component is rejected as a tag.
					const componentsForCheck = ctx.projectConfigStore.getComponents();
					const componentsToCheck = componentsForCheck.length > 0
						? componentsForCheck
						: [{ name: ctx.project.name || "default", repo: "." }];
					const failures: Array<{ component: string; message: string }> = [];
					let checkedRepoCount = 0;
					let tagDetected = false;
					for (const c of componentsToCheck) {
						const repoPath = path.join(ctx.project.rootPath, c.repo);
						const gitRepoCheck = await isGitRepo(repoPath, serverCommandRunner).catch(() => false);
						if (!gitRepoCheck) {
							baseRefWarnings.push(baseRefSkippedRepoWarning(c.name, repoPath));
							continue;
						}
						checkedRepoCount++;
						// Tag check first — if the value resolves as a tag in any component
						// repo, fail with the tag-specific message rather than the generic
						// "not present" error.
						try {
							await serverCommandRunner.execFile("git", ["rev-parse", "--verify", `refs/tags/${baseRefValue}`], { cwd: repoPath, timeout: 5_000 });
							tagDetected = true;
							break;
						} catch {
							// Not a tag in this repo — continue with branch-ref check below.
						}
						try {
							await serverCommandRunner.execFile("git", ["rev-parse", "--verify", baseRefValue], { cwd: repoPath, timeout: 5_000 });
						} catch {
							failures.push({
								component: c.name,
								message: `ref not found. Try: cd ${c.repo} && git fetch origin`,
							});
						}
					}
					if (tagDetected) {
						json(baseRefTagError(baseRefValue), 400);
						return;
					}
					if (failures.length > 0) {
						json(baseRefMissingInReposError(baseRefValue, failures, checkedRepoCount), 400);
						return;
					}
				}
			}

			// Extract structured fields (components / workflows) before flat-key validation.
			let components = (body as Record<string, unknown>).components;
			const workflows = (body as Record<string, unknown>).workflows;
			delete (body as Record<string, unknown>).components;
			delete (body as Record<string, unknown>).workflows;

			// Back-compat: legacy top-level *_command fields (build_command, test_command, etc.)
			// are folded into components[0].commands when no `components` field was supplied.
			// This keeps the propose_project tool, the project assistant, and the provisional
			// promotion path working after Follow-up A removed the legacy schema. Existing
			// components stored on disk are not modified — callers who want to update components
			// must pass a fresh `components` array. See multi-repo follow-up Issue 2 / Issue 5.
			if (!Array.isArray(components)) {
				const LEGACY_KEY_MAP: Record<string, string> = {
					build_command: "build",
					test_command: "test",
					typecheck_command: "check",
					test_unit_command: "unit",
					test_e2e_command: "e2e",
				};
				const legacyCmds: Record<string, string> = {};
				for (const [legacyKey, newKey] of Object.entries(LEGACY_KEY_MAP)) {
					const v = (body as Record<string, unknown>)[legacyKey];
					if (typeof v === "string" && v.trim().length > 0) legacyCmds[newKey] = v.trim();
				}
				const legacyHook = (body as Record<string, unknown>).worktree_setup_command;
				const hasAnyLegacy = Object.keys(legacyCmds).length > 0
					|| (typeof legacyHook === "string" && legacyHook.trim().length > 0);
				if (hasAnyLegacy) {
					const existing = ctx.projectConfigStore.getComponents();
					const defaultName = existing[0]?.name || ctx.project.name || "default";
					const defaultRepo = existing[0]?.repo || ".";
					const mergedCommands = { ...(existing[0]?.commands ?? {}), ...legacyCmds };
					const defaultComponent: Record<string, unknown> = {
						name: defaultName,
						repo: defaultRepo,
						commands: mergedCommands,
					};
					if (existing[0]?.relativePath) defaultComponent.relative_path = existing[0].relativePath;
					const hookValue = (typeof legacyHook === "string" && legacyHook.trim().length > 0)
						? legacyHook.trim()
						: existing[0]?.worktreeSetupCommand;
					if (hookValue) defaultComponent.worktree_setup_command = hookValue;
					// Preserve existing per-component config (qa_* keys etc.) — the legacy
					// flat-key write path must not silently wipe it.
					if (existing[0]?.config && Object.keys(existing[0].config).length > 0) {
						defaultComponent.config = { ...existing[0].config };
					}
					// Replace the first component but preserve any additional components on disk.
					const remaining = existing.slice(1).map(c => {
						const entry: Record<string, unknown> = { name: c.name, repo: c.repo };
						if (c.relativePath) entry.relative_path = c.relativePath;
						if (c.worktreeSetupCommand) entry.worktree_setup_command = c.worktreeSetupCommand;
						if (c.commands) entry.commands = c.commands;
						if (c.config && Object.keys(c.config).length > 0) entry.config = { ...c.config };
						return entry;
					});
					components = [defaultComponent, ...remaining];
				}
				// Legacy flat keys remain in `body` so they are ALSO written as legacy
				// flat-config entries (preserves GET round-trip for existing API clients
				// that only know the legacy schema). The structural components mirror is
				// the source of truth for workflow steps and the Components UI.
			}

			// Validate ALL flat keys before writing ANY (atomic: all-or-nothing)
			for (const [key] of Object.entries(body)) {
				if (key.includes(".")) {
					json({ error: `Config key "${key}" must not contain dots` }, 400);
					return;
				}
			}

			// Validate workflows structurally if both components and workflows are present.
			if (components && workflows && Array.isArray(components) && typeof workflows === "object") {
				try {
					const { validateAllWorkflows } = await import("./agent/workflow-validator.js");
					const errors = validateAllWorkflows(
						workflows as Parameters<typeof validateAllWorkflows>[0],
						components as Parameters<typeof validateAllWorkflows>[1],
					);
					if (errors.length > 0) {
						json({ error: "Workflow validation failed", details: errors }, 400);
						return;
					}
				} catch (err) {
					console.warn("[server] workflow validation skipped:", err);
				}
			}

			// Native-YAML migrated fields: reject legacy string payloads (must be structured
			// types or null/empty to clear). For sandbox_tokens we still need to merge
			// redacted values via mergeSandboxSecrets; the merge helper now operates on
			// structured arrays.
			const migratedExtracted: Record<string, unknown> = {};
			const MIGRATED_FIELDS = [
				{ key: "config_directories", expect: "array" as const },
				{ key: "sandbox_tokens", expect: "array" as const },
			];
			for (const { key, expect } of MIGRATED_FIELDS) {
				if (!(key in body)) continue;
				const v = (body as Record<string, unknown>)[key];
				if (v === null || v === "") {
					migratedExtracted[key] = null;
					delete (body as Record<string, unknown>)[key];
					continue;
				}
				if (typeof v === "string") {
					json({ error: `Field "${key}" must be sent as a structured ${expect}, not a JSON-encoded string` }, 400);
					return;
				}
				if (expect === "array" && !Array.isArray(v)) {
					json({ error: `Field "${key}" must be an array` }, 400);
					return;
				}
				migratedExtracted[key] = v;
				delete (body as Record<string, unknown>)[key];
			}

			// Merge secrets for migrated structured sandbox_tokens, and for any legacy
			// keys that still carry inline credentials (sandbox_credentials).
			if (Array.isArray(migratedExtracted.sandbox_tokens)) {
				migratedExtracted.sandbox_tokens = mergeSandboxTokensStructured(
					migratedExtracted.sandbox_tokens as Array<{ key: string; enabled?: boolean; value?: string }>,
					ctx.secretsStore,
				);
			}
			mergeSandboxSecrets(body as Record<string, string>, ctx.projectConfigStore, ctx.secretsStore);

			// Write legacy flat keys.
			for (const [key, value] of Object.entries(body)) {
				if (value === null || value === "") {
					ctx.projectConfigStore.remove(key);
				} else if (typeof value === "string") {
					ctx.projectConfigStore.set(key, value);
				}
			}

			// Apply migrated structured fields via typed setters.
			if ("config_directories" in migratedExtracted) {
				const v = migratedExtracted.config_directories;
				if (v === null) {
					ctx.projectConfigStore.remove("config_directories");
				} else if (Array.isArray(v)) {
					ctx.projectConfigStore.setConfigDirectories(
						v.filter((e: any) => e && typeof e === "object" && typeof e.path === "string").map((e: any) => ({
							path: String(e.path),
							types: Array.isArray(e.types) ? e.types.filter((t: unknown): t is string => typeof t === "string") : [],
						})),
					);
				}
			}
			if ("sandbox_tokens" in migratedExtracted) {
				const v = migratedExtracted.sandbox_tokens;
				if (v === null) {
					ctx.projectConfigStore.remove("sandbox_tokens");
				} else if (Array.isArray(v)) {
					ctx.projectConfigStore.setSandboxTokens(
						v.filter((e: any) => e && typeof e === "object" && typeof e.key === "string").map((e: any) => ({
							key: String(e.key),
							enabled: e.enabled !== false,
						})),
					);
				}
			}

			// Persist structured fields if provided.
			if (Array.isArray(components)) {
				const normalized = (components as Array<Record<string, unknown>>).map(c => ({
					name: String(c.name ?? ""),
					repo: typeof c.repo === "string" && c.repo ? c.repo : ".",
					relativePath: typeof c.relative_path === "string" ? c.relative_path : (typeof c.relativePath === "string" ? c.relativePath as string : undefined),
					worktreeSetupCommand: typeof c.worktree_setup_command === "string" ? c.worktree_setup_command : (typeof c.worktreeSetupCommand === "string" ? c.worktreeSetupCommand as string : undefined),
					commands: c.commands && typeof c.commands === "object" && !Array.isArray(c.commands) ? c.commands as Record<string, string> : undefined,
					config: c.config && typeof c.config === "object" && !Array.isArray(c.config) ? c.config as Record<string, string> : undefined,
				}));
				ctx.projectConfigStore.setComponents(normalized);
			}
			if (workflows && typeof workflows === "object" && !Array.isArray(workflows)) {
				ctx.projectConfigStore.setWorkflows(workflows as Record<string, import("./agent/project-config-store.js").InlineWorkflowDef>);
			}

			if (baseRefWarnings.length > 0) {
				json({ ok: true, warnings: baseRefWarnings });
				return;
			}
			json({ ok: true });
			return;
		}
	}

	// GET /api/projects/:id/qa-testing-config
	const evConfigMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/qa-testing-config$/);
	if (evConfigMatch && req.method === "GET") {
		const ctx = projectContextManager.getOrCreate(evConfigMatch[1]);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }
		json({ configured: ctx.projectConfigStore.isQaConfiguredOnAnyComponent() });
		return;
	}

	// GET /api/search
	if (url.pathname === "/api/search" && req.method === "GET") {
		const q = url.searchParams.get("q");
		if (!q) {
			json({ error: "Missing query parameter 'q'" }, 400);
			return;
		}
		const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10) || 20), 100);
		const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
		const typeParam = url.searchParams.get("type") || "all";
		const validTypes = new Set(["all", "goals", "sessions", "messages", "staff"]);
		const type = validTypes.has(typeParam) ? typeParam as "all" | "goals" | "sessions" | "messages" | "staff" : "all";
		const includeArchived = url.searchParams.get("includeArchived") === "true"
			|| (url.searchParams.get("include") || "").split(",").some(part => part.trim() === "archived");
		try {
			const projectId = url.searchParams.get("projectId") || undefined;
			const projectNames = new Map(projectRegistry.list().map(p => [p.id, p.name]));
			const results = await projectContextManager.searchAll(q, { type, limit, offset, projectId, projectNames, includeArchived });
			json(results);
		} catch (err) {
			json({ error: `Search failed: ${err}` }, 500);
		}
		return;
	}

	function* visibleArchivedRaw() {
		for (const ctx of projectContextManager.visible()) {
			for (const session of ctx.sessionStore.getArchived()) yield session;
		}
	}

	function normalizedArchivedQuery(value: string | null): string {
		return (value || "").trim().toLowerCase();
	}

	function archivedSessionMatchesQuery(session: any, query: string): boolean {
		if (!query) return true;
		return String(session?.title || "").toLowerCase().includes(query)
			|| String(session?.role || "").toLowerCase().includes(query);
	}

	function isArchivedQueryChildSession(session: any): boolean {
		return !!(session?.parentSessionId || session?.delegateOf);
	}

	function archivedGoalMatchesQuery(goal: PersistedGoal, sessions: any[], query: string): boolean {
		if (!query) return true;
		if (String(goal.title || "").toLowerCase().includes(query)) return true;
		return sessions.some(s =>
			(s?.goalId === goal.id || s?.teamGoalId === goal.id)
			&& !isArchivedQueryChildSession(s)
			&& archivedSessionMatchesQuery(s, query),
		);
	}

	// GET /api/sessions
	if (url.pathname === "/api/sessions" && req.method === "GET") {
		const currentGen = projectContextManager.getSessionGeneration();
		const sinceParam = url.searchParams.get("since");
		if (sinceParam !== null) {
			const since = parseInt(sinceParam, 10);
			if (!isNaN(since) && since === currentGen) {
				json({ generation: currentGen, changed: false });
				return;
			}
		}
		const filterProjectId = url.searchParams.get("projectId") || undefined;
		const registeredProjectIds = new Set(projectRegistry.list().map(p => p.id));
		let sessions = sessionManager.listSessions().map((s) => ({
			...s,
			colorIndex: colorStore.get(s.id),
		})).filter(s => !s.projectId || registeredProjectIds.has(s.projectId));
		if (filterProjectId) {
			sessions = sessions.filter(s => s.projectId === filterProjectId);
		}
		// Support ?include=archived to return archived sessions too
		if (url.searchParams.get("include") === "archived") {
			const archivedQuery = normalizedArchivedQuery(url.searchParams.get("q"));
			// Collect archived sessions across all project contexts
			const allArchived: typeof sessions = [];
			for (const ctx of projectContextManager.visible()) {
				const store = ctx.sessionStore;
				for (const s of store.getArchived()) {
					allArchived.push({ ...s, colorIndex: colorStore.get(s.id), status: "archived" } as any);
				}
			}
			// Sort by archivedAt descending
			allArchived.sort((a: any, b: any) => ((b as any).archivedAt ?? 0) - ((a as any).archivedAt ?? 0));
			// Apply projectId and query filters before pagination.
			const filteredArchived = (filterProjectId
				? allArchived.filter((s: any) => s.projectId === filterProjectId)
				: allArchived
			).filter((s: any) => archivedSessionMatchesQuery(s, archivedQuery));

			// Build live goal IDs for BFS seeding
			const liveGoalIds: string[] = [];
			for (const ctx of projectContextManager.visible()) {
				for (const g of ctx.goalStore.getLive()) {
					if (!g.archived) liveGoalIds.push(g.id);
				}
			}

			if (hasPagingParams()) {
				// Paginated archived sessions. Cursor pagination wins over offset when supplied.
				const paging = readOffsetPaging();
				const cursorParam = url.searchParams.get("cursor") ?? url.searchParams.get("after");
				const afterCursor = cursorParam !== null ? parseInt(cursorParam, 10) : undefined;
				const hasCursor = afterCursor !== undefined && Number.isFinite(afterCursor);
				let pagePool = filteredArchived;
				if (hasCursor) {
					pagePool = pagePool.filter((s: any) => ((s as any).archivedAt ?? 0) < afterCursor!);
				} else if (paging.offset > 0) {
					pagePool = pagePool.slice(paging.offset);
				}
				const total = filteredArchived.length;
				const hasMore = pagePool.length > paging.limit;
				const sliced = pagePool.slice(0, paging.limit);
				const nextCursor = sliced.length > 0 ? (sliced[sliced.length - 1] as any).archivedAt : undefined;
				const nextOffset = hasMore && !hasCursor ? paging.offset + paging.limit : undefined;

				// BFS: collect archived children reachable from live sessions and goals.
				const liveIdSet = new Set(sessions.map(s => s.id));
				const archivedDelegatesOfLive = bfsEnrichArchivedIndexed(
					[...liveIdSet, ...liveGoalIds],
					visibleArchivedRaw(),
					(s) => ({ ...s, colorIndex: colorStore.get(s.id), archived: true } as any),
				);

				json({ generation: currentGen, sessions: [...sessions, ...sliced], total, limit: paging.limit, offset: !hasCursor ? paging.offset : undefined, hasMore, nextCursor, ...(nextOffset !== undefined ? { nextOffset } : {}), archivedDelegates: archivedDelegatesOfLive });
			} else {
				// BFS: collect archived children reachable from live sessions and goals.
				const liveIdSet = new Set(sessions.map(s => s.id));
				const archivedDelegatesOfLive = bfsEnrichArchivedIndexed(
					[...liveIdSet, ...liveGoalIds],
					visibleArchivedRaw(),
					(s) => ({ ...s, colorIndex: colorStore.get(s.id), archived: true } as any),
				);

				// Backward compatible: return all archived sessions
				json({ generation: currentGen, sessions: [...sessions, ...filteredArchived], archivedDelegates: archivedDelegatesOfLive });
			}
		} else {
			// Always include archived children of live sessions/goals so the sidebar
			// can render chevrons/nesting without a separate fetch.
			const liveIdSet = new Set(sessions.map(s => s.id));
			// Build live goal IDs for BFS seeding
			const liveGoalIdsNonPaginated: string[] = [];
			for (const ctx of projectContextManager.visible()) {
				for (const g of ctx.goalStore.getLive()) {
					if (!g.archived) liveGoalIdsNonPaginated.push(g.id);
				}
			}
			// BFS: live parents/goals → their archived children → children of those, etc.
			const archivedDelegatesOfLive = bfsEnrichArchivedIndexed(
				[...liveIdSet, ...liveGoalIdsNonPaginated],
				visibleArchivedRaw(),
				(s) => ({ ...s, colorIndex: colorStore.get(s.id), archived: true } as any),
			);
			const paging = readOffsetPaging();
			if (paging.enabled) {
				const page = pageArray(sessions, paging);
				json({ generation: currentGen, sessions: page.items, total: page.total, limit: page.limit, offset: page.offset, hasMore: page.hasMore, ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}), archivedDelegates: archivedDelegatesOfLive });
			} else {
				json({ generation: currentGen, sessions, archivedDelegates: archivedDelegatesOfLive });
			}
		}
		return;
	}

	// POST /api/sessions/:id/activate-skill — autonomous skill activation
	const activateSkillMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/activate-skill$/);
	if (activateSkillMatch && req.method === "POST") {
		const sessionId = activateSkillMatch[1];
		const session = sessionManager.getSession(sessionId);
		if (!session) {
			json({ error: "Session not found" }, 404);
			return;
		}
		const body = await readBody(req);
		const skillName = typeof body?.name === "string" ? body.name : "";
		const skillArgs = typeof body?.args === "string" ? body.args : "";
		if (!skillName) {
			json({ error: "name is required" }, 400);
			return;
		}
		// Resolve skill discovery context: host-side cwd + per-project store.
		let resolvedConfigStore: { get(key: string): string | undefined } | undefined = projectConfigStore;
		let skillCwd = session.cwd;
		if (session.projectId) {
			const pcm = (sessionManager as any).projectContextManager as import("./agent/project-context-manager.js").ProjectContextManager | undefined;
			const ctx = pcm?.getOrCreate(session.projectId);
			if (ctx) {
				resolvedConfigStore = ctx.projectConfigStore;
				if (session.sandboxed) skillCwd = ctx.project.rootPath;
			}
		}
		const skill = getSlashSkill(skillCwd, skillName, resolvedConfigStore, skillMarketContext(session.projectId ?? null));
		if (!skill) {
			json({ error: `Skill "${skillName}" not found` }, 404);
			return;
		}
		if (skill.disableModelInvocation === true) {
			json({ error: `Skill "${skillName}" has disable-model-invocation: true and cannot be activated by the model` }, 403);
			return;
		}
		// Inject the activation header so autonomous activation is byte-equal
		// to user `/<name>` invocation.
		const pathRewrite = session.sandboxed
			? (hostPath: string): string | null => {
				// Project worktree mounts at /workspace; rewrite when the host
				// path lives under it. Built-in / personal skills aren't mounted.
				const projectRoot = (session.projectId
					? ((sessionManager as any).projectContextManager as import("./agent/project-context-manager.js").ProjectContextManager | undefined)?.getOrCreate(session.projectId)?.project.rootPath
					: undefined);
				const normHost = hostPath.replace(/\\/g, "/");
				const normProj = projectRoot ? projectRoot.replace(/\\/g, "/") : null;
				const sessionCwdNorm = session.cwd.replace(/\\/g, "/");
				for (const candidate of [normProj, sessionCwdNorm]) {
					if (candidate && (normHost === candidate || normHost.startsWith(candidate + "/"))) {
						const rel = normHost.slice(candidate.length).replace(/^\/+/, "");
						return "/workspace" + (rel ? "/" + rel : "");
					}
				}
				return null;
			}
			: undefined;
		const skillBody = buildSlashSkillPrompt(skill, skillArgs);
		const expanded = buildActivationHeader(skill, pathRewrite) + skillBody;
		json({ ok: true, expanded, source: skill.source, filePath: skill.filePath });
		return;
	}

	// POST /api/sessions/:id/tool-grant-request — long-polling endpoint called by guard extension
	const toolGrantMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/tool-grant-request$/);
	if (toolGrantMatch && req.method === "POST") {

		const sessionId = toolGrantMatch[1];
		const body = await readBody(req);
		if (!body || !body.toolName || !body.toolGroup) {
			json({ error: "toolName and toolGroup required" }, 400);
			return;
		}
		try {
			const result = await sessionManager.requestToolGrant(sessionId, body.toolName, body.toolGroup);
			json(result);
		} catch (err: any) {
			jsonError(500, err);
		}
		return;
	}

	// ── Provider per-turn lifecycle hooks (EP G1.4) ──
	// These endpoints are called only by the Bobbit-generated provider-bridge pi
	// extension (before-prompt / before-compact) and the context-trace inspector.
	// They inherit the admin-bearer gate enforced before handleApiRoute, exactly
	// like POST /api/sessions/:id/tool-grant-request above. afterTurn /
	// sessionShutdown are gateway-internal dispatches and intentionally have NO
	// public endpoint.
	//
	// Resolve a session's lifecycle dispatch context from live or persisted state.
	// Returns undefined when the session is unknown (→ 404 for the hook endpoints).
	const resolveHookCtx = (id: string): Omit<HookCtx, "budget" | "config" | "gateway"> | undefined => {
		const live = sessionManager.getSession(id);
		const persisted = sessionManager.getPersistedSession(id);
		if (!live && !persisted) return undefined;
		const projectId = live?.projectId ?? persisted?.projectId;
		return {
			sessionId: id,
			projectId,
			scope: projectId ? "project" : "global",
			cwd: live?.cwd ?? persisted?.cwd ?? process.cwd(),
			// Effective goal: team members, delegates, and reviewers carry the goal
			// only in teamGoalId, so fall back to it before persisted state. Without
			// this, disabled-provider filtering would not apply at the provider hook
			// endpoints (beforePrompt / beforeCompact) for non-lead sessions.
			goalId: live?.goalId ?? live?.teamGoalId ?? persisted?.goalId ?? persisted?.teamGoalId,
			roleName: live?.role ?? persisted?.role,
		};
	};

	// POST /api/sessions/:id/provider-hooks/before-prompt — per-turn dynamic context.
	const beforePromptMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/provider-hooks\/before-prompt$/);
	if (beforePromptMatch && req.method === "POST") {
		const sessionId = beforePromptMatch[1];
		const body = await readBody(req).catch(() => ({} as any));
		if (body && body.prompt !== undefined && typeof body.prompt !== "string") {
			json({ error: "prompt must be a string" }, 400);
			return;
		}
		const base = resolveHookCtx(sessionId);
		if (!base) {
			json({ error: "Session not found" }, 404);
			return;
		}
		const hub = sessionManager.lifecycleHub;
		if (!hub) {
			json({ content: "", tail: "", blocks: [] });
			return;
		}
		try {
			const turnIndex = body?.turn?.index;
			const { blocks } = await hub.dispatch("beforePrompt", {
				...base,
				prompt: typeof body?.prompt === "string" ? body.prompt : undefined,
				turn: typeof turnIndex === "number" && Number.isFinite(turnIndex) ? { index: turnIndex } : undefined,
			});
			const content = blocks.length ? blocks.map(fenceBlock).join("\n\n") : "";
			// Temporary back-compat for generated bridges from the system-prompt-tail era.
			// New bridges consume `content` only and must never return systemPrompt.
			const tail = content ? `\n${DYNAMIC_CONTEXT_START}\n${content}\n${DYNAMIC_CONTEXT_END}` : "";
			// Best-effort: refresh the persisted prompt-sections snapshot so the
			// inspector reflects this turn's dynamic-context blocks. Non-fatal.
			try {
				const parts = sessionManager.getPromptParts(sessionId);
				if (parts) {
					parts.dynamicContext = blocks;
					persistPromptSections(sessionId, parts, sessionManager.stateDir);
				}
			} catch (err) {
				console.debug(`[provider-hooks] prompt-sections refresh skipped for ${sessionId}:`, err);
			}
			json({
				content,
				tail,
				blocks: blocks.map((b) => ({ id: b.id, providerId: b.providerId, title: b.title, tokenEstimate: b.tokenEstimate })),
			});
		} catch (err: any) {
			jsonError(500, err);
		}
		return;
	}

	// POST /api/sessions/:id/provider-hooks/before-compact — notify providers before compaction.
	const beforeCompactMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/provider-hooks\/before-compact$/);
	if (beforeCompactMatch && req.method === "POST") {
		const sessionId = beforeCompactMatch[1];
		// The bridge forwards the about-to-be-lost span (and optionally a precomputed
		// summary) from the pi session_before_compact payload. Validate both as strings
		// so a malformed body is rejected rather than silently dispatched empty.
		const body = await readBody(req).catch(() => ({} as any));
		if (body && body.span !== undefined && typeof body.span !== "string") {
			json({ error: "span must be a string" }, 400);
			return;
		}
		if (body && body.summary !== undefined && typeof body.summary !== "string") {
			json({ error: "summary must be a string" }, 400);
			return;
		}
		const base = resolveHookCtx(sessionId);
		if (!base) {
			json({ error: "Session not found" }, 404);
			return;
		}
		const hub = sessionManager.lifecycleHub;
		if (!hub) {
			json({});
			return;
		}
		try {
			await hub.dispatch("beforeCompact", {
				...base,
				span: typeof body?.span === "string" ? body.span : undefined,
				summary: typeof body?.summary === "string" ? body.summary : undefined,
			});
			json({});
		} catch (err: any) {
			jsonError(500, err);
		}
		return;
	}

	// GET /api/sessions/:id/context-trace?limit=N — per-turn provider dispatch trace.
	const contextTraceMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/context-trace$/);
	if (contextTraceMatch && req.method === "GET") {
		const sessionId = contextTraceMatch[1];
		let limit: number | undefined;
		const rawLimit = url.searchParams.get("limit");
		if (rawLimit !== null) {
			const n = Number.parseInt(rawLimit, 10);
			if (Number.isFinite(n) && n > 0) limit = Math.min(n, 1000);
		}
		try {
			const entries = new ContextTraceStore(bobbitStateDir(), fsImpl).readTrace(sessionId, limit);
			json({ entries });
		} catch (err: any) {
			jsonError(500, err);
		}
		return;
	}

	// POST /api/sessions/:id/restart — restart a live session's agent process by id.
	const restartMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/restart$/);
	if (restartMatch && req.method === "POST") {
		let id: string;
		try {
			id = decodeURIComponent(restartMatch[1]);
		} catch {
			json({ error: "Session not found", code: "SESSION_NOT_FOUND" }, 404);
			return;
		}

		const session = sessionManager.getSession(id);
		const persisted = session ? sessionManager.getSessionStore(session.projectId).get(session.id) : undefined;
		if (!session || session.status === "terminated" || persisted?.archived) {
			json({ error: "Session not found", code: "SESSION_NOT_FOUND" }, 404);
			return;
		}
		if (session.readOnly || session.nonInteractive || persisted?.readOnly || persisted?.nonInteractive) {
			json({ error: "Session cannot be restarted", code: "SESSION_NOT_RESTARTABLE" }, 403);
			return;
		}

		const body = await readBody(req).catch(() => null);
		const status = String(session.status);
		if ((status === "busy" || status === "streaming" || session.isCompacting) && body?.force !== true) {
			json({ error: "Session is busy; retry with force to restart", code: "SESSION_BUSY" }, 409);
			return;
		}

		try {
			await sessionManager.restartAgent(id);
			json({ ok: true, sessionId: id });
		} catch (err: any) {
			const code = typeof err?.code === "string" && err.code ? err.code : "RESTART_ERROR";
			json({ error: err instanceof Error ? err.message : String(err), code }, 500);
		}
		return;
	}

	// GET /api/sessions/:id (exact match — not /api/sessions/:id/output etc.)
	const singleSessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
	if (singleSessionMatch && req.method === "GET") {
		const id = singleSessionMatch[1];
		const session = sessionManager.getSession(id);
		if (!session) {
			// Check if it's an archived session
			const archived = sessionManager.getArchivedSession(id);
			if (archived) {
				json({
					id: archived.id,
					title: archived.title,
					cwd: archived.cwd,
					projectId: archived.projectId,
					status: "archived",
					createdAt: archived.createdAt,
					lastActivity: archived.lastActivity,
					clientCount: 0,
					isCompacting: false,
					goalId: archived.goalId,
					assistantType: archived.assistantType,
					delegateOf: archived.delegateOf,
					parentSessionId: archived.parentSessionId,
					childKind: archived.childKind,
					readOnly: archived.readOnly,
					role: archived.role,
					accessory: archived.accessory,
					teamGoalId: archived.teamGoalId,
					teamLeadSessionId: archived.teamLeadSessionId,
					worktreePath: archived.worktreePath,
					taskId: archived.taskId,
					staffId: archived.staffId,
					colorIndex: colorStore.get(archived.id),
					preview: archived.preview,
					reattemptGoalId: archived.reattemptGoalId,
					archived: true,
					archivedAt: archived.archivedAt,
					imageGenerationModel: sessionManager.getImageModelForSession(archived.id),
				});
				return;
			}
			res.writeHead(404);
			res.end(JSON.stringify({ error: "Session not found" }));
			return;
		}
		const sessionPs = sessionManager.getSessionStore(session.projectId).get(session.id);
		json({
			id: session.id,
			title: session.title,
			cwd: session.cwd,
			status: session.status,
			createdAt: session.createdAt,
			lastActivity: session.lastActivity,
			clientCount: session.clients.size,
			isCompacting: session.isCompacting,
			goalId: session.goalId,
			assistantType: session.assistantType,
			// Legacy boolean fields for backward compat
			goalAssistant: session.assistantType === "goal",
			roleAssistant: session.assistantType === "role",
			toolAssistant: session.assistantType === "tool",
			delegateOf: session.delegateOf,
			parentSessionId: sessionPs?.parentSessionId ?? session.parentSessionId,
			childKind: sessionPs?.childKind ?? session.childKind,
			readOnly: sessionPs?.readOnly ?? session.readOnly,
			role: session.role,
			accessory: session.accessory,
			teamGoalId: session.teamGoalId,
			teamLeadSessionId: session.teamLeadSessionId,
			worktreePath: session.worktreePath,
			branch: session.branch ?? sessionPs?.branch,
			taskId: session.taskId,
			staffId: session.staffId,
			colorIndex: colorStore.get(session.id),
			preview: session.preview,
			reattemptGoalId: sessionPs?.reattemptGoalId,
			projectId: sessionPs?.projectId || session.projectId,
			// Persisted model selection (provider+id). Surfaces the result of
			// the WS `set_model` handler's `persistSessionModel` call so clients
			// (and tests) can verify the selection round-tripped to disk without
			// reaching into the WS state stream.
			modelProvider: sessionPs?.modelProvider,
			modelId: sessionPs?.modelId,
			spawnPinnedModel: session.spawnPinnedModel,
			spawnPinnedThinkingLevel: session.spawnPinnedThinkingLevel,
			restoreError: session.restoreError,
			lastTurnErrored: session.lastTurnErrored ?? false,
			consecutiveErrorTurns: session.consecutiveErrorTurns ?? 0,
			completedTurnCount: session.completedTurnCount ?? 0,
			imageGenerationModel: sessionManager.getImageModelForSession(session.id),
		});
		return;
	}

	// POST /api/sessions
	if (url.pathname === "/api/sessions" && req.method === "POST") {
		const __t0 = performance.now();
		try {
		const body = await readBody(req);

		// ── Delegate session creation ──
		if (body?.delegateOf && body?.instructions) {
			const parentId = typeof body.delegateOf === "string" ? body.delegateOf.trim() : "";
			if (!parentId) {
				json({ error: "delegateOf must reference a parent session" }, 400);
				return;
			}
			// Sandbox guard: delegate parent must be own session or registered child
			if (sandboxScope) {
				if (!sandboxScope.sessionIds.has(parentId)) {
					json({ error: "Forbidden: delegate parent must be own session" }, 403);
					return;
				}
			}
			const parentSession = sessionManager.getSession(parentId);
			const parentPersisted = parentSession ? undefined : sessionManager.getPersistedSession(parentId);
			if (!parentSession && !parentPersisted) {
				json({ error: "Delegate parent session not found" }, 404);
				return;
			}
			const parentProjectId = parentSession?.projectId ?? parentPersisted?.projectId;
			if (!parentProjectId) {
				json({ error: "Delegate parent session is missing projectId", code: "PROJECT_ID_REQUIRED" }, 422);
				return;
			}
			const explicitDelegateProjectId = typeof body?.projectId === "string" && body.projectId.trim().length > 0
				? body.projectId.trim()
				: undefined;
			if (explicitDelegateProjectId && explicitDelegateProjectId !== parentProjectId) {
				json({ error: "projectId must match the delegate parent session's projectId", code: "PROJECT_ID_MISMATCH" }, 422);
				return;
			}
			const parentProject = resolveProjectForRequest(projectRegistry, { projectId: parentProjectId }, {
				allowSystem: parentProjectId === SYSTEM_PROJECT_ID,
			});
			if (!parentProject.ok) { writeProjectResolutionError(parentProject); return; }
			const requestedCwd = typeof body.cwd === "string" && body.cwd.trim().length > 0
				? body.cwd.trim()
				: undefined;
			const cwd = requestedCwd ?? parentSession?.cwd ?? parentPersisted?.cwd ?? parentProject.project.rootPath;
			const cwdValidation = validateExecutionCwd(projectRegistry, projectContextManager, parentProjectId, cwd, { kind: "session", sessionId: parentId });
			if (!cwdValidation.ok) { writeCwdValidationError(cwdValidation); return; }
			try {
				const session = await sessionManager.createDelegateSession(parentId, {
					instructions: body.instructions,
					cwd,
					title: body.title,
					context: body.context,
				});
				// Register delegate as child in parent's sandbox scope
				if (sandboxScope && sandboxTokenStore) {
					sandboxTokenStore.addSession(sandboxScope.projectId, session.id);
				}
				json({
					id: session.id,
					cwd: session.cwd,
					status: session.status,
					projectId: session.projectId,
					delegateOf: session.delegateOf,
				}, 201);
			} catch (err) {
				jsonError(500, err);
			}
			return;
		}

		// ── Normal session creation ──
		const goalId = body?.goalId;

		// Accept both new assistantType and legacy boolean fields
		let assistantType = body?.assistantType as string | undefined;
		if (!assistantType) {
			if (body?.goalAssistant) assistantType = "goal";
			else if (body?.roleAssistant) assistantType = "role";
			else if (body?.toolAssistant) assistantType = "tool";
		}

		const explicitCwd = typeof body?.cwd === "string" && body.cwd.trim().length > 0
			? body.cwd.trim()
			: undefined;
		const explicitProjectId = typeof body?.projectId === "string" && body.projectId.trim().length > 0
			? body.projectId.trim()
			: undefined;

		// If creating under a goal, use the goal's cwd/project as the default.
		// NOTE: the goal's auto-transition to in-progress is deferred until AFTER
		// the sandbox ownership check below — a sandbox-scoped token must not be
		// able to mutate another project's goal state before we've verified the
		// goal is inside its scope.
		let cwd = explicitCwd || config.defaultCwd;
		let goalForSession: PersistedGoal | undefined;
		if (goalId) {
			goalForSession = getGoalAcrossProjects(goalId);
			if (goalForSession) {
				cwd = explicitCwd || goalForSession.cwd;
			}
		}

		const args = body?.args;

		// If a roleId is provided, resolve/apply it after resolvedProjectId is known.
		const roleId = body?.roleId;
		let createOpts: RoleCreateOptions | undefined;

		// ── Worktree support ──
		// Non-assistant, non-goal sessions get a worktree by default unless explicitly opted out.
		// Goal sessions have their own worktree logic via goalManager.setupWorktreeAndStartTeam().
		// Resolution of `worktreeOpts` is deferred until after `resolvedProjectId` is
		// finalised below — multi-repo (poly-repo) projects need the project's container
		// rootPath as repoPath, not `getRepoRoot(cwd)` (which fails for non-git containers).
		let worktreeOpts: { repoPath: string } | undefined;
		const wantWorktree = shouldCreateWorktree({ worktree: body?.worktree, assistantType, goalId }, true);

		// ── Re-attempt support ──
		const reattemptGoalId = body?.reattemptGoalId as string | undefined;

		// ── Sandbox request flag ──
		// Sandbox-scoped tokens MUST create sandboxed sessions — prevent escape.
		// Config/Docker preflight is deferred until after projectId resolution so it
		// uses the selected ProjectContext, not server/Headquarters config.
		let sandboxed = body?.sandboxed === true;
		if (sandboxScope) sandboxed = true;

		const isProjectAssistant = assistantType === "project" || assistantType === "project-scaffolding";
		// Role/Tool assistants can deliberately use the hidden system project when
		// no projectId is supplied. All normal user/work sessions need an explicit
		// projectId or a persisted goal/reattempt source project.
		const isServerScopeAssistant = assistantType === "role" || assistantType === "tool";

		// ── Sandbox scope ownership enforcement ──
		// Authorized delegate creation (body.delegateOf + instructions) is handled
		// and returned earlier. Any OTHER session creation reaching here under a
		// sandbox-scoped token must stay strictly inside that token's project/goal
		// scope. Enforce this BEFORE resolving the project or mutating any goal so a
		// compromised container cannot escape its scope, promote assistant/server
		// scope, or flip another project's goal to in-progress. Violations are 403.
		if (sandboxScope) {
			if (assistantType) {
				json({ error: "Forbidden: sandbox tokens cannot create assistant or server-scope sessions", code: "SANDBOX_SCOPE_VIOLATION" }, 403);
				return;
			}
			if (!explicitProjectId || explicitProjectId !== sandboxScope.projectId) {
				json({ error: "Forbidden: sandbox session projectId must match the sandbox scope", code: "SANDBOX_SCOPE_VIOLATION" }, 403);
				return;
			}
			if (goalId && !sandboxScope.goalIds.has(goalId)) {
				json({ error: "Forbidden: goal is outside the sandbox scope", code: "SANDBOX_SCOPE_VIOLATION" }, 403);
				return;
			}
			if (reattemptGoalId && !sandboxScope.goalIds.has(reattemptGoalId)) {
				json({ error: "Forbidden: reattempt goal is outside the sandbox scope", code: "SANDBOX_SCOPE_VIOLATION" }, 403);
				return;
			}
		}

		let resolvedProjectId = explicitProjectId;
		let resolvedProject: RegisteredProject | undefined;
		let provisionalProjectId: string | undefined;
		let cwdSource: CwdOwnershipSource = { kind: "user-input" };

		const goalProjectId = goalForSession?.projectId
			?? (goalId ? projectContextManager.getContextForGoal(goalId)?.project.id : undefined);
		if (goalProjectId) {
			if (resolvedProjectId && resolvedProjectId !== goalProjectId) {
				json({ error: "projectId must match the goal's projectId", code: "PROJECT_ID_MISMATCH" }, 422);
				return;
			}
			resolvedProjectId = goalProjectId;
			if (!explicitCwd) cwdSource = { kind: "goal", goalId };
		}

		// If re-attempting a goal, inherit cwd and projectId from the original goal.
		if (reattemptGoalId) {
			const origGoal = getGoalAcrossProjects(reattemptGoalId);
			if (origGoal) {
				if (!explicitCwd) cwd = origGoal.cwd || cwd;
				const origProjectId = origGoal.projectId ?? projectContextManager.getContextForGoal(reattemptGoalId)?.project.id;
				if (origProjectId) {
					if (resolvedProjectId && resolvedProjectId !== origProjectId) {
						json({ error: "projectId must match the reattempt goal's projectId", code: "PROJECT_ID_MISMATCH" }, 422);
						return;
					}
					resolvedProjectId = origProjectId;
					if (!explicitCwd) cwdSource = { kind: "goal", goalId: reattemptGoalId };
				}
			}
		}

		// For project assistants, register a provisional project at the target cwd.
		if (isProjectAssistant && cwd && !resolvedProjectId) {
			let provisionalProject: RegisteredProject;
			try {
				provisionalProject = projectRegistry.registerProvisional(path.basename(cwd), cwd);
			} catch (err) {
				if (writeSpecialProjectMutationError(err)) return;
				throw err;
			}
			provisionalProjectId = provisionalProject.id;
			resolvedProjectId = provisionalProject.id;
			// Ensure a ProjectContext exists for the provisional project
			const provCtx = projectContextManager.getOrCreate(provisionalProject.id);
			if (provCtx) {
				provCtx.gateStore.onStatusChange = () => {
					provCtx.goalStore.bumpGeneration();
				};
				wireGoalManagerResolvers(provCtx, { sessionManager, projectContextManager, projectRegistry });
			}
		}

		if (!resolvedProjectId && isServerScopeAssistant) {
			resolvedProjectId = SYSTEM_PROJECT_ID;
		}
		if (!resolvedProjectId) {
			const missing = resolveProjectForRequest(projectRegistry, { projectId: undefined });
			if (!missing.ok) writeProjectResolutionError(missing);
			return;
		}
		const resolved = resolveProjectForRequest(projectRegistry, { projectId: resolvedProjectId }, {
			allowSystem: isServerScopeAssistant && resolvedProjectId === SYSTEM_PROJECT_ID,
		});
		if (!resolved.ok) { writeProjectResolutionError(resolved); return; }
		resolvedProjectId = resolved.projectId;
		resolvedProject = resolved.project;
		const resolvedProjectContext = projectContextManager.getOrCreate(resolvedProjectId);

		// Server-scope assistants (role/tool) resolve to the hidden `system`
		// project, which has no user-facing root. They must operate strictly
		// under the Headquarters workspace directory (bobbitDir()), which is a
		// distinct location from the server run dir / system project rootPath.
		const isSystemScopeAssistant = isServerScopeAssistant && resolvedProjectId === SYSTEM_PROJECT_ID;
		if (!explicitCwd && !goalForSession && !reattemptGoalId && !isSystemScopeAssistant) {
			cwd = resolvedProject.rootPath;
		} else if (isSystemScopeAssistant && !goalForSession && !reattemptGoalId) {
			// Server-scope assistants (role/tool) must always create successfully
			// regardless of the caller-supplied cwd — they operate strictly under
			// the Headquarters workspace directory (bobbitDir()). Coerce the cwd:
			// honor an explicit cwd only when it is inside the Headquarters
			// directory (validated against the Headquarters project scope, whose
			// rootPath IS bobbitDir()); otherwise force it to the Headquarters
			// directory. Never reject a server-scope assistant over its cwd.
			const hqDir = bobbitDir();
			if (explicitCwd) {
				const hqCwdValidation = validateExecutionCwd(projectRegistry, projectContextManager, HEADQUARTERS_PROJECT_ID, explicitCwd, { kind: "user-input" });
				cwd = hqCwdValidation.ok ? explicitCwd : hqDir;
			} else {
				cwd = hqDir;
			}
		}

		// System-scope assistants were already constrained to the Headquarters
		// directory above; all other scopes must validate the resolved cwd
		// against the resolved project scope (never bypassed).
		const shouldValidateCwd = !isSystemScopeAssistant;
		if (shouldValidateCwd) {
			const cwdValidation = validateExecutionCwd(projectRegistry, projectContextManager, resolvedProjectId, cwd, cwdSource);
			if (!cwdValidation.ok) { writeCwdValidationError(cwdValidation); return; }
		}

		// Guard against stale cwd (e.g. re-attempting a goal whose worktree was deleted).
		// Only server-selected/persisted cwd values may fall back; explicit user cwd
		// must fail rather than being silently replaced with the project root.
		if (cwd && !fs.existsSync(cwd)) {
			const staleCwd = cwd;
			if (explicitCwd) {
				json({ error: `Working directory does not exist: ${staleCwd}` }, 400);
				return;
			}
			let fallback: string | undefined;
			if (fs.existsSync(resolvedProject.rootPath)) fallback = resolvedProject.rootPath;
			if (!fallback && fs.existsSync(config.defaultCwd)) fallback = config.defaultCwd;
			if (fallback) {
				console.warn(`[POST /api/sessions] cwd ${staleCwd} does not exist — falling back to ${fallback}`);
				cwd = fallback;
				if (shouldValidateCwd) {
					const fallbackValidation = validateExecutionCwd(projectRegistry, projectContextManager, resolvedProjectId, cwd, cwdSource);
					if (!fallbackValidation.ok) { writeCwdValidationError(fallbackValidation); return; }
				}
			} else {
				json({ error: `Working directory does not exist: ${staleCwd}` }, 400);
				return;
			}
		}

		// ── Sandbox validation ──
		if (sandboxed) {
			const sandboxConfig = resolvedProjectContext?.projectConfigStore.get("sandbox") || "none";
			if (sandboxConfig !== "docker") {
				json({ error: "Docker sandbox is not configured. Set sandbox: \"docker\" in project settings." }, 400);
				return;
			}
			// Skip Docker check if sandbox manager has ready containers.
			// Otherwise use a cached result to avoid running `docker info` on every session creation.
			const hasReadyContainer = sessionManager.getSandboxManager()?.getStats().containers.some(c => c.status === "ready") ?? false;
			if (!hasReadyContainer) {
				if (!_dockerAvailCache || Date.now() - _dockerAvailCache.ts > 60_000) {
					const dockerStatus = await checkDockerAvailability();
					_dockerAvailCache = { available: dockerStatus.available, error: dockerStatus.error, ts: Date.now() };
				}
				if (!_dockerAvailCache.available) {
					json({ error: `Docker is not available: ${_dockerAvailCache.error || "Docker not detected"}` }, 503);
					return;
				}
			}
		}

		if (roleId && typeof roleId === "string") {
			const role = resolveRoleForProject(roleId, resolvedProjectId);
			if (!role) {
				json({ error: `Role "${roleId}" not found` }, 404);
				return;
			}
			createOpts = roleCreateOptions(role);
		}

		// Now that `resolvedProjectId` is known, resolve `worktreeOpts`.
		// Multi-repo (poly-repo) short-circuit mirrors goal-manager.ts::createGoal:
		// if any component has repo !== ".", the project's rootPath IS the repoPath
		// even though it isn't itself a git repo. Without this, the `isGitRepo(cwd)`
		// check below returns false for the container directory and sessions would
		// run with no worktree at all.
		// Headquarters is no-worktree: skip the git probe entirely so no worktree
		// is ever resolved for HQ sessions (worktreeOpts stays undefined).
		if (wantWorktree && resolvedProjectId !== HEADQUARTERS_PROJECT_ID) {
			try {
				const projCtx = resolvedProjectId ? projectContextManager.getOrCreate(resolvedProjectId) : undefined;
				const proj = resolvedProjectId ? projectRegistry.get(resolvedProjectId) : undefined;
				// Single source of truth shared with the staff path
				// (staff-manager.ts) and goal path (goal-manager.ts).
				const components = projCtx?.projectConfigStore.getComponents() ?? [];
				const configuredBaseRef = projCtx?.projectConfigStore.get("base_ref") || undefined;
				const support = await resolveWorktreeSupport(components, proj?.rootPath, cwd, undefined, { configuredBaseRef, commandRunner: serverCommandRunner });
				if (support.supported && support.repoPath) {
					worktreeOpts = { repoPath: support.repoPath };
				}
			} catch {
				// Not a git repo or git not available — silently ignore
			}
		}

		// ── Sandbox auto-branch ──
		// For sandboxed non-goal, non-assistant sessions, generate a branch so they get
		// a container worktree instead of defaulting to /workspace.
		let autoSandboxBranch: string | undefined;
		if (sandboxed && !goalId && !assistantType) {
			const shortId = randomUUID().slice(0, 8);
			autoSandboxBranch = `session/s-${shortId}`;
		}

		// Auto-transition the goal to in-progress only after all request
		// validation has passed and immediately before creating the session.
		if (goalId && goalForSession && goalForSession.state === "todo") {
			await getGoalManagerForGoal(goalId).updateGoal(goalId, { state: "in-progress" });
		}

		try {
			const session = await sessionManager.createSession(cwd, args, goalId, assistantType, {
				...createOpts,
				worktreeOpts,
				reattemptGoalId,
				sandboxed,
				projectId: resolvedProjectId,
				...(autoSandboxBranch ? { sandboxBranch: autoSandboxBranch } : {}),
				parentSessionId: typeof body?.parentSessionId === "string" ? body.parentSessionId : undefined,
				childKind: typeof body?.childKind === "string" ? body.childKind : undefined,
				readOnly: typeof body?.readOnly === "boolean" ? body.readOnly : undefined,
			});

			// Set assistant role metadata if no explicit role was provided.
			// Role-aware: resolve the backing role via `assistantRoleForType` (the
			// single source of truth) and read its accessory from the resolved role
			// definition (support -> `support` + `headset`; other assistants ->
			// `assistant` + `wand`). Never hardcode the accessory string.
			if (!createOpts?.role && assistantType) {
				const resolvedRoleName = assistantRoleForType(assistantType);
				const resolvedRole = resolveRoleForProject(resolvedRoleName, resolvedProjectId);
				const resolvedAccessory = resolvedRole?.accessory ?? "wand";
				sessionManager.updateSessionMeta(session.id, { role: resolvedRoleName, accessory: resolvedAccessory });
				session.role = resolvedRoleName;
				session.accessory = resolvedAccessory;
			}

			// Store reattemptGoalId on the session if provided
			if (reattemptGoalId) {
				sessionManager.getSessionStore(session.projectId).update(session.id, { reattemptGoalId });
			}

			// Store projectId on the session if resolved from an explicit or persisted scope.
			// Project assistant sessions keep their provisional projectId so they
			// persist under the provisional project's store and appear in the sidebar.
			if (resolvedProjectId) {
				sessionManager.getSessionStore(session.projectId).update(session.id, { projectId: resolvedProjectId });
			}

			json({
				id: session.id,
				cwd: session.cwd,
				status: session.status,
				projectId: session.projectId ?? resolvedProjectId,
				goalId: session.goalId,
				assistantType: session.assistantType,
				// Legacy boolean fields for backward compat
				goalAssistant: session.assistantType === "goal",
				roleAssistant: session.assistantType === "role",
				toolAssistant: session.assistantType === "tool",
				role: session.role,
				accessory: session.accessory,
				parentSessionId: session.parentSessionId,
				childKind: session.childKind,
				readOnly: session.readOnly,
				reattemptGoalId,
				...(provisionalProjectId ? { provisionalProjectId } : {}),
			}, 201);
		} catch (err) {
			// Log full error context server-side so that flaky 500s in tests
			// (e.g. resilience suite under FS contention) leave a usable trail.
			// `String(err)` alone drops the stack and any error.cause chain.
			const e = err as Error & { code?: string; cause?: unknown };
			console.error(
				`[POST /api/sessions] failed cwd=${cwd ?? "(none)"} project=${resolvedProjectId ?? "(none)"} ` +
				`goal=${goalId ?? "(none)"} assistant=${assistantType ?? "(none)"} sandbox=${sandboxed ? "yes" : "no"}: ` +
				`${e.message ?? String(err)}\n${e.stack ?? ""}`,
			);
			if (e.cause) console.error("  caused by:", e.cause);
			json({
				error: String(err),
				message: e.message,
				code: e.code,
				cause: e.cause ? String(e.cause) : undefined,
			}, 500);
		}
		return;
		} finally {
			recordElapsed("POST /api/sessions", performance.now() - __t0);
		}
	}

	// ── Nested-goal endpoints ─────────────────────────────────────
	// REST surface for the team-lead-only `goal_*` tools. Implementation in
	// `nested-goal-routes.ts`. Cascade-affecting routes require explicit
	// `cascade` (422 otherwise). UI is the cascade-policy authority.
	if (await tryHandleNestedGoalRoute(req, url, {
		projectContextManager,
		verificationHarness,
		teamManager,
		sessionManager,
		// Always wired by the sole caller (see handleApiRoute optional-param note).
		cookieStore: cookieStore!,
		requireSubgoalsEnabled,
		getGoalAcrossProjects,
		getGoalManagerForGoal,
		readBody,
		json,
		jsonError,
		broadcastToAll,
		getSubgoalNestingPrefs: () => readSubgoalNestingPrefs((k) => preferencesStore.get(k)),
	})) return;

	// GET /api/goals/:goalId/descendants — live + archived descendants for the Plan tab.
	// Feeds dashboardDescendants in goal-dashboard.ts so archived children render in the DAG
	// and contribute to tree-cost rollups. Without this route, the Plan tab silently drops
	// every archived/completed child.
	const goalDescendantsMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/descendants$/);
	if (goalDescendantsMatch && req.method === "GET") {
		const goalId = goalDescendantsMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (!goal.projectId) { json({ goals: [] }); return; }
		const ctx = projectContextManager.getContextForGoal(goalId);
		if (!ctx) { json({ error: "Goal project context not found" }, 404); return; }
		// getAll() returns both live and archived.
		const allGoals = ctx.goalStore.getAll();
		// Enrich each descendant with the Plan-tab data contract: `mergeConflict`
		// (durable, from the goal record) and `gateStatus` (aggregated from the
		// child's workflow gates). The frontend consumes these exact names.
		const enriched = enrichDescendantsForPlan(collectDescendants(goalId, allGoals), {
			getGatesForGoal: (gid) => ctx.gateStore.getGatesForGoal(gid),
			hasActiveVerification: (gid) => verificationHarness.getActiveVerifications(gid).length > 0,
		});
		json({ goals: enriched });
		return;
	}

	// GET /api/goals/:goalId/tree-cost — cost rollup across descendant tree (live + archived).
	const goalTreeCostMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/tree-cost$/);
	if (goalTreeCostMatch && req.method === "GET") {
		if (!requireSubgoalsEnabled()) return;
		const goalId = goalTreeCostMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		// Dashboard tree-cost is intentionally rooted at the REQUESTED goal,
		// not its topmost ancestor (`goal.rootGoalId`). Opening a subgoal's
		// dashboard must show the rollup of that subgoal + its descendants only;
		// using `rootGoalId` would leak the whole project's grand total down to
		// every descendant view. `computeTreeCost` consumes `walkGoalSubtree`
		// for the descendant walk — do not add another traversal helper here.
		// Pinned by tests/api-goals-tree-cost.test.ts and
		// tests/e2e/ui/tree-cost-rollup.spec.ts — do not "fix" this back to
		// `goal.rootGoalId ?? goal.id` without tripping those tests.
		if (!goal.projectId) {
			json({ rootGoalId: goalId, totalCostUsd: 0, totalTokensIn: 0, totalTokensOut: 0, breakdown: [] });
			return;
		}
		const ctx = projectContextManager.getContextForGoal(goalId);
		if (!ctx) { json({ error: "Goal project context not found" }, 404); return; }
		const allGoals = ctx.goalStore.getAll();
		const costTracker = sessionManager.getCostTracker(goal.projectId);
		const result = computeTreeCost(
			goalId,
			allGoals,
			costTracker,
			(gid) => sessionManager.getAllSessionIdsForGoal(gid),
		);
		// Surface the unattributable legacy bucket (cost entries whose
		// `goalId` could not be recovered by the boot backfill). NOT added
		// to `totalCostUsd` — it's an informational residual, separate from
		// the selected goal's subtree. Hidden entirely when empty.
		const legacy = costTracker.getUnattributableLegacyCostWithMetadata();
		if (legacy.totalCost > 0 || legacy.inputTokens > 0 || legacy.outputTokens > 0) {
			const payload: {
				goalId: string;
				title: string;
				costUsd: number;
				tokensIn: number;
				tokensOut: number;
				firstSeenAt?: number;
			} = {
				goalId: "__unattributable__",
				title: "Unattributable (legacy)",
				costUsd: legacy.totalCost,
				tokensIn: legacy.inputTokens,
				tokensOut: legacy.outputTokens,
			};
			if (typeof legacy.firstSeenAt === "number") payload.firstSeenAt = legacy.firstSeenAt;
			(result as typeof result & { unattributableLegacy?: unknown }).unattributableLegacy = payload;
		}
		json(result);
		return;
	}

	// ── Goal endpoints ─────────────────────────────────────────────

	// GET /api/goals
	if (url.pathname === "/api/goals" && req.method === "GET") {
		// Paginated archived goals — aggregate across all projects
		if (url.searchParams.get("archived") === "true") {
			const paging = readOffsetPaging();
			const cursorParam = url.searchParams.get("cursor") ?? url.searchParams.get("after");
			const afterCursor = cursorParam !== null ? parseInt(cursorParam, 10) : undefined;
			const hasCursor = afterCursor !== undefined && Number.isFinite(afterCursor);
			const filterProjectId = url.searchParams.get("projectId") || undefined;
			const archivedQuery = normalizedArchivedQuery(url.searchParams.get("q"));
			// Aggregate archived goals across all project contexts
			let allArchived: PersistedGoal[] = [];
			const sessionsForGoalQuery: any[] = [];
			for (const liveSession of sessionManager.listSessions()) {
				if (filterProjectId && liveSession.projectId !== filterProjectId) continue;
				sessionsForGoalQuery.push(liveSession);
			}
			for (const ctx of projectContextManager.visible()) {
				if (filterProjectId && ctx.project.id !== filterProjectId) continue;
				allArchived.push(...ctx.goalStore.getArchived());
				for (const s of ctx.sessionStore.getArchived()) {
					sessionsForGoalQuery.push({ ...s, colorIndex: colorStore.get(s.id), status: "archived" });
				}
			}
			if (archivedQuery) {
				allArchived = allArchived.filter(g => archivedGoalMatchesQuery(g, sessionsForGoalQuery, archivedQuery));
			}
			allArchived.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
			const total = allArchived.length;
			if (hasCursor) {
				allArchived = allArchived.filter(g => (g.archivedAt ?? 0) < afterCursor!);
			} else if (paging.offset > 0) {
				allArchived = allArchived.slice(paging.offset);
			}
			const page = allArchived.slice(0, paging.limit);
			const hasMore = allArchived.length > paging.limit;
			const nextCursor = page.length > 0 ? page[page.length - 1].archivedAt : undefined;
			const nextOffset = hasMore && !hasCursor ? paging.offset + paging.limit : undefined;

			// Collect archived sessions affiliated with goals in this page
			const goalIdsInPage = new Set(page.map((g: any) => g.id));
			const affiliatedSessions: any[] = [];
			const seenSessionIds = new Set<string>();
			for (const ctx of projectContextManager.visible()) {
				for (const s of ctx.sessionStore.getArchived()) {
					if (!seenSessionIds.has(s.id) && (goalIdsInPage.has((s as any).teamGoalId) || goalIdsInPage.has((s as any).goalId))) {
						seenSessionIds.add(s.id);
						affiliatedSessions.push({ ...s, colorIndex: colorStore.get(s.id), status: "archived" });
					}
				}
			}
			// BFS walk delegate/team chains from affiliated sessions.
			const delegateEnriched = bfsEnrichArchivedIndexed(
				affiliatedSessions.map(s => s.id),
				visibleArchivedRaw(),
				(s) => ({ ...s, colorIndex: colorStore.get(s.id), status: "archived" } as any),
			);
			for (const s of delegateEnriched) {
				if (!seenSessionIds.has(s.id)) {
					seenSessionIds.add(s.id);
					affiliatedSessions.push(s);
				}
			}

			json({ goals: page, total, limit: paging.limit, offset: !hasCursor ? paging.offset : undefined, hasMore, nextCursor, ...(nextOffset !== undefined ? { nextOffset } : {}), archivedSessions: affiliatedSessions });
			return;
		}

		const currentGen = projectContextManager.getGoalGeneration();
		const sinceParam = url.searchParams.get("since");
		if (sinceParam !== null) {
			const since = parseInt(sinceParam, 10);
			if (!isNaN(since) && since === currentGen) {
				json({ generation: currentGen, changed: false });
				return;
			}
		}
		const filterProjectId = url.searchParams.get("projectId") || undefined;
		const goals = listGoalsAcrossProjects({ projectId: filterProjectId });
		const paging = readOffsetPaging();
		if (paging.enabled) {
			const page = pageArray(goals, paging);
			json({ generation: currentGen, goals: page.items, total: page.total, limit: page.limit, offset: page.offset, hasMore: page.hasMore, ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}) });
			return;
		}
		json({ generation: currentGen, goals });
		return;
	}

	// POST /api/goals
	if (url.pathname === "/api/goals" && req.method === "POST") {
		const body = await readBody(req);
		const title = body?.title;
		const explicitCwd = typeof body?.cwd === "string" && body.cwd.trim().length > 0
			? body.cwd.trim()
			: undefined;
		let cwd = explicitCwd || config.defaultCwd;
		const spec = body?.spec || "";
		const workflowId = (body?.workflowId && typeof body.workflowId === "string") ? body.workflowId : "general";
		if (!title || typeof title !== "string") {
			json({ error: "Missing title" }, 400);
			return;
		}
		try {
			const sandboxed = body.sandboxed === true;
			const autoStartTeam = body.autoStartTeam !== false; // default true
			// Per-goal metadata (optional, arbitrary namespaced key/value bag, e.g.
			// `bobbit.disabledTools`, `hindsight.memory.enabled`). Accepted only as a
			// NON-EMPTY plain object; passed verbatim to createGoal where it is
			// persisted and resolved hierarchically down the goal tree. Supersedes the
			// removed per-goal worktree-setup hook (PR #816); legacy
			// `worktreeSetupCommand`/`worktreeSetupTimeoutMs` body fields are now
			// ignored (no parse, no persistence). Component-level
			// `worktree_setup_command` is unaffected.
			let metadata: Record<string, unknown> | undefined;
			{
				const raw = body.metadata;
				if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw as object).length > 0) {
					metadata = raw as Record<string, unknown>;
				}
			}
			let enabledOptionalSteps: string[] | undefined;
			if (Array.isArray(body.enabledOptionalSteps) && body.enabledOptionalSteps.every((s: unknown) => typeof s === "string")) {
				enabledOptionalSteps = body.enabledOptionalSteps;
			}
			const resolved = resolveProjectForRequest(projectRegistry, { projectId: body.projectId });
			if (!resolved.ok) { writeProjectResolutionError(resolved); return; }
			const targetProjectId = resolved.projectId;
			if (!explicitCwd) cwd = resolved.project.rootPath;
			const cwdValidation = validateExecutionCwd(projectRegistry, projectContextManager, targetProjectId, cwd, { kind: "user-input" });
			if (!cwdValidation.ok) { writeCwdValidationError(cwdValidation); return; }
			const targetCtx = projectContextManager.getOrCreate(targetProjectId);
			if (!targetCtx) {
				json({ error: "Invalid project" }, 400);
				return;
			}
			// Lazy per-project sandbox init — idempotent, deduped by SandboxManager.
			if (sandboxed && sandboxManager) {
				try {
					await sandboxManager.ensureForProject(targetProjectId);
				} catch (err) {
					jsonError(500, err, { error: `Sandbox init failed: ${(err as Error).message || err}` });
					return;
				}
			}
			const targetGoalManager = targetCtx.goalManager;
			// Handle parentGoalId — depth cap validation (same gate as goal_spawn_child).
			const parentGoalId = (body?.parentGoalId && typeof body.parentGoalId === "string") ? body.parentGoalId.trim() : undefined;
			let resolvedParentGoal: PersistedGoal | undefined;
			if (parentGoalId) {
				// Parent MUST be in the same project context — cross-project hierarchy
				// would corrupt the parentGoalId chain because createGoal only walks
				// its own store. Reject cross-project parents with a clear 422.
				resolvedParentGoal = targetGoalManager.getGoal(parentGoalId);
				if (!resolvedParentGoal) {
					const crossProject = getGoalAcrossProjects(parentGoalId);
					if (crossProject) {
						json({ error: "Parent goal belongs to a different project. Select a parent in the same project.", code: "PARENT_CROSS_PROJECT" }, 422);
					} else {
						json({ error: "Parent goal not found", code: "PARENT_NOT_FOUND" }, 422);
					}
					return;
				}
				// S1 SECURITY: creating a child via `POST /api/goals` with a
				// `parentGoalId` is a Children mutation — it spawns and can
				// auto-start a child team under another goal. It MUST be
				// authorized like the other Children verbs BEFORE anything is
				// created/started; previously this path validated parent
				// existence + nesting + pause then created the child with NO
				// authz, letting any shared-bearer-token holder (incl. a
				// non-team-lead agent) drive child creation under an arbitrary
				// goal and bypass the Children tool policy + per-session secret
				// binding. This is an OPERATOR-class verb: the proposal UI drives
				// it (verified human cookie accepted), otherwise the AUTHENTIC
				// caller (derived server-side from the unforgeable per-session
				// secret, never the public spawning-session header) must match
				// the team-lead of the parent's ROOT goal. See
				// children-mutation-authz.ts.
				{
					const h = req.headers as Record<string, string | string[] | undefined>;
					const readHeader = (n: string): string | undefined => {
						const v = h[n.toLowerCase()];
						const s = Array.isArray(v) ? v[0] : v;
						return typeof s === "string" && s.trim() ? s.trim() : undefined;
					};
					const rootGoalId = resolvedParentGoal.rootGoalId ?? resolvedParentGoal.id;
					const authz = authorizeChildrenMutation({
						mutationClass: "operator",
						isHumanOperator: cookieTryAuth(req, cookieStore!),
						// Derive the AUTHENTIC caller from the per-session secret,
						// never the forgeable public spawning-session header.
						authenticCallerSessionId: sessionManager.sessionSecretStore.resolveSessionIdBySecret(
							readHeader("x-bobbit-session-secret"),
						),
						teamLeadSessionId: teamManager.getTeamState(rootGoalId)?.teamLeadSessionId,
					});
					if (!authz.ok) {
						json({
							error: "Caller session is not the team-lead for this goal",
							code: "NOT_TEAM_LEAD",
							goalId: parentGoalId,
						}, 403);
						return;
					}
				}
				// Pause-cascade (Finding 1): refuse to create/auto-start a child
				// under a paused parent OR any paused ancestor. Mirrors the
				// guarantee `/spawn-child` and the harness `runSubgoalStep` already
				// enforce — `POST /api/goals` with `parentGoalId` previously
				// bypassed it entirely (validated parent existence + nesting, then
				// created + auto-started the child). The walk is cycle-guarded.
				try {
					requireAncestorsNotPaused(
						parentGoalId,
						(id) => targetGoalManager.getGoal(id) ?? getGoalAcrossProjects(id),
					);
				} catch (err) {
					if (err instanceof GoalPausedError) {
						json({ error: err.message, code: err.code, goalId: err.goalId }, 409);
						return;
					}
					throw err;
				}
				const prefs = readSubgoalNestingPrefs((k) => preferencesStore.get(k));
				const nestResult = checkCanSpawnChild(
					resolvedParentGoal,
					prefs,
					(id) => targetGoalManager.getGoal(id) ?? getGoalAcrossProjects(id),
				);
				if (!nestResult.ok) {
					if (nestResult.code === "SUBGOALS_DISABLED") {
						json({ error: "Subgoals are disabled", code: "SUBGOALS_DISABLED" }, 422);
						return;
					}
					if (nestResult.code === "PARENT_SUBGOALS_DISABLED") {
						json({
							error: `Parent goal "${resolvedParentGoal.title}" doesn't allow sub-goals`,
							code: "PARENT_SUBGOALS_DISABLED",
						}, 422);
						return;
					}
					if (nestResult.code === "NESTING_DEPTH_EXCEEDED") {
						json({
							error: `Nesting depth cap reached: ${nestResult.currentDepth} / ${nestResult.maxDepth}`,
							code: "NESTING_DEPTH_EXCEEDED",
							currentDepth: nestResult.currentDepth,
							maxDepth: nestResult.maxDepth,
						}, 422);
						return;
					}
				}
			}
			// Cascade: body.workflow (inline snapshot) → workflowId lookup → auto-seed → first match.
			let resolvedWorkflow: Workflow | undefined;
			let resolvedWorkflowId = workflowId;
			const inlineWorkflow = body?.workflow;
			if (inlineWorkflow && typeof inlineWorkflow === "object") {
				resolvedWorkflow = inlineWorkflow as Workflow;
				resolvedWorkflowId = (inlineWorkflow as { id?: string }).id || workflowId;
			} else {
				// Layer 1: cascade lookup (only when workflowId given).
				if (workflowId) {
					const cascadeWorkflows = configCascade.resolveWorkflows(targetProjectId);
					resolvedWorkflow = cascadeWorkflows.find(r => r.item.id === workflowId)?.item;
					// Layer 1b: cascade miss — fall through to project store directly.
					if (!resolvedWorkflow) {
						resolvedWorkflow = targetCtx.workflowStore.get(workflowId);
					}
				}
				// Layer 2: store is empty → auto-seed defaults.
				if (!resolvedWorkflow && targetCtx.workflowStore.getAll().length === 0) {
					const projName = resolved.project.name || "project";
					const seeds = buildDefaultWorkflows(projName);
					seeds.parent = buildParentWorkflow();
					for (const wf of Object.values(seeds)) {
						targetCtx.workflowStore.put(wf as unknown as Workflow);
					}
					console.log(`[api] Auto-seeded ${Object.keys(seeds).length} default workflows for project "${projName}" on first goal creation`);
					if (workflowId) {
						resolvedWorkflow = targetCtx.workflowStore.get(workflowId);
					} else {
						resolvedWorkflow = targetCtx.workflowStore.get("general") ?? targetCtx.workflowStore.getAll()[0];
						resolvedWorkflowId = resolvedWorkflow?.id || "general";
					}
				}
				// Layer 3: explicit id given, store non-empty, still unknown → friendly 400.
				if (workflowId && !resolvedWorkflow && targetCtx.workflowStore.getAll().length > 0) {
					const available = targetCtx.workflowStore.getAll().map(w => w.id);
					jsonError(400, new Error(`Workflow "${workflowId}" not found`), {
						error: `Workflow "${workflowId}" not found. Available: ${available.join(", ")}`,
						code: "WORKFLOW_NOT_FOUND",
						workflowId,
						available,
					});
					return;
				}
			}
			// Resolve per-goal subgoal-nesting overrides.
			//
			// Two inputs: the parent's effective inherited ceiling (if any) and the
			// explicit body values from the proposal form. Rules:
			//   - System pref is the global ceiling (subgoalsEnabled gate + maxDepth cap).
			//   - For child goals the parent's effective values are also a ceiling.
			//   - Explicit body values can only tighten/disable, never exceed the ceiling.
			// Helpers from subgoal-nesting-limit.ts compute the ceiling so this stays
			// the single source of truth.
			const nestingPrefs = readSubgoalNestingPrefs((k) => preferencesStore.get(k));
			const inheritedNesting = (parentGoalId && resolvedParentGoal)
				? inheritedChildOverrides(
					resolvedParentGoal,
					nestingPrefs,
					(id) => targetGoalManager.getGoal(id) ?? getGoalAcrossProjects(id),
				)
				: undefined;
			const ceilSubgoalsAllowed = inheritedNesting
				? inheritedNesting.subgoalsAllowed
				: nestingPrefs.subgoalsEnabled;
			const ceilMaxNestingDepth = inheritedNesting
				? inheritedNesting.maxNestingDepth
				: nestingPrefs.maxNestingDepth;
			const bodySubgoalsAllowedRaw = body?.subgoalsAllowed;
			const bodyMaxNestingDepthRaw = body?.maxNestingDepth;
			let effSubgoalsAllowed: boolean | undefined = inheritedNesting?.subgoalsAllowed;
			if (typeof bodySubgoalsAllowedRaw === "boolean") {
				// body=false always wins (disable always allowed); body=true only if
				// the ceiling permits it. System/parent OFF blocks the explicit true.
				effSubgoalsAllowed = bodySubgoalsAllowedRaw && ceilSubgoalsAllowed;
			}
			let effMaxNestingDepth: number | undefined = inheritedNesting?.maxNestingDepth;
			if (typeof bodyMaxNestingDepthRaw === "number" && Number.isFinite(bodyMaxNestingDepthRaw)) {
				effMaxNestingDepth = Math.min(clampMaxDepth(bodyMaxNestingDepthRaw), ceilMaxNestingDepth);
			}
			const bodyInlineRoles = (body?.inlineRoles && typeof body.inlineRoles === "object" && !Array.isArray(body.inlineRoles))
				? body.inlineRoles as Record<string, import("./agent/role-store.js").Role>
				: undefined;
			// Root-only orchestration policy. Only honoured for top-level goals
			// (no parentGoalId); children inherit the root's values. Mirrors the
			// validation in PATCH /api/goals/:id/policy.
			const isRootGoalCreate = parentGoalId === undefined;
			let effDivergencePolicy: "strict" | "balanced" | "autonomous" | undefined;
			if (isRootGoalCreate && (body?.divergencePolicy === "strict" || body?.divergencePolicy === "balanced" || body?.divergencePolicy === "autonomous")) {
				effDivergencePolicy = body.divergencePolicy;
			}
			let effMaxConcurrentChildren: number | undefined;
			if (isRootGoalCreate && typeof body?.maxConcurrentChildren === "number" && Number.isFinite(body.maxConcurrentChildren)) {
				const n = Math.floor(body.maxConcurrentChildren);
				if (n >= 1 && n <= 8) effMaxConcurrentChildren = n;
			}
			const explicitWorktree = typeof body?.worktree === "boolean" ? body.worktree : undefined;
			// Validate the raw definition before normalization can discard malformed
			// aliases/metadata, then snapshot the same canonical deep clone used by
			// goal-workflow replacement. Component/command references are deliberately
			// not re-resolved here: the selected workflow may come from another cascade
			// layer or predate the target project's current component commands. Project
			// workflow mutations and the workflow PUT endpoint remain strict.
			if (resolvedWorkflow) {
				resolvedWorkflow = freezeWorkflowDefinition(
					resolvedWorkflow,
					targetCtx.projectConfigStore.getComponents(),
					resolvedWorkflowId,
					{ validateComponentReferences: false },
				);
			}
			const goal = await targetGoalManager.createGoal(title, cwd, {
				spec,
				workflowId: resolvedWorkflowId,
				workflowStore: targetCtx.workflowStore,
				resolvedWorkflow,
				sandboxed,
				enabledOptionalSteps,
				projectId: targetProjectId,
				parentGoalId,
				inlineRoles: bodyInlineRoles,
				subgoalsAllowed: effSubgoalsAllowed,
				maxNestingDepth: effMaxNestingDepth,
				divergencePolicy: effDivergencePolicy,
				maxConcurrentChildren: effMaxConcurrentChildren,
				metadata,
				worktree: explicitWorktree,
			});
			// Set projectId from the explicit request scope.
			if (targetProjectId) {
				targetGoalManager.updateGoal(goal.id, { projectId: targetProjectId });
				goal.projectId = targetProjectId;
			}
			// Set reattemptOf if provided
			if (body.reattemptOf && typeof body.reattemptOf === "string") {
				targetGoalManager.updateGoal(goal.id, { reattemptOf: body.reattemptOf });
				goal.reattemptOf = body.reattemptOf;
			}
			// Persist autoStartTeam flag
			targetGoalManager.updateGoal(goal.id, { autoStartTeam });
			goal.autoStartTeam = autoStartTeam;
			// Initialize gate states for the workflow
			if (goal.workflow) {
				targetCtx.gateStore.initGatesForGoal(goal.id, goal.workflow.gates.map(g => g.id));
			}
			json(goal, 201);

			// Fire-and-forget async worktree setup (and optionally start team)
			if (goal.autoStartTeam && parentGoalId) {
				// Finding 2 — a child goal auto-start must go through the
				// unified per-root scheduler so the concurrency cap applies to
				// the `POST /api/goals` child path too (previously it started
				// the team with NO permit). At cap the child is parked
				// `state='blocked'` (capacity-blocked) and started later when a
				// permit frees; the scheduler handles setup + broadcasts.
				//
				// Guard is `state !== "blocked"` (NOT `setupStatus ===
				// "preparing"`): a data-only / non-git child is created with
				// `setupStatus === "ready"` (no worktree), so gating on
				// "preparing" silently skipped the start and its team never ran.
				// `requestChildStart` → `_startScheduledChildTeam` handles both
				// "preparing" (setup + start) and "ready" (start-only). A blocked
				// child (deps unmet) is not started here — it starts on unblock.
				if (goal.state !== "blocked") {
					const outcome = verificationHarness.requestChildStart(goal.id);
					if (outcome === "capacity-blocked") {
						targetGoalManager.updateGoal(goal.id, { state: "blocked" });
						broadcastToAll({ type: "goal_state_changed", goalId: goal.id });
					}
				}
			} else if (goal.setupStatus === "preparing") {
				if (goal.autoStartTeam) {
					targetGoalManager.setupWorktreeAndStartTeam(goal.id, () => teamManager.startTeam(goal.id)).then(() => {
						broadcastToAll({ type: "goal_setup_complete", goalId: goal.id });
					}).catch((err) => {
						const g = targetGoalManager.getGoal(goal.id);
						if (g?.setupStatus === "ready") {
							broadcastToAll({ type: "goal_setup_complete", goalId: goal.id });
							console.error("[goal] Auto-start team failed (worktree ready):", err);
						} else {
							broadcastToAll({ type: "goal_setup_error", goalId: goal.id, error: String(err) });
						}
					});
				} else {
					targetGoalManager.setupWorktree(goal.id).then(() => {
						broadcastToAll({ type: "goal_setup_complete", goalId: goal.id });
					}).catch((err) => {
						broadcastToAll({ type: "goal_setup_error", goalId: goal.id, error: String(err) });
					});
				}
			}
		} catch (err) {
			jsonError(400, err);
		}
		return;
	}

	// PUT /api/goals/:goalId/workflow — replace the goal's complete frozen workflow snapshot.
	const goalWorkflowPutMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/workflow$/);
	if (goalWorkflowPutMatch && req.method === "PUT") {
		const goalId = goalWorkflowPutMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (!goal.workflow) { json({ error: "Goal has no workflow to replace" }, 400); return; }
		const workflowCtx = projectContextManager.getContextForGoal(goalId);
		if (!workflowCtx) { json({ error: "Goal project context not found" }, 404); return; }

		// This is the only await in the route. The active-verification read and all
		// mutations below intentionally form one synchronous continuation so a new
		// verification cannot interleave with the conflict check.
		const body = await readBody(req);
		if (body === null || typeof body !== "object" || Array.isArray(body)) {
			json({ error: "Workflow body must be a plain object" }, 400);
			return;
		}
		const oldWorkflow = goal.workflow;
		if (Object.prototype.hasOwnProperty.call(body, "id") && body.id !== oldWorkflow.id) {
			json({ error: `Workflow id must remain "${oldWorkflow.id}"` }, 400);
			return;
		}

		let frozen: Workflow;
		try {
			frozen = freezeWorkflowDefinition({
				...body,
				id: oldWorkflow.id,
				createdAt: oldWorkflow.createdAt,
				updatedAt: Date.now(),
				hidden: oldWorkflow.hidden,
			}, workflowCtx.projectConfigStore.getComponents(), oldWorkflow.id);
		} catch (error) {
			jsonError(400, error);
			return;
		}

		// Gate array order is presentation-only. Compare canonical definitions by
		// id; ordering inside dependsOn/verify remains significant via deep equality.
		const oldById = new Map(oldWorkflow.gates.map(gate => [gate.id, gate]));
		const newById = new Map(frozen.gates.map(gate => [gate.id, gate]));
		const modifiedOrRemoved = new Set<string>();
		for (const [gateId, oldGate] of oldById) {
			const newGate = newById.get(gateId);
			if (!newGate || !isDeepStrictEqual(oldGate, newGate)) modifiedOrRemoved.add(gateId);
		}

		const conflictingGateIds = [...new Set(
			verificationHarness.getActiveVerifications(goalId)
				.filter(active => !active.cancelled && active.overallStatus === "running" && modifiedOrRemoved.has(active.gateId))
				.map(active => active.gateId),
		)];
		if (conflictingGateIds.length > 0) {
			json({
				error: "Workflow cannot modify or remove gates with active verifications",
				code: "WORKFLOW_ACTIVE_VERIFICATION",
				gateIds: conflictingGateIds,
			}, 409);
			return;
		}

		workflowCtx.goalManager.getGoalStore().update(goalId, { workflow: frozen });
		goal.workflow = frozen;
		type WorkflowGateReconciler = {
			reconcileGatesForGoal(goalId: string, nextGateIds: Iterable<string>, modifiedGateIds?: Iterable<string>): void;
		};
		(workflowCtx.gateStore as typeof workflowCtx.gateStore & WorkflowGateReconciler)
			.reconcileGatesForGoal(goalId, newById.keys(), modifiedOrRemoved);
		broadcastToAll({ type: "goal_state_changed", goalId });
		json(frozen);
		return;
	}

	// POST /api/goals/:id/retry-setup � retry worktree setup for a goal in error state
	const retrySetupMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/retry-setup$/);
	if (retrySetupMatch && req.method === "POST") {
		const goalId = retrySetupMatch[1];
		const retryGoalManager = getGoalManagerForGoal(goalId);
		const ok = retryGoalManager.retrySetup(goalId);
		if (!ok) {
			json({ error: "Goal not found or not in error state" }, 400);
			return;
		}
		json({ ok: true });
		// Fire-and-forget async worktree setup (and optionally start team)
		const retryGoal = retryGoalManager.getGoal(goalId);
		if (retryGoal?.autoStartTeam) {
			retryGoalManager.setupWorktreeAndStartTeam(goalId, () => teamManager.startTeam(goalId)).then(() => {
				broadcastToAll({ type: "goal_setup_complete", goalId });
			}).catch((err) => {
				const g = retryGoalManager.getGoal(goalId);
				if (g?.setupStatus === "ready") {
					broadcastToAll({ type: "goal_setup_complete", goalId });
					console.error("[goal] Auto-start team failed on retry (worktree ready):", err);
				} else {
					broadcastToAll({ type: "goal_setup_error", goalId, error: String(err) });
				}
			});
		} else {
			retryGoalManager.setupWorktree(goalId).then(() => {
				broadcastToAll({ type: "goal_setup_complete", goalId });
			}).catch((err) => {
				broadcastToAll({ type: "goal_setup_error", goalId, error: String(err) });
			});
		}
		return;
	}

	/**
	 * Archive a goal (root or cascade). Extracted from the DELETE
	 * `/api/goals/:id` handler so the parent-scoped
	 * `DELETE /api/goals/:parentId/archive-child/:childId` route can
	 * reuse the exact same cascade + mergedManually semantics after
	 * its parent-child authorization check.
	 *
	 * Reads `cascade` / `mergedManually` from `url.searchParams`; writes
	 * the response via the closed-over `json` helper.
	 */
	const archiveGoalEndpoint = async (id: string): Promise<void> => {
		// `cascade` is REQUIRED — mirrors pause/resume/teardown. The UI is
		// the cascade-policy authority; api.ts always sends ?cascade=.
		const cascadeParam = url.searchParams.get("cascade");
		if (cascadeParam !== "true" && cascadeParam !== "false") {
			json({ error: "cascade=true|false query parameter is required", code: "CASCADE_REQUIRED" }, 422);
			return;
		}
		const cascade = cascadeParam === "true";

		const rootGoal = getGoalAcrossProjects(id);
		if (!rootGoal) { json({ error: "Goal not found" }, 404); return; }

		if (!cascade) {
			const liveDescendants = listDescendants(projectContextManager, id, { includeArchived: false });
			if (liveDescendants.length > 0) {
				json({
					error: `Goal has ${liveDescendants.length} live descendant(s). Re-call with ?cascade=true to archive them all.`,
					code: "HAS_DESCENDANTS",
					count: liveDescendants.length,
				}, 409);
				return;
			}
		}

		const mergedManually = url.searchParams.get("mergedManually") === "true";

		const archiveOne = async (g: import("./agent/goal-store.js").PersistedGoal): Promise<boolean> => {
			if (g.archived) {
				try {
					await cleanupGateDiagnosticsForGoal(g.id, projectContextManager.getContextForGoal(g.id)?.stateDir);
				} catch (err) {
					console.warn(`[api] archive: gate diagnostics cleanup failed for already-archived goal ${g.id}:`, err);
				}
				return false;
			}
			if (mergedManually && g.id === id && g.state !== "complete") {
				await getGoalManagerForGoal(g.id).updateGoal(g.id, { state: "complete" });
			}
			for (const active of verificationHarness.getActiveVerifications(g.id)) {
				try {
					await verificationHarness.cancelStaleVerifications(g.id, active.gateId);
				} catch (err) {
					console.error(`[api] archive: error cancelling verification for ${g.id}/${active.gateId}:`, err);
				}
			}
			const goalProjectCtx = projectContextManager.getContextForGoal(g.id);
			const teamEntry = goalProjectCtx?.teamStore.get(g.id);
			const agentBranches: string[] = [];
			if (teamEntry?.agents) {
				for (const a of teamEntry.agents) {
					if (a.branch) agentBranches.push(a.branch);
				}
			}
			if (teamEntry?.teamLeadSessionId) {
				const tl = goalProjectCtx?.sessionStore.get(teamEntry.teamLeadSessionId);
				if (tl?.branch) agentBranches.push(tl.branch);
			}
			if (teamManager.getTeamState(g.id)) {
				await teamManager.teardownTeam(g.id);
			}
			// Finding 2 — terminal event: release any per-root scheduler permit
			// this child held (or drop it from the capacity queue) so the next
			// capacity-blocked sibling can start. Best-effort + idempotent.
			if (g.parentGoalId) {
				try { verificationHarness.notifyChildTerminal(g.id); } catch (err) {
					console.warn(`[api] archive: notifyChildTerminal failed for ${g.id} (non-fatal):`, err);
				}
			}
			const gm = getGoalManagerForGoal(g.id);
			await gm.archiveGoal(g.id);
			prStatusStore.remove(g.id);
			const archivedGoal = gm.getGoal(g.id);
			if (archivedGoal?.repoPath) {
				deleteRemoteGoalBranches(archivedGoal, agentBranches, archivedGoal.repoPath, commandRunner!, serverRemoteGitPolicy).catch(err => {
					console.warn(`[api] archive: remote branch cleanup failed for ${g.id}:`, err);
				});
			}
			return true;
		};

		if (!cascade) {
			await archiveOne(rootGoal);
			json({ ok: true, archived: 1 });
			return;
		}

		const ctx = projectContextManager.getContextForGoal(id);
		const allGoals = ctx?.goalStore.getAll() ?? [];
		const result = await cascadeGoalSubtree(
			id,
			allGoals,
			{ includeRoot: true, includeArchived: true },
			{ order: "bottom-up", apply: archiveOne },
		);
		const archivedCount = result.processed.filter(p => p.result === true).length;
		if (result.errors.length > 0) {
			for (const e of result.errors) {
				console.error(`[api] archive cascade: ${e.goalId} failed:`, e.error);
			}
		}
		json({
			ok: true,
			archived: archivedCount,
			...(result.errors.length > 0
				? { errors: result.errors.map(e => ({ goalId: e.goalId, error: e.error.message })) }
				: {}),
		});
	};

	// DELETE /api/goals/:parentId/archive-child/:childId — parent-scoped
	// archive. Enforces parent-child relationship server-side so a
	// compromised/buggy team-lead cannot archive arbitrary goals by
	// supplying their id to the general DELETE /api/goals/:id route.
	// Pinned by tests/e2e/parent-scoped-archive-child.spec.ts.
	const archiveChildMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/archive-child\/([^/]+)$/);
	if (archiveChildMatch && req.method === "DELETE") {
		const parentId = archiveChildMatch[1];
		const childId = archiveChildMatch[2];
		// Subgoals feature gate — archive-child is a Children mutation.
		if (!requireSubgoalsEnabled()) return;
		// S1: archive-child is an OPERATOR Children verb (the web UI drives it),
		// so a verified human cookie is accepted; otherwise an agent caller must
		// present a spawning-session header matching the parent goal's
		// authoritative team-lead. See children-mutation-authz.ts.
		{
			const h = req.headers as Record<string, string | string[] | undefined>;
			const readHeader = (n: string): string | undefined => {
				const v = h[n.toLowerCase()];
				const s = Array.isArray(v) ? v[0] : v;
				return typeof s === "string" && s.trim() ? s.trim() : undefined;
			};
			const authz = authorizeChildrenMutation({
				mutationClass: "operator",
				isHumanOperator: cookieTryAuth(req, cookieStore!),
				// S1: derive the AUTHENTIC caller from the per-session secret,
				// never the forgeable public spawning-session header.
				authenticCallerSessionId: sessionManager.sessionSecretStore.resolveSessionIdBySecret(
					readHeader("x-bobbit-session-secret"),
				),
				teamLeadSessionId: teamManager.getTeamState(parentId)?.teamLeadSessionId,
			});
			if (!authz.ok) {
				json({
					error: "Caller session is not the team-lead for this goal",
					code: "NOT_TEAM_LEAD",
					goalId: parentId,
				}, 403);
				return;
			}
		}
		const parent = getGoalAcrossProjects(parentId);
		if (!parent) { json({ error: "Parent goal not found" }, 404); return; }
		const child = getGoalAcrossProjects(childId);
		if (!child) { json({ error: "Child goal not found" }, 404); return; }
		// Security: target must be a DIRECT child of the parent. Reject
		// non-children (siblings, roots, descendants beyond depth 1, or
		// goals from other project contexts) with 403 before touching state.
		if (child.parentGoalId !== parentId) {
			json({
				error: `Goal ${childId} is not a direct child of ${parentId} (parentGoalId=${child.parentGoalId ?? "null"}).`,
				code: "NOT_DIRECT_CHILD",
			}, 403);
			return;
		}
		// Cross-project guard — child must live in the same project context
		// as the parent. getGoalAcrossProjects can resolve both even when
		// they belong to different projects, so check explicitly.
		const parentCtx = projectContextManager.getContextForGoal(parentId);
		const childCtx = projectContextManager.getContextForGoal(childId);
		if (!parentCtx || !childCtx || parentCtx !== childCtx) {
			json({
				error: `Parent ${parentId} and child ${childId} are not in the same project context.`,
				code: "PROJECT_MISMATCH",
			}, 403);
			return;
		}
		await archiveGoalEndpoint(childId);
		return;
	}

	// Routes with goal :id parameter
	const goalMatch = url.pathname.match(/^\/api\/goals\/([^/]+)$/);
	if (goalMatch) {
		const id = goalMatch[1];

		if (req.method === "GET") {
			const goal = getGoalAcrossProjects(id);
			if (!goal) { json({ error: "Goal not found" }, 404); return; }
			json(goal);
			return;
		}

		if (req.method === "PUT") {
			const putGoal = getGoalAcrossProjects(id);
			if (putGoal?.archived) { json({ error: "Goal is archived" }, 409); return; }
			const body = await readBody(req);
			if (!body) { json({ error: "Missing body" }, 400); return; }
			const prevSpec = putGoal?.spec ?? "";
			// The goal id already fixes the project scope; a caller-supplied cwd
			// update must still be constrained to that scope (Headquarters dir for
			// HQ goals, or the normal project root / an owned worktree for normal
			// goals). Reuse the ownership-aware validator used for session/team
			// creation rather than forwarding body.cwd unchecked.
			if (typeof body.cwd === "string" && body.cwd.trim().length > 0) {
				const goalProjectId = putGoal?.projectId
					?? projectContextManager.getContextForGoal(id)?.project.id;
				if (goalProjectId) {
					const cwdValidation = validateExecutionCwd(projectRegistry, projectContextManager, goalProjectId, body.cwd, { kind: "goal", goalId: id });
					if (!cwdValidation.ok) { writeCwdValidationError(cwdValidation); return; }
				}
			}
			const goalMgr = getGoalManagerForGoal(id);
			const ok = await goalMgr.updateGoal(id, {
				title: body.title,
				cwd: body.cwd,
				state: body.state,
				spec: body.spec,
				team: true, // Always-on team mode
				repoPath: body.repoPath,
				branch: body.branch,
				reattemptOf: body.reattemptOf,
			});
			if (!ok) { json({ error: "Goal not found" }, 404); return; }
			// Spec-edit notification: emit goal_spec_changed WS event and nudge the team lead.
			if (typeof body.spec === "string" && body.spec !== prevSpec) {
				const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
				broadcastToAll({
					type: "goal_spec_changed",
					goalId: id,
					prevSpecHash: hash(prevSpec),
					newSpecHash: hash(body.spec),
					prevLen: prevSpec.length,
					newLen: (body.spec as string).length,
					ts: Date.now(),
				});
				try { teamManager.notifyTeamLeadOfSpecChange(id, prevSpec.length, (body.spec as string).length); }
				catch (err) { console.error(`[api] notifyTeamLeadOfSpecChange failed for ${id}:`, err); }
			}
			json({ ok: true });
			return;
		}

		if (req.method === "DELETE") {
			await archiveGoalEndpoint(id);
			return;
		}
	}

	// ── Role endpoints ─────────────────────────────────────────────

	const toolDiagnosticsForProject = (projectId?: string): Array<Record<string, unknown>> => {
		const diagnostics: Array<Record<string, unknown>> = [];
		const seen = new Set<string>();
		const add = (rows: Array<Record<string, unknown>> | undefined): void => {
			for (const row of rows ?? []) {
				const key = `${row.toolName ?? row.tool ?? ""}\0${row.extensionPath ?? row.path ?? ""}\0${row.message ?? ""}`;
				if (seen.has(key)) continue;
				seen.add(key);
				diagnostics.push(row);
			}
		};
		if (toolManager) add(toolManager.getToolDiagnostics() as unknown as Array<Record<string, unknown>>);
		if (projectId) add(projectContextManager.getOrCreate(projectId)?.toolManager.getToolDiagnostics() as unknown as Array<Record<string, unknown>> | undefined);
		return diagnostics;
	};
	const attachToolDiagnostics = (tools: Array<Record<string, unknown>>, diagnostics: Array<Record<string, unknown>>): void => {
		if (diagnostics.length === 0) return;
		for (const tool of tools) {
			const name = typeof tool.name === "string" ? tool.name : undefined;
			if (!name) continue;
			const related = diagnostics.filter((diagnostic) => diagnostic.toolName === name || diagnostic.tool === name || diagnostic.name === name);
			if (related.length > 0) tool.diagnostics = related;
		}
	};

	// GET /api/tools — list available agent tools (with cascade origin)
	if (url.pathname === "/api/tools" && req.method === "GET") {
		// Require an explicit projectId. First-party UI/test helpers pass
		// `headquarters` for the server scope; normalize it before any downstream
		// config/toolManager/marketplace lookup so the synthetic HQ id never leaks
		// into project-context calls.
		const projectScope = resolveRequiredConfigProjectScope(url.searchParams.get("projectId"));
		if (!projectScope.ok) { writeConfigProjectScopeError(projectScope); return; }
		const effectiveConfigProjectId = projectScope.effectiveProjectId;
		const resolved = configCascade.resolveTools(effectiveConfigProjectId);
		// pack-schema-v1: expose each market-pack tool's STRUCTURAL packId (the
		// `market-packs/<name>` dir segment via the same `resolvePackIdentityForTool`
		// the renderer/action endpoints + /api/ext/contributions use) so a tool
		// renderer's `host.ui.openPanel({panelId})` resolves the panel WITHIN its own
		// pack (panel ids are pack-local) via /api/ext/packs/:packId/panels/:panelId.
		// Empty/absent for builtins. Tool-scoped origin identity only — NOT a
		// pack-scoped contribution field.
		const toolPackTm = resolveActionToolManager(
			toolManager,
			projectScope.context?.toolManager,
		);
		const tools: Array<Record<string, unknown>> = resolved.map(r => {
			const out = withOrigin(r as any);
			if (r.originPackId && toolPackTm) {
				const packId = resolvePackIdentityForTool(toolPackTm, r.item.name).packId;
				if (packId) out.packId = packId;
			}
			return out;
		});
		// Include MCP/external tools not covered by the config cascade
		if (toolManager) {
			const resolvedNames = new Set(resolved.map(r => r.item.name));
			for (const t of toolManager.getAvailableTools(piExtensionToolScopeContext({ projectId: effectiveConfigProjectId }))) {
				if (!resolvedNames.has(t.name)) {
					tools.push({ ...t, origin: t.origin ?? "mcp" });
				}
			}
		}
		appendPiExtensionToolRows(tools, buildPiExtensionToolRows(sessionManager.resolveMarketplacePiExtensionContributions(effectiveConfigProjectId)));
		const toolDiagnostics = toolDiagnosticsForProject(effectiveConfigProjectId);
		attachToolDiagnostics(tools, toolDiagnostics);
		json({ tools, diagnostics: toolDiagnostics, toolDiagnostics });
		return;
	}

	// Routes with tool :name parameter
	const toolMatch = url.pathname.match(/^\/api\/tools\/([^/]+)$/);
	if (toolMatch) {
		const name = decodeURIComponent(toolMatch[1]);

		if (req.method === "GET") {
			// Resolve via the selected project's toolManager so project-scope
			// market-pack tools are visible. Headquarters normalizes to the
			// server/global scope; missing or unknown projectId never falls back.
			const projectScope = resolveRequiredConfigProjectScope(url.searchParams.get("projectId"));
			if (!projectScope.ok) { writeConfigProjectScopeError(projectScope); return; }
			const effectiveConfigProjectId = projectScope.effectiveProjectId;
			const tm = resolveActionToolManager(toolManager, projectScope.context?.toolManager);
			const fallbackTm = fallbackToolManagerForConfig(projectScope.context?.configDir ?? bobbitConfigDir());
			const piRows = buildPiExtensionToolRows(sessionManager.resolveMarketplacePiExtensionContributions(effectiveConfigProjectId));
			const piTool = piRows.find((row) => row.name === name);
			const tool = tm.getToolByName(name) ?? fallbackTm?.getToolByName(name);
			if (!tool && !piTool) { json({ error: "Tool not found" }, 404); return; }
			// Merge in cascade origin metadata so the detail payload carries the same
			// origin/originPackId/originPackName the LIST endpoint emits (finding #1).
			// Without this, the tools edit page replaces the cascade list item with the
			// raw detail and a market-pack tool loses its origin badge + read-only state.
			const cascadeEntry = configCascade.resolveTools(effectiveConfigProjectId).find(r => r.item.name === name);
			const toolDiagnostics = toolDiagnosticsForProject(effectiveConfigProjectId);
			if (cascadeEntry && tool) {
				const withMeta = withOrigin(cascadeEntry as any);
				// pack-schema-v1: mirror the LIST endpoint's structural packId so the
				// tools edit page keeps the same own-pack identity for a market-pack tool.
				const packId = cascadeEntry.originPackId ? resolvePackIdentityForTool(tm, name).packId : "";
				const detail: Record<string, unknown> = { ...tool, origin: withMeta.origin, ...(withMeta.overrides ? { overrides: withMeta.overrides } : {}), originPackId: withMeta.originPackId, originPackName: withMeta.originPackName, ...(packId ? { packId } : {}) };
				if (piTool) appendPiExtensionToolRows([detail], [piTool]);
				attachToolDiagnostics([detail], toolDiagnostics);
				json(detail);
			} else if (tool) {
				const detail: Record<string, unknown> = { ...tool };
				if (piTool) appendPiExtensionToolRows([detail], [piTool]);
				attachToolDiagnostics([detail], toolDiagnostics);
				json(detail);
			} else {
				const detail: Record<string, unknown> = { ...(piTool as Record<string, unknown>) };
				attachToolDiagnostics([detail], toolDiagnostics);
				json(detail);
			}
			return;
		}

		if (req.method === "PUT") {
			const body = await readBody(req);
			if (!body) { json({ error: "Missing body" }, 400); return; }
			const projectScope = resolveRequiredConfigProjectScope(body.projectId ?? url.searchParams.get("projectId"));
			if (!projectScope.ok) { writeConfigProjectScopeError(projectScope); return; }
			const targetToolManager = projectScope.context?.toolManager ?? toolManager;
			const targetConfigDir = projectScope.context?.configDir ?? bobbitConfigDir();
			const updates = {
				description: body.description,
				group: body.group,
				docs: body.docs,
				detail_docs: body.detail_docs,
				grantPolicy: body.grantPolicy,
			};
			const ok = targetToolManager.updateToolMetadata(name, updates)
				|| (fallbackToolManagerForConfig(targetConfigDir)?.updateToolMetadata(name, updates) ?? false);
			if (!ok) { json({ error: "Tool not found" }, 404); return; }
			json({ ok: true });
			return;
		}
	}

	function runtimeBuiltinToolsDir(): string {
		const moduleDefaults = path.join(path.dirname(fileURLToPath(import.meta.url)), "defaults", "tools");
		if (fs.existsSync(moduleDefaults)) return moduleDefaults;
		return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "defaults", "tools");
	}

	function fallbackToolManagerForConfig(configDirForScope: string): ToolManager | null {
		const builtinToolsDir = runtimeBuiltinToolsDir();
		if (!fs.existsSync(builtinToolsDir)) return null;
		return new ToolManager(configDirForScope, builtinToolsDir);
	}

	// Shared helper: find which group subdirectory contains a tool by scanning YAML files.
	function findToolGroupDir(toolName: string, toolsDir: string): string | null {
		try {
			const entries = fs.readdirSync(toolsDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const groupPath = path.join(toolsDir, entry.name);
				try {
					const files = fs.readdirSync(groupPath);
					for (const file of files) {
						if (!file.endsWith(".yaml")) continue;
						try {
							const raw = fs.readFileSync(path.join(groupPath, file), "utf-8");
							// Quick check without full YAML parse
							if (raw.includes(`name: ${toolName}`) || raw.includes(`name: "${toolName}"`)) {
								// Verify with proper field check
								const lines = raw.split("\n");
								for (const line of lines) {
									const m = line.match(/^name:\s*"?([^"\n]+)"?\s*$/);
									if (m && m[1].trim() === toolName) return entry.name;
								}
							}
						} catch { /* skip unreadable */ }
					}
				} catch { /* skip */ }
			}
		} catch { /* dir doesn't exist */ }
		return null;
	}

	// GET /api/tools/:tool/renderer — serve a PACK tool's pre-built ESM renderer
	// module bytes (design docs/design/extension-host.md §4a). Admin-bearer ONLY
	// (enforced before handleApiRoute): serving the module bytes is a static-asset-
	// equivalent, NOT a capability invocation, so there is deliberately NO
	// allowedTools check here (that gate is on the ACTION endpoint below). The
	// renderer file path is re-validated to stay within the tool's group dir.
	const rendererMatch = url.pathname.match(/^\/api\/tools\/([^/]+)\/renderer$/);
	if (rendererMatch && req.method === "GET") {
		const tool = decodeURIComponent(rendererMatch[1]);
		// Require the same explicit config project scope as GET /api/tools. Headquarters
		// aliases the server/global layer; unknown normal projects fail before any
		// server-scope fallback can leak a different pack renderer.
		const rendererScope = resolveRequiredConfigProjectScope(url.searchParams.get("projectId"));
		if (!rendererScope.ok) { writeConfigProjectScopeError(rendererScope); return; }
		const rendererTm = resolveActionToolManager(
			toolManager,
			rendererScope.context?.toolManager,
		);
		// Resolve the WINNING tool's on-disk location independent of `provider:`
		// (design §4b — a pack renderer needs no provider). resolveToolLocation
		// honors the same pack precedence as every other tool resolution.
		const loc = rendererTm.resolveToolLocation(tool);
		if (!loc || loc.rendererKind !== "pack" || !loc.rendererFile || !loc.baseDir) {
			json({ error: "no pack renderer for this tool" }, 404);
			return;
		}
		// The renderer resolves RELATIVE to the tool YAML's dir, but containment is
		// against the PACK ROOT (pack-schema-v1 §6.2), so `renderer: ../../lib/X.js`
		// serves while an out-of-pack path is rejected.
		const groupAbs = path.join(loc.baseDir, loc.groupDir || "");
		const packRoot = path.dirname(loc.baseDir);
		const fileAbs = path.resolve(groupAbs, loc.rendererFile);
		if (!isPackPathWithinRoot(packRoot, fileAbs)) {
			json({ error: "invalid renderer path" }, 404);
			return;
		}
		let source: string;
		try {
			source = fs.readFileSync(fileAbs, "utf-8");
		} catch {
			json({ error: "renderer module not found" }, 404);
			return;
		}
		res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-cache" });
		res.end(source);
		return;
	}

	// GET /api/ext/packs/:packId/panels/:panelId?projectId= — serve a PACK's
	// pre-built ESM side-panel module bytes (pack-schema-v1 §6.3). Panels are
	// pack-addressed (panel ids are only pack-unique), NOT tool-keyed. Admin-bearer
	// ONLY / static-asset-equivalent — NO allowedTools check (serving bytes is not a
	// capability invocation, same as the renderer endpoint). The panel `entry`
	// resolves relative to its declaring panels/<file>.yaml and is re-validated to
	// stay within the pack root.
	const extPanelMatch = url.pathname.match(/^\/api\/ext\/packs\/([^/]+)\/panels\/([^/]+)$/);
	if (extPanelMatch && req.method === "GET") {
		const packId = decodeURIComponent(extPanelMatch[1]);
		const panelId = decodeURIComponent(extPanelMatch[2]);
		const panelScope = resolveRequiredConfigProjectScope(url.searchParams.get("projectId"));
		if (!panelScope.ok) { writeConfigProjectScopeError(panelScope); return; }
		const panel = packContributionRegistry.getPanel(panelScope.effectiveProjectId, packId, panelId);
		if (!panel) {
			json({ error: "no such panel in this pack" }, 404);
			return;
		}
		const fileAbs = path.resolve(path.dirname(panel.sourceFile), panel.entry);
		if (!isPackPathWithinRoot(panel.packRoot, fileAbs)) {
			json({ error: "invalid panel path" }, 404);
			return;
		}
		let source: string;
		try {
			source = fs.readFileSync(fileAbs, "utf-8");
		} catch {
			json({ error: "panel module not found" }, 404);
			return;
		}
		res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-cache" });
		res.end(source);
		return;
	}

	// GET /api/ext/contributions?projectId= — project-scoped pack-contribution
	// metadata for the client registries (pack-schema-v1 §6.4). Activation filtering
	// is already applied by the registry (disabled entrypoints omitted). EVERY
	// installed + active pack emits a row (empty arrays allowed) — the frozen
	// always-emit contract so the client reconcile is deterministic.
	if (url.pathname === "/api/ext/contributions" && req.method === "GET") {
		const contribScope = resolveRequiredConfigProjectScope(url.searchParams.get("projectId"));
		if (!contribScope.ok) { writeConfigProjectScopeError(contribScope); return; }
		const packs = packContributionRegistry.list(contribScope.effectiveProjectId).map((p) => ({
			packId: p.packId,
			packName: p.packName,
			panels: p.panels.map((panel) => {
				const out: Record<string, unknown> = { id: panel.id };
				if (panel.title !== undefined) out.title = panel.title;
				if (panel.instanceMode !== undefined) out.instanceMode = panel.instanceMode;
				if (panel.instanceParam !== undefined) out.instanceParam = panel.instanceParam;
				return out;
			}),
			entrypoints: p.entrypoints.map((e) => {
				const out: Record<string, unknown> = { id: e.id, kind: e.kind, listName: e.listName };
				if (e.label !== undefined) out.label = e.label;
				if (e.icon !== undefined) out.icon = e.icon;
				if (e.routeId !== undefined) out.routeId = e.routeId;
				if (e.target !== undefined) out.target = e.target;
				if (e.paramKeys !== undefined) out.paramKeys = e.paramKeys;
				return out;
			}),
			routeNames: p.routes?.names ?? [],
		}));
		json({ packs });
		return;
	}

	// Fix B: there is NO server-side own-session message poster — driving the agent
	// is a client-only, user-activation + session-secret gated capability. A server
	// route/action handler has no user gesture, so the server Host API exposes no
	// `session.postMessage` (see server-host-api.ts).

	// POST /api/tools/:tool/actions/:action — invoke a pack tool's server action
	// handler (design §4b / §5). The LLM can curl this directly, so the
	// allowedTools guard here — NOT the agent layer — is the real gate (§5 i).
	const actionMatch = url.pathname.match(/^\/api\/tools\/([^/]+)\/actions\/([^/]+)$/);
	if (actionMatch && req.method === "POST") {
		const tool = decodeURIComponent(actionMatch[1]);
		const action = decodeURIComponent(actionMatch[2]);
		const body = (await readBody(req)) ?? {};
		const headerSessionId = req.headers["x-bobbit-session-id"] as string | string[] | undefined;
		// Resolve the tool through the SESSION's project-scoped tool manager (design
		// §4b): the project is derived from the session, NOT from the client, so a
		// project-scope pack (or a project pack shadowing a global tool) dispatches
		// the SAME winner the session's tool resolution sees — no split-brain. The
		// header session id is the canonical identity (the guard rejects a body/header
		// mismatch or unknown session); resolving from it before the guard is safe
		// because an invalid session falls back to the server-level manager and the
		// guard then rejects the request anyway.
		const actionHeaderSid = Array.isArray(headerSessionId) ? headerSessionId[0] : headerSessionId;
		const actionSessionProjectId = actionHeaderSid
			? (sessionManager.getSession(actionHeaderSid)?.projectId
				?? sessionManager.getPersistedSession(actionHeaderSid)?.projectId)
			: undefined;
		const sessionToolManager = resolveActionToolManager(
			toolManager,
			actionSessionProjectId ? projectContextManager.getOrCreate(actionSessionProjectId)?.toolManager : undefined,
		);
		const info = sessionToolManager.getToolByName(tool);

		// Resolve a session's allowlist (live preferred, else persisted).
		const resolveSession = (id: string): ActionGuardSession | undefined => {
			const live = sessionManager.getSession(id);
			if (live) return { allowedTools: live.allowedTools };
			const persisted = sessionManager.getPersistedSession(id);
			if (persisted) return { allowedTools: persisted.allowedTools };
			return undefined;
		};
		// Verify the toolUseId exists in the HEADER-BOUND session's transcript and
		// was a call of :tool (anti-replay/forgery; §5 iii / iii-b).
		const verifyToolUse = async (sid: string, toolUseId: string, t: string): Promise<boolean> => {
			const ps = sessionManager.getPersistedSession(sid);
			if (!ps?.agentSessionFile) return false;
			const fsCtx = sessionFsContextForAgentFile(ps, ps.agentSessionFile);
			const content = await sessionFileRead(fsCtx, ps.agentSessionFile, sandboxManager);
			return transcriptHasToolUse(content, toolUseId, t);
		};

		const guard = await authorizeActionRequest({
			tool,
			action,
			headerSessionId,
			bodySessionId: (body as { sessionId?: unknown }).sessionId,
			toolUseId: (body as { toolUseId?: unknown }).toolUseId,
			resolveSession,
			actionNames: info?.actionNames,
			verifyToolUse,
		});
		if (!guard.ok) {
			json({ error: guard.error }, guard.status);
			return;
		}
		// The tool must actually declare an actions module (checked after authz so
		// an unauthorized caller never learns whether the tool has actions).
		if (!info?.hasActions) {
			json({ error: `tool "${tool}" has no actions` }, 404);
			return;
		}

		const toolUseId = (body as { toolUseId: string }).toolUseId;
		const args = (body as { args?: unknown }).args;
		// The durable v1 Host API has NO gateway.fetch / raw passthrough: the action
		// endpoint is same-origin and built here, so there is no caller-supplied URL
		// or Authorization header to sanitize. `ctx.host` carries only the bound
		// identity (+ frozen Phase-2 stubs).
		// Slice A: derive the pack identity SERVER-SIDE from the SAME session-project
		// resolver the dispatcher loads the winning module from (no split-brain). The
		// client never sends a packId — it names only a tool, and the server maps
		// tool → winning pack (design extension-host-phase2.md §2.2).
		const ident = resolvePackIdentityForTool(sessionToolManager, tool);
		// Slice B2: own-session transcript reader for ctx.host.session.read*. Reads the
		// HEADER-BOUND session only (single-sourced identity) via the same own-session
		// read the transcript endpoint uses.
		const readOwnTranscript = async (): Promise<string | null> => {
			const ps = sessionManager.getPersistedSession(guard.sessionId);
			if (!ps?.agentSessionFile) return null;
			const fsCtx = sessionFsContextForAgentFile(ps, ps.agentSessionFile);
			return sessionFileRead(fsCtx, ps.agentSessionFile, sandboxManager);
		};
		const host = createServerHostApi({
			sessionId: guard.sessionId,
			toolUseId,
			packId: ident.packId,
			contributionId: ident.contributionId,
			packStore: getPackStore(),
			readOwnTranscript,
			// Sub-goal A seam — sub-goal C consumes this to back `host.agents`.
			orchestrationCore,
			// Sub-goal C: live status reader for host.agents.status/list (the core has
			// no public status accessor).
			readChildStatus: (id: string) => sessionManager.getSession(id)?.status,
			// Drop activation caches when an action persists provider config (host-owned).
			onStoreWrite: notePackStoreWrite,
		});
		// The session working dir the confined worker uses as its process.cwd() (tool
		// parity — prefer the worktree path; fall back to the recorded cwd).
		const actionPs = sessionManager.getPersistedSession(guard.sessionId);
		const actionWorkingDir = actionPs?.worktreePath ?? actionPs?.cwd;
		const start = Date.now();
		try {
			const result = await dispatcher.dispatch(tool, action, { host, sessionId: guard.sessionId, toolUseId, tool, workingDir: actionWorkingDir }, args, sessionToolManager);
			console.log(`[ext-action] tool=${tool} action=${action} session=${guard.sessionId} toolUseId=${toolUseId} caller=${guard.sessionId} outcome=ok durationMs=${Date.now() - start}`);
			json(result ?? null);
		} catch (err) {
			const status = err instanceof ActionError ? err.status : 500;
			const message = err instanceof Error ? err.message : String(err);
			console.warn(`[ext-action] tool=${tool} action=${action} session=${guard.sessionId} toolUseId=${toolUseId} caller=${guard.sessionId} outcome=error(${status}) durationMs=${Date.now() - start}: ${message}`);
			json({ error: message }, status);
		}
		return;
	}

	// POST /api/ext/surface-token — mint a SERVER-MINTED surface binding token for a
	// pack surface (renderer / panel / entrypoint), called by the TRUSTED app loader
	// the first time it constructs that surface's Host API (design extension-host-
	// phase2.md §2.3 + §10). Authorize via authorizeScopedRequest (header-canonical
	// session, body===header, session resolves, `tool` ∈ allowedTools), SERVER-derive
	// the winning {packId, contributionId} from `tool`, reject a non-pack caller, and
	// mint a token BOUND to {sessionId, packId, contributionId, tool}. The client holds
	// the opaque token in the Host API closure and echoes it on every scoped call; the
	// scoped endpoints DERIVE {packId, tool} from the validated token and ignore any
	// caller-supplied tool/pack — closing the cross-pack identity hole the bare `tool`
	// field left open. (A same-realm malicious pack can still mint its own token for an
	// arbitrary tool name — the documented Model-A residual, marketplace.md threat model.)
	if (url.pathname === "/api/ext/surface-token" && req.method === "POST") {
		const body = (await readBody(req)) ?? {};
		const headerSessionId = req.headers["x-bobbit-session-id"] as string | string[] | undefined;
		const mintHeaderSid = Array.isArray(headerSessionId) ? headerSessionId[0] : headerSessionId;
		const mintSessionProjectId = mintHeaderSid
			? (sessionManager.getSession(mintHeaderSid)?.projectId
				?? sessionManager.getPersistedSession(mintHeaderSid)?.projectId)
			: undefined;
		const resolveSession = (id: string): ActionGuardSession | undefined => {
			const live = sessionManager.getSession(id);
			if (live) return { allowedTools: live.allowedTools };
			const persisted = sessionManager.getPersistedSession(id);
			if (persisted) return { allowedTools: persisted.allowedTools };
			return undefined;
		};
		const contributionKind = (body as { contributionKind?: unknown }).contributionKind;

		// ── Pack-bound surfaces (panel / entrypoint / route) are deliberately NOT
		// minted from this public REST body: a same-session caller could choose another
		// active pack's id. The trusted app mints these over the session WebSocket it
		// owns; pack code receives only the resulting HostApi closure.
		if (typeof contributionKind === "string") {
			if (contributionKind !== "panel" && contributionKind !== "entrypoint" && contributionKind !== "route") {
				json({ error: "invalid contributionKind" }, 400);
				return;
			}
			json({ error: "pack-bound surface tokens must be minted over the trusted session WebSocket" }, 403);
			return;
		}

		// ── Tool-bound surface (renderer / action) — UNCHANGED. ──
		const tool = typeof (body as { tool?: unknown }).tool === "string" ? (body as { tool: string }).tool : "";
		const mintToolManager = resolveActionToolManager(
			toolManager,
			mintSessionProjectId ? projectContextManager.getOrCreate(mintSessionProjectId)?.toolManager : undefined,
		);
		const guard = authorizeScopedRequest({
			tool,
			headerSessionId,
			bodySessionId: (body as { sessionId?: unknown }).sessionId,
			resolveSession,
		});
		if (!guard.ok) {
			json({ error: guard.error }, guard.status);
			return;
		}
		const ident = resolvePackIdentityForTool(mintToolManager, tool);
		if (!ident.isPack || !ident.packId) {
			json({ error: "surface tokens are available only to market-pack tools" }, 403);
			return;
		}
		const token = mintSurfaceToken({ sessionId: guard.sessionId, packId: ident.packId, contributionId: ident.contributionId, tool });
		console.log(`[ext-surface-token] tool=${tool} packId=${ident.packId} session=${guard.sessionId} outcome=ok`);
		json({ token });
		return;
	}

	// POST /api/ext/channel-open-permit — mint the one-shot permit required by
	// `ext_channel_open`. This scoped path accepts only pack-bound surface tokens
	// (panel / entrypoint / route); channel name is resolved inside that pack only.
	if (url.pathname === "/api/ext/channel-open-permit" && req.method === "POST") {
		if (!extensionChannelServices?.openPermits) {
			json({ error: "extension channels are not available" }, 503);
			return;
		}
		const body = (await readBody(req)) ?? {};
		const headerSessionId = req.headers["x-bobbit-session-id"] as string | string[] | undefined;
		const channelHeaderSid = Array.isArray(headerSessionId) ? headerSessionId[0] : headerSessionId;
		const channelSessionProjectId = channelHeaderSid
			? (sessionManager.getSession(channelHeaderSid)?.projectId
				?? sessionManager.getPersistedSession(channelHeaderSid)?.projectId)
			: undefined;
		const resolveSession = (id: string): ActionGuardSession | undefined => {
			const live = sessionManager.getSession(id);
			if (live) return { allowedTools: live.allowedTools };
			const persisted = sessionManager.getPersistedSession(id);
			if (persisted) return { allowedTools: persisted.allowedTools };
			return undefined;
		};
		const channelToolManager = resolveActionToolManager(
			toolManager,
			channelSessionProjectId ? projectContextManager.getOrCreate(channelSessionProjectId)?.toolManager : undefined,
		);
		const result = await mintScopedExtensionChannelOpenPermit({
			openPermits: extensionChannelServices.openPermits,
			packContributionRegistry,
			projectId: channelSessionProjectId,
			resolver: channelToolManager,
			headerSessionId: channelHeaderSid,
			rawHeaderSessionId: headerSessionId,
			bodySessionId: (body as { sessionId?: unknown }).sessionId,
			surfaceToken: (body as { surfaceToken?: unknown }).surfaceToken,
			name: (body as { name?: unknown }).name,
			init: (body as { init?: unknown }).init,
			singletonKey: (body as { singletonKey?: unknown }).singletonKey,
			resolveSession,
		});
		if (!result.ok) {
			console.warn(`[ext-channel-grant] outcome=error: ${result.error}`);
			json({ error: result.error }, result.status);
			return;
		}
		console.log(`[ext-channel-grant] channel=${result.channelName} packId=${result.packId} session=${result.sessionId} outcome=ok`);
		json({ openGrant: result.openGrant });
		return;
	}

	// POST /api/ext/store/:op — pack-namespaced KV persistence behind `host.store.*`
	// (design extension-host-phase2.md §3 B1.2). Pack-scoped (NOT tool-call-scoped):
	// the caller proves identity via a SERVER-MINTED surface token (NOT a caller-
	// supplied `tool` — closing the cross-pack identity hole); the server DERIVES
	// {packId, tool} from the validated token, then layers the per-session guard
	// (header-canonical session, body===header, session resolves, derived tool ∈
	// allowedTools — NO toolUseId-ownership, so a panel/entrypoint with no owned
	// toolUseId can persist). Keys are namespaced by the derived packId.
	const storeMatch = url.pathname.match(/^\/api\/ext\/store\/([^/]+)$/);
	if (storeMatch && req.method === "POST") {
		const op = decodeURIComponent(storeMatch[1]);
		if (op !== "get" && op !== "put" && op !== "list" && op !== "delete" && op !== "deletePrefix" && op !== "stats") {
			json({ error: `Unknown store op "${op}"`, code: "STORE_OP_UNKNOWN" }, 404);
			return;
		}
		const body = (await readBody(req)) ?? {};
		const headerSessionId = req.headers["x-bobbit-session-id"] as string | string[] | undefined;
		const storeHeaderSid = Array.isArray(headerSessionId) ? headerSessionId[0] : headerSessionId;
		// Resolve the tool through the SESSION's project-scoped tool manager (same
		// no-split-brain resolution the action endpoint uses).
		const storeSessionProjectId = storeHeaderSid
			? (sessionManager.getSession(storeHeaderSid)?.projectId
				?? sessionManager.getPersistedSession(storeHeaderSid)?.projectId)
			: undefined;
		const storeToolManager = resolveActionToolManager(
			toolManager,
			storeSessionProjectId ? projectContextManager.getOrCreate(storeSessionProjectId)?.toolManager : undefined,
		);
		const resolveSession = (id: string): ActionGuardSession | undefined => {
			const live = sessionManager.getSession(id);
			if (live) return { allowedTools: live.allowedTools };
			const persisted = sessionManager.getPersistedSession(id);
			if (persisted) return { allowedTools: persisted.allowedTools };
			return undefined;
		};
		// 1. DERIVE {packId, tool?} from the SERVER-MINTED surface token — never a
		//    caller-supplied `tool`. Rejects a missing/invalid/wrong-session/stale token.
		//    For a PACK-BOUND token (no tool) the token validation already proved
		//    installed+active+own-session against the pack-contribution registry.
		const surf = resolveSurfaceIdentity({ token: (body as { surfaceToken?: unknown }).surfaceToken, headerSessionId: storeHeaderSid, resolver: storeToolManager, contributions: packContributionRegistry, projectId: storeSessionProjectId });
		if (!surf.ok) {
			json({ error: surf.error }, surf.status);
			return;
		}
		const tool = surf.tool;
		const ident = { packId: surf.packId };
		// 2. Authorize: TOOL-bound tokens layer the allowedTools+session guard;
		//    PACK-bound tokens (no tool) skip allowedTools (new trust boundary §4.5)
		//    and only re-check the body===header session match.
		const guard = tool !== undefined
			? authorizeScopedRequest({ tool, headerSessionId, bodySessionId: (body as { sessionId?: unknown }).sessionId, resolveSession })
			: packBoundScopedGuard(storeHeaderSid, (body as { sessionId?: unknown }).sessionId, resolveSession);
		if (!guard.ok) {
			json({ error: guard.error }, guard.status);
			return;
		}
		const key = (body as { key?: unknown }).key;
		const prefix = (body as { prefix?: unknown }).prefix;
		const start = Date.now();
		try {
			const packStore = getPackStore();
			let result: unknown;
			// Bound each store op by a wall-time (design §3 B1.2): a stuck/slow backend
			// rejects with PackStoreTimeoutError → 504 rather than holding the request
			// open outside the blast-radius control.
			if (op === "get") {
				result = await withStoreTimeout(packStore.get(ident.packId, key as string), undefined, `store ${op}`);
			} else if (op === "put") {
				await withStoreTimeout(packStore.put(ident.packId, key as string, (body as { value?: unknown }).value, (body as { opts?: StorePutOptions }).opts), undefined, `store ${op}`);
				// Host-owned: a direct provider-config write must drop activation caches too.
				notePackStoreWrite(key);
				result = { ok: true };
			} else if (op === "delete") {
				result = await withStoreTimeout(packStore.delete(ident.packId, key as string), undefined, `store ${op}`);
			} else if (op === "deletePrefix") {
				result = await withStoreTimeout(packStore.deletePrefix(ident.packId, prefix as string), undefined, `store ${op}`);
			} else if (op === "stats") {
				result = await withStoreTimeout(packStore.stats(ident.packId, typeof prefix === "string" ? prefix : undefined), undefined, `store ${op}`);
			} else {
				result = await withStoreTimeout(packStore.list(ident.packId, typeof prefix === "string" ? prefix : undefined), undefined, `store ${op}`);
			}
			console.log(`[ext-store] op=${op} tool=${tool} packId=${ident.packId} session=${guard.sessionId} outcome=ok durationMs=${Date.now() - start}`);
			json(result ?? null);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// A timed-out store op is a 5xx (backend unavailable); other errors (quota,
			// bad input) stay 4xx.
			const status = err instanceof PackStoreTimeoutError ? 504 : 400;
			const code = err instanceof PackStoreTimeoutError
				? "STORE_TIMEOUT"
				: err instanceof PackStoreQuotaError ? err.code : "STORE_ERROR";
			const details = err instanceof PackStoreQuotaError ? err.details : undefined;
			console.warn(`[ext-store] op=${op} tool=${tool} packId=${ident.packId} session=${guard.sessionId} outcome=error(${status}) durationMs=${Date.now() - start}: ${message}`);
			json({ error: message, code, ...(details ? { details } : {}) }, status);
		}
		return;
	}

	// GET /api/ext/session/{transcript,tool-call} — Slice B2 pack-scoped, OWN-SESSION
	// transcript reads (design extension-host-phase2.md §4 B2.2). The HEADER-BOUND
	// session is the single canonical identity; there is NO parameter for another
	// session — reads are own-session by construction. `tool` (query) gates on the
	// session's allowedTools through the SAME `authorizeScopedRequest` core the
	// action endpoint uses (no toolUseId required — panels/entrypoints may originate
	// the read). `sessionId` (query) is the body-vs-header fail-fast input.
	const extSessionTranscript = url.pathname === "/api/ext/session/transcript";
	const extSessionToolCall = url.pathname === "/api/ext/session/tool-call";
	if ((extSessionTranscript || extSessionToolCall) && req.method === "GET") {
		const extHeaderSid = req.headers["x-bobbit-session-id"] as string | string[] | undefined;
		const extCanonSid = Array.isArray(extHeaderSid) ? extHeaderSid[0] : extHeaderSid;
		const extResolveSession = (id: string): ActionGuardSession | undefined => {
			const live = sessionManager.getSession(id);
			if (live) return { allowedTools: live.allowedTools };
			const persisted = sessionManager.getPersistedSession(id);
			if (persisted) return { allowedTools: persisted.allowedTools };
			return undefined;
		};
		// Resolve the SESSION's project-scoped tool manager up front (no split-brain),
		// then DERIVE {packId, tool} from the SERVER-MINTED surface token (query param) —
		// never a caller-supplied `tool`. authorizeScopedRequest only gates allowedTools
		// (an UNRESTRICTED session has none), so identity MUST come from the validated
		// token; a missing/invalid/wrong-session/stale token (or non-pack tool) is rejected
		// BEFORE any transcript byte is read — session reads are pack-only + own-session.
		const extSessionProjectId = extCanonSid
			? (sessionManager.getSession(extCanonSid)?.projectId
				?? sessionManager.getPersistedSession(extCanonSid)?.projectId)
			: undefined;
		const extToolManager = resolveActionToolManager(
			toolManager,
			extSessionProjectId ? projectContextManager.getOrCreate(extSessionProjectId)?.toolManager : undefined,
		);
		const surf = resolveSurfaceIdentity({ token: url.searchParams.get("surfaceToken"), headerSessionId: extCanonSid, resolver: extToolManager, contributions: packContributionRegistry, projectId: extSessionProjectId });
		if (!surf.ok) {
			json({ error: surf.error }, surf.status);
			return;
		}
		// TOOL-bound tokens layer the allowedTools+session guard; PACK-bound tokens
		// (no tool) skip allowedTools (§4.5) and only re-check the session match.
		const extGuard = surf.tool !== undefined
			? authorizeScopedRequest({ tool: surf.tool, headerSessionId: extHeaderSid, bodySessionId: url.searchParams.get("sessionId"), resolveSession: extResolveSession })
			: packBoundScopedGuard(extCanonSid, url.searchParams.get("sessionId"), extResolveSession);
		if (!extGuard.ok) {
			json({ error: extGuard.error }, extGuard.status);
			return;
		}
		// Read the HEADER-BOUND session's transcript ONLY (own-session by construction).
		const extPs = sessionManager.getPersistedSession(extGuard.sessionId);
		let extJsonl: string | null = null;
		if (extPs?.agentSessionFile) {
			const fsCtx = sessionFsContextForAgentFile(extPs, extPs.agentSessionFile);
			extJsonl = await sessionFileRead(fsCtx, extPs.agentSessionFile, sandboxManager);
		}
		if (extSessionToolCall) {
			const toolUseId = url.searchParams.get("toolUseId");
			if (!toolUseId) { json({ error: "toolUseId required" }, 400); return; }
			json(transcriptToToolCall(extJsonl, toolUseId));
			return;
		}
		const parseIntQ = (name: string): number | undefined => {
			const raw = url.searchParams.get(name);
			if (raw === null) return undefined;
			const n = Number(raw);
			return Number.isFinite(n) ? n : undefined;
		};
		try {
			const envelope = buildTranscriptEnvelope(transcriptToHostMessages(extJsonl), {
				offset: parseIntQ("offset"),
				limit: parseIntQ("limit"),
				pattern: url.searchParams.get("pattern") ?? undefined,
			});
			json(envelope);
		} catch (err) {
			json({ error: err instanceof Error ? err.message : String(err) }, 400);
		}
		return;
	}

	// POST /api/ext/route/:name — pack-scoped typed route call behind `host.callRoute`
	// (design extension-host-phase2.md §5 B3.2). Pack-scoped (NOT tool-call-scoped):
	// authorize via authorizeScopedRequest (NO toolUseId-ownership — a panel/entrypoint
	// with no owned toolUseId may call routes), then derive the trusted packId SERVER-
	// side from the opener `tool` and resolve the route MODULE via the pack-level
	// RouteRegistry (opener-INDEPENDENT) so a route declared on tool Y is reachable from
	// a surface opened by tool X in the SAME pack. There is NO `<pack>` URL segment to
	// forge — the routed pack is derived from a tool the caller proves it owns.
	const routeMatch = url.pathname.match(/^\/api\/ext\/route\/([^/]+)$/);
	if (routeMatch && req.method === "POST") {
		const routeName = decodeURIComponent(routeMatch[1]);
		const body = (await readBody(req)) ?? {};
		const headerSessionId = req.headers["x-bobbit-session-id"] as string | string[] | undefined;
		const routeHeaderSid = Array.isArray(headerSessionId) ? headerSessionId[0] : headerSessionId;
		const routePs = routeHeaderSid ? sessionManager.getPersistedSession(routeHeaderSid) : undefined;
		// Resolve the tool through the SESSION's project-scoped tool manager (same
		// no-split-brain resolution the action + store endpoints use).
		const routeSessionProjectId = routeHeaderSid
			? (sessionManager.getSession(routeHeaderSid)?.projectId
				?? routePs?.projectId)
			: undefined;
		const routeToolManager = resolveActionToolManager(
			toolManager,
			routeSessionProjectId ? projectContextManager.getOrCreate(routeSessionProjectId)?.toolManager : undefined,
		);
		const resolveSession = (id: string): ActionGuardSession | undefined => {
			const live = sessionManager.getSession(id);
			if (live) return { allowedTools: live.allowedTools };
			const persisted = sessionManager.getPersistedSession(id);
			if (persisted) return { allowedTools: persisted.allowedTools };
			return undefined;
		};
		// 1. DERIVE the trusted {packId, tool} from the SERVER-MINTED surface token —
		//    never a caller-supplied `tool` (closing the cross-pack identity hole). The
		//    derived tool is the OPENER (the surface's contributing tool); the route
		//    MODULE is resolved opener-INDEPENDENTLY below via the pack-level registry.
		const surf = resolveSurfaceIdentity({ token: (body as { surfaceToken?: unknown }).surfaceToken, headerSessionId: routeHeaderSid, resolver: routeToolManager, contributions: packContributionRegistry, projectId: routeSessionProjectId });
		if (!surf.ok) {
			json({ error: surf.error }, surf.status);
			return;
		}
		const routeTool = surf.tool;
		const ident = { packId: surf.packId, contributionId: surf.contributionId };
		// 2. Authorize: TOOL-bound tokens layer the allowedTools+session guard;
		//    PACK-bound tokens (no tool — orphan/UI-only pack) skip allowedTools
		//    (§4.5) and only re-check the session match. NO toolUseId-ownership.
		const guard = routeTool !== undefined
			? authorizeScopedRequest({ tool: routeTool, headerSessionId, bodySessionId: (body as { sessionId?: unknown }).sessionId, resolveSession })
			: packBoundScopedGuard(routeHeaderSid, (body as { sessionId?: unknown }).sessionId, resolveSession);
		if (!guard.ok) {
			json({ error: guard.error }, guard.status);
			return;
		}
		// 4. Resolve the route MODULE via the pack-level registry (off pack-level
		//    routes, opener-independent — pack-schema-v1 §5.3).
		const resolved = routeRegistry.resolve(ident.packId, routeName, routeSessionProjectId);
		if (!resolved) {
			json({ error: `pack "${ident.packId}" declares no route "${routeName}"` }, 404);
			return;
		}
		// 5. Dispatch the registry's DECLARING-tool module with the packId-bound host
		//    context (identity from ident, NOT the opener tool).
		const toolUseId = typeof (body as { toolUseId?: unknown }).toolUseId === "string"
			? (body as { toolUseId: string }).toolUseId
			: undefined;
		const init = ((body as { init?: unknown }).init ?? {}) as { method?: unknown; query?: unknown; body?: unknown };
		const method = typeof init.method === "string" ? init.method : "GET";
		let query: Record<string, string> | undefined;
		if (init.query && typeof init.query === "object") {
			query = {};
			for (const [k, v] of Object.entries(init.query as Record<string, unknown>)) {
				if (v !== undefined && v !== null) query[k] = String(v);
			}
		}
		const readOwnTranscript = async (): Promise<string | null> => {
			const ps = sessionManager.getPersistedSession(guard.sessionId);
			if (!ps?.agentSessionFile) return null;
			const fsCtx = sessionFsContextForAgentFile(ps, ps.agentSessionFile);
			return sessionFileRead(fsCtx, ps.agentSessionFile, sandboxManager);
		};
		const host = createServerHostApi({
			sessionId: guard.sessionId,
			toolUseId,
			packId: ident.packId,
			contributionId: ident.contributionId,
			packStore: getPackStore(),
			readOwnTranscript,
			// Sub-goal A seam — sub-goal C consumes this to back `host.agents`.
			orchestrationCore,
			// Sub-goal C: live status reader for host.agents.status/list (the core has
			// no public status accessor).
			readChildStatus: (id: string) => sessionManager.getSession(id)?.status,
			// Drop activation caches when a route persists provider config (host-owned).
			onStoreWrite: notePackStoreWrite,
		});
		const start = Date.now();
		try {
			// The session working dir the confined worker uses as its process.cwd()
			// (tool parity — prefer the worktree path; fall back to the recorded cwd).
			const routeWorkingDir = routePs?.worktreePath ?? routePs?.cwd;
			const result = await routeDispatcher.dispatch(
				resolved.modulePath,
				resolved.packRoot,
				routeName,
				{ host, sessionId: guard.sessionId, toolUseId: toolUseId ?? "", tool: ident.contributionId, projectId: routeSessionProjectId, workingDir: routeWorkingDir, sessionArchived: routePs?.archived === true },
				{ method, query, body: init.body },
			);
			const durationMs = Date.now() - start;
			// PR Walkthrough status is a browser polling route; keep slow successes and
			// all catch-branch errors visible, but do not flood logs with fast ticks.
			const suppressNoisyOk = ident.packId === "pr-walkthrough" && routeName === "status" && durationMs < 1_000;
			if (!suppressNoisyOk) {
				console.log(`[ext-route] name=${routeName} tool=${routeTool ?? ident.contributionId} packId=${ident.packId} session=${guard.sessionId} outcome=ok durationMs=${durationMs}`);
			}
			json(result ?? null);
		} catch (err) {
			const status = err instanceof ActionError ? err.status : 500;
			const message = err instanceof Error ? err.message : String(err);
			console.warn(`[ext-route] name=${routeName} tool=${routeTool ?? ident.contributionId} packId=${ident.packId} session=${guard.sessionId} outcome=error(${status}) durationMs=${Date.now() - start}: ${message}`);
			json({ error: message }, status);
		}
		return;
	}

	// NOTE: the C2 session WRITE (`host.session.postMessage`) is intentionally NOT an
	// HTTP endpoint. It is driven over the TRUSTED session WebSocket
	// (`ext_session_post` in src/server/ws/handler.ts) so that no capturable session
	// secret ever rides a pack-monkey-patchable `fetch`, and pack code — which has no
	// handle to the WS — cannot send it. A raw same-realm `fetch` to any session
	// endpoint therefore cannot drive the agent. See docs/design/extension-host-phase2.md §8 C2.1.

	// POST /api/tools/:name/customize — copy tool group to a target scope
	const toolCustomizeMatch = url.pathname.match(/^\/api\/tools\/([^/]+)\/customize$/);
	if (toolCustomizeMatch && req.method === "POST") {
		const name = decodeURIComponent(toolCustomizeMatch[1]);
		const scope = url.searchParams.get("scope") || "server";
		const projectScope = resolveRequiredConfigProjectScope(url.searchParams.get("projectId"), { aliasSystem: true });
		if (!projectScope.ok) { writeConfigProjectScopeError(projectScope); return; }
		const projectId = projectScope.effectiveProjectId;

		// Find the tool in the cascade to get its origin
		const resolved = configCascade.resolveTools(projectId);
		const source = resolved.find(r => r.item.name === name);
		if (!source) { json({ error: "Tool not found" }, 404); return; }

		// Find the groupDir by scanning tool directories to locate this tool's YAML
		const builtinToolsDir = runtimeBuiltinToolsDir();
		const serverToolsDir = path.join(bobbitConfigDir(), "tools");

		// Find groupDir from the source layer
		let groupDir: string | null = null;
		let sourceToolsDir: string;
		if (source.origin === "builtin") {
			sourceToolsDir = builtinToolsDir;
			groupDir = findToolGroupDir(name, builtinToolsDir);
		} else if (source.origin === "project" && projectId) {
			const ctx = projectContextManager.getOrCreate(projectId);
			sourceToolsDir = ctx ? path.join(ctx.configDir, "tools") : serverToolsDir;
			groupDir = findToolGroupDir(name, sourceToolsDir);
		} else {
			sourceToolsDir = serverToolsDir;
			groupDir = findToolGroupDir(name, serverToolsDir);
		}
		// Fallback: try all layers
		if (!groupDir) groupDir = findToolGroupDir(name, builtinToolsDir) || findToolGroupDir(name, serverToolsDir);
		if (!groupDir) { json({ error: "Could not determine tool group directory" }, 400); return; }

		// Determine target directory
		let targetToolsDir: string;
		if (scope === "project" && projectId) {
			const ctx = projectContextManager.getOrCreate(projectId);
			if (!ctx) { json({ error: "Project not found" }, 404); return; }
			targetToolsDir = path.join(ctx.configDir, "tools");
		} else {
			targetToolsDir = serverToolsDir;
		}

		// Determine the actual source dir for copying
		let actualSourceDir = sourceToolsDir;
		// If the source layer doesn't have this group, try builtins then server
		if (!fs.existsSync(path.join(actualSourceDir, groupDir))) {
			if (fs.existsSync(path.join(builtinToolsDir, groupDir))) actualSourceDir = builtinToolsDir;
			else if (fs.existsSync(path.join(serverToolsDir, groupDir))) actualSourceDir = serverToolsDir;
		}

		const srcDir = path.join(actualSourceDir, groupDir);

		if (!fs.existsSync(srcDir)) { json({ error: "Source tool group not found" }, 404); return; }

		// Copy the whole group plus sibling modules imported through ../_shared/*.
		copyToolGroupWithSharedDependencies(actualSourceDir, targetToolsDir, groupDir);

		json({ ok: true, groupDir }, 201);
		return;
	}

	// DELETE /api/tools/:name/override — remove tool group override at a scope
	const toolOverrideMatch = url.pathname.match(/^\/api\/tools\/([^/]+)\/override$/);
	if (toolOverrideMatch && req.method === "DELETE") {
		const name = decodeURIComponent(toolOverrideMatch[1]);
		const scope = url.searchParams.get("scope") || "server";
		const projectScope = resolveRequiredConfigProjectScope(url.searchParams.get("projectId"), { aliasSystem: true });
		if (!projectScope.ok) { writeConfigProjectScopeError(projectScope); return; }
		const projectId = projectScope.effectiveProjectId;

		// Determine the tools directory for the target scope
		let targetToolsDir: string;
		if (scope === "project" && projectId) {
			const ctx = projectContextManager.getOrCreate(projectId);
			if (!ctx) { json({ error: "Project not found" }, 404); return; }
			targetToolsDir = path.join(ctx.configDir, "tools");
		} else {
			targetToolsDir = path.join(bobbitConfigDir(), "tools");
		}

		// Find which group directory contains this tool
		const builtinToolsDir = runtimeBuiltinToolsDir();

		// Find groupDir in the target scope (the override we're deleting)
		let groupDir = findToolGroupDir(name, targetToolsDir);
		// If not found in target, try builtins to at least know the group name
		if (!groupDir) groupDir = findToolGroupDir(name, builtinToolsDir);
		if (!groupDir) { json({ error: "Could not determine tool group directory" }, 400); return; }

		const dirToRemove = path.join(targetToolsDir, groupDir);
		if (fs.existsSync(dirToRemove)) {
			fs.rmSync(dirToRemove, { recursive: true, force: true });
		}

		json({ ok: true });
		return;
	}

	// ── Tool group policies ──

	// GET /api/tool-group-policies
	if (url.pathname === "/api/tool-group-policies" && req.method === "GET") {
		const projectScope = resolveRequiredConfigProjectScope(url.searchParams.get("projectId"));
		if (!projectScope.ok) { writeConfigProjectScopeError(projectScope); return; }
		json(configCascade.resolveToolGroupPolicies(projectScope.effectiveProjectId));
		return;
	}

	// PUT /api/tool-group-policies/:group
	const groupPolicyMatch = url.pathname.match(/^\/api\/tool-group-policies\/(.+)$/);
	if (groupPolicyMatch && req.method === "PUT") {
		const group = decodeURIComponent(groupPolicyMatch[1]);
		const body = await readBody(req);
		if (!body) { json({ error: "Missing body" }, 400); return; }
		const validPolicies = ['allow', 'ask', 'never', 'always-allow', 'ask-once', 'always-ask', 'never-ask'];
		if (body.policy && !validPolicies.includes(body.policy)) {
			json({ error: `Invalid policy. Must be one of: allow, ask, never` }, 400);
			return;
		}
		// Scope the mutation to a project-level store when projectId is given.
		// Headquarters/system alias to server scope (mirrors resolveRoleMutationTarget).
		const projectScope = resolveRequiredConfigProjectScope(body.projectId ?? url.searchParams.get("projectId"), { aliasSystem: true });
		if (!projectScope.ok) { writeConfigProjectScopeError(projectScope); return; }
		const targetStore: ToolGroupPolicyStore = projectScope.context?.toolGroupPolicyStore ?? groupPolicyStore;
		targetStore.setGroupPolicy(group, body.policy || null);
		json({ ok: true });
		return;
	}

	// ── Config: default cwd ──

	// GET /api/config/cwd
	if (url.pathname === "/api/config/cwd" && req.method === "GET") {
		json({ cwd: config.defaultCwd });
		return;
	}

	// PUT /api/config/cwd
	if (url.pathname === "/api/config/cwd" && req.method === "PUT") {
		const body = await readBody(req);
		if (!body?.cwd || typeof body.cwd !== "string") {
			json({ error: "Missing or invalid cwd" }, 400);
			return;
		}
		config.defaultCwd = body.cwd;
		preferencesStore.set("defaultCwd", body.cwd);
		json({ cwd: config.defaultCwd });
		return;
	}

	// ── Preferences ──

	/** Return preferences with sensitive keys (providerKey.*) filtered out. */
	function getSafePreferences(): Record<string, unknown> {
		const all = preferencesStore.getAll();
		const filtered: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(all)) {
			if (!key.startsWith("providerKey.")) {
				filtered[key] = value;
			}
		}
		return filtered;
	}

	/** Broadcast preferences_changed with sensitive keys filtered out. */
	function broadcastPreferencesChanged(): void {
		broadcastToAll({ type: "preferences_changed", preferences: getSafePreferences() });
	}

	// GET /api/agent-dir — return startup-resolved active dir plus next-start state.
	if (url.pathname === "/api/agent-dir" && req.method === "GET") {
		json(getAgentDirApiState());
		return;
	}

	// POST /api/agent-dir/validate — validate and probe an agent-dir target.
	if (url.pathname === "/api/agent-dir/validate" && req.method === "POST") {
		const body = await readBody(req);
		if (!body || typeof body !== "object") { json({ ok: false, error: { code: "MISSING_BODY", message: "Missing body" } }, 400); return; }
		const result = validateAgentDirTarget((body as any).path, getProjectRoot());
		json(result);
		return;
	}

	// PUT /api/agent-dir/pending — save the next-start agent dir without live-switching.
	if (url.pathname === "/api/agent-dir/pending" && req.method === "PUT") {
		const body = await readBody(req);
		if (!body || typeof body !== "object") { json({ error: "Missing body" }, 400); return; }
		const rawPath = (body as any).path;
		let persistedPath: string | undefined;
		if (rawPath === null || rawPath === undefined || (typeof rawPath === "string" && rawPath.trim().length === 0)) {
			preferencesStore.remove("agentDir");
		} else if (typeof rawPath === "string") {
			const validation = validateAgentDirTarget(rawPath, getProjectRoot());
			if (!validation.ok) { json(validation, 400); return; }
			persistedPath = validation.resolvedPath;
			preferencesStore.set("agentDir", persistedPath);
		} else {
			json({ error: "path must be a string, null, or empty" }, 400);
			return;
		}

		const state = refreshAgentDirNextStart(persistedPath, bobbitStateDir());
		preferencesStore.set("agentDirHistory", state.history);
		broadcastPreferencesChanged();
		broadcastToAll({ type: "agent_dir_changed", agentDir: getAgentDirApiState() });
		json({ ...getAgentDirApiState(), guidance: buildAgentDirRestartGuidance() });
		return;
	}

	// POST /api/agent-dir/migrate — copy allowlisted agent data; never delete or move source.
	if (url.pathname === "/api/agent-dir/migrate" && req.method === "POST") {
		const body = await readBody(req);
		if (!body || typeof body !== "object") { json({ error: "Missing body" }, 400); return; }
		const sourceRaw = (body as any).sourcePath;
		const destinationRaw = (body as any).destinationPath;
		if (typeof sourceRaw !== "string" || typeof destinationRaw !== "string" || sourceRaw.trim().length === 0 || destinationRaw.trim().length === 0) {
			json({ error: "sourcePath and destinationPath are required" }, 400);
			return;
		}
		const sourcePath = normalizeAgentDirInput(sourceRaw, getProjectRoot());
		const destinationPath = normalizeAgentDirInput(destinationRaw, getProjectRoot());
		if (!isKnownAgentDir(sourcePath)) {
			json({ error: "sourcePath must be the active or a historical agent directory", code: "INVALID_SOURCE" }, 400);
			return;
		}
		if (!isPendingAgentDir(destinationPath)) {
			json({ error: "destinationPath must be the pending next-start agent directory", code: "INVALID_DESTINATION" }, 400);
			return;
		}
		const report = migrateAgentDirData(sourcePath, destinationPath, (body as any).overwrite === true);
		if (report.error) {
			json(report, 400);
			return;
		}
		const state = refreshAgentDirNextStart((preferencesStore.get("agentDir") as string | undefined), bobbitStateDir());
		preferencesStore.set("agentDirHistory", state.history);
		broadcastToAll({ type: "agent_dir_changed", agentDir: getAgentDirApiState() });
		json({ ...report, guidance: buildAgentDirRestartGuidance() });
		return;
	}

	// GET /api/preferences — return all preferences (filter sensitive keys)
	if (url.pathname === "/api/preferences" && req.method === "GET") {
		json(getSafePreferences());
		return;
	}

	// PUT /api/preferences — merge preferences
	if (url.pathname === "/api/preferences" && req.method === "PUT") {
		const body = await readBody(req);
		if (!body || typeof body !== "object") { json({ error: "Missing body" }, 400); return; }
		const blockedAgentDirKeys = ["agentDir", "agentDirHistory"];
		const blockedKey = Object.keys(body).find(key => blockedAgentDirKeys.includes(key));
		if (blockedKey) {
			json({
				error: `${blockedKey} is managed by the agent directory settings workflow. Use PUT /api/agent-dir/pending instead.`,
				code: "AGENT_DIR_PREFERENCE_FORBIDDEN",
				key: blockedKey,
				use: "/api/agent-dir/pending",
			}, 400);
			return;
		}
		const headquartersVisibilityChanged = Object.prototype.hasOwnProperty.call(body, "showHeadquartersInProjectLists");
		for (const [key, value] of Object.entries(body)) {
			if (key === "githubTrustedHosts") {
				// Normalize-and-store the accepted subset (lossy, no 4xx). GET readback is
				// authoritative. An empty/invalid list removes the key entirely.
				const normalized = normalizeTrustedHosts(value);
				if (normalized.length === 0) preferencesStore.remove(key);
				else preferencesStore.set(key, normalized);
			} else if (value === null || value === undefined) {
				preferencesStore.remove(key);
			} else {
				preferencesStore.set(key, value);
			}
		}
		json(getSafePreferences());
		broadcastPreferencesChanged();
		if (headquartersVisibilityChanged) {
			broadcastToAll({ type: "projects_changed", projects: listProjectsForApi() });
		}
		return;
	}

	// GET /api/project-config — return project settings
	if (url.pathname === "/api/project-config" && req.method === "GET") {
		json(projectConfigStore.getWithDefaults());
		return;
	}

	// GET /api/project-config/defaults — return just the defaults
	if (url.pathname === "/api/project-config/defaults" && req.method === "GET") {
		json(projectConfigStore.getDefaults());
		return;
	}

	// GET /api/config-directories — return all scanned config directories
	if (url.pathname === "/api/config-directories" && req.method === "GET") {
		const projectId = url.searchParams.get("projectId") || undefined;
		const resolved = resolveProjectForRequest(projectRegistry, { projectId });
		if (!resolved.ok) { writeProjectResolutionError(resolved); return; }
		const resolvedStore = resolveProjectConfigStore(resolved.projectId);
		json(getAllConfigDirectories(resolved.project.rootPath, resolvedStore));
		return;
	}

	// DELETE /api/config-directories — remove a built-in directory from scanning
	if (url.pathname === "/api/config-directories" && req.method === "DELETE") {
		const body = await readBody(req);
		if (!body || typeof body !== "object" || typeof (body as any).path !== "string") {
			json({ error: "Missing 'path' in body" }, 400);
			return;
		}
		const resolved = resolveProjectForRequest(projectRegistry, { projectId: (body as any).projectId });
		if (!resolved.ok) { writeProjectResolutionError(resolved); return; }
		const resolvedStore = resolveProjectConfigStore(resolved.projectId);
		removeBuiltinDirectory(resolvedStore, (body as any).path);
		json({ ok: true });
		return;
	}

	// POST /api/config-directories/reset — reset all config dirs to defaults
	if (url.pathname === "/api/config-directories/reset" && req.method === "POST") {
		const body = await readBody(req);
		const resolved = resolveProjectForRequest(projectRegistry, { projectId: body && typeof body === "object" ? (body as any).projectId : undefined });
		if (!resolved.ok) { writeProjectResolutionError(resolved); return; }
		const resolvedStore = resolveProjectConfigStore(resolved.projectId);
		resetConfigDirectories(resolvedStore);
		json({ ok: true });
		return;
	}

	// ── Pack-Based Marketplace (design §9 / §9.1 / §9.2) ──────────────
	if (url.pathname.startsWith("/api/marketplace/") || url.pathname === "/api/packs/conflicts") {
		if (!marketplaceInstaller || !marketplaceSourceStore) { json({ error: "marketplace not available" }, 500); return; }
		const installer = marketplaceInstaller;
		const sourceStore = marketplaceSourceStore;

		// ── Built-in first-party source (built-in-first-party-packs §4.4, §6.4) ──
		// The built-in source is synthetic + non-persisted: it is composed only here
		// and points at the shipped first-party packs resolved in place.
		const BUILTIN_SOURCE_ID = "builtin";
		const builtinSource = { id: BUILTIN_SOURCE_ID, url: "builtin:", builtin: true, addedAt: new Date(0).toISOString() };
		// A pack name is "built-in" iff a shipped first-party pack declares it.
		const isBuiltinPackName = (name: string): boolean =>
			builtinFirstPartyPackEntries(resolveBuiltinPacksDir(config.builtinPacksDir)).some((e) => e.manifest?.name === name);
		// True iff a real user install of `(scope, packName)` exists in the ledger.
		const hasUserInstall = (scope: InstallScope, packName: string, projectId?: string): boolean =>
			installer.listInstalled(allContexts(normalizeConfigProjectId(projectId))).some((p) => p.scope === scope && p.packName === packName);

		const sourceDisplayName = (source: Pick<MarketplaceSource, "id" | "displayName" | "type"> & { builtin?: boolean }): string =>
			source.builtin ? "Built-in" : source.displayName ?? source.id;
		const sourceTypeForBrowse = (source: Pick<MarketplaceSource, "type"> & { builtin?: boolean }): "builtin" | "pack" | "mcp-gateway" | "mcp-registry" =>
			source.builtin ? "builtin" : (source.type ?? "pack");
		const browseRowWithSource = (pack: BrowsePack, source: Pick<MarketplaceSource, "id" | "displayName" | "type"> & { builtin?: boolean }): BrowsePack => {
			const type = sourceTypeForBrowse(source);
			return {
				...pack,
				source: { id: source.id, name: sourceDisplayName(source), type: type === "mcp-registry" ? "pack" : type, ...(source.builtin ? { builtin: true } : {}) },
				browseKey: `${source.id}:${pack.dirName}`,
			};
		};

		const MARKET_SCOPES = new Set(["global-user", "server", "project"]);
		const parseScope = (raw: unknown): InstallScope | null =>
			typeof raw === "string" && MARKET_SCOPES.has(raw) ? (raw as InstallScope) : null;

		type ScopeTarget = { scope: InstallScope; projectBase?: string; store: PackOrderStore };
		const resolveScopeTarget = (
			scope: InstallScope,
			projectId: string | undefined,
		): { ok: true; target: ScopeTarget } | { ok: false; status: number; error: string } => {
			const effectiveProjectId = normalizeConfigProjectId(projectId);
			if (scope === "project") {
				if (!projectId) return { ok: false, status: 400, error: "projectId required for project scope" };
				if (!effectiveProjectId) return { ok: true, target: { scope: "server", store: projectConfigStore } };
				const ctx = projectContextManager.getOrCreate(effectiveProjectId);
				if (!ctx) return { ok: false, status: 404, error: "Project not found" };
				return { ok: true, target: { scope, projectBase: ctx.project.rootPath, store: ctx.projectConfigStore } };
			}
			return { ok: true, target: { scope, store: projectConfigStore } };
		};

		const errStatus = (code: string, notInstalled = 409): number => {
			switch (code) {
				case "unknown_source": return 404;
				case "unknown_pack": return 404;
				case "invalid_pack": return 422;
				case "already_installed": return 409;
				case "not_installed": return notInstalled;
				case "unsafe_name": return 400;
				case "git_failed": return 502;
				default: return 400;
			}
		};
		const handleMarketErr = (err: unknown, notInstalled = 409): void => {
			if (err instanceof MarketplaceError) { json({ error: err.message }, errStatus(err.code, notInstalled)); return; }
			if (err instanceof Error && err.name === "McpGatewayError") { json({ error: err.message }, /fetch failed|HTTP|timed out/i.test(err.message) ? 502 : 422); return; }
			jsonError(500, err);
		};

		// All scope contexts present for cross-scope listing. Each carries its
		// scope's `pack_order` so `listInstalled` returns rows in precedence order
		// (finding #2) — the UI relies on that order to build reorder payloads.
		const allContexts = (projectId?: string): Array<{ scope: InstallScope; projectBase?: string; packOrder?: string[] }> => {
			const effectiveProjectId = normalizeConfigProjectId(projectId);
			const ctxs: Array<{ scope: InstallScope; projectBase?: string; packOrder?: string[] }> = [
				{ scope: "server", packOrder: projectConfigStore.getPackOrder("server") },
				{ scope: "global-user", packOrder: projectConfigStore.getPackOrder("global-user") },
			];
			if (effectiveProjectId) {
				const ctx = projectContextManager.getOrCreate(effectiveProjectId);
				if (ctx) ctxs.push({ scope: "project", projectBase: ctx.project.rootPath, packOrder: ctx.projectConfigStore.getPackOrder("project") });
			}
			return ctxs;
		};

		// ── All-source Browse ─────────────────────────────────────
		// GET /api/marketplace/browse?projectId=<optional>
		if (url.pathname === "/api/marketplace/browse" && req.method === "GET") {
			type BrowseSourceState = {
				sourceId: string;
				sourceName: string;
				sourceType: "builtin" | "pack" | "mcp-gateway" | "mcp-registry";
				builtin?: boolean;
				status: "ok" | "loading" | "error" | "unsupported";
				error?: string;
				lastSyncedAt?: string;
			};
			const sources: BrowseSourceState[] = [];
			const packs: BrowsePack[] = [];
			const builtinPacks = builtinFirstPartyPackEntries(resolveBuiltinPacksDir(config.builtinPacksDir)).map((e): BrowsePack => ({
				...e.manifest!,
				dirName: e.manifest!.name,
				hasTools: e.manifest!.contents.tools.length > 0,
				builtin: true,
				provided: true,
			} as BrowsePack));
			sources.push({ sourceId: builtinSource.id, sourceName: sourceDisplayName(builtinSource), sourceType: "builtin", builtin: true, status: "ok" });
			packs.push(...builtinPacks.map((pack) => browseRowWithSource(pack, builtinSource)));

			for (const source of sourceStore.list()) {
				const sourceType = sourceTypeForBrowse(source);
				const state: BrowseSourceState = {
					sourceId: source.id,
					sourceName: sourceDisplayName(source),
					sourceType,
					status: "ok",
					...(source.lastSyncedAt ? { lastSyncedAt: source.lastSyncedAt } : {}),
				};
				if (sourceType === "mcp-registry") {
					sources.push({ ...state, status: "unsupported", error: source.unsupportedReason ?? "source type is unsupported" });
					continue;
				}
				try {
					const rows = await installer.browseSourcePacks(source.id);
					const refreshed = sourceStore.get(source.id) ?? source;
					sources.push({ ...state, ...(refreshed.lastSyncedAt ? { lastSyncedAt: refreshed.lastSyncedAt } : {}) });
					packs.push(...rows.map((pack) => browseRowWithSource(pack, refreshed)));
				} catch (err) {
					sources.push({ ...state, status: "error", error: err instanceof Error ? err.message : String(err) });
				}
			}
			json({ sources, packs });
			return;
		}

		// ── Sources ───────────────────────────────────────────────
		// GET /api/marketplace/sources
		if (url.pathname === "/api/marketplace/sources" && req.method === "GET") {
			// Prepend the synthetic, non-removable built-in source (§4.4).
			json({ sources: [builtinSource, ...sourceStore.list()] });
			return;
		}
		// POST /api/marketplace/sources { url, ref?, type? }
		if (url.pathname === "/api/marketplace/sources" && req.method === "POST") {
			const body = await readBody(req);
			const srcUrl = body && typeof (body as any).url === "string" ? (body as any).url.trim() : "";
			if (!srcUrl) { json({ error: "url is required" }, 400); return; }
			if (sourceStore.getByUrl(srcUrl)) { json({ error: `source already registered: ${srcUrl}` }, 409); return; }
			let source;
			try {
				source = sourceStore.add({ url: srcUrl, ref: (body as any).ref, type: (body as any).type });
			} catch (err) { jsonError(400, err); return; }
			try {
				await installer.syncMarketplaceSource(source.id);
			} catch (err) {
				// Roll back the registration if the initial sync/fetch fails.
				sourceStore.remove(source.id);
				handleMarketErr(err);
				return;
			}
			json({ source: sourceStore.get(source.id) }, 201);
			return;
		}
		// /api/marketplace/sources/:id[...]
		const sourceMatch = url.pathname.match(/^\/api\/marketplace\/sources\/([^/]+)(\/sync|\/packs)?$/);
		if (sourceMatch) {
			const id = decodeURIComponent(sourceMatch[1]);
			const sub = sourceMatch[2];
			// Built-in source (§4.4): special-cased BEFORE the 404 check because
			// `sourceStore.get("builtin")` is undefined (never persisted).
			if (id === BUILTIN_SOURCE_ID) {
				if (!sub && req.method === "DELETE") {
					json({ error: "the built-in source cannot be removed" }, 403);
					return;
				}
				if (sub === "/sync" && req.method === "POST") {
					// No-op resync: built-in packs ride the app upgrade.
					json({ source: builtinSource });
					return;
				}
				if (sub === "/packs" && req.method === "GET") {
					// Map the shipped first-party packs to the same browse-row shape
					// `installer.browsePacks` returns, flagged builtin + provided.
					const packs = builtinFirstPartyPackEntries(resolveBuiltinPacksDir(config.builtinPacksDir)).map((e) => ({
						...e.manifest!,
						dirName: e.manifest!.name,
						hasTools: e.manifest!.contents.tools.length > 0,
						builtin: true,
						provided: true,
					}));
					json({ packs });
					return;
				}
				json({ error: "unsupported built-in source operation" }, 405);
				return;
			}
			if (!isValidSourceId(id) || !sourceStore.get(id)) { json({ error: `unknown source: ${id}` }, 404); return; }

			if (!sub && req.method === "DELETE") {
				sourceStore.remove(id);
				try { fs.rmSync(installer.cacheDirFor(id), { recursive: true, force: true }); } catch { /* ignore */ }
				res.writeHead(204); res.end();
				return;
			}
			if (sub === "/sync" && req.method === "POST") {
				try { await installer.syncMarketplaceSource(id); } catch (err) { handleMarketErr(err); return; }
				json({ source: sourceStore.get(id) });
				return;
			}
			if (sub === "/packs" && req.method === "GET") {
				try { json({ packs: await installer.browseSourcePacks(id) }); } catch (err) { handleMarketErr(err); }
				return;
			}
		}

		// ── Install / update / uninstall ──────────────────────────
		// POST /api/marketplace/install { sourceId, dirName, scope, projectId? }
		// `dirName` is the physical source subdir to read; the installed identity
		// is the pack's `manifest.name` (design §1.4). `packName` is accepted as a
		// back-compat alias for `dirName`.
		if (url.pathname === "/api/marketplace/install" && req.method === "POST") {
			const body = (await readBody(req)) as any;
			const scope = parseScope(body?.scope);
			if (!scope) { json({ error: "invalid scope" }, 400); return; }
			const dirName = typeof body?.dirName === "string" ? body.dirName : (typeof body?.packName === "string" ? body.packName : undefined);
			if (typeof body?.sourceId !== "string" || typeof dirName !== "string") { json({ error: "sourceId and dirName are required" }, 400); return; }
			// Built-in packs are resolved in place; they cannot be copy-installed (§4.4).
			if (body.sourceId === BUILTIN_SOURCE_ID) { json({ error: "built-in packs are provided in place and cannot be installed" }, 403); return; }
			const st = resolveScopeTarget(scope, body?.projectId);
			if (!st.ok) { json({ error: st.error }, st.status); return; }
			try {
				const targetScope = st.target.scope;
				const targetProjectId = targetScope === "project" ? normalizeConfigProjectId(body?.projectId) : undefined;
				const installed = await installer.installMarketplacePack({ sourceId: body.sourceId, dirName, scope: targetScope, projectBase: st.target.projectBase, packOrderStore: st.target.store });
				invalidateResolverCaches();
				const mcpReload = installed.manifest.contents.mcp?.length ? await reloadMcpAfterMarketplaceMutation(targetScope, targetProjectId) : undefined;
				json({ installed, ...(mcpReload ? { mcpReload } : {}) }, 201);
			} catch (err) { handleMarketErr(err); }
			return;
		}
		// POST /api/marketplace/update { scope, packName, projectId? }
		if (url.pathname === "/api/marketplace/update" && req.method === "POST") {
			const body = (await readBody(req)) as any;
			const scope = parseScope(body?.scope);
			if (!scope) { json({ error: "invalid scope" }, 400); return; }
			if (typeof body?.packName !== "string") { json({ error: "packName is required" }, 400); return; }
			// Built-in packs update with the app; a server-scope built-in with no
			// ledger entry has nothing to update (§4.4). A genuine user install of
			// the same name proceeds normally below.
			if (scope === "server" && isBuiltinPackName(body.packName) && !hasUserInstall("server", body.packName, body?.projectId)) {
				json({ error: "built-in packs update with the app; nothing to update" }, 403);
				return;
			}
			const st = resolveScopeTarget(scope, body?.projectId);
			if (!st.ok) { json({ error: st.error }, st.status); return; }
			try {
				const targetScope = st.target.scope;
				const targetProjectId = targetScope === "project" ? normalizeConfigProjectId(body?.projectId) : undefined;
				const prior = installer.listInstalled([{ scope: targetScope, projectBase: st.target.projectBase }]).find((p) => p.scope === targetScope && p.packName === body.packName);
				const hadMcp = (prior?.manifest.contents.mcp?.length ?? 0) > 0;
				const installed = await installer.updateMarketplacePack({ packName: body.packName, scope: targetScope, projectBase: st.target.projectBase, packOrderStore: st.target.store });
				invalidateResolverCaches();
				const hasMcp = (installed.manifest.contents.mcp?.length ?? 0) > 0;
				const mcpReload = hadMcp || hasMcp ? await reloadMcpAfterMarketplaceMutation(targetScope, targetProjectId) : undefined;
				json({ installed, ...(mcpReload ? { mcpReload } : {}) });
			} catch (err) { handleMarketErr(err, 409); }
			return;
		}
		// DELETE /api/marketplace/installed { scope, packName, projectId? }
		if (url.pathname === "/api/marketplace/installed" && req.method === "DELETE") {
			const body = (await readBody(req)) as any;
			const scope = parseScope(body?.scope);
			if (!scope) { json({ error: "invalid scope" }, 400); return; }
			if (typeof body?.packName !== "string") { json({ error: "packName is required" }, 400); return; }
			// Built-in packs are not in the install ledger and cannot be uninstalled
			// (§4.4); only enable/disable applies. A genuine user install of the same
			// name (ledger entry present) proceeds normally below.
			if (isBuiltinPackName(body.packName) && !hasUserInstall(scope, body.packName, body?.projectId)) {
				json({ error: "built-in packs cannot be uninstalled" }, 403);
				return;
			}
			const st = resolveScopeTarget(scope, body?.projectId);
			if (!st.ok) { json({ error: st.error }, st.status); return; }
			try {
				const targetScope = st.target.scope;
				const targetProjectId = targetScope === "project" ? normalizeConfigProjectId(body?.projectId) : undefined;
				const prior = installer.listInstalled([{ scope: targetScope, projectBase: st.target.projectBase }]).find((p) => p.scope === targetScope && p.packName === body.packName);
				installer.uninstallPack({ packName: body.packName, scope: targetScope, projectBase: st.target.projectBase, packOrderStore: st.target.store });
				invalidateResolverCaches();
				if (prior?.manifest.contents.mcp?.length) await reloadMcpAfterMarketplaceMutation(targetScope, targetProjectId);
				res.writeHead(204); res.end();
			} catch (err) { handleMarketErr(err, 404); }
			return;
		}
		// GET /api/marketplace/installed?projectId=
		if (url.pathname === "/api/marketplace/installed" && req.method === "GET") {
			const projectId = url.searchParams.get("projectId") || undefined;
			try {
				// Prepend synthetic built-in pack rows (§6.4): a distinct non-install
				// row kind (no meta/ledger entry) flagged `builtin: true`. A
				// user-installed same-name pack still appears as its own ledger row.
				const builtinRows = builtinFirstPartyPackEntries(resolveBuiltinPacksDir(config.builtinPacksDir)).map((e) => ({
					scope: "server" as InstallScope,
					packName: e.manifest!.name,
					manifest: e.manifest!,
					meta: e.meta,
					status: "ok" as const,
					builtin: true,
					// Built-in packs ship with the app: no upstream source to check, never
					// "update available" (they update with the app upgrade, §4.2).
					updateAvailable: false,
					sourceStatus: "ok" as const,
				}));
				json({ installed: [...builtinRows, ...installer.listInstalled(allContexts(projectId))] });
			} catch (err) { jsonError(500, err); }
			return;
		}

		// ── pack-order (§9.2) ─────────────────────────────────────
		if (url.pathname === "/api/marketplace/pack-order" && req.method === "GET") {
			const scope = parseScope(url.searchParams.get("scope"));
			if (!scope) { json({ error: "invalid scope" }, 400); return; }
			const projectId = url.searchParams.get("projectId") || undefined;
			const st = resolveScopeTarget(scope, projectId);
			if (!st.ok) { json({ error: st.error }, st.status); return; }
			const targetScope = st.target.scope;
			json({ scope: targetScope, order: st.target.store.getPackOrder(targetScope) });
			return;
		}
		if (url.pathname === "/api/marketplace/pack-order" && req.method === "PUT") {
			const body = (await readBody(req)) as any;
			const scope = parseScope(body?.scope);
			if (!scope) { json({ error: "invalid scope" }, 400); return; }
			if (!Array.isArray(body?.order) || !body.order.every((x: unknown) => typeof x === "string")) { json({ error: "order must be a string array" }, 400); return; }
			const st = resolveScopeTarget(scope, body?.projectId);
			if (!st.ok) { json({ error: st.error }, st.status); return; }
			const targetScope = st.target.scope;
			const targetProjectId = targetScope === "project" ? normalizeConfigProjectId(body?.projectId) : undefined;
			// Normalize: drop names not installed at this scope; append on-disk-but-absent
			// packs at lowest priority (front), preserving the requested order otherwise.
			const installedNames = installer.listInstalled([{ scope: targetScope, projectBase: st.target.projectBase }])
				.filter((p) => p.scope === targetScope && p.status !== "corrupt")
				.map((p) => p.packName);
			const installedSet = new Set(installedNames);
			const filtered = (body.order as string[]).filter((n) => installedSet.has(n));
			const missing = installedNames.filter((n) => !filtered.includes(n));
			const normalized = [...missing, ...filtered];
			st.target.store.setPackOrder(targetScope, normalized);
			invalidateResolverCaches();
			const hasMcp = installer.listInstalled([{ scope: targetScope, projectBase: st.target.projectBase }]).some((p) => p.scope === targetScope && (p.manifest.contents.mcp?.length ?? 0) > 0);
			const mcpReload = hasMcp ? await reloadMcpAfterMarketplaceMutation(targetScope, targetProjectId) : undefined;
			json({ scope: targetScope, order: normalized, ...(mcpReload ? { mcpReload } : {}) });
			return;
		}

		// ── pack-activation (pack-schema-v1 §6.7) ──────────────────
		// The `catalogue` is the UNFILTERED authoritative source for the Market UI
		// toggles: read straight from the INSTALLED pack's pack.yaml manifest
		// contents (NOT from the runtime-filtered /api/tools or /api/ext/contributions),
		// so a disabled entity still appears and can be re-enabled. `disabled` is the
		// current pack_activation override; checked = name ∉ disabled[kind].
		type PackActivationMcpOperationEntry = {
			name: string;
			label?: string;
			description?: string;
			toolName?: string;
			policyKey: string;
			selected: boolean;
			disabledByActivation: boolean;
			inputSchema?: unknown;
		};
		const mcpPolicyKey = (serverName: string, subNamespace: string | undefined, operationName?: string): string => {
			const parts = ["mcp", serverName];
			if (subNamespace) parts.push(subNamespace);
			if (operationName) parts.push(operationName);
			return parts.join("__");
		};
		const activationMcpRef = (entry: PackEntry, mcp: ResolvedMcpContribution | { listName: string; serverName: string; subNamespace?: string; config?: any; sourceFile?: string }, metaDetails: Record<string, unknown>): string => {
			return activationMcpContributionId(entry, mcp, metaDetails, sourceStore.getByUrl(String(entry.meta?.sourceUrl ?? ""))?.id);
		};
		const operationsForMcp = (mcp: { listName: string; sourceFile?: string; operationMetadata?: unknown }, metaDetails: Record<string, unknown>): McpOperationMetadataEntry[] => {
			return operationMetadataForMcpContribution(mcp, metaDetails);
		};
		const runtimeOperationsForMcp = (
			mcp: { listName: string; serverName: string; subNamespace?: string },
			contributionId: string,
			routes: McpToolRouteSnapshot[],
		): McpOperationMetadataEntry[] => {
			const out: McpOperationMetadataEntry[] = [];
			const seen = new Set<string>();
			for (const route of routes) {
				const routeContributionId = safeString(route.contributionId);
				const routeListName = safeString(route.listName);
				const routeServerName = safeString(route.serverName ?? route.publicServerName);
				const routeSubNamespace = safeString(route.subNamespace);
				const belongsToContribution = routeContributionId
					? routeContributionId === contributionId
					: routeListName === mcp.listName && routeServerName === mcp.serverName && routeSubNamespace === mcp.subNamespace;
				if (!belongsToContribution) continue;
				const parsed = typeof route.name === "string" ? parseMcpToolName(route.name) : undefined;
				const rawName = safeString(route.mcpToolName);
				const name = parsed?.sub && parsed.sub === mcp.subNamespace && parsed.op ? parsed.op : rawName;
				if (!name || seen.has(name)) continue;
				seen.add(name);
				out.push({
					name,
					...(safeString(route.description) ? { description: safeString(route.description) } : {}),
					...(route.inputSchema !== undefined ? { inputSchema: route.inputSchema } : {}),
				});
			}
			return out;
		};

		const buildActivationCatalogue = (
			scope: InstallScope,
			projectBase: string | undefined,
			store: PackOrderStore,
			packName: string,
			projectId?: string,
		): { roles: string[]; tools: string[]; skills: string[]; entrypoints: Array<{ listName: string; label?: string; kind?: "composer-slash" | "session-menu" | "route"; routeId?: string }>; providers?: string[]; hooks?: string[]; mcp?: Array<string | Record<string, unknown>>; piExtensions?: Array<string | Record<string, unknown>>; runtimes?: string[]; workflows?: string[]; descriptions: PackEntityDescriptions } | null => {
			const base = scope === "server" ? headquartersDir() : scope === "global-user" ? os.homedir() : projectBase;
			if (base === undefined) return null;
			const entries = scopeMarketPackEntries(scope as PackScope, base, store.getPackOrder(scope));
			let entry = entries.find((e) => e.manifest?.name === packName);
			// Built-in first-party packs (§7.4) have NO install-ledger entry but ARE
			// toggleable at server scope — resolve their catalogue from the built-in band.
			if ((!entry || !entry.manifest) && scope === "server") {
				entry = builtinFirstPartyPackEntries(resolveBuiltinPacksDir(config.builtinPacksDir)).find((e) => e.manifest?.name === packName);
			}
			if (!entry || !entry.manifest) return null;
			const c = entry.manifest.contents;
			const metaDetails = readYamlMapping(path.join(entry.path, ".pack-meta.yaml")) ?? {};
			const activationStore = store as unknown as ProjectConfigStore;
			const currentDisabled = activationStore.getPackActivation?.(scope as PackOrderScope, packName) ?? {};
			const disabledMcpRefs = new Set(currentDisabled.mcp ?? []);
			const disabledMcpOperations = currentDisabled.mcpOperations ?? {};
			const concreteTools = readConcretePackToolsFromGroups(entry.path, c.tools);
			const descriptions = readPackEntityDescriptions(entry.path, entry.manifest);
			if (Object.keys(concreteTools.descriptions).length > 0) {
				descriptions.tools = concreteTools.descriptions;
			} else {
				delete descriptions.tools;
			}
			// Valid entrypoint display metadata from the entrypoint files. Invalid or
			// unsupported entrypoint kinds are omitted so retired launch surfaces do not
			// render as activation toggles.
			const entrypointByListName = new Map<string, { label?: string; kind: "composer-slash" | "session-menu" | "route"; routeId?: string }>();
			const mcpByListName = new Map<string, Record<string, unknown>>();
			const piExtensionByListName = new Map<string, Record<string, unknown>>();
			try {
				const contributions = loadPackContributions(entry.path, entry.manifest);
				for (const ep of contributions.entrypoints) {
					entrypointByListName.set(ep.listName, { label: ep.label, kind: ep.kind, routeId: ep.routeId });
				}
				const mcpManager = scope === "project" ? sessionManager.getMcpManager({ projectId }) : sessionManager.getMcpManager();
				const statuses = mcpManager?.getServerStatuses() ?? [];
				const runtimeRoutes = mcpManager?.getToolRouteSnapshots?.() ?? [];
				for (const mcp of contributions.mcp ?? []) {
					const transport = mcp.config.url ? "http" : "stdio";
					const contributionId = activationMcpRef(entry, mcp, metaDetails);
					const status = statuses.find((s) => s.ownerContributions?.some((c) => c.contributionId === contributionId || (c.listName === mcp.listName && c.origin.packName === entry.manifest!.name && c.origin.scope === entry.scope)))
						?? statuses.find((s) => s.name === mcp.serverName);
					const owner = status?.ownerContributions?.find((c) => c.contributionId === contributionId || (c.listName === mcp.listName && c.origin.packName === entry.manifest!.name && c.origin.scope === entry.scope));
					const overriddenBy = status && !owner
						? (status.origin?.scope === "manual" ? "overridden-by-manual" : "overridden-by-marketplace")
						: undefined;
					const disabledOps = [...new Set(disabledMcpOperations[contributionId] ?? [])];
					const disabledOpsSet = new Set(disabledOps);
					const staticOperationMetadata = operationsForMcp(mcp, metaDetails);
					const operationMetadata = staticOperationMetadata.length > 0
						? staticOperationMetadata
						: runtimeOperationsForMcp(mcp, contributionId, runtimeRoutes);
					const knownOperationNames = new Set(operationMetadata.map((op) => op.name));
					const operations = operationMetadata.map((op): PackActivationMcpOperationEntry => {
						const policyKey = mcpPolicyKey(mcp.serverName, mcp.subNamespace, op.name);
						return {
							name: op.name,
							...(op.label ? { label: op.label } : {}),
							...(op.description ? { description: op.description } : {}),
							...(op.inputSchema !== undefined ? { inputSchema: op.inputSchema } : {}),
							toolName: policyKey,
							policyKey,
							selected: !disabledOpsSet.has(op.name),
							disabledByActivation: disabledOpsSet.has(op.name),
						};
					});
					const staleDisabledOperations = disabledOps.filter((name) => !knownOperationNames.has(name));
					mcpByListName.set(mcp.listName, {
						ref: mcp.listName,
						contributionId,
						listName: mcp.listName,
						serverName: mcp.serverName,
						policyKey: mcpPolicyKey(mcp.serverName, mcp.subNamespace),
						selected: !disabledMcpRefs.has(contributionId) && !disabledMcpRefs.has(mcp.listName),
						...(safeString(metaDetails.sourceId) ? { sourceId: safeString(metaDetails.sourceId) } : {}),
						...(entry.manifest?.name ? { installedPackName: entry.manifest.name } : {}),
						...(safeString(metaDetails.gatewayProviderId) ? { gatewayProviderId: safeString(metaDetails.gatewayProviderId) } : {}),
						...(mcp.subNamespace ? { subNamespace: mcp.subNamespace } : {}),
						...(mcp.label ? { label: mcp.label } : {}),
						...(mcp.description ? { description: mcp.description } : {}),
						transport,
						...(mcp.config.command ? { command: mcp.config.command } : {}),
						...(mcp.config.args ? { args: mcp.config.args } : {}),
						...(mcp.config.cwd ? { cwd: mcp.config.cwd } : {}),
						...(mcp.config.env ? { env: Object.keys(mcp.config.env) } : {}),
						...(mcp.config.url ? { url: mcp.config.url } : {}),
						...(mcp.config.headers ? { headers: Object.keys(mcp.config.headers) } : {}),
						...(status ? { status: status.status, ownerStatus: overriddenBy ?? (owner ? status.status : status.status), toolCount: operations.length > 0 ? operations.filter((op) => op.selected).length : status.toolCount } : {}),
						...(operations.length > 0 ? { operations, selectedOperationCount: operations.filter((op) => op.selected).length, totalOperationCount: operations.length } : { selectedOperationCount: undefined, totalOperationCount: undefined }),
						...(disabledOps.length > 0 ? { disabledOperations: disabledOps } : {}),
						...(staleDisabledOperations.length > 0 ? { staleDisabledOperations } : {}),
						...(overriddenBy ? { ownerStatus: overriddenBy, overriddenBy: status?.origin?.packName ?? status?.origin?.scope } : {}),
						...(status?.error ? { error: status.error } : {}),
					});
					if (mcp.description) {
						descriptions.mcp = { ...(descriptions.mcp ?? {}), [mcp.listName]: mcp.description };
					}
				}
			} catch { /* metadata is optional; listName is the stable key */ }
			try {
				const resolvedPiExtensions = sessionManager.resolveMarketplacePiExtensionContributions(projectId)
					.filter((piExtension) => piExtension.origin.scope === entry.scope && piExtension.origin.packName === entry.manifest!.name);
				const piExtensions = resolvedPiExtensions.length > 0 ? resolvedPiExtensions : loadPiExtensionContributionsFromRuntime(entry.path, entry.manifest);
				const disabledPiExtensions = new Set(((store as unknown as ProjectConfigStore).getPackActivation?.(scope as PackOrderScope, packName).piExtensions) ?? []);
				for (const piExtension of piExtensions) {
					const diagnostic = disabledPiExtensions.has(piExtension.listName)
						? piExtensionDiagnostic("disabled", "disabled_by_activation", `Pi extension "${piExtension.listName}" is disabled for pack "${entry.manifest.name}".`)
						: piExtension.diagnostic;
					piExtensionByListName.set(piExtension.listName, {
						ref: piExtension.listName,
						listName: piExtension.listName,
						...(piExtension.entryRelativePath ? { entryRelativePath: piExtension.entryRelativePath } : {}),
						diagnostic,
						tools: (piExtension.discovery?.tools ?? []).map((tool) => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}) })),
					});
				}
			} catch { /* pi extension metadata is optional; listName is the stable key */ }
			const baseCatalogue = {
				roles: [...c.roles],
				tools: concreteTools.tools,
				skills: [...c.skills],
				entrypoints: (c.entrypoints ?? []).flatMap((listName) => {
					const meta = entrypointByListName.get(listName);
					return meta ? [{ listName, ...meta }] : [];
				}),
				// One-line per-entity descriptions for the activation disclosure (R3).
				// Read from the SAME installed pack dir as the catalogue above — never
				// from the runtime-filtered /api/tools or /api/ext/contributions.
				descriptions,
			};
			if ((entry.manifest.schema ?? 1) < 2) return baseCatalogue;
			return {
				roles: baseCatalogue.roles,
				tools: baseCatalogue.tools,
				skills: baseCatalogue.skills,
				entrypoints: baseCatalogue.entrypoints,
				providers: [...(c.providers ?? [])],
				hooks: [...(c.hooks ?? [])],
				mcp: (c.mcp ?? []).map((listName) => mcpByListName.get(listName) ?? listName),
				piExtensions: (c.piExtensions ?? []).map((listName) => piExtensionByListName.get(listName) ?? listName),
				runtimes: [...(c.runtimes ?? [])],
				workflows: [...(c.workflows ?? [])],
				descriptions,
			};
		};
		const mcpContributionLookup = (catalogue: { mcp?: Array<string | Record<string, unknown>> }): Map<string, string> => {
			const out = new Map<string, string>();
			for (const entry of catalogue.mcp ?? []) {
				if (typeof entry === "string") {
					out.set(entry, entry);
					continue;
				}
				const contributionId = safeString(entry.contributionId) ?? safeString(entry.ref) ?? safeString(entry.listName);
				if (!contributionId) continue;
				for (const alias of [entry.contributionId, entry.ref, entry.listName, entry.legacyRef]) {
					const key = safeString(alias);
					if (key) out.set(key, contributionId);
				}
			}
			return out;
		};
		const packActivationRevision = (disabled: unknown): string =>
			`act:${createHash("sha256").update(JSON.stringify(disabled ?? {})).digest("hex").slice(0, 16)}`;
		if (url.pathname === "/api/marketplace/pack-activation" && req.method === "GET") {
			const scope = parseScope(url.searchParams.get("scope"));
			if (!scope) { json({ error: "invalid scope" }, 400); return; }
			const projectId = url.searchParams.get("projectId") || undefined;
			const packName = url.searchParams.get("packName") || "";
			if (!packName) { json({ error: "packName is required" }, 400); return; }
			const st = resolveScopeTarget(scope, projectId);
			if (!st.ok) { json({ error: st.error }, st.status); return; }
			const targetScope = st.target.scope;
			const targetProjectId = targetScope === "project" ? normalizeConfigProjectId(projectId) : undefined;
			const catalogue = buildActivationCatalogue(targetScope, st.target.projectBase, st.target.store, packName, targetProjectId);
			if (!catalogue) { json({ error: "pack not installed at this scope" }, 404); return; }
			const cfgStore = st.target.store as unknown as ProjectConfigStore;
			const disabled = cfgStore.getPackActivation(targetScope as PackOrderScope, packName);
			json({ scope: targetScope, packName, catalogue, disabled, revision: packActivationRevision(disabled) });
			return;
		}
		if (url.pathname === "/api/marketplace/pack-activation" && req.method === "PUT") {
			const body = (await readBody(req)) as any;
			const scope = parseScope(body?.scope);
			if (!scope) { json({ error: "invalid scope" }, 400); return; }
			const packName = typeof body?.packName === "string" ? body.packName : "";
			if (!packName) { json({ error: "packName is required" }, 400); return; }
			const st = resolveScopeTarget(scope, body?.projectId);
			if (!st.ok) { json({ error: st.error }, st.status); return; }
			const targetScope = st.target.scope;
			const targetProjectId = targetScope === "project" ? normalizeConfigProjectId(body?.projectId) : undefined;
			const catalogue = buildActivationCatalogue(targetScope, st.target.projectBase, st.target.store, packName, targetProjectId);
			if (!catalogue) { json({ error: "pack not installed at this scope" }, 404); return; }
			// Normalize the requested disabled refs against the pack's declared
			// catalogue (drop refs for entities the pack does not declare).
			const reqDisabled = (body?.disabled ?? {}) as Record<string, unknown>;
			const catalogueEntrypointNames = new Set(catalogue.entrypoints.map((e) => e.listName));
			const mcpLookup = mcpContributionLookup(catalogue);
			const catalogueMcpContributionIds = new Set(mcpLookup.values());
			const cfgStore = st.target.store as unknown as ProjectConfigStore;
			const beforeActivation = cfgStore.getPackActivation(targetScope as PackOrderScope, packName);
			const cataloguePiExtensionNames = normalisePiExtensionCatalogueRefs(catalogue.piExtensions);
			const normaliseKind = (kind: "roles" | "tools" | "skills" | "entrypoints" | "providers" | "hooks" | "mcp" | "piExtensions" | "runtimes" | "workflows", valid: Set<string>): string[] => {
				const raw = reqDisabled[kind];
				if (!Array.isArray(raw)) return [];
				return raw.filter((x): x is string => typeof x === "string" && valid.has(x));
			};
			const normalizeMcpRefs = (): string[] => {
				const raw = reqDisabled.mcp;
				if (!Array.isArray(raw)) return [];
				return [...new Set(raw.flatMap((x) => typeof x === "string" ? [mcpLookup.get(x) ?? ""] : []).filter((x) => x && catalogueMcpContributionIds.has(x)))];
			};
			const normalizeMcpOperationsForCatalogue = (): Record<string, string[]> | undefined => {
				const raw = reqDisabled.mcpOperations;
				const source = raw === undefined ? beforeActivation.mcpOperations : raw;
				if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
				const out: Record<string, string[]> = {};
				for (const [rawContributionId, rawOps] of Object.entries(source)) {
					const contributionId = mcpLookup.get(rawContributionId) ?? rawContributionId;
					if (!catalogueMcpContributionIds.has(contributionId) || !Array.isArray(rawOps)) continue;
					const ops = [...new Set(rawOps.filter((x): x is string => typeof x === "string" && x.length > 0))];
					if (ops.length > 0) out[contributionId] = ops;
				}
				return Object.keys(out).length > 0 ? out : undefined;
			};
			const normalized = {
				// Explicit-enable sentinel for ships-disabled-by-default packs. Enabling
				// such a pack persists `{ enabled: true }` (an empty disabled set would
				// otherwise clear the override and fall back to the default-OFF state).
				...(reqDisabled.enabled === true ? { enabled: true as const } : {}),
				roles: normaliseKind("roles", new Set(catalogue.roles)),
				tools: normaliseKind("tools", new Set(catalogue.tools)),
				skills: normaliseKind("skills", new Set(catalogue.skills)),
				entrypoints: normaliseKind("entrypoints", catalogueEntrypointNames),
				providers: normaliseKind("providers", new Set(catalogue.providers ?? [])),
				hooks: normaliseKind("hooks", new Set(catalogue.hooks ?? [])),
				mcp: normalizeMcpRefs(),
				mcpOperations: normalizeMcpOperationsForCatalogue(),
				piExtensions: normaliseKind("piExtensions", cataloguePiExtensionNames),
				runtimes: normaliseKind("runtimes", new Set(catalogue.runtimes ?? [])),
				workflows: normaliseKind("workflows", new Set(catalogue.workflows ?? [])),
			};
			const before = beforeActivation.mcp ?? [];
			const beforeOps = beforeActivation.mcpOperations ?? {};
			cfgStore.setPackActivation(targetScope as PackOrderScope, packName, normalized);
			invalidateResolverCaches();
			const mcpChanged = JSON.stringify([...before].sort()) !== JSON.stringify([...normalized.mcp].sort()) || JSON.stringify(beforeOps) !== JSON.stringify(normalized.mcpOperations ?? {});
			const mcpReload = mcpChanged ? await reloadMcpAfterMarketplaceMutation(targetScope, targetProjectId) : undefined;
			const refreshedCatalogue = mcpChanged ? buildActivationCatalogue(targetScope, st.target.projectBase, st.target.store, packName, targetProjectId) ?? catalogue : catalogue;
			const nextDisabled = cfgStore.getPackActivation(targetScope as PackOrderScope, packName);
			json({ scope: targetScope, packName, catalogue: refreshedCatalogue, disabled: nextDisabled, revision: packActivationRevision(nextDisabled), ...(mcpReload ? { mcpReload } : {}) });
			return;
		}
		if (url.pathname === "/api/marketplace/pack-activation/mcp-operation" && req.method === "PATCH") {
			const body = (await readBody(req)) as any;
			const scope = parseScope(body?.scope);
			if (!scope) { json({ error: "invalid scope" }, 400); return; }
			const contributionId = typeof body?.contributionId === "string" ? body.contributionId : "";
			const operationName = typeof body?.operationName === "string" ? body.operationName : "";
			if (!contributionId || !operationName) { json({ error: "contributionId and operationName are required" }, 400); return; }
			if (typeof body?.disabled !== "boolean") { json({ error: "disabled must be boolean" }, 400); return; }
			const st = resolveScopeTarget(scope, body?.projectId);
			if (!st.ok) { json({ error: st.error }, st.status); return; }
			const targetScope = st.target.scope;
			const targetProjectId = targetScope === "project" ? normalizeConfigProjectId(body?.projectId) : undefined;
			let matchedPackName = "";
			let matchedCatalogue: ReturnType<typeof buildActivationCatalogue> = null;
			let matchedEntry: Record<string, unknown> | undefined;
			for (const installed of installer.listInstalled([{ scope: targetScope, projectBase: st.target.projectBase }])) {
				if (installed.scope !== targetScope || installed.status === "corrupt") continue;
				const catalogue = buildActivationCatalogue(targetScope, st.target.projectBase, st.target.store, installed.packName, targetProjectId);
				if (!catalogue) continue;
				const lookup = mcpContributionLookup(catalogue);
				if (lookup.get(contributionId) === contributionId) {
					matchedPackName = installed.packName;
					matchedCatalogue = catalogue;
					matchedEntry = (catalogue.mcp ?? []).find((entry): entry is Record<string, unknown> => {
						if (typeof entry === "string") return entry === contributionId;
						return mcpContributionLookup({ mcp: [entry] }).get(contributionId) === contributionId;
					}) as Record<string, unknown> | undefined;
					break;
				}
			}
			if (!matchedPackName || !matchedCatalogue) { json({ error: "unknown MCP contribution for scope" }, 404); return; }
			const cfgStore = st.target.store as unknown as ProjectConfigStore;
			const current = cfgStore.getPackActivation(targetScope as PackOrderScope, matchedPackName);
			const currentRevision = packActivationRevision(current);
			if (typeof body?.expectedRevision === "string" && body.expectedRevision !== currentRevision) {
				json({ error: "stale activation revision", code: "STALE_REVISION", scope: targetScope, packName: matchedPackName, contributionId, operationName, disabled: current, catalogue: matchedCatalogue, revision: currentRevision }, 409);
				return;
			}
			const operationRows = Array.isArray(matchedEntry?.operations) ? matchedEntry.operations.filter((op): op is Record<string, unknown> => !!op && typeof op === "object" && !Array.isArray(op)) : [];
			const knownOperationNames = new Set(operationRows.map((op) => safeString(op.name)).filter((name): name is string => !!name));
			const nextOps = { ...(current.mcpOperations ?? {}) };
			const currentOps = new Set(nextOps[contributionId] ?? []);
			if (!knownOperationNames.has(operationName) && !(body.disabled === false && currentOps.has(operationName))) {
				json({ error: `unknown MCP operation for contribution: ${operationName}` }, 400);
				return;
			}
			if (body.disabled) currentOps.add(operationName);
			else currentOps.delete(operationName);
			if (currentOps.size > 0) nextOps[contributionId] = [...currentOps].sort();
			else delete nextOps[contributionId];
			cfgStore.setPackActivation(targetScope as PackOrderScope, matchedPackName, {
				...current,
				mcpOperations: Object.keys(nextOps).length > 0 ? nextOps : undefined,
			});
			invalidateResolverCaches();
			const mcpReload = await reloadMcpAfterMarketplaceMutation(targetScope, targetProjectId);
			const refreshedCatalogue = buildActivationCatalogue(targetScope, st.target.projectBase, st.target.store, matchedPackName, targetProjectId) ?? matchedCatalogue;
			const nextDisabled = cfgStore.getPackActivation(targetScope as PackOrderScope, matchedPackName);
			json({ scope: targetScope, packName: matchedPackName, contributionId, operationName, disabled: nextDisabled, catalogue: refreshedCatalogue, revision: packActivationRevision(nextDisabled), ...(mcpReload ? { mcpReload } : {}) });
			return;
		}

		// ── conflicts (§4 / §9) ───────────────────────────────────
		if (url.pathname === "/api/packs/conflicts" && req.method === "GET") {
			const projectId = url.searchParams.get("projectId") || undefined;
			const conflicts: ConflictWire[] = [
				...buildConflictsFor("roles", configCascade.resolveRolesEntries(projectId)),
				...buildConflictsFor("tools", configCascade.resolveToolsEntries(projectId)),
			];
			const skillCwd = resolveSkillDiscoveryCwd(process.cwd(), projectId ?? null);
			const skillStore = resolveProjectConfigStore(projectId ?? null);
			conflicts.push(...buildConflictsFor("skills", discoverSlashSkillsResolved(skillCwd, skillStore, skillMarketContext(projectId ?? null))));
			json({ conflicts });
			return;
		}

		json({ error: "not found" }, 404);
		return;
	}

	// PUT /api/project-config — update server-scope project config fields
	if (url.pathname === "/api/project-config" && req.method === "PUT") {
		const body = await readBody(req);
		if (!body || typeof body !== "object") { json({ error: "Missing body" }, 400); return; }
		const bodyMap = body as Record<string, unknown>;

		// Reject legacy top-level qa_* keys — they have moved into
		// `components[<name>].config`.
		for (const key of LEGACY_QA_TOP_LEVEL_KEYS) {
			if (key in bodyMap) {
				json({ error: `${key} settings have moved to components[].config[]; set components[<name>].config.${key} instead` }, 400);
				return;
			}
		}

		// Native-YAML migrated fields: must be sent as structured types.
		const MIGRATED_FIELDS = [
			{ key: "config_directories", expect: "array" as const },
			{ key: "sandbox_tokens", expect: "array" as const },
		];
		const migratedExtracted: Record<string, unknown> = {};
		for (const { key, expect } of MIGRATED_FIELDS) {
			if (!(key in bodyMap)) continue;
			const v = bodyMap[key];
			if (v === null || v === "") { migratedExtracted[key] = null; delete bodyMap[key]; continue; }
			if (typeof v === "string") {
				json({ error: `Field "${key}" must be sent as a structured ${expect}, not a JSON-encoded string` }, 400);
				return;
			}
			if (expect === "array" && !Array.isArray(v)) { json({ error: `Field "${key}" must be an array` }, 400); return; }
			migratedExtracted[key] = v;
			delete bodyMap[key];
		}

		for (const [key, value] of Object.entries(bodyMap)) {
			if (key.includes(".")) {
				json({ error: `Config key "${key}" must not contain dots` }, 400);
				return;
			}
			if (value === null || value === "") {
				projectConfigStore.remove(key);
			} else if (typeof value === "string") {
				projectConfigStore.set(key, value);
			}
		}

		// Apply migrated structured fields via typed setters.
		if ("config_directories" in migratedExtracted) {
			const v = migratedExtracted.config_directories;
			if (v === null) projectConfigStore.remove("config_directories");
			else if (Array.isArray(v)) {
				projectConfigStore.setConfigDirectories(
					v.filter((e: any) => e && typeof e === "object" && typeof e.path === "string").map((e: any) => ({
						path: String(e.path),
						types: Array.isArray(e.types) ? e.types.filter((t: unknown): t is string => typeof t === "string") : [],
					})),
				);
			}
		}
		if ("sandbox_tokens" in migratedExtracted) {
			const v = migratedExtracted.sandbox_tokens;
			if (v === null) projectConfigStore.remove("sandbox_tokens");
			else if (Array.isArray(v)) {
				projectConfigStore.setSandboxTokens(
					v.filter((e: any) => e && typeof e === "object" && typeof e.key === "string").map((e: any) => ({
						key: String(e.key), enabled: e.enabled !== false,
					})),
				);
			}
		}

		json({ ok: true });
		return;
	}

	// ── Unified Model Registry ──

	// GET /api/models — unified model list from all sources
	if (url.pathname === "/api/models" && req.method === "GET") {
		try {
			const models = await getAvailableModels(preferencesStore);
			json(models);
		} catch (err: any) {
			jsonError(500, err, { error: `Failed to load models: ${err.message}` });
		}
		return;
	}

	// GET /api/image-models — image generation model list
	if (url.pathname === "/api/image-models" && req.method === "GET") {
		try {
			json(getAvailableImageModels(preferencesStore));
		} catch (err: any) {
			jsonError(500, err, { error: `Failed to load image models: ${err.message}` });
		}
		return;
	}

	// POST /api/image-generation/generate — gateway-side image generation for the generate_image tool
	if (url.pathname === "/api/image-generation/generate" && req.method === "POST") {
		const body = await readBody(req);
		if (!body || typeof body !== "object" || typeof body.prompt !== "string") {
			json({ error: "Missing prompt" }, 400);
			return;
		}
		const MAX_PROMPT_CHARS = 8192;
		if (body.prompt.length > MAX_PROMPT_CHARS) {
			json({ error: "prompt exceeds 8192 chars" }, 400);
			return;
		}
		// Clamp `n` to integer in [1,4]; reject non-integers / out-of-range.
		let n: number | undefined;
		if (body.n !== undefined && body.n !== null) {
			if (typeof body.n !== "number" || !Number.isInteger(body.n) || body.n < 1 || body.n > 4) {
				json({ error: "n must be 1..4" }, 400);
				return;
			}
			n = body.n;
		}
		const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
		// Sandbox guard: callers under a sandbox-scoped token must identify a
		// session in their scope. Without sessionId we cannot prove ownership,
		// so refuse rather than silently broadcasting credentials.
		if (sandboxScope && (!sessionId || !sandboxScope.sessionIds.has(sessionId))) {
			json({ error: "session not in sandbox scope" }, 403);
			return;
		}
		const sessionPref = sessionId ? sessionManager.getImageModelForSession(sessionId) : undefined;
		const defaultPref = (preferencesStore.get("default.imageModel") as string | undefined) || defaultImageModelPref();
		const selectedModelRaw = sessionPref ? `${sessionPref.provider}/${sessionPref.id}` : defaultPref;
		// Selector / settings default is the single source of truth. body.model is ignored
		// on purpose — never reintroduce a tool- or prompt-driven model override.
		const model = canonicalImageModelPref(selectedModelRaw) || selectedModelRaw;
		try {
			const result = await generateImage(preferencesStore, {
				prompt: body.prompt,
				model,
				size: typeof body.size === "string" ? body.size : undefined,
				quality: typeof body.quality === "string" ? body.quality : undefined,
				background: typeof body.background === "string" ? body.background : undefined,
				format: typeof body.format === "string" ? body.format : undefined,
				aspectRatio: typeof body.aspectRatio === "string" ? body.aspectRatio : undefined,
				imageSize: typeof body.imageSize === "string" ? body.imageSize : undefined,
				n,
			});
			json({
				model: { provider: result.model.provider, id: result.model.id, name: result.model.name, api: result.model.api },
				images: result.images,
			});
		} catch (err: any) {
			jsonError(500, err);
		}
		return;
	}

	// ── Custom Providers ──

	// GET /api/custom-providers — list all custom provider configs
	if (url.pathname === "/api/custom-providers" && req.method === "GET") {
		const configs = (preferencesStore.get("customProviders") as CustomProviderConfig[] | undefined) || [];
		json(configs);
		return;
	}

	// POST /api/custom-providers/test — discover models without persisting
	if (url.pathname === "/api/custom-providers/test" && req.method === "POST") {
		const body = await readBody(req);
		if (!body || !body.type || !body.baseUrl) {
			json({ error: "Missing required fields: type, baseUrl" }, 400);
			return;
		}
		const config: CustomProviderConfig = {
			id: body.id || "test-" + Date.now(),
			name: body.name || body.type,
			type: body.type,
			baseUrl: body.baseUrl,
			...(body.apiKey ? { apiKey: body.apiKey } : {}),
		};
		try {
			const models = await discoverModelsForConfig(config);
			json({ models });
		} catch (err: any) {
			jsonError(500, err);
		}
		return;
	}

	// POST /api/custom-providers — add or update a custom provider config
	if (url.pathname === "/api/custom-providers" && req.method === "POST") {
		const body = await readBody(req);
		if (!body || !body.id || !body.type || !body.baseUrl) {
			json({ error: "Missing required fields: id, type, baseUrl" }, 400);
			return;
		}
		const configs = (preferencesStore.get("customProviders") as CustomProviderConfig[] | undefined) || [];
		const existing = configs.findIndex((c: CustomProviderConfig) => c.id === body.id);
		const config: CustomProviderConfig = {
			id: body.id,
			name: body.name || body.id,
			type: body.type,
			baseUrl: body.baseUrl,
			...(body.apiKey ? { apiKey: body.apiKey } : {}),
			...(body.models ? { models: body.models } : {}),
		};
		if (existing >= 0) {
			configs[existing] = config;
		} else {
			configs.push(config);
		}
		preferencesStore.set("customProviders", configs);
		json({ ok: true, config });
		return;
	}

	// DELETE /api/custom-providers/:id — remove a custom provider config
	if (url.pathname.startsWith("/api/custom-providers/") && req.method === "DELETE") {
		const providerId = decodeURIComponent(url.pathname.slice("/api/custom-providers/".length));
		if (!providerId) {
			json({ error: "Missing provider id" }, 400);
			return;
		}
		const configs = (preferencesStore.get("customProviders") as CustomProviderConfig[] | undefined) || [];
		const filtered = configs.filter((c: CustomProviderConfig) => c.id !== providerId);
		preferencesStore.set("customProviders", filtered);
		json({ ok: true });
		return;
	}

	// ── Browser-safe pi-ai boundary ──

	// GET /api/pi-ai/providers — list built-in pi-ai provider ids without exposing the browser to pi-ai's Node-only index
	if (url.pathname === "/api/pi-ai/providers" && req.method === "GET") {
		json({ providers: getBuiltInProviderIds() });
		return;
	}

	// POST /api/pi-ai/provider-key-test — test a provider key without persisting it
	if (url.pathname === "/api/pi-ai/provider-key-test" && req.method === "POST") {
		const body = await readBody(req);
		const provider = typeof body?.provider === "string" ? body.provider.trim() : "";
		const modelId = typeof body?.modelId === "string" ? body.modelId.trim() : "";
		const key = typeof body?.key === "string" ? body.key.trim() : "";
		const result = await testProviderApiKey(provider, modelId, key);
		json(result, result.status || (result.ok ? 200 : 502));
		return;
	}

	// ── Provider Keys ──

	// GET /api/provider-keys — list providers that have keys set (no key values)
	if (url.pathname === "/api/provider-keys" && req.method === "GET") {
		const all = preferencesStore.getAll();
		const providers = Object.keys(all)
			.filter(k => k.startsWith("providerKey.") && all[k])
			.map(k => k.slice("providerKey.".length));
		json({ providers });
		return;
	}

	// POST /api/provider-keys/:provider — store a provider API key
	if (url.pathname.startsWith("/api/provider-keys/") && req.method === "POST") {
		const provider = decodeURIComponent(url.pathname.slice("/api/provider-keys/".length));
		if (!provider) {
			json({ error: "Missing provider name" }, 400);
			return;
		}
		const body = await readBody(req);
		if (!body?.key || typeof body.key !== "string") {
			json({ error: "Missing 'key' field" }, 400);
			return;
		}
		preferencesStore.set(`providerKey.${provider}`, body.key);
		json({ ok: true });
		return;
	}

	// DELETE /api/provider-keys/:provider — remove a provider API key
	if (url.pathname.startsWith("/api/provider-keys/") && req.method === "DELETE") {
		const provider = decodeURIComponent(url.pathname.slice("/api/provider-keys/".length));
		if (!provider) {
			json({ error: "Missing provider name" }, 400);
			return;
		}
		preferencesStore.remove(`providerKey.${provider}`);
		json({ ok: true });
		return;
	}

	// ── AI Gateway ──

	/**
	 * Complete the observable side effects of an already-committed AIGW models
	 * publication. Cache invalidation and client notification are independent of
	 * Docker remount recovery: a remount failure must not make the durable config
	 * mutation look rolled back or leave the UI/caches on the previous models.
	 */
	async function finalizeAigwPublication(): Promise<{ remountPending: boolean }> {
		invalidateModelCache();
		sessionManager.invalidateAigwModelCache();
		broadcastPreferencesChanged();
		try {
			await sandboxManager?.refreshAgentModelMounts();
			return { remountPending: false };
		} catch (error: any) {
			console.error("[aigw] Models/configuration committed; sandbox remount is pending normal recovery:", error?.message || error);
			return { remountPending: true };
		}
	}

	// GET /api/aigw/status — check if aigw is configured
	if (url.pathname === "/api/aigw/status" && req.method === "GET") {
		const aigwUrl = getAigwUrl(preferencesStore);
		if (!aigwUrl) {
			json({ configured: false });
		} else {
			// Discover fresh models instead of reading from preferences cache
			try {
				const models = await discoverAigwModels(aigwUrl);
				json({ configured: true, url: aigwUrl, models });
			} catch {
				json({ configured: true, url: aigwUrl, models: [] });
			}
		}
		return;
	}

	// POST /api/aigw/configure — set aigw URL, discover models, write models.json
	if (url.pathname === "/api/aigw/configure" && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.url || typeof body.url !== "string") {
			json({ error: "Missing 'url' field" }, 400);
			return;
		}
		try {
			const models = await configureAigw(body.url, preferencesStore);
			const remount = await finalizeAigwPublication();
			json({ ok: true, models, ...(remount.remountPending ? { remountPending: true } : {}) });
		} catch (err: any) {
			jsonError(502, err, { error: `Failed to configure AI Gateway: ${err.message}` });
		}
		return;
	}

	// DELETE /api/aigw/configure — remove aigw config
	if (url.pathname === "/api/aigw/configure" && req.method === "DELETE") {
		removeAigw(preferencesStore);
		const remount = await finalizeAigwPublication();
		json({ ok: true, ...(remount.remountPending ? { remountPending: true } : {}) });
		return;
	}

	// POST /api/aigw/test — test connection to a URL without saving
	if (url.pathname === "/api/aigw/test" && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.url || typeof body.url !== "string") {
			json({ error: "Missing 'url' field" }, 400);
			return;
		}
		try {
			const models = await discoverAigwModels(body.url);
			json({ ok: true, models });
		} catch (err: any) {
			jsonError(502, err);
		}
		return;
	}

	// POST /api/aigw/refresh — re-discover models from the configured gateway
	if (url.pathname === "/api/aigw/refresh" && req.method === "POST") {
		const aigwUrl = getAigwUrl(preferencesStore);
		if (!aigwUrl) {
			json({ error: "No AI Gateway configured" }, 400);
			return;
		}
		try {
			const models = await configureAigw(aigwUrl, preferencesStore);
			const remount = await finalizeAigwPublication();
			json({ models, ...(remount.remountPending ? { remountPending: true } : {}) });
		} catch (err: any) {
			jsonError(502, err);
		}
		return;
	}

	// POST /api/models/test — send a trivial "Reply with OK" completion to verify
	// that a default-model preference actually resolves and responds. Used by
	// the Settings > Models tab per-row Test button.
	if (url.pathname === "/api/models/test" && req.method === "POST") {
		const body = await readBody(req);
		const pref = typeof body?.pref === "string" ? body.pref.trim() : "";
		if (!pref) {
			json({ ok: false, error: "Missing 'pref' field" }, 400);
			return;
		}
		const slash = pref.indexOf("/");
		if (slash <= 0) {
			json({ ok: false, error: "Malformed pref — expected 'provider/modelId'" }, 400);
			return;
		}
		const normalizedPref = normalizeAigwModelString(pref);
		const normalizedSlash = normalizedPref.indexOf("/");
		const provider = normalizedPref.slice(0, normalizedSlash);
		const modelId = normalizedPref.slice(normalizedSlash + 1);
		try {
			const models = await getAvailableModels(preferencesStore);
			const resolved = models.find((m) => m.provider === provider && m.id === modelId);
			if (!resolved) {
				json({
					ok: false,
					error: `Model "${pref}" is not in the current available-models list. It may be a stale preference.`,
				}, 404);
				return;
			}
			if (provider !== "aigw") {
				const result = await testModelPreference(preferencesStore, pref);
				json(result, result.status || (result.ok ? 200 : 502));
				return;
			}
			const aigwUrl = getAigwUrl(preferencesStore);
			if (!aigwUrl) {
				json({ ok: false, error: "No AI Gateway configured." });
				return;
			}
			const baseUrl = aigwUrl.replace(/\/+$/, "");
			const modelBaseUrl = (resolved.baseUrl || baseUrl).replace(/\/+$/, "");
			if (resolved.api !== "openai-responses" && resolved.api !== "openai-completions") {
				// Converse and future provider-native APIs must be exercised through
				// pi-ai; never relabel them as a root chat-completions request.
				const result = await testModelPreference(preferencesStore, normalizedPref);
				json(result, result.status || (result.ok ? 200 : 502));
				return;
			}
			const started = Date.now();
			try {
				let resp: Response;
				let modelResolved = modelId;
				if (resolved.api === "openai-responses") {
					// Well-known AIGW entries may expose multiple OpenAI-compatible
					// providers for the same model family (e.g. /openai/v1 and
					// /aws/openai/v1). Probe the model's authoritative per-provider
					// Responses endpoint instead of the multiplexed /v1/chat/completions
					// root; otherwise models like openai.gpt-5.5 falsely fail the flask.
					resp = await fetchImpl(`${modelBaseUrl}/responses`, {
						method: "POST",
						headers: { "Content-Type": "application/json", ...aigwUserAgentHeaders() },
						body: JSON.stringify({
							model: modelId,
							max_output_tokens: 16,
							input: "Reply with OK",
						}),
						signal: AbortSignal.timeout(15000),
					});
				} else {
					resp = await fetchImpl(`${modelBaseUrl}/chat/completions`, {
						method: "POST",
						headers: { "Content-Type": "application/json", ...aigwUserAgentHeaders() },
						body: JSON.stringify({
							model: modelId,
							max_tokens: 16,
							messages: [{ role: "user", content: "Reply with OK" }],
						}),
						signal: AbortSignal.timeout(15000),
					});
				}
				const latencyMs = Date.now() - started;
				if (!resp.ok) {
					const errText = (await resp.text().catch(() => "")).slice(0, 300);
					json({ ok: false, modelResolved, latencyMs, error: `Gateway ${resp.status}: ${errText || resp.statusText}` });
					return;
				}
				// Best-effort parse; we don't require specific text content—just a successful round-trip.
				await resp.json().catch(() => ({}));
				json({ ok: true, modelResolved, latencyMs });
			} catch (err: any) {
				const latencyMs = Date.now() - started;
				json({ ok: false, modelResolved: modelId, latencyMs, error: err?.message || "Request failed" });
			}
		} catch (err: any) {
			jsonError(500, err, { ok: false, error: err?.message || "Test failed" });
		}
		return;
	}

	// Proxy: /api/aigw/v1/* → forward to configured aigw URL
	if (url.pathname.startsWith("/api/aigw/v1/") && getAigwUrl(preferencesStore)) {
		const aigwUrl = getAigwUrl(preferencesStore)!;
		const subPath = url.pathname.replace("/api/aigw/v1/", "/v1/");
		const targetUrl = `${aigwUrl}${subPath}${url.search}`;
		proxyRequest(targetUrl, req, res);
		return;
	}

	// GET /api/roles/assistant/prompts — must come before :name route
	if (url.pathname === "/api/roles/assistant/prompts" && req.method === "GET") {
		const { ASSISTANT_REGISTRY } = await import("./agent/assistant-registry.js");
		const prompts = Object.values(ASSISTANT_REGISTRY).map((def) => ({
			type: def.type,
			title: def.title,
			promptTitle: def.promptTitle,
			prompt: def.prompt,
		}));
		json({ prompts });
		return;
	}

	// PUT /api/roles/assistant/prompts/:type
	if (url.pathname.startsWith("/api/roles/assistant/prompts/") && req.method === "PUT") {
		const type = url.pathname.slice("/api/roles/assistant/prompts/".length);
		if (!type) {
			json({ error: "Missing type parameter" }, 400);
			return;
		}
		const body = await readBody(req);
		const { updateAssistantDef } = await import("./agent/assistant-registry.js");
		const updated = updateAssistantDef(type, {
			prompt: body?.prompt,
			title: body?.title,
			promptTitle: body?.promptTitle,
		});
		if (!updated) {
			json({ error: `Unknown assistant type: ${type}` }, 404);
			return;
		}
		json(updated);
		return;
	}

	// GET /api/roles (with cascade origin)
	if (url.pathname === "/api/roles" && req.method === "GET") {
		// Require an explicit projectId. `headquarters` aliases the server/global
		// scope via normalizeConfigProjectId; use only the normalized value below.
		const projectScope = resolveRequiredConfigProjectScope(url.searchParams.get("projectId"));
		if (!projectScope.ok) { writeConfigProjectScopeError(projectScope); return; }
		const effectiveConfigProjectId = projectScope.effectiveProjectId;
		const resolved = configCascade.resolveRoles(effectiveConfigProjectId);
		json({ roles: resolved.map(r => withOrigin(r as any)) });
		return;
	}

	// POST /api/roles (scope-aware: body.projectId → create in that project's store; Headquarters aliases server scope)
	if (url.pathname === "/api/roles" && req.method === "POST") {
		const body = await readBody(req);
		try {
			const resolvedTarget = resolveRoleMutationTarget(body?.projectId ?? url.searchParams.get("projectId"));
			if (!resolvedTarget.ok) { writeConfigProjectScopeError(resolvedTarget); return; }
			const target = resolvedTarget.target;
			const modelStr = typeof body?.model === "string" && body.model.trim() ? body.model.trim() : undefined;
			if (target.scope === "server") {
				const role = target.manager.createRole({
					name: body?.name,
					label: body?.label,
					promptTemplate: body?.promptTemplate || "",
					accessory: body?.accessory,
					toolPolicies: body?.toolPolicies,
					model: modelStr,
					thinkingLevel: clampRoleThinking(body?.thinkingLevel, modelStr),
				});
				json(role, 201);
			} else {
				const now = Date.now();
				const role = {
					name: body?.name,
					label: body?.label ?? body?.name,
					promptTemplate: body?.promptTemplate || "",
					accessory: body?.accessory ?? "none",
					toolPolicies: body?.toolPolicies,
					model: modelStr,
					thinkingLevel: clampRoleThinking(body?.thinkingLevel, modelStr),
					createdAt: now,
					updatedAt: now,
				};
				if (!role.name || typeof role.name !== "string") throw new Error("Missing name");
				const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
				if (!NAME_PATTERN.test(role.name)) throw new Error("Role name must be lowercase alphanumeric + hyphens");
				target.store.put(role);
				json(role, 201);
			}
		} catch (err: any) {
			jsonError(400, err);
		}
		return;
	}

	// POST /api/roles/:name/customize — copy resolved role to a target scope
	const roleCustomizeMatch = url.pathname.match(/^\/api\/roles\/([^/]+)\/customize$/);
	if (roleCustomizeMatch && req.method === "POST") {
		const name = decodeURIComponent(roleCustomizeMatch[1]);
		const scope = url.searchParams.get("scope") || "server";
		const projectScope = resolveRequiredConfigProjectScope(url.searchParams.get("projectId"), { aliasSystem: true });
		if (!projectScope.ok) { writeConfigProjectScopeError(projectScope); return; }
		const projectId = projectScope.effectiveProjectId;

		const resolved = configCascade.resolveRoles(projectId);
		const source = resolved.find(r => r.item.name === name);
		if (!source) { json({ error: "Role not found" }, 404); return; }

		let targetStore: RoleStore;
		if (scope === "project" && projectId) {
			targetStore = projectScope.context?.roleStore ?? serverRoleStore;
		} else {
			// scope === "server" (or Headquarters project scope) → system/server layer
			targetStore = serverRoleStore;
		}

		const now = Date.now();
		const copy = { ...source.item, createdAt: now, updatedAt: now };
		targetStore.put(copy);
		json(copy, 201);
		return;
	}

	// DELETE /api/roles/:name/override — remove override at a scope, reverting to inherited
	const roleOverrideMatch = url.pathname.match(/^\/api\/roles\/([^/]+)\/override$/);
	if (roleOverrideMatch && req.method === "DELETE") {
		const name = decodeURIComponent(roleOverrideMatch[1]);
		const scope = url.searchParams.get("scope") || "server";
		const projectScope = resolveRequiredConfigProjectScope(url.searchParams.get("projectId"), { aliasSystem: true });
		if (!projectScope.ok) { writeConfigProjectScopeError(projectScope); return; }
		const projectId = projectScope.effectiveProjectId;

		let targetStore: RoleStore;
		if (scope === "project" && projectId) {
			targetStore = projectScope.context?.roleStore ?? serverRoleStore;
		} else {
			// scope === "server" (or Headquarters project scope) → system/server layer
			targetStore = serverRoleStore;
		}

		targetStore.remove(name);
		json({ ok: true });
		return;
	}

	// Routes with role :name parameter
	const roleMatch = url.pathname.match(/^\/api\/roles\/([^/]+)$/);
	if (roleMatch) {
		const name = decodeURIComponent(roleMatch[1]);

		if (req.method === "GET") {
			const projectScope = resolveRequiredConfigProjectScope(url.searchParams.get("projectId"));
			if (!projectScope.ok) { writeConfigProjectScopeError(projectScope); return; }
			const effectiveConfigProjectId = projectScope.effectiveProjectId;
			const resolved = configCascade.resolveRoles(effectiveConfigProjectId);
			const found = resolved.find(r => r.item.name === name);
			if (found) {
				json(withOrigin(found as any));
			} else if (!effectiveConfigProjectId) {
				const role = roleManager.getRole(name);
				if (!role) { json({ error: "Role not found" }, 404); return; }
				json(role);
			} else {
				json({ error: "Role not found" }, 404);
			}
			return;
		}

		if (req.method === "PUT") {
			const body = await readBody(req);
			if (!body) { json({ error: "Missing body" }, 400); return; }
			const resolvedTarget = resolveRoleMutationTarget(body.projectId ?? url.searchParams.get("projectId"));
			if (!resolvedTarget.ok) { writeConfigProjectScopeError(resolvedTarget); return; }
			const target = resolvedTarget.target;
			if (target.scope === "project") {
				const existing = target.store.get(name);
				if (!existing) { json({ error: "Role not found in project" }, 404); return; }
				const validPolicies = new Set(['allow', 'ask', 'never', 'always-allow', 'ask-once', 'always-ask', 'never-ask']);
				let toolPolicies = existing.toolPolicies;
				if (body.toolPolicies !== undefined) {
					const cleaned: Record<string, any> = {};
					if (body.toolPolicies && typeof body.toolPolicies === 'object') {
						for (const [k, v] of Object.entries(body.toolPolicies)) {
							if (typeof v === 'string' && validPolicies.has(v)) cleaned[k] = v;
						}
					}
					toolPolicies = cleaned;
				}
				// model / thinkingLevel: explicit empty string clears the field; absent leaves unchanged.
				let model = existing.model;
				if (body.model !== undefined) {
					model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
				}
				let thinkingLevel = existing.thinkingLevel;
				if (body.thinkingLevel !== undefined) {
					thinkingLevel = clampRoleThinking(body.thinkingLevel, model);
				}
				const updated = {
					...existing,
					label: body.label ?? existing.label,
					promptTemplate: body.promptTemplate ?? existing.promptTemplate,
					accessory: body.accessory ?? existing.accessory,
					toolPolicies,
					model,
					thinkingLevel,
					name,
					updatedAt: Date.now(),
				};
				target.store.put(updated);
				json({ ok: true });
			} else {
				// model / thinkingLevel: explicit empty string clears the field; absent leaves unchanged.
				const modelUpdate = body.model !== undefined
					? (typeof body.model === "string" && body.model.trim() ? body.model.trim() : "")
					: undefined;
				const thinkingUpdate = body.thinkingLevel !== undefined
					? (clampRoleThinking(body.thinkingLevel, typeof modelUpdate === "string" ? modelUpdate : undefined) ?? "")
					: undefined;
				// Apply model/thinking via direct store update to support clearing (yaml-store update treats undefined as "don't change").
				if (modelUpdate !== undefined || thinkingUpdate !== undefined) {
					const existing = target.manager.getRole(name);
					if (existing) {
						const patched = {
							...existing,
							model: modelUpdate !== undefined ? (modelUpdate || undefined) : existing.model,
							thinkingLevel: thinkingUpdate !== undefined ? (thinkingUpdate || undefined) : existing.thinkingLevel,
							updatedAt: Date.now(),
						};
						target.store.put(patched);
					}
				}
				const ok = target.manager.updateRole(name, {
					label: body.label,
					promptTemplate: body.promptTemplate,
					accessory: body.accessory,
					toolPolicies: body.toolPolicies !== undefined ? (() => {
						const validPolicies = new Set(['allow', 'ask', 'never', 'always-allow', 'ask-once', 'always-ask', 'never-ask']);
						const cleaned: Record<string, import("./agent/role-store.js").GrantPolicy> = {};
						if (body.toolPolicies && typeof body.toolPolicies === 'object') {
							for (const [k, v] of Object.entries(body.toolPolicies)) {
								if (typeof v === 'string' && validPolicies.has(v)) cleaned[k] = v as import("./agent/role-store.js").GrantPolicy;
							}
						}
						return cleaned;
					})() : undefined,
				});
				if (!ok) { json({ error: "Role not found" }, 404); return; }
				json({ ok: true });
			}
			return;
		}

		if (req.method === "DELETE") {
			const resolvedTarget = resolveRoleMutationTarget(url.searchParams.get("projectId"));
			if (!resolvedTarget.ok) { writeConfigProjectScopeError(resolvedTarget); return; }
			const target = resolvedTarget.target;
			if (target.scope === "project") {
				target.store.remove(name);
				json({ ok: true });
			} else {
				const ok = target.manager.deleteRole(name);
				if (!ok) { json({ error: "Role not found" }, 404); return; }
				json({ ok: true });
			}
			return;
		}
	}

	// ── Task endpoints ─────────────────────────────────────────────

	// GET /api/goals/:goalId/tasks — list tasks for a goal
	const goalTasksMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/tasks$/);
	if (goalTasksMatch && req.method === "GET") {
		const tasks = getTaskManagerForGoal(goalTasksMatch[1]).getTasksForGoal(goalTasksMatch[1]);
		const paging = readOffsetPaging();
		const withTaskPaging = <T>(items: T[]): Record<string, unknown> => {
			if (!paging.enabled) return { tasks: items };
			const page = pageArray(items, paging);
			return { tasks: page.items, total: page.total, limit: page.limit, offset: page.offset, hasMore: page.hasMore, ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}) };
		};
		if (url.searchParams.get("view") === "summary") {
			const slim = tasks.map(t => ({
				id: t.id,
				title: t.title,
				type: t.type,
				state: t.state,
				assignedSessionId: t.assignedSessionId,
				branch: t.branch,
				headSha: t.headSha,
				workflowGateId: t.workflowGateId,
				dependsOn: t.dependsOn || [],
			}));
			json(withTaskPaging(slim));
			return;
		}
		json(withTaskPaging(tasks));
		return;
	}

	// POST /api/goals/:goalId/tasks — create a task
	if (goalTasksMatch && req.method === "POST") {
		const goalId = goalTasksMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (goal.archived) { json({ error: "Goal is archived" }, 409); return; }

		const body = await readBody(req);
		const title = body?.title;
		const type = body?.type;
		if (!title || typeof title !== "string") {
			json({ error: "Missing title" }, 400);
			return;
		}
		if (!type || typeof type !== "string") {
			json({ error: "Missing type" }, 400);
			return;
		}
		try {
			const task = getTaskManagerForGoal(goalId).createTask(goalId, title, type, {
				parentTaskId: body.parentTaskId,
				spec: body.spec,
				dependsOn: body.dependsOn,
				workflowGateId: typeof body.workflowGateId === "string" ? body.workflowGateId : undefined,
				inputGateIds: Array.isArray(body.inputGateIds) ? body.inputGateIds as string[] : undefined,
			});
			json(task, 201);
		} catch (err: any) {
			jsonError(400, err);
		}
		return;
	}

	// ── Gate endpoints ─────────────────────────────────────────────

	// GET /api/goals/:goalId/gates — list gates for a goal
	const goalGatesMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates$/);
	if (goalGatesMatch && req.method === "GET") {
		const goalId = goalGatesMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		const gateCtx = projectContextManager.getContextForGoal(goalId);
		if (!gateCtx) { json({ error: "Goal not found in any project" }, 404); return; }
		const gateStore = gateCtx.gateStore;
		const gates = gateStore.getGatesForGoal(goalId);
		// Enrich with workflow gate definitions
		const enriched = gates.map(g => {
			const def = goal.workflow?.gates.find(wg => wg.id === g.gateId);
			const base = { ...g, name: def?.name, dependsOn: def?.dependsOn, content: def?.content, injectDownstream: def?.injectDownstream, metadata: def?.metadata || g.currentMetadata, signalCount: g.signals.length };
			// Surface human-bypass audit fields as canonical top-level fields so the
			// UI does not have to couple to internal signal shape.
			if (g.status === "bypassed") {
				const bypassSignal = gateStore.getLatestBypassSignal(g);
				if (bypassSignal?.metadata) {
					return {
						...base,
						whyBypassed: bypassSignal.metadata.whyBypassed,
						whoAmI: bypassSignal.metadata.whoAmI,
						bypassedAt: bypassSignal.metadata.bypassedAt,
					};
				}
			}
			return base;
		});
		const paging = readOffsetPaging();
		const gatePagingMetadata = <T>(items: T[]): { gates: T[]; total?: number; limit?: number; offset?: number; hasMore?: boolean; nextOffset?: number } => {
			if (!paging.enabled) return { gates: items };
			const page = pageArray(items, paging);
			return { gates: page.items, total: page.total, limit: page.limit, offset: page.offset, hasMore: page.hasMore, ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}) };
		};
		if (url.searchParams.get("view") === "summary") {
			const summary = buildGateStatusSummary({
				workflow: goal.workflow,
				gates,
				activeVerifications: verificationHarness.getActiveVerifications(goalId),
			});
			const { gates: summaryGates, ...counts } = summary;
			const page = gatePagingMetadata(summaryGates);
			json({ ...page, ...counts, summary: paging.enabled ? { ...summary, gates: page.gates } : summary });
			return;
		}
		// Slim the list payload: strip inline step output / artifact bodies /
		// diagnostics. Full step text is fetched lazily on expand via the
		// gate-detail + verification-snapshot paths below.
		json(gatePagingMetadata(enriched.map(g => projectGateForList(g))));
		return;
	}

	// GET /api/goals/:goalId/gates/:gateId — gate detail
	const gateDetailMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates\/([^/]+)$/);
	if (gateDetailMatch && req.method === "GET") {
		const [, goalId, gateId] = gateDetailMatch;
		const gateDetailCtx = projectContextManager.getContextForGoal(goalId);
		if (!gateDetailCtx) { json({ error: "Goal not found in any project" }, 404); return; }
		const gateStore = gateDetailCtx.gateStore;
		const gate = gateStore.getGate(goalId, gateId);
		if (!gate) { json({ error: "Gate not found" }, 404); return; }
		const goal = getGoalAcrossProjects(goalId);
		const def = goal?.workflow?.gates.find(wg => wg.id === gateId);
		if (url.searchParams.get("view") === "summary") {
			const latestSignal = gate.signals[gate.signals.length - 1];
			const slim: Record<string, unknown> = {
				goalId,
				gateId: gate.gateId,
				name: def?.name,
				status: gate.status,
				dependsOn: def?.dependsOn || [],
				signalCount: gate.signals.length,
				updatedAt: gate.updatedAt,
				hasContent: !!gate.currentContent,
				contentLength: gate.currentContent?.length || 0,
			};
			if (gate.currentMetadata) slim.currentMetadata = gate.currentMetadata;
			if (latestSignal) {
				const verificationSnapshot = latestSignal.verification ? buildGateVerificationSnapshot({
					goalId,
					gateId,
					signalId: latestSignal.id,
					verification: latestSignal.verification,
					activeVerification: verificationHarness.getActiveVerification(latestSignal.id),
					isActiveVerificationAlive: verificationHarness.areVerificationSessionsAlive(latestSignal.id),
					selectionOptions: { implicitDefault: true },
				}) : undefined;
				slim.latestSignal = {
					id: latestSignal.id,
					sessionId: latestSignal.sessionId,
					timestamp: latestSignal.timestamp,
					commitSha: latestSignal.commitSha,
					verification: verificationSnapshot ? {
						status: verificationSnapshot.status,
						summary: verificationSnapshot.summary,
						counts: verificationSnapshot.counts,
						active: verificationSnapshot.active,
						stale: verificationSnapshot.stale,
						steps: verificationSnapshot.steps,
						selection: verificationSnapshot.selection,
					} : undefined,
				};
			}
			json(slim);
			return;
		}
		json({ ...gate, name: def?.name, dependsOn: def?.dependsOn, content: def?.content, injectDownstream: def?.injectDownstream });
		return;
	}

	// GET /api/goals/:goalId/gates/:gateId/inspect — scoped gate data retrieval
	const gateInspectMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates\/([^/]+)\/inspect$/);
	if (gateInspectMatch && req.method === "GET") {
		const [, goalId, gateId] = gateInspectMatch;
		const ctx = projectContextManager.getContextForGoal(goalId);
		if (!ctx) { json({ error: "Goal not found" }, 404); return; }
		const gate = ctx.gateStore.getGate(goalId, gateId);
		if (!gate) { json({ error: "Gate not found" }, 404); return; }

		const section = url.searchParams.get("section");
		if (!section || !["content", "verification", "signals", "artifact"].includes(section)) {
			json({ error: "section query parameter is required: 'content', 'verification', 'signals', or 'artifact'" }, 400);
			return;
		}

		const stepName = url.searchParams.get("step") ?? undefined;
		if (stepName !== undefined && section !== "verification" && section !== "artifact") {
			json({ error: "step is only valid with section='verification' or section='artifact'" }, 400);
			return;
		}
		if (url.searchParams.has("retry") && section !== "artifact") {
			json({ error: "retry is only valid with section='artifact'" }, 400);
			return;
		}

		let selectionOptions: TextSelectionOptions;
		try {
			selectionOptions = { ...parseGateInspectSelectionOptions(url.searchParams), includeDiagnostics: true };
			if (section === "artifact" && selectionOptions.mode === undefined) {
				selectionOptions = { ...selectionOptions, mode: "tail", lines: selectionOptions.lines ?? 200 };
			}
			selectText("", selectionOptions);
		} catch (err) {
			if (err instanceof TextSelectionError) { json({ error: err.message }, 400); return; }
			throw err;
		}

		const resolveSignal = () => {
			const idxStr = url.searchParams.get("signal_index");
			let idx = idxStr !== null ? parseInt(idxStr, 10) : -1;
			if (isNaN(idx)) idx = -1;
			if (idx < 0) idx = gate.signals.length + idx;
			if (idx < 0 || idx >= gate.signals.length) return null;
			return { signal: gate.signals[idx], index: idx };
		};

		if (section === "content") {
			const resolved = resolveSignal();
			if (!resolved) { json({ error: "Signal not found" }, 404); return; }
			try {
				const rawText = resolved.signal.content || "";
				const selected = selectText(rawText, selectionOptions);
				json({
					gateId, section: "content",
					signalIndex: resolved.index,
					signalId: resolved.signal.id,
					text: resolved.signal.content ? selected.text : null,
					selection: selected.selection,
				});
			} catch (err) {
				if (err instanceof TextSelectionError) { json({ error: err.message }, 400); return; }
				throw err;
			}
			return;
		}

		if (section === "verification") {
			const resolved = resolveSignal();
			if (!resolved) { json({ error: "Signal not found" }, 404); return; }
			try {
				const snapshot = buildGateVerificationSnapshot({
					goalId,
					gateId,
					signalId: resolved.signal.id,
					verification: resolved.signal.verification,
					activeVerification: verificationHarness.getActiveVerification(resolved.signal.id),
					isActiveVerificationAlive: verificationHarness.areVerificationSessionsAlive(resolved.signal.id),
					selectionOptions,
					stepName,
				});
				json({
					gateId, section: "verification",
					signalIndex: resolved.index,
					signalId: resolved.signal.id,
					status: snapshot.status,
					summary: snapshot.summary,
					counts: snapshot.counts,
					active: snapshot.active,
					stale: snapshot.stale,
					steps: snapshot.steps,
					selection: snapshot.selection,
				});
			} catch (err) {
				if (err instanceof TextSelectionError) { json({ error: err.message }, 400); return; }
				if (err instanceof UnknownVerificationStepError) { json({ error: err.message }, 400); return; }
				throw err;
			}
			return;
		}

		if (section === "artifact") {
			const resolved = resolveSignal();
			if (!resolved) { json({ error: "Signal not found" }, 404); return; }
			const artifactTarget = url.searchParams.get("artifact") ?? "";
			if (!artifactTarget) {
				json({ error: "artifact query parameter is required with section='artifact'" }, 400);
				return;
			}
			let retry: number | undefined;
			const rawRetry = url.searchParams.get("retry");
			if (rawRetry !== null && rawRetry !== "") {
				if (!/^\d+$/.test(rawRetry)) { json({ error: "retry must be a non-negative integer" }, 400); return; }
				retry = Number(rawRetry);
			}

			const candidateSteps = resolved.signal.verification.steps.filter(step =>
				step.type === "command"
				&& step.diagnostics
				&& step.diagnostics.artifacts
				&& step.diagnostics.artifacts.length > 0
				&& (stepName === undefined || step.name === stepName),
			);
			if (stepName !== undefined && candidateSteps.length === 0) {
				json({
					error: `Unknown verification step "${stepName}" with retained artifacts.`,
					validSteps: resolved.signal.verification.steps
						.filter(step => step.type === "command" && step.diagnostics?.artifacts?.length)
						.map(step => step.name),
				}, 400);
				return;
			}

			const matches: Array<{ stepName: string; diagnostics: NonNullable<typeof candidateSteps[number]["diagnostics"]>; artifact: ReturnType<typeof resolveArtifactFromLookup> }> = [];
			const resolutionErrors: Array<{ stepName: string; error: GateArtifactResolutionError }> = [];
			const validSteps = candidateSteps.map(step => step.name);
			const validArtifactsByStep = candidateSteps.map(step => {
				const lookup = buildArtifactLookup(step.diagnostics);
				return {
					step: step.name,
					validArtifactIds: [...new Set(lookup.index.files.map(file => file.id))],
					validArtifacts: lookup.index.files.map(file => ({ id: file.id, relativePath: file.relativePath, retry: file.retry })),
				};
			});
			for (const step of candidateSteps) {
				if (!step.diagnostics) continue;
				const lookup = buildArtifactLookup(step.diagnostics);
				try {
					matches.push({
						stepName: step.name,
						diagnostics: step.diagnostics,
						artifact: resolveArtifactFromLookup(lookup, artifactTarget, retry),
					});
				} catch (err) {
					if (!(err instanceof GateArtifactResolutionError)) throw err;
					resolutionErrors.push({ stepName: step.name, error: err });
				}
			}

			if (matches.length === 0) {
				const nonUnknownError = resolutionErrors.find(({ error }) => !error.message.startsWith(`Unknown artifact "${artifactTarget}".`));
				json({ error: nonUnknownError?.error.message ?? `Unknown artifact "${artifactTarget}".`, validSteps, validArtifactsByStep }, 400);
				return;
			}
			if (matches.length > 1) {
				json({
					error: `Artifact "${artifactTarget}" is ambiguous across verification steps; pass step to disambiguate.`,
					validSteps: matches.map(match => match.stepName),
					validArtifacts: matches.map(match => ({ step: match.stepName, id: match.artifact.id, relativePath: match.artifact.relativePath, retry: match.artifact.retry })),
				}, 400);
				return;
			}

			const match = matches[0];
			try {
				const retainedPath = validateRetainedArtifactPath(match.diagnostics, match.artifact);
				if (!isTextInspectableArtifact(match.artifact)) {
					json({ error: `Artifact "${match.artifact.relativePath}" is not a text artifact; use read(path) or inspect the file directly.`, validSteps, validArtifactsByStep }, 400);
					return;
				}
				let text = fs.readFileSync(retainedPath, "utf8");
				if (match.artifact.relativePath.endsWith("/error-context.md") || match.artifact.relativePath === "error-context.md") {
					text = stripPlaywrightErrorContextBoilerplate(text);
				}
				const selected = selectText(text, selectionOptions);
				json({
					gateId, section: "artifact",
					signalIndex: resolved.index,
					signalId: resolved.signal.id,
					step: match.stepName,
					artifact: match.artifact,
					text: selected.text,
					selection: selected.selection,
				});
			} catch (err) {
				if (err instanceof TextSelectionError) { json({ error: err.message }, 400); return; }
				if (err instanceof Error) { json({ error: err.message, validSteps, validArtifactsByStep }, 400); return; }
				throw err;
			}
			return;
		}

		if (section === "signals") {
			const summaries = gate.signals.map((s, i) => ({
				index: i,
				id: s.id,
				timestamp: s.timestamp,
				sessionId: s.sessionId,
				commitSha: s.commitSha,
				verdict: s.verification?.status || "running",
				hasContent: !!s.content,
				metadataKeys: s.metadata ? Object.keys(s.metadata) : [],
			}));
			try {
				const rendered = summaries.map(s => JSON.stringify(s)).join("\n");
				const selected = selectText(rendered, selectionOptions);
				const selectedLines = new Set(selected.selectedLineNumbers);
				const signals = summaries.filter((_, i) => selectedLines.has(i + 1));
				json({
					gateId, section: "signals",
					signals,
					signalsTotal: summaries.length,
					signalsShown: signals.length,
					signalsTruncated: signals.length < summaries.length,
					text: selected.text,
					selection: selected.selection,
				});
			} catch (err) {
				if (err instanceof TextSelectionError) { json({ error: err.message }, 400); return; }
				throw err;
			}
			return;
		}
	}

	// POST /api/goals/:goalId/gates/:gateId/reset — reset a gate and downstream dependents
	const gateResetMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates\/([^/]+)\/reset$/);
	if (gateResetMatch && req.method === "POST") {
		if (sandboxScope) {
			json({ error: "Forbidden: sandbox token cannot reset gates" }, 403);
			return;
		}

		const [, goalId, gateId] = gateResetMatch;
		const gateResetCtx = projectContextManager.getContextForGoal(goalId);
		if (!gateResetCtx) { json({ error: "Goal not found in any project" }, 404); return; }
		const rejectDormantGoal = (candidate: PersistedGoal): boolean => {
			if (candidate.archived) {
				json({ error: "Goal is archived" }, 409);
				return true;
			}
			if (candidate.state === "shelved") {
				json({ error: "Goal is shelved", code: "GOAL_SHELVED", goalId }, 409);
				return true;
			}
			if (candidate.paused) {
				json({ error: `Goal ${goalId} is paused`, code: "GOAL_PAUSED", goalId }, 409);
				return true;
			}
			return false;
		};

		const initialGoal = gateResetCtx.goalStore.get(goalId);
		if (!initialGoal) { json({ error: "Goal not found" }, 404); return; }
		if (rejectDormantGoal(initialGoal)) return;
		if (!initialGoal.workflow) { json({ error: "Goal has no workflow" }, 400); return; }
		if (!initialGoal.workflow.gates.some(g => g.id === gateId)) {
			json({ error: `Unknown gate: ${gateId}` }, 404);
			return;
		}

		const affectedGateIds = getGateAndTransitiveDependents(initialGoal.workflow, gateId);
		try {
			await verificationHarness.cancelStaleVerificationsForGates(goalId, affectedGateIds);
		} catch (err) {
			console.error(`[api] Error cancelling verifications for reset gates ${affectedGateIds.join(", ")}:`, err);
		}

		// Cancellation is awaited, so re-read the project-owned record and reapply
		// dormant guards before mutating either persistence store.
		const goal = gateResetCtx.goalStore.get(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (rejectDormantGoal(goal)) return;
		if (!goal.workflow) { json({ error: "Goal has no workflow" }, 400); return; }
		const requestedGateDef = goal.workflow.gates.find(g => g.id === gateId);
		if (!requestedGateDef) { json({ error: `Unknown gate: ${gateId}` }, 404); return; }

		// The project-scoped write-ahead intent is durable before either store
		// changes. Both store mutations use fail-loud atomic writes; boot replay is
		// idempotent at every phase of intent -> goal -> gates -> clear.
		const initialPreviousStatuses: Record<string, GateStatus> = {};
		for (const affectedGateId of getGateAndTransitiveDependents(goal.workflow, gateId)) {
			initialPreviousStatuses[affectedGateId] = gateResetCtx.gateStore.getGate(goalId, affectedGateId)?.status ?? "pending";
		}

		let intent: GateResetIntent;
		let resumedIntent = false;
		try {
			const begun = gateResetCtx.gateResetCoordinator.begin({
				goalId,
				gateId,
				affectedGateIds: Object.keys(initialPreviousStatuses),
				previousStatuses: initialPreviousStatuses,
				previousState: goal.state,
				reopenRequired: goal.state === "complete",
			});
			intent = begun.intent;
			resumedIntent = begun.resumed;
		} catch (err) {
			console.error(`[api] Failed to persist gate-reset intent ${goalId}/${gateId}:`, err);
			json({ error: "Failed to prepare gate reset", code: "GATE_RESET_PREPARE_FAILED", retryable: true }, 500);
			return;
		}

		let resetResult: GateResetResult;
		try {
			resetResult = gateResetCtx.gateResetCoordinator.commitDurable(intent, goal.workflow);
		} catch (err) {
			// A synchronous failure is compensated when both rollback writes work.
			// If compensation itself fails, the retained intent remains the source of
			// truth and boot recovery safely completes the operation.
			try {
				gateResetCtx.gateResetCoordinator.abort(intent);
			} catch (abortErr) {
				console.error(`[api] Failed to abort gate reset ${goalId}/${gateId}; recovery intent retained:`, abortErr);
			}
			console.error(`[api] Failed to reset gate ${goalId}/${gateId}:`, err);
			json({ error: "Failed to reset gate", code: "GATE_RESET_PERSIST_FAILED", retryable: true }, 500);
			return;
		}

		// A retry after runtime/intent-clear failure reports the original durable
		// reset scope rather than the idempotent replay's now-empty changed set.
		if (resumedIntent) {
			const changedGateIds = intent.affectedGateIds.filter(id => intent.previousStatuses[id] !== "pending");
			resetResult = {
				requestedGateId: intent.gateId,
				affectedGateIds: intent.affectedGateIds,
				changedGateIds,
				unchangedGateIds: intent.affectedGateIds.filter(id => !changedGateIds.includes(id)),
				previousStatuses: intent.previousStatuses,
			};
		}

		const previousState = intent.previousState;
		const reopened = intent.reopenRequired;
		const reopen: GateResetReopenOutcome = {
			reopened,
			previousState,
			state: reopened ? "in-progress" : previousState,
		};

		let lifecycleError: { message: string; code: string; status: number } | undefined;
		if (reopened && !gateResetCtx.gateResetCoordinator.intents.wasRuntimeRearmed(intent)) {
			const team = teamManager.getTeamState(goalId);
			if (!team) {
				// `goal.team` records capability, not a live runtime. Explicit teardown
				// leaves completed goals resettable without creating a replacement team.
				gateResetCtx.gateResetCoordinator.intents.markRuntimeRearmed(intent);
			} else {
				try {
					// TeamManager owns the existing lead/team runtime rearm. A false result
					// for an actual team is a controlled, retryable failure; retaining the
					// intent ensures the next reset request tries again.
					const rearmed = teamManager.reopenCompletedTeam(goalId);
					if (!rearmed) {
						lifecycleError = { message: "Goal reopened, but its team runtime could not be rearmed", code: "TEAM_REOPEN_FAILED", status: 503 };
					} else {
						gateResetCtx.gateResetCoordinator.intents.markRuntimeRearmed(intent);
					}
				} catch (err) {
					console.error(`[api] Failed to rearm completed team ${goalId}:`, err);
					lifecycleError = { message: "Goal reopened, but its team runtime could not be rearmed", code: "TEAM_REOPEN_FAILED", status: 503 };
				}
			}
		}

		if (!lifecycleError) {
			try {
				gateResetCtx.gateResetCoordinator.complete(intent);
			} catch (err) {
				console.error(`[api] Gate reset committed but intent clear failed ${goalId}/${gateId}:`, err);
				lifecycleError = { message: "Gate reset committed but finalization failed", code: "GATE_RESET_FINALIZE_FAILED", status: 500 };
			}
		}

		if (reopened && !resumedIntent) {
			broadcastToAll({ type: "goal_state_changed", goalId });
		}

		const affectedGates = resetResult.affectedGateIds.map(affectedGateId => {
			const def = goal.workflow!.gates.find(g => g.id === affectedGateId);
			const state = gateResetCtx.gateStore.getGate(goalId, affectedGateId);
			return {
				gateId: affectedGateId,
				name: def?.name || affectedGateId,
				status: state?.status || "pending",
			};
		});

		if (!resumedIntent) {
			for (const gate of affectedGates) {
				broadcastGateStatusChanged(broadcastToGoal, goalId, gate.gateId, gate.status);
			}
			broadcastToGoal(goalId, {
				type: "gate_reset",
				goalId,
				gateId,
				affectedGateIds: resetResult.affectedGateIds,
				changedGateIds: resetResult.changedGateIds,
				unchangedGateIds: resetResult.unchangedGateIds,
				reopen,
			});
		}

		const gateNameById = new Map(goal.workflow.gates.map(g => [g.id, g.name || g.id]));
		const namesFor = (ids: string[]) => ids.map(id => `- ${gateNameById.get(id) || id}`);
		const downstreamIds = resetResult.affectedGateIds.filter(id => id !== gateId);
		const clearedPassedIds = resetResult.affectedGateIds.filter(id => resetResult.previousStatuses[id] === "passed");
		const alreadyNotPassedIds = resetResult.affectedGateIds.filter(id => resetResult.previousStatuses[id] !== "passed");
		const notificationLines = [
			`Gate reset: ${requestedGateDef.name || gateId}`,
			"",
			"Reset by user action from the goal status widget.",
			"",
			"Goal lifecycle:",
			reopened
				? `- Reopened from ${previousState} to ${reopen.state}.`
				: `- Remained ${reopen.state}; no reopen transition was needed.`,
			"",
			"Selected gate:",
			`- ${requestedGateDef.name || gateId}`,
			"",
			"Invalidated dependent gates:",
			...(downstreamIds.length ? namesFor(downstreamIds) : ["- None"]),
			"",
			"Cleared passed state:",
			...(clearedPassedIds.length ? namesFor(clearedPassedIds) : ["- None"]),
			"",
			"Already not passed but included in reset scope:",
			...(alreadyNotPassedIds.length ? namesFor(alreadyNotPassedIds) : ["- None"]),
			"",
			"Why this matters:",
			"Downstream work may have relied on outputs from the reset gate. Please revisit dependent implementation, review, or verification work before continuing.",
		];
		const notification = notificationLines.join("\n");

		let teamLeadNotified = false;
		const shouldNotifyTeamLead = !resumedIntent && (reopened || resetResult.changedGateIds.length > 0);
		const team = shouldNotifyTeamLead ? teamManager.getTeamState(goalId) : undefined;
		if (team?.teamLeadSessionId) {
			const teamLeadSession = sessionManager.getSession(team.teamLeadSessionId);
			if (teamLeadSession && teamLeadSession.status !== "terminated") {
				try {
					if (teamLeadSession.status === "streaming") {
						await sessionManager.deliverLiveSteer(team.teamLeadSessionId, notification, { source: "system" });
					} else {
						await sessionManager.enqueuePrompt(team.teamLeadSessionId, notification, { isSteered: true, source: "system" });
					}
					teamLeadNotified = true;
				} catch (err) {
					console.error(`[api] Failed to notify team lead for gate reset ${goalId}/${gateId}:`, err);
				}
			}
		}

		if (lifecycleError) {
			json({
				error: lifecycleError.message,
				code: lifecycleError.code,
				retryable: true,
				durableReset: true,
				reopen,
			}, lifecycleError.status);
			return;
		}

		json({
			ok: true,
			gateId,
			affectedGateIds: resetResult.affectedGateIds,
			changedGateIds: resetResult.changedGateIds,
			unchangedGateIds: resetResult.unchangedGateIds,
			previousStatuses: resetResult.previousStatuses,
			gates: affectedGates,
			reopen,
			teamLeadNotified,
		});
		return;
	}

	// POST /api/goals/:goalId/gates/:gateId/bypass — human-only gate bypass.
	// NOT advertised to agents: no MCP tool, no prompt/doc mention. The
	// isInitiatedByHuman guard is the runtime backstop. Modeled on the reset
	// endpoint above.
	const gateBypassMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates\/([^/]+)\/bypass$/);
	if (gateBypassMatch && req.method === "POST") {
		if (sandboxScope) {
			json({ error: "Forbidden: sandbox token cannot bypass gates" }, 403);
			return;
		}

		const [, goalId, gateId] = gateBypassMatch;
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (goal.archived) { json({ error: "Goal is archived" }, 409); return; }
		if (goal.state === "shelved") { json({ error: "Goal is shelved" }, 409); return; }
		if (!goal.workflow) { json({ error: "Goal has no workflow" }, 400); return; }

		const gateBypassCtx = projectContextManager.getContextForGoal(goalId);
		if (!gateBypassCtx) { json({ error: "Goal not found in any project" }, 404); return; }
		const gateStore = gateBypassCtx.gateStore;
		const bypassGateDef = goal.workflow.gates.find(g => g.id === gateId);
		if (!bypassGateDef) { json({ error: `Unknown gate: ${gateId}` }, 404); return; }

		const bypassBody = await readBody(req);
		if (bypassBody?.isInitiatedByHuman !== true) {
			json({ error: "This method is currently intended for human use only. Bypassing a gate as an agent is not acting in the best interest of the outcome." }, 400);
			return;
		}
		const whyBypassed = bypassBody?.whyBypassed;
		const whoAmI = bypassBody?.whoAmI;
		if (typeof whyBypassed !== "string" || !whyBypassed.trim()) { json({ error: "whyBypassed is required" }, 400); return; }
		if (typeof whoAmI !== "string" || !whoAmI.trim()) { json({ error: "whoAmI is required" }, 400); return; }

		try {
			await verificationHarness.cancelStaleVerificationsForGates(goalId, [gateId]);
		} catch (err) {
			console.error(`[api] Error cancelling verifications for bypassed gate ${gateId}:`, err);
		}

		const bypassSignal = gateStore.bypassGate(goalId, gateId, { whyBypassed, whoAmI });
		const bypassedAt = bypassSignal.metadata?.bypassedAt ?? String(bypassSignal.timestamp);

		broadcastGateStatusChanged(broadcastToGoal, goalId, gateId, "bypassed");

		let teamLeadNotified = false;
		try {
			const notification = [
				`Gate bypassed: ${bypassGateDef.name || gateId}`,
				"",
				`This gate was forced past verification by a human overseer (${whoAmI}).`,
				"",
				"Reason:",
				whyBypassed,
				"",
				"The bypassed gate now counts as satisfied for dependency ordering, but the goal still requires explicit human confirmation before it can be completed.",
			].join("\n");
			const team = teamManager.getTeamState(goalId);
			if (team?.teamLeadSessionId) {
				const teamLeadSession = sessionManager.getSession(team.teamLeadSessionId);
				if (teamLeadSession && teamLeadSession.status !== "terminated") {
					if (teamLeadSession.status === "streaming") {
						await sessionManager.deliverLiveSteer(team.teamLeadSessionId, notification, { source: "system" });
					} else {
						await sessionManager.enqueuePrompt(team.teamLeadSessionId, notification, { isSteered: true, source: "system" });
					}
					teamLeadNotified = true;
				}
			}
		} catch (err) {
			console.error(`[api] Failed to notify team lead for gate bypass ${goalId}/${gateId}:`, err);
		}

		json({ ok: true, gateId, status: "bypassed", whyBypassed, whoAmI, bypassedAt, teamLeadNotified });
		return;
	}

	// POST /api/goals/:goalId/gates/:gateId/signal — signal a gate
	const gateSignalMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates\/([^/]+)\/signal$/);
	if (gateSignalMatch && req.method === "POST") {
		const [, goalId, gateId] = gateSignalMatch;
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (goal.archived) { json({ error: "Goal is archived" }, 409); return; }
		// Pause-cascade: a paused goal must reject gate signals. This is the
		// most upstream block for both llm-review-* verifier spawns and
		// command/qa-step kickoffs in the same handler chain.
		if (goal.paused) { json({ error: `Goal ${goalId} is paused`, code: "GOAL_PAUSED", goalId }, 409); return; }
		if (!goal.workflow) { json({ error: "Goal has no workflow" }, 400); return; }
		const gateSignalCtx = projectContextManager.getContextForGoal(goalId);
		if (!gateSignalCtx) { json({ error: "Goal not found in any project" }, 404); return; }
		const gateStore = gateSignalCtx.gateStore;
		const gateDef = goal.workflow.gates.find(g => g.id === gateId);
		if (!gateDef) { json({ error: `Unknown gate: ${gateId}` }, 404); return; }

		const body = await readBody(req);
		const signalSessionId = body?.sessionId || "unknown";

		// Validate dependencies are met
		for (const depId of gateDef.dependsOn) {
			const depGate = gateStore.getGate(goalId, depId);
			// A bypassed upstream gate counts as satisfied (like passed).
			if (!depGate || (depGate.status !== "passed" && depGate.status !== "bypassed")) {
				const depDef = goal.workflow.gates.find(g => g.id === depId);
				json({ error: `Upstream gate "${depDef?.name || depId}" has not passed yet` }, 409);
				return;
			}
		}

		// Validate metadata against gate's schema
		if (gateDef.metadata && body?.metadata) {
			for (const key of Object.keys(gateDef.metadata)) {
				if (!(key in body.metadata)) {
					json({ error: `Missing required metadata field: ${key}` }, 400);
					return;
				}
			}
		} else if (gateDef.metadata && !body?.metadata) {
			const required = Object.keys(gateDef.metadata);
			if (required.length > 0) {
				json({ error: `Missing required metadata fields: ${required.join(", ")}` }, 400);
				return;
			}
		}

		// Gov-2: an ACCEPTED signal of the `goal-plan` gate on a parent-workflow
		// goal FREEZES the execution gate's verify[] (sets
		// execution.metadata.frozen = "true" durably on the goal's workflow
		// snapshot). Applied here — after dependency/metadata validation has
		// passed (so a rejected signal never freezes) but before the
		// cache/dup early-return branches (so the freeze is durable even when
		// the signal short-circuits to a cached pass). Idempotent: re-signal is
		// a harmless no-op write. After this, GET /api/goals/:id/plan reports
		// frozen:true. See src/server/agent/parent-workflow-freeze.ts.
		const freezeResult = computePlanFreezeUpdate(goal, gateId);
		if (freezeResult.freeze && freezeResult.workflow) {
			// Persist via the goal store's `update` (same path applyPlanSteps
			// uses) — `updateGoal`'s partial type does not expose `workflow`.
			gateSignalCtx.goalManager.getGoalStore().update(goalId, { workflow: freezeResult.workflow });
			goal.workflow = freezeResult.workflow;
		}

		// Get commit SHA
		let commitSha = "unknown";
		try {
			commitSha = await execGitSafe("git rev-parse HEAD", goal.cwd, "unknown");
		} catch { /* ignore */ }

		// Reject if verification is already running for this gate+commit
		if (commitSha !== "unknown") {
			const activeVers = verificationHarness.getActiveVerifications(goalId);
			const runningDup = activeVers.find(v => {
				if (v.gateId !== gateId || v.overallStatus !== "running") return false;
				const gs = gateStore.getGate(goalId, gateId);
				const s = gs?.signals.find(s => s.id === v.signalId);
				return s?.commitSha === commitSha;
			});
			if (runningDup) {
				// Check if sessions are actually alive — auto-cancel zombies
				const alive = verificationHarness.areVerificationSessionsAlive(runningDup.signalId);
				if (!alive) {
					console.log(`[api] Auto-cancelling zombie verification ${runningDup.signalId} for gate ${gateId}`);
					await verificationHarness.cancelStaleVerifications(goalId, gateId);
					// Fall through to create new signal
				} else {
					// Surface the step states so a future 409 is diagnosable from
					// logs alone — see goal "Unstick verification lock on restart".
					const stepSummary = runningDup.steps.map((s: any) => ({
						name: s.name,
						status: s.status,
						pid: s.pid,
						bootEpoch: s.bootEpoch,
						sessionId: s.sessionId,
					}));
					console.warn(`[api] Rejecting gate_signal as duplicate: gate=${gateId} signalId=${runningDup.signalId} aliveCheck=true steps=${JSON.stringify(stepSummary)}`);
					json({ error: "Verification already in progress for this commit", existingSignalId: runningDup.signalId }, 409);
					return;
				}
			}
		}

		// Auto-pass if a prior signal for the same commit already fully passed.
		// The extracted decision core owns cache-boundary and response semantics so
		// this route cannot drift from its deterministic store-level coverage.
		const cachedResponse = reuseCachedGateSignal({
			gateStore,
			goalId,
			gate: gateDef,
			commitSha,
			body,
			notifier: {
				signalReceived: (notifiedGoalId, notifiedGateId, signalId) => {
					broadcastToGoal(notifiedGoalId, { type: "gate_signal_received", goalId: notifiedGoalId, gateId: notifiedGateId, signalId });
				},
				verificationComplete: (notifiedGoalId, notifiedGateId, signalId, status) => {
					broadcastToGoal(notifiedGoalId, { type: "gate_verification_complete", goalId: notifiedGoalId, gateId: notifiedGateId, signalId, status });
				},
				statusChanged: (notifiedGoalId, notifiedGateId, status) => {
					broadcastGateStatusChanged(broadcastToGoal, notifiedGoalId, notifiedGateId, status);
				},
			},
		});
		if (cachedResponse) {
			json(cachedResponse, 201);
			return;
		}

		// Compute content version
		const existingGate = gateStore.getGate(goalId, gateId);
		const contentVersion = body?.content ? (existingGate?.currentContentVersion || 0) + 1 : undefined;

		// Check if this is a re-signal of a passed gate — cascade reset
		if (existingGate && existingGate.status === "passed") {
			gateStore.cascadeReset(goalId, gateId, goal.workflow);
			// Broadcast resets for downstream gates
			for (const g of goal.workflow.gates) {
				if (g.dependsOn.includes(gateId) || hasTransitiveDep(goal.workflow, g.id, gateId)) {
					const downstream = gateStore.getGate(goalId, g.id);
					if (downstream) {
						broadcastGateStatusChanged(broadcastToGoal, goalId, g.id, downstream.status);
					}
				}
			}
		}

		// Cancel any in-flight verifications for the same gate BEFORE seeding
		// the new one — otherwise cancelStaleVerifications would observe and
		// tear down the just-seeded active entry.
		await verificationHarness.cancelStaleVerifications(goalId, gateId);

		// Create signal record. Step enumeration is performed synchronously
		// via `beginVerification` BEFORE `recordSignal` so the gate-store and
		// `activeVerifications` agree on the step list from the very first
		// persisted state. See goal "Fix verification progress race".
		const signalId = randomUUID();
		const signal = {
			id: signalId,
			gateId,
			goalId,
			sessionId: signalSessionId,
			timestamp: Date.now(),
			commitSha,
			metadata: body?.metadata,
			content: body?.content,
			contentVersion,
			verification: { status: "running" as const, steps: [] as any[] },
		};

		const initialSteps = verificationHarness.beginVerification(signal as any, gateDef);
		signal.verification = { status: "running", steps: initialSteps };

		gateStore.recordSignal(signal);

		// Update gate content/metadata if provided
		if (body?.content && contentVersion) {
			gateStore.updateGateContent(goalId, gateId, body.content, contentVersion);
		}
		if (body?.metadata) {
			gateStore.updateGateMetadata(goalId, gateId, body.metadata);
		}

		// Broadcast signal received
		broadcastToGoal(goalId, { type: "gate_signal_received", goalId, gateId, signalId: signal.id });

		// Broadcast verification started AFTER signal received — WS clients
		// depend on this ordering (see tests/e2e/verification-core.spec.ts
		// "WS events have correct shape, timestamps, and ordering"). The
		// `gate_verification_started` event used to be fired synchronously
		// inside `beginVerification` which inverted the order on the wire.
		const activeForBroadcast = verificationHarness.getActiveVerification(signal.id);
		if (activeForBroadcast && initialSteps.length > 0) {
			broadcastToGoal(goalId, {
				type: "gate_verification_started",
				goalId,
				gateId,
				signalId: signal.id,
				startedAt: activeForBroadcast.startedAt,
				steps: (gateDef.verify || []).map((s: any) => ({ name: s.name, type: s.type, phase: s.phase ?? 0 })),
			});
		}

		// Build gate state map for metadata variable resolution + LLM reviewer context
		const allGateStates = new Map<string, { metadata?: Record<string, string>; content?: string; status?: string; injectDownstream?: boolean }>();
		for (const gs of gateStore.getGatesForGoal(goalId)) {
			const def = goal.workflow?.gates?.find((g: any) => g.id === gs.gateId);
			allGateStates.set(gs.gateId, {
				metadata: gs.currentMetadata,
				content: gs.currentContent,
				status: gs.status,
				injectDownstream: def?.injectDownstream,
			});
		}

		// Fire-and-forget verification — project `base_ref` is the configured
		// integration target; when unset, fall back to the repo's detected primary.
		// `parseBaseRef` normalizes remote refs like `origin/master` to `master`
		// for workflow variables such as `{{baseBranch}}` and legacy `{{master}}`.
		const branchContainer = goalBranchContainer(goal);
		const configuredBase = parseBaseRef(gateSignalCtx.projectConfigStore.get("base_ref") || "");
		const primary = configuredBase.branch || (await detectPrimaryBranch(branchContainer, serverCommandRunner, serverRemoteGitPolicy).catch(() => "master"));
		verificationHarness.verifyGateSignal(
			signal, gateDef, branchContainer, goal.branch, primary, allGateStates, goal.spec,
		).catch(err => console.error("[verification] Gate signal error:", err));

		const response = buildRunningGateSignalResponse(
			signal,
			verificationHarness.getActiveVerification(signal.id)?.overallStatus === "running",
		);
		json(response, 201);
		return;
	}

	// GET /api/goals/:goalId/gates/:gateId/signals — signal history
	const gateSignalsMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates\/([^/]+)\/signals$/);
	if (gateSignalsMatch && req.method === "GET") {
		const [, goalId, gateId] = gateSignalsMatch;
		const gateSignalsCtx = projectContextManager.getContextForGoal(goalId);
		if (!gateSignalsCtx) { json({ error: "Goal not found in any project" }, 404); return; }
		const gateStore = gateSignalsCtx.gateStore;
		const gate = gateStore.getGate(goalId, gateId);
		if (!gate) { json({ error: "Gate not found" }, 404); return; }
		const goal = gateSignalsCtx.goalStore.get(goalId);
		const gateName = goal?.workflow?.gates.find(def => def.id === gateId)?.name;
		json({
			signals: gate.signals,
			...(goal?.title ? { goalTitle: goal.title } : {}),
			...(gateName ? { gateName } : {}),
		});
		return;
	}

	// GET /api/goals/:goalId/verifications/active — get in-flight verification state
	const activeVerifMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/verifications\/active$/);
	if (activeVerifMatch && req.method === "GET") {
		const [, goalId] = activeVerifMatch;
		const active = verificationHarness.getActiveVerifications(goalId);
		json({ verifications: active });
		return;
	}

	// POST /api/goals/:goalId/gates/:gateId/cancel-verification — cancel a stuck verification
	const cancelVerifMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates\/([^/]+)\/cancel-verification$/);
	if (cancelVerifMatch && req.method === "POST") {
		const [, goalId, gateId] = cancelVerifMatch;
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (goal.archived) { json({ error: "Goal is archived" }, 409); return; }
		if (goal.state === "shelved") { json({ error: "Goal is shelved" }, 400); return; }

		const activeVers = verificationHarness.getActiveVerifications(goalId);
		const running = activeVers.find(v => v.gateId === gateId && v.overallStatus === "running");
		if (!running) {
			json({ cancelled: false, message: "No running verification to cancel" }, 200);
			return;
		}

		await verificationHarness.cancelStaleVerifications(goalId, gateId);
		// Explicit user cancel: also update gate status to "failed"
		const cancelCtx = projectContextManager.getContextForGoal(goalId);
		if (cancelCtx) cancelCtx.gateStore.updateGateStatus(goalId, gateId, "failed");
		json({ cancelled: true }, 200);
		return;
	}

	// POST /api/goals/:goalId/gates/:gateId/signoff — resolve a parked human-signoff step.
	// Body: { signalId, stepName, decision: "pass" | "fail", feedback? }.
	// Idempotent — already-resolved steps respond 409 with the current step state.
	const signoffMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates\/([^/]+)\/signoff$/);
	if (signoffMatch && req.method === "POST") {
		const [, goalId, gateId] = signoffMatch;
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (goal.archived) { json({ error: "Goal is archived" }, 409); return; }
		if (goal.state === "shelved") { json({ error: "Goal is shelved" }, 400); return; }

		const body = await readBody(req);
		if (!body
			|| typeof body.signalId !== "string" || !body.signalId
			|| typeof body.stepName !== "string" || !body.stepName
			|| (body.decision !== "pass" && body.decision !== "fail")) {
			json({ error: "Invalid body: { signalId, stepName, decision: 'pass'|'fail', feedback? }" }, 400);
			return;
		}

		const active = verificationHarness.getActiveVerification(body.signalId);
		if (!active || active.goalId !== goalId || active.gateId !== gateId) {
			// No in-flight verification — the signal may have already completed.
			// Distinguish "signal genuinely unknown" (404) from "signal exists but
			// the step is already resolved" (409, idempotent surface).
			const histCtx = projectContextManager.getContextForGoal(goalId);
			const histGate = histCtx?.gateStore.getGate(goalId, gateId);
			const histSignal = histGate?.signals.find(s => s.id === body.signalId);
			if (histSignal) {
				const histStep = histSignal.verification.steps.find(s => s.name === body.stepName);
				if (histStep && histStep.type === "human-signoff") {
					json({
						error: "step is no longer awaiting human input",
						stepName: histStep.name,
						status: histStep.passed ? "passed" : (histStep.skipped ? "skipped" : "failed"),
					}, 409);
					return;
				}
				if (histStep) {
					json({ error: "The specified step is not a human-signoff step" }, 409);
					return;
				}
			}
			json({ error: "No active verification for that signal/goal/gate" }, 404);
			return;
		}
		const step = active.steps.find(s => s.name === body.stepName);
		if (!step) {
			json({ error: `Step "${body.stepName}" not found in active verification` }, 404);
			return;
		}
		if (!step.awaitingHuman) {
			json({
				error: "step is no longer awaiting human input",
				stepName: step.name,
				status: step.status,
			}, 409);
			return;
		}

		const feedback = typeof body.feedback === "string" ? body.feedback : undefined;
		const resolved = verificationHarness.resolveSignoff(body.signalId, body.stepName, {
			decision: body.decision,
			feedback,
		});
		if (!resolved) {
			// Raced with cancellation or a prior resolve — idempotent surface.
			json({ error: "step is no longer awaiting human input" }, 409);
			return;
		}
		json({ resolved: true }, 200);
		return;
	}

	// GET /api/goals/:goalId/gates/:gateId/content — gate content
	const gateContentMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates\/([^/]+)\/content$/);
	if (gateContentMatch && req.method === "GET") {
		const [, goalId, gateId] = gateContentMatch;
		const gateContentCtx = projectContextManager.getContextForGoal(goalId);
		if (!gateContentCtx) { json({ error: "Goal not found in any project" }, 404); return; }
		const gateStore = gateContentCtx.gateStore;
		const gate = gateStore.getGate(goalId, gateId);
		if (!gate) { json({ error: "Gate not found" }, 404); return; }
		json({ content: gate.currentContent, version: gate.currentContentVersion });
		return;
	}

	// GET /api/goals/:goalId/workflow-context/:gateId — get dependency context for a gate
	const workflowContextMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/workflow-context\/([^/]+)$/);
	if (workflowContextMatch && req.method === "GET") {
		const goalId = workflowContextMatch[1];
		const gateId = workflowContextMatch[2];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (!goal.workflow) { json({ error: "Goal has no workflow" }, 404); return; }
		const gateDef = goal.workflow.gates.find(g => g.id === gateId);
		if (!gateDef) { json({ error: "Gate not found" }, 404); return; }

		const context = teamManager.buildDependencyContext(goalId, gateId);
		json({ context, gate: gateDef });
		return;
	}

	// Routes with task :id parameter
	const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
	if (taskMatch) {
		const id = taskMatch[1];

		// GET /api/tasks/:id
		if (req.method === "GET") {
			try {
				const record = getTaskRecordForTask(id);
				if (!record) { json({ error: "Task not found" }, 404); return; }
				if (!sandboxCanAccessTask(record.task)) return;
				json(record.task);
			} catch {
				json({ error: "Task not found" }, 404);
			}
			return;
		}

		// PUT /api/tasks/:id
		if (req.method === "PUT") {
			const body = await readBody(req);
			if (!body) { json({ error: "Missing body" }, 400); return; }
			try {
				const record = getTaskRecordForTask(id);
				if (!record) { json({ error: "Task not found" }, 404); return; }
				if (!sandboxCanAccessTask(record.task)) return;
				const tm = record.taskManager;
				const task = record.task;
				const prevState = task.state;
				const ok = tm.updateTask(id, {
					title: body.title,
					spec: body.spec,
					state: body.state,
					assignedSessionId: body.assignedSessionId,
					dependsOn: body.dependsOn,
					workflowGateId: typeof body.workflowGateId === "string" ? body.workflowGateId : undefined,
					inputGateIds: Array.isArray(body.inputGateIds) ? body.inputGateIds as string[] : undefined,
					headSha: typeof body.headSha === "string" ? body.headSha : undefined,
					baseSha: typeof body.baseSha === "string" ? body.baseSha : undefined,
					branch: typeof body.branch === "string" ? body.branch : undefined,
					resultSummary: typeof body.resultSummary === "string" ? body.resultSummary : undefined,
				});
				if (!ok) { json({ error: "Task not found" }, 404); return; }

				// Notify team lead when state transitions to terminal or blocked via PUT
				if (body.state && body.state !== prevState && (body.state === "complete" || body.state === "skipped" || body.state === "blocked") && task?.goalId) {
					teamManager.notifyTeamLeadOfTaskCompletion(task.goalId, task.title, body.state);
				}

				json({ ok: true });
			} catch (err: any) {
				jsonError(400, err);
			}
			return;
		}

		// DELETE /api/tasks/:id
		if (req.method === "DELETE") {
			try {
				const ok = getTaskManagerForTask(id).deleteTask(id);
				if (!ok) { json({ error: "Task not found" }, 404); return; }
				json({ ok: true });
			} catch {
				json({ error: "Task not found" }, 404);
			}
			return;
		}
	}

	// POST /api/tasks/:id/assign — assign task to session
	const taskAssignMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/assign$/);
	if (taskAssignMatch && req.method === "POST") {
		const body = await readBody(req);
		const sessionId = body?.sessionId;
		if (!sessionId || typeof sessionId !== "string") {
			json({ error: "Missing sessionId" }, 400);
			return;
		}
		try {
			const taskId = taskAssignMatch[1];
			const record = getTaskRecordForTask(taskId);
			if (!record) { json({ error: "Task not found" }, 400); return; }
			if (!sandboxCanAccessTask(record.task)) return;
			const tm = record.taskManager;
			const ok = tm.assignTask(taskId, sessionId);
			if (!ok) { json({ error: "Task not found" }, 400); return; }

			// Auto-populate baseSha and branch from TeamAgent record
			const agent = teamManager.findAgentBySessionId(sessionId);
			if (agent) {
				const task = tm.getTask(taskId);
				if (task) {
					const fields: Record<string, string> = {};
					if (agent.baseSha && !task.baseSha) fields.baseSha = agent.baseSha;
					if (agent.branch && !task.branch) fields.branch = agent.branch;
					if (Object.keys(fields).length) {
						tm.updateTask(taskId, fields);
					}
				}
			}

			json({ ok: true });
		} catch (err: any) {
			jsonError(400, err);
		}
		return;
	}

	// POST /api/tasks/:id/transition — state transition
	const taskTransitionMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/transition$/);
	if (taskTransitionMatch && req.method === "POST") {
		const body = await readBody(req);
		const state = body?.state;
		if (!state || typeof state !== "string") {
			json({ error: "Missing state" }, 400);
			return;
		}
		if (!VALID_TASK_STATES.has(state)) {
			json({ error: `Invalid task state: ${state}` }, 400);
			return;
		}
		try {
			const taskId = taskTransitionMatch[1];
			const record = getTaskRecordForTask(taskId);
			if (!record) { json({ error: "Task not found" }, 400); return; }
			if (!sandboxCanAccessTask(record.task)) return;
			const tm = record.taskManager;
			const task = record.task;
			const ok = tm.transitionTask(taskId, state as TaskState);
			if (!ok) { json({ error: "Task not found" }, 400); return; }

			// Notify team lead when a task reaches a terminal or blocked state
			if ((state === "complete" || state === "skipped" || state === "blocked") && task?.goalId) {
				teamManager.notifyTeamLeadOfTaskCompletion(task.goalId, task.title, state);
			}

			json({ ok: true });
		} catch (err: any) {
			jsonError(400, err);
		}
		return;
	}

	// ── Team endpoints ─────────────────────────────────────────────
	// Routes accept both /team/ and legacy /swarm/ paths

	// POST /api/goals/:id/team/start — start a team for a goal
	const teamStartMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/start$/);
	if (teamStartMatch && req.method === "POST") {
		const goalId = teamStartMatch[1];
		// Guard: goal spec must be set before starting the team.
		const startGoal = getGoalAcrossProjects(goalId);
		const trimmedSpec = (startGoal?.spec ?? "").trim();
		if (!trimmedSpec || trimmedSpec.length < 20 || trimmedSpec.toLowerCase() === "placeholder") {
			json({ error: "Goal spec must be set before starting the team. Update via PUT /api/goals/:id.", code: "SPEC_REQUIRED" }, 400);
			return;
		}
		try {
			const session = await teamManager.startTeam(goalId);
			json({ sessionId: session.id, title: session.title }, 201);
		} catch (err) {
			jsonError(400, err);
		}
		return;
	}

	// POST /api/goals/:id/team/spawn — spawn a role agent
	const teamSpawnMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/spawn$/);
	if (teamSpawnMatch && req.method === "POST") {
		const goalId = teamSpawnMatch[1];
		// Guard: reject spawn if goal is archived
		const spawnGoal = getGoalAcrossProjects(goalId);
		if (spawnGoal?.archived) {
			json({ error: "Goal is archived" }, 409);
			return;
		}
		// Pause-cascade: refuse to spawn role agents on a paused goal.
		if (spawnGoal?.paused) {
			json({ error: `Goal ${goalId} is paused`, code: "GOAL_PAUSED", goalId }, 409);
			return;
		}
		// Guard: reject spawn if goal worktree is not ready
		if (spawnGoal && spawnGoal.setupStatus !== "ready") {
			json({ error: "Goal setup not complete" }, 409);
			return;
		}
		const body = await readBody(req);
		if (!body?.role || !body?.task) {
			json({ error: "Missing role or task" }, 400);
			return;
		}
		try {
			const spawnOpts: { workflowGateId?: string; inputGateIds?: string[] } = {};
			if (typeof body.workflowGateId === "string") spawnOpts.workflowGateId = body.workflowGateId;
			if (Array.isArray(body.inputGateIds)) spawnOpts.inputGateIds = body.inputGateIds as string[];
			const result = await teamManager.spawnRole(goalId, body.role, body.task, spawnOpts);
			json(result, 201);
		} catch (err) {
			if (err instanceof GateDependencyError) {
				jsonError(409, err);
			} else if (err instanceof GoalPausedError) {
				json({ error: err.message, code: err.code, goalId: err.goalId }, 409);
			} else {
				jsonError(400, err);
			}
		}
		return;
	}

	// Finding #6 fallback: a team-lead's `team_delegate(non_blocking)` child is NOT a
	// goal team member, so the goal /team/* routes would reject it — yet the team-lead
	// holds team_prompt/dismiss/steer/abort (registered goal-scoped via team/extension.ts,
	// NOT the own-child variants in agent/extension.ts, to avoid double-registration).
	// When the target is an own child of THIS goal's team-lead (tracked by the shared
	// OrchestrationCore), route the verb through the core so the documented verbs work
	// on the lead's own delegate helpers. Goal-member behaviour is unchanged.
	const teamLeadOwnChildOwner = (goalId: string, targetId: string): string | undefined => {
		const teamState = teamManager.getTeamState(goalId);
		if (!teamState?.teamLeadSessionId) return undefined;
		const lead = teamState.teamLeadSessionId;

		// Tracked goal team members must flow through TeamManager.dismissRoleForGoal()
		// so it can remove team-manager state, subscriptions, timers, and broadcasts.
		// They are also registered in OrchestrationCore under the team lead, so a
		// plain owner/child match would incorrectly route real team agents through
		// the private team_delegate fallback. Check both the goal state snapshot and
		// the session→goal index; tests and restart paths can observe one before the
		// other is refreshed.
		if (teamState.agents.some((agent) => agent.sessionId === targetId)) return undefined;
		if (teamManager.findAgentBySessionId(targetId)) return undefined;
		const persisted = sessionManager.getPersistedSession(targetId) as any;

		if (orchestrationCore.list(lead).some(h => h.sessionId === targetId && h.childKind !== "team")) return lead;
		if (orchestrationCore.dismissedOwnerOf(targetId) === lead) return lead;
		return persisted?.delegateOf === lead || (persisted?.parentSessionId === lead && persisted?.childKind !== "team") ? lead : undefined;
	};
	const resolveAuthenticCallerFromSessionSecret = (): string | undefined => {
		const h = req.headers as Record<string, string | string[] | undefined>;
		const secretHeader = h["x-bobbit-session-secret"];
		const secret = Array.isArray(secretHeader) ? secretHeader[0] : secretHeader;
		return sessionManager.sessionSecretStore.resolveSessionIdBySecret(
			typeof secret === "string" && secret.trim() ? secret.trim() : undefined,
		);
	};
	const denyDismissNotOwned = (sessionId: string, message = "Caller session is not the team lead for this goal") => json({
		ok: false,
		status: "not-owned",
		sessionId,
		message,
		retryable: false,
	}, 403);

	// H3 authz — the own-child fallback MUST enforce owner→caller authz, exactly
	// like /orchestrate/* (server.ts ~9310). The goal /team/* routes accept a
	// sandbox-scoped token, so without this a same-goal agent that learns a
	// helper child's session id could prompt/steer/abort/dismiss the team-lead's
	// PRIVATE team_delegate child. Bind to the unforgeable per-session secret and
	// require the AUTHENTIC caller to BE the team-lead owner. Goal-MEMBER
	// operations use TeamManager below; tracked team-agent dismiss has its own
	// team-lead authz check before destructive cleanup. Returns the owner id when
	// authorized, a `denied` sentinel when the target IS an own child but the
	// caller is not its owner, or `undefined` when the target is not an own child
	// (normal path continues).
	const resolveOwnChildOwner = (goalId: string, targetId: string): { owner: string } | { denied: true } | undefined => {
		const owner = teamLeadOwnChildOwner(goalId, targetId);
		if (!owner) return undefined;
		const authenticCaller = resolveAuthenticCallerFromSessionSecret();
		if (!authenticCaller || authenticCaller !== owner) return { denied: true };
		return { owner };
	};
	const denyOwnChild = () => json({ error: "Caller session is not the owner of this child agent", code: "NOT_OWNER" }, 403);
	const ocStatusForTeamFallback = (err: unknown): number => {
		if (err instanceof SessionPromptDeliveryError) return err.status;
		if (err instanceof OrchestrationCoreError) {
			if (err.code === "NOT_STREAMING") return 409;
			if (err.code === "NOT_OWN_CHILD" || err.code === "NO_GRANDCHILDREN") return 403;
			return 400;
		}
		return 500;
	};

	// POST /api/goals/:id/team/dismiss — dismiss a role agent
	const teamDismissMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/dismiss$/);
	if (teamDismissMatch && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.sessionId) {
			json({ error: "Missing sessionId" }, 400);
			return;
		}
		const goalId = teamDismissMatch[1];
		// Own-child fallback: dismissRole only knows goal team members; a team-lead's
		// own team_delegate child is tracked by OrchestrationCore, not the team entry.
		const ownerResult = resolveOwnChildOwner(goalId, body.sessionId);
		if (ownerResult) {
			if ("denied" in ownerResult) {
				json({ ok: false, status: "not-owned", sessionId: body.sessionId, message: "Caller session is not the owner of this child agent", retryable: false }, 403);
				return;
			}
			const result = await orchestrationCore.dismiss(ownerResult.owner, body.sessionId);
			json(result, dismissHttpStatus(result));
			return;
		}
		const teamState = teamManager.getTeamState(goalId);
		const isTrackedTeamAgent = teamState?.agents.some((agent) => agent.sessionId === body.sessionId) ?? false;
		if (isTrackedTeamAgent) {
			const authz = authorizeChildrenMutation({
				mutationClass: "orchestration",
				isHumanOperator: false,
				authenticCallerSessionId: resolveAuthenticCallerFromSessionSecret(),
				teamLeadSessionId: teamState?.teamLeadSessionId,
			});
			if (!authz.ok) {
				denyDismissNotOwned(body.sessionId);
				return;
			}
		}
		const result = await teamManager.dismissRoleForGoal(goalId, body.sessionId);
		json(result, dismissHttpStatus(result));
		return;
	}

	// GET /api/goals/:id/commits — get commit history for goal branch
	const commitsMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/commits$/);
	if (commitsMatch && req.method === "GET") {
		const goalId = commitsMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (!hasGoalGitWorktree(goal)) { json(goalGitUnavailablePayload(goal, "Commit history"), 409); return; }
		if (!fs.existsSync(goal.cwd)) { json({ commits: [] }); return; }
		const branch = goal.branch;
		// Validate branch name to prevent injection
		if (!/^[a-zA-Z0-9/_.\-]+$/.test(branch)) { json({ error: "Invalid branch name" }, 400); return; }
		const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 1), 100);
		try {
			let primaryBranch = "master";
			try {
				const remoteHead = await execGit("git symbolic-ref refs/remotes/origin/HEAD", goal.cwd, 5000, undefined, commandRunner);
				primaryBranch = remoteHead.replace("refs/remotes/origin/", "");
			} catch {
				try { await execGit("git rev-parse --verify refs/heads/master", goal.cwd, 5000, undefined, commandRunner); primaryBranch = "master"; }
				catch { try { await execGit("git rev-parse --verify refs/heads/main", goal.cwd, 5000, undefined, commandRunner); primaryBranch = "main"; } catch { /* keep default */ } }
			}

			let rangeSpec = `-${limit} ${branch}`;
			if (branch !== primaryBranch && branch !== "HEAD") {
				let primaryRef = primaryBranch;
				try { await execGit(`git rev-parse --verify origin/${primaryBranch}`, goal.cwd, 5000, undefined, commandRunner); primaryRef = `origin/${primaryBranch}`; } catch { /* use local */ }
				try { await execGit(`git rev-parse ${primaryRef}`, goal.cwd, 5000, undefined, commandRunner); rangeSpec = `-${limit} ${primaryRef}..${branch}`; } catch { /* fall back */ }
			}

			const commits = await getCommitsWithFiles(goal.cwd, rangeSpec.split(" ").filter(Boolean), 5000, undefined, commandRunner);
			json({ commits });
		} catch (e: any) {
			json({ error: "Failed to read git log", detail: e.message }, 500);
		}
		return;
	}

	// GET /api/goals/:id/git-status — git status for goal worktree (async)
	const goalGitMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/git-status$/);
	if (goalGitMatch && req.method === "GET") {
		const goalId = goalGitMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (!hasGoalGitWorktree(goal)) { json(goalGitUnavailablePayload(goal, "Git status"), 409); return; }
		const cwd = goal.cwd;

		// Resolve container ID for sandboxed goals + project `base_ref` config
		// for the `aheadOfPrimary`/`behindPrimary` counter — see
		// `docs/design/base-ref.md` §5.
		let cid: string | undefined;
		let goalBaseRef: string | undefined;
		try {
			const goalCtx = projectContextManager.getContextForGoal(goalId);
			if (goalCtx) {
				goalBaseRef = goalCtx.projectConfigStore.get("base_ref") || undefined;
				if (goal.sandboxed) {
					const sandbox = sessionManager.getSandboxManager()?.get(goalCtx.project.id);
					cid = sandbox ? await sandbox.getContainerId() : undefined;
				}
			}
		} catch { /* container/config unavailable — fall through */ }

		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		const goalUntracked = url.searchParams.get('untracked') === '1';
		if (url.searchParams.get('fetch') === 'true') {
			try { await execGit('git fetch --quiet', cwd, 15000, cid); } catch { /* best-effort */ }
			invalidateGitStatusCache(cwd, cid);
		}
		try {
			const result = await batchGitStatus(cwd, cid, { untracked: goalUntracked, configuredBaseRef: goalBaseRef });
			if (!result) { json({ error: "Not a git repository" }, 400); return; }

			// Multi-repo aware envelope: include `repos` map + `aggregate` for back-compat.
			const repoWorktrees = (goal as { repoWorktrees?: Record<string, string> }).repoWorktrees;
			if (repoWorktrees && Object.keys(repoWorktrees).length > 0) {
				const repos: Record<string, typeof result> = {};
				for (const [repoName, repoPath] of Object.entries(repoWorktrees)) {
					try {
						if (cid || fs.existsSync(repoPath)) {
							const r = await batchGitStatus(repoPath, cid, { untracked: goalUntracked, configuredBaseRef: goalBaseRef });
							if (r) repos[repoName] = r;
						}
					} catch { /* per-repo failure non-fatal */ }
				}
				json({ ...result, aggregate: result, repos });
			} else {
				// Single-repo: include `repos: { ".": result }, aggregate: result` for back-compat.
				json({ ...result, aggregate: result, repos: { ".": result } });
			}
		} catch (err: any) {
			jsonError(500, err, { error: err.stderr?.trim() || err.message || "git status failed" });
		}
		return;
	}

	// GET /api/goals/:id/git-diff — unified diff for goal worktree
	const goalDiffMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/git-diff$/);
	if (goalDiffMatch && req.method === "GET") {
		const goalId = goalDiffMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (!hasGoalGitWorktree(goal)) { json(goalGitUnavailablePayload(goal, "Git diff"), 409); return; }
		const cwd = goal.cwd;

		// Resolve container ID for sandboxed goals
		let cid: string | undefined;
		if (goal.sandboxed) {
			try {
				const goalCtx = projectContextManager.getContextForGoal(goalId);
				const sandbox = goalCtx ? sessionManager.getSandboxManager()?.get(goalCtx.project.id) : undefined;
				cid = sandbox ? await sandbox.getContainerId() : undefined;
			} catch { /* container unavailable */ }
		}

		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		const file = url.searchParams.get("file") || undefined;
		const commit = url.searchParams.get("commit") || undefined;
		const repoParam = url.searchParams.get("repo") || undefined;
		const goalRepoWorktrees = (goal as { repoWorktrees?: Record<string, string> }).repoWorktrees;
		let diffCwd = cwd;
		if (repoParam && goalRepoWorktrees && goalRepoWorktrees[repoParam]) {
			diffCwd = goalRepoWorktrees[repoParam];
		}
		try {
			const diff = await getGitDiff(diffCwd, file, cid, commit, commandRunner);
			json({ diff });
		} catch (err: any) {
			if (err.message === "INVALID_PATH") { json({ error: "Invalid file path" }, 400); return; }
			if (err.message === "INVALID_COMMIT") { json({ error: "Invalid commit" }, 400); return; }
			if (err.message === "NO_DIFF") { json({ error: "No diff found" }, 404); return; }
			jsonError(500, err);
		}
		return;
	}

	// GET /api/pr-status-cache — bulk PR status from disk cache (startup hydration)
	if (req.method === "GET" && url.pathname === "/api/pr-status-cache") {
		json(prStatusStore.getAll());
		return;
	}

	// GET /api/goals/:id/pr-status — PR status for goal branch (async + cached)
	const goalPrStatusMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/pr-status$/);
	if (goalPrStatusMatch && req.method === "GET") {
		const goalId = goalPrStatusMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (!hasGoalGitWorktree(goal)) { json(goalGitUnavailablePayload(goal, "PR status"), 409); return; }
		const cwd = goal.cwd;
		if (!fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		// Pass process.cwd() as fallback — if the goal's worktree has a broken git link
		// (e.g. pruned worktree), gh can still query by branch name from the main repo.
		const optional = url.searchParams.get("optional") === "1";
		const pr = await getCachedPrStatus(cwd, goal.branch, process.cwd());
		if (pr) { prStatusStore.set(goalId, pr); json(pr); } else if (optional) { noContent(); } else { json({ error: "No PR found" }, 404); }
		return;
	}

	// GET /api/goals/:id/github-link — PR URL or sanitized GitHub branch fallback
	const goalGithubLinkMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/github-link$/);
	if (goalGithubLinkMatch && req.method === "GET") {
		const goalId = goalGithubLinkMatch[1];
		json(await resolveGoalGithubLink<PersistedGoal, PrStatusEntry>(goalId, {
			getGoal: getGoalAcrossProjects,
			hasGitWorktree: hasGoalGitWorktree,
			noWorktreeMessage: noWorktreeGoalGitMessage,
			getCachedPr: id => prStatusStore.get(id),
			getFreshPr: (cwd, branch) => getCachedPrStatus(cwd, branch, process.cwd()),
			setCachedPr: (id, pr) => prStatusStore.set(id, pr),
			pathExists: fs.existsSync,
			getOriginRemote: async cwd => {
				const { stdout } = await serverCommandRunner.execFile("git", ["remote", "get-url", "origin"], {
					cwd,
					encoding: "utf-8",
					timeout: 5_000,
				});
				return stripTokenFromGitUrl(String(stdout).trim());
			},
		}));
		return;
	}

	// POST /api/goals/:id/pr-cache-bust — invalidate PR cache for a goal
	const goalPrCacheBustMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/pr-cache-bust$/);
	if (req.method === 'POST' && goalPrCacheBustMatch) {
		const goalId = goalPrCacheBustMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		const cwd = goal.cwd;
		_prCache.delete(cwd);
		if (goal.branch) _prCache.delete(`${cwd}::${goal.branch}`);
		broadcastToAll({ type: "pr_status_changed", goalId });
		json({ ok: true });
		return;
	}

	// POST /api/goals/:id/pr-merge — merge PR for goal branch
	const goalPrMergeMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/pr-merge$/);
	if (goalPrMergeMatch && req.method === "POST") {
		const goalId = goalPrMergeMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (!hasGoalGitWorktree(goal)) { json(goalGitUnavailablePayload(goal, "PR merge"), 409); return; }
		const cwd = goal.cwd;
		if (!fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		const body = await readBody(req);
		const method = body?.method ?? "squash";
		if (!["merge", "squash", "rebase"].includes(method)) {
			json({ error: "Invalid merge method. Must be merge, squash, or rebase." }, 400);
			return;
		}
		const clientGoalBranch = typeof body?.branch === "string" ? body.branch : undefined;
		const resolvedGoalBranch = clientGoalBranch || goal.branch;
		try {
			await serverCommandRunner.execFile("gh", buildGhPrMergeArgs(resolvedGoalBranch, method, body?.admin), { cwd, encoding: "utf-8", timeout: 30000 });
			_prCache.delete(cwd);
			if (goal.branch) _prCache.delete(`${cwd}::${goal.branch}`);
			json({ ok: true });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			json({ error: msg }, 500);
		}
		return;
	}

	// GET /api/goals/:id/team — get team state
	const teamStateMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)$/);
	if (teamStateMatch && req.method === "GET") {
		const goalId = teamStateMatch[1];
		const state = teamManager.getTeamState(goalId);
		if (!state) {
			json({ error: "No active team for this goal" }, 404);
			return;
		}
		// S1: `teamLeadSessionId` is intentionally exposed here. It is NO LONGER
		// an authorization credential — orchestration/operator Children authz
		// binds to the unforgeable per-session `X-Bobbit-Session-Secret` (see
		// children-mutation-authz.ts + session-secret.ts), so knowing the public
		// team-lead session id grants nothing without the secret. Consumers rely
		// on it (the UI, auto-start-team E2E, team-state polling), so we keep it.
		json(state);
		return;
	}

	// POST /api/goals/:id/team/steer — steer a team agent mid-turn
	const teamSteerMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/steer$/);
	if (teamSteerMatch && req.method === "POST") {
		const goalId = teamSteerMatch[1];
		const body = await readBody(req);
		if (!body?.sessionId || !body?.message) {
			json({ error: "Missing sessionId or message" }, 400);
			return;
		}
		// Validate target is a team agent
		const agents = teamManager.listAgents(goalId);
		if (!agents.find(a => a.sessionId === body.sessionId)) {
			const ownerResult = resolveOwnChildOwner(goalId, body.sessionId);
			if (ownerResult) {
				if ("denied" in ownerResult) { denyOwnChild(); return; }
				try {
					await orchestrationCore.steer(ownerResult.owner, body.sessionId, body.message);
					json({ ok: true, dispatched: true });
				} catch (err) {
					json({ error: String(err instanceof Error ? err.message : err), code: err instanceof OrchestrationCoreError ? err.code : undefined }, ocStatusForTeamFallback(err));
				}
				return;
			}
			json({ error: "Session is not a member of this team" }, 403);
			return;
		}
		const session = sessionManager.getSession(body.sessionId);
		if (!session) {
			json({ error: "Session not found" }, 404);
			return;
		}
		// Allow steering non-interactive sessions (e.g. verification reviewers)
		// so the user can redirect them mid-run
		if (session.status !== "streaming") {
			json({ error: "Agent is not currently streaming — use team/prompt instead" }, 409);
			return;
		}
		try {
			await sessionManager.deliverLiveSteer(session.id, body.message);
			json({ ok: true, dispatched: true });
		} catch (err) {
			jsonError(500, err);
		}
		return;
	}

	// POST /api/goals/:id/team/abort — force-abort a stuck team agent
	const teamAbortMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/abort$/);
	if (teamAbortMatch && req.method === "POST") {
		const goalId = teamAbortMatch[1];
		const body = await readBody(req);
		if (!body?.sessionId) {
			json({ error: "Missing sessionId" }, 400);
			return;
		}
		// Validate target is a team agent
		const agents = teamManager.listAgents(goalId);
		if (!agents.find(a => a.sessionId === body.sessionId)) {
			const ownerResult = resolveOwnChildOwner(goalId, body.sessionId);
			if (ownerResult) {
				if ("denied" in ownerResult) { denyOwnChild(); return; }
				try {
					await orchestrationCore.abort(ownerResult.owner, body.sessionId);
					const afterSession = sessionManager.getSession(body.sessionId);
					json({ ok: true, status: afterSession?.status || "idle" });
				} catch (err) {
					json({ error: String(err instanceof Error ? err.message : err), code: err instanceof OrchestrationCoreError ? err.code : undefined }, ocStatusForTeamFallback(err));
				}
				return;
			}
			json({ error: "Session is not a member of this team" }, 403);
			return;
		}
		const session = sessionManager.getSession(body.sessionId);
		if (!session) {
			json({ error: "Session not found" }, 404);
			return;
		}
		try {
			await sessionManager.forceAbort(body.sessionId);
			const afterSession = sessionManager.getSession(body.sessionId);
			json({ ok: true, status: afterSession?.status || "idle" });
		} catch (err) {
			jsonError(500, err);
		}
		return;
	}

	// POST /api/goals/:id/team/prompt — prompt or steer a team agent, direct-child lead, or owned helper.
	const teamPromptMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/prompt$/);
	if (teamPromptMatch && req.method === "POST") {
		const goalId = teamPromptMatch[1];
		const body = await readBody(req);
		if (typeof body?.sessionId !== "string" || typeof body?.message !== "string") {
			json({ error: "Missing sessionId or message" }, 400);
			return;
		}
		let mode: "prompt" | "steer";
		try {
			mode = parseSessionPromptMode(body.mode, "steer");
		} catch (err) {
			if (err instanceof SessionPromptDeliveryError) json({ error: err.message, code: err.code }, err.status);
			else jsonError(500, err);
			return;
		}

		// Pause guard: reject prompts to paused goals before membership check.
		const teamPromptGoal = getGoalAcrossProjects(goalId);
		if (teamPromptGoal?.paused) {
			json({ error: "Goal is paused — resume it before sending prompts", code: "GOAL_PAUSED", goalId }, 409);
			return;
		}

		// Validate target is a team agent OR a direct-child team-lead OR an owned helper child.
		const agents = teamManager.listAgents(goalId);
		let allowed = !!agents.find(a => a.sessionId === body.sessionId);
		let ownChildOwner: string | undefined;
		if (!allowed) {
			const targetSession = sessionManager.getSession(body.sessionId);
			if (targetSession?.role === "team-lead" && targetSession.goalId) {
				const targetGoal = getGoalAcrossProjects(targetSession.goalId);
				if (targetGoal?.parentGoalId === goalId) {
					allowed = true;
				}
			}
		}
		if (!allowed) {
			const ownerResult = resolveOwnChildOwner(goalId, body.sessionId);
			if (ownerResult) {
				if ("denied" in ownerResult) { denyOwnChild(); return; }
				ownChildOwner = ownerResult.owner;
				allowed = true;
			}
		}
		if (!allowed) {
			json({
				error: "Session is not a member of this team and is not a direct-child team-lead",
				code: "NOT_TEAM_MEMBER_OR_DIRECT_CHILD",
			}, 403);
			return;
		}
		const session = sessionManager.getSession(body.sessionId);
		if (!session) {
			json({ error: "Session not found" }, 404);
			return;
		}

		// Enforce gate dependency check for team/prompt.
		const wfGateId = typeof body.workflowGateId === "string" ? body.workflowGateId : undefined;
		const inputIds = Array.isArray(body.inputGateIds) ? body.inputGateIds as string[] : undefined;
		if (wfGateId) {
			const goal = getGoalAcrossProjects(goalId);
			const goalGateCtx = projectContextManager.getContextForGoal(goalId);
			const goalGateStore = goalGateCtx?.gateStore;
			if (goal?.workflow && goalGateStore) {
				const gateStates = goalGateStore.getGatesForGoal(goalId);
				const depError = checkGateDependencies(wfGateId, goal.workflow.gates, gateStates);
				if (depError) {
					json({ error: depError }, 409);
					return;
				}
			}
		}
		try {
			// Resolve workflow gate context and prepend to message if provided.
			let message = body.message as string;
			if (wfGateId || inputIds?.length) {
				const ctx = teamManager.buildDependencyContext(goalId, wfGateId, inputIds);
				if (ctx) {
					message = ctx + "\n\n---\n\n" + message;
				}
			}
			const result = ownChildOwner
				? await orchestrationCore.prompt(ownChildOwner, body.sessionId, message, { mode })
				: await deliverSessionPrompt({
					getSession: (id) => sessionManager.getSession(id),
					enqueuePrompt: (id, text, opts) => sessionManager.enqueuePrompt(id, text, opts),
					deliverLiveSteer: (id, text, opts) => sessionManager.deliverLiveSteer(id, text, opts),
					getErroredPromptRecoveryDecision: (id) => sessionManager.getErroredPromptRecoveryDecision(id),
					enqueuePromptForRetryRecovery: (id, text, opts) => sessionManager.enqueuePromptForRetryRecovery(id, text, opts),
					retryLastPrompt: (id, opts) => sessionManager.retryLastPrompt(id, opts),
				}, body.sessionId, message, { mode, defaultMode: "steer" });
			json(result);
		} catch (err) {
			if (err instanceof SessionPromptDeliveryError || err instanceof OrchestrationCoreError) {
				json({ error: String(err instanceof Error ? err.message : err), code: err instanceof Error ? (err as { code?: string }).code : undefined }, ocStatusForTeamFallback(err));
			} else {
				jsonError(500, err);
			}
		}
		return;
	}

	// GET /api/goals/:id/team/agents — list agents for a team goal
	const teamAgentsMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/agents$/);
	if (teamAgentsMatch && req.method === "GET") {
		const goalId = teamAgentsMatch[1];
		const agents = teamManager.listAgents(goalId);

		// Include archived (dismissed) agents when ?include=archived is set
		const includeArchived = url.searchParams.get("include") === "archived";
		let archivedAgents: unknown[] = [];
		if (includeArchived) {
			const liveSessionIds = new Set(agents.map((a: any) => a.sessionId));
			archivedAgents = sessionManager.listArchivedSessions()
				.filter(s => s.teamGoalId === goalId && !liveSessionIds.has(s.id))
				.map(s => ({
					sessionId: s.id,
					role: s.role || "unknown",
					status: "archived",
					worktreePath: s.worktreePath || "",
					branch: "",
					task: "",
					createdAt: s.createdAt,
					archivedAt: s.archivedAt,
					title: s.title,
					accessory: s.accessory,
					taskId: s.taskId,
					teamLeadSessionId: s.teamLeadSessionId,
					teamGoalId: s.teamGoalId,
					delegateOf: s.delegateOf,
				}));
		}

		json({ agents: [...agents, ...archivedAgents] });
		return;
	}

	// POST /api/goals/:id/team/complete — complete a team (dismiss agents, keep team lead)
	const teamCompleteMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/complete$/);
	if (teamCompleteMatch && req.method === "POST") {
		const goalId = teamCompleteMatch[1];
		// Guard: a goal cannot be marked complete while it still has unresolved
		// live descendant goals. Nested child work must be rolled up (merged +
		// completed) or archived before the parent completes — otherwise the
		// parent's branch/PR would land without its children's work. This is
		// independent of gate-requirement state (the gate checks in
		// completeTeam() can be absent/skipped/stale, so we enforce here too).
		// Archived and already-complete descendants don't block.
		const completeCtx = projectContextManager.getContextForGoal(goalId);
		const completeAllGoals = completeCtx?.goalStore.getAll() ?? [];
		const unresolvedChildIds = walkGoalSubtree(goalId, completeAllGoals, { includeRoot: false, includeArchived: false })
			.filter(g => g.state !== "complete")
			.map(g => g.id);
		if (unresolvedChildIds.length > 0) {
			json({
				error: `Cannot complete: ${unresolvedChildIds.length} unresolved child goal(s) must be completed or archived first`,
				code: "UNRESOLVED_CHILDREN",
				childIds: unresolvedChildIds,
			}, 409);
			return;
		}
		const completeBody = await readBody(req);
		const confirmBypassedGates = completeBody?.confirmBypassedGates === true;
		// Bypassed-gate confirmation is a HUMAN-only override. A sandbox-scoped
		// agent token must not be able to confirm completion past bypassed gates
		// by hitting this REST endpoint directly — that would defeat the
		// human-in-the-loop trust boundary the bypass feature enforces.
		if (confirmBypassedGates && sandboxScope) {
			json({ error: "Forbidden: sandbox token cannot confirm completion of bypassed gates" }, 403);
			return;
		}
		try {
			await teamManager.completeTeam(goalId, { allowBypassedGates: confirmBypassedGates });
			json({ ok: true });
		} catch (err) {
			jsonError(400, err);
		}
		return;
	}

	// POST /api/goals/:id/team/teardown — fully tear down a team (dismiss agents + terminate team lead).
	// Cascade required — mirror of `tests/api-team-teardown-cascade.test.ts::teardownRoute`.
	const teamTeardownMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/teardown$/);
	if (teamTeardownMatch && req.method === "POST") {
		const goalId = teamTeardownMatch[1];
		const cascadeParam = url.searchParams.get("cascade");
		if (cascadeParam !== "true" && cascadeParam !== "false") {
			json({ error: "cascade=true|false query parameter is required", code: "CASCADE_REQUIRED" }, 422);
			return;
		}
		const cascade = cascadeParam === "true";
		// Validate goal exists before attempting teardown.
		if (!getGoalAcrossProjects(goalId)) { json({ error: "Goal not found" }, 404); return; }
		const tdCtx = projectContextManager.getContextForGoal(goalId);
		const tdAllGoals = tdCtx?.goalStore.getAll() ?? [];

		// cascade=false + live descendant teams → 409 HAS_DESCENDANT_TEAMS.
		if (!cascade) {
			const descendants = walkGoalSubtree(goalId, tdAllGoals, { includeRoot: false, includeArchived: false });
			const descendantsWithTeams = descendants
				.filter(d => !!teamManager.getTeamState(d.id))
				.map(d => ({ id: d.id, title: d.title }));
			if (descendantsWithTeams.length > 0) {
				json({
					code: "HAS_DESCENDANT_TEAMS",
					count: descendantsWithTeams.length,
					descendants: descendantsWithTeams,
					message: `Goal has ${descendantsWithTeams.length} descendant team(s) still running. Re-call with ?cascade=true to stop them all.`,
				}, 409);
				return;
			}
		}

		// Bottom-up: children torn down before parents. Skip archived
		// nodes. cascade=false collapses to root-only by capping depth at 0.
		const result = await cascadeGoalSubtree(
			goalId,
			tdAllGoals,
			{ includeRoot: true, includeArchived: false, ...(cascade ? {} : { maxDepth: 0 }) },
			{
				order: "bottom-up",
				apply: async (g) => {
					if (!teamManager.getTeamState(g.id)) return false;
					await teamManager.teardownTeam(g.id);
					return true;
				},
			},
		);
		const toreDown = result.processed.filter(p => p.result === true).length;
		json({
			ok: true,
			toreDown,
			errors: result.errors.map(e => ({ goalId: e.goalId, error: e.error.message })),
		});
		return;
	}

	// Routes with :id parameter
	const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
	if (sessionMatch) {
		const id = sessionMatch[1];

		if (req.method === "GET") {
			const session = sessionManager.getSession(id);
			if (!session) {
				json({ error: "Session not found" }, 404);
				return;
			}
			json({
				id: session.id,
				title: session.title,
				cwd: session.cwd,
				status: session.status,
				createdAt: session.createdAt,
				clientCount: session.clients.size,
			});
			return;
		}

		if (req.method === "DELETE") {
			const purge = url.searchParams.get("purge") === "true";
			// Check if it's an archived session — purge immediately
			const archivedSession = sessionManager.getArchivedSession(id);
			if (archivedSession) {
				await sessionManager.purgeArchivedSession(id);
				json({ ok: true });
				return;
			}
			const terminated = await sessionManager.terminateSession(id);
			if (!terminated) {
				// Session not live. It may still exist as a dormant / store-only entry
				// (e.g. a completed delegate parent, or a parent that went dormant after
				// a restart). Archiving such a parent MUST still cascade-reap its children
				// (design §6 — the "parent dormant/not-live" path), so route it through the
				// cascade-archive seam regardless of `purge` rather than 404-ing without
				// archiving. `terminateSession` already cascades for the live case.
				const persisted = sessionManager.getPersistedSession(id);
				if (!persisted) {
					// Truly unknown — not live, not in any store.
					json({ error: "Session not found" }, 404);
					return;
				}
				// storeArchive → archiveWithCascade → cascadeReapOwner(children) then archive,
				// so the dormant parent's live children are reaped before it is archived.
				await sessionManager.storeArchive(id);
				if (purge) {
					await sessionManager.purgeArchivedSession(id);
				}
				json({ ok: true });
				return;
			}
			// If purge requested, also purge the now-archived session immediately
			if (purge) {
				await sessionManager.purgeArchivedSession(id);
			}
			json({ ok: true });
			return;
		}
	}

	// POST /api/sessions/:id/fork — fork a live plain session: clone the source
	// transcript (and tool-content / proposal drafts) into a fresh session and
	// preserve its project/goal/task/model/role context. The caller chooses
	// whether to spin up a new worktree (default) or reuse the source's worktree.
	const forkMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/fork$/);
	if (forkMatch && req.method === "POST") {
		const sourceId = forkMatch[1];
		const forkBody = await readBody(req).catch(() => ({} as any));
		// Default to a NEW worktree when the flag is omitted.
		const newWorktree = forkBody?.newWorktree === undefined ? true : !!forkBody.newWorktree;

		const source = sessionManager.getSession(sourceId);
		const ps = sessionManager.getPersistedSession(sourceId);
		if (!ps) { json({ error: "session not found" }, 404); return; }
		if (ps.archived) { json({ error: "archived sessions cannot be forked" }, 422); return; }
		if (!source) { json({ error: "only live sessions can be forked" }, 422); return; }

		const unsupported = isUnsupportedForkSource(source, ps);
		if (unsupported) { json({ error: unsupported }, 422); return; }

		const projectId = ps.projectId || source.projectId;
		if (!projectId || !projectRegistry.get(projectId)) {
			json({ error: "source project no longer registered" }, 410);
			return;
		}

		const goal = ps.goalId ? getGoalAcrossProjects(ps.goalId) : undefined;
		if (ps.goalId && !goal) { json({ error: "source goal not found" }, 410); return; }
		if (goal?.state === "todo") {
			await getGoalManagerForGoal(goal.id).updateGoal(goal.id, { state: "in-progress" });
		}

		const { sessionFileCopy, CrossRealmCopyError } = await import("./agent/session-fs.js");
		const { formatAgentSessionFilePath } = await import("./agent/agent-session-path.js");
		const { copyToolContentDirIfPresent, copyProposalDirIfPresent, cleanupFailedContinue } = await import("./agent/continue-archived.js");

		// Resolve the source `.jsonl`, with the recovery-scan fallback for legacy
		// rows that never persisted `agentSessionFile`.
		let sourceJsonl = ps.agentSessionFile;
		if (!sourceJsonl) {
			const recovered = sessionManager.recoverSessionFile(ps);
			if (recovered) sourceJsonl = recovered;
		}
		if (!sourceJsonl) { json({ error: "source transcript missing or empty" }, 404); return; }
		if (!ps.sandboxed) {
			try {
				const st = fs.statSync(sourceJsonl);
				if (!st.isFile() || st.size === 0) { json({ error: "source transcript missing or empty" }, 404); return; }
			} catch {
				json({ error: "source transcript missing or empty" }, 404);
				return;
			}
		}

		const projCwd = projectRegistry.get(projectId)!.rootPath;
		const forkId = randomUUID();
		// Use the project root for the cloned `.jsonl` slug (same as /continue);
		// worktree-backed sessions rotate to the final cwd-derived file after the
		// worktree is ready, adopting this clone via switch_session.
		const destJsonl = formatAgentSessionFilePath(projCwd, Date.now(), forkId);

		const srcCtx = sessionFsContextForAgentFile(ps, sourceJsonl);
		const dstCtx = sessionFsContextForAgentFile({ sandboxed: !!ps.sandboxed, projectId }, destJsonl);
		try {
			await sessionFileCopy(srcCtx, sourceJsonl, dstCtx, destJsonl, sandboxManager ?? null);
		} catch (err) {
			if (err instanceof CrossRealmCopyError) { json({ error: "cross-realm fork not supported" }, 422); return; }
			cleanupFailedContinue(destJsonl, forkId, bobbitStateDir());
			jsonError(500, err, { error: `failed to clone session file: ${err instanceof Error ? err.message : String(err)}` });
			return;
		}
		try { copyToolContentDirIfPresent(sourceId, forkId, bobbitStateDir()); } catch (err) {
			console.warn(`[fork] tool-content copy failed (non-fatal): ${err}`);
		}
		try { copyProposalDirIfPresent(sourceId, forkId, bobbitStateDir()); } catch (err) {
			console.warn(`[fork] proposal-dir copy failed (non-fatal): ${err}`);
		}

		try {
			const launched = await launchSidebarSessionFork({
				forkId,
				projectId,
				projectRoot: projCwd,
				destJsonl,
				newWorktree,
				source,
				persisted: ps,
			}, {
				resolveNewWorktreeRepoPath: async projectRoot => {
					try {
						return await isGitRepo(projectRoot, serverCommandRunner)
							? await getRepoRoot(projectRoot, serverCommandRunner)
							: undefined;
					} catch {
						return undefined;
					}
				},
				buildCreateOptions: ({ worktreeOpts, oldTranscriptCwds }) => {
					const createOpts: any = {
						sessionId: forkId,
						projectId,
						sandboxed: !!ps.sandboxed,
						worktreeOpts,
						preExistingAgentSessionFile: destJsonl,
						preExistingAgentSessionOldCwds: oldTranscriptCwds,
						taskId: ps.taskId,
						reattemptGoalId: ps.reattemptGoalId,
						staffId: ps.staffId,
						allowedTools: ps.allowedTools,
					};
					if (ps.modelProvider && ps.modelId) createOpts.initialModel = `${ps.modelProvider}/${ps.modelId}`;
					if (ps.sandboxed && !worktreeOpts && !ps.goalId && !ps.assistantType) {
						createOpts.sandboxBranch = `session/${forkId.slice(0, 8)}`;
					}

					const staff = ps.staffId ? staffManager.getStaff(ps.staffId) : undefined;
					if (staff) {
						createOpts.rolePrompt = buildStaffSystemPrompt(staff, roleManager, resolveRoleForProject);
						createOpts.roleName = staff.roleId;
						createOpts.accessory = staff.accessory;
						createOpts.env = { BOBBIT_STAFF_ID: ps.staffId };
					} else {
						const role = ps.role ? resolveRoleForProject(ps.role, projectId) : undefined;
						if (role) {
							const opts = roleCreateOptions(role);
							if (createOpts.initialModel) delete opts.initialModel;
							Object.assign(createOpts, opts);
						} else if (ps.role) {
							createOpts.role = ps.role;
							createOpts.roleName = ps.role;
							if (ps.accessory) createOpts.accessory = ps.accessory;
						} else if (ps.accessory) {
							createOpts.accessory = ps.accessory;
						}
					}
					return createOpts;
				},
				createSession: ({ cwd, goalId, assistantType, options }) => sessionManager.createSession(cwd, undefined, goalId, assistantType, options),
				setTitle: (sessionId, title) => sessionManager.setTitle(sessionId, title, { markGenerated: true }),
			});
			if (ps.staffId) launched.fork.staffId = ps.staffId;
			json({
				id: launched.fork.id,
				cwd: launched.fork.cwd,
				status: launched.fork.status,
				projectId: launched.projectId,
				goalId: launched.goalId,
				title: launched.title,
			}, 201);
		} catch (err) {
			cleanupFailedContinue(destJsonl, forkId, bobbitStateDir());
			jsonError(500, err, { error: `failed to fork session: ${err instanceof Error ? err.message : String(err)}` });
		}
		return;
	}

	// POST /api/sessions/:id/prompt — prompt or steer any live session by id.
	const sessionPromptMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/prompt$/);
	if (sessionPromptMatch && req.method === "POST") {
		const targetSessionId = sessionPromptMatch[1];
		const body = await readBody(req);
		if (typeof body?.message !== "string") {
			json({ error: "Missing message" }, 400);
			return;
		}
		const h = req.headers as Record<string, string | string[] | undefined>;
		const secretHeader = h["x-bobbit-session-secret"];
		const secret = Array.isArray(secretHeader) ? secretHeader[0] : secretHeader;
		const callerSessionId = sessionManager.sessionSecretStore.resolveSessionIdBySecret(
			typeof secret === "string" && secret.trim() ? secret.trim() : undefined,
		);
		const callerSession = callerSessionId ? sessionManager.getSession(callerSessionId) : undefined;
		if (!callerSession || callerSession.status === "terminated") {
			json({ error: "Valid caller session secret is required", code: "SESSION_SECRET_REQUIRED" }, 403);
			return;
		}
		const callerAllowedTools = callerSession.allowedTools ?? [];
		if (!callerAllowedTools.some((tool) => tool.toLowerCase() === "session_prompt")) {
			json({ error: 'Tool "session_prompt" is not allowed for this session', code: "SESSION_PROMPT_NOT_ALLOWED" }, 403);
			return;
		}
		// Pause guard: reject if the target session's goal is paused.
		const sessionPromptTarget = sessionManager.getSession(targetSessionId);
		const sessionPromptGoalId = sessionPromptTarget?.goalId ?? sessionPromptTarget?.teamGoalId;
		if (sessionPromptGoalId) {
			const sessionPromptGoal = getGoalAcrossProjects(sessionPromptGoalId);
			if (sessionPromptGoal?.paused) {
				json({ error: "Goal is paused — resume it before sending prompts", code: "GOAL_PAUSED", goalId: sessionPromptGoalId }, 409);
				return;
			}
		}
		try {
			const result = await deliverSessionPrompt({
				getSession: (id) => sessionManager.getSession(id),
				enqueuePrompt: (id, text, opts) => sessionManager.enqueuePrompt(id, text, opts),
				deliverLiveSteer: (id, text, opts) => sessionManager.deliverLiveSteer(id, text, opts),
				getErroredPromptRecoveryDecision: (id) => sessionManager.getErroredPromptRecoveryDecision(id),
				enqueuePromptForRetryRecovery: (id, text, opts) => sessionManager.enqueuePromptForRetryRecovery(id, text, opts),
				retryLastPrompt: (id, opts) => sessionManager.retryLastPrompt(id, opts),
			}, targetSessionId, body.message, { mode: body.mode, defaultMode: "prompt" });
			json(result);
		} catch (err) {
			if (err instanceof SessionPromptDeliveryError) {
				json({ error: err.message, code: err.code }, err.status);
			} else {
				jsonError(500, err);
			}
		}
		return;
	}

	// POST /api/sessions/:id/wait — block until session becomes idle.
	// Uses chunked transfer with periodic heartbeat newlines to prevent
	// HTTP client body-timeout (undici defaults to 300s between chunks).
	const waitMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/wait$/);
	if (waitMatch && req.method === "POST") {
		const id = waitMatch[1];
		const body = await readBody(req);
		const timeoutMs = body?.timeout_ms ?? 600_000;

		// Stream chunked response with heartbeat to keep connection alive
		res.writeHead(200, {
			"Content-Type": "application/json",
			"Transfer-Encoding": "chunked",
			"Cache-Control": "no-cache",
		});

		// Send a heartbeat newline every 60s to prevent client body-timeout
		const heartbeat = setInterval(() => {
			const diagEnabled = cpuDiagnosticsEnabled();
			const diagStart = diagEnabled ? performance.now() : 0;
			try {
				res.write("\n");
				if (diagEnabled) getCpuDiagnostics().recordTimer("rest:waitHeartbeat", performance.now() - diagStart, { writes: 1 });
			} catch {
				if (diagEnabled) getCpuDiagnostics().recordTimer("rest:waitHeartbeat", performance.now() - diagStart, { errors: 1 });
			}
		}, 60_000);

		try {
			await sessionManager.waitForIdle(id, timeoutMs);
			const output = await sessionManager.getSessionOutput(id);
			const session = sessionManager.getSession(id);
			res.end(JSON.stringify({
				status: session?.status || "idle",
				output,
			}));
		} catch (err) {
			res.end(JSON.stringify({ error: String(err) }));
		} finally {
			clearInterval(heartbeat);
		}
		return;
	}

	// ──────────────────────────────────────────────────────────────────────────
	// OrchestrationCore agent-tool routes (docs/design/orchestration-core.md §8.2).
	//
	// `:id` is the OWNER session. The unified `team_*` agent tools call these via
	// _shared/gateway.ts; the server invokes `orchestrationCore.*` IN-PROCESS with
	// server-enforced own-children scoping (a verb only touches a child returned by
	// orchestrationCore.list(ownerId)). The pack-side `host.agents` capability
	// (sub-goal C) calls the SAME core through a different in-process path.
	// ──────────────────────────────────────────────────────────────────────────
	const orchestrateMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/orchestrate\/([a-z]+)$/);
	if (orchestrateMatch && (req.method === "POST" || req.method === "GET")) {
		const ownerId = orchestrateMatch[1];
		const verb = orchestrateMatch[2];

		// ── Caller→owner authorization (S1) ─────────────────────────────────────
		// The shared gateway bearer only proves "some token-holder"; it does NOT
		// prove the caller IS `ownerId`. Without this, any agent could enumerate /
		// prompt / steer / abort / dismiss a FOREIGN owner's children (including
		// team workers, which team-manager registers under the team-lead session
		// id) — bypassing the authz `/api/goals/:id/team/*` enforces and violating
		// the goal's "no method drives a foreign session" constraint. Bind the
		// request to the unforgeable per-session secret and require the AUTHENTIC
		// caller to BE the owner. Mirrors the children-mutation authz pattern
		// (see session-secret.ts + the spawn-child / archive-child routes).
		{
			const h = req.headers as Record<string, string | string[] | undefined>;
			const secretHeader = h["x-bobbit-session-secret"];
			const secret = Array.isArray(secretHeader) ? secretHeader[0] : secretHeader;
			const authenticCaller = sessionManager.sessionSecretStore.resolveSessionIdBySecret(
				typeof secret === "string" && secret.trim() ? secret.trim() : undefined,
			);
			if (!authenticCaller || authenticCaller !== ownerId) {
				if (verb === "dismiss") {
					const deniedBody = await readBody(req).catch(() => ({}));
					const targetId = typeof deniedBody?.childSessionId === "string" ? deniedBody.childSessionId : "unknown";
					json({ ok: false, status: "not-owned", sessionId: targetId, message: "Caller session is not the owner of these child agents", retryable: false }, 403);
					return;
				}
				json({ error: "Caller session is not the owner of these child agents", code: "NOT_OWNER" }, 403);
				return;
			}
		}

		// Map OrchestrationCore error codes → HTTP status.
		const ocStatus = (err: unknown): number => {
			if (err instanceof SessionPromptDeliveryError) return err.status;
			if (err instanceof OrchestrationCoreError) {
				if (err.code === "NOT_STREAMING") return 409;
				if (err.code === "NOT_OWN_CHILD" || err.code === "NO_GRANDCHILDREN") return 403;
				return 400;
			}
			return 500;
		};

		// GET /api/sessions/:id/orchestrate/children — list owner's tracked children.
		if (verb === "children" && req.method === "GET") {
			json({ children: orchestrationCore.list(ownerId) });
			return;
		}

		if (req.method !== "POST") { json({ error: "Method not allowed" }, 405); return; }
		const body = await readBody(req).catch(() => ({}));

		try {
			// POST /orchestrate/spawn — non-blocking spawn (single or parallel).
			if (verb === "spawn") {
				const lifecycle: "full" | undefined = body?.lifecycle === "full" ? "full" : undefined;
				const baseOpts = {
					ownerSessionId: ownerId,
					role: typeof body?.role === "string" ? body.role : undefined,
					model: typeof body?.model === "string" ? body.model : undefined,
					thinkingLevel: typeof body?.thinking_level === "string" ? body.thinking_level : undefined,
					readOnly: body?.read_only === true,
					lifecycle,
				};
				const spawnSet: Array<{ instructions: string; context?: Record<string, string> }> =
					Array.isArray(body?.parallel) && body.parallel.length > 0
						? body.parallel.map((p: any) => ({ instructions: String(p.instructions ?? ""), context: p.context }))
						: [{ instructions: String(body?.instructions ?? ""), context: body?.context }];
				const children = [];
				for (const item of spawnSet) {
					const handle = await orchestrationCore.spawn({
						...baseOpts,
						instructions: item.instructions,
						context: { ...(body?.context ?? {}), ...(item.context ?? {}) },
					});
					children.push({ childSessionId: handle.sessionId, childKind: handle.childKind, title: handle.title });
				}
				json({ children, childSessionId: children[0]?.childSessionId }, 201);
				return;
			}

			// POST /orchestrate/prompt — default steer delivery; mode:"prompt" preserves queue semantics.
			if (verb === "prompt") {
				if (!body?.childSessionId || typeof body?.message !== "string") { json({ error: "Missing childSessionId or message" }, 400); return; }
				const result = await orchestrationCore.prompt(ownerId, body.childSessionId, body.message, { mode: body.mode });
				json(result);
				return;
			}

			// POST /orchestrate/steer — mid-turn steer (409 if child not streaming).
			if (verb === "steer") {
				if (!body?.childSessionId || typeof body?.message !== "string") { json({ error: "Missing childSessionId or message" }, 400); return; }
				await orchestrationCore.steer(ownerId, body.childSessionId, body.message);
				json({ ok: true, dispatched: true });
				return;
			}

			// POST /orchestrate/abort — force-abort own child.
			if (verb === "abort") {
				if (!body?.childSessionId) { json({ error: "Missing childSessionId" }, 400); return; }
				await orchestrationCore.abort(ownerId, body.childSessionId);
				const after = sessionManager.getSession(body.childSessionId);
				json({ ok: true, status: after?.status || "idle" });
				return;
			}

			// POST /orchestrate/dismiss — terminate + archive own child.
			if (verb === "dismiss") {
				if (!body?.childSessionId) { json({ error: "Missing childSessionId" }, 400); return; }
				const result = await orchestrationCore.dismiss(ownerId, body.childSessionId);
				json(result, dismissHttpStatus(result));
				return;
			}

			// POST /orchestrate/wait — policy:"first"; chunked heartbeat like /wait.
			if (verb === "wait") {
				const timeoutMs = body?.timeout_ms ?? 600_000;
				// Default (no explicit ids) excludes `childKind:"team"` workers: a team
				// lead's goal members are NOT waited on via team_wait — they are
				// notify-managed by the team-manager (worker-idle nudge), and the lead is
				// meant to spawn-then-go-idle, not block. Mirrors the restart reminder's
				// `childKind!=="team"` filter (orchestration-core remindOwnersWithLiveChildren).
				// An EXPLICIT childSessionIds list is still honored verbatim (own-child
				// scoping is enforced by orchestrationCore.wait → requireOwnChild). Without
				// this, a lead that called team_wait after team_spawn blocked for the whole
				// worker lifetime and never went idle.
				const childIds: string[] = Array.isArray(body?.childSessionIds) && body.childSessionIds.length > 0
					? body.childSessionIds.map((s: any) => String(s))
					: orchestrationCore.list(ownerId).filter(h => h.childKind !== "team").map(h => h.sessionId);
				if (childIds.length === 0) { json({ error: "No children to await" }, 400); return; }
				res.writeHead(200, { "Content-Type": "application/json", "Transfer-Encoding": "chunked", "Cache-Control": "no-cache" });
				const heartbeat = setInterval(() => { try { res.write("\n"); } catch { /* ignore */ } }, 60_000);
				try {
					const result = await orchestrationCore.wait(ownerId, childIds, { policy: "first", timeoutMs });
					res.end(JSON.stringify({ ...result, text: formatWaitText(result) }));
				} catch (err) {
					res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
				} finally {
					clearInterval(heartbeat);
				}
				return;
			}

			// POST /orchestrate/delegate — the pinned BLOCKING contract (§8.2.1).
			// spawn (single or parallel) → wait(policy:"all") with terminal mapping
			// → auto-dismiss EVERY child in finally → aggregate. Always 2xx once
			// children settle; server owns the chunked heartbeat (undici parity).
			if (verb === "delegate") {
				const timeoutMs = body?.timeout_ms ?? 600_000;
				// Reject empty/missing instructions (and empty `parallel`) up front for
				// direct callers — matches the team_delegate tool wrapper's guard.
				const hasParallel = Array.isArray(body?.parallel) && body.parallel.length > 0;
				if (!hasParallel && (typeof body?.instructions !== "string" || !body.instructions.trim())) {
					json({ error: "Missing 'instructions' (or provide a non-empty 'parallel' array)" }, 400);
					return;
				}
				if (hasParallel && body.parallel.some((p: any) => typeof p?.instructions !== "string" || !p.instructions.trim())) {
					json({ error: "Each 'parallel' entry requires non-empty 'instructions'" }, 400);
					return;
				}
				const spawnSet: Array<{ instructions: string; context?: Record<string, string> }> =
					hasParallel
						? body.parallel.map((p: any) => ({ instructions: String(p.instructions ?? ""), context: p.context }))
						: [{ instructions: String(body?.instructions ?? ""), context: body?.context }];
				const lifecycle: "full" | undefined = body?.lifecycle === "full" ? "full" : undefined;

				res.writeHead(200, { "Content-Type": "application/json", "Transfer-Encoding": "chunked", "Cache-Control": "no-cache" });
				const heartbeat = setInterval(() => { try { res.write("\n"); } catch { /* ignore */ } }, 60_000);
				const startTime = Date.now();
				const handles: Array<{ sessionId: string } | null> = [];
				let responsePayload: unknown;
				try {
					// Spawn the full set. assertCanSpawn / spawn failures become a
					// failed delegate entry rather than aborting the others.
					const spawnErrors: Array<string | undefined> = [];
					for (const item of spawnSet) {
						try {
							const handle = await orchestrationCore.spawn({
								ownerSessionId: ownerId,
								instructions: item.instructions,
								role: typeof body?.role === "string" ? body.role : undefined,
								model: typeof body?.model === "string" ? body.model : undefined,
								thinkingLevel: typeof body?.thinking_level === "string" ? body.thinking_level : undefined,
								readOnly: body?.read_only === true,
								lifecycle,
								context: { ...(body?.context ?? {}), ...(item.context ?? {}) },
							});
							handles.push({ sessionId: handle.sessionId });
							spawnErrors.push(undefined);
						} catch (err) {
							handles.push(null);
							spawnErrors.push(err instanceof Error ? err.message : String(err));
						}
					}
					const liveIds = handles.filter((h): h is { sessionId: string } => !!h).map(h => h.sessionId);
					const waitResult = liveIds.length > 0
						? await orchestrationCore.wait(ownerId, liveIds, { policy: "all", timeoutMs })
						: { statuses: [], remaining: 0 } as Awaited<ReturnType<typeof orchestrationCore.wait>>;
					const statusById = new Map(waitResult.statuses.map(s => [s.sessionId, s.status]));

					const delegates = [];
					for (let i = 0; i < handles.length; i++) {
						const h = handles[i];
						if (!h) {
							delegates.push({ id: "error", sessionId: "", status: "failed", output: "", durationMs: Date.now() - startTime, error: spawnErrors[i] });
							continue;
						}
						const childStatus = statusById.get(h.sessionId);
						const status = childStatus === "idle" ? "completed"
							: childStatus === "timeout" ? "timeout"
							: childStatus === "terminated" ? "terminated"
							: "failed";
						const output = await sessionManager.getSessionOutput(h.sessionId).catch(() => "");
						delegates.push({ id: h.sessionId.slice(0, 12), sessionId: h.sessionId, status, output, durationMs: Date.now() - startTime });
					}
					const completed = delegates.filter(d => d.status === "completed").length;
					const summary = `${completed}/${delegates.length} delegates completed.`;
					responsePayload = { delegates, summary };
				} catch (err) {
					responsePayload = { delegates: [], summary: "", error: String(err instanceof Error ? err.message : err) };
				} finally {
					// Guaranteed cleanup — dismiss EVERY spawned child before the blocking
					// response completes. Ending the chunked response first races callers that
					// immediately list children and violates team_delegate's auto-dismiss contract.
					for (const h of handles) {
						if (h) { try { await orchestrationCore.dismiss(ownerId, h.sessionId); } catch { /* already gone */ } }
					}
					clearInterval(heartbeat);
				}
				res.end(JSON.stringify(responsePayload ?? { delegates: [], summary: "", error: "Delegate route ended without a result." }));
				return;
			}

			json({ error: `Unknown orchestrate verb: ${verb}` }, 404);
		} catch (err) {
			const status = ocStatus(err);
			json({ error: String(err instanceof Error ? err.message : err), code: err instanceof Error ? (err as { code?: string }).code : undefined }, status);
		}
		return;
	}

	// ── SUB-GOAL B SEAM (orchestration-core §6.1) ──────────────────────────────
	// GET /api/sessions/:id/children-count — child agents that would be
	// cascade-archived if this (non-goal) session is archived. Enumerated with
	// the SAME predicate AND the SAME source set `cascadeReapOwner` uses: ALL
	// live persisted sessions across projects (`getAllLiveSessions()`), NOT just
	// in-memory ones — so DORMANT persisted children (e.g. delegate children
	// deferred on boot, archived by the cascade only at runtime) are included in
	// the count and the listed names. The modal lists these before the user
	// confirms. The goal-archival path enumerates affected sessions separately
	// and is untouched.
	const childrenCountMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/children-count$/);
	if (childrenCountMatch && req.method === "GET") {
		const id = decodeURIComponent(childrenCountMatch[1]);
		// Prefer the cross-project persisted source (mirrors cascadeReapOwner's
		// `getAllLiveSessions()` enumeration, which includes dormant children);
		// fall back to in-memory sessions when no project context is available.
		const source = projectContextManager
			? projectContextManager.getAllLiveSessions()
			: sessionManager.listSessions();
		const seen = new Set<string>();
		const children: Array<{ id: string; title: string; childKind?: string }> = [];
		for (const s of source) {
			if (s.id === id || seen.has(s.id)) continue;
			if (s.delegateOf === id || (!!s.childKind && s.parentSessionId === id)) {
				seen.add(s.id);
				children.push({ id: s.id, title: s.title, childKind: s.childKind });
			}
		}
		json({ count: children.length, children });
		return;
	}
	// ───────────────────────────────────────────────────────────────────────────

	// POST /api/sessions/:archivedId/continue — Continue-Archived (lossless)
	//
	// Clones the archived session's `.jsonl` into a fresh slot, registers it
	// as the new session's `agentSessionFile`, and lets the agent CLI rehydrate
	// from it via `switch_session` — same mechanism the restart-resume path
	// uses for live sessions. No transcript stringification, no system-prompt
	// seeding, no byte budget.
	const continueMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/continue$/);
	if (continueMatch && req.method === "POST") {
		const archivedId = continueMatch[1];
		// Body is read for parity but no fields are required — the legacy `mode`
		// parameter is ignored.
		await readBody(req).catch(() => ({}));

		// Resolve the archived session across all project contexts.
		const ps = sessionManager.getPersistedSession(archivedId);
		if (!ps) { json({ error: "session not found" }, 404); return; }
		if (!ps.archived) { json({ error: "source not archived" }, 409); return; }
		if (ps.goalId || ps.delegateOf || ps.teamGoalId) {
			json({ error: "goal, delegate, or team sessions cannot be continued" }, 422);
			return;
		}
		if (!ps.projectId || !projectRegistry.get(ps.projectId)) {
			json({ error: "source project no longer registered" }, 410);
			return;
		}

		// Resolve source `.jsonl` path — fall back to the recovery scan for legacy
		// sessions whose persisted `agentSessionFile` was never populated.
		const { sessionFileCopy, CrossRealmCopyError } = await import("./agent/session-fs.js");
		const { formatAgentSessionFilePath } = await import("./agent/agent-session-path.js");
		const { copyToolContentDirIfPresent, copyProposalDirIfPresent, cleanupFailedContinue } = await import("./agent/continue-archived.js");
		const nodeFs = await import("node:fs");
		const { randomUUID } = await import("node:crypto");

		let sourceJsonl = ps.agentSessionFile;
		if (!sourceJsonl) {
			const recovered = sessionManager.recoverSessionFile(ps);
			if (recovered) sourceJsonl = recovered;
		}
		if (!sourceJsonl) {
			json({ error: "archived transcript missing or empty" }, 404);
			return;
		}

		// Verify the source file actually exists and is non-empty. For non-sandboxed
		// sessions a quick host-side stat suffices; sandboxed sessions defer to the
		// copy step (which surfaces the failure as a 500). Empty / missing → 404.
		if (!ps.sandboxed) {
			try {
				const st = nodeFs.statSync(sourceJsonl);
				if (!st.isFile() || st.size === 0) {
					json({ error: "archived transcript missing or empty" }, 404);
					return;
				}
			} catch {
				json({ error: "archived transcript missing or empty" }, 404);
				return;
			}
		}

		const proj = projectRegistry.get(ps.projectId)!;
		const projCwd = proj.rootPath;
		const wantWorktree = !!ps.worktreePath;
		let worktreeOpts: { repoPath: string } | undefined;
		if (wantWorktree) {
			const projCtx = projectContextManager.getOrCreate(ps.projectId);
			const components = projCtx?.projectConfigStore.getComponents() ?? [];
			const configuredBaseRef = projCtx?.projectConfigStore.get("base_ref") || undefined;
			const support = await resolveWorktreeSupport(components, proj.rootPath, projCwd, undefined, { configuredBaseRef, commandRunner: serverCommandRunner });
			if (!support.supported || !support.repoPath) {
				json({
					error: "failed to resolve current project repository for fresh continue worktree creation: project does not currently support git worktrees",
				}, 500);
				return;
			}
			worktreeOpts = { repoPath: support.repoPath };
		}

		// Pre-compute the cloned `.jsonl` path. We use the project root cwd here;
		// for worktree-backed sessions the agent CLI will rotate to a new file
		// once the worktree cwd is final, but the cloned file we hand it via
		// `switch_session` is what gets adopted.
		const newSessionId = randomUUID();
		const destJsonl = formatAgentSessionFilePath(projCwd, Date.now(), newSessionId);

		// Copy the source `.jsonl`. Cross-realm → 422; any other failure → 500.
		const srcCtx = sessionFsContextForAgentFile(ps, sourceJsonl);
		const dstCtx = sessionFsContextForAgentFile(ps, destJsonl);
		try {
			await sessionFileCopy(srcCtx, sourceJsonl, dstCtx, destJsonl, sandboxManager ?? null);
		} catch (err) {
			if (err instanceof CrossRealmCopyError) {
				json({ error: "cross-realm continue not supported" }, 422);
				return;
			}
			cleanupFailedContinue(destJsonl, newSessionId, bobbitStateDir());
			jsonError(500, err, { error: `failed to clone session file: ${err instanceof Error ? err.message : String(err)}` });
			return;
		}

		// Defensive forward-compat: copy the lazy tool-content cache if present.
		try {
			copyToolContentDirIfPresent(archivedId, newSessionId, bobbitStateDir());
		} catch (err) {
			console.warn(`[continue-archived] tool-content copy failed (non-fatal): ${err}`);
		}

		// Clone the proposal-draft directory (live file + history snapshots).
		// Schema-agnostic recursive copy — see `proposal-files.ts` for layout.
		// On WS auth the rehydrate broadcast iterates the new session's dir and
		// feeds the panel automatically; no extra wiring needed here.
		try {
			copyProposalDirIfPresent(archivedId, newSessionId, bobbitStateDir());
		} catch (err) {
			console.warn(`[continue-archived] proposal-dir copy failed (non-fatal): ${err}`);
		}

		const role = ps.role ? resolveRoleForProject(ps.role, ps.projectId) : undefined;
		const oldTranscriptCwds = Array.from(new Set([ps.cwd, ps.worktreePath]
			.filter((v): v is string => typeof v === "string" && v.length > 0)));
		const createOpts: any = {
			sessionId: newSessionId,
			projectId: ps.projectId,
			sandboxed: !!ps.sandboxed,
			worktreeOpts,
			preExistingAgentSessionFile: destJsonl,
			preExistingAgentSessionOldCwds: oldTranscriptCwds,
			// Continue must surface fresh worktree/base-ref setup failures synchronously;
			// the archived source worktree/branch remain provenance only. Non-sandboxed
			// continues use the normal project worktree-pool claim/fallback path; sandboxed
			// continues keep bypassing the host-side pool because container worktrees are isolated.
			awaitWorktreeSetup: !!worktreeOpts,
			bypassWorktreePool: !!worktreeOpts && !!ps.sandboxed,
		};
		// Pin the persisted model at spawn time so pi-coding-agent doesn't emit a
		// redundant initial `model_change` event with its hardcoded default.
		if (ps.modelProvider && ps.modelId) {
			createOpts.initialModel = `${ps.modelProvider}/${ps.modelId}`;
		}
		if (role) {
			const opts = roleCreateOptions(role);
			if (createOpts.initialModel) delete opts.initialModel;
			Object.assign(createOpts, opts);
		} else if (ps.role) {
			// Persisted role name without a registered Role definition (e.g. the
			// generic "assistant" role assigned to assistant sessions). Propagate
			// it + the persisted accessory so the new session inherits its identity.
			createOpts.role = ps.role;
			createOpts.roleName = ps.role;
			if (ps.accessory) createOpts.accessory = ps.accessory;
		} else if (ps.accessory) {
			createOpts.accessory = ps.accessory;
		}

		let newSession;
		try {
			newSession = await sessionManager.createSession(
				projCwd, undefined, undefined, ps.assistantType, createOpts,
			);
		} catch (err) {
			const failedRecord = sessionManager.getPersistedSession(newSessionId);
			cleanupFailedContinue(failedRecord?.agentSessionFile || destJsonl, newSessionId, bobbitStateDir());
			if (failedRecord?.agentSessionFile && failedRecord.agentSessionFile !== destJsonl) {
				cleanupFailedContinue(destJsonl, newSessionId, bobbitStateDir());
			}
			jsonError(500, err, { error: `failed to create session: ${err instanceof Error ? err.message : String(err)}` });
			return;
		}

		const baseTitle = (ps.title || "session").trim() || "session";
		const continuedTitle = `Continued: ${baseTitle}`;
		// markGenerated: prevents the first-message auto-titler from overwriting
		// "Continued: …" once the user sends their first prompt in the new session.
		sessionManager.setTitle(newSession.id, continuedTitle, { markGenerated: true });

		json({
			id: newSession.id,
			cwd: newSession.cwd,
			status: newSession.status,
			title: continuedTitle,
			assistantType: ps.assistantType,
		}, 201);
		return;
	}

	// GET /api/sessions/:id/output — get final assistant output
	const outputMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/output$/);
	if (outputMatch && req.method === "GET") {
		const id = outputMatch[1];
		try {
			const output = await sessionManager.getSessionOutput(id);
			json({ output });
		} catch {
			json({ error: "Failed to get output" }, 500);
		}
		return;
	}

	// PATCH /api/sessions/:id — update session properties (title, colorIndex, etc.)
	const patchMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
	if (patchMatch && req.method === "PATCH") {
		const id = patchMatch[1];
		const body = await readBody(req);
		if (!body || typeof body !== "object") {
			json({ error: "Invalid body" }, 400);
			return;
		}

		if (typeof body.title === "string") {
			const ok = sessionManager.setTitle(id, body.title);
			if (!ok) { json({ error: "Session not found" }, 404); return; }
		}

		if (typeof body.colorIndex === "number") {
			if (body.colorIndex < 0 || body.colorIndex > 13) {
				json({ error: "colorIndex must be 0-13" }, 400);
				return;
			}
			colorStore.set(id, body.colorIndex);
		}

		if (typeof body.projectId === "string") {
			const session = sessionManager.getSession(id);
			if (!session) { json({ error: "Session not found" }, 404); return; }
			const oldProjectId = session.projectId;
			const newProjectId = body.projectId || undefined;
			session.projectId = newProjectId;
			// Update in both old and new project stores to ensure consistency
			sessionManager.getSessionStore(oldProjectId).update(id, { projectId: newProjectId });
			if (newProjectId !== oldProjectId) {
				sessionManager.getSessionStore(newProjectId).update(id, { projectId: newProjectId });
			}
		}

		if (typeof body.preview === "boolean") {
			const session = sessionManager.getSession(id);
			if (!session) { json({ error: "Session not found" }, 404); return; }
			session.preview = body.preview;
			sessionManager.persistSessionMetadata(session).catch(() => {});
			broadcastToAll({ type: "preview_changed", sessionId: id, preview: body.preview });
		}

		if (typeof body.roleId === "string" && body.roleId !== "") {
			const session = sessionManager.getSession(id);
			const ps = sessionManager.getPersistedSession(id);
			const role = resolveRoleForProject(body.roleId, session?.projectId ?? ps?.projectId);
			if (!role) { json({ error: `Role "${body.roleId}" not found` }, 404); return; }
			try {
				const ok = await sessionManager.assignRole(id, role);
				if (!ok) { json({ error: "Session not found" }, 404); return; }
			} catch (err) {
				jsonError(400, err);
				return;
			}
		} else if (typeof body.roleId === "string" && body.roleId === "") {
			// Clear role assignment
			const session = sessionManager.getSession(id);
			if (session) {
				session.role = undefined;
				session.accessory = undefined;
				sessionManager.persistSessionMetadata(session).catch(() => {});
			}
		}

		if (typeof body.assistantType === "string" || typeof body.goalAssistant === "boolean" || typeof body.goalId === "string") {
			const session = sessionManager.getSession(id);
			if (!session) { json({ error: "Session not found" }, 404); return; }
			if (typeof body.assistantType === "string") session.assistantType = body.assistantType || undefined;
			else if (typeof body.goalAssistant === "boolean") session.assistantType = body.goalAssistant ? "goal" : undefined;
			if (typeof body.goalId === "string") session.goalId = body.goalId;
			sessionManager.persistSessionMetadata(session).catch(() => {});
		}

		if (typeof body.accessory === "string") {
			const session = sessionManager.getSession(id);
			if (session) {
				session.accessory = body.accessory || undefined;
				sessionManager.persistSessionMetadata(session).catch(() => {});
			}
		}

		if (typeof body.delegateOf === "string") {
			const session = sessionManager.getSession(id);
			if (session) {
				session.delegateOf = body.delegateOf || undefined;
				sessionManager.updateSessionMeta(id, { delegateOf: body.delegateOf || undefined });
			} else {
				sessionManager.updateSessionMeta(id, { delegateOf: body.delegateOf || undefined });
			}
		}


		if (typeof body.teamLeadSessionId === "string") {
			// Update teamLeadSessionId — works for both live and archived sessions
			const session = sessionManager.getSession(id);
			if (session) {
				sessionManager.updateSessionMeta(id, { teamLeadSessionId: body.teamLeadSessionId });
			} else {
				// Try archived session — update store directly
				const archived = sessionManager.getArchivedSession(id);
				if (archived) {
					sessionManager.updateArchivedMeta(id, { teamLeadSessionId: body.teamLeadSessionId });
				} else {
					json({ error: "Session not found" }, 404); return;
				}
			}
		}

		if (body.archived === true) {
			// Try to terminate live session first (which archives it)
			const session = sessionManager.getSession(id);
			if (session) {
				try { await sessionManager.terminateSession(id); } catch {}
			} else {
				// Dormant/store-only session — archive directly in the store
				await sessionManager.storeArchive(id);
			}
		}

		json({ ok: true });
		return;
	}

	// POST /api/sessions/:id/mark-read — record that the user viewed this session
	const markReadMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/mark-read$/);
	if (markReadMatch && req.method === "POST") {
		const id = markReadMatch[1];
		const ok = sessionManager.markSessionRead(id);
		if (!ok) { json({ error: "session not found" }, 404); return; }
		json({ ok: true });
		return;
	}

	// ── Editable proposals (file-on-disk source of truth) ──────────────
	// docs/design/editable-proposals.md §6.4
	const proposalRouteMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/proposal\/([^/]+)(\/edit|\/seed|\/restore|\/snapshot)?$/);
	if (proposalRouteMatch) {
		const sessionId = proposalRouteMatch[1];
		const typeStr = proposalRouteMatch[2];
		const suffix = proposalRouteMatch[3] || "";
		if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
			json({ error: "Invalid sessionId" }, 400);
			return;
		}
		if (!isProposalType(typeStr)) {
			json({ error: `Unknown proposal type: ${typeStr}` }, 400);
			return;
		}
		const proposalType = typeStr as ProposalType;
		const proposalStateDir = bobbitStateDir();

		// GET /api/sessions/:id/proposal/:type — read raw file
		if (suffix === "" && req.method === "GET") {
			try {
				const content = await readProposalFile(proposalStateDir, sessionId, proposalType);
				if (content === undefined) {
					json({ ok: false, code: "FILE_NOT_FOUND", message: `No ${proposalType} proposal draft. Call propose_${proposalType} first.` }, 404);
					return;
				}
				const contentType = proposalType === "goal" ? "text/markdown; charset=utf-8" : "application/yaml; charset=utf-8";
				res.writeHead(200, { "Content-Type": contentType });
				res.end(content);
			} catch (err) {
				json({ error: String((err as Error)?.message ?? err) }, 500);
			}
			return;
		}

		// GET /api/sessions/:id/proposal/:type/snapshot?rev=N — read a historical snapshot without mutating the live draft.
		if (suffix === "/snapshot" && req.method === "GET") {
			const revParam = url.searchParams.get("rev") || "";
			const rev = Number.parseInt(revParam, 10);
			if (!Number.isInteger(rev) || rev < 1 || String(rev) !== revParam) {
				json({ ok: false, code: "INVALID_BODY", message: "rev must be a positive integer" }, 400);
				return;
			}
			try {
				const content = await readSnapshot(proposalStateDir, sessionId, proposalType, rev);
				if (content === undefined) {
					json({ ok: false, code: "SNAPSHOT_NOT_FOUND", message: `No snapshot rev ${rev} for ${proposalType} proposal` }, 404);
					return;
				}
				const parsed = getProposalTypePlugin(proposalType).parse(content);
				if (!parsed.ok) {
					json(parsed, 400);
					return;
				}
				json({ ok: true, rev, fields: parsed.value.fields });
			} catch (err) {
				json({ error: String((err as Error)?.message ?? err) }, 500);
			}
			return;
		}

		// DELETE /api/sessions/:id/proposal/:type
		if (suffix === "" && req.method === "DELETE") {
			try {
				await deleteProposalFile(proposalStateDir, sessionId, proposalType);
				if (_broadcastToSession) {
					_broadcastToSession(sessionId, { type: "proposal_cleared", sessionId, proposalType });
				}
				res.writeHead(204);
				res.end();
			} catch (err) {
				json({ error: String((err as Error)?.message ?? err) }, 500);
			}
			return;
		}

		// POST /api/sessions/:id/proposal/:type/edit — surgical edit
		if (suffix === "/edit" && req.method === "POST") {
			const body = await readBody(req);
			if (!body || typeof body !== "object") {
				json({ ok: false, code: "INVALID_BODY", message: "body must be JSON object" }, 400);
				return;
			}
			const { old_text, new_text } = body as { old_text?: unknown; new_text?: unknown };
			if (typeof old_text !== "string" || typeof new_text !== "string") {
				json({ ok: false, code: "INVALID_BODY", message: "old_text and new_text must be strings" }, 400);
				return;
			}
			try {
				const result = await editProposalFile(proposalStateDir, sessionId, proposalType, old_text, new_text);
				if (!result.ok) {
					const status = result.code === "FILE_NOT_FOUND" ? 404 : 400;
					json(result, status);
					return;
				}
				if (_broadcastToSession) {
					_broadcastToSession(sessionId, {
						type: "proposal_update",
						sessionId,
						proposalType,
						fields: result.parsed.fields,
						rev: result.rev,
						streaming: false,
						source: "edit",
					});
				}
				json({ ok: true, newContent: result.newContent, rev: result.rev });
			} catch (err) {
				json({ error: String((err as Error)?.message ?? err) }, 500);
			}
			return;
		}

		// POST /api/sessions/:id/proposal/:type/seed — called from propose_* execute()
		if (suffix === "/seed" && req.method === "POST") {
			const body = await readBody(req);
			if (!body || typeof body !== "object") {
				json({ ok: false, code: "INVALID_BODY", message: "body must be JSON object" }, 400);
				return;
			}
			const args = (body as { args?: unknown }).args;
			if (!args || typeof args !== "object" || Array.isArray(args)) {
				json({ ok: false, code: "INVALID_BODY", message: "args must be an object" }, 400);
				return;
			}
			// Auto-inject parentGoalId for team-lead sessions proposing a goal,
			// but only when the current goal is actually allowed to spawn a child.
			// If subgoals are disabled globally or for this parent, an omitted
			// parentGoalId must remain omitted so accepting the proposal creates a
			// top-level goal instead of a hidden invalid child proposal.
			let enrichedArgs = args as Record<string, unknown>;
			// §1 cross-project target resolver — goal / staff / role / tool
			// (NOT project). Resolve the TARGET project uniformly so that the
			// tool path and direct API callers behave identically:
			//   explicit trimmed args.projectId wins;
			//   otherwise the session's project (system → headquarters).
			// The resolved target is validated against the registry and stamped
			// onto the draft, making `proposal.fields.projectId` the single
			// source of truth for acceptance routing. When projectId is omitted
			// this reduces to the previous behaviour byte-for-byte. `project`
			// proposals are excluded: their client acceptance mode and dispatch are
			// determined solely by `proposal.fields.projectId`; mutation endpoints
			// validate any dispatched explicit target as defense in depth.
			if (proposalType === "goal" || proposalType === "staff" || proposalType === "role" || proposalType === "tool") {
				const proposalSession = sessionManager.getSession(sessionId) ?? sessionManager.getPersistedSession(sessionId);
				const sessionProjectId = proposalSession?.projectId;
				const explicitProjectId = typeof enrichedArgs.projectId === "string" && enrichedArgs.projectId.trim().length > 0
					? enrichedArgs.projectId.trim()
					: undefined;
				const defaultProjectId = sessionProjectId === SYSTEM_PROJECT_ID ? HEADQUARTERS_PROJECT_ID : sessionProjectId;
				const targetProjectId = explicitProjectId ?? defaultProjectId;
				if (!targetProjectId) {
					json({ ok: false, code: "PROJECT_ID_REQUIRED", message: "projectId required for project-scoped proposals" }, 400);
					return;
				}
				const targetRecord = projectRegistry.get(targetProjectId);
				if (!targetRecord) {
					json({ ok: false, code: "UNKNOWN_PROJECT", message: `Unknown project: ${targetProjectId}` }, 422);
					return;
				}
				// A hidden/synthetic project (e.g. the `system` anchor) is never a
				// valid user-facing cross-project target. The system→headquarters
				// mapping above applies to the OMITTED default only; an EXPLICIT
				// projectId naming a hidden project must be rejected. Guarded on
				// `explicitProjectId` so a hidden target arriving via the session
				// default is unaffected (byte-for-byte default path preserved).
				if (explicitProjectId && targetRecord.hidden) {
					json({ ok: false, code: "UNKNOWN_PROJECT", message: `Project "${explicitProjectId}" is not a valid cross-project target.` }, 422);
					return;
				}
				enrichedArgs = { ...enrichedArgs, projectId: targetProjectId };
			}
			// Resolve workflow membership from the stamped TARGET project, then run
			// parent injection and validation through the state-independent core.
			if (proposalType === "goal") {
				const liveSession = sessionManager.getSession(sessionId);
				const projectId = (typeof enrichedArgs.projectId === "string" && enrichedArgs.projectId.trim().length > 0
					? enrichedArgs.projectId.trim()
					: undefined)
					?? (liveSession ?? sessionManager.getPersistedSession(sessionId))?.projectId;
				let workflows: import("./agent/workflow-store.js").Workflow[] = [];
				if (projectId) {
					workflows = configCascade.resolveWorkflows(projectId).map(r => r.item);
					if (workflows.length === 0) {
						const ctx = projectContextManager.getOrCreate(projectId);
						if (ctx) workflows = ctx.workflowStore.getAll();
					}
				}
				const prepared = prepareGoalProposalSeed(enrichedArgs, {
					session: liveSession,
					workflows,
					getGoal: (id) => getGoalAcrossProjects(id),
					getPreference: (key) => preferencesStore.get(key),
				});
				if (!prepared.ok) { json(prepared.body, prepared.status); return; }
				enrichedArgs = prepared.args;
			}
			try {
				const writeRes = await writeProposalFile(proposalStateDir, sessionId, proposalType, enrichedArgs);
				const parsed = await parseProposalFile(proposalStateDir, sessionId, proposalType);
				if (!parsed.ok) {
					json(parsed, 400);
					return;
				}
				const proposalLabel = proposalType.charAt(0).toUpperCase() + proposalType.slice(1);
				await openSidePanelWorkspaceTab({
					sessionManager,
					readBody,
					broadcastToSession: _broadcastToSession,
					packContributionRegistry,
				}, sessionId, {
					id: `proposal:${proposalType}`,
					kind: "proposal",
					title: `${proposalLabel} Proposal`,
					label: proposalLabel,
					source: { type: "proposal", sessionId, proposalType },
					updatedAt: Date.now(),
				}, { focus: true, placeAfterActive: true }).catch((err) => {
					console.warn(`[proposal/seed] failed to open side-panel workspace tab for ${sessionId}/${proposalType}:`, err);
				});
				if (_broadcastToSession) {
					_broadcastToSession(sessionId, {
						type: "proposal_update",
						sessionId,
						proposalType,
						fields: parsed.value.fields,
						rev: writeRes.rev,
						streaming: false,
						source: "seed",
					});
				}
				json({ ok: true, rev: writeRes.rev });
			} catch (err) {
				json({ error: String((err as Error)?.message ?? err) }, 500);
			}
			return;
		}

		// POST /api/sessions/:id/proposal/:type/restore — restore a snapshot
		if (suffix === "/restore" && req.method === "POST") {
			const body = await readBody(req);
			if (!body || typeof body !== "object") {
				json({ ok: false, code: "INVALID_BODY", message: "body must be JSON object" }, 400);
				return;
			}
			const rev = (body as { rev?: unknown }).rev;
			if (typeof rev !== "number" || !Number.isInteger(rev) || rev < 1) {
				json({ ok: false, code: "INVALID_BODY", message: "rev must be a positive integer" }, 400);
				return;
			}
			try {
				const result = await restoreSnapshot(proposalStateDir, sessionId, proposalType, rev);
				if (!result.ok) {
					const status = (result as any).code === "SNAPSHOT_NOT_FOUND" ? 404 : 400;
					json(result, status);
					return;
				}
				const proposalLabel = proposalType.charAt(0).toUpperCase() + proposalType.slice(1);
				await openSidePanelWorkspaceTab({
					sessionManager,
					readBody,
					broadcastToSession: _broadcastToSession,
					packContributionRegistry,
				}, sessionId, {
					id: `proposal:${proposalType}`,
					kind: "proposal",
					title: `${proposalLabel} Proposal`,
					label: proposalLabel,
					source: { type: "proposal", sessionId, proposalType },
					updatedAt: Date.now(),
				}, { focus: true, placeAfterActive: true }).catch((err) => {
					console.warn(`[proposal/restore] failed to open side-panel workspace tab for ${sessionId}/${proposalType}:`, err);
				});
				if (_broadcastToSession) {
					_broadcastToSession(sessionId, {
						type: "proposal_update",
						sessionId,
						proposalType,
						fields: result.fields,
						rev: result.newRev,
						streaming: false,
						source: "restore",
					});
				}
				json({ ok: true, newRev: result.newRev, fields: result.fields });
			} catch (err) {
				json({ error: String((err as Error)?.message ?? err) }, 500);
			}
			return;
		}

		json({ error: "Method not allowed" }, 405);
		return;
	}

	// GET /api/sessions/:id/proposals — list all parsed proposal drafts for the session.
	//
	// Mirrors the WS-auth `proposal_update {source:"rehydrate"}` broadcast in
	// `ws/handler.ts` but as a one-shot REST call. Used by the client's fast-path
	// session switch-back (no fresh WS auth fires, so the broadcast doesn't run
	// and the client's in-memory proposal slot would otherwise stay stale).
	const proposalsListMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/proposals$/);
	if (proposalsListMatch && req.method === "GET") {
		const sessionId = proposalsListMatch[1];
		if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
			json({ error: "Invalid sessionId" }, 400);
			return;
		}
		const stateDir = bobbitStateDir();
		try {
			const types = await listProposalFiles(stateDir, sessionId);
			const proposals: Array<{ proposalType: string; fields: Record<string, unknown>; rev: number }> = [];
			for (const proposalType of types) {
				const parsed = await parseProposalFile(stateDir, sessionId, proposalType);
				if (parsed.ok) {
					const rev = await latestRev(stateDir, sessionId, proposalType);
					proposals.push({ proposalType, fields: parsed.value.fields, rev });
				}
			}
			json({ proposals });
		} catch (err) {
			json({ error: String((err as Error)?.message ?? err) }, 500);
		}
		return;
	}

	// POST /api/sessions/:id/generate-title — auto-generate a title from chat history.
	// Works for live sessions (calls SessionManager.autoGenerateTitle) and archived
	// sessions (parses .jsonl). Used by the rename dialog when the session is not
	// the currently focused one (no live WebSocket).
	const genTitleMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/generate-title$/);
	if (genTitleMatch && req.method === "POST") {
		const id = genTitleMatch[1];
		try {
			const title = await sessionManager.generateTitleForAnySession(id);
			if (!title) {
				json({ error: "Could not generate title (session not found or no messages)" }, 404);
				return;
			}
			json({ title });
		} catch (err) {
			json({ error: String((err as Error)?.message ?? err) }, 500);
		}
		return;
	}

	// PUT /api/sessions/:id/title — legacy rename endpoint
	const titleMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/title$/);
	if (titleMatch && req.method === "PUT") {
		const id = titleMatch[1];
		const body = await readBody(req);
		const title = body?.title;
		if (!title || typeof title !== "string") {
			json({ error: "Missing title" }, 400);
			return;
		}
		const ok = sessionManager.setTitle(id, title);
		if (!ok) {
			json({ error: "Session not found" }, 404);
			return;
		}
		json({ ok: true });
		return;
	}

	// GET /api/connection-info — LAN addresses for multi-device access
	if (url.pathname === "/api/connection-info" && req.method === "GET") {
		const interfaces = await import("node:os").then((os) => os.networkInterfaces());
		const addresses: { ip: string; name: string }[] = [];
		for (const [name, addrs] of Object.entries(interfaces)) {
			if (!addrs) continue;
			for (const addr of addrs) {
				if (addr.family === "IPv4" && !addr.internal) {
					addresses.push({ ip: addr.address, name });
				}
			}
		}
		json({ addresses, port: config.port });
		return;
	}

	// GET /api/oauth/status
	if (url.pathname === "/api/oauth/status" && req.method === "GET") {
		try {
			json(oauthStatus(url.searchParams.get("provider") ?? undefined));
		} catch (err) {
			jsonError(400, err);
		}
		return;
	}

	// GET /api/oauth/flow-status?flowId=<id>[&provider=…] — callback-based OAuth progress
	if (url.pathname === "/api/oauth/flow-status" && req.method === "GET") {
		const flowId = url.searchParams.get("flowId");
		if (!flowId) {
			json({ error: "Missing flowId" }, 400);
			return;
		}
		const provider = url.searchParams.get("provider") || undefined;
		const status = oauthFlowStatus(flowId, provider);
		if (status.error === "flow not found") {
			json(status, 404);
			return;
		}
		json(status);
		return;
	}

	// POST /api/oauth/start — begin OAuth flow, returns auth URL
	if (url.pathname === "/api/oauth/start" && req.method === "POST") {
		try {
			const body = await readBody(req).catch(() => ({}));
			const result = await oauthStart(body?.provider);
			json(result);
		} catch (err) {
			jsonError(500, err);
		}
		return;
	}

	// POST /api/oauth/complete — exchange code for tokens
	if (url.pathname === "/api/oauth/complete" && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.flowId || !body?.code) {
			json({ error: "Missing flowId or code" }, 400);
			return;
		}
		try {
			const result = await oauthComplete(body.flowId, body.code);
			json(result, result.success ? 200 : 400);
		} catch (err) {
			jsonError(500, err);
		}
		return;
	}

	// POST /api/oauth/logout — clear/revoke a single provider's OAuth credential.
	// Provider-partitioned: never touches other providers or API-key entries,
	// and never echoes token material back to the client.
	if (url.pathname === "/api/oauth/logout" && req.method === "POST") {
		try {
			const body = await readBody(req).catch(() => ({}));
			const result = await oauthLogout(body?.provider);
			json(result);
		} catch (err) {
			jsonError(400, err);
		}
		return;
	}

	// GET /api/sessions/:id/file-content?path=<relative-or-absolute>&snapshotId=<id>
	// Reads a text file for inline preview. When snapshotId is provided:
	//   - If a snapshot exists on disk, returns the snapshot (historical state)
	//   - Otherwise reads the live file and saves a snapshot for future refreshes
	if (req.method === "GET" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/file-content")) {
		const id = url.pathname.split("/")[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }

		const filePath = url.searchParams.get("path");
		if (!filePath) { json({ error: "Missing path parameter" }, 400); return; }

		const snapshotId = url.searchParams.get("snapshotId");
		const snapshotDir = path.join(bobbitStateDir(), "html-snapshots");
		const snapshotFile = snapshotId ? path.join(snapshotDir, `${snapshotId.replace(/[^a-zA-Z0-9_-]/g, "")}.html`) : null;

		// Return existing snapshot if available
		if (snapshotFile && fs.existsSync(snapshotFile)) {
			try {
				const content = fs.readFileSync(snapshotFile, "utf-8");
				json({ content });
			} catch {
				json({ error: "Snapshot read failed" }, 500);
			}
			return;
		}

		// Read live file
		const resolved = path.isAbsolute(filePath)
			? path.resolve(filePath)
			: path.resolve(session.cwd, filePath);

		try {
			const stat = fs.statSync(resolved);
			if (stat.isDirectory() || stat.size > 512 * 1024) {
				json({ error: "File too large or is a directory" }, 400);
				return;
			}
			const content = fs.readFileSync(resolved, "utf-8");

			// Save snapshot for future refreshes
			if (snapshotFile) {
				try {
					fs.mkdirSync(snapshotDir, { recursive: true });
					fs.writeFileSync(snapshotFile, content, "utf-8");
				} catch { /* best-effort */ }
			}

			json({ content });
		} catch {
			json({ error: "File not found" }, 404);
		}
		return;
	}

	// GET /api/sessions/:id/google-code-assist/token — short-lived runtime material
	// for the agent-side Code Assist provider extension. Returns a fresh Google
	// account Bearer access token and the Code Assist project id. This is the only
	// way the spawned pi-coding-agent runtime obtains credentials for
	// google-gemini-cli session models, so it can refresh per request instead of
	// relying on a stale env-only token. Never returns the OAuth refresh token.
	const googleCodeAssistTokenMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/google-code-assist\/token$/);
	if (req.method === 'GET' && googleCodeAssistTokenMatch) {
		const id = googleCodeAssistTokenMatch[1];
		const session = sessionManager.getSession(id);
		if (!session) {
			json({ error: "Session not found" }, 404);
			return;
		}
		// Provider isolation: this endpoint is exclusively the Google account
		// (OAuth / Code Assist) path. It must never touch the API-key-only `google`
		// provider. A 401 here means "re-auth your Google account", not "add an API key".
		if (!hasGoogleCodeAssistCredential()) {
			json(
				{
					error: "No Google account is signed in. Re-authenticate via Settings \u2192 Account \u2192 Google (Gemini).",
					code: "GOOGLE_CODE_ASSIST_REAUTH",
				},
				401,
			);
			return;
		}
		let accessToken: string | null;
		try {
			accessToken = await getGoogleAccessToken();
		} catch (err) {
			jsonError(401, err, { code: "GOOGLE_CODE_ASSIST_REAUTH" });
			return;
		}
		if (!accessToken) {
			json(
				{
					error: "Google account token could not be refreshed. Sign in again via Settings \u2192 Account \u2192 Google (Gemini).",
					code: "GOOGLE_CODE_ASSIST_REAUTH",
				},
				401,
			);
			return;
		}
		// Project selection: an explicit GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_PROJECT_ID
		// (paid Code Assist / GCP-billed subscriptions) wins; otherwise resolve/onboard
		// the free-tier project via the Code Assist API.
		let projectId: string | undefined =
			(process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || "").trim() || undefined;
		if (!projectId) {
			try {
				projectId = await ensureCodeAssistProject(accessToken);
			} catch (err) {
				// Token is valid but project onboarding failed — surface as a non-auth
				// error so the runtime doesn't misreport it as a re-auth requirement.
				jsonError(502, err, { code: "GOOGLE_CODE_ASSIST_PROJECT" });
				return;
			}
		}
		json({ accessToken, projectId: projectId ?? null });
		return;
	}

	// GET /api/sessions/:id/git-status — get git status for session's working directory (async)
	if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/git-status')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) {
			json({ error: "Session not found" }, 404);
			return;
		}
		if (isHeadquartersSession(session)) { json(sessionGitUnavailablePayload(session, "Git status"), 409); return; }
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;

		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }

		// Resolve project `base_ref` config for the `aheadOfPrimary`/`behindPrimary`
		// counter — see `docs/design/base-ref.md` §5.
		let sessionBaseRef: string | undefined;
		try {
			const sessCtx = projectContextManager.getContextForSession(id);
			if (sessCtx) sessionBaseRef = sessCtx.projectConfigStore.get("base_ref") || undefined;
		} catch { /* config unavailable — fall through */ }

		// Optional: run git fetch first when ?fetch=true is passed
		const sessUntracked = url.searchParams.get('untracked') === '1';
		if (url.searchParams.get('fetch') === 'true') {
			try { await execGit('git fetch --quiet', cwd, 15000, cid); } catch { /* best-effort */ }
			invalidateGitStatusCache(cwd, cid);
		}

		// Single attempt — native parallel execFile is fast (50–150 ms p50 on
		// Windows) and errors are not cached, so the client retry loop in
		// `git-status-refresh.ts` (4 attempts × 0/500/2000/5000 ms backoff) is
		// the resilience layer for transient failures.
		// `session.repoWorktrees` is an ARRAY `Array<{repo, repoPath, worktreePath}>`
		// (session-manager.ts), unlike the goal's `Record<string,string>`.
		const sessRepoWorktrees = session.repoWorktrees;
		const isMultiRepo = !!(sessRepoWorktrees && sessRepoWorktrees.length > 1);

		// Root container status. In a TRUE polyrepo (no `repo: "."` git-root
		// component) the container `cwd` is NOT itself a git repo, so this is
		// null/throws — that is non-fatal in multi-repo mode (the per-repo
		// worktrees below are the source of truth). For single-repo it must
		// keep the existing 400/500 behavior.
		let result: Awaited<ReturnType<typeof batchGitStatus>> | undefined;
		try {
			result = await batchGitStatus(cwd, cid, { untracked: sessUntracked, configuredBaseRef: sessionBaseRef });
		} catch (err: any) {
			if (!isMultiRepo) {
				console.error("[git-status handler] error for session", id, "cwd=", cwd, "code=", err?.code, "signal=", err?.signal, "killed=", err?.killed, "stderr=", err?.stderr, "message=", err?.message);
				jsonError(500, err, { error: err?.stderr?.trim() || err?.message || "git status failed" });
				return;
			}
			// Multi-repo: container-cwd failure is expected/non-fatal.
			result = undefined;
		}

		if (!isMultiRepo) {
			// Single-repo / no repoWorktrees: keep back-compat flat shape plus
			// `repos: { ".": result }, aggregate: result`.
			if (!result) { json({ error: "Not a git repository" }, 400); return; }
			json({ ...result, aggregate: result, repos: { ".": result } });
			return;
		}

		// Multi-repo aware envelope (parity with the goal git-status handler):
		// emit a `repos` map keyed by repo name + an `aggregate`.
		const repos: Record<string, GitStatusResult> = {};
		for (const { repo, worktreePath } of sessRepoWorktrees!) {
			try {
				if (cid || fs.existsSync(worktreePath)) {
					const r = await batchGitStatus(worktreePath, cid, { untracked: sessUntracked, configuredBaseRef: sessionBaseRef });
					if (r) repos[repo] = r;
				}
			} catch { /* per-repo failure non-fatal */ }
		}

		const repoResults = Object.values(repos);
		// Aggregate: prefer the root container status when it IS a git repo
		// (e.g. a `repo: "."` component) for back-compat; otherwise synthesize
		// one from the per-repo results. All sub-repos share the same session
		// branch, so branch/primary fields come from the first repo while the
		// numeric counters are summed and `clean` is the AND across repos.
		let aggregate: GitStatusResult | undefined = result ?? undefined;
		if (!aggregate) {
			if (repoResults.length === 0) { json({ error: "Not a git repository" }, 400); return; }
			const base = repoResults[0];
			const sum = (pick: (r: GitStatusResult) => number) =>
				repoResults.reduce((acc, r) => acc + (typeof pick(r) === "number" ? pick(r) : 0), 0);
			const ahead = sum(r => r.ahead);
			const behind = sum(r => r.behind);
			const insertionsVsPrimary = sum(r => r.insertionsVsPrimary);
			const deletionsVsPrimary = sum(r => r.deletionsVsPrimary);
			aggregate = {
				branch: base.branch,
				primaryBranch: base.primaryBranch,
				primaryRef: base.primaryRef,
				isOnPrimary: base.isOnPrimary,
				hasUpstream: base.hasUpstream,
				mergedIntoPrimary: base.mergedIntoPrimary,
				status: [], // multi-repo mode suppresses the flat list; per-repo sections are authoritative
				ahead,
				behind,
				aheadOfPrimary: sum(r => r.aheadOfPrimary),
				behindPrimary: sum(r => r.behindPrimary),
				insertionsVsPrimary,
				deletionsVsPrimary,
				clean: repoResults.every(r => r.clean),
				unpushed: repoResults.some(r => r.unpushed),
				summary: `${repoResults.length} repos`,
				untrackedIncluded: sessUntracked,
			};
		}

		json({ ...aggregate, aggregate, repos });
		return;
	}
	// GET /api/sessions/:id/tool-content/:messageIndex/:blockIndex — lazy-load full tool input content
	const toolContentMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/tool-content\/(\d+)\/(\d+)$/);
	if (toolContentMatch && req.method === "GET") {
		const [, id, msgIdxStr, blkIdxStr] = toolContentMatch;
		const messageIndex = parseInt(msgIdxStr, 10);
		const blockIndex = parseInt(blkIdxStr, 10);
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		try {
			const msgsResp = await session.rpcClient.getMessages();
			const messages = msgsResp?.data?.messages || msgsResp?.data;
			if (!Array.isArray(messages)) { json({ error: "Could not retrieve messages" }, 500); return; }
			const msg = messages[messageIndex];
			if (!msg) { json({ error: "Message not found" }, 404); return; }
			const content = Array.isArray(msg.content) ? msg.content : [];
			const block = content[blockIndex];
			if (!block) { json({ error: "Block not found" }, 404); return; }
			let toolContent = block.arguments?.content ?? block.input?.content;
			// Fallback: text blocks (e.g. preview_open snapshot blocks in
			// toolResult messages) store their payload in `block.text`.
			if (toolContent === undefined && block.type === "text" && typeof block.text === "string") {
				toolContent = block.text;
			}
			if (toolContent === undefined) { json({ error: "No content in block" }, 404); return; }
			json({ content: toolContent });
		} catch (err) {
			jsonError(500, err);
		}
		return;
	}

	// GET /api/sessions/:id/transcript — paginated, regex-filterable transcript reader
	// Backs the `read_session` tool extension. See `src/server/agent/transcript-reader.ts`.
	const transcriptMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/transcript$/);
	if (transcriptMatch && req.method === "GET") {
		const [, targetId] = transcriptMatch;
		// Resolve target session (live or persisted).
		const targetPs = sessionManager.getPersistedSession(targetId);
		if (!targetPs) { json({ error: "session_not_found" }, 404); return; }
		if (!targetPs.agentSessionFile) { json({ error: "transcript_unavailable" }, 404); return; }


		// Parse query params.
		const qp = url.searchParams;
		function parseIntParam(name: string): number | undefined {
			const raw = qp.get(name);
			if (raw === null) return undefined;
			const n = Number(raw);
			if (!Number.isFinite(n)) {
				throw new TranscriptReaderError("invalid_params", `${name} is not a number`);
			}
			return n;
		}
		function parseBoolParam(...names: string[]): boolean | undefined {
			let raw: string | null = null;
			let foundName = "";
			for (const name of names) {
				raw = qp.get(name);
				if (raw !== null) { foundName = name; break; }
			}
			if (raw === null) return undefined;
			const normalized = raw.toLowerCase();
			if (normalized === "1" || normalized === "true") return true;
			if (normalized === "0" || normalized === "false") return false;
			throw new TranscriptReaderError("invalid_params", `${foundName} must be a boolean`);
		}
		try {
			const params = {
				offset: parseIntParam("offset"),
				limit: parseIntParam("limit"),
				pattern: qp.get("pattern") ?? undefined,
				caseSensitive: qp.get("case_sensitive") === "1" || qp.get("case_sensitive") === "true",
				context: parseIntParam("context"),
				verbose: qp.get("verbose") === "1" || qp.get("verbose") === "true",
				includeToolResults: parseBoolParam("include_tool_results", "includeToolResults"),
			};
			const ctx = sessionFsContextForAgentFile(targetPs, targetPs.agentSessionFile);
			const envelope = await readTranscript(params, {
				readContent: () => sessionFileRead(ctx, targetPs.agentSessionFile, sandboxManager),
			});
			json(envelope);
		} catch (err) {
			if (err instanceof TranscriptReaderError) {
				const status = err.code === "transcript_unavailable" ? 404 : 400;
				json({ error: err.code, detail: err.message }, status);
			} else {
				jsonError(500, err, { error: "internal_error", detail: String(err) });
			}
		}
		return;
	}

	// GET /api/sessions/:id/transcript/before-compaction — orphaned
	// pre-compaction history for the named sidecar compaction id, paginated.
	// See docs/design/persist-compaction-history.md §4.2.
	const beforeCompactionMatch = url.pathname.match(
		/^\/api\/sessions\/([^/]+)\/transcript\/before-compaction$/,
	);
	if (beforeCompactionMatch && req.method === "GET") {
		const [, targetId] = beforeCompactionMatch;
		const targetPs = sessionManager.getPersistedSession(targetId);
		if (!targetPs) { json({ error: "session_not_found" }, 404); return; }
		if (!targetPs.agentSessionFile) { json({ error: "transcript_unavailable" }, 404); return; }


		const compactionId = url.searchParams.get("compactionId");
		if (!compactionId) {
			json({ error: "invalid_params", detail: "compactionId required" }, 400);
			return;
		}
		const entry = findCompactionSidecarEntry(targetId, compactionId);
		if (!entry) {
			json({ error: "compaction_not_found" }, 404);
			return;
		}
		const qp2 = url.searchParams;
		let cursor: number | undefined;
		let limit: number | undefined;
		const verbose = qp2.get("verbose") === "1" || qp2.get("verbose") === "true";
		try {
			if (qp2.has("cursor")) {
				const c = Number(qp2.get("cursor"));
				if (!Number.isFinite(c) || !Number.isInteger(c) || c < 0) {
					throw new TranscriptReaderError("invalid_params", "cursor must be a non-negative integer");
				}
				cursor = c;
			}
			if (qp2.has("limit")) {
				const n = Number(qp2.get("limit"));
				if (!Number.isFinite(n) || !Number.isInteger(n)) {
					throw new TranscriptReaderError("invalid_params", "limit must be an integer");
				}
				limit = n;
			}
		} catch (err) {
			if (err instanceof TranscriptReaderError) {
				json({ error: err.code, detail: err.message }, 400);
			} else {
				jsonError(500, err, { error: "internal_error", detail: String(err) });
			}
			return;
		}
		const ctx2 = sessionFsContextForAgentFile(targetPs, targetPs.agentSessionFile);
		try {
			const envelope = await readOrphanedBeforeCompaction(
				{ compactionId, cursor, limit, verbose },
				{
					readContent: () => sessionFileRead(ctx2, targetPs.agentSessionFile!, sandboxManager),
					firstKeptEntryId: entry.firstKeptEntryId,
				},
			);
			json(envelope);
		} catch (err) {
			if (err instanceof TranscriptReaderError) {
				const status = err.code === "transcript_unavailable" ? 404 : 400;
				json({ error: err.code, detail: err.message }, status);
			} else {
				jsonError(500, err, { error: "internal_error", detail: String(err) });
			}
		}
		return;
	}

	// GET /api/sessions/:id/git-diff — unified diff for session working directory
	if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/git-diff')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		if (isHeadquartersSession(session)) { json(sessionGitUnavailablePayload(session, "Git diff"), 409); return; }
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;
		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		const file = url.searchParams.get("file") || undefined;
		const commit = url.searchParams.get("commit") || undefined;
		// Per-repo diff routing (multi-repo sessions). `session.repoWorktrees` is
		// an array; resolve the requested repo's worktree path, else fall back to cwd.
		const repoParam = url.searchParams.get("repo") || undefined;
		let diffCwd = cwd;
		if (repoParam && repoParam !== ".") {
			const entry = session.repoWorktrees?.find(w => w.repo === repoParam);
			if (entry) diffCwd = entry.worktreePath;
		}
		try {
			const diff = await getGitDiff(diffCwd, file, cid, commit, commandRunner);
			json({ diff });
		} catch (err: any) {
			if (err.message === "INVALID_PATH") { json({ error: "Invalid file path" }, 400); return; }
			if (err.message === "INVALID_COMMIT") { json({ error: "Invalid commit" }, 400); return; }
			if (err.message === "NO_DIFF") { json({ error: "No diff found" }, 404); return; }
			jsonError(500, err);
		}
		return;
	}
	// GET /api/sessions/:id/commits — unpushed commits for session
	if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/commits')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: 'Session not found' }, 404); return; }
		if (isHeadquartersSession(session)) { json(sessionGitUnavailablePayload(session, "Commit history"), 409); return; }
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;
		if (!cid && !fs.existsSync(cwd)) { json({ commits: [] }); return; }
		try {
			let branch = '';
			try { branch = await execGit('git rev-parse --abbrev-ref HEAD', cwd, 5000, cid, commandRunner); }
			catch { json({ commits: [] }); return; }

			let hasUpstream = false;
			try { await execGit(`git rev-parse --abbrev-ref ${branch}@{u}`, cwd, 5000, cid, commandRunner); hasUpstream = true; } catch {}

			const limit = 50;
			const direction = url.searchParams.get('direction'); // 'behind' to show incoming commits
			const vs = url.searchParams.get('vs'); // 'primary' to compare vs origin/master
			let rangeSpec: string;
			if (vs === 'primary') {
				// Compare against origin/<primary>
				let primaryBranch = 'master';
				try {
					const remoteHead = await execGit('git symbolic-ref refs/remotes/origin/HEAD', cwd, 5000, cid, commandRunner);
					primaryBranch = remoteHead.replace('refs/remotes/origin/', '');
				} catch {
					try { await execGit('git rev-parse --verify refs/heads/master', cwd, 5000, cid, commandRunner); primaryBranch = 'master'; }
					catch { try { await execGit('git rev-parse --verify refs/heads/main', cwd, 5000, cid, commandRunner); primaryBranch = 'main'; } catch {} }
				}
				let primaryRef = primaryBranch;
				try { await execGit(`git rev-parse --verify origin/${primaryBranch}`, cwd, 5000, cid, commandRunner); primaryRef = `origin/${primaryBranch}`; } catch {}
				rangeSpec = direction === 'behind' ? `HEAD..${primaryRef}` : `${primaryRef}..HEAD`;
			} else {
				rangeSpec = direction === 'behind' && hasUpstream
					? 'HEAD..@{u}'
					: hasUpstream ? '@{u}..HEAD' : `-${limit} HEAD`;
			}

			const commits = await getCommitsWithFiles(cwd, rangeSpec.split(" ").filter(Boolean), 10000, cid, commandRunner);

			json({ commits });
		} catch (e: any) {
			json({ error: 'Failed to read git log', detail: e.message }, 500);
		}
		return;
	}
	// GET /api/sessions/:id/pr-status — PR status for session's branch
	if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/pr-status')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		if (isHeadquartersSession(session)) { json(sessionGitUnavailablePayload(session, "PR status"), 409); return; }
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;
		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		// Use goal branch if available so we find the right PR even if the worktree HEAD diverged.
		// For non-goal sessions, fall back to the session's persisted branch — needed for sandbox
		// sessions where the host worktree may not have the right branch checked out.
		const goalBranch = session.goalId ? getGoalAcrossProjects(session.goalId)?.branch : undefined;
		let sessionBranch = goalBranch || sessionManager.getPersistedSession(id)?.branch;
		// For sandboxed sessions, the persisted branch may not match the actual container branch
		// (e.g. gateway assigns a different worktree name). Detect the real branch from the container.
		if (cid && cwd) {
			try {
				const actualBranch = await execGit("git rev-parse --abbrev-ref HEAD", cwd, 5000, cid);
				if (actualBranch && actualBranch !== "HEAD") sessionBranch = actualBranch;
			} catch { /* fall back to persisted branch */ }
		}
		// PR status uses `gh` CLI which needs host filesystem — use worktreePath for sandboxed sessions
		const prCwd = cid ? (session.worktreePath || process.cwd()) : cwd;
		const optional = url.searchParams.get("optional") === "1";
		const pr = await getCachedPrStatus(prCwd, sessionBranch, process.cwd());
		if (pr) {
			const goalId = session.goalId;
			if (goalId) prStatusStore.set(goalId, pr);
			json(pr);
		} else if (optional) { noContent(); } else { json({ error: "No PR found" }, 404); }
		return;
	}

	// POST /api/sessions/:id/git-pull — pull latest from remote
	if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/git-pull')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		if (isHeadquartersSession(session)) { json(sessionGitUnavailablePayload(session, "Git pull"), 409); return; }
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;
		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		try {
			const output = await execGit('git pull', cwd, 30000, cid);
			invalidateGitStatusCache(cwd, cid);
			json({ ok: true, output });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			json({ error: msg }, 500);
		}
		return;
	}

	// POST /api/sessions/:id/git-push — push local commits to remote
	if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/git-push')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		if (isHeadquartersSession(session)) { json(sessionGitUnavailablePayload(session, "Git push"), 409); return; }
		if (shouldSkipRemotePush(serverRemoteGitPolicy)) { json({ ok: true, output: "skipped (test mode)" }); return; }
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;
		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		try {
			const branch = await execGit('git symbolic-ref --short HEAD', cwd, 5000, cid);
			const upstream = await execGitSafe('git rev-parse --abbrev-ref --symbolic-full-name @{u}', cwd, "", cid);
			const output = await publishCurrentBranchToOrigin(cwd, branch, { containerId: cid, setUpstream: !upstream });
			invalidateGitStatusCache(cwd, cid);
			json({ ok: true, output });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			json({ error: msg }, 500);
		}
		return;
	}

	// POST /api/sessions/:id/git-squash-push — squash all branch commits and push directly to project primary
	if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/git-squash-push')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		if (isHeadquartersSession(session)) { json(sessionGitUnavailablePayload(session, "Squash push"), 409); return; }
		if (shouldSkipRemotePush(serverRemoteGitPolicy)) { json({ ok: true, output: "skipped (test mode)" }); return; }
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;
		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		try {
			// Honour project `base_ref` config. Squash-push fundamentally needs an
			// `origin/<primary>` (it pushes a single commit to that remote ref) —
			// if the configured base_ref points at a local-only branch with no
			// origin counterpart, fail loudly rather than push to the wrong place.
			let sessionBaseRef: string | undefined;
			try {
				const sessCtx = projectContextManager.getContextForSession(id);
				if (sessCtx) sessionBaseRef = sessCtx.projectConfigStore.get("base_ref") || undefined;
			} catch { /* config unavailable — fall through */ }

			const parsedBase = parseBaseRef(sessionBaseRef ?? "");
			let primaryBranch = parsedBase.branch;
			if (!primaryBranch) {
				try {
					const remoteHead = await execGit("git symbolic-ref refs/remotes/origin/HEAD", cwd, 5000, cid);
					primaryBranch = remoteHead.replace("refs/remotes/origin/", "");
				} catch {
					try { await execGit("git rev-parse --verify refs/heads/master", cwd, 5000, cid); primaryBranch = "master"; }
					catch { try { await execGit("git rev-parse --verify refs/heads/main", cwd, 5000, cid); primaryBranch = "main"; } catch { primaryBranch = "master"; } }
				}
			}

			// Fetch the remote primary; if origin has no such ref, refuse — squash
			// push only makes sense for a remote primary.
			try { await execGit(`git fetch origin ${primaryBranch}`, cwd, 30000, cid); }
			catch { json({ error: `origin has no "${primaryBranch}" branch — squash push needs a remote primary. Check the project's base_ref configuration.` }, 400); return; }
			const primaryRef = `origin/${primaryBranch}`;

			// Check we have commits ahead
			const aheadCount = parseInt(await execGit(`git rev-list --count ${primaryRef}..HEAD`, cwd, 5000, cid), 10) || 0;
			if (aheadCount === 0) { json({ error: `No commits ahead of ${primaryRef}` }, 400); return; }

			// Build commit message from branch commits
			const logOutput = await execGit(`git log --format="%s" ${primaryRef}..HEAD`, cwd, 5000, cid);
			const commitMessages = logOutput.trim().split("\n").filter(Boolean);
			const branch = await execGit("git rev-parse --abbrev-ref HEAD", cwd, 5000, cid);
			const summary = commitMessages.length === 1
				? commitMessages[0]
				: `Squash ${branch} (${commitMessages.length} commits)`;
			const body = commitMessages.length > 1
				? commitMessages.map(m => `- ${m}`).join("\n")
				: "";
			const fullMessage = body ? `${summary}\n\n${body}` : summary;

			// Create squash commit on top of origin/master using plumbing (no checkout needed)
			// 1. Create a tree that represents the merge result
			const mergeTree = await execGit(`git merge-tree --write-tree ${primaryRef} HEAD`, cwd, 5000, cid);
			// 2. Create a commit object with that tree, parented on origin/master
			// For sandboxed sessions, write temp file inside container
			const msgFile = cid ? `/tmp/SQUASH_MSG_${Date.now()}` : path.join(cwd, ".git", "SQUASH_MSG");
			if (cid) {
				await serverCommandRunner.execFile("docker", [
					"exec", "-w", cwd, cid, "/bin/sh", "-c", `cat > ${msgFile} << 'BOBBIT_EOF'\n${fullMessage}\nBOBBIT_EOF`,
				], { encoding: "utf-8", timeout: 5000, env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } });
			} else {
				fs.writeFileSync(msgFile, fullMessage, "utf-8");
			}
			const squashCommit = await execGit(`git commit-tree ${mergeTree} -p ${primaryRef} -F "${msgFile}"`, cwd, 5000, cid);
			if (cid) {
				await execGit(`rm -f ${msgFile}`, cwd, 5000, cid).catch(() => {});
			} else {
				fs.unlinkSync(msgFile);
			}
			// 3. Push that commit to master
			await execGit(`git push origin ${squashCommit}:refs/heads/${primaryBranch}`, cwd, 30000, cid);
			invalidateGitStatusCache(cwd, cid);

			json({ ok: true, output: `Squash pushed ${aheadCount} commit${aheadCount > 1 ? "s" : ""} to ${primaryBranch}` });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			// Check for merge conflicts from merge-tree
			if (msg.includes("CONFLICT") || msg.includes("merge-tree")) {
				json({ error: "Merge conflicts with primary. Use 'Rebase on primary' first to resolve." }, 409);
			} else {
				json({ error: msg }, 500);
			}
		}
		return;
	}

	// POST /api/sessions/:id/git-merge-primary — rebase current branch onto project's primary ref
	if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/git-merge-primary')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		if (isHeadquartersSession(session)) { json(sessionGitUnavailablePayload(session, "Rebase on primary"), 409); return; }
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;
		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		try {
			// Honour project `base_ref` config when set (mirrors the git-status
			// handler at line ~6598). A local-only base_ref (e.g. "MyUpstream")
			// must rebase against the LOCAL branch, not `origin/MyUpstream` which
			// may not exist.
			let sessionBaseRef: string | undefined;
			try {
				const sessCtx = projectContextManager.getContextForSession(id);
				if (sessCtx) sessionBaseRef = sessCtx.projectConfigStore.get("base_ref") || undefined;
			} catch { /* config unavailable — fall through */ }

			const parsedBase = parseBaseRef(sessionBaseRef ?? "");
			let primaryBranch = parsedBase.branch;
			if (!primaryBranch) {
				try {
					const remoteHead = await execGit("git symbolic-ref refs/remotes/origin/HEAD", cwd, 5000, cid);
					primaryBranch = remoteHead.replace("refs/remotes/origin/", "");
				} catch {
					try { await execGit("git rev-parse --verify refs/heads/master", cwd, 5000, cid); primaryBranch = "master"; }
					catch { try { await execGit("git rev-parse --verify refs/heads/main", cwd, 5000, cid); primaryBranch = "main"; } catch { primaryBranch = "master"; } }
				}
			}

			// Resolve actual ref: prefer `origin/<primary>` when origin has it,
			// else fall back to the bare local branch (matches `pref` semantics
			// in `git-status-native.ts`).
			let primaryRef = primaryBranch;
			try { await execGit(`git rev-parse --verify origin/${primaryBranch}`, cwd, 5000, cid); primaryRef = `origin/${primaryBranch}`; } catch { /* use local */ }

			// Only fetch when we're actually targeting the remote.
			if (primaryRef.startsWith("origin/")) {
				await execGit(`git fetch origin ${primaryBranch}`, cwd, 30000, cid);
			}
			const output = await execGit(`git rebase ${primaryRef}`, cwd, 30000, cid);

			// After rebase, check if orphaned commits remain (common after squash-merge PRs).
			// If the tree is identical to the primary ref (no diff), the commits are redundant —
			// reset to the primary ref to clean them up.
			const aheadAfter = parseInt(await execGitSafe(`git rev-list --count ${primaryRef}..HEAD`, cwd, "0", cid), 10) || 0;
			if (aheadAfter > 0) {
				const diff = await execGitSafe(`git diff ${primaryRef}..HEAD`, cwd, "", cid);
				if (diff.trim() === "") {
					// Tree is identical — these are orphaned commits from a squash merge
					await execGit(`git reset --hard ${primaryRef}`, cwd, 10000, cid);
					invalidateGitStatusCache(cwd, cid);
					json({ ok: true, output: `Rebased and reset ${aheadAfter} orphaned commit(s) from squash merge` });
					return;
				}
			}
			invalidateGitStatusCache(cwd, cid);

			json({ ok: true, output });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			json({ error: msg }, 500);
		}
		return;
	}

	// POST /api/sessions/:id/pr-merge — merge PR for session's branch
	if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/pr-merge')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		if (isHeadquartersSession(session)) { json(sessionGitUnavailablePayload(session, "PR merge"), 409); return; }
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;
		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		const body = await readBody(req);
		const method = body?.method ?? "squash";
		if (!["merge", "squash", "rebase"].includes(method)) {
			json({ error: "Invalid merge method. Must be merge, squash, or rebase." }, 400);
			return;
		}
		// Prefer the client-provided branch (headRefName from PR status) so the merge
		// targets the exact PR the widget displayed — avoids mismatches when the session's
		// persisted branch differs from the PR's head ref (e.g. staff/team agent worktrees).
		const clientBranch = typeof body?.branch === "string" ? body.branch : undefined;
		const goalBranch = session.goalId ? getGoalAcrossProjects(session.goalId)?.branch : undefined;
		const sessMergeBranch = clientBranch || goalBranch || sessionManager.getPersistedSession(id)?.branch;
		try {
			// PR merge uses `gh` CLI — for sandboxed sessions, run on host worktree
			const mergeCwd = cid ? (session.worktreePath || cwd) : cwd;
			await serverCommandRunner.execFile("gh", buildGhPrMergeArgs(sessMergeBranch, method, body?.admin), { cwd: mergeCwd, encoding: "utf-8", timeout: 30000 });
			_prCache.delete(cwd);
			if (sessMergeBranch) _prCache.delete(`${cwd}::${sessMergeBranch}`);
			json({ ok: true });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			json({ error: msg }, 500);
		}
		return;
	}

	// GET /api/slash-skills — discover .claude/skills/ SKILL.md files for autocomplete
	if (url.pathname === "/api/slash-skills" && req.method === "GET") {
		const rawCwd = url.searchParams.get("cwd") || process.cwd();
		const projectId = url.searchParams.get("projectId") || undefined;
		const resolvedProject = resolveProjectForRequest(projectRegistry, { projectId });
		if (!resolvedProject.ok) { writeProjectResolutionError(resolvedProject); return; }
		const resolvedStore = resolveProjectConfigStore(resolvedProject.projectId);
		// For sandboxed sessions the cwd is a container-internal path (e.g. /workspace-wt/...).
		// Skill files live on the host, so resolve the project rootPath for discovery.
		const cwd = resolveSkillDiscoveryCwd(rawCwd, resolvedProject.projectId);
		const skills = discoverSlashSkills(cwd, resolvedStore, skillMarketContext(resolvedProject.projectId));
		json({ skills: skills.map((s) => ({ name: s.name, description: s.description, argumentHint: s.argumentHint, source: s.source, originPackId: s.originPackId ?? null, originPackName: s.originPackName ?? null })) });
		return;
	}

	// GET /api/file-mentions — bounded file enumeration for @-mention autocomplete.
	// Includes gitignored/untracked files; excludes .git/node_modules/etc. (no .gitignore consulted).
	if (url.pathname === "/api/file-mentions" && req.method === "GET") {
		const rawCwd = url.searchParams.get("cwd") || undefined;
		const sessionId = url.searchParams.get("sessionId") || undefined;
		const rawProjectId = url.searchParams.get("projectId") || undefined;
		const q = url.searchParams.get("q") || undefined;
		const limitRaw = url.searchParams.get("limit");
		const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
		const limit = limitParsed !== undefined && Number.isFinite(limitParsed) ? limitParsed : undefined;

		let resolvedProjectId: string;
		let cwd: string;
		let cwdSource: CwdOwnershipSource;
		if (sessionId) {
			const session = sessionManager.getSession(sessionId);
			const persisted = session
				? undefined
				: (sessionManager.getPersistedSession(sessionId) ?? projectContextManager.getContextForSession(sessionId)?.sessionStore.get(sessionId));
			if (!session && !persisted) {
				json({ error: `Session "${sessionId}" not found` }, 404);
				return;
			}
			const sessionProjectId = session?.projectId ?? persisted?.projectId;
			if (!sessionProjectId) {
				json({ error: "Session missing projectId", code: "PROJECT_ID_REQUIRED" }, 403);
				return;
			}
			if (rawProjectId && rawProjectId !== sessionProjectId) {
				json({ error: "projectId does not match session projectId", code: "PROJECT_SCOPE_MISMATCH" }, 422);
				return;
			}
			const resolvedProject = resolveProjectForRequest(projectRegistry, { projectId: sessionProjectId });
			if (!resolvedProject.ok) { writeProjectResolutionError(resolvedProject); return; }
			resolvedProjectId = resolvedProject.projectId;
			// Enumerate the session's HOST worktree, NOT the project root. The
			// project-root redirect (resolveSkillDiscoveryCwd) is correct for SKILL
			// discovery but wrong here: file mentions must see the goal/session
			// worktree's branch-local, untracked and gitignored files. worktreePath
			// is the host path; for sandboxed sessions cwd is a container path so
			// worktreePath is required.
			cwd = session?.worktreePath || persisted?.worktreePath || session?.cwd || persisted?.cwd || rawCwd || resolvedProject.project.rootPath;
			cwdSource = { kind: "session", sessionId };
		} else {
			const resolvedProject = resolveProjectForRequest(projectRegistry, { projectId: rawProjectId });
			if (!resolvedProject.ok) { writeProjectResolutionError(resolvedProject); return; }
			resolvedProjectId = resolvedProject.projectId;
			cwd = rawCwd || resolvedProject.project.rootPath;
			cwdSource = { kind: "user-input" };
		}

		const cwdValidation = validateExecutionCwd(projectRegistry, projectContextManager, resolvedProjectId, cwd, cwdSource);
		if (!cwdValidation.ok) { writeCwdValidationError(cwdValidation); return; }
		const files = await enumerateFiles(cwd, { query: q, limit });
		json({ files: files.map((p) => ({ path: p })) });
		return;
	}

	// GET /api/slash-skills/details — full slash skill details including content and file paths
	if (url.pathname === "/api/slash-skills/details" && req.method === "GET") {
		const rawCwd = url.searchParams.get("cwd") || process.cwd();
		const projectId = url.searchParams.get("projectId") || undefined;
		const resolvedProject = resolveProjectForRequest(projectRegistry, { projectId });
		if (!resolvedProject.ok) { writeProjectResolutionError(resolvedProject); return; }
		const resolvedStore = resolveProjectConfigStore(resolvedProject.projectId);
		const cwd = resolveSkillDiscoveryCwd(rawCwd, resolvedProject.projectId);
		const skills = discoverSlashSkills(cwd, resolvedStore, skillMarketContext(resolvedProject.projectId));
		const directories = getSkillDirectories(cwd, resolvedStore);
		json({ skills: skills.map((s) => ({ name: s.name, description: s.description, source: s.source, filePath: s.filePath, content: s.content, originPackId: s.originPackId ?? null, originPackName: s.originPackName ?? null })), directories });
		return;
	}

	// ── Workflow endpoints ──────────────────────────────────────────

	// GET /api/workflows — a missing projectId returns an empty list (there is no
	// server-scope workflow set); a projectId returns that project's workflows.
	const workflowsMatch = url.pathname === "/api/workflows";
	if (workflowsMatch && req.method === "GET") {
		const projectId = url.searchParams.get("projectId") || undefined;
		const resolved = configCascade.resolveWorkflows(projectId);
		json({ workflows: resolved.map(r => ({ ...r.item, origin: r.origin, ...(r.overrides ? { overrides: r.overrides } : {}) })) });
		return;
	}

	// POST /api/workflows — requires projectId.
	if (workflowsMatch && req.method === "POST") {
		const body = await readBody(req);
		if (!body) { json({ error: "Missing body" }, 400); return; }
		const targetProjectId = body?.projectId;
		if (!targetProjectId) { json({ error: "projectId required" }, 400); return; }
		try {
			const ctx = projectContextManager.getOrCreate(targetProjectId);
			if (!ctx) { json({ error: "Project not found" }, 404); return; }
			const now = Date.now();
			const workflow = {
				id: body.id as string,
				name: (body.name as string) ?? body.id,
				description: (body.description as string) ?? "",
				gates: body.gates || [],
				createdAt: now,
				updatedAt: now,
			};
			if (!workflow.id || typeof workflow.id !== "string") throw new Error("Missing id");
			ctx.workflowStore.put(workflow);
			json(workflow, 201);
		} catch (err: any) {
			jsonError(400, err);
		}
		return;
	}

	// POST /api/workflows/:id/customize — copy resolved workflow into a project.
	const workflowCustomizeMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)\/customize$/);
	if (workflowCustomizeMatch && req.method === "POST") {
		const id = decodeURIComponent(workflowCustomizeMatch[1]);
		const projectId = url.searchParams.get("projectId") || undefined;
		if (!projectId) { json({ error: "projectId required" }, 400); return; }

		const resolved = configCascade.resolveWorkflows(projectId);
		const source = resolved.find(r => r.item.id === id);
		if (!source) { json({ error: "Workflow not found" }, 404); return; }

		const ctx = projectContextManager.getOrCreate(projectId);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }

		const now = Date.now();
		const copy = { ...source.item, createdAt: now, updatedAt: now };
		ctx.workflowStore.put(copy);
		json(copy, 201);
		return;
	}

	// DELETE /api/workflows/:id/override — remove project-level override.
	const workflowOverrideMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)\/override$/);
	if (workflowOverrideMatch && req.method === "DELETE") {
		const id = decodeURIComponent(workflowOverrideMatch[1]);
		const projectId = url.searchParams.get("projectId") || undefined;
		if (!projectId) { json({ error: "projectId required" }, 400); return; }

		const ctx = projectContextManager.getOrCreate(projectId);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }

		ctx.workflowStore.remove(id);
		json({ ok: true });
		return;
	}

	// GET /api/workflows/:id
	const workflowMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)$/);
	if (workflowMatch && req.method === "GET") {
		const id = decodeURIComponent(workflowMatch[1]);
		const qProjectId = url.searchParams.get("projectId") || undefined;
		if (!qProjectId) { json({ error: "Workflow not found" }, 404); return; }
		const resolved = configCascade.resolveWorkflows(qProjectId);
		const found = resolved.find(r => r.item.id === id);
		if (!found) { json({ error: "Workflow not found" }, 404); return; }
		json({ ...found.item, origin: found.origin, ...(found.overrides ? { overrides: found.overrides } : {}) });
		return;
	}

	// PUT /api/workflows/:id — requires projectId.
	if (workflowMatch && req.method === "PUT") {
		const id = decodeURIComponent(workflowMatch[1]);
		const body = await readBody(req);
		if (!body) { json({ error: "Missing body" }, 400); return; }
		const qProjectId = url.searchParams.get("projectId") || undefined;
		if (!qProjectId) { json({ error: "projectId required" }, 400); return; }
		const ctx = projectContextManager.getOrCreate(qProjectId);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }
		const existing = ctx.workflowStore.get(id);
		if (!existing) { json({ error: "Workflow not found in project" }, 404); return; }
		const updated = {
			...existing,
			name: body.name ?? existing.name,
			description: body.description ?? existing.description,
			gates: Array.isArray(body.gates) ? body.gates : existing.gates,
			id,
			updatedAt: Date.now(),
		};
		ctx.workflowStore.put(updated);
		json(updated);
		return;
	}

	// DELETE /api/workflows/:id — requires projectId.
	if (workflowMatch && req.method === "DELETE") {
		const id = decodeURIComponent(workflowMatch[1]);
		const qProjectId = url.searchParams.get("projectId") || undefined;
		if (!qProjectId) { json({ error: "projectId required" }, 400); return; }
		const ctx = projectContextManager.getOrCreate(qProjectId);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }
		ctx.workflowStore.remove(id);
		json({ ok: true });
		return;
	}

	// ── Cost endpoints ─────────────────────────────────────────────

	// GET /api/sessions/:id/cost/breakdown — cost breakdown including delegates
	const sessionCostBreakdownMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/cost\/breakdown$/);
	if (sessionCostBreakdownMatch && req.method === "GET") {
		const sessionId = sessionCostBreakdownMatch[1];
		const live = sessionManager.getSession(sessionId);
		const sessionForCost = live ?? sessionManager.getPersistedSession(sessionId);
		if (!sessionForCost?.projectId) {
			json({ error: "Session not found or has no project" }, 404);
			return;
		}
		const costTracker = sessionManager.getCostTracker(sessionForCost.projectId);
		const allCosts = costTracker.getAllCosts();
		const sessionCost = allCosts.get(sessionId);
		if (!sessionCost) {
			json({ error: "No cost data" }, 404);
			return;
		}

		// Find delegate sessions
		const delegates: any[] = [];
		const allSessions = [...sessionManager.listSessions(), ...sessionManager.listArchivedSessions()];
		for (const s of allSessions) {
			if ((s as any).delegateOf === sessionId) {
				const dCost = allCosts.get(s.id);
				if (dCost && dCost.totalCost > 0) {
					delegates.push({
						sessionId: s.id,
						title: (s as any).title || s.id.slice(0, 8),
						...dCost,
					});
				}
			}
		}
		delegates.sort((a, b) => b.totalCost - a.totalCost);

		json({
			session: { sessionId, ...sessionCost },
			delegates,
		});
		return;
	}

	// GET /api/sessions/:id/cost — cost for a single session
	const sessionCostMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/cost$/);
	if (sessionCostMatch && req.method === "GET") {
		const id = sessionCostMatch[1];
		const liveSession = sessionManager.getSession(id);
		const sessionForCost = liveSession ?? sessionManager.getPersistedSession(id);
		if (!sessionForCost?.projectId) {
			json({ error: "Session not found or has no project" }, 404);
			return;
		}
		const cost = sessionManager.getCostTracker(sessionForCost.projectId).getSessionCost(id);
		if (!cost) {
			json({ error: "No cost data for this session" }, 404);
			return;
		}
		json(cost);
		return;
	}

	// GET /api/goals/:goalId/cost/breakdown — per-session cost breakdown for a goal
	const goalCostBreakdownMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/cost\/breakdown$/);
	if (goalCostBreakdownMatch && req.method === "GET") {
		const goalId = goalCostBreakdownMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) {
			json({ error: "Goal not found" }, 404);
			return;
		}
		if (!goal.projectId) {
			json({ aggregate: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0, cacheHitRate: null }, sessions: [] });
			return;
		}
		const sessionIds = sessionManager.getAllSessionIdsForGoal(goalId);
		const costTracker = sessionManager.getCostTracker(goal.projectId);
		const allCosts = costTracker.getAllCosts();

		// Build per-session breakdown with metadata
		const sessions: any[] = [];
		for (const sid of sessionIds) {
			const cost = allCosts.get(sid);
			if (!cost || cost.totalCost === 0) continue;

			// Get session metadata from live sessions or store
			const live = sessionManager.listSessions().find(s => s.id === sid);
			const archived = !live ? sessionManager.listArchivedSessions().find(s => s.id === sid) : null;
			const meta = live || archived;

			sessions.push({
				sessionId: sid,
				title: (meta as any)?.title || sid.slice(0, 8),
				role: (meta as any)?.role || null,
				delegateOf: (meta as any)?.delegateOf || null,
				assistantType: (meta as any)?.assistantType || null,
				taskId: (meta as any)?.taskId || null,
				...cost,
			});
		}

		// Sort by cost descending
		sessions.sort((a, b) => b.totalCost - a.totalCost);

		// Compute aggregate
		const aggregate = costTracker.getGoalCost(goalId, sessionIds);

		json({ aggregate, sessions });
		return;
	}

	// GET /api/goals/:goalId/cost — aggregate cost across all sessions linked to a goal
	const goalCostMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/cost$/);
	if (goalCostMatch && req.method === "GET") {
		const goalId = goalCostMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) {
			json({ error: "Goal not found" }, 404);
			return;
		}
		if (!goal.projectId) {
			json({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0, cacheHitRate: null });
			return;
		}
		const sessionIds = sessionManager.getAllSessionIdsForGoal(goalId);
		const cost = sessionManager.getCostTracker(goal.projectId).getGoalCost(goalId, sessionIds);
		json(cost);
		return;
	}

	// GET /api/tasks/:id/cost — cost for the session(s) assigned to a task
	const taskCostMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/cost$/);
	if (taskCostMatch && req.method === "GET") {
		const taskId = taskCostMatch[1];
		const task = getTaskManagerForTask(taskId).getTask(taskId);
		if (!task) {
			json({ error: "Task not found" }, 404);
			return;
		}
		if (!task.assignedSessionId) {
			json({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0, cacheHitRate: null });
			return;
		}
		const taskSessionLive = sessionManager.getSession(task.assignedSessionId);
		const taskSession = taskSessionLive ?? sessionManager.getPersistedSession(task.assignedSessionId);
		if (!taskSession?.projectId) {
			json({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0, cacheHitRate: null });
			return;
		}
		const cost = sessionManager.getCostTracker(taskSession.projectId).getSessionCost(task.assignedSessionId);
		json(cost ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0, cacheHitRate: null });
		return;
	}

	// ── Preview mount endpoints ──────────────────────────────────────
	const VALID_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

	const previewEntryLabelForWorkspace = (entry: string | undefined | null): string => {
		const clean = (entry || "inline.html").split(/[?#]/, 1)[0]?.replace(/\\/g, "/").replace(/\/+$/, "") ?? "inline.html";
		return clean.split("/").filter(Boolean).pop() || clean || "inline.html";
	};

	const openPreviewMountWorkspaceTab = async (sessionId: string, result: {
		entry?: string;
		mtime?: number;
		url?: string;
		path?: string;
		contentHash?: string;
		artifactId?: string;
	}): Promise<void> => {
		const entry = previewEntryLabelForWorkspace(result.entry);
		try {
			await openSidePanelWorkspaceTab({
				sessionManager,
				readBody,
				broadcastToSession: _broadcastToSession,
				packContributionRegistry,
			}, sessionId, {
				id: `preview:entry:${encodeURIComponent(entry)}`,
				kind: "preview",
				title: entry,
				label: entry,
				source: {
					type: "preview",
					sessionId,
					entry,
					live: true,
					...(typeof result.contentHash === "string" && result.contentHash ? { contentHash: result.contentHash } : {}),
					...(typeof result.path === "string" && result.path ? { path: result.path } : {}),
					...(typeof result.url === "string" && result.url ? { url: result.url } : {}),
					...(typeof result.artifactId === "string" && result.artifactId ? { artifactId: result.artifactId } : {}),
				},
				state: {
					entry,
					origin: "preview-mount",
					...(typeof result.mtime === "number" ? { mtime: result.mtime } : {}),
					...(typeof result.url === "string" && result.url ? { url: result.url } : {}),
					...(typeof result.path === "string" && result.path ? { path: result.path } : {}),
					...(typeof result.contentHash === "string" && result.contentHash ? { contentHash: result.contentHash } : {}),
					...(typeof result.artifactId === "string" && result.artifactId ? { artifactId: result.artifactId } : {}),
				},
				updatedAt: Date.now(),
			}, { focus: true, placeAfterActive: true });
		} catch (err) {
			console.warn(`[preview/mount] failed to open side-panel workspace tab for ${sessionId}:`, err);
		}
	};

	// POST /api/preview/mount?sessionId=<sid> — v3 per-session preview mount.
	// Accepts {html} (with optional {entry}) or {file: absolutePath}. Returns
	// {url, path, entry, mtime, contentHash}. See docs/design/embedded-html-preview-rewrite.md §6.
	if (url.pathname === "/api/preview/mount" && req.method === "POST") {
		const sessionId = url.searchParams.get("sessionId") || "";
		if (!VALID_SESSION_ID.test(sessionId)) {
			json({ error: "Invalid sessionId" }, 400);
			return;
		}
		if (sandboxScope && !sandboxScope.sessionIds.has(sessionId)) {
			json({ error: "Forbidden: session out of scope" }, 403);
			return;
		}
		const body = await readBody(req).catch(() => ({}));
		const shouldOpenWorkspaceTab = body?.workspaceTab !== false
			&& body?.openWorkspaceTab !== false
			&& body?.internalRestore !== true
			&& url.searchParams.get("workspaceTab") !== "false";
		const hasArtifact = typeof body?.artifactId === "string" && body.artifactId.length > 0;
		const hasHtml = typeof body?.html === "string";
		const hasFile = typeof body?.file === "string" && body.file.length > 0;
		const hasAssets = Array.isArray(body?.assets);
		const hasManifest = typeof body?.manifest === "string" && body.manifest.length > 0;
		if (hasArtifact && (hasHtml || hasFile || hasAssets || hasManifest)) {
			json({ error: "`artifactId` restore cannot be combined with `html`, `file`, `assets`, or `manifest`" }, 400);
			return;
		}
		if (!hasArtifact && !hasHtml && !hasFile) {
			json({ error: "Body must contain one of 'html', 'file', or 'artifactId'" }, 400);
			return;
		}
		if (hasHtml && (hasAssets || hasManifest)) {
			json({ error: "`assets`/`manifest` only valid with `file`" }, 400);
			return;
		}
		try {
			let result: previewMount.MountResult | previewMount.MountFileResult | previewArtifacts.PreviewArtifactMountResult;
			if (hasArtifact) {
				const restored = previewArtifacts.restorePreviewArtifact(sessionId, body.artifactId as string);
				if (shouldOpenWorkspaceTab) await openPreviewMountWorkspaceTab(sessionId, restored);
				broadcastPreviewChanged(sessionId, {
					entry: restored.entry,
					mtime: restored.mtime,
					url: restored.url,
					path: restored.path,
					contentHash: restored.contentHash,
					artifactId: restored.artifactId,
				});
				json(restored);
				return;
			}
			if (hasHtml) {
				// `html` wins over `file` when both are provided.
				let entry: string | undefined;
				if (typeof body.entry === "string" && body.entry.length > 0) {
					const e = body.entry;
					if (e.includes("/") || e.includes("\\") || e.includes("..") || e.includes("\0")) {
						json({ error: "Invalid entry name" }, 400);
						return;
					}
					entry = e;
				}
				result = previewMount.writeInline(sessionId, body.html as string, entry);
			} else {
				const filePath = body.file as string;
				if (!path.isAbsolute(filePath)) {
					json({ error: "file path must be absolute" }, 400);
					return;
				}
				if (!fs.existsSync(filePath)) {
					json({ error: "file not found" }, 404);
					return;
				}
				let stat: fs.Stats;
				try { stat = fs.statSync(filePath); } catch {
					json({ error: "file not found" }, 404);
					return;
				}
				if (!stat.isFile()) {
					json({ error: "path is not a regular file" }, 404);
					return;
				}
				const base = path.basename(filePath).toLowerCase();
				if (!base.endsWith(".html") && !base.endsWith(".htm")) {
					json({ error: "file must end in .html or .htm" }, 400);
					return;
				}
				// Collect assets from inline `assets[]` and optional `manifest` JSON.
				const declared: string[] = [];
				if (hasAssets) {
					for (const a of body.assets as unknown[]) {
						if (typeof a !== "string") {
							json({ error: "`assets[]` entries must be strings" }, 400);
							return;
						}
						declared.push(a);
					}
				}
				if (hasManifest) {
					const manifestRel = body.manifest as string;
					if (path.isAbsolute(manifestRel) || manifestRel.includes("\0") ||
						manifestRel.includes("\\") || manifestRel.split("/").some(s => s === "..")) {
						json({ error: "Invalid manifest path" }, 400);
						return;
					}
					const manifestAbs = path.resolve(path.dirname(filePath), manifestRel);
					if (!fs.existsSync(manifestAbs)) {
						json({ error: `Manifest '${manifestRel}' not found` }, 404);
						return;
					}
					let manifestParsed: any;
					try {
						manifestParsed = JSON.parse(fs.readFileSync(manifestAbs, "utf-8"));
					} catch (err: any) {
						jsonError(400, err, { error: `Manifest JSON parse error: ${err?.message ?? err}` });
						return;
					}
					if (!manifestParsed || !Array.isArray(manifestParsed.assets)) {
						json({ error: "Manifest must be an object with an `assets[]` array" }, 400);
						return;
					}
					for (const a of manifestParsed.assets) {
						if (typeof a !== "string") {
							json({ error: "Manifest `assets[]` entries must be strings" }, 400);
							return;
						}
						declared.push(a);
					}
				}
				// De-duplicate while preserving order.
				const seen = new Set<string>();
				const dedup: string[] = [];
				for (const a of declared) {
					const k = a.trim();
					if (seen.has(k)) continue;
					seen.add(k);
					dedup.push(a);
				}
				result = previewMount.mountFile(sessionId, filePath, dedup);
			}
			const artifact = previewArtifacts.persistPreviewArtifact(sessionId, result);
			const resultWithArtifact = { ...result, artifactId: artifact.artifactId };
			if (shouldOpenWorkspaceTab) await openPreviewMountWorkspaceTab(sessionId, resultWithArtifact);
			broadcastPreviewChanged(sessionId, {
				entry: result.entry,
				mtime: result.mtime,
				url: result.url,
				path: result.path,
				contentHash: result.contentHash,
				artifactId: artifact.artifactId,
			});
			json(resultWithArtifact);
			return;
		} catch (err: any) {
			if (err && err instanceof previewMount.PreviewMountError) {
				jsonError(err.statusCode, err);
				return;
			}
			if (err && err instanceof previewArtifacts.PreviewArtifactError) {
				jsonError(err.statusCode, err);
				return;
			}
			jsonError(500, err, { error: `preview mount failed: ${err?.message ?? String(err)}` });
			return;
		}
	}

	// POST /api/preview/artifacts/:artifactId/restore?sessionId=<sid> — restore
	// an immutable preview artifact into the single live preview mount.
	const previewArtifactRestoreMatch = url.pathname.match(/^\/api\/preview\/artifacts\/([^/]+)\/restore$/);
	if (previewArtifactRestoreMatch && req.method === "POST") {
		const sessionId = url.searchParams.get("sessionId") || "";
		const artifactId = decodeURIComponent(previewArtifactRestoreMatch[1] || "");
		if (!VALID_SESSION_ID.test(sessionId)) {
			json({ error: "Invalid sessionId" }, 400);
			return;
		}
		if (sandboxScope && !sandboxScope.sessionIds.has(sessionId)) {
			json({ error: "Forbidden: session out of scope" }, 403);
			return;
		}
		const body = await readBody(req).catch(() => ({}));
		if (typeof body?.artifactId === "string" && body.artifactId.length > 0 && body.artifactId !== artifactId) {
			json({ error: "artifactId body does not match route" }, 400);
			return;
		}
		try {
			const restored = previewArtifacts.restorePreviewArtifact(sessionId, artifactId);
			broadcastPreviewChanged(sessionId, {
				entry: restored.entry,
				mtime: restored.mtime,
				url: restored.url,
				path: restored.path,
				contentHash: restored.contentHash,
				artifactId: restored.artifactId,
			});
			json(restored);
			return;
		} catch (err: any) {
			if (err && err instanceof previewArtifacts.PreviewArtifactError) {
				jsonError(err.statusCode, err);
				return;
			}
			jsonError(500, err, { error: `preview artifact restore failed: ${err?.message ?? String(err)}` });
			return;
		}
	}

	// GET /api/preview/mount?sessionId=<sid> — bootstrap the preview panel after
	// session select. Returns the current entry/mtime/url/path for the mount,
	// or 404 if the mount is empty / nonexistent. Same auth as the POST.
	if (url.pathname === "/api/preview/mount" && req.method === "GET") {
		const sessionId = url.searchParams.get("sessionId") || "";
		if (!VALID_SESSION_ID.test(sessionId)) {
			json({ error: "Invalid sessionId" }, 400);
			return;
		}
		if (sandboxScope && !sandboxScope.sessionIds.has(sessionId)) {
			json({ error: "Forbidden: session out of scope" }, 403);
			return;
		}
		try {
			const { pickEntry } = await import("./preview/content-route.js");
			const dir = previewMount.mountDir(sessionId);
			const entry = pickEntry(dir);
			if (!entry) {
				json({ error: "no preview mount" }, 404);
				return;
			}
			const entryPath = path.join(dir, entry);
			let stat: fs.Stats;
			try { stat = fs.statSync(entryPath); } catch {
				json({ error: "no preview mount" }, 404);
				return;
			}
			const contentHash = previewMount.contentHashForMount(sessionId);
			const artifact = previewArtifacts.findPreviewArtifactByHash(sessionId, contentHash);
			json({
				url: `/preview/${sessionId}/${entry}`,
				path: entryPath,
				relPath: path.posix.join(sessionId, entry),
				entry,
				mtime: Math.floor(stat.mtimeMs),
				contentHash,
				artifactId: artifact?.artifactId,
			});
			return;
		} catch (err: any) {
			if (err && err instanceof previewMount.PreviewMountError) {
				jsonError(err.statusCode, err);
				return;
			}
			jsonError(500, err, { error: `preview mount lookup failed: ${err?.message ?? String(err)}` });
			return;
		}
	}

	// GET /api/sessions/:sid/preview-events — SSE stream of preview-changed events
	// for the per-session preview mount. Cookie auth (or admin bearer) only;
	// sandbox tokens are not permitted (handled by the route-guard above).
	const previewEventsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/preview-events$/);
	if (previewEventsMatch && req.method === "GET") {
		const sid = previewEventsMatch[1];
		if (!VALID_SESSION_ID.test(sid)) {
			json({ error: "Invalid sessionId" }, 400);
			return;
		}
		if (sandboxScope) {
			json({ error: "Forbidden" }, 403);
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no",
		});
		try { (res as { flushHeaders?: () => void }).flushHeaders?.(); } catch { /* ok */ }
		// Initial hello so the client knows the stream is live.
		res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);

		// Subscribe to the in-process preview-changed channel populated by the
		// mount POST endpoint. Payload shape `{entry, mtime, url, path}` is
		// forwarded verbatim — the client reads `entry` to seed the iframe.
		const unsubscribe = subscribePreviewChanged(sid, payload => {
			try {
				res.write(`event: preview-changed\ndata: ${JSON.stringify(payload)}\n\n`);
			} catch { /* socket closed */ }
		});
		// Bootstrap: if a mount already exists for this session, emit the
		// current state synchronously so the just-connected client doesn't
		// wait for the next agent write. Avoids a race where
		// broadcastPreviewChanged fires between EventSource open and the
		// subscription being registered. Payload shape `{entry, mtime, url,
		// path}` matches broadcastPreviewChanged so the client doesn't need
		// to distinguish bootstrap from live events.
		try {
			const { pickEntry } = await import("./preview/content-route.js");
			const dir = previewMount.mountDir(sid);
			if (fs.existsSync(dir)) {
				const entry = pickEntry(dir);
				if (entry) {
					const entryPath = path.join(dir, entry);
					const stat = fs.statSync(entryPath);
					const contentHash = previewMount.contentHashForMount(sid);
					const artifact = previewArtifacts.findPreviewArtifactByHash(sid, contentHash);
					res.write(`event: preview-changed\ndata: ${JSON.stringify({
						entry,
						mtime: Math.floor(stat.mtimeMs),
						url: `/preview/${sid}/${entry}`,
						path: entryPath,
						contentHash,
						artifactId: artifact?.artifactId,
					})}\n\n`);
				}
			}
		} catch { /* ok — bootstrap is best-effort */ }
		const keepalive = setInterval(() => {
			try { res.write(":keepalive\n\n"); } catch { /* ok */ }
		}, 25_000);
		if (typeof keepalive.unref === "function") keepalive.unref();
		const cleanup = () => {
			clearInterval(keepalive);
			try { unsubscribe(); } catch { /* ok */ }
		};
		req.on("close", cleanup);
		req.on("error", cleanup);
		return;
	}

	// ── Background process endpoints ──────────────────────────────

	// POST /api/sessions/:id/bg-processes — create a background process
	const bgCreateMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes$/);
	if (bgCreateMatch && req.method === "POST") {
		const id = bgCreateMatch[1];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		const body = await readBody(req);
		if (!body?.command) { json({ error: "command is required" }, 400); return; }
		try {
			const info = bgProcessManager.create(id, body.command, session.cwd, session.containerId, session.sandboxed, body.name);
			json(info, 201);
		} catch (err: any) {
			if (err?.message?.includes("Sandboxed session without containerId")) {
				json({ error: "Sandboxed session cannot run host processes" }, 403);
			} else {
				throw err;
			}
		}
		return;
	}

	// GET /api/sessions/:id/bg-processes — list background processes
	if (bgCreateMatch && req.method === "GET") {
		const id = bgCreateMatch[1];
		json({ processes: bgProcessManager.list(id) });
		return;
	}

	// GET /api/sessions/:id/bg-processes/:pid/logs — get logs
	const bgLogsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)\/logs$/);
	if (bgLogsMatch && req.method === "GET") {
		const [, sessionId, processId] = bgLogsMatch;
		const logs = bgProcessManager.getLogs(sessionId, processId);
		if (!logs) { json({ error: "Process not found" }, 404); return; }
		const tail = parseInt(url.searchParams.get("tail") || "15", 10);
		json({
			log: logs.log.slice(-tail),
			stdout: logs.stdout.slice(-tail),
			stderr: logs.stderr.slice(-tail),
		});
		return;
	}

	// GET /api/sessions/:id/bg-processes/:pid/grep — search logs
	const bgGrepMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)\/grep$/);
	if (bgGrepMatch && req.method === "GET") {
		const [, sessionId, processId] = bgGrepMatch;
		const pattern = url.searchParams.get("pattern") || "";
		if (!pattern) { json({ error: "pattern is required" }, 400); return; }
		const context = parseInt(url.searchParams.get("context") || "0", 10);
		const maxResults = parseInt(url.searchParams.get("max") || "50", 10);
		const result = bgProcessManager.grepLogs(sessionId, processId, pattern, context, maxResults);
		if (!result) { json({ error: "Process not found" }, 404); return; }
		json(result);
		return;
	}

	// GET /api/sessions/:id/bg-processes/:pid/head — first N lines
	const bgHeadMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)\/head$/);
	if (bgHeadMatch && req.method === "GET") {
		const [, sessionId, processId] = bgHeadMatch;
		const lines = parseInt(url.searchParams.get("lines") || "50", 10);
		const result = bgProcessManager.headLogs(sessionId, processId, lines);
		if (!result) { json({ error: "Process not found" }, 404); return; }
		json(result);
		return;
	}

	// GET /api/sessions/:id/bg-processes/:pid/slice — line range (1-indexed)
	const bgSliceMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)\/slice$/);
	if (bgSliceMatch && req.method === "GET") {
		const [, sessionId, processId] = bgSliceMatch;
		const from = parseInt(url.searchParams.get("from") || "1", 10);
		const to = parseInt(url.searchParams.get("to") || "50", 10);
		const result = bgProcessManager.sliceLogs(sessionId, processId, from, to);
		if (!result) { json({ error: "Process not found" }, 404); return; }
		json(result);
		return;
	}

	// GET /api/sessions/:id/bg-processes/:pid/wait — block until exit or timeout
	const bgWaitMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)\/wait$/);
	if (bgWaitMatch && req.method === "GET") {
		const [, sessionId, processId] = bgWaitMatch;
		const timeout = parseInt(url.searchParams.get("timeout") || "300", 10);
		const controller = new AbortController();
		bgProcessManager.registerWait(sessionId, controller);
		try {
			await streamBgWaitResponse(res, () =>
				bgProcessManager.waitForExit(sessionId, processId, timeout * 1000, controller.signal),
				{ clock });
		} finally {
			bgProcessManager.unregisterWait(sessionId, controller);
		}
		return;
	}

	// DELETE /api/sessions/:id/bg-processes/:pid — kill or dismiss a background process
	//   ?action=kill    → terminate a running process; KEEP the exited record until dismissed
	//   ?action=dismiss → remove the record + delete persisted log/status/spool files
	//   (no action)     → legacy: kill-if-running else dismiss
	const bgKillMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)$/);
	if (bgKillMatch && req.method === "DELETE") {
		const [, sessionId, processId] = bgKillMatch;
		const action = url.searchParams.get("action");
		if (action === "kill") {
			const killed = bgProcessManager.kill(sessionId, processId);
			if (!killed) { json({ error: "Process not found or not running" }, 404); return; }
			json({ ok: true, killed: true });
			return;
		}
		if (action === "dismiss") {
			const dismissed = bgProcessManager.dismiss(sessionId, processId);
			if (!dismissed) { json({ error: "Process not found or still running" }, 409); return; }
			json({ ok: true });
			return;
		}
		// Legacy: kill-if-running else dismiss.
		const killed = bgProcessManager.kill(sessionId, processId);
		if (!killed) {
			const dismissed = bgProcessManager.dismiss(sessionId, processId);
			if (!dismissed) { json({ error: "Process not found" }, 404); return; }
		}
		json({ ok: true });
		return;
	}
	// ── Draft endpoints ─────────────────────────────────────────────

	// PUT|POST /api/sessions/:id/draft — upsert a draft
	// POST is accepted alongside PUT because navigator.sendBeacon (used for
	// beforeunload draft flush) always sends POST requests.
	const draftPutMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/draft$/);
	if (draftPutMatch && (req.method === "PUT" || req.method === "POST")) {
		const id = draftPutMatch[1];
		const body = await readBody(req);
		if (!body || typeof body.type !== "string") {
			json({ error: "Missing type" }, 400);
			return;
		}
		const ok = sessionManager.setDraft(id, body.type, body.data);
		if (!ok) { json({ error: "Session not found" }, 404); return; }
		json({ ok: true });
		return;
	}

	// POST /api/sessions/:id/abort — force-abort a streaming session (graceful + force-kill)
	const abortMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/abort$/);
	if (abortMatch && req.method === "POST") {
		const id = abortMatch[1];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		if (session.status !== "streaming") { json({ ok: true, status: session.status }); return; }
		await sessionManager.forceAbort(id);
		json({ ok: true, status: "idle" });
		return;
	}

	// GET /api/sessions/:id/prompt-sections — return system prompt broken into labeled sections
	const promptSectionsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/prompt-sections$/);
	if (promptSectionsMatch && req.method === "GET") {
		const id = promptSectionsMatch[1];

		// Try persisted snapshot first (captures the actual prompt at creation time)
		const persisted = loadPersistedPromptSections(id, sessionManager.stateDir);
		if (persisted) {
			json(persisted);
			return;
		}

		// Fallback: reconstruct for legacy sessions without a persisted snapshot
		const parts = sessionManager.getPromptParts(id);
		if (!parts) { json({ error: "Session not found or no prompt data" }, 404); return; }

		// Ensure tool docs are populated (they may have been injected at assemblePrompt time,
		// but re-inject if missing to handle edge cases)
		if (!parts.toolDocs && toolManager) {
			parts.toolDocs = toolManager.getToolDocsForPrompt(parts.allowedTools, bobbitStateDir());
		}

		const sections = getPromptSections(parts);
		const totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0);
		json({ sections, totalTokens });
		return;
	}

	// GET /api/sessions/:id/draft?type=prompt — retrieve a draft
	const draftGetMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/draft$/);
	if (draftGetMatch && req.method === "GET") {
		const id = draftGetMatch[1];
		const type = url.searchParams.get("type");
		if (!type) { json({ error: "Missing type query param" }, 400); return; }
		const data = sessionManager.getDraft(id, type);
		if (data === undefined) {
			// Check if session exists at all
			const session = sessionManager.getSession(id);
			if (!session) { json({ error: "Session not found" }, 404); return; }
			if (url.searchParams.get("optional") === "1") { noContent(); return; }
			json({ error: "Draft not found" }, 404);
			return;
		}
		json({ type, data });
		return;
	}

	// DELETE /api/sessions/:id/draft?type=prompt — clear a draft
	const draftDelMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/draft$/);
	if (draftDelMatch && req.method === "DELETE") {
		const id = draftDelMatch[1];
		const type = url.searchParams.get("type");
		if (!type) { json({ error: "Missing type query param" }, 400); return; }
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		sessionManager.deleteDraft(id, type);
		json({ ok: true });
		return;
	}

	// ── Review annotation endpoints ────────────────────────────────

	// POST /api/sessions/:id/review/annotations/bulk — bulk save all annotations + submitted flag (used by sendBeacon on page unload)
	if (req.method === "POST" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/review/annotations/bulk")) {
		const sessionId = url.pathname.split("/")[3];
		if (!sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
		if (!reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
		const body = await readBody(req);
		if (!body || typeof body !== "object") { json({ error: "Invalid body" }, 400); return; }
		const annotations: Record<string, ReviewAnnotation[]> = {};
		if (body.annotations && typeof body.annotations === "object") {
			for (const [docTitle, anns] of Object.entries(body.annotations)) {
				if (Array.isArray(anns)) {
					annotations[docTitle] = anns as ReviewAnnotation[];
				}
			}
		}
		// If `submitted` is omitted (or non-boolean), preserve whatever is
		// already on disk. This is critical: the page-unload beacon historically
		// sent `submitted: false` whenever the local cache hadn't observed a
		// `true`, which clobbered out-of-band PUT(submitted=true) calls (other
		// tabs, REST clients, the test harness) on the next page reload (RP-09).
		// The client now omits the field unless it positively wants to write
		// `true`; the legacy clear path still goes through the dedicated
		// /review/submitted PUT.
		const submitted = typeof body.submitted === "boolean"
			? body.submitted
			: reviewAnnotationStore.isSubmitted(sessionId);
		reviewAnnotationStore.writeAll(sessionId, annotations, submitted);
		json({ ok: true });
		return;
	}

	// GET /api/sessions/:id/review/annotations
	if (req.method === "GET" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/review/annotations")) {
		const sessionId = url.pathname.split("/")[3];
		if (!sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
		if (!reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
		const data = reviewAnnotationStore.getAll(sessionId);
		json(data);
		return;
	}

	// POST /api/sessions/:id/review/annotations
	if (req.method === "POST" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/review/annotations")) {
		const sessionId = url.pathname.split("/")[3];
		if (!sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
		if (!reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
		const body = await readBody(req);
		if (!body?.docTitle || !body?.annotation) {
			json({ error: "docTitle and annotation required" }, 400);
			return;
		}
		reviewAnnotationStore.addAnnotation(sessionId, body.docTitle, body.annotation);
		json({ ok: true });
		return;
	}

	// DELETE /api/sessions/:id/review/annotations[/:annotationId]
	if (req.method === "DELETE" && url.pathname.startsWith("/api/sessions/") && url.pathname.includes("/review/annotations")) {
		const parts = url.pathname.split("/");
		const sessionId = parts[3];
		if (!sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
		if (!reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
		if (parts.length >= 7 && parts[6]) {
			// DELETE /api/sessions/:id/review/annotations/:annotationId
			const annotationId = decodeURIComponent(parts[6]);
			const docTitle = url.searchParams.get("docTitle");
			if (!docTitle) { json({ error: "docTitle query parameter is required" }, 400); return; }
			reviewAnnotationStore.removeAnnotation(sessionId, docTitle, annotationId);
			json({ ok: true });
		} else {
			// DELETE /api/sessions/:id/review/annotations — clear all or by docTitle
			const body = await readBody(req);
			const docTitle = body?.docTitle;
			if (docTitle) {
				reviewAnnotationStore.clearAnnotations(sessionId, docTitle);
			} else {
				reviewAnnotationStore.clearAll(sessionId);
			}
			json({ ok: true });
		}
		return;
	}

	// GET /api/sessions/:id/review/submitted
	if (req.method === "GET" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/review/submitted")) {
		const sessionId = url.pathname.split("/")[3];
		if (!sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
		if (!reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
		json({ submitted: reviewAnnotationStore.isSubmitted(sessionId) });
		return;
	}

	// PUT /api/sessions/:id/review/submitted
	if (req.method === "PUT" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/review/submitted")) {
		const sessionId = url.pathname.split("/")[3];
		if (!sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
		if (!reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
		const body = await readBody(req);
		reviewAnnotationStore.setSubmitted(sessionId, !!body?.submitted);
		json({ ok: true });
		return;
	}

	// ── Staff endpoints ────────────────────────────────────────────

	// GET /api/staff/orphaned — staff with missing projectId or stuck on the system project
	if (url.pathname === "/api/staff/orphaned" && req.method === "GET") {
		json({ staff: staffManager.listOrphaned() });
		return;
	}

	// GET /api/staff
	if (url.pathname === "/api/staff" && req.method === "GET") {
		const projectId = url.searchParams.get("projectId") || undefined;
		json({ staff: staffManager.listStaff(projectId) });
		return;
	}

	// POST /api/staff
	if (url.pathname === "/api/staff" && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.name || typeof body.name !== "string") {
			json({ error: "Missing name" }, 400);
			return;
		}
		if (!body?.systemPrompt || typeof body.systemPrompt !== "string") {
			json({ error: "Missing systemPrompt" }, 400);
			return;
		}
		// Defense-in-depth: roleId, when present, must be a string or null.
		if (body.roleId !== undefined && body.roleId !== null && typeof body.roleId !== "string") {
			json({ error: "roleId must be a string or null" }, 400);
			return;
		}
		// Validate goal-* triggers carry a non-empty prompt (push-based
		// dispatcher has no fallback; the prompt is mandatory).
		try {
			staffManager.validateTriggers(body.triggers);
		} catch (err: any) {
			jsonError(400, err);
			return;
		}
		const explicitCwd = typeof body.cwd === "string" && body.cwd.trim().length > 0
			? body.cwd.trim()
			: undefined;
		const explicitProjectId = typeof body.projectId === "string" && body.projectId.trim().length > 0
			? body.projectId.trim()
			: undefined;
		const resolved = resolveProjectForRequest(projectRegistry, { projectId: explicitProjectId });
		if (!resolved.ok) { writeProjectResolutionError(resolved); return; }
		const cwd = explicitCwd ?? resolved.project.rootPath;
		const cwdValidation = validateExecutionCwd(projectRegistry, projectContextManager, resolved.projectId, cwd, { kind: "user-input" });
		if (!cwdValidation.ok) { writeCwdValidationError(cwdValidation); return; }
		const projectId = resolved.projectId;
		// Validate the referenced role exists in the selected project's cascade.
		// roleId omitted or null/empty is allowed — staff with no role behave as before.
		if (typeof body.roleId === "string" && body.roleId.length > 0 && !resolveRoleForProject(body.roleId, projectId)) {
			json({ error: "Role not found" }, 404);
			return;
		}
		try {
			const staff = await staffManager.createStaff(
				body.name,
				body.description || "",
				body.systemPrompt,
				cwd,
				sessionManager,
				{
					triggers: body.triggers,
					roleId: body.roleId,
					accessory: body.accessory,
					projectId,
					sandboxed: body.sandboxed === true,
					...(typeof body.worktree === "boolean" ? { worktree: body.worktree } : {}),
				},
			);
			broadcastStaffChanged({
				type: "staff_changed",
				reason: "created",
				staffId: staff.id,
				projectId,
				sessionId: staff.currentSessionId,
			});
			json(staff, 201);
		} catch (err: any) {
			console.error("[server] Failed to create staff agent:", err);
			jsonError(500, err);
		}
		return;
	}

	// Routes with staff :id parameter
	const staffMatch = url.pathname.match(/^\/api\/staff\/([^/]+)$/);
	if (staffMatch) {
		const id = staffMatch[1];

		if (req.method === "GET") {
			const staff = staffManager.getStaff(id);
			if (!staff) { json({ error: "Staff agent not found" }, 404); return; }
			json(staff);
			return;
		}

		if (req.method === "PATCH") {
			const body = await readBody(req);
			if (!body || typeof body.projectId !== "string" || !body.projectId.trim()) {
				json({ error: "Missing projectId" }, 400);
				return;
			}
			const targetProjectId = body.projectId.trim();
			const targetProject = projectRegistry.get(targetProjectId);
			if (!targetProject) { json({ error: "Project not found" }, 404); return; }
			if (targetProject.hidden || targetProject.id === SYSTEM_PROJECT_ID) {
				json({ error: "projectId must reference a registered project" }, 400);
				return;
			}
			const previousStaff = staffManager.getStaff(id);
			try {
				const staff = await staffManager.reassignProject(id, targetProjectId, sessionManager);
				if (!staff) { json({ error: "Staff agent not found" }, 404); return; }
				broadcastStaffChanged({
					type: "staff_changed",
					reason: "reassigned",
					staffId: staff.id,
					projectId: targetProjectId,
					previousProjectId: previousStaff?.projectId,
					sessionId: previousStaff?.currentSessionId,
				});
				json(staff);
			} catch (err: any) {
				jsonError(400, err);
			}
			return;
		}

		if (req.method === "PUT") {
			const body = await readBody(req);
			if (!body) { json({ error: "Missing body" }, 400); return; }
			// Defense-in-depth: roleId, when present, must be a string or null.
			if (body.roleId !== undefined && body.roleId !== null && typeof body.roleId !== "string") {
				json({ error: "roleId must be a string or null" }, 400);
				return;
			}
			const existingStaff = staffManager.getStaff(id);
			if (!existingStaff) { json({ error: "Staff agent not found" }, 404); return; }
			// Validate the referenced role exists in the staff agent's project cascade.
			// roleId: null (clear) and omitted are allowed.
			if (typeof body.roleId === "string" && body.roleId.length > 0 && !resolveRoleForProject(body.roleId, existingStaff.projectId)) {
				json({ error: "Role not found" }, 404);
				return;
			}
			// Validate goal-* triggers carry a non-empty prompt before any other
			// work (mirrors POST /api/staff). Only applies when the caller is
			// updating triggers — PUTs that omit the field are unchanged.
			if (Object.prototype.hasOwnProperty.call(body, "triggers")) {
				try {
					staffManager.validateTriggers(body.triggers);
				} catch (err: any) {
					jsonError(400, err);
					return;
				}
			}

			let cwdUpdate: string | undefined;
			if (Object.prototype.hasOwnProperty.call(body, "cwd")) {
				const staff = existingStaff;
				if (typeof body.cwd !== "string" || body.cwd.trim().length === 0) {
					json({ error: "cwd must be a non-empty string" }, 400);
					return;
				}
				const requestedCwd = body.cwd.trim();
				const normalizeCwdForComparison = (value: string): string => {
					let resolved = path.resolve(value.trim());
					try { resolved = fs.realpathSync(resolved); } catch { /* compare textual path when legacy cwd no longer exists */ }
					let normalized = resolved.replace(/\\/g, "/");
					if (process.platform === "win32") normalized = normalized.toLowerCase();
					return normalized.replace(/\/+$/, "");
				};
				const existingCwd = typeof staff.cwd === "string" ? staff.cwd : "";
				const isUnchangedCwd = existingCwd.trim().length > 0
					&& normalizeCwdForComparison(requestedCwd) === normalizeCwdForComparison(existingCwd);
				if (!isUnchangedCwd) {
					const staffProjectId = typeof staff.projectId === "string" && staff.projectId.trim().length > 0
						? staff.projectId.trim()
						: undefined;
					const staffProject = staffProjectId ? projectRegistry.get(staffProjectId) : undefined;
					if (!staffProject || staffProject.hidden || staffProject.id === SYSTEM_PROJECT_ID) {
						json({ error: "Staff agent is not attached to a registered project" }, 400);
						return;
					}
					const cwdValidation = validateExecutionCwd(projectRegistry, projectContextManager, staffProject.id, requestedCwd, { kind: "staff", staffId: staff.id });
					if (!cwdValidation.ok) { writeCwdValidationError(cwdValidation); return; }
					cwdUpdate = requestedCwd;
				}
			}

			const hasAccessoryUpdate = Object.prototype.hasOwnProperty.call(body, "accessory");
			const ok = staffManager.updateStaff(id, {
				name: body.name,
				description: body.description,
				systemPrompt: body.systemPrompt,
				cwd: cwdUpdate,
				state: body.state,
				triggers: body.triggers,
				memory: body.memory,
				roleId: body.roleId,
				accessory: hasAccessoryUpdate ? body.accessory : undefined,
				contextPolicy:
					body.contextPolicy === "preserve" || body.contextPolicy === "compact"
						? body.contextPolicy
						: undefined,
			});
			if (!ok) { json({ error: "Staff agent not found" }, 404); return; }
			const staff = staffManager.getStaff(id);
			if (hasAccessoryUpdate && staff?.currentSessionId) {
				sessionManager.updateSessionMeta(staff.currentSessionId, { accessory: staff.accessory });
			}
			if (staff) {
				broadcastStaffChanged({
					type: "staff_changed",
					reason: "updated",
					staffId: staff.id,
					projectId: staff.projectId ?? existingStaff.projectId ?? SYSTEM_PROJECT_ID,
					sessionId: staff.currentSessionId,
				});
			}
			json(staff);
			return;
		}

		if (req.method === "DELETE") {
			const previousStaff = staffManager.getStaff(id);
			const ok = await staffManager.deleteStaff(id, sessionManager);
			if (!ok) { json({ error: "Staff agent not found" }, 404); return; }
			if (previousStaff) {
				broadcastStaffChanged({
					type: "staff_changed",
					reason: "deleted",
					staffId: previousStaff.id,
					projectId: previousStaff.projectId ?? SYSTEM_PROJECT_ID,
					sessionId: previousStaff.currentSessionId,
				});
			}
			json({ ok: true });
			return;
		}
	}

	// ── Staff inbox endpoints ──────────────────────────────────────
	// `POST /api/staff/:id/wake` was deleted as part of the staff-inbox migration
	// (see docs/design/staff-inbox.md §7.2). UI/external integrations now hit
	// `POST /api/staff/:id/inbox` with `source.type = "manual_ui" | "manual_api"`.

	// GET /api/staff/:id/inbox?state=pending&limit=50
	const staffInboxListMatch = url.pathname.match(/^\/api\/staff\/([^/]+)\/inbox$/);
	if (staffInboxListMatch && req.method === "GET") {
		const id = staffInboxListMatch[1];
		if (!inboxManager) { json({ error: "Inbox not initialised" }, 500); return; }
		const staff = staffManager.getStaff(id);
		if (!staff) { json({ error: "Staff agent not found" }, 404); return; }
		const rawState = url.searchParams.get("state");
		const allowedStates: ReadonlyArray<InboxEntry["state"]> = ["pending", "completed", "failed", "cancelled"];
		const state = rawState && (allowedStates as readonly string[]).includes(rawState)
			? (rawState as InboxEntry["state"])
			: undefined;
		const limitRaw = url.searchParams.get("limit");
		const limit = limitRaw != null ? Math.max(0, parseInt(limitRaw, 10) || 0) : undefined;
		const entries = inboxManager.listForStaff(id, state, limit);
		json({ entries });
		return;
	}

	// POST /api/staff/:id/inbox
	if (staffInboxListMatch && req.method === "POST") {
		const id = staffInboxListMatch[1];
		if (!inboxManager) { json({ error: "Inbox not initialised" }, 500); return; }
		const staff = staffManager.getStaff(id);
		if (!staff) { json({ error: "Staff agent not found" }, 404); return; }
		const body = await readBody(req);
		if (!body || typeof body.title !== "string" || !body.title.trim()) {
			json({ error: "Missing title" }, 400);
			return;
		}
		if (typeof body.prompt !== "string" || !body.prompt.trim()) {
			json({ error: "Missing prompt" }, 400);
			return;
		}
		const sourceType = body.source?.type === "manual_ui" || body.source?.type === "trigger"
			? body.source.type
			: "manual_api";
		const actorId = typeof body.source?.actorId === "string" ? body.source.actorId : undefined;
		try {
			const entry = inboxManager.enqueue(id, {
				title: body.title,
				prompt: body.prompt,
				context: typeof body.context === "string" ? body.context : undefined,
				source: { type: sourceType, actorId },
			});
			json({ entry }, 201);
		} catch (err) {
			jsonError(400, err);
		}
		return;
	}

	// POST /api/staff/:id/inbox/:entryId/complete
	const staffInboxCompleteMatch = url.pathname.match(/^\/api\/staff\/([^/]+)\/inbox\/([^/]+)\/complete$/);
	if (staffInboxCompleteMatch && req.method === "POST") {
		const [, id, entryId] = staffInboxCompleteMatch;
		if (!inboxManager) { json({ error: "Inbox not initialised" }, 500); return; }
		const staff = staffManager.getStaff(id);
		if (!staff) { json({ error: "Staff agent not found" }, 404); return; }
		const body = await readBody(req);
		if (!body || typeof body.sessionId !== "string" || !body.sessionId) {
			json({ error: "Missing sessionId" }, 400);
			return;
		}
		const session = sessionManager.getSession(body.sessionId);
		if (!session || session.staffId !== id) {
			json({ error: "Forbidden: session does not belong to this staff" }, 403);
			return;
		}
		const existing = inboxManager.listForStaff(id).find(e => e.id === entryId);
		if (!existing) { json({ error: "Inbox entry not found" }, 404); return; }
		if (existing.state !== "pending") {
			json({ error: `Inbox entry ${entryId} is ${existing.state}, expected pending` }, 409);
			return;
		}
		try {
			const entry = inboxManager.transitionToCompleted(id, entryId, typeof body.summary === "string" ? body.summary : undefined);
			json({ entry });
		} catch (err) {
			jsonError(400, err);
		}
		return;
	}

	// POST /api/staff/:id/inbox/:entryId/dismiss
	const staffInboxDismissMatch = url.pathname.match(/^\/api\/staff\/([^/]+)\/inbox\/([^/]+)\/dismiss$/);
	if (staffInboxDismissMatch && req.method === "POST") {
		const [, id, entryId] = staffInboxDismissMatch;
		if (!inboxManager) { json({ error: "Inbox not initialised" }, 500); return; }
		const staff = staffManager.getStaff(id);
		if (!staff) { json({ error: "Staff agent not found" }, 404); return; }
		const body = await readBody(req);
		if (!body || typeof body.sessionId !== "string" || !body.sessionId) {
			json({ error: "Missing sessionId" }, 400);
			return;
		}
		const session = sessionManager.getSession(body.sessionId);
		if (!session || session.staffId !== id) {
			json({ error: "Forbidden: session does not belong to this staff" }, 403);
			return;
		}
		if (body.outcome !== "failed" && body.outcome !== "cancelled") {
			json({ error: "outcome must be 'failed' or 'cancelled'" }, 400);
			return;
		}
		if (typeof body.reason !== "string" || !body.reason.trim()) {
			json({ error: "Missing reason" }, 400);
			return;
		}
		const existing = inboxManager.listForStaff(id).find(e => e.id === entryId);
		if (!existing) { json({ error: "Inbox entry not found" }, 404); return; }
		if (existing.state !== "pending") {
			json({ error: `Inbox entry ${entryId} is ${existing.state}, expected pending` }, 409);
			return;
		}
		try {
			const entry = inboxManager.transitionToTerminal(id, entryId, body.outcome, body.reason);
			json({ entry });
		} catch (err) {
			jsonError(400, err);
		}
		return;
	}

	// DELETE /api/staff/:id/inbox/:entryId
	const staffInboxDeleteMatch = url.pathname.match(/^\/api\/staff\/([^/]+)\/inbox\/([^/]+)$/);
	if (staffInboxDeleteMatch && req.method === "DELETE") {
		const [, id, entryId] = staffInboxDeleteMatch;
		if (!inboxManager) { json({ error: "Inbox not initialised" }, 500); return; }
		const staff = staffManager.getStaff(id);
		if (!staff) { json({ error: "Staff agent not found" }, 404); return; }
		const ok = inboxManager.remove(id, entryId);
		if (!ok) { json({ error: "Inbox entry not found" }, 404); return; }
		json({ ok: true });
		return;
	}

	// GET /api/staff/:id/sessions — DEPRECATED (staff agents have a single permanent session)
	const staffSessionsMatch = url.pathname.match(/^\/api\/staff\/([^/]+)\/sessions$/);
	if (staffSessionsMatch && req.method === "GET") {
		json({ error: "Deprecated. Staff agents have a single permanent session. Use GET /api/staff/:id." }, 410);
		return;
	}

	// GET /api/mcp-servers
	if (url.pathname === "/api/mcp-servers" && req.method === "GET") {
		const projectId = url.searchParams.get("projectId") || undefined;
		const cwd = url.searchParams.get("cwd") || undefined;
		const resolvedProject = resolveProjectForRequest(projectRegistry, { projectId });
		if (!resolvedProject.ok) { writeProjectResolutionError(resolvedProject); return; }
		if (cwd) {
			const cwdValidation = validateExecutionCwd(projectRegistry, projectContextManager, resolvedProject.projectId, cwd, { kind: "user-input" });
			if (!cwdValidation.ok) { writeCwdValidationError(cwdValidation); return; }
		}
		const ensure = url.searchParams.get("ensure") === "true";
		const resolvedProjectId = resolvedProject.projectId;
		const mcpManager = ensure ? await sessionManager.ensureMcpManager({ projectId: resolvedProjectId }) : sessionManager.getMcpManager({ projectId: resolvedProjectId });
		if (!mcpManager) {
			json([]);
			return;
		}
		const statuses = mcpManager.getServerStatuses();
		const routeSnapshots = mcpManager.getToolRouteSnapshots();
		const result = statuses.map(s => {
			const ownedRoutes = routeSnapshots.filter(t => t.runtimeServerKey === s.name);
			const publicServerNames = new Set<string>([
				...ownedRoutes.map(t => t.publicServerName),
				...(s.ownerContributions ?? []).map(c => c.serverName),
			].filter((name): name is string => typeof name === "string" && name.length > 0));
			const publicServerName = publicServerNames.size === 1 ? [...publicServerNames][0] : undefined;
			const serverPolicyKey = publicServerName ? `mcp__${publicServerName}` : `mcp__${s.name}`;
			return {
				...s,
				serverPolicyKey,
				policyKey: serverPolicyKey,
				toolCount: ownedRoutes.length,
				tools: ownedRoutes.map(t => {
					const parsed = parseMcpToolName(t.name);
					const subNamespace = t.subNamespace ?? parsed?.sub;
					const routeServerPolicyKey = `mcp__${t.publicServerName}`;
					const packagePolicyKey = subNamespace ? `${routeServerPolicyKey}__${subNamespace}` : undefined;
					return {
						name: t.name,
						description: t.description,
						serverPolicyKey: routeServerPolicyKey,
						policyKey: t.name,
						operationPolicyKey: t.name,
						...(packagePolicyKey ? { packagePolicyKey, subNamespacePolicyKey: packagePolicyKey } : {}),
						subNamespace,
						op: parsed?.op ?? t.mcpToolName,
					};
				}),
			};
		});
		json(result);
		return;
	}

	// POST /api/mcp-servers/:name/restart
	const mcpRestartMatch = url.pathname.match(/^\/api\/mcp-servers\/([^/]+)\/restart$/);
	if (mcpRestartMatch && req.method === "POST") {
		const projectId = url.searchParams.get("projectId") || undefined;
		const cwd = url.searchParams.get("cwd") || undefined;
		const resolvedProject = resolveProjectForRequest(projectRegistry, { projectId });
		if (!resolvedProject.ok) { writeProjectResolutionError(resolvedProject); return; }
		if (cwd) {
			const cwdValidation = validateExecutionCwd(projectRegistry, projectContextManager, resolvedProject.projectId, cwd, { kind: "user-input" });
			if (!cwdValidation.ok) { writeCwdValidationError(cwdValidation); return; }
		}
		const resolvedProjectId = resolvedProject.projectId;
		const mcpManager = await sessionManager.ensureMcpManager({ projectId: resolvedProjectId });
		if (!mcpManager) {
			json({ error: "MCP not initialized" }, 500);
			return;
		}
		const serverName = decodeURIComponent(mcpRestartMatch[1]);
		let statuses = mcpManager.getServerStatuses();
		let existing = statuses.find(s => s.name === serverName);
		if (!existing || !existing.config) {
			// Re-discover servers in case config was added after startup
			const discovered = mcpManager.discoverServers();
			if (!discovered[serverName]) {
				json({ error: `MCP server "${serverName}" not found` }, 404);
				return;
			}
			// Connect the newly discovered server
			await mcpManager.connectServer(serverName, discovered[serverName]);
		} else {
			await mcpManager.disconnectServer(serverName);
			// Re-discover to pick up any config changes from disk
			const refreshed = mcpManager.discoverServers();
			const config = refreshed[serverName] || existing.config;
			await mcpManager.connectServer(serverName, config);
		}
		// Re-register MCP tools with ToolManager across default and scoped managers.
		refreshMcpExternalTools();
		const updated = mcpManager.getServerStatuses().find(s => s.name === serverName);
		json({ ok: true, ...updated });
		return;
	}

	// POST /api/internal/mcp-call
	if (url.pathname === "/api/internal/mcp-call" && req.method === "POST") {
		let parsedToolForError: string | undefined;
		try {
			const body = await new Promise<string>((resolve) => {
				let data = "";
				req.on("data", (chunk: Buffer) => data += chunk.toString());
				req.on("end", () => resolve(data));
			});
			const parsedBody = JSON.parse(body);
			const { tool, args } = parsedBody;
			const scopeKey = typeof parsedBody?.scopeKey === "string" && parsedBody.scopeKey ? parsedBody.scopeKey : undefined;
			parsedToolForError = typeof tool === "string" ? tool : undefined;
			if (!tool) {
				json({ error: "Missing 'tool' field" }, 400);
				return;
			}

			// Enforce allowedTools for the calling session.
			// This endpoint is internal — only MCP proxy extensions should call it.
			// Require session ID header to prevent direct curl bypass.
			const mcpSessionId = req.headers["x-bobbit-session-id"] as string | undefined;
			if (!mcpSessionId) {
				json({ error: "Missing X-Bobbit-Session-Id header" }, 403);
				return;
			}
			// Verify the session exists (live or persisted).
			const mcpSession = sessionManager.getSession(mcpSessionId);
			const persistedSession = mcpSession ? null : (
				// Search across all project stores for persisted session
				projectContextManager.getContextForSession(mcpSessionId)?.sessionStore.get(mcpSessionId)
				?? null
			);
			if (!mcpSession && !persistedSession) {
				json({ error: `Session "${mcpSessionId}" not found` }, 403);
				return;
			}
			if (!(mcpSession?.projectId ?? persistedSession?.projectId)) {
				json({ error: "Session missing projectId", code: "PROJECT_ID_REQUIRED" }, 403);
				return;
			}
			const mcpManager = await sessionManager.resolveMcpManagerForSession(mcpSessionId, scopeKey);
			if (!mcpManager) {
				json({ error: "MCP not initialized" }, 500);
				return;
			}
			// Enforce allowedTools for non-MCP tools on live sessions.
			// MCP tools (mcp__*) are dynamically discovered and governed by the
			// grant policy system — they may not appear in the session's static
			// allowedTools list, so we skip the check for them.
			const toolStr = tool as string;
			if (!toolStr.startsWith("mcp__") && mcpSession?.allowedTools && mcpSession.allowedTools.length > 0) {
				if (!mcpSession.allowedTools.some((t: string) => t.toLowerCase() === toolStr.toLowerCase())) {
					json({ error: `Tool "${tool}" is not allowed for this session` }, 403);
					return;
				}
			}

			// Layer B per-op never-policy enforcement (§4.3). Resolves the per-op
			// policy for `mcp__<server>__<op>` even though the model only sees the
			// aggregated `mcp_<server>` meta-tool — keeps `never` denials honoured
			// after the meta-tool is granted wholesale.
			if (toolStr.startsWith("mcp__")) {
				const roleName = mcpSession?.role ?? (persistedSession as any)?.role;
				const role = roleName ? resolveRoleForProject(roleName, mcpSession?.projectId ?? (persistedSession as any)?.projectId) : undefined;
				const parsed = parseMcpToolName(toolStr);
				const opGroup = parsed?.server ? `MCP: ${parsed.server}` : undefined;
				const policy = resolveGrantPolicy(toolStr, opGroup, role, toolManager, groupPolicyStore);
				if (policy === "never") {
					json({ error: `tool ${toolStr} denied by policy`, tool: toolStr, reason: "policy=never" }, 403);
					return;
				}
			}

			const result = await mcpManager.callTool(tool, args || {});
			json(result);
		} catch (err) {
			const e = err as Error;
			console.error(`[mcp] Tool call failed:`, e.stack || e);
			// Parse `mcp__<server>__<op>` into structured fields (§5.4).
			let parsedServer: string | undefined;
			let parsedOperation: string | undefined;
			if (parsedToolForError && parsedToolForError.startsWith("mcp__")) {
				const parsedErr = parseMcpToolName(parsedToolForError);
				if (parsedErr) {
					parsedServer = parsedErr.server;
					parsedOperation = parsedErr.sub ? `${parsedErr.sub}__${parsedErr.op}` : parsedErr.op;
				}
			}
			json({ error: e.message, server: parsedServer, operation: parsedOperation, stack: e.stack }, 500);
		}
		return;
	}

	// POST /api/internal/mcp-describe — discovery endpoint for the `mcp_describe` tool (§3.3)
	if (url.pathname === "/api/internal/mcp-describe" && req.method === "POST") {
		try {
			const body = await new Promise<string>((resolve) => {
				let data = "";
				req.on("data", (chunk: Buffer) => data += chunk.toString());
				req.on("end", () => resolve(data));
			});
			const parsed = JSON.parse(body || "{}");
			const server: string | undefined = parsed?.server;
			const operation: string | undefined = parsed?.operation;
			const scopeKey = typeof parsed?.scopeKey === "string" && parsed.scopeKey ? parsed.scopeKey : undefined;
			if (!server || typeof server !== "string") {
				json({ error: "Missing 'server' field" }, 400);
				return;
			}

			const describeSessionId = req.headers["x-bobbit-session-id"] as string | undefined;
			if (!describeSessionId) {
				json({ error: "Missing X-Bobbit-Session-Id header" }, 403);
				return;
			}
			const liveSession = sessionManager.getSession(describeSessionId);
			const persistedSession = liveSession ? null : (
				projectContextManager.getContextForSession(describeSessionId)?.sessionStore.get(describeSessionId)
				?? null
			);
			if (!liveSession && !persistedSession) {
				json({ error: `Session "${describeSessionId}" not found` }, 403);
				return;
			}
			if (!(liveSession?.projectId ?? persistedSession?.projectId)) {
				json({ error: "Session missing projectId", code: "PROJECT_ID_REQUIRED" }, 403);
				return;
			}
			const mcpManager = await sessionManager.resolveMcpManagerForSession(describeSessionId, scopeKey);
			if (!mcpManager) {
				json({ error: "MCP not initialized" }, 500);
				return;
			}

			const statuses = mcpManager.getServerStatuses();
			const directStatus = statuses.find(s => s.name === server);
			const ownerStatuses = statuses.filter(s => (s.ownerContributions ?? []).some((c) => c.serverName === server));
			const connectedRuntimeKeys = new Set(
				statuses.filter(s => s.status === "connected").map(s => s.name),
			);
			const serverIsConnected = directStatus?.status === "connected" || ownerStatuses.some(s => s.status === "connected");
			if (!serverIsConnected) {
				const statusForReason = directStatus ?? ownerStatuses.find(s => s.error || s.status !== "connected");
				const reason = statusForReason?.error ?? (statusForReason ? statusForReason.status : "unknown server");
				json({ error: `server ${server} not connected: ${reason}` }, 503);
				return;
			}

			const infos = mcpManager.getToolRouteSnapshots()
				.filter(i => i.publicServerName === server && connectedRuntimeKeys.has(i.runtimeServerKey));
			const describeNameFor = (info: (typeof infos)[number]): { name: string; subNamespace?: string } => {
				const parsedName = parseMcpToolName(info.name);
				if (parsedName?.server === server && info.subNamespace && parsedName.sub === info.subNamespace) {
					return { name: parsedName.op, subNamespace: info.subNamespace };
				}
				return { name: info.mcpToolName };
			};
			const toDescriptor = (info: (typeof infos)[number]) => {
				const described = describeNameFor(info);
				return {
					name: described.name,
					...(described.subNamespace ? { subNamespace: described.subNamespace } : {}),
					description: info.description,
					inputSchema: info.inputSchema,
				};
			};
			if (operation) {
				const match = infos.find(i => i.mcpToolName === operation)
					?? infos.find(i => describeNameFor(i).name === operation);
				if (!match) {
					json({ error: "operation not found" }, 404);
					return;
				}
				json({ tool: toDescriptor(match) });
				return;
			}
			json({ tools: infos.map(toDescriptor) });
		} catch (err) {
			const e = err as Error;
			console.error(`[mcp] Describe failed:`, e.stack || e);
			json({ error: e.message, stack: e.stack }, 500);
		}
		return;
	}

	// POST /api/internal/verification-result
	if (url.pathname === "/api/internal/verification-result" && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.sessionId || !body?.verdict || !body?.summary || typeof body.sessionId !== "string" || typeof body.verdict !== "string" || typeof body.summary !== "string") {
			json({ error: "Missing required fields: sessionId, verdict, summary" }, 400);
			return;
		}
		const resolver = verificationHarness.pendingResults.get(body.sessionId);
		if (!resolver) {
			console.warn(`[verification][reviewer-lifecycle] verification_result POST 404-dropped for session ${body.sessionId} (verdict=${body.verdict}) — no pending resolver (teardown already ran / unknown session).`);
			json({ error: "No pending verification for this session" }, 404);
			return;
		}
		console.log(`[verification][reviewer-lifecycle] verification_result POST accepted for session ${body.sessionId} (verdict=${body.verdict}).`);
		// Support report_html_file: server reads file directly (avoids tool output limits for large reports)
		if (typeof body.report_html === "string" && typeof body.report_html_file === "string") {
			json({ error: "Provide either report_html or report_html_file, not both" }, 400);
			return;
		}
		let reportHtml: string | undefined = typeof body.report_html === "string" ? body.report_html : undefined;
		if (!reportHtml && typeof body.report_html_file === "string") {
			try {
				let filePath = body.report_html_file;
				// Resolve relative paths against the session's CWD
				if (!path.isAbsolute(filePath)) {
					const session = sessionManager.getSession(body.sessionId);
					if (session) filePath = path.resolve(session.cwd, filePath);
				}
				// On Windows, POSIX paths from Git Bash (/tmp/...) resolve to C:\tmp\... which doesn't exist.
				// Fall back to the system TEMP directory for /tmp/ paths.
				if (process.platform === "win32" && !fs.existsSync(filePath) && body.report_html_file.startsWith("/tmp/")) {
					const tempDir = process.env.TEMP || process.env.TMP || "C:\\Windows\\Temp";
					const tempResolved = path.join(tempDir, body.report_html_file.slice(5));
					if (fs.existsSync(tempResolved)) filePath = tempResolved;
				}
				const stat = fs.statSync(filePath);
				const MAX_REPORT_SIZE = 10 * 1024 * 1024; // 10 MB
				if (stat.size > MAX_REPORT_SIZE) {
					json({ error: `Report file too large (${stat.size} bytes, max ${MAX_REPORT_SIZE})` }, 400);
					return;
				}
				reportHtml = fs.readFileSync(filePath, "utf-8");
			} catch (e: any) {
				json({ error: `Failed to read report file: ${e.message}` }, 400);
				return;
			}
		}
		// Inline any <img src="file://..."> references so the report renders from
		// the browser's blob origin (cross-origin file:// loads are blocked).
		if (reportHtml) {
			const session = sessionManager.getSession(body.sessionId);
			if (session?.cwd) {
				try {
					reportHtml = inlineFileImages(reportHtml, session.cwd, {
						logger: (msg) => console.warn(msg),
					});
				} catch (err: any) {
					console.warn(`[verification] inlineFileImages failed: ${err?.message || err}`);
				}
			}
		}
		resolver({
			verdict: body.verdict === "pass",
			summary: body.summary,
			reportHtml,
		});
		json({ ok: true });
		return;
	}

	// POST /api/internal/user-question/submit  — called by the UI widget with answers.
	// Non-blocking model: appends a tagged user message to the session transcript
	// via `enqueuePrompt` (the normal user-prompt path), which persists to .jsonl,
	// broadcasts, and wakes the agent. Idempotent: duplicate submits for the same
	// tool_use_id are a no-op (the second tab's submit is swallowed).
	// See src/shared/ask-envelope.ts for the envelope format.
	if (url.pathname === "/api/internal/user-question/submit" && req.method === "POST") {
		const body = await readBody(req);
		const { sessionId, toolUseId, answers } = body || {};
		if (typeof sessionId !== "string" || typeof toolUseId !== "string" || !Array.isArray(answers)) {
			json({ error: "Missing required fields: sessionId, toolUseId, answers" }, 400);
			return;
		}
		const answerErr = validateAnswers(answers);
		if (answerErr) { json({ error: answerErr }, 400); return; }
		const session = sessionManager.getSession(sessionId);
		if (!session) { json({ error: "Unknown session" }, 404); return; }

		// Pull the transcript to locate the original tool_use (for cross-validation)
		// and to detect duplicate submits (multi-tab / network retry).
		let messages: any[] = [];
		try {
			const msgsResp = await session.rpcClient.getMessages();
			const raw = msgsResp?.data?.messages || msgsResp?.data;
			if (Array.isArray(raw)) messages = raw;
		} catch (e: any) {
			json({ error: `Could not load transcript: ${e?.message || String(e)}` }, 500);
			return;
		}

		// Idempotency: if a response envelope for this toolUseId already exists,
		// return success without appending again. Check in-memory guard first
		// (covers the race where a duplicate /submit arrives before the first
		// envelope has propagated into the transcript), then the transcript
		// (covers process restart / external writers).
		const dedupKey = `${sessionId}::${toolUseId}`;
		if (askSubmittedToolUseIds.has(dedupKey)) {
			json({ ok: true, alreadySubmitted: true });
			return;
		}
		const existing = findAskResponseAnswers(messages, toolUseId);
		if (existing) {
			askSubmittedToolUseIds.add(dedupKey);
			json({ ok: true, alreadySubmitted: true });
			return;
		}

		// Locate the ask_user_choices tool_use block; use its input to cross-validate.
		let matchedQuestions: UserQuestion[] | null = null;
		for (const m of messages) {
			if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue;
			for (const b of m.content) {
				if (!b) continue;
				const isToolUse = b.type === "toolCall" || b.type === "tool_use";
				if (!isToolUse) continue;
				if (b.name !== "ask_user_choices") continue;
				if (b.id !== toolUseId) continue;
				const args = b.arguments ?? b.input;
				if (args && Array.isArray(args.questions)) {
					matchedQuestions = args.questions as UserQuestion[];
				}
				break;
			}
			if (matchedQuestions) break;
		}
		if (!matchedQuestions) {
			json({ error: "No matching ask_user_choices tool call in transcript" }, 404);
			return;
		}
		const crossErr = crossValidate(matchedQuestions, answers);
		if (crossErr) { json({ error: crossErr }, 400); return; }

		const envelope = buildAskResponseEnvelope(toolUseId, answers);
		// Mark as submitted BEFORE awaiting enqueuePrompt so a concurrent
		// duplicate /submit is rejected deterministically.
		askSubmittedToolUseIds.add(dedupKey);
		try {
			await sessionManager.enqueuePrompt(sessionId, envelope);
		} catch (e: any) {
			// Roll back the dedup flag so the caller can retry.
			askSubmittedToolUseIds.delete(dedupKey);
			json({ error: `Failed to enqueue response: ${e?.message || String(e)}` }, 500);
			return;
		}
		json({ ok: true });
		return;
	}

	// ─── Maintenance endpoints ──────────────────────────────────────────
	// These replace the old automatic cleanup-on-startup behavior.
	// Users can preview orphaned resources and choose to clean them up.
	const worktreeInventory = () => new WorktreeInventoryService({ projectContextManager, sessionManager, commandRunner: serverCommandRunner, remotePolicy: serverRemoteGitPolicy });

	// GET /api/maintenance/worktrees
	if (url.pathname === "/api/maintenance/worktrees" && req.method === "GET") {
		const include = url.searchParams.get("include");
		if (include && include !== "all" && include !== "actionable" && include !== "troubleshooting") {
			json({ error: "include must be all, actionable, or troubleshooting" }, 400);
			return;
		}
		json(await worktreeInventory().scan({ include: (include as any) || "all" }));
		return;
	}

	// GET /api/maintenance/archived-session-worktrees
	if (url.pathname === "/api/maintenance/archived-session-worktrees" && req.method === "GET") {
		const includeAlreadyCleaned = url.searchParams.get("includeAlreadyCleaned") === "1";
		json(await worktreeInventory().legacyArchivedSessionWorktrees(includeAlreadyCleaned));
		return;
	}

	// POST /api/maintenance/cleanup-archived-session-worktrees
	if (url.pathname === "/api/maintenance/cleanup-archived-session-worktrees" && req.method === "POST") {
		const body = await readBody(req);
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			json({ error: "Request body must be an object" }, 400);
			return;
		}
		const rec = body as Record<string, unknown>;
		const mode = rec.mode;
		const hasSessionIds = Object.prototype.hasOwnProperty.call(body, "sessionIds");
		const hasWorktrees = Object.prototype.hasOwnProperty.call(body, "worktrees");
		const hasCategories = Object.prototype.hasOwnProperty.call(body, "categories");
		const hasPresetId = Object.prototype.hasOwnProperty.call(body, "presetId");
		const hasProjectId = Object.prototype.hasOwnProperty.call(body, "projectId");
		const hasRepoPath = Object.prototype.hasOwnProperty.call(body, "repoPath");
		if (mode !== "all" && mode !== "selected" && mode !== "category" && mode !== "preset") { json({ error: "Invalid cleanup mode" }, 400); return; }
		if (mode === "all" && (hasSessionIds || hasWorktrees || hasCategories || hasPresetId || hasProjectId || hasRepoPath)) { json({ error: "mode=all does not accept selectors" }, 400); return; }
		if (mode === "selected") {
			if (hasCategories || hasPresetId) { json({ error: "mode=selected accepts sessionIds or worktrees selectors only" }, 400); return; }
			if (hasSessionIds && hasWorktrees) { json({ error: "mode=selected accepts either sessionIds or worktrees, not both" }, 400); return; }
			if (hasSessionIds && (!Array.isArray(rec.sessionIds) || rec.sessionIds.some((id: unknown) => typeof id !== "string"))) { json({ error: "sessionIds must be an array of strings" }, 400); return; }
			if (hasWorktrees && (!Array.isArray(rec.worktrees) || rec.worktrees.some((wt: unknown) => {
				if (!wt || typeof wt !== "object" || Array.isArray(wt)) return true;
				const selector = wt as Record<string, unknown>;
				return typeof selector.sessionId !== "string" || (selector.repo !== undefined && typeof selector.repo !== "string") || (selector.path !== undefined && typeof selector.path !== "string") || (selector.key !== undefined && typeof selector.key !== "string");
			}))) { json({ error: "worktrees must be an array of selector objects with string fields" }, 400); return; }
		}
		if (mode === "category") {
			const validCategories = new Set(["archived-session", "goal-session", "team-session", "delegate-session", "child-session", "single-repo", "multi-repo"]);
			if (hasSessionIds || hasWorktrees || hasPresetId) { json({ error: "mode=category accepts categories with optional projectId or repoPath only" }, 400); return; }
			if (!Array.isArray(rec.categories) || rec.categories.some((category: unknown) => typeof category !== "string" || !validCategories.has(category as string))) { json({ error: "categories must be an array of supported category strings" }, 400); return; }
			if (rec.projectId !== undefined && typeof rec.projectId !== "string") { json({ error: "projectId must be a string" }, 400); return; }
			if (rec.repoPath !== undefined && typeof rec.repoPath !== "string") { json({ error: "repoPath must be a string" }, 400); return; }
		}
		if (mode === "preset") {
			if (hasSessionIds || hasWorktrees || hasCategories || hasProjectId || hasRepoPath) { json({ error: "mode=preset accepts presetId only" }, 400); return; }
			if (typeof rec.presetId !== "string") { json({ error: "presetId must be a string" }, 400); return; }
		}
		try { json(await worktreeInventory().cleanupLegacyArchivedSessionWorktrees(body as any)); }
		catch (err) { json({ error: err instanceof Error ? err.message : String(err) }, 400); }
		return;
	}

	// GET /api/maintenance/orphaned-worktrees
	if (url.pathname === "/api/maintenance/orphaned-worktrees" && req.method === "GET") {
		json(await worktreeInventory().legacyOrphanedWorktrees());
		return;
	}

	// POST /api/maintenance/cleanup-worktrees
	if (url.pathname === "/api/maintenance/cleanup-worktrees" && req.method === "POST") {
		const body = await readBody(req);
		const contentLengthHeader = Array.isArray(req.headers["content-length"]) ? req.headers["content-length"][0] : req.headers["content-length"];
		const hasRequestBody = contentLengthHeader !== undefined
			? Number(contentLengthHeader) > 0
			: req.headers["transfer-encoding"] !== undefined;
		const result = await executeCleanupWorktreesRequest(body, hasRequestBody, worktreeInventory());
		json(result.body, result.status);
		return;
	}

	// GET /api/maintenance/orphaned-sessions
	if (url.pathname === "/api/maintenance/orphaned-sessions" && req.method === "GET") {
		const sessions = await sessionManager.listOrphanedNonInteractiveSessions();
		json({ sessions });
		return;
	}

	// POST /api/maintenance/cleanup-sessions
	if (url.pathname === "/api/maintenance/cleanup-sessions" && req.method === "POST") {
		const body = await readBody(req);
		const orphans = await sessionManager.listOrphanedNonInteractiveSessions();
		const orphanIds = new Set(orphans.map(o => o.id));
		const idsToTerminate = (body?.sessionIds && Array.isArray(body.sessionIds))
			? (body.sessionIds as string[]).filter(id => orphanIds.has(id))
			: orphans.map(o => o.id);
		const terminated = await sessionManager.terminateOrphanedSessions(idsToTerminate);
		json({ terminated });
		return;
	}

	// GET /api/maintenance/expired-archives
	if (url.pathname === "/api/maintenance/expired-archives" && req.method === "GET") {
		const stats = await sessionManager.getExpiredArchiveStats();
		json(stats);
		return;
	}

	// POST /api/maintenance/purge-archives
	if (url.pathname === "/api/maintenance/purge-archives" && req.method === "POST") {
		await sessionManager.purgeExpiredArchives();
		const stats = await sessionManager.getExpiredArchiveStats();
		json({ purged: true, remaining: stats });
		return;
	}

	// ─── Search admin endpoints (design §9, §11) ─────────────────────

	function resolveSearchProject(pid: string | undefined | null) {
		if (!pid) return null;
		const ctx = projectContextManager.getOrCreate(pid);
		return ctx;
	}

	function searchUnavailableResponse(state: string) {
		const reasonMap: Record<string, string> = {
			"disabled": "disabled",
			"closed": "closed",
			"initializing": "initializing",
		};
		const reason = reasonMap[state] ?? state;
		return { error: "search-unavailable", reason, state };
	}

	// POST /api/search/rebuild
	if (url.pathname === "/api/search/rebuild" && req.method === "POST") {
		const body = await readBody(req);
		const projectId = body && typeof body === "object" ? (body as any).projectId : undefined;
		if (!projectId || typeof projectId !== "string") {
			json({ error: "Missing projectId" }, 400);
			return;
		}
		const ctx = resolveSearchProject(projectId);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }
		await ctx.searchIndex.whenReady();
		const state = ctx.searchIndex.getState();
		if (state !== "ready") {
			json(searchUnavailableResponse(state), 503);
			return;
		}
		// Kick off in background — client observes progress over WS.
		ctx.searchIndex
			.rebuildFromStores(ctx.goalStore, ctx.sessionStore, undefined, ctx.staffStore)
			.catch((err) => console.error("[search] rebuild failed:", err));
		json({ ok: true }, 202);
		return;
	}

	// GET /api/search/stats?projectId=...
	if (url.pathname === "/api/search/stats" && req.method === "GET") {
		const projectId = url.searchParams.get("projectId") || undefined;
		if (!projectId) { json({ error: "Missing projectId" }, 400); return; }
		const ctx = resolveSearchProject(projectId);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }
		await ctx.searchIndex.whenReady();
		const stats = await ctx.searchIndex.getStats();
		json(stats);
		return;
	}

	// POST /api/search/compact
	if (url.pathname === "/api/search/compact" && req.method === "POST") {
		const body = await readBody(req);
		const projectId = body && typeof body === "object" ? (body as any).projectId : undefined;
		if (!projectId || typeof projectId !== "string") {
			json({ error: "Missing projectId" }, 400);
			return;
		}
		const ctx = resolveSearchProject(projectId);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }
		await ctx.searchIndex.whenReady();
		const state = ctx.searchIndex.getState();
		if (state !== "ready") {
			json(searchUnavailableResponse(state), 503);
			return;
		}
		try {
			await ctx.searchIndex.compact();
			json({ ok: true });
		} catch (err) {
			json({ error: `Compact failed: ${(err as Error).message}` }, 500);
		}
		return;
	}

	// GET /api/maintenance/orphaned-index-rows?projectId=...
	if (url.pathname === "/api/maintenance/orphaned-index-rows" && req.method === "GET") {
		const projectId = url.searchParams.get("projectId") || undefined;
		if (!projectId) { json({ error: "Missing projectId" }, 400); return; }
		const ctx = resolveSearchProject(projectId);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }
		await ctx.searchIndex.whenReady();
		const store = ctx.searchIndex.getStore();
		if (!store) {
			json(searchUnavailableResponse(ctx.searchIndex.getState()), 503);
			return;
		}
		try {
			const rows = store.list({ limit: 100000 });
			const orphans: Array<{ id: string; source_id: string; parent_id: string | null }> = [];
			for (const row of rows) {
				const sourceId = String(row.source_id ?? "");
				const id = String(row.id ?? "");
				let isOrphan = false;
				if (sourceId === "goals") {
					const goalId = id.replace(/^goal:/, "");
					isOrphan = !ctx.goalStore.get(goalId);
				} else if (sourceId === "sessions") {
					const sessionId = id.replace(/^session:/, "");
					isOrphan = !ctx.sessionStore.get(sessionId);
				} else if (sourceId === "messages") {
					const sessionId = String(row.session_id ?? "");
					isOrphan = !sessionId || !ctx.sessionStore.get(sessionId);
				} else if (sourceId === "staff") {
					const staffId = id.replace(/^staff:/, "");
					isOrphan = !ctx.staffStore.get(staffId);
				}
				if (isOrphan) {
					orphans.push({
						id,
						source_id: sourceId,
						parent_id: row.parent_id != null ? String(row.parent_id) : null,
					});
				}
			}
			json({ count: orphans.length, sample: orphans.slice(0, 100) });
		} catch (err) {
			json({ error: `Orphan scan failed: ${(err as Error).message}` }, 500);
		}
		return;
	}

	// POST /api/maintenance/cleanup-index-rows
	if (url.pathname === "/api/maintenance/cleanup-index-rows" && req.method === "POST") {
		const body = await readBody(req);
		const projectId = body && typeof body === "object" ? (body as any).projectId : undefined;
		if (!projectId || typeof projectId !== "string") {
			json({ error: "Missing projectId" }, 400);
			return;
		}
		const ctx = resolveSearchProject(projectId);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }
		await ctx.searchIndex.whenReady();
		const store = ctx.searchIndex.getStore();
		if (!store) {
			json(searchUnavailableResponse(ctx.searchIndex.getState()), 503);
			return;
		}
		try {
			const rows = store.list({ limit: 100000 });
			const toDelete: string[] = [];
			for (const row of rows) {
				const sourceId = String(row.source_id ?? "");
				const id = String(row.id ?? "");
				let isOrphan = false;
				if (sourceId === "goals") {
					isOrphan = !ctx.goalStore.get(id.replace(/^goal:/, ""));
				} else if (sourceId === "sessions") {
					isOrphan = !ctx.sessionStore.get(id.replace(/^session:/, ""));
				} else if (sourceId === "messages") {
					const sessionId = String(row.session_id ?? "");
					isOrphan = !sessionId || !ctx.sessionStore.get(sessionId);
				} else if (sourceId === "staff") {
					isOrphan = !ctx.staffStore.get(id.replace(/^staff:/, ""));
				}
				if (isOrphan) toDelete.push(id);
			}
			if (toDelete.length) await store.deleteByIds(toDelete);
			json({ deleted: toDelete.length });
		} catch (err) {
			json({ error: `Cleanup failed: ${(err as Error).message}` }, 500);
		}
		return;
	}

	json({ error: "Not found" }, 404);
}

/** Return a gate plus every transitive dependent in workflow-DAG order. */
function getGateAndTransitiveDependents(workflow: import("./agent/workflow-store.js").Workflow, gateId: string): string[] {
	const gateIds = new Set(workflow.gates.map(g => g.id));
	if (!gateIds.has(gateId)) throw new Error(`Unknown gate: ${gateId}`);

	const adjacency = new Map<string, string[]>();
	for (const gate of workflow.gates) {
		for (const depId of gate.dependsOn) {
			const list = adjacency.get(depId) ?? [];
			list.push(gate.id);
			adjacency.set(depId, list);
		}
	}

	const affectedGateIds: string[] = [];
	const visited = new Set<string>([gateId]);
	const queue = [gateId];
	while (queue.length > 0) {
		const current = queue.shift()!;
		affectedGateIds.push(current);
		for (const dependentId of adjacency.get(current) ?? []) {
			if (visited.has(dependentId)) continue;
			visited.add(dependentId);
			queue.push(dependentId);
		}
	}
	return affectedGateIds;
}

/** Check if gateId transitively depends on targetId in the workflow DAG */
function hasTransitiveDep(workflow: import("./agent/workflow-store.js").Workflow, gateId: string, targetId: string, visited = new Set<string>()): boolean {
	if (visited.has(gateId)) return false;
	visited.add(gateId);
	const gate = workflow.gates.find(g => g.id === gateId);
	if (!gate) return false;
	for (const dep of gate.dependsOn) {
		if (dep === targetId) return true;
		if (hasTransitiveDep(workflow, dep, targetId, visited)) return true;
	}
	return false;
}

/**
 * Global cap on accepted request-body size (1 MiB). Legitimate API payloads
 * (goal specs, inline workflows/roles, plan mutations) are bounded well below
 * this — the per-endpoint plan/spawn caps in nested-goal-routes.ts are the
 * fine-grained limits; this is the coarse backstop that prevents a single huge
 * body from being buffered/parsed at all (Sec-2 defence-in-depth).
 */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

/**
 * True when a request's declared Content-Length exceeds `maxBytes`. Pure +
 * header-only so the request handler can reject oversized bodies with a 413
 * BEFORE any byte is buffered. Chunked/streamed bodies that omit Content-Length
 * are bounded by the streaming cap inside `readBody()` instead.
 */
export function bodyLimitExceeded(
	contentLength: string | string[] | undefined,
	maxBytes: number = MAX_REQUEST_BODY_BYTES,
): boolean {
	const raw = Array.isArray(contentLength) ? contentLength[0] : contentLength;
	if (raw == null) return false;
	const len = Number(raw);
	return Number.isFinite(len) && len > maxBytes;
}

export function readBody(
	req: http.IncomingMessage,
	maxBytes: number = MAX_REQUEST_BODY_BYTES,
): Promise<any> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let total = 0;
		let settled = false;
		const finish = (value: any): void => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		req.on("data", (chunk: Buffer) => {
			if (settled) return;
			total += chunk.length;
			if (total > maxBytes) {
				// Oversized body: reject BEFORE Buffer.concat()/JSON.parse() so a
				// huge payload is never fully materialised in memory. Drop buffered
				// chunks, tear down the stream, and resolve null — handlers treat a
				// null body as a malformed request (400); the request-handler's
				// Content-Length precheck returns a definitive 413 for the common
				// case where the length is declared up front.
				chunks.length = 0;
				try { req.destroy(); } catch { /* best-effort */ }
				finish(null);
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				finish(JSON.parse(Buffer.concat(chunks).toString()));
			} catch {
				finish(null);
			}
		});
		req.on("error", () => finish(null));
		req.on("aborted", () => finish(null));
	});
}

const MIME_TYPES: Record<string, string> = {
	".html": "text/html",
	".js": "application/javascript",
	".css": "text/css",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".wasm": "application/wasm",
};

/**
 * Load the PWA manifest JSON. In prod the UI is embedded under `staticDir`;
 * in dev mode (--no-ui) the Vite public/ folder is used instead.
 */
function loadManifest(staticDir: string | undefined): { start_url?: string;[k: string]: unknown } {
	const candidates: string[] = [];
	if (staticDir) candidates.push(path.join(path.resolve(staticDir), "manifest.json"));
	candidates.push(path.resolve(process.cwd(), "public", "manifest.json"));
	for (const p of candidates) {
		if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
	}
	throw new Error("manifest.json not found");
}

function serveStatic(pathname: string, staticDir: string, res: http.ServerResponse) {
	const resolvedStaticDir = path.resolve(staticDir);
	let filePath = path.resolve(staticDir, pathname === "/" ? "index.html" : pathname.slice(1));

	// Prevent directory traversal
	if (!filePath.startsWith(resolvedStaticDir)) {
		res.writeHead(403);
		res.end();
		return;
	}

	try {
		if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
			// SPA fallback — serve index.html for unmatched routes
			filePath = path.join(resolvedStaticDir, "index.html");
			if (!fs.existsSync(filePath)) {
				res.writeHead(404);
				res.end("Not found");
				return;
			}
		}

		const ext = path.extname(filePath).toLowerCase();
		const contentType = MIME_TYPES[ext] || "application/octet-stream";
		const content = fs.readFileSync(filePath);

		const headers: Record<string, string> = { "Content-Type": contentType };
		// Service-worker file: never cache. Browsers byte-compare SWs for
		// updates, but an intermediate proxy/CDN serving a stale copy would
		// silently keep users on the old build's CACHE_NAME. Same goes for
		// the SPA shell (index.html) — it references hashed bundle names
		// that change every build.
		const basename = path.basename(filePath);
		if (basename === "sw.js" || basename === "index.html") {
			headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
		}

		res.writeHead(200, headers);
		res.end(content);
	} catch {
		res.writeHead(500);
		res.end("Internal server error");
	}
}
