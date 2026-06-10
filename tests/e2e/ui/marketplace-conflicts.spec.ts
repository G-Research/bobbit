/**
 * E2E (gateway-harness, API-level) — marketplace INSTALL + REGISTRY surfacing of
 * pack-contribution conflicts and orphan/UI-only packs (built-in-first-party-packs
 * design §10, item-0 #734 fixture cleanup).
 *
 * These assertions cover the layer the loader UNIT tests (tests/pack-contributions.test.ts,
 * which drive loadPackContributions over inline temp dirs) CANNOT: the live
 * marketplace install ledger + the PackContributionRegistry as surfaced by
 * GET /api/ext/contributions. Install and registration are two distinct layers —
 * a pack can install (its files land in the ledger) yet be DROPPED at registration
 * (the registry rejects it / filters its surfaces) — and only an install+registry
 * test pins that boundary.
 *
 * FIXTURE DECISION (design §10 step 2): we KEEP all six orphaned fixture dirs
 * (`conflict-dup-routeid-src`, `no-tools-pack-src`, `panel-only-src`,
 * `conflict-dup-route-name-src`, `conflict-dup-panel-id-src`,
 * `conflict-dup-entrypoint-id-src`) and wire EACH into an install-level assertion
 * here, rather than deleting the three within-pack-conflict dirs. Rationale: the
 * install + registry-surfacing path is a genuinely distinct layer from the loader
 * unit tests — we assert that a within-pack hard conflict still INSTALLS (201) but
 * is DROPPED from /api/ext/contributions (registration rejected, loud server-log
 * error), which the loader-level unit tests do not observe.
 *
 * Covered:
 *   1. `conflict-dup-routeid-src` — two packs claim the same host-global `routeId`
 *      ("shared-deeplink"): install BOTH, register NEITHER deep-link (the route
 *      entrypoints are filtered cross-pack; both packs' panels still register).
 *   2. `no-tools-pack-src` — an ORPHAN/UI-only pack (contents.tools:[]) installs and
 *      its panel + BOTH entrypoints (composer-slash launcher + kind:route deep-link)
 *      + pack-level route ("ping") all register (pack-bound surface auth, no tool in
 *      allowedTools).
 *   3. `panel-only-src` — a pack contributing ONLY one auto-discovered panel, with an
 *      all-empty `contents`, installs + registers (panels are auto-discovered, never
 *      listed in contents).
 *   4. within-pack HARD CONFLICTS (`conflict-dup-route-name-src`,
 *      `conflict-dup-panel-id-src`, `conflict-dup-entrypoint-id-src`) — each installs
 *      (201) but is DROPPED from registration (absent from /api/ext/contributions).
 *
 * WHY SERVER SCOPE: GET /api/ext/contributions (no projectId) resolves through the
 * gateway's server-level registry, which sees server + global-user packs only.
 * afterEach uninstalls every installed pack + clears every registered source so a
 * server-scope pack never leaks into a sibling spec on the worker.
 *
 * Pattern: mirrors the install harness in tests/e2e/ui/extension-host.spec.ts and
 * artifacts-pack.spec.ts (register a local-dir source, install named packs at server
 * scope), but asserts at the REST layer — no browser UI surface is required because
 * the behaviour under test is install + server-side registration.
 */
import { fileURLToPath } from "node:url";
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";

// Within-file serial: each test installs server-scope packs; serialise so a failed
// run can never leak a half-installed server-scope pack into a sibling test.
test.describe.configure({ mode: "serial" });

/** Absolute path to a `*-src/` local-dir marketplace SOURCE under tests/fixtures. */
const sourceDir = (name: string): string =>
	fileURLToPath(new URL(`../../fixtures/market-sources/${name}`, import.meta.url));

interface PackContributionsMeta {
	packId: string;
	packName: string;
	panels: { id: string; title?: string }[];
	entrypoints: Array<{ id: string; kind: string; routeId?: string; paramKeys?: string[]; label?: string; listName: string }>;
	routeNames: string[];
}

/** Register a local-dir source; returns its server-assigned source id. */
async function addSource(dir: string): Promise<string> {
	const res = await apiFetch("/api/marketplace/sources", {
		method: "POST",
		body: JSON.stringify({ url: dir }),
	});
	const body = await res.text();
	expect(res.status, body).toBe(201);
	return (JSON.parse(body) as { source: { id: string } }).source.id;
}

