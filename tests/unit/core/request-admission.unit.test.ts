import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	admitRequest,
	compileRequestAdmissionPolicy,
	RequestAdmissionConfigError,
	type RequestAdmissionMetadata,
	type RequestAdmissionPolicyInput,
} from "../../../src/server/request-admission.ts";

const BASE_POLICY: RequestAdmissionPolicyInput = {
	bindHost: "0.0.0.0",
	actualPort: 4242,
	publicOrigins: ["https://bobbit.example"],
	trustedHosts: ["100.64.0.8"],
	tlsHostnames: ["secure.example"],
	viteOriginPairs: [{ origin: "http://localhost:5173", gatewayOrigin: "http://localhost:4242" }],
};

function rawHeaders(values: Record<string, string>): string[] {
	return Object.entries(values).flatMap(([name, value]) => [name, value]);
}

function decide(
	overrides: Partial<RequestAdmissionMetadata> = {},
	policyInput: RequestAdmissionPolicyInput = BASE_POLICY,
) {
	return admitRequest(compileRequestAdmissionPolicy(policyInput), {
		rawHeaders: rawHeaders({ Host: "localhost:4242" }),
		method: "GET",
		url: "/api/health",
		isTls: false,
		...overrides,
	});
}

function assertDenied(reason: string, overrides: Partial<RequestAdmissionMetadata>): void {
	const decision = decide(overrides);
	assert.equal(decision.allowed, false);
	assert.equal(decision.reason, reason);
}

describe("request admission policy compilation", () => {
	it("builds a finite normalized authority set without trusting wildcard listeners", () => {
		const policy = compileRequestAdmissionPolicy(BASE_POLICY);
		assert.deepEqual(policy.trustedOrigins, [
			"http://localhost:4242",
			"http://127.0.0.1:4242",
			"http://[::1]:4242",
			"http://100.64.0.8:4242",
			"https://secure.example:4242",
			"https://bobbit.example",
		]);
		assert.equal(policy.trustedOrigins.some((origin) => origin.includes("0.0.0.0")), false);
		assert.equal(Object.isFrozen(policy), true);
		assert.equal(Object.isFrozen(policy.trustedOrigins), true);
	});

	it("canonicalizes DNS, trailing dots, IPv4, IPv6, and default ports", () => {
		const policy = compileRequestAdmissionPolicy({
			bindHost: "LOCALHOST.",
			actualPort: 80,
			trustedHosts: ["127.000.000.001", "2001:0DB8:0:0:0:0:0:1"],
			publicOrigins: ["HTTPS://PUBLIC.EXAMPLE.:443/"],
		});
		assert.ok(policy.trustedOrigins.includes("http://localhost"));
		assert.ok(policy.trustedOrigins.includes("http://127.0.0.1"));
		assert.ok(policy.trustedOrigins.includes("http://[2001:db8::1]"));
		assert.ok(policy.trustedOrigins.includes("https://public.example"));
		assert.equal(decide({ rawHeaders: rawHeaders({ Host: "[2001:DB8::1]:80" }) }, {
			bindHost: "::",
			actualPort: 80,
			trustedHosts: ["2001:db8::1"],
		}).allowed, true);
	});

	it("rejects malformed or unbounded configuration with stable codes", () => {
		const invalid: Array<[Partial<RequestAdmissionPolicyInput>, string]> = [
			[{ actualPort: 0 }, "invalid-port"],
			[{ bindHost: "bad host" }, "invalid-bind-host"],
			[{ basePath: "/../api" }, "invalid-base-path"],
			[{ publicOrigins: ["https://user@bobbit.example"] }, "invalid-public-origin"],
			[{ publicOrigins: ["https://bobbit.example/path"] }, "invalid-public-origin"],
			[{ tlsHostnames: ["*.example"] }, "invalid-tls-name"],
			[{ viteOriginPairs: [{ origin: "http://localhost:5173", gatewayOrigin: "http://localhost:9999" }] }, "untrusted-vite-gateway"],
		];
		for (const [override, reason] of invalid) {
			assert.throws(
				() => compileRequestAdmissionPolicy({ ...BASE_POLICY, ...override }),
				(error: unknown) => error instanceof RequestAdmissionConfigError && error.reason === reason,
			);
		}
	});
});

