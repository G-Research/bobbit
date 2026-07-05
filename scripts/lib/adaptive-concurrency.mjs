/**
 * Pure calculation for scaling DOWN unit-phase worker/test concurrency under
 * system load.
 *
 * scripts/run-unit.mjs already splits cores in half between the node and
 * browser runners so neither oversubscribes the other (see its "half-core
 * split" comment). That split assumes the box is otherwise idle. On this
 * machine that assumption is regularly false — a merge-gate conveyor
 * (scripts/gate-pr.sh in the sibling bobbit-fable-refactor checkout) runs
 * full test suites concurrently with ad-hoc dev/agent runs, and a `base`
 * concurrency sized for an idle box then oversubscribes further, producing
 * contention-induced timeouts that look like regressions but are not (see
 * docs/testing-strategy.md).
 *
 * Formula: effective = clamp(floor(base * cores / (cores + load1)), 2, base)
 *   - load1 == 0       → effective == base            (no scale-down when idle)
 *   - load1 == cores   → effective == floor(base / 2)  (box is at ~1 runnable
 *                          process per core beyond its own capacity)
 *   - load1 >> cores   → effective floors at 2 (never serialize down to 1 —
 *                          a single worker can deadlock producer/consumer
 *                          patterns some suites rely on)
 *
 * The lower bound is min(2, base) rather than a bare 2, so a box with only
 * 1 core (base itself < 2) is not forced above its own base.
 *
 * BOBBIT_TEST_CONCURRENCY, checked by the caller (scripts/run-unit.mjs)
 * BEFORE calling this function, always wins over this calculation — this is
 * the fallback/default path only.
 */
export function computeAdaptiveConcurrency({ base, cores, load1 }) {
	if (!Number.isFinite(base) || base <= 0) {
		throw new RangeError(`computeAdaptiveConcurrency: base must be a positive finite number, got ${base}`);
	}
	if (!Number.isFinite(cores) || cores <= 0) {
		throw new RangeError(`computeAdaptiveConcurrency: cores must be a positive finite number, got ${cores}`);
	}
	const safeLoad1 = Number.isFinite(load1) && load1 >= 0 ? load1 : 0;
	const scaled = Math.floor(base * (cores / (cores + safeLoad1)));
	const lowerBound = Math.min(2, base);
	return Math.min(base, Math.max(lowerBound, scaled));
}
