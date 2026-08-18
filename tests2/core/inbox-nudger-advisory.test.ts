import path from "node:path";
import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { InboxManager } from "../../src/server/agent/inbox-manager.ts";
import { InboxNudger } from "../../src/server/agent/inbox-nudger.ts";
import { InboxStore } from "../../src/server/agent/inbox-store.ts";
import { createManualClock } from "../harness/clock.js";
import { createMemFs, type MemFs } from "../harness/mem-fs.js";

let dirSeq = 0;

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

function makeHarness(options: { memfs?: MemFs; stateDir?: string } = {}) {
	const memfs = options.memfs ?? createMemFs();
	const stateDir = options.stateDir ?? path.resolve("/memfs/inbox-advisory", `h-${dirSeq++}`);
	if (!memfs.existsSync(stateDir)) memfs.mkdirSync(stateDir);
	const inboxStore = new InboxStore(stateDir, memfs);
	const staff = { id: "staff-1", state: "active", currentSessionId: "session-1", contextPolicy: "preserve" };
	const staffManager = {
		listStaff: () => [staff],
		getStaff: (id: string) => id === staff.id ? staff : undefined,
		updateStaff: vi.fn((_id: string, patch: Record<string, unknown>) => Object.assign(staff, patch)),
	};
	const enqueuePrompt = vi.fn(async (_id: string, _message: string, _options?: unknown) => undefined);
	const sessionManager = {
		getSession: (id: string) => id === "session-1" ? { id, status: "idle", rpcClient: {} } : undefined,
		enqueuePrompt,
	};
	const clock = createManualClock();
	const nudger = new InboxNudger({
		sessionManager: sessionManager as any,
		staffManager: staffManager as any,
		inboxStore,
		clock,
	});
	const pcm = {
		all: () => [{ project: { id: "project-1" }, staffStore: { get: (id: string) => id === staff.id ? staff : undefined }, inboxStore }][Symbol.iterator](),
	};
	const manager = new InboxManager(pcm as any, {} as any, () => {});
	manager.setNudger(nudger);
	return { clock, inboxStore, manager, memfs, nudger, enqueuePrompt, stateDir };
}

function advisoryInput(title = "advisory") {
	return {
		title,
		prompt: "This is informational only.",
		source: { type: "extension_advisory" as const, packId: "example", hookId: "notice" },
	};
}

describe("InboxNudger — extension advisories", () => {
	it("persists wake:false, remains actionable, and never wakes across reload", async () => {
		const first = makeHarness();
		const completed = first.manager.enqueue("staff-1", advisoryInput("complete me"), { wake: false });
		const dismissed = first.manager.enqueue("staff-1", advisoryInput("dismiss me"), { wake: false });

		assert.equal(completed.wake, false);
		assert.equal(first.inboxStore.get("staff-1", completed.id)?.wake, false);
		assert.equal(first.enqueuePrompt.mock.calls.length, 0, "wake:false does not poke");

		// Even an explicit poke and the periodic fallback must ignore advisories.
		first.nudger.poke("staff-1");
		first.nudger.start();
		await flushMicrotasks();
		first.clock.advance(InboxNudger.TICK_INTERVAL_MS);
		await flushMicrotasks();
		assert.equal(first.enqueuePrompt.mock.calls.length, 0);

		assert.deepEqual(first.manager.listForStaff("staff-1", "pending").map((entry) => entry.id), [completed.id, dismissed.id]);
		assert.equal(first.manager.transitionToCompleted("staff-1", completed.id, "seen").state, "completed");
		assert.equal(first.manager.transitionToTerminal("staff-1", dismissed.id, "cancelled", "not needed").state, "cancelled");

		const reloaded = makeHarness({ memfs: first.memfs, stateDir: first.stateDir });
		assert.equal(reloaded.inboxStore.get("staff-1", completed.id)?.wake, false, "no-wake survives store reload");
		reloaded.nudger.poke("staff-1");
		reloaded.nudger.start();
		await flushMicrotasks();
		reloaded.clock.advance(InboxNudger.TICK_INTERVAL_MS);
		await flushMicrotasks();
		assert.equal(reloaded.enqueuePrompt.mock.calls.length, 0);
		first.nudger.stop();
		reloaded.nudger.stop();
	});

	it("nudges once for a wakeable entry mixed with advisories", async () => {
		const h = makeHarness();
		h.manager.enqueue("staff-1", advisoryInput(), { wake: false });
		h.manager.enqueue("staff-1", {
			title: "normal work",
			prompt: "Please do work.",
			source: { type: "manual_api" },
		});

		await flushMicrotasks();
		assert.equal(h.enqueuePrompt.mock.calls.length, 1);
		assert.match(h.enqueuePrompt.mock.calls[0][1], /1 pending item/);

		h.nudger.start();
		h.clock.advance(InboxNudger.TICK_INTERVAL_MS);
		await flushMicrotasks();
		assert.equal(h.enqueuePrompt.mock.calls.length, 1, "the mixed batch is delivered once");
		h.nudger.stop();
	});

	it("treats a legacy entry without wake as wakeable", async () => {
		const h = makeHarness();
		h.inboxStore.put({
			id: "legacy",
			staffId: "staff-1",
			source: { type: "manual_api" },
			title: "legacy work",
			prompt: "Please do work.",
			state: "pending",
			createdAt: 1,
		});

		h.nudger.poke("staff-1");
		await flushMicrotasks();
		assert.equal(h.enqueuePrompt.mock.calls.length, 1);
	});
});
