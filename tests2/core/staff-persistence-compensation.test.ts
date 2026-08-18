import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StaffStore, type PersistedStaff } from "../../src/server/agent/staff-store.ts";
import { StaffManager } from "../../src/server/agent/staff-manager.ts";

const roots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeStaff(id: string): PersistedStaff {
	return {
		id,
		name: "Persistence Staff",
		description: "",
		systemPrompt: "prompt",
		cwd: "/project",
		state: "active",
		triggers: [],
		memory: "",
		accessory: "none",
		createdAt: 1,
		updatedAt: 2,
		projectId: "project",
		sandboxed: false,
	};
}

function failStaffRenames(enabled: () => boolean): void {
	const rename = fs.renameSync.bind(fs);
	vi.spyOn(fs, "renameSync").mockImplementation(((source, destination) => {
		if (enabled() && String(destination).endsWith(`${path.sep}staff.json`)) {
			throw new Error("injected staff save failure");
		}
		return rename(source, destination);
	}) as typeof fs.renameSync);
}

function makeManager() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "staff-persistence-compensation-"));
	roots.push(root);
	const store = new StaffStore(path.join(root, "state"));
	const searchIndex = { indexStaff: vi.fn(), removeStaff: vi.fn() };
	const context = {
		project: { id: "project", rootPath: "/project" },
		staffStore: store,
		searchIndex,
		projectConfigStore: { get: () => undefined, getComponents: () => [] },
	};
	const pcm = { getOrCreate: () => context, all: () => [context].values() };
	const manager = new StaffManager(pcm as any);
	const provision = vi.spyOn(manager as any, "provisionStaffWorktree").mockResolvedValue({
		branchName: "staff-persistence",
		repoPath: "/project",
		worktreePath: "/project-wt/staff-persistence",
		sessionCwd: "/project-wt/staff-persistence",
	});
	const cleanup = vi.spyOn(manager as any, "cleanupStaffWorktree").mockResolvedValue(undefined);
	return { manager, store, provision, cleanup, searchIndex };
}

function sessionManager(createSession: () => Promise<any>): any {
	return {
		createSession,
		setTitle: vi.fn(),
		updateSessionMeta: vi.fn(),
		persistSessionMetadata: vi.fn(),
	};
}

describe("staff persistence compensation", () => {
	it("restores the exact pre-update staff record when its atomic save fails", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "staff-store-rollback-"));
		roots.push(root);
		const store = new StaffStore(root);
		store.put(makeStaff("staff-1"));
		const before = structuredClone(store.get("staff-1")!);

		failStaffRenames(() => true);
		expect(() => store.update("staff-1", { name: "Changed", currentSessionId: "session-1" })).toThrow("injected staff save failure");
		expect(store.get("staff-1")).toEqual(before);
	});

	it("cleans a provisioned worktree when the initial staff save fails", async () => {
		const { manager, store, cleanup, searchIndex } = makeManager();
		failStaffRenames(() => true);

		await expect(manager.createStaff("Persistence Staff", "", "prompt", "/project", sessionManager(async () => ({ id: "never" })), {
			projectId: "project", worktree: true,
		})).rejects.toThrow("injected staff save failure");

		expect(cleanup).toHaveBeenCalledOnce();
		expect(store.getAll()).toEqual([]);
		expect(searchIndex.indexStaff).not.toHaveBeenCalled();
	});

	it("keeps the primary failure and the durable application-key replay when compensation persistence fails", async () => {
		const { manager, store, provision, cleanup } = makeManager();
		let failCompensationSave = false;
		failStaffRenames(() => failCompensationSave);
		const createSession = vi.fn(async () => {
			failCompensationSave = true;
			throw new Error("session bootstrap failed");
		});
		const sessions = sessionManager(createSession);

		await expect(manager.createStaff("Persistence Staff", "", "prompt", "/project", sessions, {
			projectId: "project", worktree: true, applicationKey: "staff-create-1",
		})).rejects.toThrow("session bootstrap failed");

		const persisted = store.getAll();
		expect(persisted).toHaveLength(1);
		expect(persisted[0].canonicalMutationKey).toBe("staff-create-1");
		expect(cleanup).toHaveBeenCalledOnce();

		const replay = await manager.createStaff("different request values", "", "different", "/elsewhere", sessions, {
			projectId: "project", worktree: true, applicationKey: "staff-create-1",
		});
		expect(replay.id).toBe(persisted[0].id);
		expect(createSession).toHaveBeenCalledOnce();
		expect(provision).toHaveBeenCalledOnce();
	});
});
