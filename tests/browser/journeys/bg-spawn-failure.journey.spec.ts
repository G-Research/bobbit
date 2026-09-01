// v2-native — real browser journey for terminal background-process spawn failures.
import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus, apiFetch } from "../../../tests2/browser/_helpers/journey-fixture.js";
import type { GatewayInfo } from "../../../tests2/browser/gateway-harness.js";

const SPAWN_FAILURE_MESSAGE = "Background process could not be started";

function pill(page: import("@playwright/test").Page, processId: string) {
	return page.locator(`bg-process-pill[data-id="${processId}"]`);
}

function armSpawnFailure(gateway: GatewayInfo): () => void {
	return gateway.armBgProcessSpawnError("echo never-runs");
}

test.describe("Journey: background spawn failure pill", () => {
	test("live spawn failure renders its diagnostic, reload hydrates it, and Remove purges it", async ({ page, gateway }) => {
		test.setTimeout(90_000);
		const sessionId = await createSession();
		let processId = "";
		let disarmSpawnFailure = () => {};

		try {
			await waitForSessionStatus(sessionId, "idle");
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			// The app is connected before creation. The subsequent terminal transition
			// arrives through the real session WebSocket, rather than a component fixture.
			await page.waitForFunction(
				() => (window as any).bobbitState?.connectionStatus === "connected",
				undefined,
				{ timeout: 15_000 },
			);
			disarmSpawnFailure = armSpawnFailure(gateway);

			const create = await apiFetch(`/api/sessions/${sessionId}/bg-processes`, {
				method: "POST",
				body: JSON.stringify({ command: "echo never-runs", name: "spawn-failure" }),
			});
			expect(create.status, "the production create route accepts the runtime attempt").toBe(201);
			const created = await create.json() as { id: string };
			processId = created.id;
			expect(processId).toBeTruthy();

			const failedPill = pill(page, processId);
			await expect(failedPill).toBeVisible({ timeout: 30_000 });
			await failedPill.locator("button").first().click();
			const dropdown = page.locator("#bg-process-dropdown");
			await expect(dropdown).toContainText("failed to start", { timeout: 30_000 });
			await expect(dropdown).toContainText(`Failed to start: ${SPAWN_FAILURE_MESSAGE}`);
			await expect(dropdown).not.toContainText("exit status unknown");

			// Reload forces the client to obtain the terminal record through the
			// persisted GET hydration path, not the initial live WebSocket event.
			const hydration = page.waitForResponse((response) =>
				response.url().includes(`/api/sessions/${sessionId}/bg-processes`)
					&& response.request().method() === "GET"
					&& response.ok(),
				{ timeout: 20_000 },
			);
			await page.reload({ waitUntil: "domcontentloaded" });
			await hydration;
			await expect(failedPill).toBeVisible({ timeout: 20_000 });
			await failedPill.locator("button").first().click();
			await expect(dropdown).toContainText("failed to start");
			await expect(dropdown).toContainText(`Failed to start: ${SPAWN_FAILURE_MESSAGE}`);
			await expect(dropdown).not.toContainText("exit status unknown");

			const dismissal = page.waitForResponse((response) =>
				response.url().includes(`/api/sessions/${sessionId}/bg-processes/${processId}?action=dismiss`)
					&& response.request().method() === "DELETE"
					&& response.ok(),
				{ timeout: 15_000 },
			);
			await failedPill.locator("button").nth(1).click();
			await dismissal;
			await expect(failedPill).toHaveCount(0, { timeout: 15_000 });

			const listed = await apiFetch(`/api/sessions/${sessionId}/bg-processes`);
			expect(listed.status).toBe(200);
			const body = await listed.json() as { processes: Array<{ id: string }> };
			expect(body.processes.some((process) => process.id === processId)).toBe(false);
		} finally {
			disarmSpawnFailure();
			await deleteSession(sessionId);
		}
	});
});
