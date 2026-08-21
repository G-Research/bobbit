import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, vi } from "vitest";

import { guardProcessEnv } from "./helpers/env-guard.js";

guardProcessEnv();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-session-notifications-"));
process.env.BOBBIT_DIR = root;

const { SessionManager, emitSessionEvent } = await import("../../src/server/agent/session-manager.ts");
const { broadcastStatus } = await import("../../src/server/agent/session-status.ts");
const { PromptQueue } = await import("../../src/server/agent/prompt-queue.ts");
const { EventBuffer } = await import("../../src/server/agent/event-buffer.ts");

const managers: any[] = [];

afterEach(() => {
	for (const manager of managers.splice(0)) {
		if (manager._statusHeartbeatTimer) clearInterval(manager._statusHeartbeatTimer);
		manager.sessions.clear();
	}
});

function makeHarness() {
	const facts: Array<{ name: string; publication: any; frameCount: number }> = [];
	const sent: any[] = [];
	const publisher = {
		publish(name: string, publication: any) {
			facts.push({ name, publication, frameCount: sent.length });
		},
	};
	const manager: any = new SessionManager({ hostNotificationPublisher: publisher });
	managers.push(manager);
	manager._testStore = { update: vi.fn(), get: vi.fn(() => undefined) };
	const client = {
		readyState: 1,
		bufferedAmount: 0,
		send(data: string) { sent.push(JSON.parse(data)); },
	};
	const session: any = {
		id: "session-a",
		projectId: "project-a",
		title: "Session A",
		cwd: root,
		status: "idle",
		statusVersion: 0,
		createdAt: Date.now(),
		lastActivity: Date.now(),
		clients: new Set([client]),
		rpcClient: { prompt: vi.fn(), getState: vi.fn(async () => ({ success: true, data: {} })) },
		eventBuffer: new EventBuffer(),
		promptQueue: new PromptQueue(),
		unsubscribe: () => {},
		isCompacting: false,
		setupComplete: true,
		lastPromptSource: "user",
	};
	manager.sessions.set(session.id, session);
	manager.setHostNotificationPublisher(publisher);
	return { manager, session, facts, sent };
}

describe("authoritative session host notifications", () => {
	it("publishes status only after the legacy frame and suppresses unchanged status", () => {
		const { session, facts, sent } = makeHarness();
		broadcastStatus(session, "streaming", { streamingStartedAt: 10 });

		assert.equal(sent.length, 1);
		assert.deepEqual(facts.map((fact) => fact.name), ["statusChanged", "sessionStatusChanged"]);
		assert.ok(facts.every((fact) => fact.frameCount === 1), "fact must follow legacy frame queueing");
		assert.deepEqual(facts[0].publication.payload, {
			previousStatus: "idle",
			status: "streaming",
			statusVersion: 1,
		});

		broadcastStatus(session, "streaming", { streamingStartedAt: 10 });
		assert.equal(sent.length, 2, "legacy same-status compatibility frame remains");
		assert.equal(facts.length, 2, "same-status write is not a committed transition fact");
	});

	it("reuses final-turn fences and reports explicit success, error, and abort outcomes once", () => {
		const { manager, session, facts } = makeHarness();
		manager.handleAgentLifecycle(session, { type: "agent_start" });
		manager.handleAgentLifecycle(session, { type: "agent_start" });
		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: true, messages: [] });
		assert.equal(facts.filter((fact) => fact.name === "turnStarted").length, 1);
		assert.equal(facts.filter((fact) => fact.name === "turnCompleted").length, 0);

		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false, messages: [] });
		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false, messages: [] });
		const completed = facts.filter((fact) => fact.name === "turnCompleted");
		assert.equal(completed.length, 1);
		assert.equal(completed[0].publication.payload.outcome, "succeeded");
		assert.equal(session.completedTurnCount, 1);

		manager.handleAgentLifecycle(session, { type: "agent_start" });
		manager.handleAgentLifecycle(session, {
			type: "message_end",
			message: { id: "assistant-error", role: "assistant", stopReason: "error", errorMessage: "PRIVATE_PROVIDER_BODY" },
		});
		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false, messages: [] });
		assert.equal(facts.filter((fact) => fact.name === "turnCompleted").at(-1)?.publication.payload.outcome, "errored");

		manager.handleAgentLifecycle(session, { type: "agent_start" });
		broadcastStatus(session, "aborting");
		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false, messages: [] });
		assert.equal(facts.filter((fact) => fact.name === "turnCompleted").at(-1)?.publication.payload.outcome, "aborted");
		assert.equal(JSON.stringify(facts).includes("PRIVATE_PROVIDER_BODY"), false);
	});

	it("fences tool completion on accepted tool-result message metadata", () => {
		const { manager, session, facts } = makeHarness();
		manager.handleAgentLifecycle(session, { type: "agent_start" });
		manager.markToolCallAdmitted(session.id, "call-1", "read");
		manager.handleAgentLifecycle(session, {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			isError: true,
			result: { content: [{ type: "text", text: "PRIVATE_TOOL_BODY" }] },
		});
		assert.equal(facts.filter((fact) => fact.name === "toolCallCompleted").length, 0);

		emitSessionEvent(session, {
			type: "message_end",
			message: {
				id: "result-message",
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				isError: true,
				content: [{ type: "text", text: "PRIVATE_TOOL_BODY" }],
			},
		});

		assert.deepEqual(facts.slice(-2).map((fact) => fact.name), ["messageAppended", "toolCallCompleted"]);
		assert.deepEqual(facts.at(-1)?.publication.payload, {
			toolCallId: "call-1",
			toolName: "read",
			status: "failed",
			durationMs: facts.at(-1)?.publication.payload.durationMs,
			errorStatus: "tool_error",
		});
		assert.equal(JSON.stringify(facts).includes("PRIVATE_TOOL_BODY"), false);
		assert.equal(session.hostToolCallLifecycle.size, 0);
	});
});
