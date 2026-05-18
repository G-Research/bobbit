/**
 * PATCH /api/staff/:id re-homes a staff record to a different project.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";

type ProjectRecord = { id: string; rootPath: string; name: string };

function canonical(p: string): string {
	try { return realpathSync(p); } catch { return p; }
}

function normalisePath(p: string | undefined): string {
	let value = canonical(p ?? "").replace(/\\/g, "/");
	if (value.startsWith("/private/")) value = value.slice("/private".length);
	if (process.platform === "win32") value = value.toLowerCase();
	return value.replace(/\/+$/, "");
}

function isSameOrUnder(child: string | undefined, parent: string | undefined): boolean {
	if (!child || !parent) return false;
	const c = normalisePath(child);
	const p = normalisePath(parent);
	return c === p || c.startsWith(`${p}/`);
}

function makeTempRoot(label: string): string {
	return canonical(mkdtempSync(join(tmpdir(), `bobbit-staff-patch-${label}-`)));
}

function makeGitRepo(parent: string, name: string): string {
	const repo = join(parent, name);
	mkdirSync(repo, { recursive: true });
	writeFileSync(join(repo, "README.md"), `# ${name}\n`);
	execFileSync("git", ["init"], { cwd: repo, stdio: "pipe" });
	execFileSync("git", ["add", "."], { cwd: repo, stdio: "pipe" });
	execFileSync("git", ["-c", "user.name=E2E", "-c", "user.email=e2e@example.test", "commit", "-m", "init"], { cwd: repo, stdio: "pipe" });
	return canonical(repo);
}

function makePlainDir(parent: string, name: string): string {
	const dir = join(parent, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "README.md"), `# ${name}\n`);
	return canonical(dir);
}

async function registerTempProject(name: string, rootPath: string): Promise<ProjectRecord> {
	const resp = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name, rootPath, seedWorkflows: false }),
	});
	expect(resp.ok, `project registration failed: ${await resp.clone().text().catch(() => "")}`).toBeTruthy();
	return await resp.json();
}

function seedLegacySystemStaff(gateway: any, patch: Partial<any> = {}): any {
	const pcm = gateway.sessionManager.getProjectContextManager();
	const systemCtx = pcm?.getOrCreate("system");
	if (!systemCtx) throw new Error("system project context missing");
	const now = Date.now();
	const staff = {
		id: randomUUID(),
		name: `legacy-orphan-${now}`,
		description: "Legacy orphan",
		systemPrompt: "Legacy prompt.",
		cwd: patch.cwd ?? makeTempRoot("legacy-cwd"),
		state: "active",
		triggers: [],
		memory: "",
		createdAt: now,
		updatedAt: now,
		projectId: "system",
		sandboxed: false,
		...patch,
	};
	systemCtx.staffStore.put(staff);
	return staff;
}

test.describe("PATCH /api/staff/:id — project reassignment", () => {
	let cleanupStaffIds: string[] = [];
	let cleanupProjectIds: string[] = [];
	let cleanupDirs: string[] = [];

	test.afterEach(async () => {
		for (const id of cleanupStaffIds.splice(0).reverse()) {
			await apiFetch(`/api/staff/${id}`, { method: "DELETE" }).catch(() => {});
		}
		for (const id of cleanupProjectIds.splice(0).reverse()) {
			await apiFetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
		}
		for (const dir of cleanupDirs.splice(0).reverse()) {
			try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});

	test("reassigning from project A to project B resets cwd/worktree/session metadata", async ({ gateway }) => {
		const root = makeTempRoot("reassign");
		cleanupDirs.push(root);
		const projectARoot = makeGitRepo(root, "project-a");
		const projectBRoot = makePlainDir(root, "project-b");
		const projA = await registerTempProject(`patch-a-${Date.now()}`, projectARoot);
		const projB = await registerTempProject(`patch-b-${Date.now()}`, projectBRoot);
		cleanupProjectIds.push(projA.id, projB.id);

		const createResp = await apiFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify({
				name: `patch-staff-${Date.now()}`,
				systemPrompt: "Stay project-scoped.",
				cwd: projA.rootPath,
				projectId: projA.id,
			}),
		});
		expect(createResp.status).toBe(201);
		const staff = await createResp.json();
		cleanupStaffIds.push(staff.id);
		expect(staff.projectId).toBe(projA.id);
		expect(staff.worktreePath).toBeTruthy();
		expect(staff.branch).toBeTruthy();

		const initialSessionResp = await apiFetch(`/api/sessions/${staff.currentSessionId}`);
		expect(initialSessionResp.status).toBe(200);
		const initialSession = await initialSessionResp.json();
		expect(initialSession.worktreePath).toBe(staff.worktreePath);
		expect(initialSession.branch).toBe(staff.branch);
		const persistedSession = gateway.sessionManager.getPersistedSession(staff.currentSessionId);
		expect(persistedSession?.branch).toBe(staff.branch);
		expect(normalisePath(persistedSession?.repoPath)).toBe(normalisePath(staff.repoPath ?? projA.rootPath));

		const okResp = await apiFetch(`/api/staff/${staff.id}`, {
			method: "PATCH",
			body: JSON.stringify({ projectId: projB.id }),
		});
		expect(okResp.status).toBe(200);
		const moved = await okResp.json();
		expect(moved.projectId).toBe(projB.id);
		expect(normalisePath(moved.cwd)).toBe(normalisePath(projB.rootPath));
		expect(isSameOrUnder(moved.cwd, projA.rootPath)).toBe(false);
		expect(moved.currentSessionId).toBeFalsy();
		expect(moved.worktreePath).toBeFalsy();
		expect(moved.branch).toBeFalsy();
		expect(moved.repoPath).toBeFalsy();
		expect(moved.repoWorktrees).toBeFalsy();

		const listB = await (await apiFetch(`/api/staff?projectId=${encodeURIComponent(projB.id)}`)).json();
		expect((listB.staff as any[]).some((s) => s.id === staff.id)).toBe(true);
		const listA = await (await apiFetch(`/api/staff?projectId=${encodeURIComponent(projA.id)}`)).json();
		expect((listA.staff as any[]).some((s) => s.id === staff.id)).toBe(false);
	});

	test("rejects missing, unknown, and hidden target projects", async () => {
		const root = makeTempRoot("reject");
		cleanupDirs.push(root);
		const projectRoot = makePlainDir(root, "project-a");
		const project = await registerTempProject(`patch-reject-${Date.now()}`, projectRoot);
		cleanupProjectIds.push(project.id);

		const createResp = await apiFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify({
				name: `patch-target-guard-${Date.now()}`,
				systemPrompt: "Target guard.",
				cwd: project.rootPath,
				projectId: project.id,
				worktree: false,
			}),
		});
		expect(createResp.status).toBe(201);
		const staff = await createResp.json();
		cleanupStaffIds.push(staff.id);

		const missingResp = await apiFetch(`/api/staff/${staff.id}`, {
			method: "PATCH",
			body: JSON.stringify({}),
		});
		expect(missingResp.status).toBe(400);

		const badResp = await apiFetch(`/api/staff/${staff.id}`, {
			method: "PATCH",
			body: JSON.stringify({ projectId: "no-such-project-id" }),
		});
		expect(badResp.status).toBe(404);

		const hiddenResp = await apiFetch(`/api/staff/${staff.id}`, {
			method: "PATCH",
			body: JSON.stringify({ projectId: "system" }),
		});
		expect(hiddenResp.status).toBe(400);

		const stored = await (await apiFetch(`/api/staff/${staff.id}`)).json();
		expect(stored.projectId).toBe(project.id);
		expect(normalisePath(stored.cwd)).toBe(normalisePath(project.rootPath));
	});

	test("assigns a legacy orphan to a real project root without stale runtime metadata", async ({ gateway }) => {
		const root = makeTempRoot("legacy");
		cleanupDirs.push(root);
		const projectRoot = makePlainDir(root, "target-project");
		const staleRoot = makePlainDir(root, "stale-project");
		const project = await registerTempProject(`patch-legacy-${Date.now()}`, projectRoot);
		cleanupProjectIds.push(project.id);

		const legacy = seedLegacySystemStaff(gateway, {
			cwd: staleRoot,
			currentSessionId: "legacy-session-id",
			worktreePath: join(root, "stale-project-wt"),
			branch: "staff-legacy-12345678",
			repoPath: staleRoot,
			repoWorktrees: { ".": join(root, "stale-project-wt") },
		});
		cleanupStaffIds.push(legacy.id);

		const orphaned = await (await apiFetch("/api/staff/orphaned")).json();
		expect((orphaned.staff as any[]).some((s) => s.id === legacy.id)).toBe(true);

		const resp = await apiFetch(`/api/staff/${legacy.id}`, {
			method: "PATCH",
			body: JSON.stringify({ projectId: project.id }),
		});
		expect(resp.status).toBe(200);
		const moved = await resp.json();
		expect(moved.projectId).toBe(project.id);
		expect(normalisePath(moved.cwd)).toBe(normalisePath(project.rootPath));
		expect(moved.currentSessionId).toBeFalsy();
		expect(moved.worktreePath).toBeFalsy();
		expect(moved.branch).toBeFalsy();
		expect(moved.repoPath).toBeFalsy();
		expect(moved.repoWorktrees).toBeFalsy();
	});
});
