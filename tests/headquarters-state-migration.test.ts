import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { migrateLegacyHeadquartersDirectory, migrateToPerProjectState } = await import("../src/server/agent/state-migration.ts");
const {
	HEADQUARTERS_PROJECT_ID,
	HEADQUARTERS_PROJECT_NAME,
	ProjectRegistry,
} = await import("../src/server/agent/project-registry.ts");

function tmpRoot(prefix = "bobbit-hq-migration-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function readJson<T = any>(filePath: string): T {
	return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function seedProject(stateDir: string, project: Record<string, unknown>, extra: Array<Record<string, unknown>> = []): void {
	writeJson(path.join(stateDir, "projects.json"), [project, ...extra]);
}

function hqProject(rootPath: string): Record<string, unknown> {
	return {
		id: HEADQUARTERS_PROJECT_ID,
		name: HEADQUARTERS_PROJECT_NAME,
		kind: "headquarters",
		rootPath,
		createdAt: 1,
		colorLight: "#fff",
		colorDark: "#000",
	};
}

function normalProject(id: string, rootPath: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id,
		name: "Normal Project",
		rootPath,
		createdAt: 2,
		position: 0,
		colorLight: "#fff",
		colorDark: "#000",
		...extra,
	};
}

function migrateDirs(serverRoot: string) {
	const headquartersDir = path.join(serverRoot, ".bobbit", "headquarters");
	return {
		serverRunDir: serverRoot,
		headquartersDir,
		headquartersStateDir: path.join(headquartersDir, "state"),
		headquartersConfigDir: path.join(headquartersDir, "config"),
		legacyServerBobbitDir: path.join(serverRoot, ".bobbit"),
	};
}

