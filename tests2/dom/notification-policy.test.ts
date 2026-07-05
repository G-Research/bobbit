import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/notification-policy.spec.ts (v2-dom tier).
// The legacy spec bundled a file:// entry that exposed __seed/__check/__checkSplit/
// __checkIdleTransition over the REAL predicates + app state. We import those same
// real functions here and reimplement the (thin) seed/check helpers inline, then
// assert the identical rule-table facts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	needsHumanAttention,
	needsHumanAttentionOnIdleTransition,
	needsImmediateHumanAttention,
} from "../../src/app/notification-policy.js";
import { state, type GatewaySession, type Goal } from "../../src/app/state.js";

interface SeedOpts {
	sessions: Array<Partial<GatewaySession> & Pick<GatewaySession, "id">>;
	goals?: Array<Partial<Goal> & Pick<Goal, "id" | "state">>;
	gateStatusCache?: Array<{ goalId: string; verifying?: boolean; awaitingHumanSignoff?: boolean; awaitingSignoffCount?: number }>;
}

function seed(opts: SeedOpts): void {
	state.gatewaySessions.length = 0;
	for (const s of opts.sessions) {
		state.gatewaySessions.push({
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
		} as GatewaySession);
	}
	state.goals.length = 0;
	for (const g of opts.goals ?? []) {
		state.goals.push({
			id: g.id,
			title: g.title ?? `goal ${g.id}`,
			cwd: g.cwd ?? "/tmp",
			state: g.state,
			spec: g.spec ?? "",
			createdAt: g.createdAt ?? 0,
			updatedAt: g.updatedAt ?? 0,
		} as Goal);
	}
	state.gateStatusCache.clear();
	for (const g of opts.gateStatusCache ?? []) {
		const verifying = !!g.verifying;
		const awaitingSignoffCount = g.awaitingSignoffCount ?? (g.awaitingHumanSignoff ? 1 : 0);
		state.gateStatusCache.set(g.goalId, {
			passed: 0,
			total: 0,
			verifying,
			verifyingCount: verifying ? 1 : 0,
			awaitingSignoffCount,
			awaitingHumanSignoff: awaitingSignoffCount > 0,
		} as any);
	}
}

function resolveGoal(session: GatewaySession): Goal | undefined {
	const goalId = session.teamGoalId || session.goalId;
	return goalId ? state.goals.find(g => g.id === goalId) : undefined;
}
function findSession(sessionId: string): GatewaySession {
	const s = state.gatewaySessions.find(x => x.id === sessionId);
	if (!s) throw new Error(`session ${sessionId} not seeded`);
	return s;
}

function check(sessionId: string): boolean {
	const session = findSession(sessionId);
	return needsHumanAttention(session, resolveGoal(session), state.gatewaySessions, state.gateStatusCache)
		|| needsImmediateHumanAttention(session, state.gateStatusCache);
}
function checkIdleTransition(sessionId: string): boolean {
	const session = findSession(sessionId);
	return needsHumanAttentionOnIdleTransition(session, resolveGoal(session), state.gatewaySessions, state.gateStatusCache)
		|| needsImmediateHumanAttention(session, state.gateStatusCache);
}
function checkSplit(sessionId: string): { filterable: boolean; immediate: boolean } {
	const session = findSession(sessionId);
	return {
		filterable: needsHumanAttention(session, resolveGoal(session), state.gatewaySessions, state.gateStatusCache),
		immediate: needsImmediateHumanAttention(session, state.gateStatusCache),
	};
}

function resetState() {
	state.gatewaySessions.length = 0;
	state.goals.length = 0;
	state.gateStatusCache.clear();
}
// Reset the shared module `state` both before and after (isolate:false keeps it
// alive across files, so leave it clean for the next file too).
beforeEach(resetState);
afterEach(resetState);

