import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ActionError } from "../extension-host/action-dispatcher.js";
import type { PackContributionRegistry } from "../extension-host/pack-contribution-registry.js";
import { ModuleHost, type InvokeRequest } from "../extension-host/module-host-worker.js";
import type { Clock } from "../gateway-deps.js";
import { realClock } from "../gateway-deps.js";
import type { ProposalSeedService } from "../proposals/proposal-seed-service.js";
import { packIdFromRoot, type HookContribution } from "./pack-contributions.js";
import {
	DecisionHookContractError,
	validateDecisionHookOutput,
	validateDecisionValue,
	type DecisionHookContext,
	type DecisionLifecycleEvent,
	type DecisionValue,
	type ExtensionAdvisory,
	type ValidatedDecisionHookOutput,
	type ValidatedExtensionDecisionRequest,
} from "./decision-hook-contract.js";
import {
	DecisionRequestStore,
	type ConsentTimeoutAction,
	type DecisionActor,
	type DecisionClassificationReason,
	type DecisionMemory,
	type DecisionReason,
	type StoredDecisionRequest,
} from "./decision-request-store.js";
import { resolveExtensionGrant, type ResolvedHook } from "./extension-grant-policy.js";
import type { InboxManager } from "./inbox-manager.js";
import type { ContextTraceStore, TraceDecisionOutcomeRow } from "./context-trace-store.js";

export const DECISION_SESSION_PENDING_LIMIT = 2;
export const DECISION_SESSION_24H_LIMIT = 6;
export const DECISION_GOAL_PENDING_LIMIT = 4;
export const DECISION_GOAL_24H_LIMIT = 12;
export const DECISION_CONTINUATION_MAX_ATTEMPTS = 3;
/** Durable per-staff cap for pending extension advisories. */
export const DECISION_ADVISORY_PENDING_LIMIT = 8;
const DAY_MS = 24 * 60 * 60 * 1_000;
const DECISION_TIMER_MIN_DELAY_MS = 1_000;
const DECISION_TIMER_MAX_RETRY_DELAY_MS = 60_000;

export type DecisionCreateStatus = "created" | "deduplicated" | "rejected" | "store_unavailable";
export interface DecisionCreateResult {
	status: DecisionCreateStatus;
	requestId?: string;
	request?: StoredDecisionRequest;
	code?: "DECISION_BUDGET_EXHAUSTED" | "DECISION_STORE_UNAVAILABLE" | "DECISION_SCOPE_UNAVAILABLE";
}
export type DecisionAnswerStatus = "resolved" | "already_resolved" | "invalid" | "not_found";
export type DecisionAdvisoryStatus = "enqueued" | "deduplicated" | "rejected" | "unavailable";
export interface DecisionAnswerResult {
	status: DecisionAnswerStatus;
	request?: StoredDecisionRequest;
}

export interface DecisionRequestOrigin {
	projectId: string;
	sessionId: string;
	goalId?: string;
	roleName?: string;
	cwd: string;
	event: DecisionLifecycleEvent;
	packId: string;
	hookId: string;
}

/** Minimal injectable bridge so manager tests do not need a gateway. */
export interface DecisionContinuation {
	deliver(request: StoredDecisionRequest): Promise<"delivered" | "skipped">;
	/** Releases optional ephemeral continuation context after a durable terminal delivery state. */
	complete?(request: StoredDecisionRequest): void;
}

export interface TrustedDecisionOperation {
	/** Opaque core identity; never extension-controlled arguments or policy. */
	id: string;
	kind: string;
	hardCapOverride?: "core-hard-cap";
	toolSafety?: "unsafe";
	change?: "capability-escalation" | "grant-change" | "configuration-change";
	/** Core selects only the safe settlement action, never an extension. */
	timeoutAction?: ConsentTimeoutAction;
}

export interface ConsentPauseReason {
	kind: "awaiting-extension-consent";
	requestId: string;
	createdAt: string;
}

/** The manager keeps the durable decision CAS; this bridge owns goal lifecycle side effects. */
export interface ConsentPauseLifecycle {
	pause(goalId: string, reason: ConsentPauseReason, callerSessionId?: string): Promise<"paused" | "already-paused" | "not-matching">;
	resume(goalId: string, reason: ConsentPauseReason): Promise<"resumed" | "already-resumed" | "not-matching">;
}

export interface DecisionRequestManagerDeps {
	/** Project-owned store lookup. Undefined means decisions are disabled for that project. */
	storeForProject: (projectId: string) => DecisionRequestStore | undefined;
	clock?: Clock;
	isHeadless?: () => boolean;
	inboxManager?: Pick<InboxManager, "enqueue" | "hasStaff" | "listForStaff" | "enqueueOnce" | "completeOnce" | "cancelOnce">;
	/** Returns only the origin session's still-project-owned staff id, if any. */
	consentInboxTarget?: (projectId: string, sessionId: string) => string | undefined;
	consentPauseLifecycle?: ConsentPauseLifecycle;
	/** Rebuilds hook/grant/live core facts immediately before protected work. */
	recheckConsentOperation?: (request: StoredDecisionRequest) => boolean | Promise<boolean>;
	proposalSeedService?: Pick<ProposalSeedService, "seedFromDecision">;
	trace?: Pick<ContextTraceStore, "appendOutcome">;
	/** Invalidates a REST projection only; callers must never put decision data in this frame. */
	invalidateSession?: (sessionId: string) => void;
	continuation?: DecisionContinuation;
	/** Enumerates contexts already opened at boot for restart reconciliation. */
	projectIds?: () => Iterable<string>;
}

