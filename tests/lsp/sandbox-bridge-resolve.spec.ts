/**
 * Regression test for `MultiProjectSandboxLspBridge.resolveForWorktree`.
 *
 * Background (2026-05-15): the fail-closed change in `spawnLspChild`
 * (sibling commit f1bc9aff, pinned by `server-process-sandbox.spec.ts`)
 * correctly refuses to spawn a host language server when the caller supplies
 * a sandbox bridge for a worktree without a running container. That guard
 * is at the spawn boundary — it relies on the supervisor only passing the
 * bridge through for worktrees that genuinely belong to a sandbox-configured
 * project. Before this test, the multi-project bridge always passed itself
 * through (falling back to `this` when no project matched), which made every
 * worktree look "sandboxed" — and broke the API LSP E2Es that point at
 * `tests/fixtures/lsp-ts` (a path outside any registered project).
 *
 * Invariants pinned here:
 *   1. `resolveForWorktree` returns `null` when the worktree is NOT inside
 *      any sandbox-configured project. Callers (typescript adapter) treat
 *      that as "no sandbox" and spawn the host LSP normally.
 *   2. A project with `sandbox: "docker"` whose worktree includes the path
 *      DOES resolve to a per-project bridge — preserving fail-closed.
 *   3. A project registered WITHOUT `sandbox: "docker"` is skipped, even if
 *      its worktree-root contains the path (host LSP wins).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { MultiProjectSandboxLspBridge } from "../../src/server/lsp/sandbox-bridge.ts";

type FakeCtx = {
	project: { id: string; name: string; rootPath: string };
	projectConfigStore: { get(key: string): unknown };
};

function makeCtx(opts: { id: string; rootPath: string; sandbox?: string; worktreeRoot?: string }): FakeCtx {
	const cfg: Record<string, unknown> = {};
	if (opts.sandbox !== undefined) cfg["sandbox"] = opts.sandbox;
	if (opts.worktreeRoot !== undefined) cfg["worktree_root"] = opts.worktreeRoot;
	return {
		project: { id: opts.id, name: opts.id, rootPath: opts.rootPath },
		projectConfigStore: { get: (k: string) => cfg[k] },
	};
}

function makePcm(ctxs: FakeCtx[]) {
	return { all: () => ctxs } as any;
}

const fakeSandboxManager = {
	get: () => undefined,
} as any;

describe("MultiProjectSandboxLspBridge.resolveForWorktree", () => {
	test("returns null for a path outside any registered project", () => {
		const pcm = makePcm([
			makeCtx({ id: "p1", rootPath: "/projects/p1", sandbox: "docker" }),
		]);
		const bridge = new MultiProjectSandboxLspBridge(fakeSandboxManager, pcm);
		const got = bridge.resolveForWorktree("/tmp/some/unrelated/path");
		assert.equal(got, null, "expected null for a path not under any project root or worktree-root");
	});

	test("returns null when the matching project is NOT sandbox-configured", () => {
		// Path IS inside the project root, but the project has no `sandbox: docker`
		// setting — host LSP must win, no fail-closed.
		const pcm = makePcm([
			makeCtx({ id: "p1", rootPath: "/projects/p1" /* no sandbox */ }),
		]);
		const bridge = new MultiProjectSandboxLspBridge(fakeSandboxManager, pcm);
		const got = bridge.resolveForWorktree("/projects/p1/src/foo.ts");
		assert.equal(got, null, "non-sandbox-configured projects must resolve to null");
	});

	test("returns null when the matching project has sandbox=\"none\"", () => {
		const pcm = makePcm([
			makeCtx({ id: "p1", rootPath: "/projects/p1", sandbox: "none" }),
		]);
		const bridge = new MultiProjectSandboxLspBridge(fakeSandboxManager, pcm);
		const got = bridge.resolveForWorktree("/projects/p1/src/foo.ts");
		assert.equal(got, null);
	});

	test("returns a per-project bridge for a sandbox-configured project's worktree", () => {
		const pcm = makePcm([
			makeCtx({ id: "p1", rootPath: "/projects/p1", sandbox: "docker" }),
		]);
		const bridge = new MultiProjectSandboxLspBridge(fakeSandboxManager, pcm);
		const got = bridge.resolveForWorktree("/projects/p1/src/foo.ts");
		assert.ok(got, "expected a non-null per-project bridge for a sandbox-configured match");
		assert.notEqual(got, bridge, "must not return the multi-project bridge itself");
	});

	test("matches the sandbox-configured project's <root>-wt sibling worktree root", () => {
		const pcm = makePcm([
			makeCtx({ id: "p1", rootPath: "/projects/p1", sandbox: "docker" }),
		]);
		const bridge = new MultiProjectSandboxLspBridge(fakeSandboxManager, pcm);
		const wt = path.resolve("/projects/p1-wt/session/abc/src/foo.ts");
		const got = bridge.resolveForWorktree(wt);
		assert.ok(got, `expected sibling worktree-root to match for ${wt}`);
	});

	test("prefers the longest-matching sandbox-configured project on overlap", () => {
		const pcm = makePcm([
			makeCtx({ id: "outer", rootPath: "/projects",       sandbox: "docker" }),
			makeCtx({ id: "inner", rootPath: "/projects/inner", sandbox: "docker" }),
		]);
		const bridge = new MultiProjectSandboxLspBridge(fakeSandboxManager, pcm);
		const got = bridge.resolveForWorktree("/projects/inner/src/foo.ts");
		assert.ok(got, "expected a per-project bridge");
		// Exposed via containerIdForWorktree → sandboxManager.get(projectId).
		// Stub sandboxManager records the lookup.
		const recorded: string[] = [];
		const recordingMgr = { get: (id: string) => { recorded.push(id); return undefined; } } as any;
		const recBridge = new MultiProjectSandboxLspBridge(recordingMgr, pcm);
		recBridge.resolveForWorktree("/projects/inner/src/foo.ts");
		recBridge.containerIdForWorktree("/projects/inner/src/foo.ts");
		assert.deepEqual(recorded, ["inner"], `expected the more-specific project to be chosen, got ${JSON.stringify(recorded)}`);
	});
});
