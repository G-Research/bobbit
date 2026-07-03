import { test as base, expect } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MOCK_AGENT = resolve(__dirname, "mock-agent.mjs");
const HEADQUARTERS_PROJECT_ID = "headquarters";
const HEADQUARTERS_PROJECT_NAME = "Headquarters";
const SYSTEM_PROJECT_ID = "system";

const test = base;
test.describe.configure({ mode: "serial" });

function e2eTempRoot(): string {
	if (existsSync("/.dockerenv")) return "/tmp";
	return process.platform === "win32"
		? (process.env.BOBBIT_E2E_TMP_ROOT || "C:\\bobbit-e2e")
		: join(realpathSync(tmpdir()), "bobbit-e2e");
}

function uniqueDir(label: string): string {
	const dir = join(e2eTempRoot(), `.e2e-hq-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(dir, { recursive: true });
	return realpathSync(dir);
}

function samePath(a: string, b: string): boolean {
	const ra = (() => { try { return realpathSync(a); } catch { return path.resolve(a); } })();
	const rb = (() => { try { return realpathSync(b); } catch { return path.resolve(b); } })();
	return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

function projectRecord(id: string, name: string, rootPath: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		name,
		rootPath,
		createdAt: Date.now(),
		colorLight: "#6366f1",
		colorDark: "#818cf8",
		...extra,
	};
}

interface StartOptions {
	serverRoot?: string;
	bobbitDir?: string;
	agentDir?: string;
	clean?: boolean;
	projects?: unknown[];
	preferences?: Record<string, unknown>;
	stateFiles?: Record<string, unknown>;
}

interface StartedGateway {
	baseURL: string;
	serverRoot: string;
	bobbitDir: string;
	agentDir: string;
	token: string;
	request: (urlPath: string, init?: RequestInit) => Promise<Response>;
	json: (urlPath: string, init?: RequestInit) => Promise<{ status: number; body: any; text: string }>;
	shutdown: (cleanup?: boolean) => Promise<void>;
}

async function startHeadquartersGateway(opts: StartOptions = {}): Promise<StartedGateway> {
	const serverRoot = opts.serverRoot ?? uniqueDir("server");
	const bobbitDir = opts.bobbitDir ?? join(serverRoot, ".bobbit");
	const agentDir = opts.agentDir ?? join(bobbitDir, "agent");
	if (opts.clean !== false) {
		rmSync(serverRoot, { recursive: true, force: true });
		if (!samePath(bobbitDir, join(serverRoot, ".bobbit"))) rmSync(bobbitDir, { recursive: true, force: true });
	}
	mkdirSync(serverRoot, { recursive: true });
	mkdirSync(join(bobbitDir, "state"), { recursive: true });
	mkdirSync(join(bobbitDir, "config"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(bobbitDir, "state", "session-prompts"), { recursive: true });

	const projectsPath = join(bobbitDir, "state", "projects.json");
	if (opts.projects !== undefined || !existsSync(projectsPath)) {
		writeFileSync(projectsPath, JSON.stringify(opts.projects ?? [], null, 2));
	}
	const setupPath = join(bobbitDir, "state", "setup-complete");
	if (!existsSync(setupPath)) writeFileSync(setupPath, "e2e\n");
	const preferencesPath = join(bobbitDir, "state", "preferences.json");
	if (opts.preferences !== undefined || !existsSync(preferencesPath)) {
		writeFileSync(preferencesPath, JSON.stringify({ subgoalsEnabled: true, ...(opts.preferences ?? {}) }, null, 2));
	}
	for (const [name, data] of Object.entries(opts.stateFiles ?? {})) {
		writeFileSync(join(bobbitDir, "state", name), JSON.stringify(data, null, 2));
	}

	process.env.BOBBIT_DIR = bobbitDir;
	process.env.BOBBIT_AGENT_DIR = agentDir;
	process.env.NODE_ENV = "test";
	process.env.BOBBIT_SKIP_MCP = "1";
	process.env.BOBBIT_SKIP_NPM_CI = "1";
	process.env.BOBBIT_TEST_NO_PUSH = "1";
	process.env.BOBBIT_TEST_NO_REMOTE = "1";
	process.env.BOBBIT_TEST_NO_EXTERNAL = "1";
	process.env.BOBBIT_LLM_REVIEW_SKIP = "1";
	process.env.BOBBIT_NO_OPEN = "1";
	process.env.BOBBIT_SKIP_AIGW_DISCOVERY = "1";
	process.env.BOBBIT_SKIP_TITLE_GEN = "1";
	process.env.BOBBIT_SKIP_WORKTREE_POOL = "1";

	const { setProjectRoot } = await import("../../dist/server/bobbit-dir.js");
	const { scaffoldBobbitDir } = await import("../../dist/server/scaffold.js");
	const { loadOrCreateToken } = await import("../../dist/server/auth/token.js");
	const { createGateway } = await import("../../dist/server/server.js");
	const { registerRpcBridgeFactory } = await import("../../dist/server/agent/rpc-bridge.js");
	const { InProcessMockBridge, shouldUseInProcessMock } = await import("./in-process-mock-bridge.mjs");
	registerRpcBridgeFactory((bridgeOpts: any) => shouldUseInProcessMock(bridgeOpts.cliPath) ? new InProcessMockBridge(bridgeOpts) : null);

	setProjectRoot(serverRoot);
	scaffoldBobbitDir(serverRoot);
	const token = loadOrCreateToken();
	const gw = createGateway({
		host: "127.0.0.1",
		port: 0,
		portExplicit: true,
		authToken: token,
		defaultCwd: serverRoot,
		forceAuth: true,
		agentCliPath: MOCK_AGENT,
	});
	const port = await gw.start();
	const baseURL = `http://127.0.0.1:${port}`;
	writeFileSync(join(bobbitDir, "state", "gateway-url"), baseURL, "utf-8");
	process.env.BOBBIT_GATEWAY_URL = baseURL;
	process.env.BOBBIT_TOKEN = token;

	const request = (urlPath: string, init: RequestInit = {}) => fetch(`${baseURL}${urlPath}`, {
		...init,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
			...(init.headers as Record<string, string> | undefined),
		},
	});
	const json = async (urlPath: string, init: RequestInit = {}) => {
		const resp = await request(urlPath, init);
		const text = await resp.text();
		let body: any;
		try { body = text ? JSON.parse(text) : null; } catch { body = null; }
		return { status: resp.status, body, text };
	};

	return {
		baseURL,
		serverRoot,
		bobbitDir,
		agentDir,
		token,
		request,
		json,
		shutdown: async (cleanup = true) => {
			await gw.shutdown();
			if (cleanup) {
				try { rmSync(serverRoot, { recursive: true, force: true }); } catch {}
				if (!samePath(bobbitDir, join(serverRoot, ".bobbit"))) {
					try { rmSync(bobbitDir, { recursive: true, force: true }); } catch {}
				}
			}
		},
	};
}

