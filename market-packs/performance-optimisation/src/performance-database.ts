import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export const PERFORMANCE_SCHEMA_VERSION = 2;
export const PERFORMANCE_DATABASE_FILE = "performance.sqlite";
export const PERFORMANCE_GITIGNORE_FILE = ".gitignore";
export const PERFORMANCE_GITIGNORE_CONTENT = "# Pack-owned runtime data.\n*\n";
export const PERFORMANCE_ACTIVITY_LIMIT = 50;

const MAX_TEXT = 4_000;
const MAX_DESCRIPTION = 12_000;
const MAX_LIST = 100;
const MAX_TRACKED_FILES = 10_000;
const MAX_TRACKED_BYTES = 128 * 1024 * 1024;
const COVERAGE_STATES = new Set(["unscanned", "scanning", "scanned", "stale", "failed"]);
const LEVELS = new Set(["low", "medium", "high"]);
const OUTCOMES = new Set([
	"No improvement found",
	"Improvement doesn’t justify complication",
	"Changes system behaviour",
	"Recommend merging",
	"Abandoned",
]);
const DIRECTIONS = new Set(["higher", "lower"]);
const RUN_KINDS = new Set(["baseline", "candidate"]);

export type CoverageState = "unscanned" | "scanning" | "scanned" | "stale" | "failed";
export type SchedulingState = "open" | "goal-pending" | "active" | "blocked-unmeasurable" | "concluded";
export type Level = "low" | "medium" | "high";
export type Outcome = "No improvement found" | "Improvement doesn’t justify complication" | "Changes system behaviour" | "Recommend merging" | "Abandoned";

export class PerformanceDatabaseError extends Error {
	constructor(readonly code: "INVALID_BINDING" | "OPEN_FAILED" | "CORRUPT_DATABASE" | "NEWER_SCHEMA" | "MIGRATION_FAILED" | "VALIDATION_FAILED" | "CONFLICT" | "NOT_FOUND", message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "PerformanceDatabaseError";
	}
}

export interface PerformanceDatabaseOptions {
	now?: () => string;
	id?: (prefix: string) => string;
	/** Explicit pack-local native binding selected by the build-inlined resolver. */
	nativeBinding?: string;
}

export interface ProgrammeSettingsInput {
	scannerSchedule?: string;
	directorSchedule?: string;
	maxParallelIdeators?: number;
	targetActiveGoals?: number;
	scannerStaffId?: string | null;
	directorStaffId?: string | null;
}

export interface CoverageFile {
	path: string;
	digest: string;
	bytes: number;
}

export interface CoverageRefreshInput {
	revision: string;
	files: CoverageFile[];
}

export interface CoverageInventoryDependencies {
	execGit(args: string[], encoding: "buffer"): Buffer;
	execGit(args: string[], encoding: "utf8"): string;
}

export interface CrossCuttingInput {
	id?: string;
	label: string;
	unitIds?: string[];
	files?: string[];
}

export interface LocationInput {
	scanUnitId?: string;
	file: string;
	symbol?: string;
	lineStart?: number;
	lineEnd?: number;
}

export interface HypothesisInput {
	title?: string;
	description: string;
	improvementTypes: string[];
	confidence: Level;
	impact: Level;
	risk: Level;
	locations: LocationInput[];
	sourceAttemptId?: string;
	observation?: string;
}

export interface HypothesisMergeInput {
	observation: string;
	improvementTypes?: string[];
	locations?: LocationInput[];
	sourceAttemptId?: string;
}

export interface BenchmarkReferenceInput {
	id?: string;
	name: string;
	component: string;
	commandName: string;
	metric: string;
	unit: string;
	direction: "higher" | "lower";
	scanUnitIds?: string[];
	fileGlobs?: string[];
	tags?: string[];
	warmup?: number;
	repetitions?: number;
}

export interface BenchmarkRunInput {
	hypothesisId: string;
	benchmarkId: string;
	kind: "baseline" | "candidate";
	commit: string;
	environment: string;
	metrics: Record<string, number>;
	variability?: Record<string, number>;
	interpretation?: string;
}

export interface OutcomeInput {
	outcome: Outcome;
	rationale: string;
	measurementSummary: string;
	behaviourAssessment: string;
	complexityAssessment: string;
}

export interface ActivityInput {
	actor: string;
	message: string;
	kind?: "info" | "success" | "warning" | "error";
	tab?: "flow" | "coverage" | "registry";
	sessionId?: string;
}

type SqlValue = string | number | bigint | null | Uint8Array;
type Row = Record<string, SqlValue>;

function text(value: unknown, name: string, max = MAX_TEXT): string {
	if (typeof value !== "string" || !value.trim()) throw new PerformanceDatabaseError("VALIDATION_FAILED", `${name} is required`);
	const result = value.trim();
	if (result.length > max || result.includes("\0")) throw new PerformanceDatabaseError("VALIDATION_FAILED", `${name} is invalid or exceeds ${max} characters`);
	return result;
}

function optionalText(value: unknown, name: string, max = MAX_TEXT): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	return text(value, name, max);
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
		throw new PerformanceDatabaseError("VALIDATION_FAILED", `${name} must be an integer from ${minimum} to ${maximum}`);
	}
	return value;
}

function limitOf(value: unknown, fallback = 50, maximum = 100): number {
	return value === undefined ? fallback : boundedInteger(value, "limit", 1, maximum);
}

function stringList(value: unknown, name: string, options: { minimum?: number; maximum?: number; itemMax?: number } = {}): string[] {
	if (!Array.isArray(value)) throw new PerformanceDatabaseError("VALIDATION_FAILED", `${name} must be an array`);
	const minimum = options.minimum ?? 0;
	const maximum = options.maximum ?? MAX_LIST;
	if (value.length < minimum || value.length > maximum) throw new PerformanceDatabaseError("VALIDATION_FAILED", `${name} must contain ${minimum} to ${maximum} items`);
	return [...new Set(value.map((item, index) => text(item, `${name}[${index}]`, options.itemMax ?? 240)))];
}

