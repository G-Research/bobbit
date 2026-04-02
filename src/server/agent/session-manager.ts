import { execFile as execFileCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { WebSocket } from "ws";
import type { ServerMessage } from "../ws/protocol.js";
import { EventBuffer } from "./event-buffer.js";
import { GoalManager } from "./goal-manager.js";
import { TaskManager } from "./task-manager.js";
import { PromptQueue } from "./prompt-queue.js";
import { SearchIndex } from "../search/search-index.js";
import { extractTextFromMessage } from "../search/message-extractor.js";
import { RpcBridge, type RpcBridgeOptions, containerToHostSessionPath, hostToContainerSessionPath } from "./rpc-bridge.js";
import { validateSandboxMounts } from "./sandbox-mounts.js";
import { SessionStore, type PersistedSession } from "./session-store.js";
import { getAssistantDef } from "./assistant-registry.js";
import { buildReattemptContext } from "./goal-assistant.js";
import { assembleSystemPrompt, cleanupSessionPrompt, type PromptParts } from "./system-prompt.js";
import { generateSessionTitle, generateGoalSummaryTitle } from "./title-generator.js";
import { CostTracker } from "./cost-tracker.js";
import type { ColorStore } from "./color-store.js";
import type { PersonalityManager } from "./personality-manager.js";
import type { RoleManager } from "./role-manager.js";
import type { ToolManager } from "./tool-manager.js";
import { computeToolActivationArgs, writeMcpProxyExtensions, writeToolGuardExtension, resolveGrantPolicy, computeEffectiveAllowedTools } from "./tool-activation.js";
import type { GrantPolicy } from "./role-store.js";
import type { ToolGroupPolicyStore } from "./tool-group-policy-store.js";
import { TOOLS_DIR } from "./tool-manager.js";
import { McpManager } from "../mcp/mcp-manager.js";
import { getAigwUrl, discoverAigwModels, deriveName } from "./aigw-manager.js";
import { modelRecencyRank } from "./model-registry.js";
import { buildAvailableRolesList } from "./team-manager.js";
// createWorktree is used in session-setup.ts pipeline
import { ProjectContextManager } from "./project-context-manager.js";
import { GoalStore, type PersistedGoal } from "./goal-store.js";
import { TaskStore } from "./task-store.js";
import type { GateStore } from "./gate-store.js";
import { bobbitStateDir, globalAuthPath } from "../bobbit-dir.js";

import type { SandboxPool, ClaimOptions } from "./sandbox-pool.js";
import {
	type SessionSetupPlan,
	type PipelineContext,
	executePlan,
	executeWorktreeAsync,
	persistOnce,
	handleSetupFailure,
	sendDelegatePrompt,
	DELEGATE_SPAWN_TIMEOUT_MS,
} from "./session-setup.js";

const execFileAsync = promisify(execFileCb);

/** Goal tools extension — task + gate management for any goal session. */
const GOAL_TOOLS_EXTENSION_PATH = path.join(TOOLS_DIR, "tasks", "extension.ts");

/** Team lead extension — team management tools. */
const TEAM_LEAD_EXTENSION_PATH = path.join(TOOLS_DIR, "team", "extension.ts");

export type SessionStatus = "starting" | "preparing" | "idle" | "streaming" | "terminated";

export interface SessionInfo {
	id: string;
	title: string;
	cwd: string;
	status: SessionStatus;
	createdAt: number;
	lastActivity: number;
	clients: Set<WebSocket>;
	rpcClient: RpcBridge;
	eventBuffer: EventBuffer;
	unsubscribe: () => void;
	isCompacting: boolean;
	titleGenerated: boolean;
	goalId?: string;
	/** Assistant type: "goal" | "role" | "tool" */
	assistantType?: string;
	/** Whether this session has a live HTML preview panel */
	preview?: boolean;
	/** If this is a delegate session, the parent session ID */
	delegateOf?: string;
	/** Role in a team goal (e.g., 'coder', 'reviewer', 'tester', 'team-lead') */
	role?: string;
	/** The team goal ID this agent belongs to */
	teamGoalId?: string;
	/** Session ID of the team lead that spawned this agent */
	teamLeadSessionId?: string;
	/** Path to the git worktree for this session */
	worktreePath?: string;
	/** Task ID this session is working on */
	taskId?: string;
	/** Staff agent ID this session belongs to */
	staffId?: string;
	/** Pixel-art accessory ID for the Bobbit sprite overlay */
	accessory?: string;
	/** Whether this session runs inside a Docker sandbox */
	sandboxed?: boolean;
	/** Container ID if using a pooled Docker container */
	containerId?: string;
	/** Whether this is an automated non-interactive session (e.g. verification reviewer) */
	nonInteractive?: boolean;
	/** Which project this session belongs to */
	projectId?: string;
	/** Personality names */
	personalities?: string[];
	/** Allowed tools for this session */
	allowedTools?: string[];
	/** Server-side prompt queue */
	promptQueue: PromptQueue;
	/** True if the last agent turn ended due to a model/API error */
	lastTurnErrored?: boolean;
	/** Whether tool calls were executed during the current/last turn */
	turnHadToolCalls?: boolean;
	/** Timestamp when the current streaming turn started */
	streamingStartedAt?: number;
	/** Last user prompt text, for retry on fresh-response errors */
	lastPromptText?: string;
	/** Last user prompt images, for retry on fresh-response errors */
	lastPromptImages?: Array<{ type: "image"; data: string; mimeType: string }>;
	/** Pending grant request from the guard extension's long-poll */
	pendingGrantRequest?: {
		resolve: (result: { granted: boolean; tools?: string[] }) => void;
		reject: (err: Error) => void;
		toolName: string;
		toolGroup: string;
		timer: ReturnType<typeof setTimeout>;
	};
	/** Tools granted via "one-time" mode — revoked on agent_end */
	oneTimeGrantedTools?: string[];
	/** Whether post-start setup (model, thinking, metadata) has completed */
	setupComplete?: boolean;
	/** Cached PromptParts for serving prompt-sections API */
	promptParts?: PromptParts;
}

function broadcast(clients: Set<WebSocket>, msg: ServerMessage): void {
	const data = JSON.stringify(msg);
	for (const client of clients) {
		if (client.readyState === 1) {
			client.send(data);
		}
	}
}

export interface SessionManagerOptions {
	/** Override the path to pi-coding-agent cli.js */
	agentCliPath?: string;
	/** Path to a custom system prompt file */
	systemPromptPath?: string;
	/** Color store for session color cleanup on terminate */
	colorStore?: ColorStore;
	/** Personality manager for resolving personality names to prompt fragments */
	personalityManager?: PersonalityManager;
	/** Role manager for looking up role definitions (needed by updatePersonalities) */
	roleManager?: RoleManager;
	/** Tool manager for generating tool documentation in system prompts */
	toolManager?: ToolManager;
	/** Group policy store for resolving group-level default tool grant policies */
	groupPolicyStore?: ToolGroupPolicyStore;
	/** Workflow store for injecting into GoalManager */
	workflowStore?: import("./workflow-store.js").WorkflowStore;
	/** Preferences store for aigw auto-model detection */
	preferencesStore?: import("./preferences-store.js").PreferencesStore;
	/** Project config store for reading project defaults (e.g. default_thinking_level) */
	projectConfigStore?: import("./project-config-store.js").ProjectConfigStore;
	/** Project context manager for per-project store resolution */
	projectContextManager?: ProjectContextManager;
}

export class SessionManager {
	private sessions = new Map<string, SessionInfo>();
	private agentCliPath?: string;
	private systemPromptPath?: string;
	private store: SessionStore;
	private costTracker: CostTracker;
	private colorStore?: ColorStore;
	private personalityManager?: PersonalityManager;
	private roleManager?: RoleManager;
	private toolManager?: ToolManager;
	private groupPolicyStore?: ToolGroupPolicyStore;
	private preferencesStore?: import("./preferences-store.js").PreferencesStore;
	private workflowStore?: import("./workflow-store.js").WorkflowStore;
	private projectConfigStore?: import("./project-config-store.js").ProjectConfigStore;
	private projectContextManager: ProjectContextManager | null = null;
	private mcpManager: McpManager | null = null;
	sandboxPool: SandboxPool | null = null;
	sandboxTokenStore: import("../auth/sandbox-token.js").SandboxTokenStore | null = null;
	private _onPrCreationDetected?: (session: SessionInfo) => void;
	private _verificationHarness?: import("./verification-harness.js").VerificationHarness;
	goalManager: GoalManager;
	taskManager: TaskManager;
	private purgeInterval: ReturnType<typeof setInterval> | null = null;
	/** Full-text search index (SQLite FTS5). */
	searchIndex: SearchIndex;
	/** Cached aigw model discovery result (url → { models, timestamp }) */
	private _aigwModelCache: { url: string; models: Awaited<ReturnType<typeof discoverAigwModels>>; ts: number } | null = null;
	private static AIGW_CACHE_TTL_MS = 60_000; // 1 minute

	setOnPrCreationDetected(cb: (session: SessionInfo) => void): void {
		this._onPrCreationDetected = cb;
	}

	setVerificationHarness(harness: import("./verification-harness.js").VerificationHarness): void {
		this._verificationHarness = harness;
	}

	setSandboxPool(pool: SandboxPool | null): void {
		this.sandboxPool = pool;
	}

	constructor(options?: SessionManagerOptions) {
		this.agentCliPath = options?.agentCliPath;
		this.systemPromptPath = options?.systemPromptPath;
		this.colorStore = options?.colorStore;
		this.personalityManager = options?.personalityManager;
		this.roleManager = options?.roleManager;
		this.toolManager = options?.toolManager;
		this.groupPolicyStore = options?.groupPolicyStore;
		this.preferencesStore = options?.preferencesStore;
		this.workflowStore = options?.workflowStore;
		this.projectConfigStore = options?.projectConfigStore;
		this.projectContextManager = options?.projectContextManager ?? null;
		if (this.projectContextManager) {
			const defaultCtx = this.projectContextManager.getDefault();
			this.store = defaultCtx.sessionStore;
			this.costTracker = defaultCtx.costTracker;
			this.goalManager = new GoalManager(defaultCtx.goalStore, options?.workflowStore);
			this.taskManager = new TaskManager(defaultCtx.taskStore);
			this.searchIndex = defaultCtx.searchIndex;
		} else {
			const stateDir = bobbitStateDir();
			this.store = new SessionStore(stateDir);
			this.costTracker = new CostTracker(stateDir);
			this.goalManager = new GoalManager(new GoalStore(stateDir), options?.workflowStore);
			this.taskManager = new TaskManager(new TaskStore(stateDir));
			this.searchIndex = new SearchIndex(path.join(stateDir, "search.db"));
		}
	}

	getProjectContextManager(): ProjectContextManager | null {
		return this.projectContextManager;
	}

	/** Resolve the SessionStore for a given project. */
	getSessionStore(projectId?: string): SessionStore {
		if (projectId && this.projectContextManager) {
			const ctx = this.projectContextManager.getOrCreate(projectId);
			if (ctx) return ctx.sessionStore;
		}
		return this.store;
	}

	/** Resolve the GoalStore for a given project. */
	getGoalStoreForProject(projectId?: string): GoalStore {
		if (projectId && this.projectContextManager) {
			const ctx = this.projectContextManager.getOrCreate(projectId);
			if (ctx) return ctx.goalStore;
		}
		return this.goalManager.getGoalStore();
	}

	/** Resolve the GateStore for a goal. */
	getGateStoreForGoal(goalId: string): GateStore | null {
		if (this.projectContextManager) {
			const ctx = this.projectContextManager.getContextForGoal(goalId);
			if (ctx) return ctx.gateStore;
		}
		return null;
	}

	/** Resolve SearchIndex for a project. */
	getSearchIndexForProject(projectId?: string): SearchIndex {
		if (projectId && this.projectContextManager) {
			const ctx = this.projectContextManager.getOrCreate(projectId);
			if (ctx) return ctx.searchIndex;
		}
		return this.searchIndex;
	}

	/** Resolve the correct SessionStore for an in-memory session by ID. */
	private resolveStoreForSession(id: string): SessionStore {
		const session = this.sessions.get(id);
		if (session?.projectId) {
			return this.getSessionStore(session.projectId);
		}
		return this.store;
	}

	/** Resolve the correct SessionStore for any session by ID (in-memory or persisted). */
	private resolveStoreForId(id: string): SessionStore {
		// Try in-memory first (fast path)
		const session = this.sessions.get(id);
		if (session?.projectId) {
			return this.getSessionStore(session.projectId);
		}
		// Search all project stores for persisted/archived sessions
		if (this.projectContextManager) {
			for (const ctx of this.projectContextManager.all()) {
				if (ctx.sessionStore.get(id)) return ctx.sessionStore;
			}
		}
		return this.store;
	}

	/** Resolve the correct SearchIndex for a session based on its project. */
	private resolveSearchIndex(session: { projectId?: string }): SearchIndex {
		if (session.projectId && this.projectContextManager) {
			const ctx = this.projectContextManager.getOrCreate(session.projectId);
			if (ctx) return ctx.searchIndex;
		}
		return this.searchIndex;
	}

	/** Resolve a goal across all project contexts. */
	private resolveGoal(goalId: string): PersistedGoal | undefined {
		if (this.projectContextManager) {
			const ctx = this.projectContextManager.getContextForGoal(goalId);
			if (ctx) return ctx.goalStore.get(goalId);
		}
		return this.goalManager.getGoalStore().get(goalId);
	}

	/** Whether Docker sandbox mode is enabled in project config. */
	get isSandboxEnabled(): boolean {
		return (this.projectConfigStore?.get("sandbox") || "none") === "docker";
	}

	/** Build a PipelineContext from this manager's fields. */
	buildPipelineContext(projectId?: string): PipelineContext {
		const resolvedStore = this.getSessionStore(projectId);
		const resolvedSearchIndex = this.getSearchIndexForProject(projectId);
		let resolvedGoalManager = this.goalManager;
		let resolvedTaskManager = this.taskManager;
		let resolvedProjectConfigStore = this.projectConfigStore ?? null;
		if (projectId && this.projectContextManager) {
			const ctx = this.projectContextManager.getOrCreate(projectId);
			if (ctx) {
				resolvedGoalManager = ctx.goalManager;
				resolvedTaskManager = new TaskManager(ctx.taskStore);
				resolvedProjectConfigStore = ctx.projectConfigStore;
			}
		}
		return {
			agentCliPath: this.agentCliPath,
			systemPromptPath: this.systemPromptPath,
			roleManager: this.roleManager ?? null,
			toolManager: this.toolManager ?? null,
			mcpManager: this.mcpManager,
			goalManager: resolvedGoalManager,
			taskManager: resolvedTaskManager,
			personalityManager: this.personalityManager ?? null,
			projectConfigStore: resolvedProjectConfigStore,
			sandboxPool: this.sandboxPool,
			sandboxTokenStore: this.sandboxTokenStore,
			groupPolicyStore: this.groupPolicyStore ?? null,
			costTracker: this.costTracker,
			store: resolvedStore,
			searchIndex: resolvedSearchIndex,
			sessions: this.sessions,
			assemblePrompt: (id, parts) => this.assemblePrompt(id, parts),
			buildToolRestrictionsText: (tools, role) => this.buildToolRestrictionsText(tools, role),
			applySandboxWiring: (opts, id, sandboxOpts) => this.applySandboxWiring(opts, id, sandboxOpts),
			handleAgentLifecycle: (session, event) => this.handleAgentLifecycle(session, event),
			trackCostFromEvent: (session, event) => this.trackCostFromEvent(session, event),
			broadcast: (clients, msg) => broadcast(clients, msg),
			tryAutoSelectModel: (session) => this.tryAutoSelectModel(session),
			tryApplyDefaultThinkingLevel: (session) => this.tryApplyDefaultThinkingLevel(session),
			buildWorkflowList: () => this._buildWorkflowList(),
		};
	}

	/** Network name for sandbox containers. */
	private static readonly SANDBOX_NETWORK = "bobbit-sandbox-net";

	/**
	 * Ensure the Docker bridge network for sandboxed containers exists.
	 * Idempotent — checks with `docker network inspect` first.
	 */
	async ensureSandboxNetwork(): Promise<string> {
		const name = SessionManager.SANDBOX_NETWORK;
		try {
			await execFileAsync("docker", [
				"network", "create", name,
				"--driver", "bridge",
				"--opt", "com.docker.network.bridge.enable_icc=false",
			], { timeout: 15_000 });
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
			await execFileAsync("docker", ["network", "rm", SessionManager.SANDBOX_NETWORK], { timeout: 10_000 });
			console.log(`[session-manager] Removed Docker network "${SessionManager.SANDBOX_NETWORK}"`);
		} catch {
			// Non-fatal — network may not exist or may have connected containers
		}
	}

	/**
	 * Apply Docker sandbox wiring to bridge options.
	 * Shared by createSession(), restoreSession(), and createDelegateSession().
	 * Returns true if sandbox was applied, false if sandbox is not configured.
	 */
	private async applySandboxWiring(
		bridgeOptions: RpcBridgeOptions,
		sessionId: string,
		opts?: { skipMountValidation?: boolean; sandboxClaim?: ClaimOptions }
	): Promise<boolean> {
		if (!this.projectConfigStore) return false;
		const sandboxConfig = this.projectConfigStore.get("sandbox") || "none";
		if (sandboxConfig !== "docker") return false;

		const sandboxImage = this.projectConfigStore.get("sandbox_image") || "bobbit-agent";
		const credentialsRaw = this.projectConfigStore.get("sandbox_credentials") || "";
		const mountsRaw = this.projectConfigStore.get("sandbox_mounts") || "";
		let credentials: Record<string, string> = {};
		try { credentials = credentialsRaw ? JSON.parse(credentialsRaw) : {}; } catch (err) {
			console.error(`[session-manager] Invalid sandbox_credentials JSON: ${err}`);
			throw new Error(`Invalid sandbox_credentials config: ${credentialsRaw}`);
		}
		let mounts: string[] = [];
		try { mounts = mountsRaw ? JSON.parse(mountsRaw) : []; } catch (err) {
			console.error(`[session-manager] Invalid sandbox_mounts JSON: ${err}`);
			throw new Error(`Invalid sandbox_mounts config: ${mountsRaw}`);
		}

		// Validate mounts unless skipped (e.g. during restore — already validated at creation)
		const validatedMounts = opts?.skipMountValidation ? mounts : validateSandboxMounts(mounts, "[session-manager]");

		// Ensure the restricted Docker network exists
		const sandboxNetwork = await this.ensureSandboxNetwork();

		// Read gateway URL and generate scoped token for the container
		try {
			const gwUrl = fs.readFileSync(path.join(bobbitStateDir(), "gateway-url"), "utf-8").trim();
			bridgeOptions.gatewayUrl = gwUrl;

			// Generate a scoped sandbox token instead of using the admin token
			if (this.sandboxTokenStore) {
				const goalId = bridgeOptions.env?.BOBBIT_GOAL_ID;
				const scopedToken = this.sandboxTokenStore.register(sessionId, goalId);
				bridgeOptions.gatewayToken = scopedToken;
			} else {
				const adminToken = fs.readFileSync(path.join(bobbitStateDir(), "token"), "utf-8").trim();
				bridgeOptions.gatewayToken = adminToken;
			}

		} catch (err) {
			throw new Error(`Cannot read gateway credentials for sandbox: ${err}`);
		}

		bridgeOptions.sandboxed = true;
		bridgeOptions.sandboxImage = sandboxImage;
		// Auto-resolve API credentials from host auth system, then overlay manual overrides
		const autoCredentials = resolveHostApiCredentials(this.preferencesStore);
		bridgeOptions.sandboxCredentials = { ...autoCredentials, ...credentials };
		bridgeOptions.sandboxMounts = validatedMounts;
		bridgeOptions.sandboxNetwork = sandboxNetwork;

		// Claim a pre-warmed slot from the sandbox pool
		if (this.sandboxPool) {
			const result = await this.sandboxPool.claim(sessionId, opts?.sandboxClaim);
			if (result) {
				bridgeOptions.containerId = result.containerId;
				// Override CWD to the pool slot's worktree
				bridgeOptions.cwd = result.worktreePath;
			} else {
				console.warn("[session-manager] Sandbox pool exhausted, falling back to cold docker run");
			}
		}

		return true;
	}

	getCostTracker(): CostTracker {
		return this.costTracker;
	}



	getMcpManager(): McpManager | null {
		return this.mcpManager;
	}

	async initMcp(cwd: string): Promise<void> {
		try {
			const mgr = new McpManager(cwd, this.projectConfigStore);

			// Register additional projects for multi-project MCP discovery
			if (this.projectContextManager) {
				const additionalProjects = Array.from(this.projectContextManager.all())
					.filter(ctx => ctx.project.rootPath !== cwd)
					.map(ctx => ({ cwd: ctx.project.rootPath, configStore: ctx.projectConfigStore }));
				if (additionalProjects.length > 0) {
					mgr.setAdditionalProjects(additionalProjects);
				}
			}

			await mgr.connectAll();
			this.mcpManager = mgr;

			// Register MCP tools with ToolManager
			if (this.toolManager) {
				const infos = mgr.getToolInfos();
				this.toolManager.registerExternalTools(infos.map(info => ({
					name: info.name,
					description: info.description,
					summary: info.description,
					group: info.group,
					docs: info.docs,
					provider: { type: 'mcp' as const, server: info.serverName, mcpTool: info.mcpToolName },
				})));
			}
			console.log(`[mcp] MCP initialization complete`);
		} catch (err) {
			console.error('[mcp] Failed to initialize MCP:', (err as Error).message);
		}
	}

	/** Build a markdown list of available workflows for the goal assistant prompt. */
	private _buildWorkflowList(): string {
		const workflows = this.workflowStore?.getAll();
		if (!workflows || workflows.length === 0) {
			return 'Use **general** as a safe default.';
		}
		return workflows.map(w => {
			const gateNames = w.gates.map(g => g.name).join(', ');
			return `- **${w.id}** (${w.name}) — ${w.description}. Gates: ${gateNames}.`;
		}).join('\n');
	}

	/** Build tool restrictions text including available-but-ungranted tools (MCP + builtin/extension).
	 *  Only tools with `ask` policy are listed — `never` tools are hidden,
	 *  and `allow` tools should already be in allowedTools. */
	private buildToolRestrictionsText(allowedTools: string[], role?: { toolPolicies?: Record<string, GrantPolicy> }): string {
		const toolList = allowedTools.join(", ");
		let text = `## Tool Restrictions\n\nYou are ONLY allowed to use the following tools: ${toolList}\n\nDo NOT use any other tools that are not listed above or mentioned below.`;

		// Collect all available-but-not-granted tools (MCP + builtin/extension)
		// so the agent knows it can attempt them (the guard extension blocks and triggers
		// a permission grant prompt in the UI).
		const ungrantedTools: Array<{ name: string; description: string }> = [];
		const allowedLower = new Set(allowedTools.map(a => a.toLowerCase()));

		// MCP tools
		if (this.mcpManager) {
			for (const t of this.mcpManager.getToolInfos()) {
				if (allowedLower.has(t.name.toLowerCase())) continue;
				const policy = resolveGrantPolicy(t.name, t.group, role as any, this.toolManager, this.groupPolicyStore);
				if (policy === 'ask') {
					ungrantedTools.push({ name: t.name, description: t.description });
				}
			}
		}

		// Builtin/extension tools
		if (this.toolManager) {
			const allTools = this.toolManager.getAvailableTools();
			for (const t of allTools) {
				if (allowedLower.has(t.name.toLowerCase())) continue;
				if (t.name.toLowerCase().startsWith("mcp__")) continue; // already handled above
				const policy = resolveGrantPolicy(t.name, t.group, role as any, this.toolManager, this.groupPolicyStore);
				if (policy === 'ask') {
					ungrantedTools.push({ name: t.name, description: t.description });
				}
			}
		}

		if (ungrantedTools.length > 0) {
			const ungrantedList = ungrantedTools.map(t => `- **${t.name}**: ${t.description}`).join("\n");
			text += `\n\n### Additional tools available with permission\n\nThe following tools exist but are not currently granted to your role. If a task would benefit from one of these tools, go ahead and attempt to call it — the user will be prompted to grant you access.\n\n${ungrantedList}`;
		}

		return text;
	}

	/**
	 * Build the full set of CLI args for tool activation, including guard extensions,
	 * MCP proxies, and builtin/extension activation.
	 *
	 * Returns the args array to prepend to bridgeOptions.args.
	 */
	/**
	 * Resolve the effective allowed tools for a role.
	 * If the role has explicit allowedTools, use those.
	 * Otherwise, compute from the full policy cascade (honouring the allow default).
	 */
	private resolveEffectiveAllowedTools(role: import("./role-store.js").Role | undefined): string[] {
		if (!role) return [];
		if (this.toolManager) {
			return computeEffectiveAllowedTools(this.toolManager, role, this.groupPolicyStore, this.mcpManager ?? undefined);
		}
		return [];
	}

	private buildToolActivationArgs(
		sessionId: string,
		allowedTools: string[],
		role: { toolPolicies?: Record<string, GrantPolicy> } | undefined,
		cwd: string,
	): string[] {
		// MCP proxy extensions
		const mcpExtPaths = this.mcpManager
			? writeMcpProxyExtensions(this.mcpManager, allowedTools, role, this.toolManager, this.groupPolicyStore)
			: undefined;

		// Builtin + bobbit-extension activation
		const activation = computeToolActivationArgs(allowedTools, this.toolManager, cwd, mcpExtPaths);

		const args = [...activation.args];

		// Compute session-specific grants (tools in allowedTools but not in the role's base allowedTools)
		const roleBaseTools = role && this.toolManager
			? computeEffectiveAllowedTools(this.toolManager, role as import("./role-store.js").Role, this.groupPolicyStore, this.mcpManager ?? undefined)
			: [];
		const roleAllowed = new Set(roleBaseTools.map(t => t.toLowerCase()));
		const sessionGrants = allowedTools.filter(t => !roleAllowed.has(t.toLowerCase()));

		// Tool guard extension for 'ask' policy tools
		const guardPath = this.toolManager
			? writeToolGuardExtension(sessionId, this.toolManager, this.mcpManager ?? undefined, role, this.groupPolicyStore, sessionGrants)
			: undefined;
		if (guardPath) {
			args.push("--extension", guardPath);
		}

		return args;
	}

	/** Generate tool docs and inject into prompt parts before assembly. */
	private assemblePrompt(sessionId: string, parts: PromptParts): string | undefined {
		if (this.toolManager && !parts.toolDocs) {
			parts.toolDocs = this.toolManager.getToolDocsForPrompt(parts.allowedTools);
		}
		// Cache parts for prompt-sections API
		const session = this.sessions.get(sessionId);
		if (session) session.promptParts = parts;
		return assembleSystemPrompt(sessionId, parts);
	}

	/** Get cached PromptParts for serving prompt-sections API.
	 *  If not cached (e.g. dormant session), rebuild from session metadata. */
	getPromptParts(sessionId: string): PromptParts | undefined {
		const session = this.sessions.get(sessionId);
		if (!session) return undefined;
		if (session.promptParts) return session.promptParts;

		// Rebuild on demand for dormant / restored sessions missing cached parts
		const assistantDef = session.assistantType ? getAssistantDef(session.assistantType) : undefined;
		let parts: PromptParts;

		if (assistantDef) {
			const assistantRole = this.roleManager?.getRole("assistant");
			let assistantGoalSpec = "";
			if (assistantRole?.promptTemplate) {
				assistantGoalSpec = assistantRole.promptTemplate.replace(/\{\{AGENT_ID\}\}/g, `assistant-${(session.goalId || session.id).slice(0, 8)}`);
				assistantGoalSpec += "\n\n---\n\n";
			}
			assistantGoalSpec += assistantDef.prompt;
			if (session.assistantType === "goal") {
				assistantGoalSpec = assistantGoalSpec.replace('{{AVAILABLE_WORKFLOWS}}', this._buildWorkflowList());
				// Inject re-attempt context if this is a re-attempt session
				const reattemptId = (this.resolveStoreForSession(session.id).get(session.id) as any)?.reattemptGoalId;
				if (reattemptId) {
					const origGoal = this.resolveGoal(reattemptId);
					if (origGoal) {
						assistantGoalSpec += "\n\n" + buildReattemptContext(origGoal);
					}
				}
			}
			parts = {
				baseSystemPromptPath: undefined,
				cwd: session.cwd,
				goalSpec: assistantGoalSpec,
				goalTitle: assistantDef.promptTitle,
				goalState: "active",
				allowedTools: session.allowedTools,
				projectConfigStore: this.projectConfigStore,
			};
		} else {
			const goal = session.goalId ? this.resolveGoal(session.goalId) : undefined;
			const resolvedPersonalities = (session.personalities && session.personalities.length > 0 && this.personalityManager)
				? this.personalityManager.resolvePersonalities(session.personalities)
				: undefined;

			let rolePrompt: string | undefined;
			let roleName: string | undefined;
			let toolRestrictionsText: string | undefined;
			if (session.role && this.roleManager) {
				const role = this.roleManager.getRole(session.role);
				if (role?.promptTemplate) {
					rolePrompt = role.promptTemplate;
					if (goal?.branch) rolePrompt = rolePrompt.replace(/\{\{GOAL_BRANCH\}\}/g, goal.branch);
					rolePrompt = rolePrompt.replace(/\{\{AGENT_ID\}\}/g, `${session.role}-${(session.goalId || session.id).slice(0, 8)}`);
					rolePrompt = rolePrompt.replace(/\{\{AVAILABLE_ROLES\}\}/g, buildAvailableRolesList(this.roleManager));
					roleName = session.role;
				}
				if (role) {
					const effective = this.resolveEffectiveAllowedTools(role);
					if (effective.length > 0) {
						toolRestrictionsText = this.buildToolRestrictionsText(effective, role);
					}
				}
			}

			parts = {
				baseSystemPromptPath: this.systemPromptPath,
				cwd: session.cwd,
				goalTitle: goal?.title,
				goalState: goal?.state,
				goalSpec: goal?.spec,
				rolePrompt,
				roleName,
				toolRestrictions: toolRestrictionsText,
				personalities: resolvedPersonalities,
				allowedTools: session.allowedTools,
				projectConfigStore: this.projectConfigStore,
			};
		}

		// Cache for future calls
		session.promptParts = parts;
		return parts;
	}

	// ── Prompt queue helpers ──────────────────────────────────────────

	/** Broadcast queue state to all clients and persist. */
	broadcastQueueUpdate(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (session) this.broadcastQueue(session);
	}

	private broadcastQueue(session: SessionInfo): void {
		broadcast(session.clients, {
			type: "queue_update",
			sessionId: session.id,
			queue: session.promptQueue.toArray(),
		});
		this.resolveStoreForSession(session.id).update(session.id, { messageQueue: session.promptQueue.toArray() });
	}

	/**
	 * Enqueue a prompt (or follow_up). If the agent is idle and queue was empty,
	 * dispatch immediately. Otherwise add to queue and broadcast.
	 * If the agent is idle but queue has items, enqueue and drain.
	 */
	async enqueuePrompt(sessionId: string, text: string, opts?: {
		images?: Array<{ type: "image"; data: string; mimeType: string }>;
		attachments?: unknown[];
		isFollowUp?: boolean;
		isSteered?: boolean;
	}): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;

		// If agent is idle and queue is empty, dispatch directly
		if (session.status === "idle" && session.promptQueue.isEmpty) {
			this.tryGenerateTitleFromPrompt(sessionId, text);
			session.lastPromptText = text;
			session.lastPromptImages = opts?.images;
			if (opts?.isFollowUp) {
				await session.rpcClient.followUp(text);
			} else {
				await session.rpcClient.prompt(text, opts?.images);
			}
			return;
		}

		// Agent is busy or queue has items — enqueue
		session.promptQueue.enqueue(text, {
			images: opts?.images,
			attachments: opts?.attachments,
			isSteered: opts?.isSteered,
		});
		this.broadcastQueue(session);

		// If agent is idle, start draining the queue (bug fix: idle + non-empty queue)
		if (session.status === "idle") {
			this.drainQueue(session);
		}
	}

	/**
	 * Promote a queued message to steered and reorder.
	 * If the agent is streaming, immediately dequeue and dispatch the steered
	 * message via `steer` RPC so it interrupts between tool calls.
	 */
	steerQueued(sessionId: string, messageId: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;
		const ok = session.promptQueue.steer(messageId);
		if (!ok) return false;

		// If agent is streaming, dispatch the steered message immediately
		// so it gets picked up between tool calls via getSteeringMessages().
		// Keep the message in the queue (marked dispatched) so the UI shows
		// "Sent" until the turn ends and the message appears in chat.
		if (session.status === "streaming") {
			const front = session.promptQueue.peek();
			if (front?.isSteered && !front.dispatched) {
				session.promptQueue.markDispatched(front.id);
				session.rpcClient.steer(front.text).catch((err: any) => {
					console.error(`[session-manager] Failed to dispatch steered message for ${session.id}:`, err);
				});
			}
		}

		this.broadcastQueue(session);
		return true;
	}

	/** Remove a queued message. */
	removeQueued(sessionId: string, messageId: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;
		const ok = session.promptQueue.remove(messageId);
		if (ok) this.broadcastQueue(session);
		return ok;
	}

	/**
	 * Called when the agent becomes idle (agent_end) or when a new message is
	 * enqueued while idle. Dequeue and dispatch the next message if any exist.
	 *
	 * Always dispatches via `prompt` RPC (not `steer`) because the agent is
	 * idle at this point — `steer` is only meaningful mid-turn.
	 *
	 * Sets status to "streaming" optimistically to prevent a race where another
	 * enqueuePrompt call sees idle+empty and dispatches a second concurrent prompt.
	 */
	private drainQueue(session: SessionInfo): void {
		if (session.promptQueue.isEmpty) return;

		// Skip already-dispatched messages (steered mid-turn), then pop the next
		const next = session.promptQueue.dequeueUndispatched();
		this.broadcastQueue(session);
		if (!next) return;

		// Title generation for the first real prompt
		this.tryGenerateTitleFromPrompt(session.id, next.text);

		// Track for retry
		session.lastPromptText = next.text;
		session.lastPromptImages = next.images;

		// Optimistic status update to prevent double-dispatch race
		session.status = "streaming";
		session.streamingStartedAt = session.streamingStartedAt ?? Date.now();
		this.resolveStoreForSession(session.id).update(session.id, { wasStreaming: true, streamingStartedAt: session.streamingStartedAt });
		broadcast(session.clients, { type: "session_status", status: "streaming", streamingStartedAt: session.streamingStartedAt });

		// Always dispatch as prompt — agent is idle, steer is only for mid-turn
		session.rpcClient.prompt(next.text, next.images).catch((err: any) => {
			console.error(`[session-manager] Failed to dispatch queued prompt for ${session.id}:`, err);
			// Revert optimistic status on failure
			session.status = "idle";
			broadcast(session.clients, { type: "session_status", status: "idle" });
		});
	}

	/**
	 * Handle agent events that track error state and control queue draining.
	 * Called from every event listener before broadcasting.
	 * - Tracks message_end with stopReason "error" so we can suppress queue draining.
	 * - On agent_end, skips drainQueue if the turn ended with an error.
	 */
	private handleAgentLifecycle(session: SessionInfo, event: any): void {
		// Track tool execution during this turn
		if (event.type === "tool_execution_start") {
			session.turnHadToolCalls = true;

			// Enforce allowedTools — warn when a disallowed tool is used (case-insensitive)
			if (session.allowedTools && session.allowedTools.length > 0 && event.toolName) {
				const toolLower = event.toolName.toLowerCase();
				if (!session.allowedTools.some((t: string) => t.toLowerCase() === toolLower)) {
					console.warn(
						`[session-manager] Session ${session.id} used disallowed tool "${event.toolName}". ` +
						`Allowed: [${session.allowedTools.join(", ")}]`
					);
				}
			}
		}

		if (event.type === "message_end" && event.message?.role === "assistant") {
			session.lastTurnErrored = event.message.stopReason === "error";
		}

		// When a steered user message appears in chat, remove the dispatched pill
		if (event.type === "message_end" && event.message?.role === "user") {
			if (session.promptQueue.removeDispatched()) {
				this.broadcastQueue(session);
			}
		}

		if (event.type === "agent_start") {
			session.status = "streaming";
			session.lastTurnErrored = false;
			session.turnHadToolCalls = false;
			session.streamingStartedAt = Date.now();
			this.resolveStoreForSession(session.id).update(session.id, { wasStreaming: true, streamingStartedAt: session.streamingStartedAt });
			broadcast(session.clients, { type: "session_status", status: "streaming", streamingStartedAt: session.streamingStartedAt });
		} else if (event.type === "agent_end") {
			// Revoke one-time granted tools after the turn completes
			if (session.oneTimeGrantedTools && session.oneTimeGrantedTools.length > 0) {
				const toRevoke = new Set(session.oneTimeGrantedTools.map(t => t.toLowerCase()));
				session.allowedTools = (session.allowedTools || []).filter(
					t => !toRevoke.has(t.toLowerCase())
				);
				session.oneTimeGrantedTools = [];
			}

			session.status = "idle";
			session.streamingStartedAt = undefined;
			this.resolveStoreForSession(session.id).update(session.id, { wasStreaming: false, streamingStartedAt: undefined });
			broadcast(session.clients, { type: "session_status", status: "idle" });
			// Don't drain the queue if the turn ended with a model error —
			// queued/steered messages should wait for a retry.
			if (!session.lastTurnErrored) {
				this.drainQueue(session);
			}

			// Trigger deferred setup after the first agent turn completes.
			// This runs model selection, thinking level, and metadata persistence
			// without blocking the user's first prompt.
			if (!session.setupComplete) {
				session.setupComplete = true;
				this._finishSessionSetup(session).catch((err) => {
					console.error(`[session-manager] Deferred setup error for session ${session.id}:`, err);
				});
			}
		} else if (event.type === "auto_compaction_start") {
			session.isCompacting = true;
		} else if (event.type === "auto_compaction_end") {
			session.isCompacting = false;
			if (!event.aborted) this.refreshAfterCompaction(session);
		}

		// Index completed assistant messages for search
		if (event.type === "message_end" && event.message?.role === "assistant") {
			try {
				const { text, toolNames } = extractTextFromMessage(event.message);
				if (text.trim()) {
					this.resolveSearchIndex(session).indexMessage(
						session.id,
						session.title,
						text,
						toolNames,
						Date.now(),
						session.projectId || "",
					);
				}
			} catch {
				// Non-critical — don't break message flow
			}
		}

		// Detect PR creation in bash tool results
		if (event.type === "message_end" && event.message && this._onPrCreationDetected) {
			const content = event.message.content;
			if (Array.isArray(content)) {
				let prDetected = false;
				const PR_CMD_RE = /gh\s+pr\s+(create|ready)/;
				const PR_URL_RE = /github\.com\/[^/]+\/[^/]+\/pull\/\d+/;
				for (const block of content) {
					if (block.type === "tool_use" && /^[Bb]ash$/.test(block.name) && block.input?.command) {
						if (PR_CMD_RE.test(block.input.command)) { prDetected = true; break; }
					}
					if (block.type === "tool_result") {
						const text = typeof block.content === "string" ? block.content
							: Array.isArray(block.content) ? block.content.map((c: any) => typeof c === "string" ? c : c.text || "").join("") : "";
						if (PR_URL_RE.test(text)) { prDetected = true; break; }
					}
					if (block.type === "text" && typeof block.text === "string" && PR_URL_RE.test(block.text)) {
						prDetected = true; break;
					}
				}
				if (prDetected) {
					this._onPrCreationDetected(session);
				}
			}
		}
	}

	/**
	 * Retry after a model/API error. Behaviour depends on context:
	 * - Fresh response error (no tool calls): re-sends the original user prompt
	 * - Mid-work error (tool calls already executed): sends a system continuation
	 */
	async retryLastPrompt(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error("Session not found");

		const hadToolCalls = session.turnHadToolCalls;
		session.lastTurnErrored = false;
		session.turnHadToolCalls = false;

		if (hadToolCalls) {
			// Agent was mid-work — send a system continuation prompt
			await session.rpcClient.prompt(
				"[SYSTEM: The model API returned an error while you were mid-turn. " +
				"Your previous work has been preserved. Please continue where you left off. " +
				"Do NOT start over — review your recent messages and resume from the exact point of interruption.]"
			);
		} else if (session.lastPromptText) {
			// Fresh response error — re-send the original prompt
			await session.rpcClient.prompt(session.lastPromptText, session.lastPromptImages);
		} else {
			// Fallback (e.g. session predates error tracking) — use prompt, not followUp,
			// because followUp may not be accepted when the agent is idle.
			await session.rpcClient.prompt(
				"[SYSTEM: The model API returned an error on your last response. " +
				"Please review your conversation history and retry what you were doing.]"
			);
		}
	}

	/**
	 * Grant a tool or tool group to a session's role and restart the session
	 * so it picks up the new tools. Returns the updated list of allowed tools.
	 *
	 * @param mode - Grant persistence mode:
	 *   - "persistent" (default): updates role YAML permanently
	 *   - "session-only": adds to session.allowedTools in memory only (survives until session ends/restarts)
	 *   - "one-time": adds to session.allowedTools + tracks for revocation on agent_end
	 */
	async grantToolPermission(sessionId: string, toolName: string, scope: "tool" | "group", group?: string, mode?: "persistent" | "session-only" | "one-time"): Promise<string[]> {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error("Session not found");
		if (!this.roleManager) throw new Error("No role manager available");

		// Use explicit role, or fall back to "general" role (implicit default for all sessions)
		const roleName = session.role || "general";
		const role = this.roleManager.getRole(roleName);
		if (!role) throw new Error(`Role "${roleName}" not found`);

		const effectiveAllowed = this.resolveEffectiveAllowedTools(role);
		const effectiveSet = new Set(effectiveAllowed.map(t => t.toLowerCase()));

		const newTools: string[] = [];
		if (scope === "group" && group) {
			// Add all tools from the group (MCP + non-MCP)
			if (this.mcpManager) {
				const infos = this.mcpManager.getToolInfos();
				for (const info of infos) {
					if (info.group === group && !effectiveSet.has(info.name.toLowerCase())) {
						newTools.push(info.name);
					}
				}
			}
			if (this.toolManager) {
				const allTools = this.toolManager.getAvailableTools();
				for (const tool of allTools) {
					if (tool.group === group && !effectiveSet.has(tool.name.toLowerCase()) && !newTools.includes(tool.name)) {
						newTools.push(tool.name);
					}
				}
			}
		} else {
			// Add just the single tool
			if (!effectiveSet.has(toolName.toLowerCase())) {
				newTools.push(toolName);
			}
		}

		if (newTools.length === 0) {
			// Tool is already effectively allowed — still resolve any pending guard request
			if (session.pendingGrantRequest) {
				clearTimeout(session.pendingGrantRequest.timer);
				const pending = session.pendingGrantRequest;
				session.pendingGrantRequest = undefined;
				pending.resolve({ granted: true, tools: effectiveAllowed });
			}
			return effectiveAllowed;
		}

		let resultTools: string[];

		if (mode === "one-time") {
			// Temporary grant: add to session.allowedTools, track for revocation on agent_end
			session.allowedTools = [...(session.allowedTools || []), ...newTools];
			session.oneTimeGrantedTools = [...(session.oneTimeGrantedTools || []), ...newTools];
			await this._restartSessionWithUpdatedRole(session);
			resultTools = session.allowedTools;

		} else if (mode === "session-only") {
			// Session-scoped grant: add to session.allowedTools only, don't write role YAML
			session.allowedTools = [...(session.allowedTools || []), ...newTools];
			await this._restartSessionWithUpdatedRole(session);
			resultTools = session.allowedTools;

		} else {
			// Persistent grant (default): update toolPolicies on role YAML (allowedTools is derived automatically)
			const updatedPolicies = { ...role.toolPolicies };
			for (const t of newTools) {
				updatedPolicies[t] = 'allow' as GrantPolicy;
			}
			this.roleManager.updateRole(role.name, { toolPolicies: updatedPolicies });
			// Re-read role and recompute effective allowed tools
			const updatedRole = this.roleManager.getRole(role.name);
			const updatedEffective = this.resolveEffectiveAllowedTools(updatedRole ?? role);
			session.allowedTools = updatedEffective;
			await this._restartSessionWithUpdatedRole(session);

			resultTools = updatedEffective;
		}

		// Resolve pending grant request from guard extension
		if (session.pendingGrantRequest) {
			clearTimeout(session.pendingGrantRequest.timer);
			const pending = session.pendingGrantRequest;
			session.pendingGrantRequest = undefined;
			pending.resolve({ granted: true, tools: session.allowedTools });
		}

		return resultTools;
	}

	/**
	 * Called by the guard extension's long-poll endpoint. Creates a pending
	 * grant request, broadcasts to UI clients, and returns a promise that
	 * resolves when the user grants/denies or after a 5-minute timeout.
	 */
	async requestToolGrant(sessionId: string, toolName: string, toolGroup: string): Promise<{ granted: boolean; tools?: string[] }> {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error("Session not found");

		// If a previous grant request is still pending, resolve it as denied
		if (session.pendingGrantRequest) {
			clearTimeout(session.pendingGrantRequest.timer);
			session.pendingGrantRequest.resolve({ granted: false });
			session.pendingGrantRequest = undefined;
		}

		// Create promise that will be resolved by grantToolPermission
		const promise = new Promise<{ granted: boolean; tools?: string[] }>((resolve, reject) => {
			const timer = setTimeout(() => {
				session.pendingGrantRequest = undefined;
				resolve({ granted: false });
			}, 5 * 60 * 1000); // 5 minute timeout

			session.pendingGrantRequest = { resolve, reject, toolName, toolGroup, timer };
		});

		// Broadcast to UI clients
		const roleName = session.role || "general";
		const role = this.roleManager?.getRole(roleName);
		broadcast(session.clients, {
			type: "tool_permission_needed",
			toolName,
			group: toolGroup,
			roleName: role?.name ?? roleName,
			roleLabel: role?.label ?? roleName,
			lastPromptText: session.lastPromptText,
		});

		return promise;
	}

	/**
	 * Called when the user clicks "Deny" in the UI grant dialog.
	 * Resolves the pending grant request with `{ granted: false }` so the
	 * guard extension's long-poll returns immediately instead of waiting 5 min.
	 */
	denyToolPermission(sessionId: string, _toolName: string): void {
		const session = this.sessions.get(sessionId);
		if (!session?.pendingGrantRequest) return;
		clearTimeout(session.pendingGrantRequest.timer);
		const pending = session.pendingGrantRequest;
		session.pendingGrantRequest = undefined;
		pending.resolve({ granted: false });
	}

	/**
	 * Restart a session's agent process so it picks up updated role/tools.
	 * Stops the current agent, then restores from the persisted session file
	 * which re-applies tool activation with the updated role.
	 */
	private async _restartSessionWithUpdatedRole(session: SessionInfo): Promise<void> {
		const ps = this.resolveStoreForSession(session.id).get(session.id);
		if (!ps) return;

		// Save state that must survive the restart
		const clients = new Set(session.clients);
		const savedAllowedTools = session.allowedTools ? [...session.allowedTools] : undefined;
		const savedOneTimeGrantedTools = session.oneTimeGrantedTools ? [...session.oneTimeGrantedTools] : undefined;

		// Stop the current agent process
		session.unsubscribe();
		await session.rpcClient.stop();

		// Remove from sessions map — restoreSession will re-add it
		this.sessions.delete(session.id);

		// Temporarily store overridden allowedTools so restoreSession can use them.
		// restoreSession normally derives allowedTools from the role YAML, but for
		// session-only and one-time grants the in-memory list includes extra tools.
		(ps as any)._overrideAllowedTools = savedAllowedTools;

		// Restore the session (re-launches with correct tool activation)
		try {
			await this.restoreSession(ps);
		} finally {
			// Clean up the temporary override even if restoreSession fails
			delete (ps as any)._overrideAllowedTools;
		}

		// Re-attach the saved clients and carry over grant state
		const restored = this.sessions.get(session.id);
		if (restored) {
			for (const ws of clients) {
				if ((ws as any).readyState === 1) {
					restored.clients.add(ws);
				}
			}
			// Restore in-memory grant state that restoreSession doesn't know about
			if (savedAllowedTools) restored.allowedTools = savedAllowedTools;
			if (savedOneTimeGrantedTools) restored.oneTimeGrantedTools = savedOneTimeGrantedTools;
			broadcast(restored.clients, { type: "session_status", status: "idle" });
		}
	}

	/**
	 * Check an event for usage data and record it via the cost tracker.
	 * Broadcasts a cost_update to connected clients if cost data is found.
	 */
	private trackCostFromEvent(session: SessionInfo, event: any): void {
		// Only track cost on message_end (fires once per completed message).
		// message_update fires on every streaming chunk with the same usage
		// object, which would multiply costs by ~30-40x.
		if (event.type !== "message_end") return;
		if (event.message?.role !== "assistant") return;
		const usage = event.message?.usage ?? event.usage;
		if (!usage) return;

		// Usage cost can be either a number (usage.cost) or an object (usage.cost.total)
		const costValue = typeof usage.cost === "number" ? usage.cost
			: typeof usage.cost?.total === "number" ? usage.cost.total
			: undefined;
		if (costValue === undefined) return;

		const cumulativeCost = this.costTracker.recordUsage(session.id, {
			inputTokens: usage.inputTokens ?? usage.input,
			outputTokens: usage.outputTokens ?? usage.output,
			cacheReadTokens: usage.cacheReadTokens ?? usage.cacheRead,
			cacheWriteTokens: usage.cacheWriteTokens ?? usage.cacheWrite,
			cost: costValue,
		});

		// Look up taskId from assigned tasks for this session
		const assignedTasks = this.taskManager.getTasksForSession(session.id);
		const taskId = assignedTasks.length > 0 ? assignedTasks[0].id : undefined;

		broadcast(session.clients, {
			type: "cost_update",
			sessionId: session.id,
			goalId: session.goalId,
			taskId,
			cost: cumulativeCost,
		});
	}

	/**
	 * Restore sessions from disk on startup.
	 * Re-spawns agent processes and uses switch_session to resume each one.
	 */
	async restoreSessions(): Promise<void> {
		// Initialize search index (skip when ProjectContextManager is active —
		// ProjectContext.open() already opens the index and wires callbacks)
		if (!this.projectContextManager) {
			try {
				this.searchIndex.open();
				if (this.searchIndex.needsRebuild()) {
					const goalStore = this.goalManager.getGoalStore();
					this.searchIndex.rebuildFromStores(goalStore, this.store);
				}
				// Wire index update callbacks
				const goalStore = this.goalManager.getGoalStore();
				goalStore.onIndexUpdate = (goal) => {
					try { this.searchIndex.indexGoal(goal, goal.projectId || ""); } catch (err) { console.error("[search] Failed to index goal:", err); }
				};
				this.store.onIndexUpdate = (session) => {
					try {
						const goalTitle = session.goalId ? this.resolveGoal(session.goalId)?.title : undefined;
						this.searchIndex.indexSession(session, goalTitle, session.projectId || "");
					} catch (err) { console.error("[search] Failed to index session:", err); }
				};
			} catch (err) {
				console.error("[search] Failed to initialize search index:", err);
			}
		}

		const persisted = this.projectContextManager
			? [...this.projectContextManager.getAllLiveSessions()]
			: this.store.getLive();
		if (persisted.length === 0) return;

		// Separate regular sessions from delegate sessions
		const regular = persisted.filter(ps => !ps.delegateOf);
		const delegates = persisted.filter(ps => !!ps.delegateOf);

		console.log(`[session-manager] Restoring ${regular.length} session(s), deferring ${delegates.length} delegate(s)...`);

		// Restore regular sessions in parallel (batched concurrency)
		const CONCURRENCY = 5;
		for (let i = 0; i < regular.length; i += CONCURRENCY) {
			const batch = regular.slice(i, i + CONCURRENCY);
			await Promise.all(batch.map(ps => this.restoreOneSession(ps)));
		}

		// Delegate sessions: dormant entries only — restored on-demand via addClient()
		for (const ps of delegates) {
			if (!ps.agentSessionFile || !fs.existsSync(ps.agentSessionFile)) {
				this.getSessionStore(ps.projectId).remove(ps.id);
				continue;
			}
			this.addDormantSession(ps);
		}

		// Stuck worktree recovery: warn about sessions with worktreePath set but directory missing
		for (const ps of persisted) {
			if (ps.worktreePath && !fs.existsSync(ps.worktreePath)) {
				console.warn(`[session-manager] Session "${ps.title}" (${ps.id}) has worktreePath "${ps.worktreePath}" but directory does not exist`);
			}
		}

		// Clean up orphaned non-interactive sessions (e.g. reviewer sessions from
		// a prior server run whose verification harness tracking was lost on restart).
		// These sessions would otherwise sit idle forever since nothing is watching them.
		await this.cleanupOrphanedNonInteractiveSessions();
	}

	/**
	 * Terminate any non-interactive sessions (e.g. verification reviewers) that
	 * survived a server restart. Their in-memory verification tracking is gone,
	 * so they'll never be cleaned up by the verification harness.
	 */
	private async cleanupOrphanedNonInteractiveSessions(): Promise<void> {
		// Get session IDs that the verification harness will resume — skip those
		const resumingIds = this._verificationHarness?.getResumingSessionIds() ?? new Set<string>();

		const orphans: { id: string; projectId?: string }[] = [];
		const allLive = this.projectContextManager
			? [...this.projectContextManager.getAllLiveSessions()]
			: this.store.getLive();
		for (const ps of allLive) {
			if (ps.nonInteractive && !resumingIds.has(ps.id)) {
				orphans.push({ id: ps.id, projectId: ps.projectId });
			}
		}
		if (orphans.length === 0) return;

		console.log(`[session-manager] Cleaning up ${orphans.length} orphaned non-interactive session(s)...`);
		for (const { id, projectId } of orphans) {
			try {
				await this.terminateSession(id);
				console.log(`[session-manager] Terminated orphaned non-interactive session ${id}`);
			} catch (err) {
				// If terminate fails (e.g. session wasn't fully restored), archive directly
				console.warn(`[session-manager] Failed to terminate orphan ${id}, archiving:`, err);
				this.getSessionStore(projectId).archive(id);
			}
		}
	}

	private async restoreOneSession(ps: PersistedSession): Promise<void> {
		const sessionStore = this.getSessionStore(ps.projectId);
		if (!ps.agentSessionFile) {
			if (ps.worktreePath && ps.branch) {
				// Code may be recoverable — the branch exists in git
				console.warn(
					`[session-manager] Session ${ps.id} has no agentSessionFile but has worktree ` +
					`(branch: ${ps.branch}, path: ${ps.worktreePath}). ` +
					`Code may be recoverable. Archiving session — branch "${ps.branch}" preserved in git.`,
				);
				sessionStore.archive(ps.id);
			} else {
				console.log(`[session-manager] Removing ${ps.id} — no agent session file and no worktree`);
				sessionStore.remove(ps.id);
			}
			return;
		}
		if (!fs.existsSync(ps.agentSessionFile)) {
			console.log(`[session-manager] Removing ${ps.id} — agent session file missing: ${ps.agentSessionFile}`);
			sessionStore.remove(ps.id);
			return;
		}
		try {
			await this.restoreSession(ps);
			console.log(`[session-manager] Restored: "${ps.title}" (${ps.id})`);
		} catch (err) {
			console.error(`[session-manager] Failed to restore "${ps.title}" (${ps.id}), will retry next restart:`, err);
			this.addDormantSession(ps);
		}
	}

	private addDormantSession(ps: PersistedSession): void {
		this.sessions.set(ps.id, {
			id: ps.id,
			title: ps.title,
			cwd: ps.cwd,
			status: "terminated",
			createdAt: ps.createdAt,
			lastActivity: ps.lastActivity,
			clients: new Set(),
			rpcClient: new RpcBridge({ cwd: ps.cwd }), // placeholder, not started
			eventBuffer: new EventBuffer(),
			unsubscribe: () => {},
			isCompacting: false,
			titleGenerated: true,
			goalId: ps.goalId,
			delegateOf: ps.delegateOf,
			projectId: ps.projectId,
			promptQueue: new PromptQueue(ps.messageQueue),
		});
	}

	private async restoreSession(ps: PersistedSession): Promise<void> {
		const bridgeOptions: RpcBridgeOptions = { cwd: ps.cwd };
		if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;

		// Restore env vars needed by extensions
		bridgeOptions.env = { BOBBIT_SESSION_ID: ps.id };
		if (ps.goalId) {
			bridgeOptions.env.BOBBIT_GOAL_ID = ps.goalId;
		}
		if (ps.staffId) {
			bridgeOptions.env.BOBBIT_STAFF_ID = ps.staffId;
		}

		// ── Restore Docker sandbox wiring ──
		if (ps.sandboxed) {
			await this.applySandboxWiring(bridgeOptions, ps.id, { skipMountValidation: true });
		}

		// Restore extension args for goal/team sessions
		if (ps.goalId && !ps.assistantType) {
			const isTeamLead = ps.role === "team-lead";
			const extensionPath = isTeamLead
				? TEAM_LEAD_EXTENSION_PATH
				: GOAL_TOOLS_EXTENSION_PATH;
			bridgeOptions.args = ["--extension", extensionPath];
		}

		// Restore tool activation from role's allowedTools
		// Use overridden allowedTools if provided (session-only/one-time grants)
		const overrideAllowedTools: string[] | undefined = (ps as any)._overrideAllowedTools;
		if (ps.role && this.roleManager) {
			const role = this.roleManager.getRole(ps.role);
			let effectiveAllowed = overrideAllowedTools ?? this.resolveEffectiveAllowedTools(role);
			// Exclude bash_bg for sandboxed sessions — BgProcessManager spawns on host
			if (ps.sandboxed && effectiveAllowed.length > 0) {
				effectiveAllowed = effectiveAllowed.filter(t => t !== "bash_bg");
			}
			if (effectiveAllowed.length > 0) {
				const toolArgs = this.buildToolActivationArgs(ps.id, effectiveAllowed, role, ps.cwd);
				bridgeOptions.args = [...toolArgs, ...(bridgeOptions.args || [])];
			} else if (this.mcpManager) {
				const mcpExtPaths = writeMcpProxyExtensions(this.mcpManager);
				for (const extPath of mcpExtPaths) {
					bridgeOptions.args = [...(bridgeOptions.args || []), "--extension", extPath];
				}
			}
		}

		// Derive allowedTools from role so restored prompts filter tool docs correctly
		let restoredAllowedTools: string[] | undefined;
		if (overrideAllowedTools) {
			restoredAllowedTools = overrideAllowedTools;
		} else if (ps.role && this.roleManager) {
			const role = this.roleManager.getRole(ps.role);
			if (role) {
				const effective = this.resolveEffectiveAllowedTools(role);
				if (effective.length > 0) restoredAllowedTools = effective;
			}
		}

		// Re-assemble system prompt (global + AGENTS.md + goal spec)
		const assistantDef = ps.assistantType ? getAssistantDef(ps.assistantType) : undefined;
		if (assistantDef) {
			// Combine assistant role's shared prompt with per-type specialized prompt
			const assistantRole = this.roleManager?.getRole("assistant");
			let assistantGoalSpec = "";
			if (assistantRole?.promptTemplate) {
				assistantGoalSpec = assistantRole.promptTemplate.replace(/\{\{AGENT_ID\}\}/g, `assistant-${(ps.goalId || ps.id).slice(0, 8)}`);
				assistantGoalSpec += "\n\n---\n\n";
			}
			assistantGoalSpec += assistantDef.prompt;
			if (ps.assistantType === "goal") {
				assistantGoalSpec = assistantGoalSpec.replace('{{AVAILABLE_WORKFLOWS}}', this._buildWorkflowList());
				// Inject re-attempt context if this is a re-attempt session
				if (ps.reattemptGoalId) {
					const origGoal = this.resolveGoal(ps.reattemptGoalId);
					if (origGoal) {
						assistantGoalSpec += "\n\n" + buildReattemptContext(origGoal);
					}
				}
			}

			const promptPath = this.assemblePrompt(ps.id, {
				baseSystemPromptPath: undefined,
				cwd: ps.cwd,
				goalSpec: assistantGoalSpec,
				goalTitle: assistantDef.promptTitle,
				goalState: "active",
				allowedTools: restoredAllowedTools,
				projectConfigStore: this.projectConfigStore,
			});
			if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		} else {
			const goal = ps.goalId ? this.resolveGoal(ps.goalId) : undefined;
			// Resolve persisted personality names to prompt fragments
			const resolvedPersonalities = (ps.personalities && ps.personalities.length > 0 && this.personalityManager)
				? this.personalityManager.resolvePersonalities(ps.personalities)
				: undefined;

			// Re-attach role prompt for team agents (lost on restart since rolePrompt isn't persisted)
			const goalSpec = goal?.spec;
			let rolePrompt: string | undefined;
			let roleName: string | undefined;
			let toolRestrictionsText: string | undefined;
			if (ps.role && this.roleManager) {
				const role = this.roleManager.getRole(ps.role);
				if (role?.promptTemplate) {
					rolePrompt = role.promptTemplate;
					if (goal?.branch) rolePrompt = rolePrompt.replace(/\{\{GOAL_BRANCH\}\}/g, goal.branch);
					rolePrompt = rolePrompt.replace(/\{\{AGENT_ID\}\}/g, `${ps.role}-${(ps.goalId || ps.id).slice(0, 8)}`);
					rolePrompt = rolePrompt.replace(/\{\{AVAILABLE_ROLES\}\}/g, buildAvailableRolesList(this.roleManager));
					roleName = ps.role;
				}
				const effectiveTools = restoredAllowedTools ?? this.resolveEffectiveAllowedTools(role);
				if (effectiveTools && effectiveTools.length > 0) {
					toolRestrictionsText = this.buildToolRestrictionsText(effectiveTools, role);
				}
			}

			const promptPath = this.assemblePrompt(ps.id, {
				baseSystemPromptPath: this.systemPromptPath,
				cwd: ps.cwd,
				goalTitle: goal?.title,
				goalState: goal?.state,
				goalSpec,
				rolePrompt,
				roleName,
				toolRestrictions: toolRestrictionsText,
				personalities: resolvedPersonalities,
				allowedTools: restoredAllowedTools,
				projectConfigStore: this.projectConfigStore,
			});
			if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		}

		const rpcClient = new RpcBridge(bridgeOptions);
		const eventBuffer = new EventBuffer();

		const session: SessionInfo = {
			id: ps.id,
			title: ps.title,
			cwd: ps.cwd,
			status: "starting",
			createdAt: ps.createdAt,
			lastActivity: ps.lastActivity,
			clients: new Set(),
			rpcClient,
			eventBuffer,
			unsubscribe: () => {},
			isCompacting: false,
			titleGenerated: ps.title !== "New session",
			goalId: ps.goalId,
			assistantType: ps.assistantType,
			role: ps.role,
			teamGoalId: ps.teamGoalId,
			teamLeadSessionId: ps.teamLeadSessionId,
			worktreePath: ps.worktreePath,
			taskId: ps.taskId,
			staffId: ps.staffId,
			accessory: ps.accessory,
			preview: ps.preview,
			personalities: ps.personalities,
			allowedTools: restoredAllowedTools,
			promptQueue: new PromptQueue(ps.messageQueue),
			streamingStartedAt: ps.streamingStartedAt,
			projectId: ps.projectId,
		};

		// Skip cost tracking during session restore (switch_session replays
		// all historical message_update events which would double-count costs)
		let restoring = true;

		const restoreStore = this.getSessionStore(ps.projectId);
		const unsub = rpcClient.onEvent((event: any) => {
			session.lastActivity = Date.now();
			restoreStore.update(ps.id, { lastActivity: session.lastActivity });

			this.handleAgentLifecycle(session, event);

			eventBuffer.push(event);
			broadcast(session.clients, { type: "event", data: event });
			if (!restoring) this.trackCostFromEvent(session, event);
		});

		session.unsubscribe = unsub;

		await rpcClient.start();

		// Resume the agent's previous session file
		const switchSessionPath = ps.sandboxed ? hostToContainerSessionPath(ps.agentSessionFile) : ps.agentSessionFile;
		const switchTimeout = ps.sandboxed ? 60_000 : 15_000;
		const switchResp = await rpcClient.sendCommand(
			{ type: "switch_session", sessionPath: switchSessionPath },
			switchTimeout,
		);
		restoring = false;
		if (!switchResp.success) {
			await rpcClient.stop();
			throw new Error(`switch_session failed: ${switchResp.error}`);
		}

		session.status = "idle";
		this.sessions.set(ps.id, session);

		// If the agent was mid-turn when the server died, re-prompt it to continue
		if (ps.wasStreaming) {
			console.log(`[session-manager] Session "${ps.title}" (${ps.id}) was interrupted mid-turn — re-prompting to continue`);
			restoreStore.update(ps.id, { wasStreaming: false });
			rpcClient.prompt(
				"[SYSTEM: The infrastructure server restarted while you were mid-turn. " +
				"Your previous work has been preserved. Please continue where you left off. " +
				"Do NOT start over — review your recent messages and resume from the exact point of interruption.]"
			).catch((err: any) => {
				console.error(`[session-manager] Failed to re-prompt interrupted session ${ps.id}:`, err);
			});
		}
	}

	async createSession(cwd: string, agentArgs?: string[], goalId?: string, assistantType?: string, opts?: { rolePrompt?: string; roleName?: string; role?: string; accessory?: string; env?: Record<string, string>; taskId?: string; allowedTools?: string[]; personalities?: Array<{ label: string; promptFragment: string }>; personalityNames?: string[]; workflowContext?: string; worktreeOpts?: { repoPath: string }; reattemptGoalId?: string; sandboxed?: boolean; sandboxClaim?: ClaimOptions; projectId?: string }): Promise<SessionInfo> {
		const id = randomUUID();
		// Resolve projectId from opts or from the goal's project
		const projectId = opts?.projectId ?? (goalId ? this.resolveGoal(goalId)?.projectId : undefined);
		const ctx = this.buildPipelineContext(projectId);

		// ── Worktree: return a "preparing" session immediately, launch agent async ──
		if (opts?.worktreeOpts) {
			const repoPath = opts.worktreeOpts.repoPath;
			const slug = "new-session";
			const uuid8 = id.slice(0, 8);
			const branch = `session/${slug}-${uuid8}`;
			const wtRoot = path.resolve(repoPath, "..", `${path.basename(repoPath)}-wt`);
			const safeName = branch.replace(/\//g, "-");
			const worktreePath = path.join(wtRoot, safeName);

			const now = Date.now();
			const session: SessionInfo = {
				id,
				title: "New session",
				cwd, // temporary — will be updated when worktree is ready
				status: "preparing",
				createdAt: now,
				lastActivity: now,
				clients: new Set(),
				rpcClient: new RpcBridge({ cwd }), // placeholder, not started
				eventBuffer: new EventBuffer(),
				unsubscribe: () => {},
				isCompacting: false,
				titleGenerated: false,
				goalId,
				assistantType: undefined,
				taskId: opts?.taskId,
				personalities: opts?.personalityNames,
				allowedTools: opts?.allowedTools,
				role: opts?.role,
				accessory: opts?.accessory,
				worktreePath,
				projectId,
				promptQueue: new PromptQueue(),
			};

			this.sessions.set(id, session);

			// Build the plan for the worktree pipeline
			const plan: SessionSetupPlan = {
				id,
				mode: "worktree",
				title: "New session",
				cwd,
				goalId,
				taskId: opts?.taskId,
				worktreePath,
				repoPath,
				branch,
				sandboxed: opts?.sandboxed,
				personalities: opts?.personalityNames,
				role: opts?.role,
				accessory: opts?.accessory,
				agentArgs,
				env: opts?.env,
				rolePrompt: opts?.rolePrompt,
				roleName: opts?.roleName,
				personalityFragments: opts?.personalities,
				workflowContext: opts?.workflowContext,
				effectiveAllowedTools: opts?.allowedTools,
				sandboxClaim: opts?.sandboxClaim,
				bridgeOptions: { cwd },
			};

			// Persist immediately with all known structural fields
			persistOnce(session, plan, ctx.store);

			// Fire-and-forget: create worktree then complete pipeline
			executeWorktreeAsync(plan, session, ctx).then(() => {
				// Persist session metadata now that the agent is running
				this.persistSessionMetadata(session).catch((err) => {
					console.warn(`[session-manager] Early persist failed for worktree session ${session.id}:`, err);
				});
			}).catch((err) => {
				handleSetupFailure(session, plan, err, ctx);
			});

			return session;
		}

		// ── Normal session: build plan and execute full pipeline ──
		const plan: SessionSetupPlan = {
			id,
			mode: "normal",
			title: "New session",
			cwd,
			goalId,
			assistantType,
			taskId: opts?.taskId,
			sandboxed: opts?.sandboxed,
			personalities: opts?.personalityNames,
			role: opts?.role,
			accessory: opts?.accessory,
			agentArgs,
			env: opts?.env,
			rolePrompt: opts?.rolePrompt,
			roleName: opts?.roleName,
			personalityFragments: opts?.personalities,
			workflowContext: opts?.workflowContext,
			reattemptGoalId: opts?.reattemptGoalId,
			effectiveAllowedTools: opts?.allowedTools,
			sandboxClaim: opts?.sandboxClaim,
			bridgeOptions: { cwd },
		};

		const session = await executePlan(plan, ctx);
		if (projectId) session.projectId = projectId;

		// Persist session metadata (fire-and-forget)
		this.persistSessionMetadata(session).catch((err) => {
			console.warn(`[session-manager] Early persist failed for ${session.id}:`, err);
		});

		return session;
	}

	/**
	 * Create a delegate session — a real session that runs a task on behalf of a parent session.
	 * The delegate gets a system prompt built from AGENTS.md + instructions.
	 * After creation, the instructions are automatically sent as the first prompt.
	 * Returns the session info immediately (the prompt runs asynchronously).
	 */
	async createDelegateSession(parentSessionId: string, opts: {
		instructions: string;
		cwd: string;
		title?: string;
		context?: Record<string, string>;
	}): Promise<SessionInfo> {
		const id = randomUUID();
		// Resolve projectId from parent session
		const parentProjectId = this.sessions.get(parentSessionId)?.projectId
			?? this.resolveStoreForId(parentSessionId).get(parentSessionId)?.projectId;
		const ctx = this.buildPipelineContext(parentProjectId);

		// ── Sandbox propagation from parent ──
		const parentMeta = this.getSessionStore(parentProjectId).get(parentSessionId);
		let delegateSandboxed = false;
		if (parentMeta?.sandboxed) {
			// Always use the parent's validated host-side cwd — never trust the
			// cwd from the container.  The agent sends process.cwd() which is a
			// container-internal path (typically /workspace or a subdir).  Using
			// it directly would either fail (path doesn't exist on host) or, worse,
			// allow a malicious agent to mount an arbitrary host path into the
			// delegate container.
			opts.cwd = parentMeta.cwd;
			delegateSandboxed = true;
		}

		const titleSummary = opts.title || opts.instructions.split("\n")[0].slice(0, 60) || "Delegate";

		// Inherit tool access from parent session
		const parentSession = this.sessions.get(parentSessionId);
		const parentAllowedTools = parentSession?.allowedTools;

		const plan: SessionSetupPlan = {
			id,
			mode: "delegate",
			title: titleSummary,
			cwd: opts.cwd,
			delegateOf: parentSessionId,
			sandboxed: delegateSandboxed || undefined,
			instructions: opts.instructions,
			context: opts.context,
			effectiveAllowedTools: parentAllowedTools,
			bridgeOptions: { cwd: opts.cwd },
		};

		const session = await executePlan(plan, ctx);

		// Persist with all structural fields (delegateOf is in the initial put)
		this.persistSessionMetadata(session).catch((err) => {
			console.error(`[session-manager] Failed to persist delegate session ${id}:`, err);
		});

		if (parentProjectId) session.projectId = parentProjectId;

		// Send delegate prompt with 30s timeout
		await sendDelegatePrompt(session, opts.instructions, DELEGATE_SPAWN_TIMEOUT_MS);

		console.log(`[session-manager] Created delegate session ${id} (parent: ${parentSessionId}, status: ${session.status})`);
		return session;
	}

	/**
	 * Wait for a session to become idle (not streaming).
	 * Returns immediately if already idle.
	 * Rejects on timeout.
	 */
	waitForIdle(sessionId: string, timeoutMs = 600_000): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return Promise.reject(new Error("Session not found"));
		if (session.status === "idle") return Promise.resolve();

		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				unsub();
				reject(new Error(`Timeout waiting for session ${sessionId} to become idle`));
			}, timeoutMs);

			const unsub = session.rpcClient.onEvent((event: any) => {
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsub();
					resolve();
				}
				if (event.type === "process_exit") {
					clearTimeout(timer);
					unsub();
					const reason = event.signal ? `signal ${event.signal}` : `code ${event.code}`;
					reject(new Error(`Agent process exited unexpectedly (${reason}) for session ${sessionId}`));
				}
			});
		});
	}

	/**
	 * Get the final assistant output from a session's messages.
	 */
	async getSessionOutput(sessionId: string): Promise<string> {
		const session = this.sessions.get(sessionId);
		if (!session) return "";

		const msgsResp = await session.rpcClient.getMessages();
		if (!msgsResp.success) return "";

		const messages = msgsResp.data?.messages || msgsResp.data;
		if (!Array.isArray(messages)) return "";

		// Collect text from all assistant messages
		const texts: string[] = [];
		for (const msg of messages) {
			if (msg.role === "assistant") {
				const content = msg.content;
				if (typeof content === "string") {
					texts.push(content);
				} else if (Array.isArray(content)) {
					for (const block of content) {
						if (block.type === "text" && block.text) texts.push(block.text);
					}
				}
			}
		}
		return texts.join("\n\n");
	}

	/** Query the agent for its session file and save metadata to disk */
	/** After compaction, refresh messages and state for all connected clients. */
	async refreshAfterCompaction(session: SessionInfo): Promise<void> {
		try {
			const msgs = await session.rpcClient.getMessages();
			if (msgs.success) {
				broadcast(session.clients, { type: "messages", data: msgs.data });
			}
			const st = await session.rpcClient.getState();
			if (st.success) {
				broadcast(session.clients, { type: "state", data: st.data });
			}
		} catch (err) {
			console.error(`[session-manager] Failed to refresh after compaction for ${session.id}:`, err);
		}
	}

	/**
	 * Runs metadata persistence (and retries model/thinking if early setup missed).
	 * Called after the first agent turn completes.
	 */
	private async _finishSessionSetup(session: SessionInfo): Promise<void> {
		try {
			await this.persistSessionMetadata(session);
		} catch (err) {
			console.error(`[session-manager] Setup error for session ${session.id}:`, err);
		}
	}

	/**
	 * best-ranked model when gateway is configured, otherwise does nothing
	 * (pi-coding-agent uses its own built-in default).
	 */
	private async tryAutoSelectModel(session: SessionInfo): Promise<void> {
		if (!this.preferencesStore) return;

		// Check explicit preference first (works for both aigw and public providers)
		const sessionModelPref = this.preferencesStore.get("default.sessionModel") as string | undefined;
		if (sessionModelPref) {
			const slash = sessionModelPref.indexOf("/");
			if (slash > 0 && slash < sessionModelPref.length - 1) {
				const provider = sessionModelPref.slice(0, slash);
				const modelId = sessionModelPref.slice(slash + 1);
				try {
					await session.rpcClient.setModel(provider, modelId);
					this._writeModelNameFile(session.id, sessionModelPref);
					this.resolveStoreForSession(session.id).update(session.id, { modelProvider: provider, modelId });
					console.log(`[session-manager] Set preferred model "${sessionModelPref}" for session ${session.id}`);
					broadcast(session.clients, {
						type: "state",
						data: { model: { provider, id: modelId } },
					});
					return;
				} catch (err) {
					console.warn(`[session-manager] Preferred model "${sessionModelPref}" failed, falling back:`, err);
				}
			} else {
				console.warn(`[session-manager] Malformed default.sessionModel preference: "${sessionModelPref}", ignoring`);
			}
		}

		// Fall back to aigw best-ranked model when gateway is configured
		const aigwUrl = getAigwUrl(this.preferencesStore);
		if (!aigwUrl) return;

		let aigwModels;
		try {
			// Use cached model list if fresh (avoids HTTP round-trip per session)
			if (this._aigwModelCache && this._aigwModelCache.url === aigwUrl &&
				Date.now() - this._aigwModelCache.ts < SessionManager.AIGW_CACHE_TTL_MS) {
				aigwModels = this._aigwModelCache.models;
			} else {
				aigwModels = await discoverAigwModels(aigwUrl);
				this._aigwModelCache = { url: aigwUrl, models: aigwModels, ts: Date.now() };
			}
		} catch (err) {
			console.warn(`[session-manager] Failed to discover aigw models for auto-selection:`, err);
			return;
		}
		if (aigwModels.length === 0) return;

		try {
			const modelToUse = [...aigwModels].sort((a, b) => modelRecencyRank(b.id) - modelRecencyRank(a.id))[0];

			await session.rpcClient.setModel("aigw", modelToUse.id);
			this._writeModelNameFile(session.id, modelToUse.id);
			this.resolveStoreForSession(session.id).update(session.id, { modelProvider: "aigw", modelId: modelToUse.id });
			console.log(`[session-manager] Auto-selected aigw model "${modelToUse.id}" for session ${session.id}`);

			broadcast(session.clients, {
				type: "state",
				data: { model: { provider: "aigw", id: modelToUse.id } },
			});
		} catch (err) {
			console.warn(`[session-manager] Failed to auto-select model for ${session.id}:`, err);
		}
	}

	/** Apply default_thinking_level from preferences (per-model) or project config (legacy). */
	private async tryApplyDefaultThinkingLevel(session: SessionInfo): Promise<void> {
		// Prefer per-model thinking preference, fall back to project config, then "medium"
		let level: string | undefined;
		if (this.preferencesStore) {
			level = this.preferencesStore.get("default.sessionThinkingLevel") as string | undefined;
		}
		if (!level && this.projectConfigStore) {
			level = this.projectConfigStore.get("default_thinking_level");
		}
		// Default to "medium" when not configured — matches the Settings page
		// display default and ensures team/delegate agents get an explicit level
		// instead of relying on the agent's built-in default.
		if (!level) level = "medium";
		const valid = ["off", "minimal", "low", "medium", "high"];
		if (!valid.includes(level)) return;
		try {
			await session.rpcClient.setThinkingLevel(level);
			console.log(`[session-manager] Applied default thinking level "${level}" for session ${session.id}`);
		} catch (err) {
			console.warn(`[session-manager] Failed to apply default thinking level for ${session.id}:`, err);
		}
	}

	async persistSessionMetadata(session: SessionInfo): Promise<void> {
		const maxRetries = 3;
		const delays = [500, 1000, 2000];

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				const stateResp = await session.rpcClient.getState();
				if (!stateResp.success || !stateResp.data?.sessionFile) {
					if (attempt < maxRetries) {
						console.warn(`[session-manager] getState() returned no sessionFile for ${session.id}, retrying...`);
						await new Promise(resolve => setTimeout(resolve, delays[attempt]));
						continue;
					}
					console.error(
						`[session-manager] CRITICAL: Could not get agent session file for ${session.id} after ${maxRetries + 1} attempts. ` +
						`This session will NOT survive a server restart.`,
					);
					return;
				}

				const agentSessionFile = session.sandboxed
					? containerToHostSessionPath(stateResp.data.sessionFile)
					: stateResp.data.sessionFile;

				this.resolveStoreForSession(session.id).update(session.id, { agentSessionFile });
				return; // success
			} catch (err) {
				if (attempt < maxRetries) {
					console.warn(`[session-manager] persistSessionMetadata failed for ${session.id} (attempt ${attempt + 1}), retrying: ${err}`);
					await new Promise(resolve => setTimeout(resolve, delays[attempt]));
				} else {
					console.error(
						`[session-manager] CRITICAL: persistSessionMetadata failed for ${session.id} after ${maxRetries + 1} attempts: ${err}\n` +
						`  This session will NOT survive a server restart.`,
					);
				}
			}
		}
	}

	getSession(id: string): SessionInfo | undefined {
		return this.sessions.get(id);
	}

	/**
	 * Get the pending tool permission request for a session, if any.
	 * Used to send the permission card to newly connecting clients.
	 */
	getPendingToolPermission(id: string): { toolName: string; group: string; roleName: string; roleLabel: string; lastPromptText?: string } | undefined {
		const session = this.sessions.get(id);
		if (!session?.pendingGrantRequest) return undefined;
		const roleName = session.role || "general";
		const role = this.roleManager?.getRole(roleName);
		return {
			toolName: session.pendingGrantRequest.toolName,
			group: session.pendingGrantRequest.toolGroup,
			roleName: role?.name ?? roleName,
			roleLabel: role?.label ?? roleName,
			lastPromptText: session.lastPromptText,
		};
	}

	/**
	 * Register an externally-created RPC bridge as a viewable session.
	 * Used for LLM review sub-agents in verification harness so users can watch them live.
	 * Returns an unsubscribe function to call when the session ends.
	 */
	registerExternalSession(id: string, rpcClient: RpcBridge, opts: {
		title: string;
		cwd: string;
		role?: string;
		goalId?: string;
		teamGoalId?: string;
	}): () => void {
		const eventBuffer = new EventBuffer();
		const now = Date.now();

		const session: SessionInfo = {
			id,
			title: opts.title,
			cwd: opts.cwd,
			status: "idle",
			createdAt: now,
			lastActivity: now,
			clients: new Set(),
			rpcClient,
			eventBuffer,
			unsubscribe: () => {},
			isCompacting: false,
			titleGenerated: true,
			goalId: opts.goalId,
			role: opts.role,
			teamGoalId: opts.teamGoalId,
			promptQueue: new PromptQueue(),
		};

		const unsub = rpcClient.onEvent((event: any) => {
			session.lastActivity = Date.now();
			this.handleAgentLifecycle(session, event);
			eventBuffer.push(event);
			broadcast(session.clients, { type: "event", data: event });
			this.trackCostFromEvent(session, event);
		});
		session.unsubscribe = unsub;

		this.sessions.set(id, session);

		// Resolve project from goal
		const extProjectId = opts.goalId
			? this.projectContextManager?.getContextForGoal(opts.goalId)?.project.id
			: undefined;
		const extStore = extProjectId ? this.getSessionStore(extProjectId) : this.store;
		if (extProjectId) session.projectId = extProjectId;

		// Initial persist — structural fields (store.put must precede persistSessionMetadata
		// since persistSessionMetadata now only does store.update)
		extStore.put({
			id,
			title: opts.title,
			cwd: opts.cwd,
			agentSessionFile: "",
			createdAt: now,
			lastActivity: now,
			goalId: opts.goalId,
			role: opts.role,
			teamGoalId: opts.teamGoalId,
			nonInteractive: true,
			projectId: extProjectId,
		});

		// Then update with agentSessionFile
		this.persistSessionMetadata(session).catch((err) => {
			console.error(`[session-manager] Failed to persist external session ${id}:`, err);
		});

		console.log(`[session-manager] Registered external session ${id}: ${opts.title}`);

		return () => {
			unsub();
			session.status = "terminated";
			for (const client of session.clients) {
				client.close(1000, "Session terminated");
			}
			session.clients.clear();
			this.sessions.delete(id);
			extStore.remove(id);
			cleanupSessionPrompt(id);
			console.log(`[session-manager] Unregistered external session ${id}`);
		};
	}

	listSessions(): Array<{
		id: string;
		title: string;
		cwd: string;
		status: string;
		createdAt: number;
		lastActivity: number;
		clientCount: number;
		isCompacting: boolean;
		goalId?: string;
		assistantType?: string;
		goalAssistant?: boolean;
		roleAssistant?: boolean;
		toolAssistant?: boolean;
		delegateOf?: string;
		role?: string;
		teamGoalId?: string;
		teamLeadSessionId?: string;
		worktreePath?: string;
		taskId?: string;
		staffId?: string;
		accessory?: string;
		nonInteractive?: boolean;
		preview?: boolean;
		personalities?: string[];
		reattemptGoalId?: string;
		sandboxed?: boolean;
		projectId?: string;
	}> {
		return Array.from(this.sessions.values()).map((s) => {
			const ps = this.resolveStoreForSession(s.id).get(s.id);
			return {
				id: s.id,
				title: s.title,
				cwd: s.cwd,
				status: s.status,
				createdAt: s.createdAt,
				lastActivity: s.lastActivity,
				clientCount: s.clients.size,
				isCompacting: s.isCompacting,
				goalId: s.goalId,
				assistantType: s.assistantType,
				// Legacy boolean fields for backward compat
				goalAssistant: s.assistantType === "goal",
				roleAssistant: s.assistantType === "role",
				toolAssistant: s.assistantType === "tool",
				delegateOf: s.delegateOf,
				role: s.role,
				teamGoalId: s.teamGoalId,
				teamLeadSessionId: s.teamLeadSessionId,
				worktreePath: s.worktreePath,
				taskId: s.taskId,
				staffId: s.staffId,
				accessory: s.accessory,
				nonInteractive: s.nonInteractive,
				preview: s.preview,
				personalities: s.personalities,
				reattemptGoalId: ps?.reattemptGoalId,
				sandboxed: ps?.sandboxed || s.sandboxed,
				projectId: ps?.projectId || s.projectId,
			};
		});
	}

	/**
	 * Get all session IDs for a goal, including terminated sessions from the store.
	 * Useful for cost aggregation where terminated sessions still have cost data.
	 */
	getAllSessionIdsForGoal(goalId: string): string[] {
		const ids = new Set(
			Array.from(this.sessions.values())
				.filter((s) => s.goalId === goalId)
				.map((s) => s.id),
		);
		const allPersisted = this.projectContextManager
			? [...this.projectContextManager.all()].flatMap(ctx => ctx.sessionStore.getAll())
			: this.store.getAll();
		for (const ps of allPersisted) {
			if (ps.goalId === goalId) ids.add(ps.id);
		}
		return [...ids];
	}

	setTitle(id: string, title: string): boolean {
		const session = this.sessions.get(id);
		if (!session) return false;
		session.title = title;
		this.resolveStoreForSession(id).update(id, { title });
		broadcast(session.clients, { type: "session_title", sessionId: id, title });
		return true;
	}

	/**
	 * Generate an AI-summarized goal title and rename the session.
	 * Fire-and-forget — does NOT check titleGenerated (independent of first-message auto-title).
	 */
	generateGoalTitle(sessionId: string, goalTitle: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		this._generateGoalTitleAsync(session, goalTitle).catch(err => {
			console.error(`[session ${session.id}] Goal title generation failed:`, err);
		});
	}

	private async _generateGoalTitleAsync(session: SessionInfo, goalTitle: string): Promise<void> {
		const title = await generateGoalSummaryTitle(goalTitle, this.getTitleGenOptions());
		if (title) {
			const finalTitle = `New goal: ${title}`;
			session.title = finalTitle;
			this.resolveStoreForSession(session.id).update(session.id, { title: finalTitle });
			broadcast(session.clients, { type: "session_title", sessionId: session.id, title: finalTitle });
		}
	}

	/** Update session metadata fields (role, teamGoalId, worktreePath, accessory, teamLeadSessionId) and persist. */
	updateSessionMeta(id: string, updates: { role?: string; teamGoalId?: string; worktreePath?: string; accessory?: string; nonInteractive?: boolean; teamLeadSessionId?: string; delegateOf?: string }): boolean {
		const session = this.sessions.get(id);
		if (!session) {
			// Store-only session (dormant/delegate) — update store directly
			this.resolveStoreForId(id).update(id, updates);
			return true;
		}
		if (updates.role !== undefined) session.role = updates.role;
		if (updates.teamGoalId !== undefined) session.teamGoalId = updates.teamGoalId;
		if (updates.worktreePath !== undefined) session.worktreePath = updates.worktreePath;
		if (updates.accessory !== undefined) session.accessory = updates.accessory;
		if (updates.nonInteractive !== undefined) session.nonInteractive = updates.nonInteractive;
		if (updates.teamLeadSessionId !== undefined) session.teamLeadSessionId = updates.teamLeadSessionId;
		if (updates.delegateOf !== undefined) session.delegateOf = updates.delegateOf;
		this.resolveStoreForSession(id).update(id, updates);
		return true;
	}

	// ── Draft storage ──────────────────────────────────────────────

	/**
	 * Ensure the session has an entry in the persistent store.
	 * When a session is first created, store.put() is called asynchronously
	 * (fire-and-forget) so it may not have completed yet. This ensures
	 * draft operations work even before persistence is complete.
	 */
	private ensureStoreEntry(id: string): boolean {
		const session = this.sessions.get(id);
		if (!session) return false;
		const store = this.resolveStoreForSession(id);
		if (!store.get(id)) {
			store.put({
				id: session.id,
				title: session.title,
				cwd: session.cwd,
				agentSessionFile: "",
				createdAt: session.createdAt,
				lastActivity: session.lastActivity,
				goalId: session.goalId,
				sandboxed: session.sandboxed,
				projectId: session.projectId,
			});
		}
		return true;
	}

	/** Get a draft for a session by type. */
	getDraft(id: string, type: string): unknown | undefined {
		if (!this.ensureStoreEntry(id)) return undefined;
		return this.resolveStoreForSession(id).getDraft(id, type);
	}

	/** Set a draft for a session by type. Returns false if session not found. */
	setDraft(id: string, type: string, data: unknown): boolean {
		if (!this.ensureStoreEntry(id)) return false;
		return this.resolveStoreForSession(id).setDraft(id, type, data);
	}

	/** Delete a draft for a session by type. */
	deleteDraft(id: string, type: string): boolean {
		if (!this.ensureStoreEntry(id)) return false;
		return this.resolveStoreForSession(id).deleteDraft(id, type);
	}

	/**
	 * Assign a role to an existing session by killing the agent, reassembling
	 * the system prompt with the role instructions, and respawning with
	 * `switch_session` to preserve conversation history.
	 */
	async assignRole(id: string, role: { name: string; promptTemplate: string; accessory: string }, opts?: { personalities?: string[] }): Promise<boolean> {
		const session = this.sessions.get(id);
		if (!session) return false;
		if (session.status === "streaming") throw new Error("Cannot assign role while agent is streaming");

		// Get the agent session file so we can restore conversation
		let agentSessionFile: string | undefined;
		try {
			const stateResp = await session.rpcClient.getState();
			if (stateResp.success) agentSessionFile = stateResp.data?.sessionFile;
		} catch {
			const persisted = this.resolveStoreForSession(id).get(id);
			agentSessionFile = persisted?.agentSessionFile;
		}

		// Kill the current process
		session.unsubscribe();
		await session.rpcClient.stop();

		// Reassemble system prompt with role instructions as separate fields
		const goal = session.goalId ? this.resolveGoal(session.goalId) : undefined;
		const goalSpec = goal?.spec;
		let toolRestrictionsText: string | undefined;
		// Look up the full role (with toolPolicies) from roleManager if available
		const fullRole = this.roleManager?.getRole(role.name);
		const effectiveAllowed = this.resolveEffectiveAllowedTools(fullRole);
		if (effectiveAllowed.length > 0) {
			toolRestrictionsText = this.buildToolRestrictionsText(effectiveAllowed, fullRole);
		}

		// Resolve personalities for system prompt
		const personalityNames = opts?.personalities ?? session.personalities;
		const resolvedPersonalities = (personalityNames && personalityNames.length > 0 && this.personalityManager)
			? this.personalityManager.resolvePersonalities(personalityNames)
			: undefined;

		const promptPath = this.assemblePrompt(id, {
			baseSystemPromptPath: this.systemPromptPath,
			cwd: session.cwd,
			goalTitle: goal?.title,
			goalState: goal?.state,
			goalSpec,
			rolePrompt: role.promptTemplate,
			roleName: role.name,
			toolRestrictions: toolRestrictionsText,
			personalities: resolvedPersonalities,
			allowedTools: effectiveAllowed.length > 0 ? effectiveAllowed : undefined,
			projectConfigStore: this.projectConfigStore,
		});

		// Respawn with new system prompt
		const bridgeOptions: RpcBridgeOptions = { cwd: session.cwd };
		if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;
		if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		bridgeOptions.env = { BOBBIT_SESSION_ID: id };
		if (session.goalId) {
			bridgeOptions.env.BOBBIT_GOAL_ID = session.goalId;
			// Re-attach goal tools extension (unless this is a team lead, which gets it from team-manager)
			if (!bridgeOptions.args?.includes("--extension")) {
				bridgeOptions.args = ["--extension", GOAL_TOOLS_EXTENSION_PATH];
			}
		}

		// Apply tool activation args based on role's allowedTools
		if (effectiveAllowed.length > 0) {
			const toolArgs = this.buildToolActivationArgs(id, effectiveAllowed, fullRole, session.cwd);
			bridgeOptions.args = [...toolArgs, ...(bridgeOptions.args || [])];
		} else if (this.mcpManager) {
			const mcpExtPaths = writeMcpProxyExtensions(this.mcpManager);
			for (const extPath of mcpExtPaths) {
				bridgeOptions.args = [...(bridgeOptions.args || []), "--extension", extPath];
			}
		}

		const rpcClient = new RpcBridge(bridgeOptions);
		let switchingSession = true;
		const roleStore = this.resolveStoreForSession(id);
		const unsub = rpcClient.onEvent((event: any) => {
			session.lastActivity = Date.now();
			roleStore.update(id, { lastActivity: session.lastActivity });
			this.handleAgentLifecycle(session, event);
			session.eventBuffer.push(event);
			broadcast(session.clients, { type: "event", data: event });
			if (!switchingSession) this.trackCostFromEvent(session, event);
		});

		await rpcClient.start();

		// Restore conversation from session file
		if (agentSessionFile && fs.existsSync(agentSessionFile)) {
			const rolePersisted = roleStore.get(id);
			const roleSwitchPath = rolePersisted?.sandboxed ? hostToContainerSessionPath(agentSessionFile) : agentSessionFile;
			const switchResp = await rpcClient.sendCommand(
				{ type: "switch_session", sessionPath: roleSwitchPath },
				15_000,
			);
			if (!switchResp.success) {
				console.error(`[session-manager] switch_session failed after role assignment: ${switchResp.error}`);
			}
		}
		switchingSession = false;

		// Swap in the new bridge and update metadata
		session.rpcClient = rpcClient;
		session.unsubscribe = unsub;
		session.status = "idle";
		session.role = role.name;
		session.accessory = role.accessory;
		session.allowedTools = effectiveAllowed;
		if (opts?.personalities) session.personalities = opts.personalities;

		roleStore.update(id, { role: role.name, accessory: role.accessory, personalities: opts?.personalities });

		broadcast(session.clients, { type: "session_status", status: "idle" } as any);

		// Refresh messages and state for connected clients
		try {
			const msgs = await rpcClient.getMessages();
			if (msgs.success) broadcast(session.clients, { type: "messages", data: msgs.data });
			const st = await rpcClient.getState();
			if (st.success) broadcast(session.clients, { type: "state", data: st.data });
		} catch { /* best-effort */ }

		console.log(`[session-manager] Assigned role "${role.name}" to session ${id}`);
		return true;
	}

	/**
	 * Update personalities for an existing session by killing the agent,
	 * reassembling the system prompt with the new personalities, and respawning
	 * with `switch_session` to preserve conversation history.
	 */
	async updatePersonalities(id: string, personalityNames: string[]): Promise<boolean> {
		const session = this.sessions.get(id);
		if (!session) return false;
		if (session.status === "streaming") throw new Error("Cannot update personalities while agent is streaming");

		// Get the agent session file so we can restore conversation
		let agentSessionFile: string | undefined;
		try {
			const stateResp = await session.rpcClient.getState();
			if (stateResp.success) agentSessionFile = stateResp.data?.sessionFile;
		} catch {
			const persisted = this.resolveStoreForSession(id).get(id);
			agentSessionFile = persisted?.agentSessionFile;
		}

		// Kill the current process
		session.unsubscribe();
		await session.rpcClient.stop();

		// Reassemble system prompt with new personalities (preserving role prompt if assigned)
		const goal = session.goalId ? this.resolveGoal(session.goalId) : undefined;
		const goalSpec = goal?.spec;

		// If the session has a role, include its prompt template as separate fields
		let rolePrompt: string | undefined;
		let roleName: string | undefined;
		let toolRestrictionsText: string | undefined;
		let roleAllowedTools: string[] | undefined;
		if (session.role && this.roleManager) {
			const role = this.roleManager.getRole(session.role);
			if (role) {
				rolePrompt = role.promptTemplate;
				roleName = role.name;
				const effective = this.resolveEffectiveAllowedTools(role);
				if (effective.length > 0) {
					roleAllowedTools = effective;
					toolRestrictionsText = this.buildToolRestrictionsText(effective, role);
				}
			}
		}

		const resolvedPersonalities = (personalityNames.length > 0 && this.personalityManager)
			? this.personalityManager.resolvePersonalities(personalityNames)
			: undefined;

		const promptPath = this.assemblePrompt(id, {
			baseSystemPromptPath: this.systemPromptPath,
			cwd: session.cwd,
			goalTitle: goal?.title,
			goalState: goal?.state,
			goalSpec,
			rolePrompt,
			roleName,
			toolRestrictions: toolRestrictionsText,
			personalities: resolvedPersonalities,
			allowedTools: roleAllowedTools,
			projectConfigStore: this.projectConfigStore,
		});

		// Respawn with new system prompt
		const bridgeOptions: RpcBridgeOptions = { cwd: session.cwd };
		if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;
		if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		bridgeOptions.env = { BOBBIT_SESSION_ID: id };
		if (session.goalId) {
			bridgeOptions.env.BOBBIT_GOAL_ID = session.goalId;
			if (!bridgeOptions.args?.includes("--extension")) {
				bridgeOptions.args = ["--extension", GOAL_TOOLS_EXTENSION_PATH];
			}
		}

		// Restore tool activation from role's allowedTools
		if (session.role && this.roleManager) {
			const role = this.roleManager.getRole(session.role);
			const effective = this.resolveEffectiveAllowedTools(role);
			if (effective.length > 0) {
				const toolArgs = this.buildToolActivationArgs(id, effective, role, session.cwd);
				bridgeOptions.args = [...toolArgs, ...(bridgeOptions.args || [])];
			} else if (this.mcpManager) {
				const mcpExtPaths = writeMcpProxyExtensions(this.mcpManager);
				for (const extPath of mcpExtPaths) {
					bridgeOptions.args = [...(bridgeOptions.args || []), "--extension", extPath];
				}
			}
		}

		const rpcClient = new RpcBridge(bridgeOptions);
		let switchingSession = true;
		const persoStore = this.resolveStoreForSession(id);
		const unsub = rpcClient.onEvent((event: any) => {
			session.lastActivity = Date.now();
			persoStore.update(id, { lastActivity: session.lastActivity });
			this.handleAgentLifecycle(session, event);
			session.eventBuffer.push(event);
			broadcast(session.clients, { type: "event", data: event });
			if (!switchingSession) this.trackCostFromEvent(session, event);
		});

		await rpcClient.start();

		if (agentSessionFile && fs.existsSync(agentSessionFile)) {
			const persoPersisted = persoStore.get(id);
			const persoSwitchPath = persoPersisted?.sandboxed ? hostToContainerSessionPath(agentSessionFile) : agentSessionFile;
			const switchResp = await rpcClient.sendCommand(
				{ type: "switch_session", sessionPath: persoSwitchPath },
				15_000,
			);
			if (!switchResp.success) {
				console.error(`[session-manager] switch_session failed after personality update: ${switchResp.error}`);
			}
		}
		switchingSession = false;

		// Swap in the new bridge and update metadata
		session.rpcClient = rpcClient;
		session.unsubscribe = unsub;
		session.status = "idle";
		session.personalities = personalityNames;

		persoStore.update(id, { personalities: personalityNames });

		broadcast(session.clients, { type: "session_status", status: "idle" } as any);

		// Refresh messages and state for connected clients
		try {
			const msgs = await rpcClient.getMessages();
			if (msgs.success) broadcast(session.clients, { type: "messages", data: msgs.data });
			const st = await rpcClient.getState();
			if (st.success) broadcast(session.clients, { type: "state", data: st.data });
		} catch { /* best-effort */ }

		console.log(`[session-manager] Updated personalities for session ${id}: [${personalityNames.join(", ")}]`);
		return true;
	}

	/**
	 * Generate a title for a session on the first user prompt.
	 * Called immediately when the user sends a message, not after the agent replies.
	 */
	tryGenerateTitleFromPrompt(sessionId: string, userText: string): void {
		const session = this.sessions.get(sessionId);
		if (!session || session.titleGenerated) return;
		session.titleGenerated = true;

		// Fire-and-forget
		this.autoGenerateTitleFromText(session, userText).catch((err) => {
			console.error(`[session ${session.id}] Title generation failed:`, err);
		});
	}

	private getTitleGenOptions(): import("./title-generator.js").TitleGenOptions {
		const namingModel = this.preferencesStore?.get("default.namingModel") as string | undefined;
		const aigwUrl = this.preferencesStore ? getAigwUrl(this.preferencesStore) : undefined;
		const namingThinking = this.preferencesStore?.get("default.namingThinkingLevel") as string | undefined;
		return { namingModel: namingModel || undefined, aigwUrl, thinkingLevel: namingThinking || undefined };
	}

	private async autoGenerateTitleFromText(session: SessionInfo, userText: string): Promise<void> {
		const messages = [{ role: "user", content: userText }];
		const title = await generateSessionTitle(messages, this.getTitleGenOptions());
		if (title) {
			session.title = title;
			this.resolveStoreForSession(session.id).update(session.id, { title });
			broadcast(session.clients, { type: "session_title", sessionId: session.id, title });
		}
	}

	async autoGenerateTitle(session: SessionInfo): Promise<void> {
		try {
			const msgsResp = await session.rpcClient.getMessages();
			if (!msgsResp.success) return;

			const messages = msgsResp.data?.messages || msgsResp.data;
			if (!Array.isArray(messages) || messages.length === 0) return;

			const title = await generateSessionTitle(messages, this.getTitleGenOptions());
			if (title) {
				session.title = title;
				this.resolveStoreForSession(session.id).update(session.id, { title });
				broadcast(session.clients, { type: "session_title", sessionId: session.id, title });
			}
		} catch (err) {
			console.error(`[session ${session.id}] Title generation failed:`, err);
		}
	}

	/**
	 * Ensure a session's subprocess is alive. If the session is terminated or
	 * dormant, attempt to restore it from persisted data.
	 * Throws if the session cannot be restored.
	 */
	async ensureSessionAlive(sessionId: string): Promise<void> {
		const existing = this.sessions.get(sessionId);
		if (existing && existing.status !== "terminated") return; // already alive

		// Try to restore from persisted data
		const persisted = this.resolveStoreForId(sessionId).get(sessionId);
		if (!persisted) {
			throw new Error(`Cannot restore session ${sessionId}: no persisted data found`);
		}
		await this.restoreSession(persisted);
		console.log(`[session-manager] Restored session ${sessionId} via ensureSessionAlive`);
	}

	/** Write the human-readable model name to a file so shell extensions can read it at commit time. */
	private _writeModelNameFile(sessionId: string, modelId: string): void {
		try {
			const filePath = path.join(bobbitStateDir(), "model-name-" + sessionId + ".txt");
			fs.writeFileSync(filePath, deriveName(modelId), "utf-8");
		} catch (err) {
			console.warn(`[session-manager] Failed to write model name file for ${sessionId}:`, err);
		}
	}

	/** Update the model name file for a session (called from WS handler on setModel). */
	updateModelNameFile(sessionId: string, modelId: string): void {
		this._writeModelNameFile(sessionId, modelId);
	}

	/** Persist model provider/id so archived sessions can display model info. */
	persistSessionModel(sessionId: string, provider: string, modelId: string): void {
		this.resolveStoreForSession(sessionId).update(sessionId, { modelProvider: provider, modelId });
	}

	async terminateSession(id: string): Promise<boolean> {
		const session = this.sessions.get(id);
		if (!session) return false;

		// Cascade: terminate all delegate (child) sessions first
		const children = [...this.sessions.values()].filter(s => s.delegateOf === id);
		for (const child of children) {
			console.log(`[session ${id}] Cascading terminate to delegate ${child.id}`);
			await this.terminateSession(child.id);
		}
		// Also archive persisted-but-not-in-memory delegate sessions
		const allLiveForTerminate = this.projectContextManager
			? [...this.projectContextManager.getAllLiveSessions()]
			: this.store.getLive();
		for (const ps of allLiveForTerminate) {
			if (ps.delegateOf === id && !this.sessions.has(ps.id)) {
				this.getSessionStore(ps.projectId).archive(ps.id);
			}
		}

		// Resolve any pending grant request so the guard's long-poll returns immediately
		if (session.pendingGrantRequest) {
			clearTimeout(session.pendingGrantRequest.timer);
			session.pendingGrantRequest.resolve({ granted: false });
			session.pendingGrantRequest = undefined;
		}

		session.unsubscribe();
		await session.rpcClient.stop();
		session.status = "terminated";

		// Release pooled container back to the pool
		if (session.containerId && this.sandboxPool) {
			this.sandboxPool.release(session.id, session.containerId).catch(err => {
				console.warn(`[session-manager] Sandbox pool release failed for ${session.id}:`, err);
			});
		}

		// Clean up background processes
		if ((this as any).bgProcessManager) {
			(this as any).bgProcessManager.cleanup(id);
		}

		// Clean up sandbox token
		if (this.sandboxTokenStore) {
			this.sandboxTokenStore.remove(id);
		}

		// Clean up model name file
		try {
			const modelNameFile = path.join(bobbitStateDir(), "model-name-" + id + ".txt");
			if (fs.existsSync(modelNameFile)) fs.unlinkSync(modelNameFile);
		} catch { /* ignore */ }

		// Broadcast session_archived event before closing clients
		const archivedAt = Date.now();
		broadcast(session.clients, { type: "session_archived", sessionId: id, archivedAt });

		for (const client of session.clients) {
			client.close(1000, "Session terminated");
		}
		session.clients.clear();

		this.sessions.delete(id);
		// Archive the session — keep metadata for 7 days.
		// But sessions with no agentSessionFile are unrestorable, so just remove them.
		const terminateStore = this.resolveStoreForSession(id);
		const persisted = terminateStore.get(id);
		if (persisted?.agentSessionFile) {
			terminateStore.archive(id);
		} else {
			terminateStore.remove(id);
		}
		// Don't remove color or session prompt — they're needed for archived view
		return true;
	}

	/** Get persisted session metadata by ID (live or dormant). */
	getPersistedSession(id: string): PersistedSession | undefined {
		return this.resolveStoreForId(id).get(id);
	}

	/** Get an archived session's metadata. */
	getArchivedSession(id: string): PersistedSession | undefined {
		const ps = this.resolveStoreForId(id).get(id);
		return ps?.archived ? ps : undefined;
	}

	/** Archive a session directly in the store (for dormant/store-only sessions). */
	storeArchive(id: string): boolean {
		return this.resolveStoreForId(id).archive(id);
	}

	/** Update metadata on an archived session (stored in the session store). */
	updateArchivedMeta(id: string, updates: { teamLeadSessionId?: string }): boolean {
		const store = this.resolveStoreForId(id);
		const ps = store.get(id);
		if (!ps?.archived) return false;
		store.update(id, updates);
		return true;
	}

	/** Parse the .jsonl file for an archived session and return messages. */
	getArchivedMessages(id: string): unknown[] {
		const ps = this.resolveStoreForId(id).get(id);
		if (!ps?.archived || !ps.agentSessionFile) return [];
		try {
			if (!fs.existsSync(ps.agentSessionFile)) return [];
			const content = fs.readFileSync(ps.agentSessionFile, "utf-8");
			const lines = content.trim().split("\n");
			const messages: unknown[] = [];
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const entry = JSON.parse(line);
					// Extract chat messages (user and assistant messages)
					if (entry.type === "message" && entry.message) {
						messages.push(entry.message);
					}
				} catch {
					// Skip malformed lines
				}
			}
			return messages;
		} catch {
			return [];
		}
	}

	/** List archived sessions in the same format as listSessions(). */
	listArchivedSessions(): Array<{
		id: string;
		title: string;
		cwd: string;
		status: string;
		createdAt: number;
		lastActivity: number;
		clientCount: number;
		isCompacting: boolean;
		goalId?: string;
		assistantType?: string;
		delegateOf?: string;
		role?: string;
		teamGoalId?: string;
		teamLeadSessionId?: string;
		worktreePath?: string;
		taskId?: string;
		staffId?: string;
		accessory?: string;
		preview?: boolean;
		personalities?: string[];
		reattemptGoalId?: string;
		sandboxed?: boolean;
		archived: boolean;
		archivedAt?: number;
	}> {
		const allArchived = this.projectContextManager
			? [...this.projectContextManager.all()].flatMap(ctx => ctx.sessionStore.getArchived())
			: this.store.getArchived();
		return allArchived.map((ps) => ({
			id: ps.id,
			title: ps.title,
			cwd: ps.cwd,
			status: "archived",
			createdAt: ps.createdAt,
			lastActivity: ps.lastActivity,
			clientCount: 0,
			isCompacting: false,
			goalId: ps.goalId,
			assistantType: ps.assistantType,
			delegateOf: ps.delegateOf,
			role: ps.role,
			teamGoalId: ps.teamGoalId,
			teamLeadSessionId: ps.teamLeadSessionId,
			worktreePath: ps.worktreePath,
			taskId: ps.taskId,
			staffId: ps.staffId,
			accessory: ps.accessory,
			preview: ps.preview,
			personalities: ps.personalities,
			reattemptGoalId: ps.reattemptGoalId,
			sandboxed: ps.sandboxed,
			archived: true,
			archivedAt: ps.archivedAt,
		}));
	}

	/** Permanently purge a single archived session immediately. */
	async purgeArchivedSession(id: string): Promise<boolean> {
		const ps = this.resolveStoreForId(id).get(id);
		if (!ps?.archived) return false;
		await this.purgeOneSession(ps);
		return true;
	}

	/** Purge all archived sessions older than 7 days. */
	async purgeExpiredArchives(): Promise<void> {
		const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
		const cutoff = Date.now() - SEVEN_DAYS_MS;
		const archived = this.projectContextManager
			? [...this.projectContextManager.all()].flatMap(ctx => ctx.sessionStore.getArchived())
			: this.store.getArchived();
		for (const ps of archived) {
			if (ps.archivedAt && ps.archivedAt < cutoff) {
				try {
					await this.purgeOneSession(ps);
					console.log(`[session-manager] Purged expired archive: "${ps.title}" (${ps.id})`);
				} catch (err) {
					console.error(`[session-manager] Failed to purge archive ${ps.id}:`, err);
				}
			}
		}
	}

	/** Internal: purge a single archived session — delete files, worktree, store entry. */
	private async purgeOneSession(ps: PersistedSession): Promise<void> {
		// Remove from search index
		try {
			const purgeSearchIndex = this.resolveSearchIndex(ps);
			purgeSearchIndex.removeMessagesForSession(ps.id);
			purgeSearchIndex.removeSession(ps.id);
		} catch (err) {
			console.error(`[session-manager] Failed to remove session ${ps.id} from search index:`, err);
		}

		// Delete .jsonl file
		try {
			if (ps.agentSessionFile && fs.existsSync(ps.agentSessionFile)) {
				fs.unlinkSync(ps.agentSessionFile);
			}
		} catch (err) {
			console.error(`[session-manager] Failed to delete .jsonl for ${ps.id}:`, err);
		}

		// Delete session prompt file
		try {
			cleanupSessionPrompt(ps.id);
		} catch (err) {
			console.error(`[session-manager] Failed to cleanup prompt for ${ps.id}:`, err);
		}

		// Clean up worktree
		if (ps.worktreePath && ps.repoPath) {
			try {
				const { cleanupWorktree } = await import("../skills/git.js");
				await cleanupWorktree(ps.repoPath, ps.worktreePath, ps.branch, true);
			} catch (err) {
				console.error(`[session-manager] Failed to cleanup worktree for ${ps.id}:`, err);
			}
		}

		// Remove color
		try {
			this.colorStore?.remove(ps.id);
		} catch (err) {
			console.error(`[session-manager] Failed to remove color for ${ps.id}:`, err);
		}

		// Remove from store
		this.resolveStoreForId(ps.id).purge(ps.id);
	}

	/** Start the archive purge schedule — call after restoreSessions(). */
	startPurgeSchedule(): void {
		// Purge on startup
		this.purgeExpiredArchives().catch(err => {
			console.error("[session-manager] Startup purge failed:", err);
		});
		// Purge every 24 hours
		this.purgeInterval = setInterval(() => {
			this.purgeExpiredArchives().catch(err => {
				console.error("[session-manager] Scheduled purge failed:", err);
			});
		}, 24 * 60 * 60 * 1000);
	}

	addClient(sessionId: string, ws: WebSocket): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;

		// If session is dormant (failed restore), try to revive it
		if (session.status === "terminated") {
			const ps = this.resolveStoreForId(sessionId).get(sessionId);
			if (ps && fs.existsSync(ps.agentSessionFile)) {
				console.log(`[session-manager] Client connected to dormant session "${session.title}" — attempting restore`);
				this.restoreSession(ps)
					.then(() => {
						console.log(`[session-manager] Revived dormant session: "${session.title}" (${sessionId})`);
						// restoreSession replaces the map entry — add client to the new one
						const revived = this.sessions.get(sessionId);
						if (revived) revived.clients.add(ws);
					})
					.catch((err) => {
						console.error(`[session-manager] Failed to revive session ${sessionId}:`, err);
					});
				return true; // optimistically accept the client
			}
		}

		session.clients.add(ws);

		// Note: tool_execution_update events from the heartbeat will flow to
		// this client naturally via the broadcast in the event listener.
		// The message-list renders partial results from toolPartialResults,
		// so no event replay is needed — the next heartbeat (every 3s) will
		// populate the state.

		return true;
	}

	removeClient(sessionId: string, ws: WebSocket): void {
		const session = this.sessions.get(sessionId);
		if (session) {
			session.clients.delete(ws);
		}
	}

	/**
	 * Abort the agent. If the graceful abort doesn't resolve within a timeout,
	 * force-kill the agent process and restart it so the session remains usable.
	 */
	async forceAbort(id: string, gracePeriodMs = 3000): Promise<void> {
		const session = this.sessions.get(id);
		if (!session) return;

		// If not streaming, nothing to abort
		if (session.status !== "streaming") return;

		// Try graceful abort first
		try {
			await session.rpcClient.abort();
		} catch {
			// Abort RPC itself may fail/timeout — proceed to force kill
		}

		// Wait for the agent to become idle
		const settled = await new Promise<boolean>((resolve) => {
			if (session.status !== "streaming") {
				resolve(true);
				return;
			}
			const timer = setTimeout(() => {
				unsub();
				resolve(false);
			}, gracePeriodMs);
			const unsub = session.rpcClient.onEvent((event: any) => {
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsub();
					resolve(true);
				}
			});
		});

		if (settled) return;

		// Graceful abort didn't work — force kill and restart the agent
		console.log(`[session-manager] Force-aborting session ${id} — killing agent process`);

		// Get the agent session file before killing so we can restore
		let agentSessionFile: string | undefined;
		try {
			const stateResp = await session.rpcClient.getState();
			if (stateResp.success) {
				agentSessionFile = stateResp.data?.sessionFile;
			}
		} catch {
			// Process may be unresponsive — try the persisted store
			const persisted = this.resolveStoreForSession(id).get(id);
			agentSessionFile = persisted?.agentSessionFile;
		}

		// Kill the process
		session.unsubscribe();
		await session.rpcClient.stop();

		// Emit agent_end so clients know streaming stopped
		session.status = "idle";
		broadcast(session.clients, { type: "event", data: { type: "agent_end", messages: [] } });
		broadcast(session.clients, { type: "session_status", status: "idle" });

		// Restart the agent process
		try {
			const bridgeOptions: RpcBridgeOptions = { cwd: session.cwd };
			if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;
			if (this.systemPromptPath) bridgeOptions.systemPromptPath = this.systemPromptPath;
			bridgeOptions.env = { BOBBIT_SESSION_ID: id };

			// Restore goal extension
			if (session.goalId) {
				bridgeOptions.env.BOBBIT_GOAL_ID = session.goalId;
				const isTeamLead = session.role === "team-lead";
				const extensionPath = isTeamLead
					? TEAM_LEAD_EXTENSION_PATH
					: GOAL_TOOLS_EXTENSION_PATH;
				bridgeOptions.args = ["--extension", extensionPath];
			}

			// Restore tool activation from role's allowedTools
			if (session.role && this.roleManager) {
				const role = this.roleManager.getRole(session.role);
				const effective = this.resolveEffectiveAllowedTools(role);
				if (effective.length > 0) {
					const toolArgs = this.buildToolActivationArgs(id, effective, role, session.cwd);
					bridgeOptions.args = [...toolArgs, ...(bridgeOptions.args || [])];
				} else if (this.mcpManager) {
					const mcpExtPaths = writeMcpProxyExtensions(this.mcpManager);
					for (const extPath of mcpExtPaths) {
						bridgeOptions.args = [...(bridgeOptions.args || []), "--extension", extPath];
					}
				}
			}

			const rpcClient = new RpcBridge(bridgeOptions);
			let switchingSession = true;
			const abortStore = this.resolveStoreForSession(id);
			const unsub = rpcClient.onEvent((event: any) => {
				session.lastActivity = Date.now();
				abortStore.update(id, { lastActivity: session.lastActivity });

				this.handleAgentLifecycle(session, event);

				session.eventBuffer.push(event);
				broadcast(session.clients, { type: "event", data: event });
				if (!switchingSession) this.trackCostFromEvent(session, event);
			});

			await rpcClient.start();

			// Resume session if we have the session file
			if (agentSessionFile && fs.existsSync(agentSessionFile)) {
				const abortPersisted = abortStore.get(id);
				const abortSwitchPath = abortPersisted?.sandboxed ? hostToContainerSessionPath(agentSessionFile) : agentSessionFile;
				const switchResp = await rpcClient.sendCommand(
					{ type: "switch_session", sessionPath: abortSwitchPath },
					15_000,
				);
				if (!switchResp.success) {
					console.error(`[session-manager] switch_session failed after force abort: ${switchResp.error}`);
				}
			}
			switchingSession = false;

			// Swap in the new bridge
			session.rpcClient = rpcClient;
			session.unsubscribe = unsub;
			session.status = "idle";
			console.log(`[session-manager] Session ${id} agent restarted after force abort`);
		} catch (err) {
			console.error(`[session-manager] Failed to restart agent after force abort:`, err);
			session.status = "terminated";
			broadcast(session.clients, { type: "session_status", status: "terminated" });
		}
	}

	async shutdown(): Promise<void> {
		if (this.purgeInterval) {
			clearInterval(this.purgeInterval);
			this.purgeInterval = null;
		}

		// Don't remove from store on shutdown — sessions should survive restart.
		// Persist the streaming state for each session so interrupted agents
		// can be re-prompted on the next startup.
		const ids = Array.from(this.sessions.keys());
		for (const id of ids) {
			const session = this.sessions.get(id);
			if (!session) continue;

			// Snapshot the current streaming state before we kill the process.
			// This is authoritative — the in-memory status is always correct,
			// and we write it here to handle the case where shutdown() races
			// with a pending agent_end that hasn't flushed to disk yet.
			this.resolveStoreForSession(id).update(id, { wasStreaming: session.status === "streaming", streamingStartedAt: session.streamingStartedAt });

			session.unsubscribe();
			await session.rpcClient.stop();
			session.status = "terminated";

			for (const client of session.clients) {
				client.close(1000, "Server shutting down");
			}
			session.clients.clear();
			this.sessions.delete(id);
		}

		// Flush any debounced store writes before exit
		if (this.projectContextManager) {
			for (const ctx of this.projectContextManager.all()) ctx.sessionStore.flush();
		} else {
			this.store.flush();
		}

		// Close search index
		try {
			if (this.projectContextManager) {
				// ProjectContextManager.closeAll() handles search index closing
			} else {
				this.searchIndex.close();
			}
		} catch (err) {
			console.error("[search] Failed to close search index:", err);
		}
	}
}