describe("request Host and Origin admission", () => {
	it("requires one unambiguous trusted Host even when hostile Host and Origin agree", () => {
		assertDenied("missing-host", { rawHeaders: [] });
		assertDenied("duplicate-host", { rawHeaders: ["Host", "localhost:4242", "host", "localhost:4242"] });
		assertDenied("invalid-host", { rawHeaders: rawHeaders({ Host: "user@localhost:4242" }) });
		assertDenied("invalid-host", { rawHeaders: rawHeaders({ Host: "::1:4242" }) });
		assertDenied("untrusted-host", {
			rawHeaders: rawHeaders({ Host: "attacker.example:4242", Origin: "http://attacker.example:4242" }),
		});
	});

	it("normalizes trusted request authorities but rejects ambiguous or mismatched origins", () => {
		const allowed = decide({
			rawHeaders: rawHeaders({ Host: "LOCALHOST.:4242", Origin: "http://LOCALHOST.:4242" }),
		});
		assert.equal(allowed.allowed, true);
		assert.equal(allowed.normalizedHost, "localhost:4242");
		assert.equal(allowed.normalizedOrigin, "http://localhost:4242");
		assert.deepEqual(allowed.cors, {
			allowOrigin: "http://localhost:4242",
			varyOrigin: true,
			allowCredentials: false,
		});
		assertDenied("duplicate-origin", {
			rawHeaders: ["Host", "localhost:4242", "Origin", "http://localhost:4242", "origin", "http://localhost:4242"],
		});
		for (const origin of ["null", "http://localhost:4242/", "http://user@localhost:4242", "http://localhost:4242/path", "http://localhost:4242, http://evil.test"] ) {
			assertDenied("invalid-origin", { rawHeaders: rawHeaders({ Host: "localhost:4242", Origin: origin }) });
		}
		assertDenied("origin-mismatch", {
			rawHeaders: rawHeaders({ Host: "localhost:4242", Origin: "http://127.0.0.1:4242" }),
		});
	});

	it("allows only explicitly paired Vite origins", () => {
		const vite = decide({
			rawHeaders: rawHeaders({
				Host: "localhost:4242",
				Origin: "http://localhost:5173",
				"Sec-Fetch-Site": "same-origin",
				"Sec-Fetch-Mode": "cors",
				"Sec-Fetch-Dest": "empty",
			}),
		});
		assert.equal(vite.allowed, true);
		assertDenied("origin-mismatch", {
			rawHeaders: rawHeaders({ Host: "localhost:4242", Origin: "http://localhost:5174" }),
		});
	});

	it("validates the raw request target independently of Host", () => {
		assertDenied("invalid-request-target", { url: "http://attacker.example/api/health" });
		assertDenied("invalid-request-target", { url: "//attacker.example/api/health" });
	});
});

