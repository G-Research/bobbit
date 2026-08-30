// v2-native — focused contract coverage for convention-based test discovery.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import {
	classifyTestPath,
	discoverTests,
	normalizeTestPath,
	validateIntroducedTestPaths,
} from "../../../scripts/testing-v2/test-discovery.mjs";
import { TEST_LAYOUT } from "../../../scripts/testing/layout-policy.mjs";
import { createE2EPhaseSelection } from "../../../scripts/test-phase-config.mjs";

const ISOLATED_TEST_CAP = 14;
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const require = createRequire(import.meta.url);
const { createFileMatcher } = require("playwright/lib/util") as {
	createFileMatcher: (patterns: string | RegExp | Array<string | RegExp>) => (file: string) => boolean;
};

type CommittedPlaywrightProject = {
	name: string;
	testDir: string;
	testMatch: string[];
	testIgnore: string[];
	fullyParallel: boolean;
};

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bobbit-test-discovery-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function materialize(...paths: string[]): void {
	for (const path of paths) {
		const target = join(root, ...normalizeTestPath(path).split("/"));
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, "", "utf8");
	}
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (
		ts.isParenthesizedExpression(current)
		|| ts.isAsExpression(current)
		|| ts.isTypeAssertionExpression(current)
		|| ts.isNonNullExpression(current)
		|| ts.isSatisfiesExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
	for (const element of object.properties) {
		if (!ts.isPropertyAssignment(element)) continue;
		const key = element.name;
		if ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === name) return element.initializer;
	}
	return undefined;
}

function objectLiteral(expression: ts.Expression | undefined, context: string): ts.ObjectLiteralExpression {
	if (!expression) throw new Error(`${context} is missing`);
	const unwrapped = unwrapExpression(expression);
	if (!ts.isObjectLiteralExpression(unwrapped)) throw new Error(`${context} must be an object literal`);
	return unwrapped;
}

function arrayLiteral(expression: ts.Expression | undefined, context: string): ts.ArrayLiteralExpression {
	if (!expression) throw new Error(`${context} is missing`);
	const unwrapped = unwrapExpression(expression);
	if (!ts.isArrayLiteralExpression(unwrapped)) throw new Error(`${context} must be an array literal`);
	return unwrapped;
}

function stringLiteral(expression: ts.Expression | undefined, context: string): string {
	if (!expression) throw new Error(`${context} is missing`);
	const unwrapped = unwrapExpression(expression);
	if (!ts.isStringLiteral(unwrapped) && !ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
		throw new Error(`${context} must be a string literal`);
	}
	return unwrapped.text;
}

function booleanLiteral(expression: ts.Expression | undefined, context: string): boolean {
	if (!expression) throw new Error(`${context} is missing`);
	const unwrapped = unwrapExpression(expression);
	if (unwrapped.kind === ts.SyntaxKind.TrueKeyword) return true;
	if (unwrapped.kind === ts.SyntaxKind.FalseKeyword) return false;
	throw new Error(`${context} must be a boolean literal`);
}

function stringPatterns(expression: ts.Expression | undefined, context: string): string[] {
	if (!expression) return [];
	const unwrapped = unwrapExpression(expression);
	if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) return [unwrapped.text];
	if (ts.isIdentifier(unwrapped) && unwrapped.text === "canonicalBrowserMatches") {
		return (TEST_LAYOUT as readonly { semantic: string; suffix: string }[])
			.filter(({ semantic }) => semantic === "browser-fixture" || semantic === "browser-journey")
			.map(({ suffix }) => `**/*${suffix}`);
	}
	if (ts.isCallExpression(unwrapped)
		&& ts.isIdentifier(unwrapped.expression)
		&& unwrapped.expression.text === "canonicalE2EMatch"
		&& unwrapped.arguments.length === 1) {
		const semantic = stringLiteral(unwrapped.arguments[0], `${context} semantic`);
		const convention = (TEST_LAYOUT as readonly { semantic: string; suffix: string }[])
			.find((entry) => entry.semantic === semantic);
		if (!convention) throw new Error(`${context} references unknown semantic ${semantic}`);
		return [`**/*${convention.suffix}`];
	}
	return arrayLiteral(unwrapped, context).elements.flatMap((element, index) => {
		const candidate = unwrapExpression(element);
		if (ts.isIdentifier(candidate) && candidate.text === "canonicalManualMatch") {
			const manual = (TEST_LAYOUT as readonly { semantic: string; suffix: string }[])
				.find(({ semantic }) => semantic === "manual");
			if (!manual) throw new Error("manual convention missing");
			return [`**/*${manual.suffix}`];
		}
		if (ts.isCallExpression(candidate)) return stringPatterns(candidate, `${context}[${index}]`);
		return [stringLiteral(candidate, `${context}[${index}]`)];
	});
}

