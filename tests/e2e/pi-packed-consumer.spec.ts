import { test, expect, type TestInfo } from "@playwright/test";
import { existsSync } from "node:fs";
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
const PI_PACKAGES = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
] as const;
const INSPECTED_PACKAGES = [...PI_PACKAGES, "brace-expansion", "protobufjs"];
const COMPATIBILITY_BASELINE = "0.81.1";
const KNOWN_PROTOBUF_ADVISORY = "GHSA-j3f2-48v5-ccww";
const KNOWN_VULNERABLE_PROTOBUF_PATH =
	"node_modules/@earendil-works/pi-coding-agent/node_modules/protobufjs";

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
	audit?: unknown;
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

function expectExactVulnerabilityCounts(audit: JsonRecord, moderate: number): void {
	const metadata = asRecord(audit.metadata, "npm audit metadata");
	const counts = asRecord(metadata.vulnerabilities, "npm audit vulnerability counts");
	expect(counts).toMatchObject({
		info: 0,
		low: 0,
		moderate,
		high: 0,
		critical: 0,
		total: moderate,
	});
}

function assertKnown0811Audit(auditResult: PiPackedConsumerCommandResult, auditJson: unknown): void {
	expect(
		auditResult.code,
		`npm audit must exit 1 for the exact known ${COMPATIBILITY_BASELINE} moderate`,
	).toBe(1);
	const audit = asRecord(auditJson, "npm audit result");
	expect(audit.auditReportVersion).toBe(2);
	expectExactVulnerabilityCounts(audit, 1);

	const vulnerabilities = asRecord(audit.vulnerabilities, "npm audit vulnerabilities");
	expect(Object.keys(vulnerabilities)).toEqual(["protobufjs"]);
	const protobuf = asRecord(vulnerabilities.protobufjs, "protobufjs vulnerability");
	expect(protobuf).toMatchObject({
		name: "protobufjs",
		severity: "moderate",
		isDirect: false,
		effects: [],
		nodes: [KNOWN_VULNERABLE_PROTOBUF_PATH],
	});

	expect(Array.isArray(protobuf.via), "protobufjs advisory list must be an array").toBe(true);
	const advisoryIds = (protobuf.via as unknown[]).map((entry, index) => {
		const advisory = asRecord(entry, `protobufjs advisory ${index}`);
		expect(advisory).toMatchObject({
			name: "protobufjs",
			dependency: "protobufjs",
			severity: "moderate",
		});
		expect(typeof advisory.url).toBe("string");
		return (advisory.url as string).split("/").at(-1);
	});
	expect(advisoryIds).toEqual([KNOWN_PROTOBUF_ADVISORY]);
}

function assertCleanLaterPatchAudit(auditResult: PiPackedConsumerCommandResult, auditJson: unknown): void {
	expect(
		auditResult.code,
		`npm audit must exit 0 after Pi advances beyond ${COMPATIBILITY_BASELINE}`,
	).toBe(0);
	const audit = asRecord(auditJson, "npm audit result");
	expect(audit.auditReportVersion).toBe(2);
	expectExactVulnerabilityCounts(audit, 0);
	expect(asRecord(audit.vulnerabilities, "npm audit vulnerabilities")).toEqual({});
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

			const build = await runNpm(["run", "build"], PROJECT_ROOT, 10 * 60_000);
			expectSuccess(build);

			const packed = await runNpm(["pack", "--json", "--pack-destination", packDir], PROJECT_ROOT, 3 * 60_000);
			expectSuccess(packed);
			const packJson = parseJson(packed.stdout, "npm pack");
			report.pack = packJson;
			expect(Array.isArray(packJson), "npm pack must report one-element JSON array").toBe(true);
			expect(packJson).toHaveLength(1);
			const packEntry = asRecord((packJson as unknown[])[0], "npm pack entry");
			expect(packEntry.name).toBe("bobbit");
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

			const installedManifest = JSON.parse(await readFile(
				join(consumerDir, "node_modules", "bobbit", "package.json"),
				"utf8",
			)) as { dependencies?: Record<string, string> };
			const piPins = PI_PACKAGES.map(name => installedManifest.dependencies?.[name]);
			expect(piPins.every(pin => typeof pin === "string"), "packed Bobbit must declare all three Pi dependencies").toBe(true);
			expect(new Set(piPins).size, "packed Bobbit must pin all three Pi packages to one version").toBe(1);
			const selectedPiVersion = piPins[0]!;
			parseVersion(selectedPiVersion, "selected Pi pin");
			expect(compareVersions(selectedPiVersion, COMPATIBILITY_BASELINE)).toBeGreaterThanOrEqual(0);
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
					piOccurrences.every(entry => entry.path.includes("bobbit")),
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
			const isKnown0811 = selectedPiVersion === COMPATIBILITY_BASELINE;
			if (isKnown0811) {
				const vulnerableEdges = protobufOccurrences.filter(entry => entry.version === "7.6.4");
				expect(vulnerableEdges, "0.81.1 must retain exactly its one known shrinkwrap-owned protobuf edge").toHaveLength(1);
				expect(vulnerableEdges[0].path).toContain("@earendil-works/pi-coding-agent");
				expect(
					protobufOccurrences.every(entry => entry.version === "7.6.4" || compareVersions(entry.version, "7.6.5") >= 0),
					`unexpected protobufjs edge: ${JSON.stringify(protobufOccurrences)}`,
				).toBe(true);
			} else {
				expect(
					protobufOccurrences.every(entry => compareVersions(entry.version, "7.6.5") >= 0),
					`Pi ${selectedPiVersion} must resolve every protobufjs edge to 7.6.5+: ${JSON.stringify(protobufOccurrences)}`,
				).toBe(true);
			}

			const auditResult = await runNpm(["audit", "--omit=dev", "--json"], consumerDir, 3 * 60_000, consumerEnv);
			const auditJson = parseJson(auditResult.stdout, "npm audit");
			report.audit = { exitCode: auditResult.code, result: auditJson };
			if (isKnown0811) assertKnown0811Audit(auditResult, auditJson);
			else assertCleanLaterPatchAudit(auditResult, auditJson);

			const binariesModulePath = join(consumerDir, "node_modules", "bobbit", "dist", "server", "binaries.js");
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
