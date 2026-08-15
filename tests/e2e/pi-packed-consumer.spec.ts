import { test, expect, type TestInfo } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { awaitableRm } from "./test-utils/cleanup.js";
import {
	piPackedConsumerNpmEnv,
	runPiPackedConsumerCommand,
	runPiPackedConsumerNpm,
	type PiPackedConsumerCommandResult,
} from "./test-utils/pi-packed-consumer-command.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENSURE_DIST_SCRIPT = join(PROJECT_ROOT, "scripts", "testing-v2", "ensure-dist.mjs");
const PACKAGE_NAME = (JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")) as { name: string }).name;
const PACKAGE_INSTALL_SEGMENTS = PACKAGE_NAME.split("/");
const PI_PACKAGES = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
] as const;
const INSPECTED_PACKAGES = [...PI_PACKAGES, "brace-expansion", "protobufjs"];
const REQUIRED_PI_VERSION = "0.84.1";

interface JsonRecord {
	[key: string]: unknown;
}

interface DependencyOccurrence {
	name: string;
	version: string;
	path: string[];
}

interface PackedConsumerReport {
	commands: PiPackedConsumerCommandResult[];
	selectedPiVersion?: string;
	pack?: unknown;
	tree?: unknown;
	binaries?: unknown;
}

function asRecord(value: unknown, label: string): JsonRecord {
	expect(value, `${label} must be an object`).not.toBeNull();
	expect(typeof value, `${label} must be an object`).toBe("object");
	expect(Array.isArray(value), `${label} must not be an array`).toBe(false);
	return value as JsonRecord;
}

function parseJson(stdout: string, label: string): unknown {
	expect(stdout.trim(), `${label} stdout must contain JSON`).not.toBe("");
	try {
		return JSON.parse(stdout);
	} catch (error) {
		throw new Error(`${label} emitted malformed JSON: ${(error as Error).message}\nstdout:\n${stdout}`, {
			cause: error,
		});
	}
}

function parseVersion(version: string, label = "version"): [number, number, number] {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	expect(match, `${label} must be an exact stable semver, received ${JSON.stringify(version)}`).not.toBeNull();
	return [Number(match![1]), Number(match![2]), Number(match![3])];
}

function compareVersions(left: string, right: string): number {
	const a = parseVersion(left, "selected version");
	const b = parseVersion(right, "compatibility baseline");
	for (let index = 0; index < a.length; index++) {
		if (a[index] !== b[index]) return a[index] - b[index];
	}
	return 0;
}

function collectDependencies(tree: unknown): DependencyOccurrence[] {
	const occurrences: DependencyOccurrence[] = [];
	const visit = (value: unknown, ancestors: string[]): void => {
		const node = asRecord(value, `npm ls node at ${ancestors.join(" > ") || "root"}`);
		const dependencies = node.dependencies;
		if (dependencies === undefined) return;
		const dependencyMap = asRecord(dependencies, `dependencies at ${ancestors.join(" > ") || "root"}`);
		for (const [name, rawDependency] of Object.entries(dependencyMap)) {
			const dependency = asRecord(rawDependency, `npm ls dependency ${name}`);
			const path = [...ancestors, name];
			if (INSPECTED_PACKAGES.includes(name as typeof INSPECTED_PACKAGES[number])) {
				expect(typeof dependency.version, `${path.join(" > ")} must report a version`).toBe("string");
				occurrences.push({ name, version: dependency.version as string, path });
			}
			visit(dependency, path);
		}
	};
	visit(tree, []);
	return occurrences;
}

function collectNpmProblems(tree: unknown): string[] {
	const problems: string[] = [];
	const visit = (value: unknown): void => {
		const node = asRecord(value, "npm ls node");
		if (node.problems !== undefined) {
			expect(Array.isArray(node.problems), "npm ls problems must be an array").toBe(true);
			for (const problem of node.problems as unknown[]) problems.push(String(problem));
		}
		if (node.dependencies === undefined) return;
		for (const dependency of Object.values(asRecord(node.dependencies, "npm ls dependencies"))) visit(dependency);
	};
	visit(tree);
	return problems;
}

function commandDisplay(result: PiPackedConsumerCommandResult): string {
	return [result.command, ...result.args].join(" ");
}

