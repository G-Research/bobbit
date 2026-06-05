/**
 * API/data-path coverage split out of tests/e2e/ui/stories-goal-routing.spec.ts.
 *
 * Browser project-picker and routing stories stay in the UI spec.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, rawApiFetch } from "./e2e-setup.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
	return { id: body.id, name: body.name, rootPath };
}

async function deleteProject(id: string): Promise<void> {
	await apiFetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
}

function requireProject(project: TestProject | undefined, label: string): TestProject {
	if (!project) throw new Error(`project ${label} was not registered`);
	return project;
}

test.describe("CT-18 goal/session routing API stories", () => {
	let projA: TestProject | undefined;
	let projB: TestProject | undefined;
	let tempDirs: string[] = [];
	let goalsToCleanup: string[] = [];

	test.beforeEach(async () => {
		projA = undefined;
		projB = undefined;
		tempDirs = [];
		goalsToCleanup = [];
		const dirA = mkTempDir("A");
		const dirB = mkTempDir("B");
		tempDirs.push(dirA, dirB);
		projA = await registerProject(`project-a-${Date.now()}`, dirA);
		projB = await registerProject(`project-b-${Date.now() + 1}`, dirB);
	});

	test.afterEach(async () => {
		for (const id of goalsToCleanup.splice(0)) {
			await apiFetch(`/api/goals/${id}`, { method: "DELETE" }).catch(() => {});
		}
		if (projA) await deleteProject(projA.id);
		if (projB) await deleteProject(projB.id);
		for (const d of tempDirs.splice(0)) {
			try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
		}
	});

	// -----------------------------------------------------------
	// GR-06: POST /api/goals with cwd only resolves to matching project
	// -----------------------------------------------------------

	test("GR-06: API: cwd-only request resolves project", async () => {
		const projectB = requireProject(projB, "B");

		// cwd is a subpath inside B's rootPath and does not match A.
		const subCwd = join(projectB.rootPath, "sub");
		mkdirSync(subCwd, { recursive: true });

		// Use rawApiFetch so the harness default-projectId injection doesn't
		// short-circuit the cwd-only resolution we're exercising.
		const resp = await rawApiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "GR-06 cwd-only", cwd: subCwd, worktree: false }),
		});

		expect(resp.status, "cwd-only request should succeed when cwd is inside a registered project").toBe(201);
		const created = await resp.json();
		goalsToCleanup.push(created.id);
		expect(created.projectId, "goal routed to project B via cwd match").toBe(projectB.id);
	});

	// -----------------------------------------------------------
	// GR-07: POST /api/goals with no projectId + unresolvable cwd → 400
	// -----------------------------------------------------------

	test("GR-07: API: no projectId + no matching cwd returns 400", async () => {
		const bogusCwd = join(tmpdir(), `bobbit-gr07-bogus-${Date.now()}`);
		tempDirs.push(bogusCwd);
		mkdirSync(bogusCwd, { recursive: true });

		const resp = await rawApiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "GR-07 unmatched", cwd: bogusCwd, worktree: false }),
		});

		expect(resp.status, "must reject rather than fall back to a default project").toBe(400);
		const body = await resp.json().catch(() => ({}));
		const errMsg = (body.error ?? "") as string;
		expect(errMsg.toLowerCase(), `error should mention projectId (got: ${JSON.stringify(body)})`).toContain("projectid required");
	});

	// -----------------------------------------------------------
	// GR-08: POST /api/sessions with no resolvable project → 400
	// -----------------------------------------------------------

	test("GR-08: API: session creation enforces same contract", async () => {
		const bogusCwd = join(tmpdir(), `bobbit-gr08-bogus-${Date.now()}`);
		tempDirs.push(bogusCwd);
		mkdirSync(bogusCwd, { recursive: true });

		const resp = await rawApiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: bogusCwd }),
		});

		expect(resp.status, "session creation must reject with 400").toBe(400);
		const body = await resp.json().catch(() => ({}));
		const errMsg = (body.error ?? "") as string;
		expect(errMsg.toLowerCase(), `error should mention projectId (got: ${JSON.stringify(body)})`).toContain("projectid required");
	});
});
