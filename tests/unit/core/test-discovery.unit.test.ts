import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	classifyTestPath,
	discoverTests,
	normalizeTestPath,
} from "../../../scripts/testing-v2/test-discovery.mjs";

const CLASSIFICATIONS = [
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

describe("canonical test classification", () => {
	it.each(CLASSIFICATIONS)("classifies %s from POSIX and Windows spellings", (path, expected) => {
		const posixOwner = classifyTestPath(path);
		expect(posixOwner).toEqual(expected);
		expect(classifyTestPath(path.replaceAll("/", "\\"))).toBe(posixOwner);
		expect(Object.isFrozen(posixOwner)).toBe(true);
	});

	it("does not classify former transitional or generic test paths", () => {
		for (const path of [
			"tests2/core/example.test.ts",
			"tests2/browser/example.spec.ts",
			"tests/legacy.test.ts",
			"tests/e2e/legacy.spec.ts",
		]) expect(classifyTestPath(path)).toBeNull();
	});
});

describe("canonical-only discovery", () => {
	it("discovers every semantic lane exactly once", () => {
		const activePaths = CLASSIFICATIONS.map(([path]) => path);
		materialize(...activePaths, "tests/support/helpers/unit/helper.ts", "tests2/core/inactive.test.ts");

		const discovery = discoverTests({ repoRoot: root });
		expect(discovery.core).toEqual([activePaths[0]]);
		expect(discovery.isolated).toEqual([activePaths[1]]);
		expect(discovery.dom).toEqual([activePaths[2]]);
		expect(discovery.integration).toEqual([activePaths[3]]);
		expect(discovery.browser).toEqual([activePaths[4], activePaths[5]]);
		expect(discovery.e2eGroups).toEqual({
			A: [activePaths[6]],
			B: [activePaths[8]],
			C: [activePaths[9]],
			D: [activePaths[7]],
		});
		expect(discovery.manual).toEqual([activePaths[10]]);
		expect(discovery.canonical).toBe(discovery.all);
		expect(discovery.all).toEqual([...activePaths].sort());
		expect(new Set(discovery.all).size).toBe(discovery.all.length);
		expect("transitional" in discovery).toBe(false);
		expect(Object.isFrozen(discovery)).toBe(true);
		expect(Object.isFrozen(discovery.all)).toBe(true);
		expect(Object.isFrozen(discovery.e2eGroups)).toBe(true);
	});

	it("fails closed for runnable paths without canonical ownership", () => {
		for (const path of [
			"tests/unit/core/wrong.test.ts",
			"tests/support/helpers/unit/wrong.unit.test.ts",
			"tests/unknown/wrong.spec.ts",
		]) {
			rmSync(join(root, "tests"), { recursive: true, force: true });
			materialize(path);
			expect(() => discoverTests({ repoRoot: root })).toThrow(/Canonical test discovery rejected|npm run test:new|Runnable suffixes are forbidden/);
		}
	});

	it("returns a frozen empty inventory when tests is absent", () => {
		const discovery = discoverTests({ repoRoot: root });
		expect(discovery.all).toEqual([]);
		expect(discovery.canonical).toBe(discovery.all);
		expect(discovery.e2eGroups).toEqual({ A: [], B: [], C: [], D: [] });
		expect(Object.isFrozen(discovery.unit)).toBe(true);
	});

	it("does not follow symlinked directories", () => {
		const external = join(root, "external-tests");
		mkdirSync(external, { recursive: true });
		writeFileSync(join(external, "linked.unit.test.ts"), "", "utf8");
		const core = join(root, "tests", "unit", "core");
		mkdirSync(core, { recursive: true });
		symlinkSync(external, join(core, "linked"), process.platform === "win32" ? "junction" : "dir");
		expect(discoverTests({ repoRoot: root }).all).toEqual([]);
	});
});
