/**
 * Phase 4 — `PlanMutationStore` round-trip + expiry tests.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	PlanMutationStore,
	DEFAULT_MUTATION_TTL_MS,
	type PendingMutation,
} from "../src/server/agent/plan-mutation-store.ts";

let tmpRoot: string;
let stateDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plan-mutation-store-"));
	stateDir = path.join(tmpRoot, "state");
	fs.mkdirSync(stateDir);
});

function makeMutation(goalId: string, requestId: string, overrides: Partial<PendingMutation> = {}): PendingMutation {
	const now = Date.now();
	return {
		goalId,
		requestId,
		kind: "fix-up",
		proposedSteps: [{ planId: "p1", title: "T", spec: "S" }],
		summary: "fix-up: 1 step modified",
		diff: { added: [], removed: [], modified: ["p1"], phaseChanges: [] },
		createdAt: now,
		expiresAt: now + DEFAULT_MUTATION_TTL_MS,
		...overrides,
	};
}

describe("PlanMutationStore", () => {
	it("put / get round-trip", () => {
		const store = new PlanMutationStore(stateDir);
		const m = makeMutation("g1", "r1");
		store.put(m);
		const got = store.get("g1", "r1");
		assert.ok(got);
		assert.equal(got!.requestId, "r1");
		assert.equal(got!.kind, "fix-up");
	});

	it("get returns undefined for missing", () => {
		const store = new PlanMutationStore(stateDir);
		assert.equal(store.get("nope", "nope"), undefined);
	});

	it("put twice with same requestId replaces", () => {
		const store = new PlanMutationStore(stateDir);
		store.put(makeMutation("g1", "r1", { summary: "v1" }));
		store.put(makeMutation("g1", "r1", { summary: "v2" }));
		const list = store.listForGoal("g1");
		assert.equal(list.length, 1);
		assert.equal(list[0].summary, "v2");
	});

	it("remove returns true on hit, false on miss", () => {
		const store = new PlanMutationStore(stateDir);
		store.put(makeMutation("g1", "r1"));
		assert.equal(store.remove("g1", "r1"), true);
		assert.equal(store.remove("g1", "r1"), false);
		assert.equal(store.get("g1", "r1"), undefined);
	});

	it("listForGoal isolation", () => {
		const store = new PlanMutationStore(stateDir);
		store.put(makeMutation("g1", "r1"));
		store.put(makeMutation("g1", "r2"));
		store.put(makeMutation("g2", "rA"));
		assert.equal(store.listForGoal("g1").length, 2);
		assert.equal(store.listForGoal("g2").length, 1);
		assert.equal(store.listForGoal("g3").length, 0);
	});

	it("pruneExpired removes only expired entries", () => {
		const store = new PlanMutationStore(stateDir);
		const now = Date.now();
		store.put(makeMutation("g1", "fresh", { createdAt: now, expiresAt: now + 60_000 }));
		store.put(makeMutation("g1", "stale", { createdAt: now - 100_000, expiresAt: now - 1_000 }));
		store.put(makeMutation("g2", "stale2", { createdAt: now - 100_000, expiresAt: now - 1_000 }));
		const removed = store.pruneExpired(now);
		assert.equal(removed, 2);
		assert.equal(store.get("g1", "fresh") !== undefined, true);
		assert.equal(store.get("g1", "stale"), undefined);
		assert.equal(store.get("g2", "stale2"), undefined);
	});

	it("pruneExpired is idempotent (second call returns 0)", () => {
		const store = new PlanMutationStore(stateDir);
		store.put(makeMutation("g1", "r1"));
		assert.equal(store.pruneExpired(), 0);
		assert.equal(store.pruneExpired(), 0);
		assert.equal(store.get("g1", "r1") !== undefined, true);
	});

	it("survives across instances (file-backed persistence)", () => {
		const a = new PlanMutationStore(stateDir);
		a.put(makeMutation("g1", "r1"));
		const b = new PlanMutationStore(stateDir);
		assert.ok(b.get("g1", "r1"));
	});
});
