import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { ActionError } from "./action-dispatcher.js";
import type { ServerHostApi } from "./server-host-api.js";
import { ModuleHost, type InvokeRequest } from "./module-host-worker.js";
import { PackContributionRegistry } from "./pack-contribution-registry.js";
import { LifecycleHub, type HookDispatchBase, type LifecycleHook } from "../agent/lifecycle-hub.js";
import {
	normalizeHookContributions,
	type NormalizedInterceptorContribution,
	type NormalizedLegacyProviderContribution,
	type RuntimeHookContribution,
} from "./host-hook-contributions.js";
import {
	deepFreezeHostValue,
	HOST_HOOK_LIMITS,
	HOST_INTERCEPTOR_CATALOGUE,
	validateInterceptorRequest,
	validateInterceptorResult,
	type HostInterceptorName,
	type HostInterceptorRequest,
	type HostInterceptorResult,
} from "../../shared/extension-host/host-hooks.js";

export interface HostInterceptorContext {
	readonly projectId?: string;
	readonly sessionId?: string;
	readonly goalId?: string;
	readonly cwd: string;
	readonly correlationId?: string;
	readonly signal: AbortSignal;
}

export type HostInterceptorAuditOutcome =
	| "applied"
	| "inactive"
	| "invalid-result"
	| "timed-out"
	| "cancelled"
	| "failed-open"
	| "failed-closed";

/** Payload-free and path-free by construction. */
export interface HostInterceptorAuditDecision {
	readonly occurredAt: number;
	readonly hook: HostInterceptorName;
	readonly projectId?: string;
	readonly sessionId?: string;
	readonly packId: string;
	readonly contributionId: string;
	readonly durationMs: number;
	readonly outcome: HostInterceptorAuditOutcome;
	readonly proposalReceived: boolean;
	readonly valid: boolean;
	readonly applied: boolean;
	readonly timedOut: boolean;
	readonly cancelled: boolean;
}

export interface HostInterceptorDispatchResult<N extends HostInterceptorName> {
	readonly value: HostInterceptorRequest<N>;
	readonly decisions: readonly HostInterceptorAuditDecision[];
	/** A terminal block/synthetic-error decision, when the operation has one. */
	readonly terminal?: HostInterceptorResult<N>;
}

type RuntimeInterceptorDefinition = (typeof HOST_INTERCEPTOR_CATALOGUE)[HostInterceptorName];

export interface HostInterceptorRouterOptions {
	readonly registry: PackContributionRegistry;
	readonly moduleHost: ModuleHost;
	readonly lifecycleHub?: LifecycleHub;
	readonly createHostApi?: (input: Readonly<{
		context: HostInterceptorContext;
		packId: string;
		contributionId: string;
		capabilities: readonly string[];
	}>) => ServerHostApi | undefined;
	/** Live parent-owned capability authorization. Omitted means the registry
	 * has already authorized every declared capability. */
	readonly isCapabilityAuthorized?: (input: Readonly<{
		projectId?: string;
		packId: string;
		contributionId: string;
		capability: string;
	}>) => boolean;
	readonly validateToolArgs?: (toolName: string, args: unknown, context: HostInterceptorContext) => boolean;
	readonly validateToolResult?: (toolName: string, result: unknown, context: HostInterceptorContext) => boolean;
	readonly audit?: (decision: HostInterceptorAuditDecision) => void;
	readonly now?: () => number;
	readonly monotonicNow?: () => number;
}

/** Typed, sequential pre-authority extension router. It owns no durable state. */
export class HostInterceptorRouter {
	private readonly now: () => number;
	private readonly monotonicNow: () => number;

	constructor(private readonly options: HostInterceptorRouterOptions) {
		this.now = options.now ?? Date.now;
		this.monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
	}

	/** Snapshot whether an active, currently authorized contribution makes a
	 * transport failure terminal for this operation. Spawn/respawn callers inject
	 * this host-owned decision into the generated Pi bridge; pack code cannot
	 * assert protected status itself. */
	requiresFailClosed(name: HostInterceptorName, projectId?: string): boolean {
		const definition = HOST_INTERCEPTOR_CATALOGUE[name] as RuntimeInterceptorDefinition;
		return normalizeHookContributions(this.options.registry, projectId).some((contribution) => {
			if (contribution.kind !== "interceptor" || contribution.name !== name) return false;
			const policy = contribution.failurePolicy ?? definition.defaultFailurePolicy;
			return policy === "failClosed"
				&& this.isAuthorized(contribution, projectId, definition.requiredCapabilities);
		});
	}

