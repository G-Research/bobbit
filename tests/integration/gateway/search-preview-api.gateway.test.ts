import { test, expect } from "../../../tests2/integration/_e2e/in-process-harness.js";
import { apiFetch, base, createSession, deleteSession } from "../../../tests2/integration/_e2e/e2e-setup.js";
import { mintCookie } from "./_helpers/search-preview-fixtures.js";

test.describe("Search/preview/archive API migrations", () => {
	test("preview content route injects standalone theme snapshot tokens", async () => {
		const sessionId = await createSession();
		try {
			const mount = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				body: JSON.stringify({
					html: `<!DOCTYPE html><html><head></head><body><div id="box" style="background:var(--background);color:var(--foreground);">themed</div></body></html>`,
					entry: "report.html",
				}),
			});
			expect(mount.status).toBe(200);

			const cookie = await mintCookie();
			const response = await fetch(`${base()}/preview/${sessionId}/report.html`, {
				headers: { Cookie: cookie },
			});
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type") || "").toMatch(/text\/html/);
			const body = await response.text();
			expect(body).toContain(`<base data-bobbit-preview-base href="/preview/${sessionId}/">`);
			expect(body).toContain('data-bobbit-preview-theme="snapshot"');
			expect(body).toMatch(/:root\s*{[^}]*--background\s*:/s);
			expect(body).toMatch(/:root\s*{[^}]*--foreground\s*:/s);
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
