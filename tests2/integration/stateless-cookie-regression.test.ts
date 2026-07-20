import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { getGateway } from "../harness/gateway.js";

const REGRESSION = "STATELESS_COOKIE_REGRESSION";
const COOKIE_WRITE_SETTLE_MS = 250;

interface RequestCase {
	label: string;
	method: "GET" | "POST";
	path: string;
	body?: string;
	expectedStatus: number;
}

interface RawResponse {
	status: number;
	setCookies: string[];
	body: string;
}

function requestWithBearerOnly(baseURL: string, token: string, testCase: RequestCase): Promise<RawResponse> {
	return new Promise((resolve, reject) => {
		const headers: http.OutgoingHttpHeaders = {
			Authorization: `Bearer ${token}`,
		};
		if (testCase.body !== undefined) {
			headers["Content-Type"] = "application/json";
			headers["Content-Length"] = Buffer.byteLength(testCase.body);
		}
		const request = http.request(new URL(testCase.path, baseURL), {
			method: testCase.method,
			headers,
		}, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.on("end", () => resolve({
				status: response.statusCode ?? 0,
				setCookies: response.headers["set-cookie"] ?? [],
				body: Buffer.concat(chunks).toString("utf8"),
			}));
		});
		request.on("error", reject);
		if (testCase.body !== undefined) request.write(testCase.body);
		request.end();
	});
}

function registrySnapshot(file: string): { exists: boolean; bytes: number; entries: number } {
	if (!existsSync(file)) return { exists: false, bytes: 0, entries: 0 };
	const raw = readFileSync(file, "utf8");
	let entries = -1;
	try {
		const parsed = JSON.parse(raw) as { values?: Record<string, unknown> };
		entries = parsed.values && typeof parsed.values === "object" ? Object.keys(parsed.values).length : -1;
	} catch {
		// A stateless implementation must ignore and leave any legacy bytes alone.
	}
	return { exists: true, bytes: Buffer.byteLength(raw), entries };
}

describe("stateless browser-cookie issuance regression", () => {
	it("does not mint cookies or grow the legacy registry for Bearer-only and callback traffic", async () => {
		const gateway = await getGateway();
		const registryFile = join(gateway.bobbitDir, "state", "auth-cookies.json");

		// Let any pre-test debounced write settle so growth caused by the requests
		// below is measured independently of gateway fixture initialization.
		await delay(COOKIE_WRITE_SETTLE_MS);
		const before = registrySnapshot(registryFile);

		const cases: RequestCase[] = [
			{ label: "plain Bearer request 1", method: "GET", path: "/api/health", expectedStatus: 200 },
			{ label: "plain Bearer request 2", method: "GET", path: "/api/health", expectedStatus: 200 },
			{ label: "plain Bearer request 3", method: "GET", path: "/api/health", expectedStatus: 200 },
			{
				label: "provider before-prompt callback",
				method: "POST",
				path: "/api/sessions/stateless-cookie-missing/provider-hooks/before-prompt",
				body: JSON.stringify({ prompt: "regression probe" }),
				expectedStatus: 404,
			},
			{
				label: "provider before-compact callback",
				method: "POST",
				path: "/api/sessions/stateless-cookie-missing/provider-hooks/before-compact",
				body: JSON.stringify({ span: "regression probe" }),
				expectedStatus: 404,
			},
			{
				label: "Google Code Assist token callback",
				method: "GET",
				path: "/api/sessions/stateless-cookie-missing/google-code-assist/token",
				expectedStatus: 404,
			},
			{
				label: "tool grant callback",
				method: "POST",
				path: "/api/sessions/stateless-cookie-missing/tool-grant-request",
				body: "{}",
				expectedStatus: 400,
			},
			{
				label: "internal verification callback",
				method: "POST",
				path: "/api/internal/verification-result",
				body: "{}",
				expectedStatus: 400,
			},
		];

		for (const testCase of cases) {
			const response = await requestWithBearerOnly(gateway.baseURL, gateway.token, testCase);
			expect.soft(
				response.status,
				`${REGRESSION}: ${testCase.label} must reach its real gateway handler; body=${response.body}`,
			).toBe(testCase.expectedStatus);
			expect.soft(
				response.setCookies,
				`${REGRESSION}: ${testCase.label} is non-browser traffic and must not emit Set-Cookie`,
			).toEqual([]);
		}

		await delay(COOKIE_WRITE_SETTLE_MS);
		const after = registrySnapshot(registryFile);
		expect.soft(
			after.entries,
			`${REGRESSION}: excluded traffic must not grow auth-cookies.json; before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
		).toBe(before.entries);
		expect.soft(
			after.exists,
			`${REGRESSION}: stateless authentication must not create auth-cookies.json; before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
		).toBe(false);
	});
});
