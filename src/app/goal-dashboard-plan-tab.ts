// Plan-tab render path extracted from goal-dashboard.ts (Task C).
// Public API: renderPlanTab + computePlanStepsForGoal (re-exported for the
// tab-bar badge in goal-dashboard.ts). Behaviour preservation: same Lit
// output for the same inputs.

import { html, nothing, svg, type TemplateResult } from "lit";
import { setHashRoute } from "./routing.js";
import { state, renderApp, type Goal, type GoalState } from "./state.js";

/**
 * Goal states considered "terminal" for the live-only Plan filter.
 * A child is "live" iff it is NOT archived AND its `state` is not in
 * this set — i.e. only todo / in-progress / blocked remain. Centralised
 * here so the filter site below and the data helper below share the
 * exact same rule, and so the test fixture can pin it.
 */
const PLAN_TERMINAL_STATES: ReadonlySet<GoalState> = new Set<GoalState>(["complete", "shelved"]);

function _isLiveChild(g: { state?: string | null; archived?: boolean | null }): boolean {
	if (g.archived) return false;
	return !PLAN_TERMINAL_STATES.has((g.state ?? "todo") as GoalState);
}
import { buildPlanSteps, type PlanStep, type SynthesisGoal, type FormalPlanStep } from "./plan-synthesis.js";
import { resolvePlanNodeChild, type PlanNodeChild, type PlanNodeState, type PlanNodeGateStatus } from "./plan-node-state.js";
import { computeEdgePaths, type PlanEdgeNode, type PlanEdge } from "./plan-edge-paths.js";

const svgPlan = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h18"/></svg>`;

/**
 * Plan-tab nested expansion state keyed by `goalId`. Default is **expanded**;
 * the set tracks goals the user explicitly COLLAPSED (inverse-state) so
 * default rendering recurses without extra clicks.
 */
const _planCollapsedGoals: Set<string> = new Set();

function _isPlanExpanded(goalId: string): boolean {
	return !_planCollapsedGoals.has(goalId);
}

function _togglePlanExpanded(goalId: string): void {
	if (_planCollapsedGoals.has(goalId)) _planCollapsedGoals.delete(goalId);
	else _planCollapsedGoals.add(goalId);
	renderApp();
}

/**
 * Plan-tab live-only filter state, keyed by the goalId whose Plan tab is
 * being viewed. Default is **show all** (including archived/completed
 * children); the set tracks goals the user explicitly toggled to
 * live-only. Defaults that hide data are the root cause of regressions
 * where archived siblings vanish from the plan.
 */
const _planLiveOnlyGoals: Set<string> = new Set();

function _isPlanLiveOnly(goalId: string): boolean {
	return _planLiveOnlyGoals.has(goalId);
}

function _togglePlanLiveOnly(goalId: string): void {
	if (_planLiveOnlyGoals.has(goalId)) _planLiveOnlyGoals.delete(goalId);
	else _planLiveOnlyGoals.add(goalId);
	renderApp();
}

interface PlanLayoutNode extends PlanEdgeNode {
	step: PlanStep;
	state: PlanNodeState;
	childGoal?: Goal;
	/** Resolved child's gate status (Phase 5c) — orthogonal to `state`. */
	gateStatus?: PlanNodeGateStatus;
	/** Resolved child hit a merge conflict preserved for manual recovery. */
	mergeConflict?: boolean;
}

const PLAN_NODE_W = 200;
const PLAN_NODE_H = 64;
const PLAN_PHASE_GAP = 56; // horizontal gap between phases
const PLAN_NODE_GAP_Y = 16; // vertical gap within phase
const PLAN_PADDING = 16;
const PLAN_RENDER_DEPTH_CAP = 3;

