import assert from "node:assert/strict";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { removeOwnedPathInSubprocess } from "../../../../scripts/testing-v2/owned-path-cleanup.mjs";

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
