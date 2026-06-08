// src/app/host-api.ts
//
// Phase-1 CLIENT implementation of the frozen Bobbit Extension Host API
// (design docs/design/extension-host.md §3 + §4c). This is the ONLY way a pack
// renderer touches Bobbit internals — every capability is mediated here.
//
// `getHostApi(sessionId, toolUseId)` binds the API to BOTH the gateway session
// id AND the renderer's own tool_use id, so `invokeAction(tool, action, args)`
// keeps its clean frozen signature while still supplying identity to the action
// endpoint internally (packs never put identity fields in `args`).
//
// Phase-1 implements ONLY `gateway.fetch`, `requestRender`, and `invokeAction`.
// The Phase-2 namespaces (`session`/`ui`/`store`) throw a loud "reserved for
// Phase 2" error so misuse is obvious, not silent.

import { HOST_API_VERSION, type HostApi } from "../shared/extension-host/host-api.js";
import { gatewayFetch } from "./gateway-fetch.js";
import { renderApp } from "./state.js";

/** Add the `x-bobbit-session-id` header to a fetch init, mirroring the
 *  propagation `defaults/tools/agent/extension.ts` uses (server reads it at
 *  server.ts:9030/10953). `gatewayFetch` supplies the Authorization bearer;
 *  callers must NOT pass their own. When no session is bound, the header is
 *  omitted and `gatewayFetch` behaves exactly as before. */
function withSession(init: RequestInit | undefined, sessionId: string | undefined): RequestInit {
	if (!sessionId) return init ?? {};
	return {
		...init,
		headers: {
			...(init?.headers ?? {}),
			"x-bobbit-session-id": sessionId,
		},
	};
}

/** Build the Phase-1 client Host API bound to a given session AND the
 *  renderer's own toolUseId. `invokeAction` supplies BOTH to the endpoint
 *  internally, so packs never put identity fields in `args`. Phase-2 namespaces
 *  throw a clear "not implemented in Phase 1" error so misuse is loud. */
export function getHostApi(sessionId: string | undefined, toolUseId: string | undefined): HostApi {
	const notImpl = (m: string): never => {
		throw new Error(`host.${m} is reserved for Phase 2`);
	};
	return {
		version: HOST_API_VERSION,
		gateway: {
			fetch: (path, init) => gatewayFetch(path, withSession(init, sessionId)),
		},
		requestRender: () => {
			try {
				renderApp();
			} catch {
				/* non-DOM (unit fixtures) — no-op */
			}
		},
		async invokeAction(tool, action, args) {
			// sessionId + toolUseId come from the BOUND render context, NOT from
			// args. args is pure action-domain input, validated/whitelisted by the
			// handler server-side.
			const resp = await gatewayFetch(
				`/api/tools/${encodeURIComponent(tool)}/actions/${encodeURIComponent(action)}`,
				withSession(
					{ method: "POST", body: JSON.stringify({ sessionId, toolUseId, args }) },
					sessionId,
				),
			);
			if (!resp.ok) throw new Error(`invokeAction ${tool}/${action} HTTP ${resp.status}`);
			return resp.json();
		},
		// ── Phase 2 (frozen, not implemented) ──
		session: {
			readTranscript: () => notImpl("session.readTranscript"),
			readToolCall: () => notImpl("session.readToolCall"),
			postMessage: () => notImpl("session.postMessage"),
			subscribe: () => notImpl("session.subscribe"),
		} as HostApi["session"],
		ui: {
			openPanel: () => notImpl("ui.openPanel"),
			navigate: () => notImpl("ui.navigate"),
		} as HostApi["ui"],
		store: {
			get: () => notImpl("store.get"),
			put: () => notImpl("store.put"),
			list: () => notImpl("store.list"),
		} as HostApi["store"],
	};
}
