import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type AgentDirSource = "BOBBIT_AGENT_DIR" | "persisted" | "default";

export interface AgentDirResolution {
	dir: string;
	source: AgentDirSource;
	raw?: string;
	projectRoot: string;
	defaultDir: string;
}

export interface AgentDirRuntimeState {
	startup: AgentDirResolution;
	persisted?: string;
	nextStart: AgentDirResolution;
	restartRequired: boolean;
	history: string[];
}

export type AgentDirValidationErrorCode = "EMPTY_PATH" | "INSIDE_WORKTREE" | "CREATE_FAILED" | "NOT_DIRECTORY" | "ACCESS_DENIED" | "PROBE_FAILED";

export interface AgentDirValidationError {
	code: AgentDirValidationErrorCode;
	message: string;
	rawInput: string;
	resolvedPath?: string;
}

export type AgentDirValidationResult =
	| { ok: true; resolvedPath: string }
	| { ok: false; resolvedPath?: string; error: AgentDirValidationError };

export interface AgentDirApiState {
	activePath: string;
	activeSource: AgentDirSource;
	startup: AgentDirResolution;
	defaultPath: string;
	persistedPath?: string;
	pendingPath?: string;
	nextStart: AgentDirResolution;
	restartRequired: boolean;
	envOverride?: {
		active: true;
		source: "BOBBIT_AGENT_DIR";
		value: string;
		savedPathIgnored: boolean;
	};
	history: string[];
}

export type AgentDirMigrationErrorCode = "SAME_PATH" | "DESTINATION_INSIDE_SOURCE" | "SOURCE_INSIDE_DESTINATION" | "DESTINATION_SYMLINK";

export interface AgentDirMigrationReport {
	sourcePath: string;
	destinationPath: string;
	overwrite: boolean;
	copied: string[];
	skipped: string[];
	overwritten: string[];
	missing: string[];
	warnings: string[];
	errors: string[];
	error?: { code: AgentDirMigrationErrorCode; message: string };
}

interface ResolveAgentDirInput {
	env?: NodeJS.ProcessEnv;
	projectRoot: string;
	persisted?: string;
}

interface RuntimeInitInput extends ResolveAgentDirInput {
	stateDir: string;
}

let runtimeState: AgentDirRuntimeState | undefined;
let runtimeStateDir: string | undefined;
let inMemoryAgentDirHistory: string[] = [];

const PREFERENCE_AGENT_DIR = "agentDir";
const PREFERENCE_AGENT_DIR_HISTORY = "agentDirHistory";
const MIGRATION_DIRS = new Set(["sessions", "bin"]);
const MIGRATION_FILES = new Set(["auth.json", "models.json", "settings.json", "google-code-assist.json"]);

export function defaultAgentDir(projectRoot: string): string {
	return normalizeAbsolutePath(path.join(projectRoot, ".bobbit", "agent"));
}

export function normalizeAgentDirInput(input: string, projectRoot: string): string {
	let value = input.trim();
	if (value === "~") {
		value = os.homedir();
	} else if (value.startsWith(`~${path.sep}`) || value.startsWith("~/") || value.startsWith("~\\")) {
		value = path.join(os.homedir(), value.slice(2));
	}
	const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(projectRoot, value);
	return normalizeAbsolutePath(resolved);
}

export function resolveAgentDir(input: ResolveAgentDirInput): AgentDirResolution {
	const projectRoot = normalizeAbsolutePath(input.projectRoot);
	const defaultDir = defaultAgentDir(projectRoot);
	const env = input.env ?? process.env;
	const bobbitEnv = nonEmptyString(env.BOBBIT_AGENT_DIR);
	if (bobbitEnv) {
		return { dir: normalizeAgentDirInput(bobbitEnv, projectRoot), source: "BOBBIT_AGENT_DIR", raw: bobbitEnv, projectRoot, defaultDir };
	}
	const persisted = nonEmptyString(input.persisted);
	if (persisted) {
		return { dir: normalizeAgentDirInput(persisted, projectRoot), source: "persisted", raw: persisted, projectRoot, defaultDir };
	}
	return { dir: defaultDir, source: "default", projectRoot, defaultDir };
}

