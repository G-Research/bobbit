/**
 * Real Docker restart/lifecycle coverage for command verification ownership.
 *
 * Each barrier is an observable protocol edge: gateway boot log, WebSocket
 * verification output/completion, HTTP cancellation acknowledgement, or an
 * atomic active-verification state-file change. No sleeps or polling are used.
 */
import { test, expect } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
  cpSync,
} from "node:fs";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { manualTmpRoot } from "./manual-test-paths.js";
import { seedManualTestModelPreferences } from "./manual-test-model-seeding.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const SERVER_CLI = join(PROJECT_ROOT, "dist", "server", "cli.js");

interface Gateway {
  proc: ChildProcess;
  port: number;
  dir: string;
  token: string;
  base: string;
}

interface Viewer {
  messages: any[];
  mark(): number;
  waitFrom(
    index: number,
    predicate: (event: any) => boolean,
    timeoutMs?: number,
  ): Promise<any>;
  close(): void;
}

interface RunningStep {
  goalId: string;
  gateId: string;
  signalId: string;
  payloadPid: number;
  hostPid: number;
  witness: {
    containerId: string;
    nonce: string;
    sentinelPid: number;
    pgid: number;
    startToken: string;
  };
}

function requireDockerPrerequisites(): void {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
  } catch (error) {
    throw new Error(
      `verification-container-ownership requires a reachable Docker daemon: ${String(error)}`,
    );
  }
  try {
    execFileSync("docker", ["image", "inspect", "bobbit-agent"], {
      stdio: "ignore",
      timeout: 10_000,
    });
  } catch (error) {
    throw new Error(
      `verification-container-ownership requires the bobbit-agent Docker image: ${String(error)}`,
    );
  }
}

function docker(args: string[]): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 20_000,
  }).trim();
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function startGateway(dir: string, port: number): Promise<Gateway> {
  mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
  seedManualTestModelPreferences(dir);
  const proc = spawn(
    process.execPath,
    [
      SERVER_CLI,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-tls",
      "--auth",
      "--cwd",
      dir,
    ],
    {
      env: {
        ...process.env,
        BOBBIT_DIR: join(dir, ".bobbit"),
        BOBBIT_SECRETS_DIR: join(dir, ".bobbit", "state"),
        BOBBIT_SKIP_MCP: "1",
        BOBBIT_SKIP_AIGW_DISCOVERY: "1",
        BOBBIT_SKIP_TITLE_GEN: "1",
        BOBBIT_SKIP_NPM_CI: "1",
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  const ready = new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Gateway did not become ready:\n${output}`)),
      120_000,
    );
    const observe = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("[boot] start() ready on port")) {
        clearTimeout(timer);
        resolveReady();
      }
    };
    proc.stdout!.on("data", observe);
    proc.stderr!.on("data", observe);
    proc.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Gateway exited before ready (${code ?? signal}):\n${output}`,
        ),
      );
    });
  });
  await ready;
  const token = readFileSync(
    join(dir, ".bobbit", "state", "token"),
    "utf8",
  ).trim();
  return { proc, port, dir, token, base: `http://127.0.0.1:${port}` };
}

async function crashGateway(gateway: Gateway): Promise<void> {
  if (gateway.proc.exitCode !== null) return;
  const exited = new Promise<void>((resolveExited) =>
    gateway.proc.once("exit", () => resolveExited()),
  );
  gateway.proc.kill("SIGKILL");
  await exited;
}

async function stopGateway(gateway: Gateway | undefined): Promise<void> {
  if (!gateway || gateway.proc.exitCode !== null) return;
  const exited = new Promise<void>((resolveExited) =>
    gateway.proc.once("exit", () => resolveExited()),
  );
  gateway.proc.kill("SIGKILL");
  await exited;
}

