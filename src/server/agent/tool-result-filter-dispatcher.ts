import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ActionError } from "../extension-host/action-dispatcher.js";
import { ModuleHostAbortError, type InvokeRequest, type ModuleHost } from "../extension-host/module-host-worker.js";
import type { PackContributionRegistry } from "../extension-host/pack-contribution-registry.js";
import type { HookContribution } from "./pack-contributions.js";
import type { ExtensionGrant } from "./project-config-store.js";
import { resolveExtensionGrant, type ResolvedHook } from "./extension-grant-policy.js";
import { type ToolResultFilterReasonCode } from "./tool-result-filter-reason-codes.js";
import {
	MAX_TOOL_RESULT_FILTER_HOOKS,
	ToolResultFilterContractError,
	applyToolResultFilterReduction,
	createSyntheticRejectedToolResult,
	reduceToolResultFilters,
	validateToolResultFilterProposal,
	type CanonicalToolResult,
	type ToolResultFilterAction,
	type ToolResultInspection,
	type ToolResultFilterProposal,
} from "./tool-result-filter-contract.js";

export type ToolResultFilterOutcome = "applied" | "denied" | "dropped" | "error" | "superseded";
/** These are core constants; a worker cannot select a persisted reason. */
export type { ToolResultFilterReasonCode } from "./tool-result-filter-reason-codes.js";

/** Outcome metadata is deliberately result-free and safe for audit/trace callers. */
export interface ToolResultFilterDispatchOutcome {
	source: { id: string; packId: string; hookId: string };
	action: ToolResultFilterAction;
	outcome: ToolResultFilterOutcome;
	reasonCode: ToolResultFilterReasonCode;
	ruleId?: string;
	latencyMs: number;
}

export interface ToolResultFilterResolution {
	result: Readonly<CanonicalToolResult>;
	action: ToolResultFilterAction;
	reasonCode: ToolResultFilterReasonCode;
	ruleId?: string;
	source?: { packId: string; hookId: string };
	outcomes: readonly ToolResultFilterDispatchOutcome[];
}

/** The server owns the shared worker budget; extension code never queues raw results. */
export const MAX_TOOL_RESULT_FILTER_GLOBAL_WORKERS = 64;
/** A bounded per-session call cap supports ordinary parallel tool batches. */
export const MAX_TOOL_RESULT_FILTER_SESSION_CALLS = 64;

/**
 * Synchronous admission gives a whole eligible worker set or none of it. It is
 * intentionally not a queue: waiting would retain a protected result beyond
 * the Pi gate deadline and make a later partial reduction possible.
 */
export class ToolResultFilterAdmission {
	private workers = 0;
	private readonly calls = new Map<string, number>();
	constructor(
		private readonly maxWorkers = MAX_TOOL_RESULT_FILTER_GLOBAL_WORKERS,
		private readonly maxSessionCalls = MAX_TOOL_RESULT_FILTER_SESSION_CALLS,
	) {}

	acquire(sessionId: string, workerCount: number): boolean {
		if (!Number.isSafeInteger(workerCount) || workerCount < 1 || workerCount > this.maxWorkers) return false;
		const sessionCalls = this.calls.get(sessionId) ?? 0;
		if (sessionCalls >= this.maxSessionCalls || this.workers + workerCount > this.maxWorkers) return false;
		this.workers += workerCount;
		this.calls.set(sessionId, sessionCalls + 1);
		return true;
	}

	release(sessionId: string, workerCount: number): void {
		this.workers = Math.max(0, this.workers - workerCount);
		const sessionCalls = this.calls.get(sessionId) ?? 0;
		if (sessionCalls <= 1) this.calls.delete(sessionId);
		else this.calls.set(sessionId, sessionCalls - 1);
	}
}

const globalAdmission = new ToolResultFilterAdmission();