function expectSuccess(result: PiPackedConsumerCommandResult): void {
	expect(
		result.code,
		`${commandDisplay(result)} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
	).toBe(0);
}

async function attachReport(testInfo: TestInfo, report: PackedConsumerReport): Promise<void> {
	await testInfo.attach("pi-packed-consumer-report.json", {
		body: Buffer.from(`${JSON.stringify(report, null, 2)}\n`),
		contentType: "application/json",
	});
}

test.describe("published Bobbit package dependency security", () => {
	test("a clean consumer preserves secure Pi edges and bundled binaries", async ({}, testInfo) => {
		test.setTimeout(15 * 60_000);
		const tempRoot = await mkdtemp(join(tmpdir(), "bobbit-pi-packed-consumer-"));
		const packDir = join(tempRoot, "pack");
		const consumerDir = join(tempRoot, "consumer");
		const report: PackedConsumerReport = { commands: [] };

		const runNpm = async (
			args: string[],
			cwd: string,
			timeoutMs: number,
			env: NodeJS.ProcessEnv = process.env,
		): Promise<PiPackedConsumerCommandResult> => {
			const result = await runPiPackedConsumerNpm(args, { cwd, env, timeoutMs });
			report.commands.push(result);
			return result;
		};

		try {
			await mkdir(packDir, { recursive: true });
			await mkdir(consumerDir, { recursive: true });
			await writeFile(join(consumerDir, "package.json"), `${JSON.stringify({
				name: "bobbit-packed-consumer-e2e",
				version: "1.0.0",
				private: true,
			}, null, 2)}\n`);

			// `npm run build` rewrites dist destructively. Coordinate it with the
			// repository cache/lock so concurrent E2E coordinators never pack while
			// another consumer is rebuilding the same worktree.
			const build = await runPiPackedConsumerCommand(
				process.execPath,
				[ENSURE_DIST_SCRIPT],
				{ cwd: PROJECT_ROOT, timeoutMs: 10 * 60_000 },
			);
			report.commands.push(build);
			expectSuccess(build);

			const packed = await runNpm(["pack", "--json", "--pack-destination", packDir], PROJECT_ROOT, 3 * 60_000);
			expectSuccess(packed);
			const packJson = parseJson(packed.stdout, "npm pack");
			report.pack = packJson;
			expect(Array.isArray(packJson), "npm pack must report one-element JSON array").toBe(true);
			expect(packJson).toHaveLength(1);
			const packEntry = asRecord((packJson as unknown[])[0], "npm pack entry");
			expect(packEntry.name).toBe(PACKAGE_NAME);
			expect(typeof packEntry.filename).toBe("string");
			const tarballPath = resolve(packDir, packEntry.filename as string);
			expect(existsSync(tarballPath), `npm pack did not create ${tarballPath}`).toBe(true);

			const consumerEnv = piPackedConsumerNpmEnv(consumerDir);
			const lockConfig = await runNpm(["config", "get", "package-lock"], consumerDir, 30_000, consumerEnv);
			expectSuccess(lockConfig);
			expect(lockConfig.stdout.trim(), "clean consumer must use npm's normal package-lock=true default").toBe("true");

			const install = await runNpm(["install", tarballPath], consumerDir, 10 * 60_000, consumerEnv);
			expectSuccess(install);
			expect(existsSync(join(consumerDir, "package-lock.json")), "consumer install must create its own lockfile").toBe(true);
			expect(
				existsSync(join(
					consumerDir,
					"node_modules",
					"@earendil-works",
					"pi-coding-agent",
					"npm-shrinkwrap.json",
				)),
				"published pi-coding-agent must include its dependency-owned shrinkwrap",
			).toBe(true);

			const installedRoot = join(consumerDir, "node_modules", ...PACKAGE_INSTALL_SEGMENTS);
			const installedManifest = JSON.parse(await readFile(
				join(installedRoot, "package.json"),
				"utf8",
			)) as { dependencies?: Record<string, string> };
			const piPins = PI_PACKAGES.map(name => installedManifest.dependencies?.[name]);
			expect(piPins.every(pin => typeof pin === "string"), "packed Bobbit must declare all three Pi dependencies").toBe(true);
			expect(new Set(piPins).size, "packed Bobbit must pin all three Pi packages to one version").toBe(1);
			const selectedPiVersion = piPins[0]!;
			parseVersion(selectedPiVersion, "selected Pi pin");
			expect(selectedPiVersion, "packed Bobbit must pin Pi exactly to the supported version").toBe(REQUIRED_PI_VERSION);
			report.selectedPiVersion = selectedPiVersion;

			const lsResult = await runNpm(
				["ls", ...INSPECTED_PACKAGES, "--all", "--json"],
				consumerDir,
				2 * 60_000,
				consumerEnv,
			);
			expectSuccess(lsResult);
			const tree = parseJson(lsResult.stdout, "npm ls");
			report.tree = tree;
			expect(collectNpmProblems(tree), "npm ls must have no invalid, missing, stale, or extraneous edges").toEqual([]);
			const occurrences = collectDependencies(tree);

			for (const piPackage of PI_PACKAGES) {
				const piOccurrences = occurrences.filter(entry => entry.name === piPackage);
				expect(piOccurrences.length, `${piPackage} must appear in the packed consumer tree`).toBeGreaterThan(0);
				expect(
					[...new Set(piOccurrences.map(entry => entry.version))],
					`${piPackage} must not have mixed or stale versions`,
				).toEqual([selectedPiVersion]);
				expect(
					piOccurrences.every(entry => entry.path.includes(PACKAGE_NAME)),
					`${piPackage} must resolve through the installed Bobbit package`,
				).toBe(true);
			}

			const braceOccurrences = occurrences.filter(entry => entry.name === "brace-expansion");
			expect(braceOccurrences.length, "brace-expansion must appear in the packed consumer tree").toBeGreaterThan(0);
			expect(
				braceOccurrences.every(entry => compareVersions(entry.version, "5.0.7") >= 0),
				`every brace-expansion edge must be 5.0.7+: ${JSON.stringify(braceOccurrences)}`,
			).toBe(true);

			const protobufOccurrences = occurrences.filter(entry => entry.name === "protobufjs");
			expect(protobufOccurrences.length, "protobufjs must appear in the packed consumer tree").toBeGreaterThan(0);
			expect(
				protobufOccurrences.every(entry => compareVersions(entry.version, "7.6.5") >= 0),
				`Pi ${selectedPiVersion} must resolve every protobufjs edge to 7.6.5+: ${JSON.stringify(protobufOccurrences)}`,
			).toBe(true);

			const binariesModulePath = join(installedRoot, "dist", "server", "binaries.js");
			const binaries = await import(pathToFileURL(binariesModulePath).href) as {
				expectedBinaryPackage(): string | null;
				getFdResolution(): { source: string; path: string | null; expectedPackage: string };
				getRgResolution(): { source: string; path: string | null; expectedPackage: string };
			};
			const expectedBinaryPackage = binaries.expectedBinaryPackage();
			const resolutions = {
				fd: binaries.getFdResolution(),
				rg: binaries.getRgResolution(),
			};
			report.binaries = { expectedBinaryPackage, resolutions };
			if (expectedBinaryPackage) {
				for (const [tool, resolution] of Object.entries(resolutions)) {
					expect(resolution.source, `${tool} must resolve from ${expectedBinaryPackage}`).toBe("bundled");
					expect(resolution.expectedPackage).toBe(expectedBinaryPackage);
					expect(resolution.path, `${tool} bundled resolution must have a path`).not.toBeNull();
					expect(existsSync(resolution.path!), `${tool} binary does not exist at ${resolution.path}`).toBe(true);
					const smoke = await runPiPackedConsumerCommand(resolution.path!, ["--version"], {
						cwd: consumerDir,
						env: consumerEnv,
						timeoutMs: 30_000,
					});
					report.commands.push(smoke);
					expectSuccess(smoke);
					expect(`${smoke.stdout}\n${smoke.stderr}`.trim(), `${tool} --version must print its version`).not.toBe("");
				}
			} else {
				testInfo.annotations.push({
					type: "unsupported-binary-platform",
					description: `${process.platform}-${process.arch} has no published Bobbit binary package`,
				});
			}
		} finally {
			await attachReport(testInfo, report);
			const cleanup = await awaitableRm(tempRoot, { maxAttempts: 6, backoffMs: 250 });
			expect.soft(
				cleanup.removed,
				`failed to remove packed-consumer temp tree ${tempRoot}: ${String(cleanup.lastError)}`,
			).toBe(true);
		}
	});
});
