// Tier-1 durable restart decision coverage. All process outcomes are authored
// through durable files or the command-step runner seam; no OS child is spawned.

import { afterAll, test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeTmpDir } from "../../tests/helpers/tmp.ts";
import { VerificationHarness, type ActiveVerification } from "../../src/server/agent/verification-harness.js";
import { createFakeVerificationCommandRunner } from "../harness/fake-verification-command-runner.js";

const GOAL_ID = "goal-restart-safe-command-lifecycle";
const GATE_ID = "implementation";
const MARKER = "RESTART_SAFE_COMMAND_LIFECYCLE";
const ROLE_STORE_ADAPTER = Object.freeze({ get: () => undefined, getAll: () => [] });
const COMMAND_STEP_TEMPLATE = Object.freeze({ type: "command", status: "running", phase: 0, timeoutSec: 10 });
const ACTIVE_VERIFICATION_TEMPLATE = Object.freeze({ goalId: GOAL_ID, gateId: GATE_ID, overallStatus: "running", currentPhase: 0 });

type GateStoreCall =
	| { kind: "updateSignalVerification"; signalId: string; update: any }
	| { kind: "updateGateStatus"; goalId: string; gateId: string; status: string };

let lifecycleSequence = 0;
const suiteRoot = makeTmpDir("verif-command-lifecycle-unit-");

afterAll(() => {
	fs.rmSync(suiteRoot, { recursive: true, force: true });
});

function makeLifecycleStateDir(): string {
	const stateDir = path.join(suiteRoot, String(++lifecycleSequence).padStart(2, "0"), "state");
	fs.mkdirSync(stateDir, { recursive: true });
	return stateDir;
}

function makeHarnessForStateDir(stateDir = makeLifecycleStateDir()) {
	const gateStoreCalls: GateStoreCall[] = [];
	const broadcasts: Array<{ goalId: string; event: any }> = [];
	const notifications: Array<{ goalId: string; message: string }> = [];
	const gateStore = {
		updateSignalVerification: (signalId: string, update: any) => gateStoreCalls.push({ kind: "updateSignalVerification", signalId, update }),
		updateGateStatus: (goalId: string, gateId: string, status: string) => gateStoreCalls.push({ kind: "updateGateStatus", goalId, gateId, status }),
		getGate: () => undefined,
		getGatesForGoal: () => [],
	} as any;
	const harness = new VerificationHarness(
		stateDir,
		gateStore,
		(goalId, event) => broadcasts.push({ goalId, event }),
		ROLE_STORE_ADAPTER as any,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{
			commandRunner: { execFile: async () => ({ stdout: "", stderr: "" }) },
			commandStepRunner: createFakeVerificationCommandRunner(),
		},
	);
	harness.setTeamLeadNotifier((goalId, message) => notifications.push({ goalId, message }));
	return { stateDir, harness, gateStoreCalls, broadcasts, notifications };
}

function persistActive(stateDir: string, verification: ActiveVerification | any): void {
	fs.writeFileSync(path.join(stateDir, "active-verifications.json"), JSON.stringify({ verifications: [verification] }, null, 2));
}

function latestSignalUpdate(calls: GateStoreCall[]): any {
	return [...calls].reverse().find((call): call is Extract<GateStoreCall, { kind: "updateSignalVerification" }> => call.kind === "updateSignalVerification")?.update;
}

function latestGateStatus(calls: GateStoreCall[]): string | undefined {
	return [...calls].reverse().find((call): call is Extract<GateStoreCall, { kind: "updateGateStatus" }> => call.kind === "updateGateStatus")?.status;
}

function stepByName(update: any, name: string): any {
	return update?.steps?.find((step: any) => step.name === name);
}

function notificationText(notifications: Array<{ message: string }>): string {
	return notifications.map(entry => entry.message).join("\n---\n");
}

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(res => { resolve = res; });
	return { promise, resolve };
}

function writeFixtureFiles(root: string, files: Readonly<Record<string, string>>): void {
	fs.mkdirSync(root, { recursive: true });
	for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
}

function diagnosticFixture(stateDir: string, signalId: string, contents: { out?: string; err?: string; exit?: string } = {}) {
	const diagDir = path.join(stateDir, "verifications", signalId);
	const files: Record<string, string> = {};
	if (contents.out !== undefined) files["stdout.log"] = contents.out;
	if (contents.err !== undefined) files["stderr.log"] = contents.err;
	if (contents.exit !== undefined) files["exit.txt"] = contents.exit;
	writeFixtureFiles(diagDir, files);
	return {
		outFile: path.join(diagDir, "stdout.log"),
		errFile: path.join(diagDir, "stderr.log"),
		exitFile: path.join(diagDir, "exit.txt"),
	};
}

