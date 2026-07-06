import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

import os from "node:os";
import { parse as parseYaml } from "yaml";
import { fileURLToPath } from "node:url";
import {
	bobbitStateDir,
	bobbitConfigDir,
	bobbitDir,
	headquartersDir,
	getProjectRoot,
	globalAgentDir,
} from "./bobbit-dir.js";
import { isSetupComplete } from "./setup-status.js";
export { isSetupComplete };
import { WebSocketServer } from "ws";
import { ColorStore } from "./agent/color-store.js";
import { PrStatusStore } from "./agent/pr-status-store.js";
import { SessionManager, type ExtensionChannelServices } from "./agent/session-manager.js";
import { RateLimiter } from "./auth/rate-limit.js";
import { readToken, validateToken } from "./auth/token.js";
import { handleWebSocketConnection } from "./ws/handler.js";
import type { AuthenticatedWS } from "./ws/protocol.js";
import { invalidateSlashSkillsCache, type SkillMarketContext } from "./skills/slash-skills.js";
import { TeamManager, GateDependencyError } from "./agent/team-manager.js";
import { OrchestrationCore, OrchestrationCoreError, dismissHttpStatus, isSettledStatus, type WaitResult } from "./agent/orchestration-core.js";
import { tryHandleNestedGoalRoute, listDescendants } from "./agent/nested-goal-routes.js";
import { tryHandleSwarmRoute } from "./agent/swarm-routes.js";
import { reArmSwarmGovernorsOnBoot } from "./agent/swarm-restart-resume.js";
import { spawnExperimentChildGoal } from "./agent/experiment-spawn-goal.js";
import { walkGoalSubtree, cascadeSubtree as cascadeGoalSubtree } from "./agent/goal-subtree.js";
import type { Workflow } from "./agent/workflow-store.js";
import { readSubgoalNestingPrefs } from "./agent/subgoal-nesting-limit.js";
import { GoalPausedError } from "./agent/goal-paused-guard.js";
import { backfillLegacyCostGoalIds, backfillLegacyCostGoalIdsFromTranscripts } from "./agent/cost-backfill.js";
import { checkGateDependencies } from "./agent/gate-dependency-check.js";
import { deliverSessionPrompt, parseSessionPromptMode, SessionPromptDeliveryError } from "./agent/session-prompt-delivery.js";
import { RoleStore, type Role } from "./agent/role-store.js";
import { RoleManager } from "./agent/role-manager.js";
import { buildOrientPayload, type OrientSessionInput } from "./agent/orient.js";
import { bobbitPackageVersion } from "./agent/aigw-user-agent.js";
import { ToolManager, copyDirRecursive, __resetToolScanCache, type MarketToolRoot, type PiExtensionExternalTool, type ScopedToolContext } from "./agent/tool-manager.js";
import { ActionDispatcher, ActionError, resolveActionToolManager } from "./extension-host/action-dispatcher.js";
import { RouteDispatcher, RouteRegistry } from "./extension-host/route-dispatcher.js";
// STR-01 core route registry (cohort 1: projects). See docs/design/route-registry.md.
import { RouteTable } from "./routes/route-table.js";
import type { CoreRouteCtx } from "./routes/core-route-ctx.js";
import { registerProjectRoutes } from "./routes/projects-routes.js";
// STR-01 cohort 2: the per-project config family (/api/projects/:id/config*).
import { registerProjectConfigRoutes } from "./routes/project-config-routes.js";
import { registerMarketplaceRoutes } from "./routes/marketplace-routes.js";
// STR-01 cohort 5: the staff-inbox family (/api/staff/:id/inbox*).
import { registerStaffInboxRoutes } from "./routes/staff-inbox-routes.js";
// STR-01 cohort 4: /api/pack-runtimes* and the server-scope /api/project-config trio.
import { registerPackRuntimesRoutes } from "./routes/pack-runtimes-routes.js";
import { registerServerProjectConfigRoutes } from "./routes/project-config-server-routes.js";
// STR-01 cohort 6: the workflows family (/api/workflows*) and the
// review-annotation family (/api/sessions/:id/review/*).
import { registerWorkflowsRoutes } from "./routes/workflows-routes.js";
import { registerReviewAnnotationRoutes } from "./routes/review-annotations-routes.js";
// STR-01 cohort 7: background-process, draft, abort, and prompt-section routes.
import { registerSessionUtilityRoutes } from "./routes/session-utility-routes.js";
import { registerLspRoutes } from "./routes/lsp-routes.js";
import { TsServerSupervisor } from "./lsp/supervisor.js";
// STR-01 cohort 8: maintenance and search-admin routes.
import { registerMaintenanceRoutes } from "./routes/maintenance-routes.js";
// STR-01 cohort 9: early server/system status routes.
import { registerServerSystemRoutes } from "./routes/server-system-routes.js";
// STR-01 cohort 10: staff CRUD + MCP operator/internal-MCP routes.
import { registerStaffMcpOperatorRoutes } from "./routes/staff-mcp-operator-routes.js";
// STR-01 cohort 11: OAuth account routes.
import { registerOauthAccountRoutes } from "./routes/oauth-account-routes.js";
// STR-01 cohort 12: preferences routes.
import { registerPreferencesRoutes } from "./routes/preferences-routes.js";
// STR-01 cohort 13: config-directories routes.
import { registerConfigDirectoriesRoutes } from "./routes/config-directories-routes.js";
// STR-05: roles route-handler hoist.
import { registerRolesRoutes } from "./routes/roles-routes.js";
// STR-01 cohort 14: Add Project directory browser/create routes.
import { registerDirectoryBrowserRoutes } from "./routes/directory-browser-routes.js";
// F26: propose_skill acceptance endpoint — new route, registered directly
// rather than added to the legacy if/else chain.
import { registerSkillsRoutes } from "./routes/skills-routes.js";
// STR-01 cohort 15: model/provider settings routes.
import { registerModelProviderRoutes } from "./routes/model-provider-routes.js";
// STR-01 cohort 16a: cost endpoints.
import { registerCostRoutes } from "./routes/cost-routes.js";
// STR-01 cohort 16b: preview mount/artifact/SSE endpoints.
import { registerPreviewRoutes } from "./routes/preview-routes.js";
// STR-01 cohort 17: editable proposal REST endpoints.
import { registerSessionProposalRoutes } from "./routes/session-proposal-routes.js";
// STR-01 cohort 18: host configuration routes.
import { registerHostConfigRoutes } from "./routes/host-config-routes.js";
// STR-01 cohort 19: session control/provider-hook routes.
import { registerSessionControlRoutes } from "./routes/session-control-routes.js";
// STR-01 cohort 20: session discovery/read routes.
import { registerSessionDiscoveryRoutes } from "./routes/session-discovery-routes.js";
// STR-01 cohort 21: session mutation/lifecycle routes.
import { registerSessionMutationRoutes } from "./routes/session-mutation-routes.js";
// STR-01 cohort 22: POST /api/sessions creation route.
import { registerSessionCreationRoutes } from "./routes/session-creation-routes.js";
// STR-01 cohort 23: session git read/status routes.
import { registerSessionGitReadRoutes } from "./routes/session-git-read-routes.js";
// STR-01 cohort 24: session git write/PR mutation routes.
import { registerSessionGitWriteRoutes } from "./routes/session-git-write-routes.js";
// STR-01 cohort 25: session content/readback routes.
import { registerSessionContentRoutes } from "./routes/session-content-routes.js";
// STR-01 cohort 26: prompt autocomplete/read-only discovery routes.
import { registerPromptAutocompleteRoutes } from "./routes/prompt-autocomplete-routes.js";
// STR-01 goals cohort G1: goal read/dashboard routes.
import { registerGoalReadRoutes } from "./routes/goal-read-routes.js";
// STR-01 goals cohort G2a: goal CRUD-core create/read/update routes.
import { registerGoalCrudRoutes } from "./routes/goal-crud-routes.js";
// STR-01 cohort 27: task routes.
import { registerTasksRoutes } from "./routes/tasks-routes.js";
// STR-01 cohort 28: pack UI/contribution discovery routes.
import { registerExtensionHostUiRoutes } from "./routes/extension-host-ui-routes.js";
import { ModuleHost } from "./extension-host/module-host-worker.js";
import { authorizeActionRequest, authorizeScopedRequest, transcriptHasToolUse, type ActionGuardSession } from "./extension-host/action-guard.js";
import { getPackStore, withStoreTimeout, PackStoreTimeoutError, PackStoreQuotaError } from "./extension-host/pack-store.js";
import { createServerHostApi } from "./extension-host/server-host-api.js";
import { transcriptToHostMessages, transcriptToToolCall, buildTranscriptEnvelope } from "./extension-host/contract-adapter.js";
import { resolvePackIdentityForTool } from "./extension-host/pack-identity.js";
import { mintSurfaceToken, resolveSurfaceIdentity } from "./extension-host/surface-binding.js";
import type { StorePutOptions } from "../shared/extension-host/host-api.js";
import { PackContributionRegistry } from "./extension-host/pack-contribution-registry.js";
import {
	PackRuntimeSupervisor,
	FilePortStore,
	getOrCreatePackRuntimeServerIdentity,
	type PackRuntimeStatus,
	type PackRuntimeCapabilitySummary,
} from "./runtimes/index.js";
import { loadPackContributions, packIdFromRoot, providerConfigStoreKey, PROVIDER_CONFIG_KEY_PREFIX } from "./agent/pack-contributions.js";
import { loadPiExtensionContributions, loadPiExtensionContributionsWithDiscoverySync } from "./agent/pi-extension-contributions.js";
import { LifecycleHub, type RuntimeContext } from "./agent/lifecycle-hub.js";
import { registerThinkingRouterClassifier } from "./agent/thinking-router-classifier.js";
import { TOOL_APPROVE_POINT, TOOL_APPROVE_KIND } from "./agent/tool-approve-classifier.js";
import { registerToolApproveHeuristicClassifier, isToolApproveHeuristicEnabled } from "./agent/tool-approve-heuristic.js";
import { registerModelTierClassifier } from "./agent/model-tier-classifier.js";
import { registerGateRiskClassifier } from "./agent/gate-risk-classifier.js";
import { registerSwarmTopologyClassifier } from "./agent/swarm-topology-classifier.js";
import { GOAL_COMPLETED_PRESENCE_HOOKS } from "./agent/lifecycle-hooks.js";
import { ContextTraceStore } from "./agent/context-trace-store.js";
import { isPackPathWithinRoot } from "./extension-host/path-guard.js";
import { buildGateVerificationSnapshot, UnknownVerificationStepError } from "./gate-verification-snapshot.js";
import {
	GateArtifactResolutionError,
	buildArtifactLookup,
	isTextInspectableArtifact,
	resolveArtifactFromLookup,
	stripPlaywrightErrorContextBoilerplate,
	validateRetainedArtifactPath,
} from "./gate-artifacts.js";
import { handleSidePanelWorkspaceRoute } from "./side-panel-workspace-routes.js";
import {
	TextSelectionError,
	selectText,
	type TextSelectionMode,
	type TextSelectionOptions,
} from "./utils/text-selection.js";

import { initPromptDirs } from "./agent/system-prompt.js";
import { cpuDiagnosticsEnabled, getCpuDiagnostics } from "./agent/cpu-diagnostics.js";
import { computeEffectiveAllowedTools } from "./agent/tool-activation.js";
import { initSkillSidecarDir } from "./skills/skill-sidecar.js";
import {
	initCompactionSidecarDir,
} from "./agent/compaction-sidecar.js";
import type { PersistedTask } from "./agent/task-store.js";
import { TaskManager } from "./agent/task-manager.js";
import { TaskStore } from "./agent/task-store.js";
import { BgProcessManager } from "./agent/bg-process-manager.js";
import { sessionFileRead, sessionFsContextForAgentFile } from "./agent/session-fs.js";

import { isGitRepo, getRepoRoot, resolveSandboxMountRoot, stripTokenFromGitUrl, detectPrimaryBranch, parseBaseRef, refExistsInRepo } from "./skills/git.js";

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

// Helper used by PUT /api/projects/:id/config to validate `base_ref` branch grammar.
// Mirrors git's `check-ref-format` predicate in pure JS so the API can respond
// without an exec round-trip. See docs/design/base-ref.md.
function isValidBaseRefBranchGrammar(name: string): boolean {
	if (!name) return false;
	if (/\s/.test(name)) return false;
	if (name.startsWith("-") || name.endsWith(".")) return false;
	if (name.includes("..") || name.includes("@{")) return false;
	if (/[\x00-\x1f\x7f~^:?*\[\\]/.test(name)) return false;
	return /^[A-Za-z0-9_./-]+$/.test(name);
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
): Promise<boolean> {
	try {
		const seen = new Set<string>();
		let checked = 0;
		for (const c of comps.length > 0 ? comps : [{ repo: "." }]) {
			if (seen.has(c.repo)) continue;
			seen.add(c.repo);
			const repoPath = path.join(rootPath, c.repo);
			if (!(await isGitRepo(repoPath).catch(() => false))) continue;
			checked++;
			if (!(await refExistsInRepo(repoPath, ref))) return false;
		}
		return checked > 0;
	} catch {
		return false;
	}
}

// resolveBaseRefDetectRepoPath moved to src/server/routes/projects-routes.ts
// (STR-01 cohort 1) — its only caller, GET /api/projects/:id/base-ref/detect,
// moved with it.

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

function viewerSubscribedToGoal(ws: AuthenticatedWS, goalId: string): boolean {
	if (!ws.isViewer) return false;
	const goalIds = ws.viewerGoalIds;
	return goalIds instanceof Set && goalIds.has(goalId);
}

import {
	deleteRemoteGoalBranches,
	hasGoalGitWorktree,
	noWorktreeGoalGitMessage,
	goalGitUnavailablePayload,
	buildGhPrMergeArgs,
	getCachedPrStatus,
	_prCache,
	execGit,
	execGitSafe,
	invalidateGitStatusCache,
	batchGitStatus,
	COMMIT_LOG_FORMAT,
	parseCommitLogWithShortstat,
	attachCommitFiles,
	getGitDiff,
} from "./skills/git-gh.js";
import { VerificationHarness, goalBranchContainer, sanitizeVerificationFindings } from "./agent/verification-harness.js";
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

export async function loadHydratedMessagesForAskSubmit(
	sessionManager: Pick<SessionManager, "hydrateClaudeCodeSnapshotMessages">,
	sessionId: string,
	session: { rpcClient: { getMessages: () => Promise<any> } },
): Promise<any[]> {
	const msgsResp = await session.rpcClient.getMessages();
	const liveData = msgsResp?.data;
	const hydrated = await sessionManager.hydrateClaudeCodeSnapshotMessages(sessionId, liveData);
	const raw = Array.isArray(hydrated)
		? hydrated
		: (hydrated && typeof hydrated === "object" && Array.isArray((hydrated as any).messages) ? (hydrated as any).messages : undefined);
	return Array.isArray(raw) ? raw : [];
}

export function findAskUserChoicesQuestions(messages: any[], toolUseId: string): UserQuestion[] | null {
	for (const m of messages) {
		if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const b of m.content) {
			if (!b) continue;
			const isToolUse = b.type === "toolCall" || b.type === "tool_use";
			if (!isToolUse) continue;
			if (b.name !== "ask_user_choices") continue;
			if (b.id !== toolUseId) continue;
			const args = b.arguments ?? b.input;
			if (args && Array.isArray(args.questions)) return args.questions as UserQuestion[];
		}
	}
	return null;
}

