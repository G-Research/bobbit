/**
 * Session tool-permission plumbing - SessionManager decomposition cohort 13.
 *
 * SessionManager keeps same-named wrappers for callers and source-shape tests,
 * while tool grant/revoke handling, tool-approve seam consultation, audit
 * logging, grant-aware restart recomputation, and pending-permission replay
 * live here.
 */
import type { ServerMessage } from "../ws/protocol.js";
import { makeMetaToolName, parseMcpToolName } from "../mcp/mcp-meta.js";
import type { McpManager } from "../mcp/mcp-manager.js";
import type { Decision } from "./decision-types.js";
import type { LifecycleHub } from "./lifecycle-hub.js";
import type { PersistedSession } from "./session-store.js";
import type { SessionInfo, PendingToolPermissionSnapshot } from "./session-manager.js";
import type { Role, GrantPolicy } from "./role-store.js";
import type { RoleManager } from "./role-manager.js";
import type { ToolManager } from "./tool-manager.js";
import { type EffectiveTool } from "./tool-activation.js";
import { TOOL_APPROVE_POINT, TOOL_APPROVE_KIND, isToolApproveEnforceMode, isAutoDenyDecision, type ToolApproveVerdict } from "./tool-approve-classifier.js";
import { type ToolPermissionAuditDecision, type ToolPermissionAuditSource, ToolPermissionAuditLog } from "./tool-permission-audit-log.js";

export type ToolGrantMode = "persistent" | "session-only" | "one-time";
export type ToolGrantResolution = { granted: boolean; tools?: string[]; scope?: "tool" | "group"; group?: string; mode?: ToolGrantMode; reason?: string };

export interface SessionToolPermissionsDeps {
	getSessions(): Map<string, SessionInfo>;
	getMcpManager(): McpManager | null;
	getToolManager(): ToolManager | undefined;
	getRoleManager(): RoleManager | undefined;
	getLifecycleHub(): LifecycleHub | undefined;
	getToolPermissionAuditLog(): ToolPermissionAuditLog;
	getSession(id: string): SessionInfo | undefined;
	mergeToolNames(existing: string[] | undefined, additions: string[] | undefined): string[] | undefined;
	resolveSessionRole(roleName?: string, assistantType?: string, projectId?: string): Role | undefined;
	resolveEffectiveAllowedTools(role: Role | undefined): EffectiveTool[];
	restartSessionWithUpdatedRole(session: SessionInfo): Promise<void>;
	broadcast(clients: Set<any>, msg: ServerMessage): void;
}

export class SessionToolPermissions {
	constructor(private readonly deps: SessionToolPermissionsDeps) {}

	private get sessions(): Map<string, SessionInfo> { return this.deps.getSessions(); }
	private get mcpManager(): McpManager | null { return this.deps.getMcpManager(); }
	private get toolManager(): ToolManager | undefined { return this.deps.getToolManager(); }
	private get roleManager(): RoleManager | undefined { return this.deps.getRoleManager(); }
	private get lifecycleHub(): LifecycleHub | undefined { return this.deps.getLifecycleHub(); }
	private get toolPermissionAuditLog(): ToolPermissionAuditLog { return this.deps.getToolPermissionAuditLog(); }

	private getSession(id: string): SessionInfo | undefined {
		return this.deps.getSession(id);
	}

	private mergeToolNames(existing: string[] | undefined, additions: string[] | undefined): string[] | undefined {
		return this.deps.mergeToolNames(existing, additions);
	}

	private resolveSessionRole(roleName?: string, assistantType?: string, projectId?: string): Role | undefined {
		return this.deps.resolveSessionRole(roleName, assistantType, projectId);
	}

	private resolveEffectiveAllowedTools(role: Role | undefined): EffectiveTool[] {
		return this.deps.resolveEffectiveAllowedTools(role);
	}

	private async _restartSessionWithUpdatedRole(session: SessionInfo): Promise<void> {
		return this.deps.restartSessionWithUpdatedRole(session);
	}

	private broadcast(clients: Set<any>, msg: ServerMessage): void {
		return this.deps.broadcast(clients, msg);
	}

