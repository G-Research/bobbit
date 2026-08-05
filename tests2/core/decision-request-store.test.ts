import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "vitest";
import {
	DECISION_REQUEST_RETENTION_MS,
	DecisionRequestStore,
	type DecisionMemory,
	type StoredDecisionRequest,
} from "../../src/server/agent/decision-request-store.ts";
import { createMemFs, type MemFs } from "../harness/mem-fs.js";

let memfs: MemFs = createMemFs();
let sequence = 0;

function stateDir(label: string): string {
	const dir = path.resolve("/memfs/decision-request-store", `${label}-${sequence++}`);
	memfs.mkdirSync(dir, { recursive: true });
	return dir;
}

function request(id: string, overrides: Partial<StoredDecisionRequest> = {}): StoredDecisionRequest {
	return {
		id,
		projectId: "project-1",
		sessionId: "session-1",
		goalId: "goal-1",
		asker: { packId: "pack-1", hookId: "hook-1", event: "beforePrompt" },
		dedupeId: `dedupe-${id}`,
		questionId: `question-${id}`,
		request: {
			version: 1,
			key: "deployment",
			title: "Deploy?",
			question: "Which deployment target should be used?",
			options: [{ value: "safe", label: "Safe" }, { value: "fast", label: "Fast" }],
			other: { maxLength: 280 },
			default: { kind: "option", value: "safe" },
			scope: "goal",
			deadlineAt: "2026-01-01T00:01:00.000Z",
			effect: { kind: "none" },
		},
		status: "pending",
		createdAt: "2026-01-01T00:00:00.000Z",
		deadlineAt: "2026-01-01T00:01:00.000Z",
		continuationState: "pending",
		continuationAttempts: 0,
		...overrides,
	};
}

function memory(overrides: Partial<DecisionMemory> = {}): DecisionMemory {
	return {
		scope: "goal",
		scopeId: "goal-1",
		packId: "pack-1",
		hookId: "hook-1",
		key: "deployment",
		value: { kind: "option", value: "safe" },
		validatedAt: "2026-01-01T00:01:00.000Z",
		sourceRequestId: "request-1",
		...overrides,
	};
}

describe("DecisionRequestStore", () => {
	it("atomically persists requests and exact scoped memories across restart", () => {
		const dir = stateDir("round-trip");
		const store = new DecisionRequestStore(dir, memfs);
		assert.equal(store.put(request("request-1")), true);
		const result = store.writeTerminalFirst("request-1", {
			status: "resolved",
			resolvedAt: "2026-01-01T00:01:00.000Z",
			resolution: { value: { kind: "option", value: "safe" }, actor: "user", reason: "answered" },
		}, memory());
		assert.equal(result.written, true);

		const restarted = new DecisionRequestStore(dir, memfs);
		assert.equal(restarted.isHealthy(), true);
		assert.equal(restarted.get("request-1")?.status, "resolved");
		assert.deepEqual(restarted.getMemory(memory()), memory());
	});

	it("returns defensive copies for requests and memories", () => {
		const store = new DecisionRequestStore(stateDir("copies"), memfs);
		store.put(request("request-1"));
		store.putMemory(memory());
		const copy = store.get("request-1")!;
		copy.request.options[0].label = "mutated";
		copy.asker.packId = "mutated";
		const storedMemory = store.getMemory(memory())!;
		storedMemory.value = { kind: "other", text: "mutated" };
		assert.equal(store.get("request-1")!.request.options[0].label, "Safe");
		assert.equal(store.get("request-1")!.asker.packId, "pack-1");
		assert.deepEqual(store.getMemory(memory())!.value, { kind: "option", value: "safe" });
	});

	it("does not cross session, goal, project, pack, hook, or key memory identities", () => {
		const store = new DecisionRequestStore(stateDir("scope"), memfs);
		store.putMemory(memory());
		for (const isolated of [
			memory({ scope: "session", scopeId: "session-1" }),
			memory({ scopeId: "goal-2" }),
			memory({ scope: "project", scopeId: "project-1" }),
			memory({ packId: "pack-2" }),
			memory({ hookId: "hook-2" }),
			memory({ key: "other-key" }),
		]) assert.equal(store.getMemory(isolated), undefined);
		assert.deepEqual(store.getMemory(memory()), memory());
	});

	it("serializes terminal writes: the first terminal answer and memory win", () => {
		const store = new DecisionRequestStore(stateDir("first-terminal"), memfs);
		store.put(request("request-1"));
		const first = store.writeTerminalFirst("request-1", {
			status: "resolved",
			resolvedAt: "2026-01-01T00:01:00.000Z",
			resolution: { value: { kind: "option", value: "safe" }, actor: "user", reason: "answered" },
		}, memory());
		const second = store.writeTerminalFirst("request-1", {
			status: "expired",
			resolvedAt: "2026-01-01T00:02:00.000Z",
			resolution: { value: { kind: "option", value: "fast" }, actor: "deadline", reason: "deadline_elapsed" },
		}, memory({ value: { kind: "option", value: "fast" } }));
		assert.equal(first.written, true);
		assert.equal(second.written, false);
		assert.equal(second.request?.resolution?.value.kind, "option");
		assert.equal((second.request?.resolution?.value as { value: string }).value, "safe");
		assert.deepEqual(store.getMemory(memory())!.value, { kind: "option", value: "safe" });
	});

	it("retains pending requests, prunes old terminal records, and preserves memories", () => {
		const store = new DecisionRequestStore(stateDir("retention"), memfs);
		const now = Date.parse("2026-02-01T00:00:00.000Z");
		store.put(request("old", { status: "resolved", resolvedAt: new Date(now - DECISION_REQUEST_RETENTION_MS - 1).toISOString() }));
		store.put(request("recent", { status: "resolved", resolvedAt: new Date(now - DECISION_REQUEST_RETENTION_MS).toISOString() }));
		store.put(request("pending"));
		store.putMemory(memory({ sourceRequestId: "old" }));
		assert.equal(store.pruneTerminalRequests(now), 1);
		assert.equal(store.get("old"), undefined);
		assert.ok(store.get("recent"));
		assert.ok(store.get("pending"));
		assert.ok(store.getMemory(memory({ sourceRequestId: "old" })));
	});

	it("fails closed on corrupt state without changing unrelated project state", () => {
		const dir = stateDir("corrupt");
		const file = path.join(dir, "extension-decision-requests.json");
		memfs.writeFileSync(file, "not-json", "utf-8");
		const store = new DecisionRequestStore(dir, memfs);
		assert.equal(store.isHealthy(), false);
		assert.equal(store.list().length, 0);
		assert.equal(store.put(request("request-1")), false);
		assert.equal(memfs.readFileSync(file, "utf-8"), "not-json");
	});

	it("keeps the old in-memory and disk snapshot when atomic publication fails", () => {
		const dir = stateDir("atomic-failure");
		const store = new DecisionRequestStore(dir, memfs);
		store.put(request("request-1"));
		const file = path.join(dir, "extension-decision-requests.json");
		const before = memfs.readFileSync(file, "utf-8");
		const rename = memfs.renameSync.bind(memfs);
		(memfs as any).renameSync = () => { throw new Error("rename failed"); };
		try {
			assert.equal(store.put(request("request-2")), false);
		} finally {
			(memfs as any).renameSync = rename;
		}
		assert.equal(store.get("request-2"), undefined);
		assert.equal(memfs.readFileSync(file, "utf-8"), before);
	});
});
