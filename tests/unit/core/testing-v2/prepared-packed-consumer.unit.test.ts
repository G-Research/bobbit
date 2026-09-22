import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, it } from "vitest";
import * as packedConsumerModule from "../../../../scripts/testing-v2/prewarm-packed-consumer-cache.mjs";
import { copyPackedConsumerCacheBatch } from "../../../../scripts/testing-v2/copy-packed-consumer-cache-batch.mjs";
import { resolvePackedConsumerCachePaths } from "../../../../scripts/testing-v2/resolve-packed-consumer-cache-paths.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const FAILURE_PREFIX = "PACKED_CONSUMER_PREPARATION_REUSE";
const require = createRequire(import.meta.url);
const cacache = require("cacache") as {
	put: ((cache: string, key: string, data: Buffer) => Promise<{ toString: () => string }>) & {
		stream: (cache: string, key: string, options: { integrity: string }) => NodeJS.WritableStream;
	};
	get: {
		hasContent: (cache: string, integrity: string) => Promise<unknown>;
		copy: { byDigest: (cache: string, integrity: string, destination: string) => Promise<void> };
		stream: { byDigest: (cache: string, integrity: string) => NodeJS.ReadableStream & AsyncIterable<Uint8Array> };
	};
	ls: (cache: string) => Promise<Record<string, { key?: string; integrity?: string; path?: string }>>;
	index: {
		insert: (cache: string, key: string, integrity: string) => Promise<{ path: string }>;
	};
};
const roots: string[] = [];

