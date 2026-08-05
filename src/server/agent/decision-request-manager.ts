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
	type DecisionActor,
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
const DAY_MS = 24 * 60 * 60 * 1_000;

export type DecisionCreateStatus = "created" | "deduplicated" | "rejected" | "store_unavailable";
export interface DecisionCreateResult {
	status: DecisionCreateStatus;
	requestId?: string;
	request?: StoredDecisionRequest;
	code?: "DECISION_BUDGET_EXHAUSTED" | "DECISION_STORE_UNAVAILABLE" | "DECISION_SCOPE_UNAVAILABLE";
}
export type DecisionAnswerStatus = "resolved" | "already_resolved" | "invalid" | "not_found";
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
}

export interface DecisionRequestManagerDeps {
	/** Project-owned store lookup. Undefined means decisions are disabled for that project. */
	storeForProject: (projectId: string) => DecisionRequestStore | undefined;
	clock?: Clock;
	isHeadless?: () => boolean;
	inboxManager?: Pick<InboxManager, "enqueue" | "hasStaff">;
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
				if (request.status === "pending" && (this.isHeadless() || Date.parse(request.deadlineAt) <= this.clock.now())) {
					await this.resolveDefault(request, this.isHeadless() ? "headless" : "deadline");
					continue;
				}
				// A failed callback never changes the durable answer. Reconciliation is
				// its bounded replay point, including after a process restart.
				if (request.status !== "pending" && request.continuationState === "pending") await this.deliverContinuation(request);
			}
		}
		this.armDeadlineTimer();
	}

	/** Add a validated request, enforcing semantic dedupe and server-owned limits. */
	async create(origin: DecisionRequestOrigin, request: ValidatedExtensionDecisionRequest): Promise<DecisionCreateResult> {
		this.projects.add(origin.projectId);
		const store = this.deps.storeForProject(origin.projectId);
		if (!store?.isHealthy()) return { status: "store_unavailable", code: "DECISION_STORE_UNAVAILABLE" };
		const scopeId = scopeIdFor(request.scope, origin);
		if (!scopeId) return { status: "rejected", code: "DECISION_SCOPE_UNAVAILABLE" };
		// Rendered prose and labels are intentionally not semantic identity: a pack
		// may improve wording without re-asking the same keyed decision. Option ids,
		// Other constraints, scope target, default, and effect remain exact.
		const dedupeId = fingerprint({
			version: 1, projectId: origin.projectId, target: { scope: request.scope, scopeId },
			asker: { packId: origin.packId, hookId: origin.hookId }, key: request.key,
			options: request.options.map(option => option.value), other: request.other,
			default: request.default, effect: request.effect,
		});
		const existing = store.findByDedupeId(dedupeId);
		if (existing) return { status: "deduplicated", requestId: existing.id, request: existing };
		if (!withinBudgets(store, origin, this.clock.now())) {
			return { status: "rejected", code: "DECISION_BUDGET_EXHAUSTED" };
		}
		const now = new Date(this.clock.now()).toISOString();
		const record: StoredDecisionRequest = {
			id: randomUUID(), projectId: origin.projectId, sessionId: origin.sessionId,
			...(origin.goalId ? { goalId: origin.goalId } : {}),
			asker: { packId: origin.packId, hookId: origin.hookId, event: origin.event },
			dedupeId, questionId: fingerprint({ key: request.key, question: request.question, options: request.options, other: request.other }),
			request, status: "pending", createdAt: now, deadlineAt: request.deadlineAt,
			continuationState: "pending", continuationAttempts: 0,
		};
		if (!store.put(record)) return { status: "store_unavailable", code: "DECISION_STORE_UNAVAILABLE" };
		if (this.isHeadless()) {
			const terminal = await this.resolveDefault(record, "headless");
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
		if (current.status !== "pending") return { status: "already_resolved", request: current };
		if (Date.parse(current.deadlineAt) <= this.clock.now()) {
			const resolved = await this.resolveDefault(current, "deadline");
			return { status: "already_resolved", request: resolved ?? store.get(requestId) };
		}
		let value: Readonly<DecisionValue>;
		try {
			value = validateDecisionValue(rawValue, current.request.options, current.request.other);
		} catch {
			return { status: "invalid", request: store.get(requestId) };
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

	/** Advisories use the existing durable inbox and explicitly never nudge staff. */
	advisory(origin: Pick<DecisionRequestOrigin, "packId" | "hookId">, advisory: ExtensionAdvisory): boolean {
		const inbox = this.deps.inboxManager;
		if (!inbox || !inbox.hasStaff(advisory.staffId)) return false;
		try {
			inbox.enqueue(advisory.staffId, {
				title: advisory.title, prompt: advisory.body,
				source: { type: "extension_advisory", packId: origin.packId, hookId: origin.hookId },
			}, { wake: false });
			return true;
		} catch { return false; }
	}

	private async resolveDefault(record: StoredDecisionRequest, actor: "deadline" | "headless"): Promise<StoredDecisionRequest | undefined> {
		return (await this.resolve(record, record.request.default, actor, actor === "deadline" ? "deadline_elapsed" : "headless_default")).request;
	}

	private async resolve(record: StoredDecisionRequest, value: Readonly<DecisionValue>, actor: DecisionActor, reason: DecisionReason): Promise<{ written: boolean; request?: StoredDecisionRequest }> {
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
			status: actor === "deadline" ? "expired" : "resolved", resolvedAt,
			resolution: { value: cloneValue(value), actor, reason },
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
		if (record.continuationAttempts >= DECISION_CONTINUATION_MAX_ATTEMPTS) {
			store.updateContinuation(record.id, { continuationState: "skipped", continuationAttempts: record.continuationAttempts });
			return;
		}
		const attempts = record.continuationAttempts + 1;
		try {
			const outcome = await continuation.deliver(record);
			store.updateContinuation(record.id, { continuationState: outcome, continuationAttempts: attempts });
		} catch {
			// Keep a bounded retry marker. A continuation cannot roll back the answer.
			store.updateContinuation(record.id, { continuationState: attempts >= DECISION_CONTINUATION_MAX_ATTEMPTS ? "skipped" : "pending", continuationAttempts: attempts });
		}
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
		this.timer = this.clock.setTimeout(() => { void this.reconcile(); }, Math.max(0, Date.parse(earliest.deadlineAt) - this.clock.now()));
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

	private async apply(origin: DecisionRequestOrigin, parsed: ValidatedDecisionHookOutput, ms: number): Promise<TraceDecisionOutcomeRow> {
		if (parsed.kind === "advisory") {
			return outcome(origin, this.deps.manager.advisory(origin, parsed.advisory) ? "advised" : "dropped", undefined, ms, "advisory");
		}
		const created = await this.deps.manager.create(origin, parsed.request);
		if (created.requestId) this.contexts.set(created.requestId, origin);
		if (created.status === "rejected") return outcome(origin, "dropped", "Budget exhausted", ms);
		if (created.status === "store_unavailable") return outcome(origin, "dropped", "Unavailable value", ms);
		return { ...outcome(origin, created.status === "deduplicated" ? "superseded" : "applied", created.status === "deduplicated" ? "Duplicate" : undefined, ms), requestId: created.requestId, questionId: created.request?.questionId };
	}

	private invoke(hook: HookContribution, member: "decide" | "onDecision", ctx: DecisionHookContext | import("./decision-hook-contract.js").DecisionResolutionContext): Promise<unknown> {
		const url = pathToFileURL(path.resolve(path.dirname(hook.sourceFile), hook.module)).href;
		return this.deps.moduleHost.invoke({ url, packRoot: hook.packRoot, epoch: 0, exportKind: "hooks", member, ctx, arg: undefined, workingDir: ctx.cwd } as InvokeRequest<DecisionHookContext>, hook.budget.timeoutMs);
	}
}

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