export interface ToolResultFilterDispatcherDeps {
	registry: PackContributionRegistry;
	moduleHost: ModuleHost;
	grantsForProject(projectId: string): readonly ExtensionGrant[];
	/** Server-derived session cwd, never extension- or tool-result-provided. */
	cwdForSession?: (sessionId: string, projectId: string) => string;
	/** Test injection only; production dispatchers share the core-owned admission. */
	admission?: ToolResultFilterAdmission;
}

type Source = { packId: string; hookId: string; priority: number };
type Target = { hook: HookContribution; source: Source };
type Candidate = { source: Source; proposal: ToolResultFilterProposal };
type Settled = { source: Source; candidate?: Candidate; outcome: ToolResultFilterDispatchOutcome; authorityFailure?: true };
type AuthoritySnapshot = { targets: readonly Target[]; eligible: readonly Target[] };

/** Keep worker execution comfortably below the generated gate's 2.5 second deadline. */
export const MAX_TOOL_RESULT_FILTER_WORKER_TIMEOUT_MS = 2_000;

/**
 * The one post-execution, pre-fan-out server decision seam. It receives a
 * canonical result but never records it: every observable outcome below is
 * identity, fixed code, action, and bounded timing only.
 */
export class ToolResultFilterDispatcher {
	constructor(private readonly deps: ToolResultFilterDispatcherDeps) {}

	/** Setup must not silently launch a raw session when authority is unavailable. */
	hasEligibleFilters(projectId: string): boolean {
		return this.authoritySnapshot(projectId).eligible.length > 0;
	}

	async filter(input: ToolResultInspection, signal?: AbortSignal): Promise<ToolResultFilterResolution> {
		if (signal?.aborted) return rejectedResolution([], "filter-aborted");
		let initial: AuthoritySnapshot;
		try {
			initial = this.authoritySnapshot(input.projectId);
		} catch {
			return rejectedResolution([], "filter-authority-unavailable");
		}
		if (signal?.aborted) return rejectedResolution([], "filter-aborted");
		if (initial.eligible.length === 0) return passResolution(input.result);

		const admission = this.deps.admission ?? globalAdmission;
		const workerCount = initial.eligible.length;
		if (!admission.acquire(input.sessionId, workerCount)) return rejectedResolution([], "filter-admission-rejected");
		try {
			if (signal?.aborted) return rejectedResolution([], "filter-aborted");
			const settled = await Promise.all(initial.eligible.map(target => this.invoke(target, input, signal)));
			if (signal?.aborted) return rejectedResolution(settled.map(item => item.outcome), "filter-aborted");
			const initialOutcomes = settled.map(item => item.outcome);
			if (settled.some(item => item.authorityFailure)) return rejectedResolution(initialOutcomes, "filter-authority-unavailable");

			let final: AuthoritySnapshot;
			try {
				final = this.authoritySnapshot(input.projectId);
			} catch {
				return rejectedResolution(initialOutcomes, "filter-authority-unavailable");
			}
			if (signal?.aborted) return rejectedResolution(initialOutcomes, "filter-aborted");
			// An authority change cannot be reduced against a partial stale worker set.
			// The exact ordered identity includes priority, so an order change is also
			// fail-closed: it could change which proposal wins. Explicitly disabling all
			// filters remains the one intentional raw pass-through path.
			if (final.eligible.length === 0) {
				const revoked = settled.map(item => ({
					source: item.source,
					outcome: { ...item.outcome, outcome: "denied" as const, reasonCode: "filter-disabled-or-revoked" as const, ruleId: undefined },
				}));
				return passResolution(input.result, revoked.map(item => item.outcome));
			}
			if (!sameEligibleAuthorities(initial.eligible, final.eligible)) {
				return rejectedResolution(initialOutcomes, "filter-authority-changed");
			}
			const candidates = settled.flatMap(item => item.candidate ? [item.candidate] : []);
			const reduction = reduceToolResultFilters(candidates);
			const winner = reduction.source && reduction.proposal ? { source: reduction.source, proposal: reduction.proposal } : undefined;
			if (!winner) return rejectedResolution(initialOutcomes, "filter-unavailable");
			return selectedResolution(input.result, winner, markWinner(initialOutcomes, winner));
		} finally {
			admission.release(input.sessionId, workerCount);
		}
	}

