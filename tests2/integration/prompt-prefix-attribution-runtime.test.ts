// v2-native — live gateway wiring for prompt-prefix attribution diagnostics.
import { createPrefixSeed } from "../../src/server/agent/prompt-prefix-attribution.ts";
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, connectWs, createSession, deleteSession, statusPredicate } from "./_e2e/e2e-setup.js";
import { pollUntil } from "../../tests/e2e/test-utils/cleanup.js";

interface AttributionEntry {
	sequence: number;
	boundary: "dispatch" | "before-prompt";
	comparison: "first" | "stable" | "changed" | "boundary";
	culprit?: string;
	changed?: string[];
	compactionEpoch: number;
	model?: { provider: string; id: string };
	providerCacheTelemetry: "hit" | "miss" | "unknown";
	components: Array<{ kind: string; sha256: string; bytes: number }>;
	aggregateSha256: string;
}

async function entries(sessionId: string, limit?: number): Promise<AttributionEntry[]> {
	const suffix = limit === undefined ? "" : `?limit=${limit}`;
	const response = await apiFetch(`/api/sessions/${sessionId}/prompt-prefix-attribution${suffix}`);
	expect(response.status).toBe(200);
	const body = await response.json();
	expect(Array.isArray(body.entries)).toBe(true);
	return body.entries as AttributionEntry[];
}

async function driveTurn(sessionId: string, text: string): Promise<void> {
	const connection = await connectWs(sessionId);
	try {
		const cursor = connection.messageCount();
		connection.send({ type: "prompt", text });
		await connection.waitForFrom(cursor, statusPredicate("idle"), 15_000);
	} finally {
		connection.close();
	}
}

/** Finalizes a bridge-pending dispatch through the real provider-hook route. */
async function finalizeTurn(sessionId: string, prompt: string): Promise<void> {
	const response = await apiFetch(`/api/sessions/${sessionId}/provider-hooks/before-prompt`, {
		method: "POST",
		body: JSON.stringify({ prompt }),
	});
	expect(response.status).toBe(200);
}

async function setModel(gateway: any, sessionId: string, provider: string, modelId: string): Promise<void> {
	const connection = await connectWs(sessionId);
	try {
		connection.send({ type: "set_model", provider, modelId, thinkingLevel: "medium" });
		await pollUntil(async () => {
			const persisted = gateway.sessionManager.getPersistedSession(sessionId);
			return persisted?.modelProvider === provider && persisted.modelId === modelId ? true : null;
		}, { timeoutMs: 5_000, intervalMs: 25, label: "attribution model persisted" });
	} finally {
		connection.close();
	}
}

