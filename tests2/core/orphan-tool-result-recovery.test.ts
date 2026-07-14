import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, vi } from "vitest";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-tool-recovery-"));
process.env.BOBBIT_DIR = tmpRoot;
process.env.BOBBIT_AGENT_DIR = path.join(tmpRoot, "agent");

const { SessionManager, classifyErroredPromptRecovery, emitSessionEvent } = await import("../../src/server/agent/session-manager.ts");
const { deliverSessionPrompt } = await import("../../src/server/agent/session-prompt-delivery.ts");
const { isOrphanToolResultOrderingError } = await import("../../src/server/agent/poisoned-history.ts");
const { PromptQueue } = await import("../../src/server/agent/prompt-queue.ts");
const { EventBuffer } = await import("../../src/server/agent/event-buffer.ts");

const ORPHAN_ERROR =
	"400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"messages.88.content.0: unexpected tool_use_id found in tool_result blocks: toolu_fixture. Each tool_result block must have a corresponding tool_use block in the previous message.\"}}";

const managers: any[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	while (managers.length) {
		const manager = managers.pop();
		if (manager._statusHeartbeatTimer) clearInterval(manager._statusHeartbeatTimer);
		manager.sessions?.clear();
	}
});

function bridge(prompts: Array<{ text: string; images?: unknown }>): any {
	return {
		running: true,
		async stop() {},
		prompt(text: string, images?: unknown) {
			prompts.push({ text, images });
			return Promise.resolve({ success: true });
		},
		onEvent() { return () => {}; },
	};
}

function harness(options?: { hadToolCalls?: boolean; queue?: string[] }) {
	const oldPrompts: Array<{ text: string; images?: unknown }> = [];
	const newPrompts: Array<{ text: string; images?: unknown }> = [];
	const manager: any = new SessionManager();
	managers.push(manager);
	const sessionFile = path.join(tmpRoot, "agent", "sessions", "--fixture--", "fixture.jsonl");
	fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
	fs.writeFileSync(sessionFile, JSON.stringify({
		type: "message",
		id: "fixture-user",
		parentId: null,
		message: { role: "user", content: [{ type: "text", text: "valid history" }] },
	}) + "\n");
	const persistedRecord: Record<string, any> = {
		id: "session-fixture",
		agentSessionFile: sessionFile,
		modelProvider: "anthropic",
		modelId: "claude-sonnet-4-5",
		projectId: "project-fixture",
	};
	manager._testStore = {
		get: () => persistedRecord,
		update: (_id: string, updates: Record<string, unknown>) => Object.assign(persistedRecord, updates),
	};
	const promptQueue = new PromptQueue();
	for (const text of options?.queue ?? []) promptQueue.enqueue(text);
	const session: any = {
		id: "session-fixture",
		title: "Poisoned session",
		titleGenerated: true,
		cwd: tmpRoot,
		status: "idle",
		statusVersion: 7,
		createdAt: Date.now(),
		lastActivity: Date.now(),
		clients: new Set(),
		promptQueue,
		eventBuffer: new EventBuffer(),
		inFlightSteerTexts: [],
		unsubscribe() {},
		rpcClient: bridge(oldPrompts),
		lastTurnErrored: true,
		lastTurnErrorMessage: ORPHAN_ERROR,
		turnHadToolCalls: options?.hadToolCalls ?? false,
		consecutiveErrorTurns: 3,
		transientRetryAttempts: 3,
		lastPromptText: "original user intent",
		lastPromptSource: "user",
		projectId: "project-fixture",
		modelProvider: "anthropic",
		modelId: "claude-sonnet-4-5",
		thinkingLevel: "high",
	};
	manager.sessions.set(session.id, session);
	let respawns = 0;
	manager._respawnAgentInPlaceOwned = async (_id: string, current: any) => {
		respawns++;
		// Match the real helper's temporary SessionInfo gap and fresh SessionInfo.
		// In particular, restore does not copy process-local pending prompt envelopes.
		manager.sessions.delete(current.id);
		await Promise.resolve();
		const { pendingSkillExpansions: _discardedEnvelope, ...restoredState } = current;
		const restored = { ...restoredState, rpcClient: bridge(newPrompts) };
		manager.sessions.set(current.id, restored);
		return restored;
	};
	return { manager, session, persistedRecord, oldPrompts, newPrompts, respawns: () => respawns };
}