type CommandOptions = {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs: number;
	totalTimeoutMs?: number;
	maxOutputBytes?: number;
	maxInputBytes?: number;
	input?: string | Buffer;
	repoRoot?: string;
	ownershipBootstrapRoot?: string;
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

type PathHelperCallback = (context: {
	request: { fixtureRoot: string; destination: string; integrities: string[] };
	entries: Array<{ integrity: string; path: string }>;
	options: CommandOptions;
}) => void | { output?: unknown; rawOutput?: string; code?: number; skipOutput?: boolean } | Promise<void | { output?: unknown; rawOutput?: string; code?: number; skipOutput?: boolean }>;

type CopyHelperRequest = {
	version: number;
	operation: "publish" | "verify";
	artifacts: Array<{ candidates?: string[]; integrity: string; destinationPath: string }>;
};

type CopyHelperCallback = (context: {
	request: CopyHelperRequest;
	response: Record<string, unknown>;
	options: CommandOptions;
}) => void | { output?: unknown; rawOutput?: string; code?: number; skipOutput?: boolean } | Promise<void | { output?: unknown; rawOutput?: string; code?: number; skipOutput?: boolean }>;

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

type PrepareOptions = {
	repoRoot: string;
	runRoot: string;
	baseEnv?: NodeJS.ProcessEnv;
	ensureDist: (options?: { timeoutMs: number; fixtureRoot: string; commands: unknown[] }) => void | Promise<void>;
	resolveNpm: () => { command: string; argsPrefix: string[] };
	runCommand: (command: string, args: string[], options: CommandOptions) => Promise<CommandResult>;
	preparationTimeoutMs?: number;
	now?: () => number;
	repositoryLock?: Record<string, unknown>;
};

type PackedConsumerApi = {
	preparePackedConsumerFixture?: (options: PrepareOptions) => Promise<PreparedDescriptor>;
	seedPackedConsumerCache?: (options: PrepareOptions) => Promise<{ deadline: { identity: string; startedAt: number; expiresAt: number }; seedDescriptorPath: string }>;
	finalizePackedConsumerFixture?: (seed: object) => Promise<PreparedDescriptor>;
	selectRepositorySeedArtifacts?: (lock: Record<string, unknown>, runtime?: { platform: string; arch: string; libc?: string }) => Array<{ resolved: string; integrity?: string }>;
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

function publishRequest(artifacts: Array<{ resolved: string; integrity: string; destinationPath: string }>) {
	return {
		version: 4,
		operation: "publish" as const,
		artifacts: artifacts.map(({ resolved, ...artifact }) => ({ ...artifact, candidates: [resolved] })),
	};
}

function validSha512Integrity(firstByte: number): string {
	const digest = Buffer.alloc(64);
	digest[0] = firstByte;
	return `sha512-${digest.toString("base64")}`;
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
	registryArtifacts,
	consumerRegistryArtifacts,
	onCacheCommand,
	onOfflineInstall,
	runtime,
	ambientCache = join(tmpdir(), "ambient-cache-read-only"),
	preparationTimeoutMs,
	now,
	useRealContentCache = false,
	onPathHelper,
	onCopyHelper,
	copyDecision = () => "missing",
	verifyDecision = () => "verified",
	split = false,
	onSeeded,
}: {
	registryTarballCount?: number;
	registryArtifacts?: Array<{ resolved: string; integrity?: string }>;
	consumerRegistryArtifacts?: Array<{ resolved: string; integrity?: string }>;
	onCacheCommand?: (batchIndex: number, result: CommandResult, options: CommandOptions) => Promise<void>;
	onOfflineInstall?: () => void | Promise<void>;
	runtime?: { platform: NodeJS.Platform; arch: string; libc?: string };
	ambientCache?: string;
	preparationTimeoutMs?: number;
	now?: () => number;
	useRealContentCache?: boolean;
	onPathHelper?: PathHelperCallback;
	onCopyHelper?: CopyHelperCallback;
	copyDecision?: (integrity: string) => "linked" | "copied" | "missing" | "corrupt";
	verifyDecision?: (integrity: string, invocation: number) => "verified" | "missing" | "corrupt";
	split?: boolean;
	onSeeded?: (seed: { deadline: { identity: string; startedAt: number; expiresAt: number }; seedDescriptorPath: string }) => void | Promise<void>;
} = {}) {
	const runRoot = await mkdtemp(join(tmpdir(), "bobbit-prepared-consumer-unit-"));
	roots.push(runRoot);
	const calls: CommandCall[] = [];
	let cacheBatchIndex = 0;
	let verificationInvocation = 0;
	const selectedRegistryArtifacts = registryArtifacts ?? Array.from({ length: registryTarballCount }, (_, index) => ({
		resolved: `https://registry.example.test/dependency-${String(index).padStart(3, "0")}.tgz`,
		integrity: `sha512-${index}`,
	}));
	const repositoryLock = {
		name: "bobbit-seed-fixture",
		version: "1.0.0",
		lockfileVersion: 3,
		packages: {
			"": { name: "bobbit-seed-fixture", version: "1.0.0" },
			...Object.fromEntries(selectedRegistryArtifacts.map((artifact, index) => [
				`node_modules/dependency-${String(index).padStart(3, "0")}`,
				{ version: "1.0.0", ...artifact },
			])),
		},
	};
	const prepareOptions = {
		repoRoot: REPO_ROOT,
		repositoryLock,
		runRoot,
		baseEnv: {
			PATH: process.env.PATH,
			npm_config_cache: ambientCache,
			LANG: "tr_TR.UTF-8",
			LC_ALL: "tr_TR.UTF-8",
		},
		...(runtime ? { runtime } : {}),
		...(preparationTimeoutMs ? { preparationTimeoutMs } : {}),
		...(now ? { now } : {}),
		ensureDist: () => {},
		resolveNpm: () => ({ command: "node", argsPrefix: ["npm-cli.js"] }),
		runCommand: async (command, args, options) => {
			calls.push({ command, args: [...args], options: { ...options, env: { ...options.env } } });
			const result = { command, args: [...args], code: 0, stdout: "", stderr: "" };
			if (args[0]?.endsWith("resolve-packed-consumer-cache-paths.mjs")) {
				assert.equal(args.length, 2, `${FAILURE_PREFIX}: cache-path helper receives only its script and authoritative fixture root`);
				assert.ok(options.input, `${FAILURE_PREFIX}: cache-path helper request must use bounded stdin`);
				const request = JSON.parse(String(options.input)) as {
					fixtureRoot: string;
					destination: string;
					integrities: string[];
				};
				assert.equal(args[1], request.fixtureRoot);
				let entries: Array<{ integrity: string; path: string }>;
				if (useRealContentCache) {
					entries = [];
					for (const integrity of request.integrities) {
						const entry = await cacache.index.insert(
							request.destination,
							`bobbit-packed-consumer-path:${integrity}`,
							integrity,
						);
						entries.push({ integrity, path: entry.path });
					}
				} else {
					entries = request.integrities.map(integrity => ({
						integrity,
						path: join(request.destination, "resolved", encodeURIComponent(integrity)),
					}));
				}
				const decision = await onPathHelper?.({ request, entries, options });
				const output = decision && "output" in decision ? decision.output : entries;
				if (!decision?.skipOutput) result.stdout = decision?.rawOutput ?? `${JSON.stringify(output)}\n`;
				result.code = decision?.code ?? 0;
				return result;
			}
			if (args[0]?.endsWith("copy-packed-consumer-cache-batch.mjs")) {
				assert.equal(args.length, 2, `${FAILURE_PREFIX}: cache helper keeps authority out of argv diagnostics`);
				const request = JSON.parse(String(options.input)) as CopyHelperRequest;
				const sourceContentCache = options.env?.BOBBIT_PACKED_CONSUMER_AMBIENT_CACACHE;
				const results = [];
				for (const artifact of request.artifacts) {
					if (request.operation === "publish") {
						const decision = useRealContentCache ? "linked" : copyDecision(artifact.integrity);
						if (decision === "linked" || decision === "copied") {
							await mkdir(dirname(artifact.destinationPath), { recursive: true });
							if (useRealContentCache) await cacache.get.copy.byDigest(sourceContentCache!, artifact.integrity, artifact.destinationPath);
							else await writeFile(artifact.destinationPath, `copied bytes for ${artifact.integrity}`, { flag: "wx" });
						}
						results.push({
							integrity: artifact.integrity,
							status: decision,
							candidate: decision === "missing" ? null : artifact.candidates![0],
						});
					} else {
						results.push({ integrity: artifact.integrity, status: verifyDecision(artifact.integrity, verificationInvocation) });
					}
				}
				if (request.operation === "verify") verificationInvocation++;
				const metrics: Record<string, number> = request.operation === "publish"
					? { linked: 0, copied: 0, missing: 0, corrupt: 0 }
					: { verified: 0, missing: 0, corrupt: 0 };
				for (const entry of results) metrics[entry.status]++;
				const response = {
					version: 4,
					operation: request.operation,
					results,
					metrics,
					admitted: request.artifacts.length,
					completed: request.artifacts.length,
					maxActive: Math.min(3, request.artifacts.length),
				};
				const helperDecision = await onCopyHelper?.({ request, response, options });
				const output = helperDecision && "output" in helperDecision ? helperDecision.output : response;
				if (!helperDecision?.skipOutput) result.stdout = helperDecision?.rawOutput ?? `${JSON.stringify(output)}\n`;
				result.code = helperDecision?.code ?? 0;
				return result;
			}
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
				const registryPackages = Object.fromEntries((consumerRegistryArtifacts ?? selectedRegistryArtifacts).map((artifact, index) => [
					`node_modules/dependency-${String(index).padStart(3, "0")}`,
					{ version: "1.0.0", ...artifact },
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
			if (args.includes("config") && args.includes("get") && args.includes("cache")) {
				result.stdout = `${ambientCache}\n`;
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
	} satisfies PrepareOptions;
	let seedHandle: { deadline: { identity: string; startedAt: number; expiresAt: number }; seedDescriptorPath: string } | undefined;
	let descriptor: PreparedDescriptor;
	if (split) {
		seedHandle = await requireApi("seedPackedConsumerCache")(prepareOptions);
		await onSeeded?.(seedHandle);
		descriptor = await requireApi("finalizePackedConsumerFixture")(seedHandle);
	} else {
		descriptor = await requireApi("preparePackedConsumerFixture")(prepareOptions);
	}
	return { runRoot, calls, descriptor, seedHandle };
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("prepared packed consumer", () => {
	it("selects a deterministic runtime-compatible production and optional seed superset", () => {
		const select = requireApi("selectRepositorySeedArtifacts");
		const lock = {
			lockfileVersion: 3,
			packages: {
				"": { name: "seed" },
				"node_modules/prod": { version: "1.0.0", resolved: "https://registry.example.test/prod.tgz", integrity: "sha512-prod" },
				"node_modules/prod-duplicate": { version: "1.0.0", resolved: "https://registry.example.test/prod.tgz", integrity: "sha512-prod" },
				"node_modules/optional": { version: "1.0.0", resolved: "https://registry.example.test/optional.tgz", integrity: "sha512-optional", optional: true },
				"node_modules/no-integrity": { version: "1.0.0", resolved: "https://registry.example.test/no-integrity.tgz" },
				"node_modules/dev": { version: "1.0.0", resolved: "https://registry.example.test/dev.tgz", integrity: "sha512-dev", dev: true },
				"node_modules/linux": { version: "1.0.0", resolved: "https://registry.example.test/linux.tgz", integrity: "sha512-linux", os: ["linux"] },
			},
		};
		assert.deepEqual(select(lock, { platform: "win32", arch: "x64" }), [
			{ resolved: "https://registry.example.test/no-integrity.tgz", integrity: undefined },
			{ resolved: "https://registry.example.test/optional.tgz", integrity: "sha512-optional" },
			{ resolved: "https://registry.example.test/prod.tgz", integrity: "sha512-prod" },
		]);
	});

	it("carries one immutable deadline identity and expiry from seed through finalization", async () => {
		let clock = 100;
		const { calls, descriptor, seedHandle } = await prepareFixture({
			split: true,
			preparationTimeoutMs: 300,
			now: () => clock,
			onSeeded: () => { clock = 220; },
		});
		assert.ok(seedHandle);
		assert.equal(seedHandle.deadline.startedAt, 100);
		assert.equal(seedHandle.deadline.expiresAt, 400);
		assert.equal((descriptor as PreparedDescriptor & { seed: { deadline: typeof seedHandle.deadline } }).seed.deadline.identity, seedHandle.deadline.identity);
		assert.equal((descriptor as PreparedDescriptor & { seed: { deadline: typeof seedHandle.deadline } }).seed.deadline.expiresAt, 400);
		const pack = calls.find(call => call.args.includes("pack"));
		assert.equal(pack?.options.totalTimeoutMs, 180, `${FAILURE_PREFIX}: finalization must receive only the post-seed deadline remainder`);
		const packIndex = calls.indexOf(pack!);
		assert.equal(calls.slice(packIndex).some(call => call.args.includes("cache") && call.args.includes("add")), false,
			`${FAILURE_PREFIX}: finalization must not admit late cache population`);
	});

	it("rejects a forged persisted seed descriptor before pack or finalization work", async () => {
		await assert.rejects(prepareFixture({
			split: true,
			onSeeded: async seed => {
				const persisted = JSON.parse(await readFile(seed.seedDescriptorPath, "utf8"));
				persisted.cacheDir = resolve(tmpdir(), "forged-external-cache");
				await writeFile(seed.seedDescriptorPath, `${JSON.stringify(persisted)}\n`);
			},
		}), /persisted seed descriptor does not match/);
		const evidence = JSON.parse(await readFile(join(roots.at(-1)!, "prepared-packed-consumer", "preparation-failure.json"), "utf8"));
		assert.doesNotMatch(JSON.stringify(evidence.commands), /npm-cli\.js[^\n]*pack/);
	});

	it.each([
		["extra URL", [{ resolved: "https://registry.example.test/extra.tgz", integrity: "sha512-seeded" }]],
		["changed integrity", [{ resolved: "https://registry.example.test/seeded.tgz", integrity: "sha512-changed" }]],
		["missing seeded identity", [{ resolved: "https://registry.example.test/missing.tgz" }]],
	] as const)("rejects generated consumer lock %s before offline install or descriptor", async (_label, consumerRegistryArtifacts) => {
		let installed = false;
		await assert.rejects(prepareFixture({
			registryArtifacts: [{ resolved: "https://registry.example.test/seeded.tgz", integrity: "sha512-seeded" }],
			consumerRegistryArtifacts: [...consumerRegistryArtifacts],
			onOfflineInstall: () => { installed = true; },
		}), /outside the verified seed/);
		assert.equal(installed, false);
		const fixtureRoot = join(roots.at(-1)!, "prepared-packed-consumer");
		await assert.rejects(readFile(join(fixtureRoot, "descriptor.json")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
	});

	it("packs and installs the actual tarball once with a run-owned cache and deterministic offline flags", async () => {
		const { runRoot, calls, descriptor } = await prepareFixture();
		const packCalls = calls.filter(call => call.args.includes("pack"));
		const lockOnlyInstalls = calls.filter(call => call.args.includes("install") && call.args.includes("--package-lock-only"));
		const offlineMaterializations = calls.filter(call => call.args.includes("ci") && call.args.includes("--offline"));

		assert.equal(packCalls.length, 1, `${FAILURE_PREFIX}: preparation must run npm pack exactly once`);
		assert.equal(lockOnlyInstalls.length, 1, `${FAILURE_PREFIX}: preparation must resolve the packed artifact exactly once`);
		assert.equal(offlineMaterializations.length, 1, `${FAILURE_PREFIX}: preparation must run one offline npm ci`);
		assert.equal(calls.filter(call => call.args[0]?.endsWith("resolve-packed-consumer-cache-paths.mjs")).length, 0,
			`${FAILURE_PREFIX}: an empty integrity set must skip cache-path helper startup`);
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
			resolve(join(tmpdir(), "ambient-cache-read-only")),
			`${FAILURE_PREFIX}: preparation must not inherit the ambient npm cache`,
		);
	});

	it("publishes a shared exact digest directly to one canonical final path", async () => {
		const integrity = "sha512-shared-exact-digest";
		const { calls, descriptor } = await prepareFixture({
			registryArtifacts: [
				{ resolved: "https://registry.example.test/a.tgz", integrity },
				{ resolved: "https://registry.example.test/unrelated-alias.tgz", integrity },
			],
			copyDecision: () => "copied",
		});

		const copyCalls = calls.filter(call => call.args[0]?.endsWith("copy-packed-consumer-cache-batch.mjs"));
		assert.equal(copyCalls.length, 3, `${FAILURE_PREFIX}: publication and both authority verifications must be tracked helpers`);
		const request = copyCalls.map(call => JSON.parse(String(call.options.input))).find(request => request.operation === "publish");
		assert.equal(request.version, 4);
		assert.equal(request.artifacts.length, 1, `${FAILURE_PREFIX}: duplicate integrities must publish only once`);
		assert.deepEqual(request.artifacts[0], {
			candidates: ["https://registry.example.test/a.tgz", "https://registry.example.test/unrelated-alias.tgz"],
			integrity,
			destinationPath: request.artifacts[0].destinationPath,
		});
		assert.ok(isStrictChild(join(descriptor.cacheDir, "_cacache"), request.artifacts[0].destinationPath));
		assert.equal(await readFile(request.artifacts[0].destinationPath, "utf8"), `copied bytes for ${integrity}`);
		assert.equal(calls.filter(call => call.args.includes("cache") && call.args.includes("add")).length, 0,
			`${FAILURE_PREFIX}: a verified exact ambient hit must not perform fallback`);
		await assert.rejects(readdir(join(descriptor.fixtureRoot, "cache-copy-staging")),
			(error: NodeJS.ErrnoException) => error.code === "ENOENT");
	});

	it("invokes one isolated path helper with fixed root authority, bounded stdin, and the remaining absolute budget", async () => {
		const firstIntegrity = "sha512-helper-a";
		const secondIntegrity = "sha512-helper-b";
		const { runRoot, calls, descriptor } = await prepareFixture({
			registryArtifacts: [
				{ resolved: "https://registry.example.test/a.tgz", integrity: firstIntegrity },
				{ resolved: "https://registry.example.test/b.tgz", integrity: secondIntegrity },
				{ resolved: "https://registry.example.test/a-alias.tgz", integrity: firstIntegrity },
			],
		});
		const helperCalls = calls.filter(call => call.args[0]?.endsWith("resolve-packed-consumer-cache-paths.mjs"));
		assert.equal(helperCalls.length, 1);
		const helper = helperCalls[0]!;
		assert.equal(helper.command, process.execPath);
		assert.equal(helper.args.length, 2, `${FAILURE_PREFIX}: helper receives no ambient cache or integrity argv payload`);
		assert.equal(helper.args[1], descriptor.fixtureRoot, `${FAILURE_PREFIX}: argv must carry the independent fixture authority`);
		const request = JSON.parse(String(helper.options.input));
		assert.deepEqual(Object.keys(request).sort(), ["destination", "fixtureRoot", "integrities"]);
		assert.equal(request.fixtureRoot, descriptor.fixtureRoot);
		assert.equal(request.destination, join(descriptor.cacheDir, "_cacache"));
		assert.deepEqual(request.integrities, [firstIntegrity, secondIntegrity]);
		assert.equal(helper.options.maxOutputBytes, 8 * 1024 * 1024);
		assert.equal(helper.options.cwd, REPO_ROOT);
		assert.equal(helper.options.repoRoot, REPO_ROOT);
		assert.equal(helper.options.ownershipBootstrapRoot, descriptor.fixtureRoot);
		assert.equal(helper.options.timeoutMs, helper.options.totalTimeoutMs);
		assert.ok(helper.options.totalTimeoutMs! > 0 && helper.options.totalTimeoutMs! <= 5 * 60_000);
		assert.equal(helper.options.env?.npm_config_cache, undefined);
		assert.equal(helper.options.env?.NODE_AUTH_TOKEN, undefined);
		assert.equal(helper.options.env?.LANG, undefined);
		assert.equal(helper.options.env?.LC_ALL, undefined);
		assert.equal(helper.options.env?.PATH, process.env.PATH);
		assert.ok(isStrictChild(descriptor.fixtureRoot, helper.options.env?.TEMP ?? ""));
		assert.equal(helper.options.env?.TMP, helper.options.env?.TEMP);
		assert.ok(isStrictChild(runRoot, helper.args[1]!));

		const copyHelpers = calls.filter(call => call.args[0]?.endsWith("copy-packed-consumer-cache-batch.mjs"));
		assert.equal(copyHelpers.length, 3);
		const copyHelper = copyHelpers.find(call => JSON.parse(String(call.options.input)).operation === "publish")!;
		assert.deepEqual(copyHelper.args, [copyHelper.args[0]!, descriptor.fixtureRoot]);
		assert.equal(copyHelper.options.env?.BOBBIT_PACKED_CONSUMER_AMBIENT_CACACHE, join(tmpdir(), "ambient-cache-read-only", "_cacache"));
		const copyRequest = JSON.parse(String(copyHelper.options.input));
		assert.equal(copyRequest.version, 4);
		assert.equal(copyRequest.operation, "publish");
		assert.deepEqual(copyRequest.artifacts.map(({ candidates, integrity }: { candidates: string[]; integrity: string }) => ({ candidates, integrity })), [
			{ candidates: ["https://registry.example.test/a-alias.tgz", "https://registry.example.test/a.tgz"], integrity: firstIntegrity },
			{ candidates: ["https://registry.example.test/b.tgz"], integrity: secondIntegrity },
		]);
		assert.equal(new Set(copyRequest.artifacts.map((artifact: { destinationPath: string }) => artifact.destinationPath)).size, 2);
		assert.ok(copyRequest.artifacts.every((artifact: { destinationPath: string }) =>
			isStrictChild(join(descriptor.cacheDir, "_cacache"), artifact.destinationPath)));
		assert.equal(copyHelper.options.timeoutMs, copyHelper.options.totalTimeoutMs);
		assert.equal(copyHelper.options.maxOutputBytes, 8 * 1024 * 1024);
		assert.equal(copyHelper.options.maxInputBytes, 4 * 1024 * 1024);
		assert.equal(copyHelper.options.ownershipBootstrapRoot, descriptor.fixtureRoot);
		assert.equal(copyHelper.options.env?.npm_config_cache, undefined);
		assert.equal(copyHelper.options.env?.LANG, undefined);
		assert.equal(copyHelper.options.env?.LC_ALL, undefined);
	});

	it("orders protocol-v4 URLs, SRI integrities, and aliases by exact code units", async () => {
		const upperIntegrity = validSha512Integrity(0x20);
		const lowerIntegrity = validSha512Integrity(0x88);
		const upperUrl = "https://registry.example.test/I.tgz";
		const lowerUrl = "https://registry.example.test/i.tgz";
		assert.match(upperIntegrity, /^sha512-I/);
		assert.match(lowerIntegrity, /^sha512-i/);

		const { calls } = await prepareFixture({
			registryArtifacts: [
				{ resolved: lowerUrl, integrity: upperIntegrity },
				{ resolved: "https://registry.example.test/z.tgz", integrity: lowerIntegrity },
				{ resolved: upperUrl, integrity: upperIntegrity },
			],
		});
		const pathRequest = calls
			.map(call => call.args[0]?.endsWith("resolve-packed-consumer-cache-paths.mjs") ? JSON.parse(String(call.options.input)) : undefined)
			.find(Boolean);
		assert.deepEqual(pathRequest.integrities, [upperIntegrity, lowerIntegrity]);
		const publish = calls
			.map(call => call.args[0]?.endsWith("copy-packed-consumer-cache-batch.mjs") ? JSON.parse(String(call.options.input)) as CopyHelperRequest : undefined)
			.find(request => request?.operation === "publish")!;
		assert.deepEqual(publish.artifacts.map(artifact => artifact.integrity), [upperIntegrity, lowerIntegrity]);
		assert.deepEqual(publish.artifacts[0]?.candidates, [upperUrl, lowerUrl]);
	});

	it.each([
		["malformed JSON", async () => ({ rawOutput: "not-json\n" })],
		["missing output", async () => ({ skipOutput: true })],
		["duplicate integrity", async ({ entries }: { entries: Array<{ integrity: string; path: string }> }) => ({
			output: [entries[0], { ...entries[0] }],
		})],
		["extra integrity", async ({ entries }: { entries: Array<{ integrity: string; path: string }> }) => ({
			output: [...entries, { integrity: "sha512-extra", path: `${entries[0]!.path}-extra` }],
		})],
		["out-of-root path", async ({ entries }: { entries: Array<{ integrity: string; path: string }> }) => ({
			output: [{ ...entries[0], path: resolve(tmpdir(), "escaped-cache-content") }],
		})],
		["stale integrity", async ({ entries }: { entries: Array<{ integrity: string; path: string }> }) => ({
			output: [{ ...entries[0], integrity: "sha512-stale" }],
		})],
		["failed helper", async () => ({ code: 17, skipOutput: true })],
	] as const)("blocks transfer, fallback, install, and descriptor after %s", async (_label, onPathHelper) => {
		let offlineStarted = false;
		const registryArtifacts = _label === "duplicate integrity"
			? [
				{ resolved: "https://registry.example.test/a.tgz", integrity: "sha512-a" },
				{ resolved: "https://registry.example.test/b.tgz", integrity: "sha512-b" },
			]
			: [{ resolved: "https://registry.example.test/a.tgz", integrity: "sha512-a" }];
		await assert.rejects(prepareFixture({
			registryArtifacts,
			onPathHelper: onPathHelper as PathHelperCallback,
			onOfflineInstall: () => { offlineStarted = true; },
		}), /retained partial fixture and command evidence/);

		assert.equal(offlineStarted, false);
		const runRoot = roots.at(-1)!;
		const fixtureRoot = join(runRoot, "prepared-packed-consumer");
		await assert.rejects(readFile(join(fixtureRoot, "descriptor.json")),
			(error: NodeJS.ErrnoException) => error.code === "ENOENT");
		const evidence = await readFile(join(fixtureRoot, "preparation-failure.json"), "utf8");
		assert.doesNotMatch(evidence, /npm-cli\.js[^\n]*cache[^\n]*add/);
		assert.doesNotMatch(evidence, /npm-cli\.js[^\n]*ci/);
	});

	it.each([
		["malformed JSON", async () => ({ rawOutput: "not-json\n" })],
		["wrong cardinality", async ({ response }: { response: Record<string, unknown> }) => ({ output: { ...response, results: [] } })],
		["unexpected membership", async ({ response }: { response: Record<string, unknown> }) => ({
			output: { ...response, results: [{ resolved: "https://registry.example.test/forged.tgz", integrity: "sha512-forged", status: "missing" }] },
		})],
		["duplicate membership", async ({ response }: { response: Record<string, unknown> }) => ({
			output: { ...response, results: [
				{ resolved: "https://registry.example.test/a.tgz", integrity: "sha512-a", status: "missing" },
				{ resolved: "https://registry.example.test/a.tgz", integrity: "sha512-a", status: "missing" },
			] },
		})],
		["forged destination echo", async ({ response }: { response: Record<string, unknown> }) => ({
			output: { ...response, results: [{ resolved: "https://registry.example.test/a.tgz", integrity: "sha512-a", status: "copied", destinationPath: resolve(tmpdir(), "forged") }] },
		})],
	] as const)("rejects cache-copy result %s before verification or install", async (_label, onCopyHelper) => {
		let installStarted = false;
		await assert.rejects(prepareFixture({
			registryArtifacts: _label === "duplicate membership"
				? [
					{ resolved: "https://registry.example.test/a.tgz", integrity: "sha512-a" },
					{ resolved: "https://registry.example.test/b.tgz", integrity: "sha512-b" },
				]
				: [{ resolved: "https://registry.example.test/a.tgz", integrity: "sha512-a" }],
			copyDecision: () => "copied",
			onCopyHelper: onCopyHelper as CopyHelperCallback,
			onOfflineInstall: () => { installStarted = true; },
		}), /retained partial fixture and command evidence/);
		assert.equal(installStarted, false);
		const fixtureRoot = join(roots.at(-1)!, "prepared-packed-consumer");
		await assert.rejects(readdir(join(fixtureRoot, "cache-copy-staging")),
			(error: NodeJS.ErrnoException) => error.code === "ENOENT");
	});

	it("runs the public cacache helper and transfers every authoritative path into a by-digest-readable cache", async () => {
		const fixtureRoot = await mkdtemp(join(tmpdir(), "bobbit-cache-path-helper-unit-"));
		const ambientRoot = await mkdtemp(join(tmpdir(), "bobbit-cache-path-ambient-unit-"));
		roots.push(fixtureRoot, ambientRoot);
		const sourceContentCache = join(ambientRoot, "_cacache");
		const destinationContentCache = join(fixtureRoot, "npm-cache", "_cacache");
		const integrities = await Promise.all(Array.from({ length: 3 }, async (_, index) => String(await cacache.put(
			sourceContentCache,
			`source-${index}`,
			Buffer.from(`public helper artifact ${index}`),
		))));
		const ambientIndexBefore = await cacache.ls(sourceContentCache);
		const request = {
			fixtureRoot,
			destination: destinationContentCache,
			integrities,
		};

		const results = await resolvePackedConsumerCachePaths(fixtureRoot, request) as Array<{ integrity: string; path: string }>;
		assert.deepEqual(results.map(result => result.integrity), integrities);
		assert.equal(new Set(results.map(result => resolve(result.path))).size, integrities.length);
		for (const result of results) {
			assert.ok(isAbsolute(result.path));
			assert.ok(isStrictChild(destinationContentCache, result.path));
			assert.ok(isStrictChild(fixtureRoot, result.path));
			await mkdir(dirname(result.path), { recursive: true });
			await pipeline(
				cacache.get.stream.byDigest(sourceContentCache, result.integrity),
				createWriteStream(result.path, { flags: "wx" }),
			);
			const chunks: Buffer[] = [];
			for await (const chunk of cacache.get.stream.byDigest(destinationContentCache, result.integrity)) {
				chunks.push(Buffer.from(chunk));
			}
			assert.match(Buffer.concat(chunks).toString("utf8"), /public helper artifact/);
		}
		assert.deepEqual(await cacache.ls(sourceContentCache), ambientIndexBefore,
			`${FAILURE_PREFIX}: helper and direct by-digest reads must not mutate the ambient index`);
		assert.deepEqual(Object.keys(await cacache.ls(destinationContentCache)).sort(), integrities
			.map(integrity => `bobbit-packed-consumer-path:${integrity}`)
			.sort());
	});

	it("rejects forged root, nonfixed destination, bounded types, and mismatched public index identity before recording paths", async () => {
		const fixtureRoot = await mkdtemp(join(tmpdir(), "bobbit-cache-authority-unit-"));
		const externalRoot = await mkdtemp(join(tmpdir(), "bobbit-cache-external-unit-"));
		roots.push(fixtureRoot, externalRoot);
		const destination = join(fixtureRoot, "npm-cache", "_cacache");
		const externalDestination = join(externalRoot, "npm-cache", "_cacache");
		const integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
		const valid = { fixtureRoot, destination, integrities: [integrity] };
		let insertions = 0;
		const indexInsert = async (_cache: string, key: string, selectedIntegrity: string) => {
			insertions++;
			return { key, integrity: selectedIntegrity, path: join(destination, "content", String(insertions)) };
		};

		await assert.rejects(resolvePackedConsumerCachePaths(fixtureRoot, {
			...valid,
			fixtureRoot: externalRoot,
			destination: externalDestination,
		}, { indexInsert }), /does not match authoritative fixture root/);
		await assert.rejects(resolvePackedConsumerCachePaths(fixtureRoot, {
			...valid,
			destination: join(fixtureRoot, "other", "_cacache"),
		}, { indexInsert }), /must equal the authoritative fixture/);
		await assert.rejects(resolvePackedConsumerCachePaths(fixtureRoot, {
			...valid,
			integrities: "not-an-array",
		} as unknown as typeof valid, { indexInsert }), /must be an array/);
		assert.equal(insertions, 0, `${FAILURE_PREFIX}: invalid authority and bounded types must fail before index mutation`);

		for (const [label, returned] of [
			["key", { key: "wrong", integrity, path: join(destination, "content", "a") }],
			["integrity", { key: `bobbit-packed-consumer-path:${integrity}`, integrity: `${integrity}wrong`, path: join(destination, "content", "b") }],
			["path", { key: `bobbit-packed-consumer-path:${integrity}`, integrity, path: join(externalRoot, "content") }],
		] as const) {
			await assert.rejects(resolvePackedConsumerCachePaths(fixtureRoot, valid, {
				indexInsert: async () => returned,
			}), new RegExp(`mismatched(?: canonical)? ${label}|out-of-root`));
		}
		assert.deepEqual(await cacache.ls(externalDestination), {},
			`${FAILURE_PREFIX}: rejected forged authority must not mutate the requested external index`);
	});

	it("direct helper caps work at three, stops fatal admission, and joins admitted publication", async () => {
		const fixtureRoot = await mkdtemp(join(tmpdir(), "bobbit-cache-copy-fatal-unit-"));
		const ambientRoot = await mkdtemp(join(tmpdir(), "bobbit-cache-copy-fatal-ambient-unit-"));
		roots.push(fixtureRoot, ambientRoot);
		const ambientCache = join(ambientRoot, "_cacache");
		await mkdir(ambientCache, { recursive: true });
		const artifacts: Array<{ resolved: string; integrity: string; destinationPath: string; sourcePath: string }> = [];
		for (let index = 0; index < 7; index++) {
			const sourcePath = join(ambientCache, "content", String(index));
			await mkdir(dirname(sourcePath), { recursive: true });
			await writeFile(sourcePath, `source-${index}`);
			artifacts.push({
				resolved: `https://registry.example.test/fatal-${index}.tgz`,
				integrity: `sha512-fatal-${index}`,
				destinationPath: join(fixtureRoot, "npm-cache", "_cacache", "content", String(index)),
				sourcePath,
			});
		}
		const gates = artifacts.map(() => deferred());
		const admitted: number[] = [];
		const settled: number[] = [];
		const copying = copyPackedConsumerCacheBatch(fixtureRoot, ambientCache, publishRequest(
			artifacts.map(({ resolved, integrity, destinationPath }) => ({ resolved, integrity, destinationPath })),
		), {
			lookup: async (_cache: string, key: string) => {
				const index = artifacts.findIndex(artifact => key.endsWith(artifact.resolved));
				return { key, integrity: artifacts[index]!.integrity, path: artifacts[index]!.sourcePath };
			},
			linkFile: async () => { throw Object.assign(new Error("force physical copy"), { code: "EXDEV" }); },
			copyPhysical: async (_source: string, destination: string) => {
				const index = artifacts.findIndex(artifact => artifact.destinationPath === destination);
				admitted.push(index);
				try {
					await gates[index]!.promise;
					await writeFile(destination, `copy-${index}`, { flag: "wx" });
				} finally { settled.push(index); }
			},
			readDigest: async () => Buffer.from("verified"),
		});
		const observed = copying.then(() => undefined, (error: unknown) => error);
		await waitFor(() => admitted.length === 3);
		gates[1]!.reject(Object.assign(new Error("fatal cache publication"), { code: "EIO" }));
		await waitFor(() => settled.includes(1));
		assert.deepEqual([...admitted].sort(), [0, 1, 2]);
		gates[0]!.resolve();
		gates[2]!.resolve();
		const error = await observed;
		assert.ok(error instanceof AggregateError);
		assert.deepEqual(settled.sort(), [0, 1, 2]);
		assert.match(error.message, /admitted=3, completed=3, maxActive=3/);
	});

	it("returns bounded verify results for present, missing, and corrupt digests", async () => {
		const fixtureRoot = await mkdtemp(join(tmpdir(), "bobbit-cache-verify-unit-"));
		roots.push(fixtureRoot);
		await mkdir(join(fixtureRoot, "npm-cache", "_cacache"), { recursive: true });
		const artifacts = ["sha512-a-present", "sha512-b-missing", "sha512-c-corrupt"].map(integrity => ({
			integrity,
			destinationPath: join(fixtureRoot, "npm-cache", "_cacache", integrity),
		}));
		const removed: string[] = [];
		const result = await copyPackedConsumerCacheBatch(fixtureRoot, undefined, {
			version: 4,
			operation: "verify",
			artifacts,
		}, {
			readDigest: async (_cache: string, integrity: string) => {
				if (integrity.endsWith("missing")) throw Object.assign(new Error("absent"), { code: "ENOENT" });
				if (integrity.endsWith("corrupt")) throw Object.assign(new Error("bad bytes"), { code: "EINTEGRITY" });
				return Buffer.from("present");
			},
			removeDestination: async (path: string) => { removed.push(path); },
		});
		assert.deepEqual(result.results, [
			{ integrity: "sha512-a-present", status: "verified" },
			{ integrity: "sha512-b-missing", status: "missing" },
			{ integrity: "sha512-c-corrupt", status: "corrupt" },
		]);
		assert.deepEqual(result.metrics, { verified: 1, missing: 1, corrupt: 1 });
		assert.deepEqual(removed, [], `${FAILURE_PREFIX}: final verification reports corruption without deleting caller-selected paths`);
	});

	it("caps verification at three, stops fatal admission, and joins every admitted read", async () => {
		const fixtureRoot = await mkdtemp(join(tmpdir(), "bobbit-cache-verify-fatal-unit-"));
		roots.push(fixtureRoot);
		await mkdir(join(fixtureRoot, "npm-cache", "_cacache"), { recursive: true });
		const artifacts = Array.from({ length: 7 }, (_, index) => ({
			integrity: `sha512-${index}`,
			destinationPath: join(fixtureRoot, "npm-cache", "_cacache", String(index)),
		}));
		const gates = artifacts.map(() => deferred());
		const admitted: number[] = [];
		const settled: number[] = [];
		const verifying = copyPackedConsumerCacheBatch(fixtureRoot, undefined, {
			version: 4,
			operation: "verify",
			artifacts,
		}, {
			readDigest: async (_cache: string, integrity: string) => {
				const index = artifacts.findIndex(artifact => artifact.integrity === integrity);
				admitted.push(index);
				try { await gates[index]!.promise; } finally { settled.push(index); }
				return Buffer.from("verified");
			},
		});
		const observed = verifying.then(() => undefined, (error: unknown) => error);
		await waitFor(() => admitted.length === 3);
		gates[1]!.reject(Object.assign(new Error("fatal verification I/O"), { code: "EIO" }));
		await waitFor(() => settled.includes(1));
		assert.equal(admitted.length, 3);
		gates[0]!.resolve();
		gates[2]!.resolve();
		const error = await observed;
		assert.ok(error instanceof AggregateError);
		assert.deepEqual(settled.sort(), [0, 1, 2]);
		assert.match(error.message, /admitted=3, completed=3, maxActive=3/);
	});

	it("treats a missing ambient root and normalized-key drift as bounded misses", async () => {
		const fixtureRoot = await mkdtemp(join(tmpdir(), "bobbit-cache-copy-miss-unit-"));
		const ambientRoot = await mkdtemp(join(tmpdir(), "bobbit-cache-copy-miss-ambient-unit-"));
		roots.push(fixtureRoot, ambientRoot);
		const missingCache = join(ambientRoot, "missing", "_cacache");
		const destinationPath = join(fixtureRoot, "npm-cache", "_cacache", "content", "missing");
		const artifact = { resolved: "https://registry.example.test/missing.tgz", integrity: "sha512-missing", destinationPath };
		let lookups = 0;
		const missing = await copyPackedConsumerCacheBatch(fixtureRoot, missingCache, publishRequest([artifact]), {
			lookup: async () => { lookups++; },
		});
		assert.equal(lookups, 0);
		assert.deepEqual(missing.results, [{ integrity: artifact.integrity, status: "missing", candidate: null }]);
		assert.deepEqual(missing.metrics, { linked: 0, copied: 0, missing: 1, corrupt: 0 });

		const ambientCache = join(ambientRoot, "present", "_cacache");
		await mkdir(ambientCache, { recursive: true });
		const drift = await copyPackedConsumerCacheBatch(fixtureRoot, ambientCache, publishRequest([artifact]), {
			lookup: async () => ({
				key: `make-fetch-happen:request-cache-v2:${artifact.resolved}`,
				integrity: artifact.integrity,
				path: join(ambientCache, "content", "false-hit"),
			}),
		});
		assert.deepEqual(drift.metrics, { linked: 0, copied: 0, missing: 1, corrupt: 0 });
		assert.equal(existsSync(destinationPath), false);
	});

	it("accepts binary mixed-case protocol order and rejects reversed URLs or SRI integrities", async () => {
		const fixtureRoot = await mkdtemp(join(tmpdir(), "bobbit-cache-binary-order-unit-"));
		const ambientRoot = await mkdtemp(join(tmpdir(), "bobbit-cache-binary-order-ambient-unit-"));
		roots.push(fixtureRoot, ambientRoot);
		const destinationCache = join(fixtureRoot, "npm-cache", "_cacache");
		const upperIntegrity = validSha512Integrity(0x20);
		const lowerIntegrity = validSha512Integrity(0x88);
		const upperUrl = "https://registry.example.test/I.tgz";
		const lowerUrl = "https://registry.example.test/i.tgz";
		const binaryRequest = {
			version: 4,
			operation: "publish" as const,
			artifacts: [
				{ candidates: [upperUrl, lowerUrl], integrity: upperIntegrity, destinationPath: join(destinationCache, "upper") },
				{ candidates: ["https://registry.example.test/z.tgz"], integrity: lowerIntegrity, destinationPath: join(destinationCache, "lower") },
			],
		};
		const accepted = await copyPackedConsumerCacheBatch(fixtureRoot, join(ambientRoot, "missing", "_cacache"), binaryRequest);
		assert.deepEqual(accepted.metrics, { linked: 0, copied: 0, missing: 2, corrupt: 0 });

		await assert.rejects(copyPackedConsumerCacheBatch(fixtureRoot, join(ambientRoot, "missing", "_cacache"), {
			...binaryRequest,
			artifacts: [{ ...binaryRequest.artifacts[0]!, candidates: [lowerUrl, upperUrl] }],
		}), /candidate URLs must be sorted and unique/);
		await assert.rejects(copyPackedConsumerCacheBatch(fixtureRoot, join(ambientRoot, "missing", "_cacache"), {
			...binaryRequest,
			artifacts: [...binaryRequest.artifacts].reverse(),
		}), /artifacts must be sorted and unique by integrity/);
	});

	it("tries deterministic aliases until a later exact hit and never falls back to a dead first URL", async () => {
		const fixtureRoot = await mkdtemp(join(tmpdir(), "bobbit-cache-alias-unit-"));
		const ambientRoot = await mkdtemp(join(tmpdir(), "bobbit-cache-alias-ambient-unit-"));
		roots.push(fixtureRoot, ambientRoot);
		const ambientCache = join(ambientRoot, "_cacache");
		const sourcePath = join(ambientCache, "content", "alias-hit");
		await mkdir(dirname(sourcePath), { recursive: true });
		await writeFile(sourcePath, "alias content");
		const dead = "https://registry.example.test/a-dead.tgz";
		const hit = "https://registry.example.test/z-hit.tgz";
		const integrity = "sha512-alias";
		const destinationPath = join(fixtureRoot, "npm-cache", "_cacache", "content", "alias");
		const lookedUp: string[] = [];
		const result = await copyPackedConsumerCacheBatch(fixtureRoot, ambientCache, {
			version: 4,
			operation: "publish",
			artifacts: [{ candidates: [dead, hit], integrity, destinationPath }],
		}, {
			lookup: async (_cache: string, key: string) => {
				lookedUp.push(key);
				if (key.endsWith(dead)) return { key, integrity: "sha512-mismatch", path: sourcePath };
				return { key, integrity, path: sourcePath };
			},
			readDigest: async () => Buffer.from("alias content"),
		});
		assert.deepEqual(lookedUp, [dead, hit].map(url => `make-fetch-happen:request-cache:${url}`));
		assert.deepEqual(result.results, [{ integrity, status: "linked", candidate: hit }]);
		assert.deepEqual(result.metrics, { linked: 1, copied: 0, missing: 0, corrupt: 0 });
		await assert.rejects(copyPackedConsumerCacheBatch(fixtureRoot, ambientCache, {
			version: 4,
			operation: "publish",
			artifacts: [{ candidates: [hit, dead], integrity: `${integrity}-unsorted`, destinationPath: `${destinationPath}-unsorted` }],
		}), /candidate URLs must be sorted and unique/);
	});

	it("returns one bounded miss only after every alias misses or mismatches SRI", async () => {
		const fixtureRoot = await mkdtemp(join(tmpdir(), "bobbit-cache-alias-miss-unit-"));
		const ambientRoot = await mkdtemp(join(tmpdir(), "bobbit-cache-alias-miss-ambient-unit-"));
		roots.push(fixtureRoot, ambientRoot);
		const ambientCache = join(ambientRoot, "_cacache");
		await mkdir(ambientCache, { recursive: true });
		const candidates = ["https://registry.example.test/a.tgz", "https://registry.example.test/b.tgz"];
		const integrity = "sha512-alias-miss";
		let lookups = 0;
		const result = await copyPackedConsumerCacheBatch(fixtureRoot, ambientCache, {
			version: 4,
			operation: "publish",
			artifacts: [{ candidates, integrity, destinationPath: join(fixtureRoot, "npm-cache", "_cacache", "alias-miss") }],
		}, {
			lookup: async (_cache: string, key: string) => {
				lookups++;
				return key.endsWith("a.tgz") ? null : { key, integrity: "sha512-wrong", path: join(ambientCache, "wrong") };
			},
		});
		assert.equal(lookups, 2);
		assert.deepEqual(result.results, [{ integrity, status: "missing", candidate: null }]);
		assert.deepEqual(result.metrics, { linked: 0, copied: 0, missing: 1, corrupt: 0 });
	});

	it("removes a corrupt direct publication before exact fallback", async () => {
		const fixtureRoot = await mkdtemp(join(tmpdir(), "bobbit-cache-corrupt-unit-"));
		const ambientRoot = await mkdtemp(join(tmpdir(), "bobbit-cache-corrupt-ambient-unit-"));
		roots.push(fixtureRoot, ambientRoot);
		const ambientCache = join(ambientRoot, "_cacache");
		const sourcePath = join(ambientCache, "content", "corrupt");
		await mkdir(dirname(sourcePath), { recursive: true });
		await writeFile(sourcePath, "corrupt bytes");
		const artifact = {
			resolved: "https://registry.example.test/corrupt.tgz",
			integrity: "sha512-corrupt",
			destinationPath: join(fixtureRoot, "npm-cache", "_cacache", "corrupt"),
		};
		const removed: string[] = [];
		const result = await copyPackedConsumerCacheBatch(fixtureRoot, ambientCache, publishRequest([artifact]), {
			lookup: async (_cache: string, key: string) => ({ key, integrity: artifact.integrity, path: sourcePath }),
			readDigest: async () => { throw Object.assign(new Error("bad digest"), { code: "EINTEGRITY" }); },
			removeDestination: async (path: string) => { removed.push(path); await unlink(path); },
		});
		assert.deepEqual(result.results, [{ integrity: artifact.integrity, status: "corrupt", candidate: artifact.resolved }]);
		assert.deepEqual(result.metrics, { linked: 0, copied: 0, missing: 0, corrupt: 1 });
		assert.deepEqual(removed, [artifact.destinationPath]);
		assert.equal(existsSync(artifact.destinationPath), false);
	});

	it("hardlinks an exact hit directly to its final path and survives ambient unlink without staging", async () => {
		const fixtureRoot = await mkdtemp(join(tmpdir(), "bobbit-cache-link-unit-"));
		const ambientRoot = await mkdtemp(join(tmpdir(), "bobbit-cache-link-ambient-unit-"));
		roots.push(fixtureRoot, ambientRoot);
		const ambientCache = join(ambientRoot, "_cacache");
		const sourcePath = join(ambientCache, "content", "exact-content");
		await mkdir(dirname(sourcePath), { recursive: true });
		await writeFile(sourcePath, "immutable exact content");
		const artifact = {
			resolved: "https://registry.example.test/exact.tgz",
			integrity: "sha512-exact",
			destinationPath: join(fixtureRoot, "npm-cache", "_cacache", "content", "final"),
		};
		const expectedKey = `make-fetch-happen:request-cache:${artifact.resolved}`;
		const result = await copyPackedConsumerCacheBatch(fixtureRoot, ambientCache, publishRequest([artifact]), {
			lookup: async () => ({ key: expectedKey, integrity: artifact.integrity, path: sourcePath }),
			readDigest: async () => Buffer.from("immutable exact content"),
		});
		assert.deepEqual(result.metrics, { linked: 1, copied: 0, missing: 0, corrupt: 0 });
		const [sourceStat, finalStat] = await Promise.all([stat(sourcePath), stat(artifact.destinationPath)]);
		assert.equal(finalStat.ino, sourceStat.ino);
		await unlink(sourcePath);
		assert.equal(await readFile(artifact.destinationPath, "utf8"), "immutable exact content");
		assert.equal(existsSync(join(fixtureRoot, "cache-copy-staging")), false);
	});

	it("uses exclusive physical copy only for supported hardlink failures and rejects collisions", async () => {
		const fixtureRoot = await mkdtemp(join(tmpdir(), "bobbit-cache-link-fallback-unit-"));
		const ambientRoot = await mkdtemp(join(tmpdir(), "bobbit-cache-link-fallback-ambient-unit-"));
		roots.push(fixtureRoot, ambientRoot);
		const ambientCache = join(ambientRoot, "_cacache");
		const sourcePath = join(ambientCache, "content", "exact-content");
		await mkdir(dirname(sourcePath), { recursive: true });
		await writeFile(sourcePath, "physical bytes");
		const baseArtifact = { resolved: "https://registry.example.test/fallback.tgz", integrity: "sha512-fallback" };
		const expectedKey = `make-fetch-happen:request-cache:${baseArtifact.resolved}`;
		for (const code of ["EXDEV", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EISDIR"]) {
			const artifact = { ...baseArtifact, destinationPath: join(fixtureRoot, "npm-cache", "_cacache", "content", code) };
			let copies = 0;
			const copied = await copyPackedConsumerCacheBatch(fixtureRoot, ambientCache, publishRequest([artifact]), {
				lookup: async () => ({ key: expectedKey, integrity: artifact.integrity, path: sourcePath }),
				linkFile: async () => { throw Object.assign(new Error("unsupported"), { code }); },
				copyPhysical: async (source: string, destination: string) => { copies++; await copyFile(source, destination, 1); },
				readDigest: async () => Buffer.from("physical bytes"),
			});
			assert.equal(copies, 1, `${code} must use one exclusive physical copy`);
			assert.deepEqual(copied.metrics, { linked: 0, copied: 1, missing: 0, corrupt: 0 });
		}
		const crossVolume = { ...baseArtifact, destinationPath: join(fixtureRoot, "npm-cache", "_cacache", "content", "different-device") };
		let crossVolumeLinks = 0;
		let crossVolumeCopies = 0;
		const inspectWithDifferentSourceDevice = async (path: string) => {
			const entry = await lstat(path);
			if (path !== sourcePath) return entry;
			return new Proxy(entry, { get(target, property, receiver) {
				if (property === "dev") return target.dev + 1;
				return Reflect.get(target, property, receiver);
			} });
		};
		const crossVolumeResult = await copyPackedConsumerCacheBatch(fixtureRoot, ambientCache, publishRequest([crossVolume]), {
			lookup: async () => ({ key: expectedKey, integrity: crossVolume.integrity, path: sourcePath }),
			inspectPath: inspectWithDifferentSourceDevice,
			linkFile: async () => { crossVolumeLinks++; },
			copyPhysical: async (source: string, destination: string) => { crossVolumeCopies++; await copyFile(source, destination, 1); },
			readDigest: async () => Buffer.from("physical bytes"),
		});
		assert.equal(crossVolumeLinks, 0);
		assert.equal(crossVolumeCopies, 1);
		assert.deepEqual(crossVolumeResult.metrics, { linked: 0, copied: 1, missing: 0, corrupt: 0 });

		for (const code of ["EACCES", "EPERM", "EIO", "EEXIST", "EINTEGRITY", "UNKNOWN"]) {
			const artifact = { ...baseArtifact, destinationPath: join(fixtureRoot, "npm-cache", "_cacache", "fatal", code) };
			let copies = 0;
			await assert.rejects(copyPackedConsumerCacheBatch(fixtureRoot, ambientCache, publishRequest([artifact]), {
				lookup: async () => ({ key: expectedKey, integrity: artifact.integrity, path: sourcePath }),
				linkFile: async () => { throw Object.assign(new Error(`fatal-${code}`), { code }); },
				copyPhysical: async () => { copies++; },
			}), (error: unknown) => error instanceof AggregateError && error.errors.some(failure => failure.message === `fatal-${code}`));
			assert.equal(copies, 0);
		}
		const collision = { ...baseArtifact, destinationPath: join(fixtureRoot, "npm-cache", "_cacache", "collision") };
		await mkdir(dirname(collision.destinationPath), { recursive: true });
		await writeFile(collision.destinationPath, "preexisting");
		await assert.rejects(copyPackedConsumerCacheBatch(fixtureRoot, ambientCache, publishRequest([collision]), {
			lookup: async () => ({ key: expectedKey, integrity: collision.integrity, path: sourcePath }),
		}), (error: unknown) => error instanceof AggregateError && error.errors.some(failure => (failure as NodeJS.ErrnoException).code === "EEXIST"));
		assert.equal(await readFile(collision.destinationPath, "utf8"), "preexisting");
		assert.equal(existsSync(join(fixtureRoot, "cache-copy-staging")), false,
			`${FAILURE_PREFIX}: linked and copied hits must publish without staging`);
	});

	it("rejects forged destinations, ambient source escapes, and reparse destination ancestry", async () => {
		const fixtureRoot = await mkdtemp(join(tmpdir(), "bobbit-cache-authority-unit-"));
		const ambientRoot = await mkdtemp(join(tmpdir(), "bobbit-cache-authority-ambient-unit-"));
		const externalRoot = await mkdtemp(join(tmpdir(), "bobbit-cache-authority-external-unit-"));
		roots.push(fixtureRoot, ambientRoot, externalRoot);
		const ambientCache = join(ambientRoot, "_cacache");
		const sourcePath = join(ambientCache, "content", "exact");
		await mkdir(dirname(sourcePath), { recursive: true });
		await writeFile(sourcePath, "exact");
		const base = { resolved: "https://registry.example.test/guard.tgz", integrity: "sha512-guard" };
		const expectedKey = `make-fetch-happen:request-cache:${base.resolved}`;
		await assert.rejects(copyPackedConsumerCacheBatch(fixtureRoot, ambientCache, publishRequest([
			{ ...base, destinationPath: join(externalRoot, "forged") },
		])), /strict child/);
		const duplicateDestination = join(fixtureRoot, "npm-cache", "_cacache", "duplicate");
		await assert.rejects(copyPackedConsumerCacheBatch(fixtureRoot, ambientCache, publishRequest([
			{ resolved: "https://registry.example.test/a.tgz", integrity: "sha512-a", destinationPath: duplicateDestination },
			{ resolved: "https://registry.example.test/b.tgz", integrity: "sha512-b", destinationPath: duplicateDestination },
		])), /destination paths must be unique/);
		const safe = { ...base, destinationPath: join(fixtureRoot, "npm-cache", "_cacache", "safe") };
		await assert.rejects(copyPackedConsumerCacheBatch(fixtureRoot, ambientCache, publishRequest([safe]), {
			lookup: async () => ({ key: expectedKey, integrity: safe.integrity, path: join(externalRoot, "escaped") }),
		}), (error: unknown) => error instanceof AggregateError && error.errors.some(failure => /out-of-cache/.test(failure.message)));

		const reparsePath = join(fixtureRoot, "npm-cache");
		const originalLstat = lstat;
		await assert.rejects(copyPackedConsumerCacheBatch(fixtureRoot, ambientCache, publishRequest([safe]), {
			lookup: async () => ({ key: expectedKey, integrity: safe.integrity, path: sourcePath }),
			inspectPath: async (path: string) => path === reparsePath
				? { isDirectory: () => true, isSymbolicLink: () => true }
				: originalLstat(path),
		}), (error: unknown) => error instanceof AggregateError && error.errors.some(failure => /destination ancestry/.test(failure.message)));
	});

	it("copies many real cacache digests through public retained destination entries without mutating ambient indexes", async () => {
		const ambientCache = await mkdtemp(join(tmpdir(), "bobbit-ambient-cache-unit-"));
		roots.push(ambientCache);
		const sourceContentCache = join(ambientCache, "_cacache");
		const registryArtifacts = await Promise.all(Array.from({ length: 24 }, async (_, index) => {
			const resolved = `https://registry.example.test/real-${index}.tgz`;
			return {
				resolved,
				integrity: String(await cacache.put(
					sourceContentCache,
					`make-fetch-happen:request-cache:${resolved}`,
					Buffer.from(`unique real cacache artifact ${index}`),
				)),
			};
		}));
		const ambientIndexBefore = await cacache.ls(sourceContentCache);

		const { calls, descriptor } = await prepareFixture({
			ambientCache,
			registryArtifacts,
			runtime: { platform: "win32", arch: "x64" },
			useRealContentCache: true,
		});
		const destinationContentCache = join(descriptor.cacheDir, "_cacache");

		for (const artifact of registryArtifacts) {
			assert.ok(await cacache.get.hasContent(destinationContentCache, artifact.integrity),
				`${FAILURE_PREFIX}: destination digest must verify after direct CAS publication`);
		}
		assert.deepEqual(await cacache.ls(sourceContentCache), ambientIndexBefore,
			`${FAILURE_PREFIX}: integrity reads must leave the ambient cache index unchanged`);
		const destinationEntries = await cacache.ls(destinationContentCache);
		assert.deepEqual(Object.keys(destinationEntries).sort(), registryArtifacts
			.map(artifact => `bobbit-packed-consumer-path:${artifact.integrity}`)
			.sort(), `${FAILURE_PREFIX}: public path resolution must retain one synthetic destination entry per digest`);
		for (const artifact of registryArtifacts) {
			const entry = destinationEntries[`bobbit-packed-consumer-path:${artifact.integrity}`];
			assert.equal(entry?.integrity, artifact.integrity);
			assert.ok(entry?.path && isStrictChild(destinationContentCache, entry.path),
				`${FAILURE_PREFIX}: public index paths must remain strict children of the destination cache`);
		}
		assert.equal(calls.filter(call => call.args[0]?.endsWith("resolve-packed-consumer-cache-paths.mjs")).length, 1,
			`${FAILURE_PREFIX}: all destination paths must be resolved by one helper invocation`);
		assert.equal(calls.filter(call => call.args.includes("cache") && call.args.includes("add")).length, 0,
			`${FAILURE_PREFIX}: all exact ambient digests must avoid network fallback`);
	});

	it("falls back by exact URL for helper misses, corrupt copied content, and entries without integrity", async () => {
		const missingUrl = "https://registry.example.test/missing.tgz";
		const corruptUrl = "https://registry.example.test/corrupt.tgz";
		const noIntegrityUrl = "https://registry.example.test/no-integrity.tgz";
		const { calls } = await prepareFixture({
			registryArtifacts: [
				{ resolved: missingUrl, integrity: "sha512-missing" },
				{ resolved: corruptUrl, integrity: "sha512-corrupt" },
				{ resolved: noIntegrityUrl },
			],
			copyDecision: integrity => integrity === "sha512-corrupt" ? "corrupt" : "missing",
		});

		const cacheAdds = calls.filter(call => call.args.includes("cache") && call.args.includes("add"));
		assert.equal(cacheAdds.length, 1);
		assert.deepEqual(cacheAdds[0]?.args.slice(cacheAdds[0]!.args.indexOf("--cache") + 2),
			[corruptUrl, missingUrl, noIntegrityUrl].sort(),
			`${FAILURE_PREFIX}: fallback must contain only exact locked URLs in deterministic order`);
		const helperRequests = calls.filter(call => call.args[0]?.endsWith("copy-packed-consumer-cache-batch.mjs"))
			.map(call => JSON.parse(String(call.options.input)) as CopyHelperRequest);
		assert.deepEqual(helperRequests.map(request => request.operation), ["publish", "verify", "verify"],
			`${FAILURE_PREFIX}: direct verification plus both final authority points must stay helper-owned`);
	});

	it("blocks offline install and descriptor publication when a fallback digest is still absent", async () => {
		let offlineStarted = false;
		const preparing = prepareFixture({
			registryArtifacts: [{
				resolved: "https://registry.example.test/still-missing.tgz",
				integrity: "sha512-still-missing",
			}],
			verifyDecision: () => "missing",
			onOfflineInstall: () => { offlineStarted = true; },
		});

		await assert.rejects(preparing, /isolated cache is missing or corrupt/);
		assert.equal(offlineStarted, false, `${FAILURE_PREFIX}: verification failure must prevent offline npm ci`);
		const runRoot = roots.at(-1)!;
		await assert.rejects(readFile(join(runRoot, "prepared-packed-consumer", "descriptor.json")),
			(error: NodeJS.ErrnoException) => error.code === "ENOENT");
		const evidence = JSON.parse(await readFile(join(runRoot, "prepared-packed-consumer", "preparation-failure.json"), "utf8"));
		assert.match(evidence.error.message, /still-missing\.tgz \(sha512-still-missing; missing\)/);
	});

	it("fails closed when tracked all-final verification fails before install or descriptor publication", async () => {
		let offlineStarted = false;
		let verificationCalls = 0;
		await assert.rejects(prepareFixture({
			registryArtifacts: [{
				resolved: "https://registry.example.test/verify-fatal.tgz",
				integrity: "sha512-verify-fatal",
			}],
			copyDecision: () => "copied",
			onCopyHelper: ({ request }) => {
				if (request.operation !== "verify") return;
				verificationCalls++;
				return { code: 17, skipOutput: true };
			},
			onOfflineInstall: () => { offlineStarted = true; },
		}), /retained partial fixture and command evidence/);
		assert.equal(verificationCalls, 1);
		assert.equal(offlineStarted, false);
		const fixtureRoot = join(roots.at(-1)!, "prepared-packed-consumer");
		await assert.rejects(readFile(join(fixtureRoot, "descriptor.json")),
			(error: NodeJS.ErrnoException) => error.code === "ENOENT");
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

	it("charges cache seeding to the shared deadline before build and never publishes a descriptor", async () => {
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
			repositoryLock: { lockfileVersion: 3, packages: {} },
			resolveNpm: () => ({ command: "node", argsPrefix: ["npm-cli.js"] }),
			ensureDist: ({ timeoutMs } = { timeoutMs: 0, fixtureRoot: "", commands: [] }) => {
				observedBuildTimeout = timeoutMs;
			},
			runCommand: async (command, args) => ({ command, args, code: 0, stdout: `${join(tmpdir(), "ambient-cache-read-only")}\n`, stderr: "" }),
		}), /retained partial fixture and command evidence/);

		assert.equal(observedBuildTimeout, undefined, `${FAILURE_PREFIX}: an expired seed must block build admission`);
		const fixtureRoot = join(runRoot, "prepared-packed-consumer");
		const evidence = JSON.parse(await readFile(join(fixtureRoot, "preparation-failure.json"), "utf8"));
		assert.match(evidence.error.message, /deadline exhausted before seed descriptor publication after 160ms \(limit 120ms\)/);
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
			repositoryLock: { lockfileVersion: 3, packages: {} },
			resolveNpm: () => ({ command: "node", argsPrefix: ["npm-cli.js"] }),
			ensureDist: () => {
				throw new packedConsumerModule.OwnedCommandError("build tree remained live", {
					command: "node",
					args: ["npm-cli.js", "run", "build"],
					cwd: REPO_ROOT,
					shutdown,
				});
			},
			runCommand: async (command, args) => {
				if (args.includes("config")) return { command, args, code: 0, stdout: `${join(tmpdir(), "ambient-cache-read-only")}\n`, stderr: "" };
				throw new Error("package commands must not start after incomplete build shutdown");
			},
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