function committedPlaywrightProjects(configFile: string): CommittedPlaywrightProject[] {
	const configPath = resolve(REPO_ROOT, configFile);
	const source = ts.createSourceFile(configPath, readFileSync(configPath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const exportAssignment = source.statements.find(ts.isExportAssignment);
	if (!exportAssignment || exportAssignment.isExportEquals) throw new Error(`${configFile} must have one default export`);

	let configExpression = unwrapExpression(exportAssignment.expression);
	if (ts.isCallExpression(configExpression)) {
		if (!ts.isIdentifier(configExpression.expression) || configExpression.expression.text !== "defineConfig" || configExpression.arguments.length !== 1) {
			throw new Error(`${configFile} default export must be an object literal or defineConfig(object literal)`);
		}
		configExpression = unwrapExpression(configExpression.arguments[0]);
	}
	const config = objectLiteral(configExpression, `${configFile} default export`);
	const projects = arrayLiteral(property(config, "projects"), `${configFile} projects`);
	const topLevelFullyParallel = property(config, "fullyParallel") === undefined
		? false
		: booleanLiteral(property(config, "fullyParallel"), `${configFile} fullyParallel`);
	if (configFile === "playwright-e2e.config.ts") {
		const selection = createE2EPhaseSelection() as Record<string, {
			name: string; testDir: string; testMatch?: string[]; testIgnore?: string[];
		}>;
		return projects.elements.map((element, index) => {
			const project = objectLiteral(element, `${configFile} projects[${index}]`);
			const spread = project.properties.find(ts.isSpreadAssignment);
			const expression = spread && unwrapExpression(spread.expression);
			if (!expression || !ts.isPropertyAccessExpression(expression)
				|| !ts.isIdentifier(expression.expression) || expression.expression.text !== "phaseSelection") {
				throw new Error(`${configFile} projects[${index}] must spread phaseSelection.<project>`);
			}
			const selected = selection[expression.name.text];
			if (!selected) throw new Error(`${configFile} projects[${index}] references unknown phase selection`);
			return {
				name: selected.name,
				testDir: selected.testDir,
				testMatch: selected.testMatch ?? [],
				testIgnore: selected.testIgnore ?? [],
				fullyParallel: property(project, "fullyParallel") === undefined
					? topLevelFullyParallel
					: booleanLiteral(property(project, "fullyParallel"), `${configFile} projects[${index}].fullyParallel`),
			};
		});
	}
	return projects.elements.map((element, index) => {
		const project = objectLiteral(element, `${configFile} projects[${index}]`);
		const context = `${configFile} projects[${index}]`;
		return {
			name: stringLiteral(property(project, "name"), `${context}.name`),
			testDir: stringLiteral(property(project, "testDir"), `${context}.testDir`),
			testMatch: stringPatterns(property(project, "testMatch"), `${context}.testMatch`),
			testIgnore: stringPatterns(property(project, "testIgnore"), `${context}.testIgnore`),
			fullyParallel: property(project, "fullyParallel") === undefined
				? topLevelFullyParallel
				: booleanLiteral(property(project, "fullyParallel"), `${context}.fullyParallel`),
		};
	});
}

function projectSelectsPath(project: CommittedPlaywrightProject, repositoryPath: string): boolean {
	const candidate = resolve(REPO_ROOT, ...normalizeTestPath(repositoryPath).split("/"));
	const normalizedCandidate = normalizeTestPath(candidate);
	const normalizedTestDir = normalizeTestPath(resolve(REPO_ROOT, project.testDir));
	if (normalizedCandidate !== normalizedTestDir && !normalizedCandidate.startsWith(`${normalizedTestDir}/`)) return false;
	return createFileMatcher(project.testMatch)(candidate) && !createFileMatcher(project.testIgnore)(candidate);
}

function selectedRepositoryPaths(project: CommittedPlaywrightProject): string[] {
	const candidates: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile()) candidates.push(normalizeTestPath(relative(REPO_ROOT, path)));
		}
	};
	const testDirectory = resolve(REPO_ROOT, project.testDir);
	if (existsSync(testDirectory)) visit(testDirectory);
	return candidates.filter(path => projectSelectsPath(project, path)).sort();
}

