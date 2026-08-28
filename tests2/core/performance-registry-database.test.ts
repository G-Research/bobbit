import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
	PERFORMANCE_ACTIVITY_LIMIT,
	PERFORMANCE_DATABASE_FILE,
	PerformanceDatabase,
	PerformanceDatabaseError,
} from "../../market-packs/performance-optimisation/src/performance-database.ts";

const roots: string[] = [];
function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-performance-registry-"));
	roots.push(root);
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function deterministicDb(root: string): PerformanceDatabase {
	let id = 0;
	let time = 0;
	return new PerformanceDatabase(root, {
		id: prefix => `${prefix}-${++id}`,
		now: () => new Date(Date.UTC(2025, 0, 1, 0, 0, time++)).toISOString(),
	});
}

describe("performance registry SQLite kernel", () => {
	it("creates the complete forward schema with WAL, foreign keys, and durable revision", () => {
		const root = tempRoot();
		const db = deterministicDb(root);
		const tables = (db.unsafeStatementForTests("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name);
		for (const expected of [
			"schema_migrations", "programme_settings", "scan_units", "scan_unit_files", "scan_attempts", "hypotheses",
			"hypothesis_locations", "hypothesis_observations", "hypothesis_goal_links", "benchmark_references", "benchmark_bindings",
			"benchmark_runs", "hypothesis_outcomes", "activity_events",
		]) expect(tables).toContain(expected);
		expect(db.unsafeStatementForTests("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
		expect(db.unsafeStatementForTests("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
		expect(db.revision()).toBe(0);
		db.configureProgramme({ maxParallelIdeators: 4, targetActiveGoals: 3, scannerStaffId: "scanner-1" });
		expect(db.revision()).toBe(1);
		db.close();

		const reopened = new PerformanceDatabase(root);
		expect(reopened.programmeStatus()).toMatchObject({ revision: 1, maxParallelIdeators: 4, targetActiveGoals: 3, scannerStaffId: "scanner-1" });
		reopened.close();
	});

	it("migrates legacy proposal claims back to open direct-goal scheduling", () => {
		const root = tempRoot();
		const db = deterministicDb(root);
		db.unsafeStatementForTests("INSERT INTO hypotheses(id,exact_fingerprint,title,description,improvement_types_json,confidence,impact,risk,scheduling_state,proposal_session_id,created_at,updated_at) VALUES('hyp-legacy','fingerprint','Legacy claim','Old proposal draft','[]','high','low','low','proposal-pending','delegate-session','2025-01-01','2025-01-01')").run();
		db.unsafeStatementForTests("DELETE FROM schema_migrations WHERE version=2").run();
		db.close();

		const migrated = deterministicDb(root);
		const hypothesis = migrated.hypothesisById("hyp-legacy") as { schedulingState: string; goalClaimSessionId?: string };
		const schema = migrated.unsafeStatementForTests("SELECT MAX(version) AS version FROM schema_migrations").get();
		migrated.close();
		expect(hypothesis).toMatchObject({ schedulingState: "open" });
		expect(hypothesis.goalClaimSessionId).toBeUndefined();
		expect(schema).toMatchObject({ version: 2 });
	});

	it("retains only the latest 50 activity rows newest first and advances revision atomically", () => {
		const root = tempRoot();
		const db = deterministicDb(root);
		for (let index = 0; index < PERFORMANCE_ACTIVITY_LIMIT + 7; index++) db.configureProgramme({ targetActiveGoals: index % 10 });
		const activity = db.activity() as { revision: number; items: Array<{ id: string; at: string }> };
		expect(activity.revision).toBe(57);
		expect(activity.items).toHaveLength(PERFORMANCE_ACTIVITY_LIMIT);
		expect(activity.items[0].id).toBe("activity-57");
		expect(activity.items.at(-1)?.id).toBe("activity-8");
		expect(activity.items.map(item => item.at)).toEqual([...activity.items.map(item => item.at)].sort().reverse());
		db.close();
	});

	it("rejects newer and corrupt databases without replacing them", () => {
		const newerRoot = tempRoot();
		const newerFile = path.join(newerRoot, PERFORMANCE_DATABASE_FILE);
		const raw = new Database(newerFile);
		raw.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES(999, 'future');");
		raw.close();
		expect(() => new PerformanceDatabase(newerRoot)).toThrowError(expect.objectContaining<Partial<PerformanceDatabaseError>>({ code: "NEWER_SCHEMA" }));
		expect(fs.existsSync(newerFile)).toBe(true);

		const corruptRoot = tempRoot();
		const corruptFile = path.join(corruptRoot, PERFORMANCE_DATABASE_FILE);
		fs.writeFileSync(corruptFile, "this is not sqlite", "utf8");
		const original = fs.readFileSync(corruptFile);
		expect(() => new PerformanceDatabase(corruptRoot)).toThrowError(expect.objectContaining<Partial<PerformanceDatabaseError>>({ code: "CORRUPT_DATABASE" }));
		expect(fs.readFileSync(corruptFile)).toEqual(original);
	});
});
