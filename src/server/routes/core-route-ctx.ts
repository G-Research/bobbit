// src/server/routes/core-route-ctx.ts
//
// STR-01: the shared per-request context handed to every core (non-pack)
// registry-migrated route handler. See docs/design/route-registry.md.
//
// Deliberately data-only (no imports back from server.ts — see that doc's
// "avoiding the server.ts import cycle" section): every field is either a
// leaf-module type or a plain function reference built fresh inside
// `handleApiRoute` for each request from state it already has in scope
// (mirrors the existing delegate-route-module pattern in
// e.g. src/server/agent/nested-goal-routes.ts's `NestedGoalRouteDeps`).
//
// Grow this interface as later cohorts need more; cohort 1 (projects) only
// needed the fields below.

import type http from "node:http";
import type { SessionManager } from "../agent/session-manager.js";
import type { ProjectRegistry, RegisteredProject } from "../agent/project-registry.js";
import type { ProjectContextManager } from "../agent/project-context-manager.js";
import type { ProjectContext } from "../agent/project-context.js";
import type { ProjectConfigStore } from "../agent/project-config-store.js";
import type { ConfigCascade } from "../agent/config-cascade.js";
import type { MarketplaceInstaller } from "../agent/marketplace-install.js";
import type { MarketplaceSourceStore } from "../agent/marketplace-source-store.js";
import type { McpReloadResult } from "../mcp/mcp-manager.js";
import type { InstallScope } from "../agent/marketplace-install.js";
import type { PackRuntimeStatus, PackRuntimeCapabilitySummary } from "../runtimes/index.js";
import type { PackEntry } from "../agent/pack-types.js";
import type { SkillMarketContext } from "../skills/slash-skills.js";
import type { ResolvedPiExtensionContribution, PiExtensionDiagnostic } from "../agent/session-setup.js";
import type { StaffManager } from "../agent/staff-manager.js";
import type { InboxManager } from "../agent/inbox-manager.js";
import type { PackContributionRegistry } from "../extension-host/pack-contribution-registry.js";
import type { ReviewAnnotationStore } from "../review-annotation-store.js";
import type { BgProcessManager } from "../agent/bg-process-manager.js";
import type { ToolManager } from "../agent/tool-manager.js";
import type { ToolGroupPolicyStore } from "../agent/tool-group-policy-store.js";
import type { Role, RoleStore } from "../agent/role-store.js";
import type { RoleManager } from "../agent/role-manager.js";
import type { PreferencesStore } from "../agent/preferences-store.js";
import type { SandboxManager } from "../agent/sandbox-manager.js";
import type { SandboxScope } from "../auth/sandbox-token.js";
import type { SandboxTokenStore } from "../auth/sandbox-token.js";
import type { ResolvedProject } from "../agent/resolve-project.js";
import type { CwdValidationResult } from "../agent/resolve-project.js";
import type { TsServerSupervisor } from "../lsp/supervisor.js";
import type { PersistedGoal } from "../agent/goal-store.js";
import type { TaskManager } from "../agent/task-manager.js";
import type { Workflow } from "../agent/workflow-store.js";
import type { ColorStore } from "../agent/color-store.js";
import type { GoalManager } from "../agent/goal-manager.js";
import type { PrStatusStore } from "../agent/pr-status-store.js";
import type { VerificationHarness } from "../agent/verification-harness.js";
import type { TeamManager } from "../agent/team-manager.js";
import type { PersistedTask } from "../agent/task-store.js";
import type { CookieStore } from "../auth/cookie.js";
import type { ExtensionChannelServices } from "../agent/session-manager.js";
import type { OrchestrationCore } from "../agent/orchestration-core.js";
import type { RuntimeContext } from "../agent/lifecycle-hub.js";
import type { ToolManager as ExtensionToolManager } from "../agent/tool-manager.js";
import type { ActionGuardSession } from "../extension-host/action-guard.js";
import type { RouteDispatcher, RouteRegistry } from "../extension-host/route-dispatcher.js";
/**
 * Structural copy of server.ts's own `PackRuntimeSupervisorLike` (defined
 * there, not in a leaf module — it can't be imported here without recreating
 * the server.ts import cycle this file exists to avoid). A pure interface
 * shape, not logic: the two are kept in sync by TypeScript itself — any
 * divergence between this copy and server.ts's is a structural-assignability
 * compile error at the `coreCtx` construction site in `handleApiRoute`, not a
 * silent behavioral drift.
 */
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

