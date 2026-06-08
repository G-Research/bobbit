/**
 * Browser E2E — Extension Host Phase 1 litmus (design
 * docs/design/extension-host.md §8.2). Proves END-TO-END behavioral parity for
 * an interactive built-in re-expressed as a market pack using ONLY Phase-1
 * `toolRenderers` + `actions` + the Phase-1 Host API:
 *
 *   1. Install the `retry-demo` pack (local-dir source) at SERVER scope →
 *      /api/tools lists `sample_action` with rendererKind:"pack".
 *   2. A live session whose transcript contains a `sample_action` tool call
 *      renders with the PACK renderer (the Retry button; placeholder→real) —
 *      and NO action POST fires before any click (security control §5 v).
 *   3. Click Retry → an action POST happens → the renderer's OWN DOM updates
 *      from the handler result (the `pack-result` element shows the handler's
 *      `message`), proving renderer-local state propagation (§4a).
 *   4. Reload → the pack renderer still loads (registration re-driven from
 *      /api/tools metadata — survives reload).
 *   5. Uninstall → /api/tools drops `sample_action`; the client reconcile
 *      (registerPackRenderers re-driven, as a marketplace mutation does) removes
 *      the PACK renderer from the LIVE UI (Retry button gone) WITHOUT a reload
 *      (Issue B — uninstall reconciliation, design §4a); a subsequent action
 *      POST → 404.
 *
 * WHY SERVER SCOPE: the action endpoint + renderer endpoint + GET /api/tools
 * (no projectId) resolve through the gateway's server-level ToolManager, which
 * sees server + global-user market packs only (server.ts:970). A project-scope
 * install would be invisible to those endpoints. afterEach uninstalls + clears
 * sources so the server-scope pack never leaks into sibling specs on the worker.
 *
 * Pattern: mirrors tests/e2e/ui/ask-user-choices-ui.spec.ts (drive a real
 * session whose mock-agent turn emits a tool call that renders a custom inline
 * widget, asserting on its DOM + reload restore).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * History: the litmus initially exposed two Wave 1/2 integration bugs (resolving
 * a provider-less pack tool; the action-result repaint via host.requestRender())
 * — both fixed in Wave 4, so this spec is GREEN. Wave 5 added the §4a uninstall-
 * reconciliation assertion (Issue B): an uninstall must drop the pack renderer
 * from the running UI without a reload.
 * ───────────────────────────────────────────────────────────────────────────
 */
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { test, expect, type GatewayInfo } from "../gateway-harness.js";
import { apiFetch, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

// Within-file serial: a single end-to-end lifecycle test, but be explicit so a
// failed run can never leak a half-installed server-scope pack into a retry.
test.describe.configure({ mode: "serial" });

// Absolute path to the retry-demo local-dir marketplace SOURCE (a directory
// whose `retry-demo/` subdir is the pack — a dir is a pack iff it has pack.yaml).
const SOURCE_DIR = fileURLToPath(
	new URL("../../fixtures/market-sources/retry-demo-src", import.meta.url),
);

const PACK = "retry-demo";
const TOOL = "sample_action";
const STABLE_TOOL_USE_ID = "tu-sample-1"; // must match mock-agent-core.mjs SAMPLE_ACTION_TOOL

/** Register the local-dir source and install the pack at SERVER scope. */
async function installRetryDemo(): Promise<void> {
	const addRes = await apiFetch("/api/marketplace/sources", {
		method: "POST",
		body: JSON.stringify({ url: SOURCE_DIR }),
	});
	// Read the body exactly once: on success we need source.id; on failure we
	// surface the body text. Reading twice throws "Body has already been read".
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
async function listToolNames(): Promise<Array<{ name: string; rendererKind?: string; hasActions?: boolean; actionNames?: string[] }>> {
	const res = await apiFetch("/api/tools");
	expect(res.ok).toBe(true);
	return (await res.json()).tools as Array<{ name: string; rendererKind?: string; hasActions?: boolean; actionNames?: string[] }>;
}

test.afterEach(async () => {
	await cleanup();
});

test.describe("Extension Host Phase 1 — litmus (full-stack UI)", () => {
	test("install pack → PACK renderer + Retry action round-trip → survives reload → uninstall removes it", async ({ page, gateway }) => {
		// ── Step 1: install at server scope, BEFORE opening the app so the
		// cold-load registerPackRenderers() bootstrap sees the pack. ──
		await installRetryDemo();

		// ── Step 2: /api/tools lists sample_action with rendererKind:"pack". ──
		const tools = await listToolNames();
		const meta = tools.find((t) => t.name === TOOL);
		expect(meta, "sample_action must be listed after install").toBeTruthy();
		expect(meta?.rendererKind).toBe("pack");
		expect(meta?.hasActions).toBe(true);
		expect(meta?.actionNames).toEqual(["retry"]);

		// Count POSTs to the action endpoint so we can prove control §5 v (the
		// renderer must NOT auto-invoke on render — only on a user click).
		const actionPostUrls: string[] = [];
		const isRetryPost = (r: { url(): string; method(): string }) =>
			r.method() === "POST" && /\/api\/tools\/sample_action\/actions\/retry\b/.test(r.url());
		page.on("request", (r) => { if (isRetryPost(r)) actionPostUrls.push(r.url()); });

		await openApp(page);

		// ── Drive a real session whose mock turn emits a `sample_action` tool
		// call (stable tool_use id). It renders through the live Messages.ts
		// pipeline with a real ctx.host = getHostApi(sessionId, toolUseId). ──
		await createSessionViaUI(page);
		await sendMessage(page, "SAMPLE_ACTION_TOOL please");

		// The PACK renderer mounts (lazy: placeholder → Blob-imported real
		// renderer). Asserting the Retry button proves the pack renderer won.
		const retry = page.locator('[data-testid="pack-retry"]').first();
		await expect(retry).toBeVisible({ timeout: 25_000 });

		// Control §5 v: no action POST fired before any user gesture.
		expect(actionPostUrls, "renderer must NOT auto-invoke the action on render").toHaveLength(0);
		await expect(page.locator('[data-testid="pack-result"]')).toHaveCount(0);

		// Resolve the live session id (bound into the renderer's ctx.host).
		const sid = await page.evaluate(() => (window as any).__bobbitState?.selectedSessionId as string | null);
		expect(sid, "a session must be selected").toBeTruthy();
		await waitForSessionStatus(sid!, "idle").catch(() => { /* best-effort */ });

		// Make the action endpoint's toolUseId-ownership check (§5 iii)
		// deterministic: write a transcript line whose tool_use id + name match
		// what the renderer will send. The mock's get_state may also persist the
		// same stable-id tool call; either source satisfies transcriptHasToolUse.
		await seedTranscriptToolUse(gateway, sid!);

		// ── Step 3: click Retry → an action POST happens → the renderer's OWN
		// DOM updates from the handler result (pack-result shows "retried"). ──
		const respPromise = page.waitForResponse(
			(r) => /\/api\/tools\/sample_action\/actions\/retry\b/.test(r.url()) && r.request().method() === "POST",
			{ timeout: 15_000 },
		);
		await retry.click();
		const resp = await respPromise;
		expect(resp.status(), `action POST failed: ${await resp.text().catch(() => "")}`).toBe(200);
		expect(actionPostUrls.length).toBeGreaterThan(0);

		const result = page.locator('[data-testid="pack-result"]').first();
		await expect(result).toBeVisible({ timeout: 10_000 });
		await expect(result).toHaveText("retried");

		// ── Step 4: reload → the pack renderer still loads (registration
		// re-driven from /api/tools metadata; the session transcript re-renders
		// the sample_action block). ──
		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
		await expect(page.locator('[data-testid="pack-retry"]').first()).toBeVisible({ timeout: 25_000 });

		// ── Step 5: uninstall → /api/tools drops sample_action. ──
		const delRes = await apiFetch("/api/marketplace/installed", {
			method: "DELETE",
			body: JSON.stringify({ scope: "server", packName: PACK }),
		});
		expect(delRes.status).toBe(204);

		const afterTools = await listToolNames();
		expect(afterTools.find((t) => t.name === TOOL), "sample_action must be gone after uninstall").toBeFalsy();

		// Issue B (design §4a): re-drive the client reconcile exactly as a
		// marketplace install/uninstall does (registerPackRenderers from a fresh
		// /api/tools). The pack renderer must be torn down from the LIVE UI — the
		// Retry button disappears WITHOUT a page reload (the tool block falls back
		// to default rendering since no built-in shadowed it). The reconcile is
		// idempotent, so poll-driving it (and swallowing any transient navigation
		// from the out-of-band uninstall's WS broadcast) keeps the assertion
		// deterministic.
		await expect
			.poll(async () => {
				await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers()).catch(() => { /* navigation race */ });
				return page.locator('[data-testid="pack-retry"]').count();
			}, { timeout: 15_000 })
			.toBe(0);
		await expect(page.locator('[data-testid="pack-result"]')).toHaveCount(0);

		const postAfter = await apiFetch(`/api/tools/${TOOL}/actions/retry`, {
			method: "POST",
			headers: { "x-bobbit-session-id": sid! },
			body: JSON.stringify({ sessionId: sid, toolUseId: STABLE_TOOL_USE_ID, args: {} }),
		});
		expect(postAfter.status, "action endpoint must 404 once the pack is uninstalled").toBe(404);
	});
});

/**
 * Append a transcript line (Anthropic tool_use shape) to the session's
 * persisted `.jsonl` so the action endpoint's toolUseId-ownership scan
 * (action-guard.ts::transcriptHasToolUse) finds the renderer's tool_use id.
 * Polls until persistSessionMetadata has recorded `agentSessionFile`.
 */
async function seedTranscriptToolUse(gateway: GatewayInfo, sid: string): Promise<void> {
	let file: string | undefined;
	// Event-driven poll (no inline sleep — see tests/e2e/test-utils/no-new-sleeps.mjs):
	// persistSessionMetadata records agentSessionFile shortly after session setup.
	await expect
		.poll(() => {
			file = gateway.sessionManager?.getPersistedSession(sid)?.agentSessionFile as string | undefined;
			return file ?? null;
		}, { timeout: 10_000 })
		.not.toBeNull();
	const line = JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "tool_use", id: STABLE_TOOL_USE_ID, name: TOOL, input: {} }],
		},
	});
	// Leading newline guarantees separation from any partial trailing line.
	fs.appendFileSync(file!, `\n${line}\n`);
}