const CLASSIFICATIONS = [
	["tests2/core/deep/core.test.ts", { lane: "core", phase: "unit", runner: "vitest", project: "v2-core" }],
	["tests2/dom/deep/dom.test.ts", { lane: "dom", phase: "unit", runner: "vitest", project: "v2-dom" }],
	["tests2/integration/deep/integration.test.ts", { lane: "integration", phase: "unit", runner: "vitest", project: "v2-integration" }],
	["tests2/core/deep/state.isolated.test.ts", { lane: "isolated", phase: "unit", runner: "vitest", project: "v2-isolated" }],
	["tests2/integration/deep/process.e2e.test.ts", { lane: "vitestE2E", phase: "e2e", runner: "vitest", project: "v2-e2e-vitest", e2eGroup: "D" }],
	["tests2/browser/deep/journey.spec.ts", { lane: "browser", phase: "browser", runner: "playwright", project: "browser-v2" }],
	["tests2/browser/e2e/deep/journey.spec.ts", { lane: "browserE2E", phase: "e2e", runner: "playwright", project: "browser-v2-e2e", e2eGroup: "C" }],
	["tests/worktree.e2e.test.ts", { lane: "e2eNode", phase: "e2e", runner: "tsx", project: "e2e-node", e2eGroup: "A" }],
	["tests/e2e/deep/restart.e2e.spec.ts", { lane: "e2ePlaywright", phase: "e2e", runner: "playwright", project: "e2e-playwright", e2eGroup: "B" }],
	["tests/manual-integration/deep/real.spec.ts", { lane: "manual", phase: "manual", runner: "playwright", project: "manual-integration" }],
	["tests/manual-integration/deep/real.test.ts", { lane: "manual", phase: "manual", runner: "playwright", project: "manual-integration" }],
] as const;

const CANONICAL_CLASSIFICATIONS = [
	["tests/unit/core/deep/core.unit.test.ts", { lane: "core", phase: "unit", runner: "vitest", project: "v2-core" }],
	["tests/unit/isolated/deep/state.isolated.test.ts", { lane: "isolated", phase: "unit", runner: "vitest", project: "v2-isolated" }],
	["tests/dom/deep/panel.dom.test.ts", { lane: "dom", phase: "unit", runner: "vitest", project: "v2-dom" }],
	["tests/integration/gateway/deep/api.gateway.test.ts", { lane: "integration", phase: "unit", runner: "vitest", project: "v2-integration" }],
	["tests/browser/fixtures/deep/base.fixture.spec.ts", { lane: "browser", phase: "browser", runner: "playwright", project: "browser-canonical" }],
	["tests/browser/journeys/deep/create.journey.spec.ts", { lane: "browser", phase: "browser", runner: "playwright", project: "browser-canonical" }],
	["tests/e2e/node/deep/process.node-e2e.test.ts", { lane: "e2eNode", phase: "e2e", runner: "tsx", project: "e2e-node", e2eGroup: "A" }],
	["tests/e2e/vitest/deep/restart.vitest-e2e.test.ts", { lane: "vitestE2E", phase: "e2e", runner: "vitest", project: "v2-e2e-vitest", e2eGroup: "D" }],
	["tests/e2e/api/deep/mcp.api-e2e.spec.ts", { lane: "e2eApi", phase: "e2e", runner: "playwright", project: "api-canonical", e2eGroup: "B" }],
	["tests/e2e/browser/deep/ui.browser-e2e.spec.ts", { lane: "e2eBrowser", phase: "e2e", runner: "playwright", project: "browser-canonical", e2eGroup: "C" }],
	["tests/manual/deep/model.manual.spec.ts", { lane: "manual", phase: "manual", runner: "playwright", project: "manual" }],
] as const;

