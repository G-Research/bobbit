import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { migrateLegacyHeadquartersDirectory, migrateToPerProjectState } = await import("../src/server/agent/state-migration.ts");
const { serverSecretsDir } = await import("../src/server/bobbit-dir.ts");
const {
	HEADQUARTERS_PROJECT_ID,
	HEADQUARTERS_PROJECT_NAME,
	ProjectRegistry,
} = await import("../src/server/agent/project-registry.ts");

/**
 * Live server secrets (token/TLS/sandbox-agent auth) resolve to serverSecretsDir(),
 * which defaults to an OS user-level directory. Pin BOBBIT_SECRETS_DIR to a fresh
 * temp dir so these tests NEVER write real admin secrets into the developer's home
 * dir. Returns the isolated secrets dir. Callers set it before invoking migration.
 */
function useIsolatedSecretsDir(): string {
	const dir = tmpRoot("bobbit-hq-secrets-");
	process.env.BOBBIT_SECRETS_DIR = dir;
	return dir;
}

// Safety net: guarantee BOBBIT_SECRETS_DIR is always an isolated temp dir for the
// whole file, so even standalone `tsx --test` runs never write real admin secrets
// into the developer's home dir. Individual tests override this per-case.
if (!process.env.BOBBIT_SECRETS_DIR) {
	process.env.BOBBIT_SECRETS_DIR = tmpRoot("bobbit-hq-secrets-file-");
}

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

	// Security regression (S1): live server secrets must live OUTSIDE any project
	// root, under serverSecretsDir(). In the default same-root case the legacy
	// `<serverRunDir>/.bobbit/state/token` AND the Headquarters
	// `<serverRunDir>/.bobbit/headquarters/state/token` are both descendants of a
	// normal same-root project's default cwd (`<serverRunDir>`). The migration must
	// relocate every SERVER_SECRET_ENTRY into serverSecretsDir() and leave NONE
	// behind at any project-reachable path.
	it("relocates server secrets into serverSecretsDir and leaves none at project-reachable paths (default same-root)", () => {
		const root = tmpRoot();
		const secretsDir = useIsolatedSecretsDir();
		const legacyStateDir = path.join(root, ".bobbit", "state");
		fs.mkdirSync(legacyStateDir, { recursive: true });
		// A normal project registered at the server run dir → same-root split.
		seedProject(legacyStateDir, normalProject("same-root", root));
		const adminToken = "admin-bearer-secret-value";
		fs.writeFileSync(path.join(legacyStateDir, "token"), adminToken, "utf-8");
		fs.writeFileSync(path.join(legacyStateDir, "sandbox-agent-auth"), "sandbox-secret", "utf-8");
		fs.mkdirSync(path.join(legacyStateDir, "tls"), { recursive: true });
		fs.writeFileSync(path.join(legacyStateDir, "tls", "cert.pem"), "cert-material", "utf-8");

		const dirs = migrateDirs(root);
		const diagnostics = migrateLegacyHeadquartersDirectory(dirs);

		const legacyToken = path.join(legacyStateDir, "token");
		const hqToken = path.join(dirs.headquartersStateDir, "token");
		const secretsToken = path.join(secretsDir, "token");
		// No live secret may remain at either project-reachable state dir.
		assert.equal(fs.existsSync(legacyToken), false, "legacy admin token must be removed from the normal-project state path");
		assert.equal(fs.existsSync(hqToken), false, "admin token must not remain under the Headquarters state dir");
		assert.equal(fs.existsSync(path.join(legacyStateDir, "sandbox-agent-auth")), false);
		assert.equal(fs.existsSync(path.join(legacyStateDir, "tls")), false);
		// The single authoritative copy lives in serverSecretsDir(), value preserved.
		assert.equal(fs.readFileSync(secretsToken, "utf-8"), adminToken, "serverSecretsDir must hold the authoritative admin token");
		assert.equal(fs.readFileSync(path.join(secretsDir, "sandbox-agent-auth"), "utf-8"), "sandbox-secret");
		assert.equal(fs.readFileSync(path.join(secretsDir, "tls", "cert.pem"), "utf-8"), "cert-material");
		// A NON-secret marker is left behind; diagnostics record the move without secrets.
		assert.equal(fs.existsSync(path.join(legacyStateDir, ".token-moved-to-server-secrets")), true);
		assert.ok(diagnostics.copied.some(entry => entry.includes("relocated live server secret") && entry.includes("token")));
		assert.ok(diagnostics.copied.every(entry => !entry.includes(adminToken)), "diagnostics must not contain secret contents");

		// Idempotent: re-running does not resurrect a project-reachable copy or change the value.
		const second = migrateLegacyHeadquartersDirectory(dirs);
		assert.equal(fs.existsSync(legacyToken), false, "re-running migration must not resurrect the legacy token");
		assert.equal(fs.existsSync(hqToken), false);
		assert.equal(fs.readFileSync(secretsToken, "utf-8"), adminToken);
		assert.equal(second.failures.length, 0);
	});

	// S1 (BOBBIT_DIR override): the override state dir is ALSO a descendant of a
	// same-root normal project's cwd, so override secrets must be relocated too.
	// Preserve-first: an existing serverSecretsDir token VALUE wins over both the
	// override and legacy copies (token continuity across boots).
	it("relocates BOBBIT_DIR-override server secrets into serverSecretsDir (preserve-first)", () => {
		const root = tmpRoot();
		const override = tmpRoot("bobbit-hq-override-");
		const secretsDir = useIsolatedSecretsDir();
		// A pre-existing authoritative token already lives in serverSecretsDir().
		const existingToken = "already-present-authoritative-token-value-1234567890";
		fs.writeFileSync(path.join(secretsDir, "token"), existingToken, "utf-8");
		const overrideState = path.join(override, "state");
		fs.mkdirSync(overrideState, { recursive: true });
		fs.writeFileSync(path.join(overrideState, "token"), "override-admin-token", "utf-8");
		// A legacy default .bobbit/state token also exists.
		const legacyStateDir = path.join(root, ".bobbit", "state");
		fs.mkdirSync(legacyStateDir, { recursive: true });
		fs.writeFileSync(path.join(legacyStateDir, "token"), "legacy-default-token", "utf-8");

		migrateLegacyHeadquartersDirectory({
			serverRunDir: root,
			headquartersDir: override,
			headquartersStateDir: overrideState,
			headquartersConfigDir: path.join(override, "config"),
			legacyServerBobbitDir: path.join(root, ".bobbit"),
		});

		// The pre-existing serverSecretsDir value is preserved (never overwritten).
		assert.equal(fs.readFileSync(path.join(secretsDir, "token"), "utf-8"), existingToken, "existing serverSecretsDir token value must be preserved");
		// The override copy is removed (project-reachable duplicate stripped).
		assert.equal(fs.existsSync(path.join(overrideState, "token")), false, "override HQ token must be relocated out of the override state dir");
		// Override-mode intentionally leaves the legacy default `.bobbit/state` in
		// place (it is not the HQ source), but never quarantines under HQ.
		assert.equal(fs.existsSync(path.join(overrideState, "migration-quarantine", "secrets", "token")), false);
	});

	it("moves an existing Headquarters-state token into serverSecretsDir when no legacy copy exists", () => {
		const root = tmpRoot();
		const secretsDir = useIsolatedSecretsDir();
		const dirs = migrateDirs(root);
		// Simulate a prior migration that left the token under HQ state (old layout).
		fs.mkdirSync(dirs.headquartersStateDir, { recursive: true });
		const adminToken = "hq-state-legacy-admin-token-value-abcdefghij-0123456789";
		fs.writeFileSync(path.join(dirs.headquartersStateDir, "token"), adminToken, "utf-8");

		migrateLegacyHeadquartersDirectory(dirs);

		assert.equal(fs.existsSync(path.join(dirs.headquartersStateDir, "token")), false, "token must be relocated out of the HQ state dir");
		assert.equal(fs.readFileSync(path.join(secretsDir, "token"), "utf-8"), adminToken, "relocated token value must be preserved");
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

	// B1: BOBBIT_DIR-override installs promoted per-store records under `headquarters`
	// during the old PR #925 migration and left their `.pre-headquarters-id-migration`
	// per-store backups in the OVERRIDE state dir. Restoring only the registry record
	// (as before) leaves those sessions/goals/staff attributed to headquarters. The
	// per-store repair must run for override installs too, reading the per-store files
	// and backups from the override state dir, and re-attribute the normal records to
	// the restored normal project while removing them from the HQ store.
	it("re-attributes promoted per-store records to the restored normal project (BOBBIT_DIR override, B1)", () => {
		const root = tmpRoot();
		const override = tmpRoot("bobbit-hq-override-");
		useIsolatedSecretsDir();
		const overrideState = path.join(override, "state");
		fs.mkdirSync(overrideState, { recursive: true });
		const oldId = "override-normal-project";
		// Post-promotion override registry: only headquarters remains; the normal
		// project's original record survives in the per-store id-migration backup.
		writeJson(path.join(overrideState, "projects.json"), [hqProject(override)]);
		writeJson(path.join(overrideState, "projects.json.pre-headquarters-id-migration"), [normalProject(oldId, root, { name: "Override Normal" })]);
		// Promoted sessions/goals were re-tagged to headquarters; the backups keep
		// the original normal-project attribution.
		writeJson(path.join(overrideState, "sessions.json"), [
			{ id: "s1", title: "Promoted", cwd: root, agentSessionFile: "a.jsonl", projectId: HEADQUARTERS_PROJECT_ID, createdAt: 1, lastActivity: 1 },
		]);
		writeJson(path.join(overrideState, "sessions.json.pre-headquarters-id-migration"), [
			{ id: "s1", title: "Original", cwd: root, agentSessionFile: "a.jsonl", projectId: oldId, createdAt: 1, lastActivity: 1 },
		]);
		writeJson(path.join(overrideState, "goals.json"), [
			{ id: "g1", title: "G", cwd: root, state: "todo", spec: "", projectId: HEADQUARTERS_PROJECT_ID, createdAt: 1, updatedAt: 1 },
		]);
		writeJson(path.join(overrideState, "goals.json.pre-headquarters-id-migration"), [
			{ id: "g1", title: "G", cwd: root, state: "todo", spec: "", projectId: oldId, createdAt: 1, updatedAt: 1 },
		]);

		const diagnostics = migrateLegacyHeadquartersDirectory({
			serverRunDir: root,
			headquartersDir: override,
			headquartersStateDir: overrideState,
			headquartersConfigDir: path.join(override, "config"),
			legacyServerBobbitDir: path.join(root, ".bobbit"),
		});

		// Registry record restored.
		const projects = readJson<Array<Record<string, unknown>>>(path.join(overrideState, "projects.json"));
		assert.ok(projects.some(project => project.id === oldId), "normal project registry record must be restored");
		assert.deepEqual(diagnostics.restoredNormalProjectIds, [oldId]);

		// Per-store records re-attributed to the normal project's own state dir.
		const normalSessions = readJson<{ sessions?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(path.join(root, ".bobbit", "state", "sessions.json"));
		const normalSessionRecords = Array.isArray(normalSessions) ? normalSessions : (normalSessions.sessions ?? []);
		assert.equal(normalSessionRecords[0].projectId, oldId, "promoted session must be re-attributed to the normal project");
		assert.equal(readJson<Array<Record<string, unknown>>>(path.join(root, ".bobbit", "state", "goals.json"))[0].projectId, oldId);

		// And removed from the Headquarters (override) store — no lingering duplicate.
		const hqSessions = readJson<{ sessions?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(path.join(overrideState, "sessions.json"));
		const hqSessionRecords = Array.isArray(hqSessions) ? hqSessions : (hqSessions.sessions ?? []);
		assert.equal(hqSessionRecords.some(record => record.id === "s1"), false, "re-attributed session must not remain under headquarters");
		assert.equal(readJson<Array<Record<string, unknown>>>(path.join(overrideState, "goals.json")).some(record => record.id === "g1"), false, "re-attributed goal must not remain under headquarters");

		// Idempotent: re-running does not duplicate or resurrect records.
		migrateLegacyHeadquartersDirectory({
			serverRunDir: root,
			headquartersDir: override,
			headquartersStateDir: overrideState,
			headquartersConfigDir: path.join(override, "config"),
			legacyServerBobbitDir: path.join(root, ".bobbit"),
		});
		const normalGoalsAfter = readJson<Array<Record<string, unknown>>>(path.join(root, ".bobbit", "state", "goals.json"));
		assert.equal(normalGoalsAfter.filter(record => record.id === "g1").length, 1, "re-running must not duplicate the re-attributed record");
	});

	// Finding C: the in-place / backup-driven re-attribution must PREFER the current
	// (post-promotion) record and use the stale `.pre-headquarters-id-migration`
	// backup only to recover the normal projectId (and fields the promotion stripped).
	// Overwriting the live record with the backup would silently revert progress made
	// after the promotion (updated state, new fields, newer titles).
	it("prefers the current post-promotion record over the stale id-migration backup (finding C)", () => {
		const root = tmpRoot();
		useIsolatedSecretsDir();
		const oldId = "original-project";
		const legacyStateDir = path.join(root, ".bobbit", "state");
		fs.mkdirSync(legacyStateDir, { recursive: true });
		writeJson(path.join(legacyStateDir, "projects.json"), [hqProject(root)]);
		writeJson(path.join(legacyStateDir, "projects.json.pre-headquarters-id-migration"), [normalProject(oldId, root, { name: "Original" })]);
		// CURRENT (post-promotion) goal has progressed AFTER promotion: newer state,
		// updated title/spec, and a field that did not exist in the backup snapshot.
		writeJson(path.join(legacyStateDir, "goals.json"), [
			{ id: "g1", title: "Updated after promotion", cwd: root, state: "complete", spec: "new spec", projectId: HEADQUARTERS_PROJECT_ID, createdAt: 1, updatedAt: 99, addedAfterPromotion: true },
		]);
		writeJson(path.join(legacyStateDir, "goals.json.pre-headquarters-id-migration"), [
			{ id: "g1", title: "Before promotion", cwd: root, state: "todo", spec: "old spec", projectId: oldId, createdAt: 1, updatedAt: 1 },
		]);

		const dirs = migrateDirs(root);
		migrateLegacyHeadquartersDirectory(dirs);

		const normalGoals = readJson<Array<Record<string, unknown>>>(path.join(root, ".bobbit", "state", "goals.json"));
		const g = normalGoals.find(record => record.id === "g1")!;
		assert.equal(g.projectId, oldId, "record must be re-attributed to the normal project");
		assert.equal(g.title, "Updated after promotion", "current post-promotion title must win over the stale backup");
		assert.equal(g.state, "complete", "current post-promotion state must not be reverted to the backup snapshot");
		assert.equal(g.spec, "new spec");
		assert.equal(g.updatedAt, 99);
		assert.equal(g.addedAfterPromotion, true, "fields present only in the current record must be preserved");
	});

	// Finding B: relocating a live server secret is FATAL if it cannot be provably
	// removed from a project-reachable path. If the copy into serverSecretsDir()
	// succeeds but the reachable source cannot be deleted, leaving it behind would
	// keep the admin bearer token readable under a same-root project's cwd (S1).
	// Simulate a delete failure and assert the migration throws and audits it.
	it("aborts fatally when a live server secret cannot be removed from a project-reachable path (finding B)", () => {
		const root = tmpRoot();
		useIsolatedSecretsDir();
		const dirs = migrateDirs(root);
		fs.mkdirSync(dirs.headquartersStateDir, { recursive: true });
		fs.writeFileSync(path.join(dirs.headquartersStateDir, "token"), "leaked-admin-token", "utf-8");

		const realRmSync = fs.rmSync;
		(fs as unknown as { rmSync: unknown }).rmSync = () => { throw new Error("simulated: source could not be removed"); };
		try {
			assert.throws(
				() => migrateLegacyHeadquartersDirectory(dirs),
				/could not provably relocate live server secret "token"/,
				"migration must abort when a live secret cannot be removed from a project-reachable path",
			);
		} finally {
			(fs as unknown as { rmSync: unknown }).rmSync = realRmSync;
		}

		// Diagnostics are persisted before the throw, without ever leaking the secret value.
		const diag = readJson<{ failures: string[] }>(path.join(dirs.headquartersStateDir, "headquarters-migration-diagnostics.json"));
		assert.ok(
			diag.failures.some(entry => entry.includes("could not provably relocate live server secret")),
			"the fatal relocation failure must be recorded in diagnostics for auditability",
		);
		assert.ok(diag.failures.every(entry => !entry.includes("leaked-admin-token")), "diagnostics must not contain the secret value");
	});
});

describe("serverSecretsDir resolution", () => {
	const prev = process.env.BOBBIT_SECRETS_DIR;
	it("honours the BOBBIT_SECRETS_DIR override verbatim (resolved absolute)", () => {
		const dir = tmpRoot("bobbit-secrets-override-");
		process.env.BOBBIT_SECRETS_DIR = dir;
		try {
			assert.equal(serverSecretsDir(), path.resolve(dir));
			assert.equal(fs.existsSync(serverSecretsDir()), true, "serverSecretsDir must create the directory");
		} finally {
			process.env.BOBBIT_SECRETS_DIR = prev;
		}
	});

	it("namespaces per Headquarters directory via a stable hash when no override is set", () => {
		// Redirect EVERY OS user-dir base to a temp root so the default (no-override)
		// resolution never writes into the developer's real home dir.
		const fakeHome = tmpRoot("bobbit-fake-home-");
		const saved: Record<string, string | undefined> = {
			BOBBIT_SECRETS_DIR: process.env.BOBBIT_SECRETS_DIR,
			BOBBIT_DIR: process.env.BOBBIT_DIR,
			HOME: process.env.HOME,
			USERPROFILE: process.env.USERPROFILE,
			APPDATA: process.env.APPDATA,
			XDG_STATE_HOME: process.env.XDG_STATE_HOME,
		};
		delete process.env.BOBBIT_SECRETS_DIR;
		process.env.HOME = fakeHome;
		process.env.USERPROFILE = fakeHome;
		process.env.APPDATA = path.join(fakeHome, "AppData", "Roaming");
		process.env.XDG_STATE_HOME = path.join(fakeHome, ".local", "state");
		try {
			const hqA = tmpRoot("bobbit-hqdir-a-");
			process.env.BOBBIT_DIR = hqA;
			const a1 = serverSecretsDir();
			const a2 = serverSecretsDir();
			assert.equal(a1, a2, "resolution must be stable for a fixed Headquarters dir");
			const hqB = tmpRoot("bobbit-hqdir-b-");
			process.env.BOBBIT_DIR = hqB;
			const b1 = serverSecretsDir();
			assert.notEqual(a1, b1, "different Headquarters dirs must map to different secrets namespaces");
			// Lives under the (faked) OS user-level base, never under either Headquarters dir.
			assert.equal(a1.startsWith(path.resolve(hqA)), false, "secrets must not live under the Headquarters/project root");
			assert.equal(a1.startsWith(path.resolve(fakeHome)), true, "secrets must live under the OS user-level base");
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key]; else process.env[key] = value;
			}
		}
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

	// Regression: sessions.json is a v2 envelope `{ version, epoch, sessions: [...] }`,
	// not a bare array. Reading it with readJsonArray returned [] → the central bucket
	// looked empty → clearCentralBucketIfDefaultMissing overwrote it with `[]`, silently
	// losing every session. Distribution must be envelope-aware: the central HQ bucket
	// keeps its envelope, and per-project sessions are written as v2 envelopes too.
	it("preserves and distributes a v2-envelope sessions.json through per-project migration", () => {
		const root = tmpRoot();
		const stateDir = path.join(root, ".bobbit", "headquarters", "state");
		const hqDir = path.dirname(stateDir);
		fs.mkdirSync(stateDir, { recursive: true });
		const oldId = "normal-proj";
		seedProject(stateDir, hqProject(hqDir), [normalProject(oldId, root)]);
		// Central sessions.json is a versioned envelope, not a bare array.
		writeJson(path.join(stateDir, "sessions.json"), {
			version: 2,
			epoch: 5,
			sessions: [
				{ id: "hq-s1", title: "HQ", cwd: hqDir, agentSessionFile: "a.jsonl", projectId: HEADQUARTERS_PROJECT_ID, createdAt: 1, lastActivity: 1 },
				{ id: "np-s1", title: "Normal", cwd: root, agentSessionFile: "b.jsonl", projectId: oldId, createdAt: 1, lastActivity: 1 },
			],
		});

		migrateToPerProjectState(stateDir, new ProjectRegistry(stateDir), root, { centralConfigDir: path.join(hqDir, "config") });

		// The central HQ sessions.json keeps its envelope and its HQ session (never reduced to []).
		const hqEnvelope = readJson<{ version: number; epoch: number; sessions: Array<Record<string, unknown>> }>(path.join(stateDir, "sessions.json"));
		assert.equal(Array.isArray(hqEnvelope), false, "central sessions.json must remain a v2 envelope, not be reduced to []");
		assert.equal(hqEnvelope.version, 2);
		assert.equal(hqEnvelope.epoch, 5);
		assert.equal(hqEnvelope.sessions.length, 1, "the HQ session must be preserved, not lost");
		assert.equal(hqEnvelope.sessions[0].id, "hq-s1");
		assert.equal(hqEnvelope.sessions[0].projectId, HEADQUARTERS_PROJECT_ID);

		// The normal project's session is distributed as a v2 envelope to its own state dir.
		const normalEnvelope = readJson<{ version: number; epoch: number; sessions: Array<Record<string, unknown>> }>(path.join(root, ".bobbit", "state", "sessions.json"));
		assert.equal(Array.isArray(normalEnvelope), false, "per-project sessions.json must be written as a v2 envelope");
		assert.equal(normalEnvelope.version, 2);
		assert.equal(normalEnvelope.epoch, 5);
		assert.equal(normalEnvelope.sessions.length, 1);
		assert.equal(normalEnvelope.sessions[0].id, "np-s1");
		assert.equal(normalEnvelope.sessions[0].projectId, oldId);
	});
});
