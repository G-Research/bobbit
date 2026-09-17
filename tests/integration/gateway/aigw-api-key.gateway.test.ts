/**
 * E2E tests for the optional AI Gateway API key.
 *
 * The mock gateway rejects every request that does not carry
 * `Authorization: Bearer <REQUIRED_KEY>`, which proves the key is attached on:
 *   - POST /api/aigw/test (explicit body key, and stored-key reuse for the
 *     configured origin only),
 *   - POST /api/aigw/configure (persisted under `providerKey.aigw` and
 *     published into models.json `providers.aigw.apiKey` for agent traffic),
 *   - GET /api/aigw/status + POST /api/aigw/refresh (stored key),
 *   - the /api/aigw/v1/* proxy and the /api/models/test probe.
 *
 * It also pins the non-leak invariants: the key value never appears in the
 * status response or GET /api/preferences, stored keys are never sent to a
 * different origin, and Disconnect clears the key.
 */

import { test, expect } from "../../../tests/support/harnesses/integration/gateway/in-process-harness.js";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { apiFetch } from "../../../tests/support/harnesses/integration/gateway/e2e-setup.js";

const REQUIRED_KEY = "test-gateway-key-123";

const MOCK_MODELS = {
	data: [
		{ id: "gresearch/qwen3-coder-480b-a35b", object: "model", created: 1700000000, owned_by: "system" },
	],
};

interface RecordedRequest {
	method?: string;
	url?: string;
	authorization?: string;
}

let mockServer: http.Server;
let mockPort: number;
let recordedRequests: RecordedRequest[] = [];

// Second, auth-free gateway used to prove stored keys never cross origins.
let openServer: http.Server;
let openPort: number;
let openRecordedRequests: RecordedRequest[] = [];

function getModelsJsonPath(): string {
	const envDir = process.env.BOBBIT_AGENT_DIR;
	let agentDir: string;
	if (envDir) {
		if (envDir === "~") agentDir = homedir();
		else if (envDir.startsWith("~/")) agentDir = homedir() + envDir.slice(1);
		else agentDir = envDir;
	} else {
		agentDir = join(homedir(), ".bobbit", "agent");
	}
	return join(agentDir, "models.json");
}

function resetRecorded(): void {
	recordedRequests = [];
	openRecordedRequests = [];
}

function lastRecorded(records: RecordedRequest[], path: string): RecordedRequest | undefined {
	return [...records].reverse().find((record) => record.url === path);
}

function listen(server: http.Server): Promise<number> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve((server.address() as any).port);
		});
	});
}

test.beforeAll(async () => {
	// Auth-required gateway: everything except /.well-known/opencode (404, so
	// discovery falls back to /v1/models) demands the bearer key.
	mockServer = http.createServer((req, res) => {
		const authorization = req.headers["authorization"];
		recordedRequests.push({ method: req.method, url: req.url, authorization });
		if (req.url?.startsWith("/.well-known/")) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "not found" }));
			return;
		}
		if (authorization !== `Bearer ${REQUIRED_KEY}`) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "unauthorized" }));
			return;
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		if (req.url === "/v1/chat/completions") {
			res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
			return;
		}
		res.end(JSON.stringify(MOCK_MODELS));
	});
	mockPort = await listen(mockServer);

	openServer = http.createServer((req, res) => {
		openRecordedRequests.push({ method: req.method, url: req.url, authorization: req.headers["authorization"] });
		if (req.url?.startsWith("/.well-known/")) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "not found" }));
			return;
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(MOCK_MODELS));
	});
	openPort = await listen(openServer);
});

test.afterAll(async () => {
	mockServer?.close();
	openServer?.close();
});

test.afterEach(async () => {
	await apiFetch("/api/aigw/configure", { method: "DELETE" });
	resetRecorded();
});