/** Compute the node + edge layout for a single plan (one goal's plan). */
function layoutPlanLevel(steps: PlanStep[], allGoals: Goal[], yOffset: number, parentGoalId: string, liveOnly: boolean): {
	nodes: PlanLayoutNode[];
	edges: PlanEdge[];
	width: number;
	height: number;
} {
	if (steps.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };
	const phaseMap = new Map<number, PlanStep[]>();
	for (const s of steps) {
		const list = phaseMap.get(s.phase);
		if (list) list.push(s); else phaseMap.set(s.phase, [s]);
	}
	const phases = Array.from(phaseMap.keys()).sort((a, b) => a - b);
	// Scope candidates to THIS goal's direct children; otherwise opening
	// "See Archived" pollutes the resolver with unrelated archived siblings.
	const candidates: PlanNodeChild[] = allGoals
		// pinned by tests/plan-archived-children.test.ts::computePlanStepsForGoal liveOnly filter
		// liveOnly EXCLUDES archived AND terminal-state (complete/shelved) children — only
		// in-progress / todo / blocked remain. See PLAN_TERMINAL_STATES.
		.filter(g => g.parentGoalId === parentGoalId && (!liveOnly || _isLiveChild(g)))
		.map(g => ({
			id: g.id,
			parentGoalId: g.parentGoalId,
			spawnedFromPlanId: g.spawnedFromPlanId,
			state: g.state as any,
			archived: !!g.archived,
			paused: !!g.paused,
			createdAt: g.createdAt,
			mergeConflict: !!(g as any).mergeConflict,
			gateStatus: (g as any).gateStatus as PlanNodeGateStatus | undefined,
		}));
	const nodes: PlanLayoutNode[] = [];
	let maxColH = 0;
	const nodeIdByPlanId = new Map<string, string>();
	for (let pi = 0; pi < phases.length; pi++) {
		const phase = phases[pi];
		const x = PLAN_PADDING + pi * (PLAN_NODE_W + PLAN_PHASE_GAP);
		const stepsInPhase = phaseMap.get(phase)!;
		stepsInPhase.forEach((s, i) => {
			const y = yOffset + PLAN_PADDING + i * (PLAN_NODE_H + PLAN_NODE_GAP_Y);
			const resolution = resolvePlanNodeChild(s.planId, candidates);
			const childGoal = resolution.child ? allGoals.find(g => g.id === resolution.child!.id) : undefined;
			const nodeId = `${s.planId}::${pi}::${i}`;
			const node: PlanLayoutNode = {
				id: nodeId,
				step: s,
				state: resolution.state,
				childGoal,
				gateStatus: resolution.child?.gateStatus,
				mergeConflict: !!resolution.child?.mergeConflict,
				x,
				y,
				width: PLAN_NODE_W,
				height: PLAN_NODE_H,
			};
			nodes.push(node);
			nodeIdByPlanId.set(s.planId, nodeId);
		});
		const colH = stepsInPhase.length * (PLAN_NODE_H + PLAN_NODE_GAP_Y);
		if (colH > maxColH) maxColH = colH;
	}
	// Edges: explicit dependsOn references only; unknown refs silently skipped.
	const edges: PlanEdge[] = [];
	for (const s of steps) {
		const toId = nodeIdByPlanId.get(s.planId);
		if (!toId) continue;
		for (const dep of s.dependsOn ?? []) {
			const fromId = nodeIdByPlanId.get(dep);
			if (!fromId) continue;
			edges.push({ fromNodeId: fromId, toNodeId: toId });
		}
	}
	const width = phases.length * PLAN_NODE_W + (phases.length - 1) * PLAN_PHASE_GAP + 2 * PLAN_PADDING;
	const height = yOffset + maxColH + 2 * PLAN_PADDING;
	return { nodes, edges, width, height };
}

function planNodeFillColor(s: PlanNodeState): string {
	switch (s) {
		case "complete": return "rgba(34, 197, 94, 0.10)";
		case "in-progress": return "rgba(59, 130, 246, 0.12)";
		case "failed": return "rgba(239, 68, 68, 0.12)";
		case "paused": return "rgba(234, 179, 8, 0.14)";
		default: return "rgba(120, 120, 120, 0.06)";
	}
}

