import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, base, createSession, deleteSession, readE2EToken } from "./_e2e/e2e-setup.js";

const SIGNED_COOKIE_VALUE = String.raw`v1\.[1-9]\d*\.[1-9]\d*\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}`;

async function mintCookie(): Promise<string> {
	const browserOrigin = new URL(base()).origin;
	const resp = await fetch(`${base()}/api/health`, {
		headers: {
			Authorization: `Bearer ${readE2EToken()}`,
			Origin: browserOrigin,
			"Sec-Fetch-Site": "same-origin",
			"Sec-Fetch-Mode": "cors",
		},
	});
	expect(resp.status).toBe(200);
	const setCookie = resp.headers.get("set-cookie");
	expect(setCookie, "trusted browser auth should bootstrap a signed cookie").toBeTruthy();
	const m = String(setCookie).match(new RegExp(`bobbit_session=(${SIGNED_COOKIE_VALUE})(?:;|$)`));
	expect(m, `Set-Cookie did not include a signed bobbit_session: ${setCookie}`).not.toBeNull();
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
