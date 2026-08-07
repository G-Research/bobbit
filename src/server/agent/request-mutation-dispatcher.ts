import path from "node:path";
import { pathToFileURL } from "node:url";
import { ActionError } from "../extension-host/action-dispatcher.js";
import type { ModuleHost, InvokeRequest } from "../extension-host/module-host-worker.js";
import type { PackContributionRegistry } from "../extension-host/pack-contribution-registry.js";
import type { HookContribution } from "./pack-contributions.js";
import type { ExtensionGrant } from "./project-config-store.js";
import { resolveExtensionGrant, type ResolvedHook } from "./extension-grant-policy.js";
import {
	MAX_REQUEST_MUTATION_HOOKS,
	reducePromptShape,
	reduceToolSafety,
	validatePromptShapeOutcome,
	validateRequestMutationHookOutput,
	validateToolSafetyOutcome,
	type PromptShapeCandidate,
	type PromptShapeRequest,
	type PromptShapeReduction,
	type RequestMutationEvent,
	type RequestMutationReason,
	type RequestMutationSource,
	type RequestShaper,
	type ToolSafetyCandidate,
	type ToolSafetyRequest,
	type ToolSafetyReduction,
} from "./request-mutation-contract.js";
import { RequestMutationContractError } from "./request-mutation-contract.js";

export interface RequestMutationOutcome {
	source: { kind: "core" | "extension"; id: string; packId?: string; hookId?: string };
	outcome: "applied" | "advised" | "denied" | "dropped" | "error" | "superseded";
	reason: RequestMutationReason;
	ms: number;
}

export interface PromptMutationResult extends PromptShapeReduction {
	outcomes: readonly RequestMutationOutcome[];
}
export interface ToolSafetyResult extends ToolSafetyReduction {
	outcomes: readonly RequestMutationOutcome[];
}

export interface RequestMutationDispatcherDeps {
	registry: PackContributionRegistry;
	moduleHost: ModuleHost;
	grantsForProject(projectId: string): readonly ExtensionGrant[];
	/** Core-owned consumers; never serialized, contributed, or exposed to ModuleHost. */
	coreShapers?: readonly RequestShaper[];
	/** The request contains no cwd; callers may supply the session's server-derived cwd. */
	cwdForSession?: (sessionId: string, projectId: string) => string;
}

type ExtensionTarget = { hook: HookContribution; source: RequestMutationSource };
type CoreTarget = { shaper: RequestShaper; source: RequestMutationSource };
type CandidateResult<T> = {
	candidate?: T;
	outcome: RequestMutationOutcome;
	/** Present only for candidates returned by an extension worker. */
	extensionEvent?: RequestMutationEvent;
};

/**
 * Core applies the returned typed result. Module workers only propose closed,
 * transient changes and are fenced by live declaration/grant checks both before
 * and after invocation.
 */
export class RequestMutationDispatcher {
	constructor(private readonly deps: RequestMutationDispatcherDeps) {}

	hasPromptHooks(projectId: string): boolean {
		return this.coreTargets("shapePrompt").length > 0 || this.extensionTargets(projectId, "beforePrompt").some(target => this.isGranted(projectId, target.source));
	}

	hasToolSafetyHooks(projectId: string): boolean {
		return this.coreTargets("inspectTool").length > 0 || this.extensionTargets(projectId, "beforeToolCall").some(target => this.isGranted(projectId, target.source));
	}

	async shapePrompt(request: PromptShapeRequest): Promise<PromptMutationResult> {
		const extensions = this.extensionTargets(request.projectId, "beforePrompt");
		const core = this.coreTargets("shapePrompt");
		const settled = await Promise.all([
			...extensions.map(target => this.invokePromptExtension(target, request)),
			...core.map(target => this.invokePromptCore(target, request)),
		]);
		// Workers can settle at different times. Re-evaluate every extension
		// candidate together after all have settled so a revoke/deactivation while a
		// sibling worker is pending cannot leave an earlier proposal authorized.
		const fenced = this.fenceExtensionCandidates(request.projectId, "beforePrompt", settled);
		const candidates = fenced.flatMap(result => result.candidate ? [result.candidate] : []);
		const reduction = reducePromptShape(candidates);
		const outcomes = this.markWinner(fenced.map(result => result.outcome), reduction.source, reduction.action === "replace", "applied");
		return Object.freeze({ ...reduction, outcomes: Object.freeze(outcomes) });
	}

	async inspectTool(request: ToolSafetyRequest): Promise<ToolSafetyResult> {
		const extensions = this.extensionTargets(request.projectId, "beforeToolCall");
		const core = this.coreTargets("inspectTool");
		const settled = await Promise.all([
			...extensions.map(target => this.invokeToolExtension(target, request)),
			...core.map(target => this.invokeToolCore(target, request)),
		]);
		// See shapePrompt: this is deliberately after Promise.all, rather than
		// relying on each worker's individual post-invocation grant check.
		const fenced = this.fenceExtensionCandidates(request.projectId, "beforeToolCall", settled);
		const candidates = fenced.flatMap(result => result.candidate ? [result.candidate] : []);
		const reduction = reduceToolSafety(candidates);
		const outcomes = this.markWinner(fenced.map(result => result.outcome), reduction.source, reduction.action !== "pass", reduction.action === "warn" ? "advised" : "denied");
		return Object.freeze({ ...reduction, outcomes: Object.freeze(outcomes) });
	}