function commandStepFixture(args: { name: string; startedAt: number; timeoutSec?: number; outFile?: string; errFile?: string; exitFile?: string; containerId?: string; pid?: number; pidFile?: string; heartbeatFile?: string; nonce?: string }): any {
	return {
		...COMMAND_STEP_TEMPLATE,
		...args,
		startTimeMs: args.startedAt,
		commandCwd: path.dirname(args.outFile ?? args.errFile ?? args.exitFile ?? args.pidFile ?? process.cwd()),
	};
}

function writeIdentityEvidence(root: string, pid: number, nonce: string): { pidFile: string; heartbeatFile: string } {
	fs.mkdirSync(root, { recursive: true });
	const pidFile = path.join(root, "process.pid");
	const heartbeatFile = path.join(root, "heartbeat.json");
	fs.writeFileSync(pidFile, `${pid}\n${nonce}\n`);
	fs.writeFileSync(heartbeatFile, `${JSON.stringify({ pid, nonce, ts: Math.floor(Date.now() / 1000) })}\n`);
	return { pidFile, heartbeatFile };
}

function withPidReportedAlive<T>(pid: number, fn: () => T): T {
	const originalKill = process.kill;
	process.kill = ((candidate: number, signal?: NodeJS.Signals | number) => candidate === pid ? true : originalKill(candidate, signal as any)) as typeof process.kill;
	try { return fn(); }
	finally { process.kill = originalKill; }
}

function activeVerification(signalId: string, steps: any[], startedAt = Date.now()): ActiveVerification | any {
	return { ...ACTIVE_VERIFICATION_TEMPLATE, signalId, startedAt, steps };
}

test("persisted identity accepts a matching nonce with a fresh heartbeat", () => {
	const { stateDir, harness } = makeHarnessForStateDir();
	const pid = 424_242;
	const nonce = "matching-nonce";
	const identity = writeIdentityEvidence(path.join(stateDir, "identity-match"), pid, nonce);
	const step = commandStepFixture({ name: "Matching identity", startedAt: Date.now(), pid, nonce, ...identity });
	const result = withPidReportedAlive(pid, () => (harness as any)._verifyPersistedCommandIdentity(step));
	assert.equal(result.verified, true);
	assert.equal(result.pid, pid);
});

test("persisted identity rejects a mismatched nonce without authorizing a kill", () => {
	const { stateDir, harness } = makeHarnessForStateDir();
	const pid = 424_243;
	const identity = writeIdentityEvidence(path.join(stateDir, "identity-mismatch"), pid, "foreign-nonce");
	const step = commandStepFixture({ name: "Foreign identity", startedAt: Date.now(), pid, nonce: "expected-nonce", ...identity });
	const result = withPidReportedAlive(pid, () => (harness as any)._verifyPersistedCommandIdentity(step));
	assert.equal(result.verified, false);
	assert.match(result.reason, /nonce|identity/i);
});

test("persisted identity rejects stale heartbeat evidence", () => {
	const { stateDir, harness } = makeHarnessForStateDir();
	const pid = 424_244;
	const nonce = "stale-nonce";
	const identity = writeIdentityEvidence(path.join(stateDir, "identity-stale"), pid, nonce);
	const old = new Date(Date.now() - 30_000);
	fs.utimesSync(identity.pidFile, old, old);
	fs.utimesSync(identity.heartbeatFile, old, old);
	const step = commandStepFixture({ name: "Stale identity", startedAt: Date.now() - 30_000, pid, nonce, ...identity });
	const result = withPidReportedAlive(pid, () => (harness as any)._verifyPersistedCommandIdentity(step));
	assert.equal(result.verified, false);
	assert.match(result.reason, /heartbeat|stale|identity/i);
});

test("resume finalizes a successful command from authored durable exit and output files", async () => {
	const { stateDir, harness, gateStoreCalls } = makeHarnessForStateDir();
	const startedAt = Date.now() - 100;
	const files = diagnosticFixture(stateDir, "sig-success", { out: "before restart\nafter restart\n", err: "", exit: "0\n" });
	persistActive(stateDir, activeVerification("sig-success", [commandStepFixture({ name: "Recovered command", startedAt, ...files })], startedAt));

	await harness.resumeInterruptedVerifications();
	const step = stepByName(latestSignalUpdate(gateStoreCalls), "Recovered command");
	assert.equal(latestGateStatus(gateStoreCalls), "passed");
	assert.equal(step?.status, "passed");
	assert.match(step?.output ?? "", /after restart/);
	assert.equal(fs.existsSync(path.join(stateDir, "active-verifications.json")), false);
});

