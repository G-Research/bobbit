import {
	isCanonicalExtensionGrantTimestamp,
	isExtensionCapability,
	isSafeExtensionGrantIdentifier,
	type ExtensionCapability,
	type ExtensionGrant,
	type ExtensionHookRef,
	type ProjectConfigStore,
} from "./project-config-store.js";
import type { PackContributionResolver } from "../extension-host/pack-contribution-registry.js";

/** Active hook metadata assembled exclusively from PackContributionRegistry rows. */
export interface ResolvedHook extends ExtensionHookRef {
	mode: "observe" | "decide";
	/** Schema-2 declared capabilities. `mutate` is intentionally unsupported. */
	capabilities: readonly ExtensionCapability[];
}

/** A server-derived extension principal. Clients must never manufacture this value. */
export type ExtensionGrantPrincipal =
	| { kind: "hook"; packId: string; hookId: string }
	| { kind: "pack"; packId: string };

export type ExtensionGrantDeniedReason =
	| "invalid_request"
	| "project_unavailable"
	| "inactive_principal"
	| "unsupported_capability"
	| "grant_required";

/** The live authorization result returned by the public extension-grant resolver. */
export type ExtensionGrantDecision =
	| { allowed: true; grant: ExtensionGrant }
	| { allowed: false; reason: ExtensionGrantDeniedReason };

/**
 * Project-scoped capability resolver. Every invocation reads the current durable
 * grant state, so callers must retain this function rather than an allow result.
 */
export type ExtensionCapabilityGrantResolver = (
	projectId: string,
	principal: ExtensionGrantPrincipal,
	capability: ExtensionCapability,
) => ExtensionGrantDecision;

/** The compatible hook-only decision surface retained for existing callers. */
export type GrantDecision =
	| { allowed: true; grant: ExtensionGrant }
	| { allowed: false; reason: "grant_required" | "inactive_hook" | "invalid_request" };

const PACK_ONLY_CAPABILITIES: ReadonlySet<string> = new Set([
	"service.manage",
	"memory.read",
	"memory.write",
	"memory.reflect",
	"memory.invalidate",
	"memory.read.all",
]);

