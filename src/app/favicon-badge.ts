/**
 * Favicon notification badge.
 *
 * Draws a small coloured dot (with black outline) on the top-right corner
 * of the favicon when a session completes.  Clears automatically when the
 * tab regains focus.
 *
 * Also sets the PWA app badge via the Badging API when available.
 */

const BADGE_RADIUS_RATIO = 0.18; // dot radius relative to icon size
const BADGE_COLOR = "#2dd4bf";   // turquoise
const OUTLINE_COLOR = "#000000";
const OUTLINE_WIDTH_RATIO = 0.12; // outline width relative to dot radius
const ICON_SIZE = 32;            // rendered favicon size in px

let _originalHref: string | null = null;
let _linkEl: HTMLLinkElement | null = null;
let _badgeActive = false;

function getFaviconLink(): HTMLLinkElement | null {
	if (_linkEl) return _linkEl;
	_linkEl = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
	return _linkEl;
}

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.crossOrigin = "anonymous";
		img.onload = () => resolve(img);
		img.onerror = reject;
		img.src = src;
	});
}

/** Draw the favicon with a notification dot and apply it. */
async function applyBadge(): Promise<void> {
	const link = getFaviconLink();
	if (!link) return;

	// Stash the original href on first use
	if (_originalHref === null) {
		_originalHref = link.href;
	}

	try {
		const img = await loadImage(_originalHref);
		const canvas = document.createElement("canvas");
		canvas.width = ICON_SIZE;
		canvas.height = ICON_SIZE;
		const ctx = canvas.getContext("2d")!;

		// Draw original favicon scaled to canvas
		ctx.drawImage(img, 0, 0, ICON_SIZE, ICON_SIZE);

		// Draw notification dot (top-right) with black outline
		const r = ICON_SIZE * BADGE_RADIUS_RATIO;
		const cx = ICON_SIZE - r - 1;
		const cy = r + 1;
		const outlineW = Math.max(1, r * OUTLINE_WIDTH_RATIO);

		// Outline
		ctx.beginPath();
		ctx.arc(cx, cy, r + outlineW, 0, Math.PI * 2);
		ctx.fillStyle = OUTLINE_COLOR;
		ctx.fill();

		// Fill
		ctx.beginPath();
		ctx.arc(cx, cy, r, 0, Math.PI * 2);
		ctx.fillStyle = BADGE_COLOR;
		ctx.fill();

		link.href = canvas.toDataURL("image/png");
		_badgeActive = true;
	} catch {
		// If image loading fails, silently skip
	}

	// PWA app badge (taskbar/dock icon)
	if ("setAppBadge" in navigator) {
		(navigator as any).setAppBadge().catch(() => {});
	}
}

/** Restore the original favicon. */
function clearBadge(): void {
	if (!_badgeActive) return;
	const link = getFaviconLink();
	if (link && _originalHref) {
		link.href = _originalHref;
	}
	_badgeActive = false;

	// Clear PWA app badge
	if ("clearAppBadge" in navigator) {
		(navigator as any).clearAppBadge().catch(() => {});
	}
}

/** Show a notification dot on the favicon. */
export function showFaviconBadge(): void {
	if (_badgeActive) return;
	applyBadge();
}

/** Remove the notification dot from the favicon. */
export function hideFaviconBadge(): void {
	clearBadge();
}

// Auto-clear when the tab regains focus
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible") {
		clearBadge();
	}
});
