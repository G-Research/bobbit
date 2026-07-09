// Ported from tests/rpc-bridge-gateway-env.test.ts (straggler-coverage-triage
// GENUINE-LOSS: resolveDirectGatewayEnv). Faithful port — same assertions, vitest.
//
// Direct agents may receive a scoped gateway token minted by SessionManager.
// They must never fall back to the gateway admin token in env.
import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveDirectGatewayEnv } from "../../src/server/agent/rpc-bridge.ts";

// Hermetic isolation: `resolveDirectGatewayEnv` reads `process.env.BOBBIT_GATEWAY_URL`
// as a fallback. On a dev box (or CI) where the shell exports that var — and its
// sibling BOBBIT_TOKEN — subtests that pass `envGatewayUrl: undefined` (expecting
// the state-file fallback) would otherwise inherit the ambient value and fail.
// Snapshot and delete them for the duration of this file, restoring exactly
// (preserving delete-vs-empty) afterwards. This does not change any assertion or
// expected URL — the test simply controls its own environment.
const AMBIENT_ENV_KEYS = ["BOBBIT_GATEWAY_URL", "BOBBIT_TOKEN"] as const;
const savedEnv = new Map<string, string | undefined>();

beforeAll(() => {
	for (const key of AMBIENT_ENV_KEYS) {
		savedEnv.set(key, process.env[key]);
		delete process.env[key];
	}
});

afterAll(() => {
	for (const key of AMBIENT_ENV_KEYS) {
		const prev = savedEnv.get(key);
		if (prev === undefined) delete process.env[key];
		else process.env[key] = prev;
	}
});

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
