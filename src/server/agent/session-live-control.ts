/**
 * Live session client attachment and interruption control - SessionManager decomposition cohort 15.
 *
 * SessionManager keeps same-named wrappers for callers and source-shape tests,
 * while dormant client revive, client tracking, soft abort, and force-abort
 * respawn behavior live here.
 */
import type { WebSocket } from "ws";
import type { SessionInfo } from "./session-manager.js";
import {
	canResumeClaudeCodeSession,
	emitSessionEvent,
	isUserVisibleActivity,
	switchSessionPathForAgent,
} from "./session-manager.js";
import type { SessionStore, PersistedSession } from "./session-store.js";
import type { RpcBridgeOptions, RuntimePiExtensionInfo } from "./rpc-bridge.js";
import { assertRuntimeAllowedForSession, createSessionBridge, hydrateRuntimeOptions, resolveSessionRuntime } from "./session-runtime.js";
import { sessionFileExists, sessionFsContextForAgentFile } from "./session-fs.js";
import { sanitizeAgentTranscriptFile, trustPersistedAgentSessionFile } from "./transcript-sanitizer.js";
import { broadcastStatus } from "./session-status.js";
import { truncateLargeToolContent } from "./truncate-large-content.js";
import { tagAllowedTool, type EffectiveTool } from "./tool-activation.js";
import type { SessionSecretStore } from "../auth/session-secret.js";
import type { SandboxManager } from "./sandbox-manager.js";
import type { ToolManager } from "./tool-manager.js";
import type { GrantPolicy, Role } from "./role-store.js";
import type { ClaudeCodeConfig } from "./claude-code-config.js";

type CancelAutoRetryReason = "explicit-retry" | "new-prompt" | "terminated" | "shutdown";
type ToolActivationRole = { toolPolicies?: Record<string, GrantPolicy> };

export interface SessionLiveControlDeps {
	getSessions(): Map<string, SessionInfo>;
	getAgentCliPath(): string | undefined;
	getSystemPromptPath(): string | undefined;
	getToolManager(): ToolManager | undefined;
	getSessionSecretStore(): SessionSecretStore;
	getSandboxManager(): SandboxManager | null;
	resolveStoreForId(id: string): SessionStore | null;
	resolveStoreForSession(id: string): SessionStore;
	trackConnectedSession(session: SessionInfo): void;
	restoreSessionCoalesced(ps: PersistedSession): Promise<SessionInfo | undefined>;
	cancelPendingAutoRetry(session: SessionInfo, reason: CancelAutoRetryReason): void;
	reconcileAfterAbort(session: SessionInfo): void;
	coalesceRestore(id: string, fn: (generation: number) => Promise<SessionInfo | undefined>): Promise<SessionInfo | undefined>;
	applySandboxWiring(bridgeOptions: RpcBridgeOptions, id: string, sandboxOpts?: { projectId?: string; goalId?: string; sandboxBranch?: string; sandboxBaseBranch?: string; sandboxCwdOffset?: string }): Promise<boolean>;
	applyScopedGatewayCredentials(bridgeOptions: RpcBridgeOptions, sessionId: string, projectId: string | undefined, goalId?: string): void;
	getTeamLeadExtensionPath(): string;
	getGoalToolsExtensionPath(): string;
	getProposalToolsExtensionPath(): string;
	resolveSessionRole(roleName?: string, assistantType?: string, projectId?: string): Role | undefined;
	resolveEffectiveAllowedTools(role: Role | undefined): EffectiveTool[];
	ensureMcpManagerForContext(projectId?: string, cwd?: string): Promise<unknown>;
	buildToolActivationArgs(sessionId: string, allowedTools: EffectiveTool[] | undefined, role: ToolActivationRole | undefined, cwd: string, projectId?: string, effectiveGoalId?: string, grantedTools?: string[]): { args: string[]; env: Record<string, string>; runtimeExtensions: RuntimePiExtensionInfo[] };
	resolveInitialModel(role: string | undefined, projectId: string | undefined): string | undefined;
	resolveInitialThinkingLevel(role: string | undefined, projectId: string | undefined): string | undefined;
	applyDirectProviderEnv(bridgeOptions: RpcBridgeOptions, sandboxed: boolean | undefined, provider?: string): void;
	readClaudeCodeConfigForProject(projectId?: string): ClaudeCodeConfig | undefined;
	handleAgentLifecycle(session: SessionInfo, event: any): void;
	trackCostFromEvent(session: SessionInfo, event: any): void;
	recordPiExtensionDiagnostic(session: SessionInfo, diagnostic: unknown, extension: RuntimePiExtensionInfo): void;
	tryAutoSelectModel(session: SessionInfo): Promise<void>;
	drainQueue(session: SessionInfo): void;
}

