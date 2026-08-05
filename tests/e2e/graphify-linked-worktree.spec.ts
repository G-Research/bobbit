import { test, expect } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	GraphifyDeltaAdapter,
	rebuildCodeCompatibility,
	type GraphifyDeltaExecution,
	type GraphifyDeltaRequest,
} from "../../market-packs/code-intelligence/src/graphify-runner.ts";

const fixtureProgram = path.resolve("tests2/fixtures/graphify-contract-fixture/graphify_fixture.py");

type FixtureProbe = { modulePath: string; callable: string; signature: string[] };
type FixtureResult = { graphPath: string; nodes: number; edges: number; sourcePaths: string[] };
type GuardTelemetry = { compatibilityCalls: number; linkedWorktreeGuardCalls: number };

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function python<T>(cwd: string, command: "probe" | "invoke", payload?: unknown): T {
	return JSON.parse(execFileSync("python3", [fixtureProgram, command], {
		cwd,
		encoding: "utf8",
		input: payload === undefined ? undefined : JSON.stringify(payload),
		windowsHide: true,
	})) as T;
}

function pythonFailure(cwd: string, payload: unknown): { status: number | null; stderr: string } {
	const result = spawnSync("python3", [fixtureProgram, "invoke"], {
		cwd,
		encoding: "utf8",
		input: JSON.stringify(payload),
		windowsHide: true,
	});
	return { status: result.status, stderr: result.stderr };
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

function checkoutManifest(root: string, directory = root): Record<string, string> {
	const files: Record<string, string> = {};
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === ".git") continue;
		const absolute = path.join(directory, entry.name);
		if (entry.isDirectory()) Object.assign(files, checkoutManifest(root, absolute));
		else if (entry.isFile()) files[path.relative(root, absolute)] = createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
	}
	return files;
}

function telemetry(file: string): GuardTelemetry {
	return JSON.parse(fs.readFileSync(file, "utf8")) as GuardTelemetry;
}

test.describe.configure({ mode: "serial" });

test("GraphifyDeltaAdapter spawns the contract fixture from a real linked worktree without reaching its guard", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-graphify-worktree-"));
	const primary = path.join(root, "primary");
	const linked = path.join(root, "linked");
	const hostState = path.join(root, "host-state");
	const telemetryPath = path.join(hostState, "telemetry.json");
	let publicDeltaCalls = 0;
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

		// A real linked worktree starts byte-identical to its primary checkout.
		expect(checkoutManifest(linked)).toEqual(checkoutManifest(primary));
		fs.writeFileSync(path.join(linked, "src", "child.ts"), "export const child = () => 'linked';\n");
		git(linked, "add", ".");
		git(linked, "commit", "--quiet", "-m", "child delta");

		const request: GraphifyDeltaRequest = {
			cwd: linked,
			candidateRoot: path.join(hostState, "graphs"),
			scanRoots: ["src", "tests2", "defaults"],
			changedPaths: ["src/child.ts"],
			noCluster: true,
		};

		// Prove this is live guard telemetry rather than a fixture constant.
		fs.mkdirSync(path.dirname(telemetryPath), { recursive: true });
		fs.writeFileSync(telemetryPath, JSON.stringify({ compatibilityCalls: 0, linkedWorktreeGuardCalls: 0 }));
		const blockedByLiveGuard = pythonFailure(linked, {
			telemetryPath,
			request: { ...request, candidateRoot: path.join(linked, "graphify-out") },
		});
		expect(blockedByLiveGuard).toMatchObject({ status: 2, stderr: expect.stringMatching(/linked-worktree guard invoked/) });
		expect(telemetry(telemetryPath)).toMatchObject({ linkedWorktreeGuardCalls: 1 });

		fs.writeFileSync(telemetryPath, JSON.stringify({ compatibilityCalls: 0, linkedWorktreeGuardCalls: 0 }));
		const execution: GraphifyDeltaExecution = {
			async probePublicDelta() { return null; },
			async invokePublicDelta() { publicDeltaCalls++; throw new Error("public Graphify delta is unavailable in the contract fixture"); },
			async probeCompatibility() { return python<FixtureProbe>(linked, "probe"); },
			async invokeCompatibility(_spec, deltaRequest) {
				return python<FixtureResult>(deltaRequest.cwd, "invoke", { telemetryPath, request: deltaRequest });
			},
		};
		const adapter = new GraphifyDeltaAdapter("0.0.0", execution, [rebuildCodeCompatibility("0.0.0", ["root", "changed_paths"])]);
		const result = await adapter.invokeDelta(request);
		const adapterReport = {
			invocation: "GraphifyDeltaAdapter -> spawned Python contract fixture",
			compatibility: result.compatibility,
			linkedWorktreeGuardCalls: telemetry(telemetryPath).linkedWorktreeGuardCalls,
		};
		fs.writeFileSync(path.join(hostState, "adapter-report.json"), JSON.stringify(adapterReport, null, 2));

		expect(result.graphPath.startsWith(`${hostState}${path.sep}`)).toBe(true);
		expect(result.sourcePaths).toEqual(["defaults/config.ts", "src/child.ts", "src/entry.ts", "src/parent.ts", "tests2/entry.test.ts"]);
		expect(result.compatibility).toMatchObject({ kind: "compatibility", id: "graphify.watch._rebuild_code", resolvedVersion: "0.0.0" });
		expect(publicDeltaCalls).toBe(0);
		expect(telemetry(telemetryPath)).toEqual({ compatibilityCalls: 1, linkedWorktreeGuardCalls: 0 });
		expect(JSON.parse(fs.readFileSync(path.join(hostState, "adapter-report.json"), "utf8"))).toMatchObject({ linkedWorktreeGuardCalls: 0 });
		for (const checkout of [primary, linked]) {
			expect(fs.existsSync(path.join(checkout, "graphify-out"))).toBe(false);
			expect(fs.existsSync(path.join(checkout, ".graphify_root"))).toBe(false);
			expect(fs.existsSync(path.join(checkout, "graphify-cache"))).toBe(false);
		}
		expect(git(linked, "status", "--porcelain")).toBe("");
	} finally {
		try { git(primary, "worktree", "remove", "--force", linked); } catch { /* cleanup after a failed git setup */ }
		fs.rmSync(root, { recursive: true, force: true });
	}
});
