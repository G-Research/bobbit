import fs from "node:fs";
import path from "node:path";
import { serverSecretsDir } from "../bobbit-dir.js";
import {
	HEADQUARTERS_PROJECT_ID,
	HEADQUARTERS_PROJECT_NAME,
	SYSTEM_PROJECT_ID,
	type ProjectRegistry,
	type RegisteredProject,
} from "./project-registry.js";
import type { PersistedGoal } from "./goal-store.js";
import type { PersistedStaff } from "./staff-store.js";
import type { PersistedTask } from "./task-store.js";
import type { PersistedTeamEntry } from "./team-store.js";
import type { GateState } from "./gate-store.js";

const MIGRATION_MARKER = ".migrated-to-per-project";
const PRE_MIGRATION_SUFFIX = ".pre-migration";
const RECOVERY_MARKER = ".pre-migration-recovered";
const HEADQUARTERS_ID_MIGRATION_MARKER = ".headquarters-project-id-migrated";
const HEADQUARTERS_DIR_MIGRATION_MARKER = ".headquarters-dir-migrated";
const HEADQUARTERS_MIGRATION_DIAGNOSTICS = "headquarters-migration-diagnostics.json";
const PER_PROJECT_MIGRATION_DIAGNOSTICS = "per-project-state-migration-diagnostics.json";
const HEADQUARTERS_BACKUP_SUFFIX = ".pre-headquarters-id-migration";

/** Normalize paths for equality checks, including Windows drive-letter casing. */
function pathKey(p: string): string {
	const resolved = path.resolve(p);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(a: string, b: string): boolean {
	return pathKey(a) === pathKey(b);
}

function canonicalPathKey(p: string): string {
	try {
		return pathKey(fs.realpathSync(p));
	} catch {
		return pathKey(p);
	}
}

function readJsonValue<T = unknown>(filePath: string): T | undefined {
	try {
		if (!fs.existsSync(filePath)) return undefined;
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
	} catch {
		console.log(`[migration] Warning: could not parse ${filePath}, skipping`);
		return undefined;
	}
}

function stableStringify(value: unknown): string {
	return JSON.stringify(value, Object.keys(flattenObjectKeys(value)).sort(), 2);
}

function flattenObjectKeys(value: unknown, keys: Record<string, true> = {}): Record<string, true> {
	if (Array.isArray(value)) {
		for (const item of value) flattenObjectKeys(item, keys);
	} else if (value && typeof value === "object") {
		for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
			keys[key] = true;
			flattenObjectKeys(nested, keys);
		}
	}
	return keys;
}

// Helper: read a JSON array file, return empty array if missing/corrupt.
function readJsonArray<T>(filePath: string): T[] {
	try {
		if (!fs.existsSync(filePath)) return [];
		const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		return Array.isArray(data) ? data : [];
	} catch {
		console.log(`[migration] Warning: could not parse ${filePath}, skipping`);
		return [];
	}
}

function writeJsonArray<T>(filePath: string, items: T[], opts: { backup?: boolean } = {}): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	if (opts.backup) backupForHeadquartersMigration(filePath);
	fs.writeFileSync(filePath, JSON.stringify(items, null, 2), "utf-8");
}

function backupForHeadquartersMigration(filePath: string): void {
	try {
		if (!fs.existsSync(filePath)) return;
		const backupPath = filePath + HEADQUARTERS_BACKUP_SUFFIX;
		if (!fs.existsSync(backupPath)) {
			fs.copyFileSync(filePath, backupPath);
			console.log(`[migration] Backed up ${path.basename(filePath)} → ${path.basename(backupPath)}`);
		}
	} catch (err) {
		console.log(`[migration] Warning: could not back up ${filePath}: ${err}`);
	}
}

function registryProjectMap(projectRegistry: ProjectRegistry): Map<string, RegisteredProject> | null {
	const candidate = projectRegistry as unknown as { projects?: unknown };
	return candidate.projects instanceof Map
		? candidate.projects as Map<string, RegisteredProject>
		: null;
}

function registrySave(projectRegistry: ProjectRegistry): void {
	(projectRegistry as unknown as { save(): void }).save();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

interface HeadquartersDirectoryMigrationInput {
	serverRunDir: string;
	headquartersDir: string;
	headquartersStateDir: string;
	headquartersConfigDir: string;
	legacyServerBobbitDir: string;
}

interface PerProjectMigrationDiagnostics {
	version: 1;
	runAt: string;
	paths: {
		centralStateDir: string;
		serverCwd: string;
	};
	sameRootNormalProjectIds: string[];
	ambiguousRecords: Array<{ file: string; key: string; reason: string }>;
}

interface HeadquartersMigrationDiagnostics {
	version: 1;
	runAt: string;
	paths: {
		serverRunDir: string;
		headquartersDir: string;
		headquartersStateDir: string;
		headquartersConfigDir: string;
		legacyServerBobbitDir: string;
		legacyStateDir: string;
		legacyConfigDir: string;
	};
	copied: string[];
	skipped: string[];
	quarantinedConfigFiles: string[];
	ambiguousRecords: Array<{ file: string; key: string; reason: string }>;
	restoredNormalProjectIds: string[];
	restoredNormalRecords: Array<{ file: string; key: string; projectId: string }>;
	sanitizedHeadquartersRecords: Array<{ file: string; key: string; actions: string[] }>;
	previousOverrideHints: string[];
	failures: string[];
}

const SERVER_STATE_ENTRIES = new Set([
	"projects.json",
	"preferences.json",
	"setup-complete",
	"token",
	"gateway-url",
	"watchdog.json",
	"actual-port",
	"boot-timing.jsonl",
	"session-prompts",
	"proposal-drafts",
	"preview",
	"preview-artifacts",
	"html-snapshots",
	"mcp-extensions",
	"tool-guard",
	"tool-result-error-bridge",
	"provider-bridge",
	"google-code-assist",
	"ext-store",
	"marketplace-cache",
	"pr-walkthrough",
	"tls",
	"sandbox-agent-auth",
]);

// Server-scope secrets that must never remain readable at the normal-project-owned
// `<serverRunDir>/.bobbit/state` path after the Headquarters split. A same-root
// normal project defaults cwd to `<serverRunDir>` and reads
// `<serverRunDir>/.bobbit/{state,config}`, so leaving a live admin bearer `token`
// (or TLS material / sandbox auth) there is a gateway-wide privilege escalation.
const SERVER_SECRET_ENTRIES = ["token", "tls", "sandbox-agent-auth"] as const;

const PROJECT_STORE_FILES = new Set([
	"goals.json",
	"sessions.json",
	"staff.json",
	"tasks.json",
	"team-state.json",
	"gateway-swarms.json",
	"gates.json",
	"inbox.json",
	"session-costs.json",
	"session-colors.json",
	"bg-processes.json",
]);
const PROJECT_OBJECT_STORE_FILES = new Set(["session-costs.json", "session-colors.json", "bg-processes.json"]);

function newHeadquartersDiagnostics(input: HeadquartersDirectoryMigrationInput): HeadquartersMigrationDiagnostics {
	const legacyStateDir = path.join(input.legacyServerBobbitDir, "state");
	const legacyConfigDir = path.join(input.legacyServerBobbitDir, "config");
	return {
		version: 1,
		runAt: new Date().toISOString(),
		paths: {
			serverRunDir: path.resolve(input.serverRunDir),
			headquartersDir: path.resolve(input.headquartersDir),
			headquartersStateDir: path.resolve(input.headquartersStateDir),
			headquartersConfigDir: path.resolve(input.headquartersConfigDir),
			legacyServerBobbitDir: path.resolve(input.legacyServerBobbitDir),
			legacyStateDir: path.resolve(legacyStateDir),
			legacyConfigDir: path.resolve(legacyConfigDir),
		},
		copied: [],
		skipped: [],
		quarantinedConfigFiles: [],
		ambiguousRecords: [],
		restoredNormalProjectIds: [],
		restoredNormalRecords: [],
		sanitizedHeadquartersRecords: [],
		previousOverrideHints: [],
		failures: [],
	};
}

function writeHeadquartersDiagnostics(stateDir: string, diagnostics: HeadquartersMigrationDiagnostics): void {
	try {
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(path.join(stateDir, HEADQUARTERS_MIGRATION_DIAGNOSTICS), stableStringify(diagnostics), "utf-8");
	} catch (err) {
		console.log(`[migration] Warning: could not write Headquarters migration diagnostics: ${err}`);
	}
}

function writePerProjectDiagnostics(stateDir: string, diagnostics: PerProjectMigrationDiagnostics): void {
	if (diagnostics.ambiguousRecords.length === 0) return;
	try {
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(path.join(stateDir, PER_PROJECT_MIGRATION_DIAGNOSTICS), stableStringify(diagnostics), "utf-8");
	} catch (err) {
		console.log(`[migration] Warning: could not write per-project migration diagnostics: ${err}`);
	}
}

function copyFilePreserveFirst(src: string, dest: string, rel: string, diagnostics: HeadquartersMigrationDiagnostics): void {
	try {
		if (fs.existsSync(dest)) {
			try {
				if (fs.statSync(src).isFile() && fs.statSync(dest).isFile()) {
					const a = fs.readFileSync(src);
					const b = fs.readFileSync(dest);
					if (a.equals(b)) diagnostics.skipped.push(`${rel}: already present`);
					else diagnostics.skipped.push(`${rel}: destination differs; preserved existing Headquarters file`);
				} else {
					diagnostics.skipped.push(`${rel}: destination exists; preserved existing Headquarters entry`);
				}
			} catch {
				diagnostics.skipped.push(`${rel}: destination exists; preserved existing Headquarters entry`);
			}
			return;
		}
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
		diagnostics.copied.push(rel);
	} catch (err) {
		diagnostics.failures.push(`${rel}: ${(err as Error).message}`);
	}
}

function copyTreePreserveFirst(src: string, dest: string, rel: string, diagnostics: HeadquartersMigrationDiagnostics): void {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(src);
	} catch (err) {
		diagnostics.failures.push(`${rel}: ${(err as Error).message}`);
		return;
	}
	if (stat.isSymbolicLink()) {
		diagnostics.skipped.push(`${rel}: symlink skipped`);
		return;
	}
	if (stat.isFile()) {
		copyFilePreserveFirst(src, dest, rel, diagnostics);
		return;
	}
	if (!stat.isDirectory()) {
		diagnostics.skipped.push(`${rel}: special filesystem entry skipped`);
		return;
	}
	fs.mkdirSync(dest, { recursive: true });
	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(src, { withFileTypes: true }); }
	catch (err) {
		diagnostics.failures.push(`${rel}: ${(err as Error).message}`);
		return;
	}
	for (const entry of entries) {
		copyTreePreserveFirst(path.join(src, entry.name), path.join(dest, entry.name), path.join(rel, entry.name), diagnostics);
	}
}

