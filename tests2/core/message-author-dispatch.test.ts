import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import {
	initAuthorSidecarDir,
	promptAuthorBindingMatchesText,
	readAuthorSidecar,
} from "../../src/server/agent/author-sidecar.ts";
import { EventBuffer } from "../../src/server/agent/event-buffer.ts";
import { BOBBIT_SYSTEM_AUTHOR } from "../../src/server/agent/message-author.ts";
import { PromptQueue } from "../../src/server/agent/prompt-queue.ts";
import {
	SessionManager,
	dispatchTrackedPrompt,
	prepareVisibleAgentEvent,
	projectPromptAuthorMessagesForTitle,
	restorePromptAuthorBindings,
} from "../../src/server/agent/session-manager.ts";
import {
	cancelPendingSessionPromptActivity,
	installSessionActivityAttribution,
	recordSessionEventActivity,
} from "../../src/server/agent/session-activity.ts";
import { LOCAL_USER_AUTHOR, type MessageAuthor } from "../../src/shared/message-author.ts";

const AGENT_AUTHOR: MessageAuthor = {
	kind: "agent",
	id: "session:1ae73f53-dc48",
	label: "  Test\n Coordinator ",
};
const AGENT_PREFIX = "[Test Coordinator (1ae73f)]: ";

let stateDir = "";
let secretsDir = "";
let sequence = 0;

beforeEach(() => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "message-author-dispatch-"));
	secretsDir = path.join(stateDir, "private-secrets");
	initAuthorSidecarDir(stateDir, {
		secretsDir,
		hmacKey: Buffer.alloc(32, 0x45),
	});
});

afterEach(() => {
	fs.rmSync(stateDir, { recursive: true, force: true });
});

function session(id: string, rpcClient: Record<string, unknown> = {}): any {
	return {
		id,
		title: "Dispatch agent",
		status: "idle",
		statusVersion: 0,
		clients: new Set(),
		promptQueue: new PromptQueue(),
		eventBuffer: new EventBuffer(),
		rpcClient,
	};
}

function manager(): any {
	const value: any = Object.create(SessionManager.prototype);
	value.clock = {
		now: () => 1_700_000_000_000 + sequence++,
		setTimeout: (callback: () => void) => {
			callback();
			return 0;
		},
	};
	value.broadcastQueue = vi.fn();
	value.tryGenerateTitleFromPrompt = vi.fn();
	value.markPromptDispatchStreaming = vi.fn((target: any) => { target.status = "streaming"; });
	value._sessionWriterIsCurrent = vi.fn(() => true);
	value.clearRecoveredPromptDispatchOwnership = vi.fn();
	value.recoverPromptDispatch = vi.fn();
	value.resolveStoreForSession = vi.fn(() => ({
		get: vi.fn(() => undefined),
		update: vi.fn(),
	}));
	return value;
}

