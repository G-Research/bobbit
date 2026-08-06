import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ActionError } from "../extension-host/action-dispatcher.js";
import type { InvokeRequest, ModuleHost } from "../extension-host/module-host-worker.js";
import type { PackContributionRegistry } from "../extension-host/pack-contribution-registry.js";
import type { HookContribution } from "./pack-contributions.js";
import type { ExtensionGrant } from "./project-config-store.js";
import { resolveExtensionGrant, type ResolvedHook } from "./extension-grant-policy.js";
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
export type ToolResultFilterReasonCode =
	| "no-filter"
	| "filter-passed"
	| "filter-replaced"
	| "filter-redacted"
	| "filter-rejected"
	| "filter-lower-priority"
	| "filter-grant-required"
	| "filter-disabled-or-revoked"
	| "filter-malformed"
	| "filter-timed-out"
	| "filter-unavailable"
	| "filter-authority-unavailable";

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

export interface ToolResultFilterDispatcherDeps {
	registry: PackContributionRegistry;
	moduleHost: ModuleHost;
	grantsForProject(projectId: string): readonly ExtensionGrant[];
	/** Server-derived session cwd, never extension- or tool-result-provided. */
	cwdForSession?: (sessionId: string, projectId: string) => string;
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

	/**
	 * Setup must distinguish "feature is off" from unavailable authority. Let an
	 * authority read exception escape so activation cannot silently launch raw.
	 */
	hasEligibleFilters(projectId: string): boolean {
		return this.authoritySnapshot(projectId).eligible.length > 0;
	}

