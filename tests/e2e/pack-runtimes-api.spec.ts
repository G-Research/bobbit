/**
 * Pack managed-runtime (Docker-backed) REST API E2E tests.
 *
 * Exercises the /api/pack-runtimes/* surface wired in server.ts with the Docker
 * layer FULLY MOCKED: a fake PackRuntimeSupervisor is injected via the
 * registerPackRuntimeSupervisorFactory() seam, so NO Docker daemon is involved.
 *
 * Coverage:
 *   - GET  /api/pack-runtimes                 → { runtimes } with round-trippable ids
 *   - POST /api/pack-runtimes/:id/start       → running status (mode forwarded)
 *   - POST /api/pack-runtimes/:id/stop        → stopped status
 *   - POST /api/pack-runtimes/:id/restart     → running status
 *   - GET  /api/pack-runtimes/:id/logs?tail=  → { logs } (tail clamped/validated)
 *   - malformed id            → 400
 *   - unknown runtime         → 404 (supervisor PACK_RUNTIME_NOT_FOUND)
 *   - malformed mode / tail   → 400
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";

// ---------------------------------------------------------------------------
// Fake supervisor (no Docker). One known runtime: demo-pack:web.
// ---------------------------------------------------------------------------

interface RuntimeStatus {
	id: string;
	packId: string;
	packName?: string;
	runtimeId: string;
	status: string;
	mode?: string;
	composeProject: string;
	message?: string;
}

const KNOWN = { packId: "demo-pack", runtimeId: "web", packName: "Demo Pack" };
const KNOWN_PROJECT = "bobbit-pack-demo-pack-testsuffix";

function notFound(): Error {
	const e = new Error("no such pack runtime") as Error & { code: string };
	e.code = "PACK_RUNTIME_NOT_FOUND";
	return e;
}

function isKnown(packId: string, runtimeId: string): boolean {
	return packId === KNOWN.packId && runtimeId === KNOWN.runtimeId;
}

/** Call log so tests can assert what the routes forwarded to the supervisor. */
const calls: Array<{ op: string; packId: string; runtimeId: string; opts?: unknown }> = [];

function baseStatus(status: string, mode?: string): RuntimeStatus {
	return {
		id: `${KNOWN.packId}:${KNOWN.runtimeId}`,
		packId: KNOWN.packId,
		packName: KNOWN.packName,
		runtimeId: KNOWN.runtimeId,
		status,
		mode,
		composeProject: KNOWN_PROJECT,
	};
}

const fakeSupervisor = {
	async list() {
		return [baseStatus("stopped")];
	},
	async status(packId: string, runtimeId: string) {
		if (!isKnown(packId, runtimeId)) throw notFound();
		return baseStatus("stopped");
	},
	async start(packId: string, runtimeId: string, opts?: { mode?: string }) {
		calls.push({ op: "start", packId, runtimeId, opts });
		if (!isKnown(packId, runtimeId)) throw notFound();
		return baseStatus("running", opts?.mode ?? "default");
	},
	async stop(packId: string, runtimeId: string, opts?: unknown) {
		calls.push({ op: "stop", packId, runtimeId, opts });
		if (!isKnown(packId, runtimeId)) throw notFound();
		return baseStatus("stopped");
	},
	async restart(packId: string, runtimeId: string, opts?: { mode?: string }) {
		calls.push({ op: "restart", packId, runtimeId, opts });
		if (!isKnown(packId, runtimeId)) throw notFound();
		return baseStatus("running", opts?.mode ?? "default");
	},
	async logs(packId: string, runtimeId: string, opts?: { tail?: number }) {
		calls.push({ op: "logs", packId, runtimeId, opts });
		if (!isKnown(packId, runtimeId)) throw notFound();
		return `web | started\nweb | tail=${opts?.tail ?? "none"}`;
	},
};

// Mirror server.ts encodePackRuntimeId so tests construct ids without importing
// from dist (kept in lock-step; the route re-derives ids on every response).
function encodeId(packId: string, runtimeId: string): string {
	return Buffer.from(`${packId}\n${runtimeId}`, "utf8").toString("base64url");
}

