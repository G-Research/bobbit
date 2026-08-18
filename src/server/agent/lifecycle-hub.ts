import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { ActionError } from "../extension-host/action-error.js";
import type { PackContributionRegistry } from "../extension-host/pack-contribution-registry.js";
import { ModuleHost, type InvokeRequest } from "../extension-host/module-host-worker.js";
import { packIdFromRoot, type HookContribution } from "./pack-contributions.js";
import type { ServerHostApi } from "../extension-host/server-host-api.js";
import { applyBudgets, estimateTokens, type ContextBlock, type ContextBlockAuthority } from "./context-blocks.js";
import { ContextTraceStore, type TraceOutcomeRow, type TraceProviderRow } from "./context-trace-store.js";
import type { HookScopeContextResolver, HookScopeResolutionInput } from "./hook-scope-context.js";
import type { CapabilitySelectorStage } from "./dynamic-capability-contract.js";

export type LifecycleHook = "sessionSetup" | "beforePrompt" | "afterTurn" | "beforeCompact" | "sessionShutdown";

/** Direct, per-turn terminal telemetry; never a derived CostTracker value. */
export type TurnUsageSnapshot =
	| {
		telemetry: "known";
		inputTokens?: number;
		outputTokens?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		cost?: number;
		/** Present only when the active runtime provides a verified pair. */
		provider?: string;
		modelId?: string;
	}
	| { telemetry: "unknown" };

/** Lifecycle-provider scope vocabulary. Project is the default session scope. */
export type HookScopeKind = "project" | "global";
export const DEFAULT_HOOK_SCOPE: HookScopeKind = "project";

/** Arbitrary, hierarchically-resolved per-goal metadata (see goal-metadata.ts). */
export type GoalMetadata = Record<string, unknown>;

/**
 * Resolve the EFFECTIVE (ancestry-merged) metadata for a goal. Injected by the
 * server so the shared, cross-project hub routes by `goalId` to the owning
 * project context — `projectId` is diagnostics-only. Returns `{}` when no goal
 * or no owning context. The hub treats absent resolver as "no metadata", so
 * provider filtering is a no-op and behaviour is byte-identical to today.
 */
export type GoalMetadataResolver = (goalId: string | undefined, projectId?: string) => GoalMetadata;

/** Metadata key holding the list of provider ids disabled for a goal subtree. */
const DISABLED_PROVIDERS_KEY = "bobbit.disabledProviders";

/** Context handed to a `goalProvisioned` provider hook (fire-and-forget). */
export interface GoalProvisionedCtx {
	goalId: string;
	projectId?: string;
	worktreePath: string;
	cwd: string;
	branch?: string;
	metadata: GoalMetadata;
}

export interface HookScopeAncestryEntry {
	readonly id: string;
	readonly title?: string;
}

export interface HookScopeComponent {
	readonly name: string;
	readonly repo: string;
	readonly relativePath?: string;
}

