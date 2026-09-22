import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync, watch } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";
import { after, test } from "node:test";
import {
	isCompleteOwnedCommandShutdown,
	preparePackedConsumerFixture,
	runOwnedCommand,
} from "../../../scripts/testing-v2/prewarm-packed-consumer-cache.mjs";
import { removeOwnedPath } from "../../../scripts/testing-v2/owned-path-cleanup.mjs";
import { spawnTracked, type TrackedChild } from "../../../src/server/agent/spawn-tree.ts";

const REPO_ROOT = process.cwd();
const require = createRequire(import.meta.url);
const cacache = require("cacache") as {
	put: (cache: string, key: string, data: Buffer) => Promise<{ toString(): string }>;
	get: { info: (cache: string, key: string) => Promise<{ integrity: string; path: string } | null> };
	index: { insert: (cache: string, key: string, integrity: string) => Promise<{ path: string }> };
};
const roots: string[] = [];
const owners: Array<{ tracked: TrackedChild; closed: Promise<void>; treeExitVerified: boolean }> = [];

function validSha512Integrity(firstByte: number): string {
	const digest = Buffer.alloc(64);
	digest[0] = firstByte;
	return `sha512-${digest.toString("base64")}`;
}

function isAlive(pid: number | undefined): boolean {
	if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

type HelperPids = { root: number; descendant: number };

function waitForAtomicHelperPids(marker: string, signal: AbortSignal): Promise<HelperPids> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let watcher: ReturnType<typeof watch> | undefined;
		const finish = (error?: Error, pids?: HelperPids) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			watcher?.close();
			if (error) reject(error); else resolve(pids!);
		};
		const read = () => {
			try {
				const pids = JSON.parse(readFileSync(marker, "utf8")) as HelperPids;
				if (Number.isSafeInteger(pids.root) && pids.root > 0 &&
					Number.isSafeInteger(pids.descendant) && pids.descendant > 0) finish(undefined, pids);
			} catch { /* marker has not been atomically published yet */ }
		};
		const onAbort = () => finish(signal.reason instanceof Error
			? signal.reason
			: new Error("tracked helper setup was aborted"));
		if (signal.aborted) return onAbort();
		watcher = watch(dirname(marker), { persistent: false }, read);
		watcher.once("error", error => finish(error));
		signal.addEventListener("abort", onAbort, { once: true });
		read();
	});
}

async function awaitTrackedHelperReady(tracked: TrackedChild, marker: string, timeoutMs: number): Promise<HelperPids> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(
		new Error(`tracked helper did not establish ownership and publish its PID marker within ${timeoutMs}ms`),
	), timeoutMs);
	try {
		const [, pids] = await Promise.all([
			tracked.ownershipReady,
			waitForAtomicHelperPids(marker, controller.signal),
		]);
		return pids;
	} finally {
		clearTimeout(timeout);
		if (!controller.signal.aborted) controller.abort(new Error("tracked helper setup observation completed"));
	}
}

after(async () => {
	const shutdownFailures: unknown[] = [];
	for (const owner of owners) {
		try { owner.tracked.killTree("SIGKILL"); } catch (error) { shutdownFailures.push(error); }
		const settled = await Promise.allSettled([
			owner.closed,
			owner.tracked.waitForTreeExit(10_000).then(verified => {
				if (verified !== true) throw new Error("tracked helper tree exit was not verified");
				owner.treeExitVerified = true;
			}),
		]);
		for (const result of settled) if (result.status === "rejected") shutdownFailures.push(result.reason);
	}
	if (shutdownFailures.length > 0) {
		throw new AggregateError(shutdownFailures, "packed cache helper teardown could not prove every process tree stopped; retained roots");
	}
	for (const root of roots) {
		assert.equal(owners.every(owner => owner.treeExitVerified), true,
			"owned-root deletion must be admitted only after every helper tree exit is verified");
		await removeOwnedPath(root, {
			ownerRoot: root,
			allowOwnerRoot: true,
			owner: { kind: "coordinator", id: "packed-cache-path-helper-shutdown-test" },
			lifecycle: { phase: "after verified helper tree exit", owners: owners.length },
		});
	}
});

