import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { getGateway, type GatewayFixture } from "../harness/gateway.js";
import { createScope } from "../harness/scope.js";
import { loadServerTestRuntime } from "../harness/server-runtime.js";

const COOKIE_NAME = "bobbit_session";
const COOKIE_SIGNING_KEY_FILE = "cookie-signing-key";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const COOKIE_RENEWAL_WINDOW_SECONDS = 60 * 60 * 24 * 7;
const LEGACY_COOKIE = "a".repeat(64);
const WRITE_SETTLE_MS = 200;
const MAX_STATELESS_REQUEST_MS = 1_500;
const PREVIEW_SSE_SESSION_ID = "00000000-0000-4000-8000-000000000001";

interface RawResponse {
	status: number;
	setCookies: string[];
	body: string;
}

interface RequestOptions {
	method?: "GET" | "POST";
	headers?: Record<string, string>;
	body?: string;
}

function rawRequest(baseURL: string, path: string, options: RequestOptions = {}): Promise<RawResponse> {
	return new Promise((resolve, reject) => {
		const headers: http.OutgoingHttpHeaders = { ...(options.headers ?? {}) };
		if (options.body !== undefined) {
			headers["Content-Type"] ??= "application/json";
			headers["Content-Length"] = Buffer.byteLength(options.body);
		}
		const request = http.request(new URL(path, baseURL), {
			method: options.method ?? "GET",
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
		if (options.body !== undefined) request.write(options.body);
		request.end();
	});
}

function openStreamingRequest(baseURL: string, path: string, options: RequestOptions = {}): Promise<RawResponse> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const request = http.request(new URL(path, baseURL), {
			method: options.method ?? "GET",
			headers: options.headers,
		}, (response) => {
			settled = true;
			const result = {
				status: response.statusCode ?? 0,
				setCookies: response.headers["set-cookie"] ?? [],
				body: "",
			};
			response.destroy();
			request.destroy();
			resolve(result);
		});
		request.on("error", (error) => {
			if (!settled) reject(error);
		});
		request.end();
	});
}

