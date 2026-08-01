import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	authenticateSocket,
	BASE_PATH_IMPLEMENTED,
	bootGateway,
	MOUNT,
	registerArchivedSession,
	type RunningGateway,
} from "./helpers/base-path-gateway-fixture.js";

describe.skipIf(!BASE_PATH_IMPLEMENTED).sequential("mounted loopback gateway localhost sentinel", () => {
	let running: RunningGateway;

	beforeAll(async () => {
		running = await bootGateway(MOUNT, "127.0.0.1", false);
	}, 60_000);

	afterAll(async () => {
		await running?.shutdown();
	}, 60_000);

	it("accepts the localhost sentinel on prefixed viewer and session sockets when token auth is disabled", async () => {
		const health = await fetch(`${running.baseUrl}/api/health`);
		expect(health.status).toBe(200);
		expect(await health.json()).toMatchObject({ localhost: true });

		const sessionId = await registerArchivedSession(running);
		const viewer = await authenticateSocket(
			`${running.wsOrigin}${MOUNT}/ws/viewer`,
			{},
			"localhost",
		);
		const session = await authenticateSocket(
			`${running.wsOrigin}${MOUNT}/ws/${sessionId}`,
			{},
			"localhost",
		);
		viewer.close();
		session.close();
	});
});
