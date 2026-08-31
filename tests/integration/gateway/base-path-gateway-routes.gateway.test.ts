import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recordEventLoopOperation } from "../../../src/server/agent/cpu-diagnostics.js";

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
} from "../../../tests2/integration/helpers/base-path-gateway-fixture.js";

describe.skipIf(!BASE_PATH_IMPLEMENTED).sequential("mounted gateway routes, manifest, and sockets", () => {
	let running: RunningGateway;
	let gatewayUrlSeenAtRestore: string | undefined;

	beforeAll(async () => {
		running = await bootGateway(MOUNT, "127.0.0.1", true, {
			staleGatewayUrl: "http://stale.invalid/wrong-mount",
			observeSessionRestoreGatewayUrl: (gatewayUrl) => { gatewayUrlSeenAtRestore = gatewayUrl; },
		});
	}, 60_000);

	afterAll(async () => {
		await running?.shutdown();
	}, 60_000);

	it("replaces a stale agent URL before session restore", () => {
		expect(running.lifecycleGatewayInfo().baseUrl).toBe(running.baseUrl);
		expect(gatewayUrlSeenAtRestore).toBe(running.baseUrl);
		expect(running.agentGatewayUrl()).toBe(running.baseUrl);
		expect(readFileSync(join(running.root, "state", "gateway-url"), "utf8")).toBe(running.baseUrl);
		expect(readdirSync(join(running.root, "state")).some((name) => /^gateway-url\..*\.tmp$/u.test(name))).toBe(false);
	});

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

	it("authenticates a ready upgrade despite a previously recorded event-loop stall", async () => {
		// Lag is historical by the time this upgrade arrives. It remains useful for
		// diagnostics, but must not reject a gateway that is now ready to auth.
		recordEventLoopOperation("test:historical-stall", 750);
		const viewer = await authenticateSocket(`${running.wsOrigin}${MOUNT}/ws/viewer`);
		viewer.close();
	});
});

describe.skipIf(!BASE_PATH_IMPLEMENTED).sequential("programmatic mounted gateway callback publication", () => {
	it("publishes an absent agent URL before restore using the bound IPv6 port", async () => {
		let gatewayUrlSeenAtRestore: string | undefined;
		const running = await bootGateway(MOUNT, "::1", true, {
			serveStatic: false,
			observeSessionRestoreGatewayUrl: (gatewayUrl) => { gatewayUrlSeenAtRestore = gatewayUrl; },
		});
		try {
			expect(running.lifecycleGatewayInfo().baseUrl).toBe(running.baseUrl);
			expect(running.baseUrl).toMatch(/^http:\/\/\[::1\]:\d+\/team\/bobbit$/);
			expect(gatewayUrlSeenAtRestore).toBe(running.baseUrl);
			expect(running.agentGatewayUrl()).toBe(running.baseUrl);
			expect(readFileSync(join(running.root, "state", "gateway-url"), "utf8")).toBe(running.baseUrl);
		} finally {
			await running.shutdown();
		}
	}, 60_000);

	it("accepts an authoritative HTTP(S) origin with the configured mount", async () => {
		let actualPort = 0;
		let gatewayUrlSeenAtRestore: string | undefined;
		const running = await bootGateway(MOUNT, "127.0.0.1", true, {
			serveStatic: false,
			onBound: (port) => {
				actualPort = port;
				const callbackUrl = `https://[2001:db8::42]:${port}${MOUNT}`;
				return `${callbackUrl}/`;
			},
			observeSessionRestoreGatewayUrl: (gatewayUrl) => { gatewayUrlSeenAtRestore = gatewayUrl; },
		});
		try {
			const expectedUrl = `https://[2001:db8::42]:${actualPort}${MOUNT}`;
			expect(actualPort).toBeGreaterThan(0);
			expect(running.lifecycleGatewayInfo().baseUrl).toBe(expectedUrl);
			expect(gatewayUrlSeenAtRestore).toBe(expectedUrl);
			expect(running.agentGatewayUrl()).toBe(expectedUrl);
			expect(readFileSync(join(running.root, "state", "gateway-url"), "utf8")).toBe(expectedUrl);
		} finally {
			await running.shutdown();
		}
	}, 60_000);

	it("rejects a callback path that differs from the configured mount before restore", async () => {
		let restoreStarted = false;
		await expect(bootGateway(MOUNT, "127.0.0.1", true, {
			serveStatic: false,
			onBound: () => "https://public.example.test/public/gateway/",
			observeSessionRestoreGatewayUrl: () => { restoreStarted = true; },
		})).rejects.toThrow(/callback URL path.*must match configured base path/i);
		expect(restoreStarted).toBe(false);
	}, 60_000);

	it("rejects an unsafe callback override before agents or extensions resume", async () => {
		let restoreStarted = false;
		await expect(bootGateway(MOUNT, "127.0.0.1", true, {
			serveStatic: false,
			onBound: () => "http://127.0.0.1:3001/team/../escape",
			observeSessionRestoreGatewayUrl: () => { restoreStarted = true; },
		})).rejects.toThrow(/Gateway callback URL|dot segments/i);
		expect(restoreStarted).toBe(false);
	}, 60_000);
});
