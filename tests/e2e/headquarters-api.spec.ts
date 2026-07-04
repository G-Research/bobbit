import { test as base, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MOCK_AGENT = resolve(__dirname, "mock-agent.mjs");
const HEADQUARTERS_PROJECT_ID = "headquarters";
const HEADQUARTERS_PROJECT_NAME = "Headquarters";
const SYSTEM_PROJECT_ID = "system";
const SAME_ROOT_PROJECT_ID = "same-root-normal-project";
const SAME_ROOT_PROJECT_NAME = "Original Same Root Project";
const SAME_ROOT_WORKFLOW_ID = "same-root-normal-workflow";

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

function canonicalPath(p: string): string {
	try { return realpathSync(p); } catch { return path.resolve(p); }
}

function samePath(a: string, b: string): boolean {
	const ra = canonicalPath(a);
	const rb = canonicalPath(b);
	return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

function expectSamePath(actual: string, expected: string, label: string): void {
	expect(samePath(actual, expected), `${label}: expected ${actual} to equal ${expected}`).toBe(true);
}

function isSameOrUnder(child: string, parent: string): boolean {
	const c = canonicalPath(child);
	const p = canonicalPath(parent);
	const rel = path.relative(p, c);
	return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
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

function sameRootProjectRecord(serverRoot: string, extra: Record<string, unknown> = {}) {
	return projectRecord(SAME_ROOT_PROJECT_ID, SAME_ROOT_PROJECT_NAME, serverRoot, {
		position: 0,
		colorLight: "#0ea5e9",
		colorDark: "#38bdf8",
		...extra,
	});
}

interface StartOptions {
	serverRoot?: string;
	/** Override Headquarters itself. When omitted, default HQ is <serverRoot>/.bobbit/headquarters. */
	headquartersDir?: string;
	agentDir?: string;
	clean?: boolean;
	projects?: unknown[];
	preferences?: Record<string, unknown>;
	stateFiles?: Record<string, unknown>;
}

interface StartedGateway {
	baseURL: string;
	serverRoot: string;
	headquartersDir: string;
	normalBobbitDir: string;
	agentDir: string;
	token: string;
	request: (urlPath: string, init?: RequestInit) => Promise<Response>;
	json: (urlPath: string, init?: RequestInit) => Promise<{ status: number; body: any; text: string }>;
	shutdown: (cleanup?: boolean) => Promise<void>;
}

function writeJson(file: string, data: unknown): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(data, null, 2));
}

function readJsonFile(file: string): any {
	return JSON.parse(readFileSync(file, "utf-8"));
}

function readStoreRecords(file: string): any[] {
	if (!existsSync(file)) return [];
	const data = readJsonFile(file);
	if (Array.isArray(data)) return data;
	if (Array.isArray(data.sessions)) return data.sessions;
	if (Array.isArray(data.goals)) return data.goals;
	if (Array.isArray(data.staff)) return data.staff;
	if (Array.isArray(data.records)) return data.records;
	return [];
}

function seedNormalSameRootLayout(serverRoot: string, opts: { sessions?: unknown[]; goals?: unknown[]; staff?: unknown[] } = {}): void {
	const normalStateDir = join(serverRoot, ".bobbit", "state");
	const normalConfigDir = join(serverRoot, ".bobbit", "config");
	mkdirSync(normalStateDir, { recursive: true });
	mkdirSync(normalConfigDir, { recursive: true });
	writeFileSync(join(normalConfigDir, "project.yaml"), [
		"name: Original Same Root Project",
		"same_root_normal_marker: normal-project-config",
		"workflows:",
		`  ${SAME_ROOT_WORKFLOW_ID}:`,
		`    id: ${SAME_ROOT_WORKFLOW_ID}`,
		"    name: Same Root Normal Workflow",
		"    gates:",
		"      - id: plan",
		"        name: Plan",
		"",
	].join("\n"));
	writeJson(join(normalStateDir, "sessions.json"), opts.sessions ?? []);
	writeJson(join(normalStateDir, "goals.json"), opts.goals ?? []);
	writeJson(join(normalStateDir, "staff.json"), opts.staff ?? []);
}

async function startHeadquartersGateway(opts: StartOptions = {}): Promise<StartedGateway> {
	const serverRoot = opts.serverRoot ?? uniqueDir("server");
	const headquartersDir = opts.headquartersDir ?? join(serverRoot, ".bobbit", "headquarters");
	const normalBobbitDir = join(serverRoot, ".bobbit");
	const agentDir = opts.agentDir ?? join(headquartersDir, "agent");
	const usesOverride = opts.headquartersDir !== undefined;
	if (opts.clean !== false) {
		rmSync(serverRoot, { recursive: true, force: true });
		if (!isSameOrUnder(headquartersDir, serverRoot)) rmSync(headquartersDir, { recursive: true, force: true });
	}
	mkdirSync(serverRoot, { recursive: true });
	mkdirSync(join(headquartersDir, "state", "session-prompts"), { recursive: true });
	mkdirSync(join(headquartersDir, "config"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });

	const projectsPath = join(headquartersDir, "state", "projects.json");
	if (opts.projects !== undefined || !existsSync(projectsPath)) {
		writeJson(projectsPath, opts.projects ?? []);
	}
	const setupPath = join(headquartersDir, "state", "setup-complete");
	if (!existsSync(setupPath)) writeFileSync(setupPath, "e2e\n");
	const preferencesPath = join(headquartersDir, "state", "preferences.json");
	if (opts.preferences !== undefined || !existsSync(preferencesPath)) {
		writeJson(preferencesPath, { subgoalsEnabled: true, showHeadquartersInProjectLists: true, ...(opts.preferences ?? {}) });
	}
	for (const [name, data] of Object.entries(opts.stateFiles ?? {})) {
		writeJson(join(headquartersDir, "state", name), data);
	}

	const previousEnv: Record<string, string | undefined> = {
		BOBBIT_DIR: process.env.BOBBIT_DIR,
		BOBBIT_PI_DIR: process.env.BOBBIT_PI_DIR,
		BOBBIT_AGENT_DIR: process.env.BOBBIT_AGENT_DIR,
		NODE_ENV: process.env.NODE_ENV,
		BOBBIT_SKIP_MCP: process.env.BOBBIT_SKIP_MCP,
		BOBBIT_SKIP_NPM_CI: process.env.BOBBIT_SKIP_NPM_CI,
		BOBBIT_TEST_NO_PUSH: process.env.BOBBIT_TEST_NO_PUSH,
		BOBBIT_TEST_NO_REMOTE: process.env.BOBBIT_TEST_NO_REMOTE,
		BOBBIT_TEST_NO_EXTERNAL: process.env.BOBBIT_TEST_NO_EXTERNAL,
		BOBBIT_LLM_REVIEW_SKIP: process.env.BOBBIT_LLM_REVIEW_SKIP,
		BOBBIT_NO_OPEN: process.env.BOBBIT_NO_OPEN,
		BOBBIT_SKIP_AIGW_DISCOVERY: process.env.BOBBIT_SKIP_AIGW_DISCOVERY,
		BOBBIT_SKIP_TITLE_GEN: process.env.BOBBIT_SKIP_TITLE_GEN,
		BOBBIT_SKIP_WORKTREE_POOL: process.env.BOBBIT_SKIP_WORKTREE_POOL,
		BOBBIT_GATEWAY_URL: process.env.BOBBIT_GATEWAY_URL,
		BOBBIT_TOKEN: process.env.BOBBIT_TOKEN,
	};
	const restoreEnv = () => {
		for (const [key, value] of Object.entries(previousEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};

	if (usesOverride) process.env.BOBBIT_DIR = headquartersDir;
	else delete process.env.BOBBIT_DIR;
	delete process.env.BOBBIT_PI_DIR;
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
	// Re-assert seeded files after scaffolding; scaffold must be idempotent and should not overwrite them.
	if (opts.projects !== undefined) writeJson(projectsPath, opts.projects);
	if (opts.preferences !== undefined) writeJson(preferencesPath, { subgoalsEnabled: true, showHeadquartersInProjectLists: true, ...opts.preferences });
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
	writeFileSync(join(headquartersDir, "state", "gateway-url"), baseURL, "utf-8");
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
		headquartersDir,
		normalBobbitDir,
		agentDir,
		token,
		request,
		json,
		shutdown: async (cleanup = true) => {
			try { await gw.shutdown(); }
			finally { restoreEnv(); }
			if (cleanup) {
				try { rmSync(serverRoot, { recursive: true, force: true }); } catch {}
				if (!isSameOrUnder(headquartersDir, serverRoot)) {
					try { rmSync(headquartersDir, { recursive: true, force: true }); } catch {}
				}
			}
		},
	};
}

function expectHeadquartersProject(project: any, headquartersDir: string): void {
	expect(project).toMatchObject({
		id: HEADQUARTERS_PROJECT_ID,
		name: HEADQUARTERS_PROJECT_NAME,
		kind: "headquarters",
	});
	expect(project.hidden).not.toBe(true);
	expect(project.provisional).not.toBe(true);
	expect(project.position).toBeUndefined();
	expectSamePath(project.rootPath, headquartersDir, "Headquarters rootPath");
}

function expectSameRootNormalProject(project: any, serverRoot: string): void {
	expect(project).toMatchObject({ id: SAME_ROOT_PROJECT_ID, name: SAME_ROOT_PROJECT_NAME });
	expect(project.kind).not.toBe("headquarters");
	expect(project.hidden).not.toBe(true);
	expectSamePath(project.rootPath, serverRoot, "normal same-root rootPath");
}

async function startWithNormalSameRoot(opts: StartOptions = {}): Promise<StartedGateway> {
	const serverRoot = opts.serverRoot ?? uniqueDir("same-root");
	seedNormalSameRootLayout(serverRoot);
	return startHeadquartersGateway({
		...opts,
		serverRoot,
		projects: opts.projects ?? [sameRootProjectRecord(serverRoot)],
		clean: false,
	});
}

async function createSession(gw: StartedGateway, projectId: string): Promise<any> {
	const created = await gw.json("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ projectId }),
	});
	expect(created.status, `POST /api/sessions projectId=${projectId}: ${created.text}`).toBe(201);
	return created.body;
}

async function createGoal(gw: StartedGateway, projectId: string, workflowId?: string): Promise<any> {
	const created = await gw.json("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `${projectId} restart goal ${Date.now()}`,
			spec: "Verify same-root Headquarters split restart persistence for project-scoped goal records.",
			projectId,
			worktree: false,
			autoStartTeam: false,
			...(workflowId ? { workflowId } : {}),
		}),
	});
	expect(created.status, `POST /api/goals projectId=${projectId}: ${created.text}`).toBe(201);
	return created.body;
}