function expectHeadquartersProject(project: any, serverRoot: string): void {
	expect(project).toMatchObject({
		id: HEADQUARTERS_PROJECT_ID,
		name: HEADQUARTERS_PROJECT_NAME,
		kind: "headquarters",
	});
	expect(project.hidden).not.toBe(true);
	expect(project.provisional).not.toBe(true);
	expect(project.position).toBeUndefined();
	expect(samePath(project.rootPath, serverRoot), `expected ${project.rootPath} to equal ${serverRoot}`).toBe(true);
}

test.describe("Headquarters API startup and project listing", () => {
	test("fresh startup registers visible Headquarters by default and keeps system hidden", async () => {
		const gw = await startHeadquartersGateway({ projects: [] });
		try {
			const list = await gw.json("/api/projects");
			expect(list.status).toBe(200);
			expect(Array.isArray(list.body)).toBe(true);
			expect(list.body.map((p: any) => p.id)).toContain(HEADQUARTERS_PROJECT_ID);
			expect(list.body.map((p: any) => p.id)).not.toContain(SYSTEM_PROJECT_ID);
			expectHeadquartersProject(list.body[0], gw.serverRoot);

			const hq = await gw.json(`/api/projects/${HEADQUARTERS_PROJECT_ID}`);
			expect(hq.status).toBe(200);
			expectHeadquartersProject(hq.body, gw.serverRoot);

			const system = await gw.json(`/api/projects/${SYSTEM_PROJECT_ID}`);
			expect(system.status).toBe(200);
			expect(system.body).toMatchObject({ id: SYSTEM_PROJECT_ID, hidden: true, kind: "system" });
			expect(samePath(system.body.rootPath, join(gw.bobbitDir, "state", "system-project"))).toBe(true);
		} finally {
			await gw.shutdown();
		}
	});

	test("showHeadquartersInProjectLists=false hides only list output and persists across restart", async () => {
		let gw = await startHeadquartersGateway({ projects: [] });
		const serverRoot = gw.serverRoot;
		const bobbitDir = gw.bobbitDir;
		const agentDir = gw.agentDir;
		try {
			const hide = await gw.json("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ showHeadquartersInProjectLists: false }),
			});
			expect(hide.status).toBe(200);
			expect(hide.body.showHeadquartersInProjectLists).toBe(false);

			let list = await gw.json("/api/projects");
			expect(list.status).toBe(200);
			expect(list.body.map((p: any) => p.id)).not.toContain(HEADQUARTERS_PROJECT_ID);
			const explicitWhileHidden = await gw.json(`/api/projects/${HEADQUARTERS_PROJECT_ID}`);
			expect(explicitWhileHidden.status).toBe(200);
			expectHeadquartersProject(explicitWhileHidden.body, serverRoot);

			await gw.shutdown(false);
			gw = await startHeadquartersGateway({ serverRoot, bobbitDir, agentDir, clean: false });
			list = await gw.json("/api/projects");
			expect(list.status).toBe(200);
			expect(list.body.map((p: any) => p.id)).not.toContain(HEADQUARTERS_PROJECT_ID);

			const show = await gw.json("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ showHeadquartersInProjectLists: true }),
			});
			expect(show.status).toBe(200);
			expect(show.body.showHeadquartersInProjectLists).toBe(true);
			await gw.shutdown(false);
			gw = await startHeadquartersGateway({ serverRoot, bobbitDir, agentDir, clean: false });
			list = await gw.json("/api/projects");
			expect(list.status).toBe(200);
			expect(list.body.map((p: any) => p.id)).toContain(HEADQUARTERS_PROJECT_ID);
		} finally {
			await gw.shutdown();
		}
	});
});

