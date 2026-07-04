/**
 * SWARM-W0 — SwarmGroupStore: restart-durable swarm-group barrier +
 * artifact persistence (design/swarm-orchestration.md §5.2/§5.3;
 * docs/design/swarm-orchestration-w0.md).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SwarmGroupStore, type SwarmArtifact } from "../src/server/agent/swarm-group-store.ts";

let tmpRoot: string;
let stateDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-group-store-"));
	stateDir = path.join(tmpRoot, "state");
	fs.mkdirSync(stateDir);
});

function artifact(over: Partial<SwarmArtifact> & Pick<SwarmArtifact, "goalId" | "status">): SwarmArtifact {
	return {
		sessionId: undefined,
		output: "",
		branch: undefined,
		commitSha: undefined,
		verifierScore: null,
		capturedAt: Date.now(),
		...over,
	};
}

describe("SwarmGroupStore — persistence round-trip + restart durability", () => {
	it("recordArtifact persists and get() returns it back", () => {
		const store = new SwarmGroupStore(stateDir);
		const rec = store.recordArtifact(
			"grp-1",
			artifact({ goalId: "child-a", status: "done", output: "hello", branch: "goal/child-a" }),
			["child-a", "child-b"],
			"root-1",
		);
		assert.equal(rec.swarmGroup, "grp-1");
		assert.equal(rec.rootGoalId, "root-1");
		assert.equal(rec.artifacts.length, 1);
		assert.equal(rec.barrierFired, false, "only 1 of 2 expected siblings captured — barrier must not fire yet");

		const fetched = store.get("grp-1");
		assert.ok(fetched);
		assert.equal(fetched!.artifacts[0].goalId, "child-a");
		assert.equal(fetched!.artifacts[0].output, "hello");
	});

	it("survives a restart: a fresh SwarmGroupStore instance over the same stateDir reloads prior records", () => {
		const store1 = new SwarmGroupStore(stateDir);
		store1.recordArtifact("grp-2", artifact({ goalId: "c1", status: "done" }), ["c1", "c2"], "root-2");

		// Simulate a server restart: construct a brand-new instance over the
		// same stateDir (no in-memory state carried over).
		const store2 = new SwarmGroupStore(stateDir);
		const rec = store2.get("grp-2");
		assert.ok(rec, "expected the record to survive a fresh load from disk");
		assert.equal(rec!.artifacts.length, 1);
		assert.equal(rec!.artifacts[0].goalId, "c1");
		assert.equal(rec!.rootGoalId, "root-2");
	});

	it("recordArtifact is idempotent per goalId — a second call for the same goal REPLACES, not duplicates", () => {
		const store = new SwarmGroupStore(stateDir);
		store.recordArtifact("grp-3", artifact({ goalId: "c1", status: "failed", output: "first" }), ["c1"], "root-3");
		const rec = store.recordArtifact("grp-3", artifact({ goalId: "c1", status: "done", output: "second" }), ["c1"], "root-3");
		assert.equal(rec.artifacts.length, 1);
		assert.equal(rec.artifacts[0].output, "second");
		assert.equal(rec.artifacts[0].status, "done");
	});
});

describe("SwarmGroupStore — barrier fires only when ALL expected siblings are terminal", () => {
	it("does not fire with a partial done/failed/killed mix", () => {
		const store = new SwarmGroupStore(stateDir);
		store.recordArtifact("grp-4", artifact({ goalId: "c1", status: "done" }), ["c1", "c2", "c3"]);
		let rec = store.recordArtifact("grp-4", artifact({ goalId: "c2", status: "failed" }), ["c1", "c2", "c3"]);
		assert.equal(rec.barrierFired, false, "2 of 3 siblings terminal — must not fire yet");
		rec = store.recordArtifact("grp-4", artifact({ goalId: "c3", status: "killed" }), ["c1", "c2", "c3"]);
		assert.equal(rec.barrierFired, true, "all 3 siblings (done/failed/killed) terminal — must fire");
	});

	it("allFailed=false when the barrier fires with at least one `done`", () => {
		const store = new SwarmGroupStore(stateDir);
		store.recordArtifact("grp-5", artifact({ goalId: "c1", status: "done" }), ["c1", "c2"]);
		const rec = store.recordArtifact("grp-5", artifact({ goalId: "c2", status: "failed" }), ["c1", "c2"]);
		assert.equal(rec.barrierFired, true);
		assert.equal(rec.allFailed, false);
	});

	it("allFailed=true (critique fix — must surface for human escalation) when the barrier fires with NO `done` artifact", () => {
		const store = new SwarmGroupStore(stateDir);
		store.recordArtifact("grp-6", artifact({ goalId: "c1", status: "failed" }), ["c1", "c2"]);
		const rec = store.recordArtifact("grp-6", artifact({ goalId: "c2", status: "killed" }), ["c1", "c2"]);
		assert.equal(rec.barrierFired, true);
		assert.equal(rec.allFailed, true);
	});

	it("allFailed is false while the barrier has not fired (never a premature escalation signal)", () => {
		const store = new SwarmGroupStore(stateDir);
		const rec = store.recordArtifact("grp-7", artifact({ goalId: "c1", status: "failed" }), ["c1", "c2"]);
		assert.equal(rec.barrierFired, false);
		assert.equal(rec.allFailed, false);
	});
});
