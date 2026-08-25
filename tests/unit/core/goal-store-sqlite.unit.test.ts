import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoalStore, type PersistedGoal } from "../../../src/server/agent/goal-store.js";
import { readDeletionTombstones } from "../../../src/server/agent/deletion-tombstones.js";
import { createMemFs } from "../../support/harnesses/mem-fs.js";

const roots: string[] = [];
const stores: GoalStore[] = [];

function tempRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-goal-sqlite-"));
	roots.push(dir);
	return dir;
}

function openStore(stateDir: string): GoalStore {
	const store = new GoalStore(stateDir);
	stores.push(store);
	return store;
}

function goal(id: string, overrides: Partial<PersistedGoal> = {}): PersistedGoal {
	return {
		id,
		title: `Goal ${id}`,
		cwd: `/work/${id}`,
		state: "todo",
		spec: `# ${id}`,
		createdAt: 10,
		updatedAt: 20,
		setupStatus: "ready",
		...overrides,
	};
}

function createUnmarkedDatabase(stateDir: string, failInserts = false): void {
	const db = new Database(path.join(stateDir, "goals.sqlite"));
	db.exec(`
		CREATE TABLE goal_store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;
		CREATE TABLE goal_records (id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;
		PRAGMA user_version = 1;
	`);
	if (failInserts) db.exec("CREATE TRIGGER fail_goal_import BEFORE INSERT ON goal_records BEGIN SELECT RAISE(ABORT, 'injected import failure'); END;");
	db.close();
}

