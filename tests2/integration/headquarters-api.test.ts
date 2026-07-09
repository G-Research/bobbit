// Ported from tests/e2e/headquarters-api.spec.ts (straggler-coverage-triage PARTIAL —
// the uncovered parts: same-root Headquarters/normal split API, hide/show HQ
// persistence across restart, and projectId=system role/tool writes → HQ scope).
// The resolver-level coverage is already in tests2/core/headquarters-config-alias +
// headquarters-state-migration; this file ports the runtime API/persistence/
// system-write behaviours against a dedicated src-booted gateway (DI deps).
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { guardProcessEnv } from "../core/helpers/env-guard.js";
guardProcessEnv();

import { startCustomGateway, type CustomGatewayHandle } from "./_e2e/custom-gateway.js";

const HEADQUARTERS_PROJECT_ID = "headquarters";
const HEADQUARTERS_PROJECT_NAME = "Headquarters";
const SYSTEM_PROJECT_ID = "system";
const SAME_ROOT_PROJECT_ID = "same-root-normal-project";
const SAME_ROOT_PROJECT_NAME = "Original Same Root Project";
const SAME_ROOT_WORKFLOW_ID = "same-root-normal-workflow";

function tmpDir(prefix: string): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// Windows can briefly hold handles under a just-shutdown gateway's dir (agent
// session files, gateway-url). Temp-dir removal is best-effort; the OS temp
// sweeper reclaims any straggler. Never fail a passing test on cleanup EPERM.
function rmBestEffort(dir: string): void {
	try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function samePath(a: string, b: string): boolean {
	const norm = (v: string) => {
		let r = path.resolve(v);
		try { r = fs.realpathSync(r); } catch { /* textual fallback */ }
		const n = r.replace(/\\/g, "/").replace(/\/+$/, "");
		return process.platform === "win32" ? n.toLowerCase() : n;
	};
	return norm(a) === norm(b);
}

function expectSamePath(actual: string, expected: string, label: string): void {
	assert.ok(samePath(actual, expected), `${label}: expected ${actual} to equal ${expected}`);
}

function writeJson(file: string, data: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function readJsonFile(file: string): any {
	return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function readStoreRecords(file: string): any[] {
	if (!fs.existsSync(file)) return [];
	const data = readJsonFile(file);
	if (Array.isArray(data)) return data;
	if (Array.isArray(data.sessions)) return data.sessions;
	if (Array.isArray(data.goals)) return data.goals;
	if (Array.isArray(data.staff)) return data.staff;
	if (Array.isArray(data.records)) return data.records;
	return [];
}

function sameRootProjectRecord(serverRoot: string): Record<string, unknown> {
	return {
		id: SAME_ROOT_PROJECT_ID,
		name: SAME_ROOT_PROJECT_NAME,
		rootPath: serverRoot,
		createdAt: Date.now(),
		position: 0,
		colorLight: "#0ea5e9",
		colorDark: "#38bdf8",
	};
}

function seedNormalSameRootLayout(serverRoot: string): void {
	const normalStateDir = path.join(serverRoot, ".bobbit", "state");
	const normalConfigDir = path.join(serverRoot, ".bobbit", "config");
	fs.mkdirSync(normalStateDir, { recursive: true });
	fs.mkdirSync(normalConfigDir, { recursive: true });
	fs.writeFileSync(path.join(normalConfigDir, "project.yaml"), [
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
	writeJson(path.join(normalStateDir, "sessions.json"), []);
	writeJson(path.join(normalStateDir, "goals.json"), []);
	writeJson(path.join(normalStateDir, "staff.json"), []);
}

/** preBoot that seeds the same-root normal layout + HQ registry/preferences. */
function seedSameRoot(showHeadquarters = true) {
	return ({ serverRoot, headquartersDir }: { serverRoot: string; headquartersDir: string }) => {
		fs.mkdirSync(path.join(headquartersDir, "state", "session-prompts"), { recursive: true });
		fs.mkdirSync(path.join(headquartersDir, "config"), { recursive: true });
		seedNormalSameRootLayout(serverRoot);
		writeJson(path.join(headquartersDir, "state", "projects.json"), [sameRootProjectRecord(serverRoot)]);
		const setupPath = path.join(headquartersDir, "state", "setup-complete");
		if (!fs.existsSync(setupPath)) fs.writeFileSync(setupPath, "v2\n");
		writeJson(path.join(headquartersDir, "state", "preferences.json"), { subgoalsEnabled: true, showHeadquartersInProjectLists: showHeadquarters });
	};
}

function expectHeadquartersProject(project: any, headquartersDir: string): void {
	assert.equal(project.id, HEADQUARTERS_PROJECT_ID);
	assert.equal(project.name, HEADQUARTERS_PROJECT_NAME);
	assert.equal(project.kind, "headquarters");
	assert.notEqual(project.hidden, true);
	assert.notEqual(project.provisional, true);
	expectSamePath(project.rootPath, headquartersDir, "Headquarters rootPath");
}

function expectSameRootNormalProject(project: any, serverRoot: string): void {
	assert.equal(project.id, SAME_ROOT_PROJECT_ID);
	assert.equal(project.name, SAME_ROOT_PROJECT_NAME);
	assert.notEqual(project.kind, "headquarters");
	assert.notEqual(project.hidden, true);
	expectSamePath(project.rootPath, serverRoot, "normal same-root rootPath");
}

async function createSession(gw: CustomGatewayHandle, projectId: string): Promise<any> {
	const created = await gw.json("/api/sessions", { method: "POST", body: JSON.stringify({ projectId }) });
	assert.equal(created.status, 201, `POST /api/sessions projectId=${projectId}: ${created.text}`);
	return created.body;
}

async function withSameRoot(fn: (gw: CustomGatewayHandle) => Promise<void>, prefix: string, showHeadquarters = true): Promise<void> {
	const serverRoot = tmpDir(prefix);
	const gw = await startCustomGateway({ serverRoot, preBoot: seedSameRoot(showHeadquarters) });
	try {
		await fn(gw);
	} finally {
		try { await gw.shutdown(); } finally { rmBestEffort(serverRoot); }
	}
}

describe("Headquarters same-root split API", () => {
	it("startup preserves a same-root normal project instead of promoting it to Headquarters", async () => {
		await withSameRoot(async (gw) => {
			const list = await gw.json("/api/projects");
			assert.equal(list.status, 200, list.text);
			assert.deepEqual(list.body.map((p: any) => p.id), [SAME_ROOT_PROJECT_ID, HEADQUARTERS_PROJECT_ID]);
			expectSameRootNormalProject(list.body[0], gw.serverRoot);
			expectHeadquartersProject(list.body[1], gw.headquartersDir);

			const hq = await gw.json(`/api/projects/${HEADQUARTERS_PROJECT_ID}`);
			assert.equal(hq.status, 200, hq.text);
			expectHeadquartersProject(hq.body, gw.headquartersDir);

			const normal = await gw.json(`/api/projects/${SAME_ROOT_PROJECT_ID}`);
			assert.equal(normal.status, 200, normal.text);
			expectSameRootNormalProject(normal.body, gw.serverRoot);

			const normalBobbitDir = path.join(gw.serverRoot, ".bobbit");
			assert.equal(fs.existsSync(path.join(gw.headquartersDir, "state")), true);
			assert.equal(fs.existsSync(path.join(gw.headquartersDir, "config")), true);
			assert.equal(fs.existsSync(path.join(normalBobbitDir, "state")), true);
			assert.equal(fs.existsSync(path.join(normalBobbitDir, "config")), true);
			expectSamePath(path.join(gw.serverRoot, ".bobbit", "headquarters"), gw.headquartersDir, "default Headquarters directory");

			const storedProjects = readJsonFile(path.join(gw.headquartersDir, "state", "projects.json"));
			assert.deepEqual(storedProjects.map((p: any) => p.id).sort(), [HEADQUARTERS_PROJECT_ID, SAME_ROOT_PROJECT_ID, SYSTEM_PROJECT_ID].sort());
			const systemStored = storedProjects.find((p: any) => p.id === SYSTEM_PROJECT_ID);
			assert.equal(systemStored.hidden, true);
			assert.equal(systemStored.kind, "system");
			expectSameRootNormalProject(storedProjects.find((p: any) => p.id === SAME_ROOT_PROJECT_ID), gw.serverRoot);

			const normalConfig = await gw.json(`/api/projects/${SAME_ROOT_PROJECT_ID}/config`);
			assert.equal(normalConfig.status, 200, normalConfig.text);
			assert.equal(normalConfig.body.same_root_normal_marker, "normal-project-config");
			const hqConfig = await gw.json(`/api/projects/${HEADQUARTERS_PROJECT_ID}/config`);
			assert.equal(hqConfig.status, 200, hqConfig.text);
			assert.equal(hqConfig.body.same_root_normal_marker, undefined);
		}, "v2-hq-split-startup-");
	});

	it("Quick Session creation uses projectId as the scope and separates Headquarters from same-root project state", async () => {
		await withSameRoot(async (gw) => {
			const hqSession = await createSession(gw, HEADQUARTERS_PROJECT_ID);
			assert.equal(hqSession.projectId, HEADQUARTERS_PROJECT_ID);
			expectSamePath(hqSession.cwd, gw.headquartersDir, "Headquarters session cwd");
			assert.equal(hqSession.worktreePath, undefined);

			const normalSession = await createSession(gw, SAME_ROOT_PROJECT_ID);
			assert.equal(normalSession.projectId, SAME_ROOT_PROJECT_ID);
			expectSamePath(normalSession.cwd, gw.serverRoot, "normal same-root session cwd");

			const normalBobbitDir = path.join(gw.serverRoot, ".bobbit");
			const hqSessions = readStoreRecords(path.join(gw.headquartersDir, "state", "sessions.json"));
			const normalSessions = readStoreRecords(path.join(normalBobbitDir, "state", "sessions.json"));
			assert.ok(hqSessions.map((s: any) => s.id).includes(hqSession.id));
			assert.ok(!hqSessions.map((s: any) => s.id).includes(normalSession.id));
			assert.ok(normalSessions.map((s: any) => s.id).includes(normalSession.id));
			assert.ok(!normalSessions.map((s: any) => s.id).includes(hqSession.id));

			const missingProject = await gw.json("/api/sessions", { method: "POST", body: JSON.stringify({ cwd: gw.serverRoot }) });
			assert.equal(missingProject.status, 400, missingProject.text);
			assert.equal(missingProject.body?.code, "PROJECT_ID_REQUIRED");
		}, "v2-hq-split-quick-session-");
	});

	it("system project remains hidden and anchored in Headquarters state", async () => {
		await withSameRoot(async (gw) => {
			const list = await gw.json("/api/projects");
			assert.equal(list.status, 200, list.text);
			assert.ok(!list.body.map((p: any) => p.id).includes(SYSTEM_PROJECT_ID));
			const system = await gw.json(`/api/projects/${SYSTEM_PROJECT_ID}`);
			assert.equal(system.status, 200, system.text);
			assert.equal(system.body.id, SYSTEM_PROJECT_ID);
			assert.equal(system.body.hidden, true);
			assert.equal(system.body.kind, "system");
			expectSamePath(system.body.rootPath, path.join(gw.headquartersDir, "state", "system-project"), "hidden system project rootPath");
		}, "v2-hq-split-system-hidden-");
	});

	it("hide/show Headquarters is presentation-only and persists across restart with the same-root normal project intact", async () => {
		const serverRoot = tmpDir("v2-hq-split-hide-show-");
		let gw = await startCustomGateway({ serverRoot, preBoot: seedSameRoot(true) });
		const { headquartersDir, agentDir } = gw;
		try {
			const hide = await gw.json("/api/preferences", { method: "PUT", body: JSON.stringify({ showHeadquartersInProjectLists: false }) });
			assert.equal(hide.status, 200, hide.text);
			assert.equal(hide.body.showHeadquartersInProjectLists, false);

			let list = await gw.json("/api/projects");
			assert.equal(list.status, 200, list.text);
			assert.deepEqual(list.body.map((p: any) => p.id), [SAME_ROOT_PROJECT_ID]);
			expectSameRootNormalProject(list.body[0], serverRoot);
			const explicitHq = await gw.json(`/api/projects/${HEADQUARTERS_PROJECT_ID}`);
			assert.equal(explicitHq.status, 200, explicitHq.text);
			expectHeadquartersProject(explicitHq.body, headquartersDir);

			// Restart (no preBoot → preserve all state): hidden preference persists.
			await gw.shutdown();
			gw = await startCustomGateway({ serverRoot, headquartersDir, agentDir });
			list = await gw.json("/api/projects");
			assert.equal(list.status, 200, list.text);
			assert.deepEqual(list.body.map((p: any) => p.id), [SAME_ROOT_PROJECT_ID]);

			const show = await gw.json("/api/preferences", { method: "PUT", body: JSON.stringify({ showHeadquartersInProjectLists: true }) });
			assert.equal(show.status, 200, show.text);
			assert.equal(show.body.showHeadquartersInProjectLists, true);

			await gw.shutdown();
			gw = await startCustomGateway({ serverRoot, headquartersDir, agentDir });
			list = await gw.json("/api/projects");
			assert.equal(list.status, 200, list.text);
			assert.deepEqual(list.body.map((p: any) => p.id), [SAME_ROOT_PROJECT_ID, HEADQUARTERS_PROJECT_ID]);
			expectSameRootNormalProject(list.body[0], serverRoot);
			expectHeadquartersProject(list.body[1], headquartersDir);
		} finally {
			try { await gw.shutdown(); } finally { rmBestEffort(serverRoot); }
		}
	});
});

describe("Headquarters server-scope config from hidden `system` proposals", () => {
	// Code-quality finding: server-scope role/tool assistant sessions resolve to
	// the hidden internal `system` project. Their proposal drafts carry
	// projectId="system", so on acceptance the config must NOT land in the hidden
	// system store — it must resolve to the user-facing Headquarters/server scope.
	it("POST /api/roles with projectId=system writes to Headquarters/server scope, not the hidden system store", async () => {
		const serverRoot = tmpDir("v2-hq-system-role-write-");
		const gw = await startCustomGateway({ serverRoot });
		try {
			const roleName = "sys-scope-role";
			const created = await gw.json("/api/roles", {
				method: "POST",
				body: JSON.stringify({ projectId: SYSTEM_PROJECT_ID, name: roleName, label: "Sys Scope Role", promptTemplate: "created from a server-scope assistant proposal" }),
			});
			assert.equal(created.status, 201, created.text);

			const serverRoleFile = path.join(gw.headquartersDir, "config", "roles", `${roleName}.yaml`);
			assert.equal(fs.existsSync(serverRoleFile), true, `role must be written to Headquarters/server store at ${serverRoleFile}`);

			const system = await gw.json(`/api/projects/${SYSTEM_PROJECT_ID}`);
			assert.equal(system.status, 200, system.text);
			const systemRoleFile = path.join(system.body.rootPath, ".bobbit", "config", "roles", `${roleName}.yaml`);
			assert.equal(fs.existsSync(systemRoleFile), false, "role must NOT be written to the hidden system project store");

			const hqRoles = await gw.json(`/api/roles?projectId=${HEADQUARTERS_PROJECT_ID}`);
			assert.equal(hqRoles.status, 200, hqRoles.text);
			const found = (hqRoles.body.roles as any[]).find((r) => r.name === roleName);
			assert.ok(found, "role must be visible in the Headquarters/server roles cascade");
			assert.equal(found.origin, "server");
		} finally {
			try { await gw.shutdown(); } finally { rmBestEffort(serverRoot); }
		}
	});

	it("POST /api/tools/:name/customize with projectId=system writes to Headquarters/server scope, not the hidden system store", async () => {
		const serverRoot = tmpDir("v2-hq-system-tool-write-");
		const gw = await startCustomGateway({ serverRoot });
		try {
			// `read` is a builtin File System tool (defaults/tools/filesystem/read.yaml).
			const customize = await gw.json(`/api/tools/read/customize?scope=project&projectId=${SYSTEM_PROJECT_ID}`, { method: "POST" });
			assert.equal(customize.status, 201, customize.text);
			const groupDir = customize.body.groupDir as string;
			assert.ok(groupDir, "customize must resolve the builtin tool's group dir");

			const serverToolFile = path.join(gw.headquartersDir, "config", "tools", groupDir, "read.yaml");
			assert.equal(fs.existsSync(serverToolFile), true, `tool must be written to Headquarters/server store at ${serverToolFile}`);

			const system = await gw.json(`/api/projects/${SYSTEM_PROJECT_ID}`);
			assert.equal(system.status, 200, system.text);
			const systemToolDir = path.join(system.body.rootPath, ".bobbit", "config", "tools", groupDir);
			assert.equal(fs.existsSync(systemToolDir), false, "tool must NOT be written to the hidden system project store");
		} finally {
			try { await gw.shutdown(); } finally { rmBestEffort(serverRoot); }
		}
	});
});
