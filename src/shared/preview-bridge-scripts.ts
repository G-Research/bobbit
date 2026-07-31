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

/** Script that mirrors the host app's theme/palette/CSS-variables into the
 *  preview iframe so dark/light/palette toggles are reflected immediately. */
export const PREVIEW_THEME_BRIDGE = `<script>
(function() {
	try {
		/* Standalone tab (Open-in-new-tab): parent === window, so there is no
		   host-app document to mirror. The server-injected inline <style data-bobbit-preview-theme>
		   snapshot defines :root/.dark defaults — early return and let it govern.
		   Embedded iframes (parent !== window) continue past this guard so live
		   theme toggles in the host app flow through. */
		if (parent === window) return;

		/* A repeated canonical bridge in the same document must not install
		   another observer. document.open() keeps the Window but replaces the
		   root, so streaming rewrites intentionally install for the new root. */
		var installKey = '__bobbitPreviewThemeBridgeInstalled_v1__';
		var root = document.documentElement;
		var previousInstall = window[installKey];
		if (previousInstall && previousInstall.root === root) return;
		if (previousInstall && previousInstall.observer) {
			try { previousInstall.observer.disconnect(); } catch(e) {}
		}
		var install = { root: root, observer: null };
		window[installKey] = install;

		var parentDocument = parent.document;
		var parentRoot = parentDocument.documentElement;

		function sync() {
			try {
				var parentStyles = parent.getComputedStyle(parentRoot);

				/* Mirror dark class */
				root.classList.toggle('dark', parentRoot.classList.contains('dark'));

				/* Mirror data-palette attribute */
				var palette = parentRoot.getAttribute('data-palette');
				if (palette) root.setAttribute('data-palette', palette);
				else root.removeAttribute('data-palette');

				/* Copy all CSS custom properties from the app stylesheet */
				var vars = [];
				try {
					for (var s = 0; s < parentDocument.styleSheets.length; s++) {
						var sheet = parentDocument.styleSheets[s];
						try {
							var rules = sheet.cssRules || sheet.rules;
							for (var r = 0; r < rules.length; r++) {
								var rule = rules[r];
								if (rule.style) {
									for (var i = 0; i < rule.style.length; i++) {
										var name = rule.style[i];
										if (name.startsWith('--')) vars.push(name);
									}
								}
							}
						} catch(e) { /* cross-origin sheet, skip */ }
					}
				} catch(e) {}

				/* Deduplicate and copy computed values */
				var seen = {};
				for (var v = 0; v < vars.length; v++) {
					if (seen[vars[v]]) continue;
					seen[vars[v]] = true;
					var val = parentStyles.getPropertyValue(vars[v]);
					if (val) root.style.setProperty(vars[v], val);
				}

				/* Copy the app font stack alongside every live theme sync. */
				root.style.fontFamily = parentStyles.fontFamily;
			} catch(e) { /* transient parent/style access failure — keep authored HTML running */ }
		}

		/* Initial sync */
		sync();

		/* Watch for class/attribute changes on the parent root element */
		var observer = new MutationObserver(sync);
		install.observer = observer;
		observer.observe(parentRoot, { attributes: true, attributeFilter: ['class', 'data-palette', 'style'] });
	} catch(e) { /* cross-origin or other error — degrade gracefully */ }
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

/** Combined static bridge scripts — convenient single string for server-side injection. */
export const PREVIEW_BRIDGE_SCRIPTS = PREVIEW_THEME_BRIDGE + PREVIEW_SWIPE_SCRIPT;

export const PREVIEW_NAVIGATION_MESSAGE_TYPE = "bobbit-preview-navigate";

function scriptString(value: string): string {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

function htmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * Keep asset resolution on generation-bound authority while handing document
 * navigation back to an ambient-authenticated browser context. Embedded opaque
 * frames ask their validated parent to navigate the exact iframe; standalone
 * popouts perform a top-level same-site navigation and retain `noopener`.
 */
export function previewNavigationBridge(): string {
	return `<script data-bobbit-preview-navigation>
