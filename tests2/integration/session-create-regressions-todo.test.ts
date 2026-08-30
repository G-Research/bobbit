// Ported from tests/e2e/session-create-regressions.spec.ts (straggler-coverage-triage
// PARTIAL — the uncovered sub-behaviour: a failed session creation must leave the
// source goal in `todo` when projectId validation fails). The sandbox-guard /
// projectless edges are covered by core/sandbox-guard + integration/sessions-projectless.
// Faithful port — same assertions, v2 shared compat harness.
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, bobbitDir, registerProject } from "./_e2e/e2e-setup.js";

const tempRoots: string[] = [];

function tempProjectRoot(prefix: string): string {
	const root = mkdtempSync(join(dirname(bobbitDir()), `${prefix}-`));
	tempRoots.push(root);
	return root;
}

async function readJson(resp: Response): Promise<{ text: string; json: any }> {
	const text = await resp.text();
	try { return { text, json: JSON.parse(text) }; }
	catch { return { text, json: {} }; }
}

async function createTempProject(name: string): Promise<{ id: string; rootPath: string }> {
	const project = await registerProject({ name, rootPath: tempProjectRoot(name), seedWorkflows: false });
	return { id: project.id, rootPath: project.rootPath };
}

test.describe("session create regressions", () => {
	test.describe.configure({ mode: "serial" });

	test.afterAll(async () => {
		for (const root of tempRoots.reverse()) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("POST /api/sessions leaves a goal todo when projectId validation fails", async () => {
		const projectA = await createTempProject(`session-goal-a-${Date.now()}`);
		const projectB = await createTempProject(`session-goal-b-${Date.now()}`);
		let goalId = "";
		try {
			const createGoalResp = await apiFetch("/api/goals", {
				method: "POST",
				body: JSON.stringify({
					projectId: projectA.id,
					cwd: projectA.rootPath,
					title: `Validation ordering ${Date.now()}`,
					spec: "Pin that failed session creation does not mutate the source goal state.",
					worktree: false,
				}),
			});
			const created = await readJson(createGoalResp);
			expect(createGoalResp.status, created.text).toBe(201);
			goalId = created.json.id;

			const before = await apiFetch(`/api/goals/${goalId}`);
			expect((await before.json()).state).toBe("todo");

			const resp = await apiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({
					projectId: projectB.id,
					goalId,
					worktree: false,
				}),
			});
			const body = await readJson(resp);

			expect(resp.status, body.text).toBe(422);
			expect(body.json.code).toBe("PROJECT_ID_MISMATCH");

			const after = await apiFetch(`/api/goals/${goalId}`);
			expect((await after.json()).state).toBe("todo");
		} finally {
			if (goalId) await apiFetch(`/api/goals/${goalId}?cascade=true`, { method: "DELETE" }).catch(() => undefined);
		}
	});
});