/**
 * Sole mutating facade for project-owned decision state. All answer/default
 * paths pass through `resolve`, so first-terminal-write, memory publication and
 * user-visible invalidation stay serialized by the durable store.
 */
export class DecisionRequestManager {
	private readonly clock: Clock;
	private readonly isHeadless: () => boolean;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private continuation?: DecisionContinuation;
	/** In-process claim: a crash drops it while the durable pending marker replays at boot. */
	private readonly continuationClaims = new Set<string>();
	/** Failed terminal writes must never repeatedly schedule a zero-delay deadline timer. */
	private readonly deadlineRetryDelays = new Map<string, number>();

	constructor(private readonly deps: DecisionRequestManagerDeps) {
		this.clock = deps.clock ?? realClock;
		this.isHeadless = deps.isHeadless ?? (() => process.env.CI === "true");
		this.continuation = deps.continuation;
	}

	setContinuation(continuation: DecisionContinuation | undefined): void {
		this.continuation = continuation;
	}

	stop(): void {
		if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
		this.timer = undefined;
	}

	/** Reconcile durable records after boot, then arm exactly one earliest timer. */
	async reconcile(): Promise<void> {
		for (const projectId of this.knownProjectIds()) {
			const store = this.deps.storeForProject(projectId);
			if (!store?.isHealthy()) continue;
			store.pruneTerminalRequests(this.clock.now());
			for (const request of store.list()) {
				if (request.status === "paused-awaiting-consent") {
					await this.replayConsentPause(request);
					continue;
				}
				if (request.consentInbox && (request.consentInbox.status === "surfaced" || request.consentInbox.status === "pending")) {
					await this.settleConsentInbox(request, request.status === "denied" ? "cancelled" : "completed");
				}
				if (request.status === "pending" && (this.isHeadless() || Date.parse(request.deadlineAt) <= this.clock.now())) {
					await this.resolveTimeout(request, this.isHeadless() ? "headless" : "deadline");
					const current = store.get(request.id);
					if (current?.status === "pending") this.noteDeadlineWriteFailure(current);
					else this.clearDeadlineRetry(request);
					continue;
				}
				// A failed callback never changes the durable answer. Reconciliation is
				// its bounded replay point, including after a process restart.
				if (request.status !== "pending" && request.resolution && request.continuationState === "pending") await this.deliverContinuation(request);
			}
		}
		this.armDeadlineTimer();
	}

	/** Add a validated request, enforcing semantic dedupe and server-owned limits. */
	async create(origin: DecisionRequestOrigin, request: ValidatedExtensionDecisionRequest, operation?: TrustedDecisionOperation): Promise<DecisionCreateResult> {
		this.projects.add(origin.projectId);
		const store = this.deps.storeForProject(origin.projectId);
		if (!store?.isHealthy()) return { status: "store_unavailable", code: "DECISION_STORE_UNAVAILABLE" };
		const scopeId = scopeIdFor(request.scope, origin);
		if (!scopeId) return { status: "rejected", code: "DECISION_SCOPE_UNAVAILABLE" };
		const classification = classifyEffectiveClass(request, operation);
		const effectiveRequest = classification.decisionClass === "consent-required" ? stripDefault(request) : request;
		// Rendered prose and labels are intentionally not semantic identity: a pack
		// may improve wording without re-asking the same keyed decision. Options,
		// class, protected operation, and safe default remain exact.
		const dedupeId = fingerprint({
			version: 1, projectId: origin.projectId, target: { scope: effectiveRequest.scope, scopeId },
			asker: { packId: origin.packId, hookId: origin.hookId }, key: effectiveRequest.key,
			options: effectiveRequest.options.map(option => option.value), other: effectiveRequest.other,
			decisionClass: classification.decisionClass, protectedOperation: operation ? { id: operation.id, kind: operation.kind } : undefined,
			default: effectiveRequest.default, effect: effectiveRequest.effect,
		});
		const existing = store.findByDedupeId(dedupeId);
		if (existing) return { status: "deduplicated", requestId: existing.id, request: existing };
		// Consent answers never become a remembered authorization. Deferrable
		// requests retain the established exact-scope memory behavior.
		if (classification.decisionClass === "deferrable") {
			const memory = store.getMemory({ scope: effectiveRequest.scope, scopeId, packId: origin.packId, hookId: origin.hookId, key: effectiveRequest.key });
			if (memory) {
				try {
					validateDecisionValue(memory.value, effectiveRequest.options, effectiveRequest.other);
					return { status: "deduplicated" };
				} catch { /* stale memory is not a valid answer to this request */ }
			}
		}
		if (!withinBudgets(store, origin, this.clock.now())) {
			console.warn("[decision-requests] budget exhausted pack=%s hook=%s session=%s", origin.packId, origin.hookId, origin.sessionId);
			return { status: "rejected", code: "DECISION_BUDGET_EXHAUSTED" };
		}
		const now = new Date(this.clock.now()).toISOString();
		const timeoutAction = classification.decisionClass === "consent-required"
			? (operation?.timeoutAction === "pause-goal" && origin.goalId && this.deps.consentPauseLifecycle ? "pause-goal" : "deny-operation")
			: undefined;
		const record: StoredDecisionRequest = {
			id: randomUUID(), projectId: origin.projectId, sessionId: origin.sessionId,
			...(origin.goalId ? { goalId: origin.goalId } : {}),
			asker: { packId: origin.packId, hookId: origin.hookId, event: origin.event },
			dedupeId, questionId: fingerprint({ key: effectiveRequest.key, question: effectiveRequest.question, options: effectiveRequest.options, other: effectiveRequest.other }),
			request: effectiveRequest, decisionClass: classification.decisionClass, classificationReason: classification.reason,
			...(operation ? { protectedOperation: { id: operation.id, kind: operation.kind } } : {}),
			...(timeoutAction ? { timeoutAction } : {}),
			status: "pending", createdAt: now, deadlineAt: effectiveRequest.deadlineAt,
			continuationState: "pending", continuationAttempts: 0,
		};
		if (!store.put(record)) return { status: "store_unavailable", code: "DECISION_STORE_UNAVAILABLE" };
		if (this.isHeadless()) {
			const terminal = await this.resolveTimeout(record, "headless");
			return { status: "created", requestId: record.id, request: terminal ?? store.get(record.id) };
		}
		this.invalidate(record.sessionId);
		this.armDeadlineTimer();
		return { status: "created", requestId: record.id, request: record };
	}

