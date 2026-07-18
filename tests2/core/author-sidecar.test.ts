import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
	appendPromptAuthorDispatch,
	appendPromptAuthorSettlement,
	copyAuthorSidecar,
	initAuthorSidecarDir,
	mergeAuthorSidecarIntoMessages,
	purgeAuthorSidecar,
	readAuthorSidecar,
	type PromptAuthorDispatchInput,
} from "../../src/server/agent/author-sidecar.ts";
import { LOCAL_USER_AUTHOR, type MessageAuthor } from "../../src/shared/message-author.ts";
import { createMemFs } from "../harness/mem-fs.ts";

const memoryFs = createMemFs();
const stateDir = path.resolve("/memfs/author-sidecar/state");
const fsSpies: Array<{ mockRestore(): void }> = [];

beforeAll(() => {
	for (const method of [
		"existsSync", "mkdirSync", "appendFileSync", "readFileSync", "copyFileSync", "unlinkSync",
	] as const) {
		fsSpies.push((vi.spyOn as any)(fs, method).mockImplementation(
			(...args: unknown[]) => (memoryFs as any)[method](...args),
		));
	}
	initAuthorSidecarDir(stateDir);
});

afterAll(() => {
	for (const spy of fsSpies.reverse()) spy.mockRestore();
});

const systemAuthor: MessageAuthor = { kind: "system", id: "system:bobbit", label: "Bobbit" };
const agentAuthor: MessageAuthor = { kind: "agent", id: "session:caller", label: "Caller" };

function dispatch(
	promptId: string,
	modelText: string,
	author: MessageAuthor = LOCAL_USER_AUTHOR,
	dispatchedAt = 1_000,
): PromptAuthorDispatchInput {
	return { promptId, modelText, author, dispatchedAt, source: author.kind === "system" ? "system" : author.kind };
}

describe("author sidecar persistence", () => {
	it("round-trips a dispatch and echoed settlement", () => {
		const sessionId = "roundtrip";
		expect(appendPromptAuthorDispatch(sessionId, dispatch("p1", "hello", systemAuthor))).toBe(true);
		expect(appendPromptAuthorSettlement(sessionId, {
			promptId: "p1",
			settledAt: 1_100,
			outcome: "echoed",
			messageId: "m1",
			messageTimestamp: 1_050,
		})).toBe(true);
		expect(readAuthorSidecar(sessionId)).toEqual([{
			schemaVersion: 1,
			type: "prompt-author",
			...dispatch("p1", "hello", systemAuthor),
			settlement: {
				schemaVersion: 1,
				type: "prompt-author-settlement",
				promptId: "p1",
				settledAt: 1_100,
				outcome: "echoed",
				messageId: "m1",
				messageTimestamp: 1_050,
			},
		}]);
	});

	it("latest redispatch resets an older settlement for the same prompt id", () => {
		const sessionId = "redispatch";
		appendPromptAuthorDispatch(sessionId, dispatch("p1", "first", LOCAL_USER_AUTHOR, 100));
		appendPromptAuthorSettlement(sessionId, { promptId: "p1", settledAt: 110, outcome: "cancelled" });
		appendPromptAuthorDispatch(sessionId, dispatch("p1", "second", systemAuthor, 200));
		const [binding] = readAuthorSidecar(sessionId);
		expect(binding.modelText).toBe("second");
		expect(binding.author).toEqual(systemAuthor);
		expect(binding.settlement).toBeUndefined();
	});

	it("skips malformed, invalid-author, unknown-version, and orphan-settlement lines", () => {
		const sessionId = "corrupt";
		appendPromptAuthorDispatch(sessionId, dispatch("valid", "kept"));
		const file = path.join(stateDir, "author-sidecar", `${sessionId}.jsonl`);
		memoryFs.appendFileSync(file, [
			"not json",
			JSON.stringify({ schemaVersion: 2, type: "prompt-author", promptId: "future" }),
			JSON.stringify({ schemaVersion: 1, type: "prompt-author", ...dispatch("bad", "bad"), author: { kind: "tool", id: "x", label: "x" } }),
			JSON.stringify({ schemaVersion: 1, type: "prompt-author-settlement", promptId: "orphan", settledAt: 1, outcome: "echoed" }),
		].join("\n") + "\n");
		expect(readAuthorSidecar(sessionId).map((entry) => entry.promptId)).toEqual(["valid"]);
	});

	it("missing sidecars are empty and invalid appends do not write", () => {
		expect(readAuthorSidecar("missing")).toEqual([]);
		expect(appendPromptAuthorDispatch("invalid", { ...dispatch("", "text"), promptId: "" })).toBe(false);
		expect(readAuthorSidecar("invalid")).toEqual([]);
	});

	it("copies and purges sidecars", () => {
		appendPromptAuthorDispatch("copy-source", dispatch("p1", "copy me", agentAuthor));
		expect(copyAuthorSidecar("copy-source", "copy-destination")).toBe(true);
		expect(readAuthorSidecar("copy-destination")[0].author).toEqual(agentAuthor);
		purgeAuthorSidecar("copy-destination");
		expect(readAuthorSidecar("copy-destination")).toEqual([]);
	});
});

