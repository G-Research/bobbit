import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
	applyHistoricalCompatibility,
	attributeFullRunFailures,
	buildAuditReport,
	compareSelectionEvidence,
	computeHistoricalPlan,
	createQualificationEnvironment,
	graphOnlyDiagnostic,
	historicalCompatibilityReport,
	isDocumentationOnly,
	normalizeSelectionPlan,
	npmInvocation,
	orchestrateHistoricalSelection,
	parseVitestReport,
	renderAuditReport,
	summarizeQualification,
	tombstonesForChanges,
	unitInventoryFromMap,
	validateVitestEvidence,
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
const EXTRA_UNIT = "tests2/core/unexpected.test.ts";
let fixtureParent: string;

function evidence(observed: string[], failures: string[] = []) {
	return { observed, failures };
}

function expectEvidenceError(action: () => unknown, expected: string[]) {
	try {
		action();
		throw new Error("expected validator to reject evidence");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		for (const item of expected) expect(message).toContain(item);
	}
}

function revisionFixture(label: string, files: string[] = UNIT): string {
	const root = createRunChild(label);
	for (const file of files) {
		const absolute = resolve(root, ...file.split("/"));
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, "export {};\n", "utf8");
	}
	return root;
}

function compatibilityGraph(root: string, testFiles: string[], issues: Record<string, string[]> = {}) {
	return {
		repoRoot: root,
		testFiles,
		meta: {
			impactValidation: { issues: issues.impact ?? [] },
			repositoryScanValidation: { issues: issues.scan ?? [] },
			indirectRepositoryReadValidation: { issues: issues.indirect ?? [] },
			unresolvedRepositoryReadAudit: { issues: issues.unresolved ?? [] },
			dynamicExecutableConsumerAudit: { issues: issues.dynamic ?? [] },
		},
	};
}

