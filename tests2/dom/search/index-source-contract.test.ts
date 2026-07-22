import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
/**
 * Shared contract runner for `IndexSource` implementations.
 *
 * Applied to: GoalIndexSource, SessionIndexSource, StaffIndexSource,
 * MessageIndexSource, and FilesIndexSourceStub.
 *
 * Verifies per design §3 + §5:
 *   - `iterate(ctx)` returns an AsyncIterable.
 *   - Every yielded `Indexable` has required fields populated.
 *   - `weight` is in the sensible 0.5–3.0 range.
 *   - `id` is non-empty and prefixed by the source-specific namespace.
 *   - `contentHash` is deterministic: re-running iterate with identical
 *     store state produces identical hashes.
 *   - Empty / missing content produces no output (no zero-text rows).
 */

import { describe, expect, test, vi } from "vitest";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { Readable } from "node:stream";

import { GoalIndexSource } from "../../../src/server/search/sources/goal-source.ts";
import { SessionIndexSource } from "../../../src/server/search/sources/session-source.ts";
import { StaffIndexSource } from "../../../src/server/search/sources/staff-source.ts";
import { MessageIndexSource } from "../../../src/server/search/sources/message-source.ts";
import { FilesIndexSourceStub } from "../../../src/server/search/sources/files-source.stub.ts";
import { formatSessionSearchTitle } from "../../../src/server/search/sources/session-title.ts";
import { indexableToDoc } from "../../../src/server/search/indexer.ts";
import { toSearchResult } from "../../../src/server/search/flex-store.ts";
import type { IndexSource, IndexSourceContext, Indexable } from "../../../src/server/search/types.ts";
import type { PersistedGoal, GoalStore } from "../../../src/server/agent/goal-store.ts";
import type { PersistedSession, SessionStore } from "../../../src/server/agent/session-store.ts";
import type { PersistedStaff, StaffStore } from "../../../src/server/agent/staff-store.ts";
import { installScopedMemoryFs } from "../../core/helpers/scoped-memory-fs.ts";

// ── In-memory fake stores ────────────────────────────────────────────

function fakeGoalStore(goals: PersistedGoal[]): GoalStore {
	return { getAll: () => goals } as unknown as GoalStore;
}
function fakeSessionStore(sessions: PersistedSession[]): SessionStore {
	return { getAll: () => sessions } as unknown as SessionStore;
}
function fakeStaffStore(staff: PersistedStaff[]): StaffStore {
	return { getAll: () => staff } as unknown as StaffStore;
}

function makeCtx(opts: {
	goals?: PersistedGoal[];
	sessions?: PersistedSession[];
	staff?: PersistedStaff[];
	projectId?: string;
}): IndexSourceContext {
	return {
		projectId: opts.projectId ?? "proj-test",
		goalStore: fakeGoalStore(opts.goals ?? []),
		sessionStore: fakeSessionStore(opts.sessions ?? []),
		staffStore: fakeStaffStore(opts.staff ?? []),
	};
}

async function collect(src: IndexSource, ctx: IndexSourceContext): Promise<Indexable[]> {
	const out: Indexable[] = [];
	for await (const i of src.iterate(ctx)) out.push(i);
	return out;
}

function assertValidIndexable(i: Indexable, sourceId: Indexable["sourceId"], idPrefix: string): void {
	expect(i.id, "id must be non-empty").toBeTruthy();
	expect(i.id.startsWith(idPrefix), `id "${i.id}" must start with "${idPrefix}"`).toBe(true);
	expect(i.sourceId).toBe(sourceId);
	expect(typeof i.text).toBe("string");
	expect(i.text.length).toBeGreaterThan(0);
	expect(i.metadata && typeof i.metadata === "object").toBe(true);
	expect(typeof i.contentHash).toBe("string");
	expect(i.contentHash.length).toBe(64); // sha256 hex
	expect(typeof i.timestamp).toBe("number");
	expect(typeof i.projectId).toBe("string");
	expect(i.projectId.length).toBeGreaterThan(0);
	expect(typeof i.weight).toBe("number");
	expect(i.weight).toBeGreaterThanOrEqual(0.5);
	expect(i.weight).toBeLessThanOrEqual(3.0);
}

