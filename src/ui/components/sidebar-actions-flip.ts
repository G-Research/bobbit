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

export function captureSidebarActionSourceRects(rowEl: HTMLElement): SidebarActionsFlipRect[] {
	return [...rowEl.querySelectorAll<HTMLElement>("[data-sidebar-action-quick='true'][data-sidebar-action-id]")]
		.map((el) => ({ actionId: el.dataset.sidebarActionId!, rect: el.getBoundingClientRect() }));
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
