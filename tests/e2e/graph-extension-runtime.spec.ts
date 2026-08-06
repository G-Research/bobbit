import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GraphifyDeltaAdapter,
  rebuildCodeCompatibility,
  type GraphifyDeltaExecution,
  type GraphifyDeltaRequest,
} from "../../market-packs/code-intelligence/src/graphify-runner.ts";
import {
  GraphRuntime,
  type GraphContext,
  type GraphJob,
  type GraphRuntimePort,
  type GraphTarget,
} from "../../market-packs/code-intelligence/src/graph-runtime.ts";

const fixtureProgram = path.resolve(
  "tests2/fixtures/graphify-contract-fixture/graphify_fixture.py",
);
const FIVE_MINUTES_MS = 5 * 60_000;

type FixtureProbe = {
  modulePath: string;
  callable: string;
  signature: string[];
};
type FixtureResult = {
  graphPath: string;
  nodes: number;
  edges: number;
  sourcePaths: string[];
};
type Timing = { operation: string; elapsedMs: number; resultCount?: number };
type RuntimeChange = {
  head?: string;
  parentHeadRev?: string;
  changedPaths?: readonly string[];
  dirtyPaths?: readonly string[];
};
type RuntimeContext = GraphContext & {
  targets: GraphTarget[];
  changes?: Map<string, RuntimeChange>;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function python<T>(
  cwd: string,
  command: "probe" | "invoke",
  payload?: unknown,
): T {
  return JSON.parse(
    execFileSync("python3", [fixtureProgram, command], {
      cwd,
      encoding: "utf8",
      input: payload === undefined ? undefined : JSON.stringify(payload),
      windowsHide: true,
    }),
  ) as T;
}

function writeCorpus(root: string): void {
  for (const [relative, source] of Object.entries({
    "src/entry.ts": "export const entry = () => 'base';\n",
    "src/parent.ts": "export const parent = () => 'parent';\n",
    "docs/architecture.md": "# Graph runtime architecture\n",
  })) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
}

function checkoutManifest(root: string, directory = root): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...checkoutManifest(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute));
  }
  return files.sort();
}

function time<T>(
  operation: string,
  run: () => T,
): { value: T; timing: Timing } {
  const started = performance.now();
  const value = run();
  return {
    value,
    timing: { operation, elapsedMs: performance.now() - started },
  };
}

function createAdapter(telemetryPath: string): GraphifyDeltaAdapter {
  const execution: GraphifyDeltaExecution = {
    async probePublicDelta() {
      return null;
    },
    async invokePublicDelta() {
      throw new Error(
        "public Graphify delta is unavailable in the contract fixture",
      );
    },
    async probeCompatibility() {
      return python<FixtureProbe>(process.cwd(), "probe");
    },
    async invokeCompatibility(_spec, request) {
      return python<FixtureResult>(request.cwd, "invoke", {
        telemetryPath,
        request,
      });
    },
  };
  return new GraphifyDeltaAdapter("0.0.0", execution, [
    rebuildCodeCompatibility("0.0.0", ["root", "changed_paths"]),
  ]);
}

/** This E2E is deliberately serial: a nested Git worktree shares one common dir. */
test.describe.configure({ mode: "serial" });