	/** Typed user answer endpoint seam. It does not enqueue a prompt or agent turn. */
	async answer(projectId: string, requestId: string, rawValue: unknown): Promise<DecisionAnswerResult> {
		const store = this.deps.storeForProject(projectId);
		if (!store) return { status: "not_found" };
		const current = store.get(requestId);
		if (!current) return { status: "not_found" };
		if (current.status === "paused-awaiting-consent") return this.answerPausedConsent(current, rawValue);
		if (current.status !== "pending") return { status: "already_resolved", request: current };
		if (Date.parse(current.deadlineAt) <= this.clock.now()) {
			const resolved = await this.resolveTimeout(current, "deadline");
			return { status: "already_resolved", request: resolved ?? store.get(requestId) };
		}
		let value: Readonly<DecisionValue>;
		try {
			value = validateDecisionValue(rawValue, current.request.options, current.request.other);
		} catch {
			return { status: "invalid", request: store.get(requestId) };
		}
		if (isConsent(current)) {
			if (!await this.canSettleConsent(current)) return this.denyConsent(current);
			const resolved = await this.resolveConsent(current, value);
			return resolved.written ? { status: "resolved", request: resolved.request } : { status: "already_resolved", request: resolved.request ?? store.get(requestId) };
		}
		const resolved = await this.resolve(current, value, "user", "answered");
		return resolved.written
			? { status: "resolved", request: resolved.request }
			: { status: "already_resolved", request: resolved.request ?? store.get(requestId) };
	}

	/** Pending records for the session's REST projection. */
	listPending(projectId: string, sessionId: string): StoredDecisionRequest[] {
		return this.deps.storeForProject(projectId)?.listPending(sessionId) ?? [];
	}

	/** Lookup for a session-owned route guard; callers must verify sessionId before answering. */
	get(projectId: string, requestId: string): StoredDecisionRequest | undefined {
		return this.deps.storeForProject(projectId)?.get(requestId);
	}

	/** Exact scope lookup; never falls back across scopes, keys, packs, or hooks. */
	getMemory(origin: Pick<DecisionRequestOrigin, "projectId" | "sessionId" | "goalId" | "packId" | "hookId">, scope: ValidatedExtensionDecisionRequest["scope"], key: string): DecisionValue | undefined {
		const scopeId = scopeIdFor(scope, origin);
		if (!scopeId) return undefined;
		return this.deps.storeForProject(origin.projectId)?.getMemory({ scope, scopeId, packId: origin.packId, hookId: origin.hookId, key })?.value;
	}

	/** Advisories reuse the durable inbox but do not create an immediate staff wake. */
	advisory(origin: Pick<DecisionRequestOrigin, "packId" | "hookId" | "sessionId">, advisory: ExtensionAdvisory): DecisionAdvisoryStatus {
		const inbox = this.deps.inboxManager;
		if (!inbox || !inbox.hasStaff(advisory.staffId)) return "unavailable";
		try {
			const pending = inbox.listForStaff(advisory.staffId, "pending");
			const marker = advisoryMarker(advisory.key);
			const extensionPending = pending.filter(entry => entry.source.type === "extension_advisory");
			if (extensionPending.some(entry => entry.source.packId === origin.packId && entry.source.hookId === origin.hookId && entry.context === marker)) return "deduplicated";
			if (extensionPending.length >= DECISION_ADVISORY_PENDING_LIMIT) {
				console.warn("[decision-requests] advisory budget exhausted pack=%s hook=%s session=%s", origin.packId, origin.hookId, origin.sessionId);
				return "rejected";
			}
			inbox.enqueue(advisory.staffId, {
				title: advisory.title, prompt: advisory.body, context: marker,
				source: { type: "extension_advisory", packId: origin.packId, hookId: origin.hookId },
			}, { wake: false });
			return "enqueued";
		} catch { return "unavailable"; }
	}

