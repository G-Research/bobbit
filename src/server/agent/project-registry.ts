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
  position?: number;    // Visible project ordering; hidden/system projects do not participate
  provisional?: boolean; // True while a project assistant is setting up this project
  /**
   * True for synthetic projects that should be filtered out of UI listings
   * but still resolvable by id (e.g. the "system" project used as the
   * persistence anchor for system-scope tool-assistant sessions). Hidden
   * projects must never appear in /api/projects responses.
   */
  hidden?: boolean;
  /**
   * Optional parent project id for hierarchical role/field inheritance.
   * When set, ConfigCascade walks the ancestor chain when resolving
   * role `model`/`thinkingLevel`/`promptTemplate` fields. Cycles and
   * references to hidden/provisional/non-existent projects are rejected
   * by `update()`.
   */
  parentProjectId?: string;
}

/** Stable id for the synthetic system project. */
export const SYSTEM_PROJECT_ID = "system";

export type ProjectOrderErrorCode = "invalid_project_order" | "stale_project_order";

export class ProjectOrderError extends Error {
  constructor(
    public readonly code: ProjectOrderErrorCode,
    message: string,
    public readonly details: { expectedProjectIds?: string[]; receivedProjectIds?: string[] } = {},
  ) {
    super(message);
    this.name = "ProjectOrderError";
  }
}

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

  private participatesInVisibleOrder(project: RegisteredProject): boolean {
    return !project.hidden && project.id !== SYSTEM_PROJECT_ID;
  }

  private positionSortValue(project: RegisteredProject): number {
    return Number.isFinite(project.position) ? project.position! : Number.POSITIVE_INFINITY;
  }

  private compareVisibleOrderEntries(
    a: { project: RegisteredProject; index: number },
    b: { project: RegisteredProject; index: number },
  ): number {
    const posA = this.positionSortValue(a.project);
    const posB = this.positionSortValue(b.project);
    if (posA !== posB) return posA - posB;
    if (a.project.createdAt !== b.project.createdAt) return a.project.createdAt - b.project.createdAt;
    return a.index - b.index;
  }

  private normalizeVisiblePositions(): boolean {
    const entries = [...this.projects.values()].map((project, index) => ({ project, index }));
    let changed = false;

    for (const { project } of entries) {
      if (!this.participatesInVisibleOrder(project) && project.position !== undefined) {
        delete project.position;
        changed = true;
      }
    }

    const visible = entries
      .filter(entry => this.participatesInVisibleOrder(entry.project))
      .sort((a, b) => this.compareVisibleOrderEntries(a, b));

    for (let i = 0; i < visible.length; i++) {
      const project = visible[i].project;
      if (project.position !== i) {
        project.position = i;
        changed = true;
      }
    }

    return changed;
  }

  private nextVisiblePosition(): number {
    this.normalizeVisiblePositions();
    const positions = [...this.projects.values()]
      .filter(project => this.participatesInVisibleOrder(project))
      .map(project => project.position)
      .filter((position): position is number => Number.isFinite(position));
    return positions.length > 0 ? Math.max(...positions) + 1 : 0;
  }

  /** Read projects from disk. Missing file is treated as empty registry. */
  load(): void {
    let changed = false;
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
          changed = true;
        }
        this.projects.set(p.id, p as RegisteredProject);
      }
    } catch {
      // File missing or corrupt — start empty
      this.projects.clear();
      return;
    }

    if (this.normalizeVisiblePositions()) changed = true;
    if (changed) {
      try { this.save(); } catch (err) { console.warn(`[project-registry] failed to persist migrations: ${err}`); }
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

  /** Return all registered projects. Visible projects are ordered by position; hidden projects are appended by createdAt. */
  list(): RegisteredProject[] {
    return [...this.projects.values()]
      .map((project, index) => ({ project, index }))
      .sort((a, b) => {
        const visibleA = this.participatesInVisibleOrder(a.project);
        const visibleB = this.participatesInVisibleOrder(b.project);
        if (visibleA && visibleB) return this.compareVisibleOrderEntries(a, b);
        if (visibleA !== visibleB) return visibleA ? -1 : 1;
        if (a.project.createdAt !== b.project.createdAt) return a.project.createdAt - b.project.createdAt;
        return a.index - b.index;
      })
      .map(entry => entry.project);
  }

  setVisibleOrder(projectIds: string[]): RegisteredProject[] {
    if (!Array.isArray(projectIds) || projectIds.some(id => typeof id !== "string")) {
      throw new ProjectOrderError("invalid_project_order", "projectIds must be an array of strings");
    }

    const seen = new Set<string>();
    for (const id of projectIds) {
      if (seen.has(id)) {
        throw new ProjectOrderError("invalid_project_order", `Duplicate project id in order: ${id}`);
      }
      seen.add(id);
    }

    const expectedProjectIds = this.list()
      .filter(project => this.participatesInVisibleOrder(project))
      .map(project => project.id);
    const receivedProjectIds = [...projectIds];

    for (const id of receivedProjectIds) {
      const project = this.projects.get(id);
      if (!project || !this.participatesInVisibleOrder(project)) {
        throw new ProjectOrderError("invalid_project_order", `Invalid project id in order: ${id}`);
      }
    }

    const expectedSet = new Set(expectedProjectIds);
    if (receivedProjectIds.length !== expectedProjectIds.length || receivedProjectIds.some(id => !expectedSet.has(id))) {
      throw new ProjectOrderError("stale_project_order", "Project order is stale", {
        expectedProjectIds,
        receivedProjectIds,
      });
    }

    receivedProjectIds.forEach((id, position) => {
      const project = this.projects.get(id)!;
      project.position = position;
    });
    this.save();
    return this.list().filter(project => this.participatesInVisibleOrder(project));
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
      position: this.nextVisiblePosition(),
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
    updates: Partial<Pick<RegisteredProject, "name" | "color" | "rootPath" | "palette" | "colorLight" | "colorDark">> & {
      parentProjectId?: string | null;
    },
  ): RegisteredProject {
    const project = this.projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);

    if (updates.parentProjectId !== undefined) {
      const v = updates.parentProjectId;
      if (v === null || v === "") {
        delete project.parentProjectId;
      } else if (typeof v === "string") {
        if (v === id) {
          throw new Error(`parentProjectId cannot reference self (${id})`);
        }
        const target = this.projects.get(v);
        if (!target) throw new Error(`parentProjectId references unknown project: ${v}`);
        if (target.hidden) throw new Error(`parentProjectId cannot reference a hidden project: ${v}`);
        if (target.provisional) throw new Error(`parentProjectId cannot reference a provisional project: ${v}`);
        // Cycle detection: walk target's ancestor chain and refuse if id reappears.
        const seen = new Set<string>([id]);
        let cursor: string | undefined = target.parentProjectId;
        let hops = 0;
        while (cursor && hops < 64) {
          if (seen.has(cursor)) {
            throw new Error(`parentProjectId would create a cycle through ${cursor}`);
          }
          seen.add(cursor);
          const next: RegisteredProject | undefined = this.projects.get(cursor);
          if (!next) break;
          cursor = next.parentProjectId;
          hops++;
        }
        project.parentProjectId = v;
      } else {
        throw new Error(`parentProjectId must be a string or null`);
      }
    }

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
      } else if (!project.palette) {
        // Clearing palette → reset accents to defaults (unless caller supplied explicit overrides)
        if (updates.colorLight === undefined) {
          project.colorLight = DEFAULT_PROJECT_COLOR_LIGHT;
        }
        if (updates.colorDark === undefined) {
          project.colorDark = DEFAULT_PROJECT_COLOR_DARK;
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
  /**
   * Return ancestor projects in order (closest parent first). Stops at the
   * root, on a missing reference, or on any cycle (defensive — bounded to
   * 32 hops).
   */
  getAncestors(projectId: string): RegisteredProject[] {
    const out: RegisteredProject[] = [];
    const seen = new Set<string>([projectId]);
    let cursor: string | undefined = this.projects.get(projectId)?.parentProjectId;
    let hops = 0;
    while (cursor && hops < 32) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const next = this.projects.get(cursor);
      if (!next) break;
      out.push(next);
      cursor = next.parentProjectId;
      hops++;
    }
    return out;
  }

  remove(id: string): void {
    if (!this.projects.has(id)) {
      throw new Error(`Project not found: ${id}`);
    }
    this.projects.delete(id);
    this.normalizeVisiblePositions();
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
    if (existing) {
      let changed = false;
      if (!existing.hidden) {
        existing.hidden = true;
        changed = true;
      }
      if (existing.position !== undefined) {
        delete existing.position;
        changed = true;
      }
      if (changed) {
        this.normalizeVisiblePositions();
        this.save();
      }
      return existing;
    }
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
      position: this.nextVisiblePosition(),
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
    this.normalizeVisiblePositions();
    this.save();
  }

}
