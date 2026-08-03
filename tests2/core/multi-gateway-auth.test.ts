// v2-native — request-time gateway credential resolution and redaction boundary.
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PreferencesStore } from "../../src/server/agent/preferences-store.js";
import type { ModelConfigCommandRunner } from "../../src/server/agent/model-config-command-runner.js";
import {
	GatewayCredentialResolutionError,
	listGateways,
	proxyRequest,
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

function commandRunner(stdout: unknown = "from-command"): ModelConfigCommandRunner {
	return {
		async execFile() {
			return { stdout, stderr: "" };
		},
	};
}

describe("multi-gateway optional credentials", () => {
	it("supports absent, literal, environment, and command expressions at request time", async () => {
		assert.equal(await resolveGatewayCredential(undefined, "local"), undefined);
		assert.equal(await resolveGatewayCredential("none", "local"), undefined);
		assert.equal(await resolveGatewayCredential("literal-value", "local", {}), "literal-value");
		assert.equal(await resolveGatewayCredential("MULTI_GATEWAY_TOKEN", "local", { MULTI_GATEWAY_TOKEN: "from-env" }), "from-env");
		assert.equal(
			await resolveGatewayCredential(`!node -e "process.stdout.write('from-command')"`, "local", {}, commandRunner()),
			"from-command",
		);
	});

	it("stores only a configured marker publicly and emits the bearer header on demand", async () => {
		const prefs = new PreferencesStore(stateDir);
		saveGateways(prefs, [gateway]);
		setGatewayApiKey(prefs, gateway.id, "MULTI_GATEWAY_TOKEN");
		process.env.MULTI_GATEWAY_TOKEN = "secret-token";
		assert.deepEqual(listGateways(prefs), [{ ...gateway, apiKeyConfigured: true }]);
		assert.deepEqual(await resolveGatewayRequestHeaders(prefs, gateway), { Authorization: "Bearer secret-token" });
	});

	it("sends a gateway bearer only to its configured origin", async () => {
		const prefs = new PreferencesStore(stateDir);
		const received: Array<{ target: "configured" | "external"; authorization?: string }> = [];
		const recipient = (target: "configured" | "external") => http.createServer((req, res) => {
			received.push({ target, authorization: req.headers.authorization });
			res.end("ok");
		});
		const configured = recipient("configured");
		const external = recipient("external");
		await Promise.all([configured, external].map((server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))));
		const configuredUrl = `http://127.0.0.1:${(configured.address() as any).port}`;
		const externalUrl = `http://127.0.0.1:${(external.address() as any).port}`;
		const configuredGateway = { ...gateway, url: configuredUrl };
		saveGateways(prefs, [configuredGateway]);
		setGatewayApiKey(prefs, configuredGateway.id, "literal-secret");
		const forwarder = http.createServer((req, res) => proxyRequest(req.url === "/same" ? configuredUrl : externalUrl, req, res, configuredGateway, prefs));
		await new Promise<void>((resolve) => forwarder.listen(0, "127.0.0.1", resolve));
		try {
			const forwarderUrl = `http://127.0.0.1:${(forwarder.address() as any).port}`;
			await (await fetch(`${forwarderUrl}/same`)).text();
			await (await fetch(`${forwarderUrl}/external`)).text();
			assert.deepEqual(received, [
				{ target: "configured", authorization: "Bearer literal-secret" },
				{ target: "external", authorization: undefined },
			]);
			assert.deepEqual(await resolveGatewayRequestHeaders(prefs, configuredGateway, externalUrl), {});
			setGatewayApiKey(prefs, configuredGateway.id, "!false");
			await assert.rejects(
				resolveGatewayRequestHeaders(prefs, configuredGateway, externalUrl),
				(error: unknown) => error instanceof GatewayCredentialResolutionError,
			);
		} finally {
			await Promise.all([forwarder, configured, external].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
		}
	});

	it("fails closed when a key command fails or emits no key and never reflects the expression", async () => {
		const failures: ModelConfigCommandRunner[] = [
			{ async execFile() { throw new Error("super-secret"); } },
			commandRunner(" \n"),
		];
		for (const runner of failures) {
			await assert.rejects(
				resolveGatewayCredential(`!node -e "process.stderr.write('super-secret'); process.exit(1)"`, "local", {}, runner),
				(error: unknown) => error instanceof GatewayCredentialResolutionError && error.message === 'Unable to resolve API key for gateway "local"',
			);
		}
	});
});
