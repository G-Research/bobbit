import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createGateway, realClock, realCommandRunner, realFetch, realFs } from "../../src/server/server.js";

const previousBobbitDir = process.env.BOBBIT_DIR;

afterEach(() => {
	if (previousBobbitDir === undefined) delete process.env.BOBBIT_DIR;
	else process.env.BOBBIT_DIR = previousBobbitDir;
});

describe("GatewayDeps default-real wiring", () => {
	it("resolves real deps when createGateway is called without deps", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-gateway-deps-"));
		process.env.BOBBIT_DIR = dir;
		const gateway = createGateway({ host: "127.0.0.1", port: 0, authToken: "token", defaultCwd: dir });
		try {
			expect(gateway.deps.clock).toBe(realClock);
			expect(gateway.deps.commandRunner).toBe(realCommandRunner);
			expect(gateway.deps.fetchImpl).toBe(realFetch);
			expect(gateway.deps.fsImpl).toBe(realFs);
		} finally {
			await gateway.shutdown();
		}
	});
});
