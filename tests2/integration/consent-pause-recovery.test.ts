import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "vitest";
import type { Clock, TimerHandle } from "../../src/server/gateway-deps.ts";
import { DecisionRequestManager } from "../../src/server/agent/decision-request-manager.ts";
import { DecisionRequestStore } from "../../src/server/agent/decision-request-store.ts";
import type { ValidatedExtensionDecisionRequest } from "../../src/server/agent/decision-hook-contract.ts";
import { GoalStore, type PersistedGoal } from "../../src/server/agent/goal-store.ts";
import { executePauseForGoals, pauseGoalAwaitingExtensionConsent, type GoalPauseServiceDeps } from "../../src/server/agent/goal-pause-service.ts";
import { resumeOnlyAwaitingConsentGoal } from "../../src/server/agent/goal-resume.ts";
import { InboxStore } from "../../src/server/agent/inbox-store.ts";
import { InboxManager } from "../../src/server/agent/inbox-manager.ts";
import { createMemFs, type MemFs } from "../harness/mem-fs.ts";

class ManualClock implements Clock {
	private timers: Array<{ at: number; handler: () => void; cancelled: boolean }> = [];
	constructor(private nowValue: number) {}
	now(): number { return this.nowValue; }
	setTimeout(handler: () => void, ms: number): TimerHandle {
		const timer = { at: this.nowValue + ms, handler, cancelled: false };
		this.timers.push(timer);
		return timer as unknown as TimerHandle;
	}
	setInterval(): TimerHandle { throw new Error("not used"); }
	clearTimeout(handle: TimerHandle): void { (handle as unknown as { cancelled: boolean }).cancelled = true; }
	clearInterval(): void { /* unused */ }
	advance(ms: number): void {
		this.nowValue += ms;
		for (const timer of this.timers.filter(timer => !timer.cancelled && timer.at <= this.nowValue)) {
			timer.cancelled = true;
			timer.handler();
		}
	}
}

let sequence = 0;
const PROJECT = "consent-project";
const GOAL = "consent-goal";
const SESSION = "consent-session";

function request(clock: Clock, updates: Partial<ValidatedExtensionDecisionRequest> = {}): ValidatedExtensionDecisionRequest {
	return {
		version: 1,
		key: "consent-recovery",
		title: "Protected operation",
		question: "May protected work continue?",
		options: [{ value: "allow", label: "Allow" }, { value: "deny", label: "Deny" }],
		other: { maxLength: 40 },
		default: { kind: "option", value: "deny" },
		scope: "goal",
		deadlineAt: new Date(clock.now() + 30_000).toISOString(),
		effect: { kind: "none" },
		...updates,
	};
}

function goal(): PersistedGoal {
	return { id: GOAL, title: "Protected goal", cwd: "/work", state: "in-progress", spec: "", createdAt: 1, updatedAt: 1 };
}

function origin(overrides: Record<string, unknown> = {}) {
	return { projectId: PROJECT, sessionId: SESSION, goalId: GOAL, cwd: "/work", event: "beforePrompt" as const, packId: "pack", hookId: "hook", ...overrides };
}

