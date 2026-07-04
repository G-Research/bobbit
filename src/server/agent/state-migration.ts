import fs from "node:fs";
import path from "node:path";
import {
	HEADQUARTERS_PROJECT_ID,
	HEADQUARTERS_PROJECT_NAME,
	SYSTEM_PROJECT_ID,
	type ProjectRegistry,
	type RegisteredProject,
} from "./project-registry.js";
import type { PersistedGoal } from "./goal-store.js";
import type { PersistedSession } from "./session-store.js";
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

function readJsonRecords(filePath: string): Record<string, unknown>[] {
	const value = readJsonValue<unknown>(filePath);
	if (Array.isArray(value)) return value.filter(isPlainRecord);
	if (isPlainRecord(value)) {
		return Object.entries(value).map(([id, record]) => isPlainRecord(record) ? { id, ...record } : { id, value: record });
	}
	return [];
}

function mergeRecordsByKey(
	filePath: string,
	fileName: string,
	records: Record<string, unknown>[],
	diagnostics: HeadquartersMigrationDiagnostics,
	label: string,
): void {
	if (records.length === 0) return;
	const existing = readJsonRecords(filePath);
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
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), "utf-8");
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
		for (const key of ["position", "provisional", "parentProjectId", "hidden"]) {
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
	projectEvidence: { current: Record<string, unknown>[]; sameRootIds: Set<string> },
	diagnostics: HeadquartersMigrationDiagnostics,
): void {
	const legacyRecords = readJsonRecords(legacyFile);
	if (legacyRecords.length === 0) return;
	const backupRecords = readJsonRecords(legacyFile + HEADQUARTERS_BACKUP_SUFFIX);
	const backupByKey = new Map<string, Record<string, unknown>>();
	for (const record of backupRecords) {
		const key = recordKeyForFile(fileName, record);
		if (key) backupByKey.set(key, record);
	}
	const projectsById = new Map(projectEvidence.current.map(project => [String(project.id ?? ""), project]));
	const hqRecords: Record<string, unknown>[] = [];
	const normalRecordsByProject = new Map<string, Record<string, unknown>[]>();
	const seenLegacyKeys = new Set<string>();

	const routeNormal = (projectId: string, record: Record<string, unknown>, key: string): void => {
		const bucket = normalRecordsByProject.get(projectId) ?? [];
		bucket.push(record);
		normalRecordsByProject.set(projectId, bucket);
		diagnostics.restoredNormalRecords.push({ file: fileName, key, projectId });
	};

	for (const record of legacyRecords) {
		const key = recordKeyForFile(fileName, record);
		if (key) seenLegacyKeys.add(key);
		const backup = key ? backupByKey.get(key) : undefined;
		const backupProjectId = typeof backup?.projectId === "string" ? backup.projectId : undefined;
		const projectId = typeof record.projectId === "string" ? record.projectId : undefined;

		if (backupProjectId && projectEvidence.sameRootIds.has(backupProjectId)) {
			routeNormal(backupProjectId, { ...backup, projectId: backupProjectId }, key);
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

	mergeRecordsByKey(targetFile, fileName, hqRecords, diagnostics, "headquarters");
	for (const [projectId, records] of normalRecordsByProject) {
		const project = projectsById.get(projectId);
		if (!project || typeof project.rootPath !== "string") continue;
		const normalFile = path.join(project.rootPath, ".bobbit", "state", fileName === "gateway-swarms.json" ? "team-state.json" : fileName);
		mergeRecordsByKey(normalFile, fileName, records, diagnostics, `normal:${projectId}`);
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
	} else if (usingOverride) {
		diagnostics.skipped.push("legacy default .bobbit/state: BOBBIT_DIR/BOBBIT_PI_DIR-style Headquarters override is used in place");
	}

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
			routeLegacyProjectStoreFile(fileName, legacyFile, targetFile, evidence, diagnostics);
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
		if (headquartersProject.position !== undefined) {
			delete headquartersProject.position;
			registryChanged = true;
		}
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

	console.log(
		`[migration] Starting per-project state migration. Default project: "${defaultProject.name}" (${defaultProject.id})`,
	);

	// Helper: resolve project for a given projectId.
	const resolveProject = (projectId?: string): RegisteredProject => {
		if (projectId) {
			if (headquartersAliasMigration.oldProjectIds.has(projectId)) {
				return projectRegistry.get(HEADQUARTERS_PROJECT_ID) ?? defaultProject;
			}
			const p = projectRegistry.get(projectId);
			if (p) return p;
		}
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
	const centralSessionsFile = path.join(centralStateDir, "sessions.json");
	const centralSessions = readJsonArray<PersistedSession>(centralSessionsFile);
	const sessionsByProject = new Map<string, PersistedSession[]>();

	for (const session of centralSessions) {
		const project = resolveProject(session.projectId);
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
		writeBucket(centralSessionsFile, "sessions.json", project, sessions, "id");
	}
	clearCentralBucketIfDefaultMissing(centralSessionsFile, "sessions.json", sessionsByProject);
	console.log(`[migration] Distributed ${centralSessions.length} sessions across ${sessionsByProject.size} project(s)`);

	// ── 4. Tasks — resolve project via goalId → goal's project ──
	const centralTasksFile = path.join(centralStateDir, "tasks.json");
	const centralTasks = readJsonArray<PersistedTask>(centralTasksFile);
	const tasksByProject = new Map<string, PersistedTask[]>();

	for (const task of centralTasks) {
		const project = goalProjectMap.get(task.goalId) ?? defaultProject;
		let bucket = tasksByProject.get(project.id);
		if (!bucket) {
			bucket = [];
			tasksByProject.set(project.id, bucket);
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
		const project = goalProjectMap.get(team.goalId) ?? defaultProject;
		let bucket = teamsByProject.get(project.id);
		if (!bucket) {
			bucket = [];
			teamsByProject.set(project.id, bucket);
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
		const project = goalProjectMap.get(gate.goalId) ?? defaultProject;
		let bucket = gatesByProject.get(project.id);
		if (!bucket) {
			bucket = [];
			gatesByProject.set(project.id, bucket);
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
