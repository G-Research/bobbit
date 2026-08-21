import type { HostInterceptorAuditDecision } from "./host-interceptor-router.js";

/**
 * Best-effort production diagnostic for the router's authoritative final
 * decision. Re-project the existing payload-free contract so an accidental
 * extra property on a caller-owned object can never enter the diagnostic.
 */
export function hostInterceptorAuditSink(decision: HostInterceptorAuditDecision): void {
	try {
		console.log("[host-interceptor-audit] %s", JSON.stringify({
			occurredAt: decision.occurredAt,
			hook: decision.hook,
			...(decision.projectId === undefined ? {} : { projectId: decision.projectId }),
			...(decision.sessionId === undefined ? {} : { sessionId: decision.sessionId }),
			packId: decision.packId,
			contributionId: decision.contributionId,
			durationMs: decision.durationMs,
			outcome: decision.outcome,
			proposalReceived: decision.proposalReceived,
			valid: decision.valid,
			applied: decision.applied,
			timedOut: decision.timedOut,
			cancelled: decision.cancelled,
		} satisfies HostInterceptorAuditDecision));
	} catch {
		// Diagnostics cannot affect interceptor authority or source operations.
	}
}