export type RequiredConfigProjectScope = {
	ok: true;
	requestedProjectId: string;
	effectiveProjectId?: string;
	context?: ProjectContext;
};

export type RequiredConfigProjectScopeError = {
	ok: false;
	status: 400 | 404;
	error: string;
	code: string;
};

export interface CoreRouteCtx {
	req: http.IncomingMessage;
	res: http.ServerResponse;
	url: URL;

	/** Per-request response helpers (bound to `res`; identical to the legacy inline closures). */
	json(data: unknown, status?: number): void;
	jsonError(status: number, err: unknown, extra?: Record<string, unknown>): void;
	readBody(req: http.IncomingMessage): Promise<any>;

	sessionManager: SessionManager;
	projectRegistry: ProjectRegistry;
	projectContextManager: ProjectContextManager;
	broadcastToAll(event: unknown): void;

	// Small per-request closures already defined once in handleApiRoute and
	// shared with not-yet-migrated legacy routes — passed through by
	// reference rather than duplicated or imported back from server.ts.
	isHeadquartersOwnedPath(candidatePath: string): boolean;
	listProjectsForApi(): RegisteredProject[];
	writeSpecialProjectMutationError(err: unknown): boolean;
	headquartersProject(): RegisteredProject | undefined;

	// Pure module-level helpers in server.ts that are ALSO still called by
	// not-yet-migrated legacy routes (so they stay defined once, in
	// server.ts, and are threaded through here rather than moved — moving
	// them would force a choice between duplicating them or importing this
	// module's route file back into server.ts, both worse than passing the
	// function reference through ctx).
	wireGoalManagerResolvers(
		ctx: ProjectContext,
		deps: { sessionManager: SessionManager; projectContextManager: ProjectContextManager; projectRegistry: ProjectRegistry },
	): void;
	validateComponentsConfig(components: unknown): string | null;
	isValidBaseRefBranchGrammar(name: string): boolean;
	detectedRefExistsInAllComponents(rootPath: string, comps: Array<{ repo: string }>, ref: string): Promise<boolean>;

	// ── Cohort 2 (project-config) additions — append-only from here down ──
	// Parallel cohorts each append their new fields at the END of this
	// interface (alphabetical within their own cohort block) so concurrent
	// cohort branches never collide on the same lines. Never reorder
	// existing fields.

