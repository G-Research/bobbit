/**
 * Session cost plumbing - SessionManager decomposition cohort 7.
 *
 * Extracted mechanically from session-manager.ts: resolves per-project
 * CostTracker instances, hydrates persisted cumulative cost into reconnect
 * state, records live assistant `message_end` usage, and emits cost_update
 * frames. The SessionManager methods keep their original names/signatures and
 * delegate here so existing callers and test seams remain stable.
 */
import type { WebSocket } from "ws";
import type { ServerMessage } from "../ws/protocol.js";
import type { CostTracker, SessionCost } from "./cost-tracker.js";
import type { PersistedSession } from "./session-store.js";
import { TaskManager } from "./task-manager.js";
import type { ProjectContextManager } from "./project-context-manager.js";
import type { TurnBudgetGovernor } from "./session-manager-consumer-types.js";
import type { SessionInfo } from "./session-manager.js";

export interface SessionCostPlumbingDeps {
	projectContextManager: ProjectContextManager | null;
	getTestCostTracker(): CostTracker | null;
	getTestTaskManager(): TaskManager | null;
	getSession(sessionId: string): SessionInfo | undefined;
	getPersistedSession(sessionId: string): PersistedSession | undefined;
	taskIdCache: Map<string, { taskId: string | undefined; gen: number }>;
	getTurnBudgetGovernor(): TurnBudgetGovernor | undefined;
	broadcast(clients: Set<WebSocket>, msg: ServerMessage): void;
}

export class SessionCostPlumbing {
	constructor(private readonly deps: SessionCostPlumbingDeps) {}

	/** Resolve the correct CostTracker for a session based on its project. */
	resolveCostTracker(session: { projectId?: string }): CostTracker {
		if (session.projectId && this.deps.projectContextManager) {
			const ctx = this.deps.projectContextManager.getOrCreate(session.projectId);
			if (ctx) return ctx.costTracker;
		}
		const testCostTracker = this.deps.getTestCostTracker();
		if (testCostTracker) return testCostTracker;
		throw new Error("Cannot resolve cost tracker: session has no projectId");
	}

	/** Get a CostTracker for a specific project. Requires explicit projectId when PCM is active. */
	getCostTracker(projectId?: string): CostTracker {
		if (projectId && this.deps.projectContextManager) {
			const ctx = this.deps.projectContextManager.getOrCreate(projectId);
			if (ctx) return ctx.costTracker;
		}
		const testCostTracker = this.deps.getTestCostTracker();
		if (testCostTracker) return testCostTracker;
		if (this.deps.projectContextManager) {
			throw new Error("Cannot resolve cost tracker: projectId is required");
		}
		throw new Error("No cost tracker available");
	}

	/** Return persisted cumulative cost for a session, without creating a zero-cost record. */
	getSessionCost(sessionId: string): SessionCost | undefined {
		const live = this.deps.getSession(sessionId);
		if (live) {
			try {
				const cost = this.resolveCostTracker(live).getSessionCost(sessionId);
				if (cost) return cost;
			} catch {
				// Fall through to persisted/store scans below.
			}
		}

		const persisted = this.deps.getPersistedSession(sessionId);
		if (persisted?.projectId || !this.deps.projectContextManager) {
			try {
				const cost = this.getCostTracker(persisted?.projectId).getSessionCost(sessionId);
				if (cost) return cost;
			} catch {
				// Fall through to cross-project scan.
			}
		}

		if (this.deps.projectContextManager) {
			for (const ctx of this.deps.projectContextManager.all()) {
				const cost = ctx.costTracker.getSessionCost(sessionId);
				if (cost) return cost;
			}
		}
		return undefined;
	}

	/** Merge authoritative persisted cost into a state snapshot when cost exists. */
	withSessionCostInState(sessionId: string, data: unknown): unknown {
		const cost = this.getSessionCost(sessionId);
		if (!cost) return data;
		if (data && typeof data === "object" && !Array.isArray(data)) {
			return { ...(data as Record<string, unknown>), serverCost: cost };
		}
		return { serverCost: cost };
	}

	/** Build the cumulative cost_update payload used for attach/reconnect hydration. */
	getSessionCostUpdate(sessionId: string): Extract<ServerMessage, { type: "cost_update" }> | null {
		const cost = this.getSessionCost(sessionId);
		if (!cost) return null;
		const live = this.deps.getSession(sessionId);
		const persisted = live ? undefined : this.deps.getPersistedSession(sessionId);
		return {
			type: "cost_update",
			sessionId,
			goalId: live?.goalId ?? persisted?.goalId,
			taskId: this.resolveTaskIdForSession(sessionId),
			cost,
		};
	}

	/** Broadcast cumulative persisted cost to connected clients, if this session has cost data. */
	broadcastSessionCost(session: SessionInfo): void {
		const update = this.getSessionCostUpdate(session.id);
		if (update) this.deps.broadcast(session.clients, update);
	}

