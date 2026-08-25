/**
 * Entity-leak detector for the tier-1 gateway fixture.
 *
 * The gateway is booted once per fork and shared across every test file in that
 * fork (pool:"forks", isolate:false). Shared mutable state is only safe if each
 * test cleans up the entities it creates (see createScope()). This detector
 * promotes any un-cleaned entity to a HARD failure: snapshot counts at a file's
 * start, snapshot again at its end, and fail on any positive delta.
 *
 * R2 mitigation from the design doc: cross-test state bleed becomes a loud,
 * deterministic failure instead of a silent flake in a later file.
 */
import type { EntityCounts, GatewayFixture } from "./gateway.js";

export function snapshotEntities(gw: GatewayFixture): EntityCounts {
	return gw.countEntities();
}

export interface LeakReport {
	leaked: boolean;
	deltas: EntityCounts;
	before: EntityCounts;
	after: EntityCounts;
}

export function diffEntities(before: EntityCounts, after: EntityCounts): LeakReport {
	const deltas: EntityCounts = {
		sessions: after.sessions - before.sessions,
		goals: after.goals - before.goals,
		projects: after.projects - before.projects,
	};
	// Any unowned delta is a hard failure: a POSITIVE delta is a leak (a test
	// created an entity it never cleaned up); a NEGATIVE delta means a test
	// clobbered shared baseline state (net-removed a baseline entity). Both
	// corrupt the shared fork for later files, so fire on either direction.
	const leaked = deltas.sessions !== 0 || deltas.goals !== 0 || deltas.projects !== 0;
	return { leaked, deltas, before, after };
}

/**
 * Throws if any entity count increased between `before` and `after`. Negative
 * deltas (a test that net-removed a baseline entity) are surfaced too, because
 * they indicate a test clobbered shared baseline state.
 */
export function assertNoLeaks(before: EntityCounts, after: EntityCounts): void {
	const report = diffEntities(before, after);
	if (report.leaked) {
		const parts = (Object.entries(report.deltas) as Array<[keyof EntityCounts, number]>)
			.filter(([, d]) => d !== 0)
			.map(([k, d]) => `${k}: ${d > 0 ? "+" : ""}${d}`);
		const hasPositive = report.deltas.sessions > 0 || report.deltas.goals > 0 || report.deltas.projects > 0;
		const hasNegative = report.deltas.sessions < 0 || report.deltas.goals < 0 || report.deltas.projects < 0;
		const kind = hasPositive && hasNegative
			? "entity leak + baseline clobber detected — a test both leaked new entities and net-removed baseline ones"
			: hasNegative
				? "baseline clobber detected — a test net-removed a baseline entity (destroyed shared state)"
				: "entity leak detected — a test did not clean up after itself";
		throw new Error(
			`[tests2/leak-detector] ${kind}. ` +
			`Deltas { ${parts.join(", ")} }. before=${JSON.stringify(before)} after=${JSON.stringify(after)}. ` +
			`Wrap created sessions/goals/projects in createScope() and let afterEach delete them.`,
		);
	}
}

/**
 * Convenience wrapper for a whole test file: snapshot before, run body, snapshot
 * after, assert no leak. Use in a top-level describe when you want the guard to
 * cover the entire file rather than per-test.
 */
export async function withLeakGuard(gw: GatewayFixture, body: () => Promise<void> | void): Promise<void> {
	const before = snapshotEntities(gw);
	await body();
	const after = snapshotEntities(gw);
	assertNoLeaks(before, after);
}
