/**
 * Finding 1 (descendants half) — per-descendant `mergeConflict` + `gateStatus`
 * exposed by GET /descendants. These are a DATA CONTRACT consumed by the Plan
 * tab — the field names and gateStatus value set must not change.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	aggregateGateStatus,
	enrichDescendantsForPlan,
	type DescendantGate,
} from "../src/server/agent/goal-descendants.ts";
import type { PersistedGoal } from "../src/server/agent/goal-store.ts";

const G = (over: Partial<PersistedGoal> = {}): PersistedGoal => ({
	id: over.id ?? "g",
	title: "t",
	cwd: "/tmp",
	state: "todo",
	createdAt: 0,
	...over,
}) as PersistedGoal;

describe("aggregateGateStatus", () => {
	it("failed when any gate failed (highest precedence)", () => {
		const gates: DescendantGate[] = [
			{ gateId: "design-doc", status: "passed" },
			{ gateId: "implementation", status: "failed" },
		];
		assert.equal(aggregateGateStatus(G(), gates, false), "failed");
		// failed beats an in-flight verification too.
		assert.equal(aggregateGateStatus(G(), gates, true), "failed");
	});

	it("running when a verification is in-flight and no gate failed", () => {
		const gates: DescendantGate[] = [{ gateId: "design-doc", status: "pending" }];
		assert.equal(aggregateGateStatus(G(), gates, true), "running");
	});

	it("passed when ready-to-merge gate passed", () => {
		const gates: DescendantGate[] = [
			{ gateId: "implementation", status: "pending" },
			{ gateId: "ready-to-merge", status: "passed" },
		];
		assert.equal(aggregateGateStatus(G(), gates, false), "passed");
	});

	it("passed when every gate passed", () => {
		const gates: DescendantGate[] = [
			{ gateId: "design-doc", status: "passed" },
			{ gateId: "implementation", status: "passed" },
		];
		assert.equal(aggregateGateStatus(G(), gates, false), "passed");
	});

	it("passed when the child merged (archived + complete) even with no gates", () => {
		assert.equal(aggregateGateStatus(G({ archived: true, state: "complete" }), [], false), "passed");
	});

	it("pending when gates exist but none passed/failed and not verifying", () => {
		const gates: DescendantGate[] = [
			{ gateId: "design-doc", status: "passed" },
			{ gateId: "implementation", status: "pending" },
		];
		assert.equal(aggregateGateStatus(G(), gates, false), "pending");
	});

	it("pending when no gates yet", () => {
		assert.equal(aggregateGateStatus(G(), [], false), "pending");
	});
});

describe("enrichDescendantsForPlan", () => {
	it("normalises mergeConflict to a strict boolean and aggregates gateStatus", () => {
		const descendants: PersistedGoal[] = [
			G({ id: "a" }), // mergeConflict undefined → false
			G({ id: "b", mergeConflict: true }),
		];
		const gatesByGoal: Record<string, DescendantGate[]> = {
			a: [{ gateId: "ready-to-merge", status: "passed" }],
			b: [{ gateId: "implementation", status: "failed" }],
		};
		const enriched = enrichDescendantsForPlan(descendants, {
			getGatesForGoal: (id) => gatesByGoal[id] ?? [],
			hasActiveVerification: () => false,
		});

		const a = enriched.find(g => g.id === "a")!;
		const b = enriched.find(g => g.id === "b")!;
		assert.equal(a.mergeConflict, false);
		assert.equal(a.gateStatus, "passed");
		assert.equal(b.mergeConflict, true);
		assert.equal(b.gateStatus, "failed");
	});

	it("reports running when a descendant has an active verification", () => {
		const enriched = enrichDescendantsForPlan([G({ id: "c" })], {
			getGatesForGoal: () => [{ gateId: "implementation", status: "pending" }],
			hasActiveVerification: (id) => id === "c",
		});
		assert.equal(enriched[0].gateStatus, "running");
	});
});