	/** server.ts's LEGACY_QA_TOP_LEVEL_KEYS — shared with the not-yet-migrated PUT /api/project-config legacy route, so it stays defined once in server.ts and flows through here. */
	legacyQaTopLevelKeys: readonly string[];
	/** The SERVER-scope ProjectConfigStore (handleApiRoute's `projectConfigStore` param) — the middle rung of the "resolved" view's project → server → default source cascade. */
	serverProjectConfigStore: ProjectConfigStore;
	// STR-01 cohort 2 (marketplace): appended, never reorder the fields above —
	// a parallel cohort (project-config) is also appending to this interface.
	// See src/server/routes/marketplace-routes.ts.
	/** Per-gateway-instance singletons, threaded exactly like sessionManager/
	 *  projectRegistry above (built fresh per request, same value for the life
	 *  of one gateway). Both are optional because handleApiRoute's own params
	 *  are (a pre-existing gateway-wiring detail, not request-shaped). */
	marketplaceInstaller?: MarketplaceInstaller;
	marketplaceSourceStore?: MarketplaceSourceStore;
	packRuntimeSupervisor?: PackRuntimeSupervisorLike;
	configCascade: ConfigCascade;
	/** The server/default-scope config store (handleApiRoute's own `projectConfigStore` param). */
	projectConfigStore: ProjectConfigStore;
	// Small per-request closures already defined once in handleApiRoute and
	// shared with not-yet-migrated legacy routes (mirrors the projects-cohort
	// fields above).
	invalidateResolverCaches(): void;
	reloadMcpAfterMarketplaceMutation(scope?: InstallScope, projectId?: string): Promise<McpReloadResult | undefined>;
	resolveProjectConfigStore(pid: string | null): ProjectConfigStore;
	resolveSkillDiscoveryCwd(cwd: string, projectId: string | null | undefined): string;
	skillMarketContext(projectId: string | null | undefined): SkillMarketContext;
	// Pure module-level helpers in server.ts that are ALSO still called by
	// not-yet-migrated legacy routes (e.g. /api/pack-runtimes/*) — stay defined
	// once, in server.ts, threaded through here rather than duplicated or
	// imported back (would recreate the import cycle STR-04 removed).
	safeString(value: unknown): string | undefined;
	readYamlMapping(file: string): Record<string, unknown> | null;
	readConcretePackToolsFromGroups(packDir: string, toolGroups: readonly string[]): { tools: string[]; descriptions: Record<string, string> };
	/** Returns non-null iff `packName` is a default-disabled built-in pack at server scope. Only the null-ness is observed by migrated callers. */
	getDefaultDisabledInfo(packName: string, serverStore: ProjectConfigStore): unknown | null;
	readForceEnabledPacks(store: ProjectConfigStore): Set<string>;
	writeForceEnabledPacks(store: ProjectConfigStore, set: Set<string>): void;
	loadPiExtensionContributionsFromRuntime(packRoot: string, manifest: NonNullable<PackEntry["manifest"]>): ResolvedPiExtensionContribution[];
	piExtensionDiagnostic(status: PiExtensionDiagnostic["status"], code: string, message: string): PiExtensionDiagnostic;
	normalisePiExtensionCatalogueRefs(entries: readonly (string | Record<string, unknown>)[] | undefined): Set<string>;
	activationMcpContributionId(
		entry: PackEntry,
		mcp: { listName: string; serverName: string; subNamespace?: string },
		metaDetails: Record<string, unknown>,
		fallbackSourceId?: string,
	): string;
	operationMetadataForMcpContribution(
		mcp: { listName: string; sourceFile?: string; operationMetadata?: unknown },
		metaDetails: Record<string, unknown>,
	): Array<{ name: string; label?: string; description?: string; inputSchema?: unknown }>;
	/** `runtimeManifest` is the target runtime's raw manifest (e.g.
	 *  `RuntimeContribution.manifest`) — declarative `deploymentModes`/
	 *  `configRemap` policy is read from it; omitted ⇒ no managed-mode ever
	 *  starts (see resolveRuntimeStartPlan's doc comment in server.ts). */
	resolveRuntimeStartPlan(
		deploymentConfig: Record<string, unknown>,
		runtimeManifest?: Record<string, unknown>,
	): { start: boolean; mode?: string; config: Record<string, unknown> };
	/** Identity-fallback mode-name mapping sharing `resolveRuntimeStartPlan`'s
	 *  `deploymentModes` table — see its doc comment in server.ts. */
	mapDeploymentModeToRuntimeMode(deploymentMode: string, runtimeManifest?: Record<string, unknown>): string;
	providerCarriesDeploymentMode(
		provider: { config?: Record<string, unknown>; activation?: { activeWhenConfig?: Record<string, string[]> } },
		effectiveConfig?: Record<string, unknown>,
	): boolean;

	// ── Cohort 5 (staff inbox) additions — append-only from here down.
	// Both already exist as handleApiRoute params/locals shared with the
	// not-yet-migrated rest of the /api/staff* family; threaded through
	// rather than duplicated or imported back from server.ts.
	staffManager: StaffManager;
	/** Optional exactly as handleApiRoute's own `inboxManager` param is (a pre-existing gateway-wiring detail, not request-shaped). */
	inboxManager?: InboxManager;

