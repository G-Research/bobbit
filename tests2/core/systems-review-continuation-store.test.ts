// v2-native — durable logical Systems execution/session-chain coverage.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SystemsReviewWriterLeaseCoordinator } from "../../src/server/agent/systems-review-lease.ts";
import { SystemsReviewExecutionStore } from "../../src/server/agent/systems-review-store.ts";
import type { SystemsReviewSnapshot } from "../../src/server/agent/systems-review-types.ts";

const roots: string[] = [];

function stateDirectory(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-systems-continuation-"));
	roots.push(root);
	return root;
}

function snapshot(): SystemsReviewSnapshot {
	return {
		version: 1,
		sessionId: "review-session-initial",
		signalId: "signal-1",
		createdAt: 1,
		projectRoot: "/project",
		branchContainer: "/project-wt",
		digest: "snapshot-digest",
		derivationSha256: "d".repeat(64),
		repos: [],
		changes: [],
		coverage: [],
		chunks: [{ id: "chunk-empty", index: 0, parts: [], semanticPatchBytes: 0, changeIds: [] }],
	};
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Systems review logical continuation state", () => {
	it("persists fresh reviewer sessions on one immutable execution across restart/resume", () => {
		const stateDir = stateDirectory();
		const store = new SystemsReviewExecutionStore(stateDir, { now: () => 10 });
		const created = store.create({
			id: "execution-1",
			goalId: "goal-1",
			gateId: "implementation",
			signalId: "signal-1",
			sessionId: "review-session-initial",
			snapshot: snapshot(),
			contractId: "bobbit:systems-interaction-review/v1",
			contractDigest: "a".repeat(64),
		});
		store.bindContinuationSession(created.id, "review-session-continuation-1");
		expect(store.isReviewerSessionBound(created.id, "review-session-initial")).toBe(true);
		expect(store.isReviewerSessionBound(created.id, "review-session-continuation-1")).toBe(true);

		store.markFailed(created.id, "interrupted", "RESTART", "restart after checkpoint");
		const reloaded = new SystemsReviewExecutionStore(stateDir, { now: () => 20 });
		reloaded.resume(created.id);
		reloaded.bindContinuationSession(created.id, "review-session-continuation-2");
		expect(reloaded.get(created.id)?.reviewerSessionIds).toEqual([
			"review-session-initial",
			"review-session-continuation-1",
			"review-session-continuation-2",
		]);
	});

	it("blocks other writers for the lease lifetime and releases idempotently", () => {
		const leases = new SystemsReviewWriterLeaseCoordinator({ now: () => 42 });
		const lease = leases.acquire("goal-1", "execution-1");
		expect(() => leases.assertWriteAllowed("goal-1")).toThrow(/immutable/i);
		expect(() => leases.assertWriteAllowed("goal-1", lease.token)).not.toThrow();
		expect(() => leases.acquire("goal-1", "execution-2")).toThrow(/already protected/i);
		lease.release();
		lease.release();
		expect(() => leases.assertWriteAllowed("goal-1")).not.toThrow();
	});
});
