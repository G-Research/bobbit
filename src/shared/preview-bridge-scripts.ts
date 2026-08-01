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