	private authoritySnapshot(projectId: string): AuthoritySnapshot {
		const packs = this.deps.registry.list(projectId);
		const targets = packs.flatMap((pack, priority) => pack.hooks
			.filter(hook => hook.mode === "decide"
				&& (hook.events as readonly string[]).includes("afterToolResult")
				&& (hook.capabilities as readonly string[]).includes("filter:tool-result"))
			.map(hook => ({ hook, source: { packId: pack.packId, hookId: hook.id, priority } }))
			.sort((a, b) => a.source.hookId.localeCompare(b.source.hookId) || a.hook.listName.localeCompare(b.hook.listName)),
		).slice(0, MAX_TOOL_RESULT_FILTER_HOOKS);
		const hooks: ResolvedHook[] = packs.flatMap((pack, priority) => pack.hooks.map(hook => ({
			packId: pack.packId, hookId: hook.id, mode: hook.mode, events: hook.events, capabilities: hook.capabilities, priority,
		})));
		const grants = this.deps.grantsForProject(projectId);
		const eligible = targets.filter(target => resolveExtensionGrant(hooks, grants, target.source, "filter:tool-result" as ExtensionGrant["capability"]).allowed);
		return { targets, eligible };
	}

	private async invoke(target: Target, input: ToolResultInspection, signal?: AbortSignal): Promise<Settled> {
		const started = Date.now();
		const outcome = (state: ToolResultFilterOutcome, reasonCode: ToolResultFilterReasonCode, action: ToolResultFilterAction = "pass", ruleId?: string): ToolResultFilterDispatchOutcome => ({
			source: publicSource(target.source), action, outcome: state, reasonCode, ...(ruleId ? { ruleId } : {}), latencyMs: Math.max(0, Date.now() - started),
		});
		try {
			if (signal?.aborted) return { source: target.source, outcome: outcome("denied", "filter-aborted") };
			let granted: boolean;
			try { granted = this.isGranted(input.projectId, target.source); } catch {
				return { source: target.source, authorityFailure: true, outcome: outcome("error", "filter-authority-unavailable") };
			}
			if (!granted) return { source: target.source, outcome: outcome("denied", "filter-grant-required") };
			if (signal?.aborted) return { source: target.source, outcome: outcome("denied", "filter-aborted") };
			const raw = await this.deps.moduleHost.invoke({
				url: pathToFileURL(path.resolve(path.dirname(target.hook.sourceFile), target.hook.module)).href,
				packRoot: target.hook.packRoot, epoch: 0, exportKind: "result-filters", member: "decide",
				ctx: Object.freeze({ event: "afterToolResult", sessionId: input.sessionId, projectId: input.projectId, toolCallId: input.toolCallId, toolName: input.toolName, result: input.result }),
				arg: undefined, workingDir: this.cwd(input),
			} as InvokeRequest<Record<string, unknown>>, workerTimeout(target.hook.budget.timeoutMs), signal);
			if (signal?.aborted) return { source: target.source, outcome: outcome("denied", "filter-aborted") };
			const proposal = validateToolResultFilterProposal(raw);
			if (proposal.ruleId !== target.source.hookId) throw new ToolResultFilterContractError("INVALID_PROPOSAL_IDENTITY");
			try { granted = this.isGranted(input.projectId, target.source); } catch {
				return { source: target.source, authorityFailure: true, outcome: outcome("error", "filter-authority-unavailable") };
			}
			if (!granted) return { source: target.source, outcome: outcome("denied", "filter-grant-required") };
			if (signal?.aborted) return { source: target.source, outcome: outcome("denied", "filter-aborted") };
			return { source: target.source, candidate: { source: target.source, proposal }, outcome: outcome("applied", reasonForAction(proposal.action), proposal.action, target.source.hookId) };
		} catch (error) {
			return {
				source: target.source,
				outcome: outcome(signal?.aborted ? "denied" : error instanceof ToolResultFilterContractError ? "dropped" : "error", signal?.aborted ? "filter-aborted" : error instanceof ToolResultFilterContractError ? "filter-malformed" : isTimeout(error) ? "filter-timed-out" : "filter-unavailable"),
			};
		}
	}

