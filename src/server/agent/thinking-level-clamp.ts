import { clampThinkingLevel, type ModelLike, type ThinkingLevel } from "../../shared/thinking-levels.js";
import { resolveModelStateMeta } from "./model-registry.js";

type ExactThinkingMetadata = Pick<ModelLike, "reasoning" | "thinkingLevelMap"> & {
	/** Legacy resolver results are rejected while the registry transition lands. */
	source?: string;
	available?: boolean;
};

export type ExactThinkingMetadataLookup = (
	provider: string | undefined,
	modelId: string,
) => ExactThinkingMetadata | undefined;

export interface ThinkingClampOptions {
	allowEmpty?: boolean;
	/** Test seam or target-realm exact registry lookup. */
	metadataLookup?: ExactThinkingMetadataLookup;
}

export type ThinkingClampModel = ModelLike & { metadataSource: "exact-registry" };

function normalizeProvider(provider: string | undefined): string | undefined {
	const trimmed = provider?.trim().toLowerCase();
	return trimmed || undefined;
}

function lookupExactRegistryMetadata(
	provider: string | undefined,
	modelId: string,
): ExactThinkingMetadata | undefined {
	const resolved = resolveModelStateMeta(provider, modelId) as ExactThinkingMetadata | undefined;
	if (!resolved || resolved.available === false) return undefined;
	// Reject the old resolver's inferred tier as well as the new explicit
	// unavailable result. This keeps the clamp exact across a rolling merge.
	if (resolved.source === "inferred" || resolved.source === "unavailable") return undefined;
	if (typeof resolved.reasoning !== "boolean" && resolved.thinkingLevelMap === undefined) return undefined;
	return resolved;
}

export function resolveThinkingClampModel(
	provider: string | undefined,
	modelId: string,
	opts?: Pick<ThinkingClampOptions, "metadataLookup">,
): ThinkingClampModel | undefined {
	const normalizedProvider = normalizeProvider(provider);
	const metadata = (opts?.metadataLookup ?? lookupExactRegistryMetadata)(normalizedProvider, modelId);
	if (!metadata || metadata.available === false) return undefined;
	if (metadata.source === "inferred" || metadata.source === "unavailable") return undefined;
	if (typeof metadata.reasoning !== "boolean" && metadata.thinkingLevelMap === undefined) return undefined;
	return {
		id: modelId,
		provider: normalizedProvider,
		...(typeof metadata.reasoning === "boolean" ? { reasoning: metadata.reasoning } : {}),
		...(metadata.thinkingLevelMap !== undefined ? { thinkingLevelMap: metadata.thinkingLevelMap } : {}),
		metadataSource: "exact-registry",
	};
}

/** Clamp only when exact registry or target-realm composed metadata is available. */
export function clampThinkingLevelForModel(
	level: string | undefined | null,
	provider: string | undefined,
	modelId: string,
	opts?: ThinkingClampOptions,
): ThinkingLevel | undefined {
	const model = resolveThinkingClampModel(provider, modelId, opts);
	if (!model) return undefined;
	return clampThinkingLevel(level, model, { allowEmpty: opts?.allowEmpty });
}
