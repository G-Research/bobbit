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
	type HostRouteInit,
	type ReadTranscriptOpts,
	type TranscriptEnvelope,
	type ToolCallRecord,
	type PostMessageInput,
	type HostSessionEventName,
	type HostSessionEventMap,
} from "../shared/extension-host/host-api.js";
import { gatewayFetch } from "./gateway-fetch.js";
import { renderApp } from "./state.js";
import { requestToolRender } from "../ui/tools/renderer-registry.js";
import { openPackPanel, setPanelHostFactory } from "./pack-panels.js";
import { consumeGesture } from "./gesture-context.js";
import { postSessionMessageOverWs } from "./session-write-bridge.js";
import { subscribeHostSessionEvent } from "./session-event-bus.js";
import { navigateToTarget } from "./pack-entrypoints.js";

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
// Slice D1 (design §2a.2): give pack PANELS a host API bound to the active session
// + the panel's own pack tool, so `panel.render(params, host)` can reach the
// scoped capabilities (`store`/`callRoute`/`session`). A panel originates no tool
// call, so `toolUseId` is undefined (authorizeScopedRequest needs none). Registered
// from host-api (which already imports pack-panels) so pack-panels stays free of a
// reverse import cycle.
setPanelHostFactory((sessionId, packTool) => getHostApi(sessionId, undefined, packTool));