export function initializeAgentDirRuntime(input: RuntimeInitInput): AgentDirRuntimeState {
	const projectRoot = normalizeAbsolutePath(input.projectRoot);
	const stateDir = normalizeAbsolutePath(input.stateDir);
	const persistedRaw = input.persisted ?? readPersistedAgentDir(stateDir);
	const persisted = nonEmptyString(persistedRaw) ? normalizeAgentDirInput(persistedRaw!, projectRoot) : undefined;
	const startup = resolveAgentDir({ env: input.env, projectRoot, persisted: persistedRaw });
	const nextStart = resolveAgentDir({ env: input.env, projectRoot, persisted: persistedRaw });
	const history = mergeAgentDirHistory(projectRoot, stateDir, [persisted, startup.dir, nextStart.dir]);
	runtimeStateDir = stateDir;
	runtimeState = {
		startup,
		persisted,
		nextStart,
		restartRequired: !samePath(startup.dir, nextStart.dir),
		history,
	};
	inMemoryAgentDirHistory = history;
	writeAgentDirHistoryIfReady(stateDir, history);
	return cloneRuntimeState(runtimeState);
}

export function initializeAgentDirRuntimeState(input: ResolveAgentDirInput & { stateDir?: string }): AgentDirRuntimeState {
	const projectRoot = normalizeAbsolutePath(input.projectRoot);
	return initializeAgentDirRuntime({
		...input,
		projectRoot,
		stateDir: input.stateDir ? normalizeAbsolutePath(input.stateDir) : path.join(projectRoot, ".bobbit", "state"),
	});
}

export const initializeAgentDirState = initializeAgentDirRuntimeState;

export function resetAgentDirStateForTests(): void {
	runtimeState = undefined;
	runtimeStateDir = undefined;
	inMemoryAgentDirHistory = [];
}

export const resetAgentDirRuntimeForTests = resetAgentDirStateForTests;

export function globalAgentDir(): string {
	if (runtimeState) return runtimeState.startup.dir;
	const projectRoot = normalizeAbsolutePath(process.cwd());
	return initializeAgentDirRuntime({ projectRoot, stateDir: path.join(projectRoot, ".bobbit", "state") }).startup.dir;
}

export function getAgentDirState(): AgentDirRuntimeState {
	if (!runtimeState) {
		throw new Error("Agent directory runtime has not been initialized");
	}
	return cloneRuntimeState(runtimeState);
}

export function getAgentDirApiState(): AgentDirApiState {
	const state = getAgentDirState();
	const persistedPath = state.persisted;
	const envSource = state.startup.source === "BOBBIT_AGENT_DIR" ? state.startup.source : undefined;
	return {
		activePath: state.startup.dir,
		activeSource: state.startup.source,
		startup: state.startup,
		defaultPath: state.startup.defaultDir,
		...(persistedPath ? { persistedPath, pendingPath: persistedPath } : {}),
		nextStart: state.nextStart,
		restartRequired: state.restartRequired,
		...(envSource ? {
			envOverride: {
				active: true as const,
				source: envSource,
				value: state.startup.raw ?? state.startup.dir,
				savedPathIgnored: !!persistedPath && !samePath(persistedPath, state.nextStart.dir),
			},
		} : {}),
		history: [...state.history],
	};
}

export function refreshAgentDirNextStart(persistedRaw?: string, stateDir = runtimeStateDir): AgentDirRuntimeState {
	if (!runtimeState) throw new Error("Agent directory runtime has not been initialized");
	const persisted = nonEmptyString(persistedRaw) ? normalizeAgentDirInput(persistedRaw!, runtimeState.startup.projectRoot) : undefined;
	const nextStart = resolveAgentDir({ projectRoot: runtimeState.startup.projectRoot, persisted: persistedRaw });
	const history = mergeAgentDirHistory(runtimeState.startup.projectRoot, stateDir, [runtimeState.startup.dir, persisted, nextStart.dir]);
	runtimeState = {
		...runtimeState,
		persisted,
		nextStart,
		restartRequired: !samePath(runtimeState.startup.dir, nextStart.dir),
		history,
	};
	inMemoryAgentDirHistory = history;
	if (stateDir) writeAgentDirHistoryIfReady(stateDir, history);
	return cloneRuntimeState(runtimeState);
}

export function readPersistedAgentDir(stateDir: string): string | undefined {
	const prefs = readPreferences(stateDir);
	return nonEmptyString(prefs[PREFERENCE_AGENT_DIR]);
}

