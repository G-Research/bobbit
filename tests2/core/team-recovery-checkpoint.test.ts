import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import {
	FileTeamRecoveryCheckpointStore,
	TEAM_FORENSIC_RECOVERY_CHECKPOINT_FILE,
	TEAM_FORENSIC_RECOVERY_VERSION,
} from "../../src/server/agent/team-recovery-checkpoint.ts";

const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
});

async function tempStateDir(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bobbit-team-recovery-checkpoint-"));
	cleanup.push(dir);
	return dir;
}

describe("team forensic recovery checkpoint", () => {
	it("treats missing, running, corrupt, and older-version records as incomplete", async () => {
		const stateDir = await tempStateDir();
		const store = new FileTeamRecoveryCheckpointStore();
		const file = path.join(stateDir, TEAM_FORENSIC_RECOVERY_CHECKPOINT_FILE);

		assert.equal(await store.isComplete(stateDir), false);
		await store.begin(stateDir);
		assert.equal(await store.isComplete(stateDir), false, "a crash after begin must force a retry");
		await fs.promises.writeFile(file, "not json", "utf-8");
		assert.equal(await store.isComplete(stateDir), false);
		await fs.promises.writeFile(file, JSON.stringify({ version: TEAM_FORENSIC_RECOVERY_VERSION - 1, status: "complete" }), "utf-8");
		assert.equal(await store.isComplete(stateDir), false, "a recovery policy version bump must invalidate old work");
	});

	it("publishes completion atomically after a running checkpoint", async () => {
		const stateDir = await tempStateDir();
		const store = new FileTeamRecoveryCheckpointStore();

		await store.begin(stateDir);
		await store.complete(stateDir);

		assert.equal(await store.isComplete(stateDir), true);
		const names = await fs.promises.readdir(stateDir);
		assert.deepEqual(names, [TEAM_FORENSIC_RECOVERY_CHECKPOINT_FILE]);
	});
});
