import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { ActionError } from "../extension-host/action-dispatcher.js";
import type { PackContributionRegistry } from "../extension-host/pack-contribution-registry.js";
import { ModuleHost, type InvokeRequest } from "../extension-host/module-host-worker.js";
import { packIdFromRoot, type ProviderContribution } from "./pack-contributions.js";
import type { ServerHostApi } from "../extension-host/server-host-api.js";
import { applyBudgets, estimateTokens, type ContextBlock, type ContextBlockAuthority } from "./context-blocks.js";
import { ContextTraceStore, type TraceProviderRow } from "./context-trace-store.js";
// `LifecycleHook` is defined in lifecycle-hooks.js (single source of truth,
// finding EXT-02) and re-exported here so existing `from "./lifecycle-hub.js"`
// imports keep working unchanged.
import type { LifecycleHook } from "./lifecycle-hooks.js";
export type { LifecycleHook } from "./lifecycle-hooks.js";
// `Decision`/`DecisionPoint` are defined in decision-types.js (Wave 0(b) of the
// Classifier Framework lane, EXT-05 core — see that file's header) and
// re-exported here so callers only need `from "./lifecycle-hub.js"`.
import {
	decisionKey,
	isDecision,
	type Decision,
	type DecisionClassifier,
	type DecisionDispatchCtx,
	type DecisionOutcome,
	type DecisionPoint,
} from "./decision-types.js";
export type { Decision, DecisionClassifier, DecisionDispatchCtx, DecisionOutcome, DecisionPoint } from "./decision-types.js";

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

/** Compact server-owned summary handed to goal-completion lifecycle providers. */
export interface GoalCompletedCtx {
	goalId: string;
	projectId?: string;
	cwd: string;
	branch?: string;
	mergeTarget?: string;
	parentGoalId?: string;
	rootGoalId?: string;
	headSha?: string;
	teamLeadSessionId?: string;
	completedAt: string;
	pullRequest?: {
		url?: string;
		number?: string | number;
		title?: string;
		state?: string;
		headSha?: string;
	};
	gates: Array<{
		gateId: string;
		name?: string;
		status: string;
		signalCount: number;
		updatedAt?: number;
		metadata?: Record<string, string>;
		content?: string;
		latestCommitSha?: string;
	}>;
	tasks: Array<{
		id: string;
		title: string;
		type?: string;
		state?: string;
		branch?: string;
		headSha?: string;
		resultSummary?: string;
	}>;
	touchedFiles: string[];
	metadata: GoalMetadata;
}

export interface HookCtx {
	sessionId: string;
	projectId?: string;
	scope: "project" | "global";
	cwd: string;
	goalId?: string;
	roleName?: string;
	prompt?: string;
	userText?: string;
	assistantText?: string;
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
}

/** Managed-runtime context injected into `ctx.runtime` for an ACTIVE managed
 *  provider invocation. Resolved by the host WITHOUT starting Docker. */
export interface RuntimeContext {
	baseUrl: string;
	headers: Record<string, string>;
	status: string;
}

/** Resolves the managed-runtime context for a provider declaring `runtime`. Returns
 *  `undefined` when there is no managed runtime to link (external mode, supervisor
 *  unavailable, runtime not running / API port unknown). NEVER starts Docker. */
export type RuntimeContextResolver = (opts: {
	packId: string;
	runtimeId: string;
	projectId?: string;
	config: Record<string, unknown>;
}) => Promise<RuntimeContext | undefined> | RuntimeContext | undefined;

