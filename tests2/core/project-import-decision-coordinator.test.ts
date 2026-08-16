import { describe, expect, it } from "vitest";
import { ProjectImportDecisionCoordinator } from "../../src/server/agent/project-import-decision-coordinator.ts";

describe("ProjectImportDecisionCoordinator", () => {
	it("persists dispatch outcomes in the project/import trace once without a session", async () => {
		const run = { version: 1 as const, id: "import-1", createdAt: Date.parse("2026-01-01T00:00:00.000Z"), state: "ready" as const };
		const storedRuns = new Map<string, any>();
		const traces: Array<{ projectId: string; importId: string; outcomes: readonly unknown[] }> = [];
		let runCreations = 0;
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
						ensureImportRun: (value: any) => { runCreations++; storedRuns.set(value.id, value); return { created: true, run: value }; },
					},
					projectConfigStore: { getComponents: () => [] },
				}),
			} as any,
			buildContext: ({ project, importId }) => ({
				event: "projectImported" as const, projectId: project.id, importId, projectRoot: "/project", ownedRoots: ["/project"], components: [],
			}),
			canonicalProjectRoot: project => project.rootPath,
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
		expect(runCreations).toBe(1, "the ready marker creates one durable import store before dispatch");
		expect(storedRuns.get("import-1")?.context).toMatchObject({ event: "projectImported", projectId: "project-1", importId: "import-1" });
		expect(traces).toEqual([{
			projectId: "project-1", importId: "import-1",
			outcomes: [expect.objectContaining({ event: "projectImported", packId: "extension-pack", hookId: "import-hook" })],
		}]);
	});

	it("awaits every bounded dispatch before resolving while projects reconcile concurrently", async () => {
		const runs = new Map<string, any>();
		const mutations: string[] = [];
		const errors: string[] = [];
		const traces: string[] = [];
		const ready = (id: string) => ({ version: 1 as const, id: `import-${id}`, createdAt: Date.now(), state: "ready" as const });
		let releaseFirst!: () => void;
		let firstStarted!: () => void;
		const firstDispatch = new Promise<void>(resolve => { releaseFirst = resolve; });
		const firstStartedPromise = new Promise<void>(resolve => { firstStarted = resolve; });
		const coordinator = new ProjectImportDecisionCoordinator({
			registry: {
				get: (projectId: string) => ["project-1", "project-2", "project-3"].includes(projectId)
					? { id: projectId, rootPath: `/${projectId}`, importDecisionRun: ready(projectId) }
					: undefined,
				list: () => ["project-1", "project-2", "project-3"].map(id => ({ id, rootPath: `/${id}`, importDecisionRun: ready(id) })),
			} as any,
			projectContextManager: {
				getOrCreate: () => ({
					decisionRequestStore: {
						getImportRun: (id: string) => runs.get(id),
						ensureImportRun: (run: any) => { runs.set(run.id, run); return { created: true, run }; },
					},
					projectConfigStore: { getComponents: () => [] },
				}),
			} as any,
			buildContext: ({ project, importId }) => ({
				event: "projectImported" as const, projectId: project.id, importId, projectRoot: project.rootPath, ownedRoots: [project.rootPath], components: [],
			}),
			canonicalProjectRoot: project => project.rootPath,
			dispatcher: {
				dispatchProjectImport: async (projectId) => {
					if (projectId === "project-1") {
						firstStarted();
						await firstDispatch;
						mutations.push(projectId);
					} else if (projectId === "project-2") {
						mutations.push(projectId);
					} else {
						throw new Error("isolated replay failure");
					}
					return [{ kind: "decision" as const, packId: "extension-pack", hookId: "import-hook", event: "projectImported" as const, outcome: "applied" as const }];
				},
			},
			onError: projectId => errors.push(projectId),
			trace: { appendProjectImportTrace: projectId => traces.push(projectId) },
		});

		let resolved = false;
		const replay = coordinator.reconcileAll().then(() => { resolved = true; });
		await firstStartedPromise;

		// project-2 completes even though project-1 remains live; the failed
		// project is contained instead of preventing either reconciliation.
		expect(mutations).toEqual(["project-2"]);
		expect(resolved).toBe(false);
		releaseFirst();
		await replay;

		expect(mutations).toEqual(["project-2", "project-1"]);
		expect(errors).toEqual(["project-3"]);
		expect(traces).toEqual(["project-2", "project-1"]);
		const mutationsAtResolution = [...mutations];
		await Promise.resolve();
		expect(mutations).toEqual(mutationsAtResolution);
	});

	it("fails closed before dispatching a stale durable project root", async () => {
		const run = { version: 1 as const, id: "import-1", createdAt: Date.now(), state: "ready" as const };
		let dispatched = 0;
		const coordinator = new ProjectImportDecisionCoordinator({
			registry: {
				get: () => ({ id: "project-1", rootPath: "/registered-project", importDecisionRun: run }),
				list: () => [],
			} as any,
			projectContextManager: {
				getOrCreate: () => ({
					decisionRequestStore: {
						getImportRun: () => ({
							id: "import-1", projectId: "project-1", createdAt: new Date().toISOString(), hooks: {},
							context: { event: "projectImported", projectId: "project-1", importId: "import-1", projectRoot: "/forged-project", ownedRoots: ["/forged-project"], components: [] },
						}),
						ensureImportRun: () => { throw new Error("must not replace a durable run"); },
					},
					projectConfigStore: { getComponents: () => [] },
				}),
			} as any,
			buildContext: () => { throw new Error("must not rebuild a durable run"); },
			canonicalProjectRoot: project => project.rootPath,
			dispatcher: { dispatchProjectImport: async () => { dispatched++; return []; } },
		});

		await coordinator.dispatch("project-1", "import-1");
		expect(dispatched).toBe(0);
	});
});