describe("Anthropic orphan tool-result poison classification", () => {
	it("matches only the indexed orphan-ordering signature", () => {
		assert.equal(isOrphanToolResultOrderingError(ORPHAN_ERROR), true);
		assert.equal(isOrphanToolResultOrderingError("400 messages.88.content.0: unexpected tool_use_id"), false);
		assert.equal(isOrphanToolResultOrderingError("messages.1.content.0: tool_result must have a corresponding tool_use in the previous message"), false);
		assert.equal(isOrphanToolResultOrderingError("400 invalid_request_error: generic bad request"), false);
	});

	it("classifies poison as one user-driven recovery even after generic retry budget exhaustion", () => {
		assert.deepEqual(classifyErroredPromptRecovery({
			lastTurnErrored: true,
			lastTurnErrorMessage: ORPHAN_ERROR,
			transientRetryAttempts: 99,
		}), { recoverable: true, reason: "poisoned-history", attempts: 0, maxAttempts: 1 });
	});
});

describe("SessionManager poisoned-history recovery", () => {
	it("coalesces duplicate Retry clicks into one in-place respawn and one original-intent redrive", async () => {
		const h = harness();
		const info = vi.spyOn(console, "info").mockImplementation(() => {});

		await Promise.all([
			h.manager.retryLastPrompt(h.session.id),
			h.manager.retryLastPrompt(h.session.id),
		]);

		assert.equal(h.respawns(), 1);
		assert.deepEqual(h.oldPrompts, [], "poisoned Pi process must never receive the redrive");
		assert.deepEqual(h.newPrompts.map((entry) => entry.text), ["original user intent"]);
		const restored = h.manager.sessions.get(h.session.id);
		assert.equal(restored.id, "session-fixture");
		assert.equal(restored.modelId, "claude-sonnet-4-5");
		assert.equal(restored.thinkingLevel, "high");
		assert.equal(restored.lastPromptSource, "user");
		assert.equal(restored.lastTurnErrored, false);
		assert.match(info.mock.calls.flat().join(" "), /session=session-fixture boundary=retry repairedRecords=0 sandboxed=false project=project-fixture/);
	});

	it("uses the continuation instruction after a poisoned mid-tool turn", async () => {
		const h = harness({ hadToolCalls: true });
		vi.spyOn(console, "info").mockImplementation(() => {});

		await h.manager.retryLastPrompt(h.session.id);

		assert.equal(h.respawns(), 1);
		assert.equal(h.newPrompts.length, 1);
		assert.match(h.newPrompts[0].text, /continue where you left off/i);
		assert.doesNotMatch(h.newPrompts[0].text, /original user intent/);
	});

	it("repairs before the error cap and dispatches a normal follow-up ahead of parked queue rows", async () => {
		const h = harness({ queue: ["already parked"] });
		vi.spyOn(console, "info").mockImplementation(() => {});

		const result = await h.manager.enqueuePrompt(h.session.id, "new user intent", { source: "user" });

		assert.deepEqual(result, { status: "dispatched" });
		assert.equal(h.respawns(), 1);
		assert.deepEqual(h.oldPrompts, []);
		assert.deepEqual(h.newPrompts.map((entry) => entry.text), ["new user intent"]);
		const restored = h.manager.sessions.get(h.session.id);
		assert.deepEqual(restored.promptQueue.toArray().map((row: any) => row.text), ["already parked"]);
		assert.equal(restored.lastPromptSource, "user");
		assert.doesNotMatch(h.newPrompts[0].text, /previous turn failed/i);
	});

	it("durably parks every distinct concurrent follow-up when their shared recovery rejects", async () => {
		const h = harness();
		vi.spyOn(console, "info").mockImplementation(() => {});
		let rejectReplacement!: (error: Error) => void;
		const replacement = new Promise<void>((_resolve, reject) => { rejectReplacement = reject; });
		let respawns = 0;
		h.manager._respawnAgentInPlaceOwned = async () => {
			respawns++;
			await replacement;
		};

		const first = h.manager.enqueuePrompt(h.session.id, "first accepted follow-up", { source: "user" });
		const second = h.manager.enqueuePrompt(h.session.id, "second accepted follow-up", {
			modelText: "expanded second follow-up",
			source: "agent",
		});
		rejectReplacement(new Error("fixture shared replacement failed"));

		const results = await Promise.allSettled([first, second]);
		assert.deepEqual(results.map((result) => result.status), ["rejected", "fulfilled"]);
		assert.deepEqual(results[1], { status: "fulfilled", value: { status: "queued" } });
		assert.equal(respawns, 1, "concurrent follow-ups must share one replacement attempt");
		const rollback = h.manager.sessions.get(h.session.id);
		const queued = rollback.promptQueue.toArray();
		assert.deepEqual(queued.map((row: any) => row.text), [
			"first accepted follow-up",
			"expanded second follow-up",
		]);
		assert.equal(new Set(queued.map((row: any) => row.id)).size, 2, "accepted intents need distinct durable rows");
		assert.deepEqual(h.persistedRecord.messageQueue, queued);
		assert.equal(rollback.lastPromptSource, "agent");
	});

	it("preserves a slash-skill envelope across follow-up respawn for the live echo", async () => {
		const h = harness();
		vi.spyOn(console, "info").mockImplementation(() => {});
		const originalText = "/mockup hero";
		const modelText = "expanded mockup instructions\n\nhero";
		const skillExpansions = [{
			name: "mockup",
			args: "hero",
			source: "built-in",
			filePath: "/skills/mockup/SKILL.md",
			range: [0, 7],
			expanded: "expanded mockup instructions",
		}];

		await h.manager.enqueuePrompt(h.session.id, originalText, { modelText, skillExpansions, source: "user" });
		const restored = h.manager.sessions.get(h.session.id);
		emitSessionEvent(restored, {
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: modelText }] },
		});

		assert.deepEqual(h.newPrompts.map((entry) => entry.text), [modelText]);
		const echo: any = restored.eventBuffer.getAll().at(-1)?.event;
		assert.equal(echo.message.content[0].text, originalText);
		assert.deepEqual(echo.message.skillExpansions, skillExpansions);
		assert.equal(restored.pendingSkillExpansions.length, 0);
	});

	it("preserves an @file mention envelope across follow-up respawn for the live echo", async () => {
		const h = harness();
		vi.spyOn(console, "info").mockImplementation(() => {});
		const originalText = "review @src/app.ts";
		const modelText = "review <file-reference path=\"src/app.ts\">export const app = true;</file-reference>";
		const fileMentions = [{
			path: "src/app.ts",
			range: [7, 18],
			kind: "text",
			content: "export const app = true;",
		}];

		await h.manager.enqueuePrompt(h.session.id, originalText, { modelText, fileMentions, source: "user" });
		const restored = h.manager.sessions.get(h.session.id);
		emitSessionEvent(restored, {
			type: "message_end",
			message: { role: "user", content: modelText },
		});

		assert.deepEqual(h.newPrompts.map((entry) => entry.text), [modelText]);
		const echo: any = restored.eventBuffer.getAll().at(-1)?.event;
		assert.equal(echo.message.content, originalText);
		assert.deepEqual(echo.message.skillExpansions, []);
		assert.deepEqual(echo.message.fileMentions, fileMentions);
		assert.equal(restored.pendingSkillExpansions.length, 0);
	});

	it("does not permit an automatic retry to start poisoned-history repair", async () => {
		const h = harness();
		await assert.rejects(
			() => h.manager.retryLastPrompt(h.session.id, { auto: true }),
			/user Retry or follow-up prompt/,
		);
		assert.equal(h.respawns(), 0);
		assert.deepEqual(h.oldPrompts, []);
		assert.deepEqual(h.newPrompts, []);
	});
});

