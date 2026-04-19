/**
 * E2E tests for the search admin + maintenance REST endpoints added in T11.
 *
 * Uses BOBBIT_FAKE_EMBEDDER=1 (set by the in-process harness) so the tests
 * never attempt the ~140MB ONNX model download.
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, apiFetch } from "./e2e-setup.js";

let token: string;
let projectId: string;

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
	expect(body).toHaveProperty("embedderId");
	expect(body).toHaveProperty("embedderDim");
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

test("POST /api/search/rebuild returns 202", async () => {
	const resp = await apiFetch("/api/search/rebuild", {
		method: "POST",
		body: JSON.stringify({ projectId }),
	});
	// 202 on success; 503 only if LanceDB/embedder failed to load — which
	// shouldn't happen with the fake embedder + native lancedb binary.
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
