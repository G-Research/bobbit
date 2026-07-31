import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { AppWindow } from "lucide";
import { PREVIEW_THEME_BRIDGE } from "../../../shared/preview-bridge-scripts.js";
import { renderCollapsibleHeader, renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import {
	INLINE_HTML_THEME_BRIDGE_ATTRIBUTE,
	prepareInlineHtml,
} from "./prepare-inline-html.js";

interface HtmlWriteParams {
	path: string;
	content: string;
}

interface InlineThemeState {
	dark: boolean;
	palette: string | null;
	fontFamily: string;
	variables: Record<string, string>;
}

const INLINE_THEME_MESSAGE_TYPE = "bobbit:inline-theme:v1";
const INLINE_THEME_INITIAL_ATTRIBUTE = "data-bobbit-inline-theme-initial";

/**
 * Runs before authored scripts. Initial state is inert JSON on this script;
 * subsequent state can arrive only from the iframe's direct parent. The child
 * receives display tokens, never a parent DOM/storage/gateway capability.
 */
const INLINE_THEME_MESSAGE_BRIDGE = `(function() {
	'use strict';
	var script = document.currentScript;
	if (!script) return;
	var root = document.documentElement;
	var messageType = 'bobbit:inline-theme:v1';
	var appliedVariables = [];

	function validatedTheme(value) {
		if (!value || typeof value !== 'object') return null;
		if (typeof value.dark !== 'boolean') return null;
		if (value.palette !== null && typeof value.palette !== 'string') return null;
		if (typeof value.fontFamily !== 'string') return null;
		if (!value.variables || typeof value.variables !== 'object' || Array.isArray(value.variables)) return null;
		var names = Object.keys(value.variables);
		if (names.length > 1024) return null;
		var variables = [];
		for (var index = 0; index < names.length; index++) {
			var name = names[index];
			var variableValue = value.variables[name];
			if (!/^--[A-Za-z0-9_-]+$/.test(name)) continue;
			if (typeof variableValue !== 'string' || variableValue.length > 8192) return null;
			variables.push([name, variableValue]);
		}
		return {
			dark: value.dark,
			palette: value.palette,
			fontFamily: value.fontFamily.slice(0, 8192),
			variables: variables
		};
	}

	function apply(value) {
		var theme = validatedTheme(value);
		if (!theme) return;
		root.classList.toggle('dark', theme.dark);
		if (theme.palette) root.setAttribute('data-palette', theme.palette);
		else root.removeAttribute('data-palette');
		for (var oldIndex = 0; oldIndex < appliedVariables.length; oldIndex++) {
			root.style.removeProperty(appliedVariables[oldIndex]);
		}
		appliedVariables = [];
		for (var index = 0; index < theme.variables.length; index++) {
			root.style.setProperty(theme.variables[index][0], theme.variables[index][1]);
			appliedVariables.push(theme.variables[index][0]);
		}
		root.style.fontFamily = theme.fontFamily;
	}

	try {
		var initial = script.getAttribute('${INLINE_THEME_INITIAL_ATTRIBUTE}');
		if (initial) apply(JSON.parse(initial));
		script.removeAttribute('${INLINE_THEME_INITIAL_ATTRIBUTE}');
	} catch (error) {}

	window.addEventListener('message', function(event) {
		if (event.source !== parent) return;
		var data = event.data;
		if (!data || typeof data !== 'object' || data.type !== messageType) return;
		apply(data.theme);
	});
})();`;

let canonicalThemeBridgeBody: string | undefined;

function canonicalBridgeBody(): string | undefined {
	if (canonicalThemeBridgeBody !== undefined) return canonicalThemeBridgeBody;
	try {
		canonicalThemeBridgeBody = new DOMParser()
			.parseFromString(PREVIEW_THEME_BRIDGE, "text/html")
			.querySelector("script")
			?.textContent ?? "";
		return canonicalThemeBridgeBody;
	} catch {
		return undefined;
	}
}

function serializeHtmlDocument(document: Document): string {
	const serializer = new XMLSerializer();
	return Array.from(document.childNodes, node => (
		node.nodeType === Node.ELEMENT_NODE
			? (node as Element).outerHTML
			: serializer.serializeToString(node)
	)).join("");
}

function collectCustomPropertyNames(rules: CSSRuleList | undefined, names: Set<string>): void {
	if (!rules) return;
	for (let index = 0; index < rules.length; index++) {
		const rule = rules[index] as CSSRule & { style?: CSSStyleDeclaration; cssRules?: CSSRuleList };
		try {
			if (rule.style) {
				for (let styleIndex = 0; styleIndex < rule.style.length; styleIndex++) {
					const name = rule.style[styleIndex];
					if (name?.startsWith("--")) names.add(name);
				}
			}
			collectCustomPropertyNames(rule.cssRules, names);
		} catch { /* inaccessible nested stylesheet rule */ }
	}
}

function readInlineTheme(): InlineThemeState {
	const root = document.documentElement;
	const computed = getComputedStyle(root);
	const names = new Set<string>();

	for (let index = 0; index < computed.length; index++) {
		const name = computed[index];
		if (name?.startsWith("--")) names.add(name);
	}
	for (let index = 0; index < root.style.length; index++) {
		const name = root.style[index];
		if (name?.startsWith("--")) names.add(name);
	}
	for (const stylesheet of Array.from(document.styleSheets)) {
		try {
			collectCustomPropertyNames(stylesheet.cssRules, names);
		} catch { /* cross-origin stylesheet */ }
	}

	const variables: Record<string, string> = {};
	for (const name of [...names].sort()) {
		if (!/^--[A-Za-z0-9_-]+$/.test(name)) continue;
		const value = computed.getPropertyValue(name);
		if (value) variables[name] = value;
	}

	return {
		dark: root.classList.contains("dark"),
		palette: root.getAttribute("data-palette"),
		fontFamily: computed.fontFamily,
		variables,
	};
}

/** Replace the same-origin canonical bridge with an opaque-origin message bridge. */
function prepareIsolatedInlineHtml(content: string, initialTheme: InlineThemeState): string {
	const prepared = prepareInlineHtml(content);
	try {
		const document = new DOMParser().parseFromString(prepared, "text/html");
		if (!document.head) return prepared;
		const canonicalBody = canonicalBridgeBody();
		for (const script of Array.from(document.querySelectorAll<HTMLScriptElement>(
			`script[${INLINE_HTML_THEME_BRIDGE_ATTRIBUTE}]`,
		))) {
			if (script.textContent === canonicalBody || script.textContent === INLINE_THEME_MESSAGE_BRIDGE) {
				script.remove();
			}
		}

		const bridge = document.createElement("script");
		bridge.setAttribute(INLINE_HTML_THEME_BRIDGE_ATTRIBUTE, "parent-message-v1");
		bridge.setAttribute(INLINE_THEME_INITIAL_ATTRIBUTE, JSON.stringify(initialTheme));
		bridge.textContent = INLINE_THEME_MESSAGE_BRIDGE;
		document.head.insertBefore(bridge, document.head.firstChild);
		return serializeHtmlDocument(document);
	} catch {
		return prepared;
	}
}

/**
 * Renders HTML files written via the `write` tool inline in the chat.
 *
 * Both completed and streaming documents run in opaque-origin `srcdoc`
 * iframes. Streaming updates retain their debounce and iframe identity but use
 * `srcdoc` replacement because an opaque child cannot safely expose its
 * document to the parent for `document.write()`.
 */
export class HtmlRenderer implements ToolRenderer<HtmlWriteParams, any> {
	// ── streaming-only state ──
	private _iframe: HTMLIFrameElement | null = null;
	private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private _pendingContent: string | null = null;
	private _lastAppliedContent: string | null = null;

	private _themeFrames = new Set<HTMLIFrameElement>();
	private _themeObserver: MutationObserver | null = null;

	/** Throttled snapshot of code content for the code-block during streaming.
	 *  Updated at most ~4x/sec so hljs.highlight() doesn't run every frame. */
	private _throttledCode = "";
	private _codeThrottleTimer: ReturnType<typeof setTimeout> | null = null;

	private _postTheme(iframe: HTMLIFrameElement, theme = readInlineTheme()): void {
		iframe.contentWindow?.postMessage({ type: INLINE_THEME_MESSAGE_TYPE, theme }, "*");
	}

	private _broadcastTheme = (): void => {
		const theme = readInlineTheme();
		for (const iframe of this._themeFrames) {
			if (!iframe.isConnected) {
				this._themeFrames.delete(iframe);
				continue;
			}
			this._postTheme(iframe, theme);
		}
		if (this._themeFrames.size === 0) this._disconnectThemeObserver();
	};

	private _disconnectThemeObserver(): void {
		this._themeObserver?.disconnect();
		this._themeObserver = null;
	}

	private _registerThemeFrame(iframe: HTMLIFrameElement): void {
		this._themeFrames.add(iframe);
		if (!this._themeObserver) {
			this._themeObserver = new MutationObserver(this._broadcastTheme);
			this._themeObserver.observe(document.documentElement, {
				attributes: true,
				attributeFilter: ["class", "data-palette", "style"],
			});
		}
		this._postTheme(iframe);
	}

	private _unregisterThemeFrame(iframe: HTMLIFrameElement): void {
		this._themeFrames.delete(iframe);
		if (this._themeFrames.size === 0) this._disconnectThemeObserver();
	}

	private _themedIframeRef(onFrame?: (iframe: HTMLIFrameElement) => void) {
		let boundFrame: HTMLIFrameElement | null = null;
		return (element: Element | undefined) => {
			const iframe = element as HTMLIFrameElement | undefined;
			if (boundFrame && boundFrame !== iframe) this._unregisterThemeFrame(boundFrame);
			boundFrame = iframe ?? null;
			if (!iframe) return;
			this._registerThemeFrame(iframe);
			onFrame?.(iframe);
		};
	}

	private _writeToIframe(content: string) {
		const iframe = this._iframe;
		if (!iframe) return;
		iframe.srcdoc = prepareIsolatedInlineHtml(content, readInlineTheme());
		this._lastAppliedContent = content;
	}

	private _scheduleUpdate(content: string) {
		this._pendingContent = content;
		if (this._debounceTimer) return;
		this._debounceTimer = setTimeout(() => {
			this._debounceTimer = null;
			if (this._pendingContent && this._pendingContent !== this._lastAppliedContent) {
				this._writeToIframe(this._pendingContent);
				this._pendingContent = null;
			}
		}, 1500);
	}

	/** Throttle the code string for code-block (~4x/sec). */
	private _getThrottledCode(content: string): string {
		if (!this._codeThrottleTimer) {
			this._throttledCode = content;
			this._codeThrottleTimer = setTimeout(() => {
				this._codeThrottleTimer = null;
			}, 250);
		}
		return this._throttledCode;
	}

	/** Reset streaming state so the next tool call starts fresh. */
	private _resetStreamingState() {
		this._iframe = null;
		this._lastAppliedContent = null;
		this._pendingContent = null;
		this._throttledCode = "";
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
			this._debounceTimer = null;
		}
		if (this._codeThrottleTimer) {
			clearTimeout(this._codeThrottleTimer);
			this._codeThrottleTimer = null;
		}
	}

	render(
		params: HtmlWriteParams | undefined,
		result: ToolResultMessage<any> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const headerText = params?.path ? `HTML ${params.path}` : "HTML";

		if (result?.isError) {
			const output = result.content
				?.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n") || "";
			return {
				content: html`
					<div class="space-y-3">
						${renderHeader(state, AppWindow, headerText)}
						<div class="text-sm ${isSkippedToolResult(result) ? 'text-amber-600 dark:text-amber-400' : 'text-destructive'}">${output}</div>
					</div>
				`,
				isCustom: false,
			};
		}

		const htmlContent = params?.content || "";
		const hasHtml = htmlContent.includes("<") && (
			htmlContent.includes("<html") ||
			htmlContent.includes("<body") ||
			htmlContent.includes("<div") ||
			htmlContent.includes("<!DOCTYPE") ||
			htmlContent.includes("<svg")
		);

		if (!hasHtml) {
			return { content: renderHeader(state, AppWindow, headerText), isCustom: false };
		}

		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();
		const isComplete = !!result && !result.isError;

		// ── COMPLETED: declarative srcdoc binding ──
		// Lit only updates the .srcdoc property when the value changes,
		// so equivalent parent re-renders do not reload the iframe.
		if (isComplete) {
			this._resetStreamingState();
			const preparedHtml = prepareIsolatedInlineHtml(htmlContent, readInlineTheme());
			const completedIframeSetup = this._themedIframeRef();
			const onLoad = (event: Event) => this._postTheme(event.target as HTMLIFrameElement);

			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, AppWindow, headerText, contentRef, chevronRef, false)}
						<div class="mt-3 rounded-lg border border-border overflow-hidden" style="position: relative;">
							<iframe
								${ref(completedIframeSetup)}
								.srcdoc=${preparedHtml}
								sandbox="allow-scripts"
								@load=${onLoad}
								style="width: 100%; height: 300px; border: none; background: var(--background, Canvas);"
								title=${params?.path || "HTML preview"}
							></iframe>
						</div>
						<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
							<code-block .code=${htmlContent} language="html"></code-block>
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		// ── STREAMING: debounced srcdoc replacement ──
		const streamingIframeSetup = this._themedIframeRef((iframe) => {
			if (iframe === this._iframe) {
				if (htmlContent !== this._lastAppliedContent) this._scheduleUpdate(htmlContent);
				return;
			}

			this._iframe = iframe;
			this._lastAppliedContent = null;
			this._writeToIframe(htmlContent);
		});
		const onStreamingLoad = (event: Event) => this._postTheme(event.target as HTMLIFrameElement);

		return {
			content: html`
				<div>
					${renderCollapsibleHeader(state, AppWindow, headerText, contentRef, chevronRef, false)}
					<div class="mt-3 rounded-lg border border-border overflow-hidden" style="position: relative;">
						<iframe
							${ref(streamingIframeSetup)}
							sandbox="allow-scripts"
							@load=${onStreamingLoad}
							style="width: 100%; height: 300px; border: none; background: var(--background, Canvas);"
							title=${params?.path || "HTML preview"}
						></iframe>
						<div style="
							position: absolute; inset: 0; z-index: 10;
							background: color-mix(in oklch, var(--background, Canvas) 20%, transparent);
							display: flex; align-items: center; justify-content: center;
							pointer-events: none;
						">
							<style>
								@keyframes html-renderer-spin {
									to { transform: rotate(360deg); }
								}
							</style>
							<div style="
								width: 20px; height: 20px;
								border: 2px solid color-mix(in oklch, var(--foreground, CanvasText) 15%, transparent);
								border-top-color: color-mix(in oklch, var(--foreground, CanvasText) 60%, transparent);
								border-radius: 50%;
								animation: html-renderer-spin 0.8s linear infinite;
							"></div>
						</div>
					</div>
					<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
						<code-block .code=${this._getThrottledCode(htmlContent)} language="html"></code-block>
					</div>
				</div>
			`,
			isCustom: false,
		};
	}
}
