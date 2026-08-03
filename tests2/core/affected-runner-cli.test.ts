import { execFileSync, spawnSync } from "node:child_process";
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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tests = ["tests2/core/a.test.ts", "tests2/core/b.test.ts"];
export function buildGraph() {
  return {
    testFiles: tests,
    testDeps: new Map([
      [tests[0], new Set([tests[0], "src/a.ts", "src/common.ts", "defaults/roles/coder.yaml"])],
      [tests[1], new Set([tests[1], "src/b.ts", "src/common.ts"])],
    ]),
  };
}
export function affectedTests(graph, changes) {
  const paths = changes.flatMap(change => [change.path, change.oldPath].filter(Boolean));
  const broad = paths.find(file => file === "unknown.bin" || file === "vitest.config.ts"
    || file === "package-lock.json" || /^tsconfig(?:\..+)?\.json$/.test(file)
    || file.startsWith("scripts/affected/"));
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

function write(root: string, relativePath: string, content: string): void {
	const target = path.join(root, relativePath);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, content);
}

function git(fixture: Pick<Fixture, "root" | "env">, args: string[]): string {
	return execFileSync("git", args, {
		cwd: fixture.root,
		env: fixture.env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function commit(fixture: Pick<Fixture, "root" | "env">, message: string): string {
	git(fixture, ["add", "--all"]);
	git(fixture, [
		"-c", "user.name=Affected Fixture",
		"-c", "user.email=affected@example.invalid",
		"-c", "commit.gpgsign=false",
		"commit", "--quiet", "-m", message,
	]);
	return git(fixture, ["rev-parse", "HEAD"]);
}

function makeFixture(): Fixture {
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
	write(root, "scripts/testing-v2/test-map-execution.mjs", "export const owner = 'unit';\n");
	write(root, "scripts/testing-v2/repo-source-closure.mjs", "export const closure = [];\n");
	write(root, "node_modules/vitest/vitest.mjs", FAKE_VITEST);
	write(root, "package.json", JSON.stringify({
		type: "module",
		scripts: { test: "fixture" },
		dependencies: { alpha: "1.0.0" },
		devDependencies: { vitest: "4.1.10" },
	}));
	write(root, "package-lock.json", "fixture-lock\n");
	write(root, "tsconfig.json", "{}\n");
	write(root, "vitest.config.ts", "export default {};\n");
	write(root, "tests2/tests-map.json", "{}\n");
	write(root, "tests2/core/a.test.ts", "export const a = 1;\n");
	write(root, "tests2/core/b.test.ts", "export const b = 1;\n");
	write(root, "src/a.ts", "export const a = 1;\n");
	write(root, "src/b.ts", "export const b = 1;\n");
	write(root, "src/common.ts", "export const common = 1;\n");
	write(root, "defaults/roles/coder.yaml", "name: coder\n");
	write(root, "semantic.json", "baseline-semantic-value\n");
	write(root, ".gitignore", ".profiles/\n");

	execFileSync("git", ["init", "--quiet", "-b", "trunk"], { cwd: root, env, stdio: "pipe" });
	const fixture = { root, env, base: "", logFile };
	fixture.base = commit(fixture, "initial fixture");
	return fixture;
}

function run(fixture: Fixture, args: string[], overrides: NodeJS.ProcessEnv = {}): RunnerResult {
	const result = spawnSync(
		process.execPath,
		[path.join(fixture.root, "scripts", "affected", "run.mjs"), ...args, "--json"],
		{
			cwd: fixture.root,
			env: { ...fixture.env, ...overrides },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		},
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
	it("collects committed, staged, unstaged, untracked, and explicit change records", () => {
		const fixture = makeFixture();
		write(fixture.root, "semantic.json", "committed-semantic-value\n");
		commit(fixture, "committed semantic change");

		const committed = run(fixture, ["--base", fixture.base, "--dry", "--no-cache"]);
		expect(committed.status).toBe(0);
		expect(committed.json.changed).toEqual([{ path: "semantic.json", status: "M" }]);
		expect(committed.json.reasons[0]).toBe("semantic:baseline-semantic-value->committed-semantic-value");

		write(fixture.root, "semantic.json", "staged-semantic-value\n");
		git(fixture, ["add", "semantic.json"]);
		write(fixture.root, "src/a.ts", "export const a = 2;\n");
		write(fixture.root, "docs/untracked.md", "fixture docs\n");
		const overlays = run(fixture, ["--base", "HEAD", "--dry", "--no-cache"]);
		expect(overlays.status).toBe(0);
		expect(overlays.json.changed).toEqual(expect.arrayContaining([
			{ path: "semantic.json", status: "M" },
			{ path: "src/a.ts", status: "M" },
			{ path: "docs/untracked.md", status: "A" },
		]));
		expect(overlays.json.reasons[0]).toBe("semantic:committed-semantic-value->staged-semantic-value");
		expect(overlays.json.summary).toBe("BOUNDED selected=1, cache-hit=0, run=1");

		const docsOnly = run(fixture, ["--changed", "docs/untracked.md", "--dry"]);
		expect(docsOnly.json.summary).toBe("SKIP-ALL reason=docs only, selected=0, run=0");

		const explicit = run(fixture, ["--changed", "semantic.json", "--base", "HEAD", "--dry", "--no-cache"]);
		expect(explicit.status).toBe(0);
		expect(explicit.json.changed).toEqual([{ path: "semantic.json", status: "M" }]);
		expect(explicit.json.kind).toBe("bounded");
	});

	it("preserves rename/delete attribution and fails on an invalid explicit base", () => {
		const fixture = makeFixture();
		git(fixture, ["mv", "semantic.json", "semantic-renamed.json"]);
		rmSync(path.join(fixture.root, "src", "a.ts"));
		const changed = run(fixture, ["--base", "HEAD", "--dry", "--no-cache"]);
		expect(changed.status).toBe(0);
		expect(changed.json.changed).toEqual(expect.arrayContaining([
			{ path: "semantic-renamed.json", oldPath: "semantic.json", status: "R" },
			{ path: "src/a.ts", status: "D" },
		]));
		expect(changed.json.affected).toContain("tests2/core/a.test.ts");

		const invalid = run(fixture, ["--base", "definitely-not-a-ref", "--dry"]);
		expect(invalid.status).toBe(2);
		expect(invalid.json).toMatchObject({ outcome: "error" });
		expect(invalid.json.error).toContain("merge-base");
	});

	it("bypasses warm cache for RUN-ALL and retains only fresh per-file PASS verdicts", () => {
		const fixture = makeFixture();
		const warm = run(fixture, ["--all"]);
		expect(warm.status).toBe(0);
		expect(warm.json).toMatchObject({
			kind: "run-all",
			cachePolicy: "bypass",
			counts: { total: 2, selected: 2, cacheHit: 0, run: 2 },
		});

		const boundedHit = run(fixture, ["--changed", "src/a.ts"]);
		expect(boundedHit.status).toBe(0);
		expect(boundedHit.json.outcome).toBe("cache-hit-all");
		expect(boundedHit.json.summary).toBe("CACHE-HIT-ALL selected=1, cache-hit=1, run=0");
		expect(invocations(fixture)).toHaveLength(1);

		write(fixture.root, "unknown.bin", "broad input\n");
		const broad = run(fixture, ["--base", "HEAD"]);
		expect(broad.status).toBe(0);
		expect(broad.json.summary).toContain("RUN-ALL");
		expect(broad.json.counts).toMatchObject({ selected: 2, cacheHit: 0, run: 2 });
		expect(invocations(fixture)).toHaveLength(2);

		const mixed = run(fixture, ["--base", "HEAD"], { FAKE_FAIL: "tests2/core/b.test.ts" });
		expect(mixed.status).toBe(1);
		expect(mixed.json.outcome).toBe("fail");
		const cache = JSON.parse(readFileSync(path.join(fixture.root, ".profiles", "test-cache", "results.json"), "utf8"));
		const bucket = Object.values(cache)[0] as Record<string, unknown>;
		expect(Object.keys(bucket)).toEqual(["tests2/core/a.test.ts"]);

		const passingSibling = run(fixture, ["--changed", "src/a.ts"]);
		expect(passingSibling.json.outcome).toBe("cache-hit-all");
		const failedSibling = run(fixture, ["--changed", "src/b.ts"]);
		expect(failedSibling.json.counts).toMatchObject({ selected: 1, cacheHit: 0, run: 1 });
		expect(invocations(fixture)).toHaveLength(4);

		const ambiguous = run(fixture, ["--base", "HEAD"], {
			FAKE_FAIL: "tests2/core/b.test.ts",
			FAKE_NO_REPORT: "1",
		});
		expect(ambiguous.status).toBe(1);
		const rerunAfterAmbiguousFailure = run(fixture, ["--changed", "src/a.ts"]);
		expect(rerunAfterAmbiguousFailure.json.counts).toMatchObject({ selected: 1, cacheHit: 0, run: 1 });
		expect(invocations(fixture)).toHaveLength(6);
	});

	it("invalidates hashes for dynamic inputs and fingerprints every execution boundary", async () => {
		const fixture = makeFixture();
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
			"scripts/affected/graph.mjs",
			"scripts/affected/impact-rules.mjs",
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

		write(fixture.root, ".profiles/test-cache/results.json", "not json");
		expect(cache.loadCache(options)).toEqual({});
		const graph = { testDeps: new Map([["tests2/core/a.test.ts", deps]]) };
		const records = cache.record({}, "fp", graph, new Set(["tests2/core/a.test.ts"]), "pass", options);
		expect(records.fp["tests2/core/a.test.ts"].verdict).toBe("pass");
		cache.record(records, "fp", graph, new Set(["tests2/core/a.test.ts"]), "fail", options);
		expect(records.fp).toEqual({});
	});
});
