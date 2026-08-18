import {
	isSafeExtensionGrantIdentifier,
	type ExtensionGrant,
	type ExtensionHookRef,
} from "./project-config-store.js";
import { resolveExtensionGrant, type ResolvedHook } from "./extension-grant-policy.js";

export const BUDGET_ENFORCEMENT_DISPOSITIONS = ["allow", "warn", "pause", "halt"] as const;
export type BudgetEnforcementDisposition = typeof BUDGET_ENFORCEMENT_DISPOSITIONS[number];

/** A normalized candidate; source identity is attached by core, not trusted input. */
export interface BudgetEnforcementProposal {
	disposition: BudgetEnforcementDisposition;
	ruleId: string;
	reasonId?: string;
}

/** A worker result paired with its server-derived hook identity by core. */
export interface BudgetEnforcementCandidate {
	source: ExtensionHookRef;
	proposal: unknown;
}

/** Trusted core facts about an operation already at an application choke point. */
export interface BudgetEnforcementRequest {
	sessionId: string;
	projectId?: string;
	goalId?: string;
	consumerId: string;
	operationId: string;
	/** Mandatory: silence cannot become an implicit allow. */
	fallback: BudgetEnforcementDisposition;
	/** A classification tag only; no amount, limit, or pricing input is accepted. */
	hardCapOverride?: "core-hard-cap";
}

/** Secret-free metadata suitable for the existing ContextTraceStore sanitizer. */
export interface BudgetEnforcementAudit {
	hookId?: string;
	disposition: BudgetEnforcementDisposition;
	ruleId?: string;
	reasonId?: string;
	grantDenied: number;
	malformed: number;
}

export interface BudgetEnforcementResult {
	disposition: BudgetEnforcementDisposition;
	/** `halt` and `pause` both deny the current protected operation. */
	permitsOperation: boolean;
	/** EP-11 can consume this later without an EP-11 import today. */
	consent: "not-required" | "hard-cap-override";
	audit: BudgetEnforcementAudit;
}

type AcceptedCandidate = {
	source: ExtensionHookRef;
	proposal: BudgetEnforcementProposal;
	priority: number;
};