export interface HookScopeGoal {
	readonly id: string;
	readonly title?: string;
	/** Root-to-leaf when complete; a safe leaf portion when ancestry is broken. */
	readonly ancestry?: readonly HookScopeAncestryEntry[];
	/** Present only for a complete contiguous root-to-leaf ancestry. */
	readonly depth?: number;
	/** Existing effective ancestry-merged metadata, cloned and deeply frozen. */
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HookScopeContext {
	readonly project?: { readonly id: string; readonly name?: string };
	readonly goal?: HookScopeGoal;
	readonly role?: string;
	readonly component?: HookScopeComponent;
}

export interface HookCtx {
	sessionId: string;
	projectId?: string;
	scope: HookScopeKind;
	cwd: string;
	goalId?: string;
	roleName?: string;
	prompt?: string;
	userText?: string;
	assistantText?: string;
	/** Present for gateway-dispatched afterTurn only. */
	usage?: TurnUsageSnapshot;
	/** The about-to-be-lost conversation span (beforeCompact): the concatenated
	 *  text of the messages compaction is about to summarize away. Providers retain
	 *  it before the context is dropped. */
	span?: string;
	/** A pre-computed summary of the compacted span, when the runtime supplies one
	 *  (beforeCompact). Providers prefer it over `span` when present. */
	summary?: string;
	turn?: { index: number };
	budget: { maxTokens: number };
	config: Record<string, unknown>;
	runtime?: { baseUrl: string; headers: Record<string, string>; status: string };
	gateway: { baseUrl: string; token: string };
	/** Optional project-safe, advisory snapshot for ordinary lifecycle hooks. */
	readonly scopeContext?: HookScopeContext;
}

/** Existing dispatch fields, without per-provider values or event-local scope. */
export type HookDispatchBase = Omit<HookCtx, "budget" | "config" | "gateway" | "scopeContext"> & {
	/** Core-only persisted every-N cadence; never exposed to provider hook contexts. */
	cadenceTurnIndex?: number;
};

export interface HubDiagnostic {
	providerId: string;
	hook: LifecycleHook;
	error?: string;
	timeout?: boolean;
	ms: number;
}

/** Live, exact-grant authorization supplied by the server. It intentionally
 * re-reads declarations and grants on each fence; no scheduled grant is cached. */
export type ScheduledAdvisorAuthorizer = (ref: {
	projectId?: string;
	packId: string;
	hookId: string;
}) => boolean;

export interface ScheduledAdvisorCancellationFilter {
	sessionId?: string;
	packId?: string;
	hookId?: string;
}

interface ScheduledAdvisorInvocation {
	controller: AbortController;
	generation: symbol;
}

/** Bounded decision branch injected after ordinary provider dispatch is complete. */
export interface CapabilitySelectionContext {
	readonly event: "sessionSetup";
	readonly sessionId: string;
	readonly projectId?: string;
	readonly goalId?: string;
	readonly roleName?: string;
	readonly cwd: string;
	/** Bounded query text only; no plan, policy, config, path, or credential. */
	readonly query: string;
	/** Core-derived active/permitted candidate ids, never hook-proposed ids. */
	readonly available: readonly string[];
	/** Fixed skills-stage result, present only for the MCP stage. */
	readonly selectedSkills?: readonly string[];
}

export interface CapabilityStageResult {
	readonly selected: readonly string[];
	/** True only when a valid, still-authorized selector proposal won this stage. */
	readonly authoritative: boolean;
	readonly outcomes: readonly TraceOutcomeRow[];
}

export interface DecisionLifecycleDispatcher {
	dispatch(event: LifecycleHook, context: {
		projectId: string;
		sessionId: string;
		goalId?: string;
		roleName?: string;
		cwd: string;
		/** Direct gateway terminal usage snapshot; forwarded without derivation. */
		usage?: TurnUsageSnapshot;
		/** Ordinary completed-turn index, present only for afterTurn. */
		turnIndex?: number;
		/** Persisted every-N advisor cadence, distinct from ordinary turn telemetry. */
		cadenceTurnIndex?: number;
	}): Promise<TraceOutcomeRow[]>;
	selectCapabilities(stage: CapabilitySelectorStage, context: CapabilitySelectionContext): Promise<CapabilityStageResult>;
	dispatchSetup?(context: {
		projectId: string;
		sessionId: string;
		goalId?: string;
		roleName?: string;
		cwd: string;
	}): Promise<{ outcomes: TraceOutcomeRow[]; thinkingLevel?: string }>;
}

interface ProviderTraceState {
	id: string;
	ms: number;
	error?: string;
	malformed: number;
}

const AUTHORITIES: ReadonlySet<ContextBlockAuthority> = new Set(["memory", "skill", "tool", "workflow", "role", "generic"]);

/** Shared empty set returned by the disabled-providers fast paths (no allocation). */
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

export class LifecycleHub {
	private readonly registry: PackContributionRegistry;
	private readonly moduleHost: ModuleHost;
	private readonly trace: ContextTraceStore;
	private readonly gatewayInfo: () => { baseUrl: string; token: string };
	private readonly globalMaxTokens: number;
	private readonly providerHostApi?: (opts: { sessionId: string; packId: string }) => ServerHostApi;
	private readonly goalMetadataResolver?: GoalMetadataResolver;
	private readonly scopeContextResolver?: HookScopeContextResolver;
	private readonly scheduledAdvisorAuthorizer?: ScheduledAdvisorAuthorizer;
	/** Exactly one active worker per session + pack + hook; overlaps are dropped. */
	private readonly scheduledAdvisors = new Map<string, ScheduledAdvisorInvocation>();
	private decisionDispatcher?: DecisionLifecycleDispatcher;

