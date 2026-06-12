/**
 * E2E tests for the full AI Gateway configure flow using a mock gateway.
 *
 * Spins up a tiny HTTP server that mimics the /v1/models endpoint,
 * then tests configure → status → model discovery end-to-end.
 */

import { test, expect } from "./in-process-harness.js";
import http from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { apiFetch } from "./e2e-setup.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const PACKAGE_VERSION = JSON.parse(readFileSync(resolve(PROJECT_ROOT, "package.json"), "utf-8")).version;
const EXPECTED_USER_AGENT = `Bobbit/${PACKAGE_VERSION}`;

const MOCK_MODELS = {
	data: [
		{ id: "openai/gpt-5.2", object: "model", created: 1700000000, owned_by: "system" },
		{ id: "aws/us.anthropic.claude-sonnet-4-6", object: "model", created: 1700000000, owned_by: "system" },
		{ id: "gresearch/qwen3-coder-480b-a35b", object: "model", created: 1700000000, owned_by: "system" },
	],
};

interface RecordedRequest {
	method?: string;
	url?: string;
	headers: http.IncomingHttpHeaders;
	rawHeaders: string[];
}

let mockServer: http.Server;
let mockPort: number;
let recordedRequests: RecordedRequest[] = [];

function resetRecordedRequests(): void {
	recordedRequests = [];
}

function userAgentValues(record: RecordedRequest): string[] {
	const values: string[] = [];
	for (let i = 0; i < record.rawHeaders.length; i += 2) {
		if (record.rawHeaders[i]?.toLowerCase() === "user-agent") {
			values.push(record.rawHeaders[i + 1] || "");
		}
	}
	return values;
}

function expectSingleBobbitUserAgent(record: RecordedRequest | undefined): void {
	expect(record, "mock gateway should have recorded a matching request").toBeTruthy();
	expect(record!.headers["user-agent"]).toBe(EXPECTED_USER_AGENT);
	expect(userAgentValues(record!)).toEqual([EXPECTED_USER_AGENT]);
}

function lastRecordedRequest(path: string): RecordedRequest | undefined {
	return [...recordedRequests].reverse().find((record) => record.url === path);
}

test.beforeAll(async () => {
	mockServer = http.createServer((req, res) => {
		recordedRequests.push({
			method: req.method,
			url: req.url,
			headers: req.headers,
			rawHeaders: [...req.rawHeaders],
		});
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(MOCK_MODELS));
	});
	await new Promise<void>((resolve) => {
		mockServer.listen(0, "127.0.0.1", () => {
			mockPort = (mockServer.address() as any).port;
			resolve();
		});
	});
});

test.afterAll(async () => {
	mockServer?.close();
});

test.afterEach(async () => {
	await apiFetch("/api/aigw/configure", { method: "DELETE" });
	resetRecordedRequests();
});

