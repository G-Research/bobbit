// Tier-1 durable restart decision coverage. All process outcomes are authored
// through durable files or the command-step runner seam; no OS child is spawned.

import { afterAll, test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeTmpDir } from "../../tests/helpers/tmp.ts";
import { VerificationHarness, type ActiveVerification } from "../../src/server/agent/verification-harness.js";
import { createFakeVerificationCommandRunner } from "../harness/fake-verification-command-runner.js";
import { FakePinnedCheckoutManager, pinnedCheckoutReference } from "../harness/fake-pinned-checkout-manager.js";

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
const pinnedCheckoutManagers = new Map<string, FakePinnedCheckoutManager>();

afterAll(() => {
	fs.rmSync(suiteRoot, { recursive: true, force: true });
});

function makeLifecycleStateDir(): string {
	const stateDir = path.join(suiteRoot, String(++lifecycleSequence).padStart(2, "0"), "state");
	fs.mkdirSync(stateDir, { recursive: true });
	return stateDir;
}

function makeHarnessForStateDir(stateDir = makeLifecycleStateDir(), platform?: NodeJS.Platform) {
	const gateStoreCalls: GateStoreCall[] = [];
	const broadcasts: Array<{ goalId: string; event: any }> = [];
	const notifications: Array<{ goalId: string; message: string }> = [];
	const gateStore = {
		updateSignalVerification: (signalId: string, update: any) => gateStoreCalls.push({ kind: "updateSignalVerification", signalId, update }),
		updateGateStatus: (goalId: string, gateId: string, status: string) => gateStoreCalls.push({ kind: "updateGateStatus", goalId, gateId, status }),
		getGate: () => undefined,
		getGatesForGoal: () => [],
	} as any;
	const pinnedCheckoutManager = new FakePinnedCheckoutManager(path.join(stateDir, "pinned-checkouts"));
	pinnedCheckoutManagers.set(stateDir, pinnedCheckoutManager);
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
			pinnedCheckoutManager: pinnedCheckoutManager as any,
			platform,
			// Container lifecycle tests own no Engine fixture. Their exact signal
			// mock represents a completed payload group; this structured snapshot
			// supplies an unrelated live init row as the post-signal authority.
			containerProcessTopSnapshot: async () => [{ pid: 1, ppid: 1, pgid: 1, state: "S", args: "init" }],
		},
	);
	harness.setTeamLeadNotifier((goalId, message) => notifications.push({ goalId, message }));
	return { stateDir, harness, gateStoreCalls, broadcasts, notifications, pinnedCheckoutManager };
}

function persistActive(stateDir: string, verification: ActiveVerification | any): void {
	const pinnedCheckoutManager = pinnedCheckoutManagers.get(stateDir);
	assert.ok(pinnedCheckoutManager, `missing pinned-checkout fixture for ${stateDir}`);
	const checkout = pinnedCheckoutManager.seed(verification.signalId, stateDir);
	fs.writeFileSync(path.join(stateDir, "active-verifications.json"), JSON.stringify({
		verifications: [{ ...verification, pinnedCheckout: pinnedCheckoutReference(checkout) }],
	}, null, 2));
}

