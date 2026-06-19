/**
 * API E2E — `/api/pack-runtimes/:id/{start,restart}` deployment-config remap
 * (finding #2).
 *
 * The start/restart routes must DERIVE the saved provider deployment config for
 * the pack and remap it onto the runtime's env keys EXACTLY like marketplace
 * activation start does (the shared module-level resolveRuntimeStartPlan):
 *   - `llmApiKey`            → HINDSIGHT_API_LLM_API_KEY
 *   - `externalDatabaseUrl`  → HINDSIGHT_API_DATABASE_URL
 *   - deployment `mode`      → runtime manifest mode (managed ⇒ managed-postgres,
 *                              managed-external-postgres ⇒ external-postgres)
 *
 * To exercise the REAL config-derivation path (not just a fake mode assertion)
 * this installs the first-party Hindsight pack at server scope and seeds a
 * real-ish persisted provider config into the pack-scoped store, then drives the
 * route with a fake supervisor that captures the start opts the route forwarded.
 *
 * The Docker layer is fully mocked via registerPackRuntimeSupervisorFactory — no
 * daemon is involved. Pack install/seed mirrors tests/e2e/hindsight-agent-tools.spec.ts.
 */
import { test as base, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodePackRuntimeId } from "../../dist/server/runtimes/index.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const PACK_NAME = "hindsight";
const PACK_ID = "hindsight"; // pack store namespace + structural id for this first-party pack
const RUNTIME_ID = "hindsight"; // runtimes/hindsight.yaml `id`
const PACK_SRC = path.resolve(__dirname, "..", "..", "market-packs", PACK_NAME);
const CONFIG_STORE_KEY = "provider-config:memory"; // == providerConfigStoreKey("memory")

// Skip until the pack files + built provider/runtime descriptors are present, so
// the e2e phase stays green before the implementation lands.
const DEPS_READY =
	fs.existsSync(path.join(PACK_SRC, "pack.yaml")) &&
	fs.existsSync(path.join(PACK_SRC, "runtimes", "hindsight.yaml")) &&
	fs.existsSync(path.join(PACK_SRC, "lib", "provider.mjs"));

const test = base;
const describe = DEPS_READY ? test.describe : test.describe.skip;

// ── Fake supervisor capturing the start/restart opts the route forwards ──────
interface StartOpts { projectId?: string; mode?: string; config?: Record<string, unknown> }
const calls: Array<{ op: string; packId: string; runtimeId: string; opts?: StartOpts }> = [];

function statusRow(status: string, mode?: string) {
	return {
		id: encodePackRuntimeId(PACK_ID, RUNTIME_ID),
		packId: PACK_ID,
		packName: "Hindsight",
		runtimeId: RUNTIME_ID,
		status,
		mode,
		composeProject: `bobbit-pack-${PACK_ID}-test`,
	};
}

const fakeSupervisor = {
	async list() { return [statusRow("stopped")]; },
	async status() { return statusRow("stopped"); },
	async start(packId: string, runtimeId: string, opts?: StartOpts) {
		calls.push({ op: "start", packId, runtimeId, opts });
		return statusRow("running", opts?.mode ?? "default");
	},
	async stop(packId: string, runtimeId: string, opts?: StartOpts) {
		calls.push({ op: "stop", packId, runtimeId, opts });
		return statusRow("stopped");
	},
	async restart(packId: string, runtimeId: string, opts?: StartOpts) {
		calls.push({ op: "restart", packId, runtimeId, opts });
		return statusRow("running", opts?.mode ?? "default");
	},
	async logs() { return ""; },
	async down() { return statusRow("stopped"); },
	async capabilitySummary() {
		return {
			id: encodePackRuntimeId(PACK_ID, RUNTIME_ID),
			packId: PACK_ID,
			runtimeId: RUNTIME_ID,
			mode: "managed-postgres",
			startPolicy: "on-enable",
			composeProject: `bobbit-pack-${PACK_ID}-test`,
			services: ["api", "db"],
			images: ["api", "db"],
			ports: [],
			trust: "memory",
		};
	},
};

