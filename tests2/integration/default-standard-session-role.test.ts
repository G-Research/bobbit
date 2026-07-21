import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { copyGitTemplate } from "../harness/git-template.js";
import { loadServerTestRuntime } from "../harness/server-runtime.js";
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, defaultProject, nonGitCwd, registerProject } from "./_e2e/e2e-setup.js";

const REPRO = "DEFAULT_STANDARD_ROLE_MISMATCH";
const GENERAL_ROLE = "general";
const CUSTOM_ROLE = "default-role-project-fixture";
const MODEL = "anthropic/claude-opus-4-8";
const THINKING = "xhigh";
const GENERAL_PROMPT_MARKER = "DEFAULT_GENERAL_ROLE_PROMPT_MARKER";
const CUSTOM_PROMPT_MARKER = "EXPLICIT_PROJECT_ROLE_PROMPT_MARKER";

let project: { id: string; rootPath: string };
let worktreeProject: { id: string; rootPath: string };
let worktreeFixtureRoot = "";
let restoreCommandRunner: (() => void) | undefined;

interface CreatedSession {
	id: string;
	projectId?: string;
	role?: string;
	accessory?: string;
	assistantType?: string;
	worktreePath?: string;
}

interface RoleFixture {
	name: string;
	label: string;
	promptTemplate: string;
	accessory: string;
	toolPolicies: Record<string, "ask" | "never">;
	model: string;
	thinkingLevel: string;
}

const generalOverride: RoleFixture = {
	name: GENERAL_ROLE,
	label: "General",
	promptTemplate: GENERAL_PROMPT_MARKER,
	accessory: "flask",
	toolPolicies: { Shell: "never", "File System": "ask" },
	model: MODEL,
	thinkingLevel: THINKING,
};

const customRole: RoleFixture = {
	name: CUSTOM_ROLE,
	label: "Project Role Fixture",
	promptTemplate: CUSTOM_PROMPT_MARKER,
	accessory: "magnifier",
	toolPolicies: { Shell: "never", "File System": "ask" },
	model: MODEL,
	thinkingLevel: THINKING,
};

function cannedGit(cwd: string, args: readonly string[]): string {
	const key = args.join(" ");
	if (key === "rev-parse --show-toplevel") return cwd;
	if (key === "rev-parse --is-inside-work-tree") return "true";
	if (key === "rev-parse --verify HEAD" || key === "rev-parse --verify refs/heads/master" || key === "rev-parse --verify origin/master") {
		return "a".repeat(40);
	}
	if (key === "symbolic-ref refs/remotes/origin/HEAD") return "refs/remotes/origin/master";
	if (args[0] === "rev-parse" && args[1] === "--verify") throw new Error(`missing ref: ${args[2]}`);
	if (args[0] === "worktree" && args[1] === "add") {
		const worktreePath = args[2] === "-b" ? args[4] : args[2];
		mkdirWorktree(worktreePath);
		return "";
	}
	if (args[0] === "worktree" && args[1] === "remove") {
		rmSync(args[2], { recursive: true, force: true });
		return "";
	}
	if (["branch", "fetch", "push"].includes(args[0])) return "";
	if (args[0] === "remote" && args[1] === "get-url") throw new Error("no remote");
	throw new Error(`unexpected canned git command (${cwd}): ${key}`);
}

function mkdirWorktree(worktreePath: string): void {
	const gitMarker = join(worktreePath, ".git");
	if (!existsSync(worktreePath)) {
		mkdirSync(worktreePath, { recursive: true });
		writeFileSync(gitMarker, "gitdir: canned\n");
	}
}

async function installCannedGitRunner(): Promise<void> {
	const runtime = await loadServerTestRuntime();
	const runner = runtime.gatewayDeps.realCommandRunner;
	const original = { execFile: runner.execFile, execFileSync: runner.execFileSync, spawn: runner.spawn };
	runner.execFile = async (file, args, options) => {
		if (basename(file).toLowerCase().replace(/\.exe$/, "") !== "git") throw new Error(`unexpected command: ${file}`);
		return { stdout: cannedGit(String(options?.cwd ?? ""), args), stderr: "" };
	};
	runner.execFileSync = (file, args, options) => {
		if (basename(file).toLowerCase().replace(/\.exe$/, "") !== "git") throw new Error(`unexpected command: ${file}`);
		return cannedGit(String(options?.cwd ?? ""), args);
	};
	runner.spawn = undefined;
	restoreCommandRunner = () => Object.assign(runner, original);
}

