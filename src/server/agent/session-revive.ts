/**
 * Session revive/respawn wiring — cohort 4 mechanical slice of the
 * SessionManager decomposition (docs/design/session-manager-decomposition.md,
 * cluster A/B rebuild paths). This intentionally preserves the existing
 * restore/respawn implementations inside host-bound functions; the
 * SessionManager methods remain same-named delegating wrappers so tests that
 * monkey-patch `restoreSession`, `_restoreSessionCoalesced`, or
 * `_respawnAgentInPlace` keep hitting the exact same runtime seam.
 *
 * DOC DRIFT vs. the design doc's cohort-4 wording: the doc calls for unifying
 * restore/force-abort/assign-role onto session-setup.ts's pipeline. This lane
 * requires zero behavior change, so this cohort only extracts the revive/
 * respawn core; pipeline unification is now a smaller follow-up inside this
 * module.
 */
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { EventBuffer } from "./event-buffer.js";
import { PromptQueue } from "./prompt-queue.js";
import { type RpcBridgeOptions } from "./rpc-bridge.js";
import { assertRuntimeAllowedForSession, createSessionBridge, hydrateRuntimeOptions, resolveSessionRuntime } from "./session-runtime.js";
import { sessionFsContextForAgentFile } from "./session-fs.js";
import { sanitizeAgentTranscriptFile, trustPersistedAgentSessionFile } from "./transcript-sanitizer.js";
import { type PersistedSession } from "./session-store.js";
import type { SessionStatus, SessionInfo } from "./session-manager.js";
import { shouldKeepDespiteOrphan } from "./orphan-cleanup.js";
import { getAssistantDef } from "./assistant-registry.js";
import { buildReattemptContext } from "./goal-assistant.js";
import { tagAllowedTool, type EffectiveTool } from "./tool-activation.js";
import { HEADQUARTERS_PROJECT_ID } from "./project-registry.js";
import { isSandboxExemptProject } from "./sandbox-manager.js";
import { truncateLargeToolContent } from "./truncate-large-content.js";
import { buildRestoreRolePrompt } from "./role-prompt.js";
import { applyPromptConditionals } from "./prompt-conditionals.js";
import { broadcastStatus } from "./session-status.js";
import { emitSessionEvent, isUserVisibleActivity, switchSessionPathForAgent } from "./session-manager.js";

const execFileAsync = promisify(execFileCb);

export interface SessionReviveDeps {
	host: any;
}

export class SessionRevive {
	constructor(private readonly deps: SessionReviveDeps) {}

	/**
	 * Restart a session's agent process so it picks up updated role/tools.
	 * Stops the current agent, then restores from the persisted session file
	 * which re-applies tool activation with the updated role.
	 */
	async restartSessionWithUpdatedRole(session: SessionInfo): Promise<void> {
		const ps = this.deps.host.resolveStoreForSession(session.id).get(session.id);
		if (!ps) return;

		// Save in-memory grant state that restoreSession doesn't persist.
		const savedSessionOnlyGrantedTools = session.sessionOnlyGrantedTools ? [...session.sessionOnlyGrantedTools] : undefined;
		const savedOneTimeGrantedTools = session.oneTimeGrantedTools ? [...session.oneTimeGrantedTools] : undefined;
		const overrideAllowedTools = this.deps.host.recomputeAllowedToolsForRestart(session, ps);
		// One-time grants authorize only the currently blocked invocation; do not
		// pre-populate the guard's process-local cache across respawn/refresh.
		const overrideGrantedTools = savedSessionOnlyGrantedTools;

		const restored = await this.deps.host._respawnAgentInPlace(session, ps, {
			mutatePs: (p: PersistedSession) => {
				if (overrideAllowedTools) (p as any)._overrideAllowedTools = overrideAllowedTools;
				if (overrideGrantedTools) (p as any)._overrideGrantedTools = overrideGrantedTools;
			},
		});

		if (restored) {
			if (savedSessionOnlyGrantedTools) restored.sessionOnlyGrantedTools = savedSessionOnlyGrantedTools;
			if (savedOneTimeGrantedTools) restored.oneTimeGrantedTools = savedOneTimeGrantedTools;
		}
	}