	private async resolveTimeout(record: StoredDecisionRequest, actor: "deadline" | "headless"): Promise<StoredDecisionRequest | undefined> {
		if (isConsent(record)) {
			if (record.timeoutAction === "pause-goal" && record.goalId && this.deps.consentPauseLifecycle) return this.pauseConsent(record);
			return (await this.denyConsent(record)).request;
		}
		const defaultValue = record.request.default;
		if (!defaultValue) return undefined; // Historical corrupt records fail closed.
		const result = await this.resolve(record, defaultValue, actor, actor === "deadline" ? "deadline_elapsed" : "headless_default", "defaulted");
		return result.written ? result.request : undefined;
	}

	/** Consent rejection writes no value, memory, proposal, or continuation. */
	private async denyConsent(record: StoredDecisionRequest): Promise<DecisionAnswerResult> {
		const store = this.deps.storeForProject(record.projectId);
		if (!store?.isHealthy()) return { status: "already_resolved" };
		const result = store.writeTerminalFirst(record.id, {
			status: "denied", resolvedAt: new Date(this.clock.now()).toISOString(),
		});
		const settled = result.request;
		if (result.written && settled) {
			store.updateContinuation(settled.id, { continuationState: "skipped", continuationAttempts: settled.continuationAttempts });
			this.invalidate(settled.sessionId);
			await this.settleConsentInbox(settled, "cancelled");
			this.armDeadlineTimer();
		}
		return { status: result.written ? "resolved" : "already_resolved", request: result.request ?? store.get(record.id) };
	}

	private async pauseConsent(record: StoredDecisionRequest): Promise<StoredDecisionRequest | undefined> {
		const store = this.deps.storeForProject(record.projectId);
		if (!store?.isHealthy() || !record.goalId) return undefined;
		const now = new Date(this.clock.now()).toISOString();
		const pause = { goalId: record.goalId, reason: { kind: "awaiting-extension-consent" as const, requestId: record.id, createdAt: now } };
		const result = store.writeConsentPauseFirst(record.id, {
			pausedAt: now, pause,
			inbox: { sourceKey: consentSourceKey(record), status: "pending", updatedAt: now },
		});
		const paused = result.request;
		if (!paused) return undefined;
		if (result.written) this.invalidate(paused.sessionId);
		await this.replayConsentPause(paused);
		this.armDeadlineTimer();
		return store.get(record.id);
	}

	/** Replays post-CAS goal and inbox work; neither failure may turn a pause into a failure. */
	private async replayConsentPause(record: StoredDecisionRequest): Promise<void> {
		if (record.status !== "paused-awaiting-consent" || !record.consentPause) return;
		try {
			const outcome = await this.deps.consentPauseLifecycle?.pause(record.consentPause.goalId, record.consentPause.reason, record.sessionId);
			if (outcome === "not-matching") {
				await this.settleConsentInbox(record, "cancelled");
				return;
			}
		} catch { return; }
		await this.surfaceConsentInbox(record);
	}

	private async surfaceConsentInbox(record: StoredDecisionRequest): Promise<void> {
		const store = this.deps.storeForProject(record.projectId);
		const inbox = record.consentInbox;
		if (!store || !inbox || inbox.status !== "pending") return;
		const staffId = this.deps.consentInboxTarget?.(record.projectId, record.sessionId);
		if (!staffId || !this.deps.inboxManager?.hasStaff(staffId)) {
			store.updateConsentInboxSurface(record.id, inbox.sourceKey, { status: "projection-only", updatedAt: new Date(this.clock.now()).toISOString() });
			return;
		}
		try {
			const result = this.deps.inboxManager.enqueueOnce?.(staffId, {
				title: record.request.title, prompt: record.request.question,
				context: `consent-decision:${record.id}`,
				source: { type: "consent_pause", sourceKey: inbox.sourceKey, requestId: record.id, questionId: record.questionId },
			});
			if (result) store.updateConsentInboxSurface(record.id, inbox.sourceKey, {
				status: "surfaced", entryId: result.entry.id, updatedAt: new Date(this.clock.now()).toISOString(),
			});
		} catch { /* durable pause remains actionable through the decision projection */ }
	}

	private async answerPausedConsent(record: StoredDecisionRequest, rawValue: unknown): Promise<DecisionAnswerResult> {
		const store = this.deps.storeForProject(record.projectId);
		if (!store || !record.consentPause) return { status: "already_resolved", request: record };
		let value: Readonly<DecisionValue>;
		try { value = validateDecisionValue(rawValue, record.request.options, record.request.other); }
		catch { return { status: "invalid", request: record }; }
		const claimed = store.claimConsentResume(record.id, { pause: record.consentPause, claimedAt: new Date(this.clock.now()).toISOString() });
		if (!claimed.claimed || !claimed.request) return { status: "already_resolved", request: claimed.request ?? store.get(record.id) };
		// Re-read immediately before goal release. A revocation between the typed
		// answer and this durable claim is denied rather than releasing work.
		if (!await this.canSettleConsent(claimed.request)) return this.finishPausedConsent(claimed.request, value, "denied");
		let outcome: "resumed" | "already-resumed" | "not-matching" = "not-matching";
		try { outcome = await this.deps.consentPauseLifecycle!.resume(record.consentPause.goalId, record.consentPause.reason); }
		catch { outcome = "not-matching"; }
		return this.finishPausedConsent(claimed.request, value, outcome);
	}

