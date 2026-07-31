import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CookieStore } from "../../src/server/auth/cookie.js";
import {
	api,
	authenticateSocket,
	authHeaders,
	BASE_PATH_IMPLEMENTED,
	bootGateway,
	cookiePair,
	expectRejectedUpgrade,
	MOUNT,
	openPreviewEvents,
	registerArchivedSession,
	TOKEN,
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

describe.skipIf(!BASE_PATH_IMPLEMENTED).sequential("in-process gateway mounted at a nested base path", () => {
	let running: RunningGateway;

	beforeAll(async () => {
		running = await bootGateway(MOUNT);
	}, 60_000);

	afterAll(async () => {
		await running?.shutdown();
	}, 60_000);

	it("serves mounted API/static/deep-link routes and rejects every off-mount lookalike", async () => {
		const health = await api(running.baseUrl, "/api/health");
		expect(health.status).toBe(200);
		expect(await health.json()).toMatchObject({ status: "ok" });

		for (const path of ["/", "/api/health", "/team", "/team/bobbit-other", "/other/team/bobbit"]) {
			const response = await fetch(`${running.origin}${path}`, { redirect: "manual", headers: authHeaders() });
			expect(response.status, `off-mount ${path}`).toBe(404);
		}

		const redirect = await fetch(`${running.origin}${MOUNT}?x=1&y=two`, { redirect: "manual" });
		expect(redirect.status).toBe(301);
		expect(redirect.headers.get("location")).toBe(`${MOUNT}/?x=1&y=two`);

		const asset = await fetch(`${running.baseUrl}/assets/app.js`);
		expect(asset.status).toBe(200);
		expect(await asset.text()).toBe("globalThis.__basePathAssetLoaded = true;\n");
		expect((await fetch(`${running.origin}/assets/app.js`)).status).toBe(404);

		const shell = await fetch(`${running.baseUrl}/session/copied-id`);
		expect(shell.status).toBe(200);
		const html = await shell.text();
		expect(html).toContain(`window.__BOBBIT_BASE_PATH__ = ${JSON.stringify(MOUNT)}`);
		expect(html).toContain(`src="${MOUNT}/assets/app.js"`);
		expect(html).toContain(`href="${MOUNT}/icons/icon.png"`);
	});

	it("rewrites plain and tokenized manifests and scopes browser cookies to the mount", async () => {
		const plainResponse = await fetch(`${running.baseUrl}/manifest.json`);
		expect(plainResponse.status).toBe(200);
		const plain = await plainResponse.json() as any;
		expect(plain.start_url).toBe(`${MOUNT}/`);
		expect(plain.scope).toBe(`${MOUNT}/`);
		expect(plain.icons[0].src).toBe(`${MOUNT}/icons/icon.png`);

		const tokenResponse = await fetch(`${running.baseUrl}/manifest.json?token=${encodeURIComponent(TOKEN)}`);
		const tokenized = await tokenResponse.json() as any;
		expect(tokenized.start_url).toBe(`${MOUNT}/?token=${encodeURIComponent(TOKEN)}`);
		expect(tokenized.scope).toBe(`${MOUNT}/`);

		const browserHealth = await api(running.baseUrl, "/api/health", {
			headers: {
				Origin: running.origin,
				"Sec-Fetch-Site": "same-origin",
				"Sec-Fetch-Mode": "cors",
			},
		});
		expect(browserHealth.status).toBe(200);
		const setCookie = browserHealth.headers.get("set-cookie") ?? "";
		expect(setCookie).toMatch(/^bobbit_session=/);
		expect(setCookie).toContain(`Path=${MOUNT}/`);
		expect(setCookie).not.toContain("; Secure");
	});

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

		// The browser can attach a still-valid gateway cookie after the operator
		// switches to an explicit remote UI origin. That stale cookie is ineligible
		// for cookie auth, but it must not preempt the real Bearer first frame on
		// either shared upgrade path.
		const staleCookieOptions = { origin: otherOrigin, headers: { Cookie: mountedCookie } };
		const bearerViewer = await authenticateSocket(
			`${running.wsOrigin}${MOUNT}/ws/viewer`,
			staleCookieOptions,
		);
		const bearerSession = await authenticateSocket(
			`${running.wsOrigin}${MOUNT}/ws/${sessionId}`,
			staleCookieOptions,
		);
		bearerViewer.close();
		bearerSession.close();

		// The same stale cookie grants no authority of its own. The client-side
		// localhost sentinel must still fail when no exact-origin cookie exists.
		await expect(authenticateSocket(
			`${running.wsOrigin}${MOUNT}/ws/viewer`,
			staleCookieOptions,
			"localhost",
		)).rejects.toThrow("WebSocket authentication rejected");
	});

	it("keeps preview API, restore, bootstrap, and live SSE payloads mount-relative while browser outputs are prefixed once", async () => {
		const sessionId = randomUUID();
		const mountRoute = `/api/preview/mount?sessionId=${sessionId}`;
		const firstMount = await api(running.baseUrl, mountRoute, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ html: "<!doctype html><head></head><body>first</body>", workspaceTab: false }),
		});
		if (firstMount.status !== 200) throw new Error(`Preview mount returned ${firstMount.status}: ${await firstMount.text()}`);
		const first = await firstMount.json() as { url: string; entry: string; artifactId: string };
		expect(first.url).toBe(`/preview/${sessionId}/${first.entry}`);
		expect(first.url).not.toContain(MOUNT);

		const snapshotResponse = await api(running.baseUrl, `/api/preview/mount?sessionId=${sessionId}`);
		expect(snapshotResponse.status).toBe(200);
		const snapshot = await snapshotResponse.json() as { url: string };
		expect(snapshot.url).toBe(first.url);

		const stream = await openPreviewEvents(`${running.baseUrl}/api/sessions/${sessionId}/preview-events`);
		try {
			await stream.waitForPayloadCount(1);
			expect(stream.payloads[0]?.url).toBe(first.url);

			const secondMount = await api(running.baseUrl, mountRoute, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ html: "<!doctype html><head></head><body>second</body>", entry: "second.html", workspaceTab: false }),
			});
			expect(secondMount.status).toBe(200);
			const second = await secondMount.json() as { url: string };
			await stream.waitForPayloadCount(2);
			expect(stream.payloads[1]?.url).toBe(second.url);
			expect(second.url).toBe(`/preview/${sessionId}/second.html`);

			const restore = await api(running.baseUrl, `/api/preview/artifacts/${encodeURIComponent(first.artifactId)}/restore?sessionId=${sessionId}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ artifactId: first.artifactId }),
			});
			expect(restore.status).toBe(200);
			expect((await restore.json() as { url: string }).url).toBe(first.url);
		} finally {
			stream.close();
		}

		const browserHealth = await api(running.baseUrl, "/api/health", {
			headers: { Origin: running.origin, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
		});
		const cookie = cookiePair(browserHealth.headers.get("set-cookie") ?? "");
		expect(cookie).toMatch(/^bobbit_session=/);

		const noCookie = await fetch(`${running.baseUrl}/preview/${sessionId}/${first.entry}`, { redirect: "manual" });
		expect(noCookie.status).toBe(401);

		const barePreview = await fetch(`${running.baseUrl}/preview/${sessionId}`, {
			redirect: "manual",
			headers: { Cookie: cookie },
		});
		expect(barePreview.status).toBe(301);
		expect(barePreview.headers.get("location")).toBe(`${MOUNT}/preview/${sessionId}/`);

		const entryRedirect = await fetch(`${running.baseUrl}/preview/${sessionId}/`, {
			redirect: "manual",
			headers: { Cookie: cookie },
		});
		expect(entryRedirect.status).toBe(302);
		expect(entryRedirect.headers.get("location")).toBe(`${MOUNT}/preview/${sessionId}/${first.entry}`);

		const content = await fetch(`${running.baseUrl}/preview/${sessionId}/${first.entry}`, { headers: { Cookie: cookie } });
		expect(content.status).toBe(200);
		const previewHtml = await content.text();
		expect(previewHtml).toContain(`data-bobbit-preview-base`);
		expect(previewHtml).toContain(`href="${MOUNT}/preview/${sessionId}/"`);
		expect(previewHtml).not.toContain(`${MOUNT}${MOUNT}`);
	});

	it("accepts mounted viewer and session sockets but rejects unprefixed and sibling upgrades", async () => {
		const sessionId = await registerArchivedSession(running);
		const viewer = await authenticateSocket(`${running.wsOrigin}${MOUNT}/ws/viewer`);
		const session = await authenticateSocket(`${running.wsOrigin}${MOUNT}/ws/${sessionId}`);
		viewer.close();
		session.close();

		await expectRejectedUpgrade(`${running.wsOrigin}/ws/viewer`);
		await expectRejectedUpgrade(`${running.wsOrigin}${MOUNT}-other/ws/viewer`);
		await expectRejectedUpgrade(`${running.wsOrigin}/team/ws/viewer`);
	});
});

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

describe.skipIf(!BASE_PATH_IMPLEMENTED).sequential("root-mounted gateway compatibility", () => {
	let running: RunningGateway;
	let originalShell: string;

	beforeAll(async () => {
		running = await bootGateway("");
		originalShell = readFileSync(join(running.staticDir, "index.html"), "utf8");
	}, 60_000);

	afterAll(async () => {
		await running?.shutdown();
	}, 60_000);

	it("retains root API, shell, manifest, cookie, preview wire shape, and viewer socket behavior", async () => {
		expect((await api(running.baseUrl, "/api/health")).status).toBe(200);
		const shellResponse = await fetch(`${running.origin}/session/root-deep-link`);
		expect(shellResponse.status).toBe(200);
		expect(await shellResponse.text()).toBe(originalShell);

		const manifest = await (await fetch(`${running.origin}/manifest.json`)).json() as any;
		expect(manifest.start_url).toBe("/");
		expect(manifest.scope).toBe("/");
		expect(manifest.icons[0].src).toBe("/icons/icon.png");

		const browserHealth = await api(running.baseUrl, "/api/health", {
			headers: { Origin: running.origin, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
		});
		expect(browserHealth.headers.get("set-cookie")).toContain("Path=/;");

		const previewSession = randomUUID();
		const mount = await api(running.baseUrl, `/api/preview/mount?sessionId=${previewSession}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ html: "<body>root preview</body>", workspaceTab: false }),
		});
		expect(mount.status).toBe(200);
		expect((await mount.json() as { url: string }).url).toMatch(new RegExp(`^/preview/${previewSession}/`));

		const viewer = await authenticateSocket(`${running.wsOrigin}/ws/viewer`);
		viewer.close();
	});
});

describe.skipIf(!BASE_PATH_IMPLEMENTED).sequential("mixed-case loopback gateway auth state", () => {
	let running: RunningGateway;

	beforeAll(async () => {
		running = await bootGateway("", "LOCALHOST", false);
	}, 60_000);

	afterAll(async () => {
		await running?.shutdown();
	}, 60_000);

	it("uses the same disabled-auth decision for HTTP health and viewer WebSockets", async () => {
		const health = await fetch(`${running.baseUrl}/api/health`);
		expect(health.status).toBe(200);
		expect(await health.json()).toMatchObject({ status: "ok", localhost: true });
		const viewer = await authenticateSocket(`${running.wsOrigin}/ws/viewer`, {}, "localhost");
		viewer.close();
	});
});
