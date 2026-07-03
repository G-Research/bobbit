import { spawn, type ChildProcess } from "node:child_process";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeTmpDir } from "./helpers/tmp.ts";
import { VerificationHarness, type ActiveVerification } from "../src/server/agent/verification-harness.js";

const GOAL_ID = "goal-restart-safe-command-lifecycle";
const GATE_ID = "implementation";
const MARKER = "RESTART_SAFE_COMMAND_LIFECYCLE";

type GateStoreCall =
	| { kind: "updateSignalVerification"; signalId: string; update: any }
	| { kind: "updateGateStatus"; goalId: string; gateId: string; status: string };

function makeHarness(t: TestContext) {
	const root = makeTmpDir("verif-command-lifecycle-");
	const stateDir = path.join(root, "state");
	fs.mkdirSync(stateDir, { recursive: true });
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	const gateStoreCalls: GateStoreCall[] = [];
	const broadcasts: Array<{ goalId: string; event: any }> = [];
	const notifications: Array<{ goalId: string; message: string }> = [];
	const gateStore = {
		updateSignalVerification: (signalId: string, update: any) => {
			gateStoreCalls.push({ kind: "updateSignalVerification", signalId, update });
		},
		updateGateStatus: (goalId: string, gateId: string, status: string) => {
			gateStoreCalls.push({ kind: "updateGateStatus", goalId, gateId, status });
		},
		getGate: () => undefined,
	} as any;
	const roleStore = { get: () => undefined, getAll: () => [] } as any;

	const harness = new VerificationHarness(
		stateDir,
		gateStore,
		(goalId, event) => broadcasts.push({ goalId, event }),
		roleStore,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
	);
	harness.setTeamLeadNotifier((goalId, message) => notifications.push({ goalId, message }));

	return { stateDir, harness, gateStoreCalls, broadcasts, notifications };
}

function persistActive(stateDir: string, verification: ActiveVerification | any): void {
	fs.writeFileSync(
		path.join(stateDir, "active-verifications.json"),
		JSON.stringify({ verifications: [verification] }, null, 2),
	);
}

function latestSignalUpdate(calls: GateStoreCall[]): any {
	return [...calls]
		.reverse()
		.find((call): call is Extract<GateStoreCall, { kind: "updateSignalVerification" }> => call.kind === "updateSignalVerification")
		?.update;
}

function latestGateStatus(calls: GateStoreCall[]): string | undefined {
	return [...calls]
		.reverse()
		.find((call): call is Extract<GateStoreCall, { kind: "updateGateStatus" }> => call.kind === "updateGateStatus")
		?.status;
}

function stepByName(update: any, name: string): any {
	return update?.steps?.find((step: any) => step.name === name);
}

function notificationText(notifications: Array<{ message: string }>): string {
	return notifications.map(n => n.message).join("\n---\n");
}

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: any) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function spawnNode(script: string): ChildProcess & { pid: number } {
	const child = spawn(process.execPath, ["-e", script], {
		stdio: "ignore",
		windowsHide: true,
	}) as ChildProcess & { pid?: number };
	assert.ok(child.pid, `${MARKER}: failed to start child process for lifecycle test`);
	return child as ChildProcess & { pid: number };
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.off("exit", onExit);
			resolve(false);
		}, timeoutMs);
		const onExit = () => {
			clearTimeout(timer);
			resolve(true);
		};
		child.once("exit", onExit);
	});
}

async function cleanupChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	try { child.kill("SIGKILL"); } catch { /* already gone */ }
	await waitForExit(child, 1_000);
}

