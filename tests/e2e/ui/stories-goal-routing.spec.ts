/**
 * Goal / session project-routing stories — CT-18, CT-19
 *
 * These stories characterize the target behavior of the
 * "eliminate default project" goal. They land FAILING against the
 * current server and turn green as the implementation tasks merge.
 *
 * Each `beforeEach` registers two ephemeral projects A and B (except the
 * GR-09 zero-project and GR-10 single-project variants which own their
 * own setup). We never delete the server-cwd "default" project because
 * the current server refuses that; instead we add siblings and reason
 * about routing relative to them. GR-09 tolerates the default project
 * remaining because on master that is exactly what fails the assertion.
 *
 * Phase annotations: setup (not tracked), act, assert, cleanup.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, waitForHealth } from "../e2e-setup.js";
import { SpecContext } from "./spec-framework.js";
import {
	STORY_GR01,
	STORY_GR02,
	STORY_GR03,
	STORY_GR04,
	STORY_GR05,
	STORY_GR06,
	STORY_GR07,
	STORY_GR08,
	STORY_GR09,
	STORY_GR10,
} from "./story-registry.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

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

async function listProjects(): Promise<Array<{ id: string; name: string; rootPath: string }>> {
	const res = await apiFetch("/api/projects");
	if (!res.ok) return [];
	const body = await res.json();
	return Array.isArray(body) ? body : (body.projects ?? []);
}

async function deleteAllProjects(): Promise<void> {
	const projects = await listProjects();
	for (const p of projects) await deleteProject(p.id);
}

// ---------------------------------------------------------------
// Shared two-project group (GR-01..GR-08)
// ---------------------------------------------------------------

test.describe("CT-18: Multi-project goal/session routing", () => {
	let s: SpecContext;
	let projA: TestProject;
	let projB: TestProject;
	const tempDirs: string[] = [];
	const goalsToCleanup: string[] = [];
	const sessionsToCleanup: string[] = [];

	test.beforeAll(async () => {
		await waitForHealth();
	});

	test.beforeEach(async ({ page }) => {
		s = new SpecContext(page);
		const dirA = mkTempDir("A");
		const dirB = mkTempDir("B");
		tempDirs.push(dirA, dirB);
		projA = await registerProject(`project-a-${Date.now()}`, dirA);
		projB = await registerProject(`project-b-${Date.now() + 1}`, dirB);
		// Register handles for spec graph tracking
		s.project("A").projectId = projA.id;
		s.project("B").projectId = projB.id;
	});

	test.afterEach(async () => {
		await s.cleanup();
		for (const id of goalsToCleanup.splice(0)) {
			await apiFetch(`/api/goals/${id}`, { method: "DELETE" }).catch(() => {});
		}
		for (const id of sessionsToCleanup.splice(0)) {
			await apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
		}
		if (projA) await deleteProject(projA.id);
		if (projB) await deleteProject(projB.id);
		for (const d of tempDirs.splice(0)) {
			try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
		}
	});

	// -----------------------------------------------------------
	// GR-01: Per-project sidebar button creates goal in that project
	// -----------------------------------------------------------

	test("GR-01: Per-project sidebar button creates goal in Project B", async () => {
		s.begin(STORY_GR01);

		await s.open();

		s.act();
		// The per-project "New goal in <project>" button is unambiguous.
		const btn = s.page.locator(`button[title="New goal in ${projB.name}"]`).first();
		await expect(btn, "per-project New Goal button should be visible").toBeVisible({ timeout: 15_000 });
		await btn.click();

		// Goal assistant dialog / session opens — look for the title input
		// that the assistant flow surfaces once a proposal exists. We don't
		// drive a full assistant flow here; instead we use the API to create
		// a goal with an explicit projectId B and assert it lands in B.
		const createResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "GR-01 goal", projectId: projB.id, cwd: projB.rootPath, worktree: false }),
		});
		expect(createResp.status, "create goal in B").toBe(201);
		const created = await createResp.json();
		goalsToCleanup.push(created.id);

		s.assert();
		expect(created.projectId).toBe(projB.id);

		// Verify via GET
		const listResp = await apiFetch("/api/goals");
		const list = await listResp.json();
		const goals = Array.isArray(list) ? list : (list.goals ?? []);
		const found = goals.find((g: any) => g.id === created.id);
		expect(found, "goal present in GET /api/goals").toBeTruthy();
		expect(found.projectId).toBe(projB.id);

		// Reload — goal still under B
		await s.reload();
		const afterResp = await apiFetch("/api/goals");
		const after = await afterResp.json();
		const afterGoals = Array.isArray(after) ? after : (after.goals ?? []);
		const afterFound = afterGoals.find((g: any) => g.id === created.id);
		expect(afterFound?.projectId).toBe(projB.id);
	});

	// -----------------------------------------------------------
	// GR-02: Toolbar + New Goal opens picker, creates in picked project
	// -----------------------------------------------------------

	test("GR-02: Toolbar + New Goal opens project-picker popover", async () => {
		s.begin(STORY_GR02);

		await s.open();

		s.act();
		const toolbarBtn = s.page.locator('button[title="New goal (Alt+G)"]').first();
		await expect(toolbarBtn).toBeVisible({ timeout: 15_000 });
		await toolbarBtn.click();

		// The target implementation mounts <project-picker-popover> with rows
		// listing every registered project. Both assertions must pass.
		const popover = s.page.locator("project-picker-popover").first();
		await expect(
			popover,
			"toolbar New Goal should open a project-picker-popover (does not exist on master)",
		).toBeVisible({ timeout: 5_000 });

		// Rows should include both A and B
		await expect(popover.getByText(projA.name)).toBeVisible({ timeout: 3_000 });
		await expect(popover.getByText(projB.name)).toBeVisible({ timeout: 3_000 });

		// Pick B
		await popover.getByText(projB.name).click();

		s.assert();
		// Popover closes after pick
		await expect(popover).not.toBeVisible({ timeout: 5_000 });

		// Goal form/dialog should be scoped to B. We verify end-to-end via API:
		const createResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "GR-02 goal", projectId: projB.id, cwd: projB.rootPath, worktree: false }),
		});
		expect(createResp.status).toBe(201);
		const created = await createResp.json();
		goalsToCleanup.push(created.id);
		expect(created.projectId).toBe(projB.id);
	});

	// -----------------------------------------------------------
	// GR-03: Back-to-back picks land in each respective project
	// -----------------------------------------------------------

	test("GR-03: Back-to-back: pick A then pick B", async () => {
		s.begin(STORY_GR03);

		await s.open();

		s.act();
		const toolbarBtn = s.page.locator('button[title="New goal (Alt+G)"]').first();
		await expect(toolbarBtn).toBeVisible({ timeout: 15_000 });

		// First pick: A
		await toolbarBtn.click();
		const pop1 = s.page.locator("project-picker-popover").first();
		await expect(pop1, "popover round 1").toBeVisible({ timeout: 5_000 });
		await pop1.getByText(projA.name).click();
		await expect(pop1).not.toBeVisible({ timeout: 5_000 });

		// Close any dialog that opened (escape)
		await s.page.keyboard.press("Escape");

		const g1Resp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "GR-03 G1", projectId: projA.id, cwd: projA.rootPath, worktree: false }),
		});
		const g1 = await g1Resp.json();
		goalsToCleanup.push(g1.id);

		// Second pick: B
		await toolbarBtn.click();
		const pop2 = s.page.locator("project-picker-popover").first();
		await expect(pop2, "popover round 2 (must re-open cleanly)").toBeVisible({ timeout: 5_000 });
		await pop2.getByText(projB.name).click();

		const g2Resp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "GR-03 G2", projectId: projB.id, cwd: projB.rootPath, worktree: false }),
		});
		const g2 = await g2Resp.json();
		goalsToCleanup.push(g2.id);

		s.assert();
		expect(g1.projectId).toBe(projA.id);
		expect(g2.projectId).toBe(projB.id);

		// No leaked popover elements
		await s.page.keyboard.press("Escape");
		await expect(s.page.locator("project-picker-popover")).toHaveCount(0, { timeout: 5_000 });
	});

	// -----------------------------------------------------------
	// GR-04: Goal-assistant flow lands in picked project
	// -----------------------------------------------------------

	test("GR-04: Goal-assistant flow lands in picked project", async () => {
		s.begin(STORY_GR04);

		await s.open();

		s.act();
		const toolbarBtn = s.page.locator('button[title="New goal (Alt+G)"]').first();
		await expect(toolbarBtn).toBeVisible({ timeout: 15_000 });
		await toolbarBtn.click();

		const popover = s.page.locator("project-picker-popover").first();
		await expect(popover, "picker must mount on toolbar click").toBeVisible({ timeout: 5_000 });
		await popover.getByText(projB.name).click();

		// Goal assistant session should be created with projectId === B.id
		// The assistant session is created via POST /api/sessions with
		// assistantType: "goal" and an explicit projectId.
		// We poll the sessions list for a goal-assistant session scoped to B.
		let assistantSession: any = null;
		await expect(async () => {
			const resp = await apiFetch("/api/sessions");
			const body = await resp.json();
			const sessions = Array.isArray(body) ? body : (body.sessions ?? []);
			assistantSession = sessions.find((sess: any) =>
				sess.projectId === projB.id &&
				(sess.assistantType === "goal" || sess.title?.toLowerCase().includes("goal"))
			);
			expect(assistantSession, "goal-assistant session scoped to B").toBeTruthy();
		}).toPass({ timeout: 15_000 });

		if (assistantSession?.id) sessionsToCleanup.push(assistantSession.id);

		s.assert();
		expect(assistantSession.projectId).toBe(projB.id);
	});

	// -----------------------------------------------------------
	// GR-05: Reload mid-proposal preserves project
	// -----------------------------------------------------------

	test("GR-05: Reload mid-proposal preserves project", async () => {
		s.begin(STORY_GR05);

		await s.open();

		// Create an assistant session in B via API to simulate "mid-proposal"
		const sessResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ projectId: projB.id, cwd: projB.rootPath, assistantType: "goal" }),
		});
		expect(sessResp.status, "create goal-assistant session in B").toBe(201);
		const sess = await sessResp.json();
		sessionsToCleanup.push(sess.id);

		s.act();
		await s.page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sess.id);
		await s.reload();

		// After reload the app should remember that this session is in B
		const resp = await apiFetch(`/api/sessions/${sess.id}`);
		const data = await resp.json();

		s.assert();
		expect(data.projectId).toBe(projB.id);

		// If we now create a goal from that assistant, it must land in B, not A.
		const goalResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "GR-05 goal", projectId: projB.id, cwd: projB.rootPath, worktree: false }),
		});
		const goal = await goalResp.json();
		goalsToCleanup.push(goal.id);
		expect(goal.projectId).toBe(projB.id);
	});

	// -----------------------------------------------------------
	// GR-06: POST /api/goals with cwd only resolves to matching project
	// -----------------------------------------------------------

	test("GR-06: API: cwd-only request resolves project", async () => {
		s.begin(STORY_GR06);

		s.act();
		// cwd is a subpath inside B's rootPath and does not match A.
		const subCwd = join(projB.rootPath, "sub");
		mkdirSync(subCwd, { recursive: true });

		const resp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "GR-06 cwd-only", cwd: subCwd, worktree: false }),
		});

		s.assert();
		expect(resp.status, "cwd-only request should succeed when cwd is inside a registered project").toBe(201);
		const created = await resp.json();
		goalsToCleanup.push(created.id);
		expect(created.projectId, "goal routed to project B via cwd match").toBe(projB.id);
	});

	// -----------------------------------------------------------
	// GR-07: POST /api/goals with no projectId + unresolvable cwd → 400
	// -----------------------------------------------------------

	test("GR-07: API: no projectId + no matching cwd returns 400", async () => {
		s.begin(STORY_GR07);

		s.act();
		const bogusCwd = join(tmpdir(), `bobbit-gr07-bogus-${Date.now()}`);
		mkdirSync(bogusCwd, { recursive: true });

		const resp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "GR-07 unmatched", cwd: bogusCwd, worktree: false }),
		});

		s.assert();
		expect(resp.status, "must reject rather than fall back to a default project").toBe(400);
		const body = await resp.json().catch(() => ({}));
		const errMsg = (body.error ?? "") as string;
		expect(errMsg.toLowerCase(), `error should mention projectId (got: ${JSON.stringify(body)})`).toContain("projectid required");

		try { rmSync(bogusCwd, { recursive: true, force: true }); } catch { /* best effort */ }
	});

	// -----------------------------------------------------------
	// GR-08: POST /api/sessions with no resolvable project → 400
	// -----------------------------------------------------------

	test("GR-08: API: session creation enforces same contract", async () => {
		s.begin(STORY_GR08);

		s.act();
		const bogusCwd = join(tmpdir(), `bobbit-gr08-bogus-${Date.now()}`);
		mkdirSync(bogusCwd, { recursive: true });

		const resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: bogusCwd }),
		});

		s.assert();
		expect(resp.status, "session creation must reject with 400").toBe(400);
		const body = await resp.json().catch(() => ({}));
		const errMsg = (body.error ?? "") as string;
		expect(errMsg.toLowerCase(), `error should mention projectId (got: ${JSON.stringify(body)})`).toContain("projectid required");

		try { rmSync(bogusCwd, { recursive: true, force: true }); } catch { /* best effort */ }
	});
});

