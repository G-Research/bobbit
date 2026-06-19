// Children-tab render path extracted from goal-dashboard.ts (Task C).
// Public API: renderChildrenTab + buildChildSummaries.
// Behaviour preservation: same Lit output for the same inputs.

import { html, nothing, type TemplateResult } from "lit";
import { setHashRoute } from "./routing.js";
import { state, renderApp, type Goal } from "./state.js";
import { patchGoalSubgoalPolicy } from "./api.js";
import { isSubgoalsEnabled, getSystemMaxNestingDepth } from "./subgoals-flag.js";
import { nestingDepthOf, effectiveMaxNestingDepthOf } from "./subgoal-eligibility.js";

/** Minimal cost-breakdown shape consumed by the Children tab. */
export interface ChildTreeCostBreakdown {
	goalId: string;
	costUsd: number;
}

export interface ChildCardSummary {
	goal: Goal;
	gatesPassed: number;
	gatesTotal: number;
	cost: number;
}

const svgChildren = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v6a3 3 0 0 0 3 3h12"/><path d="m15 9 3 3-3 3"/><circle cx="6" cy="20" r="2"/><circle cx="18" cy="20" r="2"/></svg>`;

// Transient flag: true while a sub-goal policy PATCH is in flight, so the
// controls disable to prevent a double-submit. Module-scoped because only one
// goal dashboard is mounted at a time.
let _savingSubgoalPolicy = false;

async function saveSubgoalPolicy(goalId: string, updates: { subgoalsAllowed?: boolean; maxNestingDepth?: number }): Promise<void> {
	if (_savingSubgoalPolicy) return;
	_savingSubgoalPolicy = true;
	renderApp();
	try {
		await patchGoalSubgoalPolicy(goalId, updates);
	} finally {
		_savingSubgoalPolicy = false;
		renderApp();
	}
}

/**
 * Existing-goal Sub-goals settings — lets a human turn on sub-goals for a
 * goal created with the toggle off (the root cause of the "Parent doesn't
 * allow sub-goals" dead-end) and tighten its max nesting depth. Persists via
 * `PATCH /api/goals/:id/policy`; the goal feed echoes the new values so they
 * survive a reload. Only rendered when the system Subgoals flag is ON.
 */
