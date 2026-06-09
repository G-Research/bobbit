/**
 * Browser E2E — Extension Host Phase-2 D2 litmus (the MAXIMAL case; design
 * docs/design/extension-host-phase2.md §11 + §13 "D2"). Proves END-TO-END
 * behavioral parity for the PR-walkthrough feature re-expressed as a market pack
 * using ALL reserved contribution keys + the durable Host API — panels + routes +
 * stores + entrypoints (launcher + kind:"route" deep-link) + host.session.readToolCall:
 *
 *   1. Install the `pr-walkthrough` pack (local-dir source) at SERVER scope →
 *      /api/tools lists `pr_walkthrough` (the contribution-bearing tool).
 *   2. A live session is created + its transcript seeded with a
 *      `submit_pr_walkthrough_yaml` tool call (the bespoke transcript surface the
 *      pack reads via host.session.readToolCall instead of internal access).
 *   3. ENTRYPOINT LAUNCH: running the `pr-walkthrough.open` composer-slash launcher
 *      (host.ui.navigate → #/ext/pr-walkthrough?jobId=… → the kind:"route" deep-link
 *      → host.ui.openPanel) mounts the viewer panel — and NO callRoute POST fires
 *      before the user's Load click (security control v1 §5 v: no auto-invoke on mount).
 *   4. PANEL RENDERS FROM THE PACK'S OWN callRoute + store: clicking Load issues
 *      host.callRoute("bundle", …) (POST /api/ext/route/bundle, tool=pr_walkthrough —
 *      NEVER a raw fetch) whose route module persists+reads the bundle via
 *      host.store.*, and host.session.readToolCall surfaces the submitted YAML.
 *   5. DEEP-LINK: a reload on #/ext/pr-walkthrough?jobId=… restores the panel
 *      (getRouteFromHash → lookupPackRoute → openPackPanel); reloading clears the
 *      in-memory panel cache, so the next Load re-reads the SAME persisted store
 *      record (stable persistedAt = store-rehydration parity proof).
 *   6. UNINSTALL: the client reconcile drops the pack's panel + deep-link route from
 *      the LIVE UI without a reload (panel torn down; the deep-link no longer resolves).
 *
 * WHY SERVER SCOPE: identical to tests/e2e/ui/extension-host.spec.ts — the
 * route/store/session/panel endpoints + GET /api/tools resolve through the server
 * ToolManager, which sees server + global-user market packs. afterEach uninstalls +
 * clears sources so the server-scope pack never leaks into sibling specs.
 *
 * Pattern: mirrors tests/e2e/ui/extension-host.spec.ts (drive a real session,
 * install a local-dir pack, assert pack-contributed surfaces, reload-restore, uninstall).
 */
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { test, expect, type GatewayInfo } from "../gateway-harness.js";
import { apiFetch, waitForSessionStatus, base, readE2ETokenAsync } from "../e2e-setup.js";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

// Within-file serial: a single end-to-end lifecycle test; be explicit so a failed
// run can never leak a half-installed server-scope pack into a retry.
test.describe.configure({ mode: "serial" });

// Absolute path to the local-dir marketplace SOURCE (its `pr-walkthrough/` subdir
// is the pack — a dir is a pack iff it has pack.yaml).
const SOURCE_DIR = fileURLToPath(
	new URL("../../fixtures/market-sources/pr-walkthrough-src", import.meta.url),
);

const PACK = "pr-walkthrough";
const TOOL = "pr_walkthrough";
const JOB_ID = "job-litmus-1";
const SUBMIT_TOOL = "submit_pr_walkthrough_yaml";
const SUBMIT_TOOL_USE_ID = "tu-prw-submit-1";
const SUBMIT_YAML = "walkthrough-yaml: v1\njob: job-litmus-1\ncards: 2";
const DEEP_LINK = `#/ext/${PACK}?jobId=${JOB_ID}`;

/** Register the local-dir source and install the pack at SERVER scope. */
async function installPack(): Promise<void> {
	const addRes = await apiFetch("/api/marketplace/sources", {
		method: "POST",
		body: JSON.stringify({ url: SOURCE_DIR }),
	});
	const addBody = await addRes.text();
	expect(addRes.status, addBody).toBe(201);
	const sourceId = (JSON.parse(addBody) as { source: { id: string } }).source.id;

	const instRes = await apiFetch("/api/marketplace/install", {
		method: "POST",
		body: JSON.stringify({ sourceId, dirName: PACK, scope: "server" }),
	});
	const instBody = await instRes.text();
	expect(instRes.status, instBody).toBe(201);
}

