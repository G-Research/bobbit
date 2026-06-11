/** Regression tests for first-class child session metadata used by visible child sessions
 * (parentSessionId/childKind/readOnly). The legacy walkthrough* fields were removed when the
 * PR walkthrough migrated to host.agents (binding-routed; no per-session walkthrough metadata). */
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
		]) {
			assert.match(setupSrc, new RegExp(`${field}:\\s*plan\\.${field}`), `persistOnce/spawnAgent must preserve ${field}`);
		}
	});

	it("persists and restores explicit walkthrough allowedTools", () => {
		const setupSrc = fs.readFileSync(path.join(process.cwd(), "src/server/agent/session-setup.ts"), "utf-8");
		const managerSrc = fs.readFileSync(path.join(process.cwd(), "src/server/agent/session-manager.ts"), "utf-8");
		const storeSrc = fs.readFileSync(path.join(process.cwd(), "src/server/agent/session-store.ts"), "utf-8");

		assert.match(storeSrc, /allowedTools\?:\s*string\[\]/, "PersistedSession must store explicit session allowedTools");
		assert.match(setupSrc, /allowedTools:\s*plan\.sessionScopedAllowedTools/, "persistOnce must write explicit session allowedTools");
		assert.match(managerSrc, /const persistedAllowedTools = Array\.isArray\(ps\.allowedTools\) && ps\.allowedTools\.length > 0 \? ps\.allowedTools : undefined;/, "restoreSession must read persisted allowedTools");
		assert.match(managerSrc, /persistedAllowedTools\.map\(n => tagAllowedTool\(n, this\.toolManager\)\)/, "restoreSession must prefer persisted allowedTools before role defaults");
	});
});