async function createStaff(gw: StartedGateway, projectId: string): Promise<any> {
	const created = await gw.json("/api/staff", {
		method: "POST",
		body: JSON.stringify({
			name: `${projectId} Restart Staff ${Date.now()}`,
			systemPrompt: "Keep this staff record for same-root restart persistence coverage.",
			projectId,
		}),
	});
	expect(created.status, `POST /api/staff projectId=${projectId}: ${created.text}`).toBe(201);
	return created.body;
}

test.describe("Headquarters same-root split API", () => {
	test("startup preserves a same-root normal project instead of promoting it to Headquarters", async () => {
		const gw = await startWithNormalSameRoot();
		try {
			const list = await gw.json("/api/projects");
			expect(list.status, list.text).toBe(200);
			expect(list.body.map((p: any) => p.id)).toEqual([HEADQUARTERS_PROJECT_ID, SAME_ROOT_PROJECT_ID]);
			expectHeadquartersProject(list.body[0], gw.headquartersDir);
			expectSameRootNormalProject(list.body[1], gw.serverRoot);

			const hq = await gw.json(`/api/projects/${HEADQUARTERS_PROJECT_ID}`);
			expect(hq.status, hq.text).toBe(200);
			expectHeadquartersProject(hq.body, gw.headquartersDir);

			const normal = await gw.json(`/api/projects/${SAME_ROOT_PROJECT_ID}`);
			expect(normal.status, normal.text).toBe(200);
			expectSameRootNormalProject(normal.body, gw.serverRoot);

			expect(existsSync(join(gw.headquartersDir, "state"))).toBe(true);
			expect(existsSync(join(gw.headquartersDir, "config"))).toBe(true);
			expect(existsSync(join(gw.normalBobbitDir, "state"))).toBe(true);
			expect(existsSync(join(gw.normalBobbitDir, "config"))).toBe(true);
			expectSamePath(join(gw.serverRoot, ".bobbit", "headquarters"), gw.headquartersDir, "default Headquarters directory");

			const storedProjects = readJsonFile(join(gw.headquartersDir, "state", "projects.json"));
			expect(storedProjects.map((p: any) => p.id).sort()).toEqual([HEADQUARTERS_PROJECT_ID, SAME_ROOT_PROJECT_ID, SYSTEM_PROJECT_ID].sort());
			expect(storedProjects.find((p: any) => p.id === SYSTEM_PROJECT_ID)).toMatchObject({ id: SYSTEM_PROJECT_ID, hidden: true, kind: "system" });
			expectSameRootNormalProject(storedProjects.find((p: any) => p.id === SAME_ROOT_PROJECT_ID), gw.serverRoot);

			const normalConfig = await gw.json(`/api/projects/${SAME_ROOT_PROJECT_ID}/config`);
			expect(normalConfig.status, normalConfig.text).toBe(200);
			expect(normalConfig.body.same_root_normal_marker).toBe("normal-project-config");
			const hqConfig = await gw.json(`/api/projects/${HEADQUARTERS_PROJECT_ID}/config`);
			expect(hqConfig.status, hqConfig.text).toBe(200);
			expect(hqConfig.body.same_root_normal_marker).toBeUndefined();
		} finally {
			await gw.shutdown();
		}
	});

	test("project assistant at the server run directory reuses the same-root normal project", async () => {
		const gw = await startWithNormalSameRoot();
		let sessionId: string | undefined;
		try {
			const created = await gw.json("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ assistantType: "project", cwd: gw.serverRoot }),
			});
			expect(created.status, created.text).toBe(201);
			sessionId = created.body.id;
			expect(created.body.provisionalProjectId).toBe(SAME_ROOT_PROJECT_ID);

			const session = await gw.json(`/api/sessions/${sessionId}`);
			expect(session.status, session.text).toBe(200);
			expect(session.body.projectId).toBe(SAME_ROOT_PROJECT_ID);
			expectSamePath(session.body.cwd, gw.serverRoot, "same-root project assistant cwd");

			const list = await gw.json("/api/projects");
			expect(list.status, list.text).toBe(200);
			expect(list.body.map((p: any) => p.id)).toEqual([HEADQUARTERS_PROJECT_ID, SAME_ROOT_PROJECT_ID]);
			expect(list.body.find((p: any) => p.id === SAME_ROOT_PROJECT_ID)?.provisional).not.toBe(true);
			const storedProjects = readJsonFile(join(gw.headquartersDir, "state", "projects.json"));
			expect(storedProjects.filter((p: any) => samePath(String(p.rootPath), gw.serverRoot) && !p.hidden).map((p: any) => p.id)).toEqual([SAME_ROOT_PROJECT_ID]);
		} finally {
			if (sessionId) await gw.request(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
			await gw.shutdown();
		}
	});

	test("Quick Session creation uses projectId as the scope and separates Headquarters from same-root project state", async () => {
		const gw = await startWithNormalSameRoot();
		try {
			const hqSession = await createSession(gw, HEADQUARTERS_PROJECT_ID);
			expect(hqSession.projectId).toBe(HEADQUARTERS_PROJECT_ID);
			expectSamePath(hqSession.cwd, gw.headquartersDir, "Headquarters session cwd");
			expect(hqSession.worktreePath).toBeUndefined();

			const normalSession = await createSession(gw, SAME_ROOT_PROJECT_ID);
			expect(normalSession.projectId).toBe(SAME_ROOT_PROJECT_ID);
			expectSamePath(normalSession.cwd, gw.serverRoot, "normal same-root session cwd");

			const hqSessions = readStoreRecords(join(gw.headquartersDir, "state", "sessions.json"));
			const normalSessions = readStoreRecords(join(gw.normalBobbitDir, "state", "sessions.json"));
			expect(hqSessions.map((s: any) => s.id)).toContain(hqSession.id);
			expect(hqSessions.map((s: any) => s.id)).not.toContain(normalSession.id);
			expect(normalSessions.map((s: any) => s.id)).toContain(normalSession.id);
			expect(normalSessions.map((s: any) => s.id)).not.toContain(hqSession.id);

			const missingProject = await gw.json("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ cwd: gw.serverRoot }),
			});
			expect(missingProject.status, missingProject.text).toBe(400);
			expect(missingProject.body?.code).toBe("PROJECT_ID_REQUIRED");
		} finally {
			await gw.shutdown();
		}
	});

	test("hide/show Headquarters is presentation-only and persists across restart with the same-root normal project intact", async () => {
		let gw = await startWithNormalSameRoot();
		const serverRoot = gw.serverRoot;
		const headquartersDir = gw.headquartersDir;
		const agentDir = gw.agentDir;
		try {
			const hide = await gw.json("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ showHeadquartersInProjectLists: false }),
			});
			expect(hide.status, hide.text).toBe(200);
			expect(hide.body.showHeadquartersInProjectLists).toBe(false);

			let list = await gw.json("/api/projects");
			expect(list.status, list.text).toBe(200);
			expect(list.body.map((p: any) => p.id)).toEqual([SAME_ROOT_PROJECT_ID]);
			expectSameRootNormalProject(list.body[0], serverRoot);
			const explicitHq = await gw.json(`/api/projects/${HEADQUARTERS_PROJECT_ID}`);
			expect(explicitHq.status, explicitHq.text).toBe(200);
			expectHeadquartersProject(explicitHq.body, headquartersDir);

			await gw.shutdown(false);
			gw = await startHeadquartersGateway({ serverRoot, headquartersDir, agentDir, clean: false });
			list = await gw.json("/api/projects");
			expect(list.status, list.text).toBe(200);
			expect(list.body.map((p: any) => p.id)).toEqual([SAME_ROOT_PROJECT_ID]);

			const show = await gw.json("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ showHeadquartersInProjectLists: true }),
			});
			expect(show.status, show.text).toBe(200);
			expect(show.body.showHeadquartersInProjectLists).toBe(true);

			await gw.shutdown(false);
			gw = await startHeadquartersGateway({ serverRoot, headquartersDir, agentDir, clean: false });
			list = await gw.json("/api/projects");
			expect(list.status, list.text).toBe(200);
			expect(list.body.map((p: any) => p.id)).toEqual([HEADQUARTERS_PROJECT_ID, SAME_ROOT_PROJECT_ID]);
			expectHeadquartersProject(list.body[0], headquartersDir);
			expectSameRootNormalProject(list.body[1], serverRoot);
		} finally {
			await gw.shutdown();
		}
	});

	test("BOBBIT_DIR overrides the Headquarters directory itself while normal same-root storage stays under <serverRoot>/.bobbit", async () => {
		const serverRoot = uniqueDir("override-server");
		const customHeadquartersDir = uniqueDir("override-headquarters");
		seedNormalSameRootLayout(serverRoot);
		const gw = await startHeadquartersGateway({
			serverRoot,
			headquartersDir: customHeadquartersDir,
			clean: false,
			projects: [sameRootProjectRecord(serverRoot)],
		});
		try {
			const list = await gw.json("/api/projects");
			expect(list.status, list.text).toBe(200);
			expect(list.body.map((p: any) => p.id)).toEqual([HEADQUARTERS_PROJECT_ID, SAME_ROOT_PROJECT_ID]);
			expectHeadquartersProject(list.body[0], customHeadquartersDir);
			expectSameRootNormalProject(list.body[1], serverRoot);
			expect(existsSync(join(customHeadquartersDir, "state", "projects.json"))).toBe(true);
			expect(existsSync(join(customHeadquartersDir, "config"))).toBe(true);
			expect(existsSync(join(serverRoot, ".bobbit", "state"))).toBe(true);
			expect(existsSync(join(serverRoot, ".bobbit", "config", "project.yaml"))).toBe(true);
			expect(existsSync(join(serverRoot, ".bobbit", "headquarters"))).toBe(false);

			const hqSession = await createSession(gw, HEADQUARTERS_PROJECT_ID);
			const normalSession = await createSession(gw, SAME_ROOT_PROJECT_ID);
			expectSamePath(hqSession.cwd, customHeadquartersDir, "BOBBIT_DIR Headquarters session cwd");
			expectSamePath(normalSession.cwd, serverRoot, "BOBBIT_DIR normal same-root session cwd");
			expect(readStoreRecords(join(customHeadquartersDir, "state", "sessions.json")).map((s: any) => s.id)).toContain(hqSession.id);
			expect(readStoreRecords(join(serverRoot, ".bobbit", "state", "sessions.json")).map((s: any) => s.id)).toContain(normalSession.id);
		} finally {
			await gw.shutdown();
		}
	});

	test("Add Project upsert can intentionally create a normal project at the server run directory and archive skips Headquarters", async () => {
		const serverRoot = uniqueDir("add-server-root");
		const gw = await startHeadquartersGateway({ serverRoot, clean: false, projects: [] });
		try {
			writeFileSync(join(gw.headquartersDir, "state", "hq-sentinel.txt"), "keep headquarters state");
			const preflight = await gw.json(`/api/projects/preflight?path=${encodeURIComponent(serverRoot)}`);
			expect(preflight.status, preflight.text).toBe(200);
			expect(preflight.body?.hasFail).toBe(false);
			expect(JSON.stringify(preflight.body)).not.toMatch(/HEADQUARTERS_ALREADY_EXISTS/);
			expect(JSON.stringify(preflight.body)).toMatch(/Headquarters|server run directory/i);
			expect(preflight.body.checks?.find((check: any) => check.remediation?.kind === "archive-bobbit"), "same-root add preflight must not offer to archive Headquarters").toBeUndefined();

			const create = await gw.json("/api/projects", {
				method: "POST",
				body: JSON.stringify({ name: SAME_ROOT_PROJECT_NAME, rootPath: serverRoot, upsert: true, acceptCanonical: true, __e2e_seed_skip__: true }),
			});
			expect([200, 201]).toContain(create.status);
			expect(create.body.id).not.toBe(HEADQUARTERS_PROJECT_ID);
			expectSamePath(create.body.rootPath, serverRoot, "created same-root normal project rootPath");

			const upsertAgain = await gw.json("/api/projects", {
				method: "POST",
				body: JSON.stringify({ name: "Same Root Reuse", rootPath: serverRoot, upsert: true, acceptCanonical: true, __e2e_seed_skip__: true }),
			});
			expect(upsertAgain.status, upsertAgain.text).toBe(200);
			expect(upsertAgain.body.id).toBe(create.body.id);
			expect(upsertAgain.body.id).not.toBe(HEADQUARTERS_PROJECT_ID);

			const duplicate = await gw.json("/api/projects", {
				method: "POST",
				body: JSON.stringify({ name: "Duplicate Same Root", rootPath: serverRoot, acceptCanonical: true, __e2e_seed_skip__: true }),
			});
			expect([400, 409]).toContain(duplicate.status);
			expect(String(duplicate.body?.code ?? duplicate.body?.error)).toMatch(/duplicate|already|project/i);

			mkdirSync(join(serverRoot, ".bobbit", "config"), { recursive: true });
			writeFileSync(join(serverRoot, ".bobbit", "config", "normal-sentinel.txt"), "normal project config");
			const archive = await gw.json("/api/projects/archive-bobbit", {
				method: "POST",
				body: JSON.stringify({ rootPath: serverRoot }),
			});
			expect(archive.status, archive.text).toBe(200);
			expect(existsSync(join(gw.headquartersDir, "state", "hq-sentinel.txt")), "archive-bobbit for the same-root normal project must not delete Headquarters state").toBe(true);
			expect(existsSync(gw.headquartersDir), "archive-bobbit for serverRoot must skip .bobbit/headquarters").toBe(true);

			const archiveHq = await gw.json("/api/projects/archive-bobbit", {
				method: "POST",
				body: JSON.stringify({ rootPath: gw.headquartersDir }),
			});
			expect(archiveHq.status, archiveHq.text).toBe(403);
			expect(archiveHq.body?.code).toBe("HEADQUARTERS_IMMUTABLE");
		} finally {
			await gw.shutdown();
		}
	});

	test("restart preserves distinct same-root sessions, goals, and staff records", async () => {
		let gw = await startWithNormalSameRoot();
		const serverRoot = gw.serverRoot;
		const headquartersDir = gw.headquartersDir;
		const agentDir = gw.agentDir;
		try {
			const hqSession = await createSession(gw, HEADQUARTERS_PROJECT_ID);
			const normalSession = await createSession(gw, SAME_ROOT_PROJECT_ID);
			const hqGoal = await createGoal(gw, HEADQUARTERS_PROJECT_ID);
			const normalGoal = await createGoal(gw, SAME_ROOT_PROJECT_ID, SAME_ROOT_WORKFLOW_ID);
			const hqStaff = await createStaff(gw, HEADQUARTERS_PROJECT_ID);
			const normalStaff = await createStaff(gw, SAME_ROOT_PROJECT_ID);

			await gw.shutdown(false);
			gw = await startHeadquartersGateway({ serverRoot, headquartersDir, agentDir, clean: false });

			const list = await gw.json("/api/projects");
			expect(list.status, list.text).toBe(200);
			expect(list.body.map((p: any) => p.id)).toEqual([HEADQUARTERS_PROJECT_ID, SAME_ROOT_PROJECT_ID]);

			const hqSessions = await gw.json(`/api/sessions?projectId=${HEADQUARTERS_PROJECT_ID}`);
			const normalSessions = await gw.json(`/api/sessions?projectId=${SAME_ROOT_PROJECT_ID}`);
			expect(hqSessions.status, hqSessions.text).toBe(200);
			expect(normalSessions.status, normalSessions.text).toBe(200);
			expect((hqSessions.body.sessions ?? hqSessions.body).map((s: any) => s.id)).toContain(hqSession.id);
			expect((hqSessions.body.sessions ?? hqSessions.body).map((s: any) => s.id)).not.toContain(normalSession.id);
			expect((normalSessions.body.sessions ?? normalSessions.body).map((s: any) => s.id)).toContain(normalSession.id);

			const hqGoals = await gw.json(`/api/goals?projectId=${HEADQUARTERS_PROJECT_ID}`);
			const normalGoals = await gw.json(`/api/goals?projectId=${SAME_ROOT_PROJECT_ID}`);
			expect(hqGoals.status, hqGoals.text).toBe(200);
			expect(normalGoals.status, normalGoals.text).toBe(200);
			expect((hqGoals.body.goals ?? hqGoals.body).map((g: any) => g.id)).toContain(hqGoal.id);
			expect((hqGoals.body.goals ?? hqGoals.body).map((g: any) => g.id)).not.toContain(normalGoal.id);
			expect((normalGoals.body.goals ?? normalGoals.body).map((g: any) => g.id)).toContain(normalGoal.id);

			const hqStaffList = await gw.json(`/api/staff?projectId=${HEADQUARTERS_PROJECT_ID}`);
			const normalStaffList = await gw.json(`/api/staff?projectId=${SAME_ROOT_PROJECT_ID}`);
			expect(hqStaffList.status, hqStaffList.text).toBe(200);
			expect(normalStaffList.status, normalStaffList.text).toBe(200);
			expect((hqStaffList.body.staff ?? hqStaffList.body).map((s: any) => s.id)).toContain(hqStaff.id);
			expect((hqStaffList.body.staff ?? hqStaffList.body).map((s: any) => s.id)).not.toContain(normalStaff.id);
			expect((normalStaffList.body.staff ?? normalStaffList.body).map((s: any) => s.id)).toContain(normalStaff.id);
		} finally {
			await gw.shutdown();
		}
	});

	test("system project remains hidden and anchored in Headquarters state", async () => {
		const gw = await startWithNormalSameRoot();
		try {
			const list = await gw.json("/api/projects");
			expect(list.status, list.text).toBe(200);
			expect(list.body.map((p: any) => p.id)).not.toContain(SYSTEM_PROJECT_ID);
			const system = await gw.json(`/api/projects/${SYSTEM_PROJECT_ID}`);
			expect(system.status, system.text).toBe(200);
			expect(system.body).toMatchObject({ id: SYSTEM_PROJECT_ID, hidden: true, kind: "system" });
			expectSamePath(system.body.rootPath, join(gw.headquartersDir, "state", "system-project"), "hidden system project rootPath");
		} finally {
			await gw.shutdown();
		}
	});
});

