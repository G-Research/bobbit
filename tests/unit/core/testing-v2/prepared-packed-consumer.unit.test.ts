import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "vitest";
import * as packedConsumerModule from "../../../../scripts/testing-v2/prewarm-packed-consumer-cache.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const FAILURE_PREFIX = "PACKED_CONSUMER_PREPARATION_REUSE";
const roots: string[] = [];

type CommandOptions = {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs: number;
	totalTimeoutMs?: number;
};

type CommandResult = {
	command: string;
	args: string[];
	code: number;
	stdout: string;
	stderr: string;
};

type Deferred = {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
};

type CommandCall = {
	command: string;
	args: string[];
	options: CommandOptions;
};

type PreparedDescriptor = {
	version: number;
	runRoot: string;
	fixtureRoot: string;
	templateDir: string;
	consumersDir: string;
	tarballPath: string;
	cacheDir: string;
	descriptorPath: string;
	packageName: string;
	packEntry: { filename: string };
	commands: unknown[];
};

type PackedConsumerApi = {
	preparePackedConsumerFixture?: (options: {
		repoRoot: string;
		runRoot: string;
		baseEnv?: NodeJS.ProcessEnv;
		ensureDist: (options?: {
			timeoutMs: number;
			fixtureRoot: string;
			commands: unknown[];
		}) => void | Promise<void>;
		resolveNpm: () => { command: string; argsPrefix: string[] };
		runCommand: (command: string, args: string[], options: CommandOptions) => Promise<{
			command: string;
			args: string[];
			code: number;
			stdout: string;
			stderr: string;
		}>;
		preparationTimeoutMs?: number;
		now?: () => number;
	}) => Promise<PreparedDescriptor>;
	readPreparedPackedConsumerDescriptor?: (
		descriptorPath: string,
		coordinatorRunRoot: string,
	) => Promise<PreparedDescriptor>;
	materializePackedConsumerFixture?: (
		descriptor: PreparedDescriptor,
		options: {
			coordinatorRunRoot: string;
			name?: string;
			mode?: "copy" | "consume";
			copy?: (source: string, destination: string, options: object) => Promise<void>;
			move?: (source: string, destination: string) => Promise<void>;
		},
	) => Promise<string | { consumerDir: string }>;
};

const api = packedConsumerModule as PackedConsumerApi;

function requireApi<K extends keyof PackedConsumerApi>(name: K): NonNullable<PackedConsumerApi[K]> {
	const candidate = api[name];
	assert.equal(
		typeof candidate,
		"function",
		`${FAILURE_PREFIX}: scripts/testing-v2/prewarm-packed-consumer-cache.mjs must export ${name}`,
	);
	return candidate as NonNullable<PackedConsumerApi[K]>;
}

function isStrictChild(root: string, candidate: string): boolean {
	const child = relative(resolve(root), resolve(candidate));
	return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function consumerPath(result: string | { consumerDir: string }): string {
	return typeof result === "string" ? result : result.consumerDir;
}

function cachePath(call: CommandCall): string | undefined {
	const cacheFlag = call.args.indexOf("--cache");
	if (cacheFlag >= 0) return call.args[cacheFlag + 1];
	return call.options.env?.npm_config_cache ?? call.options.env?.NPM_CONFIG_CACHE;
}

function deferred(): Deferred {
	let resolvePromise!: () => void;
	let rejectPromise!: (error: Error) => void;
	const promise = new Promise<void>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 0));
	}
	assert.fail(`${FAILURE_PREFIX}: condition did not become true`);
}

