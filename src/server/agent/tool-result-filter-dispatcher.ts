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
/** A core fixed code or a contract-validated extension identifier, never prose. */
export type ToolResultFilterReasonCode = string;

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
	reasonCode: string;
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
type Settled = { source: Source; candidate?: Candidate; outcome: ToolResultFilterDispatchOutcome };

/**
 * The one post-execution, pre-fan-out server decision seam. It receives a
 * canonical result but never records it: every observable outcome below is
 * identity, fixed code, action, and bounded timing only.
 */
export class ToolResultFilterDispatcher {
	constructor(private readonly deps: ToolResultFilterDispatcherDeps) {}

	hasEligibleFilters(projectId: string): boolean {
		try { return this.targets(projectId).some(target => this.isGranted(projectId, target.source)); } catch { return false; }
	}

	async filter(input: ToolResultInspection): Promise<ToolResultFilterResolution> {
		const eligible = this.targets(input.projectId).filter(target => this.isGranted(input.projectId, target.source));
		if (eligible.length === 0) return passResolution(input.result);

		const settled = await Promise.all(eligible.map(target => this.invoke(target, input)));
		const selected = new Set(eligible.map(target => sourceKey(target.source)));
		const fresh = this.targets(input.projectId).filter(target => this.isGranted(input.projectId, target.source));
		// A declaration added while this invocation was in flight has not inspected
		// this result, so it cannot turn an explicit revocation into a rejection.
		const live = new Set(fresh.map(target => sourceKey(target.source)).filter(key => selected.has(key)));
		const fenced = settled.map(item => {
			if (live.has(sourceKey(item.source))) return item;
			return {
				source: item.source,
				outcome: { ...item.outcome, outcome: "denied" as const, reasonCode: "filter-disabled-or-revoked" as const, ruleId: undefined },
			};
		});

		// Explicitly revoking/deactivating every selected filter turns the feature
		// off. This is the sole post-start pass-through exception.
		if (live.size === 0) return passResolution(input.result, fenced.map(item => item.outcome));

		const candidates = fenced.flatMap(item => item.candidate ? [item.candidate] : []);
		const reduction = reduceToolResultFilters(candidates);
		const winner = reduction.source && reduction.proposal ? { source: reduction.source, proposal: reduction.proposal } : undefined;
		if (!winner) {
			// An active filter failed to make a complete, validated decision. Never
			// fall open merely because its worker threw, timed out, or returned junk.
			return rejectedResolution(fenced.map(item => item.outcome), "filter-failed");
		}
		const outcomes = markWinner(fenced.map(item => item.outcome), winner);
		return selectedResolution(input.result, winner, outcomes);
	}

	private targets(projectId: string): Target[] {
		try {
			return this.deps.registry.list(projectId).flatMap((pack, priority) => pack.hooks
				.filter(hook => hook.mode === "decide"
					&& (hook.events as readonly string[]).includes("afterToolResult")
					&& (hook.capabilities as readonly string[]).includes("filter:tool-result"))
				.map(hook => ({ hook, source: { packId: pack.packId, hookId: hook.id, priority } }))
				.sort((a, b) => a.source.hookId.localeCompare(b.source.hookId) || a.hook.listName.localeCompare(b.hook.listName)),
			).slice(0, MAX_TOOL_RESULT_FILTER_HOOKS);
		} catch { return []; }
	}

