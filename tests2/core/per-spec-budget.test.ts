// Pins the tier-2 per-spec WALL budget classification (scripts/testing-v2/
// assert-budget.mjs): a Playwright JSON report is folded into per-FILE total
// duration (summing every test result, i.e. retries included, across nested
// suites), and files over tiers.tier2.perSpecMaxMs are violations unless
// grandfathered (then warn-only). Pure functions — no fs, no subprocesses.
import { describe, expect, it } from "vitest";
import { evaluatePerSpecBudget, perSpecWallFromReport } from "../../scripts/testing-v2/assert-budget.mjs";

type SyntheticSuite = {
	file?: string;
	suites?: SyntheticSuite[];
	specs?: Array<{ file?: string; tests?: Array<{ results?: Array<{ duration?: number }> }> }>;
};

function spec(file: string, ...durations: number[]) {
	return { file, tests: [{ results: durations.map((duration) => ({ duration })) }] };
}

const report: { suites: SyntheticSuite[] } = {
	suites: [
		// Fast file, single result — well under budget.
		{ file: "e2e/fast.spec.ts", specs: [spec("e2e/fast.spec.ts", 1_000)] },
		// Over budget via RETRIES: two results on one test must be summed.
		{ file: "e2e/retry-slow.spec.ts", specs: [spec("e2e/retry-slow.spec.ts", 40_000, 35_000)] },
		// Over budget, grandfathered.
		{ file: "e2e/grandfathered.spec.ts", specs: [spec("e2e/grandfathered.spec.ts", 90_000)] },
		// Nested describe-suites: specs split across children of the same FILE
		// must aggregate to one per-file total (30k + 35k = 65k > 60k cap).
		{
			file: "e2e/nested.spec.ts",
			suites: [
				{ specs: [spec("e2e/nested.spec.ts", 30_000)] },
				{ suites: [{ specs: [{ tests: [{ results: [{ duration: 35_000 }] }] }] }] },
			],
		},
		// Windows-style separators must normalise to forward slashes.
		{ file: "e2e\\win.spec.ts", specs: [{ file: "e2e\\win.spec.ts", tests: [{ results: [{ duration: 70_000 }] }] }] },
	],
};

const budget = {
	perSpecMaxMs: 60_000,
	perSpecGrandfather: { "e2e/grandfathered.spec.ts": 88_000 },
};

describe("perSpecWallFromReport", () => {
	it("sums per-file durations including retries and nested suites, normalising separators", () => {
		const perFileMs = perSpecWallFromReport(report);
		expect(perFileMs["e2e/fast.spec.ts"]).toBe(1_000);
		expect(perFileMs["e2e/retry-slow.spec.ts"]).toBe(75_000); // 40k + 35k retry
		expect(perFileMs["e2e/nested.spec.ts"]).toBe(65_000); // 30k + 35k across nested suites
		expect(perFileMs["e2e/win.spec.ts"]).toBe(70_000); // backslashes normalised
		expect(Object.keys(perFileMs).sort()).toEqual([
			"e2e/fast.spec.ts",
			"e2e/grandfathered.spec.ts",
			"e2e/nested.spec.ts",
			"e2e/retry-slow.spec.ts",
			"e2e/win.spec.ts",
		]);
	});

	it("tolerates empty/absent report shapes", () => {
		expect(perSpecWallFromReport({})).toEqual({});
		expect(perSpecWallFromReport(null)).toEqual({});
		expect(perSpecWallFromReport({ suites: [{ specs: [] }] })).toEqual({});
	});
});

describe("evaluatePerSpecBudget", () => {
	it("classifies under-budget as pass, grandfathered over-budget as warn, rest as violation", () => {
		const { warns, violations } = evaluatePerSpecBudget(report, budget);
		expect(warns).toEqual([{ file: "e2e/grandfathered.spec.ts", ms: 90_000, grandfatheredMs: 88_000 }]);
		expect(violations.map((v: { file: string }) => v.file)).toEqual([
			"e2e/retry-slow.spec.ts", // 75k, sorted desc
			"e2e/win.spec.ts", // 70k
			"e2e/nested.spec.ts", // 65k
		]);
	});

	it("treats a file exactly at the cap as passing", () => {
		const exact = { suites: [{ file: "e2e/exact.spec.ts", specs: [spec("e2e/exact.spec.ts", 60_000)] }] };
		const { warns, violations } = evaluatePerSpecBudget(exact, budget);
		expect(warns).toEqual([]);
		expect(violations).toEqual([]);
	});

	it("matches grandfather keys written with backslashes", () => {
		const { warns, violations } = evaluatePerSpecBudget(report, {
			perSpecMaxMs: 60_000,
			perSpecGrandfather: { "e2e\\grandfathered.spec.ts": 88_000 },
		});
		expect(warns.map((w: { file: string }) => w.file)).toEqual(["e2e/grandfathered.spec.ts"]);
		expect(violations).toHaveLength(3);
	});

	it("disables the check when perSpecMaxMs is missing or invalid", () => {
		expect(evaluatePerSpecBudget(report, {}).violations).toEqual([]);
		expect(evaluatePerSpecBudget(report, { perSpecMaxMs: 0 }).violations).toEqual([]);
		expect(evaluatePerSpecBudget(report, undefined).violations).toEqual([]);
	});
});