/** Uninstall the pack + clear every registered source (afterEach hygiene). */
async function cleanup(): Promise<void> {
	await apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: "server", packName: PACK }),
	}).catch(() => {});
	try {
		const res = await apiFetch("/api/marketplace/sources");
		for (const s of ((await res.json()).sources ?? []) as Array<{ id: string }>) {
			await apiFetch(`/api/marketplace/sources/${encodeURIComponent(s.id)}`, { method: "DELETE" }).catch(() => {});
		}
	} catch { /* ignore */ }
}

/** Fetch the server-scope tool list (no projectId → server ToolManager). */
async function listToolNames(): Promise<Array<{ name: string; rendererKind?: string }>> {
	const res = await apiFetch("/api/tools");
	expect(res.ok).toBe(true);
	return (await res.json()).tools as Array<{ name: string; rendererKind?: string }>;
}

/**
 * Append a `submit_pr_walkthrough_yaml` tool_use (+ matching tool_result) to the
 * session's persisted transcript so host.session.readToolCall(toolUseId) returns
 * the submitted YAML (mirrors extension-host.spec.ts::seedTranscriptToolUse).
 */
async function seedSubmitToolCall(gateway: GatewayInfo, sid: string): Promise<void> {
	let file: string | undefined;
	await expect
		.poll(() => {
			file = gateway.sessionManager?.getPersistedSession(sid)?.agentSessionFile as string | undefined;
			return file ?? null;
		}, { timeout: 10_000 })
		.not.toBeNull();
	const useLine = JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "tool_use", id: SUBMIT_TOOL_USE_ID, name: SUBMIT_TOOL, input: { yaml: SUBMIT_YAML } }],
		},
	});
	const resultLine = JSON.stringify({
		type: "message",
		message: {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: SUBMIT_TOOL_USE_ID, content: "published", is_error: false }],
		},
	});
	fs.appendFileSync(file!, `\n${useLine}\n${resultLine}\n`);
}

test.afterEach(async () => {
	await cleanup();
});

