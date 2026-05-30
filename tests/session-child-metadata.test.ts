/** Regression tests for first-class child session metadata used by PR walkthrough sessions. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

describe("child session metadata wiring", () => {
	it("createSession accepts and forwards PR walkthrough child metadata without delegateOf", () => {
		const managerSrc = fs.readFileSync(path.join(process.cwd(), "src/server/agent/session-manager.ts"), "utf-8");
		for (const field of [
			"parentSessionId",
			"childKind",
			"readOnly",
			"walkthroughJobId",
			"walkthroughChangesetId",
			"walkthroughTargetKey",
		]) {
			assert.match(managerSrc, new RegExp(`${field}\\?:`), `createSession opts/SessionInfo must include ${field}`);
			const forwards = managerSrc.match(new RegExp(`${field}:\\s*opts\\?\\.${field}`, "g")) ?? [];
			assert.ok(forwards.length >= 2, `createSession must forward opts.${field} into both normal and worktree plans`);
		}
	});

	it("persistOnce writes child metadata as first-class fields", () => {
		const setupSrc = fs.readFileSync(path.join(process.cwd(), "src/server/agent/session-setup.ts"), "utf-8");
		for (const field of [
			"parentSessionId",
			"childKind",
			"readOnly",
			"walkthroughJobId",
			"walkthroughChangesetId",
			"walkthroughTargetKey",
		]) {
			assert.match(setupSrc, new RegExp(`${field}:\\s*plan\\.${field}`), `persistOnce/spawnAgent must preserve ${field}`);
		}
	});
});
