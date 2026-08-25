import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PerformanceDatabase, PerformanceDatabaseError } from "../../market-packs/performance-optimisation/src/performance-database.ts";

const roots: string[] = [];
function database(): PerformanceDatabase {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-performance-ops-"));
	roots.push(root);
	let id = 0;
	let tick = 0;
	return new PerformanceDatabase(root, {
		id: prefix => `${prefix}-${++id}`,
		now: () => new Date(Date.UTC(2025, 0, 1, 0, 0, tick++)).toISOString(),
	});
}
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const files = [
	{ path: "src/cache/store.ts", digest: "digest-a", bytes: 20 },
	{ path: "src/cache/read.ts", digest: "digest-b", bytes: 30 },
	{ path: "src/server/start.ts", digest: "digest-c", bytes: 40 },
];

function refresh(db: PerformanceDatabase, revision = "commit-1", nextFiles = files) {
	return db.refreshCoverage({ revision, files: nextFiles });
}

function firstUnit(db: PerformanceDatabase) {
	return (db.listCoverage({ kinds: ["structural"], limit: 10 }) as { items: Array<{ id: string; fingerprint: string; state: string }> }).items[0];
}

function hypothesis(db: PerformanceDatabase, overrides: Record<string, unknown> = {}) {
	const unit = firstUnit(db);
	return db.createHypothesis({
		title: "Avoid repeated cache decoding",
		description: "Cache entries may be decoded repeatedly on each lookup.",
		improvementTypes: ["cpu efficiency", "speed"],
		confidence: "medium",
		impact: "high",
		risk: "low",
		locations: [{ scanUnitId: unit.id, file: "src/cache/read.ts", symbol: "readCache", lineStart: 20, lineEnd: 32 }],
		...overrides,
	} as Parameters<PerformanceDatabase["createHypothesis"]>[0]);
}

describe("performance coverage registry", () => {
	it("refreshes deterministic units, tracks attempts, invalidates edits, and preserves history", () => {
		const db = database();
		const initial = refresh(db) as { structuralUnits: number; changedUnitIds: string[] };
		expect(initial.structuralUnits).toBe(2);
		const unit = firstUnit(db);
		expect(unit.state).toBe("unscanned");

		const claimed = db.markCoverage({ unitId: unit.id, state: "claimed", scannerSessionId: "scanner-session" }) as { attemptId: string; claimedFingerprint: string };
		const duplicate = db.markCoverage({ unitId: unit.id, state: "claimed", scannerSessionId: "scanner-session" }) as { attemptId: string };
		expect(duplicate.attemptId).toBe(claimed.attemptId);
		db.markCoverage({ unitId: unit.id, state: "running", attemptId: claimed.attemptId, claimedFingerprint: claimed.claimedFingerprint, delegateSessionId: "ideator-session" });
		db.markCoverage({ unitId: unit.id, state: "completed", attemptId: claimed.attemptId, claimedFingerprint: claimed.claimedFingerprint, summary: "analysis committed" });
		expect((db.listCoverage({ kinds: ["structural"] }) as { items: Array<{ id: string; state: string }> }).items.find(item => item.id === unit.id)?.state).toBe("scanned");

		const edited = files.map(file => file.path === "src/cache/read.ts" ? { ...file, digest: "digest-edited" } : file);
		refresh(db, "commit-2", edited);
		expect((db.listCoverage({ states: ["stale"] }) as { items: Array<{ id: string }> }).items.map(item => item.id)).toContain(unit.id);

		const staleClaim = db.markCoverage({ unitId: unit.id, state: "claimed" }) as { attemptId: string };
		refresh(db, "commit-3", edited.map(file => file.path === "src/cache/read.ts" ? { ...file, digest: "digest-edited-again" } : file));
		// Omitting claimedFingerprint on completion must use the durable attempt
		// fingerprint, not the unit's now-newer fingerprint.
		db.markCoverage({ unitId: unit.id, state: "completed", attemptId: staleClaim.attemptId });
		expect((db.listCoverage({ states: ["stale"] }) as { items: Array<{ id: string }> }).items.map(item => item.id)).toContain(unit.id);
		expect((db.listAttempts({ activeOnly: false }) as { items: unknown[] }).items).toHaveLength(2);

		// Removing the whole structural group retires it from live coverage without
		// cascading away its historical scan attempts.
		refresh(db, "commit-4", files.filter(file => !file.path.startsWith("src/cache/")));
		expect((db.listCoverage() as { items: Array<{ id: string }> }).items.map(item => item.id)).not.toContain(unit.id);
		expect((db.listAttempts({ activeOnly: false }) as { items: unknown[] }).items).toHaveLength(2);
		db.close();
	});

	it("materializes validated cross-cutting units from known members", () => {
		const db = database();
		refresh(db);
		const structural = (db.listCoverage({ kinds: ["structural"] }) as { items: Array<{ id: string }> }).items;
		const created = db.upsertCrossCutting({ label: "request cache flow", unitIds: structural.map(unit => unit.id), files: ["src/cache/read.ts"] }) as { id: string };
		const cross = (db.listCoverage({ kinds: ["cross-cutting"] }) as { items: Array<{ id: string; fileCount: number }> }).items[0];
		expect(cross).toMatchObject({ id: created.id, fileCount: 3 });
		expect(() => db.upsertCrossCutting({ label: "escape", files: ["../secret.ts"] })).toThrowError(expect.objectContaining<Partial<PerformanceDatabaseError>>({ code: "VALIDATION_FAILED" }));
		db.close();
	});
});

