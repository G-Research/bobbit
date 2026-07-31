import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	authenticateSocket,
	authHeaders,
	BASE_PATH_IMPLEMENTED,
	bootGateway,
	cookiePair,
	MOUNT,
	type RunningGateway,
} from "./helpers/base-path-gateway-fixture.js";

interface TlsFixtureResponse {
	status: number;
	headers: IncomingHttpHeaders;
	body: string;
}

function tlsFixtureRequest(
	running: RunningGateway,
	route: string,
	init: { method?: string; headers?: Record<string, string>; body?: string; headersOnly?: boolean } = {},
): Promise<TlsFixtureResponse> {
	const target = new URL(running.baseUrl);
	const body = init.body ?? "";
	const headers = {
		Host: `bobbit.example:${target.port}`,
		...init.headers,
		...(body ? { "Content-Length": String(Buffer.byteLength(body)) } : {}),
	};
	return new Promise((resolveRequest, rejectRequest) => {
		const request = https.request({
			hostname: target.hostname,
			port: target.port,
			path: `${target.pathname}${route}`,
			method: init.method ?? "GET",
			headers,
			servername: "bobbit.example",
			ca: running.tlsCaCert,
		}, (response) => {
			if (init.headersOnly) {
				resolveRequest({ status: response.statusCode ?? 0, headers: response.headers, body: "" });
				response.destroy();
				request.destroy();
				return;
			}
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
			response.once("end", () => resolveRequest({
				status: response.statusCode ?? 0,
				headers: response.headers,
				body: Buffer.concat(chunks).toString("utf8"),
			}));
		});
		request.once("error", rejectRequest);
		if (body) request.write(body);
		request.end();
	});
}

describe.skipIf(!BASE_PATH_IMPLEMENTED).sequential("headless wildcard-bound gateway cookie policy", () => {
	let running: RunningGateway;
	const uiOrigin = "https://bobbit.example:5173";
	const siblingOrigin = "https://bobbit.example:5174";

	beforeAll(async () => {
		running = await bootGateway(MOUNT, "0.0.0.0", true, {
			serveStatic: false,
			tlsPublicHost: "bobbit.example",
		});
	}, 60_000);

	afterAll(async () => {
		await running?.shutdown();
	}, 60_000);

	it("mints a public-Host cross-port cookie without staticDir and retains cookie-only native transports", async () => {
		const browserHeaders = {
			...authHeaders(),
			Origin: uiOrigin,
			"Sec-Fetch-Site": "same-site",
			"Sec-Fetch-Mode": "cors",
		};
		const bootstrap = await tlsFixtureRequest(running, "/api/health", { headers: browserHeaders });
		expect(bootstrap.status).toBe(200);
		expect(bootstrap.headers["access-control-allow-origin"]).toBe(uiOrigin);
		const setCookie = bootstrap.headers["set-cookie"]?.find((value) => value.startsWith("bobbit_session=")) ?? "";
		expect(setCookie).toContain("bobbit_session=v1.2.");
		expect(setCookie).toContain(`Path=${MOUNT}/`);
		expect(setCookie).toContain("; Secure");
		const cookie = cookiePair(setCookie);

		// Reloaded clients retain only the cookie sentinel, so the real Bearer is
		// deliberately absent from every request below.
		const reload = await tlsFixtureRequest(running, "/api/health", {
			headers: { Cookie: cookie, Origin: uiOrigin },
		});
		expect(reload.status).toBe(200);
		expect(reload.headers["access-control-allow-origin"]).toBe(uiOrigin);

		const sessionId = randomUUID();
		const mounted = await tlsFixtureRequest(running, `/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			headers: { ...authHeaders(), "Content-Type": "application/json" },
			body: JSON.stringify({ html: "<!doctype html><head></head><body>headless preview</body>", workspaceTab: false }),
		});
		expect(mounted.status).toBe(200);
		const preview = JSON.parse(mounted.body) as { url: string };

		const sse = await tlsFixtureRequest(running, `/api/sessions/${sessionId}/preview-events`, {
			headers: { Cookie: cookie, Origin: uiOrigin },
			headersOnly: true,
		});
		expect(sse.status).toBe(200);

		for (const surface of ["iframe", "popout"]) {
			const content = await tlsFixtureRequest(running, preview.url, {
				headers: { Cookie: cookie },
			});
			expect(content.status, surface).toBe(200);
			expect(content.body).toContain("headless preview");
		}

		const target = new URL(running.baseUrl);
		const viewer = await authenticateSocket(`${running.wsOrigin}${MOUNT}/ws/viewer`, {
			origin: uiOrigin,
			headers: { Cookie: cookie, Host: `bobbit.example:${target.port}` },
			rejectUnauthorized: false,
		}, "localhost");
		viewer.close();

		const sibling = await tlsFixtureRequest(running, "/api/health", {
			headers: { Cookie: cookie, Origin: siblingOrigin },
		});
		expect(sibling.status).toBe(401);
		expect(sibling.headers["access-control-allow-origin"]).toBeUndefined();

		const noUi = await tlsFixtureRequest(running, "/", {});
		expect(noUi.status).toBe(404);
	});
});