function recordKeyForFile(fileName: string, record: Record<string, unknown>): string {
	if (fileName === "gates.json") return `${String(record.goalId ?? "")}::${String(record.gateId ?? "")}`;
	if (fileName === "team-state.json" || fileName === "gateway-swarms.json") return String(record.goalId ?? "");
	if (fileName === "session-costs.json" || fileName === "session-colors.json") return String(record.id ?? record.sessionId ?? "");
	return String(record.id ?? record.goalId ?? record.staffId ?? "");
}

const HEADQUARTERS_EXECUTION_STORE_FILES = new Set(["sessions.json", "goals.json", "staff.json", "team-state.json", "gateway-swarms.json"]);
const HEADQUARTERS_GIT_WORKTREE_FIELDS = [
	"worktreePath",
	"repoPath",
	"repoWorktrees",
	"branch",
	"setupStatus",
	"setupError",
	"worktreePushPolicy",
	"remotePublicationPolicy",
	"worktreeSetupCommand",
	"worktreeSetupTimeoutMs",
	"sandboxBranch",
	"sandboxBaseBranch",
	"baseSha",
] as const;

function isPathInsideOrEqual(candidate: string, root: string): boolean {
	const rootKey = pathKey(root).replace(/[\\/]+$/, "");
	const candidateKey = pathKey(candidate).replace(/[\\/]+$/, "");
	return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}${path.sep}`);
}

function isValidHeadquartersCwd(value: unknown, headquartersDirPath: string): value is string {
	return typeof value === "string" && path.isAbsolute(value) && isPathInsideOrEqual(value, headquartersDirPath);
}

function pushSanitizedHeadquartersRecord(
	diagnostics: HeadquartersMigrationDiagnostics,
	fileName: string,
	key: string,
	actions: string[],
): void {
	if (actions.length === 0) return;
	diagnostics.sanitizedHeadquartersRecords.push({ file: fileName, key, actions });
}

function sanitizeHeadquartersExecutionRecord(
	fileName: string,
	record: Record<string, unknown>,
	headquartersDirPath: string,
	opts: { stampProjectId?: boolean } = {},
): { record: Record<string, unknown>; actions: string[] } {
	if (!HEADQUARTERS_EXECUTION_STORE_FILES.has(fileName)) return { record, actions: [] };
	const sanitized: Record<string, unknown> = { ...record };
	const actions: string[] = [];
	const projectId = typeof sanitized.projectId === "string" ? sanitized.projectId : undefined;
	if (!projectId && opts.stampProjectId !== false) {
		sanitized.projectId = HEADQUARTERS_PROJECT_ID;
		actions.push(`set projectId ${HEADQUARTERS_PROJECT_ID}`);
	}

	if ((fileName !== "team-state.json" && fileName !== "gateway-swarms.json") || "cwd" in sanitized) {
		if (!isValidHeadquartersCwd(sanitized.cwd, headquartersDirPath)) {
			const previous = typeof sanitized.cwd === "string" && sanitized.cwd.length > 0 ? sanitized.cwd : "<missing>";
			sanitized.cwd = headquartersDirPath;
			actions.push(`cwd ${previous} -> ${headquartersDirPath}`);
		}
	}

	for (const field of HEADQUARTERS_GIT_WORKTREE_FIELDS) {
		if (field in sanitized) {
			delete sanitized[field];
			actions.push(`removed ${field}`);
		}
	}

	if ((fileName === "team-state.json" || fileName === "gateway-swarms.json") && Array.isArray(sanitized.agents)) {
		let agentsChanged = false;
		sanitized.agents = sanitized.agents.map(agent => {
			if (!isPlainRecord(agent)) return agent;
			const cleanAgent: Record<string, unknown> = { ...agent };
			const nestedActions: string[] = [];
			if ("cwd" in cleanAgent && !isValidHeadquartersCwd(cleanAgent.cwd, headquartersDirPath)) {
				const previous = typeof cleanAgent.cwd === "string" && cleanAgent.cwd.length > 0 ? cleanAgent.cwd : "<missing>";
				cleanAgent.cwd = headquartersDirPath;
				nestedActions.push(`agent cwd ${previous} -> ${headquartersDirPath}`);
			}
			for (const field of HEADQUARTERS_GIT_WORKTREE_FIELDS) {
				if (field in cleanAgent) {
					delete cleanAgent[field];
					nestedActions.push(`removed agent.${field}`);
				}
			}
			if (nestedActions.length > 0) {
				agentsChanged = true;
				actions.push(...nestedActions);
			}
			return cleanAgent;
		});
		if (agentsChanged) actions.push("sanitized team agents");
	}

	return { record: sanitized, actions };
}

function sanitizeHeadquartersStoreFile(
	filePath: string,
	fileName: string,
	headquartersDirPath: string,
	diagnostics: HeadquartersMigrationDiagnostics,
	opts: { stampMissingProjectId?: boolean } = {},
): void {
	if (!fs.existsSync(filePath) || !HEADQUARTERS_EXECUTION_STORE_FILES.has(fileName)) return;
	const { records, shape } = readStoreRecordsWithShape(filePath, fileName);
	if (records.length === 0) return;
	let changed = false;
	const sanitizedRecords = records.map(record => {
		const projectId = typeof record.projectId === "string" ? record.projectId : undefined;
		if (projectId && projectId !== HEADQUARTERS_PROJECT_ID && fileName !== "team-state.json" && fileName !== "gateway-swarms.json") return record;
		const key = recordKeyForFile(fileName, record);
		const result = sanitizeHeadquartersExecutionRecord(fileName, record, headquartersDirPath, { stampProjectId: opts.stampMissingProjectId !== false });
		if (result.actions.length > 0) {
			changed = true;
			pushSanitizedHeadquartersRecord(diagnostics, fileName, key, result.actions);
		}
		return result.record;
	});
	if (!changed) return;
	writeStoreRecords(filePath, sanitizedRecords, shape);
}

function sanitizeExistingHeadquartersStores(
	headquartersStateDir: string,
	headquartersDirPath: string,
	diagnostics: HeadquartersMigrationDiagnostics,
	opts: { stampMissingProjectId?: boolean } = {},
): void {
	for (const fileName of ["sessions.json", "goals.json", "staff.json", "team-state.json", "gateway-swarms.json"]) {
		sanitizeHeadquartersStoreFile(path.join(headquartersStateDir, fileName), fileName, headquartersDirPath, diagnostics, opts);
	}
}

/**
 * On-disk shape of a per-project store file. Most stores
 * (goals/staff/tasks/team-state/gates/inbox) are plain JSON arrays, but
 * `sessions.json` is a versioned envelope `{ version: 2, epoch, sessions: [...] }`
 * written by SessionStore. The migration MUST round-trip whichever shape it
 * finds: rewriting the envelope as a bare array (the previous bug) flattened its
 * top-level keys into `{ id: "version" | "epoch" | "sessions" }` pseudo-records,
 * which SessionStore cannot load — so Headquarters sessions silently vanished on
 * the next restart. Pinned by tests/headquarters-state-migration.test.ts.
 */
type StoreFileShape = { kind: "array" } | { kind: "sessions-v2"; epoch: number };

function isSessionsEnvelopeFile(fileName: string): boolean {
	return fileName === "sessions.json";
}

/**
 * Read a store file into flat records plus the shape needed to write it back
 * unchanged. Arbitrary object-shaped files are flattened key-by-key into
 * `{ id, ... }` records (the legacy behaviour for non-array stores).
 */
function readStoreRecordsWithShape(filePath: string, fileName: string): { records: Record<string, unknown>[]; shape: StoreFileShape } {
	const sessionsEnvelope = isSessionsEnvelopeFile(fileName);
	const value = readJsonValue<unknown>(filePath);
	if (Array.isArray(value)) return { records: value.filter(isPlainRecord), shape: { kind: "array" } };
	if (
		sessionsEnvelope &&
		isPlainRecord(value) &&
		(value as { version?: unknown }).version === 2 &&
		Array.isArray((value as { sessions?: unknown }).sessions)
	) {
		const epoch = typeof (value as { epoch?: unknown }).epoch === "number" ? (value as { epoch: number }).epoch : 0;
		return { records: ((value as { sessions: unknown[] }).sessions).filter(isPlainRecord), shape: { kind: "sessions-v2", epoch } };
	}
	if (isPlainRecord(value)) {
		return {
			records: Object.entries(value).map(([id, record]) => isPlainRecord(record) ? { id, ...record } : { id, value: record }),
			shape: { kind: "array" },
		};
	}
	// Missing/unreadable: write a bare array. SessionStore accepts the legacy v1
	// array shape and upgrades it to the v2 envelope on its next save. The envelope
	// is only ever *preserved* here when the file already exists in that shape, so a
	// sanitize/merge of an existing HQ store never downgrades it to the array form.
	return { records: [], shape: { kind: "array" } };
}

function writeStoreRecords(filePath: string, records: Record<string, unknown>[], shape: StoreFileShape): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const payload = shape.kind === "sessions-v2"
		? { version: 2 as const, epoch: shape.epoch, sessions: records }
		: records;
	fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");
}

function mergeRecordsByKey(
	filePath: string,
	fileName: string,
	records: Record<string, unknown>[],
	diagnostics: HeadquartersMigrationDiagnostics,
	label: string,
): void {
	if (records.length === 0) return;
	const { records: existing, shape } = readStoreRecordsWithShape(filePath, fileName);
	const indexByKey = new Map(existing.map((record, index) => [recordKeyForFile(fileName, record), index] as const).filter(([key]) => Boolean(key)));
	let added = 0;
	let repaired = 0;
	for (const record of records) {
		const key = recordKeyForFile(fileName, record);
		if (!key) continue;
		const existingIndex = indexByKey.get(key);
		if (existingIndex !== undefined) {
			const current = existing[existingIndex];
			if (
				label.startsWith("normal:") &&
				typeof record.projectId === "string" &&
				current.projectId === HEADQUARTERS_PROJECT_ID &&
				record.projectId !== HEADQUARTERS_PROJECT_ID
			) {
				existing[existingIndex] = { ...record, ...current, projectId: record.projectId };
				repaired++;
			}
			continue;
		}
		existing.push(record);
		indexByKey.set(key, existing.length - 1);
		added++;
	}
	if (added === 0 && repaired === 0 && fs.existsSync(filePath)) return;
	writeStoreRecords(filePath, existing, shape);
	diagnostics.copied.push(`${label}: ${added} added, ${repaired} repaired ${fileName} record${added + repaired === 1 ? "" : "s"}`);
}

function sameRootNormalProjectsFrom(
	projects: Record<string, unknown>[],
	serverRunDir: string,
): Record<string, unknown>[] {
	const serverKey = canonicalPathKey(serverRunDir);
	return projects.filter(project => {
		const id = typeof project.id === "string" ? project.id : "";
		if (!id || id === HEADQUARTERS_PROJECT_ID || id === SYSTEM_PROJECT_ID) return false;
		if (project.kind === "headquarters" || project.kind === "system" || project.hidden === true) return false;
		return typeof project.rootPath === "string" && canonicalPathKey(project.rootPath) === serverKey;
	});
}

function readProjectsFile(filePath: string): Record<string, unknown>[] {
	return readJsonArray<Record<string, unknown>>(filePath).filter(isPlainRecord);
}

function collectProjectEvidence(
	headquartersStateDir: string,
	legacyStateDir: string,
	serverRunDir: string,
): { current: Record<string, unknown>[]; backups: Record<string, unknown>[]; sameRoot: Record<string, unknown>[]; sameRootIds: Set<string> } {
	const projectFiles = [
		path.join(headquartersStateDir, "projects.json"),
		path.join(legacyStateDir, "projects.json"),
	];
	const backupFiles = projectFiles.map(file => file + HEADQUARTERS_BACKUP_SUFFIX);
	const current = projectFiles.flatMap(readProjectsFile);
	const backups = backupFiles.flatMap(readProjectsFile);
	const sameRoot = [...sameRootNormalProjectsFrom(current, serverRunDir), ...sameRootNormalProjectsFrom(backups, serverRunDir)];
	const sameRootIds = new Set(sameRoot.map(project => String(project.id)).filter(Boolean));
	return { current, backups, sameRoot, sameRootIds };
}

function repairProjectsFileForHeadquartersSplit(
	projectsFile: string,
	legacyProjectsFile: string,
	serverRunDir: string,
	headquartersDirPath: string,
	diagnostics: HeadquartersMigrationDiagnostics,
): Set<string> {
	let projects = readProjectsFile(projectsFile);
	if (projects.length === 0) {
		projects = readProjectsFile(legacyProjectsFile);
	}
	const backupProjects = [
		...readProjectsFile(projectsFile + HEADQUARTERS_BACKUP_SUFFIX),
		...readProjectsFile(legacyProjectsFile + HEADQUARTERS_BACKUP_SUFFIX),
	];
	const sameRootBackups = sameRootNormalProjectsFrom(backupProjects, serverRunDir);
	const restoredIds = new Set<string>();
	let changed = false;

	for (const backup of sameRootBackups) {
		const id = String(backup.id ?? "");
		if (!id || projects.some(project => project.id === id)) continue;
		projects.push({ ...backup });
		restoredIds.add(id);
		changed = true;
	}

	for (const project of projects) {
		if (project.id !== HEADQUARTERS_PROJECT_ID && project.kind !== "headquarters") continue;
		if (project.id !== HEADQUARTERS_PROJECT_ID) {
			project.id = HEADQUARTERS_PROJECT_ID;
			changed = true;
		}
		if (project.name !== HEADQUARTERS_PROJECT_NAME) {
			project.name = HEADQUARTERS_PROJECT_NAME;
			changed = true;
		}
		if (project.kind !== "headquarters") {
			project.kind = "headquarters";
			changed = true;
		}
		if (typeof project.rootPath !== "string" || !samePath(project.rootPath, headquartersDirPath)) {
			project.rootPath = path.resolve(headquartersDirPath);
			changed = true;
		}
		// NOTE: do NOT include "position" here. Since PR #933, Headquarters
		// is a user-reorderable project and its saved position must be
		// preserved across restarts. Stripping it here causes HQ to sort
		// last on every subsequent boot.
		for (const key of ["provisional", "parentProjectId", "hidden"]) {
			if (key in project) {
				delete project[key];
				changed = true;
			}
		}
	}

	const seen = new Set<string>();
	projects = projects.filter(project => {
		const id = String(project.id ?? "");
		if (!id || seen.has(id)) return false;
		seen.add(id);
		return true;
	});

	if (changed || restoredIds.size > 0 || (projects.length > 0 && !fs.existsSync(projectsFile))) {
		fs.mkdirSync(path.dirname(projectsFile), { recursive: true });
		backupForHeadquartersMigration(projectsFile);
		fs.writeFileSync(projectsFile, JSON.stringify(projects, null, 2), "utf-8");
		for (const id of restoredIds) diagnostics.restoredNormalProjectIds.push(id);
	}

	return new Set(sameRootNormalProjectsFrom([...projects, ...backupProjects], serverRunDir).map(project => String(project.id)).filter(Boolean));
}

function routeLegacyProjectStoreFile(
	fileName: string,
	legacyFile: string,
	targetFile: string,
	headquartersDirPath: string,
	projectEvidence: { current: Record<string, unknown>[]; sameRootIds: Set<string> },
	diagnostics: HeadquartersMigrationDiagnostics,
): void {
	const legacyRecords = readStoreRecordsWithShape(legacyFile, fileName).records;
	if (legacyRecords.length === 0) return;
	const backupRecords = readStoreRecordsWithShape(legacyFile + HEADQUARTERS_BACKUP_SUFFIX, fileName).records;
	const backupByKey = new Map<string, Record<string, unknown>>();
	for (const record of backupRecords) {
		const key = recordKeyForFile(fileName, record);
		if (key) backupByKey.set(key, record);
	}
	const projectsById = new Map(projectEvidence.current.map(project => [String(project.id ?? ""), project]));
	const hqRecords: Record<string, unknown>[] = [];
	const normalRecordsByProject = new Map<string, Record<string, unknown>[]>();
	const seenLegacyKeys = new Set<string>();
	// When the source and target are the same file (BOBBIT_DIR-override same-root
	// repair), records re-attributed to a normal project must be REMOVED from the
	// Headquarters store — merging them into the normal store alone would leave a
	// duplicate under `headquarters`.
	const inPlace = samePath(legacyFile, targetFile);
	const routedNormalKeys = new Set<string>();

	const routeNormal = (projectId: string, record: Record<string, unknown>, key: string): void => {
		const bucket = normalRecordsByProject.get(projectId) ?? [];
		bucket.push(record);
		normalRecordsByProject.set(projectId, bucket);
		if (key) routedNormalKeys.add(key);
		diagnostics.restoredNormalRecords.push({ file: fileName, key, projectId });
	};

	for (const record of legacyRecords) {
		const key = recordKeyForFile(fileName, record);
		if (key) seenLegacyKeys.add(key);
		const backup = key ? backupByKey.get(key) : undefined;
		const backupProjectId = typeof backup?.projectId === "string" ? backup.projectId : undefined;
		const projectId = typeof record.projectId === "string" ? record.projectId : undefined;

		if (backupProjectId && projectEvidence.sameRootIds.has(backupProjectId)) {
			// Finding C: the CURRENT (post-promotion) record is authoritative. The
			// stale `.pre-headquarters-id-migration` backup is a pre-promotion
			// snapshot — overwriting the live record with it would silently DROP any
			// updates made after promotion (progressed goals, updated sessions, …).
			// Prefer the current record's fields; use the backup only to (a) recover
			// the correct normal projectId and (b) fill in fields the promotion may
			// have stripped (e.g. worktree/git metadata). Current wins on conflict.
			routeNormal(backupProjectId, { ...backup, ...record, projectId: backupProjectId }, key);
			continue;
		}
		if (projectId && projectId !== HEADQUARTERS_PROJECT_ID && projectsById.has(projectId)) {
			routeNormal(projectId, record, key);
			continue;
		}
		if (!projectId) {
			if (projectEvidence.sameRootIds.size > 0) {
				diagnostics.ambiguousRecords.push({ file: fileName, key, reason: "missing projectId while same-root normal project evidence exists" });
				continue;
			}
			hqRecords.push({ ...record, projectId: HEADQUARTERS_PROJECT_ID });
			continue;
		}
		if (projectId === HEADQUARTERS_PROJECT_ID) {
			hqRecords.push(record);
			continue;
		}
		diagnostics.ambiguousRecords.push({ file: fileName, key, reason: `unknown projectId ${projectId}` });
	}

	for (const [key, backup] of backupByKey) {
		if (seenLegacyKeys.has(key)) continue;
		const backupProjectId = typeof backup.projectId === "string" ? backup.projectId : undefined;
		if (backupProjectId && projectEvidence.sameRootIds.has(backupProjectId)) {
			routeNormal(backupProjectId, { ...backup, projectId: backupProjectId }, key);
		}
	}

	const existingHeadquartersKeys = new Set(readStoreRecordsWithShape(targetFile, fileName).records
		.map(record => recordKeyForFile(fileName, record))
		.filter(Boolean));
	const sanitizedHeadquartersRecords = hqRecords.map(record => {
		const key = recordKeyForFile(fileName, record);
		const result = sanitizeHeadquartersExecutionRecord(fileName, record, headquartersDirPath);
		if (result.actions.length > 0 && key && !existingHeadquartersKeys.has(key)) {
			pushSanitizedHeadquartersRecord(diagnostics, fileName, key, result.actions);
		}
		return result.record;
	});
	mergeRecordsByKey(targetFile, fileName, sanitizedHeadquartersRecords, diagnostics, "headquarters");
	sanitizeHeadquartersStoreFile(targetFile, fileName, headquartersDirPath, diagnostics, { stampMissingProjectId: projectEvidence.sameRootIds.size === 0 });
	for (const [projectId, records] of normalRecordsByProject) {
		const project = projectsById.get(projectId);
		if (!project || typeof project.rootPath !== "string") continue;
		const normalFile = path.join(project.rootPath, ".bobbit", "state", fileName === "gateway-swarms.json" ? "team-state.json" : fileName);
		mergeRecordsByKey(normalFile, fileName, records, diagnostics, `normal:${projectId}`);
	}
	// In-place (override) repair: drop records now attributed to a normal project
	// from the Headquarters store so they no longer double up under `headquarters`.
	// Records that were left ambiguous / genuinely headquarters are preserved.
	if (inPlace && routedNormalKeys.size > 0) {
		const { records: existing, shape } = readStoreRecordsWithShape(targetFile, fileName);
		const kept = existing.filter(record => {
			const key = recordKeyForFile(fileName, record);
			return !key || !routedNormalKeys.has(key);
		});
		if (kept.length !== existing.length) {
			writeStoreRecords(targetFile, kept, shape);
			diagnostics.copied.push(`headquarters: removed ${existing.length - kept.length} re-attributed normal record${existing.length - kept.length === 1 ? "" : "s"} from ${fileName}`);
		}
	}
}

function quarantineLegacyConfig(
	legacyConfigDir: string,
	headquartersStateDir: string,
	diagnostics: HeadquartersMigrationDiagnostics,
): void {
	const quarantineDir = path.join(headquartersStateDir, "migration-quarantine", "config", "legacy-server-bobbit-config");
	copyTreePreserveFirst(legacyConfigDir, quarantineDir, "migration-quarantine/config/legacy-server-bobbit-config", diagnostics);
	const collect = (dir: string): void => {
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			const child = path.join(dir, entry.name);
			if (entry.isDirectory()) collect(child);
			else if (entry.isFile()) diagnostics.quarantinedConfigFiles.push(path.relative(quarantineDir, child).replace(/\\/g, "/"));
		}
	};
	collect(quarantineDir);
}

/**
 * Recursively compare two filesystem trees for byte-equivalence, mirroring what
 * {@link copyTreePreserveFirst} actually copies: symlinks and special entries are
 * skipped (so their presence is not required for equivalence), files must have
 * identical bytes, and directories must have byte-equivalent children. Used to
 * PROVE a relocated server secret landed intact before we delete the reachable
 * source. Returns false on any read/stat error so callers fail closed.
 */
function treesEqual(a: string, b: string): boolean {
	let sa: fs.Stats;
	let sb: fs.Stats;
	try {
		sa = fs.lstatSync(a);
		sb = fs.lstatSync(b);
	} catch {
		return false;
	}
	if (sa.isSymbolicLink()) return true; // copy skips symlinks; not required at dest
	if (sa.isFile()) {
		if (!sb.isFile()) return false;
		try {
			return fs.readFileSync(a).equals(fs.readFileSync(b));
		} catch {
			return false;
		}
	}
	if (sa.isDirectory()) {
		if (!sb.isDirectory()) return false;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(a, { withFileTypes: true });
		} catch {
			return false;
		}
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue; // copy skips symlinks
			if (!treesEqual(path.join(a, entry.name), path.join(b, entry.name))) return false;
		}
		return true;
	}
	return true; // special entries are skipped by the copy
}

/**
 * Security: relocate LIVE server secrets (`token`, `tls`, `sandbox-agent-auth`)
 * out of `sourceStateDir` and into the OS-level `serverSecretsDir()`, which lives
 * OUTSIDE any project root.
 *
 * Both the Headquarters state dir (`<serverRunDir>/.bobbit/headquarters/state` by
 * default) and the legacy `<serverRunDir>/.bobbit/state` are DESCENDANTS of a
 * same-root normal project's default cwd (`<serverRunDir>`), so leaving a live
 * admin bearer `token` (or TLS material / sandbox auth) there is a gateway-wide
 * privilege escalation. This moves each entry so exactly ONE live copy remains,
 * in `serverSecretsDir()`.
 *
 * Preserve-first: never overwrite a secret already present in `serverSecretsDir()`
 * — that copy is authoritative (preserves an existing token VALUE / continuity).
 * When the target already exists we simply drop the reachable duplicate. A
 * NON-secret marker is left behind so the move is traceable. Idempotent: a no-op
 * once no reachable copy remains.
 *
 * FATAL by design (finding B): if a live secret cannot be provably removed from
 * the project-reachable path — the copy into serverSecretsDir() failed / is not
 * byte-equivalent, or the reachable source survives deletion — this THROWS rather
 * than merely logging. Continuing would leave the admin bearer token readable
 * under a same-root normal project's cwd, re-opening the S1 privilege escalation.
 * Diagnostics are persisted before the throw so the failure is auditable.
 */
function relocateServerSecretsToSecretsDir(
	sourceStateDir: string,
	secretsDir: string,
	diagnostics: HeadquartersMigrationDiagnostics,
): void {
	// Never relocate onto itself (e.g. BOBBIT_SECRETS_DIR pointed at the state dir).
	if (samePath(sourceStateDir, secretsDir)) return;
	for (const entry of SERVER_SECRET_ENTRIES) {
		const src = path.join(sourceStateDir, entry);
		if (!fs.existsSync(src)) continue; // already relocated / never present
		const dest = path.join(secretsDir, entry);
		try {
			const destPreexisted = fs.existsSync(dest);
			if (!destPreexisted) {
				// 1. Preserve the secret in the secrets dir before removal.
				fs.mkdirSync(secretsDir, { recursive: true });
				copyTreePreserveFirst(src, dest, path.join("server-secrets", entry), diagnostics);
				// FATAL: prove the copy produced a byte-equivalent secret BEFORE we
				// delete the reachable source. Deleting after a bad copy would lose the
				// secret; keeping the source leaves the admin token readable.
				if (!fs.existsSync(dest) || !treesEqual(src, dest)) {
					throw new Error("copied secret into serverSecretsDir is missing or not byte-equivalent to the source");
				}
				diagnostics.copied.push(`security: relocated live server secret "${entry}" into serverSecretsDir (outside any project root)`);
			} else {
				// secretsDir already holds the authoritative live copy — just drop the
				// project-reachable duplicate. Preserves token continuity.
				diagnostics.skipped.push(`security: server secret "${entry}" already present in serverSecretsDir; removed project-reachable duplicate`);
			}
			// 2. Remove the reachable copy from the project-reachable state dir.
			fs.rmSync(src, { recursive: true, force: true });
			// FATAL: prove the reachable source is actually gone. If it survives, the
			// live admin bearer token / TLS / sandbox auth stays readable under a
			// project-reachable path (S1 escalation) — refuse to continue.
			if (fs.existsSync(src)) {
				throw new Error("reachable server secret survived removal from the project-reachable state dir");
			}
			// 3. Leave a NON-secret marker so operators can trace the move.
			try {
				fs.writeFileSync(
					path.join(sourceStateDir, `.${entry}-moved-to-server-secrets`),
					`Moved to the OS-level Bobbit server secrets directory on ${new Date().toISOString()}. Live secrets no longer live under any project-reachable path.\n`,
					"utf-8",
				);
			} catch { /* marker is best-effort and contains no secret */ }
		} catch (err) {
			// FATAL: leaving a live server secret readable under a project-reachable
			// path re-opens the same-root admin-token escalation. Persist diagnostics
			// (never containing the secret), then abort — fail closed.
			const message = `security: refusing to continue — could not provably relocate live server secret "${entry}" out of a project-reachable path (${src}): ${(err as Error).message}`;
			diagnostics.failures.push(message);
			try {
				writeHeadquartersDiagnostics(diagnostics.paths.headquartersStateDir, diagnostics);
			} catch { /* best-effort audit; the throw below is the real signal */ }
			throw new Error(message);
		}
	}
}

/**
 * Security: relocate legacy `<serverRunDir>/.bobbit/state` server secrets into
 * `serverSecretsDir()` (preserve-first) and strip the legacy copies. Thin wrapper
 * over {@link relocateServerSecretsToSecretsDir} kept for call-site clarity — the
 * legacy state dir is normal-project-owned after the split, so the same reachable
 * escalation applies. Only call in the default no-override, non-source-is-target
 * case (the override legacy dir is handled by relocating the HQ state dir).
 */
function neutralizeLegacyServerSecrets(
	legacyStateDir: string,
	diagnostics: HeadquartersMigrationDiagnostics,
): void {
	relocateServerSecretsToSecretsDir(legacyStateDir, serverSecretsDir(), diagnostics);
}

export function migrateLegacyHeadquartersDirectory(input: HeadquartersDirectoryMigrationInput): HeadquartersMigrationDiagnostics {
	const serverRunDir = path.resolve(input.serverRunDir);
	const headquartersDirPath = path.resolve(input.headquartersDir);
	const headquartersStateDir = path.resolve(input.headquartersStateDir);
	const headquartersConfigDir = path.resolve(input.headquartersConfigDir);
	const legacyServerBobbitDir = path.resolve(input.legacyServerBobbitDir);
	const legacyStateDir = path.join(legacyServerBobbitDir, "state");
	const legacyConfigDir = path.join(legacyServerBobbitDir, "config");
	const diagnostics = newHeadquartersDiagnostics({ serverRunDir, headquartersDir: headquartersDirPath, headquartersStateDir, headquartersConfigDir, legacyServerBobbitDir });

	try {
		fs.mkdirSync(headquartersStateDir, { recursive: true });
		fs.mkdirSync(headquartersConfigDir, { recursive: true });
	} catch (err) {
		diagnostics.failures.push(`prepare Headquarters directories: ${(err as Error).message}`);
		writeHeadquartersDiagnostics(headquartersStateDir, diagnostics);
		throw err;
	}

	const defaultHeadquartersDir = path.join(serverRunDir, ".bobbit", "headquarters");
	const usingOverride = !samePath(headquartersDirPath, defaultHeadquartersDir);
	const sourceIsTarget = samePath(legacyStateDir, headquartersStateDir) && samePath(legacyConfigDir, headquartersConfigDir);
	const useLegacyDefaultSource = !usingOverride || sourceIsTarget;

	if (!sourceIsTarget && !usingOverride && fs.existsSync(legacyStateDir)) {
		for (const entry of fs.readdirSync(legacyStateDir, { withFileTypes: true })) {
			const src = path.join(legacyStateDir, entry.name);
			const dest = path.join(headquartersStateDir, entry.name);
			if (PROJECT_STORE_FILES.has(entry.name)) continue;
			if (SERVER_STATE_ENTRIES.has(entry.name) || entry.name.endsWith(HEADQUARTERS_BACKUP_SUFFIX)) {
				copyTreePreserveFirst(src, dest, entry.name, diagnostics);
			}
		}
		// Relocate the legacy `<serverRunDir>/.bobbit/state` server secrets out to
		// the OS-level serverSecretsDir(); leaving them at a normal-project-reachable
		// path is a gateway-wide privilege escalation.
		neutralizeLegacyServerSecrets(legacyStateDir, diagnostics);
	} else if (usingOverride) {
		diagnostics.skipped.push("legacy default .bobbit/state: BOBBIT_DIR/BOBBIT_PI_DIR-style Headquarters override is used in place");
	}

	// Always relocate any live server secrets that were copied into (or already
	// live at) the Headquarters state dir out to serverSecretsDir(). The default
	// Headquarters dir is `<serverRunDir>/.bobbit/headquarters`, a descendant of a
	// same-root normal project's cwd, so the admin token / TLS / sandbox auth must
	// not remain there. Preserve-first: an existing secretsDir copy wins (token
	// continuity). Runs for both default and BOBBIT_DIR-override installs.
	relocateServerSecretsToSecretsDir(headquartersStateDir, serverSecretsDir(), diagnostics);

	const projectsFile = path.join(headquartersStateDir, "projects.json");
	const legacyProjectsFile = path.join(legacyStateDir, "projects.json");
	const inactiveLegacyProjectsFile = path.join(headquartersStateDir, ".inactive-legacy-default-projects.json");
	const inactiveLegacyStateDir = path.join(headquartersStateDir, ".inactive-legacy-default-state");
	const sameRootIds = repairProjectsFileForHeadquartersSplit(
		projectsFile,
		useLegacyDefaultSource ? legacyProjectsFile : inactiveLegacyProjectsFile,
		serverRunDir,
		headquartersDirPath,
		diagnostics,
	);
	const evidence = collectProjectEvidence(headquartersStateDir, useLegacyDefaultSource ? legacyStateDir : inactiveLegacyStateDir, serverRunDir);
	for (const id of sameRootIds) evidence.sameRootIds.add(id);
	const sameRootEvidence = evidence.sameRootIds.size > 0;

	if (!sourceIsTarget && !usingOverride && fs.existsSync(legacyStateDir)) {
		for (const fileName of PROJECT_STORE_FILES) {
			const legacyFile = path.join(legacyStateDir, fileName);
			if (!fs.existsSync(legacyFile)) continue;
			const targetFile = path.join(headquartersStateDir, fileName === "gateway-swarms.json" ? "team-state.json" : fileName);
			if (PROJECT_OBJECT_STORE_FILES.has(fileName)) {
				if (sameRootEvidence) {
					diagnostics.ambiguousRecords.push({ file: fileName, key: "*", reason: "object-shaped project store requires manual attribution when same-root normal project evidence exists" });
				} else {
					copyTreePreserveFirst(legacyFile, targetFile, fileName, diagnostics);
				}
				continue;
			}
			routeLegacyProjectStoreFile(fileName, legacyFile, targetFile, headquartersDirPath, evidence, diagnostics);
		}
	} else if (usingOverride && !sourceIsTarget && sameRootEvidence) {
		// B1: BOBBIT_DIR/BOBBIT_PI_DIR-override installs promoted per-store records
		// (sessions/goals/staff/…) under `headquarters` and left their
		// `.pre-headquarters-id-migration` per-store backups in the SAME override
		// state dir. `repairProjectsFileForHeadquartersSplit` restored the normal
		// project's registry record above, but without this the promoted records
		// stay attributed to headquarters. Re-run the per-store repair reading the
		// per-store files and backups from the override state dir (which is both the
		// source and the Headquarters target — routeLegacyProjectStoreFile detects
		// the in-place case and strips re-attributed normal records from the HQ
		// store). Reuses the same routing/evidence helpers as the non-override path.
		for (const fileName of PROJECT_STORE_FILES) {
			const overrideFile = path.join(headquartersStateDir, fileName);
			const hasBackup = fs.existsSync(overrideFile + HEADQUARTERS_BACKUP_SUFFIX);
			if (!fs.existsSync(overrideFile) && !hasBackup) continue;
			const targetFile = path.join(headquartersStateDir, fileName === "gateway-swarms.json" ? "team-state.json" : fileName);
			if (PROJECT_OBJECT_STORE_FILES.has(fileName)) {
				// Object-shaped stores can't be safely re-attributed key-by-key when
				// same-root evidence exists — flag for manual attribution, matching
				// the non-override branch.
				diagnostics.ambiguousRecords.push({ file: fileName, key: "*", reason: "object-shaped project store requires manual attribution when same-root normal project evidence exists (override install)" });
				continue;
			}
			routeLegacyProjectStoreFile(fileName, overrideFile, targetFile, headquartersDirPath, evidence, diagnostics);
		}
	}

	if (!sourceIsTarget && !usingOverride && fs.existsSync(legacyConfigDir)) {
		if (sameRootEvidence) {
			quarantineLegacyConfig(legacyConfigDir, headquartersStateDir, diagnostics);
			diagnostics.skipped.push("legacy default .bobbit/config: same-root normal project evidence exists; config quarantined instead of activated in Headquarters");
		} else {
			copyTreePreserveFirst(legacyConfigDir, headquartersConfigDir, "config", diagnostics);
		}
	} else if (usingOverride) {
		diagnostics.skipped.push("legacy default .bobbit/config: Headquarters override config is used in place");
	}

	sanitizeExistingHeadquartersStores(headquartersStateDir, headquartersDirPath, diagnostics, { stampMissingProjectId: !sameRootEvidence });

	try {
		fs.writeFileSync(path.join(headquartersStateDir, HEADQUARTERS_DIR_MIGRATION_MARKER), new Date().toISOString(), "utf-8");
	} catch (err) {
		diagnostics.failures.push(`write marker: ${(err as Error).message}`);
	}
	writeHeadquartersDiagnostics(headquartersStateDir, diagnostics);
	return diagnostics;
}

function migrateHeadquartersProjectAliases(
	centralStateDir: string,
	centralConfigDir: string,
	projectRegistry: ProjectRegistry,
	serverCwd: string,
): { oldProjectIds: Set<string>; headquartersProject?: RegisteredProject } {
	void centralConfigDir;
	const oldProjectIds = new Set<string>();
	const projects = registryProjectMap(projectRegistry);
	if (!projects) return { oldProjectIds };

	const projectsFile = path.join(centralStateDir, "projects.json");
	const headquartersRoot = path.resolve(path.dirname(centralStateDir));
	let headquartersProject = projects.get(HEADQUARTERS_PROJECT_ID);
	let registryChanged = false;

	const backupProjects = readProjectsFile(projectsFile + HEADQUARTERS_BACKUP_SUFFIX);
	const sameRootBackups = sameRootNormalProjectsFrom(backupProjects, serverCwd);
	for (const backup of sameRootBackups) {
		const id = String(backup.id ?? "");
		if (!id || projects.has(id)) continue;
		projects.set(id, backup as unknown as RegisteredProject);
		registryChanged = true;
		console.log(`[migration] Restored same-root normal project ${id} from Headquarters id migration backup`);
	}

	if (headquartersProject) {
		if (headquartersProject.name !== HEADQUARTERS_PROJECT_NAME) {
			headquartersProject.name = HEADQUARTERS_PROJECT_NAME;
			registryChanged = true;
		}
		if (headquartersProject.kind !== "headquarters") {
			headquartersProject.kind = "headquarters";
			registryChanged = true;
		}
		if (!samePath(headquartersProject.rootPath, headquartersRoot)) {
			headquartersProject.rootPath = headquartersRoot;
			registryChanged = true;
		}
		if (headquartersProject.hidden !== undefined) {
			delete headquartersProject.hidden;
			registryChanged = true;
		}
		if (headquartersProject.provisional !== undefined) {
			delete headquartersProject.provisional;
			registryChanged = true;
		}
		// NOTE: do NOT delete headquartersProject.position here. Since PR #933,
		// Headquarters is a first-class reorderable project and its position is
		// user-controlled. Deleting it every startup would reset HQ to the end of
		// the list. The pre-PR#933 code that stripped this field is now incorrect.
		if (headquartersProject.parentProjectId !== undefined) {
			delete headquartersProject.parentProjectId;
			registryChanged = true;
		}
	}

	if (registryChanged) {
		backupForHeadquartersMigration(projectsFile);
		registrySave(projectRegistry);
		try {
			fs.mkdirSync(centralStateDir, { recursive: true });
			fs.writeFileSync(path.join(centralStateDir, HEADQUARTERS_ID_MIGRATION_MARKER), new Date().toISOString(), "utf-8");
		} catch (err) {
			console.log(`[migration] Warning: could not write Headquarters id repair marker: ${err}`);
		}
	}

	// This function intentionally no longer returns old normal ids for rewrite.
	// Same-root normal projects remain normal projects; per-store backup repair is
	// handled by migrateLegacyHeadquartersDirectory().
	return { oldProjectIds, headquartersProject };
}

/**
 * One-time migration from centralized state (`<server-cwd>/.bobbit/state/`)
 * to per-project state (`<project-root>/.bobbit/state/`).
 *
 * Distributes goals, sessions, tasks, teams, gates, and staff to the
 * correct project's state directory based on `projectId` tags.
 *
 * MIGRATION-ONLY default-project behavior
 * ----------------------------------------
 * Legacy records predate multi-project and therefore carry no `projectId`.
 * To avoid dropping them on the floor, this migration anchors such records
 * to a single "migration target" project: `projectRegistry.getByPath(serverCwd)`
 * if one is registered, else `projects[0]`. The variable below is named
 * `defaultProject` for historical reasons — it is NOT a runtime default
 * project. Bobbit has no runtime default project concept any more:
 *
 *   - `ProjectRegistry` does not expose `ensureDefaultProject()`.
 *   - `ProjectContextManager` does not expose `getDefault()` /
 *     `getDefaultOrNull()` / `getDefaultProjectId()` /
 *     `getDefaultProjectIdOrNull()`.
 *   - `POST /api/goals`, `POST /api/sessions`, and `POST /api/staff` require
 *     an explicit `projectId` or a `cwd` that matches a registered
 *     project's `rootPath`; otherwise they return 400.
 *
 * The `projects[0]` anchor below runs at most once per install (guarded by
 * the `.migrated-to-per-project` marker file). If you are tempted to reuse
 * this fallback anywhere outside this function, don't — resolve a project
 * explicitly via `resolveProjectForRequest` instead. See
 * [docs/internals.md — Multi-project architecture / State migration] for
 * the full rationale.
 *
 * Renamed (not deleted) central files get a `.pre-migration` suffix.
 * A marker file prevents re-running.
 *
 * Uses synchronous fs operations — runs once at startup.
 */
export function migrateToPerProjectState(
	centralStateDir: string,
	projectRegistry: ProjectRegistry,
	serverCwd: string,
	opts: { centralConfigDir?: string } = {},
): void {
	const centralConfigDir = opts.centralConfigDir ?? path.join(path.dirname(centralStateDir), "config");
	const headquartersAliasMigration = migrateHeadquartersProjectAliases(centralStateDir, centralConfigDir, projectRegistry, serverCwd);
	const markerPath = path.join(centralStateDir, MIGRATION_MARKER);

	// 1. Already migrated? Headquarters split repair still ran above because it
	// is independent of the older per-project state marker.
	if (fs.existsSync(markerPath)) return;

	const projects = projectRegistry.list();
	if (projects.length === 0) {
		// No projects registered — nothing to migrate to
		return;
	}

	// Find the default project: prefer Headquarters/serverCwd, else first registered.
	const defaultProject =
		projectRegistry.get(HEADQUARTERS_PROJECT_ID) ??
		projectRegistry.getByPath(serverCwd) ??
		projects[0];

	const legacyDefaultStateDir = path.join(serverCwd, ".bobbit", "state");
	const projectEvidence = collectProjectEvidence(centralStateDir, legacyDefaultStateDir, serverCwd);
	for (const project of sameRootNormalProjectsFrom(projects as unknown as Record<string, unknown>[], serverCwd)) {
		projectEvidence.sameRootIds.add(String(project.id));
	}
	const sameRootEvidence = projectEvidence.sameRootIds.size > 0;
	const perProjectDiagnostics: PerProjectMigrationDiagnostics = {
		version: 1,
		runAt: new Date().toISOString(),
		paths: {
			centralStateDir: path.resolve(centralStateDir),
			serverCwd: path.resolve(serverCwd),
		},
		sameRootNormalProjectIds: [...projectEvidence.sameRootIds].sort(),
		ambiguousRecords: [],
	};
	const markAmbiguous = (file: string, key: string, reason: string): void => {
		perProjectDiagnostics.ambiguousRecords.push({ file, key, reason });
		console.log(`[migration] Ambiguous ${file} record ${key || "<unknown>"}: ${reason}`);
	};

	console.log(
		`[migration] Starting per-project state migration. Default project: "${defaultProject.name}" (${defaultProject.id})${sameRootEvidence ? `; same-root evidence: ${perProjectDiagnostics.sameRootNormalProjectIds.join(", ")}` : ""}`,
	);

	// Helper: resolve project for a given projectId.
	const resolveProject = (projectId?: string): RegisteredProject | undefined => {
		if (projectId) {
			if (headquartersAliasMigration.oldProjectIds.has(projectId)) {
				return projectRegistry.get(HEADQUARTERS_PROJECT_ID) ?? defaultProject;
			}
			const p = projectRegistry.get(projectId);
			if (p) return p;
			if (sameRootEvidence) return undefined;
		}
		if (sameRootEvidence) return undefined;
		return defaultProject;
	};

	// Helper: ensure <project>/.bobbit/state/ exists. Headquarters aliases the
	// server state dir, which may be redirected via BOBBIT_DIR and is not always
	// `<server root>/.bobbit/state`.
	const ensureProjectStateDir = (project: RegisteredProject): string => {
		const dir = project.id === HEADQUARTERS_PROJECT_ID
			? centralStateDir
			: path.join(project.rootPath, ".bobbit", "state");
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	};

	// Helper: merge items into an existing JSON array file by ID field, write back.
	function mergeAndWrite<T>(
		targetFile: string,
		newItems: T[],
		idField: string,
	): void {
		if (newItems.length === 0) return;
		const dir = path.dirname(targetFile);
		fs.mkdirSync(dir, { recursive: true });
		const existing = readJsonArray<T>(targetFile);
		const existingIds = new Set(existing.map((item) => String((item as Record<string, unknown>)[idField])));
		let added = 0;
		for (const item of newItems) {
			if (!existingIds.has(String((item as Record<string, unknown>)[idField]))) {
				existing.push(item);
				added++;
			}
		}
		fs.writeFileSync(targetFile, JSON.stringify(existing, null, 2), "utf-8");
		if (added > 0) {
			console.log(
				`[migration] Wrote ${added} new items to ${targetFile}`,
			);
		}
	}

	function writeBucket<T>(
		centralFile: string,
		fileName: string,
		project: RegisteredProject,
		items: T[],
		idField: string,
	): void {
		const targetFile = path.join(ensureProjectStateDir(project), fileName);
		if (samePath(targetFile, centralFile)) {
			writeJsonArray(targetFile, items, { backup: true });
			return;
		}
		mergeAndWrite(targetFile, items, idField);
	}

	function clearCentralBucketIfDefaultMissing<T>(
		centralFile: string,
		fileName: string,
		groups: Map<string, T[]>,
	): void {
		const defaultTarget = path.join(ensureProjectStateDir(defaultProject), fileName);
		if (!samePath(defaultTarget, centralFile)) return;
		if (groups.has(defaultProject.id)) return;
		if (!fs.existsSync(centralFile)) return;
		writeJsonArray(centralFile, [], { backup: true });
	}

	// Envelope-aware variants of writeBucket / clearCentralBucketIfDefaultMissing for
	// sessions.json. Unlike goals/tasks/staff (true arrays), sessions.json is a
	// versioned envelope `{ version: 2, epoch, sessions: [...] }` written by
	// SessionStore. Reading it with readJsonArray returns [] (dropping every session)
	// and writing it as a bare array (or clearing with `[]`) corrupts the store so
	// SessionStore loads nothing after restart. These preserve the discovered shape.
	function writeSessionBucket(
		centralFile: string,
		project: RegisteredProject,
		sessions: Record<string, unknown>[],
		sourceShape: StoreFileShape,
	): void {
		const targetFile = path.join(ensureProjectStateDir(project), "sessions.json");
		if (samePath(targetFile, centralFile)) {
			backupForHeadquartersMigration(targetFile);
			writeStoreRecords(targetFile, sessions, sourceShape);
			return;
		}
		if (sessions.length === 0) return;
		fs.mkdirSync(path.dirname(targetFile), { recursive: true });
		const targetExists = fs.existsSync(targetFile);
		const { records: existing, shape: existingShape } = readStoreRecordsWithShape(targetFile, "sessions.json");
		const existingIds = new Set(existing.map(item => String(item.id)));
		let added = 0;
		for (const session of sessions) {
			if (!existingIds.has(String(session.id))) {
				existing.push(session);
				added++;
			}
		}
		// Preserve the target's own envelope when it already exists; otherwise adopt
		// the source envelope shape so a brand-new per-project file stays v2.
		writeStoreRecords(targetFile, existing, targetExists ? existingShape : sourceShape);
		if (added > 0) console.log(`[migration] Wrote ${added} new items to ${targetFile}`);
	}

	function clearCentralSessionsBucketIfDefaultMissing(
		centralFile: string,
		groups: Map<string, Record<string, unknown>[]>,
		shape: StoreFileShape,
	): void {
		const defaultTarget = path.join(ensureProjectStateDir(defaultProject), "sessions.json");
		if (!samePath(defaultTarget, centralFile)) return;
		if (groups.has(defaultProject.id)) return;
		if (!fs.existsSync(centralFile)) return;
		// Write an EMPTY v2 envelope, never a bare `[]`, so SessionStore can load it.
		backupForHeadquartersMigration(centralFile);
		writeStoreRecords(centralFile, [], shape);
	}

	// Helper: safely rename a file with .pre-migration suffix.
	function renameForBackup(filePath: string): void {
		try {
			if (fs.existsSync(filePath)) {
				const backupPath = filePath + PRE_MIGRATION_SUFFIX;
				// Don't overwrite an existing backup
				if (!fs.existsSync(backupPath)) {
					fs.renameSync(filePath, backupPath);
					console.log(`[migration] Renamed ${path.basename(filePath)} → ${path.basename(backupPath)}`);
				}
			}
		} catch (err) {
			console.log(`[migration] Warning: could not rename ${filePath}: ${err}`);
		}
	}

	// ── 2. Read central goals.json and build goal→project map ──
	const centralGoalsFile = path.join(centralStateDir, "goals.json");
	const centralGoals = readJsonArray<PersistedGoal>(centralGoalsFile);
	const goalProjectMap = new Map<string, RegisteredProject>();
	const goalsByProject = new Map<string, PersistedGoal[]>();

	for (const goal of centralGoals) {
		const project = resolveProject(goal.projectId);
		if (!project) {
			markAmbiguous("goals.json", String(goal.id ?? ""), goal.projectId ? `unknown projectId ${goal.projectId} while same-root normal project evidence exists` : "missing projectId while same-root normal project evidence exists");
			let bucket = goalsByProject.get(defaultProject.id);
			if (!bucket) {
				bucket = [];
				goalsByProject.set(defaultProject.id, bucket);
			}
			bucket.push(goal);
			continue;
		}
		goal.projectId = project.id;
		goalProjectMap.set(goal.id, project);
		let bucket = goalsByProject.get(project.id);
		if (!bucket) {
			bucket = [];
			goalsByProject.set(project.id, bucket);
		}
		bucket.push(goal);
	}

	// Write goals to per-project state dirs
	for (const [projectId, goals] of goalsByProject) {
		const project = projectRegistry.get(projectId)!;
		writeBucket(centralGoalsFile, "goals.json", project, goals, "id");
	}
	clearCentralBucketIfDefaultMissing(centralGoalsFile, "goals.json", goalsByProject);
	console.log(`[migration] Distributed ${centralGoals.length} goals across ${goalsByProject.size} project(s)`);

	// ── 3. Sessions ──
	// sessions.json is a versioned envelope (see writeSessionBucket) — read and write
	// it envelope-aware so distribution never flattens/clears it to a bare array.
	const centralSessionsFile = path.join(centralStateDir, "sessions.json");
	const { records: centralSessions, shape: sessionsShape } = readStoreRecordsWithShape(centralSessionsFile, "sessions.json");
	const sessionsByProject = new Map<string, Record<string, unknown>[]>();

	for (const session of centralSessions) {
		const projectId = typeof session.projectId === "string" ? session.projectId : undefined;
		const project = resolveProject(projectId);
		if (!project) {
			markAmbiguous("sessions.json", String(session.id ?? ""), projectId ? `unknown projectId ${projectId} while same-root normal project evidence exists` : "missing projectId while same-root normal project evidence exists");
			let bucket = sessionsByProject.get(defaultProject.id);
			if (!bucket) {
				bucket = [];
				sessionsByProject.set(defaultProject.id, bucket);
			}
			bucket.push(session);
			continue;
		}
		session.projectId = project.id;
		let bucket = sessionsByProject.get(project.id);
		if (!bucket) {
			bucket = [];
			sessionsByProject.set(project.id, bucket);
		}
		bucket.push(session);
	}

	for (const [projectId, sessions] of sessionsByProject) {
		const project = projectRegistry.get(projectId)!;
		writeSessionBucket(centralSessionsFile, project, sessions, sessionsShape);
	}
	clearCentralSessionsBucketIfDefaultMissing(centralSessionsFile, sessionsByProject, sessionsShape);
	console.log(`[migration] Distributed ${centralSessions.length} sessions across ${sessionsByProject.size} project(s)`);

	// ── 4. Tasks — resolve project via goalId → goal's project ──
	const centralTasksFile = path.join(centralStateDir, "tasks.json");
	const centralTasks = readJsonArray<PersistedTask>(centralTasksFile);
	const tasksByProject = new Map<string, PersistedTask[]>();

	for (const task of centralTasks) {
		const project = goalProjectMap.get(task.goalId);
		if (!project && sameRootEvidence) {
			markAmbiguous("tasks.json", String(task.id ?? ""), `goalId ${task.goalId || "<missing>"} has no deterministic project while same-root normal project evidence exists`);
			let bucket = tasksByProject.get(defaultProject.id);
			if (!bucket) {
				bucket = [];
				tasksByProject.set(defaultProject.id, bucket);
			}
			bucket.push(task);
			continue;
		}
		const targetProject = project ?? defaultProject;
		let bucket = tasksByProject.get(targetProject.id);
		if (!bucket) {
			bucket = [];
			tasksByProject.set(targetProject.id, bucket);
		}
		bucket.push(task);
	}

	for (const [projectId, tasks] of tasksByProject) {
		const project = projectRegistry.get(projectId)!;
		writeBucket(centralTasksFile, "tasks.json", project, tasks, "id");
	}
	clearCentralBucketIfDefaultMissing(centralTasksFile, "tasks.json", tasksByProject);
	console.log(`[migration] Distributed ${centralTasks.length} tasks`);

	// ── 5. Teams — resolve project via goalId ──
	// TeamStore uses "team-state.json" (with legacy "gateway-swarms.json" fallback)
	let centralTeamsFile = path.join(centralStateDir, "team-state.json");
	if (!fs.existsSync(centralTeamsFile)) {
		centralTeamsFile = path.join(centralStateDir, "gateway-swarms.json");
	}
	const centralTeams = readJsonArray<PersistedTeamEntry>(centralTeamsFile);
	const teamsByProject = new Map<string, PersistedTeamEntry[]>();

	for (const team of centralTeams) {
		const project = goalProjectMap.get(team.goalId);
		if (!project && sameRootEvidence) {
			markAmbiguous(path.basename(centralTeamsFile), String(team.goalId ?? ""), `goalId ${team.goalId || "<missing>"} has no deterministic project while same-root normal project evidence exists`);
			let bucket = teamsByProject.get(defaultProject.id);
			if (!bucket) {
				bucket = [];
				teamsByProject.set(defaultProject.id, bucket);
			}
			bucket.push(team);
			continue;
		}
		const targetProject = project ?? defaultProject;
		let bucket = teamsByProject.get(targetProject.id);
		if (!bucket) {
			bucket = [];
			teamsByProject.set(targetProject.id, bucket);
		}
		bucket.push(team);
	}

	for (const [projectId, teams] of teamsByProject) {
		const project = projectRegistry.get(projectId)!;
		writeBucket(centralTeamsFile, "team-state.json", project, teams, "goalId");
	}
	clearCentralBucketIfDefaultMissing(centralTeamsFile, "team-state.json", teamsByProject);
	console.log(`[migration] Distributed ${centralTeams.length} teams`);

	// ── 6. Gates — single gates.json file, distribute by goalId ──
	const centralGatesFile = path.join(centralStateDir, "gates.json");
	const centralGates = readJsonArray<GateState>(centralGatesFile);
	const gatesByProject = new Map<string, GateState[]>();

	for (const gate of centralGates) {
		const project = goalProjectMap.get(gate.goalId);
		if (!project && sameRootEvidence) {
			markAmbiguous("gates.json", `${String(gate.goalId ?? "")}::${String(gate.gateId ?? "")}`, `goalId ${gate.goalId || "<missing>"} has no deterministic project while same-root normal project evidence exists`);
			let bucket = gatesByProject.get(defaultProject.id);
			if (!bucket) {
				bucket = [];
				gatesByProject.set(defaultProject.id, bucket);
			}
			bucket.push(gate);
			continue;
		}
		const targetProject = project ?? defaultProject;
		let bucket = gatesByProject.get(targetProject.id);
		if (!bucket) {
			bucket = [];
			gatesByProject.set(targetProject.id, bucket);
		}
		bucket.push(gate);
	}

	for (const [projectId, gates] of gatesByProject) {
		const project = projectRegistry.get(projectId)!;
		const targetFile = path.join(ensureProjectStateDir(project), "gates.json");
		if (samePath(targetFile, centralGatesFile)) {
			writeJsonArray(targetFile, gates, { backup: true });
			continue;
		}
		// Gates use composite key (goalId::gateId), so merge with a custom approach.
		fs.mkdirSync(path.dirname(targetFile), { recursive: true });
		const existing = readJsonArray<GateState>(targetFile);
		const existingKeys = new Set(
			existing.map((g) => `${g.goalId}::${g.gateId}`),
		);
		let added = 0;
		for (const gate of gates) {
			const key = `${gate.goalId}::${gate.gateId}`;
			if (!existingKeys.has(key)) {
				existing.push(gate);
				added++;
			}
		}
		fs.writeFileSync(targetFile, JSON.stringify(existing, null, 2), "utf-8");
		if (added > 0) {
			console.log(`[migration] Wrote ${added} gate states to ${targetFile}`);
		}
	}
	clearCentralBucketIfDefaultMissing(centralGatesFile, "gates.json", gatesByProject);
	console.log(`[migration] Distributed ${centralGates.length} gate states`);

	// ── 7. Staff ──
	const centralStaffFile = path.join(centralStateDir, "staff.json");
	const centralStaff = readJsonArray<PersistedStaff>(centralStaffFile);
	const staffByProject = new Map<string, PersistedStaff[]>();
	for (const staff of centralStaff) {
		const project = resolveProject(staff.projectId);
		if (!project) {
			const staffKey = String(staff.id ?? (staff as unknown as Record<string, unknown>).staffId ?? "");
			markAmbiguous("staff.json", staffKey, staff.projectId ? `unknown projectId ${staff.projectId} while same-root normal project evidence exists` : "missing projectId while same-root normal project evidence exists");
			let bucket = staffByProject.get(defaultProject.id);
			if (!bucket) {
				bucket = [];
				staffByProject.set(defaultProject.id, bucket);
			}
			bucket.push(staff);
			continue;
		}
		staff.projectId = project.id;
		let bucket = staffByProject.get(project.id);
		if (!bucket) {
			bucket = [];
			staffByProject.set(project.id, bucket);
		}
		bucket.push(staff);
	}
	for (const [projectId, staff] of staffByProject) {
		const project = projectRegistry.get(projectId)!;
		writeBucket(centralStaffFile, "staff.json", project, staff, "id");
	}
	clearCentralBucketIfDefaultMissing(centralStaffFile, "staff.json", staffByProject);
	if (centralStaff.length > 0) {
		console.log(`[migration] Distributed ${centralStaff.length} staff agents across ${staffByProject.size} project(s)`);
	}

	// ── 8. Rename central files for backup ──
	// Skip renaming when the central state dir IS the default project's state dir
	// (same physical path). Renaming would delete the per-project file we just wrote.
	const defaultProjectStateDir = path.resolve(ensureProjectStateDir(defaultProject));
	const centralResolved = path.resolve(centralStateDir);
	if (!samePath(centralResolved, defaultProjectStateDir)) {
		renameForBackup(centralGoalsFile);
		renameForBackup(centralSessionsFile);
		renameForBackup(centralTasksFile);
		renameForBackup(centralStaffFile);
		renameForBackup(centralGatesFile);
		// Team store files
		renameForBackup(path.join(centralStateDir, "team-state.json"));
		renameForBackup(path.join(centralStateDir, "gateway-swarms.json"));
		// Search index — will be rebuilt per-project on first access
		renameForBackup(path.join(centralStateDir, "search.db"));
		renameForBackup(path.join(centralStateDir, "search.flex"));
		renameForBackup(path.join(centralStateDir, "search.lance"));
	} else {
		console.log(
			"[migration] Central state dir is the default project dir — skipping backup rename",
		);
	}

	// ── 9. Write migration marker ──
	writePerProjectDiagnostics(centralStateDir, perProjectDiagnostics);
	try {
		fs.writeFileSync(markerPath, new Date().toISOString(), "utf-8");
		console.log("[migration] Per-project state migration complete. Marker written.");
	} catch (err) {
		console.error("[migration] Failed to write migration marker:", err);
	}
}

/**
 * Recovery pass: if `.pre-migration` backup files exist in the state dir,
 * merge any entries missing from the current state files back in.
 *
 * This fixes data loss caused by the original migration code which
 * unconditionally renamed central files even when central dir == default
 * project dir — effectively deleting the sessions it just wrote.
 *
 * Runs once (writes a `.pre-migration-recovered` marker). Safe to re-run.
 */
export function recoverPreMigrationData(stateDir: string): void {
	const recoveryMarker = path.join(stateDir, RECOVERY_MARKER);
	if (fs.existsSync(recoveryMarker)) return;

	const filesToRecover = [
		{ name: "sessions.json", idField: "id" },
		{ name: "goals.json", idField: "id" },
		{ name: "tasks.json", idField: "id" },
		{ name: "staff.json", idField: "id" },
		{ name: "team-state.json", idField: "goalId" },
	];

	let totalRecovered = 0;

	for (const { name, idField } of filesToRecover) {
		const backupFile = path.join(stateDir, name + PRE_MIGRATION_SUFFIX);
		const currentFile = path.join(stateDir, name);
		if (!fs.existsSync(backupFile)) continue;

		try {
			const backup: Record<string, unknown>[] = JSON.parse(fs.readFileSync(backupFile, "utf-8"));
			if (!Array.isArray(backup) || backup.length === 0) continue;

			const current: Record<string, unknown>[] = fs.existsSync(currentFile)
				? JSON.parse(fs.readFileSync(currentFile, "utf-8"))
				: [];
			if (!Array.isArray(current)) continue;

			const existingIds = new Set(current.map(item => String(item[idField])));
			let added = 0;
			for (const item of backup) {
				const id = String(item[idField]);
				if (id && !existingIds.has(id)) {
					current.push(item);
					existingIds.add(id);
					added++;
				}
			}

			if (added > 0) {
				fs.writeFileSync(currentFile, JSON.stringify(current, null, 2), "utf-8");
				console.log(`[migration-recovery] Recovered ${added} entries into ${name}`);
				totalRecovered += added;
			}
		} catch (err) {
			console.warn(`[migration-recovery] Failed to recover ${name}: ${err}`);
		}
	}

	// Gates use composite key
	try {
		const gatesBackup = path.join(stateDir, "gates.json" + PRE_MIGRATION_SUFFIX);
		const gatesCurrent = path.join(stateDir, "gates.json");
		if (fs.existsSync(gatesBackup)) {
			const backup: GateState[] = JSON.parse(fs.readFileSync(gatesBackup, "utf-8"));
			const current: GateState[] = fs.existsSync(gatesCurrent)
				? JSON.parse(fs.readFileSync(gatesCurrent, "utf-8"))
				: [];
			if (Array.isArray(backup) && Array.isArray(current)) {
				const existingKeys = new Set(current.map(g => `${g.goalId}::${g.gateId}`));
				let added = 0;
				for (const gate of backup) {
					const key = `${gate.goalId}::${gate.gateId}`;
					if (!existingKeys.has(key)) {
						current.push(gate);
						existingKeys.add(key);
						added++;
					}
				}
				if (added > 0) {
					fs.writeFileSync(gatesCurrent, JSON.stringify(current, null, 2), "utf-8");
					console.log(`[migration-recovery] Recovered ${added} entries into gates.json`);
					totalRecovered += added;
				}
			}
		}
	} catch (err) {
		console.warn(`[migration-recovery] Failed to recover gates.json: ${err}`);
	}

	if (totalRecovered > 0) {
		console.log(`[migration-recovery] Total recovered: ${totalRecovered} entries`);
	}

	try {
		fs.writeFileSync(recoveryMarker, new Date().toISOString(), "utf-8");
	} catch { /* best effort */ }
}

/**
 * Model-default preference keys that must be preserved across Headquarters
 * directory changes (e.g. when BOBBIT_DIR points to a fresh dir).
 */
export const MODEL_DEFAULT_PREF_KEYS = [
	"default.sessionModel",
	"default.reviewModel",
	"default.namingModel",
	"default.imageModel",
	"default.sessionThinkingLevel",
	"default.reviewThinkingLevel",
	"default.namingThinkingLevel",
] as const;

/**
 * Seed model-default preference keys into the headquarters state dir from any
 * discoverable prior preferences location.
 *
 * This runs **after** `migrateLegacyHeadquartersDirectory` and is a
 * non-destructive complement to it: it targets only the specific
 * `default.*Model` / `default.*ThinkingLevel` keys and never overwrites keys
 * that are already present in the target.
 *
 * Scenarios covered:
 * - Fresh BOBBIT_DIR override pointing to an empty dir (migration skips the
 *   legacy copy, so model defaults would be silently lost without this).
 * - First-ever fresh install where the HQ dir didn't previously exist.
 * - Standard upgrade that introduced the `headquarters/` subdirectory (the
 *   main migration already handles this, but this acts as a safety net).
 *
 * Sources attempted in priority order:
 * 1. `<serverRunDir>/.bobbit/state/preferences.json` — the legacy default path
 *    that predates the Headquarters split.
 */
export function seedModelDefaultsFromLegacy({
	headquartersStateDir,
	serverRunDir,
}: {
	headquartersStateDir: string;
	serverRunDir: string;
}): void {
	const hqPrefsFile = path.join(headquartersStateDir, "preferences.json");
	const legacyPrefsFile = path.join(serverRunDir, ".bobbit", "state", "preferences.json");

	// Skip if source and target are the same file (legacy path IS headquarters
	// state dir — no-op, nothing to seed from anywhere else).
	if (samePath(hqPrefsFile, legacyPrefsFile)) return;

	// Load target preferences (current HQ dir).
	const target: Record<string, unknown> = readJsonValue<Record<string, unknown>>(hqPrefsFile) ?? {};

	// Determine which model-default keys are missing from the target.
	const missingKeys = MODEL_DEFAULT_PREF_KEYS.filter(k => !(k in target));
	if (missingKeys.length === 0) return;

	// Attempt to load source preferences from the legacy path.
	const source = readJsonValue<Record<string, unknown>>(legacyPrefsFile);
	if (!source || typeof source !== "object" || Array.isArray(source)) return;

	// Copy only missing keys that exist in the source.
	let seeded = 0;
	for (const key of missingKeys) {
		if (key in source) {
			target[key] = source[key];
			seeded++;
		}
	}

	if (seeded === 0) return;

	// Persist the updated target preferences.
	try {
		fs.mkdirSync(path.dirname(hqPrefsFile), { recursive: true });
		fs.writeFileSync(hqPrefsFile, JSON.stringify(target, null, 2), "utf-8");
		console.log(`[migration] Seeded ${seeded} model-default preference key(s) from legacy path into Headquarters state dir`);
	} catch (err) {
		console.warn(`[migration] Warning: could not write seeded preferences to ${hqPrefsFile}: ${err}`);
	}
}
