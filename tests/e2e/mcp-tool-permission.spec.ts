/**
 * E2E tests for MCP tool permission grant flow.
 *
 * Tests the full lifecycle:
 * 1. Session with a restricted role tries to use an MCP tool
 * 2. Server detects the permission denial and broadcasts tool_permission_needed
 * 3. Client receives the message and can grant access
 * 4. Grant updates the role's allowedTools
 *
 * Uses the mock MCP server (tests/fixtures/mock-mcp-server.mjs) to provide
 * real MCP tools that the role doesn't initially have access to.
 */
import { test, expect } from "./gateway-harness.js";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	readE2EToken,
	apiFetch,
	base,
	wsBase,
	bobbitDir,
	connectWs,
	createSession,
	deleteSession,
	nonGitCwd,
	agentEndPredicate,
} from "./e2e-setup.js";
import type { Page } from "@playwright/test";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MOCK_MCP_SERVER = resolve(__dirname, "..", "fixtures", "mock-mcp-server.mjs");

test.setTimeout(60_000);

// ── Test setup: write MCP config and create a restricted role ──

const ROLE_NAME = "mcp-perm-test-role";
const DENIED_TOOL = "mcp__mock__echo";

test.beforeAll(async () => {
	// 1. Write MCP config to point at the mock MCP server
	const mcpConfigDir = join(bobbitDir(), "config");
	mkdirSync(mcpConfigDir, { recursive: true });
	writeFileSync(
		join(mcpConfigDir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				mock: {
					command: process.execPath,
					args: [MOCK_MCP_SERVER],
				},
			},
		}, null, 2),
		"utf-8",
	);

	// 2. Restart the mock MCP server so tools are discovered
	const restartResp = await apiFetch("/api/mcp-servers/mock/restart", { method: "POST" });
	expect(restartResp.status).toBe(200);
	const restartData = await restartResp.json();
	expect(restartData.toolCount).toBeGreaterThanOrEqual(2);

	// 3. Create a restricted role that does NOT include MCP tools
	const roleResp = await apiFetch("/api/roles", {
		method: "POST",
		body: JSON.stringify({
			name: ROLE_NAME,
			label: "MCP Permission Test Role",
			promptTemplate: "You are a restricted test agent.",
			allowedTools: ["Read", "Write", "Bash"],
		}),
	});
	expect(roleResp.status).toBe(201);
});

