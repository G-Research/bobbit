import type { ContextTraceStore, TraceDecisionOutcomeRow } from "./context-trace-store.js";
import type { ProjectContextManager } from "./project-context-manager.js";
import type { ProjectRegistry, RegisteredProject } from "./project-registry.js";
import type { Component } from "./project-config-store.js";

/**
 * Minimal context shape retained here to keep this lifecycle owner independent
 * of the decision contract. The context builder is the authoritative bounded
 * server-derived implementation.
 */
export interface ProjectImportDecisionContextSnapshot {
  readonly event: "projectImported";
  readonly projectId: string;
  readonly importId: string;
  readonly projectRoot: string;
  readonly ownedRoots: readonly string[];
  readonly components: readonly unknown[];
}

interface StoredImportRun {
  id: string;
  projectId: string;
  context: ProjectImportDecisionContextSnapshot;
  createdAt: string;
  completedAt?: string;
  hooks: Record<string, { state: "pending" | "completed"; completedAt?: string; outcome?: "applied" | "superseded" | "denied" | "dropped" | "error" }>;
}

interface ImportRunStore {
  getImportRun?(importId: string): StoredImportRun | undefined;
  ensureImportRun(run: StoredImportRun): { created: boolean; run: StoredImportRun };
}

interface ProjectImportDispatcher {
  dispatchProjectImport(projectId: string, importId: string): Promise<readonly TraceDecisionOutcomeRow[]>;
}

export interface ProjectImportDecisionCoordinatorDeps {
  registry: Pick<ProjectRegistry, "get" | "list">;
  projectContextManager: Pick<ProjectContextManager, "getOrCreate">;
  dispatcher: ProjectImportDispatcher;
  buildContext(input: { project: Pick<RegisteredProject, "id" | "rootPath">; importId: string; components: readonly Component[] }): ProjectImportDecisionContextSnapshot;
  now?: () => number;
  /** Project/import-run diagnostics use a separate redacted stream, never a session id. */
  trace?: Pick<ContextTraceStore, "appendProjectImportTrace">;
  onError?: (projectId: string, error: unknown) => void;
}

/**
 * Owns the import boundary only: it creates one immutable run snapshot then
 * delegates individual active-hook admission and durable completion to the
 * decision dispatcher. It never creates a session or a prompt.
 */
export class ProjectImportDecisionCoordinator {
  private readonly running = new Map<string, Promise<readonly TraceDecisionOutcomeRow[]>>();
  private readonly now: () => number;

  constructor(private readonly deps: ProjectImportDecisionCoordinatorDeps) {
    this.now = deps.now ?? Date.now;
  }

  dispatch(projectId: string, importId: string): Promise<readonly TraceDecisionOutcomeRow[]> {
    const key = `${projectId}:${importId}`;
    const existing = this.running.get(key);
    if (existing) return existing;
    const work = this.dispatchOne(projectId, importId).finally(() => this.running.delete(key));
    this.running.set(key, work);
    return work;
  }

  /** Reconcile only a ready marker. Configuring runs lack a durable body snapshot. */
  async reconcile(projectId: string): Promise<void> {
    const project = this.deps.registry.get(projectId);
    const marker = project?.importDecisionRun;
    if (!project || marker?.version !== 1 || marker.state !== "ready") return;
    await this.dispatch(project.id, marker.id);
  }

  /** One broken project is isolated from every other registered project. */
  async reconcileAll(): Promise<void> {
    for (const project of this.deps.registry.list()) {
      try {
        await this.reconcile(project.id);
      } catch (error) {
        this.deps.onError?.(project.id, error);
      }
    }
  }

  private async dispatchOne(projectId: string, importId: string): Promise<readonly TraceDecisionOutcomeRow[]> {
    const project = this.deps.registry.get(projectId);
    const marker = project?.importDecisionRun;
    if (!project || !marker || marker.version !== 1 || marker.state !== "ready" || marker.id !== importId) return [];

    const context = this.deps.projectContextManager.getOrCreate(projectId);
    const store = context?.decisionRequestStore as unknown as ImportRunStore | undefined;
    if (!context || !store) return [];

    // Never rebuild an already durable context. An import retry/restart must
    // dispatch against the exact snapshot originally admitted, not current FS.
    if (!store.getImportRun?.(importId)) {
      const snapshot = this.deps.buildContext({
        project,
        importId,
        components: context.projectConfigStore.getComponents(),
      });
      store.ensureImportRun({
        id: importId,
        projectId,
        context: snapshot,
        createdAt: new Date(marker.createdAt || this.now()).toISOString(),
        hooks: {},
      });
    }
    const outcomes = await this.deps.dispatcher.dispatchProjectImport(projectId, importId);
    // Hook completion is already durable before the dispatcher returns. Trace
    // failures are diagnostic only and cannot cause a registration/replay retry
    // to duplicate a request, default, memory, proposal, or continuation.
    if (outcomes.length > 0) {
      try { this.deps.trace?.appendProjectImportTrace(projectId, importId, outcomes); }
      catch { /* tracing is intentionally isolated from import delivery */ }
    }
    return outcomes;
  }
}
