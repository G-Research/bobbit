import { describe, expect, it } from "vitest";
import path from "node:path";
import {
	LOCAL_USER_AUTHOR,
	isMessageAuthor,
	type MessageAuthor,
} from "../../src/shared/message-author.ts";
import type { PromptSource } from "../../src/shared/prompt-source.ts";
import { PromptQueue } from "../../src/server/agent/prompt-queue.ts";
import { normalizePersistedInFlightSteers, SessionStore } from "../../src/server/agent/session-store.ts";
import { spliceInFlightMessage, spliceInFlightSteers } from "../../src/server/agent/splice-inflight-message.ts";
import { buildVisibleMessageSnapshot } from "../../src/server/agent/visible-message-snapshot.ts";
import {
	BATCH_SYSTEM_AUTHOR,
	BOBBIT_SYSTEM_AUTHOR,
	DYNAMIC_CONTEXT_AUTHOR,
	agentAuthorForSession,
	authorKindForPromptSource,
	extensionSystemAuthor,
	isToolResultOnlyMessage,
	normalizeVisibleAgentEvent,
	normalizeVisibleMessage,
	normalizeVisibleMessages,
	resolvePromptAuthor,
} from "../../src/server/agent/message-author.ts";
import { createMemFs, type MemFs } from "../harness/mem-fs.ts";

type SessionStoreMemFs = MemFs & {
	openSync(file: string, flags: string): number;
	fsyncSync(fd: number): void;
	closeSync(fd: number): void;
};

function createSessionStoreMemFs(): SessionStoreMemFs {
	const memoryFs = createMemFs() as SessionStoreMemFs;
	const descriptors = new Map<number, string>();
	const writeFileSync = memoryFs.writeFileSync.bind(memoryFs);
	let nextDescriptor = 3;
	memoryFs.openSync = (file: string) => {
		const descriptor = nextDescriptor++;
		descriptors.set(descriptor, file);
		return descriptor;
	};
	(memoryFs as any).writeFileSync = (
		target: string | number,
		data: string | NodeJS.ArrayBufferView,
		encoding?: BufferEncoding,
	) => writeFileSync(
		typeof target === "number" ? descriptors.get(target)! : target,
		data,
		encoding as any,
	);
	memoryFs.fsyncSync = () => {};
	memoryFs.closeSync = (descriptor: number) => { descriptors.delete(descriptor); };
	return memoryFs;
}

const sources: Array<[PromptSource, "user" | "agent" | "system"]> = [
	["user", "user"],
	["auto-nudge", "system"],
	["task-notification", "system"],
	["verification", "system"],
	["system", "system"],
	["agent", "agent"],
	["child-complete", "system"],
	["extension", "system"],
];

