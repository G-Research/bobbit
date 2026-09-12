/**
 * Theme-bridge + swipe-detection scripts injected into preview iframes.
 *
 * Shared by:
 *   - The server preview content route (`/preview/<sid>/...`) when serving
 *     `text/html` documents (injected before the closing `</body>`).
 *   - Any UI surface that still renders inline preview HTML via `srcdoc=`.
 *
 * Keep these scripts side-effect-light, idempotent, and self-contained — they
 * run in arbitrary user-supplied HTML documents.
 */

export const PREVIEW_BRIDGE_VERSION = 1 as const;

/** Cosmetic custom properties that the host is allowed to disclose to an
 * opaque preview. Keep this finite and shared with the injected validator. */
export const PREVIEW_THEME_PROPERTY_NAMES = Object.freeze([
	"--accent", "--accent-foreground", "--ansi-black", "--ansi-blue",
	"--ansi-bright-black", "--ansi-bright-blue", "--ansi-bright-cyan",
	"--ansi-bright-green", "--ansi-bright-magenta", "--ansi-bright-red",
	"--ansi-bright-white", "--ansi-bright-yellow", "--ansi-cyan", "--ansi-green",
	"--ansi-magenta", "--ansi-red", "--ansi-white", "--ansi-yellow",
	"--background", "--border", "--busy", "--card", "--card-foreground",
	"--chart-1", "--chart-1-foreground", "--chart-2", "--chart-2-foreground",
	"--chart-3", "--chart-3-foreground", "--chart-4", "--chart-4-foreground",
	"--chart-5", "--chart-5-foreground", "--chart-6", "--chart-6-foreground",
	"--foreground", "--info", "--info-foreground", "--input", "--labelled",
	"--link", "--muted", "--muted-foreground", "--negative",
	"--negative-foreground", "--notif-error-bg", "--notif-error-border",
	"--notif-error-text", "--notif-system-bg", "--notif-system-border",
	"--notif-system-text", "--notif-task-bg", "--notif-task-border",
	"--notif-task-text", "--notif-team-bg", "--notif-team-border",
	"--notif-team-text", "--popover", "--popover-foreground", "--positive",
	"--positive-foreground", "--primary", "--primary-foreground", "--ring",
	"--secondary", "--secondary-foreground", "--sidebar", "--sidebar-accent",
	"--sidebar-accent-foreground", "--sidebar-border", "--sidebar-foreground",
	"--sidebar-primary", "--sidebar-primary-foreground", "--user-msg-accent",
	"--user-msg-bg", "--user-msg-bg2", "--user-msg-shadow",
	"--user-msg-shadow2", "--warning", "--warning-foreground",
] as const);

export const PREVIEW_THEME_LIMITS = Object.freeze({
	maxProperties: 96,
	maxPropertyNameLength: 64,
	maxPropertyValueLength: 512,
	maxPaletteLength: 64,
	maxFontFamilyLength: 256,
	maxSerializedLength: 64 * 1024,
});

export type PreviewChildMessage =
	| { type: "bobbit-preview-ready"; version: 1 }
	| { type: "bobbit-preview-resize"; version: 1; height: number }
	| { type: "preview-swipe-start" }
	| { type: "preview-swipe-move"; dx: number }
	| { type: "preview-swipe-end"; dx: number };

export interface PreviewHostMessage {
	type: "bobbit-preview-theme";
	version: 1;
	dark: boolean;
	palette?: string;
	fontFamily?: string;
	properties: Record<string, string>;
}

export const PREVIEW_INITIAL_THEME_GLOBAL = "__bobbitPreviewInitialTheme_v1__";
export const INLINE_PREVIEW_THEME_ATTRIBUTE = "data-bobbit-inline-theme-snapshot";

/** Create the trusted inline bootstrap assignment. JSON metacharacters are
 * escaped so CSS text cannot end a containing script element. */
export function createPreviewInitialThemeAssignment(theme: PreviewHostMessage): string {
	const json = JSON.stringify(theme)
		.replace(/</g, "\\u003c")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
	return `window.${PREVIEW_INITIAL_THEME_GLOBAL}=${json};`;
}

