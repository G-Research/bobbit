/**
 * E2E tests: POST /api/goals accepts nested-goals fields.
 *
 * Covers task 1.4 of the nested-goals workflow:
 *   - Happy path: creating a child goal under an existing parent populates
 *     parentGoalId, rootGoalId, and mergeTarget="parent" on the response.
 *   - Cross-project rejection: parent in a different project → 400.
 *   - Archived parent rejection → 400.
 *   - maxConcurrentChildren range validation [1, 8] → 400 outside.
 *   - divergencePolicy enum validation → 400 on bad values.
 *
 * NOTE: these tests deliberately bypass the harness's auto-injected
 * `projectId` for the cross-project case (`apiFetch` in e2e-setup injects
 * the harness's default projectId when missing). We pass an explicit
 * projectId in the request body so the cross-project parent triggers the
 * server-side check inside `goalManager.createGoal`.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, nonGitCwd, defaultProjectId } from "./e2e-setup.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

let _counter = 0;
function uniqueProjectDir(label: string): string {
	const dir = join(nonGitCwd(), `proj-nesting-${label}-${Date.now()}-${++_counter}`);
	mkdirSync(dir, { recursive: true });
	mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
	return dir;
}

async function registerProject(name: string): Promise<{ id: string; rootPath: string }> {
	const rootPath = uniqueProjectDir(name);
	const resp = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name, rootPath }),
	});
	expect(resp.status).toBe(201);
	const proj = await resp.json();
	return { id: proj.id, rootPath };
}

async function removeProject(id: string): Promise<void> {
	await apiFetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => { });
}

async function createGoalRaw(body: Record<string, unknown>): Promise<Response> {
	return apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

test.describe("POST /api/goals — nested-goals fields", () => {
	test("happy path: child goal carries parentGoalId, rootGoalId, mergeTarget=parent", async () => {
		const projectId = await defaultProjectId();
		expect(projectId).toBeTruthy();

		// Create the parent.
		const parentResp = await createGoalRaw({
			title: `Nesting Parent ${Date.now()}`,
			cwd: nonGitCwd(),
			team: false,
			worktree: false,
			workflowId: "general",
			projectId,
			autoStartTeam: false,
		});
		expect(parentResp.status).toBe(201);
		const parent = await parentResp.json();
		expect(parent.id).toBeTruthy();
		expect(parent.parentGoalId).toBeUndefined();
		expect(parent.rootGoalId).toBe(parent.id);
		expect(parent.mergeTarget).toBe("master");

		try {
			// Create a child under the parent.
			const childResp = await createGoalRaw({
				title: `Nesting Child ${Date.now()}`,
				cwd: nonGitCwd(),
				team: false,
				worktree: false,
				workflowId: "general",
				projectId,
				autoStartTeam: false,
				parentGoalId: parent.id,
				divergencePolicy: "balanced",
				maxConcurrentChildren: 4,
			});
			expect(childResp.status).toBe(201);
			const child = await childResp.json();
			expect(child.id).toBeTruthy();
			expect(child.id).not.toBe(parent.id);
			expect(child.parentGoalId).toBe(parent.id);
			expect(child.rootGoalId).toBe(parent.id);
			expect(child.mergeTarget).toBe("parent");
			expect(child.divergencePolicy).toBe("balanced");
			expect(child.maxConcurrentChildren).toBe(4);

			await apiFetch(`/api/goals/${child.id}`, { method: "DELETE" }).catch(() => { });
		} finally {
			await apiFetch(`/api/goals/${parent.id}`, { method: "DELETE" }).catch(() => { });
		}
	});

	test("cross-project parent is rejected with 400", async () => {
		const defaultPid = await defaultProjectId();
		expect(defaultPid).toBeTruthy();
		const otherProject = await registerProject(`cross-project-${Date.now()}`);
		try {
			// Parent lives in `otherProject`.
			const parentResp = await createGoalRaw({
				title: `Cross Parent ${Date.now()}`,
				cwd: otherProject.rootPath,
				team: false,
				worktree: false,
				workflowId: "general",
				projectId: otherProject.id,
				autoStartTeam: false,
			});
			expect(parentResp.status).toBe(201);
			const parent = await parentResp.json();
			try {
				// Child claims projectId = default (different project).
				const childResp = await createGoalRaw({
					title: `Cross Child ${Date.now()}`,
					cwd: nonGitCwd(),
					team: false,
					worktree: false,
					workflowId: "general",
					projectId: defaultPid,
					autoStartTeam: false,
					parentGoalId: parent.id,
				});
				expect(childResp.status).toBe(400);
				const body = await childResp.json();
				expect(body.error).toBeTruthy();
				// Per-project goal stores mean a parent in another project either
				// trips the cross-project invariant or simply isn't visible in the
				// child's project store ("Parent goal not found"). Either is a
				// valid 400 — accept both messages.
				expect(String(body.error).toLowerCase()).toMatch(/cross-project|parent goal not found/);
			} finally {
				await apiFetch(`/api/goals/${parent.id}`, { method: "DELETE" }).catch(() => { });
			}
		} finally {
			await removeProject(otherProject.id);
		}
	});

	test("archived parent is rejected with 400", async () => {
		const projectId = await defaultProjectId();
		expect(projectId).toBeTruthy();
		const parentResp = await createGoalRaw({
			title: `Archived Parent ${Date.now()}`,
			cwd: nonGitCwd(),
			team: false,
			worktree: false,
			workflowId: "general",
			projectId,
			autoStartTeam: false,
		});
		expect(parentResp.status).toBe(201);
		const parent = await parentResp.json();

		// Archive the parent (DELETE /api/goals/:id archives, doesn't hard delete).
		const delResp = await apiFetch(`/api/goals/${parent.id}`, { method: "DELETE" });
		expect(delResp.status).toBe(200);

		// Now try to create a child under the archived parent.
		const childResp = await createGoalRaw({
			title: `Archived Child ${Date.now()}`,
			cwd: nonGitCwd(),
			team: false,
			worktree: false,
			workflowId: "general",
			projectId,
			autoStartTeam: false,
			parentGoalId: parent.id,
		});
		expect(childResp.status).toBe(400);
		const body = await childResp.json();
		expect(body.error).toBeTruthy();
		expect(String(body.error).toLowerCase()).toContain("archived");
	});

	test("maxConcurrentChildren = 0 is rejected with 400", async () => {
		const projectId = await defaultProjectId();
		const resp = await createGoalRaw({
			title: `MCC Zero ${Date.now()}`,
			cwd: nonGitCwd(),
			team: false,
			worktree: false,
			workflowId: "general",
			projectId,
			autoStartTeam: false,
			maxConcurrentChildren: 0,
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(String(body.error)).toMatch(/maxConcurrentChildren/i);
	});

	test("maxConcurrentChildren = 9 is rejected with 400", async () => {
		const projectId = await defaultProjectId();
		const resp = await createGoalRaw({
			title: `MCC Nine ${Date.now()}`,
			cwd: nonGitCwd(),
			team: false,
			worktree: false,
			workflowId: "general",
			projectId,
			autoStartTeam: false,
			maxConcurrentChildren: 9,
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(String(body.error)).toMatch(/maxConcurrentChildren/i);
	});

	test("divergencePolicy enum is validated — 'lol' rejected with 400", async () => {
		const projectId = await defaultProjectId();
		const resp = await createGoalRaw({
			title: `Bad Policy ${Date.now()}`,
			cwd: nonGitCwd(),
			team: false,
			worktree: false,
			workflowId: "general",
			projectId,
			autoStartTeam: false,
			divergencePolicy: "lol",
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(String(body.error)).toMatch(/divergencePolicy/i);
	});

	// ── Security hardening (F4) ────────────────────────────────────────────

	test("baseBranch with shell-flag-style payload is rejected with 400", async () => {
		// Defense-in-depth: baseBranch flows into git CLI invocations. A payload
		// like `--upload-pack=evil` or anything outside [A-Za-z0-9._/-] must be
		// rejected before it reaches `git`.
		const projectId = await defaultProjectId();
		const resp = await createGoalRaw({
			title: `Bad BaseBranch ${Date.now()}`,
			cwd: nonGitCwd(),
			team: false,
			worktree: false,
			workflowId: "general",
			projectId,
			autoStartTeam: false,
			baseBranch: "--upload-pack=evil",
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.field).toBe("baseBranch");
		expect(String(body.error)).toMatch(/baseBranch must match/i);
	});

	test("oversized inlineRoles prompt (>64KB) is rejected with 400", async () => {
		// Defense-in-depth: snapshot inline roles are re-rendered into every
		// team-lead system prompt; a 70KB prompt exceeds the 64KB cap.
		const projectId = await defaultProjectId();
		const resp = await createGoalRaw({
			title: `Oversized Inline Role ${Date.now()}`,
			cwd: nonGitCwd(),
			team: false,
			worktree: false,
			workflowId: "general",
			projectId,
			autoStartTeam: false,
			inlineRoles: {
				coder: {
					label: "Coder",
					prompt: "x".repeat(70_000),
				},
			},
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.field).toBe("inlineRoles");
		expect(String(body.error)).toMatch(/exceeds.*chars/i);
	});
});
