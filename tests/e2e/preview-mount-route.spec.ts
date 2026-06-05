/**
 * API E2E for WP-H: the v3 mount endpoint + content origin route.
 *
 * Validates:
 *   - POST /api/preview/mount?sessionId=<sid>  with {html} → 200 + {url, path, entry, mtime, contentHash}
 *   - GET  /api/preview/mount?sessionId=<sid> after a mount → 200 + 64-hex contentHash
 *   - GET  /preview/<sid>/inline.html with valid cookie → 200 text/html + bridge inject
 *   - GET  /preview/<sid>/inline.html without cookie (forced auth) → 401
 *   - GET  /preview/<sid>/../../etc/passwd → 403 (or 400)
 *   - GET  /preview/<sid>/missing.png → 404
 *   - POST /api/preview/mount with file= containing sibling tree
 *     → GET /preview/<sid>/sibling.png returns the asset bytes with correct MIME
 *
 * The harness runs with `forceAuth: true`, so non-localhost auth rules apply
 * even though the listening interface is 127.0.0.1.
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	createSession,
	deleteSession,
	readE2EToken,
	base,
} from "./e2e-setup.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let token: string;
let sessionId: string;

test.beforeAll(async () => {
	token = readE2EToken();
	sessionId = await createSession();
});

test.afterAll(async () => {
	await deleteSession(sessionId).catch(() => {});
});

/** Hit an authed endpoint to provoke the cookie mint, return the raw value. */
async function mintCookie(): Promise<string> {
	const resp = await fetch(`${base()}/api/health`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	expect(resp.status).toBe(200);
	const setCookie = resp.headers.get("set-cookie");
	expect(setCookie, "Server must mint bobbit_session on Bearer auth").toBeTruthy();
	const m = String(setCookie).match(/bobbit_session=([0-9a-f]{64})/i);
	expect(m, `Set-Cookie did not include bobbit_session: ${setCookie}`).not.toBeNull();
	return `bobbit_session=${m![1]}`;
}

test.describe("POST /api/preview/mount (v3)", () => {
	test("html body → 200 with {url, path, entry, mtime, contentHash, artifactId}", async () => {
		const resp = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			body: JSON.stringify({ html: "<h1>x</h1>" }),
		});
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(typeof body.url).toBe("string");
		expect(body.url).toBe(`/preview/${sessionId}/inline.html`);
		expect(body.entry).toBe("inline.html");
		expect(typeof body.path).toBe("string");
		expect(body.path.length).toBeGreaterThan(0);
		expect(typeof body.mtime).toBe("number");
		expect(body.mtime).toBeGreaterThan(0);
		expect(body.contentHash).toMatch(/^[a-f0-9]{64}$/);
		expect(body.artifactId).toMatch(/^[A-Za-z0-9_-]{6,64}$/);
	});

	test("artifactId restore rehydrates immutable mounted bytes and rejects wrong sessions", async () => {
		const restoreSessionId = await createSession();
		const otherSessionId = await createSession();
		try {
			const v1Resp = await apiFetch(`/api/preview/mount?sessionId=${restoreSessionId}`, {
				method: "POST",
				body: JSON.stringify({ html: "<!doctype html><body>artifact-v1</body>", entry: "artifact.html" }),
			});
			expect(v1Resp.status).toBe(200);
			const v1 = await v1Resp.json();
			expect(v1.artifactId).toMatch(/^[A-Za-z0-9_-]{6,64}$/);

			const v2Resp = await apiFetch(`/api/preview/mount?sessionId=${restoreSessionId}`, {
				method: "POST",
				body: JSON.stringify({ html: "<!doctype html><body>current-v2</body>", entry: "artifact.html" }),
			});
			expect(v2Resp.status).toBe(200);
			const v2 = await v2Resp.json();
			expect(v2.contentHash).not.toBe(v1.contentHash);

			const otherMount = await apiFetch(`/api/preview/mount?sessionId=${otherSessionId}`, {
				method: "POST",
				body: JSON.stringify({ html: "<!doctype html><body>other-stable</body>", entry: "artifact.html" }),
			});
			expect(otherMount.status).toBe(200);
			const otherBefore = await otherMount.json();

			const wrongSessionRestore = await apiFetch(`/api/preview/artifacts/${encodeURIComponent(v1.artifactId)}/restore?sessionId=${otherSessionId}`, {
				method: "POST",
				body: JSON.stringify({ artifactId: v1.artifactId }),
			});
			expect(wrongSessionRestore.status).toBe(404);
			const otherAfterResp = await apiFetch(`/api/preview/mount?sessionId=${otherSessionId}`);
			expect(otherAfterResp.status).toBe(200);
			const otherAfter = await otherAfterResp.json();
			expect(otherAfter.contentHash).toBe(otherBefore.contentHash);

			const restoreResp = await apiFetch(`/api/preview/artifacts/${encodeURIComponent(v1.artifactId)}/restore?sessionId=${restoreSessionId}`, {
				method: "POST",
				body: JSON.stringify({ artifactId: v1.artifactId }),
			});
			expect(restoreResp.status).toBe(200);
			const restored = await restoreResp.json();
			expect(restored.artifactId).toBe(v1.artifactId);
			expect(restored.contentHash).toBe(v1.contentHash);
			expect(restored.entry).toBe("artifact.html");

			const cookie = await mintCookie();
			const contentResp = await fetch(`${base()}/preview/${restoreSessionId}/artifact.html`, {
				headers: { Cookie: cookie },
			});
			expect(contentResp.status).toBe(200);
			const html = await contentResp.text();
			expect(html).toContain("artifact-v1");
			expect(html).not.toContain("current-v2");
		} finally {
			await deleteSession(restoreSessionId).catch(() => {});
			await deleteSession(otherSessionId).catch(() => {});
		}
	});

	test("missing html, file, and artifactId → 400", async () => {
		const resp = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(400);
	});

	test("invalid sessionId → 400", async () => {
		const resp = await apiFetch(`/api/preview/mount?sessionId=not-a-uuid`, {
			method: "POST",
			body: JSON.stringify({ html: "<h1>x</h1>" }),
		});
		expect(resp.status).toBe(400);
	});

	test("file= with explicit assets[] copies entry + declared assets only", async () => {
		const src = mkdtempSync(path.join(tmpdir(), "bobbit-mr-src-"));
		try {
			const entry = path.join(src, "report.html");
			writeFileSync(entry, `<!DOCTYPE html><body><img src="sibling.png"><img src="thumbs/x.png"></body>`);
			const pngBytes = Buffer.from([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
				0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
			]);
			writeFileSync(path.join(src, "sibling.png"), pngBytes);
			writeFileSync(path.join(src, "undeclared.txt"), "should-not-be-copied");
			mkdirSync(path.join(src, "thumbs"));
			writeFileSync(path.join(src, "thumbs", "x.png"), pngBytes);

			const resp = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				body: JSON.stringify({ file: entry, assets: ["sibling.png", "thumbs/x.png"] }),
			});
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.entry).toBe("report.html");
			expect(body.url).toBe(`/preview/${sessionId}/report.html`);
			expect(Array.isArray(body.assets)).toBe(true);
			expect(body.assets.sort()).toEqual(["sibling.png", "thumbs/x.png"]);

			const cookie = await mintCookie();
			const assetResp = await fetch(`${base()}/preview/${sessionId}/sibling.png`, {
				headers: { Cookie: cookie },
			});
			expect(assetResp.status).toBe(200);
			expect(assetResp.headers.get("content-type") || "").toMatch(/image\/png/);
			const buf = Buffer.from(await assetResp.arrayBuffer());
			expect(buf.equals(pngBytes)).toBe(true);

			const nested = await fetch(`${base()}/preview/${sessionId}/thumbs/x.png`, {
				headers: { Cookie: cookie },
			});
			expect(nested.status).toBe(200);

			// Undeclared sibling must NOT be copied — 404 from content origin.
			const undeclared = await fetch(`${base()}/preview/${sessionId}/undeclared.txt`, {
				headers: { Cookie: cookie },
			});
			expect(undeclared.status).toBe(404);
		} finally {
			rmSync(src, { recursive: true, force: true });
		}
	});

	test("file= without assets copies only entry; siblings 404", async () => {
		const src = mkdtempSync(path.join(tmpdir(), "bobbit-mr-src-bare-"));
		try {
			const entry = path.join(src, "report.html");
			writeFileSync(entry, `<!DOCTYPE html><body>bare</body>`);
			writeFileSync(path.join(src, "styles.css"), "body{}");

			const resp = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				body: JSON.stringify({ file: entry }),
			});
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.entry).toBe("report.html");
			expect(body.assets).toEqual([]);

			const cookie = await mintCookie();
			const entryResp = await fetch(`${base()}/preview/${sessionId}/report.html`, {
				headers: { Cookie: cookie },
			});
			expect(entryResp.status).toBe(200);

			const cssResp = await fetch(`${base()}/preview/${sessionId}/styles.css`, {
				headers: { Cookie: cookie },
			});
			expect(cssResp.status).toBe(404);
		} finally {
			rmSync(src, { recursive: true, force: true });
		}
	});

	test("file= with manifest reads assets from JSON file", async () => {
		const src = mkdtempSync(path.join(tmpdir(), "bobbit-mr-manifest-"));
		try {
			const entry = path.join(src, "report.html");
			writeFileSync(entry, `<!DOCTYPE html><body>m</body>`);
			writeFileSync(path.join(src, "styles.css"), "body{}");
			writeFileSync(path.join(src, "preview-manifest.json"), JSON.stringify({ assets: ["styles.css"] }));

			const resp = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				body: JSON.stringify({ file: entry, manifest: "preview-manifest.json" }),
			});
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.assets).toEqual(["styles.css"]);

			const cookie = await mintCookie();
			const cssResp = await fetch(`${base()}/preview/${sessionId}/styles.css`, {
				headers: { Cookie: cookie },
			});
			expect(cssResp.status).toBe(200);
		} finally {
			rmSync(src, { recursive: true, force: true });
		}
	});

	test("html= with assets= → 400", async () => {
		const resp = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			body: JSON.stringify({ html: "<h1>x</h1>", assets: ["foo.css"] }),
		});
		expect(resp.status).toBe(400);
	});

	test("file= with `..` in assets → 400", async () => {
		const src = mkdtempSync(path.join(tmpdir(), "bobbit-mr-bad-"));
		try {
			const entry = path.join(src, "report.html");
			writeFileSync(entry, `<h1>x</h1>`);
			const resp = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				body: JSON.stringify({ file: entry, assets: ["../escape"] }),
			});
			expect(resp.status).toBe(400);
		} finally {
			rmSync(src, { recursive: true, force: true });
		}
	});

	test("file= with missing literal asset → 404", async () => {
		const src = mkdtempSync(path.join(tmpdir(), "bobbit-mr-missing-"));
		try {
			const entry = path.join(src, "report.html");
			writeFileSync(entry, `<h1>x</h1>`);
			const resp = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				body: JSON.stringify({ file: entry, assets: ["missing.css"] }),
			});
			expect(resp.status).toBe(404);
		} finally {
			rmSync(src, { recursive: true, force: true });
		}
	});
});

