import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_PROJECT_COLOR_DARK,
  DEFAULT_PROJECT_COLOR_LIGHT,
  PALETTE_PRIMARY_COLORS,
} from "../../shared/palette-colors.js";
import { getProjectRoot } from "../bobbit-dir.js";
import { runPreflight, type PreflightReport } from "./project-preflight.js";

export interface RegisteredProject {
  id: string;           // UUID
  name: string;         // Display name
  rootPath: string;     // Absolute path to project directory
  createdAt: number;    // Epoch ms
  color?: string;       // Deprecated — kept for backward compat
  palette?: string;     // One of 10 palette IDs or undefined
  colorLight: string;   // Accent color for light mode (always present)
  colorDark: string;    // Accent color for dark mode (always present)
  provisional?: boolean; // True while a project assistant is setting up this project
  /**
   * True for synthetic projects that should be filtered out of UI listings
   * but still resolvable by id (e.g. the "system" project used as the
   * persistence anchor for system-scope tool-assistant sessions). Hidden
   * projects must never appear in /api/projects responses.
   */
  hidden?: boolean;
}

/** Stable id for the synthetic system project. */
export const SYSTEM_PROJECT_ID = "system";

/**
 * Detect whether `rootPath` resolves through a symlink to a different
 * absolute path. Best-effort — EPERM/ENOENT are swallowed and treated as
 * non-symlink.
 */
export function detectSymlinkRoot(
  rootPath: string,
): { symlink: false } | { symlink: true; canonical: string } {
  try {
    const real = fs.realpathSync(rootPath);
    const a = path.resolve(rootPath);
    const b = path.resolve(real);
    if (a !== b) return { symlink: true, canonical: b };
  } catch {
    /* best-effort */
  }
  return { symlink: false };
}

/**
 * Thrown by `register()` (and friends) when the supplied rootPath is a
 * symlink to a different canonical path and the caller has not opted in via
 * `acceptCanonical`. The REST surface translates this into a structured 400
 * carrying both paths so the UI can prompt the user.
 */
/**
 * Thrown when a server-side preflight pass surfaces any `fail` check. The
 * REST surface translates this into a 400 carrying the full report.
 */
export class PreflightFailedError extends Error {
  readonly code = "preflight_failed";
  constructor(
    public readonly rootPath: string,
    public readonly report: PreflightReport,
    failingSummary: string,
  ) {
    super(`Project preflight failed for ${rootPath}: ${failingSummary}`);
    this.name = "PreflightFailedError";
  }
}

export class SymlinkProjectRootError extends Error {
  readonly code = "symlink_root";
  constructor(public readonly rootPath: string, public readonly canonical: string) {
    super(
      `rootPath ${rootPath} is a symlink to ${canonical}; pass acceptCanonical to register the canonical path.`,
    );
    this.name = "SymlinkProjectRootError";
  }
}

export class ProjectRegistry {
  private projects = new Map<string, RegisteredProject>();
  private readonly storePath: string;

  constructor(stateDir: string) {
    this.storePath = path.join(stateDir, "projects.json");
    this.load();
  }

  /** Read projects from disk. Missing file is treated as empty registry. */
  load(): void {
    try {
      const raw = fs.readFileSync(this.storePath, "utf-8");
      const arr: any[] = JSON.parse(raw);
      this.projects.clear();
      for (const p of arr) {
        // Migration: ensure colorLight/colorDark always present
        if (!p.colorLight || !p.colorDark) {
          if (p.color) {
            p.colorLight = p.colorLight || p.color;
            p.colorDark = p.colorDark || p.color;
          } else {
            p.colorLight = p.colorLight || DEFAULT_PROJECT_COLOR_LIGHT;
            p.colorDark = p.colorDark || DEFAULT_PROJECT_COLOR_DARK;
          }
        }
        this.projects.set(p.id, p as RegisteredProject);
      }
    } catch {
      // File missing or corrupt — start empty
      this.projects.clear();
    }
  }

