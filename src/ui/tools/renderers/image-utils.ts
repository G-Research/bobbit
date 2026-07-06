import { html, type TemplateResult } from "lit";

/**
 * Show a lightbox overlay for an image. Click backdrop or press Escape to close.
 * Scroll/pinch to zoom, drag to pan when zoomed.
 */
function showLightbox(src: string) {
	const overlay = document.createElement("div");
	overlay.style.cssText = `
		position: fixed; inset: 0; z-index: 9999;
		background: rgba(0,0,0,0.85);
		display: flex; align-items: center; justify-content: center;
		cursor: zoom-out;
	`;

	const img = document.createElement("img");
	img.src = src;
	img.style.cssText = `
		max-width: 90vw; max-height: 90vh;
		object-fit: contain;
		border-radius: 4px;
		transition: transform 0.15s ease;
		cursor: default;
		user-select: none;
		-webkit-user-select: none;
	`;

	let scale = 1;
	let translateX = 0;
	let translateY = 0;
	let isDragging = false;
	let dragStartX = 0;
	let dragStartY = 0;
	let startTranslateX = 0;
	let startTranslateY = 0;

	function updateTransform() {
		img.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
		img.style.cursor = scale > 1 ? "grab" : "default";
	}

	// Scroll to zoom
	overlay.addEventListener("wheel", (e) => {
		e.preventDefault();
		const delta = e.deltaY > 0 ? 0.9 : 1.1;
		scale = Math.min(Math.max(scale * delta, 0.5), 10);
		if (scale <= 1.05 && scale >= 0.95) {
			scale = 1;
			translateX = 0;
			translateY = 0;
		}
		updateTransform();
	}, { passive: false });

	// Drag to pan when zoomed
	img.addEventListener("mousedown", (e) => {
		if (scale <= 1) return;
		e.preventDefault();
		isDragging = true;
		dragStartX = e.clientX;
		dragStartY = e.clientY;
		startTranslateX = translateX;
		startTranslateY = translateY;
		img.style.cursor = "grabbing";
	});

	window.addEventListener("mousemove", onMouseMove);
	window.addEventListener("mouseup", onMouseUp);

	function onMouseMove(e: MouseEvent) {
		if (!isDragging) return;
		translateX = startTranslateX + (e.clientX - dragStartX);
		translateY = startTranslateY + (e.clientY - dragStartY);
		updateTransform();
	}

	function onMouseUp() {
		if (isDragging) {
			isDragging = false;
			img.style.cursor = scale > 1 ? "grab" : "default";
		}
	}

	function close() {
		window.removeEventListener("mousemove", onMouseMove);
		window.removeEventListener("mouseup", onMouseUp);
		window.removeEventListener("keydown", onKeyDown);
		overlay.remove();
	}

	function onKeyDown(e: KeyboardEvent) {
		if (e.key === "Escape") close();
	}

	// Click backdrop to close (not the image itself unless at 1x)
	overlay.addEventListener("click", (e) => {
		if (e.target === overlay || (e.target === img && scale <= 1)) close();
	});

	window.addEventListener("keydown", onKeyDown);

	overlay.appendChild(img);
	document.body.appendChild(overlay);
}

/**
 * Extract image content blocks from tool result content array
 * and render them as inline <img> elements.
 */
export function renderInlineImages(content: any[] | undefined): TemplateResult {
	if (!content) return html``;

	const images = content.filter((c: any) => c.type === "image" && c.data && c.mimeType);
	if (images.length === 0) return html``;

	return html`
		<div class="flex flex-wrap gap-2 mt-2">
			${images.map(
				(img: any) => {
					const src = `data:${img.mimeType};base64,${img.data}`;
					return html`
						<img
							src=${src}
							alt="Tool output image"
							class="max-w-full rounded border border-border cursor-pointer hover:opacity-90 transition-opacity"
							style="max-height: 400px; object-fit: contain;"
							role="button"
							tabindex="0"
							@click=${() => showLightbox(src)}
							@keydown=${(e: KeyboardEvent) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									showLightbox(src);
								}
							}}
						/>
					`;
				},
			)}
		</div>
	`;
}
