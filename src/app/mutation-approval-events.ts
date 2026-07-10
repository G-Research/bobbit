import { state } from "./state.js";

// ============================================================================
// MUTATION-APPROVAL CHAT CARDS — Phase 5b
//
// Server emits `mutation_pending {goalId, requestId, kind, summary}` when a
// post-freeze plan-mutation lands in the approval queue. Client renders an
// inline card in the chat with Approve / Reject buttons. On the WS reply
// `mutation_decided`, we flip the card to a decided state.
// ============================================================================

export function handleMutationPendingEvent(msg: { goalId: string; requestId: string; kind: "fix-up" | "expansion" | "restructure" | "criteria-drop"; summary: string }): void {
	if (!state.remoteAgent) return;
	state.remoteAgent.appendMutationPendingCard({
		goalId: msg.goalId,
		requestId: msg.requestId,
		kind: msg.kind,
		summary: msg.summary,
	});
}

export function handleMutationDecidedEvent(msg: { goalId: string; requestId: string; decision: "approve" | "reject" }): void {
	if (!state.remoteAgent) return;
	state.remoteAgent.markMutationDecided(msg.requestId, msg.decision);
	// Best-effort: refresh the dashboard so the Plan tab reflects the
	// applied/rejected mutation immediately.
	import("./goal-dashboard.js").then(m => m.notifyGoalEventForDashboard?.()).catch(() => {});
}
