// Ported from tests/e2e/headquarters-api.spec.ts (straggler-coverage-triage PARTIAL —
// the uncovered parts: same-root Headquarters/normal split API, hide/show HQ
// persistence across restart, and projectId=system role/tool writes → HQ scope).
//
// This suite runs at the route/core boundary over the immutable in-memory
// Headquarters fixture. Migration mechanics remain pinned by
// headquarters-state-migration.test.ts; here we pin the resulting API/storage
// split without booting a listener or rebuilding config packs.
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import path from "node:path";

import { guardProcessEnv } from "../core/helpers/env-guard.js";
guardProcessEnv();

import { startCustomGateway, type CustomGatewayHandle } from "./_e2e/custom-gateway.js";

const HEADQUARTERS_PROJECT_ID = "headquarters";
const HEADQUARTERS_PROJECT_NAME = "Headquarters";
const SYSTEM_PROJECT_ID = "system";
const SAME_ROOT_PROJECT_ID = "same-root-normal-project";
const SAME_ROOT_PROJECT_NAME = "Original Same Root Project";

function samePath(a: string, b: string): boolean {
	const normalize = (value: string) => {
		const resolved = path.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "");
		return process.platform === "win32" ? resolved.toLowerCase() : resolved;
	};
	return normalize(a) === normalize(b);
}

function expectSamePath(actual: string, expected: string, label: string): void {
	assert.ok(samePath(actual, expected), `${label}: expected ${actual} to equal ${expected}`);
}

