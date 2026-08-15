import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GateStore, type GateSignal, type GateState } from "../../src/server/agent/gate-store.js";
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

const lifecycleWorkflow: Workflow = {
	id: "gate-store-lifecycle",
	name: "GateStore lifecycle",
	description: "",
	createdAt: 1,
	updatedAt: 1,
	gates: [
		{ id: "root", name: "Root", dependsOn: [] },
		{ id: "child", name: "Child", dependsOn: ["root"] },
	],
};

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

	it("atomically retires both legacy sources without overwriting backups created at the claim boundary", async () => {
		const stateDir = tempRoot();
		const liveConflict = representativeGate("goal-1", "conflict");
		const backupConflict = { ...representativeGate("goal-1", "conflict"), status: "failed" as const };
		const liveOnly = gate("goal-1", "live-only");
		const backupOnly = gate("goal-2", "backup-only", "passed");
		const liveSource = path.join(stateDir, "gates.json");
		const recoverySource = path.join(stateDir, "gates.json.pre-migration");
		const livePreferred = `${liveSource}.sqlite-retired`;
		const recoveryPreferred = `${recoverySource}-recovered`;
		fs.writeFileSync(liveSource, JSON.stringify([liveConflict, liveOnly]), "utf-8");
		fs.writeFileSync(recoverySource, JSON.stringify([backupConflict, backupOnly]), "utf-8");
		fs.writeFileSync(livePreferred, "existing-live-backup", "utf-8");
		fs.writeFileSync(recoveryPreferred, "existing-recovery-backup", "utf-8");

		// The preferred names already collide. Create each first free suffix after
		// GateStore selects it but immediately before its atomic no-replace claim.
		const racedTargets = new Map([
			[`${livePreferred}.1`, "racing-live-backup"],
			[`${recoveryPreferred}.1`, "racing-recovery-backup"],
		]);
		const originalLink = fs.linkSync;
		const link = vi.spyOn(fs, "linkSync").mockImplementation((source, target) => {
			const targetPath = target.toString();
			const racingBytes = racedTargets.get(targetPath);
			if (racingBytes !== undefined) {
				racedTargets.delete(targetPath);
				fs.writeFileSync(targetPath, racingBytes, "utf-8");
			}
			return originalLink(source, target);
		});
		const store = openStore(stateDir);
		link.mockRestore();

		expect(racedTargets.size).toBe(0);
		expect(store.getGate("goal-1", "conflict")).toEqual(liveConflict);
		expect(store.getGate("goal-1", "live-only")).toEqual(liveOnly);
		expect(store.getGate("goal-2", "backup-only")).toEqual(backupOnly);
		expect(fs.existsSync(liveSource)).toBe(false);
		expect(fs.existsSync(recoverySource)).toBe(false);
		expect(fs.readFileSync(livePreferred, "utf-8")).toBe("existing-live-backup");
		expect(fs.readFileSync(recoveryPreferred, "utf-8")).toBe("existing-recovery-backup");
		expect(fs.readFileSync(`${livePreferred}.1`, "utf-8")).toBe("racing-live-backup");
		expect(fs.readFileSync(`${recoveryPreferred}.1`, "utf-8")).toBe("racing-recovery-backup");
		expect(JSON.parse(fs.readFileSync(`${livePreferred}.2`, "utf-8"))).toEqual([liveConflict, liveOnly]);
		expect(JSON.parse(fs.readFileSync(`${recoveryPreferred}.2`, "utf-8"))).toEqual([backupConflict, backupOnly]);
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

	it("migrates a hand-recorded manual pass whose step omits duration_ms instead of failing the load", async () => {
		const stateDir = tempRoot();
		const manualPass = representativeGate("goal-bypass", "qualification");
		// A human bypass / hand-recorded manual pass marks a step passed without a
		// timed command run, so the persisted step legitimately has no duration_ms.
		// The old JSON loader tolerated this; the strict migration must not fatal.
		delete (manualPass.signals[0].verification.steps[0] as unknown as Record<string, unknown>).duration_ms;
		fs.writeFileSync(path.join(stateDir, "gates.json"), JSON.stringify([manualPass]), "utf-8");

		const store = openStore(stateDir);
		expect(store.getGate("goal-bypass", "qualification")?.signals[0]?.verification.steps[0]?.duration_ms).toBe(0);
		expect(fs.existsSync(path.join(stateDir, "gates.sqlite"))).toBe(true);
		expect(fs.existsSync(path.join(stateDir, "gates.json.sqlite-retired"))).toBe(true);

		// The backfilled default is durable across a restart.
		await store.close();
		stores.splice(stores.indexOf(store), 1);
		const reloaded = openStore(stateDir);
		expect(reloaded.getGate("goal-bypass", "qualification")?.signals[0]?.verification.steps[0]?.duration_ms).toBe(0);
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

	it("keeps the source and durable intent when no-replace publication fails", () => {
		const stateDir = tempRoot();
		const sourceFile = path.join(stateDir, "gates.json");
		const sourceBytes = Buffer.from(JSON.stringify([gate("goal-link-failure", "design", "passed")]));
		fs.writeFileSync(sourceFile, sourceBytes);
		const link = vi.spyOn(fs, "linkSync").mockImplementationOnce(() => {
			const error = new Error("injected hard-link publication failure") as NodeJS.ErrnoException;
			error.code = "EACCES";
			throw error;
		});
		const unlink = vi.spyOn(fs, "unlinkSync");

		expect(() => openStore(stateDir)).toThrow(/injected hard-link publication failure/);
		expect(unlink).not.toHaveBeenCalledWith(sourceFile);
		expect(fs.readFileSync(sourceFile)).toEqual(sourceBytes);
		expect(fs.existsSync(`${sourceFile}.sqlite-retired`)).toBe(false);
		link.mockRestore();
		unlink.mockRestore();

		const db = new Database(path.join(stateDir, "gates.sqlite"));
		expect(db.prepare("SELECT value FROM gate_store_meta WHERE key = ?").get("pending_retirement:gates.json"))
			.toEqual({ value: "1" });
		expect((db.prepare("SELECT COUNT(*) AS count FROM gate_records").get() as { count: number }).count).toBe(1);
		db.close();
		const recovered = openStore(stateDir);
		expect(recovered.getGate("goal-link-failure", "design")?.status).toBe("passed");
		expect(fs.existsSync(sourceFile)).toBe(false);
	});

	it("retries interrupted post-commit retirement with atomic collision handling and no reimport", () => {
		const stateDir = tempRoot();
		const sourceFile = path.join(stateDir, "gates.json");
		const preferred = `${sourceFile}.sqlite-retired`;
		const committedSource = [gate("goal-1", "design", "passed")];
		fs.writeFileSync(sourceFile, JSON.stringify(committedSource), "utf-8");

		// Preservation succeeds first. An unlink failure must keep the source and
		// durable intent so the next startup retries retirement only.
		const originalUnlink = fs.unlinkSync;
		let interrupted = false;
		const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation(file => {
			if (!interrupted && file.toString() === sourceFile) {
				interrupted = true;
				const error = new Error("injected source unlink interruption") as NodeJS.ErrnoException;
				error.code = "EACCES";
				throw error;
			}
			return originalUnlink(file);
		});
		expect(() => openStore(stateDir)).toThrow(/injected source unlink interruption/);
		unlink.mockRestore();
		expect(fs.existsSync(sourceFile)).toBe(true);
		expect(JSON.parse(fs.readFileSync(preferred, "utf-8"))).toEqual(committedSource);

		// Replace the still-visible source with stale bytes. SQLite committed before
		// retirement and must remain authoritative. Race the first free retry suffix.
		originalUnlink(sourceFile);
		const staleSource = [gate("goal-1", "design", "failed")];
		fs.writeFileSync(sourceFile, JSON.stringify(staleSource), "utf-8");
		const retryTarget = `${preferred}.1`;
		const originalLink = fs.linkSync;
		let raced = false;
		const link = vi.spyOn(fs, "linkSync").mockImplementation((source, target) => {
			if (!raced && target.toString() === retryTarget) {
				raced = true;
				fs.writeFileSync(retryTarget, "racing-restart-backup", "utf-8");
			}
			return originalLink(source, target);
		});
		const recovered = openStore(stateDir);
		link.mockRestore();

		expect(raced).toBe(true);
		expect(recovered.getGate("goal-1", "design")?.status).toBe("passed");
		expect(fs.existsSync(sourceFile)).toBe(false);
		expect(JSON.parse(fs.readFileSync(preferred, "utf-8"))).toEqual(committedSource);
		expect(fs.readFileSync(retryTarget, "utf-8")).toBe("racing-restart-backup");
		expect(JSON.parse(fs.readFileSync(`${preferred}.2`, "utf-8"))).toEqual(staleSource);
		const db = new Database(path.join(stateDir, "gates.sqlite"));
		expect(db.prepare("SELECT value FROM gate_store_meta WHERE key = ?").get("pending_retirement:gates.json")).toBeUndefined();
		db.close();
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

	it("fences every mutation before side effects once close begins and retains an accepted SQLite signal", async () => {
		const stateDir = tempRoot();
		const store = openStore(stateDir);
		store.initGatesForGoal("goal-close-fence", ["root", "child"]);
		store.updateGateStatus("goal-close-fence", "root", "passed");
		store.updateGateStatus("goal-close-fence", "child", "passed");
		await store.flush();

		let observerCalls = 0;
		store.onStatusChange = () => { observerCalls++; };
		const acceptedSignal: GateSignal = {
			id: "accepted-before-close",
			goalId: "goal-close-fence",
			gateId: "root",
			sessionId: "session-close-fence",
			timestamp: 123,
			commitSha: "abc123",
			verification: { status: "running", steps: [] },
		};
		store.recordSignal(acceptedSignal);
		const acceptedSnapshot = structuredClone(store.getGatesForGoal("goal-close-fence"));
		const closing = store.close();
		expect(store.close()).toBe(closing);

		const syncMutations = [
			() => store.initGatesForGoal("goal-close-fence", ["late"]),
			() => store.reconcileGatesForGoal("goal-close-fence", ["root"]),
			() => store.recordSignal({ ...acceptedSignal, id: "late-signal" }),
			() => store.bypassGate("goal-close-fence", "root", { whyBypassed: "late", whoAmI: "tester" }),
			() => store.updateGateStatus("goal-close-fence", "root", "failed"),
			() => store.updateGateContent("goal-close-fence", "root", "late", 2),
			() => store.updateGateMetadata("goal-close-fence", "root", { late: "true" }),
			() => store.updateSignalVerification("accepted-before-close", { status: "passed", steps: [] }),
			() => store.cascadeReset("goal-close-fence", "root", lifecycleWorkflow),
			() => store.removeGoalGates("goal-close-fence"),
		];
		for (const mutate of syncMutations) expect(mutate).toThrow(/GateStore is closing or closed/);
		await expect(store.resetGateAndDependents("goal-close-fence", "root", lifecycleWorkflow)).rejects.toThrow(/GateStore is closing or closed/);
		await expect(store.resetGateAndDependentsStrict("goal-close-fence", "root", lifecycleWorkflow)).rejects.toThrow(/GateStore is closing or closed/);
		await expect(store.resetGateAndDependentsInMemory("goal-close-fence", "root", lifecycleWorkflow)).rejects.toThrow(/GateStore is closing or closed/);

		expect(store.getGatesForGoal("goal-close-fence")).toEqual(acceptedSnapshot);
		expect(observerCalls).toBe(1);
		await closing;
		stores.splice(stores.indexOf(store), 1);

		const reloaded = openStore(stateDir);
		const byGateId = (left: GateState, right: GateState) => left.gateId.localeCompare(right.gateId);
		expect(reloaded.getGatesForGoal("goal-close-fence").sort(byGateId)).toEqual([...acceptedSnapshot].sort(byGateId));
	});

	it("lets an accepted strict memfs reset cross close and reach the final durable snapshot", async () => {
		const memfs = createMemFs();
		const stateDir = path.resolve("/memfs/gate-close-strict-success");
		memfs.mkdirSync(stateDir, { recursive: true });
		const store = new GateStore(stateDir, memfs, { persistence: "json" });
		store.initGatesForGoal("goal-1", ["root", "child"]);
		store.updateGateStatus("goal-1", "root", "passed");
		store.updateGateStatus("goal-1", "child", "passed");
		await store.flush();

		const originalRename = memfs.promises.rename.bind(memfs.promises);
		let releaseRename!: () => void;
		let markRenameStarted!: () => void;
		const renameStarted = new Promise<void>(resolve => { markRenameStarted = resolve; });
		const renameReleased = new Promise<void>(resolve => { releaseRename = resolve; });
		let holdOnce = true;
		(memfs.promises as any).rename = async (from: string, to: string) => {
			if (holdOnce && String(to).endsWith("gates.json")) {
				holdOnce = false;
				markRenameStarted();
				await renameReleased;
			}
			return originalRename(from, to);
		};
		let observerCalls = 0;
		store.onStatusChange = () => { observerCalls++; };

		const reset = store.resetGateAndDependentsStrict("goal-1", "root", lifecycleWorkflow);
		expect(store.getGate("goal-1", "root")?.status).toBe("pending");
		await renameStarted;
		const closing = store.close();
		expect(() => store.updateGateStatus("goal-1", "root", "failed")).toThrow(/GateStore is closing or closed/);
		releaseRename();
		await reset;
		await closing;
		expect(observerCalls).toBe(2);

		(memfs.promises as any).rename = originalRename;
		const reloaded = new GateStore(stateDir, memfs, { persistence: "json" });
		expect(reloaded.getGate("goal-1", "root")?.status).toBe("pending");
		expect(reloaded.getGate("goal-1", "child")?.status).toBe("pending");
		await reloaded.close();
	});

	it("compensates an accepted strict memfs reset when its close-time publication fails", async () => {
		const memfs = createMemFs();
		const stateDir = path.resolve("/memfs/gate-close-strict-failure");
		memfs.mkdirSync(stateDir, { recursive: true });
		const store = new GateStore(stateDir, memfs, { persistence: "json" });
		store.initGatesForGoal("goal-1", ["root", "child"]);
		store.updateGateStatus("goal-1", "root", "passed");
		store.updateGateStatus("goal-1", "child", "passed");
		await store.flush();

		const originalRename = memfs.promises.rename.bind(memfs.promises);
		let releaseRename!: () => void;
		let markRenameStarted!: () => void;
		const renameStarted = new Promise<void>(resolve => { markRenameStarted = resolve; });
		const renameReleased = new Promise<void>(resolve => { releaseRename = resolve; });
		(memfs.promises as any).rename = async (_from: string, to: string) => {
			if (String(to).endsWith("gates.json")) {
				markRenameStarted();
				await renameReleased;
				throw new Error("injected close-time strict failure");
			}
			return originalRename(_from, to);
		};
		let observerCalls = 0;
		store.onStatusChange = () => { observerCalls++; };
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const reset = store.resetGateAndDependentsStrict("goal-1", "root", lifecycleWorkflow);
		await renameStarted;
		const closing = store.close();
		expect(() => store.recordSignal({
			id: "late",
			goalId: "goal-1",
			gateId: "root",
			sessionId: "late",
			timestamp: 1,
			commitSha: "",
			verification: { status: "running", steps: [] },
		})).toThrow(/GateStore is closing or closed/);
		releaseRename();
		await expect(reset).rejects.toThrow(/injected close-time strict failure/);
		await expect(closing).rejects.toThrow(/injected close-time strict failure/);
		expect(store.getGate("goal-1", "root")?.status).toBe("passed");
		expect(store.getGate("goal-1", "child")?.status).toBe("passed");
		expect(observerCalls).toBe(0);
		errorSpy.mockRestore();

		(memfs.promises as any).rename = originalRename;
		const reloaded = new GateStore(stateDir, memfs, { persistence: "json" });
		expect(reloaded.getGate("goal-1", "root")?.status).toBe("passed");
		expect(reloaded.getGate("goal-1", "child")?.status).toBe("passed");
		await reloaded.close();
	});

	it("rolls back a rejected strict verification publication while preserving a concurrent same-gate mutation", async () => {
		const memfs = createMemFs();
		const stateDir = path.resolve("/memfs/gate-strict-verification-rollback");
		memfs.mkdirSync(stateDir, { recursive: true });
		const store = new GateStore(stateDir, memfs, { persistence: "json" });
		store.initGatesForGoal("goal-1", ["design"]);
		const signal: GateSignal = {
			id: "running-signal",
			goalId: "goal-1",
			gateId: "design",
			sessionId: "session-1",
			timestamp: 1,
			commitSha: "abc123",
			verification: {
				status: "running",
				steps: [{ name: "Completed phase", type: "command", passed: true, status: "passed", output: "kept", duration_ms: 3 }],
			},
		};
		store.recordSignal(signal);
		await store.flush();
		const runningVerification = structuredClone(signal.verification);
		const runningUpdatedAt = store.getGate("goal-1", "design")!.updatedAt;

		const terminal: GateSignal["verification"] = {
			status: "cancelled",
			cancellation: { cause: "goal-pause", requestedAt: 2, finalizedAt: 3 },
			steps: [
				{ name: "Completed phase", type: "command", passed: true, status: "passed", output: "kept", duration_ms: 3 },
				{ name: "Interrupted phase", type: "command", passed: false, status: "cancelled", cancellation: { cause: "goal-pause", requestedAt: 2, finalizedAt: 3 }, output: "", duration_ms: 0 },
			],
		};
		const originalRename = memfs.promises.rename.bind(memfs.promises);
		let failNextRename = true;
		let markRenameStarted!: () => void;
		let releaseRename!: () => void;
		const renameStarted = new Promise<void>(resolve => { markRenameStarted = resolve; });
		const renameReleased = new Promise<void>(resolve => { releaseRename = resolve; });
		(memfs.promises as any).rename = async (from: string, to: string) => {
			if (failNextRename && String(to).endsWith("gates.json")) {
				failNextRename = false;
				markRenameStarted();
				await renameReleased;
				throw new Error("injected strict verification rename failure");
			}
			return originalRename(from, to);
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const clock = vi.spyOn(Date, "now")
			.mockReturnValueOnce(runningUpdatedAt + 1)
			.mockReturnValueOnce(runningUpdatedAt + 2);

		const publication = store.updateSignalVerificationStrict(signal.id, terminal);
		await renameStarted;
		store.updateGateMetadata("goal-1", "design", { concurrent: "mutation" });
		releaseRename();
		await expect(publication).rejects.toThrow(/injected strict verification rename failure/);
		await store.flush();

		const afterFailure = store.getGate("goal-1", "design")!;
		expect(afterFailure.signals[0]?.verification.status).toBe("running");
		expect(afterFailure.signals[0]?.verification).toEqual(runningVerification);
		expect(afterFailure.currentMetadata).toEqual({ concurrent: "mutation" });
		expect(afterFailure.updatedAt).toBe(runningUpdatedAt + 2);
		const failedWriteReader = new GateStore(stateDir, memfs, { persistence: "json" });
		expect(failedWriteReader.getGate("goal-1", "design")?.signals[0]?.verification).toEqual(runningVerification);
		expect(failedWriteReader.getGate("goal-1", "design")?.currentMetadata).toEqual({ concurrent: "mutation" });
		failedWriteReader.dispose();

		clock.mockRestore();
		(memfs.promises as any).rename = originalRename;
		await expect(store.updateSignalVerificationStrict(signal.id, terminal)).resolves.toBeUndefined();
		const durableReader = new GateStore(stateDir, memfs, { persistence: "json" });
		expect(durableReader.getGate("goal-1", "design")?.signals[0]?.verification).toEqual(terminal);
		expect(durableReader.getGate("goal-1", "design")?.currentMetadata).toEqual({ concurrent: "mutation" });
		durableReader.dispose();
		errorSpy.mockRestore();
		await store.close();
	});

	it("rolls back a rejected SQLite strict verification publication", async () => {
		const stateDir = tempRoot();
		const store = openStore(stateDir);
		store.initGatesForGoal("goal-sqlite-strict", ["design"]);
		const signal: GateSignal = {
			id: "sqlite-running-signal",
			goalId: "goal-sqlite-strict",
			gateId: "design",
			sessionId: "session-1",
			timestamp: 1,
			commitSha: "abc123",
			verification: { status: "running", steps: [] },
		};
		store.recordSignal(signal);
		await store.flush();
		const runningVerification = structuredClone(signal.verification);
		const terminal: GateSignal["verification"] & { injectedFailure?: { toJSON(): never } } = {
			status: "cancelled",
			cancellation: { cause: "manual", requestedAt: 2, finalizedAt: 3 },
			steps: [],
			injectedFailure: { toJSON: () => { throw new Error("injected SQLite strict serialization failure"); } },
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(store.updateSignalVerificationStrict(signal.id, terminal)).rejects.toThrow(/injected SQLite strict serialization failure/);
		expect(store.getGate("goal-sqlite-strict", "design")?.signals[0]?.verification).toEqual(runningVerification);

		delete terminal.injectedFailure;
		await expect(store.updateSignalVerificationStrict(signal.id, terminal)).resolves.toBeUndefined();
		const durableReader = openStore(stateDir);
		expect(durableReader.getGate("goal-sqlite-strict", "design")?.signals[0]?.verification).toEqual(terminal);
		errorSpy.mockRestore();
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
