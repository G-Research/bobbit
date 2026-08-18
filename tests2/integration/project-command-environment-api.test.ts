/**
 * Command environment declarations must survive project/proposal API paths
 * without ever reflecting the host process environment.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, bobbitDir, createGoal, createSession, deleteGoal, deleteSession } from "./_e2e/e2e-setup.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createFakeVerificationCommandRunner } from "../harness/fake-verification-command-runner.js";
import type { VerificationCommandRunner, VerificationCommandSpawnSpec } from "../../src/server/agent/verification-command-runner.js";

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

	test("captures a running command snapshot while the next invocation reads the newly saved component environment", async ({ gateway }) => {
		let project: Project | undefined;
		let rootPath: string | undefined;
		const goalIds: string[] = [];
		const harness = gateway.teamManager.verificationHarness!;
		const originalRunner = harness.commandStepRunner;
		const fake = createFakeVerificationCommandRunner();
		const spawnSpecs: Array<{ env: NodeJS.ProcessEnv }> = [];
		harness.commandStepRunner = {
			nonDurable: true,
			spawn(spec: VerificationCommandSpawnSpec, options?: Parameters<VerificationCommandRunner["spawn"]>[1]) {
				spawnSpecs.push({ env: { ...spec.env } });
				return fake.spawn(spec, options);
			},
		};
		try {
			({ project, rootPath } = await createProject([{
				name: "api", repo: ".", commands: { test: "node -e \"setTimeout(() => process.exit(0), 250)\"" }, env: { COMPONENT_VALUE: "before" },
			}]));
			const id = `command-env-live-${Date.now()}`;
			const created = await apiFetch("/api/workflows", {
				method: "POST",
				body: JSON.stringify({
					...workflow(id, {
						name: "Snapshot", type: "command", component: "api", command: "test",
						run: undefined, env: { STEP_VALUE: "step" },
					}),
					projectId: project.id,
				}),
			});
			expect(created.status, await created.clone().text()).toBe(201);
			const firstGoal = await createGoal({ title: `Command environment snapshot ${Date.now()}`, projectId: project.id, workflowId: id, worktree: false });
			goalIds.push(firstGoal.id);

			const first = await apiFetch(`/api/goals/${firstGoal.id}/gates/verify/signal`, { method: "POST", body: JSON.stringify({}) });
			expect(first.status, await first.clone().text()).toBe(201);
			await expect.poll(() => spawnSpecs.length).toBe(1);
			expect(spawnSpecs[0].env.COMPONENT_VALUE).toBe("before");
			expect(spawnSpecs[0].env.STEP_VALUE).toBe("step");

			const update = await apiFetch(`/api/projects/${project.id}/config`, {
				method: "PUT",
				body: JSON.stringify({ components: [{ name: "api", repo: ".", commands: { test: "node -e \"setTimeout(() => process.exit(0), 250)\"" }, env: { COMPONENT_VALUE: "after" } }] }),
			});
			expect(update.status).toBe(200);
			// The first spawn owns a copied map, so a live settings write cannot
			// retroactively alter the already-running command.
			expect(spawnSpecs[0].env.COMPONENT_VALUE).toBe("before");

			await expect.poll(async () => (await (await apiFetch(`/api/goals/${firstGoal.id}/gates/verify`)).json()).status).toBe("passed");

			// A re-signal on the same goal and commit correctly reuses its passed
			// verification. A separate goal is a genuine next invocation and must
			// fresh-read the just-saved project store without restarting Bobbit.
			const secondGoal = await createGoal({ title: `Command environment next invocation ${Date.now()}`, projectId: project.id, workflowId: id, worktree: false });
			goalIds.push(secondGoal.id);
			const second = await apiFetch(`/api/goals/${secondGoal.id}/gates/verify/signal`, { method: "POST", body: JSON.stringify({}) });
			expect(second.status, await second.clone().text()).toBe(201);
			await expect.poll(() => spawnSpecs.length).toBe(2);
			expect(spawnSpecs[1].env.COMPONENT_VALUE).toBe("after");
			expect(spawnSpecs[1].env.STEP_VALUE).toBe("step");
		} finally {
			harness.commandStepRunner = originalRunner;
			await Promise.all(goalIds.map((id) => deleteGoal(id)));
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
				body: JSON.stringify({
					...workflow(id, { name: "Review", type: "llm-review", prompt: "review", env: { CI: "1" } }),
					id: undefined,
				}),
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
