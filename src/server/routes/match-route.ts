/**
 * Linear-scan route matcher. With anchored regexes (pinned by unit test) at
 * most one route matches a given (method, pathname) — we scan in registration
 * order purely for robustness against accidental ordering bugs.
 */
import type { Route } from "./types.js";

export function matchRoute(
	method: string,
	pathname: string,
	routes: ReadonlyArray<Route>,
): { route: Route; params: string[] } | null {
	for (const r of routes) {
		if (r.method !== method && r.method !== "*") continue;
		if (typeof r.pattern === "string") {
			if (r.pattern === pathname) return { route: r, params: [pathname] };
		} else {
			const m = pathname.match(r.pattern);
			if (m) return { route: r, params: Array.from(m) };
		}
	}
	return null;
}
