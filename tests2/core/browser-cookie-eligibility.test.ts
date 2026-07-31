import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	browserCookieRequestOrigin,
	browserCookieRequiresSecure,
	canonicalRequestOrigin,
	classifyBrowserCookieEligibility,
	isBrowserCookieAuthenticationCompatible,
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
	viteDevProxy: false,
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

describe("browser cookie transport security", () => {
	it.each([
		"localhost:3001",
		"app.localhost:3001",
		"127.0.0.1:3001",
		"[::1]:3001",
	])("omits Secure for an actual HTTP loopback Host (%s)", (host) => {
		assert.equal(browserCookieRequiresSecure({ headers: { host }, isTls: false }), false);
	});

	it("retains Secure for TLS even on loopback", () => {
		assert.equal(browserCookieRequiresSecure({ headers: { host: "127.0.0.1:3001" }, isTls: true }), true);
	});

	it("retains Secure for an HTTP public Host and ignores proxy forwarding headers", () => {
		assert.equal(browserCookieRequiresSecure({
			headers: {
				host: "bobbit.example",
				forwarded: "host=localhost;proto=http",
				"x-forwarded-host": "localhost",
				"x-forwarded-proto": "https",
			},
			isTls: false,
		}), true);
	});

	it("fails secure for a missing or malformed Host", () => {
		assert.equal(browserCookieRequiresSecure({ headers: {}, isTls: false }), true);
		assert.equal(browserCookieRequiresSecure({ headers: { host: "localhost, bobbit.example" }, isTls: false }), true);
	});
});