	private isGranted(projectId: string, source: Source): boolean {
		return this.authoritySnapshot(projectId).eligible.some(target => sourceKey(target.source) === sourceKey(source));
	}

	private cwd(input: ToolResultInspection): string {
		try { return this.deps.cwdForSession?.(input.sessionId, input.projectId) || process.cwd(); } catch { return process.cwd(); }
	}
}

function workerTimeout(timeoutMs: number): number { return Math.min(MAX_TOOL_RESULT_FILTER_WORKER_TIMEOUT_MS, Math.max(1, Number.isFinite(timeoutMs) ? Math.floor(timeoutMs) : 1)); }
function reasonForAction(action: ToolResultFilterAction): ToolResultFilterReasonCode { return action === "pass" ? "filter-passed" : action === "replace" ? "filter-replaced" : action === "redact" ? "filter-redacted" : "filter-rejected"; }
function markWinner(outcomes: ToolResultFilterDispatchOutcome[], winner: Candidate): ToolResultFilterDispatchOutcome[] {
	const key = sourceKey(winner.source);
	return outcomes.map(outcome => outcome.source.id === key
		? { ...outcome, outcome: "applied", reasonCode: reasonForAction(winner.proposal.action), ruleId: winner.source.hookId }
		: outcome.outcome === "applied" ? { ...outcome, outcome: "superseded", reasonCode: "filter-lower-priority", ruleId: undefined } : outcome);
}
function selectedResolution(original: Readonly<CanonicalToolResult>, winner: Candidate, outcomes: ToolResultFilterDispatchOutcome[]): ToolResultFilterResolution {
	const { proposal } = winner;
	if (proposal.action === "reject") return rejectedResolution(outcomes, "filter-rejected", winner.source.hookId, winner.source);
	const result = applyToolResultFilterReduction(original, { action: proposal.action, source: winner.source, proposal });
	return Object.freeze({ result, action: proposal.action, reasonCode: reasonForAction(proposal.action), ruleId: winner.source.hookId, source: publicSource(winner.source), outcomes: Object.freeze(outcomes) });
}
function passResolution(result: Readonly<CanonicalToolResult>, outcomes: ToolResultFilterDispatchOutcome[] = []): ToolResultFilterResolution { return Object.freeze({ result, action: "pass", reasonCode: "no-filter", outcomes: Object.freeze(outcomes) }); }
function rejectedResolution(outcomes: ToolResultFilterDispatchOutcome[], reasonCode: ToolResultFilterReasonCode, ruleId?: string, source?: Source): ToolResultFilterResolution {
	return Object.freeze({ result: createSyntheticRejectedToolResult(randomUUID()), action: "reject", reasonCode, ...(ruleId ? { ruleId } : {}), ...(source ? { source: publicSource(source) } : {}), outcomes: Object.freeze(outcomes) });
}
function sourceKey(source: Source): string { return `extension:${source.packId}:${source.hookId}`; }
/** Ordered identity protects reducer priority as well as the pack/hook principal. */
function authorityKey(source: Source): string { return `${sourceKey(source)}:${source.priority}`; }
function sameEligibleAuthorities(initial: readonly Target[], final: readonly Target[]): boolean {
	return initial.length === final.length && initial.every((target, index) => authorityKey(target.source) === authorityKey(final[index].source));
}
function publicSource(source: Source): { id: string; packId: string; hookId: string } { return { id: sourceKey(source), packId: source.packId, hookId: source.hookId }; }
function isTimeout(error: unknown): boolean { return error instanceof ModuleHostAbortError || error instanceof ActionError ? error.status === 504 : error instanceof Error && /timed out|timeout/i.test(error.message); }