function readStoreRecords(gw: CustomGatewayHandle, file: string): any[] {
	if (!gw.fs.existsSync(file)) return [];
	const data = gw.readJson(file);
	if (Array.isArray(data)) return data;
	if (Array.isArray(data.sessions)) return data.sessions;
	if (Array.isArray(data.records)) return data.records;
	return [];
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

let gw: CustomGatewayHandle;

beforeAll(() => {
	gw = startCustomGateway();
});

afterAll(async () => {
	await gw.shutdown();
});

describe("Headquarters same-root split API", () => {
	it("startup preserves a same-root normal project instead of promoting it to Headquarters", async () => {
		const list = await gw.json("/api/projects");
		assert.equal(list.status, 200, list.text);
		assert.deepEqual(list.body.map((project: any) => project.id), [SAME_ROOT_PROJECT_ID, HEADQUARTERS_PROJECT_ID]);
		expectSameRootNormalProject(list.body[0], gw.serverRoot);
		expectHeadquartersProject(list.body[1], gw.headquartersDir);

		const hq = await gw.json(`/api/projects/${HEADQUARTERS_PROJECT_ID}`);
		assert.equal(hq.status, 200, hq.text);
		expectHeadquartersProject(hq.body, gw.headquartersDir);

		const normal = await gw.json(`/api/projects/${SAME_ROOT_PROJECT_ID}`);
		assert.equal(normal.status, 200, normal.text);
		expectSameRootNormalProject(normal.body, gw.serverRoot);

		const normalBobbitDir = path.join(gw.serverRoot, ".bobbit");
		assert.equal(gw.fs.existsSync(path.join(gw.headquartersDir, "state")), true);
		assert.equal(gw.fs.existsSync(path.join(gw.headquartersDir, "config")), true);
		assert.equal(gw.fs.existsSync(path.join(normalBobbitDir, "state")), true);
		assert.equal(gw.fs.existsSync(path.join(normalBobbitDir, "config")), true);
		expectSamePath(path.join(gw.serverRoot, ".bobbit", "headquarters"), gw.headquartersDir, "default Headquarters directory");

		const storedProjects = gw.readJson(path.join(gw.headquartersDir, "state", "projects.json"));
		assert.deepEqual(storedProjects.map((project: any) => project.id).sort(), [HEADQUARTERS_PROJECT_ID, SAME_ROOT_PROJECT_ID, SYSTEM_PROJECT_ID].sort());
		const systemStored = storedProjects.find((project: any) => project.id === SYSTEM_PROJECT_ID);
		assert.equal(systemStored.hidden, true);
		assert.equal(systemStored.kind, "system");
		expectSameRootNormalProject(storedProjects.find((project: any) => project.id === SAME_ROOT_PROJECT_ID), gw.serverRoot);

		const normalConfig = await gw.json(`/api/projects/${SAME_ROOT_PROJECT_ID}/config`);
		assert.equal(normalConfig.status, 200, normalConfig.text);
		assert.equal(normalConfig.body.same_root_normal_marker, "normal-project-config");
		const hqConfig = await gw.json(`/api/projects/${HEADQUARTERS_PROJECT_ID}/config`);
		assert.equal(hqConfig.status, 200, hqConfig.text);
		assert.equal(hqConfig.body.same_root_normal_marker, undefined);
	});

	it("Quick Session creation uses projectId as the scope and separates Headquarters from same-root project state", async () => {
		const hqSession = await createSession(gw, HEADQUARTERS_PROJECT_ID);
		assert.equal(hqSession.projectId, HEADQUARTERS_PROJECT_ID);
		expectSamePath(hqSession.cwd, gw.headquartersDir, "Headquarters session cwd");
		assert.equal(hqSession.worktreePath, undefined);

		const normalSession = await createSession(gw, SAME_ROOT_PROJECT_ID);
		assert.equal(normalSession.projectId, SAME_ROOT_PROJECT_ID);
		expectSamePath(normalSession.cwd, gw.serverRoot, "normal same-root session cwd");

		const normalBobbitDir = path.join(gw.serverRoot, ".bobbit");
		const hqSessions = readStoreRecords(gw, path.join(gw.headquartersDir, "state", "sessions.json"));
		const normalSessions = readStoreRecords(gw, path.join(normalBobbitDir, "state", "sessions.json"));
		assert.ok(hqSessions.map((session: any) => session.id).includes(hqSession.id));
		assert.ok(!hqSessions.map((session: any) => session.id).includes(normalSession.id));
		assert.ok(normalSessions.map((session: any) => session.id).includes(normalSession.id));
		assert.ok(!normalSessions.map((session: any) => session.id).includes(hqSession.id));

		const missingProject = await gw.json("/api/sessions", { method: "POST", body: JSON.stringify({ cwd: gw.serverRoot }) });
		assert.equal(missingProject.status, 400, missingProject.text);
		assert.equal(missingProject.body?.code, "PROJECT_ID_REQUIRED");
	});

	it("system project remains hidden and anchored in Headquarters state", async () => {
		const list = await gw.json("/api/projects");
		assert.equal(list.status, 200, list.text);
		assert.ok(!list.body.map((project: any) => project.id).includes(SYSTEM_PROJECT_ID));
		const system = await gw.json(`/api/projects/${SYSTEM_PROJECT_ID}`);
		assert.equal(system.status, 200, system.text);
		assert.equal(system.body.id, SYSTEM_PROJECT_ID);
		assert.equal(system.body.hidden, true);
		assert.equal(system.body.kind, "system");
		expectSamePath(system.body.rootPath, path.join(gw.headquartersDir, "state", "system-project"), "hidden system project rootPath");
	});

	it("hide/show Headquarters is presentation-only and persists across restart with the same-root normal project intact", async () => {
		const hide = await gw.json("/api/preferences", { method: "PUT", body: JSON.stringify({ showHeadquartersInProjectLists: false }) });
		assert.equal(hide.status, 200, hide.text);
		assert.equal(hide.body.showHeadquartersInProjectLists, false);

		let list = await gw.json("/api/projects");
		assert.deepEqual(list.body.map((project: any) => project.id), [SAME_ROOT_PROJECT_ID]);
		expectSameRootNormalProject(list.body[0], gw.serverRoot);
		const explicitHq = await gw.json(`/api/projects/${HEADQUARTERS_PROJECT_ID}`);
		assert.equal(explicitHq.status, 200, explicitHq.text);
		expectHeadquartersProject(explicitHq.body, gw.headquartersDir);

		gw = gw.restart();
		list = await gw.json("/api/projects");
		assert.deepEqual(list.body.map((project: any) => project.id), [SAME_ROOT_PROJECT_ID]);

		const show = await gw.json("/api/preferences", { method: "PUT", body: JSON.stringify({ showHeadquartersInProjectLists: true }) });
		assert.equal(show.status, 200, show.text);
		assert.equal(show.body.showHeadquartersInProjectLists, true);

		gw = gw.restart();
		list = await gw.json("/api/projects");
		assert.deepEqual(list.body.map((project: any) => project.id), [SAME_ROOT_PROJECT_ID, HEADQUARTERS_PROJECT_ID]);
		expectSameRootNormalProject(list.body[0], gw.serverRoot);
		expectHeadquartersProject(list.body[1], gw.headquartersDir);
	});
});

describe("Headquarters server-scope config from hidden `system` proposals", () => {
	it("POST /api/roles with projectId=system writes to Headquarters/server scope, not the hidden system store", async () => {
		const roleName = "sys-scope-role";
		const created = await gw.json("/api/roles", {
			method: "POST",
			body: JSON.stringify({ projectId: SYSTEM_PROJECT_ID, name: roleName, label: "Sys Scope Role", promptTemplate: "created from a server-scope assistant proposal" }),
		});
		assert.equal(created.status, 201, created.text);

		const serverRoleFile = path.join(gw.headquartersDir, "config", "roles", `${roleName}.yaml`);
		assert.equal(gw.fs.existsSync(serverRoleFile), true, `role must be written to Headquarters/server store at ${serverRoleFile}`);
		const system = await gw.json(`/api/projects/${SYSTEM_PROJECT_ID}`);
		const systemRoleFile = path.join(system.body.rootPath, ".bobbit", "config", "roles", `${roleName}.yaml`);
		assert.equal(gw.fs.existsSync(systemRoleFile), false, "role must NOT be written to the hidden system project store");

		const hqRoles = await gw.json(`/api/roles?projectId=${HEADQUARTERS_PROJECT_ID}`);
		assert.equal(hqRoles.status, 200, hqRoles.text);
		const found = (hqRoles.body.roles as any[]).find((role) => role.name === roleName);
		assert.ok(found, "role must be visible in the Headquarters/server roles cascade");
		assert.equal(found.origin, "server");
	});

	it("POST /api/tools/:name/customize with projectId=system writes to Headquarters/server scope, not the hidden system store", async () => {
		const customize = await gw.json(`/api/tools/read/customize?scope=project&projectId=${SYSTEM_PROJECT_ID}`, { method: "POST" });
		assert.equal(customize.status, 201, customize.text);
		const groupDir = customize.body.groupDir as string;
		assert.ok(groupDir, "customize must resolve the builtin tool's group dir");

		const serverToolFile = path.join(gw.headquartersDir, "config", "tools", groupDir, "read.yaml");
		assert.equal(gw.fs.existsSync(serverToolFile), true, `tool must be written to Headquarters/server store at ${serverToolFile}`);
		const system = await gw.json(`/api/projects/${SYSTEM_PROJECT_ID}`);
		const systemToolDir = path.join(system.body.rootPath, ".bobbit", "config", "tools", groupDir);
		assert.equal(gw.fs.existsSync(systemToolDir), false, "tool must NOT be written to the hidden system project store");
	});
});
