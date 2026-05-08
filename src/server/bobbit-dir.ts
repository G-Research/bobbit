import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let _serverCwd: string | undefined;

/** Set the server's startup cwd. Called once from cli.ts at startup. */
export function setServerCwd(cwd: string): void {
  _serverCwd = cwd;
}

/** Get the server's startup cwd. Falls back to process.cwd(). */
export function getServerCwd(): string {
  return _serverCwd || process.cwd();
}

/**
 * Returns the .bobbit directory path.
 * Priority: BOBBIT_DIR env > BOBBIT_PI_DIR env (legacy) > <serverCwd>/.bobbit
 */
export function bobbitDir(serverCwd?: string): string {
  if (process.env.BOBBIT_DIR) return process.env.BOBBIT_DIR;
  if (process.env.BOBBIT_PI_DIR) return process.env.BOBBIT_PI_DIR;
  const root = serverCwd || getServerCwd();
  return path.join(root, ".bobbit");
}

/** Returns .bobbit/config */
export function bobbitConfigDir(serverCwd?: string): string {
  return path.join(bobbitDir(serverCwd), "config");
}

/** Returns .bobbit/state */
export function bobbitStateDir(serverCwd?: string): string {
  return path.join(bobbitDir(serverCwd), "state");
}

/**
 * Returns the global agent directory.
 * Priority: BOBBIT_AGENT_DIR env > PI_CODING_AGENT_DIR env > <serverCwd>/.bobbit/state/agent
 */
export function globalAgentDir(): string {
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
  return path.join(bobbitStateDir(), "agent");
}

/**
 * Migrate ~/.pi/agent/ contents to ~/.bobbit/agent/ at startup.
 * - If ~/.pi/agent/ doesn't exist or was already migrated (.pi/agent.pre-bobbit/ exists), no-op.
 * - If ~/.bobbit/agent/ doesn't exist, rename ~/.pi/agent/ to ~/.bobbit/agent/.
 * - If both exist, merge: move session dirs from .pi to .bobbit (skip existing),
 *   copy auth.json/models.json/settings.json if not already in .bobbit.
 * - After migration, rename ~/.pi/agent/ to ~/.pi/agent.pre-bobbit/.
 * Idempotent and safe.
 */
export function migrateFromLegacyPiDir(): void {
  const legacyDir = path.join(os.homedir(), ".pi", "agent");
  const markerDir = path.join(os.homedir(), ".pi", "agent.pre-bobbit");
  const newDir = path.join(os.homedir(), ".bobbit", "agent");

  // Already migrated or no legacy dir
  if (!fs.existsSync(legacyDir) || fs.existsSync(markerDir)) return;

  try {
    if (!fs.existsSync(newDir)) {
      // Simple case: just move
      fs.mkdirSync(path.join(os.homedir(), ".bobbit"), { recursive: true });
      fs.renameSync(legacyDir, newDir);
      console.log(`[migration] Moved ~/.pi/agent/ → ~/.bobbit/agent/`);
    } else {
      // Merge: move session dirs from .pi to .bobbit (skip existing)
      const legacySessionsDir = path.join(legacyDir, "sessions");
      const newSessionsDir = path.join(newDir, "sessions");
      if (fs.existsSync(legacySessionsDir)) {
        fs.mkdirSync(newSessionsDir, { recursive: true });
        let moved = 0;
        for (const entry of fs.readdirSync(legacySessionsDir)) {
          const src = path.join(legacySessionsDir, entry);
          const dst = path.join(newSessionsDir, entry);
          if (!fs.existsSync(dst)) {
            try {
              fs.renameSync(src, dst);
              moved++;
            } catch {
              // Cross-device or permission error — skip
            }
          }
        }
        if (moved > 0) {
          console.log(`[migration] Moved ${moved} session dirs from ~/.pi/agent/sessions/ → ~/.bobbit/agent/sessions/`);
        }
      }

      // Copy config files if not already present in .bobbit
      for (const file of ["auth.json", "models.json", "settings.json"]) {
        const src = path.join(legacyDir, file);
        const dst = path.join(newDir, file);
        if (fs.existsSync(src) && !fs.existsSync(dst)) {
          try {
            fs.copyFileSync(src, dst);
            console.log(`[migration] Copied ~/.pi/agent/${file} → ~/.bobbit/agent/${file}`);
          } catch {
            // Permission error — skip
          }
        }
      }

      // Rename legacy dir to mark as migrated
      fs.renameSync(legacyDir, markerDir);
      console.log(`[migration] Renamed ~/.pi/agent/ → ~/.pi/agent.pre-bobbit/`);
    }
  } catch (err) {
    console.warn(`[migration] Failed to migrate ~/.pi/agent/: ${err}`);
  }
}

/**
 * Migrate ~/.bobbit/agent/ to <serverCwd>/.bobbit/state/agent/ at startup.
 * - Skipped entirely when BOBBIT_AGENT_DIR or PI_CODING_AGENT_DIR is set (user opt-out).
 * - If ~/.bobbit/agent/ doesn't exist or marker ~/.bobbit/agent.pre-relocate/ exists, no-op.
 * - If target doesn't exist, rename legacy → target.
 * - If both exist, merge non-conflicting sessions; if there are no movable sessions,
 *   leave legacy in place with a warning. Either way, drop the marker if we touched it.
 * Idempotent and safe.
 */
export function migrateLegacyHomeAgentDir(): void {
  if (process.env.BOBBIT_AGENT_DIR || process.env.PI_CODING_AGENT_DIR) return;
  const legacy = path.join(os.homedir(), ".bobbit", "agent");
  const marker = path.join(os.homedir(), ".bobbit", "agent.pre-relocate");
  const target = globalAgentDir(); // resolves to <serverCwd>/.bobbit/state/agent
  if (!fs.existsSync(legacy) || fs.existsSync(marker)) return;
  if (path.resolve(legacy) === path.resolve(target)) return; // safety: home == server cwd
  try {
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(legacy, target);
      console.log(`[migration] Moved ~/.bobbit/agent/ → ${target}`);
    } else {
      // Merge sessions only; leave auth.json/models.json/bin in legacy.
      const legacySessions = path.join(legacy, "sessions");
      const newSessions = path.join(target, "sessions");
      if (fs.existsSync(legacySessions)) {
        fs.mkdirSync(newSessions, { recursive: true });
        let moved = 0;
        for (const e of fs.readdirSync(legacySessions)) {
          const src = path.join(legacySessions, e);
          const dst = path.join(newSessions, e);
          if (!fs.existsSync(dst)) {
            try {
              fs.renameSync(src, dst);
              moved++;
            } catch {
              // Cross-device or permission error — skip
            }
          }
        }
        if (moved > 0) {
          console.log(`[migration] Moved ${moved} agent session dirs into ${newSessions}`);
        } else {
          console.warn(`[migration] ~/.bobbit/agent/ and ${target} both exist — leaving legacy in place`);
        }
      }
      fs.renameSync(legacy, marker);
    }
  } catch (err) {
    console.warn(`[migration] Failed to relocate ~/.bobbit/agent/: ${err}`);
  }
}

/** Returns the global auth.json path. API keys are global, not per-project. */
export function globalAuthPath(): string {
  return path.join(globalAgentDir(), "auth.json");
}
