// Source: tests/delegate-helper-policy-plumbing.test.ts
// Legacy policy metadata remains readable, but provisioning must not consume it.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";

const SRC_ROOT = path.resolve(process.cwd(), "src", "server", "agent");

function src(file: string): string {
	return fs.readFileSync(path.join(SRC_ROOT, file), "utf-8");
}

describe("delegated helper legacy push-policy compatibility", () => {
	it("retains persisted policy fields only as deprecated inert metadata", () => {
		const store = src("session-store.ts");
		assert.match(store, /@deprecated Legacy inert metadata retained for backward-compatible reads/);
		assert.match(store, /worktreePushPolicy\?: WorktreePushPolicy;/);
		assert.match(store, /remotePublicationPolicy\?: WorktreePushPolicy;/);
	});

	it("does not thread publication policy through session worktree setup", () => {
		const setup = src("session-setup.ts");
		assert.doesNotMatch(setup, /worktreePushPolicy|remotePublicationPolicy|pushPolicy|skipPush/);
	});

	it("keeps compatibility options inert at the low-level worktree boundary", () => {
		const git = fs.readFileSync(path.resolve(process.cwd(), "src", "server", "skills", "git.ts"), "utf-8");
		assert.match(git, /@deprecated Ignored\. Worktree creation is always local-only\./);
		assert.doesNotMatch(git, /options\.(?:pushPolicy|skipPush)/);
	});
});