describe("notification policy — legacy rule rows (pre-rewrite parity)", () => {
	it("Row 1: standalone idle session → notify", () => {
		seed({ sessions: [{ id: "s1", status: "idle" }] });
		expect(check("s1")).toBe(true);
	});

	it("Row 2: delegate session (delegateOf set) → silent", () => {
		seed({
			sessions: [
				{ id: "parent", status: "idle" },
				{ id: "delegate", status: "idle", delegateOf: "parent" },
			],
		});
		expect(check("delegate")).toBe(false);
	});

	it("Row 3: team member (role=coder, teamLeadSessionId set) → silent", () => {
		seed({
			sessions: [
				{ id: "lead", role: "team-lead", goalId: "g1", status: "idle" },
				{ id: "coder", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "idle" },
			],
			goals: [{ id: "g1", state: "in-progress" }],
		});
		expect(check("coder")).toBe(false);
	});

	it("Row 4: team member (role=reviewer in team goal) → silent", () => {
		seed({
			sessions: [
				{ id: "lead", role: "team-lead", goalId: "g1", status: "idle" },
				{ id: "rev", role: "reviewer", teamGoalId: "g1", status: "idle" },
			],
			goals: [{ id: "g1", state: "in-progress" }],
		});
		expect(check("rev")).toBe(false);
	});

	it("Row 5: team lead idle mid-goal, sibling coder streaming → silent", () => {
		seed({
			sessions: [
				{ id: "lead", role: "team-lead", goalId: "g1", status: "idle" },
				{ id: "coder", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "streaming" },
			],
			goals: [{ id: "g1", state: "in-progress" }],
		});
		expect(check("lead")).toBe(false);
	});

	it("Row 6: team lead idle mid-goal, all members idle, no verification → notify (stuck)", () => {
		seed({
			sessions: [
				{ id: "lead", role: "team-lead", goalId: "g1", status: "idle" },
				{ id: "coder", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "idle" },
			],
			goals: [{ id: "g1", state: "in-progress" }],
		});
		expect(check("lead")).toBe(true);
	});

	it("Row 7: team lead idle mid-goal, verification running → silent", () => {
		seed({
			sessions: [
				{ id: "lead", role: "team-lead", goalId: "g1", status: "idle" },
				{ id: "coder", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "idle" },
			],
			goals: [{ id: "g1", state: "in-progress" }],
			gateStatusCache: [{ goalId: "g1", verifying: true }],
		});
		expect(check("lead")).toBe(false);
	});

	it("Row 8: team lead idle, goal complete → notify", () => {
		seed({
			sessions: [{ id: "lead", role: "team-lead", goalId: "g1", status: "idle" }],
			goals: [{ id: "g1", state: "complete" }],
		});
		expect(check("lead")).toBe(true);
	});

	it("Row 9: team lead idle, goal complete, sibling member still streaming → notify (goal-complete wins)", () => {
		seed({
			sessions: [
				{ id: "lead", role: "team-lead", goalId: "g1", status: "idle" },
				{ id: "coder", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "streaming" },
			],
			goals: [{ id: "g1", state: "complete" }],
		});
		expect(check("lead")).toBe(true);
	});

	it("Bonus: team member compacting counts as live downstream work", () => {
		seed({
			sessions: [
				{ id: "lead", role: "team-lead", goalId: "g1", status: "idle" },
				{ id: "coder", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "idle", isCompacting: true },
			],
			goals: [{ id: "g1", state: "in-progress" }],
		});
		expect(check("lead")).toBe(false);
	});
});

