import { randomUUID } from "node:crypto";
import http from "node:http";
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, nonGitCwd } from "./_e2e/e2e-setup.js";

const CUSTOM_MODEL_ID = "kimi-coding/claude-opus-5";

async function roleRequest(path: string, method: "POST" | "PUT", body: Record<string, unknown>): Promise<{ response: Response; data: any }> {
	const response = await apiFetch(path, { method, body: JSON.stringify(body) });
	const text = await response.text();
	let data: any = {};
	try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
	return { response, data };
}

async function startReasoningOllamaFixture(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => {
		const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
		req.resume();
		res.writeHead(200, { "Content-Type": "application/json" });
		if (req.method === "GET" && pathname === "/api/tags") {
			res.end(JSON.stringify({
				models: [{
					name: CUSTOM_MODEL_ID,
					model: CUSTOM_MODEL_ID,
					modified_at: "2026-01-01T00:00:00.000Z",
					size: 1,
					digest: `sha256:${"0".repeat(64)}`,
					details: {
						parent_model: "",
						format: "gguf",
						family: "fixture",
						families: ["fixture"],
						parameter_size: "1B",
						quantization_level: "Q4_0",
					},
				}],
			}));
			return;
		}
		if (req.method === "POST" && pathname === "/api/show") {
			res.end(JSON.stringify({
				modelfile: "",
				parameters: "",
				template: "",
				details: {
					parent_model: "",
					format: "gguf",
					family: "fixture",
					families: ["fixture"],
					parameter_size: "1B",
					quantization_level: "Q4_0",
				},
				model_info: {
					"general.architecture": "fixture",
					"fixture.context_length": 65_536,
				},
				capabilities: ["completion", "tools", "thinking"],
			}));
			return;
		}
		res.end(JSON.stringify({ error: `unexpected fixture route ${req.method} ${pathname}` }));
	});

	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => reject(error);
		server.once("error", onError);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", onError);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Ollama fixture did not bind a TCP port");
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		close: () => new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		}),
	};
}

test.describe("server deferred-provider model boundaries", () => {
	test("default model preferences reject the exact deferred provider without mutating durable settings", async () => {
		const beforeResponse = await apiFetch("/api/preferences");
		expect(beforeResponse.status).toBe(200);
		const before = await beforeResponse.json();

		for (const key of ["default.sessionModel", "default.reviewModel", "default.namingModel"]) {
			const rejected = await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ [key]: "kimi-coding/k2p5" }),
			});
			const text = await rejected.text();
			expect(rejected.status, `${key}: ${text}`).toBe(400);
			const after = await (await apiFetch("/api/preferences")).json();
			expect(after[key]).toBe(before[key]);
		}
	});

	test("role/createSession rejects exact kimi-coding but preserves Kimi-named IDs under supported providers", async ({ gateway }) => {
		// Vitest retries execute in the same fork, so every attempt needs distinct
		// durable names even if a prior assertion interrupted cleanup.
		const suffix = randomUUID();
		const blockedRole = `pi082-kimi-blocked-${suffix}`;
		const supportedRole = `pi082-kimi-supported-${suffix}`;
		const customProviderId = `pi082-kimi-local-${suffix}`;
		const customProviderName = `local-kimi-${suffix}`;
		const ollama = await startReasoningOllamaFixture();
		let supportedSession: any;

		try {
			const sessionsBefore = new Set(gateway.sessionManager.listSessions().map((session: any) => session.id));
			await expect(gateway.sessionManager.createSession(
				nonGitCwd(),
				undefined,
				undefined,
				undefined,
				{
					projectId: gateway.defaultProjectId,
					initialModel: "kimi-coding/k2p5",
					initialThinkingLevel: "high",
				},
			)).rejects.toThrow(/not currently available|not session-selectable|unavailable/i);
			expect(new Set(gateway.sessionManager.listSessions().map((session: any) => session.id))).toEqual(sessionsBefore);

			const blocked = await roleRequest("/api/roles", "POST", {
				name: blockedRole,
				label: "Deferred provider role",
				promptTemplate: "must not persist",
				model: "kimi-coding/k2p5",
				thinkingLevel: "high",
			});
			expect(blocked.response.status, JSON.stringify(blocked.data)).toBe(400);
			expect(String(blocked.data.error ?? "")).toMatch(/model|provider|selectable|available/i);

			const provider = await apiFetch("/api/custom-providers", {
				method: "POST",
				body: JSON.stringify({
					id: customProviderId,
					name: customProviderName,
					type: "ollama",
					baseUrl: ollama.baseUrl,
				}),
			});
			expect(provider.status, await provider.text()).toBe(200);

			// The local discovery fixture advertises both tools and thinking, so the
			// exact current catalog row authoritatively supports high effort. This
			// avoids claiming that a manual non-reasoning row should retain "high".
			const supportedModel = `${customProviderName}/${CUSTOM_MODEL_ID}`;
			const catalogResponse = await apiFetch("/api/models");
			expect(catalogResponse.status).toBe(200);
			const catalog = await catalogResponse.json();
			expect(catalog.find((model: any) =>
				model.provider === customProviderName && model.id === CUSTOM_MODEL_ID,
			)).toMatchObject({ reasoning: true });
			const supported = await roleRequest("/api/roles", "POST", {
				name: supportedRole,
				label: "Supported provider Kimi-named model",
				promptTemplate: "preserve provider identity",
				model: supportedModel,
				thinkingLevel: "high",
			});
			expect(supported.response.status, JSON.stringify(supported.data)).toBe(201);
			expect(supported.data.model).toBe(supportedModel);
			expect(supported.data.thinkingLevel).toBe("high");

			const rejectedUpdate = await roleRequest(`/api/roles/${encodeURIComponent(supportedRole)}`, "PUT", {
				model: "kimi-coding/k2p5",
				thinkingLevel: "high",
			});
			expect(rejectedUpdate.response.status, JSON.stringify(rejectedUpdate.data)).toBe(400);

			const retained = await apiFetch(`/api/roles/${encodeURIComponent(supportedRole)}`);
			expect(retained.status).toBe(200);
			expect((await retained.json()).model).toBe(supportedModel);

			supportedSession = await gateway.sessionManager.createSession(
				nonGitCwd(),
				undefined,
				undefined,
				undefined,
				{
					projectId: gateway.defaultProjectId,
					initialModel: supportedModel,
					initialThinkingLevel: "high",
				},
			);
			expect(supportedSession.spawnPinnedModel).toBe(supportedModel);
			expect(supportedSession.spawnPinnedThinkingLevel).toBe("high");
		} finally {
			if (supportedSession?.id) {
				await gateway.sessionManager.terminateSession(supportedSession.id).catch(() => {});
			}
			// Keep shared-store teardown ordered, but never let one missing fixture
			// prevent the remaining resources from being released.
			await apiFetch(`/api/roles/${encodeURIComponent(blockedRole)}`, { method: "DELETE" }).catch(() => {});
			await apiFetch(`/api/roles/${encodeURIComponent(supportedRole)}`, { method: "DELETE" }).catch(() => {});
			await apiFetch(`/api/custom-providers/${encodeURIComponent(customProviderId)}`, { method: "DELETE" }).catch(() => {});
			await ollama.close();
		}
	});
});
