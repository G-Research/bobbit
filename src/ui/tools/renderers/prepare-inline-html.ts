import { PREVIEW_THEME_BRIDGE } from "../../../shared/preview-bridge-scripts.js";

/** Marker used to make canonical theme-bridge preparation idempotent. */
export const INLINE_HTML_THEME_BRIDGE_ATTRIBUTE = "data-bobbit-inline-theme-bridge";

/**
 * Preparation is shared by every inline HTML renderer, so keep several cards
 * warm without allowing transcript HTML to become an unbounded module cache.
 * Byte accounting uses the conservative UTF-16 size of both the Map key and
 * prepared value.
 */
export const INLINE_HTML_PREPARATION_CACHE_LIMITS = Object.freeze({
	maxEntries: 16,
	maxRetainedBytes: 2 * 1024 * 1024,
	maxCacheableContentBytes: 512 * 1024,
});

interface CanonicalBridgeDescriptor {
	textContent: string;
	attributes: ReadonlyArray<readonly [name: string, value: string]>;
}

interface PreparedHtmlCacheEntry {
	prepared: string;
	retainedBytes: number;
}

// Module-scoped by design: shared renderer instances reuse it, while a Vite HMR
// module replacement naturally drops both prepared documents and the descriptor.
const preparedHtmlCache = new Map<string, PreparedHtmlCacheEntry>();
let preparedHtmlCacheBytes = 0;
let canonicalBridgeDescriptor: CanonicalBridgeDescriptor | undefined;

function retainedStringBytes(value: string): number {
	return value.length * 2;
}

function cachedPreparation(content: string): string | undefined {
	const entry = preparedHtmlCache.get(content);
	if (!entry) return undefined;

	// Refresh insertion order so active cards win over old transcript entries.
	preparedHtmlCache.delete(content);
	preparedHtmlCache.set(content, entry);
	return entry.prepared;
}

function cachePreparation(content: string, prepared: string): void {
	const contentBytes = retainedStringBytes(content);
	if (contentBytes > INLINE_HTML_PREPARATION_CACHE_LIMITS.maxCacheableContentBytes) return;

	const retainedBytes = contentBytes + retainedStringBytes(prepared);
	if (retainedBytes > INLINE_HTML_PREPARATION_CACHE_LIMITS.maxRetainedBytes) return;

	while (
		preparedHtmlCache.size >= INLINE_HTML_PREPARATION_CACHE_LIMITS.maxEntries
		|| preparedHtmlCacheBytes + retainedBytes > INLINE_HTML_PREPARATION_CACHE_LIMITS.maxRetainedBytes
	) {
		const oldestKey = preparedHtmlCache.keys().next().value as string | undefined;
		if (oldestKey === undefined) break;
		const oldest = preparedHtmlCache.get(oldestKey);
		preparedHtmlCache.delete(oldestKey);
		preparedHtmlCacheBytes -= oldest?.retainedBytes ?? 0;
	}

	preparedHtmlCache.set(content, { prepared, retainedBytes });
	preparedHtmlCacheBytes += retainedBytes;
}

/**
 * Parse the canonical bridge once into realm-neutral strings. Keeping a DOM
 * node would tie future documents to the descriptor parser's owner document.
 * Failures are deliberately not memoized so a temporarily unavailable parser
 * can recover on a later render.
 */
function getCanonicalBridgeDescriptor(): CanonicalBridgeDescriptor | undefined {
	if (canonicalBridgeDescriptor) return canonicalBridgeDescriptor;

	const bridgeDocument = new DOMParser().parseFromString(PREVIEW_THEME_BRIDGE, "text/html");
	const canonicalBridge = bridgeDocument.querySelector<HTMLScriptElement>("script");
	if (!canonicalBridge) return undefined;

	const descriptor: CanonicalBridgeDescriptor = {
		textContent: canonicalBridge.textContent ?? "",
		attributes: Array.from(
			canonicalBridge.attributes,
			attribute => [attribute.name, attribute.value] as const,
		),
	};
	canonicalBridgeDescriptor = descriptor;
	return descriptor;
}

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
 * A marker is only an idempotence hint: authored HTML may legitimately use the
 * same attribute. Verify that the marked element is the canonical bridge,
 * including executable script attributes, before skipping injection.
 */
function isCanonicalMarkedBridge(
	candidate: HTMLScriptElement,
	canonical: CanonicalBridgeDescriptor,
): boolean {
	if (candidate.textContent !== canonical.textContent) return false;

	const candidateAttributes = Array.from(candidate.attributes)
		.filter(attribute => attribute.name !== INLINE_HTML_THEME_BRIDGE_ATTRIBUTE);
	if (candidateAttributes.length !== canonical.attributes.length) return false;

	return candidateAttributes.every(attribute =>
		canonical.attributes.some(([name, value]) => name === attribute.name && value === attribute.value),
	);
}

/**
 * Prepare authored HTML for an inline `srcdoc` preview.
 *
 * DOMParser provides the insertion point rather than a raw closing-tag search,
 * so tag-shaped text inside scripts, comments, styles, and textareas remains
 * authored content. The canonical bridge is the first node in `<head>`, which
 * lets authored scripts synchronously observe the host theme while parsing.
 * Any unavailable browser API or parser/serializer failure is fail-open and is
 * not cached, allowing a later render to recover when browser APIs return.
 */
export function prepareInlineHtml(content: string): string {
	const cached = cachedPreparation(content);
	if (cached !== undefined) return cached;

	try {
		if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") return content;

		const canonicalBridge = getCanonicalBridgeDescriptor();
		if (!canonicalBridge) return content;

		const document = new DOMParser().parseFromString(content, "text/html");
		if (!document.head) return content;

		const markedBridges = document.querySelectorAll<HTMLScriptElement>(
			`script[${INLINE_HTML_THEME_BRIDGE_ATTRIBUTE}]`,
		);
		if (Array.from(markedBridges).some(candidate => isCanonicalMarkedBridge(candidate, canonicalBridge))) {
			cachePreparation(content, content);
			return content;
		}

		const bridge = document.createElement("script");
		for (const [name, value] of canonicalBridge.attributes) bridge.setAttribute(name, value);
		bridge.textContent = canonicalBridge.textContent;
		bridge.setAttribute(INLINE_HTML_THEME_BRIDGE_ATTRIBUTE, "");
		document.head.insertBefore(bridge, document.head.firstChild);

		const prepared = serializeHtmlDocument(document);
		cachePreparation(content, prepared);
		return prepared;
	} catch {
		return content;
	}
}

/** Reset module memoization between deterministic tests. */
export function resetInlineHtmlPreparationCacheForTests(): void {
	preparedHtmlCache.clear();
	preparedHtmlCacheBytes = 0;
	canonicalBridgeDescriptor = undefined;
}