export interface HubDiagnostic {
	providerId: string;
	hook: LifecycleHook;
	error?: string;
	timeout?: boolean;
	ms: number;
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

/**
 * EXT-06 transparency marker: a provider that DID return candidate blocks but
 * ends up with ZERO kept blocks purely because the shared budget (post
 * fair-share, see `applyBudgets`) had no room left for it — as opposed to a
 * thrown error, a timeout, or every candidate being malformed — used to be
 * silent (FINDINGS.md EXT-06: "the user sees no error and cannot tell that an
 * installed extension's context was dropped"). Surfaced in both the returned
 * `diagnostics` and the persisted `TraceProviderRow.error` for that provider.
 */
const STARVATION_MARKER = "context omitted: shared budget exhausted";

/** Per-provider outcome of a single (concurrent) provider hook invocation —
 *  everything `dispatch()` needs to rebuild `collected`/`diagnostics`/
 *  `traceStates` in REGISTRATION order once all providers have settled. */
interface ProviderRunResult {
	blocks: ContextBlock[];
	diagnostic?: HubDiagnostic;
	trace: ProviderTraceState;
}

export class LifecycleHub {
	private readonly registry: PackContributionRegistry;
	private readonly moduleHost: ModuleHost;
	private readonly trace: ContextTraceStore;
	private readonly gatewayInfo: () => { baseUrl: string; token: string };
	private readonly globalMaxTokens: number;
	private readonly providerHostApi?: (opts: { sessionId: string; packId: string }) => ServerHostApi;
	private readonly goalMetadataResolver?: GoalMetadataResolver;
	private readonly runtimeResolver?: RuntimeContextResolver;

