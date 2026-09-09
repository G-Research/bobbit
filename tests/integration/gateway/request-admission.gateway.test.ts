import http from "node:http";
import net from "node:net";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { vi } from "vitest";

import { expect, test } from "../../../tests/support/harnesses/integration/gateway/in-process-harness.js";

interface HttpResult {
	status: number;
	headers: http.IncomingHttpHeaders;
	body: string;
}

function trustedAuthority(baseURL: string): string {
	return new URL(baseURL).host;
}

function request(
	baseURL: string,
	path: string,
	options: { method?: string; headers?: http.OutgoingHttpHeaders; body?: string } = {},
): Promise<HttpResult> {
	const target = new URL(baseURL);
	return new Promise((resolve, reject) => {
		const req = http.request({
			hostname: "127.0.0.1",
			port: Number(target.port),
			path,
			method: options.method ?? "GET",
			headers: options.headers,
		}, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => resolve({
				status: res.statusCode ?? 0,
				headers: res.headers,
				body: Buffer.concat(chunks).toString("utf8"),
			}));
		});
		req.once("error", reject);
		if (options.body !== undefined) req.end(options.body);
		else req.end();
	});
}

function rawRequest(baseURL: string, wireRequest: string): Promise<HttpResult> {
	const target = new URL(baseURL);
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({ host: "127.0.0.1", port: Number(target.port) });
		const chunks: Buffer[] = [];
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("raw gateway request timed out"));
		}, 5_000);
		socket.once("connect", () => socket.end(wireRequest));
		socket.on("data", chunk => chunks.push(chunk));
		socket.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		socket.once("close", () => {
			clearTimeout(timer);
			const text = Buffer.concat(chunks).toString("latin1");
			const [head = "", body = ""] = text.split("\r\n\r\n", 2);
			const lines = head.split("\r\n");
			const match = /^HTTP\/\d\.\d\s+(\d{3})/.exec(lines.shift() ?? "");
			if (!match) {
				reject(new Error(`gateway returned no HTTP status: ${JSON.stringify(text.slice(0, 200))}`));
				return;
			}
			const headers: http.IncomingHttpHeaders = {};
			for (const line of lines) {
				const colon = line.indexOf(":");
				if (colon < 1) continue;
				const name = line.slice(0, colon).toLowerCase();
				const value = line.slice(colon + 1).trim();
				const prior = headers[name];
				headers[name] = prior === undefined ? value : `${prior}, ${value}`;
			}
			resolve({ status: Number(match[1]), headers, body });
		});
	});
}

function rawLines(method: string, path: string, headers: readonly string[], version = "HTTP/1.1"): string {
	return [`${method} ${path} ${version}`, ...headers, "Connection: close", "", ""].join("\r\n");
}

function expectNoCorsCapability(result: HttpResult): void {
	for (const header of [
		"access-control-allow-origin",
		"access-control-allow-methods",
		"access-control-allow-headers",
		"access-control-allow-credentials",
		"access-control-allow-private-network",
		"access-control-max-age",
	]) {
		expect.soft(result.headers[header], `${header} must be omitted`).toBeUndefined();
	}
}

function headerItems(value: string | string[] | undefined): string[] {
	return (Array.isArray(value) ? value.join(",") : value ?? "")
		.split(",")
		.map(item => item.trim().toLowerCase())
		.filter(Boolean);
}

function rejectedWebSocketStatus(url: string, options: WebSocket.ClientOptions): Promise<number> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url, options);
		let settled = false;
		const finishReject = (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (ws.readyState === WebSocket.OPEN) ws.terminate();
			reject(error);
		};
		const timer = setTimeout(() => finishReject(new Error("WebSocket admission did not settle")), 5_000);
		ws.once("open", () => finishReject(new Error("rejected WebSocket unexpectedly upgraded")));
		ws.once("unexpected-response", (_req, response) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const status = response.statusCode ?? 0;
			// Consuming the expected HTTP rejection closes the pre-upgrade request.
			// Calling terminate() while ws is still CONNECTING schedules an error;
			// removing its listeners first turns that expected error into an uncaught
			// exception that can fail a later assertion or test file.
			response.resume();
			resolve(status);
		});
		ws.once("error", (error) => {
			if (!settled) finishReject(error);
		});
	});
}