	constructor(deps: {
		registry: PackContributionRegistry;
		moduleHost: ModuleHost;
		trace: ContextTraceStore;
		gatewayInfo: () => { baseUrl: string; token: string };
		globalMaxTokens?: number;
		/** Resolve effective (ancestry-merged) per-goal metadata, routed by goalId.
		 *  Omitted ⇒ no provider is ever filtered by goal metadata (today's
		 *  behaviour). See {@link GoalMetadataResolver}. */
		goalMetadataResolver?: GoalMetadataResolver;
		/** Best-effort project-safe scope resolver for ordinary lifecycle events. */
		scopeContextResolver?: HookScopeContextResolver;
		/** Factory for a LEAST-PRIVILEGE, provider-scoped server Host API (store-only:
		 *  `capabilities.store === true`, `session`/`agents` false/unavailable). Built
		 *  per provider invocation so a hook reaches its own pack's durable store
		 *  (retain queue / diagnostics) via the SAME pack-scoped, parent-authorized
		 *  path routes use. Omitted ⇒ provider hooks run without `ctx.host`. */
		providerHostApi?: (opts: { sessionId: string; packId: string }) => ServerHostApi;
		/** Exact active-declaration + decide-grant check, read at launch and completion. */
		scheduledAdvisorAuthorizer?: ScheduledAdvisorAuthorizer;
	}) {
		this.registry = deps.registry;
		this.moduleHost = deps.moduleHost;
		this.trace = deps.trace;
		this.gatewayInfo = deps.gatewayInfo;
		this.globalMaxTokens = deps.globalMaxTokens ?? 4_000;
		this.providerHostApi = deps.providerHostApi;
		this.goalMetadataResolver = deps.goalMetadataResolver;
		this.scopeContextResolver = deps.scopeContextResolver;
		this.scheduledAdvisorAuthorizer = deps.scheduledAdvisorAuthorizer;
	}

	/** Late binding keeps gateway construction order acyclic. */
	setDecisionDispatcher(dispatcher: DecisionLifecycleDispatcher | undefined): void {
		this.decisionDispatcher = dispatcher;
	}

	/**
	 * Session setup calls this twice in sequence: skills first, then MCP with the
	 * fixed skills result. This hub is only a transient forwarding boundary;
	 * execution, grants, and reduction remain owned by the decision dispatcher.
	 */
	async selectCapabilities(stage: CapabilitySelectorStage, context: CapabilitySelectionContext): Promise<CapabilityStageResult> {
		const dispatcher = context.projectId ? this.decisionDispatcher : undefined;
		if (!dispatcher) return emptyCapabilityStageResult();
		try {
			const result = await dispatcher.selectCapabilities(stage, context);
			if (!result || !Array.isArray(result.selected) || !Array.isArray(result.outcomes) || typeof result.authoritative !== "boolean") return emptyCapabilityStageResult();
			return Object.freeze({ selected: Object.freeze([...result.selected]), authoritative: result.authoritative, outcomes: Object.freeze([...result.outcomes]) });
		} catch {
			// A selector-runtime failure is deliberately isolated from session setup;
			// the next stage still runs with its caller-provided pinned input.
			return emptyCapabilityStageResult();
		}
	}

	/**
	 * The set of provider ids disabled for the goal subtree via the
	 * `bobbit.disabledProviders` metadata convention. Empty when no resolver is
	 * injected or the goal sets no such key — so filtering is a no-op and
	 * behaviour is byte-identical to today.
	 */
	private disabledProviders(goalId: string | undefined, projectId: string | undefined): ReadonlySet<string> {
		if (!this.goalMetadataResolver) return EMPTY_SET;
		let meta: GoalMetadata;
		try {
			meta = this.goalMetadataResolver(goalId, projectId) ?? {};
		} catch (err) {
			console.warn(`[lifecycle-hub] goalMetadataResolver threw for goal ${goalId ?? "<none>"}: ${String(err)}`);
			return EMPTY_SET;
		}
		const raw = meta[DISABLED_PROVIDERS_KEY];
		if (!Array.isArray(raw)) return EMPTY_SET;
		const ids = raw.filter((v): v is string => typeof v === "string" && v.length > 0);
		return ids.length > 0 ? new Set(ids) : EMPTY_SET;
	}