	private async finishPausedConsent(record: StoredDecisionRequest, value: Readonly<DecisionValue>, outcome: "resumed" | "already-resumed" | "not-matching" | "denied"): Promise<DecisionAnswerResult> {
		const store = this.deps.storeForProject(record.projectId);
		if (!store || !record.consentPause) return { status: "already_resolved", request: record };
		const completedAt = new Date(this.clock.now()).toISOString();
		const terminal = outcome === "resumed" || outcome === "already-resumed" || outcome === "denied"
			? { status: outcome === "denied" ? "denied" as const : "resolved" as const, resolvedAt: completedAt,
				...(outcome === "denied" ? {} : { resolution: { value: cloneValue(value), actor: "user" as const, reason: "answered" as const } }) }
			: undefined;
		const completed = store.completeConsentResume(record.id, { pause: record.consentPause, completedAt, outcome, ...(terminal ? { terminal } : {}) });
		const settled = completed.request ?? store.get(record.id);
		if (!completed.completed || !settled) return { status: "already_resolved", request: settled };
		if (outcome === "not-matching") {
			await this.settleConsentInbox(settled, "cancelled");
			return { status: "already_resolved", request: settled };
		}
		this.invalidate(settled.sessionId);
		await this.settleConsentInbox(settled, outcome === "denied" ? "cancelled" : "completed");
		if (outcome === "denied") {
			store.updateContinuation(settled.id, { continuationState: "skipped", continuationAttempts: settled.continuationAttempts });
			return { status: "already_resolved", request: store.get(record.id) };
		}
		const fresh = store.get(record.id)!;
		this.traceResolution(fresh);
		await this.routeProposal(fresh);
		await this.deliverContinuation(fresh);
		return { status: "resolved", request: store.get(record.id) };
	}

	private async settleConsentInbox(record: StoredDecisionRequest, status: "completed" | "cancelled"): Promise<void> {
		const inbox = record.consentInbox;
		if (!inbox || inbox.status === "projection-only" || inbox.status === status) return;
		const staffId = this.deps.consentInboxTarget?.(record.projectId, record.sessionId);
		if (!staffId || !inbox.entryId) return;
		try {
			if (status === "completed") this.deps.inboxManager?.completeOnce?.(staffId, inbox.entryId, "Consent answered");
			else this.deps.inboxManager?.cancelOnce?.(staffId, inbox.entryId, "Consent no longer awaiting");
		} catch { return; }
		this.deps.storeForProject(record.projectId)?.updateConsentInboxSurface(record.id, inbox.sourceKey, {
			status, updatedAt: new Date(this.clock.now()).toISOString(),
		});
	}

	private async canSettleConsent(record: StoredDecisionRequest): Promise<boolean> {
		if (!record.protectedOperation) return true;
		try { return await (this.deps.recheckConsentOperation?.(record) ?? true); }
		catch { return false; }
	}

	private async resolveConsent(record: StoredDecisionRequest, value: Readonly<DecisionValue>): Promise<{ written: boolean; request?: StoredDecisionRequest }> {
		const store = this.deps.storeForProject(record.projectId);
		if (!store?.isHealthy()) return { written: false };
		const resolvedAt = new Date(this.clock.now()).toISOString();
		const result = store.writeTerminalFirst(record.id, { status: "resolved", resolvedAt, resolution: { value: cloneValue(value), actor: "user", reason: "answered" } });
		if (!result.written || !result.request) return result;
		this.invalidate(result.request.sessionId);
		this.traceResolution(result.request);
		await this.routeProposal(result.request);
		await this.deliverContinuation(result.request);
		this.armDeadlineTimer();
		return result;
	}

	private async resolve(record: StoredDecisionRequest, value: Readonly<DecisionValue>, actor: DecisionActor, reason: DecisionReason, status: "resolved" | "defaulted" = "resolved"): Promise<{ written: boolean; request?: StoredDecisionRequest }> {
		const store = this.deps.storeForProject(record.projectId);
		if (!store?.isHealthy()) return { written: false };
		const scopeId = scopeIdFor(record.request.scope, record);
		if (!scopeId) return { written: false };
		const resolvedAt = new Date(this.clock.now()).toISOString();
		const memory: DecisionMemory = {
			scope: record.request.scope, scopeId, packId: record.asker.packId, hookId: record.asker.hookId,
			key: record.request.key, value: cloneValue(value), validatedAt: resolvedAt, sourceRequestId: record.id,
		};
		const result = store.writeTerminalFirst(record.id, {
			status, resolvedAt, resolution: { value: cloneValue(value), actor, reason },
		}, memory);
		if (!result.written || !result.request) return result;
		this.invalidate(result.request.sessionId);
		this.traceResolution(result.request);
		await this.routeProposal(result.request);
		await this.deliverContinuation(result.request);
		this.armDeadlineTimer();
		return result;
	}

