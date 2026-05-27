// Test entry — bundles `needsHumanAttention` plus `state` so a file://
// fixture can seed sessions/goals/gateStatusCache and exercise the policy
// without a running gateway.

import { needsHumanAttention, needsImmediateHumanAttention } from "../../src/app/notification-policy.js";
import { state, type GatewaySession, type Goal } from "../../src/app/state.js";

(window as any).__state = state;
(window as any).__needsHumanAttention = needsHumanAttention;
(window as any).__needsImmediateHumanAttention = needsImmediateHumanAttention;

interface SeedOpts {
	sessions: Array<Partial<GatewaySession> & Pick<GatewaySession, "id">>;
	goals?: Array<Partial<Goal> & Pick<Goal, "id" | "state">>;
	gateStatusCache?: Array<{ goalId: string; verifying?: boolean; awaitingHumanSignoff?: boolean; awaitingSignoffCount?: number }>;
}

(window as any).__seed = (opts: SeedOpts): void => {
	state.gatewaySessions.length = 0;
	for (const s of opts.sessions) {
		const sess: GatewaySession = {
			id: s.id,
			title: s.title ?? `session ${s.id}`,
			cwd: s.cwd ?? "/tmp",
			status: s.status ?? "idle",
			createdAt: s.createdAt ?? 0,
			lastActivity: s.lastActivity ?? 0,
			lastReadAt: s.lastReadAt,
			clientCount: s.clientCount ?? 1,
			isCompacting: s.isCompacting,
			goalId: s.goalId,
			role: s.role,
			delegateOf: s.delegateOf,
			teamGoalId: s.teamGoalId,
			teamLeadSessionId: s.teamLeadSessionId,
			lastTurnErrored: s.lastTurnErrored,
			consecutiveErrorTurns: s.consecutiveErrorTurns,
		};
		state.gatewaySessions.push(sess);
	}
	state.goals.length = 0;
	for (const g of opts.goals ?? []) {
		const goal: Goal = {
			id: g.id,
			title: g.title ?? `goal ${g.id}`,
			cwd: g.cwd ?? "/tmp",
			state: g.state,
			spec: g.spec ?? "",
			createdAt: g.createdAt ?? 0,
			updatedAt: g.updatedAt ?? 0,
		};
		state.goals.push(goal);
	}
	state.gateStatusCache.clear();
	for (const g of opts.gateStatusCache ?? []) {
		const verifying = !!g.verifying;
		const awaitingSignoffCount = g.awaitingSignoffCount ?? (g.awaitingHumanSignoff ? 1 : 0);
		const awaitingHumanSignoff = awaitingSignoffCount > 0;
		state.gateStatusCache.set(g.goalId, {
			passed: 0,
			total: 0,
			verifying,
			verifyingCount: verifying ? 1 : 0,
			awaitingSignoffCount,
			awaitingHumanSignoff,
		});
	}
};

// Convenience: run the policy against a seeded session by id.
// Returns the OR of both predicates, mirroring how the call sites (api.ts,
// remote-agent.ts) consume them. Use `__checkSplit` for finer-grained
// assertions about which rule fired.
(window as any).__check = (sessionId: string): boolean => {
	const session = state.gatewaySessions.find(s => s.id === sessionId);
	if (!session) throw new Error(`session ${sessionId} not seeded`);
	const goalId = session.teamGoalId || session.goalId;
	const goal = goalId ? state.goals.find(g => g.id === goalId) : undefined;
	return needsHumanAttention(session, goal, state.gatewaySessions, state.gateStatusCache)
		|| needsImmediateHumanAttention(session, state.gateStatusCache);
};

// Returns { filterable, immediate } so tests can assert which predicate
// caught the case — verifies the read-filter split.
(window as any).__checkSplit = (sessionId: string): { filterable: boolean; immediate: boolean } => {
	const session = state.gatewaySessions.find(s => s.id === sessionId);
	if (!session) throw new Error(`session ${sessionId} not seeded`);
	const goalId = session.teamGoalId || session.goalId;
	const goal = goalId ? state.goals.find(g => g.id === goalId) : undefined;
	return {
		filterable: needsHumanAttention(session, goal, state.gatewaySessions, state.gateStatusCache),
		immediate: needsImmediateHumanAttention(session, state.gateStatusCache),
	};
};

(window as any).__ready = true;
