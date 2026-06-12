/**
 * Unit tests for the type-driven models.json writers + sync orchestrator
 * (docs/design/multi-gateway-providers.md §3). NO NETWORK — discovery is served
 * by a tiny in-process http.Server; models.json is written under a tmp
 * BOBBIT_AGENT_DIR.
 *
 * Covers:
 *   - aigw type, Claude id ⇒ Bedrock block + provider-level headers + env;
 *   - openai-compatible, claude-named id stays OpenAI (no Bedrock, no headers,
 *     no AWS env from this gateway);
 *   - provider key = gateway name (not the literal "aigw");
 *   - multiple gateways ⇒ multiple blocks;
 *   - pruning of disabled/removed gateways, never clobbering anthropic;
 *   - openai-compatible baseUrl normalization (append /v1, no double /v1);
 *   - Bedrock env set then cleared.
 *
 * Also folds in the former tests/aigw-headers.test.ts pins (header literal, no
 * per-model headers, exact JSON-escaped form on disk, no header leak onto
 * non-aigw providers) now that the single-URL writeAigwModelsJson is gone.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const EXPECTED_HEADER_VALUE = `!node -e "process.stdout.write(process.env.BOBBIT_SESSION_ID || '')"`;
const EXPECTED_USER_AGENT = `Bobbit/${JSON.parse(readFileSync(path.resolve("package.json"), "utf-8")).version}`;

const AWS_VARS = [
	"AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
	"AWS_BEDROCK_FORCE_HTTP1",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_REGION",
	"AWS_BEDROCK_SKIP_AUTH",
];

let agentDir: string;
let prevAgentDir: string | undefined;
const prevAws: Record<string, string | undefined> = {};

before(() => {
	agentDir = mkdtempSync(path.join(tmpdir(), "bobbit-mg-writer-agent-"));
	prevAgentDir = process.env.BOBBIT_AGENT_DIR;
	process.env.BOBBIT_AGENT_DIR = agentDir;
	for (const v of AWS_VARS) prevAws[v] = process.env[v];
});

after(() => {
	if (prevAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
	else process.env.BOBBIT_AGENT_DIR = prevAgentDir;
	for (const v of AWS_VARS) {
		if (prevAws[v] === undefined) delete process.env[v];
		else process.env[v] = prevAws[v]!;
	}
	rmSync(agentDir, { recursive: true, force: true });
});

beforeEach(() => {
	const f = path.join(agentDir, "models.json");
	if (existsSync(f)) rmSync(f);
	for (const v of AWS_VARS) delete process.env[v];
});

const { PreferencesStore } = await import("../src/server/agent/preferences-store.ts");
const {
	buildAigwProviderBlock,
	buildOpenAiCompatibleProviderBlock,
	saveGateways,
	syncGatewaysModelsJson,
} = await import("../src/server/agent/aigw-manager.ts");

type AigwModel = Awaited<ReturnType<typeof import("../src/server/agent/aigw-manager.ts").discoverAigwModels>>[number];

function model(id: string, over: Partial<AigwModel> = {}): AigwModel {
	return {
		id,
		name: id,
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 16_384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...over,
	};
}

/** Tiny in-process stub gateway: GET /v1/models → { data: [{id}] }. */
function startStub(ids: string[]): Promise<{ url: string; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => {
		res.setHeader("Content-Type", "application/json");
		if (req.url?.endsWith("/v1/models")) {
			res.end(JSON.stringify({ data: ids.map(id => ({ id, object: "model" })) }));
		} else {
			res.statusCode = 404;
			res.end("{}");
		}
	});
	return new Promise(resolve => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as any).port;
			resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>(r => server.close(() => r())) });
		});
	});
}

function newPrefs() {
	const dir = mkdtempSync(path.join(tmpdir(), "bobbit-mg-writer-state-"));
	return new PreferencesStore(dir) as any;
}

function readModelsJson(): any {
	const f = path.join(agentDir, "models.json");
	return existsSync(f) ? JSON.parse(readFileSync(f, "utf-8")) : null;
}

// ── Pure writers (no network) ──────────────────────────────────────

