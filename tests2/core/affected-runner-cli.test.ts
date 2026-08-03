import {
	appendFileSync,
	copyFileSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import {
	createRunChild,
	createRunChildEnvironment,
	removeOwnedRunChild,
} from "../harness/run-isolation.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ownedRoots: string[] = [];

type Fixture = {
	root: string;
	env: NodeJS.ProcessEnv;
	base: string;
	logFile: string;
};

type RunnerResult = {
	status: number | null;
	stderr: string;
	json: any;
};

const MOCK_GRAPH = String.raw`
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vitestConfigRepoSourceFiles } from "../testing-v2/repo-source-closure.mjs";
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tests = ["tests2/core/a.test.ts", "tests2/core/b.test.ts"];
export function buildGraph() {
  const vitestConfigFiles = vitestConfigRepoSourceFiles(REPO_ROOT)
    .map(file => relative(REPO_ROOT, file).replace(/\\/g, "/"));
  return {
    testFiles: tests,
    testDeps: new Map([
      [tests[0], new Set([tests[0], "src/a.ts", "src/common.ts", "defaults/roles/coder.yaml"])],
      [tests[1], new Set([tests[1], "src/b.ts", "src/common.ts"])],
    ]),
    meta: { vitestConfigFiles },
  };
}
export function affectedTests(graph, changes) {
  const paths = changes.flatMap(change => [change.path, change.oldPath].filter(Boolean));
  const configFiles = new Set(graph.meta.vitestConfigFiles);
  const broad = paths.find(file => file === "unknown.bin" || file === "vitest.config.ts"
    || file === "package-lock.json" || /^tsconfig(?:\..+)?\.json$/.test(file)
    || file.startsWith("scripts/affected/")
    || (file !== "scripts/testing-v2/test-map-execution.mjs" && configFiles.has(file)));
  if (broad) return {
    kind: "run-all", cachePolicy: "bypass", affected: new Set(graph.testFiles),
    browserAffected: new Set(), reasons: ["broad change: " + broad], unmapped: [],
  };
  const affected = new Set();
  if (paths.includes("src/a.ts") || paths.includes("defaults/roles/coder.yaml") || paths.includes("semantic.json")) affected.add(tests[0]);
  if (paths.includes("src/b.ts")) affected.add(tests[1]);
  if (paths.includes("src/common.ts")) for (const test of tests) affected.add(test);
  for (const test of tests) if (paths.includes(test)) affected.add(test);
  const semantic = changes.find(change => change.path === "semantic.json" || change.oldPath === "semantic.json");
  const reasons = semantic
    ? ["semantic:" + String(semantic.before).trim() + "->" + String(semantic.after).trim()]
    : ["static dependency closure"];
  if (affected.size === 0) return {
    kind: "skip-all", cachePolicy: "eligible", affected, browserAffected: new Set(),
    reasons: [paths.every(file => file.startsWith("docs/")) ? "docs only" : "no unit consumers"], unmapped: [],
  };
  return { kind: "bounded", cachePolicy: "eligible", affected, browserAffected: new Set(), reasons, unmapped: [] };
}
`;

const FAKE_VITEST = String.raw`
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--outputFile");
const outputFile = args[outputIndex + 1];
const files = args.filter(value => value.endsWith(".test.ts"));
mkdirSync(dirname(process.env.AFFECTED_FIXTURE_LOG), { recursive: true });
appendFileSync(process.env.AFFECTED_FIXTURE_LOG, JSON.stringify(files) + "\n");
if (process.env.FAKE_MUTATE_PATH) {
  appendFileSync(resolve(process.env.FAKE_MUTATE_PATH), "\n// mutated during fake Vitest execution\n");
}
const failures = new Set((process.env.FAKE_FAIL || "").split(",").filter(Boolean));
const results = files.map(file => ({
  name: resolve(file),
  status: failures.has(file) ? "failed" : "passed",
}));
if (process.env.FAKE_NO_REPORT !== "1") {
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, JSON.stringify({ testResults: results }));
}
process.exit(results.some(result => result.status === "failed") ? 1 : 0);
`;

// Keep the Vitest worker behind the tier-1 subprocess fence. A uniquely owned
// helper thread performs this end-to-end CLI fixture's bounded external command
// and returns an envelope even when the command intentionally exits nonzero.
const COMMAND_WRAPPER = String.raw`
import { spawnSync } from "node:child_process";
import { parentPort, workerData } from "node:worker_threads";
const result = spawnSync(workerData.file, workerData.args, {
  cwd: workerData.cwd, env: workerData.env, encoding: "utf8", windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
parentPort.postMessage({
  status: result.status,
  stdout: result.stdout || "",
  stderr: result.stderr || "",
  error: result.error?.message,
});
`;

function write(root: string, relativePath: string, content: string): void {
	const target = path.join(root, relativePath);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, content);
}

