import type { SidebarTreeLayoutPreferenceV1, SidebarTreeNode } from "./sidebar-tree-builder.js";
import { safeGetItem, safeSetItem } from "./safe-storage.js";

export const SIDEBAR_TREE_INDENT_KEY = "bobbit:sidebar-tree-indent";
export const SIDEBAR_TREE_INDENT_DEFAULT_PX = 16;
export const SIDEBAR_TREE_INDENT_MIN_PX = 8;
export const SIDEBAR_TREE_INDENT_MAX_PX = 28;
export const SIDEBAR_TREE_INDENT_STEP_PX = 1;
export const SIDEBAR_TREE_BASE_INDENT_PX = 5;
export const SIDEBAR_TREE_COLLAPSED_INDENT_MAX_PX = 6;

export interface ResolvedSidebarTreeLayoutPreferenceV1 {
	version: 1;
	indentMode: "comfortable";
	baseIndentPx: number;
	nestedGoalIndentPx: number;
}

function roundToSidebarTreeIndentStep(px: number): number {
	return Math.round(px / SIDEBAR_TREE_INDENT_STEP_PX) * SIDEBAR_TREE_INDENT_STEP_PX;
}

export function clampSidebarTreeIndentPx(px: number): number {
	if (typeof px !== "number" || !Number.isFinite(px)) return SIDEBAR_TREE_INDENT_DEFAULT_PX;
	const rounded = roundToSidebarTreeIndentStep(px);
	if (rounded < SIDEBAR_TREE_INDENT_MIN_PX) return SIDEBAR_TREE_INDENT_MIN_PX;
	if (rounded > SIDEBAR_TREE_INDENT_MAX_PX) return SIDEBAR_TREE_INDENT_MAX_PX;
	return rounded;
}

export function sidebarTreeIndentPxToLayout(px: number): ResolvedSidebarTreeLayoutPreferenceV1 {
	const indentPx = clampSidebarTreeIndentPx(px);
	return {
		version: 1,
		indentMode: "comfortable",
		baseIndentPx: indentPx,
		nestedGoalIndentPx: indentPx,
	};
}

export function sidebarTreeCollapsedIndentPx(pxOrLayout: number | SidebarTreeLayoutPreferenceV1): number {
	const indentPx = typeof pxOrLayout === "number"
		? clampSidebarTreeIndentPx(pxOrLayout)
		: clampSidebarTreeIndentPx(pxOrLayout.baseIndentPx ?? pxOrLayout.nestedGoalIndentPx ?? SIDEBAR_TREE_INDENT_DEFAULT_PX);
	return Math.min(SIDEBAR_TREE_COLLAPSED_INDENT_MAX_PX, Math.max(2, Math.round(indentPx / 3)));
}

export function loadSidebarTreeIndentPx(): number {
	const raw = safeGetItem(SIDEBAR_TREE_INDENT_KEY);
	const trimmed = raw?.trim();
	if (!trimmed) return SIDEBAR_TREE_INDENT_DEFAULT_PX;
	const px = Number(trimmed);
	if (!Number.isFinite(px)) return SIDEBAR_TREE_INDENT_DEFAULT_PX;
	return clampSidebarTreeIndentPx(px);
}

export function saveSidebarTreeIndentPx(px: number): number {
	const clamped = clampSidebarTreeIndentPx(px);
	safeSetItem(SIDEBAR_TREE_INDENT_KEY, String(clamped));
	return clamped;
}

export function resetSidebarTreeIndentPreference(): number {
	safeSetItem(SIDEBAR_TREE_INDENT_KEY, String(SIDEBAR_TREE_INDENT_DEFAULT_PX));
	return SIDEBAR_TREE_INDENT_DEFAULT_PX;
}

export function loadSidebarTreeLayoutPreference(): ResolvedSidebarTreeLayoutPreferenceV1 {
	return sidebarTreeIndentPxToLayout(loadSidebarTreeIndentPx());
}