import { inlineFileImages } from "./agent/inline-file-images.js";
import { StaffManager } from "./agent/staff-manager.js";
import { TriggerEngine } from "./agent/staff-trigger-engine.js";
import { GoalTriggerDispatcher } from "./agent/goal-trigger-dispatcher.js";
import { InboxManager, type InboxEntry } from "./agent/inbox-manager.js";
import { InboxNudger } from "./agent/inbox-nudger.js";
import type { InboxStore } from "./agent/inbox-store.js";
import { PreferencesStore } from "./agent/preferences-store.js";
import { ProjectConfigStore, type PackOrderScope, type DisabledRefs } from "./agent/project-config-store.js";
import { resolveDefaultActivationOverlay, buildAllDisabledRefs, isProviderConfigConfigured } from "./agent/pack-default-activation.js";
import { ToolGroupPolicyStore } from "./agent/tool-group-policy-store.js";
import { VerificationPolicyStore } from "./agent/verification-policy-store.js";
import { checkDockerAvailability, buildSandboxImage, ensureImageAgentVersion, resolveSandboxDockerContext } from "./agent/sandbox-status.js";
import { SandboxManager, type SandboxBootstrap } from "./agent/sandbox-manager.js";
import { prepareSanitizedSandboxCloneSource, resolveSandboxCloneSource, type SandboxCloneSource } from "./agent/sandbox-clone-source.js";
import { validateSandboxMounts } from "./agent/sandbox-mounts.js";
import { SandboxTokenStore, type SandboxScope } from "./auth/sandbox-token.js";
import { CookieStore, issueIfMissing as issueCookieIfMissing, tryAuth as cookieTryAuth } from "./auth/cookie.js";
import { authorizeChildrenMutation } from "./auth/children-mutation-authz.js";
import { handlePreviewRequest } from "./preview/content-route.js";
import { handlePrWalkthroughApiRoute } from "./pr-walkthrough/routes.js";
import { progressBus as searchProgressBus } from "./search/progress-bus.js";
import { isSandboxAllowed } from "./auth/sandbox-guard.js";
import { stableConfirmationBinding } from "./auth/operator-confirmation.js";
import * as previewArtifacts from "./preview/artifacts.js";
import { getAigwUrl, proxyRequest, startupAigwCheck, writeContextWindowOverrides } from "./agent/aigw-manager.js";
import { writeOpenAIModelAdditions } from "./agent/openai-model-additions.js";
import { ReviewAnnotationStore } from "./review-annotation-store.js";
import { syncCustomProviderModelsJson } from "./agent/model-registry.js";
import { sensitiveClaudeCodePreferenceMutation } from "./agent/claude-code-config.js";
import {
	ProjectRegistry,
	SYSTEM_PROJECT_ID,
	HEADQUARTERS_PROJECT_ID,
	SpecialProjectMutationError,
	isHeadquartersProject,
	isSystemProject,
	type RegisteredProject,
} from "./agent/project-registry.js";
import { ProjectContextManager } from "./agent/project-context-manager.js";
import type { ProjectContext } from "./agent/project-context.js";
import { resolveProjectForRequest, validateExecutionCwd } from "./agent/resolve-project.js";
import { GoalManager } from "./agent/goal-manager.js";
import { cleanupGateDiagnosticsForGoal } from "./agent/gate-diagnostics-cleanup.js";
import type { WorktreeReferenceRecord } from "./agent/worktree-reference-guard.js";
import { computePlanFreezeUpdate } from "./agent/parent-workflow-freeze.js";
import { resolveHostTokenValue, resolveSandboxAgentAuthPolicy } from "./agent/host-tokens.js";
import type { PersistedGoal } from "./agent/goal-store.js";
import type { GateResetResult } from "./agent/gate-store.js";
import { buildGithubBranchUrl, type GoalGithubLinkResponse } from "./sidebar-actions.js";
import { migrateLegacyHeadquartersDirectory, migrateToPerProjectState, recoverPreMigrationData } from "./agent/state-migration.js";
import { migrateAllProjects as migrateAllProjectYaml } from "./state-migration/migrate-project-yaml.js";
import { BuiltinConfigProvider } from "./agent/builtin-config.js";
import { ConfigCascade, normalizeConfigProjectId, type MarketPackProvider } from "./agent/config-cascade.js";
import { MarketplaceSourceStore } from "./agent/marketplace-source-store.js";
import { builtinFirstPartyPackEntries, resolveBuiltinPacksDir } from "./agent/builtin-packs.js";
import { seedBuiltinPackDefaults } from "./agent/builtin-pack-defaults.js";
import { MarketplaceInstaller, type InstallScope, type PackOrderStore } from "./agent/marketplace-install.js";
import type { MarketplaceMcpResolver, McpReloadResult, ResolvedMcpContribution } from "./mcp/mcp-manager.js";
import type { MarketplacePiExtensionResolver, ResolvedPiExtensionContribution, PiExtensionDiagnostic } from "./agent/session-setup.js";
import { scopeMarketPackEntries } from "./agent/pack-list.js";
import { type PackScope, type PackEntry } from "./agent/pack-types.js";
import { isSafeBasename } from "./agent/pack-manifest.js";
import { gatewayMcpActivationContributionId, gatewayMcpRuntimeKey } from "./agent/mcp-gateway-runtime-identity.js";

import { initAssistantRegistry } from "./agent/assistant-registry.js";
import { validateGoalInlineWorkflow } from "./proposals/proposal-types.js";

/** Max WebSocket frame the gateway will accept (S31). The ws default is 100 MiB;
 *  a multi-image prompt frame carries ~3x base64 per image and could silently
 *  trip a close-1009 teardown. Set an explicit, generous cap ABOVE the composer's
 *  aggregate-send guard (src/ui/components/MessageEditor.ts) so the composer
 *  rejects an oversized send with a clear error BEFORE it can tear down the socket. */
export const WS_MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;

const execFileAsync = promisify(execFileCb);

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

// ── Default-disabled built-in packs (e.g. Hindsight) ─────────────────────────
// A built-in first-party pack may ship `defaultDisabled: true` in its manifest:
// it lists in the Marketplace built-in band but resolves DORMANT (tools,
// provider, entrypoints, runtime all absent) on a fresh server until the user
// enables it OR it is "already configured" (live-setup preservation). The
// overlay is injected into the SERVER-scope ProjectConfigStore so the single
// getPackActivation seam (cascade, registry, tool-manager, slash-skills,
// Marketplace endpoints) all observe the same effective state; it is never
// persisted, so the dormancy invariant holds and an explicit user toggle (a
// persisted record, or the force-enabled marker) always wins.
//
// These helpers are MODULE-scoped (not closed over createGateway) so the
// activation PUT inside the top-level handleApiRoute shares them. The static
// per-pack info is memoized and cleared on any pack-list mutation via
// clearDefaultDisabledInfoCache(); the live gates (force-enabled marker +
// persisted provider config) are read each call.
interface DefaultDisabledInfo { allDisabled: DisabledRefs; packId: string; providerIds: string[] }
const defaultDisabledInfoCache = new Map<string, DefaultDisabledInfo | null>();
function clearDefaultDisabledInfoCache(): void { defaultDisabledInfoCache.clear(); }
/** Resolve + memoize the default-disabled info for a SERVER-scope pack name, or
 *  `null` when the pack is not default-disabled. An installed server market pack
 *  wins over the built-in band (mirrors buildActivationCatalogue's resolution). */
function getDefaultDisabledInfo(packName: string, serverStore: ProjectConfigStore): DefaultDisabledInfo | null {
	const cached = defaultDisabledInfoCache.get(packName);
	if (cached !== undefined) return cached;
	let info: DefaultDisabledInfo | null = null;
	const base = getProjectRoot();
	let entry = scopeMarketPackEntries("server" as PackScope, base, serverStore.getPackOrder("server"))
		.find((e) => e.manifest?.name === packName);
	if (!entry || !entry.manifest) {
		entry = builtinFirstPartyPackEntries(resolveBuiltinPacksDir()).find((e) => e.manifest?.name === packName);
	}
	if (entry?.manifest?.defaultDisabled === true) {
		const concrete = readConcretePackToolsFromGroups(entry.path, entry.manifest.contents.tools).tools;
		let providerIds: string[] = [];
		try { providerIds = loadPackContributions(entry.path, entry.manifest).providers.map((p) => p.id); }
		catch { /* contributions optional; configured-check just sees no providers */ }
		info = {
			allDisabled: buildAllDisabledRefs(entry.manifest, concrete),
			packId: packIdFromRoot(entry.path),
			providerIds,
		};
	}
	defaultDisabledInfoCache.set(packName, info);
	return info;
}
/** Persisted marker key: pack names the user EXPLICITLY enabled. An explicit
 *  enable clears all disabled refs (an empty record, indistinguishable from
 *  "never touched"), so the marker disambiguates it from the default-disabled
 *  baseline and makes the enable survive reboots. */
const PACK_FORCE_ENABLED_KEY = "pack_force_enabled";
function readForceEnabledPacks(store: ProjectConfigStore): Set<string> {
	try {
		const raw = store.get(PACK_FORCE_ENABLED_KEY);
		const arr = raw ? (JSON.parse(raw) as unknown) : [];
		return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
	} catch { return new Set(); }
}
function writeForceEnabledPacks(store: ProjectConfigStore, set: Set<string>): void {
	if (set.size === 0) store.remove(PACK_FORCE_ENABLED_KEY);
	else store.set(PACK_FORCE_ENABLED_KEY, JSON.stringify([...set].sort()));
}

export function buildMarketToolRootsForProject(options: {
	projectId?: string;
	builtinEntries: readonly PackEntry[];
	marketEntries: (scope: InstallScope, projectId?: string) => readonly PackEntry[];
	disabledTools: (scope: InstallScope, projectId: string | undefined, packName: string) => readonly string[] | undefined;
}): MarketToolRoot[] {
	const roots: MarketToolRoot[] = [];
	const seen = new Set<string>();
	const push = (entry: PackEntry, activationScope: InstallScope): void => {
		const toolsDir = path.join(entry.path, "tools");
		const key = path.resolve(toolsDir);
		if (seen.has(key)) return;
		seen.add(key);
		const packName = entry.manifest?.name;
		const disabledTools = packName ? options.disabledTools(activationScope, options.projectId, packName) : undefined;
		roots.push({ dir: toolsDir, disabledTools: disabledTools ? [...disabledTools] : undefined });
	};

	// Built-in first-party packs are toggleable at server scope and sit below all
	// user-installed market scopes, mirroring ConfigCascade.resolveEntities().
	for (const entry of options.builtinEntries) push(entry, "server");
	for (const scope of ["server", "global-user", "project"] as const) {
		for (const entry of options.marketEntries(scope, options.projectId)) push(entry, scope);
	}
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

// ── Headquarters session git isolation ──
// Headquarters sessions default their cwd to the Headquarters directory
// (`<serverRunDir>/.bobbit/headquarters`), which is physically INSIDE the
// server run directory's git checkout. Running git/gh from there would leak
// the parent repo's state. Headquarters never uses worktrees or git lifecycle,
// so every session git/PR endpoint must short-circuit with an unavailable
// response instead of shelling out from cwd. See design "Headquarters
// git/worktree behavior".
//
// Note: the equivalent GOAL-level helpers (deleteRemoteGoalBranches,
// hasGoalGitWorktree, noWorktreeGoalGitMessage, goalGitUnavailablePayload,
// isMissingRemoteRefDeleteError, isIgnorableRemoteBranchDeleteError) already
// live in ./skills/git-gh.js on this branch (imported above) — only these
// SESSION-level helpers are new from upstream's HQ Split (#932).
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
}

// ───────────────────────────────────────────────────────────────────────────
// Pack managed-runtime supervisor seam (P2 — see docs design "P2
// PackRuntimeSupervisor + REST"). The concrete Docker-backed supervisor + its
// id encode/decode helpers + error classes live in ./runtimes (imported above).
// The REST routes depend on the structural seam below so test harnesses can
// inject a fully-mocked supervisor (no Docker daemon) via
// registerPackRuntimeSupervisorFactory(); production builds the real
// PackRuntimeSupervisor in start().

/** The structural contract the REST routes depend on (the concrete
 *  PackRuntimeSupervisor implements a superset). Unknown-runtime failures surface
 *  as `PackRuntimeNotFoundError` (→ 404); malformed id/mode/tail as
 *  `PackRuntimeBadRequestError` (→ 400); anything else → 500 (both classes and
 *  their REST-route callers now live in src/server/routes/pack-runtimes-routes.ts,
 *  STR-01 cohort 4). */
export interface PackRuntimeSupervisorLike {
	list(projectId?: string): Promise<PackRuntimeStatus[]>;
	status(packId: string, runtimeId: string, projectId?: string): Promise<PackRuntimeStatus>;
	start(packId: string, runtimeId: string, opts?: { projectId?: string; mode?: string; config?: Record<string, unknown> }): Promise<PackRuntimeStatus>;
	stop(packId: string, runtimeId: string, opts?: { projectId?: string }): Promise<PackRuntimeStatus>;
	restart(packId: string, runtimeId: string, opts?: { projectId?: string; mode?: string; config?: Record<string, unknown> }): Promise<PackRuntimeStatus>;
	down(packId: string, runtimeId: string, opts?: { projectId?: string; volumes?: boolean; removeState?: boolean }): Promise<PackRuntimeStatus>;
	capabilitySummary(packId: string, runtimeId: string, opts?: { projectId?: string; mode?: string; config?: Record<string, unknown> }): Promise<PackRuntimeCapabilitySummary>;
	logs(packId: string, runtimeId: string, opts?: { projectId?: string; tail?: number }): Promise<string>;
}

export interface PackRuntimeSupervisorDeps {
	packContributionRegistry: PackContributionRegistry;
	stateDir: string;
	defaultCwd: string;
}

/** True for a non-array plain object — the shape a manifest's declarative
 *  mapping fields (`deploymentModes`, `configRemap`) are expected in. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Map an effective deployment config onto a runtime START plan — the SINGLE
 * source of truth shared by the marketplace pack-activation enable path AND
 * the `/api/pack-runtimes/:id/{start,restart,capabilities}` REST routes, so
 * the three can never diverge on how a deployment config becomes supervisor
 * start args.
 *
 * Policy is DECLARATIVE, read from the pack's own `runtimeManifest` (S1 — see
 * `RuntimeManifest.deploymentModes` / `.configRemap`,
 * src/server/runtime/manifest.ts) rather than hard-coded here:
 * - `deploymentConfig.mode` is looked up in `runtimeManifest.deploymentModes`;
 *   a hit starts the manifest's own mapped mode. A miss — including the
 *   absent/default mode, an unrecognized mode, or a manifest with no
 *   `deploymentModes` at all — is a NON-Docker setup path: `start: false` and
 *   no container is brought up.
 * - Each `runtimeManifest.configRemap` entry copies the named deployment-
 *   config field onto its target env key, UNLESS a value is already present
 *   under that key (a value set directly under the env key always wins).
 *
 * A pack with no runtime manifest (or one declaring neither field) always
 * gets `{ start: false, config: deploymentConfig }` regardless of `mode` —
 * the generic fallback every pack had before this policy became declarative.
 */
export function resolveRuntimeStartPlan(
	deploymentConfig: Record<string, unknown>,
	runtimeManifest?: Record<string, unknown>,
): { start: boolean; mode?: string; config: Record<string, unknown> } {
	const mode = typeof deploymentConfig.mode === "string" ? deploymentConfig.mode : "external";
	const config: Record<string, unknown> = { ...deploymentConfig };

	const configRemap = isPlainRecord(runtimeManifest?.configRemap) ? runtimeManifest!.configRemap as Record<string, unknown> : undefined;
	if (configRemap) {
		for (const [fromKey, toKeyRaw] of Object.entries(configRemap)) {
			if (typeof toKeyRaw !== "string" || toKeyRaw.length === 0) continue;
			const fromVal = deploymentConfig[fromKey];
			const existing = config[toKeyRaw];
			if (typeof fromVal === "string" && fromVal.length > 0
				&& !(typeof existing === "string" && existing.length > 0)) {
				config[toKeyRaw] = fromVal;
			}
		}
	}

	const deploymentModes = isPlainRecord(runtimeManifest?.deploymentModes) ? runtimeManifest!.deploymentModes as Record<string, unknown> : undefined;
	const modeSpec = deploymentModes?.[mode];
	const runtimeMode = isPlainRecord(modeSpec) && typeof modeSpec.runtimeMode === "string" && modeSpec.runtimeMode.length > 0
		? modeSpec.runtimeMode
		: undefined;
	return runtimeMode ? { start: true, mode: runtimeMode, config } : { start: false, config };
}

