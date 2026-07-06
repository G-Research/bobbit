/**
 * Session create/delegate bring-up wiring - cohort 6 mechanical slice of the
 * SessionManager decomposition. SessionManager keeps same-named delegating
 * wrappers so callers and runtime monkey-patches keep using the legacy surface
 * while this module owns the spawn-path implementation.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { EventBuffer } from "./event-buffer.js";
import { PromptQueue } from "./prompt-queue.js";
import { RpcBridge } from "./rpc-bridge.js";
import type { SessionInfo } from "./session-manager.js";
import type { WorktreePushPolicy, SessionRuntime } from "./session-store.js";
import type { PromptProfile } from "./system-prompt.js";
import { tagAllowedTool, type EffectiveTool } from "./tool-activation.js";
import { HEADQUARTERS_PROJECT_ID } from "./project-registry.js";
import { isSandboxExemptProject } from "./sandbox-manager.js";
import { resolveRolePrompt } from "./role-prompt.js";
import {
	type SessionSetupPlan,
	executePlan,
	executeWorktreeAsync,
	persistOnce,
	handleSetupFailure,
	sendDelegatePrompt,
	DELEGATE_SPAWN_TIMEOUT_MS,
} from "./session-setup.js";

export class SessionSpawn {
	[key: string]: any;

	async createSession(cwd: string, agentArgs?: string[], goalId?: string, assistantType?: string, opts?: { rolePrompt?: string; roleName?: string; role?: string; teamGoalId?: string; teamLeadSessionId?: string; accessory?: string; nonInteractive?: boolean; promptProfile?: PromptProfile; env?: Record<string, string>; taskId?: string; staffId?: string; allowedTools?: string[]; workflowContext?: string; worktreeOpts?: { repoPath: string }; worktreePushPolicy?: WorktreePushPolicy; reattemptGoalId?: string; sandboxed?: boolean; projectId?: string; sessionId?: string; sandboxBranch?: string; sandboxBaseBranch?: string; sandboxCwdOffset?: string; skipAutoModel?: boolean; skipAutoThinking?: boolean; initialModel?: string; runtime?: SessionRuntime; initialThinkingLevel?: string; preExistingAgentSessionFile?: string; preExistingAgentSessionOldCwds?: string[]; parentSessionId?: string; childKind?: string; readOnly?: boolean; title?: string; awaitWorktreeSetup?: boolean; bypassWorktreePool?: boolean }): Promise<SessionInfo> {
		const id = opts?.sessionId || randomUUID();
		const optsAllowedTagged: EffectiveTool[] | undefined = opts?.allowedTools
			? opts.allowedTools.map(n => tagAllowedTool(n, this.toolManager))
			: undefined;
		const sessionScopedAllowedTools = opts?.allowedTools && opts.allowedTools.length > 0
			? [...opts.allowedTools]
			: undefined;
		// Resolve projectId from opts or from the goal's project.
		// Headquarters is a server/data workspace: ignore every worktree request at
		// the lifecycle boundary so downstream setup never claims a pool, creates a
		// git worktree, or asks sandbox wiring for a branch worktree.
		const projectId = opts?.projectId ?? (goalId ? this.resolveGoal(goalId)?.projectId : undefined);
		const sandboxExemptScope = projectId ? isSandboxExemptProject(projectId) : false;
		const headquartersScope = projectId === HEADQUARTERS_PROJECT_ID;
		const effectiveSandboxed = opts?.sandboxed && !sandboxExemptScope ? true : undefined;
		const worktreeOpts = headquartersScope ? undefined : opts?.worktreeOpts;
		const worktreePushPolicy = headquartersScope ? undefined : opts?.worktreePushPolicy;
		const sandboxBranch = effectiveSandboxed ? opts?.sandboxBranch : undefined;
		const sandboxBaseBranch = effectiveSandboxed ? opts?.sandboxBaseBranch : undefined;
		await this.ensureMcpManagerForContext(projectId, cwd);
		const ctx = this.buildPipelineContext(projectId, cwd);

		// Spawn-path rolePrompt resolution. The orchestration spawn path
		// (`host.agents.spawn` -> OrchestrationCore.spawn -> createSession) threads only
		// `roleName` (no `rolePrompt`), so a pack-shipped role's promptTemplate - e.g.
		// the pr-reviewer YAML schema - would otherwise NEVER reach the child's system
		// prompt (assembleSystemPrompt only consumes `parts.rolePrompt`, never a
		// roleName->template lookup). Resolve it cascade-first here (mirrors the restore
		// path's buildRestoreRolePrompt) so a project-scoped reviewer child carries its
		// role prompt. A caller that passes an explicit `rolePrompt` (team/staff) is
		// untouched.
		let resolvedRolePrompt = opts?.rolePrompt;
		if (!resolvedRolePrompt && opts?.roleName) {
			const template = this.resolveRolePromptTemplate(opts.roleName, projectId);
			if (template) {
				resolvedRolePrompt = resolveRolePrompt({ promptTemplate: template }, {
					branch: goalId ? this.resolveGoal(goalId)?.branch : undefined,
					agentId: `${opts.roleName}-${(goalId || id).slice(0, 8)}`,
					roleManager: this.roleManager ?? undefined,
					subGoalsEnabled: this.isSubgoalsEnabled,
				});
			}
		}
		const sandboxCwdOffset = effectiveSandboxed
			? await this.resolveSandboxCwdOffset(cwd, projectId, goalId, opts?.sandboxCwdOffset)
			: undefined;
		const directGatewayEnv = !effectiveSandboxed
			? this.scopedGatewayEnvForDirectAgent(id, projectId, goalId ?? opts?.teamGoalId ?? opts?.env?.BOBBIT_GOAL_ID)
			: undefined;

		// -- Worktree: return a "preparing" session immediately, launch agent async --
		if (worktreeOpts) {
			const repoPath = worktreeOpts.repoPath;
			const uuid8 = id.slice(0, 8);
			const wtRoot = path.resolve(repoPath, "..", `${path.basename(repoPath)}-wt`);

			// Compute the final branch name up front. Both warm-pool and cold-pool
			// paths produce `session/<id8>` -- unified namespace, no first-prompt
			// rename. See docs/design/remove-session-worktree-rename.md.
			//
			// Sandboxed sessions skip the host-side pool: they create their worktree
			// inside the container via ProjectSandbox.createWorktree, and the
			// host-side worktree pool isn't reachable from the container.
			const targetBranch = `session/${uuid8}`;
			const poolForCreate = (!effectiveSandboxed && !opts?.bypassWorktreePool && projectId) ? this.worktreePools.get(projectId) : undefined;
			const claimed = poolForCreate ? await poolForCreate.claim(targetBranch).catch((err: unknown) => {
				console.warn(`[session-manager] pool.claim failed for ${id}, falling back to createWorktree: ${err instanceof Error ? err.message : err}`);
				return null;
			}) : null;

			const safeName = targetBranch.replace(/\//g, "-");
			const branch = targetBranch;
			const worktreePath = claimed ? claimed.worktreePath : path.join(wtRoot, safeName);

			const now = Date.now();
			const session: SessionInfo = {
				id,
				title: "New session",
				cwd, // temporary - will be updated when worktree is ready
				status: "preparing",
				statusVersion: 0,
				createdAt: now,
				lastActivity: now,
				clients: new Set(),
				rpcClient: new RpcBridge({ cwd }), // placeholder, not started
				eventBuffer: new EventBuffer(),
				unsubscribe: () => {},
				isCompacting: false,
				titleGenerated: false,
				goalId,
				teamGoalId: opts?.teamGoalId,
				teamLeadSessionId: opts?.teamLeadSessionId,
				assistantType,
				taskId: opts?.taskId,
				parentSessionId: opts?.parentSessionId,
				childKind: opts?.childKind,
				readOnly: opts?.readOnly,
				allowedTools: opts?.allowedTools,
				// Mirror session-setup's effectiveRoleId fallback: when callers
				// (team-manager, staff-manager) pass only `roleName`, use that as
				// `session.role` so the post-spawn auto-model safety net still
				// keys off the right role id during the worktree-prep window.
				role: opts?.role ?? opts?.roleName,
				accessory: opts?.accessory,
				nonInteractive: opts?.nonInteractive,
				worktreePath,
				worktreePushPolicy,
				projectId,
				promptQueue: new PromptQueue(),
			};

			if (claimed && claimed.worktrees && claimed.worktrees.length > 0) {
				// Re-derive per-repo `repoPath` from the project's components: the pool
				// claim only carries `repo` + `worktreePath`. For session-manager we need
				// each repo's *primary* path so cleanup-on-archive can run git ops there.
				session.repoWorktrees = claimed.worktrees.map((w: { repo: string; worktreePath: string }) => ({
					repo: w.repo,
					repoPath: w.repo === "." ? repoPath : path.join(repoPath, w.repo),
					worktreePath: w.worktreePath,
				}));
			}
			session.repoPath = repoPath;
			session.branch = branch;

			this.sessions.set(id, session);

			// Build the plan for the worktree pipeline
			const plan: SessionSetupPlan = {
				id,
				mode: "worktree",
				title: opts?.title || "New session",
				cwd,
				goalId,
				teamGoalId: opts?.teamGoalId,
				teamLeadSessionId: opts?.teamLeadSessionId,
				assistantType,
				taskId: opts?.taskId,
				// Load-bearing wire: threads staffId from opts -> plan -> persistOnce so it
				// lands in PersistedSession on disk. Pinned by `tests/staff-session-staffid-persistence.test.ts`;
				// without it `BOBBIT_STAFF_ID` is lost on respawn and the inbox tools refuse to register.
				staffId: opts?.staffId,
				parentSessionId: opts?.parentSessionId,
				childKind: opts?.childKind,
				readOnly: opts?.readOnly,
				runtime: opts?.runtime,
				sessionScopedAllowedTools,
				worktreePath,
				worktreePushPolicy,
				repoPath,
				branch,
				sandboxed: effectiveSandboxed,
				role: opts?.role,
				accessory: opts?.accessory,
				nonInteractive: opts?.nonInteractive,
				promptProfile: opts?.promptProfile,
				agentArgs,
				env: { ...(opts?.env ?? {}), ...(directGatewayEnv ?? {}) },
				rolePrompt: resolvedRolePrompt,
				roleName: opts?.roleName,
				workflowContext: opts?.workflowContext,
				effectiveAllowedTools: optsAllowedTagged,
				projectId,
				sandboxBranch,
				sandboxBaseBranch,
				sandboxCwdOffset,
				skipAutoModel: opts?.skipAutoModel,
				skipAutoThinking: opts?.skipAutoThinking,
				initialModel: opts?.initialModel,
				initialThinkingLevel: opts?.initialThinkingLevel,
				preExistingAgentSessionFile: opts?.preExistingAgentSessionFile,
				preExistingAgentSessionOldCwds: opts?.preExistingAgentSessionOldCwds,
				bridgeOptions: { cwd },
			};

			// Persist immediately with all known structural fields
			persistOnce(session, plan, ctx.store);
			if (session.repoWorktrees && session.repoWorktrees.length > 0) {
				ctx.store.update(session.id, {
					repoWorktrees: Object.fromEntries(session.repoWorktrees.map((w: { repo: string; worktreePath: string }) => [w.repo, w.worktreePath])),
				});
			}
			this.notifySessionCreated(session);

			// Finish the pipeline. Most callers keep the historical preparing-session UX
			// and let setup complete in the background. Continue-Archived opts in to
			// awaiting setup so fresh worktree/base-ref failures are returned by the POST
			// instead of surfacing later as an asynchronously archived session.
			const setupPromise = executeWorktreeAsync(plan, session, ctx, claimed?.worktreePath).then(() => {
				// agentSessionFile is now persisted synchronously by spawnAgent before
				// status flips to idle (see session-setup.ts). The post-resolve persist
				// here is redundant but kept as a safety net for re-attempts where the
				// agent may rotate its session file mid-run. Continue/Fork rehydration
				// already adopted a cloned transcript and may have sanitized runtime-only
				// metadata in that file; avoid a redundant get_state that can drop it.
				if (plan.preExistingAgentSessionFile) return;
				session.pendingMetadataPersist = this.persistSessionMetadata(session).catch((err: unknown) => {
					console.warn(`[session-manager] Early persist failed for worktree session ${session.id}:`, err);
				}).finally(() => { session.pendingMetadataPersist = undefined; });
			});

			if (opts?.awaitWorktreeSetup) {
				try {
					await setupPromise;
				} catch (err) {
					const setupError = err instanceof Error ? err : new Error(String(err));
					handleSetupFailure(session, plan, setupError, ctx);
					throw setupError;
				}
			} else {
				setupPromise.catch((err: unknown) => {
					const setupError = err instanceof Error ? err : new Error(String(err));
					handleSetupFailure(session, plan, setupError, ctx);
				});
			}

			return session;
		}

		// -- Normal session: build plan and execute full pipeline --
		const plan: SessionSetupPlan = {
			id,
			mode: "normal",
			title: opts?.title || "New session",
			cwd,
			goalId,
			teamGoalId: opts?.teamGoalId,
			teamLeadSessionId: opts?.teamLeadSessionId,
			assistantType,
			taskId: opts?.taskId,
			parentSessionId: opts?.parentSessionId,
			childKind: opts?.childKind,
			readOnly: opts?.readOnly,
			runtime: opts?.runtime,
			worktreePushPolicy,
			sessionScopedAllowedTools,
			// Load-bearing wire: same contract as the worktree branch above.
			// Pinned by `tests/staff-session-staffid-persistence.test.ts`.
			staffId: opts?.staffId,
			sandboxed: effectiveSandboxed,
			role: opts?.role,
			accessory: opts?.accessory,
			nonInteractive: opts?.nonInteractive,
			promptProfile: opts?.promptProfile,
			agentArgs,
			env: { ...(opts?.env ?? {}), ...(directGatewayEnv ?? {}) },
			rolePrompt: resolvedRolePrompt,
			roleName: opts?.roleName,
			workflowContext: opts?.workflowContext,
			reattemptGoalId: opts?.reattemptGoalId,
			effectiveAllowedTools: optsAllowedTagged,
			projectId,
			sandboxBranch,
			sandboxBaseBranch,
			sandboxCwdOffset,
			skipAutoModel: opts?.skipAutoModel,
			skipAutoThinking: opts?.skipAutoThinking,
			initialModel: opts?.initialModel,
			initialThinkingLevel: opts?.initialThinkingLevel,
			preExistingAgentSessionFile: opts?.preExistingAgentSessionFile,
			preExistingAgentSessionOldCwds: opts?.preExistingAgentSessionOldCwds,
			bridgeOptions: { cwd },
		};

		const session = await executePlan(plan, ctx);
		if (projectId) session.projectId = projectId;
		this.notifySessionCreated(session);

		// Persist session metadata (fire-and-forget, but tracked for terminate).
		// Rehydrated sessions already have a cloned/adopted transcript path recorded;
		// avoid a redundant get_state that can rewrite runtime-only metadata.
		if (!plan.preExistingAgentSessionFile) {
			session.pendingMetadataPersist = this.persistSessionMetadata(session).catch((err: unknown) => {
				console.warn(`[session-manager] Early persist failed for ${session.id}:`, err);
			}).finally(() => { session.pendingMetadataPersist = undefined; });
		}

		return session;
	}

	/**
	 * Create a delegate session - a real session that runs a task on behalf of a parent session.
	 * The delegate gets a system prompt built from AGENTS.md + instructions.
	 * After creation, the instructions are automatically sent as the first prompt.
	 * Returns the session info immediately (the prompt runs asynchronously).
	 */
	async createDelegateSession(parentSessionId: string, opts: {
		instructions: string;
		cwd: string;
		title?: string;
		context?: Record<string, string>;
		/**
		 * Explicit allowedTools override (OrchestrationCore recursion guard, section 7):
		 * the core passes the owner's allowedTools MINUS every spawn verb. When
		 * omitted, the child inherits the parent's full allowedTools (legacy).
		 */
		allowedTools?: string[];
		/**
		 * Model / thinking-level inheritance (fixes the delegate model-default
		 * drop, section 2.2). The core resolves the owner's CURRENT model and forwards
		 * it here. When omitted, the agent CLI falls back to its own default.
		 */
		initialModel?: string;
		initialThinkingLevel?: string;
		/**
		 * Source discriminator persisted alongside `delegateOf` so it survives a
		 * restart (orchestration-core section 3). Without it, a `host-agents` (or other)
		 * delegate-style child is rebuilt as `childKind:"delegate"` and the
		 * source-filtered `host.agents.*` verbs stop seeing it. Default "delegate".
		 */
		childKind?: string;
		/**
		 * Persisted read-only marker (orchestration-core section 2.2). The actual tool
		 * gating is performed by the caller via the `allowedTools` allow-list
		 * (mutating tools stripped, mirroring pr-walkthrough); this flag persists
		 * the intent for restart-rebuild, UI, and cascade parity.
		 */
		readOnly?: boolean;
		/**
		 * NON-SECRET tool-scoping env vars merged into the child process env
		 * (additive, alongside the gateway-set BOBBIT_SESSION_ID/SECRET). Used by
		 * tool policies that read process env (e.g. the pr-walkthrough reviewer's
		 * launched-PR `gh` scoping via `BOBBIT_WALKTHROUGH_TARGET_*`). Plain metadata
		 * ONLY - it never widens the child's sandbox or project (credential) scope.
		 */
		env?: Record<string, string>;
	}): Promise<SessionInfo> {
		const id = randomUUID();
		// Resolve projectId from parent session
		const parentStore = this.resolveStoreForId(parentSessionId);
		const parentProjectId = this.sessions.get(parentSessionId)?.projectId
			?? parentStore?.get(parentSessionId)?.projectId;

		// -- Sandbox propagation from parent --
		const parentMeta = parentStore?.get(parentSessionId);
		let delegateSandboxed = false;
		if (parentMeta?.sandboxed && !(parentProjectId && isSandboxExemptProject(parentProjectId))) {
			// Always use the parent's validated host-side cwd - never trust the
			// cwd from the container. The agent sends process.cwd() which is a
			// container-internal path (typically /workspace or a subdir). Using
			// it directly would either fail (path doesn't exist on host) or, worse,
			// allow a malicious agent to mount an arbitrary host path into the
			// delegate container.
			opts.cwd = parentMeta.cwd;
			delegateSandboxed = true;
		}

		await this.ensureMcpManagerForContext(parentProjectId, opts.cwd);
		const ctx = this.buildPipelineContext(parentProjectId, opts.cwd);

		const titleSummary = opts.title || opts.instructions.split("\n")[0].slice(0, 60) || "Delegate";

		// Inherit tool access from parent session, unless the caller passes an
		// explicit allowedTools override (OrchestrationCore strips spawn verbs).
		const parentSession = this.sessions.get(parentSessionId);

		// -- Goal-metadata inheritance (anti-asymmetry invariant) --
		// A `team_delegate` sub-agent natively carries only `delegateOf`; it has no
		// `goalId`/`teamGoalId`, so every per-session goal-metadata edge (disabled
		// tools, disabled providers, prompt order) would resolve to {} and the child
		// could re-acquire a tool/provider the goal disabled - a treatment leak.
		// Stamp the PARENT's effective goal as the delegate's `teamGoalId` (NOT
		// `goalId`, so it is treated as a member, not a lead) so the resolver walks
		// the same ancestry and the delegate inherits the same metadata. Prefer the
		// live parent session, then its persisted record (restart/respawn).
		const parentEffectiveGoalId =
			parentSession?.goalId ?? parentSession?.teamGoalId
			?? parentMeta?.goalId ?? parentMeta?.teamGoalId;
		const sourceAllowedTools = opts.allowedTools ?? parentSession?.allowedTools;
		const parentAllowedTools: EffectiveTool[] | undefined = sourceAllowedTools
			? sourceAllowedTools.map((n: string) => tagAllowedTool(n, this.toolManager))
			: undefined;
		// H2 - PERSIST the (already-stripped) allow-list so restart/revive preserves
		// the recursion guard (spawn verbs removed) AND read-only restrictions
		// (mutating tools removed). persistOnce persists `allowedTools` ONLY from
		// `plan.sessionScopedAllowedTools`; without this the child's persisted
		// allowedTools is undefined and a restored child falls back to role defaults
		// - silently re-enabling team_delegate/team_spawn (grandchildren) and the
		// mutating tools a read-only child must never carry.
		const sessionScopedAllowedTools = sourceAllowedTools && sourceAllowedTools.length > 0
			? [...sourceAllowedTools]
			: undefined;
		const directGatewayEnv = !delegateSandboxed
			? this.scopedGatewayEnvForDirectAgent(id, parentProjectId, parentEffectiveGoalId)
			: undefined;

		const plan: SessionSetupPlan = {
			id,
			mode: "delegate",
			title: titleSummary,
			cwd: opts.cwd,
			delegateOf: parentSessionId,
			// Effective-goal stamp (see above): makes the inherited goal metadata
			// available DURING the delegate's own setup pipeline (tool activation /
			// bridge-install / prompt order), not just after the fact.
			teamGoalId: parentEffectiveGoalId,
			// Persist the source discriminator + read-only marker (orchestration-core
			// section 3/2.2) so a delegate-style child (e.g. host-agents) is rebuilt with
			// the correct kind on restart and is enumerable by source-filtered verbs.
			childKind: opts.childKind,
			readOnly: opts.readOnly,
			sandboxed: delegateSandboxed || undefined,
			instructions: opts.instructions,
			context: opts.context,
			effectiveAllowedTools: parentAllowedTools,
			// Persist the stripped allow-list (H2) so restart preserves the
			// recursion + read-only restrictions instead of reverting to role defaults.
			sessionScopedAllowedTools,
			projectId: parentProjectId,
			// Model inheritance (section 2.2): forward the resolved owner model/thinking
			// level so a delegate no longer silently drops to the system default.
			initialModel: opts.initialModel,
			initialThinkingLevel: opts.initialThinkingLevel,
			// Caller toolEnv is non-secret metadata. directGatewayEnv is minted by the
			// gateway and spread last so user-supplied env cannot widen the inherited
			// project/session scope.
			env: { ...(opts.env ?? {}), ...(directGatewayEnv ?? {}) },
			bridgeOptions: { cwd: opts.cwd },
		};

		const session = await executePlan(plan, ctx);
		if (parentProjectId) session.projectId = parentProjectId;
		// Persist the effective-goal stamp on BOTH the live session and the store
		// record so it survives restart/respawn (the initial structural put happens
		// inside executePlan; this guarantees the field regardless of plan
		// propagation details). Belt-and-suspenders alongside plan.teamGoalId.
		if (parentEffectiveGoalId) {
			session.teamGoalId = parentEffectiveGoalId;
			this.resolveStoreForSession(session.id).update(session.id, { teamGoalId: parentEffectiveGoalId });
		}

		// Persist with all structural fields (delegateOf is in the initial put, tracked for terminate)
		session.pendingMetadataPersist = this.persistSessionMetadata(session).catch((err: unknown) => {
			console.error(`[session-manager] Failed to persist delegate session ${id}:`, err);
		}).finally(() => { session.pendingMetadataPersist = undefined; });

		// Send delegate prompt with 30s timeout
		await sendDelegatePrompt(session, opts.instructions, DELEGATE_SPAWN_TIMEOUT_MS);

		console.log(`[session-manager] Created delegate session ${id} (parent: ${parentSessionId}, status: ${session.status})`);
		return session;
	}
}
