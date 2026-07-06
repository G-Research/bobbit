import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC_ROOT = path.resolve(process.cwd(), "src", "server", "agent");

function src(file: string): string {
	return fs.readFileSync(path.join(SRC_ROOT, file), "utf-8");
}

describe("delegated helper worktree push policy plumbing", () => {
	it("persists worktreePushPolicy on session records", () => {
		const store = src("session-store.ts");
		assert.match(store, /export type WorktreePushPolicy = "local-only" \| "publish";/);
		assert.match(store, /worktreePushPolicy\?: WorktreePushPolicy;/);
		assert.match(store, /\| "worktreePushPolicy"/);
		assert.match(store, /"worktreePushPolicy"/);
	});

	it("threads createSession opts into SessionSetupPlan", () => {
		// SM decomposition c6: createSession's body (setup-plan construction)
		// lives in session-spawn.ts; session-manager.ts keeps a same-signature
		// delegating wrapper.
		const manager = src("session-spawn.ts");
		assert.match(manager, /worktreePushPolicy\?: WorktreePushPolicy/);
		assert.match(manager, /const worktreePushPolicy = headquartersScope \? undefined : opts\?\.worktreePushPolicy;/);
		assert.match(manager, /worktreePushPolicy,/);
	});

	it("passes SessionSetupPlan policy through to worktree creation and persistence", () => {
		const setup = src("session-setup.ts");
		assert.match(setup, /worktreePushPolicy\?: WorktreePushPolicy/);
		assert.match(setup, /worktreePushPolicy: plan\.worktreePushPolicy/);
		assert.match(setup, /pushPolicy: plan\.worktreePushPolicy/);
		assert.match(setup, /createWorktreeSet\([^\n]+worktreeOptions\)/);
		assert.match(setup, /createWorktree\([^\n]+worktreeOptions\)/);
	});
});
