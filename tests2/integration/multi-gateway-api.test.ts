import http from "node:http";
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch } from "./_e2e/e2e-setup.js";
import { startupAigwCheck } from "../../src/server/agent/aigw-manager.js";

const integrationKeyEnv = "BOBBIT_MULTI_GATEWAY_TEST_KEY";

interface Stub {
	url: string;
	requests: Array<{ path: string; authorization?: string }>;
	close(): Promise<void>;
}

async function startStub(models: string[], requiredKey?: string): Promise<Stub> {
	const requests: Stub["requests"] = [];
	const server = http.createServer((req, res) => {
		requests.push({ path: req.url || "", authorization: req.headers.authorization });
		res.setHeader("Content-Type", "application/json");
		if (requiredKey && req.headers.authorization !== `Bearer ${requiredKey}`) {
			res.writeHead(401);
			res.end(JSON.stringify({ error: "unauthorized" }));
			return;
		}
		if (req.url === "/v1/models") {
			res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
			return;
		}
		if (req.url === "/v1/chat/completions") {
			res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
			return;
		}
		res.writeHead(404);
		res.end(JSON.stringify({ error: "not found" }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

async function putGateways(gateways: unknown[]): Promise<Response> {
	return apiFetch("/api/aigw/gateways", { method: "PUT", body: JSON.stringify({ gateways }) });
}

test.describe.configure({ mode: "serial" });

test.describe("multi-gateway REST API", () => {
	let secured: Stub;
	let empty: Stub;

	test.beforeAll(async () => {
		process.env[integrationKeyEnv] = "integration-secret";
		secured = await startStub(["claude-local", "qwen-local"], "integration-secret");
		empty = await startStub([]);
	});

	test.afterAll(async () => {
		await secured.close();
		await empty.close();
		delete process.env[integrationKeyEnv];
	});

	test.afterEach(async () => {
		await putGateways([]);
	});

	test("saves secret-free named rows, authenticates discovery/test/proxy, and preserves or clears stable keys", async () => {
		const save = await putGateways([{
			name: "local-openai",
			url: secured.url,
			type: "openai-compatible",
			enabled: true,
			apiKey: "integration-secret",
		}]);
		expect(save.status).toBe(200);
		const saved = await save.json();
		const row = saved.gateways[0];
		expect(row).toEqual({ id: expect.any(String), name: "local-openai", url: secured.url, type: "openai-compatible", enabled: true, apiKeyConfigured: true });
		expect(JSON.stringify(saved)).not.toContain("integration-secret");
		expect(secured.requests.some((request) => request.path === "/v1/models" && request.authorization === "Bearer integration-secret")).toBe(true);
		const status = await (await apiFetch("/api/aigw/gateways/local-openai/status")).json();
		expect(status).toMatchObject({ state: "reachable", apiKeyConfigured: true });
		expect(secured.requests.at(-1)).toMatchObject({ path: "/v1/models", authorization: "Bearer integration-secret" });

		const prefs = await (await apiFetch("/api/preferences")).json();
		expect(JSON.stringify(prefs)).not.toContain("integration-secret");
		expect(prefs.modelGateways).toEqual([expect.objectContaining({ id: row.id, name: "local-openai" })]);

		const testedWithStoredKey = await apiFetch("/api/aigw/test", {
			method: "POST",
			body: JSON.stringify({ gatewayId: row.id, url: secured.url, type: "openai-compatible" }),
		});
		expect(testedWithStoredKey.status).toBe(200);
		expect(secured.requests.at(-1)).toMatchObject({ path: "/v1/models", authorization: "Bearer integration-secret" });

		const tested = await apiFetch("/api/aigw/test", {
			method: "POST",
			body: JSON.stringify({ url: secured.url, type: "openai-compatible", apiKey: "integration-secret" }),
		});
		expect(tested.status).toBe(200);
		expect((await tested.json()).models.map((model: any) => model.id)).toContain("claude-local");

		const proxied = await apiFetch("/api/aigw/local-openai/v1/models");
		expect(proxied.status).toBe(200);
		expect(secured.requests.at(-1)).toMatchObject({ path: "/v1/models", authorization: "Bearer integration-secret" });

		const modelTest = await apiFetch("/api/models/test", {
			method: "POST",
			body: JSON.stringify({ pref: "local-openai/claude-local" }),
		});
		expect(modelTest.status).toBe(200);
		expect(secured.requests.at(-1)).toMatchObject({ path: "/v1/chat/completions", authorization: "Bearer integration-secret" });

		// Omitted apiKey keeps the private key for a stable row id.
		const preserve = await putGateways([{ ...row, url: secured.url }]);
		expect(preserve.status).toBe(200);
		expect((await preserve.json()).gateways[0].apiKeyConfigured).toBe(true);

		// null clears it, and neither response contains the old expression.
		const clear = await putGateways([{ ...row, url: secured.url, apiKey: null }]);
		expect(clear.status).toBe(200);
		const cleared = await clear.json();
		expect(cleared.gateways[0].apiKeyConfigured).toBeUndefined();
		expect(JSON.stringify(cleared)).not.toContain("integration-secret");
	});

	test("rejects unsafe gateway URLs before persistence, key resolution, or network traffic", async () => {
		const unsafeUrl = `${secured.url}?x-api-key=do-not-reflect`;
		const before = secured.requests.length;
		const attempts = [
			await putGateways([{ name: "unsafe", url: unsafeUrl, type: "openai-compatible", enabled: true }]),
			await apiFetch("/api/aigw/test", { method: "POST", body: JSON.stringify({ url: unsafeUrl, type: "openai-compatible" }) }),
			await apiFetch("/api/aigw/configure", { method: "POST", body: JSON.stringify({ url: unsafeUrl }) }),
		];
		for (const response of attempts) {
			expect(response.status).toBe(400);
			expect(JSON.stringify(await response.json())).not.toContain("do-not-reflect");
		}
		expect(secured.requests).toHaveLength(before);
		expect((await (await apiFetch("/api/aigw/gateways")).json()).gateways).toEqual([]);
	});

	test("resolves test and legacy configure key expressions before outbound discovery", async () => {
		const beforeFailure = secured.requests.length;
		const failedTest = await apiFetch("/api/aigw/test", {
			method: "POST",
			body: JSON.stringify({ url: secured.url, type: "openai-compatible", apiKey: "!false" }),
		});
		expect(failedTest.status).toBe(502);
		expect(await failedTest.json()).toEqual({ error: 'Unable to resolve API key for gateway "test"' });
		expect(secured.requests).toHaveLength(beforeFailure);

		const tested = await apiFetch("/api/aigw/test", {
			method: "POST",
			body: JSON.stringify({ url: secured.url, type: "openai-compatible", apiKey: integrationKeyEnv }),
		});
		expect(tested.status).toBe(200);
		expect(secured.requests.at(-1)).toMatchObject({ path: "/v1/models", authorization: "Bearer integration-secret" });

		const configured = await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: secured.url, apiKey: integrationKeyEnv }),
		});
		expect(configured.status).toBe(200);
		expect(secured.requests.some((request) => request.path === "/v1/models" && request.authorization === "Bearer integration-secret")).toBe(true);
		const status = await (await apiFetch("/api/aigw/status")).json();
		expect(status).toMatchObject({ configured: true, state: "reachable", apiKeyConfigured: true });
		expect(secured.requests.at(-1)).toMatchObject({ path: "/v1/models", authorization: "Bearer integration-secret" });
	});

	test("reports empty, disabled, and unreachable states without converting an outage to empty", async () => {
		const emptySave = await putGateways([{ name: "empty-local", url: empty.url, type: "openai-compatible", enabled: true }]);
		expect(emptySave.status).toBe(200);
		const emptyStatus = await (await apiFetch("/api/aigw/gateways/empty-local/status")).json();
		expect(emptyStatus).toMatchObject({ configured: true, state: "empty", models: [] });

		const disabled = await putGateways([{ name: "empty-local", url: empty.url, type: "openai-compatible", enabled: false }]);
		expect(disabled.status).toBe(200);
		const disabledStatus = await (await apiFetch("/api/aigw/gateways/empty-local/status")).json();
		expect(disabledStatus).toMatchObject({ configured: true, enabled: false, state: "disabled", models: [] });

		const outageSave = await putGateways([{ name: "outage-local", url: "http://127.0.0.1:19999", type: "openai-compatible", enabled: true }]);
		expect(outageSave.status).toBe(200);
		const outageStatus = await (await apiFetch("/api/aigw/gateways/outage-local/status")).json();
		expect(outageStatus).toMatchObject({ configured: true, state: "unreachable", error: "Gateway is unreachable" });
		expect(outageStatus.models).toEqual(expect.any(Array));
	});

	test("runs legacy migration before startup discovery and keeps legacy shims working", async ({ gateway }) => {
		const prefs = gateway.sessionManager.preferencesStore;
		prefs.remove("modelGateways");
		prefs.set("aigw.url", empty.url);
		prefs.set("aigw.exclusive", true);
		await startupAigwCheck(prefs);

		// Boot migration creates the canonical singleton before discovery. The
		// legacy routes keep targeting exactly that migrated row.
		const migrated = await (await apiFetch("/api/aigw/gateways")).json();
		expect(migrated.gateways).toEqual([expect.objectContaining({ name: "aigw", url: empty.url, type: "aigw", enabled: true })]);
		const migratedPrefs = await (await apiFetch("/api/preferences")).json();
		expect(migratedPrefs).not.toHaveProperty("aigw.url");
		const configure = await apiFetch("/api/aigw/configure", { method: "POST", body: JSON.stringify({ url: empty.url }) });
		expect(configure.status).toBe(200);
		const status = await (await apiFetch("/api/aigw/status")).json();
		expect(status).toMatchObject({ configured: true, name: "aigw", url: empty.url, state: "empty" });
		expect((await (await apiFetch("/api/aigw/gateways")).json()).gateways).toEqual([
			expect.objectContaining({ name: "aigw", type: "aigw", enabled: true }),
		]);
		expect((await apiFetch("/api/aigw/refresh", { method: "POST" })).status).toBe(200);
		expect((await apiFetch("/api/aigw/configure", { method: "DELETE" })).status).toBe(200);
		expect(await (await apiFetch("/api/aigw/status")).json()).toEqual({ configured: false });
	});
});
