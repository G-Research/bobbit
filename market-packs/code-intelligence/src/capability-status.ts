import {
	languageForId,
	type LspAction,
	type SandboxLayerRequirement,
	type ToolchainRequirement,
} from "../lib/language-matrix.ts";
import type { LanguageDetection } from "./language-detection.ts";

export type CapabilityRuntime = "host" | "sandbox";
export type LspCapabilityState = "disabled" | "requires-toolchain" | "ready" | "unsupported";

export interface CapabilityStatusOptions {
	/** Explicit language enablement from the future platform settings contract. */
	enabledLanguageIds: readonly string[];
	/** Host and sandbox capability are never inferred from one another. */
	runtime: CapabilityRuntime;
	/**
	 * Bounded, externally supplied probe results. This adapter performs no probe;
	 * omitted IDs are honestly treated as unavailable.
	 */
	availableToolchainIds?: readonly string[];
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

	const available = new Set((options.availableToolchainIds ?? []).map(normalizeLanguageId));
	const missing = requirements.filter((requirement) => !available.has(normalizeLanguageId(requirement.id)));
	if (missing.length > 0) {
		return {
			component: detection.component,
			languageId: language.id,
			structuralSearch: detection.structuralSearch,
			lsp: {
				state: "requires-toolchain",
				actions: language.lsp.actions,
				requirements,
				missing,
				reason: missing.map((requirement) => requirement.installHint).join(" "),
			},
		};
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
			reason: `${language.lsp.server.id} requirements are available in the selected ${options.runtime} runtime.`,
		},
	};
}

export const deriveCapabilityStatus = deriveLanguageCapabilityStatus;

function normalizeLanguageId(value: string): string {
	return value.trim().toLowerCase();
}
