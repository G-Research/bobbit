import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CookieStore } from "../../src/server/auth/cookie.js";
import {
	authenticateSocket,
	authHeaders,
	BASE_PATH_IMPLEMENTED,
	bootGateway,
	cookiePair,
	MOUNT,
	registerArchivedSession,
	type RunningGateway,
} from "./helpers/base-path-gateway-fixture.js";

describe.skipIf(!BASE_PATH_IMPLEMENTED).sequential("mounted gateway origin-bound authentication", () => {
	let running: RunningGateway;

	beforeAll(async () => {
		running = await bootGateway(MOUNT);
	}, 60_000);

	afterAll(async () => {
		await running?.shutdown();
	}, 60_000);

	it("migrates legacy root cookies and binds HTTP, CORS preflight, and WebSocket use to the bootstrapping UI origin", async () => {
		const signingKey = readFileSync(join(running.root, "secrets", "cookie-signing-key"));
		const cookieStore = new CookieStore(signingKey);
		const legacy = cookieStore.mint();
		const uiOrigin = "http://127.0.0.1:5173";
		const otherOrigin = "http://127.0.0.1:5174";
		const rootBound = cookieStore.mint({ basePath: "", origin: uiOrigin });
		const staleRootCookies = `bobbit_session=${legacy}; bobbit_session=${rootBound}`;
		const migration = await fetch(`${running.baseUrl}/api/health`, {
			headers: {
				...authHeaders(),
				Cookie: staleRootCookies,
				Origin: uiOrigin,
				"Sec-Fetch-Site": "same-site",
				"Sec-Fetch-Mode": "cors",
			},
		});
		expect(migration.status).toBe(200);
		const setCookies = (migration.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
			?? [migration.headers.get("set-cookie") ?? ""];
		expect(setCookies.some((value) => /bobbit_session=;.*Path=\/;.*Max-Age=0/.test(value))).toBe(true);
		const mountedSetCookie = setCookies.find((value) => value.includes(`Path=${MOUNT}/`) && value.includes("bobbit_session=v1.2."));
		expect(mountedSetCookie).toBeDefined();
		const mountedCookie = cookiePair(mountedSetCookie!);

		const staleOnly = await fetch(`${running.baseUrl}/api/health`, {
			headers: { Cookie: staleRootCookies, Origin: uiOrigin },
		});
		expect(staleOnly.status).toBe(401);
		expect(staleOnly.headers.get("access-control-allow-origin")).toBeNull();

		const exact = await fetch(`${running.baseUrl}/api/health`, {
			headers: { Cookie: mountedCookie, Origin: uiOrigin },
		});
		expect(exact.status).toBe(200);
		expect(exact.headers.get("access-control-allow-origin")).toBe(uiOrigin);
		expect(exact.headers.get("access-control-allow-credentials")).toBe("true");

		const mismatch = await fetch(`${running.baseUrl}/api/health`, {
			headers: { Cookie: mountedCookie, Origin: otherOrigin },
		});
		expect(mismatch.status).toBe(401);
		expect(mismatch.headers.get("access-control-allow-origin")).toBeNull();
		expect(mismatch.headers.get("access-control-allow-credentials")).toBeNull();

		const mismatchSse = await fetch(`${running.baseUrl}/api/sessions/00000000-0000-4000-8000-000000000001/preview-events`, {
			headers: { Cookie: mountedCookie, Origin: otherOrigin },
		});
		expect(mismatchSse.status).toBe(401);
		const mismatchPreview = await fetch(`${running.baseUrl}/preview/00000000-0000-4000-8000-000000000001/index.html`, {
			headers: { Cookie: mountedCookie, Origin: otherOrigin },
		});
		expect(mismatchPreview.status).toBe(401);

		const exactPreflight = await fetch(`${running.baseUrl}/api/config`, {
			method: "OPTIONS",
			headers: {
				Origin: uiOrigin,
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "content-type",
			},
		});
		expect(exactPreflight.status).toBe(204);
		expect(exactPreflight.headers.get("access-control-allow-origin")).toBe(uiOrigin);

		const mismatchPreflight = await fetch(`${running.baseUrl}/api/config`, {
			method: "OPTIONS",
			headers: {
				Origin: otherOrigin,
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "content-type",
			},
		});
		expect(mismatchPreflight.status).toBe(204);
		expect(mismatchPreflight.headers.get("access-control-allow-origin")).toBeNull();
		expect(mismatchPreflight.headers.get("access-control-allow-credentials")).toBeNull();

		// Reloaded cookie-compatible clients persist only the non-secret
		// `localhost` sentinel. The exact bound HttpOnly cookie must therefore
		// authorize both socket types before that first auth frame is evaluated.
		const sessionId = await registerArchivedSession(running);
		const socketOptions = { origin: uiOrigin, headers: { Cookie: mountedCookie } };
		const exactViewer = await authenticateSocket(
			`${running.wsOrigin}${MOUNT}/ws/viewer`,
			socketOptions,
			"localhost",
		);
		const exactSession = await authenticateSocket(
			`${running.wsOrigin}${MOUNT}/ws/${sessionId}`,
			socketOptions,
			"localhost",
		);
		exactViewer.close();
		exactSession.close();
	});
});
