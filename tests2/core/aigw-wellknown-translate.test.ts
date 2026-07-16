// v2-native — NOT a migrated legacy test. Listed in tests-map.json `v2Native`.
//
// Unit coverage for well-known-driven AIGW discovery & translation
// (src/server/agent/aigw-manager.ts). Verifies the pure translator against a
// captured `.well-known/opencode` fixture, the writeAigwModelsJson emission of
// authoritative per-model api/baseUrl, the fallback option-1 OpenAI-responses
// routing (with NO well-known probe under skip/no-external guards), and
// default-model seeding.

import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(HERE, "fixtures", "wellknown-opencode.json");

const {
	translateWellKnown,
	writeAigwModelsJson,
	discoverAigwModels,
	configureAigw,
	seedDefaultModelsFromWellKnown,
	configureAigwRuntimeFlags,
	normalizeAigwModelString,
	fetchWellKnownConfig,
	normalizeAigwPricing,
	normalizeWellKnownCost,
} = await import("../../src/server/agent/aigw-manager.ts");
const { resetAgentDirStateForTests } = await import("../../src/server/bobbit-dir.js");

function loadFixture(): any {
	return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8"));
}

const GATEWAY = "http://aigw-local.t3.zone";

function byId(models: any[], id: string): any {
	return models.find((m) => (m.wireId ?? m.id) === id || m.id === id);
}

describe("translateWellKnown — provider → pi-ai api mapping", () => {
	it("routes @ai-sdk/openai to openai-responses on its own /openai/v1 baseURL with bare ids", () => {
		const models = translateWellKnown(loadFixture(), GATEWAY);
		const sol = byId(models, "gpt-5.6-sol");
		assert.ok(sol, "expected whitelisted gpt-5.6-sol");
		assert.equal(sol.api, "openai-responses", "@ai-sdk/openai must map to openai-responses");
		assert.equal(sol.upstreamProvider, "openai");
		assert.equal(sol.baseUrl, "http://aigw-local.t3.zone/openai/v1", "baseUrl = provider options.baseURL verbatim");
		assert.equal(sol.wireId, "gpt-5.6-sol", "subpath wire id must be bare (no provider prefix)");
		assert.equal(sol.id, "gpt-5.6-sol");
	});

	it("derives thinkingLevelMap from variants including xhigh/max plus off:none", () => {
		const models = translateWellKnown(loadFixture(), GATEWAY);
		const sol = byId(models, "gpt-5.6-sol");
		assert.deepEqual(sol.thinkingLevelMap, {
			none: "none", low: "low", high: "high", xhigh: "xhigh", max: "max", off: "none",
		});
		const luna = byId(models, "gpt-5.6-luna");
		assert.deepEqual(luna.thinkingLevelMap, { low: "low", high: "high", xhigh: "xhigh", off: "none" });
	});

	it("sets compat.supportsReasoningEffort=true only for openai-style endpoints", () => {
		const models = translateWellKnown(loadFixture(), GATEWAY);
		assert.equal(byId(models, "gpt-5.6-sol").compat?.supportsReasoningEffort, true, "openai-responses");
		assert.equal(byId(models, "qwen3-coder-480b-a35b").compat?.supportsReasoningEffort, true, "openai-completions");
		const claude = byId(models, "us.anthropic.claude-opus-4-6");
		assert.equal(claude.compat, undefined, "bedrock leaves compat undefined");
	});

	it("maps @ai-sdk/amazon-bedrock to bedrock-converse-stream on /aws", () => {
		const models = translateWellKnown(loadFixture(), GATEWAY);
		const claude = byId(models, "us.anthropic.claude-opus-4-6");
		assert.ok(claude);
		assert.equal(claude.api, "bedrock-converse-stream");
		assert.equal(claude.baseUrl, "http://aigw-local.t3.zone/aws");
	});

	it("maps a second @ai-sdk/openai provider (aws-mantle) to openai-responses on /aws/openai/v1", () => {
		const models = translateWellKnown(loadFixture(), GATEWAY);
		const oss = byId(models, "gpt-oss-120b");
		assert.ok(oss);
		assert.equal(oss.api, "openai-responses");
		assert.equal(oss.upstreamProvider, "aws-mantle");
		assert.equal(oss.baseUrl, "http://aigw-local.t3.zone/aws/openai/v1");
	});

	it("maps @ai-sdk/openai-compatible (gresearch) to openai-completions on /gresearch/v1", () => {
		const models = translateWellKnown(loadFixture(), GATEWAY);
		const qwen = byId(models, "qwen3-coder-480b-a35b");
		assert.ok(qwen);
		assert.equal(qwen.api, "openai-completions");
		assert.equal(qwen.baseUrl, "http://aigw-local.t3.zone/gresearch/v1");
	});
});

