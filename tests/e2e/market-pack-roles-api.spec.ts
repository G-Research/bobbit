import { test, expect } from "./in-process-harness.js";
import { apiFetch, defaultProject, nonGitCwd } from "./e2e-setup.js";
import { fileURLToPath } from "node:url";

const SOURCE_DIR = fileURLToPath(new URL("../fixtures/market-sources/market-role-fixture-src", import.meta.url));
const PACK_NAME = "market-role-fixture";
const ROLE_ID = "fixture-pack-nurse";
const UNKNOWN_ROLE_ID = "definitely-not-a-role-market-pack-regression";
const REPRO = "MARKET_PACK_ROLE_REGRESSION";

let sourceId: string | undefined;
const sessions: string[] = [];
const staffIds: string[] = [];

async function readJson(resp: Response): Promise<any> {
	const text = await resp.text();
	try {
		return text ? JSON.parse(text) : {};
	} catch {
		return { raw: text };
	}
}

async function addSource(): Promise<string> {
	const add = await apiFetch("/api/marketplace/sources", {
		method: "POST",
		body: JSON.stringify({ url: SOURCE_DIR }),
	});
	const text = await add.text();
	if (add.status === 409) {
		const list = await apiFetch("/api/marketplace/sources");
		expect(list.status, `${REPRO}: failed to list existing marketplace sources after source conflict`).toBe(200);
		const source = ((await list.json()).sources ?? []).find((item: any) => item.url === SOURCE_DIR);
		expect(source, `${REPRO}: existing marketplace source for fixture pack should be discoverable`).toBeTruthy();
		return source.id;
	}
	expect(add.status, `${REPRO}: failed to register fixture marketplace source; body=${text}`).toBe(201);
	return JSON.parse(text).source.id;
}

async function installPack(): Promise<void> {
	await apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: "server", packName: PACK_NAME }),
	}).catch(() => {});

	sourceId = await addSource();
	const install = await apiFetch("/api/marketplace/install", {
		method: "POST",
		body: JSON.stringify({ sourceId, dirName: PACK_NAME, scope: "server" }),
	});
	const installText = await install.text();
	expect(install.status, `${REPRO}: fixture marketplace pack install failed; body=${installText}`).toBe(201);

	const activation = await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK_NAME, disabled: {} }),
	});
	const activationText = await activation.text();
	expect(activation.status, `${REPRO}: fixture role pack activation refresh failed; body=${activationText}`).toBe(200);
}

async function fixtureRole(projectId?: string): Promise<any> {
	const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
	const res = await apiFetch(`/api/roles${qs}`);
	const body = await readJson(res);
	expect(res.status, `${REPRO}: GET /api/roles failed; body=${JSON.stringify(body)}`).toBe(200);
	const role = (body.roles ?? []).find((item: any) => item.name === ROLE_ID);
	expect(role, `${REPRO}: ${ROLE_ID} must appear in GET /api/roles before it is used by session/staff APIs`).toBeTruthy();
	return role;
}

async function createPlainSession(): Promise<string> {
	const project = await defaultProject();
	const res = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: nonGitCwd(), projectId: project.id }),
	});
	const text = await res.text();
	expect(res.status, `${REPRO}: setup session creation failed; body=${text}`).toBe(201);
	const id = JSON.parse(text).id;
	sessions.push(id);
	return id;
}

async function createPlainStaff(name: string): Promise<any> {
	const project = await defaultProject();
	const res = await apiFetch("/api/staff", {
		method: "POST",
		body: JSON.stringify({
			name,
			systemPrompt: "Staff fixture without a market-pack role yet.",
			cwd: project.rootPath,
			projectId: project.id,
		}),
	});
	const text = await res.text();
	expect(res.status, `${REPRO}: setup staff creation failed; body=${text}`).toBe(201);
	const staff = JSON.parse(text);
	staffIds.push(staff.id);
	if (staff.currentSessionId) sessions.push(staff.currentSessionId);
	return staff;
}

async function expectRole404(resp: Response, label: string): Promise<void> {
	const body = await readJson(resp);
	expect(resp.status, `${REPRO}: ${label} should still fail loudly for truly unknown roles; body=${JSON.stringify(body)}`).toBe(404);
	expect(String(body.error ?? body.message ?? ""), `${REPRO}: ${label} unknown-role response should mention role lookup failure`).toMatch(/role/i);
}

