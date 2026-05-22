/**
 * E2E test for server-side read/unread state.
 *
 * Verifies that marking a session as read persists across:
 *   1. A page reload, AND
 *   2. A full clear of localStorage / sessionStorage.
 *
 * This proves the read state is sourced from the server (lastReadAt) rather
 * than the legacy client-side `bobbit-session-visited` localStorage key.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

async function getDefaultProjectId(): Promise<{ id: string; rootPath: string }> {
	const resp = await apiFetch("/api/projects");
	const data = await resp.json();
	const projects = Array.isArray(data) ? data : (data.projects || []);
	expect(projects.length).toBeGreaterThan(0);
	return { id: projects[0].id, rootPath: projects[0].rootPath };
}

test.describe("Unseen-activity dot (server-backed read state)", () => {
	let sessionId: string | null = null;

	test.afterEach(async () => {
		if (sessionId) {
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
			sessionId = null;
		}
	});

	test("read state persists across reload with cleared localStorage", async ({ page }) => {
		const proj = await getDefaultProjectId();

		const sessResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: proj.rootPath, projectId: proj.id }),
		});
		expect(sessResp.status).toBe(201);
		const sess = await sessResp.json();
		sessionId = sess.id;

		// Bump lastActivity above lastReadAt (which is 0/undefined) so the
		// unseen dot would normally render. We do this by directly POSTing
		// nothing — session creation already sets lastActivity to now, while
		// lastReadAt remains undefined → unseen.
		// (No extra activity needed: session creation timestamp suffices.)

		await openApp(page);
		await navigateToHash(page, "#/");

		const row = page.locator(`[data-session-id="${sessionId}"]`).first();
		await expect(row).toBeVisible({ timeout: 10_000 });

		// Mark the session as read directly via the new endpoint, then refresh
		// the sessions list so the UI picks up server-side lastReadAt.
		const markResp = await apiFetch(`/api/sessions/${sessionId}/mark-read`, {
			method: "POST",
		});
		expect(markResp.status).toBe(200);

		// Clear all client storage to prove read state is NOT coming from
		// localStorage. We preserve only the gateway URL/token entries that
		// openApp would otherwise re-seed via ?token=, then call openApp again
		// to force a fresh navigation. The legacy `bobbit-session-visited`
		// key (and any other client cache) is wiped.
		await page.evaluate(() => {
			const keep = ["gateway.url", "gateway.token"];
			const saved: Record<string, string> = {};
			for (const k of keep) {
				const v = localStorage.getItem(k);
				if (v !== null) saved[k] = v;
			}
			try { localStorage.clear(); } catch { /* noop */ }
			try { sessionStorage.clear(); } catch { /* noop */ }
			for (const [k, v] of Object.entries(saved)) localStorage.setItem(k, v);
		});

		// Fresh navigation — app re-fetches sessions including server lastReadAt.
		await openApp(page);
		await navigateToHash(page, "#/");

		const rowAfterReload = page.locator(`[data-session-id="${sessionId}"]`).first();
		await expect(rowAfterReload).toBeVisible({ timeout: 15_000 });

		// The unseen dot must NOT appear — its presence would mean read state
		// regressed because localStorage was cleared.
		const unseenDot = rowAfterReload.locator(".unseen-dot");
		await expect(unseenDot).toHaveCount(0);
	});

	// Unknown-session endpoint coverage lives in tests/e2e/unseen-activity-api.spec.ts.
});