function browserHeaders(
	gateway: GatewayFixture,
	overrides: Record<string, string | undefined> = {},
): Record<string, string> {
	const origin = new URL(gateway.baseURL).origin;
	const headers: Record<string, string | undefined> = {
		Authorization: `Bearer ${gateway.token}`,
		Host: new URL(gateway.baseURL).host,
		Origin: origin,
		"Sec-Fetch-Site": "same-origin",
		"Sec-Fetch-Mode": "cors",
		...overrides,
	};
	return Object.fromEntries(
		Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
}

function bobbitSetCookies(response: RawResponse): string[] {
	return response.setCookies.filter((value) => value.startsWith(`${COOKIE_NAME}=`));
}

function cookiePair(setCookie: string): string {
	return setCookie.split(";", 1)[0];
}

function cookieValue(setCookie: string): string {
	return cookiePair(setCookie).slice(`${COOKIE_NAME}=`.length);
}

function expectSignedCookie(response: RawResponse): string {
	const cookies = bobbitSetCookies(response);
	expect(cookies, `expected one signed ${COOKIE_NAME} cookie; body=${response.body}`).toHaveLength(1);
	const value = cookieValue(cookies[0]);
	expect(value).toMatch(/^v1\.\d+\.\d+\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
	return cookies[0];
}

function digest(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function signedCookieAtRenewalBoundary(gateway: GatewayFixture): Promise<string> {
	const runtime = await loadServerTestRuntime();
	const signingKey = readFileSync(join(runtime.bobbitDir.serverSecretsDir(), COOKIE_SIGNING_KEY_FILE));
	expect(signingKey).toHaveLength(32);

	// Derive the boundary from the same injected clock used by the live gateway.
	// Backdating iat avoids advancing the shared fork clock while leaving exactly
	// seven days before expiry after both sides floor milliseconds to Unix seconds.
	const now = Math.floor(gateway.clock.now() / 1_000);
	const expiresAt = now + COOKIE_RENEWAL_WINDOW_SECONDS;
	const issuedAt = expiresAt - COOKIE_MAX_AGE_SECONDS;
	const nonce = Buffer.alloc(16, 0x5a).toString("base64url");
	const payload = `v1.${issuedAt}.${expiresAt}.${nonce}`;
	const signature = createHmac("sha256", signingKey).update(payload, "ascii").digest("base64url");
	return `${payload}.${signature}`;
}

async function withRegistryPreserved<T>(gateway: GatewayFixture, action: (file: string) => Promise<T>): Promise<T> {
	const file = join(gateway.bobbitDir, "state", "auth-cookies.json");
	// A legacy implementation writes on a short debounce. Let unrelated fixture
	// boot activity settle before taking ownership of this path.
	await delay(WRITE_SETTLE_MS);
	const existed = existsSync(file);
	const previous = existed ? readFileSync(file) : undefined;
	try {
		return await action(file);
	} finally {
		// Catch and remove any delayed write caused by a failing legacy server.
		await delay(WRITE_SETTLE_MS);
		if (previous) writeFileSync(file, previous);
		else rmSync(file, { force: true });
	}
}

describe.sequential("stateless cookie behavior through the real gateway", () => {
	it("mints only for accepted direct, originless, localhost, and Vite browser shapes", async () => {
		const gateway = await getGateway();
		await withRegistryPreserved(gateway, async () => {
			const target = new URL(gateway.baseURL);
			const cases: Array<{ label: string; headers: Record<string, string> }> = [
				{
					label: "direct production-style same-origin request",
					headers: browserHeaders(gateway),
				},
				{
					label: "originless same-origin GET",
					headers: browserHeaders(gateway, { Origin: undefined, "Sec-Fetch-Mode": "same-origin" }),
				},
				{
					label: "localhost direct request",
					headers: browserHeaders(gateway, {
						Host: `localhost:${target.port}`,
						Origin: `http://localhost:${target.port}`,
					}),
				},
				{
					label: "Vite proxy request with preserved dev-server origin",
					headers: browserHeaders(gateway, {
						Host: `localhost:${target.port}`,
						Origin: "http://localhost:5173",
					}),
				},
			];

			for (const testCase of cases) {
				const response = await rawRequest(gateway.baseURL, "/api/health", { headers: testCase.headers });
				expect.soft(response.status, `${testCase.label}: ${response.body}`).toBe(200);
				expectSignedCookie(response);
			}
		});
	});

	it("rejects untrusted or conflicting browser metadata without weakening Bearer auth", async () => {
		const gateway = await getGateway();
		await withRegistryPreserved(gateway, async () => {
			const origin = new URL(gateway.baseURL).origin;
			const cases: Array<{ label: string; headers: Record<string, string> }> = [
				{ label: "plain Bearer", headers: { Authorization: `Bearer ${gateway.token}` } },
				{ label: "cross-site", headers: browserHeaders(gateway, { "Sec-Fetch-Site": "cross-site" }) },
				{ label: "same-site", headers: browserHeaders(gateway, { "Sec-Fetch-Site": "same-site" }) },
				{ label: "navigation mode", headers: browserHeaders(gateway, { "Sec-Fetch-Mode": "navigate" }) },
				{ label: "null origin", headers: browserHeaders(gateway, { Origin: "null" }) },
				{ label: "mismatched origin", headers: browserHeaders(gateway, { Origin: "https://untrusted.example" }) },
				{ label: "multiple origins", headers: browserHeaders(gateway, { Origin: `${origin}, https://untrusted.example` }) },
				{
					label: "conflicting Fetch Metadata",
					headers: browserHeaders(gateway, { "Sec-Fetch-Site": "same-origin, cross-site" }),
				},
			];

			for (const testCase of cases) {
				const response = await rawRequest(gateway.baseURL, "/api/health", { headers: testCase.headers });
				expect.soft(response.status, `${testCase.label}: Bearer auth must still succeed`).toBe(200);
				expect.soft(response.setCookies, `${testCase.label} must not emit Set-Cookie`).toEqual([]);
			}
		});
	});

	it("never sets cookies for plain Bearer, session-bound, sandbox, or callback traffic", async () => {
		const gateway = await getGateway();
		await withRegistryPreserved(gateway, async (registryFile) => {
			rmSync(registryFile, { force: true });
			const excluded: Array<{ label: string; path: string; options: RequestOptions }> = [
				{
					label: "plain Bearer request one",
					path: "/api/health",
					options: { headers: { Authorization: `Bearer ${gateway.token}` } },
				},
				{
					label: "plain Bearer request two",
					path: "/api/health",
					options: { headers: { Authorization: `Bearer ${gateway.token}` } },
				},
				...[
					"x-bobbit-session-id",
					"x-bobbit-spawning-session",
					"x-bobbit-session-secret",
				].map((header) => ({
					label: `${header} identity`,
					path: "/api/health",
					options: { headers: browserHeaders(gateway, { [header]: "session-bound-probe" }) },
				})),
				{
					label: "provider before-prompt callback",
					path: "/api/sessions/stateless-cookie-missing/provider-hooks/before-prompt",
					options: { method: "POST", headers: browserHeaders(gateway), body: JSON.stringify({ prompt: "probe" }) },
				},
				{
					label: "provider before-compact callback",
					path: "/api/sessions/stateless-cookie-missing/provider-hooks/before-compact",
					options: { method: "POST", headers: browserHeaders(gateway), body: JSON.stringify({ span: "probe" }) },
				},
				{
					label: "Google Code Assist callback",
					path: "/api/sessions/stateless-cookie-missing/google-code-assist/token",
					options: { headers: browserHeaders(gateway) },
				},
				{
					label: "tool grant callback",
					path: "/api/sessions/stateless-cookie-missing/tool-grant-request",
					options: { method: "POST", headers: browserHeaders(gateway), body: "{}" },
				},
				{
					label: "internal verification callback",
					path: "/api/internal/verification-result",
					options: { method: "POST", headers: browserHeaders(gateway), body: "{}" },
				},
			];

			for (const testCase of excluded) {
				const response = await rawRequest(gateway.baseURL, testCase.path, testCase.options);
				expect.soft(response.status, `${testCase.label} must pass the global auth check`).not.toBe(401);
				expect.soft(response.setCookies, `${testCase.label} must not emit Set-Cookie`).toEqual([]);
			}

			const sandboxProject = `stateless-cookie-sandbox-${process.pid}-${Date.now()}`;
			const sandboxStore = gateway.sessionManager.sandboxTokenStore;
			const sandboxToken = sandboxStore.register(sandboxProject);
			try {
				const sandboxOnly = await rawRequest(gateway.baseURL, "/api/health", {
					headers: browserHeaders(gateway, { Authorization: `Bearer ${sandboxToken}` }),
				});
				expect.soft(sandboxOnly.status).toBe(200);
				expect.soft(sandboxOnly.setCookies, "sandbox Bearer traffic must not emit Set-Cookie").toEqual([]);

				const mixed = await rawRequest(
					gateway.baseURL,
					`/api/health?token=${encodeURIComponent(sandboxToken)}`,
					{ headers: browserHeaders(gateway) },
				);
				expect.soft(mixed.status).toBe(200);
				expect.soft(
					mixed.setCookies,
					"a presented sandbox credential must suppress issuance even when admin Bearer wins auth",
				).toEqual([]);
			} finally {
				sandboxStore.remove(sandboxProject);
			}

			await delay(WRITE_SETTLE_MS);
			expect(existsSync(registryFile), "excluded traffic must not create auth-cookies.json").toBe(false);
		});
	});

	it("rejects extra-segment Google token paths instead of dispatching them as callbacks", async () => {
		const gateway = await getGateway();
		const scope = createScope(gateway);
		try {
			const session = await scope.createSession({});
			const response = await rawRequest(
				gateway.baseURL,
				`/api/sessions/${session.id}/extra/google-code-assist/token`,
				{ headers: { Authorization: `Bearer ${gateway.token}` } },
			);
			expect(response.status, response.body).toBe(404);
			expect(response.setCookies, "a rejected noncanonical callback path must not mint a cookie").toEqual([]);
		} finally {
			await scope.cleanup();
		}
	});

	it("renews a near-expiry signed cookie once on API traffic but never on preview SSE", async () => {
		const gateway = await getGateway();
		const expiringValue = await signedCookieAtRenewalBoundary(gateway);
		const expiringPair = `${COOKIE_NAME}=${expiringValue}`;
		const cookieOnlyBrowserHeaders = browserHeaders(gateway, {
			Authorization: undefined,
			Cookie: expiringPair,
		});

		const sse = await openStreamingRequest(
			gateway.baseURL,
			`/api/sessions/${PREVIEW_SSE_SESSION_ID}/preview-events`,
			{ headers: cookieOnlyBrowserHeaders },
		);
		expect(sse.status).toBe(200);
		expect(sse.setCookies, "preview SSE must authenticate without renewing a near-expiry cookie").toEqual([]);

		const renewal = await rawRequest(gateway.baseURL, "/api/health", {
			headers: cookieOnlyBrowserHeaders,
		});
		expect(renewal.status, renewal.body).toBe(200);
		const replacement = expectSignedCookie(renewal);
		expect(cookieValue(replacement)).not.toBe(expiringValue);

		const followUp = await rawRequest(gateway.baseURL, "/api/health", {
			headers: browserHeaders(gateway, {
				Authorization: undefined,
				Cookie: cookiePair(replacement),
			}),
		});
		expect(followUp.status, followUp.body).toBe(200);
		expect(followUp.setCookies, "the fresh replacement must not be issued again").toEqual([]);
	});

	it("upgrades a legacy cookie once and reuses the signed cookie without repeated issuance", async () => {
		const gateway = await getGateway();
		await withRegistryPreserved(gateway, async (registryFile) => {
			rmSync(registryFile, { force: true });
			const upgrade = await rawRequest(gateway.baseURL, "/api/sessions", {
				headers: browserHeaders(gateway, { Cookie: `${COOKIE_NAME}=${LEGACY_COOKIE}` }),
			});
			expect(upgrade.status, upgrade.body).toBe(200);
			const setCookie = expectSignedCookie(upgrade);
			const attributes = setCookie.split(";").map((part) => part.trim());
			expect(attributes).toContain("HttpOnly");
			expect(attributes).toContain("SameSite=Lax");
			expect(attributes).toContain("Path=/");
			expect(attributes).toContain("Max-Age=2592000");
			expect(attributes).toContain("Secure");

			const signedPair = cookiePair(setCookie);
			const cookieOnly = await rawRequest(gateway.baseURL, "/api/sessions", {
				headers: { Cookie: signedPair },
			});
			expect(cookieOnly.status, `signed cookie must authenticate without browser metadata: ${cookieOnly.body}`).toBe(200);
			expect(cookieOnly.setCookies).toEqual([]);

			const browserFollowUp = await rawRequest(gateway.baseURL, "/api/sessions", {
				headers: browserHeaders(gateway, { Authorization: undefined, Cookie: signedPair }),
			});
			expect(browserFollowUp.status, browserFollowUp.body).toBe(200);
			expect(browserFollowUp.setCookies, "a fresh valid cookie must not be refreshed").toEqual([]);

			await delay(WRITE_SETTLE_MS);
			expect(existsSync(registryFile), "legacy upgrade must remain stateless").toBe(false);
		});
	});

	it("leaves post-start valid, corrupt, and large legacy registries byte-identical with bounded request time", async () => {
		// The shared integration fixture allocates its private state root inside
		// getGateway() and exposes it only after start(), so it has no clean pre-boot
		// injection point. A true pre-start case would require a harness API change
		// outside this task's ownership; the structural no-registry guard provides
		// that startup proof while this live test pins request latency and byte identity.
		const gateway = await getGateway();
		await withRegistryPreserved(gateway, async (registryFile) => {
			const fixtures: Array<{ label: string; bytes: Buffer }> = [
				{
					label: "valid legacy registry",
					bytes: Buffer.from(JSON.stringify({
						version: 1,
						issuedAt: 1,
						values: { [LEGACY_COOKIE]: { issuedAt: 1 } },
					})),
				},
				{ label: "corrupt legacy registry", bytes: Buffer.from("{ definitely not valid JSON") },
				{ label: "large corrupt legacy registry", bytes: Buffer.alloc(32 * 1024 * 1024, 0x78) },
			];

			for (const fixture of fixtures) {
				writeFileSync(registryFile, fixture.bytes);
				const beforeDigest = digest(fixture.bytes);
				const startedAt = performance.now();
				const response = await rawRequest(gateway.baseURL, "/api/health", {
					headers: browserHeaders(gateway, { Cookie: `${COOKIE_NAME}=${LEGACY_COOKIE}` }),
				});
				const elapsedMs = performance.now() - startedAt;

				expect.soft(response.status, `${fixture.label}: ${response.body}`).toBe(200);
				expectSignedCookie(response);
				expect.soft(
					elapsedMs,
					`${fixture.label} must not enter the request path (${elapsedMs.toFixed(1)} ms)`,
				).toBeLessThan(MAX_STATELESS_REQUEST_MS);

				await delay(WRITE_SETTLE_MS);
				expect.soft(statSync(registryFile).size, `${fixture.label} size changed`).toBe(fixture.bytes.length);
				expect.soft(digest(readFileSync(registryFile)), `${fixture.label} bytes changed`).toBe(beforeDigest);
			}
		});
	});
});