test.describe("Extension Host Phase 2 — D2 pr-walkthrough-as-pack (full-stack UI)", () => {
	test("install → entrypoint launches panel → renders from pack callRoute + store → deep-link reopens → uninstall reconciles", async ({ page, gateway }) => {
		// ── Step 1: install at server scope BEFORE opening the app so the cold-load
		// reconcile (renderers + panels + entrypoints) sees the pack. ──
		await installPack();

		const tools = await listToolNames();
		expect(tools.find((t) => t.name === TOOL), "pr_walkthrough must be listed after install").toBeTruthy();

		// Count POSTs to the pack's bundle route so we can prove control v1 §5 v
		// (the panel must NOT auto-invoke callRoute on mount — only on a user click).
		const bundlePosts: string[] = [];
		const isBundlePost = (r: { url(): string; method(): string }) =>
			r.method() === "POST" && /\/api\/ext\/route\/bundle\b/.test(r.url());
		page.on("request", (r) => { if (isBundlePost(r)) bundlePosts.push(r.url()); });

		await openApp(page);

		// Drive a real session; seed its transcript with the submit tool call.
		await createSessionViaUI(page);
		await sendMessage(page, "hello");
		const sid = await page.evaluate(() => (window as any).__bobbitState?.selectedSessionId as string | null);
		expect(sid, "a session must be selected").toBeTruthy();
		await waitForSessionStatus(sid!, "idle").catch(() => { /* best-effort */ });
		await seedSubmitToolCall(gateway, sid!);

		// Ensure the pack registries (panels + deep-link route + launchers) are
		// reconciled exactly as a marketplace mutation does (idempotent).
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers());

		// ── Step 3: ENTRYPOINT LAUNCH — run the composer-slash launcher (the same
		// runLauncherEntrypoint the slash menu calls on click). It navigates to the
		// kind:"route" deep-link, which opens the viewer panel. ──
		await page.evaluate(() => (window as any).__bobbitRunPackLauncher("pr-walkthrough.open"));

		// The deep-link hash was set by host.ui.navigate (pack never builds a URL).
		await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 })
			.toBe(DEEP_LINK);

		// The viewer panel mounts (Load button visible) — and NO bundle POST yet.
		await expect(page.locator('[data-testid="prw-panel-root"]').first()).toBeVisible({ timeout: 15_000 });
		const loadBtn = page.locator('[data-testid="prw-load"]').first();
		await expect(loadBtn).toBeVisible();
		expect(bundlePosts, "panel must NOT auto-invoke callRoute on mount").toHaveLength(0);
		await expect(page.locator('[data-testid="prw-bundle"]')).toHaveCount(0);

		// ── Step 4: LOAD → host.callRoute("bundle") (POST /api/ext/route/bundle) +
		// host.store.* + host.session.readToolCall → the panel renders. ──
		const bundleRespPromise = page.waitForResponse(
			(r) => /\/api\/ext\/route\/bundle\b/.test(r.url()) && r.request().method() === "POST",
			{ timeout: 15_000 },
		);
		await loadBtn.click();
		const bundleResp = await bundleRespPromise;
		expect(bundleResp.status(), `bundle callRoute failed: ${await bundleResp.text().catch(() => "")}`).toBe(200);
		expect(bundlePosts.length).toBeGreaterThan(0);

		// Renders the changeset + a diff-backed card from the pack's OWN route.
		await expect(page.locator('[data-testid="prw-title"]').first()).toContainText(JOB_ID, { timeout: 10_000 });
		await expect(page.locator('[data-testid="prw-diffblock"]').first()).toBeVisible();
		// readToolCall surfaced the submitted YAML (own-session, no owned toolUseId).
		await expect(page.locator('[data-testid="prw-toolcall"]').first()).toContainText("walkthrough-yaml");

		// Store-persistence proof: capture the persisted timestamp the route stamped once.
		const persistedAt1 = (await page.locator('[data-testid="prw-persisted-at"]').first().textContent())?.trim();
		expect(persistedAt1, "panel must render a persistedAt from the store-backed bundle").toBeTruthy();

		// ── Step 5: DEEP-LINK survives reload. Fully reload the app (the in-memory
		// panel cache + registries are rebuilt from scratch), reconnecting the session,
		// then navigate to the deep-link #/ext/pr-walkthrough?jobId=… . It resolves
		// through the rebuilt client pack-route registry (getRouteFromHash →
		// lookupPackRoute → openPackPanel) and the panel re-reads the SAME persisted
		// store record (no dependence on the pre-reload in-memory state). ──
		const token = await readE2ETokenAsync();
		await page.goto(`${base()}/?token=${encodeURIComponent(token)}#/session/${sid}`);
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
		// Navigate to the pack deep-link (the realistic "open this walkthrough" link).
		await page.evaluate((h) => { window.location.hash = h; }, DEEP_LINK);
		await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 }).toBe(DEEP_LINK);
		await expect(page.locator('[data-testid="prw-panel-root"]').first()).toBeVisible({ timeout: 20_000 });
		// Reload cleared the in-memory panel cache → Load button shown again (no auto-invoke).
		const loadBtn2 = page.locator('[data-testid="prw-load"]').first();
		await expect(loadBtn2).toBeVisible({ timeout: 20_000 });
		await loadBtn2.click();
		await expect(page.locator('[data-testid="prw-title"]').first()).toContainText(JOB_ID, { timeout: 10_000 });
		const persistedAt2 = (await page.locator('[data-testid="prw-persisted-at"]').first().textContent())?.trim();
		// SAME stored record after reload → store-rehydration parity (not re-synthesized).
		expect(persistedAt2, "deep-link must rehydrate the SAME persisted store record").toBe(persistedAt1);

		// ── Step 6: UNINSTALL → /api/tools drops pr_walkthrough; the client reconcile
		// tears the panel + deep-link route out of the LIVE UI without a reload. ──
		const delRes = await apiFetch("/api/marketplace/installed", {
			method: "DELETE",
			body: JSON.stringify({ scope: "server", packName: PACK }),
		});
		expect(delRes.status).toBe(204);

		const afterTools = await listToolNames();
		expect(afterTools.find((t) => t.name === TOOL), "pr_walkthrough must be gone after uninstall").toBeFalsy();

		// Re-drive the client reconcile (as a marketplace uninstall does): the pack
		// panel tab is removed and the deep-link route no longer resolves.
		await expect
			.poll(async () => {
				await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers()).catch(() => { /* navigation race */ });
				return page.locator('[data-testid="prw-panel-root"]').count();
			}, { timeout: 15_000 })
			.toBe(0);

		// The deep-link no longer resolves (owning pack uninstalled → lookupPackRoute
		// undefined → openPackPanel no-ops): navigating to it opens no panel.
		await page.evaluate((h) => { window.location.hash = h; }, DEEP_LINK);
		await expect(page.locator('[data-testid="prw-panel-root"]')).toHaveCount(0);
	});
});
