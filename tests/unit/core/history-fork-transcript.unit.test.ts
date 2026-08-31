import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";

import {
	HistoryForkValidationError,
	materializeHistoryForkTranscript,
} from "../../../src/server/agent/history-fork.ts";
import {
	activeTranscriptBranch,
	parseTranscript,
} from "../../../src/server/agent/transcript-tree.ts";

type TranscriptEntry = Record<string, unknown>;

function session(id = "session-1"): TranscriptEntry {
	return {
		type: "session",
		version: 3,
		id,
		timestamp: "2026-08-01T00:00:00.000Z",
		cwd: "/fixture/worktree",
	};
}

function user(id: string, parentId: string | null, text = id): TranscriptEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: `2026-08-01T00:00:${id.length.toString().padStart(2, "0")}.000Z`,
		message: { role: "user", content: [{ type: "text", text }] },
	};
}

function assistant(id: string, parentId: string | null, text = id): TranscriptEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: `2026-08-01T00:01:${id.length.toString().padStart(2, "0")}.000Z`,
		message: { role: "assistant", content: [{ type: "text", text }] },
	};
}

function jsonl(entries: TranscriptEntry[], trailingNewline = true): string {
	return entries.map((entry) => JSON.stringify(entry)).join("\n") + (trailingNewline ? "\n" : "");
}

function materialize(source: string, entryId: string) {
	return materializeHistoryForkTranscript(source, entryId);
}

