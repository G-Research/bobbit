import {
	isCanonicalExtensionGrantTimestamp,
	isExtensionCapability,
	isSafeExtensionGrantIdentifier,
	type ExtensionCapability,
	type ExtensionGrant,
	type ExtensionHookRef,
} from "./project-config-store.js";

/** Active hook metadata assembled exclusively from PackContributionRegistry rows. */
export interface ResolvedHook extends ExtensionHookRef {
	mode: "observe" | "decide";
	/** Schema-2 declared capabilities. `mutate` is intentionally unsupported. */
	capabilities: readonly ExtensionCapability[];
}

export type GrantDecision =
	| { allowed: true; grant: ExtensionGrant }
	| { allowed: false; reason: "grant_required" | "inactive_hook" | "invalid_request" };

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isValidRef(ref: unknown): ref is ExtensionHookRef {
	return isRecord(ref)
		&& isSafeExtensionGrantIdentifier(ref.packId)
		&& isSafeExtensionGrantIdentifier(ref.hookId);
}

function isValidGrant(grant: unknown): grant is ExtensionGrant {
	if (!isRecord(grant) || !isValidRef(grant)) return false;
	return isExtensionCapability(grant.capability)
		&& isCanonicalExtensionGrantTimestamp(grant.grantedAt)
		&& isSafeExtensionGrantIdentifier(grant.grantedBy);
}

function isValidActiveHook(hook: unknown): hook is ResolvedHook {
	if (!isRecord(hook) || !isValidRef(hook)) return false;
	return (hook.mode === "observe" || hook.mode === "decide")
		&& Array.isArray(hook.capabilities)
		&& hook.capabilities.every(isExtensionCapability);
}

function supportsCapability(hook: ResolvedHook, capability: ExtensionCapability): boolean {
	// No current declaration is eligible for mutate. A future concrete core
	// consumer may extend this explicitly; it must not become default-on here.
	if (capability === "mutate") return false;
	if (capability === "decide") return hook.mode === "decide";
	return hook.capabilities.includes(capability);
}

/**
 * Resolve one exact grant against active, server-derived hook declarations.
 * This is deliberately synchronous and side-effect free: callers read fresh
 * grants from ProjectConfigStore immediately before every use.
 */
export function resolveExtensionGrant(
	activeHooks: readonly ResolvedHook[],
	grants: readonly ExtensionGrant[],
	ref: ExtensionHookRef,
	capability: ExtensionCapability,
): GrantDecision {
	if (!isValidRef(ref) || !isExtensionCapability(capability)) {
		return { allowed: false, reason: "invalid_request" };
	}

	const hook = activeHooks.find(candidate =>
		isValidActiveHook(candidate)
		&& candidate.packId === ref.packId
		&& candidate.hookId === ref.hookId,
	);
	if (!hook) return { allowed: false, reason: "inactive_hook" };
	if (!supportsCapability(hook, capability)) {
		return { allowed: false, reason: "invalid_request" };
	}

	const grant = grants.find(candidate =>
		isValidGrant(candidate)
		&& candidate.packId === ref.packId
		&& candidate.hookId === ref.hookId
		&& candidate.capability === capability,
	);
	return grant
		? { allowed: true, grant: { ...grant } }
		: { allowed: false, reason: "grant_required" };
}