function api(
  gateway: Gateway,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${gateway.base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${gateway.token}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

async function expectResponseStatus(
  response: Response,
  expected: number,
): Promise<void> {
  if (response.status !== expected) {
    throw new Error(
      `expected HTTP ${expected}, got ${response.status}: ${await response.text()}`,
    );
  }
}

async function connectViewer(
  gateway: Gateway,
  goalId: string,
): Promise<Viewer> {
  return new Promise((resolveViewer, reject) => {
    const ws = new WebSocket(`${gateway.base.replace("http", "ws")}/ws/viewer`);
    const messages: any[] = [];
    const waiters: Array<{
      from: number;
      predicate: (event: any) => boolean;
      resolve: (event: any) => void;
    }> = [];
    const timeout = setTimeout(
      () => reject(new Error("Viewer WebSocket authentication timed out")),
      15_000,
    );
    ws.on("open", () =>
      ws.send(JSON.stringify({ type: "auth", token: gateway.token, goalId })),
    );
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const event = JSON.parse(raw.toString());
      messages.push(event);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (
          messages.length - 1 >= waiters[i].from &&
          waiters[i].predicate(event)
        ) {
          waiters[i].resolve(event);
          waiters.splice(i, 1);
        }
      }
      if (event.type === "auth_ok") {
        clearTimeout(timeout);
        resolveViewer({
          messages,
          mark: () => messages.length,
          waitFrom(from, predicate, timeoutMs = 90_000) {
            const existing = messages.slice(from).find(predicate);
            if (existing) return Promise.resolve(existing);
            return new Promise((resolveWait, rejectWait) => {
              const timer = setTimeout(
                () => rejectWait(new Error("Viewer event barrier timed out")),
                timeoutMs,
              );
              waiters.push({
                from,
                predicate,
                resolve: (event) => {
                  clearTimeout(timer);
                  resolveWait(event);
                },
              });
            });
          },
          close: () => ws.close(),
        });
      }
    });
  });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "ownership-e2e@example.test"], {
    cwd: dir,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Ownership E2E"], {
    cwd: dir,
    stdio: "ignore",
  });
  writeFileSync(join(dir, "README.md"), "# verification ownership fixture\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "fixture"], {
    cwd: dir,
    stdio: "ignore",
  });
  mkdirSync(join(dir, ".bobbit", "config"), { recursive: true });
  writeFileSync(
    join(dir, ".bobbit", "config", "project.yaml"),
    'sandbox: "docker"\n',
  );
  const sourceConfig = join(PROJECT_ROOT, ".bobbit", "config");
  if (existsSync(sourceConfig)) {
    cpSync(sourceConfig, join(dir, ".bobbit", "config"), {
      recursive: true,
      filter: (source) => !source.endsWith("project.yaml"),
    });
  }
}

async function createSandboxGoal(
  gateway: Gateway,
  projectId: string,
  title: string,
  gates: any[],
): Promise<string> {
  const response = await api(gateway, "/api/goals", {
    method: "POST",
    body: JSON.stringify({
      projectId,
      title,
      spec: "Exercise exact container verification ownership with real Docker processes.",
      workflowId: `container-ownership-${title}`,
      workflow: { id: `container-ownership-${title}`, name: title, gates },
      sandboxed: true,
      worktree: false,
      autoStartTeam: false,
    }),
  });
  await expectResponseStatus(response, 201);
  return (await response.json()).id;
}

function blockingCommand(label: string): string {
  return `printf 'READY:${label}:PAYLOAD=%s\\n' "$$"; exec tail -f /dev/null`;
}

function normalCommand(label: string): string {
  const fifo = `/tmp/bobbit-verify-${label}.fifo`;
  return `rm -f ${fifo}; mkfifo ${fifo}; printf 'READY:${label}:PAYLOAD=%s\\n' "$$"; IFS= read -r _ < ${fifo}; rm -f ${fifo}`;
}

/**
 * The payload is an adversary. It reads the immediate wrapper command line to
 * recover its nonce, then bypasses the payload FIFO and writes an exact control
 * line straight to the wrapper's stdout FD. The harness must authenticate the
 * control-channel writer, not merely its bytes.
 */
function forgedWrapperFdCompletionCommand(
  label: string,
  action: "fail" | "hold",
): string {
  const fifo = `/tmp/bobbit-verify-${label}.fifo`;
  const afterForgery =
    action === "fail"
      ? "exit 23"
      : `IFS= read -r _ < ${fifo}; rm -f ${fifo}`;
  const prepareHold =
    action === "hold" ? `rm -f ${fifo}; mkfifo ${fifo}; ` : "";
  return `__bobbit_parent=$PPID; __bobbit_nonce=$(tr '\\000' '\\n' < "/proc/$__bobbit_parent/cmdline" 2>/dev/null | grep -Eo "BOBBIT_NONCE=['\\\"]?[0-9a-f-]{36}" | sed "s/.*=['\\\"]*//" | head -n 1); test -n "$__bobbit_nonce" || { printf 'ADVERSARY_PARENT_NONCE_DISCOVERY_FAILED:${label}\\n' >&2; exit 97; }; ${prepareHold}printf 'READY:${label}:PAYLOAD=%s\\n' "$$"; printf 'ADVERSARY_DIRECT_WRAPPER_FD_FORGERY:${label}\\n' >&2; printf 'BOBBIT_CONTAINER_LAUNCHER_EXIT:%s:0\\n' "$__bobbit_nonce" > "/proc/$__bobbit_parent/fd/1"; ${afterForgery}`;
}

