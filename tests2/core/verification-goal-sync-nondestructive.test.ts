// Tier-1 decision coverage for non-destructive pre-verification goal sync.
// Git topology is injected through CommandRunner; no repository subprocesses run.

import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";

import { VerificationHarness } from "../../src/server/agent/verification-harness.js";
import type { CommandRunner } from "../../src/server/gateway-deps.ts";

const GOAL_BRANCH = "goal/nondestructive-sync";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

type Topology = "equal" | "local-ahead" | "local-behind" | "diverged";

class GitTopologyRunner implements CommandRunner {
	readonly calls: string[][] = [];
	currentHead: string;
	readonly originHead: string;

	constructor(readonly topology: Topology) {
		this.currentHead = topology === "local-ahead" || topology === "diverged" ? SHA_B : SHA_A;
		this.originHead = topology === "local-behind" || topology === "diverged" ? SHA_C : SHA_A;
	}

	async execFile(_file: string, args: readonly string[]) {
		this.calls.push([...args]);
		if (args[0] === "remote" && args[1] === "get-url") return { stdout: "https://example.test/repo.git\n", stderr: "" };
		if (args[0] === "ls-remote") return { stdout: `${this.originHead}\trefs/heads/${GOAL_BRANCH}\n`, stderr: "" };
		if (args[0] === "fetch") return { stdout: "", stderr: "" };
		if (args[0] === "symbolic-ref") return { stdout: "refs/remotes/origin/master\n", stderr: "" };
		if (args[0] === "rev-parse") return { stdout: `${this.currentHead}\n`, stderr: "" };
		if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
			const originIsAncestor = this.topology === "equal" || this.topology === "local-ahead";
			const localIsAncestor = this.topology === "equal" || this.topology === "local-behind";
			const passes = args[2]?.startsWith("origin/") ? originIsAncestor : localIsAncestor;
			if (!passes) throw Object.assign(new Error("not an ancestor"), { code: 1 });
			return { stdout: "", stderr: "" };
		}
		if (args[0] === "reset" && args[1] === "--hard") {
			this.currentHead = this.originHead;
			return { stdout: `HEAD is now at ${this.originHead}\n`, stderr: "" };
		}
		throw new Error(`unexpected git command: ${args.join(" ")}`);
	}
}

function makeProjectConfigStore() {
	return {
		get: (key: string) => key === "base_ref" ? "origin/master" : "",
		getWithDefaults: () => ({
			build_command: "npm run build",
			test_command: "npm test",
			typecheck_command: "npm run check",
			test_unit_command: "npm run test:unit",
			test_e2e_command: "npm run test:e2e",
			base_ref: "origin/master",
		}),
		getComponents: () => [],
	};
}

function makeHarness(topology: Topology) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "verif-sync-unit-"));
	const stateDir = path.join(root, "state");
	fs.mkdirSync(stateDir, { recursive: true });
	const runner = new GitTopologyRunner(topology);
	const signal = {
		id: `signal-${topology}`,
		goalId: "goal-nondestructive-sync",
		gateId: "implementation",
		sessionId: "session-nondestructive-sync",
		timestamp: Date.now(),
		commitSha: runner.currentHead,
		content: "ready",
		metadata: {},
	};
	const gateState: any = { goalId: signal.goalId, gateId: signal.gateId, status: "pending", signals: [signal] };
	const gateStore = {
		getGate: () => gateState,
		getGatesForGoal: () => [gateState],
		updateSignalVerification: (signalId: string, verification: any) => {
			const target = gateState.signals.find((entry: any) => entry.id === signalId);
			if (target) target.verification = verification;
		},
		updateGateStatus: (_goalId: string, _gateId: string, status: string) => { gateState.status = status; },
	};
	const projectConfigStore = makeProjectConfigStore();
	const goal = { id: signal.goalId, branch: GOAL_BRANCH, cwd: root, worktreePath: root, spec: "Non-destructive sync", state: "in-progress", workflowId: "feature" };
	const projectContextManager = {
		getContextForGoal: (goalId: string) => goalId === signal.goalId ? {
			project: { id: "project-sync" },
			goalStore: { get: (id: string) => id === signal.goalId ? goal : undefined },
			gateStore,
			projectConfigStore,
		} : null,
	};
	const harness = new VerificationHarness(
		stateDir,
		undefined,
		() => {},
		{ get: () => null, getAll: () => [] } as any,
		undefined,
		undefined,
		undefined,
		projectConfigStore as any,
		projectContextManager as any,
		undefined,
		{ commandRunner: runner },
	);
	(harness as any).runCommandStep = async (command: string) => ({ passed: true, output: `executed ${command}` });
	return { root, harness, runner, signal, gateState };
}

const GATE_DEF = {
	id: "implementation",
	name: "Implementation",
	dependsOn: [],
	verify: [{ name: "Trivial verify step", type: "command", run: "echo nondestructive-sync-check" }],
} as any;

async function run(topology: Topology) {
	const fixture = makeHarness(topology);
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: any[]) => warnings.push(args.map(arg => typeof arg === "string" ? arg : inspect(arg)).join(" "));
	try {
		await fixture.harness.verifyGateSignal(fixture.signal as any, GATE_DEF, fixture.root, GOAL_BRANCH, "master", new Map(), "Non-destructive goal sync");
		return { ...fixture, warnings: warnings.join("\n") };
	} catch (error) {
		fs.rmSync(fixture.root, { recursive: true, force: true });
		throw error;
	} finally {
		console.warn = originalWarn;
	}
}

function cleanup(root: string): void {
	fs.rmSync(root, { recursive: true, force: true });
}

test("local-ahead goal worktree keeps the un-pushed local commit", async () => {
	const result = await run("local-ahead");
	try {
		assert.equal(result.runner.currentHead, SHA_B);
		assert.equal(result.runner.calls.some(args => args[0] === "reset"), false);
	} finally { cleanup(result.root); }
});

test("local-behind goal worktree fast-forwards HEAD to origin", async () => {
	const result = await run("local-behind");
	try {
		assert.equal(result.runner.currentHead, SHA_C);
		assert.equal(result.runner.calls.some(args => args[0] === "reset" && args[1] === "--hard"), true);
		assert.doesNotMatch(result.warnings, /diverged|Failed to sync worktree/i);
	} finally { cleanup(result.root); }
});

test("diverged goal worktree keeps local commit and surfaces a warning", async () => {
	const result = await run("diverged");
	try {
		assert.equal(result.runner.currentHead, SHA_B);
		assert.equal(result.runner.calls.some(args => args[0] === "reset"), false);
		assert.match(result.warnings, /diverged/i);
	} finally { cleanup(result.root); }
});

test("local-behind fast-forward uses reset --hard and never merge hooks", async () => {
	const result = await run("local-behind");
	try {
		assert.equal(result.runner.calls.some(args => args[0] === "reset" && args[1] === "--hard"), true);
		assert.equal(result.runner.calls.some(args => args[0] === "merge"), false);
	} finally { cleanup(result.root); }
});

test("up-to-date goal worktree leaves HEAD unchanged", async () => {
	const result = await run("equal");
	try {
		assert.equal(result.runner.currentHead, SHA_A);
		assert.equal(result.runner.calls.some(args => args[0] === "reset"), false);
		assert.doesNotMatch(result.warnings, /diverged|Failed to sync worktree/i);
	} finally { cleanup(result.root); }
});
