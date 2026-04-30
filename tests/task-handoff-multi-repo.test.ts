/**
 * Multi-repo git handoff round-trip on PersistedTask.
 *
 * See docs/design/multi-repo-components.md §6.1.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TaskStore, readHandoff, type PersistedTask } from "../src/server/agent/task-store.ts";

let stateDir: string;

before(() => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-test-"));
});

after(() => {
	try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("readHandoff", () => {
	it("multi-repo: returns per-repo entry from gitHandoff map", () => {
		const t: PersistedTask = {
			id: "t1",
			goalId: "g1",
			title: "x",
			type: "implementation",
			state: "todo",
			createdAt: 0,
			updatedAt: 0,
			gitHandoff: {
				api: { baseSha: "a1", headSha: "a2", branch: "feat/api" },
				web: { baseSha: "w1", headSha: "w2", branch: "feat/web" },
			},
		};
		assert.deepEqual(readHandoff(t, "api"), { baseSha: "a1", headSha: "a2", branch: "feat/api" });
		assert.deepEqual(readHandoff(t, "web"), { baseSha: "w1", headSha: "w2", branch: "feat/web" });
	});

	it("legacy single-repo: falls back to flat fields when gitHandoff absent", () => {
		const t: PersistedTask = {
			id: "t2",
			goalId: "g1",
			title: "x",
			type: "implementation",
			state: "todo",
			createdAt: 0,
			updatedAt: 0,
			baseSha: "f1",
			headSha: "f2",
			branch: "feat/x",
		};
		assert.deepEqual(readHandoff(t, "anything"), { baseSha: "f1", headSha: "f2", branch: "feat/x" });
	});

	it("round-trips through TaskStore", () => {
		const store = new TaskStore(stateDir);
		const t: PersistedTask = {
			id: "rt-1",
			goalId: "g",
			title: "rt",
			type: "implementation",
			state: "todo",
			createdAt: 1,
			updatedAt: 1,
			gitHandoff: {
				api: { baseSha: "a", headSha: "b", branch: "c" },
			},
		};
		store.put(t);

		// Re-read by constructing a new store on the same dir.
		const store2 = new TaskStore(stateDir);
		const got = store2.get("rt-1");
		assert.ok(got);
		assert.equal(got!.gitHandoff?.api.headSha, "b");
		assert.equal(readHandoff(got!, "api").branch, "c");
	});
});
