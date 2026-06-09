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

/** sha256 hex of `role + "\n" + text` — the content binding for a C2 session-write
 *  permit. Computed with SubtleCrypto so the value matches the server's Node
 *  `createHash("sha256")` exactly (same UTF-8 input, same hex encoding). Used by
 *  `host.session.postMessage` to mint a content-bound, one-time write permit before
 *  posting (design extension-host-phase2.md §8 C2.1 + session-write-permit.ts). */
async function sessionWriteContentHash(role: string, text: string): Promise<string> {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) throw new Error("host.session.postMessage requires SubtleCrypto (secure context)");
	const bytes = new TextEncoder().encode(`${role}\n${text}`);
	const digest = await subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
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
	// `packTool` (Slice A) is the tool name whose pack owns this renderer/panel. The
	// TRUSTED app loader passes it; the Host API then MINTS a SERVER-MINTED surface
	// binding token bound to {sessionId, packId, contributionId, tool} (the server
	// resolves the winning contribution). The opaque token is captured in THIS closure
	// — pack module code never sees or sets it — and echoed on every scoped call
	// (store/callRoute/session). The server DERIVES {packId, tool} from the validated
	// token and IGNORES any caller-supplied tool/pack, closing the cross-pack identity
	// hole the bare `tool` field left open (design extension-host-phase2.md §2.3 + §10).
	// A same-realm malicious pack can still mint its own token for any tool name — the
	// documented Model-A residual (marketplace.md threat model).
	let surfaceTokenPromise: Promise<string> | undefined;
	const getSurfaceToken = (): Promise<string> => {
		if (!packTool) return Promise.reject(new Error("host scoped capabilities require a pack-served context"));
		if (!surfaceTokenPromise) {
			const p = (async (): Promise<string> => {
				const resp = await gatewayFetch(
					"/api/ext/surface-token",
					withSession({ method: "POST", body: JSON.stringify({ sessionId, tool: packTool }) }, sessionId),
				);
				if (!resp.ok) throw new Error(`surface-token HTTP ${resp.status}`);
				const data = (await resp.json()) as { token?: string };
				if (!data?.token) throw new Error("surface-token: empty response");
				return data.token;
			})();
			// On failure (mint denied / offline) drop the memo so a later call re-mints.
			p.catch(() => { if (surfaceTokenPromise === p) surfaceTokenPromise = undefined; });
			surfaceTokenPromise = p;
		}
		return surfaceTokenPromise;
	};
	// Run a scoped fetch with the surface token threaded by `build`. On a 403 (e.g. a
	// token that expired on a long-lived tab) the memo is dropped and the call re-mints
	// + retries ONCE — so a stale token self-heals without surfacing to the pack.
	const scopedFetch = async (build: (token: string) => { path: string; init: RequestInit }): Promise<Response> => {
		const first = build(await getSurfaceToken());
		let resp = await gatewayFetch(first.path, withSession(first.init, sessionId));
		if (resp.status === 403) {
			surfaceTokenPromise = undefined;
			const retry = build(await getSurfaceToken());
			resp = await gatewayFetch(retry.path, withSession(retry.init, sessionId));
		}
		return resp;
	};
	// Slice B1: POST a store op to /api/ext/store/:op carrying the SERVER-MINTED
	// surface token (NOT a raw `tool`) so the server derives the trusted packId.
	const storeOp = async (op: "get" | "put" | "list", payload: Record<string, unknown>): Promise<unknown> => {
		if (!packTool) throw new Error("host.store requires a pack-served renderer context");
		const resp = await scopedFetch((token) => ({
			path: `/api/ext/store/${op}`,
			init: { method: "POST", body: JSON.stringify({ sessionId, toolUseId, surfaceToken: token, ...payload }) },
		}));
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
			const resp = await scopedFetch((token) => ({
				path: `/api/ext/route/${encodeURIComponent(name)}`,
				init: { method: "POST", body: JSON.stringify({ sessionId, toolUseId, surfaceToken: token, init }) },
			}));
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
				if (!packTool) throw new Error("host.session.readTranscript requires a pack-served context");
				const resp = await scopedFetch((token) => {
					const params = new URLSearchParams();
					if (sessionId) params.set("sessionId", sessionId);
					params.set("surfaceToken", token);
					if (opts?.offset != null) params.set("offset", String(opts.offset));
					if (opts?.limit != null) params.set("limit", String(opts.limit));
					if (opts?.pattern) params.set("pattern", opts.pattern);
					return { path: `/api/ext/session/transcript?${params.toString()}`, init: { method: "GET" } };
				});
				if (!resp.ok) throw new Error(`session.readTranscript HTTP ${resp.status}`);
				return resp.json();
			},
			readToolCall: async (toolUseId: string): Promise<ToolCallRecord | null> => {
				if (!packTool) throw new Error("host.session.readToolCall requires a pack-served context");
				const resp = await scopedFetch((token) => {
					const params = new URLSearchParams();
					if (sessionId) params.set("sessionId", sessionId);
					params.set("surfaceToken", token);
					params.set("toolUseId", toolUseId);
					return { path: `/api/ext/session/tool-call?${params.toString()}`, init: { method: "GET" } };
				});
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
				// AFTER the transient-activation assertion: compute the content hash, then
				// drive over the trusted WS (no fetch, no secret). The poster mints a
				// server-minted, one-time, content-bound write permit (bound to this hash)
				// and posts with the returned nonce — so a captured/replayed/tampered frame
				// is rejected server-side (§8 C2.1 + session-write-permit.ts). `sessionId`
				// selects the bound RemoteAgent's poster; the server ignores it as a target.
				return (async () => {
					// Mint (or reuse) the SERVER-MINTED surface token so the WS handler derives
					// the trusted {packId, tool} from it — never a caller-supplied `tool`.
					const surfaceToken = await getSurfaceToken();
					const contentHash = await sessionWriteContentHash(msg.role, msg.text);
					await postSessionMessageOverWs({
						sessionId,
						surfaceToken,
						role: msg.role,
						text: msg.text,
						resumeTurn: msg.resumeTurn,
						contentHash,
					});
				})();
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
