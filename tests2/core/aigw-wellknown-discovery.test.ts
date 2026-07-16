// v2-native — NOT a migrated legacy test. Listed in tests-map.json `v2Native`.
// AIGW guarded fallback discovery and bounded one-hop well-known resolution coverage.

import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import http from "node:http";
import {
	configureAigwRuntimeFlags, discoverAigwModels, fetchWellKnownConfig, startDiscoveryServer,
} from "./helpers/aigw-wellknown-test-helpers.js";

describe("discoverAigwModels — fallback option-1 (no well-known probe under guards)", () => {
	function startMock(models: Array<{ id: string }>): Promise<{ url: string; close: () => Promise<void>; paths: () => string[] }> {
		const paths: string[] = [];
		const server = http.createServer((req, res) => {
			paths.push(req.url ?? "");
			if (req.url?.endsWith("/v1/models")) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ data: models.map((m) => ({ ...m, object: "model" })) }));
				return;
			}
			res.writeHead(404);
			res.end();
		});
		return new Promise((resolve) => {
			server.listen(0, "127.0.0.1", () => {
				const port = (server.address() as any).port;
				resolve({
					url: `http://127.0.0.1:${port}`,
					close: () => new Promise<void>((r) => server.close(() => r())),
					paths: () => paths,
				});
			});
		});
	}

	afterEach(() => configureAigwRuntimeFlags({ skipAigwDiscovery: false, testNoExternal: false }));

	it("does not probe /.well-known when skipAigwDiscovery is set, and routes OpenAI reasoning ids to openai-responses while Claude stays non-responses", async () => {
		configureAigwRuntimeFlags({ skipAigwDiscovery: true });
		const mock = await startMock([
			{ id: "openai/gpt-5.2" },
			{ id: "aws/us.anthropic.claude-sonnet-4-6" },
			{ id: "gresearch/qwen3-coder" },
		]);
		try {
			const models = await discoverAigwModels(mock.url);
			assert.ok(!mock.paths().some((p) => p.includes(".well-known")),
				`no well-known probe expected under skip flag, saw: ${mock.paths().join(",")}`);

			const gpt = models.find((m: any) => (m.wireId ?? m.id) === "gpt-5.2");
			assert.ok(gpt, "gpt-5.2 should be present with a bare wire id");
			assert.equal(gpt.api, "openai-responses", "OpenAI reasoning id routes to responses in fallback");
			assert.ok(gpt.baseUrl?.endsWith("/openai/v1"), `baseUrl should be origin/openai/v1, got ${gpt.baseUrl}`);
			assert.equal(gpt.wireId, "gpt-5.2");
			assert.equal(gpt.compat?.supportsReasoningEffort, true, "fallback Responses models must retain reasoning effort");

			// Claude is NOT routed to responses in fallback (remapped to bedrock downstream).
			const claude = models.find((m: any) => m.id.includes("claude"));
			assert.ok(claude);
			assert.notEqual(claude.api, "openai-responses");

			// Non-reasoning model keeps openai-completions.
			const qwen = models.find((m: any) => m.id === "gresearch/qwen3-coder");
			assert.ok(qwen, "expected non-reasoning fallback model");
			assert.equal(qwen.api, "openai-completions");
			assert.equal(qwen.baseUrl, `${mock.url}/v1`, "legacy completions retain the /v1 route from /v1/models");
		} finally {
			await mock.close();
		}
	});

	it("blocks external well-known + models probes under testNoExternal", async () => {
		configureAigwRuntimeFlags({ testNoExternal: true });
		await assert.rejects(
			() => discoverAigwModels("https://api.example.invalid/v1"),
			/External AI Gateway discovery is disabled in tests/,
		);
	});
});

