import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	getRegisteredRpcBridgeFactory,
	registerRpcBridgeFactory,
	type RpcBridgeFactory,
} from "../../src/server/agent/rpc-bridge.js";
import {
	defaultRpcBridgeFactory,
	realClock,
	realCommandRunner,
	realFetch,
	realFs,
	resolveGatewayDeps,
} from "../../src/server/gateway-deps.js";
import { installGatewayBridgeDeps } from "../../src/server/server.js";

const SERVER_SOURCE = readFileSync(fileURLToPath(new URL("../../src/server/server.ts", import.meta.url)), "utf8");

describe("GatewayDeps default-real wiring", () => {
	it("passes the injected SDK bridge factory into SessionManager", () => {
		const construction = SERVER_SOURCE.match(/const sessionManager = new SessionManager\(\{([\s\S]*?)\n\t\}\);/);
		expect(construction?.[1]).toContain("claudeAgentSdkBridgeDepsFactory: gatewayDeps.claudeAgentSdkBridgeDepsFactory,");
	});

	it("resolves real deps when no deps are provided", () => {
		const deps = resolveGatewayDeps();
		expect(deps.clock).toBe(realClock);
		expect(deps.commandRunner).toBe(realCommandRunner);
		expect(deps.fetchImpl).toBe(realFetch);
		expect(deps.fsImpl).toBe(realFs);
		expect(deps.agentBridgeFactory).toBe(defaultRpcBridgeFactory);
	});

	it("honors the deprecated registerRpcBridgeFactory alias when no explicit dep is provided", () => {
		const aliasFactory: RpcBridgeFactory = () => null;
		registerRpcBridgeFactory(aliasFactory);
		try {
			const installed = installGatewayBridgeDeps();
			expect(installed.gatewayDeps.agentBridgeFactory).toBe(aliasFactory);
			expect(getRegisteredRpcBridgeFactory()).toBe(aliasFactory);
			installed.restoreExplicitRpcBridgeFactory();
		} finally {
			registerRpcBridgeFactory(null);
		}
	});

	it("explicit agentBridgeFactory overrides the alias and is restored on shutdown", () => {
		const aliasFactory: RpcBridgeFactory = () => null;
		const explicitFactory: RpcBridgeFactory = () => null;
		registerRpcBridgeFactory(aliasFactory);
		try {
			const installed = installGatewayBridgeDeps({ agentBridgeFactory: explicitFactory });
			expect(installed.gatewayDeps.agentBridgeFactory).toBe(explicitFactory);
			expect(getRegisteredRpcBridgeFactory()).toBe(explicitFactory);
			installed.restoreExplicitRpcBridgeFactory();
			expect(getRegisteredRpcBridgeFactory()).toBe(aliasFactory);
		} finally {
			registerRpcBridgeFactory(null);
		}
	});
});
