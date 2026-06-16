/**
 * Unit tests for `startupAigwCheck()` startup refresh of `models.json`.
 *
 * Contract (per design doc "Refresh models.json on startup"):
 *   1. When aigw is configured AND gateway is reachable, models.json is
 *      re-written with the discovered model list and the provider-level
 *      `x-opencode-session` header block.
 *   2. When aigw is configured but the gateway is unreachable, the existing
 *      models.json is left byte-identical and a warning is logged.
 *   3. When aigw is configured AND `BOBBIT_SKIP_AIGW_DISCOVERY` is set,
 *      no HTTP request is made, models.json is untouched, but Bedrock
 *      env vars (AWS_ENDPOINT_URL_BEDROCK_RUNTIME, etc.) ARE set.
 *   4. When aigw is NOT configured, returns false; pre-existing models.json
 *      is untouched by this call.
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const EXPECTED_HEADER_VALUE =
	`!node -e "process.stdout.write(process.env.BOBBIT_SESSION_ID || '')"`;
const EXPECTED_USER_AGENT = `Bobbit/${JSON.parse(readFileSync(path.resolve("package.json"), "utf-8")).version}`;

let tmp: string;
let stateDir: string;
let previousAgentDir: string | undefined;
let previousSkip: string | undefined;
let previousBedrockEndpoint: string | undefined;
let previousNoExternal: string | undefined;

before(() => {
	tmp = mkdtempSync(path.join(tmpdir(), "bobbit-aigw-startup-"));
	stateDir = path.join(tmp, "state");
	mkdirSync(stateDir, { recursive: true });
	previousAgentDir = process.env.BOBBIT_AGENT_DIR;
	previousSkip = process.env.BOBBIT_SKIP_AIGW_DISCOVERY;
	previousBedrockEndpoint = process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
	previousNoExternal = process.env.BOBBIT_TEST_NO_EXTERNAL;
	process.env.BOBBIT_AGENT_DIR = tmp;
});

after(() => {
	if (previousAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
	else process.env.BOBBIT_AGENT_DIR = previousAgentDir;
	if (previousSkip === undefined) delete process.env.BOBBIT_SKIP_AIGW_DISCOVERY;
	else process.env.BOBBIT_SKIP_AIGW_DISCOVERY = previousSkip;
	if (previousBedrockEndpoint === undefined) delete process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
	else process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = previousBedrockEndpoint;
	if (previousNoExternal === undefined) delete process.env.BOBBIT_TEST_NO_EXTERNAL;
	else process.env.BOBBIT_TEST_NO_EXTERNAL = previousNoExternal;
	rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
	const f = path.join(tmp, "models.json");
	if (existsSync(f)) rmSync(f);
	const prefsFile = path.join(stateDir, "preferences.json");
	if (existsSync(prefsFile)) rmSync(prefsFile);
	delete process.env.BOBBIT_SKIP_AIGW_DISCOVERY;
	delete process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
});

const { startupAigwCheck, discoverAigwModels } = await import("../src/server/agent/aigw-manager.js");
const { PreferencesStore } = await import("../src/server/agent/preferences-store.js");

function readModels(): any {
	const f = path.join(tmp, "models.json");
	if (!existsSync(f)) return null;
	return JSON.parse(readFileSync(f, "utf-8"));
}

function startMockGateway(modelIds: string[]): Promise<{ url: string; close: () => Promise<void>; requestCount: () => number }> {
	let count = 0;
	const server = http.createServer((req, res) => {
		count++;
		if (req.url?.endsWith("/v1/models")) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				data: modelIds.map(id => ({ id, object: "model", created: 1700000000, owned_by: "system" })),
			}));
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
				requestCount: () => count,
			});
		});
	});
}

describe("startupAigwCheck — models.json refresh on startup", () => {
	it("aigw configured + reachable mock gateway → models.json rewritten with header + fresh models", async () => {
		const mock = await startMockGateway([
			"openai/gpt-5.2",
			"aws/us.anthropic.claude-sonnet-4-6",
		]);
		try {
			const prefs = new PreferencesStore(stateDir);
			prefs.set("aigw.url", mock.url);

			const result = await startupAigwCheck(prefs as any);
			assert.equal(result, true, "should return true when aigw is configured");

			const data = readModels();
			assert.ok(data?.providers?.aigw, "providers.aigw must exist");
			assert.equal(
				data.providers.aigw.headers["User-Agent"],
				EXPECTED_USER_AGENT,
				"provider-level User-Agent must use the current package version",
			);
			assert.equal(
				data.providers.aigw.headers["x-opencode-session"],
				EXPECTED_HEADER_VALUE,
				"provider-level x-opencode-session header must match documented literal",
			);
			const ids = data.providers.aigw.models.map((m: any) => m.id);
			// Claude prefix is stripped by writeAigwModelsJson
			assert.ok(ids.includes("openai/gpt-5.2"));
			assert.ok(ids.includes("us.anthropic.claude-sonnet-4-6"));

			// Bedrock env vars set as a side-effect.
			assert.ok(
				process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME,
				"AWS_ENDPOINT_URL_BEDROCK_RUNTIME must be set",
			);
		} finally {
			await mock.close();
		}
	});

	it("aigw configured + unreachable gateway → existing models.json left untouched, warning logged", async () => {
		// Pre-write a sentinel models.json. We capture the bytes and verify
		// they're unchanged after the failed startup refresh.
		const sentinel = {
			providers: {
				anthropic: { apiKey: "sk-test", models: [{ id: "claude-x" }] },
				aigw: {
					baseUrl: "http://127.0.0.1:1",
					apiKey: "none",
					api: "openai-completions",
					// Intentionally NO headers block — proves the file was NOT rewritten
					// (a successful refresh would add the x-opencode-session block).
					models: [{ id: "old-cached-model", name: "Old Model" }],
				},
			},
		};
		writeFileSync(path.join(tmp, "models.json"), JSON.stringify(sentinel, null, 2));
		const before = readFileSync(path.join(tmp, "models.json"));

		const prefs = new PreferencesStore(stateDir);
		// Port 1 is reserved (TCPMUX) and reliably refuses connections.
		prefs.set("aigw.url", "http://127.0.0.1:1");

		const warnings: string[] = [];
		const origWarn = console.warn;
		console.warn = (...args: any[]) => { warnings.push(args.join(" ")); };
		try {
			const result = await startupAigwCheck(prefs as any);
			assert.equal(result, true);
		} finally {
			console.warn = origWarn;
		}

		const after = readFileSync(path.join(tmp, "models.json"));
		assert.deepEqual(after, before, "models.json must be byte-identical after unreachable refresh");
		assert.ok(
			warnings.some(w => w.includes("[aigw] gateway unreachable on startup")),
			`expected unreachable-startup warning, got: ${warnings.join(" | ")}`,
		);
	});

	it("BOBBIT_SKIP_AIGW_DISCOVERY=1 → no HTTP request, file untouched, but Bedrock env vars set", async () => {
		// Use a mock gateway and assert no request reaches it under the flag.
		const mock = await startMockGateway(["should-not-be-fetched"]);
		try {
			const sentinel = { providers: { anthropic: { apiKey: "sk-test" } } };
			writeFileSync(path.join(tmp, "models.json"), JSON.stringify(sentinel, null, 2));
			const before = readFileSync(path.join(tmp, "models.json"));

			process.env.BOBBIT_SKIP_AIGW_DISCOVERY = "1";
			const prefs = new PreferencesStore(stateDir);
			prefs.set("aigw.url", mock.url);

			const result = await startupAigwCheck(prefs as any);
			assert.equal(result, true);

			assert.equal(mock.requestCount(), 0, "no HTTP request must be made under skip flag");
			const after = readFileSync(path.join(tmp, "models.json"));
			assert.deepEqual(after, before, "models.json must be untouched under skip flag");
			// Env vars MUST still be set — that's the deliberate semantics shift.
			assert.ok(
				process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME,
				"AWS_ENDPOINT_URL_BEDROCK_RUNTIME must be set even under skip flag",
			);
		} finally {
			await mock.close();
		}
	});

	it("BOBBIT_TEST_NO_EXTERNAL blocks external AIGW discovery but permits local mocks", async () => {
		const mock = await startMockGateway(["openai/local-only"]);
		try {
			process.env.BOBBIT_TEST_NO_EXTERNAL = "1";
			await assert.rejects(
				() => discoverAigwModels("https://api.example.invalid/v1"),
				/External AI Gateway discovery is disabled in tests/,
			);

			const models = await discoverAigwModels(mock.url);
			assert.equal(models.length, 1);
			assert.equal(mock.requestCount(), 1, "local mock gateway should still be reachable under the external-network guard");
		} finally {
			await mock.close();
		}
	});

	it("aigw not configured → returns false, models.json untouched", async () => {
		const sentinel = { providers: { anthropic: { apiKey: "sk-test" } } };
		writeFileSync(path.join(tmp, "models.json"), JSON.stringify(sentinel, null, 2));
		const before = readFileSync(path.join(tmp, "models.json"));

		// Skip the no-internet probe path — it would otherwise try localhost candidates.
		process.env.BOBBIT_SKIP_AIGW_DISCOVERY = "1";

		const prefs = new PreferencesStore(stateDir);
		// No aigw.url set.

		const result = await startupAigwCheck(prefs as any);
		assert.equal(result, false, "should return false when aigw is not configured");

		const after = readFileSync(path.join(tmp, "models.json"));
		assert.deepEqual(after, before, "models.json must be untouched when aigw is not configured");
	});
});