async function prepareFixture({
	registryTarballCount = 0,
	onCacheCommand,
	onOfflineInstall,
}: {
	registryTarballCount?: number;
	onCacheCommand?: (batchIndex: number, result: CommandResult, options: CommandOptions) => Promise<void>;
	onOfflineInstall?: () => void | Promise<void>;
} = {}) {
	const runRoot = await mkdtemp(join(tmpdir(), "bobbit-prepared-consumer-unit-"));
	roots.push(runRoot);
	const calls: CommandCall[] = [];
	let cacheBatchIndex = 0;
	const prepare = requireApi("preparePackedConsumerFixture");
	const descriptor = await prepare({
		repoRoot: REPO_ROOT,
		runRoot,
		baseEnv: {
			PATH: process.env.PATH,
			npm_config_cache: join(tmpdir(), "ambient-cache-must-not-be-used"),
		},
		ensureDist: () => {},
		resolveNpm: () => ({ command: "node", argsPrefix: ["npm-cli.js"] }),
		runCommand: async (command, args, options) => {
			calls.push({ command, args: [...args], options: { ...options, env: { ...options.env } } });
			const result = { command, args: [...args], code: 0, stdout: "", stderr: "" };
			if (args.includes("pack")) {
				const packDir = args[args.indexOf("--pack-destination") + 1];
				assert.ok(packDir, `${FAILURE_PREFIX}: npm pack must use an owned destination`);
				await mkdir(packDir, { recursive: true });
				await writeFile(join(packDir, "bobbit-fixture.tgz"), "actual packed bytes");
				result.stdout = JSON.stringify([{
					name: "@gresearch/bobbit",
					filename: "bobbit-fixture.tgz",
					entryCount: 1,
					size: 19,
					unpackedSize: 19,
				}]);
				return result;
			}
			if (args.includes("--package-lock-only")) {
				const manifest = JSON.parse(await readFile(join(options.cwd, "package.json"), "utf8"));
				manifest.dependencies = { "@gresearch/bobbit": "file:../../pack/bobbit-fixture.tgz" };
				await writeFile(join(options.cwd, "package.json"), `${JSON.stringify(manifest)}\n`);
				const registryPackages = Object.fromEntries(Array.from({ length: registryTarballCount }, (_, index) => [
					`node_modules/dependency-${String(index).padStart(3, "0")}`,
					{
						version: "1.0.0",
						resolved: `https://registry.example.test/dependency-${String(index).padStart(3, "0")}.tgz`,
						integrity: `sha512-${index}`,
					},
				]));
				await writeFile(join(options.cwd, "package-lock.json"), JSON.stringify({
					name: "prepared-consumer",
					version: "1.0.0",
					lockfileVersion: 3,
					packages: {
						"": { name: "prepared-consumer", version: "1.0.0", dependencies: manifest.dependencies },
						"node_modules/@gresearch/bobbit": {
							version: "1.0.0",
							resolved: "file:../../pack/bobbit-fixture.tgz",
						},
						...registryPackages,
					},
				}));
				return result;
			}
			if (args.includes("cache") && args.includes("add")) {
				const batchIndex = cacheBatchIndex++;
				result.stdout = `cache-batch-${batchIndex}`;
				await onCacheCommand?.(batchIndex, result, options);
				return result;
			}
			if (args.includes("ci") && args.includes("--offline")) {
				await onOfflineInstall?.();
				const stagedManifest = JSON.parse(await readFile(join(options.cwd, "package.json"), "utf8"));
				const stagedLock = JSON.parse(await readFile(join(options.cwd, "package-lock.json"), "utf8"));
				assert.deepEqual(stagedLock.packages[""].dependencies, stagedManifest.dependencies,
					`${FAILURE_PREFIX}: offline install must consume the already-resolved packed-artifact lock`);
				const fixtureModule = join(options.cwd, "node_modules", "fixture-dependency");
				await mkdir(fixtureModule, { recursive: true });
				await writeFile(join(fixtureModule, "marker.txt"), "installed-template");
			}
			return result;
		},
	});
	return { runRoot, calls, descriptor };
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("prepared packed consumer", () => {
	it("packs and installs the actual tarball once with a run-owned cache and deterministic offline flags", async () => {
		const { runRoot, calls, descriptor } = await prepareFixture();
		const packCalls = calls.filter(call => call.args.includes("pack"));
		const lockOnlyInstalls = calls.filter(call => call.args.includes("install") && call.args.includes("--package-lock-only"));
		const offlineMaterializations = calls.filter(call => call.args.includes("ci") && call.args.includes("--offline"));

		assert.equal(packCalls.length, 1, `${FAILURE_PREFIX}: preparation must run npm pack exactly once`);
		assert.equal(lockOnlyInstalls.length, 1, `${FAILURE_PREFIX}: preparation must resolve the packed artifact exactly once`);
		assert.equal(offlineMaterializations.length, 1, `${FAILURE_PREFIX}: preparation must run one offline npm ci`);
		assert.ok(isStrictChild(runRoot, descriptor.tarballPath), `${FAILURE_PREFIX}: tarball must stay below the run root`);
		assert.ok(isStrictChild(runRoot, descriptor.templateDir), `${FAILURE_PREFIX}: template must stay below the run root`);
		assert.ok(isStrictChild(runRoot, descriptor.cacheDir), `${FAILURE_PREFIX}: npm cache must stay below the run root`);
		assert.equal(await readFile(descriptor.tarballPath, "utf8"), "actual packed bytes");

		const install = offlineMaterializations[0]!;
		for (const flag of ["--offline", "--ignore-scripts", "--no-audit", "--no-fund"]) {
			assert.ok(install.args.includes(flag), `${FAILURE_PREFIX}: prepared install must pass ${flag}`);
		}
		assert.ok(
			!install.args.some(argument => resolve(argument) === resolve(descriptor.tarballPath)),
			`${FAILURE_PREFIX}: offline npm ci must consume the validated lock without a second package operand`,
		);
		assert.equal(
			resolve(cachePath(install) ?? ""),
			resolve(descriptor.cacheDir),
			`${FAILURE_PREFIX}: offline install must use the descriptor's isolated cache`,
		);
		assert.notEqual(
			resolve(descriptor.cacheDir),
			resolve(join(tmpdir(), "ambient-cache-must-not-be-used")),
			`${FAILURE_PREFIX}: preparation must not inherit the ambient npm cache`,
		);
	});

	it("fills nine cache batches through a dynamic three-worker pool before offline install", async () => {
		const gates = Array.from({ length: 9 }, deferred);
		const admitted: number[] = [];
		const completed: number[] = [];
		const released = new Set<number>();
		let active = 0;
		let maxActive = 0;
		let completionsAtOfflineInstall = -1;
		const preparing = prepareFixture({
			registryTarballCount: 9 * 32,
			onCacheCommand: async batchIndex => {
				admitted.push(batchIndex);
				active++;
				maxActive = Math.max(maxActive, active);
				try {
					await gates[batchIndex]!.promise;
					completed.push(batchIndex);
				} finally {
					active--;
				}
			},
			onOfflineInstall: () => { completionsAtOfflineInstall = completed.length; },
		});

		await waitFor(() => admitted.length === 3);
		while (admitted.length < 9) {
			const batchIndex = [...admitted].reverse().find(index => !released.has(index));
			assert.notEqual(batchIndex, undefined);
			const priorAdmissions = admitted.length;
			released.add(batchIndex!);
			gates[batchIndex!]!.resolve();
			await waitFor(() => admitted.length === priorAdmissions + 1);
		}
		for (const batchIndex of admitted) {
			if (!released.has(batchIndex)) gates[batchIndex]!.resolve();
		}
		const { calls, descriptor } = await preparing;

		assert.equal(maxActive, 3, `${FAILURE_PREFIX}: cache preparation must cap active commands at three`);
		assert.equal(completionsAtOfflineInstall, 9,
			`${FAILURE_PREFIX}: offline install and descriptor publication require all nine cache successes`);
		assert.deepEqual(admitted, [0, 1, 2, 3, 4, 5, 6, 7, 8],
			`${FAILURE_PREFIX}: each completion must dynamically admit the next deterministic batch`);
		assert.notDeepEqual(completed, [...completed].sort((left, right) => left - right),
			`${FAILURE_PREFIX}: the injected runner must exercise out-of-order completion`);
		const cacheCalls = calls.filter(call => call.args.includes("cache") && call.args.includes("add"));
		assert.equal(cacheCalls.length, 9);
		assert.ok(cacheCalls.every(call => cachePath(call) === descriptor.cacheDir),
			`${FAILURE_PREFIX}: concurrent writers must share only the isolated run-owned cache`);
		assert.ok(cacheCalls.every(call => typeof call.options.totalTimeoutMs === "number" && call.options.totalTimeoutMs! <= 5 * 60_000),
			`${FAILURE_PREFIX}: each admitted cache owner must receive the common preparation deadline remainder`);
		const recordedCache = (descriptor.commands as CommandResult[])
			.filter(command => command.args.includes("cache") && command.args.includes("add"));
		assert.deepEqual(recordedCache.map(command => command.stdout),
			Array.from({ length: 9 }, (_, index) => `cache-batch-${index}`),
			`${FAILURE_PREFIX}: descriptor evidence must be ordered by batch index, not completion`);
		const offlineIndex = calls.findIndex(call => call.args.includes("ci") && call.args.includes("--offline"));
		assert.ok(offlineIndex > Math.max(...cacheCalls.map(call => calls.indexOf(call))),
			`${FAILURE_PREFIX}: offline install must start only after all cache writers settle successfully`);
	});

	it("stops cache admission after an observed failure and retains every admitted failure in batch order", async () => {
		const gates = Array.from({ length: 9 }, deferred);
		const admitted: number[] = [];
		const settled: number[] = [];
		let preparationSettled = false;
		const preparing = prepareFixture({
			registryTarballCount: 9 * 32,
			onCacheCommand: async (batchIndex, _result, options) => {
				admitted.push(batchIndex);
				try {
					await gates[batchIndex]!.promise;
				} catch {
					throw new packedConsumerModule.OwnedCommandError(`cache batch ${batchIndex + 1} failed`, {
						command: "node",
						args: ["npm-cli.js", "cache", "add", `batch-${batchIndex + 1}`],
						cwd: options.cwd,
						shutdown: {
							ownershipState: "established",
							rootCloseObserved: true,
							treeExitAttempted: true,
							treeExitSettled: true,
							treeExitVerified: true,
							completionTimedOut: false,
						},
					});
				} finally {
					settled.push(batchIndex);
				}
			},
		});
		const observed = preparing.then(
			() => ({ error: undefined }),
			error => ({ error }),
		).finally(() => { preparationSettled = true; });

		await waitFor(() => admitted.length === 3);
		gates[0]!.resolve();
		await waitFor(() => admitted.length === 4);
		gates[2]!.resolve();
		await waitFor(() => admitted.length === 5);
		gates[1]!.reject(new Error("first failure"));
		await waitFor(() => settled.includes(1));
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(admitted.length, 5, `${FAILURE_PREFIX}: no batch may be admitted after failure is observed`);
		assert.equal(preparationSettled, false, `${FAILURE_PREFIX}: preparation must await all already-admitted owners`);
		gates[3]!.resolve();
		gates[4]!.reject(new Error("second failure"));
		const { error } = await observed;
		assert.ok(error instanceof Error);
		assert.deepEqual(admitted, [0, 1, 2, 3, 4]);
		assert.deepEqual([...settled].sort((left, right) => left - right), [0, 1, 2, 3, 4],
			`${FAILURE_PREFIX}: rejection must wait for every admitted owner to settle`);

		const runRoot = roots.at(-1)!;
		const fixtureRoot = join(runRoot, "prepared-packed-consumer");
		const evidence = JSON.parse(await readFile(join(fixtureRoot, "preparation-failure.json"), "utf8"));
		assert.equal(evidence.error.name, "AggregateError");
		assert.deepEqual(evidence.error.errors.map((failure: { message: string }) => failure.message), [
			"cache batch 2 failed",
			"cache batch 5 failed",
		]);
		assert.deepEqual(evidence.error.errors.map((failure: { args: string[] }) => failure.args.at(-1)), ["batch-2", "batch-5"]);
		assert.ok(evidence.error.errors.every((failure: { shutdown: { treeExitVerified: boolean } }) => failure.shutdown.treeExitVerified),
			`${FAILURE_PREFIX}: aggregate evidence must preserve each owned command's shutdown proof`);
		const recordedCache = (evidence.commands as CommandResult[])
			.filter(command => command.args.includes("cache") && command.args.includes("add"));
		assert.deepEqual(recordedCache.map(command => command.stdout), ["cache-batch-0", "cache-batch-2", "cache-batch-3"],
			`${FAILURE_PREFIX}: successful command evidence must remain in batch order`);
		await assert.rejects(readFile(join(fixtureRoot, "descriptor.json")),
			(error: NodeJS.ErrnoException) => error.code === "ENOENT",
			`${FAILURE_PREFIX}: partial cache success must not publish a descriptor`);
	});

	it("materializes independent copied consumers without rerunning package commands", async () => {
		const { runRoot, calls, descriptor } = await prepareFixture();
		const materialize = requireApi("materializePackedConsumerFixture");
		const packageCommandCount = calls.length;
		const first = consumerPath(await materialize(descriptor, { coordinatorRunRoot: runRoot, name: "first" }));
		const second = consumerPath(await materialize(descriptor, { coordinatorRunRoot: runRoot, name: "second" }));

		assert.equal(calls.length, packageCommandCount, `${FAILURE_PREFIX}: materialization must reuse preparation without npm pack/install`);
		assert.notEqual(resolve(first), resolve(second), `${FAILURE_PREFIX}: each consumer needs a unique directory`);
		assert.notEqual(resolve(first), resolve(descriptor.templateDir), `${FAILURE_PREFIX}: a consumer must not be the immutable template`);
		assert.notEqual(resolve(second), resolve(descriptor.templateDir), `${FAILURE_PREFIX}: a consumer must not be the immutable template`);
		assert.ok(isStrictChild(runRoot, first), `${FAILURE_PREFIX}: first consumer escaped the run root`);
		assert.ok(isStrictChild(runRoot, second), `${FAILURE_PREFIX}: second consumer escaped the run root`);
		assert.equal((await lstat(join(first, "node_modules"))).isSymbolicLink(), false, `${FAILURE_PREFIX}: copied node_modules must not be a symlink`);
		assert.equal((await lstat(join(second, "node_modules"))).isSymbolicLink(), false, `${FAILURE_PREFIX}: copied node_modules must not be a symlink`);

		const marker = join("node_modules", "fixture-dependency", "marker.txt");
		await writeFile(join(first, marker), "mutated-first");
		await mkdir(join(first, ".bobbit"), { recursive: true });
		await writeFile(join(first, ".bobbit", "secrets.json"), "first-only");
		assert.equal(await readFile(join(second, marker), "utf8"), "installed-template", `${FAILURE_PREFIX}: consumers must not share mutable dependency files`);
		assert.equal(await readFile(join(descriptor.templateDir, marker), "utf8"), "installed-template", `${FAILURE_PREFIX}: consumer mutation must not alter the template`);
		await assert.rejects(
			readFile(join(second, ".bobbit", "secrets.json"), "utf8"),
			(error: NodeJS.ErrnoException) => error.code === "ENOENT",
			`${FAILURE_PREFIX}: consumer workspace state must remain isolated`,
		);
	});

	it("atomically consumes the prepared tree once without copying or rerunning package commands", async () => {
		const { runRoot, calls, descriptor } = await prepareFixture();
		const materialize = requireApi("materializePackedConsumerFixture");
		const packageCommandCount = calls.length;
		const marker = join("node_modules", "fixture-dependency", "marker.txt");
		const manifestBytes = await readFile(join(descriptor.templateDir, "package.json"));
		const lockBytes = await readFile(join(descriptor.templateDir, "package-lock.json"));
		const markerBytes = await readFile(join(descriptor.templateDir, marker));
		let copyCount = 0;
		const moves: Array<{ source: string; destination: string }> = [];

		const consumed = consumerPath(await materialize(descriptor, {
			coordinatorRunRoot: runRoot,
			name: "one-shot",
			mode: "consume",
			copy: async () => { copyCount++; },
			move: async (source, destination) => {
				moves.push({ source, destination });
				await rename(source, destination);
			},
		}));

		assert.equal(copyCount, 0, `${FAILURE_PREFIX}: consume mode must not copy the installed tree`);
		assert.deepEqual(moves, [{ source: descriptor.templateDir, destination: consumed }],
			`${FAILURE_PREFIX}: consume mode must atomically rename the prepared template`);
		assert.equal(calls.length, packageCommandCount, `${FAILURE_PREFIX}: consumption must not invoke a package command`);
		assert.notEqual(resolve(consumed), resolve(descriptor.templateDir), `${FAILURE_PREFIX}: destination must be unique from the template`);
		assert.ok(isStrictChild(runRoot, consumed), `${FAILURE_PREFIX}: consumed tree escaped the run root`);
		const destination = await lstat(consumed);
		assert.equal(destination.isDirectory(), true, `${FAILURE_PREFIX}: consumed destination must be an ordinary directory`);
		assert.equal(destination.isSymbolicLink(), false, `${FAILURE_PREFIX}: consumed destination must not be a symlink`);
		assert.equal((await lstat(join(consumed, "node_modules"))).isSymbolicLink(), false,
			`${FAILURE_PREFIX}: consumed node_modules must remain an ordinary private tree`);
		assert.deepEqual(await readFile(join(consumed, "package.json")), manifestBytes,
			`${FAILURE_PREFIX}: consume mode must preserve manifest bytes`);
		assert.deepEqual(await readFile(join(consumed, "package-lock.json")), lockBytes,
			`${FAILURE_PREFIX}: consume mode must preserve lock bytes`);
		assert.deepEqual(await readFile(join(consumed, marker)), markerBytes,
			`${FAILURE_PREFIX}: consume mode must preserve installed marker bytes`);
		const lock = JSON.parse(lockBytes.toString("utf8"));
		const packedReference = lock.packages[""].dependencies[descriptor.packageName] as string;
		assert.match(packedReference, /^file:/, `${FAILURE_PREFIX}: consumed lock must retain its file reference`);
		assert.equal(
			resolve(consumed, decodeURIComponent(packedReference.slice("file:".length))),
			resolve(descriptor.tarballPath),
			`${FAILURE_PREFIX}: equal-depth move must keep the lock bound to the real packed tarball`,
		);
		await assert.rejects(
			lstat(descriptor.templateDir),
			(error: NodeJS.ErrnoException) => error.code === "ENOENT",
			`${FAILURE_PREFIX}: successful consumption must remove the template source name`,
		);
		await assert.rejects(
			materialize(descriptor, {
				coordinatorRunRoot: runRoot,
				name: "second-consume",
				mode: "consume",
				copy: async () => { copyCount++; },
			}),
			(error: NodeJS.ErrnoException) => error.code === "ENOENT",
			`${FAILURE_PREFIX}: the prepared tree must be consumable only once`,
		);
		assert.equal(copyCount, 0, `${FAILURE_PREFIX}: failed second consumption must not fall back to copying`);
		assert.equal(calls.length, packageCommandCount, `${FAILURE_PREFIX}: failed second consumption must not invoke a package command`);
	});

	it("rejects a self-consistent descriptor owned by a different run root before reuse", async () => {
		const { calls, descriptor } = await prepareFixture();
		const authoritativeRoot = await mkdtemp(join(tmpdir(), "bobbit-packed-authoritative-unit-"));
		roots.push(authoritativeRoot);
		const commandCount = calls.length;
		const readDescriptor = requireApi("readPreparedPackedConsumerDescriptor");

		await assert.rejects(
			readDescriptor(descriptor.descriptorPath, authoritativeRoot),
			/descriptorPath must be a strict child of the E2E run root/,
		);
		assert.equal(calls.length, commandCount, `${FAILURE_PREFIX}: rejected provenance must not invoke a package command`);
	});

	it("rejects a descriptor whose declared file identity differs from the coordinator path", async () => {
		const { runRoot, calls, descriptor } = await prepareFixture();
		const commandCount = calls.length;
		await writeFile(descriptor.descriptorPath, `${JSON.stringify({
			...descriptor,
			descriptorPath: join(descriptor.fixtureRoot, "other-descriptor.json"),
		})}\n`);
		const readDescriptor = requireApi("readPreparedPackedConsumerDescriptor");

		await assert.rejects(
			readDescriptor(descriptor.descriptorPath, runRoot),
			/descriptor path does not match the authoritative E2E run layout/,
		);
		assert.equal(calls.length, commandCount, `${FAILURE_PREFIX}: descriptor mismatch must not invoke a package command`);
	});

	it("rejects an external template before copying or invoking package commands", async () => {
		const { runRoot, calls, descriptor } = await prepareFixture();
		const externalRoot = await mkdtemp(join(tmpdir(), "bobbit-packed-external-template-unit-"));
		roots.push(externalRoot);
		const externalTemplate = join(externalRoot, "template");
		await mkdir(externalTemplate, { recursive: true });
		const forged = { ...descriptor, templateDir: externalTemplate };
		const commandCount = calls.length;
		let copies = 0;
		const materialize = requireApi("materializePackedConsumerFixture");

		await assert.rejects(
			materialize(forged, {
				coordinatorRunRoot: runRoot,
				copy: async () => { copies++; },
			}),
			/templateDir must be a strict child of the E2E run root/,
		);
		assert.equal(copies, 0, `${FAILURE_PREFIX}: an external template must be rejected before cp`);
		assert.equal(calls.length, commandCount, `${FAILURE_PREFIX}: rejected materialization must not invoke a package command`);
	});

	it("passes the shrinking preparation budget through dist locking and the owned build command", async () => {
		const fixtureRoot = join(await mkdtemp(join(tmpdir(), "bobbit-packed-dist-budget-unit-")), "fixture");
		roots.push(dirname(fixtureRoot));
		const remaining = [240, 125];
		const commands: unknown[] = [];
		let lockWaitMs: number | undefined;
		let buildTimeoutMs: number | undefined;
		await packedConsumerModule.ensurePackedConsumerDist({
			repoRoot: REPO_ROOT,
			baseEnv: { PATH: process.env.PATH },
			npm: { command: "node", argsPrefix: ["npm-cli.js"] },
			fixtureRoot,
			commands,
			remainingPreparationMs: () => remaining.shift()!,
			ensureDistBuildFn: async (options: { lockWaitMs: number; runBuild: () => Promise<void> }) => {
				lockWaitMs = options.lockWaitMs;
				await options.runBuild();
				return { key: "fixture", cacheHit: false };
			},
			runCommand: async (command: string, args: string[], options: CommandOptions) => {
				buildTimeoutMs = options.timeoutMs;
				assert.equal(command, "node");
				assert.deepEqual(args, ["npm-cli.js", "run", "build"]);
				assert.equal(options.cwd, REPO_ROOT);
				assert.equal((options as CommandOptions & { ownershipBootstrapRoot?: string }).ownershipBootstrapRoot, fixtureRoot);
				return { command, args, code: 0, stdout: "built", stderr: "" };
			},
		});

		assert.equal(lockWaitMs, 240, `${FAILURE_PREFIX}: dist lock must receive only the first remaining budget`);
		assert.equal(buildTimeoutMs, 125, `${FAILURE_PREFIX}: build must receive the smaller later remaining budget`);
		assert.equal(commands.length, 1, `${FAILURE_PREFIX}: build evidence must join the preparation command ledger`);
	});

	it("retains build-stage deadline evidence and never publishes a descriptor", async () => {
		const runRoot = await mkdtemp(join(tmpdir(), "bobbit-packed-build-deadline-unit-"));
		roots.push(runRoot);
		const ticks = [100, 160, 260];
		let observedBuildTimeout: number | undefined;
		const prepare = requireApi("preparePackedConsumerFixture");

		await assert.rejects(prepare({
			repoRoot: REPO_ROOT,
			runRoot,
			preparationTimeoutMs: 120,
			now: () => ticks.shift() ?? 260,
			resolveNpm: () => ({ command: "node", argsPrefix: ["npm-cli.js"] }),
			ensureDist: ({ timeoutMs } = { timeoutMs: 0, fixtureRoot: "", commands: [] }) => {
				observedBuildTimeout = timeoutMs;
			},
			runCommand: async () => { throw new Error("package commands must not start after build deadline exhaustion"); },
		}), /retained partial fixture and command evidence/);

		assert.equal(observedBuildTimeout, 60, `${FAILURE_PREFIX}: build stage must receive the monotonic remaining budget`);
		const fixtureRoot = join(runRoot, "prepared-packed-consumer");
		const evidence = JSON.parse(await readFile(join(fixtureRoot, "preparation-failure.json"), "utf8"));
		assert.match(evidence.error.message, /deadline exhausted before post-build preparation after 160ms \(limit 120ms\)/);
		await assert.rejects(readFile(join(fixtureRoot, "descriptor.json"), "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
	});

	it("retains incomplete build shutdown proof and blocks descriptor publication", async () => {
		const runRoot = await mkdtemp(join(tmpdir(), "bobbit-packed-build-shutdown-unit-"));
		roots.push(runRoot);
		const prepare = requireApi("preparePackedConsumerFixture");
		const shutdown = {
			ownershipState: "established",
			killRequested: true,
			rootCloseObserved: false,
			treeExitAttempted: true,
			treeExitSettled: false,
			treeExitVerified: false,
			completionTimedOut: true,
		};

		await assert.rejects(prepare({
			repoRoot: REPO_ROOT,
			runRoot,
			resolveNpm: () => ({ command: "node", argsPrefix: ["npm-cli.js"] }),
			ensureDist: () => {
				throw new packedConsumerModule.OwnedCommandError("build tree remained live", {
					command: "node",
					args: ["npm-cli.js", "run", "build"],
					cwd: REPO_ROOT,
					shutdown,
				});
			},
			runCommand: async () => { throw new Error("package commands must not start after incomplete build shutdown"); },
		}), /retained partial fixture and command evidence/);

		const fixtureRoot = join(runRoot, "prepared-packed-consumer");
		const evidence = JSON.parse(await readFile(join(fixtureRoot, "preparation-failure.json"), "utf8"));
		assert.equal(evidence.error.message, "build tree remained live");
		assert.deepEqual(evidence.error.shutdown, shutdown);
		assert.deepEqual(evidence.error.args, ["npm-cli.js", "run", "build"]);
		await assert.rejects(readFile(join(fixtureRoot, "descriptor.json"), "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
	});

	it("reports timeout ownership, tree termination, exit state, cwd, and retained output", async () => {
		const child = Object.assign(new EventEmitter(), {
			pid: 4242,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		let fireExecutionTimeout: (() => void) | undefined;
		const running = packedConsumerModule.runOwnedCommand("node", ["npm-cli.js", "install"], {
			cwd: REPO_ROOT,
			timeoutMs: 41,
			ownershipEstablishmentTimeoutMs: 17,
			treeExitTimeoutMs: 29,
			spawnOwned: async () => ({
				child,
				ownershipReady: Promise.resolve(),
				killTree: () => child.emit("close", null, "SIGKILL"),
				waitForTreeExit: async (timeoutMs: number) => {
					assert.equal(timeoutMs, 29);
					return true;
				},
			}),
			setTimer: (callback: () => void, timeoutMs: number) => {
				if (timeoutMs === 41) fireExecutionTimeout = callback;
				return Symbol(`timer-${timeoutMs}`);
			},
			clearTimer: () => {},
		});
		await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate));
		child.stdout.write("retained stdout marker");
		child.stderr.write("retained stderr marker");
		assert.ok(fireExecutionTimeout, `${FAILURE_PREFIX}: execution timeout did not arm`);
		fireExecutionTimeout();

		let failure: unknown;
		try {
			await running;
		} catch (error) {
			failure = error;
		}
		assert.ok(failure instanceof Error, `${FAILURE_PREFIX}: timed-out package command must reject`);
		const diagnostic = failure.message;
		for (const [label, pattern] of [
			["timeout", /timed out after 41ms/i],
			["cwd", new RegExp(REPO_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")],
			["pid", /pid[^\n]*4242/i],
			["ownership", /ownership/i],
			["tree termination", /tree[^\n]*(?:exit|terminat|complete)/i],
			["exit signal", /SIGKILL/i],
			["stdout", /retained stdout marker/],
			["stderr", /retained stderr marker/],
		] as const) {
			assert.match(diagnostic, pattern, `${FAILURE_PREFIX}: timeout diagnostics must include ${label}`);
		}
	});

	it("bounds post-kill completion when neither root close nor tree verification settles", async () => {
		const child = Object.assign(new EventEmitter(), {
			pid: 5151,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		let fireExecutionTimeout: (() => void) | undefined;
		let fireCompletionTimeout: (() => void) | undefined;
		let killCount = 0;
		let treeExitAttempts = 0;
		const completionTimer = Symbol("completion-timer");
		const clearedCompletionTimers: symbol[] = [];
		const running = packedConsumerModule.runOwnedCommand("node", ["npm-cli.js", "install"], {
			cwd: REPO_ROOT,
			timeoutMs: 41,
			ownershipEstablishmentTimeoutMs: 17,
			treeExitTimeoutMs: 29,
			spawnOwned: async () => ({
				child,
				ownershipReady: Promise.resolve(),
				killTree: () => { killCount++; },
				waitForTreeExit: async (timeoutMs: number) => {
					assert.equal(timeoutMs, 29);
					treeExitAttempts++;
					return new Promise<boolean>(() => {});
				},
			}),
			setTimer: (callback: () => void, timeoutMs: number) => {
				if (timeoutMs === 41) fireExecutionTimeout = callback;
				return Symbol(`timer-${timeoutMs}`);
			},
			clearTimer: () => {},
			setCompletionTimer: (callback: () => void, timeoutMs: number) => {
				assert.equal(timeoutMs, 29);
				fireCompletionTimeout = callback;
				return completionTimer;
			},
			clearCompletionTimer: (timer: symbol) => { clearedCompletionTimers.push(timer); },
		});
		await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate));
		child.stdout.write("root-close stdout marker");
		child.stderr.write("root-close stderr marker");
		assert.ok(fireExecutionTimeout, `${FAILURE_PREFIX}: execution timeout did not arm`);
		fireExecutionTimeout();
		await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate));
		assert.equal(killCount, 1, `${FAILURE_PREFIX}: timeout must request one kill`);
		assert.equal(treeExitAttempts, 1, `${FAILURE_PREFIX}: timeout must attempt tree verification without root close`);
		assert.ok(fireCompletionTimeout, `${FAILURE_PREFIX}: post-kill completion timeout did not arm`);
		fireCompletionTimeout();

		await assert.rejects(running, (error: Error) => {
			assert.match(error.message, /timed out after 41ms/i);
			assert.match(error.message, /pid[^\n]*5151/i);
			assert.match(error.message, /root close: not observed within 29ms/i);
			assert.match(error.message, /tree exit: verification did not complete within 29ms/i);
			assert.match(error.message, /root-close stdout marker/);
			assert.match(error.message, /root-close stderr marker/);
			return true;
		});
		assert.equal(killCount, 1, `${FAILURE_PREFIX}: completion expiry must not request another kill`);
		assert.deepEqual(clearedCompletionTimers, [completionTimer]);
		assert.equal(child.listenerCount("error"), 0);
		assert.equal(child.listenerCount("close"), 0);
		assert.equal(child.stdout.listenerCount("data"), 0);
		assert.equal(child.stderr.listenerCount("data"), 0);
	});

	it("bounds tree verification after an overflowing command reports root close", async () => {
		const child = Object.assign(new EventEmitter(), {
			pid: 6161,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		let fireCompletionTimeout: (() => void) | undefined;
		let killCount = 0;
		let treeExitAttempts = 0;
		const completionTimer = Symbol("completion-timer");
		const clearedCompletionTimers: symbol[] = [];
		const running = packedConsumerModule.runOwnedCommand("node", ["npm-cli.js", "pack"], {
			cwd: REPO_ROOT,
			timeoutMs: 1_000,
			maxOutputBytes: 32,
			treeExitTimeoutMs: 37,
			spawnOwned: async () => ({
				child,
				ownershipReady: Promise.resolve(),
				killTree: () => {
					killCount++;
					child.emit("close", null, "SIGKILL");
				},
				waitForTreeExit: async () => {
					treeExitAttempts++;
					return new Promise<boolean>(() => {});
				},
			}),
			setCompletionTimer: (callback: () => void, timeoutMs: number) => {
				assert.equal(timeoutMs, 37);
				fireCompletionTimeout = callback;
				return completionTimer;
			},
			clearCompletionTimer: (timer: symbol) => { clearedCompletionTimers.push(timer); },
		});
		await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate));
		child.stderr.write("retained overflow stderr");
		child.stdout.write("output that crosses the configured maximum");
		await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate));
		assert.equal(killCount, 1, `${FAILURE_PREFIX}: overflow must request one kill`);
		assert.equal(treeExitAttempts, 1);
		assert.ok(fireCompletionTimeout, `${FAILURE_PREFIX}: tree-verification timeout did not arm`);
		fireCompletionTimeout();

		await assert.rejects(running, (error: Error) => {
			assert.match(error.message, /exceeded the 32-byte output limit/i);
			assert.match(error.message, /pid[^\n]*6161/i);
			assert.match(error.message, /root close: code=null, signal=SIGKILL/i);
			assert.match(error.message, /tree exit: verification did not complete within 37ms/i);
			assert.match(error.message, /retained overflow stderr/);
			return true;
		});
		assert.equal(killCount, 1, `${FAILURE_PREFIX}: tree expiry must not request another kill`);
		assert.deepEqual(clearedCompletionTimers, [completionTimer]);
		assert.equal(child.listenerCount("error"), 0);
		assert.equal(child.listenerCount("close"), 0);
		assert.equal(child.stdout.listenerCount("data"), 0);
		assert.equal(child.stderr.listenerCount("data"), 0);
	});
});
