import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let _projectRoot: string | undefined;

/** Set the project root directory. Called once from cli.ts at startup. */
export function setProjectRoot(root: string): void {
  _projectRoot = root;
}

/** Get the project root directory. Falls back to process.cwd(). */
export function getProjectRoot(): string {
  return _projectRoot || process.cwd();
}

/**
 * Returns the .bobbit directory path.
 * Priority: BOBBIT_DIR env > BOBBIT_PI_DIR env (legacy) > <projectRoot>/.bobbit
 */
export function bobbitDir(projectRoot?: string): string {
  if (process.env.BOBBIT_DIR) return process.env.BOBBIT_DIR;
  if (process.env.BOBBIT_PI_DIR) return process.env.BOBBIT_PI_DIR;
  const root = projectRoot || getProjectRoot();
  return path.join(root, ".bobbit");
}

/** Returns .bobbit/config */
export function bobbitConfigDir(projectRoot?: string): string {
  return path.join(bobbitDir(projectRoot), "config");
}

/** Returns .bobbit/state */
export function bobbitStateDir(projectRoot?: string): string {
  return path.join(bobbitDir(projectRoot), "state");
}

/**
 * Returns the global agent directory (~/.bobbit/agent/ or ~/.pi/agent/ for legacy installs).
 * Priority: BOBBIT_AGENT_DIR env > PI_CODING_AGENT_DIR env > filesystem auto-detect.
 * Auto-detect: if ~/.bobbit/agent/ exists, use it. Else if ~/.pi/agent/ exists, use it.
 * Otherwise use ~/.bobbit/agent/ (new installs).
 */
export function globalAgentDir(): string {
  // Check env vars first
  const bobbitEnv = process.env.BOBBIT_AGENT_DIR;
  if (bobbitEnv) {
    if (bobbitEnv === "~") return os.homedir();
    if (bobbitEnv.startsWith("~/")) return os.homedir() + bobbitEnv.slice(1);
    return bobbitEnv;
  }
  const piEnv = process.env.PI_CODING_AGENT_DIR;
  if (piEnv) {
    if (piEnv === "~") return os.homedir();
    if (piEnv.startsWith("~/")) return os.homedir() + piEnv.slice(1);
    return piEnv;
  }

  // Filesystem auto-detect with fallback
  const newDir = path.join(os.homedir(), ".bobbit", "agent");
  const legacyDir = path.join(os.homedir(), ".pi", "agent");
  if (fs.existsSync(newDir)) return newDir;
  if (fs.existsSync(legacyDir)) return legacyDir;
  return newDir; // new installs
}

/** Returns the global auth.json path. API keys are global, not per-project. */
export function globalAuthPath(): string {
  return path.join(globalAgentDir(), "auth.json");
}
