import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import { GateStore, type GateSignal } from "../../src/server/agent/gate-store.ts";
import { realCommandRunner, type CommandRunner } from "../../src/server/gateway-deps.ts";
import { VerificationHarness } from "../../src/server/agent/verification-harness.ts";
import { PinnedCheckoutError, VerificationPinnedCheckoutManager } from "../../src/server/agent/verification-pinned-checkout.ts";
import { createRunChild } from "../harness/run-isolation.ts";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const SIGNAL_ID = "a0f0f0f0-0000-4000-8000-0000000000a1";

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" });
	return stdout.trim();
}

async function fixture(): Promise<{ root: string; state: string; head: string }> {
	const base = createRunChild("pinned-checkout-real-git");
	roots.push(base);
	const root = path.join(base, "repo");
	await mkdir(root);
	await git(root, "init");
	await git(root, "config", "user.email", "pinned-checkout@example.test");
	await git(root, "config", "user.name", "Pinned checkout fixture");
	await writeFile(path.join(root, ".gitignore"), "ignored/\n");
	await writeFile(path.join(root, "tracked.txt"), "before\n");
	await writeFile(path.join(root, "deleted.txt"), "delete me\n");
	await git(root, "add", ".");
	await git(root, "commit", "-m", "fixture");
	return { root, state: path.join(base, "state"), head: await git(root, "rev-parse", "HEAD") };
}

function signal(commitSha: string): GateSignal {
	return {
		id: SIGNAL_ID,
		gateId: "implementation",
		goalId: "goal",
		sessionId: "session",
		timestamp: Date.now(),
		commitSha,
		verification: { status: "running", steps: [] },
	};
}

const SYNC_BRANCH = "goal/local-behind-sync";