export function normalizeRepositoryPath(value: unknown, name = "path"): string {
	const candidate = text(value, name, 1_000).replaceAll("\\", "/").replace(/^\.\//, "");
	if (path.posix.isAbsolute(candidate) || /^[A-Za-z]:\//.test(candidate)) throw new PerformanceDatabaseError("VALIDATION_FAILED", `${name} must be repository-relative`);
	const normalized = path.posix.normalize(candidate);
	if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.split("/").includes("..")) {
		throw new PerformanceDatabaseError("VALIDATION_FAILED", `${name} must remain inside the repository`);
	}
	return normalized;
}

function enumValue<T extends string>(value: unknown, name: string, allowed: Set<string>): T {
	const result = text(value, name, 80);
	if (!allowed.has(result)) throw new PerformanceDatabaseError("VALIDATION_FAILED", `${name} is invalid`);
	return result as T;
}

function json(value: unknown): string {
	return JSON.stringify(value);
}

function parseJson<T>(value: unknown, fallback: T): T {
	if (typeof value !== "string") return fallback;
	try { return JSON.parse(value) as T; } catch { return fallback; }
}

function row(value: unknown): Row | undefined {
	return value && typeof value === "object" ? value as Row : undefined;
}

function rows(value: unknown[]): Row[] {
	return value as Row[];
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function canonicalTerms(value: string): string[] {
	return [...new Set(value.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((term) => term.length >= 3))].sort();
}

function structuralGroup(file: string): string {
	const parts = file.split("/");
	if (parts.length === 1) return "root";
	const first = parts[0];
	if (["src", "app", "lib", "packages", "services", "apps"].includes(first) && parts.length > 2) return `${first}/${parts[1]}`;
	return first;
}

function structuralId(group: string): string {
	return `struct-${sha256(group).slice(0, 16)}`;
}

function normalizeBenchmarkGlob(value: string, index: number): string {
	const glob = text(value, `fileGlobs[${index}]`, 300).replace(/\\/g, "/");
	if (glob.startsWith("/") || /^[a-z]:\//i.test(glob) || glob.split("/").includes("..")) {
		throw new PerformanceDatabaseError("VALIDATION_FAILED", `fileGlobs[${index}] must stay repository-relative`);
	}
	return glob.replace(/^\.\//, "");
}

function benchmarkGlobMatches(file: string, glob: string): boolean {
	let expression = "^";
	for (let index = 0; index < glob.length; index += 1) {
		const character = glob[index];
		if (character === "*" && glob[index + 1] === "*") {
			index += 1;
			if (glob[index + 1] === "/") {
				index += 1;
				expression += "(?:.*/)?";
			} else expression += ".*";
		} else if (character === "*") expression += "[^/]*";
		else if (character === "?") expression += "[^/]";
		else expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
	}
	return new RegExp(`${expression}$`).test(file);
}

function hypothesisFingerprint(input: Pick<HypothesisInput, "description" | "improvementTypes" | "locations">): string {
	const locations = input.locations.map(location => `${location.scanUnitId ?? ""}|${normalizeRepositoryPath(location.file)}|${location.symbol?.trim().toLowerCase() ?? ""}`).sort();
	const description = input.description.trim().toLowerCase().replace(/\s+/g, " ");
	return sha256(json({ description, types: [...new Set(input.improvementTypes)].sort(), locations }));
}

function locationKey(location: LocationInput): string {
	return sha256(`${location.scanUnitId ?? ""}|${location.file}|${location.symbol ?? ""}`);
}

function isProductionPath(file: string): boolean {
	const lower = file.toLowerCase();
	const segments = lower.split("/");
	if (segments.some(segment => ["test", "tests", "__tests__", "docs", "doc", "coverage", "dist", "build", "generated", "vendor", "node_modules", ".git", ".bobbit"].includes(segment))) return false;
	if (/(^|\/)(readme|changelog|license)(\.|$)/i.test(file)) return false;
	if (/(^|\/)[^/]+\.(test|spec|bench|benchmark)\.[^/]+$/i.test(file)) return false;
	if (/\.(md|mdx|rst|txt|snap|map|lock|png|jpe?g|gif|svg|ico|pdf|woff2?|ttf|eot)$/i.test(file)) return false;
	return /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|kts|c|cc|cpp|cxx|h|hpp|cs|php|swift|scala|sh|sql|vue|svelte)$/i.test(file);
}

export function inventoryTrackedProductionFiles(cwd: string, dependencies?: CoverageInventoryDependencies): CoverageRefreshInput {
	if (!path.isAbsolute(cwd)) throw new PerformanceDatabaseError("VALIDATION_FAILED", "coverage workspace must be an absolute path");
	const execGit = dependencies?.execGit ?? ((args: string[], encoding: "buffer" | "utf8") => execFileSync("git", args, {
		cwd,
		encoding,
		maxBuffer: encoding === "buffer" ? 16 * 1024 * 1024 : 128 * 1024,
		windowsHide: true,
		stdio: ["ignore", "pipe", "ignore"],
	}) as Buffer & string);
	let output: Buffer;
	let revision = "unborn";
	try {
		output = execGit(["ls-files", "-z", "--cached"], "buffer");
		try { revision = execGit(["rev-parse", "HEAD"], "utf8").trim(); } catch { /* unborn repository */ }
	} catch (cause) {
		throw new PerformanceDatabaseError("VALIDATION_FAILED", "coverage refresh requires a readable Git workspace", { cause });
	}
	const root = fs.realpathSync(cwd);
	const candidates = output.toString("utf8").split("\0").filter(Boolean).map(file => normalizeRepositoryPath(file)).filter(isProductionPath).sort();
	if (candidates.length > MAX_TRACKED_FILES) throw new PerformanceDatabaseError("VALIDATION_FAILED", `coverage inventory exceeds ${MAX_TRACKED_FILES} production files`);
	let totalBytes = 0;
	const files: CoverageFile[] = [];
	for (const file of candidates) {
		const absolute = path.resolve(root, ...file.split("/"));
		const relative = path.relative(root, absolute);
		if (relative.startsWith("..") || path.isAbsolute(relative)) throw new PerformanceDatabaseError("VALIDATION_FAILED", "tracked path escaped the workspace");
		let content: Buffer;
		try {
			const stat = fs.lstatSync(absolute);
			if (!stat.isFile() || stat.isSymbolicLink()) continue;
			const canonical = fs.realpathSync(absolute);
			const canonicalRelative = path.relative(root, canonical);
			if (canonicalRelative.startsWith("..") || path.isAbsolute(canonicalRelative)) continue;
			content = fs.readFileSync(canonical);
		} catch { continue; }
		totalBytes += content.length;
		if (totalBytes > MAX_TRACKED_BYTES) throw new PerformanceDatabaseError("VALIDATION_FAILED", "coverage inventory exceeds the bounded content budget");
		if (content.includes(0)) continue;
		files.push({ path: file, digest: sha256(content), bytes: content.length });
	}
	return { revision: text(revision, "revision", 200), files };
}

const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS programme_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS programme_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  scanner_schedule TEXT,
  director_schedule TEXT,
  max_parallel_ideators INTEGER NOT NULL DEFAULT 2 CHECK (max_parallel_ideators BETWEEN 1 AND 20),
  target_active_goals INTEGER NOT NULL DEFAULT 2 CHECK (target_active_goals BETWEEN 0 AND 50),
  scanner_staff_id TEXT,
  director_staff_id TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scan_units (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('structural','cross-cutting')),
  label TEXT NOT NULL,
  parent_id TEXT REFERENCES scan_units(id) ON DELETE SET NULL,
  fingerprint TEXT NOT NULL,
  current_revision TEXT NOT NULL,
  last_scanned_fingerprint TEXT,
  last_scanned_revision TEXT,
  state TEXT NOT NULL CHECK (state IN ('unscanned','scanning','scanned','stale','failed')),
  definition_json TEXT,
  retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0,1)),
  last_scan_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scan_unit_files (
  scan_unit_id TEXT NOT NULL REFERENCES scan_units(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY(scan_unit_id, path)
);
CREATE INDEX IF NOT EXISTS scan_unit_files_path_idx ON scan_unit_files(path);
CREATE TABLE IF NOT EXISTS scan_attempts (
  id TEXT PRIMARY KEY,
  scan_unit_id TEXT NOT NULL REFERENCES scan_units(id) ON DELETE CASCADE,
  claimed_fingerprint TEXT NOT NULL,
  scanner_staff_id TEXT,
  scanner_session_id TEXT,
  delegate_session_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('claimed','running','completed','failed','cancelled')),
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_scan_attempt ON scan_attempts(scan_unit_id, claimed_fingerprint) WHERE state IN ('claimed','running');
CREATE TABLE IF NOT EXISTS hypotheses (
  id TEXT PRIMARY KEY,
  exact_fingerprint TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  improvement_types_json TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
  impact TEXT NOT NULL CHECK (impact IN ('low','medium','high')),
  risk TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
  scheduling_state TEXT NOT NULL CHECK (scheduling_state IN ('open','proposal-pending','active','blocked-unmeasurable','concluded')),
  proposal_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hypothesis_locations (
  hypothesis_id TEXT NOT NULL REFERENCES hypotheses(id) ON DELETE CASCADE,
  location_key TEXT NOT NULL,
  scan_unit_id TEXT REFERENCES scan_units(id) ON DELETE SET NULL,
  file_path TEXT NOT NULL,
  symbol TEXT,
  line_start INTEGER,
  line_end INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(hypothesis_id, location_key)
);
CREATE INDEX IF NOT EXISTS hypothesis_locations_file_idx ON hypothesis_locations(file_path);
CREATE TABLE IF NOT EXISTS hypothesis_observations (
  id TEXT PRIMARY KEY,
  hypothesis_id TEXT NOT NULL REFERENCES hypotheses(id) ON DELETE CASCADE,
  source_attempt_id TEXT REFERENCES scan_attempts(id) ON DELETE SET NULL,
  observation TEXT NOT NULL,
  locations_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hypothesis_goal_links (
  hypothesis_id TEXT PRIMARY KEY REFERENCES hypotheses(id) ON DELETE CASCADE,
  goal_id TEXT NOT NULL UNIQUE,
  linked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS benchmark_references (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  component TEXT NOT NULL,
  command_name TEXT NOT NULL,
  metric TEXT NOT NULL,
  unit TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('higher','lower')),
  file_globs_json TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  warmup INTEGER,
  repetitions INTEGER,
  stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(component, command_name, metric)
);
CREATE TABLE IF NOT EXISTS benchmark_bindings (
  benchmark_id TEXT NOT NULL REFERENCES benchmark_references(id) ON DELETE CASCADE,
  scan_unit_id TEXT NOT NULL REFERENCES scan_units(id) ON DELETE CASCADE,
  PRIMARY KEY(benchmark_id, scan_unit_id)
);
CREATE TABLE IF NOT EXISTS benchmark_runs (
  id TEXT PRIMARY KEY,
  hypothesis_id TEXT NOT NULL REFERENCES hypotheses(id) ON DELETE CASCADE,
  benchmark_id TEXT NOT NULL REFERENCES benchmark_references(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('baseline','candidate')),
  commit_sha TEXT NOT NULL,
  environment TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  variability_json TEXT NOT NULL,
  interpretation TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hypothesis_outcomes (
  hypothesis_id TEXT PRIMARY KEY REFERENCES hypotheses(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL,
  rationale TEXT NOT NULL,
  measurement_summary TEXT NOT NULL,
  behaviour_assessment TEXT NOT NULL,
  complexity_assessment TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('info','success','warning','error')),
  actor TEXT NOT NULL,
  message TEXT NOT NULL,
  tab TEXT CHECK (tab IN ('flow','coverage','registry')),
  session_id TEXT
);
CREATE INDEX IF NOT EXISTS activity_newest_idx ON activity_events(sequence DESC);
`;

// Schema v1 used proposal-pending/proposal_session_id for disposable proposal
// delegates. Direct Director-owned goal creation supersedes that workflow. Reset
// any unresolved legacy draft claim so it can be scheduled by the Director under
// the new direct-creation protocol. The physical values remain compatible to
// avoid rebuilding the referenced hypotheses table; DTOs expose goal semantics.
const MIGRATION_2 = `
UPDATE hypotheses
SET scheduling_state = 'open', proposal_session_id = NULL, updated_at = CURRENT_TIMESTAMP
WHERE scheduling_state = 'proposal-pending';
`;

export class PerformanceDatabase {
	readonly file: string;
	private readonly db: Database.Database;
	private readonly now: () => string;
	private readonly makeId: (prefix: string) => string;

	constructor(directory: string, options: PerformanceDatabaseOptions = {}) {
		if (typeof directory !== "string" || !directory || !path.isAbsolute(directory) || directory.includes("\0")) {
			throw new PerformanceDatabaseError("INVALID_BINDING", "performance local-data directory is unavailable or invalid");
		}
		this.now = options.now ?? (() => new Date().toISOString());
		this.makeId = options.id ?? (prefix => `${prefix}-${randomUUID()}`);
		try {
			fs.mkdirSync(directory, { recursive: true });
			try {
				fs.writeFileSync(path.join(directory, PERFORMANCE_GITIGNORE_FILE), PERFORMANCE_GITIGNORE_CONTENT, { encoding: "utf8", flag: "wx" });
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
			}
			this.file = path.join(directory, PERFORMANCE_DATABASE_FILE);
			this.db = new Database(this.file, { timeout: 5_000, ...(options.nativeBinding ? { nativeBinding: options.nativeBinding } : {}) });
		} catch (cause) {
			throw new PerformanceDatabaseError("OPEN_FAILED", "performance registry could not be opened", { cause });
		}
		try {
			this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
			const integrity = row(this.db.prepare("PRAGMA quick_check").get());
			if (integrity && String(Object.values(integrity)[0]) !== "ok") throw new PerformanceDatabaseError("CORRUPT_DATABASE", "performance registry failed its integrity check");
			this.migrate();
		} catch (cause) {
			try { this.db.close(); } catch { /* best effort */ }
			if (cause instanceof PerformanceDatabaseError) throw cause;
			const message = cause instanceof Error ? cause.message : String(cause);
			const code = /not a database|malformed|disk image/i.test(message) ? "CORRUPT_DATABASE" : "MIGRATION_FAILED";
			throw new PerformanceDatabaseError(code, code === "CORRUPT_DATABASE" ? "performance registry is corrupt" : "performance registry migration failed", { cause });
		}
	}

	close(): void { this.db.close(); }

	private migrate(): void {
		const hasMigrations = Number(row(this.db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get())?.count ?? 0) > 0;
		let current = 0;
		if (hasMigrations) current = Number(row(this.db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get())?.version ?? 0);
		if (!Number.isSafeInteger(current) || current < 0) throw new PerformanceDatabaseError("CORRUPT_DATABASE", "performance registry has invalid migration metadata");
		if (current > PERFORMANCE_SCHEMA_VERSION) throw new PerformanceDatabaseError("NEWER_SCHEMA", `performance registry schema ${current} is newer than supported schema ${PERFORMANCE_SCHEMA_VERSION}`);
		if (current < 1) {
			this.transaction(() => {
				this.db.exec(MIGRATION_1);
				const at = this.now();
				this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)").run(1, at);
				this.db.prepare("INSERT OR IGNORE INTO programme_meta(singleton, revision, updated_at) VALUES(1, 0, ?)").run(at);
				this.db.prepare("INSERT OR IGNORE INTO programme_settings(singleton, updated_at) VALUES(1, ?)").run(at);
			});
		}
		if (current < 2) {
			this.transaction(() => {
				this.db.exec(MIGRATION_2);
				this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)").run(2, this.now());
			});
		}
	}

	private transaction<T>(operation: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			try { this.db.exec("ROLLBACK"); } catch { /* retain original error */ }
			throw error;
		}
	}

	private visibleChange(activity: ActivityInput): number {
		const at = this.now();
		const kind = activity.kind ?? "info";
		this.db.prepare("UPDATE programme_meta SET revision = revision + 1, updated_at = ? WHERE singleton = 1").run(at);
		this.db.prepare("INSERT INTO activity_events(id, at, kind, actor, message, tab, session_id) VALUES(?, ?, ?, ?, ?, ?, ?)").run(
			this.makeId("activity"), at, kind, text(activity.actor, "activity actor", 120), text(activity.message, "activity message", 500), activity.tab ?? null, optionalText(activity.sessionId, "activity session", 120) ?? null,
		);
		this.db.prepare("DELETE FROM activity_events WHERE sequence NOT IN (SELECT sequence FROM activity_events ORDER BY sequence DESC LIMIT ?)").run(PERFORMANCE_ACTIVITY_LIMIT);
		return this.revision();
	}

	revision(): number {
		return Number(row(this.db.prepare("SELECT revision FROM programme_meta WHERE singleton = 1").get())?.revision ?? 0);
	}

	programmeStatus(): Record<string, unknown> {
		const settings = row(this.db.prepare("SELECT * FROM programme_settings WHERE singleton = 1").get());
		return {
			revision: this.revision(),
			scannerSchedule: settings?.scanner_schedule ?? undefined,
			directorSchedule: settings?.director_schedule ?? undefined,
			maxParallelIdeators: Number(settings?.max_parallel_ideators ?? 2),
			targetActiveGoals: Number(settings?.target_active_goals ?? 2),
			scannerStaffId: settings?.scanner_staff_id ?? undefined,
			directorStaffId: settings?.director_staff_id ?? undefined,
			updatedAt: settings?.updated_at,
		};
	}

	configureProgramme(input: ProgrammeSettingsInput): Record<string, unknown> {
		const current = this.programmeStatus();
		const scannerSchedule = input.scannerSchedule === undefined ? current.scannerSchedule : optionalText(input.scannerSchedule, "scannerSchedule", 200);
		const directorSchedule = input.directorSchedule === undefined ? current.directorSchedule : optionalText(input.directorSchedule, "directorSchedule", 200);
		const maxParallel = input.maxParallelIdeators === undefined ? Number(current.maxParallelIdeators) : boundedInteger(input.maxParallelIdeators, "maxParallelIdeators", 1, 20);
		const target = input.targetActiveGoals === undefined ? Number(current.targetActiveGoals) : boundedInteger(input.targetActiveGoals, "targetActiveGoals", 0, 50);
		const scannerStaff = input.scannerStaffId === undefined ? current.scannerStaffId : input.scannerStaffId === null ? undefined : text(input.scannerStaffId, "scannerStaffId", 120);
		const directorStaff = input.directorStaffId === undefined ? current.directorStaffId : input.directorStaffId === null ? undefined : text(input.directorStaffId, "directorStaffId", 120);
		const revision = this.transaction(() => {
			this.db.prepare(`UPDATE programme_settings SET scanner_schedule=?, director_schedule=?, max_parallel_ideators=?, target_active_goals=?, scanner_staff_id=?, director_staff_id=?, updated_at=? WHERE singleton=1`).run(
				scannerSchedule as string | null ?? null, directorSchedule as string | null ?? null, maxParallel, target, scannerStaff as string | null ?? null, directorStaff as string | null ?? null, this.now(),
			);
			return this.visibleChange({ actor: "Performance programme", message: "Programme settings updated", tab: "flow" });
		});
		return { ...this.programmeStatus(), revision };
	}

	refreshCoverage(input: CoverageRefreshInput): Record<string, unknown> {
		const revisionName = text(input.revision, "revision", 200);
		if (!Array.isArray(input.files) || input.files.length > MAX_TRACKED_FILES) throw new PerformanceDatabaseError("VALIDATION_FAILED", "files exceeds the coverage inventory bound");
		const normalized = input.files.map((file, index) => ({
			path: normalizeRepositoryPath(file?.path, `files[${index}].path`),
			digest: text(file?.digest, `files[${index}].digest`, 128),
			bytes: boundedInteger(file?.bytes, `files[${index}].bytes`, 0, MAX_TRACKED_BYTES),
		}));
		if (new Set(normalized.map(file => file.path)).size !== normalized.length) throw new PerformanceDatabaseError("VALIDATION_FAILED", "coverage files must be unique");
		const groups = new Map<string, CoverageFile[]>();
		for (const file of normalized) {
			const group = structuralGroup(file.path);
			const existing = groups.get(group) ?? [];
			existing.push(file);
			groups.set(group, existing);
		}
		const changed: string[] = [];
		const resultRevision = this.transaction(() => {
			const currentStructural = new Set(rows(this.db.prepare("SELECT id FROM scan_units WHERE kind='structural' AND retired=0").all()).map(item => String(item.id)));
			for (const [group, files] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
				const id = structuralId(group);
				currentStructural.delete(id);
				const fingerprint = sha256(files.sort((a, b) => a.path.localeCompare(b.path)).map(file => `${file.path}\0${file.digest}`).join("\0"));
				const existing = row(this.db.prepare("SELECT fingerprint, last_scanned_fingerprint FROM scan_units WHERE id=?").get(id));
				const state: CoverageState = !existing ? "unscanned" : existing.fingerprint === fingerprint && existing.last_scanned_fingerprint === fingerprint ? "scanned" : existing.fingerprint === fingerprint ? this.unitState(id) : "stale";
				if (!existing || existing.fingerprint !== fingerprint) changed.push(id);
				const now = this.now();
				this.db.prepare(`INSERT INTO scan_units(id,kind,label,fingerprint,current_revision,state,created_at,updated_at) VALUES(?,'structural',?,?,?,?,?,?)
					ON CONFLICT(id) DO UPDATE SET label=excluded.label,fingerprint=excluded.fingerprint,current_revision=excluded.current_revision,state=excluded.state,retired=0,updated_at=excluded.updated_at`).run(id, group, fingerprint, revisionName, state, now, now);
				this.db.prepare("DELETE FROM scan_unit_files WHERE scan_unit_id=?").run(id);
				const insertFile = this.db.prepare("INSERT INTO scan_unit_files(scan_unit_id,path,content_digest,bytes) VALUES(?,?,?,?)");
				for (const file of files) insertFile.run(id, file.path, file.digest, file.bytes);
			}
			for (const removed of currentStructural) {
				changed.push(removed);
				// Retain the unit row so historical attempts and hypothesis locations
				// remain referentially intact, while excluding it from the live map.
				this.db.prepare("UPDATE scan_units SET retired=1,fingerprint=?,current_revision=?,state='stale',updated_at=? WHERE id=?").run(sha256(""), revisionName, this.now(), removed);
				this.db.prepare("DELETE FROM scan_unit_files WHERE scan_unit_id=?").run(removed);
			}
			this.materializeCrossCutting(revisionName, changed);
			return this.visibleChange({ actor: "Optimisation Scanner", message: `Coverage refreshed: ${groups.size} structural units, ${changed.length} changed`, tab: "coverage" });
		});
		return { revision: resultRevision, structuralUnits: groups.size, changedUnitIds: changed.slice(0, MAX_LIST), files: normalized.length };
	}

	private unitState(id: string): CoverageState {
		const value = String(row(this.db.prepare("SELECT state FROM scan_units WHERE id=?").get(id))?.state ?? "unscanned");
		return COVERAGE_STATES.has(value) ? value as CoverageState : "unscanned";
	}

	private materializeCrossCutting(revisionName: string, changed: string[]): void {
		const crossUnits = rows(this.db.prepare("SELECT id, definition_json, fingerprint, last_scanned_fingerprint FROM scan_units WHERE kind='cross-cutting' AND retired=0").all());
		for (const unit of crossUnits) {
			const definition = parseJson<{ unitIds?: string[]; files?: string[] }>(unit.definition_json, {});
			const selected = new Map<string, CoverageFile>();
			for (const unitId of definition.unitIds ?? []) {
				for (const file of rows(this.db.prepare("SELECT path,content_digest,bytes FROM scan_unit_files WHERE scan_unit_id=? ORDER BY path").all(unitId))) {
					selected.set(String(file.path), { path: String(file.path), digest: String(file.content_digest), bytes: Number(file.bytes) });
				}
			}
			for (const filePath of definition.files ?? []) {
				const file = row(this.db.prepare("SELECT path,content_digest,bytes FROM scan_unit_files WHERE path=? ORDER BY scan_unit_id LIMIT 1").get(filePath));
				if (file) selected.set(String(file.path), { path: String(file.path), digest: String(file.content_digest), bytes: Number(file.bytes) });
			}
			const files = [...selected.values()].sort((a, b) => a.path.localeCompare(b.path));
			const fingerprint = sha256(files.map(file => `${file.path}\0${file.digest}`).join("\0"));
			const id = String(unit.id);
			const state = unit.fingerprint === fingerprint && unit.last_scanned_fingerprint === fingerprint ? "scanned" : unit.fingerprint === fingerprint ? this.unitState(id) : "stale";
			if (unit.fingerprint !== fingerprint) changed.push(id);
			this.db.prepare("UPDATE scan_units SET fingerprint=?,current_revision=?,state=?,updated_at=? WHERE id=?").run(fingerprint, revisionName, state, this.now(), id);
			this.db.prepare("DELETE FROM scan_unit_files WHERE scan_unit_id=?").run(id);
			const insert = this.db.prepare("INSERT INTO scan_unit_files(scan_unit_id,path,content_digest,bytes) VALUES(?,?,?,?)");
			for (const file of files) insert.run(id, file.path, file.digest, file.bytes);
		}
	}

	upsertCrossCutting(input: CrossCuttingInput): Record<string, unknown> {
		const label = text(input.label, "label", 180);
		const unitIds = input.unitIds === undefined ? [] : stringList(input.unitIds, "unitIds", { maximum: 50, itemMax: 100 });
		const files = input.files === undefined ? [] : stringList(input.files, "files", { maximum: 200, itemMax: 1_000 }).map((file, index) => normalizeRepositoryPath(file, `files[${index}]`));
		if (unitIds.length === 0 && files.length === 0) throw new PerformanceDatabaseError("VALIDATION_FAILED", "cross-cutting units require unitIds or files");
		for (const unitId of unitIds) {
			const unit = row(this.db.prepare("SELECT kind FROM scan_units WHERE id=? AND retired=0").get(unitId));
			if (!unit || unit.kind !== "structural") throw new PerformanceDatabaseError("VALIDATION_FAILED", `unknown structural unit: ${unitId}`);
		}
		for (const file of files) if (!this.db.prepare("SELECT 1 FROM scan_unit_files WHERE path=? LIMIT 1").get(file)) throw new PerformanceDatabaseError("VALIDATION_FAILED", `unknown production file: ${file}`);
		const id = input.id === undefined ? `cross-${sha256(label.toLowerCase()).slice(0, 16)}` : text(input.id, "id", 100);
		const definition = { unitIds: [...unitIds].sort(), files: [...files].sort() };
		const revision = this.transaction(() => {
			const now = this.now();
			this.db.prepare(`INSERT INTO scan_units(id,kind,label,fingerprint,current_revision,state,definition_json,created_at,updated_at) VALUES(?,'cross-cutting',?,'','definition','unscanned',?,?,?)
				ON CONFLICT(id) DO UPDATE SET label=excluded.label,definition_json=excluded.definition_json,state='stale',updated_at=excluded.updated_at`).run(id, label, json(definition), now, now);
			this.materializeCrossCutting("definition", []);
			return this.visibleChange({ actor: "Optimisation Scanner", message: `Cross-cutting unit updated: ${label}`, tab: "coverage" });
		});
		return { id, revision, ...definition };
	}

	listCoverage(options: { states?: string[]; kinds?: string[]; limit?: number } = {}): Record<string, unknown> {
		const limit = limitOf(options.limit, 50, 100);
		const states = options.states === undefined ? [] : stringList(options.states, "states", { maximum: 5, itemMax: 30 });
		for (const state of states) enumValue(state, "state", COVERAGE_STATES);
		const kinds = options.kinds === undefined ? [] : stringList(options.kinds, "kinds", { maximum: 2, itemMax: 30 });
		for (const kind of kinds) if (!new Set(["structural", "cross-cutting"]).has(kind)) throw new PerformanceDatabaseError("VALIDATION_FAILED", "kind is invalid");
		const clauses: string[] = [];
		const parameters: SqlValue[] = [];
		if (states.length) { clauses.push(`state IN (${states.map(() => "?").join(",")})`); parameters.push(...states); }
		if (kinds.length) { clauses.push(`kind IN (${kinds.map(() => "?").join(",")})`); parameters.push(...kinds); }
		parameters.push(limit);
		clauses.unshift("retired=0");
		const result = rows(this.db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM scan_unit_files f WHERE f.scan_unit_id=u.id) AS file_count FROM scan_units u WHERE ${clauses.join(" AND ")} ORDER BY CASE state WHEN 'stale' THEN 0 WHEN 'unscanned' THEN 1 WHEN 'failed' THEN 2 WHEN 'scanning' THEN 3 ELSE 4 END, kind, label LIMIT ?`).all(...parameters));
		return { revision: this.revision(), items: result.map(item => this.coverageDto(item)) };
	}

	private coverageDto(item: Row): Record<string, unknown> {
		return {
			id: String(item.id), label: String(item.label), kind: String(item.kind), state: String(item.state),
			fingerprint: String(item.fingerprint), currentRevision: String(item.current_revision), fileCount: Number(item.file_count ?? 0),
			lastScannedFingerprint: item.last_scanned_fingerprint ?? undefined, lastScannedRevision: item.last_scanned_revision ?? undefined,
			lastScanAt: item.last_scan_at ?? undefined,
		};
	}

	markCoverage(input: { unitId: string; state: string; attemptId?: string; claimedFingerprint?: string; scannerStaffId?: string; scannerSessionId?: string; delegateSessionId?: string; summary?: string }): Record<string, unknown> {
		const unitId = text(input.unitId, "unitId", 100);
		const target = enumValue<"claimed" | "running" | "completed" | "failed" | "cancelled">(input.state, "state", new Set(["claimed", "running", "completed", "failed", "cancelled"]));
		let unit: Row | undefined;
		let claimedFingerprint = optionalText(input.claimedFingerprint, "claimedFingerprint", 128);
		const now = this.now();
		let attemptId = optionalText(input.attemptId, "attemptId", 100);
		const revision = this.transaction(() => {
			unit = row(this.db.prepare("SELECT * FROM scan_units WHERE id=? AND retired=0").get(unitId));
			if (!unit) throw new PerformanceDatabaseError("NOT_FOUND", `unknown scan unit: ${unitId}`);
			claimedFingerprint ??= String(unit.fingerprint);
			if (target === "claimed") {
				const active = row(this.db.prepare("SELECT id,state FROM scan_attempts WHERE scan_unit_id=? AND claimed_fingerprint=? AND state IN ('claimed','running')").get(unitId, claimedFingerprint));
				if (active) {
					attemptId = String(active.id);
					return this.revision();
				} else {
					attemptId ??= this.makeId("attempt");
					this.db.prepare(`INSERT INTO scan_attempts(id,scan_unit_id,claimed_fingerprint,scanner_staff_id,scanner_session_id,delegate_session_id,state,summary,created_at,updated_at) VALUES(?,?,?,?,?,?,'claimed',?,?,?)`).run(
						attemptId, unitId, claimedFingerprint, optionalText(input.scannerStaffId, "scannerStaffId", 120) ?? null, optionalText(input.scannerSessionId, "scannerSessionId", 120) ?? null, optionalText(input.delegateSessionId, "delegateSessionId", 120) ?? null, optionalText(input.summary, "summary", 1_000) ?? null, now, now,
					);
				}
				this.db.prepare("UPDATE scan_units SET state='scanning',updated_at=? WHERE id=?").run(now, unitId);
			} else {
				if (!attemptId) throw new PerformanceDatabaseError("VALIDATION_FAILED", "attemptId is required for attempt transitions");
				const attempt = row(this.db.prepare("SELECT * FROM scan_attempts WHERE id=? AND scan_unit_id=?").get(attemptId, unitId));
				if (!attempt) throw new PerformanceDatabaseError("NOT_FOUND", `unknown scan attempt: ${attemptId}`);
				const attemptFingerprint = String(attempt.claimed_fingerprint);
				if (input.claimedFingerprint !== undefined && claimedFingerprint !== attemptFingerprint) {
					throw new PerformanceDatabaseError("CONFLICT", "claimedFingerprint does not match the durable scan attempt");
				}
				claimedFingerprint = attemptFingerprint;
				if (["completed", "failed", "cancelled"].includes(target) && attempt.state === target) {
					const incomingSummary = optionalText(input.summary, "summary", 1_000);
					if (incomingSummary !== undefined && incomingSummary !== attempt.summary) throw new PerformanceDatabaseError("CONFLICT", "scan attempt is already terminal with a different summary");
					return this.revision();
				}
				if (target === "running") {
					this.db.prepare("UPDATE scan_attempts SET state='running',delegate_session_id=COALESCE(?,delegate_session_id),summary=COALESCE(?,summary),updated_at=? WHERE id=?").run(optionalText(input.delegateSessionId, "delegateSessionId", 120) ?? null, optionalText(input.summary, "summary", 1_000) ?? null, now, attemptId);
					this.db.prepare("UPDATE scan_units SET state='scanning',updated_at=? WHERE id=?").run(now, unitId);
				} else {
					this.db.prepare("UPDATE scan_attempts SET state=?,summary=COALESCE(?,summary),updated_at=?,completed_at=? WHERE id=?").run(target, optionalText(input.summary, "summary", 1_000) ?? null, now, now, attemptId);
					if (target === "completed" && claimedFingerprint === String(unit.fingerprint)) {
						this.db.prepare("UPDATE scan_units SET state='scanned',last_scanned_fingerprint=?,last_scanned_revision=current_revision,last_scan_at=?,updated_at=? WHERE id=?").run(claimedFingerprint, now, now, unitId);
					} else {
						const nextState = claimedFingerprint !== String(unit.fingerprint) ? "stale" : target === "failed" ? "failed" : "unscanned";
						this.db.prepare("UPDATE scan_units SET state=?,updated_at=? WHERE id=?").run(nextState, now, unitId);
					}
				}
			}
			return this.visibleChange({ actor: "Optimisation Scanner", message: `Scan ${target}: ${String(unit.label)}`, tab: "coverage", sessionId: input.scannerSessionId });
		});
		return { attemptId, unitId, state: target, claimedFingerprint, currentFingerprint: String(unit!.fingerprint), revision };
	}

	listAttempts(options: { activeOnly?: boolean; limit?: number } = {}): Record<string, unknown> {
		const limit = limitOf(options.limit, 50, 100);
		const values = rows(this.db.prepare(`SELECT a.*,u.label,u.fingerprint AS current_fingerprint FROM scan_attempts a JOIN scan_units u ON u.id=a.scan_unit_id ${options.activeOnly === false ? "" : "WHERE a.state IN ('claimed','running')"} ORDER BY a.created_at ASC LIMIT ?`).all(limit));
		return { revision: this.revision(), items: values.map(item => ({
			id: item.id, unitId: item.scan_unit_id, unitLabel: item.label, state: item.state, claimedFingerprint: item.claimed_fingerprint,
			currentFingerprint: item.current_fingerprint, scannerStaffId: item.scanner_staff_id ?? undefined, scannerSessionId: item.scanner_session_id ?? undefined,
			delegateSessionId: item.delegate_session_id ?? undefined, summary: item.summary ?? undefined, createdAt: item.created_at, updatedAt: item.updated_at,
		})) };
	}

	searchHypotheses(input: { query?: string; file?: string; scanUnitId?: string; limit?: number } = {}): Record<string, unknown> {
		const limit = limitOf(input.limit, 20, 50);
		const query = optionalText(input.query, "query", 500);
		const file = input.file === undefined ? undefined : normalizeRepositoryPath(input.file);
		const scanUnitId = optionalText(input.scanUnitId, "scanUnitId", 100);
		const candidates = rows(this.db.prepare(`SELECT h.*, GROUP_CONCAT(l.file_path, char(31)) AS files FROM hypotheses h LEFT JOIN hypothesis_locations l ON l.hypothesis_id=h.id GROUP BY h.id ORDER BY h.updated_at DESC LIMIT 200`).all());
		const queryTerms = query ? canonicalTerms(query) : [];
		const ranked = candidates.flatMap(candidate => {
			const files = typeof candidate.files === "string" && candidate.files ? candidate.files.split(String.fromCharCode(31)) : [];
			const haystack = canonicalTerms(`${String(candidate.title)} ${String(candidate.description)}`);
			const matchesFile = !file || files.includes(file);
			const matchesUnit = !scanUnitId || Boolean(this.db.prepare("SELECT 1 FROM hypothesis_locations WHERE hypothesis_id=? AND scan_unit_id=?").get(candidate.id, scanUnitId));
			if (!matchesFile || !matchesUnit) return [];
			const overlap = queryTerms.length ? queryTerms.filter(term => haystack.includes(term)).length / queryTerms.length : 1;
			if (queryTerms.length && overlap === 0) return [];
			return [{ score: overlap, item: this.hypothesisDto(candidate) }];
		}).sort((left, right) => right.score - left.score || String((left.item as { createdAt?: unknown }).createdAt).localeCompare(String((right.item as { createdAt?: unknown }).createdAt))).slice(0, limit);
		return { revision: this.revision(), items: ranked.map(result => ({ ...result.item, matchScore: result.score })) };
	}

	createHypothesis(raw: HypothesisInput): Record<string, unknown> {
		const input = this.validateHypothesis(raw);
		const exactFingerprint = hypothesisFingerprint(input);
		const existing = row(this.db.prepare("SELECT * FROM hypotheses WHERE exact_fingerprint=?").get(exactFingerprint));
		if (existing) return { created: false, revision: this.revision(), hypothesis: this.hypothesisDto(existing) };
		const id = this.makeId("hyp");
		const now = this.now();
		const revision = this.transaction(() => {
			const raced = row(this.db.prepare("SELECT id FROM hypotheses WHERE exact_fingerprint=?").get(exactFingerprint));
			if (raced) return this.revision();
			this.db.prepare(`INSERT INTO hypotheses(id,exact_fingerprint,title,description,improvement_types_json,confidence,impact,risk,scheduling_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'open',?,?)`).run(
				id, exactFingerprint, input.title, input.description, json(input.improvementTypes), input.confidence, input.impact, input.risk, now, now,
			);
			this.upsertLocations(id, input.locations, now);
			this.insertObservation(id, input.observation ?? input.description, input.locations, input.sourceAttemptId, now);
			return this.visibleChange({ actor: "Performance Ideator", message: `Hypothesis created: ${input.title}`, kind: "success", tab: "registry" });
		});
		const stored = row(this.db.prepare("SELECT * FROM hypotheses WHERE exact_fingerprint=?").get(exactFingerprint))!;
		return { created: String(stored.id) === id, revision, hypothesis: this.hypothesisDto(stored) };
	}

	private validateHypothesis(raw: HypothesisInput): Required<Pick<HypothesisInput, "title" | "description" | "improvementTypes" | "confidence" | "impact" | "risk" | "locations">> & Pick<HypothesisInput, "sourceAttemptId" | "observation"> {
		const description = text(raw.description, "description", MAX_DESCRIPTION);
		const title = optionalText(raw.title, "title", 180) ?? description.split(/[.!?\n]/, 1)[0].slice(0, 180);
		const improvementTypes = stringList(raw.improvementTypes, "improvementTypes", { minimum: 1, maximum: 10, itemMax: 80 }).map(value => value.toLowerCase()).sort();
		if (!Array.isArray(raw.locations) || raw.locations.length < 1 || raw.locations.length > 50) throw new PerformanceDatabaseError("VALIDATION_FAILED", "locations must contain 1 to 50 items");
		const locations = raw.locations.map((location, index) => this.validateLocation(location, index));
		return {
			title, description, improvementTypes,
			confidence: enumValue<Level>(raw.confidence, "confidence", LEVELS), impact: enumValue<Level>(raw.impact, "impact", LEVELS), risk: enumValue<Level>(raw.risk, "risk", LEVELS), locations,
			sourceAttemptId: optionalText(raw.sourceAttemptId, "sourceAttemptId", 100), observation: optionalText(raw.observation, "observation", MAX_DESCRIPTION),
		};
	}

	private validateLocation(location: LocationInput, index: number): LocationInput {
		if (!location || typeof location !== "object") throw new PerformanceDatabaseError("VALIDATION_FAILED", `locations[${index}] is invalid`);
		const lineStart = location.lineStart === undefined ? undefined : boundedInteger(location.lineStart, `locations[${index}].lineStart`, 1, 10_000_000);
		const lineEnd = location.lineEnd === undefined ? undefined : boundedInteger(location.lineEnd, `locations[${index}].lineEnd`, lineStart ?? 1, 10_000_000);
		const scanUnitId = optionalText(location.scanUnitId, `locations[${index}].scanUnitId`, 100);
		if (scanUnitId && !this.db.prepare("SELECT 1 FROM scan_units WHERE id=?").get(scanUnitId)) throw new PerformanceDatabaseError("VALIDATION_FAILED", `unknown scan unit: ${scanUnitId}`);
		return { scanUnitId, file: normalizeRepositoryPath(location.file, `locations[${index}].file`), symbol: optionalText(location.symbol, `locations[${index}].symbol`, 300), lineStart, lineEnd };
	}

	private upsertLocations(hypothesisId: string, locations: LocationInput[], now: string): void {
		const statement = this.db.prepare(`INSERT INTO hypothesis_locations(hypothesis_id,location_key,scan_unit_id,file_path,symbol,line_start,line_end,updated_at) VALUES(?,?,?,?,?,?,?,?)
			ON CONFLICT(hypothesis_id,location_key) DO UPDATE SET scan_unit_id=excluded.scan_unit_id,file_path=excluded.file_path,symbol=excluded.symbol,line_start=excluded.line_start,line_end=excluded.line_end,updated_at=excluded.updated_at`);
		for (const location of locations) statement.run(hypothesisId, locationKey(location), location.scanUnitId ?? null, location.file, location.symbol ?? null, location.lineStart ?? null, location.lineEnd ?? null, now);
	}

	private insertObservation(hypothesisId: string, observation: string, locations: LocationInput[], sourceAttemptId: string | undefined, now: string): void {
		if (sourceAttemptId && !this.db.prepare("SELECT 1 FROM scan_attempts WHERE id=?").get(sourceAttemptId)) throw new PerformanceDatabaseError("VALIDATION_FAILED", `unknown source attempt: ${sourceAttemptId}`);
		this.db.prepare("INSERT INTO hypothesis_observations(id,hypothesis_id,source_attempt_id,observation,locations_json,created_at) VALUES(?,?,?,?,?,?)").run(this.makeId("observation"), hypothesisId, sourceAttemptId ?? null, observation, json(locations), now);
	}

	mergeHypothesis(hypothesisIdValue: string, raw: HypothesisMergeInput): Record<string, unknown> {
		const hypothesisId = text(hypothesisIdValue, "hypothesisId", 100);
		const hypothesis = row(this.db.prepare("SELECT * FROM hypotheses WHERE id=?").get(hypothesisId));
		if (!hypothesis) throw new PerformanceDatabaseError("NOT_FOUND", `unknown hypothesis: ${hypothesisId}`);
		const observation = text(raw.observation, "observation", MAX_DESCRIPTION);
		const locations = raw.locations === undefined ? [] : raw.locations.map((location, index) => this.validateLocation(location, index));
		const addedTypes = raw.improvementTypes === undefined ? [] : stringList(raw.improvementTypes, "improvementTypes", { maximum: 10, itemMax: 80 }).map(value => value.toLowerCase());
		const types = [...new Set([...parseJson<string[]>(hypothesis.improvement_types_json, []), ...addedTypes])].sort();
		const revision = this.transaction(() => {
			const now = this.now();
			this.upsertLocations(hypothesisId, locations, now);
			this.insertObservation(hypothesisId, observation, locations, optionalText(raw.sourceAttemptId, "sourceAttemptId", 100), now);
			this.db.prepare("UPDATE hypotheses SET improvement_types_json=?,updated_at=? WHERE id=?").run(json(types), now, hypothesisId);
			return this.visibleChange({ actor: "Performance Ideator", message: `Hypothesis observation merged: ${String(hypothesis.title)}`, tab: "registry" });
		});
		return { revision, hypothesis: this.hypothesisById(hypothesisId) };
	}

	private hypothesisDto(item: Row): Record<string, unknown> {
		const id = String(item.id);
		const goal = row(this.db.prepare("SELECT goal_id FROM hypothesis_goal_links WHERE hypothesis_id=?").get(id));
		const outcome = row(this.db.prepare("SELECT outcome,recorded_at FROM hypothesis_outcomes WHERE hypothesis_id=?").get(id));
		const observationCount = Number(row(this.db.prepare("SELECT COUNT(*) AS count FROM hypothesis_observations WHERE hypothesis_id=?").get(id))?.count ?? 0);
		const storedSchedulingState = String(item.scheduling_state);
		return {
			id, title: String(item.title), description: String(item.description), improvementTypes: parseJson(item.improvement_types_json, []),
			confidence: String(item.confidence), impact: String(item.impact), risk: String(item.risk),
			schedulingState: storedSchedulingState === "proposal-pending" ? "goal-pending" : storedSchedulingState,
			goalClaimSessionId: item.proposal_session_id ?? undefined, goalId: goal?.goal_id ?? undefined, outcome: outcome?.outcome ?? undefined,
			observationCount, createdAt: item.created_at, updatedAt: item.updated_at,
		};
	}

	hypothesisById(hypothesisId: string): Record<string, unknown> {
		const item = row(this.db.prepare("SELECT * FROM hypotheses WHERE id=?").get(hypothesisId));
		if (!item) throw new PerformanceDatabaseError("NOT_FOUND", `unknown hypothesis: ${hypothesisId}`);
		return this.hypothesisDto(item);
	}

	highestPriority(limitValue?: number): Record<string, unknown> {
		const limit = limitOf(limitValue, 10, 50);
		const values = rows(this.db.prepare(`SELECT * FROM hypotheses WHERE scheduling_state='open' ORDER BY CASE risk WHEN 'low' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, CASE impact WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at ASC, id ASC LIMIT ?`).all(limit));
		return { revision: this.revision(), items: values.map(value => this.hypothesisDto(value)) };
	}

	markGoalCreation(hypothesisIdValue: string, stateValue: string, directorSessionIdValue: string, summaryValue?: string): Record<string, unknown> {
		const hypothesisId = text(hypothesisIdValue, "hypothesisId", 100);
		const state = enumValue<"claimed" | "released">(stateValue, "state", new Set(["claimed", "released"]));
		const directorSessionId = text(directorSessionIdValue, "directorSessionId", 120);
		const summary = optionalText(summaryValue, "summary", 1_000);
		const revision = this.transaction(() => {
			if (state === "claimed") {
				const result = this.db.prepare("UPDATE hypotheses SET scheduling_state='proposal-pending',proposal_session_id=?,updated_at=? WHERE id=? AND scheduling_state='open'").run(directorSessionId, this.now(), hypothesisId);
				if (Number(result.changes) !== 1) {
					const current = row(this.db.prepare("SELECT scheduling_state,proposal_session_id FROM hypotheses WHERE id=?").get(hypothesisId));
					if (current?.scheduling_state === "proposal-pending" && current.proposal_session_id === directorSessionId) return this.revision();
					throw new PerformanceDatabaseError("CONFLICT", "hypothesis is not open for goal creation");
				}
				return this.visibleChange({ actor: "Optimisation Director", message: `Hypothesis claimed for direct goal creation: ${hypothesisId}`, tab: "registry", sessionId: directorSessionId });
			}

			const result = this.db.prepare("UPDATE hypotheses SET scheduling_state='open',proposal_session_id=NULL,updated_at=? WHERE id=? AND scheduling_state='proposal-pending' AND proposal_session_id=?").run(this.now(), hypothesisId, directorSessionId);
			if (Number(result.changes) !== 1) throw new PerformanceDatabaseError("CONFLICT", "goal creation claim is not owned by this Director session");
			return this.visibleChange({ actor: "Optimisation Director", message: summary ? `Goal creation claim released: ${summary}` : `Goal creation claim released: ${hypothesisId}`, kind: "warning", tab: "registry", sessionId: directorSessionId });
		});
		return { revision, hypothesis: this.hypothesisById(hypothesisId) };
	}

	linkGoal(hypothesisIdValue: string, goalIdValue: string): Record<string, unknown> {
		const hypothesisId = text(hypothesisIdValue, "hypothesisId", 100);
		const goalId = text(goalIdValue, "goalId", 120);
		if (!this.db.prepare("SELECT 1 FROM hypotheses WHERE id=?").get(hypothesisId)) throw new PerformanceDatabaseError("NOT_FOUND", `unknown hypothesis: ${hypothesisId}`);
		const revision = this.transaction(() => {
			const existingHypothesisLink = row(this.db.prepare("SELECT goal_id FROM hypothesis_goal_links WHERE hypothesis_id=?").get(hypothesisId));
			if (existingHypothesisLink?.goal_id === goalId) return this.revision();
			if (existingHypothesisLink) throw new PerformanceDatabaseError("CONFLICT", "hypothesis is already linked to another goal");
			const existingGoalLink = row(this.db.prepare("SELECT hypothesis_id FROM hypothesis_goal_links WHERE goal_id=?").get(goalId));
			if (existingGoalLink) throw new PerformanceDatabaseError("CONFLICT", "goal is already linked to another hypothesis");
			this.db.prepare("INSERT INTO hypothesis_goal_links(hypothesis_id,goal_id,linked_at) VALUES(?,?,?)").run(hypothesisId, goalId, this.now());
			this.db.prepare("UPDATE hypotheses SET scheduling_state='active',proposal_session_id=NULL,updated_at=? WHERE id=?").run(this.now(), hypothesisId);
			return this.visibleChange({ actor: "Optimisation Director", message: `Performance goal linked: ${goalId}`, kind: "success", tab: "flow" });
		});
		return { revision, hypothesisId, goalId };
	}

	recordOutcome(hypothesisIdValue: string, raw: OutcomeInput): Record<string, unknown> {
		const hypothesisId = text(hypothesisIdValue, "hypothesisId", 100);
		if (!this.db.prepare("SELECT 1 FROM hypotheses WHERE id=?").get(hypothesisId)) throw new PerformanceDatabaseError("NOT_FOUND", `unknown hypothesis: ${hypothesisId}`);
		const input = {
			outcome: enumValue<Outcome>(raw.outcome, "outcome", OUTCOMES), rationale: text(raw.rationale, "rationale", MAX_DESCRIPTION),
			measurementSummary: text(raw.measurementSummary, "measurementSummary", MAX_DESCRIPTION), behaviourAssessment: text(raw.behaviourAssessment, "behaviourAssessment", MAX_DESCRIPTION),
			complexityAssessment: text(raw.complexityAssessment, "complexityAssessment", MAX_DESCRIPTION),
		};
		const prior = row(this.db.prepare("SELECT * FROM hypothesis_outcomes WHERE hypothesis_id=?").get(hypothesisId));
		if (prior && prior.outcome === input.outcome && prior.rationale === input.rationale && prior.measurement_summary === input.measurementSummary && prior.behaviour_assessment === input.behaviourAssessment && prior.complexity_assessment === input.complexityAssessment) {
			return { revision: this.revision(), idempotent: true, hypothesisId, outcome: input.outcome };
		}
		if (prior) throw new PerformanceDatabaseError("CONFLICT", "a different terminal outcome is already recorded");
		const revision = this.transaction(() => {
			this.db.prepare("INSERT INTO hypothesis_outcomes(hypothesis_id,outcome,rationale,measurement_summary,behaviour_assessment,complexity_assessment,recorded_at) VALUES(?,?,?,?,?,?,?)").run(hypothesisId, input.outcome, input.rationale, input.measurementSummary, input.behaviourAssessment, input.complexityAssessment, this.now());
			this.db.prepare("UPDATE hypotheses SET scheduling_state='concluded',updated_at=? WHERE id=?").run(this.now(), hypothesisId);
			return this.visibleChange({ actor: "Performance Team Lead", message: `Outcome recorded: ${input.outcome}`, kind: input.outcome === "Recommend merging" ? "success" : "warning", tab: "registry" });
		});
		return { revision, idempotent: false, hypothesisId, outcome: input.outcome };
	}

	registerBenchmark(raw: BenchmarkReferenceInput): Record<string, unknown> {
		const name = text(raw.name, "name", 180);
		const component = text(raw.component, "component", 180);
		const commandName = text(raw.commandName, "commandName", 180);
		if (/\s|[;&|`$<>]/.test(commandName)) throw new PerformanceDatabaseError("VALIDATION_FAILED", "commandName must identify a named project command, not shell text");
		const metric = text(raw.metric, "metric", 120);
		const unit = text(raw.unit, "unit", 80);
		const direction = enumValue<"higher" | "lower">(raw.direction, "direction", DIRECTIONS);
		const scanUnitIds = raw.scanUnitIds === undefined ? [] : stringList(raw.scanUnitIds, "scanUnitIds", { maximum: 50, itemMax: 100 });
		for (const unitId of scanUnitIds) if (!this.db.prepare("SELECT 1 FROM scan_units WHERE id=?").get(unitId)) throw new PerformanceDatabaseError("VALIDATION_FAILED", `unknown scan unit: ${unitId}`);
		const fileGlobs = raw.fileGlobs === undefined ? [] : stringList(raw.fileGlobs, "fileGlobs", { maximum: 50, itemMax: 300 }).map(normalizeBenchmarkGlob);
		const tags = raw.tags === undefined ? [] : stringList(raw.tags, "tags", { maximum: 50, itemMax: 80 });
		const warmup = raw.warmup === undefined ? undefined : boundedInteger(raw.warmup, "warmup", 0, 1_000);
		const repetitions = raw.repetitions === undefined ? undefined : boundedInteger(raw.repetitions, "repetitions", 1, 10_000);
		const existing = row(this.db.prepare("SELECT id FROM benchmark_references WHERE component=? AND command_name=? AND metric=?").get(component, commandName, metric));
		const id = existing ? String(existing.id) : raw.id === undefined ? this.makeId("benchmark") : text(raw.id, "id", 100);
		const revision = this.transaction(() => {
			const now = this.now();
			this.db.prepare(`INSERT INTO benchmark_references(id,name,component,command_name,metric,unit,direction,file_globs_json,tags_json,warmup,repetitions,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
				ON CONFLICT(component,command_name,metric) DO UPDATE SET name=excluded.name,unit=excluded.unit,direction=excluded.direction,file_globs_json=excluded.file_globs_json,tags_json=excluded.tags_json,warmup=excluded.warmup,repetitions=excluded.repetitions,stale=0,updated_at=excluded.updated_at`).run(id, name, component, commandName, metric, unit, direction, json(fileGlobs), json(tags), warmup ?? null, repetitions ?? null, now, now);
			const resolved = String(row(this.db.prepare("SELECT id FROM benchmark_references WHERE component=? AND command_name=? AND metric=?").get(component, commandName, metric))!.id);
			this.db.prepare("DELETE FROM benchmark_bindings WHERE benchmark_id=?").run(resolved);
			for (const unitId of scanUnitIds) this.db.prepare("INSERT INTO benchmark_bindings(benchmark_id,scan_unit_id) VALUES(?,?)").run(resolved, unitId);
			const blockedLocations = rows(this.db.prepare("SELECT h.id,l.scan_unit_id,l.file_path FROM hypotheses h JOIN hypothesis_locations l ON l.hypothesis_id=h.id WHERE h.scheduling_state='blocked-unmeasurable'").all());
			const applicableBlockedIds = new Set(blockedLocations.flatMap(location => {
				const bound = location.scan_unit_id && scanUnitIds.includes(String(location.scan_unit_id));
				const matchesFile = fileGlobs.some(glob => benchmarkGlobMatches(String(location.file_path), glob));
				return bound || matchesFile ? [String(location.id)] : [];
			}));
			for (const hypothesisId of applicableBlockedIds) this.db.prepare("UPDATE hypotheses SET scheduling_state='open',updated_at=? WHERE id=?").run(now, hypothesisId);
			return this.visibleChange({ actor: "Performance programme", message: `Benchmark registered: ${name}`, tab: "flow" });
		});
		return { revision, benchmark: this.benchmarkById(id) };
	}

	benchmarkById(idValue: string): Record<string, unknown> {
		const id = text(idValue, "benchmarkId", 100);
		const item = row(this.db.prepare("SELECT * FROM benchmark_references WHERE id=?").get(id));
		if (!item) throw new PerformanceDatabaseError("NOT_FOUND", `unknown benchmark: ${id}`);
		const bindings = rows(this.db.prepare("SELECT scan_unit_id FROM benchmark_bindings WHERE benchmark_id=? ORDER BY scan_unit_id").all(id)).map(value => String(value.scan_unit_id));
		return { id, name: item.name, component: item.component, commandName: item.command_name, metric: item.metric, unit: item.unit, direction: item.direction, scanUnitIds: bindings, fileGlobs: parseJson(item.file_globs_json, []), tags: parseJson(item.tags_json, []), warmup: item.warmup ?? undefined, repetitions: item.repetitions ?? undefined, stale: Number(item.stale) === 1 };
	}

	listBenchmarks(input: { hypothesisId?: string; scanUnitId?: string; limit?: number } = {}): Record<string, unknown> {
		const limit = limitOf(input.limit, 50, 100);
		let scanUnitIds: string[] = [];
		let hypothesisFiles: string[] = [];
		if (input.hypothesisId) {
			const locations = rows(this.db.prepare("SELECT scan_unit_id,file_path FROM hypothesis_locations WHERE hypothesis_id=?").all(text(input.hypothesisId, "hypothesisId", 100)));
			scanUnitIds = locations.flatMap(item => item.scan_unit_id ? [String(item.scan_unit_id)] : []);
			hypothesisFiles = locations.map(item => String(item.file_path));
		}
		if (input.scanUnitId) scanUnitIds.push(text(input.scanUnitId, "scanUnitId", 100));
		const values = rows(this.db.prepare("SELECT r.id FROM benchmark_references r WHERE r.stale=0 ORDER BY r.name,r.id").all());
		const items = values.map(value => this.benchmarkById(String(value.id)) as { scanUnitIds: string[]; fileGlobs: string[] }).filter(item => {
			if (!input.hypothesisId && !input.scanUnitId) return true;
			if (item.scanUnitIds.some(unitId => scanUnitIds.includes(unitId))) return true;
			return Boolean(input.hypothesisId && item.fileGlobs.some(glob => hypothesisFiles.some(file => benchmarkGlobMatches(file, glob))));
		}).slice(0, limit);
		return { revision: this.revision(), items };
	}

	recordBenchmarkRun(raw: BenchmarkRunInput): Record<string, unknown> {
		const hypothesisId = text(raw.hypothesisId, "hypothesisId", 100);
		const benchmarkId = text(raw.benchmarkId, "benchmarkId", 100);
		if (!this.db.prepare("SELECT 1 FROM hypotheses WHERE id=?").get(hypothesisId)) throw new PerformanceDatabaseError("NOT_FOUND", `unknown hypothesis: ${hypothesisId}`);
		if (!this.db.prepare("SELECT 1 FROM benchmark_references WHERE id=? AND stale=0").get(benchmarkId)) throw new PerformanceDatabaseError("NOT_FOUND", `unknown or stale benchmark: ${benchmarkId}`);
		const kind = enumValue<"baseline" | "candidate">(raw.kind, "kind", RUN_KINDS);
		const commit = text(raw.commit, "commit", 200);
		const environment = text(raw.environment, "environment", MAX_DESCRIPTION);
		const metrics = this.numericMap(raw.metrics, "metrics", true);
		const variability = this.numericMap(raw.variability ?? {}, "variability", false);
		const interpretation = optionalText(raw.interpretation, "interpretation", MAX_DESCRIPTION);
		const id = this.makeId("run");
		const revision = this.transaction(() => {
			this.db.prepare("INSERT INTO benchmark_runs(id,hypothesis_id,benchmark_id,kind,commit_sha,environment,metrics_json,variability_json,interpretation,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, hypothesisId, benchmarkId, kind, commit, environment, json(metrics), json(variability), interpretation ?? null, this.now());
			return this.visibleChange({ actor: "Performance Team Lead", message: `${kind === "baseline" ? "Baseline" : "Candidate"} benchmark recorded`, tab: "flow" });
		});
		return { id, revision, hypothesisId, benchmarkId, kind };
	}

	private numericMap(value: unknown, name: string, required: boolean): Record<string, number> {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new PerformanceDatabaseError("VALIDATION_FAILED", `${name} must be an object`);
		const entries = Object.entries(value as Record<string, unknown>);
		if ((required && entries.length === 0) || entries.length > 50) throw new PerformanceDatabaseError("VALIDATION_FAILED", `${name} must contain ${required ? "1 to" : "at most"} 50 values`);
		const result: Record<string, number> = {};
		for (const [key, metric] of entries) {
			const cleanKey = text(key, `${name} key`, 120);
			if (typeof metric !== "number" || !Number.isFinite(metric)) throw new PerformanceDatabaseError("VALIDATION_FAILED", `${name}.${cleanKey} must be finite`);
			result[cleanKey] = metric;
		}
		return result;
	}

	activity(limitValue?: number): Record<string, unknown> {
		const limit = limitOf(limitValue, PERFORMANCE_ACTIVITY_LIMIT, PERFORMANCE_ACTIVITY_LIMIT);
		const values = rows(this.db.prepare("SELECT * FROM activity_events ORDER BY sequence DESC LIMIT ?").all(limit));
		return { revision: this.revision(), items: values.map(item => ({ id: item.id, at: item.at, kind: item.kind, actor: item.actor, message: item.message, tab: item.tab ?? undefined, sessionId: item.session_id ?? undefined })) };
	}

	snapshot(): Record<string, unknown> {
		const settings = this.programmeStatus();
		const coverageRows = rows(this.db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM scan_unit_files f WHERE f.scan_unit_id=u.id) AS file_count FROM scan_units u WHERE retired=0 ORDER BY kind,label LIMIT 100`).all());
		const hypothesisRows = rows(this.db.prepare(`
			SELECT h.*,
				(SELECT a.delegate_session_id
				 FROM hypothesis_observations o
				 JOIN scan_attempts a ON a.id=o.source_attempt_id
				 WHERE o.hypothesis_id=h.id AND a.delegate_session_id IS NOT NULL
				 ORDER BY o.created_at DESC,o.id DESC LIMIT 1) AS source_session_id
			FROM hypotheses h ORDER BY h.updated_at DESC,h.id LIMIT 100
		`).all());
		const activities = (this.activity(PERFORMANCE_ACTIVITY_LIMIT).items as Record<string, unknown>[]);
		const attempts = (this.listAttempts({ activeOnly: false, limit: 50 }).items as Record<string, unknown>[]);
		const observations = rows(this.db.prepare("SELECT id,hypothesis_id,source_attempt_id,observation,created_at FROM hypothesis_observations ORDER BY created_at DESC,id DESC LIMIT 100").all()).map(item => ({ id: item.id, hypothesisId: item.hypothesis_id, sourceAttemptId: item.source_attempt_id ?? undefined, observation: item.observation, createdAt: item.created_at }));
		const benchmarkRuns = rows(this.db.prepare("SELECT id,hypothesis_id,benchmark_id,kind,commit_sha,metrics_json,variability_json,interpretation,created_at FROM benchmark_runs ORDER BY created_at DESC,id DESC LIMIT 100").all()).map(item => ({ id: item.id, hypothesisId: item.hypothesis_id, benchmarkId: item.benchmark_id, kind: item.kind, commit: item.commit_sha, metrics: parseJson(item.metrics_json, {}), variability: parseJson(item.variability_json, {}), interpretation: item.interpretation ?? undefined, createdAt: item.created_at }));
		const outcomes = rows(this.db.prepare("SELECT * FROM hypothesis_outcomes ORDER BY recorded_at DESC,hypothesis_id LIMIT 100").all()).map(item => ({ hypothesisId: item.hypothesis_id, outcome: item.outcome, rationale: item.rationale, measurementSummary: item.measurement_summary, behaviourAssessment: item.behaviour_assessment, complexityAssessment: item.complexity_assessment, recordedAt: item.recorded_at }));
		const activeAttempts = Number(row(this.db.prepare("SELECT COUNT(*) AS count FROM scan_attempts WHERE state IN ('claimed','running')").get())?.count ?? 0);
		const completedLast24h = Number(row(this.db.prepare("SELECT COUNT(*) AS count FROM scan_attempts WHERE state='completed' AND completed_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')").get())?.count ?? 0);
		const newest = activities[0];
		const coverage = coverageRows.map(item => ({
			id: item.id, label: item.label, kind: item.kind === "cross-cutting" ? "Cross-cutting" : "Structural", state: item.state === "scanned" ? "scanned" : item.state === "stale" ? "stale" : "awaiting",
			covered: item.state === "scanned" ? Number(item.file_count) : 0, total: Number(item.file_count), lastScan: item.last_scan_at ?? undefined,
			detail: `${Number(item.file_count)} production files`, children: [],
		}));
		const registry = hypothesisRows.map(item => {
			const dto = this.hypothesisDto(item);
			const confidence = item.confidence === "high" ? 0.9 : item.confidence === "medium" ? 0.6 : 0.3;
			return { id: dto.id, title: dto.title, status: dto.schedulingState, confidence, workload: `${String(item.risk)} risk · ${String(item.impact)} impact`, summary: item.description, evidence: `${String(dto.observationCount)} observations${dto.outcome ? ` · ${String(dto.outcome)}` : ""}`, lastEvidence: item.updated_at, sessionId: item.source_session_id ?? undefined };
		});
		const goals = hypothesisRows.flatMap(item => {
			const dto = this.hypothesisDto(item);
			return dto.goalId ? [{ id: dto.goalId, label: item.title, detail: dto.schedulingState }] : [];
		});
		const meta = row(this.db.prepare("SELECT updated_at FROM programme_meta WHERE singleton=1").get());
		return {
			version: 1, revision: this.revision(), updatedAt: meta?.updated_at ?? settings.updatedAt,
			programme: settings,
			scanner: { state: activeAttempts > 0 ? "active" : "idle", activeScans: activeAttempts, completedLast24h, activity: newest?.message, lastActivity: newest?.at },
			director: { state: "idle", activeAgents: Number(row(this.db.prepare("SELECT COUNT(*) AS count FROM hypotheses WHERE scheduling_state='proposal-pending'").get())?.count ?? 0), detail: "Registry-backed optimisation programme", sessions: [] },
			registry, goals, pullRequests: [], coverage, attempts, observations, activity: activities,
			benchmarks: (this.listBenchmarks({ limit: 100 }).items as unknown[]), benchmarkRuns, outcomes,
		};
	}

	/** Narrow diagnostic seam for deterministic migration/invariant tests. */
	unsafeStatementForTests(sql: string): Database.Statement { return this.db.prepare(sql); }
}

export function openPerformanceDatabase(directory: string, options?: PerformanceDatabaseOptions): PerformanceDatabase {
	return new PerformanceDatabase(directory, options);
}