function writeIdentityFile(file: string, pid: number, nonce: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${pid}\n${nonce}\n`);
}

function commandStepFixture(args: {
	name: string;
	startedAt: number;
	pid?: number;
	timeoutSec?: number;
	outFile?: string;
	errFile?: string;
	exitFile?: string;
	identityFile?: string;
	nonce?: string;
	containerId?: string;
}): any {
	return {
		name: args.name,
		type: "command",
		status: "running",
		phase: 0,
		startedAt: args.startedAt,
		startTimeMs: args.startedAt,
		pid: args.pid,
		timeoutSec: args.timeoutSec ?? 10,
		outFile: args.outFile,
		errFile: args.errFile,
		exitFile: args.exitFile,
		commandCwd: path.dirname(args.outFile ?? args.errFile ?? args.exitFile ?? args.identityFile ?? process.cwd()),
		// Proposed persistent-command identity fields, mirroring bash_bg's pidfile+nonce contract.
		pidFile: args.identityFile,
		nonce: args.nonce,
		containerId: args.containerId,
	};
}

function activeVerification(signalId: string, steps: any[], startedAt = Date.now()): ActiveVerification | any {
	return {
		goalId: GOAL_ID,
		gateId: GATE_ID,
		signalId,
		overallStatus: "running",
		startedAt,
		currentPhase: 0,
		steps,
	};
}

test("resume does not trust or kill an alive PID when the pidfile identity does not match", async (t) => {
	const { stateDir, harness, gateStoreCalls } = makeHarness(t);
	const child = spawnNode("setTimeout(() => {}, 30000)");
	try {
		const startedAt = Date.now();
		const pidFile = path.join(stateDir, "identity", "foreign.pid");
		writeIdentityFile(pidFile, child.pid, "foreign-nonce");

		persistActive(stateDir, activeVerification("sig-foreign-pid", [commandStepFixture({
			name: "Foreign PID",
			startedAt,
			pid: child.pid,
			timeoutSec: 0.2,
			identityFile: pidFile,
			nonce: "expected-nonce",
		})], startedAt));

		await harness.resumeInterruptedVerifications();
		const exited = await waitForExit(child, 250);
		const update = latestSignalUpdate(gateStoreCalls);
		const step = stepByName(update, "Foreign PID");

		assert.equal(
			exited,
			false,
			`${MARKER}: resume must not kill an unrelated live process when the persisted pidfile/nonce does not prove identity.`,
		);
		assert.notEqual(
			latestGateStatus(gateStoreCalls),
			"failed",
			`${MARKER}: an unverified PID after restart should leave the gate retryable/pending, not failed as a command verdict.`,
		);
		assert.notEqual(
			step?.status,
			"failed",
			`${MARKER}: an unverified PID should not be persisted as a failed command step.`,
		);
	} finally {
		await cleanupChild(child);
	}
});

test("alive resumed command that dies without durable status remains restart-interrupted and pending", async (t) => {
	const { stateDir, harness, gateStoreCalls, notifications } = makeHarness(t);
	const child = spawnNode("setTimeout(() => process.exit(0), 80)");
	try {
		const startedAt = Date.now();
		const diagDir = path.join(stateDir, "verifications", "sig-dies-without-status");
		fs.mkdirSync(diagDir, { recursive: true });
		const outFile = path.join(diagDir, "stdout.log");
		const errFile = path.join(diagDir, "stderr.log");
		const exitFile = path.join(diagDir, "exit.txt");
		const pidFile = path.join(diagDir, "process.pid");
		fs.writeFileSync(outFile, "probe:started\n");
		fs.writeFileSync(errFile, "");
		writeIdentityFile(pidFile, child.pid, "matching-nonce");

		persistActive(stateDir, activeVerification("sig-dies-without-status", [commandStepFixture({
			name: "Dies without status",
			startedAt,
			pid: child.pid,
			timeoutSec: 2,
			outFile,
			errFile,
			exitFile,
			identityFile: pidFile,
			nonce: "matching-nonce",
		})], startedAt));

		await harness.resumeInterruptedVerifications();
		const update = latestSignalUpdate(gateStoreCalls);
		const step = stepByName(update, "Dies without status");
		const notices = notificationText(notifications);

		assert.equal(
			latestGateStatus(gateStoreCalls),
			"pending",
			`${MARKER}: a command that died after restart without a durable exit/status file should leave the gate pending for re-signal.`,
		);
		assert.equal(
			step?.status,
			"waiting",
			`${MARKER}: no durable command verdict should be represented as restart-interrupted/waiting, not failed.`,
		);
		assert.match(
			step?.output ?? "",
			/no command verdict was obtained|durable command exit status|re-signal/i,
			`${MARKER}: retryable interruption diagnostics should say no command verdict was obtained.`,
		);
		assert.doesNotMatch(
			`${step?.output ?? ""}\n${notices}`,
			/did not produce an exit code \(timeout or process died after restart\)/i,
			`${MARKER}: a post-restart no-status death must not be labelled as a failed command verdict.`,
		);
	} finally {
		await cleanupChild(child);
	}
});

test("timeout after restart kills a process only when matching identity is verified", async (t) => {
	const { stateDir, harness, gateStoreCalls } = makeHarness(t);
	const child = spawnNode("setTimeout(() => {}, 30000)");
	try {
		const startedAt = Date.now() - 2_000;
		const diagDir = path.join(stateDir, "verifications", "sig-timeout-verified");
		fs.mkdirSync(diagDir, { recursive: true });
		const outFile = path.join(diagDir, "stdout.log");
		const errFile = path.join(diagDir, "stderr.log");
		const exitFile = path.join(diagDir, "exit.txt");
		const pidFile = path.join(diagDir, "process.pid");
		fs.writeFileSync(outFile, "probe:still-running-after-deadline\n");
		fs.writeFileSync(errFile, "");
		writeIdentityFile(pidFile, child.pid, "verified-nonce");

		persistActive(stateDir, activeVerification("sig-timeout-verified", [commandStepFixture({
			name: "Verified timeout",
			startedAt,
			pid: child.pid,
			timeoutSec: 1,
			outFile,
			errFile,
			exitFile,
			identityFile: pidFile,
			nonce: "verified-nonce",
		})], startedAt));

		await harness.resumeInterruptedVerifications();
		const exited = await waitForExit(child, 1_000);
		const update = latestSignalUpdate(gateStoreCalls);
		const step = stepByName(update, "Verified timeout");

		assert.equal(
			exited,
			true,
			`${MARKER}: a process with matching persisted identity whose deadline elapsed during restart must be reaped, not orphaned.`,
		);
		assert.match(
			step?.output ?? "",
			/timeout|timed out|deadline/i,
			`${MARKER}: timeout recovery should surface timeout/deadline diagnostics rather than a generic restart interruption.`,
		);
	} finally {
		await cleanupChild(child);
	}
});

test("cancelled or superseded resumed verification cannot update gate state after cancellation", async (t) => {
	const { harness, gateStoreCalls, broadcasts, notifications } = makeHarness(t);
	const startedAt = Date.now();
	const verification = activeVerification("sig-stale-resume", [commandStepFixture({
		name: "Slow resumed command",
		startedAt,
	})], startedAt);

	(harness as any).activeVerifications.set(verification.signalId, verification);
	const resumeStarted = deferred<void>();
	const allowResumeToFinish = deferred<void>();
	(harness as any)._resumeCommandStep = async () => {
		resumeStarted.resolve();
		await allowResumeToFinish.promise;
		return {
			name: "Slow resumed command",
			type: "command",
			passed: true,
			output: "stale command eventually passed",
			duration_ms: 1,
		};
	};

	const resumePromise = (harness as any)._resumeOneVerification(verification);
	await resumeStarted.promise;
	await harness.cancelStaleVerificationsForGates(GOAL_ID, [GATE_ID]);

	const callCountAfterCancel = gateStoreCalls.length;
	const broadcastCountAfterCancel = broadcasts.length;
	const notificationCountAfterCancel = notifications.length;

	allowResumeToFinish.resolve();
	await resumePromise;

	assert.equal(
		gateStoreCalls.length,
		callCountAfterCancel,
		`${MARKER}: a stale resumed verification must not update signal/gate state after it was cancelled or superseded.`,
	);
	assert.equal(
		broadcasts.length,
		broadcastCountAfterCancel,
		`${MARKER}: a stale resumed verification must not broadcast completion/status after cancellation.`,
	);
	assert.equal(
		notifications.length,
		notificationCountAfterCancel,
		`${MARKER}: a stale resumed verification must not notify the team lead after cancellation.`,
	);
});

test("mixed same-phase real failure and restart interruption notifies only the real failed step", async (t) => {
	const { stateDir, harness, gateStoreCalls, notifications } = makeHarness(t);
	const startedAt = Date.now() - 1_000;
	const diagDir = path.join(stateDir, "verifications", "sig-mixed-same-phase");
	fs.mkdirSync(diagDir, { recursive: true });
	const outFile = path.join(diagDir, "real-failure.out.log");
	const errFile = path.join(diagDir, "real-failure.err.log");
	const exitFile = path.join(diagDir, "real-failure.exit");
	fs.writeFileSync(outFile, "real failure after restart\n");
	fs.writeFileSync(errFile, "");
	fs.writeFileSync(exitFile, "7\n");

	persistActive(stateDir, activeVerification("sig-mixed-same-phase", [
		commandStepFixture({
			name: "Real failed command",
			startedAt,
			outFile,
			errFile,
			exitFile,
		}),
		{
			...commandStepFixture({ name: "No verdict sibling", startedAt }),
			phase: 0,
		},
	], startedAt));

	await harness.resumeInterruptedVerifications();
	const update = latestSignalUpdate(gateStoreCalls);
	const realFailure = stepByName(update, "Real failed command");
	const interrupted = stepByName(update, "No verdict sibling");
	const notices = notificationText(notifications);

	assert.equal(realFailure?.status, "failed", `${MARKER}: precondition — recovered exit code 7 should be a real failed command row.`);
	assert.equal(interrupted?.status, "waiting", `${MARKER}: precondition — no-verdict sibling should remain restart-interrupted/waiting.`);
	assert.match(notices, /step="Real failed command"/, `${MARKER}: notification should include the real failed command.`);
	assert.doesNotMatch(
		notices,
		/step="No verdict sibling"/,
		`${MARKER}: notification must not include inspect commands for same-phase restart-interrupted/no-verdict rows.`,
	);
});

test("container or attached command fallback interruption is guarded as retryable with clear diagnostics", async (t) => {
	const { stateDir, harness, gateStoreCalls, notifications } = makeHarness(t);
	const startedAt = Date.now() - 500;

	persistActive(stateDir, activeVerification("sig-container-attached-interrupt", [commandStepFixture({
		name: "Container attached command",
		startedAt,
		containerId: "container-under-test",
	})], startedAt));

	await harness.resumeInterruptedVerifications();
	const update = latestSignalUpdate(gateStoreCalls);
	const step = stepByName(update, "Container attached command");
	const combined = `${step?.output ?? ""}\n${notificationText(notifications)}`;

	assert.equal(
		latestGateStatus(gateStoreCalls),
		"pending",
		`${MARKER}: unsupported attached/container command recovery should leave the gate pending/retryable.`,
	);
	assert.notEqual(
		step?.status,
		"failed",
		`${MARKER}: attached/container interruption without durable status must not be persisted as a fake command failure.`,
	);
	assert.match(
		combined,
		/container|docker|attached|unsupported/i,
		`${MARKER}: diagnostics should clearly identify the unsupported container/attached command recovery path.`,
	);
	assert.match(
		combined,
		/re-signal|retry|pending|no command verdict/i,
		`${MARKER}: diagnostics should tell the team lead to retry/re-signal rather than inspect a fake command verdict.`,
	);
});

test("resume can finalize from a durable exit file produced by a surviving command", async (t) => {
	const { stateDir, harness, gateStoreCalls } = makeHarness(t);
	const startedAt = Date.now();
	const diagDir = path.join(stateDir, "verifications", "sig-durable-exit-smoke");
	fs.mkdirSync(diagDir, { recursive: true });
	const outFile = path.join(diagDir, "stdout.log");
	const errFile = path.join(diagDir, "stderr.log");
	const exitFile = path.join(diagDir, "exit.txt");
	const pidFile = path.join(diagDir, "process.pid");
	fs.writeFileSync(outFile, "probe:started\n");
	fs.writeFileSync(errFile, "");

	const child = spawnNode([
		"const fs = require('fs');",
		`const out = ${JSON.stringify(outFile)};`,
		`const exitFile = ${JSON.stringify(exitFile)};`,
		"setTimeout(() => {",
		"  fs.appendFileSync(out, 'probe:after-restart\\n');",
		"  fs.writeFileSync(exitFile, '0\\n');",
		"  process.exit(0);",
		"}, 120);",
	].join("\n"));
	try {
		writeIdentityFile(pidFile, child.pid, "smoke-nonce");
		persistActive(stateDir, activeVerification("sig-durable-exit-smoke", [commandStepFixture({
			name: "Durable exit smoke",
			startedAt,
			pid: child.pid,
			timeoutSec: 2,
			outFile,
			errFile,
			exitFile,
			identityFile: pidFile,
			nonce: "smoke-nonce",
		})], startedAt));

		await harness.resumeInterruptedVerifications();
		const update = latestSignalUpdate(gateStoreCalls);
		const step = stepByName(update, "Durable exit smoke");

		assert.equal(latestGateStatus(gateStoreCalls), "passed", `${MARKER}: durable exit-code recovery should pass the gate for exit 0.`);
		assert.equal(step?.status, "passed", `${MARKER}: durable exit-code recovery should persist the command step as passed.`);
		assert.match(step?.output ?? "", /probe:after-restart/, `${MARKER}: recovered output should include diagnostics written after restart.`);
		assert.equal(fs.existsSync(path.join(stateDir, "active-verifications.json")), false, `${MARKER}: completed resumed verification should clear active-verifications.json.`);
	} finally {
		await cleanupChild(child);
	}
});
