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
import { manualTmpRoot } from "../manual-integration/manual-test-paths.js";
import { seedManualTestModelPreferences } from "../manual-integration/manual-test-model-seeding.js";

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

interface ContainerIdentity {
  pid: number;
  pgid: number;
  startToken: string;
  termFile: string;
}

interface ContainerFixture {
  gateway: Gateway;
  root: string;
  projectId: string;
  containerId: string;
  bootstrapGoal: string;
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

interface CommandGoal {
  title: string;
  gateId: string;
  run: string;
  timeout?: number;
  expectFailure?: boolean;
}

async function createSandboxGoal(
  gateway: Gateway,
  projectId: string,
  title: string,
  gates: unknown[],
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

/** Create the one-command workflow used by every ownership journey. */
function createCommandGoal(
  gateway: Gateway,
  projectId: string,
  { title, gateId, run, timeout = 30, expectFailure = false }: CommandGoal,
): Promise<string> {
  return createSandboxGoal(gateway, projectId, title, [
    {
      id: gateId,
      name: gateId,
      dependsOn: [],
      verify: [
        {
          name: gateId,
          type: "command",
          run,
          ...(expectFailure ? { expect: "failure" } : {}),
          timeout,
        },
      ],
    },
  ]);
}

function blockingCommand(label: string): string {
  return `printf 'READY:${label}:PAYLOAD=%s\\n' "$$"; exec tail -f /dev/null`;
}

/** Keep a payload live until the timeout cleanup path runs. */
function timeoutBlockingCommand(label: string): string {
  return `printf 'READY:${label}:PAYLOAD=%s\\n' "$$"; exec tail -f /dev/null`;
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
 * A same-UID verification payload uses /proc to inject B's full tuple directly
 * into A's docker-exec stdout transport. The control FIFO is an explicit test
 * barrier only; no container-owned state file participates in the attack.
 */
function preReleaseTransportForgeryCommand(
  label: string,
  termFile: string,
  controlFifo: string,
): string {
  return `rm -f ${termFile} ${controlFifo}; mkfifo ${controlFifo}; trap 'printf TERM > ${termFile}' TERM; printf 'READY:${label}:PAYLOAD=%s\\n' "$$"; IFS=' ' read -r __bobbit_target_nonce __bobbit_target_container __bobbit_sentinel __bobbit_pgid __bobbit_start < ${controlFifo}; test -n "$__bobbit_target_nonce" && test -n "$__bobbit_target_container" && test -n "$__bobbit_sentinel" && test -n "$__bobbit_pgid" && test -n "$__bobbit_start" || exit 97; __bobbit_target=; for __bobbit_cmdline in /proc/[0-9]*/cmdline; do if tr '\\000' '\\n' < "$__bobbit_cmdline" 2>/dev/null | grep -Fq "$__bobbit_target_nonce"; then __bobbit_target=\${__bobbit_cmdline#/proc/}; __bobbit_target=\${__bobbit_target%/cmdline}; break; fi; done; test -n "$__bobbit_target" && test -w "/proc/$__bobbit_target/fd/1" || { printf 'ADVERSARY_TARGET_TRANSPORT_DISCOVERY_FAILED:${label}\\n' >&2; exit 97; }; printf 'ADVERSARY_PRERELEASE_TRANSPORT_FORGERY:${label}\\n' >&2; printf 'BOBBIT_CONTAINER_OWNERSHIP_TUPLE {"containerId":"%s","nonce":"%s","sentinelPid":%s,"pgid":%s,"startToken":"%s"}\\n' "$__bobbit_target_container" "$__bobbit_target_nonce" "$__bobbit_sentinel" "$__bobbit_pgid" "$__bobbit_start" > "/proc/$__bobbit_target/fd/1" || exit 97; exec tail -f /dev/null`;
}

function forgedWrapperFdCompletionCommand(
  label: string,
  action: "fail" | "hold",
): string {
  const fifo = `/tmp/bobbit-verify-${label}.fifo`;
  const afterForgery =
    action === "fail" ? "exit 23" : `IFS= read -r _ < ${fifo}; rm -f ${fifo}`;
  const prepareHold =
    action === "hold" ? `rm -f ${fifo}; mkfifo ${fifo}; ` : "";
  return `__bobbit_parent=$PPID; ${prepareHold}printf 'READY:${label}:PAYLOAD=%s\\n' "$$"; printf 'ADVERSARY_DIRECT_WRAPPER_FD_FORGERY:${label}\\n' >&2; printf 'BOBBIT_CONTAINER_LAUNCHER_EXIT:untrusted:0\\n' > "/proc/$__bobbit_parent/fd/1"; ${afterForgery}`;
}

/**
 * This is the real inner-supervisor protocol, not a marker-shaped user line.
 * The payload reaches the persisted in-group sentinel through /proc and writes
 * a syntactically valid `BOBBIT_INNER_EXIT 0` before it either blocks or exits
 * 23. The host must never make this descriptor a completion authority.
 */
function forgedInnerSentinelExitCommand(
  label: string,
  action: "hold" | "exit-23",
): string {
  const fifo = `/tmp/bobbit-verify-${label}.fifo`;
  const afterForgery =
    action === "hold"
      ? `IFS= read -r _ < ${fifo}; rm -f ${fifo}; printf 'HONEST_RELEASE:${label}\\n'`
      : `printf 'HONEST_EXIT_23:${label}\\n' >&2; exit 23`;
  const prepareHold =
    action === "hold" ? `rm -f ${fifo}; mkfifo ${fifo}; ` : "";
  return `${prepareHold}__bobbit_sentinel=$PPID; test -r "/proc/$__bobbit_sentinel/fd/1" || { printf 'ADVERSARY_SENTINEL_FD_UNAVAILABLE:${label}\\n' >&2; exit 97; }; printf 'READY:${label}:PAYLOAD=%s\\n' "$$"; printf 'ADVERSARY_VALID_INNER_EXIT_FORGERY:${label}:SENTINEL=%s\\n' "$__bobbit_sentinel" >&2; printf 'BOBBIT_INNER_EXIT 0\\n' > "/proc/$__bobbit_sentinel/fd/1"; ${afterForgery}`;
}

function honestExitCommand(label: string, code: number): string {
  return `printf 'READY:${label}:PAYLOAD=%s\\n' "$$"; printf 'HONEST_EXIT_${code}:${label}\\n' >&2; exit ${code}`;
}

/** B's command has hostile `docker top`-looking CR/LF rows and copied A identity. */
function structuredTopAbuseCommand(
  label: string,
  termFile: string,
  controlFifo: string,
  copiedTag: string,
  copiedNonce: string,
): string {
  const syntheticRows = `\r\n77771 1 77771 bobbit-container-sentinel:${copiedTag}:77771:77771:77771\r\n77772 77771 77771 nonce=${copiedNonce}`;
  return `: '${syntheticRows}'; ${preReleaseTransportForgeryCommand(label, termFile, controlFifo)}`;
}

/**
 * A concurrent payload copies A's daemon tag only after killing A's genuine
 * tagged sentinel. It keeps A's private transport pipe open, then injects the
 * exact tuple of a non-descendant replacement running in B's process group.
 */
function copiedTagReplacementCommand(
  label: string,
  controlFifo: string,
  replacementFile: string,
  termFile: string,
): string {
  // The host supplies the already-attested tag only to drive this adversarial
  // fixture. B's child has a byte-for-byte copied marker but remains in B's
  // process group, so cancelling A must never name it.
  return `rm -f ${controlFifo} ${replacementFile} ${termFile}; mkfifo ${controlFifo}; trap 'printf TERM > ${termFile}' TERM; printf 'READY:${label}:PAYLOAD=%s\n' "$$"; IFS= read -r __bobbit_tag < ${controlFifo}; test -n "$__bobbit_tag" || exit 97; /bin/sh -c '__tag=$1; __p=$$; __g=$(awk "{print \$5}" "/proc/$__p/stat"); __s=$(awk "{print \$22}" "/proc/$__p/stat"); exec /bin/sh -c "trap \"\" TERM; exec tail -f /dev/null" "bobbit-container-sentinel:$__tag:$__p:$__g:$__s"' copied-tag-bootstrap "$__bobbit_tag" & __bobbit_replacement=$!; set -- $(awk '{print $1, $5, $22}' "/proc/$__bobbit_replacement/stat"); test "$1" = "$__bobbit_replacement" && test "$2" = "$(awk '{print $5}' /proc/$$/stat)" && test -n "$3" || exit 97; printf '{"pid":%s,"pgid":%s,"startToken":"%s"}\n' "$1" "$2" "$3" > ${replacementFile}; printf 'COPIED_TAG_REPLACEMENT_READY:${label}:PID=%s:PGID=%s\n' "$1" "$2"; exec tail -f /dev/null`;
}

async function startStep(
  viewer: Viewer,
  gateway: Gateway,
  goalId: string,
  gateId: string,
  label: string,
  containerId: string,
  metadata?: Record<string, string>,
): Promise<RunningStep> {
  const from = viewer.mark();
  const response = await api(
    gateway,
    `/api/goals/${goalId}/gates/${gateId}/signal`,
    {
      method: "POST",
      body: JSON.stringify({
        content: `start ${label}`,
        ...(metadata ? { metadata } : {}),
      }),
    },
  );
  await expectResponseStatus(response, 201);
  const signalId = (await response.json()).signal.id as string;
  const ready = await viewer.waitFrom(
    from,
    outputEvent(signalId, `READY:${label}:`),
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
  // The host persists the exact witness and daemon ancestry attestation before
  // releasing the payload; no container-visible witness file is authority.
  expect(step.containerId).toMatch(/^[a-f0-9]{64}$/i);
  const witness = step.containerOwnershipWitness;
  expect(witness).toMatchObject({
    containerId: step.containerId,
    nonce: step.pidNonce,
  });
  expect(witness.sentinelPid).toBeGreaterThan(0);
  expect(witness.pgid).toBeGreaterThan(0);
  expect(witness.startToken).toBeTruthy();
  expect(step.containerOwnershipAttestation).toMatchObject({
    containerId: step.containerId,
    nonce: step.pidNonce,
    sentinelPid: witness.sentinelPid,
    pgid: witness.pgid,
    startToken: witness.startToken,
  });
  return { goalId, gateId, signalId, payloadPid, hostPid: step.pid, witness };
}

function outputEvent(signalId: string, text: string): (event: any) => boolean {
  return (event) =>
    event.type === "gate_verification_step_output" &&
    event.signalId === signalId &&
    typeof event.text === "string" &&
    event.text.includes(text);
}

function completionEvent(signalId: string): (event: any) => boolean {
  return (event) =>
    event.type === "gate_verification_complete" && event.signalId === signalId;
}

function stepCompletionEvent(signalId: string): (event: any) => boolean {
  return (event) =>
    event.type === "gate_verification_step_complete" &&
    event.signalId === signalId;
}

async function cancelStep(step: RunningStep, gateway: Gateway): Promise<void> {
  await expectResponseStatus(
    await api(
      gateway,
      `/api/goals/${step.goalId}/gates/${step.gateId}/cancel-verification`,
      { method: "POST" },
    ),
    200,
  );
}

function releaseFifo(containerId: string, label: string): void {
  docker([
    "exec",
    containerId,
    "/bin/sh",
    "-c",
    `printf x > /tmp/bobbit-verify-${label}.fifo`,
  ]);
}

function assertStepCleaned(containerId: string, step: RunningStep): void {
  assertContainerGone(containerId, step.payloadPid);
  assertContainerGone(containerId, step.witness.sentinelPid);
  assertContainerGroupGone(containerId, step.witness.pgid);
  assertHostGone(step.hostPid);
}

function assertContainerGroupGone(containerId: string, pgid: number): void {
  const members = docker([
    "exec",
    containerId,
    "/bin/sh",
    "-c",
    `for f in /proc/[0-9]*/stat; do awk -v g=${pgid} '$5 == g && $3 != "Z" { print $1 }' "$f" 2>/dev/null; done`,
  ])
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
  expect(members, `container process group ${pgid} must be gone`).toEqual([]);
}

function containerProcessCount(containerId: string): number {
  return docker(["top", containerId, "-eo", "pid"])
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => /^\s*\d+\s*$/.test(line)).length;
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

/** Prove the persisted tuple is descended from its own daemon Exec PID. */
function assertDaemonExecOwnsWitness(
  containerId: string,
  step: any,
  label: string,
): void {
  const witness = step.containerOwnershipWitness as RunningStep["witness"];
  const attestation = step.containerOwnershipAttestation;
  expect(
    attestation?.execId,
    `${label} must persist its daemon Exec identity`,
  ).toBeTruthy();
  expect(
    attestation?.tag,
    `${label} must persist its daemon Exec tag`,
  ).toBeTruthy();
  expect(witness, `${label} must persist its own exact witness`).toBeTruthy();
  expect(witness.sentinelPid, `${label} sentinel PID`).toBeGreaterThan(0);
  // Docker CLI cannot inspect exec objects reliably across Engine versions. The
  // persisted ExecInspect PID and a single daemon `docker top` snapshot are the
  // authority: its PIDs live in the daemon namespace, unlike the frame tuple.
  const rows = docker(["top", containerId, "-eo", "pid,ppid,pgid,args"])
    .split(/\r?\n/)
    .slice(1)
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line))
    .filter((row): row is RegExpExecArray => !!row)
    .map((row) => ({
      pid: Number(row[1]),
      ppid: Number(row[2]),
      args: row[4],
    }));
  const marker = `bobbit-container-sentinel:${attestation.tag}:${witness.sentinelPid}:${witness.pgid}:${witness.startToken}`;
  const sentinels = rows.filter((row) => row.args.includes(marker));
  expect(sentinels, `${label} has one immutable sentinel argv`).toHaveLength(1);
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  let cursor = sentinels[0];
  const seen = new Set<number>();
  while (cursor.pid !== attestation.enginePid && !seen.has(cursor.pid)) {
    seen.add(cursor.pid);
    const parent = byPid.get(cursor.ppid);
    expect(
      parent,
      `${label} sentinel parent chain remains in the daemon snapshot`,
    ).toBeTruthy();
    cursor = parent!;
  }
  expect(
    cursor.pid,
    `${label} sentinel parent chain ends at its ExecInspect PID`,
  ).toBe(attestation.enginePid);
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

async function waitForHostResultBeforePayloadCleanup(
  statePath: string,
  signalId: string,
): Promise<any> {
  return waitForActiveVerification(
    statePath,
    signalId,
    (entry) => {
      const step = entry?.steps?.[0];
      if (
        !step?.containerCompletionFile ||
        !step?.containerCompletionNonce ||
        step.containerPayloadCleanupCompletedAt ||
        !step.containerPayloadCleanupPending
      )
        return false;
      try {
        const result = JSON.parse(
          readFileSync(step.containerCompletionFile, "utf8"),
        );
        return (
          result.nonce === step.containerCompletionNonce &&
          Number.isSafeInteger(result.exitCode)
        );
      } catch {
        return false;
      }
    },
    `host docker-exec result did not precede payload cleanup for ${signalId}`,
  );
}

function waitForRecoveredRemovalAfterPayloadCleanup(
  statePath: string,
  signalId: string,
): Promise<void> {
  return new Promise((resolveRecovered, rejectRecovered) => {
    let observedCleanup = false;
    let watcher: ReturnType<typeof watch> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      watcher?.close();
      if (timer) clearTimeout(timer);
      if (error) rejectRecovered(error);
      else resolveRecovered();
    };
    const observe = () => {
      try {
        const entry = readActiveVerification(statePath, signalId);
        if (entry?.steps?.[0]?.containerPayloadCleanupCompletedAt)
          observedCleanup = true;
        if (!entry) {
          finish(
            observedCleanup
              ? undefined
              : new Error(
                  `recovered terminal removal preceded exact payload cleanup for ${signalId}`,
                ),
          );
        }
      } catch (error) {
        finish(error as Error);
      }
    };
    watcher = watch(resolve(statePath, ".."), (_event, file) => {
      if (file === "active-verifications.json") observe();
    });
    timer = setTimeout(
      () =>
        finish(
          new Error(
            `recovery did not terminally settle ${signalId} after cleanup`,
          ),
        ),
      120_000,
    );
    observe();
  });
}

async function createContainerFixture(
  label: string,
): Promise<ContainerFixture> {
  const port = await freePort();
  const root = join(
    manualTmpRoot(),
    `.bobbit-container-ownership-${label}-${port}`,
  );
  rmSync(root, { recursive: true, force: true });
  initRepo(root);
  const gateway = await startGateway(root, port);
  const projectResponse = await api(gateway, "/api/projects", {
    method: "POST",
    body: JSON.stringify({
      name: `container-ownership-${label}-${port}`,
      rootPath: root,
      acceptCanonical: true,
    }),
  });
  await expectResponseStatus(projectResponse, 201);
  const projectId = (await projectResponse.json()).id as string;
  const configResponse = await api(
    gateway,
    `/api/projects/${projectId}/config`,
    {
      method: "PUT",
      body: JSON.stringify({ sandbox: "docker" }),
    },
  );
  await expectResponseStatus(configResponse, 200);
  const bootstrapGoal = await createCommandGoal(gateway, projectId, {
    title: `bootstrap-${label}`,
    gateId: "bootstrap",
    run: normalCommand(`bootstrap-${label}`),
  });
  const containerId = docker([
    "ps",
    "-q",
    "--filter",
    `label=bobbit-project=${projectId}`,
  ]);
  expect(containerId, "fixture sandbox container").toBeTruthy();
  return { gateway, root, projectId, containerId, bootstrapGoal };
}

async function disposeFixture(
  fixture: ContainerFixture | undefined,
  gateway: Gateway | undefined = fixture?.gateway,
): Promise<void> {
  if (!fixture) return;
  await stopGateway(gateway);
  cleanupDockerProject(fixture.projectId);
  rmSync(fixture.root, { recursive: true, force: true });
}

function killContainerProcess(
  fixture: ContainerFixture | undefined,
  pid: number | undefined,
): void {
  try {
    if (fixture && pid)
      docker(["exec", fixture.containerId, "kill", "-KILL", String(pid)]);
  } catch {
    /* teardown best effort */
  }
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

  let fixture: ContainerFixture | undefined;
  let gateway: Gateway | undefined;
  let viewer: Viewer | undefined;
  let siblingPid = 0;
  let sibling: ContainerIdentity | undefined;
  try {
    fixture = await createContainerFixture("lifecycle");
    gateway = fixture.gateway;
    const { root, projectId, containerId, bootstrapGoal } = fixture;
    const { port } = gateway;
    const activePath = join(
      root,
      ".bobbit",
      "state",
      "active-verifications.json",
    );
    viewer = await connectViewer(gateway, bootstrapGoal);
    const normalFrom = viewer.mark();
    const bootstrap = await startStep(
      viewer,
      gateway,
      bootstrapGoal,
      "bootstrap",
      "bootstrap-lifecycle",
      containerId,
    );
    // Release only after durable witness and host transport observation.
    releaseFifo(containerId, "bootstrap-lifecycle");
    // A normal exit is the first lifecycle contract: completion follows payload
    // and transport cleanup, not just the command leader's exit.
    const normalDone = await viewer.waitFrom(
      normalFrom,
      completionEvent(bootstrap.signalId),
    );
    expect(normalDone.status).toBe("passed");
    assertStepCleaned(containerId, bootstrap);
    viewer.close();
    viewer = undefined;
    sibling = startSameUidSibling(containerId, `unrelated-sibling-${port}`);
    siblingPid = sibling.pid;
    assertContainerAlive(containerId, siblingPid, "unrelated sibling");

    const timeoutGoal = await createCommandGoal(gateway, projectId, {
      title: "timeout",
      gateId: "timeout",
      run: timeoutBlockingCommand("timeout"),
      timeout: 1,
    });
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
    expect(timeoutActiveStep.containerOwnershipAttestation).toMatchObject({
      version: 1,
      containerId: timeoutStep.witness.containerId,
      nonce: timeoutStep.witness.nonce,
      sentinelPid: timeoutStep.witness.sentinelPid,
      pgid: timeoutStep.witness.pgid,
      startToken: timeoutStep.witness.startToken,
    });
    expect(timeoutStep.witness.sentinelPid).not.toBe(sibling!.pid);
    const timeoutDone = await viewer.waitFrom(
      timeoutFrom,
      completionEvent(timeoutStep.signalId),
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
    assertStepCleaned(containerId, timeoutStep);
    viewer.close();
    viewer = undefined;

    const forgedFailureGoal = await createCommandGoal(gateway, projectId, {
      title: "forged-nonzero",
      gateId: "forged-nonzero",
      run: forgedWrapperFdCompletionCommand("forged-nonzero", "fail"),
      timeout: 30,
    });
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
      outputEvent(
        forgedFailure.signalId,
        "BOBBIT_CONTAINER_LAUNCHER_EXIT:untrusted:0",
      ),
    );
    expect(
      forgedFailureControlLine.text,
      "the adversary must reach the wrapper FD rather than the payload FIFO",
    ).not.toContain("[payload]");
    const forgedFailureDone = await viewer.waitFrom(
      forgedFailureFrom,
      completionEvent(forgedFailure.signalId),
    );
    expect(
      forgedFailureDone.status,
      "payload-controlled completion-shaped output must not turn exit 23 into a pass",
    ).toBe("failed");
    assertStepCleaned(containerId, forgedFailure);
    assertContainerAlive(
      containerId,
      siblingPid,
      "unrelated sibling after forged nonzero completion",
    );
    viewer.close();
    viewer = undefined;

    const forgedHoldGoal = await createCommandGoal(gateway, projectId, {
      title: "forged-hold",
      gateId: "forged-hold",
      run: forgedWrapperFdCompletionCommand("forged-hold", "hold"),
      timeout: 30,
    });
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
      outputEvent(
        forgedHold.signalId,
        "BOBBIT_CONTAINER_LAUNCHER_EXIT:untrusted:0",
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
        .some(completionEvent(forgedHold.signalId)),
      "forged output cannot emit completion before the payload exits",
    ).toBe(false);
    assertContainerAlive(
      containerId,
      forgedHold.payloadPid,
      "payload after forged completion-shaped output",
    );
    assertHostAlive(forgedHold.hostPid);
    releaseFifo(containerId, "forged-hold");
    const forgedHoldDone = await viewer.waitFrom(
      forgedHoldFrom,
      completionEvent(forgedHold.signalId),
    );
    expect(forgedHoldDone.status).toBe("passed");
    assertStepCleaned(containerId, forgedHold);
    assertContainerAlive(
      containerId,
      siblingPid,
      "unrelated sibling after forged held completion",
    );
    viewer.close();
    viewer = undefined;

    const concurrentControlFifo = `/tmp/bobbit-verify-concurrent-control-${port}.fifo`;
    const concurrentTermFile = "/tmp/bobbit-verify-concurrent-b.term";
    const concurrentGoal = await createCommandGoal(gateway, projectId, {
      title: "concurrent",
      gateId: "b",
      run: preReleaseTransportForgeryCommand(
        "concurrent-b",
        concurrentTermFile,
        concurrentControlFifo,
      ),
      timeout: 60,
    });
    viewer = await connectViewer(gateway, concurrentGoal);
    const second = await startStep(
      viewer,
      gateway,
      concurrentGoal,
      "b",
      "concurrent-b",
      containerId,
    );

    // B is a live same-UID attacker in the shared container. Once A's host
    // record exposes its transport identity, B finds A's wrapper through /proc
    // and injects B's complete tuple straight into A's stdout transport. No
    // mutable container file or readiness FIFO participates in this attack.
    const concurrentAttackGoal = await createCommandGoal(gateway, projectId, {
      title: "concurrent-pre-release-forgery",
      gateId: "a",
      run: blockingCommand("concurrent-pre-release-a"),
      timeout: 60,
    });
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
        return !!step?.pid && !!step?.containerId && !!step?.pidNonce;
      },
      "pre-release target did not publish its docker-exec transport identity",
    );
    const targetIdentity = {
      containerId: preReleaseTarget!.steps[0].containerId as string,
      nonce: preReleaseTarget!.steps[0].pidNonce as string,
    };
    expect(targetIdentity.containerId).toMatch(new RegExp(`^${containerId}`));
    expect(targetIdentity.nonce).toEqual(expect.any(String));
    expect(targetIdentity.nonce).not.toBe(second.witness.nonce);
    // This is a one-shot attack release. The attacker can observe its target's
    // wrapper arguments through /proc; the explicit values make that
    // deterministic without reviving a container-owned state file.
    docker([
      "exec",
      containerId,
      "/bin/sh",
      "-c",
      `printf '%s %s %s %s %s\n' ${targetIdentity.nonce} ${targetIdentity.containerId} ${second.witness.sentinelPid} ${second.witness.pgid} ${second.witness.startToken} > ${concurrentControlFifo}`,
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
    const daemonBoundBeforeForgery =
      preReleaseStep.containerOwnershipWitness !== undefined;
    expect(
      failedClosedBeforeRelease || daemonBoundBeforeForgery,
      "the forged tuple must either fail closed before host release or lose to A's daemon-bound tuple",
    ).toBe(true);
    const readyBeforeOutcome = viewer.messages
      .slice(attackFrom)
      .some(outputEvent(attackSignalId, "READY:concurrent-pre-release-a:"));
    let daemonBoundPayloadPid: number | undefined;
    if (failedClosedBeforeRelease) {
      expect(
        readyBeforeOutcome,
        "a forged transport tuple must not release A's payload",
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
      expect(preReleaseStep.containerOwnershipWitness).toMatchObject(
        targetIdentity,
      );
      expect(preReleaseStep.containerOwnershipWitness).not.toMatchObject({
        sentinelPid: second.witness.sentinelPid,
        startToken: second.witness.startToken,
      });
      // A can run only after its own durable daemon-bound tuple; B's direct
      // transport frame is never a release authority.
      if (readyBeforeOutcome) {
        expect(preReleaseStep.containerOwnershipWitness).toMatchObject(
          targetIdentity,
        );
      }
      const readyA = await viewer.waitFrom(
        attackFrom,
        outputEvent(attackSignalId, "READY:concurrent-pre-release-a:"),
      );
      daemonBoundPayloadPid = Number(/PAYLOAD=(\d+)/.exec(readyA.text)?.[1]);
      expect(
        daemonBoundPayloadPid,
        "daemon-bound A must be the only payload released",
      ).toBeGreaterThan(0);
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
    await cancelStep(second, gateway);
    assertStepCleaned(containerId, second);
    viewer.close();
    viewer = undefined;

    const restartGoal = await createCommandGoal(gateway, projectId, {
      title: "restart",
      gateId: "restart",
      run: timeoutBlockingCommand("restart"),
      timeout: 1,
    });
    viewer = await connectViewer(gateway, restartGoal);
    const restartStep = await startStep(
      viewer,
      gateway,
      restartGoal,
      "restart",
      "restart",
      containerId,
    );
    // Recovery must use only the immutable host-owned tuple and v1
    // attestation that were persisted before the payload was released.
    const hostPinnedRestartStep = await readActiveStep(
      gateway,
      restartGoal,
      restartStep.signalId,
    );
    expect(
      hostPinnedRestartStep.containerOwnershipWitness,
      "host must persist the original container witness before payload code proceeds",
    ).toMatchObject(restartStep.witness);
    expect(hostPinnedRestartStep.containerOwnershipAttestation).toMatchObject({
      version: 1,
      containerId: restartStep.witness.containerId,
      nonce: restartStep.witness.nonce,
      sentinelPid: restartStep.witness.sentinelPid,
      pgid: restartStep.witness.pgid,
      startToken: restartStep.witness.startToken,
    });
    // Crash after host persistence while the payload remains live. Restart
    // recovery may only use this immutable v1 host attestation for cleanup.
    const recovered = waitForActiveRemoval(activePath, restartStep.signalId);
    viewer.close();
    viewer = undefined;
    await crashGateway(gateway);
    gateway = await startGateway(root, port);
    await recovered;
    assertStepCleaned(containerId, restartStep);
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

    const stableProcessCount = containerProcessCount(containerId);
    const label = "fast-natural";
    const goal = await createCommandGoal(gateway, projectId, {
      title: label,
      gateId: "natural",
      run: normalCommand(label),
      timeout: 30,
    });
    viewer = await connectViewer(gateway, goal);
    const from = viewer.mark();
    const step = await startStep(
      viewer,
      gateway,
      goal,
      "natural",
      label,
      containerId,
    );
    releaseFifo(containerId, label);
    const done = await viewer.waitFrom(from, completionEvent(step.signalId));
    expect(done.status, `${label} terminal status`).toBe("passed");
    assertStepCleaned(containerId, step);
    expect(
      containerProcessCount(containerId),
      `${label} must not retain a sentinel or process group`,
    ).toBe(stableProcessCount);
    viewer.close();
    viewer = undefined;
  } finally {
    killContainerProcess(fixture, siblingPid);
    viewer?.close();
    await stopGateway(gateway);
    if (fixture) {
      cleanupDockerProject(fixture.projectId);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("protocol-valid inner exit frames cannot complete a blocked or exit-23 payload", async () => {
  requireDockerPrerequisites();
  test.setTimeout(300_000);
  let fixture: ContainerFixture | undefined;
  let viewer: Viewer | undefined;
  let sibling: ContainerIdentity | undefined;
  try {
    fixture = await createContainerFixture("inner-exit");
    sibling = startSameUidSibling(fixture.containerId, "inner-exit-sibling");
    const holdGoal = await createCommandGoal(
      fixture.gateway,
      fixture.projectId,
      {
        title: "forged-inner-hold",
        gateId: "hold",
        run: forgedInnerSentinelExitCommand("forged-inner-hold", "hold"),
        timeout: 30,
      },
    );
    viewer = await connectViewer(fixture.gateway, holdGoal);
    const holdFrom = viewer.mark();
    const hold = await startStep(
      viewer,
      fixture.gateway,
      holdGoal,
      "hold",
      "forged-inner-hold",
      fixture.containerId,
    );
    await viewer.waitFrom(
      holdFrom,
      outputEvent(
        hold.signalId,
        "ADVERSARY_VALID_INNER_EXIT_FORGERY:forged-inner-hold",
      ),
    );
    const activeHold = await api(
      fixture.gateway,
      `/api/goals/${holdGoal}/verifications/active`,
    );
    await expectResponseStatus(activeHold, 200);
    expect(
      (await activeHold.json()).verifications.some(
        (entry: any) => entry.signalId === hold.signalId,
      ),
      "INNER_EXIT_FORGERY must not release a blocked payload",
    ).toBe(true);
    expect(
      viewer.messages.slice(holdFrom).some(completionEvent(hold.signalId)),
      "INNER_EXIT_FORGERY must not publish completion before the honest payload release",
    ).toBe(false);
    assertContainerAlive(
      fixture.containerId,
      hold.payloadPid,
      "blocked payload after forged exact protocol frame",
    );
    assertHostAlive(hold.hostPid);
    releaseFifo(fixture.containerId, "forged-inner-hold");
    const holdDone = await viewer.waitFrom(
      holdFrom,
      completionEvent(hold.signalId),
    );
    expect(holdDone.status).toBe("passed");
    assertStepCleaned(fixture.containerId, hold);
    assertContainerAlive(
      fixture.containerId,
      sibling.pid,
      "sibling after forged blocked inner exit",
    );
    viewer.close();
    viewer = undefined;

    const exitGoal = await createCommandGoal(
      fixture.gateway,
      fixture.projectId,
      {
        title: "forged-inner-23",
        gateId: "exit",
        run: forgedInnerSentinelExitCommand("forged-inner-23", "exit-23"),
        timeout: 30,
      },
    );
    viewer = await connectViewer(fixture.gateway, exitGoal);
    const exitFrom = viewer.mark();
    const exit23 = await startStep(
      viewer,
      fixture.gateway,
      exitGoal,
      "exit",
      "forged-inner-23",
      fixture.containerId,
    );
    const exitStep = await viewer.waitFrom(
      exitFrom,
      stepCompletionEvent(exit23.signalId),
    );
    expect(
      exitStep.status,
      "INNER_EXIT_FORGERY must not turn honest exit 23 into success",
    ).toBe("failed");
    expect(
      exitStep.output,
      "honest exit 23 must run before terminal publication",
    ).toContain("HONEST_EXIT_23:forged-inner-23");
    assertStepCleaned(fixture.containerId, exit23);
    assertContainerAlive(
      fixture.containerId,
      sibling.pid,
      "sibling after forged exit-23 inner exit",
    );
  } finally {
    viewer?.close();
    killContainerProcess(fixture, sibling?.pid);
    await disposeFixture(fixture);
  }
});

test("honest payload exit 125 is terminal only after payload and transport cleanup", async () => {
  requireDockerPrerequisites();
  test.setTimeout(300_000);
  let fixture: ContainerFixture | undefined;
  let viewer: Viewer | undefined;
  let sibling: ContainerIdentity | undefined;
  try {
    fixture = await createContainerFixture("exit-125");
    sibling = startSameUidSibling(fixture.containerId, "exit-125-sibling");
    const exits = [
      {
        label: "honest-125-failed",
        gateId: "failed",
        code: 125,
        status: "failed",
        statusMessage:
          "HONEST_EXIT_125 must be a terminal failed verdict, not a pending cleanup state",
        siblingMessage: "sibling after honest exit 125",
      },
      {
        label: "honest-125-expected",
        gateId: "expected",
        code: 125,
        status: "passed",
        statusMessage:
          "expect: failure must accept honest exit 125 after exact cleanup",
        siblingMessage: "sibling after expected honest exit 125",
        expectFailure: true,
        metadata: { error_pattern: "HONEST_EXIT_125" },
      },
    ] as const;
    for (const exit of exits) {
      const goal = await createCommandGoal(fixture.gateway, fixture.projectId, {
        title: exit.label,
        gateId: exit.gateId,
        run: honestExitCommand(exit.label, exit.code),
        timeout: 30,
        ...(exit.expectFailure ? { expectFailure: true } : {}),
      });
      viewer = await connectViewer(fixture.gateway, goal);
      const from = viewer.mark();
      const step = await startStep(
        viewer,
        fixture.gateway,
        goal,
        exit.gateId,
        exit.label,
        fixture.containerId,
        exit.metadata,
      );
      const result = await viewer.waitFrom(
        from,
        stepCompletionEvent(step.signalId),
      );
      expect(result.status, exit.statusMessage).toBe(exit.status);
      expect(result.output).toContain(`HONEST_EXIT_${exit.code}:${exit.label}`);
      assertStepCleaned(fixture.containerId, step);
      assertContainerAlive(fixture.containerId, sibling.pid, exit.siblingMessage);
      viewer.close();
      viewer = undefined;
    }
  } finally {
    viewer?.close();
    killContainerProcess(fixture, sibling?.pid);
    await disposeFixture(fixture);
  }
});

test("recovery cleans an exact exited sentinel group before publishing its host result", async () => {
  requireDockerPrerequisites();
  test.setTimeout(300_000);
  let fixture: ContainerFixture | undefined;
  let gateway: Gateway | undefined;
  let viewer: Viewer | undefined;
  try {
    fixture = await createContainerFixture("result-crash-window");
    gateway = fixture.gateway;
    const goalId = await createCommandGoal(gateway, fixture.projectId, {
      title: "result-crash-window",
      gateId: "result",
      run: normalCommand("result-crash-window"),
      timeout: 30,
    });
    const activePath = join(
      fixture.root,
      ".bobbit",
      "state",
      "active-verifications.json",
    );
    viewer = await connectViewer(gateway, goalId);
    const from = viewer.mark();
    const step = await startStep(
      viewer,
      gateway,
      goalId,
      "result",
      "result-crash-window",
      fixture.containerId,
    );
    const terminalAfterCleanup = waitForRecoveredRemovalAfterPayloadCleanup(
      activePath,
      step.signalId,
    );
    releaseFifo(fixture.containerId, "result-crash-window");
    const hostResultBeforeCleanup = await waitForHostResultBeforePayloadCleanup(
      activePath,
      step.signalId,
    );
    expect(hostResultBeforeCleanup.steps[0].containerOwnershipWitness).toEqual(
      step.witness,
    );
    expect(
      viewer.messages.slice(from).some(completionEvent(step.signalId)),
      "the live gateway must not publish a terminal event while exact cleanup is pending",
    ).toBe(false);
    viewer.close();
    viewer = undefined;
    await crashGateway(gateway);
    gateway = await startGateway(fixture.root, gateway.port);
    await terminalAfterCleanup;
    assertStepCleaned(fixture.containerId, step);
    const signalsResponse = await api(
      gateway,
      `/api/goals/${goalId}/gates/result/signals`,
    );
    await expectResponseStatus(signalsResponse, 200);
    const recoveredSignal = (await signalsResponse.json()).signals.find(
      (signal: any) => signal.id === step.signalId,
    );
    expect(
      recoveredSignal?.verification?.status,
      "recovered terminal publication follows the durably observed exact cleanup",
    ).toBe("passed");
  } finally {
    viewer?.close();
    await stopGateway(gateway);
    if (fixture) {
      cleanupDockerProject(fixture.projectId);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("missing retained host transport witness keeps container recovery pending until exact restoration", async () => {
  requireDockerPrerequisites();
  let fixture: ContainerFixture | undefined;
  let gateway: Gateway | undefined;
  let viewer: Viewer | undefined;
  let sibling: ContainerIdentity | undefined;
  try {
    fixture = await createContainerFixture("missing-host-transport-witness");
    gateway = fixture.gateway;
    sibling = startSameUidSibling(
      fixture.containerId,
      "missing-host-transport-witness-sibling",
    );
    const goalId = await createCommandGoal(gateway, fixture.projectId, {
      title: "missing-host-transport-witness",
      gateId: "result",
      run: normalCommand("missing-host-transport-witness"),
      timeout: 30,
    });
    const activePath = join(
      fixture.root,
      ".bobbit",
      "state",
      "active-verifications.json",
    );
    viewer = await connectViewer(gateway, goalId);
    const from = viewer.mark();
    const step = await startStep(
      viewer,
      gateway,
      goalId,
      "result",
      "missing-host-transport-witness",
      fixture.containerId,
    );
    const durableStep = await readActiveStep(gateway, goalId, step.signalId);
    const sentinelFile = durableStep.sentinelFile as string | undefined;
    expect(
      sentinelFile,
      "readiness must durably retain the host docker-exec sentinel identity",
    ).toBeTruthy();
    expect(existsSync(sentinelFile!)).toBe(true);
    const exactWitness = readFileSync(sentinelFile!, "utf8");
    const parsedTransportWitness = JSON.parse(exactWitness);
    expect(parsedTransportWitness).toMatchObject({
      pgid: step.hostPid,
      nonce: durableStep.pidNonce,
    });
    expect(parsedTransportWitness.pid).toBeGreaterThan(0);

    // Corrupt only the host-side transport authority after the container tuple
    // and daemon attestation are durable. The payload itself may finish, but a
    // missing host witness must never make its historical process group a target
    // or authorize terminal publication.
    rmSync(sentinelFile!);
    const terminalAfterExactCleanup = waitForRecoveredRemovalAfterPayloadCleanup(
      activePath,
      step.signalId,
    );
    releaseFifo(fixture.containerId, "missing-host-transport-witness");
    const pending = await waitForActiveVerification(
      activePath,
      step.signalId,
      (entry) => {
        const activeStep = entry?.steps?.[0];
        return (
          !!activeStep?.containerPayloadCleanupCompletedAt &&
          activeStep.containerTransportCleanupPending === true &&
          !activeStep.containerTransportCleanupCompletedAt
        );
      },
      "missing host transport witness did not leave cleanup durably pending",
    );
    const pendingStep = pending!.steps[0];
    expect(pendingStep.containerOwnershipWitness).toEqual(step.witness);
    expect(pendingStep.containerTransportCleanupPending).toBe(true);
    expect(pendingStep.containerTransportCleanupCompletedAt).toBeUndefined();
    assertContainerGone(fixture.containerId, step.payloadPid);
    assertContainerGone(fixture.containerId, step.witness.sentinelPid);
    assertContainerGroupGone(fixture.containerId, step.witness.pgid);
    assertNoContainerTermSignal(
      fixture.containerId,
      sibling.termFile,
      "unrelated same-UID sibling while transport witness is missing",
    );
    assertContainerAlive(
      fixture.containerId,
      sibling.pid,
      "unrelated same-UID sibling while transport witness is missing",
    );
    expect(
      viewer.messages.slice(from).some(completionEvent(step.signalId)),
      "a missing host transport witness cannot publish terminal completion",
    ).toBe(false);
    const pendingSignals = await api(
      gateway,
      `/api/goals/${goalId}/gates/result/signals`,
    );
    await expectResponseStatus(pendingSignals, 200);
    const pendingSignal = (await pendingSignals.json()).signals.find(
      (signal: any) => signal.id === step.signalId,
    );
    expect(
      pendingSignal?.verification,
      "a missing host transport witness keeps its exact verification and command step active",
    ).toMatchObject({
      status: "running",
      steps: [{ name: "result", status: "running", passed: false }],
    });
    const pendingGateResponse = await api(
      gateway,
      `/api/goals/${goalId}/gates/result?view=summary`,
    );
    await expectResponseStatus(pendingGateResponse, 200);
    expect(
      (await pendingGateResponse.json()).status,
      "a missing host transport witness cannot terminally change its gate status",
    ).toBe("pending");

    // The original atomically retained witness is restored only after a gateway
    // crash removes the live-child authority. Recovery can then validate this
    // exact tuple before it reaps the retained host transport sentinel.
    viewer.close();
    viewer = undefined;
    await crashGateway(gateway);
    writeFileSync(sentinelFile!, exactWitness);
    gateway = await startGateway(fixture.root, gateway.port);
    await terminalAfterExactCleanup;
    assertStepCleaned(fixture.containerId, step);
    assertNoContainerTermSignal(
      fixture.containerId,
      sibling.termFile,
      "unrelated same-UID sibling after exact host transport recovery",
    );
    assertContainerAlive(
      fixture.containerId,
      sibling.pid,
      "unrelated same-UID sibling after exact host transport recovery",
    );
    const recoveredSignals = await api(
      gateway,
      `/api/goals/${goalId}/gates/result/signals`,
    );
    await expectResponseStatus(recoveredSignals, 200);
    const recoveredSignal = (await recoveredSignals.json()).signals.find(
      (signal: any) => signal.id === step.signalId,
    );
    expect(
      recoveredSignal?.verification?.status,
      "terminal gate publication follows exact payload and host transport cleanup",
    ).toBe("passed");
  } finally {
    viewer?.close();
    killContainerProcess(fixture, sibling?.pid);
    await disposeFixture(fixture, gateway);
  }
});

test("a copied daemon tag on B's non-descendant cannot replace A's cancelled ownership", async () => {
  requireDockerPrerequisites();
  test.setTimeout(300_000);
  let fixture: ContainerFixture | undefined;
  let viewerA: Viewer | undefined;
  let viewerB: Viewer | undefined;
  let a: RunningStep | undefined;
  let b: RunningStep | undefined;
  let replacementPid = 0;
  try {
    fixture = await createContainerFixture("copied-tag");
    const controlFifo = `/tmp/bobbit-copied-tag-control-${fixture.gateway.port}.fifo`;
    const replacementFile = `/tmp/bobbit-copied-tag-replacement-${fixture.gateway.port}.json`;
    const bTermFile = `/tmp/bobbit-copied-tag-b-${fixture.gateway.port}.term`;
    const bGoal = await createCommandGoal(fixture.gateway, fixture.projectId, {
      title: "copied-tag-b",
      gateId: "b",
      run: copiedTagReplacementCommand(
        "copied-tag-b",
        controlFifo,
        replacementFile,
        bTermFile,
      ),
      timeout: 60,
    });
    viewerB = await connectViewer(fixture.gateway, bGoal);
    b = await startStep(
      viewerB,
      fixture.gateway,
      bGoal,
      "b",
      "copied-tag-b",
      fixture.containerId,
    );

    const aGoal = await createCommandGoal(fixture.gateway, fixture.projectId, {
      title: "copied-tag-a",
      gateId: "a",
      run: blockingCommand("copied-tag-a"),
      timeout: 60,
    });
    viewerA = await connectViewer(fixture.gateway, aGoal);
    a = await startStep(
      viewerA,
      fixture.gateway,
      aGoal,
      "a",
      "copied-tag-a",
      fixture.containerId,
    );
    const attestedA = await readActiveStep(fixture.gateway, aGoal, a.signalId);
    const attestation = attestedA.containerOwnershipAttestation;
    expect(attestation).toMatchObject({
      version: 1,
      containerId: a.witness.containerId,
      nonce: a.witness.nonce,
      sentinelPid: a.witness.sentinelPid,
      pgid: a.witness.pgid,
      startToken: a.witness.startToken,
    });
    expect(attestation.tag).toBeTruthy();
    expect(attestation.nonce).not.toBe(b.witness.nonce);
    const bFrom = viewerB.mark();
    docker([
      "exec",
      fixture.containerId,
      "/bin/sh",
      "-c",
      `printf '%s\n' ${attestation.tag} > ${controlFifo}`,
    ]);
    await viewerB.waitFrom(
      bFrom,
      outputEvent(b!.signalId, "COPIED_TAG_REPLACEMENT_READY:copied-tag-b"),
    );
    const replacement = JSON.parse(
      docker(["exec", fixture.containerId, "cat", replacementFile]),
    ) as ContainerIdentity;
    replacementPid = replacement.pid;
    expect(
      replacement.pgid,
      "replacement must run in B's group, not A's daemon Exec tree",
    ).toBe(b.witness.pgid);

    const unchangedA = await readActiveStep(fixture.gateway, aGoal, a.signalId);
    expect(unchangedA.containerOwnershipWitness).toEqual(a.witness);
    expect(unchangedA.containerOwnershipAttestation).toEqual(attestation);
    expect(unchangedA.containerPayloadCleanupPending).not.toBe(true);

    await expectResponseStatus(
      await api(
        fixture.gateway,
        `/api/goals/${aGoal}/gates/a/cancel-verification`,
        { method: "POST" },
      ),
      200,
    );
    assertNoContainerTermSignal(
      fixture.containerId,
      bTermFile,
      "B copied-tag group after cancelling A",
    );
    assertContainerAlive(
      fixture.containerId,
      b.payloadPid,
      "B payload after cancelling copied-tag target A",
    );
    assertContainerAlive(
      fixture.containerId,
      replacementPid,
      "B copied-tag replacement after cancelling A",
    );
    assertHostAlive(b.hostPid);
  } finally {
    viewerA?.close();
    viewerB?.close();
    killContainerProcess(fixture, replacementPid);
    killContainerProcess(fixture, b?.payloadPid);
    await disposeFixture(fixture);
  }
});

test("structured docker-top row injection cannot substitute concurrent ownership", async () => {
  requireDockerPrerequisites();
  test.setTimeout(300_000);
  let fixture: ContainerFixture | undefined;
  let viewerA: Viewer | undefined;
  let viewerB: Viewer | undefined;
  let sibling: ContainerIdentity | undefined;
  let a: RunningStep | undefined;
  let b: RunningStep | undefined;
  try {
    fixture = await createContainerFixture("structured-top");
    sibling = startSameUidSibling(
      fixture.containerId,
      "structured-top-sibling",
    );
    const aGoal = await createCommandGoal(fixture.gateway, fixture.projectId, {
      title: "structured-top-a",
      gateId: "a",
      run: blockingCommand("structured-top-a"),
      timeout: 60,
    });
    viewerA = await connectViewer(fixture.gateway, aGoal);
    a = await startStep(
      viewerA,
      fixture.gateway,
      aGoal,
      "a",
      "structured-top-a",
      fixture.containerId,
    );
    const attestedA = await readActiveStep(fixture.gateway, aGoal, a.signalId);
    const attestationA = attestedA.containerOwnershipAttestation;
    expect(attestationA).toMatchObject({
      containerId: a.witness.containerId,
      nonce: a.witness.nonce,
      sentinelPid: a.witness.sentinelPid,
      pgid: a.witness.pgid,
      startToken: a.witness.startToken,
    });
    expect(attestationA.tag).toBeTruthy();

    const controlFifo = `/tmp/bobbit-structured-top-control-${fixture.gateway.port}.fifo`;
    const bTermFile = `/tmp/bobbit-structured-top-b-${fixture.gateway.port}.term`;
    const bGoal = await createCommandGoal(fixture.gateway, fixture.projectId, {
      title: "structured-top-b",
      gateId: "b",
      run: structuredTopAbuseCommand(
        "structured-top-b",
        bTermFile,
        controlFifo,
        attestationA.tag,
        a.witness.nonce,
      ),
      timeout: 60,
    });
    viewerB = await connectViewer(fixture.gateway, bGoal);
    b = await startStep(
      viewerB,
      fixture.gateway,
      bGoal,
      "b",
      "structured-top-b",
      fixture.containerId,
    );
    const activeB = await readActiveStep(fixture.gateway, bGoal, b.signalId);
    expect(b.witness.nonce).not.toBe(a.witness.nonce);
    expect(b.witness.pgid).not.toBe(a.witness.pgid);
    expect(
      attestationA.execId,
      "concurrent hostile steps cannot share a daemon Exec",
    ).not.toBe(activeB.containerOwnershipAttestation?.execId);
    assertDaemonExecOwnsWitness(fixture.containerId, attestedA, "A");
    assertDaemonExecOwnsWitness(fixture.containerId, activeB, "B");
    const bFrom = viewerB.mark();
    docker([
      "exec",
      fixture.containerId,
      "/bin/sh",
      "-c",
      `printf '%s %s %s %s %s\\n' ${a.witness.nonce} ${a.witness.containerId} ${b.witness.sentinelPid} ${b.witness.pgid} ${b.witness.startToken} > ${controlFifo}`,
    ]);
    await viewerB.waitFrom(
      bFrom,
      outputEvent(
        b.signalId,
        "ADVERSARY_PRERELEASE_TRANSPORT_FORGERY:structured-top-b",
      ),
    );

    const unchangedA = await readActiveStep(fixture.gateway, aGoal, a.signalId);
    expect(
      unchangedA.containerOwnershipWitness,
      "embedded synthetic rows and B's tuple cannot become A's persisted authority",
    ).toEqual(a.witness);
    expect(unchangedA.containerOwnershipAttestation).toEqual(attestationA);
    expect(unchangedA.containerOwnershipWitness).not.toMatchObject({
      sentinelPid: b.witness.sentinelPid,
      pgid: b.witness.pgid,
      startToken: b.witness.startToken,
    });

    await cancelStep(a, fixture.gateway);
    assertStepCleaned(fixture.containerId, a);
    assertNoContainerTermSignal(
      fixture.containerId,
      bTermFile,
      "B group after cancelling structured-top target A",
    );
    assertContainerAlive(
      fixture.containerId,
      b.payloadPid,
      "B payload after A cancellation",
    );
    assertContainerAlive(
      fixture.containerId,
      b.witness.sentinelPid,
      "B sentinel after A cancellation",
    );
    assertHostAlive(b.hostPid);
    assertContainerAlive(
      fixture.containerId,
      sibling.pid,
      "unrelated sibling after A cancellation",
    );

    await cancelStep(b, fixture.gateway);
    assertStepCleaned(fixture.containerId, b);
    assertContainerAlive(
      fixture.containerId,
      sibling.pid,
      "unrelated sibling after B cleanup",
    );
  } finally {
    viewerA?.close();
    viewerB?.close();
    killContainerProcess(fixture, sibling?.pid);
    killContainerProcess(fixture, a?.payloadPid);
    killContainerProcess(fixture, b?.payloadPid);
    await disposeFixture(fixture);
  }
});
