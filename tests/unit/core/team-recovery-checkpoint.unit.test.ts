import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import {
	FileTeamRecoveryCheckpointStore,
	TEAM_FORENSIC_RECOVERY_CHECKPOINT_FILE,
	TEAM_FORENSIC_RECOVERY_COMPLETION_FENCE_FILE,
	TEAM_FORENSIC_RECOVERY_VERSION,
} from "../../../src/server/agent/team-recovery-checkpoint.ts";

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

	it("retains retry authority when directory sync fails after the complete rename", async () => {
		const stateDir = await tempStateDir();
		const store = new FileTeamRecoveryCheckpointStore();
		const marker = path.join(stateDir, TEAM_FORENSIC_RECOVERY_CHECKPOINT_FILE);
		const fence = path.join(stateDir, TEAM_FORENSIC_RECOVERY_COMPLETION_FENCE_FILE);
		await store.begin(stateDir);

		const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		const realOpen = fs.promises.open.bind(fs.promises);
		let injected = false;
		const openSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
			const handle = await realOpen(...args);
			if (path.resolve(String(args[0])) !== path.resolve(stateDir)) return handle;
			return new Proxy(handle, {
				get(target, property) {
					if (property === "sync") return async () => {
						const checkpoint = JSON.parse(await fs.promises.readFile(marker, "utf-8")) as { status?: string };
						if (!injected && checkpoint.status === "complete" && await fs.promises.access(fence).then(() => true, () => false)) {
							injected = true;
							const error = new Error("INJECTED_POST_RENAME_DIRECTORY_FSYNC_EIO") as NodeJS.ErrnoException;
							error.code = "EIO";
							throw error;
						}
						return target.sync();
					};
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}) as fs.promises.FileHandle;
		});
		try {
			await assert.rejects(store.complete(stateDir), /INJECTED_POST_RENAME_DIRECTORY_FSYNC_EIO/);
			assert.equal(JSON.parse(await fs.promises.readFile(marker, "utf-8")).status, "complete", "precondition: rename made complete visible before directory fsync failed");
			assert.equal(await store.isComplete(stateDir), false, "RECOVERY_COMPLETION_FENCE: a visible but unacknowledged complete marker must remain retryable");
			assert.equal(await fs.promises.access(fence).then(() => true, () => false), true, "RECOVERY_COMPLETION_FENCE: failed publication must retain its sibling fence");
		} finally {
			openSpy.mockRestore();
			platformSpy.mockRestore();
		}

		await store.begin(stateDir);
		await store.complete(stateDir);
		assert.equal(await store.isComplete(stateDir), true, "RECOVERY_COMPLETION_FENCE: a later successful pass may publish completion");
		assert.deepEqual(await fs.promises.readdir(stateDir), [TEAM_FORENSIC_RECOVERY_CHECKPOINT_FILE]);
	});

	it("republishes retry authority when fence-clear acknowledgement fails", async () => {
		const stateDir = await tempStateDir();
		const store = new FileTeamRecoveryCheckpointStore();
		const marker = path.join(stateDir, TEAM_FORENSIC_RECOVERY_CHECKPOINT_FILE);
		const fence = path.join(stateDir, TEAM_FORENSIC_RECOVERY_COMPLETION_FENCE_FILE);
		await store.begin(stateDir);

		const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		const realOpen = fs.promises.open.bind(fs.promises);
		let injected = false;
		const openSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
			const handle = await realOpen(...args);
			if (path.resolve(String(args[0])) !== path.resolve(stateDir)) return handle;
			return new Proxy(handle, {
				get(target, property) {
					if (property === "sync") return async () => {
						const checkpoint = JSON.parse(await fs.promises.readFile(marker, "utf-8")) as { status?: string };
						const fenceExists = await fs.promises.access(fence).then(() => true, () => false);
						if (!injected && checkpoint.status === "complete" && !fenceExists) {
							injected = true;
							const error = new Error("INJECTED_FENCE_CLEAR_DIRECTORY_FSYNC_EIO") as NodeJS.ErrnoException;
							error.code = "EIO";
							throw error;
						}
						return target.sync();
					};
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}) as fs.promises.FileHandle;
		});
		try {
			await assert.rejects(store.complete(stateDir), /INJECTED_FENCE_CLEAR_DIRECTORY_FSYNC_EIO/);
			assert.equal(injected, true, "precondition: failure occurs only after the fence is absent");
			assert.equal(JSON.parse(await fs.promises.readFile(marker, "utf-8")).status, "complete");
			assert.equal(await fs.promises.access(fence).then(() => true, () => false), true, "RECOVERY_COMPLETION_FENCE: failed fence-clear acknowledgement must republish retry authority");
			assert.equal(await store.isComplete(stateDir), false, "RECOVERY_COMPLETION_FENCE: reported completion failure must remain retryable on the next boot");
		} finally {
			openSpy.mockRestore();
			platformSpy.mockRestore();
		}

		await store.begin(stateDir);
		await store.complete(stateDir);
		assert.equal(await store.isComplete(stateDir), true, "RECOVERY_COMPLETION_FENCE: a later acknowledged completion restores the clean fast path");
		assert.deepEqual(await fs.promises.readdir(stateDir), [TEAM_FORENSIC_RECOVERY_CHECKPOINT_FILE]);
	});

	it("preserves the prior checkpoint when durable temporary-file publication is interrupted", async () => {
		const stateDir = await tempStateDir();
		const store = new FileTeamRecoveryCheckpointStore();
		await store.complete(stateDir);
		const realOpen = fs.promises.open.bind(fs.promises);
		const openSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
			const handle = await realOpen(...args);
			return new Proxy(handle, {
				get(target, property) {
					if (property === "sync") return async () => { throw new Error("INJECTED_CHECKPOINT_FSYNC_INTERRUPTION"); };
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}) as fs.promises.FileHandle;
		});
		try {
			await assert.rejects(
				store.begin(stateDir),
				/INJECTED_CHECKPOINT_FSYNC_INTERRUPTION/,
				"RECOVERY_CHECKPOINT_ATOMICITY: checkpoint publication must flush its temporary file before rename",
			);
			assert.equal(await store.isComplete(stateDir), true, "RECOVERY_CHECKPOINT_ATOMICITY: an interrupted replacement must preserve the prior valid checkpoint");
			assert.deepEqual(await fs.promises.readdir(stateDir), [TEAM_FORENSIC_RECOVERY_CHECKPOINT_FILE], "RECOVERY_CHECKPOINT_ATOMICITY: interrupted temporary files must be cleaned up");
		} finally {
			openSpy.mockRestore();
		}
	});
});
