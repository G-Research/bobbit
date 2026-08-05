import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	GraphifyDeltaAdapter,
	rebuildCodeCompatibility,
	type GraphifyDeltaExecution,
} from "../../market-packs/code-intelligence/src/graphify-runner.ts";
import { GraphifyChainHarness } from "../../market-packs/code-intelligence/src/graphify-harness.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function writeCorpus(root: string): void {
	for (const [relative, source] of Object.entries({
		"src/entry.ts": "export const entry = () => 'base';\n",
		"src/parent.ts": "export const parent = () => 'parent';\n",
		"tests2/entry.test.ts": "export const testEntry = true;\n",
		"defaults/config.ts": "export const config = true;\n",
	})) {
		const file = path.join(root, relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, source);
	}
}

test.describe.configure({ mode: "serial" });

test("Graphify adapter keeps linked-worktree fixture artifacts external", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-graphify-worktree-"));
	const primary = path.join(root, "primary");
	const linked = path.join(root, "linked");
	const hostState = path.join(root, "host-state");
	let publicDeltaCalls = 0;
	let compatibilityCalls = 0;
	try {
		fs.mkdirSync(primary, { recursive: true });
		git(primary, "init", "--quiet");
		git(primary, "config", "user.email", "graphify-test@bobbit.local");
		git(primary, "config", "user.name", "Graphify fixture");
		git(primary, "checkout", "--quiet", "-b", "main");
		writeCorpus(primary);
		git(primary, "add", ".");
		git(primary, "commit", "--quiet", "-m", "base corpus");
		git(primary, "worktree", "add", "--quiet", "-b", "feature/linked", linked, "HEAD");
		fs.writeFileSync(path.join(linked, "src", "child.ts"), "export const child = () => 'linked';\n");
		git(linked, "add", ".");
		git(linked, "commit", "--quiet", "-m", "child delta");

		// This is an adapter-boundary fixture, not a claim that Graphify ran locally.
		// The checked-in benchmark records the unavailable Graphify capability honestly.
		const execution: GraphifyDeltaExecution = {
			async probePublicDelta() { return null; },
			async invokePublicDelta() { publicDeltaCalls++; throw new Error("public delta is deliberately unavailable in the isolated harness"); },
			async probeCompatibility() { return { modulePath: "graphify.watch", callable: "_rebuild_code", signature: ["root", "changed_paths"] }; },
			async invokeCompatibility(_spec, request) {
				compatibilityCalls++;
				expect(request.cwd).toBe(linked);
				expect(request.scanRoots).toEqual(["defaults", "src", "tests2"]);
				expect(request.changedPaths).toEqual(["src/child.ts"]);
				expect(request.noCluster).toBe(true);
				const graphPath = path.join(hostState, "graphs", "feature-child.json");
				fs.mkdirSync(path.dirname(graphPath), { recursive: true });
				fs.writeFileSync(graphPath, JSON.stringify({ sourcePaths: ["src/entry.ts", "src/child.ts"] }));
				return { graphPath, nodes: 2, edges: 1, sourcePaths: ["src/child.ts", "src/entry.ts"] };
			},
		};
		const adapter = new GraphifyDeltaAdapter("0.0.0", execution, [rebuildCodeCompatibility("0.0.0", ["root"])]);
		const result = await adapter.invokeDelta({
			cwd: linked,
			candidateRoot: path.join(hostState, "graphs"),
			scanRoots: ["src", "tests2", "defaults"],
			changedPaths: ["src/child.ts"],
			noCluster: true,
		});

		expect(result.graphPath.startsWith(`${hostState}${path.sep}`)).toBe(true);
		expect(fs.existsSync(result.graphPath)).toBe(true);
		expect(result.compatibility).toMatchObject({ kind: "compatibility", id: "graphify.watch._rebuild_code", resolvedVersion: "0.0.0" });
		expect(compatibilityCalls).toBe(1);
		expect(publicDeltaCalls).toBe(0);
		for (const checkout of [primary, linked]) {
			expect(fs.existsSync(path.join(checkout, "graphify-out"))).toBe(false);
			expect(fs.existsSync(path.join(checkout, ".graphify_root"))).toBe(false);
			expect(fs.existsSync(path.join(checkout, "graphify-cache"))).toBe(false);
		}

		const chain = new GraphifyChainHarness();
		chain.addBase("main-A", git(primary, "rev-parse", "HEAD"), { sourcePaths: ["src/entry.ts"], nodes: 1, edges: 0 });
		chain.derive("parent-B", "derived-base", "main-A", "parent-B", { sourcePaths: ["src/entry.ts", "src/parent.ts"], nodes: 2, edges: 1 });
		chain.derive("child-D", "branch", "parent-B", git(linked, "rev-parse", "HEAD"), { sourcePaths: result.sourcePaths, nodes: result.nodes, edges: result.edges });
		expect(chain.advanceParent("parent-B")).toEqual(["parent-B", "child-D"]);
		expect(chain.current("parent-B")).toBeNull();
		expect(chain.current("child-D")).toBeNull();
	} finally {
		try { git(primary, "worktree", "remove", "--force", linked); } catch { /* cleanup after a failed git setup */ }
		fs.rmSync(root, { recursive: true, force: true });
	}
});