test.describe("Headquarters project lifecycle protections", () => {
	test("rejects destructive lifecycle mutations and server-root archive/preflight remediation", async () => {
		const gw = await startHeadquartersGateway({ projects: [] });
		try {
			for (const [label, response] of [
				["delete", await gw.json(`/api/projects/${HEADQUARTERS_PROJECT_ID}`, { method: "DELETE" })],
				["update", await gw.json(`/api/projects/${HEADQUARTERS_PROJECT_ID}`, { method: "PUT", body: JSON.stringify({ name: "Moved", rootPath: uniqueDir("bad-root") }) })],
				["promote", await gw.json(`/api/projects/${HEADQUARTERS_PROJECT_ID}/promote`, { method: "POST", body: JSON.stringify({ name: "Moved" }) })],
			] as const) {
				expect(response.status, `${label} should be forbidden`).toBe(403);
				expect(response.body?.code, `${label} should use the immutable error code`).toBe("HEADQUARTERS_IMMUTABLE");
			}

			const archive = await gw.json("/api/projects/archive-bobbit", {
				method: "POST",
				body: JSON.stringify({ rootPath: gw.serverRoot }),
			});
			expect(archive.status).toBe(403);
			expect(String(archive.body?.code ?? archive.body?.error)).toMatch(/HEADQUARTERS_IMMUTABLE|gateway-owned|Headquarters/i);
			expect(existsSync(gw.bobbitDir), "gateway-owned .bobbit must not be moved").toBe(true);

			const preflight = await gw.json(`/api/projects/preflight?path=${encodeURIComponent(gw.serverRoot)}`);
			expect(preflight.status).toBe(200);
			const archiveRemediation = preflight.body.checks.find((check: any) => check.remediation?.kind === "archive-bobbit");
			expect(archiveRemediation, "server root preflight must not offer archive-bobbit remediation").toBeUndefined();
			const gatewayOwned = preflight.body.checks.find((check: any) => check.id === "bobbit.gateway-owned");
			expect(gatewayOwned?.level).toMatch(/pass|warn|info/);
		} finally {
			await gw.shutdown();
		}
	});
});

