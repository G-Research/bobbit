import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	UNIT_FILE_WALL_BUDGET_MS,
	UnitFileBudgetReporter,
} from "../harness/unit-file-budget-reporter.js";

type TestModule = Parameters<UnitFileBudgetReporter["onTestModuleStart"]>[0];

function moduleFor(moduleId: string, project: string): TestModule {
	return { moduleId, project: { name: project } } as unknown as TestModule;
}

function timedReporter() {
	let now = 0;
	const reporter = new UnitFileBudgetReporter(() => now);
	return {
		reporter,
		elapse(testModule: TestModule, durationMs: number) {
			reporter.onTestModuleStart(testModule);
			now += durationMs;
			reporter.onTestModuleEnd(testModule);
		},
	};
}

describe("UnitFileBudgetReporter", () => {
	test("allows every tier-1 project at the exact 15 second boundary", () => {
		const { reporter, elapse } = timedReporter();
		for (const project of ["v2-core", "v2-dom", "v2-integration", "v2-isolated"]) {
			elapse(moduleFor(`/repo/tests2/${project}.test.ts`, project), UNIT_FILE_WALL_BUDGET_MS);
		}

		assert.doesNotThrow(() => reporter.onTestRunEnd());
	});

	test("measures the whole module wall and aggregates repeated executions of one physical file", () => {
		const { reporter, elapse } = timedReporter();
		elapse(moduleFor("C:\\repo\\tests2\\core\\retry.test.ts?first", "v2-core"), 7_500);
		elapse(moduleFor("file:///C:/repo/tests2/core/retry.test.ts?retry", "v2-core"), 7_501);

		assert.throws(
			() => reporter.onTestRunEnd(),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /budget=15000ms/);
				assert.match(error.message, /path=C:\/repo\/tests2\/core\/retry\.test\.ts/);
				assert.match(error.message, /project=v2-core/);
				assert.match(error.message, /duration=15001ms/);
				return true;
			},
		);
	});

	test("reports all over-budget files with path, project, and duration", () => {
		const { reporter, elapse } = timedReporter();
		elapse(moduleFor("/repo/tests2/dom/slow.test.ts", "v2-dom"), 15_250.2);
		elapse(moduleFor("/repo/tests2/integration/slower.test.ts", "v2-integration"), 18_000);

		assert.throws(
			() => reporter.onTestRunEnd(),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /path=\/repo\/tests2\/integration\/slower\.test\.ts project=v2-integration duration=18000ms/);
				assert.match(error.message, /path=\/repo\/tests2\/dom\/slow\.test\.ts project=v2-dom duration=15251ms/);
				return true;
			},
		);
	});

	test("does not create exemptions for additional unit projects", () => {
		const { reporter, elapse } = timedReporter();
		elapse(moduleFor("/repo/tests2/core/future.test.ts", "v2-future-unit"), 15_001);

		assert.throws(
			() => reporter.onTestRunEnd(),
			/project=v2-future-unit duration=15001ms/,
		);
	});

	test("ignores the conditional e2e project", () => {
		const { reporter, elapse } = timedReporter();
		elapse(moduleFor("/repo/tests2/core/team-manager.test.ts", "v2-e2e-vitest"), 60_000);

		assert.doesNotThrow(() => reporter.onTestRunEnd());
	});

	test("resets completed timing aggregates at the start of each run", () => {
		const { reporter, elapse } = timedReporter();
		elapse(moduleFor("/repo/tests2/core/slow.test.ts", "v2-core"), 16_000);
		reporter.onTestRunStart();

		assert.doesNotThrow(() => reporter.onTestRunEnd());
	});
});
