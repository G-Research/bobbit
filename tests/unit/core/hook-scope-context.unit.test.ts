import { describe, it } from "vitest";
import assert from "node:assert/strict";
import path from "node:path";

import {
  GOAL_METADATA_WALK_DEPTH_CAP,
  resolveGoalMetadata,
} from "../../../src/server/agent/goal-metadata.ts";
import {
  resolveHookScopeContext,
  type HookScopeResolutionInput,
} from "../../../src/server/agent/hook-scope-context.ts";
import type { HookScopeContext } from "../../../src/server/agent/lifecycle-hub.ts";

type Goal = {
  id: string;
  title: string;
  parentGoalId?: string;
  archived?: boolean;
  metadata?: Record<string, unknown>;
};

type Component = { name: string; repo: string; relativePath?: string };

type ScopeFixture = {
  projectId: string;
  projectRoot: string;
  context: Record<string, unknown>;
};

function projectFixture(
  projectId = "project-a",
  options: {
    name?: string;
    root?: string;
    goals?: Goal[];
    components?: Component[];
    kind?: string;
    hidden?: boolean;
  } = {},
): ScopeFixture {
  const goals = new Map((options.goals ?? []).map((goal) => [goal.id, goal]));
  const projectRoot = options.root ?? `/projects/${projectId}`;
  const lookup = { get: (id: string) => goals.get(id) };
  const context = {
    project: {
      id: projectId,
      name: options.name ?? "Project A",
      rootPath: projectRoot,
      ...(options.kind ? { kind: options.kind } : {}),
      ...(options.hidden ? { hidden: true } : {}),
    },
    goalStore: lookup,
    goalManager: {
      getEffectiveGoalMetadata: (goalId: string) =>
        resolveGoalMetadata(lookup, goalId),
    },
    projectConfigStore: { getComponents: () => options.components ?? [] },
  };
  return { projectId, projectRoot, context };
}

