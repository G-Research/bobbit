/**
 * Regression: a fresh project with NO workflows seeded must still allow
 * goal creation. Pre-fix: server threw NO_WORKFLOWS_MSG → 400. The E2E
 * harness only papered over this by auto-seeding test workflows on every
 * POST /api/projects in apiFetch, so production users hitting the same
 * path would get "Failed to create goal: 400".
 *
 * Post-fix: server falls back to the built-in defaults from
 * `buildDefaultWorkflows` when both the cascade and the project store are
 * empty. The `__e2e_seed_skip__` marker on POST /api/projects bypasses
 * the harness auto-seed so this test exercises the SERVER fallback only.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";

function makeRepo(label: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `bobbit-noseed-${label}-`));
	execSync("git init -q -b master && git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init", { cwd: root, stdio: "ignore" });
	return root;
}

test.describe("Goal creation auto-seeds workflows when project has none", () => {
	test("fresh project + goal creation succeeds without prior workflow seed @smoke", async () => {
		// `__e2e_seed_skip__: true` opts out of harness's apiFetch auto-seed
		// so this test exercises the SERVER fallback (buildDefaultWorkflows)
		// — exactly what production users hit when they create a project
		// via the simple "New Project" flow without running project setup.
		const cwd = makeRepo("p1");
		const projResp = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "noseed-1-" + Date.now(), rootPath: cwd, __e2e_seed_skip__: true }),
		});
		expect(projResp.status, `project create body=${await projResp.clone().text()}`).toBe(201);
		const proj = await projResp.json();
		expect(proj.id).toBeTruthy();

		// Confirm project really has no workflows seeded.
		const wfResp = await apiFetch(`/api/workflows?projectId=${proj.id}`);
		expect(wfResp.status).toBe(200);
		const wfBody = await wfResp.json();
		const wfList = Array.isArray(wfBody) ? wfBody : (wfBody.workflows ?? []);
		expect(wfList).toEqual([]);

		// Goal creation — pre-fix returned 400; post-fix returns 201.
		const goalResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "Goal on a project with no workflows",
				spec: "Smoke test for auto-seed fallback",
				projectId: proj.id,
				cwd,
			}),
		});
		const goalText = await goalResp.clone().text();
		expect(goalResp.status, `goal creation should succeed; body=${goalText}`).toBe(201);
		const goal = await goalResp.json();
		expect(goal.id).toBeTruthy();
		expect(goal.workflowId).toBe("general");
		expect(goal.workflow).toBeTruthy();
		expect(goal.workflow.gates.length).toBeGreaterThan(0);

		await apiFetch(`/api/goals/${goal.id}?cascade=false`, { method: "DELETE" }).catch(() => {});
	});

	test("inline workflow body bypasses cascade and uses the snapshot directly", async () => {
		const cwd = makeRepo("p2");
		const projResp = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "noseed-2-" + Date.now(), rootPath: cwd, __e2e_seed_skip__: true }),
		});
		expect(projResp.status, `project create body=${await projResp.clone().text()}`).toBe(201);
		const proj = await projResp.json();

		const inlineWorkflow = {
			id: "custom",
			name: "Custom inline",
			description: "A user-supplied workflow",
			gates: [
				{ id: "design-doc", name: "Design", dependsOn: [], content: true, verify: [] },
				{ id: "ready-to-merge", name: "Ready to merge", dependsOn: ["design-doc"], verify: [] },
			],
			createdAt: 0,
			updatedAt: 0,
		};

		const goalResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "Goal with inline workflow",
				spec: "Testing inline-YAML path",
				projectId: proj.id,
				cwd,
				workflow: inlineWorkflow,
			}),
		});
		const goalText = await goalResp.clone().text();
		expect(goalResp.status, `inline workflow goal creation should succeed; body=${goalText}`).toBe(201);
		const goal = await goalResp.json();
		expect(goal.workflowId).toBe("custom");
		expect(goal.workflow.gates.map((g: { id: string }) => g.id)).toEqual(["design-doc", "ready-to-merge"]);

		await apiFetch(`/api/goals/${goal.id}?cascade=false`, { method: "DELETE" }).catch(() => {});
	});
});
