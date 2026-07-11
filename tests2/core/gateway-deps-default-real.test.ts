import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { defaultRpcBridgeFactory, realClock, realCommandRunner, realFetch, realFs, resolveGatewayDeps } from "../../src/server/gateway-deps.js";
import { getRegisteredRpcBridgeFactory, registerRpcBridgeFactory, type RpcBridgeFactory } from "../../src/server/agent/rpc-bridge.js";

import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

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
	it("resolves real deps when no deps are provided", () => {
		const deps = resolveGatewayDeps();
		expect(deps.clock).toBe(realClock);
		expect(deps.commandRunner).toBe(realCommandRunner);
		expect(deps.fetchImpl).toBe(realFetch);
		expect(deps.fsImpl).toBe(realFs);
		expect(deps.agentBridgeFactory).toBe(defaultRpcBridgeFactory);
	});

	it("honors the deprecated registerRpcBridgeFactory alias when no explicit dep is provided", async () => {
		const { createGateway } = await import("../../src/server/server.js");
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
		const { createGateway } = await import("../../src/server/server.js");
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
