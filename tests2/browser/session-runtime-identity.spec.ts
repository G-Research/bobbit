/**
 * Browser journey: provider-derived session runtime identity.
 *
 * Uses the production ClaudeAgentSdkBridge with only its official Query seam
 * replaced, so picker, session-list/audit, archive, reload, and reconnect
 * projections all travel through the normal gateway and browser paths.
 */
import type { Page } from "@playwright/test";
import { test, expect, apiFetch, createSession, deleteSession, openApp, navigateToHash, waitForSessionStatus } from "./_helpers/journey-fixture.js";

const SDK_PROVIDER = "claude-agent-sdk";
const SDK_MODEL = "sonnet-runtime-browser";
const SDK_SESSION_ID = "22222222-2222-4222-8222-222222222222";

type SdkQueryArgs = { prompt: AsyncIterable<unknown>; options: Record<string, unknown> };

/** Minimal deterministic implementation of the official SDK Query interface. */
class FakeSdkQuery implements AsyncIterable<unknown> {
	private closed = false;
	private reader?: (value: IteratorResult<unknown>) => void;

	constructor(readonly args: SdkQueryArgs) {}

	async initializationResult(): Promise<{ session_id: string }> {
		return { session_id: SDK_SESSION_ID };
	}
	async interrupt(): Promise<void> {}
	async setModel(): Promise<void> {}
	async setMaxThinkingTokens(): Promise<void> {}
	async close(): Promise<void> {
		this.closed = true;
		this.reader?.({ done: true, value: undefined });
		this.reader = undefined;
	}
	[Symbol.asyncIterator](): AsyncIterator<unknown> {
		return {
			next: () => this.closed
				? Promise.resolve({ done: true, value: undefined })
				: new Promise<IteratorResult<unknown>>((resolve) => { this.reader = resolve; }),
		};
	}
}

const queries: FakeSdkQuery[] = [];
test.use({
	claudeAgentSdkBridgeDepsFactory: {
		create: () => ({
			query: ((args: SdkQueryArgs) => {
				const query = new FakeSdkQuery(args);
				queries.push(query);
				return query;
			}) as any,
			clock: {
				now: () => Date.now(),
				setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
				clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
				setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
				clearInterval: (handle: ReturnType<typeof setInterval>) => clearInterval(handle),
			},
		}),
	},
});

function sessionRow(page: Page, sessionId: string) {
	return page.locator(`[data-session-id="${sessionId}"]`).first();
}

function runtimeBadge(row: ReturnType<typeof sessionRow>) {
	return row.locator('[data-runtime-badge="claude-agent-sdk"]').first();
}

async function showArchived(page: Page): Promise<void> {
	await page.getByTestId("sidebar-filters-button").click();
	await expect(page.getByTestId("sidebar-filters-popover")).toBeVisible();
	const toggle = page.getByTestId("sidebar-filter-archived").locator('input[type="checkbox"]');
	if (!(await toggle.isChecked())) await toggle.check();
}

async function selectSdkDefaultInModelsSettings(page: Page): Promise<void> {
	await navigateToHash(page, "#/settings/system/models");
	await expect(page.getByTestId("models-tab")).toBeVisible({ timeout: 20_000 });
	const sessionModelRow = page.locator('[data-testid="model-row"][data-row-label="Session"]').first();
	await expect(sessionModelRow).toBeVisible();
	await sessionModelRow.locator('button[title="Choose model"]').click();
	// ModelSelector's dialog is mounted independently of its custom-element host.
	// Assert the interactive search control rather than the host itself, mirroring
	// the stable settings picker journey.
	const search = page.getByPlaceholder("Search models...");
	await expect(search).toBeVisible({ timeout: 15_000 });
	await search.fill(SDK_MODEL);
	const model = page.locator(`[data-model-item][data-model-id="${SDK_MODEL}"]`).filter({ hasText: SDK_PROVIDER }).first();
	await expect(model).toBeVisible({ timeout: 15_000 });
	await expect(model.locator('[data-runtime-badge="claude-agent-sdk"]')).toBeVisible();
	await model.click();
	await expect(sessionModelRow).toContainText(SDK_MODEL, { timeout: 15_000 });
}