describe("classifyTestPath", () => {
	it.each([...CLASSIFICATIONS, ...CANONICAL_CLASSIFICATIONS])("classifies %s from POSIX and Windows paths", (path, expected) => {
		const posixOwner = classifyTestPath(path);
		const windowsOwner = classifyTestPath(path.replaceAll("/", "\\"));

		expect(posixOwner).toEqual(expected);
		expect(windowsOwner).toBe(posixOwner);
		expect(Object.isFrozen(posixOwner)).toBe(true);
	});

	it("normalizes separators and a repository-relative prefix", () => {
		expect(normalizeTestPath(".\\tests2\\core\\nested\\one.test.ts")).toBe("tests2/core/nested/one.test.ts");
	});

	it.each([
		["tests2/core/wrong.spec.ts", "tests/browser/journeys"],
		["tests2/integration/wrong.spec.ts", "tests/browser/journeys"],
		["tests2/browser/wrong.test.ts", "canonical Vitest directories"],
		["tests2/dom/wrong.isolated.test.ts", "tests2/core or tests2/integration"],
		["tests2/dom/wrong.e2e.test.ts", "tests2/core or tests2/integration"],
		["tests2/unsupported/wrong.test.ts", "canonical destination under tests"],
		["tests2/core/wrong.isolated.e2e.test.ts", "exactly one semantic suffix"],
		["../tests2/core/traversal.test.ts", "without '..' traversal"],
	])("rejects unsupported or ambiguous placement %s actionably", (path, remedy) => {
		expect(() => classifyTestPath(path)).toThrow(remedy);
	});

	it("leaves non-test sources and pre-existing unmarked legacy tests inactive", () => {
		expect(classifyTestPath("tests2/core/helper.ts")).toBeNull();
		expect(classifyTestPath("tests/legacy.test.ts")).toBeNull();
		expect(classifyTestPath("tests/e2e/legacy.spec.ts")).toBeNull();
	});
});