	// --- Wave 0(b) decision seam (EXT-05 core, select-only) ---------------
	// Independent of `registry`/`moduleHost` above: Wave 0(b) classifiers are
	// registered directly (see `registerDecisionClassifier`), not loaded from
	// pack YAML — that wiring is Wave 1(b). Empty in production today (no
	// caller registers anything), which is what makes `dispatchDecision`
	// byte-identical-dark: see the pinning tests in
	// tests/lifecycle-hub-dispatch-decision.test.ts.
	private readonly decisionAllowList = new Set<string>();
	private readonly decisionClassifiers = new Map<string, DecisionClassifier[]>();
	// CLF-W1a: decisions now attach to `ContextTraceStore`'s persisted
	// `TraceEntry.decisions[]` (see `ContextTraceStore.appendDecision`) when a
	// per-turn entry is active for the session. This ring is the FALLBACK for
	// out-of-turn dispatches (no trace entry exists yet for the session, e.g.
	// direct test calls with no prior `dispatch()`), and remains the
	// mechanism `getDecisionTrace()` exposes for tests — see
	// `recordDecisionOutcome`.
	private readonly decisionTrace: DecisionOutcome[] = [];
	private static readonly MAX_DECISION_TRACE = 500;

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
		/** Factory for a LEAST-PRIVILEGE, provider-scoped server Host API (store-only:
		 *  `capabilities.store === true`, `session`/`agents` false/unavailable). Built
		 *  per provider invocation so a hook reaches its own pack's durable store
		 *  (retain queue / diagnostics) via the SAME pack-scoped, parent-authorized
		 *  path routes use. Omitted ⇒ provider hooks run without `ctx.host`. */
		providerHostApi?: (opts: { sessionId: string; packId: string }) => ServerHostApi;
		/** Resolves `ctx.runtime` for providers declaring a `runtime` linkage (managed
	 *  deployment modes). Consulted per provider invocation; NEVER starts Docker.
	 *  Omitted ⇒ providers run without `ctx.runtime` (managed modes stay dormant). */
		runtimeResolver?: RuntimeContextResolver;
	}) {
		this.registry = deps.registry;
		this.moduleHost = deps.moduleHost;
		this.trace = deps.trace;
		this.gatewayInfo = deps.gatewayInfo;
		this.globalMaxTokens = deps.globalMaxTokens ?? 4_000;
		this.providerHostApi = deps.providerHostApi;
		this.goalMetadataResolver = deps.goalMetadataResolver;
		this.runtimeResolver = deps.runtimeResolver;
	}

	private async resolveProviderRuntime(
		provider: { runtime?: string; config?: Record<string, unknown>; packRoot: string },
		projectId: string | undefined,
	): Promise<RuntimeContext | undefined> {
		if (!provider.runtime || !this.runtimeResolver) return undefined;
		try {
			return (await this.runtimeResolver({
				packId: packIdFromRoot(provider.packRoot),
				runtimeId: provider.runtime,
				projectId,
				config: provider.config ?? {},
			})) ?? undefined;
		} catch {
			return undefined; // resolution failure is non-fatal — provider stays dormant
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
	 * Fire the `goalCompleted` lifecycle hook after a goal is marked complete.
	 * Non-fatal: provider errors/timeouts are logged into diagnostics and swallowed
	 * so goal completion can never be rolled back by an extension provider.
	 */
	async dispatchGoalCompleted(ctx: GoalCompletedCtx): Promise<{ diagnostics: HubDiagnostic[] }> {
		const disabled = this.disabledProviders(ctx.goalId, ctx.projectId);
		const providers = this.registry.listProviders(ctx.projectId).filter(
			(p) => !disabled.has(p.id) && p.hooks.includes("goalCompleted"),
		);
		const diagnostics: HubDiagnostic[] = [];

		for (const provider of providers) {
			const packId = packIdFromRoot(provider.packRoot);
			const runtime = await this.resolveProviderRuntime(provider, ctx.projectId);
			const providerHost = this.providerHostApi?.({ sessionId: `goal:${ctx.goalId}`, packId });
			const url = pathToFileURL(path.resolve(path.dirname(provider.sourceFile), provider.module)).href;
			const t0 = performance.now();
			try {
				await this.moduleHost.invoke({
					url,
					packRoot: provider.packRoot,
					epoch: 0,
					exportKind: "providers",
					member: "goalCompleted",
					ctx: {
						...ctx,
						workingDir: ctx.cwd,
						config: provider.config ?? {},
						gateway: this.gatewayInfo(),
						host: providerHost,
						...(runtime ? { runtime } : {}),
					} as unknown as InvokeRequest["ctx"],
					arg: undefined,
					workingDir: ctx.cwd,
				}, provider.budget.timeoutMs);
			} catch (err) {
				const ms = Math.round(performance.now() - t0);
				const message = err instanceof Error ? err.message : String(err);
				if ((err instanceof ActionError && err.status === 504) || message.includes("timed out")) {
					diagnostics.push({ providerId: provider.id, hook: "goalCompleted", timeout: true, ms });
				} else {
					diagnostics.push({ providerId: provider.id, hook: "goalCompleted", error: message, ms });
				}
				console.warn(`[lifecycle-hub] goalCompleted hook for provider ${provider.id} failed (non-fatal): ${message}`);
			}
		}
		return { diagnostics };
	}

	/**
	 * Run a single provider's hook invocation. Encapsulates the FULL per-provider
	 * try/catch (request build → invoke → validate/extract blocks, or classify the
	 * failure as a timeout/thrown-error) as a standalone async unit so `dispatch()`
	 * can fan these out concurrently (EXT-04) instead of awaiting them one at a
	 * time. Never throws — every outcome (success, malformed blocks, thrown error,
	 * timeout) is captured in the returned `ProviderRunResult`, so `Promise.allSettled`
	 * in `dispatch()` should only ever see `"fulfilled"`.
	 */
	private async runProvider(
		provider: ProviderContribution,
		hook: LifecycleHook,
		base: Omit<HookCtx, "budget" | "config" | "gateway">,
	): Promise<ProviderRunResult> {
		const packId = packIdFromRoot(provider.packRoot);
		// Managed-runtime context (P3): for a provider linked to a runtime, resolve
		// `ctx.runtime` (baseUrl/headers/status) WITHOUT starting Docker. Absent for
		// external mode / a stopped runtime / when no resolver is wired — the provider
		// then stays dormant via its own isActive(cfg, ctx.runtime) gate.
		const runtime = await this.resolveProviderRuntime(provider, base.projectId);
		const hookCtx: HookCtx = {
			...base,
			config: provider.config ?? {},
			budget: { maxTokens: provider.budget.maxTokens },
			gateway: this.gatewayInfo(),
			...(runtime ? { runtime } : {}),
		};
		// Provider-scoped, store-only host (least privilege). The LIVE object stays
		// in the parent (module-host-worker strips it before serialization) and
		// services the worker's proxied store calls — the durable retain queue /
		// diagnostics path. packId is derived from the contribution's pack root.
		const providerHost = this.providerHostApi?.({ sessionId: base.sessionId, packId });
		const url = pathToFileURL(path.resolve(path.dirname(provider.sourceFile), provider.module)).href;
		const t0 = performance.now();
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
			const ms = Math.round(performance.now() - t0);

			const candidates = extractBlocks(result);
			const blocks: ContextBlock[] = [];
			let malformed = 0;
			for (const candidate of candidates) {
				const block = validateBlock(candidate, provider.id);
				if (!block) {
					malformed++;
					continue;
				}
				blocks.push(block);
			}
			const error = malformed > 0 ? "malformed block(s) dropped" : undefined;
			return {
				blocks,
				diagnostic: error ? { providerId: provider.id, hook, error, ms } : undefined,
				trace: { id: provider.id, ms, malformed, error },
			};
		} catch (err) {
			const ms = Math.round(performance.now() - t0);
			const message = err instanceof Error ? err.message : String(err);
			const timeout = (err instanceof ActionError && err.status === 504) || message.includes("timed out");
			return {
				blocks: [],
				diagnostic: timeout
					? { providerId: provider.id, hook, timeout: true, ms }
					: { providerId: provider.id, hook, error: message, ms },
				trace: { id: provider.id, ms, malformed: 0, error: timeout ? "timeout" : message },
			};
		}
	}

	async dispatch(
		hook: LifecycleHook,
		base: Omit<HookCtx, "budget" | "config" | "gateway">,
	): Promise<{ blocks: ContextBlock[]; diagnostics: HubDiagnostic[] }> {
		const disabled = this.disabledProviders(base.goalId, base.projectId);
		const providers = this.registry.listProviders(base.projectId).filter((p) => !disabled.has(p.id) && p.hooks.includes(hook));
		const diagnostics: HubDiagnostic[] = [];
		const collected: ContextBlock[] = [];
		const traceStates = new Map<string, ProviderTraceState>();

		// EXT-04 (shared-deadline fan-out): providers race CONCURRENTLY instead of
		// stacking their timeouts serially — `dispatch()` as a whole now takes as
		// long as the SLOWEST provider (bounded by its own `budget.timeoutMs`, via
		// ModuleHost's existing per-invoke terminate-on-timeout) rather than the SUM
		// of every provider's timeout. No additional hub-level deadline is needed:
		// the fan-out already turns "sum of N timeouts" into "max of N timeouts" for
		// free, and each provider's own timeout accounting is untouched (still
		// measured from ITS OWN `t0` inside `runProvider`, independent of how many
		// other providers are running alongside it).
		//
		// `Promise.allSettled` resolves its results array in the SAME order as the
		// input array regardless of completion order (a language guarantee, not a
		// race) — so `settled[i]` always corresponds to `providers[i]`, and the loop
		// below rebuilds `collected`/`diagnostics`/`traceStates` in REGISTRATION
		// order, byte-identical to the pre-fix serial code's ordering, even though
		// execution now overlaps in wall-clock time. See
		// tests/lifecycle-hub.test.ts's ordering-determinism + shared-deadline pins.
		//
		// CLF coordination: a future model-backed classifier cascade
		// (`dispatchDecision`, EXT-05 core) can be layered onto this fan-out without
		// breaking order, since ordering is keyed off the STATIC `providers` array,
		// never off completion timing.
		const settled = await Promise.allSettled(providers.map((provider) => this.runProvider(provider, hook, base)));

		for (let i = 0; i < providers.length; i++) {
			const provider = providers[i];
			const outcome = settled[i];
			if (outcome.status === "rejected") {
				// `runProvider` catches everything internally, so this is unreachable in
				// practice — kept as a defensive fallback so a future refactor can't
				// silently turn a rejection into a hung/absent trace row.
				const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
				diagnostics.push({ providerId: provider.id, hook, error: message, ms: 0 });
				traceStates.set(provider.id, { id: provider.id, ms: 0, malformed: 0, error: message });
				continue;
			}
			const { blocks, diagnostic, trace } = outcome.value;
			collected.push(...blocks);
			if (diagnostic) diagnostics.push(diagnostic);
			traceStates.set(provider.id, trace);
		}

		const perProviderMax = new Map(providers.map((p) => [p.id, p.budget.maxTokens]));
		const budgeted = applyBudgets(collected, perProviderMax, this.globalMaxTokens);
		const traceRows = providers.map((provider): TraceProviderRow => {
			const state = traceStates.get(provider.id) ?? { id: provider.id, ms: 0, malformed: 0 };
			const blocksCount = budgeted.kept.filter((block) => block.providerId === provider.id).length;
			const omittedCount = budgeted.omitted.filter(({ block }) => block.providerId === provider.id).length + state.malformed;
			// EXT-06 transparency: a provider that contributed candidates but ends with
			// ZERO kept blocks purely because the shared budget had no room — no error,
			// no timeout, nothing malformed — used to be silent. Only fires when nothing
			// else already explains the zero (a real error/timeout takes precedence).
			const starved = blocksCount === 0 && omittedCount > 0 && !state.error;
			if (starved) diagnostics.push({ providerId: provider.id, hook, error: STARVATION_MARKER, ms: state.ms });
			return {
				id: provider.id,
				ms: state.ms,
				blocks: blocksCount,
				omitted: omittedCount,
				...(state.error ? { error: state.error } : starved ? { error: STARVATION_MARKER } : {}),
			};
		});
		this.trace.appendTrace(base.sessionId, { ts: Date.now(), hook, sessionId: base.sessionId, providers: traceRows });

		return { blocks: budgeted.kept, diagnostics };
	}

	// --- Wave 0(b) decision seam (EXT-05 core, select-only) ----------------

	/**
	 * Allow-lists a (point, kind) pair for `dispatchDecision` WITHOUT attaching
	 * a classifier. Exists so tests can pin the "allow-listed but zero
	 * classifiers registered" behaviour (abstain, byte-identical) distinctly
	 * from the "pair never allow-listed at all" rejection. No production
	 * caller exists yet — see `dispatchDecision`.
	 */
	allowDecisionPoint(point: DecisionPoint, kind: string): void {
		this.decisionAllowList.add(decisionKey(point, kind));
	}

	/**
	 * Registers a classifier at (point, kind), implicitly allow-listing the
	 * pair. Returns an unregister function. No production caller registers a
	 * classifier today (Wave 1(b) wires pack-declared classifiers through
	 * here or a moduleHost-backed adapter) — this is exercised only by tests
	 * (a "fake classifier") until then.
	 */
	registerDecisionClassifier<TChoice = unknown>(
		point: DecisionPoint,
		kind: string,
		classifier: DecisionClassifier<TChoice>,
	): () => void {
		const key = decisionKey(point, kind);
		this.decisionAllowList.add(key);
		const list = this.decisionClassifiers.get(key) ?? [];
		list.push(classifier as DecisionClassifier);
		this.decisionClassifiers.set(key, list);
		return () => {
			const cur = this.decisionClassifiers.get(key);
			if (!cur) return;
			const idx = cur.indexOf(classifier as DecisionClassifier);
			if (idx >= 0) cur.splice(idx, 1);
		};
	}

	/**
	 * EXT-05 core (CLF-W0b): consult registered classifiers for a DECISION at
	 * (point, kind). SELECT-ONLY — returns the first `select` a registered
	 * classifier produces (first-registered-wins; arbitrating ties/confidence
	 * across multiple selecting classifiers is deferred to a later wave, see
	 * design doc §6), or `abstain` when nothing selects (including when zero
	 * classifiers are registered — this is the byte-identical-today case).
	 *
	 * Throws for an unregistered (point, kind) pair (the allow-list rejection)
	 * rather than silently no-op-ing, so a caller typo can never silently go
	 * dark — this is safe ONLY because there is no production call site yet;
	 * a real call site would need to decide fail-open vs fail-closed per the
	 * design doc's safety model (§6) before this wave's blanket "throw" ships
	 * on a live path.
	 *
	 * NO PRODUCTION CALL SITE consults this yet — the seam ships dark. Nothing
	 * in the shipped server calls `allowDecisionPoint`/`registerDecisionClassifier`,
	 * so every real invocation of this method today would throw, and none
	 * occurs — production behaviour is provably byte-identical. See
	 * tests/lifecycle-hub-dispatch-decision.test.ts.
	 */
	async dispatchDecision<TChoice = unknown>(
		point: DecisionPoint,
		kind: string,
		ctx: DecisionDispatchCtx,
		arg?: unknown,
	): Promise<Decision<TChoice>> {
		const key = decisionKey(point, kind);
		if (!this.decisionAllowList.has(key)) {
			throw new Error(`dispatchDecision: (${point}, ${JSON.stringify(kind)}) is not a registered decision point/kind pair`);
		}
		const t0 = performance.now();
		const classifiers = this.decisionClassifiers.get(key) ?? [];
		const consulted: string[] = [];
		let decision: Decision<TChoice> = { kind: "abstain" };
		for (const classifier of classifiers) {
			consulted.push(classifier.id);
			let result: unknown;
			try {
				result = await classifier.evaluate(ctx, arg);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.warn(`[lifecycle-hub] decision classifier ${classifier.id} threw at (${point}, ${kind}) (non-fatal, treated as abstain): ${message}`);
				continue;
			}
			if (!isDecision(result)) {
				console.warn(`[lifecycle-hub] decision classifier ${classifier.id} returned a malformed Decision at (${point}, ${kind}); treated as abstain`);
				continue;
			}
			if (result.kind === "select") {
				decision = result as Decision<TChoice>;
				break;
			}
			// abstain → keep polling remaining classifiers
		}
		const ms = Math.round(performance.now() - t0);
		this.recordDecisionOutcome(ctx.sessionId, { ts: Date.now(), point, decisionKind: kind, consulted, decision, ms });
		return decision;
	}

	/**
	 * CLF-W1a: record a decision outcome into the durable per-turn trace when
	 * one is active for this session (`ContextTraceStore.appendDecision`
	 * attaches to the latest `TraceEntry`), falling back to the in-memory ring
	 * for out-of-turn dispatches (no trace entry exists yet — e.g. a direct
	 * `dispatchDecision` call with no prior `dispatch()` for the session, as
	 * every CLF-W0b pinning test does). This keeps those tests' `getDecisionTrace()`
	 * assertions unchanged: `ContextTraceStore.appendDecision` returns `false`
	 * when no trace file exists, so the ring still receives the outcome.
	 */
	private recordDecisionOutcome(sessionId: string, entry: DecisionOutcome): void {
		const attached = this.trace.appendDecision(sessionId, entry);
		if (attached) return;
		this.decisionTrace.push(entry);
		if (this.decisionTrace.length > LifecycleHub.MAX_DECISION_TRACE) {
			this.decisionTrace.shift();
		}
	}

	/** Test/inspection accessor for the FALLBACK in-memory decision-outcome
	 *  ring — outcomes that had no active per-turn trace entry to attach to.
	 *  Decisions attached to a durable `TraceEntry` are read via
	 *  `ContextTraceStore.readTrace()` / `GET .../context-trace`, not here. */
	getDecisionTrace(): readonly DecisionOutcome[] {
		return this.decisionTrace;
	}
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
