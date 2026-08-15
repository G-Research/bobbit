import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "vitest";

import { GateStore, type GateSignal } from "../../src/server/agent/gate-store.ts";
import { GoalStore, type PersistedGoal } from "../../src/server/agent/goal-store.ts";
import { VerificationHarness } from "../../src/server/agent/verification-harness.ts";
import { PinnedCheckoutError, VerificationPinnedCheckoutManager } from "../../src/server/agent/verification-pinned-checkout.ts";
import { realCommandRunner, type CommandRunner } from "../../src/server/gateway-deps.ts";
import { buildStepCache } from "../../src/server/agent/verification-logic.ts";
import { reuseCachedGateSignal } from "../../src/server/gate-signal-response.ts";
import { createRunChild } from "../harness/run-isolation.ts";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const ROLE_STORE = { get: () => undefined, getAll: () => [] };

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" });
	return stdout.trim();
}

async function waitFor(file: string, timeoutMs = 5_000): Promise<void> {
	let last: unknown;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try { await access(file); return; } catch (error) { last = error; }
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for fixture control ${path.basename(file)}: ${String(last)}`);
}

async function singleFixture() {
	const base = createRunChild("pinned-gate-verification-e2e");
	roots.push(base);
	const source = path.join(base, "live-source");
	const state = path.join(base, "state");
	const control = path.join(base, "control");
	await Promise.all([mkdir(source), mkdir(control)]);
	await git(source, "init");
	await git(source, "config", "user.email", "pinned-gate@example.test");
	await git(source, "config", "user.name", "Pinned gate fixture");
	await writeFile(path.join(source, "fixture.txt"), "frozen-v1\n");
	await git(source, "add", ".");
	await git(source, "commit", "-m", "fixture");
	return { base, source, state, control, head: await git(source, "rev-parse", "HEAD") };
}

function command(script: string, ...args: string[]): string {
	return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)} ${args.map(arg => JSON.stringify(arg)).join(" ")}`;
}

function signal(id: string, head: string, goalId = "goal", gateId = "verify"): GateSignal {
	return { id, goalId, gateId, sessionId: "test-session", timestamp: Date.now(), commitSha: head, verification: { status: "running", steps: [] } };
}

function harnessFixture(input: {
	state: string;
	goal: PersistedGoal;
	components?: unknown[];
	manager?: VerificationPinnedCheckoutManager;
}) {
	const gateStore = new GateStore(input.state);
	const goalStore = new GoalStore(input.state);
	goalStore.put(input.goal);
	gateStore.initGatesForGoal(input.goal.id, ["verify"]);
	const projectConfigStore = {
		get: () => "",
		getWithDefaults: () => ({}),
		getComponents: () => input.components ?? [],
	};
	const context = {
		project: { id: "pinned-gate-project" }, goalStore, gateStore, projectConfigStore,
		goalManager: { resolveRootMaxConcurrentChildren: () => 1 },
	};
	const harness = new VerificationHarness(
		input.state, gateStore, () => {}, ROLE_STORE as any, undefined, undefined, undefined,
		projectConfigStore as any, { getContextForGoal: (id: string) => id === input.goal.id ? context : undefined } as any,
		undefined, { pinnedCheckoutManager: input.manager as any },
	);
	return { harness, gateStore };
}

function goal(id: string, cwd: string, workflow: any, extra: Partial<PersistedGoal> = {}): PersistedGoal {
	return { id, title: id, cwd, worktreePath: cwd, state: "in-progress", spec: "Pinned lifecycle fixture", createdAt: Date.now(), updatedAt: Date.now(), workflowId: "pinned", workflow, ...extra };
}