test.describe("session runtime identity", () => {
	test("SDK selection stays visible in live, reloaded, reconnected, archived, and unavailable audit rows", async ({ page, gateway }) => {
		test.setTimeout(55_000);
		queries.length = 0;
		const originalPreferences = await (await apiFetch("/api/preferences")).json() as Record<string, unknown>;
		let sessionId: string | undefined;
		try {
			const provider = await apiFetch("/api/custom-providers", {
				method: "POST",
				body: JSON.stringify({
					id: SDK_PROVIDER,
					name: SDK_PROVIDER,
					type: "manual",
					baseUrl: "http://127.0.0.1:9",
					models: [{ id: SDK_MODEL, name: "Runtime Browser Sonnet" }],
				}),
			});
			expect(provider.status, await provider.text()).toBe(200);

			await openApp(page);
			await selectSdkDefaultInModelsSettings(page);
			sessionId = await createSession();
			await waitForSessionStatus(sessionId, "idle");
			expect(queries, "SDK selection must start the production SDK bridge").toHaveLength(1);

			const liveResponse = await apiFetch("/api/sessions");
			const livePayload = await liveResponse.json() as { sessions: Array<Record<string, unknown>> };
			expect(livePayload.sessions.find((session) => session.id === sessionId)).toMatchObject({
				runtime: "claude-agent-sdk",
				modelProvider: SDK_PROVIDER,
				modelId: SDK_MODEL,
				modelAvailable: true,
			});

			await navigateToHash(page, `#/session/${sessionId}`);
			const liveRow = sessionRow(page, sessionId);
			await expect(liveRow).toBeVisible({ timeout: 20_000 });
			await expect(runtimeBadge(liveRow)).toBeVisible();

			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(runtimeBadge(sessionRow(page, sessionId))).toBeVisible({ timeout: 20_000 });

			await gateway.crash();
			await gateway.restart();
			await waitForSessionStatus(sessionId, "idle", 30_000);
			await expect.poll(async () => {
				const response = await apiFetch(`/api/sessions/${sessionId}`);
				const record = await response.json() as Record<string, unknown>;
				return record.runtime;
			}, { timeout: 30_000 }).toBe("claude-agent-sdk");
			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(runtimeBadge(sessionRow(page, sessionId))).toBeVisible({ timeout: 20_000 });
			expect(queries, "restart reconnect resumes through the SDK bridge").toHaveLength(2);

			const archive = await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
			expect(archive.ok, await archive.text()).toBe(true);
			await expect.poll(async () => {
				const response = await apiFetch(`/api/sessions/${sessionId}?include=archived`);
				const record = await response.json() as Record<string, unknown>;
				return record.archived === true || record.status === "archived";
			}, { timeout: 15_000 }).toBe(true);

			// Archiving through the REST seam does not mutate this page's sidebar
			// cache. Reload before selecting the archived filter so this assertion
			// exercises the audit-list projection rather than stale client state.
			await page.reload({ waitUntil: "domcontentloaded" });
			await showArchived(page);
			const archivedRow = sessionRow(page, sessionId);
			await expect(archivedRow).toBeVisible({ timeout: 20_000 });
			await expect(runtimeBadge(archivedRow)).toBeVisible();

			const removed = await apiFetch(`/api/custom-providers/${SDK_PROVIDER}`, { method: "DELETE" });
			expect(removed.status, await removed.text()).toBe(200);
			// Audit routes use the registry's cached catalog synchronously. Refresh it
			// first so the archived session is evaluated against the removed provider.
			const catalogResponse = await apiFetch("/api/models");
			expect(catalogResponse.status).toBe(200);
			const catalog = await catalogResponse.json() as Array<Record<string, unknown>>;
			expect(catalog.some((model) => model.provider === SDK_PROVIDER && model.id === SDK_MODEL)).toBe(false);

			const unavailableResponse = await apiFetch("/api/sessions?include=archived");
			const unavailablePayload = await unavailableResponse.json() as { sessions: Array<Record<string, unknown>> };
			expect(unavailablePayload.sessions.find((session) => session.id === sessionId)).toMatchObject({
				runtime: "claude-agent-sdk",
				modelProvider: SDK_PROVIDER,
				modelId: SDK_MODEL,
				modelAvailable: false,
			});

			await page.reload({ waitUntil: "domcontentloaded" });
			await showArchived(page);
			await expect(runtimeBadge(sessionRow(page, sessionId))).toBeVisible({ timeout: 20_000 });
			await expect(sessionRow(page, sessionId)).toContainText("Model unavailable");
		} finally {
			if (sessionId) await deleteSession(sessionId).catch(() => undefined);
			await apiFetch(`/api/custom-providers/${SDK_PROVIDER}`, { method: "DELETE" }).catch(() => undefined);
			await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({
					"default.sessionModel": originalPreferences["default.sessionModel"] ?? null,
					"default.sessionThinkingLevel": originalPreferences["default.sessionThinkingLevel"] ?? null,
				}),
			}).catch(() => undefined);
		}
	});
});
