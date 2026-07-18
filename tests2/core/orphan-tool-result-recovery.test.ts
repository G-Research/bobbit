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

function bridge(
	prompts: Array<{ text: string; images?: unknown }>,
	rejectWith?: string,
	onPrompt?: () => void,
	rejectAsThrow = false,
): any {
	return {
		running: true,
		async stop() {},
		prompt(text: string, images?: unknown) {
			prompts.push({ text, images });
			onPrompt?.();
			if (rejectWith && rejectAsThrow) return Promise.reject(new Error(rejectWith));
			return Promise.resolve(rejectWith
				? { success: false, error: rejectWith }
				: { success: true });
		},
		onEvent() { return () => {}; },
	};
}

function harness(options?: {
	hadToolCalls?: boolean;
	queue?: string[];
	rejectRedriveWith?: string;
	rejectRedriveOnce?: boolean;
	observeTurnBeforeRedriveReject?: boolean;
	completeTurnBeforeRedriveReject?: boolean;
	terminalTurnError?: string;
	throwRedriveRejection?: boolean;
	consecutiveErrorTurns?: number;
}) {
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
		consecutiveErrorTurns: options?.consecutiveErrorTurns ?? 3,
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
	let redriveRejected = false;
	manager._respawnAgentInPlaceOwned = async (_id: string, current: any) => {
		respawns++;
		// Match the real helper's temporary SessionInfo gap and fresh SessionInfo.
		// In particular, restore does not copy process-local pending prompt envelopes.
		manager.sessions.delete(current.id);
		await Promise.resolve();
		const { pendingSkillExpansions: _discardedEnvelope, ...restoredState } = current;
		let restored: any;
		let promptCallCount = 0;
		const restoredBridge = bridge(newPrompts, options?.rejectRedriveWith, () => {
			if (options?.observeTurnBeforeRedriveReject) {
				manager.handleAgentLifecycle(restored, { type: "agent_start" });
			}
		}, options?.throwRedriveRejection);
		if (options?.rejectRedriveOnce && !options.completeTurnBeforeRedriveReject) {
			const rejectOnce = restoredBridge.prompt.bind(restoredBridge);
			restoredBridge.prompt = (text: string, images?: unknown) => {
				if (!redriveRejected) {
					redriveRejected = true;
					return rejectOnce(text, images);
				}
				newPrompts.push({ text, images });
				return Promise.resolve({ success: true });
			};
		}
		if (options?.completeTurnBeforeRedriveReject) {
			restoredBridge.prompt = (text: string, images?: unknown) => {
				newPrompts.push({ text, images });
				manager.handleAgentLifecycle(restored, { type: "agent_start" });
				manager.handleAgentLifecycle(restored, {
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "done" }],
						stopReason: options.terminalTurnError ? "error" : "stop",
						errorMessage: options.terminalTurnError,
					},
				});
				manager.handleAgentLifecycle(restored, { type: "agent_end", messages: [] });
				const call = promptCallCount++;
				if (call === 0 && options.rejectRedriveWith) {
					return options.throwRedriveRejection
						? Promise.reject(new Error(options.rejectRedriveWith))
						: Promise.resolve({ success: false, error: options.rejectRedriveWith });
				}
				return Promise.resolve({ success: true });
			};
		}
		restored = {
			...restoredState,
			status: "idle",
			dormant: false,
			lifecycleFenced: false,
			rpcClient: restoredBridge,
		};
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
		assert.equal(restored.lastPromptSource, "system");
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

	it("keeps a rejected poison follow-up front-priority, durable, and error-gated", async () => {
		const h = harness({
			queue: ["older parked intent"],
			rejectRedriveWith: "fixture canonical bridge rejected redrive",
		});
		vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const drain = vi.spyOn(h.manager, "drainQueue");

		await assert.rejects(
			() => h.manager.enqueuePrompt(h.session.id, "intent survives rejected redrive", { source: "user" }),
			/fixture canonical bridge rejected redrive/,
		);
		await new Promise((resolve) => setTimeout(resolve, 20));

		const restored = h.manager.sessions.get(h.session.id);
		const rows = restored.promptQueue.toArray();
		assert.deepEqual(rows.map((row: any) => row.text), [
			"intent survives rejected redrive",
			"older parked intent",
		]);
		assert.equal(new Set(rows.map((row: any) => row.id)).size, 2, "rejection must not duplicate either durable row");
		assert.deepEqual(h.persistedRecord.messageQueue, rows, "the exact surviving order remains durable");
		assert.equal(restored.status, "idle", "rejected canonical dispatch rolls streaming back to idle");
		assert.equal(restored.lastTurnErrored, true);
		assert.equal(restored.lastTurnErrorMessage, "fixture canonical bridge rejected redrive");
		assert.deepEqual(restored.recoveredPromptDispatchQueueIds, [rows[0].id]);
		assert.equal(drain.mock.calls.length, 0, "manual recovery gate must not drain unrelated parked work");
		assert.equal(restored.lifecycleGeneration, h.manager._currentRespawnGeneration(h.session.id));
	});

	it.each([
		{ rejection: "response" as const },
		{ rejection: "throw" as const },
	])("keeps a rollback-revive follow-up poison-owned through rejection, replacement, and unstick ($rejection)", async ({ rejection }) => {
		const h = harness({
			queue: ["older parked intent"],
			rejectRedriveWith: "fixture rollback-revive bridge rejected intent",
			rejectRedriveOnce: true,
			throwRedriveRejection: rejection === "throw",
			consecutiveErrorTurns: 1,
		});
		vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		h.session.status = "terminated";
		h.session.dormant = true;
		h.session.sessionOnlyGrantedTools = ["session-grant"];
		h.session.oneTimeGrantedTools = ["one-turn-grant"];
		const originalText = "/mockup rollback";
		const modelText = "expanded rollback recovery";
		const skillExpansions = [{
			name: "mockup",
			args: "rollback",
			source: "built-in",
			filePath: "/skills/mockup/SKILL.md",
			range: [0, 7],
			expanded: modelText,
		}];
		const images = [{ type: "image" as const, data: "fixture-image", mimeType: "image/png" }];
		const attachments = [{ name: "fixture.txt" }];
		const enqueue = vi.spyOn(h.session.promptQueue, "enqueue");

		await assert.rejects(
			() => h.manager.enqueuePrompt(h.session.id, originalText, {
				modelText,
				skillExpansions,
				images,
				attachments,
				source: "agent",
			}),
			/fixture rollback-revive bridge rejected intent/,
		);

		let restored = h.manager.sessions.get(h.session.id);
		const rejectedRows = restored.promptQueue.toArray();
		const rejectedId = rejectedRows[0].id;
		assert.equal(rejectedId, enqueue.mock.results[0]?.value.id, "rejection must retain the originally accepted queue row");
		assert.deepEqual(rejectedRows.map((row: any) => row.text), [modelText, "older parked intent"]);
		assert.deepEqual(rejectedRows[0].images, images);
		assert.deepEqual(rejectedRows[0].attachments, attachments);
		assert.deepEqual(restored.recoveredPromptDispatchQueueIds, [rejectedId]);
		assert.deepEqual(restored.poisonRecoveryPromptDispatchQueueIds, [rejectedId]);
		assert.equal(h.persistedRecord.messageQueue[0].id, rejectedId);
		assert.equal(restored.id, h.session.id);
		assert.equal(restored.modelProvider, "anthropic");
		assert.equal(restored.modelId, "claude-sonnet-4-5");
		assert.deepEqual(restored.sessionOnlyGrantedTools, ["session-grant"]);
		assert.deepEqual(restored.oneTimeGrantedTools, ["one-turn-grant"]);
		assert.equal(
			restored.pendingSkillExpansions?.some((entry: any) =>
				entry.modelText === modelText && entry.originalText === originalText
			) ?? false,
			true,
		);

		// A later lifecycle replacement must carry the exact durable acceptance row
		// and its process-local metadata onto the final canonical SessionInfo.
		await h.manager._respawnAgentInPlace(restored, h.persistedRecord, { deferQueueDrain: true });
		restored = h.manager.sessions.get(h.session.id);
		assert.equal(restored.promptQueue.toArray()[0].id, rejectedId);
		assert.deepEqual(restored.recoveredPromptDispatchQueueIds, [rejectedId]);
		assert.deepEqual(restored.poisonRecoveryPromptDispatchQueueIds, [rejectedId]);
		assert.deepEqual(restored.sessionOnlyGrantedTools, ["session-grant"]);
		assert.deepEqual(restored.oneTimeGrantedTools, ["one-turn-grant"]);
		assert.equal(
			restored.pendingSkillExpansions?.some((entry: any) =>
				entry.modelText === modelText && entry.originalText === originalText
			) ?? false,
			true,
			"replacement must preserve the rejected intent's display envelope",
		);
		assert.equal(h.persistedRecord.messageQueue[0].id, rejectedId);
		assert.equal(restored.id, h.session.id);
		assert.equal(restored.modelProvider, "anthropic");
		assert.equal(restored.modelId, "claude-sonnet-4-5");

		assert.deepEqual(
			await h.manager.enqueuePrompt(h.session.id, "later generic follow-up", { source: "user" }),
			{ status: "dispatched" },
		);
		assert.equal(restored.promptQueue.toArray()[0].id, rejectedId, "generic unstick must not supersede poison-owned work");
		assert.deepEqual(restored.recoveredPromptDispatchQueueIds, [rejectedId]);
		assert.deepEqual(restored.poisonRecoveryPromptDispatchQueueIds, [rejectedId]);

		h.manager.handleAgentLifecycle(restored, {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "later done" }], stopReason: "stop" },
		});
		h.manager.handleAgentLifecycle(restored, { type: "agent_end", messages: [] });
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.equal(h.newPrompts.length, 3);
		assert.equal(h.newPrompts[0].text, modelText);
		assert.match(h.newPrompts[1].text, /later generic follow-up$/);
		assert.equal(h.newPrompts[2].text, modelText);
		assert.deepEqual(restored.promptQueue.toArray().map((row: any) => row.text), ["older parked intent"]);
		assert.equal(restored.recoveredPromptDispatchQueueIds, undefined);
		assert.equal(restored.poisonRecoveryPromptDispatchQueueIds, undefined);

		// Completing the eventual poison turn may drain unrelated work, but must not
		// dispatch the accepted rollback intent a third time.
		h.manager.handleAgentLifecycle(restored, {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "rollback done" }], stopReason: "stop" },
		});
		h.manager.handleAgentLifecycle(restored, { type: "agent_end", messages: [] });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(h.newPrompts.filter((entry) => entry.text === modelText).length, 2);
		assert.equal(h.newPrompts.at(-1)?.text, "older parked intent");
	});

	it.each([
		{ initiator: "follow-up" as const, rejection: "response" as const },
		{ initiator: "follow-up" as const, rejection: "throw" as const },
		{ initiator: "retry" as const, rejection: "response" as const },
		{ initiator: "retry" as const, rejection: "throw" as const },
	])("keeps a rejected poison $initiator row owned across later generic unstick ($rejection)", async ({ initiator, rejection }) => {
		const h = harness({
			queue: ["older parked intent"],
			rejectRedriveWith: "fixture canonical bridge rejected redrive",
			rejectRedriveOnce: true,
			throwRedriveRejection: rejection === "throw",
			consecutiveErrorTurns: 1,
		});
		vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		h.session.sessionOnlyGrantedTools = ["session-grant"];
		h.session.oneTimeGrantedTools = ["one-turn-grant"];
		const poisonOriginalText = initiator === "follow-up" ? "/mockup poison" : "original user intent";
		const poisonModelText = initiator === "follow-up" ? "expanded poison recovery" : "original user intent";
		const poisonSkillExpansions = [{
			name: "mockup",
			args: "poison",
			source: "built-in",
			filePath: "/skills/mockup/SKILL.md",
			range: [0, 7],
			expanded: "expanded poison recovery",
		}];

		await assert.rejects(
			() => initiator === "follow-up"
				? h.manager.enqueuePrompt(h.session.id, poisonOriginalText, {
					modelText: poisonModelText,
					skillExpansions: poisonSkillExpansions,
					source: "agent",
				})
				: h.manager.retryLastPrompt(h.session.id),
			/fixture canonical bridge rejected redrive/,
		);

		const restored = h.manager.sessions.get(h.session.id);
		const rejectedRows = restored.promptQueue.toArray();
		const rejectedId = rejectedRows[0].id;
		assert.deepEqual(rejectedRows.map((row: any) => row.text), [poisonModelText, "older parked intent"]);
		assert.deepEqual(restored.recoveredPromptDispatchQueueIds, [rejectedId]);
		assert.deepEqual(restored.poisonRecoveryPromptDispatchQueueIds, [rejectedId]);
		assert.deepEqual(restored.sessionOnlyGrantedTools, ["session-grant"]);
		assert.deepEqual(restored.oneTimeGrantedTools, ["one-turn-grant"]);

		const laterText = "later generic follow-up";
		assert.deepEqual(await h.manager.enqueuePrompt(h.session.id, laterText, {
			source: "user",
		}), { status: "dispatched" });

		const afterUnstick = restored.promptQueue.toArray();
		assert.deepEqual(afterUnstick.map((row: any) => row.text), [poisonModelText, "older parked intent"]);
		assert.equal(afterUnstick[0].id, rejectedId, "generic unstick must preserve the accepted poison row identity");
		assert.deepEqual(h.persistedRecord.messageQueue, afterUnstick);
		assert.deepEqual(restored.recoveredPromptDispatchQueueIds, [rejectedId]);
		assert.deepEqual(restored.poisonRecoveryPromptDispatchQueueIds, [rejectedId]);
		assert.deepEqual(restored.sessionOnlyGrantedTools, ["session-grant"]);
		assert.deepEqual(restored.oneTimeGrantedTools, ["one-turn-grant"]);
		assert.equal(h.newPrompts.length, 2);
		assert.equal(h.newPrompts[0].text, poisonModelText);
		assert.match(h.newPrompts[1].text, /later generic follow-up$/);
		assert.equal(
			restored.pendingSkillExpansions?.some((entry: any) => entry.modelText === poisonModelText) ?? false,
			initiator === "follow-up",
			"the rejected poison envelope must remain paired with its durable row",
		);

		h.manager.handleAgentLifecycle(restored, {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "later done" }], stopReason: "stop" },
		});
		h.manager.handleAgentLifecycle(restored, { type: "agent_end", messages: [] });
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.equal(h.newPrompts.length, 3);
		assert.equal(h.newPrompts[0].text, poisonModelText);
		assert.match(h.newPrompts[1].text, /later generic follow-up$/);
		assert.equal(h.newPrompts[2].text, poisonModelText);
		assert.deepEqual(restored.promptQueue.toArray().map((row: any) => row.text), ["older parked intent"]);
		assert.equal(restored.recoveredPromptDispatchQueueIds, undefined);
		assert.equal(restored.poisonRecoveryPromptDispatchQueueIds, undefined);
		assert.deepEqual(restored.sessionOnlyGrantedTools, ["session-grant"]);
		if (initiator === "follow-up") {
			emitSessionEvent(restored, {
				type: "message_end",
				message: { role: "user", content: [{ type: "text", text: poisonModelText }] },
			});
			const poisonEcho: any = restored.eventBuffer.getAll().at(-1)?.event;
			assert.equal(poisonEcho.message.content[0].text, poisonOriginalText);
			assert.deepEqual(poisonEcho.message.skillExpansions, poisonSkillExpansions);
		}

		// A later successful boundary may drain unrelated work, but it must never
		// redispatch the already accepted poison recovery row.
		h.manager.handleAgentLifecycle(restored, {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "recovery done" }], stopReason: "stop" },
		});
		h.manager.handleAgentLifecycle(restored, { type: "agent_end", messages: [] });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(h.newPrompts.map((entry) => entry.text).filter((text) => text === poisonModelText), [
			poisonModelText,
			poisonModelText,
		]);
		assert.equal(h.newPrompts.at(-1)?.text, "older parked intent");
	});

	it("still supersedes an ordinary failed-dispatch copy during generic unstick", async () => {
		const h = harness({ consecutiveErrorTurns: 1 });
		const recovered = h.session.promptQueue.enqueueAtFront("ordinary failed dispatch");
		h.session.recoveredPromptDispatchQueueIds = [recovered.id];
		h.session.lastTurnErrorMessage = "ordinary provider failure";

		assert.deepEqual(
			await h.manager.enqueuePrompt(h.session.id, "superseding follow-up", { source: "user" }),
			{ status: "dispatched" },
		);

		assert.equal(h.oldPrompts.length, 1);
		assert.match(h.oldPrompts[0].text, /superseding follow-up$/);
		assert.equal(h.session.promptQueue.isEmpty, true);
		assert.equal(h.session.recoveredPromptDispatchQueueIds, undefined);
	});

	it("does not restore or replay a durable poison follow-up after Pi observed the turn before the RPC rejection", async () => {
		const h = harness({
			rejectRedriveWith: "Command timed out: prompt",
			observeTurnBeforeRedriveReject: true,
			throwRedriveRejection: true,
		});
		vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		assert.deepEqual(
			await h.manager.enqueuePrompt(h.session.id, "accepted exactly once", { source: "user" }),
			{ status: "dispatched" },
		);

		const restored = h.manager.sessions.get(h.session.id);
		assert.equal(restored.agentObservedTurnVersion, 1);
		assert.equal(restored.promptQueue.isEmpty, true);
		assert.equal(restored.recoveredPromptDispatchQueueIds, undefined);
		assert.equal(restored.lastTurnErrored, false);
		assert.deepEqual(h.newPrompts.map((entry) => entry.text), ["accepted exactly once"]);

		// A later successful turn boundary must not find a restored durable row and
		// dispatch the already-accepted follow-up (including its tool effects) twice.
		h.manager.handleAgentLifecycle(restored, { type: "agent_end", messages: [] });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(h.newPrompts.map((entry) => entry.text), ["accepted exactly once"]);
	});

	it("processes a complete poison-redrive turn before RPC rejection without stranding or duplicating queued prompts", async () => {
		const h = harness({
			queue: ["queued behind accepted redrive"],
			rejectRedriveWith: "Command timed out: prompt",
			completeTurnBeforeRedriveReject: true,
			throwRedriveRejection: true,
		});
		vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		assert.deepEqual(
			await h.manager.enqueuePrompt(h.session.id, "accepted exactly once", { source: "user" }),
			{ status: "dispatched" },
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const restored = h.manager.sessions.get(h.session.id);
		assert.equal(restored.status, "idle", "pre-ack terminal lifecycle must settle the canonical session");
		assert.equal(restored.lastTurnErrored, false);
		assert.equal(restored.promptQueue.isEmpty, true, "coordinator release must drain the remaining queued prompt");
		assert.equal(restored.recoveredPromptDispatchQueueIds, undefined);
		assert.deepEqual(h.newPrompts.map((entry) => entry.text), [
			"accepted exactly once",
			"queued behind accepted redrive",
		]);
		assert.equal(restored.completedTurnCount, 2);
	});

	it("preserves a terminal model error that arrives before the poison-redrive RPC rejection", async () => {
		const h = harness({
			rejectRedriveWith: "Command timed out: prompt",
			completeTurnBeforeRedriveReject: true,
			terminalTurnError: "terminal provider failure",
			throwRedriveRejection: true,
		});
		vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		assert.deepEqual(
			await h.manager.enqueuePrompt(h.session.id, "accepted errored turn", { source: "user" }),
			{ status: "dispatched" },
		);

		const restored = h.manager.sessions.get(h.session.id);
		assert.equal(restored.status, "idle");
		assert.equal(restored.lastTurnErrored, true);
		assert.equal(restored.lastTurnErrorMessage, "terminal provider failure");
		assert.equal(restored.completedTurnCount, 1);
		assert.equal(restored.promptQueue.isEmpty, true);
		assert.deepEqual(h.newPrompts.map((entry) => entry.text), ["accepted errored turn"]);
	});

	it("uses a unique durable Retry row and preserves an independently queued identical prompt", async () => {
		const h = harness({ queue: ["original user intent"] });
		vi.spyOn(console, "info").mockImplementation(() => {});
		const independent = h.session.promptQueue.toArray()[0];

		await h.manager.retryLastPrompt(h.session.id);

		assert.deepEqual(h.newPrompts.map((entry) => entry.text), ["original user intent"]);
		const restored = h.manager.sessions.get(h.session.id);
		const rows = restored.promptQueue.toArray();
		assert.deepEqual(rows.map((row: any) => row.text), ["original user intent"]);
		assert.equal(rows[0].id, independent.id, "Retry must consume only its new row identity");
		assert.deepEqual(h.persistedRecord.messageQueue, rows);
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

	it("reports queued after parking behind a failed shared recovery and drains that accepted envelope once", async () => {
		const h = harness();
		const failedRecovery = Promise.reject(new Error("fixture shared recovery failed"));
		h.manager._poisonedHistoryRecoveries.set(h.session.id, failedRecovery);
		const skillExpansions = [{
			name: "mockup",
			args: "hero",
			source: "built-in",
			filePath: "/skills/mockup/SKILL.md",
			range: [0, 7],
			expanded: "expanded mockup instructions",
		}];

		const result = await h.manager.enqueuePrompt(h.session.id, "/mockup hero", {
			modelText: "expanded mockup instructions\n\nhero",
			skillExpansions,
			images: [{ type: "image", data: "fixture-image", mimeType: "image/png" }],
			attachments: [{ name: "fixture.txt" }],
			source: "agent",
		});

		assert.deepEqual(result, { status: "queued" }, "durably accepted intent must not reject and invite caller resubmission");
		const rollback = h.manager.sessions.get(h.session.id);
		const queued = rollback.promptQueue.toArray();
		assert.equal(queued.length, 1);
		assert.equal(queued[0].text, "expanded mockup instructions\n\nhero");
		assert.deepEqual(queued[0].images, [{ type: "image", data: "fixture-image", mimeType: "image/png" }]);
		assert.deepEqual(queued[0].attachments, [{ name: "fixture.txt" }]);
		assert.equal(h.persistedRecord.messageQueue[0].id, queued[0].id, "durable parking must preserve the queue row identity");
		assert.deepEqual(rollback.pendingSkillExpansions, [{
			modelText: "expanded mockup instructions\n\nhero",
			originalText: "/mockup hero",
			skillExpansions,
		}]);
		assert.equal(rollback.lastPromptSource, "agent");

		// The queued result is the acceptance contract: the caller does not resubmit.
		// Once recovery gating clears, the one durable row must drain exactly once.
		h.manager._poisonedHistoryRecoveries.delete(h.session.id);
		rollback.lastTurnErrored = false;
		h.manager.drainQueue(rollback);
		await new Promise((resolve) => setTimeout(resolve, 0));
		h.manager.drainQueue(rollback);
		assert.deepEqual(h.oldPrompts.map((entry) => entry.text), ["expanded mockup instructions\n\nhero"]);
		assert.equal(rollback.promptQueue.isEmpty, true);
		assert.deepEqual(h.persistedRecord.messageQueue, []);
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
		const enqueuePrompt = vi.fn(async () => ({ status: "queued" as const }));
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
		assert.equal((result as any).recovery.queued, true, "session_prompt must report the durable queued acceptance truthfully");
		assert.deepEqual(enqueuePrompt.mock.calls, [["session-fixture", "new REST intent", { source: "agent" }]]);
		assert.equal(enqueuePromptForRetryRecovery.mock.calls.length, 0);
		assert.equal(retryLastPrompt.mock.calls.length, 0);
	});
});
