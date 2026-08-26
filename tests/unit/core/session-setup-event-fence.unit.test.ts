import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { guardProcessEnv } from "./_helpers/env-guard.js";

guardProcessEnv();

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-setup-event-fence-"));
process.env.BOBBIT_DIR = tmpRoot;

const { persistOnce, subscribeToEvents } = await import("../../../src/server/agent/session-setup.ts");
const { EventBuffer } = await import("../../../src/server/agent/event-buffer.ts");
const { PromptQueue } = await import("../../../src/server/agent/prompt-queue.ts");

afterAll(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("session setup initial unanswered-question state", () => {
	const session = (id: string) => ({
		id,
		title: `Session ${id}`,
		cwd: tmpRoot,
		createdAt: 100,
		lastActivity: 200,
	}) as any;
	const plan = (id: string, preExistingAgentSessionFile?: string) => ({
		id,
		mode: "normal",
		title: `Session ${id}`,
		cwd: tmpRoot,
		bridgeOptions: {},
		preExistingAgentSessionFile,
	}) as any;

	it("persists false for a fresh transcript", () => {
		const put = vi.fn();
		persistOnce(session("fresh-session-id"), plan("fresh-session-id"), { put } as any);

		expect(put).toHaveBeenCalledOnce();
		expect(put.mock.calls[0]![0]).toMatchObject({
			id: "fresh-session-id",
			agentSessionFile: "",
			hasUnansweredQuestion: false,
		});
	});

	it("leaves imported transcript state unset so restore performs legacy backfill", () => {
		const put = vi.fn();
		const importedTranscript = path.join(tmpRoot, "imported-session-id.jsonl");
		persistOnce(
			session("imported-session-id"),
			plan("imported-session-id", importedTranscript),
			{ put } as any,
		);

		const persisted = put.mock.calls[0]![0];
		expect(persisted.agentSessionFile).toBe(importedTranscript);
		expect(Object.prototype.hasOwnProperty.call(persisted, "hasUnansweredQuestion")).toBe(false);
	});
});

describe("session setup event lifecycle fence", () => {
	it("drops old-generation terminal and compaction events, then delivers new events once after unfence", () => {
		const listeners = new Set<(event: any) => void>();
		const rpcClient = {
			onEvent(listener: (event: any) => void) {
				listeners.add(listener);
				return () => { listeners.delete(listener); };
			},
		};
		const send = vi.fn();
		const onEventAccepted = vi.fn();
		const session: any = {
			id: "session-event-fence",
			title: "Event fence",
			cwd: tmpRoot,
			status: "streaming",
			statusVersion: 0,
			createdAt: 1,
			lastActivity: 1,
			clients: new Set([{ readyState: 1, bufferedAmount: 0, send }]),
			rpcClient,
			eventBuffer: new EventBuffer(),
			promptQueue: new PromptQueue(),
			lifecycleFenced: true,
			onEventAccepted,
		};
		const storeUpdate = vi.fn();
		const prepareVisibleAgentEvent = vi.fn((_session: any, event: any) => event);
		const queueDrain = vi.fn();
		const compactionBoundary = vi.fn();
		const handleAgentLifecycle = vi.fn((_session: any, event: any) => {
			if (event.type === "agent_end") queueDrain();
			if (event.type === "compaction_end") compactionBoundary();
		});
		const trackCostFromEvent = vi.fn();
		const emit = (event: any) => {
			for (const listener of [...listeners]) listener(event);
		};
		const oldGenerationEvents = [
			{ type: "message_end", message: { id: "old-message", role: "assistant", content: [] } },
			{ type: "agent_end", willRetry: false, messages: [] },
			{ type: "compaction_end", result: { summary: "old summary" } },
		];

		const unsubscribe = subscribeToEvents(session, {
			store: { update: storeUpdate },
			prepareVisibleAgentEvent,
			handleAgentLifecycle,
			trackCostFromEvent,
		} as any);

		for (const event of oldGenerationEvents) emit(event);

		expect(prepareVisibleAgentEvent).not.toHaveBeenCalled();
		expect(storeUpdate).not.toHaveBeenCalled();
		expect(handleAgentLifecycle).not.toHaveBeenCalled();
		expect(trackCostFromEvent).not.toHaveBeenCalled();
		expect(session.eventBuffer.getAll()).toEqual([]);
		expect(onEventAccepted).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
		expect(queueDrain).not.toHaveBeenCalled();
		expect(compactionBoundary).not.toHaveBeenCalled();

		session.lifecycleFenced = false;
		const newGenerationEvents = [
			{ type: "message_end", message: { id: "new-message", role: "assistant", content: [] } },
			{ type: "agent_end", willRetry: false, messages: [] },
			{ type: "compaction_end", result: { summary: "new summary" } },
		];
		for (const event of newGenerationEvents) emit(event);

		expect(prepareVisibleAgentEvent).toHaveBeenCalledTimes(3);
		expect(handleAgentLifecycle).toHaveBeenCalledTimes(3);
		expect(trackCostFromEvent).toHaveBeenCalledTimes(3);
		expect(session.eventBuffer.getAll().map((entry: any) => entry.event)).toEqual(newGenerationEvents);
		expect(onEventAccepted).toHaveBeenCalledTimes(3);
		expect(send).toHaveBeenCalledTimes(3);
		expect(queueDrain).toHaveBeenCalledTimes(1);
		expect(compactionBoundary).toHaveBeenCalledTimes(1);
		expect(session.eventBuffer.getAll().some((entry: any) => entry.event?.type === "context_cleared")).toBe(false);

		unsubscribe();
	});
});
