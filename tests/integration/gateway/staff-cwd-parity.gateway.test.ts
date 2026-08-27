import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { test, expect } from "./_helpers/e2e/in-process-harness.js";
import { apiFetch, rawApiFetch, registerProject, deleteSession } from "./_helpers/e2e/e2e-setup.js";
import { copyGitTemplate } from "../../support/harnesses/shared/git-template.js";
import { createRunChild } from "../../support/harnesses/shared/run-isolation.js";

type ProjectRecord = { id: string; rootPath: string; [key: string]: unknown };

type StaffCreateResult = {
	status: number;
	text: string;
	json: any;
};

function canonical(path: string, nativeRealpath: typeof realpathSync.native = realpathSync.native): string {
	const lexical = resolve(path);
	let existingPrefix = lexical;
	let identity = lexical;
	while (true) {
		try {
			// Worktree coordinates can be returned before their final directories
			// exist. Resolve the longest existing prefix so Windows expands an 8.3
			// spelling such as RUNNER~1 without discarding the missing suffix.
			identity = resolve(nativeRealpath(existingPrefix), relative(existingPrefix, lexical));
			break;
		} catch {
			const parent = dirname(existingPrefix);
			if (parent === existingPrefix) break;
			existingPrefix = parent;
		}
	}
	return process.platform === "win32" ? identity.toLowerCase() : identity;
}

function normalisePath(path: string): string {
	let value = canonical(path).replace(/\\/g, "/");
	if (value.startsWith("/private/")) value = value.slice("/private".length);
	return value.replace(/\/+$/, "");
}

