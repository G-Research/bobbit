// v2-native — request-time gateway credential resolution and redaction boundary.
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PreferencesStore } from "../../src/server/agent/preferences-store.js";
import {
	GatewayCredentialResolutionError,
	listGateways,
	resolveGatewayCredential,
	resolveGatewayRequestHeaders,
	saveGateways,
	setGatewayApiKey,
} from "../../src/server/agent/aigw-manager.js";

let stateDir = "";
let oldToken: string | undefined;
beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-multi-gateway-auth-")); oldToken = process.env.MULTI_GATEWAY_TOKEN; });
afterEach(() => {
	if (oldToken === undefined) delete process.env.MULTI_GATEWAY_TOKEN;
	else process.env.MULTI_GATEWAY_TOKEN = oldToken;
	fs.rmSync(stateDir, { recursive: true, force: true });
});

const gateway = { id: "local-id", name: "local", url: "http://localhost:8080", type: "openai-compatible" as const, enabled: true };

describe("multi-gateway optional credentials", () => {
	it("supports absent, literal, environment, and command expressions at request time", async () => {
		assert.equal(await resolveGatewayCredential(undefined, "local"), undefined);
		assert.equal(await resolveGatewayCredential("none", "local"), undefined);
		assert.equal(await resolveGatewayCredential("literal-value", "local", {}), "literal-value");
		assert.equal(await resolveGatewayCredential("MULTI_GATEWAY_TOKEN", "local", { MULTI_GATEWAY_TOKEN: "from-env" }), "from-env");
		assert.equal(await resolveGatewayCredential(`!node -e "process.stdout.write('from-command')"`, "local"), "from-command");
	});

	it("stores only a configured marker publicly and emits the bearer header on demand", async () => {
		const prefs = new PreferencesStore(stateDir);
		saveGateways(prefs, [gateway]);
		setGatewayApiKey(prefs, gateway.id, "MULTI_GATEWAY_TOKEN");
		process.env.MULTI_GATEWAY_TOKEN = "secret-token";
		assert.deepEqual(listGateways(prefs), [{ ...gateway, apiKeyConfigured: true }]);
		assert.deepEqual(await resolveGatewayRequestHeaders(prefs, gateway), { Authorization: "Bearer secret-token" });
	});

	it("fails closed when a key command fails and never reflects the expression", async () => {
		await assert.rejects(
			resolveGatewayCredential(`!node -e "process.stderr.write('super-secret'); process.exit(1)"`, "local"),
			(error: unknown) => error instanceof GatewayCredentialResolutionError && error.message === 'Unable to resolve API key for gateway "local"',
		);
	});
});