test.describe("AI Gateway API key", () => {
	test("test without a key fails against an auth-required gateway", async () => {
		const res = await apiFetch("/api/aigw/test", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});
		expect(res.status).toBe(502);
		expect(lastRecorded(recordedRequests, "/v1/models")?.authorization).toBeUndefined();
	});

	test("test attaches the submitted key without persisting it", async () => {
		const res = await apiFetch("/api/aigw/test", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}`, apiKey: REQUIRED_KEY }),
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.ok).toBe(true);
		expect(data.models).toHaveLength(1);
		expect(lastRecorded(recordedRequests, "/v1/models")?.authorization).toBe(`Bearer ${REQUIRED_KEY}`);

		// Probe-only: nothing was configured or stored.
		const status = await (await apiFetch("/api/aigw/status")).json();
		expect(status.configured).toBe(false);
	});

	test("configure persists the key, publishes it to models.json, and never echoes it back", async () => {
		const res = await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}`, apiKey: REQUIRED_KEY }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).ok).toBe(true);

		// Agent inference reads the published provider block.
		const modelsPath = getModelsJsonPath();
		expect(existsSync(modelsPath)).toBe(true);
		const modelsJson = JSON.parse(readFileSync(modelsPath, "utf-8"));
		expect(modelsJson.providers?.aigw?.apiKey).toBe(REQUIRED_KEY);

		// Status reports presence only — the raw value must never be returned.
		const statusRes = await apiFetch("/api/aigw/status");
		const statusText = await statusRes.text();
		const status = JSON.parse(statusText);
		expect(status.configured).toBe(true);
		expect(status.hasApiKey).toBe(true);
		expect(statusText).not.toContain(REQUIRED_KEY);

		// The providerKey.* namespace is filtered from the preferences API.
		const prefsText = await (await apiFetch("/api/preferences")).text();
		expect(prefsText).not.toContain(REQUIRED_KEY);
		expect(JSON.parse(prefsText)["providerKey.aigw"]).toBeUndefined();
	});

	test("refresh, proxy, and model probe reuse the stored key", async () => {
		await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}`, apiKey: REQUIRED_KEY }),
		});
		resetRecorded();

		// Refresh re-discovers with the stored key against the auth-required mock.
		const refreshRes = await apiFetch("/api/aigw/refresh", { method: "POST" });
		expect(refreshRes.status).toBe(200);
		expect((await refreshRes.json()).models).toHaveLength(1);
		expect(lastRecorded(recordedRequests, "/v1/models")?.authorization).toBe(`Bearer ${REQUIRED_KEY}`);

		// Browser proxy attaches the stored key server-side.
		const proxyRes = await apiFetch("/api/aigw/v1/models");
		expect(proxyRes.status).toBe(200);
		expect(lastRecorded(recordedRequests, "/v1/models")?.authorization).toBe(`Bearer ${REQUIRED_KEY}`);

		// The per-model Test probe attaches it too.
		const probeRes = await apiFetch("/api/models/test", {
			method: "POST",
			body: JSON.stringify({ pref: "aigw/gresearch/qwen3-coder-480b-a35b" }),
		});
		expect(probeRes.status).toBe(200);
		expect((await probeRes.json()).ok).toBe(true);
		expect(lastRecorded(recordedRequests, "/v1/chat/completions")?.authorization).toBe(`Bearer ${REQUIRED_KEY}`);
	});

	test("test without a key reuses the stored key only for the configured origin", async () => {
		await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}`, apiKey: REQUIRED_KEY }),
		});
		resetRecorded();

		// Same origin as the configured gateway: stored key is reused.
		const sameOrigin = await apiFetch("/api/aigw/test", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});
		expect(sameOrigin.status).toBe(200);
		expect(lastRecorded(recordedRequests, "/v1/models")?.authorization).toBe(`Bearer ${REQUIRED_KEY}`);

		// Different origin: the stored key must not be attached.
		const crossOrigin = await apiFetch("/api/aigw/test", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${openPort}` }),
		});
		expect(crossOrigin.status).toBe(200);
		for (const record of openRecordedRequests) {
			expect(record.authorization, `stored key leaked to ${record.url}`).toBeUndefined();
		}
	});

	test("a failed configure with a new key changes nothing", async () => {
		await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}`, apiKey: REQUIRED_KEY }),
		});

		// Clearing the key means unauthenticated discovery, which this gateway
		// rejects: the failure must leave URL and stored key untouched.
		const res = await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}`, apiKey: "" }),
		});
		expect(res.status).toBe(502);

		const status = await (await apiFetch("/api/aigw/status")).json();
		expect(status.configured).toBe(true);
		expect(status.hasApiKey).toBe(true);
	});

	test("disconnect clears the stored key", async () => {
		await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}`, apiKey: REQUIRED_KEY }),
		});
		const delRes = await apiFetch("/api/aigw/configure", { method: "DELETE" });
		expect(delRes.status).toBe(200);

		// Reconfiguring without a key now fails: the stored key is gone.
		resetRecorded();
		const reconfigure = await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});
		expect(reconfigure.status).toBe(502);
		expect(lastRecorded(recordedRequests, "/v1/models")?.authorization).toBeUndefined();
	});
});
