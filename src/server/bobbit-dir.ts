import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  defaultAgentDir as resolveDefaultAgentDir,
  getAgentDirState as getRuntimeAgentDirState,
  initializeAgentDirRuntime as initializeRuntimeAgentDir,
} from "./agent-dir-config.js";

export {
  buildAgentDirRestartGuidance,
  getAgentDirApiState,
  getAgentDirState,
  initializeAgentDirRuntime,
  initializeAgentDirRuntimeState,
  initializeAgentDirState,
  resetAgentDirStateForTests,
  resetAgentDirRuntimeForTests,
  isKnownAgentDir,
  isPendingAgentDir,
  migrateAgentDirData,
  normalizeAgentDirInput,
  readPersistedAgentDir,
  readPersistedAgentDirHistory,
  recordAgentDirHistory,
  refreshAgentDirNextStart,
  resolveAgentDir,
  validateAgentDirTarget,
  type AgentDirApiState,
  type AgentDirMigrationReport,
  type AgentDirResolution,
  type AgentDirRuntimeState,
  type AgentDirSource,
  type AgentDirValidationError,
  type AgentDirValidationErrorCode,
  type AgentDirValidationResult,
} from "./agent-dir-config.js";

let _projectRoot: string | undefined;

/** Set the project root directory. Called once from cli.ts at startup. */
export function setProjectRoot(root: string): void {
  _projectRoot = path.resolve(root);
}

/** Get the project root directory. Falls back to process.cwd(). */
export function getProjectRoot(): string {
  return _projectRoot || process.cwd();
}

/**
 * Returns the physical Headquarters/server workspace directory.
 * Priority: BOBBIT_DIR env > BOBBIT_PI_DIR env (legacy) > <projectRoot>/.bobbit/headquarters.
 */
export function headquartersDir(projectRoot = getProjectRoot()): string {
  if (process.env.BOBBIT_DIR) return path.resolve(process.env.BOBBIT_DIR);
  if (process.env.BOBBIT_PI_DIR) return path.resolve(process.env.BOBBIT_PI_DIR);
  return path.join(path.resolve(projectRoot), ".bobbit", "headquarters");
}

/** Server-level Bobbit dir alias. Normal projects must use normalProjectBobbitDir(projectRoot). */
export function serverBobbitDir(): string {
  return headquartersDir();
}

/** Returns the normal project-local .bobbit directory path. */
export function normalProjectBobbitDir(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".bobbit");
}

/** Returns the server/Headquarters Bobbit directory path. Normal projects must not call this. */
export function bobbitDir(projectRoot = getProjectRoot()): string {
  return headquartersDir(projectRoot);
}

/** Returns <headquartersDir>/config. */
export function bobbitConfigDir(projectRoot = getProjectRoot()): string {
  return path.join(headquartersDir(projectRoot), "config");
}

/** Returns <headquartersDir>/state. */
export function bobbitStateDir(projectRoot = getProjectRoot()): string {
  return path.join(headquartersDir(projectRoot), "state");
}

/**
 * Absolute directory for LIVE server secrets — the admin bearer `token`, TLS
 * material (`tls/`), and sandbox-agent auth (`sandbox-agent-auth/`).
 *
 * These MUST live OUTSIDE any project root. The default Headquarters dir is
 * `<serverRunDir>/.bobbit/headquarters`, and a normal project registered at the
 * server run directory defaults its session cwd to `<serverRunDir>`. That makes
 * `<serverRunDir>/.bobbit/headquarters/state/token` a descendant of a normal
 * project's cwd — a project agent could read the live admin token and escalate
 * to gateway-wide API access. Relocating the secrets to an OS user-level
 * directory removes them from any project-reachable path.
 *
 * Resolution priority (computed fresh each call — no cache — so env overrides
 * used for test isolation take effect):
 *   1. `BOBBIT_SECRETS_DIR` (explicit override; REQUIRED for test isolation).
 *   2. OS user dir + `bobbit/secrets/<hash>` where `<hash>` = first 16 hex of
 *      `sha256(headquartersDir())` (stable per Headquarters dir, so multiple
 *      servers on one machine don't collide).
 */
export function serverSecretsDir(): string {
  let dir: string;
  if (process.env.BOBBIT_SECRETS_DIR) {
    dir = path.resolve(process.env.BOBBIT_SECRETS_DIR);
  } else {
    const hash = crypto.createHash("sha256").update(headquartersDir()).digest("hex").slice(0, 16);
    if (process.platform === "win32") {
      const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
      dir = path.join(base, "bobbit", "secrets", hash);
    } else if (process.platform === "darwin") {
      dir = path.join(os.homedir(), "Library", "Application Support", "bobbit", "secrets", hash);
    } else {
      const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
      dir = path.join(base, "bobbit", "secrets", hash);
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform !== "win32") {
    try { fs.chmodSync(dir, 0o700); } catch { /* best-effort perms */ }
  }
  return dir;
}

/** Returns the server/Headquarters default agent directory. */
export function defaultAgentDir(projectRoot = getProjectRoot()): string {
  return resolveDefaultAgentDir(projectRoot);
}

/**
 * Returns the startup-resolved global agent directory.
 * Priority at initialization: BOBBIT_AGENT_DIR env > persisted agentDir > <headquartersDir>/agent/.
 */
export function globalAgentDir(): string {
  try {
    return getRuntimeAgentDirState().startup.dir;
  } catch {
    const projectRoot = getProjectRoot();
    return initializeRuntimeAgentDir({ projectRoot, stateDir: bobbitStateDir(projectRoot) }).startup.dir;
  }
}

/** Returns the global auth.json path. API keys are global, not per-project. */
export function globalAuthPath(): string {
  return path.join(globalAgentDir(), "auth.json");
}
