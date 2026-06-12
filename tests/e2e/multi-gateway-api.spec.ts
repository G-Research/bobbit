/**
 * API E2E tests for the multi-gateway provider surface (Slice C).
 *
 * Exercises the §6 REST contract against TWO in-process stub gateways (NO
 * NETWORK — never the LAN host, never tools/dummy-aigw):
 *
 *   - PUT /api/aigw/gateways with one enabled `openai-compatible` gateway and a
 *     DISABLED `aigw` gateway → merged mode: /api/models surfaces provider
 *     "llama-swap" + built-ins, no "aigw"; models.json has the
 *     openai-compatible block (plain openai-completions, no headers) and NO
 *     aigw block (disabled ⇒ pruned).
 *   - Enable the `aigw` gateway → exclusive mode: /api/models surfaces ONLY
 *     "aigw" (built-ins + openai-compatible suppressed); on disk BOTH blocks
 *     exist — the aigw block carries the x-opencode-session header literal and
 *     Bedrock-routes the claude id, while the openai-compatible block's
 *     `claude-local` stays openai-completions (the latent-bug fix).
 *   - PUT [] → both gateway blocks pruned, a pre-seeded `anthropic` block
 *     untouched, /api/models shows built-ins only.
 *   - POST /api/aigw/test → ok + 502 on unreachable.
 *   - Legacy POST/DELETE /api/aigw/configure shims still work.
 *
 * "Binding resolves" is asserted at the models.json layer (provider block +
 * correct `api` per type) since `set_model` is agent-subprocess-side and not
 * reachable from the in-process REST harness — same de-scope rationale as
 * tests/e2e/aigw-session-header.spec.ts.
 */

import { test, expect } from "./in-process-harness.js";
import http from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiFetch } from "./e2e-setup.js";

// Tests share the worker-scoped gateway + a single on-disk models.json, so they
// must run serially and reset gateway state between each.
test.describe.configure({ mode: "serial" });

const EXPECTED_HEADER_VALUE =
	`!node -e "process.stdout.write(process.env.BOBBIT_SESSION_ID || '')"`;

interface StubGateway {
	url: string;
	close: () => Promise<void>;
}

/** A tiny OpenAI-compatible stub: GET /v1/models + POST /v1/chat/completions. */
function startStub(modelIds: string[]): Promise<StubGateway> {
	const server = http.createServer((req, res) => {
		res.setHeader("Content-Type", "application/json");
		if (req.url?.endsWith("/v1/models")) {
			res.end(JSON.stringify({
				data: modelIds.map((id) => ({ id, object: "model", created: 1700000000, owned_by: "system" })),
			}));
			return;
		}
		if (req.url?.endsWith("/v1/chat/completions")) {
			res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
			return;
		}
		res.writeHead(404);
		res.end(JSON.stringify({ error: "not found" }));
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as any).port;
			resolve({
				url: `http://127.0.0.1:${port}`,
				close: () => new Promise<void>((r) => server.close(() => r())),
			});
		});
	});
}

function modelsJsonPath(bobbitDir: string): string {
	return join(bobbitDir, "agent", "models.json");
}

function readModelsJson(bobbitDir: string): any {
	const p = modelsJsonPath(bobbitDir);
	if (!existsSync(p)) return { providers: {} };
	return JSON.parse(readFileSync(p, "utf-8"));
}

async function putGateways(gateways: Array<Record<string, unknown>>): Promise<Response> {
	return apiFetch("/api/aigw/gateways", {
		method: "PUT",
		body: JSON.stringify({ gateways }),
	});
}

async function getModels(): Promise<any[]> {
	const res = await apiFetch("/api/models");
	expect(res.status).toBe(200);
	return res.json();
}

// Stub gateways — stubA mimics a local llama-swap; stubB an enterprise aigw.
let stubA: StubGateway; // openai-compatible (llama-swap)
let stubB: StubGateway; // aigw

