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

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { GoalIndexSource } from "../../src/server/search/sources/goal-source.ts";
import { SessionIndexSource } from "../../src/server/search/sources/session-source.ts";
import { StaffIndexSource } from "../../src/server/search/sources/staff-source.ts";
import { MessageIndexSource } from "../../src/server/search/sources/message-source.ts";
import { FilesIndexSourceStub } from "../../src/server/search/sources/files-source.stub.ts";
import type { IndexSource, IndexSourceContext, Indexable } from "../../src/server/search/types.ts";
import type { PersistedGoal, GoalStore } from "../../src/server/agent/goal-store.ts";
import type { PersistedSession, SessionStore } from "../../src/server/agent/session-store.ts";
import type { PersistedStaff, StaffStore } from "../../src/server/agent/staff-store.ts";

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
	},
];

// ── Goal source ──────────────────────────────────────────────────────

test.describe("GoalIndexSource", () => {
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

test.describe("SessionIndexSource", () => {
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

	test("contentHash stable under unchanged input", async () => {
		const ctx = makeCtx({ goals, sessions });
		const a = await collect(new SessionIndexSource(), ctx);
		const b = await collect(new SessionIndexSource(), makeCtx({ goals, sessions }));
		expect(a.map((i) => i.contentHash)).toEqual(b.map((i) => i.contentHash));
	});
});

// ── Staff source ─────────────────────────────────────────────────────

test.describe("StaffIndexSource", () => {
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

test.describe("MessageIndexSource", () => {
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

		const assistant = out.find((o) => o.role === "assistant")!;
		expect(assistant.weight).toBe(1.0);
		expect(assistant.text.includes("<thinking>")).toBe(false);

		const toolCall = out.find((o) => o.role === "tool_call")!;
		expect(toolCall.weight).toBe(0.8);
		expect(toolCall.text.startsWith("write ")).toBe(true);

		// Cleanup
		fs.rmSync(dir, { recursive: true, force: true });
	});
});

// ── Files source stub (v2 readiness) ────────────────────────────────

test.describe("FilesIndexSourceStub", () => {
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