export function readPersistedAgentDirHistory(stateDir: string): string[] {
	const prefs = readPreferences(stateDir);
	return Array.isArray(prefs[PREFERENCE_AGENT_DIR_HISTORY])
		? prefs[PREFERENCE_AGENT_DIR_HISTORY].filter((v): v is string => typeof v === "string" && v.trim().length > 0)
		: [];
}

export function recordAgentDirHistory(dir: string, stateDir = runtimeStateDir, projectRoot = runtimeState?.startup.projectRoot): string[] {
	const resolvedProjectRoot = normalizeAbsolutePath(projectRoot ?? process.cwd());
	const history = mergeAgentDirHistory(resolvedProjectRoot, stateDir, [dir]);
	inMemoryAgentDirHistory = history;
	if (stateDir) writeAgentDirHistoryIfReady(stateDir, history);
	if (runtimeState) runtimeState = { ...runtimeState, history };
	return history;
}

export function validateAgentDirTarget(input: unknown, projectRoot: string): AgentDirValidationResult {
	const rawInput = typeof input === "string" ? input : "";
	if (rawInput.trim().length === 0) {
		return validationError("EMPTY_PATH", "Enter an agent directory path.", rawInput);
	}
	let resolvedPath: string;
	try {
		resolvedPath = normalizeAgentDirInput(rawInput, projectRoot);
	} catch (err) {
		return validationError("CREATE_FAILED", `Failed to resolve path: ${(err as Error).message}`, rawInput);
	}

	const normalizedProjectRoot = normalizeAbsolutePath(projectRoot);
	const gitRoot = resolveGitWorktreeRoot(normalizedProjectRoot);
	const gitRootForComparison = safeRealpath(gitRoot) ?? gitRoot;
	const allowedDefault = defaultAgentDir(normalizedProjectRoot);
	const allowedDefaultCandidates = [allowedDefault, realpathForExistingPrefix(allowedDefault) ?? allowedDefault];
	if (isDisallowedInsideWorktree(gitRootForComparison, allowedDefaultCandidates, resolvedPath)) {
		return validationError("INSIDE_WORKTREE", "Choose a directory outside the git worktree, or use the project default .bobbit/agent directory.", rawInput, resolvedPath);
	}

	// Before creating a missing directory, resolve the deepest existing parent.
	// This catches outside symlinks/junctions that would make mkdir land inside
	// the git worktree, without leaving behind a rejected directory in the repo.
	const preCreateRealTarget = realpathForExistingPrefix(resolvedPath);
	if (preCreateRealTarget && isDisallowedInsideWorktree(gitRootForComparison, allowedDefaultCandidates, preCreateRealTarget)) {
		return validationError("INSIDE_WORKTREE", "Choose a directory outside the git worktree, or use the project default .bobbit/agent directory.", rawInput, preCreateRealTarget);
	}

	try {
		if (fs.existsSync(resolvedPath)) {
			const existing = fs.statSync(resolvedPath);
			if (!existing.isDirectory()) {
				return validationError("NOT_DIRECTORY", "The resolved path exists but is not a directory.", rawInput, resolvedPath);
			}
		} else {
			fs.mkdirSync(resolvedPath, { recursive: true, mode: 0o700 });
		}
	} catch (err) {
		return validationError("CREATE_FAILED", `Failed to create directory: ${(err as Error).message}`, rawInput, resolvedPath);
	}

	let realResolvedPath = resolvedPath;
	try {
		const stat = fs.statSync(resolvedPath);
		if (!stat.isDirectory()) {
			return validationError("NOT_DIRECTORY", "The resolved path exists but is not a directory.", rawInput, resolvedPath);
		}
		realResolvedPath = fs.realpathSync(resolvedPath);
	} catch (err) {
		return validationError("NOT_DIRECTORY", `Failed to inspect directory: ${(err as Error).message}`, rawInput, resolvedPath);
	}

	if (isDisallowedInsideWorktree(gitRootForComparison, allowedDefaultCandidates, realResolvedPath)) {
		return validationError("INSIDE_WORKTREE", "Choose a directory outside the git worktree, or use the project default .bobbit/agent directory.", rawInput, realResolvedPath);
	}

	try {
		fs.accessSync(resolvedPath, fs.constants.R_OK | fs.constants.W_OK);
	} catch (err) {
		return validationError("ACCESS_DENIED", `Directory is not readable and writable: ${(err as Error).message}`, rawInput, resolvedPath);
	}

	const probe = path.join(resolvedPath, `.bobbit-agent-dir-probe-${process.pid}-${randomUUID()}`);
	try {
		fs.writeFileSync(probe, "probe", { flag: "wx", mode: 0o600 });
		const read = fs.readFileSync(probe, "utf-8");
		if (read !== "probe") throw new Error("probe readback mismatch");
		fs.unlinkSync(probe);
	} catch (err) {
		try { if (fs.existsSync(probe)) fs.unlinkSync(probe); } catch { /* ignore cleanup */ }
		return validationError("PROBE_FAILED", `Directory read/write probe failed: ${(err as Error).message}`, rawInput, resolvedPath);
	}

	return { ok: true, resolvedPath };
}