describe("Headquarters directory migration", () => {
	it("moves deterministic server state/config into the default Headquarters directory", () => {
		const root = tmpRoot();
		const legacyStateDir = path.join(root, ".bobbit", "state");
		const legacyConfigDir = path.join(root, ".bobbit", "config");
		fs.mkdirSync(legacyConfigDir, { recursive: true });
		seedProject(legacyStateDir, hqProject(root));
		writeJson(path.join(legacyStateDir, "sessions.json"), [{ id: "s1", title: "S", cwd: root, agentSessionFile: "a.jsonl", createdAt: 1, lastActivity: 1 }]);
		fs.writeFileSync(path.join(legacyStateDir, "preferences.json"), JSON.stringify({ theme: "dark" }), "utf-8");
		fs.writeFileSync(path.join(legacyConfigDir, "project.yaml"), "name: Server Config\n", "utf-8");

		const dirs = migrateDirs(root);
		const diagnostics = migrateLegacyHeadquartersDirectory(dirs);

		assert.equal(fs.existsSync(path.join(dirs.headquartersStateDir, ".headquarters-dir-migrated")), true);
		assert.equal(readJson(path.join(dirs.headquartersStateDir, "preferences.json")).theme, "dark");
		assert.equal(readJson(path.join(dirs.headquartersStateDir, "sessions.json"))[0].projectId, HEADQUARTERS_PROJECT_ID);
		assert.equal(fs.readFileSync(path.join(dirs.headquartersConfigDir, "project.yaml"), "utf-8"), "name: Server Config\n");
		assert.equal(diagnostics.ambiguousRecords.length, 0);

		const second = migrateLegacyHeadquartersDirectory(dirs);
		assert.ok(second.skipped.some(entry => entry.includes("destination differs") || entry.includes("already present")), "migration should be idempotent and preserve existing HQ files");
	});

	it("sanitizes migrated Headquarters execution records and is idempotent", () => {
		const root = tmpRoot();
		const legacyStateDir = path.join(root, ".bobbit", "state");
		const dirs = migrateDirs(root);
		const worktreePath = path.join(root, "..", "repo-wt", "goal-branch");
		const repoWorktrees = { ".": worktreePath };
		seedProject(legacyStateDir, hqProject(root));
		writeJson(path.join(legacyStateDir, "sessions.json"), [{
			id: "s1",
			title: "Legacy HQ",
			cwd: root,
			agentSessionFile: "a.jsonl",
			projectId: HEADQUARTERS_PROJECT_ID,
			createdAt: 1,
			lastActivity: 1,
			worktreePath,
			repoPath: root,
			repoWorktrees,
			branch: "goal/legacy",
			worktreePushPolicy: "publish",
			remotePublicationPolicy: "publish",
			drafts: { keep: true },
		}]);
		writeJson(path.join(legacyStateDir, "goals.json"), [{
			id: "g1",
			title: "Legacy goal",
			cwd: root,
			state: "todo",
			spec: "keep",
			projectId: HEADQUARTERS_PROJECT_ID,
			createdAt: 1,
			updatedAt: 1,
			worktreePath,
			repoPath: root,
			repoWorktrees,
			branch: "goal/legacy",
			setupStatus: "preparing",
			setupError: "boom",
			metadata: { keep: true },
		}]);
		writeJson(path.join(legacyStateDir, "staff.json"), [{
			id: "staff1",
			name: "Staff",
			description: "keep",
			systemPrompt: "keep",
			cwd: root,
			state: "active",
			triggers: [],
			memory: "keep",
			accessory: "none",
			createdAt: 1,
			updatedAt: 1,
			projectId: HEADQUARTERS_PROJECT_ID,
			worktreePath,
			repoPath: root,
			repoWorktrees,
			branch: "goal/legacy",
		}]);
		writeJson(path.join(legacyStateDir, "team-state.json"), [{
			goalId: "g1",
			teamLeadSessionId: "s1",
			maxConcurrent: 1,
			agents: [{
				sessionId: "s2",
				role: "coder",
				task: "keep",
				createdAt: 1,
				worktreePath,
				branch: "goal/member",
				baseSha: "abc123",
			}],
		}]);

		const diagnostics = migrateLegacyHeadquartersDirectory(dirs);
		const sessionFile = path.join(dirs.headquartersStateDir, "sessions.json");
		const goalFile = path.join(dirs.headquartersStateDir, "goals.json");
		const staffFile = path.join(dirs.headquartersStateDir, "staff.json");
		const teamFile = path.join(dirs.headquartersStateDir, "team-state.json");
		const session = readJson<Array<Record<string, unknown>>>(sessionFile)[0];
		const goal = readJson<Array<Record<string, unknown>>>(goalFile)[0];
		const staff = readJson<Array<Record<string, unknown>>>(staffFile)[0];
		const team = readJson<Array<Record<string, unknown>>>(teamFile)[0];
		const unsafeFields = ["worktreePath", "repoPath", "repoWorktrees", "branch", "setupStatus", "setupError", "worktreePushPolicy", "remotePublicationPolicy"];

		for (const record of [session, goal, staff]) {
			assert.equal(path.resolve(String(record.cwd)), path.resolve(dirs.headquartersDir));
			assert.equal(record.projectId, HEADQUARTERS_PROJECT_ID);
			for (const field of unsafeFields) {
				assert.equal(Object.hasOwn(record, field), false, `${field} should be removed from ${String(record.id)}`);
			}
		}
		assert.deepEqual(session.drafts, { keep: true });
		assert.deepEqual(goal.metadata, { keep: true });
		assert.equal(staff.memory, "keep");
		assert.equal(Object.hasOwn((team.agents as Array<Record<string, unknown>>)[0], "worktreePath"), false);
		assert.equal(Object.hasOwn((team.agents as Array<Record<string, unknown>>)[0], "branch"), false);
		assert.equal(Object.hasOwn((team.agents as Array<Record<string, unknown>>)[0], "baseSha"), false);
		assert.equal((team.agents as Array<Record<string, unknown>>)[0].task, "keep");
		assert.ok(diagnostics.sanitizedHeadquartersRecords.some(entry => entry.file === "sessions.json" && entry.key === "s1"));
		assert.ok(readJson<{ sanitizedHeadquartersRecords: Array<{ file: string; key: string }> }>(path.join(dirs.headquartersStateDir, "headquarters-migration-diagnostics.json"))
			.sanitizedHeadquartersRecords.some(entry => entry.file === "sessions.json" && entry.key === "s1"));

		const firstStores = [sessionFile, goalFile, staffFile, teamFile].map(file => fs.readFileSync(file, "utf-8"));
		const second = migrateLegacyHeadquartersDirectory(dirs);
		assert.deepEqual([sessionFile, goalFile, staffFile, teamFile].map(file => fs.readFileSync(file, "utf-8")), firstStores);
		assert.equal(second.sanitizedHeadquartersRecords.length, 0);
	});

	// Regression: SessionStore persists sessions.json as a versioned envelope
	// `{ version: 2, epoch, sessions: [...] }`. Sanitizing that store must round-trip
	// the envelope. The earlier bug flattened it into a bare array whose top-level
	// keys became `{ id: "version" | "epoch" | "sessions" }` pseudo-records that
	// SessionStore could not load, so `/api/sessions?projectId=headquarters` returned
	// [] after restart. This unit guard pins the envelope through sanitization.
	it("preserves the sessions.json v2 envelope while sanitizing Headquarters session records", () => {
		const root = tmpRoot();
		const dirs = migrateDirs(root);
		const epoch = 7;
		const worktreePath = path.join(root, "..", "repo-wt", "goal-branch");
		// Seed an existing Headquarters state sessions.json in the versioned envelope
		// shape, with a session whose cwd/worktree/git fields require sanitization.
		writeJson(path.join(dirs.headquartersStateDir, "sessions.json"), {
			version: 2,
			epoch,
			sessions: [{
				id: "hq-envelope-1",
				title: "HQ session",
				cwd: worktreePath,
				agentSessionFile: "a.jsonl",
				projectId: HEADQUARTERS_PROJECT_ID,
				createdAt: 1,
				lastActivity: 1,
				worktreePath,
				repoPath: root,
				repoWorktrees: { ".": worktreePath },
				branch: "goal/legacy",
				worktreePushPolicy: "publish",
				remotePublicationPolicy: "publish",
				drafts: { keep: true },
			}],
		});

		const diagnostics = migrateLegacyHeadquartersDirectory(dirs);

		const sessionsFile = path.join(dirs.headquartersStateDir, "sessions.json");
		const envelope = readJson<{ version: number; epoch: number; sessions: Array<Record<string, unknown>> }>(sessionsFile);
		// Envelope shape must survive sanitization (never a bare array).
		assert.equal(Array.isArray(envelope), false, "sessions.json must remain a v2 envelope, not a bare array");
		assert.equal(envelope.version, 2, "version must be preserved");
		assert.equal(envelope.epoch, epoch, "epoch must be preserved");
		assert.equal(Array.isArray(envelope.sessions), true, "sessions must be an array under the envelope");
		assert.equal(envelope.sessions.length, 1);

		const session = envelope.sessions[0];
		assert.equal(session.id, "hq-envelope-1");
		assert.equal(session.projectId, HEADQUARTERS_PROJECT_ID);
		assert.equal(path.resolve(String(session.cwd)), path.resolve(dirs.headquartersDir), "cwd should be normalized to the Headquarters directory");
		for (const field of ["worktreePath", "repoPath", "repoWorktrees", "branch", "worktreePushPolicy", "remotePublicationPolicy"]) {
			assert.equal(Object.hasOwn(session, field), false, `${field} should be removed from the Headquarters session`);
		}
		assert.deepEqual(session.drafts, { keep: true }, "non-git session fields must be preserved");
		assert.ok(diagnostics.sanitizedHeadquartersRecords.some(entry => entry.file === "sessions.json" && entry.key === "hq-envelope-1"));

		// Re-running migration is idempotent: file bytes are unchanged and nothing new is sanitized.
		const firstBytes = fs.readFileSync(sessionsFile, "utf-8");
		const second = migrateLegacyHeadquartersDirectory(dirs);
		assert.equal(fs.readFileSync(sessionsFile, "utf-8"), firstBytes, "sessions.json must be byte-identical after re-running migration");
		assert.equal(second.sanitizedHeadquartersRecords.length, 0);
		const reread = readJson<{ version: number; epoch: number; sessions: unknown[] }>(sessionsFile);
		assert.equal(reread.version, 2);
		assert.equal(reread.epoch, epoch);
		assert.equal(reread.sessions.length, 1);
	});

	it("does not promote same-root normal projects and quarantines ambiguous config", () => {
		const root = tmpRoot();
		const oldId = "server-root-project";
		const legacyStateDir = path.join(root, ".bobbit", "state");
		const legacyConfigDir = path.join(root, ".bobbit", "config");
		fs.mkdirSync(legacyConfigDir, { recursive: true });
		seedProject(legacyStateDir, normalProject(oldId, root));
		writeJson(path.join(legacyStateDir, "sessions.json"), [{ id: "s1", title: "S", cwd: root, agentSessionFile: "a.jsonl", createdAt: 1, lastActivity: 1 }]);
		fs.writeFileSync(path.join(legacyConfigDir, "project.yaml"), "name: Normal Config\n", "utf-8");

		const dirs = migrateDirs(root);
		const diagnostics = migrateLegacyHeadquartersDirectory(dirs);

		const projects = readJson<Array<Record<string, unknown>>>(path.join(dirs.headquartersStateDir, "projects.json"));
		assert.ok(projects.some(project => project.id === oldId), "same-root normal project must remain visible as itself");
		assert.equal(projects.some(project => project.id === HEADQUARTERS_PROJECT_ID && project.id !== oldId), false, "migration does not manufacture HQ before ensureHeadquartersProject");
		assert.equal(fs.existsSync(path.join(dirs.headquartersStateDir, "sessions.json")), false, "missing projectId records are ambiguous and not imported into Headquarters when same-root evidence exists");
		assert.equal(fs.existsSync(path.join(dirs.headquartersConfigDir, "project.yaml")), false, "same-root normal config must not become HQ config");
		assert.equal(
			fs.readFileSync(path.join(dirs.headquartersStateDir, "migration-quarantine", "config", "legacy-server-bobbit-config", "project.yaml"), "utf-8"),
			"name: Normal Config\n",
		);
		assert.equal(diagnostics.ambiguousRecords[0].file, "sessions.json");
		assert.deepEqual(diagnostics.restoredNormalProjectIds, []);
	});

	it("repairs installs that were promoted by restoring reliable backups to the normal project", () => {
		const root = tmpRoot();
		const oldId = "original-project";
		const legacyStateDir = path.join(root, ".bobbit", "state");
		fs.mkdirSync(legacyStateDir, { recursive: true });
		writeJson(path.join(legacyStateDir, "projects.json"), [hqProject(root)]);
		writeJson(path.join(legacyStateDir, "projects.json.pre-headquarters-id-migration"), [normalProject(oldId, root, { name: "Original", palette: "blue" })]);
		writeJson(path.join(legacyStateDir, "sessions.json"), [{ id: "s1", title: "Promoted", cwd: root, agentSessionFile: "a.jsonl", projectId: HEADQUARTERS_PROJECT_ID, createdAt: 1, lastActivity: 1 }]);
		writeJson(path.join(legacyStateDir, "sessions.json.pre-headquarters-id-migration"), [{ id: "s1", title: "Original", cwd: root, agentSessionFile: "a.jsonl", projectId: oldId, createdAt: 1, lastActivity: 1 }]);

		const dirs = migrateDirs(root);
		const diagnostics = migrateLegacyHeadquartersDirectory(dirs);

		const projects = readJson<Array<Record<string, unknown>>>(path.join(dirs.headquartersStateDir, "projects.json"));
		const hq = projects.find(project => project.id === HEADQUARTERS_PROJECT_ID)!;
		const normal = projects.find(project => project.id === oldId)!;
		assert.equal(path.resolve(String(hq.rootPath)), path.resolve(dirs.headquartersDir));
		assert.equal(normal.name, "Original");
		assert.equal(normal.palette, "blue");
		assert.deepEqual(diagnostics.restoredNormalProjectIds, [oldId]);

		const normalSessions = readJson<Array<Record<string, unknown>>>(path.join(root, ".bobbit", "state", "sessions.json"));
		assert.equal(normalSessions[0].projectId, oldId, "normal project state should be repaired from the reliable backup");
		assert.equal(fs.existsSync(path.join(dirs.headquartersStateDir, "sessions.json")), false, "promoted normal record must not be surfaced under HQ");
	});

	it("uses BOBBIT_DIR-style Headquarters overrides in place instead of nesting or copying default .bobbit", () => {
		const root = tmpRoot();
		const override = tmpRoot("bobbit-hq-override-");
		const overrideState = path.join(override, "state");
		const overrideConfig = path.join(override, "config");
		fs.mkdirSync(overrideConfig, { recursive: true });
		seedProject(overrideState, hqProject(override));
		fs.writeFileSync(path.join(overrideConfig, "project.yaml"), "name: Override HQ\n", "utf-8");
		writeJson(path.join(root, ".bobbit", "state", "projects.json"), [normalProject("normal-default-root", root)]);
		fs.mkdirSync(path.join(root, ".bobbit", "config"), { recursive: true });
		fs.writeFileSync(path.join(root, ".bobbit", "config", "project.yaml"), "name: Normal Same Root\n", "utf-8");

		const diagnostics = migrateLegacyHeadquartersDirectory({
			serverRunDir: root,
			headquartersDir: override,
			headquartersStateDir: overrideState,
			headquartersConfigDir: overrideConfig,
			legacyServerBobbitDir: path.join(root, ".bobbit"),
		});

		assert.equal(fs.readFileSync(path.join(overrideConfig, "project.yaml"), "utf-8"), "name: Override HQ\n");
		assert.equal(fs.existsSync(path.join(override, "headquarters", "state")), false);
		assert.equal(readJson<Array<Record<string, unknown>>>(path.join(overrideState, "projects.json")).some(project => project.id === "normal-default-root"), false, "BOBBIT_DIR must not import default .bobbit project registry");
		assert.ok(diagnostics.skipped.some(entry => entry.includes("override config is used in place")));
	});
});

describe("Headquarters per-project migration repair", () => {
	it("does not promote a same-root normal project during legacy per-project migration", () => {
		const root = tmpRoot();
		const stateDir = path.join(root, ".bobbit", "headquarters", "state");
		const hqDir = path.dirname(stateDir);
		fs.mkdirSync(stateDir, { recursive: true });
		const oldId = "server-root-project";
		seedProject(stateDir, hqProject(hqDir), [normalProject(oldId, root)]);
		writeJson(path.join(stateDir, "goals.json"), [{ id: "g1", title: "G", cwd: root, state: "todo", spec: "", projectId: oldId, createdAt: 1, updatedAt: 1 }]);

		migrateToPerProjectState(stateDir, new ProjectRegistry(stateDir), root, { centralConfigDir: path.join(hqDir, "config") });

		const projects = readJson<Array<Record<string, unknown>>>(path.join(stateDir, "projects.json"));
		assert.ok(projects.some(project => project.id === oldId));
		assert.ok(projects.some(project => project.id === HEADQUARTERS_PROJECT_ID));
		assert.equal(readJson(path.join(root, ".bobbit", "state", "goals.json"))[0].projectId, oldId);
	});
});