	/**
	 * True when at least one active (activation-filtered) provider for the
	 * project declares one of the given hooks. Used by session setup to decide
	 * whether the per-turn provider-bridge extension is warranted; keeps provider
	 * activation filtering centralized in the registry.
	 *
	 * `goalId` (effective goal for the session) lets metadata-disabled providers
	 * be excluded — a goal subtree that disables Hindsight gets NO bridge.
	 */
	hasProvidersForHooks(projectId: string | undefined, hooks: readonly LifecycleHook[], goalId?: string): boolean {
		const wanted = new Set<string>(hooks);
		const disabled = this.disabledProviders(goalId, projectId);
		return this.registry.listProviders(projectId).some((p) => !disabled.has(p.id) && p.hooks.some((h) => wanted.has(h)));
	}

	/**
	 * Fire the `goalProvisioned` lifecycle hook for every enabled provider that
	 * declares it. Dispatched at EVERY worktree provisioning in a goal's subtree
	 * (team lead, members, sub-agents, nested sub-goals, pool claims) so
	 * filesystem treatments land uniformly. Non-fatal: a provider error/timeout
	 * is logged and swallowed, return value ignored. Providers must be cheap and
	 * idempotent (content-addressed marker/cache).
	 */
	async dispatchGoalProvisioned(ctx: GoalProvisionedCtx): Promise<void> {
		const disabled = this.disabledProviders(ctx.goalId, ctx.projectId);
		const providers = this.registry.listProviders(ctx.projectId).filter(
			(p) => !disabled.has(p.id) && p.hooks.includes("goalProvisioned"),
		);
		for (const provider of providers) {
			const providerHost = this.providerHostApi?.({ sessionId: `goal:${ctx.goalId}`, packId: packIdFromRoot(provider.packRoot) });
			const url = pathToFileURL(path.resolve(path.dirname(provider.sourceFile), provider.module)).href;
			try {
				await this.moduleHost.invoke({
					url,
					packRoot: provider.packRoot,
					epoch: 0,
					exportKind: "providers",
					member: "goalProvisioned",
					ctx: {
						goalId: ctx.goalId,
						projectId: ctx.projectId,
						worktreePath: ctx.worktreePath,
						cwd: ctx.cwd,
						workingDir: ctx.cwd,
						branch: ctx.branch,
						metadata: ctx.metadata,
						config: provider.config ?? {},
						gateway: this.gatewayInfo(),
						host: providerHost,
					} as unknown as InvokeRequest["ctx"],
					arg: undefined,
					workingDir: ctx.cwd,
				}, provider.budget.timeoutMs);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.warn(`[lifecycle-hub] goalProvisioned hook for provider ${provider.id} failed (non-fatal): ${message}`);
			}
		}
	}

	/**
	 * Launch due every-N-turn advisors. This method is deliberately asynchronous;
	 * SessionManager starts it fire-and-forget after ordinary afterTurn dispatch.
	 */
	async dispatchScheduledAdvisors(
		base: HookDispatchBase,
		scopeInput?: Readonly<HookScopeResolutionInput>,
	): Promise<void> {
		const due = this.registry.listScheduledAdvisorHooks(base.projectId).filter((hook) => {
			const everyNTurns = hook.schedule?.everyNTurns;
			return !!everyNTurns && !!base.turn && base.turn.index % everyNTurns === 0;
		});
		// Start every independently-keyed advisor now. The returned aggregate is
		// observed only by SessionManager's logging catch, never awaited by it.
		await Promise.all(due.map((hook) => this.launchScheduledAdvisor(hook, base, scopeInput)));
	}

	/** Abort matching live advisors. No missed work is queued or retried. */
	cancelScheduledAdvisors(filter: ScheduledAdvisorCancellationFilter = {}): void {
		for (const [key, invocation] of this.scheduledAdvisors) {
			const [sessionId, packId, hookId] = key.split("\u0000");
			if ((filter.sessionId && filter.sessionId !== sessionId)
				|| (filter.packId && filter.packId !== packId)
				|| (filter.hookId && filter.hookId !== hookId)) continue;
			invocation.controller.abort();
		}
	}