	async dispatch<N extends HostInterceptorName>(
		name: N,
		input: HostInterceptorRequest<N>,
		context: HostInterceptorContext,
	): Promise<HostInterceptorDispatchResult<N>> {
		if (!validateInterceptorRequest(name, input)) throw new TypeError(`invalid ${name} interceptor request`);
		const definition = HOST_INTERCEPTOR_CATALOGUE[name] as RuntimeInterceptorDefinition;
		const dispatchLimit = definition.dispatchDeadlineMs;
		const dispatchStarted = this.monotonicNow();
		const deadline = dispatchStarted + dispatchLimit;
		const dispatchController = new AbortController();
		const forwardAbort = (): void => dispatchController.abort(context.signal.reason);
		context.signal.addEventListener("abort", forwardAbort, { once: true });
		const stopInvalidation = this.options.registry.onInvalidate(() => dispatchController.abort("registry-invalidated"));
		const deadlineTimer = setTimeout(() => dispatchController.abort("dispatch-deadline"), dispatchLimit);
		const decisions: HostInterceptorAuditDecision[] = [];
		let value = clone(input);
		let terminal: HostInterceptorResult<N> | undefined;
		try {
			const contributions = normalizeHookContributions(this.options.registry, context.projectId)
				.filter((row): row is NormalizedInterceptorContribution | NormalizedLegacyProviderContribution =>
					(row.kind === "interceptor" || row.kind === "legacy-provider") && row.name === name,
				);
			for (const contribution of contributions) {
				if (terminal !== undefined) break;
				const started = this.monotonicNow();
				if (dispatchController.signal.aborted) {
					if (dispatchController.signal.reason === "dispatch-deadline") {
						const failed = this.failClosedResult(name, contribution, definition);
						this.record(decisions, contribution, name, context, started, failed === undefined ? "timed-out" : "failed-closed", false, false, false, true);
						if (failed !== undefined) terminal = failed as HostInterceptorResult<N>;
					}
					break;
				}
				const remaining = Math.floor(deadline - this.monotonicNow());
				if (remaining <= 0) {
					const failed = this.failClosedResult(name, contribution, definition);
					this.record(decisions, contribution, name, context, started, failed === undefined ? "timed-out" : "failed-closed", false, false, false, true);
					if (failed !== undefined) terminal = failed as HostInterceptorResult<N>;
					break;
				}
				const requiredCapabilities = contribution.kind === "interceptor" ? definition.requiredCapabilities : [];
				if (!this.isAuthorized(contribution, context.projectId, requiredCapabilities)) {
					this.record(decisions, contribution, name, context, started, "inactive", false, false, false);
					continue;
				}
				const cap = definition.maxTimeoutMs;
				const declared = contribution.kind === "legacy-provider"
					? contribution.budget.timeoutMs
					: contribution.budget.declaredTimeoutMs ?? definition.defaultTimeoutMs;
				const timeoutMs = Math.max(1, Math.min(remaining, declared, cap));
				let proposalReceived = false;
				let valid = false;
				try {
					const proposal = contribution.kind === "legacy-provider"
						? await this.invokeLegacy(name, value, context, contribution, timeoutMs, dispatchController.signal)
						: await this.invokeExplicit(name, value, context, contribution, timeoutMs, dispatchController.signal);
					proposalReceived = true;
					valid = validateInterceptorResult(name, proposal) && this.validateOperationMutation(name, value, proposal, context);
					if (!valid) {
						const failed = this.failClosedResult(name, contribution, definition);
						this.record(decisions, contribution, name, context, started, failed === undefined ? "invalid-result" : "failed-closed", true, false, false);
						if (failed !== undefined) terminal = failed as HostInterceptorResult<N>;
						continue;
					}
					// Authority is deliberately checked again after worker settlement and
					// immediately before application.
					if (!this.isAuthorized(contribution, context.projectId, requiredCapabilities) || dispatchController.signal.aborted) {
						this.record(decisions, contribution, name, context, started, "cancelled", true, true, false, false, true);
						continue;
					}
					const folded = foldResult(name, value, proposal as HostInterceptorResult<N>);
					value = folded.value;
					if (folded.terminal !== undefined) terminal = folded.terminal;
					this.record(decisions, contribution, name, context, started, "applied", true, true, true);
				} catch (error) {
					const deadlineExpired = dispatchController.signal.aborted && dispatchController.signal.reason === "dispatch-deadline";
					const timedOut = isTimeout(error) || deadlineExpired;
					const cancelled = !timedOut && (dispatchController.signal.aborted || isCancelled(error));
					const failed = !cancelled ? this.failClosedResult(name, contribution, definition) : undefined;
					const outcome: HostInterceptorAuditOutcome = timedOut
						? (failed === undefined ? "timed-out" : "failed-closed")
						: cancelled ? "cancelled" : failed === undefined ? "failed-open" : "failed-closed";
					this.record(decisions, contribution, name, context, started, outcome, proposalReceived, valid, false, timedOut, cancelled);
					if (failed !== undefined) terminal = failed as HostInterceptorResult<N>;
				}
			}
		} finally {
			clearTimeout(deadlineTimer);
			stopInvalidation();
			context.signal.removeEventListener("abort", forwardAbort);
		}
		return Object.freeze({
			value: deepFreeze(value),
			decisions: Object.freeze(decisions.slice()),
			...(terminal === undefined ? {} : { terminal: deepFreeze(terminal) }),
		});
	}