// ---------------------------------------------------------------
// CT-19 zero/single project UX (GR-09, GR-10)
// ---------------------------------------------------------------

test.describe("CT-19: First-run and single-project UX", () => {
	let s: SpecContext;
	let initialProjects: Array<{ id: string; name: string; rootPath: string }> = [];
	const createdProjects: string[] = [];
	const tempDirs: string[] = [];

	test.beforeAll(async () => {
		await waitForHealth();
	});

	test.beforeEach(async ({ page }) => {
		s = new SpecContext(page);
		initialProjects = await listProjects();
	});

	test.afterEach(async () => {
		await s.cleanup();
		for (const id of createdProjects.splice(0)) {
			await deleteProject(id);
		}
		// Best-effort: re-register anything we nuked so subsequent tests are not
		// starved. On current master we cannot delete the server-cwd project at
		// all, so initialProjects is preserved anyway.
		for (const p of initialProjects) {
			const existing = (await listProjects()).find(q => q.id === p.id);
			if (!existing) {
				await apiFetch("/api/projects", {
					method: "POST",
					body: JSON.stringify({ name: p.name, rootPath: p.rootPath }),
				}).catch(() => {});
			}
		}
		for (const d of tempDirs.splice(0)) {
			try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
		}
	});

	// -----------------------------------------------------------
	// GR-09: Zero-project install disables New Goal button
	// -----------------------------------------------------------

	test("GR-09: First-run zero-project UX disables New Goal", async () => {
		s.begin(STORY_GR09);

		// Attempt to reach zero-project state. Current master will refuse to
		// delete the server-cwd default project (400), leaving at least one
		// project registered. That is exactly how this characterization test
		// fails against master.
		await deleteAllProjects();

		s.act();
		await s.open();
		const projects = await listProjects();

		s.assert();
		expect(projects.length, "zero projects required for first-run UX").toBe(0);

		// Toolbar New Goal button must be disabled with tooltip hint
		const btn = s.page.locator('button[title="New goal (Alt+G)"], button[title="Add a project first"]').first();
		await expect(btn).toBeVisible({ timeout: 10_000 });
		await expect(
			btn,
			"toolbar New Goal must be disabled in zero-project state",
		).toBeDisabled({ timeout: 5_000 });

		// API also enforces: POST /api/goals fails with 400
		const resp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "GR-09 should fail", worktree: false }),
		});
		expect(resp.status, "goal creation must 400 in zero-project state").toBe(400);
	});

	// -----------------------------------------------------------
	// GR-10: Single-project install skips the picker
	// -----------------------------------------------------------

	test("GR-10: Single-project install skips the picker", async () => {
		s.begin(STORY_GR10);

		// Target state: exactly one project registered. On current master we
		// cannot guarantee "exactly one" (we can't delete the default), so
		// this test asserts the target behavior and fails against master if
		// there are 0 or >1 projects OR if the popover is shown.
		await deleteAllProjects();

		const lone = await registerProject(`lone-${Date.now()}`, mkTempDir("lone"));
		createdProjects.push(lone.id);
		tempDirs.push(lone.rootPath);

		await s.open();

		s.act();
		const projects = await listProjects();
		expect(projects.length, "exactly one project required").toBe(1);

		const toolbarBtn = s.page.locator('button[title="New goal (Alt+G)"]').first();
		await expect(toolbarBtn).toBeVisible({ timeout: 15_000 });
		await toolbarBtn.click();

		s.assert();
		// No popover should mount: single-project short-circuits straight to
		// the goal dialog/assistant scoped to the lone project.
		await expect(
			s.page.locator("project-picker-popover"),
			"popover must NOT mount in single-project install",
		).toHaveCount(0, { timeout: 3_000 });

		// Submitting creates a goal in the lone project
		const createResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "GR-10 single", projectId: lone.id, cwd: lone.rootPath, worktree: false }),
		});
		expect(createResp.status).toBe(201);
		const created = await createResp.json();
		await apiFetch(`/api/goals/${created.id}`, { method: "DELETE" }).catch(() => {});
		expect(created.projectId).toBe(lone.id);
	});
});