describe("discoverTests", () => {
	it("recursively discovers, sorts, and assigns every active convention exactly once", () => {
		const activePaths = [
			"tests2/core/z-last.test.ts",
			"tests2/core/nested/a-first.test.ts",
			"tests2/dom/z-dom.test.ts",
			"tests2/integration/a-integration.test.ts",
			"tests2/core/z-state.isolated.test.ts",
			"tests2/integration/a-state.isolated.test.ts",
			"tests2/core/z-process.e2e.test.ts",
			"tests2/integration/a-process.e2e.test.ts",
			"tests2/browser/z-browser.spec.ts",
			"tests2/browser/nested/a-browser.spec.ts",
			"tests2/browser/e2e/z-e2e.spec.ts",
			"tests2/browser/e2e/nested/a-e2e.spec.ts",
			"tests/z-node.e2e.test.ts",
			"tests/a-node.e2e.test.ts",
			"tests/e2e/z-playwright.e2e.spec.ts",
			"tests/e2e/nested/a-playwright.e2e.spec.ts",
			"tests/manual-integration/z-manual.test.ts",
			"tests/manual-integration/nested/a-manual.spec.ts",
			"tests/unit/core/canonical.unit.test.ts",
			"tests/unit/isolated/canonical.isolated.test.ts",
			"tests/dom/canonical.dom.test.ts",
			"tests/integration/gateway/canonical.gateway.test.ts",
			"tests/browser/fixtures/canonical.fixture.spec.ts",
			"tests/browser/journeys/canonical.journey.spec.ts",
			"tests/e2e/node/canonical.node-e2e.test.ts",
			"tests/e2e/vitest/canonical.vitest-e2e.test.ts",
			"tests/e2e/api/canonical.api-e2e.spec.ts",
			"tests/e2e/browser/canonical.browser-e2e.spec.ts",
			"tests/manual/canonical.manual.spec.ts",
		];
		materialize(...activePaths, "tests2/core/helper.ts", "tests/legacy.test.ts", "tests/e2e/legacy.spec.ts");

		const discovery = discoverTests({ repoRoot: root });

		expect(discovery.core).toEqual(["tests/unit/core/canonical.unit.test.ts", "tests2/core/nested/a-first.test.ts", "tests2/core/z-last.test.ts"]);
		expect(discovery.dom).toEqual(["tests/dom/canonical.dom.test.ts", "tests2/dom/z-dom.test.ts"]);
		expect(discovery.integration).toEqual(["tests/integration/gateway/canonical.gateway.test.ts", "tests2/integration/a-integration.test.ts"]);
		expect(discovery.isolated).toEqual(["tests/unit/isolated/canonical.isolated.test.ts", "tests2/core/z-state.isolated.test.ts", "tests2/integration/a-state.isolated.test.ts"]);
		expect(discovery.vitestE2E).toEqual(["tests/e2e/vitest/canonical.vitest-e2e.test.ts", "tests2/core/z-process.e2e.test.ts", "tests2/integration/a-process.e2e.test.ts"]);
		expect(discovery.browser).toEqual(["tests/browser/fixtures/canonical.fixture.spec.ts", "tests/browser/journeys/canonical.journey.spec.ts", "tests2/browser/nested/a-browser.spec.ts", "tests2/browser/z-browser.spec.ts"]);
		expect(discovery.browserE2E).toEqual(["tests2/browser/e2e/nested/a-e2e.spec.ts", "tests2/browser/e2e/z-e2e.spec.ts"]);
		expect(discovery.e2eApi).toEqual(["tests/e2e/api/canonical.api-e2e.spec.ts"]);
		expect(discovery.e2eBrowser).toEqual(["tests/e2e/browser/canonical.browser-e2e.spec.ts"]);
		expect(discovery.manual).toEqual(["tests/manual-integration/nested/a-manual.spec.ts", "tests/manual-integration/z-manual.test.ts", "tests/manual/canonical.manual.spec.ts"]);
		expect(discovery.e2eGroups).toEqual({
			A: ["tests/a-node.e2e.test.ts", "tests/e2e/node/canonical.node-e2e.test.ts", "tests/z-node.e2e.test.ts"],
			B: ["tests/e2e/api/canonical.api-e2e.spec.ts", "tests/e2e/nested/a-playwright.e2e.spec.ts", "tests/e2e/z-playwright.e2e.spec.ts"],
			C: ["tests/e2e/browser/canonical.browser-e2e.spec.ts", ...discovery.browserE2E],
			D: discovery.vitestE2E,
		});
		expect(discovery.unit).toEqual([
			...discovery.core,
			...discovery.dom,
			...discovery.integration,
			...discovery.isolated,
		].sort());
		expect(discovery.vitest).toEqual([...discovery.unit, ...discovery.vitestE2E].sort());
		expect(discovery.all).toEqual([...activePaths].sort());
		const expectedCanonical = activePaths.filter(path => path.includes("/canonical.")).sort();
		expect(discovery.canonical).toEqual(expectedCanonical);
		expect(discovery.transitional).toEqual(activePaths.filter(path => !expectedCanonical.includes(path)).sort());
		expect(discovery.canonical.filter((path: string) => discovery.transitional.includes(path))).toEqual([]);
		expect([...discovery.canonical, ...discovery.transitional].sort()).toEqual(discovery.all);
		expect(new Set(discovery.all).size).toBe(discovery.all.length);
		expect(discovery.browser).not.toContain("tests2/browser/e2e/z-e2e.spec.ts");
		expect(discovery.core).not.toContain("tests2/core/z-state.isolated.test.ts");
		expect(discovery.integration).not.toContain("tests2/integration/a-process.e2e.test.ts");
		expect(Object.isFrozen(discovery)).toBe(true);
		expect(Object.isFrozen(discovery.all)).toBe(true);
		expect(Object.isFrozen(discovery.e2eGroups)).toBe(true);
		expect(() => discovery.all.push("tests2/core/mutation.test.ts")).toThrow();
	});

	it("returns an immutable empty inventory when active roots are missing", () => {
		const discovery = discoverTests({ repoRoot: root });

		expect(discovery.all).toEqual([]);
		expect(discovery.canonical).toEqual([]);
		expect(discovery.transitional).toEqual([]);
		expect(discovery.e2eGroups).toEqual({ A: [], B: [], C: [], D: [] });
		expect(Object.isFrozen(discovery.unit)).toBe(true);
	});

	it("does not follow symlinked directories", () => {
		const external = join(root, "external-tests");
		mkdirSync(external, { recursive: true });
		writeFileSync(join(external, "linked.test.ts"), "", "utf8");
		const core = join(root, "tests2", "core");
		mkdirSync(core, { recursive: true });
		symlinkSync(external, join(core, "linked"), process.platform === "win32" ? "junction" : "dir");

		expect(discoverTests({ repoRoot: root }).all).toEqual([]);
	});

	it("rejects managed-root suffix mismatches found during traversal", () => {
		materialize("tests2/browser/api.test.ts", "tests2/core/journey.spec.ts");

		expect(() => discoverTests({ repoRoot: root })).toThrow("Unsupported transitional test placement");
	});

	it(`caps only transitional isolated tests at ${ISOLATED_TEST_CAP}`, () => {
		const transitional = Array.from({ length: ISOLATED_TEST_CAP }, (_, index) => `tests2/core/state-${index}.isolated.test.ts`);
		materialize(...transitional, "tests/unit/isolated/canonical.isolated.test.ts");
		const discovery = discoverTests({ repoRoot: root });
		expect(discovery.isolated).toHaveLength(ISOLATED_TEST_CAP + 1);
		expect(discovery.isolated.filter((path: string) => path === "tests/unit/isolated/canonical.isolated.test.ts")).toHaveLength(1);

		materialize("tests2/integration/one-too-many.isolated.test.ts");
		expect(() => discoverTests({ repoRoot: root })).toThrow(`maximum is ${ISOLATED_TEST_CAP}`);
	});
});

