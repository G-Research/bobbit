import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import YAML from "yaml";
import {
	isCompleteOwnedCommandShutdown,
	lockedTarballsMissingFromRepository,
	OwnedCommandError,
	PACKED_CONSUMER_PREPARATION_TIMEOUT_MS,
	preparePackedConsumerFixture,
	runOwnedCommand,
} from "../../../scripts/testing-v2/prewarm-packed-consumer-cache.mjs";

const PACKED_CONSUMER_SOURCE = readFileSync(
	new URL("../../../tests/e2e/browser/packaged-inline-html-theme.browser-e2e.spec.ts", import.meta.url),
	"utf8",
);
const COMMAND_HELPER_SOURCE = readFileSync(
	new URL("../../../tests/e2e/test-utils/pi-packed-consumer-command.ts", import.meta.url),
	"utf8",
);
const PREWARM_SOURCE = readFileSync(
	new URL("../../../scripts/testing-v2/prewarm-packed-consumer-cache.mjs", import.meta.url),
	"utf8",
);
const WORKFLOW_SOURCE = readFileSync(
	new URL("../../../.github/workflows/build-unit-gate.yml", import.meta.url),
	"utf8",
);
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PACKAGE_MANIFEST = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { files: string[] };
const PACKAGE_LOCK = JSON.parse(readFileSync(join(REPO_ROOT, "package-lock.json"), "utf8")) as {
	packages?: Record<string, { version?: string; gypfile?: boolean }>;
};

type WorkflowStep = {
	name: string;
	if?: string;
	run?: string;
	with?: Record<string, unknown>;
};

type Workflow = {
	jobs: {
		e2e: {
			strategy: { matrix: { os: string[] } };
			steps: WorkflowStep[];
		};
	};
};

type RunCommandOptions = {
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
};