test.describe("Headquarters ordering and normal projects", () => {
	test("anchors Headquarters first and excludes it from PUT /api/projects/order payloads", async () => {
		const gw = await startHeadquartersGateway({ projects: [] });
		try {
			const rootA = uniqueDir("normal-a");
			const rootB = uniqueDir("normal-b");
			const createA = await gw.json("/api/projects", { method: "POST", body: JSON.stringify({ name: "A", rootPath: rootA, acceptCanonical: true, __e2e_seed_skip__: true }) });
			const createB = await gw.json("/api/projects", { method: "POST", body: JSON.stringify({ name: "B", rootPath: rootB, acceptCanonical: true, __e2e_seed_skip__: true }) });
			expect(createA.status).toBe(201);
			expect(createB.status).toBe(201);
			const a = createA.body;
			const b = createB.body;

			const reorder = await gw.json("/api/projects/order", { method: "PUT", body: JSON.stringify({ projectIds: [b.id, a.id] }) });
			expect(reorder.status).toBe(200);
			expect(reorder.body.projects.map((p: any) => p.id)).toEqual([HEADQUARTERS_PROJECT_ID, b.id, a.id]);

			const list = await gw.json("/api/projects");
			expect(list.status).toBe(200);
			expect(list.body.map((p: any) => p.id)).toEqual([HEADQUARTERS_PROJECT_ID, b.id, a.id]);
			expect(list.body[0].position).toBeUndefined();
			expect(list.body.slice(1).map((p: any) => p.position)).toEqual([0, 1]);

			const withHq = await gw.json("/api/projects/order", { method: "PUT", body: JSON.stringify({ projectIds: [HEADQUARTERS_PROJECT_ID, a.id, b.id] }) });
			expect(withHq.status).toBe(400);
			expect(withHq.body.code).toBe("invalid_project_order");

			const duplicateServerRoot = await gw.json("/api/projects", { method: "POST", body: JSON.stringify({ name: "Duplicate HQ", rootPath: gw.serverRoot, acceptCanonical: true }) });
			expect([200, 400, 409]).toContain(duplicateServerRoot.status);
			if (duplicateServerRoot.status === 200) {
				expect(duplicateServerRoot.body.id).toBe(HEADQUARTERS_PROJECT_ID);
			} else {
				expect(String(duplicateServerRoot.body?.code ?? duplicateServerRoot.body?.error)).toMatch(/headquarters|server/i);
			}
		} finally {
			await gw.shutdown();
		}
	});
});