	private extensionTargets(projectId: string, event: RequestMutationEvent): ExtensionTarget[] {
		try {
			const packs = this.deps.registry.list(projectId);
			return packs.flatMap((pack, priority) => pack.hooks
				.filter(hook => hook.mode === "decide" && hook.events.includes(event) && hook.capabilities.includes("mutate"))
				.map(hook => ({ hook, source: { packId: pack.packId, hookId: hook.id, priority } }))
				.sort((a, b) => a.source.hookId.localeCompare(b.source.hookId) || a.hook.listName.localeCompare(b.hook.listName)),
			).slice(0, MAX_REQUEST_MUTATION_HOOKS);
		} catch {
			return [];
		}
	}

	private coreTargets(member: "shapePrompt" | "inspectTool"): CoreTarget[] {
		return (this.deps.coreShapers ?? [])
			.filter(shaper => typeof shaper?.[member] === "function" && safeCoreShaper(shaper))
			.map(shaper => ({ shaper, source: { packId: "core", hookId: shaper.id, priority: shaper.priority } }))
			.sort((a, b) => a.source.priority - b.source.priority || a.shaper.id.localeCompare(b.shaper.id));
	}

	/**
	 * Apply the final live authorization fence to extension candidates only.
	 * Core candidates are constructed and executed by core and therefore have no
	 * declaration/grant state to re-check.
	 */
	private fenceExtensionCandidates<T extends { source: RequestMutationSource }>(projectId: string, event: RequestMutationEvent, settled: readonly CandidateResult<T>[]): CandidateResult<T>[] {
		return settled.map(result => {
			if (!result.candidate || !result.extensionEvent) return result;
			const source = result.candidate.source;
			const declared = this.extensionTargets(projectId, event).some(target =>
				target.source.packId === source.packId && target.source.hookId === source.hookId,
			);
			if (declared && this.isGranted(projectId, source)) return result;
			return {
				...result,
				candidate: undefined,
				outcome: {
					...result.outcome,
					outcome: "denied",
					reason: declared ? "Grant required" : "Prompt mutation disabled",
				},
			};
		});
	}

	private async invokePromptExtension(target: ExtensionTarget, request: PromptShapeRequest): Promise<CandidateResult<PromptShapeCandidate>> {
		const started = Date.now();
		const extension = extensionOutcome(target.source);
		try {
			if (!this.isGranted(request.projectId, target.source)) return { outcome: extension("denied", "Grant required", started) };
			const raw = await this.invoke(target.hook, Object.freeze({
				event: "beforePrompt", sessionId: request.sessionId, projectId: request.projectId,
				cwd: this.cwd(request), prompt: request.text,
			}));
			const proposal = validateRequestMutationHookOutput(raw, "beforePrompt", request);
			if (!proposal) return { outcome: extension("dropped", "Unavailable", started) };
			// The closed validator binds proposal kind to its event; retain that
			// runtime assertion here so only prompt proposals reach this reducer.
			if (proposal.kind !== "prompt-shape") throw new RequestMutationContractError("INVALID_PROPOSAL_EVENT");
			if (!this.isGranted(request.projectId, target.source)) return { outcome: extension("denied", "Grant required", started) };
			return { candidate: { source: target.source, proposal }, outcome: extension("advised", "Prompt shaped", started), extensionEvent: "beforePrompt" };
		} catch (error) {
			return { outcome: extension(error instanceof RequestMutationContractError ? "dropped" : "error", error instanceof RequestMutationContractError ? "Malformed result" : isTimeout(error) ? "Timed out" : "Unavailable", started) };
		}
	}

	private async invokeToolExtension(target: ExtensionTarget, request: ToolSafetyRequest): Promise<CandidateResult<ToolSafetyCandidate>> {
		const started = Date.now();
		const extension = extensionOutcome(target.source);
		try {
			if (!this.isGranted(request.projectId, target.source)) return { outcome: extension("denied", "Grant required", started) };
			const raw = await this.invoke(target.hook, Object.freeze({
				event: "beforeToolCall", sessionId: request.sessionId, projectId: request.projectId,
				cwd: this.cwd(request), tool: Object.freeze({ name: request.toolName }),
			}));
			const proposal = validateRequestMutationHookOutput(raw, "beforeToolCall", request);
			if (!proposal) return { outcome: extension("dropped", "Unavailable", started) };
			// The closed validator binds proposal kind to its event; retain that
			// runtime assertion here so only tool proposals reach this reducer.
			if (proposal.kind !== "tool-safety") throw new RequestMutationContractError("INVALID_PROPOSAL_EVENT");
			if (!this.isGranted(request.projectId, target.source)) return { outcome: extension("denied", "Grant required", started) };
			return { candidate: { source: target.source, proposal }, outcome: extension("advised", proposal.decision === "deny" ? "Tool denied" : "Tool warning", started), extensionEvent: "beforeToolCall" };
		} catch (error) {
			return { outcome: extension(error instanceof RequestMutationContractError ? "dropped" : "error", error instanceof RequestMutationContractError ? "Malformed result" : isTimeout(error) ? "Timed out" : "Unavailable", started) };
		}
	}

