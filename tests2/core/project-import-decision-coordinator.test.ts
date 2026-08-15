import { describe, expect, it } from "vitest";
import { ProjectImportDecisionCoordinator } from "../../src/server/agent/project-import-decision-coordinator.ts";

describe("ProjectImportDecisionCoordinator", () => {
	it("persists dispatch outcomes in the project/import trace once without a session", async () => {
		const run = { version: 1 as const, id: "import-1", createdAt: Date.parse("2026-01-01T00:00:00.000Z"), state: "ready" as const };
		const storedRuns = new Map<string, any>();
		const traces: Array<{ projectId: string; importId: string; outcomes: readonly unknown[] }> = [];
		let dispatches = 0;
		const coordinator = new ProjectImportDecisionCoordinator({
			registry: {
				get: (projectId: string) => projectId === "project-1" ? { id: "project-1", rootPath: "/project", importDecisionRun: run } : undefined,
				list: () => [],
			} as any,
			projectContextManager: {
				getOrCreate: () => ({
					decisionRequestStore: {
						getImportRun: (id: string) => storedRuns.get(id),
						ensureImportRun: (value: any) => { storedRuns.set(value.id, value); return { created: true, run: value }; },
					},
					projectConfigStore: { getComponents: () => [] },
				}),
			} as any,
			buildContext: ({ project, importId }) => ({
				event: "projectImported" as const, projectId: project.id, importId, projectRoot: "/project", ownedRoots: ["/project"], components: [],
			}),
			dispatcher: {
				dispatchProjectImport: async () => {
					dispatches++;
					return [{ kind: "decision" as const, packId: "extension-pack", hookId: "import-hook", event: "projectImported" as const, outcome: "applied" as const }];
				},
			},
			trace: { appendProjectImportTrace: (projectId, importId, outcomes) => traces.push({ projectId, importId, outcomes }) },
		});

		const [first, second] = await Promise.all([coordinator.dispatch("project-1", "import-1"), coordinator.dispatch("project-1", "import-1")]);

		expect(first).toEqual(second);
		expect(dispatches).toBe(1);
		expect(storedRuns.get("import-1")?.context).toMatchObject({ event: "projectImported", projectId: "project-1", importId: "import-1" });
		expect(traces).toEqual([{
			projectId: "project-1", importId: "import-1",
			outcomes: [expect.objectContaining({ event: "projectImported", packId: "extension-pack", hookId: "import-hook" })],
		}]);
	});
});