test.describe("AI Gateway Configure Flow", () => {
	test("test connection discovers models without saving", async () => {
		resetRecordedRequests();
		const res = await apiFetch("/api/aigw/test", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.ok).toBe(true);
		expect(data.models).toHaveLength(3);
		expectSingleBobbitUserAgent(lastRecordedRequest("/v1/models"));

		// Should NOT be configured after test
		const status = await apiFetch("/api/aigw/status");
		const statusData = await status.json();
		expect(statusData.configured).toBe(false);
	});

	test("configure discovers models and persists config", async () => {
		resetRecordedRequests();
		const res = await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.ok).toBe(true);
		expect(data.models).toHaveLength(3);
		expectSingleBobbitUserAgent(lastRecordedRequest("/v1/models"));

		// Verify model IDs — Claude models get prefix stripped (Bedrock API)
		const ids = data.models.map((m: any) => m.id);
		expect(ids).toContain("openai/gpt-5.2");
		expect(ids).toContain("us.anthropic.claude-sonnet-4-6");
		expect(ids).toContain("gresearch/qwen3-coder-480b-a35b");
	});

	test("status returns configured state and models", async () => {
		// Configure first
		await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});
		resetRecordedRequests();

		const res = await apiFetch("/api/aigw/status");
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.configured).toBe(true);
		expect(data.url).toBe(`http://127.0.0.1:${mockPort}`);
		expect(data.models).toHaveLength(3);
		expectSingleBobbitUserAgent(lastRecordedRequest("/v1/models"));
	});

	test("refresh re-discovers models with the Bobbit User-Agent", async () => {
		await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});
		resetRecordedRequests();

		const res = await apiFetch("/api/aigw/refresh", { method: "POST" });
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.models).toHaveLength(3);
		expectSingleBobbitUserAgent(lastRecordedRequest("/v1/models"));
	});

	test("model metadata is inferred correctly", async () => {
		const res = await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});
		const data = await res.json();

		const gpt = data.models.find((m: any) => m.id === "openai/gpt-5.2");
		expect(gpt).toBeTruthy();
		expect(gpt.contextWindow).toBe(400_000);
		expect(gpt.input).toContain("image");

		const claude = data.models.find((m: any) => m.id === "us.anthropic.claude-sonnet-4-6");
		expect(claude).toBeTruthy();
		expect(claude.contextWindow).toBe(1_000_000);
		expect(claude.reasoning).toBe(true);

		const qwen = data.models.find((m: any) => m.id === "gresearch/qwen3-coder-480b-a35b");
		expect(qwen).toBeTruthy();
		expect(qwen.input).toContain("text");
	});

	test("delete removes configuration", async () => {
		// Configure first
		await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});

		// Delete
		const delRes = await apiFetch("/api/aigw/configure", { method: "DELETE" });
		expect(delRes.status).toBe(200);

		// Verify unconfigured
		const status = await apiFetch("/api/aigw/status");
		const data = await status.json();
		expect(data.configured).toBe(false);
	});

	test("proxy route forwards to gateway when configured", async () => {
		// Configure
		await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});
		resetRecordedRequests();

		// Proxy request with a deliberately wrong incoming User-Agent. The server
		// must replace it with Bobbit/<version>, not forward the client header.
		const res = await apiFetch("/api/aigw/v1/models", {
			headers: { "User-Agent": "WrongClient/9.9" },
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.data).toHaveLength(3);
		expectSingleBobbitUserAgent(lastRecordedRequest("/v1/models"));
	});

	test("preferences reflect aigw config", async () => {
		await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});

		const res = await apiFetch("/api/preferences");
		const prefs = await res.json();
		// Post multi-gateway migration: the legacy single `aigw.url` pref is
		// superseded by the `modelGateways` list (the configure shim upserts a
		// `{ name: "aigw", type: "aigw", enabled: true }` entry).
		const gateways = prefs["modelGateways"];
		expect(Array.isArray(gateways)).toBe(true);
		expect(gateways.find((g: { name: string }) => g.name === "aigw")?.url).toBe(
			`http://127.0.0.1:${mockPort}`,
		);
		expect(prefs["aigw.url"]).toBeUndefined();
		// aigw.models is no longer cached in preferences — models are discovered fresh via GET /api/models
	});

	test("/api/models returns aigw Claude IDs with prefix stripped (regression: model picker silently fails)", async () => {
		// Regression test for the bug where picking a Claude model served by the
		// AI Gateway via the prompt model picker appeared to succeed but actually
		// did not switch the agent's bound model: a subsequent prompt went to the
		// previously bound model, and refreshing snapped the UI back.
		//
		// Root cause: configureAigw() strips the provider prefix from Claude IDs
		// when writing models.json (e.g. "aws/us.anthropic.claude-..." becomes
		// "us.anthropic.claude-..."), but GET /api/models (which powers the
		// ModelSelector popover) was returning the raw prefixed IDs. The agent's
		// rpc `set_model` does a strict equality match against models.json, so the
		// lookup failed, the error was swallowed by the WS handler, and the UI
		// optimistically updated to a model the agent never actually switched to.
		//
		// Guarantee: IDs surfaced by /api/models for the `aigw` provider must
		// match the IDs written to models.json — i.e. Claude models must be
		// prefix-stripped and tagged api=bedrock-converse-stream; non-Claude
		// models retain their original form.
		const configureRes = await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});
		const configureData = await configureRes.json();

		const res = await apiFetch("/api/models");
		expect(res.status).toBe(200);
		const models = await res.json();

		const aigwModels = models.filter((m: any) => m.provider === "aigw");
		expect(aigwModels.length).toBe(3);

		// Claude: prefix stripped, routed through Bedrock Converse
		const claude = aigwModels.find((m: any) => m.id.includes("claude"));
		expect(claude).toBeTruthy();
		expect(claude.id).toBe("us.anthropic.claude-sonnet-4-6");
		expect(claude.id).not.toContain("/");
		expect(claude.api).toBe("bedrock-converse-stream");

		// Non-Claude aigw models keep their original ID (including any slash)
		const gpt = aigwModels.find((m: any) => m.id.includes("gpt"));
		expect(gpt).toBeTruthy();
		expect(gpt.id).toBe("openai/gpt-5.2");

		const qwen = aigwModels.find((m: any) => m.id.includes("qwen"));
		expect(qwen).toBeTruthy();
		expect(qwen.id).toBe("gresearch/qwen3-coder-480b-a35b");

		// The critical invariant: every aigw ID surfaced by /api/models must
		// also exist in models.json (reflected by the configure response, which
		// applies the same transform before persisting). Without this, the
		// agent's strict-equality set_model lookup silently rejects the pick.
		const modelsJsonIds = new Set(configureData.models.map((m: any) => m.id));
		for (const m of aigwModels) {
			expect(modelsJsonIds.has(m.id)).toBe(true);
		}
	});

	test("preferences cleaned after delete", async () => {
		await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});
		await apiFetch("/api/aigw/configure", { method: "DELETE" });

		const res = await apiFetch("/api/preferences");
		const prefs = await res.json();
		expect(prefs["aigw.url"]).toBeUndefined();
		// aigw.models is no longer stored in preferences
	});
});
