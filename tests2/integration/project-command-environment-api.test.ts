/**
 * Command environment declarations must survive project/proposal API paths
 * without ever reflecting the host process environment.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, bobbitDir, createSession, deleteSession } from "./_e2e/e2e-setup.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

interface Project { id: string }

function root(): string {
	return mkdtempSync(join(bobbitDir(), "command-env-api-"));
}

async function createProject(components: unknown[]): Promise<{ project: Project; rootPath: string }> {
	const rootPath = root();
	const response = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({
			name: `command-env-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			rootPath,
			components,
			__e2e_seed_skip__: true,
		}),
	});
	expect(response.status, await response.clone().text()).toBe(201);
	return { project: await response.json(), rootPath };
}

async function removeProject(project: Project | undefined, rootPath: string | undefined): Promise<void> {
	if (project) await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
	if (rootPath) rmSync(rootPath, { recursive: true, force: true });
}

function workflow(id: string, step: Record<string, unknown>) {
	return {
		id,
		name: id,
		description: "command environment API coverage",
		gates: [{ id: "verify", name: "Verify", depends_on: [], verify: [step] }],
	};
}

test.describe("Project command environment API", () => {
	test("POST, PUT, GET structured, promotion, and live store reads preserve declared env only", async ({ gateway }) => {
		let project: Project | undefined;
		let rootPath: string | undefined;
		try {
			({ project, rootPath } = await createProject([{
				name: "api",
				repo: ".",
				commands: { test: "node test.js" },
				env: { NODE_OPTIONS: "--max-old-space-size=4096", EMPTY: "" },
				config: { qa_max_scenarios: "3" },
			}]));

			let structured = await (await apiFetch(`/api/projects/${project.id}/structured`)).json();
			expect(structured.components).toEqual([{
				name: "api", repo: ".", commands: { test: "node test.js" },
				env: { NODE_OPTIONS: "--max-old-space-size=4096", EMPTY: "" },
				config: { qa_max_scenarios: "3" },
			}]);
			// This endpoint returns declarations—not the effective environment copied
			// from Bobbit's process—so a common host-only variable cannot leak.
			expect(structured.components[0].env.PATH).toBeUndefined();

			const update = await apiFetch(`/api/projects/${project.id}/config`, {
				method: "PUT",
				body: JSON.stringify({ components: [{
					name: "api", repo: ".", commands: { test: "node test.js", check: "node check.js" },
					env: { CI: "1", EMPTY: "" }, config: { qa_max_scenarios: "3" },
				}] }),
			});
			expect(update.status).toBe(200);
			// The same live ProjectConfigStore is read by the next command invocation;
			// no gateway restart or cache invalidation is required for this read.
			expect(gateway.projectContextManager.getOrCreate(project.id)?.projectConfigStore.getComponent("api")?.env)
				.toEqual({ CI: "1", EMPTY: "" });

			structured = await (await apiFetch(`/api/projects/${project.id}/structured`)).json();
			expect(structured.components[0]).toMatchObject({
				commands: { test: "node test.js", check: "node check.js" },
				env: { CI: "1", EMPTY: "" }, config: { qa_max_scenarios: "3" },
			});
			expect((await apiFetch(`/api/projects/${project.id}/config`)).status).toBe(200);

			const promoted = await apiFetch(`/api/projects/${project.id}/promote`, { method: "POST", body: JSON.stringify({}) });
			expect(promoted.status).toBe(200);
			structured = await (await apiFetch(`/api/projects/${project.id}/structured`)).json();
			expect(structured.components[0].env).toEqual({ CI: "1", EMPTY: "" });
		} finally {
			await removeProject(project, rootPath);
		}
	});

	test("rejects malformed and case-colliding component environment maps before project mutation", async () => {
		for (const env of [{ "NOT-VALID": "1" }, { Path: "a", PATH: "b" }, { OK: 7 }]) {
			const response = await apiFetch("/api/projects", {
				method: "POST",
				body: JSON.stringify({
					name: `command-env-invalid-${Date.now()}-${Math.random().toString(36).slice(2)}`,
					rootPath: root(), components: [{ name: "api", repo: ".", env }],
				}),
			});
			expect(response.status, await response.clone().text()).toBe(400);
		}
	});

	test("workflow APIs preserve command overrides and reject them on non-command steps", async () => {
		let project: Project | undefined;
		let rootPath: string | undefined;
		try {
			({ project, rootPath } = await createProject([{ name: "api", repo: ".", commands: { test: "node test.js" }, env: { CI: "0" } }]));
			const id = `command-env-workflow-${Date.now()}`;
			const created = await apiFetch("/api/workflows", {
				method: "POST",
				body: JSON.stringify({ ...workflow(id, { name: "Test", type: "command", component: "api", command: "test", env: { CI: "1" } }), projectId: project.id }),
			});
			expect(created.status, await created.clone().text()).toBe(201);
			const fetched = await (await apiFetch(`/api/workflows/${id}?projectId=${project.id}`)).json();
			expect(fetched.gates[0].verify[0].env).toEqual({ CI: "1" });

			const rejected = await apiFetch(`/api/workflows/${id}?projectId=${project.id}`, {
				method: "PUT",
				body: JSON.stringify(workflow(id, { name: "Review", type: "llm-review", prompt: "review", env: { CI: "1" } })),
			});
			expect(rejected.status, await rejected.clone().text()).toBe(400);
			expect(await rejected.text()).toMatch(/env/i);
		} finally {
			await removeProject(project, rootPath);
		}
	});

	test("project proposal schema round-trips declared environment without host values", async () => {
		const sessionId = await createSession();
		try {
			const seeded = await apiFetch(`/api/sessions/${sessionId}/proposal/project/seed`, {
				method: "POST",
				body: JSON.stringify({ args: {
					name: "proposal-command-env", root_path: root(),
					components: [{ name: "api", repo: ".", commands: { test: "node test.js" }, env: { CI: "1" } }],
					workflows: { feature: workflow("feature", { name: "Test", type: "command", component: "api", command: "test", env: { CI: "2" } }) },
				} }),
			});
			expect(seeded.status, await seeded.clone().text()).toBe(200);
			const proposal = await (await apiFetch(`/api/sessions/${sessionId}/proposal/project`)).text();
			expect(proposal).toMatch(/env:\n\s+CI: "1"/);
			expect(proposal).toMatch(/env:\n\s+CI: "2"/);
			expect(proposal).not.toMatch(/PATH:/);
		} finally {
			await deleteSession(sessionId);
		}
	});
});
