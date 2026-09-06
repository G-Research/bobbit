import { join } from "node:path";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { test, expect } from "../../../support/harnesses/integration/gateway/in-process-harness.js";
import {
	apiFetch,
	connectWs,
	createSession,
	deleteSession,
	type WsConnection,
	type WsMsg,
} from "../../../support/harnesses/integration/gateway/e2e-setup.js";
import { installFakeCodexOAuth } from "../../../support/fixtures/models/fake-codex-oauth.js";
import { pollUntil } from "../../../e2e/test-utils/cleanup.js";
import {
	clearOAuthCache,
	findSessionSelectableModel,
	invalidateModelCache,
} from "../../../../src/server/agent/model-registry.js";

const ASTRA = {
	provider: "openai-codex",
	id: "gpt-6-astra",
} as const;

const ASTRA_THINKING_MAP = {
	off: null,
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
} as const;

function astraState(message: WsMsg, thinkingLevel: "minimal" | "max"): boolean {
	if (message.type !== "state") return false;
	const state = message.data as any;
	return state?.model?.provider === ASTRA.provider
		&& state?.model?.id === ASTRA.id
		&& state?.thinkingLevel === thinkingLevel;
}

function assertAstraState(message: WsMsg, thinkingLevel: "minimal" | "max", context: string): void {
	expect(message.type, context).toBe("state");
	const state = message.data as any;
	expect(state.thinkingLevel, `${context}: effective thinking`).toBe(thinkingLevel);
	expect(state.model, `${context}: Pi metadata`).toMatchObject({
		provider: ASTRA.provider,
		id: ASTRA.id,
		contextWindow: 272_000,
		maxTokens: 128_000,
		reasoning: true,
		input: ["text", "image"],
		thinkingLevelMap: ASTRA_THINKING_MAP,
	});
}

async function closeWs(ws: WsConnection): Promise<void> {
	const closed = new Promise<void>((resolve) => ws.ws.once("close", () => resolve()));
	ws.close();
	await closed;
}

async function waitForPersistedThinking(gateway: any, sessionId: string, thinkingLevel: "minimal" | "max"): Promise<void> {
	await pollUntil(async () => {
		const row = gateway.sessionManager.getPersistedSession(sessionId);
		return row?.modelProvider === ASTRA.provider
			&& row.modelId === ASTRA.id
			&& row.effectiveThinkingLevel === thinkingLevel;
	}, { timeoutMs: 5_000, intervalMs: 25, label: `Astra/${thinkingLevel} tuple persisted` });
}

function stripBobbitPresentation(model: Record<string, unknown>): Record<string, unknown> {
	const { authenticated: _authenticated, modelCapacity: _modelCapacity, ...piRow } = model;
	return piRow;
}

test.describe("Astra session persistence", () => {
	test("uses the authenticated Pi row, clamps off to minimal, and retains max across reconnect", async ({ gateway }) => {
		gateway.restoreAgentDirRuntime();
		const restoreAuth = installFakeCodexOAuth(join(gateway.bobbitDir, "agent"));
		clearOAuthCache();
		invalidateModelCache();

		let sessionId: string | undefined;
		let ws1: WsConnection | undefined;
		let ws2: WsConnection | undefined;
		try {
			const response = await apiFetch("/api/models");
			expect(response.status).toBe(200);
			const models = await response.json() as Array<Record<string, any>>;
			const matches = models.filter((model) => model.provider === ASTRA.provider && model.id === ASTRA.id);
			expect(matches, "Astra must occur exactly once in the real Pi-backed API catalog").toHaveLength(1);
			const model = matches[0];
			expect(model.authenticated, "the isolated Codex OAuth fixture should authenticate Astra").toBe(true);
			expect(findSessionSelectableModel(models as any, ASTRA.provider, ASTRA.id)).toBe(model);

			const upstream = getBuiltinModel(ASTRA.provider, ASTRA.id);
			expect(upstream, "Pi 0.85.1 must publish the Astra row").toBeTruthy();
			expect(stripBobbitPresentation(model)).toEqual(upstream);
			expect(model).toMatchObject({
				name: "GPT-6 Astra",
				api: "openai-codex-responses",
				baseUrl: "https://chatgpt.com/backend-api",
				contextWindow: 272_000,
				maxTokens: 128_000,
				reasoning: true,
				input: ["text", "image"],
				cost: {
					input: 10,
					output: 50,
					cacheRead: 1,
					cacheWrite: 12.5,
					tiers: [{ inputTokensAbove: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
				},
				thinkingLevelMap: ASTRA_THINKING_MAP,
				compat: {
					supportsOpenAIGrammarTools: true,
					supportsAdditionalTools: true,
					supportsToolSearch: true,
				},
			});

			sessionId = await createSession();
			ws1 = await connectWs(sessionId);

			let cursor = ws1.messageCount();
			ws1.send({ type: "set_model", provider: ASTRA.provider, modelId: ASTRA.id, thinkingLevel: "off" });
			const minimal = await ws1.waitForFrom(cursor, (message) => astraState(message, "minimal"), 10_000);
			assertAstraState(minimal, "minimal", "off selection");
			await waitForPersistedThinking(gateway, sessionId, "minimal");

			cursor = ws1.messageCount();
			ws1.send({ type: "set_model", provider: ASTRA.provider, modelId: ASTRA.id, thinkingLevel: "max" });
			const max = await ws1.waitForFrom(cursor, (message) => astraState(message, "max"), 10_000);
			assertAstraState(max, "max", "max selection");
			await waitForPersistedThinking(gateway, sessionId, "max");

			await closeWs(ws1);
			ws1 = undefined;
			ws2 = await connectWs(sessionId);
			cursor = ws2.messageCount();
			ws2.send({ type: "get_state" });
			const reconnected = await ws2.waitForFrom(cursor, (message) => astraState(message, "max"), 10_000);
			assertAstraState(reconnected, "max", "reconnect");
			await waitForPersistedThinking(gateway, sessionId, "max");
		} finally {
			if (ws2) await closeWs(ws2).catch(() => undefined);
			if (ws1) await closeWs(ws1).catch(() => undefined);
			if (sessionId) await deleteSession(sessionId).catch(() => undefined);
			restoreAuth();
			clearOAuthCache();
			invalidateModelCache();
		}
	});
});
