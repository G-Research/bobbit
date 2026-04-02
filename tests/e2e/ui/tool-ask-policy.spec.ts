/**
 * E2E browser tests for the "ask" tool permission policy.
 *
 * Exercises the full user journey:
 * 1. Role has a tool with "ask" policy
 * 2. Agent tries to use the tool → guard blocks → permission card appears
 * 3. User approves or denies via the card UI
 * 4. Tool executes (or doesn't) based on the decision
 */
import { test, expect } from "../gateway-harness.js";
import {
	apiFetch,
	deleteSession,
	nonGitCwd,
	connectWs,
} from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

const ASK_ROLE = "e2e-ask-policy-role";
const TOOL_NAME = "Bash";
const TOOL_GROUP = "Shell";

async function createSessionWithRole(roleId: string): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: nonGitCwd(), roleId }),
	});
	expect(resp.status).toBe(201);
	return (await resp.json()).id;
}

test.describe("Tool ask policy (UI)", () => {
	// Create a role with Bash set to "ask" policy
	test.beforeAll(async () => {
		// Clean up any leftover role from a previous run
		await apiFetch(`/api/roles/${ASK_ROLE}`, { method: "DELETE" }).catch(() => {});

		const resp = await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({
				name: ASK_ROLE,
				label: "E2E Ask Policy",
				toolPolicies: {
					[TOOL_NAME]: "ask",
				},
			}),
		});
		expect(resp.status).toBe(201);
	});

	test.afterAll(async () => {
		await apiFetch(`/api/roles/${ASK_ROLE}`, { method: "DELETE" }).catch(() => {});
	});

	test("permission card appears when tool grant is requested", async ({ page }) => {
		const sessionId = await createSessionWithRole(ASK_ROLE);

		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });

			// Ensure the UI's WS is connected to this session before triggering the event.
			// Send a simple prompt and wait for the agent to respond first.
			await page.locator("textarea").first().fill("Say OK");
			await page.locator("textarea").first().press("Enter");
			await expect(page.getByText("OK").first()).toBeVisible({ timeout: 10_000 });

			// Connect a separate Node WS to verify the event fires
			const conn = await connectWs(sessionId);

			// Now simulate the guard extension's long-poll POST.
			const grantPromise = apiFetch(`/api/sessions/${sessionId}/tool-grant-request`, {
				method: "POST",
				body: JSON.stringify({ toolName: TOOL_NAME, toolGroup: TOOL_GROUP }),
			});

			// Verify the server broadcasts tool_permission_needed
			const permMsg = await conn.waitFor(
				(m: any) => m.type === "tool_permission_needed",
				5_000,
			);
			console.log("PERM MSG:", JSON.stringify(permMsg));
			conn.close();

			// Grant via the Node WS conn (not the browser) to unblock the long-poll  
			// and simultaneously check if the browser shows the card
			// Actually, the browser should already have shown the card from the tool_permission_needed event.
			// Let's try granting via the REST endpoint to check if the browser renders the card
			// OR if the issue is that the browser's WS simply never receives the event.
			
			// Wait longer and check for any permission-related text
			await page.waitForTimeout(2000);
			const allText = await page.evaluate(() => document.body.innerText);
			console.log("ALL TEXT includes 'permission':", allText.includes("permission"));
			console.log("ALL TEXT includes 'doesn\\'t have access':", allText.includes("doesn't have access"));
			console.log("ALL TEXT includes 'Bash':", allText.includes("Bash"));
			console.log("ALL TEXT includes 'denied':", allText.includes("denied"));
			console.log("ALL TEXT includes 'Tool':", allText.includes("Tool"));
			// Check for the custom element tag in outerHTML
			const hasCard = await page.evaluate(() => document.body.outerHTML.includes("tool-permission-card"));
			console.log("outerHTML has tool-permission-card:", hasCard);

			// The tool-permission-card should appear in the chat
			const card = page.locator("tool-permission-card").first();
			await expect(card).toBeVisible({ timeout: 10_000 });

			// Verify the card shows the tool name and role label
			await expect(card.getByText(TOOL_NAME)).toBeVisible();
			await expect(card.getByText("E2E Ask Policy")).toBeVisible();

			// Verify all three action buttons are present
			await expect(card.getByRole("button", { name: /Allow all tools/i })).toBeVisible();
			await expect(card.getByRole("button", { name: /Allow just/i })).toBeVisible();
			await expect(card.getByRole("button", { name: /Deny/i })).toBeVisible();

			// Clean up the pending long-poll by denying
			await card.getByRole("button", { name: /Deny/i }).click();
			await grantPromise.catch(() => {});
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});

	test("granting permission resolves the long-poll and updates the role", async ({ page }) => {
		const sessionId = await createSessionWithRole(ASK_ROLE);

		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });

			// Trigger tool permission request via REST (simulates guard extension)
			const grantPromise = apiFetch(`/api/sessions/${sessionId}/tool-grant-request`, {
				method: "POST",
				body: JSON.stringify({ toolName: TOOL_NAME, toolGroup: TOOL_GROUP }),
			});

			// Wait for card to appear
			const card = page.locator("tool-permission-card").first();
			await expect(card).toBeVisible({ timeout: 10_000 });

			// Click "Allow just <tool>" (persistent mode is the default)
			await card.getByRole("button", { name: /Allow just/i }).click();

			// Card should show "Permission granted"
			await expect(card.getByText(/Permission granted/i)).toBeVisible({ timeout: 5_000 });

			// The long-poll should resolve with granted: true
			const grantResult = await grantPromise.then(r => r.json());
			expect(grantResult.granted).toBe(true);

			// Verify the role was permanently updated
			const roleResp = await apiFetch(`/api/roles/${ASK_ROLE}`);
			const role = await roleResp.json();
			expect(role.toolPolicies?.[TOOL_NAME] === "allow").toBeTruthy();
		} finally {
			// Reset role back to ask policy
			await apiFetch(`/api/roles/${ASK_ROLE}`, {
				method: "PUT",
				body: JSON.stringify({
					label: "E2E Ask Policy",
					toolPolicies: { [TOOL_NAME]: "ask" },
				}),
			}).catch(() => {});
			await deleteSession(sessionId).catch(() => {});
		}
	});

	test("denying permission shows denied state and resolves long-poll", async ({ page }) => {
		const sessionId = await createSessionWithRole(ASK_ROLE);

		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });

			const grantPromise = apiFetch(`/api/sessions/${sessionId}/tool-grant-request`, {
				method: "POST",
				body: JSON.stringify({ toolName: TOOL_NAME, toolGroup: TOOL_GROUP }),
			});

			const card = page.locator("tool-permission-card").first();
			await expect(card).toBeVisible({ timeout: 10_000 });

			// Click "Deny"
			await card.getByRole("button", { name: /Deny/i }).click();

			// Card should show "Permission denied"
			await expect(card.getByText(/Permission denied/i)).toBeVisible({ timeout: 5_000 });

			// Long-poll should resolve with granted: false
			const denyResult = await grantPromise.then(r => r.json());
			expect(denyResult.granted).toBe(false);
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});

	test("session-only grant does not modify the role permanently", async ({ page }) => {
		const sessionId = await createSessionWithRole(ASK_ROLE);

		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });

			const grantPromise = apiFetch(`/api/sessions/${sessionId}/tool-grant-request`, {
				method: "POST",
				body: JSON.stringify({ toolName: TOOL_NAME, toolGroup: TOOL_GROUP }),
			});

			const card = page.locator("tool-permission-card").first();
			await expect(card).toBeVisible({ timeout: 10_000 });

			// Change duration to "This session only"
			await card.locator("select").selectOption("session-only");

			// Click "Allow just <tool>"
			await card.getByRole("button", { name: /Allow just/i }).click();

			// Card should show granted state
			await expect(card.getByText(/Permission granted/i)).toBeVisible({ timeout: 5_000 });

			// Long-poll should resolve with granted
			const result = await grantPromise.then(r => r.json());
			expect(result.granted).toBe(true);

			// Verify the role was NOT permanently modified — toolPolicies should still have "ask"
			const roleResp = await apiFetch(`/api/roles/${ASK_ROLE}`);
			const role = await roleResp.json();
			expect(role.toolPolicies?.[TOOL_NAME]).toBe("ask");
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
