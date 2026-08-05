import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import type { GateSignal } from "../../src/server/agent/gate-store.ts";
import {
	PinnedCheckoutError,
	VerificationPinnedCheckoutManager,
} from "../../src/server/agent/verification-pinned-checkout.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function git(root: string, args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

async function fixture(): Promise<{ root: string; state: string; head: string }> {
	const base = await mkdtemp(path.join(os.tmpdir(), "bobbit-pinned-checkout-"));
	roots.push(base);
	const root = path.join(base, "repo");
	const state = path.join(base, "state");
	execFileSync("git", ["init", root], { stdio: "ignore" });
	git(root, ["config", "user.email", "test@example.invalid"]);
	git(root, ["config", "user.name", "Pinned checkout test"]);
	await writeFile(path.join(root, ".gitignore"), "ignored/\n");
	await writeFile(path.join(root, ".gitattributes"), "raw.txt text\n");
	await writeFile(path.join(root, "raw.txt"), "before\n");
	await writeFile(path.join(root, "deleted.txt"), "delete me\n");
	await writeFile(path.join(root, "exec.sh"), "#!/bin/sh\necho old\n");
	await chmod(path.join(root, "exec.sh"), 0o755);
	await symlink("raw.txt", path.join(root, "link"));
	git(root, ["add", "-A"]);
	git(root, ["commit", "-m", "initial"]);
	return { root, state, head: git(root, ["rev-parse", "HEAD"]) };
}

function signal(head: string): GateSignal {
	return {
		id: "a0f0f0f0-0000-4000-8000-000000000001", gateId: "implementation", goalId: "goal", sessionId: "session",
		timestamp: Date.now(), commitSha: head,
		verification: { status: "running", steps: [] },
	};
}

describe("VerificationPinnedCheckoutManager", () => {
	it.skipIf(process.platform === "win32")("materializes dirty raw source bytes and detects mutations", async () => {
		const { root, state, head } = await fixture();
		await writeFile(path.join(root, "raw.txt"), "dirty\r\n");
		await writeFile(path.join(root, "new.txt"), "untracked\n");
		await unlink(path.join(root, "deleted.txt"));
		await writeFile(path.join(root, "exec.sh"), "#!/bin/sh\necho dirty\n");
		await chmod(path.join(root, "exec.sh"), 0o755);
		await symlink("new.txt", path.join(root, "new-link"));
		await writeFile(path.join(root, "ignored"), "not a directory");

		const manager = new VerificationPinnedCheckoutManager(state);
		const checkout = await manager.acquire({ signal: signal(head), sourceRoot: root });
		assert.equal(await readFile(path.join(checkout.path, "raw.txt"), "utf8"), "dirty\r\n", "does not apply Git text filters");
		assert.equal(await readFile(path.join(checkout.path, "new.txt"), "utf8"), "untracked\n");
		await assert.rejects(readFile(path.join(checkout.path, "deleted.txt")), /ENOENT/);
		assert.equal(await readFile(path.join(checkout.path, "new-link"), "utf8"), "untracked\n");
		assert.equal((await lstat(path.join(checkout.path, "exec.sh"))).mode & 0o111, 0o111);
		assert.ok(checkout.contentDigest.digest);
		await manager.assertUnchanged(checkout);

		await chmod(path.join(checkout.path, "raw.txt"), 0o644);
		await writeFile(path.join(checkout.path, "raw.txt"), "mutated\n");
		await assert.rejects(manager.assertUnchanged(checkout), (error: unknown) => error instanceof PinnedCheckoutError && error.code === "PINNED_CHECKOUT_MUTATED");
		await manager.release(checkout.id);
		assert.equal(manager.getDiagnostics().leaseCount, 0);
	});

	it("fails closed for a stale commit and leaves no lease", async () => {
		const { root, state } = await fixture();
		const manager = new VerificationPinnedCheckoutManager(state);
		await assert.rejects(
			manager.acquire({ signal: signal("0".repeat(40)), sourceRoot: root }),
			(error: unknown) => error instanceof PinnedCheckoutError && error.code === "PINNED_CHECKOUT_ACQUIRE_FAILED",
		);
		assert.deepEqual(manager.getDiagnostics(), { leaseCount: 0, cleanupPending: 0 });
	});

	it.skipIf(process.platform === "win32")("recovers an orphaned ready lease without sweeping other worktrees", async () => {
		const { root, state, head } = await fixture();
		const first = new VerificationPinnedCheckoutManager(state);
		const checkout = await first.acquire({ signal: signal(head), sourceRoot: root });
		const resumed = new VerificationPinnedCheckoutManager(state);
		assert.equal(resumed.getLease(checkout.id)?.state, "ready");
		await resumed.recover(new Set());
		assert.equal(resumed.getLease(checkout.id), undefined);
		await assert.rejects(readFile(checkout.path), /ENOENT/);
		assert.equal(git(root, ["worktree", "list", "--porcelain"]).includes(checkout.path), false);
	});
});
