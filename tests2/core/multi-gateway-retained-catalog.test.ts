// v2-native — semantic empty/unreachable status and URL-scoped retained models.
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PreferencesStore } from "../../src/server/agent/preferences-store.js";
import { getGatewayStatus } from "../../src/server/agent/aigw-manager.js";
import { resetAgentDirStateForTests } from "../../src/server/bobbit-dir.js";
import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

let dir = "";
let previousAgentDir: string | undefined;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-multi-gateway-retained-")); previousAgentDir = process.env.BOBBIT_AGENT_DIR; process.env.BOBBIT_AGENT_DIR = dir; resetAgentDirStateForTests(); });
afterEach(() => { if (previousAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR; else process.env.BOBBIT_AGENT_DIR = previousAgentDir; resetAgentDirStateForTests(); fs.rmSync(dir, { recursive: true, force: true }); });

function startGateway(models: unknown[]): Promise<{ url: string; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => {
		if (req.url === "/.well-known/opencode") { res.writeHead(404); res.end(); return; }
		if (req.url === "/v1/models") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ data: models })); return; }
		res.writeHead(404); res.end();
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
		const port = (server.address() as { port: number }).port;
		resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((done) => server.close(() => done())) });
	}));
}

describe("multi-gateway retained discovery catalog", () => {
	it("distinguishes successful empty discovery from an unreachable matching retained block", async () => {
		const live = await startGateway([]);
		try {
			const prefs = new PreferencesStore(path.join(dir, "state"));
			const liveGateway = { id: "live", name: "local", url: live.url, type: "openai-compatible" as const, enabled: true };
			assert.deepEqual(await getGatewayStatus(prefs, liveGateway), { state: "empty", models: [] });

			const offlineGateway = { ...liveGateway, url: "http://127.0.0.1:9" };
			fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { local: { baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "retained-local" }] } } }));
			assert.deepEqual(await getGatewayStatus(prefs, offlineGateway), { state: "unreachable", models: [{ id: "retained-local" }], error: "Gateway is unreachable" });
		} finally { await live.close(); }
	});

	it("rejects retained models when the provider block targets another URL", async () => {
		const prefs = new PreferencesStore(path.join(dir, "state"));
		const gateway = { id: "offline", name: "local", url: "http://127.0.0.1:9", type: "openai-compatible" as const, enabled: true };
		fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { local: { baseUrl: "http://127.0.0.1:9999/v1", models: [{ id: "stale" }] } } }));
		assert.deepEqual(await getGatewayStatus(prefs, gateway), { state: "unreachable", models: [], error: "Gateway is unreachable" });
	});
});
