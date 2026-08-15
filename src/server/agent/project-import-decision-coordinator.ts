import type { ContextTraceStore, TraceDecisionOutcomeRow } from "./context-trace-store.js";
import type { ProjectContextManager } from "./project-context-manager.js";
import type { ProjectRegistry, RegisteredProject } from "./project-registry.js";
import type { Component } from "./project-config-store.js";
import type { DecisionRequestStore, StoredProjectImportRun } from "./decision-request-store.js";
import {
  canonicalProjectImportRoot,
  validateProjectImportDecisionContext,
  type ProjectImportDecisionContext,
} from "./project-import-decision-context.js";

/**
 * The builder and replay validator share the one precise, bounded context
 * contract. Keeping it typed prevents an unvalidated component shape from
 * reaching durable import-run storage or the dispatcher.
 */
export type ProjectImportDecisionContextSnapshot = ProjectImportDecisionContext;

interface ProjectImportDispatcher {
  /** The coordinator supplies the freshly registry-validated snapshot. */
  dispatchProjectImport(projectId: string, importId: string, context: ProjectImportDecisionContextSnapshot): Promise<readonly TraceDecisionOutcomeRow[]>;
}

export interface ProjectImportDecisionCoordinatorDeps {
  registry: Pick<ProjectRegistry, "get" | "list">;
  projectContextManager: Pick<ProjectContextManager, "getOrCreate">;
  dispatcher: ProjectImportDispatcher;
  buildContext(input: { project: Pick<RegisteredProject, "id" | "rootPath">; importId: string; components: readonly Component[] }): ProjectImportDecisionContextSnapshot;
  /** Test seam; production resolves the registered root through realpath. */
  canonicalProjectRoot?: (project: Pick<RegisteredProject, "id" | "rootPath">) => string;
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

  /**
   * Reconcile every project concurrently, but do not release startup ordering
   * until each dispatch has settled. Hook invocation itself is bounded by the
   * dispatcher/module host; a local timer cannot safely cancel its mutations.
   */
  async reconcileAll(): Promise<void> {
    await Promise.all(this.deps.registry.list().map(async (project) => {
      try {
        await this.reconcile(project.id);
      } catch (error) {
        this.deps.onError?.(project.id, error);
      }
    }));
  }

  private async dispatchOne(projectId: string, importId: string): Promise<readonly TraceDecisionOutcomeRow[]> {
    const project = this.deps.registry.get(projectId);
    const marker = project?.importDecisionRun;
    if (!project || !marker || marker.version !== 1 || marker.state !== "ready" || marker.id !== importId) return [];

    const context = this.deps.projectContextManager.getOrCreate(projectId);
    const store: Pick<DecisionRequestStore, "getImportRun" | "ensureImportRun"> | undefined = context?.decisionRequestStore;
    if (!context || !store) {
      this.reportFailure(projectId, importId, "import decision store unavailable");
      return [];
    }

    // Never rebuild an already durable context. An import retry/restart must
    // dispatch against the exact snapshot originally admitted, not current FS.
    let run: StoredProjectImportRun | undefined = store.getImportRun(importId);
    if (!run) {
      let ensured: { created: boolean; run: StoredProjectImportRun } | undefined;
      try {
        const snapshot = this.deps.buildContext({
          project,
          importId,
          components: context.projectConfigStore.getComponents(),
        });
        ensured = store.ensureImportRun({
          id: importId,
          projectId,
          context: snapshot,
          createdAt: new Date(marker.createdAt || this.now()).toISOString(),
          hooks: {},
        });
      } catch {
        this.reportFailure(projectId, importId, "import run admission failed");
        return [];
      }
      run = ensured?.run;
      // `undefined` is not a benign no-op: it means the atomic store rejected
      // an invalid/mismatched immutable run. Do not silently retry against a
      // different filesystem snapshot or make a user answer again.
      if (!run) {
        this.reportFailure(projectId, importId, "import run admission rejected");
        return [];
      }
    }

    // The durable file is untrusted on every restart. Match the snapshot to
    // the current registry identity/root immediately before any dispatcher can
    // select a hook or derive ModuleHost.workingDir from it.
    let snapshot: ProjectImportDecisionContextSnapshot;
    try {
      const projectRoot = this.deps.canonicalProjectRoot?.(project) ?? canonicalProjectImportRoot(project.rootPath);
      snapshot = validateProjectImportDecisionContext(run.context, { projectId, importId, projectRoot });
    } catch {
      this.reportFailure(projectId, importId, "durable import context mismatch");
      return [];
    }
    const outcomes = await this.deps.dispatcher.dispatchProjectImport(projectId, importId, snapshot);
    // Hook completion is already durable before the dispatcher returns. Trace
    // failures are diagnostic only and cannot cause a registration/replay retry
    // to duplicate a request, default, memory, proposal, or continuation.
    if (outcomes.length > 0) {
      try { this.deps.trace?.appendProjectImportTrace(projectId, importId, outcomes); }
      catch { /* tracing is intentionally isolated from import delivery */ }
    }
    return outcomes;
  }

  /**
   * Import failures are deliberately visible without retaining exception text
   * or untrusted path/context bytes. The fixed trace row is safe for the
   * project activity surface and the log gives operators a loud correlation.
   */
  private reportFailure(projectId: string, importId: string, message: string): void {
    this.deps.onError?.(projectId, new Error(message));
    try {
      this.deps.trace?.appendProjectImportTrace(projectId, importId, [{
        kind: "decision", packId: "project-import", hookId: "coordinator",
        event: "projectImported", outcome: "error", reason: "Unavailable",
      }]);
    } catch {
      // Diagnostics must not change replay or registration semantics.
    }
  }
}
