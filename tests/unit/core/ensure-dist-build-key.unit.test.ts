/**
 * Pins the content-addressed dist build cache (scripts/testing-v2/ensure-dist.mjs)
 * used by test:e2e:v2 and tests2/browser-global-setup.ts: changed build inputs
 * must change the key, and validation must fail closed on a missing/stale
 * manifest or missing build artifacts so a stale dist can never be silently
 * tested. Modeled on tests/unit/core/server-prebundle-cache.unit.test.ts; uses an owned
 * temp fixture and real child processes with a synthetic build — never npm.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
	computeDistBuildKey,
	distBuildLockPath,
	validateDistBuild,
} from "../../../scripts/testing-v2/ensure-dist.mjs";

type NativeSpawn = typeof import("node:child_process").spawn;
type SpawnGuardState = { originals?: { spawn?: NativeSpawn } };
const SPAWN_GUARD_STATE = Symbol.for("bobbit.tests2.tier1-spawn-guard-state");

const BASE_FILES: Record<string, string> = {
	"src/server/cli.ts": "export const cli = 1;\n",
	"src/shared/value.ts": "export const value = 1;\n",
	"src/ui/app.ts": "export const app = 1;\n",
	"defaults/roles/basic.yaml": "name: basic\n",
	"market-packs/demo/pack.yaml": "name: demo\n",
	"market-packs/demo/src/panel.ts": "export const panel = 1;\n",
	"public/sw.js": "// sw\n",
	"index.html": "<html></html>\n",
	"package.json": '{"scripts":{"build":"noop"}}\n',
	"package-lock.json": "{}\n",
	"vite.config.ts": "export default {};\n",
	"tsconfig.json": "{}\n",
	"tsconfig.server.json": "{}\n",
	"scripts/copy-defaults.mjs": "// copy defaults\n",
	"scripts/copy-builtin-packs.mjs": "// copy builtin packs\n",
	"scripts/build-market-packs.mjs": "// build packs\n",
};

function writeRepoFile(root: string, relativeFile: string, content: string): void {
	const file = join(root, ...relativeFile.split("/"));
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

function writeFakeRepo(root: string): void {
	for (const [relativeFile, content] of Object.entries(BASE_FILES)) {
		writeRepoFile(root, relativeFile, content);
	}
}

function resetFakeRepo(root: string): void {
	writeFakeRepo(root);
}

const DIST_WORKER_SOURCE = String.raw`
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDistBuild } from ${JSON.stringify(new URL("../../../scripts/testing-v2/ensure-dist.mjs", import.meta.url).href)};

const [repoRoot, mode, reportPath, callerId] = process.argv.slice(2);
const marker = (name) => join(repoRoot, name);
const report = (value) => writeFileSync(reportPath, JSON.stringify(value));
const signal = (event) => process.send?.({ event });
const waitForParentRelease = () => {
	signal("awaiting-parent-release");
	if (readFileSync(0, "utf8") !== "release") throw new Error("parent did not release worker");
};
try {
	const result = ensureDistBuild({
		repoRoot,
		lockStaleMs: 1,
		afterComputeKey: () => {
			if (mode === "late-reader") {
				signal("late-reader-key-computed");
				waitForParentRelease();
			}
		},
		beforeAcquireLock: () => {
			signal("before-acquire");
			if (mode === "late-reader") signal("late-reader-before-acquire");
		},
		afterAcquireIntent: () => {
			if (mode === "crash-intent") {
				signal("crash-intent-created");
				// process.exit bypasses the lock acquirer's finally cleanup, modeling a
				// coordinator that dies after publishing intent but before acquisition.
				process.exit(86);
			}
		},
		afterRecoveryClaim: () => {
			if (mode === "recovery") {
				signal("recovery-claimed");
				waitForParentRelease();
			}
		},
		runBuild: () => {
			if (mode === "fail") {
				appendFileSync(marker("build-count"), "failed\n");
				throw new Error("intentional build failure");
			}
			appendFileSync(marker("build-count"), mode + "\n");
			mkdirSync(join(repoRoot, "dist", "server"), { recursive: true });
			mkdirSync(join(repoRoot, "dist", "ui"), { recursive: true });
			if (mode === "fail-partial") {
				writeFileSync(join(repoRoot, "dist", "server", "cli.js"), "// partial\n");
				writeFileSync(join(repoRoot, "dist", "ui", "index.html"), "<partial></partial>\n");
				throw new Error("intentional partial build failure");
			}
			if (mode === "partial-slow") {
				writeFileSync(join(repoRoot, "dist", "server", "cli.js"), "// partial\n");
				writeFileSync(join(repoRoot, "dist", "ui", "index.html"), "<partial></partial>\n");
				signal("partial-build-published");
				waitForParentRelease();
			}
			if (mode === "slow") {
				signal("build-started");
				waitForParentRelease();
			}
			writeFileSync(join(repoRoot, "dist", "server", "cli.js"), "// cli\n");
			writeFileSync(join(repoRoot, "dist", "ui", "index.html"), "<html></html>\n");
		},
	});
	report({ ok: true, result });
} catch (error) {
	report({ ok: false, message: error instanceof Error ? error.message : String(error) });
}
`;

function nativeSpawn(): NativeSpawn {
	const state = (process as NodeJS.Process & { [SPAWN_GUARD_STATE]?: SpawnGuardState })[SPAWN_GUARD_STATE];
	const spawn = state?.originals?.spawn;
	if (!spawn) throw new Error("ensure-dist multi-process probe requires the tier-1 spawn guard's preserved native spawn");
	return spawn;
}

type DistWorkerResult = { stdout: string; stderr: string; report: Record<string, unknown> };
type InteractiveDistWorker = {
	done: Promise<DistWorkerResult>;
	waitForEvent: (event: string) => Promise<void>;
	release: () => void;
};
type EventWaiter = { resolve: () => void; reject: (error: Error) => void };

function runDistWorker(
	workerFile: string,
	root: string,
	mode: string,
	callerId: string,
): Promise<DistWorkerResult> {
	const reportPath = join(root, `report-${callerId}.json`);
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		const options: SpawnOptions = { cwd: root, stdio: ["ignore", "pipe", "pipe"] };
		const child: ChildProcess = nativeSpawn()(process.execPath, [workerFile, root, mode, reportPath, callerId], options);
		child.stdout?.on("data", chunk => { stdout += chunk.toString(); });
		child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
		child.once("error", reject);
		child.once("close", code => {
			if (code !== 0) return reject(new Error(`dist worker ${callerId} exited ${code}: ${stderr}`));
			try {
				resolve({ stdout, stderr, report: JSON.parse(requireFile(reportPath)) as Record<string, unknown> });
			} catch (error) {
				reject(error);
			}
		});
	});
}

/**
 * Event-driven worker control for timing-sensitive lock regressions. IPC
 * publishes state transitions and stdin is a one-shot parent release barrier;
 * no filesystem polling or wall-clock scheduling determines the interleaving.
 */