export function getHostApi(
	sessionId: string | undefined,
	toolUseId: string | undefined,
	packTool?: string,
): HostApi {
	// `packTool` (Slice A) is the tool name whose pack owns this renderer. It is
	// held in closure for the scoped Phase-2 capabilities (callRoute/store/session)
	// to send as `tool` so the server can derive the trusted packId (the client
	// never sends a packId — design extension-host-phase2.md §2.3). Every Phase-2
	// capability now has a real body (B1/B2/B3/B4/C1/C2), so no `notImpl` stub remains.
	// Slice B1: POST a store op to /api/ext/store/:op, sending the bound `packTool`
	// as `tool` so the server derives the trusted packId (client never sends one).
	const storeOp = async (op: "get" | "put" | "list", payload: Record<string, unknown>): Promise<unknown> => {
		if (!packTool) throw new Error("host.store requires a pack-served renderer context");
		const resp = await gatewayFetch(
			`/api/ext/store/${op}`,
			withSession(
				{ method: "POST", body: JSON.stringify({ sessionId, toolUseId, tool: packTool, ...payload }) },
				sessionId,
			),
		);
		if (!resp.ok) throw new Error(`store.${op} HTTP ${resp.status}`);
		return resp.json();
	};
	// Phase-1 host: only invokeAction + requestRender are implemented. `capabilities`
	// is the single source of truth; the throwing stubs below exist only for type
	// stability and MUST NOT be feature-detected by member presence.
	const flags = {
		invokeAction: true,
		requestRender: true,
		callRoute: true,
		// Slice C2 flips `session` (reads B2 + writes C2); Slice C1 flips `ui`
		// (openPanel B4 + navigate C1). With store (B1) + callRoute (B3) all Phase-2
		// capabilities are now live (capability-signaling convention, design §0).
		session: true,
		ui: true,
		store: true,
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
		// ── Phase 2 ──
		// Slice B3: POST to /api/ext/route/:name, sending the bound `packTool` as
		// `tool` so the server authorizes the caller + derives the trusted packId (the
		// client never knows/sends a packId). The server then resolves the route MODULE
		// via the pack-level RouteRegistry (opener-independent) and dispatches it. The
		// route is addressed by `name` within the pack's namespace — never a raw URL.
		async callRoute<TResult = unknown>(name: string, init?: HostRouteInit): Promise<TResult> {
			if (!packTool) throw new Error("host.callRoute requires a pack-served renderer context");
			const resp = await gatewayFetch(
				`/api/ext/route/${encodeURIComponent(name)}`,
				withSession(
					{ method: "POST", body: JSON.stringify({ sessionId, toolUseId, tool: packTool, init }) },
					sessionId,
				),
			);
			if (!resp.ok) throw new Error(`callRoute ${name} HTTP ${resp.status}`);
			return resp.json() as Promise<TResult>;
		},
		session: {
			// Slice B2: own-session READS over the namespaced /api/ext endpoints. The
			// server scopes the read to the HEADER-BOUND session (own-session by
			// construction — no other-session parameter). `tool` lets the server derive
			// the trusted packId + gate on allowedTools (same guard as invokeAction).
			// NOTE: `flags.session` stays FALSE until C2 wires writes — these bodies are
			// internal-only until the whole namespace flips live (capability-signaling).
			readTranscript: async (opts?: ReadTranscriptOpts): Promise<TranscriptEnvelope> => {
				const params = new URLSearchParams();
				if (sessionId) params.set("sessionId", sessionId);
				if (packTool) params.set("tool", packTool);
				if (opts?.offset != null) params.set("offset", String(opts.offset));
				if (opts?.limit != null) params.set("limit", String(opts.limit));
				if (opts?.pattern) params.set("pattern", opts.pattern);
				const resp = await gatewayFetch(
					`/api/ext/session/transcript?${params.toString()}`,
					withSession({ method: "GET" }, sessionId),
				);
				if (!resp.ok) throw new Error(`session.readTranscript HTTP ${resp.status}`);
				return resp.json();
			},
			readToolCall: async (toolUseId: string): Promise<ToolCallRecord | null> => {
				const params = new URLSearchParams();
				if (sessionId) params.set("sessionId", sessionId);
				if (packTool) params.set("tool", packTool);
				params.set("toolUseId", toolUseId);
				const resp = await gatewayFetch(
					`/api/ext/session/tool-call?${params.toString()}`,
					withSession({ method: "GET" }, sessionId),
				);
				if (!resp.ok) throw new Error(`session.readToolCall HTTP ${resp.status}`);
				return resp.json();
			},
			// Slice C2: WRITE — post a user/system message into the BOUND session,
			// optionally resuming the agent turn. Drives the agent, so it has two
			// independent gates:
			//   1. TRANSPORT (unforgeable): the SEND rides the app's authenticated session
			//      WebSocket via `postSessionMessageOverWs` — NOT a `fetch`. There is no
			//      session secret on any request for a same-realm pack to monkey-patch /
			//      capture / replay, and pack code has no handle to the WS so it cannot send
			//      on it. The server targets the WS connection's OWN authenticated session,
			//      authorizes the pack's `tool` ∈ allowedTools, derives the packId, and
			//      audits every post; cross-session posting is structurally impossible.
			//   2. REAL user activation (defense-in-depth) — consumeGesture() reads
			//      navigator.userActivation SYNCHRONOUSLY at the prologue (before any await)
			//      and THROWS when no genuine user gesture is active, so a render/mount-time
			//      post fails loudly. A pack cannot fabricate transient activation.
			postMessage: (msg: PostMessageInput): Promise<void> => {
				// SYNCHRONOUS activation check (NOT inside the async body — an async throw
				// would be a rejected promise, not a loud synchronous failure on mount).
				if (!consumeGesture()) throw new Error("postMessage requires a user gesture");
				if (!packTool) throw new Error("host.session.postMessage requires a pack-served context");
				// Drive over the trusted WS (no fetch, no secret). `sessionId` selects the
				// bound RemoteAgent's poster; the server ignores it as a target.
				return postSessionMessageOverWs({
					sessionId,
					tool: packTool,
					role: msg.role,
					text: msg.text,
					resumeTurn: msg.resumeTurn,
				});
			},
			// Slice C2: subscribe to live, TYPED session events bridged from the session
			// WebSocket onto the frozen HostSessionEventMap (contract shapes via the
			// client internal→contract mapper). Scoped to the BOUND session; returns an
			// unsubscribe fn. No server round-trip — the per-session RemoteAgent feeds the bus.
			subscribe: <E extends HostSessionEventName>(
				event: E,
				cb: (payload: HostSessionEventMap[E]) => void,
			): (() => void) => subscribeHostSessionEvent(sessionId, event, cb),
		} as HostApi["session"],
		ui: {
			// Slice B4: open (or focus) a pack-contributed side panel via the client
			// pack-panel registry (lazy Blob-URL import + mount).
			openPanel: (target) => openPackPanel(target),
			// Slice C1: navigate the SPA to a pack-contributed deep-link route by
			// STRUCTURED target. `navigateToTarget` resolves `target.route` through the
			// client pack-route registry, filters params to the route's declared
			// paramKeys, and serializes `#/ext/<routeId>?<params>` via the router — the
			// pack never builds a URL (v1 §3 structured addressing). Unknown route =
			// no-op (e.g. owning pack uninstalled).
			navigate: (target) => navigateToTarget(target),
		} as HostApi["ui"],
		store: {
			get: async (key: string) => (await storeOp("get", { key })) as never,
			put: async (key: string, value: unknown) => {
				await storeOp("put", { key, value });
			},
			list: async (prefix?: string) => (await storeOp("list", { prefix })) as string[],
		} as HostApi["store"],
	};
}
