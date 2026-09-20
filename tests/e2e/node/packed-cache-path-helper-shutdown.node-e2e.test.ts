import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

test("stalled cache-path helper reaps its descendant before preparation rejects", { timeout: 40_000 }, async () => {
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
			publishDestination: async () => {},
			removeDestination: async () => {},
		},
		runCommand: async (command: string, args: string[], options: Record<string, unknown>) => {
			if (args[0]?.endsWith("resolve-packed-consumer-cache-paths.mjs")) {
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
			if (args.includes("pack")) {
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
	assert.equal(sourceReads, 0, "cache transfer must not start after helper timeout");
	assert.equal(offlineInstallStarted, false, "offline install must not start after helper timeout");
	const fixtureRoot = join(runRoot, "prepared-packed-consumer");
	assert.equal(existsSync(join(fixtureRoot, "descriptor.json")), false);
	const evidence = JSON.parse(readFileSync(join(fixtureRoot, "preparation-failure.json"), "utf8"));
	assert.equal(isCompleteOwnedCommandShutdown(evidence.error.shutdown), true);
	assert.match(evidence.error.message, /total deadline|timed out/);
	assert.equal(existsSync(runRoot), true,
		"failed preparation must retain its authoritative root until async teardown independently re-verifies every owner");
});