const DISPOSITIONS = new Set<string>(BUDGET_ENFORCEMENT_DISPOSITIONS);
const SEVERITY: Readonly<Record<BudgetEnforcementDisposition, number>> = {
	allow: 0,
	warn: 1,
	pause: 2,
	halt: 3,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isDisposition(value: unknown): value is BudgetEnforcementDisposition {
	return typeof value === "string" && DISPOSITIONS.has(value);
}

function isSafeRef(value: unknown): value is ExtensionHookRef {
	return isRecord(value)
		&& isSafeExtensionGrantIdentifier(value.packId)
		&& isSafeExtensionGrantIdentifier(value.hookId);
}

function readProposal(value: unknown): BudgetEnforcementProposal | undefined {
	if (!isRecord(value)
		|| !isDisposition(value.disposition)
		|| !isSafeExtensionGrantIdentifier(value.ruleId)) return undefined;
	if (value.reasonId !== undefined && !isSafeExtensionGrantIdentifier(value.reasonId)) return undefined;
	return {
		disposition: value.disposition,
		ruleId: value.ruleId,
		...(value.reasonId === undefined ? {} : { reasonId: value.reasonId }),
	};
}

function isValidRequest(request: BudgetEnforcementRequest): boolean {
	return isDisposition(request?.fallback)
		&& isSafeExtensionGrantIdentifier(request?.consumerId)
		&& isSafeExtensionGrantIdentifier(request?.operationId)
		&& (request.hardCapOverride === undefined || request.hardCapOverride === "core-hard-cap");
}

function activePriority(activeHooks: readonly ResolvedHook[], source: ExtensionHookRef): number {
	const hook = activeHooks.find(candidate => candidate.packId === source.packId && candidate.hookId === source.hookId);
	if (typeof hook?.priority === "number" && Number.isFinite(hook.priority)) return hook.priority;
	// PackContributionRegistry supplies active packs low→high. Use the final
	// hook position for a pack so every hook in that pack shares its precedence.
	let priority = 0;
	for (let index = 0; index < activeHooks.length; index++) {
		if (activeHooks[index]?.packId === source.packId) priority = index;
	}
	return priority;
}

function lexical(a: string, b: string): number {
	return a === b ? 0 : a < b ? -1 : 1;
}

/** Negative means `a` wins deterministic equal-severity attribution over `b`. */
function compareAttribution(a: AcceptedCandidate, b: AcceptedCandidate): number {
	if (a.priority !== b.priority) return b.priority - a.priority;
	return lexical(a.source.packId, b.source.packId)
		|| lexical(a.source.hookId, b.source.hookId)
		|| lexical(a.proposal.ruleId, b.proposal.ruleId)
		|| (a.proposal.reasonId === undefined ? b.proposal.reasonId === undefined ? 0 : 1
			: b.proposal.reasonId === undefined ? -1 : lexical(a.proposal.reasonId, b.proposal.reasonId));
}

function result(
	disposition: BudgetEnforcementDisposition,
	consent: BudgetEnforcementResult["consent"],
	audit: BudgetEnforcementAudit,
): BudgetEnforcementResult {
	return Object.freeze({
		disposition,
		permitsOperation: disposition === "allow" || disposition === "warn",
		consent,
		audit: Object.freeze({ ...audit }),
	});
}

/**
 * Resolve authorized extension advice at the core application boundary.
 *
 * Callers must read fresh active hooks and grants immediately before invoking
 * this pure reducer, so a grant revoked while a worker was in flight fails
 * closed when its result is applied.
 */
export function resolveBudgetEnforcement(
	request: BudgetEnforcementRequest,
	activeHooks: readonly ResolvedHook[],
	grants: readonly ExtensionGrant[],
	candidates: readonly BudgetEnforcementCandidate[],
): BudgetEnforcementResult {
	const consent = request?.hardCapOverride === "core-hard-cap" ? "hard-cap-override" : "not-required";
	if (!isValidRequest(request)) {
		return result("halt", consent, { disposition: "halt", grantDenied: 0, malformed: 1 });
	}

	let grantDenied = 0;
	let malformed = 0;
	let selected: AcceptedCandidate | undefined;
	for (const candidate of Array.isArray(candidates) ? candidates : []) {
		if (!isRecord(candidate) || !isSafeRef(candidate.source)) {
			malformed++;
			continue;
		}
		const proposal = readProposal(candidate.proposal);
		if (!proposal) {
			malformed++;
			continue;
		}
		if (!resolveExtensionGrant(activeHooks, grants, candidate.source, "decide").allowed) {
			grantDenied++;
			continue;
		}
		const accepted: AcceptedCandidate = {
			source: { packId: candidate.source.packId, hookId: candidate.source.hookId },
			proposal,
			priority: activePriority(activeHooks, candidate.source),
		};
		if (!selected
			|| SEVERITY[accepted.proposal.disposition] > SEVERITY[selected.proposal.disposition]
			|| (SEVERITY[accepted.proposal.disposition] === SEVERITY[selected.proposal.disposition]
				&& compareAttribution(accepted, selected) < 0)) {
			selected = accepted;
		}
	}

	if (!selected) {
		return result(request.fallback, consent, {
			disposition: request.fallback,
			grantDenied,
			malformed,
		});
	}
	return result(selected.proposal.disposition, consent, {
		hookId: selected.source.hookId,
		disposition: selected.proposal.disposition,
		ruleId: selected.proposal.ruleId,
		...(selected.proposal.reasonId === undefined ? {} : { reasonId: selected.proposal.reasonId }),
		grantDenied,
		malformed,
	});
}