function installPack(bobbitDir: string): void {
	const packDir = path.join(bobbitDir, ".bobbit", "config", "market-packs", PACK_NAME);
	fs.rmSync(packDir, { recursive: true, force: true });
	fs.cpSync(PACK_SRC, packDir, { recursive: true });
	fs.writeFileSync(
		path.join(packDir, ".pack-meta.yaml"),
		[
			"sourceUrl: e2e",
			"sourceRef: local",
			"commit: test",
			`packName: ${PACK_NAME}`,
			"version: 1.0.0",
			"installedAt: '2026-01-01T00:00:00.000Z'",
			"updatedAt: '2026-01-01T00:00:00.000Z'",
			"scope: server",
		].join("\n") + "\n",
		"utf-8",
	);
}

/** Percent-encode every non-alphanumeric byte — mirrors pack-store.ts::encodeKey. */
function encodeStoreKey(key: string): string {
	const bytes = Buffer.from(key, "utf8");
	let out = "";
	for (const b of bytes) {
		const isAlnum = (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
		out += isAlnum ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return out;
}

function seedConfig(bobbitDir: string, config: Record<string, unknown> | null): void {
	const dir = path.join(bobbitDir, "state", "ext-store", PACK_ID);
	const file = path.join(dir, `${encodeStoreKey(CONFIG_STORE_KEY)}.json`);
	if (config === null) { fs.rmSync(file, { force: true }); return; }
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ v: 1, value: config }), "utf-8");
}

async function setPackActivation(disabled: Record<string, string[]>): Promise<void> {
	const resp = await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK_NAME, disabled }),
	});
	expect(resp.status, await resp.text().catch(() => "")).toBe(200);
}
const ALL_ENABLED = { roles: [], tools: [], skills: [], entrypoints: [], providers: [] };

/** Seed provider config AND refresh the activation-filtered registry index. The
 *  registry overlays persisted store config + applies the provider activation
 *  gate at INDEX time and caches the result; a direct disk seed afterwards is
 *  invisible until the cache is dropped. A pack-activation PUT invalidates the
 *  resolver caches, so the runtime route then sees the seeded deployment config. */
async function seedAndRefresh(bobbitDir: string, config: Record<string, unknown>): Promise<void> {
	seedConfig(bobbitDir, config);
	await setPackActivation(ALL_ENABLED);
}

const RUNTIME_API_ID = encodePackRuntimeId(PACK_ID, RUNTIME_ID);

describe.configure({ mode: "serial" });