test("resume preserves a real durable non-zero command verdict", async () => {
	const { stateDir, harness, gateStoreCalls, notifications } = makeHarnessForStateDir();
	const startedAt = Date.now() - 100;
	const files = diagnosticFixture(stateDir, "sig-failure", { out: "assertion failed after restart\n", err: "", exit: "7\n" });
	persistActive(stateDir, activeVerification("sig-failure", [commandStepFixture({ name: "Real failed command", startedAt, ...files })], startedAt));

	await harness.resumeInterruptedVerifications();
	const step = stepByName(latestSignalUpdate(gateStoreCalls), "Real failed command");
	assert.equal(latestGateStatus(gateStoreCalls), "failed");
	assert.equal(step?.status, "failed");
	assert.match(notificationText(notifications), /step="Real failed command"/);
});

test("no durable verdict remains restart-interrupted and pending", async () => {
	const { stateDir, harness, gateStoreCalls, notifications } = makeHarnessForStateDir();
	const startedAt = Date.now() - 100;
	const files = diagnosticFixture(stateDir, "sig-no-verdict", { out: "probe started\n", err: "" });
	persistActive(stateDir, activeVerification("sig-no-verdict", [commandStepFixture({ name: "No verdict", startedAt, ...files })], startedAt));

	await harness.resumeInterruptedVerifications();
	const step = stepByName(latestSignalUpdate(gateStoreCalls), "No verdict");
	assert.equal(latestGateStatus(gateStoreCalls), "pending");
	assert.equal(step?.status, "waiting");
	assert.match(step?.output ?? "", /no command verdict|re-signal|durable command exit status/i);
	assert.doesNotMatch(notificationText(notifications), /step="No verdict"/);
});

test("mixed durable failure and interruption notifies only the failed step", async () => {
	const { stateDir, harness, gateStoreCalls, notifications } = makeHarnessForStateDir();
	const startedAt = Date.now() - 100;
	const failed = diagnosticFixture(stateDir, "sig-mixed", { out: "real failure\n", err: "", exit: "7\n" });
	persistActive(stateDir, activeVerification("sig-mixed", [
		commandStepFixture({ name: "Real failed command", startedAt, ...failed }),
		commandStepFixture({ name: "No verdict sibling", startedAt }),
	], startedAt));

	await harness.resumeInterruptedVerifications();
	const update = latestSignalUpdate(gateStoreCalls);
	assert.equal(stepByName(update, "Real failed command")?.status, "failed");
	assert.equal(stepByName(update, "No verdict sibling")?.status, "waiting");
	const notices = notificationText(notifications);
	assert.match(notices, /step="Real failed command"/);
	assert.doesNotMatch(notices, /step="No verdict sibling"/);
});

test("attached or container recovery stays retryable with clear diagnostics", async () => {
	const { stateDir, harness, gateStoreCalls } = makeHarnessForStateDir();
	const startedAt = Date.now() - 100;
	persistActive(stateDir, activeVerification("sig-attached", [commandStepFixture({ name: "Container attached command", startedAt, containerId: "container-under-test" })], startedAt));

	await harness.resumeInterruptedVerifications();
	const step = stepByName(latestSignalUpdate(gateStoreCalls), "Container attached command");
	assert.equal(latestGateStatus(gateStoreCalls), "pending");
	assert.notEqual(step?.status, "failed");
	assert.match(step?.output ?? "", /container|attached|unsupported/i);
	assert.match(step?.output ?? "", /re-signal|retry|pending|no command verdict/i);
});

test("resume reads bounded tails instead of whole retained logs", async () => {
	const { stateDir, harness, gateStoreCalls } = makeHarnessForStateDir();
	const startedAt = Date.now() - 100;
	const files = diagnosticFixture(stateDir, "sig-large", {
		out: `HEAD_STDOUT_SENTINEL\n${"x".repeat(1_200_000)}\nTAIL_STDOUT_SENTINEL\n`,
		err: "STDERR_TAIL_SENTINEL\n",
		exit: "7\n",
	});
	persistActive(stateDir, activeVerification("sig-large", [commandStepFixture({ name: "Large retained output", startedAt, ...files })], startedAt));

	await harness.resumeInterruptedVerifications();
	const output = stepByName(latestSignalUpdate(gateStoreCalls), "Large retained output")?.output ?? "";
	assert.match(output, /TAIL_STDOUT_SENTINEL/);
	assert.match(output, /STDERR_TAIL_SENTINEL/);
	assert.doesNotMatch(output, /HEAD_STDOUT_SENTINEL/);
	assert.ok(output.length <= 6_000, `${MARKER}: expected bounded output, got ${output.length}`);
});