export function migrateAgentDirData(sourcePath: string, destinationPath: string, overwrite = false): AgentDirMigrationReport {
	const source = normalizeAbsolutePath(sourcePath);
	const destination = normalizeAbsolutePath(destinationPath);
	const report: AgentDirMigrationReport = {
		sourcePath: source,
		destinationPath: destination,
		overwrite,
		copied: [],
		skipped: [],
		overwritten: [],
		missing: [],
		warnings: [],
		errors: [],
	};

	const relationshipError = agentDirMigrationRelationshipError(source, destination);
	if (relationshipError) {
		report.error = relationshipError;
		report.errors.push(relationshipError.message);
		return report;
	}

	if (!fs.existsSync(source)) {
		report.errors.push("Source directory does not exist.");
		return report;
	}
	try {
		if (!fs.statSync(source).isDirectory()) {
			report.errors.push("Source path is not a directory.");
			return report;
		}
		const existingDestination = lstatIfExists(destination);
		if (existingDestination?.isSymbolicLink()) {
			const message = "destinationPath must not be a symlink.";
			report.error = { code: "DESTINATION_SYMLINK", message };
			report.errors.push(message);
			return report;
		}
		fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
		const destinationStat = fs.lstatSync(destination);
		if (destinationStat.isSymbolicLink()) {
			const message = "destinationPath must not be a symlink.";
			report.error = { code: "DESTINATION_SYMLINK", message };
			report.errors.push(message);
			return report;
		}
		if (!destinationStat.isDirectory()) {
			report.errors.push("Destination path is not a directory.");
			return report;
		}
	} catch (err) {
		report.errors.push(`Failed to prepare migration directories: ${(err as Error).message}`);
		return report;
	}

	for (const name of [...MIGRATION_DIRS, ...MIGRATION_FILES]) {
		const src = path.join(source, name);
		const dst = path.join(destination, name);
		if (!fs.existsSync(src)) {
			report.missing.push(name);
			continue;
		}
		try {
			const stat = fs.lstatSync(src);
			if (stat.isSymbolicLink()) {
				report.warnings.push(`Skipped symlink ${name}.`);
				continue;
			}
			if (stat.isDirectory()) {
				if (!MIGRATION_DIRS.has(name)) {
					report.warnings.push(`Skipped unexpected directory ${name}.`);
					continue;
				}
				copyAllowedDirectory(src, dst, name, overwrite, report, destination);
			} else if (stat.isFile()) {
				if (!MIGRATION_FILES.has(name)) {
					report.warnings.push(`Skipped unexpected file ${name}.`);
					continue;
				}
				copyAllowedFile(src, dst, name, overwrite, report, destination);
			} else {
				report.warnings.push(`Skipped special filesystem entry ${name}.`);
			}
		} catch (err) {
			report.errors.push(`${name}: ${(err as Error).message}`);
		}
	}

	return report;
}

export function isKnownAgentDir(dir: string, state = runtimeState): boolean {
	if (!state) return false;
	const normalized = normalizeAbsolutePath(dir);
	return samePath(normalized, state.startup.dir) || state.history.some((entry) => samePath(entry, normalized));
}

export function isPendingAgentDir(dir: string, state = runtimeState): boolean {
	if (!state) return false;
	const normalized = normalizeAbsolutePath(dir);
	return samePath(normalized, state.nextStart.dir) || (!!state.persisted && samePath(normalized, state.persisted));
}

