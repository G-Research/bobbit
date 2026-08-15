import { languageForId, type SandboxLayerRequirement } from "../lib/language-matrix.ts";
import type { LanguageDetection } from "./language-detection.ts";

export interface SandboxRequirementAttribution {
	languageId: string;
	label: string;
	reason: string;
}

/**
 * A deduplicated generic image-layer declaration. It deliberately has no shell,
 * Dockerfile, mount, build command, or image mutation capability.
 */
export interface DerivedSandboxLayerRequirement extends SandboxLayerRequirement {
	languageIds: readonly string[];
	reasons: readonly SandboxRequirementAttribution[];
}

/**
 * Return the sandbox layers for explicitly enabled, detected LSP languages.
 * Deduplication is exclusively by matrix-declared layerId; attribution remains
 * visible when several languages require the same layer.
 */
export function deriveSandboxRequirements(
	detected: readonly LanguageDetection[],
	enabledLanguageIds: readonly string[],
): readonly DerivedSandboxLayerRequirement[] {
	const enabled = new Set(enabledLanguageIds.map(normalize));
	const layers = new Map<string, {
		requirement: SandboxLayerRequirement;
		attributions: SandboxRequirementAttribution[];
	}>();

	for (const detection of detected) {
		const language = languageForId(detection.languageId);
		if (!language?.lsp || !enabled.has(language.id)) continue;
		for (const requirement of language.lsp.sandbox) {
			const current = layers.get(requirement.layerId) ?? { requirement, attributions: [] };
			current.attributions.push({
				languageId: language.id,
				label: language.label,
				reason: `${language.label} LSP requires ${requirement.label}.`,
			});
			layers.set(requirement.layerId, current);
		}
	}

	return [...layers.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([, { requirement, attributions }]) => {
			const uniqueAttributions = attributions
				.filter((attribution, index, values) => values.findIndex((candidate) => candidate.languageId === attribution.languageId) === index)
				.sort((left, right) => left.languageId.localeCompare(right.languageId));
			return {
				...requirement,
				languageIds: uniqueAttributions.map((attribution) => attribution.languageId),
				reasons: uniqueAttributions,
			};
		});
}

function normalize(value: string): string {
	return value.trim().toLowerCase();
}