describe("Playwright selector parity", () => {
	it("keeps transitional and canonical browser/manual selectors disjoint on POSIX and Windows paths", () => {
		const browserProjects = committedPlaywrightProjects("playwright-v2.config.ts");
		const e2eProjects = committedPlaywrightProjects("playwright-e2e.config.ts");
		const manualProjects = committedPlaywrightProjects("playwright-manual.config.ts");
		expect(browserProjects.map(project => project.name)).toEqual(["browser-v2", "browser-canonical", "browser-v2-e2e"]);
		expect(e2eProjects.map(project => project.name)).toEqual(["api", "api-canonical", "browser-canonical", "api-realpush", "browser"]);
		expect(manualProjects.map(project => project.name)).toEqual(["manual-integration", "manual"]);
		const browser = browserProjects.find(project => project.name === "browser-v2")!;
		const browserCanonical = browserProjects.find(project => project.name === "browser-canonical")!;
		const browserE2E = browserProjects.find(project => project.name === "browser-v2-e2e")!;
		const apiCanonical = e2eProjects.find(project => project.name === "api-canonical")!;
		const e2eBrowserCanonical = e2eProjects.find(project => project.name === "browser-canonical")!;
		const manual = manualProjects.find(project => project.name === "manual-integration")!;
		const manualCanonical = manualProjects.find(project => project.name === "manual")!;
		expect(browser.fullyParallel).toBe(false);
		expect(browserCanonical.fullyParallel).toBe(true);
		expect(browserE2E.fullyParallel).toBe(false);
		const discovery = discoverTests();
		const selected = {
			browser: selectedRepositoryPaths(browser),
			browserCanonical: selectedRepositoryPaths(browserCanonical),
			browserE2E: selectedRepositoryPaths(browserE2E),
			apiCanonical: selectedRepositoryPaths(apiCanonical),
			e2eBrowserCanonical: selectedRepositoryPaths(e2eBrowserCanonical),
			manual: selectedRepositoryPaths(manual),
			manualCanonical: selectedRepositoryPaths(manualCanonical),
		};
		expect([...selected.browser, ...selected.browserCanonical].sort()).toEqual(discovery.browser);
		expect(selected.browserE2E).toEqual(discovery.browserE2E);
		expect(selected.apiCanonical).toEqual(discovery.e2eApi);
		expect(selected.e2eBrowserCanonical).toEqual(discovery.e2eBrowser);
		expect([...selected.manual, ...selected.manualCanonical].sort()).toEqual(discovery.manual);
		expect(selected.browser.some(path => path.startsWith("tests2/browser/e2e/"))).toBe(false);
		expect(selected.browserE2E.every(path => path.startsWith("tests2/browser/e2e/"))).toBe(true);
		const laneSets = Object.values(selected).map(paths => new Set(paths));
		for (let left = 0; left < laneSets.length; left += 1) {
			for (let right = left + 1; right < laneSets.length; right += 1) {
				expect([...laneSets[left]].filter(path => laneSets[right].has(path))).toEqual([]);
			}
		}
		const projects = [...browserProjects, ...e2eProjects, ...manualProjects];
		for (const [path, owner] of [
			["tests2/browser/fixtures/representative.spec.ts", "browser-v2"],
			["tests2/browser/e2e/representative.spec.ts", "browser-v2-e2e"],
			["tests/browser/fixtures/representative.fixture.spec.ts", "browser-canonical"],
			["tests/browser/journeys/representative.journey.spec.ts", "browser-canonical"],
			["tests/e2e/api/representative.api-e2e.spec.ts", "api-canonical"],
			["tests/e2e/browser/representative.browser-e2e.spec.ts", "browser-canonical"],
			["tests/manual-integration/representative.test.ts", "manual-integration"],
			["tests/manual-integration/representative.spec.ts", "manual-integration"],
			["tests/manual/representative.manual.spec.ts", "manual"],
			["tests2/browser/api.test.ts", undefined],
			["tests2/core/api.test.ts", undefined],
			["tests/e2e/process.e2e.spec.ts", undefined],
			["tests/manual-integration/representative.spec.js", undefined],
		] as const) {
			for (const pathForm of [path, path.replaceAll("/", "\\")]) {
				expect(projects.filter(project => projectSelectsPath(project, pathForm)).map(project => project.name)).toEqual(owner ? [owner] : []);
			}
		}

		const coordinator = readFileSync(resolve(REPO_ROOT, "scripts/testing-v2/run-e2e-v2.mjs"), "utf8");
		const groupC = coordinator.match(/async function runGroupC[\s\S]*?(?=\nexport function groupDVitestArgs)/)?.[0];
		expect(groupC).toContain('spec.startsWith("tests/e2e/browser/")');
		expect(groupC).toContain("createCanonicalGroupCInvocation(canonicalSpecs");
		expect(coordinator).toContain('"--project=browser-canonical"');
	});
});

describe("validateIntroducedTestPaths", () => {
	it("accepts every canonical convention, Windows paths, duplicates, and non-test sources", () => {
		expect(() => validateIntroducedTestPaths([
			...CANONICAL_CLASSIFICATIONS.map(([path]) => path),
			"tests\\dom\\windows.dom.test.ts",
			"tests/dom/windows.dom.test.ts",
			"src/server/helper.ts",
		])).not.toThrow();
	});

	it("rejects newly introduced transitional and unowned tests with canonical destinations", () => {
		expect(() => validateIntroducedTestPaths([
			"tests2/core/new.test.ts",
			"tests/e2e/new.spec.ts",
			"tests/unknown/new.test.ts",
		])).toThrowError(expect.objectContaining({
			message: expect.stringContaining("npm run test:new"),
		}));
	});

	it("does not alter filesystem discovery", () => {
		materialize("tests2/core/automatic.test.ts");
		const before = discoverTests({ repoRoot: root });

		expect(() => validateIntroducedTestPaths(["tests2/browser/automatic.spec.ts"])).toThrow();

		expect(discoverTests({ repoRoot: root })).toEqual(before);
	});
});