	async filter(input: ToolResultInspection): Promise<ToolResultFilterResolution> {
		let initial: AuthoritySnapshot;
		try {
			initial = this.authoritySnapshot(input.projectId);
		} catch {
			return rejectedResolution([], "filter-authority-unavailable");
		}
		if (initial.eligible.length === 0) return passResolution(input.result);

		const settled = await Promise.all(initial.eligible.map(target => this.invoke(target, input)));
		const initialOutcomes = settled.map(item => item.outcome);
		// A failed authority read is not a successful revocation. It must fail
		// closed even if a later snapshot happens to find no active hooks.
		if (settled.some(item => item.authorityFailure)) {
			return rejectedResolution(initialOutcomes, "filter-authority-unavailable");
		}

		let final: AuthoritySnapshot;
		try {
			final = this.authoritySnapshot(input.projectId);
		} catch {
			return rejectedResolution(initialOutcomes, "filter-authority-unavailable");
		}
		const selected = new Set(initial.eligible.map(target => sourceKey(target.source)));
		// A declaration added while this invocation was in flight has not inspected
		// this result, so it cannot turn an explicit revocation into a rejection.
		const live = new Set(final.eligible.map(target => sourceKey(target.source)).filter(key => selected.has(key)));
		const fenced = settled.map(item => {
			if (live.has(sourceKey(item.source))) return item;
			return {
				source: item.source,
				outcome: { ...item.outcome, outcome: "denied" as const, reasonCode: "filter-disabled-or-revoked" as const, ruleId: undefined },
			};
		});

		// This is the sole post-start pass-through exception: a successful final
		// authority read has proven every originally selected hook was revoked.
		if (live.size === 0) return passResolution(input.result, fenced.map(item => item.outcome));

		const candidates = fenced.flatMap(item => item.candidate ? [item.candidate] : []);
		const reduction = reduceToolResultFilters(candidates);
		const winner = reduction.source && reduction.proposal ? { source: reduction.source, proposal: reduction.proposal } : undefined;
		if (!winner) {
			// An active filter failed to make a complete, validated decision. Never
			// fall open merely because its worker threw, timed out, or returned junk.
			return rejectedResolution(fenced.map(item => item.outcome), "filter-unavailable");
		}
		const outcomes = markWinner(fenced.map(item => item.outcome), winner);
		return selectedResolution(input.result, winner, outcomes);
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

	private async invoke(target: Target, input: ToolResultInspection): Promise<Settled> {
		const started = Date.now();
		const outcome = (state: ToolResultFilterOutcome, reasonCode: ToolResultFilterReasonCode, action: ToolResultFilterAction = "pass", ruleId?: string): ToolResultFilterDispatchOutcome => ({
			source: publicSource(target.source), action, outcome: state, reasonCode, ...(ruleId ? { ruleId } : {}), latencyMs: Math.max(0, Date.now() - started),
		});
		try {
			let granted: boolean;
			try { granted = this.isGranted(input.projectId, target.source); } catch {
				return { source: target.source, authorityFailure: true, outcome: outcome("error", "filter-authority-unavailable") };
			}
			if (!granted) return { source: target.source, outcome: outcome("denied", "filter-grant-required") };
			const raw = await this.deps.moduleHost.invoke({
				url: pathToFileURL(path.resolve(path.dirname(target.hook.sourceFile), target.hook.module)).href,
				packRoot: target.hook.packRoot, epoch: 0, exportKind: "hooks", member: "decide",
				ctx: Object.freeze({ event: "afterToolResult", sessionId: input.sessionId, projectId: input.projectId, toolCallId: input.toolCallId, toolName: input.toolName, result: input.result }),
				arg: undefined, workingDir: this.cwd(input),
			} as InvokeRequest<Record<string, unknown>>, workerTimeout(target.hook.budget.timeoutMs));
			const proposal = validateToolResultFilterProposal(raw);
			// Worker identifiers are not observability authority. A response may only
			// claim the hook identity that core selected from the registry.
			if (proposal.ruleId !== target.source.hookId) throw new ToolResultFilterContractError("INVALID_PROPOSAL_IDENTITY");
			try { granted = this.isGranted(input.projectId, target.source); } catch {
				return { source: target.source, authorityFailure: true, outcome: outcome("error", "filter-authority-unavailable") };
			}
			if (!granted) return { source: target.source, outcome: outcome("denied", "filter-grant-required") };
			return {
				source: target.source,
				candidate: { source: target.source, proposal },
				outcome: outcome("applied", reasonForAction(proposal.action), proposal.action, target.source.hookId),
			};
		} catch (error) {
			return {
				source: target.source,
				outcome: outcome(error instanceof ToolResultFilterContractError ? "dropped" : "error", error instanceof ToolResultFilterContractError ? "filter-malformed" : isTimeout(error) ? "filter-timed-out" : "filter-unavailable"),
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

function workerTimeout(timeoutMs: number): number {
	return Math.min(MAX_TOOL_RESULT_FILTER_WORKER_TIMEOUT_MS, Math.max(1, Number.isFinite(timeoutMs) ? Math.floor(timeoutMs) : 1));
}
function reasonForAction(action: ToolResultFilterAction): ToolResultFilterReasonCode {
	return action === "pass" ? "filter-passed"
		: action === "replace" ? "filter-replaced"
			: action === "redact" ? "filter-redacted" : "filter-rejected";
}
function markWinner(outcomes: ToolResultFilterDispatchOutcome[], winner: Candidate): ToolResultFilterDispatchOutcome[] {
	const key = sourceKey(winner.source);
	return outcomes.map(outcome => {
		if (outcome.source.id === key) {
			return { ...outcome, outcome: "applied", reasonCode: reasonForAction(winner.proposal.action), ruleId: winner.source.hookId };
		}
		if (outcome.outcome === "applied") return { ...outcome, outcome: "superseded", reasonCode: "filter-lower-priority", ruleId: undefined };
		return outcome;
	});
}

function selectedResolution(original: Readonly<CanonicalToolResult>, winner: Candidate, outcomes: ToolResultFilterDispatchOutcome[]): ToolResultFilterResolution {
	const { proposal } = winner;
	if (proposal.action === "reject") return rejectedResolution(outcomes, "filter-rejected", winner.source.hookId, winner.source);
	const result = applyToolResultFilterReduction(original, { action: proposal.action, source: winner.source, proposal });
	return Object.freeze({
		result, action: proposal.action, reasonCode: reasonForAction(proposal.action), ruleId: winner.source.hookId,
		source: publicSource(winner.source), outcomes: Object.freeze(outcomes),
	});
}

function passResolution(result: Readonly<CanonicalToolResult>, outcomes: ToolResultFilterDispatchOutcome[] = []): ToolResultFilterResolution {
	return Object.freeze({ result, action: "pass", reasonCode: "no-filter", outcomes: Object.freeze(outcomes) });
}
function rejectedResolution(outcomes: ToolResultFilterDispatchOutcome[], reasonCode: ToolResultFilterReasonCode, ruleId?: string, source?: Source): ToolResultFilterResolution {
	const result = createSyntheticRejectedToolResult(randomUUID());
	return Object.freeze({ result, action: "reject", reasonCode, ...(ruleId ? { ruleId } : {}), ...(source ? { source: publicSource(source) } : {}), outcomes: Object.freeze(outcomes) });
}
function sourceKey(source: Source): string { return `extension:${source.packId}:${source.hookId}`; }
function publicSource(source: Source): { id: string; packId: string; hookId: string } { return { id: sourceKey(source), packId: source.packId, hookId: source.hookId }; }
function isTimeout(error: unknown): boolean { return error instanceof ActionError ? error.status === 504 : error instanceof Error && /timed out|timeout/i.test(error.message); }
