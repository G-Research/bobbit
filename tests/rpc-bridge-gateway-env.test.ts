/**
 * Unit test: RpcBridge direct-child gateway credential injection.
 *
 * Direct agents may receive a scoped gateway token minted by SessionManager.
 * They must never fall back to the gateway admin token in env.
 *
 * Run with:
 *   npx tsx --test --test-force-exit tests/rpc-bridge-gateway-env.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveDirectGatewayEnv } from "../src/server/agent/rpc-bridge.ts";

function tmpStateDirWith(gatewayUrl: string | null): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-gw-env-"));
	if (gatewayUrl !== null) {
		fs.writeFileSync(path.join(dir, "gateway-url"), gatewayUrl, "utf-8");
	}
	return dir;
}

describe("resolveDirectGatewayEnv", () => {
	it("injects explicit scoped gatewayToken and BOBBIT_GATEWAY_URL from the state file", () => {
		const stateDir = tmpStateDirWith("https://127.0.0.1:3001");
		const env = resolveDirectGatewayEnv(
			{ gatewayToken: "scoped-project-token" },
			{
				stateDir: () => stateDir,
				envGatewayUrl: undefined,
			},
		);
		assert.equal(env.BOBBIT_TOKEN, "scoped-project-token");
		assert.equal(env.BOBBIT_GATEWAY_URL, "https://127.0.0.1:3001");
	});

	it("prefers explicit caller-supplied gatewayToken / gatewayUrl over other URL sources", () => {
		const stateDir = tmpStateDirWith("https://disk-url:3001");
		const env = resolveDirectGatewayEnv(
			{ gatewayToken: "scoped-sandbox-token", gatewayUrl: "https://explicit:9000" },
			{
				stateDir: () => stateDir,
				envGatewayUrl: "https://env-url:3001",
			},
		);
		assert.equal(env.BOBBIT_TOKEN, "scoped-sandbox-token");
		assert.equal(env.BOBBIT_GATEWAY_URL, "https://explicit:9000");
	});

	it("falls back to BOBBIT_GATEWAY_URL from env before reading the state file", () => {
		const stateDir = tmpStateDirWith("https://disk-url:3001");
		const env = resolveDirectGatewayEnv(
			{},
			{
				stateDir: () => stateDir,
				envGatewayUrl: "https://env-url:3001",
			},
		);
		assert.equal(env.BOBBIT_GATEWAY_URL, "https://env-url:3001");
	});

	it("omits BOBBIT_TOKEN when no scoped gatewayToken is supplied", () => {
		const stateDir = tmpStateDirWith("https://disk-url:3001");
		const env = resolveDirectGatewayEnv(
			{},
			{
				stateDir: () => stateDir,
				envGatewayUrl: undefined,
			},
		);
		assert.ok(!("BOBBIT_TOKEN" in env), "BOBBIT_TOKEN must be absent without a scoped token");
		assert.equal(env.BOBBIT_GATEWAY_URL, "https://disk-url:3001");
	});

	it("omits BOBBIT_GATEWAY_URL when neither env nor state file provides one", () => {
		const stateDir = tmpStateDirWith(null);
		const env = resolveDirectGatewayEnv(
			{ gatewayToken: "scoped-token" },
			{
				stateDir: () => stateDir,
				envGatewayUrl: undefined,
			},
		);
		assert.equal(env.BOBBIT_TOKEN, "scoped-token");
		assert.ok(!("BOBBIT_GATEWAY_URL" in env), "BOBBIT_GATEWAY_URL must be absent when unresolvable");
	});
});