function fakeRetryClock() {
	let callback: (() => void | Promise<void>) | undefined;
	let delay: number | undefined;
	return {
		setTimeout: (next: () => void | Promise<void>, milliseconds: number) => {
			callback = next;
			delay = milliseconds;
			return 1 as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimeout: () => { callback = undefined; },
		delay: () => delay,
		run: async () => { await callback?.(); },
	};
}

async function localBehindFixture(): Promise<{ root: string; state: string; source: string; oldHead: string; newHead: string }> {
	const base = createRunChild("pinned-checkout-local-behind");
	roots.push(base);
	const origin = path.join(base, "origin.git");
	const seed = path.join(base, "seed");
	const source = path.join(base, "source");
	const publisher = path.join(base, "publisher");
	await execFile("git", ["init", "--bare", origin]);
	await mkdir(seed);
	await git(seed, "init");
	await git(seed, "config", "user.email", "sync@example.test");
	await git(seed, "config", "user.name", "Sync fixture");
	await writeFile(path.join(seed, "tracked.txt"), "before sync\n");
	await git(seed, "add", ".");
	await git(seed, "commit", "-m", "initial");
	await git(seed, "remote", "add", "origin", origin);
	await git(seed, "push", "origin", "HEAD:master");
	await git(seed, "checkout", "-b", SYNC_BRANCH);
	await git(seed, "push", "--set-upstream", "origin", SYNC_BRANCH);
	await execFile("git", ["clone", "--branch", SYNC_BRANCH, origin, source]);
	const oldHead = await git(source, "rev-parse", "HEAD");
	await execFile("git", ["clone", "--branch", SYNC_BRANCH, origin, publisher]);
	await git(publisher, "config", "user.email", "publisher@example.test");
	await git(publisher, "config", "user.name", "Publisher fixture");
	await writeFile(path.join(publisher, "tracked.txt"), "after sync\n");
	await git(publisher, "commit", "-am", "advance origin");
	await git(publisher, "push", "origin", SYNC_BRANCH);
	return { root: base, state: path.join(base, "state"), source, oldHead, newHead: await git(publisher, "rev-parse", "HEAD") };
}

describe("VerificationPinnedCheckoutManager real Git inventory", () => {
	it.skipIf(process.platform === "win32")("uses its exact empty root barrier rather than an enclosing repository", async () => {
		const source = await fixture();
		const enclosing = path.join(path.dirname(source.state), "enclosing-gateway-repository");
		await mkdir(enclosing);
		await git(enclosing, "init");
		const manager = new VerificationPinnedCheckoutManager(path.join(enclosing, "state"));
		const checkout = await manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });
		try {
			const barrier = await lstat(path.join(checkout.path, ".git"));
			assert.ok(barrier.isFile() && !barrier.isSymbolicLink() && barrier.size === 0);
			await assert.rejects(
				execFile("git", ["-C", checkout.path, "rev-parse", "--show-toplevel"]),
				/Git command failed|invalid gitfile|not a git repository/i,
				"Git must stop at the pinned root instead of walking into the enclosing gateway repository",
			);
		} finally {
			await manager.release(checkout.id, "test-project-id");
		}
	});

	it("retries a real Git worktree cleanup after a fake-clock busy failure", async () => {
		const source = await fixture();
		const clock = fakeRetryClock();
		let failRemove = true;
		const runner: CommandRunner = {
			execFile: async (file, args, options) => {
				if (file === "git" && args.includes("worktree") && args.includes("remove") && failRemove) {
					failRemove = false;
					throw Object.assign(new Error("simulated busy worktree"), { code: "EBUSY" });
				}
				return realCommandRunner.execFile(file, args, options);
			},
		};
		const manager = new VerificationPinnedCheckoutManager(source.state, {
			commandRunner: runner, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
		});
		const checkout = await manager.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });
		await assert.rejects(manager.release(checkout.id, checkout.projectId), (error: unknown) =>
			error instanceof PinnedCheckoutError && error.code === "PINNED_CHECKOUT_UNREADABLE"
				&& error.message === "Pinned checkout cleanup is pending",
		);
		assert.equal(clock.delay(), 1_000);
		await clock.run();
		assert.equal(manager.getLease(checkout.id), undefined);
		await assert.rejects(lstat(checkout.path), /ENOENT/);
	});

	it("attests the materialized source inventory from an empty --no-checkout worktree index, detects additions, and resumes it durably", async () => {
		const source = await fixture();
		await writeFile(path.join(source.root, "tracked.txt"), "dirty\r\n");
		await writeFile(path.join(source.root, "untracked.txt"), "untracked source\n");
		await unlink(path.join(source.root, "deleted.txt"));

		const first = new VerificationPinnedCheckoutManager(source.state);
		const checkout = await first.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });
		try {
			assert.equal(await readFile(path.join(checkout.path, "tracked.txt"), "utf8"), "dirty\r\n");
			await assert.rejects(readFile(path.join(checkout.path, "deleted.txt")), /ENOENT/);
			const barrier = await lstat(path.join(checkout.path, ".git"));
			assert.ok(barrier.isFile() && !barrier.isSymbolicLink() && barrier.size === 0, "the sandbox-visible tree exposes only its empty Git discovery barrier");
			assert.ok(checkout.contentDigest.digest);
			const persisted = JSON.parse(await readFile(path.join(source.state, "verification-checkouts.json"), "utf8"));
			assert.equal(persisted[0].sourceInventory.some((entry: { relativePath: string }) => entry.relativePath === "untracked.txt"), true);

			await mkdir(path.join(checkout.path, "ignored"));
			await writeFile(path.join(checkout.path, "ignored", "build.txt"), "generated\n");
			await first.assertUnchanged(checkout);
			await writeFile(path.join(source.root, "tracked.txt"), "live worktree changed after snapshot\n");

			const restarted = new VerificationPinnedCheckoutManager(source.state);
			const resumed = await restarted.resume(checkout.id, "test-project-id");
			assert.equal(resumed.contentDigest.digest, checkout.contentDigest.digest);
			await restarted.assertUnchanged(resumed);

			await writeFile(path.join(resumed.path, "added-by-verification.txt"), "must invalidate\n");
			await assert.rejects(
				restarted.assertUnchanged(resumed),
				(error: unknown) => error instanceof PinnedCheckoutError && error.code === "PINNED_CHECKOUT_MUTATED",
			);
			await restarted.release(resumed.id, "test-project-id");
		} catch (error) {
			await first.release(checkout.id, "test-project-id");
			throw error;
		}
	});

	it("persists only literal, private-Git-confirmed ignored output directories across restart", async () => {
		const source = await fixture();
		await writeFile(path.join(source.root, ".gitignore"), [
			"build/", "tracked.txt/", "notignored/", "!notignored/", "!negated/", "wild*/", "escaped\\/", "/anchored/", "dot/./", "outside/../escape/", "# comment/",
		].join("\n"));
		await mkdir(path.join(source.root, "packages"));
		await writeFile(path.join(source.root, "packages", ".gitignore"), "output/\n");

		const first = new VerificationPinnedCheckoutManager(source.state);
		const checkout = await first.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });
		try {
			assert.deepEqual(checkout.writableIgnoredDirectories, ["build", "packages/output"]);
			const persisted = JSON.parse(await readFile(path.join(source.state, "verification-checkouts.json"), "utf8"));
			assert.deepEqual(persisted[0].writableIgnoredDirectories, ["build", "packages/output"]);
			// The resumed lease must retain its acquisition-time authority, rather
			// than consult the subsequently mutable source ignore configuration.
			await writeFile(path.join(source.root, ".gitignore"), "changed-after-acquisition/\n");
			const restarted = new VerificationPinnedCheckoutManager(source.state);
			const resumed = await restarted.resume(checkout.id, "test-project-id");
			assert.deepEqual(resumed.writableIgnoredDirectories, ["build", "packages/output"]);
			await restarted.release(resumed.id, "test-project-id");
		} catch (error) {
			await first.release(checkout.id, "test-project-id");
			throw error;
		}
	});

	it("keeps an ignored node_modules setup link out of persisted writable outputs across restart", async () => {
		const source = await fixture();
		await writeFile(path.join(source.root, ".gitignore"), "node_modules/\ndist/\n");
		await mkdir(path.join(source.root, "node_modules", "pinned-dependency"), { recursive: true });
		await writeFile(path.join(source.root, "node_modules", "pinned-dependency", "index.js"), "module.exports = 'source dependency';\n");
		const first = new VerificationPinnedCheckoutManager(source.state);
		const checkout = await first.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });
		try {
			assert.deepEqual(checkout.writableIgnoredDirectories, ["dist"]);
			assert.equal((await lstat(path.join(checkout.path, "node_modules"))).isSymbolicLink(), true, "the dependency link remains available outside writable output mounts");
			const statePath = path.join(source.state, "verification-checkouts.json");
			const persisted = JSON.parse(await readFile(statePath, "utf8"));
			assert.deepEqual(persisted[0].writableIgnoredDirectories, ["dist"]);

			const resumed = await new VerificationPinnedCheckoutManager(source.state).resume(checkout.id, "test-project-id");
			assert.deepEqual(resumed.writableIgnoredDirectories, ["dist"], "restart retains the narrow frozen output authority");
			persisted[0].writableIgnoredDirectories = ["node_modules"];
			await writeFile(statePath, JSON.stringify(persisted));
			await assert.rejects(new VerificationPinnedCheckoutManager(source.state).resume(checkout.id, "test-project-id"), /invalid writable ignored directory/);
		} finally {
			await first.release(checkout.id, "test-project-id");
		}
	});

	it("rejects a tampered persisted ignored-output allowlist on restart", async () => {
		const source = await fixture();
		const first = new VerificationPinnedCheckoutManager(source.state);
		const checkout = await first.acquire({ signal: signal(source.head), sourceRoot: source.root, projectId: "test-project-id" });
		try {
			const statePath = path.join(source.state, "verification-checkouts.json");
			const persisted = JSON.parse(await readFile(statePath, "utf8"));
			persisted[0].writableIgnoredDirectories = ["../outside"];
			await writeFile(statePath, JSON.stringify(persisted));
			const restarted = new VerificationPinnedCheckoutManager(source.state);
			await assert.rejects(restarted.resume(checkout.id, "test-project-id"));
			await first.release(checkout.id, "test-project-id");
		} catch (error) {
			await first.release(checkout.id, "test-project-id");
			throw error;
		}
	});

	it("durably repins a local-behind signal to the verified post-sync HEAD before real checkout acquisition", async () => {
		const fixture = await localBehindFixture();
		const gateStore = new GateStore(fixture.state);
		const goalId = "local-behind-goal";
		const gateId = "implementation";
		gateStore.initGatesForGoal(goalId, [gateId]);
		const gateSignal = signal(fixture.oldHead);
		gateSignal.goalId = goalId;
		gateSignal.gateId = gateId;
		gateStore.recordSignal(gateSignal);
		const projectConfigStore = { get: () => "", getWithDefaults: () => ({}), getComponents: () => [] };
		const goal = { id: goalId, branch: SYNC_BRANCH, cwd: fixture.source, worktreePath: fixture.source, spec: "sync fixture", state: "in-progress", workflowId: "feature" };
		const projectContextManager = {
			getContextForGoal: (id: string) => id === goalId ? {
				project: { id: "real-sync-project" },
				goalStore: { get: (candidate: string) => candidate === goalId ? goal : undefined },
				gateStore,
				projectConfigStore,
			} : null,
		};
		const harness = new VerificationHarness(
			fixture.state, gateStore, () => {}, { get: () => null, getAll: () => [] } as any,
			undefined, undefined, undefined, projectConfigStore as any, projectContextManager as any,
		);
		(harness as any).runCommandStep = async () => ({ passed: true, output: "verified" });
		const workflowGate = {
			id: gateId, name: "Implementation", dependsOn: [],
			verify: [{ name: "verify synced snapshot", type: "command", run: "echo verified" }],
		} as any;

		await harness.verifyGateSignal(gateSignal, workflowGate, fixture.source, SYNC_BRANCH, "master", new Map(), goal.spec);
		await gateStore.flush();

		const persisted = gateStore.getGate(goalId, gateId)?.signals[0];
		assert.equal(await git(fixture.source, "rev-parse", "HEAD"), fixture.newHead, "the live goal worktree must fast-forward");
		assert.equal(gateSignal.commitSha, fixture.newHead, "the in-memory signal must be repinned before acquisition");
		assert.equal(persisted?.commitSha, fixture.newHead, "the GateStore signal must durably record the post-sync SHA");
		const attestation = persisted?.pinnedCheckout;
		assert.ok(attestation && attestation.version === 1, "the single-repository checkout must retain its v1 attestation");
		assert.equal(attestation.commitSha, fixture.newHead, "the checkout attestation must match the repinned signal");
		assert.equal(persisted?.verification.status, "passed");
	});
});