test.describe("GET /api/preview/mount (v3)", () => {
	test("current mount response includes a 64-hex contentHash", async () => {
		const currentSessionId = await createSession();
		try {
			const mountResp = await apiFetch(`/api/preview/mount?sessionId=${currentSessionId}`, {
				method: "POST",
				body: JSON.stringify({ html: "<h1>bootstrap hash</h1>", entry: "current.html" }),
			});
			expect(mountResp.status).toBe(200);

			const resp = await apiFetch(`/api/preview/mount?sessionId=${currentSessionId}`);
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.url).toBe(`/preview/${currentSessionId}/current.html`);
			expect(body.relPath).toBe(`${currentSessionId}/current.html`);
			expect(body.entry).toBe("current.html");
			expect(typeof body.path).toBe("string");
			expect(body.path.length).toBeGreaterThan(0);
			expect(typeof body.mtime).toBe("number");
			expect(body.mtime).toBeGreaterThan(0);
			expect(body.contentHash).toMatch(/^[a-f0-9]{64}$/);
			expect(body.artifactId).toMatch(/^[A-Za-z0-9_-]{6,64}$/);
		} finally {
			await deleteSession(currentSessionId).catch(() => {});
		}
	});
});

test.describe("GET /preview/<sid>/* — content origin", () => {
	test.beforeAll(async () => {
		// Ensure inline.html exists for this session.
		const resp = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			body: JSON.stringify({ html: "<!DOCTYPE html><html><body>hello</body></html>" }),
		});
		expect(resp.status).toBe(200);
	});

	test("with valid bobbit_session cookie → 200 text/html with bridge scripts injected", async () => {
		const cookie = await mintCookie();
		const resp = await fetch(`${base()}/preview/${sessionId}/inline.html`, {
			headers: { Cookie: cookie },
		});
		expect(resp.status).toBe(200);
		expect(resp.headers.get("content-type") || "").toMatch(/text\/html/);
		const body = await resp.text();
		// <base> rewritten to content-origin path.
		expect(body).toContain(`<base href="/preview/${sessionId}/">`);
		// Bridge marker — any of the shared script substrings will do.
		expect(body).toMatch(/preview-swipe-start|MutationObserver/);
	});

	test("without cookie or bearer (forced auth) → 401", async () => {
		const resp = await fetch(`${base()}/preview/${sessionId}/inline.html`);
		expect(resp.status).toBe(401);
	});

	test("traversal `/preview/<sid>/../../etc/passwd` → 403 (or 400)", async () => {
		const cookie = await mintCookie();
		// We must NOT let fetch normalize the path away — go through a low-level
		// URL string. Node's fetch normalizes `..` segments client-side, so use
		// percent-encoded slashes which the server decodes server-side.
		const url = `${base()}/preview/${sessionId}/..%2F..%2Fetc%2Fpasswd`;
		const resp = await fetch(url, { headers: { Cookie: cookie } });
		// path-guard rejects with 403; if Node's fetch normalizes anyway, 404 is
		// also acceptable as it proves the file isn't served.
		expect([400, 403, 404]).toContain(resp.status);
		expect(resp.status).not.toBe(200);
	});

	test("backslash in path → 403", async () => {
		const cookie = await mintCookie();
		const url = `${base()}/preview/${sessionId}/sub%5Cevil.html`;
		const resp = await fetch(url, { headers: { Cookie: cookie } });
		expect(resp.status).toBe(403);
	});

	test("missing file → 404", async () => {
		const cookie = await mintCookie();
		const resp = await fetch(`${base()}/preview/${sessionId}/no-such-file.png`, {
			headers: { Cookie: cookie },
		});
		expect(resp.status).toBe(404);
	});
});