// ── Fixtures ─────────────────────────────────────────────────────────

const goals: PersistedGoal[] = [
	{
		id: "g1",
		title: "First goal",
		cwd: "/tmp",
		state: "in-progress",
		spec: "Build the thing that does the thing.",
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_010_000,
		projectId: "proj-a",
	},
	{
		id: "g2",
		title: "",
		cwd: "/tmp",
		state: "todo",
		spec: "",
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
	},
	{
		id: "g3-archived",
		title: "Archived goal",
		cwd: "/tmp",
		state: "complete",
		spec: "Old work.",
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_005_000,
		archived: true,
		archivedAt: 1_700_000_007_000,
	},
];

const sessions: PersistedSession[] = [
	{
		id: "s1",
		title: "Working on the thing",
		cwd: "/tmp",
		agentSessionFile: "", // no file — message source should skip gracefully
		createdAt: 1_700_000_000_000,
		lastActivity: 1_700_000_500_000,
		goalId: "g1",
		projectId: "proj-a",
	},
	{
		id: "s2-no-title",
		title: "",
		cwd: "/tmp",
		agentSessionFile: "",
		createdAt: 1_700_000_000_000,
		lastActivity: 1_700_000_000_000,
	},
];

const staff: PersistedStaff[] = [
	{
		id: "staff1",
		name: "Nightly Reviewer",
		description: "Checks PRs after midnight.",
		systemPrompt: "You review.",
		cwd: "/tmp",
		state: "active",
		triggers: [],
		memory: "",
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_100_000,
		projectId: "proj-a",
		accessory: "",
		sandboxed: false,
	},
	{
		id: "staff2-empty",
		name: "",
		description: "",
		systemPrompt: "",
		cwd: "/tmp",
		state: "paused",
		triggers: [],
		memory: "",
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
		accessory: "",
		sandboxed: false,
	},
];

// ── Goal source ──────────────────────────────────────────────────────

describe("GoalIndexSource", () => {
	test("yields valid Indexables and skips empty goals", async () => {
		const ctx = makeCtx({ goals });
		const src = new GoalIndexSource();
		expect(src.sourceId).toBe("goals");
		const out = await collect(src, ctx);
		expect(out.length).toBe(2); // g2 skipped (no title + no spec)
		for (const i of out) assertValidIndexable(i, "goals", "goal:");
		const g1 = out.find((o) => o.id === "goal:g1")!;
		expect(g1.weight).toBe(2.5);
		expect(g1.role).toBe("spec");
		expect(g1.text).toBe("First goal\n\nBuild the thing that does the thing.");
		expect(g1.projectId).toBe("proj-a");
		expect(g1.archived).toBe(false);
		const archived = out.find((o) => o.id === "goal:g3-archived")!;
		expect(archived.archived).toBe(true);
	});

	test("contentHash stable under unchanged input", async () => {
		const ctx = makeCtx({ goals });
		const a = await collect(new GoalIndexSource(), ctx);
		const b = await collect(new GoalIndexSource(), makeCtx({ goals }));
		expect(a.map((i) => i.contentHash)).toEqual(b.map((i) => i.contentHash));
	});
});

// ── Session source ───────────────────────────────────────────────────

