import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createGateway, defaultRpcBridgeFactory, realClock, realCommandRunner, realFetch, realFs } from "../../src/server/server.js";
import { getRegisteredRpcBridgeFactory, registerRpcBridgeFactory, type RpcBridgeFactory } from "../../src/server/agent/rpc-bridge.js";

const previousBobbitDir = process.env.BOBBIT_DIR;

function setTempBobbitDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-gateway-deps-"));
	process.env.BOBBIT_DIR = dir;
	return dir;
}

afterEach(() => {
	if (previousBobbitDir === undefined) delete process.env.BOBBIT_DIR;
	else process.env.BOBBIT_DIR = previousBobbitDir;
	registerRpcBridgeFactory(null);
});

describe("GatewayDeps default-real wiring", () => {
	it("resolves real deps when createGateway is called without deps", async () => {
		const dir = setTempBobbitDir();
		const gateway = createGateway({ host: "127.0.0.1", port: 0, authToken: "token", defaultCwd: dir });
		try {
			expect(gateway.deps.clock).toBe(realClock);
			expect(gateway.deps.commandRunner).toBe(realCommandRunner);
			expect(gateway.deps.fetchImpl).toBe(realFetch);
			expect(gateway.deps.fsImpl).toBe(realFs);
			expect(gateway.deps.agentBridgeFactory).toBe(defaultRpcBridgeFactory);
		} finally {
			await gateway.shutdown();
		}
	});

	it("honors the deprecated registerRpcBridgeFactory alias when no explicit dep is provided", async () => {
		const dir = setTempBobbitDir();
		const aliasFactory: RpcBridgeFactory = () => null;
		registerRpcBridgeFactory(aliasFactory);
		const gateway = createGateway({ host: "127.0.0.1", port: 0, authToken: "token", defaultCwd: dir });
		try {
			expect(gateway.deps.agentBridgeFactory).toBe(aliasFactory);
			expect(getRegisteredRpcBridgeFactory()).toBe(aliasFactory);
		} finally {
			await gateway.shutdown();
		}
	});

	it("explicit agentBridgeFactory overrides the alias and is restored on shutdown", async () => {
		const dir = setTempBobbitDir();
		const aliasFactory: RpcBridgeFactory = () => null;
		const explicitFactory: RpcBridgeFactory = () => null;
		registerRpcBridgeFactory(aliasFactory);
		const gateway = createGateway(
			{ host: "127.0.0.1", port: 0, authToken: "token", defaultCwd: dir },
			{ agentBridgeFactory: explicitFactory },
		);
		try {
			expect(gateway.deps.agentBridgeFactory).toBe(explicitFactory);
			expect(getRegisteredRpcBridgeFactory()).toBe(explicitFactory);
		} finally {
			await gateway.shutdown();
		}
		expect(getRegisteredRpcBridgeFactory()).toBe(aliasFactory);
	});
});