describe("notification policy — four-rule team-lead disjunction (post-rewrite)", () => {
	it("Rule 1: goal complete fires via the read-filterable predicate", () => {
		seed({
			sessions: [{ id: "lead", role: "team-lead", goalId: "g1", status: "idle" }],
			goals: [{ id: "g1", state: "complete" }],
		});
		expect(checkSplit("lead")).toEqual({ filterable: true, immediate: false });
	});

	it("Rule 2: pending sign-off fires via the immediate predicate (bypasses read filter)", () => {
		seed({
			sessions: [{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: Date.now(), lastReadAt: Date.now() }],
			goals: [{ id: "g1", state: "in-progress" }],
			gateStatusCache: [{ goalId: "g1", awaitingHumanSignoff: true }],
		});
		expect(checkSplit("lead").immediate).toBe(true);
	});

	it("Rule 2: pending sign-off ignored when session is a delegate (escalation invariant)", () => {
		seed({
			sessions: [
				{ id: "parent", role: "team-lead", goalId: "g1", status: "idle" },
				{ id: "del", goalId: "g1", status: "idle", delegateOf: "parent" },
			],
			goals: [{ id: "g1", state: "in-progress" }],
			gateStatusCache: [{ goalId: "g1", awaitingHumanSignoff: true }],
		});
		expect(check("del")).toBe(false);
	});

	it("Rule 2: pending sign-off ignored when session is a team member (escalation invariant)", () => {
		seed({
			sessions: [
				{ id: "lead", role: "team-lead", goalId: "g1", status: "idle" },
				{ id: "coder", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "idle" },
			],
			goals: [{ id: "g1", state: "in-progress" }],
			gateStatusCache: [{ goalId: "g1", awaitingHumanSignoff: true }],
		});
		expect(check("coder")).toBe(false);
	});

	it("Rule 3: 3 consecutive errored turns + lastTurnErrored fires via the immediate predicate", () => {
		seed({
			sessions: [{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastTurnErrored: true, consecutiveErrorTurns: 3 }],
			goals: [{ id: "g1", state: "in-progress" }],
		});
		expect(checkSplit("lead").immediate).toBe(true);
	});

	it("Rule 3: 2 consecutive errored turns is below the threshold → silent", () => {
		seed({
			sessions: [
				{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: Date.now(), lastTurnErrored: true, consecutiveErrorTurns: 2 },
				{ id: "coder", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "streaming" },
			],
			goals: [{ id: "g1", state: "in-progress" }],
		});
		expect(checkSplit("lead")).toEqual({ filterable: false, immediate: false });
	});

	it("Rule 3: lastTurnErrored=false with high count → silent (must be currently errored)", () => {
		seed({
			sessions: [
				{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: Date.now(), lastTurnErrored: false, consecutiveErrorTurns: 5 },
				{ id: "coder", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "streaming" },
			],
			goals: [{ id: "g1", state: "in-progress" }],
		});
		expect(checkSplit("lead").immediate).toBe(false);
	});

	it("Rule 3: also applies to standalone (non-lead) sessions", () => {
		seed({ sessions: [{ id: "s1", status: "idle", lastTurnErrored: true, consecutiveErrorTurns: 4 }] });
		expect(checkSplit("s1").immediate).toBe(true);
	});

	it("Rule 4: idle for <10s with no live siblings → silent (debounce kicks in)", () => {
		seed({
			sessions: [{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: Date.now() - 5_000 }],
			goals: [{ id: "g1", state: "in-progress" }],
		});
		expect(checkSplit("lead")).toEqual({ filterable: false, immediate: false });
	});

	it("Rule 4: idle for >10s with no live siblings → persistent unread notify", () => {
		seed({
			sessions: [{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: Date.now() - 11_000 }],
			goals: [{ id: "g1", state: "in-progress" }],
		});
		expect(checkSplit("lead").filterable).toBe(true);
	});

	it("Idle transition: team lead stuck rule does not beep just because the lead went idle", () => {
		seed({
			sessions: [{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: Date.now() - 60_000 }],
			goals: [{ id: "g1", state: "in-progress" }],
		});
		expect({ persistent: check("lead"), transition: checkIdleTransition("lead") }).toEqual({ persistent: true, transition: false });
	});

	it("Idle transition: goal complete still notifies", () => {
		seed({
			sessions: [{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: Date.now() - 60_000 }],
			goals: [{ id: "g1", state: "complete" }],
		});
		expect(checkIdleTransition("lead")).toBe(true);
	});

	it("Idle transition: pending sign-off still notifies immediately", () => {
		seed({
			sessions: [{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: Date.now() - 60_000 }],
			goals: [{ id: "g1", state: "in-progress" }],
			gateStatusCache: [{ goalId: "g1", awaitingHumanSignoff: true }],
		});
		expect(checkIdleTransition("lead")).toBe(true);
	});

	it("Rule 4 suppressor — live sibling: lead idle >10s but sibling streaming → silent", () => {
		seed({
			sessions: [
				{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: Date.now() - 60_000 },
				{ id: "coder", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "streaming" },
			],
			goals: [{ id: "g1", state: "in-progress" }],
		});
		expect(checkSplit("lead")).toEqual({ filterable: false, immediate: false });
	});

	it("Rule 4 suppressor — sibling compacting: lead idle >10s but sibling compacting → silent", () => {
		seed({
			sessions: [
				{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: Date.now() - 60_000 },
				{ id: "coder", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "idle", isCompacting: true },
			],
			goals: [{ id: "g1", state: "in-progress" }],
		});
		expect(checkSplit("lead")).toEqual({ filterable: false, immediate: false });
	});

	it("Rule 4 suppressor — verification running: lead idle >10s but cache.verifying → silent", () => {
		seed({
			sessions: [{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: Date.now() - 60_000 }],
			goals: [{ id: "g1", state: "in-progress" }],
			gateStatusCache: [{ goalId: "g1", verifying: true }],
		});
		expect(checkSplit("lead").filterable).toBe(false);
	});

	it("Rule 4 suppressor — pending sign-off: lead idle >10s but cache.awaitingHumanSignoff → filterable false (immediate fires instead)", () => {
		seed({
			sessions: [{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: Date.now() - 60_000 }],
			goals: [{ id: "g1", state: "in-progress" }],
			gateStatusCache: [{ goalId: "g1", awaitingHumanSignoff: true }],
		});
		const result = checkSplit("lead");
		expect(result.filterable).toBe(false);
		expect(result.immediate).toBe(true);
	});

	it("Rule 4 suppressor — lead itself live: lead status=streaming → silent (filterable false)", () => {
		seed({
			sessions: [{ id: "lead", role: "team-lead", goalId: "g1", status: "streaming", lastActivity: Date.now() - 60_000 }],
			goals: [{ id: "g1", state: "in-progress" }],
		});
		expect(checkSplit("lead").filterable).toBe(false);
	});

	it("Rule 4 suppressor — lead compacting: lead.isCompacting → silent", () => {
		seed({
			sessions: [{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", isCompacting: true, lastActivity: Date.now() - 60_000 }],
			goals: [{ id: "g1", state: "in-progress" }],
		});
		expect(checkSplit("lead").filterable).toBe(false);
	});

	it("Spawn handoff: old sibling terminated, new sibling streaming within 500ms → predicate stays false throughout", () => {
		const leadActiveAt = Date.now() - 2_000;
		seed({
			sessions: [
				{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: leadActiveAt },
				{ id: "del-old", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "streaming" },
			],
			goals: [{ id: "g1", state: "in-progress" }],
		});
		const r0 = checkSplit("lead");

		seed({
			sessions: [
				{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: leadActiveAt },
				{ id: "del-old", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "terminated" },
			],
			goals: [{ id: "g1", state: "in-progress" }],
		});
		const r1 = checkSplit("lead");

		seed({
			sessions: [
				{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: leadActiveAt },
				{ id: "del-old", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "terminated" },
				{ id: "del-new", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "streaming" },
			],
			goals: [{ id: "g1", state: "in-progress" }],
		});
		const r2 = checkSplit("lead");

		expect(r0).toEqual({ filterable: false, immediate: false });
		expect(r1).toEqual({ filterable: false, immediate: false });
		expect(r2).toEqual({ filterable: false, immediate: false });
	});

	it("Rule 1 + 2 combined: goal complete with pending sign-off → both predicates fire", () => {
		seed({
			sessions: [{ id: "lead", role: "team-lead", goalId: "g1", status: "idle" }],
			goals: [{ id: "g1", state: "complete" }],
			gateStatusCache: [{ goalId: "g1", awaitingHumanSignoff: true }],
		});
		const result = checkSplit("lead");
		expect(result.filterable).toBe(true);
		expect(result.immediate).toBe(true);
	});
});