describe("pack-runtimes start/restart derives + remaps the saved deployment config", () => {
	let bobbitDir: string;

	test.beforeAll(async ({ gateway }) => {
		bobbitDir = gateway.bobbitDir;
		installPack(bobbitDir);
		const mod = await import("../../dist/server/server.js");
		mod.registerPackRuntimeSupervisorFactory(() => fakeSupervisor);
		// PUT pack-activation invalidates resolver caches so the freshly-installed
		// pack (and its `memory` provider) is resolvable by the runtime routes.
		await setPackActivation(ALL_ENABLED);
	});

	test.afterAll(async () => {
		const mod = await import("../../dist/server/server.js");
		mod.registerPackRuntimeSupervisorFactory(null);
		seedConfig(bobbitDir, null);
		const packDir = path.join(bobbitDir, ".bobbit", "config", "market-packs", PACK_NAME);
		fs.rmSync(packDir, { recursive: true, force: true });
	});

	test.beforeEach(() => { calls.length = 0; });

	test("the Hindsight pack + memory provider resolve for the runtime routes", async () => {
		const res = await apiFetch("/api/ext/contributions");
		expect(res.status).toBe(200);
		const data = await res.json();
		const pack = (data.packs as Array<{ packId: string; packName: string }>).find((p) => p.packName === PACK_NAME);
		expect(pack, "hindsight pack is registered after install").toBeTruthy();
		expect(pack!.packId).toBe(PACK_ID);
	});

	test("managed mode → managed-postgres + llmApiKey remapped to HINDSIGHT_API_LLM_API_KEY", async () => {
		await seedAndRefresh(bobbitDir, {
			mode: "managed",
			llmApiKey: "sk-managed-key",
			dataDir: "/tmp/hs-data",
			bank: "bobbit",
		});
		const res = await apiFetch(`/api/pack-runtimes/${RUNTIME_API_ID}/start`, { method: "POST" });
		expect(res.status, await res.text().catch(() => "")).toBe(200);
		const startCall = calls.find((c) => c.op === "start");
		expect(startCall, "route forwarded a start to the supervisor").toBeTruthy();
		// Deployment "managed" maps to the runtime manifest mode.
		expect(startCall!.opts?.mode).toBe("managed-postgres");
		// The provider's llmApiKey is remapped onto the manifest env key.
		expect(startCall!.opts?.config?.HINDSIGHT_API_LLM_API_KEY).toBe("sk-managed-key");
		// The raw deployment fields are still carried in the overlay (placeholder vars).
		expect(startCall!.opts?.config?.llmApiKey).toBe("sk-managed-key");
		expect(startCall!.opts?.config?.dataDir).toBe("/tmp/hs-data");
	});

	test("managed-external-postgres → external-postgres + externalDatabaseUrl remapped to HINDSIGHT_API_DATABASE_URL", async () => {
		await seedAndRefresh(bobbitDir, {
			mode: "managed-external-postgres",
			llmApiKey: "sk-extpg-key",
			externalDatabaseUrl: "postgresql://u:p@db.example:5432/hindsight",
			bank: "bobbit",
		});
		const res = await apiFetch(`/api/pack-runtimes/${RUNTIME_API_ID}/restart`, { method: "POST" });
		expect(res.status, await res.text().catch(() => "")).toBe(200);
		const call = calls.find((c) => c.op === "restart");
		expect(call, "route forwarded a restart to the supervisor").toBeTruthy();
		expect(call!.opts?.mode).toBe("external-postgres");
		expect(call!.opts?.config?.HINDSIGHT_API_DATABASE_URL).toBe("postgresql://u:p@db.example:5432/hindsight");
		expect(call!.opts?.config?.HINDSIGHT_API_LLM_API_KEY).toBe("sk-extpg-key");
	});

	test("an explicit body mode overrides the deployment-derived mode (config still remapped)", async () => {
		await seedAndRefresh(bobbitDir, { mode: "managed", llmApiKey: "sk-override", bank: "bobbit" });
		const res = await apiFetch(`/api/pack-runtimes/${RUNTIME_API_ID}/start`, {
			method: "POST",
			body: JSON.stringify({ mode: "external-postgres" }),
		});
		expect(res.status).toBe(200);
		const startCall = calls.find((c) => c.op === "start");
		// Explicit body mode wins over the plan's mapped managed-postgres.
		expect(startCall!.opts?.mode).toBe("external-postgres");
		// The deployment config remap is still applied regardless of the explicit mode.
		expect(startCall!.opts?.config?.HINDSIGHT_API_LLM_API_KEY).toBe("sk-override");
	});

	test("saved EXTERNAL mode + no explicit body mode → 409, never starts Docker", async () => {
		await seedAndRefresh(bobbitDir, { mode: "external", externalUrl: "http://localhost:9177", bank: "hermes" });
		const res = await apiFetch(`/api/pack-runtimes/${RUNTIME_API_ID}/start`, { method: "POST" });
		const body = await res.json().catch(() => ({}));
		expect(res.status, JSON.stringify(body)).toBe(409);
		expect(body.mode).toBe("external");
		expect(body.started).toBe(false);
		// The supervisor must NOT have been asked to start anything.
		expect(calls.find((c) => c.op === "start"), "external mode must not start Docker").toBeFalsy();
	});

	test("saved EXTERNAL mode + restart with no explicit body mode → 409, never restarts Docker", async () => {
		await seedAndRefresh(bobbitDir, { mode: "external", externalUrl: "http://localhost:9177", bank: "hermes" });
		const res = await apiFetch(`/api/pack-runtimes/${RUNTIME_API_ID}/restart`, { method: "POST" });
		const body = await res.json().catch(() => ({}));
		expect(res.status, JSON.stringify(body)).toBe(409);
		expect(calls.find((c) => c.op === "restart"), "external mode must not restart Docker").toBeFalsy();
	});

	test("saved EXTERNAL mode + explicit managed body mode → starts the requested managed stack", async () => {
		await seedAndRefresh(bobbitDir, { mode: "external", externalUrl: "http://localhost:9177", llmApiKey: "sk-explicit", bank: "bobbit" });
		const res = await apiFetch(`/api/pack-runtimes/${RUNTIME_API_ID}/start`, {
			method: "POST",
			body: JSON.stringify({ mode: "managed-postgres" }),
		});
		expect(res.status, await res.text().catch(() => "")).toBe(200);
		const startCall = calls.find((c) => c.op === "start");
		expect(startCall, "an explicit managed body mode overrides the external saved plan").toBeTruthy();
		expect(startCall!.opts?.mode).toBe("managed-postgres");
		expect(startCall!.opts?.config?.HINDSIGHT_API_LLM_API_KEY).toBe("sk-explicit");
	});
});