describe("buildAigwProviderBlock", () => {
	const gw = { id: "1", name: "aigw", url: "http://gw/v1", type: "aigw" as const, enabled: true };

	it("emits provider-level headers, Bedrock-routes Claude ids, keeps non-Claude on openai-completions", () => {
		const block: any = buildAigwProviderBlock(gw, [
			model("aws/us.anthropic.claude-sonnet-4-6", { name: "Claude Sonnet 4.6 (aws)", reasoning: true, input: ["text", "image"] }),
			model("openai/gpt-5.2", { name: "Gpt 5.2 (openai)" }),
		]);

		assert.equal(block.baseUrl, "http://gw/v1");
		assert.equal(block.headers["User-Agent"], EXPECTED_USER_AGENT);
		assert.equal(block.headers["x-opencode-session"], EXPECTED_HEADER_VALUE);

		const claude = block.models.find((m: any) => m.id.includes("claude"));
		assert.equal(claude.id, "us.anthropic.claude-sonnet-4-6", "Claude id must be prefix-stripped");
		assert.equal(claude.api, "bedrock-converse-stream");
		assert.ok(String(claude.baseUrl).endsWith("/aws"), `claude baseUrl must end /aws, got ${claude.baseUrl}`);

		const gpt = block.models.find((m: any) => m.id === "openai/gpt-5.2");
		assert.equal(gpt.api ?? "openai-completions", "openai-completions");
		assert.equal(gpt.baseUrl, undefined, "non-Claude must not get a per-model baseUrl");

		for (const m of block.models) assert.equal(m.headers, undefined, "no per-model headers");
	});
});

describe("buildOpenAiCompatibleProviderBlock", () => {
	it("emits plain openai-completions for EVERY model incl. a claude-named id, with no headers or Bedrock", () => {
		const gw = { id: "2", name: "llama-swap", url: "http://host:9292", type: "openai-compatible" as const, enabled: true };
		const block: any = buildOpenAiCompatibleProviderBlock(gw, [model("qwen-coder-medium"), model("claude-local")]);

		assert.equal(block.headers, undefined, "openai-compatible block must have NO headers");
		assert.equal(block.api, "openai-completions");

		const claude = block.models.find((m: any) => m.id === "claude-local");
		assert.equal(claude.api, "openai-completions", "a claude-named id must stay openai-completions");
		assert.notEqual(claude.api, "bedrock-converse-stream");
		assert.equal(claude.baseUrl, undefined, "no per-model /aws baseUrl override");
	});

	it("normalizes baseUrl: appends /v1 and never doubles it", () => {
		const a: any = buildOpenAiCompatibleProviderBlock({ id: "a", name: "g", url: "http://host:9292", type: "openai-compatible", enabled: true }, []);
		assert.equal(a.baseUrl, "http://host:9292/v1");
		const b: any = buildOpenAiCompatibleProviderBlock({ id: "b", name: "g", url: "http://host:9292/v1/", type: "openai-compatible", enabled: true }, []);
		assert.equal(b.baseUrl, "http://host:9292/v1");
	});
});

// ── Sync orchestrator (in-process stub) ────────────────────────────