const CHILD_ALLOWED_THEME_PROPERTIES = JSON.stringify(PREVIEW_THEME_PROPERTY_NAMES);
const CHILD_THEME_LIMITS = JSON.stringify(PREVIEW_THEME_LIMITS);

/** Message-only theme and resize bridge for opaque preview documents. It never
 * dereferences the parent DOM; exact parent WindowProxy identity binds input. */
export const PREVIEW_THEME_BRIDGE = `<script>
(function() {
	try {
		/* Standalone preview routes use their server-injected theme snapshot. */
		if (parent === window) return;

		var installKey = '__bobbitPreviewBridgeInstalled_v1__';
		var initialKey = '${PREVIEW_INITIAL_THEME_GLOBAL}';
		var root = document.documentElement;
		var previousInstall = window[installKey];
		if (previousInstall && previousInstall.root === root) return;
		if (previousInstall && previousInstall.resizeObserver) {
			try { previousInstall.resizeObserver.disconnect(); } catch(e) {}
		}
		var install = { root: root, resizeObserver: null, properties: {} };
		window[installKey] = install;
		var allowedNames = ${CHILD_ALLOWED_THEME_PROPERTIES};
		var allowed = {};
		for (var a = 0; a < allowedNames.length; a++) allowed[allowedNames[a]] = true;
		var limits = ${CHILD_THEME_LIMITS};

		function isRecord(value) {
			return !!value && typeof value === 'object' && !Array.isArray(value);
		}
		function hasExactKeys(value, required, optional) {
			var keys = Object.keys(value);
			if (keys.length < required.length || keys.length > required.length + optional.length) return false;
			for (var i = 0; i < required.length; i++) if (!Object.prototype.hasOwnProperty.call(value, required[i])) return false;
			for (var k = 0; k < keys.length; k++) if (required.indexOf(keys[k]) < 0 && optional.indexOf(keys[k]) < 0) return false;
			return true;
		}
		function validTheme(value) {
			if (!isRecord(value) || !hasExactKeys(value, ['type', 'version', 'dark', 'properties'], ['palette', 'fontFamily'])) return false;
			if (value.type !== 'bobbit-preview-theme' || value.version !== 1 || typeof value.dark !== 'boolean') return false;
			if (value.palette !== undefined && (typeof value.palette !== 'string' || value.palette.length > limits.maxPaletteLength || !/^[a-zA-Z0-9_-]*$/.test(value.palette))) return false;
			if (value.fontFamily !== undefined && (typeof value.fontFamily !== 'string' || value.fontFamily.length > limits.maxFontFamilyLength)) return false;
			if (!isRecord(value.properties)) return false;
			var names = Object.keys(value.properties);
			if (names.length > limits.maxProperties) return false;
			for (var i = 0; i < names.length; i++) {
				var name = names[i], propertyValue = value.properties[name];
				if (!allowed[name] || name.slice(0, 2) !== '--' || name.length > limits.maxPropertyNameLength) return false;
				if (typeof propertyValue !== 'string' || propertyValue.length > limits.maxPropertyValueLength) return false;
			}
			try { if (JSON.stringify(value).length > limits.maxSerializedLength) return false; } catch(e) { return false; }
			return true;
		}
		function applyTheme(value) {
			if (!validTheme(value)) return;
			root.classList.toggle('dark', value.dark);
			if (value.palette) root.setAttribute('data-palette', value.palette);
			else root.removeAttribute('data-palette');
			root.style.fontFamily = value.fontFamily || '';
			var next = value.properties;
			var previous = install.properties;
			var oldNames = Object.keys(previous);
			for (var i = 0; i < oldNames.length; i++) if (!Object.prototype.hasOwnProperty.call(next, oldNames[i])) root.style.removeProperty(oldNames[i]);
			var names = Object.keys(next);
			for (var n = 0; n < names.length; n++) root.style.setProperty(names[n], next[names[n]]);
			install.properties = next;
		}
		function sendHeight() {
			try {
				var bodyHeight = document.body && Number(document.body.scrollHeight) || 0;
				var rootHeight = Number(root.scrollHeight) || 0;
				var height = Math.max(bodyHeight, rootHeight) + 16;
				if (Number.isFinite(height)) parent.postMessage({type:'bobbit-preview-resize',version:1,height:height}, '*');
			} catch(e) {}
		}
		function installResize() {
			if (typeof ResizeObserver !== 'function') { sendHeight(); return; }
			try {
				var observer = new ResizeObserver(sendHeight);
				install.resizeObserver = observer;
				observer.observe(root);
				if (document.body) observer.observe(document.body);
				sendHeight();
			} catch(e) { sendHeight(); }
		}

		applyTheme(window[initialKey]);
		window.addEventListener('message', function(event) {
			if (event.source !== parent) return;
			applyTheme(event.data);
		});
		if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installResize, {once:true});
		else installResize();
		parent.postMessage({type:'bobbit-preview-ready',version:1}, '*');
	} catch(e) { /* cosmetic bridge failure must not stop authored scripts */ }
})();
<\/script>`;