function startInteractiveDistWorker(
	workerFile: string,
	root: string,
	mode: string,
	callerId: string,
): InteractiveDistWorker {
	const reportPath = join(root, `report-${callerId}.json`);
	let stdout = "";
	let stderr = "";
	const observedEvents = new Set<string>();
	const eventWaiters = new Map<string, EventWaiter[]>();
	let completionError: Error | undefined;
	const child = nativeSpawn()(process.execPath, [workerFile, root, mode, reportPath, callerId], {
		cwd: root,
		stdio: ["pipe", "pipe", "pipe", "ipc"],
	});
	const failEventWaiters = (error: Error) => {
		completionError = error;
		for (const waiters of eventWaiters.values()) {
			for (const waiter of waiters) waiter.reject(error);
		}
		eventWaiters.clear();
	};
	child.stdout?.on("data", chunk => { stdout += chunk.toString(); });
	child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
	child.on("message", message => {
		const event = typeof message === "object" && message !== null && "event" in message
			? (message as { event?: unknown }).event
			: undefined;
		if (typeof event !== "string") return;
		observedEvents.add(event);
		for (const waiter of eventWaiters.get(event) ?? []) waiter.resolve();
		eventWaiters.delete(event);
	});
	const done = new Promise<DistWorkerResult>((resolve, reject) => {
		child.once("error", error => {
			failEventWaiters(error);
			reject(error);
		});
		child.once("close", code => {
			if (code !== 0) {
				const error = new Error(`dist worker ${callerId} exited ${code}: ${stderr}`);
				failEventWaiters(error);
				return reject(error);
			}
			try {
				const result = { stdout, stderr, report: JSON.parse(requireFile(reportPath)) as Record<string, unknown> };
				resolve(result);
				failEventWaiters(new Error(`dist worker ${callerId} exited before publishing the requested lifecycle event`));
			} catch (error) {
				const failure = error instanceof Error ? error : new Error(String(error));
				failEventWaiters(failure);
				reject(failure);
			}
		});
	});
	return {
		done,
		waitForEvent: event => {
			if (observedEvents.has(event)) return Promise.resolve();
			if (completionError) return Promise.reject(completionError);
			return new Promise((resolve, reject) => {
				const waiters = eventWaiters.get(event) ?? [];
				waiters.push({ resolve, reject });
				eventWaiters.set(event, waiters);
			});
		},
		release: () => child.stdin?.end("release"),
	};
}

