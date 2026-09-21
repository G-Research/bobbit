import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	detectDockerSandboxCapability,
	E2E_FINAL_CLEANUP_POLICY,
	finalizeE2ERunCleanup,
	groupDVitestArgs,
	prepareE2EDistServerPrebundle,
	resolveE2ePlaywrightWorkers,
	resolveE2ERetryCount,
	resolveE2eVitestWorkers,
	runGroupBWithPackedConsumerFinalization,
	runGroupBWithPackedConsumerPreparation,
	runSeedThenGroupAAndPrebundle,
} from "../../../scripts/testing-v2/run-e2e-v2.mjs";
import {
	isDockerSandboxAvailable,
	SANDBOX_IMAGE,
} from "../../../tests/e2e/test-utils/docker.js";

type ProbeCall = { args: readonly string[]; timeoutMs: number };

function capabilityProbe(daemonAvailable: boolean, imageAvailable: boolean, calls: ProbeCall[]) {
	return (args: readonly string[], timeoutMs: number): boolean => {
		calls.push({ args, timeoutMs });
		return args[0] === "info" ? daemonAvailable : imageAvailable;
	};
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe("E2E Docker capability and scheduling", () => {
	it.each([
		{ daemon: false, image: false, expected: "daemon-unavailable", sandbox: false, callCount: 1 },
		{ daemon: true, image: false, expected: "image-unavailable", sandbox: false, callCount: 2 },
		{ daemon: true, image: true, expected: "available", sandbox: true, callCount: 2 },
	])("classifies daemon=$daemon image=$image", ({ daemon, image, expected, sandbox, callCount }) => {
		const coordinatorCalls: ProbeCall[] = [];
		const testCalls: ProbeCall[] = [];

		expect(detectDockerSandboxCapability(capabilityProbe(daemon, image, coordinatorCalls))).toBe(expected);
		expect(isDockerSandboxAvailable(capabilityProbe(daemon, image, testCalls))).toBe(sandbox);
		expect(coordinatorCalls).toHaveLength(callCount);
		expect(testCalls).toHaveLength(callCount);
		for (const calls of [coordinatorCalls, testCalls]) {
			expect(calls[0]).toEqual({ args: ["info"], timeoutMs: 5_000 });
			if (daemon) expect(calls[1]).toEqual({ args: ["image", "inspect", SANDBOX_IMAGE], timeoutMs: 10_000 });
		}
	});

	it.each([
		[{}, 2],
		[{ E2E_V2_PW_WORKERS: "1" }, 1],
		[{ E2E_V2_PW_WORKERS: "2" }, 2],
		[{ E2E_V2_PW_WORKERS: "3" }, 3],
		[{ E2E_V2_PW_WORKERS: "4" }, 4],
		[{ E2E_V2_PW_WORKERS: "5" }, 4],
		[{ E2E_V2_PW_WORKERS: "invalid" }, 2],
	] as const)("resolves the bounded Group B worker policy from %j", (env, expected) => {
		expect(resolveE2ePlaywrightWorkers(env)).toBe(expected);
	});

	it.each([
		[{}, 2],
		[{ VITEST_MAX_WORKERS: "1" }, 1],
		[{ VITEST_MAX_WORKERS: "1.9" }, 1],
		[{ VITEST_MAX_WORKERS: "2" }, 2],
		[{ VITEST_MAX_WORKERS: "3" }, 2],
		[{ VITEST_MAX_WORKERS: "999" }, 2],
		[{ VITEST_MAX_WORKERS: "0" }, 2],
		[{ VITEST_MAX_WORKERS: "invalid" }, 2],
	] as const)("resolves the bounded Group D worker policy from %j", (env, expected) => {
		expect(resolveE2eVitestWorkers(env)).toBe(expected);
	});

	it("selects both ordered Group D projects in one Vitest invocation", () => {
		expect(groupDVitestArgs({})).toEqual([
			"run",
			"--config", "vitest.config.ts",
			"--project", "v2-e2e-vitest-cli",
			"--project", "v2-e2e-vitest",
			"--silent=passed-only",
		]);
		expect(groupDVitestArgs({ BOBBIT_V2_RETRY_FREE: "1" })).toEqual([
			"run",
			"--config", "vitest.config.ts",
			"--project", "v2-e2e-vitest-cli",
			"--project", "v2-e2e-vitest",
			"--silent=passed-only",
			"--retry=0",
		]);
		const source = readFileSync("scripts/testing-v2/run-e2e-v2.mjs", "utf8");
		const groupD = source.slice(source.indexOf("async function runGroupD("), source.indexOf("async function main()"));
		expect(groupD.match(/\breturn run\(/g)).toHaveLength(1);
		expect(groupD.match(/groupDVitestArgs\(coordinatorEnv\)/g)).toHaveLength(1);
		expect(groupD).toContain('BOBBIT_V2_E2E_VITEST: "1"');
		expect(groupD).toContain("VITEST_MAX_WORKERS: String(resolveE2eVitestWorkers(coordinatorEnv))");
	});

	it("runs seed → A → prebundle → concurrent B/finalization barrier → cache fan-out → C → D with D strictly last", () => {
		const source = readFileSync("scripts/testing-v2/run-e2e-v2.mjs", "utf8");
		const defaultSchedule = source.match(/\} else \{\n\t\t\/\/ Hosted runners[\s\S]*?\n\t\}\n\n\tconst sample/)?.[0];
		expect(defaultSchedule).toBeDefined();

		const steps = [
			"createSerialPlaywrightEnvironment(coordinatorEnv)",
			"const prerequisites = await runSeedThenGroupAAndPrebundle({",
			"seedPackedConsumer: () => seedGroupCPackedConsumer(C, sharedPlaywrightEnv, paths)",
			"runGroupA: () => runGroupA(A, coordinatorEnv)",
			"preparePrebundle: () => prepareE2EDistServerPrebundle(paths, coordinatorEnv)",
			"bundle = prerequisites.prebundle",
			"const groupBEnvironment = Object.freeze(composeE2EChildEnvironment",
			"const paired = await runGroupBWithPackedConsumerFinalization({",
			"finalizePackedConsumer: () => finalizeGroupCPackedConsumer(prerequisites.seed, sharedPlaywrightEnv, paths)",
			"fanOutSerialTransformCache(paths.cacheRoot, paths.root)",
			"await runSerialGroupC(C, sharedPlaywrightEnv, paths, groupCWorkers, retries, serialTransformCache.snapshotPath)",
			"await runGroupD(D, { coordinatorEnv })",
		];
		let previous = -1;
		for (const step of steps) {
			const position = defaultSchedule!.indexOf(step);
			expect(position, step).toBeGreaterThan(previous);
			previous = position;
		}
		expect(defaultSchedule!.match(/seedGroupCPackedConsumer\(/g)).toHaveLength(1);
		expect(defaultSchedule).toContain("results.push(groupBResult)");
		expect(defaultSchedule).toContain('captureLatestProfile("B")');
		expect(defaultSchedule).toContain("Object.freeze(sharedPlaywrightEnv)");
		expect(defaultSchedule).not.toContain("groupDRun");
		expect(defaultSchedule).not.toMatch(/Promise\.all[\s\S]*runGroupD/);
		expect(resolveE2ERetryCount({})).toBe(3);
		expect(defaultSchedule).toContain("const groupBWorkers = resolveE2ePlaywrightWorkers()");
		expect(defaultSchedule).toContain("const groupCWorkers = resolveE2ePlaywrightWorkers()");
		const focusedGroupB = source.slice(
			source.indexOf("async function runGroupB("),
			source.indexOf("async function runSerialGroupB("),
		);
		expect(focusedGroupB).toContain("const pwWorkers = resolveE2ePlaywrightWorkers()");
		const reportCapacity = source.slice(
			source.indexOf("\n\t\tcapacity: {"),
			source.indexOf("\n\t\t},", source.indexOf("\n\t\tcapacity: {")),
		);
		expect(reportCapacity).toContain("B: resolveE2ePlaywrightWorkers()");
		expect(reportCapacity).toContain("D: resolveE2eVitestWorkers(coordinatorEnv)");
		const focusedGroupD = source.slice(
			source.indexOf("async function runGroupD("),
			source.indexOf("async function main()"),
		);
		expect(focusedGroupD).toContain("VITEST_MAX_WORKERS: String(resolveE2eVitestWorkers(coordinatorEnv))");
		expect(source).not.toContain('process.platform === "win32" && process.env.E2E_V2_PW_WORKERS === undefined ? 1');
		expect(defaultSchedule).toContain("preparePrebundle: () => prepareE2EDistServerPrebundle(paths, coordinatorEnv)");
		expect(defaultSchedule).toContain("bundle = prerequisites.prebundle");
		const reportAt = source.indexOf("const report = {");
		const bundleFieldAt = source.indexOf("\n\t\tbundle,", reportAt);
		const cleanupAt = source.indexOf("await finalizeE2ERunCleanup({", reportAt);
		expect(bundleFieldAt).toBeGreaterThan(reportAt);
		expect(cleanupAt).toBeGreaterThan(bundleFieldAt);
		const cleanupCall = source.slice(cleanupAt, cleanupAt + 1_200);
		expect(cleanupCall).toContain('coordinator: { pid: process.pid, state: "groups-settled" }');
		expect(cleanupCall).toContain('sampler: { state: "stopped"');
		expect(cleanupCall).toContain('state: "written"');
	});

	it("uses the bounded high-cardinality cleanup policy and reports terminal timing", async () => {
		expect(E2E_FINAL_CLEANUP_POLICY).toEqual({
			traversalConcurrency: 128,
			subprocessThreadPoolSize: 32,
			deadlineMs: 30_000,
		});
		expect(Object.isFrozen(E2E_FINAL_CLEANUP_POLICY)).toBe(true);
		const paths = { root: "owned-e2e-root", runId: "cleanup-policy" };
		const info: string[] = [];
		const errors: string[] = [];
		const options: Record<string, unknown>[] = [];
		let clock = 100;
		const success = await finalizeE2ERunCleanup({
			paths,
			anyFailed: false,
			lifecycle: { groups: "settled" },
			remove: async (_target: string, removeOptions: Record<string, unknown>) => {
				options.push(removeOptions);
				clock = 132;
			},
			logInfo: (message: string) => info.push(message),
			logError: (message: string) => errors.push(message),
			now: () => clock,
		});
		expect(success).toBe(0);
		expect(options).toEqual([expect.objectContaining(E2E_FINAL_CLEANUP_POLICY)]);
		expect(info).toEqual([
			expect.stringContaining("cleanup start"),
			expect.stringContaining("cleanup success in 32.0ms"),
		]);
		expect(errors).toEqual([]);

		clock = 200;
		const failure = await finalizeE2ERunCleanup({
			paths,
			anyFailed: false,
			lifecycle: { groups: "settled" },
			remove: async () => {
				clock = 230;
				throw new Error("terminal cleanup failure");
			},
			logInfo: (message: string) => info.push(message),
			logError: (message: string) => errors.push(message),
			now: () => clock,
		});
		expect(failure).toBe(1);
		expect(errors.at(-1)).toContain("cleanup failed in 30.0ms");
		expect(errors.at(-1)).toContain("terminal cleanup failure");
	});

	it("keeps the seed authority across A and prebundle before admitting B/finalization", async () => {
		const seed = deferred<{ id: string; deadline: Readonly<{ identity: string; expiresAt: number }> }>();
		const groupA = deferred<{ code: number }>();
		const prebundle = deferred<{ bundlePath: string }>();
		const events: string[] = [];
		const deadline = Object.freeze({ identity: "deadline-300s", expiresAt: 300_000 });
		const seedHandle = Object.freeze({ id: "verified", deadline });
		const running = runSeedThenGroupAAndPrebundle({
			seedPackedConsumer: () => { events.push("seed-start"); return seed.promise; },
			runGroupA: () => { events.push("a-start"); return groupA.promise; },
			onGroupASettled: () => events.push("a-settled"),
			preparePrebundle: () => { events.push("prebundle-start"); return prebundle.promise; },
		});
		expect(events).toEqual(["seed-start"]);
		seed.resolve(seedHandle);
		await Promise.resolve();
		await Promise.resolve();
		expect(events).toEqual(["seed-start", "a-start"]);
		groupA.resolve({ code: 0 });
		await Promise.resolve();
		await Promise.resolve();
		expect(events).toEqual(["seed-start", "a-start", "a-settled", "prebundle-start"]);
		prebundle.resolve({ bundlePath: "bundle.mjs" });
		const prerequisites = await running;
		expect(prerequisites.seed).toBe(seedHandle);
		expect(prerequisites.seed.deadline).toBe(deadline);

		let finalizedSeed: typeof seedHandle | undefined;
		await expect(runGroupBWithPackedConsumerFinalization({
			runGroupB: () => Promise.resolve({ code: 0 }),
			finalizePackedConsumer: () => {
				finalizedSeed = prerequisites.seed;
				return Promise.resolve({ selected: true });
			},
		})).resolves.toMatchObject({ groupB: { code: 0 }, packedConsumer: { selected: true } });
		expect(finalizedSeed).toBe(seedHandle);
		expect(finalizedSeed?.deadline).toBe(deadline);
	});

	it("blocks A and prebundle when seeding fails, and blocks prebundle when A throws", async () => {
		const seedFailure = new Error("seed failed");
		let aStarts = 0;
		let prebundleStarts = 0;
		await expect(runSeedThenGroupAAndPrebundle({
			seedPackedConsumer: () => Promise.reject(seedFailure),
			runGroupA: () => { aStarts++; return Promise.resolve({ code: 0 }); },
			preparePrebundle: () => { prebundleStarts++; return Promise.resolve({ bundlePath: "late" }); },
		})).rejects.toBe(seedFailure);
		expect(aStarts).toBe(0);
		expect(prebundleStarts).toBe(0);

		const groupAFailure = new Error("A threw");
		await expect(runSeedThenGroupAAndPrebundle({
			seedPackedConsumer: () => Promise.resolve({ id: "verified" }),
			runGroupA: () => Promise.reject(groupAFailure),
			preparePrebundle: () => { prebundleStarts++; return Promise.resolve({ bundlePath: "late" }); },
		})).rejects.toBe(groupAFailure);
		expect(prebundleStarts).toBe(0);
	});

	it.each(["group-b", "preparation"] as const)("waits at the overlap barrier when %s settles first", async (first) => {
		const groupB = deferred<{ code: number }>();
		const preparation = deferred<{ selected: boolean }>();
		const events: string[] = [];
		const running = runGroupBWithPackedConsumerPreparation({
			runGroupB: () => {
				events.push("start-b");
				return groupB.promise;
			},
			preparePackedConsumer: () => {
				events.push("start-preparation");
				return preparation.promise;
			},
			onGroupBSettled: () => events.push("profile-b"),
		});
		let settled = false;
		void running.then(() => { settled = true; }, () => { settled = true; });
		expect(events).toEqual(["start-b", "start-preparation"]);

		if (first === "group-b") groupB.resolve({ code: 0 });
		else preparation.resolve({ selected: true });
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(events.includes("profile-b")).toBe(first === "group-b");

		if (first === "group-b") preparation.resolve({ selected: true });
		else groupB.resolve({ code: 0 });
		await expect(running).resolves.toEqual({ groupB: { code: 0 }, packedConsumer: { selected: true } });
		expect(events).toEqual(["start-b", "start-preparation", "profile-b"]);
	});

	it("waits for B and retains its nonzero result before propagating preparation failure", async () => {
		const groupB = deferred<{ code: number }>();
		const preparationFailure = new Error("preparation deadline exhausted");
		let observedB: { code: number } | undefined;
		let settled = false;
		const running = runGroupBWithPackedConsumerPreparation({
			runGroupB: () => groupB.promise,
			preparePackedConsumer: () => Promise.reject(preparationFailure),
			onGroupBSettled: (result: { code: number }) => { observedB = result; },
		});
		void running.then(() => { settled = true; }, () => { settled = true; });
		await Promise.resolve();
		expect(settled).toBe(false);

		groupB.resolve({ code: 7 });
		await expect(running).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as AggregateError).errors[0]).toMatchObject({ message: expect.stringContaining("exit code 7") });
			expect((error as AggregateError).errors[1]).toBe(preparationFailure);
			return true;
		});
		expect(observedB).toEqual({ code: 7 });
	});

	it("joins finalization and aggregates it with a nonzero Group B result", async () => {
		const finalization = deferred<{ selected: boolean }>();
		const finalizationFailure = new Error("finalization failed");
		const running = runGroupBWithPackedConsumerFinalization({
			runGroupB: () => Promise.resolve({ code: 9 }),
			finalizePackedConsumer: () => finalization.promise,
		});
		let settled = false;
		void running.then(() => { settled = true; }, () => { settled = true; });
		await Promise.resolve();
		expect(settled).toBe(false);
		finalization.reject(finalizationFailure);
		await expect(running).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as AggregateError).errors[0]).toMatchObject({ message: expect.stringContaining("exit code 9") });
			expect((error as AggregateError).errors[1]).toBe(finalizationFailure);
			return true;
		});
	});

	it("aggregates simultaneous B and preparation exceptions", async () => {
		const groupBFailure = new Error("B threw");
		const preparationFailure = new Error("preparation threw");
		await expect(runGroupBWithPackedConsumerPreparation({
			runGroupB: () => Promise.reject(groupBFailure),
			preparePackedConsumer: () => Promise.reject(preparationFailure),
		})).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as AggregateError).errors).toEqual([groupBFailure, preparationFailure]);
			expect((error as Error).message).toContain("Group B and packed-consumer finalization both failed");
			return true;
		});
	});

	it("reports child build/reuse details after parent-side validation", async () => {
		const paths = { root: "owned-run-root" };
		const resolvePrebundle = (options: { repoRoot: string; runRoot: string }) => {
			expect(options.runRoot).toBe(paths.root);
			return { key: "compiled-key", bundlePath: "owned-run-root/bundle.mjs" };
		};
		const command = (cacheHit: boolean) => async () => ({
			code: 0,
			stdout: JSON.stringify({ ok: true, cacheHit, path: "ignored-foreign-path" }),
			stderr: "",
			shutdown: {
				ownershipState: "established",
				rootCloseObserved: true,
				treeExitAttempted: true,
				treeExitSettled: true,
				treeExitVerified: true,
				completionTimedOut: false,
			},
		});
		const built = await prepareE2EDistServerPrebundle(paths, {}, {
			runCommand: command(false),
			resolvePrebundle,
		});
		expect(built).toMatchObject({
			observed: true,
			status: "built",
			key: "compiled-key",
			bundlePath: "owned-run-root/bundle.mjs",
			fallback: false,
		});
		expect(built.buildWallMs).toBeGreaterThanOrEqual(0);

		const reused = await prepareE2EDistServerPrebundle(paths, {}, {
			runCommand: command(true),
			resolvePrebundle,
		});
		expect(reused.status).toBe("reused");
	});

	it("gates only image-backed sandbox cases and retains non-Docker coverage", () => {
		const source = readFileSync("tests/e2e/api/sandbox-recovery.api-e2e.spec.ts", "utf8");
		expect(source.match(/test\.skip\(!isDockerSandboxAvailable\(\)/g)).toHaveLength(2);
		expect(source).not.toContain("test.skip(!isDockerAvailable()");
		expect(source).toContain('test.describe("process_exit event handling"');
		expect(source.indexOf('test.describe("process_exit event handling"')).toBeGreaterThan(
			source.lastIndexOf("test.skip(!isDockerSandboxAvailable()"),
		);
	});

	it("keeps the Browser spawn-failure journey Docker-free and occurrence-scoped", () => {
		const journey = readFileSync("tests/browser/journeys/bg-spawn-failure.journey.spec.ts", "utf8");
		const harness = readFileSync("tests/e2e/gateway-harness.ts", "utf8");
		const manager = readFileSync("src/server/agent/bg-process-manager.ts", "utf8");
		const server = readFileSync("src/server/server.ts", "utf8");

		expect(journey).toContain('gateway.armBgProcessSpawnError("echo never-runs")');
		expect(journey).not.toMatch(/containerId|sandboxed|docker|isDocker/i);
		expect(harness).toContain("if (!armed || armed.command !== command)");
		expect(harness).toContain("return defaultBgProcessSpawn(command, cwd, containerId, paths)");
		expect(harness).toContain("bgProcessSpawnErrorArm = undefined");
		expect(harness).toContain('createAsyncSpawnErrorChild("ENOENT")');
		expect(harness).toContain("queueMicrotask(() =>");
		expect(harness).toContain('child.emit("error", error)');
		expect(manager).toContain("export const defaultBgProcessSpawn: SpawnFn");
		expect(manager).toContain('child.on?.("error", (err: unknown) => this.reconcileSpawnFailure');
		expect(server).toContain("config.bgProcessSpawnFn");
	});
});
