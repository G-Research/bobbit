import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./in-process-harness.js";
import { apiFetch, rawApiFetch, registerProject } from "./e2e-setup.js";

type ProjectRecord = { id: string; rootPath: string; [key: string]: unknown };

type StaffCreateResult = {
	status: number;
	text: string;
	json: any;
};

function canonical(path: string): string {
	try { return realpathSync(path); } catch { return path; }
}

function normalisePath(path: string): string {
	let value = canonical(path).replace(/\\/g, "/");
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
	return canonical(mkdtempSync(join(tmpdir(), `bobbit-staff-cwd-${label}-`)));
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

async function createProject(name: string, rootPath: string): Promise<ProjectRecord> {
	return registerProject({
		name,
		rootPath,
		seedWorkflows: false,
	});
}

async function postStaff(body: Record<string, unknown>): Promise<StaffCreateResult> {
	const res = await rawApiFetch("/api/staff", {
		method: "POST",
		body: JSON.stringify(body),
	});
	const text = await res.text();
	let json: any = undefined;
	try { json = text ? JSON.parse(text) : undefined; } catch { /* keep text only */ }
	return { status: res.status, text, json };
}

async function putStaff(id: string, body: Record<string, unknown>): Promise<StaffCreateResult> {
	const res = await rawApiFetch(`/api/staff/${id}`, {
		method: "PUT",
		body: JSON.stringify(body),
	});
	const text = await res.text();
	let json: any = undefined;
	try { json = text ? JSON.parse(text) : undefined; } catch { /* keep text only */ }
	return { status: res.status, text, json };
}

async function deleteStaff(id: string): Promise<void> {
	await apiFetch(`/api/staff/${id}`, { method: "DELETE" }).catch(() => {});
}

async function deleteProject(id: string): Promise<void> {
	await apiFetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
}

test.describe("staff cwd parity regressions", () => {
	let cleanupStaffIds: string[] = [];
	let cleanupProjectIds: string[] = [];
	let cleanupDirs: string[] = [];

	test.afterEach(async () => {
		for (const id of cleanupStaffIds.splice(0).reverse()) {
			await deleteStaff(id);
		}
		for (const id of cleanupProjectIds.splice(0).reverse()) {
			await deleteProject(id);
		}
		for (const dir of cleanupDirs.splice(0).reverse()) {
			try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});

	for (const cwdCase of [
		{ label: "missing cwd", patch: {} },
		{ label: "blank cwd", patch: { cwd: "" } },
	]) {
		test(`POST /api/staff with projectId and ${cwdCase.label} uses the project-derived worktree`, async ({ gateway }) => {
			const root = makeTempRoot(cwdCase.label.replace(/\s+/g, "-"));
			cleanupDirs.push(root);
			const repo = makeGitRepo(root, "project-repo");
			const project = await createProject(`staff-cwd-${cwdCase.label}-${Date.now()}`, repo);
			cleanupProjectIds.push(project.id);

			const created = await postStaff({
				name: `Staff cwd ${cwdCase.label}`,
				systemPrompt: "Stay inside the selected project.",
				projectId: project.id,
				...cwdCase.patch,
			});
			if (created.status === 201 && created.json?.id) cleanupStaffIds.push(created.json.id);

			expect(
				created.status,
				`STAFF_CWD_PARITY_PROJECT_ID_EMPTY_CWD: ${cwdCase.label} should derive cwd from projectId=${project.id}, not defaultCwd=${gateway.bobbitDir}. body=${created.text}`,
			).toBe(201);

			const staff = created.json;
			expect(staff.projectId, "STAFF_CWD_PARITY_PROJECT_ID_EMPTY_CWD: staff should remain attached to the selected project").toBe(project.id);
			expect(staff.worktreePath, "STAFF_CWD_PARITY_PROJECT_ID_EMPTY_CWD: git project should create a staff worktree by default").toBeTruthy();
			expect(
				isSameOrUnder(staff.worktreePath, `${project.rootPath}-wt`),
				`STAFF_CWD_PARITY_PROJECT_ID_EMPTY_CWD: worktreePath=${staff.worktreePath} must be under project worktree root ${project.rootPath}-wt, not server default ${gateway.bobbitDir}`,
			).toBe(true);

			const sessionRes = await apiFetch(`/api/sessions/${staff.currentSessionId}`);
			expect(sessionRes.status, "STAFF_CWD_PARITY_PROJECT_ID_EMPTY_CWD: staff permanent session should be readable").toBe(200);
			const session = await sessionRes.json();
			expect(
				isSameOrUnder(session.cwd, staff.worktreePath),
				`STAFF_CWD_PARITY_PROJECT_ID_EMPTY_CWD: session cwd=${session.cwd} must run inside staff worktree ${staff.worktreePath}`,
			).toBe(true);
			expect(
				isSameOrUnder(session.cwd, gateway.bobbitDir),
				`STAFF_CWD_PARITY_PROJECT_ID_EMPTY_CWD: session cwd=${session.cwd} must not run under server default cwd ${gateway.bobbitDir}`,
			).toBe(false);
		});
	}

	test("POST /api/staff without projectId and without cwd returns project-resolution 400", async () => {
		const created = await postStaff({
			name: "No project staff",
			systemPrompt: "This request has no resolvable project.",
		});
		if (created.status === 201 && created.json?.id) cleanupStaffIds.push(created.json.id);

		expect(
			created.status,
			`STAFF_CWD_PARITY_NO_PROJECT_400: staff creation with no projectId and no cwd must fail with project-resolution 400, not fall back to default cwd. body=${created.text}`,
		).toBe(400);
	});

	test("POST /api/staff without projectId and with blank cwd returns project-resolution 400", async () => {
		const created = await postStaff({
			name: "Blank project staff",
			systemPrompt: "This request has only blank cwd.",
			cwd: "",
		});
		if (created.status === 201 && created.json?.id) cleanupStaffIds.push(created.json.id);

		expect(
			created.status,
			`STAFF_CWD_PARITY_NO_PROJECT_400: staff creation with no projectId and blank cwd must fail with project-resolution 400, not fall back to default cwd. body=${created.text}`,
		).toBe(400);
	});

	test("registered non-git project staff creation succeeds without a worktree", async () => {
		const root = makeTempRoot("non-git");
		cleanupDirs.push(root);
		const projectDir = makePlainDir(root, "plain-project");
		const project = await createProject(`staff-cwd-non-git-${Date.now()}`, projectDir);
		cleanupProjectIds.push(project.id);

		const created = await postStaff({
			name: "Non-git staff",
			systemPrompt: "Run from the project directory without a worktree.",
			projectId: project.id,
			cwd: project.rootPath,
		});
		if (created.status === 201 && created.json?.id) cleanupStaffIds.push(created.json.id);

		expect(
			created.status,
			`STAFF_CWD_PARITY_NON_GIT_NO_WORKTREE: registered non-git project should create staff in project cwd without git worktree failure. body=${created.text}`,
		).toBe(201);

		const staff = created.json;
		expect(staff.worktreePath, "STAFF_CWD_PARITY_NON_GIT_NO_WORKTREE: non-git staff must not have worktreePath").toBeFalsy();
		expect(staff.branch, "STAFF_CWD_PARITY_NON_GIT_NO_WORKTREE: non-git staff must not have branch").toBeFalsy();
		const session = await (await apiFetch(`/api/sessions/${staff.currentSessionId}`)).json();
		expect(normalisePath(session.cwd), "STAFF_CWD_PARITY_NON_GIT_NO_WORKTREE: session must run in project cwd").toBe(normalisePath(project.rootPath));
	});

	test("git project with worktree false creates staff in project cwd without branch or worktreePath", async () => {
		const root = makeTempRoot("opt-out");
		cleanupDirs.push(root);
		const repo = makeGitRepo(root, "project-repo");
		const project = await createProject(`staff-cwd-opt-out-${Date.now()}`, repo);
		cleanupProjectIds.push(project.id);

		const created = await postStaff({
			name: "No worktree staff",
			systemPrompt: "Run directly from the selected project directory.",
			projectId: project.id,
			cwd: project.rootPath,
			worktree: false,
		});
		if (created.status === 201 && created.json?.id) cleanupStaffIds.push(created.json.id);

		expect(
			created.status,
			`STAFF_CWD_PARITY_WORKTREE_OPTOUT: worktree=false staff creation should succeed. body=${created.text}`,
		).toBe(201);

		const staff = created.json;
		expect(staff.worktreePath, "STAFF_CWD_PARITY_WORKTREE_OPTOUT: worktree=false must not allocate worktreePath").toBeFalsy();
		expect(staff.branch, "STAFF_CWD_PARITY_WORKTREE_OPTOUT: worktree=false must not allocate branch").toBeFalsy();
		expect(normalisePath(staff.cwd), "STAFF_CWD_PARITY_WORKTREE_OPTOUT: staff cwd should stay at project root").toBe(normalisePath(project.rootPath));

		const sessionRes = await apiFetch(`/api/sessions/${staff.currentSessionId}`);
		expect(sessionRes.status, "STAFF_CWD_PARITY_WORKTREE_OPTOUT: staff permanent session should be readable").toBe(200);
		const session = await sessionRes.json();
		expect(normalisePath(session.cwd), "STAFF_CWD_PARITY_WORKTREE_OPTOUT: session cwd should stay at project root").toBe(normalisePath(project.rootPath));
		expect(session.worktreePath, "STAFF_CWD_PARITY_WORKTREE_OPTOUT: session must not have worktreePath").toBeFalsy();
	});

	test("explicit cwd from a different registered project is rejected", async () => {
		const root = makeTempRoot("mismatch");
		cleanupDirs.push(root);
		const repoA = makeGitRepo(root, "project-a");
		const repoB = makeGitRepo(root, "project-b");
		const projectA = await createProject(`staff-cwd-project-a-${Date.now()}`, repoA);
		const projectB = await createProject(`staff-cwd-project-b-${Date.now()}`, repoB);
		cleanupProjectIds.push(projectA.id, projectB.id);

		const created = await postStaff({
			name: "Mismatched cwd staff",
			systemPrompt: "Do not cross project boundaries.",
			projectId: projectA.id,
			cwd: projectB.rootPath,
		});
		if (created.status === 201 && created.json?.id) cleanupStaffIds.push(created.json.id);

		expect(
			created.status,
			`STAFF_CWD_PARITY_MISMATCHED_CWD_400: projectId=${projectA.id} with cwd from projectId=${projectB.id} must be rejected. body=${created.text}`,
		).toBe(400);
	});

	test("PUT /api/staff/:id rejects cwd outside the staff project and preserves stored cwd", async () => {
		const root = makeTempRoot("put-reject");
		cleanupDirs.push(root);
		const projectADir = makePlainDir(root, "project-a");
		const projectBDir = makePlainDir(root, "project-b");
		const arbitraryDir = makePlainDir(root, "outside-registered-projects");
		const projectA = await createProject(`staff-cwd-put-a-${Date.now()}`, projectADir);
		const projectB = await createProject(`staff-cwd-put-b-${Date.now()}`, projectBDir);
		cleanupProjectIds.push(projectA.id, projectB.id);

		const created = await postStaff({
			name: "Update cwd guard staff",
			systemPrompt: "Do not accept cwd edits outside this project.",
			projectId: projectA.id,
			cwd: projectA.rootPath,
		});
		if (created.status === 201 && created.json?.id) cleanupStaffIds.push(created.json.id);
		expect(created.status, `STAFF_CWD_PARITY_UPDATE_GUARD_SETUP: staff creation failed. body=${created.text}`).toBe(201);
		const staffId = created.json.id;
		const originalCwd = created.json.cwd;

		for (const [label, cwd] of [
			["different registered project", projectB.rootPath],
			["unregistered temp dir", arbitraryDir],
			["blank cwd", "   "],
		] as const) {
			const updated = await putStaff(staffId, { cwd });
			expect(
				updated.status,
				`STAFF_CWD_PARITY_UPDATE_GUARD_400: PUT cwd=${label} must be rejected. body=${updated.text}`,
			).toBe(400);

			const storedRes = await apiFetch(`/api/staff/${staffId}`);
			expect(storedRes.status, `STAFF_CWD_PARITY_UPDATE_GUARD_PRESERVE: staff should remain readable after rejected ${label}`).toBe(200);
			const stored = await storedRes.json();
			expect(
				normalisePath(stored.cwd),
				`STAFF_CWD_PARITY_UPDATE_GUARD_PRESERVE: rejected ${label} must not mutate stored cwd`,
			).toBe(normalisePath(originalCwd));
		}
	});

	test("PUT /api/staff/:id accepts cwd inside the staff project", async () => {
		const root = makeTempRoot("put-accept");
		cleanupDirs.push(root);
		const projectDir = makePlainDir(root, "project-a");
		const subdir = join(projectDir, "packages", "app");
		mkdirSync(subdir, { recursive: true });
		const project = await createProject(`staff-cwd-put-accept-${Date.now()}`, projectDir);
		cleanupProjectIds.push(project.id);

		const created = await postStaff({
			name: "Update cwd allowed staff",
			systemPrompt: "Allow cwd edits inside this project.",
			projectId: project.id,
			cwd: project.rootPath,
		});
		if (created.status === 201 && created.json?.id) cleanupStaffIds.push(created.json.id);
		expect(created.status, `STAFF_CWD_PARITY_UPDATE_ALLOWED_SETUP: staff creation failed. body=${created.text}`).toBe(201);

		const updated = await putStaff(created.json.id, { cwd: subdir });
		expect(
			updated.status,
			`STAFF_CWD_PARITY_UPDATE_ALLOWED: PUT cwd to a subdirectory inside projectId=${project.id} should succeed. body=${updated.text}`,
		).toBe(200);
		expect(normalisePath(updated.json.cwd), "STAFF_CWD_PARITY_UPDATE_ALLOWED: stored cwd should update to the project subdirectory").toBe(normalisePath(subdir));
		expect(updated.json.projectId, "STAFF_CWD_PARITY_UPDATE_ALLOWED: staff should remain attached to its project").toBe(project.id);
	});
});
