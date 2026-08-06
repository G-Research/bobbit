import path from "node:path";
import { ProjectContext, resolveProjectContextPaths } from "./project-context.js";
import { GateStore } from "./gate-store.js";
import {
  canonicalGateStoreStateRoot,
  releaseGateStorePreload,
  type GateStoreMigrationWorkerResult,
} from "./gate-store-migration-worker.js";
import { ProjectRegistry } from "./project-registry.js";
import type { GoalTriggerDispatcher } from "./goal-trigger-dispatcher.js";
import type { PersistedGoal } from "./goal-store.js";
import type { PersistedSession } from "./session-store.js";
import type { SearchResults, SearchResult } from "../search/types.js";
import type { ProjectConfigStore } from "./project-config-store.js";
import { realFs, type Clock, type CommandRunner, type FsLike } from "../gateway-deps.js";
import type { RemoteGitPolicy } from "../skills/git.js";
import { bootLog, SLOW_PHASE_MS } from "../boot-profile.js";

/**
 * Minimal session-resolver surface needed by the search orphan filter.
 * Kept as a structural type to avoid a circular import with session-manager.
 */
interface SessionResolver {
  getPersistedSession(id: string): PersistedSession | undefined;
}

type StateRootPreparation = {
  promise: Promise<GateStoreMigrationWorkerResult>;
  consumers: number;
};

