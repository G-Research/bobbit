/**
 * Unit tests for `resolveManagedRuntimeContext` (src/server/server.ts) — the
 * SINGLE source of truth the LifecycleHub provider-hook path AND the pack-ROUTE
 * dispatch path both use to build `ctx.runtime` for a managed-mode pack.
 *
 * It must:
 *   - resolve a runtime ONLY for a managed deployment mode (external ⇒ undefined,
 *     so the route/provider stay dormant and never dial an empty base URL);
 *   - READ status + the already-persisted API host port from the supervisor and
 *     build `{ baseUrl, headers, status }` WITHOUT starting Docker;
 *   - prefer the `*_API_PORT` port spec (by key OR env), else the first port;
 *   - attach an `Authorization: Bearer <apiKey>` header only when an apiKey is set;
 *   - degrade to undefined when the supervisor is absent, status throws, the
 *     capability summary throws, or no host port is known yet.
 *
 * This pins the server-side half of the managed-route fix that the direct route
 * unit tests (which receive ctx.runtime pre-built) cannot exercise.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveManagedRuntimeContext, type PackRuntimeSupervisorLike } from "../src/server/server.ts";

type Cap = Awaited<ReturnType<PackRuntimeSupervisorLike["capabilitySummary"]>>;
type Status = Awaited<ReturnType<PackRuntimeSupervisorLike["status"]>>;

/** A minimal supervisor stub: only `status` + `capabilitySummary` are consulted
 *  by the resolver; every other verb throws so a regression that starts Docker
 *  (calls start/restart/etc.) is caught loudly. */
function stubSupervisor(opts: {
	status?: Partial<Status> | (() => never);
	cap?: Partial<Cap> | (() => never);
}): PackRuntimeSupervisorLike {
	const notUsed = (name: string) => () => { throw new Error(`supervisor.${name} must not be called by resolveManagedRuntimeContext`); };
	return {
		list: notUsed("list") as never,
		status: (typeof opts.status === "function"
			? opts.status
			: async () => ({ status: "running", ...(opts.status ?? {}) } as Status)) as never,
		start: notUsed("start") as never,
		stop: notUsed("stop") as never,
		restart: notUsed("restart") as never,
		down: notUsed("down") as never,
		capabilitySummary: (typeof opts.cap === "function"
			? opts.cap
			: async () => ({ ports: [], ...(opts.cap ?? {}) } as Cap)) as never,
		logs: notUsed("logs") as never,
	};
}

const MANAGED = { mode: "managed" } as Record<string, unknown>;

test("external mode ⇒ undefined (no runtime; never consults the supervisor)", async () => {
	const sup = stubSupervisor({ status: () => { throw new Error("status must not be called for external mode"); } });
	assert.equal(
		await resolveManagedRuntimeContext(sup, { packId: "hindsight", runtimeId: "hindsight", config: { mode: "external" } }),
		undefined,
	);
	// Absent mode defaults to external.
	assert.equal(
		await resolveManagedRuntimeContext(sup, { packId: "hindsight", runtimeId: "hindsight", config: {} }),
		undefined,
	);
});

test("no supervisor ⇒ undefined", async () => {
	assert.equal(
		await resolveManagedRuntimeContext(undefined, { packId: "hindsight", runtimeId: "hindsight", config: MANAGED }),
		undefined,
	);
});

test("managed mode + running runtime + known API port ⇒ { baseUrl, headers, status }", async () => {
	const sup = stubSupervisor({
		status: { status: "running" },
		cap: { ports: [{ key: "HINDSIGHT_WEB_PORT", host: 13000 }, { key: "HINDSIGHT_API_PORT", host: 48080 }] } as Partial<Cap>,
	});
	const rt = await resolveManagedRuntimeContext(sup, {
		packId: "hindsight",
		runtimeId: "hindsight",
		projectId: "proj-1",
		config: { mode: "managed", apiKey: "sk-tok" },
	});
	assert.deepEqual(rt, {
		baseUrl: "http://127.0.0.1:48080",
		headers: { Authorization: "Bearer sk-tok" },
		status: "running",
	});
});

test("matches the API port by env var name when the key does not match", async () => {
	const sup = stubSupervisor({
		cap: { ports: [{ key: "primary", env: "HINDSIGHT_API_PORT", host: 41999 }] } as Partial<Cap>,
	});
	const rt = await resolveManagedRuntimeContext(sup, { packId: "p", runtimeId: "r", config: { mode: "managed" } });
	assert.equal(rt?.baseUrl, "http://127.0.0.1:41999");
	assert.deepEqual(rt?.headers, {}, "no apiKey ⇒ no Authorization header");
});

test("falls back to the first declared port when no API port spec matches", async () => {
	const sup = stubSupervisor({ cap: { ports: [{ key: "WEB", host: 18080 }] } as Partial<Cap> });
	const rt = await resolveManagedRuntimeContext(sup, { packId: "p", runtimeId: "r", config: { mode: "managed" } });
	assert.equal(rt?.baseUrl, "http://127.0.0.1:18080");
});

test("managed-external-postgres is also resolved", async () => {
	const sup = stubSupervisor({ cap: { ports: [{ key: "HINDSIGHT_API_PORT", host: 38080 }] } as Partial<Cap> });
	const rt = await resolveManagedRuntimeContext(sup, { packId: "p", runtimeId: "r", config: { mode: "managed-external-postgres" } });
	assert.equal(rt?.baseUrl, "http://127.0.0.1:38080");
});

test("no persisted host port yet ⇒ undefined (runtime not reachable)", async () => {
	const sup = stubSupervisor({ cap: { ports: [{ key: "HINDSIGHT_API_PORT" }] } as Partial<Cap> });
	assert.equal(
		await resolveManagedRuntimeContext(sup, { packId: "p", runtimeId: "r", config: { mode: "managed" } }),
		undefined,
	);
});

test("status() throwing ⇒ undefined (non-fatal)", async () => {
	const sup = stubSupervisor({ status: () => { throw new Error("docker query failed"); } });
	assert.equal(
		await resolveManagedRuntimeContext(sup, { packId: "p", runtimeId: "r", config: { mode: "managed" } }),
		undefined,
	);
});

test("capabilitySummary() throwing ⇒ undefined (non-fatal)", async () => {
	const sup = stubSupervisor({ cap: () => { throw new Error("summary failed"); } });
	assert.equal(
		await resolveManagedRuntimeContext(sup, { packId: "p", runtimeId: "r", config: { mode: "managed" } }),
		undefined,
	);
});

test("propagates the supervisor's status string (e.g. starting) onto ctx.runtime", async () => {
	const sup = stubSupervisor({
		status: { status: "starting" },
		cap: { ports: [{ key: "HINDSIGHT_API_PORT", host: 40000 }] } as Partial<Cap>,
	});
	const rt = await resolveManagedRuntimeContext(sup, { packId: "p", runtimeId: "r", config: { mode: "managed" } });
	assert.equal(rt?.status, "starting");
});