test.describe("Headquarters no-git goals", () => {
	test("Headquarters goals default to the Headquarters directory and do not allocate git/worktree state", async () => {
		const gw = await startHeadquartersGateway({ projects: [] });
		try {
			execFileSync("git", ["init"], { cwd: gw.serverRoot, stdio: "ignore" });
			const workflow = { id: "hq-git-data-only", name: "HQ Git Data Only", gates: [{ id: "plan", name: "Plan", content: true }] };
			const create = await gw.json("/api/goals", {
				method: "POST",
				body: JSON.stringify({
					title: "Headquarters git data-only goal",
					spec: "Verify that a Headquarters goal does not allocate a branch even when the server run directory is a git repo.",
					projectId: HEADQUARTERS_PROJECT_ID,
					worktree: true,
					autoStartTeam: false,
					workflowId: workflow.id,
					workflow,
				}),
			});
			expect([201, 422]).toContain(create.status);
			if (create.status === 422) {
				expect(create.body?.code).toBe("HEADQUARTERS_WORKTREE_UNAVAILABLE");
				return;
			}
			expect(create.body.projectId).toBe(HEADQUARTERS_PROJECT_ID);
			expectSamePath(create.body.cwd, gw.headquartersDir, "Headquarters goal cwd");
			expect(create.body.setupStatus).toBe("ready");
			expect(create.body.branch).toBeUndefined();
			expect(create.body.worktreePath).toBeUndefined();
			expect(create.body.repoPath).toBeUndefined();

			const gitStatus = await gw.json(`/api/goals/${create.body.id}/git-status`);
			expect(gitStatus.status, gitStatus.text).toBe(409);
			expect(gitStatus.body.code).toBe("GOAL_GIT_UNAVAILABLE");
		} finally {
			await gw.shutdown();
		}
	});
});
