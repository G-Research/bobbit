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
import { apiFetch } from "./e2e-setup.js";

const test = base;

const PACK = "hindsight";
const CONFIG_KEY = "provider-config:memory";

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
	await getPackStore().put(PACK, CONFIG_KEY, {});
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
