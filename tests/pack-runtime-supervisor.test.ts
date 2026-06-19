/**
 * Unit — P2 PackRuntimeSupervisor (Docker fully mocked).
 *
 * Covers (design "P2 PackRuntimeSupervisor + REST design", Tests §):
 *   1. Status walk: empty ps → stopped; running/healthy → running; unhealthy → unhealthy.
 *   2. Health timeout: `up -d` ok but ps stays starting → unhealthy + timeout message.
 *   3. ENOENT from the executor → docker-unavailable (never throws).
 *   4. Concurrent ensureRuntime → exactly one `compose up` invocation (in-flight dedupe).
 *   5. stop → `compose stop` and a stopped status.
 *   6. Compose project name contains the deterministic injected server suffix.
 *   7. Docker exec env carries MSYS_NO_PATHCONV / MSYS2_ARG_CONV_EXCL.
 *   + id encode/decode, tail clamp, ps parse, and up-invocation arg/env-file shape.
 *
 * No real Docker is ever executed: the executor seam is mocked in every test.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
	PackRuntimeSupervisor,
	PackRuntimeNotFoundError,
	PackRuntimeBadRequestError,
	PackRuntimeDockerUnavailableError,
	FilePortStore,
	getOrCreatePackRuntimeServerIdentity,
	readRuntimeStartPolicy,
	readRuntimeHealthcheck,
	encodePackRuntimeId,
	decodePackRuntimeId,
	packRuntimePersistKey,
	clampTail,
	parseComposePs,
	mapServicesToState,
	type DockerExecOptions,
	type DockerExecResult,
	type DockerExecutor,
} from "../src/server/runtimes/pack-runtime-supervisor.ts";
import type { RuntimeContribution } from "../src/server/agent/pack-contributions.ts";
import type { PackContributionResolver } from "../src/server/extension-host/pack-contribution-registry.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

let tmp: string;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pack-runtime-sup-")); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const PACK_ID = "hindsight";
const RUNTIME_ID = "db";

function makeContribution(overrides: Partial<RuntimeContribution> = {}): RuntimeContribution {
	const packRoot = path.join(tmp, "packs", PACK_ID);
	const sourceFile = path.join(packRoot, "runtimes", `${RUNTIME_ID}.yaml`);
	return {
		id: RUNTIME_ID,
		title: "Hindsight DB",
		description: "Managed Postgres",
		listName: RUNTIME_ID,
		sourceFile,
		packRoot,
		manifest: {
			id: RUNTIME_ID,
			composeFile: "compose.yaml",
			modes: { default: { services: ["db"], profiles: ["managed"] } },
		},
		...overrides,
	};
}

/** Minimal PackContributionResolver returning a single runtime. */
function makeRegistry(contribution: RuntimeContribution): PackContributionResolver {
	const pack = {
		packId: PACK_ID,
		packName: "Hindsight",
		packRoot: contribution.packRoot,
		panels: [],
		entrypoints: [],
		providers: [],
		runtimes: [contribution],
	};
	const resolver = {
		list: () => [pack],
		getPack: (_p: string | undefined, packId: string) => (packId === PACK_ID ? pack : undefined),
		getRuntime: (_p: string | undefined, packId: string, runtimeId: string) =>
			packId === PACK_ID && runtimeId === contribution.id ? contribution : undefined,
		getPanel: () => undefined,
		getEntrypoint: () => undefined,
		listProviders: () => [],
		hasRoute: () => false,
	};
	return resolver as unknown as PackContributionResolver;
}

interface DockerCall {
	file: string;
	args: string[];
	options: DockerExecOptions;
}

type SubHandler = (ctx: { calls: DockerCall[] }) => DockerExecResult | Promise<DockerExecResult>;

function subcommandOf(args: string[]): string {
	for (const sub of ["up", "stop", "logs", "ps", "down"]) {
		if (args.includes(sub)) return sub;
	}
	return "other";
}

function makeDocker(handlers: Partial<Record<string, SubHandler>>) {
	const calls: DockerCall[] = [];
	const executor: DockerExecutor = async (file, args, options) => {
		calls.push({ file, args: [...args], options });
		const handler = handlers[subcommandOf([...args])];
		if (handler) return handler({ calls });
		return { stdout: "", stderr: "" };
	};
	return {
		executor,
		calls,
		countSub: (sub: string) => calls.filter((c) => c.args.includes(sub)).length,
	};
}

const ok = (stdout = ""): DockerExecResult => ({ stdout, stderr: "" });

/**
 * Expected base of EVERY `docker compose` invocation: the project plus the
 * `-f composeFile`/`--env-file` derived from the validated runtime invocation.
 * status/stop/logs must all carry these (not just `up`) so they address the
 * correct compose context regardless of the gateway cwd.
 */
function composeBase(project: string, composeAbs: string, envFile: string): string[] {
	return ["compose", "-p", project, "-f", composeAbs, "--env-file", envFile];
}

