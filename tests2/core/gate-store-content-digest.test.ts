import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "vitest";
import { GateStore } from "../../src/server/agent/gate-store.ts";
import { createMemFs } from "../harness/mem-fs.js";

const digest = { algorithm: "sha256" as const, version: 1 as const, digest: "a".repeat(64), fileCount: 2 };

describe("GateStore content digest persistence", () => {
	it("keeps legacy signals readable and durably mutates digest results", async () => {
		const fs = createMemFs();
		const stateDir = path.resolve("/memfs/gate-content-digest");
		fs.mkdirSync(stateDir, { recursive: true });
		const store = new GateStore(stateDir, fs);
		store.initGatesForGoal("goal", ["gate"]);
		store.recordSignal({
			id: "legacy", gateId: "gate", goalId: "goal", sessionId: "s", timestamp: 1, commitSha: "abc",
			verification: { status: "passed", steps: [] },
		});
		store.recordSignal({
			id: "current", gateId: "gate", goalId: "goal", sessionId: "s", timestamp: 2, commitSha: "abc",
			verification: { status: "running", steps: [] },
		});
		store.updateSignalContentDigest("current", digest);
		await store.flush();

		const reloaded = new GateStore(stateDir, fs);
		const signals = reloaded.getGate("goal", "gate")!.signals;
		assert.equal(signals[0].contentDigest, undefined, "legacy data is preserved without migration");
		assert.deepEqual(signals[1].contentDigest, digest);
		store.updateSignalContentDigest("current", { code: "VERIFICATION_CONTENT_DIGEST_FAILED", message: "Unable to compute verification content digest" });
		assert.equal(store.getGate("goal", "gate")!.signals[1].contentDigest, undefined);
		assert.equal(store.getGate("goal", "gate")!.signals[1].contentDigestError?.code, "VERIFICATION_CONTENT_DIGEST_FAILED");
	});
});