function expectValidationError(
	source: string,
	entryId: string,
	code: string,
	status: number,
): HistoryForkValidationError {
	let thrown: unknown;
	try {
		materialize(source, entryId);
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(HistoryForkValidationError);
	const validationError = thrown as HistoryForkValidationError;
	expect(validationError).toMatchObject({ code, status });
	return validationError;
}

describe("shared transcript tree", () => {
	it("preserves exact raw records while selecting the terminal leaf target's parent-linked branch", () => {
		const headerRaw = `  ${JSON.stringify(session())}\r\n`;
		const rootRaw = `${JSON.stringify(user("root", null))}\n`;
		const inactiveRaw = `\t${JSON.stringify(user("inactive", "root"))}\r\n`;
		const activeRaw = `${JSON.stringify(assistant("active", "root"))}  \n`;
		const leafRaw = `${JSON.stringify({
			type: "leaf",
			id: "leaf-control",
			parentId: "inactive",
			targetId: "active",
			timestamp: "2026-08-01T00:02:00.000Z",
		})}\n`;
		const parsed = parseTranscript(headerRaw + rootRaw + inactiveRaw + activeRaw + leafRaw);

		assert.equal(parsed.headers.length, 1);
		assert.equal(parsed.headers[0].raw, headerRaw);
		assert.equal(parsed.byId.get("inactive")?.raw, inactiveRaw);
		assert.deepEqual(
			activeTranscriptBranch(parsed).map((record) => record.id),
			["root", "active"],
		);
		assert.deepEqual(parsed.activeBranch.map((record) => record.id), ["root", "active"]);
		assert.deepEqual(parsed.anomalies, []);
	});
});

describe("history fork transcript materialization", () => {
	it("cuts exactly before the selected prompt and retains active raw model, tool, and compaction records byte-for-byte", () => {
		const richUsage = {
			input: 11,
			output: 7,
			reasoning: 4,
			totalTokens: 22,
			cost: { input: 0.1, output: 0.2, total: 0.3 },
		};
		const records: Array<{ entry: TranscriptEntry; ending: string; prefix?: string; suffix?: string }> = [
			{ entry: session(), ending: "\r\n", prefix: "  " },
			{ entry: user("first-user", null, "/skill keep\n@src/file.ts"), ending: "\n" },
			{ entry: user("inactive-user", "first-user", "abandoned"), ending: "\r\n", prefix: "\t" },
			{
				entry: {
					type: "model_change",
					id: "model-change",
					parentId: "first-user",
					provider: "anthropic",
					modelId: "claude-fixture",
					thinkingLevel: "high",
					futureMetadata: { preserve: true },
				},
				ending: "\n",
				suffix: "  ",
			},
			{
				entry: {
					type: "message",
					id: "assistant-tool",
					parentId: "model-change",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "fixture" } }],
						usage: richUsage,
					},
				},
				ending: "\r\n",
			},
			{
				entry: {
					type: "message",
					id: "tool-result",
					parentId: "assistant-tool",
					message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: "raw result" },
				},
				ending: "\n",
			},
			{
				entry: {
					type: "compaction",
					id: "compaction",
					parentId: "tool-result",
					summary: "raw summary",
					firstKeptEntryId: "first-user",
					retainedTail: [{ role: "assistant", content: "tail" }],
					usage: richUsage,
					additive: { untouched: true },
				},
				ending: "\r\n",
			},
			{ entry: user("selected-user", "compaction", "do not retain"), ending: "\n" },
			{ entry: assistant("later-assistant", "selected-user", "also discarded"), ending: "\r\n" },
			{
				entry: {
					type: "leaf",
					id: "leaf-control",
					parentId: "later-assistant",
					targetId: "later-assistant",
				},
				ending: "\n",
			},
		];
		const raw = records.map(({ entry, ending, prefix = "", suffix = "" }) => `${prefix}${JSON.stringify(entry)}${suffix}${ending}`);
		const source = raw.join("");
		const sourceBefore = `${source}`;
		const result = materialize(source, "selected-user");
		const expected = [raw[0], raw[1], raw[3], raw[4], raw[5], raw[6]].join("");

		assert.equal(result.content, expected);
		assert.equal(result.content.includes("inactive-user"), false);
		assert.equal(result.content.includes("selected-user"), false);
		assert.equal(result.content.includes("later-assistant"), false);
		assert.equal(result.content.includes("leaf-control"), false);
		assert.deepEqual(result.retainedEntryIds, new Set([
			"first-user",
			"model-change",
			"assistant-tool",
			"tool-result",
			"compaction",
		]));
		assert.deepEqual(result.retainedUserEntries.map((record) => record.id), ["first-user"]);
		assert.deepEqual(result.retainedCompactions.map((record) => record.id), ["compaction"]);
		assert.equal(result.selected.id, "selected-user");
		assert.equal(source, sourceBefore, "materialization must not mutate the source bytes");
	});

	it("emits only the exact session header when the selected prompt is the root", () => {
		const header = `\t${JSON.stringify(session())}  \r\n`;
		const selected = `${JSON.stringify(user("root-prompt", null))}\n`;
		const later = `${JSON.stringify(assistant("reply", "root-prompt"))}\n`;
		const result = materialize(header + selected + later, "root-prompt");

		assert.equal(result.content, header);
		assert.deepEqual(result.retainedEntryIds, new Set());
		assert.deepEqual(result.retainedUserEntries, []);
		assert.deepEqual(result.retainedCompactions, []);
	});

	it("distinguishes a missing cursor from a cursor on an inactive branch", () => {
		const source = jsonl([
			session(),
			user("root", null),
			user("inactive", "root"),
			assistant("active", "root"),
			{ type: "leaf", id: "leaf", parentId: "inactive", targetId: "active" },
		]);

		expectValidationError(source, "missing", "HISTORY_FORK_CURSOR_NOT_FOUND", 409);
		expectValidationError(source, "inactive", "HISTORY_FORK_CURSOR_INACTIVE", 409);
	});

	it.each([
		["assistant", assistant("selected", null)],
		["provider tool result", {
			type: "message",
			id: "selected",
			parentId: null,
			message: { role: "toolResult", toolCallId: "call-1", content: "result" },
		}],
		["user tool_result-only block", {
			type: "message",
			id: "selected",
			parentId: null,
			message: { role: "user", content: [{ type: "tool_result", toolCallId: "call-1", content: "result" }] },
		}],
		["non-message record", {
			type: "model_change",
			id: "selected",
			parentId: null,
			provider: "fixture",
			modelId: "fixture",
		}],
	] as const)("rejects a non-prompt %s cursor", (_label, selected) => {
		const source = jsonl([session(), selected]);
		expectValidationError(source, "selected", "HISTORY_FORK_CURSOR_NOT_USER", 422);
	});

	it("cuts safely before the newest ordinary user entry while streaming", () => {
		const source = jsonl([
			session(),
			user("older-user", null),
			assistant("older-reply", "older-user"),
			user("current-user", "older-reply"),
			assistant("partial-reply", "current-user"),
		]);

		const older = materialize(source, "older-user");
		assert.equal(older.content, `${JSON.stringify(session())}\n`);
		const current = materialize(source, "current-user");
		assert.equal(current.selected.id, "current-user");
		assert.equal(current.content, jsonl([
			session(),
			user("older-user", null),
			assistant("older-reply", "older-user"),
		]));
	});

	it.each([
		["malformed complete line", `${jsonl([session(), user("selected", null)])}{not-json}\n`],
		["non-object JSON line", `${jsonl([session(), user("selected", null)])}["not", "an", "entry"]\n`],
		["duplicate ids", jsonl([session(), user("selected", null), assistant("selected", "selected")])],
		["missing parent", jsonl([session(), user("selected", "missing-parent")])],
		["cycle", jsonl([
			session(),
			user("selected", "cycle-b"),
			assistant("cycle-b", "selected"),
		])],
		["parent recorded after child", jsonl([
			session(),
			user("selected", "later-parent"),
			assistant("later-parent", null),
		])],
		["missing session header", jsonl([user("selected", null)])],
		["session header after a tree entry", jsonl([user("selected", null), session()])],
		["duplicate session headers", jsonl([session("one"), session("two"), user("selected", null)])],
	] as const)("fails closed on an invalid transcript with %s", (_label, source) => {
		expectValidationError(source, "selected", "HISTORY_FORK_TRANSCRIPT_INVALID", 409);
	});

	it("uses one immutable snapshot even when complete records are appended later", () => {
		const original = jsonl([
			session(),
			user("root", null),
			user("selected", "root"),
			assistant("selected-reply", "selected"),
		]);
		const snapshot = original;
		const currentBytes = original + jsonl([
			user("new-branch", "root"),
			{ type: "leaf", id: "leaf", parentId: "new-branch", targetId: "new-branch" },
		]);

		const fromSnapshot = materialize(snapshot, "selected");
		assert.equal(fromSnapshot.content, `${JSON.stringify(session())}\n${JSON.stringify(user("root", null))}\n`);
		assert.equal(fromSnapshot.content.includes("new-branch"), false);
		assert.equal(snapshot, original);
		expectValidationError(currentBytes, "selected", "HISTORY_FORK_CURSOR_INACTIVE", 409);
	});

	it("ignores one malformed unterminated append fragment but rejects it once complete", () => {
		const stable = jsonl([
			session(),
			user("root", null),
			user("selected", "root"),
			assistant("reply", "selected"),
		]);
		const partialAppend = `${stable}{"type":"message","id":"concurrent`;
		const expected = `${JSON.stringify(session())}\n${JSON.stringify(user("root", null))}\n`;

		assert.equal(materialize(partialAppend, "selected").content, expected);
		expectValidationError(`${partialAppend}\n`, "selected", "HISTORY_FORK_TRANSCRIPT_INVALID", 409);
	});
});
