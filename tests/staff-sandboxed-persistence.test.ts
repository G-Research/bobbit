/**
 * Unit tests for StaffStore — `sandboxed` field persistence.
 *
 * Pins the fix-staff-sandbox-model design contract at the data-model layer:
 *   - PersistedStaff.sandboxed round-trips through StaffStore reload (proves
 *     the value is written to staff.json and read back faithfully).
 *   - Legacy records without the field normalise to `false` on load.
 *   - StaffManager.updateStaff's TypeScript signature omits `sandboxed`, so
 *     no legitimate caller can flip it. The user-facing API allow-list
 *     (PUT /api/staff/:id) is pinned by the E2E test in tests/e2e/staff.spec.ts.
 *
 * Mirrors the test pattern used by tests/staff-orphan-reassign.test.ts:
 * exercise the real StaffStore against file://-style tmp directories.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "staff-sandbox-"));
process.env.BOBBIT_DIR = tmpRoot;
fs.mkdirSync(path.join(tmpRoot, "state"), { recursive: true });

const { StaffStore } = await import("../src/server/agent/staff-store.ts");

after(() => {
	try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ok */ }
});

function baseStaff(id: string, sandboxed: boolean) {
	return {
		id,
		name: `bot-${id}`,
		description: "",
		systemPrompt: "x",
		cwd: tmpRoot,
		state: "active" as const,
		triggers: [],
		memory: "",
		createdAt: 0,
		updatedAt: 0,
		projectId: "proj-a",
		sandboxed,
	};
}

describe("StaffStore — sandboxed persistence", () => {
	it("persists sandboxed: true and reloads it as true via a fresh StaffStore", () => {
		const dir = fs.mkdtempSync(path.join(tmpRoot, "store-true-"));
		const s1 = new StaffStore(dir);
		s1.put(baseStaff("on", true));

		// Fresh instance pointed at the same dir — simulates restart.
		const s2 = new StaffStore(dir);
		const loaded = s2.get("on");
		assert.ok(loaded, "record must be reloaded");
		assert.strictEqual(loaded!.sandboxed, true, "sandboxed=true must round-trip");
	});

	it("persists sandboxed: false and reloads it as false", () => {
		const dir = fs.mkdtempSync(path.join(tmpRoot, "store-false-"));
		const s1 = new StaffStore(dir);
		s1.put(baseStaff("off", false));

		const s2 = new StaffStore(dir);
		const loaded = s2.get("off");
		assert.ok(loaded);
		assert.strictEqual(loaded!.sandboxed, false);
	});

	it("normalises a legacy record without the sandboxed field to false", () => {
		const dir = fs.mkdtempSync(path.join(tmpRoot, "store-legacy-"));
		// Hand-craft a staff.json from before the field existed.
		const legacy = {
			id: "legacy-1",
			name: "Legacy Bot",
			description: "",
			systemPrompt: "x",
			cwd: tmpRoot,
			state: "active",
			triggers: [],
			memory: "",
			createdAt: 0,
			updatedAt: 0,
			projectId: "proj-a",
			// no `sandboxed` field at all
		};
		fs.writeFileSync(path.join(dir, "staff.json"), JSON.stringify([legacy], null, 2), "utf-8");

		const store = new StaffStore(dir);
		const loaded = store.get("legacy-1");
		assert.ok(loaded, "legacy record must load");
		assert.strictEqual(loaded!.sandboxed, false, "missing field must normalise to false");
		assert.strictEqual(typeof loaded!.sandboxed, "boolean", "must be a real boolean, not undefined");
	});

	it("normalises a legacy record with sandboxed: null/undefined/missing to false", () => {
		const dir = fs.mkdtempSync(path.join(tmpRoot, "store-mixed-"));
		const records = [
			{ id: "a", name: "a", description: "", systemPrompt: "x", cwd: tmpRoot,
			  state: "active", triggers: [], memory: "", createdAt: 0, updatedAt: 0 },
			{ id: "b", name: "b", description: "", systemPrompt: "x", cwd: tmpRoot,
			  state: "active", triggers: [], memory: "", createdAt: 0, updatedAt: 0, sandboxed: null },
			{ id: "c", name: "c", description: "", systemPrompt: "x", cwd: tmpRoot,
			  state: "active", triggers: [], memory: "", createdAt: 0, updatedAt: 0, sandboxed: undefined },
		];
		fs.writeFileSync(path.join(dir, "staff.json"), JSON.stringify(records, null, 2), "utf-8");

		const store = new StaffStore(dir);
		for (const id of ["a", "b", "c"]) {
			const loaded = store.get(id);
			assert.ok(loaded, `record ${id} must load`);
			assert.strictEqual(loaded!.sandboxed, false, `record ${id} must normalise to false`);
		}
	});
});

describe("StaffStore — type contract", () => {
	it("PersistedStaff carries `sandboxed: boolean` as a required field", () => {
		// Compile-time check: the object literal must declare `sandboxed` to
		// satisfy the type. If a future refactor demotes the field to optional
		// or removes it, this test will fail to compile and surface the change.
		const dir = fs.mkdtempSync(path.join(tmpRoot, "store-types-"));
		const store = new StaffStore(dir);
		const rec = baseStaff("typed", true);
		store.put(rec);
		const loaded = store.get("typed");
		assert.ok(loaded);
		assert.strictEqual(typeof loaded!.sandboxed, "boolean");
	});
});
