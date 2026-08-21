import path from "node:path";
import { bobbitConfigDir, bobbitDir, bobbitStateDir, normalProjectBobbitDir } from "../bobbit-dir.js";
import { HEADQUARTERS_PROJECT_ID, type RegisteredProject } from "./project-registry.js";
import { GoalStore } from "./goal-store.js";
import type { GoalTriggerDispatcher } from "./goal-trigger-dispatcher.js";
import { SessionStore } from "./session-store.js";
import { BgProcessStore } from "./bg-process-store.js";
import { GateStore } from "./gate-store.js";
import { GateResetCoordinator } from "./gate-reset-intent.js";
import { TaskStore } from "./task-store.js";
import { TeamStore } from "./team-store.js";
import { StaffStore } from "./staff-store.js";
import { InboxStore } from "./inbox-store.js";
import { RoleStore } from "./role-store.js";
import { WorkflowStore } from "./workflow-store.js";
import { ToolManager } from "./tool-manager.js";
import { ProjectConfigStore } from "./project-config-store.js";
import { ToolGroupPolicyStore } from "./tool-group-policy-store.js";
import { ColorStore } from "./color-store.js";
import { SearchService } from "../search/search-service.js";
import { CostTracker } from "./cost-tracker.js";
import { GoalManager } from "./goal-manager.js";
import { SecretsStore } from "./secrets-store.js";
import { PlanMutationStore } from "./plan-mutation-store.js";
import { realFs, type Clock, type CommandRunner, type FsLike } from "../gateway-deps.js";
import type { RemoteGitPolicy } from "../skills/git.js";
import type {
  HostNotificationDispatcher,
  HostNotificationPublication,
} from "../extension-host/host-notification-dispatcher.js";
import type {
  HostNotification,
  HostNotificationName,
} from "../../shared/extension-host/host-hooks.js";

/**
 * A container holding a complete set of stores scoped to one project.
 *
 * Each normal project gets its own ProjectContext with stores pointing
 * at `<project-root>/.bobbit/state/` and `<project-root>/.bobbit/config/`.
 * Headquarters is the exception: it is the server workspace itself and aliases
 * `bobbitStateDir()` / `bobbitConfigDir()` under the physical Headquarters dir.
 *
 * NOTE: Store constructors are being updated in parallel to accept
 * stateDir/configDir parameters. This file will compile once those
 * changes are merged.
 */
export class ProjectContext {
  readonly project: RegisteredProject;
  readonly stateDir: string;
  readonly configDir: string;
  readonly bobbitDir: string;

  // State stores
  readonly goalStore: GoalStore;
  readonly sessionStore: SessionStore;
  readonly bgProcessStore: BgProcessStore;
  readonly gateStore: GateStore;
  readonly gateResetCoordinator: GateResetCoordinator;
  readonly taskStore: TaskStore;
  readonly teamStore: TeamStore;
  readonly staffStore: StaffStore;
  readonly inboxStore: InboxStore;
  readonly colorStore: ColorStore;
  readonly searchIndex: SearchService;
  readonly costTracker: CostTracker;
  readonly goalManager: GoalManager;
  readonly secretsStore: SecretsStore;
  readonly planMutationStore: PlanMutationStore;

  /**
   * Optional dispatcher for `goal_created` / `goal_archived` staff triggers.
   * Wired post-construction by `ProjectContextManager.setGoalTriggerDispatcher`
   * once `server.ts` has built the staff/inbox managers. Stays `null` in tests
   * that don't need the trigger surface.
   */
  private goalTriggerDispatcher: GoalTriggerDispatcher | null = null;
  private hostNotificationDispatcher: HostNotificationDispatcher | null = null;
  private closePromise: Promise<void> | null = null;

  // Config stores
  readonly roleStore: RoleStore;
  readonly workflowStore: WorkflowStore;
  readonly toolManager: ToolManager;
  readonly projectConfigStore: ProjectConfigStore;
  readonly toolGroupPolicyStore: ToolGroupPolicyStore;

