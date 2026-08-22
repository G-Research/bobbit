import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, it } from "vitest";
import { StaffStore } from "../../src/server/agent/staff-store.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "staff-context-policy-store-"));

afterAll(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function baseStaff(id: string, contextPolicy?: unknown): Record<string, unknown> {
	const record: Record<string, unknown> = {
		id,
		name: `staff-${id}`,
		description: "",
		systemPrompt: "test staff",
		cwd: tmpRoot,
		state: "active",
		triggers: [],
		memory: "",
		accessory: "none",
		createdAt: 1,
		updatedAt: 1,
		sandboxed: false,
	};
	if (arguments.length >= 2) record.contextPolicy = contextPolicy;
	return record;
}

function readStaffJson(dir: string): Array<Record<string, unknown>> {
	return JSON.parse(fs.readFileSync(path.join(dir, "staff.json"), "utf8"));
}

describe("StaffStore — context policy", () => {
	it("round-trips compact, preserve, and clear through staff.json and a fresh store", () => {
		const dir = fs.mkdtempSync(path.join(tmpRoot, "round-trip-"));
		const first = new StaffStore(dir);
		const policies = ["compact", "preserve", "clear"] as const;

		for (const policy of policies) {
			first.put(baseStaff(policy, policy) as any);
		}

		assert.deepEqual(
			readStaffJson(dir).map((record) => [record.id, record.contextPolicy]),
			policies.map((policy) => [policy, policy]),
		);

		const reloaded = new StaffStore(dir);
		for (const policy of policies) {
			assert.equal(reloaded.get(policy)?.contextPolicy, policy, `${policy} must survive a fresh StaffStore reload`);
		}
	});

	it("defaults an omitted policy to compact on put and keeps that default after reload", () => {
		const dir = fs.mkdtempSync(path.join(tmpRoot, "default-"));
		const first = new StaffStore(dir);
		first.put(baseStaff("omitted") as any);

		assert.equal(first.get("omitted")?.contextPolicy, "compact");
		assert.equal(readStaffJson(dir)[0]?.contextPolicy, "compact", "the normalized default must be durable");
		assert.equal(new StaffStore(dir).get("omitted")?.contextPolicy, "compact");
	});

	it("normalizes missing, unknown, and malformed persisted values to compact while retaining valid policies", () => {
		const dir = fs.mkdtempSync(path.join(tmpRoot, "malformed-"));
		const malformed = [
			baseStaff("missing"),
			baseStaff("unknown", "erase"),
			baseStaff("empty", ""),
			baseStaff("null", null),
			baseStaff("number", 42),
			baseStaff("object", { policy: "clear" }),
		];
		const valid = [
			baseStaff("valid-compact", "compact"),
			baseStaff("valid-preserve", "preserve"),
			baseStaff("valid-clear", "clear"),
		];
		fs.writeFileSync(path.join(dir, "staff.json"), JSON.stringify([...malformed, ...valid], null, 2), "utf8");

		const store = new StaffStore(dir);
		for (const record of malformed) {
			assert.equal(store.get(String(record.id))?.contextPolicy, "compact", `${record.id} must normalize to compact`);
		}
		assert.equal(store.get("valid-compact")?.contextPolicy, "compact");
		assert.equal(store.get("valid-preserve")?.contextPolicy, "preserve");
		assert.equal(store.get("valid-clear")?.contextPolicy, "clear");
	});
});