function seedActivePinnedCheckout(harness: any, verification: any, sourceRoot = process.cwd()): void {
	const checkout = harness.pinnedCheckoutManager.seed(verification.signalId, sourceRoot);
	verification.pinnedCheckout = pinnedCheckoutReference(checkout);
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

function commandStepFixture(args: { name: string; startedAt: number; timeoutSec?: number; outFile?: string; errFile?: string; exitFile?: string; containerId?: string; pid?: number; pidFile?: string; heartbeatFile?: string; nonce?: string; pidNonce?: string; windowsJobCompletionFile?: string; windowsJobCompletionNonce?: string; containerCompletionFile?: string; containerCompletionNonce?: string; containerOwnershipWitness?: { containerId: string; nonce: string; sentinelPid: number; pgid: number; startToken: string }; containerOwnershipAttestation?: { version: 1; containerId: string; nonce: string; execId: string; enginePid: number; tag: string; sentinelPid: number; pgid: number; startToken: string }; restartRecoveryMode?: "detached" | "container-exec" | "pending-retry" | "unsupported" }): any {
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

const CONTAINER_PROCESS = Object.freeze({ sentinelPid: 321_654, pgid: 321_654, startToken: "container-start" });
function containerOwnership(containerId: string, nonce: string) {
	return { containerOwnershipWitness: { containerId, nonce, ...CONTAINER_PROCESS }, containerOwnershipAttestation: { version: 1, containerId, nonce, execId: "exec", enginePid: 1, enginePgid: 2, tag: "tag", ...CONTAINER_PROCESS } };
}
function containerStep(args: any) { return commandStepFixture({ ...args, restartRecoveryMode: "container-exec", ...containerOwnership(args.containerId, args.nonce) }); }
function trackVerification(harness: any, verification: any): void {
	seedActivePinnedCheckout(harness, verification);
	harness.activeVerifications.set(verification.signalId, verification);
}
function mockContainerIdentity(harness: any): void { harness.containerProcessIdentityInspector = async (_containerId: string, pid: number) => ({ pid, ...CONTAINER_PROCESS }); }

test("terminal cleanup rows are private and cancellation retries resources without rewriting a published pass", async () => {
	const { harness, gateStoreCalls, broadcasts, pinnedCheckoutManager } = makeHarnessForStateDir();
	const signalId = "sig-terminal-cleanup";
	const fullContainerId = "a".repeat(64);
	let removals = 0;
	(harness as any).sessionManager = {
		getSandboxManager: () => ({
			get: () => ({
				removeVerificationSidecar: async ({ containerId }: { containerId: string }) => {
					assert.equal(containerId, fullContainerId, `${MARKER}: cleanup must retain the persisted full container identity`);
					if (++removals === 1) throw new Error("Docker endpoint at /private/path is unavailable");
				},
			}),
		}),
	};
	const verification = activeVerification(signalId, [], Date.now());
	seedActivePinnedCheckout(harness, verification);
	verification.projectId = "test-project-id";
	verification.overallStatus = "passed";
	verification.terminalVerdictPublished = true;
	verification.verificationContainer = {
		projectId: "test-project-id", signalId, containerId: fullContainerId,
		cwd: `/bobbit-state/verification-checkouts/${signalId}`, ignoredOutputDirs: [],
	};
	(harness as any).activeVerifications.set(signalId, verification);

	await (harness as any)._releaseTerminalVerificationResources(verification);
	assert.ok(verification.cleanupPending, `${MARKER}: failed strict cleanup must retain the terminal row`);
	assert.deepEqual(harness.getActiveVerifications(), [], `${MARKER}: cleanup-only rows must not surface as active verification work`);
	assert.equal(harness.getActiveVerification(signalId), undefined, `${MARKER}: a terminal cleanup row must not participate in active lookup`);
	const publication = { gateStoreCalls: gateStoreCalls.length, broadcasts: broadcasts.length };

	await harness.cancelAllVerifications(GOAL_ID);
	assert.equal(removals, 2, `${MARKER}: goal cancellation should drive the retained cleanup obligation`);
	assert.equal((harness as any).activeVerifications.has(signalId), false, `${MARKER}: successful retry must release the exact terminal row`);
	assert.deepEqual({ gateStoreCalls: gateStoreCalls.length, broadcasts: broadcasts.length }, publication, `${MARKER}: cancellation must not overwrite or re-broadcast a published pass`);
	assert.deepEqual(pinnedCheckoutManager.releasedSignalIds, [signalId]);
});

test("branch dependency remap preserves the default link when its target is absent", async () => {
	const { harness, pinnedCheckoutManager } = makeHarnessForStateDir();
	const signalId = "sig-remap-target";
	const checkout = pinnedCheckoutManager.seed(signalId, process.cwd());
	fs.symlinkSync(path.join(process.cwd(), "node_modules"), path.join(checkout.path, "node_modules"));
	const calls: string[][] = [];
	(harness as any).commandRunner = {
		execFile: async (_command: string, args: string[]) => {
			calls.push(args);
			if (args[args.length - 3] === "test") throw new Error("missing branch dependencies");
			return { stdout: "", stderr: "" };
		},
	};

	await (harness as any).remapSandboxIgnoredDependencies(checkout, `/bobbit-state/verification-checkouts/${signalId}`, "b".repeat(64), "goal/missing-deps");
	assert.deepEqual(calls, [["exec", "-u", "root", "b".repeat(64), "test", "-d", "/workspace-wt/goal/missing-deps/node_modules"]]);
	assert.equal(fs.readlinkSync(path.join(checkout.path, "node_modules")), path.join(process.cwd(), "node_modules"), `${MARKER}: absent branch dependencies must not replace the working default link`);
});

test("persisted identity accepts a matching nonce with a fresh heartbeat on a supported host", () => {
	// Exercise the durable-host contract independent of the CI runner's OS.
	const { stateDir, harness } = makeHarnessForStateDir(undefined, "linux");
	const pid = 424_242, nonce = "matching-nonce";
	const identity = writeIdentityEvidence(path.join(stateDir, "identity-match"), pid, nonce);
	const result = withPidReportedAlive(pid, () => (harness as any)._verifyPersistedCommandIdentity(commandStepFixture({ name: "Matching identity", startedAt: Date.now(), pid, nonce, ...identity })));
	assert.equal(result.verified, true);
	assert.equal(result.pid, pid);
});

test("persisted Windows host command identity fails closed even with a matching fresh heartbeat", () => {
	// A nonce and heartbeat do not atomically bind a persisted Windows PID to
	// its original tree after restart. This must remain true on every CI host.
	const { stateDir, harness } = makeHarnessForStateDir(undefined, "win32");
	const pid = 424_242, nonce = "windows-unsupported-nonce";
	const identity = writeIdentityEvidence(path.join(stateDir, "identity-windows-unsupported"), pid, nonce);
	const result = withPidReportedAlive(pid, () => (harness as any)._verifyPersistedCommandIdentity(commandStepFixture({ name: "Windows host identity", startedAt: Date.now(), pid, nonce, ...identity })));
	assert.equal(result.verified, false);
	assert.equal(result.pid, pid);
	assert.match(result.reason, /Windows host-detached.*unsupported|refusing PID cleanup/i);
});

test("persisted identity rejects a mismatched nonce without authorizing a kill", () => {
	const { stateDir, harness } = makeHarnessForStateDir(undefined, "linux");
	const pid = 424_243, identity = writeIdentityEvidence(path.join(stateDir, "identity-mismatch"), pid, "foreign-nonce");
	const result = withPidReportedAlive(pid, () => (harness as any)._verifyPersistedCommandIdentity(commandStepFixture({ name: "Foreign identity", startedAt: Date.now(), pid, nonce: "expected-nonce", ...identity })));
	assert.equal(result.verified, false);
	assert.match(result.reason, /nonce|identity/i);
});

test("persisted identity rejects stale heartbeat evidence", () => {
	const { stateDir, harness } = makeHarnessForStateDir(undefined, "linux");
	const pid = 424_244, nonce = "stale-nonce";
	const identity = writeIdentityEvidence(path.join(stateDir, "identity-stale"), pid, nonce);
	const old = new Date(Date.now() - 30_000);
	fs.utimesSync(identity.pidFile, old, old);
	fs.utimesSync(identity.heartbeatFile, old, old);
	const result = withPidReportedAlive(pid, () => (harness as any)._verifyPersistedCommandIdentity(commandStepFixture({ name: "Stale identity", startedAt: Date.now() - 30_000, pid, nonce, ...identity })));
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

test("no durable verdict is cancelled as gateway restart recovery without failing the gate", async () => {
	const { stateDir, harness, gateStoreCalls, notifications } = makeHarnessForStateDir();
	const startedAt = Date.now() - 100;
	const files = diagnosticFixture(stateDir, "sig-no-verdict", { out: "probe started\n", err: "" });
	persistActive(stateDir, activeVerification("sig-no-verdict", [commandStepFixture({ name: "No verdict", startedAt, ...files })], startedAt));

	await harness.resumeInterruptedVerifications();
	const update = latestSignalUpdate(gateStoreCalls);
	const step = stepByName(update, "No verdict");
	assert.equal(latestGateStatus(gateStoreCalls), "pending");
	assert.equal(update?.status, "cancelled");
	assert.deepEqual(update?.cancellation && {
		cause: update.cancellation.cause,
		requestedAt: typeof update.cancellation.requestedAt,
		finalizedAt: typeof update.cancellation.finalizedAt,
	}, { cause: "gateway-restart-recovery", requestedAt: "number", finalizedAt: "number" });
	assert.equal(step?.status, "cancelled");
	assert.deepEqual(step?.cancellation && {
		cause: step.cancellation.cause,
		requestedAt: typeof step.cancellation.requestedAt,
		finalizedAt: typeof step.cancellation.finalizedAt,
	}, { cause: "gateway-restart-recovery", requestedAt: "number", finalizedAt: "number" });
	assert.match(step?.output ?? "", /probe started|no command verdict|re-signal|durable command exit status/i);
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

test("persisted container cancellation kills and verifies its payload before reaping the host transport", async () => {
	const { harness } = makeHarnessForStateDir(undefined, "linux");
	const events: string[] = [];
	mockContainerIdentity(harness);
	(harness as any)._dockerExecCapture = async (containerId: string, script: string) => {
		events.push("payload");
		assert.equal(containerId, "container-cancel-only");
		assert.match(script, /live_p=\$\(awk '\{print \$1\}'/);
		assert.equal((script.match(/live_p=\$\(awk '\{print \$1\}'/g) ?? []).length, 2, "exact tuple must be checked before TERM and again before KILL");
		assert.match(script, /kill -TERM -"\$pgid"[\s\S]*live_p=\$\(awk '\{print \$1\}'[\s\S]*kill -KILL -"\$pgid"/);
		assert.doesNotMatch(script, /kill -0 -"\$pgid"/, "never post-probe a historical PGID after final signal");
		assert.doesNotMatch(script, /docker (?:stop|kill)|killall|pkill/);
		return { code: 0, stdout: "" }; // no live group remains after the exact-group probe
	};
	(harness as any).recoveredSentinelReaper = async () => { events.push("sentinel"); };
	const startedAt = Date.now();
	const verification = activeVerification("sig-container-cancel", [containerStep({ name: "Container payload", startedAt, containerId: "container-cancel-only", pidFile: "/tmp/bobbit-cancel.pid", nonce: "container-cancel-nonce" })], startedAt);
	trackVerification(harness, verification);

	await harness.cancelStaleVerificationsForGates(GOAL_ID, [GATE_ID]);

	assert.deepEqual(events, ["payload", "sentinel"], `${MARKER}: payload cleanup must precede host sentinel reap`);
	assert.equal((harness as any).activeVerifications.has(verification.signalId), false);
	assert.ok(verification.steps[0].killCompletedAt, `${MARKER}: cancellation must not complete before payload cleanup`);
});

test("recovers a crash after host result before payload cleanup, then reaps transport before finalizing", async () => {
	const { stateDir, harness } = makeHarnessForStateDir(undefined, "linux");
	const events: string[] = [];
	mockContainerIdentity(harness);
	(harness as any)._dockerExecCapture = async (containerId: string, script: string) => {
		assert.equal(containerId, "container-terminal-only");
		events.push("payload-no-live-group");
		assert.match(script, /live_g=\$\(awk '\{print \$5\}'/);
		assert.equal((script.match(/live_g=\$\(awk '\{print \$5\}'/g) ?? []).length, 2, "exact PGID must be checked before both destructive signals");
		assert.match(script, /kill -TERM -"\$pgid"[\s\S]*live_g=\$\(awk '\{print \$5\}'[\s\S]*kill -KILL -"\$pgid"/);
		assert.doesNotMatch(script, /kill -0 -"\$pgid"/, "never post-probe a historical PGID after final signal");
		return { code: 0, stdout: "" };
	};
	(harness as any)._reapRecoveredPosixSentinel = async () => { events.push("sentinel"); };
	const hostControlFile = path.join(stateDir, "container-terminal-result.json");
	fs.writeFileSync(hostControlFile, JSON.stringify({ nonce: "container-terminal-nonce", exitCode: 0 }));
	const step = containerStep({ name: "Recovered container success", startedAt: Date.now() - 100, containerId: "container-terminal-only", pidFile: "/tmp/bobbit-terminal.pid", exitFile: "/tmp/bobbit-terminal.exit", containerCompletionFile: hostControlFile, containerCompletionNonce: "container-terminal-nonce", nonce: "container-terminal-nonce" });
	const verification = activeVerification("sig-container-terminal", [step], step.startedAt);
	trackVerification(harness, verification);

	const result = await (harness as any)._resumeContainerCommandStep(verification, step, {
		finalize: (code: number) => ({ name: step.name, type: "command", passed: code === 0, output: String(code), duration_ms: 1 }), timeoutResult: () => { throw new Error("unexpected timeout"); }, restartInterrupted: () => { throw new Error("unexpected interruption"); },
	});

	assert.equal(result?.passed, true);
	assert.deepEqual(events, ["payload-no-live-group", "sentinel"], `${MARKER}: crash recovery must clean payload before the retained host transport`);
});

test("a durable container result remains pending until its exact host transport reaps, then finalizes once", async () => {
	const { stateDir, harness } = makeHarnessForStateDir(undefined, "linux");
	const completion = path.join(stateDir, "transport-pending-result.json");
	fs.writeFileSync(completion, JSON.stringify({ nonce: "transport-pending-nonce", exitCode: 0 }));
	const startedAt = Date.now();
	const step = containerStep({
		name: "Container transport pending", startedAt, containerId: "container-transport-pending",
		nonce: "transport-pending-nonce", containerCompletionFile: completion,
		containerCompletionNonce: "transport-pending-nonce", containerPayloadCleanupCompletedAt: Date.now(),
		containerTransportCleanupPending: true,
	});
	const verification = activeVerification("sig-container-transport-pending", [step], startedAt);
	trackVerification(harness, verification);
	let reaped = false;
	let finalizations = 0;
	(harness as any)._reapRecoveredPosixSentinel = async (candidate: any) => {
		if (!reaped) {
			candidate.containerTransportCleanupPending = true;
			throw new Error("exact host transport sentinel is missing or reused");
		}
	};
	const helpers = {
		finalize: (code: number) => { finalizations++; return { name: step.name, type: "command", passed: code === 0, output: String(code), duration_ms: 1 }; },
		timeoutResult: () => { throw new Error("unexpected timeout"); },
		restartInterrupted: () => { throw new Error("unexpected interruption"); },
	};

	await assert.rejects(() => (harness as any)._resumeContainerCommandStep(verification, step, helpers), /missing or reused/);
	assert.equal(finalizations, 0);
	assert.equal(step.containerTransportCleanupPending, true);
	assert.equal(step.containerTransportCleanupCompletedAt, undefined);

	reaped = true;
	const result = await (harness as any)._resumeContainerCommandStep(verification, step, helpers);
	assert.equal(result?.passed, true);
	assert.equal(finalizations, 1);
	assert.equal(step.containerTransportCleanupPending, undefined);
	assert.ok(step.containerTransportCleanupCompletedAt);
});

test("Windows persisted container cancellation cannot complete through the POSIX sentinel no-op", async () => {
	const { harness } = makeHarnessForStateDir(undefined, "win32");
	const events: string[] = [];
	mockContainerIdentity(harness);
	(harness as any)._dockerExecCapture = async (containerId: string, script: string) => {
		events.push("payload");
		assert.equal(containerId, "container-windows-only");
		assert.match(script, /kill -TERM -"\$pgid"/);
		return { code: 0, stdout: "" };
	};
	// The production POSIX reaper is intentionally a Windows no-op. This seam
	// makes the ordering observable: the in-container proof must still happen.
	(harness as any).recoveredSentinelReaper = async () => { events.push("sentinel-no-op"); };
	const startedAt = Date.now();
	const verification = activeVerification("sig-container-windows", [containerStep({ name: "Windows container payload", startedAt, containerId: "container-windows-only", pidFile: "/tmp/bobbit-windows.pid", nonce: "container-windows-nonce" })], startedAt);
	trackVerification(harness, verification);

	await harness.cancelAllVerifications(GOAL_ID);

	assert.deepEqual(events, ["payload", "sentinel-no-op"]);
	assert.equal((harness as any).activeVerifications.has(verification.signalId), false);
});

test("Windows recovered docker-exec transport requires nonce-bound Job-close evidence", async () => {
	const { stateDir, harness } = makeHarnessForStateDir(undefined, "win32");
	const step = commandStepFixture({ name: "Windows recovered transport", startedAt: Date.now(), containerId: "container-windows-proof", restartRecoveryMode: "container-exec", nonce: "windows-job-proof-nonce", pidNonce: "windows-job-proof-nonce", windowsJobCompletionFile: path.join(stateDir, "missing-job-proof.json"), windowsJobCompletionNonce: "windows-job-proof-nonce" });
	await assert.rejects(() => (harness as any)._reapRecoveredPosixSentinel(step), /Job completion evidence|completion is pending/i);
	assert.equal(step.sentinelCleanupPending, true);

	fs.writeFileSync(step.windowsJobCompletionFile, JSON.stringify({ nonce: "windows-job-proof-nonce", jobClosed: true }));
	await (harness as any)._reapRecoveredPosixSentinel(step);
	assert.equal(step.sentinelCleanupPending, undefined);
});

test("unsupported attached container recovery is cancelled with a durable restart cause", async () => {
	const { stateDir, harness, gateStoreCalls } = makeHarnessForStateDir();
	const startedAt = Date.now() - 100;
	persistActive(stateDir, activeVerification("sig-attached", [commandStepFixture({ name: "Container attached command", startedAt, containerId: "container-under-test" })], startedAt));

	await harness.resumeInterruptedVerifications();
	const update = latestSignalUpdate(gateStoreCalls);
	const step = stepByName(update, "Container attached command");
	assert.equal(latestGateStatus(gateStoreCalls), "pending");
	assert.equal(update?.status, "cancelled");
	assert.equal(update?.cancellation?.cause, "gateway-restart-recovery");
	assert.equal(step?.status, "cancelled");
	assert.equal(step?.cancellation?.cause, "gateway-restart-recovery");
	assert.match(step?.output ?? "", /container|attached|unsupported/i);
	assert.match(step?.output ?? "", /re-signal|retry|pending|no command verdict/i);
});

test("restart retains an ambiguous spawning command as a durable cleanup owner", async () => {
	const { stateDir, harness, gateStoreCalls, broadcasts } = makeHarnessForStateDir();
	const signalId = "sig-spawning-restart";
	const startedAt = Date.now() - 100;
	persistActive(stateDir, activeVerification(signalId, [{
		...commandStepFixture({ name: "Spawn window command", startedAt, restartRecoveryMode: "pending-retry" }),
		commandSpawnState: "spawning",
	}], startedAt));

	await harness.resumeInterruptedVerifications();

	const active = (harness as any).activeVerifications.get(signalId);
	const persisted = (harness as any)._loadActive().find((verification: ActiveVerification) => verification.signalId === signalId);
	assert.ok(active, `${MARKER}: a spawn-window command must retain its active cleanup owner`);
	assert.equal(active.overallStatus, "cancelled");
	assert.equal(active.steps[0].status, "running", `${MARKER}: cleanup must not invent command completion`);
	assert.equal(active.steps[0].killReason, "cancelled");
	assert.equal(active.steps[0].killSignal, "SIGKILL");
	assert.ok(active.steps[0].killRequestedAt, `${MARKER}: restart must persist kill intent before cleanup retries`);
	assert.match(active.steps[0].killUnsafeReason ?? "", /no restart-safe persisted process identity/i);
	assert.equal((harness as any)._hasPendingCommandKillCleanup(active), true);
	assert.equal(persisted.steps[0].killRequestedAt, active.steps[0].killRequestedAt, `${MARKER}: ambiguous cleanup intent must survive restart persistence`);
	assert.equal(gateStoreCalls.length, 0, `${MARKER}: ambiguous cleanup must not terminalize the signal or gate`);
	assert.equal(broadcasts.length, 0, `${MARKER}: ambiguous cleanup must not publish terminal WebSocket state`);
});

test("spawning and spawned commands fail closed while queued commands finalize immediately", async () => {
	const { harness, gateStoreCalls, broadcasts } = makeHarnessForStateDir();
	const startedAt = Date.now();
	const spawning = activeVerification("sig-spawning-cancel", [{
		...commandStepFixture({ name: "Spawning", startedAt, restartRecoveryMode: "pending-retry" }),
		commandSpawnState: "spawning",
	}], startedAt);
	const spawned = activeVerification("sig-spawned-cancel", [{
		...commandStepFixture({ name: "Spawned", startedAt, restartRecoveryMode: "pending-retry" }),
		commandSpawnState: "spawned",
	}], startedAt);
	const queued = activeVerification("sig-queued-cancel", [{
		...commandStepFixture({ name: "Queued", startedAt, restartRecoveryMode: "pending-retry" }),
		commandSpawnState: "queued",
	}], startedAt);
	// First leave the old generation in its ambiguous spawn window. A later
	// generation must not erase that durable cleanup owner while superseding it.
	trackVerification(harness, spawning);
	assert.equal(await harness.cancelAllVerifications(GOAL_ID, "manual"), false);
	trackVerification(harness, spawned);
	trackVerification(harness, queued);

	const settled = await harness.cancelStaleVerificationsForGates(GOAL_ID, [GATE_ID]);

	for (const verification of [spawning, spawned]) {
		const step = verification.steps[0];
		assert.equal((harness as any).activeVerifications.get(verification.signalId), verification, `${MARKER}: ${step.commandSpawnState} ownership must survive a later superseding generation`);
		assert.ok(step.killRequestedAt, `${MARKER}: ${step.commandSpawnState} must receive durable kill intent`);
		assert.equal(step.killReason, "cancelled");
		assert.match(step.killUnsafeReason ?? "", /no restart-safe persisted process identity/i);
		assert.equal(step.killCompletedAt, undefined, `${MARKER}: ${step.commandSpawnState} without exact identity must never invent cleanup completion`);
	}
	assert.equal(spawning.cancellation?.cause, "manual", `${MARKER}: later supersession must preserve the first cancellation fence`);
	assert.equal(settled, false, `${MARKER}: ambiguous spawning ownership keeps cancellation retryable`);
	assert.equal((harness as any).activeVerifications.has(queued.signalId), false, `${MARKER}: only explicit queued proves no command process exists`);
	assert.ok(gateStoreCalls.some(call => call.kind === "updateSignalVerification" && call.signalId === queued.signalId), `${MARKER}: queued cancellation may finalize immediately`);
	assert.ok(broadcasts.some(entry => entry.event?.signalId === queued.signalId && entry.event?.status === "cancelled"));
	assert.equal(broadcasts.some(entry => (entry.event?.signalId === spawning.signalId || entry.event?.signalId === spawned.signalId) && entry.event?.type === "gate_verification_complete"), false, `${MARKER}: ambiguous old generations must not publish terminal completion`);

	const persisted = (harness as any)._loadActive();
	assert.deepEqual(persisted.map((verification: ActiveVerification) => verification.signalId).sort(), [spawning.signalId, spawned.signalId].sort(), `${MARKER}: later supersession must not discard ambiguous cleanup owners`);
});

test("completed spawned rows preserve history without acquiring cancellation cleanup", async () => {
	const { harness, gateStoreCalls, broadcasts, pinnedCheckoutManager } = makeHarnessForStateDir();
	const signalId = "sig-completed-spawned";
	const startedAt = Date.now();
	const verification = activeVerification(signalId, [
		{
			...commandStepFixture({ name: "Completed command", startedAt }),
			status: "passed",
			durationMs: 12,
			output: "already passed",
			commandSpawnState: "spawned",
		},
		{
			...commandStepFixture({ name: "Queued command", startedAt }),
			commandSpawnState: "queued",
		},
	], startedAt);
	trackVerification(harness, verification);

	assert.equal(await harness.cancelAllVerifications(GOAL_ID, "manual"), true);

	const update = latestSignalUpdate(gateStoreCalls);
	const completed = stepByName(update, "Completed command");
	const queued = stepByName(update, "Queued command");
	assert.equal(completed?.status, "passed", `${MARKER}: completed command history must remain authoritative`);
	assert.equal(completed?.output, "already passed");
	assert.equal(verification.steps[0].killRequestedAt, undefined, `${MARKER}: stale spawned state must not create a new kill intent for a completed row`);
	assert.equal(verification.steps[0].killCompletedAt, undefined);
	assert.equal(queued?.status, "cancelled");
	assert.equal(latestGateStatus(gateStoreCalls), "pending");
	assert.equal(update?.status, "cancelled");
	assert.equal((harness as any).activeVerifications.has(signalId), false, `${MARKER}: completed row must not leak a cleanup owner`);
	assert.deepEqual(pinnedCheckoutManager.releasedSignalIds, [signalId]);
	assert.equal(broadcasts.filter(entry => entry.event?.type === "gate_verification_complete" && entry.event?.signalId === signalId).length, 1, `${MARKER}: cancellation must publish exactly once`);
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
	seedActivePinnedCheckout(harness, verification);
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
	seedActivePinnedCheckout(harness, verification);
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