describe("browser route/context matrix", () => {
	const fetchHeaders = (site: string, mode: string, dest: string, origin?: string): string[] => rawHeaders({
		Host: "localhost:4242",
		...(origin ? { Origin: origin } : {}),
		"Sec-Fetch-Site": site,
		"Sec-Fetch-Mode": mode,
		"Sec-Fetch-Dest": dest,
	});

	it("permits safe originless top-level UI and preview navigation, including external links", () => {
		for (const url of ["/", "/preview/session/index.html"]) {
			const result = decide({ url, rawHeaders: fetchHeaders("cross-site", "navigate", "document") });
			assert.equal(result.allowed, true);
			assert.match(result.context, /^(ui|preview)-document$/);
		}
		assertDenied("unsafe-navigation-method", {
			method: "POST",
			url: "/",
			rawHeaders: fetchHeaders("same-origin", "navigate", "document", "http://localhost:4242"),
		});
	});

	it("allows coherent originless same-origin API metadata while denying other browser contexts", () => {
		for (const mode of ["cors", "same-origin"]) {
			for (const includeEmptyDestination of [false, true]) {
				const result = decide({
					url: "/api/health",
					rawHeaders: rawHeaders({
						Host: "localhost:4242",
						"Sec-Fetch-Site": "same-origin",
						"Sec-Fetch-Mode": mode,
						...(includeEmptyDestination ? { "Sec-Fetch-Dest": "empty" } : {}),
					}),
				});
				assert.equal(result.allowed, true);
				assert.equal(result.context, "api");
				assert.equal(result.normalizedOrigin, undefined);
				assert.equal(result.cors, undefined);
			}
		}
		for (const site of ["same-site", "cross-site", "none"]) {
			assertDenied("cross-site-browser-request", {
				url: "/api/health",
				rawHeaders: fetchHeaders(site, "cors", "empty"),
			});
		}
		assertDenied("cross-site-browser-request", {
			url: "/app.js",
			rawHeaders: fetchHeaders("cross-site", "no-cors", "script"),
		});
		assertDenied("origin-required", {
			transport: "websocket",
			url: "/ws/session",
			rawHeaders: fetchHeaders("same-origin", "websocket", "empty"),
		});
		assert.equal(decide().allowed, true);
		assert.equal(decide({ transport: "websocket", url: "/ws/session" }).allowed, true);
	});

	it("accepts undici's lone cors mode as non-browser traffic across HTTP routes only", () => {
		const cases = [
			{ url: "/api/health", context: "api" },
			{ url: "/", context: "ui-static" },
			{ url: "/app.js", context: "ui-static" },
			{ url: "/preview/session/index.html", context: "preview-resource" },
			{ url: "/preview/session/style.css", context: "preview-resource" },
		] as const;
		for (const testCase of cases) {
			const undici = decide({
				url: testCase.url,
				rawHeaders: rawHeaders({ Host: "localhost:4242", "Sec-Fetch-Mode": "cors" }),
			});
			assert.equal(undici.allowed, true, testCase.url);
			assert.equal(undici.context, testCase.context, testCase.url);
			assert.equal(undici.normalizedOrigin, undefined, testCase.url);
			assert.equal(undici.cors, undefined, testCase.url);
		}

		assertDenied("partial-fetch-metadata", {
			transport: "websocket",
			url: "/ws/session",
			rawHeaders: rawHeaders({ Host: "localhost:4242", "Sec-Fetch-Mode": "cors" }),
		});
		assertDenied("partial-fetch-metadata", {
			url: "/app.js",
			rawHeaders: rawHeaders({ Host: "localhost:4242", "Sec-Fetch-Mode": "no-cors" }),
		});
		assertDenied("partial-fetch-metadata", {
			rawHeaders: rawHeaders({
				Host: "localhost:4242",
				Origin: "http://localhost:4242",
				"Sec-Fetch-Mode": "cors",
			}),
		});
	});

	it("accepts route-coherent browser metadata without a destination", () => {
		const api = decide({
			rawHeaders: rawHeaders({
				Host: "localhost:4242",
				Origin: "http://localhost:4242",
				"Sec-Fetch-Site": "same-origin",
				"Sec-Fetch-Mode": "cors",
			}),
		});
		assert.equal(api.allowed, true);
		assert.equal(api.context, "api");

		const websocket = decide({
			transport: "websocket",
			url: "/ws/session",
			rawHeaders: rawHeaders({
				Host: "localhost:4242",
				Origin: "http://localhost:4242",
				"Sec-Fetch-Site": "same-origin",
				"Sec-Fetch-Mode": "websocket",
			}),
		});
		assert.equal(websocket.allowed, true);

		assertDenied("origin-mismatch", {
			rawHeaders: rawHeaders({
				Host: "localhost:4242",
				Origin: "https://attacker.example",
				"Sec-Fetch-Site": "same-origin",
				"Sec-Fetch-Mode": "cors",
			}),
		});
		assertDenied("cross-site-browser-request", {
			rawHeaders: rawHeaders({
				Host: "localhost:4242",
				Origin: "http://localhost:4242",
				"Sec-Fetch-Site": "cross-site",
				"Sec-Fetch-Mode": "cors",
			}),
		});
		assertDenied("invalid-fetch-metadata", {
			url: "/preview/session/index.html",
			rawHeaders: rawHeaders({
				Host: "localhost:4242",
				Origin: "http://localhost:4242",
				"Sec-Fetch-Site": "same-origin",
				"Sec-Fetch-Mode": "navigate",
			}),
		});
	});

	it("permits same-origin embedded previews/resources and rejects same-site siblings and opaque origins", () => {
		assert.equal(decide({
			url: "/preview/session/index.html",
			rawHeaders: fetchHeaders("same-origin", "navigate", "iframe"),
		}).allowed, true);
		assert.equal(decide({
			url: "/preview/session/style.css",
			rawHeaders: fetchHeaders("same-origin", "no-cors", "style"),
		}).allowed, true);
		assertDenied("origin-mismatch", {
			url: "/preview/session/style.css",
			rawHeaders: fetchHeaders("same-site", "cors", "style", "https://sibling.example"),
		});
		assertDenied("invalid-origin", {
			url: "/preview/session/index.html",
			rawHeaders: fetchHeaders("cross-site", "navigate", "iframe", "null"),
		});
	});

	it("rejects partial, duplicated, and malformed Fetch Metadata", () => {
		assertDenied("partial-fetch-metadata", {
			rawHeaders: rawHeaders({ Host: "localhost:4242", "Sec-Fetch-Site": "same-origin" }),
		});
		assertDenied("duplicate-fetch-metadata", {
			rawHeaders: [
				...fetchHeaders("same-origin", "cors", "empty", "http://localhost:4242"),
				"Sec-Fetch-Site", "same-origin",
			],
		});
		assertDenied("invalid-fetch-metadata", {
			rawHeaders: fetchHeaders("same-origin, cross-site", "cors", "empty", "http://localhost:4242"),
		});
	});
});