test("real cache-copy helper hardlinks one exact CAS hit and joins its owned process tree", { timeout: 40_000 }, async () => {
	const runRoot = mkdtempSync(join(tmpdir(), "bobbit-packed-cache-helper-link-e2e-"));
	const ambientRoot = mkdtempSync(join(tmpdir(), "bobbit-packed-cache-helper-ambient-e2e-"));
	roots.push(runRoot, ambientRoot);
	const fixtureRoot = join(runRoot, "prepared-packed-consumer");
	mkdirSync(fixtureRoot, { recursive: true });
	const ambientCache = join(ambientRoot, "_cacache");
	const resolved = "https://registry.example.test/helper-exact.tgz";
	const cacheKey = `make-fetch-happen:request-cache:${resolved}`;
	const integrity = String(await cacache.put(ambientCache, cacheKey, Buffer.from("real helper immutable content")));
	const destinationCache = join(fixtureRoot, "npm-cache", "_cacache");
	const destination = await cacache.index.insert(destinationCache, `bobbit-packed-consumer-path:${integrity}`, integrity);
	const helperPath = join(REPO_ROOT, "scripts", "testing-v2", "copy-packed-consumer-cache-batch.mjs");
	const result = await runOwnedCommand(process.execPath, [helperPath, fixtureRoot], {
		cwd: REPO_ROOT,
		env: { ...process.env, BOBBIT_PACKED_CONSUMER_AMBIENT_CACACHE: ambientCache },
		timeoutMs: 30_000,
		totalTimeoutMs: 30_000,
		input: `${JSON.stringify({ version: 4, operation: "publish", artifacts: [{ candidates: [resolved], integrity, destinationPath: destination.path }] })}\n`,
		repoRoot: REPO_ROOT,
		ownershipBootstrapRoot: fixtureRoot,
	});
	assert.equal(result.code, 0, result.stderr);
	assert.equal(isCompleteOwnedCommandShutdown(result.shutdown), true);
	assert.doesNotMatch(JSON.stringify({ args: result.args, stdout: result.stdout, stderr: result.stderr }),
		new RegExp(ambientRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
		"published helper command evidence must not expose the ambient absolute path");
	const response = JSON.parse(result.stdout) as {
		metrics: { linked: number; copied: number; missing: number };
		results: Array<{ status: string }>;
	};
	assert.deepEqual(response.metrics, { linked: 1, copied: 0, missing: 0, corrupt: 0 });
	assert.equal(response.results[0]?.status, "linked");
	const source = await cacache.get.info(ambientCache, cacheKey);
	assert.ok(source?.path);
	assert.equal(statSync(destination.path).ino, statSync(source.path).ino,
		"the helper must directly hardlink the exact immutable ambient CAS inode to the canonical final path");
	unlinkSync(source.path);
	assert.equal(readFileSync(destination.path, "utf8"), "real helper immutable content",
		"the canonical final hardlink must survive unlinking the ambient cache name");
	assert.equal(existsSync(join(fixtureRoot, "cache-copy-staging")), false,
		"direct publication must not create a staging tree");
});

test("cache-copy helper accepts binary mixed-case protocol order under an alternate locale", { timeout: 40_000 }, async () => {
	const runRoot = mkdtempSync(join(tmpdir(), "bobbit-packed-cache-helper-order-e2e-"));
	const ambientRoot = mkdtempSync(join(tmpdir(), "bobbit-packed-cache-helper-order-ambient-e2e-"));
	roots.push(runRoot, ambientRoot);
	const fixtureRoot = join(runRoot, "prepared-packed-consumer");
	mkdirSync(fixtureRoot, { recursive: true });
	const destinationCache = join(fixtureRoot, "npm-cache", "_cacache");
	const upperIntegrity = validSha512Integrity(0x20);
	const lowerIntegrity = validSha512Integrity(0x88);
	const upperUrl = "https://registry.example.test/I.tgz";
	const lowerUrl = "https://registry.example.test/i.tgz";
	const helperPath = join(REPO_ROOT, "scripts", "testing-v2", "copy-packed-consumer-cache-batch.mjs");
	const parentLocale = Intl.Collator().resolvedOptions().locale;
	const alternateLocale = parentLocale.toLowerCase().startsWith("tr") ? "en_US.UTF-8" : "tr_TR.UTF-8";
	const helperEnv = {
		...process.env,
		LANG: alternateLocale,
		LC_ALL: alternateLocale,
		BOBBIT_PACKED_CONSUMER_AMBIENT_CACACHE: join(ambientRoot, "missing", "_cacache"),
	};
	const localeProbe = await runOwnedCommand(process.execPath, ["-e", "process.stdout.write(Intl.Collator().resolvedOptions().locale)"], {
		cwd: REPO_ROOT,
		env: helperEnv,
		timeoutMs: 30_000,
		totalTimeoutMs: 30_000,
		repoRoot: REPO_ROOT,
		ownershipBootstrapRoot: fixtureRoot,
	});
	if (process.platform !== "win32") assert.notEqual(localeProbe.stdout, parentLocale,
		"POSIX child locale override must differ from the parent for this regression");
	const request = {
		version: 4,
		operation: "publish",
		artifacts: [
			{ candidates: [upperUrl, lowerUrl], integrity: upperIntegrity, destinationPath: join(destinationCache, "upper") },
			{ candidates: ["https://registry.example.test/z.tgz"], integrity: lowerIntegrity, destinationPath: join(destinationCache, "lower") },
		],
	};
	const result = await runOwnedCommand(process.execPath, [helperPath, fixtureRoot], {
		cwd: REPO_ROOT,
		env: helperEnv,
		timeoutMs: 30_000,
		totalTimeoutMs: 30_000,
		input: `${JSON.stringify(request)}\n`,
		repoRoot: REPO_ROOT,
		ownershipBootstrapRoot: fixtureRoot,
	});
	assert.equal(result.code, 0, result.stderr);
	assert.equal(isCompleteOwnedCommandShutdown(result.shutdown), true);
	const response = JSON.parse(result.stdout) as { version: number; operation: string; metrics: Record<string, number> };
	assert.equal(response.version, 4);
	assert.equal(response.operation, "publish");
	assert.deepEqual(response.metrics, { linked: 0, copied: 0, missing: 2, corrupt: 0 });
});

test("cache-copy helper redacts JSON-escaped ambient paths from terminal diagnostics", { timeout: 40_000 }, async () => {
	const runRoot = mkdtempSync(join(tmpdir(), "bobbit-packed-cache-helper-redaction-e2e-"));
	const ambientRoot = mkdtempSync(join(tmpdir(), "bobbit packed cache redaction e2e-"));
	roots.push(runRoot, ambientRoot);
	const fixtureRoot = join(runRoot, "prepared-packed-consumer");
	mkdirSync(fixtureRoot, { recursive: true });
	const ambientCache = join(ambientRoot, "_cacache");
	const resolved = "https://registry.example.test/helper-redaction.tgz";
	const cacheKey = `make-fetch-happen:request-cache:${resolved}`;
	const integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
	await cacache.index.insert(ambientCache, cacheKey, integrity);
	const destinationCache = join(fixtureRoot, "npm-cache", "_cacache");
	const destination = await cacache.index.insert(destinationCache, `bobbit-packed-consumer-path:${integrity}`, integrity);
	const helperPath = join(REPO_ROOT, "scripts", "testing-v2", "copy-packed-consumer-cache-batch.mjs");
	const result = await runOwnedCommand(process.execPath, [helperPath, fixtureRoot], {
		cwd: REPO_ROOT,
		env: { ...process.env, BOBBIT_PACKED_CONSUMER_AMBIENT_CACACHE: ambientCache },
		timeoutMs: 30_000,
		totalTimeoutMs: 30_000,
		input: `${JSON.stringify({ version: 4, operation: "publish", artifacts: [{ candidates: [resolved], integrity, destinationPath: destination.path }] })}\n`,
		repoRoot: REPO_ROOT,
		ownershipBootstrapRoot: fixtureRoot,
	});
	assert.equal(result.code, 1);
	assert.match(result.stderr, /<ambient npm cache>/);
	assert.doesNotMatch(result.stderr, new RegExp(ambientRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
	const escaped = JSON.stringify(ambientRoot).slice(1, -1);
	assert.equal(result.stderr.toLowerCase().includes(escaped.toLowerCase()), false,
		"JSON escaping must not bypass ambient-path redaction");
	assert.equal(isCompleteOwnedCommandShutdown(result.shutdown), true);
});

test("stalled cache-copy helper reaps its descendant before preparation rejects", { timeout: 40_000 }, async () => {
	const runRoot = mkdtempSync(join(tmpdir(), "bobbit-packed-cache-helper-shutdown-"));
	roots.push(runRoot);
	const marker = join(runRoot, "helper-pids.json");
	const ambientCache = join(runRoot, "ambient-cache");
	const integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
	const fixture = [
		"const fs=require('node:fs');",
		"const {spawn}=require('node:child_process');",
		"const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
		"const marker=process.argv[1];",
		"fs.writeFileSync(marker+'.tmp',JSON.stringify({root:process.pid,descendant:descendant.pid}));",
		"fs.renameSync(marker+'.tmp',marker);",
		"setInterval(()=>{},1000);",
	].join("");
	const tracked = spawnTracked(process.execPath, ["-e", fixture, marker], {
		cwd: REPO_ROOT,
		env: process.env,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	let rootCloseObserved = false;
	const closed = new Promise<void>((resolve, reject) => {
		tracked.child.once("error", reject);
		tracked.child.once("close", () => {
			rootCloseObserved = true;
			resolve();
		});
	});
	let transportSettled = false;
	const transportSettlement = Promise.allSettled([
		finished(tracked.child.stdin!, { cleanup: true }),
		finished(tracked.child.stdout!, { cleanup: true }),
		finished(tracked.child.stderr!, { cleanup: true }),
	]).then(() => { transportSettled = true; });
	const owner = { tracked, closed, treeExitVerified: false };
	owners.push(owner);

	let pids: HelperPids;
	try {
		pids = await awaitTrackedHelperReady(tracked, marker, 20_000);
	} catch (setupError) {
		try { tracked.killTree("SIGKILL"); } catch { /* reported by the bounded joins below */ }
		const cleanup = await Promise.allSettled([
			closed,
			tracked.waitForTreeExit(10_000).then(verified => {
				if (verified !== true) throw new Error("setup cleanup did not verify tracked helper tree exit");
				owner.treeExitVerified = true;
			}),
			transportSettlement,
		]);
		const cleanupFailures = cleanup
			.filter((result): result is PromiseRejectedResult => result.status === "rejected")
			.map(result => result.reason);
		throw cleanupFailures.length > 0
			? new AggregateError([setupError, ...cleanupFailures], "tracked helper setup and cleanup failed")
			: setupError;
	}
	assert.equal(isAlive(tracked.child.pid), true, "tracked ownership process must be live before the measured preparation call");
	assert.equal(isAlive(pids.root), true, "pre-owned helper root must be live before the measured preparation call");
	assert.equal(isAlive(pids.descendant), true, "pre-owned helper descendant must be live before the measured preparation call");

	let killRequests = 0;
	let spawnInjections = 0;
	let offlineInstallStarted = false;
	const measuredTracked: TrackedChild = {
		child: tracked.child,
		ownershipReady: tracked.ownershipReady,
		killTree: (signal, graceMsOverride) => {
			killRequests++;
			tracked.killTree(signal, graceMsOverride);
		},
		waitForTreeExit: timeoutMs => tracked.waitForTreeExit(timeoutMs),
		killed: () => tracked.killed(),
		timedOut: () => tracked.timedOut(),
		markSurvival: () => tracked.markSurvival(),
	};

	await assert.rejects(preparePackedConsumerFixture({
		repoRoot: REPO_ROOT,
		runRoot,
		preparationTimeoutMs: 10_000,
		ensureDist: () => {},
		resolveNpm: () => ({ command: process.execPath, argsPrefix: ["npm-cli.js"] }),
		runCommand: async (command: string, args: string[], options: Record<string, unknown>) => {
			if (args[0]?.endsWith("copy-packed-consumer-cache-batch.mjs")) {
				return runOwnedCommand(process.execPath, ["-e", fixture, marker], {
					cwd: options.cwd as string,
					env: options.env as NodeJS.ProcessEnv,
					timeoutMs: options.timeoutMs as number,
					totalTimeoutMs: options.totalTimeoutMs as number,
					input: options.input as string,
					maxOutputBytes: options.maxOutputBytes as number,
					treeExitTimeoutMs: 10_000,
					spawnOwned: async (_ownedCommand: string, _ownedArgs: string[], ownedOptions: Record<string, unknown>) => {
						spawnInjections++;
						(ownedOptions.onSpawned as ((candidate: TrackedChild) => void) | undefined)?.(measuredTracked);
						return measuredTracked;
					},
				});
			}
			const result = { command, args: [...args], code: 0, stdout: "", stderr: "" };
			if (args[0]?.endsWith("resolve-packed-consumer-cache-paths.mjs")) {
				const request = JSON.parse(String(options.input)) as { destination: string; integrities: string[] };
				result.stdout = `${JSON.stringify(request.integrities.map((selectedIntegrity, index) => ({
					integrity: selectedIntegrity,
					path: join(request.destination, "resolved", `${index}.content`),
				})))}\n`;
			} else if (args.includes("pack")) {
				const packDir = args[args.indexOf("--pack-destination") + 1]!;
				writeFileSync(join(packDir, "bobbit-fixture.tgz"), "packed bytes");
				result.stdout = JSON.stringify([{ name: "@gresearch/bobbit", filename: "bobbit-fixture.tgz" }]);
			} else if (args.includes("--package-lock-only")) {
				const manifestPath = join(options.cwd as string, "package.json");
				const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
				manifest.dependencies = { "@gresearch/bobbit": "file:../../pack/bobbit-fixture.tgz" };
				writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
				writeFileSync(join(options.cwd as string, "package-lock.json"), JSON.stringify({
					name: "packed-helper-shutdown",
					version: "1.0.0",
					lockfileVersion: 3,
					packages: {
						"": { name: "packed-helper-shutdown", version: "1.0.0", dependencies: manifest.dependencies },
						"node_modules/@gresearch/bobbit": { version: "1.0.0", resolved: "file:../../pack/bobbit-fixture.tgz" },
						"node_modules/dependency": {
							version: "1.0.0",
							resolved: "https://registry.example.test/dependency.tgz",
							integrity,
						},
					},
				}));
			} else if (args.includes("config") && args.includes("get") && args.includes("cache")) {
				mkdirSync(ambientCache, { recursive: true });
				result.stdout = `${ambientCache}\n`;
			} else if (args.includes("ci")) {
				offlineInstallStarted = true;
			}
			return result;
		},
	}), /retained partial fixture and command evidence/);

	await Promise.all([closed, transportSettlement]);
	assert.equal(spawnInjections, 1, "the measured helper command must reuse exactly one pre-owned handle");
	assert.equal(killRequests, 1, "the measured timeout must request exactly one owned-tree kill");
	assert.equal(rootCloseObserved, true, "pre-owned helper root close must settle before preparation rejects");
	assert.equal(transportSettled, true, "all pre-owned helper transports must settle before preparation rejects");
	assert.equal(isAlive(pids.root), false, "helper root must be dead before preparation rejects");
	assert.equal(isAlive(pids.descendant), false, "helper descendant must be dead before preparation rejects");
	assert.equal(offlineInstallStarted, false, "offline install must not start after helper timeout");
	const fixtureRoot = join(runRoot, "prepared-packed-consumer");
	assert.equal(existsSync(join(fixtureRoot, "descriptor.json")), false);
	const evidence = JSON.parse(readFileSync(join(fixtureRoot, "preparation-failure.json"), "utf8"));
	const helperFailure = evidence.error.shutdown ? evidence.error : evidence.error.errors?.[0];
	assert.equal(isCompleteOwnedCommandShutdown(helperFailure?.shutdown), true,
		"preparation must retain complete tree/close/transport proof before rejecting");
	assert.match(JSON.stringify(evidence.error), /total deadline|timed out/);
	assert.equal(existsSync(runRoot), true,
		"failed preparation must retain its authoritative root until async teardown independently re-verifies every owner");
});
