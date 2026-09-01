import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import {
	PER_FILE_BASELINE,
	loadCommittedPerFileCoverageBaseline,
} from "../../../scripts/testing-v2/coverage-delta.mjs";
import {
	COVERAGE_BASELINE_PATH,
	SPEC_BASELINE_PATH,
	loadQualityBaselines,
} from "../../../scripts/testing-v2/parity.mjs";
import { isRunnableTestPath, normalizeTestPath } from "../../../scripts/testing/layout-policy.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SUPPORT_ROOT = path.join(REPOSITORY_ROOT, "tests", "support");

function repositoryPath(...segments: string[]): string {
	return path.join(REPOSITORY_ROOT, ...segments);
}

function repositoryIdentity(filePath: string): string {
	return normalizeTestPath(path.relative(REPOSITORY_ROOT, filePath));
}

function allFiles(root: string): string[] {
	return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
		const absolute = path.join(root, entry.name);
		return entry.isDirectory() ? allFiles(absolute) : [absolute];
	});
}

describe("canonical test support assets", () => {
	it("resolves representative imported-only assets by purpose", () => {
		const representatives = [
			"tests/support/data/quality/budgets/budget-caps.json",
			"tests/support/data/quality/chaos/mutants.json",
			"tests/support/data/quality/coverage/v2-baseline-coverage.json",
			"tests/support/fixtures/release/npm-attestations-bobbit-0.15.1.json",
			"tests/support/fixtures/unit/security/pi-published-shrinkwrap-security/advisory-floor.json",
			"tests/support/fixtures/unit/providers/wellknown-opencode.json",
			"tests/support/fixtures/browser/packs/pack-hot-reload/pack-hot-reload-fixture/lib/nested/hot-reload/panel.js",
			"tests/support/data/dom/quarantine/tool-manager-mcp-section.test.ts.txt",
			"tests/support/helpers/dom/setup/custom-elements.ts",
		];

		for (const identity of representatives) {
			const absolute = repositoryPath(...identity.split("/"));
			assert.equal(existsSync(absolute), true, `${identity} must exist at its canonical support path`);
			assert.equal(repositoryIdentity(absolute), identity);
			const windowsSpelling = path.win32.join(...identity.split("/"));
			assert.equal(normalizeTestPath(windowsSpelling), identity);
		}

		const legacyAssets = [
			"tests2/budget-caps.json",
			"tests2/chaos/mutants.json",
			"tests2/v2-baseline-coverage.json",
			"tests2/fixtures/release/npm-attestations-bobbit-0.15.1.json",
			"tests2/core/fixtures/pi-published-shrinkwrap-security/advisory-floor.json",
			"tests2/core/fixtures/wellknown-opencode.json",
		];
		for (const identity of legacyAssets) assert.equal(existsSync(repositoryPath(...identity.split("/"))), false);
	});

	it("loads all committed coverage baselines through their real consumers", () => {
		assert.equal(repositoryIdentity(PER_FILE_BASELINE), "tests/support/data/quality/coverage/v2-baseline-coverage-per-file.json");
		assert.equal(repositoryIdentity(COVERAGE_BASELINE_PATH), "tests/support/data/quality/coverage/v2-baseline-coverage.json");
		assert.equal(repositoryIdentity(SPEC_BASELINE_PATH), "tests/support/data/quality/coverage/v2-baseline-spec.json");

		const perFile = loadCommittedPerFileCoverageBaseline();
		const { coverage, spec } = loadQualityBaselines();
		assert.ok(Object.keys(perFile.files).length > 0);
		assert.ok(Object.keys(coverage.areas).length > 0);
		assert.ok(spec.contracts > 0);
		assert.ok(spec.stories > 0);
	});

	it("keeps support imported-only and outside runnable discovery", () => {
		const runnable = allFiles(SUPPORT_ROOT)
			.map(repositoryIdentity)
			.filter(isRunnableTestPath);
		assert.deepEqual(runnable, []);
		const packageManifest = JSON.parse(readFileSync(repositoryPath("package.json"), "utf8")) as { files: string[] };
		assert.equal(packageManifest.files.some(entry => normalizeTestPath(entry).startsWith("tests/support")), false);
	});
});