/** A real child exits after intent publication, intentionally bypassing cleanup. */
function runCrashedDistWorker(workerFile: string, root: string, callerId: string): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const child = nativeSpawn()(process.execPath, [workerFile, root, "crash-intent", join(root, `report-${callerId}.json`), callerId], {
			cwd: root,
			stdio: "ignore",
		});
		child.once("error", reject);
		child.once("close", resolve);
	});
}

function requireFile(file: string): string {
	if (!existsSync(file)) throw new Error(`worker did not publish report: ${file}`);
	return readFileSync(file, "utf8");
}

/** Well-formed dist fixture: artifacts + manifest matching `key`. */
function writeDistFixture(root: string, key: string): void {
	writeRepoFile(root, "dist/server/cli.js", "#!/usr/bin/env node\n// cli\n");
	writeRepoFile(root, "dist/ui/index.html", "<html></html>\n");
	writeRepoFile(root, "dist/.build-manifest.json", `${JSON.stringify({ schema: 1, key, createdAt: new Date().toISOString() }, null, 2)}\n`);
}

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let workspace: string;
let repoRoot: string;
let workerFile: string;
let key: string;

beforeAll(() => {
	workspace = mkdtempSync(join(tmpdir(), "bobbit-ensure-dist-"));
	repoRoot = join(workspace, "repo");
	workerFile = join(workspace, "ensure-dist-worker.mjs");
	writeFileSync(workerFile, DIST_WORKER_SOURCE);
	writeFakeRepo(repoRoot);
	key = computeDistBuildKey(repoRoot);
});

afterAll(() => {
	rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
});

