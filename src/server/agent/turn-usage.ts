import type { TurnUsageSnapshot } from "./lifecycle-hub.js";

/**
 * Reads direct terminal assistant telemetry from Pi's event wire format.
 *
 * This deliberately does not derive data from CostTracker: omitted fields stay
 * omitted, including cache values. Callers may supply an already-verified
 * runtime model pair; partial attribution is never exposed.
 */
export function readTerminalAssistantUsage(
	event: unknown,
	attribution?: { provider?: string; modelId?: string },
): TurnUsageSnapshot | undefined {
	if (!isRecord(event) || event.type !== "message_end" || !isRecord(event.message) || event.message.role !== "assistant") {
		return undefined;
	}
	const usage = event.message.usage ?? event.usage;
	if (!isRecord(usage)) return undefined;

	const inputTokens = firstFiniteNonNegative(usage.inputTokens, usage.input);
	const outputTokens = firstFiniteNonNegative(usage.outputTokens, usage.output);
	const cacheReadTokens = firstFiniteNonNegative(usage.cacheReadTokens, usage.cacheRead);
	const cacheWriteTokens = firstFiniteNonNegative(usage.cacheWriteTokens, usage.cacheWrite);
	const cost = firstFiniteNonNegative(usage.cost, isRecord(usage.cost) ? usage.cost.total : undefined);
	const provider = nonEmptyString(attribution?.provider);
	const modelId = nonEmptyString(attribution?.modelId);

	return {
		telemetry: "known",
		...(inputTokens !== undefined ? { inputTokens } : {}),
		...(outputTokens !== undefined ? { outputTokens } : {}),
		...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
		...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
		...(cost !== undefined ? { cost } : {}),
		...(provider && modelId ? { provider, modelId } : {}),
	};
}

function firstFiniteNonNegative(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	}
	return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
