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
import os from "node:os";
import path from "node:path";

import {
	PackRuntimeSupervisor,
	PackRuntimeNotFoundError,
	PackRuntimeBadRequestError,
	PackRuntimeDockerUnavailableError,
	FilePortStore,
	encodePackRuntimeId,
	decodePackRuntimeId,
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
	for (const sub of ["up", "stop", "logs", "ps"]) {
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

		// Generated secret was created+persisted.
		assert.ok((secrets.data.GEN_SECRET ?? "").length > 0);
		// Port was allocated+persisted.
		assert.ok(typeof portStore.get("WEB_PORT") === "number");

		// Rendered env file carries the resolved values (no unresolved refs).
		const project = "bobbit-pack-envpack-testsuffix";
		const envFile = path.join(tmp, "envpack-data", project, "svc.env");
		const body = fs.readFileSync(envFile, "utf-8");
		assert.match(body, /USER_KEY="configured-llm-key"/);
		assert.match(body, /GEN_SECRET="/);
		assert.match(body, new RegExp(`WEB_PORT="${portStore.get("WEB_PORT")}"`));
	});

	it("a missing required user secret rejects with a clear error (not silent)", async () => {
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
		await assert.rejects(() => sup.start("envpack", "svc"), /USER_KEY/);
		assert.equal(docker.countSub("up"), 0);
	});
});