type StateRootPreparationConsumer = {
  result: Promise<GateStoreMigrationWorkerResult>;
  release(): void;
};

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
  private _sessionResolverWarned = false;
  /** Changes whenever a context is created or removed. */
  private contextTopologyVersion = 0;
  /** Stable between observations; increases when task state or topology changes. */
  private taskGenerationToken = 0;
  private lastObservedTaskGenerationSum = 0;
  private lastObservedTaskTopologyVersion = 0;
  /**
   * Shared dispatcher for `goal_created` / `goal_archived` staff triggers.
   * Wired post-boot by `server.ts` once the staff/inbox managers exist.
   * Stored here so every existing AND every future-lazy-created
   * ProjectContext gets the same dispatcher reference.
   */
  private goalTriggerDispatcher: GoalTriggerDispatcher | null = null;
  /**
   * Optional post-create configurator applied to every context (existing and
   * lazily-created). `server.ts` uses it to wire each context's `toolManager`
   * with its market-pack `tools/` roots provider so market-pack tools resolve
   * at runtime (design §3.2 / finding #1).
   */
  private contextConfigurator: ((ctx: ProjectContext) => void) | null = null;
  /** Coalesced boot preparation. Snapshot projects are fenced from sync lazy publication until it settles. */
  private initialization: Promise<void> | null = null;
  private initializingProjectIds = new Set<string>();
  /**
   * Production gate migration barriers are keyed by the physical state root,
   * not project ID. Registry aliases must never start a second worker or let a
   * synchronous lookup construct GateStore against the same legacy file.
   */
  private preparingStateRoots = new Map<string, StateRootPreparation>();
  private failedStateRoots = new Set<string>();
  /** Identical project requests also share context construction/publication. */
  private preparingContexts = new Map<string, Promise<ProjectContext | null>>();

  constructor(
    registry: ProjectRegistry,
    private readonly options: { headquartersProjectConfigStore?: ProjectConfigStore; fsImpl?: FsLike; clock?: Clock; commandRunner?: CommandRunner; remotePolicy?: RemoteGitPolicy; worktreeSetupRuntime?: { skipNpmCi?: boolean; recordSetupPath?: string } } = {},
  ) {
    this.registry = registry;
  }

  /**
   * Late-bind a configurator run against every context (existing + future).
   * Idempotent and order-independent with respect to `initAll()`/`getOrCreate`.
   */
  setContextConfigurator(configurator: (ctx: ProjectContext) => void): void {
    this.contextConfigurator = configurator;
    for (const ctx of this.contexts.values()) {
      try { configurator(ctx); } catch (err) { console.warn("[pcm] context configurator failed:", err); }
    }
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

  /**
   * Initialize contexts for the registered-project snapshot. Production state
   * roots are prepared off-loop as one barrier before any snapshot context is
   * constructed or published. Concurrent callers share the same barrier.
   */
  initAll(): Promise<void> {
    if (this.initialization) return this.initialization;

    const t0 = Date.now();
    const projects = this.registry.list();
    for (const project of projects) this.initializingProjectIds.add(project.id);

    let operation!: Promise<void>;
    operation = (async () => {
      // Every registry entry owns a consumer before any coalesced worker can
      // settle. A rejected aggregate therefore cannot lose a sibling's fulfilled
      // one-shot claim, and one abandoning alias cannot release another alias's
      // still-adoptable claim.
      const consumers = this.usesRealFs()
        ? projects.map(project => this.prepareStateRoot(resolveProjectContextPaths(project).stateDir))
        : [];
      try {
        // FsLike-backed unit fixtures intentionally retain GateStore's
        // deterministic synchronous migration seam; real project roots must go
        // through the worker so legacy parse/stringify never runs on the gateway
        // thread. Promise.all also lets GateStore.prepare coalesce aliased roots.
        const preparations = consumers.length > 0
          ? await Promise.all(consumers.map(consumer => consumer.result))
          : [];

        // Publication order remains registry order and begins only after every
        // worker succeeded. Each parsed snapshot is handed directly to its one
        // immediate constructor and is never retained as a reusable cache.
        for (let index = 0; index < projects.length; index++) {
          const project = projects[index]!;
          if (this.contexts.has(project.id)) continue;
          const pt0 = Date.now();
          this.createAndPublishContext(project.id, preparations[index]);
          const dt = Date.now() - pt0;
          if (dt >= SLOW_PHASE_MS) bootLog(`[boot] context open: project=${project.id} in ${dt}ms`);
        }
        bootLog(`[boot] initAll opened ${projects.length} project context(s) in ${Date.now() - t0}ms`);
      } finally {
        // A consumer release waits for its own worker result when necessary.
        // Consumed claims ignore the eventual release; every other fulfilled
        // claim is deterministically abandoned even after partial init failure.
        for (const consumer of consumers) consumer.release();
        for (const project of projects) this.initializingProjectIds.delete(project.id);
        if (this.initialization === operation) this.initialization = null;
      }
    })();
    this.initialization = operation;
    return operation;
  }

  /**
   * Prepare a production gate root off-loop, then construct and publish its
   * ProjectContext. The fence is installed synchronously before this method
   * returns a Promise, so getOrCreate() cannot enter GateStore's legacy
   * constructor path during the worker window.
   */
  prepareAndGetOrCreate(projectId: string): Promise<ProjectContext | null> {
    const existing = this.contexts.get(projectId);
    if (existing) return Promise.resolve(existing);

    const pending = this.preparingContexts.get(projectId);
    if (pending) return pending;

    const project = this.registry.get(projectId);
    if (!project) return Promise.resolve(null);

    // FsLike-backed fixtures intentionally keep deterministic synchronous
    // construction; no worker can operate on their in-memory filesystem.
    if (!this.usesRealFs()) return Promise.resolve(this.createAndPublishContext(projectId));

    if (this.initializingProjectIds.has(projectId) && this.initialization) {
      return this.initialization.then(() => this.contexts.get(projectId) ?? null);
    }

    const stateDir = resolveProjectContextPaths(project).stateDir;
    const expectedRoot = this.stateRootKey(stateDir);
    const preparation = this.prepareStateRoot(stateDir);
    let operation!: Promise<ProjectContext | null>;
    operation = preparation.result.then(prepared => {
      const alreadyPublished = this.contexts.get(projectId);
      if (alreadyPublished) return alreadyPublished;

      // Registration can be removed while a worker is running. Never publish a
      // context for a stale registry entry. A root update is retried behind the
      // new root's own synchronous fence.
      const currentProject = this.registry.get(projectId);
      if (!currentProject) return null;
      const currentRoot = this.stateRootKey(resolveProjectContextPaths(currentProject).stateDir);
      if (currentRoot !== expectedRoot) {
        if (this.preparingContexts.get(projectId) === operation) this.preparingContexts.delete(projectId);
        return this.prepareAndGetOrCreate(projectId);
      }
      return this.createAndPublishContext(projectId, prepared);
    }).finally(() => {
      // Only the final abandoning consumer releases a shared one-shot claim.
      // Once a constructor adopts it, the release is intentionally a no-op.
      preparation.release();
      if (this.preparingContexts.get(projectId) === operation) this.preparingContexts.delete(projectId);
    });
    this.preparingContexts.set(projectId, operation);
    return operation;
  }

  /** Get or lazily create a ProjectContext. */
  getOrCreate(projectId: string): ProjectContext | null {
    const existing = this.contexts.get(projectId);
    if (existing) return existing;

    const project = this.registry.get(projectId);
    if (!project) return null;

    // A synchronous accessor must not bypass either boot's all-project barrier
    // or a root-keyed post-boot worker. Production legacy state is never safe
    // to construct until prepareAndGetOrCreate() has completed successfully.
    if (this.initializingProjectIds.has(projectId)) return null;
    if (!this.usesRealFs()) return this.createAndPublishContext(projectId);

    const stateDir = resolveProjectContextPaths(project).stateDir;
    const root = this.stateRootKey(stateDir);
    if (this.preparingStateRoots.has(root) || this.failedStateRoots.has(root)) return null;
    // Persisted production GateStore hydration is always asynchronous. A truly
    // new root has no JSON to hydrate and retains the established synchronous
    // construction path; existing roots must use prepareAndGetOrCreate.
    if (!this.hasGatePersistence(stateDir)) return this.createAndPublishContext(projectId);
    return null;
  }

  private usesRealFs(): boolean {
    return !this.options.fsImpl || this.options.fsImpl === realFs;
  }

  private stateRootKey(stateDir: string): string {
    return canonicalGateStoreStateRoot(stateDir);
  }

  private hasGatePersistence(stateDir: string): boolean {
    const fsImpl = this.options.fsImpl ?? realFs;
    return fsImpl.existsSync(path.join(stateDir, "gate-records", "v2"))
      || fsImpl.existsSync(path.join(stateDir, "gates.json"));
  }

  /** Install a root fence before launching the worker and coalesce aliases. */
  private prepareStateRoot(stateDir: string): StateRootPreparationConsumer {
    const root = this.stateRootKey(stateDir);
    let preparation = this.preparingStateRoots.get(root);
    if (!preparation) {
      let resolveFence!: (result: GateStoreMigrationWorkerResult) => void;
      let rejectFence!: (reason?: unknown) => void;
      const fence = new Promise<GateStoreMigrationWorkerResult>((resolve, reject) => {
        resolveFence = resolve;
        rejectFence = reject;
      });
      preparation = { promise: fence, consumers: 0 };
      this.preparingStateRoots.set(root, preparation);

      let worker: Promise<unknown> | undefined;
      try {
        worker = GateStore.prepare(stateDir);
      } catch (error) {
        this.failedStateRoots.add(root);
        if (this.preparingStateRoots.get(root) === preparation) this.preparingStateRoots.delete(root);
        rejectFence(error);
      }
      // A synchronous launch failure already rejected the fence. Avoid attaching
      // a second rejection path while retaining the same consumer contract.
      if (worker) {
        void worker.then(
          result => {
            this.failedStateRoots.delete(root);
            if (this.preparingStateRoots.get(root) === preparation) this.preparingStateRoots.delete(root);
            resolveFence(result as GateStoreMigrationWorkerResult);
          },
          (error) => {
            this.failedStateRoots.add(root);
            if (this.preparingStateRoots.get(root) === preparation) this.preparingStateRoots.delete(root);
            rejectFence(error);
          },
        );
      }
    }

    preparation.consumers++;
    let released = false;
    return {
      result: preparation.promise,
      release: () => {
        if (released) return;
        released = true;
        preparation!.consumers--;
        if (preparation!.consumers !== 0) return;
        // The aggregate may reject before a sibling worker fulfills. Attach
        // cleanup to that result so no successfully prepared owner is orphaned.
        void preparation!.promise.then(
          prepared => {
            // A new alias may join the still-running root after the count first
            // reaches zero. Re-check at settlement before abandoning its claim.
            // Structural test seams may omit a preload entirely; production
            // worker results always carry the one-shot claim.
            if (preparation!.consumers === 0 && prepared.preload) releaseGateStorePreload(prepared.preload);
          },
          () => undefined,
        );
      },
    };
  }

  private createAndPublishContext(projectId: string, preparation?: GateStoreMigrationWorkerResult): ProjectContext | null {
    const existing = this.contexts.get(projectId);
    if (existing) return existing;
    const project = this.registry.get(projectId);
    if (!project) return null;

    const ctx = new ProjectContext(project, { ...this.options, gateStorePreload: preparation?.preload });
    ctx.open();
    // Propagate any post-boot dispatcher wiring to lazily-created contexts.
    if (this.goalTriggerDispatcher) {
      ctx.setGoalTriggerDispatcher(this.goalTriggerDispatcher);
    }
    // Apply any post-boot context configurator (e.g. market tool roots).
    if (this.contextConfigurator) {
      try { this.contextConfigurator(ctx); } catch (err) { console.warn("[pcm] context configurator failed:", err); }
    }
    this.contexts.set(projectId, ctx);
    this.contextTopologyVersion++;
    return ctx;
  }

  /**
   * Late-bound: register the shared `GoalTriggerDispatcher` and wire it into
   * every existing context. Subsequent `getOrCreate` calls will pick up the
   * dispatcher automatically. Safe to call before or after `initAll()`.
   */
  setGoalTriggerDispatcher(dispatcher: GoalTriggerDispatcher | null): void {
    this.goalTriggerDispatcher = dispatcher;
    for (const ctx of this.contexts.values()) {
      ctx.setGoalTriggerDispatcher(dispatcher);
    }
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
    for (const ctx of this.visible()) {
      goals.push(...ctx.goalStore.getLive());
    }
    return goals.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** All live (non-archived) sessions across all projects. */
  getAllLiveSessions(): PersistedSession[] {
    const sessions: PersistedSession[] = [];
    for (const ctx of this.visible()) {
      sessions.push(...ctx.sessionStore.getLive());
    }
    return sessions;
  }

  /** All goals (including archived) across all projects. */
  getAllGoals(): PersistedGoal[] {
    const goals: PersistedGoal[] = [];
    for (const ctx of this.visible()) {
      goals.push(...ctx.goalStore.getAll());
    }
    return goals.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** All sessions (including archived) across all projects. */
  getAllSessions(): PersistedSession[] {
    const sessions: PersistedSession[] = [];
    for (const ctx of this.visible()) {
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
      includeArchived?: boolean;
    } = {},
  ): Promise<SearchResults> {
    const rawResults: SearchResult[] = [];
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    for (const ctx of this.contexts.values()) {
      // Skip hidden contexts (e.g. synthetic system project) — they
      // must never surface in user-facing search results.
      if (ctx.project.hidden) continue;
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
        includeArchived: opts.includeArchived ?? false,
      });
      const { results } = out instanceof Promise ? await out : out;

      rawResults.push(...results);
    }

    // Orphan filter + weak-match drop (message-only). Weak metadata matches
    // are valid index rows that happened to rank for this query, so omit them
    // from this response without deleting their parent session's message index.
    const orphaned: SearchResult[] = [];
    const filtered = rawResults.filter((hit) => {
      if (!this._hitExists(hit)) { orphaned.push(hit); return false; }
      if (hit.type === "message" && hit.matchedOn === "metadata") {
        // Phantom match — token hit metadata only, user can't see why.
        return false;
      }
      return true;
    });

    // Opportunistic cleanup is only for rows whose backing entity is gone.
    if (orphaned.length > 0) this._scheduleOpportunisticCleanup(orphaned);

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
        // Fail-open when session resolver isn't wired (e.g. unit tests or
        // alternate bootstraps that skip setDependencies). Silently dropping
        // every session/message hit is worse than returning a stale row.
        if (!this.sessionResolver) {
          this._warnSessionResolverMissing();
          return true;
        }
        const sessionId = hit.sessionId ?? hit.id;
        return this.sessionResolver.getPersistedSession(sessionId) !== undefined;
      }
      case "message":
        if (!this.sessionResolver) {
          this._warnSessionResolverMissing();
          return true;
        }
        if (!hit.sessionId) return false;
        return this.sessionResolver.getPersistedSession(hit.sessionId) !== undefined;
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
  /** One-time warning when the session resolver wiring is missing. */
  private _warnSessionResolverMissing(): void {
    if (this._sessionResolverWarned) return;
    this._sessionResolverWarned = true;
    console.warn("[search] orphan filter disabled: sessionManager not wired");
  }

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

  /**
   * Monotonic process-local cache token for cross-project task lookups.
   *
   * A raw sum of store generations is insufficient: removing a context can
   * revisit an earlier sum, while adding a context whose persisted tasks load
   * at generation zero does not alter the sum at all. Including an explicit
   * topology version and translating observed changes into a monotonic token
   * prevents both states from colliding with an older cache entry.
   */
  getTaskGeneration(): number {
    let generationSum = 0;
    for (const ctx of this.contexts.values()) {
      generationSum += ctx.taskStore.getGeneration();
    }

    if (
      generationSum !== this.lastObservedTaskGenerationSum
      || this.contextTopologyVersion !== this.lastObservedTaskTopologyVersion
    ) {
      this.taskGenerationToken++;
      this.lastObservedTaskGenerationSum = generationSum;
      this.lastObservedTaskTopologyVersion = this.contextTopologyVersion;
    }

    return this.taskGenerationToken;
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  /** Close all contexts on shutdown. Awaits every context's async close so
   *  the caller (server shutdown / test teardown) can safely remove the temp
   *  state dir only after all pending search flushes have settled. */
  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.contexts.values()].map((ctx) => ctx.close()));
    if (this.contexts.size > 0) {
      this.contexts.clear();
      this.contextTopologyVersion++;
    }
  }

  /** Remove a context when a project is unregistered. The returned barrier
   *  settles only after all context-owned background work has stopped. */
  async remove(projectId: string): Promise<void> {
    const ctx = this.contexts.get(projectId);
    if (ctx) {
      await ctx.close();
      this.contexts.delete(projectId);
      this.contextTopologyVersion++;
    }
  }

  /**
   * Iterate **every** context the manager owns, including hidden ones
   * (e.g. the synthetic system project registered for system-scope
   * tool-assistant sessions).
   *
   * Use this for callers that legitimately need every context:
   * `getContextForSession`, `findStoreForStaff`, MCP discovery, etc.
   *
   * If you are iterating to do worktree/pool/UI work where the system
   * project must be skipped, use {@link visible} instead.
   */
  all(): IterableIterator<ProjectContext> {
    return this.contexts.values();
  }

  /**
   * Iterate only **visible** contexts — i.e. excluding `hidden: true`
   * projects (the synthetic system project).
   *
   * Use this for worktree sweepers, worktree-pool init, goal/task
   * pool-resolver wiring, maintenance endpoints, and user-facing
   * listings/aggregations. The hidden system project must never
   * participate in any of these flows; iterating it caused
   * `pool/_pool-*` branches to be allocated in unrelated host repos
   * when the bobbit state dir was nested inside one (see
   * `tests/system-project-pool-leak.test.ts`).
   */
  *visible(): IterableIterator<ProjectContext> {
    for (const ctx of this.contexts.values()) {
      if (ctx.project.hidden) continue;
      yield ctx;
    }
  }

  /** Number of initialized project contexts. */
  get size(): number {
    return this.contexts.size;
  }
}