  constructor(project: RegisteredProject, opts: { headquartersProjectConfigStore?: ProjectConfigStore; fsImpl?: FsLike; goalPersistence?: "sqlite" | "json"; taskPersistence?: "sqlite" | "json"; gatePersistence?: "sqlite" | "json"; clock?: Clock; commandRunner?: CommandRunner; remotePolicy?: RemoteGitPolicy; worktreeSetupRuntime?: { skipNpmCi?: boolean; recordSetupPath?: string } } = {}) {
    this.project = project;
    const fsImpl = opts.fsImpl;
    const clock = opts.clock;
    const commandRunner = opts.commandRunner;
    const isHeadquarters = project.id === HEADQUARTERS_PROJECT_ID || project.kind === "headquarters";
    if (isHeadquarters) {
      this.bobbitDir = bobbitDir();
      this.stateDir = bobbitStateDir();
      this.configDir = bobbitConfigDir();
    } else {
      this.bobbitDir = normalProjectBobbitDir(project.rootPath);
      this.stateDir = path.join(this.bobbitDir, "state");
      this.configDir = path.join(this.bobbitDir, "config");
    }

    // Build dependencies without native database handles first. A failure in
    // this section needs no store-specific cleanup.
    this.sessionStore = new SessionStore(this.stateDir, fsImpl, clock);
    this.bgProcessStore = new BgProcessStore(this.stateDir, clock);
    this.teamStore = new TeamStore(this.stateDir);
    this.staffStore = new StaffStore(this.stateDir);
    this.inboxStore = new InboxStore(this.stateDir, fsImpl);
    this.colorStore = new ColorStore(this.stateDir);
    this.searchIndex = new SearchService({ stateDir: this.stateDir, projectId: project.id, staffStore: this.staffStore });
    this.costTracker = new CostTracker(this.stateDir, fsImpl);
    this.secretsStore = new SecretsStore(this.stateDir, fsImpl);
    this.planMutationStore = new PlanMutationStore(this.stateDir, undefined, fsImpl, clock);

    // ProjectConfigStore must precede WorkflowStore because inline workflows
    // are loaded from project.yaml.
    this.roleStore = new RoleStore(this.configDir);
    this.projectConfigStore = isHeadquarters && opts.headquartersProjectConfigStore
      ? opts.headquartersProjectConfigStore
      : new ProjectConfigStore(this.configDir, fsImpl);
    this.workflowStore = new WorkflowStore(this.projectConfigStore);
    this.toolManager = new ToolManager(this.configDir);
    this.toolGroupPolicyStore = new ToolGroupPolicyStore(this.configDir);

    // GoalStore, TaskStore, and GateStore may own native SQLite handles. Keep
    // their construction and every dependent constructor in one guarded tail;
    // reverse disposal guarantees a later failure releases all opened handles.
    const defaultPersistence = !fsImpl || fsImpl === realFs ? "sqlite" : "json";
    let goalStore: GoalStore | undefined;
    let taskStore: TaskStore | undefined;
    let gateStore: GateStore | undefined;
    try {
      goalStore = new GoalStore(this.stateDir, fsImpl, { persistence: opts.goalPersistence ?? defaultPersistence });
      this.goalStore = goalStore;
      taskStore = new TaskStore(this.stateDir, fsImpl, { persistence: opts.taskPersistence ?? defaultPersistence });
      this.taskStore = taskStore;
      gateStore = new GateStore(this.stateDir, fsImpl, { persistence: opts.gatePersistence ?? defaultPersistence });
      this.gateStore = gateStore;

      // GoalManager requires WorkflowStore and GoalStore (fail-loud).
      this.goalManager = new GoalManager(this.goalStore, this.workflowStore, this.stateDir, { commandRunner, clock, remotePolicy: opts.remotePolicy, worktreeSetupRuntime: opts.worktreeSetupRuntime });
      // Pending reset intents become synchronously visible before the context
      // is returned to ProjectContextManager and before open()/resume logic.
      this.gateResetCoordinator = new GateResetCoordinator(this.stateDir, this.goalStore, this.gateStore, fsImpl);
    } catch (error) {
      const disposalErrors: unknown[] = [];
      for (const store of [gateStore, taskStore, goalStore]) {
        try { store?.dispose(); }
        catch (disposeError) { disposalErrors.push(disposeError); }
      }
      if (disposalErrors.length > 0) {
        throw new AggregateError([error, ...disposalErrors], "Project context construction failed and native store cleanup also failed");
      }
      throw error;
    }
  }

