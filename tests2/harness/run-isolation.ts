import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

/** Environment key inherited by every worker participating in one test run. */
export const RUN_ROOT_ENV = "BOBBIT_V2_RUN_ROOT";
/** Set only by the coordinator that made RUN_ROOT_ENV; workers must never clean it. */
export const RUN_ROOT_OWNER_ENV = "BOBBIT_V2_RUN_ROOT_OWNER_PID";
export const PLAYWRIGHT_BROWSERS_PATH_ENV = "PLAYWRIGHT_BROWSERS_PATH";

/**
 * Exact credential inputs read by the gateway's host-token and model-auth paths.
 * Prefixes cover provider-specific variants while keeping unrelated environment
 * settings (notably PATH and test controls) untouched.
 */
export const CREDENTIAL_ENV_EXACT_NAMES = new Set([
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"OPENAI_CODEX_AUTH",
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"GOOGLE_CLOUD_ACCESS_TOKEN",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GOOGLE_CLOUD_PROJECT_ID",
	"GOOGLE_GENAI_USE_GCA",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_PROFILE",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
	"AWS_BEDROCK_SKIP_AUTH",
	"NPM_TOKEN",
	"GITHUB_TOKEN",
	"GH_TOKEN",
	"AIGW_OPENCODE_TOKEN",
]);

export const CREDENTIAL_ENV_PREFIXES = [
	"CLAUDE_CODE_",
	"ANTHROPIC_",
	"OPENAI_",
	"OPENROUTER_",
	"GEMINI_",
	"GOOGLE_",
	"AWS_",
	"AIGW_",
	"OPENCODE_",
	"GITHUB_",
	"GH_",
	"AZURE_",
	"COHERE_",
	"MISTRAL_",
	"GROQ_",
	"TOGETHER_",
	"DEEPSEEK_",
	"XAI_",
] as const;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Backward-compatible RegExp export for focused tests and existing harness callers.
// The prefix list remains the source of truth; this is only its RegExp form.
export const CREDENTIAL_ENV_PATTERN = new RegExp(
	`^(?:${CREDENTIAL_ENV_PREFIXES.map(escapeRegExp).join("|")}|BOBBIT_.*(?:KEY|TOKEN|SECRET|CREDENTIALS?)$)`,
);

/** True for known host credentials and provider auth/config inputs. */
export function isCredentialEnvKey(key: string, platform: NodeJS.Platform = process.platform): boolean {
	// process.env is case-insensitive on Windows, but Object.keys() preserves
	// inherited spelling. Normalize before matching so a lower-case credential
	// cannot survive a host-environment scrub.
	const normalized = platform === "win32" ? key.toUpperCase() : key;
	return CREDENTIAL_ENV_EXACT_NAMES.has(normalized) || CREDENTIAL_ENV_PATTERN.test(normalized);
}

export interface PathContainmentApi {
	resolve(...paths: string[]): string;
	relative(from: string, to: string): string;
	isAbsolute(path: string): boolean;
}

function canonicalDirectory(directory: string): string {
	mkdirSync(directory, { recursive: true });
	try { return realpathSync(directory); } catch { return path.resolve(directory); }
}

/**
 * Whether candidate is strictly below root. An absolute relative result is an
 * escape on Windows (different drive or UNC path), even though it does not
 * begin with `..`; reject it before any destructive operation.
 */
export function isOwnedRunChild(root: string, candidate: string, pathApi: PathContainmentApi = path): boolean {
	const canonicalRoot = pathApi.resolve(root);
	const canonicalCandidate = pathApi.resolve(candidate);
	const rel = pathApi.relative(canonicalRoot, canonicalCandidate);
	return rel !== "" && !pathApi.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !rel.startsWith("../") && !rel.startsWith("..\\");
}

let runRoot: string | undefined;
let runRootOwnedByThisProcess = false;
let cleanupRegistered = false;
let runRootCleaned = false;

function registerOwnerCleanup(): void {
	if (cleanupRegistered || !runRootOwnedByThisProcess) return;
	cleanupRegistered = true;
	process.once("exit", () => { cleanupOwnedRunRoot(); });
}

/** Return the canonical, per-coordinator root. Child workers reuse its env value. */
export function getRunRoot(): string {
	if (runRoot) return runRoot;
	const inherited = process.env[RUN_ROOT_ENV];
	if (inherited) return runRoot = canonicalDirectory(inherited);
	const base = canonicalDirectory(tmpdir());
	runRoot = canonicalDirectory(mkdtempSync(path.join(base, "bobbit-v2-run-")));
	runRootOwnedByThisProcess = true;
	process.env[RUN_ROOT_ENV] = runRoot;
	process.env[RUN_ROOT_OWNER_ENV] = String(process.pid);
	registerOwnerCleanup();
	return runRoot;
}

/** True only in the coordinator process that allocated this run root. */
export function isRunRootOwner(): boolean {
	getRunRoot();
	return runRootOwnedByThisProcess;
}

