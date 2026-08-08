import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GateStore, type GateState } from "../../src/server/agent/gate-store.js";
import type { Workflow } from "../../src/server/agent/workflow-store.js";

const roots: string[] = [];
const stores: GateStore[] = [];

function tempStateDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-gate-sqlite-"));
	roots.push(dir);
	return dir;
}

function openStore(stateDir: string): GateStore {
	const store = new GateStore(stateDir);
	stores.push(store);
	return store;
}

function gate(goalId: string, gateId: string, status: GateState["status"] = "pending"): GateState {
	return { goalId, gateId, status, signals: [], updatedAt: 1 };
}

afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("GateStore SQLite persistence", () => {
	it("migrates gates.json transactionally, retires it, and treats SQLite as authoritative", async () => {
		const stateDir = tempStateDir();
		const legacy = [gate("goal-1", "design", "passed"), gate("goal-1", "implementation")];
		fs.writeFileSync(path.join(stateDir, "gates.json"), JSON.stringify(legacy), "utf-8");

		const store = openStore(stateDir);
		expect(store.getGatesForGoal("goal-1")).toHaveLength(2);
		expect(fs.existsSync(path.join(stateDir, "gates.sqlite"))).toBe(true);
		expect(fs.existsSync(path.join(stateDir, "gates.json"))).toBe(false);
		expect(fs.existsSync(path.join(stateDir, "gates.json.sqlite-retired"))).toBe(true);

		store.updateGateStatus("goal-1", "implementation", "passed");
		await store.flush();
		const metrics = store.getPersistenceMetrics();
		expect(metrics?.bytes).toBeGreaterThan(0);
		expect(metrics!.bytes).toBeLessThan(Buffer.byteLength(JSON.stringify(legacy)));
		await store.close();

		// A restored stale monolith must not overwrite the completed SQLite state.
		fs.writeFileSync(path.join(stateDir, "gates.json"), JSON.stringify([gate("goal-1", "implementation", "failed")]), "utf-8");
		const reloaded = openStore(stateDir);
		expect(reloaded.getGate("goal-1", "design")?.status).toBe("passed");
		expect(reloaded.getGate("goal-1", "implementation")?.status).toBe("passed");
	});

	it("rolls back the whole dirty batch when one payload cannot serialize", async () => {
		const stateDir = tempStateDir();
		const store = openStore(stateDir);
		store.initGatesForGoal("goal-1", ["a", "b"]);
		await store.flush();

		store.updateGateStatus("goal-1", "a", "passed");
		const circular: Record<string, string> = {};
		(circular as Record<string, unknown>).self = circular;
		store.updateGateMetadata("goal-1", "b", circular);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(store.flush()).rejects.toThrow(/circular/i);
		errorSpy.mockRestore();

		const concurrentReader = openStore(stateDir);
		expect(concurrentReader.getGate("goal-1", "a")?.status).toBe("pending");
		expect(concurrentReader.getGate("goal-1", "b")?.currentMetadata).toBeUndefined();
		await concurrentReader.close();

		store.updateGateMetadata("goal-1", "b", { fixed: "true" });
		await store.flush();
		await store.close();
		const reloaded = openStore(stateDir);
		expect(reloaded.getGate("goal-1", "a")?.status).toBe("passed");
		expect(reloaded.getGate("goal-1", "b")?.currentMetadata).toEqual({ fixed: "true" });
	});

	it("rolls back a strict multi-gate reset as one transaction", async () => {
		const stateDir = tempStateDir();
		const store = openStore(stateDir);
		store.initGatesForGoal("goal-1", ["root", "child"]);
		store.updateGateStatus("goal-1", "root", "passed");
		store.updateGateStatus("goal-1", "child", "passed");
		await store.flush();

		const circular: Record<string, string> = {};
		(circular as Record<string, unknown>).self = circular;
		store.updateGateMetadata("goal-1", "child", circular);
		const workflow: Workflow = {
			id: "sqlite-reset",
			name: "SQLite reset",
			description: "",
			createdAt: 1,
			updatedAt: 1,
			gates: [
				{ id: "root", name: "Root", dependsOn: [] },
				{ id: "child", name: "Child", dependsOn: ["root"] },
			],
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(store.resetGateAndDependentsStrict("goal-1", "root", workflow)).rejects.toThrow(/circular/i);
		errorSpy.mockRestore();
		expect(store.getGate("goal-1", "root")?.status).toBe("passed");
		expect(store.getGate("goal-1", "child")?.status).toBe("passed");

		const durable = openStore(stateDir);
		expect(durable.getGate("goal-1", "root")?.status).toBe("passed");
		expect(durable.getGate("goal-1", "child")?.status).toBe("passed");
		await durable.close();

		store.updateGateMetadata("goal-1", "child", { fixed: "true" });
		await store.flush();
	});

	it("leaves invalid legacy input in place and retries safely", () => {
		const stateDir = tempStateDir();
		const legacyFile = path.join(stateDir, "gates.json");
		fs.writeFileSync(legacyFile, JSON.stringify([gate("goal-1", "valid"), { ...gate("goal-1", "invalid"), goalId: 42 }]), "utf-8");

		expect(() => openStore(stateDir)).toThrow(/Invalid legacy gate at index 1/);
		expect(fs.existsSync(legacyFile)).toBe(true);
		expect(fs.existsSync(path.join(stateDir, "gates.json.sqlite-retired"))).toBe(false);
	});

	it("closes concurrently and releases the handle after a corrupt-row startup failure", async () => {
		const stateDir = tempStateDir();
		const store = openStore(stateDir);
		store.initGatesForGoal("goal-1", ["design"]);
		await store.flush();
		store.updateGateStatus("goal-1", "design", "passed");
		await Promise.all([store.close(), store.close()]);

		const persisted = openStore(stateDir);
		expect(persisted.getGate("goal-1", "design")?.status).toBe("passed");
		await persisted.close();

		const dbFile = path.join(stateDir, "gates.sqlite");
		const db = new Database(dbFile);
		db.prepare("UPDATE gate_records SET payload = ? WHERE goal_id = ? AND gate_id = ?")
			.run(JSON.stringify(gate("wrong-goal", "design")), "goal-1", "design");
		db.close();

		expect(() => openStore(stateDir)).toThrow(/row identity mismatch/);
		const moved = `${dbFile}.moved`;
		fs.renameSync(dbFile, moved);
		expect(fs.existsSync(moved)).toBe(true);
	});
});