test("GraphRuntime keeps linked and nested worktree graph artifacts host-only, stays non-blocking, floors base rebuilds, and records real timings", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "bobbit-graph-runtime-e2e-"),
  );
  const primary = path.join(root, "primary");
  const parent = path.join(root, "parent");
  const child = path.join(root, "child");
  const hostState = path.join(root, "host-state");
  const telemetryPath = path.join(hostState, "telemetry.json");
  let now = 1;
  let candidateSequence = 0;
  const executions: Array<GraphJob & { elapsedMs: number; graphPath: string }> =
    [];
  const failures: Array<{ operation: string; message: string }> = [];
  const stale: Array<{ target: GraphTarget; reason: string }> = [];
  const targetsByWorktree = new Map<string, string>();

  try {
    fs.mkdirSync(primary, { recursive: true });
    fs.mkdirSync(hostState, { recursive: true });
    fs.writeFileSync(
      telemetryPath,
      JSON.stringify({ compatibilityCalls: 0, linkedWorktreeGuardCalls: 0 }),
    );
    git(primary, "init", "--quiet");
    git(primary, "config", "user.email", "graph-runtime-e2e@bobbit.local");
    git(primary, "config", "user.name", "Graph runtime E2E");
    git(primary, "checkout", "--quiet", "-b", "main");
    writeCorpus(primary);
    git(primary, "add", ".");
    git(primary, "commit", "--quiet", "-m", "base corpus");
    git(
      primary,
      "worktree",
      "add",
      "--quiet",
      "-b",
      "goal/parent",
      parent,
      "HEAD",
    );
    fs.writeFileSync(
      path.join(parent, "src", "parent-goal.ts"),
      "export const parentGoal = true;\n",
    );
    git(parent, "add", ".");
    git(parent, "commit", "--quiet", "-m", "parent goal delta");
    // This is a real worktree derived from the parent worktree's branch head.
    git(
      parent,
      "worktree",
      "add",
      "--quiet",
      "-b",
      "goal/parent/child",
      child,
      "HEAD",
    );
    fs.writeFileSync(
      path.join(child, "src", "child-goal.ts"),
      "export const childGoal = true;\n",
    );
    git(child, "add", ".");
    git(child, "commit", "--quiet", "-m", "child goal delta");

    const parentTarget: GraphTarget = {
      projectId: "project-e2e",
      component: "app",
      worktreeId: "parent-worktree",
      goalId: "parent-goal",
      primaryRef: "main",
    };
    const childTarget: GraphTarget = {
      projectId: "project-e2e",
      component: "app",
      worktreeId: "child-worktree",
      goalId: "child-goal",
      parentGoalId: "parent-goal",
      primaryRef: "main",
    };
    targetsByWorktree.set(parentTarget.worktreeId, parent);
    targetsByWorktree.set(childTarget.worktreeId, child);
    const adapter = createAdapter(telemetryPath);

    const port: GraphRuntimePort<RuntimeContext> = {
      async resolveTargets(context) {
        return context.targets;
      },
      async observePrimary() {
        return git(primary, "rev-parse", "HEAD");
      },
      async inspectChanges(target, context) {
        return context.changes?.get(target.worktreeId) ?? null;
      },
      async markStale(target, reason) {
        stale.push({ target, reason });
      },
      async recordFailure(_target, operation, error) {
        failures.push({
          operation,
          message: error instanceof Error ? error.message : String(error),
        });
      },
      async execute(job) {
        const checkout =
          job.operation === "base-rebuild"
            ? primary
            : targetsByWorktree.get(job.target.worktreeId);
        if (!checkout)
          throw new Error(`missing checkout for ${job.target.worktreeId}`);
        const candidateRoot = path.join(
          hostState,
          "graphs",
          `${job.operation}-${candidateSequence++}`,
        );
        fs.mkdirSync(candidateRoot, { recursive: true });
        const started = performance.now();
        const result = await adapter.invokeDelta({
          cwd: checkout,
          candidateRoot,
          scanRoots: ["src", "docs"],
          changedPaths: job.changedPaths,
          noCluster: true,
        });
        executions.push({
          ...job,
          elapsedMs: performance.now() - started,
          graphPath: result.graphPath,
        });
      },
    };
    const runtime = new GraphRuntime(port, {
      clock: { now: () => now },
      debounceMs: 5,
      basePublishFloorMs: FIVE_MINUTES_MS,
      maxConcurrency: 1,
    });

    // Provision must enqueue instead of waiting for the live Graphify subprocess.
    const provisionStarted = performance.now();
    const provisionResult = await runtime.goalProvisioned({
      targets: [parentTarget],
    });
    const provisionElapsedMs = performance.now() - provisionStarted;
    expect(provisionResult.blocks).toEqual([]);
    expect(provisionElapsedMs).toBeLessThan(1_000);
    await expect
      .poll(() => runtime.status())
      .toMatchObject({ queued: 0, running: 0 });
    expect(executions.map((job) => job.operation)).toEqual(
      expect.arrayContaining(["base-rebuild", "provision"]),
    );

    // First observation establishes the direct parent revision. The second must
    // mark only the child chain stale and still leave hook failures non-fatal.
    const childChanges = new Map<string, RuntimeChange>([
      [
        childTarget.worktreeId,
        {
          head: git(child, "rev-parse", "HEAD"),
          parentHeadRev: git(parent, "rev-parse", "HEAD"),
          changedPaths: ["src/child-goal.ts"],
        },
      ],
    ]);
    await runtime.afterTurn({ targets: [childTarget], changes: childChanges });
    now += 5;
    runtime.tick();
    await expect
      .poll(() => runtime.status())
      .toMatchObject({ queued: 0, running: 0 });
    fs.writeFileSync(
      path.join(parent, "src", "parent-advanced.ts"),
      "export const parentAdvanced = true;\n",
    );
    git(parent, "add", ".");
    git(parent, "commit", "--quiet", "-m", "advance parent goal");
    childChanges.set(childTarget.worktreeId, {
      head: git(child, "rev-parse", "HEAD"),
      parentHeadRev: git(parent, "rev-parse", "HEAD"),
      changedPaths: ["src/child-goal.ts"],
    });
    const afterTurnStarted = performance.now();
    const afterTurnResult = await runtime.afterTurn({
      targets: [childTarget],
      changes: childChanges,
    });
    expect(performance.now() - afterTurnStarted).toBeLessThan(1_000);
    expect(afterTurnResult.blocks).toEqual([]);
    expect(stale).toEqual([{ target: childTarget, reason: "parent-advanced" }]);
    now += 5;
    runtime.tick();
    await expect
      .poll(() => runtime.status())
      .toMatchObject({ queued: 0, running: 0 });

    // A main advance is observed, but a second base build cannot publish before
    // the per-component five-minute floor expires.
    fs.writeFileSync(
      path.join(primary, "src", "main-advanced.ts"),
      "export const mainAdvanced = true;\n",
    );
    git(primary, "add", ".");
    git(primary, "commit", "--quiet", "-m", "advance primary");
    await runtime.afterTurn({ targets: [parentTarget] });
    expect(runtime.status().jobs.map((job) => job.operation)).toContain(
      "base-rebuild",
    );
    const beforeFloor = executions.filter(
      (job) => job.operation === "base-rebuild",
    ).length;
    runtime.tick();
    expect(
      executions.filter((job) => job.operation === "base-rebuild"),
    ).toHaveLength(beforeFloor);
    now = FIVE_MINUTES_MS + 1;
    runtime.tick();
    await expect
      .poll(() => runtime.status())
      .toMatchObject({ queued: 0, running: 0 });
    expect(
      executions.filter((job) => job.operation === "base-rebuild"),
    ).toHaveLength(beforeFloor + 1);

    // All artifact paths remain under host state, not in a primary, parent, or
    // nested-child checkout. The fixture's live guard proves this was enforced.
    const hostRealpath = fs.realpathSync(hostState);
    for (const execution of executions)
      expect(execution.graphPath.startsWith(`${hostRealpath}${path.sep}`)).toBe(
        true,
      );
    for (const checkout of [primary, parent, child]) {
      expect(checkoutManifest(checkout)).not.toContain("graphify-out");
      expect(fs.existsSync(path.join(checkout, "graphify-out"))).toBe(false);
      expect(fs.existsSync(path.join(checkout, ".graphify_root"))).toBe(false);
      expect(fs.existsSync(path.join(checkout, "graphify-cache"))).toBe(false);
    }
    expect(JSON.parse(fs.readFileSync(telemetryPath, "utf8"))).toMatchObject({
      linkedWorktreeGuardCalls: 0,
    });
    expect(failures).toEqual([]);

    // A rejected off-hook worker is captured as declared failure data. The hook
    // still resolves quickly and never leaks the executor error to the caller.
    const hookFailures: string[] = [];
    const failingRuntime = new GraphRuntime<RuntimeContext>(
      {
        resolveTargets: async (context) => context.targets,
        observePrimary: async () => git(primary, "rev-parse", "HEAD"),
        execute: async () => {
          throw new Error("intentional graph worker failure");
        },
        recordFailure: async (_target, operation) => {
          hookFailures.push(operation);
        },
      },
      { clock: { now: () => now }, maxConcurrency: 1 },
    );
    const failingHookStarted = performance.now();
    expect(
      await failingRuntime.goalProvisioned({ targets: [childTarget] }),
    ).toEqual({ blocks: [] });
    expect(performance.now() - failingHookStarted).toBeLessThan(1_000);
    await expect
      .poll(() => failingRuntime.status())
      .toMatchObject({ queued: 0, running: 0 });
    expect(hookFailures).toEqual(
      expect.arrayContaining(["base-rebuild", "provision"]),
    );

    // Timings are measured against generated host artifacts, rather than
    // hard-coded evidence. The two query scopes must be independently observable.
    const graph = JSON.parse(
      fs.readFileSync(executions.at(-1)!.graphPath, "utf8"),
    ) as { sourcePaths: string[] };
    const codeQuery = time("query-code", () =>
      graph.sourcePaths.filter((source) => !source.startsWith("docs/")),
    );
    const codeDocsQuery = time("query-code-docs", () => graph.sourcePaths);
    const timings: Timing[] = [
      ...executions.map((execution) => ({
        operation: execution.operation,
        elapsedMs: execution.elapsedMs,
      })),
      { ...codeQuery.timing, resultCount: codeQuery.value.length },
      { ...codeDocsQuery.timing, resultCount: codeDocsQuery.value.length },
    ];
    expect(codeQuery.value).not.toContain("docs/architecture.md");
    expect(codeDocsQuery.value).toContain("docs/architecture.md");
    for (const timing of timings) {
      expect(
        timing.elapsedMs,
        `${timing.operation} timing`,
      ).toBeGreaterThanOrEqual(0);
      expect(timing.elapsedMs, `${timing.operation} timing`).toBeLessThan(
        5_000,
      );
    }
  } finally {
    try {
      git(primary, "worktree", "remove", "--force", child);
    } catch {
      /* partial fixture setup */
    }
    try {
      git(primary, "worktree", "remove", "--force", parent);
    } catch {
      /* partial fixture setup */
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
