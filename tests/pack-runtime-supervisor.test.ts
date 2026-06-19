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
	readRuntimeStartPolicy,
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
	it("stop issues `compose stop` and reports stopped", async () => {
		const docker = makeDocker({ stop: () => ok(), ps: () => ok("") });
		const sup = makeSupervisor(docker.executor);
		const st = await sup.stop(PACK_ID, RUNTIME_ID);
		assert.equal(st.status, "stopped");
		const stopCall = docker.calls.find((c) => c.args.includes("stop"))!;
		const project = `bobbit-pack-${PACK_ID}-testsuffix`;
		const composeAbs = path.join(tmp, "packs", PACK_ID, "runtimes", "compose.yaml");
		const envFile = path.join(tmp, "data", project, `${RUNTIME_ID}.env`);
		// Carries the compose file/env file AND is scoped to this runtime's service
		// (`db`) — not the whole pack project.
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
	it("runs `compose logs --tail N` and returns stdout", async () => {
		const docker = makeDocker({ logs: () => ok("hello logs") });
		const sup = makeSupervisor(docker.executor);
		const out = await sup.logs(PACK_ID, RUNTIME_ID, { tail: 42 });
		assert.equal(out, "hello logs");
		const logCall = docker.calls.find((c) => c.args.includes("logs"))!;
		const project = `bobbit-pack-${PACK_ID}-testsuffix`;
		const composeAbs = path.join(tmp, "packs", PACK_ID, "runtimes", "compose.yaml");
		const envFile = path.join(tmp, "data", project, `${RUNTIME_ID}.env`);
		// Carries the compose file/env file AND is scoped to this runtime's service (`db`).
		assert.deepEqual(logCall.args, [...composeBase(project, composeAbs, envFile), "logs", "--tail", "42", "db"]);
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
		assert.deepEqual(stopCall.args, [
			...composeBase(PROJECT, COMPOSE_ABS, envFileFor("alpha")), "stop", "a1", "a2",
		]);
		// Sibling runtime's services are never passed.
		assert.ok(!stopCall.args.includes("b1"));
		assert.ok(!stopCall.args.includes("b2"));
	});

	it("status scopes `ps` to the runtime's own services only", async () => {
		const docker = makeDocker({ ps: () => ok("") });
		const sup = makeMultiSupervisor(docker.executor);
		await sup.status(MULTI_PACK, "beta");
		const psCall = docker.calls.find((c) => c.args.includes("ps"))!;
		assert.deepEqual(psCall.args, [
			...composeBase(PROJECT, COMPOSE_ABS, envFileFor("beta")), "ps", "--format", "json", "b1", "b2",
		]);
		assert.ok(!psCall.args.includes("a1"));
	});

	it("logs scope to the runtime's own services only", async () => {
		const docker = makeDocker({ logs: () => ok("out") });
		const sup = makeMultiSupervisor(docker.executor);
		await sup.logs(MULTI_PACK, "alpha", { tail: 10 });
		const logCall = docker.calls.find((c) => c.args.includes("logs"))!;
		assert.deepEqual(logCall.args, [
			...composeBase(PROJECT, COMPOSE_ABS, envFileFor("alpha")), "logs", "--tail", "10", "a1", "a2",
		]);
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
		const envFile = path.join(tmp, "bad-data", project, "bad.env");
		// Compose file/env file still present; no trailing service args.
		assert.deepEqual(stopCall.args, [...composeBase(project, composeAbs, envFile), "stop"]);
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

	it("concurrent explicit starts with DIFFERENT modes each issue their own up", async () => {
		const docker = makeDocker({
			up: () => ok(),
			ps: () => ok('{"Service":"db","State":"running","Health":"healthy"}'),
		});
		const sup = makeMmSupervisor(docker.executor);
		const [a, b] = await Promise.all([
			sup.start(MM_PACK, "svc", { mode: "default" }),
			sup.start(MM_PACK, "svc", { mode: "alt" }),
		]);
		assert.equal(a.status, "running");
		assert.equal(b.status, "running");
		assert.equal(a.mode, "default");
		assert.equal(b.mode, "alt");
		// Each mode must actually run — neither collapses onto the other's promise.
		assert.equal(docker.countSub("up"), 2);
		const profiles = docker.calls
			.filter((c) => c.args.includes("up"))
			.flatMap((c) => {
				const i = c.args.indexOf("--profile");
				return i >= 0 ? [c.args[i + 1]] : [];
			});
		assert.ok(profiles.includes("managed"));
		assert.ok(profiles.includes("external"));
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