function planNodeBorderColor(s: PlanNodeState): string {
	switch (s) {
		case "complete": return "#22c55e";
		case "in-progress": return "#3b82f6";
		case "failed": return "#ef4444";
		case "paused": return "#eab308";
		default: return "var(--border)";
	}
}

/**
 * Gate-status dot colour — design-system semantic tokens only (no
 * hardcoded hex). Orthogonal to the tier-based node fill/border above:
 * the dot reflects the resolved child's workflow-gate progress.
 */
function planGateStatusColor(s: PlanNodeGateStatus): string {
	switch (s) {
		case "passed": return "var(--positive)";
		case "failed": return "var(--negative)";
		case "running": return "var(--info)";
		default: return "var(--muted-foreground)"; // pending
	}
}

function renderPlanLevel(steps: PlanStep[], allGoals: Goal[], depth: number, ownerGoalId: string, liveOnly: boolean): TemplateResult | typeof nothing {
	if (steps.length === 0 || depth > PLAN_RENDER_DEPTH_CAP) return nothing;
	const { nodes, edges, width, height } = layoutPlanLevel(steps, allGoals, 0, ownerGoalId, liveOnly);
	const paths = computeEdgePaths(nodes, edges, {});
	return html`
		<div class="plan-level" data-testid="plan-level-${depth}" data-plan-depth="${depth}" style="position:relative;margin-bottom:18px;">
			<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="display:block;max-width:100%;">
				${paths.map(p => svg`<path data-testid="plan-edge" d=${p.d} fill="none" stroke="var(--muted-foreground)" stroke-opacity="0.4" stroke-width="1.5"></path>`)}
				${nodes.map(n => {
					// Show the chevron only when the resolved child has its
					// own formal plan or own ad-hoc children.
					const childHasSubPlan = n.childGoal
						? computePlanStepsForGoal(n.childGoal as any, allGoals, { isNested: true, liveOnly }).length > 0
						: false;
					const isArchived = !!n.childGoal?.archived;
					const gateStatus = n.gateStatus;
					const hasConflict = !!n.mergeConflict;
					return svg`<g data-testid="plan-node" data-plan-state="${n.state}" data-plan-gate-status="${gateStatus ?? ""}" data-plan-conflict="${hasConflict ? 'true' : 'false'}" data-plan-id="${n.step.planId}" data-child-goal-id="${n.childGoal?.id ?? ""}" data-archived="${isArchived ? 'true' : 'false'}" style="${isArchived ? 'opacity:0.55;' : ''}">
					<rect x=${n.x} y=${n.y} width=${n.width} height=${n.height} rx="6" ry="6"
						fill=${planNodeFillColor(n.state)}
						stroke=${planNodeBorderColor(n.state)}
						stroke-width="1.5"
						stroke-dasharray=${isArchived ? "4 3" : "none"}
						class=${isArchived ? "plan-node-archived" : ""}></rect>
					<foreignObject x=${n.x + 6} y=${n.y + 4} width=${n.width - 12} height=${n.height - 8}>
						<div xmlns="http://www.w3.org/1999/xhtml" style="font-family:inherit;font-size:11px;color:var(--foreground);overflow:hidden;height:100%;display:flex;flex-direction:column;justify-content:space-between;">
							<div style="display:flex;align-items:center;gap:4px;">
								${gateStatus ? html`<span data-testid="plan-node-gate-dot" data-gate-status="${gateStatus}"
									style="flex-shrink:0;width:8px;height:8px;border-radius:50%;background:${planGateStatusColor(gateStatus)};${gateStatus === 'running' ? 'box-shadow:0 0 0 2px color-mix(in oklch, var(--info) 25%, transparent);' : ''}"
									title="Gate: ${gateStatus}"></span>` : nothing}
								${childHasSubPlan && n.childGoal ? html`<span data-testid="plan-node-chevron" class="plan-chevron"
									style="cursor:pointer;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:3px;background:transparent;"
									@click=${(e: Event) => { e.stopPropagation(); _togglePlanExpanded(n.childGoal!.id); }}
									title="${_isPlanExpanded(n.childGoal.id) ? "Collapse" : "Expand"} sub-plan">
									${_isPlanExpanded(n.childGoal.id) ? "▾" : "▸"}
								</span>` : nothing}
								<span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;" title="${n.step.title}">${n.step.title}</span>
								${hasConflict ? html`<span data-testid="plan-node-conflict-pill" title="Merge conflict — child preserved for manual recovery" style="flex-shrink:0;font-size:9px;font-weight:600;padding:1px 5px;border-radius:8px;background:color-mix(in oklch, var(--negative) 16%, transparent);color:var(--negative);text-transform:uppercase;letter-spacing:0.04em;">conflict</span>` : nothing}
								${isArchived ? html`<span data-testid="plan-node-archived-pill" style="flex-shrink:0;font-size:9px;font-weight:500;padding:1px 5px;border-radius:8px;background:var(--muted);color:var(--muted-foreground);text-transform:uppercase;letter-spacing:0.04em;">archived</span>` : nothing}
							</div>
							<div style="display:flex;justify-content:space-between;align-items:center;font-size:10px;color:var(--muted-foreground);">
								<span>${n.state}</span>
								${n.childGoal ? html`<a class="plan-node-link"
									style="color:var(--primary);text-decoration:none;cursor:pointer;"
									@click=${(e: Event) => { e.stopPropagation(); setHashRoute("goal-dashboard", n.childGoal!.id); }}
									title="Open ${n.childGoal.title}">open →</a>` : nothing}
							</div>
						</div>
					</foreignObject>
				</g>`;
				})}
			</svg>
			${nodes.filter(n => n.childGoal && _isPlanExpanded(n.childGoal.id)).map(n => {
				const child = n.childGoal!;
				const childPlanSteps = computePlanStepsForGoal(child as any, allGoals, { isNested: true, liveOnly });
				// Leaf children render NOTHING — the parent node already names them.
				if (childPlanSteps.length === 0) return nothing;
				if (depth + 1 > PLAN_RENDER_DEPTH_CAP) {
					const direct = state.goals.filter(g => g.parentGoalId === child.id).length;
					return html`<div data-testid="plan-subtree-truncated" style="margin-left:24px;font-size:11px;color:var(--muted-foreground);padding:6px 0;">Show ${direct} more nested step${direct === 1 ? "" : "s"}…</div>`;
				}
				return html`
					<div data-testid="plan-subtree" data-parent-goal-id="${child.id}"
						style="margin-left:24px;border-left:2px solid var(--border);padding-left:8px;">
						${renderPlanLevel(childPlanSteps, allGoals, depth + 1, child.id, liveOnly)}
					</div>
				`;
			})}
		</div>
	`;
}