test.describe("prompt-prefix attribution runtime wiring", () => {
	let sessionId = "";

	test.afterEach(async () => {
		if (sessionId) await deleteSession(sessionId);
		sessionId = "";
	});

	test("persists hash-only stable turns, redacts all raw inputs, and applies the endpoint limit cap", async ({ gateway }) => {
		sessionId = await createSession();
		const live = gateway.sessionManager.getSession(sessionId) as any;
		expect(live).toBeTruthy();

		// Inject sentinels into every fingerprint input, then exercise the real
		// WebSocket dispatch → before-prompt API → ContextTraceStore path.
		live.prefixSeed = createPrefixSeed({
			system: "PREFIX-SYSTEM-RAW-SENTINEL",
			tools: { description: "PREFIX-TOOL-RAW-SENTINEL", schema: { secret: "PREFIX-TOOL-SCHEMA-SENTINEL" } },
			skills: "PREFIX-SKILL-RAW-SENTINEL",
			sessionSetupDynamicContext: "PREFIX-DYNAMIC-RAW-SENTINEL",
		});
		gateway.sessionManager.setupPromptPrefixAttribution(live, true);

		await driveTurn(sessionId, "PREFIX-USER-PROMPT-RAW-SENTINEL one");
		await finalizeTurn(sessionId, "PREFIX-USER-PROMPT-RAW-SENTINEL one");
		await driveTurn(sessionId, "PREFIX-USER-PROMPT-RAW-SENTINEL two");
		await finalizeTurn(sessionId, "PREFIX-USER-PROMPT-RAW-SENTINEL two");

		const initial = await entries(sessionId);
		expect(initial).toHaveLength(2);
		expect(initial[0]).toMatchObject({ comparison: "first", boundary: "before-prompt", providerCacheTelemetry: "unknown" });
		expect(initial[1]).toMatchObject({ comparison: "stable", boundary: "before-prompt", comparableTo: initial[0].sequence, providerCacheTelemetry: "unknown" });
		for (const entry of initial) {
			expect(entry.aggregateSha256).toMatch(/^[a-f0-9]{64}$/);
			expect(entry.components).toHaveLength(4);
			for (const component of entry.components) {
				expect(component).toMatchObject({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
				expect(component).not.toHaveProperty("content");
			}
		}
		const rendered = JSON.stringify(initial);
		for (const sentinel of [
			"PREFIX-SYSTEM-RAW-SENTINEL",
			"PREFIX-TOOL-RAW-SENTINEL",
			"PREFIX-TOOL-SCHEMA-SENTINEL",
			"PREFIX-SKILL-RAW-SENTINEL",
			"PREFIX-DYNAMIC-RAW-SENTINEL",
			"PREFIX-USER-PROMPT-RAW-SENTINEL",
		]) expect(rendered).not.toContain(sentinel);

		// The recorder and store are the real session-owned instances; add enough
		// records to prove the route's public 1000-row cap without a second store.
		for (let index = 0; index < 1_000; index++) {
			live.prefixAttributionRecorder.beginDispatch(live.prefixSeed, { compactionEpoch: 0 });
			live.prefixAttributionRecorder.flushPending();
		}
		const capped = await entries(sessionId, 50_000);
		expect(capped).toHaveLength(1_000);
		expect((await entries(sessionId, 1))[0].sequence).toBe(capped.at(-1)?.sequence);
	});

	test("keeps persisted attribution rows observable after an agent restart", async ({ gateway }) => {
		sessionId = await createSession();
		const live = gateway.sessionManager.getSession(sessionId) as any;
		gateway.sessionManager.setupPromptPrefixAttribution(live, true);
		await driveTurn(sessionId, "restart attribution persistence");
		await finalizeTurn(sessionId, "restart attribution persistence");
		const before = await entries(sessionId);
		expect(before).toHaveLength(1);

		const restart = await apiFetch(`/api/sessions/${sessionId}/restart`, { method: "POST", body: JSON.stringify({}) });
		expect(restart.status).toBe(200);
		const after = await entries(sessionId);
		expect(after).toEqual(before);
	});

	test("marks model switches and successful compaction as comparison boundaries", async ({ gateway }) => {
		sessionId = await createSession();
		await driveTurn(sessionId, "baseline boundary turn");
		expect((await entries(sessionId)).at(-1)).toMatchObject({ comparison: "first", compactionEpoch: 0 });

		await setModel(gateway, sessionId, "anthropic", "claude-sonnet-5");
		await driveTurn(sessionId, "model boundary turn");
		const modelBoundary = (await entries(sessionId)).at(-1)!;
		expect(modelBoundary).toMatchObject({ comparison: "boundary", model: { provider: "anthropic", id: "claude-sonnet-5" } });

		const connection = await connectWs(sessionId);
		try {
			const cursor = connection.messageCount();
			connection.send({ type: "compact" });
			await connection.waitForFrom(cursor, message => message.type === "event" && message.data?.type === "compaction_end", 15_000);
		} finally {
			connection.close();
		}
		await driveTurn(sessionId, "compaction boundary turn");
		const compactionBoundary = (await entries(sessionId)).at(-1)!;
		expect(compactionBoundary).toMatchObject({ comparison: "boundary" });
		expect(compactionBoundary.compactionEpoch).toBeGreaterThan(modelBoundary.compactionEpoch);
	});
});
