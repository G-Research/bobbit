// Raw Pi 0.80.6 transcript coverage for active-branch toolResult repair.
// Distinctive failure token: ORPHAN_TOOL_RESULTS_ACTIVE_BRANCH.

import { describe, expect, it } from "vitest";
import { sanitizeTranscriptContent } from "../../src/server/agent/transcript-sanitizer.ts";

const AFFECTED_TOOL_CALL_IDS = [
	"toolu_011XxjFHDfiTyzt8UgF2eVe2",
	"toolu_01A5tBKqT9crbozrVf5CujD8",
] as const;

type Entry = Record<string, any>;

function message(id: string, parentId: string | null, role: string, content: unknown, extra: Record<string, unknown> = {}): Entry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-07-12T19:41:18.000Z",
		message: { role, content, timestamp: 1783885278000, ...extra },
	};
}

function assistant(id: string, parentId: string | null, calls: Array<string | { id: string; type: "toolCall" | "tool_use" }>, text?: string): Entry {
	const content: Entry[] = [];
	if (text !== undefined) content.push({ type: "text", text });
	for (const call of calls) {
		const { id: toolId, type } = typeof call === "string" ? { id: call, type: "toolCall" as const } : call;
		content.push(type === "toolCall"
			? { type, id: toolId, name: "read", arguments: { path: "fixture" } }
			: { type, id: toolId, name: "read", input: { path: "fixture" } });
	}
	return message(id, parentId, "assistant", content, {
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: calls.length > 0 ? "toolUse" : "stop",
	});
}

function result(id: string, parentId: string | null, toolCallId: unknown, options: { isError?: boolean; toolName?: string } = {}): Entry {
	const toolResult: Entry = {
		role: "toolResult",
		toolName: options.toolName ?? "read",
		content: [{ type: "text", text: options.isError ? "fixture error" : "fixture result" }],
		isError: options.isError ?? false,
		timestamp: 1783885278303,
	};
	if (toolCallId !== undefined) toolResult.toolCallId = toolCallId;
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-07-12T19:41:18.303Z",
		message: toolResult,
	};
}

function user(id: string, parentId: string | null, text = "next prompt"): Entry {
	return message(id, parentId, "user", [{ type: "text", text }]);
}

function metadata(id: string, parentId: string | null, extra: Record<string, unknown> = {}): Entry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: "2026-07-12T19:41:18.250Z",
		customType: "extension-state",
		data: { fixture: true },
		...extra,
	};
}

function customMessage(id: string, parentId: string | null): Entry {
	return {
		type: "custom_message",
		id,
		parentId,
		timestamp: "2026-07-12T19:41:18.250Z",
		customType: "extension-context",
		content: [{ type: "text", text: "Injected extension context" }],
		display: false,
	};
}

function branchSummary(id: string, parentId: string | null): Entry {
	return {
		type: "branch_summary",
		id,
		parentId,
		timestamp: "2026-07-12T19:41:18.250Z",
		fromId: parentId ?? "root",
		summary: "Summary of the abandoned branch",
	};
}

function jsonl(entries: Entry[], trailingNewline = true): string {
	return entries.map((entry) => JSON.stringify(entry)).join("\n") + (trailingNewline ? "\n" : "");
}

function parsedEntries(content: string): Entry[] {
	return content.split("\n").flatMap((line) => {
		if (!line.trim()) return [];
		try {
			return [JSON.parse(line)];
		} catch {
			return [];
		}
	});
}

function ids(content: string): string[] {
	return parsedEntries(content).map((entry) => entry.id).filter(Boolean);
}

function toolResultIds(content: string): unknown[] {
	return parsedEntries(content)
		.filter((entry) => entry.type === "message" && entry.message?.role === "toolResult")
		.map((entry) => entry.message.toolCallId);
}

const AFFECTED_PI_0806_SEQUENCE = jsonl([
	{
		type: "message",
		id: "msg-user-before-affected-turn",
		parentId: null,
		timestamp: "2026-07-12T19:41:17.101Z",
		message: {
			role: "user",
			content: [{ type: "text", text: "Inspect the current test performance." }],
			timestamp: 1783885277101,
		},
	},
	{
		type: "message",
		id: "msg-text-only-assistant",
		parentId: "msg-user-before-affected-turn",
		timestamp: "2026-07-12T19:41:18.202Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "I will inspect the relevant test data." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			timestamp: 1783885278202,
		},
	},
	result("msg-orphan-tool-result-one", "msg-text-only-assistant", AFFECTED_TOOL_CALL_IDS[0]),
	result("msg-orphan-tool-result-two", "msg-orphan-tool-result-one", AFFECTED_TOOL_CALL_IDS[1], { toolName: "grep" }),
]);