async function startStep(
  viewer: Viewer,
  gateway: Gateway,
  goalId: string,
  gateId: string,
  label: string,
  containerId: string,
): Promise<RunningStep> {
  const from = viewer.mark();
  const response = await api(
    gateway,
    `/api/goals/${goalId}/gates/${gateId}/signal`,
    {
      method: "POST",
      body: JSON.stringify({ content: `start ${label}` }),
    },
  );
  await expectResponseStatus(response, 201);
  const signalId = (await response.json()).signal.id as string;
  const ready = await viewer.waitFrom(
    from,
    (event) =>
      event.type === "gate_verification_step_output" &&
      event.signalId === signalId &&
      typeof event.text === "string" &&
      event.text.includes(`READY:${label}:`),
  );
  const payloadPid = Number(/PAYLOAD=(\d+)/.exec(ready.text)?.[1]);
  expect(payloadPid, `missing payload PID in ${ready.text}`).toBeGreaterThan(0);

  const activeResponse = await api(
    gateway,
    `/api/goals/${goalId}/verifications/active`,
  );
  expect(activeResponse.status).toBe(200);
  const active = (await activeResponse.json()).verifications.find(
    (entry: any) => entry.signalId === signalId,
  );
  expect(
    active,
    "ready output must follow durable active-step publication",
  ).toBeTruthy();
  const step = active.steps[0];
  expect(step.restartRecoveryMode).toBe("container-exec");
  expect(step.pid).toBeGreaterThan(0);
  expect(step.pidNonce).toBeTruthy();
  expect(step.containerWitnessFile).toBeTruthy();
  // The API input may be Docker's short selector. Durable authority records
  // Docker's canonical immutable ID, which must also bind the witness.
  expect(step.containerId).toMatch(/^[a-f0-9]{64}$/i);
  const witness = JSON.parse(
    docker(["exec", containerId, "cat", step.containerWitnessFile]),
  );
  expect(witness).toMatchObject({ containerId: step.containerId, nonce: step.pidNonce });
  expect(witness.sentinelPid).toBeGreaterThan(0);
  expect(witness.pgid).toBeGreaterThan(0);
  expect(witness.startToken).toBeTruthy();
  return { goalId, gateId, signalId, payloadPid, hostPid: step.pid, witness };
}

function assertHostGone(pid: number): void {
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  expect(alive, `docker exec transport ${pid} must be gone`).toBe(false);
}

function assertHostAlive(pid: number): void {
  try {
    process.kill(pid, 0);
  } catch (error) {
    throw new Error(`docker exec transport ${pid} died: ${String(error)}`);
  }
}