describe("dist build callers", () => {
	it("routes E2E setup and packed-consumer builds through the mutex entrypoint", () => {
		const e2eGlobalSetup = readFileSync(join(PROJECT_ROOT, "tests", "e2e", "e2e-global-setup.ts"), "utf8");
		assert.match(
			e2eGlobalSetup,
			/const ensureDistScript = join\(projectRoot, "scripts", "testing-v2", "ensure-dist\.mjs"\);/,
			"E2E global setup must target the shared mutex entrypoint",
		);
		assert.match(
			e2eGlobalSetup,
			/execFileSync\(process\.execPath, \[ensureDistScript\], \{\s*cwd: projectRoot,\s*stdio: "inherit",\s*\}\)/s,
			"E2E global setup must invoke ensure-dist with this Node runtime",
		);
		assert.doesNotMatch(
			e2eGlobalSetup,
			/execSync\(|execFileSync\([^\n]*\["npm"|npm run build:(?:server|ui)/,
			"E2E global setup must not bypass the dist mutex with a direct build",
		);

		const packedConsumer = readFileSync(join(PROJECT_ROOT, "tests", "e2e", "pi-packed-consumer.spec.ts"), "utf8");
		assert.match(
			packedConsumer,
			/const ENSURE_DIST_SCRIPT = join\(PROJECT_ROOT, "scripts", "testing-v2", "ensure-dist\.mjs"\);/,
			"packed-consumer must target the shared mutex entrypoint",
		);
		assert.match(
			packedConsumer,
			/runPiPackedConsumerCommand\(\s*process\.execPath,\s*\[ENSURE_DIST_SCRIPT\],\s*\{ cwd: PROJECT_ROOT, timeoutMs: 10 \* 60_000 \},\s*\)/s,
			"packed-consumer must invoke ensure-dist with this Node runtime",
		);
		assert.match(
			packedConsumer,
			/report\.commands\.push\(build\);\s*expectSuccess\(build\);/s,
			"packed-consumer must retain build command reporting and failure handling",
		);
		assert.doesNotMatch(
			packedConsumer,
			/runNpm\(\["run", "build"\]/,
			"packed-consumer must not bypass the dist mutex with a direct build",
		);
	});
});

describe.sequential("dist build cache key", () => {
	it("is deterministic for identical inputs", () => {
		assert.equal(computeDistBuildKey(repoRoot), key);
	});

	it("changes when any build input changes and ignores non-inputs", () => {
		try {
			const changedInputs: Array<[string, string]> = [
				["src/server/cli.ts", "export const cli = 2;\n"],
				["src/shared/value.ts", "export const value = 2;\n"],
				["defaults/roles/basic.yaml", "name: changed\n"],
				["market-packs/demo/src/panel.ts", "export const panel = 2;\n"],
				["public/sw.js", "// sw v2\n"],
				["index.html", "<html><body></body></html>\n"],
				["vite.config.ts", "export default { build: {} };\n"],
				["tsconfig.server.json", '{"compilerOptions":{}}\n'],
				["package-lock.json", '{"lockfileVersion":3}\n'],
				["scripts/copy-defaults.mjs", "// copy defaults v2\n"],
			];
			for (const [relativeFile, content] of changedInputs) {
				writeRepoFile(repoRoot, relativeFile, content);
				assert.notEqual(computeDistBuildKey(repoRoot), key, `${relativeFile} changes must change the key`);
				writeRepoFile(repoRoot, relativeFile, BASE_FILES[relativeFile]);
				assert.equal(computeDistBuildKey(repoRoot), key, `${relativeFile} restore must restore the key`);
			}

			// New files under input dirs are part of the key.
			writeRepoFile(repoRoot, "src/server/new-module.ts", "export const added = 1;\n");
			assert.notEqual(computeDistBuildKey(repoRoot), key, "added source files must change the key");
			rmSync(join(repoRoot, "src", "server", "new-module.ts"));
			assert.equal(computeDistBuildKey(repoRoot), key);

			// Files outside the build input set must not affect the key.
			writeRepoFile(repoRoot, "tests/unit/core/some.test.ts", "// not a build input\n");
			writeRepoFile(repoRoot, "README.md", "# not a build input\n");
			writeRepoFile(repoRoot, "src/node_modules/dep/index.js", "// skipped dir\n");
			assert.equal(computeDistBuildKey(repoRoot), key, "non-inputs must not balloon the content key");
		} finally {
			resetFakeRepo(repoRoot);
		}
	});
});

describe.sequential("dist build validation (fail-closed)", () => {
	it("fails on a missing manifest", () => {
		assert.equal(validateDistBuild(repoRoot, key), false, "no dist/ at all must not validate");
		writeRepoFile(repoRoot, "dist/server/cli.js", "// cli\n");
		writeRepoFile(repoRoot, "dist/ui/index.html", "<html></html>\n");
		assert.equal(validateDistBuild(repoRoot, key), false, "artifacts without a manifest must not validate");
		rmSync(join(repoRoot, "dist"), { recursive: true, force: true });
	});

	it("passes on a well-formed fixture and pins schema + key matching", () => {
		writeDistFixture(repoRoot, key);
		assert.equal(validateDistBuild(repoRoot, key), true, "well-formed manifest + artifacts must validate");

		assert.equal(validateDistBuild(repoRoot, "stale-key"), false, "wrong key must not validate");

		writeRepoFile(repoRoot, "dist/.build-manifest.json", `${JSON.stringify({ schema: 999, key }, null, 2)}\n`);
		assert.equal(validateDistBuild(repoRoot, key), false, "unknown schema must not validate");

		writeRepoFile(repoRoot, "dist/.build-manifest.json", "not json{");
		assert.equal(validateDistBuild(repoRoot, key), false, "corrupt manifest must fail closed");

		rmSync(join(repoRoot, "dist"), { recursive: true, force: true });
	});

	it("fails when a build artifact is missing despite a matching manifest", () => {
		writeDistFixture(repoRoot, key);
		rmSync(join(repoRoot, "dist", "server", "cli.js"));
		assert.equal(validateDistBuild(repoRoot, key), false, "missing dist/server/cli.js must not validate");

		writeDistFixture(repoRoot, key);
		rmSync(join(repoRoot, "dist", "ui", "index.html"));
		assert.equal(validateDistBuild(repoRoot, key), false, "missing dist/ui/index.html must not validate");

		rmSync(join(repoRoot, "dist"), { recursive: true, force: true });
	});
});

function resetLockFixture(root = repoRoot): void {
	rmSync(join(root, "dist"), { recursive: true, force: true });
	rmSync(join(root, ".profiles"), { recursive: true, force: true });
	for (const name of [
		"build-count",
		"report-leader.json", "report-waiter.json", "report-failed.json", "report-repaired.json", "report-stale.json",
		"report-reclaimer.json", "report-successor.json", "report-crashed.json", "report-recovered-intent.json",
		"report-late-reader.json", "report-partial-builder.json", "report-partial-failure.json", "report-partial-repair.json",
	]) {
		rmSync(join(root, name), { force: true });
	}
	writeFakeRepo(root);
}

function buildCount(root = repoRoot): string[] {
	return readFileSync(join(root, "build-count"), "utf8").trim().split("\n").filter(Boolean);
}

describe.sequential("dist build worktree lock", () => {
	it("is scoped to one worktree rather than a machine-wide lock", () => {
		const otherWorktree = join(workspace, "other-worktree");
		writeFakeRepo(otherWorktree);
		assert.notEqual(distBuildLockPath(repoRoot), distBuildLockPath(otherWorktree));
	});

	it("runs exactly one real multi-process build and makes the waiter consume its manifest", async () => {
		resetLockFixture();
		const leader = startInteractiveDistWorker(workerFile, repoRoot, "slow", "leader");
		await leader.waitForEvent("build-started");

		const waiter = startInteractiveDistWorker(workerFile, repoRoot, "normal", "waiter");
		// The waiter has already observed the cache miss before the owner publishes
		// the manifest. Releasing now pins the required revalidation-inside-lock path.
		await waiter.waitForEvent("before-acquire");
		leader.release();

		const [leaderResult, waiterResult] = await Promise.all([leader.done, waiter.done]);
		assert.deepEqual(buildCount(), ["slow"], "only the lock owner may execute the build");
		assert.equal(leaderResult.report.ok, true);
		assert.equal(waiterResult.report.ok, true);
		assert.deepEqual(
			[leaderResult.report.result, waiterResult.report.result]
				.map(result => (result as { cacheHit: boolean }).cacheHit)
				.sort(),
			[false, true],
			"one caller builds and the contending caller uses the published manifest",
		);
		assert.match(waiterResult.stdout, /cache hit after lock/, "waiter must revalidate only after acquiring the mutex");
	});

	it("releases a failed build owner and recovers a bounded stale owner", async () => {
		resetLockFixture();
		const failed = await runDistWorker(workerFile, repoRoot, "fail", "failed");
		assert.equal(failed.report.ok, false);
		assert.match(String(failed.report.message), /intentional build failure/);

		const repaired = await runDistWorker(workerFile, repoRoot, "normal", "repaired");
		assert.equal(repaired.report.ok, true, "a failed builder must release its lock for the next coordinator");
		assert.deepEqual(buildCount(), ["failed", "normal"]);

		resetLockFixture();
		const staleLock = distBuildLockPath(repoRoot);
		mkdirSync(dirname(staleLock), { recursive: true });
		writeFileSync(staleLock, `${JSON.stringify({ pid: 0, token: "dead-owner" })}\n`);
		const old = new Date(Date.now() - 100);
		utimesSync(staleLock, old, old);

		const recovered = await runDistWorker(workerFile, repoRoot, "normal", "stale");
		assert.equal(recovered.report.ok, true, "a dead stale owner must be reclaimed without manual cleanup");
		assert.deepEqual(buildCount(), ["normal"]);
		assert.equal(existsSync(staleLock), false, "the replacement owner must release the recovered lock");
	});

	it("makes a cache-hit consumer wait for a partial owner before validating", async () => {
		resetLockFixture();
		const originalSource = BASE_FILES["src/server/cli.ts"];
		const oldKey = computeDistBuildKey(repoRoot);
		writeDistFixture(repoRoot, oldKey);

		// Hold a reader just after it computes the old key. The parent then changes
		// the source, starts a builder, and waits until that builder has recreated
		// both critical artifacts with partial contents. IPC + stdin barriers make
		// this exact interleaving independent of scheduler speed.
		const reader = startInteractiveDistWorker(workerFile, repoRoot, "late-reader", "late-reader");
		await reader.waitForEvent("late-reader-key-computed");
		writeRepoFile(repoRoot, "src/server/cli.ts", "export const cli = 2;\n");
		const builder = startInteractiveDistWorker(workerFile, repoRoot, "partial-slow", "partial-builder");
		await builder.waitForEvent("partial-build-published");

		reader.release();
		// A cache-hit path must enter the mutex instead of validating the retained
		// old manifest against the partial artifacts outside it.
		await reader.waitForEvent("late-reader-before-acquire");
		builder.release();

		const [builderResult, readerResult] = await Promise.all([builder.done, reader.done]);
		assert.equal(builderResult.report.ok, true);
		assert.equal(readerResult.report.ok, true);
		assert.deepEqual(buildCount(), ["partial-slow"], "the reader must consume the completed publication");
		assert.equal((readerResult.report.result as { cacheHit: boolean }).cacheHit, true);
		assert.match(readerResult.stdout, /cache hit after lock/);
		assert.match(readFileSync(join(repoRoot, "dist", "server", "cli.js"), "utf8"), /^\/\/ cli$/m);
		writeRepoFile(repoRoot, "src/server/cli.ts", originalSource);
	});

	it("invalidates the previous manifest before a failed partial build", async () => {
		resetLockFixture();
		const originalSource = BASE_FILES["src/server/cli.ts"];
		const oldKey = computeDistBuildKey(repoRoot);
		writeDistFixture(repoRoot, oldKey);
		writeRepoFile(repoRoot, "src/server/cli.ts", "export const cli = 2;\n");

		const failed = await runDistWorker(workerFile, repoRoot, "fail-partial", "partial-failure");
		assert.equal(failed.report.ok, false);
		assert.match(String(failed.report.message), /intentional partial build failure/);
		assert.equal(
			existsSync(join(repoRoot, "dist", ".build-manifest.json")),
			false,
			"a failed build must not leave its predecessor's manifest paired with partial artifacts",
		);

		// Restore the old source key: without pre-build invalidation, this consumer
		// would accept the old manifest and the partial files as a false cache hit.
		writeRepoFile(repoRoot, "src/server/cli.ts", originalSource);
		const repaired = await runDistWorker(workerFile, repoRoot, "normal", "partial-repair");
		assert.equal(repaired.report.ok, true);
		assert.equal((repaired.report.result as { cacheHit: boolean }).cacheHit, false);
		assert.deepEqual(buildCount(), ["fail-partial", "normal"]);
	});

	it("reclaims a dead stale acquisition intent from a real crashed child", async () => {
		resetLockFixture();
		const staleLock = distBuildLockPath(repoRoot);
		mkdirSync(dirname(staleLock), { recursive: true });
		writeFileSync(staleLock, `${JSON.stringify({ pid: 0, token: "dead-lock-owner" })}\n`);
		const old = new Date(Date.now() - 100);
		utimesSync(staleLock, old, old);

		const crashed = await runCrashedDistWorker(workerFile, repoRoot, "crashed");
		assert.equal(crashed, 86, "the child must die without its intent cleanup finally block");

		const intentName = readdirSync(dirname(staleLock)).find(name => name.startsWith(`${staleLock.split(/[\\/]/).pop()}.acquire-`));
		assert.ok(intentName, "crashed acquirer must leave a published intent");
		const staleIntent = join(dirname(staleLock), intentName);
		utimesSync(staleIntent, old, old);

		const recovered = await runDistWorker(workerFile, repoRoot, "normal", "recovered-intent");
		assert.equal(recovered.report.ok, true, "a dead stale intent must not wedge lock recovery");
		assert.deepEqual(buildCount(), ["normal"]);
		assert.equal(existsSync(staleIntent), false, "only the dead intent is reclaimed");
		assert.equal(existsSync(staleLock), false, "the replacement owner must release its lock");
	});

});