/**
 * Map an already-resolved DEPLOYMENT mode value onto its runtime-manifest mode
 * id, using the SAME declarative `runtimeManifest.deploymentModes` table
 * `resolveRuntimeStartPlan` reads — an unmapped value (including a caller
 * value that is ALREADY a runtime mode id, e.g. an explicit
 * `?mode=managed-postgres` override) passes through UNCHANGED (identity
 * fallback), so this never throws away an explicit runtime-mode override.
 * Used by the `/api/pack-runtimes/:id/capabilities` disclosure route so it
 * agrees with `resolveRuntimeStartPlan`'s mapping without re-declaring it.
 */
export function mapDeploymentModeToRuntimeMode(
	deploymentMode: string,
	runtimeManifest?: Record<string, unknown>,
): string {
	const deploymentModes = isPlainRecord(runtimeManifest?.deploymentModes) ? runtimeManifest!.deploymentModes as Record<string, unknown> : undefined;
	const modeSpec = deploymentModes?.[deploymentMode];
	return isPlainRecord(modeSpec) && typeof modeSpec.runtimeMode === "string" && modeSpec.runtimeMode.length > 0
		? modeSpec.runtimeMode
		: deploymentMode;
}

/**
 * Whether a pack exposes a managed-runtime DEPLOYMENT SURFACE — i.e. a provider
 * whose EFFECTIVE config actually carries a deployment `mode` (external / managed
 * / managed-external-postgres), or whose activation links to that mode
 * (`activeWhenConfig.mode`). Merely HAVING a provider is NOT enough: a pack with an
 * unrelated provider (one with no deployment mode) has no external/managed concept,
 * so it must behave EXACTLY like a provider-less runtime pack — its `on-enable`
 * runtime starts in the manifest DEFAULT (Docker) mode and the consent disclosure
 * shows that default, rather than being suppressed to / disclosed as the external
 * (no-Docker) setup path. Shared by the marketplace activation path, the REST
 * `/api/pack-runtimes/:id/start` guard, and the `/capabilities` disclosure so the
 * three can never diverge.
 */
export function providerCarriesDeploymentMode(
	provider: { config?: Record<string, unknown>; activation?: { activeWhenConfig?: Record<string, string[]> } },
	effectiveConfig?: Record<string, unknown>,
): boolean {
	const config = effectiveConfig ?? provider.config ?? {};
	if (typeof config.mode === "string" && config.mode.length > 0) return true;
	const activeWhen = provider.activation?.activeWhenConfig;
	return !!activeWhen && Object.prototype.hasOwnProperty.call(activeWhen, "mode");
}

/**
 * P3 managed-runtime context resolution — the SINGLE source of truth shared by
 * BOTH the LifecycleHub provider-hook path (`runtimeResolver`) and the pack-ROUTE
 * dispatch path (`/api/ext/route/:name`), so a managed provider and its sibling
 * routes always agree on the runtime linkage they receive.
 *
 * For a provider/route in a MANAGED deployment mode (`managed` /
 * `managed-external-postgres`), it READS the supervisor's runtime status + the
 * already-persisted API host port (from the pure capability summary) and builds
 * the `ctx.runtime` linkage `{ baseUrl, headers, status }`. It NEVER starts
 * Docker. External mode / no supervisor / a stopped runtime / an unknown API
 * port ⇒ `undefined`, and the consumer stays dormant via its own gate.
 */
export async function resolveManagedRuntimeContext(
	supervisor: PackRuntimeSupervisorLike | undefined,
	opts: { packId: string; runtimeId: string; projectId?: string; config: Record<string, unknown> },
): Promise<RuntimeContext | undefined> {
	const { packId, runtimeId, projectId, config: providerConfig } = opts;
	const mode = typeof providerConfig.mode === "string" ? providerConfig.mode : "external";
	if (mode !== "managed" && mode !== "managed-external-postgres") return undefined;
	if (!supervisor) return undefined;
	let status: PackRuntimeStatus;
	try {
		status = await supervisor.status(packId, runtimeId, projectId);
	} catch {
		return undefined;
	}
	let apiPort: number | undefined;
	try {
		const cap = await supervisor.capabilitySummary(packId, runtimeId, { projectId });
		const apiSpec =
			cap.ports.find((p) => /(^|_)API_PORT$/i.test(p.key) || (p.env ? /(^|_)API_PORT$/i.test(p.env) : false)) ??
			cap.ports[0];
		if (apiSpec && typeof apiSpec.host === "number") apiPort = apiSpec.host;
	} catch {
		return undefined;
	}
	if (apiPort === undefined) return undefined;
	const apiKey = typeof providerConfig.apiKey === "string" && providerConfig.apiKey.length > 0 ? providerConfig.apiKey : undefined;
	const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
	return { baseUrl: `http://127.0.0.1:${apiPort}`, headers, status: status.status };
}

export type PackRuntimeSupervisorFactory = (deps: PackRuntimeSupervisorDeps) => PackRuntimeSupervisorLike | undefined;

let _packRuntimeSupervisorFactory: PackRuntimeSupervisorFactory | null = null;

/**
 * Register an alternative pack-runtime-supervisor factory. Called by test
 * harnesses to inject a fully-mocked supervisor (no Docker daemon) so the
 * /api/pack-runtimes/* routes can be exercised end-to-end. Pass `null` to clear.
 * When unset, production builds the real PackRuntimeSupervisor in start().
 */
export function registerPackRuntimeSupervisorFactory(factory: PackRuntimeSupervisorFactory | null): void {
	_packRuntimeSupervisorFactory = factory;
}