(function() {
	var MESSAGE_TYPE = ${scriptString(PREVIEW_NAVIGATION_MESSAGE_TYPE)};
	function within(pathname, base) {
		return pathname === base || pathname.indexOf(base.endsWith('/') ? base : base + '/') === 0;
	}
	// Derive every navigation boundary from the marked base after the response
	// reaches the browser. Source Vite rebases that element from a mounted
	// gateway to its root origin, while production leaves it mounted. Keeping no
	// server-path constants here prevents those two authorities from drifting.
	var markedBases = document.querySelectorAll('base[' + 'data-bobbit-preview-' + 'base]');
	if (markedBases.length !== 1) return;
	var capabilityBase;
	var canonicalBase;
	var canonicalDocument;
	try {
		capabilityBase = new URL(markedBases[0].href, location.href);
		var marker = capabilityBase.pathname.lastIndexOf('/_content/');
		if (marker < 0 || capabilityBase.search || capabilityBase.hash) return;
		var capabilitySuffix = capabilityBase.pathname.slice(marker + '/_content/'.length);
		if (!/^[A-Za-z0-9_-]{43}\\/$/.test(capabilitySuffix)) return;
		canonicalBase = new URL(capabilityBase.href);
		canonicalBase.pathname = capabilityBase.pathname.slice(0, marker + 1);
		var previewMarker = canonicalBase.pathname.lastIndexOf('/preview/');
		if (previewMarker < 0) return;
		var scopeSegments = canonicalBase.pathname.slice(previewMarker + '/preview/'.length).split('/').filter(Boolean);
		var liveScope = scopeSegments.length === 1;
		if (!liveScope && !(scopeSegments.length === 3 && scopeSegments[1] === '_artifact')) return;
		canonicalDocument = new URL(location.href);
		if (canonicalDocument.origin !== capabilityBase.origin
			|| !within(canonicalDocument.pathname, canonicalBase.pathname)) return;
		var documentRelative = canonicalDocument.pathname.slice(canonicalBase.pathname.length);
		if (documentRelative === '_content' || documentRelative.indexOf('_content/') === 0) return;
	} catch (_) { return; }
	function crossesScope(relative) {
		return relative === '_content' || relative.indexOf('_content/') === 0
			|| (liveScope && (relative === '_artifact' || relative.indexOf('_artifact/') === 0));
	}
	function canonicalTarget(raw) {
		if (typeof raw !== 'string' || !raw) return null;
		if (raw.charAt(0) === '#') return new URL(raw, canonicalDocument.href).href;
		var requested;
		try { requested = new URL(raw, document.baseURI); } catch (_) { return null; }
		if (requested.origin !== capabilityBase.origin) return null;
		if (within(requested.pathname, capabilityBase.pathname)) {
			var suffix = requested.pathname.slice(capabilityBase.pathname.length);
			if (crossesScope(suffix)) return null;
			var target = new URL(canonicalBase.href);
			target.pathname = canonicalBase.pathname + suffix;
			target.search = requested.search;
			target.hash = requested.hash;
			return target.href;
		}
		if (!within(requested.pathname, canonicalBase.pathname)) return null;
		return crossesScope(requested.pathname.slice(canonicalBase.pathname.length)) ? null : requested.href;
	}
	function handoff(target) {
		if (parent === window) location.assign(target);
		else parent.postMessage({ type: MESSAGE_TYPE, url: target }, '*');
	}
	// Programmatic and nested-frame document loads first receive a fixed inert
	// handoff document at the capability URL. Relay
	// only messages from a direct child browsing context; each canonical preview
	// document repeats this check, so deeply nested frames reach the app through
	// a source-validated chain without granting document authority to the asset
	// capability.
	window.addEventListener('message', function(event) {
		if (!event.data || event.data.type !== MESSAGE_TYPE) return;
		var frames = document.querySelectorAll('iframe,frame');
		var owned = false;
		for (var i = 0; i < frames.length; i++) {
			try {
				if (frames[i].contentWindow === event.source) { owned = true; break; }
			} catch (_) {}
		}
		if (!owned) return;
		var target = canonicalTarget(event.data.url);
		if (target) handoff(target);
	});
	// Chromium resolves meta refresh against the document URL rather than the
	// marked asset base. Capture same-scope refresh directives as they are parsed
	// so an opaque document cannot lose its ambient cookie on the native load.
	function captureMetaRefresh(meta) {
		if (!meta || String(meta.getAttribute('http-equiv') || '').trim().toLowerCase() !== 'refresh') return;
		var content = String(meta.getAttribute('content') || '');
		var parsed = /^\\s*(\\d+(?:\\.\\d+)?)\\s*(?:;\\s*(?:url\\s*=\\s*)?(.+?))?\\s*$/i.exec(content);
		if (!parsed) return;
		var raw = parsed[2] || canonicalDocument.href;
		if ((raw.charAt(0) === '"' && raw.charAt(raw.length - 1) === '"')
			|| (raw.charAt(0) === "'" && raw.charAt(raw.length - 1) === "'")) raw = raw.slice(1, -1);
		var target = canonicalTarget(raw);
		if (!target) return;
		meta.removeAttribute('http-equiv');
		var delay = Math.max(0, Number(parsed[1]) * 1000);
		setTimeout(function() { handoff(target); }, Number.isFinite(delay) ? delay : 0);
	}
	function inspectMetaRefresh(node) {
		if (!node || node.nodeType !== 1) return;
		if (String(node.tagName).toLowerCase() === 'meta') captureMetaRefresh(node);
		var metas = node.querySelectorAll ? node.querySelectorAll('meta[http-equiv]') : [];
		for (var i = 0; i < metas.length; i++) captureMetaRefresh(metas[i]);
	}
	inspectMetaRefresh(document.documentElement);
	new MutationObserver(function(records) {
		for (var i = 0; i < records.length; i++) {
			if (records[i].type === 'attributes') inspectMetaRefresh(records[i].target);
			for (var j = 0; j < records[i].addedNodes.length; j++) inspectMetaRefresh(records[i].addedNodes[j]);
		}
	}).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['http-equiv', 'content'] });
	document.addEventListener('click', function(event) {
		if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		var node = event.target;
		while (node && node.nodeType === 1 && String(node.tagName).toLowerCase() !== 'a') node = node.parentElement;
		if (!node || String(node.tagName).toLowerCase() !== 'a' || node.hasAttribute('download')) return;
		var targetName = (node.getAttribute('target') || '_self').toLowerCase();
		if (targetName !== '_self') return;
		var target = canonicalTarget(node.getAttribute('href'));
		if (!target) return;
		event.preventDefault();
		handoff(target);
	}, true);
	document.addEventListener('submit', function(event) {
		if (event.defaultPrevented) return;
		var form = event.target;
		if (!form || String(form.tagName).toLowerCase() !== 'form') return;
		var submitter = event.submitter;
		var method = String((submitter && submitter.getAttribute('formmethod')) || form.getAttribute('method') || 'get').toLowerCase();
		var targetName = String((submitter && submitter.getAttribute('formtarget')) || form.getAttribute('target') || '_self').toLowerCase();
		if (method !== 'get' || targetName !== '_self') return;
		var rawAction = (submitter && submitter.getAttribute('formaction')) || form.getAttribute('action') || canonicalDocument.href;
		var target = canonicalTarget(rawAction);
		if (!target) return;
		var url = new URL(target);
		new FormData(form).forEach(function(value, name) {
			url.searchParams.append(name, typeof value === 'string' ? value : value.name);
		});
		event.preventDefault();
		handoff(url.href);
	}, true);
})();
<\/script>`;
}

/**
 * Fixed script for a capability-path document navigation. The server returns
 * this bridge instead of any agent-authored file bytes. It derives the
 * canonical ambient-auth URL solely from the response-rebased marked base and
 * its own browser URL, then either navigates a standalone popout or asks its
 * direct parent to relay the target. The canonical preview bridge above
 * source-validates each nested relay; the app validates the top-level iframe.
 */
export function previewNavigationHandoffBridge(): string {
	return `<script data-bobbit-preview-navigation-handoff>
