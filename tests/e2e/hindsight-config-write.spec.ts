/**
 * API E2E — sessionless built-in pack-route CONFIG WRITE seam
 * (`POST /api/ext/pack-route/:packId/config`).
 *
 * The Marketplace Configure button writes Hindsight config inline from `#/market`,
 * where there is NO active chat session to mint a surface token. This seam is the
 * GET seam's config-write sibling: admin-bearer + BUILT-IN pack only, ALLOWLISTED to
 * the `config` route name. It validates + persists to the pack store and NEVER starts
 * Docker. This spec pins:
 *
 *   1. POST config to the built-in `hindsight` pack persists, and a subsequent GET
 *      reflects the saved values (round-trip through the real route + pack store).
 *   2. POST to a NON-config route name (e.g. `status`) is rejected 403 (not a general
 *      write seam).
 *   3. CONFIG_INVALID — an invalid override returns the route's structured error.
 *
 * Runs against the BUILT-IN band (the seam restricts writes to built-in first-party
 * packs), so it gates on the Hindsight contribution being served in this environment
 * and skips cleanly otherwise.
 */
import { test as base, expect } from "./in-process-harness.js";
import { apiFetch, defaultProjectId } from "./e2e-setup.js";

const test = base;

const PACK = "hindsight";
const CONFIG_KEY = "provider-config:memory";
const PROJECT_CONFIG_PREFIX = "provider-config:memory:project:";

interface ContribMeta { packId: string; routeNames?: string[] }

/** Whether the BUILT-IN Hindsight pack is served with its `config` route in this
 *  environment (dist not rebuilt / branches not merged ⇒ skip). */
async function hindsightConfigRouteReady(): Promise<boolean> {
	const res = await apiFetch("/api/ext/contributions");
	if (!res.ok) return false;
	const packs = ((await res.json()).packs ?? []) as ContribMeta[];
	const meta = packs.find((p) => p.packId === PACK);
	return !!meta && !!meta.routeNames?.includes("config");
}

/** Reset the built-in pack's persisted config so writes here never leak into sibling
 *  specs sharing the worker-scoped in-process gateway. */
async function resetConfig(): Promise<void> {
	const { getPackStore } = await import("../../dist/server/extension-host/pack-store.js");
	const store = getPackStore();
	await store.put(PACK, CONFIG_KEY, {});
	// Clear any per-project overlay for the default project so writes here never leak.
	try {
		const pid = await defaultProjectId();
		if (pid) await store.put(PACK, `${PROJECT_CONFIG_PREFIX}${pid}`, {});
	} catch {
		/* best-effort */
	}
}

test.describe.configure({ mode: "serial" });

