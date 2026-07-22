import { PREVIEW_THEME_BRIDGE } from "../../../shared/preview-bridge-scripts.js";

/** Marker used to make canonical theme-bridge preparation idempotent. */
export const INLINE_HTML_THEME_BRIDGE_ATTRIBUTE = "data-bobbit-inline-theme-bridge";

/**
 * Serialize every parsed document-level node while using the browser's HTML
 * serializer for the document element. This retains the doctype and leading or
 * trailing comments without turning HTML elements into XHTML.
 */
function serializeHtmlDocument(document: Document): string {
	const serializer = new XMLSerializer();
	return Array.from(document.childNodes, (node) => (
		node.nodeType === 1
			? (node as Element).outerHTML
			: serializer.serializeToString(node)
	)).join("");
}

/**
 * Prepare authored HTML for an inline `srcdoc` preview.
 *
 * DOMParser provides the insertion point rather than a raw closing-tag search,
 * so tag-shaped text inside scripts, comments, styles, and textareas remains
 * authored content. The canonical bridge is the first node in `<head>`, which
 * lets authored scripts synchronously observe the host theme while parsing.
 * Any unavailable browser API or parser/serializer failure is fail-open.
 */
export function prepareInlineHtml(content: string): string {
	try {
		if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") return content;

		const parser = new DOMParser();
		const document = parser.parseFromString(content, "text/html");
		if (document.querySelector(`script[${INLINE_HTML_THEME_BRIDGE_ATTRIBUTE}]`)) return content;

		const bridgeDocument = parser.parseFromString(PREVIEW_THEME_BRIDGE, "text/html");
		const canonicalBridge = bridgeDocument.querySelector("script");
		if (!canonicalBridge || !document.head) return content;

		const bridge = document.importNode(canonicalBridge, true);
		bridge.setAttribute(INLINE_HTML_THEME_BRIDGE_ATTRIBUTE, "");
		document.head.insertBefore(bridge, document.head.firstChild);

		return serializeHtmlDocument(document);
	} catch {
		return content;
	}
}