async function flushMicrotasks(): Promise<void> {
	for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("message author dispatch boundary", () => {
	it("writes exact sidecar bindings before all four RPC sites while durable text stays unprefixed", async () => {
		const trackedCalls: string[] = [];
		const tracked = session("dispatch-tracked", {
			prompt: vi.fn(async (text: string) => {
				const [binding] = readAuthorSidecar("dispatch-tracked");
				assert.ok(binding, "binding exists before the provider RPC");
				assert.equal(binding.modelPrefix, "[System]: ");
				assert.equal(promptAuthorBindingMatchesText(binding, text), true);
				trackedCalls.push(text);
				return { success: true };
			}),
		});
		await dispatchTrackedPrompt(tracked, "tracked base", {
			source: "system",
			author: BOBBIT_SYSTEM_AUTHOR,
			now: () => 100,
		});
		assert.deepEqual(trackedCalls, ["[System]: tracked base"]);

		const value = manager();
		const directCalls: string[] = [];
		const direct = session("dispatch-direct", {
			prompt: vi.fn(async (text: string) => {
				directCalls.push(text);
				return { success: true };
			}),
		});
		await value.dispatchDirectPrompt(
			direct,
			"direct base",
			undefined,
			undefined,
			false,
			false,
			"agent",
			AGENT_AUTHOR,
		);
		assert.deepEqual(directCalls, [`${AGENT_PREFIX}direct base`]);
		assert.equal(direct.lastPromptText, "direct base");

		const steerCalls: string[] = [];
		const steer = session("dispatch-steer", {
			steer: vi.fn(async (text: string) => {
				steerCalls.push(text);
				return { success: true };
			}),
		});
		const humanSteer = steer.promptQueue.enqueue("human segment", {
			isSteered: true,
			source: "user",
			author: LOCAL_USER_AUTHOR,
		});
		const agentSteer = steer.promptQueue.enqueue("agent segment", {
			isSteered: true,
			source: "agent",
			author: AGENT_AUTHOR,
		});
		await value._dispatchSteer(steer, [humanSteer, agentSteer]);
		assert.deepEqual(steerCalls, ["[System]: human segment\nagent segment"]);
		assert.equal(steer.inFlightSteerTexts[0].text, "human segment\nagent segment");
		assert.equal(steer.inFlightSteerTexts[0].author.id, "system:bobbit:batch");

		const drainCalls: string[] = [];
		const queued = session("dispatch-drain", {
			prompt: vi.fn(async (text: string) => {
				drainCalls.push(text);
				return { success: true };
			}),
		});
		queued.promptQueue.enqueue("queued human base", {
			suppressTitleGen: true,
			source: "user",
			author: LOCAL_USER_AUTHOR,
		});
		value.drainQueue(queued);
		await flushMicrotasks();
		assert.deepEqual(drainCalls, ["queued human base"]);
		assert.equal(queued.lastPromptText, "queued human base");
	});

	it("prefixes steer batches once and never promotes an all-user batch to System", async () => {
		const value = manager();
		const run = async (
			id: string,
			rows: Array<{ text: string; source: "user" | "agent" | "system"; author: MessageAuthor }>,
		): Promise<{ text: string; ledger: any }> => {
			let text = "";
			const target = session(id, {
				steer: vi.fn(async (value: string) => {
					text = value;
					return { success: true };
				}),
			});
			const queued = rows.map((row) => target.promptQueue.enqueue(row.text, {
				isSteered: true,
				source: row.source,
				author: row.author,
			}));
			await value._dispatchSteer(target, queued);
			return { text, ledger: target.inFlightSteerTexts[0] };
		};

		const sameAgent = await run("batch-agent", [
			{ text: "one", source: "agent", author: AGENT_AUTHOR },
			{ text: "two", source: "agent", author: AGENT_AUTHOR },
		]);
		assert.equal(sameAgent.text, `${AGENT_PREFIX}one\ntwo`);
		assert.equal(sameAgent.text.indexOf(AGENT_PREFIX), 0);
		assert.equal(sameAgent.text.lastIndexOf(AGENT_PREFIX), 0);
		assert.equal(sameAgent.ledger.text, "one\ntwo");

		const secondUser: MessageAuthor = { kind: "user", id: "user:synthetic-two", label: "Second" };
		const allUsers = await run("batch-users", [
			{ text: "first", source: "user", author: LOCAL_USER_AUTHOR },
			{ text: "second", source: "user", author: secondUser },
		]);
		assert.equal(allUsers.text, "first\nsecond");
		assert.equal(allUsers.ledger.author.id, LOCAL_USER_AUTHOR.id);

		const mixed = await run("batch-mixed", [
			{ text: "first", source: "user", author: LOCAL_USER_AUTHOR },
			{ text: "second", source: "agent", author: AGENT_AUTHOR },
		]);
		assert.equal(mixed.text, "[System]: first\nsecond");
		assert.equal(mixed.ledger.text, "first\nsecond");
	});

	it("sends base text when write-before-prefix persistence fails", async () => {
		const ledgerDir = path.join(secretsDir, "author-sidecar");
		const movedLedgerDir = path.join(secretsDir, "author-sidecar-moved");
		fs.renameSync(ledgerDir, movedLedgerDir);
		fs.writeFileSync(ledgerDir, "blocks directory recreation", "utf8");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const calls: string[] = [];
		const target = session("dispatch-degraded", {
			prompt: vi.fn(async (text: string) => {
				calls.push(text);
				return { success: true };
			}),
		});
		try {
			await dispatchTrackedPrompt(target, "safe base", {
				source: "system",
				author: BOBBIT_SYSTEM_AUTHOR,
				now: () => 200,
			});
		} finally {
			warn.mockRestore();
			fs.unlinkSync(ledgerDir);
			fs.renameSync(movedLedgerDir, ledgerDir);
		}

		assert.deepEqual(calls, ["safe base"]);
		assert.equal(target.pendingPromptAuthors[0].modelText, "safe base");
		assert.equal(target.pendingPromptAuthors[0].modelPrefix, undefined);
		assert.deepEqual(readAuthorSidecar(target.id), []);
	});

	it.each(["negative", "throw"] as const)(
		"makes a stale %s callback inert after a same-row redrain",
		async (failure) => {
			const value = manager();
			const oldResponse = deferred<any>();
			const replacementResponse = deferred<any>();
			const prompt = vi.fn()
				.mockImplementationOnce(() => oldResponse.promise)
				.mockImplementationOnce(() => replacementResponse.promise);
			const target = session(`dispatch-attempt-${failure}`, { prompt });
			target.lastActivity = 100;
			installSessionActivityAttribution(target, {
				get: () => ({ lastReadAt: 100 }),
				update: vi.fn(),
			}, { now: () => 101, suppressUntilPrompt: true });
			const durable = target.promptQueue.enqueue("same durable row", { suppressTitleGen: true });

			const oldDispatch = value.dispatchDirectPrompt(
				target,
				durable.text,
				undefined,
				undefined,
				false,
				false,
				"user",
				LOCAL_USER_AUTHOR,
				durable.id,
			);
			await flushMicrotasks();
			const oldPreparedRecord = target.pendingPromptAuthors[0];
			cancelPendingSessionPromptActivity(target);
			assert.equal(
				value.cancelRestoredPromptAuthorDispatch(target, oldPreparedRecord.promptId),
				true,
			);
			target.status = "idle";
			value.drainQueue(target);
			await flushMicrotasks();
			assert.equal(prompt.mock.calls.length, 2);
			const replacementRecord = target.pendingPromptAuthors[0];
			assert.equal(replacementRecord.promptId, durable.id);
			assert.notEqual(replacementRecord.attemptId, oldPreparedRecord.attemptId);

			if (failure === "negative") oldResponse.resolve({ success: false, error: "old rejected" });
			else oldResponse.reject(new Error("old transport failure"));
			await oldDispatch;
			await flushMicrotasks();

			assert.equal(target.pendingPromptAuthors[0], replacementRecord);
			assert.equal(target.promptQueue.length, 0, "old callback must not duplicate the durable row");
			assert.equal(value.recoverPromptDispatch.mock.calls.length, 0);

			replacementResponse.resolve({ success: true });
			await flushMicrotasks();
			assert.equal(target.lastActivity, 101);
			assert.equal(target.promptQueue.length, 0);
		},
	);

	it("does not let a late cancelled same-text message id settle a new attempt", async () => {
		const target = session("dispatch-late-predecessor");
		const author = { kind: "system", id: "system:bobbit", label: "Bobbit" } as const;
		restorePromptAuthorBindings(target, [{
			schemaVersion: 1,
			type: "prompt-author",
			promptId: "old-attempt",
			dispatchedAt: 1,
			modelText: "[System]: same bytes",
			source: "system",
			author,
			settlement: {
				schemaVersion: 1,
				type: "prompt-author-settlement",
				promptId: "old-attempt",
				settledAt: 2,
				outcome: "cancelled",
			},
		}]);
		const pendingResponse = deferred<any>();
		target.rpcClient = { prompt: vi.fn(() => pendingResponse.promise) };
		const dispatch = dispatchTrackedPrompt(target, "same bytes", {
			source: "system",
			author,
			now: () => 3,
		});
		await flushMicrotasks();
		const current = target.pendingPromptAuthors[0];

		prepareVisibleAgentEvent(target, {
			type: "message_end",
			message: { id: "historical-pi-id", role: "user", content: "[System]: same bytes" },
		});

		assert.equal(target.pendingPromptAuthors[0], current);
		assert.equal(readAuthorSidecar(target.id).find((row) => row.promptId === current.promptId)?.settlement, undefined);
		pendingResponse.resolve({ success: false, error: "current rejected" });
		await assert.rejects(dispatch, /current rejected/);
		assert.equal(target.pendingPromptAuthors.length, 0);
		assert.equal(
			readAuthorSidecar(target.id).find((row) => row.promptId === current.promptId)?.settlement?.outcome,
			"cancelled",
		);
	});

	it("projects an RPC-accepted same-text attempt ahead of its cancelled predecessor", async () => {
		const target = session("dispatch-accepted-after-predecessor");
		const author = { kind: "system", id: "system:bobbit", label: "Bobbit" } as const;
		restorePromptAuthorBindings(target, [{
			schemaVersion: 1,
			type: "prompt-author",
			promptId: "old-attempt",
			dispatchedAt: 1,
			modelText: "[System]: same bytes",
			source: "system",
			author,
			settlement: {
				schemaVersion: 1,
				type: "prompt-author-settlement",
				promptId: "old-attempt",
				settledAt: 2,
				outcome: "cancelled",
			},
		}]);
		target.rpcClient = { prompt: vi.fn(async () => ({ success: true })) };
		await dispatchTrackedPrompt(target, "same bytes", {
			source: "system",
			author,
			now: () => 3,
		});
		const current = target.pendingPromptAuthors[0];

		const visible = prepareVisibleAgentEvent(target, {
			type: "message_end",
			message: { id: "current-pi-id", role: "user", content: "[System]: same bytes" },
		}) as any;

		assert.equal(visible.message.content, "same bytes");
		assert.equal(visible.message.author.id, author.id);
		assert.equal(target.pendingPromptAuthors.length, 0);
		assert.equal(
			readAuthorSidecar(target.id).find((row) => row.promptId === current.promptId)?.settlement?.outcome,
			"echoed",
		);
		assert.equal(target.promptAuthorAmbiguityFences.bindings[0].promptId, "old-attempt");
	});

	it("bounds rejected prompt tombstones without retaining raw payloads", async () => {
		const target = session("dispatch-bounded-tombstones", {
			prompt: vi.fn(async () => ({ success: false, error: "rejected" })),
			steer: vi.fn(async () => ({ success: false, error: "steer rejected" })),
		});
		target.promptAuthorTombstoneBudget = { maxCount: 2, maxBytes: 1024 };
		const largePayload = "large rejected payload ".repeat(400_000);
		for (const text of [largePayload, "rejected two", "rejected three", "rejected four"]) {
			await assert.rejects(dispatchTrackedPrompt(target, text), /rejected/);
		}
		const value = manager();
		target.status = "streaming";
		for (const text of ["steer rejected payload one", "steer rejected payload two"]) {
			const row = target.promptQueue.enqueue(text, { isSteered: true });
			await assert.rejects(value._dispatchSteer(target, [row]), /steer rejected/);
		}

		const owner = target.promptAuthorAmbiguityFences;
		assert.equal(owner.bindings.length, 2);
		assert.equal(owner.overflowed, true);
		assert.ok(owner.residentBytes <= 1024);
		assert.equal(owner.bindings.some((binding: any) => "modelText" in binding), false);
		assert.equal(JSON.stringify(owner).includes("large rejected payload"), false);
		assert.equal(JSON.stringify(owner).includes("steer rejected payload"), false);
		assert.equal(target.pendingPromptAuthors.length, 0);
	});

	it("applies the same digest-only tombstone bound while restoring cancelled sidecars", () => {
		const target = session("restore-bounded-tombstones");
		target.promptAuthorTombstoneBudget = { maxCount: 2, maxBytes: 1024 };
		const author = { kind: "system", id: "system:bobbit", label: "Bobbit" } as const;
		restorePromptAuthorBindings(target, Array.from({ length: 5 }, (_, index) => ({
			schemaVersion: 1 as const,
			type: "prompt-author" as const,
			promptId: `cancelled-${index}`,
			dispatchedAt: index,
			modelText: `restored secret ${index}`,
			source: "system" as const,
			author,
			settlement: {
				schemaVersion: 1 as const,
				type: "prompt-author-settlement" as const,
				promptId: `cancelled-${index}`,
				settledAt: index + 1,
				outcome: "cancelled" as const,
			},
		})));

		const owner = target.promptAuthorAmbiguityFences;
		assert.equal(owner.bindings.length, 2);
		assert.equal(owner.overflowed, true);
		assert.ok(owner.residentBytes <= 1024);
		assert.equal(owner.bindings.some((binding: any) => "modelText" in binding), false);
		assert.equal(JSON.stringify(owner).includes("restored secret"), false);

		const byteLimited = session("restore-byte-bounded-tombstones");
		byteLimited.promptAuthorTombstoneBudget = { maxCount: 100, maxBytes: 1 };
		restorePromptAuthorBindings(byteLimited, [{
			schemaVersion: 1,
			type: "prompt-author",
			promptId: "too-large-for-byte-budget",
			dispatchedAt: 1,
			modelText: "byte bounded restored secret",
			source: "system",
			author,
			settlement: {
				schemaVersion: 1,
				type: "prompt-author-settlement",
				promptId: "too-large-for-byte-budget",
				settledAt: 2,
				outcome: "cancelled",
			},
		}]);
		assert.equal(byteLimited.promptAuthorAmbiguityFences.bindings.length, 0);
		assert.equal(byteLimited.promptAuthorAmbiguityFences.residentBytes, 0);
		assert.equal(byteLimited.promptAuthorAmbiguityFences.overflowed, true);
	});

	it("uses the shared bounded digest owner for settled keyless restore ambiguity only", () => {
		const target = session("restore-settled-keyless-fences");
		target.promptAuthorTombstoneBudget = { maxCount: 2, maxBytes: 1024 };
		const author = { kind: "user", id: "user:local", label: "User" } as const;
		const echoed = (promptId: string, modelText: string, messageId?: string) => ({
			schemaVersion: 1 as const,
			type: "prompt-author" as const,
			promptId,
			dispatchedAt: 1,
			modelText,
			source: "user" as const,
			author,
			settlement: {
				schemaVersion: 1 as const,
				type: "prompt-author-settlement" as const,
				promptId,
				settledAt: 2,
				outcome: "echoed" as const,
				...(messageId ? { messageId } : {}),
			},
		});
		restorePromptAuthorBindings(target, [
			echoed("keyless-1", "settled secret one"),
			echoed("keyless-2", "settled secret two"),
			echoed("keyless-dropped", "settled secret three"),
			echoed("stable-id", "known stable bytes", "pi-stable-id"),
		]);

		const owner = target.promptAuthorAmbiguityFences;
		assert.deepEqual(owner.bindings.map((binding: any) => binding.promptId), ["keyless-1", "keyless-2"]);
		assert.equal(owner.overflowed, true);
		assert.ok(owner.residentBytes <= 1024);
		assert.equal(owner.bindings.some((binding: any) => "modelText" in binding), false);
		assert.equal(JSON.stringify(owner).includes("settled secret"), false);
		assert.equal(target.promptAuthorMessageBindings.get("id:pi-stable-id")?.promptId, "stable-id");
		assert.equal(owner.bindings.some((binding: any) => binding.promptId === "stable-id"), false);

		// Rehydration is the common restore/replacement owner. It preserves the
		// sticky overflow fence even when the next sidecar snapshot is fully keyed.
		restorePromptAuthorBindings(target, [echoed("stable-id", "known stable bytes", "pi-stable-id")]);
		assert.equal(target.promptAuthorAmbiguityFences.overflowed, true);
	});

	it("keeps a same-text queued retry pending behind a settled keyless fence", async () => {
		const value = manager();
		const response = deferred<any>();
		const target = session("dispatch-queued-settled-keyless", {
			prompt: vi.fn(() => response.promise),
		});
		target.lastActivity = 450;
		const writes: number[] = [];
		installSessionActivityAttribution(target, {
			get: () => ({ lastActivity: 450, lastReadAt: 450 }),
			update: (_id: string, patch: any) => writes.push(patch.lastActivity),
		}, { now: () => 451, suppressUntilPrompt: true });
		restorePromptAuthorBindings(target, [{
			schemaVersion: 1,
			type: "prompt-author",
			promptId: "settled-keyless-predecessor",
			dispatchedAt: 1,
			modelText: "same queued bytes",
			source: "user",
			author: LOCAL_USER_AUTHOR,
			settlement: {
				schemaVersion: 1,
				type: "prompt-author-settlement",
				promptId: "settled-keyless-predecessor",
				settledAt: 2,
				outcome: "echoed",
			},
		}]);
		target.promptAuthorReplayBindings = undefined;
		target.lastKeylessPromptAuthorEnd = undefined;
		target.promptQueue.enqueue("same queued bytes", { source: "user", author: LOCAL_USER_AUTHOR });

		value.drainQueue(target);
		await flushMicrotasks();
		const current = target.pendingPromptAuthors[0];
		const update = prepareVisibleAgentEvent(target, {
			type: "message_update",
			message: { role: "user", content: "same queued bytes" },
		});
		recordSessionEventActivity(target, update);
		assert.equal(target.pendingPromptAuthors[0], current, "an update cannot settle either occurrence");
		assert.equal(readAuthorSidecar(target.id).find((row) => row.promptId === current.promptId)?.settlement, undefined);
		const end = prepareVisibleAgentEvent(target, {
			type: "message_end",
			message: { role: "user", content: "same queued bytes" },
		});
		recordSessionEventActivity(target, end);
		assert.equal(target.pendingPromptAuthors[0], current);
		assert.equal(target.lastActivity, 450);
		response.resolve({ success: false, error: "queued rejection" });
		await flushMicrotasks();

		assert.equal(target.lastActivity, 450);
		assert.deepEqual(writes, []);
		assert.equal(value.recoverPromptDispatch.mock.calls.length, 1);
		assert.equal(value.recoverPromptDispatch.mock.calls[0][1].length, 1);
		assert.equal(target.pendingPromptAuthors.length, 0);
	});

	it("fails closed after tombstone overflow but lets a positive ack finalize buffered projection", async () => {
		const target = session("dispatch-overflow-positive");
		target.lastActivity = 500;
		const persisted = { lastActivity: 500, lastReadAt: 500 };
		installSessionActivityAttribution(target, {
			get: () => persisted,
			update: (_id: string, patch: any) => { persisted.lastActivity = patch.lastActivity; },
		}, { now: () => 501, suppressUntilPrompt: true });
		target.promptAuthorTombstoneBudget = { maxCount: 1, maxBytes: 1024 };
		const author = { kind: "system", id: "system:bobbit", label: "Bobbit" } as const;
		const cancelled = (promptId: string, modelText: string) => ({
			schemaVersion: 1 as const,
			type: "prompt-author" as const,
			promptId,
			dispatchedAt: 1,
			modelText,
			source: "system" as const,
			author,
			settlement: {
				schemaVersion: 1 as const,
				type: "prompt-author-settlement" as const,
				promptId,
				settledAt: 2,
				outcome: "cancelled" as const,
			},
		});
		restorePromptAuthorBindings(target, [
			cancelled("retained", "[System]: other text"),
			cancelled("dropped", "[System]: same bytes"),
		]);
		const response = deferred<any>();
		target.rpcClient = { prompt: vi.fn(() => response.promise) };
		const dispatch = dispatchTrackedPrompt(target, "same bytes", { source: "system", author, now: () => 3 });
		await flushMicrotasks();

		const visible = prepareVisibleAgentEvent(target, {
			type: "message_end",
			message: { role: "user", content: "[System]: same bytes" },
		}) as any;
		assert.equal(visible.message.content, "same bytes");
		assert.equal(target.lastActivity, 500, "ambiguous echo cannot commit before acknowledgement");
		assert.equal(target.pendingPromptAuthors.length, 1);

		response.resolve({ success: true });
		await dispatch;
		assert.equal(target.lastActivity, 501);
		assert.equal(persisted.lastActivity, 501);
		assert.equal(target.pendingPromptAuthors.length, 0);
		assert.equal(readAuthorSidecar(target.id).at(-1)?.settlement?.outcome, "echoed");
	});

	it("keeps overflowed historical echo plus current rejection quarantined and recoverable once", async () => {
		const value = manager();
		const response = deferred<any>();
		const target = session("dispatch-overflow-negative", { prompt: vi.fn(() => response.promise) });
		target.lastActivity = 700;
		const writes: number[] = [];
		installSessionActivityAttribution(target, {
			get: () => ({ lastActivity: 700, lastReadAt: 700 }),
			update: (_id: string, patch: any) => writes.push(patch.lastActivity),
		}, { now: () => 701, suppressUntilPrompt: true });
		target.promptAuthorTombstoneBudget = { maxCount: 0, maxBytes: 0 };
		const author = { kind: "system", id: "system:bobbit", label: "Bobbit" } as const;
		restorePromptAuthorBindings(target, [{
			schemaVersion: 1,
			type: "prompt-author",
			promptId: "dropped-historical",
			dispatchedAt: 1,
			modelText: "same bytes",
			source: "system",
			author,
			settlement: {
				schemaVersion: 1,
				type: "prompt-author-settlement",
				promptId: "dropped-historical",
				settledAt: 2,
				outcome: "cancelled",
			},
		}]);
		const dispatch = value.dispatchDirectPrompt(
			target, "same bytes", undefined, undefined, false, false, "system", author,
		);
		await flushMicrotasks();
		prepareVisibleAgentEvent(target, {
			type: "message_end",
			message: { role: "user", content: "same bytes" },
		});
		assert.equal(target.lastActivity, 700);

		response.resolve({ success: false, error: "current rejected" });
		await assert.rejects(dispatch, /current rejected/);
		assert.equal(target.lastActivity, 700);
		assert.deepEqual(writes, []);
		assert.equal(value.recoverPromptDispatch.mock.calls.length, 1);
		assert.equal(value.recoverPromptDispatch.mock.calls[0][1].length, 1);
		assert.equal(target.pendingPromptAuthors.length, 0);
	});

	it.each([
		{ correlation: "keyed", failure: "negative" },
		{ correlation: "keyed", failure: "throw" },
		{ correlation: "keyless", failure: "negative" },
		{ correlation: "keyless", failure: "throw" },
	] as const)(
		"keeps an unambiguous $correlation message_update cancellable before a $failure direct acknowledgement",
		async ({ correlation, failure }) => {
			const value = manager();
			const response = deferred<any>();
			const target = session(`dispatch-update-${correlation}-${failure}`, {
				prompt: vi.fn(() => response.promise),
			});
			target.lastActivity = 750;
			const persisted = { lastActivity: 750, lastReadAt: 750 };
			const writes: number[] = [];
			installSessionActivityAttribution(target, {
				get: () => persisted,
				update: (_id: string, patch: any) => {
					persisted.lastActivity = patch.lastActivity;
					writes.push(patch.lastActivity);
				},
			}, { now: () => 751, suppressUntilPrompt: true });
			const author = { kind: "system", id: "system:bobbit", label: "Bobbit" } as const;
			const dispatch = value.dispatchDirectPrompt(
				target, "current update", undefined, undefined, false, false, "system", author,
			);
			await flushMicrotasks();
			const current = target.pendingPromptAuthors[0];
			const messageId = correlation === "keyed" ? "current-update-id" : undefined;
			const update = prepareVisibleAgentEvent(target, {
				type: "message_update",
				message: { ...(messageId ? { id: messageId } : {}), role: "user", content: "[System]: current update" },
			}) as any;
			recordSessionEventActivity(target, update);
			assert.equal(update.message.content, "current update");
			assert.equal(update.message.author.id, author.id);
			assert.equal(target.pendingPromptAuthors[0], current);
			assert.equal(target.lastActivity, 750);
			assert.deepEqual(writes, []);

			if (failure === "negative") response.resolve({ success: false, error: "current rejected" });
			else response.reject(new Error("current transport failure"));
			await assert.rejects(dispatch, /current (rejected|transport failure)/);

			const laterReplay = prepareVisibleAgentEvent(target, {
				type: "message_end",
				message: { id: "later-replay", role: "assistant", content: "restored output" },
			});
			recordSessionEventActivity(target, laterReplay);
			assert.equal(target.lastActivity, 750);
			assert.equal(persisted.lastActivity, 750);
			assert.deepEqual(writes, []);
			assert.equal(value.recoverPromptDispatch.mock.calls.length, 1);
			assert.equal(value.recoverPromptDispatch.mock.calls[0][1][0].text, "current update");
			assert.equal(target.pendingPromptAuthors.length, 0);
			assert.equal(
				readAuthorSidecar(target.id).find((row) => row.promptId === current.promptId)?.settlement?.outcome,
				"cancelled",
			);
			if (messageId) assert.equal(target.promptAuthorMessageBindings?.has(`id:${messageId}`), false);
		},
	);

	it.each(["keyed", "keyless"] as const)(
		"commits an unambiguous %s message_update projection only after a positive acknowledgement",
		async (correlation) => {
			const response = deferred<any>();
			const target = session(`dispatch-update-positive-${correlation}`, {
				prompt: vi.fn(() => response.promise),
			});
			target.lastActivity = 775;
			const writes: number[] = [];
			installSessionActivityAttribution(target, {
				get: () => ({ lastActivity: 775, lastReadAt: 775 }),
				update: (_id: string, patch: any) => writes.push(patch.lastActivity),
			}, { now: () => 776, suppressUntilPrompt: true });
			const author = { kind: "system", id: "system:bobbit", label: "Bobbit" } as const;
			const value = manager();
			const dispatch = value.dispatchDirectPrompt(
				target, "accepted update", undefined, undefined, false, false, "system", author,
			);
			await flushMicrotasks();
			const current = target.pendingPromptAuthors[0];
			const messageId = correlation === "keyed" ? "accepted-update-id" : undefined;
			const update = prepareVisibleAgentEvent(target, {
				type: "message_update",
				message: { ...(messageId ? { id: messageId } : {}), role: "user", content: "[System]: accepted update" },
			}) as any;
			assert.equal(update.message.content, "accepted update");
			assert.equal(update.message.author.id, author.id);
			assert.equal(target.lastActivity, 775);
			assert.deepEqual(writes, []);

			response.resolve({ success: true });
			await dispatch;
			assert.equal(target.lastActivity, 776);
			assert.deepEqual(writes, [776]);
			assert.equal(target.pendingPromptAuthors[0], current, "an update cannot settle the author occurrence");

			prepareVisibleAgentEvent(target, {
				type: "message_end",
				message: { ...(messageId ? { id: messageId } : {}), role: "user", content: "[System]: accepted update" },
			});
			assert.deepEqual(writes, [776], "the terminal echo must not recommit an acknowledged boundary");
			assert.equal(target.pendingPromptAuthors.length, 0);
			assert.equal(
				readAuthorSidecar(target.id).find((row) => row.promptId === current.promptId)?.settlement?.outcome,
				"echoed",
			);
		},
	);

	it.each([
		{ correlation: "keyed", failure: "negative" },
		{ correlation: "keyed", failure: "throw" },
		{ correlation: "keyless", failure: "negative" },
		{ correlation: "keyless", failure: "throw" },
	] as const)(
		"fails closed for an overflowed $correlation message_update before a $failure acknowledgement",
		async ({ correlation, failure }) => {
			const value = manager();
			const response = deferred<any>();
			const target = session(`dispatch-overflow-update-${correlation}-${failure}`, {
				prompt: vi.fn(() => response.promise),
			});
			target.lastActivity = 800;
			const persisted = { lastActivity: 800, lastReadAt: 800 };
			const writes: number[] = [];
			installSessionActivityAttribution(target, {
				get: () => persisted,
				update: (_id: string, patch: any) => {
					persisted.lastActivity = patch.lastActivity;
					writes.push(patch.lastActivity);
				},
			}, { now: () => 801, suppressUntilPrompt: true });
			target.promptAuthorTombstoneBudget = { maxCount: 0, maxBytes: 0 };
			const author = { kind: "system", id: "system:bobbit", label: "Bobbit" } as const;
			restorePromptAuthorBindings(target, [{
				schemaVersion: 1,
				type: "prompt-author",
				promptId: "dropped-historical-update",
				dispatchedAt: 1,
				modelText: "[System]: same bytes",
				source: "system",
				author,
				settlement: {
					schemaVersion: 1,
					type: "prompt-author-settlement",
					promptId: "dropped-historical-update",
					settledAt: 2,
					outcome: "cancelled",
				},
			}]);
			const dispatch = value.dispatchDirectPrompt(
				target, "same bytes", undefined, undefined, false, false, "system", author,
			);
			await flushMicrotasks();
			const preparedUpdate = prepareVisibleAgentEvent(target, {
				type: "message_update",
				message: {
					...(correlation === "keyed" ? { id: "historical-update-id" } : {}),
					role: "user",
					content: "[System]: same bytes",
				},
			});
			recordSessionEventActivity(target, preparedUpdate);
			assert.equal(target.lastActivity, 800);
			assert.equal(persisted.lastActivity, 800);
			assert.deepEqual(writes, []);
			assert.equal(target.pendingPromptAuthors.length, 1, "update must not settle the current attempt");

			if (failure === "negative") response.resolve({ success: false, error: "current rejected" });
			else response.reject(new Error("current transport failure"));
			await assert.rejects(dispatch, /current (rejected|transport failure)/);

			const laterReplay = prepareVisibleAgentEvent(target, {
				type: "message_end",
				message: { id: "later-replay", role: "assistant", content: "restored output" },
			});
			recordSessionEventActivity(target, laterReplay);
			assert.equal(target.lastActivity, 800);
			assert.equal(persisted.lastActivity, 800);
			assert.deepEqual(writes, []);
			assert.equal(value.recoverPromptDispatch.mock.calls.length, 1);
			assert.equal(value.recoverPromptDispatch.mock.calls[0][1].length, 1);
			assert.equal(value.recoverPromptDispatch.mock.calls[0][1][0].text, "same bytes");
			assert.equal(target.pendingPromptAuthors.length, 0);
		},
	);

	it.each(["keyed", "keyless"] as const)(
		"lets a positive acknowledgement authorize an overflowed %s message_update exactly once",
		async (correlation) => {
			const response = deferred<any>();
			const target = session(`dispatch-overflow-update-positive-${correlation}`, {
				prompt: vi.fn(() => response.promise),
			});
			target.lastActivity = 900;
			const persisted = { lastActivity: 900, lastReadAt: 900 };
			const writes: number[] = [];
			installSessionActivityAttribution(target, {
				get: () => persisted,
				update: (_id: string, patch: any) => {
					persisted.lastActivity = patch.lastActivity;
					writes.push(patch.lastActivity);
				},
			}, { now: () => 901, suppressUntilPrompt: true });
			target.promptAuthorTombstoneBudget = { maxCount: 0, maxBytes: 0 };
			const author = { kind: "system", id: "system:bobbit", label: "Bobbit" } as const;
			restorePromptAuthorBindings(target, [{
				schemaVersion: 1,
				type: "prompt-author",
				promptId: "dropped-positive-update",
				dispatchedAt: 1,
				modelText: "[System]: same bytes",
				source: "system",
				author,
				settlement: {
					schemaVersion: 1,
					type: "prompt-author-settlement",
					promptId: "dropped-positive-update",
					settledAt: 2,
					outcome: "cancelled",
				},
			}]);
			const value = manager();
			const dispatch = value.dispatchDirectPrompt(
				target, "same bytes", undefined, undefined, false, false, "system", author,
			);
			await flushMicrotasks();
			const current = target.pendingPromptAuthors[0];
			const messageId = correlation === "keyed" ? "current-update-id" : undefined;
			const preparedUpdate = prepareVisibleAgentEvent(target, {
				type: "message_update",
				message: { ...(messageId ? { id: messageId } : {}), role: "user", content: "[System]: same bytes" },
			});
			recordSessionEventActivity(target, preparedUpdate);
			assert.equal(target.lastActivity, 900);
			assert.deepEqual(writes, []);
			assert.equal(target.pendingPromptAuthors[0], current, "update must remain nonterminal");

			response.resolve({ success: true });
			await dispatch;
			assert.equal(target.lastActivity, 901);
			assert.equal(persisted.lastActivity, 901);
			assert.deepEqual(writes, [901]);
			assert.equal(target.pendingPromptAuthors[0], current);

			const visibleEnd = prepareVisibleAgentEvent(target, {
				type: "message_end",
				message: { ...(messageId ? { id: messageId } : {}), role: "user", content: "[System]: same bytes" },
			}) as any;
			assert.equal(visibleEnd.message.content, "same bytes");
			assert.equal(visibleEnd.message.author.id, author.id);
			assert.deepEqual(writes, [901], "terminal correlation must not recommit the boundary");
			assert.equal(target.pendingPromptAuthors.length, 0);
			assert.equal(
				readAuthorSidecar(target.id).find((row) => row.promptId === current.promptId)?.settlement?.outcome,
				"echoed",
			);
		},
	);

	it("settles and projects a buffered same-text echo only after the current RPC is accepted", async () => {
		const target = session("dispatch-buffered-after-predecessor");
		const author = { kind: "system", id: "system:bobbit", label: "Bobbit" } as const;
		const predecessorAuthor = { kind: "system", id: "system:predecessor", label: "Predecessor" } as const;
		restorePromptAuthorBindings(target, [{
			schemaVersion: 1,
			type: "prompt-author",
			promptId: "old-attempt",
			dispatchedAt: 1,
			modelText: "[System]: same bytes",
			source: "system",
			author: predecessorAuthor,
			settlement: {
				schemaVersion: 1,
				type: "prompt-author-settlement",
				promptId: "old-attempt",
				settledAt: 2,
				outcome: "cancelled",
			},
		}]);
		const pendingResponse = deferred<any>();
		target.rpcClient = { prompt: vi.fn(() => pendingResponse.promise) };
		const dispatch = dispatchTrackedPrompt(target, "same bytes", {
			source: "system",
			author,
			now: () => 3,
		});
		await flushMicrotasks();
		const current = target.pendingPromptAuthors[0];

		const visible = prepareVisibleAgentEvent(target, {
			type: "message_end",
			message: { id: "ambiguous-pi-id", role: "user", content: "[System]: same bytes" },
		}) as any;
		assert.equal(visible.message.content, "same bytes");
		assert.equal(visible.message.author.id, author.id, "current projection is buffered separately from attribution");
		assert.equal(target.pendingPromptAuthors[0], current, "ambiguous echo stays pending before acknowledgement");
		assert.equal(readAuthorSidecar(target.id).find((row) => row.promptId === current.promptId)?.settlement, undefined);

		pendingResponse.resolve({ success: true });
		await dispatch;
		assert.equal(target.pendingPromptAuthors.length, 0);
		assert.equal(
			readAuthorSidecar(target.id).find((row) => row.promptId === current.promptId)?.settlement?.outcome,
			"echoed",
		);
	});

	it("commits the current same-text echo once its cancelled predecessor is identified", async () => {
		const target = session("dispatch-current-after-predecessor");
		const author = { kind: "system", id: "system:bobbit", label: "Bobbit" } as const;
		restorePromptAuthorBindings(target, [{
			schemaVersion: 1,
			type: "prompt-author",
			promptId: "old-attempt",
			dispatchedAt: 1,
			modelText: "[System]: same bytes",
			source: "system",
			author,
			settlement: {
				schemaVersion: 1,
				type: "prompt-author-settlement",
				promptId: "old-attempt",
				settledAt: 2,
				outcome: "cancelled",
			},
		}]);
		const pendingResponse = deferred<any>();
		target.rpcClient = { prompt: vi.fn(() => pendingResponse.promise) };
		const dispatch = dispatchTrackedPrompt(target, "same bytes", {
			source: "system",
			author,
			now: () => 3,
		});
		await flushMicrotasks();
		const current = target.pendingPromptAuthors[0];

		prepareVisibleAgentEvent(target, {
			type: "message_end",
			message: { id: "historical-pi-id", role: "user", content: "[System]: same bytes" },
		});
		prepareVisibleAgentEvent(target, {
			type: "message_end",
			message: { id: "current-pi-id", role: "user", content: "[System]: same bytes" },
		});
		assert.equal(target.pendingPromptAuthors.length, 0, "current echo should settle the live attempt");
		pendingResponse.resolve({ success: false, error: "late negative acknowledgement" });

		await assert.doesNotReject(dispatch);
		assert.equal(target.pendingPromptAuthors.length, 0);
		assert.equal(
			readAuthorSidecar(target.id).find((row) => row.promptId === current.promptId)?.settlement?.outcome,
			"echoed",
		);
	});

	it.each([
		{ correlation: "keyed", failure: "negative" },
		{ correlation: "keyed", failure: "throw" },
		{ correlation: "keyless", failure: "negative" },
		{ correlation: "keyless", failure: "throw" },
	] as const)(
		"does not let an unsuppressed $correlation user update accept a direct $failure",
		async ({ correlation, failure }) => {
			const value = manager();
			const response = deferred<any>();
			const target = session(`dispatch-unsuppressed-${correlation}-${failure}`, {
				prompt: vi.fn(() => response.promise),
			});
			target.lastActivity = 1_100;
			const persisted = { lastActivity: 1_100, lastReadAt: 1_100 };
			const writes: number[] = [];
			installSessionActivityAttribution(target, {
				get: () => persisted,
				update: (_id: string, patch: any) => {
					persisted.lastActivity = patch.lastActivity;
					writes.push(patch.lastActivity);
				},
			}, { now: () => 1_101 });
			const dispatch = value.dispatchDirectPrompt(
				target, "unsuppressed direct", undefined, undefined, false, false, "user", LOCAL_USER_AUTHOR,
			);
			await flushMicrotasks();
			const current = target.pendingPromptAuthors[0];
			const update = prepareVisibleAgentEvent(target, {
				type: "message_update",
				message: {
					...(correlation === "keyed" ? { id: "unsuppressed-direct-id" } : {}),
					role: "user",
					content: "unsuppressed direct",
				},
			});
			assert.equal(recordSessionEventActivity(target, update), false);
			assert.equal(target.lastActivity, 1_100);
			assert.deepEqual(writes, []);

			if (failure === "negative") response.resolve({ success: false, error: "current rejected" });
			else response.reject(new Error("current transport failure"));
			await assert.rejects(dispatch, /current (rejected|transport failure)/);

			assert.equal(target.lastActivity, 1_100);
			assert.equal(persisted.lastActivity, 1_100);
			assert.deepEqual(writes, []);
			assert.equal(value.recoverPromptDispatch.mock.calls.length, 1);
			assert.equal(value.recoverPromptDispatch.mock.calls[0][1][0].text, "unsuppressed direct");
			assert.equal(target.pendingPromptAuthors.length, 0);
			assert.equal(
				readAuthorSidecar(target.id).find((row) => row.promptId === current.promptId)?.settlement?.outcome,
				"cancelled",
			);
		},
	);

	it.each([
		{ correlation: "keyed", failure: "negative" },
		{ correlation: "keyless", failure: "throw" },
	] as const)(
		"does not let an unsuppressed $correlation user update accept a steer $failure",
		async ({ correlation, failure }) => {
			const value = manager();
			const target = session(`steer-unsuppressed-${correlation}-${failure}`);
			target.status = "streaming";
			target.lastActivity = 1_200;
			const writes: number[] = [];
			installSessionActivityAttribution(target, {
				get: () => ({ lastActivity: 1_200, lastReadAt: 1_200 }),
				update: (_id: string, patch: any) => writes.push(patch.lastActivity),
			}, { now: () => 1_201 });
			target.rpcClient = {
				steer: vi.fn(async () => {
					const update = prepareVisibleAgentEvent(target, {
						type: "message_update",
						message: {
							...(correlation === "keyed" ? { id: "unsuppressed-steer-id" } : {}),
							role: "user",
							content: "unsuppressed steer",
						},
					});
					recordSessionEventActivity(target, update);
					if (failure === "throw") throw new Error("steer transport failure");
					return { success: false, error: "steer rejected" };
				}),
			};
			const row = target.promptQueue.enqueue("unsuppressed steer", {
				isSteered: true,
				source: "user",
				author: LOCAL_USER_AUTHOR,
			});

			await assert.rejects(
				value._dispatchSteer(target, [row]),
				/steer (rejected|transport failure)/,
			);
			assert.equal(target.lastActivity, 1_200);
			assert.deepEqual(writes, []);
			assert.equal(target.inFlightSteerTexts.length, 0);
			assert.deepEqual(target.promptQueue.toArray().map((queued: any) => queued.text), ["unsuppressed steer"]);
			assert.equal(readAuthorSidecar(target.id).at(-1)?.settlement?.outcome, "cancelled");
		},
	);

	it("counts an unsuppressed accepted prompt once and lets an exact terminal beat a late negative", async () => {
		const value = manager();
		const positiveResponse = deferred<any>();
		const positive = session("dispatch-unsuppressed-positive", {
			prompt: vi.fn(() => positiveResponse.promise),
		});
		positive.lastActivity = 1_300;
		const positiveWrites: number[] = [];
		installSessionActivityAttribution(positive, {
			get: () => ({ lastActivity: 1_300, lastReadAt: 1_300 }),
			update: (_id: string, patch: any) => positiveWrites.push(patch.lastActivity),
		}, { now: () => 1_301 });
		const positiveDispatch = value.dispatchDirectPrompt(
			positive, "positive unsuppressed", undefined, undefined, false, false, "user", LOCAL_USER_AUTHOR,
		);
		await flushMicrotasks();
		const update = prepareVisibleAgentEvent(positive, {
			type: "message_update",
			message: { id: "positive-unsuppressed-id", role: "user", content: "positive unsuppressed" },
		});
		recordSessionEventActivity(positive, update);
		assert.deepEqual(positiveWrites, []);
		positiveResponse.resolve({ success: true });
		await positiveDispatch;
		assert.deepEqual(positiveWrites, [1_301]);
		const end = prepareVisibleAgentEvent(positive, {
			type: "message_end",
			message: { id: "positive-unsuppressed-id", role: "user", content: "positive unsuppressed" },
		});
		recordSessionEventActivity(positive, end);
		assert.deepEqual(positiveWrites, [1_301]);

		const negativeResponse = deferred<any>();
		const terminal = session("dispatch-unsuppressed-terminal", {
			prompt: vi.fn(() => negativeResponse.promise),
		});
		terminal.lastActivity = 1_400;
		const terminalWrites: number[] = [];
		installSessionActivityAttribution(terminal, {
			get: () => ({ lastActivity: 1_400, lastReadAt: 1_400 }),
			update: (_id: string, patch: any) => terminalWrites.push(patch.lastActivity),
		}, { now: () => 1_401 });
		const terminalDispatch = value.dispatchDirectPrompt(
			terminal, "terminal unsuppressed", undefined, undefined, false, false, "user", LOCAL_USER_AUTHOR,
		);
		await flushMicrotasks();
		const terminalEnd = prepareVisibleAgentEvent(terminal, {
			type: "message_end",
			message: { id: "terminal-unsuppressed-id", role: "user", content: "terminal unsuppressed" },
		});
		recordSessionEventActivity(terminal, terminalEnd);
		negativeResponse.resolve({ success: false, error: "late negative" });
		await assert.doesNotReject(terminalDispatch);
		assert.deepEqual(terminalWrites, [1_401]);
		assert.equal(value.recoverPromptDispatch.mock.calls.length, 0);
		assert.equal(readAuthorSidecar(terminal.id).at(-1)?.settlement?.outcome, "echoed");
	});

	it("keeps recovery rows unprefixed after a rejected decorated direct prompt", async () => {
		const value = manager();
		const target = session("dispatch-recovery", {
			prompt: vi.fn(async () => ({ success: false, error: "rejected" })),
		});
		await assert.rejects(
			value.dispatchDirectPrompt(
				target,
				"recoverable base",
				undefined,
				undefined,
				false,
				false,
				"agent",
				AGENT_AUTHOR,
			),
			/rejected/,
		);
		const recoveryRows = value.recoverPromptDispatch.mock.calls[0][1];
		assert.equal(recoveryRows[0].text, "recoverable base");
		assert.doesNotMatch(recoveryRows[0].text, /^\[/);
	});

	it("projects live, replayed, buffered, and title-history rows without double stripping", async () => {
		let piText = "";
		const target = session("dispatch-replay", {
			prompt: vi.fn(async (text: string) => {
				piText = text;
				return { success: true };
			}),
		});
		await dispatchTrackedPrompt(target, "[System]: hello", {
			source: "system",
			author: BOBBIT_SYSTEM_AUTHOR,
			now: () => 300,
		});
		assert.equal(piText, "[System]: [System]: hello");

		const rawEvent = {
			type: "message_end",
			message: {
				id: "pi-message-1",
				role: "user",
				content: piText,
				timestamp: 301,
			},
		};
		const visible = prepareVisibleAgentEvent(target, rawEvent) as any;
		assert.equal(visible.message.content, "[System]: hello");
		assert.equal(visible.message.author.id, BOBBIT_SYSTEM_AUTHOR.id);
		target.eventBuffer.push(visible);
		assert.equal((target.eventBuffer.getAll()[0].event as any).message.content, "[System]: hello");

		const visibleClone = JSON.parse(JSON.stringify(visible));
		const defensiveReplay = prepareVisibleAgentEvent(target, visibleClone) as any;
		assert.equal(defensiveReplay.message.content, "[System]: hello");
		const freshRawReplay = prepareVisibleAgentEvent(target, structuredClone(rawEvent)) as any;
		assert.equal(freshRawReplay.message.content, "[System]: hello");

		const titleRows = projectPromptAuthorMessagesForTitle(
			target.id,
			[structuredClone(rawEvent.message)],
			target,
		);
		assert.equal((titleRows[0] as any).content, "[System]: hello");
	});
});