describe("well-known bounded one-hop resolution", () => {
	afterEach(() => {
		configureAigwRuntimeFlags({ skipAigwDiscovery: false, testNoExternal: false, e2e: false });
		delete process.env.AIGW_OPENCODE_TOKEN;
	});

	it("resolves one same-origin remote hop within two requests and filters declared headers", async () => {
		process.env.AIGW_OPENCODE_TOKEN = "inherited-secret";
		const paths: string[] = [];
		const auth: Array<string | undefined> = [];
		const hosts: Array<string | undefined> = [];
		const server = await startDiscoveryServer((req, res, origin) => {
			paths.push(req.url ?? "");
			auth.push(req.headers.authorization);
			hosts.push(req.headers.host);
			res.setHeader("Content-Type", "application/json");
			if (req.url === "/.well-known/opencode") {
				res.end(JSON.stringify({ remote_config: { url: `${origin}/remote`, headers: {
					Authorization: "Bearer declared", Host: "evil.invalid", "Content-Length": "999", "User-Agent": "evil",
				} } }));
			} else {
				res.end(JSON.stringify({ config: { provider: {} } }));
			}
		});
		try {
			const config = await fetchWellKnownConfig(server.origin);
			assert.deepEqual(config?.provider, {});
			assert.deepEqual(paths, ["/.well-known/opencode", "/remote"]);
			assert.equal(auth[0], "Bearer inherited-secret");
			assert.equal(auth[1], "Bearer declared");
			assert.ok(hosts.every((host) => host === new URL(server.origin).host));
		} finally { await server.close(); }
	});

	it("rejects a second remote hop without requesting it", async () => {
		const paths: string[] = [];
		const server = await startDiscoveryServer((req, res, origin) => {
			paths.push(req.url ?? "");
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify(req.url === "/.well-known/opencode"
				? { remote_config: { url: `${origin}/one` } }
				: { remote_config: { url: `${origin}/two` } }));
		});
		try {
			assert.equal(await fetchWellKnownConfig(server.origin), null);
			assert.deepEqual(paths, ["/.well-known/opencode", "/one"]);
		} finally { await server.close(); }
	});

	it("does not follow redirects and rejects cross-origin HTTP remote targets", async () => {
		const redirectPaths: string[] = [];
		const redirecting = await startDiscoveryServer((req, res, origin) => {
			redirectPaths.push(req.url ?? "");
			if (req.url === "/.well-known/opencode") {
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ remote_config: { url: `${origin}/redirect` } }));
			} else {
				res.writeHead(302, { Location: "/config" });
				res.end();
			}
		});
		try {
			assert.equal(await fetchWellKnownConfig(redirecting.origin), null);
			assert.deepEqual(redirectPaths, ["/.well-known/opencode", "/redirect"]);
		} finally { await redirecting.close(); }

		let remoteRequests = 0;
		const remote = await startDiscoveryServer((_req, res) => { remoteRequests++; res.end("{}"); });
		const gateway = await startDiscoveryServer((_req, res) => {
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ remote_config: { url: `${remote.origin}/config` } }));
		});
		try {
			assert.equal(await fetchWellKnownConfig(gateway.origin), null);
			assert.equal(remoteRequests, 0);
		} finally { await gateway.close(); await remote.close(); }
	});

	it("enforces an absolute deadline even when the server keeps streaming bytes", async () => {
		const server = await startDiscoveryServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			const timer = setInterval(() => res.write(" "), 15);
			res.on("close", () => clearInterval(timer));
		});
		try {
			const started = Date.now();
			assert.equal(await fetchWellKnownConfig(server.origin, 100), null);
			assert.ok(Date.now() - started < 1000, "streaming response must not extend the end-to-end deadline");
		} finally { await server.close(); }
	});

	it("treats an empty provider object as authoritative and never calls /v1/models", async () => {
		const paths: string[] = [];
		const server = await startDiscoveryServer((req, res) => {
			paths.push(req.url ?? "");
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ provider: {} }));
		});
		try {
			assert.deepEqual(await discoverAigwModels(server.origin), []);
			assert.deepEqual(paths, ["/.well-known/opencode"]);
		} finally { await server.close(); }
	});
});
