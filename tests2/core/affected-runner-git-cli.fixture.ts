/**
 * Test-only real-Git fixture for the budgeted change-collection CLI journeys.
 * Every mutable root is run-owned and removed by cleanupFixtures().
 */
import {
	copyFileSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
	createRunChild,
	createRunChildEnvironment,
	removeOwnedRunChild,
} from "../harness/run-isolation.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ownedRoots: string[] = [];

export type Fixture = {
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
import { classifyAffectedTests } from "./classification.mjs";
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tests = ["tests2/core/a.test.ts", "tests2/core/b.test.ts"];
export function buildGraph(options = {}) {
  const vitestConfigFiles = vitestConfigRepoSourceFiles(REPO_ROOT)
    .map(file => relative(REPO_ROOT, file).replace(/\\/g, "/"));
  const tombstones = new Set([...(options.tombstones ?? [])].map(file => String(file).replace(/\\/g, "/")));
  const marketReadme = [...tombstones].find(file => file.toLowerCase() === "market-packs/example/readme.md") ?? "market-packs/example/README.md";
  const testDeps = new Map([
    [tests[0], new Set([tests[0], "src/a.ts", "src/common.ts", "defaults/roles/coder.yaml", marketReadme])],
    [tests[1], new Set([tests[1], "src/b.ts", "src/common.ts"])],
  ]);
  const srcToTests = new Map();
  for (const [test, deps] of testDeps) for (const dep of deps) {
    if (!srcToTests.has(dep)) srcToTests.set(dep, new Set());
    srcToTests.get(dep).add(test);
  }
  const pathIndex = new Map([...srcToTests.keys(), ...tombstones].map(file => [file.toLowerCase(), file]));
  return {
    testFiles: tests,
    testDeps,
    srcToTests,
    srcToBrowser: new Map(),
    browserDeps: new Map(),
    meta: { vitestConfigFiles, tombstones, pathIndex },
  };
}
export function affectedTests(graph, changes) {
  const paths = changes.flatMap(change => [change.path, change.oldPath].filter(Boolean));
  const removedExecutable = changes.find(change => /^D/.test(change.status) && /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/i.test(change.path));
  if (removedExecutable && graph.meta?.tombstones?.has(removedExecutable.path)) return {
    kind: "run-all", cachePolicy: "bypass", affected: new Set(graph.testFiles),
    browserAffected: new Set(), reasons: ["unresolved deleted dependency: " + removedExecutable.path], unmapped: [removedExecutable.path],
  };
  if (paths.some(file => String(file).toLowerCase() === "package.json")) {
    return classifyAffectedTests(graph, changes);
  }
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
  if (paths.map(file => String(file).toLowerCase()).includes("market-packs/example/readme.md")) affected.add(tests[0]);
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

export function write(root: string, relativePath: string, content: string): void {
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

export async function git(fixture: Pick<Fixture, "root" | "env">, args: string[]): Promise<string> {
	const result = await command(fixture, "git", args);
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.error ?? result.stderr}`);
	return result.stdout.trim();
}

export async function commit(fixture: Pick<Fixture, "root" | "env">, message: string): Promise<string> {
	await git(fixture, ["add", "--all"]);
	await git(fixture, [
		"-c", "user.name=Affected Fixture",
		"-c", "user.email=affected@example.invalid",
		"-c", "commit.gpgsign=false",
		"commit", "--quiet", "-m", message,
	]);
	return git(fixture, ["rev-parse", "HEAD"]);
}

export async function makeFixture(): Promise<Fixture> {
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
	write(root, "scripts/affected/classification.mjs", String.raw`
export function classifyAffectedTests(graph, changes) {
  const change = changes.find(candidate => [candidate.path, candidate.oldPath]
    .filter(Boolean).some(file => String(file).toLowerCase() === "package.json"));
  const packagePath = change.path.toLowerCase() === "package.json";
  const oldPackagePath = change.oldPath === undefined
    ? packagePath
    : change.oldPath.toLowerCase() === "package.json";
  if (packagePath !== oldPackagePath) return {
    kind: "run-all", cachePolicy: "bypass", affected: new Set(graph.testFiles),
    browserAffected: new Set(), reasons: ["root package topology change: " + change.oldPath + " -> " + change.path],
    unmapped: [],
  };
  throw new Error("fixture package classifier expected a package topology change");
}
`);
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
	write(root, "src/deleted-tool.ts", "export const deletedTool = 1;\n");
	write(root, "defaults/roles/coder.yaml", "name: coder\n");
	write(root, "market-packs/example/README.md", "# example pack\n");
	write(root, "semantic.json", "baseline-semantic-value\n");
	write(root, ".gitignore", ".profiles/\n");

	const fixture = { root, env, base: "", logFile };
	const initialized = await command(fixture, "git", ["init", "--quiet", "-b", "trunk"]);
	if (initialized.status !== 0) throw new Error(`git init failed: ${initialized.error ?? initialized.stderr}`);
	fixture.base = await commit(fixture, "initial fixture");
	return fixture;
}

export async function run(fixture: Fixture, args: string[], overrides: NodeJS.ProcessEnv = {}): Promise<RunnerResult> {
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

export function invocations(fixture: Fixture): string[][] {
	try {
		return readFileSync(fixture.logFile, "utf8").trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
	} catch {
		return [];
	}
}

export function cleanupFixtures(): void {
	while (ownedRoots.length) removeOwnedRunChild(ownedRoots.pop()!);
}