	/**
	 * Resolve the taskId (if any) assigned to a session.
	 *
	 * Fast path: `session.taskId` / `persisted.taskId` are stamped once at
	 * session creation (`createSession` opts.taskId) for the normal
	 * task-driven spawn flow - cheap, no scan needed.
	 *
	 * Slow path (PERF-05): sessions with neither (ad hoc / legacy / not
	 * spawned for a task) fall back to scanning every project's TaskStore
	 * for a task whose `assignedSessionId` matches. That fallback is cached
	 * per session, keyed by `ProjectContextManager.getTaskGeneration()`.
	 */
	resolveTaskIdForSession(sessionId: string): string | undefined {
		const live = this.deps.getSession(sessionId);
		if (live?.taskId) return live.taskId;
		const persisted = this.deps.getPersistedSession(sessionId);
		if (persisted?.taskId) return persisted.taskId;
		if (this.deps.projectContextManager) {
			const gen = this.deps.projectContextManager.getTaskGeneration();
			const cached = this.deps.taskIdCache.get(sessionId);
			if (cached && cached.gen === gen) return cached.taskId;

			let taskId: string | undefined;
			for (const ctx of this.deps.projectContextManager.all()) {
				const tm = new TaskManager(ctx.taskStore);
				const tasks = tm.getTasksForSession(sessionId);
				if (tasks.length > 0) { taskId = tasks[0].id; break; }
			}
			this.deps.taskIdCache.set(sessionId, { taskId, gen });
			return taskId;
		}
		const tasks = this.deps.getTestTaskManager()?.getTasksForSession(sessionId) ?? [];
		return tasks.length > 0 ? tasks[0].id : undefined;
	}

	/**
	 * Check an event for usage data and record it via the cost tracker.
	 * Broadcasts a cost_update to connected clients if cost data is found.
	 */
	trackCostFromEvent(session: SessionInfo, event: any): void {
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

		const sessionCostTracker = this.resolveCostTracker(session);
		const stampGoalId = session.goalId ?? session.teamGoalId;
		const trigger = this.costTriggerFromEvent(session, event);
		const cumulativeCost = sessionCostTracker.recordUsage(session.id, {
			inputTokens: usage.inputTokens ?? usage.input,
			outputTokens: usage.outputTokens ?? usage.output,
			cacheReadTokens: usage.cacheReadTokens ?? usage.cacheRead,
			cacheWriteTokens: usage.cacheWriteTokens ?? usage.cacheWrite,
			// pi-ai's Anthropic provider sets `cacheWrite1h` from
			// `cache_creation.ephemeral_1h_input_tokens` (verified in
			// node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js:352).
			// No `cacheWrite5m`-equivalent field exists on the wire - see
			// cost-tracker.ts's `cacheWrite1hTokens` doc.
			cacheWrite1hTokens: usage.cacheWrite1hTokens ?? usage.cacheWrite1h,
			cost: costValue,
		}, stampGoalId, trigger);

		// SWARM-W1 - hard per-node token-budget governor (design/swarm-orchestration.md
		// section 6, must-fix #1): this `message_end` hook is the ONE place cumulative
		// turn usage becomes known, so it's the enforcement point for a HARD
		// per-node ceiling - not just a spawn-boundary "pause and ask".
		if (stampGoalId) {
			const totalTokens = (cumulativeCost.inputTokens ?? 0) + (cumulativeCost.outputTokens ?? 0);
			const governor = this.deps.getTurnBudgetGovernor();
			const action = governor?.check(stampGoalId, totalTokens);
			if (action?.kind === "abort-turn") {
				console.warn(`[swarm-governor] aborting in-flight turn for goal ${stampGoalId}: ${action.reason}`);
				try {
					session.rpcClient.abort();
				} catch (err) {
					console.warn(`[swarm-governor] abort() failed for session ${session.id} (non-fatal):`, err);
				}
			} else if (action?.kind === "hard-kill") {
				governor?.hardKill(stampGoalId, action.reason)
					.catch((err) => console.warn(`[swarm-governor] hardKillSwarmNode failed for goal ${stampGoalId} (non-fatal):`, err));
			}
		}

		// PERF-05: the shared, cached resolver keeps live and reconnect
		// cost_update frames aligned without re-scanning tasks every message.
		const taskId = this.resolveTaskIdForSession(session.id);

		this.deps.broadcast(session.clients, {
			type: "cost_update",
			sessionId: session.id,
			goalId: session.goalId,
			taskId,
			cost: cumulativeCost,
		});
	}

	costTriggerFromEvent(session: SessionInfo, event: any): string | undefined {
		if (event.type !== "message_end") return undefined;
		if (!session.isCompacting) return undefined;
		const pending = (session as any)._pendingCompactionStart as
			| { trigger?: "auto" | "overflow" }
			| undefined;
		const trigger = pending?.trigger ?? ((session as any)._manualCompactionId ? "manual" : undefined);
		return trigger ? `compaction:${trigger}` : undefined;
	}
}
