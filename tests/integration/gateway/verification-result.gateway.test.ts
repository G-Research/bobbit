/**
 * E2E tests for the POST /api/internal/verification-result endpoint.
 *
 * Verifies request validation (400), unknown session handling (404),
 * and the happy path where a pending resolver is called with the
 * correct VerificationResult.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { vi } from "vitest";
import { test, expect } from "../../../tests/support/harnesses/integration/gateway/in-process-harness.js";
import { apiFetch } from "../../../tests/support/harnesses/integration/gateway/e2e-setup.js";

const MAX_REPORT_BYTES = 10 * 1024 * 1024;
const VERIFIER_AUTH_ERROR = {
	error: "Valid verifier session secret is required",
	code: "VERIFIER_SESSION_SECRET_REQUIRED",
};

function verifierHeaders(gateway: any, sessionId: string): Record<string, string> {
	return { "X-Bobbit-Session-Secret": gateway.sessionManager.sessionSecretStore.getOrCreateSecret(sessionId) };
}

async function postVerification(
	gateway: any,
	body: Record<string, unknown>,
	headers: Record<string, string>,
): Promise<Response> {
	return fetch(`${gateway.baseURL}/api/internal/verification-result`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

async function authenticatedBrowserCookie(gateway: any): Promise<string> {
	const origin = new URL(gateway.baseURL).origin;
	const response = await fetch(`${gateway.baseURL}/api/health`, {
		headers: {
			Authorization: `Bearer ${gateway.token}`,
			Origin: origin,
			"Sec-Fetch-Site": "same-origin",
			"Sec-Fetch-Mode": "cors",
		},
	});
	const setCookie = response.headers.get("set-cookie") ?? "";
	const cookie = /bobbit_session=[^;,]+/.exec(setCookie)?.[0];
	if (!cookie) throw new Error(`failed to mint signed browser cookie: ${response.status} ${await response.text()}`);
	return cookie;
}

function matchingPathCalls(spy: { mock: { calls: unknown[][] } }, expectedPath: string): number {
	const canonical = path.resolve(expectedPath);
	return spy.mock.calls.filter(([candidate]) => typeof candidate === "string" && path.resolve(candidate) === canonical).length;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
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

	test("binds a pending result to the exact verifier secret, not other admitted credentials", async ({ gateway, scope }) => {
		const harness = (gateway.sessionManager as any)._verificationHarness;
		const target = "test-session-auth-target";
		const foreign = (await scope.createSession({})).id as string;
		const projectId = `verification-auth-${process.pid}-${Date.now()}`;
		const sandboxStore = gateway.sessionManager.sandboxTokenStore;
		const sandboxToken = sandboxStore.register(projectId);
		sandboxStore.addSession(projectId, target);
		const browserCookie = await authenticatedBrowserCookie(gateway);
		const resolver = vi.fn();
		harness.pendingResults.set(target, resolver);
		try {
			const cases = [
				{
					label: "same-scope sandbox bearer with only the guessed public sessionId",
					headers: { Authorization: `Bearer ${sandboxToken}` },
				},
				{
					label: "admin bearer without a verifier secret",
					headers: { Authorization: `Bearer ${gateway.token}` },
				},
				{
					label: "signed browser cookie without a verifier secret",
					headers: {
						Cookie: browserCookie,
						Origin: new URL(gateway.baseURL).origin,
						"Sec-Fetch-Site": "same-origin",
						"Sec-Fetch-Mode": "cors",
					},
				},
				{
					label: "another real session's secret",
					headers: {
						Authorization: `Bearer ${gateway.token}`,
						...verifierHeaders(gateway, foreign),
					},
				},
			];

			for (const testCase of cases) {
				const response = await postVerification(
					gateway,
					{ sessionId: target, verdict: "pass", summary: "forged" },
					testCase.headers,
				);
				const responseBody = await response.json();
				expect.soft(response.status, `${testCase.label}: ${JSON.stringify(responseBody)}`).toBe(403);
				expect.soft(responseBody, `${testCase.label}: stable verifier error`).toEqual(VERIFIER_AUTH_ERROR);
				expect.soft(resolver, `${testCase.label}: pending resolver must remain untouched`).not.toHaveBeenCalled();
			}

			const accepted = await postVerification(
				gateway,
				{ sessionId: target, verdict: "pass", summary: "authentic" },
				{ Authorization: `Bearer ${sandboxToken}`, ...verifierHeaders(gateway, target) },
			);
			expect(accepted.status, await accepted.text()).toBe(200);
			expect(resolver).toHaveBeenCalledTimes(1);
			expect(resolver).toHaveBeenCalledWith({ verdict: true, summary: "authentic", reportHtml: undefined });
		} finally {
			harness.pendingResults.delete(target);
			sandboxStore.remove(projectId);
		}
	});

	test("rejects verdicts other than exact pass or fail before resolving", async ({ gateway }) => {
		const harness = (gateway.sessionManager as any)._verificationHarness;
		const sessionId = "test-session-invalid-verdict";
		const resolver = vi.fn();
		harness.pendingResults.set(sessionId, resolver);
		try {
			for (const verdict of ["Pass", "PASS", "passed", "failure", "true"]) {
				const response = await apiFetch("/api/internal/verification-result", {
					method: "POST",
					headers: verifierHeaders(gateway, sessionId),
					body: JSON.stringify({ sessionId, verdict, summary: "must not resolve" }),
				});
				const body = await response.json();
				expect.soft(response.status, `${verdict}: ${JSON.stringify(body)}`).toBe(400);
				expect.soft(body.error, verdict).toBe("Invalid verdict: expected 'pass' or 'fail'");
			}
			expect(resolver).not.toHaveBeenCalled();
		} finally {
			harness.pendingResults.delete(sessionId);
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

	test("rejects report_html_file without touching the supplied host path", async ({ gateway }) => {
		const harness = (gateway.sessionManager as any)._verificationHarness;
		const sessionId = "test-session-file";
		const reportPath = path.join(gateway.bobbitDir, `gateway-host-read-probe-${process.pid}.html`);
		fs.writeFileSync(reportPath, "gateway must not read this marker");
		const statSpy = vi.spyOn(fs, "statSync");
		const realpathSpy = vi.spyOn(fs, "realpathSync");
		const readSpy = vi.spyOn(fs, "readFileSync");
		const resolver = vi.fn();
		harness.pendingResults.set(sessionId, resolver);
		try {
			const response = await apiFetch("/api/internal/verification-result", {
				method: "POST",
				headers: verifierHeaders(gateway, sessionId),
				body: JSON.stringify({
					sessionId,
					verdict: "pass",
					summary: "attempted host read",
					report_html_file: reportPath,
				}),
			});
			const responseBody = await response.json();

			expect(response.status, JSON.stringify(responseBody)).toBe(400);
			expect(responseBody).toEqual({
				error: "report_html_file is not accepted by the gateway; upload its contents as report_html",
			});
			expect(resolver).not.toHaveBeenCalled();
			expect(matchingPathCalls(statSpy, reportPath), "gateway stat of report_html_file").toBe(0);
			expect(matchingPathCalls(realpathSpy, reportPath), "gateway realpath of report_html_file").toBe(0);
			expect(matchingPathCalls(readSpy, reportPath), "gateway read of report_html_file").toBe(0);
		} finally {
			harness.pendingResults.delete(sessionId);
			statSpy.mockRestore();
			realpathSpy.mockRestore();
			readSpy.mockRestore();
			fs.rmSync(reportPath, { force: true });
		}
	});

	test("passes inline file URLs unchanged without gateway filesystem access", async ({ gateway, scope }) => {
		const harness = (gateway.sessionManager as any)._verificationHarness;
		const projectRoot = path.join(gateway.bobbitDir, "default-project");
		fs.mkdirSync(projectRoot, { recursive: true });
		const workspace = fs.mkdtempSync(path.join(projectRoot, "verification-inline-"));
		const imagePath = path.join(workspace, "private.png");
		fs.writeFileSync(imagePath, Buffer.from("gateway must not inline this marker"));
		const session = await scope.createSession({ cwd: workspace });
		const sessionId = session.id as string;
		const htmlReport = `<img src="${pathToFileURL(imagePath).href}" alt="must remain external">`;
		const resolver = vi.fn();
		harness.pendingResults.set(sessionId, resolver);
		const statSpy = vi.spyOn(fs, "statSync");
		const readSpy = vi.spyOn(fs, "readFileSync");
		try {
			const response = await apiFetch("/api/internal/verification-result", {
				method: "POST",
				headers: verifierHeaders(gateway, sessionId),
				body: JSON.stringify({ sessionId, verdict: "pass", summary: "inline", report_html: htmlReport }),
			});

			expect(response.status, await response.text()).toBe(200);
			expect(resolver).toHaveBeenCalledTimes(1);
			expect(resolver.mock.calls[0][0].reportHtml).toBe(htmlReport);
			expect(matchingPathCalls(statSpy, imagePath), "gateway stat of inline file URL").toBe(0);
			expect(matchingPathCalls(readSpy, imagePath), "gateway read of inline file URL").toBe(0);
		} finally {
			harness.pendingResults.delete(sessionId);
			statSpy.mockRestore();
			readSpy.mockRestore();
			await gateway.api(`/api/sessions/${sessionId}?purge=true`, { method: "DELETE" });
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});

	test("accepts an escape-heavy report at 10 MiB and rejects one decoded byte more", async ({ gateway }) => {
		const harness = (gateway.sessionManager as any)._verificationHarness;
		const sessionId = "test-session-report-boundary";
		const resolver = vi.fn();
		const exactReport = `\\"`.repeat(MAX_REPORT_BYTES / 2);
		expect(Buffer.byteLength(exactReport)).toBe(MAX_REPORT_BYTES);
		harness.pendingResults.set(sessionId, resolver);
		try {
			const accepted = await apiFetch("/api/internal/verification-result", {
				method: "POST",
				headers: verifierHeaders(gateway, sessionId),
				body: JSON.stringify({ sessionId, verdict: "pass", summary: "exact limit", report_html: exactReport }),
			});
			expect(accepted.status, await accepted.text()).toBe(200);
			expect(resolver).toHaveBeenCalledTimes(1);
			const uploaded = resolver.mock.calls[0][0].reportHtml as string;
			expect(Buffer.byteLength(uploaded)).toBe(MAX_REPORT_BYTES);
			expect(sha256(uploaded)).toBe(sha256(exactReport));

			const rejected = await apiFetch("/api/internal/verification-result", {
				method: "POST",
				headers: verifierHeaders(gateway, sessionId),
				body: JSON.stringify({ sessionId, verdict: "pass", summary: "over limit", report_html: `${exactReport}x` }),
			});
			const rejectedBody = await rejected.json();
			expect(rejected.status, JSON.stringify(rejectedBody)).toBe(400);
			expect(rejectedBody.error).toBe(`HTML report too large (max ${MAX_REPORT_BYTES} bytes)`);
			expect(resolver).toHaveBeenCalledTimes(1);
		} finally {
			harness.pendingResults.delete(sessionId);
		}
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