function resolverFor(...fixtures: ScopeFixture[]) {
  const contexts = new Map(
    fixtures.map((fixture) => [fixture.projectId, fixture.context]),
  );
  const calls: Array<string | undefined> = [];
  return {
    calls,
    resolve(input: HookScopeResolutionInput): HookScopeContext | undefined {
      return resolveHookScopeContext(
        {
          getOrCreate(projectId: string) {
            calls.push(projectId);
            return (contexts.get(projectId) as any) ?? null;
          },
        },
        input,
      );
    },
  };
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.ok(
    Object.isFrozen(value),
    "every reachable scope value must be frozen",
  );
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

describe("resolveHookScopeContext", () => {
  it("publishes a complete root-to-leaf lineage, descendant-wins metadata, and role", () => {
    const source = projectFixture("project-a", {
      name: "Alpha",
      goals: [
        {
          id: "root",
          title: "Root",
          metadata: { policy: { retries: 1, rootOnly: true }, tools: ["read"] },
        },
        {
          id: "child",
          title: "Child",
          parentGoalId: "root",
          metadata: { policy: { retries: 2, childOnly: true } },
        },
        {
          id: "leaf",
          title: "Leaf",
          parentGoalId: "child",
          metadata: { tools: ["write"], policy: { leafOnly: true } },
        },
      ],
    });
    const { resolve } = resolverFor(source);

    const rootScope = resolve({
      projectId: "project-a",
      goalId: "root",
      cwd: source.projectRoot,
    });
    assert.deepEqual(rootScope?.goal, {
      id: "root",
      title: "Root",
      ancestry: [{ id: "root", title: "Root" }],
      depth: 1,
      metadata: { policy: { retries: 1, rootOnly: true }, tools: ["read"] },
    });

    const scope = resolve({
      projectId: "project-a",
      goalId: "leaf",
      roleName: "tester",
      cwd: source.projectRoot,
    });

    assert.deepEqual(scope, {
      project: { id: "project-a", name: "Alpha" },
      goal: {
        id: "leaf",
        title: "Leaf",
        ancestry: [
          { id: "root", title: "Root" },
          { id: "child", title: "Child" },
          { id: "leaf", title: "Leaf" },
        ],
        depth: 3,
        metadata: {
          policy: {
            retries: 2,
            rootOnly: true,
            childOnly: true,
            leafOnly: true,
          },
          tools: ["write"],
        },
      },
      role: "tester",
    });
  });

  it("exposes only configured component coordinates for unique single- and multi-repo worktree matches", () => {
    const single = projectFixture("single", {
      root: "/projects/single",
      components: [{ name: "web", repo: ".", relativePath: "apps/web" }],
    });
    const multi = projectFixture("multi", {
      root: "/projects/multi",
      components: [
        { name: "api", repo: "services/api" },
        { name: "web", repo: "apps/web", relativePath: "client" },
      ],
    });
    const { resolve } = resolverFor(single, multi);

    assert.deepEqual(
      resolve({
        projectId: "single",
        cwd: "/worktrees/single/apps/web/src",
        worktreePath: "/worktrees/single",
      })?.component,
      { name: "web", repo: ".", relativePath: "apps/web" },
    );
    assert.deepEqual(
      resolve({
        projectId: "multi",
        cwd: "/worktrees/web/client/src",
        repoWorktrees: {
          "services/api": "/worktrees/api",
          "apps/web": "/worktrees/web",
        },
      })?.component,
      { name: "web", repo: "apps/web", relativePath: "client" },
    );
  });

  it("maps safe sandbox container paths into host component coordinates", () => {
    const single = projectFixture("sandbox-single", {
      components: [{ name: "web", repo: ".", relativePath: "apps/web" }],
    });
    const multi = projectFixture("sandbox-multi", {
      components: [
        { name: "api", repo: "services/api" },
        { name: "web", repo: "apps/web", relativePath: "client" },
      ],
    });
    const { resolve } = resolverFor(single, multi);

    assert.deepEqual(
      resolve({
        projectId: "sandbox-single",
        cwd: "/workspace-wt/goal-branch/apps/web/src",
        worktreePath: "/host/worktrees/goal-branch",
        repoPath: "/host/project",
      })?.component,
      { name: "web", repo: ".", relativePath: "apps/web" },
    );
    assert.deepEqual(
      resolve({
        projectId: "sandbox-single",
        cwd: "/workspace/apps/web/src",
        repoPath: "/host/project",
      })?.component,
      { name: "web", repo: ".", relativePath: "apps/web" },
    );
    assert.deepEqual(
      resolve({
        projectId: "sandbox-multi",
        cwd: "/workspace-wt/goal-branch/apps/web/client/src",
        worktreePath: "/host/worktrees/goal-branch",
        repoPath: "/host/project",
        repoWorktrees: {
          "services/api": "/host/worktrees/goal-branch/services/api",
          "apps/web": "/host/worktrees/goal-branch/apps/web",
        },
      })?.component,
      { name: "web", repo: "apps/web", relativePath: "client" },
    );
    assert.deepEqual(
      resolve({
        projectId: "sandbox-multi",
        cwd: "/workspace/apps/web/client/src",
        repoPath: "/host/project",
      })?.component,
      { name: "web", repo: "apps/web", relativePath: "client" },
    );
  });

  it("preserves project-config Windows separators for native and sandbox component paths", () => {
    const nativeRoot = path.join(path.parse(process.cwd()).root, "worktrees", "native-component");
    const native = projectFixture("native-component", {
      components: [{ name: "web", repo: ".", relativePath: "apps\\web" }],
    });
    const sandbox = projectFixture("windows-config-sandbox", {
      components: [{ name: "web", repo: "apps\\web", relativePath: "client" }],
    });
    const unsafe = projectFixture("unsafe-windows-config", {
      components: [
        { name: "drive", repo: ".", relativePath: "C:\\private" },
        { name: "unc", repo: ".", relativePath: "\\\\server\\share" },
        { name: "traversal", repo: "apps\\..\\private" },
      ],
    });
    const { resolve } = resolverFor(native, sandbox, unsafe);

    assert.deepEqual(
      resolve({
        projectId: "native-component",
        cwd: path.join(nativeRoot, "apps", "web", "src"),
        worktreePath: nativeRoot,
      })?.component,
      { name: "web", repo: ".", relativePath: "apps\\web" },
      "a platform-native cwd must not be rejected merely for Windows separators",
    );
    assert.deepEqual(
      resolve({
        projectId: "windows-config-sandbox",
        cwd: "/workspace/apps/web/client/src",
        repoPath: "/host/project",
        repoWorktrees: { "apps\\web": "/host/project/apps/web" },
      })?.component,
      { name: "web", repo: "apps\\web", relativePath: "client" },
      "safe Windows-style configured paths map through canonical container coordinates",
    );
    assert.equal(
      resolve({
        projectId: "unsafe-windows-config",
        cwd: path.join(nativeRoot, "apps", "web", "src"),
        worktreePath: nativeRoot,
      })?.component,
      undefined,
      "drive, UNC, and traversal component paths remain rejected",
    );
  });

  it("rejects malformed or ambiguous sandbox container coordinates", () => {
    const single = projectFixture("sandbox-single", {
      components: [{ name: "web", repo: ".", relativePath: "apps/web" }],
    });
    const multi = projectFixture("sandbox-multi", {
      components: [
        { name: "api", repo: "services/api" },
        { name: "web", repo: "apps/web", relativePath: "client" },
      ],
    });
    const ambiguous = projectFixture("sandbox-ambiguous", {
      components: [
        { name: "one", repo: ".", relativePath: "apps/web" },
        { name: "two", repo: ".", relativePath: "apps/web" },
      ],
    });
    const { resolve } = resolverFor(single, multi, ambiguous);

    assert.equal(
      resolve({
        projectId: "sandbox-single",
        cwd: "/workspace-wt/goal-branch/../../apps/web",
        worktreePath: "/host/worktrees/goal-branch",
      })?.component,
      undefined,
    );
    assert.equal(
      resolve({
        projectId: "sandbox-single",
        cwd: "/workspace-wt/goal-branch\\apps\\web",
        worktreePath: "/host/worktrees/goal-branch",
      })?.component,
      undefined,
      "container namespaces retain strict slash-only validation",
    );
    assert.equal(
      resolve({
        projectId: "sandbox-multi",
        cwd: "/workspace-wt/goal-branch",
        worktreePath: "/host/worktrees/goal-branch",
        repoWorktrees: {
          "services/api": "/host/worktrees/goal-branch/services/api",
          "apps/web": "/host/worktrees/goal-branch/apps/web",
        },
      })?.component,
      undefined,
    );
    assert.equal(
      resolve({
        projectId: "sandbox-multi",
        cwd: "/workspace-wt/goal-branch/apps/web/client",
        worktreePath: "/host/worktrees/goal-branch",
      })?.component,
      undefined,
      "multi-repo sandbox paths require their own host worktree coordinate",
    );
    assert.equal(
      resolve({
        projectId: "sandbox-ambiguous",
        cwd: "/workspace-wt/goal-branch/apps/web",
        worktreePath: "/host/worktrees/goal-branch",
      })?.component,
      undefined,
      "equal-depth sandbox matches remain ambiguous",
    );
  });

  it("selects the unique deepest monorepo component and omits ambiguous or branch-container matches", () => {
    const mono = projectFixture("mono", {
      root: "/projects/mono",
      components: [
        { name: "apps", repo: ".", relativePath: "apps" },
        { name: "web", repo: ".", relativePath: "apps/web" },
      ],
    });
    const ambiguous = projectFixture("ambiguous", {
      root: "/projects/ambiguous",
      components: [
        { name: "one", repo: ".", relativePath: "apps/web" },
        { name: "two", repo: ".", relativePath: "apps/web" },
      ],
    });
    const multi = projectFixture("branch-container", {
      root: "/projects/branch-container",
      components: [
        { name: "api", repo: "api" },
        { name: "web", repo: "web" },
      ],
    });
    const { resolve } = resolverFor(mono, ambiguous, multi);

    assert.deepEqual(
      resolve({
        projectId: "mono",
        cwd: "/worktrees/mono/apps/web/src",
        worktreePath: "/worktrees/mono",
      })?.component,
      { name: "web", repo: ".", relativePath: "apps/web" },
    );
    assert.equal(
      resolve({
        projectId: "ambiguous",
        cwd: "/worktrees/ambiguous/apps/web/src",
        worktreePath: "/worktrees/ambiguous",
      })?.component,
      undefined,
    );
    assert.equal(
      resolve({
        projectId: "branch-container",
        cwd: "/worktrees/branch-container",
        worktreePath: "/worktrees/branch-container",
      })?.component,
      undefined,
    );
  });

  it("keeps goal-less sessions useful while never serializing absolute component roots", () => {
    const source = projectFixture("project-a", {
      root: "/private/projects/alpha",
      components: [{ name: "api", repo: ".", relativePath: "services/api" }],
    });
    const { resolve } = resolverFor(source);
    const scope = resolve({
      projectId: "project-a",
      roleName: "coder",
      cwd: "/private/worktrees/alpha/services/api/src",
      worktreePath: "/private/worktrees/alpha",
    });

    assert.deepEqual(scope, {
      project: { id: "project-a", name: "Project A" },
      role: "coder",
      component: { name: "api", repo: ".", relativePath: "services/api" },
    });
    assert.ok(
      !JSON.stringify(scope).includes("/private/"),
      "scope context must never expose computed absolute paths",
    );
  });

  it("returns project and role only for missing or archived leaf goals", () => {
    const source = projectFixture("project-a", {
      goals: [
        {
          id: "archived",
          title: "Archived",
          archived: true,
          metadata: { secret: true },
        },
      ],
    });
    const { resolve } = resolverFor(source);

    for (const goalId of ["missing", "archived"]) {
      assert.deepEqual(
        resolve({
          projectId: "project-a",
          goalId,
          roleName: "reviewer",
          cwd: source.projectRoot,
        }),
        {
          project: { id: "project-a", name: "Project A" },
          role: "reviewer",
        },
      );
    }
  });

  it("degrades cyclic, missing-parent, archived-parent, and capped lineage without complete depth or metadata", () => {
    const capGoals: Goal[] = Array.from(
      { length: GOAL_METADATA_WALK_DEPTH_CAP + 1 },
      (_value, index) => ({
        id: `cap-${index}`,
        title: `Cap ${index}`,
        ...(index > 0 ? { parentGoalId: `cap-${index - 1}` } : {}),
        metadata: { index },
      }),
    );
    const source = projectFixture("project-a", {
      goals: [
        {
          id: "missing",
          title: "Missing",
          parentGoalId: "ghost",
          metadata: { leaf: true },
        },
        {
          id: "archived-child",
          title: "Archived child",
          parentGoalId: "archived-parent",
        },
        { id: "archived-parent", title: "Archived parent", archived: true },
        { id: "cycle-a", title: "Cycle A", parentGoalId: "cycle-b" },
        { id: "cycle-b", title: "Cycle B", parentGoalId: "cycle-a" },
        ...capGoals,
      ],
    });
    const { resolve } = resolverFor(source);

    for (const goalId of [
      "missing",
      "archived-child",
      "cycle-a",
      `cap-${GOAL_METADATA_WALK_DEPTH_CAP}`,
    ]) {
      const scope = resolve({
        projectId: "project-a",
        goalId,
        cwd: source.projectRoot,
      });
      assert.ok(
        scope?.goal,
        `${goalId} retains only safe leaf-level goal identity`,
      );
      assert.equal(
        scope?.goal?.depth,
        undefined,
        `${goalId} must not invent complete depth`,
      );
      assert.equal(
        scope?.goal?.metadata,
        undefined,
        `${goalId} must not expose effective metadata from an incomplete chain`,
      );
    }
  });

  it("never falls back across projects and rejects headquarters, hidden/system, and unknown projects", () => {
    const own = projectFixture("project-a");
    const foreign = projectFixture("project-b", {
      goals: [
        { id: "foreign-goal", title: "Foreign", metadata: { foreign: true } },
      ],
    });
    const headquarters = projectFixture("headquarters", {
      kind: "headquarters",
    });
    const system = projectFixture("system", { kind: "system", hidden: true });
    const { calls, resolve } = resolverFor(own, foreign, headquarters, system);

    assert.deepEqual(
      resolve({
        projectId: "project-a",
        goalId: "foreign-goal",
        roleName: "tester",
        cwd: own.projectRoot,
      }),
      {
        project: { id: "project-a", name: "Project A" },
        role: "tester",
      },
    );
    assert.equal(
      resolve({ projectId: "headquarters", cwd: headquarters.projectRoot }),
      undefined,
    );
    assert.equal(
      resolve({ projectId: "system", cwd: system.projectRoot }),
      undefined,
    );
    assert.equal(resolve({ projectId: "unknown", cwd: "/unknown" }), undefined);
    assert.deepEqual(
      calls,
      ["project-a", "headquarters", "system", "unknown"],
      "only the supplied session project may be queried",
    );
  });

  it("deep-freezes detached snapshots, including nested metadata and ancestry", () => {
    const storedMetadata = { nested: { enabled: true }, items: [{ value: 1 }] };
    const source = projectFixture("project-a", {
      goals: [{ id: "root", title: "Root", metadata: storedMetadata }],
    });
    const { resolve } = resolverFor(source);
    const scope = resolve({
      projectId: "project-a",
      goalId: "root",
      cwd: source.projectRoot,
    });

    assert.ok(scope?.goal?.metadata);
    storedMetadata.nested.enabled = false;
    storedMetadata.items[0].value = 2;
    assert.deepEqual(
      scope.goal.metadata,
      { nested: { enabled: true }, items: [{ value: 1 }] },
      "snapshot must not retain store-owned metadata",
    );
    assertDeepFrozen(scope);
    assert.throws(() => {
      (scope.goal!.metadata!.nested as { enabled: boolean }).enabled = false;
    }, TypeError);
    assert.throws(() => {
      (scope.goal!.ancestry as unknown as Array<unknown>).push({
        id: "mutated",
      });
    }, TypeError);
  });
});
