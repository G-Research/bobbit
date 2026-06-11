/**
 * Theme preference normalization.
 *
 * The shared `<theme-toggle>` (from @mariozechner/mini-lit) renders a "system"
 * (Monitor) glyph whenever the stored `theme` is `"system"` — which is the
 * value it falls back to when `localStorage.theme` is unset. We never want to
 * surface that ambiguous icon: the toggle should always show the *current*
 * theme (Sun / Moon) and only ever cycle between light and dark.
 *
 * To achieve that without forking the third-party component, we pin the stored
 * preference to the resolved effective theme at boot whenever it isn't already
 * an explicit `"light"` / `"dark"`. This must run before the first
 * `<theme-toggle>` is constructed (it reads `localStorage` in its constructor),
 * so this module is imported at the very top of `main.ts`.
 */
export function normalizeThemePreference(): void {
	if (typeof window === "undefined" || typeof localStorage === "undefined") return;
	const stored = localStorage.getItem("theme");
	if (stored === "light" || stored === "dark") return;
	const prefersDark = typeof window.matchMedia === "function"
		&& window.matchMedia("(prefers-color-scheme: dark)").matches;
	localStorage.setItem("theme", prefersDark ? "dark" : "light");
}

normalizeThemePreference();
