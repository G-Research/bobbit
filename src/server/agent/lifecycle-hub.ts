import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { ActionError } from "../extension-host/action-dispatcher.js";
import type { PackContributionRegistry } from "../extension-host/pack-contribution-registry.js";
import { ModuleHost, type InvokeRequest } from "../extension-host/module-host-worker.js";
import { packIdFromRoot } from "./pack-contributions.js";
import type { ServerHostApi } from "../extension-host/server-host-api.js";
import { applyBudgets, estimateTokens, type ContextBlock, type ContextBlockAuthority } from "./context-blocks.js";
import { ContextTraceStore, type TraceProviderRow } from "./context-trace-store.js";

export type LifecycleHook = "sessionSetup" | "beforePrompt" | "afterTurn" | "beforeCompact" | "sessionShutdown";

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

export class LifecycleHub {
	private readonly registry: PackContributionRegistry;
	private readonly moduleHost: ModuleHost;
	private readonly trace: ContextTraceStore;
	private readonly gatewayInfo: () => { baseUrl: string; token: string };
	private readonly globalMaxTokens: number;
	private readonly providerHostApi?: (opts: { sessionId: string; packId: string }) => ServerHostApi;
	private readonly goalMetadataResolver?: GoalMetadataResolver;
	private readonly runtimeResolver?: RuntimeContextResolver;

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

	async dispatch(
		hook: LifecycleHook,
		base: Omit<HookCtx, "budget" | "config" | "gateway">,
	): Promise<{ blocks: ContextBlock[]; diagnostics: HubDiagnostic[] }> {
		const disabled = this.disabledProviders(base.goalId, base.projectId);
		const providers = this.registry.listProviders(base.projectId).filter((p) => !disabled.has(p.id) && p.hooks.includes(hook));
		const diagnostics: HubDiagnostic[] = [];
		const collected: ContextBlock[] = [];
		const traceStates = new Map<string, ProviderTraceState>();

		for (const provider of providers) {
			const packId = packIdFromRoot(provider.packRoot);
			// Managed-runtime context (P3): for a provider linked to a runtime, resolve
			// `ctx.runtime` (baseUrl/headers/status) WITHOUT starting Docker. Absent for
			// external mode / a stopped runtime / when no resolver is wired — the provider
			// then stays dormant via its own isActive(cfg, ctx.runtime) gate.
			let runtime: RuntimeContext | undefined;
			if (provider.runtime && this.runtimeResolver) {
				try {
					runtime = (await this.runtimeResolver({
						packId,
						runtimeId: provider.runtime,
						projectId: base.projectId,
						config: provider.config ?? {},
					})) ?? undefined;
				} catch {
					runtime = undefined; // resolution failure is non-fatal — provider stays dormant
				}
			}
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

		return { blocks: budgeted.kept, diagnostics };
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
