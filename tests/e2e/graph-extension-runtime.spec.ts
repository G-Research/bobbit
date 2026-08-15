import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphRuntime, type GraphRuntimePort, type GraphTarget } from "../../market-packs/code-intelligence/src/graph-runtime.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function manifest(root: string, directory = root): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === ".git") continue;
		const absolute = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...manifest(root, absolute));
		else if (entry.isFile()) files.push(path.relative(root, absolute));
	}
	return files.sort();
}

test("GraphRuntime keeps linked worktrees untouched and declares the EP-8 lifecycle boundary", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-graph-runtime-e2e-"));
	const primary = path.join(root, "primary");
	const child = path.join(root, "child");
	try {
		fs.mkdirSync(primary, { recursive: true });
		git(primary, "init", "--quiet");
		git(primary, "config", "user.email", "graph-runtime-e2e@bobbit.local");
		git(primary, "config", "user.name", "Graph Runtime E2E");
		git(primary, "checkout", "--quiet", "-b", "main");
		fs.mkdirSync(path.join(primary, "src"), { recursive: true });
		fs.writeFileSync(path.join(primary, "src", "entry.ts"), "export const entry = true;\n");
		git(primary, "add", ".");
		git(primary, "commit", "--quiet", "-m", "base corpus");
		git(primary, "worktree", "add", "--quiet", "-b", "goal/child", child, "HEAD");

		const childTarget: GraphTarget = {
			projectId: "project-e2e", component: "app", worktreeId: "child-worktree", goalId: "child-goal", parentGoalId: "parent-goal", primaryRef: "main",
		};
		const before = manifest(child);
		let resolved = 0;
		let manual = 0;
		const port: GraphRuntimePort = {
			resolveTargets: async () => { resolved += 1; return [childTarget]; },
			manualRebuild: async () => { manual += 1; return { accepted: true }; },
		};
		const runtime = new GraphRuntime(port);

		const started = performance.now();
		expect(await runtime.goalProvisioned({})).toEqual({ blocks: [] });
		expect(await runtime.afterTurn({})).toEqual({ blocks: [] });
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(resolved).toBe(0);
		expect(manual).toBe(0);
		expect(manifest(child)).toEqual(before);
		expect(fs.existsSync(path.join(child, "graphify-out"))).toBe(false);

		// The only permitted rebuild seam is an awaited, caller-owned route action.
		expect(await runtime.rebuild({})).toEqual({ accepted: true });
		expect(resolved).toBe(1);
		expect(manual).toBe(1);
		expect(manifest(child)).toEqual(before);

		const unavailable = new GraphRuntime<{}>({ resolveTargets: async () => [childTarget] });
		expect(await unavailable.rebuild({})).toEqual({ accepted: false, reason: "GRAPH_REBUILD_UNAVAILABLE_PENDING_EP8" });
	} finally {
		try { git(primary, "worktree", "remove", "--force", child); } catch { /* partial fixture setup */ }
		fs.rmSync(root, { recursive: true, force: true });
	}
});
