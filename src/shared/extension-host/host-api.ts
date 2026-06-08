// src/shared/extension-host/host-api.ts
//
// The FROZEN Bobbit Extension Host API (design docs/design/extension-host.md §3).
//
// This module is types-only (plus the HOST_API_VERSION const) so it is importable
// from BOTH the client hosts (src/ui, src/app) AND the server host (src/server) with
// no runtime coupling. Phase 1 implements ONLY `gateway` and `invokeAction` (+ the
// client-only `requestRender`); everything else is frozen-not-implemented so Phase-2
// implementations are purely additive — add the method body + wire the capability
// through the same authorization path, with no signature churn.

/** Bumped only on a breaking change to any member below. Phase-2 additions that only
 *  ADD members do NOT bump this. Renderers may read host.version to feature-detect. */
export const HOST_API_VERSION = 1 as const;

/**
 * The single, versioned, capability-scoped object through which ALL extension code
 * (client renderers and, in Phase 2, panels/entrypoints) touches Bobbit internals.
 * Every member is mediated + authorized in one place (the gateway action/route guards
 * and the client wrappers). There are no privileged escape hatches.
 */
export interface HostApi {
	/** Frozen API version. See HOST_API_VERSION. */
	readonly version: number;

	/** Gateway access, scoped + audited. PHASE 1: implemented. */
	readonly gateway: HostGatewayApi;

	/**
	 * Request a top-down UI re-render of the current view. PHASE 1: implemented as a
	 * thin wrapper over the app's existing renderApp() (already imported by
	 * renderer-registry.ts). A renderer calls this AFTER an action resolves so its
	 * locally-held result (renderer-local state, §4a) is painted. Client-only — it
	 * touches no server state and is a no-op in non-DOM contexts (unit fixtures).
	 * Renderers that mount their own LitElement use native reactivity and ignore this.
	 */
	requestRender(): void;

	/**
	 * Invoke a server action handler contributed by a tool.
	 * PHASE 1: implemented. POSTs /api/tools/:tool/actions/:action.
	 *
	 * `sessionId` and `toolUseId` are NOT parameters: they come from the render
	 * context the Host API was bound to (getHostApi(sessionId, toolUseId), §4c) and
	 * are supplied to the endpoint internally. `args` is therefore PURE action-domain
	 * input — it is whitelisted/validated by the handler and never carries identity
	 * fields like toolUseId. The bound toolUseId is always the renderer's OWN tool
	 * call; acting on a different tool call is out of Phase-1 scope.
	 * Resolves with the handler's JSON result; rejects on guard/handler failure.
	 */
	invokeAction<TArgs = unknown, TResult = unknown>(
		tool: string,
		action: string,
		args: TArgs,
	): Promise<TResult>;

	/** Transcript + message capabilities. PHASE 2 (frozen, not implemented). */
	readonly session: HostSessionApi;

	/** UI surface capabilities. PHASE 2 (frozen, not implemented). */
	readonly ui: HostUiApi;

	/** Ownership-scoped persistence. PHASE 2 (frozen, not implemented). */
	readonly store: HostStoreApi;
}

export interface HostGatewayApi {
	/**
	 * Authenticated fetch against the gateway, same credentials/headers as the app.
	 * PHASE 1: implemented as a thin wrapper over src/app/gateway-fetch.ts::gatewayFetch.
	 * `path` is a gateway-relative path (e.g. "/api/goals/:id"). The wrapper injects the
	 * Authorization bearer + the caller's session id header; callers must NOT pass their
	 * own Authorization header.
	 *
	 * AUTHORIZATION BOUNDARY (see §5.1): this is deliberately NO MORE privileged than the
	 * app's existing gatewayFetch. It reaches PRE-EXISTING gateway endpoints, each of which
	 * enforces its own authorization; it creates no new server capability and no new
	 * bypass (the LLM/UI can already call these endpoints with the admin token). It is the
	 * lower-level interop seam for renderers that re-express built-ins which today POST to
	 * existing endpoints directly. The PRIMARY, recommended pack→server path is
	 * `invokeAction` (tool-authorized through the action endpoint guard).
	 */
	fetch(path: string, init?: RequestInit): Promise<Response>;
}

/** PHASE 2 — frozen, not implemented. Read/post the current session's transcript. */
export interface HostSessionApi {
	/** Read the current session's transcript (paginated envelope), mirroring
	 *  GET /api/sessions/:id/transcript. */
	readTranscript(opts?: ReadTranscriptOpts): Promise<TranscriptEnvelope>;
	/** Read a single tool call (params + result) by tool_use id from this session. */
	readToolCall(toolUseId: string): Promise<ToolCallRecord | null>;
	/** Post a user/system message into the current session (may resume the agent turn). */
	postMessage(msg: PostMessageInput): Promise<void>;
	/** Subscribe to live session events (tool results, status). Returns an unsubscribe fn. */
	subscribe(event: SessionEvent, cb: (payload: unknown) => void): () => void;
}

/** PHASE 2 — frozen, not implemented. Drive non-chat UI surfaces. */
export interface HostUiApi {
	/** Open (or focus) a contributed panel, handing it an opaque payload. */
	openPanel(panelId: string, payload?: unknown): void;
	/** Navigate the SPA to a contributed route (e.g. "#/ext/pr-walkthrough/123"). */
	navigate(route: string): void;
}

/** PHASE 2 — frozen, not implemented. Ownership-scoped server persistence.
 *  Keys are namespaced to the contributing pack server-side; one pack cannot read
 *  another pack's store. Maps onto the reserved `stores:` contribution. */
export interface HostStoreApi {
	get<T = unknown>(key: string): Promise<T | null>;
	put<T = unknown>(key: string, value: T): Promise<void>;
	list(prefix?: string): Promise<string[]>;
}

// ── Phase-2 payload shapes (frozen so impls are additive) ──
export interface ReadTranscriptOpts { offset?: number; limit?: number; pattern?: string; }
export interface TranscriptEnvelope { total: number; returned: number; messages: unknown[]; }
export interface ToolCallRecord { toolUseId: string; tool: string; params: unknown; result: unknown; isError: boolean; }
export interface PostMessageInput { role: "user" | "system"; text: string; resumeTurn?: boolean; }
export type SessionEvent = "tool_result" | "status" | "message";
