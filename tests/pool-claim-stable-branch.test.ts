/**
 * Unit-level regression: a session row persisted with `branch = session/<id8>`
 * after a pool claim must round-trip through SessionStore unchanged \u2014 no
 * rename code path is invoked across reload.
 *
 * Mirrors the scenario in design \u00a716.2 (restart-resume preserves branch).
 * The full restart-resume E2E lives in
 * `tests/manual-integration/restart-minimal.spec.ts` (real gateway + hard
 * kill + re-spawn).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/server/agent/session-store.ts";

describe("pool-claim branch stability across SessionStore reload", () => {
	it("session row with branch=session/<id8> reloads unchanged", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pool-stable-"));
		try {
			const store1 = new SessionStore(dir);
			store1.put({
				id: "abcd1234-aaaa-bbbb-cccc-deadbeef0000",
				title: "Some session",
				cwd: "/tmp/repo-wt/session-abcd1234",
				agentSessionFile: "/tmp/sessions/x.jsonl",
				createdAt: 1, lastActivity: 1,
				branch: "session/abcd1234",
				worktreePath: "/tmp/repo-wt/session-abcd1234",
				repoPath: "/tmp/repo",
				projectId: "proj-1",
			});
			store1.flush();

			// Simulate restart: fresh store reads from disk.
			const store2 = new SessionStore(dir);
			const reloaded = store2.get("abcd1234-aaaa-bbbb-cccc-deadbeef0000");
			assert.ok(reloaded);
			assert.equal(reloaded!.branch, "session/abcd1234");
			assert.equal(reloaded!.worktreePath, "/tmp/repo-wt/session-abcd1234");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("legacy poolId / worktreeDegraded fields are silently ignored on load", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pool-legacy-"));
		try {
			// Hand-write a sessions.json with legacy fields that no longer exist
			// on PersistedSession. They must round-trip without crashing the loader.
			const legacy = [{
				id: "deadbeef-0000-0000-0000-000000000000",
				title: "Legacy",
				cwd: "/tmp",
				agentSessionFile: "/tmp/x.jsonl",
				createdAt: 1, lastActivity: 1,
				branch: "pool/_pool-deadbeef",
				poolId: "_pool-deadbeef",
				worktreeDegraded: true,
			}];
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify(legacy));

			const store = new SessionStore(dir);
			const reloaded = store.get("deadbeef-0000-0000-0000-000000000000");
			assert.ok(reloaded);
			assert.equal(reloaded!.title, "Legacy");
			// Branch is preserved \u2014 the sweeper handles cleanup of the orphan,
			// not the loader.
			assert.equal(reloaded!.branch, "pool/_pool-deadbeef");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