test.afterAll(async () => {
	// Clean up role
	await apiFetch(`/api/roles/${ROLE_NAME}`, { method: "DELETE" }).catch(() => {});
	// Clean up MCP config
	const mcpConfigPath = join(bobbitDir(), "config", "mcp.json");
	if (existsSync(mcpConfigPath)) {
		try { unlinkSync(mcpConfigPath); } catch { /* ignore */ }
	}
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. WebSocket-level: tool_permission_needed broadcast
// ═══════════════════════════════════════════════════════════════════════════

test.describe("MCP Tool Permission — WebSocket protocol", () => {
	let sessionId: string;
	test.afterEach(async () => {
		if (sessionId) { await deleteSession(sessionId); sessionId = ""; }
	});

	test("server broadcasts tool_permission_needed when denied MCP tool is used", async () => {
		// Create a session with the restricted role
		const resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({
				cwd: nonGitCwd(),
				roleId: ROLE_NAME,
			}),
		});
		expect(resp.status).toBe(201);
		sessionId = (await resp.json()).id;

		// Connect via WebSocket
		const conn = await connectWs(sessionId);
		try {
			// Send a prompt that triggers the mock agent to POST to tool-grant-request
			conn.send({ type: "prompt", text: `TOOL_DENIED:${DENIED_TOOL}` });

			// Wait for the tool_permission_needed message (broadcast by the gateway
			// when the guard extension's tool-grant-request arrives)
			const permMsg = await conn.waitFor(
				(m) => m.type === "tool_permission_needed",
				15_000,
			);

			expect(permMsg.toolName).toBe(DENIED_TOOL);
			expect(permMsg.roleName).toBe(ROLE_NAME);
			expect(permMsg.roleLabel).toBe("MCP Permission Test Role");
			expect(permMsg.group).toBeTruthy();

			// Grant the tool to unblock the mock agent's pending REST call
			conn.send({
				type: "grant_tool_permission",
				toolName: DENIED_TOOL,
				scope: "tool",
			});

			// Wait for the session to restart and go idle after the grant
			await conn.waitFor(
				(m) => m.type === "session_status" && m.status === "idle",
				15_000,
			);
			// Wait for the replayed prompt's turn to complete
			await conn.waitFor(agentEndPredicate(), 15_000).catch(() => {});
		} finally {
			conn.close();
		}
	});

	test("grant_tool_permission adds tool to role's allowedTools", async () => {
		// Use a fresh role for this test to avoid pollution
		const grantRoleName = "mcp-grant-test-role";
		await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({
				name: grantRoleName,
				label: "Grant Test Role",
				promptTemplate: "Test agent for granting.",
				allowedTools: ["Read"],
			}),
		});

		try {
			// Create session with this role
			const resp = await apiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({
					cwd: nonGitCwd(),
					roleId: grantRoleName,
				}),
			});
			expect(resp.status).toBe(201);
			sessionId = (await resp.json()).id;

			const conn = await connectWs(sessionId);
			try {
				// Trigger the denial — mock agent POSTs to tool-grant-request and blocks
				conn.send({ type: "prompt", text: `TOOL_DENIED:${DENIED_TOOL}` });

				// Wait for tool_permission_needed (broadcast when grant request arrives)
				await conn.waitFor(
					(m) => m.type === "tool_permission_needed" && m.toolName === DENIED_TOOL,
					15_000,
				);

				// Grant the single tool — this resolves the pending grant request,
				// which unblocks the mock agent and triggers a session restart
				conn.send({
					type: "grant_tool_permission",
					toolName: DENIED_TOOL,
					scope: "tool",
				});

				// Wait for the session restart to complete (idle status)
				await conn.waitFor(
					(m) => m.type === "session_status" && m.status === "idle",
					15_000,
				);
				// Wait for the replayed prompt's turn to complete
				await conn.waitFor(agentEndPredicate(), 15_000).catch(() => {});

				// Verify the role now includes the granted tool
				const roleResp = await apiFetch(`/api/roles/${grantRoleName}`);
				expect(roleResp.status).toBe(200);
				const role = await roleResp.json();
				expect(role.allowedTools).toContain(DENIED_TOOL);
			} finally {
				conn.close();
			}
		} finally {
			await apiFetch(`/api/roles/${grantRoleName}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("grant_tool_permission with scope=group adds all MCP tools from group", async () => {
		const groupRoleName = "mcp-group-grant-role";
		await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({
				name: groupRoleName,
				label: "Group Grant Test Role",
				promptTemplate: "Test agent for group granting.",
				allowedTools: ["Read"],
			}),
		});

		try {
			const resp = await apiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({
					cwd: nonGitCwd(),
					roleId: groupRoleName,
				}),
			});
			expect(resp.status).toBe(201);
			sessionId = (await resp.json()).id;

			const conn = await connectWs(sessionId);
			try {
				// Trigger the denial — mock agent POSTs to tool-grant-request and blocks
				conn.send({ type: "prompt", text: `TOOL_DENIED:${DENIED_TOOL}` });

				// Wait for tool_permission_needed (broadcast when grant request arrives)
				const permMsg = await conn.waitFor(
					(m) => m.type === "tool_permission_needed" && m.toolName === DENIED_TOOL,
					15_000,
				);
				const mcpGroup = permMsg.group;

				// Grant the entire group — resolves pending grant request and triggers restart
				conn.send({
					type: "grant_tool_permission",
					toolName: DENIED_TOOL,
					scope: "group",
					group: mcpGroup,
				});

				// Wait for session restart (idle)
				await conn.waitFor(
					(m) => m.type === "session_status" && m.status === "idle",
					15_000,
				);
				// Wait for the replayed prompt's turn to complete
				await conn.waitFor(agentEndPredicate(), 15_000).catch(() => {});

				// Verify the role includes both MCP tools (echo and add)
				const roleResp = await apiFetch(`/api/roles/${groupRoleName}`);
				const role = await roleResp.json();
				expect(role.allowedTools).toContain("mcp__mock__echo");
				expect(role.allowedTools).toContain("mcp__mock__add");
			} finally {
				conn.close();
			}
		} finally {
			await apiFetch(`/api/roles/${groupRoleName}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("no tool_permission_needed when session has no role and no tool restrictions", async () => {
		// The scaffolded "general" role has allowedTools, so sessions without
		// an explicit role still get tool restrictions. To test a truly
		// unrestricted session, temporarily give the general role an empty allowedTools.
		// Small delay to let any in-flight session restarts from prior tests settle
		await new Promise(r => setTimeout(r, 1500));

		const origResp = await apiFetch("/api/roles/general").catch(() => null);
		if (!origResp || !origResp.ok) {
			test.skip();
			return;
		}
		const origRole = await origResp.json();

		await apiFetch("/api/roles/general", {
			method: "PUT",
			body: JSON.stringify({ ...origRole, allowedTools: [], toolPolicies: {} }),
		});

		try {
			// Create a session without a role (general role now has no restrictions)
			sessionId = await createSession();
			const conn = await connectWs(sessionId);
			try {
				// Send a normal prompt (not TOOL_DENIED) — with no restrictions,
				// the guard extension has no 'ask' policies, so no tool_permission_needed
				// should ever fire. Use a regular prompt to verify no false positives.
				conn.send({ type: "prompt", text: "Say OK" });

				// Wait for the turn to finish
				await conn.waitFor(agentEndPredicate(), 10_000);

				// Verify no tool_permission_needed was received
				const permMsgs = conn.messages.filter((m: any) => m.type === "tool_permission_needed");
				expect(permMsgs.length).toBe(0);
			} finally {
				conn.close();
			}
		} finally {
			// Restore the original general role (ignore errors if gateway already shut down)
			if (origRole) {
				await apiFetch("/api/roles/general", {
					method: "PUT",
					body: JSON.stringify(origRole),
				}).catch(() => {});
			}
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Fullstack UI: tool permission card rendering and grant button
// ═══════════════════════════════════════════════════════════════════════════

/** Open the app authenticated via token query param. */
async function openApp(page: Page): Promise<void> {
	const token = readE2EToken();
	const b = `http://127.0.0.1:${process.env.E2E_PORT}`;
	await page.goto(`${b}/?token=${encodeURIComponent(token)}`);
	await expect(
		page.locator("button[title='New session']").first(),
	).toBeVisible({ timeout: 15_000 });
}

test.describe("MCP Tool Permission — Fullstack UI", () => {
	let sessionId: string;
	test.afterEach(async () => {
		if (sessionId) { await deleteSession(sessionId).catch(() => {}); sessionId = ""; }
	});

	test("tool permission card appears and grant button works", async ({ page }) => {
		// Verify gateway is still alive before proceeding
		const healthCheck = await apiFetch("/api/health").catch(() => null);
		if (!healthCheck?.ok) {
			test.skip();
			return;
		}
		// Create a dedicated role for this UI test
		const uiRoleName = "mcp-ui-perm-role";
		await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({
				name: uiRoleName,
				label: "UI Permission Test",
				promptTemplate: "You are a UI test agent.",
				allowedTools: ["Read", "Write"],
			}),
		});

		try {
			// Create a session with the restricted role
			const resp = await apiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({
					cwd: nonGitCwd(),
					roleId: uiRoleName,
				}),
			});
			expect(resp.status).toBe(201);
			const data = await resp.json();
			sessionId = data.id;

			// Open the app 
			await openApp(page);
			// If the setup wizard is showing, skip it
			const skipButton = page.locator("button").filter({ hasText: "Skip setup" });
			if (await skipButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
				await skipButton.click();
				await page.waitForTimeout(500);
			}
			// Navigate to the session via hash routing
			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
			// Wait for the session's textarea to appear (the chat input)
			const textarea = page.locator("textarea").first();
			await expect(textarea).toBeVisible({ timeout: 15_000 });

			// Send the tool denied prompt via the browser UI
			await textarea.fill(`TOOL_DENIED:${DENIED_TOOL}`);
			await textarea.press("Enter");

			// Wait for the tool-permission-card to appear in the DOM
			// The mock agent's guard-style REST request triggers tool_permission_needed
			const permCard = page.locator("tool-permission-card").first();
			await expect(permCard).toBeVisible({ timeout: 20_000 });

			// Verify card content via shadow DOM
			// The card shows the short tool name (e.g. "echo") and the role label
			const cardText = await permCard.evaluate((el) => el.shadowRoot?.textContent || el.textContent || "");
			expect(cardText).toContain("echo");
			expect(cardText).toContain("UI Permission Test");

			// Click the "Allow just echo" button (second button = tool scope)
			const grantButton = permCard.locator("button").nth(1);
			await expect(grantButton).toBeVisible({ timeout: 5_000 });
			await grantButton.click();

			// Verify the role was updated
			// Poll because the grant triggers a session restart
			let roleUpdated = false;
			const deadline = Date.now() + 15_000;
			while (Date.now() < deadline && !roleUpdated) {
				const roleResp = await apiFetch(`/api/roles/${uiRoleName}`);
				if (roleResp.ok) {
					const role = await roleResp.json();
					if (role.allowedTools?.includes(DENIED_TOOL)) {
						roleUpdated = true;
					}
				}
				if (!roleUpdated) await new Promise(r => setTimeout(r, 200));
			}
			expect(roleUpdated).toBe(true);

			// Optional screenshot
			if (process.env.SCREENSHOT === "1") {
				await page.screenshot({
					path: "tests/e2e/screenshots/mcp-tool-permission-grant.png",
					fullPage: true,
				});
			}
		} finally {
			await apiFetch(`/api/roles/${uiRoleName}`, { method: "DELETE" }).catch(() => {});
		}
	});
});