describe("author sidecar correlation", () => {
	it("excludes cancelled dispatches and falls back to legacy local-user inference", () => {
		const sessionId = "cancelled";
		appendPromptAuthorDispatch(sessionId, dispatch("p1", "same", systemAuthor));
		appendPromptAuthorSettlement(sessionId, { promptId: "p1", settledAt: 1_100, outcome: "cancelled" });
		const rows = mergeAuthorSidecarIntoMessages(
			readAuthorSidecar(sessionId),
			[{ role: "user", content: "same" }],
			{ session: { id: "target", title: "Target" } },
		);
		expect(rows[0].author).toEqual(LOCAL_USER_AUTHOR);
	});

	it("consumes duplicate identical prompt bindings FIFO", () => {
		const sessionId = "duplicates";
		appendPromptAuthorDispatch(sessionId, dispatch("p1", "same", systemAuthor, 100));
		appendPromptAuthorDispatch(sessionId, dispatch("p2", "same", agentAuthor, 200));
		const rows = mergeAuthorSidecarIntoMessages(
			readAuthorSidecar(sessionId),
			[{ role: "user", content: "same" }, { role: "user", content: "same" }],
		);
		expect(rows.map((row) => row.author)).toEqual([systemAuthor, agentAuthor]);
	});

	it("reserves an exact id binding before FIFO text matching", () => {
		const sessionId = "id-priority";
		appendPromptAuthorDispatch(sessionId, dispatch("p1", "same", systemAuthor, 100));
		appendPromptAuthorSettlement(sessionId, { promptId: "p1", settledAt: 110, outcome: "echoed", messageId: "m1" });
		appendPromptAuthorDispatch(sessionId, dispatch("p2", "same", agentAuthor, 200));
		appendPromptAuthorSettlement(sessionId, { promptId: "p2", settledAt: 210, outcome: "echoed", messageId: "m2" });
		const rows = mergeAuthorSidecarIntoMessages(readAuthorSidecar(sessionId), [
			{ role: "user", content: "same" },
			{ id: "m2", role: "user", content: "same" },
		]);
		expect(rows.map((row) => row.author)).toEqual([systemAuthor, agentAuthor]);
	});

	it("uses timestamp plus exact text to disambiguate a retained compacted duplicate", () => {
		const sessionId = "timestamp-priority";
		appendPromptAuthorDispatch(sessionId, dispatch("p1", "same", systemAuthor, 1_000));
		appendPromptAuthorSettlement(sessionId, {
			promptId: "p1", settledAt: 1_100, outcome: "echoed", messageTimestamp: 1_050,
		});
		appendPromptAuthorDispatch(sessionId, dispatch("p2", "same", agentAuthor, 10_000));
		appendPromptAuthorSettlement(sessionId, {
			promptId: "p2", settledAt: 10_100, outcome: "echoed", messageTimestamp: 10_050,
		});
		const rows = mergeAuthorSidecarIntoMessages(
			readAuthorSidecar(sessionId),
			[{ role: "user", content: "same", timestamp: 10_100 }],
		);
		expect(rows[0].author).toEqual(agentAuthor);
	});

	it("does not claim provider-history user-role tool result blocks", () => {
		const sessionId = "tool-result";
		appendPromptAuthorDispatch(sessionId, dispatch("p1", "", systemAuthor));
		const rows = mergeAuthorSidecarIntoMessages(
			readAuthorSidecar(sessionId),
			[
				{ role: "assistant", content: "called tool" },
				{ role: "user", content: [{ type: "tool_result", content: "result" }] },
			],
			{ session: { id: "target", title: "Target" } },
		);
		expect(rows[1].author).toEqual({ kind: "agent", id: "session:target", label: "Target" });
		expect(rows[1].author?.kind).not.toBe("tool");
	});

	it("is idempotent after authors have been merged", () => {
		const sessionId = "idempotent";
		appendPromptAuthorDispatch(sessionId, dispatch("p1", "hello", systemAuthor));
		const first = mergeAuthorSidecarIntoMessages(readAuthorSidecar(sessionId), [{ role: "user", content: "hello" }]);
		const second = mergeAuthorSidecarIntoMessages(readAuthorSidecar(sessionId), first);
		expect(second).toBe(first);
	});
});
