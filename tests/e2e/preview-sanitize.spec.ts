import { test, expect } from "./in-process-harness.js";
import { readE2EToken, base } from "./e2e-setup.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let token: string;

const headers = () => ({
	Authorization: `Bearer ${token}`,
	"Content-Type": "application/json",
});

async function apiFetch(path: string, opts?: RequestInit): Promise<Response> {
	return fetch(`${base()}${path}`, {
		...opts,
		headers: { ...headers(), ...(opts?.headers || {}) },
	});
}

test.beforeAll(() => {
	token = readE2EToken();
});

test.describe("Preview sessionId sanitization", () => {
	test("POST with path traversal sessionId returns 400", async () => {
		const resp = await apiFetch("/api/preview?sessionId=x/../../traversal", {
			method: "POST",
			body: JSON.stringify({ html: "<h1>evil</h1>" }),
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.error).toBe("Invalid sessionId");
	});

	test("POST with dot-dot sequences returns 400", async () => {
		const resp = await apiFetch("/api/preview?sessionId=..%2F..%2Fetc%2Ftest", {
			method: "POST",
			body: JSON.stringify({ html: "<h1>evil</h1>" }),
		});
		expect(resp.status).toBe(400);
	});

	test("POST with backslash traversal returns 400", async () => {
		const resp = await apiFetch("/api/preview?sessionId=valid\\..\\..\\test", {
			method: "POST",
			body: JSON.stringify({ html: "<h1>evil</h1>" }),
		});
		expect(resp.status).toBe(400);
	});

	test("POST with colon in sessionId returns 400", async () => {
		const resp = await apiFetch("/api/preview?sessionId=test:colon", {
			method: "POST",
			body: JSON.stringify({ html: "<h1>evil</h1>" }),
		});
		expect(resp.status).toBe(400);
	});

	test("POST with valid UUID sessionId succeeds", async () => {
		const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
		const resp = await apiFetch(`/api/preview?sessionId=${uuid}`, {
			method: "POST",
			body: JSON.stringify({ html: "<h1>valid</h1>" }),
		});
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.ok).toBe(true);
	});

	test("GET with valid UUID returns written content", async () => {
		const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
		// Write first
		await apiFetch(`/api/preview?sessionId=${uuid}`, {
			method: "POST",
			body: JSON.stringify({ html: "<h1>hello</h1>" }),
		});
		// Read back
		const resp = await apiFetch(`/api/preview?sessionId=${uuid}`);
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.html).toBe("<h1>hello</h1>");
		expect(body.mtime).toBeGreaterThan(0);
	});

	test("GET with traversal sessionId returns 400", async () => {
		const resp = await apiFetch("/api/preview?sessionId=x/../../../etc/passwd");
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.error).toBe("Invalid sessionId");
	});

	test("POST with no sessionId uses default preview.html", async () => {
		const resp = await apiFetch("/api/preview", {
			method: "POST",
			body: JSON.stringify({ html: "<h1>default</h1>" }),
		});
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.ok).toBe(true);
	});
});

test.describe("Preview asset path-traversal defence", () => {
	const sid = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
	let baseDir: string;
	let root: string;

	test.beforeAll(async () => {
		root = mkdtempSync(path.join(tmpdir(), "bobbit-asset-"));
		baseDir = path.join(root, "preview");
		mkdirSync(baseDir, { recursive: true });
		mkdirSync(path.join(baseDir, "gifs"), { recursive: true });
		writeFileSync(path.join(baseDir, "report.html"), "<html><body><img src=\"gifs/01.gif\"></body></html>", "utf-8");
		writeFileSync(path.join(baseDir, "gifs", "01.gif"), "GIF89a-stub-bytes", "utf-8");
		writeFileSync(path.join(root, "secret.txt"), "TOPSECRET", "utf-8");

		const resp = await apiFetch(`/api/preview?sessionId=${sid}`, {
			method: "POST",
			body: JSON.stringify({ kind: "file", path: path.join(baseDir, "report.html") }),
		});
		expect(resp.status).toBe(200);
	});

	test.afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("GET asset with valid relative path returns 200", async () => {
		const resp = await apiFetch(`/api/preview/asset?sessionId=${sid}&path=gifs/01.gif`);
		expect(resp.status).toBe(200);
		expect(resp.headers.get("content-type")).toMatch(/image\/gif/);
		const body = await resp.text();
		expect(body).toContain("GIF89a");
	});

	test("GET asset with ../ traversal returns 400", async () => {
		const resp = await apiFetch(`/api/preview/asset?sessionId=${sid}&path=../secret.txt`);
		expect(resp.status).toBe(400);
	});

	test("GET asset with deep ../../../ traversal returns 400", async () => {
		const resp = await apiFetch(`/api/preview/asset?sessionId=${sid}&path=../../../etc/passwd`);
		expect(resp.status).toBe(400);
	});

	test("GET asset with URL-encoded ../ returns 400", async () => {
		const resp = await apiFetch(`/api/preview/asset?sessionId=${sid}&path=..%2F..%2Fsecret.txt`);
		expect(resp.status).toBe(400);
	});

	test("GET asset with backslash returns 400", async () => {
		const resp = await apiFetch(`/api/preview/asset?sessionId=${sid}&path=foo%5C..%5C..%5Csecret.txt`);
		expect(resp.status).toBe(400);
	});

	test("GET asset with absolute path returns 400", async () => {
		const resp = await apiFetch(`/api/preview/asset?sessionId=${sid}&path=%2Fetc%2Fpasswd`);
		expect(resp.status).toBe(400);
	});

	test("GET asset with missing path returns 400", async () => {
		const resp = await apiFetch(`/api/preview/asset?sessionId=${sid}`);
		expect(resp.status).toBe(400);
	});

	test("GET asset with bad sessionId returns 400", async () => {
		const resp = await apiFetch(`/api/preview/asset?sessionId=not-a-uuid&path=gifs/01.gif`);
		expect(resp.status).toBe(400);
	});

	test("GET asset for sessionId with no preview meta returns 404", async () => {
		const resp = await apiFetch(`/api/preview/asset?sessionId=c3d4e5f6-a7b8-9012-cdef-123456789012&path=foo.gif`);
		expect(resp.status).toBe(404);
	});

	test("GET asset for missing sibling file returns 404", async () => {
		const resp = await apiFetch(`/api/preview/asset?sessionId=${sid}&path=missing.gif`);
		expect(resp.status).toBe(404);
	});

	test("GET render returns rewritten HTML with <base> tag", async () => {
		const resp = await apiFetch(`/api/preview/render?sessionId=${sid}`);
		expect(resp.status).toBe(200);
		expect(resp.headers.get("content-type")).toMatch(/text\/html/);
		const body = await resp.text();
		expect(body).toContain(`<base href="/api/preview/asset?sessionId=${sid}&path="`);
		expect(body).toContain("<img src=\"gifs/01.gif\"");
	});
});