export class SessionLiveControl {
	constructor(private readonly deps: SessionLiveControlDeps) {}

	private get sessions(): Map<string, SessionInfo> { return this.deps.getSessions(); }
	private get agentCliPath(): string | undefined { return this.deps.getAgentCliPath(); }
	private get systemPromptPath(): string | undefined { return this.deps.getSystemPromptPath(); }
	private get toolManager(): ToolManager | undefined { return this.deps.getToolManager(); }
	private get sessionSecretStore(): SessionSecretStore { return this.deps.getSessionSecretStore(); }
	private get sandboxManager(): SandboxManager | null { return this.deps.getSandboxManager(); }

	private resolveStoreForId(id: string): SessionStore | null {
		return this.deps.resolveStoreForId(id);
	}

	private resolveStoreForSession(id: string): SessionStore {
		return this.deps.resolveStoreForSession(id);
	}

	private _trackConnectedSession(session: SessionInfo): void {
		this.deps.trackConnectedSession(session);
	}

	private _restoreSessionCoalesced(ps: PersistedSession): Promise<SessionInfo | undefined> {
		return this.deps.restoreSessionCoalesced(ps);
	}

	private cancelPendingAutoRetry(session: SessionInfo, reason: CancelAutoRetryReason): void {
		this.deps.cancelPendingAutoRetry(session, reason);
	}

	private _reconcileAfterAbort(session: SessionInfo): void {
		this.deps.reconcileAfterAbort(session);
	}

	private _coalesceRestore(id: string, fn: (generation: number) => Promise<SessionInfo | undefined>): Promise<SessionInfo | undefined> {
		return this.deps.coalesceRestore(id, fn);
	}

	private applySandboxWiring(bridgeOptions: RpcBridgeOptions, id: string, sandboxOpts?: { projectId?: string; goalId?: string; sandboxBranch?: string; sandboxBaseBranch?: string; sandboxCwdOffset?: string }): Promise<boolean> {
		return this.deps.applySandboxWiring(bridgeOptions, id, sandboxOpts);
	}

	private applyScopedGatewayCredentials(bridgeOptions: RpcBridgeOptions, sessionId: string, projectId: string | undefined, goalId?: string): void {
		this.deps.applyScopedGatewayCredentials(bridgeOptions, sessionId, projectId, goalId);
	}

	private getTeamLeadExtensionPath(): string {
		return this.deps.getTeamLeadExtensionPath();
	}

	private getGoalToolsExtensionPath(): string {
		return this.deps.getGoalToolsExtensionPath();
	}

	private getProposalToolsExtensionPath(): string {
		return this.deps.getProposalToolsExtensionPath();
	}

	private resolveSessionRole(roleName?: string, assistantType?: string, projectId?: string): Role | undefined {
		return this.deps.resolveSessionRole(roleName, assistantType, projectId);
	}

	private resolveEffectiveAllowedTools(role: Role | undefined): EffectiveTool[] {
		return this.deps.resolveEffectiveAllowedTools(role);
	}

	private ensureMcpManagerForContext(projectId?: string, cwd?: string): Promise<unknown> {
		return this.deps.ensureMcpManagerForContext(projectId, cwd);
	}

