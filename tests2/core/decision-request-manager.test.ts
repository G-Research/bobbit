import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "vitest";
import type { Clock, TimerHandle } from "../../src/server/gateway-deps.ts";
import {
	DECISION_ADVISORY_PENDING_LIMIT,
	DECISION_GOAL_PENDING_LIMIT,
	DECISION_SESSION_PENDING_LIMIT,
	DecisionRequestManager,
	type DecisionRequestOrigin,
} from "../../src/server/agent/decision-request-manager.ts";
import { DECISION_REQUEST_RETENTION_MS, DecisionRequestStore } from "../../src/server/agent/decision-request-store.ts";
import type { ValidatedExtensionDecisionRequest } from "../../src/server/agent/decision-hook-contract.ts";
import { createMemFs, type MemFs } from "../harness/mem-fs.ts";

class FakeClock implements Clock {
	private timers: Array<{ at: number; handler: () => void; cancelled: boolean }> = [];
	constructor(private time: number) {}
	now(): number { return this.time; }
	setTimeout(handler: () => void, ms: number): TimerHandle {
		const timer = { at: this.time + ms, handler, cancelled: false };
		this.timers.push(timer);
		return timer as unknown as TimerHandle;
	}
	setInterval(): TimerHandle { throw new Error("not used"); }
	clearTimeout(handle: TimerHandle): void { (handle as unknown as { cancelled: boolean }).cancelled = true; }
	clearInterval(): void { /* unused */ }
	advance(ms: number): void {
		this.time += ms;
		for (const timer of this.timers.filter(timer => !timer.cancelled && timer.at <= this.time)) {
			timer.cancelled = true;
			timer.handler();
		}
	}
	pendingTimerDelays(): number[] {
		return this.timers.filter(timer => !timer.cancelled).map(timer => timer.at - this.time);
	}
}

let sequence = 0;
function fixture(opts: { headless?: boolean; continuation?: () => Promise<"delivered" | "skipped">; continuationComplete?: () => void; proposal?: boolean } = {}) {
	const fs: MemFs = createMemFs();
	const dir = path.join("/memfs", `decision-manager-${sequence++}`);
	fs.mkdirSync(dir, { recursive: true });
	const store = new DecisionRequestStore(dir, fs);
	const clock = new FakeClock(Date.parse("2026-01-01T00:00:00.000Z"));
	const invalidations: string[] = [];
	const proposals: Array<{ type: string; args: Record<string, unknown> }> = [];
	const manager = new DecisionRequestManager({
		storeForProject: projectId => projectId === "project-1" ? store : undefined,
		clock,
		isHeadless: () => opts.headless === true,
		invalidateSession: sessionId => invalidations.push(sessionId),
		proposalSeedService: opts.proposal ? {
			seedFromDecision: async (_session, type, args) => {
				proposals.push({ type, args });
				return { ok: true as const, status: 200 as const, rev: 7, fields: {} };
			},
		} : undefined,
		continuation: opts.continuation ? { deliver: () => opts.continuation!(), complete: opts.continuationComplete } : undefined,
	});
	return { fs, store, clock, manager, invalidations, proposals };
}

function origin(overrides: Partial<DecisionRequestOrigin> = {}): DecisionRequestOrigin {
	return {
		projectId: "project-1", sessionId: "session-1", goalId: "goal-1", cwd: "/work",
		event: "beforePrompt", packId: "pack-1", hookId: "hook-1", ...overrides,
	};
}
function request(clock: Clock, overrides: Partial<ValidatedExtensionDecisionRequest> = {}): ValidatedExtensionDecisionRequest {
	return {
		version: 1, key: "review-style", title: "Review style", question: "Which review style?",
		options: [{ value: "quick", label: "Quick" }, { value: "thorough", label: "Thorough" }],
		other: { maxLength: 40 }, default: { kind: "option", value: "quick" }, scope: "goal",
		deadlineAt: new Date(clock.now() + 30_000).toISOString(), effect: { kind: "none" }, ...overrides,
	};
}