describe("session_prompt poisoned-history follow-up", () => {
	it("routes new intent through enqueuePrompt recovery instead of returning 409 or auto-retrying the old prompt", async () => {
		const enqueuePrompt = vi.fn(async () => ({ status: "dispatched" as const }));
		const enqueuePromptForRetryRecovery = vi.fn(() => ({ status: "queued" as const, queuedId: "q1" }));
		const retryLastPrompt = vi.fn(async () => {});
		const result = await deliverSessionPrompt({
			getSession: () => ({ id: "session-fixture", status: "idle", lastTurnErrored: true }),
			enqueuePrompt,
			deliverLiveSteer: vi.fn(async () => {}),
			getErroredPromptRecoveryDecision: () => ({ recoverable: true, reason: "poisoned-history", attempts: 0, maxAttempts: 1 }),
			enqueuePromptForRetryRecovery,
			retryLastPrompt,
		}, "session-fixture", "new REST intent", { defaultMode: "prompt", source: "agent" });

		assert.equal(result.ok, true);
		assert.equal((result as any).status, "recovered");
		assert.deepEqual(enqueuePrompt.mock.calls, [["session-fixture", "new REST intent", { source: "agent" }]]);
		assert.equal(enqueuePromptForRetryRecovery.mock.calls.length, 0);
		assert.equal(retryLastPrompt.mock.calls.length, 0);
	});
});