test("recovered command success delegates remaining waiting phases", async () => {
	const { harness, gateStoreCalls } = makeHarnessForStateDir();
	const startedAt = Date.now() - 100;
	const verification = activeVerification("sig-continue", [
		{ name: "Recovered command", type: "command", status: "running", phase: 0, startedAt, exitFile: "authored" },
		{ name: "Downstream review", type: "llm-review", status: "waiting", phase: 1, startedAt },
	], startedAt);
	(harness as any).activeVerifications.set(verification.signalId, verification);
	(harness as any)._resumeCommandStep = async () => ({ name: "Recovered command", type: "command", passed: true, output: "recovered", duration_ms: 1 });
	let continued = false;
	(harness as any)._continueResumeWithRemainingPhases = async (active: any) => {
		continued = true;
		assert.equal(active.steps[0].status, "passed");
		assert.equal(active.steps[1].status, "waiting");
		return true;
	};

	await (harness as any)._resumeOneVerification(verification);
	assert.equal(continued, true);
	assert.equal(gateStoreCalls.length, 0);
});

test("cancelled or superseded resume cannot update gate state after cancellation", async () => {
	const { harness, gateStoreCalls, broadcasts, notifications } = makeHarnessForStateDir();
	const startedAt = Date.now();
	const verification = activeVerification("sig-stale", [commandStepFixture({ name: "Slow resumed command", startedAt })], startedAt);
	(harness as any).activeVerifications.set(verification.signalId, verification);
	const resumeStarted = deferred<void>();
	const allowFinish = deferred<void>();
	(harness as any)._resumeCommandStep = async () => {
		resumeStarted.resolve();
		await allowFinish.promise;
		return { name: "Slow resumed command", type: "command", passed: true, output: "stale pass", duration_ms: 1 };
	};

	const resumePromise = (harness as any)._resumeOneVerification(verification);
	await resumeStarted.promise;
	await harness.cancelStaleVerificationsForGates(GOAL_ID, [GATE_ID]);
	const counts = [gateStoreCalls.length, broadcasts.length, notifications.length];
	allowFinish.resolve();
	await resumePromise;
	assert.deepEqual([gateStoreCalls.length, broadcasts.length, notifications.length], counts);
});

test("normal verification keeps recovered phases and executes only downstream through the fake runner", async () => {
	const { stateDir, harness, gateStoreCalls } = makeHarnessForStateDir();
	const workDir = path.join(stateDir, "work");
	fs.mkdirSync(workDir, { recursive: true });
	const signal = { id: "sig-downstream", goalId: GOAL_ID, gateId: GATE_ID, sessionId: "session", timestamp: Date.now(), commitSha: "HEAD", verification: { status: "running", steps: [] } } as any;
	const startedAt = Date.now() - 100;
	const active = activeVerification(signal.id, [
		{ name: "Recovered phase", type: "command", status: "passed", phase: 0, startedAt, durationMs: 12, output: "recovered-success" },
		{ name: "Downstream command", type: "command", status: "waiting", phase: 1, startedAt },
	], startedAt);
	(harness as any).activeVerifications.set(signal.id, active);
	(harness as any)._persistActive();
	const gate = {
		id: GATE_ID,
		name: "Implementation",
		dependsOn: [],
		verify: [
			{ name: "Recovered phase", type: "command", phase: 0, run: "echo should-not-rerun" },
			{ name: "Downstream command", type: "command", phase: 1, run: "echo downstream-ran" },
		],
	} as any;

	await harness.verifyGateSignal(signal, gate, workDir);
	const update = latestSignalUpdate(gateStoreCalls);
	assert.equal(latestGateStatus(gateStoreCalls), "passed");
	assert.equal(stepByName(update, "Recovered phase")?.output, "recovered-success");
	assert.equal(stepByName(update, "Downstream command")?.status, "passed");
	assert.match(stepByName(update, "Downstream command")?.output ?? "", /downstream-ran/);
});