	private async invoke(target: Target, input: ToolResultInspection): Promise<Settled> {
		const started = Date.now();
		const outcome = (state: ToolResultFilterOutcome, reasonCode: ToolResultFilterReasonCode, action: ToolResultFilterAction = "pass", ruleId?: string): ToolResultFilterDispatchOutcome => ({
			source: publicSource(target.source), action, outcome: state, reasonCode, ...(ruleId ? { ruleId } : {}), latencyMs: Math.max(0, Date.now() - started),
		});
		try {
			if (!this.isGranted(input.projectId, target.source)) return { source: target.source, outcome: outcome("denied", "filter-grant-required") };
			const raw = await this.deps.moduleHost.invoke({
				url: pathToFileURL(path.resolve(path.dirname(target.hook.sourceFile), target.hook.module)).href,
				packRoot: target.hook.packRoot, epoch: 0, exportKind: "hooks", member: "decide",
				ctx: Object.freeze({ event: "afterToolResult", sessionId: input.sessionId, projectId: input.projectId, toolCallId: input.toolCallId, toolName: input.toolName, result: input.result }),
				arg: undefined, workingDir: this.cwd(input),
			} as InvokeRequest<Record<string, unknown>>, target.hook.budget.timeoutMs);
			const proposal = validateToolResultFilterProposal(raw);
			if (!proposal) throw new ToolResultFilterContractError("MISSING_PROPOSAL");
			if (!this.isGranted(input.projectId, target.source)) return { source: target.source, outcome: outcome("denied", "filter-grant-required") };
			return {
				source: target.source,
				candidate: { source: target.source, proposal },
				outcome: outcome("applied", proposal.action === "pass" ? "filter-passed" : "filter-lower-priority", proposal.action, proposal.ruleId),
			};
		} catch (error) {
			return {
				source: target.source,
				outcome: outcome(error instanceof ToolResultFilterContractError ? "dropped" : "error", error instanceof ToolResultFilterContractError ? "filter-malformed" : isTimeout(error) ? "filter-timed-out" : "filter-unavailable"),
			};
		}
	}

	private isGranted(projectId: string, source: Source): boolean {
		try {
			return resolveExtensionGrant(this.resolvedHooks(projectId), this.deps.grantsForProject(projectId), source, "filter:tool-result" as ExtensionGrant["capability"]).allowed;
		} catch { return false; }
	}

	private resolvedHooks(projectId: string): ResolvedHook[] {
		return this.deps.registry.list(projectId).flatMap((pack, priority) => pack.hooks.map(hook => ({
			packId: pack.packId, hookId: hook.id, mode: hook.mode, events: hook.events, capabilities: hook.capabilities, priority,
		})));
	}

	private cwd(input: ToolResultInspection): string {
		try { return this.deps.cwdForSession?.(input.sessionId, input.projectId) || process.cwd(); } catch { return process.cwd(); }
	}
}

function markWinner(outcomes: ToolResultFilterDispatchOutcome[], winner: Candidate): ToolResultFilterDispatchOutcome[] {
	const key = sourceKey(winner.source);
	return outcomes.map(outcome => {
		if (outcome.source.id === key) {
			// This is the only selected extension decision. Preserve its validated
			// rule/reason identity rather than the provisional lower-priority label.
			return {
				...outcome,
				outcome: "applied",
				reasonCode: winner.proposal.reasonCode,
			};
		}
		if (outcome.outcome === "applied") return { ...outcome, outcome: "superseded", reasonCode: "filter-lower-priority" };
		return outcome;
	});
}

function selectedResolution(original: Readonly<CanonicalToolResult>, winner: Candidate, outcomes: ToolResultFilterDispatchOutcome[]): ToolResultFilterResolution {
	const { proposal } = winner;
	if (proposal.action === "reject") return rejectedResolution(outcomes, proposal.reasonCode, proposal.ruleId, winner.source);
	const result = applyToolResultFilterReduction(original, { action: proposal.action, source: winner.source, proposal });
	return Object.freeze({
		result, action: proposal.action, reasonCode: proposal.reasonCode, ruleId: proposal.ruleId,
		source: publicSource(winner.source), outcomes: Object.freeze(outcomes),
	});
}

function passResolution(result: Readonly<CanonicalToolResult>, outcomes: ToolResultFilterDispatchOutcome[] = []): ToolResultFilterResolution {
	return Object.freeze({ result, action: "pass", reasonCode: "no-filter", outcomes: Object.freeze(outcomes) });
}

function rejectedResolution(outcomes: ToolResultFilterDispatchOutcome[], reasonCode: string, ruleId?: string, source?: Source): ToolResultFilterResolution {
	const result = createSyntheticRejectedToolResult(randomUUID());
	return Object.freeze({ result, action: "reject", reasonCode, ...(ruleId ? { ruleId } : {}), ...(source ? { source: publicSource(source) } : {}), outcomes: Object.freeze(outcomes) });
}

function sourceKey(source: Source): string { return `extension:${source.packId}:${source.hookId}`; }
function publicSource(source: Source): { id: string; packId: string; hookId: string } { return { id: sourceKey(source), packId: source.packId, hookId: source.hookId }; }
function isTimeout(error: unknown): boolean { return error instanceof ActionError ? error.status === 504 : error instanceof Error && /timed out|timeout/i.test(error.message); }