describe("message author primitives", () => {
	it.each(sources)("maps PromptSource %s to %s", (source, expected) => {
		expect(authorKindForPromptSource(source)).toBe(expected);
	});

	it("validates only bounded, non-empty three-kind authors", () => {
		expect(isMessageAuthor(LOCAL_USER_AUTHOR)).toBe(true);
		expect(isMessageAuthor({ kind: "tool", id: "tool:x", label: "Tool" })).toBe(false);
		expect(isMessageAuthor({ kind: "user", id: " ", label: "User" })).toBe(false);
		expect(isMessageAuthor({ kind: "user", id: "user:x", label: "x".repeat(257) })).toBe(false);
	});

	it("uses stable staff identity and staff name before mutable session metadata", () => {
		const author = agentAuthorForSession(
			{ id: "session-id", staffId: "STAFF/One", title: "Mutable title", role: "reviewer" },
			{ getStaff: () => ({ name: "Ada" } as any) },
		);
		expect(author).toEqual({ kind: "agent", id: "staff:staff-one", label: "Ada" });
	});

	it("uses title, role label, role name, then Agent for non-staff labels", () => {
		const deps = { getRole: () => ({ name: "reviewer", label: "Reviewer" } as any) };
		expect(agentAuthorForSession({ id: "s1", title: "Session title", role: "reviewer" }, deps).label).toBe("Session title");
		expect(agentAuthorForSession({ id: "s1", title: " ", role: "reviewer" }, deps).label).toBe("Reviewer");
		expect(agentAuthorForSession({ id: "s1", title: "", role: "coder" }).label).toBe("coder");
		expect(agentAuthorForSession({ id: "s1", title: "" }).label).toBe("Agent");
		expect(agentAuthorForSession({ id: "Session/One", title: "" }).id).toBe("session:session-one");
	});

	it("constructs bounded extension system identities from trusted pack/tool metadata", () => {
		expect(extensionSystemAuthor("Acme/Pack", "Post Message")).toEqual({
			kind: "system",
			id: "system:extension:acme-pack:post-message",
			label: "Acme/Pack/Post Message",
		});
		expect(extensionSystemAuthor("pack", "tool", "Contribution").label).toBe("Contribution");
	});

	it("resolves human, authenticated-agent, extension, and missing-agent authors safely", () => {
		const caller = { kind: "agent", id: "session:caller", label: "Caller" } as const;
		const extension = extensionSystemAuthor("pack", "post");
		expect(resolvePromptAuthor("user")).toEqual(LOCAL_USER_AUTHOR);
		expect(resolvePromptAuthor("agent", { agentAuthor: caller })).toBe(caller);
		expect(resolvePromptAuthor("agent")).toBe(BOBBIT_SYSTEM_AUTHOR);
		expect(resolvePromptAuthor("extension", { systemAuthor: extension })).toBe(extension);
	});

	it("recognizes message-level and provider-history tool result shapes", () => {
		expect(isToolResultOnlyMessage({ role: "toolResult", content: "ok" })).toBe(true);
		expect(isToolResultOnlyMessage({ role: "tool_result", content: [] })).toBe(true);
		expect(isToolResultOnlyMessage({ role: "tool", content: [] })).toBe(true);
		expect(isToolResultOnlyMessage({
			role: "user",
			content: [{ type: "tool_result", content: "ok" }],
		})).toBe(true);
		expect(isToolResultOnlyMessage({
			role: "user",
			content: [{ type: "toolResult", content: "ok" }, { type: "text", text: "  " }],
		})).toBe(true);
		expect(isToolResultOnlyMessage({ role: "user", content: [{ type: "text", text: "human" }] })).toBe(false);
	});

	it("infers hidden/custom rows, assistant, and legacy human rows", () => {
		const context = { session: { id: "abc", title: "Coder" } };
		expect(normalizeVisibleMessage({ role: "custom", customType: "bobbit:dynamic-context", display: false }, context).author)
			.toEqual(DYNAMIC_CONTEXT_AUTHOR);
		expect(normalizeVisibleMessage({ role: "system-notification", message: "notice" }, context).author)
			.toEqual(BOBBIT_SYSTEM_AUTHOR);
		expect(normalizeVisibleMessage({ role: "assistant", content: "answer" }, context).author)
			.toEqual({ kind: "agent", id: "session:abc", label: "Coder" });
		expect(normalizeVisibleMessage({ role: "user", content: "question" }, context).author)
			.toEqual(LOCAL_USER_AUTHOR);
	});

	it("replaces invalid pre-existing metadata instead of trusting it", () => {
		const normalized = normalizeVisibleMessage({
			role: "assistant",
			content: "answer",
			author: { kind: "tool", id: "tool:x", label: "Tool" },
		}, { session: { id: "abc", title: "Agent" } });
		expect(normalized.author).toEqual({ kind: "agent", id: "session:abc", label: "Agent" });
	});

	it("preserves validated authors only when Bobbit marks them as trusted", () => {
		const extension = extensionSystemAuthor("trusted-pack", "post-message");
		const message = { role: "user", content: "extension prompt", author: extension };

		expect(normalizeVisibleMessage(message).author).toEqual(LOCAL_USER_AUTHOR);
		expect(normalizeVisibleMessage(message, { existingAuthorIsTrusted: true }).author).toBe(extension);
	});

	it.each(["message_update", "message_end"] as const)(
		"rejects forged assistant authors on live %s events",
		(eventType) => {
			const sessionAuthor = { kind: "agent", id: "session:abc", label: "Coder" } as const;
			for (const forged of [
				LOCAL_USER_AUTHOR,
				{ kind: "agent", id: "session:forged", label: "Forged agent" } as const,
				{ kind: "system", id: "system:forged", label: "Forged system" } as const,
			]) {
				const event = {
					type: eventType,
					message: { role: "assistant", content: "unchanged model bytes", author: forged },
				};
				const normalized = normalizeVisibleAgentEvent(
					{ id: "abc", title: "Coder" },
					event,
					{ agentAuthor: sessionAuthor },
				);
				expect(normalized.message.author).toEqual(sessionAuthor);
				expect(normalized.message.content).toBe(event.message.content);
			}
		},
	);

	it.each(["message_update", "message_end"] as const)(
		"rejects forged authors in favor of the bound prompt on live %s events",
		(eventType) => {
			const boundAuthor = extensionSystemAuthor("trusted-pack", "post-message");
			for (const forged of [
				LOCAL_USER_AUTHOR,
				{ kind: "agent", id: "session:forged", label: "Forged agent" } as const,
				{ kind: "system", id: "system:forged", label: "Forged system" } as const,
			]) {
				const event = {
					type: eventType,
					message: { role: "user", content: "unchanged prompt bytes", author: forged },
				};
				const normalized = normalizeVisibleAgentEvent(
					{ id: "abc", title: "Coder" },
					event,
					{ promptAuthor: boundAuthor },
				);
				expect(normalized.message.author).toEqual(boundAuthor);
				expect(normalized.message.content).toBe(event.message.content);
			}
		},
	);

	it("tool results inherit an accountable predecessor and never a tool author", () => {
		const rows = normalizeVisibleMessages([
			{ role: "assistant", content: "calling" },
			{ role: "toolResult", toolName: "bash", content: "ok" },
			{ role: "user", content: [{ type: "tool_result", content: "provider result" }] },
		], { session: { id: "abc", title: "Coder" } });
		expect(rows.map((row) => row.author?.kind)).toEqual(["agent", "agent", "agent"]);
		expect(rows[1].author).toEqual(rows[0].author);
		expect(rows[2].author).toEqual(rows[1].author);
	});

	it("normalizes message events without changing non-message lifecycle events", () => {
		const event = { type: "message_update", message: { role: "assistant", content: "stream" } };
		const normalized = normalizeVisibleAgentEvent({ id: "abc", title: "Coder" }, event);
		expect(normalized).not.toBe(event);
		expect((normalized as any).message.author.kind).toBe("agent");
		const lifecycle = { type: "agent_start" };
		expect(normalizeVisibleAgentEvent({ id: "abc" }, lifecycle)).toBe(lifecycle);
	});

	it("preserves queue author provenance across persistence restore and accepts legacy rows", () => {
		const systemAuthor: MessageAuthor = { kind: "system", id: "system:bobbit", label: "Bobbit" };
		const queued = new PromptQueue();
		queued.enqueue("notification", { isSteered: true, source: "task-notification", author: systemAuthor });
		queued.enqueue("legacy prompt");

		const persisted = JSON.parse(JSON.stringify(queued.toArray()));
		const stateDir = path.resolve("/memfs/message-author/queue");
		const memoryFs = createSessionStoreMemFs();
		const store = new SessionStore(stateDir, memoryFs);
		store.put({
			id: "author-queue-session",
			title: "Author queue",
			cwd: stateDir,
			agentSessionFile: path.join(stateDir, "agent.jsonl"),
			createdAt: 1,
			lastActivity: 1,
			messageQueue: persisted,
		} as any);
		const reloaded = new SessionStore(stateDir, memoryFs).get("author-queue-session");
		const restored = new PromptQueue(reloaded?.messageQueue).toArray();
		expect(restored[0]).toMatchObject({
			text: "notification",
			isSteered: true,
			source: "task-notification",
			author: systemAuthor,
		});
		expect(restored[1]).toMatchObject({ text: "legacy prompt" });
		expect(restored[1].source).toBeUndefined();
		expect(restored[1].author).toBeUndefined();

		const invalid = new PromptQueue([{ ...persisted[0], author: { kind: "tool", id: "tool:x", label: "Tool" } }]);
		expect(invalid.peek()?.author).toBeUndefined();
	});

	it("normalizes legacy and structured in-flight steer ledgers without inventing tool authors", () => {
		const systemAuthor: MessageAuthor = { kind: "system", id: "system:bobbit", label: "Bobbit" };
		const restored = normalizePersistedInFlightSteers([
			"legacy human steer",
			{ text: "server steer", promptId: "prompt-system", source: "auto-nudge", author: systemAuthor },
			{ text: "invalid author", promptId: "prompt-invalid", source: "system", author: { kind: "tool", id: "tool:x", label: "Tool" } as any },
		]);
		expect(restored).toEqual([
			{
				text: "legacy human steer",
				promptId: "legacy-inflight-steer:0",
				source: "user",
				author: LOCAL_USER_AUTHOR,
			},
			{ text: "server steer", promptId: "prompt-system", source: "auto-nudge", author: systemAuthor },
			{ text: "invalid author", promptId: "prompt-invalid", source: "system" },
		]);
	});

	it("keeps authors on in-flight assistant and steer snapshot splices", () => {
		const agentAuthor: MessageAuthor = { kind: "agent", id: "session:abc", label: "Coder" };
		const systemAuthor: MessageAuthor = { kind: "system", id: "system:bobbit", label: "Bobbit" };
		const assistant = {
			id: "assistant-live",
			role: "assistant",
			content: [{ type: "text", text: "partial" }],
			author: agentAuthor,
		};
		const withAssistant = spliceInFlightMessage([], { id: assistant.id, message: assistant });
		expect(withAssistant).toEqual([assistant]);

		const snapshot = spliceInFlightSteers(withAssistant, [{
			text: "automatic reminder",
			promptId: "system-steer",
			source: "auto-nudge",
			author: systemAuthor,
		}]);
		expect(snapshot).toHaveLength(2);
		expect(snapshot[0]).toMatchObject({ role: "assistant", author: agentAuthor });
		expect(snapshot[1]).toMatchObject({
			id: "inflight-steer:system-steer",
			role: "user",
			author: systemAuthor,
			_inFlightSteer: true,
		});
		expect(snapshot[1].content).toEqual([{ type: "text", text: "automatic reminder" }]);
	});

	it("strips untrusted snapshot authors before preserving trusted Bobbit splices", () => {
		const snapshotAgent: MessageAuthor = { kind: "agent", id: "session:snapshot-trust", label: "Snapshot Agent" };
		const liveAgent: MessageAuthor = { kind: "agent", id: "session:live-trust", label: "Live Agent" };
		const trustedSystem: MessageAuthor = { kind: "system", id: "system:bobbit", label: "Bobbit" };
		const untrustedSystem: MessageAuthor = { kind: "system", id: "system:forged", label: "Forged" };
		const untrustedAgent: MessageAuthor = { kind: "agent", id: "session:forged", label: "Forged" };

		const rawSnapshot = [
			{ id: "raw-assistant", role: "assistant", content: "answer", author: untrustedSystem },
			{ id: "raw-user", role: "user", content: "question", author: untrustedAgent },
		];
		const visible = buildVisibleMessageSnapshot(rawSnapshot, {
			sessionId: "snapshot-trust",
			session: { id: "snapshot-trust", title: "Snapshot Agent" },
			agentAuthor: snapshotAgent,
			latestMessageUpdate: {
				id: "live-assistant",
				message: { id: "live-assistant", role: "assistant", content: "partial", author: liveAgent },
			},
			inFlightSteerTexts: [{
				text: "trusted reminder",
				promptId: "trusted-steer",
				source: "system",
				author: trustedSystem,
			}],
		});

		expect(visible[0].author).toEqual(snapshotAgent);
		expect(visible[1].author).toEqual(LOCAL_USER_AUTHOR);
		expect(visible[2].author).toEqual(liveAgent);
		expect(visible[3].author).toEqual(trustedSystem);
		expect(rawSnapshot[0].author).toEqual(untrustedSystem);
		expect(rawSnapshot[1].author).toEqual(untrustedAgent);
	});

	it("exposes the mixed-author batch identity as a system author", () => {
		expect(BATCH_SYSTEM_AUTHOR).toEqual({ kind: "system", id: "system:bobbit:batch", label: "Bobbit" });
	});
});