	private buildToolActivationArgs(sessionId: string, allowedTools: EffectiveTool[] | undefined, role: ToolActivationRole | undefined, cwd: string, projectId?: string, effectiveGoalId?: string, grantedTools?: string[]): { args: string[]; env: Record<string, string>; runtimeExtensions: RuntimePiExtensionInfo[] } {
		return this.deps.buildToolActivationArgs(sessionId, allowedTools, role, cwd, projectId, effectiveGoalId, grantedTools);
	}

	private resolveInitialModel(role: string | undefined, projectId: string | undefined): string | undefined {
		return this.deps.resolveInitialModel(role, projectId);
	}

	private resolveInitialThinkingLevel(role: string | undefined, projectId: string | undefined): string | undefined {
		return this.deps.resolveInitialThinkingLevel(role, projectId);
	}

	private applyDirectProviderEnv(bridgeOptions: RpcBridgeOptions, sandboxed: boolean | undefined, provider?: string): void {
		this.deps.applyDirectProviderEnv(bridgeOptions, sandboxed, provider);
	}

	private readClaudeCodeConfigForProject(projectId?: string) {
		return this.deps.readClaudeCodeConfigForProject(projectId);
	}

	private handleAgentLifecycle(session: SessionInfo, event: any): void {
		this.deps.handleAgentLifecycle(session, event);
	}

	private trackCostFromEvent(session: SessionInfo, event: any): void {
		this.deps.trackCostFromEvent(session, event);
	}

	private recordPiExtensionDiagnostic(session: SessionInfo, diagnostic: unknown, extension: RuntimePiExtensionInfo): void {
		this.deps.recordPiExtensionDiagnostic(session, diagnostic, extension);
	}

	private tryAutoSelectModel(session: SessionInfo): Promise<void> {
		return this.deps.tryAutoSelectModel(session);
	}

	private drainQueue(session: SessionInfo): void {
		this.deps.drainQueue(session);
	}

	addClient(sessionId: string, ws: WebSocket): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;

		// If session is dormant (failed restore), try to revive it
		if (session.status === "terminated") {
			const ps = this.resolveStoreForId(sessionId)?.get(sessionId);
			if (ps && (ps.agentSessionFile || canResumeClaudeCodeSession(ps))) {
				console.log(`[session-manager] Client connected to dormant session "${session.title}" — attempting restore`);
				this._restoreSessionCoalesced(ps)
					.then(() => {
						console.log(`[session-manager] Revived dormant session: "${session.title}" (${sessionId})`);
						// restoreSession replaces the map entry — add client to the canonical one.
						const revived = this.sessions.get(sessionId);
						if (revived && (ws as any).readyState === 1) {
							revived.clients.add(ws);
							this._trackConnectedSession(revived);
						}
					})
					.catch((err) => {
						console.error(`[session-manager] Failed to revive session ${sessionId}:`, err);
					});
				return true; // optimistically accept the client
			}
		}

