import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
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

function rewriteProjectIdReferences(value: unknown, oldProjectIds: Set<string>): boolean {
	let changed = false;
	if (Array.isArray(value)) {
		for (const item of value) {
			if (rewriteProjectIdReferences(item, oldProjectIds)) changed = true;
		}
		return changed;
	}
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	for (const [key, nested] of Object.entries(record)) {
		if ((key === "projectId" || key === "parentProjectId") && typeof nested === "string" && oldProjectIds.has(nested)) {
			record[key] = HEADQUARTERS_PROJECT_ID;
			changed = true;
			continue;
		}
		if (key === "provisionalProjectId" && typeof nested === "string" && oldProjectIds.has(nested)) {
			delete record[key];
			changed = true;
			continue;
		}
		if (rewriteProjectIdReferences(nested, oldProjectIds)) changed = true;
	}
	return changed;
}

function walkJsonFiles(root: string, visit: (filePath: string) => void): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const p = path.join(root, entry.name);
		if (entry.isDirectory()) {
			walkJsonFiles(p, visit);
			continue;
		}
		if (!entry.isFile()) continue;
		if (!entry.name.endsWith(".json")) continue;
		if (entry.name.endsWith(HEADQUARTERS_BACKUP_SUFFIX) || entry.name.endsWith(PRE_MIGRATION_SUFFIX)) continue;
		if (entry.name.endsWith(".tmp")) continue;
		visit(p);
	}
}

function rewriteProjectIdsInJsonTree(root: string, oldProjectIds: Set<string>): void {
	if (oldProjectIds.size === 0) return;
	walkJsonFiles(root, (filePath) => {
		let data: unknown;
		try {
			data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		} catch {
			return;
		}
		if (!rewriteProjectIdReferences(data, oldProjectIds)) return;
		backupForHeadquartersMigration(filePath);
		fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
		console.log(`[migration] Rewrote stale project references in ${filePath}`);
	});
}

function scanStaleProjectIdReferences(root: string, oldProjectIds: Set<string>): string[] {
	const hits: string[] = [];
	if (oldProjectIds.size === 0) return hits;
	const visit = (value: unknown, filePath: string, trail: string): void => {
		if (Array.isArray(value)) {
			value.forEach((item, index) => visit(item, filePath, `${trail}[${index}]`));
			return;
		}
		if (!value || typeof value !== "object") return;
		for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
			const nextTrail = trail ? `${trail}.${key}` : key;
			if (
				(key === "projectId" || key === "parentProjectId" || key === "provisionalProjectId") &&
				typeof nested === "string" &&
				oldProjectIds.has(nested)
			) {
				hits.push(`${filePath}:${nextTrail}`);
			}
			visit(nested, filePath, nextTrail);
		}
	};
	walkJsonFiles(root, (filePath) => {
		try {
			visit(JSON.parse(fs.readFileSync(filePath, "utf-8")), filePath, "");
		} catch {
			// Ignore malformed sidecars; normal store loads already warn elsewhere.
		}
	});
	return hits;
}

function dropSearchIndexesForHeadquartersMigration(stateDir: string): void {
	for (const name of ["search.flex", "search.lance", "search.db", "search.db-wal", "search.db-shm"]) {
		const target = path.join(stateDir, name);
		if (!fs.existsSync(target)) continue;
		const backup = target + HEADQUARTERS_BACKUP_SUFFIX;
		try {
			if (!fs.existsSync(backup)) {
				fs.renameSync(target, backup);
				console.log(`[migration] Moved search index ${name} → ${path.basename(backup)} for reindex`);
			} else {
				fs.rmSync(target, { recursive: true, force: true });
				console.log(`[migration] Removed stale search index ${name} for reindex`);
			}
		} catch (err) {
			console.log(`[migration] Warning: could not reset search index ${target}: ${err}`);
		}
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function deepMergeLegacyIntoCurrent(legacy: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...legacy, ...current };
	for (const [key, legacyValue] of Object.entries(legacy)) {
		const currentValue = current[key];
		if (isPlainRecord(legacyValue) && isPlainRecord(currentValue)) {
			merged[key] = deepMergeLegacyIntoCurrent(legacyValue, currentValue);
		}
	}
	return merged;
}

function readYamlRecord(filePath: string): Record<string, unknown> | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		const parsed = YAML.parse(fs.readFileSync(filePath, "utf-8"));
		return isPlainRecord(parsed) ? parsed : null;
	} catch (err) {
		console.log(`[migration] Warning: could not parse YAML ${filePath}: ${err}`);
		return null;
	}
}

