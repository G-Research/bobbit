import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	classifyBrowserCookieEligibility,
	type BrowserCookieEligibilityContext,
	type BrowserCookieHeaders,
	type BrowserCookieRequestMetadata,
} from "../../src/server/auth/browser-cookie.ts";

const BASE_HEADERS: BrowserCookieHeaders = {
	host: "bobbit.example",
	origin: "https://bobbit.example",
	"sec-fetch-site": "same-origin",
	"sec-fetch-mode": "cors",
};

const BASE_REQUEST: BrowserCookieRequestMetadata = {
	method: "GET",
	pathname: "/api/sessions",
	headers: BASE_HEADERS,
	isTls: true,
};

const BASE_CONTEXT: BrowserCookieEligibilityContext = {
	deployment: "direct",
	configuredHost: "bobbit.example",
	authentication: { source: "admin-bearer" },
};

function classify(
	request: Partial<Omit<BrowserCookieRequestMetadata, "headers">> & { headers?: BrowserCookieHeaders } = {},
	context: Partial<BrowserCookieEligibilityContext> = {},
) {
	return classifyBrowserCookieEligibility(
		{
			...BASE_REQUEST,
			...request,
			headers: { ...BASE_HEADERS, ...request.headers },
		},
		{ ...BASE_CONTEXT, ...context },
	);
}

function assertDenied(
	expectedReason: ReturnType<typeof classify>["reason"],
	request: Parameters<typeof classify>[0] = {},
	context: Parameters<typeof classify>[1] = {},
): void {
	assert.deepEqual(classify(request, context), {
		mayBootstrap: false,
		mayRenew: false,
		reason: expectedReason,
	});
}

