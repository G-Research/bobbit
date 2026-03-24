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

/** Returns the global auth.json path (~/.pi/agent/auth.json). API keys are global, not per-project. */
export function globalAuthPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "auth.json");
}
