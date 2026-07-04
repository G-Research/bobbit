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

/** Returns the project-local default agent directory. */
export function defaultAgentDir(projectRoot = getProjectRoot()): string {
  return resolveDefaultAgentDir(projectRoot);
}

/**
 * Returns the startup-resolved global agent directory.
 * Priority at initialization: BOBBIT_AGENT_DIR env > persisted agentDir > <projectRoot>/.bobbit/agent/.
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
