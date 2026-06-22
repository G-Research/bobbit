import { inferMeta } from "./aigw-manager.js";
import { clampThinkingLevel, type ThinkingLevel } from "../../shared/thinking-levels.js";

/** Clamp a thinking level against Bobbit's inferred metadata for a provider/model pair. */
export function clampThinkingLevelForModel(
	level: string | undefined | null,
	provider: string | undefined,
	modelId: string,
	opts?: { allowEmpty?: boolean },
): ThinkingLevel | undefined {
	const meta = inferMeta(modelId);
	return clampThinkingLevel(level, {
		id: modelId,
		provider,
		reasoning: meta.reasoning,
	}, opts);
}
