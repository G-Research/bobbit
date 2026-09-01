import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { discoverTests } from "../../../scripts/testing-v2/test-discovery.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
	scripts: Record<string, string>;
};

const RETIRED_IMPLEMENTATION = [
	"README.md",
	"cache.mjs",
	"classification.mjs",
	"correctness-sample.json",
	"correctness-vs-main.mjs",
	"graph.mjs",
	"impact-rules.mjs",
	"proof-vs-main.mjs",
	"run.mjs",
	"runner.mjs",
] as const;

const RETIRED_MAP_FILES = [
	"scripts/testing-v2/test-map-execution.mjs",
	"scripts/testing-v2/gen-inventory.mjs",
	"scripts/testing-v2/codemod.mjs",
	"scripts/testing-v2/lib-census.mjs",
	"scripts/testing-v2/check-inventory.mjs",
	"scripts/testing-v2/unit-inventory-audit.mjs",
	"scripts/testing-v2/unit-declaration-semantic-map.json",
] as const;

function repoPath(...parts: string[]): string {
	return resolve(REPO_ROOT, ...parts);
}

describe("complete test lane entrypoints", () => {
	it("keeps the retired selector, graph, audit, impact inventory, cache, and proof sources absent", () => {
		assert.equal(existsSync(repoPath("scripts", "affected")), false);
		for (const file of RETIRED_IMPLEMENTATION) {
			assert.equal(existsSync(repoPath("scripts", "affected", file)), false, `${file} must stay retired`);
		}
	});

	it("keeps retired package and inventory entrypoints absent", () => {
		assert.deepEqual(
			Object.keys(packageJson.scripts).filter((name) => /^test:affected(?::|$)/.test(name)),
			[],
		);
		assert.equal("test:unit:inventory" in packageJson.scripts, false);
		for (const path of RETIRED_MAP_FILES) assert.equal(existsSync(repoPath(...path.split("/"))), false, `${path} must stay retired`);
		const discovery = discoverTests();
		assert.equal(discovery.canonical, discovery.all);
	});

	it("dispatches the existing complete lanes and aggregate exactly", () => {
		assert.deepEqual(
			{
				unit: packageJson.scripts["test:unit"],
				browser: packageJson.scripts["test:browser"],
				browserLane: packageJson.scripts["test:v2:browser"],
				e2e: packageJson.scripts["test:e2e"],
				e2eLane: packageJson.scripts["test:e2e:v2"],
				manual: packageJson.scripts["test:manual"],
				aggregate: packageJson.scripts.test,
			},
			{
				unit: "vitest run --config vitest.config.ts --silent=passed-only",
				browser: "npm run test:v2:browser --",
				browserLane: "node scripts/testing-v2/run-browser-v2.mjs",
				e2e: "npm run test:e2e:v2",
				e2eLane: "node scripts/testing-v2/ensure-dist.mjs && node scripts/testing-v2/run-e2e-v2.mjs",
				manual: "npm run build && npx playwright test --config playwright-manual.config.ts",
				aggregate: "npm run test:unit && npm run test:browser && npm run test:e2e",
			},
		);
	});
});
