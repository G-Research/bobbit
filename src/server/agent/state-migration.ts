import fs from "node:fs";
import path from "node:path";
import type { ProjectRegistry, RegisteredProject } from "./project-registry.js";
import type { PersistedGoal } from "./goal-store.js";
import type { PersistedSession } from "./session-store.js";
import type { PersistedStaff } from "./staff-store.js";
import type { PersistedTask } from "./task-store.js";
import type { PersistedTeamEntry } from "./team-store.js";
import type { GateState } from "./gate-store.js";

const MIGRATION_MARKER = ".migrated-to-per-project";
const PRE_MIGRATION_SUFFIX = ".pre-migration";

/**
 * One-time migration from centralized state (`<server-cwd>/.bobbit/state/`)
 * to per-project state (`<project-root>/.bobbit/state/`).
 *
 * Distributes goals, sessions, tasks, teams, gates, and staff to the
 * correct project's state directory based on `projectId` tags.
 * Records without a `projectId` go to the default project.
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
): void {
	const markerPath = path.join(centralStateDir, MIGRATION_MARKER);

	// 1. Already migrated?
	if (fs.existsSync(markerPath)) return;

	const projects = projectRegistry.list();
	if (projects.length === 0) {
		// No projects registered — nothing to migrate to
		return;
	}

	// Find the default project: prefer the one at serverCwd, else first registered
	const defaultProject =
		projectRegistry.getByPath(serverCwd) ?? projects[0];

	console.log(
		`[migration] Starting per-project state migration. Default project: "${defaultProject.name}" (${defaultProject.id})`,
	);

	// Helper: resolve project for a given projectId
	const resolveProject = (projectId?: string): RegisteredProject => {
		if (projectId) {
			const p = projectRegistry.get(projectId);
			if (p) return p;
		}
		return defaultProject;
	};

	// Helper: ensure <project>/.bobbit/state/ exists
	const ensureProjectStateDir = (project: RegisteredProject): string => {
		const dir = path.join(project.rootPath, ".bobbit", "state");
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	};

	// Helper: read a JSON array file, return empty array if missing/corrupt
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

	// Helper: merge items into an existing JSON array file by ID field, write back
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

	// Helper: safely rename a file with .pre-migration suffix
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
		const stateDir = ensureProjectStateDir(project);
		mergeAndWrite(path.join(stateDir, "goals.json"), goals, "id");
	}
	console.log(`[migration] Distributed ${centralGoals.length} goals across ${goalsByProject.size} project(s)`);

	// ── 3. Sessions ──
	const centralSessionsFile = path.join(centralStateDir, "sessions.json");
	const centralSessions = readJsonArray<PersistedSession>(centralSessionsFile);
	const sessionsByProject = new Map<string, PersistedSession[]>();

	for (const session of centralSessions) {
		const project = resolveProject(session.projectId);
		let bucket = sessionsByProject.get(project.id);
		if (!bucket) {
			bucket = [];
			sessionsByProject.set(project.id, bucket);
		}
		bucket.push(session);
	}

	for (const [projectId, sessions] of sessionsByProject) {
		const project = projectRegistry.get(projectId)!;
		const stateDir = ensureProjectStateDir(project);
		mergeAndWrite(path.join(stateDir, "sessions.json"), sessions, "id");
	}
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
		const stateDir = ensureProjectStateDir(project);
		mergeAndWrite(path.join(stateDir, "tasks.json"), tasks, "id");
	}
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
		const stateDir = ensureProjectStateDir(project);
		mergeAndWrite(path.join(stateDir, "team-state.json"), teams, "goalId");
	}
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
		const stateDir = ensureProjectStateDir(project);
		// Gates use composite key (goalId::gateId), so merge with a custom approach
		const targetFile = path.join(stateDir, "gates.json");
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
	console.log(`[migration] Distributed ${centralGates.length} gate states`);

	// ── 7. Staff — no projectId, all go to default project ──
	const centralStaffFile = path.join(centralStateDir, "staff.json");
	const centralStaff = readJsonArray<PersistedStaff>(centralStaffFile);
	if (centralStaff.length > 0) {
		const stateDir = ensureProjectStateDir(defaultProject);
		mergeAndWrite(path.join(stateDir, "staff.json"), centralStaff, "id");
		console.log(`[migration] Moved ${centralStaff.length} staff agents to default project`);
	}

	// ── 8. Rename central files for backup ──
	// Skip renaming when the central state dir IS the default project's state dir
	// (same physical path). Renaming would delete the per-project file we just wrote.
	const defaultProjectStateDir = path.resolve(
		path.join(defaultProject.rootPath, ".bobbit", "state"),
	);
	const centralResolved = path.resolve(centralStateDir);
	if (centralResolved !== defaultProjectStateDir) {
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
