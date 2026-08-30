import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
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
	prewarmPackedConsumerCache,
	runOwnedCommand,
} from "../../scripts/testing-v2/prewarm-packed-consumer-cache.mjs";

const PACKED_CONSUMER_SOURCE = readFileSync(
	new URL("../../tests/e2e/api/pi-packed-consumer.api-e2e.spec.ts", import.meta.url),
	"utf8",
);
const COMMAND_HELPER_SOURCE = readFileSync(
	new URL("../../tests/e2e/test-utils/pi-packed-consumer-command.ts", import.meta.url),
	"utf8",
);
const PREWARM_SOURCE = readFileSync(
	new URL("../../scripts/testing-v2/prewarm-packed-consumer-cache.mjs", import.meta.url),
	"utf8",
);
const WORKFLOW_SOURCE = readFileSync(
	new URL("../../.github/workflows/build-unit-gate.yml", import.meta.url),
	"utf8",
);
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

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
	it("prewarms the restored cache on every E2E OS before the normal gate", () => {
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
		assert.ok(installIndex > setupIndex, "npm ci must populate the restored cache after setup-node");
		assert.equal(steps[installIndex]?.run, "npm ci");
		assert.ok(prewarmIndex > installIndex, "prewarm must follow the lock-driven npm ci");
		assert.equal(steps[prewarmIndex]?.run, "node scripts/testing-v2/prewarm-packed-consumer-cache.mjs");
		assert.equal(steps[prewarmIndex]?.if, undefined, "prewarm must run on every E2E matrix OS");
		assert.ok(gateIndex > prewarmIndex, "the offline E2E must run only after cache preparation");
		assert.equal(steps[gateIndex]?.run, "npm run test:e2e", "the workflow must retain the normal retry-enabled suite command");
	});

	it("builds, packs, and fully installs the exact real tarball with bounded owned processes", () => {
		const source = PREWARM_SOURCE;
		assert.ok(source.indexOf("await ensureDist();") < source.indexOf("await mkdtemp("),
			"the joined build must precede the one disposable root");
		assert.match(source, /const packDir = join\(tempRoot, "pack"\);\s*const consumerDir = join\(tempRoot, "consumer"\);/s);
		assert.match(source, /"pack",\s*"--ignore-scripts",\s*"--json",\s*"--pack-destination",\s*packDir/s);
		assert.match(source, /!Array\.isArray\(parsed\) \|\| parsed\.length !== 1/);
		assert.match(source, /basename\(entry\.filename\) !== entry\.filename/,
			"npm pack's filename must identify one file directly inside the owned pack directory");
		assert.match(source, /const tarball = await stat\(tarballPath\)/,
			"the exact emitted tarball must exist before installation");
		assert.match(source, /"install",\s*"--ignore-scripts",\s*"--no-audit",\s*"--no-fund",\s*tarballPath/s);
		assert.doesNotMatch(source, /["']--(?:offline|prefer-offline|package-lock-only|registry|cache)["']/,
			"prewarm must be one full online install into the inherited cache");
		assert.doesNotMatch(source, /copyFile|symlink|npm-shrinkwrap\.json|bundleDependencies/,
			"prewarm must not seed or copy an installed dependency graph");
		assert.match(source, /const PACK_TIMEOUT_MS = 3 \* 60_000;/);
		assert.match(source, /const INSTALL_TIMEOUT_MS = process\.platform === "win32" \? 15 \* 60_000 : 10 \* 60_000;/);
		assert.match(source, /export const OWNERSHIP_ESTABLISHMENT_TIMEOUT_MS = 30_000;/);
		assert.match(source, /await Promise\.race\(\[\s*tracked\.ownershipReady,/s,
			"spawn-time ownership must have a separate setup deadline before execution timing");
		assert.match(source, /tracked\.killTree\("SIGKILL"\);/);
		assert.match(source, /await tracked\.waitForTreeExit\(treeExitTimeoutMs\)/);
		assert.match(source, /await rm\(tempRoot, \{ recursive: true, force: true, maxRetries: 6, retryDelay: 250 \}\);/,
			"the one owned root must always be removed in finally");
	});

	it("uses a fresh empty consumer while inheriting cache, registry, auth, and config", async () => {
		const tempParent = mkdtempSync(join(tmpdir(), "bobbit-prewarm-pin-"));
		const calls: Array<{ args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }> = [];
		const order: string[] = [];
		try {
			await prewarmPackedConsumerCache({
				repoRoot: REPO_ROOT,
				tempParent,
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
				runCommand: async (command: string, args: string[], options: RunCommandOptions) => {
					calls.push({ args: [...args], cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs });
					if (args.includes("pack")) {
						order.push("pack");
						const packDir = args[args.indexOf("--pack-destination") + 1];
						writeFileSync(join(packDir, "bobbit-1.0.0.tgz"), "real tarball fixture");
						return commandResult(command, args, {
							stdout: JSON.stringify([{ name: "@gresearch/bobbit", filename: "bobbit-1.0.0.tgz" }]),
						});
					}
					order.push("install");
					const manifest = JSON.parse(readFileSync(join(options.cwd, "package.json"), "utf8"));
					assert.deepEqual(manifest, {
						name: "bobbit-packed-cache-prewarm",
						version: "1.0.0",
						private: true,
					});
					assert.deepEqual(readdirSync(options.cwd), ["package.json"],
						"the preparatory consumer must begin without a lock or installed tree");
					return commandResult(command, args);
				},
			});

			assert.deepEqual(order, ["ensure-dist", "pack", "install"]);
			assert.equal(calls.length, 2);
			assert.deepEqual(calls[0]?.args.slice(1), [
				"pack", "--ignore-scripts", "--json", "--pack-destination", calls[0]?.args.at(-1),
			]);
			assert.deepEqual(calls[1]?.args.slice(1, -1), [
				"install", "--ignore-scripts", "--no-audit", "--no-fund",
			]);
			assert.equal(dirname(calls[1]!.args.at(-1)!), calls[0]!.args.at(-1));
			assert.equal(calls[0]?.timeoutMs, 3 * 60_000);
			assert.equal(calls[1]?.timeoutMs, process.platform === "win32" ? 15 * 60_000 : 10 * 60_000);
			const inherited: Record<string, string> = {
				npm_config_cache: "inherited-cache",
				npm_config_registry: "https://registry.example.test/",
				npm_config_userconfig: "inherited-userconfig",
				NODE_AUTH_TOKEN: "inherited-auth",
			};
			for (const [key, value] of Object.entries(inherited)) {
				assert.equal(calls[1]?.env[key], value);
			}
			assert.equal(calls[1]?.env.npm_config_package_lock, undefined);
			assert.equal(calls[1]?.env.npm_lifecycle_event, undefined);
			assert.equal(calls[1]?.env.npm_package_name, undefined);
			assert.equal(calls[1]?.env.INIT_CWD, calls[1]?.cwd);
			assert.deepEqual(readdirSync(tempParent), [], "successful prewarm must remove its disposable root");
		} finally {
			rmSync(tempParent, { recursive: true, force: true });
		}
	});

	it.each([
		{
			label: "malformed pack output",
			pack: { stdout: "[]" },
			expected: /npm pack must report exactly one result/,
		},
		{
			label: "install failure",
			pack: { stdout: JSON.stringify([{ name: "@gresearch/bobbit", filename: "bobbit-1.0.0.tgz" }]) },
			expected: /exited 17/,
		},
	])("propagates $label and still removes the owned root", async ({ pack, expected }) => {
		const tempParent = mkdtempSync(join(tmpdir(), "bobbit-prewarm-failure-pin-"));
		try {
			await assert.rejects(prewarmPackedConsumerCache({
				repoRoot: REPO_ROOT,
				tempParent,
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
					return commandResult(command, args, { code: 17, stderr: "injected install failure" });
				},
			}), expected);
			assert.deepEqual(readdirSync(tempParent), [], "failed prewarm must remove its disposable root");
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

	it("installs the actual local tarball strictly offline with the existing safety timeout", () => {
		const packedConsumer = PACKED_CONSUMER_SOURCE;
		assert.match(
			packedConsumer,
			/const packed = await runNpm\(\["pack", "--json", "--pack-destination", packDir\], PROJECT_ROOT, 3 \* 60_000\);/,
			"the test must create the real publishable tarball",
		);
		assert.match(
			packedConsumer,
			/const tarballPath = resolve\(packDir, packEntry\.filename as string\);\s*expect\(existsSync\(tarballPath\), `npm pack did not create \$\{tarballPath\}`\)\.toBe\(true\);/s,
			"the install target must be npm pack's actual emitted tarball",
		);

		const installCall = packedConsumer.match(
			/const install = await runNpm\((\["install"[^\n]+), consumerDir, (10 \* 60_000), consumerEnv\);/,
		);
		assert.ok(installCall, "packed consumer must retain one explicit npm install call");
		assert.equal(installCall[1], '["install", "--offline", tarballPath]',
			"npm must fail closed on cache misses instead of consulting the registry");
		assert.equal(installCall[2], "10 * 60_000", "the unchanged ten-minute timeout remains only a hard safety bound");
		assert.doesNotMatch(installCall[0], /prefer-offline|registry|cache|force/,
			"the install must not add a best-effort or registry fallback");
		assert.doesNotMatch(packedConsumer, /test\.describe\.configure\(\{[^}]*retries|testInfo\.retry/,
			"the real E2E must retain the suite's normal retry policy");

		const helper = COMMAND_HELPER_SOURCE;
		assert.match(helper, /const env: NodeJS\.ProcessEnv = \{ \.\.\.process\.env \};/,
			"the clean consumer must inherit the prewarmed setup-node cache");
		assert.doesNotMatch(helper, /["']npm_config_cache["']|env\.(?:npm_config_cache|NPM_CONFIG_CACHE)\s*=/,
			"the helper must not redirect offline resolution to an empty per-test cache");
	});

	it("retains a clean consumer and the published security assertions", () => {
		const packedConsumer = PACKED_CONSUMER_SOURCE;
		assert.match(packedConsumer, /const packDir = join\(tempRoot, "pack"\);\s*const consumerDir = join\(tempRoot, "consumer"\);/s,
			"packing and consumer installation must stay in separate directories");
		assert.match(packedConsumer, /name: "bobbit-packed-consumer-e2e",\s*version: "1\.0\.0",\s*private: true,/s,
			"the consumer must begin as an empty package rather than a seeded dependency graph");
		assert.match(packedConsumer, /"clean consumer must use npm's normal package-lock=true default"/);
		assert.match(packedConsumer, /"consumer install must create its own lockfile"/);
		assert.match(packedConsumer, /"published pi-coding-agent must include its dependency-owned shrinkwrap"/);
		assert.match(packedConsumer, /"npm ls must have no invalid, missing, stale, or extraneous edges"/);
		assert.match(packedConsumer, /"packed Bobbit must pin Pi exactly to the supported version"/);
		assert.match(packedConsumer, /`every brace-expansion edge must be 5\.0\.7\+:/);
		assert.match(packedConsumer, /`Pi \$\{selectedPiVersion\} must resolve every protobufjs edge to 7\.6\.5\+:/);
		assert.match(packedConsumer, /expect\(resolution\.source, `\$\{tool\} must resolve from \$\{expectedBinaryPackage\}`\)\.toBe\("bundled"\)/);
		assert.match(packedConsumer, /runPiPackedConsumerCommand\(resolution\.path!, \["--version"\]/,
			"the installed bundled binaries must still execute from the clean consumer");
	});
});