function makeSupervisor(
	executor: DockerExecutor,
	opts: Partial<ConstructorParameters<typeof PackRuntimeSupervisor>[0]> = {},
): PackRuntimeSupervisor {
	const contribution = (opts as { contribution?: RuntimeContribution }).contribution ?? makeContribution();
	return new PackRuntimeSupervisor({
		registry: makeRegistry(contribution),
		executor,
		serverIdentitySuffix: "testsuffix",
		runtimeDataDir: path.join(tmp, "data"),
		startupTimeoutMs: 50,
		pollIntervalMs: 20,
		...opts,
	});
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("pack-runtime id encode/decode", () => {
	it("round-trips packId + runtimeId", () => {
		const id = encodePackRuntimeId("my-pack", "db.v1");
		assert.deepEqual(decodePackRuntimeId(id), { packId: "my-pack", runtimeId: "db.v1" });
	});
	it("round-trips ids with separators safely", () => {
		const id = encodePackRuntimeId("a:b", "c:d");
		assert.deepEqual(decodePackRuntimeId(id), { packId: "a:b", runtimeId: "c:d" });
	});
	it("rejects malformed ids", () => {
		assert.throws(() => decodePackRuntimeId("nocolon"), PackRuntimeBadRequestError);
		assert.throws(() => decodePackRuntimeId(":only"), PackRuntimeBadRequestError);
		assert.throws(() => decodePackRuntimeId("only:"), PackRuntimeBadRequestError);
	});
});

describe("clampTail", () => {
	it("defaults, clamps, and validates", () => {
		assert.equal(clampTail(undefined), 200);
		assert.equal(clampTail(0), 1);
		assert.equal(clampTail(50), 50);
		assert.equal(clampTail(99999), 5000);
		assert.throws(() => clampTail("abc"), PackRuntimeBadRequestError);
	});
});

describe("parseComposePs / mapServicesToState", () => {
	it("parses JSON-lines and JSON-array output", () => {
		const lines = '{"Service":"db","State":"running","Health":"healthy"}\n{"Service":"api","State":"running"}';
		assert.deepEqual(parseComposePs(lines), [
			{ name: "db", state: "running", health: "healthy" },
			{ name: "api", state: "running" },
		]);
		const arr = '[{"Name":"db","State":"running"}]';
		assert.deepEqual(parseComposePs(arr), [{ name: "db", state: "running" }]);
		assert.deepEqual(parseComposePs("   "), []);
	});
	it("maps service states", () => {
		assert.equal(mapServicesToState([]), "stopped");
		assert.equal(mapServicesToState([{ name: "db", state: "running", health: "healthy" }]), "running");
		assert.equal(mapServicesToState([{ name: "db", state: "running" }]), "running");
		assert.equal(mapServicesToState([{ name: "db", state: "running", health: "unhealthy" }]), "unhealthy");
		assert.equal(mapServicesToState([{ name: "db", state: "running", health: "starting" }]), "starting");
		assert.equal(mapServicesToState([{ name: "db", state: "exited" }]), "stopped");
	});
});

// ── Status walk ──────────────────────────────────────────────────────────────

describe("PackRuntimeSupervisor.status", () => {
	it("empty ps → stopped", async () => {
		const docker = makeDocker({ ps: () => ok("") });
		const sup = makeSupervisor(docker.executor);
		const st = await sup.status(PACK_ID, RUNTIME_ID);
		assert.equal(st.status, "stopped");
		assert.deepEqual(st.services, []);
		assert.equal(st.id, encodePackRuntimeId(PACK_ID, RUNTIME_ID));
		assert.equal(st.packName, "Hindsight");
		assert.equal(st.title, "Hindsight DB");
	});

	it("running/healthy ps → running", async () => {
		const docker = makeDocker({
			ps: () => ok('{"Service":"db","State":"running","Health":"healthy"}'),
		});
		const sup = makeSupervisor(docker.executor);
		const st = await sup.status(PACK_ID, RUNTIME_ID);
		assert.equal(st.status, "running");
	});

	it("unhealthy service → unhealthy", async () => {
		const docker = makeDocker({
			ps: () => ok('{"Service":"db","State":"running","Health":"unhealthy"}'),
		});
		const sup = makeSupervisor(docker.executor);
		const st = await sup.status(PACK_ID, RUNTIME_ID);
		assert.equal(st.status, "unhealthy");
	});

	it("throws PackRuntimeNotFoundError for unknown runtime", async () => {
		const docker = makeDocker({ ps: () => ok("") });
		const sup = makeSupervisor(docker.executor);
		await assert.rejects(() => sup.status(PACK_ID, "nope"), PackRuntimeNotFoundError);
		await assert.rejects(() => sup.status("nopack", RUNTIME_ID), PackRuntimeNotFoundError);
	});

	it("list() reports every active runtime", async () => {
		const docker = makeDocker({ ps: () => ok("") });
		const sup = makeSupervisor(docker.executor);
		const all = await sup.list();
		assert.equal(all.length, 1);
		assert.equal(all[0]!.runtimeId, RUNTIME_ID);
		assert.equal(all[0]!.status, "stopped");
	});
});

// ── No auto-start (P3 invariant) ─────────────────────────────────────────────
//
// P3 hard invariant: Docker `compose up` happens ONLY from an explicit user
// enable/start action. The READ paths (boot listing / status polling) must never
// implicitly bring a runtime up. This pins that contract at the supervisor seam:
// neither `list()` nor `status()` may ever issue an `up` subcommand, regardless
// of the runtime's current state (stopped, healthy, or unhealthy).

describe("PackRuntimeSupervisor no-auto-start (P3)", () => {
	for (const [label, psOut] of [
		["stopped", ""],
		["running", '{"Service":"db","State":"running","Health":"healthy"}'],
		["unhealthy", '{"Service":"db","State":"running","Health":"unhealthy"}'],
	] as const) {
		it(`status() never issues compose up (${label})`, async () => {
			// `up` is intentionally UNHANDLED: if status ever called it the spy would
			// still record the call, so the zero-count assertion is meaningful.
			const docker = makeDocker({ ps: () => ok(psOut) });
			const sup = makeSupervisor(docker.executor);
			await sup.status(PACK_ID, RUNTIME_ID);
			assert.equal(docker.countSub("up"), 0, "status must not auto-start the runtime");
			// The only Docker subcommand a read path may issue is `ps`.
			assert.ok(docker.calls.every((c) => c.args.includes("ps")));
		});
	}

	it("list() never issues compose up across every active runtime", async () => {
		const docker = makeDocker({ ps: () => ok('{"Service":"db","State":"running","Health":"healthy"}') });
		const sup = makeSupervisor(docker.executor);
		await sup.list();
		assert.equal(docker.countSub("up"), 0, "boot listing must not auto-start any runtime");
		assert.ok(docker.calls.every((c) => c.args.includes("ps")));
	});
});

// ── Start / ensure / poll ────────────────────────────────────────────────────

describe("PackRuntimeSupervisor.start / ensureRuntime", () => {
	it("renders env file and issues a contained `compose up -d` with profiles", async () => {
		const docker = makeDocker({
			up: () => ok(),
			ps: () => ok('{"Service":"db","State":"running","Health":"healthy"}'),
		});
		const contribution = makeContribution();
		const sup = makeSupervisor(docker.executor, { contribution });
		const st = await sup.start(PACK_ID, RUNTIME_ID);
		assert.equal(st.status, "running");
		assert.equal(st.mode, "default");

		const upCall = docker.calls.find((c) => c.args.includes("up"))!;
		const project = `bobbit-pack-${PACK_ID}-testsuffix`;
		const composeAbs = path.join(contribution.packRoot, "runtimes", "compose.yaml");
		const envFile = path.join(tmp, "data", project, `${RUNTIME_ID}.env`);
		assert.deepEqual(upCall.args, [
			"compose", "-p", project, "-f", composeAbs, "--env-file", envFile,
			"--profile", "managed", "up", "-d", "db",
		]);
		// Env file actually rendered to disk.
		assert.ok(fs.existsSync(envFile));
	});

	it("ensureRuntime fast-paths when already running (no up)", async () => {
		const docker = makeDocker({
			ps: () => ok('{"Service":"db","State":"running","Health":"healthy"}'),
			up: () => ok(),
		});
		const sup = makeSupervisor(docker.executor);
		const st = await sup.ensureRuntime(PACK_ID, RUNTIME_ID);
		assert.equal(st.status, "running");
		assert.equal(docker.countSub("up"), 0);
	});

	it("health timeout: up ok but ps stays starting → unhealthy + message", async () => {
		let t = 0;
		const docker = makeDocker({
			up: () => ok(),
			ps: () => ok('{"Service":"db","State":"running","Health":"starting"}'),
		});
		const sup = makeSupervisor(docker.executor, {
			now: () => t,
			sleep: async (ms: number) => { t += ms; },
			startupTimeoutMs: 50,
			pollIntervalMs: 20,
		});
		const st = await sup.ensureRuntime(PACK_ID, RUNTIME_ID);
		assert.equal(st.status, "unhealthy");
		assert.match(st.message ?? "", /did not become healthy/);
	});

	it("concurrent ensureRuntime → exactly one compose up", async () => {
		let started = false;
		const docker = makeDocker({
			up: () => { started = true; return ok(); },
			ps: () => ok(started ? '{"Service":"db","State":"running","Health":"healthy"}' : ""),
		});
		const sup = makeSupervisor(docker.executor);
		const [a, b] = await Promise.all([
			sup.ensureRuntime(PACK_ID, RUNTIME_ID),
			sup.ensureRuntime(PACK_ID, RUNTIME_ID),
		]);
		assert.equal(a.status, "running");
		assert.equal(b.status, "running");
		assert.equal(docker.countSub("up"), 1);
	});
});

// ── HTTP startup readiness gate (declared healthcheck) ───────────────────────
//
// When a runtime declares an HTTP `healthcheck`, startup readiness MUST poll the
// declared path at http://127.0.0.1:<resolved host port><path> until HTTP 200.
// A compose-ps "running" alone must NOT complete start as `running` — the gap
// these pin is exactly the supervisor declaring `running` off `compose ps` before
// the data-plane API actually accepts requests.

/** A runtime declaring an HTTP `/health` readiness probe on an allocated port. */
function makeHealthContribution(hc: Record<string, unknown> = {}): RuntimeContribution {
	const packRoot = path.join(tmp, "packs", PACK_ID);
	const sourceFile = path.join(packRoot, "runtimes", `${RUNTIME_ID}.yaml`);
	return {
		id: RUNTIME_ID,
		title: "Hindsight API",
		listName: RUNTIME_ID,
		sourceFile,
		packRoot,
		manifest: {
			id: RUNTIME_ID,
			composeFile: "compose.yaml",
			healthcheck: { service: "api", port: "API_PORT", path: "/health", intervalMs: 5, startupTimeoutMs: 60, ...hc },
			ports: [{ key: "API_PORT", container: 8888 }],
			env: { API_PORT: { port: "API_PORT" } },
			modes: { default: { services: ["api"] } },
		},
	};
}

describe("PackRuntimeSupervisor HTTP startup readiness", () => {
	it("polls the declared HTTP health path and reports running only on 200", async () => {
		const docker = makeDocker({
			up: () => ok(),
			ps: () => ok('{"Service":"api","State":"running","Health":"healthy"}'),
		});
		let probes = 0;
		const urls: string[] = [];
		const httpProbe = async (url: string) => {
			urls.push(url);
			probes++;
			return probes >= 2 ? 200 : 0; // not ready first poll, ready second
		};
		let t = 0;
		const sup = makeSupervisor(docker.executor, {
			contribution: makeHealthContribution(),
			httpProbe,
			now: () => t,
			sleep: async (ms: number) => { t += ms; },
			startupTimeoutMs: 1000,
			pollIntervalMs: 5,
		});
		const st = await sup.start(PACK_ID, RUNTIME_ID);
		assert.equal(st.status, "running");
		assert.ok(probes >= 2, "must keep polling until the HTTP health path returns 200");
		// The probe URL targets 127.0.0.1 on the RESOLVED host port + declared path.
		assert.match(urls[0], /^http:\/\/127\.0\.0\.1:\d+\/health$/);
	});

	it("does NOT report running off compose ps alone — never-200 health times out to unhealthy", async () => {
		// compose ps reports a healthy/running container the WHOLE time, but the HTTP
		// health path never returns 200. The previous ps-only gap would have reported
		// `running`; the fix must hold at `starting` and time out to `unhealthy`.
		const docker = makeDocker({
			up: () => ok(),
			ps: () => ok('{"Service":"api","State":"running","Health":"healthy"}'),
		});
		let probes = 0;
		const httpProbe = async () => { probes++; return 503; };
		let t = 0;
		const sup = makeSupervisor(docker.executor, {
			contribution: makeHealthContribution(),
			httpProbe,
			now: () => t,
			sleep: async (ms: number) => { t += ms; },
			startupTimeoutMs: 30,
			pollIntervalMs: 5,
		});
		const st = await sup.start(PACK_ID, RUNTIME_ID);
		assert.equal(st.status, "unhealthy");
		assert.match(st.message ?? "", /did not become healthy/);
		assert.ok(probes >= 1, "the HTTP health path must actually be probed");
	});

	it("a Docker-reported unhealthy container short-circuits before the HTTP probe", async () => {
		const docker = makeDocker({
			up: () => ok(),
			ps: () => ok('{"Service":"api","State":"running","Health":"unhealthy"}'),
		});
		let probes = 0;
		const httpProbe = async () => { probes++; return 200; };
		const sup = makeSupervisor(docker.executor, {
			contribution: makeHealthContribution(),
			httpProbe,
			startupTimeoutMs: 50,
			pollIntervalMs: 20,
		});
		const st = await sup.start(PACK_ID, RUNTIME_ID);
		assert.equal(st.status, "unhealthy");
		assert.equal(probes, 0, "a Docker-unhealthy container must short-circuit before any HTTP probe");
	});

	it("readRuntimeHealthcheck parses a valid block and rejects malformed ones", () => {
		assert.deepEqual(
			readRuntimeHealthcheck({ healthcheck: { service: "api", port: "API_PORT", path: "/health", intervalMs: 2000, startupTimeoutMs: 120000 } }),
			{ service: "api", port: "API_PORT", path: "/health", intervalMs: 2000, startupTimeoutMs: 120000 },
		);
		assert.equal(readRuntimeHealthcheck(undefined), null);
		assert.equal(readRuntimeHealthcheck({}), null);
		assert.equal(readRuntimeHealthcheck({ healthcheck: { path: "/health" } }), null, "missing port → null");
		assert.equal(readRuntimeHealthcheck({ healthcheck: { port: "API_PORT" } }), null, "missing path → null");
		// Invalid (non-positive / non-finite) timing fields are dropped, NOT carried —
		// so the supervisor falls back to its own defaults for those (finding #3).
		assert.deepEqual(
			readRuntimeHealthcheck({ healthcheck: { port: "API_PORT", path: "/health", intervalMs: 0, startupTimeoutMs: -1 } }),
			{ port: "API_PORT", path: "/health" },
		);
	});
});

// ── Healthcheck loop timing honours the manifest (finding #3) ─────────────────
//
// The HTTP readiness loop must use the manifest healthcheck's `startupTimeoutMs`
// and `intervalMs` when declared (as parsed by readRuntimeHealthcheck — positive,
// finite values only), falling back to the supervisor defaults only when absent
// or invalid. A runtime that knows its own startup budget (e.g. Hindsight's
// 120s) must not be cut short by a smaller supervisor default, and vice-versa.

describe("PackRuntimeSupervisor healthcheck loop timing (finding #3)", () => {
	it("honours the manifest startupTimeoutMs over a (much larger) supervisor default", async () => {
		const docker = makeDocker({
			up: () => ok(),
			ps: () => ok('{"Service":"api","State":"running","Health":"healthy"}'),
		});
		let probes = 0;
		const httpProbe = async () => { probes++; return 0; }; // never ready
		let t = 0;
		const sup = makeSupervisor(docker.executor, {
			// Manifest says: give up after 30ms, re-poll every 5ms.
			contribution: makeHealthContribution({ intervalMs: 5, startupTimeoutMs: 30 }),
			httpProbe,
			now: () => t,
			sleep: async (ms: number) => { t += ms; },
			// Supervisor default is enormous — if it (wrongly) governed the loop the
			// runtime would poll ~200k times before giving up.
			startupTimeoutMs: 1_000_000,
			pollIntervalMs: 5,
		});
		const st = await sup.start(PACK_ID, RUNTIME_ID);
		assert.equal(st.status, "unhealthy");
		// 30ms budget / 5ms interval ⇒ a small, bounded number of probes (proves the
		// manifest's 30ms — not the 1_000_000ms default — bounded the loop).
		assert.ok(probes > 0 && probes <= 12, `expected a manifest-bounded probe count, got ${probes}`);
	});

	it("honours the manifest intervalMs for both the re-poll sleep and the probe timeout", async () => {
		const docker = makeDocker({
			up: () => ok(),
			ps: () => ok('{"Service":"api","State":"running","Health":"healthy"}'),
		});
		const probeTimeouts: number[] = [];
		const httpProbe = async (_url: string, timeoutMs: number) => { probeTimeouts.push(timeoutMs); return 0; };
		const sleeps: number[] = [];
		let t = 0;
		const sup = makeSupervisor(docker.executor, {
			contribution: makeHealthContribution({ intervalMs: 5, startupTimeoutMs: 20 }),
			httpProbe,
			now: () => t,
			sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
			// Supervisor defaults differ from the manifest so a regression to them is visible.
			startupTimeoutMs: 9999,
			pollIntervalMs: 999,
		});
		const st = await sup.start(PACK_ID, RUNTIME_ID);
		assert.equal(st.status, "unhealthy");
		// Re-poll sleeps use the MANIFEST interval (5), never the supervisor 999.
		assert.ok(sleeps.length > 0);
		assert.ok(sleeps.every((s) => s === 5), `expected all sleeps to be the manifest interval 5, got ${sleeps}`);
		// The HTTP probe timeout is the manifest interval too.
		assert.ok(probeTimeouts.every((s) => s === 5), `expected probe timeouts of 5, got ${probeTimeouts}`);
	});

	it("falls back to supervisor defaults when the manifest omits/invalidates the timing", async () => {
		const docker = makeDocker({
			up: () => ok(),
			ps: () => ok('{"Service":"api","State":"running","Health":"healthy"}'),
		});
		const httpProbe = async () => 0; // never ready
		const sleeps: number[] = [];
		let t = 0;
		const sup = makeSupervisor(docker.executor, {
			// Invalid timing values ⇒ readRuntimeHealthcheck drops them ⇒ fallback.
			contribution: makeHealthContribution({ intervalMs: 0, startupTimeoutMs: 0 }),
			httpProbe,
			now: () => t,
			sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
			startupTimeoutMs: 25,
			pollIntervalMs: 7,
		});
		const st = await sup.start(PACK_ID, RUNTIME_ID);
		assert.equal(st.status, "unhealthy");
		// Loop used the SUPERVISOR interval (7) since the manifest had no valid one.
		assert.ok(sleeps.length > 0);
		assert.ok(sleeps.every((s) => s === 7), `expected supervisor-default sleeps of 7, got ${sleeps}`);
	});
});

// ── ENOENT → docker-unavailable ──────────────────────────────────────────────

describe("PackRuntimeSupervisor docker-unavailable", () => {
	const enoent = () => { const e = new Error("spawn docker ENOENT") as Error & { code: string }; e.code = "ENOENT"; throw e; };

	it("status maps ENOENT → docker-unavailable (no throw)", async () => {
		const docker = makeDocker({ ps: enoent });
		const sup = makeSupervisor(docker.executor);
		const st = await sup.status(PACK_ID, RUNTIME_ID);
		assert.equal(st.status, "docker-unavailable");
	});

	it("ensureRuntime maps ENOENT → docker-unavailable", async () => {
		const docker = makeDocker({ ps: enoent, up: enoent });
		const sup = makeSupervisor(docker.executor);
		const st = await sup.ensureRuntime(PACK_ID, RUNTIME_ID);
		assert.equal(st.status, "docker-unavailable");
	});

	it("logs throw PackRuntimeDockerUnavailableError on ENOENT (no silent empty)", async () => {
		const docker = makeDocker({ logs: enoent });
		const sup = makeSupervisor(docker.executor);
		await assert.rejects(() => sup.logs(PACK_ID, RUNTIME_ID), PackRuntimeDockerUnavailableError);
	});

	it("ensureRuntime short-circuits on docker-unavailable (no compose up)", async () => {
		const docker = makeDocker({ ps: enoent, up: () => ok() });
		const sup = makeSupervisor(docker.executor);
		const st = await sup.ensureRuntime(PACK_ID, RUNTIME_ID);
		assert.equal(st.status, "docker-unavailable");
		// status() saw ENOENT → ensureRuntime must NOT fall through into start.
		assert.equal(docker.countSub("up"), 0);
	});
});

// ── Stop / restart ───────────────────────────────────────────────────────────

describe("PackRuntimeSupervisor.stop / restart", () => {
	it("stop issues `compose stop`, reuses the started env, and reports stopped", async () => {
		const docker = makeDocker({ up: () => ok(), stop: () => ok(), ps: () => ok("") });
		const sup = makeSupervisor(docker.executor);
		// Start once so the READ-ONLY stop target reuses the rendered env file. Like
		// down/logs, stop never rebuilds a full start invocation (which would re-resolve
		// start-only secrets and fail a default/never-started managed runtime).
		await sup.start(PACK_ID, RUNTIME_ID);
		const st = await sup.stop(PACK_ID, RUNTIME_ID);
		assert.equal(st.status, "stopped");
		const stopCall = docker.calls.find((c) => c.args.includes("stop"))!;
		const project = `bobbit-pack-${PACK_ID}-testsuffix`;
		const composeAbs = path.join(tmp, "packs", PACK_ID, "runtimes", "compose.yaml");
		const envFile = path.join(tmp, "data", project, `${RUNTIME_ID}.env`);
		// Carries the compose file/env file (reused from start) AND is scoped to this
		// runtime's service (`db`) — not the whole pack project.
		assert.deepEqual(stopCall.args, [...composeBase(project, composeAbs, envFile), "stop", "db"]);
	});

	it("restart stops then starts", async () => {
		let started = false;
		const docker = makeDocker({
			stop: () => { started = false; return ok(); },
			up: () => { started = true; return ok(); },
			ps: () => ok(started ? '{"Service":"db","State":"running","Health":"healthy"}' : ""),
		});
		const sup = makeSupervisor(docker.executor);
		const st = await sup.restart(PACK_ID, RUNTIME_ID);
		assert.equal(st.status, "running");
		assert.equal(docker.countSub("stop"), 1);
		assert.equal(docker.countSub("up"), 1);
	});
});

// ── Logs ─────────────────────────────────────────────────────────────────────

describe("PackRuntimeSupervisor.logs", () => {
	it("runs `compose logs --tail N` scoped to the runtime's services, reusing the rendered env", async () => {
		const docker = makeDocker({ up: () => ok(), ps: () => ok(""), logs: () => ok("hello logs") });
		const sup = makeSupervisor(docker.executor);
		// Start once so the read-only logs target reuses the rendered env file.
		await sup.start(PACK_ID, RUNTIME_ID);
		const out = await sup.logs(PACK_ID, RUNTIME_ID, { tail: 42 });
		assert.equal(out, "hello logs");
		const logCall = docker.calls.find((c) => c.args.includes("logs"))!;
		const project = `bobbit-pack-${PACK_ID}-testsuffix`;
		const composeAbs = path.join(tmp, "packs", PACK_ID, "runtimes", "compose.yaml");
		const envFile = path.join(tmp, "data", project, `${RUNTIME_ID}.env`);
		// Carries the compose file/env file (reused) AND is scoped to this runtime's service (`db`).
		assert.deepEqual(logCall.args, [...composeBase(project, composeAbs, envFile), "logs", "--tail", "42", "db"]);
	});

	it("reuses an env file rendered by a prior start, and never resolves start-only secrets", async () => {
		// A runtime whose base env REQUIRES a user-configured secret — logs must NOT
		// rebuild the full start invocation (which would throw on the missing secret).
		const packRoot = path.join(tmp, "packs", "logsecret");
		const contribution = {
			id: "svc",
			title: "svc",
			description: "svc",
			listName: "svc",
			sourceFile: path.join(packRoot, "runtimes", "svc.yaml"),
			packRoot,
			manifest: {
				id: "svc",
				composeFile: "compose.yaml",
				env: { LLM_KEY: { secret: "LLM_KEY" } },
				modes: { "managed-postgres": { services: ["api"] } },
			},
		} as RuntimeContribution;
		const pack = {
			packId: "logsecret", packName: "Log Secret", packRoot,
			panels: [], entrypoints: [], providers: [], runtimes: [contribution],
		};
		const registry = {
			list: () => [pack],
			getPack: (_p: string | undefined, id: string) => (id === "logsecret" ? pack : undefined),
			getRuntime: (_p: string | undefined, id: string, rt: string) =>
				id === "logsecret" && rt === "svc" ? contribution : undefined,
			getPanel: () => undefined, getEntrypoint: () => undefined,
			listProviders: () => [], hasRoute: () => false,
		} as unknown as PackContributionResolver;
		const docker = makeDocker({ logs: () => ok("managed logs") });
		const sup = new PackRuntimeSupervisor({
			registry,
			executor: docker.executor,
			serverIdentitySuffix: "testsuffix",
			runtimeDataDir: path.join(tmp, "logsecret-data"),
			// No secretsStore seeded with LLM_KEY — a full start invocation would throw.
		});
		const out = await sup.logs("logsecret", "svc", { tail: 10 });
		assert.equal(out, "managed logs");
		const logCall = docker.calls.find((c) => c.args.includes("logs"))!;
		assert.ok(logCall.args.includes("api"), "scoped to the runtime's service");
	});
});

// ── Project name / Docker env discipline ─────────────────────────────────────

describe("compose project name + docker env discipline", () => {
	it("compose project contains the deterministic injected suffix", async () => {
		const docker = makeDocker({ ps: () => ok("") });
		const sup = makeSupervisor(docker.executor);
		assert.equal(sup.composeProjectFor(PACK_ID), "bobbit-pack-hindsight-testsuffix");
		const st = await sup.status(PACK_ID, RUNTIME_ID);
		assert.equal(st.composeProject, "bobbit-pack-hindsight-testsuffix");
	});

	it("sanitizes unsafe packId characters in the compose project", () => {
		const docker = makeDocker({});
		const sup = makeSupervisor(docker.executor);
		assert.equal(sup.composeProjectFor("My Pack/v2!"), "bobbit-pack-my-pack-v2-testsuffix");
	});

	it("docker exec env carries MSYS_NO_PATHCONV and MSYS2_ARG_CONV_EXCL", async () => {
		const docker = makeDocker({ ps: () => ok("") });
		const sup = makeSupervisor(docker.executor);
		await sup.status(PACK_ID, RUNTIME_ID);
		const call = docker.calls[0]!;
		assert.equal(call.options.env.MSYS_NO_PATHCONV, "1");
		assert.equal(call.options.env.MSYS2_ARG_CONV_EXCL, "*");
		assert.equal(call.options.windowsHide, true);
	});

	it("honours DOCKER_BIN via injected dockerBin", async () => {
		const docker = makeDocker({ ps: () => ok("") });
		const sup = makeSupervisor(docker.executor, { dockerBin: "podman" });
		await sup.status(PACK_ID, RUNTIME_ID);
		assert.equal(docker.calls[0]!.file, "podman");
	});

	it("server identity is STABLE across restarts → stable compose project name (finding)", () => {
		// Production wiring derives the compose-project suffix from a STATE-persisted
		// server identity (not a per-process random), so a gateway restart computes the
		// SAME project name and never orphans the still-running containers.
		const stateDir = fs.mkdtempSync(path.join(tmp, "ident-state-"));
		const idA = getOrCreatePackRuntimeServerIdentity(stateDir);
		assert.ok(idA.length > 0);
		// A second read of the same state dir returns the SAME identity (persisted,
		// never re-randomized) — this is what a process restart does.
		const idB = getOrCreatePackRuntimeServerIdentity(stateDir);
		assert.equal(idB, idA, "identity is persisted, not re-randomized across reads/restarts");

		// Two supervisors built from that identity (as production does) produce the
		// SAME compose project name.
		const mk = (suffix: string) =>
			makeSupervisor(makeDocker({ ps: () => ok("") }).executor, { serverIdentitySuffix: suffix });
		assert.equal(
			mk(idA).composeProjectFor(PACK_ID),
			mk(idB).composeProjectFor(PACK_ID),
			"same persisted identity ⇒ identical compose project name",
		);

		// A DIFFERENT state dir (a co-resident second server) gets its own identity, so
		// the collision guard still holds across concurrent servers.
		const otherStateDir = fs.mkdtempSync(path.join(tmp, "ident-state2-"));
		const idOther = getOrCreatePackRuntimeServerIdentity(otherStateDir);
		assert.notEqual(idOther, idA, "a distinct server state dir gets a distinct identity");
	});
});

// ── Service-scoped commands across a multi-runtime pack ─────────────────────

describe("PackRuntimeSupervisor service scoping (multi-runtime pack)", () => {
	const MULTI_PACK = "multi";

	function makeMultiContribution(id: string, services: string[]): RuntimeContribution {
		const packRoot = path.join(tmp, "packs", MULTI_PACK);
		return {
			id,
			title: id,
			description: id,
			listName: id,
			sourceFile: path.join(packRoot, "runtimes", `${id}.yaml`),
			packRoot,
			manifest: {
				id,
				composeFile: "compose.yaml",
				modes: { default: { services } },
			},
		} as RuntimeContribution;
	}

	/** Registry with two runtimes (a/b) under ONE shared pack compose project. */
	function makeMultiRegistry(contribs: RuntimeContribution[]): PackContributionResolver {
		const pack = {
			packId: MULTI_PACK,
			packName: "Multi",
			packRoot: contribs[0]!.packRoot,
			panels: [],
			entrypoints: [],
			providers: [],
			runtimes: contribs,
		};
		const byId = new Map(contribs.map((c) => [c.id, c]));
		const resolver = {
			list: () => [pack],
			getPack: (_p: string | undefined, packId: string) => (packId === MULTI_PACK ? pack : undefined),
			getRuntime: (_p: string | undefined, packId: string, runtimeId: string) =>
				packId === MULTI_PACK ? byId.get(runtimeId) : undefined,
			getPanel: () => undefined,
			getEntrypoint: () => undefined,
			listProviders: () => [],
			hasRoute: () => false,
		};
		return resolver as unknown as PackContributionResolver;
	}

	function makeMultiSupervisor(executor: DockerExecutor): PackRuntimeSupervisor {
		const contribs = [
			makeMultiContribution("alpha", ["a1", "a2"]),
			makeMultiContribution("beta", ["b1", "b2"]),
		];
		return new PackRuntimeSupervisor({
			registry: makeMultiRegistry(contribs),
			executor,
			serverIdentitySuffix: "testsuffix",
			runtimeDataDir: path.join(tmp, "multi-data"),
			startupTimeoutMs: 50,
			pollIntervalMs: 20,
		});
	}

	const PROJECT = `bobbit-pack-${MULTI_PACK}-testsuffix`;
	const COMPOSE_ABS = path.join(tmp, "packs", MULTI_PACK, "runtimes", "compose.yaml");
	const envFileFor = (runtimeId: string) => path.join(tmp, "multi-data", PROJECT, `${runtimeId}.env`);

	it("stop scopes to the runtime's own services only", async () => {
		const docker = makeDocker({ stop: () => ok(), ps: () => ok("") });
		const sup = makeMultiSupervisor(docker.executor);
		await sup.stop(MULTI_PACK, "alpha");
		const stopCall = docker.calls.find((c) => c.args.includes("stop"))!;
		// READ-ONLY stop on a never-started runtime carries the project + compose file
		// but NO `--env-file` (none rendered yet) — like down/logs it never rebuilds a
		// full start invocation. Still scoped to alpha's own services.
		assert.deepEqual(stopCall.args, [
			"compose", "-p", PROJECT, "-f", COMPOSE_ABS, "stop", "a1", "a2",
		]);
		assert.ok(!stopCall.args.includes("--env-file"));
		// Sibling runtime's services are never passed.
		assert.ok(!stopCall.args.includes("b1"));
		assert.ok(!stopCall.args.includes("b2"));
	});

	it("status scopes `ps` to the runtime's own services only", async () => {
		const docker = makeDocker({ ps: () => ok("") });
		const sup = makeMultiSupervisor(docker.executor);
		await sup.status(MULTI_PACK, "beta");
		const psCall = docker.calls.find((c) => c.args.includes("ps"))!;
		// READ-ONLY status on a never-started runtime carries the project + compose
		// file but NO `--env-file` (none rendered yet) — it never renders an env file
		// just to inspect a dormant runtime. Still scoped to beta's own services.
		assert.deepEqual(psCall.args, [
			"compose", "-p", PROJECT, "-f", COMPOSE_ABS, "ps", "--format", "json", "b1", "b2",
		]);
		assert.ok(!psCall.args.includes("--env-file"));
		assert.ok(!psCall.args.includes("a1"));
		// Read-only status never wrote a rendered env file for beta.
		assert.equal(fs.existsSync(envFileFor("beta")), false);
	});

	it("logs scope to the runtime's own services only", async () => {
		const docker = makeDocker({ logs: () => ok("out") });
		const sup = makeMultiSupervisor(docker.executor);
		await sup.logs(MULTI_PACK, "alpha", { tail: 10 });
		const logCall = docker.calls.find((c) => c.args.includes("logs"))!;
		// READ-ONLY logs on a never-started runtime: NO `--env-file` (none rendered
		// yet), still scoped to alpha's own services.
		assert.deepEqual(logCall.args, [
			"compose", "-p", PROJECT, "-f", COMPOSE_ABS, "logs", "--tail", "10", "a1", "a2",
		]);
		assert.ok(!logCall.args.includes("--env-file"));
		assert.ok(!logCall.args.includes("b1"));
	});
});

// ── Invalid-manifest propagation (no whole-project fallback) ────────────────

describe("PackRuntimeSupervisor invalid-manifest handling", () => {
	const BAD_PACK = "badpack";

	/** A contribution whose carried manifest fails deep P1 validation. */
	function makeBadContribution(manifest: Record<string, unknown>): RuntimeContribution {
		const packRoot = path.join(tmp, "packs", BAD_PACK);
		return {
			id: "bad",
			title: "bad",
			description: "bad",
			listName: "bad",
			sourceFile: path.join(packRoot, "runtimes", "bad.yaml"),
			packRoot,
			manifest,
		} as RuntimeContribution;
	}

	function makeBadRegistry(contribution: RuntimeContribution): PackContributionResolver {
		const pack = {
			packId: BAD_PACK,
			packName: "Bad",
			packRoot: contribution.packRoot,
			panels: [],
			entrypoints: [],
			providers: [],
			runtimes: [contribution],
		};
		const resolver = {
			list: () => [pack],
			getPack: (_p: string | undefined, packId: string) => (packId === BAD_PACK ? pack : undefined),
			getRuntime: (_p: string | undefined, packId: string, runtimeId: string) =>
				packId === BAD_PACK && runtimeId === contribution.id ? contribution : undefined,
			getPanel: () => undefined,
			getEntrypoint: () => undefined,
			listProviders: () => [],
			hasRoute: () => false,
		};
		return resolver as unknown as PackContributionResolver;
	}

	function makeBadSupervisor(executor: DockerExecutor, manifest: Record<string, unknown>): PackRuntimeSupervisor {
		return new PackRuntimeSupervisor({
			registry: makeBadRegistry(makeBadContribution(manifest)),
			executor,
			serverIdentitySuffix: "testsuffix",
			runtimeDataDir: path.join(tmp, "bad-data"),
			startupTimeoutMs: 50,
			pollIntervalMs: 20,
		});
	}

	// composeFile escapes the pack root → deep validation rejects the manifest.
	const ESCAPING = { id: "bad", composeFile: "../../escape.yaml", modes: { default: { services: ["svc"] } } };

	it("status rejects an invalid manifest and never runs a compose command", async () => {
		const docker = makeDocker({ ps: () => ok("") });
		const sup = makeBadSupervisor(docker.executor, ESCAPING);
		await assert.rejects(() => sup.status(BAD_PACK, "bad"), PackRuntimeBadRequestError);
		assert.equal(docker.calls.length, 0);
	});

	it("list() isolates an invalid-manifest runtime as a structured stopped row (no throw)", async () => {
		// A single unusable runtime must not blank the whole boot listing: list()
		// catches the per-runtime failure and surfaces a `stopped` row carrying the
		// reason instead of throwing (finding #1).
		const docker = makeDocker({ ps: () => ok("") });
		const sup = makeBadSupervisor(docker.executor, ESCAPING);
		const all = await sup.list();
		assert.equal(all.length, 1);
		assert.equal(all[0]!.status, "stopped");
		assert.match(all[0]!.message ?? "", /escapes the pack root|invalid runtime manifest/);
		// The bad runtime never reached a Docker command.
		assert.equal(docker.countSub("ps"), 0);
	});

	it("stop rejects an invalid manifest and never runs an unscoped whole-project stop", async () => {
		const docker = makeDocker({ stop: () => ok(), ps: () => ok("") });
		const sup = makeBadSupervisor(docker.executor, ESCAPING);
		await assert.rejects(() => sup.stop(BAD_PACK, "bad"), PackRuntimeBadRequestError);
		assert.equal(docker.countSub("stop"), 0);
	});

	it("logs reject an invalid manifest and never run an unscoped whole-project logs", async () => {
		const docker = makeDocker({ logs: () => ok("") });
		const sup = makeBadSupervisor(docker.executor, ESCAPING);
		await assert.rejects(() => sup.logs(BAD_PACK, "bad"), PackRuntimeBadRequestError);
		assert.equal(docker.countSub("logs"), 0);
	});

	it("a VALID manifest with no declared services scopes stop to the whole project", async () => {
		// The empty-service (whole-project) form is reserved for a successfully
		// validated manifest that genuinely declares no services.
		const docker = makeDocker({ stop: () => ok(), ps: () => ok("") });
		const sup = makeBadSupervisor(docker.executor, {
			id: "bad",
			composeFile: "compose.yaml",
			modes: { default: {} },
		});
		await sup.stop(BAD_PACK, "bad");
		const stopCall = docker.calls.find((c) => c.args.includes("stop"))!;
		const project = `bobbit-pack-${BAD_PACK}-testsuffix`;
		const composeAbs = path.join(tmp, "packs", BAD_PACK, "runtimes", "compose.yaml");
		// READ-ONLY stop on a never-started runtime: compose file present, NO
		// `--env-file` (none rendered yet), and no trailing service args (the valid
		// manifest genuinely declares no services → whole-project scope).
		assert.deepEqual(stopCall.args, ["compose", "-p", project, "-f", composeAbs, "stop"]);
	});
});

// ── Production-safe resolver context (env refs resolve before Docker) ───────

describe("PackRuntimeSupervisor production resolver context", () => {
	function makeEnvContribution(): RuntimeContribution {
		const packRoot = path.join(tmp, "packs", "envpack");
		return {
			id: "svc",
			title: "svc",
			description: "svc",
			listName: "svc",
			sourceFile: path.join(packRoot, "runtimes", "svc.yaml"),
			packRoot,
			manifest: {
				id: "svc",
				composeFile: "compose.yaml",
				secrets: [{ key: "GEN_SECRET", generate: true }],
				ports: [{ key: "WEB_PORT", container: 8080 }],
				env: {
					GEN_SECRET: { generate: "GEN_SECRET" },
					WEB_PORT: { port: "WEB_PORT" },
					USER_KEY: { secret: "USER_KEY" },
				},
				modes: { default: { services: ["api"], requireEnv: ["USER_KEY"] } },
			},
		} as RuntimeContribution;
	}

	function makeEnvRegistry(contribution: RuntimeContribution): PackContributionResolver {
		const pack = {
			packId: "envpack",
			packName: "Env Pack",
			packRoot: contribution.packRoot,
			panels: [],
			entrypoints: [],
			providers: [],
			runtimes: [contribution],
		};
		const resolver = {
			list: () => [pack],
			getPack: (_p: string | undefined, packId: string) => (packId === "envpack" ? pack : undefined),
			getRuntime: (_p: string | undefined, packId: string, runtimeId: string) =>
				packId === "envpack" && runtimeId === "svc" ? contribution : undefined,
			getPanel: () => undefined,
			getEntrypoint: () => undefined,
			listProviders: () => [],
			hasRoute: () => false,
		};
		return resolver as unknown as PackContributionResolver;
	}

	function inMemorySecrets(seed: Record<string, string> = {}) {
		const data: Record<string, string> = { ...seed };
		return {
			get: (k: string) => data[k],
			set: (k: string, v: string) => { data[k] = v; },
			data,
		};
	}

	it("resolves generated + port + configured-secret env refs without throwing", async () => {
		const docker = makeDocker({
			up: () => ok(),
			ps: () => ok('{"Service":"api","State":"running","Health":"healthy"}'),
		});
		const contribution = makeEnvContribution();
		const secrets = inMemorySecrets({ USER_KEY: "configured-llm-key" });
		const portStore = new FilePortStore(path.join(tmp, "envpack-ports.json"));
		const sup = new PackRuntimeSupervisor({
			registry: makeEnvRegistry(contribution),
			executor: docker.executor,
			serverIdentitySuffix: "testsuffix",
			runtimeDataDir: path.join(tmp, "envpack-data"),
			startupTimeoutMs: 50,
			pollIntervalMs: 20,
			secretsStore: secrets,
			portStore,
		});

		const st = await sup.start("envpack", "svc");
		assert.equal(st.status, "running");

		// Generated secret was created+persisted under a pack/runtime-NAMESPACED key
		// (NOT the raw `GEN_SECRET`), guarding against cross-runtime collisions.
		const genKey = packRuntimePersistKey("envpack", "svc", "GEN_SECRET");
		assert.ok((secrets.data[genKey] ?? "").length > 0);
		assert.equal(secrets.data.GEN_SECRET, undefined); // raw key is never used for generated secrets
		// Port was allocated+persisted under the namespaced key too.
		const portKey = packRuntimePersistKey("envpack", "svc", "WEB_PORT");
		assert.ok(typeof portStore.get(portKey) === "number");
		assert.equal(portStore.get("WEB_PORT"), undefined);

		// Rendered env file carries the resolved values keyed by the RAW manifest
		// names (no unresolved refs).
		const project = "bobbit-pack-envpack-testsuffix";
		const envFile = path.join(tmp, "envpack-data", project, "svc.env");
		const body = fs.readFileSync(envFile, "utf-8");
		assert.match(body, /USER_KEY="configured-llm-key"/);
		assert.match(body, /GEN_SECRET="/);
		assert.match(body, new RegExp(`WEB_PORT="${portStore.get(portKey)}"`));
	});

	it("status/logs/stop after start reuse the persisted port (no churn while bound)", async () => {
		// A counting PortStore: proves read/control paths never re-allocate (call
		// `set`) once a port is persisted, even while the live port is un-bindable.
		class CountingPortStore {
			data: Record<string, number> = {};
			sets = 0;
			get(k: string) { return this.data[k]; }
			set(k: string, v: number) { this.data[k] = v; this.sets++; }
		}
		const docker = makeDocker({
			up: () => ok(),
			ps: () => ok('{"Service":"api","State":"running","Health":"healthy"}'),
			stop: () => ok(),
			logs: () => ok("out"),
		});
		const contribution = makeEnvContribution();
		const secrets = inMemorySecrets({ USER_KEY: "configured-llm-key" });
		const portStore = new CountingPortStore();
		const sup = new PackRuntimeSupervisor({
			registry: makeEnvRegistry(contribution),
			executor: docker.executor,
			serverIdentitySuffix: "testsuffix",
			runtimeDataDir: path.join(tmp, "churn-data"),
			startupTimeoutMs: 50,
			pollIntervalMs: 20,
			secretsStore: secrets,
			portStore,
		});

		const st = await sup.start("envpack", "svc");
		assert.equal(st.status, "running");
		const portKey = packRuntimePersistKey("envpack", "svc", "WEB_PORT");
		const allocatedPort = portStore.get(portKey);
		assert.equal(typeof allocatedPort, "number");
		const setsAfterStart = portStore.sets;
		assert.equal(setsAfterStart, 1);

		// Occupy the allocated port so it is NOT currently bindable, exactly as a
		// running container would. The buggy revalidating allocation would now rotate
		// the persisted port on every status/logs/stop call.
		const blocker = net.createServer();
		await new Promise<void>((res, rej) => {
			blocker.once("error", rej);
			blocker.listen(allocatedPort, "127.0.0.1", res);
		});
		try {
			await sup.status("envpack", "svc");
			await sup.logs("envpack", "svc", { tail: 5 });
			await sup.stop("envpack", "svc");
		} finally {
			await new Promise<void>((res) => blocker.close(() => res()));
		}

		// Persisted port never rotated and no replacement allocation happened.
		assert.equal(portStore.get(portKey), allocatedPort);
		assert.equal(portStore.sets, setsAfterStart);

		// The re-rendered env file still carries the SAME resolved port/secret values.
		const project = "bobbit-pack-envpack-testsuffix";
		const envFile = path.join(tmp, "churn-data", project, "svc.env");
		const body = fs.readFileSync(envFile, "utf-8");
		assert.match(body, new RegExp(`WEB_PORT="${allocatedPort}"`));
		assert.match(body, /USER_KEY="configured-llm-key"/);
	});

	it("repeated start of an already-running runtime is idempotent — no second `up`, no port re-allocation", async () => {
		// Finding: a repeat REST `/start` while the runtime is RUNNING must NOT rebuild
		// the invocation, `compose up` again, or rotate the (now container-bound) host
		// port. `allocateHostPort` would see the bound port as unavailable and probe a
		// NEW one, orphaning the live mapping — so the second start must fast-path.
		class CountingPortStore {
			data: Record<string, number> = {};
			sets = 0;
			get(k: string) { return this.data[k]; }
			set(k: string, v: number) { this.data[k] = v; this.sets++; }
		}
		let started = false;
		const docker = makeDocker({
			up: () => { started = true; return ok(); },
			ps: () => ok(started ? '{"Service":"api","State":"running","Health":"healthy"}' : ""),
		});
		const contribution = makeEnvContribution();
		const portStore = new CountingPortStore();
		const sup = new PackRuntimeSupervisor({
			registry: makeEnvRegistry(contribution),
			executor: docker.executor,
			serverIdentitySuffix: "testsuffix",
			runtimeDataDir: path.join(tmp, "idempotent-start-data"),
			startupTimeoutMs: 50,
			pollIntervalMs: 20,
			secretsStore: inMemorySecrets({ USER_KEY: "configured-llm-key" }),
			portStore,
		});

		const first = await sup.start("envpack", "svc");
		assert.equal(first.status, "running");
		assert.equal(docker.countSub("up"), 1, "first start issues exactly one compose up");
		assert.equal(portStore.sets, 1, "first start allocates the host port once");
		const portKey = packRuntimePersistKey("envpack", "svc", "WEB_PORT");
		const allocatedPort = portStore.get(portKey)!;

		// Bind the allocated port so it is NOT currently bindable — exactly as a live
		// container holds it. A non-idempotent start would now rotate the port.
		const blocker = net.createServer();
		await new Promise<void>((res, rej) => {
			blocker.once("error", rej);
			blocker.listen(allocatedPort, "127.0.0.1", res);
		});
		try {
			const second = await sup.start("envpack", "svc");
			assert.equal(second.status, "running");
		} finally {
			await new Promise<void>((res) => blocker.close(() => res()));
		}

		// Idempotent: no second `up`, and the persisted port was neither rotated nor re-set.
		assert.equal(docker.countSub("up"), 1, "repeat start must not compose up again");
		assert.equal(portStore.sets, 1, "repeat start must not re-allocate the host port");
		assert.equal(portStore.get(portKey), allocatedPort, "persisted port unchanged");
	});

	it("a missing required user secret rejects as PackRuntimeBadRequestError (→ 400, not 500)", async () => {
		const docker = makeDocker({ up: () => ok(), ps: () => ok("") });
		const contribution = makeEnvContribution();
		const sup = new PackRuntimeSupervisor({
			registry: makeEnvRegistry(contribution),
			executor: docker.executor,
			serverIdentitySuffix: "testsuffix",
			runtimeDataDir: path.join(tmp, "envpack-data2"),
			secretsStore: inMemorySecrets(), // USER_KEY absent
			portStore: new FilePortStore(path.join(tmp, "envpack-ports2.json")),
		});
		// buildRuntimeInvocation's unmet-requireEnv error is a CONFIG/user fault — the
		// supervisor must wrap it as PackRuntimeBadRequestError so REST answers 400,
		// not a misleading 500. The original message (mentioning the key) is preserved.
		await assert.rejects(
			() => sup.start("envpack", "svc"),
			(err: unknown) => err instanceof PackRuntimeBadRequestError && /USER_KEY/.test((err as Error).message),
		);
		assert.equal(docker.countSub("up"), 0);
	});

	it("status() for an unstarted runtime needs NO deployment secrets and never mutates state (finding #1)", async () => {
		// `ps` returns empty (nothing running). The runtime's manifest declares a
		// REQUIRED user secret (USER_KEY) + a generated secret + an allocated port —
		// none of which are configured. A read-only status must NOT try to resolve
		// them (which would 400), render an env file, or allocate/persist a port.
		const docker = makeDocker({ ps: () => ok("") });
		const contribution = makeEnvContribution();
		const secrets = inMemorySecrets(); // USER_KEY absent ⇒ a start would 400
		const portStore = new FilePortStore(path.join(tmp, "ro-status-ports.json"));
		const sup = new PackRuntimeSupervisor({
			registry: makeEnvRegistry(contribution),
			executor: docker.executor,
			serverIdentitySuffix: "testsuffix",
			runtimeDataDir: path.join(tmp, "ro-status-data"),
			secretsStore: secrets,
			portStore,
		});

		const st = await sup.status("envpack", "svc");
		assert.equal(st.status, "stopped"); // structured status, no throw

		// No mutation: no rendered env file, no allocated/persisted port, no generated secret.
		const project = "bobbit-pack-envpack-testsuffix";
		const envFile = path.join(tmp, "ro-status-data", project, "svc.env");
		assert.equal(fs.existsSync(envFile), false, "status must not render an env file");
		assert.equal(portStore.get(packRuntimePersistKey("envpack", "svc", "WEB_PORT")), undefined, "status must not allocate a port");
		assert.equal(secrets.data[packRuntimePersistKey("envpack", "svc", "GEN_SECRET")], undefined, "status must not generate a secret");

		// `ps` carried the project + compose file but NO --env-file (none rendered).
		const psCall = docker.calls.find((c) => c.args.includes("ps"))!;
		assert.ok(!psCall.args.includes("--env-file"));

		// list() over the same registry is equally read-only and secret-free.
		const all = await sup.list();
		assert.equal(all.length, 1);
		assert.equal(all[0]!.status, "stopped");
		assert.equal(fs.existsSync(envFile), false);
	});

	it("status() reuses a rendered env file once a start has produced one (finding #1)", async () => {
		// After a real start renders the env file, read-only status PREFERS it so
		// compose interpolation is accurate — it still never re-renders or rotates ports.
		const docker = makeDocker({
			up: () => ok(),
			ps: () => ok('{"Service":"api","State":"running","Health":"healthy"}'),
		});
		const contribution = makeEnvContribution();
		const portStore = new FilePortStore(path.join(tmp, "ro-reuse-ports.json"));
		const sup = new PackRuntimeSupervisor({
			registry: makeEnvRegistry(contribution),
			executor: docker.executor,
			serverIdentitySuffix: "testsuffix",
			runtimeDataDir: path.join(tmp, "ro-reuse-data"),
			startupTimeoutMs: 50,
			pollIntervalMs: 20,
			secretsStore: inMemorySecrets({ USER_KEY: "k" }),
			portStore,
		});
		await sup.start("envpack", "svc");
		const project = "bobbit-pack-envpack-testsuffix";
		const envFile = path.join(tmp, "ro-reuse-data", project, "svc.env");
		assert.ok(fs.existsSync(envFile));

		docker.calls.length = 0;
		await sup.status("envpack", "svc");
		const psCall = docker.calls.find((c) => c.args.includes("ps"))!;
		// Now that an env file exists, status reuses it via --env-file.
		assert.ok(psCall.args.includes("--env-file"));
		assert.ok(psCall.args.includes(envFile));
	});

	it("control paths reuse the start config overlay so config-only secrets re-resolve (finding #2)", async () => {
		const docker = makeDocker({
			up: () => ok(),
			ps: () => ok('{"Service":"api","State":"running","Health":"healthy"}'),
			stop: () => ok(),
			logs: () => ok("out"),
			down: () => ok(),
		});
		const contribution = makeEnvContribution();
		// USER_KEY is NOT in the global secret store — it is supplied ONLY via the
		// start config overlay (mirrors the marketplace managed-enable path forwarding
		// a config-only secret). `requireEnv` makes it mandatory, so WITHOUT a persisted
		// overlay every later control/teardown command would re-throw
		// PackRuntimeBadRequestError when it rebuilds the compose env.
		const secrets = inMemorySecrets();
		const portStore = new FilePortStore(path.join(tmp, "overlay-ports.json"));
		const sup = new PackRuntimeSupervisor({
			registry: makeEnvRegistry(contribution),
			executor: docker.executor,
			serverIdentitySuffix: "testsuffix",
			runtimeDataDir: path.join(tmp, "overlay-data"),
			startupTimeoutMs: 50,
			pollIntervalMs: 20,
			secretsStore: secrets,
			portStore,
		});

		const started = await sup.start("envpack", "svc", { config: { USER_KEY: "from-config" } });
		assert.equal(started.status, "running");

		// The effective mode + config overlay are persisted beside the rendered env.
		const project = "bobbit-pack-envpack-testsuffix";
		const cfgFile = path.join(tmp, "overlay-data", project, "svc.config.json");
		assert.ok(fs.existsSync(cfgFile));
		assert.deepEqual(JSON.parse(fs.readFileSync(cfgFile, "utf-8")), {
			mode: "default",
			config: { USER_KEY: "from-config" },
		});

		// Control + teardown must NOT throw: the persisted overlay re-resolves the
		// config-only USER_KEY secret on every rebuild.
		await sup.status("envpack", "svc");
		await sup.logs("envpack", "svc", { tail: 5 });
		await sup.stop("envpack", "svc");
		const downStatus = await sup.down("envpack", "svc");
		assert.equal(downStatus.status, "stopped");

		// The re-rendered env file still carries the config-supplied secret.
		const envFile = path.join(tmp, "overlay-data", project, "svc.env");
		assert.match(fs.readFileSync(envFile, "utf-8"), /USER_KEY="from-config"/);
	});

	it("purge (down -v + removeState) deletes the persisted config sidecar (finding #2)", async () => {
		const docker = makeDocker({
			up: () => ok(),
			ps: () => ok('{"Service":"api","State":"running","Health":"healthy"}'),
			down: () => ok(),
		});
		const contribution = makeEnvContribution();
		const portStore = new FilePortStore(path.join(tmp, "purge-cfg-ports.json"));
		const sup = new PackRuntimeSupervisor({
			registry: makeEnvRegistry(contribution),
			executor: docker.executor,
			serverIdentitySuffix: "testsuffix",
			runtimeDataDir: path.join(tmp, "purge-cfg-data"),
			startupTimeoutMs: 50,
			pollIntervalMs: 20,
			secretsStore: inMemorySecrets(),
			portStore,
		});
		await sup.start("envpack", "svc", { config: { USER_KEY: "from-config" } });
		const project = "bobbit-pack-envpack-testsuffix";
		const cfgFile = path.join(tmp, "purge-cfg-data", project, "svc.config.json");
		assert.ok(fs.existsSync(cfgFile));
		await sup.down("envpack", "svc", { volumes: true, removeState: true });
		assert.equal(fs.existsSync(cfgFile), false);
	});
});

// ── Start in-flight dedupe keyed by mode ─────────────────────────────────────

describe("PackRuntimeSupervisor start mode dedupe", () => {
	const MM_PACK = "mm";

	/** A runtime with two modes that issue DISTINCT compose profiles. */
	function makeMmContribution(): RuntimeContribution {
		const packRoot = path.join(tmp, "packs", MM_PACK);
		return {
			id: "svc",
			title: "svc",
			description: "svc",
			listName: "svc",
			sourceFile: path.join(packRoot, "runtimes", "svc.yaml"),
			packRoot,
			manifest: {
				id: "svc",
				composeFile: "compose.yaml",
				modes: {
					default: { services: ["db"], profiles: ["managed"] },
					alt: { services: ["db"], profiles: ["external"] },
				},
			},
		} as RuntimeContribution;
	}

	function makeMmRegistry(contribution: RuntimeContribution): PackContributionResolver {
		const pack = {
			packId: MM_PACK,
			packName: "Multi Mode",
			packRoot: contribution.packRoot,
			panels: [],
			entrypoints: [],
			providers: [],
			runtimes: [contribution],
		};
		const resolver = {
			list: () => [pack],
			getPack: (_p: string | undefined, packId: string) => (packId === MM_PACK ? pack : undefined),
			getRuntime: (_p: string | undefined, packId: string, runtimeId: string) =>
				packId === MM_PACK && runtimeId === contribution.id ? contribution : undefined,
			getPanel: () => undefined,
			getEntrypoint: () => undefined,
			listProviders: () => [],
			hasRoute: () => false,
		};
		return resolver as unknown as PackContributionResolver;
	}

	function makeMmSupervisor(executor: DockerExecutor): PackRuntimeSupervisor {
		return new PackRuntimeSupervisor({
			registry: makeMmRegistry(makeMmContribution()),
			executor,
			serverIdentitySuffix: "testsuffix",
			runtimeDataDir: path.join(tmp, "mm-data"),
			startupTimeoutMs: 50,
			pollIntervalMs: 20,
		});
	}

	it("concurrent explicit starts with CONFLICTING modes reject the second (one up, no env-file race)", async () => {
		// A runtime identity owns ONE rendered env file + ONE compose project, so two
		// concurrent starts in DIFFERENT modes would race — both render the same env
		// file and `compose up` the same project. The supervisor serializes at runtime
		// identity: the first mode wins, the conflicting concurrent mode is rejected.
		const docker = makeDocker({
			up: () => ok(),
			ps: () => ok('{"Service":"db","State":"running","Health":"healthy"}'),
		});
		const sup = makeMmSupervisor(docker.executor);
		const [a, b] = await Promise.allSettled([
			sup.start(MM_PACK, "svc", { mode: "default" }),
			sup.start(MM_PACK, "svc", { mode: "alt" }),
		]);
		// Exactly one start succeeds (the first to claim the in-flight slot); the other
		// is rejected with a deterministic bad-request rather than racing the env file.
		const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
		const rejected = [a, b].filter((r) => r.status === "rejected");
		assert.equal(fulfilled.length, 1);
		assert.equal(rejected.length, 1);
		assert.equal((fulfilled[0] as PromiseFulfilledResult<{ status: string }>).value.status, "running");
		assert.ok(
			(rejected[0] as PromiseRejectedResult).reason instanceof PackRuntimeBadRequestError,
			"conflicting concurrent mode rejects with PackRuntimeBadRequestError",
		);
		// Only ONE `compose up` runs — the rejected start never reached `_doStart`.
		assert.equal(docker.countSub("up"), 1);
	});

	it("sequential starts in different modes each run (no false in-flight conflict)", async () => {
		const docker = makeDocker({
			up: () => ok(),
			ps: () => ok('{"Service":"db","State":"running","Health":"healthy"}'),
		});
		const sup = makeMmSupervisor(docker.executor);
		// Await each — the in-flight slot clears on settle, so a later different-mode
		// start is NOT a conflict. (A repeat-same-mode start of an already-running
		// runtime fast-paths, so we use distinct modes to force a second `up`.)
		const first = await sup.start(MM_PACK, "svc", { mode: "default" });
		await sup.stop(MM_PACK, "svc");
		const second = await sup.start(MM_PACK, "svc", { mode: "alt" });
		assert.equal(first.mode, "default");
		assert.equal(second.mode, "alt");
		assert.equal(docker.countSub("up"), 2);
	});

	it("concurrent explicit starts with the SAME mode still dedupe to one up", async () => {
		let started = false;
		const docker = makeDocker({
			up: () => { started = true; return ok(); },
			ps: () => ok(started ? '{"Service":"db","State":"running","Health":"healthy"}' : ""),
		});
		const sup = makeMmSupervisor(docker.executor);
		const [a, b] = await Promise.all([
			sup.start(MM_PACK, "svc", { mode: "alt" }),
			sup.start(MM_PACK, "svc", { mode: "alt" }),
		]);
		assert.equal(a.status, "running");
		assert.equal(b.status, "running");
		assert.equal(docker.countSub("up"), 1);
	});
});

// ── Cross-runtime persistence isolation (namespaced generated secrets + ports) ─

describe("PackRuntimeSupervisor cross-runtime persistence isolation", () => {
	const ISO_PACK = "iso";

	/** Two runtimes under ONE pack that both declare the SAME raw keys. */
	function makeIsoContribution(id: string): RuntimeContribution {
		const packRoot = path.join(tmp, "packs", ISO_PACK);
		return {
			id,
			title: id,
			description: id,
			listName: id,
			sourceFile: path.join(packRoot, "runtimes", `${id}.yaml`),
			packRoot,
			manifest: {
				id,
				composeFile: "compose.yaml",
				secrets: [{ key: "DB_PASSWORD", generate: true }],
				ports: [{ key: "WEB_PORT", container: 8080 }],
				env: { DB_PASSWORD: { generate: "DB_PASSWORD" }, WEB_PORT: { port: "WEB_PORT" } },
				modes: { default: { services: [id] } },
			},
		} as RuntimeContribution;
	}

	function makeIsoRegistry(contribs: RuntimeContribution[]): PackContributionResolver {
		const pack = {
			packId: ISO_PACK,
			packName: "Iso",
			packRoot: contribs[0]!.packRoot,
			panels: [],
			entrypoints: [],
			providers: [],
			runtimes: contribs,
		};
		const byId = new Map(contribs.map((c) => [c.id, c]));
		const resolver = {
			list: () => [pack],
			getPack: (_p: string | undefined, packId: string) => (packId === ISO_PACK ? pack : undefined),
			getRuntime: (_p: string | undefined, packId: string, runtimeId: string) =>
				packId === ISO_PACK ? byId.get(runtimeId) : undefined,
			getPanel: () => undefined,
			getEntrypoint: () => undefined,
			listProviders: () => [],
			hasRoute: () => false,
		};
		return resolver as unknown as PackContributionResolver;
	}

	function inMemorySecrets(seed: Record<string, string> = {}) {
		const data: Record<string, string> = { ...seed };
		return { get: (k: string) => data[k], set: (k: string, v: string) => { data[k] = v; }, data };
	}

	it("namespaces generated secrets + ports so two same-key runtimes never collide", async () => {
		const docker = makeDocker({
			up: () => ok(),
			ps: () => ok('{"Service":"x","State":"running","Health":"healthy"}'),
		});
		const secrets = inMemorySecrets();
		const portStore = new FilePortStore(path.join(tmp, "iso-ports.json"));
		const sup = new PackRuntimeSupervisor({
			registry: makeIsoRegistry([makeIsoContribution("alpha"), makeIsoContribution("beta")]),
			executor: docker.executor,
			serverIdentitySuffix: "testsuffix",
			runtimeDataDir: path.join(tmp, "iso-data"),
			startupTimeoutMs: 50,
			pollIntervalMs: 20,
			secretsStore: secrets,
			portStore,
		});

		await sup.start(ISO_PACK, "alpha");
		await sup.start(ISO_PACK, "beta");

		const aPwd = packRuntimePersistKey(ISO_PACK, "alpha", "DB_PASSWORD");
		const bPwd = packRuntimePersistKey(ISO_PACK, "beta", "DB_PASSWORD");
		const aPort = packRuntimePersistKey(ISO_PACK, "alpha", "WEB_PORT");
		const bPort = packRuntimePersistKey(ISO_PACK, "beta", "WEB_PORT");

		// Distinct namespaced store slots — the raw shared key is NEVER written, so
		// beta's start cannot overwrite alpha's persisted secret/port (and vice versa).
		assert.notEqual(aPwd, bPwd);
		assert.equal(secrets.data.DB_PASSWORD, undefined);
		assert.ok((secrets.data[aPwd] ?? "").length > 0);
		assert.ok((secrets.data[bPwd] ?? "").length > 0);
		// Independent generated values (not a single shared secret).
		assert.notEqual(secrets.data[aPwd], secrets.data[bPwd]);

		assert.equal(portStore.get("WEB_PORT"), undefined);
		assert.equal(typeof portStore.get(aPort), "number");
		assert.equal(typeof portStore.get(bPort), "number");
	});

	it("keeps USER-CONFIGURED secrets on their RAW (shared) key across runtimes", async () => {
		// A runtime that references a user-configured `secret:` reads it by the RAW
		// key (intentionally global) — namespacing only applies to GENERATED secrets.
		const packRoot = path.join(tmp, "packs", "isouser");
		const contribution = {
			id: "svc",
			title: "svc",
			description: "svc",
			listName: "svc",
			sourceFile: path.join(packRoot, "runtimes", "svc.yaml"),
			packRoot,
			manifest: {
				id: "svc",
				composeFile: "compose.yaml",
				env: { SHARED_KEY: { secret: "SHARED_KEY" } },
				modes: { default: { services: ["svc"], requireEnv: ["SHARED_KEY"] } },
			},
		} as RuntimeContribution;
		const pack = {
			packId: "isouser",
			packName: "IsoUser",
			packRoot,
			panels: [],
			entrypoints: [],
			providers: [],
			runtimes: [contribution],
		};
		const registry = {
			list: () => [pack],
			getPack: (_p: string | undefined, packId: string) => (packId === "isouser" ? pack : undefined),
			getRuntime: (_p: string | undefined, packId: string, runtimeId: string) =>
				packId === "isouser" && runtimeId === "svc" ? contribution : undefined,
			getPanel: () => undefined,
			getEntrypoint: () => undefined,
			listProviders: () => [],
			hasRoute: () => false,
		} as unknown as PackContributionResolver;

		const docker = makeDocker({
			up: () => ok(),
			ps: () => ok('{"Service":"svc","State":"running","Health":"healthy"}'),
		});
		const secrets = inMemorySecrets({ SHARED_KEY: "global-value" }); // raw key seeded
		const sup = new PackRuntimeSupervisor({
			registry,
			executor: docker.executor,
			serverIdentitySuffix: "testsuffix",
			runtimeDataDir: path.join(tmp, "isouser-data"),
			startupTimeoutMs: 50,
			pollIntervalMs: 20,
			secretsStore: secrets,
			portStore: new FilePortStore(path.join(tmp, "isouser-ports.json")),
		});

		const st = await sup.start("isouser", "svc");
		assert.equal(st.status, "running");
		// Resolved from the RAW key (no namespaced lookup for user secrets).
		const envFile = path.join(tmp, "isouser-data", "bobbit-pack-isouser-testsuffix", "svc.env");
		assert.match(fs.readFileSync(envFile, "utf-8"), /SHARED_KEY="global-value"/);
	});
});

// ── readRuntimeStartPolicy (pure) ────────────────────────────────────────────

describe("readRuntimeStartPolicy", () => {
	it("only the literal 'on-enable' opts a runtime into auto-start; everything else is manual", () => {
		assert.equal(readRuntimeStartPolicy({ startPolicy: "on-enable" }), "on-enable");
		assert.equal(readRuntimeStartPolicy({ startPolicy: "manual" }), "manual");
		assert.equal(readRuntimeStartPolicy({}), "manual", "absent policy defaults to manual");
		assert.equal(readRuntimeStartPolicy(undefined), "manual");
		// Defensive: a non-literal/garbage value never silently enables auto-start.
		assert.equal(readRuntimeStartPolicy({ startPolicy: "On-Enable" }), "manual");
		assert.equal(readRuntimeStartPolicy({ startPolicy: true as unknown as string }), "manual");
	});
});

// ── down() — uninstall vs explicit purge (P3) ────────────────────────────────
//
// `down` is the uninstall/purge primitive. Pins the design invariants:
//   - uninstall  → `docker compose down` (NO `-v`): containers/networks removed,
//     bind-mounted data SURVIVES, supervisor-owned local state is preserved.
//   - purge      → `docker compose down -v` + removeState: Docker volumes AND the
//     rendered env / persisted generated-secret / allocated-port bookkeeping go.
//   - ENOENT     → docker-unavailable (never throws), and the requested local
//     state removal still runs (host-FS bookkeeping is meaningful Docker-less).

describe("PackRuntimeSupervisor.down (uninstall vs purge)", () => {
	function inMemorySecrets(seed: Record<string, string> = {}) {
		const data: Record<string, string> = { ...seed };
		const removed: string[] = [];
		return {
			get: (k: string) => data[k],
			set: (k: string, v: string) => { data[k] = v; },
			remove: (k: string) => { delete data[k]; removed.push(k); },
			data,
			removed,
		};
	}

	/** A runtime that declares a generated secret + a port so state-removal has
	 *  something namespaced to delete. */
	function makeStateContribution(): RuntimeContribution {
		const packRoot = path.join(tmp, "packs", "downpack");
		return {
			id: "svc",
			title: "svc",
			description: "svc",
			listName: "svc",
			sourceFile: path.join(packRoot, "runtimes", "svc.yaml"),
			packRoot,
			manifest: {
				id: "svc",
				composeFile: "compose.yaml",
				secrets: [{ key: "GEN_SECRET", generate: true }],
				ports: [{ key: "WEB_PORT", container: 8080 }],
				env: { GEN_SECRET: { generate: "GEN_SECRET" }, WEB_PORT: { port: "WEB_PORT" } },
				modes: { default: { services: ["api"] } },
			},
		} as RuntimeContribution;
	}

	function makeDownRegistry(contribution: RuntimeContribution): PackContributionResolver {
		const pack = {
			packId: "downpack",
			packName: "Down Pack",
			packRoot: contribution.packRoot,
			panels: [],
			entrypoints: [],
			providers: [],
			runtimes: [contribution],
		};
		const resolver = {
			list: () => [pack],
			getPack: (_p: string | undefined, packId: string) => (packId === "downpack" ? pack : undefined),
			getRuntime: (_p: string | undefined, packId: string, runtimeId: string) =>
				packId === "downpack" && runtimeId === "svc" ? contribution : undefined,
			getPanel: () => undefined,
			getEntrypoint: () => undefined,
			listProviders: () => [],
			hasRoute: () => false,
		};
		return resolver as unknown as PackContributionResolver;
	}

	function makeDownSupervisor(executor: DockerExecutor, secrets: ReturnType<typeof inMemorySecrets>, portStore: FilePortStore) {
		return new PackRuntimeSupervisor({
			registry: makeDownRegistry(makeStateContribution()),
			executor,
			serverIdentitySuffix: "testsuffix",
			runtimeDataDir: path.join(tmp, "down-data"),
			startupTimeoutMs: 50,
			pollIntervalMs: 20,
			secretsStore: secrets,
			portStore,
		});
	}

	const PROJECT = "bobbit-pack-downpack-testsuffix";
	const COMPOSE_ABS = path.join(tmp, "packs", "downpack", "runtimes", "compose.yaml");
	const ENV_FILE = path.join(tmp, "down-data", PROJECT, "svc.env");

	it("uninstall: `compose down` WITHOUT -v, reports stopped, preserves local state", async () => {
		const docker = makeDocker({ up: () => ok(), ps: () => ok(""), down: () => ok() });
		const secrets = inMemorySecrets();
		const portStore = new FilePortStore(path.join(tmp, "down-ports.json"));
		const sup = makeDownSupervisor(docker.executor, secrets, portStore);

		// Start once so the env file + namespaced secret/port are persisted.
		await sup.start("downpack", "svc");
		const genKey = packRuntimePersistKey("downpack", "svc", "GEN_SECRET");
		const portKey = packRuntimePersistKey("downpack", "svc", "WEB_PORT");
		assert.ok(fs.existsSync(ENV_FILE));
		assert.ok((secrets.data[genKey] ?? "").length > 0);
		assert.equal(typeof portStore.get(portKey), "number");

		const st = await sup.down("downpack", "svc");
		assert.equal(st.status, "stopped");
		assert.equal(st.composeProject, PROJECT);

		const downCall = docker.calls.find((c) => c.args.includes("down"))!;
		// Carries the compose file/env file; NO `-v` (bind data must survive).
		assert.deepEqual(downCall.args, [...composeBase(PROJECT, COMPOSE_ABS, ENV_FILE), "down"]);
		assert.ok(!downCall.args.includes("-v"), "uninstall down must never pass -v");

		// Local supervisor-owned state preserved on a non-purge down.
		assert.ok(fs.existsSync(ENV_FILE), "rendered env file preserved on uninstall");
		assert.ok((secrets.data[genKey] ?? "").length > 0, "generated secret preserved on uninstall");
		assert.equal(typeof portStore.get(portKey), "number", "allocated port preserved on uninstall");
		assert.deepEqual(secrets.removed, [], "no secret removal on uninstall");
	});

	it("purge: `compose down -v` AND removes the rendered env + persisted secret/port", async () => {
		const docker = makeDocker({ up: () => ok(), ps: () => ok(""), down: () => ok() });
		const secrets = inMemorySecrets();
		const portStore = new FilePortStore(path.join(tmp, "purge-ports.json"));
		const sup = makeDownSupervisor(docker.executor, secrets, portStore);

		await sup.start("downpack", "svc");
		const genKey = packRuntimePersistKey("downpack", "svc", "GEN_SECRET");
		const portKey = packRuntimePersistKey("downpack", "svc", "WEB_PORT");
		assert.ok(fs.existsSync(ENV_FILE));
		assert.ok((secrets.data[genKey] ?? "").length > 0);
		assert.equal(typeof portStore.get(portKey), "number");

		const st = await sup.down("downpack", "svc", { volumes: true, removeState: true });
		assert.equal(st.status, "stopped");

		const downCall = docker.calls.find((c) => c.args.includes("down"))!;
		// `down -v` for the explicit purge.
		assert.deepEqual(downCall.args, [...composeBase(PROJECT, COMPOSE_ABS, ENV_FILE), "down", "-v"]);

		// Supervisor-owned local state removed: env file gone, namespaced secret + port dropped.
		assert.ok(!fs.existsSync(ENV_FILE), "rendered env file removed on purge");
		assert.equal(secrets.data[genKey], undefined, "generated secret removed on purge");
		assert.ok(secrets.removed.includes(genKey), "secret store remove() called for the namespaced key");
		assert.equal(portStore.get(portKey), undefined, "allocated port removed on purge");
	});

	it("down ENOENT → docker-unavailable (no throw); removeState still runs", async () => {
		const enoent = () => { const e = new Error("spawn docker ENOENT") as Error & { code: string }; e.code = "ENOENT"; throw e; };
		// up/ps succeed so a prior start persists state; only `down` hits ENOENT.
		const docker = makeDocker({ up: () => ok(), ps: () => ok(""), down: enoent });
		const secrets = inMemorySecrets();
		const portStore = new FilePortStore(path.join(tmp, "down-enoent-ports.json"));
		const sup = makeDownSupervisor(docker.executor, secrets, portStore);

		await sup.start("downpack", "svc");
		const genKey = packRuntimePersistKey("downpack", "svc", "GEN_SECRET");
		assert.ok((secrets.data[genKey] ?? "").length > 0);

		const st = await sup.down("downpack", "svc", { volumes: true, removeState: true });
		assert.equal(st.status, "docker-unavailable");
		assert.equal(st.composeProject, PROJECT);
		// Even with Docker missing, the host-FS state removal proceeds.
		assert.ok(!fs.existsSync(ENV_FILE), "env file removed despite docker-unavailable");
		assert.equal(secrets.data[genKey], undefined, "namespaced secret removed despite docker-unavailable");
	});

	it("unknown runtime → PackRuntimeNotFoundError", async () => {
		const docker = makeDocker({ down: () => ok() });
		const sup = makeDownSupervisor(docker.executor, inMemorySecrets(), new FilePortStore(path.join(tmp, "down-nf-ports.json")));
		await assert.rejects(() => sup.down("downpack", "nope"), PackRuntimeNotFoundError);
		assert.equal(docker.countSub("down"), 0);
	});
});

// ── down without start-only secrets / sidecar (managed teardown) ─────────────
//
// Teardown must NEVER rebuild a full start invocation. A managed runtime whose
// config supplies the LLM key only as a START-time `secret:` env ref (NOT in the
// global secret store), or one that was never started (no rendered env file / no
// persisted config sidecar), must still tear down: `down` addresses the compose
// project read-only and runs `compose down`/`down -v` regardless.

describe("PackRuntimeSupervisor.down without start-only secrets/sidecar", () => {
	// A managed-only runtime whose base env REQUIRES a user-configured secret
	// (HINDSIGHT_API_LLM_API_KEY) — exactly the shape that makes a full start
	// invocation throw when the secret is absent.
	function makeSecretRequiringContribution(): RuntimeContribution {
		const packRoot = path.join(tmp, "packs", "secretpack");
		return {
			id: "svc",
			title: "svc",
			description: "svc",
			listName: "svc",
			sourceFile: path.join(packRoot, "runtimes", "svc.yaml"),
			packRoot,
			manifest: {
				id: "svc",
				composeFile: "compose.yaml",
				env: { LLM_KEY: { secret: "LLM_KEY" } },
				modes: { "managed-postgres": { services: ["api", "db"] } },
			},
		} as RuntimeContribution;
	}

	function makeSecretRegistry(contribution: RuntimeContribution): PackContributionResolver {
		const pack = {
			packId: "secretpack",
			packName: "Secret Pack",
			packRoot: contribution.packRoot,
			panels: [],
			entrypoints: [],
			providers: [],
			runtimes: [contribution],
		};
		const resolver = {
			list: () => [pack],
			getPack: (_p: string | undefined, packId: string) => (packId === "secretpack" ? pack : undefined),
			getRuntime: (_p: string | undefined, packId: string, runtimeId: string) =>
				packId === "secretpack" && runtimeId === "svc" ? contribution : undefined,
			getPanel: () => undefined,
			getEntrypoint: () => undefined,
			listProviders: () => [],
			hasRoute: () => false,
		};
		return resolver as unknown as PackContributionResolver;
	}

	function makeSecretSupervisor(executor: DockerExecutor) {
		return new PackRuntimeSupervisor({
			registry: makeSecretRegistry(makeSecretRequiringContribution()),
			executor,
			serverIdentitySuffix: "testsuffix",
			runtimeDataDir: path.join(tmp, "secret-data"),
			startupTimeoutMs: 50,
			pollIntervalMs: 20,
			// NO secretsStore seeded with LLM_KEY — a full start invocation would throw.
			portStore: new FilePortStore(path.join(tmp, "secret-ports.json")),
		});
	}

	const PROJECT = "bobbit-pack-secretpack-testsuffix";
	// composeFile is resolved relative to the sourceFile's dir (runtimes/).
	const COMPOSE_ABS = path.join(tmp, "packs", "secretpack", "runtimes", "compose.yaml");

	it("tears down a never-started managed runtime WITHOUT resolving the missing secret or a sidecar", async () => {
		const docker = makeDocker({ down: () => ok() });
		const sup = makeSecretSupervisor(docker.executor);
		// Never started: no env file, no config sidecar, no LLM_KEY in any store.
		const st = await sup.down("secretpack", "svc");
		assert.equal(st.status, "stopped");
		assert.equal(st.composeProject, PROJECT);
		const downCall = docker.calls.find((c) => c.args.includes("down"))!;
		// Minimal read-only target: project + compose file, NO --env-file (none rendered).
		assert.deepEqual(downCall.args, ["compose", "-p", PROJECT, "-f", COMPOSE_ABS, "down"]);
		assert.ok(!downCall.args.includes("--env-file"), "never-started down carries no env file");
	});

	it("purges (down -v + removeState) a never-started managed runtime without secrets", async () => {
		const docker = makeDocker({ down: () => ok() });
		const sup = makeSecretSupervisor(docker.executor);
		const st = await sup.down("secretpack", "svc", { volumes: true, removeState: true });
		assert.equal(st.status, "stopped");
		const downCall = docker.calls.find((c) => c.args.includes("down"))!;
		assert.deepEqual(downCall.args, ["compose", "-p", PROJECT, "-f", COMPOSE_ABS, "down", "-v"]);
	});

	it("stops a never-started managed runtime WITHOUT resolving the missing secret or a sidecar", async () => {
		const docker = makeDocker({ stop: () => ok(), ps: () => ok("") });
		const sup = makeSecretSupervisor(docker.executor);
		// Never started: no env file, no config sidecar, no LLM_KEY in any store.
		// A full start invocation would throw on the unresolved `secret: LLM_KEY`;
		// stop must use the read-only target and issue `compose stop` regardless.
		const st = await sup.stop("secretpack", "svc");
		assert.equal(st.status, "stopped");
		assert.equal(st.composeProject, PROJECT);
		const stopCall = docker.calls.find((c) => c.args.includes("stop"))!;
		// Minimal read-only target: project + compose file + scoped services, NO
		// --env-file (none rendered yet), and no fresh env render on disk.
		assert.deepEqual(stopCall.args, ["compose", "-p", PROJECT, "-f", COMPOSE_ABS, "stop", "api", "db"]);
		assert.ok(!stopCall.args.includes("--env-file"), "never-started stop carries no env file");
	});

	it("stop surfaces docker-unavailable (ENOENT) for a never-started managed runtime", async () => {
		const enoent = Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
		const docker = makeDocker({ stop: () => { throw enoent; } });
		const sup = makeSecretSupervisor(docker.executor);
		const st = await sup.stop("secretpack", "svc");
		assert.equal(st.status, "docker-unavailable");
		assert.equal(st.composeProject, PROJECT);
	});
});

// ── capabilitySummary — pre-start consent disclosure (P3 §8) ─────────────────
//
// Pure w.r.t. Docker: derived only from the validated manifest + selected mode +
// already-persisted ports (NEVER allocates, NEVER runs a compose command). Pins
// the enable-card disclosure surface: images/services after omitServices, declared
// ports + persisted host assignment, the managed volume/data path, the start
// policy, and the memory/trust copy.

describe("PackRuntimeSupervisor.capabilitySummary", () => {
	/** A multi-mode runtime mirroring Hindsight's shape: a managed mode with `db`
	 *  and an external-postgres mode that omits `db`, plus ports + a DATA_DIR env. */
	function makeCapContribution(): RuntimeContribution {
		const packRoot = path.join(tmp, "packs", "cappack");
		return {
			id: "hindsight",
			title: "Hindsight",
			description: "Managed memory",
			listName: "hindsight",
			sourceFile: path.join(packRoot, "runtimes", "hindsight.yaml"),
			packRoot,
			manifest: {
				id: "hindsight",
				startPolicy: "on-enable",
				composeFile: "compose.yaml",
				ports: [
					{ key: "WEB_PORT", env: "HINDSIGHT_WEB_PORT", container: 3000 },
					{ key: "API_PORT", env: "HINDSIGHT_API_PORT", container: 8080 },
				],
				env: {
					HINDSIGHT_DATA_DIR: { value: "${dataDir:-~/.hindsight}" },
				},
				modes: {
					"managed-postgres": { services: ["api", "web", "db"] },
					"external-postgres": { services: ["api", "web", "db"], omitServices: ["db"] },
				},
			},
		} as RuntimeContribution;
	}

	function makeCapRegistry(contribution: RuntimeContribution): PackContributionResolver {
		const pack = {
			packId: "cappack",
			packName: "Cap Pack",
			packRoot: contribution.packRoot,
			panels: [],
			entrypoints: [],
			providers: [],
			runtimes: [contribution],
		};
		const resolver = {
			list: () => [pack],
			getPack: (_p: string | undefined, packId: string) => (packId === "cappack" ? pack : undefined),
			getRuntime: (_p: string | undefined, packId: string, runtimeId: string) =>
				packId === "cappack" && runtimeId === "hindsight" ? contribution : undefined,
			getPanel: () => undefined,
			getEntrypoint: () => undefined,
			listProviders: () => [],
			hasRoute: () => false,
		};
		return resolver as unknown as PackContributionResolver;
	}

	function makeCapSupervisor(portStore?: FilePortStore): PackRuntimeSupervisor {
		const docker = makeDocker({});
		return new PackRuntimeSupervisor({
			registry: makeCapRegistry(makeCapContribution()),
			executor: docker.executor,
			serverIdentitySuffix: "testsuffix",
			runtimeDataDir: path.join(tmp, "cap-data"),
			...(portStore ? { portStore } : {}),
		});
	}

	it("managed mode discloses api+web+db, ports, default volume path, on-enable policy, trust copy", async () => {
		const sup = makeCapSupervisor();
		const cap = await sup.capabilitySummary("cappack", "hindsight", { mode: "managed-postgres" });
		assert.equal(cap.mode, "managed-postgres");
		assert.equal(cap.startPolicy, "on-enable");
		assert.deepEqual(cap.services, ["api", "web", "db"]);
		assert.deepEqual(cap.images, ["api", "web", "db"]);
		assert.equal(cap.composeProject, "bobbit-pack-cappack-testsuffix");
		// Declared ports surfaced with their env name + container port; no host yet.
		const web = cap.ports.find((p) => p.key === "WEB_PORT")!;
		assert.equal(web.env, "HINDSIGHT_WEB_PORT");
		assert.equal(web.container, 3000);
		assert.equal(web.host, undefined, "no host port allocated by a pure capability read");
		// Default managed data path resolved from the ${dataDir:-~/.hindsight} value ref.
		assert.equal(cap.volumePath, "~/.hindsight");
		assert.match(cap.trust, /store and recall agent memory/);
		assert.match(cap.trust, /purge removes Docker/i);
	});

	it("external-postgres mode subtracts db from the disclosed services", async () => {
		const sup = makeCapSupervisor();
		const cap = await sup.capabilitySummary("cappack", "hindsight", { mode: "external-postgres" });
		assert.deepEqual(cap.services, ["api", "web"]);
		assert.ok(!cap.services.includes("db"), "external-postgres discloses no managed db service");
	});

	it("discloses an ALREADY-persisted host port without allocating a new one", async () => {
		const portStore = new FilePortStore(path.join(tmp, "cap-ports.json"));
		portStore.set(packRuntimePersistKey("cappack", "hindsight", "WEB_PORT"), 54321);
		const sup = makeCapSupervisor(portStore);
		const cap = await sup.capabilitySummary("cappack", "hindsight", { mode: "managed-postgres" });
		const web = cap.ports.find((p) => p.key === "WEB_PORT")!;
		assert.equal(web.host, 54321, "persisted host port disclosed verbatim");
		// The API port was never persisted → no host assignment fabricated.
		const api = cap.ports.find((p) => p.key === "API_PORT")!;
		assert.equal(api.host, undefined);
	});

	it("a configured dataDir overrides the default disclosed volume path", async () => {
		const sup = makeCapSupervisor();
		const cap = await sup.capabilitySummary("cappack", "hindsight", {
			mode: "managed-postgres",
			config: { dataDir: "/srv/hindsight" },
		});
		assert.equal(cap.volumePath, "/srv/hindsight");
	});

	it("defaults to the first declared mode when none is requested", async () => {
		const sup = makeCapSupervisor();
		const cap = await sup.capabilitySummary("cappack", "hindsight");
		assert.equal(cap.mode, "managed-postgres");
	});

	it("rejects an unknown mode with PackRuntimeBadRequestError", async () => {
		const sup = makeCapSupervisor();
		await assert.rejects(
			() => sup.capabilitySummary("cappack", "hindsight", { mode: "nope" }),
			PackRuntimeBadRequestError,
		);
	});

	it("startPolicyFor reports the runtime's declared on-enable policy (no Docker)", () => {
		const sup = makeCapSupervisor();
		assert.equal(sup.startPolicyFor("cappack", "hindsight"), "on-enable");
	});
});
