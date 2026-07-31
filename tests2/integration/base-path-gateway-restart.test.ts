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

describe.skipIf(!BASE_PATH_IMPLEMENTED).sequential("direct cross-port browser cookie binding", () => {
	let running: RunningGateway;

	beforeAll(async () => {
		running = await bootGateway(MOUNT, "localhost", true);
	}, 60_000);

	afterAll(async () => {
		await running?.shutdown();
	}, 60_000);

	it("recovers only the cookie's exact cross-port origin after process restarts", async () => {
		const uiOrigin = "http://localhost.:5173";
		const siblingOrigin = "http://localhost.:5174";
		const preflight = (origin: string) => fetch(`${running.baseUrl}/api/setup-status/dismiss`, {
			method: "OPTIONS",
			headers: {
				Origin: origin,
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "content-type",
			},
		});
		const mutateWithCookie = (origin: string, cookie: string) => fetch(`${running.baseUrl}/api/setup-status/dismiss`, {
			method: "POST",
			headers: {
				Cookie: cookie,
				Origin: origin,
				"Content-Type": "application/json",
				"Sec-Fetch-Site": "same-site",
				"Sec-Fetch-Mode": "cors",
			},
			body: "{}",
		});

		const bootstrap = await fetch(`${running.baseUrl}/api/health`, {
			headers: {
				...authHeaders(),
				Origin: uiOrigin,
				"Sec-Fetch-Site": "same-site",
				"Sec-Fetch-Mode": "cors",
			},
		});
		expect(bootstrap.status).toBe(200);
		expect(bootstrap.headers.get("access-control-allow-origin")).toBe(uiOrigin);
		const setCookie = bootstrap.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("bobbit_session=v1.2.");
		expect(setCookie).toContain(`Path=${MOUNT}/`);
		const cookie = cookiePair(setCookie);

		await running.restart();

		// A fresh process has no volatile preflight state. Neither the exact UI
		// nor a same-host sibling is reflected until the signed claim is verified.
		expect((await preflight(uiOrigin)).headers.get("access-control-allow-origin")).toBeNull();
		expect((await preflight(siblingOrigin)).headers.get("access-control-allow-origin")).toBeNull();
		const siblingRead = await fetch(`${running.baseUrl}/api/health`, {
			headers: { Cookie: cookie, Origin: siblingOrigin },
		});
		expect(siblingRead.status).toBe(401);
		expect(siblingRead.headers.get("access-control-allow-origin")).toBeNull();
		await expect(authenticateSocket(`${running.wsOrigin}${MOUNT}/ws/viewer`, {
			origin: siblingOrigin,
			headers: { Cookie: cookie },
		}, "localhost")).rejects.toThrow("WebSocket authentication rejected");

		// A cookie-authenticated WebSocket reconstructs only its signed Origin.
		const viewer = await authenticateSocket(`${running.wsOrigin}${MOUNT}/ws/viewer`, {
			origin: uiOrigin,
			headers: { Cookie: cookie },
		}, "localhost");
		viewer.close();
		const websocketRecoveredPreflight = await preflight(uiOrigin);
		expect(websocketRecoveredPreflight.headers.get("access-control-allow-origin")).toBe(uiOrigin);
		const websocketRecoveredMutation = await mutateWithCookie(uiOrigin, cookie);
		expect(websocketRecoveredMutation.status).toBe(200);
		expect(websocketRecoveredMutation.headers.get("access-control-allow-origin")).toBe(uiOrigin);
		expect((await preflight(siblingOrigin)).headers.get("access-control-allow-origin")).toBeNull();

		await running.restart();
		expect((await preflight(uiOrigin)).headers.get("access-control-allow-origin")).toBeNull();

		// The same recovery is independently available through a CORS-simple GET.
		const simpleRead = await fetch(`${running.baseUrl}/api/health`, {
			headers: { Cookie: cookie, Origin: uiOrigin },
		});
		expect(simpleRead.status).toBe(200);
		expect(simpleRead.headers.get("access-control-allow-origin")).toBe(uiOrigin);
		const httpRecoveredPreflight = await preflight(uiOrigin);
		expect(httpRecoveredPreflight.headers.get("access-control-allow-origin")).toBe(uiOrigin);
		const httpRecoveredMutation = await mutateWithCookie(uiOrigin, cookie);
		expect(httpRecoveredMutation.status).toBe(200);
		expect(httpRecoveredMutation.headers.get("access-control-allow-origin")).toBe(uiOrigin);
		expect((await preflight(siblingOrigin)).headers.get("access-control-allow-origin")).toBeNull();
	});
});
