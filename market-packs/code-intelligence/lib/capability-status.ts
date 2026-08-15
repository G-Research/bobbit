import {
	languageForId,
	type LspAction,
	type SandboxLayerRequirement,
	type ToolchainRequirement,
} from "./language-matrix.ts";
import type { LanguageDetection } from "./language-detection.ts";

export type CapabilityRuntime = "host" | "sandbox";
export type LspCapabilityState = "disabled" | "requires-toolchain" | "ready" | "unavailable" | "unsupported";

/** Exact EP-8 instance identity. The pack only compares this read-only data. */
export interface LspServiceInstanceKey {
	projectId: string;
	component: string;
	worktreePath: string;
	languageId: string;
}

/** Read-only platform service state; this adapter never creates or updates it. */
export interface LspServiceReadinessSnapshot {
	key: LspServiceInstanceKey;
	state: "ready" | "starting" | "failed" | "stopped";
	serverId: string;
	serverVersion: string;
	/** Platform-owned evaluation of the matrix server version constraint. */
	versionCompatible: boolean;
}

/**
 * A platform-owned probe fact for one named runtime prerequisite. The pack
 * never probes an executable or evaluates a version range itself.
 */
export interface ToolchainProbeFact {
	/** Must exactly match the matrix requirement ID; aliases are not accepted. */
	id: string;
	/** Platform-reported version evidence, required for a constrained requirement. */
	reportedVersion?: string;
	/** Platform-owned compatibility evaluation for this exact requirement. */
	compatible: boolean;
}

export interface CapabilityStatusOptions {
	/** Explicit language enablement from the future platform settings contract. */
	enabledLanguageIds: readonly string[];
	/** Host and sandbox capability are never inferred from one another. */
	runtime: CapabilityRuntime;
	/**
	 * Bounded, platform-owned probe facts keyed by their runtime. This adapter
	 * performs no probing; missing, unversioned constrained, or incompatible
	 * facts honestly require the named toolchain.
	 */
	toolchainProbeFacts?: Readonly<Partial<Record<CapabilityRuntime, readonly ToolchainProbeFact[]>>>;
	/**
	 * The instance this status surface is about. A ready result requires this
	 * exact key and a matching, compatible platform-owned readiness snapshot.
	 */
	serviceKey?: LspServiceInstanceKey;
	serviceSnapshot?: LspServiceReadinessSnapshot;
}

export interface LspCapabilityStatus {
	state: LspCapabilityState;
	actions: readonly LspAction[];
	requirements: readonly ToolchainRequirement[] | readonly SandboxLayerRequirement[];
	missing: readonly ToolchainRequirement[] | readonly SandboxLayerRequirement[];
	reason?: string;
}

export interface LanguageCapabilityStatus {
	component: string;
	languageId: string;
	structuralSearch: "available" | "unsupported";
	lsp: LspCapabilityStatus;
}

/**
 * Purely derives the honest offer/status wording from matrix data and supplied
 * settings/probe facts. It cannot launch a server, inspect PATH, or mutate
 * project state.
 */
export function deriveLanguageCapabilityStatus(
	detection: LanguageDetection,
	options: CapabilityStatusOptions,
): LanguageCapabilityStatus {
	const language = languageForId(detection.languageId);
	if (!language?.lsp) {
		return {
			component: detection.component,
			languageId: detection.languageId,
			structuralSearch: detection.structuralSearch,
			lsp: {
				state: "unsupported",
				actions: [],
				requirements: [],
				missing: [],
				reason: `${language?.label ?? detection.languageId} declares structural search only; no LSP server is available.`,
			},
		};
	}

	const requirements = options.runtime === "host" ? language.lsp.host : language.lsp.sandbox;
	const enabled = new Set(options.enabledLanguageIds.map(normalizeLanguageId)).has(language.id);
	if (!enabled) {
		return {
			component: detection.component,
			languageId: language.id,
			structuralSearch: detection.structuralSearch,
			lsp: {
				state: "disabled",
				actions: language.lsp.actions,
				requirements,
				missing: [],
				reason: `${language.label} LSP is disabled. Enable it explicitly before starting ${language.lsp.server.id}.`,
			},
		};
	}

	// A matrix declaration with no requirements has no evidence that the named
	// service can run in this runtime. Never turn an empty declaration plus a
	// readiness snapshot into a false ready result.
	if (requirements.length === 0) {
		return unavailableStatus(
			detection,
			language.id,
			language.lsp.actions,
			requirements,
			`The ${options.runtime} LSP declaration has no named toolchain requirements; ${language.lsp.server.id} cannot be considered ready.`,
		);
	}

	const probeFailures = requirements.flatMap((requirement) => {
		const probe = options.toolchainProbeFacts?.[options.runtime]?.find((fact) => fact.id === requirement.id);
		const failure = toolchainProbeFailure(requirement, probe);
		return failure ? [failure] : [];
	});
	if (probeFailures.length > 0) {
		return {
			component: detection.component,
			languageId: language.id,
			structuralSearch: detection.structuralSearch,
			lsp: {
				state: "requires-toolchain",
				actions: language.lsp.actions,
				requirements,
				missing: probeFailures.map(({ requirement }) => requirement),
				reason: probeFailures.map(({ reason }) => reason).join(" "),
			},
		};
	}

	const readiness = matchingReadyService(options, detection.component, language.id, language.lsp.server.id);
	if (!readiness.ready) {
		return unavailableStatus(detection, language.id, language.lsp.actions, requirements, readiness.reason);
	}

	return {
		component: detection.component,
		languageId: language.id,
		structuralSearch: detection.structuralSearch,
		lsp: {
			state: "ready",
			actions: language.lsp.actions,
			requirements,
			missing: [],
			reason: `${language.lsp.server.id} is ready for this linked-worktree component.`,
		},
	};
}