async function run(harness: VerificationHarness, store: GateStore, source: string, candidate: GateSignal, gate: any, goalBranch?: string): Promise<void> {
	candidate.verification.steps = harness.beginVerification(candidate, gate);
	store.recordSignal(candidate);
	await harness.verifyGateSignal(candidate, gate, source, goalBranch);
	await store.flush();
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("pinned gate verification lifecycle (real Git and commands)", () => {
	it.skipIf(process.platform === "win32")("runs a real gate command from a frozen signal checkout while the live worktree changes", async () => {
		const f = await singleFixture();
		const ready = path.join(f.control, "ready");
		const release = path.join(f.control, "release");
		const gate = { id: "verify", name: "Verify", dependsOn: [], verify: [{ name: "read frozen bytes", type: "command", run: command("const fs=require('fs'); const [ready,release]=process.argv.slice(1); fs.writeFileSync(ready,'ready'); while(!fs.existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); console.log(fs.readFileSync('fixture.txt','utf8').trim()); console.log(process.cwd());", ready, release) }] };
		const workflow = { id: "pinned", name: "Pinned", description: "fixture", gates: [gate], createdAt: Date.now(), updatedAt: Date.now() };
		const manager = new VerificationPinnedCheckoutManager(f.state);
		let acquiredPath = "";
		let auditCount = 0;
		const acquire = manager.acquire.bind(manager);
		const audit = manager.assertUnchanged.bind(manager);
		manager.acquire = async input => { const checkout = await acquire(input); acquiredPath = checkout.path; return checkout; };
		manager.assertUnchanged = async checkout => { auditCount++; return audit(checkout); };
		const { harness, gateStore } = harnessFixture({ state: f.state, goal: goal("goal", f.source, workflow), manager });
		const candidate = signal("11111111-1111-4111-8111-111111111111", f.head);
		const verification = run(harness, gateStore, f.source, candidate, gate);
		try {
			await waitFor(ready);
			await writeFile(path.join(f.source, "fixture.txt"), "live-v2\n");
			await writeFile(release, "go\n");
			await verification;

			const stored = gateStore.getGate("goal", "verify")!.signals[0]!;
			assert.equal(stored.verification.status, "passed");
			assert.match(stored.verification.steps[0]!.output, /frozen-v1/);
			assert.doesNotMatch(stored.verification.steps[0]!.output, /live-v2/);
			assert.match(stored.verification.steps[0]!.output, new RegExp(acquiredPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			assert.equal(await readFile(path.join(f.source, "fixture.txt"), "utf8"), "live-v2\n");
			assert.ok(stored.contentDigest?.digest);
			assert.deepEqual(stored.pinnedCheckout, { version: 1, commitSha: f.head, contentDigest: stored.contentDigest });
			assert.ok(auditCount >= 3, "pre-phase, post-phase, and terminal audits must run");
			await assert.rejects(lstat(acquiredPath), /ENOENT/, "terminal cleanup removes the exact public checkout");
		} finally {
			await writeFile(release, "go\n").catch(() => {});
			await verification.catch(() => {});
		}
	});

	it.skipIf(process.platform === "win32")("fails a successful command that mutates its public pinned source and persists sanitized attestation failure", async () => {
		const f = await singleFixture();
		const gate = { id: "verify", name: "Verify", dependsOn: [], verify: [{ name: "mutate pinned source", type: "command", run: command("const fs=require('fs'); fs.chmodSync('fixture.txt',0o644); fs.writeFileSync('fixture.txt','mutated only in pinned checkout\\n');") }] };
		const workflow = { id: "pinned", name: "Pinned", description: "fixture", gates: [gate], createdAt: Date.now(), updatedAt: Date.now() };
		const manager = new VerificationPinnedCheckoutManager(f.state);
		let acquiredPath = "";
		const acquire = manager.acquire.bind(manager);
		manager.acquire = async input => { const checkout = await acquire(input); acquiredPath = checkout.path; return checkout; };
		const { harness, gateStore } = harnessFixture({ state: f.state, goal: goal("goal", f.source, workflow), manager });
		await run(harness, gateStore, f.source, signal("22222222-2222-4222-8222-222222222222", f.head), gate);
		const stored = gateStore.getGate("goal", "verify")!.signals[0]!;
		assert.equal(stored.verification.status, "failed");
		assert.deepEqual(stored.pinnedCheckoutError, { code: "PINNED_CHECKOUT_MUTATED", message: "Frozen verification source changed during execution." });
		assert.equal(stored.verification.steps.at(-1)?.output, "Frozen verification source changed during execution.");
		assert.equal(await readFile(path.join(f.source, "fixture.txt"), "utf8"), "frozen-v1\n");
		const durable = JSON.stringify(stored);
		assert.ok(!durable.includes(f.source) && !durable.includes(acquiredPath) && !durable.includes(f.control), "operator evidence must not expose source, checkout, or control paths");
		await assert.rejects(lstat(acquiredPath), /ENOENT/);
	});

	it.skipIf(process.platform === "win32")("cancels a held real command before releasing its signal checkout", async () => {
		const f = await singleFixture();
		const ready = path.join(f.control, "cancel-ready");
		const gate = { id: "verify", name: "Verify", dependsOn: [], verify: [{ name: "held command", type: "command", run: command("const fs=require('fs'); const ready=process.argv[1]; fs.writeFileSync(ready,String(process.pid)); for(;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);", ready) }] };
		const workflow = { id: "pinned", name: "Pinned", description: "fixture", gates: [gate], createdAt: Date.now(), updatedAt: Date.now() };
		const manager = new VerificationPinnedCheckoutManager(f.state);
		let acquiredPath = "";
		let released = false;
		let releaseSawTerminalCommand = false;
		let heldPid = 0;
		const acquire = manager.acquire.bind(manager);
		const release = manager.release.bind(manager);
		manager.acquire = async input => { const checkout = await acquire(input); acquiredPath = checkout.path; return checkout; };
		const { harness, gateStore } = harnessFixture({ state: f.state, goal: goal("goal", f.source, workflow), manager });
		manager.release = async (...args: Parameters<typeof release>) => {
			const step = gateStore.getGate("goal", "verify")?.signals[0]?.verification.steps[0];
			releaseSawTerminalCommand = step?.status !== "running";
			assert.ok(releaseSawTerminalCommand, "the command step must be terminal/reaped before its pinned lease releases");
			assert.ok(Number.isSafeInteger(heldPid) && heldPid > 0, "held command identity must be captured before a liveness check");
			assert.throws(() => process.kill(heldPid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH", "the held command process must be reaped before its pinned lease releases");
			released = true;
			return release(...args);
		};
		const candidate = signal("66666666-6666-4666-8666-666666666666", f.head);
		const verification = run(harness, gateStore, f.source, candidate, gate);
		try {
			await waitFor(ready);
			heldPid = Number(await readFile(ready, "utf8"));
			assert.ok(Number.isSafeInteger(heldPid) && heldPid > 0, "fixture must capture the held command process identity");
			await harness.cancelStaleVerifications("goal", "verify");
			await verification;
			assert.equal(gateStore.getGate("goal", "verify")!.signals[0]!.verification.status, "failed", "a killed command cannot publish a pass");
			assert.ok(released && releaseSawTerminalCommand, "terminal cancellation releases only after command cleanup");
			await assert.rejects(lstat(acquiredPath), /ENOENT/);
		} finally {
			await harness.cancelStaleVerifications("goal", "verify").catch(() => {});
			await verification.catch(() => {});
		}
	});

	it.skipIf(process.platform === "win32")("resumes only the persisted ready lease after live mutation and converges exact cleanup across restart", async () => {
		const f = await singleFixture();
		const gate = { id: "verify", name: "Verify", dependsOn: [], verify: [{ name: "check", type: "command", run: "true" }] };
		const workflow = { id: "pinned", name: "Pinned", description: "fixture", gates: [gate], createdAt: Date.now(), updatedAt: Date.now() };
		const initial = new VerificationPinnedCheckoutManager(f.state);
		const candidate = signal("77777777-7777-4777-8777-777777777777", f.head);
		const checkout = await initial.acquire({ signal: candidate, sourceRoot: f.source, projectId: "pinned-gate-project" });
		candidate.contentDigest = checkout.contentDigest;
		candidate.pinnedCheckout = { version: 1, commitSha: checkout.commitSha, contentDigest: checkout.contentDigest };
		const first = harnessFixture({ state: f.state, goal: goal("goal", f.source, workflow), manager: initial });
		first.gateStore.recordSignal(candidate);
		await first.gateStore.flush();
		await writeFile(path.join(f.state, "active-verifications.json"), JSON.stringify({ verifications: [{
			goalId: "goal", gateId: "verify", signalId: candidate.id, projectId: checkout.projectId,
			steps: [], overallStatus: "passed", startedAt: Date.now(), terminalVerdictPublished: true,
			pinnedCheckout: { id: checkout.id, projectId: checkout.projectId, path: checkout.path, commitSha: checkout.commitSha, contentDigest: checkout.contentDigest },
		}] }));
		await writeFile(path.join(f.source, "fixture.txt"), "live-v2-after-restart\n");

		const restartedManager = new VerificationPinnedCheckoutManager(f.state);
		let reacquireCalls = 0;
		const reacquire = restartedManager.acquire.bind(restartedManager);
		restartedManager.acquire = async input => { reacquireCalls++; return reacquire(input); };
		const resumed = await restartedManager.resume(candidate.id, checkout.projectId);
		assert.equal(await readFile(path.join(resumed.path, "fixture.txt"), "utf8"), "frozen-v1\n", "resume must never rematerialize changed live bytes");
		assert.deepEqual(resumed.contentDigest, candidate.contentDigest);
		const restarted = harnessFixture({ state: f.state, goal: goal("goal", f.source, workflow), manager: restartedManager });
		await restarted.harness.resumeInterruptedVerifications();
		assert.equal(reacquireCalls, 0, "restart must resume the persisted lease, never acquire a new source snapshot");
		assert.deepEqual(restarted.gateStore.getGate("goal", "verify")?.signals[0]?.pinnedCheckout, candidate.pinnedCheckout);
		await assert.rejects(lstat(checkout.path), /ENOENT/, "terminal active owner releases its exact persisted checkout");

		const missing = await singleFixture();
		const missingSignal = signal("88888888-8888-4888-8888-888888888888", missing.head);
		const missingInitial = new VerificationPinnedCheckoutManager(missing.state);
		const missingCheckout = await missingInitial.acquire({ signal: missingSignal, sourceRoot: missing.source, projectId: "pinned-gate-project" });
		await rm(missingCheckout.path, { recursive: true, force: true });
		const missingRestarted = new VerificationPinnedCheckoutManager(missing.state);
		await assert.rejects(missingRestarted.resume(missingSignal.id, missingCheckout.projectId), (error: unknown) =>
			error instanceof PinnedCheckoutError && error.code === "PINNED_CHECKOUT_UNREADABLE",
			"a missing public root must fail closed rather than reacquiring mutable live source",
		);
		await missingRestarted.release(missingSignal.id, missingCheckout.projectId).catch(() => {});

		const cleanup = await singleFixture();
		let failRemoval = true;
		const failingRunner: CommandRunner = {
			execFile: async (file, args, options) => {
				if (file === "git" && args.includes("worktree") && args.includes("remove") && failRemoval) {
					failRemoval = false;
					throw Object.assign(new Error("fixture busy worktree"), { code: "EBUSY" });
				}
				return realCommandRunner.execFile(file, args, options);
			},
		};
		const noRetryTimer = () => 0 as unknown as ReturnType<typeof setTimeout>;
		const pendingManager = new VerificationPinnedCheckoutManager(cleanup.state, { commandRunner: failingRunner, setTimeout: noRetryTimer, clearTimeout: () => {} });
		const pendingSignal = signal("99999999-9999-4999-8999-999999999999", cleanup.head);
		const pendingCheckout = await pendingManager.acquire({ signal: pendingSignal, sourceRoot: cleanup.source, projectId: "pinned-gate-project" });
		await assert.rejects(pendingManager.release(pendingSignal.id, pendingCheckout.projectId), (error: unknown) => error instanceof PinnedCheckoutError && error.code === "PINNED_CHECKOUT_UNREADABLE");
		assert.equal(pendingManager.getLease(pendingSignal.id)?.state, "releasing", "failed cleanup retains its exact durable owner");
		const converged = new VerificationPinnedCheckoutManager(cleanup.state);
		await converged.recover(new Map());
		assert.equal(converged.getLease(pendingSignal.id), undefined);
		await assert.rejects(lstat(pendingCheckout.path), /ENOENT/);
		assert.equal(await readFile(path.join(cleanup.source, "fixture.txt"), "utf8"), "frozen-v1\n", "recovery never sweeps the live repository");
	});

	it.skipIf(process.platform === "win32")("reuses only coherent frozen evidence and refuses changed digest or v2 repository identity", async () => {
		const f = await singleFixture();
		const gate: any = { id: "verify", name: "Verify", dependsOn: [], verify: [{ name: "check", type: "command", run: "true" }] };
		const workflow = { id: "pinned", name: "Pinned", description: "fixture", gates: [gate], createdAt: Date.now(), updatedAt: Date.now() };
		const { harness, gateStore } = harnessFixture({ state: f.state, goal: goal("goal", f.source, workflow) });
		await run(harness, gateStore, f.source, signal("33333333-3333-4333-8333-333333333333", f.head), gate);
		const prior = gateStore.getGate("goal", "verify")!.signals[0]!;
		const reused = reuseCachedGateSignal({ gateStore, goalId: "goal", gate, commitSha: f.head, contentDigest: prior.contentDigest, currentPinnedCheckout: { version: 1 }, createSignalId: () => "44444444-4444-4444-8444-444444444444", notifier: { signalReceived() {}, verificationComplete() {}, statusChanged() {} } });
		assert.equal(reused.response?.signal.cached, true);
		assert.equal(gateStore.getGate("goal", "verify")!.signals.at(-1)?.pinnedCheckout?.version, 1);
		const changed = { ...prior.contentDigest!, digest: "f".repeat(64) };
		assert.equal(reuseCachedGateSignal({ gateStore, goalId: "goal", gate, commitSha: f.head, contentDigest: changed, notifier: { signalReceived() {}, verificationComplete() {}, statusChanged() {} } }).missReason, "content-digest-mismatch");
		const v2Prior = { ...prior, id: "v2-prior", pinnedCheckout: { version: 2 as const, layout: "multi-repo" as const, contentDigest: prior.contentDigest!, repositories: [{ repoKey: "apps/web", commitSha: "a".repeat(40), contentDigest: prior.contentDigest! }, { repoKey: "services/api", commitSha: "b".repeat(40), contentDigest: prior.contentDigest! }] } };
		const v2Current = { ...prior, id: "v2-current", pinnedCheckout: { ...v2Prior.pinnedCheckout, repositories: [{ ...v2Prior.pinnedCheckout.repositories[0]!, commitSha: "c".repeat(40) }, v2Prior.pinnedCheckout.repositories[1]!] } };
		const decision = buildStepCache([v2Prior as GateSignal, v2Current as GateSignal], v2Current.id, f.head, prior.contentDigest);
		assert.equal(decision.missReason, "pinned-checkout-mismatch");
	});

	it.skipIf(process.platform === "win32")("does not repin a non-Git multi-repository container after origin sync", async () => {
		const base = createRunChild("pinned-gate-multi-repin"); roots.push(base);
		const container = path.join(base, "container"); const state = path.join(base, "state");
		const api = path.join(container, "services", "api"); const web = path.join(container, "apps", "web");
		for (const repo of [api, web]) {
			await mkdir(repo, { recursive: true }); await git(repo, "init"); await git(repo, "config", "user.email", "multi@example.test"); await git(repo, "config", "user.name", "Multi fixture");
			await writeFile(path.join(repo, "value.txt"), "frozen\n"); await git(repo, "add", "."); await git(repo, "commit", "-m", "fixture");
		}
		const gate = { id: "verify", name: "Verify", dependsOn: [], verify: [] };
		const workflow = { id: "pinned", name: "Pinned", description: "fixture", gates: [gate], createdAt: Date.now(), updatedAt: Date.now() };
		const { harness, gateStore } = harnessFixture({ state, goal: goal("goal", container, workflow, { repoWorktrees: { "services/api": api, "apps/web": web } }) });
		await run(harness, gateStore, container, signal("55555555-5555-4555-8555-555555555551", await git(api, "rev-parse", "HEAD")), gate, "goal/multi-fixture");
		const stored = gateStore.getGate("goal", "verify")!.signals[0]!;
		assert.equal(stored.verification.status, "passed");
		assert.equal(stored.pinnedCheckout?.version, 2);
		assert.equal(stored.commitSha, await git(api, "rev-parse", "HEAD"), "the non-Git container must not overwrite the display commit");
	});

	it.skipIf(process.platform === "win32")("runs a multi-repository component command from its exact pinned nested subtree", async () => {
		const base = createRunChild("pinned-gate-multi-e2e"); roots.push(base);
		const container = path.join(base, "container"); const state = path.join(base, "state");
		const api = path.join(container, "services", "api"); const web = path.join(container, "apps", "web");
		for (const repo of [api, web]) { await mkdir(path.join(repo, "packages", repo === api ? "api" : "web"), { recursive: true }); await git(repo, "init"); await git(repo, "config", "user.email", "multi@example.test"); await git(repo, "config", "user.name", "Multi fixture"); await writeFile(path.join(repo, "packages", repo === api ? "api" : "web", "value.txt"), repo === api ? "api-frozen\n" : "web-frozen\n"); await git(repo, "add", "."); await git(repo, "commit", "-m", "fixture"); }
		const gate = { id: "verify", name: "Verify", dependsOn: [], verify: [{ name: "api component", type: "command", component: "api", command: "verify" }] };
		const workflow = { id: "pinned", name: "Pinned", description: "fixture", gates: [gate], createdAt: Date.now(), updatedAt: Date.now() };
		const components = [{ name: "api", repo: "services/api", relativePath: "packages/api", commands: { verify: command("const fs=require('fs'); console.log(fs.readFileSync('value.txt','utf8').trim()); console.log(process.cwd());") } }];
		const manager = new VerificationPinnedCheckoutManager(state);
		let acquiredPath = "";
		const acquire = manager.acquire.bind(manager);
		manager.acquire = async input => { const checkout = await acquire(input); acquiredPath = checkout.path; return checkout; };
		const { harness, gateStore } = harnessFixture({ state, goal: goal("goal", container, workflow, { repoWorktrees: { "services/api": api, "apps/web": web } }), components, manager });
		const apiHead = await git(api, "rev-parse", "HEAD");
		await run(harness, gateStore, container, signal("55555555-5555-4555-8555-555555555555", apiHead), gate);
		const stored = gateStore.getGate("goal", "verify")!.signals[0]!;
		assert.equal(stored.verification.status, "passed");
		assert.match(stored.verification.steps[0]!.output, /api-frozen/);
		assert.match(stored.verification.steps[0]!.output, new RegExp(path.join(acquiredPath, "services", "api", "packages", "api").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "component command must run below this signal's acquired pinned root");
		assert.ok(!stored.verification.steps[0]!.output.includes(container), "component command must not execute from the live container");
		assert.deepEqual(stored.pinnedCheckout?.version, 2);
		assert.deepEqual((stored.pinnedCheckout as any).repositories.map((repository: any) => repository.repoKey), ["apps/web", "services/api"]);
	});
});