	private async routeProposal(record: StoredDecisionRequest): Promise<void> {
		if (record.request.effect?.kind !== "proposal" || !record.resolution) return;
		const key = record.resolution.value.kind === "option" ? record.resolution.value.value : "other";
		const seed = record.request.effect.proposals[key];
		if (!seed || !this.deps.proposalSeedService) return;
		try {
			const result = await this.deps.proposalSeedService.seedFromDecision(
				record.sessionId,
				seed.proposalType as Parameters<ProposalSeedService["seedFromDecision"]>[1],
				seed.args,
			);
			const store = this.deps.storeForProject(record.projectId);
			if (result.ok) store?.updateProposal(record.id, { status: "created", type: seed.proposalType, rev: result.rev });
			else store?.updateProposal(record.id, { status: "failed", type: seed.proposalType, code: "PROPOSAL_SEED_FAILED" });
		} catch {
			this.deps.storeForProject(record.projectId)?.updateProposal(record.id, { status: "failed", type: seed.proposalType, code: "PROPOSAL_SEED_FAILED" });
		}
	}

	private async deliverContinuation(record: StoredDecisionRequest): Promise<void> {
		const continuation = this.continuation;
		const store = this.deps.storeForProject(record.projectId);
		if (!continuation || !store || record.continuationState !== "pending") {
			if (!continuation && store) store.updateContinuation(record.id, { continuationState: "skipped", continuationAttempts: record.continuationAttempts });
			return;
		}
		const claim = `${record.projectId}:${record.id}`;
		// The claim is acquired before an await. A concurrent answer/reconcile sees
		// it synchronously and cannot invoke onDecision a second time.
		if (this.continuationClaims.has(claim)) return;
		this.continuationClaims.add(claim);
		try {
			// Do not use the caller's snapshot after acquiring the claim: another
			// resolution path may have terminalized or completed it before this turn.
			const current = store.get(record.id);
			if (!current || current.status === "pending" || current.status === "paused-awaiting-consent" || !current.resolution || current.continuationState !== "pending") return;
			// A consent response cannot release a protected hook after its grant or
			// live trusted facts changed while this delivery was queued.
			if (isConsent(current) && !await this.canSettleConsent(current)) {
				store.updateContinuation(current.id, { continuationState: "skipped", continuationAttempts: current.continuationAttempts });
				return;
			}
			if (current.continuationAttempts >= DECISION_CONTINUATION_MAX_ATTEMPTS) {
				if (store.updateContinuation(current.id, { continuationState: "skipped", continuationAttempts: current.continuationAttempts })) this.completeContinuation(continuation, current);
				return;
			}
			const attempts = current.continuationAttempts + 1;
			try {
				const outcome = await continuation.deliver(current);
				const latest = store.get(current.id);
				if (latest?.continuationState === "pending" && store.updateContinuation(current.id, { continuationState: outcome, continuationAttempts: attempts })) {
					this.completeContinuation(continuation, current);
				}
			} catch {
				// Keep one failed attempt pending for a later reconciliation retry. The
				// terminal answer never changes, and a fresh record prevents stale writes.
				const latest = store.get(current.id);
				if (latest?.continuationState === "pending") {
					const state = attempts >= DECISION_CONTINUATION_MAX_ATTEMPTS ? "skipped" : "pending";
					if (store.updateContinuation(current.id, { continuationState: state, continuationAttempts: attempts }) && state === "skipped") this.completeContinuation(continuation, current);
				}
			}
		} finally {
			this.continuationClaims.delete(claim);
		}
	}

	private completeContinuation(continuation: DecisionContinuation, record: StoredDecisionRequest): void {
		try { continuation.complete?.(record); } catch { /* cache cleanup cannot affect decision delivery */ }
	}

	private traceResolution(record: StoredDecisionRequest): void {
		const resolution = record.resolution;
		if (!resolution) return;
		try {
			this.deps.trace?.appendOutcome(record.sessionId, {
				kind: "decision", packId: record.asker.packId, hookId: record.asker.hookId,
				event: "decisionResolved", outcome: "applied", requestId: record.id, questionId: record.questionId,
				answer: resolution.value.kind === "option" ? resolution.value.value : "other",
				defaultApplied: resolution.actor !== "user", actor: resolution.actor,
				reason: resolution.actor === "deadline" ? "Deadline elapsed" : resolution.actor === "headless" ? "Headless default" : undefined,
			});
		} catch { /* tracing is never on the answer path */ }
	}

	private invalidate(sessionId: string): void {
		try { this.deps.invalidateSession?.(sessionId); } catch { /* metadata projection is best effort */ }
	}

	private armDeadlineTimer(): void {
		this.stop();
		if (this.isHeadless()) return;
		let earliest: StoredDecisionRequest | undefined;
		for (const projectId of this.knownProjectIds()) {
			for (const request of this.deps.storeForProject(projectId)?.listPending() ?? []) {
				if (!earliest || request.deadlineAt < earliest.deadlineAt) earliest = request;
			}
		}
		if (!earliest) return;
		const untilDeadline = Date.parse(earliest.deadlineAt) - this.clock.now();
		const retryDelay = this.deadlineRetryDelays.get(deadlineRetryKey(earliest));
		this.timer = this.clock.setTimeout(
			() => { void this.reconcile(); },
			untilDeadline <= 0 ? retryDelay ?? DECISION_TIMER_MIN_DELAY_MS : Math.max(DECISION_TIMER_MIN_DELAY_MS, untilDeadline),
		);
	}

