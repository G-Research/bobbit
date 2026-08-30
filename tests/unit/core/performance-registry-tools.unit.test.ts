import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPerformanceRoutes } from "../../../market-packs/performance-optimisation/src/performance-routes.ts";
import {
	executePerformanceTool,
	PACK_LOCAL_DATA_ENV,
	PERFORMANCE_PACK_ID,
	PERFORMANCE_TOOL_DEFINITIONS,
	resolvePerformanceLocalDataDirectory,
} from "../../../market-packs/performance-optimisation/src/performance-tools.ts";

const roots: string[] = [];
function tempRoot(label: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), label));
	roots.push(root);
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("performance registry model tools and route", () => {
	it("derives the tool database only from the pack binding and inventories cwd production files", () => {
		const workspace = tempRoot("bobbit-performance-workspace-");
		const localData = tempRoot("bobbit-performance-local-");
		fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
		fs.mkdirSync(path.join(workspace, "tests"), { recursive: true });
		fs.mkdirSync(path.join(workspace, "docs"), { recursive: true });
		fs.writeFileSync(path.join(workspace, "src", "server.ts"), "export const value = 1;\n");
		fs.writeFileSync(path.join(workspace, "tests", "server.test.ts"), "throw new Error('excluded');\n");
		fs.writeFileSync(path.join(workspace, "docs", "design.md"), "excluded\n");

		const env = { [PACK_LOCAL_DATA_ENV]: JSON.stringify({ [PERFORMANCE_PACK_ID]: localData }) } as NodeJS.ProcessEnv;
		expect(resolvePerformanceLocalDataDirectory(env)).toBe(localData);
		const inventoryDependencies = {
			execGit(args: string[], encoding: "buffer" | "utf8") {
				const value = args[0] === "ls-files"
					? "src/server.ts\0tests/server.test.ts\0docs/design.md\0"
					: "fixture-revision\n";
				return encoding === "buffer" ? Buffer.from(value) : value;
			},
		} as any;
		const refreshed = executePerformanceTool("perf_coverage_refresh", {}, { localDataDirectory: localData, cwd: workspace, inventoryDependencies }) as { files: number; structuralUnits: number };
		expect(refreshed).toMatchObject({ files: 1, structuralUnits: 1 });
		const coverage = executePerformanceTool("perf_coverage_get_modules_to_scan", { limit: 10 }, { localDataDirectory: localData }) as { items: Array<{ fileCount: number }> };
		expect(coverage.items).toEqual([expect.objectContaining({ fileCount: 1 })]);
		expect(executePerformanceTool("perf_programme_get_session_context", {}, { localDataDirectory: localData, sessionId: "session-authority" }))
			.toEqual({ sessionId: "session-authority" });
		expect(() => executePerformanceTool("perf_programme_get_session_context", {}, { localDataDirectory: localData, sessionId: "" }))
			.toThrow(/session identity is unavailable/i);
	});

	it("registers bounded schemas for every provider YAML and exposes a panel-compatible snapshot", async () => {
		const localData = tempRoot("bobbit-performance-route-");
		const toolDirectory = path.resolve("market-packs/performance-optimisation/tools/performance-optimisation");
		const providerNames = fs.readdirSync(toolDirectory).filter(file => file.endsWith(".yaml")).map(file => file.replace(/\.yaml$/, "")).sort();
		expect(providerNames).toEqual(PERFORMANCE_TOOL_DEFINITIONS.map(definition => definition.name).sort());
		for (const definition of PERFORMANCE_TOOL_DEFINITIONS) {
			expect(definition.parameters).toMatchObject({ type: "object", additionalProperties: false });
			expect(JSON.stringify(definition.parameters)).not.toMatch(/rootPath|databasePath|projectId/);
		}

		const response = await createPerformanceRoutes()["performance-snapshot"]({ host: { localData: { directory: async () => localData } } });
		expect(response).toMatchObject({ version: 1, revision: 0, registry: [], goals: [], pullRequests: [], coverage: [], activity: [] });
		expect(response).not.toHaveProperty("snapshot");
	});
});
