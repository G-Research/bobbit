/**
 * Session boot restore/reap wiring - SessionManager decomposition cohort 8.
 *
 * Extracted mechanically from session-manager.ts: startup restore orchestration,
 * delegate/child boot reaping, worktree recovery, orphan-transcript scanning,
 * and dormant placeholder creation. SessionManager keeps same-named delegating
 * wrappers so existing callers and test monkey-patches keep hitting the legacy
 * method seams.
 */
import fs from "node:fs";
import path from "node:path";
import { EventBuffer } from "./event-buffer.js";
import { PromptQueue } from "./prompt-queue.js";
import { RpcBridge } from "./rpc-bridge.js";
import { sessionFileExists, sessionFsContextForAgentFile } from "./session-fs.js";
import { type PersistedSession, type SessionRuntime, SessionStore } from "./session-store.js";
import type { SessionInfo } from "./session-manager.js";
import { shouldKeepDespiteOrphan, scanOrphanedTranscripts } from "./orphan-cleanup.js";
import { activeAgentSessionsDir } from "./agent-session-path.js";
import { shouldReapChildOnBoot, shouldSendRestartCollectionReminder } from "./orchestration-core.js";
import { resolveSessionRuntime } from "./session-runtime.js";
import { trustPersistedAgentSessionFile } from "./transcript-sanitizer.js";

export interface SessionBootDeps {
	host: any;
}

function canResumeClaudeCodeSession(ps: Pick<PersistedSession, "runtime" | "modelProvider" | "claudeCodeSessionId"> | undefined): boolean {
	if (!ps || typeof ps.claudeCodeSessionId !== "string" || !ps.claudeCodeSessionId.trim()) return false;
	return resolveSessionRuntime({ runtime: ps.runtime as SessionRuntime | undefined, modelProvider: ps.modelProvider }) === "claude-code";
}

export class SessionBoot {
	constructor(private readonly deps: SessionBootDeps) {}

