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
  witnessFile: string;
  witness: {
    containerId: string;
    nonce: string;
    sentinelPid: number;
    pgid: number;
    startToken: string;
  };
}

interface ContainerIdentity {
  pid: number;
  pgid: number;
  startToken: string;
  termFile: string;
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

/**
 * Same-UID payload attack: discover wrapper-only values through /proc, retain
 * this step's containerId/nonce, and atomically replace its witness with a
 * different live process group's exact identity.
 */
function witnessSubstitutionCommand(
  label: string,
  target: number | { witnessFile: string },
  releaseFifo?: string,
): string {
  const targetDiscovery =
    typeof target === "number"
      ? `__bobbit_target_pid=${target};`
      : `__bobbit_target_witness=${target.witnessFile}; test -f "$__bobbit_target_witness" || { printf 'ADVERSARY_CONCURRENT_WITNESS_DISCOVERY_FAILED:${label}\\n' >&2; exit 97; }; __bobbit_target_pid=$(sed -n 's/.*"sentinelPid":\\([0-9][0-9]*\\).*/\\1/p' "$__bobbit_target_witness");`;
  const waitForHostPin = releaseFifo
    ? `rm -f ${releaseFifo}; mkfifo ${releaseFifo}; printf 'READY:${label}:PAYLOAD=%s\\n' "$$"; IFS= read -r _ < ${releaseFifo}; `
    : "";
  const readyAfterAttack = releaseFifo
    ? ""
    : `printf 'READY:${label}:PAYLOAD=%s\\n' "$$"; `;
  return `${waitForHostPin}__bobbit_parent=$PPID; __bobbit_cmd=$(tr '\\000' '\\n' < "/proc/$__bobbit_parent/cmdline" 2>/dev/null); __bobbit_nonce=$(printf '%s\\n' "$__bobbit_cmd" | grep -Eo "BOBBIT_NONCE=['\\\"]?[0-9a-f-]{36}" | sed "s/.*=['\\\"]*//" | head -n 1); __bobbit_witness=$(printf '%s\\n' "$__bobbit_cmd" | grep -Eo "BOBBIT_WITNESS=['\\\"]?[^'\\\"[:space:]]+" | sed "s/.*=['\\\"]*//" | head -n 1); test -n "$__bobbit_nonce" && test -n "$__bobbit_witness" && test -f "$__bobbit_witness" || { printf 'ADVERSARY_WITNESS_DISCOVERY_FAILED:${label}\\n' >&2; exit 97; }; __bobbit_container=$(sed -n 's/.*"containerId":"\\([^"]*\\)".*/\\1/p' "$__bobbit_witness"); __bobbit_witness_nonce=$(sed -n 's/.*"nonce":"\\([^"]*\\)".*/\\1/p' "$__bobbit_witness"); test -n "$__bobbit_container" && test "$__bobbit_witness_nonce" = "$__bobbit_nonce" || { printf 'ADVERSARY_WITNESS_BINDING_FAILED:${label}\\n' >&2; exit 97; }; ${targetDiscovery} set -- $(awk '{print $1, $5, $22}' "/proc/$__bobbit_target_pid/stat" 2>/dev/null); __bobbit_live_pid=$1; __bobbit_live_pgid=$2; __bobbit_live_start=$3; test "$__bobbit_live_pid" = "$__bobbit_target_pid" && test -n "$__bobbit_live_pgid" && test -n "$__bobbit_live_start" || { printf 'ADVERSARY_TARGET_IDENTITY_FAILED:${label}\\n' >&2; exit 97; }; __bobbit_tmp="$__bobbit_witness.attack.$$"; printf '{"containerId":"%s","nonce":"%s","sentinelPid":%s,"pgid":%s,"startToken":"%s"}\\n' "$__bobbit_container" "$__bobbit_nonce" "$__bobbit_live_pid" "$__bobbit_live_pgid" "$__bobbit_live_start" > "$__bobbit_tmp" && mv "$__bobbit_tmp" "$__bobbit_witness" || { printf 'ADVERSARY_WITNESS_REPLACEMENT_FAILED:${label}\\n' >&2; exit 97; }; printf 'WITNESS_SUBSTITUTED:${label}:PGID=%s\\n' "$__bobbit_live_pgid"; ${readyAfterAttack}exec tail -f /dev/null`;
}

function signalRecordingBlockingCommand(
  label: string,
  termFile: string,
): string {
  return `rm -f ${termFile}; trap 'printf TERM > ${termFile}' TERM; printf 'READY:${label}:PAYLOAD=%s\\n' "$$"; while :; do sleep 2147483647 & wait $!; done`;
}

function normalCommand(label: string, emitLargeOutput = false): string {
  const fifo = `/tmp/bobbit-verify-${label}.fifo`;
  const postReadinessOutput = emitLargeOutput
    ? `head -c 9217 /dev/zero | tr '\\000' X; printf '\\n'; __i=1; while [ "$__i" -le 128 ]; do printf 'POST_READY_LINE:${label}:%s\\n' "$__i"; __i=$((__i + 1)); done; printf 'POST_READY_DRAINED:${label}\\n';`
    : "";
  // Keep the first post-readiness record deliberately newline-free and larger
  // than the stream decoder's 8 KiB authority-frame bound. Normal user output
  // must never be confused with a control frame or make terminal publication
  // outrun payload/transport cleanup.
  return `rm -f ${fifo}; mkfifo ${fifo}; printf 'READY:${label}:PAYLOAD=%s\\n' "$$"; IFS= read -r _ < ${fifo}; rm -f ${fifo}; ${postReadinessOutput}`;
}

/**
 * A same-UID verification payload is an active attacker, not merely a sibling.
 * On each host-provided target witness pathname it finds the target's nonce in
 * its live sentinel environment, pre-opens the former predictable readiness
 * FIFO, and writes B's exact tuple directly to A's private docker-exec FD.
 *
 * There is no retry loop: the control FIFO is the explicit test barrier and
 * each attack inspects /proc exactly once after the host observed A's transport
 * PID in durable state.
 */
function preReleaseTransportForgeryCommand(
  label: string,
  termFile: string,
  controlFifo: string,
): string {
  return `rm -f ${termFile} ${controlFifo}; mkfifo ${controlFifo}; trap 'printf TERM > ${termFile}' TERM; printf 'READY:${label}:PAYLOAD=%s\\n' "$$"; __bobbit_own_pgid=$(awk '{print $5}' "/proc/$$/stat" 2>/dev/null); __bobbit_own_witness=; for __bobbit_candidate in /tmp/.bobbit-verif/*/*.ownership.json; do test -f "$__bobbit_candidate" || continue; __bobbit_candidate_pgid=$(sed -n 's/.*"pgid":\\([0-9][0-9]*\\).*/\\1/p' "$__bobbit_candidate"); if test "$__bobbit_candidate_pgid" = "$__bobbit_own_pgid"; then __bobbit_own_witness=$__bobbit_candidate; break; fi; done; test -n "$__bobbit_own_witness" || { printf 'ADVERSARY_OWN_WITNESS_DISCOVERY_FAILED:${label}\\n' >&2; exit 97; }; while IFS= read -r __bobbit_target_witness < ${controlFifo}; do __bobbit_target_pid=; __bobbit_target_nonce=; for __bobbit_environ in /proc/[0-9]*/environ; do if tr '\\000' '\\n' < "$__bobbit_environ" 2>/dev/null | grep -Fqx "BOBBIT_WITNESS=$__bobbit_target_witness"; then __bobbit_target_pid=\${__bobbit_environ#/proc/}; __bobbit_target_pid=\${__bobbit_target_pid%/environ}; __bobbit_target_nonce=$(tr '\\000' '\\n' < "$__bobbit_environ" 2>/dev/null | sed -n 's/^BOBBIT_NONCE=//p'); break; fi; done; test -n "$__bobbit_target_pid" && test -n "$__bobbit_target_nonce" || { printf 'ADVERSARY_TARGET_TRANSPORT_DISCOVERY_FAILED:${label}\\n' >&2; exit 97; }; __bobbit_container=$(sed -n 's/.*"containerId":"\\([^"]*\\)".*/\\1/p' "$__bobbit_own_witness"); __bobbit_sentinel=$(sed -n 's/.*"sentinelPid":\\([0-9][0-9]*\\).*/\\1/p' "$__bobbit_own_witness"); __bobbit_pgid=$(sed -n 's/.*"pgid":\\([0-9][0-9]*\\).*/\\1/p' "$__bobbit_own_witness"); __bobbit_start=$(sed -n 's/.*"startToken":"\\([^"]*\\)".*/\\1/p' "$__bobbit_own_witness"); test -n "$__bobbit_container" && test -n "$__bobbit_sentinel" && test -n "$__bobbit_pgid" && test -n "$__bobbit_start" || { printf 'ADVERSARY_TUPLE_DISCOVERY_FAILED:${label}\\n' >&2; exit 97; }; __bobbit_legacy_ready="$__bobbit_target_witness.ready"; rm -f "$__bobbit_legacy_ready"; mkfifo "$__bobbit_legacy_ready" || exit 97; exec 9<> "$__bobbit_legacy_ready"; printf '.\\n' >&9; printf 'ADVERSARY_PRERELEASE_TRANSPORT_FORGERY:${label}\\n' > "/proc/$__bobbit_target_pid/fd/4"; printf 'BOBBIT_CONTAINER_OWNERSHIP_TUPLE {"containerId":"%s","nonce":"%s","sentinelPid":%s,"pgid":%s,"startToken":"%s"}\\n' "$__bobbit_container" "$__bobbit_target_nonce" "$__bobbit_sentinel" "$__bobbit_pgid" "$__bobbit_start" > "/proc/$__bobbit_target_pid/fd/4" || exit 97; done`;
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
    action === "fail" ? "exit 23" : `IFS= read -r _ < ${fifo}; rm -f ${fifo}`;
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
  expect(witness).toMatchObject({
    containerId: step.containerId,
    nonce: step.pidNonce,
  });
  expect(witness.sentinelPid).toBeGreaterThan(0);
  expect(witness.pgid).toBeGreaterThan(0);
  expect(witness.startToken).toBeTruthy();
  return {
    goalId,
    gateId,
    signalId,
    payloadPid,
    hostPid: step.pid,
    witnessFile: step.containerWitnessFile,
    witness,
  };
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
    const state = execFileSync(
      "docker",
      [
        "exec",
        containerId,
        "/bin/sh",
        "-c",
        `awk '{print $3}' /proc/${pid}/stat 2>/dev/null || true`,
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    ).trim();
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
  execFileSync(
    "docker",
    ["exec", containerId, "/bin/sh", "-c", `kill -0 ${pid}`],
    {
      stdio: "ignore",
      timeout: 10_000,
    },
  );
  expect(pid, `${label} PID`).toBeGreaterThan(0);
}

function startSameUidSibling(
  containerId: string,
  label: string,
): ContainerIdentity {
  const termFile = `/tmp/bobbit-verify-${label}.term`;
  const pid = Number(
    docker([
      "exec",
      containerId,
      "/bin/sh",
      "-c",
      `rm -f ${termFile}; setsid /bin/sh -c 'trap "printf TERM > ${termFile}" TERM; while :; do sleep 2147483647 & wait $!; done' >/dev/null 2>&1 & echo $!`,
    ]),
  );
  const identity = docker([
    "exec",
    containerId,
    "/bin/sh",
    "-c",
    `awk '{print $1, $5, $22}' /proc/${pid}/stat`,
  ]).split(/\s+/);
  expect(identity, `same-UID sibling ${label} identity`).toHaveLength(3);
  expect(Number(identity[0])).toBe(pid);
  const pgid = Number(identity[1]);
  expect(pgid).toBeGreaterThan(0);
  expect(identity[2]).toBeTruthy();
  return { pid, pgid, startToken: identity[2], termFile };
}

function assertNoContainerTermSignal(
  containerId: string,
  termFile: string,
  label: string,
): void {
  const observed = docker([
    "exec",
    containerId,
    "/bin/sh",
    "-c",
    `if test -e ${termFile}; then cat ${termFile}; else printf ABSENT; fi`,
  ]);
  expect(observed, `${label} must not receive a destructive TERM`).toBe(
    "ABSENT",
  );
}

async function readActiveStep(
  gateway: Gateway,
  goalId: string,
  signalId: string,
): Promise<any> {
  const response = await api(
    gateway,
    `/api/goals/${goalId}/verifications/active`,
  );
  await expectResponseStatus(response, 200);
  const active = (await response.json()).verifications.find(
    (entry: any) => entry.signalId === signalId,
  );
  expect(active, `active step ${signalId}`).toBeTruthy();
  return active.steps[0];
}

function readActiveVerification(
  statePath: string,
  signalId: string,
): any | undefined {
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
  let sibling: ContainerIdentity | undefined;
  const activePath = join(
    root,
    ".bobbit",
    "state",
    "active-verifications.json",
  );
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
    sibling = startSameUidSibling(containerId, `unrelated-sibling-${port}`);
    siblingPid = sibling.pid;
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
            run: witnessSubstitutionCommand("timeout", siblingPid),
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
    const timeoutActiveStep = await readActiveStep(
      gateway,
      timeoutGoal,
      timeoutStep.signalId,
    );
    expect(timeoutStep.witness).toMatchObject({
      containerId: timeoutActiveStep.containerId,
      nonce: timeoutActiveStep.pidNonce,
      sentinelPid: sibling!.pid,
      pgid: sibling!.pgid,
      startToken: sibling!.startToken,
    });
    const timeoutDone = await viewer.waitFrom(
      timeoutFrom,
      (event) =>
        event.type === "gate_verification_complete" &&
        event.signalId === timeoutStep.signalId,
      120_000,
    );
    expect(timeoutDone.status).toBe("failed");
    assertNoContainerTermSignal(
      containerId,
      sibling!.termFile,
      "substituted unrelated sibling after timeout",
    );
    assertContainerAlive(
      containerId,
      siblingPid,
      "unrelated sibling after timeout",
    );
    assertContainerGone(containerId, timeoutStep.payloadPid);
    assertHostGone(timeoutStep.hostPid);
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
        event.text.includes(
          `BOBBIT_CONTAINER_LAUNCHER_EXIT:${forgedFailure.witness.nonce}:0`,
        ),
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
        event.text.includes(
          `BOBBIT_CONTAINER_LAUNCHER_EXIT:${forgedHold.witness.nonce}:0`,
        ),
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

    const concurrentControlFifo = `/tmp/bobbit-verify-concurrent-control-${port}.fifo`;
    const concurrentTermFile = "/tmp/bobbit-verify-concurrent-b.term";
    const concurrentGoal = await createSandboxGoal(
      gateway,
      projectId,
      "concurrent",
      [
        {
          id: "b",
          name: "b",
          dependsOn: [],
          verify: [
            {
              name: "b",
              type: "command",
              run: preReleaseTransportForgeryCommand(
                "concurrent-b",
                concurrentTermFile,
                concurrentControlFifo,
              ),
              timeout: 60,
            },
          ],
        },
      ],
    );
    viewer = await connectViewer(gateway, concurrentGoal);
    const second = await startStep(
      viewer,
      gateway,
      concurrentGoal,
      "b",
      "concurrent-b",
      containerId,
    );

    // B is already a live same-UID verification step in this shared container.
    // A has not reached genuine readiness: B receives only A's durable witness
    // pathname, recovers A's nonce from /proc, poisons the former predictable
    // readiness FIFO, then writes B's tuple to A's docker-exec transport.
    const concurrentAttackGoal = await createSandboxGoal(
      gateway,
      projectId,
      "concurrent-pre-release-forgery",
      [
        {
          id: "a",
          name: "a",
          dependsOn: [],
          verify: [
            {
              name: "a",
              type: "command",
              run: blockingCommand("concurrent-pre-release-a"),
              timeout: 60,
            },
          ],
        },
      ],
    );
    viewer = await connectViewer(gateway, concurrentAttackGoal);
    const attackFrom = viewer.mark();
    const attackResponse = await api(
      gateway,
      `/api/goals/${concurrentAttackGoal}/gates/a/signal`,
      {
        method: "POST",
        body: JSON.stringify({
          content: "start pre-release transport forgery",
        }),
      },
    );
    await expectResponseStatus(attackResponse, 201);
    const attackSignalId = (await attackResponse.json()).signal.id as string;
    const preReleaseTarget = await waitForActiveVerification(
      activePath,
      attackSignalId,
      (entry) => {
        const step = entry?.steps?.[0];
        return !!step?.pid && typeof step.containerWitnessFile === "string";
      },
      "pre-release target did not publish its docker-exec transport identity",
    );
    const targetWitnessFile = preReleaseTarget!.steps[0]
      .containerWitnessFile as string;
    // This is A's own, pre-release inner sentinel tuple.  It is captured before
    // B receives A's transport pathname, so either secure schedule below has a
    // stable expected identity: B's same-UID tuple can never become authority.
    const targetInnerWitness = JSON.parse(
      docker(["exec", containerId, "cat", targetWitnessFile]),
    ) as RunningStep["witness"];
    expect(targetInnerWitness).toMatchObject({
      containerId: preReleaseTarget!.steps[0].containerId,
      nonce: preReleaseTarget!.steps[0].pidNonce,
    });
    expect(targetInnerWitness).not.toMatchObject({
      sentinelPid: second.witness.sentinelPid,
      startToken: second.witness.startToken,
    });
    // This FIFO write is a one-shot release of B's attack, not a readiness poll.
    docker([
      "exec",
      containerId,
      "/bin/sh",
      "-c",
      `printf '%s\\n' ${targetWitnessFile} > ${concurrentControlFifo}`,
    ]);
    const preReleaseOutcome = await waitForActiveVerification(
      activePath,
      attackSignalId,
      (entry) => {
        const step = entry?.steps?.[0];
        return (
          step?.containerPayloadCleanupPending === true ||
          step?.containerOwnershipWitness !== undefined
        );
      },
      "target did not settle either its forged or genuine pre-release ownership boundary",
    );
    const preReleaseStep = preReleaseOutcome!.steps[0];
    const failedClosedBeforeRelease =
      preReleaseStep.containerPayloadCleanupPending === true &&
      preReleaseStep.containerOwnershipWitness === undefined;
    const daemonBoundBeforeForgery = preReleaseStep.containerOwnershipWitness !== undefined;
    expect(
      failedClosedBeforeRelease || daemonBoundBeforeForgery,
      "the forged tuple must either fail closed before host release or lose to A's daemon-bound tuple",
    ).toBe(true);
    expect(
      docker([
        "exec",
        containerId,
        "/bin/sh",
        "-c",
        `test -p ${targetWitnessFile}.ready`,
      ]),
      "the concurrent payload must have pre-opened and written the old filesystem readiness path",
    ).toBe("");

    const readyBeforeOutcome = viewer.messages
      .slice(attackFrom)
      .some(
        (event) =>
          event.type === "gate_verification_step_output" &&
          event.signalId === attackSignalId &&
          typeof event.text === "string" &&
          event.text.includes("READY:concurrent-pre-release-a:"),
      );
    let daemonBoundPayloadPid: number | undefined;
    if (failedClosedBeforeRelease) {
      expect(
        readyBeforeOutcome,
        "a forged readiness path and transport tuple must not release A's payload",
      ).toBe(false);
      expect(
        preReleaseStep.containerOwnershipWitness,
        "untrusted container output must never become the durable authority",
      ).toBeUndefined();
    } else {
      // The scheduler may observe A's Engine-tagged exec first.  A late forged
      // B tuple is then payload output only: the durable authority remains A's
      // exact daemon-bound inner sentinel and host release is legitimate.
      expect(preReleaseStep.containerPayloadCleanupPending).not.toBe(true);
      expect(preReleaseStep.containerOwnershipWitness).toEqual(targetInnerWitness);
      expect(preReleaseStep.containerOwnershipWitness).not.toMatchObject({
        sentinelPid: second.witness.sentinelPid,
        startToken: second.witness.startToken,
      });
      // A can run only after the durable A tuple above; the old FIFO write alone
      // is never a release authority.
      if (readyBeforeOutcome) {
        expect(preReleaseStep.containerOwnershipWitness).toEqual(targetInnerWitness);
      }
      const readyA = await viewer.waitFrom(
        attackFrom,
        (event) =>
          event.type === "gate_verification_step_output" &&
          event.signalId === attackSignalId &&
          typeof event.text === "string" &&
          event.text.includes("READY:concurrent-pre-release-a:"),
      );
      daemonBoundPayloadPid = Number(/PAYLOAD=(\d+)/.exec(readyA.text)?.[1]);
      expect(daemonBoundPayloadPid, "daemon-bound A must be the only payload released").toBeGreaterThan(0);
    }

    const cancelA = await api(
      gateway,
      `/api/goals/${concurrentAttackGoal}/gates/a/cancel-verification`,
      { method: "POST" },
    );
    await expectResponseStatus(cancelA, 200);
    if (daemonBoundBeforeForgery) {
      // The cancellation route acknowledges only after exact payload cleanup and
      // exact host docker-exec transport cleanup, in that order.
      assertContainerGone(containerId, daemonBoundPayloadPid!);
    }
    assertHostGone(preReleaseTarget!.steps[0].pid);
    assertNoContainerTermSignal(
      containerId,
      concurrentTermFile,
      "forging concurrent step B after cancelling target A",
    );
    assertContainerAlive(
      containerId,
      second.payloadPid,
      "concurrent step B after cancelling target A",
    );
    assertHostAlive(second.hostPid);
    assertContainerAlive(
      containerId,
      siblingPid,
      "unrelated sibling after pre-release concurrent cancellation",
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
            run: witnessSubstitutionCommand(
              "restart",
              siblingPid,
              `/tmp/bobbit-verify-restart-host-pin-${port}.fifo`,
            ),
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
    // The payload cannot replace the file until the host has durably pinned the
    // original spawn-time tuple. Recovery must use this host-owned authority,
    // not re-read the container-visible file below.
    const hostPinnedRestartStep = await readActiveStep(
      gateway,
      restartGoal,
      restartStep.signalId,
    );
    expect(
      hostPinnedRestartStep.containerOwnershipWitness,
      "host must persist the original container witness before payload code proceeds",
    ).toMatchObject(restartStep.witness);
    const restartAttackFrom = viewer.mark();
    docker([
      "exec",
      containerId,
      "/bin/sh",
      "-c",
      `printf x > /tmp/bobbit-verify-restart-host-pin-${port}.fifo`,
    ]);
    await viewer.waitFrom(
      restartAttackFrom,
      (event) =>
        event.type === "gate_verification_step_output" &&
        event.signalId === restartStep.signalId &&
        typeof event.text === "string" &&
        event.text.includes("WITNESS_SUBSTITUTED:restart:"),
    );
    const replacedRestartWitness = JSON.parse(
      docker(["exec", containerId, "cat", restartStep.witnessFile]),
    );
    expect(replacedRestartWitness).toMatchObject({
      containerId: restartStep.witness.containerId,
      nonce: restartStep.witness.nonce,
      sentinelPid: sibling!.pid,
      pgid: sibling!.pgid,
      startToken: sibling!.startToken,
    });
    const recovered = waitForActiveRemoval(activePath, restartStep.signalId);
    viewer.close();
    viewer = undefined;
    await crashGateway(gateway);
    gateway = await startGateway(root, port);
    await recovered;
    assertContainerGone(containerId, restartStep.payloadPid);
    assertHostGone(restartStep.hostPid);
    assertNoContainerTermSignal(
      containerId,
      sibling!.termFile,
      "substituted unrelated sibling after restart recovery",
    );
    assertContainerAlive(
      containerId,
      siblingPid,
      "unrelated sibling after restart recovery",
    );
    // Recovery closes its viewer before the gateway crash; keep this transition
    // idempotent so restart cleanup cannot dereference the already-cleared viewer.
    viewer?.close();
    viewer = undefined;

    const largeOutputGoal = await createSandboxGoal(
      gateway,
      projectId,
      "large-post-readiness-output",
      [
        {
          id: "large-post-readiness-output",
          name: "large-post-readiness-output",
          dependsOn: [],
          verify: [
            {
              name: "large-post-readiness-output",
              type: "command",
              run: normalCommand("large-post-readiness-output", true),
              timeout: 30,
            },
          ],
        },
      ],
    );
    viewer = await connectViewer(gateway, largeOutputGoal);
    const largeOutputFrom = viewer.mark();
    const largeOutputStep = await startStep(
      viewer,
      gateway,
      largeOutputGoal,
      "large-post-readiness-output",
      "large-post-readiness-output",
      containerId,
    );
    docker([
      "exec",
      containerId,
      "/bin/sh",
      "-c",
      "printf x > /tmp/bobbit-verify-large-post-readiness-output.fifo",
    ]);
    const largeOutputDone = await viewer.waitFrom(
      largeOutputFrom,
      (event) =>
        event.type === "gate_verification_complete" &&
        event.signalId === largeOutputStep.signalId,
    );
    expect(largeOutputDone.status).toBe("passed");
    const largeOutput = viewer.messages
      .slice(largeOutputFrom)
      .filter(
        (event) =>
          event.type === "gate_verification_step_output" &&
          event.signalId === largeOutputStep.signalId &&
          typeof event.text === "string",
      )
      .map((event) => event.text)
      .join("");
    expect(largeOutput).toContain("X".repeat(8_193));
    expect(
      largeOutput.match(/POST_READY_LINE:large-post-readiness-output:/g),
    ).toHaveLength(128);
    expect(largeOutput).toContain(
      "POST_READY_DRAINED:large-post-readiness-output",
    );
    // Completion publication is after the exact payload group and its host
    // docker-exec transport have both been reaped, despite the large stream.
    assertContainerGone(containerId, largeOutputStep.payloadPid);
    assertHostGone(largeOutputStep.hostPid);
    viewer.close();
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
    const witnessFailureSignalId = (await witnessFailureResponse.json()).signal
      .id as string;
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
      viewer.messages
        .slice(witnessFailureFrom)
        .some(
          (event) =>
            event.type === "gate_verification_step_output" &&
            event.signalId === witnessFailureSignalId &&
            typeof event.text === "string" &&
            event.text.includes("PAYLOAD_STARTED:witness-publication-failure"),
        ),
      "user payload must not start before atomic witness publication",
    ).toBe(false);
    expect(
      viewer.messages
        .slice(witnessFailureFrom)
        .some(
          (event) =>
            event.type === "gate_verification_complete" &&
            event.signalId === witnessFailureSignalId,
        ),
      "no terminal gate publication is permitted while exact payload cleanup proof is absent",
    ).toBe(false);
    expect(
      failedStep.sentinelFile,
      "host transport needs its own exact sentinel witness",
    ).toBeTruthy();
    const hostWitness = JSON.parse(
      readFileSync(failedStep.sentinelFile, "utf8"),
    );
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
