import type { ApiModel } from "./model-registry.js";

/** Fresh input must reach this total before a missing cache read is actionable. */
export const CACHE_STALL_INPUT_THRESHOLD = 50_000;

export interface CacheStallWarning {
	at: number;
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

/** Cumulative CostTracker counters captured when a capable posture begins. */
export interface CachePostureUsageBaseline {
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

/** Sanitized, durable cache information that is safe to expose to an operator. */
export interface CachePosture {
	provider: "anthropic";
	model: string;
	api: "anthropic-messages";
	expectedCaching: "provider-managed";
	ttl: "unknown";
	healthyAt?: number;
	stallWarning?: CacheStallWarning;
}

/** Original, session-wide stall evidence retained after model changes. */
export interface CacheStallHistory {
	posture: Omit<CachePosture, "healthyAt" | "stallWarning">;
	warning: CacheStallWarning;
}

export type CachePostureClassification =
	| { capable: true; posture: Omit<CachePosture, "healthyAt" | "stallWarning"> }
	| { capable: false };

/**
 * Fail closed: cache telemetry is proven only for a session-selectable, direct
 * Anthropic Messages catalog model with text input. Provider/model spelling,
 * pricing fields, and inferred model metadata are intentionally not evidence.
 */
export function classifyCachePosture(model: ApiModel | undefined): CachePostureClassification {
	if (
		!model
		|| model.provider !== "anthropic"
		|| model.api !== "anthropic-messages"
		|| model.sessionSelectable === false
		|| !model.id
		|| !model.input?.includes("text")
	) return { capable: false };

	return {
		capable: true,
		posture: {
			provider: "anthropic",
			model: model.id,
			api: "anthropic-messages",
			expectedCaching: "provider-managed",
			ttl: "unknown",
		},
	};
}

export function cachePostureMessage(posture: CachePosture): string {
	return `Cache posture: ${posture.model} via ${posture.api}; caching is provider-managed (TTL unknown).`;
}

export function cacheStallMessage(): string {
	return `No prompt-cache reads were reported after ${CACHE_STALL_INPUT_THRESHOLD.toLocaleString()} fresh input tokens. Check the provider cache configuration and request telemetry.`;
}
