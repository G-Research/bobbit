import { ProjectContext } from "./project-context.js";
import { ProjectRegistry } from "./project-registry.js";
import type { PersistedGoal } from "./goal-store.js";
import type { PersistedSession } from "./session-store.js";
import type { SearchResults, SearchResult } from "../search/types.js";

/**
 * Minimal session-resolver surface needed by the search orphan filter.
 * Kept as a structural type to avoid a circular import with session-manager.
 */
interface SessionResolver {
  getPersistedSession(id: string): PersistedSession | undefined;
}

/**
 * Central registry of ProjectContext instances.
 *
 * Manages per-project state contexts and provides aggregation methods
 * for cross-project queries (goals, sessions, search).
 */
export class ProjectContextManager {
  private contexts = new Map<string, ProjectContext>();
  private registry: ProjectRegistry;
  private sessionResolver: SessionResolver | null = null;

  constructor(registry: ProjectRegistry) {
    this.registry = registry;
  }

  /**
   * Wire dependencies used by cross-project services (notably the search
   * orphan filter). Called once during boot after the SessionManager is
   * instantiated. The manager itself is still constructed with only the
   * registry so existing callers need no change.
   */
  setDependencies(deps: { sessionManager: SessionResolver }): void {
    this.sessionResolver = deps.sessionManager;
  }

  /** Initialize contexts for all registered projects. */
  initAll(): void {
    for (const project of this.registry.list()) {
      this.getOrCreate(project.id);
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
    return ctx;
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
  async searchAll(
    query: string,
    opts: {
      type?: string;
      limit?: number;
      offset?: number;
      projectId?: string;
      projectNames?: Map<string, string>;
    } = {},
  ): Promise<SearchResults> {
    const rawResults: SearchResult[] = [];
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    for (const ctx of this.contexts.values()) {
      // Filter by projectId if specified
      if (opts.projectId && ctx.project.id !== opts.projectId) continue;

      if (!ctx.searchIndex) continue;

      const out = ctx.searchIndex.search(query, {
        type: opts.type as any,
        // Fetch enough results for cross-project merging
        limit: limit + offset,
        offset: 0,
        projectId: undefined, // Already filtered above
        projectNames: opts.projectNames,
      });
      const { results } = out instanceof Promise ? await out : out;

      rawResults.push(...results);
    }

    // Orphan filter + weak-match drop (message-only).
    const dropped: SearchResult[] = [];
    const filtered = rawResults.filter((hit) => {
      if (!this._hitExists(hit)) { dropped.push(hit); return false; }
      if (hit.type === "message" && hit.matchedOn === "metadata") {
        // Phantom match — token hit metadata only, user can't see why.
        dropped.push(hit);
        return false;
      }
      return true;
    });

    // Opportunistic cleanup — fire-and-forget.
    if (dropped.length > 0) this._scheduleOpportunisticCleanup(dropped);

    // Sort by timestamp descending (most recent first) and apply pagination.
    filtered.sort((a, b) => b.timestamp - a.timestamp);
    return {
      results: filtered.slice(offset, offset + limit),
      total: filtered.length,
    };
  }

  /**
   * Orphan existence check. Returns false for hits whose backing entity
   * (goal, session, message's parent session, staff) no longer exists, or
   * whose project is no longer registered.
   */
  private _hitExists(hit: SearchResult): boolean {
    // Project gate — registry is ultimate source of truth.
    if (hit.projectId && !this.registry.get(hit.projectId)) return false;

    const ctx = hit.projectId ? this.contexts.get(hit.projectId) : undefined;
    if (!ctx) return false;

    // SearchResult.id is now emitted as a bare entity id (the source
    // prefix is stripped in toSearchResult for goal/session/staff). For
    // messages, the parent session id is carried separately on hit.sessionId.
    switch (hit.type) {
      case "goal": {
        const goalId = hit.goalId ?? hit.id;
        return ctx.goalStore.get(goalId) !== undefined;
      }
      case "session": {
        const sessionId = hit.sessionId ?? hit.id;
        return this.sessionResolver?.getPersistedSession(sessionId) !== undefined;
      }
      case "message":
        if (!hit.sessionId) return false;
        return this.sessionResolver?.getPersistedSession(hit.sessionId) !== undefined;
      case "staff": {
        return ctx.staffStore.get(hit.id) !== undefined;
      }
      case "file":
        return true; // files source not in scope
      default:
        return true;
    }
  }

  /**
   * Fire-and-forget: when a hit is dropped as orphaned, enqueue a removal
   * from the owning project's search index so subsequent queries don't
   * return the same orphan row. Not awaited.
   */
  private _scheduleOpportunisticCleanup(dropped: SearchResult[]): void {
    // De-dupe session-level message purges — one op per session is enough.
    const messageSessionsPurged = new Set<string>();
    for (const hit of dropped) {
      const ctx = hit.projectId ? this.contexts.get(hit.projectId) : undefined;
      const idx = ctx?.searchIndex;
      if (!idx) continue;
      // hit.id is the bare entity id (prefix stripped in toSearchResult).
      // The remove* methods re-apply the goal:/session:/staff: prefix
      // internally when addressing the FlexSearch index.
      try {
        switch (hit.type) {
          case "goal":
            idx.removeGoal(hit.goalId ?? hit.id);
            break;
          case "session":
            idx.removeSession(hit.sessionId ?? hit.id);
            break;
          case "message":
            if (hit.sessionId && !messageSessionsPurged.has(hit.sessionId)) {
              messageSessionsPurged.add(hit.sessionId);
              idx.removeMessagesForSession(hit.sessionId);
            }
            break;
          case "staff":
            idx.removeStaff(hit.id);
            break;
        }
      } catch (err) {
        console.warn("[search] opportunistic cleanup failed:", err);
      }
    }
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
