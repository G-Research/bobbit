import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	api,
	authenticateSocket,
	authHeaders,
	BASE_PATH_IMPLEMENTED,
	bootGateway,
	expectRejectedUpgrade,
	MOUNT,
	registerArchivedSession,
	TOKEN,
	type RunningGateway,
} from "./helpers/base-path-gateway-fixture.js";

describe.skipIf(!BASE_PATH_IMPLEMENTED).sequential("mounted gateway routes, manifest, and sockets", () => {
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