function authenticatedWebSocket(url: string, token: string, options: WebSocket.ClientOptions = {}): Promise<void> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url, options);
		const timer = setTimeout(() => finish(new Error("WebSocket authentication timed out")), 5_000);
		const finish = (error?: Error) => {
			clearTimeout(timer);
			ws.removeAllListeners();
			ws.close();
			if (error) reject(error);
			else resolve();
		};
		ws.once("open", () => ws.send(JSON.stringify({ type: "auth", token, clientKind: "app" })));
		ws.on("message", raw => {
			let frame: { type?: string } = {};
			try { frame = JSON.parse(String(raw)); } catch { return; }
			if (frame.type === "auth_ok") finish();
			if (frame.type === "auth_failed") finish(new Error("WebSocket inner authentication failed"));
		});
		ws.once("error", finish);
	});
}

test.describe.serial("central gateway request admission", () => {
	test("rejects equal attacker Host and Origin before every HTTP route family", async ({ gateway }) => {
		const port = new URL(gateway.baseURL).port;
		const attacker = `attacker.example:${port}`;
		for (const path of [
			"/api/health",
			"/api/ca-cert",
			"/manifest.json",
			"/",
			`/preview/${randomUUID()}/index.html`,
		]) {
			const result = await request(gateway.baseURL, path, {
				headers: {
					Host: attacker,
					Origin: `http://${attacker}`,
					"Sec-Fetch-Site": "same-origin",
					"Sec-Fetch-Mode": "cors",
					Authorization: `Bearer ${gateway.token}`,
				},
			});
			expect.soft(result.status, `${path} bypassed trusted-Host admission: ${result.body}`).toBe(403);
		}
	});

	test("accepts normalized loopback aliases and ignores forwarded authority headers", async ({ gateway }) => {
		const port = new URL(gateway.baseURL).port;
		for (const authority of [`127.0.0.1:${port}`, `LOCALHOST.:${port}`, `[::1]:${port}`]) {
			const result = await request(gateway.baseURL, "/api/health", {
				headers: {
					Host: authority,
					Origin: `HTTP://${authority}`,
					"Sec-Fetch-Site": "same-origin",
					"Sec-Fetch-Mode": "cors",
					Authorization: `Bearer ${gateway.token}`,
				},
			});
			expect.soft(result.status, `${authority}: ${result.body}`).toBe(200);
		}

		const forwardedOnlyAttack = await request(gateway.baseURL, "/api/health", {
			headers: {
				Host: trustedAuthority(gateway.baseURL),
				"X-Forwarded-Host": "attacker.example",
				"X-Forwarded-Proto": "https",
				Forwarded: "host=attacker.example;proto=https",
				Authorization: `Bearer ${gateway.token}`,
			},
		});
		expect(forwardedOnlyAttack.status, forwardedOnlyAttack.body).toBe(200);

		const hostileHost = await request(gateway.baseURL, "/api/health", {
			headers: {
				Host: `attacker.example:${port}`,
				"X-Forwarded-Host": trustedAuthority(gateway.baseURL),
				"X-Forwarded-Proto": "http",
				Authorization: `Bearer ${gateway.token}`,
			},
		});
		expect(hostileHost.status).toBe(403);
	});

	test("rejects missing, duplicated, comma-joined, userinfo-bearing, and path-bearing authorities", async ({ gateway }) => {
		const authority = trustedAuthority(gateway.baseURL);
		const origin = new URL(gateway.baseURL).origin;
		const auth = `Authorization: Bearer ${gateway.token}`;
		const cases: Array<{ label: string; wire: string }> = [
			{
				label: "missing Host",
				wire: rawLines("GET", "/api/health", [auth], "HTTP/1.0"),
			},
			{
				label: "duplicate Host",
				wire: rawLines("GET", "/api/health", [`Host: ${authority}`, `Host: ${authority}`, auth]),
			},
			{
				label: "comma-joined Host",
				wire: rawLines("GET", "/api/health", [`Host: ${authority}, attacker.example`, auth]),
			},
			{
				label: "userinfo Host",
				wire: rawLines("GET", "/api/health", [`Host: user@${authority}`, auth]),
			},
			{
				label: "path-bearing Host",
				wire: rawLines("GET", "/api/health", [`Host: ${authority}/admin`, auth]),
			},
			{
				label: "duplicate Origin",
				wire: rawLines("GET", "/api/health", [
					`Host: ${authority}`,
					`Origin: ${origin}`,
					`Origin: ${origin}`,
					"Sec-Fetch-Site: same-origin",
					"Sec-Fetch-Mode: cors",
					auth,
				]),
			},
			{
				label: "comma-joined Origin",
				wire: rawLines("GET", "/api/health", [
					`Host: ${authority}`,
					`Origin: ${origin}, https://attacker.example`,
					"Sec-Fetch-Site: same-origin",
					"Sec-Fetch-Mode: cors",
					auth,
				]),
			},
			{
				label: "userinfo Origin",
				wire: rawLines("GET", "/api/health", [
					`Host: ${authority}`,
					`Origin: http://user@${authority}`,
					"Sec-Fetch-Site: same-origin",
					"Sec-Fetch-Mode: cors",
					auth,
				]),
			},
			{
				label: "path-bearing Origin",
				wire: rawLines("GET", "/api/health", [
					`Host: ${authority}`,
					`Origin: ${origin}/path`,
					"Sec-Fetch-Site: same-origin",
					"Sec-Fetch-Mode: cors",
					auth,
				]),
			},
			{
				label: "duplicate Fetch Metadata",
				wire: rawLines("GET", "/api/health", [
					`Host: ${authority}`,
					`Origin: ${origin}`,
					"Sec-Fetch-Site: same-origin",
					"Sec-Fetch-Site: same-origin",
					"Sec-Fetch-Mode: cors",
					auth,
				]),
			},
		];

		for (const testCase of cases) {
			const result = await rawRequest(gateway.baseURL, testCase.wire);
			expect.soft(result.status, `${testCase.label}: ${result.body}`).toBe(403);
		}
	});

	test("applies the top-level navigation exception only to safe UI and preview documents", async ({ gateway }) => {
		const host = trustedAuthority(gateway.baseURL);
		const navigationHeaders = {
			Host: host,
			"Sec-Fetch-Site": "cross-site",
			"Sec-Fetch-Mode": "navigate",
			"Sec-Fetch-Dest": "document",
		};
		for (const path of ["/", `/preview/${randomUUID()}/index.html`]) {
			const result = await request(gateway.baseURL, path, { headers: navigationHeaders });
			expect.soft(result.status, `${path} top-level navigation was rejected by admission`).not.toBe(403);
		}

		const forbidden = [
			await request(gateway.baseURL, "/api/health", {
				headers: { ...navigationHeaders, Authorization: `Bearer ${gateway.token}` },
			}),
			await request(gateway.baseURL, `/preview/${randomUUID()}/index.html`, {
				headers: { ...navigationHeaders, "Sec-Fetch-Dest": "iframe" },
			}),
			await request(gateway.baseURL, "/", {
				method: "POST",
				headers: navigationHeaders,
			}),
			await request(gateway.baseURL, "/", {
				headers: { ...navigationHeaders, Origin: "https://attacker.example" },
			}),
		];
		for (const result of forbidden) expect.soft(result.status, result.body).toBe(403);
	});

	test("admits same-origin preview iframe traffic but rejects sibling, cross-site, and opaque origins", async ({ gateway, scope }) => {
		const session = await scope.createSession({});
		const mounted = await gateway.api(`/api/preview/mount?sessionId=${session.id}`, {
			method: "POST",
			body: JSON.stringify({ html: "<!doctype html><title>admission preview</title>", workspaceTab: false }),
		});
		const mountedText = await mounted.text();
		expect(mounted.status, mountedText).toBe(200);
		const previewPath = (JSON.parse(mountedText) as { url: string }).url;
		const authority = trustedAuthority(gateway.baseURL);
		const accepted = await request(gateway.baseURL, previewPath, {
			headers: {
				Host: authority,
				"Sec-Fetch-Site": "same-origin",
				"Sec-Fetch-Mode": "navigate",
				"Sec-Fetch-Dest": "iframe",
				Authorization: `Bearer ${gateway.token}`,
			},
		});
		expect(accepted.status, accepted.body).toBe(200);

		for (const headers of [
			{
				Origin: "http://sibling.localhost",
				"Sec-Fetch-Site": "same-site",
				"Sec-Fetch-Mode": "navigate",
				"Sec-Fetch-Dest": "iframe",
			},
			{
				"Sec-Fetch-Site": "cross-site",
				"Sec-Fetch-Mode": "navigate",
				"Sec-Fetch-Dest": "iframe",
			},
			{
				Origin: "null",
				"Sec-Fetch-Site": "cross-site",
				"Sec-Fetch-Mode": "cors",
				"Sec-Fetch-Dest": "empty",
			},
		]) {
			const result = await request(gateway.baseURL, previewPath, {
				headers: { Host: authority, Authorization: `Bearer ${gateway.token}`, ...headers },
			});
			expect.soft(result.status, JSON.stringify(headers)).toBe(403);
		}
	});

	test("emits minimal allowlisted CORS headers and denies cross-origin, PNA, method, and header escalation", async ({ gateway }) => {
		const origin = new URL(gateway.baseURL).origin;
		const common = {
			Host: trustedAuthority(gateway.baseURL),
			Origin: origin,
			"Sec-Fetch-Site": "same-origin",
			"Sec-Fetch-Mode": "cors",
			"Access-Control-Request-Method": "POST",
			"Access-Control-Request-Headers": "authorization, content-type",
		};
		const accepted = await request(gateway.baseURL, "/api/sessions", {
			method: "OPTIONS",
			headers: common,
		});
		expect(accepted.status, accepted.body).toBe(204);
		expect(accepted.headers["access-control-allow-origin"]).toBe(origin);
		expect(headerItems(accepted.headers.vary)).toContain("origin");
		expect(headerItems(accepted.headers["access-control-allow-methods"])).toEqual(["post"]);
		expect(headerItems(accepted.headers["access-control-allow-headers"])).toEqual(["authorization", "content-type"]);
		expect(Number(accepted.headers["access-control-max-age"])).toBeGreaterThan(0);
		expect(Number(accepted.headers["access-control-max-age"])).toBeLessThanOrEqual(86_400);
		expect(accepted.headers["access-control-allow-credentials"]).toBeUndefined();
		expect(accepted.headers["access-control-allow-private-network"]).toBeUndefined();

		for (const override of [
			{ Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" },
			{ "Access-Control-Request-Private-Network": "true" },
			{ "Access-Control-Request-Method": "TRACE" },
			{ "Access-Control-Request-Headers": "authorization, x-attacker-header" },
		]) {
			const denied = await request(gateway.baseURL, "/api/sessions", {
				method: "OPTIONS",
				headers: { ...common, ...override },
			});
			expect.soft(denied.status, JSON.stringify(override)).toBe(403);
			expectNoCorsCapability(denied);
		}

		const deniedActual = await request(gateway.baseURL, "/api/sessions", {
			headers: {
				Host: trustedAuthority(gateway.baseURL),
				Origin: "https://attacker.example",
				"Sec-Fetch-Site": "cross-site",
				"Sec-Fetch-Mode": "cors",
				Authorization: `Bearer ${gateway.token}`,
			},
		});
		expect(deniedActual.status).toBe(403);
		expectNoCorsCapability(deniedActual);
	});

	test("allows originless authenticated CLI and sandbox clients while preserving inner authorization", async ({ gateway, scope }) => {
		const unauthenticated = await request(gateway.baseURL, "/api/sessions", {
			headers: { Host: trustedAuthority(gateway.baseURL) },
		});
		expect(unauthenticated.status).toBe(401);

		const cli = await request(gateway.baseURL, "/api/sessions", {
			headers: {
				Host: trustedAuthority(gateway.baseURL),
				Authorization: `Bearer ${gateway.token}`,
			},
		});
		expect(cli.status, cli.body).toBe(200);

		const session = await scope.createSession({});
		const sandboxStore = gateway.sessionManager.sandboxTokenStore;
		const sandboxProject = gateway.defaultProjectId;
		const sandboxToken = sandboxStore.register(sandboxProject);
		sandboxStore.addSession(sandboxProject, session.id);
		try {
			const sandbox = await request(gateway.baseURL, `/api/sessions/${session.id}`, {
				headers: {
					Host: trustedAuthority(gateway.baseURL),
					Authorization: `Bearer ${sandboxToken}`,
					"X-Bobbit-Session-Id": session.id,
				},
			});
			expect(sandbox.status, sandbox.body).toBe(200);
		} finally {
			sandboxStore.removeSession(sandboxProject, session.id);
			sandboxStore.remove(sandboxProject);
		}

		const browserShapedOriginless = await request(gateway.baseURL, "/api/sessions", {
			headers: {
				Host: trustedAuthority(gateway.baseURL),
				Authorization: `Bearer ${gateway.token}`,
				"Sec-Fetch-Site": "same-origin",
				"Sec-Fetch-Mode": "cors",
			},
		});
		expect(browserShapedOriginless.status).toBe(403);
	});

	test("rejects hostile browser upgrades before both viewer and session WebSocket handlers", async ({ gateway, scope }) => {
		const session = await scope.createSession({});
		const origin = new URL(gateway.baseURL).origin;
		for (const suffix of ["viewer", session.id]) {
			const target = `${gateway.wsBase}/ws/${suffix}`;
			const crossSite = await rejectedWebSocketStatus(target, {
				origin: "https://attacker.example",
				headers: {
					"Sec-Fetch-Site": "cross-site",
					"Sec-Fetch-Mode": "websocket",
					Authorization: `Bearer ${gateway.token}`,
				},
			});
			expect.soft(crossSite, `${suffix} accepted a cross-site upgrade`).toBe(403);

			const attackerAuthority = `attacker.example:${new URL(gateway.baseURL).port}`;
			const rebinding = await rejectedWebSocketStatus(target, {
				origin: `http://${attackerAuthority}`,
				headers: {
					Host: attackerAuthority,
					"Sec-Fetch-Site": "same-origin",
					"Sec-Fetch-Mode": "websocket",
				},
			});
			expect.soft(rebinding, `${suffix} accepted equal attacker Host and Origin`).toBe(403);
		}

		await authenticatedWebSocket(`${gateway.wsBase}/ws/${session.id}`, gateway.token);
		await authenticatedWebSocket(`${gateway.wsBase}/ws/viewer`, gateway.token, {
			origin,
			headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "websocket" },
		});
	});

	test("rejects duplicate Host and Origin on WebSocket upgrades before handleUpgrade", async ({ gateway }) => {
		const authority = trustedAuthority(gateway.baseURL);
		const origin = new URL(gateway.baseURL).origin;
		const key = Buffer.alloc(16, 0x61).toString("base64");
		const upgradeHeaders = [
			"Upgrade: websocket",
			"Connection: Upgrade",
			`Sec-WebSocket-Key: ${key}`,
			"Sec-WebSocket-Version: 13",
		];
		for (const headers of [
			[`Host: ${authority}`, `Host: ${authority}`, ...upgradeHeaders],
			[
				`Host: ${authority}`,
				`Origin: ${origin}`,
				`Origin: ${origin}`,
				"Sec-Fetch-Site: same-origin",
				"Sec-Fetch-Mode: websocket",
				...upgradeHeaders,
			],
			[
				`Host: ${authority}`,
				`Origin: ${origin}/path`,
				"Sec-Fetch-Site: same-origin",
				"Sec-Fetch-Mode: websocket",
				...upgradeHeaders,
			],
		]) {
			const result = await rawRequest(gateway.baseURL, rawLines("GET", "/ws/viewer", headers));
			expect.soft(result.status, result.body).toBe(403);
		}
	});

	test("logs bounded reason diagnostics without leaking URL or credential values", async ({ gateway }) => {
		const secret = `request-admission-secret-${randomUUID()}`;
		const warn = vi.spyOn(console, "warn");
		try {
			const result = await request(gateway.baseURL, `/api/health?token=${secret}`, {
				headers: {
					Host: `attacker.example:${new URL(gateway.baseURL).port}`,
					Origin: "https://attacker.example",
					Authorization: `Bearer ${secret}`,
					Cookie: `bobbit_session=${secret}`,
				},
			});
			expect(result.status).toBe(403);
			const diagnostics = warn.mock.calls
				.map(call => call.map(value => String(value)).join(" "))
				.filter(line => /admission/i.test(line))
				.join("\n");
			expect(diagnostics, "a rejected request must emit an admission diagnostic").not.toBe("");
			expect(diagnostics).not.toContain(secret);
			expect(diagnostics).not.toContain("/api/health?");
			expect(diagnostics).not.toContain("authorization");
			expect(diagnostics).not.toContain("cookie");
		} finally {
			warn.mockRestore();
		}
	});
});
