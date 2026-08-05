import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import type { CommandRunner, ExecFileOptions } from "../../src/server/gateway-deps.ts";
import type { GateSignal } from "../../src/server/agent/gate-store.ts";
import type { VerificationSourceInventoryEntry } from "../../src/server/agent/verification-content-digest.ts";
import {
	PinnedCheckoutError,
	VerificationPinnedCheckoutManager,
} from "../../src/server/agent/verification-pinned-checkout.ts";
import { copyGitTemplate } from "../harness/git-template.ts";
import { createRunChild } from "../harness/run-isolation.ts";

const HEAD = "a".repeat(40);
const SIGNAL_ID = "a0f0f0f0-0000-4000-8000-000000000001";

interface Fixture {
	base: string;
	root: string;
	state: string;
	head: string;
	inventory: { tracked: string[]; untracked: string[] };
}

interface GitCall {
	args: string[];
	options?: ExecFileOptions;
}

interface FakeGit {
	runner: CommandRunner;
	calls: GitCall[];
	failNextRemove(): void;
}

const roots: string[] = [];
afterEach(async () => {
	// The coordinator owns run-root cleanup. This removes only a child created by
	// this worker, so failed fixtures never leak into a later test in this file.
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(options: { symlink?: boolean } = {}): Promise<Fixture> {
	const base = createRunChild("pinned-checkout");
	roots.push(base);
	const root = path.join(base, "repo");
	copyGitTemplate(root);
	const state = path.join(base, "state");
	await writeFile(path.join(root, ".gitignore"), "ignored/\n");
	await writeFile(path.join(root, ".gitattributes"), "raw.txt text\n");
	await writeFile(path.join(root, "raw.txt"), "before\n");
	await writeFile(path.join(root, "staged.txt"), "before staging\n");
	await writeFile(path.join(root, "deleted.txt"), "delete me\n");
	await writeFile(path.join(root, "exec.sh"), "#!/bin/sh\necho old\n");
	await chmod(path.join(root, "exec.sh"), 0o755);
	const inventory = {
		tracked: [".gitignore", ".gitattributes", "raw.txt", "staged.txt", "deleted.txt", "exec.sh"],
		untracked: [] as string[],
	};
	if (options.symlink) {
		await symlink("raw.txt", path.join(root, "link"));
		inventory.tracked.push("link");
	}
	return { base, root, state, head: HEAD, inventory };
}

function nul(entries: readonly string[]): Buffer {
	return Buffer.concat(entries.flatMap(entry => [Buffer.from(entry), Buffer.from("\0")]));
}

/**
 * A deterministic Git boundary: core tests never spawn, while the manager still
 * receives the exact worktree and NUL-inventory protocol it owns in production.
 */
function fakeGit(source: Fixture): FakeGit {
	const calls: GitCall[] = [];
	let failRemove = false;
	const empty = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
	return {
		calls,
		failNextRemove: () => { failRemove = true; },
		runner: {
			execFile: async (file, args, options) => {
				assert.equal(file, "git", "manager invokes Git by executable, never a shell");
				const command = [...args];
				calls.push({ args: command, options });
				if (command.includes("--show-toplevel")) return { stdout: `${source.root}\n`, stderr: "" };
				if (command.includes("--verify") && command.includes("HEAD^{commit}")) return { stdout: `${source.head}\n`, stderr: "" };
				if (command.includes("ls-files")) {
					return { stdout: nul(command.includes("--cached") ? source.inventory.tracked : source.inventory.untracked), stderr: Buffer.alloc(0) };
				}
				if (command.includes("worktree") && command.includes("add")) {
					await mkdir(command.at(-2)!, { recursive: true });
					return empty;
				}
				if (command.includes("worktree") && command.includes("remove")) {
					if (failRemove) {
						failRemove = false;
						throw Object.assign(new Error("worktree is busy"), { code: "EBUSY" });
					}
					await rm(command.at(-1)!, { recursive: true, force: true });
					return empty;
				}
				throw new Error(`unexpected Git command: ${command.join(" ")}`);
			},
		},
	};
}

function signal(head: string): GateSignal {
	return {
		id: SIGNAL_ID, gateId: "implementation", goalId: "goal", sessionId: "session",
		timestamp: Date.now(), commitSha: head,
		verification: { status: "running", steps: [] },
	};
}

const isPinnedError = (code: PinnedCheckoutError["code"]) =>
	(error: unknown) => error instanceof PinnedCheckoutError && error.code === code;

describe("VerificationPinnedCheckoutManager", () => {
	it("materializes dirty, staged, untracked, deleted, and executable raw source bytes, detects mutation, and releases only its lease", async () => {
		const source = await fixture();
		await writeFile(path.join(source.root, "raw.txt"), "dirty\r\n");
		// Git inventory identifies a staged file by name; D-3 must copy its working
		// bytes rather than a filtered Git blob.
		await writeFile(path.join(source.root, "staged.txt"), "staged source bytes\n");
		await writeFile(path.join(source.root, "new.txt"), "untracked\n");
		await unlink(path.join(source.root, "deleted.txt"));
		await writeFile(path.join(source.root, "exec.sh"), "#!/bin/sh\necho dirty\n");
		await chmod(path.join(source.root, "exec.sh"), 0o755);
		await writeFile(path.join(source.root, "ignored"), "not in the Git inventory");
		source.inventory.untracked.push("new.txt");

		const git = fakeGit(source);
		const manager = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		const checkout = await manager.acquire({ signal: signal(source.head), sourceRoot: source.root });
		assert.equal(await readFile(path.join(checkout.path, "raw.txt"), "utf8"), "dirty\r\n", "does not apply Git text filters");
		assert.equal(await readFile(path.join(checkout.path, "staged.txt"), "utf8"), "staged source bytes\n");
		assert.equal(await readFile(path.join(checkout.path, "new.txt"), "utf8"), "untracked\n");
		await assert.rejects(readFile(path.join(checkout.path, "deleted.txt")), /ENOENT/);
		await assert.rejects(readFile(path.join(checkout.path, "ignored")), /ENOENT/);
		assert.equal((await lstat(path.join(checkout.path, "exec.sh"))).mode & 0o111, 0o111);
		assert.ok(checkout.contentDigest.digest);
		await manager.assertUnchanged(checkout);

		const reacquired = await manager.acquire({ signal: signal(source.head), sourceRoot: source.root });
		assert.equal(reacquired.path, checkout.path, "a signal owns one durable checkout");
		await chmod(path.join(checkout.path, "raw.txt"), 0o644);
		await writeFile(path.join(checkout.path, "raw.txt"), "mutated\n");
		await assert.rejects(manager.assertUnchanged(checkout), isPinnedError("PINNED_CHECKOUT_MUTATED"));
		await manager.release(checkout.id);
		assert.equal(manager.getDiagnostics().leaseCount, 0);
		await assert.rejects(readFile(checkout.path), /ENOENT/);
		assert.ok(git.calls.every(call => call.options?.env?.GIT_DIR === undefined && call.options?.env?.GIT_WORK_TREE === undefined && call.options?.env?.GIT_INDEX_FILE === undefined), "every Git call clears ambient repository selectors");
	});

	it.skipIf(process.platform === "win32")("preserves in-root symlinks as source links rather than dereferencing them", async () => {
		const source = await fixture({ symlink: true });
		const git = fakeGit(source);
		const manager = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		const checkout = await manager.acquire({ signal: signal(source.head), sourceRoot: source.root });
		assert.equal((await lstat(path.join(checkout.path, "link"))).isSymbolicLink(), true);
		assert.equal(await readFile(path.join(checkout.path, "link"), "utf8"), "before\n");
		await manager.release(checkout.id);
	});

	it("fails closed for stale commits, untrusted identifiers, and unsupported nested source roots without creating a lease", async () => {
		const source = await fixture();
		const git = fakeGit(source);
		const manager = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		await assert.rejects(manager.acquire({ signal: signal("0".repeat(40)), sourceRoot: source.root }), isPinnedError("PINNED_CHECKOUT_ACQUIRE_FAILED"));
		await assert.rejects(manager.acquire({ signal: { ...signal(source.head), id: "../worktree" }, sourceRoot: source.root }), isPinnedError("PINNED_CHECKOUT_ACQUIRE_FAILED"));
		assert.deepEqual(manager.getDiagnostics(), { leaseCount: 0, cleanupPending: 0 });
		assert.equal(git.calls.some(call => call.args.includes("worktree")), false, "untrusted signal input never reaches Git argv");

		const nested = path.join(source.root, "nested");
		await mkdir(nested);
		await assert.rejects(manager.acquire({ signal: signal(source.head), sourceRoot: nested }), isPinnedError("PINNED_CHECKOUT_UNSUPPORTED_LAYOUT"));
		assert.deepEqual(manager.getDiagnostics(), { leaseCount: 0, cleanupPending: 0 });
	});

	it("fails closed on an escaping or special-file inventory entry before it can materialize outside the lease", async () => {
		const source = await fixture();
		const git = fakeGit(source);
		const unsafe = (relativePath: string): VerificationSourceInventoryEntry => ({
			relativePath, rawPath: Buffer.from(relativePath), membership: "tracked",
		});
		for (const entry of [unsafe("../escaped"), unsafe("submodule")]) {
			if (entry.relativePath === "submodule") await mkdir(path.join(source.root, entry.relativePath));
			const manager = new VerificationPinnedCheckoutManager(source.state, {
				commandRunner: git.runner,
				readInventory: async () => [entry],
			});
			await assert.rejects(manager.acquire({ signal: signal(source.head), sourceRoot: source.root }), isPinnedError("PINNED_CHECKOUT_ACQUIRE_FAILED"));
			assert.deepEqual(manager.getDiagnostics(), { leaseCount: 0, cleanupPending: 0 });
		}
		assert.equal(git.calls.filter(call => call.args.includes("worktree") && call.args.includes("remove")).length, 2, "each rejected materialization cleans only its own transient lease");
	});

	it("resumes a durable ready lease after restart without consulting live source bytes", async () => {
		const source = await fixture();
		const git = fakeGit(source);
		const checkout = await new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner })
			.acquire({ signal: signal(source.head), sourceRoot: source.root });
		git.calls.splice(0);
		await writeFile(path.join(source.root, "raw.txt"), "live tree changed after signal\n");

		const resumed = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		const restored = await resumed.resume(checkout.id);
		assert.equal(restored.path, checkout.path);
		assert.equal(await readFile(path.join(restored.path, "raw.txt"), "utf8"), "before\n");
		assert.equal(git.calls.some(call => call.args.includes("ls-files") && call.args[1] === source.root), false, "restart verification reads the lease checkout, not mutable source");
		await resumed.release(restored.id);
	});

	it("recovers orphaned leases without sweeping active or unrelated worktrees", async () => {
		const source = await fixture();
		const git = fakeGit(source);
		const first = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		const checkout = await first.acquire({ signal: signal(source.head), sourceRoot: source.root });
		const unrelated = path.join(source.base, "unrelated-worktree");
		await mkdir(unrelated);
		await writeFile(path.join(unrelated, "keep.txt"), "must survive\n");

		const active = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		await active.recover(new Set([checkout.id]));
		assert.equal(active.getLease(checkout.id)?.state, "ready");
		assert.equal(await readFile(path.join(unrelated, "keep.txt"), "utf8"), "must survive\n");

		await active.recover(new Set());
		assert.equal(active.getLease(checkout.id), undefined);
		await assert.rejects(readFile(checkout.path), /ENOENT/);
		assert.equal(await readFile(path.join(unrelated, "keep.txt"), "utf8"), "must survive\n");
		const removes = git.calls.filter(call => call.args.includes("worktree") && call.args.includes("remove"));
		assert.deepEqual(removes.map(call => call.args.at(-1)), [checkout.path]);
	});

	it("persists failed cleanup for restart recovery and exposes bounded diagnostics", async () => {
		const source = await fixture();
		const git = fakeGit(source);
		const first = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		const checkout = await first.acquire({ signal: signal(source.head), sourceRoot: source.root });
		git.failNextRemove();
		await first.release(checkout.id);
		assert.deepEqual(first.getDiagnostics(), { leaseCount: 1, cleanupPending: 1 });
		assert.equal(first.getLease(checkout.id)?.lastCleanupErrorCode, "PATH_BUSY");

		const restarted = new VerificationPinnedCheckoutManager(source.state, { commandRunner: git.runner });
		assert.equal(restarted.getLease(checkout.id)?.state, "releasing");
		await restarted.recover(new Set());
		assert.deepEqual(restarted.getDiagnostics(), { leaseCount: 0, cleanupPending: 0 });
		await assert.rejects(readFile(checkout.path), /ENOENT/);
	});
});
