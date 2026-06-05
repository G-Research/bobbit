/**
 * Pure validation helper for explicit `dependsOn` references in plan steps.
 *
 * Two entry points:
 *
 *  - `validateDependsOn({ planId, dependsOn, knownPlanIds })` — single-spawn
 *    validation, used by `POST /api/goals/:id/spawn-child`. The caller builds
 *    `knownPlanIds` from the parent's existing children's `spawnedFromPlanId`
 *    values. `planId` is the planId of the step being spawned (so we can
 *    reject self-deps).
 *
 *  - `validatePlanDependsOn(steps[])` — multi-step plan validation, used by
 *    `PATCH /api/goals/:id/plan`. Detects self-deps, unknown planId
 *    references, and cycles via Kahn's algorithm.
 *
 * Returns `{ ok: true }` on success or one of three error shapes:
 *
 *   { ok: false, code: "SELF_DEPENDENCY", planId }
 *   { ok: false, code: "UNKNOWN_PLAN_ID", missing: string[] }
 *   { ok: false, code: "DEPENDS_ON_CYCLE", path: string[] }
 *
 * The REST layer maps these to 400 status codes with structured error bodies.
 *
 * No DOM. No I/O. No side effects.
 */

export type DependsOnErrorCode =
	| "SELF_DEPENDENCY"
	| "UNKNOWN_PLAN_ID"
	| "DEPENDS_ON_CYCLE";

export type DependsOnValidationResult =
	| { ok: true }
	| { ok: false; code: "SELF_DEPENDENCY"; planId: string }
	| { ok: false; code: "UNKNOWN_PLAN_ID"; missing: string[] }
	| { ok: false; code: "DEPENDS_ON_CYCLE"; path: string[] };

export interface ValidateDependsOnInput {
	/** planId of the step being spawned/added. */
	planId: string;
	/** Optional list of sibling planIds this step depends on. */
	dependsOn?: string[];
	/** planIds the step is allowed to reference (e.g. siblings already spawned). */
	knownPlanIds: Iterable<string>;
}

/**
 * Validate a single step's `dependsOn` array — used at spawn-child time.
 * `knownPlanIds` is typically the set of `spawnedFromPlanId`s already on
 * the parent's children. The new step's own planId is rejected if present
 * in its own deps (self-dependency).
 */
export function validateDependsOn(input: ValidateDependsOnInput): DependsOnValidationResult {
	const deps = input.dependsOn ?? [];
	if (deps.length === 0) return { ok: true };
	if (deps.includes(input.planId)) {
		return { ok: false, code: "SELF_DEPENDENCY", planId: input.planId };
	}
	const known = new Set(input.knownPlanIds);
	const missing: string[] = [];
	for (const d of deps) {
		if (!known.has(d)) missing.push(d);
	}
	if (missing.length > 0) {
		return { ok: false, code: "UNKNOWN_PLAN_ID", missing };
	}
	return { ok: true };
}

/** Subset of plan-step shape we care about for graph validation. */
export interface DependsOnStep {
	planId: string;
	dependsOn?: string[];
}

/**
 * Validate a full proposed plan — used at PATCH /plan time. Detects:
 *   1. self-deps (a step referencing its own planId in `dependsOn`),
 *   2. unknown planId references (deps pointing at non-existent steps),
 *   3. cycles, via Kahn's algorithm.
 *
 * On the first error encountered, returns the error variant. Reports the
 * cycle path (a representative cycle) as the list of remaining planIds when
 * Kahn's terminates with non-empty in-degree map.
 */
export function validatePlanDependsOn(steps: DependsOnStep[]): DependsOnValidationResult {
	const planIds = new Set<string>();
	for (const s of steps) planIds.add(s.planId);

	// 1. self-deps + unknown refs
	const missing: string[] = [];
	for (const s of steps) {
		const deps = s.dependsOn ?? [];
		if (deps.includes(s.planId)) {
			return { ok: false, code: "SELF_DEPENDENCY", planId: s.planId };
		}
		for (const d of deps) {
			if (!planIds.has(d) && !missing.includes(d)) missing.push(d);
		}
	}
	if (missing.length > 0) {
		return { ok: false, code: "UNKNOWN_PLAN_ID", missing };
	}

	// 2. cycle via Kahn's
	const inDegree = new Map<string, number>();
	const adj = new Map<string, string[]>();
	for (const s of steps) {
		inDegree.set(s.planId, 0);
		adj.set(s.planId, []);
	}
	for (const s of steps) {
		for (const d of s.dependsOn ?? []) {
			// edge: d -> s.planId (s depends on d)
			adj.get(d)!.push(s.planId);
			inDegree.set(s.planId, (inDegree.get(s.planId) ?? 0) + 1);
		}
	}
	const queue: string[] = [];
	for (const [k, v] of inDegree) if (v === 0) queue.push(k);
	let visited = 0;
	while (queue.length > 0) {
		const id = queue.shift()!;
		visited++;
		for (const next of adj.get(id) ?? []) {
			const d = (inDegree.get(next) ?? 0) - 1;
			inDegree.set(next, d);
			if (d === 0) queue.push(next);
		}
	}
	if (visited < steps.length) {
		// remaining nodes participate in (or are downstream of) at least one cycle.
		const remaining: string[] = [];
		for (const [k, v] of inDegree) if (v > 0) remaining.push(k);
		return { ok: false, code: "DEPENDS_ON_CYCLE", path: remaining };
	}
	return { ok: true };
}