	// ── Cohort 4 (pack-runtimes) additions — append-only from here down. ──
	// Never reorder the fields above; a parallel cohort-5 branch may also be
	// appending to this interface.
	/** Per-gateway-instance singleton (handleApiRoute's own scope var) — needed
	 *  by the pack-runtimes capabilities/start routes to read a provider's RAW
	 *  (activation-unfiltered) contributions via `getRawPack`. */
	packContributionRegistry: PackContributionRegistry;
	/** server.ts's module-level `readBodyText` — reads the raw request body as
	 *  text (no JSON parse), distinguishing an EMPTY body (valid) from a
	 *  MALFORMED one (400). ALSO used by the not-yet-migrated sessionless
	 *  `/api/ext/pack-route/:packId/:routeName` route, so it stays defined once
	 *  in server.ts and is threaded through here rather than duplicated. */
	readBodyText(req: http.IncomingMessage, maxBytes?: number): Promise<string | null>;

	// ── Cohort 6 (workflows + review-annotations) additions — append-only
	// from here down. Never reorder the fields above.
	/** handleApiRoute's own `reviewAnnotationStore` param — optional exactly as it is there (a pre-existing gateway-wiring detail, not request-shaped). Workflows needed no new fields: configCascade + projectContextManager were already threaded through by cohort 1/2. */
	reviewAnnotationStore?: ReviewAnnotationStore;

	// ── Cohort 7 (session utility routes) additions — append-only from here
	// down. Never reorder the fields above.
	bgProcessManager: BgProcessManager;
	noContent(): void;
	toolManager: ToolManager;

	// ── Cohort 9 (server/system routes) additions — append-only from here
	// down. Never reorder the fields above.
	config: {
		host: string;
		forceAuth?: boolean;
		tls?: { caCert?: string };
	};
	preferencesStore: PreferencesStore;
	sandboxManager?: SandboxManager;
	getAigwUrl(prefs: PreferencesStore): string | undefined;
	writeProjectResolutionError(resolved: Extract<ResolvedProject, { ok: false }>): void;

	// ── Cohort 10 (staff CRUD + MCP operator routes) additions — append-only.
	groupPolicyStore: ToolGroupPolicyStore;
	refreshMcpExternalTools(): void;
	resolveRoleForProject(roleId: string, projectId?: string): Role | undefined;

	// ── Cohort 12 (preferences routes) additions — append-only.
	broadcastPreferencesChanged(): void;
	claudeCodeConfirmationBinding(patch: Record<string, unknown>): { requiresConfirmation: boolean; keys: string[]; binding: string };
	firstHeader(name: string): string | undefined;
	getSafePreferences(): Record<string, unknown>;
	isHumanOperatorRequest(): boolean;

	// ── STR-05 roles route-hoist additions — append-only.
	clampRoleThinking(value: unknown, modelStr: string | undefined): string | undefined;
	resolveRequiredConfigProjectScope(projectIdValue: unknown, opts?: { aliasSystem?: boolean }): RequiredConfigProjectScope | RequiredConfigProjectScopeError;
	roleManager: RoleManager;
	serverRoleStore: RoleStore;
	writeConfigProjectScopeError(error: RequiredConfigProjectScopeError): void;

	// ── Cohort 14 (directory browser routes) additions — append-only.
	defaultCwd: string;

	// ── Cohort 15 (model/provider routes) additions — append-only.
	sandboxScope?: SandboxScope;
	// ── Wave 1 LSP routes (docs/design/lsp-product-tools.md) additions —
	// append-only. Per-gateway-instance singleton, threaded exactly like
	// bgProcessManager above. Optional so gateways that opt out of LSP (e.g.
	// some lightweight test harnesses) leave routes fail-open rather than
	// throwing on a missing field.
	lspSupervisor?: TsServerSupervisor;

	// ── Cohort 16a (cost routes) additions — append-only.
	getGoalAcrossProjects(goalId: string): PersistedGoal | undefined;
	getTaskManagerForTask(taskId: string): TaskManager;

	// ── Cohort 16b (preview routes) additions — append-only.
	broadcastToSession?: (sessionId: string, event: any) => void;