function runtime(options: {
	memfs?: MemFs;
	root?: string;
	clock?: ManualClock;
	headless?: boolean;
	continued?: number[];
	proposals?: Array<{ type: string; args: Record<string, unknown> }>;
} = {}) {
	const memfs = options.memfs ?? createMemFs();
	const root = options.root ?? path.join("/memfs", `consent-recovery-${sequence++}`);
	memfs.mkdirSync(root, { recursive: true });
	const clock = options.clock ?? new ManualClock(Date.parse("2026-02-03T04:05:06.000Z"));
	const decisionStore = new DecisionRequestStore(path.join(root, "decisions"), memfs);
	const goalStore = new GoalStore(path.join(root, "goals"), memfs);
	if (!goalStore.get(GOAL)) goalStore.put(goal());
	const inboxStore = new InboxStore(path.join(root, "inbox"), memfs);
	const staffIds = new Set(["staff-1"]);
	const inbox = new InboxManager({
		all: () => [{ project: { id: PROJECT }, staffStore: { get: (id: string) => staffIds.has(id) ? { id } : undefined }, inboxStore }][Symbol.iterator](),
	} as never, {} as never, () => undefined);
	const broadcasts: string[] = [];
	const pauseDeps: GoalPauseServiceDeps = {
		getGoalManagerForGoal: () => ({ getGoalStore: () => goalStore }) as never,
		verificationHarness: { getActiveVerifications: () => [], cancelStaleVerifications: async () => undefined } as never,
		sessionManager: { getAllSessionsRaw: () => [], abortSessionTurn: async () => undefined } as never,
		broadcastGoalStateChanged: id => broadcasts.push(id),
	};
	const manager = new DecisionRequestManager({
		storeForProject: id => id === PROJECT ? decisionStore : undefined,
		projectIds: () => [PROJECT],
		clock,
		isHeadless: () => options.headless === true,
		inboxManager: inbox,
		consentInboxTarget: () => "staff-1",
		recheckConsentOperation: () => true,
		consentPauseLifecycle: {
			pause: (goalId, reason, caller) => pauseGoalAwaitingExtensionConsent(pauseDeps, goalId, reason, caller),
			resume: (goalId, reason) => resumeOnlyAwaitingConsentGoal(goalStore, goalId, reason, id => broadcasts.push(id)),
		},
		continuation: options.continued ? { deliver: async () => { options.continued!.push(1); return "delivered" as const; } } : undefined,
		proposalSeedService: options.proposals ? {
			seedFromDecision: async (_session, type, args) => {
				options.proposals!.push({ type, args });
				return { ok: true as const, status: 200 as const, rev: 1, fields: {} };
			},
		} : undefined,
	});
	return { memfs, root, clock, manager, decisionStore, goalStore, inboxStore, inbox, broadcasts };
}

