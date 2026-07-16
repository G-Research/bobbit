/**
 * API/data-path coverage split out of tests/e2e/ui/stories-goal-routing.spec.ts.
 *
 * Browser project-picker and routing stories stay in the UI spec.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch } from "./_e2e/e2e-setup.js";
import { localApiFetch, trackGoal, trackProject } from "./helpers/session-fixtures.js";

/** Create a fresh, isolated temp directory usable as a project rootPath. */
function mkTempDir(label: string): string {
	const dir = mkdtempSync(join(tmpdir(), `bobbit-gr-${label}-`));
	mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
	return dir;
}

interface TestProject { id: string; name: string; rootPath: string; }

async function registerProject(name: string, rootPath: string): Promise<TestProject> {
	const res = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name, rootPath }),
	});
	expect(res.status, `register ${name}`).toBe(201);
	const body = await res.json();
	trackProject(body.id);
	return { id: body.id, name: body.name, rootPath };
}

async function deleteProject(id: string): Promise<void> {
	await apiFetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
}

test.describe("CT-18 goal/session routing API stories", () => {
	// -----------------------------------------------------------
	// GR-06: POST /api/goals requires explicit projectId, even for matching cwd
	// -----------------------------------------------------------

	test("GR-06: API: cwd-only request inside a project is rejected; explicit projectId succeeds", async ({ gateway }) => {
		const rootPath = mkTempDir("explicit");
		const project = await registerProject(`project-${randomUUID()}`, rootPath);
		let goalId: string | undefined;
		try {
			const subCwd = join(project.rootPath, "sub");
			mkdirSync(subCwd, { recursive: true });

			const cwdOnly = await localApiFetch(gateway, "/api/goals", {
				method: "POST",
				body: JSON.stringify({ title: "GR-06 cwd-only", cwd: subCwd, worktree: false }),
			});
			expect(cwdOnly.status, "cwd-only requests must not infer project scope").toBe(400);
			const errorBody = await cwdOnly.json().catch(() => ({}));
			expect(String(errorBody.code ?? errorBody.error ?? "").toLowerCase()).toContain("project");

			const explicit = await apiFetch("/api/goals", {
				method: "POST",
				body: JSON.stringify({ title: "GR-06 explicit", cwd: subCwd, projectId: project.id, worktree: false }),
			});
			expect(explicit.status, await explicit.clone().text()).toBe(201);
			const created = await explicit.json();
			goalId = trackGoal(created.id);
			expect(created.projectId).toBe(project.id);
		} finally {
			if (goalId) await apiFetch(`/api/goals/${goalId}?cascade=true`, { method: "DELETE" }).catch(() => {});
			await deleteProject(project.id);
			rmSync(rootPath, { recursive: true, force: true });
		}
	});

	// -----------------------------------------------------------
	// GR-07: POST /api/goals with no projectId + unresolvable cwd → 400
	// -----------------------------------------------------------

	test("GR-07: API: no projectId + no matching cwd returns 400", async ({ gateway }) => {
		const bogusCwd = mkTempDir("unmatched-goal");
		try {
			const resp = await localApiFetch(gateway, "/api/goals", {
				method: "POST",
				body: JSON.stringify({ title: "GR-07 unmatched", cwd: bogusCwd, worktree: false }),
			});

			expect(resp.status, "must reject rather than fall back to a default project").toBe(400);
			const body = await resp.json().catch(() => ({}));
			const errMsg = (body.error ?? "") as string;
			expect(errMsg.toLowerCase(), `error should mention projectId (got: ${JSON.stringify(body)})`).toContain("projectid required");
		} finally {
			rmSync(bogusCwd, { recursive: true, force: true });
		}
	});

	// -----------------------------------------------------------
	// GR-08: POST /api/sessions with no resolvable project → 400
	// -----------------------------------------------------------

	test("GR-08: API: session creation enforces same contract", async ({ gateway }) => {
		const bogusCwd = mkTempDir("unmatched-session");
		try {
			const resp = await localApiFetch(gateway, "/api/sessions", {
				method: "POST",
				body: JSON.stringify({ cwd: bogusCwd }),
			});

			expect(resp.status, "session creation must reject with 400").toBe(400);
			const body = await resp.json().catch(() => ({}));
			const errMsg = (body.error ?? "") as string;
			expect(errMsg.toLowerCase(), `error should mention projectId (got: ${JSON.stringify(body)})`).toContain("projectid required");
		} finally {
			rmSync(bogusCwd, { recursive: true, force: true });
		}
	});
});
