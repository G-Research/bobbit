import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface RegisteredProject {
  id: string;           // UUID
  name: string;         // Display name
  rootPath: string;     // Absolute path to project directory
  createdAt: number;    // Epoch ms
  color?: string;       // Optional accent color
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
      const arr: RegisteredProject[] = JSON.parse(raw);
      this.projects.clear();
      for (const p of arr) {
        this.projects.set(p.id, p);
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

  /**
   * Register a new project.
   * - Validates rootPath is absolute.
   * - Scaffolds `.bobbit/config/` and `.bobbit/state/` if they don't exist.
   * - Persists immediately.
   */
  register(name: string, rootPath: string, color?: string): RegisteredProject {
    if (!path.isAbsolute(rootPath)) {
      throw new Error(`rootPath must be absolute, got: ${rootPath}`);
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

    const project: RegisteredProject = {
      id: randomUUID(),
      name,
      rootPath,
      createdAt: Date.now(),
      ...(color ? { color } : {}),
    };

    this.projects.set(project.id, project);
    this.save();
    return project;
  }

  /** Update mutable fields (name, color) of an existing project. */
  update(
    id: string,
    updates: Partial<Pick<RegisteredProject, "name" | "color">>,
  ): RegisteredProject {
    const project = this.projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);

    if (updates.name !== undefined) project.name = updates.name;
    if (updates.color !== undefined) project.color = updates.color;

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

    const projectName = name ?? path.basename(serverCwd) || "default";
    return this.register(projectName, serverCwd);
  }
}