function assertContainerGone(containerId: string, pid: number): void {
  let alive = true;
  try {
    // `kill -0` reports a zombie until the container's PID 1 reaps it. A Z
    // state is terminal, not a live payload that can retain work or signals.
    const state = execFileSync("docker", ["exec", containerId, "/bin/sh", "-c", `awk '{print $3}' /proc/${pid}/stat 2>/dev/null || true`], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    alive = state !== "" && state !== "Z";
  } catch {
    alive = false;
  }
  expect(alive, `container payload ${pid} must be gone`).toBe(false);
}

function assertContainerAlive(
  containerId: string,
  pid: number,
  label: string,
): void {
  execFileSync("docker", ["exec", containerId, "/bin/sh", "-c", `kill -0 ${pid}`], {
    stdio: "ignore",
    timeout: 10_000,
  });
  expect(pid, `${label} PID`).toBeGreaterThan(0);
}

function readActiveVerification(statePath: string, signalId: string): any | undefined {
  if (!existsSync(statePath)) return undefined;
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  return state.verifications?.find((entry: any) => entry.signalId === signalId);
}

function waitForActiveVerification(
  statePath: string,
  signalId: string,
  predicate: (entry: any | undefined) => boolean,
  reason: string,
): Promise<any | undefined> {
  return new Promise((resolveState, reject) => {
    let watcher: ReturnType<typeof watch> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (entry: any | undefined) => {
      watcher?.close();
      if (timer) clearTimeout(timer);
      resolveState(entry);
    };
    const observe = () => {
      try {
        const entry = readActiveVerification(statePath, signalId);
        if (predicate(entry)) finish(entry);
      } catch (error) {
        watcher?.close();
        if (timer) clearTimeout(timer);
        reject(error);
      }
    };
    watcher = watch(resolve(statePath, ".."), (_event, file) => {
      if (file === "active-verifications.json") observe();
    });
    timer = setTimeout(() => {
      watcher?.close();
      reject(new Error(reason));
    }, 120_000);
    // Covers a transition that completed between the HTTP acknowledgement and
    // watcher setup without turning this event barrier into polling.
    observe();
  });
}

function waitForActiveRemoval(
  statePath: string,
  signalId: string,
): Promise<void> {
  return waitForActiveVerification(
    statePath,
    signalId,
    (entry) => !entry,
    `restart recovery did not settle ${signalId}`,
  ).then(() => undefined);
}

function cleanupDockerProject(projectId: string): void {
  for (const id of docker([
    "ps",
    "-aq",
    "--filter",
    `label=bobbit-project=${projectId}`,
  ])
    .split(/\s+/)
    .filter(Boolean)) {
    try {
      docker(["rm", "-f", id]);
    } catch {
      /* teardown best effort */
    }
  }
  for (const volume of docker([
    "volume",
    "ls",
    "-q",
    "--filter",
    `label=bobbit-project=${projectId}`,
  ])
    .split(/\s+/)
    .filter(Boolean)) {
    try {
      docker(["volume", "rm", "-f", volume]);
    } catch {
      /* teardown best effort */
    }
  }
}

test.describe.configure({ mode: "serial" });

test("container command verification owns only its exact payload and docker-exec transport", async () => {
  requireDockerPrerequisites();
  test.setTimeout(300_000);

  const port = await freePort();
  const root = join(manualTmpRoot(), `.bobbit-container-ownership-${port}`);
  rmSync(root, { recursive: true, force: true });
  initRepo(root);
  let gateway: Gateway | undefined;
  let viewer: Viewer | undefined;
  let projectId = "";
  let containerId = "";
  let siblingPid = 0;
  const activePath = join(root, ".bobbit", "state", "active-verifications.json");
  try {
    gateway = await startGateway(root, port);
    const projectResponse = await api(gateway, "/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: `container-ownership-${port}`,
        rootPath: root,
        acceptCanonical: true,
      }),
    });
    await expectResponseStatus(projectResponse, 201);
    projectId = (await projectResponse.json()).id;
    const configResponse = await api(
      gateway,
      `/api/projects/${projectId}/config`,
      {
        method: "PUT",
        body: JSON.stringify({ sandbox: "docker" }),
      },
    );
    await expectResponseStatus(configResponse, 200);

    const bootstrapGoal = await createSandboxGoal(
      gateway,
      projectId,
      "bootstrap",
      [
        {
          id: "bootstrap",
          name: "bootstrap",
          dependsOn: [],
          verify: [
            {
              name: "bootstrap",
              type: "command",
              run: normalCommand("bootstrap"),
              timeout: 30,
            },
          ],
        },
      ],
    );
    containerId = docker([
      "ps",
      "-q",
      "--filter",
      `label=bobbit-project=${projectId}`,
    ]);
    expect(containerId).toBeTruthy();
    viewer = await connectViewer(gateway, bootstrapGoal);
    const normalFrom = viewer.mark();
    const bootstrap = await startStep(
      viewer,
      gateway,
      bootstrapGoal,
      "bootstrap",
      "bootstrap",
      containerId,
    );
    // Release the command through its FIFO only after the durable witness and
    // host transport record were observed above.
    docker([
      "exec",
      containerId,
      "/bin/sh",
      "-c",
      "printf x > /tmp/bobbit-verify-bootstrap.fifo",
    ]);
    // A normal exit is the first lifecycle contract: completion follows payload
    // and transport cleanup, not just the command leader's exit.
    const normalDone = await viewer.waitFrom(
      normalFrom,
      (event) =>
        event.type === "gate_verification_complete" &&
        event.signalId === bootstrap.signalId,
    );
    expect(normalDone.status).toBe("passed");
    assertContainerGone(containerId, bootstrap.payloadPid);
    assertHostGone(bootstrap.hostPid);
    viewer.close();
    viewer = undefined;
    siblingPid = Number(
      docker([
        "exec",
        containerId,
        "/bin/sh",
        "-c",
        "setsid /bin/sh -c 'trap \"\" TERM; exec tail -f /dev/null' >/dev/null 2>&1 & echo $!",
      ]),
    );
    assertContainerAlive(containerId, siblingPid, "unrelated sibling");

    const timeoutGoal = await createSandboxGoal(gateway, projectId, "timeout", [
      {
        id: "timeout",
        name: "timeout",
        dependsOn: [],
        verify: [
          {
            name: "timeout",
            type: "command",
            run: blockingCommand("timeout"),
            timeout: 1,
          },
        ],
      },
    ]);
    viewer = await connectViewer(gateway, timeoutGoal);
    const timeoutFrom = viewer.mark();
    const timeoutStep = await startStep(
      viewer,
      gateway,
      timeoutGoal,
      "timeout",
      "timeout",
      containerId,
    );
    const timeoutDone = await viewer.waitFrom(
      timeoutFrom,
      (event) =>
        event.type === "gate_verification_complete" &&
        event.signalId === timeoutStep.signalId,
      120_000,
    );
    expect(timeoutDone.status).toBe("failed");
    assertContainerGone(containerId, timeoutStep.payloadPid);
    assertHostGone(timeoutStep.hostPid);
    assertContainerAlive(
      containerId,
      siblingPid,
      "unrelated sibling after timeout",
    );
    viewer.close();
    viewer = undefined;

    const forgedFailureGoal = await createSandboxGoal(
      gateway,
      projectId,
      "forged-nonzero",
      [
        {
          id: "forged-nonzero",
          name: "forged-nonzero",
          dependsOn: [],
          verify: [
            {
              name: "forged-nonzero",
              type: "command",
              run: forgedWrapperFdCompletionCommand("forged-nonzero", "fail"),
              timeout: 30,
            },
          ],
        },
      ],
    );
    viewer = await connectViewer(gateway, forgedFailureGoal);
    const forgedFailureFrom = viewer.mark();
    const forgedFailure = await startStep(
      viewer,
      gateway,
      forgedFailureGoal,
      "forged-nonzero",
      "forged-nonzero",
      containerId,
    );
    const forgedFailureControlLine = await viewer.waitFrom(
      forgedFailureFrom,
      (event) =>
        event.type === "gate_verification_step_output" &&
        event.signalId === forgedFailure.signalId &&
        typeof event.text === "string" &&
        event.text.includes(`BOBBIT_CONTAINER_LAUNCHER_EXIT:${forgedFailure.witness.nonce}:0`),
    );
    expect(
      forgedFailureControlLine.text,
      "the adversary must reach the wrapper FD rather than the payload FIFO",
    ).not.toContain("[payload]");
    const forgedFailureDone = await viewer.waitFrom(
      forgedFailureFrom,
      (event) =>
        event.type === "gate_verification_complete" &&
        event.signalId === forgedFailure.signalId,
    );
    expect(
      forgedFailureDone.status,
      "payload-controlled completion-shaped output must not turn exit 23 into a pass",
    ).toBe("failed");
    assertContainerGone(containerId, forgedFailure.payloadPid);
    assertHostGone(forgedFailure.hostPid);
    assertContainerAlive(
      containerId,
      siblingPid,
      "unrelated sibling after forged nonzero completion",
    );
    viewer.close();
    viewer = undefined;

    const forgedHoldGoal = await createSandboxGoal(
      gateway,
      projectId,
      "forged-hold",
      [
        {
          id: "forged-hold",
          name: "forged-hold",
          dependsOn: [],
          verify: [
            {
              name: "forged-hold",
              type: "command",
              run: forgedWrapperFdCompletionCommand("forged-hold", "hold"),
              timeout: 30,
            },
          ],
        },
      ],
    );
    viewer = await connectViewer(gateway, forgedHoldGoal);
    const forgedHoldFrom = viewer.mark();
    const forgedHold = await startStep(
      viewer,
      gateway,
      forgedHoldGoal,
      "forged-hold",
      "forged-hold",
      containerId,
    );
    const forgedHoldControlLine = await viewer.waitFrom(
      forgedHoldFrom,
      (event) =>
        event.type === "gate_verification_step_output" &&
        event.signalId === forgedHold.signalId &&
        typeof event.text === "string" &&
        event.text.includes(`BOBBIT_CONTAINER_LAUNCHER_EXIT:${forgedHold.witness.nonce}:0`),
    );
    expect(
      forgedHoldControlLine.text,
      "the held payload must inject its forged line through the wrapper FD",
    ).not.toContain("[payload]");
    const forgedHoldActive = await api(
      gateway,
      `/api/goals/${forgedHoldGoal}/verifications/active`,
    );
    await expectResponseStatus(forgedHoldActive, 200);
    expect(
      (await forgedHoldActive.json()).verifications.some(
        (entry: any) => entry.signalId === forgedHold.signalId,
      ),
      "forged output cannot terminally publish while its payload is still blocked",
    ).toBe(true);
    expect(
      viewer.messages
        .slice(forgedHoldFrom)
        .some(
          (event) =>
            event.type === "gate_verification_complete" &&
            event.signalId === forgedHold.signalId,
        ),
      "forged output cannot emit completion before the payload exits",
    ).toBe(false);
    assertContainerAlive(
      containerId,
      forgedHold.payloadPid,
      "payload after forged completion-shaped output",
    );
    assertHostAlive(forgedHold.hostPid);
    docker([
      "exec",
      containerId,
      "/bin/sh",
      "-c",
      "printf x > /tmp/bobbit-verify-forged-hold.fifo",
    ]);
    const forgedHoldDone = await viewer.waitFrom(
      forgedHoldFrom,
      (event) =>
        event.type === "gate_verification_complete" &&
        event.signalId === forgedHold.signalId,
    );
    expect(forgedHoldDone.status).toBe("passed");
    assertContainerGone(containerId, forgedHold.payloadPid);
    assertHostGone(forgedHold.hostPid);
    assertContainerAlive(
      containerId,
      siblingPid,
      "unrelated sibling after forged held completion",
    );
    viewer.close();
    viewer = undefined;

    const concurrentGoal = await createSandboxGoal(
      gateway,
      projectId,
      "concurrent",
      [
        {
          id: "a",
          name: "a",
          dependsOn: [],
          verify: [
            {
              name: "a",
              type: "command",
              run: blockingCommand("concurrent-a"),
              timeout: 60,
            },
          ],
        },
        {
          id: "b",
          name: "b",
          dependsOn: [],
          verify: [
            {
              name: "b",
              type: "command",
              run: blockingCommand("concurrent-b"),
              timeout: 60,
            },
          ],
        },
      ],
    );
    viewer = await connectViewer(gateway, concurrentGoal);
    const first = await startStep(
      viewer,
      gateway,
      concurrentGoal,
      "a",
      "concurrent-a",
      containerId,
    );
    const second = await startStep(
      viewer,
      gateway,
      concurrentGoal,
      "b",
      "concurrent-b",
      containerId,
    );
    expect(first.witness.nonce).not.toBe(second.witness.nonce);
    expect(first.witness.pgid).not.toBe(second.witness.pgid);
    const cancelA = await api(
      gateway,
      `/api/goals/${concurrentGoal}/gates/a/cancel-verification`,
      { method: "POST" },
    );
    await expectResponseStatus(cancelA, 200);
    assertContainerGone(containerId, first.payloadPid);
    assertHostGone(first.hostPid);
    assertContainerAlive(
      containerId,
      second.payloadPid,
      "concurrent step B after cancelling step A",
    );
    assertHostAlive(second.hostPid);
    assertContainerAlive(
      containerId,
      siblingPid,
      "unrelated sibling after concurrent cancellation",
    );
    const cancelB = await api(
      gateway,
      `/api/goals/${concurrentGoal}/gates/b/cancel-verification`,
      { method: "POST" },
    );
    await expectResponseStatus(cancelB, 200);
    assertContainerGone(containerId, second.payloadPid);
    assertHostGone(second.hostPid);
    viewer.close();
    viewer = undefined;

    const restartGoal = await createSandboxGoal(gateway, projectId, "restart", [
      {
        id: "restart",
        name: "restart",
        dependsOn: [],
        verify: [
          {
            name: "restart",
            type: "command",
            run: blockingCommand("restart"),
            timeout: 1,
          },
        ],
      },
    ]);
    viewer = await connectViewer(gateway, restartGoal);
    const restartStep = await startStep(
      viewer,
      gateway,
      restartGoal,
      "restart",
      "restart",
      containerId,
    );
    const recovered = waitForActiveRemoval(activePath, restartStep.signalId);
    viewer.close();
    viewer = undefined;
    await crashGateway(gateway);
    gateway = await startGateway(root, port);
    await recovered;
    assertContainerGone(containerId, restartStep.payloadPid);
    assertHostGone(restartStep.hostPid);
    assertContainerAlive(
      containerId,
      siblingPid,
      "unrelated sibling after restart recovery",
    );
    // Recovery closes its viewer before the gateway crash; keep this transition
    // idempotent so restart cleanup cannot dereference the already-cleared viewer.
    viewer?.close();
    viewer = undefined;

    // Break the in-container atomic witness path before the wrapper can launch
    // user code. A regular file where the state directory must be makes mkdir
    // fail deterministically even for root inside the test container.
    docker([
      "exec",
      containerId,
      "/bin/sh",
      "-c",
      "rm -rf /tmp/.bobbit-verif; : > /tmp/.bobbit-verif",
    ]);
    const witnessFailureGoal = await createSandboxGoal(
      gateway,
      projectId,
      "witness-publication-failure",
      [
        {
          id: "witness-publication-failure",
          name: "witness-publication-failure",
          dependsOn: [],
          verify: [
            {
              name: "witness-publication-failure",
              type: "command",
              run: "printf 'PAYLOAD_STARTED:witness-publication-failure\\n'; exec tail -f /dev/null",
              timeout: 30,
            },
          ],
        },
      ],
    );
    viewer = await connectViewer(gateway, witnessFailureGoal);
    const witnessFailureFrom = viewer.mark();
    const witnessFailureResponse = await api(
      gateway,
      `/api/goals/${witnessFailureGoal}/gates/witness-publication-failure/signal`,
      {
        method: "POST",
        body: JSON.stringify({ content: "start witness publication failure" }),
      },
    );
    await expectResponseStatus(witnessFailureResponse, 201);
    const witnessFailureSignalId = (await witnessFailureResponse.json()).signal.id as string;
    const pendingFailure = await waitForActiveVerification(
      activePath,
      witnessFailureSignalId,
      (entry) => entry?.steps?.[0]?.containerPayloadCleanupPending === true,
      "container witness publication failure did not reject ownership readiness",
    );
    expect(pendingFailure).toBeTruthy();
    const failedStep = pendingFailure!.steps[0];
    expect(
      failedStep.containerPayloadCleanupPending,
      "a pre-payload witness failure must reject ownership readiness and remain retryable",
    ).toBe(true);
    expect(
      viewer.messages.slice(witnessFailureFrom).some(
        (event) =>
          event.type === "gate_verification_step_output" &&
          event.signalId === witnessFailureSignalId &&
          typeof event.text === "string" &&
          event.text.includes("PAYLOAD_STARTED:witness-publication-failure"),
      ),
      "user payload must not start before atomic witness publication",
    ).toBe(false);
    expect(
      viewer.messages.slice(witnessFailureFrom).some(
        (event) =>
          event.type === "gate_verification_complete" &&
          event.signalId === witnessFailureSignalId,
      ),
      "no terminal gate publication is permitted while exact payload cleanup proof is absent",
    ).toBe(false);
    expect(failedStep.sentinelFile, "host transport needs its own exact sentinel witness").toBeTruthy();
    const hostWitness = JSON.parse(readFileSync(failedStep.sentinelFile, "utf8"));
    expect(hostWitness.pid).toBeGreaterThan(0);
    assertHostGone(failedStep.pid);
    assertHostGone(hostWitness.pid);
    assertContainerAlive(
      containerId,
      siblingPid,
      "unrelated sibling after pre-payload witness failure",
    );
  } finally {
    try {
      if (containerId && siblingPid)
        docker(["exec", containerId, "kill", "-KILL", String(siblingPid)]);
    } catch {
      /* best effort */
    }
    viewer?.close();
    await stopGateway(gateway);
    if (projectId) cleanupDockerProject(projectId);
    rmSync(root, { recursive: true, force: true });
  }
});
