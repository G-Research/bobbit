/**
 * Unit tests for StaffStore — `accessory` field persistence.
 *
 * Pins staff accessories as first-class persisted staff data:
 *   - a selected accessory is written to staff.json and survives a fresh
 *     StaffStore reload;
 *   - legacy records with missing/invalid accessory values normalise to "none".
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "staff-accessory-store-"));
process.env.BOBBIT_DIR = tmpRoot;
fs.mkdirSync(path.join(tmpRoot, "state"), { recursive: true });

const { StaffStore } = await import("../src/server/agent/staff-store.ts");

after(() => {
	try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ok */ }
});

function baseStaff(id: string, accessory?: unknown) {
	const staff: Record<string, unknown> = {
		id,
		name: `bot-${id}`,
		description: "",
		systemPrompt: "x",
		cwd: tmpRoot,
		state: "active",
		triggers: [],
		memory: "",
		createdAt: 0,
		updatedAt: 0,
		projectId: "proj-a",
		sandboxed: false,
	};
	if (arguments.length >= 2) staff.accessory = accessory;
	return staff;
}

function readStaffJson(dir: string): Array<Record<string, unknown>> {
	return JSON.parse(fs.readFileSync(path.join(dir, "staff.json"), "utf-8"));
}

describe("StaffStore — accessory persistence", () => {
	it("persists a selected accessory to staff.json and reloads it unchanged", () => {
		const dir = fs.mkdtempSync(path.join(tmpRoot, "store-roundtrip-"));
		const s1 = new StaffStore(dir);
		s1.put(baseStaff("wizard", "wizard-hat") as any);

		const [persisted] = readStaffJson(dir);
		assert.strictEqual(
			persisted.accessory,
			"wizard-hat",
			"accessory must be written to staff.json as first-class staff data",
		);

		const s2 = new StaffStore(dir);
		const loaded = s2.get("wizard") as any;
		assert.ok(loaded, "record must be reloaded");
		assert.strictEqual(loaded.accessory, "wizard-hat", "accessory must survive a fresh StaffStore reload");
	});

	it("normalises missing and invalid legacy accessory values to none on load", () => {
		const dir = fs.mkdtempSync(path.join(tmpRoot, "store-legacy-"));
		const records = [
			baseStaff("missing"),
			baseStaff("unknown", "rocket-boots"),
			baseStaff("empty", ""),
			baseStaff("null", null),
			baseStaff("number", 42),
			baseStaff("object", { id: "crown" }),
		];
		fs.writeFileSync(path.join(dir, "staff.json"), JSON.stringify(records, null, 2), "utf-8");

		const store = new StaffStore(dir);
		for (const id of ["missing", "unknown", "empty", "null", "number", "object"]) {
			const loaded = store.get(id) as any;
			assert.ok(loaded, `legacy record ${id} must load`);
			assert.strictEqual(loaded.accessory, "none", `legacy record ${id} must normalise accessory to none`);
		}
	});
});