function mergeLegacyProjectYaml(legacyFile: string, targetFile: string): void {
	const legacy = readYamlRecord(legacyFile);
	if (!legacy) return;
	fs.mkdirSync(path.dirname(targetFile), { recursive: true });
	if (!fs.existsSync(targetFile)) {
		fs.copyFileSync(legacyFile, targetFile);
		console.log(`[migration] Preserved legacy Headquarters config ${legacyFile} → ${targetFile}`);
		return;
	}
	const current = readYamlRecord(targetFile) ?? {};
	const merged = deepMergeLegacyIntoCurrent(legacy, current);
	if (JSON.stringify(merged) === JSON.stringify(current)) return;
	backupForHeadquartersMigration(targetFile);
	fs.writeFileSync(targetFile, YAML.stringify(merged), "utf-8");
	console.log(`[migration] Merged legacy Headquarters config into ${targetFile}`);
}

function copyMissingLegacyConfig(legacyConfigDir: string, centralConfigDir: string): void {
	if (samePath(legacyConfigDir, centralConfigDir) || !fs.existsSync(legacyConfigDir)) return;
	const walk = (srcDir: string): void => {
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(srcDir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			const src = path.join(srcDir, entry.name);
			const rel = path.relative(legacyConfigDir, src);
			const dest = path.join(centralConfigDir, rel);
			if (entry.isDirectory()) {
				walk(src);
				continue;
			}
			if (!entry.isFile()) continue;
			if (rel.replace(/\\/g, "/") === "project.yaml") {
				mergeLegacyProjectYaml(src, dest);
				continue;
			}
			if (fs.existsSync(dest)) continue;
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.copyFileSync(src, dest);
			console.log(`[migration] Preserved legacy Headquarters config ${src} → ${dest}`);
		}
	};
	walk(legacyConfigDir);
}

function mergeLegacyJsonArrayFile(
	legacyFile: string,
	targetFile: string,
	oldProjectIds: Set<string>,
	keyFor: (item: Record<string, unknown>) => string,
): void {
	const legacy = readJsonArray<Record<string, unknown>>(legacyFile);
	if (legacy.length === 0) return;
	const rewritten = JSON.parse(JSON.stringify(legacy)) as Record<string, unknown>[];
	rewriteProjectIdReferences(rewritten, oldProjectIds);
	const existing = readJsonArray<Record<string, unknown>>(targetFile);
	const seen = new Set(existing.map(keyFor).filter(Boolean));
	let added = 0;
	for (const item of rewritten) {
		const key = keyFor(item);
		if (!key || seen.has(key)) continue;
		existing.push(item);
		seen.add(key);
		added++;
	}
	if (added === 0 && fs.existsSync(targetFile)) return;
	fs.mkdirSync(path.dirname(targetFile), { recursive: true });
	backupForHeadquartersMigration(targetFile);
	fs.writeFileSync(targetFile, JSON.stringify(existing, null, 2), "utf-8");
	console.log(`[migration] Preserved ${added} legacy Headquarters state entr${added === 1 ? "y" : "ies"} from ${legacyFile}`);
}

function preserveLegacyServerRootBobbitForHeadquarters(
	centralStateDir: string,
	centralConfigDir: string,
	serverCwd: string,
	oldProjectIds: Set<string>,
): void {
	if (oldProjectIds.size === 0) return;
	const legacyBobbitDir = path.join(path.resolve(serverCwd), ".bobbit");
	const legacyStateDir = path.join(legacyBobbitDir, "state");
	const legacyConfigDir = path.join(legacyBobbitDir, "config");

	if (!samePath(legacyStateDir, centralStateDir) && fs.existsSync(legacyStateDir)) {
		mergeLegacyJsonArrayFile(path.join(legacyStateDir, "goals.json"), path.join(centralStateDir, "goals.json"), oldProjectIds, item => String(item.id ?? ""));
		mergeLegacyJsonArrayFile(path.join(legacyStateDir, "sessions.json"), path.join(centralStateDir, "sessions.json"), oldProjectIds, item => String(item.id ?? ""));
		mergeLegacyJsonArrayFile(path.join(legacyStateDir, "staff.json"), path.join(centralStateDir, "staff.json"), oldProjectIds, item => String(item.id ?? ""));
		mergeLegacyJsonArrayFile(path.join(legacyStateDir, "tasks.json"), path.join(centralStateDir, "tasks.json"), oldProjectIds, item => String(item.id ?? ""));
		mergeLegacyJsonArrayFile(path.join(legacyStateDir, "team-state.json"), path.join(centralStateDir, "team-state.json"), oldProjectIds, item => String(item.goalId ?? ""));
		mergeLegacyJsonArrayFile(path.join(legacyStateDir, "gateway-swarms.json"), path.join(centralStateDir, "team-state.json"), oldProjectIds, item => String(item.goalId ?? ""));
		mergeLegacyJsonArrayFile(path.join(legacyStateDir, "gates.json"), path.join(centralStateDir, "gates.json"), oldProjectIds, item => `${String(item.goalId ?? "")}::${String(item.gateId ?? "")}`);
	}

	copyMissingLegacyConfig(legacyConfigDir, centralConfigDir);
}