export function renderSubgoalSettings(goal: Goal): TemplateResult | typeof nothing {
	if (!isSubgoalsEnabled()) return nothing;
	const systemCap = getSystemMaxNestingDepth();
	const goalDepth = nestingDepthOf(goal.id, state.goals);
	const minDepth = goalDepth + 1;            // need ≥1 level below to host children
	// Inherited absolute cap: a CHILD goal can never widen past its parent's
	// effective cap (system ∩ parent.own ∩ … up the tree), only the system cap
	// for a root. Mirrors the server clamp in nested-goal-routes.ts so the
	// control never offers a range the server will reject.
	const parent = goal.parentGoalId
		? state.goals.find(g => g.id === goal.parentGoalId)
		: undefined;
	const maxDepth = parent ? effectiveMaxNestingDepthOf(parent as any, state.goals as any) : systemCap;
	const atCap = minDepth > maxDepth;         // no room for any sub-goals
	const depthFixed = !atCap && minDepth === maxDepth;
	const allowed = goal.subgoalsAllowed !== false && !atCap;
	const depthValue = atCap
		? maxDepth
		: Math.min(maxDepth, Math.max(minDepth, goal.maxNestingDepth ?? maxDepth));
	const levelsBelow = Math.max(0, depthValue - goalDepth);
	const disabled = _savingSubgoalPolicy;
	return html`
		<div class="subgoal-settings" data-testid="goal-subgoal-settings"
			style="border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:14px;background:var(--card);display:flex;flex-direction:column;gap:8px;">
			<div style="font-weight:600;font-size:13px;color:var(--foreground);">Sub-goal settings</div>
			${atCap ? html`
				<div style="font-size:11px;color:var(--muted-foreground);line-height:1.4;" data-testid="goal-subgoal-settings-at-cap">
					This goal sits at depth ${goalDepth}, at the inherited nesting cap of ${maxDepth}. It cannot host sub-goals.
				</div>
			` : html`
				<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;color:var(--foreground);${disabled ? "opacity:0.6;pointer-events:none;" : ""}">
					<input type="checkbox" class="toggle-switch"
						.checked=${allowed}
						?disabled=${disabled}
						data-testid="goal-subgoal-settings-allow-toggle"
						@change=${(e: Event) => saveSubgoalPolicy(goal.id, { subgoalsAllowed: (e.target as HTMLInputElement).checked })} />
					<span style="font-weight:500;">Allow sub-goals</span>
				</label>
				<div style="font-size:11px;color:var(--muted-foreground);line-height:1.4;">
					When on, this goal's team-lead can create child sub-goals, and it can be picked as a Parent Goal when creating a new goal.
				</div>
				${allowed ? html`
					<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--foreground);${depthFixed || disabled ? "opacity:0.7;" : ""}">
						<span>Max nesting depth</span>
						<span style="display:inline-flex;align-items:center;border:1px solid var(--border);border-radius:6px;overflow:hidden;">
							<button type="button" title="Decrease"
								?disabled=${depthFixed || disabled || depthValue <= minDepth}
								data-testid="goal-subgoal-settings-depth-dec"
								style="width:26px;height:26px;display:flex;align-items:center;justify-content:center;background:var(--background);color:var(--muted-foreground);border:none;cursor:pointer;"
								@click=${() => saveSubgoalPolicy(goal.id, { maxNestingDepth: Math.max(minDepth, depthValue - 1) })}>−</button>
							<input type="number" min=${String(minDepth)} max=${String(maxDepth)} step="1"
								.value=${String(depthValue)}
								?disabled=${depthFixed || disabled}
								data-testid="goal-subgoal-settings-depth"
								style="width:34px;text-align:center;border:none;border-left:1px solid var(--border);border-right:1px solid var(--border);background:var(--background);color:var(--foreground);padding:3px 0;"
								@change=${(e: Event) => {
									const raw = parseInt((e.target as HTMLInputElement).value, 10);
									if (Number.isFinite(raw)) saveSubgoalPolicy(goal.id, { maxNestingDepth: Math.min(maxDepth, Math.max(minDepth, raw)) });
								}} />
							<button type="button" title="Increase"
								?disabled=${depthFixed || disabled || depthValue >= maxDepth}
								data-testid="goal-subgoal-settings-depth-inc"
								style="width:26px;height:26px;display:flex;align-items:center;justify-content:center;background:var(--background);color:var(--muted-foreground);border:none;cursor:pointer;"
								@click=${() => saveSubgoalPolicy(goal.id, { maxNestingDepth: Math.min(maxDepth, depthValue + 1) })}>+</button>
						</span>
					</label>
					<div style="font-size:11px;color:var(--muted-foreground);line-height:1.4;" data-testid="goal-subgoal-settings-depth-help">
						Deepest nesting level allowed in this tree (inherited cap ${maxDepth}). This goal is at depth ${goalDepth}, so it allows ${levelsBelow} level${levelsBelow === 1 ? "" : "s"} of sub-goals below it.${depthFixed ? " Only one value fits, so it's fixed." : ""}
					</div>
				` : nothing}
			`}
		</div>
	`;
}

/** Status chip class — duplicates goal-dashboard.ts::statusChipClass to keep this module self-contained. */
function statusChipClass(s: "todo" | "in-progress" | "complete" | "blocked" | "skipped"): string {
	switch (s) {
		case "todo": return "chip-todo";
		case "in-progress": return "chip-progress";
		case "complete": return "chip-done";
		case "blocked": return "chip-blocked";
		case "skipped": return "chip-failed";
	}
}

export function buildChildSummaries(
	parentGoalId: string,
	includeArchived: boolean,
	allGoals: readonly Goal[],
	treeCostBreakdown: ChildTreeCostBreakdown[] | null,
): ChildCardSummary[] {
	const out: ChildCardSummary[] = [];
	for (const g of allGoals) {
		if (g.parentGoalId !== parentGoalId) continue;
		if (g.archived && !includeArchived) continue;
		if (!g.archived && includeArchived) continue;
		const gatesTotal = g.workflow?.gates.length ?? 0;
		// Tree-cost breakdown is the source for per-child cost when present;
		// otherwise leave 0 (the user already sees a "Tree cost" rollup).
		const breakdown = treeCostBreakdown?.find(b => b.goalId === g.id);
		const cost = breakdown ? breakdown.costUsd : 0;
		// gatesPassed: best-effort — only stamped on archived+complete (success terminal).
		const gatesPassed = g.archived && g.state === "complete" ? gatesTotal : 0;
		out.push({ goal: g, gatesPassed, gatesTotal, cost });
	}
	out.sort((a, b) => a.goal.createdAt - b.goal.createdAt);
	return out;
}