function historicalInventory(label: string, count: number): string[] {
	return Array.from({ length: count }, (_, index) =>
		`tests2/core/${label}-${String(index + 1).padStart(4, "0")}.test.ts`);
}

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

	it("requires direct, native-observed, and newly attributed failing tests while allowing over-selection", () => {
		const safe = compareSelectionEvidence({
			selected: [UNIT[0], UNIT[1], UNIT[2]],
			directChangedUnit: [UNIT[0]],
			nativeChangedObserved: [UNIT[1]],
			fullRunFailures: [UNIT[2]],
			baselineRunFailures: [UNIT[2]],
		});
		expect(safe).toMatchObject({
			fullRunFailures: [UNIT[2]],
			baselineRunFailures: [UNIT[2]],
			attributedFullRunFailures: [],
			required: [UNIT[0], UNIT[1]],
			underSelected: [],
			overSelected: [UNIT[2]],
			safe: true,
		});

		const unsafe = compareSelectionEvidence({
			selected: [UNIT[0]],
			directChangedUnit: [UNIT[0]],
			nativeChangedObserved: [UNIT[1]],
			fullRunFailures: [UNIT[0], UNIT[2]],
			baselineRunFailures: [UNIT[0]],
		});
		expect(unsafe.attributedFullRunFailures).toEqual([UNIT[2]]);
		expect(unsafe.underSelected).toEqual([UNIT[1], UNIT[2]]);
		expect(unsafe.safe).toBe(false);
	});

	it("subtracts clean baseline failures but retains failures newly present in the changed run", async () => {
		const attributed = await attributeFullRunFailures({
			fullRunFailures: [UNIT[0], UNIT[2]],
			runBaseline: async () => ({
				code: 1,
				evidence: { observed: UNIT, failures: [UNIT[0]] },
			}),
		});
		expect(attributed).toMatchObject({
			baselineRan: true,
			fullRunFailures: [UNIT[0], UNIT[2]],
			baselineRunFailures: [UNIT[0]],
			attributedFullRunFailures: [UNIT[2]],
		});
	});

	it("fails closed when a non-zero baseline has no named failing-test evidence", async () => {
		await expect(attributeFullRunFailures({
			fullRunFailures: [UNIT[0]],
			label: "fixture baseline",
			runBaseline: async () => ({
				code: 1,
				evidence: { observed: UNIT, failures: [] },
			}),
		})).rejects.toThrow("fixture baseline: baseline full unit run exited 1 without named failing-test evidence");
	});

	it("rejects a partial clean-baseline report before it can subtract a changed-run failure", async () => {
		await expect(attributeFullRunFailures({
			fullRunFailures: [UNIT[0]],
			label: "fixture baseline",
			runBaseline: async () => ({
				code: 1,
				evidence: evidence([UNIT[0], UNIT[1]], [UNIT[0]]),
				unitInventory: UNIT,
			}),
		})).rejects.toThrow(`missing (1): ${UNIT[2]}`);
	});

	it("does not run an extra baseline when the changed full run has no failures", async () => {
		const runBaseline = vi.fn();
		const attributed = await attributeFullRunFailures({
			fullRunFailures: [],
			runBaseline,
		});
		expect(runBaseline).not.toHaveBeenCalled();
		expect(attributed).toEqual({
			baselineRan: false,
			fullRunFailures: [],
			baselineRunFailures: [],
			attributedFullRunFailures: [],
			baseline: undefined,
		});
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

		const skipped = parseVitestReport({
			testResults: [{ name: resolve(repoRoot, UNIT[0]), status: "skipped", assertionResults: [{ status: "skipped" }] }],
		}, repoRoot);
		expect(skipped.observed).toEqual([UNIT[0]]);
		expect(skipped.failures).toEqual([]);
		expect(() => parseVitestReport({}, repoRoot)).toThrow("missing testResults");
	});

	it("validates full Vitest reports against exact revision inventory and exit consistency", () => {
		expectEvidenceError(() => validateVitestEvidence({
			evidence: evidence([UNIT[0], UNIT[1]]),
			exitCode: 0,
			unitInventory: UNIT,
			mode: "full",
			label: "changed full",
		}), ["changed full: Vitest JSON inventory mismatch", "missing (1)", UNIT[2], "unexpected (0)"]);

		expectEvidenceError(() => validateVitestEvidence({
			evidence: evidence([UNIT[0], UNIT[1]], [UNIT[1]]),
			exitCode: 1,
			unitInventory: UNIT,
			mode: "full",
			label: "partial failing full",
		}), ["partial failing full: Vitest JSON inventory mismatch", UNIT[2], "unexpected (0)"]);

		expectEvidenceError(() => validateVitestEvidence({
			evidence: evidence([...UNIT, EXTRA_UNIT]),
			exitCode: 0,
			unitInventory: UNIT,
			mode: "full",
			label: "unexpected report file",
		}), ["unexpected report file: Vitest JSON inventory mismatch", "missing (0)", "unexpected (1)", EXTRA_UNIT]);

		expectEvidenceError(() => validateVitestEvidence({
			evidence: evidence(UNIT, [UNIT[1]]),
			exitCode: 0,
			unitInventory: UNIT,
			mode: "full",
			label: "clean exit with failure",
		}), ["clean exit with failure report names failures despite exit code 0", UNIT[1]]);

		expectEvidenceError(() => validateVitestEvidence({
			evidence: evidence(UNIT),
			exitCode: 2,
			unitInventory: UNIT,
			mode: "full",
			label: "crashed full",
		}), ["crashed full exited 2 without named failing-test evidence"]);
	});

	it("validates native Vitest reports as revision-owned subsets with exit consistency", () => {
		expect(validateVitestEvidence({
			evidence: evidence([UNIT[2]], [UNIT[2]]),
			exitCode: 1,
			unitInventory: UNIT,
			mode: "native",
			label: "native failing subset",
		})).toMatchObject({ observed: [UNIT[2]], failures: [UNIT[2]] });

		expectEvidenceError(() => validateVitestEvidence({
			evidence: evidence([UNIT[0]]),
			exitCode: 1,
			unitInventory: UNIT,
			mode: "native",
			label: "native crash",
		}), ["native crash exited 1 without named failing-test evidence"]);

		expectEvidenceError(() => validateVitestEvidence({
			evidence: evidence([UNIT[0]], [UNIT[0]]),
			exitCode: 0,
			unitInventory: UNIT,
			mode: "native",
			label: "native clean exit with failure",
		}), ["native clean exit with failure report names failures despite exit code 0", UNIT[0]]);

		expectEvidenceError(() => validateVitestEvidence({
			evidence: evidence([EXTRA_UNIT]),
			exitCode: 0,
			unitInventory: UNIT,
			mode: "native",
			label: "native wrong revision",
		}), ["native wrong revision: Vitest JSON inventory mismatch", "unexpected (1)", EXTRA_UNIT]);
	});

	it("validates changed and parent revision inventories independently", async () => {
		const changedInventory = [UNIT[0], UNIT[1], EXTRA_UNIT];
		const parentInventory = [UNIT[0], UNIT[2]];
		expect(validateVitestEvidence({
			evidence: evidence(changedInventory, [EXTRA_UNIT]),
			exitCode: 1,
			unitInventory: changedInventory,
			mode: "full",
			label: "changed revision full",
		}).validation).toMatchObject({ expectedCount: 3, observedCount: 3, missing: [], unexpected: [] });

		const attributed = await attributeFullRunFailures({
			fullRunFailures: [EXTRA_UNIT],
			label: "parent revision baseline",
			runBaseline: async () => ({
				code: 1,
				evidence: evidence(parentInventory, [UNIT[2]]),
				unitInventory: parentInventory,
			}),
		});
		expect(attributed.baselineRunFailures).toEqual([UNIT[2]]);
		expect(attributed.attributedFullRunFailures).toEqual([EXTRA_UNIT]);
	});

	it("cleans an invocation-owned root after fake full runners write partial JSON evidence", async () => {
		let changedRoot = "";
		await expect(withOwnedQualificationRoot(async (root: string) => {
			changedRoot = root;
			const reportPath = resolve(root, "runs", "changed-full-unit.json");
			await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(resolve(root, "runs"), { recursive: true })
				.then(() => writeFile(reportPath, JSON.stringify({ testResults: [
					{ name: resolve(root, UNIT[0]), status: "passed", assertionResults: [] },
				] }), "utf8")));
			const parsed = parseVitestReport(JSON.parse(readFileSync(reportPath, "utf8")), root);
			validateVitestEvidence({
				evidence: parsed,
				exitCode: 0,
				unitInventory: UNIT,
				mode: "full",
				label: "fake changed full runner",
			});
		}, { parent: fixtureParent })).rejects.toThrow(`missing (2): ${UNIT[1]}, ${UNIT[2]}`);
		expect(existsSync(changedRoot)).toBe(false);

		let baselineRoot = "";
		await expect(withOwnedQualificationRoot(async (root: string) => {
			baselineRoot = root;
			await attributeFullRunFailures({
				fullRunFailures: [UNIT[0]],
				label: "fake baseline runner",
				runBaseline: async () => ({
					code: 1,
					evidence: evidence([UNIT[0]], [UNIT[0]]),
					unitInventory: UNIT,
				}),
			});
		}, { parent: fixtureParent })).rejects.toThrow(`missing (2): ${UNIT[1]}, ${UNIT[2]}`);
		expect(existsSync(baselineRoot)).toBe(false);
		expect(existsSync(fixtureParent)).toBe(true);
	});

	it("passes exact delete and rename-old paths to revision graph tombstones", () => {
		expect(tombstonesForChanges([
			{ status: "M", path: "src/modified.ts" },
			{ status: "D", path: "src/deleted.ts" },
			{ status: "d", path: "src/windows\\deleted.ts" },
			{ status: "R100", oldPath: "src/renamed-old.ts", path: "src/renamed-new.ts" },
			{ status: "C100", oldPath: "src/copied-old.ts", path: "src/copied-new.ts" },
		])).toEqual([
			"src/deleted.ts",
			"src/renamed-old.ts",
			"src/windows/deleted.ts",
		]);
	});

	it("ignores a future declaration only while its path is absent from the exact revision", () => {
		const root = revisionFixture("affected-compat-absent");
		const futureOwner = "src/server/future-selector-owner.ts";
		const issue = `future-rule: production owner is missing: ${futureOwner}`;
		try {
			const absent = historicalCompatibilityReport(
				compatibilityGraph(root, UNIT, { impact: [issue] }),
				{ repoRoot: root, unitInventory: UNIT },
			);
			expect(absent.escalated).toBe(false);
			expect(absent.ignoredIssues).toEqual([{
				source: "impact",
				issue,
				disposition: "ignored-absent-declaration",
				paths: [futureOwner],
			}]);

			const liveOwner = resolve(root, ...futureOwner.split("/"));
			mkdirSync(dirname(liveOwner), { recursive: true });
			writeFileSync(liveOwner, "export {};\n", "utf8");
			const present = historicalCompatibilityReport(
				compatibilityGraph(root, UNIT, { impact: [issue] }),
				{ repoRoot: root, unitInventory: UNIT },
			);
			expect(present.ignoredIssues).toEqual([]);
			expect(present.escalated).toBe(true);
			expect(present.escalationIssues).toEqual([expect.objectContaining({
				source: "impact",
				issue,
				disposition: "run-all",
				reason: "unclassifiable live inventory or ownership issue",
			})]);
		} finally {
			removeOwnedRunChild(root);
		}
	});

	it("quarantines exact live audit consumers only into non-doc bounded plans", () => {
		const root = revisionFixture("affected-compat-quarantine");
		try {
			const unresolvedIssue = `${UNIT[1]}: unresolved repository read differs from current declaration`;
			const dynamicIssue = `${UNIT[2]}: dynamic executable operation differs from current declaration`;
			const compatibility = historicalCompatibilityReport(
				compatibilityGraph(root, UNIT, { unresolved: [unresolvedIssue], dynamic: [dynamicIssue] }),
				{ repoRoot: root, unitInventory: UNIT },
			);
			expect(compatibility.escalated).toBe(false);
			expect(compatibility.quarantinedTests).toEqual([UNIT[1], UNIT[2]]);
			expect(compatibility.quarantineIssues).toEqual([
				expect.objectContaining({ source: "unresolved-reader", disposition: "quarantine", test: UNIT[1] }),
				expect.objectContaining({ source: "dynamic-operation", disposition: "quarantine", test: UNIT[2] }),
			]);

			const bounded = {
				kind: "bounded",
				cachePolicy: "eligible",
				selected: [UNIT[0]],
				browserAffected: [],
				reasons: ["fixture closure"],
				unmapped: [],
			};
			expect(applyHistoricalCompatibility(bounded, compatibility, UNIT)).toMatchObject({
				kind: "bounded",
				cachePolicy: "eligible",
				selected: UNIT,
				compatibilityBaseSelectedCount: 1,
				compatibilityAddedTests: [UNIT[1], UNIT[2]],
			});
			expect(applyHistoricalCompatibility(bounded, compatibility, UNIT, { documentationOnly: true })).toMatchObject({
				kind: "bounded",
				cachePolicy: "eligible",
				selected: [UNIT[0]],
			});

			const preexistingRunAll = applyHistoricalCompatibility({
				...bounded,
				kind: "run-all",
				cachePolicy: "bypass",
				selected: UNIT,
			}, compatibility, UNIT);
			expect(preexistingRunAll).toMatchObject({ kind: "run-all", cachePolicy: "bypass", selected: UNIT });
		} finally {
			removeOwnedRunChild(root);
		}
	});

	it("escalates live inventory, opaque audit, graph, and ownership drift to the exact revision inventory", () => {
		const root = revisionFixture("affected-compat-escalate", [...UNIT, EXTRA_UNIT]);
		try {
			const liveInventory = historicalCompatibilityReport(
				compatibilityGraph(root, UNIT, { impact: ["defaults/new-family/config.yaml: shipped input has no declared impact family"] }),
				{ repoRoot: root, unitInventory: UNIT },
			);
			const opaqueAudit = historicalCompatibilityReport(
				compatibilityGraph(root, UNIT, { dynamic: ["opaque live dynamic-operation drift"] }),
				{ repoRoot: root, unitInventory: UNIT },
			);
			const graphFailure = historicalCompatibilityReport(undefined, {
				repoRoot: root,
				unitInventory: UNIT,
				graphIssues: ["synthetic graph construction failure"],
			});
			for (const report of [liveInventory, opaqueAudit, graphFailure]) expect(report.escalated).toBe(true);
			expect(liveInventory.escalationIssues[0]).toMatchObject({ source: "impact", disposition: "run-all" });
			expect(opaqueAudit.escalationIssues[0]).toMatchObject({
				source: "dynamic-operation",
				disposition: "run-all",
				reason: "unclassifiable live audit issue",
			});
			expect(graphFailure.escalationIssues[0]).toMatchObject({
				source: "graph",
				disposition: "run-all",
				reason: "historical graph construction failed",
			});

			const ownershipMismatch = historicalCompatibilityReport(
				compatibilityGraph(root, [UNIT[0], EXTRA_UNIT]),
				{ repoRoot: root, unitInventory: UNIT },
			);
			expect(ownershipMismatch.escalationIssues).toEqual([expect.objectContaining({
				source: "ownership",
				disposition: "run-all",
				reason: "revision unit ownership mismatch",
				missingFromGraph: [UNIT[1], UNIT[2]],
				unexpectedInGraph: [EXTRA_UNIT],
			})]);
			const escalatedPlan = applyHistoricalCompatibility({
				kind: "bounded",
				cachePolicy: "eligible",
				selected: [UNIT[0], EXTRA_UNIT],
				browserAffected: [],
				reasons: ["fixture closure"],
				unmapped: [],
			}, ownershipMismatch, UNIT);
			expect(escalatedPlan).toMatchObject({
				kind: "run-all",
				cachePolicy: "bypass",
				selected: UNIT,
				compatibilityEscalated: true,
			});
			expect(escalatedPlan.selected).not.toContain(EXTRA_UNIT);
		} finally {
			removeOwnedRunChild(root);
		}
	});

	it("propagates classification, compatibility, and selector failures after a revision graph is built", async () => {
		const root = revisionFixture("affected-orchestration-errors");
		const graph = {
			...compatibilityGraph(root, UNIT),
			srcToTests: new Map(),
		};
		const compatibility = {
			quarantinedTests: [],
			escalated: false,
			escalationIssues: [],
		};
		const base = {
			buildGraph: () => graph,
			affectedTests: () => ({
				kind: "bounded",
				cachePolicy: "eligible",
				affected: new Set([UNIT[0]]),
			}),
			changes: [{ status: "M", path: "src/example.ts" }],
			unitInventory: UNIT,
			repoRoot: root,
			revision: "a".repeat(40),
			executionMapLoaderFactory: async () => () => undefined,
			documentationClassifier: () => false,
			compatibilityReporter: () => compatibility,
		};
		try {
			await expect(orchestrateHistoricalSelection({
				...base,
				documentationClassifier: () => { throw new Error("classification failed"); },
			})).rejects.toThrow("classification failed");
			await expect(orchestrateHistoricalSelection({
				...base,
				compatibilityReporter: () => { throw new Error("compatibility failed"); },
			})).rejects.toThrow("compatibility failed");
			await expect(orchestrateHistoricalSelection({
				...base,
				affectedTests: () => { throw new Error("selector failed"); },
			})).rejects.toThrow("selector failed");
		} finally {
			removeOwnedRunChild(root);
		}
	});

	it("retains RUN-ALL only for graph construction incompatibility and a declared selector result", async () => {
		const root = revisionFixture("affected-orchestration-run-all");
		const changes = [{ status: "M", path: "vitest.config.ts" }];
		const selector = vi.fn(() => ({
			kind: "run-all",
			cachePolicy: "bypass",
			affected: new Set([UNIT[0]]),
			reasons: ["Vitest configuration changed: vitest.config.ts"],
		}));
		const common = {
			changes,
			unitInventory: UNIT,
			repoRoot: root,
			revision: "b".repeat(40),
			executionMapLoaderFactory: async () => () => undefined,
		};
		try {
			const graphFallbackSelector = vi.fn(() => {
				throw new Error("selector must not run without a graph");
			});
			const graphFallback = await orchestrateHistoricalSelection({
				...common,
				buildGraph: () => { throw new Error("historical graph syntax unsupported"); },
				affectedTests: graphFallbackSelector,
			});
			expect(graphFallbackSelector).not.toHaveBeenCalled();
			expect(graphFallback).toMatchObject({
				documentationOnly: false,
				computed: {
					plan: {
						kind: "run-all",
						cachePolicy: "bypass",
						selected: UNIT,
					},
					graphOnlyDiagnostic: undefined,
				},
			});
			expect(graphFallback.compatibility.escalationIssues).toEqual([
				expect.objectContaining({ source: "graph", disposition: "run-all" }),
			]);

			const graph = {
				...compatibilityGraph(root, UNIT),
				srcToTests: new Map([["vitest.config.ts", new Set(UNIT)]]),
			};
			const declaredRunAll = await orchestrateHistoricalSelection({
				...common,
				buildGraph: () => graph,
				affectedTests: selector,
				documentationClassifier: () => false,
			});
			expect(selector).toHaveBeenCalledOnce();
			expect(declaredRunAll.computed.plan).toMatchObject({
				kind: "run-all",
				cachePolicy: "bypass",
				selected: UNIT,
				reasons: ["Vitest configuration changed: vitest.config.ts"],
			});
			expect(declaredRunAll.computed.graphOnlyDiagnostic).toMatchObject({
				executable: false,
				selected: UNIT,
			});
		} finally {
			removeOwnedRunChild(root);
		}
	});

	it("pins measured #1071 and #1072 counts at the pure exact-revision plan seam", async () => {
		// The real plan-only probe (no npm install/full run) measured these immutable
		// revisions. The unit seam pins the result without spawning Git from tier 1.
		const revision1071 = "7a42e234caaf5c93771c17bbfc9582781139729b";
		const unit1071 = historicalInventory("pr-1071", 991);
		const plan1071 = await computeHistoricalPlan({
			graph: { srcToTests: new Map([["vitest.config.ts", new Set(unit1071)]]) },
			affectedTests: () => ({
				kind: "run-all",
				cachePolicy: "bypass",
				affected: new Set(unit1071.slice(0, 10)),
				reasons: ["Vitest configuration changed: vitest.config.ts"],
			}),
			changes: [{ status: "M", path: "vitest.config.ts" }],
			unitInventory: unit1071,
			compatibility: { quarantinedTests: unit1071.slice(-9), escalated: false, escalationIssues: [] },
			provenance: { revision: revision1071, repoRoot: "revision-1071", unitTotal: unit1071.length },
		});
		expect(plan1071.plan).toMatchObject({
			kind: "run-all",
			cachePolicy: "bypass",
			selected: unit1071,
			provenance: { revision: revision1071, repoRoot: "revision-1071", unitTotal: 991 },
		});
		expect(plan1071.graphOnlyDiagnostic).toMatchObject({ executable: false, selected: unit1071 });

		const revision1072 = "3d99218c57344cd0d7763a720b5d2634d11cc7b4";
		const unit1072 = historicalInventory("pr-1072", 1004);
		const baseSelected1072 = unit1072.slice(0, 556);
		const quarantined1072 = unit1072.slice(556, 565);
		const plan1072 = await computeHistoricalPlan({
			graph: { srcToTests: new Map([["src/server/server.ts", new Set(unit1072.slice(0, 555))]]) },
			affectedTests: () => ({
				kind: "bounded",
				cachePolicy: "eligible",
				affected: new Set([...baseSelected1072, EXTRA_UNIT]),
				reasons: ["static dependency closure"],
			}),
			changes: [{ status: "M", path: "src/server/server.ts" }],
			unitInventory: unit1072,
			compatibility: { quarantinedTests: quarantined1072, escalated: false, escalationIssues: [] },
			provenance: { revision: revision1072, repoRoot: "revision-1072", unitTotal: unit1072.length },
		});
		expect(plan1072.plan).toMatchObject({
			kind: "bounded",
			cachePolicy: "eligible",
			compatibilityBaseSelectedCount: 556,
			compatibilityAddedTests: quarantined1072,
			provenance: { revision: revision1072, repoRoot: "revision-1072", unitTotal: 1004 },
		});
		expect(plan1072.plan.selected).toHaveLength(565);
		expect(plan1072.plan.selected).not.toContain(EXTRA_UNIT);
		expect(plan1072.graphOnlyDiagnostic?.selected).toHaveLength(555);
	});

	it("reports graph-only selection as explicitly non-executable with an accurate scope", () => {
		const graph = {
			srcToTests: new Map([
				["src/shared/runtime.ts", new Set([UNIT[0], "tests2/browser/advisory.spec.ts"])],
				["tests2/harness/suite-setup.ts", new Set(UNIT)],
			]),
		};
		const diagnostic = graphOnlyDiagnostic(graph, [{
			status: "M",
			path: "src\\shared\\runtime.ts",
		}], UNIT);
		expect(diagnostic).toEqual({
			executable: false,
			label: "graph-only diagnostic (bounded static closure; broad triggers ignored; never executed)",
			selected: [UNIT[0]],
		});
		expect(graphOnlyDiagnostic(graph, [{
			status: "M",
			path: "tests2/harness/suite-setup.ts",
		}], UNIT)).toMatchObject({
			executable: false,
			label: "graph-only diagnostic (full unit closure; broad triggers ignored; never executed)",
			selected: UNIT,
		});
	});

	it("uses runner documentation classification for nested docs and graph-owned Markdown", () => {
		const graph = {
			testFiles: UNIT,
			testDeps: new Map(UNIT.map((test) => [test, new Set()])),
			browserDeps: new Map(),
			srcToTests: new Map([
				["defaults/system-prompt.md", new Set([UNIT[0]])],
				[".claude/skills/release/SKILL.md", new Set([UNIT[0]])],
				[".bobbit/config/example/README.md", new Set([UNIT[1]])],
				["market-packs/example/README.md", new Set([UNIT[2]])],
			]),
			srcToBrowser: new Map(),
			meta: {},
		};
		const nestedReadme = [{
			path: "packages/widget/README.fr.md",
			oldPath: "packages/legacy-widget/README.md",
			status: "R100",
		}];
		const documentationOnly = isDocumentationOnly(graph, nestedReadme);
		expect(documentationOnly).toBe(true);
		expect(summarizeQualification([{
			id: "nested-readme",
			documentationOnly,
			plan: { kind: "skip-all", selected: [] },
			timings: { selectionMs: 1 },
		}] as any[])).toMatchObject({ suspiciousZero: [], safe: true });

		for (const path of [
			"defaults/system-prompt.md",
			".claude/skills/release/SKILL.md",
			".bobbit/config/example/README.md",
			"market-packs/example/README.md",
		]) {
			expect(isDocumentationOnly(graph, [{ path, status: "M" }]), path).toBe(false);
		}
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

	it("renders commit, plan, commands, failure attribution, exit codes, discrepancies, and timings", () => {
		const evidence = compareSelectionEvidence({
			selected: UNIT,
			nativeChangedObserved: [UNIT[0]],
			fullRunFailures: [UNIT[1]],
			baselineRunFailures: [UNIT[1]],
		});
		const historicalRoot = resolve(fixtureParent, "historical-revision-root");
		const ignoredCompatibilityIssue = {
			source: "impact",
			issue: "future owner is absent",
			disposition: "ignored-absent-declaration",
		};
		const quarantineCompatibilityIssue = {
			source: "dynamic-operation",
			issue: `${UNIT[2]}: dynamic operation drift`,
			disposition: "quarantine",
			test: UNIT[2],
		};
		const row = {
			id: "sample",
			commit: "a".repeat(40),
			parent: "b".repeat(40),
			subject: "fixture",
			documentationOnly: false,
			changedInputs: [{ status: "M", path: "src/example.ts" }],
			plan: {
				kind: "bounded",
				cachePolicy: "eligible",
				selected: UNIT,
				reasons: ["closure"],
				compatibilityAddedTests: [UNIT[2]],
				provenance: {
					revision: "a".repeat(40),
					repoRoot: historicalRoot,
					unitTotal: UNIT.length,
					testMap: "tests2/tests-map.json",
					tombstones: ["src/deleted.ts", "src/renamed-old.ts"],
				},
			},
			compatibility: {
				issues: [ignoredCompatibilityIssue, quarantineCompatibilityIssue],
				ignoredIssues: [ignoredCompatibilityIssue],
				quarantinedTests: [UNIT[2]],
				escalated: false,
				escalationIssues: [],
			},
			graphOnlyDiagnostic: undefined,
			failureBaseline: { ran: true, revision: "c".repeat(40) },
			commands: {
				nativeChanged: "vitest --changed parent",
				fullUnit: "npm run test:unit -- --retry=0",
				baselineCheckout: "git checkout baseline",
				baselineInstall: "npm ci",
				baselineFullUnit: "npm run test:unit baseline",
			},
			exitCodes: { nativeChanged: 0, fullUnit: 1, baselineCheckout: 0, baselineInstall: 0, baselineFullUnit: 1 },
			timings: {
				selectionMs: 1,
				installMs: 2,
				nativeChangedMs: 3,
				fullUnitMs: 4,
				baselineCheckoutMs: 5,
				baselineInstallMs: 6,
				baselineFullUnitMs: 7,
			},
			evidence,
		};
		const report = buildAuditReport([row], { generatedAt: "2026-01-01T00:00:00.000Z" });
		const text = renderAuditReport(report);
		for (const expected of [
			row.commit,
			"changed inputs (1): src/example.ts",
			"executable plan: bounded; cache=eligible; selected=3",
			`plan provenance: revision=${row.commit}; root=${historicalRoot}; unit-total=3; test-map=tests2/tests-map.json; tombstones=src/deleted.ts, src/renamed-old.ts`,
			"historical compatibility: issues=2; ignored-absent=1; quarantined=1; escalated=false",
			`compatibility quarantined tests (1): ${UNIT[2]}`,
			`compatibility plan additions (1): ${UNIT[2]}`,
			row.commands.nativeChanged,
			row.commands.fullUnit,
			"failure baseline: cccccccccccccccccccccccccccccccccccccccc",
			row.commands.baselineInstall,
			row.commands.baselineFullUnit,
			"exit codes: native=0, full=1, baseline-checkout=0, baseline-install=0, baseline-full=1",
			`full failures (1): ${UNIT[1]}`,
			`baseline failures (1): ${UNIT[1]}`,
			"attributed failures (0): (none)",
			"under-selected (0)",
			"over-selected (2)",
			"selection=1, install=2, native=3, full=4, baseline-checkout=5, baseline-install=6, baseline-full=7",
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
