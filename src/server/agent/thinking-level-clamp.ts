import { getModel } from "@earendil-works/pi-ai";
import { inferMeta } from "./aigw-manager.js";
import { clampThinkingLevel, type ModelLike, type ThinkingLevel } from "../../shared/thinking-levels.js";

type CatalogThinkingMetadata = Pick<ModelLike, "reasoning" | "thinkingLevelMap">;
export type PiCatalogLookup = (provider: string, modelId: string) => CatalogThinkingMetadata | undefined;

export interface ThinkingClampOptions {
	allowEmpty?: boolean;
	catalogLookup?: PiCatalogLookup;
}

export type ThinkingClampMetadataSource = "pi-ai-catalog" | "inferMeta";
export type ThinkingClampModel = ModelLike & { metadataSource: ThinkingClampMetadataSource };

function lookupPiCatalogModel(provider: string, modelId: string): CatalogThinkingMetadata | undefined {
	try {
		return getModel(provider as any, modelId) as CatalogThinkingMetadata | undefined;
	} catch {
		return undefined;
	}
}

function normalizeProvider(provider: string | undefined): string | undefined {
	const trimmed = provider?.trim().toLowerCase();
	return trimmed || undefined;
}

function resolveCatalogMetadata(
	provider: string | undefined,
	modelId: string,
	catalogLookup: PiCatalogLookup = lookupPiCatalogModel,
): CatalogThinkingMetadata | undefined {
	const normalizedProvider = normalizeProvider(provider);
	// AI Gateway and custom/unknown providers often expose sparse or synthetic ids;
	// keep those on Bobbit's inferMeta fallback instead of consulting pi-ai's
	// built-in catalog under the wrong provider namespace.
	if (!normalizedProvider || normalizedProvider === "aigw" || normalizedProvider === "custom") return undefined;
	const catalogModel = catalogLookup(normalizedProvider, modelId);
	if (!catalogModel) return undefined;
	const hasReasoning = typeof catalogModel.reasoning === "boolean";
	const hasThinkingLevelMap = catalogModel.thinkingLevelMap !== undefined;
	if (!hasReasoning && !hasThinkingLevelMap) return undefined;
	return {
		...(hasReasoning ? { reasoning: catalogModel.reasoning } : {}),
		...(hasThinkingLevelMap ? { thinkingLevelMap: catalogModel.thinkingLevelMap } : {}),
	};
}

export function resolveThinkingClampModel(
	provider: string | undefined,
	modelId: string,
	opts?: Pick<ThinkingClampOptions, "catalogLookup">,
): ThinkingClampModel {
	const normalizedProvider = normalizeProvider(provider);
	const catalog = resolveCatalogMetadata(normalizedProvider, modelId, opts?.catalogLookup);
	if (catalog) {
		return {
			id: modelId,
			provider: normalizedProvider,
			reasoning: typeof catalog.reasoning === "boolean" ? catalog.reasoning : inferMeta(modelId).reasoning,
			...(catalog.thinkingLevelMap !== undefined ? { thinkingLevelMap: catalog.thinkingLevelMap } : {}),
			metadataSource: "pi-ai-catalog",
		};
	}

	const meta = inferMeta(modelId);
	return {
		id: modelId,
		provider: normalizedProvider,
		reasoning: meta.reasoning,
		metadataSource: "inferMeta",
	};
}

/** Clamp a thinking level against pi-ai catalog metadata, falling back to Bobbit's inferred metadata. */
export function clampThinkingLevelForModel(
	level: string | undefined | null,
	provider: string | undefined,
	modelId: string,
	opts?: ThinkingClampOptions,
): ThinkingLevel | undefined {
	return clampThinkingLevel(level, resolveThinkingClampModel(provider, modelId, opts), { allowEmpty: opts?.allowEmpty });
}
