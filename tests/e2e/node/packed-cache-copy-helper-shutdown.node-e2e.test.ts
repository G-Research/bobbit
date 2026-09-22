import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
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
};
const roots: string[] = [];
const owners: Array<{ tracked: TrackedChild; closed: Promise<void>; treeExitVerified: boolean }> = [];

function isAlive(pid: number | undefined): boolean {
	if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
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
	const helperPath = join(REPO_ROOT, "scripts", "testing-v2", "copy-packed-consumer-cache-batch.mjs");
	const result = await runOwnedCommand(process.execPath, [helperPath, fixtureRoot], {
		cwd: REPO_ROOT,
		env: { ...process.env, BOBBIT_PACKED_CONSUMER_AMBIENT_CACACHE: ambientCache },
		timeoutMs: 30_000,
		totalTimeoutMs: 30_000,
		input: `${JSON.stringify({ version: 2, artifacts: [{ resolved, integrity }] })}\n`,
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
		results: Array<{ status: string; partialPath: string }>;
	};
	assert.deepEqual(response.metrics, { linked: 1, copied: 0, missing: 0 });
	assert.equal(response.results[0]?.status, "linked");
	const source = await cacache.get.info(ambientCache, cacheKey);
	assert.ok(source?.path);
	assert.equal(statSync(response.results[0]!.partialPath).ino, statSync(source.path).ino,
		"the helper result must be a hardlink to the exact immutable ambient CAS inode");
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
	let sourceReads = 0;
	let publicationStarted = false;
	let offlineInstallStarted = false;

	await assert.rejects(preparePackedConsumerFixture({
		repoRoot: REPO_ROOT,
		runRoot,
		preparationTimeoutMs: 10_000,
		ensureDist: () => {},
		resolveNpm: () => ({ command: process.execPath, argsPrefix: ["npm-cli.js"] }),
		contentCache: {
			createReadStream: () => {
				sourceReads++;
				const stream = new PassThrough();
				stream.end("must not be read");
				return stream;
			},
			prepareDestination: async () => {},
			createWriteStream: () => new PassThrough(),
			publishDestination: async () => { publicationStarted = true; },
			removeDestination: async () => {},
		},
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
					spawnOwned: async (ownedCommand: string, ownedArgs: string[], ownedOptions: Record<string, unknown>) => {
						const tracked = spawnTracked(ownedCommand, ownedArgs, {
							cwd: ownedOptions.cwd as string,
							env: ownedOptions.env as NodeJS.ProcessEnv,
							stdio: ["pipe", "pipe", "pipe"],
							windowsHide: true,
						});
						const closed = new Promise<void>((resolve, reject) => {
							tracked.child.once("error", reject);
							tracked.child.once("close", () => resolve());
						});
						owners.push({ tracked, closed, treeExitVerified: false });
						return tracked;
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

	assert.equal(existsSync(marker), true, "fake helper must publish both PIDs before its deadline");
	const pids = JSON.parse(readFileSync(marker, "utf8")) as { root: number; descendant: number };
	assert.equal(isAlive(pids.root), false, "helper root must be dead before preparation rejects");
	assert.equal(isAlive(pids.descendant), false, "helper descendant must be dead before preparation rejects");
	assert.equal(sourceReads, 0, "cache verification must not start after helper timeout");
	assert.equal(publicationStarted, false, "cache publication must not start after helper timeout");
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
