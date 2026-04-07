import { ProjectContext } from "./project-context.js";
import { ProjectRegistry } from "./project-registry.js";
import type { PersistedGoal } from "./goal-store.js";
import type { PersistedSession } from "./session-store.js";
import type { SearchResults, SearchResult } from "../search/search-index.js";

/**
 * Central registry of ProjectContext instances.
 *
 * Manages per-project state contexts and provides aggregation methods
 * for cross-project queries (goals, sessions, search).
 */
export class ProjectContextManager {
  private contexts = new Map<string, ProjectContext>();
  private registry: ProjectRegistry;
  private defaultProjectId: string | null = null;

  constructor(registry: ProjectRegistry) {
    this.registry = registry;
  }

  /** Initialize contexts for all registered projects. */
  initAll(): void {
    const projects = this.registry.list();
    for (const project of projects) {
      this.getOrCreate(project.id);
    }
    // First project is the default (server CWD, registered via ensureDefaultProject)
    if (projects.length > 0 && !this.defaultProjectId) {
      this.defaultProjectId = projects[0].id;
    }
  }

  /** Get or lazily create a ProjectContext. */
  getOrCreate(projectId: string): ProjectContext | null {
    let ctx = this.contexts.get(projectId);
    if (ctx) return ctx;

    const project = this.registry.get(projectId);
    if (!project) return null;

    ctx = new ProjectContext(project);
    ctx.open();
    this.contexts.set(projectId, ctx);

    // Set as default if this is the first context
    if (!this.defaultProjectId) {
      this.defaultProjectId = projectId;
    }

    return ctx;
  }

  /** @deprecated Use explicit projectId resolution instead. The default project should not be used as a fallback. */
  getDefault(): ProjectContext {
    if (!this.defaultProjectId) {
      throw new Error("Default project context not initialized — call initAll() first");
    }
    const ctx = this.contexts.get(this.defaultProjectId);
    if (!ctx) {
      throw new Error(`Default project context not found for id=${this.defaultProjectId}`);
    }
    return ctx;
  }

  /**
   * Null-safe version of getDefault().
   * Returns null when no projects are registered (e.g. fresh folder with no .bobbit/).
   */
  getDefaultOrNull(): ProjectContext | null {
    if (!this.defaultProjectId) return null;
    return this.contexts.get(this.defaultProjectId) ?? null;
  }

  /** @deprecated Use explicit projectId resolution instead. The default project should not be used as a fallback. */
  getDefaultProjectId(): string {
    if (!this.defaultProjectId) {
      throw new Error("Default project not initialized — call initAll() first");
    }
    return this.defaultProjectId;
  }

  /**
   * Null-safe version of getDefaultProjectId().
   * Returns null when no projects are registered (e.g. fresh folder with no .bobbit/).
   * Use this in API creation endpoints that should return a clear error instead of crashing.
   */
  getDefaultProjectIdOrNull(): string | null {
    return this.defaultProjectId;
  }

  /** Get the underlying project registry. */
  getRegistry(): ProjectRegistry {
    return this.registry;
  }

  /** Resolve which project a goal belongs to by scanning all contexts. */
  getContextForGoal(goalId: string): ProjectContext | null {
    for (const ctx of this.contexts.values()) {
      if (ctx.goalStore.get(goalId)) return ctx;
    }
    return null;
  }

  /** Resolve which project a session belongs to by scanning all contexts. */
  getContextForSession(sessionId: string): ProjectContext | null {
    for (const ctx of this.contexts.values()) {
      if (ctx.sessionStore.get(sessionId)) return ctx;
    }
    return null;
  }

  // ── Aggregation methods ────────────────────────────────────────

  /** All live (non-archived) goals across all projects, sorted by updatedAt desc. */
  getAllLiveGoals(): PersistedGoal[] {
    const goals: PersistedGoal[] = [];
    for (const ctx of this.contexts.values()) {
      goals.push(...ctx.goalStore.getLive());
    }
    return goals.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** All live (non-archived) sessions across all projects. */
  getAllLiveSessions(): PersistedSession[] {
    const sessions: PersistedSession[] = [];
    for (const ctx of this.contexts.values()) {
      sessions.push(...ctx.sessionStore.getLive());
    }
    return sessions;
  }

  /** All goals (including archived) across all projects. */
  getAllGoals(): PersistedGoal[] {
    const goals: PersistedGoal[] = [];
    for (const ctx of this.contexts.values()) {
      goals.push(...ctx.goalStore.getAll());
    }
    return goals.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** All sessions (including archived) across all projects. */
  getAllSessions(): PersistedSession[] {
    const sessions: PersistedSession[] = [];
    for (const ctx of this.contexts.values()) {
      sessions.push(...ctx.sessionStore.getAll());
    }
    return sessions;
  }

  /** Aggregate search across all (or filtered) project indexes. */
  searchAll(
    query: string,
    opts: {
      type?: string;
      limit?: number;
      offset?: number;
      projectId?: string;
      projectNames?: Map<string, string>;
    } = {},
  ): SearchResults {
    const allResults: SearchResult[] = [];
    let totalCount = 0;
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    for (const ctx of this.contexts.values()) {
      // Filter by projectId if specified
      if (opts.projectId && ctx.project.id !== opts.projectId) continue;

      if (!ctx.searchIndex) continue;

      const { results, total } = ctx.searchIndex.search(query, {
        type: opts.type as any,
        // Fetch enough results for cross-project merging
        limit: limit + offset,
        offset: 0,
        projectId: undefined, // Already filtered above
        projectNames: opts.projectNames,
      });

      allResults.push(...results);
      totalCount += total;
    }

    // Sort by timestamp descending (most recent first) and apply pagination
    allResults.sort((a, b) => b.timestamp - a.timestamp);
    return {
      results: allResults.slice(offset, offset + limit),
      total: totalCount,
    };
  }

  // ── Generation counters (for polling optimization) ─────────────

  /** Sum of all goal store generations — any single project change is detected. */
  getGoalGeneration(): number {
    let gen = 0;
    for (const ctx of this.contexts.values()) {
      gen += ctx.goalStore.getGeneration();
    }
    return gen;
  }

  /** Sum of all session store generations — any single project change is detected. */
  getSessionGeneration(): number {
    let gen = 0;
    for (const ctx of this.contexts.values()) {
      gen += ctx.sessionStore.getGeneration();
    }
    return gen;
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  /** Close all contexts on shutdown. */
  closeAll(): void {
    for (const ctx of this.contexts.values()) {
      ctx.close();
    }
    this.contexts.clear();
  }

  /** Remove a context when a project is unregistered. */
  remove(projectId: string): void {
    const ctx = this.contexts.get(projectId);
    if (ctx) {
      ctx.close();
      this.contexts.delete(projectId);
    }
  }

  /** Iterate all contexts. */
  all(): IterableIterator<ProjectContext> {
    return this.contexts.values();
  }

  /** Number of initialized project contexts. */
  get size(): number {
    return this.contexts.size;
  }
}