	// ── Cohort 17 (editable proposal routes) additions — append-only.
	validateGoalProposalWorkflow(
		args: Record<string, unknown>,
		workflows: Workflow[],
	): { ok: false; code: string; message: string; availableWorkflows?: { id: string; name: string }[]; validOptionalSteps?: string[] } | null;

	// ── Cohort 18 (host configuration routes) additions — append-only.
	/** handleApiRoute's mutable gateway config object, threaded so PUT /api/config/cwd preserves the legacy in-place write. */
	mutableGatewayConfig: { defaultCwd: string };

	// ── Cohort 20 (session discovery routes) additions — append-only.
	archivedSessionMatchesQuery(session: any, query: string): boolean;
	bfsEnrichArchived(seedIds: string[], allArchived: any[]): any[];
	colorStore: ColorStore;
	normalizedArchivedQuery(value: string | null): string;

	// ── Cohort 21 (session mutation/lifecycle routes) additions — append-only.
	getGoalManagerForGoal(goalId: string): GoalManager;
	isUnsupportedForkSource(session: any, ps: any): string | null;
	roleCreateOptions(role: Role): { rolePrompt?: string; roleName: string; role: string; accessory?: string; initialModel?: string; initialThinkingLevel?: string };

	// ── Cohort 22 (session creation route) additions — append-only.
	sandboxTokenStore?: SandboxTokenStore;
	writeCwdValidationError(validation: Extract<CwdValidationResult, { ok: false }>): void;

	// ── Cohort 23 (session git read/status routes) additions — append-only.
	isHeadquartersSession(session: { projectId?: string }): boolean;
	prStatusStore: PrStatusStore;
	sessionGitUnavailablePayload(session: { id: string; projectId?: string }, action: string): Record<string, unknown>;

	// ── Goals G1 additions — append-only.
	archivedGoalMatchesQuery(goal: PersistedGoal, sessions: any[], query: string): boolean;
	getTaskManagerForGoal(goalId: string): TaskManager;
	listGoalsAcrossProjects(opts?: { projectId?: string }): PersistedGoal[];
	requireSubgoalsEnabled(): boolean;
	verificationHarness: VerificationHarness;

	// ── Cohort 27 (task routes) additions — append-only.
	getTaskRecordForTask(taskId: string): { task: PersistedTask; taskManager: TaskManager; projectId: string } | undefined;
	sandboxCanAccessTask(task: PersistedTask): boolean;
	teamManager: TeamManager;

	// ── Goals G2a additions — append-only.
	cookieStore: CookieStore;

	// ── Goals G2b additions — append-only.
	// No new fields: lifecycle/archive routes reuse ctx values already
	// threaded by earlier cohorts.

	// ── Cohort 30 (extension-host invocation routes) additions — append-only.
	extensionChannelServices?: ExtensionChannelServices;
	mintScopedExtensionChannelOpenPermit(input: {
		openPermits: unknown;
		packContributionRegistry: PackContributionRegistry;
		projectId?: string;
		resolver: ExtensionToolManager;
		headerSessionId: string | undefined;
		rawHeaderSessionId: string | string[] | undefined;
		bodySessionId: unknown;
		surfaceToken: unknown;
		name: unknown;
		init: unknown;
		singletonKey: unknown;
		resolveSession(id: string): ActionGuardSession | undefined;
	}): Promise<{ ok: true; openGrant: string; channelName: string; packId: string; sessionId: string } | { ok: false; status: number; error: string }>;
	notePackStoreWrite(key: unknown): void;
	orchestrationCore: OrchestrationCore;
	resolveManagedRuntimeContext(
		supervisor: PackRuntimeSupervisorLike | undefined,
		opts: { packId: string; runtimeId: string; projectId?: string; config?: Record<string, unknown> },
	): Promise<RuntimeContext | undefined>;
	routeDispatcher: RouteDispatcher;
	routeRegistry: RouteRegistry;
	// ── Goals G3a additions — append-only.
	broadcastToGoal(goalId: string, event: any): void;
}
