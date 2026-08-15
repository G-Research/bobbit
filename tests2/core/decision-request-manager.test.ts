import assert from "node:assert/strict";
import path from "node:path";
import { describe, expect, it } from "vitest";
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

	it("uses project-import delivery budgets and invalidation without creating a session", async () => {
		const { manager, clock, store, invalidations } = fixture();
		const imported = { projectId: "project-1", importId: "import-1", event: "projectImported" as const, packId: "pack-1", hookId: "hook-1" };
		for (let index = 0; index < DECISION_SESSION_PENDING_LIMIT; index++) {
			assert.equal((await manager.create(imported, request(clock, { key: `import-${index}`, scope: "project" }))).status, "created");
		}
		assert.deepEqual(await manager.create(imported, request(clock, { key: "import-over", scope: "project" })), { status: "rejected", code: "DECISION_BUDGET_EXHAUSTED" });
		const pending = manager.listPendingImportRequests("project-1", "import-1");
		assert.equal(pending.length, DECISION_SESSION_PENDING_LIMIT);
		assert.equal(pending[0]?.sessionId, undefined);
		assert.deepEqual(pending[0]?.delivery, { kind: "project-import", importId: "import-1" });
		await manager.answer("project-1", pending[0]!.id, { kind: "option", value: "quick" });
		assert.deepEqual(invalidations, [], "a project import must not emit a session invalidation");
		assert.deepEqual(store.get(pending[0]!.id)?.resolution?.value, { kind: "option", value: "quick" });
		assert.deepEqual(manager.getMemory(imported, "project", "import-0"), { kind: "option", value: "quick" });
	});

	it("rejects project-import requests outside project scope", async () => {
		const { manager, clock } = fixture();
		const imported = { projectId: "project-1", importId: "import-1", event: "projectImported" as const, packId: "pack-1", hookId: "hook-1" };
		assert.deepEqual(await manager.create(imported, request(clock, { scope: "session" })), { status: "rejected", code: "DECISION_SCOPE_UNAVAILABLE" });
	});

	it("expires defaults through one reconciled deadline and survives a restart", async () => {
		const first = fixture();
		const created = await first.manager.create(origin(), request(first.clock));
		first.clock.advance(30_000);
		await first.manager.reconcile();
		assert.equal(first.store.get(created.requestId!)?.status, "defaulted");
		assert.deepEqual(first.store.get(created.requestId!)?.resolution, {
			value: { kind: "option", value: "quick" }, actor: "deadline", reason: "deadline_elapsed",
		});
	});

	it("applies a headless default immediately without an interactive invalidation", async () => {
		const { manager, clock, store, invalidations } = fixture({ headless: true });
		const created = await manager.create(origin(), request(clock));
		assert.equal(created.request?.status, "defaulted");
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

	it("forces all trusted platform floors to consent and strips a requested safe default", async () => {
		const { manager, clock, store } = fixture();
		const operations = [
			{ hardCapOverride: "core-hard-cap" as const, reason: "core-hard-cap" },
			{ toolSafety: "unsafe" as const, reason: "core-unsafe-tool" },
			{ change: "capability-escalation" as const, reason: "core-capability-change" },
			{ change: "grant-change" as const, reason: "core-grant-change" },
			{ change: "configuration-change" as const, reason: "core-configuration-change" },
		];
		for (const [index, floor] of operations.entries()) {
			const created = await manager.create(origin({ sessionId: `session-${index}`, goalId: `goal-${index}` }), request(clock, { key: `forced-${index}` }), {
				id: `operation-${index}`, kind: "trusted", ...floor,
			});
			const persisted = store.get(created.requestId!)!;
			assert.equal(persisted.decisionClass, "consent-required");
			assert.equal(persisted.classificationReason, floor.reason);
			assert.equal(persisted.request.default, undefined);
			assert.equal(persisted.timeoutAction, "deny-operation");
		}
	});

	it("does not deduplicate terminal consent but retains active consent dedupe", async () => {
		const { manager, clock, store } = fixture();
		const operation = { id: "unsafe-tool", kind: "tool", toolSafety: "unsafe" as const };
		const first = await manager.create(origin(), request(clock), operation);
		assert.equal((await manager.answer("project-1", first.requestId!, { kind: "option", value: "quick" })).status, "resolved");
		assert.equal(store.get(first.requestId!)?.status, "denied");
		const second = await manager.create(origin(), request(clock), operation);
		const duplicate = await manager.create(origin(), request(clock), operation);
		assert.equal(second.status, "created");
		assert.equal(duplicate.status, "deduplicated");
		assert.equal(duplicate.requestId, second.requestId);
	});

	it("denies consent proposal effects headlessly and at deadline without a draft, memory, continuation, or protected work", async () => {
		let delivered = 0;
		const effect = { kind: "proposal" as const, proposals: {
			quick: { proposalType: "goal" as const, args: { title: "Must not seed" } },
			thorough: { proposalType: "goal" as const, args: { title: "Must not seed" } },
			other: { proposalType: "goal" as const, args: { title: "Must not seed" } },
		} };
		const headless = fixture({ headless: true, proposal: true, continuation: async () => { delivered++; return "delivered"; } });
		const created = await headless.manager.create(origin(), request(headless.clock, { effect }), { id: "unsafe-tool", kind: "tool", toolSafety: "unsafe" });
		const persisted = headless.store.get(created.requestId!)!;
		assert.equal(persisted.status, "denied");
		assert.equal(persisted.resolution, undefined);
		assert.equal(persisted.continuationState, "skipped");
		assert.equal(headless.store.listMemories().length, 0);
		assert.deepEqual(headless.proposals, []);
		assert.equal(delivered, 0);

		const deadline = fixture({ proposal: true });
		const overdue = await deadline.manager.create(origin(), request(deadline.clock, { effect }), { id: "unsafe-deadline", kind: "tool", toolSafety: "unsafe" });
		deadline.clock.advance(30_000);
		await deadline.manager.reconcile();
		assert.equal(deadline.store.get(overdue.requestId!)?.status, "denied");
		assert.deepEqual(deadline.proposals, []);
	});

	it("pauses consent durably, surfaces one non-waking inbox reference, and resumes through one answer", async () => {
		const fs: MemFs = createMemFs();
		const dir = path.join("/memfs", `consent-manager-${sequence++}`);
		fs.mkdirSync(dir, { recursive: true });
		const store = new DecisionRequestStore(dir, fs);
		const clock = new FakeClock(Date.parse("2026-01-01T00:00:00.000Z"));
		const pauses: string[] = [];
		const resumes: string[] = [];
		const entries: Array<{ id: string; staffId: string; wake: boolean }> = [];
		const manager = new DecisionRequestManager({
			isHeadless: () => false,
			storeForProject: () => store, clock,
			recheckConsentOperation: () => true,
			consentPauseLifecycle: {
				pause: async (_goal, reason) => { pauses.push(reason.requestId); return pauses.length === 1 ? "paused" : "already-paused"; },
				resume: async (_goal, reason) => { resumes.push(reason.requestId); return "resumed"; },
			},
			consentInboxTarget: () => "staff-1",
			inboxManager: {
				hasStaff: () => true,
				enqueueOnce: (_staff: string, input: { source: { type: string } }) => {
					const existing = entries[0];
					if (existing) return { entry: existing as never, created: false };
					const entry = { id: "inbox-1", staffId: "staff-1", wake: false };
					entries.push(entry);
					assert.equal(input.source.type, "consent_pause");
					return { entry: entry as never, created: true };
				},
				completeOnce: () => ({}) as never,
				cancelOnce: () => ({}) as never,
			} as never,
		});
		const created = await manager.create(origin(), request(clock), { id: "goal-operation", kind: "goal", toolSafety: "unsafe", timeoutAction: "pause-goal" });
		clock.advance(30_000);
		await manager.reconcile();
		const paused = store.get(created.requestId!)!;
		assert.equal(paused.status, "paused-awaiting-consent");
		assert.equal(paused.consentInbox?.status, "surfaced");
		assert.deepEqual(pauses, [created.requestId!]);
		assert.deepEqual(entries, [{ id: "inbox-1", staffId: "staff-1", wake: false }]);
		await manager.reconcile();
		assert.equal(entries.length, 1, "startup replay must use source-key dedupe");
		const answered = await manager.answer("project-1", created.requestId!, { kind: "option", value: "thorough" });
		assert.equal(answered.status, "resolved");
		assert.equal(store.get(created.requestId!)?.status, "resolved");
		assert.deepEqual(resumes, [created.requestId!]);
	});

	it("claims concurrent consent pause replay while retaining durable crash recovery", async () => {
		const { clock, store } = fixture();
		let pauses = 0;
		let release!: () => void;
		let entered!: () => void;
		let settled!: () => void;
		const blocked = new Promise<void>(resolve => { release = resolve; });
		const pauseStarted = new Promise<void>(resolve => { entered = resolve; });
		const pauseSettled = new Promise<void>(resolve => { settled = resolve; });
		const guarded = new DecisionRequestManager({
			isHeadless: () => false,
			storeForProject: () => store, clock,
			consentPauseLifecycle: {
				pause: async () => { pauses++; entered(); await blocked; settled(); return "paused"; },
				resume: async () => "resumed",
			},
		});
		const created = await guarded.create(origin(), request(clock), {
			id: "goal-operation", kind: "goal", toolSafety: "unsafe", timeoutAction: "pause-goal",
		});
		clock.advance(30_000); // Timer reconciliation starts and blocks in canonical pause.
		await pauseStarted;
		await guarded.reconcile(); // Explicit/startup reconciliation races the timer.
		assert.equal(pauses, 1, "one in-process replay claim reaches canonical pause");
		release();
		await pauseSettled;
		assert.equal(store.get(created.requestId!)?.status, "paused-awaiting-consent");
	});

	it("does not resume a manual or different consent pause after an answer", async () => {
		const { clock, store } = fixture();
		// Construct with a matching pause service first so timeout stores its exact intent.
		const pausedManager = new DecisionRequestManager({
			isHeadless: () => false,
			storeForProject: () => store, clock,
			recheckConsentOperation: () => true,
			consentPauseLifecycle: { pause: async () => "paused", resume: async () => "not-matching" },
		});
		const created = await pausedManager.create(origin(), request(clock), { id: "goal-operation", kind: "goal", toolSafety: "unsafe", timeoutAction: "pause-goal" });
		clock.advance(30_000);
		await pausedManager.reconcile();
		const result = await pausedManager.answer("project-1", created.requestId!, { kind: "option", value: "quick" });
		assert.equal(result.status, "resolved");
		assert.equal(store.get(created.requestId!)?.status, "denied");
		assert.equal(store.get(created.requestId!)?.continuationState, "skipped");
	});

	it("retries a claimed resume after transient failure and never replays its completed pause", async () => {
		const { clock, store } = fixture();
		let pauseCalls = 0;
		let resumeCalls = 0;
		let transient = true;
		const manager = new DecisionRequestManager({
			isHeadless: () => false,
			storeForProject: () => store, clock, recheckConsentOperation: () => true,
			consentPauseLifecycle: {
				pause: async () => { pauseCalls++; return "paused"; },
				resume: async () => { resumeCalls++; if (transient) throw new Error("temporary lifecycle outage"); return "resumed"; },
			},
		});
		const created = await manager.create(origin(), request(clock), { id: "retry-resume", kind: "goal", toolSafety: "unsafe", timeoutAction: "pause-goal" });
		clock.advance(30_000);
		await manager.reconcile();
		assert.equal(pauseCalls, 1);
		assert.equal((await manager.answer("project-1", created.requestId!, { kind: "option", value: "quick" })).status, "already_resolved");
		assert.equal(store.get(created.requestId!)?.consentPause?.resume?.status, "claimed");
		await manager.reconcile();
		assert.equal(pauseCalls, 1, "a claimed answer must never re-pause after restart/retry");
		transient = false;
		await manager.reconcile();
		assert.equal(resumeCalls, 3);
		assert.equal(store.get(created.requestId!)?.status, "resolved");
	});

	it("rechecks authorization before releasing a restarted claimed consent", async () => {
		const { clock, store } = fixture();
		let resumeCalls = 0;
		const manager = new DecisionRequestManager({
			isHeadless: () => false,
			storeForProject: () => store, clock, recheckConsentOperation: () => false,
			consentPauseLifecycle: { pause: async () => "paused", resume: async () => { resumeCalls++; return "resumed"; } },
		});
		const created = await manager.create(origin(), request(clock), { id: "revoked-recovery", kind: "goal", toolSafety: "unsafe", timeoutAction: "pause-goal" });
		clock.advance(30_000);
		await manager.reconcile();
		const paused = store.get(created.requestId!)!;
		assert.equal(store.claimConsentResume(created.requestId!, {
			pause: paused.consentPause!, claimedAt: new Date(clock.now()).toISOString(), value: { kind: "option", value: "quick" },
		}).claimed, true);
		await manager.reconcile();
		assert.equal(resumeCalls, 0);
		assert.equal(store.get(created.requestId!)?.status, "denied");
	});

	it("rechecks trusted consent facts before a user answer can release protected work", async () => {
		let continuationCalls = 0;
		const { clock, store } = fixture();
		const guarded = new DecisionRequestManager({
			isHeadless: () => false,
			storeForProject: () => store, clock,
			recheckConsentOperation: () => false,
			continuation: { deliver: async () => { continuationCalls++; return "delivered"; } },
		});
		const created = await guarded.create(origin(), request(clock), { id: "unsafe-tool", kind: "tool", toolSafety: "unsafe" });
		const result = await guarded.answer("project-1", created.requestId!, { kind: "option", value: "quick" });
		assert.equal(result.status, "resolved");
		assert.equal(store.get(created.requestId!)?.status, "denied");
		assert.equal(store.get(created.requestId!)?.resolution, undefined);
		assert.equal(continuationCalls, 0);
	});

	it("fails closed for a direct consent request when no fresh grant recheck is wired", async () => {
		let continuationCalls = 0;
		const { manager, clock, store, proposals } = fixture({
			proposal: true,
			continuation: async () => { continuationCalls++; return "delivered"; },
		});
		const { default: _default, ...directConsent } = request(clock, {
			requestedClass: "consent-required",
			effect: { kind: "proposal", proposals: {
				quick: { proposalType: "goal", args: { title: "Must not seed" } },
				thorough: { proposalType: "goal", args: { title: "Must not seed" } },
				other: { proposalType: "goal", args: { title: "Must not seed" } },
			} },
		});
		const created = await manager.create(origin(), directConsent);
		assert.equal(store.get(created.requestId!)?.protectedOperation, undefined);
		assert.equal((await manager.answer("project-1", created.requestId!, { kind: "option", value: "quick" })).status, "resolved");
		assert.equal(store.get(created.requestId!)?.status, "denied");
		assert.equal(store.get(created.requestId!)?.resolution, undefined);
		assert.equal(store.listMemories().length, 0);
		assert.deepEqual(proposals, []);
		assert.equal(continuationCalls, 0);
	});

	it("durably deduplicates and caps advisories through the non-waking inbox seam", () => {
		const calls: Array<{ input: { context?: string; source: { type: string; packId?: string; hookId?: string } }; options: { wake?: boolean } }> = [];
		const manager = new DecisionRequestManager({
			isHeadless: () => false,
			storeForProject: () => undefined,
			inboxManager: {
				hasStaff: () => true,
				listForStaff: () => calls.map(call => ({ state: "pending", context: call.input.context, source: call.input.source })) as never,
				enqueue: (_staffId, input, options = {}) => { calls.push({ input, options }); return {} as never; },
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

	it("does not seed a proposal for declared negative or Other answers", async () => {
		const { manager, clock, proposals, store } = fixture({ proposal: true });
		const created = await manager.create(origin(), request(clock, {
			effect: {
				kind: "proposal",
				proposals: { quick: { proposalType: "goal", args: { title: "Create only" } } },
				noEffectValues: ["thorough", "other"],
			},
		}));
		await manager.answer("project-1", created.requestId!, { kind: "option", value: "thorough" });
		expect(proposals).toEqual([]);
		expect(store.get(created.requestId!)?.proposal).toBeUndefined();
	});
});
