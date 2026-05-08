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