export function createGateway(config: GatewayConfig) {
	const stateDir = bobbitStateDir();
	const configDir = bobbitConfigDir();
	migrateLegacyHeadquartersDirectory({
		serverRunDir: getProjectRoot(),
		headquartersDir: bobbitDir(),
		headquartersStateDir: stateDir,
		headquartersConfigDir: configDir,
		legacyServerBobbitDir: path.join(getProjectRoot(), ".bobbit"),
	});
	fs.mkdirSync(stateDir, { recursive: true });
	// Ensure API-only/test gateways also get a startup-resolved agent dir even when
	// they do not enter through cli.ts. This is a no-op after CLI initialization.
	globalAgentDir();
	if (cpuDiagnosticsEnabled()) getCpuDiagnostics();

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
	migrateToPerProjectState(stateDir, projectRegistry, getProjectRoot(), { centralConfigDir: configDir });

	// Recover data lost by the original migration bug (unconditional rename
	// when central dir == default project dir). Must run before stores load.
	recoverPreMigrationData(stateDir);

	// One-shot project.yaml migration: synthesize components[] for legacy
	// single-repo projects. Idempotent. Must run BEFORE ProjectContext
	// instantiation so ProjectConfigStore.load() picks up the new shape,
	// and BEFORE the worktree pool fills.
	migrateAllProjectYaml(
		projectRegistry.list().map(p => ({ id: p.id, name: p.name, rootPath: p.rootPath })),
	);

	const projectConfigStore = new ProjectConfigStore(configDir);

	// One-time boot seed for first-party built-ins that ship present-but-disabled
	// (opt-in) — e.g. experiment-runner. Idempotent (durable marker under
	// stateDir) and a no-op when the pack is not actually shipped as a built-in;
	// never throws (src/server/agent/builtin-pack-defaults.ts).
	try {
		seedBuiltinPackDefaults({ stateDir, store: projectConfigStore, builtinPacksDir: resolveBuiltinPacksDir() });
	} catch (err) {
		console.warn(`[startup] builtin-pack-defaults seed failed: ${err}`);
	}

	// Initialize per-project contexts. Headquarters shares the server-scope
	// ProjectConfigStore so server/HQ writes cannot stale-read or clobber.
	const projectContextManager = new ProjectContextManager(projectRegistry, { headquartersProjectConfigStore: projectConfigStore });
	projectContextManager.initAll();

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

	const colorStore = new ColorStore(stateDir);
	const prStatusStore = new PrStatusStore(stateDir);
	const preferencesStore = new PreferencesStore(stateDir);
	const reviewAnnotationStore = new ReviewAnnotationStore(stateDir);
	const savedCwd = preferencesStore.get("defaultCwd");
	if (savedCwd && typeof savedCwd === "string") {
		config.defaultCwd = savedCwd;
	}
	const roleStore = new RoleStore(configDir);
	const roleManager = new RoleManager(roleStore);
	const toolManager = new ToolManager(configDir);
	toolManager.generateDetailDocs(stateDir);
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
	const groupPolicyStore = new ToolGroupPolicyStore(configDir);
	const verificationPolicyStore = new VerificationPolicyStore(configDir);
	const sandboxTokenStore = new SandboxTokenStore();
	const cookieStore = new CookieStore(stateDir);
	const sessionManager = new SessionManager({
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
	});
	sessionManager.sandboxTokenStore = sandboxTokenStore;

	// Wire sessionManager into the project context manager so the search
	// orphan filter can resolve sessions across projects (live, dormant,
	// archived). The registry is already passed via the constructor.
	projectContextManager.setDependencies({ sessionManager });
	// Wire gate status changes to bump goal generation for all project contexts
	for (const ctx of projectContextManager.all()) {
		ctx.gateStore.onStatusChange = () => {
			ctx.goalStore.bumpGeneration();
		};
	}

	const builtinConfigProvider = new BuiltinConfigProvider();
	// Wire builtin defaults into stores (in-memory only, no disk writes).
	// Direct store lookups (roleStore.get()) transparently fall back to
	// builtins, so no seeding to disk is needed. Workflows are project-
	// scoped only — no system layer, no builtin layer.
	roleStore.setBuiltins(builtinConfigProvider.getRoles());
	groupPolicyStore.setBuiltins(builtinConfigProvider.getToolGroupPolicies());
	verificationPolicyStore.setBuiltinRaw(builtinConfigProvider.getVerificationPolicyRaw());
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
		getVerificationPolicyRaw: () => verificationPolicyStore.getMergedRaw(),
	}, projectContextManager);
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
	const marketplaceSourceStore = new MarketplaceSourceStore(configDir);
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
		return buildMarketToolRootsForProject({
			projectId: effectiveProjectId,
			builtinEntries: builtinFirstPartyPackEntries(resolveBuiltinPacksDir()),
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
		for (const e of builtinFirstPartyPackEntries(resolveBuiltinPacksDir())) {
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
		// Disabled-runtime activation override (DisabledRefs.runtimes): a runtime
		// disabled via pack_activation is dropped from the pack's contributions, so the
		// supervisor's registry lookup 404s and runtime listings omit it.
		(scope, projectId, packName) => packActivationStore(scope as PackScope, projectId)?.getPackActivation(scope as PackOrderScope, packName).runtimes ?? [],
	);
	// P2 pack managed-runtime supervisor handle (Docker-backed). Declared HERE — before
	// the LifecycleHub — so the hub's runtime-context resolver can consult it lazily at
	// dispatch time. The production instance is built lazily in start(); a registered
	// test factory is consulted FRESH per call so registerPackRuntimeSupervisorFactory(null)
	// reverts cleanly with no stale mock cached. Boot/install/update/list/status never
	// start Docker (see the design invariants); the runtime resolver only READS status
	// + the already-persisted API host port to inject ctx.runtime for managed providers.
	let realPackRuntimeSupervisor: PackRuntimeSupervisorLike | undefined = undefined;
	const getActivePackRuntimeSupervisor = (): PackRuntimeSupervisorLike | undefined =>
		_packRuntimeSupervisorFactory
			? (_packRuntimeSupervisorFactory({ packContributionRegistry, stateDir, defaultCwd: config.defaultCwd }) ?? realPackRuntimeSupervisor)
			: realPackRuntimeSupervisor;

	sessionManager.lifecycleHub = new LifecycleHub({
		registry: packContributionRegistry,
		moduleHost,
		trace: new ContextTraceStore(bobbitStateDir()),
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
		// P3 — managed-runtime context injection. For a provider declaring a `runtime`
		// linkage in a MANAGED deployment mode, resolve ctx.runtime from the supervisor
		// WITHOUT starting Docker: read the runtime status + the already-persisted API
		// host port (from the pure capability summary). External mode / a stopped runtime
		// / an unknown port ⇒ undefined, and the provider stays dormant via its own gate.
		runtimeResolver: async ({ packId, runtimeId, projectId, config: providerConfig }) =>
			resolveManagedRuntimeContext(getActivePackRuntimeSupervisor(), { packId, runtimeId, projectId, config: providerConfig }),
	});
	// CLF-W1b — F14 thinking router: the Decision seam's first production
	// customer, registered at construction (not inside SessionManager's own
	// constructor, since `lifecycleHub` is assigned here, after the fact).
	// Deterministic-only, OBSERVE MODE ONLY: `enqueuePrompt` records the
	// Decision into the transparency trace but never applies it (see that
	// file's header comment for the full design-doc rationale).
	// S7 — `packContributionRegistry` lets a pack-declared `kind: selector`
	// provider (id `thinking-router-rules`) override/extend the built-in RULES
	// table; resolved ONCE here (synchronous, zero moduleHost) — see
	// thinking-router-classifier.ts's header for the full rationale.
	registerThinkingRouterClassifier(sessionManager.lifecycleHub, packContributionRegistry);
	// CLF-W2 — tool auto-approve/deny decision seam HARNESS. Allow-lists the
	// (tool-call, tool-approve) pair so `SessionManager.requestToolGrant`'s
	// real consult never hits `dispatchDecision`'s allow-list-rejection throw
	// — but deliberately registers NO classifier here (unlike the thinking
	// router above). Zero classifiers ⇒ every consult abstains ⇒ behaviour is
	// unconditionally unchanged today, regardless of `BOBBIT_CLF_TOOL_APPROVE`.
	// See tool-approve-classifier.ts's header for the full scope/rationale —
	// a real production classifier is a deliberately separate follow-up PR.
	sessionManager.lifecycleHub.allowDecisionPoint(TOOL_APPROVE_POINT, TOOL_APPROVE_KIND);
	// CLF-W2.5 — register the real, conservative rule-based tool-approve
	// heuristic (tool-approve-heuristic.ts) ONLY when BOBBIT_CLF_TOOL_APPROVE
	// is set at all (any value, including "observe"). Unset stays exactly
	// CLF-W2's harness-only state above — zero classifiers registered, every
	// consult abstains, byte-identical to before this file existed. See
	// `isToolApproveHeuristicEnabled`'s doc comment for why this is a
	// SEPARATE gate from `isToolApproveEnforceMode` (which only controls
	// whether a produced `deny` auto-applies, not whether the classifier
	// itself runs at all).
	if (isToolApproveHeuristicEnabled()) {
		registerToolApproveHeuristicClassifier(sessionManager.lifecycleHub);
	}
	// CLF-W4 — model-tier classifier: registered unconditionally, same as the
	// F14 thinking router above — this classifier has no apply/enforce mode at
	// all this wave (see model-tier-classifier.ts's header for why), so there
	// is nothing to gate behind a flag. Pure telemetry, zero behavior change.
	registerModelTierClassifier(sessionManager.lifecycleHub);
	// CLF-W5 — gate-risk classifier: registered unconditionally, same pattern
	// as CLF-W4's model-tier classifier above — no apply/enforce mode this
	// wave either (see gate-risk-classifier.ts's header for why). Pure
	// telemetry, zero behavior change; the classifier's proposed
	// low/medium/high label is the evidence VER-05's solo-fast auto-selection
	// question needs (RECONCILIATION-2026-07-05.md's dark-flags lane), never
	// applied by this wave.
	registerGateRiskClassifier(sessionManager.lifecycleHub);
	// SWARM-W4.3 — swarm-topology classifier: registered unconditionally, same
	// pattern as CLF-W4's model-tier classifier above — no apply/enforce mode
	// this wave either (see swarm-topology-classifier.ts's header for why).
	// Pure telemetry, zero behavior change; the best-of-N route consults this
	// classifier but never reads the decision back, so topology remains 100%
	// caller-supplied.
	registerSwarmTopologyClassifier(sessionManager.lifecycleHub);
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

	// ── Default-disabled built-in packs (e.g. Hindsight) ─────────────────────
	// A built-in first-party pack may ship `defaultDisabled: true` in its manifest:
	// it lists in the Marketplace built-in band but resolves DORMANT (tools,
	// provider, entrypoints, runtime all absent) on a fresh server until the user
	// enables it OR it is "already configured" (live-setup preservation). We inject
	// a READ-TIME overlay into the SERVER-scope activation store so the single
	// getPackActivation seam (cascade, registry, tool-manager, slash-skills,
	// Marketplace endpoints) all observe the same effective state. The overlay is
	// never persisted, so the dormancy invariant holds and an explicit user toggle
	// (a persisted record, or the force-enabled marker) always wins.
	//
	// The static per-pack info + force-enabled marker live in module-scope helpers
	// (getDefaultDisabledInfo / readForceEnabledPacks / writeForceEnabledPacks) so
	// the activation PUT in handleApiRoute (a top-level function) shares them. Here
	// we only INJECT the overlay resolver into the SERVER-scope store: it consults
	// the memoized static info plus the live gates (force-enabled marker + persisted
	// provider config) on each call (cheap, and only for default-disabled packs).
	projectConfigStore.setDefaultActivationResolver((scope, packName, stored): DisabledRefs | undefined => {
		if (scope !== "server") return undefined;
		const info = getDefaultDisabledInfo(packName, projectConfigStore);
		if (!info) return undefined;
		const isForceEnabled = readForceEnabledPacks(projectConfigStore).has(packName);
		let isConfigured = false;
		if (!isForceEnabled && Object.keys(stored).length === 0) {
			for (const pid of info.providerIds) {
				const cfg = getPackStore().getSync<Record<string, unknown>>(info.packId, providerConfigStoreKey(pid));
				if (isProviderConfigConfigured(cfg)) { isConfigured = true; break; }
			}
		}
		return resolveDefaultActivationOverlay({
			scope, packName, stored,
			isDefaultDisabled: true,
			isForceEnabled,
			isConfigured,
			allDisabledRefs: info.allDisabled,
		});
	});

	const staffManager = new StaffManager(projectContextManager);
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

	const triggerEngine = new TriggerEngine(staffManager, sessionManager, inboxManager);
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

	const teamManager = new TeamManager(sessionManager, {
		colorStore,
		taskManager: new TaskManager(taskStore),
		roleStore,
		projectContextManager,
		// Goal-completion lifecycle wiring (originally added in 00301569, silently
		// dropped by merge b687d93d — pinned by
		// tests/source-pin-merge-invariants.test.ts; DO NOT remove). Bridges
		// TeamManager's post-completion dispatch to the LifecycleHub so providers
		// declaring the `goalCompleted` hook (e.g. the Hindsight memory pack) fire
		// after a goal is durably marked complete. The hub is read lazily via the
		// closure — it is constructed earlier in createGateway but must not be
		// captured by value here.
		goalCompletedDispatcher: async (ctx) => {
			await sessionManager.lifecycleHub?.dispatchGoalCompleted(ctx);
		},
		hasGoalCompletedProviders: (goalId, projectId) =>
			!!sessionManager.lifecycleHub?.hasProvidersForHooks(projectId, GOAL_COMPLETED_PRESENCE_HOOKS, goalId),
		resolveGoalPullRequest: (goalId) => {
			const pr = prStatusStore.get(goalId);
			if (!pr) return undefined;
			// headSha is not part of the current PrStatusEntry shape but may exist on
			// persisted cache entries written by earlier versions — read defensively.
			const headSha = (pr as { headSha?: unknown }).headSha;
			return {
				url: pr.url,
				number: pr.number,
				title: pr.title,
				state: pr.state,
				headSha: typeof headSha === "string" ? headSha : undefined,
			};
		},
		toolManager,
		orchestrationCore,
	});
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
	);
	// Expose bg process manager for API routes and session cleanup
	(sessionManager as any).bgProcessManager = bgProcessManager;
	// Wave 1 of the `code_*` product tool group (docs/design/lsp-product-tools.md):
	// one gateway-owned tsserver instance per worktree root, lazily spawned on
	// first use. See src/server/routes/lsp-routes.ts for the HTTP surface
	// `defaults/tools/code/extension.ts` proxies to.
	const lspSupervisor = new TsServerSupervisor();
	const rateLimiter = new RateLimiter();

	const cleanupInterval = setInterval(() => {
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
			res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Bobbit-Session-Id, X-Bobbit-Spawning-Session, X-Bobbit-Operator-Confirmation");

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
			const hasAuthorizationHeader = typeof req.headers.authorization === "string" && req.headers.authorization.length > 0;
			const requestHeader = (value: string | string[] | undefined): string => Array.isArray(value) ? (value[0] || "") : (value || "");
			const hasSessionBoundAuthHeaders = (): boolean => Boolean(
				requestHeader(req.headers["x-bobbit-session-id"])
				|| requestHeader(req.headers["x-bobbit-session-secret"])
				|| requestHeader(req.headers["x-bobbit-spawning-session"]),
			);
			const canMintOperatorCookie = (): boolean => {
				if (url.pathname !== "/api/health" || req.method !== "GET") return false;
				if (hasAuthorizationHeader || url.searchParams.has("token") || hasSessionBoundAuthHeaders()) return false;
				return true;
			};

			// Cookie auth short-circuit — if the browser presents a known
			// bobbit_session cookie, treat the request as admin-authenticated
			// and skip the bearer-token check below.
			const hasValidCookie = cookieTryAuth(req, cookieStore);

			// Auth check — skipped in localhost mode (only local processes can connect)
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

				// Admin token first, then sandbox token
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
					// Successful admin Bearer/query-token auth mints only a preview/API
					// cookie so iframe content origin can authenticate without the token
					// leaking into URLs. Operator-confirmation-capable cookies must never
					// be issued to token-authenticated REST traffic.
					issueCookieIfMissing(req, res, cookieStore, { localhost: isLocalhostMode, operator: false });
				}
			} else if (!isPublicEndpoint && isLocalhostMode) {
				// Localhost mode: skip auth check, still mint the cookie so the
				// browser can use the same cookie auth path on non-localhost
				// deployments later (and the SSE endpoint below remains uniform).
				// Requests that carry Authorization or ?token are API/script traffic
				// and only receive preview/API-capable cookies. Local no-auth browser
				// bootstrap on /api/health receives the operator-capable cookie used
				// by human confirmation flows.
				issueCookieIfMissing(req, res, cookieStore, { localhost: true, operator: canMintOperatorCookie() });
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
			try {
				await handleApiRoute(url, req, res, {
					sessionManager,
					config,
					colorStore,
					prStatusStore,
					teamManager,
					orchestrationCore,
					roleManager,
					toolManager,
					projectContextManager,
					bgProcessManager,
					staffManager,
					verificationHarness,
					preferencesStore,
					projectConfigStore,
					groupPolicyStore,
					broadcastToGoal,
					broadcastToAll,
					sandboxManager,
					projectRegistry,
					configCascade,
					sandboxScope,
					sandboxTokenStore,
					reviewAnnotationStore,
					broadcastToSession,
					roleStore,
					inboxManager,
					marketplaceSourceStore,
					marketplaceInstaller,
					cookieStore,
					actionDispatcher,
					routeDispatcher,
					routeRegistry,
					packContributionRegistry,
					extensionChannelServices,
					packRuntimeSupervisor: getActivePackRuntimeSupervisor(),
					lspSupervisor,
				});
			} catch (err) {
				// Central backstop: a route handler that throws (e.g. a durable
				// store refusing to save over a corrupt file — ProjectConfigStore's
				// CON-02 loadFailed guard) must surface as an error response, not a
				// silently hung request plus an unhandled-rejection log line.
				console.error(`[gateway] Unhandled API route error (${req.method} ${url.pathname}):`, err);
				if (!res.headersSent) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
				} else if (!res.writableEnded) {
					res.end();
				}
			}
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
			for (const client of wss.clients) {
				const ws = client as AuthenticatedWS;
				if (!ws.authenticated || ws.readyState !== 1 /* OPEN */) continue;
				const sid = ws.sessionId;
				if (sid) {
					const session = sessionManager.getSession(sid);
					if (session?.teamGoalId === goalId || session?.goalId === goalId) ws.send(data);
					continue;
				}
				if (viewerSubscribedToGoal(ws, goalId)) ws.send(data);
			}
			return;
		}

		const stringifyStart = performance.now();
		const data = JSON.stringify(event);
		const stringifyMs = performance.now() - stringifyStart;
		const sendStart = performance.now();
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
		for (const client of wss.clients) {
			const ws = client as AuthenticatedWS;
			scanned++;
			if (!ws.authenticated || ws.readyState !== 1 /* OPEN */) { skipped++; continue; }
			const sid = ws.sessionId;
			if (sid) {
				const session = sessionManager.getSession(sid);
				if (session?.teamGoalId === goalId || session?.goalId === goalId) {
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
			if (ws.isViewer) {
				if (viewerSubscribedToGoal(ws, goalId)) {
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
			for (const client of wss.clients) {
				const ws = client as AuthenticatedWS;
				if (ws.authenticated && ws.readyState === 1 /* OPEN */) {
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
		for (const client of wss.clients) {
			const ws = client as AuthenticatedWS;
			scanned++;
			if (ws.authenticated && ws.readyState === 1 /* OPEN */) {
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
			for (const client of wss.clients) {
				const ws = client as AuthenticatedWS;
				if (!ws.authenticated || ws.readyState !== 1 /* OPEN */) continue;
				const sid = ws.sessionId;
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
		for (const client of wss.clients) {
			const ws = client as AuthenticatedWS;
			scanned++;
			if (!ws.authenticated || ws.readyState !== 1 /* OPEN */) { skipped++; continue; }
			const sid = ws.sessionId;
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
				if (ws.readyState === 1 /* OPEN */) ws.send(data);
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
			if (ws.readyState === 1 /* OPEN */) {
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

	verificationHarness = new VerificationHarness(stateDir, undefined, broadcastToGoal, roleStore, preferencesStore, sessionManager, teamManager, projectConfigStore, projectContextManager, configCascade);
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

	// SWARM-W2 (design/swarm-orchestration.md §11 Wave 2 "restart-resume"):
	// the SwarmGovernor above is a fresh, empty, in-memory instance every
	// boot — re-arm it now for any swarm-sibling goal that was still
	// in-flight (expected but not yet terminal) when the gateway last
	// stopped, so token-budget/straggler enforcement resumes rather than
	// silently lapsing for the rest of that sibling's life. Best-effort,
	// synchronous, cheap (bounded by live swarm-group count) — every store
	// it reads was already loaded from disk by `projectContextManager.initAll()`
	// earlier in boot.
	try {
		reArmSwarmGovernorsOnBoot(projectContextManager, verificationHarness);
	} catch (err) {
		console.warn("[swarm-restart-resume] boot re-arm sweep failed (non-fatal):", err);
	}

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

	return {
		server,
		sessionManager,
		/** @internal Exposed for in-process E2E tests to drive supervisor-respawn directly. */
		teamManager,
		/** @internal Exposed for in-process E2E tests to drive restart-survival (rebuildIndexFromPersisted + remindOwnersWithLiveChildren) directly. */
		orchestrationCore,
		bgProcessManager,
		projectContextManager,
		/**
		 * @internal Exposed for in-process E2E tests to drive the SWARM-W2
		 * restart-resume boot sweep (`reArmSwarmGovernorsOnBoot`) directly — an
		 * in-process gateway can't literally kill+restart its own Node process,
		 * so the restart-resume E2E re-invokes the exact same boot-time
		 * function against this live `verificationHarness`/`projectContextManager`
		 * pair to simulate "gateway restarted" deterministically (see
		 * tests/e2e/api-swarm-restart-resume.spec.ts).
		 */
		verificationHarness,
		/** @internal Exposed for in-process E2E tests to seed/read preferences directly (see tests/e2e/in-process-harness.ts GatewayInfo.preferencesStore). */
		preferencesStore,
		get extensionChannels() { return extensionChannelServices; },
		async start(): Promise<number> {
			// Check internet and auto-configure AI Gateway if offline
			// Runs before session restore so models.json is written before
			// any agent subprocesses start.
			await startupAigwCheck(preferencesStore);
			// P2: build the real pack-runtime supervisor unless a test factory already
			// supplied a (mocked) one. All Docker execution is encapsulated in the
			// supervisor; rendered env files live under the server state dir.
			if (!realPackRuntimeSupervisor && !_packRuntimeSupervisorFactory) {
				try {
					const { SecretsStore } = await import("./agent/secrets-store.js");
					const runtimeDataDir = path.join(stateDir, "pack-runtimes");
					// Production-safe resolver context: declared generated secrets are
					// created+persisted via SecretsStore and declared host ports via a
					// file-backed FilePortStore, so real pack runtimes (e.g. Hindsight)
					// resolve their env refs instead of throwing before Docker starts.
					realPackRuntimeSupervisor = new PackRuntimeSupervisor({
						registry: packContributionRegistry,
						runtimeDataDir,
						// STABLE across gateway restarts (persisted under the state dir): a
						// random per-process suffix would change the compose project name on
						// every restart and orphan the still-running containers.
						serverIdentitySuffix: getOrCreatePackRuntimeServerIdentity(stateDir),
						secretsStore: new SecretsStore(stateDir),
						portStore: new FilePortStore(path.join(runtimeDataDir, "ports.json")),
					});
				} catch (err) {
					console.warn(`[pack-runtimes] supervisor unavailable: ${(err as Error)?.message ?? err}`);
				}
			}
			await writeContextWindowOverrides();
			await writeOpenAIModelAdditions();
			// Re-discover configured custom local providers (Ollama/LM Studio/vLLM/
			// llama.cpp/manual) and refresh their models.json entries so restarts
			// pick up whatever's currently running without requiring a manual
			// re-save in Settings. Best-effort — an unreachable local server here
			// just means that provider's models stay stale/absent this run.
			if (!process.env.BOBBIT_SKIP_CUSTOM_PROVIDER_SYNC) {
				try {
					await syncCustomProviderModelsJson(preferencesStore);
				} catch (err) {
					console.warn("[custom-providers] Startup models.json sync failed:", (err as Error).message);
				}
			}
			await initExtensionChannelsOnce();

			// Initialize MCP servers (skip in test environments)
			if (!process.env.BOBBIT_SKIP_MCP) {
				try {
					await sessionManager.initMcp(headquartersDir());
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

				const isRepo = await isGitRepo(projectDir);
				if (!isRepo) {
					console.log(`[sandbox] Project ${projectId} is not a git repo — sandbox disabled (worktrees require git)`);
					return null;
				}
				const repoPath = await getRepoRoot(projectDir);

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
						const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd, timeout: 5000 });
						return stdout.trim() || null;
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
			sandboxManager = new SandboxManager({ bootstrap: sandboxBootstrap });
			sessionManager.setSandboxManager(sandboxManager);
			sessionManager.subscribeSandboxRecovery();

			// Restore persisted sessions before accepting connections
			await sessionManager.restoreSessions();

			// One-shot legacy cost backfill: stamp `goalId` on cost entries
			// that pre-date the forward-stamp fix (commit a4050f59). Runs
			// once per project context after sessions are restored so the
			// resolver can see live PersistedSession records. Idempotent.
			const agentSessionsRoot = path.join(globalAgentDir(), "sessions");
			try {
				for (const ctx of projectContextManager.all()) {
					backfillLegacyCostGoalIds({
						costTracker: ctx.costTracker,
						sessionManager,
						agentSessionsRoot,
					});
				}
			} catch (err) {
				console.warn("[cost-backfill] boot backfill failed (non-fatal):", err);
			}

			// NOTE: Orphaned worktree cleanup and non-interactive session cleanup
			// are no longer automatic on startup. Use the Settings → Maintenance UI
			// or the /api/maintenance/* endpoints to preview and clean up manually.

			sessionManager.startPurgeSchedule();

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
				// Runs *after* the synchronous sidecar pass so it only touches entries
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
							if (!isMultiRepoProject && await isGitRepo(ctx.project.rootPath).catch(() => false)) {
								sweepRootPath = await getRepoRoot(ctx.project.rootPath);
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
						console.log(`[boot] sweeper start (${sweepProjects.length} projects)`);
						const result = await sweepOrphanedWorktrees({
							projects: sweepProjects,
							goals: sweepGoals,
							sessions: sweepSessions,
							teams: sweepTeams,
							staff: sweepStaff,
						});
						console.log(`[boot] sweeper done in ${Date.now() - tStart}ms (reclaimed=${result.reclaimed} cleaned=${result.cleaned} repaired=${result.repaired})`);
					} catch (err) {
						console.warn(`[boot] sweeper failed in ${Date.now() - tStart}ms (non-fatal):`, err);
					}
				})();

				const poolInitTask = (async () => {
					if (process.env.BOBBIT_SKIP_WORKTREE_POOL) return;
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
									if (!(await isGitRepo(path.join(repoPath, c.repo)))) { poolReady = false; break; }
								}
							} else {
								poolReady = await isGitRepo(repoPath);
							}
							if (poolReady) {
								const poolSize = parseInt(ctx.projectConfigStore.get("worktree_pool_size") || "2", 10) || 2;
								const wtRoot = ctx.projectConfigStore.get("worktree_root") || undefined;
								const pcs = ctx.projectConfigStore;
								// Single-repo: resolve nested rootPath to the actual git toplevel so
								// pool entries land under <gitRoot>-wt/, not <projectDir>-wt/.
								const poolRepoPath = isMulti ? repoPath : await getRepoRoot(repoPath);
								sessionManager.initWorktreePoolForProject(ctx.project.id, poolRepoPath, () => pcs.getComponents(), poolSize, wtRoot, () => pcs.get("base_ref"), () => pcs.get("worktree_setup_timeout_ms") || undefined, ctx.project.rootPath);
								console.log(`[boot] pool ready: project=${ctx.project.id} in ${Date.now() - tStart}ms`);
							} else {
								console.log(`[boot] pool skipped (not a git repo): project=${ctx.project.id} in ${Date.now() - tStart}ms`);
							}
						} catch (err) {
							console.warn(`[boot] pool init failed: project=${ctx.project.id} in ${Date.now() - tStart}ms (non-fatal):`, err);
						}
					}));
				})();
				await Promise.all([transcriptBackfillTask, sweeperTask, poolInitTask]);
				console.log(`[boot] background tasks complete in ${Date.now() - t0}ms`);
			};

			// Wire goal-manager resolvers so goals claim through the pool first and
			// resolve components / project root for multi-repo goal creation.
			// Hidden contexts (synthetic system project) have no goals to wire.
			for (const ctx of projectContextManager.visible()) {
				wireGoalManagerResolvers(ctx, { sessionManager, projectContextManager, projectRegistry });
			}

			// Now that sessions are live, re-subscribe to team events
			// (must happen after restoreSessions so session objects exist)
			teamManager.resubscribeTeamEvents();

			// Resume any verifications that were interrupted by a server restart (fire-and-forget)
			verificationHarness.resumeInterruptedVerifications().catch(err => {
				console.error("[verification] Error resuming interrupted verifications:", err);
			});

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
			clearInterval(cleanupInterval);
			triggerEngine.stop();
			inboxNudger.stop();
			wss.close();
			await disposeExtensionChannelServices(extensionChannelServices, "gateway-shutdown");
			try { getCpuDiagnostics().shutdown(); } catch { /* best-effort */ }
			try { verificationHarness?.shutdown(); } catch { /* best-effort */ }
			for (const pool of sessionManager.getAllWorktreePools().values()) {
				await pool.drain();
			}
			await sessionManager.getPiProcessPool().drain();
			await sessionManager.shutdown();
			await projectContextManager.closeAll();
			if (sandboxManager) {
				await sandboxManager.shutdownAll();
			}
			await sessionManager.cleanupSandboxNetwork();
			await lspSupervisor.shutdownAll();
		},
	};
}

// isSetupComplete now lives in ./setup-status.ts (re-exported at top of file).

// The sandbox-secret redaction/merge helpers (redactSandboxSecrets,
// redactSandboxSecretsResolved, mergeSecretsIntoTokens,
// mergeSandboxTokensStructured, mergeSandboxSecrets) moved to
// src/server/routes/project-config-routes.ts (STR-01 cohort 2) — their only
// callers, the /api/projects/:id/config* handlers, moved with them.

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

// STR-01 core route registry (docs/design/route-registry.md). Built ONCE at
// module load — handlers are pure functions of (ctx, params) with no closure
// over any particular gateway instance's state (all instance-specific state
// flows through the per-request `CoreRouteCtx` built inside handleApiRoute
// below), so a single table instance is safe to reuse across every gateway
// created in this process (relevant for e2e tests, which may construct
// multiple gateways in one process).
const coreRouteTable = new RouteTable<CoreRouteCtx>();
// One line per migrated cohort — parallel cohort branches APPEND below the
// existing lines (never reorder) so they merge without conflicts.
registerProjectRoutes(coreRouteTable);
registerProjectConfigRoutes(coreRouteTable);
registerMarketplaceRoutes(coreRouteTable);
registerStaffInboxRoutes(coreRouteTable);
registerPackRuntimesRoutes(coreRouteTable);
registerServerProjectConfigRoutes(coreRouteTable);
registerWorkflowsRoutes(coreRouteTable);
registerReviewAnnotationRoutes(coreRouteTable);
registerSessionUtilityRoutes(coreRouteTable);
registerMaintenanceRoutes(coreRouteTable);
registerServerSystemRoutes(coreRouteTable);
registerStaffMcpOperatorRoutes(coreRouteTable);
registerOauthAccountRoutes(coreRouteTable);
registerPreferencesRoutes(coreRouteTable);
registerConfigDirectoriesRoutes(coreRouteTable);
registerRolesRoutes(coreRouteTable);
registerDirectoryBrowserRoutes(coreRouteTable);
registerLspRoutes(coreRouteTable);
registerSkillsRoutes(coreRouteTable);
registerModelProviderRoutes(coreRouteTable);
registerCostRoutes(coreRouteTable);
registerPreviewRoutes(coreRouteTable);
registerSessionProposalRoutes(coreRouteTable);
registerHostConfigRoutes(coreRouteTable);
registerSessionControlRoutes(coreRouteTable);
registerSessionDiscoveryRoutes(coreRouteTable);
registerSessionMutationRoutes(coreRouteTable);
registerSessionCreationRoutes(coreRouteTable);
registerSessionGitReadRoutes(coreRouteTable);
registerSessionGitWriteRoutes(coreRouteTable);
registerSessionContentRoutes(coreRouteTable);
registerPromptAutocompleteRoutes(coreRouteTable);
registerGoalReadRoutes(coreRouteTable);
registerGoalCrudRoutes(coreRouteTable);
registerTasksRoutes(coreRouteTable);
registerExtensionHostUiRoutes(coreRouteTable);

interface HandleApiRouteDeps {
	sessionManager: SessionManager;
	config: GatewayConfig;
	colorStore: ColorStore;
	prStatusStore: PrStatusStore;
	teamManager: TeamManager;
	orchestrationCore: OrchestrationCore;
	roleManager: RoleManager;
	toolManager: ToolManager;
	projectContextManager: ProjectContextManager;
	bgProcessManager: BgProcessManager;
	staffManager: StaffManager;
	verificationHarness: VerificationHarness;
	preferencesStore: PreferencesStore;
	projectConfigStore: ProjectConfigStore;
	groupPolicyStore: ToolGroupPolicyStore;
	broadcastToGoal(goalId: string, event: any): void;
	broadcastToAll(event: any): void;
	sandboxManager: SandboxManager | null;
	projectRegistry: ProjectRegistry;
	configCascade: ConfigCascade;
	sandboxScope?: SandboxScope;
	sandboxTokenStore: SandboxTokenStore;
	reviewAnnotationStore?: ReviewAnnotationStore;
	broadcastToSession?(sessionId: string, event: any): void;
	roleStore: RoleStore;
	inboxManager: InboxManager;
	marketplaceSourceStore: MarketplaceSourceStore;
	marketplaceInstaller: MarketplaceInstaller;
	cookieStore: CookieStore;
	actionDispatcher: ActionDispatcher;
	routeDispatcher: RouteDispatcher;
	routeRegistry: RouteRegistry;
	packContributionRegistry: PackContributionRegistry;
	extensionChannelServices?: ExtensionChannelServices;
	packRuntimeSupervisor?: PackRuntimeSupervisorLike;
	lspSupervisor?: TsServerSupervisor;
}

async function handleApiRoute(
	url: URL,
	req: http.IncomingMessage,
	res: http.ServerResponse,
	deps: HandleApiRouteDeps,
) {
	const {
		sessionManager,
		config,
		colorStore,
		prStatusStore,
		teamManager,
		orchestrationCore,
		roleManager,
		toolManager,
		projectContextManager,
		bgProcessManager,
		staffManager,
		verificationHarness,
		preferencesStore,
		projectConfigStore,
		groupPolicyStore,
		broadcastToGoal,
		broadcastToAll,
		sandboxManager,
		projectRegistry,
		configCascade,
		sandboxScope,
		sandboxTokenStore,
		reviewAnnotationStore,
		broadcastToSession: _broadcastToSession,
		roleStore: serverRoleStore,
		inboxManager,
		marketplaceSourceStore,
		marketplaceInstaller,
		cookieStore,
		actionDispatcher: dispatcher,
		routeDispatcher,
		routeRegistry,
		packContributionRegistry,
		extensionChannelServices,
		packRuntimeSupervisor,
		lspSupervisor,
	} = deps;
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
	const invalidateResolverCaches = (): void => { invalidateSlashSkillsCache(); __resetToolScanCache(); toolManager.clearScopedPiExtensionTools(); piExtensionDiscoveryCache.clear(); dispatcher.invalidate(); routeDispatcher.invalidate(); routeRegistry.invalidate(); packContributionRegistry.invalidate(); closeUnavailableExtensionChannels(); clearDefaultDisabledInfoCache(); };
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
	})) return;

	// ── Core route registry (STR-01) ────────────────────────────────
	// Consulted BEFORE the legacy if/else chain below. A match here handles
	// the request and returns; no match falls through unchanged (this is
	// how routes are migrated one cohort at a time — see
	// docs/design/route-registry.md). Registrants so far: cohort 1, the
	// /api/projects* CRUD + preflight/detect/scan/promote/base-ref-detect
	// family (src/server/routes/projects-routes.ts); cohort 2, the per-project
	// config family (src/server/routes/project-config-routes.ts); cohort 3,
	// the /api/marketplace/* + GET /api/packs/conflicts family
	// (src/server/routes/marketplace-routes.ts); cohort 5, the staff-inbox
	// family (src/server/routes/staff-inbox-routes.ts); cohort 4, the
	// /api/pack-runtimes* family (src/server/routes/pack-runtimes-routes.ts)
	// and the server-scope /api/project-config trio
	// (src/server/routes/project-config-server-routes.ts); cohort 6, the
	// workflows family (src/server/routes/workflows-routes.ts) and the
	// review-annotation family (src/server/routes/review-annotations-routes.ts);
	// cohort 7, session utility routes
	// (src/server/routes/session-utility-routes.ts); cohort 8, maintenance and
	// search-admin routes (src/server/routes/maintenance-routes.ts); cohort 9,
	// server/system routes (src/server/routes/server-system-routes.ts);
	// cohort 10, staff CRUD plus MCP operator/internal-MCP routes
	// (src/server/routes/staff-mcp-operator-routes.ts).
	// server/system routes (src/server/routes/server-system-routes.ts); cohort
	// 11, OAuth account routes (src/server/routes/oauth-account-routes.ts);
	// cohort 12, preferences routes (src/server/routes/preferences-routes.ts);
	// cohort 13, config-directories routes
	// (src/server/routes/config-directories-routes.ts);
	// STR-05, roles routes (src/server/routes/roles-routes.ts).
	// cohort 17, editable proposal REST routes
	// (src/server/routes/session-proposal-routes.ts).
	// cohort 18, host configuration routes
	// (src/server/routes/host-config-routes.ts).
	// cohort 19, session control/provider-hook routes
	// (src/server/routes/session-control-routes.ts).
	// cohort 20, session discovery/read routes
	// (src/server/routes/session-discovery-routes.ts).
	// cohort 21, session mutation/lifecycle routes
	// (src/server/routes/session-mutation-routes.ts).
	// cohort 22, session creation route
	// (src/server/routes/session-creation-routes.ts).
	// cohort 23, session git read/status routes
	// (src/server/routes/session-git-read-routes.ts).
	// cohort 24, session git write/PR mutation routes
	// (src/server/routes/session-git-write-routes.ts).
	// cohort 25, session content/readback routes
	// (src/server/routes/session-content-routes.ts).
	// cohort 27, task routes (src/server/routes/tasks-routes.ts).
	// cohort 28, pack UI/contribution discovery routes
	// (src/server/routes/extension-host-ui-routes.ts).
	// goals G2a, goal CRUD-core create/read/update routes
	// (src/server/routes/goal-crud-routes.ts).
	{
		const coreMatch = coreRouteTable.match(req.method || "GET", url.pathname);
		if (coreMatch) {
			const coreCtx: CoreRouteCtx = {
				req, res, url, json, jsonError, readBody,
				sessionManager, projectRegistry, projectContextManager, broadcastToAll,
				isHeadquartersOwnedPath, listProjectsForApi, writeSpecialProjectMutationError, headquartersProject,
				wireGoalManagerResolvers, validateComponentsConfig, isValidBaseRefBranchGrammar, detectedRefExistsInAllComponents,
				// Cohort 2 (project-config) — append-only, like the ctx interface.
				legacyQaTopLevelKeys: LEGACY_QA_TOP_LEVEL_KEYS,
				serverProjectConfigStore: projectConfigStore,
				// Cohort 3 (marketplace) additions — append-only, see core-route-ctx.ts.
				marketplaceInstaller, marketplaceSourceStore, packRuntimeSupervisor, configCascade, projectConfigStore,
				invalidateResolverCaches, reloadMcpAfterMarketplaceMutation,
				resolveProjectConfigStore, resolveSkillDiscoveryCwd, skillMarketContext,
				safeString, readYamlMapping, readConcretePackToolsFromGroups,
				getDefaultDisabledInfo, readForceEnabledPacks, writeForceEnabledPacks,
				loadPiExtensionContributionsFromRuntime, piExtensionDiagnostic, normalisePiExtensionCatalogueRefs,
				activationMcpContributionId, operationMetadataForMcpContribution,
				resolveRuntimeStartPlan, providerCarriesDeploymentMode, mapDeploymentModeToRuntimeMode,
				// Cohort 5 (staff inbox) additions — append-only, see core-route-ctx.ts.
				staffManager, inboxManager,
				// Cohort 4 (pack-runtimes) additions — append-only, see core-route-ctx.ts.
				packContributionRegistry, readBodyText,
				// Cohort 6 (workflows + review-annotations) additions — append-only,
				// see core-route-ctx.ts. Workflows needed no new fields.
				reviewAnnotationStore,
				// Cohort 7 (session utility routes) additions — append-only.
				bgProcessManager, noContent, toolManager,
				// Cohort 9 (server/system routes) additions — append-only.
				config, preferencesStore, sandboxManager: sandboxManager ?? undefined, getAigwUrl, writeProjectResolutionError,
				// Cohort 10 (staff CRUD + MCP operator routes) additions — append-only.
				groupPolicyStore, refreshMcpExternalTools, resolveRoleForProject,
				// Cohort 12 (preferences routes) additions — append-only.
				broadcastPreferencesChanged, claudeCodeConfirmationBinding, firstHeader, getSafePreferences, isHumanOperatorRequest,
				// STR-05 roles route-hoist additions — append-only.
				clampRoleThinking, resolveRequiredConfigProjectScope, roleManager, serverRoleStore, writeConfigProjectScopeError,
				// Cohort 14 (directory browser routes) additions — append-only.
				defaultCwd: config.defaultCwd,
				// Cohort 15 (model/provider routes) additions — append-only.
				sandboxScope,
				// Wave 1 LSP routes additions — append-only.
				lspSupervisor,
				// Cohort 16a (cost routes) additions — append-only.
				getGoalAcrossProjects, getTaskManagerForTask,
				// Cohort 16b (preview routes) additions — append-only.
				broadcastToSession: _broadcastToSession,
				// Cohort 17 (editable proposal routes) additions — append-only.
				validateGoalProposalWorkflow,
				// Cohort 18 (host configuration routes) additions — append-only.
				mutableGatewayConfig: config,
				// Cohort 20 (session discovery routes) additions — append-only.
				archivedSessionMatchesQuery, bfsEnrichArchived, colorStore, normalizedArchivedQuery,
				// Cohort 21 (session mutation/lifecycle routes) additions — append-only.
				getGoalManagerForGoal, isUnsupportedForkSource, roleCreateOptions,
				// Cohort 22 (session creation route) additions — append-only.
				sandboxTokenStore, writeCwdValidationError,
				// Cohort 23 (session git read/status routes) additions — append-only.
				isHeadquartersSession, prStatusStore, sessionGitUnavailablePayload,
				// Goals G1 additions — append-only.
				archivedGoalMatchesQuery, getTaskManagerForGoal, listGoalsAcrossProjects, requireSubgoalsEnabled, verificationHarness,
				// Cohort 27 (task routes) additions — append-only.
				getTaskRecordForTask, sandboxCanAccessTask, teamManager,
				// Goals G2a additions — append-only.
				cookieStore: cookieStore!,
			};
			await coreMatch.handler(coreCtx, coreMatch.params);
			return;
		}
	}

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

	// GET /api/harness-status, POST /api/harness/restart,
	// GET/POST /api/dev/boot-timing, GET /api/health,
	// POST /api/internal/test/replay-buffered-events/:sessionId,
	// GET/POST /api/setup-status*, GET/PUT /api/system-prompt-context,
	// POST /api/system-prompt/customise, POST /api/shutdown,
	// GET /api/ca-cert, GET /api/sandbox-pool, GET /api/worktree-pool,
	// GET /api/sandbox-status, POST /api/sandbox-image/build, and
	// GET /api/sandbox/host-tokens moved to the core route registry
	// (STR-01 cohort 9) — see src/server/routes/server-system-routes.ts.
	// ── Project Detection & Browse ────────────────────────────────────

	// GET /api/projects/preflight, POST /api/projects/archive-bobbit,
	// POST /api/projects/detect, POST /api/projects/scan,
	// GET /api/projects/:id/structured, POST /api/projects/:id/rescan-repos
	// moved to the core route registry (STR-01 cohort 1) — see
	// src/server/routes/projects-routes.ts and docs/design/route-registry.md.
	// Upstream's HQ Split (#932) added Headquarters-aware preflight relabeling
	// and archive-bobbit preservation of a physically-nested Headquarters
	// directory (custom BOBBIT_DIR case) to these handlers; both were ported
	// into projects-routes.ts's handleProjectsPreflight/handleProjectsArchiveBobbit
	// rather than reintroduced here. See docs/design/route-registry.md and
	// tests/e2e/headquarters-api.spec.ts / tests/headquarters-server-scope-guards.test.ts.

	// POST /api/create-directory and GET /api/browse-directory moved to the
	// core route registry (STR-01 cohort 14) — see
	// src/server/routes/directory-browser-routes.ts and
	// docs/design/route-registry.md.

	// ── Project CRUD ──────────────────────────────────────────────────
	// GET/POST /api/projects, PUT /api/projects/order,
	// GET/PUT/DELETE /api/projects/:id, POST /api/projects/:id/promote,
	// GET /api/projects/:id/base-ref/detect moved to the core route registry
	// (STR-01 cohort 1) — see src/server/routes/projects-routes.ts and
	// docs/design/route-registry.md.

	// GET/PUT /api/projects/:id/config, GET /api/projects/:id/config/defaults,
	// GET /api/projects/:id/config/resolved moved to the core route registry
	// (STR-01 cohort 2) — see src/server/routes/project-config-routes.ts and
	// docs/design/route-registry.md (including the fall-through-parity shims
	// for unhandled methods on those paths).

	// GET /api/projects/:id/qa-testing-config moved to the core route registry
	// (STR-01 cohort 4) — see src/server/routes/projects-routes.ts and
	// docs/design/route-registry.md.

	// BFS helper: walk delegateOf, parentSessionId, teamLeadSessionId, teamGoalId, and goalId chains
	// from seed IDs through an archived session pool.
	function bfsEnrichArchived(seedIds: string[], allArchived: any[]): any[] {
		const result: any[] = [];
		const seen = new Set<string>();
		const queue = [...seedIds];
		while (queue.length > 0) {
			const parentId = queue.shift()!;
			for (const s of allArchived) {
				if (!seen.has(s.id) && (
					s.delegateOf === parentId ||
					s.parentSessionId === parentId ||
					s.teamLeadSessionId === parentId ||
					s.teamGoalId === parentId ||
					s.goalId === parentId
				)) {
					seen.add(s.id);
					result.push(s);
					queue.push(s.id);
				}
			}
		}
		return result;
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

	// GET /api/search, GET /api/sessions, and GET /api/sessions/:id moved to
	// the core route registry (STR-01 cohort 20) — see
	// src/server/routes/session-discovery-routes.ts and
	// docs/design/route-registry.md.

	// POST /api/sessions/:id/activate-skill,
	// POST /api/sessions/:id/tool-grant-request,
	// POST /api/sessions/:id/provider-hooks/{before-prompt,before-compact},
	// GET /api/sessions/:id/context-trace, and
	// POST /api/sessions/:id/restart moved to the core route registry
	// (STR-01 cohort 19) — see src/server/routes/session-control-routes.ts
	// and docs/design/route-registry.md.

	// POST /api/sessions moved to the core route registry (STR-01 cohort 22) —
	// see src/server/routes/session-creation-routes.ts and docs/design/route-registry.md.

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

	// ── SWARM-W1 endpoints ────────────────────────────────────────
	// REST surface for the fixed best-of-N swarm pattern. Implementation in
	// `swarm-routes.ts`. See docs/design/swarm-orchestration-w1.md.
	if (await tryHandleSwarmRoute(req, url, {
		projectContextManager,
		verificationHarness,
		teamManager,
		sessionManager,
		cookieStore: cookieStore!,
		getGoalAcrossProjects,
		getGoalManagerForGoal,
		readBody,
		json,
		jsonError,
		broadcastToAll,
	})) return;

	// ── Goal endpoints ─────────────────────────────────────────────

	// GET /api/goals, GET /api/goals/:goalId/descendants, and
	// GET /api/goals/:goalId/tree-cost moved to the core route registry
	// (STR-01 goals cohort G1) — see src/server/routes/goal-read-routes.ts.

	// POST /api/goals moved to the core route registry
	// (STR-01 goals cohort G2a) — see src/server/routes/goal-crud-routes.ts.

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
				// SWARM-W0: this is a general archive, not necessarily a merge — a
				// goal archived without ever reaching state=complete is an
				// operator-initiated "kill" from the swarm barrier's point of view
				// (see docs/design/swarm-orchestration-w0.md for why goals have no
				// separate "failed" state yet). Mirrors the mergedManually stamp
				// above (which flips this same goal's state to "complete" first).
				const swarmTerminalStatus = (g.state === "complete" || (mergedManually && g.id === id)) ? "done" : "killed";
				try { await verificationHarness.notifyChildTerminal(g.id, swarmTerminalStatus); } catch (err) {
					console.warn(`[api] archive: notifyChildTerminal failed for ${g.id} (non-fatal):`, err);
				}
			}
			const gm = getGoalManagerForGoal(g.id);
			await gm.archiveGoal(g.id);
			prStatusStore.remove(g.id);
			const archivedGoal = gm.getGoal(g.id);
			if (archivedGoal?.repoPath) {
				deleteRemoteGoalBranches(archivedGoal, agentBranches, archivedGoal.repoPath).catch(err => {
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

	// GET /api/goals/:id and PUT /api/goals/:id moved to the core route registry
	// (STR-01 goals cohort G2a) — see src/server/routes/goal-crud-routes.ts.
	// DELETE /api/goals/:id remains inline with the archive-cascade helper until G2b.
	const goalMatch = url.pathname.match(/^\/api\/goals\/([^/]+)$/);
	if (goalMatch && req.method === "DELETE") {
		const id = goalMatch[1];
		await archiveGoalEndpoint(id);
		return;
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

	// GET /api/tools/:tool/renderer, GET /api/ext/packs/:packId/panels/:panelId,
	// GET/POST /api/ext/packs/:packId/settings-sections/:sectionId{/surface-token},
	// and GET /api/ext/contributions moved to the core route registry
	// (STR-01 cohort 28) — see src/server/routes/extension-host-ui-routes.ts.

	// GET /api/pack-runtimes, GET /api/pack-runtimes/:id/capabilities,
	// POST /api/pack-runtimes/:id/down, POST /api/pack-runtimes/:id/{start,stop,
	// restart}, GET /api/pack-runtimes/:id/logs moved to the core route registry
	// (STR-01 cohort 4) — see src/server/routes/pack-runtimes-routes.ts and
	// docs/design/route-registry.md (including the fall-through-parity shims
	// for unhandled methods on those paths).

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
			// EXPERIMENT-RUNNER SEAM: back host.agents.spawnGoal with the shared
			// nested-goal creation closure (parent-derived, cap-aware team start).
			spawnChildGoal: (ownerSessionId: string, spawnOpts) => spawnExperimentChildGoal({
				sessionManager,
				projectContextManager,
				verificationHarness,
				getSubgoalNestingPrefs: () => readSubgoalNestingPrefs((k) => preferencesStore.get(k)),
				broadcastToAll,
			}, ownerSessionId, spawnOpts),
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
			// EXPERIMENT-RUNNER SEAM: back host.agents.spawnGoal with the shared
			// nested-goal creation closure (parent-derived, cap-aware team start).
			spawnChildGoal: (ownerSessionId: string, spawnOpts) => spawnExperimentChildGoal({
				sessionManager,
				projectContextManager,
				verificationHarness,
				getSubgoalNestingPrefs: () => readSubgoalNestingPrefs((k) => preferencesStore.get(k)),
				broadcastToAll,
			}, ownerSessionId, spawnOpts),
			// Drop activation caches when a route persists provider config (host-owned).
			onStoreWrite: notePackStoreWrite,
		});
		// P3/P4 — managed-runtime context injection for pack ROUTES. Mirror the
		// LifecycleHub provider-hook path: if the routed pack has a provider declaring a
		// `runtime` linkage and its EFFECTIVE config selects a managed deployment mode,
		// resolve `ctx.runtime` from the supervisor WITHOUT starting Docker so the route
		// handlers reach the locally-running managed runtime (e.g. Hindsight status/recall).
		// External mode / no runtime / a stopped runtime ⇒ undefined, and the route stays
		// dormant via its own `isActive(cfg, ctx.runtime)` gate. Resolution failure is
		// non-fatal (the route just runs without runtime).
		let routeRuntime: RuntimeContext | undefined;
		try {
			const pack = packContributionRegistry.getPack(routeSessionProjectId, ident.packId);
			const runtimeProvider = pack?.providers.find((p) => typeof p.runtime === "string" && p.runtime.length > 0);
			if (runtimeProvider?.runtime) {
				routeRuntime = await resolveManagedRuntimeContext(packRuntimeSupervisor, {
					packId: ident.packId,
					runtimeId: runtimeProvider.runtime,
					projectId: routeSessionProjectId,
					config: runtimeProvider.config ?? {},
				});
			}
		} catch {
			routeRuntime = undefined; // non-fatal — the route runs without ctx.runtime
		}
		const start = Date.now();
		try {
			// The session working dir the confined worker uses as its process.cwd()
			// (tool parity — prefer the worktree path; fall back to the recorded cwd).
			const routeWorkingDir = routePs?.worktreePath ?? routePs?.cwd;
			const result = await routeDispatcher.dispatch(
				resolved.modulePath,
				resolved.packRoot,
				routeName,
				{ host, sessionId: guard.sessionId, toolUseId: toolUseId ?? "", tool: ident.contributionId, projectId: routeSessionProjectId, workingDir: routeWorkingDir, sessionArchived: routePs?.archived === true, ...(routeRuntime ? { runtime: routeRuntime } : {}) },
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

	// GET/POST /api/ext/pack-route/:packId/:routeName — SESSIONLESS admin access to a
	// BUILT-IN pack's route (Hindsight UX polish). The Marketplace must read built-in
	// Hindsight config/status, AND write Hindsight config, after `#/market` navigation
	// when there is no active chat session, so the surface-token path
	// (`/api/ext/surface-token` → `/api/ext/route`) 403s. This additive route serves
	// the SAME pack-level route module WITHOUT a bound session. It is narrowly scoped
	// so it cannot widen the extension threat model:
	//   • Admin-bearer only (gated before handleApiRoute) — the trusted app shell.
	//   • BUILT-IN first-party packs only — a same-realm third-party pack cannot use
	//     this sessionless seam to read or write another pack's route output.
	//   • GET → any route (pure read). POST → ALLOWLISTED to the `config` route name
	//     ONLY (the built-in config write); any other routeName under POST is rejected
	//     403, so this is NOT a general write seam — it is purely the GET seam's
	//     config-write sibling. The `config` route validates + persists to the pack
	//     store (CONFIG_INVALID for bad input) and returns the redacted effective
	//     config.
	// CRITICAL: this path NEVER starts Docker and works with NO session — POST only
	// persists config to the pack store. `ctx.runtime` is resolved WITHOUT starting
	// Docker (mirrors `/api/ext/route`), preserving the no-Docker-auto-start invariant.
	const packRouteMatch = url.pathname.match(/^\/api\/ext\/pack-route\/([^/]+)\/([^/]+)$/);
	if (packRouteMatch && (req.method === "GET" || req.method === "POST")) {
		const reqPackId = decodeURIComponent(packRouteMatch[1]);
		const routeName = decodeURIComponent(packRouteMatch[2]);
		const isWrite = req.method === "POST";
		const projectId = url.searchParams.get("projectId") || undefined;
		// POST is allowlisted to the `config` route ONLY — never a general write seam.
		if (isWrite && routeName !== "config") {
			json({ error: "sessionless pack-route writes are available only for the 'config' route" }, 403);
			return;
		}
		// Parse the JSON body for the config write. An empty body is rejected for POST
		// (a config write must carry overrides); malformed JSON is a 400 client error.
		let writeBody: Record<string, unknown> = {};
		if (isWrite) {
			const bodyText = await readBodyText(req);
			if (bodyText === null) { json({ error: "request body unreadable or too large" }, 400); return; }
			const trimmed = bodyText.trim();
			if (trimmed.length === 0) { json({ error: "config write requires a JSON body" }, 400); return; }
			try {
				const parsed = JSON.parse(trimmed);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
					json({ error: "config write body must be a JSON object" }, 400);
					return;
				}
				writeBody = parsed as Record<string, unknown>;
			} catch {
				json({ error: "config write body must be valid JSON" }, 400);
				return;
			}
		}
		// Restrict to BUILT-IN first-party packs (same enumeration the Installed list
		// uses to synthesise built-in rows), keyed by the STRUCTURAL packId.
		const builtinPackIds = new Set(
			builtinFirstPartyPackEntries(resolveBuiltinPacksDir())
				.filter((e) => e.manifest)
				.map((e) => packIdFromRoot(e.path)),
		);
		if (!builtinPackIds.has(reqPackId)) {
			json({ error: "sessionless pack-route access is available only to built-in packs" }, 403);
			return;
		}
		const resolved = routeRegistry.resolve(reqPackId, routeName, projectId);
		if (!resolved) {
			json({ error: `pack "${reqPackId}" declares no route "${routeName}"` }, 404);
			return;
		}
		const host = createServerHostApi({
			sessionId: "",
			toolUseId: undefined,
			packId: reqPackId,
			contributionId: "",
			packStore: getPackStore(),
			orchestrationCore,
			readChildStatus: (id: string) => sessionManager.getSession(id)?.status,
			onStoreWrite: notePackStoreWrite,
		});
		// Managed-runtime context injection (NO Docker start) — mirror `/api/ext/route`.
		let packRouteRuntime: RuntimeContext | undefined;
		try {
			const pack = packContributionRegistry.getPack(projectId, reqPackId);
			const runtimeProvider = pack?.providers.find((p) => typeof p.runtime === "string" && p.runtime.length > 0);
			if (runtimeProvider?.runtime) {
				packRouteRuntime = await resolveManagedRuntimeContext(packRuntimeSupervisor, {
					packId: reqPackId,
					runtimeId: runtimeProvider.runtime,
					projectId,
					config: runtimeProvider.config ?? {},
				});
			}
		} catch {
			packRouteRuntime = undefined; // non-fatal — the route runs without ctx.runtime
		}
		const start = Date.now();
		try {
			const result = await routeDispatcher.dispatch(
				resolved.modulePath,
				resolved.packRoot,
				routeName,
				{ host, sessionId: "", toolUseId: "", tool: "", projectId, ...(packRouteRuntime ? { runtime: packRouteRuntime } : {}) },
				isWrite ? { method: "POST", body: writeBody } : { method: "GET" },
			);
			console.log(`[ext-pack-route] name=${routeName} packId=${reqPackId} method=${isWrite ? "POST" : "GET"} sessionless outcome=ok durationMs=${Date.now() - start}`);
			json(result ?? null);
		} catch (err) {
			const status = err instanceof ActionError ? err.status : 500;
			const message = err instanceof Error ? err.message : String(err);
			console.warn(`[ext-pack-route] name=${routeName} packId=${reqPackId} sessionless outcome=error(${status}) durationMs=${Date.now() - start}: ${message}`);
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
		const destDir = path.join(targetToolsDir, groupDir);

		if (!fs.existsSync(srcDir)) { json({ error: "Source tool group not found" }, 404); return; }

		// Copy entire group directory (recursively handles nested files)
		copyDirRecursive(srcDir, destDir);

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

	// /api/tool-group-policies* and /api/config/cwd moved to the core route
	// registry (STR-01 cohort 18) — see src/server/routes/host-config-routes.ts
	// and docs/design/route-registry.md.

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

	// /api/agent-dir* moved to the core route registry (STR-01 cohort 18) —
	// see src/server/routes/host-config-routes.ts and
	// docs/design/route-registry.md.

	function firstHeader(name: string): string | undefined {
		const value = req.headers[name.toLowerCase()];
		const str = Array.isArray(value) ? value[0] : value;
		return typeof str === "string" && str.length > 0 ? str : undefined;
	}

	function hasSessionBoundHeaders(): boolean {
		return Boolean(
			firstHeader("x-bobbit-session-id")
			|| firstHeader("x-bobbit-session-secret")
			|| firstHeader("x-bobbit-spawning-session"),
		);
	}

	function isHumanOperatorRequest(): boolean {
		return Boolean(
			cookieStore
			&& cookieTryAuth(req, cookieStore, { operator: true })
			&& !sandboxScope
			&& !hasSessionBoundHeaders()
			&& !firstHeader("authorization"),
		);
	}

	function claudeCodeConfirmationBinding(patch: Record<string, unknown>): { requiresConfirmation: boolean; keys: string[]; binding: string } {
		const sensitive = sensitiveClaudeCodePreferenceMutation(patch);
		return {
			requiresConfirmation: sensitive.requiresConfirmation,
			keys: sensitive.keys,
			binding: stableConfirmationBinding({ values: sensitive.values }),
		};
	}

	// POST /api/auth/operator-elevate — upgrade the caller's bobbit_session cookie to an
	// operator-capable one. This is the ONLY operator-elevation path in --auth mode.
	//
	// Why it exists: operator-capable cookies are otherwise minted solely by the
	// credential-free localhost /api/health bootstrap. In --auth mode that branch never
	// runs and bearer/query-token traffic deliberately receives operator:false cookies,
	// so a human browser on an authed deployment had NO path to operator confirmations
	// (inherited from the original 58071877/01489efb design, whose tests only exercised
	// the happy path with forceAuth:false).
	//
	// Security invariants preserved (mirror isHumanOperatorRequest and the pinned
	// negative tests in tests/e2e/claude-code-status-api.spec.ts):
	// - Session-bound traffic (X-Bobbit-Session-*/X-Bobbit-Spawning-Session) can never
	//   elevate — hard 403 regardless of credentials.
	// - Sandbox-scoped tokens can never elevate — the sandbox route guard default-denies
	//   this path before dispatch, and we re-check here for defense in depth.
	// - Generic bearer/API traffic still receives operator:false cookies everywhere else;
	//   elevation only happens on this explicit, deliberate POST which additionally
	//   requires the ADMIN token itself in --auth mode (an operator:false cookie alone —
	//   e.g. one replayed from a preview iframe context — is NOT sufficient).
	// The operator:true cookie replaces a non-operator cookie via issueIfMissing's
	// re-issue semantics (pinned by tests/preview-cookie.test.ts).
	if (url.pathname === "/api/auth/operator-elevate" && req.method === "POST") {
		if (sandboxScope) {
			json({ error: "Sandbox-scoped tokens cannot elevate to operator" }, 403);
			return;
		}
		if (hasSessionBoundHeaders()) {
			json({ error: "Session-bound callers cannot elevate to operator" }, 403);
			return;
		}
		const isLocalhostMode = !config.forceAuth && (config.host === "localhost" || config.host === "127.0.0.1" || config.host === "::1");
		if (!isLocalhostMode) {
			const authHeader = firstHeader("authorization");
			const presentedToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : url.searchParams.get("token");
			if (!presentedToken || !validateToken(presentedToken, config.authToken)) {
				json({ error: "Operator elevation requires the admin token" }, 403);
				return;
			}
		}
		issueCookieIfMissing(req, res, cookieStore!, { localhost: isLocalhostMode, operator: true });
		json({ ok: true, operator: true });
		return;
	}

	// /api/preferences and /api/preferences/claude-code/confirmation moved to
	// the core route registry (STR-01 cohort 12) — see
	// src/server/routes/preferences-routes.ts (which also carries the S5
	// pack-attributed-write gate, docs/design/pack-settings-contribution.md §4.3)
	// and docs/design/route-registry.md.

	// GET /api/project-config, GET /api/project-config/defaults, and (below)
	// PUT /api/project-config moved to the core route registry (STR-01
	// cohort 4) — see src/server/routes/project-config-server-routes.ts and
	// docs/design/route-registry.md.

	// /api/config-directories* moved to the core route registry (STR-01
	// cohort 13) — see src/server/routes/config-directories-routes.ts and
	// docs/design/route-registry.md.

	// ── Pack-Based Marketplace (design §9 / §9.1 / §9.2) ──────────────
	// GET/POST/PUT/DELETE/PATCH /api/marketplace/* (sources, browse, install/
	// update/uninstall, pack-order, pack-activation, mcp-operation toggles,
	// purge-runtime) and GET /api/packs/conflicts moved to the core route
	// registry (STR-01 cohort 2) — see src/server/routes/marketplace-routes.ts
	// and docs/design/route-registry.md. Upstream's HQ Split (#932) changed the
	// "server" scope base for pack-runtime-context/activation-catalogue lookups
	// from getProjectRoot() to headquartersDir(); ported into
	// marketplace-routes.ts's resolvePackRuntimeContext/buildActivationCatalogue
	// rather than reintroduced here.

	// PUT /api/project-config moved to the core route registry (STR-01
	// cohort 4) — see src/server/routes/project-config-server-routes.ts and
	// docs/design/route-registry.md.

	// Model/provider settings routes moved to the core route registry (STR-01 cohort 15) — see
	// src/server/routes/model-provider-routes.ts and docs/design/route-registry.md.
	// The raw AIGW proxy remains inline below because it intentionally preserves
	// method-agnostic streaming behavior through req/res.

	// Proxy: /api/aigw/v1/* → forward to configured aigw URL
	if (url.pathname.startsWith("/api/aigw/v1/") && getAigwUrl(preferencesStore)) {
		const aigwUrl = getAigwUrl(preferencesStore)!;
		const subPath = url.pathname.replace("/api/aigw/v1/", "/v1/");
		const targetUrl = `${aigwUrl}${subPath}${url.search}`;
		proxyRequest(targetUrl, req, res);
		return;
	}

	// /api/roles* moved to the core route registry (STR-05) — see
	// src/server/routes/roles-routes.ts and docs/design/route-registry.md.

	// ── Task endpoints ─────────────────────────────────────────────

	// GET/POST /api/goals/:goalId/tasks moved to the core route registry
	// (STR-01 goals cohort G1) — see src/server/routes/goal-read-routes.ts.

	// ── Gate endpoints ─────────────────────────────────────────────

	// GET /api/goals/:goalId/gates and GET /api/goals/:goalId/gates/:gateId
	// moved to the core route registry (STR-01 goals cohort G1) — see
	// src/server/routes/goal-read-routes.ts.

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
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (goal.archived) { json({ error: "Goal is archived" }, 409); return; }
		if (!goal.workflow) { json({ error: "Goal has no workflow" }, 400); return; }

		const gateResetCtx = projectContextManager.getContextForGoal(goalId);
		if (!gateResetCtx) { json({ error: "Goal not found in any project" }, 404); return; }
		const gateStore = gateResetCtx.gateStore;
		const requestedGateDef = goal.workflow.gates.find(g => g.id === gateId);
		if (!requestedGateDef) { json({ error: `Unknown gate: ${gateId}` }, 404); return; }

		const affectedGateIds = getGateAndTransitiveDependents(goal.workflow, gateId);
		try {
			await verificationHarness.cancelStaleVerificationsForGates(goalId, affectedGateIds);
		} catch (err) {
			console.error(`[api] Error cancelling verifications for reset gates ${affectedGateIds.join(", ")}:`, err);
		}

		let resetResult: GateResetResult;
		try {
			resetResult = gateStore.resetGateAndDependents(goalId, gateId, goal.workflow);
		} catch (err: any) {
			json({ error: err?.message || `Unknown gate: ${gateId}` }, 404);
			return;
		}

		const affectedGates = resetResult.affectedGateIds.map(affectedGateId => {
			const def = goal.workflow!.gates.find(g => g.id === affectedGateId);
			const state = gateStore.getGate(goalId, affectedGateId);
			return {
				gateId: affectedGateId,
				name: def?.name || affectedGateId,
				status: state?.status || "pending",
			};
		});

		for (const gate of affectedGates) {
			broadcastToGoal(goalId, { type: "gate_status_changed", goalId, gateId: gate.gateId, status: gate.status });
		}
		broadcastToGoal(goalId, {
			type: "gate_reset",
			goalId,
			gateId,
			affectedGateIds: resetResult.affectedGateIds,
			changedGateIds: resetResult.changedGateIds,
			unchangedGateIds: resetResult.unchangedGateIds,
		});

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
		const team = teamManager.getTeamState(goalId);
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

		json({
			ok: true,
			gateId,
			affectedGateIds: resetResult.affectedGateIds,
			changedGateIds: resetResult.changedGateIds,
			unchangedGateIds: resetResult.unchangedGateIds,
			previousStatuses: resetResult.previousStatuses,
			gates: affectedGates,
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

		broadcastToGoal(goalId, { type: "gate_status_changed", goalId, gateId, status: "bypassed" });

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
		// Manual reset preserves signal history for auditability, so this route-level
		// fast path must honor the same reset cache boundary as VerificationHarness.
		// Human sign-offs are never reusable consent; let the harness run them again.
		if (commitSha !== "unknown") {
			const existingGateForCache = gateStore.getGate(goalId, gateId);
			if (existingGateForCache) {
				const cacheInvalidatedAt = existingGateForCache.verificationCacheInvalidatedAt;
				const incomingContent = typeof body?.content === "string" ? body.content : "";
				const priorPassed = existingGateForCache.signals.find(s =>
					s.commitSha === commitSha
					&& ((typeof s.content === "string" ? s.content : "") === incomingContent)
					&& s.verification?.status === "passed"
					&& (cacheInvalidatedAt === undefined || s.timestamp > cacheInvalidatedAt)
					&& !s.verification.steps.some(step => step.type === "human-signoff")
				);
				if (priorPassed?.verification) {
					const phaseByStepName = new Map((gateDef.verify || []).map((s: any) => [s.name, s.phase ?? 0]));
					const cachedSteps = priorPassed.verification.steps.map((s: any) => {
						const status = s.skipped ? "skipped" : (s.status ?? (s.passed ? "passed" : "failed"));
						return {
							...s,
							status,
							...(status === "skipped" ? { skipped: true } : {}),
							phase: s.phase ?? phaseByStepName.get(s.name) ?? 0,
							output: `[cached from prior signal] ${s.output}`,
						};
					});
					// Create a signal record with cached results
					const cachedSignal = {
						id: randomUUID(),
						gateId,
						goalId,
						sessionId: body?.sessionId || "unknown",
						timestamp: Date.now(),
						commitSha,
						metadata: body?.metadata,
						content: body?.content,
						contentVersion: body?.content ? (existingGateForCache.currentContentVersion || 0) + 1 : undefined,
						verification: {
							status: "passed" as const,
							steps: cachedSteps,
						},
					};
					gateStore.recordSignal(cachedSignal);
					if (body?.content && cachedSignal.contentVersion) {
						gateStore.updateGateContent(goalId, gateId, body.content, cachedSignal.contentVersion);
					}
					if (body?.metadata) {
						gateStore.updateGateMetadata(goalId, gateId, body.metadata);
					}
					gateStore.updateGateStatus(goalId, gateId, "passed");
					broadcastToGoal(goalId, { type: "gate_signal_received", goalId, gateId, signalId: cachedSignal.id });
					broadcastToGoal(goalId, { type: "gate_verification_complete", goalId, gateId, signalId: cachedSignal.id, status: "passed" });
					broadcastToGoal(goalId, { type: "gate_status_changed", goalId, gateId, status: "passed" });
					const verifySteps = cachedSignal.verification.steps.map((s: any) => ({
						name: s.name,
						type: s.type,
						status: s.status,
						passed: s.passed,
						skipped: s.skipped,
						phase: s.phase,
						duration_ms: s.duration_ms,
						output: s.output,
					}));
					json({ signal: { id: cachedSignal.id, gateId, goalId, status: "passed", steps: verifySteps, cached: true } }, 201);
					return;
				}
			}
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
						broadcastToGoal(goalId, { type: "gate_status_changed", goalId, gateId: g.id, status: downstream.status });
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
		const primary = configuredBase.branch || (await detectPrimaryBranch(branchContainer).catch(() => "master"));
		verificationHarness.verifyGateSignal(
			signal, gateDef, branchContainer, goal.branch, primary, allGateStates, goal.spec,
		).catch(err => console.error("[verification] Gate signal error:", err));

		const verifySteps = initialSteps.map((s: any) => ({
			name: s.name,
			type: s.type,
			status: s.status,
			passed: s.passed,
			skipped: s.skipped,
			phase: s.phase,
			duration_ms: s.duration_ms,
			output: s.output,
		}));
		const signalResponse = { id: signal.id, gateId, goalId, status: "running", steps: verifySteps };
		const response: { signal: typeof signalResponse; agentReminder?: string } = { signal: signalResponse };
		if (verificationHarness.getActiveVerification(signal.id)?.overallStatus === "running") {
			response.agentReminder = "Gate signal accepted. Verification is running asynchronously. Do not poll with `gate_status` or `gate_inspect`. Go idle now and wait for the server to deliver verification results or further instructions.";
		}
		json(response, 201);
		return;
	}

	// GET /api/goals/:goalId/gates/:gateId/signals and
	// GET /api/goals/:goalId/verifications/active moved to the core route
	// registry (STR-01 goals cohort G1) — see src/server/routes/goal-read-routes.ts.

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

	// GET /api/goals/:goalId/gates/:gateId/content moved to the core route
	// registry (STR-01 goals cohort G1) — see src/server/routes/goal-read-routes.ts.

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

	// /api/tasks/:id, /api/tasks/:id/assign, and /api/tasks/:id/transition
	// moved to the core route registry (STR-01 cohort 27) — see
	// src/server/routes/tasks-routes.ts.

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
				const remoteHead = await execGit("git symbolic-ref refs/remotes/origin/HEAD", goal.cwd);
				primaryBranch = remoteHead.replace("refs/remotes/origin/", "");
			} catch {
				try { await execGit("git rev-parse --verify refs/heads/master", goal.cwd); primaryBranch = "master"; }
				catch { try { await execGit("git rev-parse --verify refs/heads/main", goal.cwd); primaryBranch = "main"; } catch { /* keep default */ } }
			}

			let rangeSpec = `-${limit} ${branch}`;
			if (branch !== primaryBranch && branch !== "HEAD") {
				let primaryRef = primaryBranch;
				try { await execGit(`git rev-parse --verify origin/${primaryBranch}`, goal.cwd); primaryRef = `origin/${primaryBranch}`; } catch { /* use local */ }
				try { await execGit(`git rev-parse ${primaryRef}`, goal.cwd); rangeSpec = `-${limit} ${primaryRef}..${branch}`; } catch { /* fall back */ }
			}

			const out = await execGit(`git log --format="${COMMIT_LOG_FORMAT}" --shortstat ${rangeSpec}`, goal.cwd);
			const commits = await attachCommitFiles(parseCommitLogWithShortstat(out), goal.cwd);
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
			const diff = await getGitDiff(diffCwd, file, cid, commit);
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
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ available: false, reason: "goal-not-found" } satisfies GoalGithubLinkResponse); return; }
		if (!hasGoalGitWorktree(goal)) { json({ available: false, reason: "no-worktree", message: noWorktreeGoalGitMessage(goal) } satisfies GoalGithubLinkResponse); return; }

		const cached = prStatusStore.get(goalId);
		if (cached?.url) {
			json({ available: true, kind: "pr", url: cached.url } satisfies GoalGithubLinkResponse);
			return;
		}

		if (goal.branch && fs.existsSync(goal.cwd)) {
			const fresh = await getCachedPrStatus(goal.cwd, goal.branch, process.cwd()).catch(() => null);
			if (fresh?.url) {
				prStatusStore.set(goalId, fresh);
				json({ available: true, kind: "pr", url: fresh.url } satisfies GoalGithubLinkResponse);
				return;
			}
		}

		if (!goal.branch) { json({ available: false, reason: "no-branch" } satisfies GoalGithubLinkResponse); return; }

		const remoteCwd = goal.repoPath || goal.cwd;
		try {
			const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
				cwd: remoteCwd,
				encoding: "utf-8",
				timeout: 5_000,
			});
			const branchUrl = buildGithubBranchUrl(stripTokenFromGitUrl(stdout.trim()), goal.branch);
			if (!branchUrl) { json({ available: false, reason: "no-github-remote" } satisfies GoalGithubLinkResponse); return; }
			json({ available: true, kind: "branch", url: branchUrl } satisfies GoalGithubLinkResponse);
		} catch {
			json({ available: false, reason: "no-github-remote" } satisfies GoalGithubLinkResponse);
		}
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
			await execFileAsync("gh", buildGhPrMergeArgs(resolvedGoalBranch, method, body?.admin), { cwd, encoding: "utf-8", timeout: 30000 });
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

	// DELETE/PATCH /api/sessions/:id, POST /api/sessions/:id/{fork,continue,
	// mark-read,generate-title}, GET /api/sessions/:id/{children-count,output},
	// and PUT /api/sessions/:id/title moved to the core route registry
	// (STR-01 cohort 21) — see src/server/routes/session-mutation-routes.ts
	// and docs/design/route-registry.md.

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
		try {
			const result = await deliverSessionPrompt({
				getSession: (id) => sessionManager.getSession(id),
				enqueuePrompt: (id, text, opts) => sessionManager.enqueuePrompt(id, text, opts),
				deliverLiveSteer: (id, text, opts) => sessionManager.deliverLiveSteer(id, text, opts),
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

	// POST /api/sessions/:id/notify — enqueue a system-sourced notification into
	// a session's prompt queue. Session-auth only (normal handleApiRoute gate;
	// no new auth surface — unlike /prompt above, this is a client→server call,
	// not agent→agent, so it does not require a caller session secret).
	//
	// Client caller: api.ts::notifyProposalDecision(), invoked by
	// session-manager.ts after the user accepts/rejects a registered proposal
	// (project/goal/role/tool/staff) — tells the proposing agent the outcome so
	// it can continue (or retry) instead of silently stalling. Was a half-landed
	// feature: the client call landed in #714 but this route never existed
	// (W2.G(a) forensics finding) — the POST 404'd silently until now.
	const notifyMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/notify$/);
	if (notifyMatch && req.method === "POST") {
		const notifySessionId = notifyMatch[1];
		const notifyBody = await readBody(req);
		if (typeof notifyBody?.message !== "string" || !notifyBody.message.trim()) {
			json({ error: "message is required" }, 400);
			return;
		}
		const MAX_NOTIFY_MESSAGE_LENGTH = 10_000;
		if (notifyBody.message.length > MAX_NOTIFY_MESSAGE_LENGTH) {
			json({ error: `message exceeds maximum length of ${MAX_NOTIFY_MESSAGE_LENGTH} characters` }, 400);
			return;
		}
		const notifySession = sessionManager.getSession(notifySessionId);
		if (!notifySession) { json({ error: "Session not found" }, 404); return; }
		try {
			// Mirrors the gate-reset/gate-bypass team-lead notification pattern
			// above: live-steer a streaming session, else enqueue as a queued
			// system-sourced prompt.
			if (notifySession.status === "streaming") {
				await sessionManager.deliverLiveSteer(notifySessionId, notifyBody.message, { source: "system" });
			} else {
				await sessionManager.enqueuePrompt(notifySessionId, notifyBody.message, { isSteered: true, source: "system" });
			}
			json({ ok: true });
		} catch (err) {
			jsonError(500, err);
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

	// Editable proposal REST endpoints moved to the core route registry
	// (STR-01 cohort 17) — see src/server/routes/session-proposal-routes.ts
	// and docs/design/route-registry.md.

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

	// STR-01 cohort 11: OAuth account routes moved to
	// src/server/routes/oauth-account-routes.ts.

	// Session content/readback routes moved to the core route registry
	// (STR-01 cohort 25) — see src/server/routes/session-content-routes.ts.

	// GET /api/sessions/:id/{git-status,git-diff,commits,pr-status}
	// moved to the core route registry (STR-01 cohort 23) —
	// see src/server/routes/session-git-read-routes.ts.
	// POST /api/sessions/:id/{git-pull,git-push,git-squash-push,git-merge-primary,pr-merge}
	// moved to the core route registry (STR-01 cohort 24) — see
	// src/server/routes/session-git-write-routes.ts.

	// GET /api/slash-skills, GET /api/file-mentions, and
	// GET /api/slash-skills/details moved to the core route registry
	// (STR-01 cohort 26) — see src/server/routes/prompt-autocomplete-routes.ts.

	// Cost endpoints moved to the core route registry (STR-01 cohort 16a) —
	// see src/server/routes/cost-routes.ts and docs/design/route-registry.md.

	// Preview mount/artifact/SSE endpoints moved to the core route registry
	// (STR-01 cohort 16b) — see src/server/routes/preview-routes.ts and
	// docs/design/route-registry.md.

	// GET /api/internal/orient — self-description ("whoami") for the `orient`
	// tool (Finding W2.15). Read-only assembly of state the gateway already
	// holds; see src/server/agent/orient.ts for the payload shape + rationale.
	if (url.pathname === "/api/internal/orient" && req.method === "GET") {
		try {
			const orientSessionId = req.headers["x-bobbit-session-id"] as string | undefined;
			if (!orientSessionId) {
				json({ error: "Missing X-Bobbit-Session-Id header" }, 403);
				return;
			}
			const liveSession = sessionManager.getSession(orientSessionId);
			const ctx = projectContextManager.getContextForSession(orientSessionId);
			const persistedSession = liveSession ? undefined : ctx?.sessionStore.get(orientSessionId);
			const sessionRecord = liveSession ?? persistedSession;
			if (!sessionRecord) {
				json({ error: `Session "${orientSessionId}" not found` }, 403);
				return;
			}

			const orientSession: OrientSessionInput = liveSession
				? {
						id: liveSession.id,
						title: liveSession.title,
						status: liveSession.status,
						cwd: liveSession.cwd,
						worktreePath: liveSession.worktreePath,
						role: liveSession.role,
						assistantType: liveSession.assistantType,
						sandboxed: liveSession.sandboxed,
						containerId: liveSession.containerId,
						model: liveSession.spawnPinnedModel,
						thinkingLevel: liveSession.spawnPinnedThinkingLevel,
						readOnly: liveSession.readOnly,
						delegateOf: liveSession.delegateOf,
						parentSessionId: liveSession.parentSessionId,
						childKind: liveSession.childKind,
						projectId: liveSession.projectId,
						goalId: liveSession.goalId,
						teamGoalId: liveSession.teamGoalId,
						teamLeadSessionId: liveSession.teamLeadSessionId,
					}
				: {
						id: persistedSession!.id,
						title: persistedSession!.title,
						status: "dormant",
						cwd: persistedSession!.cwd,
						worktreePath: persistedSession!.worktreePath,
						role: persistedSession!.role,
						assistantType: persistedSession!.assistantType,
						sandboxed: persistedSession!.sandboxed,
						model: persistedSession!.modelProvider && persistedSession!.modelId
							? `${persistedSession!.modelProvider}/${persistedSession!.modelId}`
							: undefined,
						readOnly: persistedSession!.readOnly,
						delegateOf: persistedSession!.delegateOf,
						parentSessionId: persistedSession!.parentSessionId,
						childKind: persistedSession!.childKind,
						projectId: persistedSession!.projectId,
						goalId: persistedSession!.goalId,
						teamGoalId: persistedSession!.teamGoalId,
						teamLeadSessionId: persistedSession!.teamLeadSessionId,
					};

			const goalRecord = orientSession.goalId ? ctx?.goalStore.get(orientSession.goalId) : undefined;
			const project = orientSession.projectId ? projectRegistry.get(orientSession.projectId) : undefined;

			let gatewayUrl = "";
			try {
				gatewayUrl = process.env.BOBBIT_GATEWAY_URL || fs.readFileSync(path.join(bobbitStateDir(), "gateway-url"), "utf-8").trim();
			} catch { /* not started via cli.ts yet (e.g. some test harnesses) */ }

			const payload = buildOrientPayload({
				gateway: {
					version: bobbitPackageVersion,
					url: gatewayUrl,
					tokenPath: path.join(bobbitStateDir(), "token"),
				},
				session: orientSession,
				goal: goalRecord
					? {
							id: goalRecord.id,
							title: goalRecord.title,
							state: goalRecord.state,
							branch: goalRecord.branch,
							team: goalRecord.team,
							teamLeadSessionId: goalRecord.teamLeadSessionId,
							parentGoalId: goalRecord.parentGoalId,
						}
					: null,
				project: project ? { id: project.id, name: project.name, rootPath: project.rootPath } : null,
			});
			json(payload);
		} catch (err) {
			const e = err as Error;
			console.error(`[orient] Self-description failed:`, e.stack || e);
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
			json({ error: "No pending verification for this session" }, 404);
			return;
		}
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
			findings: sanitizeVerificationFindings(body.findings),
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
			messages = await loadHydratedMessagesForAskSubmit(sessionManager, sessionId, session);
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
		const matchedQuestions = findAskUserChoicesQuestions(messages, toolUseId);
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

	json({ error: "Not found" }, 404);
}

/**
 * Validate a goal proposal's `workflow` / `inlineWorkflow` / `options` args.
 * Returns a structured error object to send as 400, or null if valid. Pure —
 * caller resolves the workflow list (see seed handler).
 *
 * Rules (see docs/design — Validate goal workflow):
 * - A structurally valid `inlineWorkflow` is a bespoke snapshot and takes
 *   precedence over any `workflow` id. It satisfies the project workflow
 *   requirement and `options` are validated against the inline snapshot.
 * - A malformed `inlineWorkflow` fails structurally before project-workflow
 *   validation so it never degrades into MISSING_WORKFLOW/UNKNOWN_WORKFLOW.
 * - Without `inlineWorkflow`, zero project workflows ⇒ no validation.
 * - Without `inlineWorkflow`, empty/omitted `workflow` ⇒ MISSING_WORKFLOW when
 *   workflows are available.
 * - Without `inlineWorkflow`, an explicit `workflow` not among the configured
 *   ids ⇒ UNKNOWN_WORKFLOW.
 * - `options` are comma-separated optional-step names matched ONLY by canonical
 *   `verify[].name` where `optional: true`. The runtime (verification-logic.ts)
 *   and UI both key on step.name, so accepting optionalLabel/label would be a
 *   false-success path that later fails to enable the step.
 */
function validateGoalProposalWorkflow(
	args: Record<string, unknown>,
	workflows: Workflow[],
): { ok: false; code: string; message: string; availableWorkflows?: { id: string; name: string }[]; validOptionalSteps?: string[] } | null {
	const inlineWorkflow = args.inlineWorkflow;
	if (inlineWorkflow !== undefined && inlineWorkflow !== null) {
		const inlineErr = validateGoalInlineWorkflow(inlineWorkflow);
		if (inlineErr) return inlineErr;
		return validateGoalProposalOptions(args, inlineWorkflow as Workflow);
	}

	if (workflows.length === 0) return null;

	const wfArg = typeof args.workflow === "string" ? args.workflow.trim() : "";
	const available = workflows.map(w => ({ id: w.id, name: w.name }));
	const availableIds = available.map(w => w.id).join(", ");

	// 1. Workflow id is required when this session has resolvable workflows.
	if (!wfArg) {
		return {
			ok: false,
			code: "MISSING_WORKFLOW",
			message: `Workflow is required for this project. Re-call propose_goal with one of these workflow IDs: ${availableIds}.`,
			availableWorkflows: available,
		};
	}

	// 2. Unknown explicit workflow id.
	const chosen = workflows.find(w => w.id === wfArg);
	if (!chosen) {
		return {
			ok: false,
			code: "UNKNOWN_WORKFLOW",
			message: `Unknown workflow "${wfArg}". Available workflows for this project: ${availableIds}. Re-call propose_goal with one of these IDs.`,
			availableWorkflows: available,
		};
	}

	// 3. Validate optional-step names against the chosen explicit workflow.
	return validateGoalProposalOptions(args, chosen);
}

function validateGoalProposalOptions(
	args: Record<string, unknown>,
	workflow: Workflow,
): { ok: false; code: "UNKNOWN_OPTIONAL_STEP"; message: string; validOptionalSteps: string[] } | null {
	const optsArg = typeof args.options === "string" ? args.options : "";
	const requested = optsArg.split(",").map(s => s.trim()).filter(Boolean);
	if (requested.length === 0) return null;

	const validNames = new Set<string>();
	for (const g of workflow.gates) {
		for (const s of (g.verify ?? [])) {
			// Only the canonical step.name is a valid enable key (runtime + UI both
			// match on name); accepting optionalLabel/label would be a false success.
			if (s.optional === true) validNames.add(s.name);
		}
	}
	const validList = [...validNames];
	const unknown = requested.filter(n => !validNames.has(n));
	if (unknown.length === 0) return null;
	return {
		ok: false,
		code: "UNKNOWN_OPTIONAL_STEP",
		message: `Unknown optional step(s) [${unknown.join(", ")}] for workflow "${workflow.id}". Valid optional steps: ${validList.length ? validList.join(", ") : "(none)"}.`,
		validOptionalSteps: validList,
	};
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

/**
 * Read the raw request body as text (no JSON parse). Handlers that must
 * distinguish an EMPTY body (valid — e.g. default-mode start) from a MALFORMED
 * one (400) read this instead of {@link readBody}. Resolves null on an oversized
 * / aborted / errored stream.
 */
export function readBodyText(
	req: http.IncomingMessage,
	maxBytes: number = MAX_REQUEST_BODY_BYTES,
): Promise<string | null> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let total = 0;
		let settled = false;
		const finish = (value: string | null): void => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		req.on("data", (chunk: Buffer) => {
			if (settled) return;
			total += chunk.length;
			if (total > maxBytes) {
				// Oversized body: reject BEFORE Buffer.concat() so a huge payload is
				// never fully materialised in memory. Drop buffered chunks, tear down
				// the stream, and resolve null — handlers treat a null body as a
				// malformed request (400); the request-handler's Content-Length
				// precheck returns a definitive 413 when the length is declared up front.
				chunks.length = 0;
				try { req.destroy(); } catch { /* best-effort */ }
				finish(null);
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => finish(Buffer.concat(chunks).toString()));
		req.on("error", () => finish(null));
		req.on("aborted", () => finish(null));
	});
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