describe("browser cookie eligibility", () => {
	it("bootstraps only after already-resolved admin or localhost authentication", () => {
		assert.deepEqual(classify(), {
			mayBootstrap: true,
			mayRenew: false,
			reason: "eligible-bootstrap",
		});
		assert.deepEqual(classify({}, { authentication: { source: "localhost-trusted" } }), {
			mayBootstrap: true,
			mayRenew: false,
			reason: "eligible-bootstrap",
		});
		assertDenied("ineligible-authentication", {}, { authentication: { source: "other" } });
	});

	it("renews only a signed-cookie-authenticated request in its renewal window", () => {
		assert.deepEqual(classify({}, { authentication: { source: "signed-cookie", needsRenewal: true } }), {
			mayBootstrap: false,
			mayRenew: true,
			reason: "eligible-renewal",
		});
		assertDenied(
			"cookie-renewal-not-needed",
			{},
			{ authentication: { source: "signed-cookie", needsRenewal: false } },
		);
	});

	it("accepts production TLS, same-origin mode, and originless GET shapes", () => {
		assert.equal(classify().mayBootstrap, true);
		assert.equal(classify({ headers: { "sec-fetch-mode": "same-origin" } }).mayBootstrap, true);
		assert.equal(classify({ headers: { origin: undefined } }).mayBootstrap, true);
		assert.equal(classify({ headers: {
			"sec-fetch-site": " SAME-ORIGIN ",
			"sec-fetch-mode": " CORS ",
			origin: "HTTPS://BOBBIT.EXAMPLE",
		} }).mayBootstrap, true);
	});

	it("accepts direct localhost HTTP for Bearer and trusted-local authentication", () => {
		const localRequest = {
			isTls: false,
			headers: {
				host: "localhost:3001",
				origin: "http://localhost:3001",
			},
		};
		assert.equal(classify(localRequest).mayBootstrap, true);
		assert.equal(classify(localRequest, {
			configuredHost: "localhost",
			authentication: { source: "localhost-trusted" },
		}).mayBootstrap, true);
	});

	it("accepts Vite's rewritten Host with a localhost dev Origin", () => {
		assert.equal(classify({
			isTls: false,
			headers: {
				host: "localhost:3001",
				origin: "http://localhost:5173",
			},
		}, {
			deployment: "vite",
			configuredHost: "localhost",
		}).mayBootstrap, true);

		assert.equal(classify({
			isTls: false,
			headers: {
				host: "127.0.0.1:3001",
				origin: "http://localhost:5173",
			},
		}, {
			deployment: "vite",
			configuredHost: "localhost",
		}).mayBootstrap, true);
	});

	it("accepts the HTTPS Vite exception only when request and Origin use the configured remote host", () => {
		assert.equal(classify({
			headers: {
				host: "100.64.0.8:3001",
				origin: "https://100.64.0.8:5173",
			},
		}, {
			deployment: "vite",
			configuredHost: "100.64.0.8",
		}).mayBootstrap, true);

		assertDenied("origin-mismatch", {
			headers: {
				host: "gateway.example:3001",
				origin: "https://mesh.example:5173",
			},
		}, {
			deployment: "vite",
			configuredHost: "mesh.example",
		});
	});

	it("does not enable the Vite port exception while serving the production UI", () => {
		assertDenied("origin-mismatch", {
			headers: {
				host: "bobbit.example:3001",
				origin: "https://bobbit.example:5173",
			},
		});
	});

	it("requires the exact Fetch Metadata contract", () => {
		for (const value of [undefined, "cross-site", "same-site", "none", "same-origin, same-origin", ["same-origin", "same-origin"]]) {
			assertDenied("invalid-fetch-site", { headers: { "sec-fetch-site": value } });
		}
		for (const value of [undefined, "navigate", "no-cors", "cors, same-origin", ["cors", "same-origin"]]) {
			assertDenied("invalid-fetch-mode", { headers: { "sec-fetch-mode": value } });
		}
		assertDenied("invalid-fetch-site", { headers: { "Sec-Fetch-Site": "same-origin" } });
	});

	it("rejects conflicting case-variant Fetch Metadata fields", () => {
		assertDenied("invalid-fetch-site", { headers: { "Sec-Fetch-Site": "same-origin" } });
		assertDenied("invalid-fetch-mode", { headers: { "Sec-Fetch-Mode": "cors" } });
	});

	it("requires Origin on non-GET requests", () => {
		assertDenied("origin-required", {
			method: "POST",
			headers: { origin: undefined },
		});
	});

	it("rejects malformed, opaque, multiple, and resource Origins", () => {
		for (const origin of [
			"null",
			"not a URL",
			"https://bobbit.example, https://bobbit.example",
			"https://user@bobbit.example",
			"https://bobbit.example/",
			"https://bobbit.example/path",
			"https://bobbit.example?query",
			"https://bobbit.example#fragment",
			["https://bobbit.example", "https://bobbit.example"],
		]) {
			assertDenied("invalid-origin", { headers: { origin } });
		}
	});

	it("rejects mismatched production origins including port mismatches", () => {
		assertDenied("origin-mismatch", { headers: { origin: "https://other.example" } });
		assertDenied("origin-mismatch", {
			headers: {
				host: "bobbit.example:3001",
				origin: "https://bobbit.example:5173",
			},
		});
	});

	it("rejects non-loopback HTTP in direct and Vite deployments", () => {
		assertDenied("insecure-non-loopback-origin", {
			isTls: false,
			headers: {
				host: "bobbit.example:3001",
				origin: "http://bobbit.example:3001",
			},
		});
		assertDenied("insecure-non-loopback-origin", {
			isTls: false,
			headers: {
				host: "100.64.0.8:3001",
				origin: "http://100.64.0.8:5173",
			},
		}, {
			deployment: "vite",
			configuredHost: "100.64.0.8",
		});
	});

	it("uses the TLS socket and Host rather than forwarded headers", () => {
		assert.equal(classify({ headers: {
			forwarded: "host=evil.example;proto=http",
			"x-forwarded-host": "evil.example",
			"x-forwarded-proto": "http",
		} }).mayBootstrap, true);
	});

	it("rejects missing, multiple, or malformed Host", () => {
		for (const host of [undefined, ["bobbit.example", "evil.example"], "bobbit.example, evil.example", "user@bobbit.example", "bobbit.example/path", "bobbit.example:"]) {
			assertDenied("invalid-request-host", { headers: { host } });
		}
	});

	it("excludes all internal routes and the exact generated callback inventory", () => {
		const routes: Array<[string, string]> = [
			["GET", "/api/internal"],
			["POST", "/api/internal/verification-result"],
			["POST", "/api/sessions/session-1/provider-hooks/before-prompt"],
			["POST", "/api/sessions/session-1/provider-hooks/before-compact"],
			["GET", "/api/sessions/session-1/google-code-assist/token"],
			["POST", "/api/sessions/session-1/tool-grant-request"],
		];
		for (const [method, pathname] of routes) {
			assertDenied("internal-callback-route", { method, pathname });
		}
	});

	it("keeps callback exclusions method- and path-specific", () => {
		for (const [method, pathname] of [
			["GET", "/api/internalish"],
			["GET", "/api/sessions/session-1/provider-hooks/before-prompt"],
			["POST", "/api/sessions/session-1/google-code-assist/token"],
			["GET", "/api/sessions/session-1/tool-grant-request"],
			["POST", "/api/sessions/session-1/provider-hooks/before-prompt/"],
		] as const) {
			assert.equal(classify({ method, pathname }).mayBootstrap, true);
		}
	});

	it("excludes every session-bound identity header regardless of value form", () => {
		for (const [name, value] of [
			["x-bobbit-session-id", "session-1"],
			["x-bobbit-spawning-session", ""],
			["X-Bobbit-Session-Secret", ["secret"]],
		] as const) {
			assertDenied("session-bound-request", { headers: { [name]: value } });
		}
	});

	it("lets a resolved sandbox credential override an otherwise eligible admin or cookie request", () => {
		assertDenied("sandbox-credential-presented", {}, {
			authentication: { source: "admin-bearer" },
			hasSandboxCredential: true,
		});
		assertDenied("sandbox-credential-presented", {}, {
			authentication: { source: "signed-cookie", needsRenewal: true },
			hasSandboxCredential: true,
		});
	});

	it("never turns browser metadata into authorization", () => {
		assertDenied("ineligible-authentication", {}, { authentication: { source: "other" } });
	});
});
