/**
 * Browser E2E — Tools page "New Tool" button uses the user-facing
 * Headquarters server workspace scope.
 *
 * Under the Headquarters split, the synthetic "system" project is hidden
 * compatibility-only. First-party UI should POST `/api/sessions` with
 * `{ toolAssistant: true, projectId: "headquarters" }` and succeed even when
 * no normal projects are registered.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.describe("Tools page — New Tool with Headquarters scope", () => {
	test("POST body carries projectId='headquarters' and server returns 201", async ({ page }) => {
		await openApp(page);

		// Remove normal projects. Headquarters is immutable and remains the
		// user-facing server workspace for tool assistants.
		const list = await apiFetch("/api/projects").then(r => r.json()) as Array<{ id: string; kind?: string }>;
		for (const p of list) {
			if (p.id === "headquarters" || p.kind === "headquarters") continue;
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

		// Click "New Tool" (Headquarters scope is the default).
		const newToolBtn = page.locator("button").filter({ hasText: /New Tool/ }).first();
		await expect(newToolBtn).toBeVisible({ timeout: 10_000 });
		const postPromise = page.waitForResponse((resp) => resp.request().method() === "POST" && new URL(resp.url()).pathname === "/api/sessions", { timeout: 10_000 });
		await newToolBtn.click();
		await postPromise;

		expect(postBody, "POST /api/sessions body must be captured").not.toBeNull();
		expect(postBody.toolAssistant).toBe(true);
		expect(postBody.projectId).toBe("headquarters");
		expect(postStatus, "POST /api/sessions must succeed (201)").toBe(201);
	});

	test("persistence — Headquarters scope survives reload (still POSTs successfully)", async ({ page }) => {
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