describe("SessionIndexSource", () => {
	test("yields valid Indexables and skips untitled sessions", async () => {
		const ctx = makeCtx({ goals, sessions });
		const src = new SessionIndexSource();
		expect(src.sourceId).toBe("sessions");
		const out = await collect(src, ctx);
		expect(out.length).toBe(1);
		const s1 = out[0];
		assertValidIndexable(s1, "sessions", "session:");
		expect(s1.weight).toBe(3.0);
		expect(s1.role).toBe("title");
		expect(s1.text).toBe("Working on the thing");
		expect(s1.metadata.goalId).toBe("g1");
		expect(s1.metadata.goalTitle).toBe("First goal");
		expect(s1.projectId).toBe("proj-a");
	});

	test("formats goal-owned session display titles once", async () => {
		const ctx = makeCtx({ goals, sessions });
		const [s1] = await collect(new SessionIndexSource(), ctx);
		expect(s1.text).toBe("Working on the thing");
		expect(s1.display?.title, "direct session result title should include its goal context").toBe("First goal: Working on the thing");
		expect(s1.display?.snippet, "direct session result snippet should use the same formatted title").toBe("First goal: Working on the thing");

		const alreadyPrefixed = await collect(new SessionIndexSource(), makeCtx({
			goals,
			sessions: [{ ...sessions[0], title: "First goal: Working on the thing" }],
		}));
		expect(alreadyPrefixed[0].display?.title, "goal prefix should not be duplicated").toBe("First goal: Working on the thing");
	});

	test("does not treat goal title substrings as existing prefixes", () => {
		expect(formatSessionSearchTitle("Prefix search", "Fix")).toBe("Fix: Prefix search");
		expect(formatSessionSearchTitle("guide updates", "UI")).toBe("UI: guide updates");
		expect(formatSessionSearchTitle("Fix: Prefix search", "Fix")).toBe("Fix: Prefix search");
		expect(formatSessionSearchTitle("Prefix search for Fix", "Fix")).toBe("Prefix search for Fix");
		expect(formatSessionSearchTitle("Build the UI guide", "UI")).toBe("Build the UI guide");
	});

	test("contentHash stable under unchanged input", async () => {
		const ctx = makeCtx({ goals, sessions });
		const a = await collect(new SessionIndexSource(), ctx);
		const b = await collect(new SessionIndexSource(), makeCtx({ goals, sessions }));
		expect(a.map((i) => i.contentHash)).toEqual(b.map((i) => i.contentHash));
	});
});

// ── Staff source ─────────────────────────────────────────────────────

describe("StaffIndexSource", () => {
	test("yields valid Indexables and skips empty staff", async () => {
		const ctx = makeCtx({ staff });
		const src = new StaffIndexSource();
		expect(src.sourceId).toBe("staff");
		const out = await collect(src, ctx);
		expect(out.length).toBe(1);
		const s = out[0];
		assertValidIndexable(s, "staff", "staff:");
		expect(s.weight).toBe(1.5);
		expect(s.role).toBe("profile");
		expect(s.text).toBe("Nightly Reviewer\n\nChecks PRs after midnight.");
	});

	test("contentHash stable under unchanged input", async () => {
		const a = await collect(new StaffIndexSource(), makeCtx({ staff }));
		const b = await collect(new StaffIndexSource(), makeCtx({ staff }));
		expect(a.map((i) => i.contentHash)).toEqual(b.map((i) => i.contentHash));
	});
});

// ── Message source ───────────────────────────────────────────────────

