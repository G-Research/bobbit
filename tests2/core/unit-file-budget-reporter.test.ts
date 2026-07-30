import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
	UNIT_CONCURRENT_PROOF_BANNER,
	UNIT_CONCURRENT_PROOF_ENV,
	UNIT_FILE_WALL_BUDGET_MS,
	UnitFileBudgetReporter,
} from "../harness/unit-file-budget-reporter.js";

type TestModule = Parameters<UnitFileBudgetReporter["onTestModuleStart"]>[0];

function moduleFor(moduleId: string, project: string): TestModule {
	return { moduleId, project: { name: project } } as unknown as TestModule;
}

function timedReporter(options: {
	env?: NodeJS.ProcessEnv;
	output?: (message: string) => void;
} = {}) {
	let now = 0;
	const reporter = new UnitFileBudgetReporter(
		() => now,
		options.env ?? {},
		options.output ?? (() => undefined),
	);
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
	test("allows every tier-1 project at the exact 25 second boundary", () => {
		const { reporter, elapse } = timedReporter();
		for (const project of ["v2-core", "v2-dom", "v2-integration", "v2-isolated"]) {
			elapse(moduleFor(`/repo/tests2/${project}.test.ts`, project), UNIT_FILE_WALL_BUDGET_MS);
		}

		assert.doesNotThrow(() => reporter.onTestRunEnd());
	});

	test("hard-fails by default after measuring the whole module wall and aggregating retries", () => {
		const { reporter, elapse } = timedReporter();
		elapse(moduleFor("C:\\repo\\tests2\\core\\retry.test.ts?first", "v2-core"), 12_500);
		elapse(moduleFor("file:///C:/repo/tests2/core/retry.test.ts?retry", "v2-core"), 12_501);

		assert.throws(
			() => reporter.onTestRunEnd(),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /budget=25000ms/);
				assert.match(error.message, /path=C:\/repo\/tests2\/core\/retry\.test\.ts/);
				assert.match(error.message, /project=v2-core/);
				assert.match(error.message, /duration=25001ms/);
				return true;
			},
		);
	});

	test("reports all over-budget files with path, project, and duration", () => {
		const { reporter, elapse } = timedReporter();
		elapse(moduleFor("/repo/tests2/dom/slow.test.ts", "v2-dom"), 25_250.2);
		elapse(moduleFor("/repo/tests2/integration/slower.test.ts", "v2-integration"), 28_000);

		assert.throws(
			() => reporter.onTestRunEnd(),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /path=\/repo\/tests2\/integration\/slower\.test\.ts project=v2-integration duration=28000ms/);
				assert.match(error.message, /path=\/repo\/tests2\/dom\/slow\.test\.ts project=v2-dom duration=25251ms/);
				return true;
			},
		);
	});

	test("reports every wall-budget overrun without throwing in explicit concurrent proof mode", () => {
		const output: string[] = [];
		const { reporter, elapse } = timedReporter({
			env: { [UNIT_CONCURRENT_PROOF_ENV]: "1" },
			output: message => output.push(message),
		});
		reporter.onTestRunStart();
		elapse(moduleFor("/repo/tests2/dom/slow.test.ts", "v2-dom"), 25_250.2);
		elapse(moduleFor("/repo/tests2/integration/slower.test.ts", "v2-integration"), 28_000);

		assert.doesNotThrow(() => reporter.onTestRunEnd());
		assert.equal(output[0], UNIT_CONCURRENT_PROOF_BANNER);
		assert.equal(output.length, 2);
		assert.match(output[1], /CONCURRENT PROOF MODE/);
		assert.match(output[1], /do not qualify as solo unit-stage evidence/);
		assert.match(output[1], /path=\/repo\/tests2\/integration\/slower\.test\.ts project=v2-integration duration=28000ms/);
		assert.match(output[1], /path=\/repo\/tests2\/dom\/slow\.test\.ts project=v2-dom duration=25251ms/);
		assert.match(output[1], /suite and test failures remain authoritative/);
	});

	test("requires the exact proof-mode opt-in value", () => {
		const { reporter, elapse } = timedReporter({
			env: { [UNIT_CONCURRENT_PROOF_ENV]: "true" },
		});
		elapse(moduleFor("/repo/tests2/core/slow.test.ts", "v2-core"), 25_001);

		assert.throws(() => reporter.onTestRunEnd(), /duration=25001ms/);
	});

	test("does not create exemptions for additional unit projects", () => {
		const { reporter, elapse } = timedReporter();
		elapse(moduleFor("/repo/tests2/core/future.test.ts", "v2-future-unit"), 25_001);

		assert.throws(
			() => reporter.onTestRunEnd(),
			/project=v2-future-unit duration=25001ms/,
		);
	});

	test("ignores the conditional e2e project", () => {
		const { reporter, elapse } = timedReporter();
		elapse(moduleFor("/repo/tests2/core/team-manager.test.ts", "v2-e2e-vitest"), 60_000);

		assert.doesNotThrow(() => reporter.onTestRunEnd());
	});

	test("resets completed timing aggregates at the start of each run", () => {
		const { reporter, elapse } = timedReporter();
		elapse(moduleFor("/repo/tests2/core/slow.test.ts", "v2-core"), 26_000);
		reporter.onTestRunStart();

		assert.doesNotThrow(() => reporter.onTestRunEnd());
	});

	test("leaves the standard unit command and Vitest execution controls independent of proof mode", () => {
		const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
		assert.equal(
			packageJson.scripts["test:unit"],
			"vitest run --config vitest.config.ts --silent=passed-only",
		);

		const config = readFileSync(new URL("../../vitest.config.ts", import.meta.url), "utf8");
		assert.doesNotMatch(config, new RegExp(UNIT_CONCURRENT_PROOF_ENV));
		assert.match(config, /export const FIXED_UNIT_WORKERS = 3/);
		assert.match(config, /retry: 3/);
	});
});
