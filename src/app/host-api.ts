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
// Phase-1 implements ONLY `requestRender` and `invokeAction`. There is NO
// `gateway.fetch` and no raw passthrough: the action endpoint is same-origin and
// built here. The Phase-2 members (`callRoute`/`session`/`ui`/`store`) throw a
// loud "reserved for Phase 2" error so misuse is obvious, not silent;
// `host.capabilities` is the single source of truth for what is implemented.

import {
	HOST_API_VERSION,
	HOST_CONTRACT_VERSION,
	type HostApi,
} from "../shared/extension-host/host-api.js";
import { gatewayFetch } from "./gateway-fetch.js";
import { renderApp } from "./state.js";
import { requestToolRender } from "../ui/tools/renderer-registry.js";

/** Add the `x-bobbit-session-id` header to a fetch init, mirroring the
 *  propagation `defaults/tools/agent/extension.ts` uses (server reads it). The
 *  bound session is the host-API security context; `gatewayFetch` supplies the
 *  Authorization bearer. When no session is bound the header is omitted. */
function withSession(init: RequestInit | undefined, sessionId: string | undefined): RequestInit {
	const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
	if (sessionId) headers["x-bobbit-session-id"] = sessionId;
	return { ...init, headers };
}

/** Build the Phase-1 client Host API bound to a given session AND the
 *  renderer's own toolUseId. `invokeAction` supplies BOTH to the endpoint
 *  internally, so packs never put identity fields in `args`. `capabilities` is
 *  the single source of truth; the Phase-2 stubs below exist only for type
 *  stability and throw a clear "reserved for Phase 2" error.
 *
 *  This is the CLIENT-side construction; the server analogue is the internal
 *  `createServerHostApi({ sessionId, toolUseId, ... })` contract (§3.2), where
 *  pack identity is SERVER-DERIVED from the resolved winning contribution —
 *  never passed by extension code. */
export function getHostApi(sessionId: string | undefined, toolUseId: string | undefined): HostApi {
	const notImpl = (m: string): never => {
		throw new Error(`host.${m} is reserved for Phase 2`);
	};
	// Phase-1 host: only invokeAction + requestRender are implemented. `capabilities`
	// is the single source of truth; the throwing stubs below exist only for type
	// stability and MUST NOT be feature-detected by member presence.
	const flags = {
		invokeAction: true,
		requestRender: true,
		callRoute: false,
		session: false,
		ui: false,
		store: false,
	};
	return {
		version: HOST_API_VERSION,
		contractVersion: HOST_CONTRACT_VERSION,
		capabilities: {
			...flags,
			has: (name: string) => (flags as Record<string, boolean>)[name] === true,
		},
		requestRender: () => {
			// A top-down renderApp() alone does NOT re-run the memoized tool
			// components' renderers (their reactive props are unchanged), so a pack
			// renderer's post-action local state would never paint. Dispatch the
			// dedicated force-repaint event so mounted <tool-message>/<tool-group>
			// elements requestUpdate() and re-run render() — mirroring the
			// TOOL_RENDERER_LOADED_EVENT lazy-load mechanism (design §4a).
			try {
				renderApp();
			} catch {
				/* non-DOM (unit fixtures) — no-op */
			}
			requestToolRender();
		},
		async invokeAction(tool, action, args) {
			// sessionId + toolUseId come from the BOUND render context, NOT from
			// args. args is pure action-domain input, validated/whitelisted by the
			// handler server-side. The endpoint is same-origin: no caller-supplied
			// URL or Authorization header, so there is nothing to sanitize.
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
		callRoute: () => notImpl("callRoute"),
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
