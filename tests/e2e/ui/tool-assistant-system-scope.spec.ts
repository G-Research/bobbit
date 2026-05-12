/**
 * Browser E2E — Tools page "New Tool" button with system scope POSTs
 * /api/sessions with `{ toolAssistant: true, projectId: "system" }` and
 * succeeds even when zero real projects are registered.
 *
 * The synthetic "system" project is registered server-side at startup but
 * filtered out of GET /api/projects (hidden), so state.projects can be
 * empty while the POST still resolves.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.describe("Tools page — New Tool with system scope", () => {
	test("POST body carries projectId='system' and server returns 201", async ({ page }) => {
		await openApp(page);

		// Remove the harness "default" project so only the hidden system
		// project remains. This proves that the system-scope tool-assistant
		// path doesn't depend on any real project being registered.
		const list = await apiFetch("/api/projects").then(r => r.json()) as Array<{ id: string }>;
		for (const p of list) {
			await apiFetch(`/api/projects/${p.id}`, { method: "DELETE" });
		}

		await navigateToHash(page, "#/tools");

		// Capture the session-create request to assert body shape.
		let postBody: any = null;
		let postStatus: number | null = null;
		page.on("request", (req) => {
			if (req.method() === "POST" && new URL(req.url()).pathname === "/api/sessions") {
				try { postBody = JSON.parse(req.postData() || "null"); } catch { /* ignore */ }
			}
		});
		page.on("response", async (resp) => {
			if (resp.request().method() === "POST" && new URL(resp.url()).pathname === "/api/sessions") {
				postStatus = resp.status();
			}
		});

		// Click "New Tool" (system scope is the default).
		const newToolBtn = page.locator("button").filter({ hasText: /New Tool/ }).first();
		await expect(newToolBtn).toBeVisible({ timeout: 10_000 });
		const postPromise = page.waitForResponse((resp) => resp.request().method() === "POST" && new URL(resp.url()).pathname === "/api/sessions", { timeout: 10_000 });
		await newToolBtn.click();
		await postPromise;

		expect(postBody, "POST /api/sessions body must be captured").not.toBeNull();
		expect(postBody.toolAssistant).toBe(true);
		expect(postBody.projectId).toBe("system");
		expect(postStatus, "POST /api/sessions must succeed (201)").toBe(201);
	});

	test("persistence — system project survives reload (still POSTs successfully)", async ({ page }) => {
		await openApp(page);
		await page.reload();
		await navigateToHash(page, "#/tools");

		let postStatus: number | null = null;
		page.on("response", async (resp) => {
			if (resp.request().method() === "POST" && new URL(resp.url()).pathname === "/api/sessions") {
				postStatus = resp.status();
			}
		});

		const newToolBtn = page.locator("button").filter({ hasText: /New Tool/ }).first();
		await expect(newToolBtn).toBeVisible({ timeout: 10_000 });
		const postPromise = page.waitForResponse((resp) => resp.request().method() === "POST" && new URL(resp.url()).pathname === "/api/sessions", { timeout: 10_000 });
		await newToolBtn.click();
		await postPromise;
		expect(postStatus).toBe(201);
	});
});