(function() {
	var MESSAGE_TYPE = ${scriptString(PREVIEW_NAVIGATION_MESSAGE_TYPE)};
	function within(pathname, base) {
		return pathname === base || pathname.indexOf(base.endsWith('/') ? base : base + '/') === 0;
	}
	var markedBases = document.querySelectorAll('base[' + 'data-bobbit-preview-' + 'base]');
	if (markedBases.length !== 1) return;
	var capabilityBase;
	var current;
	try {
		capabilityBase = new URL(markedBases[0].href, location.href);
		current = new URL(location.href);
		var marker = capabilityBase.pathname.lastIndexOf('/_content/');
		if (marker < 0 || capabilityBase.search || capabilityBase.hash) return;
		var capabilitySuffix = capabilityBase.pathname.slice(marker + '/_content/'.length);
		if (!/^[A-Za-z0-9_-]{43}\\/$/.test(capabilitySuffix)) return;
		if (current.origin !== capabilityBase.origin || !within(current.pathname, capabilityBase.pathname)) return;
		var canonicalBase = new URL(capabilityBase.href);
		canonicalBase.pathname = capabilityBase.pathname.slice(0, marker + 1);
		var previewMarker = canonicalBase.pathname.lastIndexOf('/preview/');
		if (previewMarker < 0) return;
		var scopeSegments = canonicalBase.pathname.slice(previewMarker + '/preview/'.length).split('/').filter(Boolean);
		var liveScope = scopeSegments.length === 1;
		if (!liveScope && !(scopeSegments.length === 3 && scopeSegments[1] === '_artifact')) return;
		var relative = current.pathname.slice(capabilityBase.pathname.length);
		if (relative === '_content' || relative.indexOf('_content/') === 0
			|| (liveScope && (relative === '_artifact' || relative.indexOf('_artifact/') === 0))) return;
		var target = new URL(canonicalBase.href);
		target.pathname = canonicalBase.pathname + relative;
		target.search = current.search;
		target.hash = current.hash;
		if (!within(target.pathname, canonicalBase.pathname)) return;
		if (parent === window) location.replace(target.href);
		else parent.postMessage({ type: MESSAGE_TYPE, url: target.href }, '*');
	} catch (_) { return; }
})();
<\/script>`;
}

/** Return the complete, authored-byte-free navigation handoff document. */
export function previewNavigationHandoffDocument(publicCapabilityBaseHref: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><base data-bobbit-preview-base href="${htmlAttribute(publicCapabilityBaseHref)}"></head><body>${previewNavigationHandoffBridge()}</body></html>`;
}