describe("consent pause recovery integration", () => {
	it("applies deferrable defaults but silently denies forced consent without memory, grant, proposal, or protected continuation", async () => {
		const deferrable = runtime({ headless: true });
		const ordinary = await deferrable.manager.create(origin(), request(deferrable.clock));
		assert.equal(ordinary.request?.status, "defaulted");
		assert.equal(ordinary.request?.resolution?.actor, "headless");

		const continued: number[] = [];
		const proposals: Array<{ type: string; args: Record<string, unknown> }> = [];
		const guarded = runtime({ headless: true, continued, proposals });
		const silent = await guarded.manager.create(origin(), request(guarded.clock, {
			effect: { kind: "proposal", proposals: {
				allow: { proposalType: "goal", args: { title: "must not be created" } },
				deny: { proposalType: "goal", args: { title: "must not be created" } },
				other: { proposalType: "goal", args: { title: "must not be created" } },
			} },
		}), { id: "unsafe-tool", kind: "tool", toolSafety: "unsafe" });
		const denied = guarded.decisionStore.get(silent.requestId!)!;
		assert.equal(denied.status, "denied");
		assert.equal(denied.request.default, undefined);
		assert.equal(denied.resolution, undefined);
		assert.equal(guarded.decisionStore.listMemories().length, 0);
		assert.deepEqual(continued, []);
		assert.deepEqual(proposals, []);
	});

	it("forces every trusted floor over a requested default and never persists an extension-selected allow path", async () => {
		const fixture = runtime();
		const floors = [
			{ hardCapOverride: "core-hard-cap" as const, reason: "core-hard-cap" },
			{ toolSafety: "unsafe" as const, reason: "core-unsafe-tool" },
			{ change: "capability-escalation" as const, reason: "core-capability-change" },
			{ change: "grant-change" as const, reason: "core-grant-change" },
			{ change: "configuration-change" as const, reason: "core-configuration-change" },
		];
		for (const [index, floor] of floors.entries()) {
			const created = await fixture.manager.create(origin({ sessionId: `session-${index}`, goalId: `goal-${index}` }), request(fixture.clock, { key: `floor-${index}` }), {
				id: `operation-${index}`, kind: "core", timeoutAction: "deny-operation", ...floor,
			});
			const persisted = fixture.decisionStore.get(created.requestId!)!;
			assert.equal(persisted.decisionClass, "consent-required");
			assert.equal(persisted.classificationReason, floor.reason);
			assert.equal(persisted.request.default, undefined);
			assert.equal(persisted.timeoutAction, "deny-operation");
		}
	});

	it("durably pauses at deadline, survives concurrent restart replay, and one answer resumes exactly the matching goal", async () => {
		const first = runtime();
		const created = await first.manager.create(origin(), request(first.clock), {
			id: "goal-operation", kind: "goal", toolSafety: "unsafe", timeoutAction: "pause-goal",
		});
		first.manager.stop();
		first.clock.advance(30_000);
		await first.manager.reconcile();
		const paused = first.decisionStore.get(created.requestId!)!;
		assert.equal(paused.status, "paused-awaiting-consent");
		assert.equal(first.goalStore.get(GOAL)?.paused, true);
		assert.equal(first.goalStore.get(GOAL)?.state, "in-progress", "awaiting consent is never a failed or stalled goal state");
		assert.match(JSON.stringify(first.goalStore.get(GOAL)?.pauseReason), /awaiting-extension-consent/);
		assert.equal(first.inboxStore.list("staff-1").length, 1);
		assert.equal(first.inboxStore.list("staff-1")[0]?.wake, false);

		const restarted = runtime({ memfs: first.memfs, root: first.root, clock: first.clock });
		await Promise.all([first.manager.reconcile(), restarted.manager.reconcile()]);
		assert.equal(restarted.inboxStore.list("staff-1").length, 1, "restart and concurrent replay preserve one source-key inbox reference");
		assert.equal(restarted.decisionStore.get(created.requestId!)?.status, "paused-awaiting-consent");
		const broadcastsBeforeAnswer = restarted.broadcasts.filter(id => id === GOAL).length;

		const answer = await restarted.manager.answer(PROJECT, created.requestId!, { kind: "option", value: "allow" });
		assert.equal(answer.status, "resolved");
		assert.equal(restarted.goalStore.get(GOAL)?.paused, false);
		assert.equal(restarted.decisionStore.get(created.requestId!)?.status, "resolved");
		assert.equal(restarted.inboxStore.list("staff-1")[0]?.state, "completed");
		assert.equal((await restarted.manager.answer(PROJECT, created.requestId!, { kind: "option", value: "allow" })).status, "already_resolved");
		assert.equal(restarted.broadcasts.filter(id => id === GOAL).length, broadcastsBeforeAnswer + 1, "the answer is one idempotent resume action after restart");
	});

	it("recovers a durable claimed answer before or after canonical resume without replaying the pause", async () => {
		const first = runtime();
		const created = await first.manager.create(origin(), request(first.clock), {
			id: "restart-claim", kind: "goal", toolSafety: "unsafe", timeoutAction: "pause-goal",
		});
		first.manager.stop();
		first.clock.advance(30_000);
		await first.manager.reconcile();
		const paused = first.decisionStore.get(created.requestId!)!;
		assert.equal(first.decisionStore.claimConsentResume(created.requestId!, {
			pause: paused.consentPause!, claimedAt: new Date(first.clock.now()).toISOString(), value: { kind: "option", value: "allow" },
		}).claimed, true);

		const claimBeforeResume = runtime({ memfs: first.memfs, root: first.root, clock: first.clock });
		await claimBeforeResume.manager.reconcile();
		assert.equal(claimBeforeResume.decisionStore.get(created.requestId!)?.status, "resolved");
		assert.equal(claimBeforeResume.goalStore.get(GOAL)?.paused, false);

		const second = runtime();
		const secondCreated = await second.manager.create(origin(), request(second.clock, { key: "resume-before-complete" }), {
			id: "restart-resume", kind: "goal", toolSafety: "unsafe", timeoutAction: "pause-goal",
		});
		second.manager.stop();
		second.clock.advance(30_000);
		await second.manager.reconcile();
		const secondPaused = second.decisionStore.get(secondCreated.requestId!)!;
		assert.equal(second.decisionStore.claimConsentResume(secondCreated.requestId!, {
			pause: secondPaused.consentPause!, claimedAt: new Date(second.clock.now()).toISOString(), value: { kind: "option", value: "allow" },
		}).claimed, true);
		assert.equal(await resumeOnlyAwaitingConsentGoal(second.goalStore, GOAL, secondPaused.consentPause!.reason, () => undefined), "resumed");
		const resumeBeforeComplete = runtime({ memfs: second.memfs, root: second.root, clock: second.clock });
		await resumeBeforeComplete.manager.reconcile();
		assert.equal(resumeBeforeComplete.decisionStore.get(secondCreated.requestId!)?.status, "resolved");
		assert.equal(resumeBeforeComplete.goalStore.get(GOAL)?.paused, false);
	});

	it("does not let a late consent answer resume a manual pause, and advisories remain noninterrupting", async () => {
		const fixture = runtime();
		const created = await fixture.manager.create(origin(), request(fixture.clock), {
			id: "manual-protection", kind: "goal", toolSafety: "unsafe", timeoutAction: "pause-goal",
		});
		fixture.manager.stop();
		fixture.clock.advance(30_000);
		await fixture.manager.reconcile();
		// An operator resume clears provenance. Reconciliation must not re-pause the
		// goal merely because the durable decision record is still awaiting answer.
		fixture.goalStore.update(GOAL, { paused: false, pauseReason: undefined });
		await fixture.manager.reconcile();
		assert.equal(fixture.goalStore.get(GOAL)?.paused, false);
		// A later manual pause remains independent; a late answer must not claim it.
		await executePauseForGoals({
			getGoalManagerForGoal: () => ({ getGoalStore: () => fixture.goalStore }) as never,
			verificationHarness: { getActiveVerifications: () => [], cancelStaleVerifications: async () => undefined } as never,
			sessionManager: { getAllSessionsRaw: () => [], abortSessionTurn: async () => undefined } as never,
			broadcastGoalStateChanged: () => undefined,
		}, [fixture.goalStore.get(GOAL)!], undefined);
		assert.equal((await fixture.manager.answer(PROJECT, created.requestId!, { kind: "option", value: "allow" })).status, "resolved");
		assert.equal(fixture.goalStore.get(GOAL)?.paused, true);
		assert.equal(fixture.decisionStore.get(created.requestId!)?.status, "denied");

		assert.equal(fixture.manager.advisory(origin(), { version: 1, staffId: "staff-1", key: "notice", title: "Notice", body: "No interruption" }), "enqueued");
		assert.equal(fixture.decisionStore.list().length, 1, "advisory creates no decision/deadline/default");
		const advisory = fixture.inboxStore.list("staff-1").find(entry => entry.source.type === "extension_advisory");
		assert.equal(advisory?.wake, false);
	});

	it("routes an answered configuration consent to a proposal seed only", async () => {
		const proposals: Array<{ type: string; args: Record<string, unknown> }> = [];
		const fixture = runtime({ proposals });
		const created = await fixture.manager.create(origin(), request(fixture.clock, {
			effect: { kind: "proposal", proposals: {
				allow: { proposalType: "project", args: { setting: "safe-draft" } },
				deny: { proposalType: "project", args: { setting: "keep" } },
				other: { proposalType: "project", args: { setting: "other" } },
			} },
		}), { id: "configuration", kind: "config", change: "configuration-change" });
		assert.equal((await fixture.manager.answer(PROJECT, created.requestId!, { kind: "option", value: "allow" })).status, "resolved");
		assert.deepEqual(proposals, [{ type: "project", args: { setting: "safe-draft" } }]);
		assert.deepEqual(fixture.decisionStore.get(created.requestId!)?.proposal, { status: "created", type: "project", rev: 1 });
	});
});
