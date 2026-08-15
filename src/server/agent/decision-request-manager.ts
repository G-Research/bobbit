import { createHash, randomUUID } from "node:crypto";
import { isKnownThinkingLevel } from "../../shared/thinking-levels.js";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ActionError } from "../extension-host/action-dispatcher.js";
import type { PackContributionRegistry } from "../extension-host/pack-contribution-registry.js";
import { ModuleHost, type InvokeRequest } from "../extension-host/module-host-worker.js";
import type { Clock } from "../gateway-deps.js";
import { realClock } from "../gateway-deps.js";
import type { ProposalDraftOwner, ProposalSeedService } from "../proposals/proposal-seed-service.js";
import { packIdFromRoot, type HookContribution } from "./pack-contributions.js";
import {
	DecisionHookContractError,
	validateDecisionHookOutput,
	validateProjectImportDecisionHookOutput,
	type ProjectImportDecisionHookContext,
	type ProjectImportDecisionResolutionContext,
	validateDecisionValue,
	type DecisionHookContext,
	type DecisionLifecycleEvent,
	type StaffImprovementSignals,
	type DecisionValue,
	type ExtensionAdvisory,
	type ValidatedDecisionHookOutput,
	type ValidatedExtensionDecisionRequest,
	type ProposalType,
} from "./decision-hook-contract.js";
import {
	DecisionRequestStore,
	type StoredProjectImportRun,
	type ImportDecisionOutcomeCode,
	type ConsentTimeoutAction,
	type DecisionActor,
	type DecisionClassificationReason,
	type DecisionMemory,
	type DecisionReason,
	type DecisionDelivery,
	type StoredDecisionRequest,
} from "./decision-request-store.js";
import { resolveExtensionGrant, type ResolvedHook } from "./extension-grant-policy.js";
import type { InboxManager } from "./inbox-manager.js";
import type { ContextTraceStore, TraceDecisionOutcomeRow } from "./context-trace-store.js";
import { trustedOperationForExtensionDecision } from "./trusted-decision-operation.js";
import { snapshotStaffImprovementSignals } from "./staff-improvement-signals.js";
import {
	admitAdvisorySelection,
	reduceAdvisorySelectionCandidates,
	snapshotAdvisorySelectionAvailability,
	type AdvisorySelectionAvailability,
	type AdvisorySelectionCandidate,
	type ValidatedAdvisorySelectionProposal,
} from "./advisory-selection-contract.js";
import type { AdvisoryThinkingConsumer } from "./advisory-thinking-consumer.js";
import {
	canonicalizeCapabilityQuery,
	DynamicCapabilityContractError,
	reduceCapabilitySelectionCandidates,
	snapshotCapabilityAvailability,
	validateCapabilityProposal,
	type CapabilitySelectorStage,
	type CapabilitySelectionCandidate,
} from "./dynamic-capability-contract.js";
import type { CapabilitySelectionContext, CapabilityStageResult } from "./lifecycle-hub.js";

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

/** Project registration has a durable target, not a synthetic agent session. */
export interface ProjectImportDecisionRequestOrigin {
	projectId: string;
	importId: string;
	event: "projectImported";
	packId: string;
	hookId: string;
}