/**
 * Parent-side validation for an opaque-frame navigation handoff. The source
 * window check is owned by the caller; this helper proves the requested URL is
 * same-origin and remains inside the exact live/artifact preview scope already
 * loaded in that iframe. Capability routes are never accepted as documents.
 */
export function validatedPreviewNavigationTarget(currentIframeSrc: string, requestedHref: unknown): string | null {
	if (typeof requestedHref !== "string" || !requestedHref || /[\\\u0000-\u001f\u007f]/u.test(requestedHref)) return null;
	let current: URL;
	let requested: URL;
	try {
		current = new URL(currentIframeSrc);
		requested = new URL(requestedHref);
	} catch {
		return null;
	}
	if (!/^https?:$/.test(current.protocol)
		|| requested.protocol !== current.protocol
		|| requested.origin !== current.origin
		|| requested.username
		|| requested.password) return null;
	const marker = current.pathname.lastIndexOf("/preview/");
	if (marker < 0) return null;
	const prefix = current.pathname.slice(0, marker + "/preview/".length);
	const remainder = current.pathname.slice(prefix.length);
	const segments = remainder.split("/");
	const sessionId = segments[0] ?? "";
	if (!sessionId || !/^[A-Za-z0-9._~-]+$/.test(sessionId)) return null;
	let scope = `${prefix}${sessionId}/`;
	const artifactScope = segments[1] === "_artifact";
	if (artifactScope) {
		const artifactId = segments[2] ?? "";
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(artifactId)) return null;
		scope += `_artifact/${artifactId}/`;
	}
	if (!requested.pathname.startsWith(scope)) return null;
	const relative = requested.pathname.slice(scope.length);
	if (relative === "_content" || relative.startsWith("_content/")
		|| (!artifactScope && (relative === "_artifact" || relative.startsWith("_artifact/")))) return null;
	return requested.href;
}

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