describe("DecisionRequestManager", () => {
	it("deduplicates semantic requests despite title, labels, event, and deadline changes", async () => {
		const { manager, clock, store } = fixture();
		const first = await manager.create(origin(), request(clock));
		const duplicate = await manager.create(origin({ event: "afterTurn" }), request(clock, {
			title: "Different render title", deadlineAt: new Date(clock.now() + 60_000).toISOString(),
			options: [{ value: "quick", label: "Fast" }, { value: "thorough", label: "Slow" }],
		}));
		assert.equal(first.status, "created");
		assert.equal(duplicate.status, "deduplicated");
		assert.equal(duplicate.requestId, first.requestId);
		assert.equal(store.list().length, 1);
	});

	it("writes one validated exact-scope memory and only the first terminal answer wins", async () => {
		const { manager, clock, store } = fixture();
		const created = await manager.create(origin(), request(clock));
		const first = await manager.answer("project-1", created.requestId!, { kind: "option", value: "thorough" });
		const second = await manager.answer("project-1", created.requestId!, { kind: "option", value: "quick" });
		assert.equal(first.status, "resolved");
		assert.equal(second.status, "already_resolved");
		assert.deepEqual(store.get(created.requestId!)?.resolution?.value, { kind: "option", value: "thorough" });
		assert.deepEqual(manager.getMemory(origin(), "goal", "review-style"), { kind: "option", value: "thorough" });
		assert.equal(manager.getMemory(origin({ goalId: "other-goal" }), "goal", "review-style"), undefined);
		assert.equal(manager.getMemory(origin(), "goal", "other-key"), undefined);
	});

	it("uses schema-valid exact memories after their terminal request is pruned", async () => {
		const { manager, clock, store } = fixture();
		const created = await manager.create(origin(), request(clock));
		await manager.answer("project-1", created.requestId!, { kind: "option", value: "thorough" });
		manager.stop();
		clock.advance(DECISION_REQUEST_RETENTION_MS + 1);
		assert.equal(store.pruneTerminalRequests(clock.now()), 1);

		assert.equal((await manager.create(origin(), request(clock))).status, "deduplicated");
		assert.equal(store.list().length, 0, "a memory hit must not recreate the pruned request");
		assert.equal((await manager.create(origin(), request(clock, { key: "different-key" }))).status, "created");
		assert.equal((await manager.create(origin(), request(clock, { scope: "session" }))).status, "created");
		assert.equal(store.putMemory({
			scope: "goal", scopeId: "goal-1", packId: "pack-1", hookId: "hook-1", key: "stale-memory",
			value: { kind: "option", value: "removed-option" }, validatedAt: new Date(clock.now()).toISOString(), sourceRequestId: "old",
		}), true);
		assert.equal((await manager.create(origin({ sessionId: "other-session" }), request(clock, { key: "stale-memory" }))).status, "created", "an invalid stored value must not suppress a new request");
	});

	it("rejects malformed typed answers without persisting a resolution", async () => {
		const { manager, clock, store } = fixture();
		const created = await manager.create(origin(), request(clock));
		const result = await manager.answer("project-1", created.requestId!, { kind: "option", value: "not-an-option" });
		assert.equal(result.status, "invalid");
		assert.equal(store.get(created.requestId!)?.status, "pending");
	});

	it("enforces loud session and goal pending budgets independently", async () => {
		const session = fixture();
		for (let index = 0; index < DECISION_SESSION_PENDING_LIMIT; index++) {
			assert.equal((await session.manager.create(origin({ goalId: undefined }), request(session.clock, { key: `session-${index}`, question: `Question ${index}`, scope: "session" }))).status, "created");
		}
		assert.deepEqual(await session.manager.create(origin({ goalId: undefined }), request(session.clock, { key: "over", question: "Over", scope: "session" })), { status: "rejected", code: "DECISION_BUDGET_EXHAUSTED" });

		const goal = fixture();
		for (let index = 0; index < DECISION_GOAL_PENDING_LIMIT; index++) {
			assert.equal((await goal.manager.create(origin({ sessionId: `session-${index}` }), request(goal.clock, { key: `goal-${index}`, question: `Goal question ${index}` }))).status, "created");
		}
		assert.equal((await goal.manager.create(origin({ sessionId: "other-session" }), request(goal.clock, { key: "goal-over", question: "Goal over" }))).code, "DECISION_BUDGET_EXHAUSTED");
	});

	it("expires defaults through one reconciled deadline and survives a restart", async () => {
		const first = fixture();
		const created = await first.manager.create(origin(), request(first.clock));
		first.clock.advance(30_000);
		await first.manager.reconcile();
		assert.equal(first.store.get(created.requestId!)?.status, "expired");
		assert.deepEqual(first.store.get(created.requestId!)?.resolution, {
			value: { kind: "option", value: "quick" }, actor: "deadline", reason: "deadline_elapsed",
		});
	});

	it("applies a headless default immediately without an interactive invalidation", async () => {
		const { manager, clock, store, invalidations } = fixture({ headless: true });
		const created = await manager.create(origin(), request(clock));
		assert.equal(created.request?.status, "resolved");
		assert.equal(store.get(created.requestId!)?.resolution?.actor, "headless");
		assert.deepEqual(invalidations, ["session-1"]);
	});

	it("claims continuation delivery so answer and reconciliation cannot invoke it concurrently", async () => {
		let calls = 0;
		let completed = 0;
		let release!: () => void;
		let entered!: () => void;
		const blocked = new Promise<void>(resolve => { release = resolve; });
		const enteredContinuation = new Promise<void>(resolve => { entered = resolve; });
		const { manager, clock, store } = fixture({ continuation: async () => { calls++; entered(); await blocked; return "delivered"; }, continuationComplete: () => { completed++; } });
		const created = await manager.create(origin(), request(clock));
		const answer = manager.answer("project-1", created.requestId!, { kind: "option", value: "thorough" });
		await enteredContinuation;
		assert.equal(calls, 1);
		await manager.reconcile();
		assert.equal(calls, 1, "reconciliation must observe the synchronous in-flight claim");
		release();
		await answer;
		assert.equal(store.get(created.requestId!)?.continuationState, "delivered");
		assert.equal(store.get(created.requestId!)?.continuationAttempts, 1);
		assert.equal(completed, 1, "delivered continuation context must be released");
	});

	it("backs off an overdue terminal-write failure instead of scheduling a zero-delay loop", async () => {
		const { fs, manager, clock, store } = fixture();
		const created = await manager.create(origin(), request(clock));
		manager.stop();
		const failingFs = fs as unknown as { writeFileSync: (...args: unknown[]) => void };
		const writeFileSync = failingFs.writeFileSync.bind(fs);
		let writes = 0;
		failingFs.writeFileSync = () => {
			writes++;
			throw new Error("read only");
		};
		clock.advance(30_000);
		await manager.reconcile();
		assert.equal(store.get(created.requestId!)?.status, "pending");
		assert.equal(clock.pendingTimerDelays()[0], 2_000);
		const attemptsAfterFirstReconcile = writes;
		clock.advance(1_999);
		assert.equal(writes, attemptsAfterFirstReconcile, "the overdue request must not immediately reconcile again");
		failingFs.writeFileSync = writeFileSync;
		manager.stop();
	});

	it("keeps a failed continuation pending for one later reconciliation retry", async () => {
		let attempts = 0;
		const { manager, clock, store, proposals } = fixture({
			proposal: true,
			continuation: async () => { attempts++; if (attempts === 1) throw new Error("isolated"); return "delivered"; },
		});
		const created = await manager.create(origin(), request(clock, {
			effect: { kind: "proposal", proposals: {
				quick: { proposalType: "goal", args: { title: "Quick" } },
				thorough: { proposalType: "goal", args: { title: "Thorough" } },
				other: { proposalType: "goal", args: { title: "Other" } },
			} },
		}));
		await manager.answer("project-1", created.requestId!, { kind: "option", value: "quick" });
		assert.deepEqual(proposals, [{ type: "goal", args: { title: "Quick" } }]);
		assert.equal(store.get(created.requestId!)?.continuationState, "pending");
		await manager.reconcile();
		assert.equal(store.get(created.requestId!)?.continuationState, "delivered");
		assert.equal(store.get(created.requestId!)?.continuationAttempts, 2);
	});

	it("durably deduplicates and caps advisories through the non-waking inbox seam", () => {
		const calls: Array<{ input: { context?: string; source: { type: string; packId?: string; hookId?: string } }; options: { wake?: boolean } }> = [];
		const manager = new DecisionRequestManager({
			storeForProject: () => undefined,
			inboxManager: {
				hasStaff: () => true,
				listForStaff: () => calls.map(call => ({ state: "pending", context: call.input.context, source: call.input.source })) as never,
				enqueue: (_staffId, input, options) => { calls.push({ input, options }); return {} as never; },
			},
		});
		const notice = { version: 1 as const, staffId: "staff-1", key: "notice", title: "Notice", body: "Body" };
		assert.equal(manager.advisory(origin(), notice), "enqueued");
		assert.equal(manager.advisory(origin(), notice), "deduplicated");
		assert.equal(calls[0]?.options.wake, false);
		for (let index = 1; index < DECISION_ADVISORY_PENDING_LIMIT; index++) {
			assert.equal(manager.advisory(origin(), { ...notice, key: `notice-${index}` }), "enqueued");
		}
		assert.equal(manager.advisory(origin(), { ...notice, key: "over-budget" }), "rejected");
	});
});