type AnyDecisionRequestOrigin = DecisionRequestOrigin | ProjectImportDecisionRequestOrigin;

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
	inboxManager?: Pick<InboxManager, "enqueue" | "hasStaff" | "listForStaff">
		& Partial<Pick<InboxManager, "enqueueOnce" | "completeOnce" | "cancelOnce">>;
	/** Returns only the origin session's still-project-owned staff id, if any. */
	consentInboxTarget?: (projectId: string, sessionId: string) => string | undefined;
	consentPauseLifecycle?: ConsentPauseLifecycle;
	/** Rebuilds hook/grant/live core facts immediately before protected work. */
	recheckConsentOperation?: (request: StoredDecisionRequest) => boolean | Promise<boolean>;
	proposalSeedService?: Pick<ProposalSeedService, "seedFromDecision">;
	trace?: Pick<ContextTraceStore, "appendOutcome" | "appendProjectImportOutcome">;
	/** Invalidates a REST projection only; callers must never put decision data in this frame. */
	invalidateSession?: (sessionId: string) => void;
	/** Metadata-only invalidation for a project-import decision projection. */
	invalidateProjectImport?: (projectId: string) => void;
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
	/**
	 * Prevent concurrent timer/startup/manual reconciliation from invoking the
	 * external canonical pause lifecycle twice. It is intentionally ephemeral:
	 * a crash leaves the durable pause intent available for boot replay.
	 */
	private readonly consentReplayClaims = new Set<string>();
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
	async create(origin: AnyDecisionRequestOrigin, request: ValidatedExtensionDecisionRequest, operation?: TrustedDecisionOperation): Promise<DecisionCreateResult> {
		this.projects.add(origin.projectId);
		const store = this.deps.storeForProject(origin.projectId);
		if (!store?.isHealthy()) return { status: "store_unavailable", code: "DECISION_STORE_UNAVAILABLE" };
		const scopeId = scopeIdFor(request.scope, origin);
		if (!scopeId || origin.event === "projectImported" && request.scope !== "project") return { status: "rejected", code: "DECISION_SCOPE_UNAVAILABLE" };
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
		const existing = classification.decisionClass === "consent-required"
			? store.findActiveByDedupeId(dedupeId)
			: store.findByDedupeId(dedupeId);
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
			console.warn("[decision-requests] budget exhausted pack=%s hook=%s delivery=%s", origin.packId, origin.hookId, deliveryId(origin));
			return { status: "rejected", code: "DECISION_BUDGET_EXHAUSTED" };
		}
		const now = new Date(this.clock.now()).toISOString();
		const timeoutAction = classification.decisionClass === "consent-required"
			? (operation?.timeoutAction === "pause-goal" && isSessionOrigin(origin) && origin.goalId && this.deps.consentPauseLifecycle ? "pause-goal" : "deny-operation")
			: undefined;
		const delivery = deliveryFor(origin);
		const record: StoredDecisionRequest = {
			id: randomUUID(), projectId: origin.projectId, delivery,
			...(isSessionOrigin(origin) ? { sessionId: origin.sessionId, ...(origin.goalId ? { goalId: origin.goalId } : {}) } : {}),
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
		this.invalidate(record);
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

	/** Pending records for callers that must only consider deadline-eligible work. */
	listPending(projectId: string, sessionId: string): StoredDecisionRequest[] {
		return this.deps.storeForProject(projectId)?.listPending(sessionId) ?? [];
	}

	/** Project-owned projection seam; it can never leak a session delivery. */
	listPendingImportRequests(projectId: string, importId: string): StoredDecisionRequest[] {
		return this.deps.storeForProject(projectId)?.listPendingImportRequests(importId) ?? [];
	}

	/** Import-run state remains in the same project-owned atomic snapshot as requests. */
	getImportRun(projectId: string, importId: string): StoredProjectImportRun | undefined {
		return this.deps.storeForProject(projectId)?.getImportRun(importId);
	}

	ensureImportHooks(projectId: string, importId: string, hookKeys: readonly string[]): StoredProjectImportRun | undefined {
		return this.deps.storeForProject(projectId)?.ensureImportHooks(importId, hookKeys);
	}

	completeImportHook(projectId: string, importId: string, hookKey: string, outcome: ImportDecisionOutcomeCode): boolean {
		return this.deps.storeForProject(projectId)?.completeImportHook(importId, hookKey, outcome, new Date(this.clock.now()).toISOString()) ?? false;
	}

	/** Actionable session records include a durable consent pause awaiting its one answer. */
	listActionable(projectId: string, sessionId: string): StoredDecisionRequest[] {
		return (this.deps.storeForProject(projectId)?.list() ?? []).filter(request =>
			request.delivery.kind === "session" && request.delivery.sessionId === sessionId && (request.status === "pending" || request.status === "paused-awaiting-consent"),
		);
	}

	/** Lookup for a session-owned route guard; callers must verify sessionId before answering. */
	get(projectId: string, requestId: string): StoredDecisionRequest | undefined {
		return this.deps.storeForProject(projectId)?.get(requestId);
	}

	/** Exact scope lookup; never falls back across scopes, keys, packs, or hooks. */
	getMemory(origin: Pick<DecisionRequestOrigin, "projectId" | "sessionId" | "goalId" | "packId" | "hookId"> | Pick<ProjectImportDecisionRequestOrigin, "projectId" | "importId" | "packId" | "hookId">, scope: ValidatedExtensionDecisionRequest["scope"], key: string): DecisionValue | undefined {
		const scopeId = scopeIdFor(scope, origin);
		if (!scopeId) return undefined;
		return this.deps.storeForProject(origin.projectId)?.getMemory({ scope, scopeId, packId: origin.packId, hookId: origin.hookId, key })?.value;
	}

	/** Advisories reuse the durable inbox but do not create an immediate staff wake. */
	advisory(origin: Pick<AnyDecisionRequestOrigin, "packId" | "hookId">, advisory: ExtensionAdvisory): DecisionAdvisoryStatus {
		const inbox = this.deps.inboxManager;
		if (!inbox || !inbox.hasStaff(advisory.staffId)) return "unavailable";
		try {
			const pending = inbox.listForStaff(advisory.staffId, "pending");
			const marker = advisoryMarker(advisory.key);
			const extensionPending = pending.filter(entry => entry.source.type === "extension_advisory");
			if (extensionPending.some(entry => entry.source.packId === origin.packId && entry.source.hookId === origin.hookId && entry.context === marker)) return "deduplicated";
			if (extensionPending.length >= DECISION_ADVISORY_PENDING_LIMIT) {
				console.warn("[decision-requests] advisory budget exhausted pack=%s hook=%s", origin.packId, origin.hookId);
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
			this.traceResolution(settled);
			this.invalidate(settled);
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
		if (result.written) {
			this.traceResolution(paused);
			this.invalidate(paused);
		}
		await this.replayConsentPause(paused);
		this.armDeadlineTimer();
		return store.get(record.id);
	}

	/** Replays post-CAS goal and inbox work; neither failure may turn a pause into a failure. */
	private async replayConsentPause(record: StoredDecisionRequest): Promise<void> {
		if (record.status !== "paused-awaiting-consent" || !record.consentPause) return;
		// A durable claimed answer is a different recovery phase. Never replay the
		// pause after the user action, especially after an operator resumed it.
		if (record.consentPause.resume?.status === "claimed") {
			await this.resumeClaimedConsent(record);
			return;
		}
		const claim = `${record.projectId}:${record.id}`;
		// A concurrent explicit reconcile can race the deadline timer after the
		// durable CAS and before the canonical pause promise settles. Claim before
		// the first await; crash recovery remains possible because this is not state.
		if (this.consentReplayClaims.has(claim)) return;
		this.consentReplayClaims.add(claim);
		try {
			if (!record.consentPause.pauseAppliedAt) {
				if (!this.deps.consentPauseLifecycle) return;
				try {
					const outcome = await this.deps.consentPauseLifecycle.pause(record.consentPause.goalId, record.consentPause.reason, record.delivery.kind === "session" ? record.delivery.sessionId : undefined);
					if (outcome === "not-matching") {
						await this.settleConsentInbox(record, "cancelled");
						return;
					}
					this.deps.storeForProject(record.projectId)?.markConsentPauseApplied(record.id, record.consentPause, new Date(this.clock.now()).toISOString());
				} catch { return; }
			}
			await this.surfaceConsentInbox(this.deps.storeForProject(record.projectId)?.get(record.id) ?? record);
		} finally {
			this.consentReplayClaims.delete(claim);
		}
	}

	private async surfaceConsentInbox(record: StoredDecisionRequest): Promise<void> {
		const store = this.deps.storeForProject(record.projectId);
		const inbox = record.consentInbox;
		if (!store || !inbox || inbox.status !== "pending") return;
		if (record.delivery.kind !== "session") return;
		const staffId = this.deps.consentInboxTarget?.(record.projectId, record.delivery.sessionId);
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
		const claimed = store.claimConsentResume(record.id, {
			pause: record.consentPause, claimedAt: new Date(this.clock.now()).toISOString(), value: cloneValue(value),
		});
		if (!claimed.claimed || !claimed.request) return { status: "already_resolved", request: claimed.request ?? store.get(record.id) };
		return this.resumeClaimedConsent(claimed.request);
	}

	/** Complete a persisted claim. Resume failures remain claimed for boot/reconcile retry. */
	private async resumeClaimedConsent(record: StoredDecisionRequest): Promise<DecisionAnswerResult> {
		const resume = record.consentPause?.resume;
		if (!record.consentPause || resume?.status !== "claimed") return { status: "already_resolved", request: record };
		// A legacy/incomplete durable claim contains no validated user choice and
		// can only fail closed; new claims always persist the schema-valid value.
		if (!resume.value) return this.finishPausedConsent(record, undefined, "denied");
		// This recheck is deliberately immediately before the recovered release;
		// the continuation path repeats it immediately before protected delivery.
		if (!await this.canSettleConsent(record)) return this.finishPausedConsent(record, resume.value, "denied");
		if (!this.deps.consentPauseLifecycle) return { status: "already_resolved", request: record };
		let outcome: "resumed" | "already-resumed" | "not-matching";
		try { outcome = await this.deps.consentPauseLifecycle.resume(record.consentPause.goalId, record.consentPause.reason); }
		catch { return { status: "already_resolved", request: record }; }
		return this.finishPausedConsent(record, resume.value, outcome);
	}

	private async finishPausedConsent(record: StoredDecisionRequest, value: Readonly<DecisionValue> | undefined, outcome: "resumed" | "already-resumed" | "not-matching" | "denied"): Promise<DecisionAnswerResult> {
		const store = this.deps.storeForProject(record.projectId);
		if (!store || !record.consentPause) return { status: "already_resolved", request: record };
		const completedAt = new Date(this.clock.now()).toISOString();
		const denied = outcome === "denied" || outcome === "not-matching";
		if (!denied && !value) return { status: "already_resolved", request: record };
		const terminal = { status: denied ? "denied" as const : "resolved" as const, resolvedAt: completedAt,
			...(denied ? {} : { resolution: { value: cloneValue(value!), actor: "user" as const, reason: "answered" as const } }) };
		const completed = store.completeConsentResume(record.id, { pause: record.consentPause, completedAt, outcome, terminal });
		const settled = completed.request ?? store.get(record.id);
		if (!completed.completed || !settled) return { status: "already_resolved", request: settled };
		this.invalidate(settled);
		await this.settleConsentInbox(settled, denied ? "cancelled" : "completed");
		if (denied) {
			store.updateContinuation(settled.id, { continuationState: "skipped", continuationAttempts: settled.continuationAttempts });
			this.traceResolution(store.get(record.id) ?? settled);
			this.armDeadlineTimer();
			return { status: "resolved", request: store.get(record.id) };
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
		if (record.delivery.kind !== "session") return;
		const staffId = this.deps.consentInboxTarget?.(record.projectId, record.delivery.sessionId);
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
		// Every consent response, including a hook's direct consent request with
		// no core-owned protected operation, requires a fresh active-hook + exact
		// decide-grant recheck. Missing wiring and recheck failures deny by default.
		if (!this.deps.recheckConsentOperation) return false;
		try { return await this.deps.recheckConsentOperation(record); }
		catch { return false; }
	}

	private async resolveConsent(record: StoredDecisionRequest, value: Readonly<DecisionValue>): Promise<{ written: boolean; request?: StoredDecisionRequest }> {
		const store = this.deps.storeForProject(record.projectId);
		if (!store?.isHealthy()) return { written: false };
		const resolvedAt = new Date(this.clock.now()).toISOString();
		const result = store.writeTerminalFirst(record.id, { status: "resolved", resolvedAt, resolution: { value: cloneValue(value), actor: "user", reason: "answered" } });
		if (!result.written || !result.request) return result;
		this.invalidate(result.request);
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
		this.invalidate(result.request);
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
		const owner: string | ProposalDraftOwner = record.delivery.kind === "session"
			? record.delivery.sessionId
			: { kind: "project-import", projectId: record.projectId, importId: record.delivery.importId, requestId: record.id };
		try {
			const proposalService = this.deps.proposalSeedService as unknown as {
				seedFromDecision(owner: string | ProposalDraftOwner, type: ProposalType, args: Record<string, unknown>): ReturnType<ProposalSeedService["seedFromDecision"]>;
			};
			const result = await proposalService.seedFromDecision(
				owner,
				seed.proposalType,
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
		const decisionStatus = record.status === "resolved" || record.status === "defaulted" || record.status === "denied" || record.status === "paused-awaiting-consent"
			? record.status : undefined;
		if (!decisionStatus) return;
		const outcome: TraceDecisionOutcomeRow = {
			kind: "decision", packId: record.asker.packId, hookId: record.asker.hookId,
			event: "decisionResolved", outcome: record.status === "denied" ? "denied" : "applied", requestId: record.id, questionId: record.questionId,
			...(resolution ? {
				answer: resolution.value.kind === "option" ? resolution.value.value : "other",
				defaultApplied: resolution.actor !== "user", actor: resolution.actor,
				reason: resolution.actor === "deadline" ? "Deadline elapsed" : resolution.actor === "headless" ? "Headless default" : undefined,
			} : {}),
			decisionClass: record.decisionClass ?? "deferrable", decisionStatus,
			classificationReason: record.classificationReason ?? "requested",
			...(record.timeoutAction ? { timeoutAction: record.timeoutAction } : {}),
			...(record.consentPause?.resume ? { resumeStatus: record.consentPause.resume.status } : {}),
		};
		try {
			if (record.delivery.kind === "session") this.deps.trace?.appendOutcome(record.delivery.sessionId, outcome);
			else this.deps.trace?.appendProjectImportOutcome(record.projectId, record.delivery.importId, outcome);
		} catch { /* tracing is never on the answer path */ }
	}

	private invalidate(record: Pick<StoredDecisionRequest, "projectId" | "delivery">): void {
		try {
			if (record.delivery.kind === "session") this.deps.invalidateSession?.(record.delivery.sessionId);
			else this.deps.invalidateProjectImport?.(record.projectId);
		} catch { /* metadata projection is best effort */ }
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
		/** Evaluated only when at least one active decision hook may run. */
		availabilityForProject?: (projectId: string) => Promise<AdvisorySelectionAvailability> | AdvisorySelectionAvailability;
		/** Fixture seam only until core has a transcript-safe bounded histogram owner. */
		staffImprovementSignalsForSession?: (sessionId: string) => StaffImprovementSignals | undefined;
		thinkingConsumer?: AdvisoryThinkingConsumer;
	}) {
		deps.manager.setContinuation(this);
	}

	async dispatch(
		event: DecisionLifecycleEvent,
		context: Omit<DecisionRequestOrigin, "event" | "packId" | "hookId"> & {
			usage?: import("./lifecycle-hub.js").TurnUsageSnapshot;
			/** Ordinary completed-turn index, retained for non-scheduled decisions. */
			turnIndex?: number;
			/** Persisted advisor cadence; required for every-N scheduled decisions. */
			cadenceTurnIndex?: number;
		},
	): Promise<TraceDecisionOutcomeRow[]> {
		return (await this.dispatchInternal(event, context, false)).outcomes;
	}

	/**
	 * Awaited setup-only decision path. It shares the ordinary active-pack, exact
	 * grant, isolation, validation, admission, and reduction fences, but returns
	 * the reduced thinking candidate instead of trying to mutate a not-yet-live
	 * session. Callers receive no raw hook output.
	 */
	async dispatchSetup(
		context: Omit<DecisionRequestOrigin, "event" | "packId" | "hookId">,
	): Promise<{ outcomes: TraceDecisionOutcomeRow[]; thinkingLevel?: string }> {
		const result = await this.dispatchInternal("sessionSetup", context, true);
		const thinking = result.reduction.thinking?.selection;
		return { outcomes: result.outcomes, ...(thinking?.kind === "thinking" ? { thinkingLevel: thinking.thinkingLevel } : {}) };
	}

	/**
	 * Registration-only dispatch. The context was already atomically persisted by
	 * the coordinator, so restart/retry never reads the filesystem or invents a
	 * session. Pending hook records are written before code is invoked.
	 */
	async dispatchProjectImport(projectId: string, importId: string): Promise<readonly TraceDecisionOutcomeRow[]> {
		this.deps.manager.registerProject(projectId);
		const run = this.deps.manager.getImportRun(projectId, importId);
		if (!run || run.completedAt) return [];
		const hooks = this.projectImportHooks(projectId);
		const keyed = hooks.map(candidate => ({ ...candidate, origin: { ...candidate.origin, importId }, key: `${candidate.origin.packId}:${candidate.origin.hookId}` }));
		const admitted = this.deps.manager.ensureImportHooks(projectId, importId, keyed.map(candidate => candidate.key));
		if (!admitted) return [];

		const outcomes: TraceDecisionOutcomeRow[] = [];
		const currentKeys = new Set(keyed.map(candidate => candidate.key));
		// A declaration disabled between a crash and replay is explicitly denied;
		// it cannot remain an unbounded pending import hook.
		for (const [key, entry] of Object.entries(admitted.hooks)) {
			if (entry.state === "pending" && !currentKeys.has(key)
				&& this.deps.manager.completeImportHook(projectId, importId, key, "denied")) {
				const [packId, hookId] = key.split(":", 2);
				outcomes.push(outcome({ packId: packId!, hookId: hookId!, event: "projectImported" }, "denied", "Grant required"));
			}
		}

		for (const candidate of keyed) {
			const latest = this.deps.manager.getImportRun(projectId, importId);
			if (latest?.hooks[candidate.key]?.state !== "pending") continue;
			const started = Date.now();
			let row: TraceDecisionOutcomeRow;
			try {
				if (!this.isStillProjectImportDispatchable(projectId, candidate.origin)) {
					row = outcome(candidate.origin, "denied", "Grant required", elapsed(started));
				} else {
					const value = await this.invoke(candidate.hook, "decide", importContext(run));
					const parsed = validateProjectImportDecisionHookOutput(value);
					const ms = elapsed(started);
					if (!parsed) row = outcome(candidate.origin, "applied", undefined, ms);
					else if (parsed.kind === "selection" || parsed.kind === "request-mutation") row = outcome(candidate.origin, "dropped", "Unavailable value", ms);
					else if (!this.isStillProjectImportDispatchable(projectId, candidate.origin)) row = outcome(candidate.origin, "denied", "Grant required", ms);
					else row = await this.apply(candidate.origin, parsed, ms, false);
				}
			} catch (error) {
				const ms = elapsed(started);
				row = isTimeout(error) ? outcome(candidate.origin, "dropped", "Timed out", ms)
					: error instanceof DecisionHookContractError ? outcome(candidate.origin, "dropped", "Malformed result", ms)
					: outcome(candidate.origin, "error", undefined, ms);
			}
			// Lack of a current exact grant is intentionally non-terminal. The
			// registration snapshot remains pending so an authenticated operator
			// grant can replay this same immutable import run; it never executes
			// merely because the checkout supplied an extension_grants row.
			const awaitingOperatorGrant = row.outcome === "denied" && row.reason === "Grant required";
			const completion = row.outcome === "error" ? "error" : row.outcome === "denied" ? "denied"
				: row.outcome === "dropped" ? "dropped" : row.outcome === "superseded" ? "superseded" : "applied";
			if (awaitingOperatorGrant || this.deps.manager.completeImportHook(projectId, importId, candidate.key, completion)) outcomes.push(row);
		}
		return outcomes;
	}

	private async dispatchInternal(
		event: DecisionLifecycleEvent,
		context: Omit<DecisionRequestOrigin, "event" | "packId" | "hookId"> & {
			usage?: import("./lifecycle-hub.js").TurnUsageSnapshot;
			turnIndex?: number;
			cadenceTurnIndex?: number;
		},
		returnSetupSelection: boolean,
	): Promise<{ outcomes: TraceDecisionOutcomeRow[]; reduction: ReturnType<typeof reduceAdvisorySelectionCandidates> }> {
		this.deps.manager.registerProject(context.projectId);
		const hooks = this.dispatchHooks(event, context);
		// This is also the strict no-hook fast path: no availability lookup, worker
		// import, trace selection row, store write, or runtime mutation occurs.
		if (hooks.length === 0) return { outcomes: [], reduction: Object.freeze({}) };

		let availability: Readonly<AdvisorySelectionAvailability>;
		try {
			availability = snapshotAdvisorySelectionAvailability(await this.deps.availabilityForProject?.(context.projectId) ?? emptyAvailability());
		} catch {
			availability = emptyAvailability();
		}

		const settled = await Promise.all(hooks.map(async ({ hook, origin, priority }) => {
			const started = Date.now();
			try {
				const active = resolvedHooks(this.deps.registry, context.projectId);
				if (!resolveExtensionGrant(active, this.deps.grantsForProject(context.projectId), { packId: origin.packId, hookId: origin.hookId }, "decide").allowed) {
					return { immediate: outcome(origin, "denied", "Grant required", Math.max(0, Date.now() - started)) };
				}
				const signals = hook.schedule?.kind === "decision"
					? snapshotStaffImprovementSignals(this.deps.staffImprovementSignalsForSession?.(context.sessionId))
					: undefined;
				const value = await this.invoke(hook, "decide", hookContext(origin, context.usage, availability, signals));
				const parsed = validateDecisionHookOutput(value);
				if (!parsed) return {};
				const ms = Math.max(0, Date.now() - started);
				// Request mutation has its own transient dispatcher and is never a
				// decision request. Keep this boundary even though this validator call
				// currently rejects it without its event/request application context.
				if (parsed.kind === "request-mutation") return {};
				if (parsed.kind !== "selection") {
					if (!this.isStillDispatchable(event, context, origin)) return { immediate: outcome(origin, "denied", "Grant required", ms) };
					return { immediate: await this.apply(origin, parsed, ms, isScheduledDecisionHook(hook)) };
				}
				const selection = admitAdvisorySelection(parsed.selection, availability);
				if (!selection) return { immediate: selectionOutcome(origin, parsed.selection, "dropped", "Unavailable value", ms) };
				if (!resolveExtensionGrant(resolvedHooks(this.deps.registry, context.projectId), this.deps.grantsForProject(context.projectId), { packId: origin.packId, hookId: origin.hookId }, "decide").allowed) {
					return { immediate: selectionOutcome(origin, selection, "denied", "Grant required", ms) };
				}
				return { selection: { origin, candidate: { source: { packId: origin.packId, hookId: origin.hookId }, selection, priority }, ms } };
			} catch (error) {
				const ms = Math.max(0, Date.now() - started);
				if (isTimeout(error)) return { immediate: outcome(origin, "dropped", "Timed out", ms) };
				if (error instanceof DecisionHookContractError) return { immediate: outcome(origin, "dropped", "Malformed result", ms) };
				return { immediate: outcome(origin, "error", undefined, ms) };
			}
		}));

		const outcomes: TraceDecisionOutcomeRow[] = settled.flatMap(result => result.immediate ? [result.immediate] : []);
		const selections = settled.flatMap(result => result.selection ? [result.selection] : []);
		const reduction = reduceAdvisorySelectionCandidates(selections.map(entry => entry.candidate));
		for (const entry of selections) {
			const winner = reduction[entry.candidate.selection.kind];
			if (!winner || !sameCandidate(winner, entry.candidate)) {
				outcomes.push(selectionOutcome(entry.origin, entry.candidate.selection, "superseded", "Lower-priority selection", entry.ms));
				continue;
			}
			if (returnSetupSelection && entry.candidate.selection.kind === "thinking") {
				outcomes.push(selectionOutcome(entry.origin, entry.candidate.selection, "advised", undefined, entry.ms, selectionValue(entry.candidate.selection)));
				continue;
			}
			outcomes.push(await this.applySelection(event, entry.origin, entry.candidate.selection, entry.ms));
		}
		return { outcomes, reduction };
	}

	/**
	 * Executes the narrowly declared startup selector surface. Capability ids are
	 * admitted only by the pure reducer against the core-provided ceiling; hooks
	 * never receive policy, config, paths, or mutable session state.
	 */
	async selectCapabilities(stage: CapabilitySelectorStage, context: CapabilitySelectionContext): Promise<CapabilityStageResult> {
		if (!context.projectId) return emptyCapabilityStageResult();
		const safeContext = capabilityContext(context);
		const hooks = this.capabilityHooks(stage, safeContext);
		if (hooks.length === 0) return emptyCapabilityStageResult();

		const settled = await Promise.all(hooks.map(async ({ hook, origin }) => {
			const started = Date.now();
			try {
				// Both fences re-enumerate the active, shadow-collapsed registry and
				// grants. A selector disabled or revoked while running cannot reduce.
				const active = this.capabilityHooks(stage, safeContext).find(candidate =>
					candidate.origin.packId === origin.packId && candidate.origin.hookId === origin.hookId,
				);
				if (!active || !resolveExtensionGrant(
					resolvedHooks(this.deps.registry, context.projectId!), this.deps.grantsForProject(context.projectId!),
					{ packId: origin.packId, hookId: origin.hookId }, "decide",
				).allowed) return { outcome: capabilityOutcome(origin, stage, "denied", "Grant required", elapsed(started)) };

				const member = stage === "skills" ? "selectSkills" : "selectMcp";
				const proposal = validateCapabilityProposal(await this.invoke(hook, member, safeContext));
				const ms = elapsed(started);
				const after = this.capabilityHooks(stage, safeContext).find(candidate =>
					candidate.origin.packId === origin.packId && candidate.origin.hookId === origin.hookId,
				);
				if (!after || !resolveExtensionGrant(
					resolvedHooks(this.deps.registry, context.projectId!), this.deps.grantsForProject(context.projectId!),
					{ packId: origin.packId, hookId: origin.hookId }, "decide",
				).allowed) return { outcome: capabilityOutcome(origin, stage, "denied", "Grant required", ms) };
				const candidate: CapabilitySelectionCandidate = Object.freeze({
					source: Object.freeze({ packId: origin.packId, hookId: origin.hookId }),
					priority: after.priority,
					proposal,
				});
				return { candidate, origin, ms };
			} catch (error) {
				const ms = elapsed(started);
				if (isTimeout(error)) return { outcome: capabilityOutcome(origin, stage, "dropped", "Timed out", ms) };
				if (error instanceof DynamicCapabilityContractError) return { outcome: capabilityOutcome(origin, stage, "dropped", "Malformed result", ms) };
				return { outcome: capabilityOutcome(origin, stage, "error", undefined, ms) };
			}
		}));

		const candidates = settled.flatMap(result => result.candidate ? [result.candidate] : []);
		const reduction = reduceCapabilitySelectionCandidates(candidates, safeContext.available);
		const outcomes = settled.flatMap(result => result.outcome ? [result.outcome] : []);
		for (const result of settled) {
			if (!result.candidate || !result.origin || result.ms === undefined) continue;
			const winner = reduction.winner;
			outcomes.push(capabilityOutcome(
				result.origin, stage,
				winner && sameCapabilityCandidate(winner, result.candidate) ? "advised" : "superseded",
				winner && sameCapabilityCandidate(winner, result.candidate) ? undefined : "Lower-priority selection",
				result.ms,
			));
		}
		return Object.freeze({ selected: reduction.selected, authoritative: reduction.winner !== undefined, outcomes: Object.freeze(outcomes) });
	}

	private capabilityHooks(stage: CapabilitySelectorStage, context: CapabilitySelectionContext): Array<{ hook: HookContribution; origin: DecisionRequestOrigin; priority: number }> {
		if (!context.projectId) return [];
		return activePacks(this.deps.registry, context.projectId).flatMap((pack, priority) =>
			pack.hooks
				.filter(hook => hook.mode === "decide" && hook.events.includes("sessionSetup") && hookSelectors(hook).includes(stage))
				.map(hook => {
					const origin: DecisionRequestOrigin = {
						projectId: context.projectId!, sessionId: context.sessionId, goalId: context.goalId,
						roleName: context.roleName, cwd: context.cwd, event: "sessionSetup",
						packId: pack.packId, hookId: hook.id,
					};
					return { hook, priority, origin };
				})
				.sort((a, b) => a.hook.id.localeCompare(b.hook.id) || (a.hook.listName ?? "").localeCompare(b.hook.listName ?? "")),
		);
	}

	private dispatchHooks(event: DecisionLifecycleEvent, context: Omit<DecisionRequestOrigin, "event" | "packId" | "hookId"> & { turnIndex?: number; cadenceTurnIndex?: number }): Array<{ hook: HookContribution; origin: DecisionRequestOrigin; priority: number }> {
		// Registry `list` is the sole active, shadow-collapsed low→high pack order.
		// Scheduled advisors remain on LifecycleHub's advisory-only path; only due,
		// explicitly decision-kind declarations enter this ordinary dispatcher.
		return activePacks(this.deps.registry, context.projectId).flatMap((pack, priority) =>
			pack.hooks
				.filter(hook => hook.mode === "decide" && hook.events.includes(event) && isDispatchableDecisionHook(hook, event, context.cadenceTurnIndex))
				.map(hook => ({ hook, priority, origin: { ...context, event, packId: pack.packId, hookId: hook.id } }))
				.sort((a, b) => a.hook.id.localeCompare(b.hook.id) || (a.hook.listName ?? "").localeCompare(b.hook.listName ?? "")),
		);
	}

	private projectImportHooks(projectId: string): Array<{ hook: HookContribution; origin: ProjectImportDecisionRequestOrigin }> {
		return activePacks(this.deps.registry, projectId).flatMap(pack => pack.hooks
			.filter(hook => hook.mode === "decide" && hook.events.includes("projectImported"))
			.map(hook => ({ hook, origin: { projectId, importId: "", event: "projectImported" as const, packId: pack.packId, hookId: hook.id } }))
			.sort((a, b) => a.origin.hookId.localeCompare(b.origin.hookId) || (a.hook.listName ?? "").localeCompare(b.hook.listName ?? "")),
		);
	}

	private isStillProjectImportDispatchable(projectId: string, origin: Pick<ProjectImportDecisionRequestOrigin, "packId" | "hookId">): boolean {
		return this.projectImportHooks(projectId).some(candidate => candidate.origin.packId === origin.packId && candidate.origin.hookId === origin.hookId)
			&& resolveExtensionGrant(resolvedHooks(this.deps.registry, projectId), this.deps.grantsForProject(projectId), origin, "decide").allowed;
	}

	private isStillDispatchable(
		event: DecisionLifecycleEvent,
		context: Omit<DecisionRequestOrigin, "event" | "packId" | "hookId"> & { turnIndex?: number; cadenceTurnIndex?: number },
		origin: Pick<DecisionRequestOrigin, "packId" | "hookId">,
	): boolean {
		return this.dispatchHooks(event, context).some(candidate => candidate.origin.packId === origin.packId && candidate.origin.hookId === origin.hookId)
			&& resolveExtensionGrant(resolvedHooks(this.deps.registry, context.projectId), this.deps.grantsForProject(context.projectId), origin, "decide").allowed;
	}

	private async applySelection(event: DecisionLifecycleEvent, origin: DecisionRequestOrigin, selection: ValidatedAdvisorySelectionProposal, ms: number): Promise<TraceDecisionOutcomeRow> {
		if (selection.kind !== "thinking" || event !== "afterTurn" || !this.deps.thinkingConsumer) {
			return selectionOutcome(origin, selection, "advised", undefined, ms, selectionValue(selection));
		}
		const requested = isKnownThinkingLevel(selection.thinkingLevel);
		if (!requested) return selectionOutcome(origin, selection, "dropped", "Unavailable value", ms);
		try {
			const applied = await this.deps.thinkingConsumer.apply({
				sessionId: origin.sessionId, projectId: origin.projectId, requested,
				source: { packId: origin.packId, hookId: origin.hookId },
			});
			if (applied.status === "applied") return selectionOutcome(origin, selection, "applied", undefined, ms, applied.effectiveThinkingLevel);
			if (applied.status === "pinned") return selectionOutcome(origin, selection, "denied", "User pin", ms);
			if (applied.status === "denied") return selectionOutcome(origin, selection, "denied", "Grant required", ms);
			if (applied.status === "unavailable") return selectionOutcome(origin, selection, "dropped", "Unavailable value", ms);
			return selectionOutcome(origin, selection, "error", undefined, ms);
		} catch {
			return selectionOutcome(origin, selection, "error", undefined, ms);
		}
	}

	async deliver(record: StoredDecisionRequest): Promise<"delivered" | "skipped"> {
		if (record.delivery.kind === "project-import") {
			const origin: ProjectImportDecisionRequestOrigin = {
				projectId: record.projectId, importId: record.delivery.importId, event: "projectImported",
				packId: record.asker.packId, hookId: record.asker.hookId,
			};
			if (!this.isStillProjectImportDispatchable(record.projectId, origin)) return "skipped";
			const hook = this.projectImportHooks(record.projectId).find(candidate => candidate.origin.packId === origin.packId && candidate.origin.hookId === origin.hookId)?.hook;
			const run = this.deps.manager.getImportRun(record.projectId, record.delivery.importId);
			if (!hook || !run) return "skipped";
			try {
				await this.invoke(hook, "onDecision", { ...importContext(run), requestId: record.id, resolution: record.resolution! });
				return "delivered";
			} catch (error) {
				if (error instanceof ActionError && error.status === 404) return "skipped";
				throw error;
			}
		}
		const origin = this.contexts.get(record.id) ?? {
			projectId: record.projectId, sessionId: record.delivery.sessionId, goalId: record.goalId,
			cwd: process.cwd(), event: record.asker.event as DecisionLifecycleEvent, packId: record.asker.packId, hookId: record.asker.hookId,
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

	private async apply(origin: AnyDecisionRequestOrigin, parsed: Exclude<ValidatedDecisionHookOutput, { kind: "selection" } | { kind: "request-mutation" }>, ms: number, scheduledDecision: boolean): Promise<TraceDecisionOutcomeRow> {
		if (parsed.kind === "advisory") {
			const advised = this.deps.manager.advisory(origin, parsed.advisory);
			return outcome(origin, advised === "enqueued" ? "advised" : advised === "deduplicated" ? "superseded" : "dropped", advised === "deduplicated" ? "Duplicate" : advised === "rejected" ? "Budget exhausted" : undefined, ms, "advisory");
		}
		// This adapter is the only extension-output path into `create()`. It derives
		// sensitive change facts from validated proposal semantics; a hook cannot
		// submit an operation, lower the class, or select its timeout behavior.
		const request = scheduledDecision && parsed.request.effect.kind === "proposal"
			? admitScheduledProposalConsent(parsed.request)
			: parsed.request;
		// A scheduled proposal is an opt-in draft action, not a generic effect
		// router. Reject misleading or inverted mappings before they become durable.
		if (!request) return outcome(origin, "dropped", "Malformed result", ms);
		const created = await this.deps.manager.create(origin, request, trustedOperationForExtensionDecision(request));
		if (created.requestId && isSessionOrigin(origin)) this.contexts.set(created.requestId, origin);
		if (created.status === "rejected") return outcome(origin, "dropped", created.code === "DECISION_SCOPE_UNAVAILABLE" ? "Unavailable value" : "Budget exhausted", ms);
		if (created.status === "store_unavailable") return outcome(origin, "dropped", "Unavailable value", ms);
		return { ...outcome(origin, created.status === "deduplicated" ? "superseded" : "applied", created.status === "deduplicated" ? "Duplicate" : undefined, ms), requestId: created.requestId, questionId: created.request?.questionId };
	}

	private invoke(hook: HookContribution, member: "decide" | "onDecision" | "selectSkills" | "selectMcp", ctx: DecisionHookContext | import("./decision-hook-contract.js").DecisionResolutionContext | ProjectImportDecisionHookContext | ProjectImportDecisionResolutionContext | CapabilitySelectionContext): Promise<unknown> {
		const url = pathToFileURL(path.resolve(path.dirname(hook.sourceFile), hook.module)).href;
		const workingDir = "cwd" in ctx ? ctx.cwd : ctx.projectRoot;
		return this.deps.moduleHost.invoke({ url, packRoot: hook.packRoot, epoch: 0, exportKind: "hooks", member, ctx, arg: undefined, workingDir } as InvokeRequest<DecisionHookContext>, hook.budget.timeoutMs);
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
function isSessionOrigin(origin: AnyDecisionRequestOrigin): origin is DecisionRequestOrigin {
	return origin.event !== "projectImported";
}
function deliveryFor(origin: AnyDecisionRequestOrigin): DecisionDelivery {
	return isSessionOrigin(origin) ? { kind: "session", sessionId: origin.sessionId } : { kind: "project-import", importId: origin.importId };
}
function deliveryId(origin: AnyDecisionRequestOrigin): string {
	return isSessionOrigin(origin) ? origin.sessionId : origin.importId;
}
function scopeIdFor(
	scope: ValidatedExtensionDecisionRequest["scope"],
	origin: Pick<DecisionRequestOrigin, "projectId" | "sessionId" | "goalId"> | Pick<ProjectImportDecisionRequestOrigin, "projectId" | "importId"> | Pick<StoredDecisionRequest, "projectId" | "sessionId" | "goalId" | "delivery">,
): string | undefined {
	if (scope === "project") return origin.projectId;
	if (scope === "session") return "sessionId" in origin ? origin.sessionId : undefined;
	return "goalId" in origin ? origin.goalId : undefined;
}
function withinBudgets(store: DecisionRequestStore, origin: AnyDecisionRequestOrigin, now: number): boolean {
	const records = store.list();
	const recent = records.filter(request => Date.parse(request.createdAt) > now - DAY_MS);
	// An awaiting-consent pause is still interrupting work and consumes the
	// same caps, but must never be treated as a deadline-timer candidate.
	const active = records.filter(request => request.status === "pending" || request.status === "paused-awaiting-consent");
	const delivery = deliveryFor(origin);
	const sameDelivery = (request: StoredDecisionRequest) => {
		if (delivery.kind === "session") return request.delivery.kind === "session" && request.delivery.sessionId === delivery.sessionId;
		return request.delivery.kind === "project-import" && request.delivery.importId === delivery.importId;
	};
	if (active.filter(sameDelivery).length >= DECISION_SESSION_PENDING_LIMIT) return false;
	if (recent.filter(sameDelivery).length >= DECISION_SESSION_24H_LIMIT) return false;
	if (isSessionOrigin(origin) && origin.goalId) {
		if (active.filter(request => request.goalId === origin.goalId).length >= DECISION_GOAL_PENDING_LIMIT) return false;
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
function importContext(run: StoredProjectImportRun): ProjectImportDecisionHookContext {
	// The store validates this snapshot on every load; defensive JSON copying
	// prevents a module from mutating a shared durable object in-process.
	return Object.freeze(JSON.parse(JSON.stringify(run.context))) as ProjectImportDecisionHookContext;
}

function hookContext(
	origin: DecisionRequestOrigin,
	usage?: import("./lifecycle-hub.js").TurnUsageSnapshot,
	availableSelections?: Readonly<AdvisorySelectionAvailability>,
	staffImprovementSignals?: StaffImprovementSignals,
): DecisionHookContext {
	return Object.freeze({
		event: origin.event, sessionId: origin.sessionId, projectId: origin.projectId,
		...(origin.goalId ? { goalId: origin.goalId } : {}),
		...(origin.roleName ? { roleName: origin.roleName } : {}),
		cwd: origin.cwd,
		...(origin.event === "afterTurn" && usage ? { usage } : {}),
		...(availableSelections ? { availableSelections } : {}),
		...(staffImprovementSignals ? { staffImprovementSignals } : {}),
	}) as DecisionHookContext;
}
function isScheduledDecisionHook(hook: HookContribution): boolean {
	return hook.schedule?.kind === "decision" && hook.schedule.everyNTurns !== undefined;
}

function isDispatchableDecisionHook(hook: HookContribution, event: DecisionLifecycleEvent, cadenceTurnIndex: number | undefined): boolean {
	const schedule = hook.schedule;
	// A wall-clock-only or kind-only declaration has no scheduler semantics. It
	// remains an ordinary decide hook; only every-N declarations opt into cadence.
	if (!schedule || schedule.everyNTurns === undefined) return true;
	if (schedule.kind !== "decision") return false;
	return event === "afterTurn" && Number.isSafeInteger(cadenceTurnIndex) && cadenceTurnIndex! > 0 && cadenceTurnIndex! % schedule.everyNTurns === 0;
}

/**
 * Scheduled staff proposals are a deliberately narrow consent surface: only the
 * exact `create` / `Create draft` option may seed, while every decline and Other
 * answer is explicitly effect-free. This is checked after general hook-output
 * validation but before a durable consent record is created.
 */
function admitScheduledProposalConsent(request: ValidatedExtensionDecisionRequest): ValidatedExtensionDecisionRequest | undefined {
	if (request.effect.kind !== "proposal") return undefined;
	const create = request.options.find(option => option.value === "create");
	if (!create || create.label !== "Create draft") return undefined;
	const noEffect = request.effect.noEffectValues;
	const expectedNoEffect = new Set([...request.options.filter(option => option.value !== "create").map(option => option.value), "other"]);
	if (!noEffect || noEffect.length !== expectedNoEffect.size || noEffect.some(value => !expectedNoEffect.delete(value))) return undefined;
	if (expectedNoEffect.size !== 0) return undefined;
	const proposalKeys = Object.keys(request.effect.proposals);
	if (proposalKeys.length !== 1 || proposalKeys[0] !== "create" || !request.effect.proposals.create) return undefined;
	const { default: _default, ...withoutDefault } = request;
	return { ...withoutDefault, requestedClass: "consent-required" };
}

function activePacks(registry: PackContributionRegistry, projectId: string): Array<{ packId: string; hooks: HookContribution[] }> {
	const list = (registry as unknown as { list?: (id: string) => Array<{ packId: string; hooks: HookContribution[] }> }).list;
	if (typeof list === "function") return list.call(registry, projectId);
	// Compatibility for existing isolated dispatcher fakes. Production registries
	// always expose `list`; this fallback cannot invent priority beyond list order.
	return registry.listHooks(projectId).map(hook => ({ packId: packIdFromRoot(hook.packRoot), hooks: [hook] }));
}
function resolvedHooks(registry: PackContributionRegistry, projectId: string): ResolvedHook[] {
	return activePacks(registry, projectId).flatMap((pack, priority) =>
		pack.hooks.map(hook => ({ packId: pack.packId, hookId: hook.id, mode: hook.mode, capabilities: hook.capabilities, priority })),
	);
}
function outcome(origin: Pick<AnyDecisionRequestOrigin, "packId" | "hookId" | "event">, state: TraceDecisionOutcomeRow["outcome"], reason?: TraceDecisionOutcomeRow["reason"], ms?: number, kind: "decision" | "advisory" = "decision"): TraceDecisionOutcomeRow {
	return { kind, packId: origin.packId, hookId: origin.hookId, event: origin.event, outcome: state, ...(reason ? { reason } : {}), ...(ms === undefined ? {} : { ms }) };
}
function emptyCapabilityStageResult(): CapabilityStageResult {
	return Object.freeze({ selected: Object.freeze([] as string[]), authoritative: false, outcomes: Object.freeze([] as TraceDecisionOutcomeRow[]) });
}
function capabilityContext(context: CapabilitySelectionContext): CapabilitySelectionContext {
	const query = canonicalizeCapabilityQuery(context.query);
	const available = snapshotCapabilityAvailability(context.available);
	const selectedSkills = snapshotCapabilityAvailability(context.selectedSkills ?? []);
	return Object.freeze({
		event: "sessionSetup",
		sessionId: context.sessionId,
		...(context.projectId ? { projectId: context.projectId } : {}),
		...(context.goalId ? { goalId: context.goalId } : {}),
		...(context.roleName ? { roleName: context.roleName } : {}),
		cwd: context.cwd,
		query,
		available,
		...(context.selectedSkills === undefined ? {} : { selectedSkills }),
	});
}
function hookSelectors(hook: HookContribution): readonly CapabilitySelectorStage[] {
	const selectors = (hook as HookContribution & { selectors?: unknown }).selectors;
	if (!Array.isArray(selectors)) return [];
	return selectors.filter((selector): selector is CapabilitySelectorStage => selector === "skills" || selector === "mcp");
}
function elapsed(started: number): number { return Math.max(0, Date.now() - started); }
function sameCapabilityCandidate(a: CapabilitySelectionCandidate, b: CapabilitySelectionCandidate): boolean {
	return a.source.packId === b.source.packId && a.source.hookId === b.source.hookId;
}
function capabilityOutcome(
	origin: Pick<DecisionRequestOrigin, "packId" | "hookId" | "event">,
	stage: CapabilitySelectorStage,
	state: TraceDecisionOutcomeRow["outcome"],
	reason: TraceDecisionOutcomeRow["reason"] | undefined,
	ms: number,
): TraceDecisionOutcomeRow {
	// `capabilityStage` is independently allow-listed by ContextTraceStore. No
	// proposal reason, candidate id, raw output, or query text is retained here.
	return { ...outcome(origin, state, reason, ms), capabilityStage: stage } as TraceDecisionOutcomeRow;
}
function emptyAvailability(): Readonly<AdvisorySelectionAvailability> {
	return Object.freeze({ models: Object.freeze([]), thinkingLevels: Object.freeze([]), roles: Object.freeze([]), workflows: Object.freeze([]) });
}
function sameCandidate(a: AdvisorySelectionCandidate, b: AdvisorySelectionCandidate): boolean {
	return a.source.packId === b.source.packId && a.source.hookId === b.source.hookId;
}
function selectionValue(selection: ValidatedAdvisorySelectionProposal): string {
	return selection.kind === "model" ? `${selection.provider}/${selection.modelId}`
		: selection.kind === "thinking" ? selection.thinkingLevel
			: selection.kind === "role" ? selection.roleName : selection.workflowId;
}
function selectionOutcome(
	origin: Pick<DecisionRequestOrigin, "packId" | "hookId" | "event">,
	selection: ValidatedAdvisorySelectionProposal,
	state: TraceDecisionOutcomeRow["outcome"],
	reason?: TraceDecisionOutcomeRow["reason"],
	ms?: number,
	value?: string,
): TraceDecisionOutcomeRow {
	return {
		...outcome(origin, state, reason, ms), selectionKind: selection.kind,
		...(value !== undefined ? { selectionValue: value } : {}),
	};
}
function isTimeout(error: unknown): boolean { return error instanceof ActionError ? error.status === 504 : error instanceof Error && error.message.includes("timed out"); }
