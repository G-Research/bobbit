// Heavy-library rendering for the artifacts PACK viewer — REAL behavioral parity
// with the built-in PdfArtifact (pdfjs-dist) and DocxArtifact (docx-preview),
// closing two of the gap reviewer's DOCUMENTED GAPS.
//
// VENDORING: these npm deps are bundled INLINE into the served
// `ArtifactViewerPanel.js` by `scripts/build-market-packs.mjs`. A pack ESM is
// loaded via a Blob-URL `import()`, which has no resolvable base for dynamic
// `import("./chunk.js")` — so EVERYTHING must be in one self-contained file, and
// these libs are imported eagerly (browser-only; this module is never imported by
// the node:test unit suite, which imports the node-safe `helpers.ts`).
//
// pdfjs WORKER (the worker wrinkle): a separate Web Worker is impossible here —
// pdfjs derives its worker URL from `import.meta.url`, which under a Blob-URL
// module is a `blob:` URL with no sibling worker file, and there is no pack-asset
// endpoint to serve one. So the build inlines the pre-bundled worker SOURCE as a
// string (the `virtual:pdf-worker` module) and we hand it to pdfjs as a
// Blob-URL `workerSrc`. pdfjs then spins up a real worker from that blob — true
// off-main-thread parsing, fully self-contained, no server changes. (Chosen over
// `disableWorker`, which pdfjs only honours via the same fake-worker import path
// that breaks under Blob-URL loading.)

import * as pdfjsLib from "pdfjs-dist";
// The pre-bundled pdf.worker source, inlined as a string by the build's
// `virtual:pdf-worker` esbuild plugin.
// @ts-expect-error virtual module resolved by scripts/build-market-packs.mjs
import pdfWorkerSource from "virtual:pdf-worker";
import { renderAsync } from "docx-preview";

let workerConfigured = false;
function configurePdfWorker(): void {
	if (workerConfigured) return;
	workerConfigured = true;
	try {
		const blob = new Blob([pdfWorkerSource as string], { type: "text/javascript" });
		(pdfjsLib as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc =
			URL.createObjectURL(blob);
	} catch {
		/* if Blob/URL are unavailable the getDocument call below will surface the error */
	}
}

function base64ToUint8Array(content: string): Uint8Array {
	let b64 = content;
	if (content.startsWith("data:")) {
		const m = content.match(/base64,(.+)/);
		if (m) b64 = m[1];
	}
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function showError(root: HTMLElement, message: string): void {
	root.innerHTML = "";
	const box = document.createElement("div");
	box.className = "m-4 p-4 rounded-lg border border-destructive bg-destructive/10 text-destructive max-w-2xl";
	box.setAttribute("data-testid", "artifact-viewer-binary-error");
	box.textContent = message;
	root.appendChild(box);
}

/**
 * Render every page of a base64 PDF into `root` as canvases — parity with
 * PdfArtifact.renderPdf (scale 1.5, white page background, per-page separators).
 */
export async function renderPdfInto(root: HTMLElement, content: string): Promise<void> {
	configurePdfWorker();
	let pdf: any = null;
	try {
		const data = base64ToUint8Array(content);
		const loadingTask = (pdfjsLib as any).getDocument({ data });
		pdf = await loadingTask.promise;

		root.innerHTML = "";
		const wrapper = document.createElement("div");
		wrapper.className = "p-4";
		wrapper.setAttribute("data-testid", "artifact-viewer-pdf-pages");
		root.appendChild(wrapper);

		for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
			const page = await pdf.getPage(pageNum);
			const viewport = page.getViewport({ scale: 1.5 });

			const pageContainer = document.createElement("div");
			pageContainer.className = "mb-4 last:mb-0";

			const canvas = document.createElement("canvas");
			canvas.height = viewport.height;
			canvas.width = viewport.width;
			canvas.className = "w-full max-w-full h-auto block mx-auto bg-white rounded shadow-sm border border-border";
			const ctx = canvas.getContext("2d");
			if (ctx) {
				ctx.fillStyle = "white";
				ctx.fillRect(0, 0, canvas.width, canvas.height);
			}

			await page.render({ canvasContext: ctx, viewport, canvas }).promise;
			pageContainer.appendChild(canvas);
			wrapper.appendChild(pageContainer);
		}
	} catch (err: any) {
		showError(root, `Error loading PDF: ${err?.message || String(err)}`);
	} finally {
		try { pdf?.destroy?.(); } catch { /* ignore */ }
	}
}

/**
 * Render a base64 DOCX into `root` via docx-preview — parity with
 * DocxArtifact.renderDocx (same renderAsync options + the theme-fitting style
 * overrides that keep the document on a white page, fitting the panel width).
 */
export async function renderDocxInto(root: HTMLElement, content: string): Promise<void> {
	try {
		const data = base64ToUint8Array(content);
		root.innerHTML = "";
		const wrapper = document.createElement("div");
		wrapper.className = "docx-wrapper-custom";
		wrapper.setAttribute("data-testid", "artifact-viewer-docx-rendered");
		root.appendChild(wrapper);

		await renderAsync(data as unknown as Blob, wrapper, undefined, {
			className: "docx",
			inWrapper: true,
			ignoreWidth: true,
			ignoreHeight: false,
			ignoreFonts: false,
			breakPages: true,
			ignoreLastRenderedPageBreak: true,
			experimental: false,
			trimXmlDeclaration: true,
			useBase64URL: false,
			renderHeaders: true,
			renderFooters: true,
			renderFootnotes: true,
			renderEndnotes: true,
		});

		const style = document.createElement("style");
		style.textContent = `
			[data-docx-render-root] .docx-wrapper { max-width: 100% !important; margin: 0 !important; background: transparent !important; padding: 0 !important; }
			[data-docx-render-root] .docx-wrapper > section.docx { box-shadow: none !important; border: none !important; border-radius: 0 !important; margin: 0 !important; padding: 2em !important; background: white !important; color: black !important; max-width: 100% !important; width: 100% !important; min-width: 0 !important; overflow-x: auto !important; }
			[data-docx-render-root] table { max-width: 100% !important; width: auto !important; overflow-x: auto !important; display: block !important; }
			[data-docx-render-root] img { max-width: 100% !important; height: auto !important; }
			[data-docx-render-root] p, [data-docx-render-root] span, [data-docx-render-root] div { max-width: 100% !important; word-wrap: break-word !important; overflow-wrap: break-word !important; }
		`;
		root.appendChild(style);
	} catch (err: any) {
		showError(root, `Error loading document: ${err?.message || String(err)}`);
	}
}