test.describe("Headquarters BOBBIT_DIR config aliasing", () => {
	test("server roles/tools/policies resolve for Headquarters as server origin while workflows stay project-scoped", async () => {
		const serverRoot = uniqueDir("alias-root");
		const redirectedBobbitDir = uniqueDir("alias-bobbit");
		const gw = await startHeadquartersGateway({ serverRoot, bobbitDir: redirectedBobbitDir, projects: [] });
		try {
			const hq = await gw.json(`/api/projects/${HEADQUARTERS_PROJECT_ID}`);
			expect(hq.status).toBe(200);
			expectHeadquartersProject(hq.body, serverRoot);
			expect(existsSync(join(redirectedBobbitDir, "config"))).toBe(true);
			expect(existsSync(join(serverRoot, ".bobbit", "config"))).toBe(false);

			const roleCreate = await gw.json("/api/roles", {
				method: "POST",
				body: JSON.stringify({
					name: "hq-api-role",
					label: "HQ API Role",
					promptTemplate: "server role for Headquarters alias API test",
					accessory: "none",
					model: "openai/gpt-test",
					thinkingLevel: "medium",
				}),
			});
			expect(roleCreate.status).toBe(201);
			const hqRoles = await gw.json(`/api/roles?projectId=${HEADQUARTERS_PROJECT_ID}`);
			expect(hqRoles.status).toBe(200);
			const role = hqRoles.body.roles.find((entry: any) => entry.name === "hq-api-role");
			expect(role).toMatchObject({ name: "hq-api-role", origin: "server" });
			expect(hqRoles.body.roles.filter((entry: any) => entry.name === "hq-api-role")).toHaveLength(1);

			const policy = await gw.json("/api/tool-group-policies/Shell", { method: "PUT", body: JSON.stringify({ policy: "ask" }) });
			expect(policy.status).toBe(200);
			const hqPolicies = await gw.json(`/api/tool-group-policies?projectId=${HEADQUARTERS_PROJECT_ID}`);
			expect(hqPolicies.status).toBe(200);
			expect(hqPolicies.body.Shell).toMatchObject({ policy: "ask", origin: "server" });

			const workflowBody = {
				components: [{ name: "server", repo: "." }],
				workflows: {
					"hq-workflow": { id: "hq-workflow", name: "HQ Workflow", gates: [{ id: "one", name: "One" }] },
				},
			};
			const putConfig = await gw.json(`/api/projects/${HEADQUARTERS_PROJECT_ID}/config`, { method: "PUT", body: JSON.stringify(workflowBody) });
			expect(putConfig.status).toBe(200);
			const hqWorkflows = await gw.json(`/api/workflows?projectId=${HEADQUARTERS_PROJECT_ID}`);
			expect(hqWorkflows.status).toBe(200);
			expect((hqWorkflows.body.workflows ?? hqWorkflows.body).map((wf: any) => wf.id)).toContain("hq-workflow");
			const serverWorkflows = await gw.json("/api/workflows");
			expect(serverWorkflows.status).toBe(200);
			expect((serverWorkflows.body.workflows ?? serverWorkflows.body).map((wf: any) => wf.id)).not.toContain("hq-workflow");
		} finally {
			await gw.shutdown();
		}
	});
});

test.describe("Headquarters migration", () => {
	test("promotes an existing server-root project to Headquarters and rewrites structured project references", async () => {
		const serverRoot = uniqueDir("migration-root");
		const childRoot = uniqueDir("migration-child");
		const oldProjectId = "old-server-root-project";
		const now = Date.now();
		const gw = await startHeadquartersGateway({
			serverRoot,
			projects: [
				projectRecord(oldProjectId, "Old Server Root", serverRoot, { position: 0 }),
				projectRecord("child-project", "Child Project", childRoot, { parentProjectId: oldProjectId, position: 1 }),
			],
			stateFiles: {
				"goals.json": [{ id: "legacy-goal", title: "Legacy Goal", cwd: serverRoot, state: "todo", spec: "legacy spec", createdAt: now, updatedAt: now, projectId: oldProjectId, setupStatus: "ready" }],
				"sessions.json": [{ id: "legacy-session", title: "Legacy Session", cwd: serverRoot, agentSessionFile: join(serverRoot, "legacy.jsonl"), createdAt: now, lastActivity: now, projectId: oldProjectId }],
				"staff.json": [{ id: "legacy-staff", name: "Legacy Staff", description: "legacy", systemPrompt: "prompt", cwd: serverRoot, state: "active", triggers: [], memory: "", accessory: "none", createdAt: now, updatedAt: now, projectId: oldProjectId, sandboxed: false }],
			},
		});
		try {
			const list = await gw.json("/api/projects");
			expect(list.status).toBe(200);
			expect(list.body.map((p: any) => p.id)).toEqual([HEADQUARTERS_PROJECT_ID, "child-project"]);
			expectHeadquartersProject(list.body[0], serverRoot);
			expect(list.body.find((p: any) => p.id === "child-project").parentProjectId).toBe(HEADQUARTERS_PROJECT_ID);

			const storedProjects = JSON.parse(readFileSync(join(gw.bobbitDir, "state", "projects.json"), "utf-8"));
			expect(storedProjects.map((p: any) => p.id)).not.toContain(oldProjectId);
			expect(storedProjects.find((p: any) => p.id === "child-project").parentProjectId).toBe(HEADQUARTERS_PROJECT_ID);

			for (const file of ["goals.json", "sessions.json", "staff.json"]) {
				const data = JSON.parse(readFileSync(join(gw.bobbitDir, "state", file), "utf-8"));
				expect(JSON.stringify(data), `${file} must not retain the old server-root project id`).not.toContain(oldProjectId);
				expect(data[0].projectId).toBe(HEADQUARTERS_PROJECT_ID);
				expect(existsSync(join(gw.bobbitDir, "state", `${file}.pre-migration`)), `${file} should remain the central Headquarters state file, not be renamed away`).toBe(false);
			}
		} finally {
			await gw.shutdown();
		}
	});
});

