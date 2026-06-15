/**
 * Unit tests for InboxNudger — 15 s tick + poke fast-path + contextPolicy
 * gating + agent_start hook clears nudgePending.
 *
 * Uses node:test `mock.timers` for the 15 s interval and `mock.fn` for
 * fakes. We never spin a real SessionManager or StaffManager — both are
 * structurally typed at the boundary, so light fakes suffice.
 *
 * Pinned by docs/design/staff-inbox.md §3.3, §5, §13.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, after, mock } from "node:test";
import assert from "node:assert/strict";
import { makeTmpDir } from "./helpers/tmp.ts";

const tmpRoot = makeTmpDir("inbox-nudger-");

const { InboxStore } = await import("../src/server/agent/inbox-store.ts");
const { InboxNudger } = await import("../src/server/agent/inbox-nudger.ts");

after(() => {
	try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ok */ }
});

type StaffStatus = "idle" | "streaming" | "starting" | "terminated";

interface FakeSession {
	id: string;
	status: StaffStatus;
	rpcClient: {
		compact: ReturnType<typeof mock.fn>;
	};
}

function makeHarness(opts: {
	staffId?: string;
	contextPolicy?: "compact" | "preserve";
	staffState?: "active" | "paused" | "retired";
	sessionId?: string;
	sessionStatus?: StaffStatus;
	currentSessionId?: string | undefined;
}) {
	const stateDir = fs.mkdtempSync(path.join(tmpRoot, "h-"));
	const inboxStore = new InboxStore(stateDir);
	const staffId = opts.staffId ?? "staff-1";
	const sessionId = opts.sessionId ?? "session-1";
	const currentSessionId = ("currentSessionId" in opts) ? opts.currentSessionId : sessionId;
	const staff: any = {
		id: staffId,
		state: opts.staffState ?? "active",
		currentSessionId,
		contextPolicy: opts.contextPolicy ?? "compact",
	};
	const staffManager = {
		listStaff: () => [staff],
		getStaff: (id: string) => (id === staffId ? staff : undefined),
		updateStaff: mock.fn((id: string, patch: Record<string, unknown>) => { if (id === staffId) Object.assign(staff, patch); return staff; }),
	};

	const session: FakeSession = {
		id: sessionId,
		status: opts.sessionStatus ?? "idle",
		rpcClient: { compact: mock.fn(async (_t?: number) => undefined) },
	};
	const enqueuePrompt = mock.fn(async (_id: string, _msg: string, _opts?: any) => {});
	const sessionManager = {
		getSession: (id: string) => (id === sessionId ? session : undefined),
		enqueuePrompt,
	};

	const nudger = new InboxNudger({
		sessionManager: sessionManager as any,
		staffManager: staffManager as any,
		inboxStore,
	});

	return { nudger, staff, session, staffManager, sessionManager, inboxStore, enqueuePrompt };
}

function enqueueDirect(inboxStore: InstanceType<typeof InboxStore>, staffId: string, id = "e1") {
	inboxStore.put({
		id,
		staffId,
		source: { type: "trigger", triggerId: "t1" },
		title: "t",
		prompt: "do thing",
		state: "pending",
		createdAt: Date.now(),
	});
}

describe("InboxNudger — periodic tick", () => {
	it("wakes an idle staff with pending entries on the next tick", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const h = makeHarness({});
		enqueueDirect(h.inboxStore, h.staff.id);
		h.nudger.start();

		t.mock.timers.tick(15_000);
		// Yield so microtasks (poke / applyPolicyThenNudge) settle.
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		assert.equal(h.enqueuePrompt.mock.callCount(), 1);
		const call = h.enqueuePrompt.mock.calls[0];
		assert.equal(call.arguments[0], h.session.id);
		assert.match(call.arguments[1], /\[INBOX\] You have 1 pending item\./);
		assert.deepEqual(call.arguments[2], { isSteered: true });

		h.nudger.stop();
	});

	it("uses pluralised wording for multiple pending entries", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const h = makeHarness({});
		enqueueDirect(h.inboxStore, h.staff.id, "e1");
		enqueueDirect(h.inboxStore, h.staff.id, "e2");
		enqueueDirect(h.inboxStore, h.staff.id, "e3");
		h.nudger.start();

		t.mock.timers.tick(15_000);
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		assert.equal(h.enqueuePrompt.mock.callCount(), 1);
		assert.match(h.enqueuePrompt.mock.calls[0].arguments[1], /3 pending items/);
		h.nudger.stop();
	});

	it("does NOT wake a streaming staff", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const h = makeHarness({ sessionStatus: "streaming" });
		enqueueDirect(h.inboxStore, h.staff.id);
		h.nudger.start();

		t.mock.timers.tick(15_000);
		await new Promise((r) => setImmediate(r));
		assert.equal(h.enqueuePrompt.mock.callCount(), 0);
		h.nudger.stop();
	});

	it("does NOT wake a starting staff", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const h = makeHarness({ sessionStatus: "starting" });
		enqueueDirect(h.inboxStore, h.staff.id);
		h.nudger.start();

		t.mock.timers.tick(15_000);
		await new Promise((r) => setImmediate(r));
		assert.equal(h.enqueuePrompt.mock.callCount(), 0);
		h.nudger.stop();
	});

	it("does NOT wake when inbox is empty", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const h = makeHarness({});
		h.nudger.start();

		t.mock.timers.tick(15_000);
		await new Promise((r) => setImmediate(r));
		assert.equal(h.enqueuePrompt.mock.callCount(), 0);
		h.nudger.stop();
	});

	it("skips paused / retired staff", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const h = makeHarness({ staffState: "paused" });
		enqueueDirect(h.inboxStore, h.staff.id);
		h.nudger.start();

		t.mock.timers.tick(15_000);
		await new Promise((r) => setImmediate(r));
		assert.equal(h.enqueuePrompt.mock.callCount(), 0);
		h.nudger.stop();
	});

	it("skips staff with no currentSessionId", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const h = makeHarness({ currentSessionId: undefined });
		enqueueDirect(h.inboxStore, h.staff.id);
		h.nudger.start();

		t.mock.timers.tick(15_000);
		await new Promise((r) => setImmediate(r));
		assert.equal(h.enqueuePrompt.mock.callCount(), 0);
		h.nudger.stop();
	});

	it("guards re-nudge via nudgePending until onAgentStart clears it", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const h = makeHarness({});
		enqueueDirect(h.inboxStore, h.staff.id, "e1");
		h.nudger.start();

		t.mock.timers.tick(15_000);
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		assert.equal(h.enqueuePrompt.mock.callCount(), 1, "first tick wakes once");

		// Add another pending entry; without clearing the guard, no second wake.
		enqueueDirect(h.inboxStore, h.staff.id, "e2");
		t.mock.timers.tick(15_000);
		await new Promise((r) => setImmediate(r));
		assert.equal(h.enqueuePrompt.mock.callCount(), 1, "guard suppresses the second wake");

		// Simulate the agent starting its turn — clears the guard.
		h.nudger.onAgentStart(h.session.id);
		t.mock.timers.tick(15_000);
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		assert.equal(h.enqueuePrompt.mock.callCount(), 2, "post-agent_start tick wakes again");

		h.nudger.stop();
	});
});