function renderChildCard(s: ChildCardSummary): TemplateResult {
	const g = s.goal;
	// Resolution order matters: archived must short-circuit BEFORE state-string
	// fallback, otherwise an archived in-progress goal renders as "Running".
	const stateClass: "complete" | "paused" | "failed" | "archived" | "in-progress" | "todo" | "shelved" =
		g.archived && g.state === "complete"
			? "complete"
			: g.archived
				? "archived"
				: g.paused
					? "paused"
					: g.state === "shelved"
						? "failed"
						: (g.state as "in-progress" | "todo");
	const stateLabel =
		stateClass === "complete" ? "Done"
			: stateClass === "archived" ? "Archived"
				: stateClass === "paused" ? "Paused"
					: stateClass === "failed" ? "Failed"
						: stateClass === "in-progress" ? "Running"
							: "Todo";
	const stateChip =
		stateClass === "complete" ? "complete"
			: stateClass === "archived" ? "skipped"
				: stateClass === "in-progress" ? "in-progress"
					: stateClass === "failed" ? "skipped"
						: "todo";
	const costStr = s.cost > 0 ? `$${s.cost.toFixed(2)}` : "—";
	const progressStr = s.gatesTotal > 0 ? `${s.gatesPassed}/${s.gatesTotal}` : "—";
	return html`
		<div class="child-card" data-testid="child-card-${g.id}"
			style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;cursor:pointer;background:var(--card);min-width:0;${g.archived ? "opacity:0.7;" : ""}"
			@click=${() => setHashRoute("goal-dashboard", g.id)}>
			<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
				<span class="status-chip ${statusChipClass(stateChip)}" data-testid="child-card-state">
					<span class="dot"></span>${stateLabel}
				</span>
				${g.paused ? html`<span class="meta-tag" data-testid="child-card-paused" style="background:var(--secondary);color:var(--muted-foreground);font-size:10px;padding:1px 6px;border-radius:6px;">paused</span>` : nothing}
			</div>
			<div style="font-weight:600;font-size:13px;line-height:1.3;margin-bottom:6px;color:var(--foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${g.title}">${g.title}</div>
			<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted-foreground);">
				<span title="Gates passed / total">${progressStr}</span>
				<span title="Cost (USD)">${costStr}</span>
			</div>
		</div>
	`;
}

export function renderChildrenTab(args: {
	currentGoal: Goal;
	allGoals: readonly Goal[];
	treeCostBreakdown: ChildTreeCostBreakdown[] | null;
}): TemplateResult {
	const { currentGoal, allGoals, treeCostBreakdown } = args;
	const live = buildChildSummaries(currentGoal.id, false, allGoals, treeCostBreakdown);
	const archived = buildChildSummaries(currentGoal.id, true, allGoals, treeCostBreakdown);
	const settings = renderSubgoalSettings(currentGoal);
	if (live.length === 0 && archived.length === 0) {
		return html`
			<div class="tab-panel-inner" data-testid="children-tab">
				${settings}
				<div class="tab-empty">${svgChildren}<span>No child goals yet</span></div>
			</div>
		`;
	}
	return html`
		<div class="tab-panel-inner" data-testid="children-tab">
			${settings}
			<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;">
				${live.map(s => renderChildCard(s))}
			</div>
			${archived.length > 0 ? html`
				<details style="margin-top:14px;">
					<summary style="cursor:pointer;font-size:12px;color:var(--muted-foreground);" data-testid="children-archived-disclosure">Archived (${archived.length})</summary>
					<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;margin-top:10px;opacity:0.7;">
						${archived.map(s => renderChildCard(s))}
					</div>
				</details>
			` : nothing}
		</div>
	`;
}
