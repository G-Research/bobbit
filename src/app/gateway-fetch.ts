// Tiny standalone module — kept dependency-free so utilities like
// `src/ui/utils/fetch-tool-content.ts` can import a `fetch()` wrapper
// without dragging the entire `src/app/api.ts` graph (render.ts,
// session-manager.ts, dialogs.ts, ReviewDocument.ts, recogito, …) into
// downstream bundles. Test fixtures that bundle `Messages.ts` previously
// pulled ~9 MB of unrelated app shell purely because of this transitive
// import; splitting `gatewayFetch` out shrinks them dramatically and
// removes the `__ready` flake under parallel-worker contention.
//
// Keep this file dependency-free.

export const GW_URL_KEY = "gateway.url";
export const GW_TOKEN_KEY = "gateway.token";

/**
 * Copy a `HeadersInit` into a plain object while DROPPING any `Authorization`
 * header (case-insensitive). The Host API is the single security choke point
 * (extension-host.md §5.1): the injected admin bearer must always win, so a
 * renderer-/extension-supplied `Authorization` is stripped here before the host
 * API delegates to `gatewayFetch`. Tolerates `Headers`, `[k,v][]`, and plain
 * object header shapes. Kept here (the dependency-free module) so it is
 * unit-testable in node without dragging the UI graph.
 */
export function stripAuthorizationHeaders(headers: HeadersInit | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!headers) return out;
	const put = (k: string, v: string): void => {
		if (k.toLowerCase() === "authorization") return; // injected bearer must win
		out[k] = v;
	};
	if (typeof Headers !== "undefined" && headers instanceof Headers) {
		headers.forEach((v, k) => put(k, v));
	} else if (Array.isArray(headers)) {
		for (const [k, v] of headers) put(k, String(v));
	} else {
		for (const [k, v] of Object.entries(headers as Record<string, string>)) put(k, String(v));
	}
	return out;
}

export function gatewayFetch(path: string, options: RequestInit = {}): Promise<Response> {
	const url = localStorage.getItem(GW_URL_KEY) || window.location.origin;
	const token = localStorage.getItem(GW_TOKEN_KEY) || "";
	return fetch(`${url}${path}`, {
		...options,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...options.headers,
		},
	});
}
