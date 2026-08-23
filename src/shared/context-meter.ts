export type ContextMeterMode = "dual" | "target-only" | "capacity-only" | "unknown";

export interface ContextMeterInput {
	usage: number;
	contextWindow?: number | null;
	modelCapacity?: number | null;
}

export interface ContextMeterResult {
	mode: ContextMeterMode;
	target?: number;
	capacity?: number;
	scale?: number;
	percentage?: number;
	markerPct?: number;
	primaryPct: number;
	warningPct: number;
	negativePct: number;
}

function positiveFinite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: undefined;
}

function validUsage(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

function percentageOf(amount: number, scale: number): number {
	return (amount / scale) * 100;
}

/**
 * Resolves display-only context meter geometry without changing the runtime
 * context window used for compaction. Segment widths are percentages of the
 * returned scale; only geometry is clamped to that scale.
 */
export function resolveContextMeter({
	usage,
	contextWindow,
	modelCapacity,
}: ContextMeterInput): ContextMeterResult {
	const target = positiveFinite(contextWindow);
	const knownCapacity = positiveFinite(modelCapacity);
	const currentUsage = validUsage(usage);

	let mode: ContextMeterMode;
	let capacity: number | undefined;
	let scale: number | undefined;

	if (target !== undefined && knownCapacity !== undefined && knownCapacity > target) {
		mode = "dual";
		capacity = knownCapacity;
		scale = knownCapacity;
	} else if (target !== undefined) {
		// Equal limits collapse to the existing single-limit treatment. A
		// capacity below the runtime target is contradictory and fails closed.
		mode = "target-only";
		scale = target;
	} else if (knownCapacity !== undefined) {
		mode = "capacity-only";
		capacity = knownCapacity;
		scale = knownCapacity;
	} else {
		return {
			mode: "unknown",
			primaryPct: 0,
			warningPct: 0,
			negativePct: 0,
		};
	}

	if (currentUsage === undefined) {
		return {
			mode,
			...(target !== undefined ? { target } : {}),
			...(capacity !== undefined ? { capacity } : {}),
			scale,
			...(mode === "dual" && target !== undefined ? { markerPct: percentageOf(target, scale) } : {}),
			primaryPct: 0,
			warningPct: 0,
			negativePct: 0,
		};
	}

	if (target === undefined) {
		return {
			mode,
			capacity,
			scale,
			percentage: percentageOf(currentUsage, scale),
			primaryPct: percentageOf(Math.min(currentUsage, scale), scale),
			warningPct: 0,
			negativePct: 0,
		};
	}

	const primaryAmount = Math.min(currentUsage, 0.75 * target);
	const warningAmount = Math.max(0, Math.min(currentUsage, target) - 0.75 * target);
	const negativeAmount = Math.max(0, Math.min(currentUsage, scale) - target);

	return {
		mode,
		target,
		...(capacity !== undefined ? { capacity } : {}),
		scale,
		percentage: percentageOf(currentUsage, scale),
		...(mode === "dual" ? { markerPct: percentageOf(target, scale) } : {}),
		primaryPct: percentageOf(primaryAmount, scale),
		warningPct: percentageOf(warningAmount, scale),
		negativePct: percentageOf(negativeAmount, scale),
	};
}
