import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, createGoal, defaultProject, defaultProjectId, deleteGoal, nonGitCwd } from "./_e2e/e2e-setup.js";
import { gateDiagnosticsGoalDir } from "../../src/server/agent/gate-diagnostics-cleanup.js";

const SPEC = "Gate diagnostics cleanup E2E goal spec padded enough to satisfy goal creation validation.";

async function setSubgoalsEnabled(enabled: boolean): Promise<void> {
	const resp = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ subgoalsEnabled: enabled }),
	});
	expect(resp.status).toBe(200);
}

function seedDiagnostics(stateDir: string, goalId: string): string {
	const dir = gateDiagnosticsGoalDir(goalId, stateDir);
	fs.mkdirSync(path.join(dir, "gate", "signal", "step"), { recursive: true });
	fs.writeFileSync(path.join(dir, "gate", "signal", "step", "stdout.log"), `diagnostics for ${goalId}`, "utf-8");
	return dir;
}

async function createChild(parentId: string): Promise<string> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `diagnostic cleanup child ${Date.now()}`,
			cwd: nonGitCwd(),
			worktree: false,
			autoStartTeam: false,
			workflowId: "feature",
			spec: SPEC,
			projectId: await defaultProjectId(),
			parentGoalId: parentId,
		}),
	});
	expect(resp.status).toBe(201);
	return ((await resp.json()) as { id: string }).id;
}

test("cascade archiving a goal tree removes retained diagnostics for parent and child goals", async () => {
	await setSubgoalsEnabled(true);
	const project = await defaultProject();
	const stateDir = path.join(project.rootPath, ".bobbit", "state");
	const parent = await createGoal({
		title: `diagnostic cleanup parent ${Date.now()}`,
		spec: SPEC,
		autoStartTeam: false,
		subgoalsAllowed: true,
	});
	let childId: string | undefined;
	try {
		childId = await createChild(parent.id as string);
		const parentDir = seedDiagnostics(stateDir, parent.id as string);
		const childDir = seedDiagnostics(stateDir, childId);
		const unrelatedDir = seedDiagnostics(stateDir, "unrelated-goal");

		const resp = await apiFetch(`/api/goals/${parent.id}?cascade=true`, { method: "DELETE" });
		expect(resp.status).toBe(200);
		expect((await resp.json()).archived).toBe(2);

		expect(fs.existsSync(parentDir), "parent diagnostics should be removed").toBe(false);
		expect(fs.existsSync(childDir), "child diagnostics should be removed").toBe(false);
		expect(fs.existsSync(unrelatedDir), "unrelated diagnostics should be preserved").toBe(true);
	} finally {
		if (childId) await deleteGoal(childId).catch(() => {});
		await deleteGoal(parent.id as string).catch(() => {});
	}
});