test.describe("Headquarters no-git goals", () => {
	test("creates a worktree:false Headquarters goal with ready setup, gates/tasks/archive basics, and clear git-dependent responses", async () => {
		const gw = await startHeadquartersGateway({ projects: [] });
		try {
			const workflow = { id: "hq-data-only", name: "HQ Data Only", gates: [{ id: "plan", name: "Plan", content: true }] };
			const create = await gw.json("/api/goals", {
				method: "POST",
				body: JSON.stringify({
					title: "Headquarters data-only goal",
					spec: "Verify that a Headquarters no-git goal can use data-only API flows without branch or worktree assumptions.",
					projectId: HEADQUARTERS_PROJECT_ID,
					cwd: gw.serverRoot,
					worktree: false,
					autoStartTeam: false,
					workflowId: workflow.id,
					workflow,
				}),
			});
			expect(create.status).toBe(201);
			const goal = create.body;
			expect(goal.projectId).toBe(HEADQUARTERS_PROJECT_ID);
			expect(goal.setupStatus).toBe("ready");
			expect(goal.branch).toBeUndefined();
			expect(goal.worktreePath).toBeUndefined();
			expect(goal.repoPath).toBeUndefined();

			const gates = await gw.json(`/api/goals/${goal.id}/gates`);
			expect(gates.status).toBe(200);
			expect(gates.body.gates.map((gate: any) => gate.gateId)).toEqual(["plan"]);

			const task = await gw.json(`/api/goals/${goal.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "Data-only task", type: "testing", spec: "confirm task store works" }) });
			expect(task.status).toBe(201);
			expect(task.body.goalId).toBe(goal.id);

			const githubLink = await gw.json(`/api/goals/${goal.id}/github-link`);
			expect(githubLink.status).toBe(200);
			expect(githubLink.body).toMatchObject({ available: false, reason: "no-branch" });
			const optionalPrStatus = await gw.request(`/api/goals/${goal.id}/pr-status?optional=1`);
			expect([204, 400, 404, 409]).toContain(optionalPrStatus.status);
			if (optionalPrStatus.status !== 204 && optionalPrStatus.status !== 404) {
				const text = await optionalPrStatus.text();
				expect(text).toMatch(/branch|worktree|git|no PR|unavailable/i);
			}

			const archive = await gw.json(`/api/goals/${goal.id}?cascade=true`, { method: "DELETE" });
			expect(archive.status).toBe(200);
			expect(archive.body.archived).toBe(1);

			const archived = await gw.json(`/api/goals?archived=true&projectId=${HEADQUARTERS_PROJECT_ID}`);
			expect(archived.status).toBe(200);
			expect(archived.body.goals.map((g: any) => g.id)).toContain(goal.id);
		} finally {
			await gw.shutdown();
		}
	});
});