  /** Open resources that require initialization (LanceDB + embedder). */
  open(): void {
    // Kick off async initialization — non-blocking, state transitions
    // through "initializing" → "ready" (or a disabled state).
    this.searchIndex.open({
      goalStore: this.goalStore,
      sessionStore: this.sessionStore,
      staffStore: this.staffStore,
    });
    // Wire search index updates on goal/session mutations.
    // NOTE: `onIndexUpdate` is the single SEARCH index hook and must NOT be
    // co-opted for goal lifecycle triggers — those use the separate
    // `onGoalCreated` / `onGoalArchived` channels wired below.
    this.goalStore.onIndexUpdate = (goal) => {
      this.searchIndex.indexGoal(goal, this.project.id);
      for (const session of this.sessionStore.getAll()) {
        if (session.goalId !== goal.id) continue;
        this.searchIndex.indexSession(session, goal.title, this.project.id);
        this.searchIndex.reindexMessagesForSession(session, goal.title, this.project.id);
      }
    };
    this.sessionStore.onIndexUpdate = (session) => {
      const goalTitle = session.goalId ? this.goalStore.get(session.goalId)?.title : undefined;
      this.searchIndex.indexSession(session, goalTitle, this.project.id);
      this.searchIndex.reindexMessagesForSession(session, goalTitle, this.project.id);
    };
    // Re-apply any dispatcher wiring in case `setGoalTriggerDispatcher`
    // was called before `open()` (current call order is reverse, but the
    // explicit re-bind keeps both orderings safe).
    this.applyGoalTriggerDispatcher();
  }

  /**
   * Attach the shared `GoalTriggerDispatcher` so this context's GoalStore
   * mutations dispatch `goal_created` / `goal_archived` events to staff
   * inboxes. Idempotent and order-independent with respect to `open()` —
   * the manager wires every existing context (and every future
   * `getOrCreate`) after the dispatcher is constructed in `server.ts`.
   */
  setGoalTriggerDispatcher(dispatcher: GoalTriggerDispatcher | null): void {
    this.goalTriggerDispatcher = dispatcher;
    this.applyGoalTriggerDispatcher();
  }

  /** Late-bind the canonical post-authority notification publisher. */
  setHostNotificationDispatcher(dispatcher: HostNotificationDispatcher | null): void {
    this.hostNotificationDispatcher = dispatcher;
  }

  /** Narrow publisher callback for project-owned mutation boundaries. */
  publishHostNotification<N extends HostNotificationName>(
    name: N,
    publication: Omit<HostNotificationPublication<N>, "projectId">,
  ): HostNotification<N> | undefined {
    return this.hostNotificationDispatcher?.publish(name, {
      ...publication,
      projectId: this.project.id,
    } as HostNotificationPublication<N>);
  }

  /** Wire the authoritative post-archive cross-store reconciliation boundary. */
  setGoalArchiveReconciler(reconciler: ((goalId: string) => Promise<unknown>) | undefined): void {
    this.goalManager.setGoalArchiveReconciler(reconciler);
  }

  private applyGoalTriggerDispatcher(): void {
    const d = this.goalTriggerDispatcher;
    if (!d) {
      // Detach: leave onIndexUpdate untouched, only clear the trigger hooks.
      this.goalStore.onGoalCreated = undefined;
      this.goalStore.onGoalArchived = undefined;
      return;
    }
    this.goalStore.onGoalCreated = (goal) => d.onGoalCreated(goal);
    this.goalStore.onGoalArchived = (goal) => d.onGoalArchived(goal);
  }

  /** Close every owned resource exactly once. The shared promise is also the
   *  barrier for pending writes and native-handle release. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = closeProjectContextResources(this);
    return this.closePromise;
  }
}

async function closeProjectContextResources(context: ProjectContext): Promise<void> {
  const errors: unknown[] = [];
  const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
    try { await operation(); }
    catch (error) { errors.push(error); }
  };

  // Stop mutation sources and let boot-time reset recovery settle before the
  // gate database closes. No coordinator write may outlive this context.
  await attempt(() => context.planMutationStore.stopSweep());
  await attempt(() => context.gateResetCoordinator?.recovery);

  const drain = async (store: { flush?: () => void | Promise<void>; flushAsync?: () => Promise<void> } | undefined): Promise<void> => {
    if (!store) return;
    if (typeof store.flushAsync === "function") await store.flushAsync();
    else await store.flush?.();
  };
  const closeStore = async (store: { close?: () => void | Promise<void>; flush?: () => void | Promise<void>; flushAsync?: () => Promise<void> } | undefined): Promise<void> => {
    if (typeof store?.close === "function") await store.close();
    else await drain(store);
  };

  // Each operation captures its own failure so one broken store cannot skip
  // sibling drains or leave another native database open on Windows.
  await Promise.all([
    attempt(() => closeStore(context.goalStore)),
    attempt(() => closeStore(context.taskStore)),
    attempt(() => closeStore(context.gateStore)),
    attempt(() => drain(context.sessionStore)),
  ]);
  await attempt(() => { context.costTracker?.flush(); });
  await attempt(() => { context.bgProcessStore?.flush(); });
  await attempt(async () => { await context.searchIndex?.close(); });

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, `Failed to close ${errors.length} project resources`);
}
