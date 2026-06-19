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
import {
	clampTail,
	encodePackRuntimeId,
	PackRuntimeNotFoundError,
	PackRuntimeDockerUnavailableError,
} from "../../dist/server/runtimes/index.js";

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
	return new PackRuntimeNotFoundError("no such pack runtime");
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
		// Mirror the real supervisor: tail validation/clamping is the supervisor's
		// responsibility (a non-numeric tail throws → REST maps to 400). Validate
		// BEFORE recording the call so the malformed-tail case shows no log read.
		const tail = clampTail(opts?.tail);
		calls.push({ op: "logs", packId, runtimeId, opts });
		if (!isKnown(packId, runtimeId)) throw notFound();
		return `web | started\nweb | tail=${tail}`;
	},
};

// The real, merged URL-safe id encoding (encodeURIComponent(packId):runtimeId).
function encodeId(packId: string, runtimeId: string): string {
	return encodePackRuntimeId(packId, runtimeId);
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

	test("POST start with a malformed JSON body → 400 (no start)", async () => {
		const id = encodeId(KNOWN.packId, KNOWN.runtimeId);
		const res = await apiFetch(`/api/pack-runtimes/${id}/start`, {
			method: "POST",
			body: "{not valid json",
		});
		// A non-empty but unparseable body must NOT be silently coerced to `{}` and
		// mutate the default mode — it is a client error and the supervisor is never
		// invoked.
		expect(res.status).toBe(400);
		expect(calls.some((c) => c.op === "start")).toBe(false);
	});

	test("POST restart with a malformed JSON body → 400 (no restart)", async () => {
		const id = encodeId(KNOWN.packId, KNOWN.runtimeId);
		const res = await apiFetch(`/api/pack-runtimes/${id}/restart`, {
			method: "POST",
			body: "not-json-at-all",
		});
		expect(res.status).toBe(400);
		expect(calls.some((c) => c.op === "restart")).toBe(false);
	});

	test("POST start with an empty body still uses the default mode (200)", async () => {
		// An EMPTY body is valid (no mode override) and must not be rejected.
		const id = encodeId(KNOWN.packId, KNOWN.runtimeId);
		const res = await apiFetch(`/api/pack-runtimes/${id}/start`, { method: "POST" });
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.status).toBe("running");
		expect(data.mode).toBe("default");
	});

	test("clearing the factory (null) drops the cached mock — no stale supervisor", async () => {
		const mod = await import("../../dist/server/server.js");
		const SENTINEL = "sentinel-pack-xyz";
		mod.registerPackRuntimeSupervisorFactory(() => ({
			...fakeSupervisor,
			async list() {
				return [{ ...baseStatus("running"), packId: SENTINEL, runtimeId: "r" }];
			},
		}));
		try {
			const seen = await apiFetch("/api/pack-runtimes");
			expect(seen.status).toBe(200);
			const seenData = await seen.json();
			expect(seenData.runtimes.some((r: { packId: string }) => r.packId === SENTINEL)).toBe(true);

			// Clear the factory — the previously-served mock must NOT linger in the
			// server closure. The route reverts to the production supervisor (or none
			// when unwired). The mock returns 200 + sentinel and never throws, so the
			// sole invariant is that the sentinel is no longer served: a 200 must not
			// contain it, and any non-200 (503 unwired / 500 from the real supervisor)
			// equally proves the stale mock is gone.
			mod.registerPackRuntimeSupervisorFactory(null);
			const after = await apiFetch("/api/pack-runtimes");
			if (after.status === 200) {
				const afterData = await after.json();
				expect(afterData.runtimes.some((r: { packId: string }) => r.packId === SENTINEL)).toBe(false);
			} else {
				expect(after.status).not.toBe(200);
			}
		} finally {
			mod.registerPackRuntimeSupervisorFactory(() => fakeSupervisor);
		}
	});

	test("non-numeric tail → 400 (no log read)", async () => {
		const id = encodeId(KNOWN.packId, KNOWN.runtimeId);
		const res = await apiFetch(`/api/pack-runtimes/${id}/logs?tail=abc`);
		expect(res.status).toBe(400);
		expect(calls.some((c) => c.op === "logs")).toBe(false);
	});

	test("out-of-range tail is clamped, not rejected", async () => {
		const id = encodeId(KNOWN.packId, KNOWN.runtimeId);
		const res = await apiFetch(`/api/pack-runtimes/${id}/logs?tail=-5`);
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.logs).toContain("tail=1"); // clampTail(-5) → 1
	});

	test("logs docker-unavailable → 200 with docker-unavailable status (not hidden)", async () => {
		const mod = await import("../../dist/server/server.js");
		// Swap in a supervisor whose logs() reports Docker missing for this case.
		mod.registerPackRuntimeSupervisorFactory(() => ({
			...fakeSupervisor,
			async logs() {
				throw new PackRuntimeDockerUnavailableError("docker is not available");
			},
		}));
		try {
			const id = encodeId(KNOWN.packId, KNOWN.runtimeId);
			const res = await apiFetch(`/api/pack-runtimes/${id}/logs?tail=50`);
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.status).toBe("docker-unavailable");
			expect(data.logs).toBe("");
		} finally {
			mod.registerPackRuntimeSupervisorFactory(() => fakeSupervisor);
		}
	});
});
