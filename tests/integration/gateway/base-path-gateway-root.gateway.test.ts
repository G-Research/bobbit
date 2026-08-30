import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	api,
	authenticateSocket,
	BASE_PATH_IMPLEMENTED,
	bootGateway,
	type RunningGateway,
} from "../../../tests2/integration/helpers/base-path-gateway-fixture.js";

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