	/**
	 * Grant a tool or tool group to a session's role and restart the session
	 * so it picks up the new tools. Returns the updated list of allowed tools.
	 *
	 * @param mode - Grant persistence mode:
	 *   - "persistent" (default): updates role YAML permanently
	 *   - "session-only": adds to session.allowedTools in memory only (survives Refresh agent, not gateway restart)
	 *   - "one-time": adds to session.allowedTools + tracks for revocation on agent_end
	 */
	async grantToolPermission(sessionId: string, toolName: string, scope: "tool" | "group", group?: string, mode?: ToolGrantMode): Promise<string[]> {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error("Session not found");
		if (!this.roleManager) throw new Error("No role manager available");

		// Use explicit role, or fall back to "general" role (implicit default for all sessions).
		// Resolve cascade-first so pack-contributed roles keep their policies here too.
		const roleName = session.role || "general";
		const role = this.resolveSessionRole(roleName, undefined, session.projectId);
		if (!role) throw new Error(`Role "${roleName}" not found`);

		const grantScopeTools: string[] = [];
		if (scope === "group" && group) {
			// Approving a group covers tools in that group only. Do not use the full
			// effective role surface here: ask-gated tools are registered there so the
			// model can attempt them, but they are not approved grants yet.
			if (this.mcpManager) {
				for (const info of this.mcpManager.getToolInfos()) {
					if (info.group !== group) continue;
					grantScopeTools.push(info.name);

					// The guard/model-facing MCP surface is the collapsed meta-tool
					// (`mcp_<server>` / `mcp_<server>__<sub>`), while the MCP manager
					// stores canonical per-operation names. Group grants must include
					// both forms: per-op names keep Layer B/internal filtering working,
					// and the meta name lets the active guard correlate and cache only
					// the MCP group it is currently unblocking.
					const parsed = parseMcpToolName(info.name);
					if (parsed) grantScopeTools.push(makeMetaToolName(parsed.server, parsed.sub));
				}
			}
			if (this.toolManager) {
				for (const tool of this.toolManager.getAvailableTools()) {
					if (tool.group === group) grantScopeTools.push(tool.name);
				}
			}
		} else {
			grantScopeTools.push(toolName);
		}
		const approvedGrantTools = this.mergeToolNames(undefined, grantScopeTools.length > 0 ? grantScopeTools : [toolName]) ?? [toolName];

		if (session.pendingGrantRequest) {
			const pending = session.pendingGrantRequest;
			const requestedToolMatches = pending.toolName.toLowerCase() === toolName.toLowerCase();
			const requestedGroupMatches = !!group && pending.toolGroup.toLowerCase() === group.toLowerCase();
			const approvedToolsCoverPending = approvedGrantTools.some(t => t.toLowerCase() === pending.toolName.toLowerCase());
			const grantCoversPending = scope === "group"
				? requestedGroupMatches && approvedToolsCoverPending
				: requestedToolMatches && approvedToolsCoverPending;
			if (!grantCoversPending) {
				clearTimeout(pending.timer);
				session.pendingGrantRequest = undefined;
				pending.resolve({
					granted: false,
					reason: `Ignored stale permission grant for ${toolName}; active request is for ${pending.toolName}.`,
				});
				this.appendToolPermissionAudit(session, pending, "denied", "auto");
				return session.allowedTools ?? [];
			}
		}

		let resultTools: string[];

		if (mode === "one-time") {
			// Temporary grant: add to session.allowedTools, track for revocation on agent_end
			session.allowedTools = this.mergeToolNames(session.allowedTools, approvedGrantTools) ?? [];
			session.oneTimeGrantedTools = this.mergeToolNames(session.oneTimeGrantedTools, approvedGrantTools);
			resultTools = session.allowedTools;

		} else if (mode === "session-only") {
			// Session-scoped grant: add to session.allowedTools only, don't write role YAML
			session.allowedTools = this.mergeToolNames(session.allowedTools, approvedGrantTools) ?? [];
			session.sessionOnlyGrantedTools = this.mergeToolNames(session.sessionOnlyGrantedTools, approvedGrantTools);
			resultTools = session.allowedTools;

		} else {
			// Persistent grant (default): update toolPolicies on role YAML when the
			// role is locally writable. Pack roles are read-only through RoleManager,
			// so keep the grant effective for this session without writing to the pack.
			const updatedPolicies = { ...role.toolPolicies };
			for (const t of approvedGrantTools) {
				updatedPolicies[t] = 'allow' as GrantPolicy;
			}
			const writableRole = this.roleManager.getRole(role.name);
			let effectiveRole: Role = { ...role, toolPolicies: updatedPolicies };
			if (writableRole) {
				this.roleManager.updateRole(role.name, { toolPolicies: updatedPolicies });
				effectiveRole = this.resolveSessionRole(role.name, undefined, session.projectId) ?? effectiveRole;
			} else {
				session.sessionOnlyGrantedTools = this.mergeToolNames(session.sessionOnlyGrantedTools, approvedGrantTools);
			}
			const updatedEffective = this.resolveEffectiveAllowedTools(effectiveRole).map(e => e.name);
			session.allowedTools = this.mergeToolNames(updatedEffective, writableRole ? undefined : approvedGrantTools) ?? updatedEffective;
			resultTools = session.allowedTools;
		}

		if (session.pendingGrantRequest) {
			// Single-owner grant resumption: the active guard long-poll receives only
			// the approved grant scope/delta and lets the original tool call continue.
			// Returning the full effective surface here would let unrelated ask-gated
			// tools bypass future prompts in the active process.
			clearTimeout(session.pendingGrantRequest.timer);
			const pending = session.pendingGrantRequest;
			session.pendingGrantRequest = undefined;
			pending.resolve({ granted: true, tools: approvedGrantTools, scope, group, mode: mode ?? "persistent" });
			this.appendToolPermissionAudit(session, pending, "granted", "user");
			return resultTools;
		}

		await this._restartSessionWithUpdatedRole(session);
		return resultTools;
	}

