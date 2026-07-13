import { describe, expect, it } from "vitest";
import {
	LOCAL_USER_AUTHOR,
	isMessageAuthor,
} from "../../src/shared/message-author.ts";
import type { PromptSource } from "../../src/shared/prompt-source.ts";
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
		expect(resolvePromptAuthor("user")).toBe(LOCAL_USER_AUTHOR);
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

	it("exposes the mixed-author batch identity as a system author", () => {
		expect(BATCH_SYSTEM_AUTHOR).toEqual({ kind: "system", id: "system:bobbit:batch", label: "Bobbit" });
	});
});
