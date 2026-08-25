import { describe, expect, it } from "vitest";
import { buildAskResponseEnvelope } from "../../src/shared/ask-envelope.js";
import {
	deriveTranscriptNavigation,
	filterTranscriptEntries,
	selectUnansweredTarget,
	transcriptMessageIdentity,
	transcriptMessageTargetId,
	type TranscriptHistoryEntry,
} from "../../src/ui/transcript-history.js";
import { classifyAskUserChoicesState } from "../../src/ui/tools/ask-user-choices-state.js";

const USER = { kind: "user" as const, id: "user:local", label: "User" };
const AGENT = { kind: "agent" as const, id: "session:worker", label: "Coder" };
const SYSTEM = { kind: "system" as const, id: "system:bobbit", label: "Bobbit" };
const answer = [{ question: "Ship it?", selected: "Yes", other_text: null }];
const questionParams = (question = "Ship it?") => ({
	questions: [{ question, options: ["Yes", "No"] }],
});
const ask = (id: string, params = questionParams()) => ({
	type: "toolCall",
	id,
	name: "ask_user_choices",
	arguments: params,
});
const result = (toolCallId: string, value: unknown, isError = false) => ({
	role: "toolResult",
	toolCallId,
	toolName: "ask_user_choices",
	content: [{ type: "text", text: JSON.stringify(value) }],
	isError,
	timestamp: 1,
});

describe("ask_user_choices shared lifecycle", () => {
	it("preserves pending, posted, answered, legacy, and terminal failure semantics", () => {
		expect(classifyAskUserChoicesState(undefined, null)).toEqual({
			posted: false, answers: null, failed: false, unresolved: true,
		});
		expect(classifyAskUserChoicesState(result("a", { status: "posted" }) as any, null)).toMatchObject({
			posted: true, failed: false, unresolved: true,
		});
		expect(classifyAskUserChoicesState(result("a", { status: "posted" }) as any, answer)).toMatchObject({
			posted: true, answers: answer, failed: false, unresolved: false,
		});
		expect(classifyAskUserChoicesState(result("a", { answers: answer }) as any, null)).toMatchObject({
			posted: false, answers: answer, failed: false, unresolved: false,
		});
		expect(classifyAskUserChoicesState(result("a", { error: "bad" }, true) as any, null)).toMatchObject({
			failed: true, unresolved: false,
		});
		expect(classifyAskUserChoicesState(result("a", { error: "bad" }) as any, null)).toMatchObject({
			failed: true, unresolved: false,
		});
	});

	it("rejects malformed legacy answers without weakening terminal failure defense", () => {
		const malformed = result("a", {
			answers: [{ question: "Ship it?", selected: ["Yes", 1], other_text: null }],
		});
		expect(classifyAskUserChoicesState(malformed as any, null)).toMatchObject({
			answers: null, failed: true, unresolved: false,
		});
	});
});

