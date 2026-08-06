import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import type { GateSignal } from "../../src/server/agent/gate-store.ts";
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

describe("VerificationPinnedCheckoutManager real Git inventory", () => {
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
			assert.equal(await git(checkout.path, "ls-files", "--cached"), "", "real --no-checkout worktrees have no usable target inventory");
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
});
