import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GateStore, type GateState } from "../../src/server/agent/gate-store.js";
import { ProjectContext } from "../../src/server/agent/project-context.js";
import { recoverPreMigrationData } from "../../src/server/agent/state-migration.js";
import type { Workflow } from "../../src/server/agent/workflow-store.js";
import { createMemFs } from "../harness/mem-fs.js";

const roots: string[] = [];
const stores: GateStore[] = [];
const contexts: ProjectContext[] = [];

function tempRoot(): string {
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

function representativeGate(goalId: string, gateId: string): GateState {
	return {
		goalId,
		gateId,
		status: "passed",
		currentContent: "## Review\n\nPreserve exactly.",
		currentContentVersion: 3,
		currentMetadata: { source: "qualification", unicode: "✓" },
		signals: [{
			id: "signal-1",
			goalId,
			gateId,
			sessionId: "session-1",
			timestamp: 1234,
			commitSha: "0123456789abcdef",
			metadata: { attempt: "1" },
			content: "payload",
			contentVersion: 3,
			verification: {
				status: "passed",
				steps: [{
					name: "Typecheck",
					type: "command",
					passed: true,
					output: "ok",
					duration_ms: 42,
					status: "passed",
					phase: 1,
				}],
			},
		}],
		updatedAt: 5678,
		legacyExtension: { nested: ["preserved", 7] },
	} as GateState;
}

function historicalGate(goalId: string, gateId: string): GateState {
	return {
		goalId,
		gateId,
		status: "failed",
		signals: [{
			id: "historical-signal",
			goalId,
			gateId,
			sessionId: "historical-session",
			timestamp: 100,
			commitSha: "historical",
			verification: {
				status: "failed",
				steps: [{
					name: "Historical remote check",
					type: "remote-state",
					passed: false,
					output: "retained audit history",
					duration_ms: 8,
				}],
			},
		}],
		updatedAt: 101,
		historicalTopLevelExtension: true,
	} as unknown as GateState;
}

function stateFingerprint(gates: GateState[]) {
	const ordered = [...gates].sort((a, b) => `${a.goalId}::${a.gateId}`.localeCompare(`${b.goalId}::${b.gateId}`));
	return {
		count: ordered.length,
		identities: ordered.map(item => `${item.goalId}::${item.gateId}`),
		hashes: ordered.map(item => createHash("sha256").update(JSON.stringify(item)).digest("hex")),
	};
}

function createUnmarkedDatabase(stateDir: string, failInserts = false): void {
	const db = new Database(path.join(stateDir, "gates.sqlite"));
	db.exec(`
		CREATE TABLE gate_store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;
		CREATE TABLE gate_records (
			goal_id TEXT NOT NULL,
			gate_id TEXT NOT NULL,
			payload TEXT NOT NULL,
			PRIMARY KEY (goal_id, gate_id)
		) STRICT;
		CREATE INDEX gate_records_goal_id_idx ON gate_records(goal_id);
		PRAGMA user_version = 1;
	`);
	if (failInserts) {
		db.exec(`CREATE TRIGGER fail_gate_import BEFORE INSERT ON gate_records BEGIN SELECT RAISE(ABORT, 'injected import failure'); END;`);
	}
	db.close();
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const context of contexts.splice(0)) await context.close();
	for (const store of stores.splice(0)) await store.close();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("GateStore SQLite persistence", () => {
	it("keeps the public non-real FsLike constructor on JSON persistence by default", async () => {
		const memfs = createMemFs();
		const stateDir = path.resolve("/memfs/gate-store-default");
		memfs.mkdirSync(stateDir, { recursive: true });
		const store = new GateStore(stateDir, memfs);
		store.initGatesForGoal("goal-memfs", ["design"]);
		await store.flush();
		expect(memfs.existsSync(path.join(stateDir, "gates.json"))).toBe(true);
		await store.close();
		const reloaded = new GateStore(stateDir, memfs);
		expect(reloaded.getGate("goal-memfs", "design")?.status).toBe("pending");
		await reloaded.close();
	});

	it("automatically migrates on ProjectContext startup and exactly restores mutation after close", async () => {
		const projectRoot = tempRoot();
		const stateDir = path.join(projectRoot, ".bobbit", "state");
		fs.mkdirSync(stateDir, { recursive: true });
		const original = representativeGate("goal-project", "design");
		fs.writeFileSync(path.join(stateDir, "gates.json"), JSON.stringify([original]), "utf-8");
		const project = {
			id: "sqlite-project",
			name: "SQLite project",
			rootPath: projectRoot,
			createdAt: Date.now(),
			colorLight: "#000000",
			colorDark: "#ffffff",
		} as any;

		const context = new ProjectContext(project);
		contexts.push(context);
		expect(context.gateStore.getGate(original.goalId, original.gateId)).toEqual(original);
		expect(fs.existsSync(path.join(stateDir, "gates.sqlite"))).toBe(true);
		expect(fs.existsSync(path.join(stateDir, "gates.json.sqlite-retired"))).toBe(true);

		context.gateStore.updateGateMetadata(original.goalId, original.gateId, { after: "mutation" });
		await context.close();
		contexts.splice(contexts.indexOf(context), 1);
		const expected = JSON.parse(JSON.stringify(context.gateStore.getGate(original.goalId, original.gateId))) as GateState;

		const restarted = new ProjectContext(project);
		contexts.push(restarted);
		expect(restarted.gateStore.getGate(original.goalId, original.gateId)).toEqual(expected);
		expect(stateFingerprint(restarted.gateStore.getGatesForGoal(original.goalId))).toEqual(stateFingerprint([expected]));
	});

	it("imports both legacy sources with live precedence and collision-safe non-destructive retirement", async () => {
		const stateDir = tempRoot();
		const liveConflict = representativeGate("goal-1", "conflict");
		const backupConflict = { ...representativeGate("goal-1", "conflict"), status: "failed" as const };
		const liveOnly = gate("goal-1", "live-only");
		const backupOnly = gate("goal-2", "backup-only", "passed");
		fs.writeFileSync(path.join(stateDir, "gates.json"), JSON.stringify([liveConflict, liveOnly]), "utf-8");
		fs.writeFileSync(path.join(stateDir, "gates.json.pre-migration"), JSON.stringify([backupConflict, backupOnly]), "utf-8");
		fs.writeFileSync(path.join(stateDir, "gates.json.sqlite-retired"), "existing-live-backup", "utf-8");
		fs.writeFileSync(path.join(stateDir, "gates.json.pre-migration-recovered"), "existing-recovery-backup", "utf-8");

		const store = openStore(stateDir);
		expect(store.getGate("goal-1", "conflict")).toEqual(liveConflict);
		expect(store.getGate("goal-1", "live-only")).toEqual(liveOnly);
		expect(store.getGate("goal-2", "backup-only")).toEqual(backupOnly);
		expect(fs.readFileSync(path.join(stateDir, "gates.json.sqlite-retired"), "utf-8")).toBe("existing-live-backup");
		expect(fs.readFileSync(path.join(stateDir, "gates.json.pre-migration-recovered"), "utf-8")).toBe("existing-recovery-backup");
		expect(JSON.parse(fs.readFileSync(path.join(stateDir, "gates.json.sqlite-retired.1"), "utf-8"))).toEqual([liveConflict, liveOnly]);
		expect(JSON.parse(fs.readFileSync(path.join(stateDir, "gates.json.pre-migration-recovered.1"), "utf-8"))).toEqual([backupConflict, backupOnly]);
		expect(stateFingerprint([...store.getGatesForGoal("goal-1"), ...store.getGatesForGoal("goal-2")]))
			.toEqual(stateFingerprint([liveConflict, liveOnly, backupOnly]));
	});

	it("keeps generic state recovery from recreating ignored gates.json", () => {
		const stateDir = tempRoot();
		const recoveryFile = path.join(stateDir, "gates.json.pre-migration");
		const historical = historicalGate("goal-historical", "remote-check");
		fs.writeFileSync(recoveryFile, JSON.stringify([historical]), "utf-8");

		recoverPreMigrationData(stateDir);
		expect(fs.existsSync(path.join(stateDir, "gates.json"))).toBe(false);
		expect(fs.existsSync(recoveryFile)).toBe(true);

		const store = openStore(stateDir);
		expect(store.getGate(historical.goalId, historical.gateId)).toEqual(historical);
		expect(fs.existsSync(path.join(stateDir, "gates.json.pre-migration-recovered"))).toBe(true);
	});

	it("transactionally merges pre-migration recovery into authoritative SQLite without replacing conflicts", async () => {
		const stateDir = tempRoot();
		const authoritative = openStore(stateDir);
		authoritative.initGatesForGoal("goal-1", ["conflict"]);
		authoritative.updateGateStatus("goal-1", "conflict", "passed");
		await authoritative.close();
		stores.splice(stores.indexOf(authoritative), 1);
		const durableConflict = gate("goal-1", "conflict", "passed");
		const recoveredOnly = representativeGate("goal-2", "recovered-only");
		fs.writeFileSync(
			path.join(stateDir, "gates.json.pre-migration"),
			JSON.stringify([{ ...durableConflict, status: "failed" }, recoveredOnly]),
			"utf-8",
		);

		const recovered = openStore(stateDir);
		expect(recovered.getGate("goal-1", "conflict")?.status).toBe("passed");
		expect(recovered.getGate("goal-2", "recovered-only")).toEqual(recoveredOnly);
		expect(fs.existsSync(path.join(stateDir, "gates.json"))).toBe(false);
		expect(fs.existsSync(path.join(stateDir, "gates.json.pre-migration"))).toBe(false);
		expect(fs.existsSync(path.join(stateDir, "gates.json.pre-migration-recovered"))).toBe(true);
	});

	it("rejects malformed authoritative recovery transactionally and releases the database handle", async () => {
		const stateDir = tempRoot();
		const authoritative = openStore(stateDir);
		await authoritative.close();
		stores.splice(stores.indexOf(authoritative), 1);

		const malformed = representativeGate("goal-2", "malformed-recovery") as GateState & Record<string, unknown>;
		(malformed.signals[0].verification.steps[0] as unknown as Record<string, unknown>).diagnostics = { artifacts: "not-an-array" };
		const recoveryFile = path.join(stateDir, "gates.json.pre-migration");
		const sourceBytes = Buffer.from(JSON.stringify([malformed]));
		fs.writeFileSync(recoveryFile, sourceBytes);

		expect(() => openStore(stateDir)).toThrow(/invalid retained-command-diagnostics shape/i);
		expect(fs.readFileSync(recoveryFile)).toEqual(sourceBytes);
		const dbFile = path.join(stateDir, "gates.sqlite");
		const db = new Database(dbFile);
		expect((db.prepare("SELECT COUNT(*) AS count FROM gate_records").get() as { count: number }).count).toBe(0);
		expect(db.prepare("SELECT value FROM gate_store_meta WHERE key = 'pre_migration_recovery_complete'").get()).toBeUndefined();
		db.close();
		fs.renameSync(dbFile, `${dbFile}.released`);
	});

	it("preserves source bytes when complete validation or transactional import fails", () => {
		const invalidDir = tempRoot();
		const invalidFile = path.join(invalidDir, "gates.json");
		const invalidBytes = Buffer.from(JSON.stringify([gate("goal-1", "valid"), { ...gate("goal-1", "invalid"), status: "unknown" }]));
		fs.writeFileSync(invalidFile, invalidBytes);
		expect(() => openStore(invalidDir)).toThrow(/Invalid legacy gate at index 1.*unsupported status/);
		expect(fs.readFileSync(invalidFile)).toEqual(invalidBytes);
		expect(fs.existsSync(path.join(invalidDir, "gates.json.sqlite-retired"))).toBe(false);

		const duplicateDir = tempRoot();
		const duplicateFile = path.join(duplicateDir, "gates.json");
		const duplicateBytes = Buffer.from(JSON.stringify([gate("goal-duplicate", "same"), gate("goal-duplicate", "same")]));
		fs.writeFileSync(duplicateFile, duplicateBytes);
		expect(() => openStore(duplicateDir)).toThrow(/Duplicate gates\.json gate/);
		expect(fs.readFileSync(duplicateFile)).toEqual(duplicateBytes);

		const failedImportDir = tempRoot();
		const sourceFile = path.join(failedImportDir, "gates.json");
		const sourceBytes = Buffer.from(JSON.stringify([representativeGate("goal-2", "import")]));
		fs.writeFileSync(sourceFile, sourceBytes);
		createUnmarkedDatabase(failedImportDir, true);
		expect(() => openStore(failedImportDir)).toThrow(/injected import failure/);
		expect(fs.readFileSync(sourceFile)).toEqual(sourceBytes);
		const db = new Database(path.join(failedImportDir, "gates.sqlite"));
		expect((db.prepare("SELECT COUNT(*) AS count FROM gate_records").get() as { count: number }).count).toBe(0);
		expect((db.prepare("SELECT COUNT(*) AS count FROM gate_store_meta").get() as { count: number }).count).toBe(0);
		db.close();
	});

	it("retries an interrupted post-commit retirement without reimporting changed source", () => {
		const stateDir = tempRoot();
		const sourceFile = path.join(stateDir, "gates.json");
		fs.writeFileSync(sourceFile, JSON.stringify([gate("goal-1", "design", "passed")]), "utf-8");
		const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
			const error = new Error("injected retirement interruption") as NodeJS.ErrnoException;
			error.code = "EACCES";
			throw error;
		});
		expect(() => openStore(stateDir)).toThrow(/injected retirement interruption/);
		expect(fs.existsSync(sourceFile)).toBe(true);
		rename.mockRestore();

		// SQLite committed before the failed rename; this stale edit must only be retired.
		fs.writeFileSync(sourceFile, JSON.stringify([gate("goal-1", "design", "failed")]), "utf-8");
		const recovered = openStore(stateDir);
		expect(recovered.getGate("goal-1", "design")?.status).toBe("passed");
		expect(fs.existsSync(sourceFile)).toBe(false);
		expect(fs.existsSync(path.join(stateDir, "gates.json.sqlite-retired"))).toBe(true);
	});

	it("rolls back the whole dirty batch when one payload cannot serialize", async () => {
		const stateDir = tempRoot();
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
		const stateDir = tempRoot();
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

	it("retries a transient final flush failure and restores the exact mutation after restart", async () => {
		const stateDir = tempRoot();
		const store = openStore(stateDir);
		store.initGatesForGoal("goal-close-retry", ["design"]);
		await store.flush();
		store.updateGateStatus("goal-close-retry", "design", "passed");
		let serializeAttempts = 0;
		const transientMetadata = {
			toJSON() {
				serializeAttempts++;
				if (serializeAttempts === 1) throw new Error("injected transient final flush failure");
				return { recovered: "true" };
			},
		} as unknown as Record<string, string>;
		store.updateGateMetadata("goal-close-retry", "design", transientMetadata);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const firstClose = store.close();
		const concurrentClose = store.close();
		expect(concurrentClose).toBe(firstClose);
		await expect(firstClose).resolves.toBeUndefined();
		expect(serializeAttempts).toBe(2);
		errorSpy.mockRestore();
		stores.splice(stores.indexOf(store), 1);

		const reloaded = openStore(stateDir);
		expect(reloaded.getGate("goal-close-retry", "design")).toMatchObject({
			status: "passed",
			currentMetadata: { recovered: "true" },
		});
	});

	it("rejects a persistent final flush failure for every close caller and releases the handle", async () => {
		const stateDir = tempRoot();
		const store = openStore(stateDir);
		store.initGatesForGoal("goal-close-failure", ["design"]);
		await store.flush();
		let serializeAttempts = 0;
		const persistentMetadata = {
			toJSON() {
				serializeAttempts++;
				throw new Error("injected persistent final flush failure");
			},
		} as unknown as Record<string, string>;
		store.updateGateMetadata("goal-close-failure", "design", persistentMetadata);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const firstClose = store.close();
		const concurrentClose = store.close();
		expect(concurrentClose).toBe(firstClose);
		const outcomes = await Promise.allSettled([firstClose, concurrentClose]);
		expect(outcomes).toMatchObject([
			{ status: "rejected", reason: { message: "injected persistent final flush failure" } },
			{ status: "rejected", reason: { message: "injected persistent final flush failure" } },
		]);
		expect(serializeAttempts).toBe(2);
		errorSpy.mockRestore();
		stores.splice(stores.indexOf(store), 1);

		const dbFile = path.join(stateDir, "gates.sqlite");
		const moved = `${dbFile}.released`;
		fs.renameSync(dbFile, moved);
		fs.renameSync(moved, dbFile);
		const reloaded = openStore(stateDir);
		expect(reloaded.getGate("goal-close-failure", "design")?.currentMetadata).toBeUndefined();
	});

	it("closes concurrently and releases the handle after a corrupt-row startup failure", async () => {
		const stateDir = tempRoot();
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
