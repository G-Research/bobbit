/**
 * Unit test: RpcBridge direct-child gateway credential injection.
 *
 * After the S1 secret relocation the gateway token no longer lives at a
 * project-reachable `<dir>/state/token`, so the on-disk fallback in the
 * agent-side helpers (defaults/tools/_shared/gateway.ts,
 * tool-guard-extension.ts, tool-activation.ts) fails with "token not found".
 * Direct (non-sandbox) children are spawned with a plain env that lacked
 * BOBBIT_TOKEN / BOBBIT_GATEWAY_URL, so those helpers could not authenticate.
 *
 * resolveDirectGatewayEnv() mirrors how sandbox sessions get gatewayToken:
 * it injects BOBBIT_TOKEN=readToken() and BOBBIT_GATEWAY_URL into the env,
 * never writing the token to disk. This pins that behavior.
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
	it("injects BOBBIT_TOKEN from readToken() and BOBBIT_GATEWAY_URL from the state file", () => {
		const stateDir = tmpStateDirWith("https://127.0.0.1:3001");
		const env = resolveDirectGatewayEnv(
			{},
			{
				readToken: () => "a".repeat(64),
				stateDir: () => stateDir,
				envGatewayUrl: undefined,
			},
		);
		assert.equal(env.BOBBIT_TOKEN, "a".repeat(64));
		assert.equal(env.BOBBIT_GATEWAY_URL, "https://127.0.0.1:3001");
	});

	it("prefers explicit caller-supplied gatewayToken / gatewayUrl over the disk sources", () => {
		const stateDir = tmpStateDirWith("https://disk-url:3001");
		const env = resolveDirectGatewayEnv(
			{ gatewayToken: "scoped-sandbox-token", gatewayUrl: "https://explicit:9000" },
			{
				readToken: () => "b".repeat(64),
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
				readToken: () => "c".repeat(64),
				stateDir: () => stateDir,
				envGatewayUrl: "https://env-url:3001",
			},
		);
		assert.equal(env.BOBBIT_GATEWAY_URL, "https://env-url:3001");
	});

	it("omits BOBBIT_TOKEN when no token is resolvable (never writes an empty credential)", () => {
		const stateDir = tmpStateDirWith("https://disk-url:3001");
		const env = resolveDirectGatewayEnv(
			{},
			{
				readToken: () => null,
				stateDir: () => stateDir,
				envGatewayUrl: undefined,
			},
		);
		assert.ok(!("BOBBIT_TOKEN" in env), "BOBBIT_TOKEN must be absent when no token resolves");
		assert.equal(env.BOBBIT_GATEWAY_URL, "https://disk-url:3001");
	});

	it("omits BOBBIT_GATEWAY_URL when neither env nor state file provides one", () => {
		const stateDir = tmpStateDirWith(null); // no gateway-url file written
		const env = resolveDirectGatewayEnv(
			{},
			{
				readToken: () => "d".repeat(64),
				stateDir: () => stateDir,
				envGatewayUrl: undefined,
			},
		);
		assert.equal(env.BOBBIT_TOKEN, "d".repeat(64));
		assert.ok(!("BOBBIT_GATEWAY_URL" in env), "BOBBIT_GATEWAY_URL must be absent when unresolvable");
	});
});