describe("transcript history projection", () => {
	it("keeps authoritative input chronology and classifies trusted authors and visible types", () => {
		const messages = [
			{ id: "u1", role: "user", content: "Human prompt", author: USER },
			{ id: "a1", role: "assistant", content: [{ type: "text", text: "Primary response" }], author: AGENT },
			{ id: "p1", role: "user", content: "Agent handoff", author: AGENT },
			{ id: "s1", role: "user", content: "System instruction", author: SYSTEM },
			{ id: "n1", role: "system-notification", message: "Session restarted", author: SYSTEM },
			{ id: "m1", role: "mutation-pending", summary: "Approve a fix-up", author: SYSTEM },
			{ id: "e1", role: "error", content: "Provider failed", author: SYSTEM },
			{ id: "a2", role: "assistant", content: [
				{ type: "toolCall", id: "ordinary", name: "read", arguments: { path: "x" } },
				ask("q1", questionParams("Choose a release channel")),
			] },
			result("ordinary", "noise"),
		];
		const projected = deriveTranscriptNavigation(messages as any);

		expect(projected.entries.map((entry) => [entry.kind, entry.typeLabel, entry.excerpt])).toEqual([
			["user", "Prompt", "Human prompt"],
			["agent", "Response", "Primary response"],
			["agent", "Agent prompt", "Agent handoff"],
			["system", "System prompt", "System instruction"],
			["system", "System event", "Session restarted"],
			["system", "System event", "Approve a fix-up"],
			["system", "Error", "Provider failed"],
			["question", "Multiple-choice question", "Choose a release channel"],
		]);
		expect(projected.entries.map((entry) => entry.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		expect(projected.unresolvedQuestions).toHaveLength(1);
	});

	it("keeps text and special assistant blocks in content order while omitting ordinary tools", () => {
		const projected = deriveTranscriptNavigation([{
			id: "mixed",
			role: "assistant",
			content: [
				{ type: "text", text: "Before" },
				ask("q1"),
				{ type: "toolCall", id: "r1", name: "read", arguments: {} },
				{ type: "text", text: "After" },
				{ type: "toolCall", id: "clear", name: "__context_cleared", arguments: { clearId: "c1" } },
			],
		}] as any);
		expect(projected.entries.map((entry) => [entry.kind, entry.excerpt])).toEqual([
			["agent", "Before"],
			["question", "Ship it?"],
			["agent", "After"],
			["system", "Context cleared"],
		]);
	});

	it("reconciles provider-style results without dropping mixed visible user text", () => {
		const projected = deriveTranscriptNavigation([
			{
				id: "ask-row",
				role: "assistant",
				content: [ask("mixed-result", questionParams("Choose a target"))],
			},
			{
				id: "mixed-user-row",
				role: "user",
				author: USER,
				content: [
					{
						type: "tool_result",
						tool_use_id: "mixed-result",
						content: JSON.stringify({ answers: answer }),
					},
					{ type: "text", text: "Please continue with the selected target" },
				],
			},
		] as any);

		expect(projected.entries.map((entry) => [entry.kind, entry.excerpt, entry.unresolved])).toEqual([
			["question", "Choose a target", false],
			["user", "Please continue with the selected target", false],
		]);
		expect(projected.entries.filter((entry) => entry.kind === "user")).toHaveLength(1);
		expect(projected.unresolvedQuestions).toEqual([]);
	});

	it("derives unresolved state only from later matching results and valid response envelopes", () => {
		const messages = [
			{ role: "user", content: buildAskResponseEnvelope("before", answer) },
			{ id: "asks", role: "assistant", content: [
				ask("before", questionParams("Preceding envelope")),
				ask("answered", questionParams("Answered later")),
				ask("failed", questionParams("Failed call")),
				ask("legacy", questionParams("Legacy call")),
				ask("team|composite-1", questionParams("Composite call")),
			] },
			result("before", { status: "posted" }),
			result("answered", { status: "posted" }),
			{ role: "user", content: "[ask_user_choices_response tool_use_id=answered]\nnot-json" },
			{ role: "user", content: buildAskResponseEnvelope("answered", answer) },
			result("failed", { error: "no" }, true),
			result("legacy", { answers: answer }),
			result("team|composite-1", { status: "posted" }),
		];
		const projected = deriveTranscriptNavigation(messages as any);
		const questions = projected.entries.filter((entry) => entry.kind === "question");

		expect(questions.map((entry) => [entry.excerpt, entry.unresolved])).toEqual([
			["Preceding envelope", true],
			["Answered later", false],
			["Failed call", false],
			["Legacy call", false],
			["Composite call", true],
		]);
		expect(projected.unresolvedQuestions.map((entry) => entry.excerpt)).toEqual([
			"Preceding envelope", "Composite call",
		]);
		expect(projected.entries.some((entry) => entry.excerpt.includes("ask_user_choices_response"))).toBe(false);
	});

	it("accepts current arguments and legacy input calls but rejects malformed calls and ids", () => {
		const projected = deriveTranscriptNavigation([{
			id: "a1",
			role: "assistant",
			content: [
				ask("good"),
				{ type: "tool_use", id: "legacy", name: "ask_user_choices", input: questionParams("Legacy input") },
				ask("bad id!"),
				ask("missing-options", { questions: [{ question: "No options" }] } as any),
				ask("missing-tabs", { questions: [
					{ question: "One", options: ["a", "b"] },
					{ question: "Two", options: ["a", "b"] },
				] }),
			],
		}] as any);
		expect(projected.entries.map((entry) => entry.excerpt)).toEqual(["Ship it?", "Legacy input"]);
	});

	it("normalizes and bounds excerpts", () => {
		const long = `  first\n\t${"x".repeat(240)}  `;
		const [entry] = deriveTranscriptNavigation([{ id: "u", role: "user", content: long }] as any).entries;
		expect(entry.excerpt.startsWith("first x")).toBe(true);
		expect(entry.excerpt.endsWith("…")).toBe(true);
		expect(entry.excerpt.length).toBe(180);
	});
});

describe("transcript target identity", () => {
	it("prefers durable ids and includes reducer metadata plus ordinal in fallback identity", () => {
		expect(transcriptMessageIdentity({ id: "message-1", _order: 99 }, 4)).toBe("message-1");
		expect(transcriptMessageTargetId({ id: "message-1" }, 4)).toBe("message:message-1");
		expect(transcriptMessageIdentity({ _origin: "server", _order: 12, _insertionTick: 3 }, 4))
			.toBe("synth:server:12:3:4");
		expect(transcriptMessageIdentity({ _origin: "server", _order: 12, _insertionTick: 3 }, 5))
			.not.toBe(transcriptMessageIdentity({ _origin: "server", _order: 12, _insertionTick: 3 }, 4));
	});
});

describe("transcript history filtering and unanswered targeting", () => {
	const entries: TranscriptHistoryEntry[] = [
		{ id: "1", targetId: "u", ordinal: 0, kind: "user", authorLabel: "User", typeLabel: "Prompt", excerpt: "Deploy production", unresolved: false },
		{ id: "2", targetId: "a", ordinal: 1, kind: "agent", authorLabel: "Coder", typeLabel: "Response", excerpt: "Production is ready", unresolved: false },
		{ id: "3", targetId: "q1", ordinal: 2, kind: "question", authorLabel: "Coder", typeLabel: "Multiple-choice question", excerpt: "Choose region", unresolved: true },
		{ id: "4", targetId: "q2", ordinal: 3, kind: "question", authorLabel: "Coder", typeLabel: "Multiple-choice question", excerpt: "Choose tier", unresolved: true },
	];

	it("composes author/type filter with normalized case-insensitive search", () => {
		expect(filterTranscriptEntries(entries, "all", "  PRODUCTION ").map((entry) => entry.id)).toEqual(["1", "2"]);
		expect(filterTranscriptEntries(entries, "agent", "production").map((entry) => entry.id)).toEqual(["2"]);
		expect(filterTranscriptEntries(entries, "question", " coder   multiple-choice ").map((entry) => entry.id)).toEqual(["3", "4"]);
		expect(filterTranscriptEntries(entries, "system", "production")).toEqual([]);
	});

	it("selects the nearest fully-above question and otherwise the newest unresolved question", () => {
		const rects = new Map([
			["q1", { bottom: 120 }],
			["q2", { bottom: 240 }],
		]);
		expect(selectUnansweredTarget(entries.slice(2), rects, 250)?.id).toBe("4");
		expect(selectUnansweredTarget(entries.slice(2), rects, 200)?.id).toBe("3");
		expect(selectUnansweredTarget(entries.slice(2), rects, 100)?.id).toBe("4");
		expect(selectUnansweredTarget([], rects, 100)).toBeNull();
	});
});