describe("performance hypothesis and benchmark registry", () => {
	it("deduplicates exact creates, appends observations, and orders open work by policy", () => {
		const db = database();
		refresh(db);
		const unit = firstUnit(db);
		const claimed = db.markCoverage({ unitId: unit.id, state: "claimed", scannerSessionId: "scanner-session" }) as { attemptId: string; claimedFingerprint: string };
		db.markCoverage({ unitId: unit.id, state: "running", attemptId: claimed.attemptId, claimedFingerprint: claimed.claimedFingerprint, delegateSessionId: "ideator-session" });
		const first = hypothesis(db, { sourceAttemptId: claimed.attemptId }) as { created: boolean; hypothesis: { id: string; observationCount: number } };
		const duplicate = hypothesis(db) as { created: boolean; hypothesis: { id: string } };
		expect(first.created).toBe(true);
		expect(duplicate).toMatchObject({ created: false, hypothesis: { id: first.hypothesis.id } });
		const merged = db.mergeHypothesis(first.hypothesis.id, { observation: "A second scan found the same decode path.", locations: [{ file: "src/cache/store.ts", symbol: "decode" }] }) as { hypothesis: { observationCount: number } };
		expect(merged.hypothesis.observationCount).toBe(2);

		const highRisk = hypothesis(db, { title: "A risky rewrite", description: "Rewrite the entire cache engine for speed.", risk: "high", locations: [{ file: "src/cache/store.ts", symbol: "rewrite" }] }) as { hypothesis: { id: string } };
		const ordered = db.highestPriority() as { items: Array<{ id: string }> };
		expect(ordered.items.map(item => item.id)).toEqual([first.hypothesis.id, highRisk.hypothesis.id]);
		const snapshotRegistry = db.snapshot().registry as Array<{ id: string; sessionId?: string }>;
		expect(snapshotRegistry.find(item => item.id === first.hypothesis.id)?.sessionId).toBe("ideator-session");
		db.close();
	});

	it("claims direct goal creation once, supports owned release, links unique goals, records runs, and makes outcomes idempotent", () => {
		const db = database();
		refresh(db);
		const released = hypothesis(db, { title: "Release claim", description: "Release a failed direct goal creation claim.", locations: [{ file: "src/cache/store.ts", symbol: "release" }] }) as { hypothesis: { id: string } };
		db.markGoalCreation(released.hypothesis.id, "claimed", "director-session");
		expect(() => db.markGoalCreation(released.hypothesis.id, "released", "other-session")).toThrowError(expect.objectContaining<Partial<PerformanceDatabaseError>>({ code: "CONFLICT" }));
		expect(db.markGoalCreation(released.hypothesis.id, "released", "director-session", "create failed")).toMatchObject({ hypothesis: { schedulingState: "open" } });

		const created = hypothesis(db) as { hypothesis: { id: string } };
		const hypothesisId = created.hypothesis.id;
		expect(db.markGoalCreation(hypothesisId, "claimed", "director-session")).toMatchObject({ hypothesis: { schedulingState: "goal-pending", goalClaimSessionId: "director-session" } });
		expect(() => db.markGoalCreation(hypothesisId, "claimed", "other-session")).toThrowError(expect.objectContaining<Partial<PerformanceDatabaseError>>({ code: "CONFLICT" }));
		db.linkGoal(hypothesisId, "goal-1");

		const unitId = firstUnit(db).id;
		const registered = db.registerBenchmark({ name: "Cache lookup", component: "server", commandName: "bench:cache", metric: "latency", unit: "ms", direction: "lower", scanUnitIds: [unitId], repetitions: 5 }) as { benchmark: { id: string } };
		db.recordBenchmarkRun({ hypothesisId, benchmarkId: registered.benchmark.id, kind: "baseline", commit: "abc123", environment: "fixture runner", metrics: { latency: 12.5 }, variability: { stddev: 0.2 } });
		db.recordBenchmarkRun({ hypothesisId, benchmarkId: registered.benchmark.id, kind: "candidate", commit: "def456", environment: "fixture runner", metrics: { latency: 10.1 }, interpretation: "repeatable" });

		const outcome = { outcome: "Recommend merging" as const, rationale: "Repeatable benefit with no added complexity.", measurementSummary: "12.5 ms to 10.1 ms.", behaviourAssessment: "Existing behaviour tests pass.", complexityAssessment: "Complexity neutral." };
		expect(db.recordOutcome(hypothesisId, outcome)).toMatchObject({ idempotent: false, outcome: "Recommend merging" });
		expect(db.recordOutcome(hypothesisId, outcome)).toMatchObject({ idempotent: true, outcome: "Recommend merging" });
		expect((db.snapshot().registry as Array<{ id: string; status: string }>)[0]).toMatchObject({ id: hypothesisId, status: "concluded" });
		db.close();
	});
});
