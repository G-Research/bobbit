// Children-tab render path extracted from goal-dashboard.ts (Task C).
// Public API: renderChildrenTab + buildChildSummaries.
// Behaviour preservation: same Lit output for the same inputs.

import { html, nothing, type TemplateResult } from "lit";
import { setHashRoute } from "./routing.js";
import type { Goal } from "./state.js";

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
	if (live.length === 0 && archived.length === 0) {
		return html`<div class="tab-empty">${svgChildren}<span>No child goals yet</span></div>`;
	}
	return html`
		<div class="tab-panel-inner" data-testid="children-tab">
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
