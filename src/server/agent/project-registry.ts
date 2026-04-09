import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_PROJECT_COLOR_DARK,
  DEFAULT_PROJECT_COLOR_LIGHT,
  PALETTE_PRIMARY_COLORS,
} from "../../shared/palette-colors.js";

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

  /** Find a project whose rootPath matches (normalized). */
  getByPath(rootPath: string): RegisteredProject | undefined {
    const normalized = path.resolve(rootPath);
    for (const p of this.projects.values()) {
      if (path.resolve(p.rootPath) === normalized) return p;
    }
    return undefined;
  }

  /** Find the project whose rootPath contains the given cwd (longest match wins). */
  findByCwd(cwd: string): RegisteredProject | undefined {
    const normalized = path.resolve(cwd).replace(/\\/g, "/").toLowerCase();
    let best: RegisteredProject | undefined;
    let bestLen = 0;
    for (const p of this.projects.values()) {
      const root = path.resolve(p.rootPath).replace(/\\/g, "/").toLowerCase();
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
    opts?: { color?: string; palette?: string; colorLight?: string; colorDark?: string },
  ): RegisteredProject {
    if (!path.isAbsolute(rootPath)) {
      throw new Error(`rootPath must be absolute, got: ${rootPath}`);
    }

    if (!fs.existsSync(rootPath)) {
      throw new Error("Project root path does not exist: " + rootPath);
    }

    // Check for duplicate rootPath
    const existing = this.getByPath(rootPath);
    if (existing) {
      throw new Error(`A project is already registered at ${rootPath} (id=${existing.id})`);
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
   * Callers (e.g. server.ts) should guard against removing the default project.
   */
  remove(id: string): void {
    if (!this.projects.has(id)) {
      throw new Error(`Project not found: ${id}`);
    }
    this.projects.delete(id);
    this.save();
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

  /**
   * Ensure the server CWD is registered as the default project.
   * If a project already exists at `serverCwd`, returns it.
   * Otherwise registers a new one with name defaulting to the directory basename.
   */
  ensureDefaultProject(
    serverCwd: string,
    name?: string,
  ): RegisteredProject {
    const existing = this.getByPath(serverCwd);
    if (existing) return existing;

    const projectName = name ?? (path.basename(serverCwd) || "default");
    return this.register(projectName, serverCwd);
  }
}