	/**
	 * Snapshot the per-session monotonic counters that the client keeps in
	 * lockstep with the server: the streaming-event `seq` (EventBuffer.lastSeq)
	 * and the canonical `statusVersion`. Used by `restartAgent` /
	 * `_restartSessionWithUpdatedRole` to seed the freshly-built EventBuffer
	 * and SessionInfo so the client's `_highestSeq` and `_lastStatusVersion`
	 * trackers — which never get reset because the WS stays open across the
	 * respawn — keep applying live frames instead of silently dropping them as
	 * "duplicates".
	 *
	 * The numbers we hand back are the high-water marks. The post-restart code
	 * primes the new buffer with `seedNextSeq(lastSeq + 1)` and the new
	 * SessionInfo with `statusVersion: lastVersion`; the very next live frame
	 * therefore lands at seq = lastSeq + 1 / version = lastVersion + 1, which
	 * advances both client trackers naturally.
	 */
	snapshotStreamingFrameOfReference(session: SessionInfo): { lastSeq: number; lastStatusVersion: number } {
		return {
			lastSeq: session.eventBuffer.lastSeq,
			lastStatusVersion: session.statusVersion ?? 0,
		};
	}

	/**
	 * Respawn a session's agent process in-place while WS clients stay attached.
	 *
	 * Owns the snapshot/unsubscribe/stop/restore/re-attach/broadcast dance shared
	 * by `restartAgent`, `_restartSessionWithUpdatedRole`, `recoverSandboxSessions`,
	 * and the in-memory branch of `ensureSessionAlive`.
	 *
	 * The streaming frame-of-reference is snapshotted AFTER `unsubscribe()` so a
	 * final in-flight `agent_end`-style event cannot race past `lastSeq`. The
	 * carry-over fields (`_restartFrameOfReference`, `_overrideAllowedTools`)
	 * are stashed on the persisted-session record for `restoreSession()` to
	 * consume, then unconditionally cleared in `finally`.
	 */
	async respawnAgentInPlace(
		session: SessionInfo,
		ps: PersistedSession,
		opts?: { mutatePs?: (ps: PersistedSession) => void; finalStatus?: SessionStatus },
	): Promise<SessionInfo | undefined> {
		return this.deps.host._coalesceRestore(session.id, async (generation: number) => {
			const savedClients = new Set(session.clients);
			// Snapshot AFTER unsubscribe so no in-flight event races past lastSeq.
			session.unsubscribe();
			const frameOfRef = this.deps.host._snapshotStreamingFrameOfReference(session);
			this.deps.host._fenceReplacedSession(session, generation);
			try { await session.rpcClient.stop(); } catch { /* already dead */ }

			this.deps.host.sessions.delete(session.id);
			// PERF-05: session is about to be re-registered by restoreSession()
			// below; drop any stale taskId-resolution cache entry so it's
			// recomputed fresh rather than briefly missing from the map with a
			// now-orphaned cache entry.
			this.deps.host.taskIdCache.delete(session.id);
			(ps as any)._restartFrameOfReference = frameOfRef;
			opts?.mutatePs?.(ps);
			try {
				await this.deps.host.restoreSession(ps);
			} finally {
				delete (ps as any)._restartFrameOfReference;
				delete (ps as any)._overrideAllowedTools;
				delete (ps as any)._overrideGrantedTools;
			}
			const restored = this.deps.host.sessions.get(session.id);
			if (restored) {
				restored.lifecycleGeneration = generation;
				for (const ws of savedClients) {
					if ((ws as any).readyState === 1) restored.clients.add(ws);
				}
				broadcastStatus(restored, opts?.finalStatus ?? "idle");
				this.deps.host._trackConnectedSession(restored);
			}
			return restored;
		});
	}

