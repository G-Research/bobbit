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
	return makeHarnessForStateDir(stateDir);
}

function makeHarnessForStateDir(stateDir: string) {
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
		getGatesForGoal: () => [],
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

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForCondition<T>(label: string, predicate: () => T | undefined | null | false, timeoutMs = 3_000, intervalMs = 25): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const value = predicate();
			if (value) return value;
		} catch (err) {
			lastError = err;
		}
		await sleep(intervalMs);
	}
	assert.fail(`${MARKER}: timed out waiting for ${label}${lastError instanceof Error ? ` (${lastError.message})` : ""}`);
}

function writeIdentityFile(file: string, pid: number, nonce: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${pid}\n${nonce}\n`);
}

function writeHeartbeatFile(file: string, pid: number, nonce: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ pid, nonce, ts: Math.floor(Date.now() / 1000) }) + "\n");
}

function loadActiveVerifications(stateDir: string): any[] {
	try {
		return JSON.parse(fs.readFileSync(path.join(stateDir, "active-verifications.json"), "utf8")).verifications ?? [];
	} catch {
		return [];
	}
}

function nodeShellCommand(script: string): string {
	const b64 = Buffer.from(script, "utf8").toString("base64");
	return `"${process.execPath}" -e "eval(Buffer.from('${b64}','base64').toString())"`;
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
	heartbeatFile?: string;
	processStartToken?: string;
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
		heartbeatFile: args.heartbeatFile,
		processStartToken: args.processStartToken,
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

test("resume waits for a pidfile that appears shortly after restart before declaring interruption", async (t) => {
	const { stateDir, harness, gateStoreCalls } = makeHarness(t);
	const startedAt = Date.now();
	const diagDir = path.join(stateDir, "verifications", "sig-late-pidfile");
	fs.mkdirSync(diagDir, { recursive: true });
	const outFile = path.join(diagDir, "stdout.log");
	const errFile = path.join(diagDir, "stderr.log");
	const exitFile = path.join(diagDir, "exit.txt");
	const pidFile = path.join(diagDir, "process.pid");
	const heartbeatFile = path.join(diagDir, "heartbeat.json");
	fs.writeFileSync(outFile, "probe:started\n");
	fs.writeFileSync(errFile, "");

	const child = spawnNode([
		"const fs = require('fs');",
		`const out = ${JSON.stringify(outFile)};`,
		`const exitFile = ${JSON.stringify(exitFile)};`,
		"setTimeout(() => {",
		"  fs.appendFileSync(out, 'probe:after-late-pidfile\\n');",
		"  fs.writeFileSync(exitFile, '0\\n');",
		"  process.exit(0);",
		"}, 160);",
	].join("\n"));
	try {
		persistActive(stateDir, activeVerification("sig-late-pidfile", [commandStepFixture({
			name: "Late pidfile command",
			startedAt,
			pid: child.pid,
			timeoutSec: 2,
			outFile,
			errFile,
			exitFile,
			identityFile: pidFile,
			nonce: "late-pidfile-nonce",
			heartbeatFile,
		})], startedAt));

		setTimeout(() => {
			try {
				writeIdentityFile(pidFile, child.pid, "late-pidfile-nonce");
				writeHeartbeatFile(heartbeatFile, child.pid, "late-pidfile-nonce");
			} catch { /* test cleanup may have run */ }
		}, 25);

		await harness.resumeInterruptedVerifications();
		const update = latestSignalUpdate(gateStoreCalls);
		const step = stepByName(update, "Late pidfile command");

		assert.equal(
			latestGateStatus(gateStoreCalls),
			"passed",
			`${MARKER}: resume should retry the create→pidfile window briefly and recover the real exit code once the pidfile appears.`,
		);
		assert.equal(step?.status, "passed", `${MARKER}: late pidfile recovery should finalize from the durable exit file, not restart-interrupt.`);
		assert.match(step?.output ?? "", /probe:after-late-pidfile/, `${MARKER}: late pidfile recovery should retain output written after restart.`);
	} finally {
		await cleanupChild(child);
	}
});

test("stale pidfile nonce without start token or fresh heartbeat is not trusted or killed", async (t) => {
	const { stateDir, harness, gateStoreCalls } = makeHarness(t);
	const child = spawnNode("setTimeout(() => {}, 30000)");
	try {
		const startedAt = Date.now() - 2_000;
		const diagDir = path.join(stateDir, "verifications", "sig-stale-pidfile");
		fs.mkdirSync(diagDir, { recursive: true });
		const outFile = path.join(diagDir, "stdout.log");
		const errFile = path.join(diagDir, "stderr.log");
		const exitFile = path.join(diagDir, "exit.txt");
		const pidFile = path.join(diagDir, "process.pid");
		const heartbeatFile = path.join(diagDir, "heartbeat.json");
		fs.writeFileSync(outFile, "stale identity should not be enough\n");
		fs.writeFileSync(errFile, "");
		writeIdentityFile(pidFile, child.pid, "stale-nonce");
		writeHeartbeatFile(heartbeatFile, child.pid, "stale-nonce");
		const old = new Date(Date.now() - 30_000);
		fs.utimesSync(pidFile, old, old);
		fs.utimesSync(heartbeatFile, old, old);

		persistActive(stateDir, activeVerification("sig-stale-pidfile", [commandStepFixture({
			name: "Stale pidfile command",
			startedAt,
			pid: child.pid,
			timeoutSec: 1,
			outFile,
			errFile,
			exitFile,
			identityFile: pidFile,
			nonce: "stale-nonce",
			heartbeatFile,
		})], startedAt));

		await harness.resumeInterruptedVerifications();
		const exited = await waitForExit(child, 250);
		const update = latestSignalUpdate(gateStoreCalls);
		const step = stepByName(update, "Stale pidfile command");

		assert.equal(
			exited,
			false,
			`${MARKER}: stale pidfile+nonce without processStartToken or fresh heartbeat must not authorize killing an alive numeric PID.`,
		);
		assert.equal(
			latestGateStatus(gateStoreCalls),
			"pending",
			`${MARKER}: stale command identity should leave the verification retryable/pending, not timeout-failed.`,
		);
		assert.equal(step?.status, "waiting", `${MARKER}: stale command identity should be represented as restart-interrupted/waiting.`);
		assert.match(step?.output ?? "", /identity|heartbeat|re-signal|no command verdict/i, `${MARKER}: stale identity diagnostics should explain why no command verdict was obtained.`);
	} finally {
		await cleanupChild(child);
	}
});

test("resume finalization reads only bounded retained log tails for large stdout and stderr", async (t) => {
	const { stateDir, harness, gateStoreCalls } = makeHarness(t);
	const startedAt = Date.now() - 1_000;
	const diagDir = path.join(stateDir, "verifications", "sig-large-retained-output");
	fs.mkdirSync(diagDir, { recursive: true });
	const outFile = path.join(diagDir, "stdout.log");
	const errFile = path.join(diagDir, "stderr.log");
	const exitFile = path.join(diagDir, "exit.txt");
	const hugePrefix = `HEAD_STDOUT_SENTINEL\n${"x".repeat(1_200_000)}\n`;
	fs.writeFileSync(outFile, `${hugePrefix}TAIL_STDOUT_SENTINEL\n`);
	fs.writeFileSync(errFile, "STDERR_TAIL_SENTINEL\n");
	fs.writeFileSync(exitFile, "7\n");

	let wholeLogReads = 0;
	const originalReadFileSync = fs.readFileSync;
	(fs as any).readFileSync = function patchedReadFileSync(file: fs.PathOrFileDescriptor, ...args: any[]) {
		const p = typeof file === "string" ? path.resolve(file) : undefined;
		if (p === path.resolve(outFile) || p === path.resolve(errFile)) wholeLogReads++;
		return (originalReadFileSync as any).call(this, file, ...args);
	};
	try {
		persistActive(stateDir, activeVerification("sig-large-retained-output", [commandStepFixture({
			name: "Large retained output",
			startedAt,
			outFile,
			errFile,
			exitFile,
		})], startedAt));

		await harness.resumeInterruptedVerifications();
	} finally {
		(fs as any).readFileSync = originalReadFileSync;
	}

	const update = latestSignalUpdate(gateStoreCalls);
	const step = stepByName(update, "Large retained output");
	const output = step?.output ?? "";
	assert.equal(step?.status, "failed", `${MARKER}: precondition — recovered exit code 7 should remain a real failed command.`);
	assert.equal(
		wholeLogReads,
		0,
		`${MARKER}: resume/finalization must not use full fs.readFileSync reads for large retained stdout/stderr logs; it should read bounded tails instead.`,
	);
	assert.match(output, /TAIL_STDOUT_SENTINEL/, `${MARKER}: bounded output should retain the stdout tail.`);
	assert.match(output, /STDERR_TAIL_SENTINEL/, `${MARKER}: bounded output should retain the stderr tail.`);
	assert.doesNotMatch(output, /HEAD_STDOUT_SENTINEL/, `${MARKER}: bounded output should omit old leading stdout content.`);
	assert.ok(output.length <= 6_000, `${MARKER}: step output should remain a small bounded tail, got ${output.length} chars.`);
});

test("real command failure mentioning restart is still notified while no-verdict rows are omitted", async (t) => {
	const { stateDir, harness, gateStoreCalls, notifications } = makeHarness(t);
	const startedAt = Date.now() - 1_000;
	const diagDir = path.join(stateDir, "verifications", "sig-real-failure-mentions-restart");
	fs.mkdirSync(diagDir, { recursive: true });
	const outFile = path.join(diagDir, "stdout.log");
	const errFile = path.join(diagDir, "stderr.log");
	const exitFile = path.join(diagDir, "exit.txt");
	fs.writeFileSync(outFile, "application log: Step was interrupted by server restart while exercising retry UI\nassertion failed after restart\n");
	fs.writeFileSync(errFile, "");
	fs.writeFileSync(exitFile, "7\n");

	persistActive(stateDir, activeVerification("sig-real-failure-mentions-restart", [
		commandStepFixture({
			name: "Real failure with restart text",
			startedAt,
			outFile,
			errFile,
			exitFile,
		}),
		commandStepFixture({
			name: "Restart interrupted sibling",
			startedAt,
		}),
	], startedAt));

	await harness.resumeInterruptedVerifications();
	const update = latestSignalUpdate(gateStoreCalls);
	const realFailure = stepByName(update, "Real failure with restart text");
	const interrupted = stepByName(update, "Restart interrupted sibling");
	const notices = notificationText(notifications);

	assert.equal(realFailure?.status, "failed", `${MARKER}: durable exit code 7 is a real command failure even if its output mentions restart.`);
	assert.equal(interrupted?.status, "waiting", `${MARKER}: sibling without a command verdict should remain restart-interrupted/waiting.`);
	assert.equal(latestGateStatus(gateStoreCalls), "failed", `${MARKER}: a real command failure must keep the gate failed, not restart-suppressed to pending.`);
	assert.match(notices, /step="Real failure with restart text"/, `${MARKER}: notification should include the real failed command step.`);
	assert.doesNotMatch(notices, /step="Restart interrupted sibling"/, `${MARKER}: notification must omit restart-interrupted/no-verdict rows.`);
	assert.doesNotMatch(notices, /no real failure was observed/i, `${MARKER}: notification must not claim no real failure when a durable command exit code failed.`);
});

test("gate-signal command verification can be resumed by a fresh harness and recover real exit output", async (t) => {
	const initial = makeHarness(t);
	const workDir = path.join(initial.stateDir, "work");
	fs.mkdirSync(workDir, { recursive: true });
	const releaseFile = path.join(workDir, "release.txt");
	const startedFile = path.join(workDir, "started.txt");
	const command = nodeShellCommand([
		"const fs = require('fs');",
		`const releaseFile = ${JSON.stringify(releaseFile)};`,
		`const startedFile = ${JSON.stringify(startedFile)};`,
		"console.log('gate-signal-probe:started');",
		"fs.writeFileSync(startedFile, 'started');",
		"const deadline = Date.now() + 5000;",
		"const timer = setInterval(() => {",
		"  if (fs.existsSync(releaseFile)) {",
		"    clearInterval(timer);",
		"    console.log('gate-signal-probe:after-restart');",
		"    process.exit(0);",
		"  }",
		"  if (Date.now() > deadline) {",
		"    clearInterval(timer);",
		"    console.error('gate-signal-probe:timeout waiting for release');",
		"    process.exit(97);",
		"  }",
		"}, 25);",
	].join("\n"));
	const gate = {
		id: GATE_ID,
		name: "Implementation",
		dependsOn: [],
		verify: [{ name: "Gate signal restart probe", type: "command", phase: 0, timeout: 5, run: command }],
	} as any;
	const signal = {
		id: "sig-gate-signal-restart-probe",
		goalId: GOAL_ID,
		gateId: GATE_ID,
		sessionId: "session-under-test",
		timestamp: Date.now(),
		commitSha: "HEAD",
		verification: { status: "running", steps: [] },
	} as any;

	initial.harness.beginVerification(signal, gate);
	const verifyPromise = initial.harness.verifyGateSignal(signal, gate, workDir);
	try {
		await waitForCondition("gate-signal command persisted with durable identity", () => {
			const active = loadActiveVerifications(initial.stateDir).find(v => v.signalId === signal.id);
			const step = active?.steps?.find((s: any) => s.name === "Gate signal restart probe");
			if (!step?.pid || !step?.pidFile || !step?.outFile || !fs.existsSync(step.pidFile) || !fs.existsSync(startedFile)) return false;
			const out = fs.existsSync(step.outFile) ? fs.readFileSync(step.outFile, "utf8") : "";
			return out.includes("gate-signal-probe:started") ? step : false;
		}, 5_000, 25);

		const resumed = makeHarnessForStateDir(initial.stateDir);
		const resumePromise = resumed.harness.resumeInterruptedVerifications();
		await sleep(50);
		fs.writeFileSync(releaseFile, "release");
		await resumePromise;
		await verifyPromise;

		const update = latestSignalUpdate(resumed.gateStoreCalls);
		const step = stepByName(update, "Gate signal restart probe");
		assert.equal(latestGateStatus(resumed.gateStoreCalls), "passed", `${MARKER}: fresh harness resume should recover the real exit 0 from a gate-signal-started command.`);
		assert.equal(step?.status, "passed", `${MARKER}: resumed gate-signal command should be persisted as passed.`);
		assert.match(step?.output ?? "", /gate-signal-probe:started/, `${MARKER}: recovered output should include pre-restart command output.`);
		assert.match(step?.output ?? "", /gate-signal-probe:after-restart/, `${MARKER}: recovered output should include post-restart command output.`);
		assert.equal(fs.existsSync(path.join(initial.stateDir, "active-verifications.json")), false, `${MARKER}: completed fresh-harness resume should clear active-verifications.json.`);
	} finally {
		fs.writeFileSync(releaseFile, "release");
		await verifyPromise.catch(() => {});
	}
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
