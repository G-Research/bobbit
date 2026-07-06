/**
 * Session setup/sandbox plumbing - SessionManager decomposition cohort 11.
 *
 * SessionManager keeps same-named wrappers for callers and source-shape tests,
 * while PipelineContext construction, scoped gateway credentials, Docker
 * network setup, sandbox cwd mapping, and sandbox credential resolution live here.
 */
import { execFile as execFileCb, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { sandboxNetworkCreateArgs } from "./docker-args.js";
import { readClaudeCodeConfig } from "./claude-code-config.js";
import type { RpcBridgeOptions, RuntimePiExtensionDiagnostic, RuntimePiExtensionInfo } from "./rpc-bridge.js";
import { readToken } from "../auth/token.js";
import { ensureSandboxAgentAuthFile, resolveHostTokenValue, resolveSandboxAgentAuthPolicy } from "./host-tokens.js";
import { bobbitStateDir, globalAuthPath } from "../bobbit-dir.js";
import type { GoalManager } from "./goal-manager.js";
import { TaskManager } from "./task-manager.js";
import type { SearchService } from "../search/search-service.js";
import type { McpManager } from "../mcp/mcp-manager.js";
import type { SessionStore, PersistedSession } from "./session-store.js";
import type { PersistedGoal } from "./goal-store.js";
import type { CostTracker } from "./cost-tracker.js";
import type { RoleManager } from "./role-manager.js";
import type { ToolManager } from "./tool-manager.js";
import type { ToolGroupPolicyStore } from "./tool-group-policy-store.js";
import type { ProjectContextManager } from "./project-context-manager.js";
import type { PrStatusStore } from "./pr-status-store.js";
import type { SessionSecretStore } from "../auth/session-secret.js";
import type { LifecycleHub } from "./lifecycle-hub.js";
import type { PiProcessPool } from "./pi-process-pool.js";
import { isWarmPoolEnabled } from "./pi-process-pool.js";
import { HEADQUARTERS_PROJECT_ID } from "./project-registry.js";
import { isSandboxExemptProject, type SandboxManager } from "./sandbox-manager.js";
import { isGitRepo, getRepoRoot, isUnresolvedHeadWorktreeError } from "../skills/git.js";
import type { ServerMessage } from "../ws/protocol.js";
import type { WebSocket } from "ws";
import type { SessionInfo } from "./session-manager.js";
import {
	type PipelineContext,
	type SandboxWiringOptions,
	type MarketplacePiExtensionResolver,
	applySandboxCwdOffset,
	normalizeSandboxCwdOffset,
	relativeSandboxCwdOffset,
} from "./session-setup.js";

const execFileAsync = promisify(execFileCb);

function isSandboxContainerPath(cwd?: string): boolean {
	return !!cwd && (cwd === "/workspace" || cwd.startsWith("/workspace/") || cwd === "/workspace-wt" || cwd.startsWith("/workspace-wt/"));
}

export interface SessionSetupPlumbingDeps {
	getAgentCliPath(): string | undefined;
	getSystemPromptPath(): string | undefined;
	getRoleManager(): RoleManager | null | undefined;
	getToolManager(): ToolManager | null | undefined;
	getGroupPolicyStore(): ToolGroupPolicyStore | null | undefined;
	getConfigCascade(): import("./config-cascade.js").ConfigCascade | null;
	getPreferencesStore(): import("./preferences-store.js").PreferencesStore | undefined;
	getProjectConfigStore(): import("./project-config-store.js").ProjectConfigStore | null | undefined;
	getProjectContextManager(): ProjectContextManager | null;
	getSandboxManager(): SandboxManager | null;
	getSandboxTokenStore(): import("../auth/sandbox-token.js").SandboxTokenStore | null;
	getSessionSecretStore(): SessionSecretStore;
	getPiProcessPool(): PiProcessPool;
	getLifecycleHub(): LifecycleHub | undefined;
	getPrStatusStore(): PrStatusStore | null;
	getTestCostTracker(): CostTracker | null;
	getTestGoalManager(): GoalManager | null;
	getTestTaskManager(): TaskManager | null;
	getSessionStore(projectId?: string): SessionStore;
	getSearchIndexForProject(projectId?: string): SearchService;
	getSessions(): Map<string, SessionInfo>;
	getAllPersistedSessionsForWorktreeGuard(): PersistedSession[];
	getMcpManagerForContext(projectId?: string, cwd?: string): McpManager | null;
	getMarketplacePiExtensionResolver(): MarketplacePiExtensionResolver | null;
	registerWarmPoolIdentityAlias(poolOwnedId: string, realSessionId: string): void;
	assemblePrompt(sessionId: string, parts: import("./system-prompt.js").PromptParts): string | undefined;
	applySandboxWiring(opts: RpcBridgeOptions, id: string, sandboxOpts?: SandboxWiringOptions): Promise<boolean>;
	handleAgentLifecycle(session: SessionInfo, event: any): void;
	trackCostFromEvent(session: SessionInfo, event: any): void;
	recordPiExtensionDiagnostic(session: SessionInfo, diagnostic: RuntimePiExtensionDiagnostic, extension: RuntimePiExtensionInfo): void;
	broadcast(clients: Set<WebSocket>, msg: ServerMessage): void;
	tryAutoSelectModel(session: SessionInfo): Promise<void>;
	tryApplyDefaultThinkingLevel(session: SessionInfo): Promise<void>;
	buildWorkflowList(projectId?: string): string;
	resolveInitialModel(role: string | undefined, projectId: string | undefined): string | undefined;
	resolveInitialThinkingLevel(role: string | undefined, projectId: string | undefined): string | undefined;
	persistSessionMetadata(session: SessionInfo): Promise<void>;
	resolveGoal(goalId: string): PersistedGoal | undefined;
	dispatchGoalProvisionedForWorktree(opts: {
		goalId: string | undefined;
		projectId?: string;
		worktreePath: string;
		cwd: string;
		branch?: string;
	}): Promise<void>;
}

export class SessionSetupPlumbing {
	/** Network name for sandbox containers. */
	private static readonly SANDBOX_NETWORK = "bobbit-sandbox-net";

	constructor(private readonly deps: SessionSetupPlumbingDeps) {}

	readClaudeCodeConfigForProject(projectId?: string) {
		const preferencesStore = this.deps.getPreferencesStore();
		if (!preferencesStore) return undefined;
		const projectContextManager = this.deps.getProjectContextManager();
		const projectConfigStore = projectId && projectContextManager
			? (projectContextManager.getOrCreate(projectId)?.projectConfigStore ?? this.deps.getProjectConfigStore() ?? null)
			: (this.deps.getProjectConfigStore() ?? null);
		return readClaudeCodeConfig(preferencesStore, projectConfigStore);
	}

	/** Build a PipelineContext from this manager's fields. Requires projectId when PCM is active. */
	buildPipelineContext(projectId?: string, cwd?: string): PipelineContext {
		const resolvedStore = this.deps.getSessionStore(projectId);
		const resolvedSearchIndex = this.deps.getSearchIndexForProject(projectId);
		let resolvedGoalManager: GoalManager;
		let resolvedTaskManager: TaskManager;
		let resolvedProjectConfigStore = this.deps.getProjectConfigStore() ?? null;
		let resolvedCostTracker: CostTracker;
		const projectContextManager = this.deps.getProjectContextManager();
		if (projectId && projectContextManager) {
			const ctx = projectContextManager.getOrCreate(projectId);
			if (ctx) {
				resolvedGoalManager = ctx.goalManager;
				resolvedTaskManager = new TaskManager(ctx.taskStore);
				resolvedProjectConfigStore = ctx.projectConfigStore;
				resolvedCostTracker = ctx.costTracker;
			} else {
				throw new Error(`Cannot build pipeline context: project "${projectId}" not found`);
			}
		} else if (this.deps.getTestCostTracker() && this.deps.getTestGoalManager() && this.deps.getTestTaskManager()) {
			resolvedCostTracker = this.deps.getTestCostTracker()!;
			resolvedGoalManager = this.deps.getTestGoalManager()!;
			resolvedTaskManager = this.deps.getTestTaskManager()!;
		} else {
			throw new Error("Cannot build pipeline context: no project context manager or test stores");
		}
		resolvedGoalManager.setLiveSessionResolver(() => this.deps.getAllPersistedSessionsForWorktreeGuard());
		return {
			agentCliPath: this.deps.getAgentCliPath(),
			systemPromptPath: this.deps.getSystemPromptPath(),
			roleManager: this.deps.getRoleManager() ?? null,
			toolManager: this.deps.getToolManager() ?? null,
			mcpManager: this.deps.getMcpManagerForContext(projectId, cwd),
			marketplacePiExtensionResolver: this.deps.getMarketplacePiExtensionResolver(),
			goalManager: resolvedGoalManager,
			taskManager: resolvedTaskManager,
			projectConfigStore: resolvedProjectConfigStore,
			serverProjectConfigStore: this.deps.getProjectConfigStore() ?? null,
			preferencesStore: this.deps.getPreferencesStore() ?? null,
			sandboxManager: this.deps.getSandboxManager(),
			sandboxTokenStore: this.deps.getSandboxTokenStore(),
			sessionSecretStore: this.deps.getSessionSecretStore(),
			// Dark by default (BOBBIT_WARM_POOL=1 opts in) — see the field doc
			// comment. Gating here (not inside pi-process-pool.ts) means a
			// disabled pool is never even referenced by session-setup.ts's
			// spawnAgent(), matching `claim() returns null → cold path` for
			// "the flag is off" as just another kind of miss.
			piProcessPool: isWarmPoolEnabled() ? this.deps.getPiProcessPool() : undefined,
			registerWarmPoolIdentityAlias: (poolOwnedId, realSessionId) => this.deps.registerWarmPoolIdentityAlias(poolOwnedId, realSessionId),
			groupPolicyStore: this.deps.getGroupPolicyStore() ?? null,
			configCascade: this.deps.getConfigCascade(),
			lifecycleHub: this.deps.getLifecycleHub(),
			costTracker: resolvedCostTracker,
			store: resolvedStore,
			searchIndex: resolvedSearchIndex,
			sessions: this.deps.getSessions(),
			listPersistedSessionsForWorktreeGuard: () => this.deps.getAllPersistedSessionsForWorktreeGuard(),
			assemblePrompt: (id, parts) => this.deps.assemblePrompt(id, parts),

			applySandboxWiring: (opts, id, sandboxOpts) => this.deps.applySandboxWiring(opts, id, sandboxOpts),
			handleAgentLifecycle: (session, event) => this.deps.handleAgentLifecycle(session, event),
			trackCostFromEvent: (session, event) => this.deps.trackCostFromEvent(session, event),
			recordPiExtensionDiagnostic: (session, diagnostic, extension) => this.deps.recordPiExtensionDiagnostic(session, diagnostic, extension),
			broadcast: (clients, msg) => this.deps.broadcast(clients, msg),
			tryAutoSelectModel: (session) => this.deps.tryAutoSelectModel(session),
			tryApplyDefaultThinkingLevel: (session) => this.deps.tryApplyDefaultThinkingLevel(session),
			buildWorkflowList: (projectId?: string) => this.deps.buildWorkflowList(projectId),
			resolveInitialModel: (role, projectId) => this.deps.resolveInitialModel(role, projectId),
			resolveInitialThinkingLevel: (role, projectId) => this.deps.resolveInitialThinkingLevel(role, projectId),
			persistSessionMetadata: (session) => this.deps.persistSessionMetadata(session),
			prStatusStore: this.deps.getPrStatusStore()!,
			// Hierarchical goal-metadata resolver, bound to THIS project's GoalManager.
			// The pipeline (tool activation, prompt order, bridge-install) resolves the
			// effective (inherited) metadata for a session's goal through this single
			// closure — no other site walks the goal ancestry. Absent metadata ⇒ {}.
			resolveGoalMetadata: (goalId: string | undefined) => resolvedGoalManager.getEffectiveGoalMetadata(goalId),
		};
	}

	/**
	 * Ensure the Docker bridge network for sandboxed containers exists.
	 * Idempotent — checks with `docker network inspect` first.
	 */
	async ensureSandboxNetwork(): Promise<string> {
		const name = SessionSetupPlumbing.SANDBOX_NETWORK;
		try {
			await execFileAsync("docker", sandboxNetworkCreateArgs(name), { timeout: 15_000 });
			console.log(`[session-manager] Created Docker network "${name}"`);
		} catch (err: any) {
			const msg = err.stderr || err.message || "";
			if (!msg.includes("already exists")) {
				console.error(`[session-manager] Failed to create Docker network "${name}":`, err);
				throw err;
			}
			// Network was created concurrently — that's fine
		}
		return name;
	}

	/**
	 * Remove the sandbox Docker network. Non-fatal if it doesn't exist
	 * or has connected containers.
	 */
	async cleanupSandboxNetwork(): Promise<void> {
		try {
			await execFileAsync("docker", ["network", "rm", SessionSetupPlumbing.SANDBOX_NETWORK], { timeout: 10_000 });
			console.log(`[session-manager] Removed Docker network "${SessionSetupPlumbing.SANDBOX_NETWORK}"`);
		} catch {
			// Non-fatal — network may not exist or may have connected containers
		}
	}

	async resolveSandboxCwdOffset(
		cwd: string,
		projectId?: string,
		goalId?: string,
		explicitOffset?: string,
	): Promise<string | undefined> {
		const explicit = normalizeSandboxCwdOffset(explicitOffset);
		if (explicit) return explicit;
		if (!cwd || isSandboxContainerPath(cwd)) return undefined;

		// Goal/team sessions often pass a host worktree cwd without worktreeOpts.
		// Prefer the goal's stable repo/worktree metadata when available.
		if (goalId) {
			const goal = this.deps.resolveGoal(goalId);
			const goalCwd = goal?.cwd || cwd;
			const goalWorktreeOffset = relativeSandboxCwdOffset(goal?.worktreePath, goalCwd);
			if (goalWorktreeOffset) return goalWorktreeOffset;
			const goalRepoOffset = relativeSandboxCwdOffset(goal?.repoPath, goalCwd);
			if (goalRepoOffset) return goalRepoOffset;
		}

		try {
			if (await isGitRepo(cwd)) {
				const repoRoot = await getRepoRoot(cwd);
				const repoOffset = relativeSandboxCwdOffset(repoRoot, cwd);
				if (repoOffset) return repoOffset;
			}
		} catch {
			// Fall back to project-root containment below.
		}

		const projectContextManager = this.deps.getProjectContextManager();
		if (projectId && projectContextManager) {
			const project = projectContextManager.getOrCreate(projectId)?.project;
			const projectRoot = project?.rootPath;
			if (projectRoot) {
				try {
					if (await isGitRepo(projectRoot)) {
						const repoRoot = await getRepoRoot(projectRoot);
						const repoOffset = relativeSandboxCwdOffset(repoRoot, cwd);
						if (repoOffset) return repoOffset;
					}
				} catch {
					// Project may be non-git; project-relative offset still works for /workspace.
				}
				const projectOffset = relativeSandboxCwdOffset(projectRoot, cwd);
				if (projectOffset) return projectOffset;
			}
		}

		return undefined;
	}

	readGatewayUrlForAgent(): string | undefined {
		try {
			return fs.readFileSync(path.join(bobbitStateDir(), "gateway-url"), "utf-8").trim() || undefined;
		} catch {
			return undefined;
		}
	}

	mintScopedGatewayToken(projectId: string | undefined, sessionId: string, goalId?: string): string | undefined {
		const sandboxTokenStore = this.deps.getSandboxTokenStore();
		if (!projectId || !sandboxTokenStore) return undefined;
		const scopedToken = sandboxTokenStore.register(projectId);
		sandboxTokenStore.addSession(projectId, sessionId);
		if (goalId) sandboxTokenStore.addGoal(projectId, goalId);
		return scopedToken;
	}

	applyScopedGatewayCredentials(
		bridgeOptions: RpcBridgeOptions,
		sessionId: string,
		projectId: string | undefined,
		goalId?: string,
	): void {
		const gwUrl = this.readGatewayUrlForAgent();
		if (gwUrl) bridgeOptions.gatewayUrl = gwUrl;
		const scopedToken = this.mintScopedGatewayToken(projectId, sessionId, goalId ?? bridgeOptions.env?.BOBBIT_GOAL_ID);
		if (scopedToken) bridgeOptions.gatewayToken = scopedToken;
	}

	scopedGatewayEnvForDirectAgent(sessionId: string, projectId: string | undefined, goalId?: string): Record<string, string> | undefined {
		const env: Record<string, string> = {};
		const gwUrl = this.readGatewayUrlForAgent();
		if (gwUrl) env.BOBBIT_GATEWAY_URL = gwUrl;
		const scopedToken = this.mintScopedGatewayToken(projectId, sessionId, goalId);
		if (scopedToken) env.BOBBIT_TOKEN = scopedToken;
		return Object.keys(env).length > 0 ? env : undefined;
	}

	/**
	 * Apply Docker sandbox wiring to bridge options.
	 * Shared by createSession(), restoreSession(), and createDelegateSession().
	 * Returns true if sandbox was applied, false if sandbox is not configured.
	 *
	 * With the new per-project sandbox architecture, this:
	 * - Gets the ProjectSandbox for the project
	 * - Gets the container ID
	 * - Sets up credentials and token (one per project, not per session)
	 * - Sets bridgeOptions.containerId
	 * - The CWD is the container-internal worktree path (set by caller or /workspace)
	 */
	async applySandboxWiring(
		bridgeOptions: RpcBridgeOptions,
		sessionId: string,
		opts?: SandboxWiringOptions,
	): Promise<boolean> {
		// Resolve project ID before reading sandbox config. The selected project's
		// config is authoritative; the server/HQ store is only a legacy fallback for
		// genuinely unscoped callers.
		const projectId = opts?.projectId;
		if (!projectId) {
			throw new Error("Sandbox mode requires a projectId");
		}
		if (isSandboxExemptProject(projectId)) {
			bridgeOptions.sandboxed = false;
			delete bridgeOptions.containerId;
			return false;
		}

		const projectContextManager = this.deps.getProjectContextManager();
		const projectContext = projectContextManager?.getOrCreate(projectId) ?? null;
		const projectConfigStore = projectContext?.projectConfigStore ?? this.deps.getProjectConfigStore();
		if (!projectConfigStore) return false;
		const sandboxConfig = projectConfigStore.get("sandbox") || "none";
		if (sandboxConfig !== "docker") return false;

		// Get the ProjectSandbox for this project
		const sandboxManager = this.deps.getSandboxManager();
		if (!sandboxManager) {
			throw new Error("Sandbox mode requires SandboxManager — not initialized");
		}
		// Lazy per-project init — idempotent. Handles restore paths and any call site
		// that reached wiring without going through the explicit session-setup /
		// goals / staff entry points.
		await sandboxManager.ensureForProject(projectId);
		const sandbox = sandboxManager.get(projectId);
		if (!sandbox) {
			throw new Error(`No sandbox initialized for project ${projectId}`);
		}

		const containerId = await sandbox.getContainerId();

		// Read gateway URL and generate scoped token for the container.
		const gwUrl = this.readGatewayUrlForAgent();
		if (!gwUrl) throw new Error("Cannot read gateway credentials for sandbox: gateway-url not found");
		bridgeOptions.gatewayUrl = gwUrl;
		const scopedToken = this.mintScopedGatewayToken(projectId, sessionId, opts?.goalId ?? bridgeOptions.env?.BOBBIT_GOAL_ID);
		if (scopedToken) {
			bridgeOptions.gatewayToken = scopedToken;
		} else {
			// Legacy/test harnesses may omit SandboxTokenStore; keep sandbox behavior
			// unchanged there. Direct agents never use this admin fallback.
			const adminToken = readToken();
			if (adminToken === null) {
				throw new Error("Cannot read gateway credentials for sandbox");
			}
			bridgeOptions.gatewayToken = adminToken;
		}

		bridgeOptions.sandboxed = true;
		bridgeOptions.containerId = containerId;
		const projectRootPath = projectContext?.project.rootPath;
		if (projectRootPath) {
			bridgeOptions.projectMarketPacksRoot = path.join(projectRootPath, ".bobbit", "config", "market-packs");
		}

		// Create a worktree inside the container when a branch is specified.
		// This is the primary code path for goal agents (team lead + members).
		// Headquarters is always no-worktree, so ignore any legacy sandboxBranch.
		if (opts?.sandboxBranch && projectId !== HEADQUARTERS_PROJECT_ID) {
			// Capture the HOST-side working directory BEFORE it is remapped into the
			// container worktree below. The `goalProvisioned` provider runs HOST-side
			// (LifecycleHub.dispatchGoalProvisioned executes the provider module on
			// the host with `workingDir: ctx.cwd`), so it must be handed a host
			// filesystem path it can actually write to. The container worktree
			// (`/workspace-wt/<branch>`) lives in a Docker volume and is NOT reachable
			// from the host — passing it made the marker write silently no-op (the
			// hook is non-fatal), so metadata-driven filesystem treatments never
			// landed on sandboxed worktrees. For session-setup-provisioned sandbox
			// sessions this is the session's host worktree cwd; for team members /
			// delegates it is the goal's host worktree cwd they were created with.
			const hostWorktreeCwd = bridgeOptions.cwd;
			try {
				const worktreePath = await sandbox.createWorktree(
					opts.sandboxBranch,
					opts.sandboxBranch,
					opts.sandboxBaseBranch,
				);
				// Agent runtime cwd → the container worktree (offset applied). The
				// agent boots here; only the host-side provider dispatch below uses
				// host coordinates.
				bridgeOptions.cwd = applySandboxCwdOffset(worktreePath, opts.sandboxCwdOffset);
				// Fire the `goalProvisioned` lifecycle hook for the freshly provisioned
				// sandbox worktree. team-manager skips its own dispatch for sandboxed
				// members (no host worktreeResult), and the session-setup provisioning
				// dispatch never runs for these container worktrees — so without this,
				// metadata-driven filesystem treatments would be missing on every
				// sandboxed team lead / member worktree. We dispatch with HOST
				// coordinates (`hostWorktreeCwd`), NOT the container path, so the
				// host-side provider can write its marker files. Skipped when there is
				// no usable host path — restore / respawn paths arrive with
				// `bridgeOptions.cwd` already pointing at a container-internal path
				// (`/workspace-wt/...`); the worktree was provisioned on first creation
				// and providers are idempotent, so a re-dispatch is unnecessary (and
				// would just no-op host-side).
				if (hostWorktreeCwd && !isSandboxContainerPath(hostWorktreeCwd)) {
					await this.deps.dispatchGoalProvisionedForWorktree({
						goalId: opts.goalId,
						projectId,
						worktreePath: hostWorktreeCwd,
						cwd: hostWorktreeCwd,
						branch: opts.sandboxBranch,
					});
				}
			} catch (err) {
				if (!isUnresolvedHeadWorktreeError(err) || opts.sandboxBaseBranch || opts.goalId) throw err;
				console.warn(`[session-manager] ${err.message}; running sandbox session ${sessionId} without a worktree in /workspace`);
				bridgeOptions.cwd = applySandboxCwdOffset("/workspace", opts.sandboxCwdOffset);
			}
		} else if (!isSandboxContainerPath(bridgeOptions.cwd)) {
			// Regular no-worktree sessions run from the project clone in /workspace.
			bridgeOptions.cwd = applySandboxCwdOffset("/workspace", opts?.sandboxCwdOffset);
		}

		// Resolve sandbox tokens from unified config (with legacy fallback)
		// Get project-scoped config/secrets when available.
		const secretsStore = projectContext?.secretsStore ?? null;
		bridgeOptions.sandboxCredentials = resolveSandboxTokens(this.deps.getPreferencesStore(), projectConfigStore, secretsStore);
		const sandboxTokenEntries = projectConfigStore?.getSandboxTokens() ?? [];
		const sandboxAuthPolicy = resolveSandboxAgentAuthPolicy(sandboxTokenEntries);
		ensureSandboxAgentAuthFile({
			prefs: this.deps.getPreferencesStore(),
			includeCodexAuth: sandboxAuthPolicy.includeCodexAuth,
			includeGoogleAuth: sandboxAuthPolicy.includeGoogleAuth,
			scope: opts?.projectId,
		});

		return true;
	}
}

// ── Sandbox credential auto-resolution ─────────────────────────────

/**
 * Map of auth.json provider keys → env vars that pi-coding-agent checks.
 * OAuth providers use their OAuth token env var; API-key providers use the standard key var.
 * Kept for legacy fallback when sandbox_tokens is not set.
 */
const PROVIDER_ENV_MAP: Record<string, { envVar: string; extractKey: (cred: any) => string | undefined }> = {
	anthropic: {
		envVar: "ANTHROPIC_OAUTH_TOKEN",
		extractKey: (cred) => cred?.type === "oauth" ? cred.access : cred?.type === "api_key" ? cred.key : undefined,
	},
	openai: {
		envVar: "OPENAI_API_KEY",
		extractKey: (cred) => cred?.type === "api_key" ? cred.key : undefined,
	},
	google: {
		envVar: "GEMINI_API_KEY",
		extractKey: (cred) => cred?.type === "api_key" ? cred.key : undefined,
	},
	xai: {
		envVar: "XAI_API_KEY",
		extractKey: (cred) => cred?.type === "api_key" ? cred.key : undefined,
	},
	groq: {
		envVar: "GROQ_API_KEY",
		extractKey: (cred) => cred?.type === "api_key" ? cred.key : undefined,
	},
	mistral: {
		envVar: "MISTRAL_API_KEY",
		extractKey: (cred) => cred?.type === "api_key" ? cred.key : undefined,
	},
	openrouter: {
		envVar: "OPENROUTER_API_KEY",
		extractKey: (cred) => cred?.type === "api_key" ? cred.key : undefined,
	},
};

/**
 * Resolve sandbox tokens from the unified sandbox_tokens config key.
 * Falls back to legacy behavior (sandbox_credentials + sandbox_host_token_overrides + sandbox_github_token)
 * when sandbox_tokens is not set.
 */
export function resolveSandboxTokens(prefs?: import("./preferences-store.js").PreferencesStore | null, projectConfig?: import("./project-config-store.js").ProjectConfigStore | null, secretsStore?: import("./secrets-store.js").SecretsStore | null): Record<string, string> {
	const entries = projectConfig?.getSandboxTokens() ?? [];

	// ── New unified path: sandbox_tokens is set ──
	if (entries.length > 0) {
		const result: Record<string, string> = {};
		const secrets = secretsStore?.getAll() || {};
		for (const entry of entries) {
			if (!entry.enabled || !entry.key) continue;
			// Check secrets store first, then fall back to inline value (pre-migration).
			const explicitValue = secrets[entry.key] || entry.value;
			if (explicitValue) {
				result[entry.key] = explicitValue;
			} else {
				// Empty value = resolve from host.
				const resolved = resolveHostTokenValue(entry.key, prefs);
				if (resolved) {
					result[entry.key] = resolved;
				}
			}
		}
		return result;
	}

	// ── Legacy fallback: sandbox_tokens not set ──
	return resolveLegacySandboxCredentials(prefs, projectConfig);
}

/**
 * Legacy credential resolution from sandbox_credentials + sandbox_host_token_overrides + sandbox_github_token.
 * Used as fallback when sandbox_tokens is not configured.
 */
export function resolveLegacySandboxCredentials(prefs?: import("./preferences-store.js").PreferencesStore | null, projectConfig?: import("./project-config-store.js").ProjectConfigStore | null): Record<string, string> {
	const result: Record<string, string> = {};

	// 1. Read auth.json
	let authData: Record<string, any> | null = null;
	try {
		const authPath = globalAuthPath();
		if (fs.existsSync(authPath)) {
			authData = JSON.parse(fs.readFileSync(authPath, "utf-8"));
		}
	} catch {
		// Ignore read errors
	}

	for (const [provider, { envVar, extractKey }] of Object.entries(PROVIDER_ENV_MAP)) {
		const hostEnvVal = process.env[envVar];
		if (hostEnvVal) {
			result[envVar] = hostEnvVal;
			continue;
		}

		if (prefs) {
			const storedKey = prefs.get(`providerKey.${provider}`) as string | undefined;
			if (storedKey) {
				result[envVar] = storedKey;
				continue;
			}
		}

		if (authData && authData[provider]) {
			const key = extractKey(authData[provider]);
			if (key) {
				result[envVar] = key;
			}
		}
	}

	// Auto-detect GITHUB_TOKEN for gh CLI
	const overridesRaw = projectConfig?.get("sandbox_host_token_overrides") || "";
	let tokenOverrides: Record<string, string> = {};
	try { tokenOverrides = overridesRaw ? JSON.parse(overridesRaw) : {}; } catch { /* ignore */ }

	const ghTokenEnabled = tokenOverrides["GITHUB_TOKEN"] !== undefined
		? tokenOverrides["GITHUB_TOKEN"] !== "false"
		: (projectConfig?.get("sandbox_github_token") ?? "true") !== "false";

	if (ghTokenEnabled && !result["GITHUB_TOKEN"]) {
		const hostGhToken = process.env["GITHUB_TOKEN"] || process.env["GH_TOKEN"];
		if (hostGhToken) {
			result["GITHUB_TOKEN"] = hostGhToken;
		} else {
			try {
				const token = execFileSync("gh", ["auth", "token"], { timeout: 5_000, encoding: "utf-8" }).trim();
				if (token) {
					result["GITHUB_TOKEN"] = token;
				}
			} catch {
				// gh not installed or not authenticated — skip
			}
		}
	}

	// Auto-detect NPM_TOKEN if enabled
	const npmTokenEnabled = tokenOverrides["NPM_TOKEN"] !== "false";
	if (npmTokenEnabled && !result["NPM_TOKEN"] && process.env["NPM_TOKEN"]) {
		result["NPM_TOKEN"] = process.env["NPM_TOKEN"];
	}

	// Remove any tokens that are explicitly disabled in overrides
	for (const [envVar, override] of Object.entries(tokenOverrides)) {
		if (override === "false" && result[envVar]) {
			delete result[envVar];
		}
	}

	// Merge manual sandbox_credentials on top
	const credentialsRaw = projectConfig?.get("sandbox_credentials") || "";
	try {
		const credentials: Record<string, string> = credentialsRaw ? JSON.parse(credentialsRaw) : {};
		Object.assign(result, credentials);
	} catch { /* ignore */ }

	return result;
}
