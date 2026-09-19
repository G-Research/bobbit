import assert from "node:assert/strict";
import { lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { removeOwnedPathInSubprocess } from "../../../../scripts/testing-v2/owned-path-cleanup.mjs";
import { spawnTracked } from "../../../../src/server/agent/spawn-tree.js";

test("removes an owned root through the real isolated cleanup process", async () => {
	const ownerRoot = await mkdtemp(join(tmpdir(), "bobbit-owned-cleanup-child-"));
	await writeFile(join(ownerRoot, "entry.txt"), "owned");
	try {
		const result = await removeOwnedPathInSubprocess(ownerRoot, {
			ownerRoot,
			allowOwnerRoot: true,
			owner: { kind: "coordinator", id: "subprocess-integration" },
			deadlineMs: 5_000,
			traversalConcurrency: 8,
			subprocessThreadPoolSize: 8,
		});
		assert.equal(result.removed, true);
		assert.equal(result.attempts, 1);
		await assert.rejects(lstat(ownerRoot), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
	} finally {
		await rm(ownerRoot, { recursive: true, force: true });
	}
});

test("timeout settles only after the real deleting child closes and its tree exits", { timeout: 25_000 }, async () => {
	const ownerRoot = await mkdtemp(join(tmpdir(), "bobbit-owned-cleanup-timeout-"));
	const fixture = fileURLToPath(new URL("../../../support/fixtures/owned-path-cleanup-stall.mjs", import.meta.url));
	const entryCount = 300;
	await Promise.all(Array.from({ length: entryCount }, (_, index) => writeFile(join(ownerRoot, `${index}.txt`), "owned")));
	const startedAt = Date.now();
	try {
		const failure = await removeOwnedPathInSubprocess(ownerRoot, {
			ownerRoot,
			allowOwnerRoot: true,
			owner: { kind: "coordinator", id: "subprocess-timeout-integration" },
			deadlineMs: 7_000,
			subprocessThreadPoolSize: 8,
		}, {
			spawnOwned: (_modulePath: string, env: NodeJS.ProcessEnv, onSpawned: (tracked: ReturnType<typeof spawnTracked>) => void) => {
				const tracked = spawnTracked(process.execPath, [fixture], {
					env,
					stdio: ["pipe", "pipe", "inherit"],
					windowsHide: true,
				});
				onSpawned(tracked);
				return tracked;
			},
		}).then(() => undefined, (error: unknown) => error) as Error & {
			code?: string;
			lifecycle?: { subprocess?: Record<string, unknown> };
		};

		assert.equal(failure.code, "ECLEANUPSUBPROCESSTIMEOUT");
		assert.equal(failure.lifecycle?.subprocess?.terminationRequested, true);
		assert.equal(failure.lifecycle?.subprocess?.treeExitVerified, true);
		assert.equal(failure.lifecycle?.subprocess?.closed, true);
		assert.ok(Date.now() - startedAt < 18_000, "termination and proof must remain bounded");
		const immediatelyAfterSettlement = (await readdir(ownerRoot)).length;
		assert.ok(immediatelyAfterSettlement > 0, "timeout must retain undeleted diagnostics");
		assert.ok(immediatelyAfterSettlement < entryCount, "the real child must begin deletion before timeout");
		assert.equal((await readdir(ownerRoot)).length, immediatelyAfterSettlement, "no deletion may continue after settlement");
	} finally {
		await rm(ownerRoot, { recursive: true, force: true });
	}
});
