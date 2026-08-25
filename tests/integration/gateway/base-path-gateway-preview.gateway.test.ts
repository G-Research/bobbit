import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	api,
	BASE_PATH_IMPLEMENTED,
	bootGateway,
	cookiePair,
	MOUNT,
	openPreviewEvents,
	type RunningGateway,
} from "./_helpers/base-path-gateway-fixture.js";

describe.skipIf(!BASE_PATH_IMPLEMENTED).sequential("mounted gateway preview and SSE routes", () => {
	let running: RunningGateway;

	beforeAll(async () => {
		running = await bootGateway(MOUNT);
	}, 60_000);

	afterAll(async () => {
		await running?.shutdown();
	}, 60_000);

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
});
