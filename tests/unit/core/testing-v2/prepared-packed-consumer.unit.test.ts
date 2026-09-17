import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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
};

type CommandCall = {
	command: string;
	args: string[];
	options: CommandOptions;
};

type PreparedDescriptor = {
	templateDir: string;
	tarballPath: string;
	cacheDir: string;
};

type PackedConsumerApi = {
	preparePackedConsumerFixture?: (options: {
		repoRoot: string;
		runRoot: string;
		baseEnv?: NodeJS.ProcessEnv;
		ensureDist: () => void | Promise<void>;
		resolveNpm: () => { command: string; argsPrefix: string[] };
		runCommand: (command: string, args: string[], options: CommandOptions) => Promise<{
			command: string;
			args: string[];
			code: number;
			stdout: string;
			stderr: string;
		}>;
	}) => Promise<PreparedDescriptor>;
	materializePackedConsumerFixture?: (
		descriptor: PreparedDescriptor,
		options: { runRoot: string; name?: string },
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

async function prepareFixture() {
	const runRoot = await mkdtemp(join(tmpdir(), "bobbit-prepared-consumer-unit-"));
	roots.push(runRoot);
	const calls: CommandCall[] = [];
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
				await writeFile(join(options.cwd, "package-lock.json"), JSON.stringify({
					name: "prepared-consumer",
					version: "1.0.0",
					lockfileVersion: 3,
					packages: { "": { name: "prepared-consumer", version: "1.0.0" } },
				}));
				return result;
			}
			if (args.includes("install") && args.includes("--offline")) {
				const fixtureModule = join(options.cwd, "node_modules", "fixture-dependency");
				await mkdir(fixtureModule, { recursive: true });
				await writeFile(join(fixtureModule, "marker.txt"), "installed-template");
				await writeFile(join(options.cwd, "package-lock.json"), "{\"lockfileVersion\":3}\n");
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
		const offlineInstalls = calls.filter(call => call.args.includes("install") && call.args.includes("--offline"));

		assert.equal(packCalls.length, 1, `${FAILURE_PREFIX}: preparation must run npm pack exactly once`);
		assert.equal(offlineInstalls.length, 1, `${FAILURE_PREFIX}: preparation must run one offline template install`);
		assert.ok(isStrictChild(runRoot, descriptor.tarballPath), `${FAILURE_PREFIX}: tarball must stay below the run root`);
		assert.ok(isStrictChild(runRoot, descriptor.templateDir), `${FAILURE_PREFIX}: template must stay below the run root`);
		assert.ok(isStrictChild(runRoot, descriptor.cacheDir), `${FAILURE_PREFIX}: npm cache must stay below the run root`);
		assert.equal(await readFile(descriptor.tarballPath, "utf8"), "actual packed bytes");

		const install = offlineInstalls[0]!;
		for (const flag of ["--offline", "--ignore-scripts", "--no-audit", "--no-fund"]) {
			assert.ok(install.args.includes(flag), `${FAILURE_PREFIX}: prepared install must pass ${flag}`);
		}
		assert.ok(
			install.args.some(argument => resolve(argument) === resolve(descriptor.tarballPath)),
			`${FAILURE_PREFIX}: offline install must consume npm pack's actual emitted tarball`,
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

	it("materializes independent copied consumers without rerunning package commands", async () => {
		const { runRoot, calls, descriptor } = await prepareFixture();
		const materialize = requireApi("materializePackedConsumerFixture");
		const packageCommandCount = calls.length;
		const first = consumerPath(await materialize(descriptor, { runRoot, name: "first" }));
		const second = consumerPath(await materialize(descriptor, { runRoot, name: "second" }));

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