/**
 * Compute plan steps for an arbitrary goal (top-level or nested).
 *
 * Default behaviour: include ALL direct children regardless of state
 * (archived/completed children remain visible in the plan). Pass
 * `liveOnly:true` to opt OUT of archived children at the call site —
 * defaults that hide data are the root cause of "archived siblings
 * vanish from the plan" regressions, so the helper default stays
 * inclusive and only explicit callers exclude.
 */
export function computePlanStepsForGoal(goal: Goal, allGoals: Goal[], opts?: { isNested?: boolean; liveOnly?: boolean }): PlanStep[] {
	const formalGate = goal.workflow?.gates.find(g => g.id === "execution");
	let formalSteps: FormalPlanStep[] | undefined = (formalGate as any)?.verify
		?.filter((v: any) => v.type === "subgoal" && v.subgoal)
		.map((v: any, idx: number) => ({
			planId: v.subgoal.planId,
			title: v.subgoal.title,
			spec: v.subgoal.spec,
			phase: typeof v.phase === "number" ? v.phase : idx,
			dependsOn: Array.isArray(v.subgoal.dependsOn) ? v.subgoal.dependsOn : undefined,
		}));
	const childSynthesis: SynthesisGoal[] = allGoals
		// pinned by tests/plan-archived-children.test.ts::computePlanStepsForGoal liveOnly filter
		// liveOnly EXCLUDES archived AND terminal-state (complete/shelved) children — only
		// in-progress / todo / blocked remain. See PLAN_TERMINAL_STATES.
		.filter(g => g.parentGoalId === goal.id && (!opts?.liveOnly || _isLiveChild(g)))
		.map(g => ({
			id: g.id,
			parentGoalId: g.parentGoalId,
			spawnedFromPlanId: g.spawnedFromPlanId,
			createdAt: g.createdAt,
			state: g.state as any,
			archived: !!g.archived,
			paused: !!(g as any).paused,
			title: g.title,
			workflowId: g.workflowId,
			dependsOnPlanIds: g.dependsOnPlanIds,
		}));
	// Guard against inherited parent-workflow snapshots rendering phantom
	// plan steps. At nested depth, formalSteps only count if at least one
	// own child resolves them — otherwise we're seeing an inherited echo.
	if (opts?.isNested && formalSteps && formalSteps.length > 0) {
		const formalPlanIds = new Set(formalSteps.map(s => s.planId));
		const anyResolved = childSynthesis.some(c => c.spawnedFromPlanId && formalPlanIds.has(c.spawnedFromPlanId));
		if (!anyResolved) formalSteps = undefined;
	}
	// liveOnly: also drop formal execution-plan steps whose resolved child
	// is absent from the (already-filtered) childSynthesis. Without this,
	// archiving/completing a child would leave a phantom unresolved "todo"
	// formal node behind when the user has explicitly asked for live work
	// only. Default mode keeps ALL formal steps (including unresolved/
	// archived/completed) — the helper default stays inclusive.
	// pinned by tests/plan-archived-children.test.ts::formal execution plan liveOnly hides steps whose resolved child is archived or completed
	if (opts?.liveOnly && formalSteps && formalSteps.length > 0) {
		const liveChildPlanIds = new Set(
			childSynthesis
				.map(c => c.spawnedFromPlanId)
				.filter((p): p is string => typeof p === "string" && p.length > 0)
		);
		formalSteps = formalSteps.filter(s => liveChildPlanIds.has(s.planId));
		if (formalSteps.length === 0) formalSteps = undefined;
	}
	return buildPlanSteps({ formalSteps, childGoals: childSynthesis });
}