describe("sanitizeTranscriptContent — orphan Pi tool results", () => {
	it("repairs the exact affected Pi 0.80.6 active-branch sequence", () => {
		const repaired = sanitizeTranscriptContent(AFFECTED_PI_0806_SEQUENCE);

		expect(repaired.changed).toBe(true);
		expect(repaired.rewritten).toBe(2);
		expect(
			toolResultIds(repaired.content).filter((id) => AFFECTED_TOOL_CALL_IDS.includes(id as any)),
			"ORPHAN_TOOL_RESULTS_ACTIVE_BRANCH: orphan tool results remain on active branch",
		).toEqual([]);
		expect(ids(repaired.content)).toEqual([
			"msg-user-before-affected-turn",
			"msg-text-only-assistant",
		]);
		expect(repaired.content.endsWith("\n")).toBe(true);
	});

	it("bypasses consecutive removed parents with the minimum surviving-link rewrite", () => {
		const source = jsonl([
			assistant("a", null, [], "text only"),
			result("r1", "a", "missing-1"),
			result("r2", "r1", "missing-2"),
			user("u", "r2"),
		]);
		const repaired = sanitizeTranscriptContent(source);
		const entries = parsedEntries(repaired.content);

		expect(repaired.rewritten).toBe(2);
		expect(entries.map((entry) => entry.id)).toEqual(["a", "u"]);
		expect(entries[1].parentId).toBe("a");
		expect(entries[0]).toEqual(JSON.parse(source.split("\n")[0]));
	});

	it("removes missing, empty, non-string, mismatched, duplicate, and already-settled ids", () => {
		const source = jsonl([
			assistant("a", null, ["call-1", "call-2"]),
			result("valid-1", "a", "call-1"),
			result("duplicate", "valid-1", "call-1"),
			result("missing", "duplicate", undefined),
			result("empty", "missing", ""),
			result("whitespace", "empty", "   "),
			result("non-string", "whitespace", 42),
			result("mismatch", "non-string", "other-call"),
			result("valid-2", "mismatch", "call-2"),
		]);
		const repaired = sanitizeTranscriptContent(source);

		expect(repaired.rewritten).toBe(6);
		expect(ids(repaired.content)).toEqual(["a", "valid-1", "valid-2"]);
		expect(toolResultIds(repaired.content)).toEqual(["call-1", "call-2"]);
		expect(parsedEntries(repaired.content)[2].parentId).toBe("valid-1");
	});

	it("rejects an id belonging only to an older assistant turn", () => {
		const source = jsonl([
			assistant("old-a", null, ["old-call"]),
			result("old-r", "old-a", "old-call"),
			user("u", "old-r"),
			assistant("new-a", "u", ["new-call"]),
			result("stale-r", "new-a", "old-call"),
		]);
		const repaired = sanitizeTranscriptContent(source);

		expect(repaired.rewritten).toBe(1);
		expect(ids(repaired.content)).not.toContain("stale-r");
		expect(toolResultIds(repaired.content)).toEqual(["old-call"]);
	});

	it("leaves valid single and errored results byte-identical", () => {
		for (const isError of [false, true]) {
			const source = jsonl([
				assistant("a", null, ["call"]),
				result("r", "a", "call", { isError }),
			]);
			expect(sanitizeTranscriptContent(source)).toEqual({ content: source, changed: false, rewritten: 0 });
		}
	});

	it("leaves parallel calls and results byte-identical in either result order", () => {
		for (const order of [["call-1", "call-2"], ["call-2", "call-1"]]) {
			const source = jsonl([
				assistant("a", null, ["call-1", "call-2"]),
				result("r1", "a", order[0]),
				result("r2", "r1", order[1]),
			]);
			expect(sanitizeTranscriptContent(source)).toEqual({ content: source, changed: false, rewritten: 0 });
		}
	});

	it("accepts Anthropic tool_use compatibility blocks", () => {
		const source = jsonl([
			assistant("a", null, [{ id: "compat-call", type: "tool_use" }]),
			result("r", "a", "compat-call"),
		]);
		expect(sanitizeTranscriptContent(source)).toEqual({ content: source, changed: false, rewritten: 0 });
	});

	it("preserves interrupted and incomplete assistant turns", () => {
		const noResults = jsonl([assistant("a", null, ["call-1", "call-2"])]);
		const oneOfTwoResults = jsonl([
			assistant("a", null, ["call-1", "call-2"]),
			result("r", "a", "call-2"),
		]);
		expect(sanitizeTranscriptContent(noResults).content).toBe(noResults);
		expect(sanitizeTranscriptContent(oneOfTwoResults).content).toBe(oneOfTwoResults);
	});

	it("preserves a synthetic compaction assistant/result pair", () => {
		const source = jsonl([
			assistant("compact-card", null, ["compaction-summary:compact-active"]),
			result("compact-result", "compact-card", "compaction-summary:compact-active", {
				toolName: "__compaction_summary",
			}),
		]);
		expect(sanitizeTranscriptContent(source)).toEqual({ content: source, changed: false, rewritten: 0 });
	});

	it("allows non-context metadata inside a parallel result run", () => {
		const source = jsonl([
			assistant("a", null, ["call-1", "call-2"]),
			metadata("meta-1", "a", { activeToolNames: ["read"] }),
			result("r1", "meta-1", "call-1"),
			metadata("meta-2", "r1"),
			result("r2", "meta-2", "call-2"),
		]);
		expect(sanitizeTranscriptContent(source)).toEqual({ content: source, changed: false, rewritten: 0 });
	});

	it.each([
		["custom_message", customMessage],
		["branch_summary", branchSummary],
	] as const)("treats a Pi %s entry as ending the result run", (_type, contextEntry) => {
		const source = jsonl([
			assistant("a", null, ["call"]),
			contextEntry("context", "a"),
			result("late", "context", "call"),
		]);
		const repaired = sanitizeTranscriptContent(source);

		expect(repaired.rewritten).toBe(1);
		expect(ids(repaired.content)).toEqual(["a", "context"]);
		expect(repaired.content).toContain(JSON.stringify(contextEntry("context", "a")));
	});

	it("keeps latest-compaction projection ordering transparent to a valid result run", () => {
		const source = jsonl([
			assistant("a", null, ["call"]),
			{
				type: "compaction",
				id: "compact",
				parentId: "a",
				firstKeptEntryId: "a",
				summary: "summary projected before the preserved tail",
				tokensBefore: 100,
			},
			result("r", "compact", "call"),
		]);
		expect(sanitizeTranscriptContent(source)).toEqual({ content: source, changed: false, rewritten: 0 });
	});

	it("treats a non-result conversation message as ending the result run", () => {
		const source = jsonl([
			assistant("a", null, ["call"]),
			user("u", "a"),
			result("late", "u", "call"),
		]);
		const repaired = sanitizeTranscriptContent(source);
		expect(ids(repaired.content)).toEqual(["a", "u"]);
		expect(repaired.rewritten).toBe(1);
	});

	it("leaves structurally orphaned results on inactive branches byte-identical", () => {
		const inactiveOrphan = result("inactive-orphan", "root", "never-called");
		const source = jsonl([
			user("root", null),
			inactiveOrphan,
			assistant("active-a", "root", ["active-call"]),
			result("active-r", "active-a", "active-call"),
		]);
		expect(sanitizeTranscriptContent(source)).toEqual({ content: source, changed: false, rewritten: 0 });
		expect(source).toContain(JSON.stringify(inactiveOrphan));
	});

	it("reparents active and inactive children when an active orphan is their shared ancestor", () => {
		const source = jsonl([
			user("root", null),
			assistant("a", "root", [], "text only"),
			result("shared-orphan", "a", "never-called"),
			user("inactive-child", "shared-orphan", "alternate branch"),
			user("active-child", "shared-orphan", "active branch"),
		]);
		const repaired = sanitizeTranscriptContent(source);
		const entries = parsedEntries(repaired.content);

		expect(repaired.rewritten).toBe(1);
		expect(ids(repaired.content)).toEqual(["root", "a", "inactive-child", "active-child"]);
		expect(entries.find((entry) => entry.id === "inactive-child")?.parentId).toBe("a");
		expect(entries.find((entry) => entry.id === "active-child")?.parentId).toBe("a");
	});

	it("bypasses consecutive removed ancestors for every surviving branch", () => {
		const source = jsonl([
			assistant("a", null, [], "text only"),
			result("orphan-1", "a", "missing-1"),
			result("orphan-2", "orphan-1", "missing-2"),
			metadata("inactive-from-first", "orphan-1", { branch: "first" }),
			metadata("inactive-from-second", "orphan-2", { branch: "second" }),
			user("active-child", "orphan-2"),
		]);
		const repaired = sanitizeTranscriptContent(source);
		const entries = parsedEntries(repaired.content);

		expect(repaired.rewritten).toBe(2);
		expect(entries.find((entry) => entry.id === "inactive-from-first")?.parentId).toBe("a");
		expect(entries.find((entry) => entry.id === "inactive-from-second")?.parentId).toBe("a");
		expect(entries.find((entry) => entry.id === "active-child")?.parentId).toBe("a");
	});

	it("ignores pre-boundary orphan results excluded by the latest compaction projection", () => {
		const source = jsonl([
			assistant("old-a", null, [], "old text-only turn"),
			result("old-orphan", "old-a", "old-missing"),
			user("kept-user", "old-orphan"),
			{
				type: "compaction",
				id: "compact",
				parentId: "kept-user",
				firstKeptEntryId: "kept-user",
				summary: "summary",
			},
			assistant("new-a", "compact", ["new-call"]),
			result("new-r", "new-a", "new-call"),
		]);
		expect(sanitizeTranscriptContent(source)).toEqual({ content: source, changed: false, rewritten: 0 });
	});

	it("repairs an orphan inside the latest compaction's preserved tail", () => {
		const source = jsonl([
			assistant("kept-a", null, [], "text only"),
			result("kept-orphan", "kept-a", "missing"),
			user("kept-user", "kept-orphan"),
			{
				type: "compaction",
				id: "compact",
				parentId: "kept-user",
				firstKeptEntryId: "kept-a",
				summary: "summary",
			},
		]);
		const repaired = sanitizeTranscriptContent(source);
		const entries = parsedEntries(repaired.content);

		expect(ids(repaired.content)).toEqual(["kept-a", "kept-user", "compact"]);
		expect(entries.find((entry) => entry.id === "kept-user")?.parentId).toBe("kept-a");
		expect(entries.find((entry) => entry.id === "compact")?.parentId).toBe("kept-user");
	});

	it("uses only post-compaction descendants when firstKeptEntryId is unresolved", () => {
		const source = jsonl([
			assistant("old-a", null, [], "text only"),
			result("old-orphan", "old-a", "missing"),
			{
				type: "compaction",
				id: "compact",
				parentId: "old-orphan",
				firstKeptEntryId: "not-on-branch",
				summary: "summary",
			},
			assistant("new-a", "compact", [], "new text only"),
			result("new-orphan", "new-a", "missing-new"),
		]);
		const repaired = sanitizeTranscriptContent(source);

		expect(ids(repaired.content)).toEqual(["old-a", "old-orphan", "compact", "new-a"]);
		expect(repaired.rewritten).toBe(1);
	});

	it("preserves malformed JSON and unrelated metadata while repairing around them", () => {
		const a = JSON.stringify(assistant("a", null, [], "text only"));
		const orphan = JSON.stringify(result("orphan", "a", "missing"));
		const meta = JSON.stringify(metadata("meta", "orphan", { secretShape: { untouched: true } }));
		const malformed = "{ definitely-not-json";
		const source = [a, malformed, orphan, meta, ""].join("\n");
		const repaired = sanitizeTranscriptContent(source);

		expect(repaired.content.split("\n")).toContain(malformed);
		expect(repaired.content).toContain('"secretShape":{"untouched":true}');
		expect(parsedEntries(repaired.content).find((entry) => entry.id === "meta")?.parentId).toBe("a");
	});

	it.each([true, false])("preserves trailing-newline shape when trailingNewline=%s", (trailingNewline) => {
		const source = jsonl([
			assistant("a", null, [], "text only"),
			result("orphan", "a", "missing"),
		], trailingNewline);
		const repaired = sanitizeTranscriptContent(source);
		expect(repaired.content.endsWith("\n")).toBe(trailingNewline);
	});

	it("is deterministic and idempotent after removal and parent bypass", () => {
		const source = jsonl([
			assistant("a", null, [], "text only"),
			result("orphan", "a", "missing"),
			metadata("meta", "orphan"),
			user("u", "meta"),
		]);
		const once = sanitizeTranscriptContent(source);
		const twice = sanitizeTranscriptContent(once.content);
		const anotherFirstPass = sanitizeTranscriptContent(source);

		expect(once).toEqual(anotherFirstPass);
		expect(twice).toEqual({ content: once.content, changed: false, rewritten: 0 });
	});

	it("does not reinterpret user tool_result blocks as removable message-level results", () => {
		const source = jsonl([
			assistant("a", null, ["call"]),
			message("user-tool-result", "a", "user", [{
				type: "tool_result",
				tool_use_id: "call",
				content: "ok",
			}]),
		]);
		expect(sanitizeTranscriptContent(source)).toEqual({ content: source, changed: false, rewritten: 0 });
	});

	it("leaves valid transcripts byte-identical, including line ordering and whitespace", () => {
		const header = '{ "type": "session", "id": "session-id", "cwd": "C:/work" }';
		const a = JSON.stringify(assistant("a", null, ["call"]));
		const r = JSON.stringify(result("r", "a", "call"));
		const source = `${header}\n${a}\n${r}`;
		const repaired = sanitizeTranscriptContent(source);

		expect(repaired).toEqual({ content: source, changed: false, rewritten: 0 });
	});
});