export function applySidebarTreeLayoutVars(pxOrLayout: number | SidebarTreeLayoutPreferenceV1): void {
	if (typeof document === "undefined") return;
	const layout = typeof pxOrLayout === "number"
		? sidebarTreeIndentPxToLayout(pxOrLayout)
		: {
			version: 1 as const,
			indentMode: "comfortable" as const,
			baseIndentPx: clampSidebarTreeIndentPx(pxOrLayout.baseIndentPx ?? pxOrLayout.nestedGoalIndentPx ?? SIDEBAR_TREE_INDENT_DEFAULT_PX),
			nestedGoalIndentPx: clampSidebarTreeIndentPx(pxOrLayout.nestedGoalIndentPx ?? pxOrLayout.baseIndentPx ?? SIDEBAR_TREE_INDENT_DEFAULT_PX),
		};
	document.documentElement.style.setProperty("--sidebar-tree-base-indent", `${layout.baseIndentPx}px`);
	document.documentElement.style.setProperty("--sidebar-tree-nested-goal-indent", `${layout.nestedGoalIndentPx}px`);
	document.documentElement.style.setProperty("--sidebar-tree-collapsed-indent", `${sidebarTreeCollapsedIndentPx(layout)}px`);
}

function clampDepth(depth: number | undefined): number {
	if (typeof depth !== "number" || !Number.isFinite(depth)) return 0;
	return Math.max(0, Math.round(depth));
}

function baseIndentCalc(depth: number): string {
	const clampedDepth = clampDepth(depth);
	return clampedDepth === 1
		? "var(--sidebar-tree-base-indent, var(--sidebar-tree-base-indent-default))"
		: `calc(var(--sidebar-tree-base-indent, var(--sidebar-tree-base-indent-default)) * ${clampedDepth})`;
}

function nestedGoalIndentCalc(depth: number): string {
	const clampedDepth = clampDepth(depth);
	return clampedDepth === 1
		? "var(--sidebar-tree-nested-goal-indent, var(--sidebar-tree-nested-goal-indent-default))"
		: `calc(var(--sidebar-tree-nested-goal-indent, var(--sidebar-tree-nested-goal-indent-default)) * ${clampedDepth})`;
}

function collapsedIndentCalc(depth: number): string {
	const clampedDepth = clampDepth(depth);
	return clampedDepth === 1
		? "var(--sidebar-tree-collapsed-indent, var(--sidebar-tree-collapsed-indent-default))"
		: `calc(var(--sidebar-tree-collapsed-indent, var(--sidebar-tree-collapsed-indent-default)) * ${clampedDepth})`;
}

function isProjectForestGoalNode(node: Pick<SidebarTreeNode, "kind" | "context">): boolean {
	const placement = (node.context as { renderPlacement?: unknown } | undefined)?.renderPlacement;
	return node.kind === "goal" && (placement === "project-forest" || placement === "archived-section");
}

export function sidebarTreeBaseIndentStyle(): string {
	return "padding-inline-start: var(--sidebar-tree-base-indent, var(--sidebar-tree-base-indent-default));";
}

export function sidebarTreeHalfIndentStyle(): string {
	return "padding-inline-start: var(--sidebar-tree-half-indent);";
}

export function sidebarTreeNodeIndentStyle(node: Pick<SidebarTreeNode, "kind" | "indentDepth" | "indentLevel" | "context">): string {
	const depth = clampDepth(node.indentDepth ?? node.indentLevel);
	const value = isProjectForestGoalNode(node as Pick<SidebarTreeNode, "kind" | "context">)
		? nestedGoalIndentCalc(depth)
		: baseIndentCalc(depth);
	return `padding-inline-start: ${value};`;
}

export function sidebarTreeLegacyGoalIndentStyle(depth: number): string {
	return `padding-inline-start: ${nestedGoalIndentCalc(depth)};`;
}

export function sidebarTreeTruncationIndentStyle(depth: number): string {
	return `padding-inline-start: calc(${nestedGoalIndentCalc(depth)} + var(--sidebar-header-chevron-w));`;
}

export function sidebarTreeCollapsedIndentStyle(depth = 1): string {
	return `padding-inline-start: ${collapsedIndentCalc(depth)};`;
}
