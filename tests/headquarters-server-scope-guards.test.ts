import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TOKEN = "test-token";

function tmpDir(prefix: string): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function readJson<T = any>(filePath: string): T {
	return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function writePack(root: string, packName: string, body: string, skillName = "demo"): void {
	fs.mkdirSync(path.join(root, packName, "skills", skillName), { recursive: true });
	fs.writeFileSync(path.join(root, packName, "pack.yaml"), [
		`name: ${packName}`,
		"description: test pack",
		"version: 1.0.0",
		"contents:",
		"  roles: []",
		"  tools: []",
		`  skills: [${skillName}]`,
		"",
	].join("\n"), "utf-8");
	fs.writeFileSync(path.join(root, packName, "skills", skillName, "SKILL.md"), `---\nname: ${skillName}\ndescription: ${skillName} skill\n---\n${body}\n`, "utf-8");
}

function writeInstalledPack(root: string, packName: string, skillName = "demo"): void {
	writePack(root, packName, "installed", skillName);
	fs.writeFileSync(path.join(root, packName, ".pack-meta.yaml"), [
		`packName: ${packName}`,
		"version: 1.0.0",
		"scope: server",
		"sourceUrl: test",
		"sourceRef: main",
		"commit: test",
		"installedAt: test",
		"updatedAt: test",
		"",
	].join("\n"), "utf-8");
}

function samePath(a: string, b: string): boolean {
	const normalize = (value: string) => {
		let resolved = path.resolve(value);
		try { resolved = fs.realpathSync(resolved); } catch { /* textual fallback */ }
		const normalized = resolved.replace(/\\/g, "/").replace(/\/+$/, "");
		return process.platform === "win32" ? normalized.toLowerCase() : normalized;
	};
	return normalize(a) === normalize(b);
}

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
	return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
	for (const [key, value] of Object.entries(snapshot)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

async function startGateway(t: { after(fn: () => void | Promise<void>): void }, serverRoot: string, opts: { bobbitDir?: string } = {}) {
	const envKeys = [
		"BOBBIT_DIR",
		"BOBBIT_PI_DIR",
		"BOBBIT_AGENT_DIR",
		"BOBBIT_SKIP_MCP",
		"BOBBIT_SKIP_WORKTREE_POOL",
		"BOBBIT_SKIP_AIGW_DISCOVERY",
		"BOBBIT_TEST_NO_EXTERNAL",
		"BOBBIT_TEST_NO_REMOTE",
		"BOBBIT_TEST_NO_PUSH",
		"BOBBIT_SKIP_NPM_CI",
		"BOBBIT_NO_OPEN",
		"NODE_ENV",
	];
	const env = snapshotEnv(envKeys);
	const { setProjectRoot, getProjectRoot, resetAgentDirStateForTests } = await import("../src/server/bobbit-dir.ts");
	const previousProjectRoot = getProjectRoot();
	resetAgentDirStateForTests?.();
	setProjectRoot(serverRoot);

	if (opts.bobbitDir) process.env.BOBBIT_DIR = opts.bobbitDir;
	else delete process.env.BOBBIT_DIR;
	delete process.env.BOBBIT_PI_DIR;
	process.env.BOBBIT_AGENT_DIR = path.join(serverRoot, ".agent");
	process.env.BOBBIT_SKIP_MCP = "1";
	process.env.BOBBIT_SKIP_WORKTREE_POOL = "1";
	process.env.BOBBIT_SKIP_AIGW_DISCOVERY = "1";
	process.env.BOBBIT_TEST_NO_EXTERNAL = "1";
	process.env.BOBBIT_TEST_NO_REMOTE = "1";
	process.env.BOBBIT_TEST_NO_PUSH = "1";
	process.env.BOBBIT_SKIP_NPM_CI = "1";
	process.env.BOBBIT_NO_OPEN = "1";
	process.env.NODE_ENV = "test";

	const { createGateway } = await import("../src/server/server.ts");
	const gw = createGateway({
		host: "127.0.0.1",
		port: 0,
		portExplicit: true,
		authToken: TOKEN,
		defaultCwd: serverRoot,
		forceAuth: true,
		agentCliPath: path.join(process.cwd(), "tests", "e2e", "mock-agent.mjs"),
	});
	const port = await gw.start();
	t.after(async () => {
		try { await gw.shutdown(); } catch { /* best-effort */ }
		resetAgentDirStateForTests?.();
		setProjectRoot(previousProjectRoot);
		restoreEnv(env);
	});
	return { gw, baseUrl: `http://127.0.0.1:${port}` };
}

async function api(baseUrl: string, pathname: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
	const res = await fetch(`${baseUrl}${pathname}`, {
		method,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${TOKEN}`,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : null };
}

test("startup migrates legacy server state before the project registry loads", async (t) => {
	const serverRoot = tmpDir("bobbit-hq-startup-migration-");
	const legacyState = path.join(serverRoot, ".bobbit", "state");
	writeJson(path.join(legacyState, "projects.json"), [
		{
			id: "same-root-normal",
			name: "Same Root Normal",
			rootPath: serverRoot,
			createdAt: 1,
			position: 3,
		},
	]);
	writeJson(path.join(legacyState, "preferences.json"), { theme: "dark" });
	fs.writeFileSync(path.join(legacyState, "setup-complete"), "legacy\n", "utf-8");

	await startGateway(t, serverRoot);

	const headquartersState = path.join(serverRoot, ".bobbit", "headquarters", "state");
	const projects = readJson<Array<Record<string, unknown>>>(path.join(headquartersState, "projects.json"));
	assert.ok(projects.some((project) => project.id === "headquarters" && samePath(String(project.rootPath), path.join(serverRoot, ".bobbit", "headquarters"))));
	assert.ok(projects.some((project) => project.id === "same-root-normal" && samePath(String(project.rootPath), serverRoot)), "legacy same-root normal project should be visible after startup");
	assert.equal(readJson<{ theme: string }>(path.join(headquartersState, "preferences.json")).theme, "dark");
	assert.equal(fs.existsSync(path.join(headquartersState, ".headquarters-dir-migrated")), true);
});

test("server marketplace uses Headquarters config instead of same-root normal config", async (t) => {
	const serverRoot = tmpDir("bobbit-hq-marketplace-split-");
	writeJson(path.join(serverRoot, ".bobbit", "state", "projects.json"), [{
		id: "same-root-normal",
		name: "Same Root Normal",
		rootPath: serverRoot,
		createdAt: 1,
		position: 2,
	}]);
	const sameRootMarketPacks = path.join(serverRoot, ".bobbit", "config", "market-packs");
	writeInstalledPack(sameRootMarketPacks, "normal-only-pack");

	const { baseUrl } = await startGateway(t, serverRoot);
	const sourceRoot = path.join(serverRoot, "source-packs");
	writePack(sourceRoot, "hq-pack", "from headquarters");

	const source = await api(baseUrl, "/api/marketplace/sources", { url: sourceRoot });
	assert.equal(source.status, 201, JSON.stringify(source.body));
	const sourceId = source.body.source.id as string;
	const installed = await api(baseUrl, "/api/marketplace/install", { sourceId, dirName: "hq-pack", scope: "server" });
	assert.equal(installed.status, 201, JSON.stringify(installed.body));

	const headquartersMarketPacks = path.join(serverRoot, ".bobbit", "headquarters", "config", "market-packs");
	assert.equal(fs.existsSync(path.join(headquartersMarketPacks, "hq-pack", "pack.yaml")), true, "server install should write under Headquarters config");
	assert.equal(fs.existsSync(path.join(sameRootMarketPacks, "hq-pack")), false, "server install must not write into same-root normal project config");

	const listed = await api(baseUrl, "/api/marketplace/installed?projectId=headquarters");
	assert.equal(listed.status, 200, JSON.stringify(listed.body));
	const names = (listed.body.installed as Array<{ packName: string }>).map((pack) => pack.packName);
	assert.ok(names.includes("hq-pack"), "Headquarters server pack should be listed");
	assert.equal(names.includes("normal-only-pack"), false, "same-root normal project packs must not be listed as server/HQ packs");

	const activation = await api(baseUrl, "/api/marketplace/pack-activation?scope=server&packName=hq-pack&projectId=headquarters");
	assert.equal(activation.status, 200, JSON.stringify(activation.body));
	assert.deepEqual(activation.body.catalogue.skills, ["demo"]);
	const normalActivation = await api(baseUrl, "/api/marketplace/pack-activation?scope=server&packName=normal-only-pack&projectId=headquarters");
	assert.equal(normalActivation.status, 404, "activation catalogue must not read same-root normal pack");
});

test("delegate session creation validates cwd against the parent project and defaults to parent cwd", async (t) => {
	const serverRoot = tmpDir("bobbit-delegate-cwd-");
	const { baseUrl } = await startGateway(t, serverRoot);
	const register = await api(baseUrl, "/api/projects", { name: "Normal", rootPath: serverRoot, upsert: true });
	assert.ok(register.status === 200 || register.status === 201, JSON.stringify(register.body));
	const projectId = register.body.id as string;

	const parentCwd = path.join(serverRoot, "subdir");
	fs.mkdirSync(parentCwd, { recursive: true });
	const parent = await api(baseUrl, "/api/sessions", { projectId, cwd: parentCwd, worktree: false });
	assert.equal(parent.status, 201, JSON.stringify(parent.body));

	const outside = tmpDir("bobbit-delegate-outside-");
	const rejected = await api(baseUrl, "/api/sessions", {
		delegateOf: parent.body.id,
		instructions: "outside cwd must be rejected",
		cwd: outside,
	});
	assert.equal(rejected.status, 422);
	assert.equal(rejected.body.code, "CWD_OUTSIDE_PROJECT");

	const inherited = await api(baseUrl, "/api/sessions", {
		delegateOf: parent.body.id,
		instructions: "use parent cwd",
	});
	assert.equal(inherited.status, 201, JSON.stringify(inherited.body));
	assert.ok(samePath(inherited.body.cwd, parentCwd), `expected delegate cwd ${inherited.body.cwd} to match parent cwd ${parentCwd}`);
});

test("server-scope role assistant without cwd defaults to the Headquarters directory", async (t) => {
	const serverRoot = tmpDir("bobbit-role-assistant-default-cwd-");
	const { baseUrl } = await startGateway(t, serverRoot);
	const created = await api(baseUrl, "/api/sessions", { assistantType: "role", worktree: false });
	assert.equal(created.status, 201, JSON.stringify(created.body));
	const hqDir = path.join(serverRoot, ".bobbit", "headquarters");
	assert.ok(samePath(created.body.cwd, hqDir), `expected role assistant cwd ${created.body.cwd} to default to Headquarters dir ${hqDir}`);
});

test("server-scope role assistant coerces an explicit cwd outside the Headquarters directory", async (t) => {
	const serverRoot = tmpDir("bobbit-role-assistant-outside-cwd-");
	const { baseUrl } = await startGateway(t, serverRoot);
	// An existing on-disk dir outside HQ — the escape must be coerced back to
	// the Headquarters directory, never rejected: server-scope assistants must
	// always create successfully regardless of the caller-supplied cwd.
	const outside = tmpDir("bobbit-role-assistant-escape-");
	const created = await api(baseUrl, "/api/sessions", { assistantType: "role", worktree: false, cwd: outside });
	assert.equal(created.status, 201, JSON.stringify(created.body));
	const hqDir = path.join(serverRoot, ".bobbit", "headquarters");
	assert.ok(samePath(created.body.cwd, hqDir), `expected role assistant cwd ${created.body.cwd} to be coerced to Headquarters dir ${hqDir}`);
});

test("server-scope tool assistant coerces an explicit cwd outside the Headquarters directory", async (t) => {
	const serverRoot = tmpDir("bobbit-tool-assistant-outside-cwd-");
	const { baseUrl } = await startGateway(t, serverRoot);
	const outside = tmpDir("bobbit-tool-assistant-escape-");
	const created = await api(baseUrl, "/api/sessions", { assistantType: "tool", worktree: false, cwd: outside });
	assert.equal(created.status, 201, JSON.stringify(created.body));
	const hqDir = path.join(serverRoot, ".bobbit", "headquarters");
	assert.ok(samePath(created.body.cwd, hqDir), `expected tool assistant cwd ${created.body.cwd} to be coerced to Headquarters dir ${hqDir}`);
});

test("server-scope assistant accepts an explicit cwd inside the Headquarters directory", async (t) => {
	const serverRoot = tmpDir("bobbit-role-assistant-inside-cwd-");
	const { baseUrl } = await startGateway(t, serverRoot);
	const hqSubdir = path.join(serverRoot, ".bobbit", "headquarters", "workspace");
	fs.mkdirSync(hqSubdir, { recursive: true });
	const accepted = await api(baseUrl, "/api/sessions", { assistantType: "role", worktree: false, cwd: hqSubdir });
	assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
	assert.ok(samePath(accepted.body.cwd, hqSubdir), `expected role assistant cwd ${accepted.body.cwd} to be preserved inside Headquarters dir`);
});

test("config discovery APIs require explicit projectId", async (t) => {
	const serverRoot = tmpDir("bobbit-config-api-project-required-");
	const { baseUrl } = await startGateway(t, serverRoot);

	// Project-runtime routes require an explicit projectId (400 on missing).
	for (const pathname of ["/api/mcp-servers", "/api/sandbox-status", "/api/sandbox-image/build"]) {
		const missing = await api(baseUrl, pathname, undefined, pathname.endsWith("/build") ? "POST" : "GET");
		assert.equal(missing.status, 400, `${pathname} should require projectId`);
		assert.equal(missing.body.code, "PROJECT_ID_REQUIRED");
	}

	// Tool/role discovery/detail/config mutations require an explicit projectId.
	// First-party UI passes `headquarters` for server scope; missing scope must fail closed.
	for (const pathname of [
		"/api/tools",
		"/api/tools/read",
		"/api/roles",
		"/api/roles/team-lead",
		"/api/tool-group-policies",
	]) {
		const missing = await api(baseUrl, pathname);
		assert.equal(missing.status, 400, `${pathname} should require projectId`);
		assert.equal(missing.body.code, "PROJECT_ID_REQUIRED");
	}
	for (const { pathname, method, body } of [
		{ pathname: "/api/tools/read", method: "PUT", body: { description: "x" } },
		{ pathname: "/api/tools/read/customize?scope=project", method: "POST", body: undefined },
		{ pathname: "/api/tools/read/override?scope=project", method: "DELETE", body: undefined },
		{ pathname: "/api/roles", method: "POST", body: { name: "missing-project-role", label: "Missing Project" } },
		{ pathname: "/api/roles/team-lead", method: "PUT", body: { label: "Team Lead" } },
		{ pathname: "/api/roles/team-lead", method: "DELETE", body: undefined },
		{ pathname: "/api/roles/coder/customize?scope=project", method: "POST", body: undefined },
		{ pathname: "/api/roles/coder/override?scope=project", method: "DELETE", body: undefined },
		{ pathname: "/api/tool-group-policies/bash", method: "PUT", body: { policy: "ask" } },
	]) {
		const missing = await api(baseUrl, pathname, body, method);
		assert.equal(missing.status, 400, `${method} ${pathname} should require projectId`);
		assert.equal(missing.body.code, "PROJECT_ID_REQUIRED");
	}

	// /api/workflows keeps its softer contract: a missing projectId returns an
	// empty list (there is no server-scope workflow set), not a 400.
	const workflowsMissing = await api(baseUrl, "/api/workflows");
	assert.equal(workflowsMissing.status, 200, JSON.stringify(workflowsMissing.body));
	assert.deepEqual(workflowsMissing.body.workflows, []);

	const mcp = await api(baseUrl, "/api/mcp-servers?projectId=headquarters");
	assert.equal(mcp.status, 200, JSON.stringify(mcp.body));
	assert.deepEqual(mcp.body, []);

	const tools = await api(baseUrl, "/api/tools?projectId=headquarters");
	assert.equal(tools.status, 200, JSON.stringify(tools.body));
	assert.ok(Array.isArray(tools.body.tools));

	const toolDetail = await api(baseUrl, "/api/tools/read?projectId=headquarters");
	assert.equal(toolDetail.status, 200, JSON.stringify(toolDetail.body));
	assert.equal(toolDetail.body.name, "read");

	const toolUpdate = await api(baseUrl, "/api/tools/read?projectId=headquarters", { description: "Read files" }, "PUT");
	assert.equal(toolUpdate.status, 200, JSON.stringify(toolUpdate.body));
	const toolCustomize = await api(baseUrl, "/api/tools/read/customize?scope=project&projectId=headquarters", undefined, "POST");
	assert.equal(toolCustomize.status, 201, JSON.stringify(toolCustomize.body));
	const toolOverride = await api(baseUrl, "/api/tools/read/override?scope=project&projectId=headquarters", undefined, "DELETE");
	assert.equal(toolOverride.status, 200, JSON.stringify(toolOverride.body));

	const groupPolicies = await api(baseUrl, "/api/tool-group-policies?projectId=headquarters");
	assert.equal(groupPolicies.status, 200, JSON.stringify(groupPolicies.body));

	const groupPolicyUpdate = await api(baseUrl, "/api/tool-group-policies/bash?projectId=headquarters", { policy: "ask" }, "PUT");
	assert.equal(groupPolicyUpdate.status, 200, JSON.stringify(groupPolicyUpdate.body));

	const roles = await api(baseUrl, "/api/roles?projectId=headquarters");
	assert.equal(roles.status, 200, JSON.stringify(roles.body));
	assert.ok(Array.isArray(roles.body.roles));

	const roleName = "hq-scope-guard-role";
	const createRole = await api(baseUrl, "/api/roles", { projectId: "headquarters", name: roleName, label: "HQ Guard" });
	assert.equal(createRole.status, 201, JSON.stringify(createRole.body));
	const roleDetail = await api(baseUrl, `/api/roles/${roleName}?projectId=headquarters`);
	assert.equal(roleDetail.status, 200, JSON.stringify(roleDetail.body));
	assert.equal(roleDetail.body.name, roleName);
	const updateRole = await api(baseUrl, `/api/roles/${roleName}?projectId=headquarters`, { label: "HQ Guard Updated" }, "PUT");
	assert.equal(updateRole.status, 200, JSON.stringify(updateRole.body));
	const deleteRole = await api(baseUrl, `/api/roles/${roleName}?projectId=headquarters`, undefined, "DELETE");
	assert.equal(deleteRole.status, 200, JSON.stringify(deleteRole.body));

	const customRoleName = "hq-scope-customize-role";
	const createCustomRole = await api(baseUrl, "/api/roles", { projectId: "headquarters", name: customRoleName, label: "HQ Customize" });
	assert.equal(createCustomRole.status, 201, JSON.stringify(createCustomRole.body));
	const roleCustomize = await api(baseUrl, `/api/roles/${customRoleName}/customize?scope=project&projectId=headquarters`, undefined, "POST");
	assert.equal(roleCustomize.status, 201, JSON.stringify(roleCustomize.body));
	const roleOverride = await api(baseUrl, `/api/roles/${customRoleName}/override?scope=project&projectId=headquarters`, undefined, "DELETE");
	assert.equal(roleOverride.status, 200, JSON.stringify(roleOverride.body));

	const workflows = await api(baseUrl, "/api/workflows?projectId=headquarters");
	assert.equal(workflows.status, 200, JSON.stringify(workflows.body));
	assert.ok(Array.isArray(workflows.body.workflows));
});

test("session MCP manager resolution fails closed for projectless sessions", async () => {
	const bobbitDir = tmpDir("bobbit-mcp-cwd-scope-");
	const env = snapshotEnv(["BOBBIT_DIR", "BOBBIT_PI_DIR"]);
	process.env.BOBBIT_DIR = bobbitDir;
	delete process.env.BOBBIT_PI_DIR;
	const { SessionManager } = await import("../src/server/agent/session-manager.ts");
	const manager = new SessionManager();
	try {
		const cwd = tmpDir("bobbit-mcp-session-cwd-");
		(manager as any).sessions.set("legacy-session", { id: "legacy-session", cwd });
		const defaultManager = { kind: "default-mcp-manager" };
		(manager as any).mcpManager = defaultManager;
		const calls: unknown[] = [];
		(manager as any).ensureMcpManager = async (scope: unknown) => {
			calls.push(scope);
			return null;
		};

		assert.equal(manager.getMcpManagerForSession("legacy-session"), null);
		assert.equal(await manager.ensureMcpManagerForSession("legacy-session"), null);
		assert.equal(await manager.resolveMcpManagerForSession("legacy-session"), null);
		assert.deepEqual(calls, [], "projectless session should not use default or cwd-scoped MCP manager");

		assert.equal(await manager.resolveMcpManagerForSession("legacy-session", `cwd:${path.resolve(cwd)}`), null);
		assert.deepEqual(calls, [], "caller-supplied cwd scopeKey must not create a scoped MCP manager");
	} finally {
		(manager as any).sessions.clear();
		await manager.shutdown();
		restoreEnv(env);
	}
});

test("Headquarters session skill catalog uses Headquarters market packs only", async () => {
	const serverRoot = tmpDir("bobbit-hq-skill-catalog-");
	const env = snapshotEnv(["BOBBIT_DIR", "BOBBIT_PI_DIR"]);
	const { setProjectRoot, getProjectRoot } = await import("../src/server/bobbit-dir.ts");
	const previousProjectRoot = getProjectRoot();
	try {
		delete process.env.BOBBIT_DIR;
		delete process.env.BOBBIT_PI_DIR;
		setProjectRoot(serverRoot);
		const headquartersRoot = path.join(serverRoot, ".bobbit", "headquarters");
		writeInstalledPack(path.join(serverRoot, ".bobbit", "config", "market-packs"), "normal-skill-pack", "normal-skill");
		writeInstalledPack(path.join(headquartersRoot, "config", "market-packs"), "hq-skill-pack", "hq-skill");

		const { SessionManager } = await import("../src/server/agent/session-manager.ts");
		const { ProjectConfigStore } = await import("../src/server/agent/project-config-store.ts");
		const serverStore = new ProjectConfigStore(path.join(headquartersRoot, "config"));
		const manager = new SessionManager({ projectConfigStore: serverStore }) as any;
		const catalog = manager.computeSkillsCatalog(undefined, headquartersRoot, serverStore, "headquarters") as Array<{ name: string }> | undefined;
		const names = new Set((catalog ?? []).map((skill) => skill.name));
		assert.equal(names.has("hq-skill"), true, "Headquarters skill catalog should include HQ server packs");
		assert.equal(names.has("normal-skill"), false, "Headquarters skill catalog must not include same-root normal project packs");
		await manager.shutdown();
	} finally {
		setProjectRoot(previousProjectRoot);
		restoreEnv(env);
	}
});

test("archive-bobbit through a symlink to the server root preserves Headquarters", async (t) => {
	const serverRoot = tmpDir("bobbit-archive-real-root-");
	const { baseUrl } = await startGateway(t, serverRoot);
	const linkRoot = path.join(os.tmpdir(), `bobbit-archive-root-link-${process.pid}-${Date.now()}`);
	try {
		fs.symlinkSync(serverRoot, linkRoot, process.platform === "win32" ? "junction" : "dir");
	} catch (err) {
		t.skip(`symlink/junction creation unavailable: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
	t.after(() => { try { fs.rmSync(linkRoot, { recursive: true, force: true }); } catch { /* best-effort */ } });

	const hqSentinel = path.join(serverRoot, ".bobbit", "headquarters", "state", "sentinel.txt");
	fs.mkdirSync(path.dirname(hqSentinel), { recursive: true });
	fs.writeFileSync(hqSentinel, "keep headquarters\n", "utf-8");
	const normalConfig = path.join(serverRoot, ".bobbit", "config", "project.yaml");
	fs.mkdirSync(path.dirname(normalConfig), { recursive: true });
	fs.writeFileSync(normalConfig, "name: normal config\n", "utf-8");

	const archived = await api(baseUrl, "/api/projects/archive-bobbit", { rootPath: linkRoot });
	assert.equal(archived.status, 200, JSON.stringify(archived.body));
	assert.equal(fs.existsSync(hqSentinel), true, "Headquarters state must survive archive via a symlinked server root");
	assert.ok(archived.body.preservedPaths.includes("headquarters"), "archive manifest should record Headquarters as preserved");
});