test.describe("market-pack roles API regression", () => {
	test.beforeAll(async () => {
		await installPack();
	});

	test.afterAll(async () => {
		for (const staffId of staffIds.splice(0).reverse()) {
			await apiFetch(`/api/staff/${staffId}`, { method: "DELETE" }).catch(() => {});
		}
		for (const sessionId of sessions.splice(0).reverse()) {
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
		await apiFetch("/api/marketplace/installed", {
			method: "DELETE",
			body: JSON.stringify({ scope: "server", packName: PACK_NAME }),
		}).catch(() => {});
		if (sourceId) {
			await apiFetch(`/api/marketplace/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("GET /api/roles exposes the market-pack role with distinctive fields", async () => {
		const project = await defaultProject();
		const role = await fixtureRole(project.id);
		expect(role.originPackName, `${REPRO}: fixture role should be tagged with its market pack`).toBe(PACK_NAME);
		expect(role.promptTemplate, `${REPRO}: fixture role prompt marker should survive cascade serialization`).toContain("FIXTURE_PACK_ROLE_PROMPT");
		expect(role.accessory).toBe("stethoscope");
		expect(role.model).toBe("openai/gpt-4.1-mini");
		expect(role.thinkingLevel).toBe("low");
		expect(role.toolPolicies).toMatchObject({ Shell: "never", "File System": "ask" });
	});

	test("POST /api/sessions accepts a role that is visible through the market-pack cascade", async () => {
		const project = await defaultProject();
		await fixtureRole(project.id);

		const resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd(), projectId: project.id, roleId: ROLE_ID }),
		});
		const text = await resp.text();
		expect(resp.status, `${REPRO}: POST /api/sessions must accept market-pack role ${ROLE_ID} that appears in GET /api/roles; body=${text}`).toBe(201);
		const created = JSON.parse(text);
		sessions.push(created.id);

		const get = await apiFetch(`/api/sessions/${created.id}`);
		const session = await readJson(get);
		expect(session.role, `${REPRO}: created session should persist the market-pack role name`).toBe(ROLE_ID);
		expect(session.accessory, `${REPRO}: created session should use the market-pack role accessory`).toBe("stethoscope");
	});

	test("PATCH /api/sessions/:id accepts a role that is visible through the market-pack cascade", async () => {
		const project = await defaultProject();
		await fixtureRole(project.id);
		const sessionId = await createPlainSession();

		const resp = await apiFetch(`/api/sessions/${sessionId}`, {
			method: "PATCH",
			body: JSON.stringify({ roleId: ROLE_ID }),
		});
		const body = await readJson(resp);
		expect(resp.status, `${REPRO}: PATCH /api/sessions/:id must assign market-pack role ${ROLE_ID} that appears in GET /api/roles; body=${JSON.stringify(body)}`).toBe(200);

		const get = await apiFetch(`/api/sessions/${sessionId}`);
		const session = await readJson(get);
		expect(session.role, `${REPRO}: patched session should persist the market-pack role name`).toBe(ROLE_ID);
		expect(session.accessory, `${REPRO}: patched session should use the market-pack role accessory`).toBe("stethoscope");
	});

	test("POST /api/staff validates roleId through the market-pack cascade", async () => {
		const project = await defaultProject();
		await fixtureRole(project.id);

		const resp = await apiFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify({
				name: `Market Role Staff ${Date.now()}`,
				systemPrompt: "Staff using the fixture market-pack role.",
				cwd: project.rootPath,
				projectId: project.id,
				roleId: ROLE_ID,
			}),
		});
		const text = await resp.text();
		expect(resp.status, `${REPRO}: POST /api/staff must accept market-pack role ${ROLE_ID} that appears in GET /api/roles; body=${text}`).toBe(201);
		const staff = JSON.parse(text);
		staffIds.push(staff.id);
		if (staff.currentSessionId) sessions.push(staff.currentSessionId);
		expect(staff.roleId, `${REPRO}: created staff should persist market-pack roleId`).toBe(ROLE_ID);
	});

	test("PUT /api/staff/:id validates roleId through the market-pack cascade", async () => {
		const project = await defaultProject();
		await fixtureRole(project.id);
		const staff = await createPlainStaff(`Market Role Update Staff ${Date.now()}`);

		const resp = await apiFetch(`/api/staff/${staff.id}`, {
			method: "PUT",
			body: JSON.stringify({ roleId: ROLE_ID }),
		});
		const body = await readJson(resp);
		expect(resp.status, `${REPRO}: PUT /api/staff/:id must accept market-pack role ${ROLE_ID} that appears in GET /api/roles; body=${JSON.stringify(body)}`).toBe(200);
		expect(body.roleId, `${REPRO}: updated staff should persist market-pack roleId`).toBe(ROLE_ID);
	});

	test("unknown roles still return clear 404s on session and staff validation paths", async () => {
		const project = await defaultProject();
		await fixtureRole(project.id);

		await expectRole404(await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd(), projectId: project.id, roleId: UNKNOWN_ROLE_ID }),
		}), "POST /api/sessions");

		const sessionId = await createPlainSession();
		await expectRole404(await apiFetch(`/api/sessions/${sessionId}`, {
			method: "PATCH",
			body: JSON.stringify({ roleId: UNKNOWN_ROLE_ID }),
		}), "PATCH /api/sessions/:id");

		await expectRole404(await apiFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify({
				name: `Unknown Role Staff ${Date.now()}`,
				systemPrompt: "Staff using an unknown role.",
				cwd: project.rootPath,
				projectId: project.id,
				roleId: UNKNOWN_ROLE_ID,
			}),
		}), "POST /api/staff");

		const staff = await createPlainStaff(`Unknown Role Update Staff ${Date.now()}`);
		await expectRole404(await apiFetch(`/api/staff/${staff.id}`, {
			method: "PUT",
			body: JSON.stringify({ roleId: UNKNOWN_ROLE_ID }),
		}), "PUT /api/staff/:id");
	});
});