function commandResult(command: string, args: string[], overrides: Partial<{
	code: number;
	stdout: string;
	stderr: string;
}> = {}) {
	return {
		command,
		args: [...args],
		code: overrides.code ?? 0,
		stdout: overrides.stdout ?? "",
		stderr: overrides.stderr ?? "",
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

function invokeTimer(callback: (() => void) | undefined, message: string): void {
	assert.ok(callback, message);
	callback();
}

describe("packed-consumer offline install contract", () => {
	it("retains better-sqlite3's published no-gyp-install metadata in the root lock", () => {
		const lockedPackage = PACKAGE_LOCK.packages?.["node_modules/better-sqlite3"];
		assert.equal(lockedPackage?.version, "13.0.3");
		assert.equal(lockedPackage?.gypfile, false,
			"npm ci must not synthesize node-gyp rebuild for the prebuilt native package");
	});

	it("resolves checkout-only support before creating a clean packed consumer", () => {
		const supportRoot = join(REPO_ROOT, "tests", "support");
		const canonicalBudget = join(supportRoot, "data", "quality", "budgets", "budgets.json");
		assert.equal(existsSync(canonicalBudget), true);
		assert.equal(canonicalBudget.replaceAll("\\", "/").endsWith("tests/support/data/quality/budgets/budgets.json"), true);
		assert.equal(PACKAGE_MANIFEST.files.some(entry => entry.replaceAll("\\", "/").startsWith("tests/support")), false,
			"repository test support must remain excluded from the published package");
	});

	it("prepares the packed consumer inside the E2E run instead of a redundant CI prewarm", () => {
		const workflow = YAML.parse(WORKFLOW_SOURCE) as Workflow;
		const e2e = workflow.jobs.e2e;
		const steps = e2e.steps;
		const setupIndex = steps.findIndex(step => step.name === "Set up Node");
		const installIndex = steps.findIndex(step => step.name === "Install");
		const prewarmIndex = steps.findIndex(step => step.name === "Warm packed-consumer npm cache");
		const gateIndex = steps.findIndex(step => step.name === "E2E gate");

		assert.deepEqual(e2e.strategy.matrix.os, ["ubuntu-latest", "windows-latest", "macos-latest"]);
		assert.ok(setupIndex >= 0, "E2E must configure Node and the npm cache");
		assert.deepEqual(steps[setupIndex]?.with, { "node-version": "22.19.0", cache: "npm" });
		assert.ok(installIndex > setupIndex, "npm ci must follow setup-node");
		assert.equal(steps[installIndex]?.run, "npm ci");
		assert.equal(prewarmIndex, -1, "CI must not duplicate run-scoped packed-consumer preparation");
		assert.ok(gateIndex > installIndex, "the E2E runner owns packed-consumer preparation");
		assert.equal(steps[gateIndex]?.run, "npm run test:e2e", "the workflow must retain the normal retry-enabled suite command");
	});

	it("builds one exact tarball and one strict-offline template in the run root", () => {
		const source = PREWARM_SOURCE;
		assert.match(source, /const fixtureRoot = join\(absoluteRunRoot, FIXTURE_DIRECTORY\)/);
		assert.match(source, /"pack", "--ignore-scripts", "--json", "--pack-destination", packDir/);
		assert.match(source, /!Array\.isArray\(parsed\) \|\| parsed\.length !== 1/);
		assert.match(source, /basename\(entry\.filename\) !== entry\.filename/,
			"npm pack's filename must identify one file directly inside the owned pack directory");
		assert.match(source, /const tarball = await stat\(tarballPath\)/,
			"the exact emitted tarball must exist before dependency resolution");
		assert.match(source, /"install",\s*"--package-lock-only",\s*"--ignore-scripts",\s*"--no-audit",\s*"--no-fund",\s*"--cache", cacheDir,\s*tarballPath/s);
		assert.match(source, /"cache", "add", "--cache", cacheDir, \.\.\.batch/);
		assert.match(source, /"ci",\s*"--offline",\s*"--ignore-scripts",\s*"--no-audit",\s*"--no-fund",\s*"--cache", cacheDir/s);
		assert.doesNotMatch(source, /"ci",[\s\S]{0,200}tarballPath/,
			"offline npm ci must materialize the generated lock without a second package operand");
		assert.match(source, /await copy\(validated\.templateDir, consumerDir/,
			"materialization must copy the prepared installed dependency graph");
		assert.match(source, /const OFFLINE_INSTALL_TIMEOUT_MS = 10 \* 60_000;/);
		assert.match(source, /export const PACKED_CONSUMER_PREPARATION_TIMEOUT_MS = 5 \* 60_000;/);
		assert.match(source, /remainingCommandTimeout\("offline npm ci", OFFLINE_INSTALL_TIMEOUT_MS\)/,
			"the former 600-second install budget must be capped by the preparation-wide deadline");
		assert.match(source, /export const OWNERSHIP_ESTABLISHMENT_TIMEOUT_MS = 30_000;/);
		assert.match(source, /await Promise\.race\(\[\s*tracked\.ownershipReady,/s,
			"spawn-time ownership must have a separate setup deadline before execution timing");
		assert.match(source, /tracked\.killTree\("SIGKILL"\);/);
		assert.match(source, /await tracked\.waitForTreeExit\(treeExitTimeoutMs\)/);
		assert.match(source, /await rename\(temporaryDescriptor, descriptorPath\)/,
			"the descriptor must publish atomically after validation");
	});

	it("resolves a fresh empty consumer and caches only newly selected tarballs", async () => {
		const tempParent = mkdtempSync(join(tmpdir(), "bobbit-prewarm-pin-"));
		const calls: Array<{ args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }> = [];
		const order: string[] = [];
		let nowMs = 0;
		const selectedUrl = "https://registry.example.test/new-dependency/-/new-dependency-1.2.3.tgz";
		try {
			await preparePackedConsumerFixture({
				repoRoot: REPO_ROOT,
				runRoot: tempParent,
				baseEnv: {
					PATH: process.env.PATH,
					npm_config_cache: "inherited-cache",
					npm_config_registry: "https://registry.example.test/",
					npm_config_userconfig: "inherited-userconfig",
					NODE_AUTH_TOKEN: "inherited-auth",
					npm_config_package_lock: "false",
					npm_lifecycle_event: "test:e2e",
					npm_package_name: "bobbit",
				},
				ensureDist: () => { order.push("ensure-dist"); },
				resolveNpm: () => ({ command: "node", argsPrefix: ["npm-cli.js"] }),
				now: () => nowMs,
				runCommand: async (command: string, args: string[], options: RunCommandOptions) => {
					calls.push({ args: [...args], cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs });
					nowMs += 5_000;
					if (args.includes("pack")) {
						order.push("pack");
						const packDir = args[args.indexOf("--pack-destination") + 1];
						writeFileSync(join(packDir, "bobbit-1.0.0.tgz"), "real tarball fixture");
						return commandResult(command, args, {
							stdout: JSON.stringify([{ name: "@gresearch/bobbit", filename: "bobbit-1.0.0.tgz" }]),
						});
					}
					if (args.includes("--package-lock-only")) {
						order.push("resolve");
						const manifest = JSON.parse(readFileSync(join(options.cwd, "package.json"), "utf8"));
						assert.equal(manifest.name, "bobbit-inline-theme-clean-consumer");
						assert.equal(manifest.private, true);
						assert.deepEqual(readdirSync(options.cwd), ["package.json"],
							"dependency resolution must begin without a lock or installed tree");
						manifest.dependencies = { "@gresearch/bobbit": "file:../../pack/bobbit-1.0.0.tgz" };
						writeFileSync(join(options.cwd, "package.json"), `${JSON.stringify(manifest)}\n`);
						writeFileSync(join(options.cwd, "package-lock.json"), JSON.stringify({
							name: "bobbit-inline-theme-clean-consumer",
							version: "1.0.0",
							lockfileVersion: 3,
							packages: {
								"": {
									name: "bobbit-inline-theme-clean-consumer",
									version: "1.0.0",
									dependencies: manifest.dependencies,
								},
								"node_modules/@gresearch/bobbit": {
									version: "1.0.0",
									resolved: "file:../../pack/bobbit-1.0.0.tgz",
								},
								"node_modules/new-dependency": {
									version: "1.2.3",
									resolved: selectedUrl,
									integrity: "sha512-fixture",
								},
							},
						}));
						return commandResult(command, args);
					}
					if (args.includes("--offline")) {
						order.push("install");
						const stagedManifest = JSON.parse(readFileSync(join(options.cwd, "package.json"), "utf8"));
						const stagedLock = JSON.parse(readFileSync(join(options.cwd, "package-lock.json"), "utf8"));
						assert.deepEqual(stagedManifest.dependencies, {
							"@gresearch/bobbit": "file:../../pack/bobbit-1.0.0.tgz",
						}, "the offline install must reuse the resolver's exact packed-artifact manifest");
						assert.deepEqual(stagedLock.packages[""].dependencies, stagedManifest.dependencies,
							"the offline install must start from the generated lock instead of resolving the graph again");
						mkdirSync(join(options.cwd, "node_modules"), { recursive: true });
						return commandResult(command, args);
					}
					order.push("cache");
					return commandResult(command, args);
				},
			});

			assert.deepEqual(order, ["ensure-dist", "pack", "resolve", "cache", "install"]);
			assert.equal(calls.length, 4);
			assert.deepEqual(calls[0]?.args.slice(1), [
				"pack", "--ignore-scripts", "--json", "--pack-destination", calls[0]?.args.at(-1),
			]);
			assert.deepEqual(calls[1]?.args.slice(1, 6), [
				"install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund",
			]);
			assert.equal(dirname(calls[1]!.args.at(-1)!), calls[0]!.args.at(-1));
			assert.deepEqual(calls[2]?.args.slice(0, 4), ["npm-cli.js", "cache", "add", "--cache"]);
			assert.equal(calls[2]?.args.at(-1), selectedUrl);
			assert.equal(calls[3]?.args[1], "ci");
			assert.ok(calls[3]?.args.includes("--offline"));
			assert.ok(!calls[3]?.args.includes(calls[1]!.args.at(-1)!),
				"offline npm ci must not trigger a second lock-free packed-artifact solve");
			assert.equal(calls[0]?.timeoutMs, 3 * 60_000);
			assert.equal(calls[1]?.timeoutMs, PACKED_CONSUMER_PREPARATION_TIMEOUT_MS - 5_000);
			assert.equal(calls[2]?.timeoutMs, 3 * 60_000);
			assert.equal(calls[3]?.timeoutMs, PACKED_CONSUMER_PREPARATION_TIMEOUT_MS - 15_000,
				"late commands must receive only the remaining monotonic preparation budget");
			const inherited: Record<string, string> = {
				npm_config_cache: "inherited-cache",
				npm_config_registry: "https://registry.example.test/",
				npm_config_userconfig: "inherited-userconfig",
				NODE_AUTH_TOKEN: "inherited-auth",
			};
			for (const call of calls.slice(1)) {
				for (const [key, value] of Object.entries(inherited).filter(([key]) => key !== "npm_config_cache")) assert.equal(call.env[key], value);
				assert.notEqual(call.env.npm_config_cache, inherited.npm_config_cache);
				assert.ok(call.env.npm_config_cache?.startsWith(tempParent));
				assert.equal(call.env.npm_config_package_lock, undefined);
				assert.equal(call.env.npm_lifecycle_event, undefined);
				assert.equal(call.env.npm_package_name, undefined);
				assert.equal(call.env.INIT_CWD, call.cwd);
			}
			assert.ok(readdirSync(tempParent).includes("prepared-packed-consumer"), "successful preparation must retain its descriptor and template");
		} finally {
			rmSync(tempParent, { recursive: true, force: true });
		}
	});

	it("deduplicates missing tarballs and excludes incompatible native packages", () => {
		const shared = "https://registry.example.test/shared/-/shared-1.0.0.tgz";
		const any = "https://registry.example.test/any/-/any-1.0.0.tgz";
		const windows = "https://registry.example.test/native/-/native-win32-1.0.0.tgz";
		const linux = "https://registry.example.test/native/-/native-linux-1.0.0.tgz";
		const scalarWindows = "https://registry.example.test/scalar/-/scalar-win32-1.0.0.tgz";
		const lock = (packages: Record<string, unknown>) => ({ lockfileVersion: 3, packages });
		const repository = lock({
			"node_modules/shared": { version: "1.0.0", resolved: shared },
		});
		const consumer = lock({
			"node_modules/a": { version: "1.0.0", resolved: shared },
			"node_modules/a/node_modules/shared": { version: "1.0.0", resolved: shared },
			"node_modules/any": { version: "1.0.0", resolved: any, os: ["any"] },
			"node_modules/native-win32": { version: "1.0.0", resolved: windows, os: ["win32"], cpu: ["x64"] },
			"node_modules/native-linux": { version: "1.0.0", resolved: linux, os: ["linux"], cpu: ["x64"] },
			"node_modules/scalar-win32": { version: "1.0.0", resolved: scalarWindows, os: "win32", cpu: "x64" },
		});
		assert.deepEqual(
			lockedTarballsMissingFromRepository(consumer, repository, { platform: "win32", arch: "x64" }),
			[any, windows, scalarWindows],
		);
		assert.deepEqual(
			lockedTarballsMissingFromRepository(consumer, repository, { platform: "linux", arch: "x64", libc: "glibc" }),
			[any, linux],
		);
	});

	it.each([
		{
			label: "malformed pack output",
			pack: { stdout: "[]" },
			expected: /npm pack must report exactly one result/,
			expectedCommands: 1,
			expectedLastCode: 0,
		},
		{
			label: "lock resolution failure",
			pack: { stdout: JSON.stringify([{ name: "@gresearch/bobbit", filename: "bobbit-1.0.0.tgz" }]) },
			expected: /exited 17/,
			expectedCommands: 2,
			expectedLastCode: 17,
		},
	])("propagates $label and retains partial fixture command evidence", async ({ pack, expected, expectedCommands, expectedLastCode }) => {
		const tempParent = mkdtempSync(join(tmpdir(), "bobbit-prewarm-failure-pin-"));
		try {
			await assert.rejects(preparePackedConsumerFixture({
				repoRoot: REPO_ROOT,
				runRoot: tempParent,
				ensureDist: () => {},
				resolveNpm: () => ({ command: "node", argsPrefix: ["npm-cli.js"] }),
				runCommand: async (command: string, args: string[]) => {
					if (args.includes("pack")) {
						if (pack.stdout !== "[]") {
							const packDir = args[args.indexOf("--pack-destination") + 1];
							writeFileSync(join(packDir, "bobbit-1.0.0.tgz"), "real tarball fixture");
						}
						return commandResult(command, args, pack);
					}
					return commandResult(command, args, { code: 17, stderr: "injected lock resolution failure" });
				},
			}), (error: Error) => {
				assert.match(error.message, expected);
				assert.match(error.message, /retained partial fixture and command evidence/);
				return true;
			});
			const fixtureRoot = join(tempParent, "prepared-packed-consumer");
			const evidencePath = join(fixtureRoot, "preparation-failure.json");
			assert.ok(readdirSync(tempParent).includes("prepared-packed-consumer"), "failed preparation must remain in the coordinator-owned run root");
			const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
			assert.equal(evidence.status, "failed");
			assert.equal(evidence.fixtureRoot, fixtureRoot);
			assert.match(evidence.error.message, expected);
			assert.equal(evidence.commands.length, expectedCommands);
			assert.equal(evidence.commands.at(-1)?.code, expectedLastCode,
				"failure evidence must include the last completed command result, including nonzero exits");
		} finally {
			rmSync(tempParent, { recursive: true, force: true });
		}
	});

	it("caps a live command by the remaining preparation deadline, joins its tree, and retains evidence", async () => {
		const tempParent = mkdtempSync(join(tmpdir(), "bobbit-prewarm-deadline-pin-"));
		const child = Object.assign(new EventEmitter(), {
			pid: 4242,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		let nowMs = 0;
		let observedTimeoutMs: number | undefined;
		let killCount = 0;
		let completionJoins = 0;
		try {
			await assert.rejects(preparePackedConsumerFixture({
				repoRoot: REPO_ROOT,
				runRoot: tempParent,
				preparationTimeoutMs: 50,
				now: () => nowMs,
				ensureDist: () => { nowMs = 10; },
				resolveNpm: () => ({ command: "node", argsPrefix: ["npm-cli.js"] }),
				runCommand: async (command: string, args: string[], options: RunCommandOptions) => {
					observedTimeoutMs = options.timeoutMs;
					return runOwnedCommand(command, args, {
						cwd: options.cwd,
						env: options.env,
						timeoutMs: options.timeoutMs,
						spawnOwned: async () => ({
							child,
							ownershipReady: Promise.resolve(),
							killTree: () => {
								killCount++;
								child.emit("close", null, "SIGKILL");
							},
							waitForTreeExit: async () => {
								completionJoins++;
								return true;
							},
						}),
						setTimer: (callback: () => void, timeoutMs: number) => {
							if (timeoutMs === observedTimeoutMs) queueMicrotask(callback);
							return Symbol(`timer-${timeoutMs}`);
						},
						clearTimer: () => {},
						setCompletionTimer: () => Symbol("completion-timer"),
						clearCompletionTimer: () => {},
					});
				},
			}), (error: Error) => {
				assert.match(error.message, /retained partial fixture and command evidence/);
				assert.match(error.message, /timed out after 40ms/);
				return true;
			});

			assert.equal(observedTimeoutMs, 40, "npm pack receives only the deadline remainder after build preparation");
			assert.equal(killCount, 1, "deadline expiry terminates the one owned process tree");
			assert.equal(completionJoins, 1, "preparation does not reject until complete tree exit is verified");
			const fixtureRoot = join(tempParent, "prepared-packed-consumer");
			const evidence = JSON.parse(readFileSync(join(fixtureRoot, "preparation-failure.json"), "utf8"));
			assert.match(evidence.error.message, /timed out after 40ms/);
			assert.match(evidence.error.message, /tree exit: verified complete/);
			assert.equal(existsSync(join(fixtureRoot, "descriptor.json")), false,
				"deadline failure must not publish a descriptor that could start Group C");
		} finally {
			rmSync(tempParent, { recursive: true, force: true });
		}
	});

	it("kills an overflowing owned process once and joins verified completion", async () => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		let killCount = 0;
		let completionJoins = 0;
		const running = runOwnedCommand("node", ["npm-cli.js", "pack"], {
			cwd: REPO_ROOT,
			timeoutMs: 1_000,
			maxOutputBytes: 4,
			spawnOwned: async () => ({
				child,
				ownershipReady: Promise.resolve(),
				killTree: () => {
					killCount++;
					child.emit("close", null, "SIGKILL");
				},
				waitForTreeExit: async () => {
					completionJoins++;
					return true;
				},
			}),
		});
		await Promise.resolve();
		child.stdout.write("12345");
		await assert.rejects(running, /exceeded the 4-byte output limit/);
		assert.equal(killCount, 1, "overflow must request one owned kill");
		assert.equal(completionJoins, 1, "failure must join verified tree completion");
	});

	it("starts the unchanged execution timeout only after prompt ownership readiness", async () => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		const ownership = deferred<void>();
		let fireExecutionTimeout: (() => void) | undefined;
		let killCount = 0;
		let completionJoins = 0;
		const clearedTimers: symbol[] = [];
		const ownershipTimerToken = Symbol("ownership-timer");
		const executionTimerToken = Symbol("execution-timer");
		const running = runOwnedCommand("node", ["npm-cli.js", "install"], {
			cwd: REPO_ROOT,
			timeoutMs: 321,
			ownershipEstablishmentTimeoutMs: 17,
			spawnOwned: async () => ({
				child,
				ownershipReady: ownership.promise,
				killTree: () => {
					killCount++;
					child.emit("close", null, "SIGKILL");
				},
				waitForTreeExit: async () => {
					completionJoins++;
					return true;
				},
			}),
			setTimer: (callback: () => void, timeoutMs: number) => {
				if (timeoutMs === 17) return ownershipTimerToken;
				assert.equal(timeoutMs, 321, "execution must retain its full configured budget");
				fireExecutionTimeout = callback;
				return executionTimerToken;
			},
			clearTimer: (token: symbol) => { clearedTimers.push(token); },
		});
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(fireExecutionTimeout, undefined, "execution timer must remain disarmed during ownership setup");
		ownership.resolve(undefined);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(clearedTimers, [ownershipTimerToken], "prompt readiness must clear its losing setup timer");
		invokeTimer(fireExecutionTimeout, "execution timer must arm after ownership readiness");
		await assert.rejects(running, /timed out after 321ms/);
		assert.equal(killCount, 1, "timeout must request one owned kill");
		assert.equal(completionJoins, 1, "timeout must join verified tree completion");
		assert.deepEqual(clearedTimers, [ownershipTimerToken, executionTimerToken]);
	});

	it("clears the setup timer when deferred ownership rejects", async () => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		const ownership = deferred<void>();
		const timerToken = Symbol("ownership-timer");
		const timerDurations: number[] = [];
		const clearedTimers: symbol[] = [];
		let killCount = 0;
		const running = runOwnedCommand("node", ["npm-cli.js", "pack"], {
			cwd: REPO_ROOT,
			timeoutMs: 321,
			ownershipEstablishmentTimeoutMs: 17,
			spawnOwned: async () => ({
				child,
				ownershipReady: ownership.promise,
				killTree: () => {
					killCount++;
					child.emit("close", null, "SIGKILL");
				},
				waitForTreeExit: async () => true,
			}),
			setTimer: (_callback: () => void, timeoutMs: number) => {
				timerDurations.push(timeoutMs);
				return timerToken;
			},
			clearTimer: (token: symbol) => { clearedTimers.push(token); },
		});
		await new Promise<void>(resolve => setImmediate(resolve));
		ownership.reject(new Error("injected ownership failure"));
		await assert.rejects(running, /did not establish process-tree ownership/);
		assert.equal(killCount, 1);
		assert.deepEqual(timerDurations, [17], "execution timer must not arm after rejected ownership");
		assert.deepEqual(clearedTimers, [timerToken], "rejected ownership must clear its losing setup timer");
	});

	it.each(["resolve", "reject"] as const)(
		"bounds deferred ownership setup, joins cleanup, and ignores late %s",
		async lateSettlement => {
			const child = Object.assign(new EventEmitter(), {
				stdout: new PassThrough(),
				stderr: new PassThrough(),
			});
			const ownership = deferred<void>();
			const treeExit = deferred<boolean>();
			const timerToken = Symbol("ownership-timer");
			let fireOwnershipTimeout: (() => void) | undefined;
			let killCount = 0;
			let completionJoins = 0;
			let settled = false;
			const clearedTimers: symbol[] = [];
			const timerDurations: number[] = [];
			const running = runOwnedCommand("node", ["npm-cli.js", "install"], {
				cwd: REPO_ROOT,
				timeoutMs: 321,
				ownershipEstablishmentTimeoutMs: 17,
				treeExitTimeoutMs: 43,
				spawnOwned: async () => ({
					child,
					ownershipReady: ownership.promise,
					killTree: () => { killCount++; },
					waitForTreeExit: async (timeoutMs: number) => {
						assert.equal(timeoutMs, 43);
						completionJoins++;
						return treeExit.promise;
					},
				}),
				setTimer: (callback: () => void, timeoutMs: number) => {
					timerDurations.push(timeoutMs);
					fireOwnershipTimeout = callback;
					return timerToken;
				},
				clearTimer: (token: symbol) => { clearedTimers.push(token); },
			});
			const observed = running.then(
				(value: unknown) => { settled = true; return { value }; },
				(error: unknown) => { settled = true; return { error }; },
			);

			await new Promise<void>(resolve => setImmediate(resolve));
			assert.deepEqual(timerDurations, [17], "setup must use only its exact separate bound");
			invokeTimer(fireOwnershipTimeout, "ownership setup timer must arm with the injected bound");
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(killCount, 1, "setup expiry must request exactly one owned kill");
			assert.deepEqual(timerDurations, [17], "execution timer must never arm after setup expiry");
			assert.deepEqual(clearedTimers, [timerToken], "expired setup timer must be cleared");
			assert.equal(settled, false, "rejection must wait for the child close boundary");

			child.emit("close", null, "SIGKILL");
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(completionJoins, 1, "close must be followed by bounded tree verification");
			assert.equal(settled, false, "rejection must wait for verified tree completion");
			assert.equal(child.listenerCount("error"), 0);
			assert.equal(child.listenerCount("close"), 0);
			assert.equal(child.stdout.listenerCount("data"), 0);
			assert.equal(child.stderr.listenerCount("data"), 0);

			treeExit.resolve(true);
			const result = await observed;
			assert.ok("error" in result);
			assert.match(String(result.error), /ownership readiness timed out after 17ms/);
			assert.ok(result.error instanceof OwnedCommandError);
			const shutdown = (result.error as { shutdown: Record<string, unknown> }).shutdown;
			assert.deepEqual(shutdown, {
				ownershipState: "timed out",
				killRequested: true,
				rootCloseObserved: true,
				rootExitCode: null,
				rootSignal: "SIGKILL",
				treeExitAttempted: true,
				treeExitSettled: true,
				treeExitVerified: true,
				completionTimedOut: false,
			});
			assert.equal(isCompleteOwnedCommandShutdown(shutdown), false,
				"verified tree exit before ownership acknowledgement must remain incomplete proof");

			if (lateSettlement === "resolve") ownership.resolve(undefined);
			else ownership.reject(new Error("late injected ownership rejection"));
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(killCount, 1, "late ownership settlement must not reverse the terminal result");
			assert.deepEqual(timerDurations, [17], "late ownership settlement must not arm a timer");
		},
	);

	it("rejects a non-positive ownership-establishment bound before spawning", async () => {
		let spawned = false;
		await assert.rejects(runOwnedCommand("node", [], {
			cwd: REPO_ROOT,
			timeoutMs: 1,
			ownershipEstablishmentTimeoutMs: 0,
			spawnOwned: async () => { spawned = true; throw new Error("must not spawn"); },
		}), /ownershipEstablishmentTimeoutMs must be a positive number/);
		assert.equal(spawned, false);
	});

	it("returns normal success only after verified owned-tree completion", async () => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		let completionJoins = 0;
		const running = runOwnedCommand("node", ["npm-cli.js", "pack"], {
			cwd: REPO_ROOT,
			timeoutMs: 1_000,
			spawnOwned: async () => ({
				child,
				ownershipReady: Promise.resolve(),
				killTree: () => { throw new Error("normal close must not request a kill"); },
				waitForTreeExit: async () => {
					completionJoins++;
					return true;
				},
			}),
		});
		await Promise.resolve();
		child.stdout.write("pack json");
		child.emit("close", 0, null);
		const result = await running;
		assert.equal(result.code, 0);
		assert.equal(result.stdout, "pack json");
		assert.equal(completionJoins, 1, "normal success must join verified tree completion");
	});

	it("fails closed when normal process close lacks verified tree completion", async () => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		const running = runOwnedCommand("node", ["npm-cli.js", "pack"], {
			cwd: REPO_ROOT,
			timeoutMs: 1_000,
			spawnOwned: async () => ({
				child,
				ownershipReady: Promise.resolve(),
				killTree: () => { throw new Error("normal close must not request a kill"); },
				waitForTreeExit: async () => false,
			}),
		});
		await Promise.resolve();
		child.emit("close", 0, null);
		await assert.rejects(running, /closed without verified process-tree completion/);
	});

	it("hands the actual packed tarball and strict-offline install evidence to the browser", () => {
		const packedConsumer = PACKED_CONSUMER_SOURCE;
		assert.match(packedConsumer, /const descriptorPath = resolvePackedConsumerDescriptorPath\(process\.env, coordinatorRunRoot!\)/,
			"the browser journey must resolve the canonical coordinator-owned descriptor path");
		assert.match(packedConsumer, /readPreparedPackedConsumerDescriptor\(descriptorPath, coordinatorRunRoot!\)/,
			"the browser journey must bind the canonical descriptor to the authoritative coordinator root");
		assert.match(packedConsumer, /materializePackedConsumerFixture\(descriptor, \{\s*coordinatorRunRoot: coordinatorRunRoot!/s,
			"the browser journey must use an authoritative-root-bound private template copy");
		assert.match(packedConsumer, /const tarballPath = resolve\(descriptor\.tarballPath\)/,
			"the browser must validate npm pack's actual emitted tarball");
		assert.match(packedConsumer, /packed tarball must be owned by the authoritative coordinator root/,
			"the packed tarball must remain bound to the coordinator root");
		assert.match(packedConsumer, /executed packed CLI must be owned by the authoritative coordinator root/,
			"the executed CLI must come from the coordinator-owned consumer copy");
		assert.match(packedConsumer, /command\.args\.includes\("ci"\) && command\.args\.includes\("--offline"\)/,
			"the browser must verify strict-offline npm ci evidence");
		assert.match(packedConsumer, /\["--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--cache"\]/,
			"deterministic npm ci flags must remain asserted");
		assert.match(packedConsumer, /prepared npm ci must use the descriptor's isolated cache/,
			"the browser must bind npm ci to the prepared fixture's isolated cache");
		assert.match(packedConsumer, /offline npm ci must not receive a package operand/,
			"the browser must reject a second packed-artifact operand during lock-driven npm ci");
		assert.match(packedConsumer, /installedPackages\[`node_modules\/\$\{PACKAGE_NAME\}`\]\?\.resolved/,
			"the copied consumer lock must prove the installed package resolves from the packed artifact");
		assert.match(packedConsumer, /consumer lock \$\{label\} must resolve to the actual packed tarball/,
			"the browser must bind the copied lock reference to the coordinator's actual tarball");
		assert.match(packedConsumer, /test\.describe\.configure\(\{ retries: 0 \}\)/,
			"the retained clean-consumer browser journey must remain first-attempt only");
		assert.doesNotMatch(packedConsumer, /testInfo\.retry/,
			"the journey must not branch on or hide a retry");

		const helper = COMMAND_HELPER_SOURCE;
		assert.match(helper, /runOwnedCommand\(command, args/,
			"all remaining consumer package commands must use tracked tree ownership");
	});

	it("retains a clean consumer and the published security assertions", () => {
		const packedConsumer = PACKED_CONSUMER_SOURCE;
		assert.match(PREWARM_SOURCE, /const resolverDir = join\(preparationDir, "resolver"\);\s*const templateDir = join\(preparationDir, "template"\);/s,
			"lock-free resolution and the installed template must stay separate");
		assert.match(PREWARM_SOURCE, /name: "bobbit-inline-theme-clean-consumer",\s*version: "1\.0\.0",\s*private: true,/s,
			"the prepared consumer must begin as an empty external package");
		assert.match(packedConsumer, /"clean consumer must use npm's normal package-lock=true default"/);
		assert.match(packedConsumer, /"consumer install must create its own lockfile"/);
		assert.match(packedConsumer, /"published pi-coding-agent must include its dependency-owned shrinkwrap"/);
		assert.match(packedConsumer, /"npm ls must have no invalid, missing, stale, or extraneous edges"/);
		assert.match(packedConsumer, /const REQUIRED_PI_VERSION = "0\.85\.1";/,
			"the packed consumer must pin the selected Pi compatibility line");
		assert.match(packedConsumer, /const MINIMUM_PI_NODE_VERSION = "22\.19\.0";/,
			"the packed consumer must enforce Pi's Node engine floor");
		assert.match(packedConsumer, /"packed Bobbit must pin Pi exactly to the supported version"/);
		assert.match(packedConsumer, /installedPiManifest\.bin\?\.pi[^\n]+\.toBe\("dist\/bundle\/cli\.js"\)/,
			"the packed consumer must resolve Pi's declared bundled entrypoint");
		assert.match(packedConsumer, /runPiPackedConsumerCommand\(process\.execPath, \[declaredPiCli, "--version"\]/,
			"the declared Pi entrypoint must execute under the compatible consumer runtime");
		assert.match(packedConsumer, /`every brace-expansion edge must be 5\.0\.7\+:/);
		assert.match(packedConsumer, /`Pi \$\{selectedPiVersion\} must resolve every protobufjs edge to 7\.6\.5\+:/);
		assert.match(packedConsumer, /expect\(resolution\.source, `\$\{tool\} must resolve from \$\{expectedBinaryPackage\}`\)\.toBe\("bundled"\)/);
		assert.match(packedConsumer, /runPiPackedConsumerCommand\(resolution\.path!, \["--version"\]/,
			"the installed bundled binaries must still execute from the clean consumer");
	});
});
