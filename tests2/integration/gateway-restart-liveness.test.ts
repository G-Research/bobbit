import { expect, test } from "vitest";
import { getGateway } from "../harness/gateway.js";

test("gateway fixture recovers an interrupted crash and coalesces concurrent restarts", async () => {
	const gateway = await getGateway();
	const token = gateway.token;
	const bobbitDir = gateway.bobbitDir;
	const clock = gateway.clock;

	await gateway.crash();
	await gateway.crash();

	const recovered = await getGateway();
	expect(recovered).toBe(gateway);
	expect(recovered.token).toBe(token);
	expect(recovered.bobbitDir).toBe(bobbitDir);
	expect(recovered.clock).toBe(clock);
	expect((await recovered.api("/health")).status).toBe(200);

	await Promise.all([recovered.restart(), recovered.restart()]);
	expect((await recovered.api("/health")).status).toBe(200);
});
