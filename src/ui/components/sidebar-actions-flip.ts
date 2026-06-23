export interface SidebarActionsFlipRect {
	actionId: string;
	rect: DOMRectReadOnly;
}

export interface FlipDelta {
	actionId: string;
	dx: number;
	dy: number;
	sx: number;
	sy: number;
}

function finiteOr(value: number, fallback: number): number {
	return Number.isFinite(value) ? value : fallback;
}

function scale(sourceSize: number, targetSize: number): number {
	if (targetSize === 0) return 1;
	return finiteOr(sourceSize / targetSize, 1);
}

function isVisibleActionSource(el: HTMLElement): boolean {
	const rect = el.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return false;
	const style = getComputedStyle(el);
	return style.display !== "none" && style.visibility !== "hidden";
}

function captureActionSourceRects(rowEl: HTMLElement, selector: string): SidebarActionsFlipRect[] {
	return [...rowEl.querySelectorAll<HTMLElement>(selector)]
		.filter(isVisibleActionSource)
		.map((el) => ({ actionId: el.dataset.sidebarActionId!, rect: el.getBoundingClientRect() }));
}

export function captureSidebarActionSourceRects(rowEl: HTMLElement): SidebarActionsFlipRect[] {
	return captureActionSourceRects(rowEl, "[data-sidebar-action-quick='true'][data-sidebar-action-id]");
}

export function captureHeaderSessionActionSourceRects(rowEl: HTMLElement): SidebarActionsFlipRect[] {
	return captureActionSourceRects(rowEl, "[data-session-action-surface='header'][data-sidebar-action-id]");
}

export function computeSidebarActionFlipDeltas(
	sources: SidebarActionsFlipRect[],
	targets: SidebarActionsFlipRect[],
): FlipDelta[] {
	const targetById = new Map(targets.map((target) => [target.actionId, target.rect]));
	const deltas: FlipDelta[] = [];

	for (const source of sources) {
		const target = targetById.get(source.actionId);
		if (!target) continue;

		deltas.push({
			actionId: source.actionId,
			dx: finiteOr(source.rect.left - target.left, 0),
			dy: finiteOr(source.rect.top - target.top, 0),
			sx: scale(source.rect.width, target.width),
			sy: scale(source.rect.height, target.height),
		});
	}

	return deltas;
}