function migrateHeadquartersProjectAliases(
	centralStateDir: string,
	centralConfigDir: string,
	projectRegistry: ProjectRegistry,
	serverCwd: string,
): { oldProjectIds: Set<string>; headquartersProject?: RegisteredProject } {
	const oldProjectIds = new Set<string>();
	const projects = registryProjectMap(projectRegistry);
	if (!projects) return { oldProjectIds };

	const projectsFile = path.join(centralStateDir, "projects.json");
	const serverRoot = path.resolve(serverCwd);
	const serverRootKey = canonicalPathKey(serverRoot);
	let headquartersProject = projects.get(HEADQUARTERS_PROJECT_ID);
	const serverRootCandidates = [...projects.values()].filter(project => {
		if (project.id === HEADQUARTERS_PROJECT_ID || project.kind === "headquarters") return false;
		if (project.id === SYSTEM_PROJECT_ID || project.kind === "system" || project.hidden) return false;
		return canonicalPathKey(project.rootPath) === serverRootKey;
	});

	for (const project of serverRootCandidates) oldProjectIds.add(project.id);

	let registryChanged = false;
	const markProjectsBackup = (): void => backupForHeadquartersMigration(projectsFile);
	const repairHeadquarters = (project: RegisteredProject): void => {
		if (project.id !== HEADQUARTERS_PROJECT_ID) {
			projects.delete(project.id);
			project.id = HEADQUARTERS_PROJECT_ID;
			projects.set(project.id, project);
			registryChanged = true;
		}
		if (project.name !== HEADQUARTERS_PROJECT_NAME) {
			project.name = HEADQUARTERS_PROJECT_NAME;
			registryChanged = true;
		}
		const resolvedRoot = path.resolve(serverRoot);
		if (path.resolve(project.rootPath) !== resolvedRoot) {
			project.rootPath = resolvedRoot;
			registryChanged = true;
		}
		if (project.kind !== "headquarters") {
			project.kind = "headquarters";
			registryChanged = true;
		}
		if (project.hidden !== undefined) {
			delete project.hidden;
			registryChanged = true;
		}
		if (project.provisional !== undefined) {
			delete project.provisional;
			registryChanged = true;
		}
		if (project.position !== undefined) {
			delete project.position;
			registryChanged = true;
		}
		if (project.parentProjectId !== undefined) {
			delete project.parentProjectId;
			registryChanged = true;
		}
	};

	if (!headquartersProject && serverRootCandidates.length > 0) {
		headquartersProject = serverRootCandidates[0];
		markProjectsBackup();
		repairHeadquarters(headquartersProject);
	}

	if (headquartersProject) {
		repairHeadquarters(headquartersProject);
	}

	if (headquartersProject && serverRootCandidates.length > 0) {
		markProjectsBackup();
		for (const candidate of serverRootCandidates) {
			if (candidate === headquartersProject || candidate.id === HEADQUARTERS_PROJECT_ID) continue;
			projects.delete(candidate.id);
			registryChanged = true;
		}
	}

	if (oldProjectIds.size > 0) {
		for (const project of projects.values()) {
			if (project.parentProjectId && oldProjectIds.has(project.parentProjectId)) {
				if (project.id === HEADQUARTERS_PROJECT_ID) delete project.parentProjectId;
				else project.parentProjectId = HEADQUARTERS_PROJECT_ID;
				registryChanged = true;
			}
		}
	}

	if (registryChanged) {
		markProjectsBackup();
		registrySave(projectRegistry);
		const promotedIds = [...oldProjectIds].join(", ");
		console.log(promotedIds
			? `[migration] Promoted server-root project reference(s) ${promotedIds} to Headquarters`
			: "[migration] Repaired Headquarters project registry record");
	}

	if (oldProjectIds.size > 0) {
		preserveLegacyServerRootBobbitForHeadquarters(centralStateDir, centralConfigDir, serverCwd, oldProjectIds);
		rewriteProjectIdsInJsonTree(centralStateDir, oldProjectIds);
		dropSearchIndexesForHeadquartersMigration(centralStateDir);
		const staleRefs = scanStaleProjectIdReferences(centralStateDir, oldProjectIds);
		if (staleRefs.length > 0) {
			throw new Error(
				`Headquarters project id migration left stale project id references: ${staleRefs.slice(0, 20).join(", ")}`,
			);
		}
	}

	if (headquartersProject || oldProjectIds.size > 0) {
		try {
			fs.mkdirSync(centralStateDir, { recursive: true });
			fs.writeFileSync(path.join(centralStateDir, HEADQUARTERS_ID_MIGRATION_MARKER), new Date().toISOString(), "utf-8");
		} catch (err) {
			console.log(`[migration] Warning: could not write Headquarters id migration marker: ${err}`);
		}
	}

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

	// 1. Already migrated? Headquarters id promotion still ran above because it
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