	private noteDeadlineWriteFailure(record: StoredDecisionRequest): void {
		const key = deadlineRetryKey(record);
		const previous = this.deadlineRetryDelays.get(key) ?? DECISION_TIMER_MIN_DELAY_MS;
		this.deadlineRetryDelays.set(key, Math.min(DECISION_TIMER_MAX_RETRY_DELAY_MS, previous * 2));
	}

	private clearDeadlineRetry(record: StoredDecisionRequest): void {
		this.deadlineRetryDelays.delete(deadlineRetryKey(record));
	}

	private knownProjectIds(): string[] {
		// Store lookup is intentionally injectable. Integrations can enumerate all
		// opened project contexts at boot; newly observed projects are retained too.
		for (const projectId of this.deps.projectIds?.() ?? []) this.projects.add(projectId);
		return [...this.projects];
	}
	private projects = new Set<string>();
	/** Integration helper: registering a project also makes boot reconciliation cover it. */
	registerProject(projectId: string): void { this.projects.add(projectId); }
}

/** Bounded lifecycle branch. It imports only granted, active decide hooks. */
export class DecisionHookDispatcher implements DecisionContinuation {
	private readonly contexts = new Map<string, DecisionRequestOrigin>();

	constructor(private readonly deps: {
		manager: DecisionRequestManager;
		registry: PackContributionRegistry;
		moduleHost: ModuleHost;
		grantsForProject: (projectId: string) => readonly import("./project-config-store.js").ExtensionGrant[];
	}) {
		deps.manager.setContinuation(this);
	}

	async dispatch(event: DecisionLifecycleEvent, context: Omit<DecisionRequestOrigin, "event" | "packId" | "hookId">): Promise<TraceDecisionOutcomeRow[]> {
		const outcomes: TraceDecisionOutcomeRow[] = [];
		this.deps.manager.registerProject(context.projectId);
		const hooks = this.deps.registry.listHooks(context.projectId);
		for (const hook of hooks) {
			if (hook.mode !== "decide" || !hook.events.includes(event)) continue;
			const origin: DecisionRequestOrigin = { ...context, event, packId: packIdFromRoot(hook.packRoot), hookId: hook.id };
			const active = resolvedHooks(this.deps.registry, context.projectId);
			if (!resolveExtensionGrant(active, this.deps.grantsForProject(context.projectId), { packId: origin.packId, hookId: origin.hookId }, "decide").allowed) {
				outcomes.push(outcome(origin, "denied", "Grant required"));
				continue;
			}
			const started = Date.now();
			try {
				const value = await this.invoke(hook, "decide", hookContext(origin));
				const parsed = validateDecisionHookOutput(value);
				if (!parsed) continue;
				outcomes.push(await this.apply(origin, parsed, Math.max(0, Date.now() - started)));
			} catch (error) {
				outcomes.push(outcome(origin, "error", isTimeout(error) ? "Timed out" : error instanceof DecisionHookContractError ? "Malformed result" : undefined, Math.max(0, Date.now() - started)));
			}
		}
		return outcomes;
	}

	async deliver(record: StoredDecisionRequest): Promise<"delivered" | "skipped"> {
		const origin = this.contexts.get(record.id) ?? {
			projectId: record.projectId, sessionId: record.sessionId, goalId: record.goalId,
			cwd: process.cwd(), event: record.asker.event, packId: record.asker.packId, hookId: record.asker.hookId,
		};
		const hook = this.deps.registry.listHooks(record.projectId).find(candidate =>
			candidate.id === record.asker.hookId && packIdFromRoot(candidate.packRoot) === record.asker.packId && candidate.mode === "decide",
		);
		if (!hook || !resolveExtensionGrant(resolvedHooks(this.deps.registry, record.projectId), this.deps.grantsForProject(record.projectId), { packId: record.asker.packId, hookId: record.asker.hookId }, "decide").allowed) return "skipped";
		try {
			await this.invoke(hook, "onDecision", { ...hookContext(origin), requestId: record.id, resolution: record.resolution! });
			return "delivered";
		} catch (error) {
			if (error instanceof ActionError && error.status === 404) return "skipped";
			throw error;
		}
	}

	complete(record: StoredDecisionRequest): void {
		this.contexts.delete(record.id);
	}

	private async apply(origin: DecisionRequestOrigin, parsed: ValidatedDecisionHookOutput, ms: number): Promise<TraceDecisionOutcomeRow> {
		if (parsed.kind === "advisory") {
			const advised = this.deps.manager.advisory(origin, parsed.advisory);
			return outcome(origin, advised === "enqueued" ? "advised" : advised === "deduplicated" ? "superseded" : "dropped", advised === "deduplicated" ? "Duplicate" : advised === "rejected" ? "Budget exhausted" : undefined, ms, "advisory");
		}
		const created = await this.deps.manager.create(origin, parsed.request);
		if (created.requestId) this.contexts.set(created.requestId, origin);
		if (created.status === "rejected") return outcome(origin, "dropped", created.code === "DECISION_SCOPE_UNAVAILABLE" ? "Unavailable value" : "Budget exhausted", ms);
		if (created.status === "store_unavailable") return outcome(origin, "dropped", "Unavailable value", ms);
		return { ...outcome(origin, created.status === "deduplicated" ? "superseded" : "applied", created.status === "deduplicated" ? "Duplicate" : undefined, ms), requestId: created.requestId, questionId: created.request?.questionId };
	}

