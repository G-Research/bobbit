import { createHash } from "node:crypto";
import type { TrustedDecisionOperation } from "./decision-request-manager.js";
import type { ValidatedExtensionDecisionRequest } from "./decision-hook-contract.js";
import type { StoredDecisionRequest } from "./decision-request-store.js";

type DecisionEffectCarrier = Pick<ValidatedExtensionDecisionRequest, "effect"> | Pick<StoredDecisionRequest["request"], "effect">;
type ProposalChangeOperation = TrustedDecisionOperation & {
	change: NonNullable<TrustedDecisionOperation["change"]>;
};

/**
 * Core-owned classification for an extension's already-validated proposal
 * effect. Hooks only supply the untrusted proposal; this adapter chooses the
 * protected-operation identity, platform floor, and fail-closed timeout.
 */
export function trustedOperationForExtensionDecision(
	request: DecisionEffectCarrier,
): ProposalChangeOperation | undefined {
	const effect = request.effect;
	if (!effect || effect.kind !== "proposal") return undefined;
	const proposalTypes = Object.values(effect.proposals).map(seed => seed.proposalType);
	const change = proposalTypes.includes("tool")
		? "capability-escalation"
		: proposalTypes.includes("role")
			? "grant-change"
			: proposalTypes.includes("project")
				? "configuration-change"
				: undefined;
	if (!change) return undefined;
	return {
		id: operationId(change, effect),
		kind: "extension-proposal-change",
		change,
		timeoutAction: "deny-operation",
	};
}

/**
 * Rebuild a proposal-change operation from the durable validated request. A
 * changed effect, stale record, or a non-core operation identity is rejected.
 */
export function isCurrentTrustedExtensionDecisionOperation(record: StoredDecisionRequest): boolean {
	const current = trustedOperationForExtensionDecision(record.request);
	if (!current || !record.protectedOperation) return false;
	return record.protectedOperation.id === current.id
		&& record.protectedOperation.kind === current.kind
		&& record.timeoutAction === current.timeoutAction
		&& record.classificationReason === classificationReason(current.change);
}

function operationId(change: NonNullable<TrustedDecisionOperation["change"]>, effect: object): string {
	return `proposal-change:${createHash("sha256").update(canonical({ change, effect })).digest("hex")}`;
}

function classificationReason(change: NonNullable<TrustedDecisionOperation["change"]>): StoredDecisionRequest["classificationReason"] {
	switch (change) {
		case "capability-escalation": return "core-capability-change";
		case "grant-change": return "core-grant-change";
		case "configuration-change": return "core-configuration-change";
	}
}

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
