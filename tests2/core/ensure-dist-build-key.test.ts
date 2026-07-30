/**
 * Pins the content-addressed dist build cache (scripts/testing-v2/ensure-dist.mjs)
 * used by test:e2e:v2 and tests2/browser-global-setup.ts: changed build inputs
 * must change the key, and validation must fail closed on a missing/stale
 * manifest or missing build artifacts so a stale dist can never be silently
 * tested. Modeled on tests2/core/server-prebundle-cache.test.ts; uses an owned
 * temp fixture and real child processes with a synthetic build — never npm.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
	computeDistBuildKey,
	distBuildLockPath,
	validateDistBuild,
} from "../../scripts/testing-v2/ensure-dist.mjs";

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
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDistBuild } from ${JSON.stringify(new URL("../../scripts/testing-v2/ensure-dist.mjs", import.meta.url).href)};

const [repoRoot, mode, reportPath, callerId] = process.argv.slice(2);
const marker = (name) => join(repoRoot, name);
const report = (value) => writeFileSync(reportPath, JSON.stringify(value));
const waitForRelease = () => {
	const deadline = Date.now() + 5_000;
	while (!existsSync(marker("allow-build-finish"))) {
		if (Date.now() >= deadline) throw new Error("test release signal was not published");
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
	}
};
try {
	writeFileSync(marker("caller-" + callerId + ".started"), "started");
	const result = ensureDistBuild({
		repoRoot,
		lockStaleMs: 1,
		lockWaitMs: 5_000,
		lockPollMs: 5,
		beforeAcquireLock: () => writeFileSync(marker("caller-" + callerId + ".missed"), "missed"),
		afterRecoveryClaim: () => {
			if (mode === "recovery") {
				writeFileSync(marker("recovery-claimed"), "claimed");
				waitForRelease();
			}
		},
		runBuild: () => {
			if (mode === "fail") {
				appendFileSync(marker("build-count"), "failed\n");
				throw new Error("intentional build failure");
			}
			appendFileSync(marker("build-count"), mode + "\n");
			if (mode === "slow") {
				writeFileSync(marker("build-started"), "started");
				waitForRelease();
			}
			mkdirSync(join(repoRoot, "dist", "server"), { recursive: true });
			mkdirSync(join(repoRoot, "dist", "ui"), { recursive: true });
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

function waitForFile(file: string, timeoutMs = 5_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		const check = () => {
			if (existsSync(file)) return resolve();
			if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${file}`));
			setTimeout(check, 5);
		};
		check();
	});
}

function runDistWorker(
	workerFile: string,
	root: string,
	mode: string,
	callerId: string,
): Promise<{ stdout: string; stderr: string; report: Record<string, unknown> }> {
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
			writeRepoFile(repoRoot, "tests2/core/some.test.ts", "// not a build input\n");
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
		"allow-build-finish", "build-started", "build-count", "recovery-claimed",
		"caller-leader.started", "caller-leader.missed", "caller-waiter.started", "caller-waiter.missed",
		"caller-reclaimer.started", "caller-reclaimer.missed", "caller-successor.started", "caller-successor.missed",
		"report-leader.json", "report-waiter.json", "report-failed.json", "report-repaired.json", "report-stale.json",
		"report-reclaimer.json", "report-successor.json",
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
		const leader = runDistWorker(workerFile, repoRoot, "slow", "leader");
		await waitForFile(join(repoRoot, "build-started"));

		const waiter = runDistWorker(workerFile, repoRoot, "normal", "waiter");
		// The waiter has already observed the cache miss before the owner publishes
		// the manifest. Releasing now pins the required revalidation-inside-lock path.
		await waitForFile(join(repoRoot, "caller-waiter.missed"));
		writeFileSync(join(repoRoot, "allow-build-finish"), "release");

		const [leaderResult, waiterResult] = await Promise.all([leader, waiter]);
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

	it("does not remove a successor while recovery has claimed a stale owner", async () => {
		resetLockFixture();
		const staleLock = distBuildLockPath(repoRoot);
		mkdirSync(dirname(staleLock), { recursive: true });
		writeFileSync(staleLock, `${JSON.stringify({ pid: 0, token: "released-owner" })}\n`);
		const old = new Date(Date.now() - 100);
		utimesSync(staleLock, old, old);

		const reclaimer = runDistWorker(workerFile, repoRoot, "recovery", "reclaimer");
		await waitForFile(join(repoRoot, "recovery-claimed"));
		const successor = runDistWorker(workerFile, repoRoot, "normal", "successor");
		await waitForFile(join(repoRoot, "caller-successor.missed"));
		assert.equal(
			JSON.parse(readFileSync(staleLock, "utf8")).token,
			"released-owner",
			"a successor started during recovery must not replace the claimed stale lock",
		);
		writeFileSync(join(repoRoot, "allow-build-finish"), "release");

		const [reclaimerResult, successorResult] = await Promise.all([reclaimer, successor]);
		assert.equal(reclaimerResult.report.ok, true);
		assert.equal(successorResult.report.ok, true);
		assert.deepEqual(buildCount(), ["normal"], "the successor may build only after the recovery claim is released");
		assert.match(reclaimerResult.stdout, /cache hit after lock/);
	});
});