async function closeTracked(store: GoalStore): Promise<void> {
	stores.splice(stores.indexOf(store), 1);
	await store.close();
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const store of stores.splice(0)) await store.close().catch(() => {});
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("GoalStore SQLite persistence", () => {
	it("retains JSON persistence and historical canonicalization for injected filesystems", async () => {
		const memfs = createMemFs();
		const stateDir = path.resolve("/memfs/goal-store-sqlite-json");
		memfs.mkdirSync(stateDir, { recursive: true });
		memfs.writeFileSync(path.join(stateDir, "goals.json"), JSON.stringify([{
			...goal("legacy"),
			swarm: true,
			skipArtifactRequirements: ["design"],
			setupStatus: undefined,
			metadata: [],
			inlineRoles: "bad",
			worktreeSetupCommand: "echo old",
		}]), "utf-8");
		const store = new GoalStore(stateDir, memfs);
		expect(store.get("legacy")).toMatchObject({ team: true, skipGateRequirements: ["design"], setupStatus: "ready" });
		expect(store.get("legacy")).not.toHaveProperty("swarm");
		expect(store.get("legacy")).not.toHaveProperty("metadata");
		store.put(goal("new"));
		await store.close();
		expect(memfs.existsSync(path.join(stateDir, "goals.json"))).toBe(true);
		expect(memfs.existsSync(path.join(stateDir, "goals.sqlite"))).toBe(false);
		const reloaded = new GoalStore(stateDir, memfs, { persistence: "json" });
		expect(reloaded.getAll().map(item => item.id).sort()).toEqual(["legacy", "new"]);
		await reloaded.close();
	});

	it("initializes an authoritative empty database and durably publishes only dirty records", async () => {
		const stateDir = tempRoot();
		const store = openStore(stateDir);
		expect(store.getAll()).toEqual([]);
		const dbFile = path.join(stateDir, "goals.sqlite");
		expect(fs.existsSync(dbFile)).toBe(true);
		store.put(goal("one", { metadata: { unicode: "✓" } }));
		store.put(goal("two", { title: "Untouched" }));
		await store.flush();
		const db = new Database(dbFile);
		const untouched = (db.prepare("SELECT payload FROM goal_records WHERE id = ?").get("two") as { payload: string }).payload;
		db.close();

		store.update("one", { title: "Changed" });
		await store.flush();
		expect(store.getPersistenceMetrics()?.bytes).toBe(Buffer.byteLength(JSON.stringify(store.get("one"))));
		const check = new Database(dbFile);
		expect((check.prepare("SELECT payload FROM goal_records WHERE id = ?").get("two") as { payload: string }).payload).toBe(untouched);
		expect((check.prepare("SELECT COUNT(*) AS count FROM goal_records").get() as { count: number }).count).toBe(2);
		expect(check.prepare("SELECT value FROM goal_store_meta WHERE key = 'migration_complete'").get()).toEqual({ value: "1" });
		check.close();
		await closeTracked(store);
		const reloaded = openStore(stateDir);
		expect(reloaded.get("one")?.title).toBe("Changed");
	});

	it("preserves null workflow clears through runtime publication and authoritative reload", async () => {
		const stateDir = tempRoot();
		const store = openStore(stateDir);
		store.put(goal("runtime-null", {
			workflowId: "feature",
			workflow: {
				id: "feature",
				name: "Feature",
				description: "Feature workflow",
				gates: [],
				createdAt: 1,
				updatedAt: 2,
			},
		}));
		await store.flush();

		expect(store.update("runtime-null", { workflowId: null, workflow: null } as any)).toBe(true);
		expect(store.get("runtime-null")).toMatchObject({ workflowId: null, workflow: null });
		await store.flush();

		const db = new Database(path.join(stateDir, "goals.sqlite"));
		const payload = JSON.parse((db.prepare("SELECT payload FROM goal_records WHERE id = ?").get("runtime-null") as { payload: string }).payload);
		expect(payload).toMatchObject({ workflowId: null, workflow: null });
		db.close();

		await closeTracked(store);
		const reopened = openStore(stateDir);
		expect(reopened.get("runtime-null")).toMatchObject({ workflowId: null, workflow: null });
	});

	it("migrates legacy null workflow fields exactly and reloads them from SQLite", async () => {
		const stateDir = tempRoot();
		const legacyFile = path.join(stateDir, "goals.json");
		const legacyGoal = goal("legacy-null", { workflowId: null, workflow: null } as any);
		const sourceBytes = Buffer.from(JSON.stringify([legacyGoal]));
		fs.writeFileSync(legacyFile, sourceBytes);

		const migrated = openStore(stateDir);
		expect(migrated.get("legacy-null")).toEqual(legacyGoal);
		expect(fs.readFileSync(`${legacyFile}.sqlite-retired`)).toEqual(sourceBytes);
		const db = new Database(path.join(stateDir, "goals.sqlite"));
		const payload = JSON.parse((db.prepare("SELECT payload FROM goal_records WHERE id = ?").get("legacy-null") as { payload: string }).payload);
		expect(payload).toEqual(legacyGoal);
		db.close();

		await closeTracked(migrated);
		const reopened = openStore(stateDir);
		expect(reopened.get("legacy-null")).toEqual(legacyGoal);
	});

	it("reopens persisted inline roles under the historical compatibility contract without rewriting them", async () => {
		const stateDir = tempRoot();
		const initialized = openStore(stateDir);
		await closeTracked(initialized);

		const inlineRoles = {
			reviewer: {
				name: "reviewer",
				label: "Legacy reviewer",
				promptTemplate: "Review the persisted goal",
				accessory: "legacy-accessory",
				model: "bare-legacy-model",
				thinkingLevel: "legacy-deep",
				toolPolicies: { bash: "prompt-every-time" },
				createdAt: 11,
				updatedAt: 12,
			},
		};
		const legacyGoal = goal("legacy-inline-role", { inlineRoles } as any);
		const payload = JSON.stringify(legacyGoal);
		const dbFile = path.join(stateDir, "goals.sqlite");
		let db = new Database(dbFile);
		db.prepare("INSERT INTO goal_records (id, payload) VALUES (?, ?)").run(legacyGoal.id, payload);
		db.close();

		const reopened = openStore(stateDir);
		expect(reopened.get(legacyGoal.id)?.inlineRoles).toEqual(inlineRoles);
		await closeTracked(reopened);

		db = new Database(dbFile);
		expect((db.prepare("SELECT payload FROM goal_records WHERE id = ?").get(legacyGoal.id) as { payload: string }).payload).toBe(payload);
		db.close();
	});

	it("migrates legacy JSON inline roles without normalizing their values", async () => {
		const stateDir = tempRoot();
		const legacyFile = path.join(stateDir, "goals.json");
		const inlineRoles = {
			builder: {
				name: "builder",
				label: "Legacy builder",
				promptTemplate: "Build from the old snapshot",
				model: "old-model-id",
				thinkingLevel: "maximum-plus",
				toolPolicies: { edit: "legacy-custom-policy" },
			},
		};
		const legacyGoal = goal("legacy-json-inline-role", { inlineRoles } as any);
		const sourceBytes = Buffer.from(JSON.stringify([legacyGoal]));
		fs.writeFileSync(legacyFile, sourceBytes);

		const migrated = openStore(stateDir);
		expect(migrated.get(legacyGoal.id)?.inlineRoles).toEqual(inlineRoles);
		expect(fs.readFileSync(`${legacyFile}.sqlite-retired`)).toEqual(sourceBytes);
		await closeTracked(migrated);

		const reopened = openStore(stateDir);
		expect(reopened.get(legacyGoal.id)?.inlineRoles).toEqual(inlineRoles);
	});

	it("migrates a legacy verify step whose type was retired instead of failing the load", async () => {
		const stateDir = tempRoot();
		const legacyFile = path.join(stateDir, "goals.json");
		// `remote-state` is a retired verify-step type still present in older
		// goals.json (e.g. `{ type: "remote-state", operation: "publish-branch" }`).
		// The migration must preserve it, not reject it against a current allow-list.
		const legacyGoal = goal("legacy-retired-type", {
			workflow: {
				id: "wf-1",
				name: "Legacy workflow",
				description: "",
				createdAt: 1,
				updatedAt: 2,
				gates: [{
					id: "publish",
					name: "Publish",
					dependsOn: [],
					verify: [{ name: "Branch pushed to remote", type: "remote-state", operation: "publish-branch" }],
				}],
			},
		} as any);
		fs.writeFileSync(legacyFile, JSON.stringify([legacyGoal]), "utf-8");

		const migrated = openStore(stateDir);
		const step = (migrated.get("legacy-retired-type")?.workflow as any)?.gates?.[0]?.verify?.[0];
		expect(step?.type).toBe("remote-state");
		expect(fs.existsSync(`${legacyFile}.sqlite-retired`)).toBe(true);

		// The retired type is durable across a restart.
		await closeTracked(migrated);
		const reopened = openStore(stateDir);
		expect(((reopened.get("legacy-retired-type")?.workflow as any)?.gates?.[0]?.verify?.[0])?.type).toBe("remote-state");
	});

	it("continues to reject non-null malformed workflow fields", async () => {
		const sourceDir = tempRoot();
		const sourceFile = path.join(sourceDir, "goals.json");
		const sourceBytes = Buffer.from(JSON.stringify([goal("invalid-source", { workflowId: 42 } as any)]));
		fs.writeFileSync(sourceFile, sourceBytes);
		expect(() => openStore(sourceDir)).toThrow(/workflowId must be a string or null/);
		expect(fs.readFileSync(sourceFile)).toEqual(sourceBytes);

		const runtimeDir = tempRoot();
		const runtime = openStore(runtimeDir);
		runtime.put(goal("invalid-runtime"));
		await runtime.flush();
		runtime.update("invalid-runtime", { workflow: "not-a-workflow" } as any);
		vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(runtime.flush()).rejects.toThrow(/workflow: must be an object/);
		runtime.update("invalid-runtime", { workflow: null } as any);
		await runtime.flush();
	});

	it("validates, merges, verifies, and retires live and recovery JSON without resurrecting tombstones", async () => {
		const stateDir = tempRoot();
		const live = goal("live", { title: "Live wins", metadata: { extension: { nested: true } } });
		const recoveryConflict = goal("live", { title: "Stale" });
		const recovered = goal("recovered", { spec: "Unicode ✓" });
		const deleted = goal("deleted");
		const liveFile = path.join(stateDir, "goals.json");
		const recoveryFile = `${liveFile}.pre-migration`;
		const liveBytes = Buffer.from(JSON.stringify([live]));
		const recoveryBytes = Buffer.from(JSON.stringify([recoveryConflict, recovered, deleted]));
		const tombstoneFile = path.join(stateDir, ".deletion-tombstones.json");
		const tombstoneBytes = Buffer.from(JSON.stringify({ "goals.json": ["deleted"] }, null, 2));
		fs.writeFileSync(liveFile, liveBytes);
		fs.writeFileSync(recoveryFile, recoveryBytes);
		fs.writeFileSync(tombstoneFile, tombstoneBytes);

		const store = openStore(stateDir);
		expect(store.getAll()).toEqual([live, recovered]);
		expect(fs.readFileSync(`${liveFile}.sqlite-retired`)).toEqual(liveBytes);
		expect(fs.readFileSync(`${liveFile}.pre-migration-recovered`)).toEqual(recoveryBytes);
		expect(fs.readFileSync(tombstoneFile)).toEqual(tombstoneBytes);
		expect(fs.existsSync(liveFile)).toBe(false);
		expect(fs.existsSync(recoveryFile)).toBe(false);
	});

	it("uses collision-safe retirement names even when the first free candidate races", () => {
		const stateDir = tempRoot();
		const source = path.join(stateDir, "goals.json");
		const preferred = `${source}.sqlite-retired`;
		const sourceBytes = Buffer.from(JSON.stringify([goal("collision")]));
		fs.writeFileSync(source, sourceBytes);
		fs.writeFileSync(preferred, "existing");
		const originalLink = fs.linkSync;
		let raced = false;
		vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
			if (!raced && String(to) === `${preferred}.1`) {
				raced = true;
				fs.writeFileSync(`${preferred}.1`, "racing");
			}
			return originalLink(from, to);
		});
		const store = openStore(stateDir);
		expect(store.get("collision")).toBeDefined();
		expect(fs.readFileSync(preferred, "utf-8")).toBe("existing");
		expect(fs.readFileSync(`${preferred}.1`, "utf-8")).toBe("racing");
		expect(fs.readFileSync(`${preferred}.2`)).toEqual(sourceBytes);
	});

	it("rejects malformed, duplicate, and failed imports without modifying source evidence", () => {
		const malformedDir = tempRoot();
		const malformedFile = path.join(malformedDir, "goals.json");
		const malformedBytes = Buffer.from(JSON.stringify([goal("ok"), goal("bad", { state: "unknown" as any })]));
		fs.writeFileSync(malformedFile, malformedBytes);
		expect(() => openStore(malformedDir)).toThrow(/legacy goal at index 1.*unsupported state/i);
		expect(fs.readFileSync(malformedFile)).toEqual(malformedBytes);

		const duplicateDir = tempRoot();
		const duplicateFile = path.join(duplicateDir, "goals.json");
		const duplicateBytes = Buffer.from(JSON.stringify([goal("same"), goal("same")]));
		fs.writeFileSync(duplicateFile, duplicateBytes);
		expect(() => openStore(duplicateDir)).toThrow(/Duplicate goals\.json goal same/);
		expect(fs.readFileSync(duplicateFile)).toEqual(duplicateBytes);

		const failedDir = tempRoot();
		const failedFile = path.join(failedDir, "goals.json");
		const failedBytes = Buffer.from(JSON.stringify([goal("failure")]));
		fs.writeFileSync(failedFile, failedBytes);
		createUnmarkedDatabase(failedDir, true);
		expect(() => openStore(failedDir)).toThrow(/injected import failure/);
		expect(fs.readFileSync(failedFile)).toEqual(failedBytes);
		const db = new Database(path.join(failedDir, "goals.sqlite"));
		expect((db.prepare("SELECT COUNT(*) AS count FROM goal_records").get() as { count: number }).count).toBe(0);
		expect((db.prepare("SELECT COUNT(*) AS count FROM goal_store_meta").get() as { count: number }).count).toBe(0);
		db.close();
	});

	it("rejects corrupt authoritative rows and identity mismatches while releasing the native handle", async () => {
		const stateDir = tempRoot();
		const store = openStore(stateDir);
		store.put(goal("right"));
		await closeTracked(store);
		const dbFile = path.join(stateDir, "goals.sqlite");
		let db = new Database(dbFile);
		db.prepare("UPDATE goal_records SET payload = ? WHERE id = ?").run("{broken", "right");
		db.close();
		expect(() => openStore(stateDir)).toThrow(/Invalid SQLite payload/);
		fs.renameSync(dbFile, `${dbFile}.corrupt`);

		const mismatchDir = tempRoot();
		const mismatch = openStore(mismatchDir);
		mismatch.put(goal("right"));
		await closeTracked(mismatch);
		const mismatchFile = path.join(mismatchDir, "goals.sqlite");
		db = new Database(mismatchFile);
		db.prepare("UPDATE goal_records SET payload = ? WHERE id = ?").run(JSON.stringify(goal("wrong")), "right");
		db.close();
		expect(() => openStore(mismatchDir)).toThrow(/row identity mismatch/);
		fs.renameSync(mismatchFile, `${mismatchFile}.mismatch`);
	});

	it("recovers only missing non-tombstoned rows into authoritative SQLite and preserves conflicts", async () => {
		const stateDir = tempRoot();
		const authoritative = openStore(stateDir);
		authoritative.put(goal("conflict", { title: "Durable" }));
		authoritative.put(goal("deleted"));
		await authoritative.flush();
		authoritative.remove("deleted");
		await closeTracked(authoritative);
		expect(readDeletionTombstones(stateDir, "goals.json")).toContain("deleted");
		fs.writeFileSync(path.join(stateDir, "goals.json.pre-migration"), JSON.stringify([
			goal("conflict", { title: "Stale" }), goal("deleted"), goal("recovered"),
		]));
		const recovered = openStore(stateDir);
		expect(recovered.get("conflict")?.title).toBe("Durable");
		expect(recovered.get("deleted")).toBeUndefined();
		expect(recovered.get("recovered")).toBeDefined();
		expect(fs.existsSync(path.join(stateDir, "goals.json.pre-migration-recovered"))).toBe(true);
	});

	it("retries interrupted post-commit retirement without reimporting changed source bytes", () => {
		const stateDir = tempRoot();
		const source = path.join(stateDir, "goals.json");
		const preferred = `${source}.sqlite-retired`;
		fs.writeFileSync(source, JSON.stringify([goal("committed", { title: "Committed" })]));
		const originalUnlink = fs.unlinkSync;
		let interrupted = false;
		vi.spyOn(fs, "unlinkSync").mockImplementation(file => {
			if (!interrupted && String(file) === source) {
				interrupted = true;
				const error = new Error("injected unlink interruption") as NodeJS.ErrnoException;
				error.code = "EACCES";
				throw error;
			}
			return originalUnlink(file);
		});
		expect(() => openStore(stateDir)).toThrow(/unlink interruption/);
		vi.restoreAllMocks();
		originalUnlink(source);
		fs.writeFileSync(source, JSON.stringify([goal("committed", { title: "Stale" }), goal("new-stale")]));
		const recovered = openStore(stateDir);
		expect(recovered.get("committed")?.title).toBe("Committed");
		expect(recovered.get("new-stale")).toBeUndefined();
		expect(fs.existsSync(source)).toBe(false);
		expect(fs.existsSync(preferred)).toBe(true);
		expect(fs.existsSync(`${preferred}.1`)).toBe(true);
	});

	it("rejects invalid runtime records transactionally before they can corrupt authoritative rows", async () => {
		const stateDir = tempRoot();
		const store = openStore(stateDir);
		store.put(goal("valid"));
		await store.flush();
		store.update("valid", { maxConcurrentChildren: Number.NaN });
		vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(store.flush()).rejects.toThrow(/maxConcurrentChildren must be finite/);
		let db = new Database(path.join(stateDir, "goals.sqlite"));
		expect(JSON.parse((db.prepare("SELECT payload FROM goal_records WHERE id = 'valid'").get() as { payload: string }).payload).maxConcurrentChildren).toBeUndefined();
		db.close();
		store.update("valid", { maxConcurrentChildren: 4 });
		await store.flush();
		await closeTracked(store);
		const reopened = openStore(stateDir);
		expect(reopened.get("valid")?.maxConcurrentChildren).toBe(4);
	});

	it("rolls back and requeues an entire dirty batch after serialization failure", async () => {
		const stateDir = tempRoot();
		const store = openStore(stateDir);
		store.put(goal("one"));
		store.put(goal("two"));
		await store.flush();
		store.update("one", { title: "Changed" });
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		store.update("two", { metadata: circular });
		vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(store.flush()).rejects.toThrow(/circular/i);
		const concurrent = openStore(stateDir);
		expect(concurrent.get("one")?.title).toBe("Goal one");
		expect(concurrent.get("two")?.metadata).toBeUndefined();
		await closeTracked(concurrent);
		store.update("two", { metadata: { fixed: true } });
		await store.flush();
		await closeTracked(store);
		const reloaded = openStore(stateDir);
		expect(reloaded.get("one")?.title).toBe("Changed");
		expect(reloaded.get("two")?.metadata).toEqual({ fixed: true });
	});

	it("validates the exact serialized goal payload before committing a dirty batch", async () => {
		const stateDir = tempRoot();
		const store = openStore(stateDir);
		store.put(goal("normal"));
		store.put(goal("deceptive"));
		await store.flush();

		store.update("normal", { title: "Changed" });
		store.put(Object.assign(goal("deceptive"), {
			toJSON() { return goal("wrong-id", { title: "Deceptive bytes" }); },
		}));
		vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(store.flush()).rejects.toThrow(/identity mismatch for deceptive/);

		store.put(Object.assign(goal("deceptive"), {
			toJSON() { return { ...goal("deceptive", { title: "Invalid legacy bytes" }), swarm: "not-a-boolean" }; },
		}));
		await expect(store.flush()).rejects.toThrow(/team must be boolean/);

		const reader = new Database(path.join(stateDir, "goals.sqlite"));
		expect(JSON.parse((reader.prepare("SELECT payload FROM goal_records WHERE id = 'normal'").get() as { payload: string }).payload).title).toBe("Goal normal");
		expect(JSON.parse((reader.prepare("SELECT payload FROM goal_records WHERE id = 'deceptive'").get() as { payload: string }).payload).title).toBe("Goal deceptive");
		reader.close();

		store.put(goal("deceptive", { title: "Corrected" }));
		await store.flush();
		await closeTracked(store);
		const reopened = openStore(stateDir);
		expect(reopened.get("normal")?.title).toBe("Changed");
		expect(reopened.get("deceptive")?.title).toBe("Corrected");
		await closeTracked(reopened);
	});

	it("rolls back a statement failure, retains the external delete tombstone, and retries deletion", async () => {
		const stateDir = tempRoot();
		const store = openStore(stateDir);
		store.put(goal("keep"));
		store.put(goal("delete"));
		await store.flush();
		const injector = new Database(path.join(stateDir, "goals.sqlite"));
		injector.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON goal_records WHEN old.id = 'delete' BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END;");
		store.update("keep", { title: "Rolled back" });
		store.remove("delete");
		vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(store.flush()).rejects.toThrow(/injected delete failure/);
		expect(readDeletionTombstones(stateDir, "goals.json")).toContain("delete");
		let reader = new Database(path.join(stateDir, "goals.sqlite"));
		expect(JSON.parse((reader.prepare("SELECT payload FROM goal_records WHERE id = 'keep'").get() as { payload: string }).payload).title).toBe("Goal keep");
		expect(reader.prepare("SELECT id FROM goal_records WHERE id = 'delete'").get()).toEqual({ id: "delete" });
		reader.close();
		injector.exec("DROP TRIGGER fail_delete");
		injector.close();
		await store.flush();
		reader = new Database(path.join(stateDir, "goals.sqlite"));
		expect(reader.prepare("SELECT id FROM goal_records WHERE id = 'delete'").get()).toBeUndefined();
		reader.close();
	});

	it("coalesces concurrent same-goal archive publication and permits a fresh retry", async () => {
		const stateDir = tempRoot();
		const store = openStore(stateDir);
		store.put(goal("coalesced-target", { state: "in-progress" }));
		store.put(goal("independent-target", { state: "in-progress" }));
		store.put(goal("unrelated-update", { title: "Before" }));
		await store.flush();
		const archivedHooks: string[] = [];
		store.onGoalArchived = (row) => { archivedHooks.push(row.id); };

		const persistence = (store as any).persistence;
		const originalPublishStrict = persistence.publishStrict.bind(persistence);
		let rejectArchive!: (error: Error) => void;
		let entered!: () => void;
		const archiveEntered = new Promise<void>((resolve) => { entered = resolve; });
		vi.spyOn(persistence, "publishStrict")
			.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
				rejectArchive = reject;
				entered();
			}))
			.mockImplementation((...args: unknown[]) => originalPublishStrict(args[0] as Iterable<string>));

		const first = store.archiveStrict("coalesced-target");
		await archiveEntered;
		const second = store.archiveStrict("coalesced-target");
		expect(second).toBe(first);

		store.update("unrelated-update", { title: "Concurrent" });
		expect(store.get("unrelated-update")?.title).toBe("Concurrent");
		await expect(store.archiveStrict("independent-target")).resolves.toBe(true);
		expect(store.get("independent-target")?.archived).toBe(true);

		const firstRejected = expect(first).rejects.toThrow(/coalesced archive failure/);
		const secondRejected = expect(second).rejects.toThrow(/coalesced archive failure/);
		rejectArchive(new Error("injected coalesced archive failure"));
		await Promise.all([firstRejected, secondRejected]);

		expect(store.get("coalesced-target")?.archived).toBeUndefined();
		expect(store.get("coalesced-target")?.archivedAt).toBeUndefined();
		expect(archivedHooks).toEqual(["independent-target"]);
		await store.flush();
		const failedReload = openStore(stateDir);
		expect(failedReload.get("coalesced-target")?.archived).toBeUndefined();
		await closeTracked(failedReload);

		await expect(store.archiveStrict("coalesced-target")).resolves.toBe(true);
		expect(archivedHooks).toEqual(["independent-target", "coalesced-target"]);
		await closeTracked(store);
		const successfulReload = openStore(stateDir);
		expect(successfulReload.get("coalesced-target")?.archived).toBe(true);
		await closeTracked(successfulReload);
	});

	it("preserves a concurrent same-goal update when archive publication rejects", async () => {
		const stateDir = tempRoot();
		const store = openStore(stateDir);
		store.put(goal("archive-race", { state: "in-progress" }));
		await store.flush();
		let archiveHooks = 0;
		store.onGoalArchived = () => { archiveHooks++; };

		const persistence = (store as any).persistence;
		const originalPublishStrict = persistence.publishStrict.bind(persistence);
		let rejectArchive!: (error: Error) => void;
		let entered!: () => void;
		const archiveEntered = new Promise<void>((resolve) => { entered = resolve; });
		vi.spyOn(persistence, "publishStrict")
			.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
				rejectArchive = reject;
				entered();
			}))
			.mockImplementation((...args: unknown[]) => originalPublishStrict(args[0] as Iterable<string>));

		const archiving = store.archiveStrict("archive-race");
		await archiveEntered;
		store.update("archive-race", { state: "complete", metadata: { merged: true } });
		const concurrentUpdatedAt = store.get("archive-race")!.updatedAt;
		rejectArchive(new Error("injected deferred archive failure"));
		await expect(archiving).rejects.toThrow(/deferred archive failure/);

		expect(store.get("archive-race")).toMatchObject({
			state: "complete",
			metadata: { merged: true },
			updatedAt: concurrentUpdatedAt,
		});
		expect(store.get("archive-race")).not.toHaveProperty("archived");
		expect(store.get("archive-race")).not.toHaveProperty("archivedAt");
		expect(archiveHooks).toBe(0);
		await store.flush();
		await closeTracked(store);

		const reloaded = openStore(stateDir);
		expect(reloaded.get("archive-race")).toMatchObject({ state: "complete", metadata: { merged: true } });
		expect(reloaded.get("archive-race")).not.toHaveProperty("archived");
		expect(reloaded.get("archive-race")).not.toHaveProperty("archivedAt");
	});

	it("fully rolls back archive failure without erasing an unrelated goal generation", async () => {
		const stateDir = tempRoot();
		const store = openStore(stateDir);
		store.put(goal("archive-target", { state: "in-progress" }));
		store.put(goal("unrelated", { title: "Before" }));
		await store.flush();
		const beforeTarget = { ...store.get("archive-target")! };

		const persistence = (store as any).persistence;
		const originalPublishStrict = persistence.publishStrict.bind(persistence);
		let rejectArchive!: (error: Error) => void;
		let entered!: () => void;
		const archiveEntered = new Promise<void>((resolve) => { entered = resolve; });
		vi.spyOn(persistence, "publishStrict")
			.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
				rejectArchive = reject;
				entered();
			}))
			.mockImplementation((...args: unknown[]) => originalPublishStrict(args[0] as Iterable<string>));

		const archiving = store.archiveStrict("archive-target");
		await archiveEntered;
		store.update("unrelated", { title: "Concurrent" });
		const concurrentGeneration = store.getGeneration();
		rejectArchive(new Error("injected unrelated archive failure"));
		await expect(archiving).rejects.toThrow(/unrelated archive failure/);

		expect(store.get("archive-target")).toEqual(beforeTarget);
		expect(store.get("unrelated")?.title).toBe("Concurrent");
		expect(store.getGeneration()).toBeGreaterThan(concurrentGeneration);
	});

	it("rolls back only strict-update fields when a later same-goal update wins", async () => {
		const stateDir = tempRoot();
		const store = openStore(stateDir);
		store.put(goal("strict-race", { state: "in-progress" }));
		await store.flush();

		const persistence = (store as any).persistence;
		const originalPublishStrict = persistence.publishStrict.bind(persistence);
		let rejectStrict!: (error: Error) => void;
		let entered!: () => void;
		const strictEntered = new Promise<void>((resolve) => { entered = resolve; });
		vi.spyOn(persistence, "publishStrict")
			.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
				rejectStrict = reject;
				entered();
			}))
			.mockImplementation((...args: unknown[]) => originalPublishStrict(args[0] as Iterable<string>));

		const marking = store.updateStrict("strict-race", { team: true });
		await strictEntered;
		store.update("strict-race", { state: "complete", metadata: { merged: true } });
		const concurrentUpdatedAt = store.get("strict-race")!.updatedAt;
		rejectStrict(new Error("injected deferred marker failure"));
		await expect(marking).rejects.toThrow(/deferred marker failure/);

		expect(store.get("strict-race")).toMatchObject({
			state: "complete",
			metadata: { merged: true },
			updatedAt: concurrentUpdatedAt,
		});
		expect(store.get("strict-race")).not.toHaveProperty("team");
		await store.flush();
		await closeTracked(store);

		const reloaded = openStore(stateDir);
		expect(reloaded.get("strict-race")).toMatchObject({ state: "complete", metadata: { merged: true } });
		expect(reloaded.get("strict-race")).not.toHaveProperty("team");
	});

	it("compensates strict updates on publication failure without firing observers", async () => {
		const stateDir = tempRoot();
		const store = openStore(stateDir);
		store.put(goal("strict", { state: "complete" }));
		await store.flush();
		let observerCalls = 0;
		store.onIndexUpdate = () => { observerCalls++; };
		const beforeGeneration = store.getGeneration();
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(store.updateStrict("strict", { metadata: circular, state: "in-progress" })).rejects.toThrow(/circular/i);
		expect(store.get("strict")).toMatchObject({ state: "complete" });
		expect(store.get("strict")?.metadata).toBeUndefined();
		expect(store.getGeneration()).toBe(beforeGeneration);
		expect(observerCalls).toBe(0);
		await store.flush();
		await expect(store.updateStrict("strict", { state: "complete" })).resolves.toBe(true);
	});

	it("shares concurrent close, drains accepted writes, fences every mutator, and releases the handle", async () => {
		const stateDir = tempRoot();
		const store = openStore(stateDir);
		store.put(goal("accepted"));
		const closing = store.close();
		expect(store.close()).toBe(closing);
		for (const mutate of [
			() => store.put(goal("late")),
			() => store.remove("accepted"),
			() => store.archive("accepted"),
			() => store.update("accepted", { title: "late" }),
			() => store.bumpGeneration(),
		]) expect(mutate).toThrow(/GoalStore is closing or closed/);
		await expect(store.updateStrict("accepted", { title: "late" })).rejects.toThrow(/GoalStore is closing or closed/);
		await closing;
		stores.splice(stores.indexOf(store), 1);
		const dbFile = path.join(stateDir, "goals.sqlite");
		fs.renameSync(dbFile, `${dbFile}.released`);
		fs.renameSync(`${dbFile}.released`, dbFile);
		const reloaded = openStore(stateDir);
		expect(reloaded.get("accepted")).toBeDefined();
	});

	it("retries one transient final failure and restores the durable payload", async () => {
		const transientDir = tempRoot();
		const transient = openStore(transientDir);
		transient.put(goal("transient"));
		await transient.flush();
		let attempts = 0;
		transient.update("transient", { metadata: { toJSON() { attempts++; if (attempts === 1) throw new Error("transient close failure"); return { recovered: true }; } } });
		vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(transient.close()).resolves.toBeUndefined();
		expect(attempts).toBe(2);
		stores.splice(stores.indexOf(transient), 1);
		const recovered = openStore(transientDir);
		expect(recovered.get("transient")?.metadata).toEqual({ recovered: true });
	});

	it("rejects persistent final failure for every caller and releases the handle", async () => {
		const persistentDir = tempRoot();
		const persistent = openStore(persistentDir);
		persistent.put(goal("persistent"));
		await persistent.flush();
		let persistentAttempts = 0;
		persistent.update("persistent", { metadata: { toJSON() { persistentAttempts++; throw new Error("persistent close failure"); } } });
		vi.spyOn(console, "error").mockImplementation(() => {});
		const close = persistent.close();
		const outcomes = await Promise.allSettled([close, persistent.close()]);
		expect(outcomes.map(item => item.status)).toEqual(["rejected", "rejected"]);
		expect(persistentAttempts).toBe(2);
		stores.splice(stores.indexOf(persistent), 1);
		const dbFile = path.join(persistentDir, "goals.sqlite");
		fs.renameSync(dbFile, `${dbFile}.released`);
	});
});