export function buildAgentDirRestartGuidance(): string {
	const state = getAgentDirState();
	if (state.startup.source === "BOBBIT_AGENT_DIR") {
		const pending = state.persisted ? ` Saved pending directory: ${state.persisted}.` : " No persisted pending directory is set.";
		return `${state.startup.source} is active, so this process continues using ${state.startup.dir}.${pending} Remove the environment override and restart to use the persisted setting.`;
	}
	if (state.restartRequired) {
		return `Restart Bobbit to use ${state.nextStart.dir}. This process continues using ${state.startup.dir} until restart.`;
	}
	return `No restart is required for the effective agent directory. This process is using ${state.startup.dir}.`;
}

function readPreferences(stateDir: string): Record<string, unknown> {
	try {
		const file = path.join(stateDir, "preferences.json");
		if (!fs.existsSync(file)) return {};
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

function writePreferences(stateDir: string, prefs: Record<string, unknown>): void {
	fs.mkdirSync(stateDir, { recursive: true });
	fs.writeFileSync(path.join(stateDir, "preferences.json"), JSON.stringify(prefs, null, 2), "utf-8");
}

function writeAgentDirHistory(stateDir: string, history: string[]): void {
	const prefs = readPreferences(stateDir);
	prefs[PREFERENCE_AGENT_DIR_HISTORY] = history;
	writePreferences(stateDir, prefs);
}

function writeAgentDirHistoryIfReady(stateDir: string, history: string[]): void {
	if (!fs.existsSync(stateDir)) return;
	try {
		writeAgentDirHistory(stateDir, history);
	} catch {
		// History is compatibility metadata. Never let a best-effort history write
		// initialize or break pure path translation/test contexts before startup
		// has scaffolded .bobbit/state.
	}
}

function mergeAgentDirHistory(projectRoot: string, stateDir: string | undefined, dirs: Array<string | undefined>): string[] {
	const seeded = [
		path.join(os.homedir(), ".bobbit", "agent"),
		defaultAgentDir(projectRoot),
		...inMemoryAgentDirHistory,
		...(stateDir ? readPersistedAgentDirHistory(stateDir) : []),
		...dirs,
	];
	const history: string[] = [];
	for (const dir of seeded) {
		if (!dir) continue;
		const normalized = normalizeAgentDirInput(dir, projectRoot);
		if (!history.some((entry) => samePath(entry, normalized))) history.push(normalized);
	}
	return history;
}

function resolveGitWorktreeRoot(projectRoot: string): string {
	try {
		const output = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd: projectRoot,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		}).trim();
		if (output) return normalizeAbsolutePath(output);
	} catch {
		// Fall back to the configured project root when git is unavailable.
	}
	return normalizeAbsolutePath(projectRoot);
}

function copyAllowedDirectory(src: string, dst: string, rel: string, overwrite: boolean, report: AgentDirMigrationReport, destinationRoot: string): void {
	const stat = fs.lstatSync(src);
	if (stat.isSymbolicLink()) {
		report.warnings.push(`Skipped symlink ${rel}.`);
		return;
	}
	if (!stat.isDirectory()) {
		report.warnings.push(`Skipped non-directory ${rel}.`);
		return;
	}
	if (!ensureDestinationPathHasNoSymlinks(dst, destinationRoot, rel, report)) return;
	fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
	for (const entry of fs.readdirSync(src)) {
		const childRel = path.join(rel, entry);
		const childSrc = path.join(src, entry);
		const childDst = path.join(dst, entry);
		const childStat = fs.lstatSync(childSrc);
		if (childStat.isSymbolicLink()) {
			report.warnings.push(`Skipped symlink ${childRel}.`);
		} else if (childStat.isDirectory()) {
			copyAllowedDirectory(childSrc, childDst, childRel, overwrite, report, destinationRoot);
		} else if (childStat.isFile()) {
			copyAllowedFile(childSrc, childDst, childRel, overwrite, report, destinationRoot);
		} else {
			report.warnings.push(`Skipped special filesystem entry ${childRel}.`);
		}
	}
}

function copyAllowedFile(src: string, dst: string, rel: string, overwrite: boolean, report: AgentDirMigrationReport, destinationRoot: string): void {
	const parentRel = path.dirname(rel);
	const parentLabel = parentRel === "." ? rel : parentRel;
	if (!ensureDestinationPathHasNoSymlinks(path.dirname(dst), destinationRoot, parentLabel, report)) return;
	const existingDestination = lstatIfExists(dst);
	if (existingDestination) {
		if (!overwrite) {
			report.skipped.push(rel);
			return;
		}
		if (existingDestination.isDirectory()) {
			report.errors.push(`${rel}: destination exists as a directory.`);
			return;
		}
		if (existingDestination.isSymbolicLink()) {
			report.errors.push(`${rel}: destination exists as a symlink.`);
			return;
		}
		fs.copyFileSync(src, dst);
		report.overwritten.push(rel);
		return;
	}
	fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
	fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
	report.copied.push(rel);
}

