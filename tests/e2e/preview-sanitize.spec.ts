import { test, expect } from "./in-process-harness.js";
import { readE2EToken, base } from "./e2e-setup.js";

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
