/**
 * runComponentSetups — sequential per-component runner with stub exec.
 *
 * See docs/design/multi-repo-components.md §7.1.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { runComponentSetups } from "../src/server/skills/worktree-setup.ts";
import type { Component } from "../src/server/agent/project-config-store.ts";

describe("runComponentSetups", () => {
	it("runs in declared order; data-only skipped; failure is non-fatal", async () => {
		const calls: Array<{ cmd: string; cwd: string; sourceRepo: string }> = [];
		const components: Component[] = [
			{ name: "api", repo: "api", worktreeSetupCommand: "npm ci" },
			{ name: "shared", repo: "shared" }, // data-only — no command, must be skipped
			{ name: "web", repo: "web", worktreeSetupCommand: "BREAK" },  // failing
			{ name: "docs", repo: "docs", worktreeSetupCommand: "echo ok" }, // runs after failure
		];
		const branchContainer = "/wt/branch-x";
		const primaryWorktreeRoot = "/repo";

		await runComponentSetups({
			components,
			branchContainer,
			primaryWorktreeRoot,
			exec: async (cmd, cwd, env) => {
				calls.push({ cmd, cwd, sourceRepo: env.SOURCE_REPO ?? "" });
				if (cmd === "BREAK") throw new Error("boom");
			},
		});

		// Declared order, data-only skipped.
		assert.deepEqual(calls.map(c => c.cmd), ["npm ci", "BREAK", "echo ok"]);

		// Per-component cwd resolves to <branchContainer>/<repo>.
		assert.equal(calls[0].cwd, path.join(branchContainer, "api"));
		assert.equal(calls[1].cwd, path.join(branchContainer, "web"));
		assert.equal(calls[2].cwd, path.join(branchContainer, "docs"));

		// SOURCE_REPO points at the matching path under the primary checkout.
		assert.equal(calls[0].sourceRepo, path.join(primaryWorktreeRoot, "api"));
		assert.equal(calls[2].sourceRepo, path.join(primaryWorktreeRoot, "docs"));
	});

	it("single-repo (repo='.') with relativePath resolves cwd to branchContainer/<relativePath>", async () => {
		const calls: Array<{ cwd: string; sourceRepo: string }> = [];
		await runComponentSetups({
			components: [{ name: "app", repo: ".", relativePath: "app", worktreeSetupCommand: "echo ok" }],
			branchContainer: "/wt/feat-x",
			primaryWorktreeRoot: "/repo",
			exec: async (_cmd, cwd, env) => {
				calls.push({ cwd, sourceRepo: env.SOURCE_REPO ?? "" });
			},
		});
		// cwd must honor relativePath — the bug was running at branchContainer
		// instead of branchContainer/app.
		assert.equal(calls[0].cwd, path.join("/wt/feat-x", "app"));
		assert.ok(calls[0].cwd.endsWith(`${path.sep}app`), `expected cwd to end with /app, got ${calls[0].cwd}`);
		assert.equal(calls[0].sourceRepo, path.join("/repo", "app"));
	});

	it("single-repo (repo='.') resolves cwd to branchContainer itself", async () => {
		const calls: Array<{ cwd: string; sourceRepo: string }> = [];
		await runComponentSetups({
			components: [{ name: "self", repo: ".", worktreeSetupCommand: "npm ci" }],
			branchContainer: "/wt/feat-x",
			primaryWorktreeRoot: "/repo",
			exec: async (_cmd, cwd, env) => {
				calls.push({ cwd, sourceRepo: env.SOURCE_REPO ?? "" });
			},
		});
		assert.equal(calls[0].cwd, "/wt/feat-x");
		// path.join collapses to platform separators; use path.join for assertion.
		assert.equal(calls[0].sourceRepo, path.join("/repo"));
	});
});
