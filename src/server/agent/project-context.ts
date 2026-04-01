import path from "node:path";
import type { RegisteredProject } from "./project-registry.js";
import { GoalStore } from "./goal-store.js";
import { SessionStore } from "./session-store.js";
import { GateStore } from "./gate-store.js";
import { TaskStore } from "./task-store.js";
import { TeamStore } from "./team-store.js";
import { StaffStore } from "./staff-store.js";
import { RoleStore } from "./role-store.js";
import { PersonalityStore } from "./personality-store.js";
import { WorkflowStore } from "./workflow-store.js";
import { ToolManager } from "./tool-manager.js";
import { ProjectConfigStore } from "./project-config-store.js";
import { ToolGroupPolicyStore } from "./tool-group-policy-store.js";
import { ColorStore } from "./color-store.js";
import { SearchIndex } from "../search/search-index.js";
import { CostTracker } from "./cost-tracker.js";
import { GoalManager } from "./goal-manager.js";

/**
 * A container holding a complete set of stores scoped to one project.
 *
 * Each registered project gets its own ProjectContext with stores pointing
 * at `<project-root>/.bobbit/state/` and `<project-root>/.bobbit/config/`.
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
  readonly gateStore: GateStore;
  readonly taskStore: TaskStore;
  readonly teamStore: TeamStore;
  readonly staffStore: StaffStore;
  readonly colorStore: ColorStore;
  readonly searchIndex: SearchIndex;
  readonly costTracker: CostTracker;
  readonly goalManager: GoalManager;

  // Config stores
  readonly roleStore: RoleStore;
  readonly personalityStore: PersonalityStore;
  readonly workflowStore: WorkflowStore;
  readonly toolManager: ToolManager;
  readonly projectConfigStore: ProjectConfigStore;
  readonly toolGroupPolicyStore: ToolGroupPolicyStore;

  constructor(project: RegisteredProject) {
    this.project = project;
    this.bobbitDir = path.join(project.rootPath, ".bobbit");
    this.stateDir = path.join(this.bobbitDir, "state");
    this.configDir = path.join(this.bobbitDir, "config");

    // Instantiate state stores with project-scoped state directory
    this.goalStore = new GoalStore(this.stateDir);
    this.sessionStore = new SessionStore(this.stateDir);
    this.gateStore = new GateStore(this.stateDir);
    this.taskStore = new TaskStore(this.stateDir);
    this.teamStore = new TeamStore(this.stateDir);
    this.staffStore = new StaffStore(this.stateDir);
    this.colorStore = new ColorStore(this.stateDir);
    this.searchIndex = new SearchIndex(path.join(this.stateDir, "search.db"));
    this.costTracker = new CostTracker(this.stateDir);
    this.goalManager = new GoalManager(this.goalStore);

    // Instantiate config stores with project-scoped config directory
    this.roleStore = new RoleStore(this.configDir);
    this.personalityStore = new PersonalityStore(this.configDir);
    this.workflowStore = new WorkflowStore(this.configDir);
    this.toolManager = new ToolManager(this.configDir);
    this.projectConfigStore = new ProjectConfigStore(this.configDir);
    this.toolGroupPolicyStore = new ToolGroupPolicyStore(this.configDir);
  }

  /** Open resources that require initialization (e.g. SQLite). */
  open(): void {
    this.searchIndex.staffStore = this.staffStore;
    this.searchIndex.open();
    if (this.searchIndex.needsRebuild()) {
      this.searchIndex.rebuildFromStores(this.goalStore, this.sessionStore, undefined, this.staffStore);
    }
    // Wire search index updates on goal/session mutations
    this.goalStore.onIndexUpdate = (goal) => {
      this.searchIndex.indexGoal(goal, this.project.id);
    };
    this.sessionStore.onIndexUpdate = (session) => {
      const goalTitle = session.goalId ? this.goalStore.get(session.goalId)?.title : undefined;
      this.searchIndex.indexSession(session, goalTitle, this.project.id);
    };
  }

  /** Close resources for clean shutdown. */
  close(): void {
    this.sessionStore.flush();
    this.searchIndex.close();
  }
}
