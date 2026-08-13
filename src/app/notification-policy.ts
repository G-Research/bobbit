/**
 * Client compatibility surface for the DOM-free canonical unread policy.
 *
 * Keep application imports pointed here. The implementation lives in shared
 * code so session-list projection and client notification/unread treatment can
 * consume the same rules without importing browser state into the server.
 */
export {
	hasLiveDownstreamWork,
	isSessionUnread,
	needsHumanAttention,
	needsHumanAttentionOnIdleTransition,
	needsImmediateHumanAttention,
} from "../shared/session-unread-policy.js";
export type {
	UnreadPolicyGateStatus,
	UnreadPolicyGoal,
	UnreadPolicySession,
	SessionUnreadContext,
} from "../shared/session-unread-policy.js";