	private async launchScheduledAdvisor(
		hook: HookContribution,
		base: HookDispatchBase,
		scopeInput?: Readonly<HookScopeResolutionInput>,
	): Promise<void> {
		const packId = packIdFromRoot(hook.packRoot);
		const ref = { projectId: base.projectId, packId, hookId: hook.id };
		// The server owns exact active-declaration + decide-grant checks. Omit the
		// advisor entirely when unavailable so ineligible code is never imported.
		if (!this.scheduledAdvisorAuthorizer?.(ref)) return;

		const key = [base.sessionId, packId, hook.id].join("\u0000");
		if (this.scheduledAdvisors.has(key)) {
			this.appendAdvisorTrace(base.sessionId, packId, hook.id, "dropped", "Overlapping invocation", 0);
			return;
		}

		const controller = new AbortController();
		const generation = Symbol(key);
		this.scheduledAdvisors.set(key, { controller, generation });
		const t0 = performance.now();
		try {
			let scopeContext: HookScopeContext | undefined;
			if (this.scopeContextResolver) {
				try { scopeContext = this.scopeContextResolver(scopeInput ?? base); }
				catch { console.warn("[lifecycle-hub] scopeContextResolver threw; continuing without scope context"); }
			}
			// Advisors intentionally receive no gateway credential or Host API. Their
			// returned value is only a trace identifier, never prose or an action.
			const ctx = Object.freeze({
				sessionId: base.sessionId,
				projectId: base.projectId,
				goalId: base.goalId,
				roleName: base.roleName,
				cwd: base.cwd,
				turn: Object.freeze({ index: base.turn!.index }),
				config: Object.freeze({ ...(hook.config ?? {}) }),
				budget: Object.freeze({ maxTokens: hook.budget.maxTokens }),
				...(scopeContext ? { scopeContext } : {}),
				workingDir: base.cwd,
			});
			const url = pathToFileURL(path.resolve(path.dirname(hook.sourceFile), hook.module)).href;
			const result = await this.moduleHost.invoke({
				url,
				packRoot: hook.packRoot,
				epoch: 0,
				exportKind: "advisors",
				member: hook.id,
				ctx: ctx as unknown as InvokeRequest["ctx"],
				arg: undefined,
				workingDir: base.cwd,
			}, hook.budget.timeoutMs, controller.signal);
			const ms = elapsedMs(t0);
			if (controller.signal.aborted) {
				this.appendAdvisorTrace(base.sessionId, packId, hook.id, "dropped", "Cancelled", ms);
			} else if (!this.scheduledAdvisorAuthorizer?.(ref)) {
				this.appendAdvisorTrace(base.sessionId, packId, hook.id, "dropped", "Disabled or revoked", ms);
			} else {
				const advisory = validateAdvisoryResult(result);
				if (!advisory.valid) this.appendAdvisorTrace(base.sessionId, packId, hook.id, "dropped", "Malformed result", ms);
				else this.appendAdvisorTrace(base.sessionId, packId, hook.id, "advised", undefined, ms, advisory.value);
			}
		} catch (err) {
			const ms = elapsedMs(t0);
			const message = err instanceof Error ? err.message : String(err);
			if (controller.signal.aborted) this.appendAdvisorTrace(base.sessionId, packId, hook.id, "dropped", "Cancelled", ms);
			else if ((err instanceof ActionError && err.status === 504) || message.includes("timed out")) this.appendAdvisorTrace(base.sessionId, packId, hook.id, "dropped", "Timed out", ms);
			else this.appendAdvisorTrace(base.sessionId, packId, hook.id, "error", undefined, ms);
		} finally {
			// A late completion from an older invocation must never release a newer key.
			if (this.scheduledAdvisors.get(key)?.generation === generation) this.scheduledAdvisors.delete(key);
		}
	}

	private appendAdvisorTrace(
		sessionId: string, packId: string, hookId: string,
		outcome: "advised" | "dropped" | "error", reason: "Malformed result" | "Timed out" | "Overlapping invocation" | "Cancelled" | "Disabled or revoked" | undefined,
		ms: number, value?: string,
	): void {
		this.trace.appendTrace(sessionId, {
			ts: Date.now(), hook: "afterTurn", sessionId, providers: [],
			outcomes: [{ kind: "advisory", packId, hookId, event: "afterTurn", outcome, ...(reason ? { reason } : {}), ...(value ? { value } : {}), ms }],
		});
	}

