/**
 * Unit tests for `reconcilePackSettingsSectionsForProject` +
 * `registerPackSettingsSections` + `renderPackSettingsSections` + the
 * `SettingsHostApi` (docs/design/pack-settings-contribution.md §4.2/§4.3/§4.6).
 * Pins the settings-section contribution kind's client registry — the
 * settings-section analogue of pack-panels-reconcile.spec.ts:
 *   - reconcile fetches /api/ext/contributions scoped to HEADQUARTERS (v1 is
 *     "system" scope ONLY — no project variance);
 *   - renderPackSettingsSections filters by `tab` and scopes each section under
 *     a `{packId}-{sectionId}` testid, not a bare id (§4.6's collision-safety
 *     requirement);
 *   - a registry change (uninstall / precedence change) drops the section from
 *     the NEXT render with NO reload — the entire "disappear live" mechanism;
 *   - `host.preferences.get/set` round-trips through `PUT /api/preferences`
 *     carrying the `x-bobbit-settings-section-token` header — never a raw,
 *     unmediated preference write.
 *
 * Pattern mirrors pack-panels-reconcile.spec.ts: esbuild bundles the entry
 * once, a file:// fixture loads it, and we drive the helpers via window
 * globals. `window.fetch` is stubbed to record request URLs + serve fake
 * contribution metadata, a fake settings-section module, and fake preferences.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const FIXTURE = path.resolve("tests/fixtures/pack-settings-sections.html");
const BUNDLE = path.resolve("tests/fixtures/pack-settings-sections-bundle.js");
const ENTRY = path.resolve("tests/fixtures/pack-settings-sections-entry.ts");
const PACK_SRC = path.resolve("src/app/pack-settings-sections.ts");

test.beforeAll(() => {
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: [ENTRY, PACK_SRC] });
});

const PAGE = `file://${FIXTURE}`;

async function gotoAndWait(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
}

test.describe("reconcilePackSettingsSectionsForProject + renderPackSettingsSections (§4.2/§4.6)", () => {
	test("reconcile fetches /api/ext/contributions scoped to HEADQUARTERS (system scope only)", async ({ page }) => {
		await gotoAndWait(page);
		const calls = await page.evaluate(async () => {
			(window as any).__clearCalls();
			await (window as any).__reconcile();
			return (window as any).__calls();
		});
		expect(calls.some((u: string) => /\/api\/ext\/contributions\?projectId=headquarters$/.test(u))).toBe(true);
	});

	test("a redundant reconcile is deduped — no re-fetch", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(async () => { await (window as any).__reconcile(); });
		const calls = await page.evaluate(async () => {
			(window as any).__clearCalls();
			await (window as any).__reconcile();
			return (window as any).__calls();
		});
		expect(calls.some((u: string) => u.includes("/api/ext/contributions"))).toBe(false);
	});

	test("renders the section under a {packId}-{sectionId} testid on its declared tab, and NOT on another tab", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(async () => { await (window as any).__reconcile(); });

		const generalHtml: string = await page.evaluate(() => (window as any).__renderStable("general"));
		expect(generalHtml).toContain('data-testid="pr-walkthrough-pr-walkthrough.trusted-hosts"');
		expect(generalHtml).toContain('data-testid="fake-section-body"');
		expect(generalHtml).toContain("ghe.example.com");

		const modelsHtml: string = await page.evaluate(() => (window as any).__renderStable("models"));
		expect(modelsHtml).not.toContain("pr-walkthrough-pr-walkthrough.trusted-hosts");
	});

	test("sorts by order then packId when two packs declare sections on the same tab", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(async () => {
			(window as any).__setContributions([
				{ packId: "pack_b", packName: "pack_b", panels: [], settingsSections: [{ id: "sec", tab: "general", order: 50 }], entrypoints: [], routeNames: [] },
				{ packId: "pack_a", packName: "pack_a", panels: [], settingsSections: [{ id: "sec", tab: "general", order: 50 }], entrypoints: [], routeNames: [] },
			]);
			await (window as any).__reconcile();
		});
		const html: string = await page.evaluate(() => (window as any).__renderStable("general"));
		// Same order (50) → tie-broken by packId ascending: pack_a before pack_b.
		expect(html.indexOf("pack_a-sec")).toBeGreaterThanOrEqual(0);
		expect(html.indexOf("pack_a-sec")).toBeLessThan(html.indexOf("pack_b-sec"));
	});

	test("uninstall reconcile drops the section from the registry — the NEXT render omits it live, no reload", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(async () => { await (window as any).__reconcile(); });

		const before: string = await page.evaluate(() => (window as any).__renderStable("general"));
		expect(before).toContain("pr-walkthrough-pr-walkthrough.trusted-hosts");

		// Uninstall: the fresh metadata declares no packs at all. `__register` with
		// `invalidateLoaded` is the marketplace-mutation force-reregister path
		// (mirrors `registerPackPanels(..., { invalidateLoaded: true })`).
		await page.evaluate(() => {
			(window as any).__setContributions([]);
			(window as any).__register({ invalidateLoaded: true });
		});

		const after: string = await page.evaluate(() => (window as any).__renderStable("general"));
		expect(after).not.toContain("pr-walkthrough-pr-walkthrough.trusted-hosts");
	});

	test("SettingsHostApi.preferences.set carries the pack surface-token header and round-trips via PUT /api/preferences", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(async () => { await (window as any).__reconcile(); });
		await page.evaluate(() => (window as any).__renderStable("general"));

		await page.evaluate(async () => {
			(window as any).__clearPutCalls();
			(window as any).__clearCalls();
			const btn = document.querySelector('[data-testid="fake-add"]') as HTMLButtonElement;
			btn.click();
			await (window as any).__flush();
		});

		const [putCalls, calls] = await page.evaluate(() => [(window as any).__putCalls(), (window as any).__calls()]);
		// The surface token is minted via the pack-addressed endpoint before the
		// write (mirrors host-api.ts's lazy getSurfaceToken()).
		expect(calls.some((u: string) => u.includes("/api/ext/packs/pr-walkthrough/settings-sections/pr-walkthrough.trusted-hosts/surface-token"))).toBe(true);
		expect(putCalls.length).toBeGreaterThan(0);
		const put = putCalls[putCalls.length - 1];
		expect(put.headers["x-bobbit-settings-section-token"]).toBe("fake-token");
		expect(put.body).toEqual({ githubTrustedHosts: ["added.example.com"] });

		// The authoritative GET readback updates the cache — the next render
		// reflects the server's (here, echoed) value.
		const after: string = await page.evaluate(() => (window as any).__renderStable("general"));
		expect(after).toContain("added.example.com");
	});
});
