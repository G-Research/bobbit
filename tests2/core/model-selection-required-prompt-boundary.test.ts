import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, describe, it, vi } from "vitest";

import { deliverSessionPrompt } from "../../src/server/agent/session-prompt-delivery.ts";
import { handleWebSocketConnection } from "../../src/server/ws/handler.ts";
import {
	MODEL_SELECTION_RECOVERY_FAILED,
	MODEL_SELECTION_REQUIRED,
	type ModelSelectionRequiredCondition,
} from "../../src/server/ws/protocol.ts";

const CONDITION: ModelSelectionRequiredCondition = {
	code: MODEL_SELECTION_REQUIRED,
	provider: "retired-provider",
	modelId: "retired-model",
};

class FakeWebSocket extends EventEmitter {
	readyState = 1;
	readonly sent: any[] = [];

	send(data: string, callback?: (error?: Error) => void): void {
		this.sent.push(JSON.parse(data));
		callback?.();
	}

	close(code?: number, reason?: string): void {
		this.readyState = 3;
		this.emit("close", code, reason);
	}
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	assert.fail(`timed out waiting for ${label}`);
}

function websocketHarness(recoverModelSelectionRequired = vi.fn(async () => {})) {
	const ws = new FakeWebSocket();
	const clients = new Set<any>();
	const queueRows = [{ id: "persisted-queued", text: "leave me parked" }];
	const enqueuePrompt = vi.fn(async () => ({ status: "queued" as const }));
	const rpcPrompt = vi.fn();
	const projectConfigGet = vi.fn();
	let cwdReads = 0;
	const session: any = {
		id: "conditioned-session",
		title: "Retired model history",
		status: "terminated",
		statusVersion: 4,
		condition: CONDITION,
		dormant: true,
		clients,
		eventBuffer: { size: 0 },
		promptQueue: { toArray: () => queueRows },
		rpcClient: { prompt: rpcPrompt },
		get cwd() {
			cwdReads++;
			throw new Error("prompt preprocessing read cwd");
		},
	};
	const persisted = {
		modelProvider: CONDITION.provider,
		modelId: CONDITION.modelId,
		effectiveThinkingLevel: "high",
	};
	const persistMutation = vi.fn();
	const manager: any = {
		getSession: (id: string) => id === session.id ? session : undefined,
		getArchivedSession: () => undefined,
		addClient: (_id: string, client: any) => clients.add(client),
		removeClient: (_id: string, client: any) => clients.delete(client),
		getPersistedSession: () => persisted,
		getImageModelForSession: () => undefined,
		withSessionCostInState: (_id: string, data: unknown) => data,
		getSessionCostUpdate: () => undefined,
		getPendingToolPermission: () => undefined,
		getProjectContextManager: () => undefined,
		enqueuePrompt,
		persistSessionModel: persistMutation,
		recoverModelSelectionRequired,
	};

	handleWebSocketConnection(
		ws as any,
		session.id,
		{ socket: { remoteAddress: "127.0.0.1" } } as any,
		manager,
		"unused-token",
		{ isRateLimited: () => false, recordFailure: () => {} } as any,
		{ get: projectConfigGet },
		true,
	);
	ws.emit("message", JSON.stringify({ type: "auth", token: "ignored" }));

	return {
		ws,
		session,
		queueRows,
		enqueuePrompt,
		rpcPrompt,
		projectConfigGet,
		persistMutation,
		recoverModelSelectionRequired,
		cwdReads: () => cwdReads,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("MODEL_SELECTION_REQUIRED prompt boundaries", () => {
	it("shared delivery rejects before generic terminated handling and acceptance", async () => {
		const enqueuePrompt = vi.fn();
		const deliverLiveSteer = vi.fn();
		const getRecoveryDecision = vi.fn();

		await assert.rejects(
			() => deliverSessionPrompt({
				getSession: () => ({
					id: "conditioned-session",
					status: "terminated",
					condition: CONDITION,
				}),
				enqueuePrompt,
				deliverLiveSteer,
				getErroredPromptRecoveryDecision: getRecoveryDecision,
			}, "conditioned-session", "do not accept", { defaultMode: "prompt" }),
			(error: any) => {
				assert.equal(error.code, MODEL_SELECTION_REQUIRED);
				assert.equal(error.status, 409);
				assert.match(error.message, /retired-provider\/retired-model/);
				assert.match(error.message, /choose a replacement model/i);
				return true;
			},
		);
		assert.equal(enqueuePrompt.mock.calls.length, 0);
		assert.equal(deliverLiveSteer.mock.calls.length, 0);
		assert.equal(getRecoveryDecision.mock.calls.length, 0, "condition rejection must precede terminated recovery classification");
	});

	it("WS prompt rejection exposes the tuple and performs no preprocessing or acceptance mutation", async () => {
		const h = websocketHarness();
		try {
			await waitFor(
				() => h.ws.sent.some((frame) => frame.type === "state"),
				"initial fallback state",
			);
			const state = h.ws.sent.find((frame) => frame.type === "state");
			assert.deepEqual(state.data.condition, CONDITION);
			assert.equal(state.data.model.provider, CONDITION.provider);
			assert.equal(state.data.model.id, CONDITION.modelId);

			const stateCount = h.ws.sent.filter((frame) => frame.type === "state").length;
			h.ws.emit("message", JSON.stringify({ type: "get_state" }));
			await waitFor(
				() => h.ws.sent.filter((frame) => frame.type === "state").length > stateCount,
				"explicit conditioned get_state",
			);
			const explicitState = h.ws.sent.filter((frame) => frame.type === "state").at(-1);
			assert.deepEqual(explicitState.data.condition, CONDITION);

			const queueBefore = JSON.stringify(h.queueRows);
			const attachmentDraft = Object.freeze({ id: "attachment-1", fileName: "draft.txt", content: "draft bytes" });
			h.ws.emit("message", JSON.stringify({
				type: "prompt",
				text: "/missing-skill inspect @draft.txt",
				attachments: [attachmentDraft],
			}));
			await waitFor(
				() => h.ws.sent.some((frame) => frame.type === "error" && frame.code === MODEL_SELECTION_REQUIRED),
				"model-selection-required error",
			);

			const error = h.ws.sent.find((frame) => frame.type === "error" && frame.code === MODEL_SELECTION_REQUIRED);
			assert.match(error.message, /retired-provider\/retired-model/);
			assert.match(error.message, /choose a replacement model/i);
			assert.equal(h.cwdReads(), 0, "file mention preprocessing must not inspect cwd");
			assert.equal(h.projectConfigGet.mock.calls.length, 0, "skill preprocessing must not inspect config");
			assert.equal(h.enqueuePrompt.mock.calls.length, 0, "the queue acceptance boundary must not run");
			assert.equal(h.rpcPrompt.mock.calls.length, 0);
			assert.equal(h.persistMutation.mock.calls.length, 0);
			assert.equal(JSON.stringify(h.queueRows), queueBefore, "existing persisted prompts must remain parked and unchanged");
			assert.deepEqual(attachmentDraft, { id: "attachment-1", fileName: "draft.txt", content: "draft bytes" });
			assert.equal(
				h.ws.sent.some((frame) => frame.type === "error" && frame.code === "COMMAND_ERROR"),
				false,
			);
		} finally {
			h.ws.close();
		}
	});

	it("routes a conditioned model selection through exact cold recovery", async () => {
		const recover = vi.fn(async () => {});
		const h = websocketHarness(recover);
		try {
			h.ws.emit("message", JSON.stringify({
				type: "set_model",
				provider: "anthropic",
				modelId: "claude-sonnet-5",
				thinkingLevel: "high",
			}));
			await waitFor(() => recover.mock.calls.length === 1, "cold model recovery");
			assert.deepEqual(recover.mock.calls[0], [
				"conditioned-session",
				"anthropic",
				"claude-sonnet-5",
				"high",
			]);
			assert.equal(h.persistMutation.mock.calls.length, 0, "transport must not publish before manager verification");
			assert.equal(h.rpcPrompt.mock.calls.length, 0);
		} finally {
			h.ws.close();
		}
	});

	it("sanitizes an actionable recovery failure while retaining the condition", async () => {
		const secret = `sk-or-${"a".repeat(28)}`;
		const recover = vi.fn(async () => {
			throw new Error(`provider rejected api_key=${secret}`);
		});
		const h = websocketHarness(recover);
		vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			h.ws.emit("message", JSON.stringify({
				type: "set_model",
				provider: "anthropic",
				modelId: "claude-sonnet-5",
			}));
			await waitFor(
				() => h.ws.sent.some((frame) => frame.type === "error" && frame.code === MODEL_SELECTION_RECOVERY_FAILED),
				"sanitized recovery failure",
			);
			const error = h.ws.sent.find((frame) => frame.type === "error" && frame.code === MODEL_SELECTION_RECOVERY_FAILED);
			assert.match(error.message, /choose another available model or retry/i);
			assert.equal(error.message.includes(secret), false);
			assert.match(error.message, /<redacted-(?:api-key|token)>/);
			assert.deepEqual(h.session.condition, CONDITION);
			assert.equal(h.persistMutation.mock.calls.length, 0);
		} finally {
			h.ws.close();
		}
	});
});
