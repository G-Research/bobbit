/**
 * E2E tests for the search admin + maintenance REST endpoints.
 */
import { rmSync } from "node:fs";
import { test, expect } from "./_helpers/e2e/in-process-harness.js";
import { readE2EToken, apiFetch } from "./_helpers/e2e/e2e-setup.js";
import { createRunChild } from "../../support/harnesses/run-isolation.js";
import { SearchUnavailableError } from "../../../src/server/search/search-service.js";

let token: string;
let projectId: string;

type MaintenanceRequest = (projectId: string) => { path: string; init?: RequestInit };

async function expectFreshMirrorUnavailableThenReady(
	gateway: any,
	label: string,
	requestFor: MaintenanceRequest,
	expectedReadyBody: unknown,
): Promise<void> {
	const rootPath = createRunChild(`search-admin-${label}`);
	let freshProjectId: string | undefined;
	try {
		const created = await gateway.api("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: `search-admin-${label}`, rootPath, __e2e_seed_skip__: true }),
		});
		expect(created.status).toBe(201);
		freshProjectId = (await created.json()).id;

		const request = requestFor(freshProjectId!);
		const unavailable = await gateway.api(request.path, request.init);
		expect(unavailable.status).toBe(503);
		expect(await unavailable.json()).toEqual({ error: "search-unavailable", reason: "rebuilding", state: "ready" });

		const ctx = gateway.projectContextManager.getOrCreate(freshProjectId!);
		await ctx.searchIndex.rebuildFromStores(ctx.goalStore, ctx.sessionStore, undefined, ctx.staffStore);

		const ready = await gateway.api(request.path, request.init);
		expect(ready.status).toBe(200);
		expect(await ready.json()).toEqual(expectedReadyBody);
	} finally {
		if (freshProjectId) await gateway.api(`/api/projects/${encodeURIComponent(freshProjectId)}`, { method: "DELETE" }).catch(() => undefined);
		rmSync(rootPath, { recursive: true, force: true });
	}
}

test.beforeAll(async () => {
	token = readE2EToken();
	void token;
	const resp = await apiFetch("/api/projects");
	expect(resp.status).toBe(200);
	const body = await resp.json();
	const projects = Array.isArray(body) ? body : body.projects;
	expect(Array.isArray(projects)).toBe(true);
	expect(projects.length).toBeGreaterThan(0);
	projectId = projects[0].id;
});

test("GET /api/search/stats returns expected shape", async () => {
	const resp = await apiFetch(`/api/search/stats?projectId=${encodeURIComponent(projectId)}`);
	expect(resp.status).toBe(200);
	const body = await resp.json();
	expect(body).toHaveProperty("state");
	expect(body).toHaveProperty("engine");
	expect(body).toHaveProperty("engineVersion");
	expect(body.engine).toBe("flexsearch");
	expect(body).toHaveProperty("lastRebuildAt");
	expect(body).toHaveProperty("rowCountsBySource");
	expect(body).toHaveProperty("datasetBytes");
	expect(body.rowCountsBySource).toEqual(
		expect.objectContaining({ goals: expect.any(Number), sessions: expect.any(Number), messages: expect.any(Number), staff: expect.any(Number) }),
	);
	expect(typeof body.datasetBytes).toBe("number");
});

test("GET /api/search/stats with missing projectId returns 400", async () => {
	const resp = await apiFetch(`/api/search/stats`);
	expect(resp.status).toBe(400);
});

test("GET /api/search/stats with unknown projectId returns 404", async () => {
	const resp = await apiFetch(`/api/search/stats?projectId=does-not-exist-xyz`);
	expect(resp.status).toBe(404);
});

test("GET /api/search maps a busy search worker to the explicit unavailable response", async ({ gateway }) => {
	const ctx = gateway.projectContextManager.getOrCreate(projectId);
	const originalSearch = ctx.searchIndex.search;
	ctx.searchIndex.search = () => Promise.reject(new SearchUnavailableError("backpressure"));
	try {
		const resp = await gateway.api(`/api/search?q=${encodeURIComponent("busy worker")}&projectId=${encodeURIComponent(projectId)}`);
		expect(resp.status).toBe(503);
		expect(await resp.json()).toEqual({ error: "search-unavailable", reason: "backpressure", state: "ready" });
	} finally {
		ctx.searchIndex.search = originalSearch;
	}
});

test("GET /api/search exposes rebuilding recovery with the unavailable envelope", async ({ gateway }) => {
	const ctx = gateway.projectContextManager.getOrCreate(projectId);
	const originalSearch = ctx.searchIndex.search;
	ctx.searchIndex.search = () => Promise.reject(new SearchUnavailableError("rebuilding"));
	try {
		const resp = await gateway.api(`/api/search?q=${encodeURIComponent("rebuilding mirror")}&projectId=${encodeURIComponent(projectId)}`);
		expect(resp.status).toBe(503);
		expect(await resp.json()).toEqual({ error: "search-unavailable", reason: "rebuilding", state: "ready" });
	} finally {
		ctx.searchIndex.search = originalSearch;
	}
});

test("GET orphan maintenance reports a fresh lazy rebuild and succeeds when ready", async ({ gateway }) => {
	await expectFreshMirrorUnavailableThenReady(
		gateway,
		"orphan-preview",
		id => ({ path: `/api/maintenance/orphaned-index-rows?projectId=${encodeURIComponent(id)}` }),
		{ count: 0, sample: [] },
	);
});

test("POST orphan cleanup reports a fresh lazy rebuild and succeeds when ready", async ({ gateway }) => {
	await expectFreshMirrorUnavailableThenReady(
		gateway,
		"orphan-cleanup",
		id => ({
			path: "/api/maintenance/cleanup-index-rows",
			init: { method: "POST", body: JSON.stringify({ projectId: id }) },
		}),
		{ deleted: 0 },
	);
});

test("POST /api/search/rebuild returns 202", async () => {
	const resp = await apiFetch("/api/search/rebuild", {
		method: "POST",
		body: JSON.stringify({ projectId }),
	});
	// 202 on success; 503 only if the search stack is unavailable.
	expect([202, 503]).toContain(resp.status);
	if (resp.status === 202) {
		const body = await resp.json();
		expect(body).toEqual({ ok: true });
	}
});

test("POST /api/search/rebuild without projectId returns 400", async () => {
	const resp = await apiFetch("/api/search/rebuild", {
		method: "POST",
		body: JSON.stringify({}),
	});
	expect(resp.status).toBe(400);
});

test("GET /api/maintenance/orphaned-index-rows returns expected shape", async () => {
	const resp = await apiFetch(`/api/maintenance/orphaned-index-rows?projectId=${encodeURIComponent(projectId)}`);
	// 200 on success; 503 only if the search stack is unavailable.
	expect([200, 503]).toContain(resp.status);
	if (resp.status === 200) {
		const body = await resp.json();
		expect(body).toHaveProperty("count");
		expect(body).toHaveProperty("sample");
		expect(typeof body.count).toBe("number");
		expect(Array.isArray(body.sample)).toBe(true);
	}
});
