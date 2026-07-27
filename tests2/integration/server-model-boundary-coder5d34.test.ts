import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch } from "./_e2e/e2e-setup.js";

const BLOCKED_ROLE = `pi082-kimi-blocked-${Date.now()}`;
const SUPPORTED_ROLE = `pi082-kimi-id-supported-${Date.now()}`;

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
	});

	test("role create/update rejects exact kimi-coding but preserves Kimi-named IDs under supported providers", async () => {
		const blocked = await roleRequest("/api/roles", "POST", {
			name: BLOCKED_ROLE,
			label: "Deferred provider role",
			promptTemplate: "must not persist",
			model: "kimi-coding/k2p5",
			thinkingLevel: "high",
		});
		expect(blocked.response.status, JSON.stringify(blocked.data)).toBe(400);
		expect(String(blocked.data.error ?? "")).toMatch(/model|provider|selectable|available/i);

		const supported = await roleRequest("/api/roles", "POST", {
			name: SUPPORTED_ROLE,
			label: "Supported provider Kimi-named model",
			promptTemplate: "preserve provider identity",
			model: "aigw/kimi-coding/claude-opus-5",
			thinkingLevel: "high",
		});
		expect(supported.response.status, JSON.stringify(supported.data)).toBe(201);
		expect(supported.data.model).toBe("aigw/kimi-coding/claude-opus-5");
		expect(supported.data.thinkingLevel).toBe("high");

		const rejectedUpdate = await roleRequest(`/api/roles/${encodeURIComponent(SUPPORTED_ROLE)}`, "PUT", {
			model: "kimi-coding/k2p5",
			thinkingLevel: "high",
		});
		expect(rejectedUpdate.response.status, JSON.stringify(rejectedUpdate.data)).toBe(400);

		const retained = await apiFetch(`/api/roles/${encodeURIComponent(SUPPORTED_ROLE)}`);
		expect(retained.status).toBe(200);
		expect((await retained.json()).model).toBe("aigw/kimi-coding/claude-opus-5");
	});
});
