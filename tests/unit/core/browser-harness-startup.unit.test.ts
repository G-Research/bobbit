import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "vitest";
import { withDistServerImportWarmup } from "../../support/harnesses/browser/dist-import-warmup.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const HARNESSES = [
	"tests/e2e/gateway-harness.ts",
	"tests/e2e/in-process-harness.ts",
	"tests/e2e/in-process-harness-realpush.ts",
] as const;
const temporaryRoots: string[] = [];

function temporaryStateDir(): string {
	const root = mkdtempSync(join(tmpdir(), "bobbit-import-warmup-unit-"));
	temporaryRoots.push(root);
	return join(root, "barrier", "dist-server");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolvePromise!: () => void;
	const promise = new Promise<void>(resolve => { resolvePromise = resolve; });
	return { promise, resolve: resolvePromise };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) throw new Error("condition was not reached");
		await new Promise(resolveDelay => setTimeout(resolveDelay, 2));
	}
}

function startupImportBlock(file: string): string {
	const source = readFileSync(resolve(PROJECT_ROOT, file), "utf8");
	const start = source.indexOf("// Playwright workers share one transform cache");
	const end = source.indexOf("// Register the in-process mock bridge factory", start);
	assert.ok(start >= 0 && end > start, `${file} must retain the documented server startup boundary`);
	return source.slice(start, end);
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
	}
});