test.describe("Hindsight built-in pack-route config write seam", () => {
	let ready = false;

	test.beforeAll(async () => {
		ready = await hindsightConfigRouteReady();
	});

	test.afterEach(async () => {
		if (ready) await resetConfig();
	});

	test("POST config persists and a subsequent GET reflects the saved values", async () => {
		test.skip(!ready, "Hindsight built-in config route not served in this environment");

		const overrides = {
			mode: "external",
			externalUrl: "http://localhost:9177",
			uiUrl: "http://localhost:19177/banks/bobbit?view=data",
			bank: "e2e-write-bank",
			namespace: "default",
		};
		const writeRes = await apiFetch(`/api/ext/pack-route/${PACK}/config`, {
			method: "POST",
			body: JSON.stringify(overrides),
		});
		expect(writeRes.status).toBe(200);
		const written = await writeRes.json();
		expect(written.ok).toBe(true);
		expect(written.configured).toBe(true);
		expect(written.config.externalUrl).toBe(overrides.externalUrl);
		expect(written.config.uiUrl).toBe(overrides.uiUrl);
		expect(written.config.bank).toBe(overrides.bank);

		// A fresh GET over the same seam reflects the persisted values.
		const readRes = await apiFetch(`/api/ext/pack-route/${PACK}/config`);
		expect(readRes.status).toBe(200);
		const read = await readRes.json();
		expect(read.config.externalUrl).toBe(overrides.externalUrl);
		expect(read.config.uiUrl).toBe(overrides.uiUrl);
		expect(read.config.bank).toBe(overrides.bank);
	});

	test("a partial write merges over stored config (does not clobber untouched fields)", async () => {
		test.skip(!ready, "Hindsight built-in config route not served in this environment");

		await apiFetch(`/api/ext/pack-route/${PACK}/config`, {
			method: "POST",
			body: JSON.stringify({ mode: "external", externalUrl: "http://localhost:9177", bank: "keep-me" }),
		});
		// A second write touching only uiUrl must preserve the stored bank/externalUrl.
		const res = await apiFetch(`/api/ext/pack-route/${PACK}/config`, {
			method: "POST",
			body: JSON.stringify({ uiUrl: "http://localhost:19177/banks/keep-me" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.config.bank).toBe("keep-me");
		expect(body.config.externalUrl).toBe("http://localhost:9177");
		expect(body.config.uiUrl).toBe("http://localhost:19177/banks/keep-me");
	});

	test("POST to a NON-config route name is rejected 403 (not a general write seam)", async () => {
		test.skip(!ready, "Hindsight built-in config route not served in this environment");

		const res = await apiFetch(`/api/ext/pack-route/${PACK}/status`, {
			method: "POST",
			body: JSON.stringify({ anything: true }),
		});
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(String(body.error)).toMatch(/config/i);

		// And the read seam for that same route name still works as a GET.
		const getRes = await apiFetch(`/api/ext/pack-route/${PACK}/status`);
		expect(getRes.status).toBe(200);
	});

	test("new memory-quality config fields round-trip (defaults + tagsMatch/retainEveryNTurns)", async () => {
		test.skip(!ready, "Hindsight built-in config route not served in this environment");

		// GET reflects the new cost-conscious defaults before any write.
		const def = await (await apiFetch(`/api/ext/pack-route/${PACK}/config`)).json();
		expect(def.config.recallScope).toBe("project");
		expect(def.config.tagsMatch).toBe("any");
		expect(def.config.retainEveryNTurns).toBe(5);

		const writeRes = await apiFetch(`/api/ext/pack-route/${PACK}/config`, {
			method: "POST",
			body: JSON.stringify({
				mode: "external",
				externalUrl: "http://localhost:9177",
				tagsMatch: "any_strict",
				retainEveryNTurns: 3,
				recallScope: "all",
			}),
		});
		expect(writeRes.status).toBe(200);
		const w = await writeRes.json();
		expect(w.config.tagsMatch).toBe("any_strict");
		expect(w.config.retainEveryNTurns).toBe(3);
		expect(w.config.recallScope).toBe("all");
	});

	test("a per-project override resolves over the global config with correct precedence (no Docker)", async () => {
		test.skip(!ready, "Hindsight built-in config route not served in this environment");

		const projectId = (await defaultProjectId())!;
		// Global: scope all, bank global-bank.
		await apiFetch(`/api/ext/pack-route/${PACK}/config`, {
			method: "POST",
			body: JSON.stringify({ mode: "external", externalUrl: "http://localhost:9177", recallScope: "all", bank: "global-bank" }),
		});
		// Per-project overlay: scope project, bank proj-bank (sessionless seam + ?projectId).
		const setRes = await apiFetch(`/api/ext/pack-route/${PACK}/config?projectId=${encodeURIComponent(projectId)}`, {
			method: "POST",
			body: JSON.stringify({ projectOverride: { recallScope: "project", bank: "proj-bank" } }),
		});
		expect(setRes.status).toBe(200);
		const setBody = await setRes.json();
		expect(setBody.ok).toBe(true);
		expect(setBody.config.recallScope).toBe("project");
		expect(setBody.config.bank).toBe("proj-bank");
		expect(setBody.projectOverride).toEqual({ recallScope: "project", bank: "proj-bank" });
		expect(setBody.globalConfig.recallScope).toBe("all");
		expect(setBody.globalConfig.bank).toBe("global-bank");

		// GET with the project reflects the overlay; GET without it shows the global.
		const withProj = await (await apiFetch(`/api/ext/pack-route/${PACK}/config?projectId=${encodeURIComponent(projectId)}`)).json();
		expect(withProj.config.bank).toBe("proj-bank");
		expect(withProj.config.recallScope).toBe("project");
		const noProj = await (await apiFetch(`/api/ext/pack-route/${PACK}/config`)).json();
		expect(noProj.config.bank).toBe("global-bank");
		expect(noProj.config.recallScope).toBe("all");
	});

	test("an invalid override returns the route's CONFIG_INVALID structured error", async () => {
		test.skip(!ready, "Hindsight built-in config route not served in this environment");

		const res = await apiFetch(`/api/ext/pack-route/${PACK}/config`, {
			method: "POST",
			body: JSON.stringify({ mode: "not-a-mode" }),
		});
		// The route handles the validation failure (200) and returns a structured error
		// body rather than throwing — the seam passes the body through unchanged.
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(false);
		expect(body.error).toBe("CONFIG_INVALID");
		expect(Array.isArray(body.errors)).toBe(true);
	});
});