describe("translateWellKnown — filters and metadata", () => {
	it("drops disabled_providers entirely and honours per-provider whitelist", () => {
		const models = translateWellKnown(loadFixture(), GATEWAY);
		// legacy-openai is in disabled_providers → no models from it.
		assert.equal(byId(models, "gpt-4-legacy"), undefined, "disabled provider must be filtered out");
		// openai whitelist = [sol, luna] → terra excluded.
		assert.ok(byId(models, "gpt-5.6-sol"));
		assert.ok(byId(models, "gpt-5.6-luna"));
		assert.equal(byId(models, "gpt-5.6-terra"), undefined, "non-whitelisted model must be filtered out");
	});

	it("maps limit/reasoning/modalities/cost correctly", () => {
		const models = translateWellKnown(loadFixture(), GATEWAY);
		const sol = byId(models, "gpt-5.6-sol");
		assert.equal(sol.contextWindow, 272000, "limit.context → contextWindow");
		assert.equal(sol.maxTokens, 128000, "limit.output → maxTokens");
		assert.equal(sol.reasoning, true);
		assert.deepEqual(sol.input, ["text", "image"], "modalities.input → input");
		assert.deepEqual(sol.cost, { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.5625 },
			"well-known cost is per-1M and maps straight across (incl cache_read/cache_write)");

		const luna = byId(models, "gpt-5.6-luna");
		// cost without cache_* → heuristic cache ratios applied off input.
		assert.deepEqual(luna.cost, { input: 0.5, output: 4, cacheRead: 0.05, cacheWrite: 0.625 });
		assert.deepEqual(luna.input, ["text"]);
	});
});

describe("writeAigwModelsJson — authoritative per-model api/baseUrl", () => {
	let tmpAgentDir: string;
	let prevAgentDir: string | undefined;

	beforeEach(() => {
		prevAgentDir = process.env.BOBBIT_AGENT_DIR;
		tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-wk-models-"));
		process.env.BOBBIT_AGENT_DIR = tmpAgentDir;
		resetAgentDirStateForTests();
	});
	afterEach(() => {
		if (prevAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
		else process.env.BOBBIT_AGENT_DIR = prevAgentDir;
		resetAgentDirStateForTests();
		fs.rmSync(tmpAgentDir, { recursive: true, force: true });
	});

	it("emits per-model api/baseUrl for well-known models and never sends reasoning_effort+tools on a forbidden completions model", () => {
		const models = translateWellKnown(loadFixture(), GATEWAY);
		writeAigwModelsJson(`${GATEWAY}/v1`, models);
		const data = JSON.parse(fs.readFileSync(path.join(tmpAgentDir, "models.json"), "utf-8"));
		const entries: any[] = data.providers.aigw.models;

		const sol = entries.find((m) => m.id === "gpt-5.6-sol");
		assert.ok(sol, "expected gpt-5.6-sol entry with bare id");
		assert.equal(sol.api, "openai-responses");
		assert.equal(sol.upstreamProvider, "openai");
		assert.equal(sol.baseUrl, "http://aigw-local.t3.zone/openai/v1");

		const claude = entries.find((m) => m.id === "us.anthropic.claude-opus-4-6");
		assert.equal(claude.api, "bedrock-converse-stream");
		assert.equal(claude.baseUrl, "http://aigw-local.t3.zone/aws");

		const qwen = entries.find((m) => m.id === "qwen3-coder-480b-a35b");
		assert.equal(qwen.api, "openai-completions");
		assert.equal(qwen.baseUrl, "http://aigw-local.t3.zone/gresearch/v1");

		// The forbidden combo (reasoning_effort + tools on plain chat/completions)
		// cannot occur: every gpt-5.6 model routes to openai-responses, never
		// openai-completions.
		const forbidden = entries.filter((m) => m.id.startsWith("gpt-5.6") && m.api === "openai-completions");
		assert.deepEqual(forbidden, [], "gpt-5.6 models must never be routed to openai-completions");
	});

	it("normalizes legacy AIGW provider-prefixed ids when the bare well-known id exists", () => {
		const models = translateWellKnown(loadFixture(), GATEWAY);
		writeAigwModelsJson(`${GATEWAY}/v1`, models);

		assert.equal(normalizeAigwModelString("aigw/openai/gpt-5.6-sol"), "aigw/gpt-5.6-sol");
		assert.equal(normalizeAigwModelString("aigw/aws-mantle/gpt-oss-120b"), "aigw/gpt-oss-120b");
		assert.equal(normalizeAigwModelString("aigw/unknown/gpt-5.6-sol"), "aigw/gpt-5.6-sol");
		assert.equal(normalizeAigwModelString("aigw/gresearch/not-present"), "aigw/gresearch/not-present");
		assert.equal(normalizeAigwModelString("aigw/unknown/multi/segment"), "aigw/unknown/multi/segment");
	});

	it("does not persist configuration when the atomic models.json write fails", async () => {
		const badAgentDir = path.join(tmpAgentDir, "not-a-directory");
		fs.writeFileSync(badAgentDir, "file");
		process.env.BOBBIT_AGENT_DIR = badAgentDir;
		resetAgentDirStateForTests();
		const prefs = new Map<string, unknown>();
		const server = await startDiscoveryServer((_req, res) => {
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ provider: {} }));
		});
		try {
			await assert.rejects(() => configureAigw(server.origin, {
				get: (key: string) => prefs.get(key),
				set: (key: string, value: unknown) => { prefs.set(key, value); },
				remove: (key: string) => { prefs.delete(key); },
			} as any));
			assert.equal(prefs.has("aigw.url"), false);
		} finally {
			await server.close();
			process.env.BOBBIT_AGENT_DIR = tmpAgentDir;
			resetAgentDirStateForTests();
		}
	});
});

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

			// Claude is NOT routed to responses in fallback (remapped to bedrock downstream).
			const claude = models.find((m: any) => m.id.includes("claude"));
			assert.ok(claude);
			assert.notEqual(claude.api, "openai-responses");

			// Non-reasoning model keeps openai-completions.
			const qwen = models.find((m: any) => m.id === "gresearch/qwen3-coder");
			assert.ok(qwen, "expected non-reasoning fallback model");
			assert.equal(qwen.api, "openai-completions");
			assert.ok(!qwen.baseUrl, "non-reasoning fallback model has no per-model baseUrl override");
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