function agentDirMigrationRelationshipError(source: string, destination: string): AgentDirMigrationReport["error"] | null {
	const candidates: Array<[string, string]> = [[source, destination]];
	const realSource = realpathForExistingPrefix(source);
	const realDestination = realpathForExistingPrefix(destination);
	if (realSource && realDestination) candidates.push([realSource, realDestination]);
	for (const [sourceCandidate, destinationCandidate] of candidates) {
		if (samePath(sourceCandidate, destinationCandidate)) {
			return { code: "SAME_PATH", message: "sourcePath and destinationPath must be different agent directories." };
		}
		if (isPathWithinOrEqual(sourceCandidate, destinationCandidate)) {
			return { code: "DESTINATION_INSIDE_SOURCE", message: "destinationPath must not be inside sourcePath." };
		}
		if (isPathWithinOrEqual(destinationCandidate, sourceCandidate)) {
			return { code: "SOURCE_INSIDE_DESTINATION", message: "sourcePath must not be inside destinationPath." };
		}
	}
	return null;
}

function validationError(code: AgentDirValidationErrorCode, message: string, rawInput: string, resolvedPath?: string): AgentDirValidationResult {
	return { ok: false, ...(resolvedPath ? { resolvedPath } : {}), error: { code, message, rawInput, ...(resolvedPath ? { resolvedPath } : {}) } };
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizeAbsolutePath(value: string): string {
	return path.resolve(value);
}

function isPathWithinOrEqual(parent: string, child: string): boolean {
	const relative = path.relative(normalizeAbsolutePath(parent), normalizeAbsolutePath(child));
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isDisallowedInsideWorktree(gitRoot: string, allowedDefault: string | string[], target: string): boolean {
	const allowedDefaults = Array.isArray(allowedDefault) ? allowedDefault : [allowedDefault];
	return isPathWithinOrEqual(gitRoot, target) && !allowedDefaults.some((entry) => isPathWithinOrEqual(entry, target));
}

function safeRealpath(value: string): string | undefined {
	try { return fs.realpathSync(value); } catch { return undefined; }
}

function lstatIfExists(value: string): fs.Stats | undefined {
	try { return fs.lstatSync(value); } catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
}

function realpathForExistingPrefix(value: string): string | undefined {
	const normalized = normalizeAbsolutePath(value);
	const missing: string[] = [];
	let current = normalized;
	while (true) {
		const real = safeRealpath(current);
		if (real) return normalizeAbsolutePath(path.join(real, ...missing));
		const parent = path.dirname(current);
		if (samePath(parent, current)) return undefined;
		missing.unshift(path.basename(current));
		current = parent;
	}
}

function ensureDestinationPathHasNoSymlinks(target: string, destinationRoot: string, rel: string, report: AgentDirMigrationReport): boolean {
	const root = normalizeAbsolutePath(destinationRoot);
	const normalizedTarget = normalizeAbsolutePath(target);
	if (!isPathWithinOrEqual(root, normalizedTarget)) {
		report.errors.push(`${rel}: destination path escapes the selected pending directory.`);
		return false;
	}
	const rootStat = lstatIfExists(root);
	if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
		report.errors.push(`${rel}: destination directory is not a real directory.`);
		return false;
	}
	const relative = path.relative(root, normalizedTarget);
	if (!relative) return true;
	let current = root;
	const seen: string[] = [];
	for (const part of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		seen.push(part);
		const stat = lstatIfExists(current);
		if (!stat) return true;
		if (stat.isSymbolicLink()) {
			report.errors.push(`${rel}: destination path contains symlink ${path.join(...seen)}.`);
			return false;
		}
	}
	return true;
}

function samePath(a: string, b: string): boolean {
	const left = normalizeAbsolutePath(a);
	const right = normalizeAbsolutePath(b);
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function cloneRuntimeState(state: AgentDirRuntimeState): AgentDirRuntimeState {
	return {
		startup: { ...state.startup },
		persisted: state.persisted,
		nextStart: { ...state.nextStart },
		restartRequired: state.restartRequired,
		history: [...state.history],
	};
}