/** Install a named pack (physical subdir) at SERVER scope; asserts 201. */
async function installPack(sourceId: string, dirName: string): Promise<void> {
	const res = await apiFetch("/api/marketplace/install", {
		method: "POST",
		body: JSON.stringify({ sourceId, dirName, scope: "server" }),
	});
	const body = await res.text();
	expect(res.status, `install ${dirName} failed: ${body}`).toBe(201);
}

/** Server-scope pack-contribution metadata (panels/entrypoints/routes). */
async function listContributions(): Promise<PackContributionsMeta[]> {
	const res = await apiFetch("/api/ext/contributions");
	expect(res.ok).toBe(true);
	return (await res.json()).packs as PackContributionsMeta[];
}

/** Uninstall every installed pack + clear every registered source (afterEach hygiene). */
async function cleanup(): Promise<void> {
	try {
		const res = await apiFetch("/api/marketplace/installed");
		const installed = ((await res.json()).installed ?? []) as Array<{ packName?: string; name?: string; scope?: string }>;
		for (const p of installed) {
			const packName = p.packName ?? p.name;
			if (!packName) continue;
			await apiFetch("/api/marketplace/installed", {
				method: "DELETE",
				body: JSON.stringify({ scope: p.scope ?? "server", packName }),
			}).catch(() => {});
		}
	} catch { /* ignore */ }
	try {
		const res = await apiFetch("/api/marketplace/sources");
		for (const s of ((await res.json()).sources ?? []) as Array<{ id: string }>) {
			await apiFetch(`/api/marketplace/sources/${encodeURIComponent(s.id)}`, { method: "DELETE" }).catch(() => {});
		}
	} catch { /* ignore */ }
}

test.afterEach(async () => {
	await cleanup();
});

