import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "vitest";
import YAML from "yaml";

const RELEASE_CONTROL_FILES = [
	"scripts/release/changelog-section.mjs",
	"scripts/release/dist-tag-guard.mjs",
	"scripts/release/release-contract.mjs",
	"scripts/release/validate-release-commit.mjs",
] as const;

const CODEQL_CONFIG_PATH = resolve(process.cwd(), ".github/codeql/codeql-config.yml");
const RELEASE_TSCONFIG_PATH = resolve(process.cwd(), "tsconfig.release.json");
const PACKAGE_JSON_PATH = resolve(process.cwd(), "package.json");

interface CodeQlConfig {
	paths?: string[];
	"paths-ignore"?: string[];
}

interface ReleaseTsConfig {
	compilerOptions?: Record<string, unknown>;
	files?: string[];
	include?: string[];
}

interface WorkflowStep {
	name?: string;
	run?: string;
}

interface Workflow {
	jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Match the documented CodeQL path-filter subset used by this repository. */
function codeQlPatternMatches(file: string, rawPattern: string): boolean {
	const normalize = (value: string): string => value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
	const path = normalize(file);
	const pattern = normalize(rawPattern);
	if (!pattern.includes("*")) return path === pattern || path.startsWith(`${pattern}/`);

	const pathSegments = path.split("/");
	const patternSegments = pattern.split("/");
	const matchFrom = (patternIndex: number, pathIndex: number): boolean => {
		if (patternIndex === patternSegments.length) return pathIndex === pathSegments.length;
		const segment = patternSegments[patternIndex];
		if (segment === "**") {
			if (patternIndex === patternSegments.length - 1) return true;
			for (let next = pathIndex; next <= pathSegments.length; next += 1) {
				if (matchFrom(patternIndex + 1, next)) return true;
			}
			return false;
		}
		if (pathIndex === pathSegments.length) return false;
		const expression = new RegExp(
			`^${segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*")}$`,
		);
		return expression.test(pathSegments[pathIndex]) && matchFrom(patternIndex + 1, pathIndex + 1);
	};
	return matchFrom(0, 0);
}

function isAnalyzed(config: CodeQlConfig, file: string): boolean {
	const included = !config.paths || config.paths.length === 0 || config.paths.some(pattern => codeQlPatternMatches(file, pattern));
	const ignored = (config["paths-ignore"] ?? []).some(pattern => codeQlPatternMatches(file, pattern));
	return included && !ignored;
}

function workflowStep(path: string, jobName: string, stepName: string): WorkflowStep {
	const workflow = YAML.parse(readFileSync(resolve(process.cwd(), path), "utf8")) as Workflow;
	const step = workflow.jobs?.[jobName]?.steps?.find(candidate => candidate.name === stepName);
	assert.ok(step, `${path} must retain ${jobName}'s ${stepName} step`);
	return step;
}

describe("release static-analysis ownership", () => {
	it("keeps release controls in CodeQL while excluding ordinary tooling and test assets", () => {
		const config = YAML.parse(readFileSync(CODEQL_CONFIG_PATH, "utf8")) as CodeQlConfig;

		for (const file of RELEASE_CONTROL_FILES) {
			assert.equal(isAnalyzed(config, file), true, `CodeQL must analyze publication control ${file}`);
		}

		for (const file of [
			"scripts/build-server.mjs",
			"scripts/benchmarks/event-stream/fixture.mjs",
			"scripts/testing/check-layout.mjs",
			"tests/unit/core/example.unit.test.ts",
			"tests/support/fixtures/release/example.json",
			"tools/dummy-aigw/server.js",
		]) {
			assert.equal(isAnalyzed(config, file), false, `CodeQL must continue excluding non-production path ${file}`);
		}
	});

	it("strictly type-checks exactly the four release-control modules", () => {
		const config = readJson<ReleaseTsConfig>(RELEASE_TSCONFIG_PATH);
		assert.equal(config.compilerOptions?.allowJs, true, "release type-check must load JavaScript modules");
		assert.equal(config.compilerOptions?.checkJs, true, "release JavaScript must receive type diagnostics");
		assert.equal(config.compilerOptions?.noEmit, true, "release checking must not rewrite runtime modules");
		assert.equal(config.compilerOptions?.strict, true, "publication controls require strict checking");
		assert.deepEqual(
			[...(config.files ?? [])].sort(),
			[...RELEASE_CONTROL_FILES].sort(),
			"the dedicated config must explicitly own the complete release-control graph",
		);
		assert.equal(config.include, undefined, "the narrow release config must not acquire unrelated files through include globs");
	});

	it("routes the release type-check through npm check inherited by PR and publish verification", () => {
		const packageJson = readJson<{ scripts?: Record<string, string> }>(PACKAGE_JSON_PATH);
		const check = packageJson.scripts?.check ?? "";
		assert.match(
			check,
			/(?:^|&&)\s*tsc\s+-p\s+tsconfig\.release\.json(?:\s|$)/,
			"npm run check must invoke the dedicated release-control config",
		);
		assert.equal(
			(check.match(/tsconfig\.release\.json/g) ?? []).length,
			1,
			"npm run check must have one authoritative release type-check",
		);
		assert.equal(
			workflowStep(".github/workflows/build-unit-gate.yml", "verify", "Type-check").run,
			"npm run check",
			"the PR build gate must inherit release checking from npm run check",
		);
		assert.equal(
			workflowStep(".github/workflows/release-publish.yml", "verify", "Type-check").run,
			"npm run check",
			"post-merge release verification must inherit release checking before publication",
		);
	});
});