	/**
	 * CLF-W2 — consult the tool-approve decision seam (harness only, see
	 * `tool-approve-classifier.ts`) for this tool-permission ask. Returns
	 * `undefined` (rather than throwing) whenever the consult can't produce a
	 * usable Decision — no hub, an unregistered (point,kind) pair, or the
	 * classifier itself erroring — this consult must never block a tool ask
	 * from reaching the human-approval flow. Mirrors
	 * `consultThinkingRouterHub`'s fail-open discipline exactly.
	 */
	async consultToolApproveHub(session: SessionInfo, toolName: string, toolGroup: string): Promise<Decision<ToolApproveVerdict> | undefined> {
		try {
			return await this.lifecycleHub!.dispatchDecision<ToolApproveVerdict>(
				TOOL_APPROVE_POINT,
				TOOL_APPROVE_KIND,
				{ sessionId: session.id, projectId: session.projectId, goalId: session.goalId, cwd: session.cwd },
				{ toolName, toolGroup, roleName: session.role },
			);
		} catch (err) {
			console.warn(`[session-manager] tool-approve dispatchDecision failed for session ${session.id} (non-fatal, observe-mode only): ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	}

	appendToolPermissionAudit(
		session: SessionInfo,
		ask: { toolName: string; toolGroup?: string; toolApproveDecision?: Decision<ToolApproveVerdict> },
		decision: ToolPermissionAuditDecision,
		source: ToolPermissionAuditSource,
	): void {
		try {
			this.toolPermissionAuditLog.append(session.id, {
				ts: Date.now(),
				sessionId: session.id,
				...(session.projectId ? { projectId: session.projectId } : {}),
				toolName: ask.toolName,
				...(ask.toolGroup ? { toolGroup: ask.toolGroup } : {}),
				decision,
				source,
				...(ask.toolApproveDecision ? { toolApproveDecision: ask.toolApproveDecision } : {}),
			});
		} catch (err) {
			console.warn(`[session-manager] tool-permission audit append failed for session ${session.id} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Called by the guard extension's long-poll endpoint. Creates a pending
	 * grant request, broadcasts to UI clients, and returns a promise that
	 * resolves when the user grants/denies or after a 5-minute timeout.
	 */
	async requestToolGrant(sessionId: string, toolName: string, toolGroup: string): Promise<ToolGrantResolution> {
		// `getSession()` (not a raw `this.sessions.get()`) — the guard extension
		// (tool-guard-extension.ts) embeds ITS OWN session id as a string literal
		// at generation time (`const sessionId = ${JSON.stringify(sessionId)}`).
		// For a warm-pool-claimed session (docs/design/warm-pi-process-pool.md)
		// that embedded id is the pool's placeholder id, not the live session's
		// real id — `getSession()` resolves the alias so tool-approval still
		// reaches the correct session instead of 404ing.
		const session = this.getSession(sessionId);
		if (!session) throw new Error("Session not found");

		// If a previous grant request is still pending, resolve it as denied
		if (session.pendingGrantRequest) {
			clearTimeout(session.pendingGrantRequest.timer);
			const pending = session.pendingGrantRequest;
			pending.resolve({ granted: false });
			this.appendToolPermissionAudit(session, pending, "denied", "auto");
			session.pendingGrantRequest = undefined;
		}

		// CLF-W2 — tool-approve decision seam consult (see
		// tool-approve-classifier.ts's header for the full design/scope).
		// Guarded OUTSIDE the await (matches `consultThinkingRouterHub`'s own
		// call site in `enqueuePrompt`): when there is no hub at all — true for
		// the overwhelming majority of today's tests and any deployment that
		// never wires one — this introduces ZERO extra microtask ticks before
		// the pre-existing synchronous frame-allocation below.
		//
		// OBSERVE MODE (default): the Decision (if any) is recorded via
		// `dispatchDecision`'s own trace/transparency-panel wiring; nothing
		// below changes — the human-ask flow always runs.
		// ENFORCE MODE (`BOBBIT_CLF_TOOL_APPROVE=enforce`): only the safe
		// direction ever short-circuits — a `select` with `choice: "deny"`
		// resolves this call immediately, BEFORE the frame-allocation /
		// broadcast below, so no `tool_permission_needed` ever reaches the UI
		// and no pending-grant timer is started (design doc §6.4: deny is the
		// only always-safe tool verdict). A `select` with `choice: "allow"` is
		// deliberately NOT auto-applied this wave — it needs the CQ-03
		// operator-confirmation permit for widening, which is out of scope
		// here — so it falls through to the human-ask flow exactly like an
		// abstain. Ships dark today: `server.ts` only allow-lists this
		// (point,kind) pair, it registers no classifier, so this consult
		// always abstains in production and the enforce branch is provably
		// unreachable regardless of the flag — see
		// tests/session-manager-tool-approve.test.ts for the exercised
		// mechanics via a directly-registered test classifier.
		const toolApproveDecision = this.lifecycleHub ? await this.consultToolApproveHub(session, toolName, toolGroup) : undefined;
		if (isToolApproveEnforceMode() && isAutoDenyDecision(toolApproveDecision)) {
			this.appendToolPermissionAudit(session, { toolName, toolGroup, toolApproveDecision }, "denied", "auto");
			return { granted: false, reason: toolApproveDecision.rationale ?? "Auto-denied by the tool-approve decision seam (CLF-W2, enforce mode)" };
		}

		// Stamp seq+ts so client reducer can order this frame relative to live
		// `event` frames. See docs/design/unified-message-ordering-reducer.md §3.1.
		// IMPORTANT: this is the ONLY frame-allocation callsite in src/server/.
		// Late-joiners that attach while this perm is pending must REPLAY the
		// same seq/ts (via getPendingToolPermission) — never allocate a fresh
		// seq — or already-attached clients will gap-buffer the next live
		// event. Pinned by tests/perm-frame-late-joiner-seq-gap.test.ts.
		const { seq, ts } = session.eventBuffer.pushFrame();

		// Create promise that will be resolved by grantToolPermission
		const promise = new Promise<ToolGrantResolution>((resolve, reject) => {
			const timer = setTimeout(() => {
				const pending = session.pendingGrantRequest;
				session.pendingGrantRequest = undefined;
				resolve({ granted: false });
				if (pending) this.appendToolPermissionAudit(session, pending, "denied", "timeout");
			}, 5 * 60 * 1000); // 5 minute timeout

			session.pendingGrantRequest = { resolve, reject, toolName, toolGroup, toolApproveDecision, timer, seq, ts };
		});

		// Broadcast to UI clients
		const roleName = session.role || "general";
		const role = this.roleManager?.getRole(roleName);
		this.broadcast(session.clients, {
			type: "tool_permission_needed",
			toolName,
			group: toolGroup,
			roleName: role?.name ?? roleName,
			roleLabel: role?.label ?? roleName,
			lastPromptText: session.lastPromptText,
			seq,
			ts,
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
		this.appendToolPermissionAudit(session, pending, "denied", "user");
	}

	recomputeAllowedToolsForRestart(session: SessionInfo, ps: PersistedSession): string[] | undefined {
		// Preserve a persisted EXPLICIT empty allowlist (`[]` = NO tools) as distinct
		// from absent (`undefined` = fall back to role/cascade). Only a missing /
		// non-array value falls back; an emptied allowlist (recursion-stripped
		// delegate, bobbit.disabledTools) must NOT silently re-acquire role defaults
		// on respawn/restart.
		const persistedAllowedTools = Array.isArray(ps.allowedTools) ? ps.allowedTools : undefined;
		const sessionGrants = this.mergeToolNames(session.sessionOnlyGrantedTools, session.oneTimeGrantedTools);

		// Persisted allow-lists are true session-scoped constraints (delegate/read-only
		// children, explicit createSession overrides, incl. an explicit empty `[]`).
		// Preserve them exactly, with any live grants layered on top.
		if (persistedAllowedTools) {
			return this.mergeToolNames(persistedAllowedTools, sessionGrants);
		}

		// Normal sessions derive their tool surface from the current role/group/MCP
		// policy cascade. Only one-time/session-only grants are carried across the
		// respawn; the old live session.allowedTools is just a stale cache.
		if (!sessionGrants) return undefined;
		const restoredRole = this.resolveSessionRole(ps.role, ps.assistantType, ps.projectId);
		const recomputedAllowed = this.resolveEffectiveAllowedTools(restoredRole).map(t => t.name);
		return this.mergeToolNames(recomputedAllowed, sessionGrants);
	}

	/**
	 * Get the pending tool permission request for a session, if any.
	 * Used to send the permission card to newly connecting clients.
	 */
	getPendingToolPermission(id: string): /* includes replayed seq: number; ts: number */ PendingToolPermissionSnapshot | undefined {
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
			seq: session.pendingGrantRequest.seq,
			ts: session.pendingGrantRequest.ts,
		};
	}
}