describe("InboxNudger — contextPolicy", () => {
	it("\"compact\" runs session.rpcClient.compact(120_000) BEFORE enqueuePrompt", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const h = makeHarness({ contextPolicy: "compact" });
		enqueueDirect(h.inboxStore, h.staff.id);
		h.nudger.start();

		// Capture call order across compact and enqueuePrompt.
		const order: string[] = [];
		const compactImpl = async (_t?: number) => { order.push("compact"); };
		h.session.rpcClient.compact = mock.fn(compactImpl);
		h.enqueuePrompt.mock.mockImplementation(async () => { order.push("enqueue"); });

		t.mock.timers.tick(15_000);
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		assert.equal(h.session.rpcClient.compact.mock.callCount(), 1);
		assert.equal(h.session.rpcClient.compact.mock.calls[0].arguments[0], 120_000);
		assert.deepEqual(order, ["compact", "enqueue"]);
		h.nudger.stop();
	});

	it("\"preserve\" skips compact and goes straight to enqueuePrompt", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const h = makeHarness({ contextPolicy: "preserve" });
		enqueueDirect(h.inboxStore, h.staff.id);
		h.nudger.start();

		t.mock.timers.tick(15_000);
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		assert.equal(h.session.rpcClient.compact.mock.callCount(), 0);
		assert.equal(h.enqueuePrompt.mock.callCount(), 1);
		h.nudger.stop();
	});

	it("tolerates an rpcClient without a compact() method (test double)", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const h = makeHarness({ contextPolicy: "compact" });
		// Drop compact entirely.
		(h.session.rpcClient as any).compact = undefined;
		enqueueDirect(h.inboxStore, h.staff.id);
		h.nudger.start();

		t.mock.timers.tick(15_000);
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		// Still nudges — the missing compact is treated as a no-op.
		assert.equal(h.enqueuePrompt.mock.callCount(), 1);
		h.nudger.stop();
	});
});

describe("InboxNudger.poke fast-path", () => {
	it("delivers a wake within microtask scheduling (no 15 s wait)", async () => {
		// We do NOT enable mock timers here — we want the real microtask loop.
		const h = makeHarness({ contextPolicy: "preserve" });
		enqueueDirect(h.inboxStore, h.staff.id);
		// Note: nudger.start() is NOT called — poke should still fire tickOne.

		h.nudger.poke(h.staff.id);
		// Microtask scheduled inside poke. Flush microtasks; then any pending
		// promise from enqueuePrompt.
		await Promise.resolve();
		await Promise.resolve();
		await new Promise((r) => setImmediate(r));

		assert.equal(h.enqueuePrompt.mock.callCount(), 1);
	});

	it("poke against a streaming staff is a no-op (gated by tickOne)", async () => {
		const h = makeHarness({ sessionStatus: "streaming" });
		enqueueDirect(h.inboxStore, h.staff.id);
		h.nudger.poke(h.staff.id);
		await Promise.resolve();
		await new Promise((r) => setImmediate(r));
		assert.equal(h.enqueuePrompt.mock.callCount(), 0);
	});
});

describe("InboxNudger.start/stop", () => {
	it("stop clears the interval (no further ticks)", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const h = makeHarness({});
		enqueueDirect(h.inboxStore, h.staff.id);
		h.nudger.start();
		h.nudger.stop();

		t.mock.timers.tick(15_000 * 5);
		await new Promise((r) => setImmediate(r));
		assert.equal(h.enqueuePrompt.mock.callCount(), 0);
	});

	it("start is idempotent (calling twice does not double-tick)", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const h = makeHarness({});
		enqueueDirect(h.inboxStore, h.staff.id);
		h.nudger.start();
		h.nudger.start();

		t.mock.timers.tick(15_000);
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		assert.equal(h.enqueuePrompt.mock.callCount(), 1);

		h.nudger.stop();
	});
});