// ── Sandbox credential auto-resolution ─────────────────────────────

/**
 * Map of auth.json provider keys → env vars that pi-coding-agent checks.
 * OAuth providers use their OAuth token env var; API-key providers use the standard key var.
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
 * Resolve API credentials from the host's auth.json + env vars + preferences store.
 * Returns a map of env var names → values to inject into the sandbox container.
 * Manual sandbox_credentials always take precedence (merged on top by caller).
 */
function resolveHostApiCredentials(prefs?: import("./preferences-store.js").PreferencesStore | null): Record<string, string> {
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
		// Skip if the host env var is already set (will be inherited by docker)
		// Actually docker exec doesn't inherit host env — we need to pass explicitly
		// But check host env as a credential source
		const hostEnvVal = process.env[envVar];
		if (hostEnvVal) {
			result[envVar] = hostEnvVal;
			continue;
		}

		// Check preferences store (migrated provider keys from UI)
		if (prefs) {
			const storedKey = prefs.get(`providerKey.${provider}`) as string | undefined;
			if (storedKey) {
				result[envVar] = storedKey;
				continue;
			}
		}

		// Check auth.json
		if (authData && authData[provider]) {
			const key = extractKey(authData[provider]);
			if (key) {
				result[envVar] = key;
			}
		}
	}

	return result;
}