describe("CORS preflight projection", () => {
	function preflight(extra: Record<string, string> = {}) {
		return decide({
			method: "OPTIONS",
			url: "/api/sessions",
			rawHeaders: rawHeaders({
				Host: "localhost:4242",
				Origin: "http://localhost:4242",
				"Sec-Fetch-Site": "same-origin",
				"Sec-Fetch-Mode": "cors",
				"Sec-Fetch-Dest": "empty",
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "authorization, Content-Type",
				...extra,
			}),
		});
	}

	it("returns only the exact allowed origin and requested allowlisted capabilities", () => {
		const result = preflight();
		assert.equal(result.allowed, true);
		assert.equal(result.context, "preflight");
		assert.deepEqual(result.cors, {
			allowOrigin: "http://localhost:4242",
			varyOrigin: true,
			allowCredentials: false,
			allowMethod: "POST",
			allowHeaders: ["Authorization", "Content-Type"],
			maxAgeSeconds: 600,
		});

		const withoutDest = decide({
			method: "OPTIONS",
			url: "/api/sessions",
			rawHeaders: rawHeaders({
				Host: "localhost:4242",
				Origin: "http://localhost:4242",
				"Sec-Fetch-Site": "same-origin",
				"Sec-Fetch-Mode": "cors",
				"Access-Control-Request-Method": "POST",
			}),
		});
		assert.equal(withoutDest.allowed, true);
		assert.equal(withoutDest.context, "preflight");
	});

	it("denies disallowed methods, headers, hostile origins, and private-network requests", () => {
		assert.equal(preflight({ "Access-Control-Request-Method": "TRACE" }).reason, "preflight-method-denied");
		assert.equal(preflight({ "Access-Control-Request-Headers": "X-Evil" }).reason, "preflight-header-denied");
		assert.equal(preflight({ Origin: "https://evil.example" }).reason, "origin-mismatch");
		const pna = preflight({ "Access-Control-Request-Private-Network": "true" });
		assert.equal(pna.allowed, false);
		assert.equal(pna.reason, "private-network-denied");
		assert.equal("cors" in pna, false);
	});
});