describe("seedDefaultModelsFromWellKnown", () => {
	function fakePrefs(initial: Record<string, unknown> = {}) {
		const store = { ...initial };
		return {
			store,
			get: (k: string) => store[k],
			set: (k: string, v: unknown) => { store[k] = v; },
		};
	}

	it("seeds session/review/naming prefs from config.model only when unset", () => {
		const models = translateWellKnown(loadFixture(), GATEWAY);
		const prefs = fakePrefs({ "default.sessionModel": "anthropic/claude-user-choice" });
		seedDefaultModelsFromWellKnown(loadFixture(), models, prefs as any);
		// session already set → preserved; review/naming seeded to aigw/<stripped>.
		assert.equal(prefs.store["default.sessionModel"], "anthropic/claude-user-choice");
		assert.equal(prefs.store["default.reviewModel"], "aigw/us.anthropic.claude-opus-4-6");
		assert.equal(prefs.store["default.namingModel"], "aigw/us.anthropic.claude-opus-4-6");
	});

	it("no-op when config.model has no matching discovered model", () => {
		const models = translateWellKnown(loadFixture(), GATEWAY);
		const prefs = fakePrefs();
		seedDefaultModelsFromWellKnown({ model: "aws:no.such.model", provider: {} } as any, models, prefs as any);
		assert.equal(prefs.store["default.sessionModel"], undefined);
	});
});

describe("well-known collision, validation, and pricing invariants", () => {
	const provider = (baseURL: string, name: string) => ({
		npm: "@ai-sdk/openai",
		options: { baseURL },
		models: { shared: { name } },
	});

	it("emits one bare ID and prefers config.model provider, otherwise insertion order", () => {
		const preferred = translateWellKnown({
			model: "second:shared",
			provider: {
				first: provider(`${GATEWAY}/first/v1`, "First"),
				second: provider(`${GATEWAY}/second/v1`, "Second"),
			},
		}, GATEWAY);
		assert.equal(preferred.length, 1);
		assert.equal(preferred[0].upstreamProvider, "second");
		assert.equal(preferred[0].id, "shared");

		const stable = translateWellKnown({
			provider: {
				second: provider(`${GATEWAY}/second/v1`, "Second"),
				first: provider(`${GATEWAY}/first/v1`, "First"),
			},
		}, GATEWAY);
		assert.equal(stable.length, 1);
		assert.equal(stable[0].upstreamProvider, "second");
	});

	it("excludes providers with missing, cross-origin HTTP, private HTTPS, or credentialed bases", () => {
		const models = translateWellKnown({ provider: {
			missing: { models: { missing: {} } },
			crossHttp: provider("http://example.com/v1", "cross-http"),
			privateHttps: provider("https://169.254.169.254/v1", "metadata"),
			credentialed: provider("https://user:pass@example.com/v1", "credentialed"),
			valid: provider(`${GATEWAY}/valid/v1`, "valid"),
		} }, GATEWAY);
		assert.deepEqual(models.map((model: any) => model.id), ["shared"]);
		assert.equal(models[0].upstreamProvider, "valid");
		const publicLiteral = translateWellKnown({ provider: {
			publicIp: provider("https://8.8.8.8/v1", "public-ip"),
		} }, GATEWAY);
		assert.equal(publicLiteral.length, 1);
		assert.equal(publicLiteral[0].upstreamProvider, "publicIp");
	});

	it("keeps legacy per-token and well-known per-million costs one million-fold apart", () => {
		const legacy = normalizeAigwPricing({ prompt: 2, completion: 3 });
		const wellKnown = normalizeWellKnownCost({ input: 2, output: 3 });
		assert.equal(legacy.input, wellKnown.input * 1_000_000);
		assert.equal(legacy.output, wellKnown.output * 1_000_000);
	});
});

function startDiscoveryServer(
	handler: (req: http.IncomingMessage, res: http.ServerResponse, origin: string) => void,
): Promise<{ origin: string; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => handler(req, res, `http://127.0.0.1:${(server.address() as any).port}`));
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
		origin: `http://127.0.0.1:${(server.address() as any).port}`,
		close: () => new Promise<void>((done) => server.close(() => done())),
	})));
}

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
