import type { Page } from "@playwright/test";
import { test, expect } from "../../e2e/gateway-harness.js";
import {
	apiFetch,
	createSession,
	deleteSession,
	waitForSessionStatus,
} from "../../e2e/e2e-setup.js";
import { navigateToHash, openApp } from "../fixtures/ui-helpers.js";

const MUTATING_TOOLS = ["write", "edit", "bash", "bash_bg"] as const;

async function spawnReadOnlyDelegate(gateway: any, ownerId: string): Promise<string> {
	const ownerSecret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(ownerId);
	const response = await apiFetch(`/api/sessions/${ownerId}/orchestrate/spawn`, {
		method: "POST",
		headers: { "X-Bobbit-Session-Secret": ownerSecret },
		body: JSON.stringify({
			instructions: "Stay available for a browser follow-up prompt, then answer briefly.",
			read_only: true,
		}),
	});
	const responseBody = await response.clone().text();
	expect(response.status, `read-only delegate spawn failed: ${responseBody}`).toBe(201);
	const body = await response.json() as { childSessionId?: string };
	expect(body.childSessionId).toEqual(expect.any(String));
	return body.childSessionId!;
}

async function expectActiveReadOnlyDelegate(page: Page, sessionId: string, phase: string): Promise<void> {
	await expect.poll(() => page.evaluate((id) => {
		const app = (window as any).bobbitState;
		const record = app?.gatewaySessions?.find((candidate: { id?: string }) => candidate.id === id);
		const ui = app?.chatPanel?.agentInterface;
		const presentationArchived = typeof ui?.archived === "boolean"
			? ui.archived
			: ui?.readOnly === true;
		return {
			selected: app?.selectedSessionId ?? null,
			capabilityReadOnly: record?.readOnly === true,
			lifecycleStatus: record?.status ?? null,
			presentationArchived,
			nonInteractive: ui?.nonInteractive === true,
		};
	}, sessionId), {
		timeout: 15_000,
		message: `${phase}: active read-only delegate must retain independent capability and lifecycle state`,
	}).toEqual({
		selected: sessionId,
		capabilityReadOnly: true,
		lifecycleStatus: "idle",
		presentationArchived: false,
		nonInteractive: false,
	});

	const composer = page.locator("agent-interface message-editor textarea").first();
	await expect(composer, `${phase}: active read-only delegate composer`).toBeVisible({ timeout: 15_000 });
	await expect(composer, `${phase}: active read-only delegate composer`).toBeEnabled();
	await expect(page.locator("agent-interface [data-continue-archived-footer]"), `${phase}: archive footer`).toHaveCount(0);
	await expect(page.locator("agent-interface streaming-message-container .bobbit-blob--archived"), `${phase}: archived sprite styling`).toHaveCount(0);
	await expect.poll(() => page.locator("agent-interface streaming-message-container").first().evaluate((element: any) => element.archived === true), {
		timeout: 5_000,
		message: `${phase}: streaming sprite must use live lifecycle presentation`,
	}).toBe(false);

	const row = page.locator(`[data-session-id="${sessionId}"][data-nav-active="true"]`).first();
	await expect(row, `${phase}: active delegate sidebar row`).toBeVisible({ timeout: 10_000 });
	const imageFilters = await row.locator("img").evaluateAll((images) => images.map((image) => getComputedStyle(image).filter));
	expect(imageFilters.join(" "), `${phase}: active delegate sidebar sprite must not be desaturated`).not.toContain("grayscale");
}

function expectMutatingToolsWithheld(gateway: any, sessionId: string, phase: string): void {
	const live = gateway.sessionManager.getSession(sessionId);
	const persisted = gateway.sessionManager.getPersistedSession(sessionId);
	expect(persisted?.readOnly, `${phase}: durable capability marker`).toBe(true);
	const liveTools: string[] = live?.allowedTools ?? [];
	const persistedTools: string[] = persisted?.allowedTools ?? [];
	for (const tool of MUTATING_TOOLS) {
		expect(liveTools, `${phase}: live read-only delegate must not expose ${tool}`).not.toContain(tool);
		expect(persistedTools, `${phase}: persisted read-only delegate must not expose ${tool}`).not.toContain(tool);
	}
}