describe("MessageIndexSource", () => {
	test("skips sessions without an agentSessionFile or with a missing file", async () => {
		const ctx = makeCtx({
			sessions: [
				{ ...sessions[0], agentSessionFile: "" },
				{ ...sessions[0], id: "s-missing", agentSessionFile: path.join(os.tmpdir(), "definitely-does-not-exist-" + Date.now() + ".jsonl") },
			],
		});
		const out = await collect(new MessageIndexSource(), ctx);
		expect(out.length).toBe(0);
	});

	test("reads .jsonl and applies content policy", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msg-source-"));
		const file = path.join(dir, "session.jsonl");
		const lines = [
			JSON.stringify({
				message: {
					role: "user",
					content: "Hello there",
					timestamp: 1_700_000_100_000,
				},
			}),
			JSON.stringify({
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Sure, let me <thinking>plan</thinking> do it." },
						{ type: "tool_use", name: "write", input: { path: "a.txt", content: "x" } },
					],
					timestamp: 1_700_000_200_000,
				},
			}),
			"", // blank line — must be tolerated
			"not-json", // junk line — must be tolerated
		];
		fs.writeFileSync(file, lines.join("\n"), "utf-8");

		const ctx = makeCtx({
			sessions: [
				{
					id: "s1",
					title: "Chat",
					cwd: "/tmp",
					agentSessionFile: file,
					createdAt: 1_700_000_000_000,
					lastActivity: 1_700_000_200_000,
					projectId: "proj-a",
				},
			],
		});
		const out = await collect(new MessageIndexSource(), ctx);
		// 1 user text + 1 assistant text (stripped) + 1 tool_use = 3
		expect(out.length).toBe(3);
		for (const i of out) assertValidIndexable(i, "messages", "message:s1:");

		const user = out.find((o) => o.role === "user")!;
		expect(user.text).toBe("Hello there");
		expect(user.weight).toBe(2.0);
		expect(user.id).toBe("message:s1:0:text:0");
		expect(user.metadata.sessionTitle, "message rows should carry parent session title metadata").toBe("Chat");

		const assistant = out.find((o) => o.role === "assistant")!;
		expect(assistant.weight).toBe(1.0);
		expect(assistant.text.includes("<thinking>")).toBe(false);

		const toolCall = out.find((o) => o.role === "tool_call")!;
		expect(toolCall.weight).toBe(0.8);
		expect(toolCall.text.startsWith("write ")).toBe(true);

		// Cleanup
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("indexes inferred and sidecar-resolved authors without changing text or weights", async () => {
		const restoreFs = installScopedMemoryFs();
		const file = path.resolve("/memory/message-author-source/session.jsonl");
		const transcript = [
			{ id: "human-message", message: { role: "user", content: "HumanPromptSearchToken" } },
			{ id: "assistant-message", message: { role: "assistant", content: "AssistantSearchToken" } },
			{ id: "system-message", message: { role: "user", content: "SystemPromptSearchToken" } },
		].map((row) => JSON.stringify(row)).join("\n") + "\n";
		const streamSpy = vi.spyOn(fs, "createReadStream").mockImplementation((streamPath) => {
			return Readable.from([fs.readFileSync(streamPath, "utf-8")]) as fs.ReadStream;
		});
		syncBuiltinESMExports();

		try {
			fs.writeFileSync(file, transcript, "utf-8");
			const source = new MessageIndexSource(() => [{
				schemaVersion: 1,
				type: "prompt-author",
				promptId: "system-prompt",
				dispatchedAt: 100,
				modelText: "SystemPromptSearchToken",
				source: "task-notification",
				author: { kind: "system", id: "system:bobbit", label: "Bobbit" },
				settlement: {
					schemaVersion: 1,
					type: "prompt-author-settlement",
					promptId: "system-prompt",
					settledAt: 101,
					outcome: "echoed",
					messageId: "system-message",
				},
			}]);

			const messages = await collect(source, makeCtx({
				sessions: [{
					id: "system-session",
					title: "System session",
					cwd: "/tmp",
					agentSessionFile: file,
					createdAt: 1,
					lastActivity: 2,
				}],
			}));
			expect(messages.map(({ text, role, weight }) => ({ text, role, weight }))).toEqual([
				{ text: "HumanPromptSearchToken", role: "user", weight: 2.0 },
				{ text: "AssistantSearchToken", role: "assistant", weight: 1.0 },
				{ text: "SystemPromptSearchToken", role: "user", weight: 2.0 },
			]);
			expect(messages.map((message) => ({
				kind: message.metadata.authorKind,
				id: message.metadata.authorId,
				label: message.metadata.authorLabel,
			}))).toEqual([
				{ kind: "user", id: "user:local", label: "User" },
				{ kind: "agent", id: "session:system-session", label: "System session" },
				{ kind: "system", id: "system:bobbit", label: "Bobbit" },
			]);
			expect(messages.map((message) => message.text).join(" ")).not.toContain("Bobbit");
			expect(messages.map((message) => message.text).join(" ")).not.toContain("System session");
		} finally {
			streamSpy.mockRestore();
			restoreFs();
			syncBuiltinESMExports();
		}
	});

	test("streams oversized same-text rows with sidecar authors and reserved later keys", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msg-source-stream-authors-"));
		const file = path.join(dir, "session.jsonl");
		const repeatedText = "OversizedSameTextSearchToken";
		const transcript = [
			{
				id: "older-fifo-user",
				message: {
					role: "user",
					content: [
						{ type: "text", text: repeatedText },
						{ type: "image", data: "a".repeat(2_048), mimeType: "image/png" },
					],
					attachments: [{ type: "image", content: "b".repeat(2_048) }],
					author: { kind: "system", id: "system:forged", label: "Forged" },
				},
			},
			{
				id: "tool-result",
				message: {
					role: "user",
					content: [{ type: "tool_result", content: "AccountableToolResultToken" }],
				},
			},
			{
				id: "timestamp-agent",
				message: {
					role: "user",
					content: repeatedText,
					timestamp: 5_000,
					author: { kind: "user", id: "user:forged", label: "Forged" },
				},
			},
			{
				id: "later-exact-system",
				message: {
					role: "user",
					content: repeatedText,
					timestamp: 9_000,
					author: { kind: "user", id: "user:forged", label: "Forged" },
				},
			},
			{
				id: "following-assistant",
				message: { role: "assistant", content: "FollowingAssistantSearchToken" },
			},
		].map((row) => JSON.stringify(row)).join("\n") + "\n";
		fs.writeFileSync(file, transcript, "utf-8");

		const systemAuthor = { kind: "system" as const, id: "system:bobbit", label: "Bobbit" };
		const callerAuthor = { kind: "agent" as const, id: "session:caller", label: "Caller" };
		const localAuthor = { kind: "user" as const, id: "user:local", label: "User" };
		const bindings = [
			{
				schemaVersion: 1 as const,
				type: "prompt-author" as const,
				promptId: "later-system",
				dispatchedAt: 100,
				modelText: repeatedText,
				source: "system" as const,
				author: systemAuthor,
				settlement: {
					schemaVersion: 1 as const,
					type: "prompt-author-settlement" as const,
					promptId: "later-system",
					settledAt: 9_100,
					outcome: "echoed" as const,
					messageId: "later-exact-system",
				},
			},
			{
				schemaVersion: 1 as const,
				type: "prompt-author" as const,
				promptId: "older-user",
				dispatchedAt: 200,
				modelText: repeatedText,
				source: "user" as const,
				author: localAuthor,
				settlement: {
					schemaVersion: 1 as const,
					type: "prompt-author-settlement" as const,
					promptId: "older-user",
					settledAt: 50_000,
					outcome: "echoed" as const,
				},
			},
			{
				schemaVersion: 1 as const,
				type: "prompt-author" as const,
				promptId: "timestamp-agent",
				dispatchedAt: 300,
				modelText: repeatedText,
				source: "agent" as const,
				author: callerAuthor,
				settlement: {
					schemaVersion: 1 as const,
					type: "prompt-author-settlement" as const,
					promptId: "timestamp-agent",
					settledAt: 5_100,
					outcome: "echoed" as const,
					messageTimestamp: 5_000,
				},
			},
		];
		const readBindings = vi.fn((_sessionId: string) => bindings);
		const ctx = makeCtx({
			sessions: [{
				id: "oversized-session",
				title: "Oversized chat",
				cwd: "/tmp",
				agentSessionFile: file,
				createdAt: 1,
				lastActivity: 2,
			}],
		});

		try {
			const normal = await collect(new MessageIndexSource(readBindings), ctx);
			const lowCap = await collect(new MessageIndexSource(readBindings, {
				maxRetainedBytes: 1,
				maxRetainedRows: 1,
				maxAuthorBindings: 3,
				maxAuthorBindingBytes: 4_096,
			}), ctx);

			expect(readBindings).toHaveBeenCalledTimes(2);
			expect(lowCap.map(({ id, text, role }) => ({ id, text, role }))).toEqual([
				{ id: "message:oversized-session:0:text:0", text: repeatedText, role: "user" },
				{ id: "message:oversized-session:1:tool_result:0", text: "AccountableToolResultToken", role: "tool_result" },
				{ id: "message:oversized-session:2:text:0", text: repeatedText, role: "user" },
				{ id: "message:oversized-session:3:text:0", text: repeatedText, role: "user" },
				{ id: "message:oversized-session:4:text:0", text: "FollowingAssistantSearchToken", role: "assistant" },
			]);
			const authors = (rows: Indexable[]) => rows.map((message) => ({
				kind: message.metadata.authorKind,
				id: message.metadata.authorId,
				label: message.metadata.authorLabel,
			}));
			expect(authors(lowCap)).toEqual([
				{ kind: "user", id: "user:local", label: "User" },
				{ kind: "user", id: "user:local", label: "User" },
				{ kind: "agent", id: "session:caller", label: "Caller" },
				{ kind: "system", id: "system:bobbit", label: "Bobbit" },
				{ kind: "agent", id: "session:oversized-session", label: "Oversized chat" },
			]);
			expect(authors(lowCap)).toEqual(authors(normal));
			expect(lowCap.some((message) => String(message.metadata.authorId).includes("forged"))).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("omits ambiguous prompt authors when compact sidecar correlation exceeds its cap", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msg-source-binding-cap-"));
		const file = path.join(dir, "session.jsonl");
		fs.writeFileSync(file, [
			JSON.stringify({ id: "system-row", message: {
				role: "user",
				content: "SystemBindingCapToken",
				author: { kind: "agent", id: "session:forged", label: "Forged" },
			} }),
			JSON.stringify({ id: "ambiguous-tool-row", message: {
				role: "user",
				content: [{ type: "tool_result", content: "AmbiguousToolResultToken" }],
				author: { kind: "user", id: "user:forged", label: "Forged" },
			} }),
			JSON.stringify({ id: "assistant-row", message: {
				role: "assistant",
				content: [
					{ type: "text", text: "SafeAssistantToken" },
					{ type: "tool_use", name: "read", input: { path: "safe.txt" } },
				],
				author: { kind: "system", id: "system:forged", label: "Forged" },
			} }),
			JSON.stringify({ id: "safe-tool-row", message: {
				role: "user",
				content: [{ type: "tool_result", content: "SafeToolResultToken" }],
			} }),
			JSON.stringify({ id: "agent-row", message: {
				role: "user",
				content: "AgentBindingCapToken",
				author: { kind: "system", id: "system:forged", label: "Forged" },
			} }),
		].join("\n") + "\n", "utf-8");
		const binding = (promptId: string, text: string, messageId: string, kind: "system" | "agent") => ({
			schemaVersion: 1 as const,
			type: "prompt-author" as const,
			promptId,
			dispatchedAt: 1,
			modelText: text,
			source: kind,
			author: kind === "system"
				? { kind, id: "system:bobbit", label: "Bobbit" }
				: { kind, id: "session:caller", label: "Caller" },
			settlement: {
				schemaVersion: 1 as const,
				type: "prompt-author-settlement" as const,
				promptId,
				settledAt: 2,
				outcome: "echoed" as const,
				messageId,
			},
		});
		const readBindings = vi.fn(() => [
			binding("system", "SystemBindingCapToken", "system-row", "system"),
			binding("agent", "AgentBindingCapToken", "agent-row", "agent"),
		]);

		try {
			const messages = await collect(new MessageIndexSource(readBindings, {
				maxAuthorBindings: 1,
			}), makeCtx({
				sessions: [{
					id: "binding-cap-session",
					title: "Binding cap chat",
					cwd: "/tmp",
					agentSessionFile: file,
					createdAt: 1,
					lastActivity: 2,
				}],
			}));

			expect(readBindings).toHaveBeenCalledOnce();
			expect(messages.map(({ text, role, metadata }) => ({
				text,
				role,
				msgIdx: metadata.msgIdx,
				blockKey: metadata.blockKey,
			}))).toEqual([
				{ text: "SystemBindingCapToken", role: "user", msgIdx: 0, blockKey: "text:0" },
				{ text: "AmbiguousToolResultToken", role: "tool_result", msgIdx: 1, blockKey: "tool_result:0" },
				{ text: "SafeAssistantToken", role: "assistant", msgIdx: 2, blockKey: "text:0" },
				{ text: "read {\"path\":\"safe.txt\"}", role: "tool_call", msgIdx: 2, blockKey: "tool_use:1" },
				{ text: "SafeToolResultToken", role: "tool_result", msgIdx: 3, blockKey: "tool_result:0" },
				{ text: "AgentBindingCapToken", role: "user", msgIdx: 4, blockKey: "text:0" },
			]);
			const authors = messages.map(({ metadata }) => ({
				kind: metadata.authorKind,
				id: metadata.authorId,
				label: metadata.authorLabel,
			}));
			expect(authors).toEqual([
				{ kind: undefined, id: undefined, label: undefined },
				{ kind: undefined, id: undefined, label: undefined },
				{ kind: "agent", id: "session:binding-cap-session", label: "Binding cap chat" },
				{ kind: "agent", id: "session:binding-cap-session", label: "Binding cap chat" },
				{ kind: "agent", id: "session:binding-cap-session", label: "Binding cap chat" },
				{ kind: undefined, id: undefined, label: undefined },
			]);
			expect(messages.some((message) => String(message.metadata.authorId).includes("forged"))).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("denormalizes goal-prefixed session title metadata for message result round-trip", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msg-title-source-"));
		const file = path.join(dir, "session.jsonl");
		fs.writeFileSync(file, JSON.stringify({ message: { role: "user", content: "QuackerTitleRegression" } }) + "\n", "utf-8");

		const ctx = makeCtx({
			goals: [{ ...goals[0], id: "goal-title", title: "Fix Search Titles" }],
			sessions: [{
				id: "session-title",
				title: "Grouped Session",
				cwd: "/tmp",
				agentSessionFile: file,
				createdAt: 1_700_000_000_000,
				lastActivity: 1_700_000_200_000,
				goalId: "goal-title",
				projectId: "proj-a",
			}],
		});
		const [msg] = await collect(new MessageIndexSource(), ctx);
		expect(msg.metadata.goalTitle, "message rows should carry goal title metadata").toBe("Fix Search Titles");
		expect(msg.metadata.sessionTitle, "message rows should carry resolved parent session title metadata").toBe("Fix Search Titles: Grouped Session");

		const doc = indexableToDoc(msg, msg.text, "session-title");
		const result = toSearchResult(doc, "QuackerTitleRegression", 1);
		expect(result.sessionTitle, "resolved message session title should round-trip through stored search docs").toBe("Fix Search Titles: Grouped Session");

		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("does not duplicate goal prefix in message session title metadata", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msg-prefixed-title-source-"));
		const file = path.join(dir, "session.jsonl");
		fs.writeFileSync(file, JSON.stringify({ message: { role: "user", content: "QuackerAlreadyPrefixed" } }) + "\n", "utf-8");

		const ctx = makeCtx({
			goals: [{ ...goals[0], id: "goal-title", title: "Fix Search Titles" }],
			sessions: [{
				id: "session-prefixed-title",
				title: "Fix Search Titles: Grouped Session",
				cwd: "/tmp",
				agentSessionFile: file,
				createdAt: 1_700_000_000_000,
				lastActivity: 1_700_000_200_000,
				goalId: "goal-title",
				projectId: "proj-a",
			}],
		});
		const [msg] = await collect(new MessageIndexSource(), ctx);
		expect(msg.metadata.sessionTitle, "goal prefix should not be duplicated for message-derived session context").toBe("Fix Search Titles: Grouped Session");

		fs.rmSync(dir, { recursive: true, force: true });
	});
});

// ── Files source stub (v2 readiness) ────────────────────────────────

describe("FilesIndexSourceStub", () => {
	test("walks a fixture dir and yields valid file Indexables", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "files-src-"));
		fs.writeFileSync(path.join(dir, "a.md"), "# Hello\n\nWorld\n", "utf-8");
		fs.mkdirSync(path.join(dir, "sub"));
		fs.writeFileSync(path.join(dir, "sub", "b.ts"), "export const x = 1;\n", "utf-8");
		fs.writeFileSync(path.join(dir, "empty.txt"), "", "utf-8");

		const ctx = makeCtx({ projectId: "proj-files" });
		const src = new FilesIndexSourceStub({ fixtureDir: dir });
		const out = await collect(src, ctx);
		expect(out.length).toBe(2); // empty.txt filtered out
		for (const i of out) assertValidIndexable(i, "files", "file:");
		const md = out.find((o) => o.id === "file:a.md")!;
		expect(md.display?.filePath).toBe("a.md");
		expect(md.display?.startLine).toBe(1);
		expect((md.display?.endLine ?? 0)).toBeGreaterThanOrEqual(3);

		fs.rmSync(dir, { recursive: true, force: true });
	});
});