async function readJson(response: Response): Promise<any> {
	const text = await response.text();
	try {
		return text ? JSON.parse(text) : {};
	} catch {
		return { raw: text };
	}
}

async function putProjectRole(projectId: string, role: RoleFixture): Promise<void> {
	const response = await apiFetch("/api/roles", {
		method: "POST",
		body: JSON.stringify({ ...role, projectId }),
	});
	const body = await readJson(response);
	expect(response.status, `create project role ${role.name}; body=${JSON.stringify(body)}`).toBe(201);
	expect(body).toMatchObject({
		name: role.name,
		promptTemplate: role.promptTemplate,
		accessory: role.accessory,
		toolPolicies: role.toolPolicies,
		model: MODEL,
		thinkingLevel: THINKING,
	});
}

async function removeProjectRole(projectId: string, name: string): Promise<void> {
	await apiFetch(`/api/roles/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`, {
		method: "DELETE",
	}).catch(() => undefined);
}

async function createSession(body: Record<string, unknown>): Promise<CreatedSession> {
	const response = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify(body),
	});
	const payload = await readJson(response);
	expect(response.status, `POST /api/sessions failed; body=${JSON.stringify(payload)}`).toBe(201);
	expect(payload.id, "POST /api/sessions must return a session id").toBeTruthy();
	return payload as CreatedSession;
}

async function purgeSession(id: string | undefined): Promise<void> {
	if (!id) return;
	await apiFetch(`/api/sessions/${encodeURIComponent(id)}?purge=true`, { method: "DELETE" }).catch(() => undefined);
}

async function roleSurfaces(gateway: any, created: CreatedSession): Promise<Record<string, string | null>> {
	const detailResponse = await apiFetch(`/api/sessions/${encodeURIComponent(created.id)}`);
	const detail = await readJson(detailResponse);
	expect(detailResponse.status, `GET /api/sessions/${created.id}; body=${JSON.stringify(detail)}`).toBe(200);

	const listProjectId = created.projectId ?? project.id;
	const listResponse = await apiFetch(`/api/sessions?projectId=${encodeURIComponent(listProjectId)}`);
	const listBody = await readJson(listResponse);
	expect(listResponse.status, `GET /api/sessions list; body=${JSON.stringify(listBody)}`).toBe(200);
	const listed = (listBody.sessions ?? listBody).find((session: any) => session.id === created.id);
	expect(listed, `GET /api/sessions must include ${created.id}`).toBeTruthy();

	return {
		post: created.role ?? null,
		live: gateway.sessionManager.getSession(created.id)?.role ?? null,
		persisted: gateway.sessionManager.getPersistedSession(created.id)?.role ?? null,
		detail: detail.role ?? null,
		list: listed.role ?? null,
	};
}

async function expectRoleEverywhere(gateway: any, created: CreatedSession, expectedRole: string, message: string): Promise<void> {
	const observed = await roleSurfaces(gateway, created);
	expect(observed, message).toEqual({
		post: expectedRole,
		live: expectedRole,
		persisted: expectedRole,
		detail: expectedRole,
		list: expectedRole,
	});
}

function expectInitialRoleConfiguration(
	gateway: any,
	sessionId: string,
	expected: { role: string; promptMarker: string; accessory: string },
): void {
	const live = gateway.sessionManager.getSession(sessionId);
	const persisted = gateway.sessionManager.getPersistedSession(sessionId);
	const promptParts = gateway.sessionManager.getPromptParts(sessionId);

	expect(live, `live session ${sessionId}`).toBeTruthy();
	expect(live.role).toBe(expected.role);
	expect(live.accessory).toBe(expected.accessory);
	expect(persisted?.role).toBe(expected.role);
	expect(persisted?.accessory).toBe(expected.accessory);
	expect(String(promptParts?.rolePrompt ?? ""), "resolved role prompt must reach initial prompt assembly").toContain(expected.promptMarker);
	expect(live.spawnPinnedModel, "resolved role model must reach initial spawn").toBe(MODEL);
	expect(live.spawnPinnedThinkingLevel, "resolved role thinking level must reach initial spawn").toBe(THINKING);
	expect(live.allowedTools, "resolved role tool policies must produce an initial allowlist").toContain("read");
	expect(live.allowedTools).not.toContain("bash");
	expect(live.allowedTools).not.toContain("bash_bg");
}