export const deriveCapabilityStatus = deriveLanguageCapabilityStatus;

function toolchainProbeFailure(
	requirement: ToolchainRequirement | SandboxLayerRequirement,
	probe: ToolchainProbeFact | undefined,
): { requirement: ToolchainRequirement | SandboxLayerRequirement; reason: string } | undefined {
	if (!probe) {
		return { requirement, reason: requirement.installHint };
	}
	if (requirement.version && (!probe.reportedVersion || !probe.reportedVersion.trim())) {
		return {
			requirement,
			reason: `${requirement.label} has no reported version evidence for ${requirement.version.range}. ${requirement.installHint}`,
		};
	}
	if (!probe.compatible) {
		return {
			requirement,
			reason: requirement.version
				? `${requirement.label} is not compatible with ${requirement.version.range}. ${requirement.installHint}`
				: `${requirement.label} is not compatible with this LSP declaration. ${requirement.installHint}`,
		};
	}
}

function unavailableStatus(
	detection: LanguageDetection,
	languageId: string,
	actions: readonly LspAction[],
	requirements: readonly ToolchainRequirement[] | readonly SandboxLayerRequirement[],
	reason: string,
): LanguageCapabilityStatus {
	return {
		component: detection.component,
		languageId,
		structuralSearch: detection.structuralSearch,
		lsp: { state: "unavailable", actions, requirements, missing: [], reason },
	};
}

function matchingReadyService(
	options: CapabilityStatusOptions,
	component: string,
	languageId: string,
	serverId: string,
): { ready: true } | { ready: false; reason: string } {
	const key = options.serviceKey;
	const snapshot = options.serviceSnapshot;
	if (!key || !snapshot) {
		return { ready: false, reason: "The managed LSP service has no readiness snapshot for this linked-worktree component." };
	}
	if (!validServiceKey(key) || !validServiceKey(snapshot.key)
		|| key.component !== component || normalizeLanguageId(key.languageId) !== languageId
		|| snapshot.key.projectId !== key.projectId || snapshot.key.component !== key.component
		|| snapshot.key.worktreePath !== key.worktreePath || normalizeLanguageId(snapshot.key.languageId) !== languageId) {
		return { ready: false, reason: "The managed LSP service snapshot is not bound to this exact project, component, worktree, and language." };
	}
	if (snapshot.state !== "ready") {
		return { ready: false, reason: unavailableServiceReason(snapshot.state) };
	}
	if (typeof snapshot.serverId !== "string" || typeof snapshot.serverVersion !== "string"
		|| normalizeLanguageId(snapshot.serverId) !== normalizeLanguageId(serverId) || !snapshot.serverVersion.trim() || !snapshot.versionCompatible) {
		return { ready: false, reason: "The managed LSP service is not version-compatible with this language declaration." };
	}
	return { ready: true };
}

function unavailableServiceReason(state: Exclude<LspServiceReadinessSnapshot["state"], "ready">): string {
	switch (state) {
		case "starting": return "The managed LSP service is starting for this linked-worktree component.";
		case "failed": return "The managed LSP service failed for this linked-worktree component.";
		case "stopped": return "The managed LSP service is stopped for this linked-worktree component.";
	}
}

function validServiceKey(key: LspServiceInstanceKey): boolean {
	return typeof key.projectId === "string" && Boolean(key.projectId.trim())
		&& typeof key.component === "string" && Boolean(key.component.trim())
		&& typeof key.worktreePath === "string" && Boolean(key.worktreePath.trim())
		&& typeof key.languageId === "string" && Boolean(key.languageId.trim());
}

function normalizeLanguageId(value: string): string {
	return value.trim().toLowerCase();
}
