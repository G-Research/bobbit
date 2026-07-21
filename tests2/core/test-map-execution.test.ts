// v2-native — focused contract coverage for explicit tests-map execution ownership.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	executionForMaterializedPath,
	loadVitestExecutionMap,
} from "../../scripts/testing-v2/test-map-execution.mjs";

type Execution = {
	runner: string;
	tier: string;
	project: string;
	reason?: string;
};
type TestRecord = { path: string; reason: string; execution: Execution };
type TestMap = { v2Native: TestRecord[]; entries: [] };

const MATERIALIZED_PATHS = [
	"tests2/core/example.test.ts",
	"tests2/dom/example.test.ts",
	"tests2/integration/example.test.ts",
	"tests2/core/bobbit-dir-agent-dir.test.ts",
	"tests2/core/file-mentions-authenticated-boundary.test.ts",
	"tests2/core/git-lifecycle-no-publication-real-git.test.ts",
	"tests2/core/marketplace-install.test.ts",
	"tests2/core/orphan-tool-result-rehydration-boundaries.test.ts",
	"tests2/core/team-manager.test.ts",
] as const;
let root: string;
let mapPath: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "bobbit-map-"));
	for (const area of ["core", "dom", "integration"]) {
		mkdirSync(join(root, "tests2", area), { recursive: true });
	}
	for (const path of MATERIALIZED_PATHS) writeFileSync(join(root, path), "", "utf8");
	mapPath = join(root, "tests2", "tests-map.json");
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function makeFixture(): { root: string; mapPath: string; map: TestMap } {
	const map: TestMap = {
		v2Native: MATERIALIZED_PATHS.map((path) => ({
			path,
			reason: "fixture",
			execution: { ...executionForMaterializedPath(path) },
		})),
		entries: [],
	};
	writeMap(mapPath, map);
	return { root, mapPath, map };
}

function writeMap(target: string, map: TestMap): void {
	writeFileSync(target, JSON.stringify(map), "utf8");
}

function record(map: TestMap, path: string): TestRecord {
	const found = map.v2Native.find((item) => item.path === path);
	if (!found) throw new Error(`Fixture record not found: ${path}`);
	return found;
}

function loadFixture(root: string, mapPath: string) {
	return loadVitestExecutionMap({ repoRoot: root, mapPath });
}

describe("tests-map execution metadata", () => {
	it("accepts path-derived core, dom, integration, isolated, and approved E2E ownership", () => {
		const { root, mapPath } = makeFixture();

		const execution = loadFixture(root, mapPath);

		expect(execution.core).toEqual(["tests2/core/example.test.ts"]);
		expect(execution.dom).toEqual(["tests2/dom/example.test.ts"]);
		expect(execution.integration).toEqual(["tests2/integration/example.test.ts"]);
		expect(execution.isolated).toEqual(["tests2/core/bobbit-dir-agent-dir.test.ts"]);
		expect(execution.e2e).toEqual([
			"tests2/core/file-mentions-authenticated-boundary.test.ts",
			"tests2/core/git-lifecycle-no-publication-real-git.test.ts",
			"tests2/core/marketplace-install.test.ts",
			"tests2/core/orphan-tool-result-rehydration-boundaries.test.ts",
			"tests2/core/team-manager.test.ts",
		]);
	});

	it.each([
		["tests2/core/example.test.ts", { runner: "vitest", tier: "unit", project: "dom" }],
		["tests2/dom/example.test.ts", { runner: "vitest", tier: "unit", project: "integration" }],
		["tests2/integration/example.test.ts", { runner: "vitest", tier: "unit", project: "core" }],
		["tests2/core/example.test.ts", { runner: "vitest", tier: "e2e", project: "e2e" }],
		["tests2/core/git-lifecycle-no-publication-real-git.test.ts", { runner: "vitest", tier: "unit", project: "core" }],
		["tests2/core/orphan-tool-result-rehydration-boundaries.test.ts", { runner: "vitest", tier: "unit", project: "core" }],
		["tests2/core/team-manager.test.ts", { runner: "vitest", tier: "unit", project: "core" }],
	])("rejects cross-tagging %s", (path, execution) => {
		const { root, mapPath, map } = makeFixture();
		record(map, path).execution = execution;
		writeMap(mapPath, map);

		expect(() => loadFixture(root, mapPath)).toThrow(`execution metadata for ${path} must match`);
	});

	it.each([
		["missing", undefined],
		["incorrect", "not the canonical isolated reason"],
	])("rejects %s isolated reasons", (_label, reason) => {
		const { root, mapPath, map } = makeFixture();
		const isolated = record(map, "tests2/core/bobbit-dir-agent-dir.test.ts");
		if (reason === undefined) delete isolated.execution.reason;
		else isolated.execution.reason = reason;
		writeMap(mapPath, map);

		expect(() => loadFixture(root, mapPath)).toThrow("execution metadata for tests2/core/bobbit-dir-agent-dir.test.ts must match");
	});

	it("rejects an isolated reason on a non-isolated project", () => {
		const { root, mapPath, map } = makeFixture();
		record(map, "tests2/core/example.test.ts").execution.reason = "unneeded isolation";
		writeMap(mapPath, map);

		expect(() => loadFixture(root, mapPath)).toThrow("execution metadata for tests2/core/example.test.ts must match");
	});

	it("preserves duplicate ownership and missing physical ownership validation", () => {
		const { root, mapPath, map } = makeFixture();
		map.v2Native.push(structuredClone(record(map, "tests2/core/example.test.ts")));
		map.v2Native = map.v2Native.filter((item) => item.path !== "tests2/integration/example.test.ts");
		map.v2Native.push({
			path: "tests2/core/not-present.test.ts",
			reason: "fixture",
			execution: executionForMaterializedPath("tests2/core/not-present.test.ts"),
		});
		writeMap(mapPath, map);

		try {
			loadFixture(root, mapPath);
			expect.unreachable("invalid fixture should fail");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toContain("duplicate materialized execution ownership");
			expect(message).toContain("tests2/integration/example.test.ts: unit/e2e Vitest file has no execution owner");
			expect(message).toContain("materialized test path does not exist: tests2/core/not-present.test.ts");
		}
	});
});