  /** Atomically persist projects to disk (write tmp + rename). */
  save(): void {
    const dir = path.dirname(this.storePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.storePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.list(), null, 2), "utf-8");
    fs.renameSync(tmp, this.storePath);
  }

  /** Return all registered projects, ordered by createdAt ascending. */
  list(): RegisteredProject[] {
    return [...this.projects.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Lookup by project ID. */
  get(id: string): RegisteredProject | undefined {
    return this.projects.get(id);
  }

  /** Find a project whose rootPath matches (normalized). Excludes hidden
   * synthetic projects (e.g. "system") so that real-project lookups don't
   * accidentally match the install-dir anchor of the hidden system project. */
  getByPath(rootPath: string): RegisteredProject | undefined {
    const normalized = path.resolve(rootPath);
    for (const p of this.projects.values()) {
      if (p.hidden) continue;
      if (path.resolve(p.rootPath) === normalized) return p;
    }
    return undefined;
  }

  /** Find the project whose rootPath contains the given cwd (longest match wins).
   * Excludes hidden synthetic projects — they should never match by cwd.
   *
   * Both sides are canonicalized via realpathSync (best-effort, with textual
   * fallback on EPERM/ENOENT) so a cwd reached through a symlink resolves to
   * a project registered at the canonical path (or vice versa).
   * `getByPath()` is intentionally NOT canonicalized — it is used as a
   * duplicate-path guard for `register()` and must match exactly what the
   * caller passed. */
  findByCwd(cwd: string): RegisteredProject | undefined {
    const resolveReal = (p: string) => {
      try { return fs.realpathSync(p); } catch { return p; }
    };
    const normalized = path.resolve(resolveReal(cwd)).replace(/\\/g, "/").toLowerCase();
    let best: RegisteredProject | undefined;
    let bestLen = 0;
    for (const p of this.projects.values()) {
      if (p.hidden) continue;
      const root = path.resolve(resolveReal(p.rootPath)).replace(/\\/g, "/").toLowerCase();
      if ((normalized === root || normalized.startsWith(root + "/")) && root.length > bestLen) {
        best = p;
        bestLen = root.length;
      }
    }
    return best;
  }

  /**
   * Register a new project.
   * - Validates rootPath is absolute.
   * - Scaffolds `.bobbit/config/` and `.bobbit/state/` if they don't exist.
   * - Persists immediately.
   */
  register(
    name: string,
    rootPath: string,
    opts?: { color?: string; palette?: string; colorLight?: string; colorDark?: string; acceptCanonical?: boolean },
  ): RegisteredProject {
    if (!path.isAbsolute(rootPath)) {
      throw new Error(`rootPath must be absolute, got: ${rootPath}`);
    }

    if (!fs.existsSync(rootPath)) {
      throw new Error("Project root path does not exist: " + rootPath);
    }

    // Symlink guard: if rootPath resolves through a symlink, require the
    // caller to opt in to the canonical path. Otherwise worktree creation,
    // .bobbit/state scaffolding, and path-containment checks would operate
    // inconsistently against both the symlink and its target.
    const sym = detectSymlinkRoot(rootPath);
    if (sym.symlink) {
      if (opts?.acceptCanonical) {
        rootPath = sym.canonical;
      } else {
        throw new SymlinkProjectRootError(rootPath, sym.canonical);
      }
    }

    // Check for duplicate rootPath
    const existing = this.getByPath(rootPath);
    if (existing) {
      throw new Error(`A project is already registered at ${rootPath} (id=${existing.id})`);
    }

    // Defense in depth: re-run preflight server-side. The REST endpoint may
    // have already shown the report to the user, but we never trust the
    // client to have actually heeded it. Any `fail` aborts registration.
    // Callers that legitimately need to bypass (e.g. the synthetic system
    // project or the project-assistant scaffolding path) call sister
    // methods (registerSystemProject / registerProvisional) which do not
    // invoke this guard.
    try {
      const report = runPreflight(rootPath, {
        registeredProjects: this.list(),
        gatewayProjectRoot: getProjectRoot(),
      });
      if (report.hasFail) {
        const failing = report.checks.filter(c => c.level === "fail")
          .map(c => `${c.id}: ${c.detail}`)
          .join("; ");
        throw new PreflightFailedError(rootPath, report, failing);
      }
    } catch (err) {
      if (err instanceof PreflightFailedError) throw err;
      // Any other failure inside preflight is non-fatal — log and proceed,
      // matching the pre-preflight behavior so a broken check can't lock
      // out all project registration.
      console.warn(`[project-registry] preflight failed unexpectedly: ${err}`);
    }

    // Scaffold .bobbit directories
    const bobbitDir = path.join(rootPath, ".bobbit");
    fs.mkdirSync(path.join(bobbitDir, "config"), { recursive: true });
    fs.mkdirSync(path.join(bobbitDir, "state"), { recursive: true });

    // Determine colors: explicit > palette-seeded > legacy color > defaults
    let colorLight = opts?.colorLight;
    let colorDark = opts?.colorDark;
    const palette = opts?.palette;

    if (palette && PALETTE_PRIMARY_COLORS[palette]) {
      if (!colorLight) colorLight = PALETTE_PRIMARY_COLORS[palette].light;
      if (!colorDark) colorDark = PALETTE_PRIMARY_COLORS[palette].dark;
    }

    if (!colorLight && opts?.color) colorLight = opts.color;
    if (!colorDark && opts?.color) colorDark = opts.color;

    colorLight = colorLight || DEFAULT_PROJECT_COLOR_LIGHT;
    colorDark = colorDark || DEFAULT_PROJECT_COLOR_DARK;

    const project: RegisteredProject = {
      id: randomUUID(),
      name,
      rootPath,
      createdAt: Date.now(),
      color: colorLight, // backward compat
      colorLight,
      colorDark,
      ...(palette ? { palette } : {}),
    };

    this.projects.set(project.id, project);
    this.save();
    return project;
  }

  /** Update mutable fields of an existing project. */
  update(
    id: string,
    updates: Partial<Pick<RegisteredProject, "name" | "color" | "rootPath" | "palette" | "colorLight" | "colorDark">>,
  ): RegisteredProject {
    const project = this.projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);

    if (updates.name !== undefined) project.name = updates.name;
    if (updates.rootPath !== undefined) project.rootPath = path.resolve(updates.rootPath);

    // Handle palette change
    if (updates.palette !== undefined) {
      project.palette = updates.palette || undefined; // empty string → clear palette
      // Auto-seed colors from palette when colors not explicitly provided
      if (project.palette && PALETTE_PRIMARY_COLORS[project.palette]) {
        if (updates.colorLight === undefined) {
          project.colorLight = PALETTE_PRIMARY_COLORS[project.palette].light;
        }
        if (updates.colorDark === undefined) {
          project.colorDark = PALETTE_PRIMARY_COLORS[project.palette].dark;
        }
      }
    }

    // Explicit color overrides
    if (updates.colorLight !== undefined) project.colorLight = updates.colorLight;
    if (updates.colorDark !== undefined) project.colorDark = updates.colorDark;

    // Legacy color field — keep in sync
    if (updates.color !== undefined) project.color = updates.color;
    else project.color = project.colorLight;

    this.projects.set(id, project);
    this.save();
    return project;
  }

  /**
   * Remove a project from the registry.
   * Does NOT delete files on disk — only unregisters.
   * Callers (e.g. server.ts) should guard against removing the last remaining project.
   */
  remove(id: string): void {
    if (!this.projects.has(id)) {
      throw new Error(`Project not found: ${id}`);
    }
    this.projects.delete(id);
    this.save();
  }

  /**
   * Register the synthetic "system" project anchored at the bobbit install
   * directory. Idempotent — safe to call repeatedly. Used as the
   * `projectId` for system-scope tool-assistant sessions so they have a
   * valid persistence anchor without forcing the user to register a real
   * project. Marked `hidden: true` so callers can filter it out of UI
   * listings.
   */
  registerSystemProject(rootPath: string): RegisteredProject {
    const existing = this.projects.get(SYSTEM_PROJECT_ID);
    if (existing) return existing;
    if (!path.isAbsolute(rootPath)) {
      throw new Error(`rootPath must be absolute, got: ${rootPath}`);
    }
    // The system project is hidden and synthetic — there is no user-facing
    // confirm dialog. Silently use the canonical path if rootPath is a
    // symlink to keep state consistent.
    {
      const sym = detectSymlinkRoot(rootPath);
      if (sym.symlink) rootPath = sym.canonical;
    }
    // Scaffold .bobbit dirs only if rootPath exists. The bobbit install dir
    // normally does, but tests may pass a placeholder.
    if (fs.existsSync(rootPath)) {
      const bobbitDir = path.join(rootPath, ".bobbit");
      try {
        fs.mkdirSync(path.join(bobbitDir, "config"), { recursive: true });
        fs.mkdirSync(path.join(bobbitDir, "state"), { recursive: true });
      } catch { /* best-effort — read-only install dirs are fine */ }
    }
    const project: RegisteredProject = {
      id: SYSTEM_PROJECT_ID,
      name: "System",
      rootPath,
      createdAt: Date.now(),
      colorLight: DEFAULT_PROJECT_COLOR_LIGHT,
      colorDark: DEFAULT_PROJECT_COLOR_DARK,
      hidden: true,
    };
    this.projects.set(project.id, project);
    this.save();
    return project;
  }

  /**
   * Register a provisional project (used by project assistant sessions).
   * Provisional projects are real persisted projects with `provisional: true`.
   * For scaffolding (Path C), the rootPath may not exist yet — skip existence check.
   * Deduplicates: if a provisional project already exists at the same rootPath, reuse it.
   */
  registerProvisional(name: string, rootPath: string): RegisteredProject {
    if (!path.isAbsolute(rootPath)) {
      throw new Error(`rootPath must be absolute, got: ${rootPath}`);
    }
    // Provisional projects are transient assistant scaffolds — the user is
    // not shown a path-confirmation dialog at this point. Silently use the
    // canonical path if rootPath is a symlink, matching the
    // acceptCanonical=true branch of register().
    {
      const sym = detectSymlinkRoot(rootPath);
      if (sym.symlink) rootPath = sym.canonical;
    }

    // Deduplicate: reuse existing provisional project at same path
    const normalized = path.resolve(rootPath);
    for (const p of this.projects.values()) {
      if (p.provisional && path.resolve(p.rootPath) === normalized) {
        return p;
      }
    }

    // Scaffold .bobbit directories only if rootPath exists
    if (fs.existsSync(rootPath)) {
      const bobbitDir = path.join(rootPath, ".bobbit");
      fs.mkdirSync(path.join(bobbitDir, "config"), { recursive: true });
      fs.mkdirSync(path.join(bobbitDir, "state"), { recursive: true });
    }

    const project: RegisteredProject = {
      id: randomUUID(),
      name,
      rootPath,
      createdAt: Date.now(),
      colorLight: DEFAULT_PROJECT_COLOR_LIGHT,
      colorDark: DEFAULT_PROJECT_COLOR_DARK,
      provisional: true,
    };

    this.projects.set(project.id, project);
    this.save();
    return project;
  }

  /**
   * Promote a provisional project to a full project.
   * Clears `provisional` flag and optionally updates the name.
   * If rootPath now exists but wasn't scaffolded, scaffold it.
   */
  promote(id: string, updates: { name?: string }): RegisteredProject {
    const project = this.projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    // Idempotent — if already promoted, just update the name and return
    delete project.provisional;
    if (updates.name !== undefined) project.name = updates.name;

    // Scaffold .bobbit directories if they don't exist yet (e.g. scaffolding path)
    if (fs.existsSync(project.rootPath)) {
      const bobbitDir = path.join(project.rootPath, ".bobbit");
      fs.mkdirSync(path.join(bobbitDir, "config"), { recursive: true });
      fs.mkdirSync(path.join(bobbitDir, "state"), { recursive: true });
    }

    this.projects.set(id, project);
    this.save();
    return project;
  }

  /**
   * Remove a provisional project. Safety guard: throws if the project is not provisional.
   * Does NOT delete files on disk — only unregisters.
   */
  removeProvisional(id: string): void {
    const project = this.projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (!project.provisional) throw new Error(`Cannot remove non-provisional project ${id} via removeProvisional()`);
    this.projects.delete(id);
    this.save();
  }

}
