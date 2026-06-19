/**
 * API E2E — P3 managed-runtime activation/consent wiring.
 *
 * Exercises the server-side activation side effects with the Docker layer FULLY
 * MOCKED (a fake PackRuntimeSupervisor injected via registerPackRuntimeSupervisorFactory).
 * Packs are written to disk at server scope (mirroring marketplace-provider-activation).
 *
 * Pins the P3 hard invariants:
 *   - Enabling a `startPolicy: on-enable` runtime in a MANAGED mode IS the explicit
 *     start action (calls supervisor.start exactly once); disabling calls stop.
 *   - EXTERNAL mode never starts a container on enable (non-Docker setup path).
 *   - Reading (GET pack-activation / GET pack-runtimes) never starts a runtime.
 *   - Uninstall tears down WITHOUT volumes (data survives); explicit purge runs
 *     down WITH volumes + state removal.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";
import { encodePackRuntimeId } from "../../dist/server/runtimes/index.js";
import fs from "node:fs";
import path from "node:path";

// ── Fake supervisor (no Docker). Records every control call. ─────────────────

interface SupCall {
	op: "start" | "stop" | "down" | "restart";
	packId: string;
	runtimeId: string;
	opts?: Record<string, unknown>;
}
const calls: SupCall[] = [];

function statusFor(packId: string, runtimeId: string, status: string, mode?: string) {
	return { id: `${packId}:${runtimeId}`, packId, runtimeId, status, mode, composeProject: `bobbit-pack-${packId}-test` };
}

const fakeSupervisor = {
	async list() { return []; },
	async status(packId: string, runtimeId: string) { return statusFor(packId, runtimeId, "stopped"); },
	async start(packId: string, runtimeId: string, opts?: Record<string, unknown>) {
		calls.push({ op: "start", packId, runtimeId, opts });
		return statusFor(packId, runtimeId, "running", opts?.mode as string | undefined);
	},
	async stop(packId: string, runtimeId: string, opts?: Record<string, unknown>) {
		calls.push({ op: "stop", packId, runtimeId, opts });
		return statusFor(packId, runtimeId, "stopped");
	},
	async restart(packId: string, runtimeId: string, opts?: Record<string, unknown>) {
		calls.push({ op: "restart", packId, runtimeId, opts });
		return statusFor(packId, runtimeId, "running");
	},
	async down(packId: string, runtimeId: string, opts?: Record<string, unknown>) {
		calls.push({ op: "down", packId, runtimeId, opts });
		return statusFor(packId, runtimeId, "stopped");
	},
	async logs() { return ""; },
	async capabilitySummary(packId: string, runtimeId: string, opts?: Record<string, unknown>) {
		// Echo the effective deployment config's dataDir into volumePath so a test can
		// prove the route forwards the SAME effective config used by activation (e.g. a
		// custom bind path), not just schema defaults.
		const config = (opts?.config ?? {}) as Record<string, unknown>;
		const volumePath = typeof config.dataDir === "string" && config.dataDir.length > 0 ? config.dataDir : "~/.hindsight";
		return { ...statusFor(packId, runtimeId, "stopped"), mode: (opts?.mode as string | undefined) ?? "managed-postgres", startPolicy: "on-enable", services: ["api", "web", "db"], images: ["api", "web", "db"], ports: [], volumePath, trust: "x" };
	},
};

// ── Pack-on-disk helpers (server scope). ─────────────────────────────────────

function writeMeta(packDir: string, packName: string): void {
	fs.writeFileSync(path.join(packDir, ".pack-meta.yaml"), [
		"sourceUrl: e2e",
		"sourceRef: local",
		"commit: test",
		`packName: ${packName}`,
		"version: 1.0.0",
		"installedAt: '2026-01-01T00:00:00.000Z'",
		"updatedAt: '2026-01-01T00:00:00.000Z'",
		"scope: server",
	].join("\n") + "\n", "utf-8");
}

/** A schema-v2 pack declaring a managed runtime (startPolicy: on-enable) and a
 *  memory provider carrying the deployment `mode` (drives the start plan). */