	private isAuthorized(
		contribution: NormalizedInterceptorContribution | NormalizedLegacyProviderContribution,
		projectId: string | undefined,
		requiredCapabilities: readonly string[],
	): boolean {
		const registryAuthorized = contribution.kind === "legacy-provider"
			? this.options.registry.isProviderAuthorized(projectId, contribution.packId, contribution.providerId, contribution.listName, contribution.activationEpoch)
			: this.options.registry.isHookAuthorized(projectId, contribution.packId, contribution.contributionId, contribution.listName, contribution.activationEpoch, requiredCapabilities);
		if (!registryAuthorized) return false;
		return contribution.capabilities.every((capability) => this.options.isCapabilityAuthorized?.({
			projectId,
			packId: contribution.packId,
			contributionId: contribution.contributionId,
			capability,
		}) !== false);
	}

	private async invokeExplicit<N extends HostInterceptorName>(
		name: N,
		value: HostInterceptorRequest<N>,
		context: HostInterceptorContext,
		contribution: NormalizedInterceptorContribution,
		timeoutMs: number,
		signal: AbortSignal,
	): Promise<unknown> {
		const host = this.options.createHostApi?.({
			context,
			packId: contribution.packId,
			contributionId: contribution.contributionId,
			capabilities: contribution.capabilities,
		});
		const url = `${pathToFileURL(path.resolve(path.dirname(contribution.sourceFile), contribution.module)).href}?e=${contribution.activationEpoch}`;
		return this.options.moduleHost.invoke({
			url,
			packRoot: contribution.packRoot,
			epoch: contribution.activationEpoch,
			exportKind: "hooks",
			member: name,
			ctx: {
				host,
				sessionId: context.sessionId ?? `project:${context.projectId ?? "unbound"}`,
				projectId: context.projectId,
				goalId: context.goalId,
				tool: `host-interceptor:${name}`,
				workingDir: context.cwd,
				config: contribution.config,
				correlationId: context.correlationId,
			} as unknown as InvokeRequest["ctx"],
			arg: deepFreeze(clone(value)),
			workingDir: context.cwd,
			signal,
		}, timeoutMs);
	}

	private async invokeLegacy<N extends HostInterceptorName>(
		name: N,
		value: HostInterceptorRequest<N>,
		context: HostInterceptorContext,
		contribution: NormalizedLegacyProviderContribution,
		timeoutMs: number,
		signal: AbortSignal,
	): Promise<unknown> {
		if (!this.options.lifecycleHub) return { context: [] };
		const base = legacyDispatchBase(value, context);
		const result = await this.options.lifecycleHub.dispatchProvider(
			name as LifecycleHook,
			base,
			{ id: contribution.providerId, listName: contribution.listName, packRoot: contribution.packRoot },
			undefined,
			{ signal, timeoutMs },
		);
		if (name === "sessionShutdown") return {};
		return {
			context: result.blocks.map((block) => ({
				id: block.id,
				title: block.title,
				authority: block.authority,
				content: block.content,
				reason: block.reason,
				priority: block.priority,
			})),
		};
	}

	private validateOperationMutation<N extends HostInterceptorName>(
		name: N,
		value: HostInterceptorRequest<N>,
		proposal: unknown,
		context: HostInterceptorContext,
	): boolean {
		if (!proposal || typeof proposal !== "object") return true;
		const record = proposal as Record<string, unknown>;
		const action = typeof record.action === "string" ? record.action : typeof record.decision === "string" ? record.decision : undefined;
		if (name === "beforeToolCall" && (action === "replaceArgs" || "args" in record)) {
			const request = value as unknown as Record<string, unknown>;
			return !!this.options.validateToolArgs && typeof request.toolName === "string"
				&& this.options.validateToolArgs(request.toolName, record.args, context);
		}
		if (name === "afterToolResult" && (action === "replaceResult" || "result" in record)) {
			const request = value as unknown as Record<string, unknown>;
			return !this.options.validateToolResult || typeof request.toolName !== "string"
				|| this.options.validateToolResult(request.toolName, record.result, context);
		}
		return true;
	}