test.describe("Pack runtimes REST API", () => {
	test.beforeAll(async () => {
		const mod = await import("../../dist/server/server.js");
		mod.registerPackRuntimeSupervisorFactory(() => fakeSupervisor);
	});

	test.afterAll(async () => {
		const mod = await import("../../dist/server/server.js");
		mod.registerPackRuntimeSupervisorFactory(null);
	});

	test.beforeEach(() => {
		calls.length = 0;
	});

	test("GET /api/pack-runtimes lists runtimes with round-trippable ids @smoke", async () => {
		const res = await apiFetch("/api/pack-runtimes");
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(Array.isArray(data.runtimes)).toBe(true);
		expect(data.runtimes.length).toBe(1);
		const rt = data.runtimes[0];
		expect(rt.packId).toBe(KNOWN.packId);
		expect(rt.runtimeId).toBe(KNOWN.runtimeId);
		expect(rt.status).toBe("stopped");
		// id is re-derived by the route → decodes back to {packId, runtimeId}.
		expect(rt.id).toBe(encodeId(KNOWN.packId, KNOWN.runtimeId));
	});

	test("POST start returns running status and forwards mode", async () => {
		const id = encodeId(KNOWN.packId, KNOWN.runtimeId);
		const res = await apiFetch(`/api/pack-runtimes/${id}/start`, {
			method: "POST",
			body: JSON.stringify({ mode: "external" }),
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.status).toBe("running");
		expect(data.mode).toBe("external");
		expect(data.id).toBe(id);
		const startCall = calls.find((c) => c.op === "start");
		expect((startCall?.opts as { mode?: string })?.mode).toBe("external");
	});

	test("POST stop returns stopped status", async () => {
		const id = encodeId(KNOWN.packId, KNOWN.runtimeId);
		const res = await apiFetch(`/api/pack-runtimes/${id}/stop`, { method: "POST" });
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.status).toBe("stopped");
		expect(calls.some((c) => c.op === "stop")).toBe(true);
	});

	test("POST restart returns running status", async () => {
		const id = encodeId(KNOWN.packId, KNOWN.runtimeId);
		const res = await apiFetch(`/api/pack-runtimes/${id}/restart`, { method: "POST" });
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.status).toBe("running");
		expect(calls.some((c) => c.op === "restart")).toBe(true);
	});

	test("GET logs returns text and forwards tail", async () => {
		const id = encodeId(KNOWN.packId, KNOWN.runtimeId);
		const res = await apiFetch(`/api/pack-runtimes/${id}/logs?tail=50`);
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(typeof data.logs).toBe("string");
		expect(data.logs).toContain("tail=50");
		const logCall = calls.find((c) => c.op === "logs");
		expect((logCall?.opts as { tail?: number })?.tail).toBe(50);
	});

	test("malformed runtime id → 400", async () => {
		// '%21%21' decodes to '!!' which is not valid base64url.
		const res = await apiFetch("/api/pack-runtimes/%21%21/start", { method: "POST" });
		expect(res.status).toBe(400);
	});

	test("unknown runtime → 404", async () => {
		const id = encodeId("ghost-pack", "nope");
		const res = await apiFetch(`/api/pack-runtimes/${id}/start`, { method: "POST" });
		expect(res.status).toBe(404);
	});

	test("malformed mode → 400 (no supervisor call)", async () => {
		const id = encodeId(KNOWN.packId, KNOWN.runtimeId);
		const res = await apiFetch(`/api/pack-runtimes/${id}/start`, {
			method: "POST",
			body: JSON.stringify({ mode: "" }),
		});
		expect(res.status).toBe(400);
		expect(calls.some((c) => c.op === "start")).toBe(false);
	});

	test("malformed tail → 400 (no supervisor call)", async () => {
		const id = encodeId(KNOWN.packId, KNOWN.runtimeId);
		const res = await apiFetch(`/api/pack-runtimes/${id}/logs?tail=-5`);
		expect(res.status).toBe(400);
		expect(calls.some((c) => c.op === "logs")).toBe(false);
	});
});