		session.clients.add(ws);
		this._trackConnectedSession(session);

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
			this._trackConnectedSession(session);
		}
	}

	/**
	 * Abort the agent. If the graceful abort doesn't resolve within a timeout,
	 * force-kill the agent process and restart it so the session remains usable.
	 */
	/**
	 * Soft-abort: interrupt the current streaming turn without killing the
	 * agent process. Used by pause-cascade — the session stays registered so
	 * `goal_resume` can resume it later. No kill/restart fallback.
	 */
	async abortSessionTurn(id: string): Promise<void> {
		const session = this.sessions.get(id);
		if (!session || session.status !== "streaming") return;
		broadcastStatus(session, "aborting");
		try { await session.rpcClient.abort(); } catch { /* best-effort */ }
	}

	async forceAbort(id: string, gracePeriodMs = 3000): Promise<void> {
		const session = this.sessions.get(id);
		if (!session) return;

		// S40: cancel any pending auto-retry timer regardless of streaming state.
		// An abort during the post-error backoff window (status "idle") would
		// otherwise leave the timer to fire a spurious retry on a session someone
		// just stopped (reachable via the team-abort route). No-op when none pending.
		this.cancelPendingAutoRetry(session, "terminated");

		// If not streaming, nothing more to abort
		if (session.status !== "streaming") return;

		// Broadcast aborting status so UI shows feedback during grace period
		broadcastStatus(session, "aborting");

		// CRITICAL: register the agent_end listener BEFORE calling abort().
		// The pi-agent-core SDK can emit agent_end synchronously inside the
		// await of rpcClient.abort() (handleRunFailure emits before finishRun()
		// clears activeRun). If we register after the await, we miss the event,
		// the grace period times out, and we fall into the force-kill branch —
		// which then kills the bridge process *after* drainQueue (running off
		// agent_end) has already dispatched a queued prompt to that bridge.
		// Result: the steered user-message echo renders but the agent process
		// is killed before it can produce an assistant response.
		let resolveSettled!: (v: boolean) => void;
		const settledPromise = new Promise<boolean>((resolve) => { resolveSettled = resolve; });
		const settleTimer = setTimeout(() => {
			unsubSettle();
			resolveSettled(false);
		}, gracePeriodMs);
		const unsubSettle = session.rpcClient.onEvent((event: any) => {
			if (event.type === "agent_end") {
				clearTimeout(settleTimer);
				unsubSettle();
				resolveSettled(true);
			}
		});

		// Try graceful abort, but do NOT serialize it ahead of the grace race
		// (S8): rpcClient.abort() can block up to the 30s sendCommand timeout on a
		// wedged bridge, which would delay the force-kill to ~30s instead of the
		// intended gracePeriodMs (3s). Fire it un-awaited — wrapped in an async IIFE
		// so a SYNCHRONOUS throw ("Agent process not running" when there is no
		// stdin) becomes a caught rejection rather than escaping — and race it
		// against the grace timer below. A fast agent_end still resolves settled=true
		// and returns gracefully without force-kill.
		void (async () => { await session.rpcClient.abort(); })().catch(() => {});

		const settled = await settledPromise;

		if (settled) return;

		// Graceful abort didn't work — force kill and restart the agent
		console.log(`[session-manager] Force-aborting session ${id} — killing agent process`);

		// Get the agent session file before killing so we can restore.
		// Path is in the agent's coordinate system — no translation needed.
		let agentSessionFile: string | undefined;
		try {
			const stateResp = await session.rpcClient.getState();
			if (stateResp.success) agentSessionFile = stateResp.data?.sessionFile;
		} catch {
			const persisted = this.resolveStoreForSession(id).get(id);
			agentSessionFile = persisted?.agentSessionFile;
		}

		// Kill the process
		session.unsubscribe();
		await session.rpcClient.stop();

		// Reconcile any in-flight steers that died with the bridge: anything
		// left in the shadow ledger was recorded for dispatch but never echoed
		// (the process is dead before its message_end could arrive). Re-enqueue
		// at front so the post-respawn drainQueue redispatches them once.
		this._reconcileAfterAbort(session);

		// Emit agent_end so clients know streaming stopped.
		// WP4/RC3: route through emitSessionEvent so a client that resumes after a
		// force-abort replays the agent_end (and clears its stale streaming partial)
		// instead of relying on a later snapshot tick.
		emitSessionEvent(session, { type: "agent_end", messages: [] });
		broadcastStatus(session, "idle");

		// Restart the agent process
		try {
			await this._coalesceRestore(id, async (generation) => {
				session.lifecycleGeneration = generation;
				const bridgeOptions: RpcBridgeOptions = { cwd: session.cwd };
			if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;
			if (this.systemPromptPath) bridgeOptions.systemPromptPath = this.systemPromptPath;
			if (this.toolManager) bridgeOptions.toolManager = this.toolManager;
			bridgeOptions.env = {
				BOBBIT_SESSION_ID: id,
				BOBBIT_SESSION_SECRET: this.sessionSecretStore.getOrCreateSecret(id),
			};

			// Apply sandbox wiring for sandboxed sessions (container spawn, token, etc.)
			if (session.sandboxed) {
				const sandboxApplied = await this.applySandboxWiring(bridgeOptions, id, {
					projectId: session.projectId,
					goalId: session.goalId,
				});
				if (!sandboxApplied) {
					session.sandboxed = false;
					this.resolveStoreForSession(id).update(id, { sandboxed: false });
					this.applyScopedGatewayCredentials(bridgeOptions, id, session.projectId, session.goalId ?? session.teamGoalId);
				}
			} else {
				this.applyScopedGatewayCredentials(bridgeOptions, id, session.projectId, session.goalId ?? session.teamGoalId);
			}

			// Restore goal extension
			if (session.goalId) {
				bridgeOptions.env.BOBBIT_GOAL_ID = session.goalId;
				const isTeamLead = session.role === "team-lead";
				if (isTeamLead) {
					bridgeOptions.args = ["--extension", this.getTeamLeadExtensionPath(), "--extension", this.getGoalToolsExtensionPath()];
				} else {
					bridgeOptions.args = ["--extension", this.getGoalToolsExtensionPath()];
				}
			}

			// Restore proposal tools extension for assistant sessions
			if (session.assistantType) {
				bridgeOptions.args = bridgeOptions.args || [];
				const proposalExtPath = this.getProposalToolsExtensionPath();
				if (!bridgeOptions.args.includes(proposalExtPath)) {
					bridgeOptions.args.push("--extension", proposalExtPath);
				}
			}

			// Restore tool activation, including Bobbit extension tools and MCP policy filtering.
			const role = this.resolveSessionRole(session.role, session.assistantType, session.projectId);
			// Derive the effective allowlist from the session/persisted allowlist when
			// present — NOT from the role alone. A restricted child/delegate (or any
			// session whose allowlist was narrowed/removed by bobbit.disabledTools)
			// persists a constrained allowedTools; recomputing from
			// `resolveEffectiveAllowedTools(role)` would widen it back to the role
			// default (minus disabled names) on force-abort respawn. Mirrors the
			// restore path's persisted-allowlist handling.
			const forceAbortPersisted = this.resolveStoreForSession(id).get(id);
			const forceAbortAllowedNames = forceAbortPersisted?.allowedTools ?? session.allowedTools;
			const effective: EffectiveTool[] = Array.isArray(forceAbortAllowedNames)
				? forceAbortAllowedNames.map(n => tagAllowedTool(n, this.toolManager))
				: this.resolveEffectiveAllowedTools(role);
			// Preserve the unrestricted (`undefined`) vs explicit-empty (`[]`)
			// distinction. A persisted `[]` means NO tools and MUST stay `[]` — never
			// collapse it to `undefined`, which would re-grant every tool. Only a
			// genuinely unrestricted resolution (role-less ⇒ resolves to `[]`)
			// collapses to `undefined` (all tools), preserving today's behaviour.
			const forceAbortAllowed: EffectiveTool[] | undefined = Array.isArray(forceAbortAllowedNames)
				? effective
				: (effective.length > 0 ? effective : undefined);
			await this.ensureMcpManagerForContext(session.projectId, session.cwd);
			const forceActivation = this.buildToolActivationArgs(id, forceAbortAllowed, role, session.cwd, session.projectId, session.goalId ?? session.teamGoalId, session.sessionOnlyGrantedTools);
			bridgeOptions.args = [...forceActivation.args, ...(bridgeOptions.args || [])];
			bridgeOptions.piExtensions = [...(bridgeOptions.piExtensions ?? []), ...forceActivation.runtimeExtensions];
			bridgeOptions.env = { ...(bridgeOptions.env || {}), ...forceActivation.env };

			// Pin model/thinking-level at spawn for the force-abort respawn.
			const forceRespawnPersisted = this.resolveStoreForSession(id).get(id);
			if (forceRespawnPersisted?.modelProvider && forceRespawnPersisted?.modelId) {
				bridgeOptions.initialModel = `${forceRespawnPersisted.modelProvider}/${forceRespawnPersisted.modelId}`;
			} else {
				const initModel = this.resolveInitialModel(session.role, session.projectId);
				if (initModel) bridgeOptions.initialModel = initModel;
			}
			const initThinking = session.spawnPinnedThinkingLevel ?? this.resolveInitialThinkingLevel(session.role, session.projectId);
			if (initThinking) bridgeOptions.initialThinkingLevel = initThinking;
			this.applyDirectProviderEnv(bridgeOptions, !!session.sandboxed, forceRespawnPersisted?.modelProvider);
			const runtime = resolveSessionRuntime({ runtime: forceRespawnPersisted?.runtime, initialModel: bridgeOptions.initialModel, modelProvider: forceRespawnPersisted?.modelProvider });
			assertRuntimeAllowedForSession(runtime, session.sandboxed);
			Object.assign(bridgeOptions, hydrateRuntimeOptions({
				...bridgeOptions,
				runtime,
				claudeCodeSessionId: forceRespawnPersisted?.claudeCodeSessionId,
				claudeCodeExecutable: forceRespawnPersisted?.claudeCodeExecutable,
				claudeCodePermissionMode: forceRespawnPersisted?.claudeCodePermissionMode,
				claudeCodeModelAlias: forceRespawnPersisted?.claudeCodeModelAlias,
				readOnly: forceRespawnPersisted?.readOnly ?? session.readOnly,
			}, this.readClaudeCodeConfigForProject(session.projectId)));

		const rpcClient = createSessionBridge(bridgeOptions);
		session.spawnPinnedModel = bridgeOptions.initialModel;
		session.spawnPinnedThinkingLevel = bridgeOptions.initialThinkingLevel;
		session.thinkingRouterAppliedBaseline = undefined;
		let switchingSession = true;
			const abortStore = this.resolveStoreForSession(id);
			const unsub = rpcClient.onEvent((event: any) => {
				if (isUserVisibleActivity(event)) {
					session.lastActivity = Date.now();
					abortStore.update(id, { lastActivity: session.lastActivity });
				}

				this.handleAgentLifecycle(session, event);

				const truncated = truncateLargeToolContent(event);
				emitSessionEvent(session, truncated);
				if (!switchingSession) this.trackCostFromEvent(session, event);
			});

			bridgeOptions.onPiExtensionDiagnostic = (diagnostic, extension) => this.recordPiExtensionDiagnostic(session, diagnostic, extension);
			await rpcClient.start();

			// Resume session if we have the session file.
			const abortPs = { ...forceRespawnPersisted, ...session, agentSessionFile } as PersistedSession;
			const abortFileCtx = sessionFsContextForAgentFile(abortPs, agentSessionFile);
			if (agentSessionFile) trustPersistedAgentSessionFile(agentSessionFile);
			if (agentSessionFile && await sessionFileExists(abortFileCtx, agentSessionFile, this.sandboxManager)) {
				// Un-poison blank-text user messages before rehydrating — this is
				// the route a live already-stuck session takes (forceAbort →
				// respawn), so the re-spawned agent reads a sanitized transcript.
				await sanitizeAgentTranscriptFile(abortFileCtx, agentSessionFile, this.sandboxManager);
				const switchResp = await rpcClient.sendCommand(
					{ type: "switch_session", sessionPath: switchSessionPathForAgent(abortPs) },
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

			try {
				await this.tryAutoSelectModel(session);
			} catch (err) {
				await rpcClient.stop();
				throw err;
			}

			broadcastStatus(session, "idle");
			console.log(`[session-manager] Session ${id} agent restarted after force abort`);

				// Drain any queued messages (steered first, then normal). Fresh
				// retry budget — the old process (and its busy guard) is gone.
				session.recoverDrainAttempts = 0;
				this.drainQueue(session);
				return session;
			});
		} catch (err) {
			console.error(`[session-manager] Failed to restart agent after force abort:`, err);
			broadcastStatus(session, "terminated");
		}
	}
}
