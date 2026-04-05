/**
 * Regression test: project palette stays applied after navigating to a session.
 *
 * Reproduces the bug where connectToSession() applied the palette before
 * refreshSessions() resolved, causing the palette to revert to the global one
 * when the session wasn't yet in gatewaySessions.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, nonGitCwd } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.describe("Project palette on session navigation", () => {
	let projectId: string;
	let sessionId: string;

	test.afterEach(async () => {
		if (sessionId) {
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
		if (projectId) {
			await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("palette matches project after navigating to session", async ({ page }) => {
		// Create a project with the "ocean" palette
		const projResp = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({
				name: "palette-test",
				rootPath: nonGitCwd(),
				palette: "ocean",
			}),
		});
		expect(projResp.status).toBe(201);
		const proj = await projResp.json();
		projectId = proj.id;

		// Create a session scoped to that project
		const sessResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({
				cwd: nonGitCwd(),
				projectId,
			}),
		});
		expect(sessResp.status).toBe(201);
		const sess = await sessResp.json();
		sessionId = sess.id;

		// Open the app and navigate to the session
		await openApp(page);
		await navigateToHash(page, `#/session/${sessionId}`);

		// Wait for palette to be applied (may happen asynchronously after refreshSessions)
		await page.waitForFunction(
			() => document.documentElement.dataset.palette === "ocean",
			{ timeout: 10_000 },
		);

		const palette = await page.evaluate(() => document.documentElement.dataset.palette);
		expect(palette).toBe("ocean");
	});
});
