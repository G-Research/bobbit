import { html, svg, type TemplateResult } from "lit";
import { layoutDag, type LayoutResult } from "./mission-dag-layout.js";
import type { MissionPlan, PlannedGoal } from "../../app/mission-types.js";
import { plannedGoalColor } from "../../app/mission-types.js";

export interface MissionDagSvgOptions {
	onNodeClick?: (planId: string) => void;
	highlightPlanId?: string;
	maxWidth?: number;
}

/**
 * Render a mission plan as an SVG DAG. Pure view component — caller controls
 * data and click handling.
 *
 * IMPORTANT (lit + SVG): SVG presentation attributes like `fill`, `stroke`,
 * `stroke-width`, `font-size`, `font-weight`, `text-anchor`, `opacity` are
 * NOT exposed as JS properties on SVGElement. lit's default attribute
 * binding (`fill=${expr}`) does `element[name] = value`, which silently
 * no-ops on these. The result is invisible 0×0 black rects. To force lit
 * to write a real DOM attribute we either prefix with `.` (property),
 * `?` (boolean), or fold the values into an inline `style="..."` string —
 * the latter is bulletproof since `style` is always parsed as an attribute.
 */
export function renderMissionDagSvg(
	plan: MissionPlan | null | undefined,
	opts: MissionDagSvgOptions = {},
): TemplateResult {
	if (!plan || plan.goals.length === 0) {
		return html`
			<div class="mission-dag-empty"
				style="border:1px dashed var(--border);border-radius:8px;padding:24px;text-align:center;color:var(--muted-foreground,#64748b);font-size:13px;"
				data-testid="mission-dag-empty">
				No plan yet. The Commander will propose a DAG once the charter passes.
			</div>
		`;
	}

	const nodes = plan.goals.map(g => ({ id: g.planId }));
	const edges = plan.dependencies.map(e => ({ from: e.from, to: e.to }));
	const layout = layoutDag(nodes, edges);
	const byId = new Map<string, PlannedGoal>(plan.goals.map(g => [g.planId, g]));

	return html`
		<div class="mission-dag-wrap" style="overflow-x:auto;border:1px solid var(--border);border-radius:8px;background:var(--background);display:flex;flex-direction:column;align-items:center;padding:8px;min-height:${layout.size.h + 16}px;">
			${svg`
				<svg
					viewBox="0 0 ${layout.size.w} ${layout.size.h}"
					width="${layout.size.w}"
					height="${layout.size.h}"
					style="display:block;max-width:100%;font-family:inherit;"
					role="img"
					aria-label="Mission plan DAG"
					data-testid="mission-dag-svg"
				>
					${renderEdges(plan, layout)}
					${plan.goals.map(node => renderNode(node, layout, byId, opts))}
				</svg>
			`}
			${layout.cyclic ? html`
				<div role="alert" style="padding:8px 12px;color:#b91c1c;font-size:12px;border-top:1px solid var(--border);">
					Warning: DAG contains a cycle — falling back to linear layout.
				</div>
			` : ""}
		</div>
	`;
}

function renderEdges(plan: MissionPlan, layout: LayoutResult): TemplateResult {
	return svg`
		<g style="stroke:var(--muted-foreground,#64748b);stroke-width:1.5;fill:none;opacity:0.6;">
			${plan.dependencies.map(e => {
				const from = layout.positions.get(e.from);
				const to = layout.positions.get(e.to);
				if (!from || !to) return svg``;
				const fx = from.x + 160; // node right edge
				const fy = from.y + 28;  // node centre y
				const tx = to.x;
				const ty = to.y + 28;
				const midX = (fx + tx) / 2;
				const path = `M ${fx} ${fy} C ${midX} ${fy} ${midX} ${ty} ${tx} ${ty}`;
				return svg`<path d=${path}></path>`;
			})}
		</g>
	`;
}

function renderNode(
	node: PlannedGoal,
	layout: LayoutResult,
	_byId: Map<string, PlannedGoal>,
	opts: MissionDagSvgOptions,
): TemplateResult {
	const pos = layout.positions.get(node.planId);
	if (!pos) return svg``;
	const c = plannedGoalColor(node);
	const isHighlight = opts.highlightPlanId === node.planId;
	const stroke = isHighlight ? "#0f172a" : c.stroke;
	const strokeWidth = isHighlight ? 2.5 : 1.5;
	const click = opts.onNodeClick
		? (e: Event) => { e.stopPropagation(); opts.onNodeClick!(node.planId); }
		: undefined;
	const groupStyle = click ? "cursor:pointer;" : "";
	const rectStyle = `fill:${c.fill};stroke:${stroke};stroke-width:${strokeWidth};`;
	const titleStyle = "font-size:12px;font-weight:600;fill:#0f172a;text-anchor:middle;pointer-events:none;";
	const labelStyle = "font-size:10px;fill:#475569;text-anchor:middle;pointer-events:none;";
	return svg`
		<g
			class="mission-dag-node"
			data-plan-id=${node.planId}
			data-state=${c.label}
			style=${groupStyle}
			@click=${click}
		>
			<rect x=${pos.x} y=${pos.y} width="160" height="56" rx="8" ry="8"
				style=${rectStyle}></rect>
			<text x=${pos.x + 80} y=${pos.y + 22}
				style=${titleStyle}>
				${truncate(node.title, 22)}
			</text>
			<text x=${pos.x + 80} y=${pos.y + 40}
				style=${labelStyle}>
				${c.label}
			</text>
		</g>
	`;
}

function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return s.slice(0, n - 1) + "…";
}