	async restoreSession(ps: PersistedSession): Promise<void> {
		const bridgeOptions: RpcBridgeOptions = { cwd: ps.cwd };
		if (this.deps.host.agentCliPath) bridgeOptions.cliPath = this.deps.host.agentCliPath;
		if (this.deps.host.toolManager) bridgeOptions.toolManager = this.deps.host.toolManager;

		// Restore env vars needed by extensions. The per-session capability
		// secret (S1) is regenerated here on restore and handed to the
		// re-spawned agent process — see `session-secret.ts` (restart-safe).
		bridgeOptions.env = {
			BOBBIT_SESSION_ID: ps.id,
			BOBBIT_SESSION_SECRET: this.deps.host.sessionSecretStore.getOrCreateSecret(ps.id),
		};
		if (ps.goalId) {
			bridgeOptions.env.BOBBIT_GOAL_ID = ps.goalId;
		}
		if (ps.staffId) {
			bridgeOptions.env.BOBBIT_STAFF_ID = ps.staffId;
		}

		// ── Restore Docker sandbox wiring ──
		let restoredSandboxed = ps.sandboxed === true && !(ps.projectId && isSandboxExemptProject(ps.projectId));
		if (ps.sandboxed === true) {
			// Keep applySandboxWiring as the single restore decision point. It uses
			// the selected project's config internally, returns false for non-docker
			// projects, and preserves Headquarters/system no-sandbox exemptions.
			// On restore, the worktree already exists inside the container —
			// pass the container-internal cwd directly (no branch = no worktree creation).
			if (ps.cwd?.startsWith("/workspace")) {
				bridgeOptions.cwd = ps.cwd;
			}
			restoredSandboxed = await this.deps.host.applySandboxWiring(bridgeOptions, ps.id, {
				projectId: ps.projectId,
				goalId: ps.goalId ?? ps.teamGoalId,
			});
			if (!restoredSandboxed) {
				ps.sandboxed = false;
				this.deps.host.resolveStoreForSession(ps.id).update(ps.id, { sandboxed: false });
				this.deps.host.applyScopedGatewayCredentials(bridgeOptions, ps.id, ps.projectId, ps.goalId ?? ps.teamGoalId);
			}
		} else {
			if (ps.sandboxed) {
				ps.sandboxed = false;
				this.deps.host.resolveStoreForSession(ps.id).update(ps.id, { sandboxed: false });
			}
			this.deps.host.applyScopedGatewayCredentials(bridgeOptions, ps.id, ps.projectId, ps.goalId ?? ps.teamGoalId);
		}
		if (restoredSandboxed) {
			// Verify the sandbox worktree still exists inside the container. Headquarters
			// sessions are no-worktree, so never repair/recreate /workspace-wt paths.
			if (ps.projectId !== HEADQUARTERS_PROJECT_ID && ps.cwd?.startsWith("/workspace-wt/") && bridgeOptions.containerId) {
				try {
					await execFileAsync("docker", [
						"exec", bridgeOptions.containerId, "test", "-d", ps.cwd,
					], { timeout: 5_000 });
					console.log(`[session-manager] Sandbox worktree verified for ${ps.id}: ${ps.cwd}`);
				} catch {
					console.warn(`[session-manager] Sandbox worktree MISSING for ${ps.id}: ${ps.cwd} — attempting recovery`);
					let recovered = false;

					// Try git worktree repair first — handles broken .git link files after hard container kill
					try {
						await execFileAsync("docker", [
							"exec", "-w", "/workspace", bridgeOptions.containerId!,
							"git", "worktree", "repair",
						], { timeout: 10_000 });
						// Re-check if worktree now exists after repair
						await execFileAsync("docker", [
							"exec", bridgeOptions.containerId!, "test", "-d", ps.cwd!,
						], { timeout: 5_000 });
						console.log(`[session-manager] Sandbox worktree repaired for ${ps.id}: ${ps.cwd}`);
						recovered = true;
					} catch {
						// Repair didn't help — fall through to createWorktree
					}

					if (!recovered && ps.branch && ps.projectId && this.deps.host.sandboxManager) {
						const sandbox = this.deps.host.sandboxManager.get(ps.projectId);
						if (sandbox) {
							try {
								// Derive the container worktree root, not a cwd subdirectory offset.
								// e.g. /workspace-wt/session/s-9241bb92/packages/app → session/s-9241bb92
								const branchWorktreeRoot = `/workspace-wt/${ps.branch}`;
								const worktreeName = (ps.cwd === branchWorktreeRoot || ps.cwd!.startsWith(`${branchWorktreeRoot}/`))
									? ps.branch
									: ps.cwd!.replace(/^\/workspace-wt\//, "");
								await sandbox.createWorktree(worktreeName, ps.branch);
								console.log(`[session-manager] Sandbox worktree recovered for ${ps.id}: ${ps.cwd}`);
								recovered = true;
							} catch (err) {
								console.warn(`[session-manager] Sandbox worktree recovery failed for ${ps.id}:`, err);
							}
						}
					}
					if (!recovered) {
						if (shouldKeepDespiteOrphan(ps)) {
							console.warn(`[orphan-cleanup] WARN: would-archive ${ps.id} but worktree+recent-transcript present — leaving live`);
							this.deps.host.addDormantSession(ps);
							return;
						}
						console.warn(`[session-manager] Archiving session ${ps.id} — sandbox worktree unrecoverable`);
						try { this.deps.host.getSessionStore(ps.projectId).archive(ps.id); } catch { /* best-effort */ }
						return; // Skip restoring this session
					}
				}
			}
		}

		// Restore extension args for goal/team sessions
		if (ps.goalId && !ps.assistantType) {
			const isTeamLead = ps.role === "team-lead";
			if (isTeamLead) {
				// Team leads need both: team tools + goal tools (tasks/gates)
				bridgeOptions.args = ["--extension", this.deps.host.getTeamLeadExtensionPath(), "--extension", this.deps.host.getGoalToolsExtensionPath()];
			} else {
				bridgeOptions.args = ["--extension", this.deps.host.getGoalToolsExtensionPath()];
			}
		}

		// Restore proposal tools extension for assistant sessions
		if (ps.assistantType) {
			bridgeOptions.args = bridgeOptions.args || [];
			const proposalExtPath = this.deps.host.getProposalToolsExtensionPath();
			if (!bridgeOptions.args.includes(proposalExtPath)) {
				bridgeOptions.args.push("--extension", proposalExtPath);
			}
		}

		// Restore tool activation. Roleless normal sessions still use the general
		// role so Bobbit extension tools and group policies are restored.
		const overrideAllowedTools: string[] | undefined = (ps as any)._overrideAllowedTools;
		const overrideGrantedTools: string[] | undefined = (ps as any)._overrideGrantedTools;
		// Preserve a persisted EXPLICIT empty allowlist (`[]` = NO tools) as distinct
		// from absent (`undefined` = fall back to role defaults). Only a missing /
		// non-array value falls back; `[]` must survive restore so a restricted
		// session (e.g. allowlist emptied by bobbit.disabledTools) does not silently
		// re-acquire role-default tools on restart.
		const persistedAllowedTools = Array.isArray(ps.allowedTools) ? ps.allowedTools : undefined;
		const hasExplicitAllowlist = overrideAllowedTools !== undefined || persistedAllowedTools !== undefined;
		const restoredRole = this.deps.host.resolveSessionRole(ps.role, ps.assistantType, ps.projectId);
		const effectiveAllowed: EffectiveTool[] = overrideAllowedTools
			? overrideAllowedTools.map(n => tagAllowedTool(n, this.deps.host.toolManager))
			: persistedAllowedTools
				? persistedAllowedTools.map(n => tagAllowedTool(n, this.deps.host.toolManager))
				: this.deps.host.resolveEffectiveAllowedTools(restoredRole);
		// Filter goal-metadata disabled tools (bobbit.disabledTools) from the
		// restored allowlist so the prompt tool-docs + persisted allowedTools stay
		// consistent with what buildToolActivationArgs actually activates.
		const restoreEffectiveGoalId = ps.goalId ?? ps.teamGoalId;
		const restoreDisabled = this.deps.host.disabledToolsForGoal(restoreEffectiveGoalId, ps.projectId);
		// Per-goal prompt section ordering (bobbit.promptSectionOrder) for the
		// session's EFFECTIVE goal — mirrors session-setup's initial-setup path so
		// a restored session keeps its goal's custom order instead of reverting to
		// the default after a gateway restart. Undefined ⇒ byte-identical default.
		const restoreSectionOrder = this.deps.host.promptSectionOrderForGoal(restoreEffectiveGoalId, ps.projectId);
		const restoredFiltered = restoreDisabled
			? effectiveAllowed.filter(e => !restoreDisabled.has(e.name.toLowerCase()))
			: effectiveAllowed;
		// Preserve the unrestricted (`undefined`) vs explicit-empty (`[]`)
		// distinction. A genuinely unrestricted session (role-less / no
		// toolManager, NO persisted/override allowlist) resolves `effectiveAllowed`
		// to `[]` and must map to `undefined` (all tools). But when there WAS an
		// explicit allowlist source — a persisted/override `[]`, or an allowlist
		// `bobbit.disabledTools` removed entirely — `restoredFiltered` is `[]` and
		// must stay `[]` (NO tools); never collapse it to `undefined`, which would
		// re-grant every tool on restart.
		const restoredAllowedTools: EffectiveTool[] | undefined =
			(hasExplicitAllowlist || effectiveAllowed.length > 0) ? restoredFiltered : undefined;
		const restoredAllowedNames = restoredAllowedTools?.map(e => e.name);
		await this.deps.host.ensureMcpManagerForContext(ps.projectId, ps.cwd);
		const restoredActivation = this.deps.host.buildToolActivationArgs(ps.id, restoredAllowedTools, restoredRole, ps.cwd, ps.projectId, ps.goalId ?? ps.teamGoalId, overrideGrantedTools);
		bridgeOptions.args = [...restoredActivation.args, ...(bridgeOptions.args || [])];
		bridgeOptions.piExtensions = [...(bridgeOptions.piExtensions ?? []), ...restoredActivation.runtimeExtensions];
		bridgeOptions.env = { ...(bridgeOptions.env || {}), ...restoredActivation.env };

		// Re-assemble system prompt (global + AGENTS.md + goal spec)
		const assistantDef = ps.assistantType ? getAssistantDef(ps.assistantType) : undefined;
		if (assistantDef) {
			// Combine assistant role's shared prompt with per-type specialized prompt
			const assistantTemplate = this.deps.host.resolveRolePromptTemplate("assistant", ps.projectId);
			let assistantGoalSpec = "";
			if (assistantTemplate) {
				assistantGoalSpec = assistantTemplate.replace(/\{\{AGENT_ID\}\}/g, `assistant-${(ps.goalId || ps.id).slice(0, 8)}`);
				assistantGoalSpec += "\n\n---\n\n";
			}
			assistantGoalSpec += assistantDef.prompt;
			if (ps.assistantType === "goal") {
				assistantGoalSpec = assistantGoalSpec.replace('{{AVAILABLE_WORKFLOWS}}', this.deps.host._buildWorkflowList(ps.projectId));
				// Inject re-attempt context if this is a re-attempt session
				if (ps.reattemptGoalId) {
					const origGoal = this.deps.host.resolveGoal(ps.reattemptGoalId);
					if (origGoal) {
						assistantGoalSpec += "\n\n" + buildReattemptContext(origGoal, this.deps.host.prStatusStore!);
					}
				}
			}
			assistantGoalSpec = applyPromptConditionals(assistantGoalSpec, { subGoalsEnabled: this.deps.host.isSubgoalsEnabled });

			const promptPath = this.deps.host.assemblePrompt(ps.id, {
				// Restore/respawn path: keep the global base prompt so it reaches
				// restored assistant sessions.
				baseSystemPromptPath: this.deps.host.systemPromptPath,
				cwd: ps.cwd,
				goalSpec: assistantGoalSpec,
				goalTitle: assistantDef.promptTitle,
				goalState: "active",
				allowedTools: restoredAllowedNames,
				projectConfigStore: this.deps.host.projectConfigStore,
				sectionOrder: restoreSectionOrder,
			});
			if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		} else if (ps.delegateOf && !ps.goalId) {
			// Delegate restore: rebuild the system prompt from durable instructions +
			// context — the delegate's equivalent of a worker task spec. Use the Task
			// fields so restored delegates and prompt-section reconstruction agree.
			const promptPath = this.deps.host.assemblePrompt(ps.id, this.deps.host.buildDelegatePromptParts({
				cwd: ps.cwd,
				// Keep AGENTS.md / project config dirs readable for sandbox or multi-repo
				// delegates whose cwd is container-internal.
				projectRoot: ps.repoPath,
				instructions: ps.instructions || "",
				context: ps.context,
				allowedTools: restoredAllowedNames,
				sectionOrder: restoreSectionOrder,
			}));
			if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		} else {
			const goal = ps.goalId ? this.deps.host.resolveGoal(ps.goalId) : undefined;

			// Re-attach role/staff prompt (lost on restart since rolePrompt isn't
			// persisted). Staff sessions rebuild the full role context + systemPrompt
			// + pinned memory via buildStaffSystemPrompt; team agents resolve the role
			// template. See buildRestoreRolePrompt.
			const goalSpec = goal?.spec;
			const { rolePrompt, roleName } = buildRestoreRolePrompt(ps, {
				goalBranch: goal?.branch,
				roleManager: this.deps.host.roleManager,
				getStaff: this.deps.host.staffRecordSource ? (id) => this.deps.host.staffRecordSource!.getStaff(id) : undefined,
				resolveTemplate: (rn, pid) => this.deps.host.resolveRolePromptTemplate(rn, pid),
				subGoalsEnabled: this.deps.host.isSubgoalsEnabled,
			});

			const promptPath = this.deps.host.assemblePrompt(ps.id, {
				baseSystemPromptPath: this.deps.host.systemPromptPath,
				cwd: ps.cwd,
				goalTitle: goal?.title,
				goalState: goal?.state,
				goalSpec,
				rolePrompt,
				roleName,
				allowedTools: restoredAllowedNames,
				projectConfigStore: this.deps.host.projectConfigStore,
				sectionOrder: restoreSectionOrder,
				promptProfile: ps.nonInteractive ? "reviewer" : undefined,
			});
			if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		}

		// Pin model + thinking level at spawn so pi-coding-agent doesn't emit a
		// redundant initial `model_change` event with its hardcoded default.
		// Prefer the persisted model if known (avoids surprising changes after
		// restart); fall back to role/preference resolution.
		if (ps.modelProvider && ps.modelId) {
			bridgeOptions.initialModel = `${ps.modelProvider}/${ps.modelId}`;
		} else {
			const initModel = this.deps.host.resolveInitialModel(ps.role, ps.projectId);
			if (initModel) bridgeOptions.initialModel = initModel;
		}
		const initThinking = this.deps.host.resolveInitialThinkingLevel(ps.role, ps.projectId);
		if (initThinking) bridgeOptions.initialThinkingLevel = initThinking;
		this.deps.host.applyDirectProviderEnv(bridgeOptions, !!ps.sandboxed, ps.modelProvider);

		const runtime = resolveSessionRuntime({ runtime: ps.runtime, initialModel: bridgeOptions.initialModel, modelProvider: ps.modelProvider });
		assertRuntimeAllowedForSession(runtime, ps.sandboxed);
		Object.assign(bridgeOptions, hydrateRuntimeOptions({
			...bridgeOptions,
			runtime,
			claudeCodeSessionId: ps.claudeCodeSessionId,
			claudeCodeExecutable: ps.claudeCodeExecutable,
			claudeCodePermissionMode: ps.claudeCodePermissionMode,
			claudeCodeModelAlias: ps.claudeCodeModelAlias,
			readOnly: ps.readOnly,
		}, this.deps.host.readClaudeCodeConfigForProject(ps.projectId)));

		const rpcClient = createSessionBridge(bridgeOptions);
		const eventBuffer = new EventBuffer();
		// In-place restart paths (`restartAgent`, `_restartSessionWithUpdatedRole`)
		// stash the previous session's streaming frame-of-reference on `ps` so the
		// new EventBuffer/SessionInfo continue the monotonic seq + statusVersion
		// sequence space. Clients keep their WS open across the respawn, so a
		// fresh seq-1 / version-1 frame would be silently dropped by their dedup
		// gates. See _snapshotStreamingFrameOfReference().
		const frameOfRef = (ps as any)._restartFrameOfReference as
			| { lastSeq: number; lastStatusVersion: number }
			| undefined;
		if (frameOfRef && Number.isFinite(frameOfRef.lastSeq) && frameOfRef.lastSeq > 0) {
			eventBuffer.seedNextSeq(frameOfRef.lastSeq + 1);
		}
		const initialStatusVersion = frameOfRef && Number.isFinite(frameOfRef.lastStatusVersion)
			? frameOfRef.lastStatusVersion
			: 0;

		const session: SessionInfo = {
			id: ps.id,
			title: ps.title,
			cwd: ps.cwd,
			status: "starting",
			statusVersion: initialStatusVersion,
			lifecycleGeneration: this.deps.host._currentRespawnGeneration(ps.id),
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
			delegateOf: ps.delegateOf,
			parentSessionId: ps.parentSessionId,
			childKind: ps.childKind,
			readOnly: ps.readOnly,
			role: ps.role,
			teamGoalId: ps.teamGoalId,
			teamLeadSessionId: ps.teamLeadSessionId,
			worktreePath: ps.worktreePath,
			taskId: ps.taskId,
			staffId: ps.staffId,
			accessory: ps.accessory,
			preview: ps.preview,
			allowedTools: restoredAllowedNames,
			promptQueue: new PromptQueue(ps.messageQueue),
			streamingStartedAt: ps.streamingStartedAt,
			restoreStartupWasStreaming: ps.wasStreaming === true,
			projectId: ps.projectId,
			inFlightSteerTexts: Array.isArray(ps.inFlightSteerTexts) ? [...ps.inFlightSteerTexts] : undefined,
			spawnPinnedModel: bridgeOptions.initialModel,
			spawnPinnedThinkingLevel: bridgeOptions.initialThinkingLevel,
			thinkingLevelUserPinned: ps.thinkingLevelUserPinned,
			repoPath: ps.repoPath,
			branch: ps.branch,
			worktreePushPolicy: ps.worktreePushPolicy,
			remotePublicationPolicy: ps.remotePublicationPolicy,
			repoWorktrees: ps.repoWorktrees && ps.repoPath
				? Object.entries(ps.repoWorktrees).map(([repo, worktreePath]) => ({
					repo,
					repoPath: repo === "." ? ps.repoPath! : path.join(ps.repoPath!, repo),
					worktreePath,
				}))
				: undefined,
			sandboxed: ps.sandboxed,
		};

		// Skip cost tracking during session restore (switch_session replays
		// all historical message_update events which would double-count costs)
		let restoring = true;

		const restoreStore = this.deps.host.getSessionStore(ps.projectId);
		const unsub = rpcClient.onEvent((event: any) => {
			// During restore, switch_session replays every persisted message as an
			// rpc event. Bumping lastActivity here would clobber the pre-restart
			// timestamp with Date.now(). Gate on the restoring flag AND on
			// isUserVisibleActivity so post-resume lifecycle frames (agent_start,
			// agent_idle, connection_state, state, session_title) don't clobber it.
			if (!restoring) {
				if (isUserVisibleActivity(event)) {
					session.lastActivity = Date.now();
					restoreStore.update(ps.id, { lastActivity: session.lastActivity });
				}
			}

			this.deps.host.handleAgentLifecycle(session, event);

			const truncated = truncateLargeToolContent(event);
			emitSessionEvent(session, truncated);
			if (!restoring) this.deps.host.trackCostFromEvent(session, event);
		});

		bridgeOptions.onPiExtensionDiagnostic = (diagnostic, extension) => this.deps.host.recordPiExtensionDiagnostic(session, diagnostic, extension);
		session.unsubscribe = unsub;

		await rpcClient.start();

		// Resume the agent's previous session file. Persisted host paths are still
		// readable by Bobbit; sandboxed agents receive the active mount's container
		// path when the host path maps to the active sessions mount.
		trustPersistedAgentSessionFile(ps.agentSessionFile);
		const transcriptFileCtx = sessionFsContextForAgentFile(ps, ps.agentSessionFile);
		const switchSessionPath = switchSessionPathForAgent(ps);
		// Un-poison any blank-text user messages persisted before the
		// attachment-only fix, so the agent doesn't re-send an invalid blank
		// ContentBlock on resume (best-effort, non-fatal).
		await sanitizeAgentTranscriptFile(
			transcriptFileCtx,
			ps.agentSessionFile,
			this.deps.host.sandboxManager,
		);
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

		try {
			await this.deps.host.tryAutoSelectModel(session);
		} catch (err) {
			await rpcClient.stop();
			throw err;
		}

		broadcastStatus(session, "idle");

		// For sandbox sessions, resolve the container ID so git-status and other
		// host-side operations can run commands inside the container via docker exec.
		// The containerId is not persisted — it's resolved from SandboxManager which
		// reconnects to the existing container by label on startup.
		if (ps.sandboxed && this.deps.host.sandboxManager && ps.projectId) {
			try {
				const sandbox = this.deps.host.sandboxManager.get(ps.projectId);
				if (sandbox) {
					session.containerId = await sandbox.getContainerId();
				}
			} catch (err) {
				console.warn(`[session-manager] Could not resolve container for sandbox session ${ps.id}: ${err}`);
			}
		}

		this.deps.host.sessions.set(ps.id, session);

		// `switch_session` replays durable user message echoes and `_consumeSteerEcho`
		// clears matching ledger entries. Anything left here was accepted for
		// dispatch but not echoed before the gateway died, so re-enqueue it once.
		this.deps.host._reconcileInFlightSteers(session);

		// Restore + re-attach this session's persisted background processes. The
		// session now exists and (for sandboxed sessions) containerId has been
		// re-resolved, so liveness/re-attach can target the live process.
		const bgMgr = (this.deps.host as any).bgProcessManager;
		if (bgMgr?.restoreSession) {
			try { await bgMgr.restoreSession(ps.id); }
			catch (err) { console.warn(`[session-manager] bg-process restore failed for ${ps.id}:`, err); }
		}

		// If the agent was mid-turn when the server died, re-prompt it to continue.
		// EXCEPTION: verification reviewer / agent-qa sessions are nonInteractive
		// and are re-driven EXCLUSIVELY by the verification harness
		// (`resumeInterruptedVerifications()` -> `_tryResumeFromSession`, which
		// waits for readiness and sends its own reminder prompt). Firing the boot
		// nudge here too would race two prompts on the same cold reviewer agent.
		// We still clear `wasStreaming` so the flag doesn't leak across restarts.
		if (ps.wasStreaming && ps.nonInteractive) {
			console.log(`[session-manager] Session "${ps.title}" (${ps.id}) was interrupted mid-turn but is nonInteractive — leaving re-drive to the verification harness`);
			restoreStore.update(ps.id, { wasStreaming: false });
		} else if (ps.wasStreaming) {
			console.log(`[session-manager] Session "${ps.title}" (${ps.id}) was interrupted mid-turn — re-prompting to continue`);
			restoreStore.update(ps.id, { wasStreaming: false });
			// Record a boot-coordination marker so the team-manager boot-resume
			// nudge skips this lead and we don't race two prompts at the same
			// cold agent. Cleared in handleAgentLifecycle on agent_start.
			this.deps.host._bootRepromptedSessions.add(ps.id);
			// Cold agent: wait for readiness, then prompt with a generous timeout
			// (the default 30s reliably times out on boot). Keep the .catch() so a
			// failure is logged and never throws.
			rpcClient.promptWhenReady(
				"[SYSTEM: The infrastructure server restarted while you were mid-turn. " +
				"Your previous work has been preserved. Please continue where you left off. " +
				"Do NOT start over — review your recent messages and resume from the exact point of interruption.]"
			).catch((err: any) => {
				console.error(`[session-manager] Failed to re-prompt interrupted session ${ps.id}:`, err);
			});
		}
	}

}
