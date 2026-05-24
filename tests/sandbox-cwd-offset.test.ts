import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
	applySandboxCwdOffset,
	normalizeSandboxCwdOffset,
	relativeSandboxCwdOffset,
} from "../src/server/agent/session-setup.js";

describe("sandbox cwd offset helpers", () => {
	it("preserves a repo-relative subdirectory under sandbox worktrees", () => {
		assert.equal(
			applySandboxCwdOffset("/workspace-wt/staff-agent-1234", "packages/app"),
			"/workspace-wt/staff-agent-1234/packages/app",
		);
	});

	it("preserves a repo-relative subdirectory for no-worktree sandbox sessions", () => {
		assert.equal(
			applySandboxCwdOffset("/workspace", "packages/app"),
			"/workspace/packages/app",
		);
	});

	it("normalizes Windows-style relative offsets into container paths", () => {
		assert.equal(normalizeSandboxCwdOffset("packages\\app"), "packages/app");
		assert.equal(
			applySandboxCwdOffset("/workspace-wt/staff-agent-1234", "packages\\app"),
			"/workspace-wt/staff-agent-1234/packages/app",
		);
	});

	it("does not append empty, parent-traversal, or absolute offsets", () => {
		assert.equal(applySandboxCwdOffset("/workspace-wt/branch", ""), "/workspace-wt/branch");
		assert.equal(applySandboxCwdOffset("/workspace-wt/branch", "."), "/workspace-wt/branch");
		assert.equal(applySandboxCwdOffset("/workspace-wt/branch", "../other"), "/workspace-wt/branch");
		assert.equal(applySandboxCwdOffset("/workspace-wt/branch", "/tmp/other"), "/workspace-wt/branch");
		assert.equal(applySandboxCwdOffset("/workspace-wt/branch", "C:\\tmp\\other"), "/workspace-wt/branch");
	});

	it("derives safe host cwd offsets only when cwd stays under the root", () => {
		const root = path.resolve("sandbox-offset-root");
		const cwd = path.join(root, "packages", "app");
		assert.equal(relativeSandboxCwdOffset(root, cwd), "packages/app");

		const outside = path.resolve("sandbox-offset-root-sibling", "app");
		assert.equal(relativeSandboxCwdOffset(root, outside), undefined);
	});
});