type LegacyHookGrant = ExtensionGrant & ExtensionHookRef & { principal?: undefined };
type PackGrant = ExtensionGrant & { principal: "pack"; packId: string; capability: ExtensionCapability; grantedAt: string; grantedBy: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isValidRef(ref: unknown): ref is ExtensionHookRef {
	return isRecord(ref)
		&& isSafeExtensionGrantIdentifier(ref.packId)
		&& isSafeExtensionGrantIdentifier(ref.hookId);
}

function isValidPrincipal(principal: unknown): principal is ExtensionGrantPrincipal {
	if (!isRecord(principal) || !isSafeExtensionGrantIdentifier(principal.packId)) return false;
	return principal.kind === "pack"
		? Object.keys(principal).every(key => key === "kind" || key === "packId")
		: principal.kind === "hook"
			&& isSafeExtensionGrantIdentifier(principal.hookId)
			&& Object.keys(principal).every(key => key === "kind" || key === "packId" || key === "hookId");
}

/** Validate the legacy discriminator-free hook grant shape. */
function isValidHookGrant(grant: unknown): grant is LegacyHookGrant {
	if (!isRecord(grant) || grant.principal !== undefined || !isValidRef(grant)) return false;
	return isExtensionCapability(grant.capability)
		&& isCanonicalExtensionGrantTimestamp(grant.grantedAt)
		&& isSafeExtensionGrantIdentifier(grant.grantedBy);
}

/** Validate the compatible `principal: pack` durable grant shape. */
function isValidPackGrant(grant: unknown): grant is PackGrant {
	if (!isRecord(grant)
		|| grant.principal !== "pack"
		|| Object.hasOwn(grant, "hookId")
		|| !isSafeExtensionGrantIdentifier(grant.packId)) return false;
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

function supportsHookCapability(hook: ResolvedHook, capability: ExtensionCapability): boolean {
	if (PACK_ONLY_CAPABILITIES.has(capability)) return false;
	// No current declaration is eligible for mutate. A future concrete core
	// consumer may extend this explicitly; it must not become default-on here.
	if (capability === "mutate") return false;
	if (capability === "decide") return hook.mode === "decide";
	return hook.capabilities.includes(capability);
}

function isMatchingActivePack(pack: unknown, packId: string): pack is { packId: string; hooks: readonly unknown[] } {
	return isRecord(pack)
		&& pack.packId === packId
		&& Array.isArray(pack.hooks);
}

function resolvedHook(packId: string, hooks: readonly unknown[], hookId: string): ResolvedHook | undefined {
	const candidate = hooks.find(hook => isRecord(hook) && hook.id === hookId);
	if (!isRecord(candidate)) return undefined;
	const hook: ResolvedHook = {
		packId,
		hookId,
		mode: candidate.mode as ResolvedHook["mode"],
		capabilities: candidate.capabilities as ResolvedHook["capabilities"],
	};
	return isValidActiveHook(hook) ? hook : undefined;
}

function cloneGrant(grant: ExtensionGrant): ExtensionGrant {
	return { ...grant };
}

/**
 * Build the sole public, live extension capability resolver. The active pack is
 * server-resolved before grants are read; a valid persisted grant alone can
 * never reactivate an uninstalled, disabled, or shadowed pack.
 */
export function createExtensionCapabilityGrantResolver(deps: {
	contextForProject(projectId: string): { projectConfigStore: Pick<ProjectConfigStore, "getExtensionGrants"> } | undefined;
	contributions: Pick<PackContributionResolver, "getPack">;
}): ExtensionCapabilityGrantResolver {
	return (projectId, principal, capability) => {
		if (!isSafeExtensionGrantIdentifier(projectId) || !isValidPrincipal(principal) || !isExtensionCapability(capability)) {
			return { allowed: false, reason: "invalid_request" };
		}

		let context: { projectConfigStore: Pick<ProjectConfigStore, "getExtensionGrants"> } | undefined;
		try {
			context = deps.contextForProject(projectId);
		} catch {
			return { allowed: false, reason: "project_unavailable" };
		}
		if (!context) return { allowed: false, reason: "project_unavailable" };

		let pack: { packId: string; hooks: readonly unknown[] } | undefined;
		try {
			const resolved = deps.contributions.getPack(projectId, principal.packId);
			pack = isMatchingActivePack(resolved, principal.packId) ? resolved : undefined;
		} catch {
			return { allowed: false, reason: "inactive_principal" };
		}
		if (!pack) return { allowed: false, reason: "inactive_principal" };

		if (principal.kind === "hook") {
			const hook = resolvedHook(principal.packId, pack.hooks, principal.hookId);
			if (!hook) return { allowed: false, reason: "inactive_principal" };
			if (!supportsHookCapability(hook, capability)) return { allowed: false, reason: "unsupported_capability" };
		} else if (!PACK_ONLY_CAPABILITIES.has(capability)) {
			return { allowed: false, reason: "unsupported_capability" };
		}

		let grants: readonly ExtensionGrant[];
		try {
			// This read is deliberately after all eligibility checks and occurs for
			// every use. Revocation therefore wins over stale awaited work.
			grants = context.projectConfigStore.getExtensionGrants();
		} catch {
			return { allowed: false, reason: "project_unavailable" };
		}
		const grant = grants.find(candidate => principal.kind === "hook"
			? isValidHookGrant(candidate)
				&& candidate.packId === principal.packId
				&& candidate.hookId === principal.hookId
				&& candidate.capability === capability
			: isValidPackGrant(candidate)
				&& candidate.packId === principal.packId
				&& candidate.capability === capability,
		);
		return grant ? { allowed: true, grant: cloneGrant(grant) } : { allowed: false, reason: "grant_required" };
	};
}

/**
 * Resolve one exact legacy hook grant against active, server-derived hook
 * declarations. Existing callers retain their historical denial reason names.
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
	if (!supportsHookCapability(hook, capability)) {
		return { allowed: false, reason: "invalid_request" };
	}

	const grant = grants.find(candidate =>
		isValidHookGrant(candidate)
		&& candidate.packId === ref.packId
		&& candidate.hookId === ref.hookId
		&& candidate.capability === capability,
	);
	return grant
		? { allowed: true, grant: cloneGrant(grant) }
		: { allowed: false, reason: "grant_required" };
}