async function command(
	fixture: Pick<Fixture, "root" | "env">,
	file: string,
	args: string[],
	overrides: NodeJS.ProcessEnv = {},
): Promise<{ status: number | null; stdout: string; stderr: string; error?: string }> {
	return await new Promise((resolveCommand, reject) => {
		const worker = new Worker(path.join(fixture.root, "command-wrapper.mjs"), {
			workerData: {
				file,
				args,
				cwd: fixture.root,
				env: { ...fixture.env, ...overrides },
			},
		});
		const timeout = setTimeout(() => {
			void worker.terminate();
			reject(new Error(`fixture command timed out: ${file}`));
		}, 30_000);
		worker.once("message", (result) => {
			clearTimeout(timeout);
			resolveCommand(result);
		});
		worker.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
	});
}

async function git(fixture: Pick<Fixture, "root" | "env">, args: string[]): Promise<string> {
	const result = await command(fixture, "git", args);
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.error ?? result.stderr}`);
	return result.stdout.trim();
}

async function commit(fixture: Pick<Fixture, "root" | "env">, message: string): Promise<string> {
	await git(fixture, ["add", "--all"]);
	await git(fixture, [
		"-c", "user.name=Affected Fixture",
		"-c", "user.email=affected@example.invalid",
		"-c", "commit.gpgsign=false",
		"commit", "--quiet", "-m", message,
	]);
	return git(fixture, ["rev-parse", "HEAD"]);
}

async function makeFixture(): Promise<Fixture> {
	const root = createRunChild("affected-runner-cli");
	ownedRoots.push(root);
	const logFile = path.join(root, ".profiles", "fake-vitest.jsonl");
	const globalConfig = path.join(root, "empty-gitconfig");
	writeFileSync(globalConfig, "");
	const env = createRunChildEnvironment({
		AFFECTED_FIXTURE_LOG: logFile,
		GIT_CONFIG_GLOBAL: globalConfig,
		GIT_CONFIG_NOSYSTEM: "1",
	});

	mkdirSync(path.join(root, "scripts", "affected"), { recursive: true });
	copyFileSync(path.join(REPO_ROOT, "scripts", "affected", "run.mjs"), path.join(root, "scripts", "affected", "run.mjs"));
	copyFileSync(path.join(REPO_ROOT, "scripts", "affected", "cache.mjs"), path.join(root, "scripts", "affected", "cache.mjs"));
	write(root, "scripts/affected/graph.mjs", MOCK_GRAPH);
	write(root, "scripts/affected/impact-rules.mjs", "export const rules = [];\n");
	write(root, "scripts/affected/classification.mjs", "export const classifier = 'fixture';\n");
	write(root, "scripts/testing-v2/test-map-execution.mjs", "export const owner = 'unit';\n");
	copyFileSync(
		path.join(REPO_ROOT, "scripts", "testing-v2", "repo-source-closure.mjs"),
		path.join(root, "scripts", "testing-v2", "repo-source-closure.mjs"),
	);
	write(root, "node_modules/vitest/vitest.mjs", FAKE_VITEST);
	write(root, "command-wrapper.mjs", COMMAND_WRAPPER);
	write(root, "package.json", JSON.stringify({
		type: "module",
		scripts: { test: "fixture" },
		dependencies: { alpha: "1.0.0" },
		devDependencies: { vitest: "4.1.10" },
	}));
	write(root, "package-lock.json", "fixture-lock\n");
	write(root, "tsconfig.json", "{}\n");
	write(root, "vitest.config.ts", [
		'import "./scripts/testing-v2/test-map-execution.mjs";',
		'import "./tests2/harness/unit-file-budget-reporter.js";',
		'import "./tests2/harness/run-isolation.js";',
		"export default {};",
		"",
	].join("\n"));
	write(root, "tests2/harness/run-isolation.ts", 'import "../../scripts/testing-v2/environment-policy.mjs";\n');
	write(root, "tests2/harness/unit-file-budget-reporter.ts", "export default class UnitFileBudgetReporter {}\n");
	write(root, "scripts/testing-v2/environment-policy.mjs", "export const policy = true;\n");
	write(root, "tests2/tests-map.json", "{}\n");
	write(root, "tests2/core/a.test.ts", "export const a = 1;\n");
	write(root, "tests2/core/b.test.ts", "export const b = 1;\n");
	write(root, "src/a.ts", "export const a = 1;\n");
	write(root, "src/b.ts", "export const b = 1;\n");
	write(root, "src/common.ts", "export const common = 1;\n");
	write(root, "defaults/roles/coder.yaml", "name: coder\n");
	write(root, "semantic.json", "baseline-semantic-value\n");
	write(root, ".gitignore", ".profiles/\n");

	const fixture = { root, env, base: "", logFile };
	const initialized = await command(fixture, "git", ["init", "--quiet", "-b", "trunk"]);
	if (initialized.status !== 0) throw new Error(`git init failed: ${initialized.error ?? initialized.stderr}`);
	fixture.base = await commit(fixture, "initial fixture");
	return fixture;
}

async function run(fixture: Fixture, args: string[], overrides: NodeJS.ProcessEnv = {}): Promise<RunnerResult> {
	const result = await command(
		fixture,
		process.execPath,
		[path.join(fixture.root, "scripts", "affected", "run.mjs"), ...args, "--json"],
		overrides,
	);
	const stdout = result.stdout.trim();
	return {
		status: result.status,
		stderr: result.stderr,
		json: stdout ? JSON.parse(stdout) : undefined,
	};
}

function invocations(fixture: Fixture): string[][] {
	try {
		return readFileSync(fixture.logFile, "utf8").trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
	} catch {
		return [];
	}
}

afterEach(() => {
	while (ownedRoots.length) removeOwnedRunChild(ownedRoots.pop()!);
});

describe("affected runner CLI", () => {
	it("collects committed, staged, unstaged, untracked, and explicit change records", async () => {
		const fixture = await makeFixture();
		write(fixture.root, "semantic.json", "committed-semantic-value\n");
		await commit(fixture, "committed semantic change");

		const committed = await run(fixture, ["--base", fixture.base, "--dry", "--no-cache"]);
		expect(committed.status).toBe(0);
		expect(committed.json.changed).toEqual([{ path: "semantic.json", status: "M" }]);
		expect(committed.json.reasons[0]).toBe("semantic:baseline-semantic-value->committed-semantic-value");

		write(fixture.root, "semantic.json", "staged-semantic-value\n");
		await git(fixture, ["add", "semantic.json"]);
		write(fixture.root, "src/a.ts", "export const a = 2;\n");
		write(fixture.root, "docs/untracked.md", "fixture docs\n");
		const overlays = await run(fixture, ["--base", "HEAD", "--dry", "--no-cache"]);
		expect(overlays.status).toBe(0);
		expect(overlays.json.changed).toEqual(expect.arrayContaining([
			{ path: "semantic.json", status: "M" },
			{ path: "src/a.ts", status: "M" },
			{ path: "docs/untracked.md", status: "A" },
		]));
		expect(overlays.json.reasons[0]).toBe("semantic:committed-semantic-value->staged-semantic-value");
		expect(overlays.json.summary).toBe("BOUNDED selected=1, cache-hit=0, run=1");

		const docsOnly = await run(fixture, ["--changed", "docs/untracked.md", "--dry"]);
		expect(docsOnly.json.summary).toBe("SKIP-ALL reason=docs only, selected=0, run=0");

		const explicit = await run(fixture, ["--changed", "semantic.json", "--base", "HEAD", "--dry", "--no-cache"]);
		expect(explicit.status).toBe(0);
		expect(explicit.json.changed).toEqual([{ path: "semantic.json", status: "M" }]);
		expect(explicit.json.kind).toBe("bounded");
	});

	it("preserves rename/delete attribution and fails on an invalid explicit base", async () => {
		const fixture = await makeFixture();
		await git(fixture, ["mv", "semantic.json", "semantic-renamed.json"]);
		rmSync(path.join(fixture.root, "src", "a.ts"));
		const changed = await run(fixture, ["--base", "HEAD", "--dry", "--no-cache"]);
		expect(changed.status).toBe(0);
		expect(changed.json.changed).toEqual(expect.arrayContaining([
			{ path: "semantic-renamed.json", oldPath: "semantic.json", status: "R" },
			{ path: "src/a.ts", status: "D" },
		]));
		expect(changed.json.affected).toContain("tests2/core/a.test.ts");

		const invalid = await run(fixture, ["--base", "definitely-not-a-ref", "--dry"]);
		expect(invalid.status).toBe(2);
		expect(invalid.json).toMatchObject({ outcome: "error" });
		expect(invalid.json.error).toContain("merge-base");
	});

	it("bypasses warm cache for RUN-ALL and retains only fresh per-file PASS verdicts", async () => {
		const fixture = await makeFixture();
		const warm = await run(fixture, ["--all"]);
		expect(warm.status).toBe(0);
		expect(warm.json).toMatchObject({
			kind: "run-all",
			cachePolicy: "bypass",
			counts: { total: 2, selected: 2, cacheHit: 0, run: 2 },
		});

		const boundedHit = await run(fixture, ["--changed", "src/a.ts"]);
		expect(boundedHit.status).toBe(0);
		expect(boundedHit.json.outcome).toBe("cache-hit-all");
		expect(boundedHit.json.summary).toBe("CACHE-HIT-ALL selected=1, cache-hit=1, run=0");
		expect(invocations(fixture)).toHaveLength(1);

		write(fixture.root, "unknown.bin", "broad input\n");
		const broad = await run(fixture, ["--base", "HEAD"]);
		expect(broad.status).toBe(0);
		expect(broad.json.summary).toContain("RUN-ALL");
		expect(broad.json.counts).toMatchObject({ selected: 2, cacheHit: 0, run: 2 });
		expect(invocations(fixture)).toHaveLength(2);

		const mixed = await run(fixture, ["--base", "HEAD"], { FAKE_FAIL: "tests2/core/b.test.ts" });
		expect(mixed.status).toBe(1);
		expect(mixed.json.outcome).toBe("fail");
		const cache = JSON.parse(readFileSync(path.join(fixture.root, ".profiles", "test-cache", "results.json"), "utf8"));
		const bucket = Object.values(cache)[0] as Record<string, unknown>;
		expect(Object.keys(bucket)).toEqual(["tests2/core/a.test.ts"]);

		const passingSibling = await run(fixture, ["--changed", "src/a.ts"]);
		expect(passingSibling.json.outcome).toBe("cache-hit-all");
		const failedSibling = await run(fixture, ["--changed", "src/b.ts"]);
		expect(failedSibling.json.counts).toMatchObject({ selected: 1, cacheHit: 0, run: 1 });
		expect(invocations(fixture)).toHaveLength(4);

		const ambiguous = await run(fixture, ["--base", "HEAD"], {
			FAKE_FAIL: "tests2/core/b.test.ts",
			FAKE_NO_REPORT: "1",
		});
		expect(ambiguous.status).toBe(1);
		const rerunAfterAmbiguousFailure = await run(fixture, ["--changed", "src/a.ts"]);
		expect(rerunAfterAmbiguousFailure.json.counts).toMatchObject({ selected: 1, cacheHit: 0, run: 1 });
		expect(invocations(fixture)).toHaveLength(6);
	});

	it("bypasses warm cache for every transitive Vitest configuration input", async () => {
		const fixture = await makeFixture();
		const unitFiles = ["tests2/core/a.test.ts", "tests2/core/b.test.ts"];
		const warm = await run(fixture, ["--all"]);
		expect(warm.status).toBe(0);

		for (const [index, configInput] of [
			"tests2/harness/run-isolation.ts",
			"scripts/testing-v2/environment-policy.mjs",
			"tests2/harness/unit-file-budget-reporter.ts",
		].entries()) {
			const result = await run(fixture, ["--changed", configInput]);
			expect(result.status, configInput).toBe(0);
			expect(result.json, configInput).toMatchObject({
				kind: "run-all",
				cachePolicy: "bypass",
				cacheHits: [],
				toRun: unitFiles,
				counts: { total: 2, selected: 2, cacheHit: 0, run: 2 },
			});
			expect(invocations(fixture), configInput).toHaveLength(index + 2);
			expect(invocations(fixture).at(-1), configInput).toEqual(unitFiles);
		}

		const dynamicInput = "tests2/harness/dynamic-config-input.ts";
		write(fixture.root, dynamicInput, "export const dynamicConfigInput = true;\n");
		appendFileSync(
			path.join(fixture.root, "vitest.config.ts"),
			'\nimport "./tests2/harness/dynamic-config-input.js";\n',
		);
		const dynamic = await run(fixture, ["--changed", dynamicInput]);
		expect(dynamic.status).toBe(0);
		expect(dynamic.json).toMatchObject({
			kind: "run-all",
			cachePolicy: "bypass",
			cacheHits: [],
			toRun: unitFiles,
			counts: { total: 2, selected: 2, cacheHit: 0, run: 2 },
		});
		expect(invocations(fixture).at(-1)).toEqual(unitFiles);

		rmSync(path.join(fixture.root, dynamicInput));
		const deletedDynamic = await run(fixture, ["--changed", dynamicInput]);
		expect(deletedDynamic.status).toBe(0);
		expect(deletedDynamic.json).toMatchObject({
			kind: "run-all",
			cachePolicy: "bypass",
			cacheHits: [],
			toRun: unitFiles,
			counts: { total: 2, selected: 2, cacheHit: 0, run: 2 },
		});
		expect(invocations(fixture).at(-1)).toEqual(unitFiles);
	});

	it("does not certify code, non-code, or runner inputs mutated during execution", async () => {
		const fixture = await makeFixture();
		const cacheFile = path.join(fixture.root, ".profiles", "test-cache", "results.json");
		const cachedTests = (): string[] => {
			try {
				const cache = JSON.parse(readFileSync(cacheFile, "utf8"));
				return Object.values(cache).flatMap(bucket => Object.keys(bucket as Record<string, unknown>));
			} catch {
				return [];
			}
		};

		const codeMutation = await run(fixture, ["--changed", "src/a.ts"], {
			FAKE_MUTATE_PATH: "src/a.ts",
		});
		expect(codeMutation.status).toBe(0);
		expect(cachedTests()).not.toContain("tests2/core/a.test.ts");
		const afterCodeMutation = await run(fixture, ["--changed", "src/a.ts"]);
		expect(afterCodeMutation.json.counts).toMatchObject({ selected: 1, cacheHit: 0, run: 1 });
		const unchangedWarmHit = await run(fixture, ["--changed", "src/a.ts"]);
		expect(unchangedWarmHit.json.outcome).toBe("cache-hit-all");

		rmSync(cacheFile, { force: true });
		const nonCodeMutation = await run(fixture, ["--changed", "defaults/roles/coder.yaml"], {
			FAKE_MUTATE_PATH: "defaults/roles/coder.yaml",
		});
		expect(nonCodeMutation.status).toBe(0);
		expect(cachedTests()).not.toContain("tests2/core/a.test.ts");
		const afterNonCodeMutation = await run(fixture, ["--changed", "defaults/roles/coder.yaml"]);
		expect(afterNonCodeMutation.json.counts).toMatchObject({ selected: 1, cacheHit: 0, run: 1 });

		rmSync(cacheFile, { force: true });
		const runnerMutation = await run(fixture, ["--all"], {
			FAKE_MUTATE_PATH: "vitest.config.ts",
		});
		expect(runnerMutation.status).toBe(0);
		expect(runnerMutation.json).toMatchObject({
			kind: "run-all",
			cachePolicy: "bypass",
			counts: { selected: 2, cacheHit: 0, run: 2 },
		});
		const cacheModuleUrl = `${pathToFileURL(path.join(fixture.root, "scripts", "affected", "cache.mjs")).href}?toctou=${Date.now()}`;
		const cache: any = await import(cacheModuleUrl);
		const postChangeFingerprint = cache.runnerFingerprint({ repoRoot: fixture.root });
		const stored = JSON.parse(readFileSync(cacheFile, "utf8"));
		expect(stored[postChangeFingerprint]).toBeUndefined();
		expect(cachedTests()).toEqual([]);
		const afterRunnerMutation = await run(fixture, ["--changed", "src/a.ts"]);
		expect(afterRunnerMutation.json.counts).toMatchObject({ selected: 1, cacheHit: 0, run: 1 });
	});

	it("invalidates hashes for dynamic inputs and fingerprints every execution boundary", async () => {
		const fixture = await makeFixture();
		const cacheModuleUrl = `${pathToFileURL(path.join(fixture.root, "scripts", "affected", "cache.mjs")).href}?test=${Date.now()}`;
		const cache: any = await import(cacheModuleUrl);
		const options = { repoRoot: fixture.root };
		const deps = new Set(["tests2/core/a.test.ts", "defaults/roles/coder.yaml"]);
		const initialHash = cache.testHash("tests2/core/a.test.ts", deps, options);
		write(fixture.root, "defaults/roles/coder.yaml", "name: reviewer\n");
		expect(cache.testHash("tests2/core/a.test.ts", deps, options)).not.toBe(initialHash);

		const packagePath = path.join(fixture.root, "package.json");
		const initialPackage = JSON.parse(readFileSync(packagePath, "utf8"));
		const initialFingerprint = cache.runnerFingerprint(options);
		writeFileSync(packagePath, JSON.stringify({ ...initialPackage, scripts: { test: "metadata-only-change" } }));
		expect(cache.runnerFingerprint(options)).toBe(initialFingerprint);
		writeFileSync(packagePath, JSON.stringify({
			...initialPackage,
			dependencies: { ...initialPackage.dependencies, beta: "2.0.0" },
		}));
		expect(cache.runnerFingerprint(options)).not.toBe(initialFingerprint);
		writeFileSync(packagePath, JSON.stringify(initialPackage));

		for (const file of [
			"package-lock.json",
			"tsconfig.json",
			"vitest.config.ts",
			"tests2/tests-map.json",
			"scripts/testing-v2/test-map-execution.mjs",
			"scripts/testing-v2/repo-source-closure.mjs",
			"tests2/harness/run-isolation.ts",
			"scripts/testing-v2/environment-policy.mjs",
			"tests2/harness/unit-file-budget-reporter.ts",
			"scripts/affected/graph.mjs",
			"scripts/affected/impact-rules.mjs",
			"scripts/affected/classification.mjs",
			"scripts/affected/run.mjs",
			"scripts/affected/cache.mjs",
		]) {
			const target = path.join(fixture.root, file);
			const before = readFileSync(target, "utf8");
			const fingerprint = cache.runnerFingerprint(options);
			appendFileSync(target, "\n// fingerprint mutation\n");
			expect(cache.runnerFingerprint(options), file).not.toBe(fingerprint);
			writeFileSync(target, before);
		}

		const configPath = path.join(fixture.root, "vitest.config.ts");
		const dynamicInput = "tests2/harness/dynamic-fingerprint-input.ts";
		const beforeDynamicInput = cache.runnerFingerprint(options);
		write(fixture.root, dynamicInput, "export const value = 1;\n");
		expect(cache.runnerFingerprint(options), "unimported source").toBe(beforeDynamicInput);
		appendFileSync(configPath, '\nimport "./tests2/harness/dynamic-fingerprint-input.js";\n');
		const afterDynamicImport = cache.runnerFingerprint(options);
		expect(afterDynamicImport, "new config import topology").not.toBe(beforeDynamicInput);
		appendFileSync(path.join(fixture.root, dynamicInput), "export const next = 2;\n");
		expect(cache.runnerFingerprint(options), "newly imported config dependency bytes").not.toBe(afterDynamicImport);
		rmSync(path.join(fixture.root, dynamicInput));
		expect(cache.runnerFingerprint(options), "missing imported config dependency").not.toBe(afterDynamicImport);

		write(fixture.root, ".profiles/test-cache/results.json", "not json");
		expect(cache.loadCache(options)).toEqual({});
		const graph = { testDeps: new Map([["tests2/core/a.test.ts", deps]]) };
		const tests = new Set(["tests2/core/a.test.ts"]);
		const stableHashes = cache.snapshotTestHashes(graph, tests, options);
		const records = cache.record({}, "fp", tests, "pass", stableHashes);
		expect(records.fp["tests2/core/a.test.ts"]).toEqual({
			hash: stableHashes.get("tests2/core/a.test.ts"),
			verdict: "pass",
		});
		cache.record(records, "fp", tests, "fail");
		expect(records.fp).toEqual({});
	});
});