	/**
	 * Restore sessions from disk on startup.
	 * Re-spawns agent processes and uses switch_session to resume each one.
	 */
	async restoreSessions(): Promise<void> {
		const host = this.deps.host;
		// Initialize search service (skip when ProjectContextManager is active —
		// ProjectContext.open() already opens the service and wires callbacks)
		if (!host.projectContextManager && host._testSearchIndex && host._testStore && host._testGoalManager) {
			try {
				const goalStore = host._testGoalManager.getGoalStore();
				const testSearchIndex = host._testSearchIndex;
				testSearchIndex.open({ goalStore, sessionStore: host._testStore });
				// Wire index update callbacks
				goalStore.onIndexUpdate = (goal: any) => {
					try {
						testSearchIndex.indexGoal(goal, goal.projectId || "");
						for (const session of host._testStore?.getAll() ?? []) {
							if (session.goalId !== goal.id) continue;
							testSearchIndex.indexSession(session, goal.title, session.projectId || "");
							testSearchIndex.reindexMessagesForSession(session, goal.title, session.projectId || "");
						}
					} catch (err) { console.error("[search] Failed to index goal:", err); }
				};
				host._testStore.onIndexUpdate = (session: PersistedSession) => {
					try {
						const goalTitle = session.goalId ? host.resolveGoal(session.goalId)?.title : undefined;
						testSearchIndex.indexSession(session, goalTitle, session.projectId || "");
						testSearchIndex.reindexMessagesForSession(session, goalTitle, session.projectId || "");
					} catch (err) { console.error("[search] Failed to index session:", err); }
				};
			} catch (err) {
				console.error("[search] Failed to initialize search index:", err);
			}
		}

		const persisted = host.projectContextManager
			? [...host.projectContextManager.getAllLiveSessions()]
			: (host._testStore?.getLive() ?? []);
		if (persisted.length === 0) return;

		// Separate regular sessions from delegate sessions
		const regular = persisted.filter((ps: PersistedSession) => !ps.delegateOf);
		const delegates = persisted.filter((ps: PersistedSession) => !!ps.delegateOf);

		// Delegate boot-reap (orchestration-core §5): archive an orphaned delegate
		// child (owner gone/archived) BEFORE dispatch. This reap MUST stay in
		// restoreSessions() — the orphan-reap wiring test stubs restoreOneSession to
		// a no-op and still expects the orphan archived, so it cannot move into the
		// per-session path. Survivors are NOT deferred as dormant husks anymore:
		// they ride the SAME live-restore path workers use (restoreOneSession →
		// restoreSession), so a delegate comes back as a live process with its task
		// rebuilt from the durable instructions/context fields, and the parent's
		// team_wait re-attaches to a live child and collects a real result. A delegate
		// that was mid-turn is re-driven by the shared wasStreaming boot-resume nudge
		// in restoreSession() — no delegate-specific registry.
		const delegateSurvivors: PersistedSession[] = [];
		for (const ps of delegates) {
			if (!ps.agentSessionFile && !canResumeClaudeCodeSession(ps)) {
				try { host.getSessionStore(ps.projectId).archive(ps.id); } catch { /* project gone */ }
				continue;
			}
			// Reap an orphaned delegate child whose owner session is gone or archived.
			// A child whose owner is restoring (exists, not archived) survives and is
			// restored live below.
			const owner = ps.delegateOf ? host.getPersistedSession(ps.delegateOf) : undefined;
			const reap = shouldReapChildOnBoot({
				childKind: ps.childKind ?? "delegate",
				ownerSessionId: ps.delegateOf,
				ownerExists: !!owner,
				ownerArchived: owner?.archived === true,
			});
			if (reap.reap) {
				console.log(`[session-manager] Reaping orphaned delegate child ${ps.id} on boot — ${reap.reason}`);
				try { host.getSessionStore(ps.projectId).archive(ps.id); } catch { /* project gone */ }
				continue;
			}
			delegateSurvivors.push(ps);
		}

		const liveRestore = [...regular, ...delegateSurvivors];
		console.log(`[session-manager] Restoring ${regular.length} session(s) + ${delegateSurvivors.length} delegate(s) live...`);

		// Restore regular + surviving delegate sessions in parallel (batched concurrency)
		const CONCURRENCY = 5;
		for (let i = 0; i < liveRestore.length; i += CONCURRENCY) {
			const batch = liveRestore.slice(i, i + CONCURRENCY);
			await Promise.all(batch.map((ps: PersistedSession) => host.restoreOneSession(ps)));
		}

		// OrchestrationCore (§3/§4): rebuild the in-memory child index from the
		// already-persisted link fields (delegateOf / parentSessionId+childKind)
		// — no new persisted registry — then remind any owner with live restored
		// children to re-collect them via team_wait (restart survival, no
		// transparent tool-call resumption). Non-collectable child kinds (for
		// example team-managed and PR Walkthrough children) are skipped here.
		if (host.orchestrationCore) {
			try {
				host.orchestrationCore.rebuildIndexFromPersisted(persisted);
				await host.orchestrationCore.remindOwnersWithLiveChildren(shouldSendRestartCollectionReminder);
			} catch (err) {
				console.warn("[session-manager] OrchestrationCore boot index/reminder failed:", err);
			}
		}

		// Recover worktrees whose directories are missing OR whose .git metadata is broken.
		// This covers two failure modes:
		//   1. Directory deleted (cleanup, crash, manual removal)
		//   2. Directory exists but .git file is gone (partial git worktree remove on Windows,
		//      or worktree entry pruned by another git operation while files remain on disk)
		// Skip sandboxed sessions — their worktreePath is a container-internal path.
		for (const ps of persisted) {
			if (!ps.worktreePath || !ps.branch || !ps.repoPath || ps.sandboxed || ps.archived) continue;
			const dirExists = fs.existsSync(ps.worktreePath);
			const gitFileExists = dirExists && fs.existsSync(path.join(ps.worktreePath, ".git"));

			if (!dirExists || !gitFileExists) {
				const reason = !dirExists ? "directory missing" : ".git metadata missing";
				console.log(`[session-manager] Recovering worktree for "${ps.title}" (${ps.id}): ${reason}, branch: ${ps.branch}`);
				try {
					const { recoverWorktree } = await import("../skills/git.js");
					const recovered = await recoverWorktree(ps.repoPath, ps.branch, ps.worktreePath);
					if (recovered) {
						console.log(`[session-manager] Worktree recovered: ${recovered}`);
					} else {
						console.warn(`[session-manager] Could not recover worktree for "${ps.title}" (${ps.id}) — branch may be gone`);
					}
				} catch (err) {
					console.warn(`[session-manager] Worktree recovery failed for "${ps.title}" (${ps.id}):`, err);
				}
			}
		}

		// NOTE: Orphaned non-interactive session cleanup is no longer automatic
		// on startup. Use the Settings → Maintenance UI or
		// GET/POST /api/maintenance/orphaned-sessions to preview and clean up manually.

		// Scan for orphaned agent-CLI transcripts — surface a banner if the
		// session-metadata index has diverged from the on-disk JSONLs.
		try {
			const agentSessionsRoot = activeAgentSessionsDir();
			const tracked = new Set<string>();
			let mostRecent = 0;
			const allPersisted = host.projectContextManager
				? [...host.projectContextManager.getAllSessions()]
				: (host._testStore?.getAll() ?? []);
			for (const ps of allPersisted) {
				if (ps.agentSessionFile) tracked.add(ps.agentSessionFile);
				if (ps.lastActivity && ps.lastActivity > mostRecent) mostRecent = ps.lastActivity;
			}
			// If the store is empty (fresh install), use a 24h floor so we don't
			// flag every transcript from a previous install.
			const floor = mostRecent > 0 ? mostRecent : (Date.now() - 24 * 60 * 60 * 1000);
			const result = scanOrphanedTranscripts(agentSessionsRoot, tracked, floor);
			host.orphanedTranscriptsCount = result.count;
			if (result.count > 0) {
				console.warn(`[session-store] WARN: ${result.count} agent transcript(s) on disk are not tracked in sessions.json`);
			}
		} catch (err) {
			console.warn("[session-manager] orphan-transcript scan failed:", err);
		}
	}