test.describe("active read-only delegate interaction", () => {
	test("stays live and promptable through navigation, reload, reconnect, and authoritative refresh", async ({ page, gateway }) => {
		test.slow();
		const ownerId = await createSession();
		let delegateId: string | undefined;
		try {
			await waitForSessionStatus(ownerId, "idle");
			delegateId = await spawnReadOnlyDelegate(gateway, ownerId);
			await waitForSessionStatus(delegateId, "idle");
			expectMutatingToolsWithheld(gateway, delegateId, "spawn");

			await openApp(page);
			await navigateToHash(page, `#/session/${delegateId}`);
			await expectActiveReadOnlyDelegate(page, delegateId, "initial open");

			const followUp = `read-only delegate browser follow-up ${Date.now()}`;
			const composer = page.locator("agent-interface message-editor textarea").first();
			await composer.fill(followUp);
			await composer.press("Enter");
			await expect(page.getByText(followUp, { exact: true }).first(), "accepted follow-up should render in the transcript")
				.toBeVisible({ timeout: 10_000 });
			await waitForSessionStatus(delegateId, "idle");
			const transcript = await gateway.sessionManager.getSession(delegateId)?.rpcClient.getMessages();
			expect(JSON.stringify(transcript), "direct follow-up must reach the delegate transport, not only optimistic UI").toContain(followUp);

			// Cached-panel navigation is a distinct projection path.
			await navigateToHash(page, `#/session/${ownerId}`);
			await expect.poll(() => page.evaluate((id) => (window as any).bobbitState?.selectedSessionId === id, ownerId), { timeout: 15_000 }).toBe(true);
			await navigateToHash(page, `#/session/${delegateId}`);
			await expectActiveReadOnlyDelegate(page, delegateId, "cached navigation return");

			// A reload exercises cold list hydration and transcript restoration.
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
			await expectActiveReadOnlyDelegate(page, delegateId, "reload");
			await expect(page.getByText(followUp, { exact: true }).first(), "follow-up transcript should survive reload")
				.toBeVisible({ timeout: 15_000 });
			expectMutatingToolsWithheld(gateway, delegateId, "reload");

			// Force only the mounted session socket closed, then observe a new
			// authenticated connection epoch without navigating or reloading.
			const reconnectEpoch = await page.evaluate(() => {
				const remote = (window as any).bobbitState?.remoteAgent;
				const before = remote?._connectionEpoch ?? 0;
				remote?.ws?.close(4000, "read-only delegate reconnect fixture");
				return before;
			});
			await expect.poll(() => page.evaluate((before) => {
				const app = (window as any).bobbitState;
				return (app?.remoteAgent?._connectionEpoch ?? 0) > before
					&& app?.connectionStatus === "connected";
			}, reconnectEpoch), { timeout: 15_000, message: "delegate WebSocket should reconnect in place" }).toBe(true);
			await expectActiveReadOnlyDelegate(page, delegateId, "WebSocket reconnect");

			// Force a full authoritative list fetch without recreating the mounted
			// panel. Pinning broadcasts sessions_changed; resetting only the conditional
			// cursor makes the resulting push refresh return and reconcile a full list.
			await page.evaluate(() => {
				const app = (window as any).bobbitState;
				(window as any).__readOnlyDelegateInterfaceBeforeRefresh = app?.chatPanel?.agentInterface;
				if (app?.sessionPollTimer) {
					clearInterval(app.sessionPollTimer);
					app.sessionPollTimer = null;
				}
				app.sessionsGeneration = -1;
			});
			const listFetch = page.waitForResponse((response) => {
				const url = new URL(response.url());
				return response.request().method() === "GET"
					&& url.pathname.endsWith("/api/sessions")
					&& !url.searchParams.has("since")
					&& !url.searchParams.has("include");
			}, { timeout: 15_000 });
			const pinResponse = await apiFetch(`/api/sessions/${delegateId}/pin`, {
				method: "PUT",
				body: JSON.stringify({ pinned: true }),
			});
			expect(pinResponse.status).toBe(200);
			const refreshResponse = await listFetch;
			expect(refreshResponse.ok(), "authoritative session-list fetch should succeed").toBe(true);
			const refreshBody = await refreshResponse.json() as { changed?: boolean; sessions?: Array<{ id?: string; readOnly?: boolean; user_tags?: string[] }> };
			expect(refreshBody.changed, "forced full list fetch must return an authoritative snapshot").not.toBe(false);
			expect(refreshBody.sessions?.find((candidate) => candidate.id === delegateId)).toMatchObject({
				readOnly: true,
				user_tags: expect.arrayContaining(["pinned=true"]),
			});
			await expect.poll(() => page.evaluate((id) => {
				const app = (window as any).bobbitState;
				const record = app?.gatewaySessions?.find((candidate: { id?: string }) => candidate.id === id);
				return record?.user_tags?.includes("pinned=true") === true
					&& app?.chatPanel?.agentInterface === (window as any).__readOnlyDelegateInterfaceBeforeRefresh
					&& document.contains(app.chatPanel.agentInterface);
			}, delegateId), { timeout: 15_000, message: "authoritative list snapshot should reconcile in the mounted delegate panel" }).toBe(true);
			await expectActiveReadOnlyDelegate(page, delegateId, "authoritative session refresh");
			expectMutatingToolsWithheld(gateway, delegateId, "authoritative session refresh");
		} finally {
			if (delegateId) await deleteSession(delegateId).catch(() => {});
			await deleteSession(ownerId).catch(() => {});
		}
	});
});
