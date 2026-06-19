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

export class LifecycleHub {
	private readonly registry: PackContributionRegistry;
	private readonly moduleHost: ModuleHost;
	private readonly trace: ContextTraceStore;
	private readonly gatewayInfo: () => { baseUrl: string; token: string };
	private readonly globalMaxTokens: number;
	private readonly providerHostApi?: (opts: { sessionId: string; packId: string }) => ServerHostApi;

	constructor(deps: {
		registry: PackContributionRegistry;
		moduleHost: ModuleHost;
		trace: ContextTraceStore;
		gatewayInfo: () => { baseUrl: string; token: string };
		globalMaxTokens?: number;
		/** Factory for a LEAST-PRIVILEGE, provider-scoped server Host API (store-only:
		 *  `capabilities.store === true`, `session`/`agents` false/unavailable). Built
		 *  per provider invocation so a hook reaches its own pack's durable store
		 *  (retain queue / diagnostics) via the SAME pack-scoped, parent-authorized
		 *  path routes use. Omitted ⇒ provider hooks run without `ctx.host`. */
		providerHostApi?: (opts: { sessionId: string; packId: string }) => ServerHostApi;
	}) {
		this.registry = deps.registry;
		this.moduleHost = deps.moduleHost;
		this.trace = deps.trace;
		this.gatewayInfo = deps.gatewayInfo;
		this.globalMaxTokens = deps.globalMaxTokens ?? 4_000;
		this.providerHostApi = deps.providerHostApi;
	}

	/**
	 * True when at least one active (activation-filtered) provider for the
	 * project declares one of the given hooks. Used by session setup to decide
	 * whether the per-turn provider-bridge extension is warranted; keeps provider
	 * activation filtering centralized in the registry.
	 */
	hasProvidersForHooks(projectId: string | undefined, hooks: readonly LifecycleHook[]): boolean {
		const wanted = new Set<string>(hooks);
		return this.registry.listProviders(projectId).some((p) => p.hooks.some((h) => wanted.has(h)));
	}

	async dispatch(
		hook: LifecycleHook,
		base: Omit<HookCtx, "budget" | "config" | "gateway">,
	): Promise<{ blocks: ContextBlock[]; diagnostics: HubDiagnostic[] }> {
		const providers = this.registry.listProviders(base.projectId).filter((p) => p.hooks.includes(hook));
		const diagnostics: HubDiagnostic[] = [];
		const collected: ContextBlock[] = [];
		const traceStates = new Map<string, ProviderTraceState>();

		for (const provider of providers) {
			const hookCtx: HookCtx = {
				...base,
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
