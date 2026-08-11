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