/** Script that detects horizontal swipes inside the preview iframe and
 *  forwards them to the parent via postMessage so the unified panel slider
 *  can react. Vertical gestures fall through to normal browser scrolling. */
export const PREVIEW_SWIPE_SCRIPT = `<script>
(function() {
	var startX = 0, startY = 0, captured = false, decided = false;
	document.addEventListener('touchstart', function(e) {
		startX = e.touches[0].clientX;
		startY = e.touches[0].clientY;
		captured = false;
		decided = false;
	}, {passive: true});
	document.addEventListener('touchmove', function(e) {
		if (decided && !captured) return;
		var dx = e.touches[0].clientX - startX;
		var dy = e.touches[0].clientY - startY;
		if (!decided && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
			decided = true;
			captured = Math.abs(dx) > Math.abs(dy);
			if (captured) parent.postMessage({type:'preview-swipe-start'}, '*');
		}
		if (captured) {
			e.preventDefault();
			parent.postMessage({type:'preview-swipe-move', dx: dx}, '*');
		}
	}, {passive: false});
	document.addEventListener('touchend', function(e) {
		if (!captured) return;
		var dx = e.changedTouches[0].clientX - startX;
		parent.postMessage({type:'preview-swipe-end', dx: dx}, '*');
		captured = false;
		decided = false;
	}, {passive: true});
})();
<\/script>`;

/** Combined bridge scripts — convenient single string for server-side injection. */
export const PREVIEW_BRIDGE_SCRIPTS = PREVIEW_THEME_BRIDGE + PREVIEW_SWIPE_SCRIPT;

/**
 * Inject a `<base>` tag and the bridge scripts into an arbitrary HTML
 * document, used by the server's preview content route (`/preview/<sid>/...`).
 *
 * - `<base>` goes immediately after the first `<head>` opening tag, or, if
 *   no `<head>` exists, the function prepends `<head>${baseTag}</head>` to
 *   the body.
 * - Bridge scripts go immediately before the first `</body>`, or, if no
 *   `</body>` is present, are appended to the end of the document.
 *
 * No HTML parser dependency — pure string operations, matches the existing
 * `srcdoc` concatenation trade-off.
 */
export function injectBaseAndScripts(html: string, baseTag: string, scripts: string): string {
	let out = html;

	// 1. Inject <base> after first <head ...> opening tag (case-insensitive).
	const headOpenRe = /<head\b[^>]*>/i;
	const headMatch = out.match(headOpenRe);
	if (headMatch) {
		const idx = (headMatch.index ?? 0) + headMatch[0].length;
		out = out.slice(0, idx) + baseTag + out.slice(idx);
	} else {
		// No <head> at all — prepend a synthetic one.
		out = `<head>${baseTag}</head>` + out;
	}

	// 2. Inject bridge scripts before </body>, or append.
	const bodyCloseRe = /<\/body\s*>/i;
	const bodyMatch = out.match(bodyCloseRe);
	if (bodyMatch) {
		const idx = bodyMatch.index ?? out.length;
		out = out.slice(0, idx) + scripts + out.slice(idx);
	} else {
		out = out + scripts;
	}

	return out;
}
