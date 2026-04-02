/**
 * E2E browser tests for the "ask" tool permission policy.
 *
 * Tests the full journey: guard blocks tool → card appears → user grants/denies.
 * Uses the REST tool-grant-request endpoint to simulate the guard extension's
 * long-poll, verifying the UI card rendering and user interaction flow.
 */
import { test, expect } from "../gateway-harness.js";
import {
	apiFetch,
	createSession,
	deleteSession,
	nonGitCwd,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { openApp, createSessionViaUI, sendMessage, waitForAgentResponse } from "./ui-helpers.js";

const ASK_ROLE = "e2e-ask-policy-role";
const TOOL_NAME = "Bash";
const TOOL_GROUP = "Shell";

test.describe("Tool ask policy (UI)", () => {
	test.beforeAll(async () => {
		await apiFetch(`/api/roles/${ASK_ROLE}`, { method: "DELETE" }).catch(() => {});
		const resp = await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({
				name: ASK_ROLE,
				label: "E2E Ask Policy",
				toolPolicies: { [TOOL_NAME]: "ask" },
			}),
		});
		expect(resp.status).toBe(201);
	});

	test.afterAll(async () => {
		await apiFetch(`/api/roles/${ASK_ROLE}`, { method: "DELETE" }).catch(() => {});
	});

	test("permission card appears and grant button works", async ({ page }) => {
		await openApp(page);

		// Create session via UI so it's properly wired with the app's RemoteAgent
		await createSessionViaUI(page);

		// Send a message and wait for response to confirm session is fully connected
		await sendMessage(page, "Say OK");
		await waitForAgentResponse(page);

		// Now assign the ask-policy role to this session
		// Get the session ID from the URL hash
		const sessionId = await page.evaluate(() => {
			const hash = location.hash;
			const match = hash.match(/#\/session\/(.+)/);
			return match?.[1] ?? "";
		});
		expect(sessionId).toBeTruthy();

		try {
			// Assign the role via API
			await apiFetch(`/api/sessions/${sessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ roleId: ASK_ROLE }),
			});

			// Fire the tool-grant-request (simulates guard extension long-poll)
			const grantPromise = apiFetch(`/api/sessions/${sessionId}/tool-grant-request`, {
				method: "POST",
				body: JSON.stringify({ toolName: TOOL_NAME, toolGroup: TOOL_GROUP }),
			});

			// The tool-permission-card should appear
			const card = page.locator("tool-permission-card").first();
			await expect(card).toBeVisible({ timeout: 15_000 });

			// Verify card mentions the tool name and role
			await expect(card.locator("code").first()).toContainText("Bash");

			// Click "Allow just Bash"
			await card.getByRole("button", { name: /Allow just/i }).click();
			await expect(card.getByText(/Permission granted/i)).toBeVisible({ timeout: 5_000 });

			// Long-poll should resolve
			const result = await grantPromise.then(r => r.json());
			expect(result.granted).toBe(true);
		} finally {
			// Reset role for next test (ignore errors during gateway shutdown)
			await Promise.all([
				apiFetch(`/api/roles/${ASK_ROLE}`, {
					method: "PUT",
					body: JSON.stringify({ label: "E2E Ask Policy", toolPolicies: { [TOOL_NAME]: "ask" } }),
				}).catch(() => {}),
				deleteSession(sessionId).catch(() => {}),
			]);
		}
	});

	test("deny button resolves long-poll and removes card", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "Say OK");
		await waitForAgentResponse(page);

		const sessionId = await page.evaluate(() => {
			const match = location.hash.match(/#\/session\/(.+)/);
			return match?.[1] ?? "";
		});
		expect(sessionId).toBeTruthy();

		try {
			await apiFetch(`/api/sessions/${sessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ roleId: ASK_ROLE }),
			});

			const grantPromise = apiFetch(`/api/sessions/${sessionId}/tool-grant-request`, {
				method: "POST",
				body: JSON.stringify({ toolName: TOOL_NAME, toolGroup: TOOL_GROUP }),
			});

			const card = page.locator("tool-permission-card").first();
			await expect(card).toBeVisible({ timeout: 15_000 });

			// Click Deny — the card should show denied state or be removed
			await card.getByRole("button", { name: /Deny/i }).click();

			// Long-poll should resolve with denied
			const result = await grantPromise.then(r => r.json());
			expect(result.granted).toBe(false);
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});

	test("session-only grant does not modify role permanently", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "Say OK");
		await waitForAgentResponse(page);

		const sessionId = await page.evaluate(() => {
			const match = location.hash.match(/#\/session\/(.+)/);
			return match?.[1] ?? "";
		});
		expect(sessionId).toBeTruthy();

		try {
			await apiFetch(`/api/sessions/${sessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ roleId: ASK_ROLE }),
			});

			const grantPromise = apiFetch(`/api/sessions/${sessionId}/tool-grant-request`, {
				method: "POST",
				body: JSON.stringify({ toolName: TOOL_NAME, toolGroup: TOOL_GROUP }),
			});

			const card = page.locator("tool-permission-card").first();
			await expect(card).toBeVisible({ timeout: 15_000 });

			// Select "This session only" duration
			await card.locator("select").selectOption("session-only");
			await card.getByRole("button", { name: /Allow just/i }).click();
			await expect(card.getByText(/Permission granted/i)).toBeVisible({ timeout: 5_000 });

			const result = await grantPromise.then(r => r.json());
			expect(result.granted).toBe(true);

			// Role should NOT be modified
			const roleResp = await apiFetch(`/api/roles/${ASK_ROLE}`);
			const role = await roleResp.json();
			expect(role.toolPolicies?.[TOOL_NAME]).toBe("ask");
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
