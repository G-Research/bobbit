// Lazy loader for <transparency-panel>.
//
// The panel is cold-path UI: it only appears on turns with recorded
// transparency decisions. Keep the loader dependency-free so the panel's
// presentation helpers stay out of the session runtime chunk until needed.

let loaded = false;

export function ensureTransparencyPanel(): void {
	if (loaded) return;
	loaded = true;
	import("../components/TransparencyPanel.js").catch((err) => {
		loaded = false;
		console.warn("[transparency-panel] failed to load component", err);
	});
}
