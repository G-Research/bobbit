import { test, expect } from "./in-process-harness.js";
import { apiFetch, base, createSession, deleteSession, readE2EToken } from "./e2e-setup.js";

async function mintCookie(): Promise<string> {
	const resp = await fetch(`${base()}/api/health`, {
		headers: { Authorization: `Bearer ${readE2EToken()}` },
	});
	expect(resp.status).toBe(200);
	const setCookie = resp.headers.get("set-cookie");
	expect(setCookie).toBeTruthy();
	const m = String(setCookie).match(/bobbit_session=([0-9a-f]{64})/i);
	expect(m, `Set-Cookie did not include bobbit_session: ${setCookie}`).not.toBeNull();
	return `bobbit_session=${m![1]}`;
}

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
			const resp = await fetch(`${base()}/preview/${sessionId}/report.html`, {
				headers: { Cookie: cookie },
			});
			expect(resp.status).toBe(200);
			expect(resp.headers.get("content-type") || "").toMatch(/text\/html/);
			const body = await resp.text();
			expect(body).toContain(`<base href="/preview/${sessionId}/">`);
			expect(body).toContain('data-bobbit-preview-theme="snapshot"');
			expect(body).toMatch(/:root\s*{[^}]*--background\s*:/s);
			expect(body).toMatch(/:root\s*{[^}]*--foreground\s*:/s);
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