async function waitForGenuineWorktree(gateway: any, sessionId: string, sourceRepo: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	let observed: Record<string, unknown> = {};
	while (Date.now() < deadline) {
		const live = gateway.sessionManager.getSession(sessionId);
		observed = {
			status: live?.status ?? null,
			worktreePath: live?.worktreePath ?? null,
			worktreeGitExists: live?.worktreePath ? existsSync(join(live.worktreePath, ".git")) : false,
		};
		if (observed.worktreePath && observed.worktreePath !== sourceRepo && observed.worktreeGitExists) return;
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	expect(
		observed.worktreeGitExists === true,
		`worktree:true against a committed fixture repository must create a distinct Git worktree; observed=${JSON.stringify(observed)}`,
	).toBe(true);
}

async function waitForInitialRoleConfiguration(gateway: any, sessionId: string, promptMarker: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	let observed: Record<string, unknown> = {};
	while (Date.now() < deadline) {
		const live = gateway.sessionManager.getSession(sessionId);
		const rolePrompt = String(gateway.sessionManager.getPromptParts(sessionId)?.rolePrompt ?? "");
		observed = {
			status: live?.status ?? null,
			spawnPinnedModel: live?.spawnPinnedModel ?? null,
			spawnPinnedThinkingLevel: live?.spawnPinnedThinkingLevel ?? null,
			rolePromptReady: rolePrompt.includes(promptMarker),
		};
		if (live?.status === "idle" && live.spawnPinnedModel === MODEL && live.spawnPinnedThinkingLevel === THINKING && observed.rolePromptReady) return;
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	expect(false, `resolved role configuration did not reach worktree initial spawn; observed=${JSON.stringify(observed)}`).toBe(true);
}

async function expectProjectRoles(projectId: string, roleNames: string[]): Promise<void> {
	const rolesResponse = await apiFetch(`/api/roles?projectId=${encodeURIComponent(projectId)}`);
	const rolesBody = await readJson(rolesResponse);
	expect(rolesResponse.status, JSON.stringify(rolesBody)).toBe(200);
	for (const roleName of roleNames) {
		const role = (rolesBody.roles ?? []).find((candidate: any) => candidate.name === roleName);
		expect(role, `${roleName} must resolve through the project role cascade`).toBeTruthy();
		expect(role.origin, `${roleName} must be project-resolved, not a server fallback`).toBe("project");
	}
}

test.beforeAll(async ({ gateway }) => {
	await installCannedGitRunner();
	project = await defaultProject();
	worktreeFixtureRoot = mkdtempSync(join(tmpdir(), "bobbit-default-role-worktree-"));
	const repoRoot = copyGitTemplate(join(worktreeFixtureRoot, "repo"));
	worktreeProject = await registerProject({
		name: `default-role-worktree-${process.pid}`,
		rootPath: repoRoot,
		components: [{ name: "repo", repo: "." }],
		seedWorkflows: false,
	});
	const worktreeContext = gateway.projectContextManager.getOrCreate(worktreeProject.id);
	expect(worktreeContext, "registered worktree fixture must have a project context").toBeTruthy();
	worktreeContext.projectConfigStore.set("base_ref", "master");

	await putProjectRole(project.id, generalOverride);
	await putProjectRole(project.id, customRole);
	await putProjectRole(worktreeProject.id, generalOverride);
	await expectProjectRoles(project.id, [GENERAL_ROLE, CUSTOM_ROLE]);
	await expectProjectRoles(worktreeProject.id, [GENERAL_ROLE]);
});

test.afterAll(async () => {
	if (worktreeProject) await removeProjectRole(worktreeProject.id, GENERAL_ROLE);
	if (project) {
		await removeProjectRole(project.id, CUSTOM_ROLE);
		await removeProjectRole(project.id, GENERAL_ROLE);
	}
	if (worktreeProject) {
		await apiFetch(`/api/projects/${encodeURIComponent(worktreeProject.id)}`, { method: "DELETE" }).catch(() => undefined);
	}
	if (worktreeFixtureRoot) rmSync(worktreeFixtureRoot, { recursive: true, force: true });
	restoreCommandRunner?.();
});

test.describe("POST /api/sessions defaults new standard sessions to the resolved general role", () => {
	test("non-worktree creation with omitted role persists general across every surface", async ({ gateway }) => {
		let created: CreatedSession | undefined;
		try {
			created = await createSession({ cwd: nonGitCwd(), projectId: project.id, worktree: false });
			await expectRoleEverywhere(
				gateway,
				created,
				GENERAL_ROLE,
				`${REPRO}: omitted roleId must resolve to role=general in POST, live state, persistence, detail, and list`,
			);
			expect(created.accessory).toBe(generalOverride.accessory);
			expectInitialRoleConfiguration(gateway, created.id, {
				role: GENERAL_ROLE,
				promptMarker: GENERAL_PROMPT_MARKER,
				accessory: generalOverride.accessory,
			});
		} finally {
			await purgeSession(created?.id);
		}
	});

	for (const [label, roleId] of [["empty string", ""], ["null", null]] as const) {
		test(`non-worktree creation with ${label} role also persists general`, async ({ gateway }) => {
			let created: CreatedSession | undefined;
			try {
				created = await createSession({ cwd: nonGitCwd(), projectId: project.id, worktree: false, roleId });
				await expectRoleEverywhere(
					gateway,
					created,
					GENERAL_ROLE,
					`${REPRO}: ${label} roleId must resolve to role=general in POST, live state, persistence, detail, and list`,
				);
			} finally {
				await purgeSession(created?.id);
			}
		});
	}

	test("genuine worktree creation with omitted role spawns and persists as general", async ({ gateway }) => {
		let created: CreatedSession | undefined;
		const sourceRepo = worktreeProject.rootPath;
		try {
			created = await createSession({ cwd: sourceRepo, projectId: worktreeProject.id, worktree: true });
			await waitForGenuineWorktree(gateway, created.id, sourceRepo);
			await expectRoleEverywhere(
				gateway,
				created,
				GENERAL_ROLE,
				`${REPRO}: worktree POST without roleId must resolve to role=general in POST, live state, persistence, detail, and list`,
			);
			expect(created.accessory).toBe(generalOverride.accessory);
			await waitForInitialRoleConfiguration(gateway, created.id, GENERAL_PROMPT_MARKER);
			expectInitialRoleConfiguration(gateway, created.id, {
				role: GENERAL_ROLE,
				promptMarker: GENERAL_PROMPT_MARKER,
				accessory: generalOverride.accessory,
			});
		} finally {
			await purgeSession(created?.id);
		}
	});

	test("an explicit project-resolved custom role keeps its full initial spawn configuration", async ({ gateway }) => {
		let created: CreatedSession | undefined;
		try {
			created = await createSession({
				cwd: nonGitCwd(),
				projectId: project.id,
				worktree: false,
				roleId: CUSTOM_ROLE,
			});
			await expectRoleEverywhere(
				gateway,
				created,
				CUSTOM_ROLE,
				"explicit project-resolved roles must not be replaced by the standard-session default",
			);
			expect(created.accessory).toBe(customRole.accessory);
			expectInitialRoleConfiguration(gateway, created.id, {
				role: CUSTOM_ROLE,
				promptMarker: CUSTOM_PROMPT_MARKER,
				accessory: customRole.accessory,
			});
		} finally {
			await purgeSession(created?.id);
		}
	});

	test("assistant creation retains the assistant role mapping", async ({ gateway }) => {
		let created: CreatedSession | undefined;
		try {
			created = await createSession({
				cwd: nonGitCwd(),
				projectId: project.id,
				assistantType: "role",
				worktree: false,
			});
			expect(created.assistantType).toBe("role");
			await expectRoleEverywhere(
				gateway,
				created,
				"assistant",
				"assistant sessions must retain assistantRoleForType mapping instead of defaulting to general",
			);
			expect(created.accessory).toBe("wand");
			expect(gateway.sessionManager.getPersistedSession(created.id)?.accessory).toBe("wand");
		} finally {
			await purgeSession(created?.id);
		}
	});
});