	async dispatch(
		hook: LifecycleHook,
		base: HookDispatchBase,
		scopeInput?: Readonly<HookScopeResolutionInput>,
	): Promise<{ blocks: ContextBlock[]; diagnostics: HubDiagnostic[]; thinkingLevel?: string }> {
		let scopeContext: HookScopeContext | undefined;
		if (this.scopeContextResolver) {
			try {
				scopeContext = this.scopeContextResolver(scopeInput ?? base);
			} catch {
				console.warn("[lifecycle-hub] scopeContextResolver threw; continuing without scope context");
			}
		}
		const disabled = this.disabledProviders(base.goalId, base.projectId);
		const providers = this.registry.listProviders(base.projectId).filter((p) => !disabled.has(p.id) && p.hooks.includes(hook));
		const diagnostics: HubDiagnostic[] = [];
		const collected: ContextBlock[] = [];
		const traceStates = new Map<string, ProviderTraceState>();

		const { cadenceTurnIndex: _cadenceTurnIndex, ...providerBase } = base;
		for (const provider of providers) {
			const hookCtx: HookCtx = {
				...providerBase,
				...(scopeContext ? { scopeContext } : {}),
				config: provider.config ?? {},
				budget: { maxTokens: provider.budget.maxTokens },
				gateway: this.gatewayInfo(),
			};
			// Provider-scoped, store-only host (least privilege). The LIVE object stays
			// in the parent (module-host-worker strips it before serialization) and
			// services the worker's proxied store calls — the durable retain queue /
			// diagnostics path. packId is derived from the contribution's pack root.
			const providerHost = this.providerHostApi?.({ sessionId: base.sessionId, packId: packIdFromRoot(provider.packRoot) });
			const url = pathToFileURL(path.resolve(path.dirname(provider.sourceFile), provider.module)).href;
			const t0 = performance.now();
			let ms = 0;
			try {
				const result = await this.moduleHost.invoke({
					url,
					packRoot: provider.packRoot,
					epoch: 0,
					exportKind: "providers",
					member: hook,
					ctx: { ...hookCtx, workingDir: base.cwd, host: providerHost } as unknown as InvokeRequest["ctx"],
					arg: undefined,
					workingDir: base.cwd,
				}, provider.budget.timeoutMs);
				ms = Math.round(performance.now() - t0);

				const candidates = extractBlocks(result);
				let malformed = 0;
				for (const candidate of candidates) {
					const block = validateBlock(candidate, provider.id);
					if (!block) {
						malformed++;
						continue;
					}
					collected.push(block);
				}
				if (malformed > 0) {
					diagnostics.push({ providerId: provider.id, hook, error: "malformed block(s) dropped", ms });
				}
				traceStates.set(provider.id, { id: provider.id, ms, malformed, error: malformed > 0 ? "malformed block(s) dropped" : undefined });
			} catch (err) {
				ms = Math.round(performance.now() - t0);
				const message = err instanceof Error ? err.message : String(err);
				if ((err instanceof ActionError && err.status === 504) || message.includes("timed out")) {
					diagnostics.push({ providerId: provider.id, hook, timeout: true, ms });
					traceStates.set(provider.id, { id: provider.id, ms, malformed: 0, error: "timeout" });
				} else {
					diagnostics.push({ providerId: provider.id, hook, error: message, ms });
					traceStates.set(provider.id, { id: provider.id, ms, malformed: 0, error: message });
				}
			}
		}

		const perProviderMax = new Map(providers.map((p) => [p.id, p.budget.maxTokens]));
		const budgeted = applyBudgets(collected, perProviderMax, this.globalMaxTokens);
		const traceRows = providers.map((provider): TraceProviderRow => {
			const state = traceStates.get(provider.id) ?? { id: provider.id, ms: 0, malformed: 0 };
			return {
				id: provider.id,
				ms: state.ms,
				blocks: budgeted.kept.filter((block) => block.providerId === provider.id).length,
				omitted: budgeted.omitted.filter(({ block }) => block.providerId === provider.id).length + state.malformed,
				...(state.error ? { error: state.error } : {}),
			};
		});
		this.trace.appendTrace(base.sessionId, { ts: Date.now(), hook, sessionId: base.sessionId, providers: traceRows });

		// Setup selection must complete before bridge construction. All other decision
		// events remain detached; never dispatch sessionSetup twice.
		const dispatcher = base.projectId ? this.decisionDispatcher : undefined;
		let thinkingLevel: string | undefined;
		if (dispatcher?.dispatchSetup && hook === "sessionSetup") {
			try {
				const result = await dispatcher.dispatchSetup({
					projectId: base.projectId!, sessionId: base.sessionId,
					...(base.goalId ? { goalId: base.goalId } : {}),
					...(base.roleName ? { roleName: base.roleName } : {}),
					cwd: base.cwd,
				});
				thinkingLevel = result.thinkingLevel;
				if (result.outcomes.length > 0) {
					this.trace.appendTrace(base.sessionId, { ts: Date.now(), hook, sessionId: base.sessionId, providers: [], outcomes: result.outcomes });
				}
			} catch {
				// Decision hooks are isolated: setup continues with no extension choice.
			}
		} else if (dispatcher) {
			void Promise.resolve()
				.then(() => dispatcher.dispatch(hook, {
					projectId: base.projectId!, sessionId: base.sessionId,
					...(base.goalId ? { goalId: base.goalId } : {}),
					...(base.roleName ? { roleName: base.roleName } : {}),
					...(base.usage ? { usage: base.usage } : {}),
					...(hook === "afterTurn" && base.turn ? { turnIndex: base.turn.index } : {}),
					...(hook === "afterTurn" && base.cadenceTurnIndex !== undefined ? { cadenceTurnIndex: base.cadenceTurnIndex } : {}),
					cwd: base.cwd,
				}))
				.then((outcomes) => {
					if (!Array.isArray(outcomes) || outcomes.length === 0) return;
					try { this.trace.appendTrace(base.sessionId, { ts: Date.now(), hook, sessionId: base.sessionId, providers: [], outcomes }); } catch { /* isolated */ }
				})
				.catch(() => { /* decision dispatch never blocks an agent turn */ });
		}

		return { blocks: budgeted.kept, diagnostics, ...(thinkingLevel ? { thinkingLevel } : {}) };
	}
}

function emptyCapabilityStageResult(): CapabilityStageResult {
	return Object.freeze({ selected: Object.freeze([] as string[]), authoritative: false, outcomes: Object.freeze([] as TraceOutcomeRow[]) });
}

function elapsedMs(start: number): number {
	return Math.max(0, Math.round(performance.now() - start));
}

function validateAdvisoryResult(result: unknown): { valid: true; value?: string } | { valid: false } {
	if (result === undefined) return { valid: true };
	if (!isPlainObject(result) || Object.keys(result).some((key) => key !== "advisory")) return { valid: false };
	if (result.advisory === undefined) return { valid: true };
	if (!isPlainObject(result.advisory) || Object.keys(result.advisory).some((key) => key !== "value")) return { valid: false };
	const value = result.advisory.value;
	if (value !== undefined && (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))) return { valid: false };
	return { valid: true, ...(typeof value === "string" ? { value } : {}) };
}

function extractBlocks(result: unknown): unknown[] {
	if (Array.isArray(result)) return result;
	if (isPlainObject(result) && Array.isArray(result.blocks)) return result.blocks;
	return [];
}

function validateBlock(candidate: unknown, providerId: string): ContextBlock | undefined {
	if (!isPlainObject(candidate)) return undefined;
	if (typeof candidate.id !== "string") return undefined;
	if (typeof candidate.title !== "string") return undefined;
	if (typeof candidate.content !== "string") return undefined;
	if (typeof candidate.reason !== "string") return undefined;
	if (typeof candidate.authority !== "string" || !AUTHORITIES.has(candidate.authority as ContextBlockAuthority)) return undefined;
	if (typeof candidate.priority !== "number" || !Number.isFinite(candidate.priority)) return undefined;
	return {
		id: candidate.id,
		title: candidate.title,
		providerId,
		authority: candidate.authority as ContextBlockAuthority,
		content: candidate.content,
		reason: candidate.reason,
		priority: candidate.priority,
		tokenEstimate: estimateTokens(candidate.content),
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object") return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}
