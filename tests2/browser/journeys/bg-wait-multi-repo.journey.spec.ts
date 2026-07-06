/**
 * Journey: BG Wait Steer + Multi-Repo — v2 browser smoke
 * Covers: journey-bg-wait-steer, journey-multi-repo
 * Consolidated from: bg-wait-*, multi-repo-*, etc.
 */
import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus, apiFetch } from "../_helpers/journey-fixture.js";

test.describe("Journey: BG Wait Steer", () => {
	test("session loads for bg-wait interaction", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("message editor present for steer interaction", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			const editor = page.locator("message-editor textarea").first();
			await expect(editor).toBeVisible({ timeout: 15_000 });
			await editor.fill("steer test");
			const val = await editor.inputValue();
			expect(val).toBe("steer test");
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("bg process lifecycle: create → poll until exited → exitCode 0", async () => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			// Create a bg process with a trivial command that exits cleanly
			const res = await apiFetch(`/api/sessions/${sessionId}/bg-processes`, {
				method: "POST",
				body: JSON.stringify({ command: "echo done", name: "journey-smoke" }),
			});
			expect(res.status, "bg-process create should return 201").toBe(201);
			const body = await res.json();
			const bgId = body.id as string;
			expect(bgId).toBeTruthy();

			// Poll until the process exits (max ~10 s)
			let finalStatus: { status: string; exitCode: number | null } | null = null;
			for (let i = 0; i < 40; i++) {
				await new Promise((r) => setTimeout(r, 250));
				const listRes = await apiFetch(`/api/sessions/${sessionId}/bg-processes`);
				if (!listRes.ok) continue;
				const data = await listRes.json();
				const proc = (data.processes as Array<{ id: string; status: string; exitCode: number | null }>)
					.find((p) => p.id === bgId);
				if (proc && proc.status === "exited") {
					finalStatus = proc;
					break;
				}
			}
			expect(finalStatus, "bg process should reach exited state").not.toBeNull();
			expect(finalStatus!.exitCode, "echo done should exit with code 0").toBe(0);
		} finally {
			await deleteSession(sessionId);
		}
	});
});

test.describe("Journey: Multi-Repo", () => {
	test("project settings route reachable for multi-repo config", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 10_000 });
		await expect(page.locator("body")).toBeVisible({ timeout: 10_000 });
	});

	test("app shell stable during multi-repo project setup flow", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 10_000 });
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 5_000 });
	});
});