test.describe("Marketplace — install + registry surfacing of conflicts / orphan packs", () => {
	test("cross-pack duplicate routeId → install BOTH, register NEITHER deep-link (panels still register)", async () => {
		const src = await addSource(sourceDir("conflict-dup-routeid-src"));
		await installPack(src, "dup-routeid-a");
		await installPack(src, "dup-routeid-b");

		const packs = await listContributions();
		const a = packs.find((p) => p.packId === "dup-routeid-a");
		const b = packs.find((p) => p.packId === "dup-routeid-b");

		// Both packs INSTALL + register (their panels survive) — only the colliding
		// host-global route entrypoints are filtered.
		expect(a, "dup-routeid-a must register (panel survives)").toBeTruthy();
		expect(b, "dup-routeid-b must register (panel survives)").toBeTruthy();
		expect(a?.panels.map((p) => p.id)).toContain("dupa.viewer");
		expect(b?.panels.map((p) => p.id)).toContain("dupb.viewer");

		// register NEITHER deep-link: no surviving kind:"route" entrypoint claims the
		// conflicting host-global routeId "shared-deeplink" in EITHER pack.
		const allEntrypoints = [...(a?.entrypoints ?? []), ...(b?.entrypoints ?? [])];
		expect(
			allEntrypoints.filter((e) => e.kind === "route" && e.routeId === "shared-deeplink"),
			"the colliding shared-deeplink route entrypoint must be dropped from BOTH packs",
		).toHaveLength(0);
	});

	test("orphan no-tools pack installs → panel + both entrypoints + pack-level route register", async () => {
		const src = await addSource(sourceDir("no-tools-pack-src"));
		await installPack(src, "no-tools-pack");

		const packs = await listContributions();
		const pack = packs.find((p) => p.packId === "no-tools-pack");
		expect(pack, "the no-tools (orphan/UI-only) pack must register despite contents.tools:[]").toBeTruthy();

		// Auto-discovered panel.
		expect(pack?.panels.map((p) => p.id)).toContain("notools.viewer");

		// Both entrypoints register: the composer-slash launcher + the unique-routeId
		// deep-link (its routeId "notools" does not collide, so it is NOT filtered).
		const epIds = (pack?.entrypoints ?? []).map((e) => e.id);
		expect(epIds, "the composer-slash launcher entrypoint must register").toContain("notools.open");
		expect(epIds, "the kind:route deep-link entrypoint must register").toContain("notools.deeplink");
		const deeplink = pack?.entrypoints.find((e) => e.id === "notools.deeplink");
		expect(deeplink?.kind).toBe("route");
		expect(deeplink?.routeId).toBe("notools");
		expect(deeplink?.paramKeys).toContain("jobId");

		// Pack-level route allowlist registers.
		expect(pack?.routeNames, "the pack-level route 'ping' must register").toContain("ping");
	});

	test("panel-only pack installs → its single auto-discovered panel registers (empty contents)", async () => {
		const src = await addSource(sourceDir("panel-only-src"));
		await installPack(src, "panel-only");

		const packs = await listContributions();
		const pack = packs.find((p) => p.packId === "panel-only");
		expect(pack, "a panel-only pack with all-empty contents must still register its panel").toBeTruthy();
		expect(pack?.panels.map((p) => p.id)).toEqual(["panelonly.viewer"]);
		expect(pack?.entrypoints, "a panel-only pack contributes no entrypoints").toHaveLength(0);
		expect(pack?.routeNames, "a panel-only pack contributes no routes").toHaveLength(0);
	});

	// Built-in first-party pack (no install): disabling its entrypoints at SERVER
	// scope must drop them — INCLUDING the kind:"route" deep-link — from the
	// runtime /api/ext/contributions endpoint, while pack-level routes (support for
	// the surviving panel) stay. Pins the server-side activation-filter wiring for
	// the built-in band (built-in-first-party-packs §7): the client overlay/route
	// behaviour depends on this filtered set being correct.
	test("built-in pr-walkthrough: disabling entrypoints drops them + the route deep-link from /api/ext/contributions", async () => {
		const PACK = "pr-walkthrough";
		const LIST_NAMES = ["pr-walkthrough-open", "pr-walkthrough-git-widget", "pr-walkthrough-palette", "pr-walkthrough-route"];

		const before = (await listContributions()).find((p) => p.packId === PACK);
		expect(before, "the built-in pr-walkthrough pack must resolve with NO install").toBeTruthy();
		expect(
			(before?.entrypoints ?? []).some((e) => e.kind === "route" && e.routeId === PACK),
			"the kind:route deep-link must be present before disable",
		).toBe(true);

		const put = await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT",
			body: JSON.stringify({ scope: "server", packName: PACK, disabled: { entrypoints: LIST_NAMES } }),
		});
		expect(put.status, "server-scope activation PUT for the built-in pack must succeed").toBe(200);

		const after = (await listContributions()).find((p) => p.packId === PACK);
		expect(after, "the built-in pack row must still emit (panels/routes survive)").toBeTruthy();
		expect(after?.entrypoints ?? [], "all disabled entrypoints must be dropped").toHaveLength(0);
		expect(
			(after?.entrypoints ?? []).some((e) => e.kind === "route" && e.routeId === PACK),
			"the kind:route deep-link must be dropped on disable",
		).toBe(false);
		// Pack-level routes are support for the surviving panel — they are NOT
		// entrypoints, so they remain even when every entrypoint is disabled.
		expect(after?.routeNames, "pack-level routes survive entrypoint disable").toEqual(
			expect.arrayContaining(["bundle", "publish"]),
		);

		// Re-enable so the disabled server-scope activation never leaks to a sibling test.
		await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT",
			body: JSON.stringify({ scope: "server", packName: PACK, disabled: { entrypoints: [] } }),
		});
		const restored = (await listContributions()).find((p) => p.packId === PACK);
		expect((restored?.entrypoints ?? []).length, "re-enable restores the entrypoints").toBeGreaterThan(0);
	});

	test("within-pack hard conflicts install (201) but are DROPPED from registration", async () => {
		const cases: Array<{ src: string; dirName: string }> = [
			{ src: "conflict-dup-route-name-src", dirName: "dup-route-name" },
			{ src: "conflict-dup-panel-id-src", dirName: "dup-panel-id" },
			{ src: "conflict-dup-entrypoint-id-src", dirName: "dup-entrypoint-id" },
		];
		for (const c of cases) {
			const src = await addSource(sourceDir(c.src));
			await installPack(src, c.dirName); // install SUCCEEDS — files land in the ledger
		}

		// Registration REJECTS each within-pack hard conflict (loadPackContributions
		// throws PackContributionError → the registry drops the pack with a loud
		// server-log error), so none appear in /api/ext/contributions.
		const packs = await listContributions();
		const ids = new Set(packs.map((p) => p.packId));
		for (const c of cases) {
			expect(ids.has(c.dirName), `${c.dirName} (within-pack hard conflict) must be dropped from registration`).toBe(false);
		}
	});
});
