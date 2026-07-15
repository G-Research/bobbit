import { describe, expect, it } from "vitest";
import type { RpcBridgeFactory } from "../../src/server/agent/rpc-bridge.js";
import { loadServerTestRuntime } from "../harness/server-runtime.js";

describe("GatewayDeps default-real wiring", () => {
	it("resolves real deps when no deps are provided", async () => {
		const { gatewayDeps } = await loadServerTestRuntime();
		const deps = gatewayDeps.resolveGatewayDeps();
		expect(deps.clock).toBe(gatewayDeps.realClock);
		expect(deps.commandRunner).toBe(gatewayDeps.realCommandRunner);
		expect(deps.fetchImpl).toBe(gatewayDeps.realFetch);
		expect(deps.fsImpl).toBe(gatewayDeps.realFs);
		expect(deps.agentBridgeFactory).toBe(gatewayDeps.defaultRpcBridgeFactory);
	});

	it("honors the deprecated registerRpcBridgeFactory alias when no explicit dep is provided", async () => {
		const { rpcBridge, server } = await loadServerTestRuntime();
		const aliasFactory: RpcBridgeFactory = () => null;
		rpcBridge.registerRpcBridgeFactory(aliasFactory);
		try {
			const installed = server.installGatewayBridgeDeps();
			expect(installed.gatewayDeps.agentBridgeFactory).toBe(aliasFactory);
			expect(rpcBridge.getRegisteredRpcBridgeFactory()).toBe(aliasFactory);
			installed.restoreExplicitRpcBridgeFactory();
		} finally {
			rpcBridge.registerRpcBridgeFactory(null);
		}
	});

	it("explicit agentBridgeFactory overrides the alias and is restored on shutdown", async () => {
		const { rpcBridge, server } = await loadServerTestRuntime();
		const aliasFactory: RpcBridgeFactory = () => null;
		const explicitFactory: RpcBridgeFactory = () => null;
		rpcBridge.registerRpcBridgeFactory(aliasFactory);
		try {
			const installed = server.installGatewayBridgeDeps({ agentBridgeFactory: explicitFactory });
			expect(installed.gatewayDeps.agentBridgeFactory).toBe(explicitFactory);
			expect(rpcBridge.getRegisteredRpcBridgeFactory()).toBe(explicitFactory);
			installed.restoreExplicitRpcBridgeFactory();
			expect(rpcBridge.getRegisteredRpcBridgeFactory()).toBe(aliasFactory);
		} finally {
			rpcBridge.registerRpcBridgeFactory(null);
		}
	});
});