/**
 * Delete a run root only when this process allocated it. Workers inherit the
 * root but have no ownership flag, so their exit can never race sibling tests.
 * Reporters finish before the coordinator exits; durable summaries belong in
 * their explicitly managed report paths, not in disposable worker artifacts.
 */
export function cleanupOwnedRunRoot(): boolean {
	if (!runRootOwnedByThisProcess || !runRoot || runRootCleaned) return false;
	runRootCleaned = true;
	try {
		rmSync(runRoot, { recursive: true, force: true });
		return true;
	} catch {
		runRootCleaned = false;
		return false;
	}
}

/** Allocate a unique directory owned by this run; only such children may be removed. */
export function createRunChild(prefix: string): string {
	return canonicalDirectory(mkdtempSync(path.join(getRunRoot(), `${prefix}-`)));
}

/**
 * Create a deterministic artifact directory inside this run's unique root.
 *
 * Unlike createRunChild(), artifact names are deliberately stable: Playwright
 * receives one output directory per coordinator, while the unique run root
 * prevents concurrent coordinators from ever sharing it. Reject separators so
 * a config value can neither escape nor overlap another owned child.
 */
export function createRunArtifactDirectory(name: string): string {
	if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name !== path.basename(name)) {
		throw new Error(`invalid run artifact directory name: ${name}`);
	}
	const root = getRunRoot();
	const artifactDir = path.resolve(root, name);
	if (!isOwnedRunChild(root, artifactDir)) throw new Error(`refusing to create non-owned test artifact path: ${artifactDir}`);
	return canonicalDirectory(artifactDir);
}

export function removeOwnedRunChild(candidate: string): void {
	const root = getRunRoot();
	if (!isOwnedRunChild(root, candidate)) throw new Error(`refusing to remove non-owned test path: ${candidate}`);
	rmSync(candidate, { recursive: true, force: true });
}

/** The Playwright browser registry derived from an unredirected user environment. */
export function resolvePlaywrightBrowserRegistry(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	if (env[PLAYWRIGHT_BROWSERS_PATH_ENV]) return env[PLAYWRIGHT_BROWSERS_PATH_ENV];
	const home = env.HOME || env.USERPROFILE;
	if (!home) throw new Error("cannot resolve Playwright browser registry without HOME or USERPROFILE");
	if (platform === "linux") return path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "ms-playwright");
	if (platform === "darwin") return path.join(home, "Library", "Caches", "ms-playwright");
	if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ms-playwright");
	throw new Error(`unsupported platform for Playwright browser registry: ${platform}`);
}

/**
 * Preserve the real Playwright browser registry before HOME is isolated.
 * Browser workers redirect HOME to avoid host Bobbit config, but Chromium is
 * installed in Playwright's user cache; this explicit path keeps launches out
 * of the empty per-run home without exposing any application configuration.
 */
export function capturePlaywrightBrowserRegistry(): string {
	const registry = resolvePlaywrightBrowserRegistry();
	process.env[PLAYWRIGHT_BROWSERS_PATH_ENV] = registry;
	return registry;
}

/** Redirect all user-discovery roots before a server/discovery module is imported. */
export function installRunIsolation(): string {
	const root = getRunRoot();
	const home = canonicalDirectory(path.join(root, "home"));
	const temp = canonicalDirectory(path.join(root, "tmp"));
	process.env.TMPDIR = temp;
	process.env.TEMP = temp;
	process.env.TMP = temp;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.BOBBIT_DIR = canonicalDirectory(path.join(root, "bobbit"));
	process.env.BOBBIT_PI_DIR = process.env.BOBBIT_DIR;
	process.env.BOBBIT_AGENT_DIR = canonicalDirectory(path.join(root, "agent"));
	process.env.PI_CODING_AGENT_DIR = process.env.BOBBIT_AGENT_DIR;
	process.env.BOBBIT_SECRETS_DIR = canonicalDirectory(path.join(root, "secrets"));
	process.env.APPDATA = canonicalDirectory(path.join(root, "appdata", "roaming"));
	process.env.LOCALAPPDATA = canonicalDirectory(path.join(root, "appdata", "local"));
	process.env.XDG_STATE_HOME = canonicalDirectory(path.join(root, "xdg", "state"));
	process.env.XDG_CONFIG_HOME = canonicalDirectory(path.join(root, "xdg", "config"));
	for (const key of Object.keys(process.env)) {
		if (isCredentialEnvKey(key)) delete process.env[key];
	}
	return root;
}

/** Snapshot/delete credentials for focused tests that deliberately seed them. */
export function isolateCredentialEnv(): () => void {
	const saved = new Map<string, string | undefined>();
	for (const key of Object.keys(process.env)) {
		if (isCredentialEnvKey(key)) {
			saved.set(key, process.env[key]);
			delete process.env[key];
		}
	}
	return () => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

export function isOwnedRunPath(candidate: string): boolean {
	const root = getRunRoot();
	return existsSync(root) && (path.resolve(candidate) === root || isOwnedRunChild(root, candidate));
}