	private failClosedResult<N extends HostInterceptorName>(
		name: N,
		contribution: RuntimeHookContribution,
		definition: RuntimeInterceptorDefinition,
	): unknown {
		if (contribution.kind !== "interceptor") return undefined;
		const policy = contribution.failurePolicy ?? definition.defaultFailurePolicy;
		if (policy !== "failClosed") return undefined;
		if (name === "beforeToolCall") return { action: "block", reasonCode: "not_permitted" };
		if (name === "afterToolResult") return { action: "syntheticError", code: "handler_error" };
		return undefined;
	}

	private record(
		rows: HostInterceptorAuditDecision[],
		contribution: NormalizedInterceptorContribution | NormalizedLegacyProviderContribution,
		hook: HostInterceptorName,
		context: HostInterceptorContext,
		started: number,
		outcome: HostInterceptorAuditOutcome,
		proposalReceived: boolean,
		valid: boolean,
		applied: boolean,
		timedOut = false,
		cancelled = false,
	): void {
		const row = Object.freeze({
			occurredAt: this.now(), hook,
			...(context.projectId ? { projectId: context.projectId } : {}),
			...(context.sessionId ? { sessionId: context.sessionId } : {}),
			packId: contribution.packId,
			contributionId: contribution.contributionId,
			durationMs: Math.min(60_000, Math.max(0, Math.round(this.monotonicNow() - started))),
			outcome, proposalReceived, valid, applied, timedOut, cancelled,
		});
		rows.push(row);
		try { this.options.audit?.(row); } catch { /* audit cannot affect authority */ }
	}
}

function legacyDispatchBase<N extends HostInterceptorName>(
	value: HostInterceptorRequest<N>,
	context: HostInterceptorContext,
): HookDispatchBase {
	const input = value as unknown as Record<string, unknown>;
	return {
		sessionId: context.sessionId ?? String(input.sessionId ?? `project:${context.projectId ?? "unbound"}`),
		projectId: context.projectId,
		goalId: context.goalId,
		cwd: context.cwd,
		scope: input.scope === "global" || input.scope === "project"
			? input.scope
			: context.projectId ? "project" : "global",
		...(typeof input.roleName === "string" ? { roleName: input.roleName } : {}),
		...(typeof input.prompt === "string"
			? { prompt: input.prompt }
			: typeof input.userText === "string" ? { prompt: input.userText } : {}),
		...(typeof input.userText === "string" ? { userText: input.userText } : {}),
		...(typeof input.span === "string" ? { span: input.span } : {}),
		...(typeof input.summary === "string" ? { summary: input.summary } : {}),
		...(typeof input.turnIndex === "number" ? { turn: { index: input.turnIndex } } : {}),
	};
}

function foldResult<N extends HostInterceptorName>(
	name: N,
	current: HostInterceptorRequest<N>,
	proposal: HostInterceptorResult<N>,
): { value: HostInterceptorRequest<N>; terminal?: HostInterceptorResult<N> } {
	const value = clone(current) as unknown as Record<string, unknown>;
	const result = proposal as unknown as Record<string, unknown>;
	if (Array.isArray(result.context)) {
		const existing = Array.isArray(value.context) ? value.context : [];
		value.context = [...existing, ...clone(result.context)].slice(0, HOST_HOOK_LIMITS.contextContributions);
	}
	if ("flush" in result) value.flush = result.flush;
	if ("initialised" in result) value.initialised = result.initialised;
	const action = typeof result.action === "string" ? result.action : typeof result.decision === "string" ? result.decision : undefined;
	if (name === "beforeToolCall") {
		if (action === "replaceArgs") value.args = clone(result.args);
		if (action === "block") return { value: value as HostInterceptorRequest<N>, terminal: proposal };
	}
	if (name === "afterToolResult") {
		if (action === "replaceResult") value.result = clone(result.result);
		if (action === "syntheticError") return { value: value as HostInterceptorRequest<N>, terminal: proposal };
	}
	return { value: value as HostInterceptorRequest<N> };
}

function isTimeout(error: unknown): boolean {
	return (error instanceof ActionError && error.status === 504)
		|| (error instanceof Error && /timed out/i.test(error.message));
}

function isCancelled(error: unknown): boolean {
	return (error instanceof ActionError && error.status === 499)
		|| (error instanceof Error && /cancel/i.test(error.message));
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
	return deepFreezeHostValue(value) as T;
}