test.beforeAll(async () => {
	stubA = await startStub(["qwen-coder-medium", "claude-local"]);
	stubB = await startStub(["openai/gpt-5.2", "aws/us.anthropic.claude-sonnet-4-6"]);
});

test.afterAll(async () => {
	await stubA?.close();
	await stubB?.close();
});

test.afterEach(async ({ gateway }) => {
	// Reset gateway list (prunes managed gateway blocks) so tests don't leak.
	await putGateways([]);
	// Strip any sentinel `anthropic` block a test seeded into models.json.
	try {
		const p = modelsJsonPath(gateway.bobbitDir);
		if (existsSync(p)) {
			const data = JSON.parse(readFileSync(p, "utf-8"));
			if (data?.providers?.anthropic?.apiKey === "sk-ant-e2e-sentinel") {
				delete data.providers.anthropic;
				writeFileSync(p, JSON.stringify(data, null, 2));
			}
		}
	} catch { /* best-effort cleanup */ }
});

test.describe("Multi-gateway provider API", () => {
	test("GET /api/aigw/gateways is empty by default", async () => {
		const res = await apiFetch("/api/aigw/gateways");
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(Array.isArray(data.gateways)).toBe(true);
		expect(data.gateways).toHaveLength(0);
	});

	test("merged mode: enabled openai-compatible + disabled aigw", async ({ gateway }) => {
		const res = await putGateways([
			{ name: "llama-swap", type: "openai-compatible", url: stubA.url, enabled: true },
			{ name: "aigw", type: "aigw", url: stubB.url, enabled: false },
		]);
		expect(res.status).toBe(200);
		const body = await res.json();
		// Canonical list round-trips (incl. the disabled row), with ids filled in.
		expect(body.gateways).toHaveLength(2);
		const llamaRow = body.gateways.find((g: any) => g.name === "llama-swap");
		expect(llamaRow).toBeTruthy();
		expect(typeof llamaRow.id).toBe("string");
		expect(llamaRow.id.length).toBeGreaterThan(0);
		expect(body.gateways.find((g: any) => g.name === "aigw").enabled).toBe(false);
		// Discovered models reported for the enabled gateway only.
		expect(body.modelsByGateway["llama-swap"]).toHaveLength(2);

		// /api/models — merged: llama-swap present, built-ins present, no aigw.
		const models = await getModels();
		const providers = new Set(models.map((m) => m.provider));
		expect(providers.has("llama-swap")).toBe(true);
		expect(providers.has("aigw")).toBe(false);
		// At least one built-in provider survives in merged mode.
		expect(models.some((m) => m.provider !== "llama-swap" && m.provider !== "aigw")).toBe(true);

		// On disk: openai-compatible block, NO aigw block (disabled ⇒ pruned).
		const data = readModelsJson(gateway.bobbitDir);
		const llama = data.providers["llama-swap"];
		expect(llama, "llama-swap provider block must exist").toBeTruthy();
		expect(llama.api).toBe("openai-completions");
		expect(llama.baseUrl).toBe(`${stubA.url}/v1`);
		expect(llama.headers, "openai-compatible block must carry NO headers").toBeUndefined();
		expect(data.providers.aigw, "disabled aigw must not be written").toBeUndefined();
		// claude-local on an openai-compatible gateway stays plain OpenAI.
		const claudeLocal = llama.models.find((m: any) => m.id === "claude-local");
		expect(claudeLocal).toBeTruthy();
		expect(claudeLocal.api).toBe("openai-completions");
		expect(claudeLocal.baseUrl, "no per-model Bedrock baseUrl override").toBeUndefined();
	});

	test("exclusive mode: enabling aigw suppresses built-ins + openai-compatible", async ({ gateway }) => {
		const res = await putGateways([
			{ name: "llama-swap", type: "openai-compatible", url: stubA.url, enabled: true },
			{ name: "aigw", type: "aigw", url: stubB.url, enabled: true },
		]);
		expect(res.status).toBe(200);

		// /api/models — exclusive: ONLY provider "aigw"; built-ins + llama-swap gone.
		const models = await getModels();
		const providers = new Set(models.map((m) => m.provider));
		expect(providers.has("aigw")).toBe(true);
		expect(providers.has("llama-swap"), "openai-compatible suppressed in exclusive mode").toBe(false);
		expect([...providers], "only the aigw provider contributes in exclusive mode").toEqual(["aigw"]);

		// On disk: BOTH blocks exist (the agent could bind either) ...
		const data = readModelsJson(gateway.bobbitDir);
		const aigw = data.providers.aigw;
		expect(aigw, "aigw provider block must exist").toBeTruthy();
		expect(aigw.headers["x-opencode-session"]).toBe(EXPECTED_HEADER_VALUE);
		// ... aigw Bedrock-routes the claude id (prefix stripped) ...
		const aigwClaude = aigw.models.find((m: any) => m.id.includes("claude"));
		expect(aigwClaude).toBeTruthy();
		expect(aigwClaude.id).toBe("us.anthropic.claude-sonnet-4-6");
		expect(aigwClaude.api).toBe("bedrock-converse-stream");

		// ... while the openai-compatible block's claude-local stays OpenAI.
		const llama = data.providers["llama-swap"];
		expect(llama, "llama-swap block must still exist on disk in exclusive mode").toBeTruthy();
		expect(llama.headers).toBeUndefined();
		const claudeLocal = llama.models.find((m: any) => m.id === "claude-local");
		expect(claudeLocal.api).toBe("openai-completions");
		expect(claudeLocal.baseUrl).toBeUndefined();
	});

	test("disabled aigw is NOT exclusive (merged with built-ins)", async () => {
		const res = await putGateways([
			{ name: "aigw", type: "aigw", url: stubB.url, enabled: false },
		]);
		expect(res.status).toBe(200);

		const models = await getModels();
		const providers = new Set(models.map((m) => m.provider));
		expect(providers.has("aigw"), "disabled aigw contributes nothing").toBe(false);
		// Built-ins are present (disabled aigw ⇒ not exclusive ⇒ merged mode).
		expect(models.some((m) => m.provider !== "aigw"), "built-ins present").toBe(true);
	});

	test("PUT [] prunes gateway blocks but leaves unrelated providers untouched", async ({ gateway }) => {
		// Seed two gateway blocks first.
		const seed = await putGateways([
			{ name: "llama-swap", type: "openai-compatible", url: stubA.url, enabled: true },
			{ name: "aigw", type: "aigw", url: stubB.url, enabled: true },
		]);
		expect(seed.status).toBe(200);

		// Inject a sentinel `anthropic` provider block directly on disk to prove
		// the sync never clobbers providers it does not manage.
		const p = modelsJsonPath(gateway.bobbitDir);
		const before = readModelsJson(gateway.bobbitDir);
		const sentinelAnthropic = { apiKey: "sk-ant-e2e-sentinel", models: [{ id: "claude-x" }] };
		before.providers.anthropic = sentinelAnthropic;
		writeFileSync(p, JSON.stringify(before, null, 2));

		// Clear the gateway list.
		const clear = await putGateways([]);
		expect(clear.status).toBe(200);

		const after = readModelsJson(gateway.bobbitDir);
		expect(after.providers["llama-swap"], "openai-compatible block pruned").toBeUndefined();
		expect(after.providers.aigw, "aigw block pruned").toBeUndefined();
		expect(after.providers.anthropic, "unrelated anthropic block untouched").toEqual(sentinelAnthropic);

		// /api/models — built-ins only, no gateway providers.
		const models = await getModels();
		const providers = new Set(models.map((m) => m.provider));
		expect(providers.has("llama-swap")).toBe(false);
		expect(providers.has("aigw")).toBe(false);
	});

	test("POST /api/aigw/test discovers a URL (ok) and 502s on unreachable", async () => {
		const ok = await apiFetch("/api/aigw/test", {
			method: "POST",
			body: JSON.stringify({ url: stubA.url }),
		});
		expect(ok.status).toBe(200);
		const okData = await ok.json();
		expect(okData.ok).toBe(true);
		expect(okData.models).toHaveLength(2);

		const bad = await apiFetch("/api/aigw/test", {
			method: "POST",
			body: JSON.stringify({ url: "http://127.0.0.1:19999" }),
		});
		expect(bad.status).toBe(502);

		const missing = await apiFetch("/api/aigw/test", {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(missing.status).toBe(400);
	});

	test("PUT rejects an invalid gateway list (400)", async () => {
		// An aigw-type gateway must be named exactly "aigw" (§1 singleton constraint).
		const res = await putGateways([
			{ name: "enterprise", type: "aigw", url: stubB.url, enabled: true },
		]);
		expect(res.status).toBe(400);
		const data = await res.json();
		expect(data.error).toBeTruthy();
	});

	test("per-gateway refresh + status by name", async ({ gateway }) => {
		await putGateways([
			{ name: "llama-swap", type: "openai-compatible", url: stubA.url, enabled: true },
		]);

		const refresh = await apiFetch("/api/aigw/gateways/llama-swap/refresh", { method: "POST" });
		expect(refresh.status).toBe(200);
		expect((await refresh.json()).models).toHaveLength(2);

		const status = await apiFetch("/api/aigw/gateways/llama-swap/status");
		expect(status.status).toBe(200);
		const sData = await status.json();
		expect(sData.configured).toBe(true);
		expect(sData.name).toBe("llama-swap");
		expect(sData.type).toBe("openai-compatible");
		expect(sData.enabled).toBe(true);
		expect(sData.models).toHaveLength(2);

		// Unknown gateway → 404 refresh / { configured:false } status.
		const unknownRefresh = await apiFetch("/api/aigw/gateways/nope/refresh", { method: "POST" });
		expect(unknownRefresh.status).toBe(404);
		const unknownStatus = await apiFetch("/api/aigw/gateways/nope/status");
		expect(unknownStatus.status).toBe(200);
		expect((await unknownStatus.json()).configured).toBe(false);

		// Sanity: the block landed on disk.
		const data = readModelsJson(gateway.bobbitDir);
		expect(data.providers["llama-swap"]).toBeTruthy();
	});

	test("legacy configure/status/DELETE shims still work", async ({ gateway }) => {
		// configure upserts a singleton `aigw` gateway and returns transformed models.
		const conf = await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: stubB.url }),
		});
		expect(conf.status).toBe(200);
		const confData = await conf.json();
		expect(confData.ok).toBe(true);
		const ids = confData.models.map((m: any) => m.id);
		expect(ids).toContain("openai/gpt-5.2");
		expect(ids).toContain("us.anthropic.claude-sonnet-4-6"); // claude prefix stripped

		// status reflects the configured aigw gateway.
		const status = await apiFetch("/api/aigw/status");
		expect(status.status).toBe(200);
		const statusData = await status.json();
		expect(statusData.configured).toBe(true);
		expect(statusData.url).toBe(stubB.url);

		// The aigw gateway is also visible in the canonical list.
		const list = await (await apiFetch("/api/aigw/gateways")).json();
		expect(list.gateways.find((g: any) => g.name === "aigw")).toBeTruthy();

		// DELETE removes the aigw gateway + prunes its block.
		const del = await apiFetch("/api/aigw/configure", { method: "DELETE" });
		expect(del.status).toBe(200);
		expect((await del.json()).ok).toBe(true);

		const afterStatus = await (await apiFetch("/api/aigw/status")).json();
		expect(afterStatus.configured).toBe(false);
		const data = readModelsJson(gateway.bobbitDir);
		expect(data.providers.aigw).toBeUndefined();
	});

	test("DELETE /api/aigw/configure succeeds even when nothing is configured", async () => {
		const del = await apiFetch("/api/aigw/configure", { method: "DELETE" });
		expect(del.status).toBe(200);
		expect((await del.json()).ok).toBe(true);
	});
});