describe("syncGatewaysModelsJson", () => {
	it("aigw + Claude id ⇒ Bedrock block + headers + AWS env set; provider key = gateway name", async () => {
		const stub = await startStub(["openai/gpt-5.2", "aws/us.anthropic.claude-sonnet-4-6"]);
		try {
			const prefs = newPrefs();
			saveGateways(prefs, [{ id: "1", name: "aigw", url: stub.url, type: "aigw", enabled: true }]);
			await syncGatewaysModelsJson(prefs);

			const data = readModelsJson();
			assert.ok(data.providers.aigw, "block must live under providers.aigw");
			assert.equal(data.providers.aigw.headers["x-opencode-session"], EXPECTED_HEADER_VALUE);
			assert.equal(data.providers.aigw.headers["User-Agent"], EXPECTED_USER_AGENT);

			const claude = data.providers.aigw.models.find((m: any) => m.id.includes("claude"));
			assert.equal(claude.api, "bedrock-converse-stream");
			assert.ok(String(claude.baseUrl).endsWith("/aws"));

			assert.ok(process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME, "AWS env must be set for an enabled aigw gateway");
		} finally {
			await stub.close();
		}
	});

	it("openai-compatible: claude-named id stays openai-completions; no headers; no AWS env; keyed by gateway name", async () => {
		const stub = await startStub(["qwen-coder-medium", "claude-local"]);
		try {
			const prefs = newPrefs();
			saveGateways(prefs, [{ id: "2", name: "llama-swap", url: stub.url, type: "openai-compatible", enabled: true }]);
			await syncGatewaysModelsJson(prefs);

			const data = readModelsJson();
			assert.ok(data.providers["llama-swap"], "block must live under providers['llama-swap']");
			assert.equal(data.providers.aigw, undefined, "must NOT create a providers.aigw block");
			assert.equal(data.providers["llama-swap"].headers, undefined, "no headers for openai-compatible");

			const claude = data.providers["llama-swap"].models.find((m: any) => m.id === "claude-local");
			assert.equal(claude.api, "openai-completions");
			assert.equal(claude.baseUrl, undefined);

			assert.equal(process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME, undefined, "openai-compatible gateway must not set Bedrock env");
		} finally {
			await stub.close();
		}
	});

	it("multiple enabled gateways ⇒ multiple provider blocks from one sync", async () => {
		const stub = await startStub(["qwen-coder-medium", "aws/us.anthropic.claude-sonnet-4-6"]);
		try {
			const prefs = newPrefs();
			saveGateways(prefs, [
				{ id: "1", name: "aigw", url: stub.url, type: "aigw", enabled: true },
				{ id: "2", name: "llama-swap", url: stub.url, type: "openai-compatible", enabled: true },
			]);
			await syncGatewaysModelsJson(prefs);

			const data = readModelsJson();
			assert.ok(data.providers.aigw, "providers.aigw present");
			assert.ok(data.providers["llama-swap"], "providers['llama-swap'] present");
		} finally {
			await stub.close();
		}
	});

	it("prunes disabled / removed gateways without clobbering unrelated providers", async () => {
		const stub = await startStub(["qwen-coder-medium"]);
		try {
			// Pre-seed an unrelated anthropic provider.
			writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
				providers: { anthropic: { apiKey: "sk-test", models: [{ id: "claude-x" }] } },
			}, null, 2));

			const prefs = newPrefs();
			saveGateways(prefs, [
				{ id: "1", name: "aigw", url: stub.url, type: "aigw", enabled: true },
				{ id: "2", name: "llama-swap", url: stub.url, type: "openai-compatible", enabled: true },
			]);
			await syncGatewaysModelsJson(prefs);
			assert.ok(readModelsJson().providers["llama-swap"], "both gateways present after first sync");

			// Disable llama-swap → its block is pruned, aigw stays.
			saveGateways(prefs, [
				{ id: "1", name: "aigw", url: stub.url, type: "aigw", enabled: true },
				{ id: "2", name: "llama-swap", url: stub.url, type: "openai-compatible", enabled: false },
			]);
			await syncGatewaysModelsJson(prefs);
			let data = readModelsJson();
			assert.equal(data.providers["llama-swap"], undefined, "disabled gateway block pruned");
			assert.ok(data.providers.aigw, "aigw block intact");

			// Remove everything → both gateway blocks gone, anthropic survives.
			saveGateways(prefs, []);
			await syncGatewaysModelsJson(prefs);
			data = readModelsJson();
			assert.equal(data.providers.aigw, undefined, "aigw pruned");
			assert.equal(data.providers["llama-swap"], undefined, "llama-swap pruned");
			assert.ok(data.providers.anthropic, "unrelated anthropic provider untouched");
		} finally {
			await stub.close();
		}
	});

	it("sets Bedrock env for an enabled aigw, then clears the four AWS_* vars when disabled", async () => {
		const stub = await startStub(["aws/us.anthropic.claude-sonnet-4-6"]);
		try {
			const prefs = newPrefs();
			saveGateways(prefs, [{ id: "1", name: "aigw", url: stub.url, type: "aigw", enabled: true }]);
			await syncGatewaysModelsJson(prefs);
			assert.ok(process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME, "env set while aigw enabled");
			assert.equal(process.env.AWS_ACCESS_KEY_ID, "anything");

			saveGateways(prefs, [{ id: "1", name: "aigw", url: stub.url, type: "aigw", enabled: false }]);
			await syncGatewaysModelsJson(prefs);
			assert.equal(process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME, undefined);
			assert.equal(process.env.AWS_BEDROCK_FORCE_HTTP1, undefined);
			assert.equal(process.env.AWS_ACCESS_KEY_ID, undefined);
			assert.equal(process.env.AWS_SECRET_ACCESS_KEY, undefined);
		} finally {
			await stub.close();
		}
	});

	it("writes the exact JSON-escaped x-opencode-session literal and never leaks headers onto non-aigw providers", async () => {
		const stub = await startStub(["openai/gpt-5.2"]);
		try {
			// Pre-seed anthropic with its own headers — must be left untouched.
			writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
				providers: { anthropic: { apiKey: "sk-test", headers: { "X-Existing": "keep-me" } } },
			}, null, 2));

			const prefs = newPrefs();
			saveGateways(prefs, [{ id: "1", name: "aigw", url: stub.url, type: "aigw", enabled: true }]);
			await syncGatewaysModelsJson(prefs);

			const raw = readFileSync(path.join(agentDir, "models.json"), "utf-8");
			assert.ok(
				raw.includes(`"!node -e \\"process.stdout.write(process.env.BOBBIT_SESSION_ID || '')\\""`),
				"file must contain the exact escaped JSON form of the header literal",
			);

			const data = readModelsJson();
			assert.deepEqual(data.providers.anthropic.headers, { "X-Existing": "keep-me" }, "anthropic headers untouched");
			assert.equal(data.providers.anthropic.headers["User-Agent"], undefined, "no User-Agent leak");
			assert.equal(data.providers.anthropic.headers["x-opencode-session"], undefined, "no x-opencode-session leak");
		} finally {
			await stub.close();
		}
	});
});