describe("browser harness startup", () => {
	it("warms once, then releases all waiting workers to import concurrently", async () => {
		const stateDir = temporaryStateDir();
		const warmupStarted = deferred();
		const finishWarmup = deferred();
		const finishFollowers = deferred();
		const containmentRoot = resolve(stateDir, "..", "..");
		const ownerCache = join(containmentRoot, "cache", "process-owner");
		const followerCaches = [
			join(containmentRoot, "cache", "process-follower-1"),
			join(containmentRoot, "cache", "process-follower-2"),
		] as const;
		for (const cacheDir of [ownerCache, ...followerCaches]) mkdirSync(cacheDir, { recursive: true });
		let followerStarts = 0;
		let activeFollowers = 0;
		let maxActiveFollowers = 0;

		const first = withDistServerImportWarmup(async () => {
			warmupStarted.resolve();
			await finishWarmup.promise;
			writeFileSync(join(ownerCache, "dist-server.js"), "compiled");
			return "first";
		}, { stateDir, cacheDir: ownerCache, containmentRoot, waitMs: 1 });
		await warmupStarted.promise;

		const follower = (value: string, cacheDir: string) => withDistServerImportWarmup(async () => {
			assert.equal(readFileSync(join(cacheDir, "dist-server.js"), "utf8"), "compiled");
			followerStarts++;
			activeFollowers++;
			maxActiveFollowers = Math.max(maxActiveFollowers, activeFollowers);
			await finishFollowers.promise;
			activeFollowers--;
			return value;
		}, { stateDir, cacheDir, containmentRoot, waitMs: 1 });
		const second = follower("second", followerCaches[0]);
		const third = follower("third", followerCaches[1]);

		await new Promise(resolveDelay => setTimeout(resolveDelay, 15));
		assert.equal(followerStarts, 0, "followers must not import against a partially populated cache");
		finishWarmup.resolve();
		await waitUntil(() => followerStarts === 2);
		assert.equal(maxActiveFollowers, 2, "ready followers must not serialize behind the warmup lock");
		finishFollowers.resolve();

		assert.deepEqual(await Promise.all([first, second, third]), ["first", "second", "third"]);
		assert.equal(existsSync(`${stateDir}.ready`), true);
		assert.equal(existsSync(`${stateDir}.lock`), false);
	});

	it("publishes the first importer's cache and seeds independent followers before import", async () => {
		const stateDir = temporaryStateDir();
		const containmentRoot = resolve(stateDir, "..", "..");
		const ownerCache = join(containmentRoot, "cache", "process-owner");
		const followerACache = join(containmentRoot, "cache", "process-follower-a");
		const followerBCache = join(containmentRoot, "cache", "process-follower-b");
		for (const directory of [ownerCache, followerACache, followerBCache]) {
			mkdirSync(join(directory, "dist"), { recursive: true });
		}

		let ownerImports = 0;
		const owner = await withDistServerImportWarmup(async () => {
			ownerImports++;
			writeFileSync(join(ownerCache, "dist", "server.js"), "compiled-owner");
			return "owner";
		}, { stateDir, cacheDir: ownerCache, containmentRoot, waitMs: 1 });
		assert.equal(owner, "owner");
		assert.equal(ownerImports, 1);

		// A follower may already have transformed an unrelated/colliding entry;
		// seeding must retain the follower's process-local result.
		writeFileSync(join(followerBCache, "dist", "server.js"), "compiled-follower");
		const follower = (cacheDir: string, expected: string) => withDistServerImportWarmup(async () => {
			assert.equal(readFileSync(join(cacheDir, "dist", "server.js"), "utf8"), expected);
			return cacheDir;
		}, { stateDir, cacheDir, containmentRoot, waitMs: 1 });

		assert.deepEqual(await Promise.all([
			follower(followerACache, "compiled-owner"),
			follower(followerBCache, "compiled-follower"),
		]), [followerACache, followerBCache]);
		assert.notEqual(followerACache, followerBCache);
		assert.equal(
			readFileSync(`${stateDir}.pwtest-cache-snapshot/dist/server.js`, "utf8"),
			"compiled-owner",
		);
	});

	it("lets another worker become the warmer after the first worker fails", async () => {
		const stateDir = temporaryStateDir();
		const firstStarted = deferred();
		const failFirst = deferred();
		let replacementStarted = false;

		const first = withDistServerImportWarmup(async () => {
			firstStarted.resolve();
			await failFirst.promise;
			throw new Error("warmup import failed");
		}, { stateDir, waitMs: 1 });
		await firstStarted.promise;
		const replacement = withDistServerImportWarmup(async () => {
			replacementStarted = true;
			return "recovered";
		}, { stateDir, waitMs: 1 });

		failFirst.resolve();
		await assert.rejects(first, /warmup import failed/);
		assert.equal(await replacement, "recovered");
		assert.equal(replacementStarted, true);
		assert.equal(existsSync(`${stateDir}.ready`), true);
		assert.equal(existsSync(`${stateDir}.lock`), false);
	});

	it("atomically recovers an abandoned stale lock", async () => {
		const stateDir = temporaryStateDir();
		const lockPath = `${stateDir}.lock`;
		mkdirSync(lockPath, { recursive: true });
		const staleDate = new Date(Date.now() - 10_000);
		utimesSync(lockPath, staleDate, staleDate);

		const result = await withDistServerImportWarmup(async () => "recovered", {
			stateDir,
			staleMs: 5,
			waitMs: 1,
			timeoutMs: 500,
		});

		assert.equal(result, "recovered");
		assert.equal(existsSync(`${stateDir}.ready`), true);
		assert.equal(existsSync(lockPath), false);
		assert.equal(
			readFileSync(`${stateDir}.ready`, "utf8"),
			"dist-server-imports-ready-v1\n",
		);
	});

	it("keeps each harness import graph ordered behind the warmup barrier", () => {
		for (const file of HARNESSES) {
			const block = startupImportBlock(file);
			assert.match(block, /withDistServerImportWarmup/, `${file} must use the first-writer barrier`);
			const imports = [
				"dist/server/bobbit-dir.js",
				"dist/server/scaffold.js",
				"dist/server/auth/token.js",
				"dist/server/server.js",
				"dist/server/agent/rpc-bridge.js",
			];
			let previous = -1;
			for (const imported of imports) {
				const position = block.indexOf(imported);
				assert.ok(position > previous, `${file} must import ${imported} in canonical order`);
				previous = position;
			}
			assert.doesNotMatch(block, /Promise\.all/, `${file} must keep shared-graph roots ordered`);
		}
	});
});
