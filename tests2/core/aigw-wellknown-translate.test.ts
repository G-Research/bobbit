// v2-native — NOT a migrated legacy test. Listed in tests-map.json `v2Native`.
// Pure AIGW well-known translation, filtering, collision, pricing, and default-seeding coverage.

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
	GATEWAY, byId, collectAigwProviderDnsHosts, createAigwGuardedLookup, loadFixture,
	normalizeAigwPricing, normalizeWellKnownCost, seedDefaultModelsFromWellKnown,
	translateWellKnown,
} from "./helpers/aigw-wellknown-test-helpers.js";

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

	it("accepts public cross-origin HTTPS DNS providers and guards every connection-time lookup", async () => {
		const models = translateWellKnown({ provider: {
			publicDns: provider("https://api.vendor.example/v1", "public-dns"),
		} }, GATEWAY);
		assert.equal(models.length, 1);
		assert.deepEqual(collectAigwProviderDnsHosts({ baseUrl: GATEWAY, models }), ["api.vendor.example"]);

		let lookupCount = 0;
		const original = ((_hostname: string, _options: any, callback: any) => {
			lookupCount++;
			callback(null, lookupCount === 1
				? [{ address: "93.184.216.34", family: 4 }]
				: [{ address: "169.254.169.254", family: 4 }]);
		}) as any;
		const guarded = createAigwGuardedLookup(new Set(["api.vendor.example"]), original) as any;
		const lookup = () => new Promise<any[]>((resolve, reject) => guarded("api.vendor.example", { all: true }, (error: Error, addresses: any[]) => error ? reject(error) : resolve(addresses)));
		assert.deepEqual(await lookup(), [{ address: "93.184.216.34", family: 4 }]);
		await assert.rejects(lookup, /non-public address/);
		assert.equal(lookupCount, 2, "DNS must be revalidated for each actual connection lookup");
	});

	it("keeps legacy per-token and well-known per-million costs one million-fold apart", () => {
		const legacy = normalizeAigwPricing({ prompt: 2, completion: 3 });
		const wellKnown = normalizeWellKnownCost({ input: 2, output: 3 });
		assert.equal(legacy.input, wellKnown.input * 1_000_000);
		assert.equal(legacy.output, wellKnown.output * 1_000_000);
	});
});
