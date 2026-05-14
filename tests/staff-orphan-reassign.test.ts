/**
 * Unit tests for StaffManager.listOrphaned() and reassignProject().
 *
 * Pins the orphan-detection + re-home behaviour required by the surface-
 * staff-in-sessions design §6.
 *
 * NOTE: ProjectContextManager transitively pulls in `flexsearch`, which Node 25
 * ESM rejects under tsx --test. We mock the minimal `pcm` surface that
 * StaffManager needs (`getOrCreate`, `all`) and exercise the real StaffStore.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "staff-orphan-"));
process.env.BOBBIT_DIR = tmpRoot;
fs.mkdirSync(path.join(tmpRoot, "state"), { recursive: true });

const { StaffStore } = await import("../src/server/agent/staff-store.ts");
const { StaffManager } = await import("../src/server/agent/staff-manager.ts");
const { SYSTEM_PROJECT_ID } = await import("../src/server/agent/project-registry.ts");

after(() => {
	try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ok */ }
});

/** Minimal ProjectContextManager surface needed by StaffManager. */
function makePcm(projectIds: string[]) {
	const contexts = new Map<string, any>();
	for (const id of projectIds) {
		const dir = fs.mkdtempSync(path.join(tmpRoot, `pcm-${id}-`));
		contexts.set(id, {
			project: { id },
			staffStore: new StaffStore(dir),
			searchIndex: { indexStaff() {}, removeStaff() {} },
			projectConfigStore: { get: () => undefined },
		});
	}
	return {
		getOrCreate: (id: string) => contexts.get(id) ?? null,
		all: () => contexts.values(),
		_ctx: contexts,
	};
}

describe("StaffManager.listOrphaned", () => {
	it("returns empty when all staff carry a real projectId", () => {
		const pcm = makePcm(["proj-a"]);
		const ctx = pcm._ctx.get("proj-a");
		ctx.staffStore.put({
			id: "s1", name: "alpha", description: "", systemPrompt: "x",
			cwd: tmpRoot, state: "active", triggers: [],
			memory: "", createdAt: 0, updatedAt: 0, projectId: "proj-a",
		});
		const mgr = new StaffManager(pcm as any);
		assert.deepStrictEqual(mgr.listOrphaned(), []);
	});

	it("flags staff persisted under the synthetic system project", () => {
		const pcm = makePcm([SYSTEM_PROJECT_ID, "proj-a"]);
		const sysCtx = pcm._ctx.get(SYSTEM_PROJECT_ID);
		sysCtx.staffStore.put({
			id: "legacy", name: "legacy-greeter", description: "", systemPrompt: "x",
			cwd: tmpRoot, state: "active", triggers: [],
			memory: "", createdAt: 0, updatedAt: 0, projectId: SYSTEM_PROJECT_ID,
		});
		const mgr = new StaffManager(pcm as any);
		const orphans = mgr.listOrphaned();
		assert.strictEqual(orphans.length, 1);
		assert.strictEqual(orphans[0].id, "legacy");
	});

	it("flags staff whose projectId is missing entirely", () => {
		const pcm = makePcm(["proj-a"]);
		const ctx = pcm._ctx.get("proj-a");
		ctx.staffStore.put({
			id: "nolink", name: "nolink-bot", description: "", systemPrompt: "x",
			cwd: tmpRoot, state: "active", triggers: [],
			memory: "", createdAt: 0, updatedAt: 0,
		} as any);
		const mgr = new StaffManager(pcm as any);
		const orphans = mgr.listOrphaned();
		assert.strictEqual(orphans.length, 1);
		assert.strictEqual(orphans[0].id, "nolink");
	});
});

describe("StaffManager.reassignProject", () => {
	it("moves a staff record between per-project stores", () => {
		const pcm = makePcm(["proj-a", "proj-b"]);
		const ctxA = pcm._ctx.get("proj-a");
		const ctxB = pcm._ctx.get("proj-b");
		ctxA.staffStore.put({
			id: "moving", name: "shuffle", description: "", systemPrompt: "x",
			cwd: tmpRoot, state: "active", triggers: [],
			memory: "", createdAt: 0, updatedAt: 0, projectId: "proj-a",
		});
		const mgr = new StaffManager(pcm as any);
		const moved = mgr.reassignProject("moving", "proj-b");
		assert.ok(moved, "reassignProject must return the moved record");
		assert.strictEqual(moved!.projectId, "proj-b");
		assert.strictEqual(ctxA.staffStore.get("moving"), undefined, "old store must drop record");
		assert.strictEqual(ctxB.staffStore.get("moving")?.projectId, "proj-b", "new store must own record");
	});

	it("re-homes a system-project staff to a real project", () => {
		const pcm = makePcm([SYSTEM_PROJECT_ID, "proj-a"]);
		const sysCtx = pcm._ctx.get(SYSTEM_PROJECT_ID);
		sysCtx.staffStore.put({
			id: "orphan1", name: "wanderer", description: "", systemPrompt: "x",
			cwd: tmpRoot, state: "active", triggers: [],
			memory: "", createdAt: 0, updatedAt: 0, projectId: SYSTEM_PROJECT_ID,
		});
		const mgr = new StaffManager(pcm as any);
		assert.strictEqual(mgr.listOrphaned().length, 1, "starts as orphan");

		const moved = mgr.reassignProject("orphan1", "proj-a");
		assert.strictEqual(moved!.projectId, "proj-a");
		const ctxA = pcm._ctx.get("proj-a");
		assert.ok(ctxA.staffStore.get("orphan1"), "new store must own record");
		assert.strictEqual(sysCtx.staffStore.get("orphan1"), undefined, "system store must drop record");
		assert.strictEqual(mgr.listOrphaned().length, 0, "no orphans remain");
	});

	it("returns null when the staff id doesn't exist", () => {
		const pcm = makePcm(["proj-a"]);
		const mgr = new StaffManager(pcm as any);
		assert.strictEqual(mgr.reassignProject("missing-id", "proj-a"), null);
	});

	it("throws when target project is unknown", () => {
		const pcm = makePcm(["proj-a"]);
		const ctxA = pcm._ctx.get("proj-a");
		ctxA.staffStore.put({
			id: "stuck", name: "stuck", description: "", systemPrompt: "x",
			cwd: tmpRoot, state: "active", triggers: [],
			memory: "", createdAt: 0, updatedAt: 0, projectId: "proj-a",
		});
		const mgr = new StaffManager(pcm as any);
		assert.throws(() => mgr.reassignProject("stuck", "no-such-project"), /not found/i);
	});
});
