/**
 * E2E tests for the POST /api/internal/verification-result endpoint.
 *
 * Verifies request validation (400), unknown session handling (404),
 * and the happy path where a pending resolver is called with the
 * correct VerificationResult.
 */
import { test, expect } from "../../../tests/support/harnesses/integration/gateway/in-process-harness.js";
import { apiFetch } from "../../../tests/support/harnesses/integration/gateway/e2e-setup.js";

function verifierHeaders(gateway: any, sessionId: string): Record<string, string> {
	return { "X-Bobbit-Session-Secret": gateway.sessionManager.sessionSecretStore.getOrCreateSecret(sessionId) };
}

test.describe("POST /api/internal/verification-result", () => {
	test("returns 404 for an authenticated session with no pending verification", async ({ gateway }) => {
		const sessionId = "unknown-session-id";
		const res = await apiFetch("/api/internal/verification-result", {
			method: "POST",
			headers: verifierHeaders(gateway, sessionId),
			body: JSON.stringify({ sessionId, verdict: "pass", summary: "All good" }),
		});
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toContain("No pending verification");
	});

	test("returns 400 when sessionId is missing", async () => {
		const res = await apiFetch("/api/internal/verification-result", {
			method: "POST",
			body: JSON.stringify({ verdict: "pass", summary: "test" }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("Missing required fields");
	});

	test("returns 400 when verdict is missing", async () => {
		const res = await apiFetch("/api/internal/verification-result", {
			method: "POST",
			body: JSON.stringify({ sessionId: "s1", summary: "test" }),
		});
		expect(res.status).toBe(400);
	});

	test("returns 400 when summary is missing", async () => {
		const res = await apiFetch("/api/internal/verification-result", {
			method: "POST",
			body: JSON.stringify({ sessionId: "s1", verdict: "pass" }),
		});
		expect(res.status).toBe(400);
	});

	test("returns 400 when sessionId is not a string", async () => {
		const res = await apiFetch("/api/internal/verification-result", {
			method: "POST",
			body: JSON.stringify({ sessionId: 123, verdict: "pass", summary: "test" }),
		});
		expect(res.status).toBe(400);
	});

	test("returns 400 when verdict is not a string", async () => {
		const res = await apiFetch("/api/internal/verification-result", {
			method: "POST",
			body: JSON.stringify({ sessionId: "s1", verdict: true, summary: "test" }),
		});
		expect(res.status).toBe(400);
	});

	test("returns 400 when summary is not a string", async () => {
		const res = await apiFetch("/api/internal/verification-result", {
			method: "POST",
			body: JSON.stringify({ sessionId: "s1", verdict: "pass", summary: 42 }),
		});
		expect(res.status).toBe(400);
	});

	test("rejects a missing or foreign verifier session secret", async ({ gateway }) => {
		const harness = (gateway.sessionManager as any)._verificationHarness;
		const target = "test-session-auth-target";
		harness.pendingResults.set(target, () => {});
		try {
			for (const headers of [undefined, verifierHeaders(gateway, "test-session-auth-foreign")]) {
				const res = await apiFetch("/api/internal/verification-result", {
					method: "POST",
					headers,
					body: JSON.stringify({ sessionId: target, verdict: "pass", summary: "forged" }),
				});
				expect(res.status).toBe(403);
				expect(await res.json()).toMatchObject({ code: "VERIFIER_SESSION_SECRET_REQUIRED" });
			}
		} finally {
			harness.pendingResults.delete(target);
		}
	});

	test("resolves pending verification result with pass verdict", async ({ gateway }) => {
		// Access verificationHarness through sessionManager (private but accessible via any)
		const harness = (gateway.sessionManager as any)._verificationHarness;
		expect(harness).toBeTruthy();
		const sessionId = "test-session-pass";

		const promise = new Promise<any>((resolve) => {
			harness.pendingResults.set(sessionId, (result: any) => {
				resolve(result);
			});
		});

		const res = await apiFetch("/api/internal/verification-result", {
			method: "POST",
			headers: verifierHeaders(gateway, sessionId),
			body: JSON.stringify({
				sessionId,
				verdict: "pass",
				summary: "All tests passed successfully",
			}),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);

		// Verify the resolver was called with correct structured data
		const result = await promise;
		expect(result.verdict).toBe(true); // "pass" → true
		expect(result.summary).toBe("All tests passed successfully");
		expect(result.reportHtml).toBeUndefined();

		// Clean up
		harness.pendingResults.delete("test-session-pass");
	});

	test("resolves pending verification result with fail verdict", async ({ gateway }) => {
		const harness = (gateway.sessionManager as any)._verificationHarness;
		const sessionId = "test-session-fail";

		const promise = new Promise<any>((resolve) => {
			harness.pendingResults.set(sessionId, (result: any) => {
				resolve(result);
			});
		});

		const res = await apiFetch("/api/internal/verification-result", {
			method: "POST",
			headers: verifierHeaders(gateway, sessionId),
			body: JSON.stringify({
				sessionId,
				verdict: "fail",
				summary: "3 critical failures found",
			}),
		});

		expect(res.status).toBe(200);

		const result = await promise;
		expect(result.verdict).toBe(false); // "fail" → false
		expect(result.summary).toBe("3 critical failures found");
		expect(result.reportHtml).toBeUndefined();

		harness.pendingResults.delete("test-session-fail");
	});

	test("passes report_html through when provided", async ({ gateway }) => {
		const harness = (gateway.sessionManager as any)._verificationHarness;
		const sessionId = "test-session-html";

		const promise = new Promise<any>((resolve) => {
			harness.pendingResults.set(sessionId, resolve);
		});

		const htmlReport = "<html><body><h1>QA Report</h1><p>All good</p></body></html>";
		const res = await apiFetch("/api/internal/verification-result", {
			method: "POST",
			headers: verifierHeaders(gateway, sessionId),
			body: JSON.stringify({
				sessionId,
				verdict: "pass",
				summary: "QA passed",
				report_html: htmlReport,
			}),
		});

		expect(res.status).toBe(200);

		const result = await promise;
		expect(result.verdict).toBe(true);
		expect(result.summary).toBe("QA passed");
		expect(result.reportHtml).toBe(htmlReport);

		harness.pendingResults.delete("test-session-html");
	});

	test("rejects report_html_file without dereferencing the supplied host path", async ({ gateway }) => {
		const harness = (gateway.sessionManager as any)._verificationHarness;
		const sessionId = "test-session-file";
		let resolved = false;
		harness.pendingResults.set(sessionId, () => { resolved = true; });
		try {
			const res = await apiFetch("/api/internal/verification-result", {
				method: "POST",
				headers: verifierHeaders(gateway, sessionId),
				body: JSON.stringify({
					sessionId,
					verdict: "pass",
					summary: "attempted host read",
					report_html_file: process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/passwd",
				}),
			});

			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: expect.stringContaining("not accepted by the gateway"),
			});
			expect(resolved).toBe(false);
		} finally {
			harness.pendingResults.delete(sessionId);
		}
	});

	test("does not dereference file URLs embedded in inline HTML", async ({ gateway }) => {
		const harness = (gateway.sessionManager as any)._verificationHarness;
		const sessionId = "test-session-file-url";
		const htmlReport = `<img src="file://${process.platform === "win32" ? "C:/Windows/win.ini" : "/etc/passwd"}">`;
		const promise = new Promise<any>((resolve) => harness.pendingResults.set(sessionId, resolve));

		const res = await apiFetch("/api/internal/verification-result", {
			method: "POST",
			headers: verifierHeaders(gateway, sessionId),
			body: JSON.stringify({ sessionId, verdict: "pass", summary: "inline", report_html: htmlReport }),
		});

		expect(res.status).toBe(200);
		expect((await promise).reportHtml).toBe(htmlReport);
		harness.pendingResults.delete(sessionId);
	});

	test("ignores non-string report_html", async ({ gateway }) => {
		const harness = (gateway.sessionManager as any)._verificationHarness;
		const sessionId = "test-session-bad-html";
		const promise = new Promise<any>((resolve) => {
			harness.pendingResults.set(sessionId, resolve);
		});

		const res = await apiFetch("/api/internal/verification-result", {
			method: "POST",
			headers: verifierHeaders(gateway, sessionId),
			body: JSON.stringify({ sessionId, verdict: "pass", summary: "ok", report_html: 12345 }),
		});

		expect(res.status).toBe(200);
		expect((await promise).reportHtml).toBeUndefined();
		harness.pendingResults.delete(sessionId);
	});

	test("accepts repeat delivery only from the same authenticated verifier", async ({ gateway }) => {
		const harness = (gateway.sessionManager as any)._verificationHarness;
		const sessionId = "test-session-once";
		const headers = verifierHeaders(gateway, sessionId);
		harness.pendingResults.set(sessionId, () => {});

		const res1 = await apiFetch("/api/internal/verification-result", {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId, verdict: "pass", summary: "ok" }),
		});
		expect(res1.status).toBe(200);

		const res2 = await apiFetch("/api/internal/verification-result", {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId, verdict: "fail", summary: "re-call" }),
		});
		expect(res2.status).toBe(200);
		harness.pendingResults.delete(sessionId);
	});
});
