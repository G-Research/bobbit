// v2-native — real browser journey for terminal background-process spawn failures.
import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus, apiFetch } from "../../../tests2/browser/_helpers/journey-fixture.js";
import type { GatewayInfo } from "../../e2e/gateway-harness.js";

const SPAWN_FAILURE_MESSAGE = "Background process could not be started";

function pill(page: import("@playwright/test").Page, processId: string) {
	return page.locator(`bg-process-pill[data-id="${processId}"]`);
}

/**
 * Route the production REST create endpoint through its container runtime path.
 * An unallocated container ID is deterministic whether Docker is absent
 * (child `error`) or installed (the docker wrapper exits non-zero), and the
 * manager maps both outcomes to the same persisted spawn-failed terminal state.
 */
function forceMissingContainerRuntime(gateway: GatewayInfo, sessionId: string): void {
	const session = gateway.sessionManager?.getSession(sessionId) as { containerId?: string; sandboxed?: boolean } | undefined;
	expect(session, "test session must be live in the gateway fixture").toBeTruthy();
	session!.containerId = `missing-bg-runtime-${process.pid}-${Date.now().toString(36)}`;
	session!.sandboxed = true;
}

test.describe("Journey: background spawn failure pill", () => {
	test("live spawn failure renders its diagnostic, reload hydrates it, and Remove purges it", async ({ page, gateway }) => {
		test.setTimeout(90_000);
		const sessionId = await createSession();
		let processId = "";

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
			forceMissingContainerRuntime(gateway, sessionId);

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
			await deleteSession(sessionId);
		}
	});
});
