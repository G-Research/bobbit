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
import { PassThrough, Writable } from "node:stream";
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
const CACHE_PATH_HELPER_SOURCE = readFileSync(
	new URL("../../../scripts/testing-v2/resolve-packed-consumer-cache-paths.mjs", import.meta.url),
	"utf8",
);
const CACHE_COPY_HELPER_SOURCE = readFileSync(
	new URL("../../../scripts/testing-v2/copy-packed-consumer-cache-batch.mjs", import.meta.url),
	"utf8",
);
const WORKFLOW_SOURCE = readFileSync(
	new URL("../../../.github/workflows/build-unit-gate.yml", import.meta.url),
	"utf8",
);
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PACKAGE_MANIFEST = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { files: string[] };
const PACKAGE_LOCK = JSON.parse(readFileSync(join(REPO_ROOT, "package-lock.json"), "utf8")) as {
	packages?: Record<string, { name?: string; version?: string; gypfile?: boolean }>;
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
	totalTimeoutMs?: number;
	input?: string | Buffer;
	maxOutputBytes?: number;
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
		assert.match(source, /copyFile\(join\(repoRoot, "package-lock\.json"\), join\(resolverDir, "package-lock\.json"\)\)/,
			"the committed lock must seed npm's sole external lock update");
		assert.match(source, /"install",\s*"--package-lock-only",\s*"--offline",\s*"--ignore-scripts",\s*"--no-audit",\s*"--no-fund",\s*"--cache", cacheDir,\s*tarballPath/s);
		assert.match(CACHE_COPY_HELPER_SOURCE, /import cacache from "cacache"/,
			"the batch helper must use only cacache's public root export");
		assert.match(CACHE_COPY_HELPER_SOURCE, /cacache\.get\.info/,
			"the helper must use the public exact-key lookup API for ambient authority");
		assert.match(CACHE_COPY_HELPER_SOURCE, /copyFile\(source, destination, COPYFILE_EXCL\)/,
			"unsupported hardlinks must fall back to one direct exclusive physical copy");
		assert.doesNotMatch(`${source}\n${CACHE_PATH_HELPER_SOURCE}\n${CACHE_COPY_HELPER_SOURCE}`, /cacache\/lib\/|content-v\d*/,
			"cache layout must never depend on a private subpath or hand-coded content version");
		assert.match(CACHE_PATH_HELPER_SOURCE, /import cacache from "cacache"/,
			"the path helper must use only cacache's public root export");
		assert.match(CACHE_PATH_HELPER_SOURCE, /indexInsert\(destination, key, integrity\)/,
			"public index insertion must provide cacache's authoritative destination path");
		assert.match(CACHE_PATH_HELPER_SOURCE, /entry\.key !== key/,
			"the helper must bind every returned public entry to its requested key");
		assert.match(CACHE_PATH_HELPER_SOURCE, /entry\.integrity !== integrity/,
			"the helper must bind every returned public entry to its canonical requested integrity");
		assert.doesNotMatch(`${CACHE_PATH_HELPER_SOURCE}\n${CACHE_COPY_HELPER_SOURCE}`, /cacache\.put|cacache\.index\.(?:delete|remove)|cacache\.rm|createReadStream|createWriteStream|pipeline\(/,
			"helpers must neither mutate ambient cache state nor restore the stalled stream pipeline");
		assert.doesNotMatch(source, /cacache\.put\.stream/,
			"exact digest reuse must not pay for a second content publication");
		assert.doesNotMatch(source, /packed-consumer:\$\{artifact\.resolved\}/,
			"destination cache publication must not invent custom index keys");
		assert.doesNotMatch(source, /hasContent/,
			"uncancellable cache probes must not precede deadline-bound digest streams");
		assert.doesNotMatch(source, /cacache\.ls\(/, "ambient cache entries must never be enumerated wholesale");
		assert.match(source, /"cache", "add", "--cache", layout\.cacheDir, \.\.\.batches\[index\]/);
		assert.match(source, /const CACHE_WORKER_COUNT = 3;/,
			"cache population must retain the accepted bounded concurrency");
		assert.match(source, /runCommand\(process\.execPath, \[helperPath, fixtureRoot\]/,
			"all path resolution must run in one deadline-owned helper with independent root authority");
		assert.match(source, /helperEnv\[CACHE_COPY_AMBIENT_ENV\] = sourceContentCache;[\s\S]{0,500}runCommand\(process\.execPath, \[helperPath, fixtureRoot\]/,
			"direct publication must run in one tracked helper with independent destination and ambient authority");
		assert.match(source, /input,/,
			"the untrusted cache-path request must use deadline-owned stdin instead of parent filesystem transport");
		assert.match(source, /ownershipBootstrapRoot: fixtureRoot/,
			"the helper process must bootstrap ownership only inside the retained fixture root");
		assert.match(source, /await Promise\.allSettled\([\s\S]{0,200}CACHE_WORKER_COUNT/,
			"all admitted cache writers must settle before preparation advances");
		assert.match(source, /"ci",\s*"--offline",\s*"--ignore-scripts",\s*"--no-audit",\s*"--no-fund",\s*"--cache", cacheDir/s);
		assert.doesNotMatch(source, /"ci",[\s\S]{0,200}tarballPath/,
			"offline npm ci must materialize the generated lock without a second package operand");
		assert.match(source, /mode = "copy"/,
			"materialization must preserve copied consumers as the default contract");
		assert.match(source, /await copy\(validated\.templateDir, consumerDir/,
			"default materialization must copy the prepared installed dependency graph");
		assert.match(source, /if \(mode === "consume"\)[\s\S]{0,300}await move\(validated\.templateDir, consumerDir\)/,
			"one-shot materialization must atomically move rather than duplicate the installed tree");
		assert.match(source, /const OFFLINE_INSTALL_TIMEOUT_MS = 10 \* 60_000;/);
		assert.match(source, /export const PACKED_CONSUMER_PREPARATION_TIMEOUT_MS = 5 \* 60_000;/);
		assert.match(source, /\.\.\.commandDeadline\("offline npm ci", OFFLINE_INSTALL_TIMEOUT_MS\)/,
			"the former 600-second install budget must be capped by the preparation-wide deadline");
		assert.match(source, /totalTimeoutMs - Math\.max\(0, now\(\) - totalStartedAt\)/,
			"the owned-command lifetime must debit ownership readiness from its absolute budget");
		assert.match(source, /export const OWNERSHIP_ESTABLISHMENT_TIMEOUT_MS = 90_000;/);
		assert.match(source, /await Promise\.race\(\[\s*tracked\.ownershipReady,/s,
			"spawn-time ownership must retain its independent setup cap inside the total deadline");
		assert.match(source, /tracked\.killTree\("SIGKILL"\);/);
		assert.match(source, /await tracked\.waitForTreeExit\(treeExitTimeoutMs\)/);
		assert.match(source, /await rename\(temporaryDescriptor, descriptorPath\)/,
			"the descriptor must publish atomically after validation");
	});

	it("seeds npm's lock update and selectively transfers an exact ambient digest", async () => {
		const tempParent = mkdtempSync(join(tmpdir(), "bobbit-prewarm-pin-"));
		const ambientCache = join(tempParent, "ambient-cache");
		const calls: Array<{ args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }> = [];
		const order: string[] = [];
		const cacheHelperRequests: Array<{
			version: number;
			operation: "publish" | "verify";
			artifacts: Array<{ candidates?: string[]; integrity: string; destinationPath: string }>;
		}> = [];
		const cacheHelperResults: Array<{
			version: number;
			operation: "publish" | "verify";
			results: Array<{ integrity: string; status: string; candidate?: string | null }>;
			metrics: Record<string, number>;
			admitted: number;
			completed: number;
			maxActive: number;
		}> = [];
		let directDestinationPath = "";
		let nowMs = 0;
		const selectedAliasUrl = "https://registry.example.test/alias/-/alias-1.2.3.tgz";
		const selectedUrl = "https://registry.example.test/new-dependency/-/new-dependency-1.2.3.tgz";
		const selectedIntegrity = "sha512-fixture";
		const expectedDestinationPath = join(
			tempParent,
			"prepared-packed-consumer",
			"npm-cache",
			"_cacache",
			"resolved",
			encodeURIComponent(selectedIntegrity),
		);
		try {
			const descriptor = await preparePackedConsumerFixture({
				repoRoot: REPO_ROOT,
				runRoot: tempParent,
				repositoryLock: {
					lockfileVersion: 3,
					packages: {
						"": { name: "seed" },
						"node_modules/alias": { version: "1.2.3", resolved: selectedAliasUrl, integrity: selectedIntegrity },
						"node_modules/new-dependency": { version: "1.2.3", resolved: selectedUrl, integrity: selectedIntegrity },
					},
				},
				baseEnv: {
					PATH: process.env.PATH,
					npm_config_cache: ambientCache,
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
					if (args[0]?.endsWith("resolve-packed-consumer-cache-paths.mjs")) {
						const request = JSON.parse(String(options.input)) as {
							fixtureRoot: string;
							destination: string;
							integrities: string[];
						};
						assert.equal(args[1], request.fixtureRoot,
							"cache helper argv must carry authority independently of stdin data");
						order.push("paths");
						return commandResult(command, args, { stdout: `${JSON.stringify(request.integrities.map(integrity => ({
							integrity,
							path: join(request.destination, "resolved", encodeURIComponent(integrity)),
						})))}\n` });
					}
					if (args[0]?.endsWith("copy-packed-consumer-cache-batch.mjs")) {
						const request = JSON.parse(String(options.input)) as {
							version: number;
							operation: "publish" | "verify";
							artifacts: Array<{ candidates?: string[]; integrity: string; destinationPath: string }>;
						};
						cacheHelperRequests.push(request);
						assert.equal(request.version, 4);
						assert.equal(args[1], join(tempParent, "prepared-packed-consumer"));
						assert.equal(args.length, 2);
						assert.deepEqual(request.artifacts.map(({ integrity, destinationPath }) => ({ integrity, destinationPath })), [{
							integrity: selectedIntegrity,
							destinationPath: expectedDestinationPath,
						}], "every helper phase must use the path resolved for the canonical destination digest");

						let response: (typeof cacheHelperResults)[number];
						if (request.operation === "publish") {
							assert.deepEqual(request.artifacts[0]?.candidates, [selectedAliasUrl, selectedUrl],
								"protocol-v4 publication must group and code-unit-sort every URL for the selected digest");
							directDestinationPath = request.artifacts[0]!.destinationPath;
							mkdirSync(dirname(directDestinationPath), { recursive: true });
							writeFileSync(directDestinationPath, "copied ambient bytes", { flag: "wx" });
							order.push("publish");
							response = {
								version: 4,
								operation: "publish",
								results: [{ integrity: selectedIntegrity, status: "copied", candidate: selectedUrl }],
								metrics: { linked: 0, copied: 1, missing: 0, corrupt: 0 },
								admitted: 1,
								completed: 1,
								maxActive: 1,
							};
						} else {
							assert.deepEqual(request.artifacts[0]?.candidates, undefined,
								"protocol-v4 verification must carry only digest and canonical destination authority");
							assert.equal(readFileSync(expectedDestinationPath, "utf8"), "copied ambient bytes");
							order.push("verify");
							response = {
								version: 4,
								operation: "verify",
								results: [{ integrity: selectedIntegrity, status: "verified" }],
								metrics: { verified: 1, missing: 0, corrupt: 0 },
								admitted: 1,
								completed: 1,
								maxActive: 1,
							};
						}
						cacheHelperResults.push(response);
						return commandResult(command, args, { stdout: `${JSON.stringify(response)}\n` });
					}
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
						const seedLock = JSON.parse(readFileSync(join(options.cwd, "package-lock.json"), "utf8"));
						assert.equal(manifest.name, "bobbit-inline-theme-clean-consumer");
						assert.equal(manifest.private, true);
						assert.equal(seedLock.packages[""].name, PACKAGE_LOCK.packages?.[""]?.name,
							"the repository lock must exist before npm produces the external lock");
						assert.deepEqual(readdirSync(options.cwd), ["package-lock.json", "package.json"],
							"dependency resolution must begin from only the manifest and repository lock seed");
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
									integrity: selectedIntegrity,
								},
							},
						}));
						return commandResult(command, args);
					}
					if (args.includes("config") && args.includes("get") && args.includes("cache")) {
						order.push("discover");
						return commandResult(command, args, { stdout: `${ambientCache}\n` });
					}
					if (args.includes("ci") && args.includes("--offline")) {
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
					assert.fail(`unexpected package command: ${args.join(" ")}`);
				},
			});

			assert.deepEqual(order, [
				"discover", "paths", "publish", "verify", "ensure-dist", "pack", "resolve", "verify", "install",
			], "publication and both all-final verifications must complete before the offline install");
			assert.equal(calls.length, 8);
			assert.deepEqual(calls[0]?.args, ["npm-cli.js", "config", "get", "cache"]);
			assert.ok(calls[1]?.args[0]?.endsWith("resolve-packed-consumer-cache-paths.mjs"));
			for (const index of [2, 3, 6]) {
				assert.ok(calls[index]?.args[0]?.endsWith("copy-packed-consumer-cache-batch.mjs"),
					`command ${index} must be a tracked buffered cache helper`);
			}
			assert.deepEqual(cacheHelperRequests.map(request => request.operation), ["publish", "verify", "verify"],
				"seed and finalization must each perform their required tracked all-final verification");
			assert.deepEqual(cacheHelperResults, [
				{
					version: 4,
					operation: "publish",
					results: [{ integrity: selectedIntegrity, status: "copied", candidate: selectedUrl }],
					metrics: { linked: 0, copied: 1, missing: 0, corrupt: 0 },
					admitted: 1,
					completed: 1,
					maxActive: 1,
				},
				...Array.from({ length: 2 }, () => ({
					version: 4,
					operation: "verify" as const,
					results: [{ integrity: selectedIntegrity, status: "verified" }],
					metrics: { verified: 1, missing: 0, corrupt: 0 },
					admitted: 1,
					completed: 1,
					maxActive: 1,
				})),
			]);
			assert.deepEqual(calls[4]?.args.slice(1), [
				"pack", "--ignore-scripts", "--json", "--pack-destination", calls[4]?.args.at(-1),
			]);
			assert.deepEqual(calls[5]?.args.slice(1, 7), [
				"install", "--package-lock-only", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
			]);
			assert.equal(dirname(calls[5]!.args.at(-1)!), calls[4]!.args.at(-1));
			assert.equal(calls[7]?.args[1], "ci");
			assert.ok(calls[7]?.args.includes("--offline"));
			assert.ok(!calls[7]?.args.includes(calls[5]!.args.at(-1)!),
				"offline npm ci must not trigger a second lock-free packed-artifact solve");
			assert.equal(calls[0]?.timeoutMs, 30_000);
			assert.equal(calls[1]?.timeoutMs, PACKED_CONSUMER_PREPARATION_TIMEOUT_MS - 5_000);
			assert.equal(calls[2]?.timeoutMs, PACKED_CONSUMER_PREPARATION_TIMEOUT_MS - 10_000);
			assert.equal(calls[3]?.timeoutMs, PACKED_CONSUMER_PREPARATION_TIMEOUT_MS - 15_000);
			assert.equal(calls[4]?.timeoutMs, 3 * 60_000);
			assert.equal(calls[5]?.timeoutMs, PACKED_CONSUMER_PREPARATION_TIMEOUT_MS - 25_000);
			assert.equal(calls[6]?.timeoutMs, PACKED_CONSUMER_PREPARATION_TIMEOUT_MS - 30_000);
			assert.equal(calls[7]?.timeoutMs, PACKED_CONSUMER_PREPARATION_TIMEOUT_MS - 35_000,
				"late commands must receive only the original monotonic preparation deadline remainder");
			assert.equal(directDestinationPath, expectedDestinationPath,
				"the exact selected ambient digest must publish directly to its canonical isolated-cache path");
			assert.equal(readFileSync(directDestinationPath, "utf8"), "copied ambient bytes");
			assert.equal(existsSync(join(tempParent, "prepared-packed-consumer", "cache-copy-staging")), false);
			assert.doesNotMatch(directDestinationPath, new RegExp(selectedUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			const inherited: Record<string, string> = {
				npm_config_cache: ambientCache,
				npm_config_registry: "https://registry.example.test/",
				npm_config_userconfig: "inherited-userconfig",
				NODE_AUTH_TOKEN: "inherited-auth",
			};
			for (const call of [calls[5]!, calls[7]!]) {
				for (const [key, value] of Object.entries(inherited).filter(([key]) => key !== "npm_config_cache")) assert.equal(call.env[key], value);
				assert.notEqual(call.env.npm_config_cache, inherited.npm_config_cache);
				assert.ok(call.env.npm_config_cache?.startsWith(tempParent));
				assert.equal(call.env.npm_config_package_lock, undefined);
				assert.equal(call.env.npm_lifecycle_event, undefined);
				assert.equal(call.env.npm_package_name, undefined);
				assert.equal(call.env.INIT_CWD, call.cwd);
			}
			assert.equal(calls[0]?.env.npm_config_cache, ambientCache,
				"cache discovery may inspect but must not mutate or pass ambient state to consumer commands");
			const publishedEvidence = JSON.stringify(descriptor.commands);
			assert.doesNotMatch(publishedEvidence, /inherited-auth|inherited-userconfig/,
				"published command diagnostics must not serialize credential-bearing environment values");
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
			expectedCommands: 2,
			expectedLastCode: 0,
		},
		{
			label: "lock resolution failure",
			pack: { stdout: JSON.stringify([{ name: "@gresearch/bobbit", filename: "bobbit-1.0.0.tgz" }]) },
			expected: /exited 17/,
			expectedCommands: 3,
			expectedLastCode: 17,
		},
	])("propagates $label and retains partial fixture command evidence", async ({ pack, expected, expectedCommands, expectedLastCode }) => {
		const tempParent = mkdtempSync(join(tmpdir(), "bobbit-prewarm-failure-pin-"));
		try {
			await assert.rejects(preparePackedConsumerFixture({
				repoRoot: REPO_ROOT,
				runRoot: tempParent,
				repositoryLock: { lockfileVersion: 3, packages: {} },
				ensureDist: () => {},
				resolveNpm: () => ({ command: "node", argsPrefix: ["npm-cli.js"] }),
				runCommand: async (command: string, args: string[]) => {
					if (args.includes("config")) return commandResult(command, args, { stdout: `${join(tempParent, "ambient-cache")}\n` });
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

	it("settles at the total deadline when pre-handle setup never returns", async () => {
		const tempParent = mkdtempSync(join(tmpdir(), "bobbit-prewarm-prehandle-deadline-pin-"));
		const factoryEntered = deferred<void>();
		const factoryAborted = deferred<void>();
		const neverSettles = new Promise<never>(() => {});
		let fireTotalDeadline: (() => void) | undefined;
		let spawnCount = 0;
		try {
			const preparing = preparePackedConsumerFixture({
				repoRoot: REPO_ROOT,
				runRoot: tempParent,
				preparationTimeoutMs: 50,
				now: () => 0,
				ensureDist: () => {},
				resolveNpm: () => ({ command: "node", argsPrefix: ["npm-cli.js"] }),
				runCommand: (command: string, args: string[], options: RunCommandOptions) => runOwnedCommand(command, args, {
					cwd: options.cwd,
					env: options.env,
					timeoutMs: options.timeoutMs,
					totalTimeoutMs: options.totalTimeoutMs,
					now: () => 0,
					spawnOwned: async (_ownedCommand: string, _ownedArgs: string[], spawnOptions: { signal: AbortSignal }) => {
						factoryEntered.resolve(undefined);
						spawnOptions.signal.addEventListener("abort", () => factoryAborted.resolve(undefined), { once: true });
						await neverSettles;
						spawnOptions.signal.throwIfAborted();
						spawnCount++;
						throw new Error("a child must not be created after the deadline");
					},
					setTimer: (callback: () => void, timeoutMs: number) => {
						if (timeoutMs === 50) fireTotalDeadline = callback;
						return Symbol(`timer-${timeoutMs}`);
					},
					clearTimer: () => {},
				}),
			});

			await factoryEntered.promise;
			invokeTimer(fireTotalDeadline, "the total deadline must arm before the spawn factory returns");
			await factoryAborted.promise;
			await assert.rejects(preparing, (error: Error) => {
				assert.match(error.message, /retained partial fixture and command evidence/);
				assert.match(error.message, /50ms total deadline/);
				return true;
			});

			assert.equal(spawnCount, 0, "the detached factory must receive abort before its final spawn boundary");
			const fixtureRoot = join(tempParent, "prepared-packed-consumer");
			const evidence = JSON.parse(readFileSync(join(fixtureRoot, "preparation-failure.json"), "utf8"));
			assert.deepEqual(evidence.error.shutdown, {
				ownershipState: "not spawned before deadline",
				killRequested: false,
				rootCloseObserved: false,
				rootExitCode: null,
				rootSignal: null,
				treeExitAttempted: false,
				treeExitSettled: false,
				treeExitVerified: false,
				completionTimedOut: false,
			});
			assert.equal(existsSync(join(fixtureRoot, "descriptor.json")), false,
				"a pre-handle deadline failure must not publish a descriptor");
		} finally {
			rmSync(tempParent, { recursive: true, force: true });
		}
	});

	it("terminates and proves an exposed tree while the spawn factory never returns", async () => {
		const tempParent = mkdtempSync(join(tmpdir(), "bobbit-prewarm-exposed-deadline-pin-"));
		const handleExposed = deferred<void>();
		const neverSettles = new Promise<never>(() => {});
		const child = Object.assign(new EventEmitter(), {
			pid: 4343,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		let fireTotalDeadline: (() => void) | undefined;
		let killCount = 0;
		let completionJoins = 0;
		try {
			const preparing = preparePackedConsumerFixture({
				repoRoot: REPO_ROOT,
				runRoot: tempParent,
				preparationTimeoutMs: 50,
				now: () => 0,
				ensureDist: () => {},
				resolveNpm: () => ({ command: "node", argsPrefix: ["npm-cli.js"] }),
				runCommand: (command: string, args: string[], options: RunCommandOptions) => runOwnedCommand(command, args, {
					cwd: options.cwd,
					env: options.env,
					timeoutMs: options.timeoutMs,
					totalTimeoutMs: options.totalTimeoutMs,
					now: () => 0,
					spawnOwned: async (_ownedCommand: string, _ownedArgs: string[], spawnOptions: { onSpawned: (tracked: unknown) => void }) => {
						const tracked = {
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
						};
						spawnOptions.onSpawned(tracked);
						handleExposed.resolve(undefined);
						return neverSettles;
					},
					setTimer: (callback: () => void, timeoutMs: number) => {
						if (timeoutMs === 50) fireTotalDeadline = callback;
						return Symbol(`timer-${timeoutMs}`);
					},
					clearTimer: () => {},
				}),
			});

			await handleExposed.promise;
			child.stdout.write("output observed at handle exposure");
			child.stderr.write("error output observed at handle exposure");
			invokeTimer(fireTotalDeadline, "the total deadline must remain active while the exposed factory is delayed");
			assert.equal(killCount, 1, "deadline expiry must terminate the exposed tree immediately and exactly once");
			await assert.rejects(preparing, /retained partial fixture and command evidence/);

			assert.equal(killCount, 1, "bounded completion must not request a second tree termination");
			assert.equal(completionJoins, 1, "failure must await the exposed tree's bounded completion proof");
			const fixtureRoot = join(tempParent, "prepared-packed-consumer");
			const evidence = JSON.parse(readFileSync(join(fixtureRoot, "preparation-failure.json"), "utf8"));
			assert.equal(isCompleteOwnedCommandShutdown(evidence.error.shutdown), true);
			assert.match(evidence.error.message, /output observed at handle exposure/);
			assert.match(evidence.error.message, /error output observed at handle exposure/);
			assert.equal(existsSync(join(fixtureRoot, "descriptor.json")), false,
				"an exposed-tree deadline failure must not publish a descriptor");
		} finally {
			rmSync(tempParent, { recursive: true, force: true });
		}
	});

	it("caps ownership readiness by the remaining preparation deadline, joins its tree, and retains evidence", async () => {
		const tempParent = mkdtempSync(join(tmpdir(), "bobbit-prewarm-deadline-pin-"));
		const child = Object.assign(new EventEmitter(), {
			pid: 4242,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		const ownership = deferred<void>();
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
						totalTimeoutMs: options.totalTimeoutMs,
						now: () => 0,
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
				assert.match(error.message, /50ms total deadline \(including ownership readiness\)/);
				return true;
			});

			assert.equal(observedTimeoutMs, 50, "cache seeding receives the original preparation deadline before finalization");
			assert.equal(killCount, 1, "deadline expiry terminates the one owned process tree");
			assert.equal(completionJoins, 1, "preparation does not reject until complete tree exit is verified");
			const fixtureRoot = join(tempParent, "prepared-packed-consumer");
			const evidence = JSON.parse(readFileSync(join(fixtureRoot, "preparation-failure.json"), "utf8"));
			assert.match(evidence.error.message, /50ms total deadline \(including ownership readiness\)/);
			assert.match(evidence.error.message, /tree exit: verified complete/);
			assert.deepEqual(evidence.error.shutdown, {
				ownershipState: "termination requested before readiness",
				killRequested: true,
				rootCloseObserved: true,
				rootExitCode: null,
				rootSignal: "SIGKILL",
				treeExitAttempted: true,
				treeExitSettled: true,
				treeExitVerified: true,
				completionTimedOut: false,
			});
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

	it("joins blocked stdin transport under the immutable total deadline and kills once", async () => {
		const stdin = new Writable({ write() { /* deliberately block drain */ } });
		const child = Object.assign(new EventEmitter(), {
			pid: 7070,
			stdin,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		let fireTotalDeadline: (() => void) | undefined;
		let killCount = 0;
		let joins = 0;
		const running = runOwnedCommand("node", ["helper.mjs", "fixture-root"], {
			cwd: REPO_ROOT,
			timeoutMs: 100,
			totalTimeoutMs: 100,
			now: () => 0,
			input: JSON.stringify({ bounded: true }),
			spawnOwned: async () => ({
				child,
				ownershipReady: Promise.resolve(),
				killTree: () => {
					killCount++;
					child.stdout.end();
					child.stderr.end();
					child.emit("close", null, "SIGKILL");
				},
				waitForTreeExit: async () => { joins++; return true; },
			}),
			setTimer: (callback: () => void, timeoutMs: number) => {
				if (timeoutMs === 100) fireTotalDeadline = callback;
				return Symbol(`timer-${timeoutMs}`);
			},
			clearTimer: () => {},
		});
		await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate));
		invokeTimer(fireTotalDeadline, "total deadline must remain armed while stdin is blocked");
		await assert.rejects(running, /100ms total deadline/);
		assert.equal(stdin.destroyed, true, "timeout must destroy the blocked request transport");
		assert.equal(killCount, 1);
		assert.equal(joins, 1);
	});

	it("treats stdin errors as terminal and waits for response streams plus verified tree exit", async () => {
		const stdin = new Writable({
			write(_chunk, _encoding, callback) { callback(new Error("injected stdin failure")); },
		});
		const child = Object.assign(new EventEmitter(), {
			pid: 7171,
			stdin,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		let killCount = 0;
		let joins = 0;
		const running = runOwnedCommand("node", ["helper.mjs", "fixture-root"], {
			cwd: REPO_ROOT,
			timeoutMs: 1_000,
			input: "{}\n",
			spawnOwned: async () => ({
				child,
				ownershipReady: Promise.resolve(),
				killTree: () => {
					killCount++;
					queueMicrotask(() => {
						child.stdout.end();
						child.stderr.end();
						child.emit("close", null, "SIGKILL");
					});
				},
				waitForTreeExit: async () => { joins++; return true; },
			}),
		});
		await assert.rejects(running, /stdin transport failed/);
		assert.equal(killCount, 1);
		assert.equal(joins, 1);
		assert.equal(child.stdout.destroyed, true);
		assert.equal(child.stderr.destroyed, true);
	});

	it("uses the immutable total deadline to close and join an open response transport", async () => {
		const child = Object.assign(new EventEmitter(), {
			pid: 7272,
			stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		let fireTotalDeadline: (() => void) | undefined;
		let killCount = 0;
		let treeExitJoins = 0;
		const running = runOwnedCommand("node", ["helper.mjs", "fixture-root"], {
			cwd: REPO_ROOT,
			timeoutMs: 1_000,
			totalTimeoutMs: 29,
			treeExitTimeoutMs: 31,
			input: "{}\n",
			now: () => 0,
			spawnOwned: async () => ({
				child,
				ownershipReady: Promise.resolve(),
				killTree: () => {
					killCount++;
					assert.equal(child.stdout.destroyed, true,
						"failure admission must destroy stdout before requesting tree termination");
					assert.equal(child.stderr.destroyed, true,
						"failure admission must destroy stderr before requesting tree termination");
					queueMicrotask(() => child.emit("close", null, "SIGKILL"));
				},
				waitForTreeExit: async () => { treeExitJoins++; return true; },
			}),
			setTimer: (callback: () => void, timeoutMs: number) => {
				if (timeoutMs === 29) fireTotalDeadline = callback;
				return Symbol(`timer-${timeoutMs}`);
			},
			clearTimer: () => {},
		});
		await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate));
		child.stdout.write("response before deadline");
		invokeTimer(fireTotalDeadline, "open stdout must remain governed by the immutable total deadline");
		await assert.rejects(running, (error: unknown) => {
			if (!(error instanceof OwnedCommandError)) return false;
			const owned = error as Error & { shutdown: Record<string, unknown> };
			assert.match(owned.message, /29ms total deadline/);
			assert.equal(owned.shutdown.rootCloseObserved, true);
			assert.equal(owned.shutdown.treeExitVerified, true);
			return true;
		});
		assert.equal(killCount, 1);
		assert.equal(treeExitJoins, 1);
		assert.equal(child.stdout.destroyed, true);
		assert.equal(child.stderr.destroyed, true);
	});

	it("keeps an error-before-close command pending until the actual close event", async () => {
		const child = Object.assign(new EventEmitter(), {
			pid: 7373,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		let killCount = 0;
		let settled = false;
		const running = runOwnedCommand("node", ["npm-cli.js", "pack"], {
			cwd: REPO_ROOT,
			timeoutMs: 1_000,
			spawnOwned: async () => ({
				child,
				ownershipReady: Promise.resolve(),
				killTree: () => { killCount++; },
				waitForTreeExit: async () => true,
			}),
		});
		const observed = running.then(
			(value: unknown) => { settled = true; return { value }; },
			(error: unknown) => { settled = true; return { error }; },
		);
		await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate));
		child.emit("error", new Error("injected process error"));
		await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate));
		assert.equal(killCount, 1);
		assert.equal(settled, false,
			"an error event must not synthesize root close or release command completion");
		assert.equal(child.listenerCount("close"), 1,
			"the real close listener must remain admitted after an error event");
		assert.equal(child.stdout.destroyed, true);
		assert.equal(child.stderr.destroyed, true);

		child.emit("close", null, "SIGKILL");
		const result = await observed;
		assert.ok("error" in result);
		assert.ok(result.error instanceof OwnedCommandError);
		assert.match(String(result.error), /injected process error/);
		assert.equal((result.error as { shutdown: Record<string, unknown> }).shutdown.rootCloseObserved, true);
		assert.equal(child.listenerCount("error"), 0);
		assert.equal(child.listenerCount("close"), 0);
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

	it("keeps one absolute total deadline while ownership consumes most of the budget", async () => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		const ownership = deferred<void>();
		let nowMs = 0;
		let fireTotalDeadline: (() => void) | undefined;
		let killCount = 0;
		let completionJoins = 0;
		const timerDurations: number[] = [];
		const running = runOwnedCommand("node", ["npm-cli.js", "install"], {
			cwd: REPO_ROOT,
			timeoutMs: 100,
			totalTimeoutMs: 100,
			ownershipEstablishmentTimeoutMs: 1_000,
			now: () => nowMs,
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
				timerDurations.push(timeoutMs);
				if (timeoutMs === 100) fireTotalDeadline = callback;
				return Symbol(`timer-${timeoutMs}`);
			},
			clearTimer: () => {},
		});

		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(timerDurations, [100],
			"a setup cap beyond the remaining budget must not compete with the absolute deadline");
		nowMs = 80;
		ownership.resolve(undefined);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(timerDurations, [100],
			"ownership readiness must not restart a full execution budget; only the original 20ms remainder remains");
		nowMs = 100;
		invokeTimer(fireTotalDeadline, "the original total deadline must stay armed across ownership readiness");

		await assert.rejects(running, (error: unknown) => {
			if (!(error instanceof OwnedCommandError)) return false;
			const owned = error as Error & { shutdown: Record<string, unknown> };
			assert.match(owned.message, /100ms total deadline \(including ownership readiness\)/);
			assert.equal(isCompleteOwnedCommandShutdown(owned.shutdown), true,
				"deadline failure must still carry complete owned-tree shutdown proof");
			return true;
		});
		assert.equal(killCount, 1);
		assert.equal(completionJoins, 1);
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
			assert.equal(child.listenerCount("error"), 1,
				"late child errors must remain observed until every completion barrier settles");
			assert.equal(child.listenerCount("close"), 0);
			assert.equal(child.stdout.listenerCount("data"), 0);
			assert.equal(child.stderr.listenerCount("data"), 0);

			treeExit.resolve(true);
			const result = await observed;
			assert.equal(child.listenerCount("error"), 0,
				"the late-error observer must be removed once command settlement is terminal");
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

	it("returns normal success only after close, transports, and verified tree completion", async () => {
		const stdin = new PassThrough();
		const child = Object.assign(new EventEmitter(), {
			stdin,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		const treeExit = deferred<boolean>();
		let completionJoins = 0;
		let fireTotalDeadline: (() => void) | undefined;
		let settled = false;
		const clearedTimers: symbol[] = [];
		const totalTimerToken = Symbol("total-timer");
		const running = runOwnedCommand("node", ["npm-cli.js", "pack"], {
			cwd: REPO_ROOT,
			timeoutMs: 1_000,
			totalTimeoutMs: 100,
			now: () => 0,
			spawnOwned: async () => ({
				child,
				ownershipReady: Promise.resolve(),
				killTree: () => { throw new Error("normal close must not request a kill"); },
				waitForTreeExit: async () => {
					completionJoins++;
					return treeExit.promise;
				},
			}),
			setTimer: (callback: () => void, timeoutMs: number) => {
				if (timeoutMs === 100) {
					fireTotalDeadline = callback;
					return totalTimerToken;
				}
				return Symbol(`timer-${timeoutMs}`);
			},
			clearTimer: (timer: symbol) => { clearedTimers.push(timer); },
		});
		const observed = running.finally(() => { settled = true; });
		await Promise.resolve();
		child.stdout.write("pack json");
		child.emit("close", 0, null);
		await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate));
		assert.equal(settled, false, "root close alone must not admit success");
		assert.equal(clearedTimers.includes(totalTimerToken), false,
			"the immutable total timer must remain armed while response transport is open");
		assert.ok(fireTotalDeadline, "normal success must remain governed by the total deadline until fully joined");
		child.stdout.end();
		child.stderr.end();
		await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate));
		assert.equal(settled, false, "transport settlement must still wait for tree-exit proof");
		treeExit.resolve(true);
		const result = await observed;
		assert.equal(result.code, 0);
		assert.equal(result.stdout, "pack json");
		assert.equal(completionJoins, 1, "normal success must join verified tree completion");
		assert.equal(clearedTimers.includes(totalTimerToken), true,
			"the total timer may clear only after the whole success barrier settles");
		assert.equal(stdin.destroyed, false, "a no-input npm command must leave ignored stdin untouched");
		assert.equal(stdin.writableEnded, false);
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
		child.stdout.end();
		child.stderr.end();
		child.emit("close", 0, null);
		await assert.rejects(running, /closed without verified process-tree completion/);
	});

	it("hands the actual packed tarball and strict-offline install evidence to the browser", () => {
		const packedConsumer = PACKED_CONSUMER_SOURCE;
		assert.match(packedConsumer, /const descriptorPath = resolvePackedConsumerDescriptorPath\(process\.env, coordinatorRunRoot!\)/,
			"the browser journey must resolve the canonical coordinator-owned descriptor path");
		assert.match(packedConsumer, /readPreparedPackedConsumerDescriptor\(descriptorPath, coordinatorRunRoot!\)/,
			"the browser journey must bind the canonical descriptor to the authoritative coordinator root");
		assert.match(packedConsumer, /const repeatedProject = testInfo\.project\.repeatEach > 1/,
			"repeat-each projects must avoid racing to consume one prepared tree");
		assert.match(packedConsumer, /name: `inline-theme-\$\{testInfo\.workerIndex\}-\$\{testInfo\.repeatEachIndex\}`/,
			"repeat materializations must include the repeat index in their unique name");
		assert.match(packedConsumer, /materializePackedConsumerFixture\(descriptor, \{\s*coordinatorRunRoot: coordinatorRunRoot![\s\S]{0,250}mode: repeatedProject \? "copy" : "consume"/,
			"ordinary runs must consume once while every potentially overlapping repeat receives a copy");
		assert.match(packedConsumer, /const tarballPath = resolve\(descriptor\.tarballPath\)/,
			"the browser must validate npm pack's actual emitted tarball");
		assert.match(packedConsumer, /packed tarball must be owned by the authoritative coordinator root/,
			"the packed tarball must remain bound to the coordinator root");
		assert.match(packedConsumer, /executed packed CLI must be owned by the authoritative coordinator root/,
			"the executed CLI must come from the coordinator-owned consumed tree");
		assert.match(packedConsumer, /command\.args\.includes\("ci"\) && command\.args\.includes\("--offline"\)/,
			"the browser must verify strict-offline npm ci evidence");
		assert.match(packedConsumer, /\["--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--cache"\]/,
			"deterministic npm ci flags must remain asserted");
		assert.match(packedConsumer, /prepared npm ci must use the descriptor's isolated cache/,
			"the browser must bind npm ci to the prepared fixture's isolated cache");
		assert.match(packedConsumer, /offline npm ci must not receive a package operand/,
			"the browser must reject a second packed-artifact operand during lock-driven npm ci");
		assert.match(packedConsumer, /installedPackages\[`node_modules\/\$\{PACKAGE_NAME\}`\]\?\.resolved/,
			"the consumed consumer lock must prove the installed package resolves from the packed artifact");
		assert.match(packedConsumer, /consumer lock \$\{label\} must resolve to the actual packed tarball/,
			"the browser must bind the consumed lock reference to the coordinator's actual tarball");
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
		assert.match(PREWARM_SOURCE, /resolverDir: join\(preparationDir, "resolver"\),\s*templateDir: join\(preparationDir, "template"\),/s,
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
