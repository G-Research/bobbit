import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, nonGitCwd } from "./_e2e/e2e-setup.js";

const BLOCKED_ROLE = `pi082-kimi-blocked-${Date.now()}`;
const SUPPORTED_ROLE = `pi082-kimi-id-supported-${Date.now()}`;
const CUSTOM_PROVIDER_ID = `pi082-kimi-local-${Date.now()}`;
const CUSTOM_PROVIDER_NAME = `local-kimi-${Date.now()}`;
const CUSTOM_MODEL_ID = "kimi-coding/claude-opus-5";

async function roleRequest(path: string, method: "POST" | "PUT", body: Record<string, unknown>): Promise<{ response: Response; data: any }> {
	const response = await apiFetch(path, { method, body: JSON.stringify(body) });
	const text = await response.text();
	let data: any = {};
	try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
	return { response, data };
}

test.describe("server deferred-provider model boundaries", () => {
	test.afterAll(async () => {
		await apiFetch(`/api/roles/${encodeURIComponent(BLOCKED_ROLE)}`, { method: "DELETE" }).catch(() => {});
		await apiFetch(`/api/roles/${encodeURIComponent(SUPPORTED_ROLE)}`, { method: "DELETE" }).catch(() => {});
		await apiFetch(`/api/custom-providers/${encodeURIComponent(CUSTOM_PROVIDER_ID)}`, { method: "DELETE" }).catch(() => {});
	});

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
			name: BLOCKED_ROLE,
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
				id: CUSTOM_PROVIDER_ID,
				name: CUSTOM_PROVIDER_NAME,
				type: "manual",
				baseUrl: "http://127.0.0.1:9",
				models: [{ id: CUSTOM_MODEL_ID, name: "Kimi-named local model" }],
			}),
		});
		expect(provider.status, await provider.text()).toBe(200);

		const supportedModel = `${CUSTOM_PROVIDER_NAME}/${CUSTOM_MODEL_ID}`;
		const supported = await roleRequest("/api/roles", "POST", {
			name: SUPPORTED_ROLE,
			label: "Supported provider Kimi-named model",
			promptTemplate: "preserve provider identity",
			model: supportedModel,
			thinkingLevel: "high",
		});
		expect(supported.response.status, JSON.stringify(supported.data)).toBe(201);
		expect(supported.data.model).toBe(supportedModel);
		expect(supported.data.thinkingLevel).toBe("high");

		const rejectedUpdate = await roleRequest(`/api/roles/${encodeURIComponent(SUPPORTED_ROLE)}`, "PUT", {
			model: "kimi-coding/k2p5",
			thinkingLevel: "high",
		});
		expect(rejectedUpdate.response.status, JSON.stringify(rejectedUpdate.data)).toBe(400);

		const retained = await apiFetch(`/api/roles/${encodeURIComponent(SUPPORTED_ROLE)}`);
		expect(retained.status).toBe(200);
		expect((await retained.json()).model).toBe(supportedModel);

		let supportedSession: any;
		try {
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
			if (supportedSession?.id) await gateway.sessionManager.terminateSession(supportedSession.id).catch(() => {});
		}
	});
});
