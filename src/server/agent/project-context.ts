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
import type { Clock, CommandRunner, FsLike } from "../gateway-deps.js";
import type { RemoteGitPolicy } from "../skills/git.js";

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

  // Config stores
  readonly roleStore: RoleStore;
  readonly workflowStore: WorkflowStore;
  readonly toolManager: ToolManager;
  readonly projectConfigStore: ProjectConfigStore;
  readonly toolGroupPolicyStore: ToolGroupPolicyStore;

  constructor(project: RegisteredProject, opts: { headquartersProjectConfigStore?: ProjectConfigStore; fsImpl?: FsLike; clock?: Clock; commandRunner?: CommandRunner; remotePolicy?: RemoteGitPolicy; worktreeSetupRuntime?: { skipNpmCi?: boolean; recordSetupPath?: string } } = {}) {
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

    // Instantiate state stores with project-scoped state directory
    this.goalStore = new GoalStore(this.stateDir, fsImpl);
    this.sessionStore = new SessionStore(this.stateDir, fsImpl, clock);
    this.bgProcessStore = new BgProcessStore(this.stateDir, clock);
    this.gateStore = new GateStore(this.stateDir, fsImpl);
    // Construct after both stores load: pending reset intents are replayed
    // state-first before any team runtime or boot-resume logic observes them.
    this.gateResetCoordinator = new GateResetCoordinator(this.stateDir, this.goalStore, this.gateStore, fsImpl);
    this.taskStore = new TaskStore(this.stateDir);
    this.teamStore = new TeamStore(this.stateDir);
    this.staffStore = new StaffStore(this.stateDir);
    this.inboxStore = new InboxStore(this.stateDir, fsImpl);
    this.colorStore = new ColorStore(this.stateDir);
    this.searchIndex = new SearchService({ stateDir: this.stateDir, projectId: project.id, staffStore: this.staffStore });
    this.costTracker = new CostTracker(this.stateDir, fsImpl);
    this.secretsStore = new SecretsStore(this.stateDir);
    this.planMutationStore = new PlanMutationStore(this.stateDir, undefined, fsImpl, clock);

    // Instantiate config stores with project-scoped config directory.
    // ProjectConfigStore must come before WorkflowStore — the inline
    // workflow store reads workflows from project.yaml. WorkflowStore
    // must be constructed before GoalManager so the manager can resolve
    // workflow snapshots without callers having to thread the store
    // through every createGoal call (WorkflowStore-required invariant — see
    // docs/_phase-1-notes.md).
    this.roleStore = new RoleStore(this.configDir);
    this.projectConfigStore = isHeadquarters && opts.headquartersProjectConfigStore
      ? opts.headquartersProjectConfigStore
      : new ProjectConfigStore(this.configDir, fsImpl);
    this.workflowStore = new WorkflowStore(this.projectConfigStore);
    this.toolManager = new ToolManager(this.configDir);
    this.toolGroupPolicyStore = new ToolGroupPolicyStore(this.configDir);

    // GoalManager depends on workflowStore (GoalManager requires WorkflowStore — fail-loud). Constructed
    // after the config stores above so the project's WorkflowStore is
    // available for workflow-id resolution at goal creation time.
    this.goalManager = new GoalManager(this.goalStore, this.workflowStore, this.stateDir, { commandRunner, clock, remotePolicy: opts.remotePolicy, worktreeSetupRuntime: opts.worktreeSetupRuntime });
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

  /** Close resources for clean shutdown. Awaits the search flush so callers
   *  (teardown, shutdown) can guarantee no async I/O outlives this promise —
   *  preventing the FlexSearch flush-on-close race against temp-dir removal. */
  async close(): Promise<void> {
    // Stop future plan-mutation sweeps and wait for an active prune before
    // closing resources or allowing this context's state directory to vanish.
    await this.planMutationStore.stopSweep();
    this.sessionStore.flush();
    this.costTracker.flush();
    // Mirror sessionStore: flush the bg-process store so its final epoch
    // (exit status, dismiss removals, offset advances) is on disk before exit.
    // Otherwise a pending debounced write lands after the next gateway loads
    // the older epoch, tripping the stale-snapshot guard and silently dropping
    // every subsequent save (re-attach exit code + dismiss).
    this.bgProcessStore.flush();
    await this.searchIndex.close();
  }
}