	// NOTE: cleanupOrphanedNonInteractiveSessions() was removed — replaced by
	// listOrphanedNonInteractiveSessions() + terminateOrphanedSessions() which
	// are called via the /api/maintenance/* REST endpoints.

	async restoreOneSession(ps: PersistedSession): Promise<void> {
		const host = this.deps.host;
		// Backfill missing projectId from goal association (pre-fix sessions)
		if (!ps.projectId && ps.goalId && host.projectContextManager) {
			const ctx = host.projectContextManager.getContextForGoal(ps.goalId);
			if (ctx) {
				ps = { ...ps, projectId: ctx.project.id };
				try {
					host.getSessionStore(ctx.project.id).update(ps.id, { projectId: ctx.project.id });
					console.log(`[session-manager] Backfilled projectId for session ${ps.id} from goal ${ps.goalId}`);
				} catch { /* best-effort */ }
			}
		}
		// No projectId and no goalId: session predates multi-project and cannot be
		// safely assigned to any project at runtime. Skip restore rather than
		// silently dumping it into an arbitrary "default" project.
		if (!ps.projectId && !ps.goalId && !canResumeClaudeCodeSession(ps)) {
			console.warn(`[session-manager] Session ${ps.id} has no projectId and predates multi-project — skipping restore`);
			return;
		}
		let sessionStore: SessionStore;
		try {
			sessionStore = host.getSessionStore(ps.projectId);
		} catch {
			if (process.env.BOBBIT_DEBUG) console.log(`[session-manager] Skipping session ${ps.id} — project "${ps.projectId}" no longer registered`);
			return;
		}
		// Generalized boot-reap for ANY child linked by parentSessionId+childKind
		// (orchestration-core §5). Such children (pr-walkthrough, host-agents with
		// lifecycle:"full", and future kinds) are persisted sessions NOT linked by
		// `delegateOf` — so without this they would be resurrected as live node
		// processes on every restart (the session-leak bug), and a child whose
		// parent was archived while the server was down would come back as a LIVE
		// ORPHAN. (delegateOf-linked children are reaped in restoreSessions()'s
		// dormant-defer loop using the same helper.) pr-walkthrough additionally
		// supplies the generic `childTerminal` terminal signal (set server-side by
		// completing code) so a terminal reviewer is reaped with ZERO pack knowledge here.
		if (ps.childKind && ps.parentSessionId && !ps.delegateOf) {
			let kindTerminal = false;
			let kindTerminalReason: string | undefined;
			// GENERIC persisted terminal marker (orchestration-core Decision E /
			// Findings 3–4): any child stamped `childTerminal:true` by completing
			// server-side code is reapable on boot, with ZERO pack/kind knowledge here.
			// host-agents reviewers (e.g. pr-walkthrough's host.agents reviewer) rely on this.
			if (ps.childTerminal === true) {
				kindTerminal = true;
				kindTerminalReason = "child session marked terminal";
			}
			const parent = host.getPersistedSession(ps.parentSessionId);
			const decision = shouldReapChildOnBoot({
				childKind: ps.childKind,
				ownerSessionId: ps.parentSessionId,
				ownerExists: !!parent,
				ownerArchived: parent?.archived === true,
				kindTerminal,
				kindTerminalReason,
			});
			if (decision.reap) {
				console.log(`[session-manager] Reaping ${ps.childKind} child ${ps.id} on boot — ${decision.reason}`);
				sessionStore.archive(ps.id);
				return;
			}
		}
		if (!ps.agentSessionFile && !canResumeClaudeCodeSession(ps)) {
			// No session file path — persistSessionMetadata never completed.
			// Try to recover by scanning the sessions dir for a matching .jsonl.
			const recovered = host.recoverSessionFile(ps);
			if (recovered) {
				console.log(`[session-manager] Recovered session file for ${ps.id}: ${recovered}`);
				sessionStore.update(ps.id, { agentSessionFile: recovered });
				ps = { ...ps, agentSessionFile: recovered };
				// Fall through to normal restore below
			} else {
				if (shouldKeepDespiteOrphan(ps)) {
					console.warn(`[orphan-cleanup] WARN: would-archive ${ps.id} but worktree+recent-transcript present — leaving live`);
					host.addDormantSession(ps);
					return;
				}
				if (ps.worktreePath && ps.branch) {
					console.warn(
						`[session-manager] Session ${ps.id} has no agentSessionFile but has worktree ` +
						`(branch: ${ps.branch}, path: ${ps.worktreePath}). ` +
						`Code may be recoverable. Archiving session — branch "${ps.branch}" preserved in git.`,
					);
				} else {
					console.log(`[session-manager] Archiving ${ps.id} — no agent session file (metadata preserved)`);
				}
				sessionStore.archive(ps.id);
				return;
			}
		}
		trustPersistedAgentSessionFile(ps.agentSessionFile);
		const fileCtx = sessionFsContextForAgentFile(ps, ps.agentSessionFile);
		const fileFound = await sessionFileExists(fileCtx, ps.agentSessionFile, host.sandboxManager);
		if (!fileFound) {
			// `agentSessionFile` is set (persistSessionMetadata only records it after a
			// live getState) but no transcript exists on disk. Pi (>=0.77) creates the
			// session JSONL lazily on the first assistant flush with an exclusive
			// `openSync(file, "wx")`, and Bobbit must not pre-create it — so a crash or
			// server restart in that pre-flush window legitimately leaves the path
			// recorded with no file. That is NOT an orphan to archive.
			//
			// For non-sandboxed sessions this is fully recoverable without any sentinel
			// file: restoreSession() issues switch_session, which routes through
			// SessionManager.open -> setSessionFile. Pi handles a missing path by
			// starting a fresh session on the agent's cwd and creating the file on its
			// first write (the `wx` open then succeeds). Queued prompts replay normally.
			// If the worktree/cwd is actually gone, restoreSession() throws below and we
			// fall back to a dormant (never archived) session. Pinned by
			// tests/session-manager-no-precreate.test.ts.
			if (!ps.sandboxed) {
				console.log(`[session-manager] Session ${ps.id} recorded ${ps.agentSessionFile} but has no transcript yet (pre-flush restart) — restoring live; agent will create the file on first write`);
				// fall through to restoreSession()
			} else if (shouldKeepDespiteOrphan(ps)) {
				console.warn(`[orphan-cleanup] WARN: would-archive ${ps.id} but worktree+recent-transcript present — leaving live`);
				host.addDormantSession(ps);
				return;
			} else {
				console.log(`[session-manager] Archiving ${ps.id} — agent session file not found: ${ps.agentSessionFile} (metadata preserved)`);
				sessionStore.archive(ps.id);
				return;
			}
		}
		try {
			await host._restoreSessionCoalesced(ps);
			// Per-session restore detail is debug-only — the `Restoring N session(s)`
			// summary above covers the routine boot case; failures still log loudly.
			if (process.env.BOBBIT_DEBUG) console.log(`[session-manager] Restored: "${ps.title}" (${ps.id})`);
		} catch (err) {
			const msg = err instanceof Error ? (err.stack || err.message) : String(err);
			console.error(`[session-manager] Failed to restore "${ps.title}" (${ps.id}), will retry next restart:`, err);
			host.addDormantSession(ps, msg);
		}
	}

	addDormantSession(ps: PersistedSession, restoreError?: string): void {
		this.deps.host.sessions.set(ps.id, {
			id: ps.id,
			title: ps.title,
			cwd: ps.cwd,
			status: "terminated",
			statusVersion: 0,
			restoreError,
			dormant: true,
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
			parentSessionId: ps.parentSessionId,
			childKind: ps.childKind,
			readOnly: ps.readOnly,
			allowedTools: ps.allowedTools,
			projectId: ps.projectId,
			promptQueue: new PromptQueue(ps.messageQueue),
			inFlightSteerTexts: Array.isArray(ps.inFlightSteerTexts) ? [...ps.inFlightSteerTexts] : undefined,
		} satisfies SessionInfo);
	}
}