	private invoke(hook: HookContribution, member: "decide" | "onDecision", ctx: DecisionHookContext | import("./decision-hook-contract.js").DecisionResolutionContext): Promise<unknown> {
		const url = pathToFileURL(path.resolve(path.dirname(hook.sourceFile), hook.module)).href;
		return this.deps.moduleHost.invoke({ url, packRoot: hook.packRoot, epoch: 0, exportKind: "hooks", member, ctx, arg: undefined, workingDir: ctx.cwd } as InvokeRequest<DecisionHookContext>, hook.budget.timeoutMs);
	}
}

function advisoryMarker(key: string): string { return `extension-advisory-key:${key}`; }

function classifyEffectiveClass(request: ValidatedExtensionDecisionRequest, operation?: TrustedDecisionOperation): { decisionClass: "deferrable" | "consent-required"; reason: DecisionClassificationReason } {
	if (operation?.hardCapOverride === "core-hard-cap") return { decisionClass: "consent-required", reason: "core-hard-cap" };
	if (operation?.toolSafety === "unsafe") return { decisionClass: "consent-required", reason: "core-unsafe-tool" };
	if (operation?.change === "capability-escalation") return { decisionClass: "consent-required", reason: "core-capability-change" };
	if (operation?.change === "grant-change") return { decisionClass: "consent-required", reason: "core-grant-change" };
	if (operation?.change === "configuration-change") return { decisionClass: "consent-required", reason: "core-configuration-change" };
	return { decisionClass: request.requestedClass === "consent-required" ? "consent-required" : "deferrable", reason: "requested" };
}

/** A platform elevation deliberately erases the untrusted default before every persistence boundary. */
function stripDefault(request: ValidatedExtensionDecisionRequest): StoredDecisionRequest["request"] {
	const { default: _default, ...withoutDefault } = request;
	return { ...withoutDefault, requestedClass: request.requestedClass };
}
function isConsent(request: StoredDecisionRequest): boolean { return request.decisionClass === "consent-required"; }
function consentSourceKey(record: Pick<StoredDecisionRequest, "projectId" | "id">): string { return `consent-pause:${record.projectId}:${record.id}`; }
function deadlineRetryKey(record: Pick<StoredDecisionRequest, "projectId" | "id">): string { return `${record.projectId}:${record.id}`; }
function scopeIdFor(scope: ValidatedExtensionDecisionRequest["scope"], origin: Pick<DecisionRequestOrigin, "projectId" | "sessionId" | "goalId">): string | undefined {
	return scope === "project" ? origin.projectId : scope === "session" ? origin.sessionId : origin.goalId;
}
function withinBudgets(store: DecisionRequestStore, origin: Pick<DecisionRequestOrigin, "sessionId" | "goalId">, now: number): boolean {
	const recent = store.list().filter(request => Date.parse(request.createdAt) > now - DAY_MS);
	const pending = store.listPending();
	if (pending.filter(request => request.sessionId === origin.sessionId).length >= DECISION_SESSION_PENDING_LIMIT) return false;
	if (recent.filter(request => request.sessionId === origin.sessionId).length >= DECISION_SESSION_24H_LIMIT) return false;
	if (origin.goalId) {
		if (pending.filter(request => request.goalId === origin.goalId).length >= DECISION_GOAL_PENDING_LIMIT) return false;
		if (recent.filter(request => request.goalId === origin.goalId).length >= DECISION_GOAL_24H_LIMIT) return false;
	}
	return true;
}
function fingerprint(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
function cloneValue(value: Readonly<DecisionValue>): DecisionValue { return value.kind === "option" ? { kind: "option", value: value.value } : { kind: "other", text: value.text }; }
function hookContext(origin: DecisionRequestOrigin): DecisionHookContext {
	return { event: origin.event, sessionId: origin.sessionId, projectId: origin.projectId, ...(origin.goalId ? { goalId: origin.goalId } : {}), ...(origin.roleName ? { roleName: origin.roleName } : {}), cwd: origin.cwd };
}
function resolvedHooks(registry: PackContributionRegistry, projectId: string): ResolvedHook[] {
	return registry.listHooks(projectId).map(hook => ({ packId: packIdFromRoot(hook.packRoot), hookId: hook.id, mode: hook.mode, capabilities: hook.capabilities }));
}
function outcome(origin: Pick<DecisionRequestOrigin, "packId" | "hookId" | "event">, state: TraceDecisionOutcomeRow["outcome"], reason?: TraceDecisionOutcomeRow["reason"], ms?: number, kind: "decision" | "advisory" = "decision"): TraceDecisionOutcomeRow {
	return { kind, packId: origin.packId, hookId: origin.hookId, event: origin.event, outcome: state, ...(reason ? { reason } : {}), ...(ms === undefined ? {} : { ms }) };
}
function isTimeout(error: unknown): boolean { return error instanceof ActionError ? error.status === 504 : error instanceof Error && error.message.includes("timed out"); }