function writeRuntimePack(root: string, packName: string, mode: "external" | "managed" | "managed-external-postgres", opts: { extraProviderConfig?: string[]; dataDir?: string } = {}): string {
	const packDir = path.join(root, ".bobbit", "config", "market-packs", packName);
	fs.mkdirSync(path.join(packDir, "providers"), { recursive: true });
	fs.mkdirSync(path.join(packDir, "runtimes"), { recursive: true });
	fs.mkdirSync(path.join(packDir, "runtime"), { recursive: true });
	fs.mkdirSync(path.join(packDir, "lib"), { recursive: true });
	fs.writeFileSync(path.join(packDir, "pack.yaml"), [
		"schema: 2",
		`name: ${packName}`,
		"description: Runtime activation e2e",
		"version: 1.0.0",
		"contents:",
		"  roles: []",
		"  tools: []",
		"  skills: []",
		"  entrypoints: []",
		"  providers: [memory]",
		"  runtimes: [hindsight]",
	].join("\n") + "\n", "utf-8");
	writeMeta(packDir, packName);
	// Provider carries the deployment mode as its config default.
	fs.writeFileSync(path.join(packDir, "providers", "memory.yaml"), [
		"id: memory",
		"kind: memory",
		"module: ../lib/provider.mjs",
		"hooks: [beforePrompt]",
		"config:",
		`  mode: { type: enum, values: [external, managed, managed-external-postgres], default: ${mode} }`,
		"  externalUrl: { type: string, optional: true }",
		`  dataDir: { type: string, default: ${opts.dataDir ?? "~/.hindsight"} }`,
		...(opts.extraProviderConfig ?? []),
	].join("\n") + "\n", "utf-8");
	// Minimal but realistic runtime descriptor (raw manifest is carried verbatim;
	// the activation hook only reads startPolicy + forwards to the supervisor).
	fs.writeFileSync(path.join(packDir, "runtimes", "hindsight.yaml"), [
		"id: hindsight",
		"title: Hindsight",
		"startPolicy: on-enable",
		"composeFile: ../runtime/compose.yaml",
		"modes:",
		"  managed-postgres: { services: [api, web, db] }",
		"  external-postgres: { services: [api, web, db], omitServices: [db] }",
	].join("\n") + "\n", "utf-8");
	fs.writeFileSync(path.join(packDir, "runtime", "compose.yaml"), "services:\n  api: { image: hindsight/api }\n", "utf-8");
	fs.writeFileSync(path.join(packDir, "lib", "provider.mjs"), "export default {};\n", "utf-8");
	return packDir;
}

/** A schema-v2 pack declaring a managed runtime (startPolicy: on-enable) but NO
 *  provider — i.e. no deployment-config surface. resolveRuntimeStartPlan({})
 *  defaults to external/no-start, so without the no-surface fallback the
 *  `on-enable` runtime would never start. */
function writeProviderlessRuntimePack(root: string, packName: string): string {
	const packDir = path.join(root, ".bobbit", "config", "market-packs", packName);
	fs.mkdirSync(path.join(packDir, "runtimes"), { recursive: true });
	fs.mkdirSync(path.join(packDir, "runtime"), { recursive: true });
	fs.writeFileSync(path.join(packDir, "pack.yaml"), [
		"schema: 2",
		`name: ${packName}`,
		"description: Provider-less runtime activation e2e",
		"version: 1.0.0",
		"contents:",
		"  roles: []",
		"  tools: []",
		"  skills: []",
		"  entrypoints: []",
		"  providers: []",
		"  runtimes: [hindsight]",
	].join("\n") + "\n", "utf-8");
	writeMeta(packDir, packName);
	fs.writeFileSync(path.join(packDir, "runtimes", "hindsight.yaml"), [
		"id: hindsight",
		"title: Hindsight",
		"startPolicy: on-enable",
		"composeFile: ../runtime/compose.yaml",
		"modes:",
		"  managed-postgres: { services: [api, web, db] }",
	].join("\n") + "\n", "utf-8");
	fs.writeFileSync(path.join(packDir, "runtime", "compose.yaml"), "services:\n  api: { image: hindsight/api }\n", "utf-8");
	return packDir;
}

/** A schema-v2 pack declaring a managed runtime (startPolicy: on-enable) AND a
 *  provider — but a provider that carries NO deployment `mode` (an UNRELATED
 *  provider). Per finding #2 this must behave EXACTLY like a provider-less runtime
 *  pack: `hasDeploymentSurface` is false (a provider alone is not a deployment
 *  surface), so the `on-enable` runtime starts in the manifest DEFAULT mode. */
