import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
	buildAuditReport,
	compareSelectionEvidence,
	createQualificationEnvironment,
	graphOnlyDiagnostic,
	normalizeSelectionPlan,
	npmInvocation,
	parseVitestReport,
	renderAuditReport,
	summarizeQualification,
	unitInventoryFromMap,
	withOwnedQualificationRoot,
} from "../../scripts/affected/correctness-vs-main.mjs";
import {
	createRunChild,
	removeOwnedRunChild,
} from "../harness/run-isolation.js";

const UNIT = [
	"tests2/core/alpha.test.ts",
	"tests2/dom/beta.test.ts",
	"tests2/integration/gamma.test.ts",
];
let fixtureParent: string;

beforeAll(() => {
	fixtureParent = createRunChild("affected-correctness-fast");
});

afterAll(() => {
	if (existsSync(fixtureParent)) removeOwnedRunChild(fixtureParent);
});

describe("affected correctness qualification primitives", () => {
	it("normalizes tri-state plans and makes RUN-ALL a cache-bypassing full execution", () => {
		expect(normalizeSelectionPlan({
			kind: "bounded",
			cachePolicy: "eligible",
			affected: new Set([UNIT[0], "tests2/browser/not-unit.spec.ts"]),
			reasons: ["static closure"],
		}, UNIT)).toEqual({
			kind: "bounded",
			cachePolicy: "eligible",
			selected: [UNIT[0]],
			browserAffected: [],
			reasons: ["static closure"],
			unmapped: [],
		});

		const runAll = normalizeSelectionPlan({
			kind: "run-all",
			cachePolicy: "bypass",
			affected: new Set([UNIT[0]]),
			reason: "vitest config changed",
		}, UNIT);
		expect(runAll.selected).toEqual(UNIT);
		expect(runAll.cachePolicy).toBe("bypass");
		expect(() => normalizeSelectionPlan({
			kind: "run-all",
			cachePolicy: "eligible",
			affected: UNIT,
		}, UNIT)).toThrow("RUN-ALL selection must bypass result-cache reads");

		expect(normalizeSelectionPlan({ affected: new Set() }, UNIT)).toMatchObject({
			kind: "skip-all",
			selected: [],
			cachePolicy: "eligible",
		});
	});

	it("dispatches Windows npm through Node with exact argv and no cmd shim", () => {
		const npmCli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
		const nodeExecutable = "C:\\Program Files\\nodejs\\node.exe";
		const unsafeAsShellText = "cache path & echo must-not-run";
		const invocation = npmInvocation(["ci", "--cache", unsafeAsShellText], {
			platform: "win32",
			env: { NPM_EXECPATH: npmCli },
			nodeExecutable,
			fileExists: (path: string) => path === npmCli,
		});
		expect(invocation).toEqual({
			file: nodeExecutable,
			args: [npmCli, "ci", "--cache", unsafeAsShellText],
		});
		expect(invocation.file).not.toMatch(/\.cmd$/i);
	});

	it("requires every direct, native-observed, and full-run-failing test while allowing over-selection", () => {
		const safe = compareSelectionEvidence({
			selected: [UNIT[0], UNIT[1], UNIT[2]],
			directChangedUnit: [UNIT[0]],
			nativeChangedObserved: [UNIT[1]],
			fullRunFailures: [],
		});
		expect(safe).toMatchObject({
			required: [UNIT[0], UNIT[1]],
			underSelected: [],
			overSelected: [UNIT[2]],
			safe: true,
		});

		const unsafe = compareSelectionEvidence({
			selected: [UNIT[0]],
			directChangedUnit: [UNIT[0]],
			nativeChangedObserved: [UNIT[1]],
			fullRunFailures: [UNIT[2]],
		});
		expect(unsafe.underSelected).toEqual([UNIT[1], UNIT[2]]);
		expect(unsafe.safe).toBe(false);
	});

	it("parses auditable Vitest touched and failing file evidence", () => {
		const repoRoot = resolve(fixtureParent, "repo");
		const parsed = parseVitestReport({
			testResults: [
				{ name: resolve(repoRoot, UNIT[0]), status: "passed", assertionResults: [{ status: "passed" }] },
				{ name: resolve(repoRoot, UNIT[1]), status: "failed", assertionResults: [] },
				{ name: resolve(repoRoot, UNIT[2]), status: "passed", assertionResults: [{ status: "failed" }] },
			],
		}, repoRoot);
		expect(parsed.observed).toEqual(UNIT);
		expect(parsed.failures).toEqual([UNIT[1], UNIT[2]]);
		expect(() => parseVitestReport({}, repoRoot)).toThrow("missing testResults");
	});

	it("reports graph-only selection as explicitly non-executable", () => {
		const graph = {
			srcToTests: new Map([
				["src/shared/runtime.ts", new Set([UNIT[0], "tests2/browser/advisory.spec.ts"])],
			]),
		};
		const diagnostic = graphOnlyDiagnostic(graph, [{
			status: "M",
			path: "src\\shared\\runtime.ts",
		}], UNIT);
		expect(diagnostic).toEqual({
			executable: false,
			label: "graph-only diagnostic (broad triggers ignored; never executed)",
			selected: [UNIT[0]],
		});
	});

	it("excludes SKIP-ALL and RUN-ALL from bounded averages and fails blind non-doc zeroes", () => {
		const rows = [
			{ id: "docs", documentationOnly: true, plan: { kind: "skip-all", selected: [] }, timings: { selectionMs: 1 } },
			{ id: "bounded-a", documentationOnly: false, plan: { kind: "bounded", selected: [UNIT[0], UNIT[1]] }, timings: { selectionMs: 4 } },
			{ id: "bounded-b", documentationOnly: false, plan: { kind: "bounded", selected: [UNIT[2]] }, timings: { selectionMs: 8 } },
			{ id: "broad", documentationOnly: false, plan: { kind: "run-all", selected: UNIT }, timings: { selectionMs: 2 } },
			{ id: "blind", documentationOnly: false, plan: { kind: "skip-all", selected: [] }, timings: { selectionMs: 1 } },
		] as any[];
		const summary = summarizeQualification(rows);
		expect(summary.categories).toEqual({ "skip-all": 2, bounded: 2, "run-all": 1 });
		expect(summary.boundedAverageSampleCount).toBe(2);
		expect(summary.boundedAverageSelected).toBe(2);
		expect(summary.boundedAverageSelectionMs).toBe(6);
		expect(summary.suspiciousZero).toEqual(["blind"]);
		expect(summary.safe).toBe(false);
	});

	it("renders commit, plan, commands, evidence, discrepancies, and timings in the audit output", () => {
		const evidence = compareSelectionEvidence({ selected: UNIT, nativeChangedObserved: [UNIT[0]] });
		const row = {
			id: "sample",
			commit: "a".repeat(40),
			parent: "b".repeat(40),
			subject: "fixture",
			documentationOnly: false,
			changedInputs: [{ status: "M", path: "src/example.ts" }],
			plan: { kind: "bounded", cachePolicy: "eligible", selected: UNIT, reasons: ["closure"] },
			graphOnlyDiagnostic: undefined,
			commands: { nativeChanged: "vitest --changed parent", fullUnit: "npm run test:unit -- --retry=0" },
			timings: { selectionMs: 1, installMs: 2, nativeChangedMs: 3, fullUnitMs: 4 },
			evidence,
		};
		const report = buildAuditReport([row], { generatedAt: "2026-01-01T00:00:00.000Z" });
		const text = renderAuditReport(report);
		for (const expected of [
			row.commit,
			"changed inputs (1): src/example.ts",
			"executable plan: bounded; cache=eligible; selected=3",
			row.commands.nativeChanged,
			row.commands.fullUnit,
			"under-selected (0)",
			"over-selected (2)",
			"selection=1, install=2, native=3, full=4",
		]) expect(text).toContain(expected);
	});

	it("sanitizes credentials and redirects every mutable discovery root beneath the owned run", async () => {
		await withOwnedQualificationRoot(async (root: string) => {
			const env = createQualificationEnvironment(root, {
				PATH: process.env.PATH,
				GITHUB_TOKEN: "must-not-survive",
				BOBBIT_GATEWAY_URL: "https://ambient.invalid",
				BOBBIT_TEST_DELiberate: "preserved",
			});
			expect(env.GITHUB_TOKEN).toBeUndefined();
			expect(env.BOBBIT_GATEWAY_URL).toBeUndefined();
			expect(env.BOBBIT_TEST_DELiberate).toBe("preserved");
			for (const key of [
				"HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "BOBBIT_DIR",
				"BOBBIT_AGENT_DIR", "BOBBIT_SECRETS_DIR", "XDG_CACHE_HOME",
				"XDG_CONFIG_HOME", "XDG_STATE_HOME", "APPDATA", "LOCALAPPDATA",
				"npm_config_cache",
			]) {
				const rel = relative(root, env[key]!);
				expect(rel, `${key} must be owned by the qualification root`).not.toMatch(/^\.\.(?:[\\/]|$)/);
			}
		}, { parent: fixtureParent });
	});

	it("removes only its exact owned root after both success and child failure", async () => {
		let successfulRoot = "";
		await withOwnedQualificationRoot(async (root: string) => {
			successfulRoot = root;
			expect(existsSync(root)).toBe(true);
		}, { parent: fixtureParent });
		expect(existsSync(successfulRoot)).toBe(false);
		expect(existsSync(fixtureParent)).toBe(true);

		let failedRoot = "";
		await expect(withOwnedQualificationRoot(async (root: string) => {
			failedRoot = root;
			throw new Error("fixture child failed");
		}, { parent: fixtureParent })).rejects.toThrow("fixture child failed");
		expect(existsSync(failedRoot)).toBe(false);
		expect(existsSync(fixtureParent)).toBe(true);
	});

	it("pins immutable sample coverage for docs, UI, #1071, #1072, dependency, and shipped non-code cases", () => {
		const manifest = JSON.parse(readFileSync(new URL("../../scripts/affected/correctness-sample.json", import.meta.url), "utf8"));
		expect(manifest.schemaVersion).toBe(1);
		expect(manifest.samples.map((sample: any) => sample.id)).toEqual([
			"docs-only",
			"ui-only",
			"pr-1071",
			"pr-1072",
			"dependency-bump",
			"role-and-tool-inputs",
			"market-pack",
		]);
		for (const sample of manifest.samples) expect(sample.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(manifest.samples.find((sample: any) => sample.id === "docs-only")).toMatchObject({
			expectedPlan: "skip-all",
			syntheticChanges: [{ path: "docs/extension-host-authoring.md" }],
		});
		expect(manifest.samples.find((sample: any) => sample.id === "pr-1071")).toMatchObject({
			expectedPlan: "run-all",
			requireGraphOnlyDiagnostic: true,
		});
		expect(manifest.samples.find((sample: any) => sample.id === "pr-1072")).toMatchObject({ expectedPlan: "bounded" });
		expect(manifest.samples.find((sample: any) => sample.id === "role-and-tool-inputs")).toMatchObject({
			category: "shipped-non-code",
			expectedPlan: "bounded",
		});
		expect(manifest.samples.find((sample: any) => sample.id === "market-pack")).toMatchObject({
			category: "marketplace-pack",
			expectedPlan: "bounded",
		});
	});

	it("extracts only map-owned unit files from historical execution metadata", () => {
		expect(unitInventoryFromMap({
			entries: [
				{ v2Path: UNIT[0], execution: { runner: "vitest", tier: "unit" } },
				{ v2Path: "tests2/browser/example.spec.ts", execution: { runner: "playwright", tier: "browser" } },
			],
			v2Native: [
				{ path: UNIT[1], execution: { runner: "vitest", tier: "unit" } },
				{ path: "tests2/core/e2e.test.ts", execution: { runner: "vitest", tier: "e2e" } },
			],
		})).toEqual([UNIT[0], UNIT[1]]);
	});
});