describe("browser cookie origin authority", () => {
	it("canonicalizes an exact browser Origin and uses actual Host/TLS only as the originless fallback", () => {
		assert.equal(browserCookieRequestOrigin({
			headers: { host: "bobbit.example:3001", origin: "HTTPS://BOBBIT.EXAMPLE:5173" },
			isTls: true,
		}), "https://bobbit.example:5173");
		assert.equal(browserCookieRequestOrigin({
			headers: {
				host: "LOCALHOST:3001",
				"x-forwarded-host": "attacker.example",
				"x-forwarded-proto": "https",
			},
			isTls: false,
		}), "http://localhost:3001");
		assert.equal(canonicalRequestOrigin({ headers: { host: "[::1]:3001" }, isTls: false }), "http://[::1]:3001");
		assert.equal(browserCookieRequestOrigin({
			headers: { host: "bobbit.example, attacker.example", origin: "https://bobbit.example" },
			isTls: true,
		}), undefined);
	});

	it("keeps legacy cookie authority exact-origin instead of accepting an arbitrary same-host port", () => {
		assert.equal(isBrowserCookieAuthenticationCompatible({
			headers: { host: "bobbit.example:3001", origin: "https://bobbit.example:3001" },
			isTls: true,
		}), true);
		assert.equal(isBrowserCookieAuthenticationCompatible({
			headers: { host: "bobbit.example:3001", origin: "https://bobbit.example:5173" },
			isTls: true,
		}), false);
	});
});

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

	it("accepts Vite's rewritten Host with a localhost dev Origin only in explicit proxy mode", () => {
		assert.equal(classify({
			isTls: false,
			headers: {
				host: "localhost:3001",
				origin: "http://localhost:5173",
			},
		}, {
			viteDevProxy: true,
			configuredHost: "localhost",
		}).mayBootstrap, true);

		const rewrittenAlias = {
			isTls: false,
			headers: {
				host: "127.0.0.1:3001",
				origin: "http://localhost:5173",
			},
		};
		assert.equal(classify(rewrittenAlias, {
			viteDevProxy: true,
			configuredHost: "localhost",
		}).mayBootstrap, true);
		assertDenied("origin-mismatch", rewrittenAlias, {
			viteDevProxy: false,
			configuredHost: "localhost",
		});
	});

	it("accepts HTTPS loopback Vite terminating TLS for an HTTP loopback gateway only in explicit proxy mode", () => {
		const viteTlsTermination = {
			isTls: false,
			headers: {
				host: "127.0.0.1:3001",
				origin: "https://localhost:5173",
			},
		};
		assert.equal(classify(viteTlsTermination, {
			viteDevProxy: true,
			configuredHost: "127.0.0.1",
		}).mayBootstrap, true);
		assertDenied("origin-mismatch", viteTlsTermination, {
			viteDevProxy: false,
			configuredHost: "127.0.0.1",
		});

		assertDenied("origin-mismatch", {
			isTls: true,
			headers: {
				host: "localhost:3001",
				origin: "http://localhost:5173",
			},
		}, {
			viteDevProxy: true,
			configuredHost: "localhost",
		});
		assertDenied("insecure-non-loopback-origin", {
			isTls: false,
			headers: {
				host: "100.64.0.8:3001",
				origin: "https://100.64.0.8:5173",
				"x-forwarded-proto": "https",
			},
		}, {
			viteDevProxy: true,
			configuredHost: "100.64.0.8",
		});
	});

	it("accepts the HTTPS Vite exception only when request and Origin use the configured remote host", () => {
		assert.equal(classify({
			headers: {
				host: "100.64.0.8:3001",
				origin: "https://100.64.0.8:5173",
			},
		}, {
			viteDevProxy: true,
			configuredHost: "100.64.0.8",
		}).mayBootstrap, true);

		assertDenied("origin-mismatch", {
			headers: {
				host: "gateway.example:3001",
				origin: "https://mesh.example:5173",
			},
		}, {
			viteDevProxy: true,
			configuredHost: "mesh.example",
		});
	});

	it("allows direct cross-port binding only with real bearer or an exact centrally verified cookie", () => {
		const crossPort = {
			headers: {
				host: "bobbit.example:3001",
				origin: "https://bobbit.example:5173",
			},
		};
		assert.equal(classify(crossPort).mayBootstrap, true);
		assert.deepEqual(classify(crossPort, {
			authentication: { source: "signed-cookie", needsRenewal: true },
		}), {
			mayBootstrap: false,
			mayRenew: true,
			reason: "eligible-renewal",
		});
		assertDenied("origin-mismatch", crossPort, { authentication: { source: "localhost-trusted" } });
		assertDenied("origin-mismatch", crossPort, { authentication: { source: "other" } });
	});

	it("uses normalized public Host authority for headless wildcard-bound cross-port binding", () => {
		assert.equal(classify({
			headers: {
				host: "bobbit.example:3001",
				origin: "https://BOBBIT.EXAMPLE.:5173",
			},
		}, {
			configuredHost: "0.0.0.0",
			viteDevProxy: false,
		}).mayBootstrap, true);
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

	it("rejects mismatched production hosts and schemes", () => {
		assertDenied("origin-mismatch", { headers: { origin: "https://other.example" } });
		assertDenied("origin-mismatch", {
			headers: {
				host: "bobbit.example:3001",
				origin: "https://subdomain.bobbit.example:5173",
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
			viteDevProxy: true,
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

	it("never bootstraps or renews on the preview SSE route", () => {
		const request = { method: "GET", pathname: "/api/sessions/session-1/preview-events" };
		assertDenied("internal-callback-route", request);
		assertDenied("internal-callback-route", request, {
			authentication: { source: "signed-cookie", needsRenewal: true },
		});
	});

	it("keeps the ordinary preview API eligible", () => {
		const request = { method: "GET", pathname: "/api/preview/mount" };
		assert.equal(classify(request).mayBootstrap, true);
		assert.equal(classify(request, {
			authentication: { source: "signed-cookie", needsRenewal: true },
		}).mayRenew, true);
	});

	it("keeps callback exclusions method- and path-specific", () => {
		for (const [method, pathname] of [
			["GET", "/api/internalish"],
			["GET", "/api/sessions/session-1/provider-hooks/before-prompt"],
			["POST", "/api/sessions/session-1/google-code-assist/token"],
			["GET", "/api/sessions/session-1/tool-grant-request"],
			["POST", "/api/sessions/session-1/provider-hooks/before-prompt/"],
			["POST", "/api/sessions/session-1/preview-events"],
			["GET", "/api/sessions/session-1/preview-events/"],
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