	private async invokePromptCore(target: CoreTarget, request: PromptShapeRequest): Promise<CandidateResult<PromptShapeCandidate>> {
		const started = Date.now();
		const outcome = coreOutcome(target.shaper.id);
		try {
			const value = validatePromptShapeOutcome(await target.shaper.shapePrompt!(Object.freeze({ ...request })));
			if (!value) return { outcome: outcome("error", "Malformed result", started) };
			if (value.action === "pass") return { outcome: outcome("dropped", value.reason, started) };
			return {
				candidate: { source: target.source, proposal: { kind: "prompt-shape", version: 1, intent: "augment", text: value.text, reasonId: target.shaper.id } },
				outcome: outcome("advised", value.reason, started),
			};
		} catch { return { outcome: outcome("error", "Unavailable", started) }; }
	}

	private async invokeToolCore(target: CoreTarget, request: ToolSafetyRequest): Promise<CandidateResult<ToolSafetyCandidate>> {
		const started = Date.now();
		const outcome = coreOutcome(target.shaper.id);
		try {
			const value = validateToolSafetyOutcome(await target.shaper.inspectTool!(Object.freeze({ ...request })));
			if (!value) return { outcome: outcome("error", "Malformed result", started) };
			if (value.action === "pass") return { outcome: outcome("dropped", value.reason, started) };
			return {
				candidate: { source: target.source, proposal: { kind: "tool-safety", version: 1, decision: value.action, tool: request.toolName, reasonId: target.shaper.id } },
				outcome: outcome("advised", value.reason, started),
			};
		} catch { return { outcome: outcome("error", "Unavailable", started) }; }
	}

	private invoke(hook: HookContribution, ctx: Record<string, unknown> & { cwd: string }): Promise<unknown> {
		const url = pathToFileURL(path.resolve(path.dirname(hook.sourceFile), hook.module)).href;
		return this.deps.moduleHost.invoke({
			url, packRoot: hook.packRoot, epoch: 0, exportKind: "hooks", member: "decide",
			ctx, arg: undefined, workingDir: ctx.cwd,
		} as InvokeRequest<Record<string, unknown>>, hook.budget.timeoutMs);
	}

	private isGranted(projectId: string, source: RequestMutationSource): boolean {
		try {
			return resolveExtensionGrant(this.resolvedHooks(projectId), this.deps.grantsForProject(projectId), source, "mutate").allowed;
		} catch { return false; }
	}

	private resolvedHooks(projectId: string): ResolvedHook[] {
		return this.deps.registry.list(projectId).flatMap((pack, priority) => pack.hooks.map(hook => ({
			packId: pack.packId, hookId: hook.id, mode: hook.mode, capabilities: hook.capabilities, priority,
		})));
	}

	private cwd(request: PromptShapeRequest | ToolSafetyRequest): string {
		try { return this.deps.cwdForSession?.(request.sessionId, request.projectId) || process.cwd(); } catch { return process.cwd(); }
	}

	private markWinner(outcomes: RequestMutationOutcome[], source: RequestMutationSource | undefined, applied: boolean, winnerState: "applied" | "advised" | "denied"): RequestMutationOutcome[] {
		if (!source || !applied) return outcomes;
		const id = source.packId === "core" ? `core:${source.hookId}` : `extension:${source.packId}:${source.hookId}`;
		return outcomes.map(outcome => {
			if (outcome.source.id === id) return { ...outcome, outcome: winnerState };
			if (outcome.outcome === "advised") return { ...outcome, outcome: "superseded", reason: "Lower-priority proposal" };
			return outcome;
		});
	}
}

function safeCoreShaper(value: RequestShaper): boolean {
	return typeof value.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.id)
		&& typeof value.priority === "number" && Number.isFinite(value.priority);
}
function extensionOutcome(source: RequestMutationSource) {
	return (outcome: RequestMutationOutcome["outcome"], reason: RequestMutationReason, started: number): RequestMutationOutcome => ({
		source: { kind: "extension", id: `extension:${source.packId}:${source.hookId}`, packId: source.packId, hookId: source.hookId },
		outcome, reason, ms: Math.max(0, Date.now() - started),
	});
}
function coreOutcome(id: string) {
	return (outcome: RequestMutationOutcome["outcome"], reason: RequestMutationReason, started: number): RequestMutationOutcome => ({
		source: { kind: "core", id: `core:${id}` }, outcome, reason, ms: Math.max(0, Date.now() - started),
	});
}
function isTimeout(error: unknown): boolean {
	return error instanceof ActionError ? error.status === 504 : error instanceof Error && /timed out|timeout/i.test(error.message);
}