function writeNoModeProviderRuntimePack(root: string, packName: string): string {
	const packDir = path.join(root, ".bobbit", "config", "market-packs", packName);
	fs.mkdirSync(path.join(packDir, "providers"), { recursive: true });
	fs.mkdirSync(path.join(packDir, "runtimes"), { recursive: true });
	fs.mkdirSync(path.join(packDir, "runtime"), { recursive: true });
	fs.mkdirSync(path.join(packDir, "lib"), { recursive: true });
	fs.writeFileSync(path.join(packDir, "pack.yaml"), [
		"schema: 2",
		`name: ${packName}`,
		"description: No-mode provider runtime e2e",
		"version: 1.0.0",
		"contents:",
		"  roles: []",
		"  tools: []",
		"  skills: []",
		"  entrypoints: []",
		"  providers: [aux]",
		"  runtimes: [hindsight]",
	].join("\n") + "\n", "utf-8");
	writeMeta(packDir, packName);
	// Provider with NO `mode` and NO activeWhenConfig.mode → not a deployment surface.
	fs.writeFileSync(path.join(packDir, "providers", "aux.yaml"), [
		"id: aux",
		"kind: generic",
		"module: ../lib/provider.mjs",
		"hooks: [beforePrompt]",
		"config:",
		"  label: { type: string, default: hello }",
	].join("\n") + "\n", "utf-8");
	fs.writeFileSync(path.join(packDir, "runtimes", "hindsight.yaml"), [
		"id: hindsight",
		"title: Hindsight",
		"startPolicy: on-enable",
		"composeFile: ../runtime/compose.yaml",
		"modes:",
		"  managed-postgres: { services: [api, web, db] }",
	].join("\n") + "\n", "utf-8");
	fs.writeFileSync(path.join(packDir, "runtime", "compose.yaml"), "services:\n  api: { image: hindsight/api }\n", "utf-8");
	fs.writeFileSync(path.join(packDir, "lib", "provider.mjs"), "export default {};\n", "utf-8");
	return packDir;
}

async function setDisabledRuntimes(packName: string, runtimes: string[]) {
	return apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName, disabled: { runtimes } }),
	});
}

/** The persisted disabled-runtime refs for a pack (server scope). */
async function getDisabledRuntimes(packName: string): Promise<string[]> {
	const res = await apiFetch(`/api/marketplace/pack-activation?scope=server&packName=${encodeURIComponent(packName)}`);
	const body = await res.json();
	return (body?.disabled?.runtimes ?? []) as string[];
}