function isSameOrUnder(
	child: string | undefined,
	parent: string | undefined,
	pathIdentity: (path: string) => string = canonical,
): boolean {
	if (!child || !parent) return false;
	const offset = relative(pathIdentity(parent), pathIdentity(child));
	return offset === "" || (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`));
}

let fixtureRoot = "";
let fixtureSequence = 0;

function makeTempRoot(label: string): string {
	const root = join(fixtureRoot, `${++fixtureSequence}-${label}`);
	mkdirSync(root, { recursive: true });
	return canonical(root);
}

function makeGitRepo(parent: string, name: string): string {
	return canonical(copyGitTemplate(join(parent, name)));
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

/**
 * Register a multi-repo (poly-repo) project: a NON-git container `rootPath`
 * with one git sub-repo per component. `components` declares the `repo`
 * sub-directory names; a `repo: "."` container component may be included to
 * exercise the exact poly-repo bug trigger.
 */
async function createMultiRepoProject(
	name: string,
	rootPath: string,
	components: Array<{ name: string; repo: string }>,
): Promise<ProjectRecord> {
	return registerProject({
		name,
		rootPath,
		components,
		seedWorkflows: false,
	});
}

async function getSession(id: string): Promise<any> {
	const res = await apiFetch(`/api/sessions/${id}`);
	expect(res.status, `session ${id} should be readable`).toBe(200);
	return res.json();
}

/**
 * Poll a session until its worktree set has actually been provisioned ON DISK.
 *
 * `worktreePath`/`branch` are assigned synchronously at session creation (the
 * container path is pre-computed before `executeWorktreeAsync` runs), so they
 * are NOT a reliable readiness signal. The async cold path only materialises
 * the per-repo worktrees a moment later. We therefore poll until at least one
 * expected sub-repo worktree directories exist on disk. The compatibility
 * harness's retry matcher advances the manual gateway clock and yields for IO,
 * so the check is bounded without adding wall-clock sleeps.
 */
async function waitForSessionWorktree(id: string, expectedRepos: string[], timeoutMs = 10_000): Promise<any> {
	let last: any;
	const retryingExpectation = expect(async () => {
		last = await getSession(id);
		expect(
			!!(last.worktreePath && last.branch)
				&& expectedRepos.every(repo => existsSync(join(last.worktreePath, repo, ".git"))),
		).toBe(true);
	}) as unknown as ReturnType<typeof expect> & {
		toPass(options: { timeout: number; intervals: number[] }): Promise<void>;
	};
	await retryingExpectation.toPass({ timeout: timeoutMs, intervals: [10, 25, 50] });
	return last;
}

/**
 * The set of git sub-repos actually worktree'd under a branch container, as
 * observed on disk. A worktree exists when `<container>/<repo>/.git` is
 * present. The non-git container itself must NEVER carry a top-level `.git`
 * (that would mean `git worktree add` ran against the container root).
 */
function worktreedReposOnDisk(container: string, candidateRepos: string[]): string[] {
	return candidateRepos
		.filter(repo => existsSync(join(container, repo, ".git")))
		.sort();
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

function seedLegacySystemStaff(gateway: any, patch: Partial<any> = {}): any {
	const pcm = gateway.sessionManager.getProjectContextManager();
	const systemCtx = pcm?.getOrCreate("system");
	if (!systemCtx) throw new Error("system project context missing");
	const now = Date.now();
	const staff = {
		id: randomUUID(),
		name: `legacy-orphan-${now}`,
		description: "Original description",
		systemPrompt: "Original prompt.",
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

test.describe("staff cwd parity regressions", () => {
	let cleanupStaffIds: string[] = [];
	let cleanupSessionIds: string[] = [];
	let cleanupProjectIds: string[] = [];
	let cleanupDirs: string[] = [];

	test.beforeAll(() => {
		fixtureRoot = createRunChild("staff-cwd-parity");
	});

	test.afterEach(async () => {
		for (const id of cleanupStaffIds.splice(0).reverse()) {
			await deleteStaff(id);
		}
		for (const id of cleanupSessionIds.splice(0).reverse()) {
			await deleteSession(id);
		}
		for (const id of cleanupProjectIds.splice(0).reverse()) {
			await deleteProject(id);
		}
		// Project/session stores can still flush after their REST deletion. Keep
		// their run-owned roots until the coordinator removes the whole run tree.
		cleanupDirs.splice(0);
	});

	test("path containment resolves a Windows short-path identity without admitting a sibling", () => {
		const root = makeTempRoot("path-identity");
		cleanupDirs.push(root);
		let identityRoot = root;
		let alternateRoot = root;
		let pathIdentity = canonical;

		if (process.platform === "win32") {
			identityRoot = join(root, "runneradmin");
			alternateRoot = join(root, "RUNNER~1");
			const nativeRealpath = ((candidate: string) => {
				if (candidate.toLowerCase() === identityRoot.toLowerCase()) return identityRoot;
				if (candidate.toLowerCase() === alternateRoot.toLowerCase()) return identityRoot;
				throw Object.assign(new Error(`missing path: ${candidate}`), { code: "ENOENT" });
			}) as typeof realpathSync.native;
			pathIdentity = path => canonical(path, nativeRealpath);
			alternateRoot = alternateRoot.toUpperCase();
		}

		const parent = join(alternateRoot, "project-repo-wt");
		expect(
			isSameOrUnder(join(identityRoot, "project-repo-wt", "staff-branch"), parent, pathIdentity),
			"STAFF_CWD_PARITY_PATH_IDENTITY: missing worktree descendants must compare by their filesystem-authoritative parent identity",
		).toBe(true);
		expect(
			isSameOrUnder(join(identityRoot, "project-repo-wt-sibling", "staff-branch"), parent, pathIdentity),
			"STAFF_CWD_PARITY_PATH_IDENTITY: a sibling sharing the worktree-root prefix must remain outside containment",
		).toBe(false);
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
			`STAFF_CWD_PARITY_MISMATCHED_CWD_422: projectId=${projectA.id} with cwd from projectId=${projectB.id} must be rejected. body=${created.text}`,
		).toBe(422);
		expect(created.json?.code).toBe("CWD_OUTSIDE_PROJECT");
	});

	test("PUT /api/staff/:id allows orphaned legacy field edits when cwd is unchanged", async ({ gateway }) => {
		const root = makeTempRoot("orphan-unchanged");
		cleanupDirs.push(root);
		const projectDir = makePlainDir(root, "legacy-project");
		const originalCwd = projectDir;
		const legacy = seedLegacySystemStaff(gateway, {
			name: "Legacy orphan staff",
			cwd: originalCwd,
		});
		cleanupStaffIds.push(legacy.id);

		const updated = await putStaff(legacy.id, {
			name: "Renamed legacy orphan",
			description: "Updated description",
			systemPrompt: "Updated prompt.",
			cwd: `${originalCwd}   `,
		});
		expect(
			updated.status,
			`STAFF_CWD_PARITY_ORPHAN_UNCHANGED_SAVE: unchanged cwd from the edit page should not require a registered project. body=${updated.text}`,
		).toBe(200);
		expect(updated.json.name).toBe("Renamed legacy orphan");
		expect(updated.json.description).toBe("Updated description");
		expect(updated.json.systemPrompt).toBe("Updated prompt.");
		expect(updated.json.cwd, "STAFF_CWD_PARITY_ORPHAN_UNCHANGED_SAVE: unchanged cwd must not be rewritten just because the UI re-sent it").toBe(originalCwd);
	});

	test("PUT /api/staff/:id rejects orphaned legacy cwd changes and preserves stored cwd", async ({ gateway }) => {
		const root = makeTempRoot("orphan-change");
		cleanupDirs.push(root);
		const projectDir = makePlainDir(root, "legacy-project");
		const newCwd = makePlainDir(root, "new-cwd");
		const originalCwd = projectDir;
		const legacy = seedLegacySystemStaff(gateway, {
			name: "Legacy orphan cwd guard",
			cwd: originalCwd,
		});
		cleanupStaffIds.push(legacy.id);
		const staffId = legacy.id;

		const updated = await putStaff(staffId, {
			name: "Should not persist",
			cwd: newCwd,
		});
		expect(
			updated.status,
			`STAFF_CWD_PARITY_ORPHAN_CHANGE_400: orphaned staff cwd changes must still be rejected before cwd validation when no registered project is attached. body=${updated.text}`,
		).toBe(400);

		const storedRes = await apiFetch(`/api/staff/${staffId}`);
		expect(storedRes.status, "STAFF_CWD_PARITY_ORPHAN_CHANGE_PRESERVE: staff should remain readable after rejected cwd change").toBe(200);
		const stored = await storedRes.json();
		expect(stored.name, "STAFF_CWD_PARITY_ORPHAN_CHANGE_PRESERVE: rejected update must not mutate other fields").toBe("Legacy orphan cwd guard");
		expect(stored.cwd, "STAFF_CWD_PARITY_ORPHAN_CHANGE_PRESERVE: rejected cwd change must not mutate stored cwd").toBe(originalCwd);
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

		for (const [label, cwd, expectedStatus, expectedCode] of [
			["different registered project", projectB.rootPath, 422, "CWD_OUTSIDE_PROJECT"],
			["unregistered temp dir", arbitraryDir, 422, "CWD_OUTSIDE_PROJECT"],
			["blank cwd", "   ", 400, undefined],
		] as const) {
			const updated = await putStaff(staffId, { cwd });
			expect(
				updated.status,
				`STAFF_CWD_PARITY_UPDATE_GUARD_${expectedStatus}: PUT cwd=${label} must be rejected. body=${updated.text}`,
			).toBe(expectedStatus);
			if (expectedCode) expect(updated.json?.code).toBe(expectedCode);

			const storedRes = await apiFetch(`/api/staff/${staffId}`);
			expect(storedRes.status, `STAFF_CWD_PARITY_UPDATE_GUARD_PRESERVE: staff should remain readable after rejected ${label}`).toBe(200);
			const stored = await storedRes.json();
			expect(
				normalisePath(stored.cwd),
				`STAFF_CWD_PARITY_UPDATE_GUARD_PRESERVE: rejected ${label} must not mutate stored cwd`,
			).toBe(normalisePath(originalCwd));
		}
	});

	test("poly-repo staff creation matches session worktree shape and never worktrees the non-git container", async () => {
		// ── Build a poly-repo project ──────────────────────────────────────
		// A NON-git container root with two git sub-repos one level deep.
		const root = makeTempRoot("polyrepo");
		cleanupDirs.push(root);
		cleanupDirs.push(`${root}-wt`);
		makeGitRepo(root, "repo-a");
		makeGitRepo(root, "repo-b");
		// The container root itself is deliberately NOT a git repo.
		expect(
			existsSync(join(root, ".git")),
			"STAFF_CWD_PARITY_POLYREPO: container root must NOT be a git repo (poly-repo precondition)",
		).toBe(false);

		// Register the project with the EXACT bug trigger: a `repo: "."` container
		// component alongside the two git sub-repo components (multi-repo).
		const project = await createMultiRepoProject(
			`staff-cwd-polyrepo-${Date.now()}`,
			root,
			[
				{ name: "container", repo: "." },
				{ name: "a", repo: "repo-a" },
				{ name: "b", repo: "repo-b" },
			],
		);
		cleanupProjectIds.push(project.id);
		const projectRoot = project.rootPath;
		const wtRoot = `${projectRoot}-wt`;
		const candidateRepos = ["repo-a", "repo-b"];

		// ── Criterion 1 + 2: STAFF worktree shape ──────────────────────────
		const created = await postStaff({
			name: "Poly-repo staff",
			systemPrompt: "Worktree each git sub-repo, never the non-git container.",
			projectId: project.id,
		});
		if (created.status === 201 && created.json?.id) cleanupStaffIds.push(created.json.id);

		expect(
			created.status,
			`STAFF_CWD_PARITY_POLYREPO: staff creation in a poly-repo must succeed (must not throw 'git worktree add' / 'not a git repository'). body=${created.text}`,
		).toBe(201);

		const staff = created.json;
		expect(
			staff.worktreePath,
			"STAFF_CWD_PARITY_POLYREPO: poly-repo staff must allocate a branch container worktreePath",
		).toBeTruthy();
		expect(
			isSameOrUnder(staff.worktreePath, wtRoot),
			`STAFF_CWD_PARITY_POLYREPO: staff worktreePath=${staff.worktreePath} must be under the project worktree root ${wtRoot}`,
		).toBe(true);

		// Per-repo worktrees recorded on the staff record: exactly the two git
		// sub-repos, NEVER the non-git "." container.
		const staffRepoKeys = Object.keys((staff.repoWorktrees ?? {}) as Record<string, string>).sort();
		expect(
			staffRepoKeys,
			`STAFF_CWD_PARITY_POLYREPO: staff.repoWorktrees must cover exactly the git sub-repos. got=${JSON.stringify(staff.repoWorktrees)}`,
		).toEqual(["repo-a", "repo-b"]);
		expect(
			staffRepoKeys.includes("."),
			"STAFF_CWD_PARITY_POLYREPO: the non-git '.' container must never appear in staff.repoWorktrees",
		).toBe(false);

		// On disk: each git sub-repo is worktree'd under the staff container; the
		// container root was never worktree'd (no top-level .git).
		const staffReposOnDisk = worktreedReposOnDisk(staff.worktreePath, candidateRepos);
		expect(
			staffReposOnDisk,
			`STAFF_CWD_PARITY_POLYREPO: on-disk staff worktrees must be exactly the git sub-repos under ${staff.worktreePath}`,
		).toEqual(["repo-a", "repo-b"]);
		expect(
			existsSync(join(staff.worktreePath, ".git")),
			`STAFF_CWD_PARITY_POLYREPO: the non-git container ${staff.worktreePath} must never be worktree'd (no top-level .git)`,
		).toBe(false);

		// The permanent staff session runs inside the branch container.
		const staffSession = await getSession(staff.currentSessionId);
		expect(
			isSameOrUnder(staffSession.cwd, staff.worktreePath),
			`STAFF_CWD_PARITY_POLYREPO: staff session cwd=${staffSession.cwd} must run inside the staff branch container ${staff.worktreePath}`,
		).toBe(true);

		// ── Criterion 1 + 3: SESSION worktree shape (parity) ───────────────
		const sessionRes = await rawApiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({
				projectId: project.id,
				worktree: true,
			}),
		});
		const sessionCreate = await sessionRes.json();
		if (sessionRes.status === 201 && sessionCreate?.id) cleanupSessionIds.push(sessionCreate.id);
		expect(
			sessionRes.status,
			`STAFF_CWD_PARITY_POLYREPO: regular session creation in the same poly-repo must succeed. body=${JSON.stringify(sessionCreate)}`,
		).toBe(201);

		const session = await waitForSessionWorktree(sessionCreate.id, candidateRepos);
		expect(
			isSameOrUnder(session.worktreePath, wtRoot),
			`STAFF_CWD_PARITY_POLYREPO: session worktreePath=${session.worktreePath} must be under the same project worktree root ${wtRoot}`,
		).toBe(true);

		const sessionReposOnDisk = worktreedReposOnDisk(session.worktreePath, candidateRepos);
		expect(
			sessionReposOnDisk,
			`STAFF_CWD_PARITY_POLYREPO: on-disk session worktrees must be exactly the git sub-repos under ${session.worktreePath}`,
		).toEqual(["repo-a", "repo-b"]);
		expect(
			existsSync(join(session.worktreePath, ".git")),
			`STAFF_CWD_PARITY_POLYREPO: the non-git container ${session.worktreePath} must never be worktree'd for a session either`,
		).toBe(false);

		// ── Parity assertion ───────────────────────────────────────────────
		// Staff and session must agree on WHICH repos get worktrees. They run on
		// distinct branches (distinct containers under the same `<root>-wt/`), so
		// parity is over the SET of worktree'd repos, not the absolute paths.
		expect(
			staffReposOnDisk,
			`STAFF_CWD_PARITY_POLYREPO: staff and session must worktree the SAME set of repos. staff=${JSON.stringify(staffReposOnDisk)} session=${JSON.stringify(sessionReposOnDisk)}`,
		).toEqual(sessionReposOnDisk);
		expect(
			staffRepoKeys,
			"STAFF_CWD_PARITY_POLYREPO: staff.repoWorktrees keys must match the session's on-disk worktree set",
		).toEqual(sessionReposOnDisk);

		// Criterion 2 (belt-and-braces): the non-git container root itself was
		// never turned into a git worktree by EITHER path.
		expect(
			existsSync(join(projectRoot, ".git")),
			`STAFF_CWD_PARITY_POLYREPO: the registered non-git container root ${projectRoot} must remain non-git after staff + session creation`,
		).toBe(false);
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