export function renderPlanTab(args: {
	currentGoal: Goal;
	allGoals: Goal[];
}): TemplateResult {
	const { currentGoal, allGoals } = args;
	const liveOnly = _isPlanLiveOnly(currentGoal.id);
	const steps = computePlanStepsForGoal(currentGoal, allGoals, { liveOnly });
	const toggle = html`
		<div class="plan-tab-controls" style="display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-bottom:8px;">
			<button type="button"
				data-testid="plan-live-only-toggle"
				data-live-only="${liveOnly ? 'true' : 'false'}"
				@click=${() => _togglePlanLiveOnly(currentGoal.id)}
				title="${liveOnly ? 'Showing live (in-progress/todo/blocked) subgoals only — click to include archived/completed' : 'Showing all subgoals (including archived/completed) — click to show live only'}"
				style="font-size:11px;padding:3px 8px;border-radius:4px;border:1px solid var(--border);background:${liveOnly ? 'var(--muted)' : 'transparent'};color:var(--foreground);cursor:pointer;">
				${liveOnly ? 'Live only' : 'Show all'}
			</button>
		</div>
	`;
	if (steps.length === 0) {
		return html`
			<div class="tab-panel-inner" data-testid="plan-tab" style="overflow-x:auto;">
				${toggle}
				<div class="tab-empty">${svgPlan}<span>No plan yet — propose subgoal steps or spawn a child.</span></div>
			</div>
		`;
	}
	return html`
		<div class="tab-panel-inner" data-testid="plan-tab" style="overflow-x:auto;">
			${toggle}
			${renderPlanLevel(steps, allGoals, 0, currentGoal.id, liveOnly)}
		</div>
	`;
}