test.describe("marketplace managed-runtime activation (P3)", () => {
	test.beforeAll(async () => {
		const mod = await import("../../dist/server/server.js");
		mod.registerPackRuntimeSupervisorFactory(() => fakeSupervisor);
	});
	test.afterAll(async () => {
		const mod = await import("../../dist/server/server.js");
		mod.registerPackRuntimeSupervisorFactory(null);
	});
	test.beforeEach(() => { calls.length = 0; });

	test("managed mode: enabling an on-enable runtime starts it once; disabling stops it", async ({ gateway }) => {
		const packName = `rt-managed-${Date.now()}`;
		const packDir = writeRuntimePack(gateway.bobbitDir, packName, "managed");
		try {
			// 1. Disable the runtime first (enabled → disabled) → exactly one stop.
			const disable = await setDisabledRuntimes(packName, ["hindsight"]);
			expect(disable.status).toBe(200);
			expect(calls.filter((c) => c.op === "stop").length).toBe(1);
			expect(calls.some((c) => c.op === "start")).toBe(false);

			calls.length = 0;
			// 2. Re-enable (disabled → enabled) → explicit managed start, exactly once.
			const enable = await setDisabledRuntimes(packName, []);
			expect(enable.status).toBe(200);
			const startCalls = calls.filter((c) => c.op === "start");
			expect(startCalls.length).toBe(1);
			expect(startCalls[0].runtimeId).toBe("hindsight");
			// managed → runtime mode managed-postgres is forwarded to the supervisor.
			expect(startCalls[0].opts?.mode).toBe("managed-postgres");
			// The activation response surfaces the runtime status.
			const body = await enable.json();
			expect(Array.isArray(body.runtimes)).toBe(true);
			expect(body.runtimes[0].status).toBe("running");
		} finally {
			fs.rmSync(packDir, { recursive: true, force: true });
		}
	});

	test("managed mode forwards the provider llmApiKey onto the runtime HINDSIGHT_API_LLM_API_KEY secret (finding #1)", async ({ gateway }) => {
		const packName = `rt-llmkey-${Date.now()}`;
		// The managed Hindsight runtime requires HINDSIGHT_API_LLM_API_KEY (a user-
		// configured secret env ref). The provider exposes it via the `llmApiKey`
		// deployment-config field; the activation start plan must remap it onto the
		// runtime env key so the supervisor's config overlay can satisfy it.
		const packDir = writeRuntimePack(gateway.bobbitDir, packName, "managed", {
			extraProviderConfig: ["  llmApiKey: { type: string, default: test-llm-key }"],
		});
		try {
			await setDisabledRuntimes(packName, ["hindsight"]);
			calls.length = 0;
			const enable = await setDisabledRuntimes(packName, []);
			expect(enable.status).toBe(200);
			const startCalls = calls.filter((c) => c.op === "start");
			expect(startCalls.length).toBe(1);
			const config = startCalls[0].opts?.config as Record<string, unknown> | undefined;
			expect(config?.HINDSIGHT_API_LLM_API_KEY).toBe("test-llm-key");
		} finally {
			fs.rmSync(packDir, { recursive: true, force: true });
		}
	});

	test("provider-less runtime pack: enabling an on-enable runtime starts it in the default mode (finding #2 — no deployment surface)", async ({ gateway }) => {
		// A runtime-only pack has NO provider deployment config, so the start plan
		// defaults to external/no-start. The activation path must mirror the REST start
		// path's no-deployment-surface fallback: an `on-enable` runtime starts in the
		// runtime's DEFAULT mode (mode undefined ⇒ supervisor picks the manifest default),
		// rather than being suppressed by the external default.
		const packName = `rt-providerless-${Date.now()}`;
		const packDir = writeProviderlessRuntimePack(gateway.bobbitDir, packName);
		try {
			// Disable then re-enable to drive the explicit disabled → enabled start path.
			await setDisabledRuntimes(packName, ["hindsight"]);
			calls.length = 0;
			const enable = await setDisabledRuntimes(packName, []);
			expect(enable.status).toBe(200);
			const startCalls = calls.filter((c) => c.op === "start");
			expect(startCalls.length).toBe(1);
			expect(startCalls[0].runtimeId).toBe("hindsight");
			// No deployment surface → no managed/external mode forwarded; the supervisor
			// resolves the runtime's default mode itself.
			expect(startCalls[0].opts?.mode).toBeUndefined();
			const body = await enable.json();
			expect(Array.isArray(body.runtimes)).toBe(true);
			expect(body.runtimes[0].status).toBe("running");
		} finally {
			fs.rmSync(packDir, { recursive: true, force: true });
		}
	});

	test("unrelated-provider runtime pack: an on-enable runtime starts in the DEFAULT mode — a provider with no deployment mode is NOT a deployment surface (finding #2)", async ({ gateway }) => {
		// A pack with a provider that carries no deployment `mode` has no external/managed
		// concept, so it must behave like a provider-less runtime pack: the no-deployment-
		// surface fallback starts the `on-enable` runtime in the manifest DEFAULT mode
		// (mode undefined) rather than being suppressed by the external-default plan.
		const packName = `rt-nomode-${Date.now()}`;
		const packDir = writeNoModeProviderRuntimePack(gateway.bobbitDir, packName);
		try {
			await setDisabledRuntimes(packName, ["hindsight"]);
			calls.length = 0;
			const enable = await setDisabledRuntimes(packName, []);
			expect(enable.status).toBe(200);
			const startCalls = calls.filter((c) => c.op === "start");
			expect(startCalls.length).toBe(1);
			expect(startCalls[0].runtimeId).toBe("hindsight");
			// No deployment surface → no mode forwarded; the supervisor picks the default.
			expect(startCalls[0].opts?.mode).toBeUndefined();
			const body = await enable.json();
			expect(body.runtimes[0].status).toBe("running");
		} finally {
			fs.rmSync(packDir, { recursive: true, force: true });
		}
	});

	test("capabilities for a provider-less runtime pack disclose the manifest DEFAULT Docker mode/services — not external/no-Docker (finding #1)", async ({ gateway }) => {
		// With no deployment surface the disclosure must show the manifest default (Docker)
		// mode/services so the consent UI matches what activation/start actually brings up,
		// rather than collapsing to the external (no-Docker) setup path.
		const packName = `rt-cap-providerless-${Date.now()}`;
		const packDir = writeProviderlessRuntimePack(gateway.bobbitDir, packName);
		try {
			const id = encodePackRuntimeId(packName, "hindsight");
			const res = await apiFetch(`/api/pack-runtimes/${id}/capabilities`);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.dockerRequired).toBe(true);
			expect(body.mode).toBe("managed-postgres");
			expect(body.services).toEqual(["api", "web", "db"]);
		} finally {
			fs.rmSync(packDir, { recursive: true, force: true });
		}
	});

	test("capabilities for an unrelated-provider runtime pack also disclose the default Docker mode (finding #1)", async ({ gateway }) => {
		const packName = `rt-cap-nomode-${Date.now()}`;
		const packDir = writeNoModeProviderRuntimePack(gateway.bobbitDir, packName);
		try {
			const id = encodePackRuntimeId(packName, "hindsight");
			const res = await apiFetch(`/api/pack-runtimes/${id}/capabilities`);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.dockerRequired).toBe(true);
			expect(body.mode).toBe("managed-postgres");
			expect(body.services).toEqual(["api", "web", "db"]);
		} finally {
			fs.rmSync(packDir, { recursive: true, force: true });
		}
	});

	test("disabled runtime: the runtime REST 404s (registry no longer resolves it) (finding #3)", async ({ gateway }) => {
		// Disabling a runtime via pack_activation drops it from the pack's contributions,
		// so the supervisor's registry lookup misses → 404 on capabilities/start. Use the
		// REAL (registry-backed) supervisor here: the fake supervisor never consults the
		// registry, so the rejection must come from the registry filtering itself.
		const mod = await import("../../dist/server/server.js");
		const packName = `rt-disabled-rest-${Date.now()}`;
		const packDir = writeRuntimePack(gateway.bobbitDir, packName, "managed");
		try {
			// Disable the runtime (fake supervisor present → harmless stop).
			const disable = await setDisabledRuntimes(packName, ["hindsight"]);
			expect(disable.status).toBe(200);
			// Switch to the real, registry-backed supervisor so the lookup is registry-driven.
			mod.registerPackRuntimeSupervisorFactory(null);
			const id = encodePackRuntimeId(packName, "hindsight");
			const caps = await apiFetch(`/api/pack-runtimes/${id}/capabilities`);
			expect(caps.status).toBe(404);
			const start = await apiFetch(`/api/pack-runtimes/${id}/start`, { method: "POST", body: JSON.stringify({ mode: "managed-postgres" }) });
			expect(start.status).toBe(404);
		} finally {
			mod.registerPackRuntimeSupervisorFactory(() => fakeSupervisor);
			fs.rmSync(packDir, { recursive: true, force: true });
		}
	});

	test("external mode: enabling the runtime NEVER starts a container (non-Docker setup path)", async ({ gateway }) => {
		const packName = `rt-external-${Date.now()}`;
		const packDir = writeRuntimePack(gateway.bobbitDir, packName, "external");
		try {
			// Disable then re-enable; the external deployment mode must avoid start entirely.
			await setDisabledRuntimes(packName, ["hindsight"]);
			calls.length = 0;
			const enable = await setDisabledRuntimes(packName, []);
			expect(enable.status).toBe(200);
			expect(calls.some((c) => c.op === "start")).toBe(false);
			// No runtime status surfaced because no supervisor action was taken.
			const body = await enable.json();
			expect(body.runtimes).toBeUndefined();
		} finally {
			fs.rmSync(packDir, { recursive: true, force: true });
		}
	});

	test("disable stops the runtime even when the CURRENT mode is external (managed-start leak guard, review finding)", async ({ gateway }) => {
		// Scenario: the runtime was previously started in a MANAGED mode, then the saved
		// deployment config was changed to `external`. Teardown must NOT be gated on the
		// CURRENT saved mode — gating skips the stop and leaks the still-running container.
		// stop() is now read-only/minimal/idempotent (it never resolves start-only inputs
		// like HINDSIGHT_API_LLM_API_KEY, reuses an already-rendered .env only when one
		// exists, and maps a missing Docker install to a docker-unavailable STATUS rather
		// than throwing), so calling it for an external/never-started runtime is harmless.
		const packName = `rt-external-disable-${Date.now()}`;
		const packDir = writeRuntimePack(gateway.bobbitDir, packName, "external");
		try {
			expect(await getDisabledRuntimes(packName)).not.toContain("hindsight");
			const disable = await setDisabledRuntimes(packName, ["hindsight"]);
			expect(disable.status).toBe(200);
			// stop IS called now (unconditional teardown) and harmlessly returns stopped.
			const stopCalls = calls.filter((c) => c.op === "stop");
			expect(stopCalls.length).toBe(1);
			expect(stopCalls[0].runtimeId).toBe("hindsight");
			// The disable still persists.
			expect(await getDisabledRuntimes(packName)).toContain("hindsight");
		} finally {
			fs.rmSync(packDir, { recursive: true, force: true });
		}
	});

	test("uninstall tears the runtime down (without -v) even when the CURRENT mode is external (managed-start leak guard, review finding)", async ({ gateway }) => {
		// Mirror of the disable guard for uninstall: a runtime started managed and later
		// reconfigured to external must still be `compose down`-ed on uninstall, or the
		// container leaks. down() is read-only/minimal/idempotent (never resolves managed
		// start-only inputs, maps no-Docker to a status), so it is harmless for an
		// external/never-started runtime. Default uninstall preserves data (no `-v`).
		const packName = `rt-external-uninstall-${Date.now()}`;
		const packDir = writeRuntimePack(gateway.bobbitDir, packName, "external");
		try {
			const res = await apiFetch("/api/marketplace/installed", {
				method: "DELETE",
				body: JSON.stringify({ scope: "server", packName }),
			});
			expect(res.status).toBe(204);
			// down IS called now (unconditional teardown) WITHOUT volumes (bind data survives).
			const downCalls = calls.filter((c) => c.op === "down");
			expect(downCalls.length).toBe(1);
			expect(downCalls[0].runtimeId).toBe("hindsight");
			expect(downCalls[0].opts?.volumes).toBe(false);
			expect(downCalls[0].opts?.removeState).toBe(false);
			// The pack is gone from the install ledger.
			const listed = await apiFetch("/api/marketplace/installed");
			const installed = (await listed.json()).installed as Array<{ packName: string; scope: string }>;
			expect(installed.some((p) => p.packName === packName && p.scope === "server")).toBe(false);
		} finally {
			fs.rmSync(packDir, { recursive: true, force: true });
		}
	});

	test("managed mode: UNINSTALL still tears the runtime down (review finding #2 — managed unchanged)", async ({ gateway }) => {
		const packName = `rt-managed-uninstall-${Date.now()}`;
		const packDir = writeRuntimePack(gateway.bobbitDir, packName, "managed");
		try {
			const res = await apiFetch("/api/marketplace/installed", {
				method: "DELETE",
				body: JSON.stringify({ scope: "server", packName }),
			});
			expect(res.status).toBe(204);
			const downCalls = calls.filter((c) => c.op === "down");
			expect(downCalls.length).toBe(1);
			expect(downCalls[0].opts?.volumes).toBe(false);
			expect(downCalls[0].opts?.removeState).toBe(false);
		} finally {
			fs.rmSync(packDir, { recursive: true, force: true });
		}
	});

	test("capabilities for managed mode discloses the CUSTOM dataDir bind path activation uses (review finding #3)", async ({ gateway }) => {
		const packName = `rt-capabilities-datadir-${Date.now()}`;
		const customPath = "/srv/custom-hindsight-data";
		// Managed mode with a non-default dataDir. The capabilities route must resolve the
		// SAME effective deployment config activation uses and forward it, so the consent
		// disclosure shows the custom bind path — not the schema default.
		const packDir = writeRuntimePack(gateway.bobbitDir, packName, "managed", { dataDir: customPath });
		try {
			// packId for a server-scope disk pack under market-packs/<name> is <name>.
			const id = encodePackRuntimeId(packName, "hindsight");
			const res = await apiFetch(`/api/pack-runtimes/${id}/capabilities`);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.mode).toBe("managed-postgres");
			expect(body.dockerRequired).toBe(true);
			expect(body.volumePath).toBe(customPath);
		} finally {
			fs.rmSync(packDir, { recursive: true, force: true });
		}
	});

	test("reads never auto-start: GET pack-activation + GET pack-runtimes issue no start", async ({ gateway }) => {
		const packName = `rt-noauto-${Date.now()}`;
		const packDir = writeRuntimePack(gateway.bobbitDir, packName, "managed");
		try {
			const get = await apiFetch(`/api/marketplace/pack-activation?scope=server&packName=${encodeURIComponent(packName)}`);
			expect(get.status).toBe(200);
			const body = await get.json();
			expect(body.catalogue.runtimes).toEqual(["hindsight"]);
			await apiFetch("/api/pack-runtimes");
			// Pure reads — listing/inspecting must never bring a runtime up.
			expect(calls.some((c) => c.op === "start")).toBe(false);
		} finally {
			fs.rmSync(packDir, { recursive: true, force: true });
		}
	});

	test("uninstall tears the runtime down WITHOUT volumes (bind data survives)", async ({ gateway }) => {
		const packName = `rt-uninstall-${Date.now()}`;
		const packDir = writeRuntimePack(gateway.bobbitDir, packName, "managed");
		try {
			const res = await apiFetch("/api/marketplace/installed", {
				method: "DELETE",
				body: JSON.stringify({ scope: "server", packName }),
			});
			expect(res.status).toBe(204);
			const downCalls = calls.filter((c) => c.op === "down");
			expect(downCalls.length).toBe(1);
			expect(downCalls[0].runtimeId).toBe("hindsight");
			expect(downCalls[0].opts?.volumes).toBe(false);
			expect(downCalls[0].opts?.removeState).toBe(false);
		} finally {
			fs.rmSync(packDir, { recursive: true, force: true });
		}
	});

	test("uninstall reports a REAL teardown failure (down throws) and does NOT uninstall", async ({ gateway }) => {
		const mod = await import("../../dist/server/server.js");
		const packName = `rt-uninstall-fail-${Date.now()}`;
		const packDir = writeRuntimePack(gateway.bobbitDir, packName, "managed");
		mod.registerPackRuntimeSupervisorFactory(() => ({
			...fakeSupervisor,
			async down(packId: string, runtimeId: string, opts?: Record<string, unknown>) {
				calls.push({ op: "down", packId, runtimeId, opts });
				throw new Error("compose down exploded");
			},
		}));
		try {
			const res = await apiFetch("/api/marketplace/installed", {
				method: "DELETE",
				body: JSON.stringify({ scope: "server", packName }),
			});
			// A real Docker teardown failure is reported — never silently swallowed.
			expect(res.status).toBe(502);
			const body = await res.json();
			expect(String(body.error)).toContain("teardown failed");
			expect(Array.isArray(body.details)).toBe(true);
			expect(body.details.join(" ")).toContain("compose down exploded");
			// The pack is STILL installed (the uninstall was aborted, not silently completed).
			const listed = await apiFetch("/api/marketplace/installed");
			const installed = (await listed.json()).installed as Array<{ packName: string; scope: string }>;
			expect(installed.some((p) => p.packName === packName && p.scope === "server")).toBe(true);
		} finally {
			mod.registerPackRuntimeSupervisorFactory(() => fakeSupervisor);
			fs.rmSync(packDir, { recursive: true, force: true });
		}
	});

	test("uninstall TOLERATES a docker-unavailable runtime (down returns status, no throw) and still uninstalls", async ({ gateway }) => {
		const mod = await import("../../dist/server/server.js");
		const packName = `rt-uninstall-nodocker-${Date.now()}`;
		const packDir = writeRuntimePack(gateway.bobbitDir, packName, "managed");
		mod.registerPackRuntimeSupervisorFactory(() => ({
			...fakeSupervisor,
			async down(packId: string, runtimeId: string, opts?: Record<string, unknown>) {
				calls.push({ op: "down", packId, runtimeId, opts });
				return statusFor(packId, runtimeId, "docker-unavailable");
			},
		}));
		try {
			const res = await apiFetch("/api/marketplace/installed", {
				method: "DELETE",
				body: JSON.stringify({ scope: "server", packName }),
			});
			// A docker-unavailable STATUS (graceful, no throw) must not block uninstall.
			expect(res.status).toBe(204);
			expect(calls.filter((c) => c.op === "down").length).toBe(1);
		} finally {
			mod.registerPackRuntimeSupervisorFactory(() => fakeSupervisor);
			fs.rmSync(packDir, { recursive: true, force: true });
		}
	});

	test("enable FAILURE (start throws) returns 502 and does NOT persist enabled (finding #2)", async ({ gateway }) => {
		const mod = await import("../../dist/server/server.js");
		const packName = `rt-enable-throw-${Date.now()}`;
		const packDir = writeRuntimePack(gateway.bobbitDir, packName, "managed");
		try {
			// Start disabled (persisted), then make start() throw on the re-enable.
			await setDisabledRuntimes(packName, ["hindsight"]);
			expect(await getDisabledRuntimes(packName)).toContain("hindsight");
			mod.registerPackRuntimeSupervisorFactory(() => ({
				...fakeSupervisor,
				async start(packId: string, runtimeId: string, opts?: Record<string, unknown>) {
					calls.push({ op: "start", packId, runtimeId, opts });
					throw new Error("compose up exploded");
				},
			}));
			const enable = await setDisabledRuntimes(packName, []);
			// A thrown start aborts the PUT — never a swallowed 200.
			expect(enable.status).toBe(502);
			const body = await enable.json();
			expect(String(body.error)).toContain("compose up exploded");
			expect(body.runtimes[0].status).toBe("error");
			// State is unchanged: the runtime is STILL disabled (the enable did not take).
			expect(body.disabled.runtimes).toContain("hindsight");
			expect(await getDisabledRuntimes(packName)).toContain("hindsight");
		} finally {
			mod.registerPackRuntimeSupervisorFactory(() => fakeSupervisor);
			fs.rmSync(packDir, { recursive: true, force: true });
		}
	});

	test("enable FAILURE (start returns unhealthy) returns 502 and does NOT persist enabled (finding #2)", async ({ gateway }) => {
		const mod = await import("../../dist/server/server.js");
		const packName = `rt-enable-unhealthy-${Date.now()}`;
		const packDir = writeRuntimePack(gateway.bobbitDir, packName, "managed");
		try {
			await setDisabledRuntimes(packName, ["hindsight"]);
			mod.registerPackRuntimeSupervisorFactory(() => ({
				...fakeSupervisor,
				async start(packId: string, runtimeId: string, opts?: Record<string, unknown>) {
					calls.push({ op: "start", packId, runtimeId, opts });
					return statusFor(packId, runtimeId, "unhealthy", opts?.mode as string | undefined);
				},
			}));
			const enable = await setDisabledRuntimes(packName, []);
			expect(enable.status).toBe(502);
			const body = await enable.json();
			expect(String(body.error)).toContain("failed to start");
			expect(await getDisabledRuntimes(packName)).toContain("hindsight");
		} finally {
			mod.registerPackRuntimeSupervisorFactory(() => fakeSupervisor);
			fs.rmSync(packDir, { recursive: true, force: true });
		}
	});

	test("disable FAILURE (stop throws) returns 502 and does NOT persist disabled (finding #2)", async ({ gateway }) => {
		const mod = await import("../../dist/server/server.js");
		const packName = `rt-disable-throw-${Date.now()}`;
		const packDir = writeRuntimePack(gateway.bobbitDir, packName, "managed");
		try {
			// Runtime starts enabled (empty disabled set). Make stop() throw on disable.
			expect(await getDisabledRuntimes(packName)).not.toContain("hindsight");
			mod.registerPackRuntimeSupervisorFactory(() => ({
				...fakeSupervisor,
				async stop(packId: string, runtimeId: string, opts?: Record<string, unknown>) {
					calls.push({ op: "stop", packId, runtimeId, opts });
					throw new Error("compose stop exploded");
				},
			}));
			const disable = await setDisabledRuntimes(packName, ["hindsight"]);
			expect(disable.status).toBe(502);
			const body = await disable.json();
			expect(String(body.error)).toContain("compose stop exploded");
			// The runtime is STILL enabled — a failed stop must not record it disabled.
			expect(body.disabled.runtimes ?? []).not.toContain("hindsight");
			expect(await getDisabledRuntimes(packName)).not.toContain("hindsight");
		} finally {
			mod.registerPackRuntimeSupervisorFactory(() => fakeSupervisor);
			fs.rmSync(packDir, { recursive: true, force: true });
		}
	});

	test("enable TOLERATES docker-unavailable: persists enabled, reports status, no 502 (finding #2)", async ({ gateway }) => {
		const mod = await import("../../dist/server/server.js");
		const packName = `rt-enable-nodocker-${Date.now()}`;
		const packDir = writeRuntimePack(gateway.bobbitDir, packName, "managed");
		try {
			await setDisabledRuntimes(packName, ["hindsight"]);
			mod.registerPackRuntimeSupervisorFactory(() => ({
				...fakeSupervisor,
				async start(packId: string, runtimeId: string, opts?: Record<string, unknown>) {
					calls.push({ op: "start", packId, runtimeId, opts });
					return statusFor(packId, runtimeId, "docker-unavailable", opts?.mode as string | undefined);
				},
			}));
			const enable = await setDisabledRuntimes(packName, []);
			// docker-unavailable is graceful — the enable persists and is reported (not a 502).
			expect(enable.status).toBe(200);
			const body = await enable.json();
			expect(body.runtimes[0].status).toBe("docker-unavailable");
			expect(await getDisabledRuntimes(packName)).not.toContain("hindsight");
		} finally {
			mod.registerPackRuntimeSupervisorFactory(() => fakeSupervisor);
			fs.rmSync(packDir, { recursive: true, force: true });
		}
	});

	test("explicit purge runs down WITH volumes + state removal", async ({ gateway }) => {
		const packName = `rt-purge-${Date.now()}`;
		const packDir = writeRuntimePack(gateway.bobbitDir, packName, "managed");
		try {
			const res = await apiFetch("/api/marketplace/purge-runtime", {
				method: "POST",
				body: JSON.stringify({ scope: "server", packName, runtimeId: "hindsight" }),
			});
			expect(res.status).toBe(200);
			const downCalls = calls.filter((c) => c.op === "down");
			expect(downCalls.length).toBe(1);
			expect(downCalls[0].opts?.volumes).toBe(true);
			expect(downCalls[0].opts?.removeState).toBe(true);
			const data = await res.json();
			expect(data.status).toBe("stopped");
		} finally {
			fs.rmSync(packDir, { recursive: true, force: true });
		}
	});

	test("purge-runtime for an unknown runtime → 404", async ({ gateway }) => {
		const packName = `rt-purge-404-${Date.now()}`;
		const packDir = writeRuntimePack(gateway.bobbitDir, packName, "managed");
		try {
			const res = await apiFetch("/api/marketplace/purge-runtime", {
				method: "POST",
				body: JSON.stringify({ scope: "server", packName, runtimeId: "ghost" }),
			});
			expect(res.status).toBe(404);
			expect(calls.some((c) => c.op === "down")).toBe(false);
		} finally {
			fs.rmSync(packDir, { recursive: true, force: true });
		}
	});
});
