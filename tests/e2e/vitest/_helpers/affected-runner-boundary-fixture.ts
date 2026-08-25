import { spawn } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createRunChild,
	createRunChildEnvironment,
	removeOwnedRunChild,
} from "../../../../tests2/harness/run-isolation.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const FIXTURE_GRAPH = String.raw`
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureTest = "tests2/core/fixture.test.ts";
export function buildGraph() {
  return {
    testFiles: [fixtureTest],
    testDeps: new Map([[fixtureTest, new Set([fixtureTest])]]),
    srcToTests: new Map(),
    srcToBrowser: new Map(),
    browserDeps: new Map(),
    meta: {},
  };
}
export function affectedTests(_graph, changes) {
  const paths = changes.flatMap(change => [change.path, change.oldPath].filter(Boolean));
  const sourcePaths = paths.filter(file => file.startsWith("src/"));
  if (sourcePaths.length === 0) return {
    kind: "skip-all", cachePolicy: "eligible", affected: new Set(),
    browserAffected: new Set(), reasons: ["docs only"], unmapped: [],
  };
  return {
    kind: "bounded", cachePolicy: "eligible", affected: new Set([fixtureTest]),
    browserAffected: new Set(), reasons: sourcePaths.map(file => "source:" + file), unmapped: [],
  };
}
`;

const FIXTURE_CACHE = String.raw`
export function loadCache() { return {}; }
export function partition(_cache, _fingerprint, _graph, selected) {
  return { hits: new Set(), misses: new Set(selected) };
}
export function record() {}
export function runnerFingerprint() { return "fixture-fingerprint"; }
export function saveCache() {}
export function snapshotTestHashes(_graph, tests) {
  return new Map(tests.map(test => [test, "fixture-hash"]));
}
`;

export interface AffectedRunnerFixture {
	root: string;
	env: NodeJS.ProcessEnv;
	base: string;
}

export interface CommandResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

export interface RunnerResult extends CommandResult {
	json: any;
}

function write(root: string, relativePath: string, content: string): void {
	const target = path.join(root, relativePath);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, content, "utf8");
}

function command(
	fixture: Pick<AffectedRunnerFixture, "root" | "env">,
	file: string,
	args: string[],
): Promise<CommandResult> {
	return new Promise((resolveCommand, reject) => {
		const child = spawn(file, args, {
			cwd: fixture.root,
			env: fixture.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		child.once("error", reject);
		child.once("close", (status) => resolveCommand({ status, stdout, stderr }));
	});
}

export async function git(fixture: Pick<AffectedRunnerFixture, "root" | "env">, args: string[]): Promise<string> {
	const result = await command(fixture, "git", args);
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
	}
	return result.stdout.trim();
}

export async function commit(fixture: Pick<AffectedRunnerFixture, "root" | "env">, message: string): Promise<string> {
	await git(fixture, ["add", "--all"]);
	await git(fixture, [
		"-c", "user.name=Affected E2E Fixture",
		"-c", "user.email=affected-e2e@example.invalid",
		"-c", "commit.gpgsign=false",
		"commit", "--quiet", "-m", message,
	]);
	return git(fixture, ["rev-parse", "HEAD"]);
}

export async function createAffectedRunnerFixture(): Promise<AffectedRunnerFixture> {
	const root = createRunChild("affected-runner-boundary");
	const globalConfig = path.join(root, "empty-gitconfig");
	writeFileSync(globalConfig, "", "utf8");
	const env = createRunChildEnvironment({
		GIT_CONFIG_GLOBAL: globalConfig,
		GIT_CONFIG_NOSYSTEM: "1",
	});
	const fixture: AffectedRunnerFixture = { root, env, base: "" };

	try {
		mkdirSync(path.join(root, "scripts", "affected"), { recursive: true });
		for (const file of ["run.mjs", "runner.mjs"]) {
			copyFileSync(
				path.join(REPO_ROOT, "scripts", "affected", file),
				path.join(root, "scripts", "affected", file),
			);
		}
		write(root, "scripts/affected/graph.mjs", FIXTURE_GRAPH);
		write(root, "scripts/affected/cache.mjs", FIXTURE_CACHE);
		write(root, "package.json", JSON.stringify({ type: "module" }, null, 2) + "\n");
		write(root, "tests2/core/fixture.test.ts", "export const fixture = true;\n");
		write(root, "docs/readme.md", "fixture documentation\n");
		for (const file of [
			"committed.ts",
			"staged.ts",
			"unstaged.ts",
			"rename-old.ts",
			"deleted.ts",
		]) write(root, `src/${file}`, `export const value = ${JSON.stringify(file)};\n`);

		await git(fixture, ["init", "--quiet", "-b", "trunk"]);
		fixture.base = await commit(fixture, "initial affected-runner boundary fixture");
		return fixture;
	} catch (error) {
		removeOwnedRunChild(root);
		throw error;
	}
}

export function writeFixture(fixture: AffectedRunnerFixture, relativePath: string, content: string): void {
	write(fixture.root, relativePath, content);
}

export async function runAffectedCli(fixture: AffectedRunnerFixture, args: string[]): Promise<RunnerResult> {
	const result = await command(fixture, process.execPath, [
		path.join(fixture.root, "scripts", "affected", "run.mjs"),
		...args,
		"--json",
	]);
	const stdout = result.stdout.trim();
	return {
		...result,
		json: stdout ? JSON.parse(stdout) : undefined,
	};
}

export function removeAffectedRunnerFixture(fixture: AffectedRunnerFixture | undefined): void {
	if (fixture) removeOwnedRunChild(fixture.root);
}
