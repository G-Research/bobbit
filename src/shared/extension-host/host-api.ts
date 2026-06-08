// src/shared/extension-host/host-api.ts
//
// The FROZEN Bobbit Extension Host API — durable v1 contract
// (design docs/design/extension-host.md §3).
//
// This module is types-only (plus the HOST_API_VERSION / HOST_CONTRACT_VERSION
// consts) so it is importable from BOTH the client hosts (src/ui, src/app) AND the
// server host (src/server) with no runtime coupling. Phase 1 implements ONLY
// `invokeAction` (+ the client-only `requestRender`); everything else is
// frozen-not-implemented so Phase-2 implementations are purely additive — add the
// method body + flip the `capabilities` flag, with no signature churn.
//
// There is NO `gateway.fetch` and NO other raw passthrough: `invokeAction`
// (tool-authorized) is the only Phase-1 pack→server path, and the Phase-2,
// pack-scoped, typed `callRoute` reaches ONLY the calling pack's own
// `/api/ext/<thisPack>/*` namespace. That no-escape-hatch invariant is what makes
// v1 durable — one un-typed passthrough would make the whole abstraction a fiction.

/** Bumped only on a BREAKING change to any member below. Additive-only after v1: adding a
 *  new method/namespace does NOT bump this. Renderers feature-detect AVAILABILITY via
 *  `host.capabilities` (the single source of truth for what is IMPLEMENTED on this host) —
 *  NOT via member-presence checks, because reserved Phase-2 namespaces are present-but-
 *  throwing stubs (see HostCapabilities). `host.version` only identifies the contract
 *  revision; it never implies a member is implemented. */
export const HOST_API_VERSION = 1 as const;

/** Versions the Host-API-OWNED data contracts (HostMessage / HostContentBlock /
 *  ToolCallRecord / event payloads). Bumped only on a BREAKING change to those shapes.
 *  Kept distinct from HOST_API_VERSION so the surface and the data model can evolve
 *  independently; packs may read it to feature-detect contract-shape additions.
 *
 *  ADAPTER SEAM: these data contracts are STABLE shapes this contract OWNS. Bobbit maps
 *  its INTERNAL session/message/tool-call wire format onto them through a documented
 *  internal→contract adapter (Phase 2: `src/server/extension-host/contract-adapter.ts`),
 *  the single place the mapping lives — so internals can be refactored freely without
 *  breaking packs. */
export const HOST_CONTRACT_VERSION = 1 as const;

/**
 * The single, versioned, capability-scoped object through which ALL extension code
 * (client renderers and, in Phase 2, panels/entrypoints) touches Bobbit. Every member is
 * a typed, named, authorized method, mediated in one place (the gateway action/route
 * guards and the client wrappers). There are NO raw passthroughs and NO privileged escape
 * hatches — that invariant is what makes v1 durable (one un-typed passthrough would make
 * the whole abstraction a fiction).
 */
export interface HostApi {
	/** Frozen API version. See HOST_API_VERSION. */
	readonly version: number;

	/** Version of the Host-API-owned data contracts. See HOST_CONTRACT_VERSION. */
	readonly contractVersion: number;

	/**
	 * The SINGLE SOURCE OF TRUTH for which capabilities are actually IMPLEMENTED on this
	 * host. Authors MUST feature-detect via `host.capabilities.<name>` (or
	 * `host.capabilities.has(name)`), NOT via member-presence checks: reserved Phase-2
	 * namespaces (`callRoute`/`session`/`ui`/`store`) are present-but-throwing stubs for
	 * type stability, so `if (host.callRoute)` / `if (host.store)` would WRONGLY succeed.
	 * On a Phase-1 host this reads `{ invokeAction: true, requestRender: true,
	 * callRoute: false, session: false, ui: false, store: false }`. A Phase-2 host that
	 * implements a capability flips its flag to `true` (purely additive — no signature or
	 * version churn). */
	readonly capabilities: HostCapabilities;

	/**
	 * Force the active tool block(s) to repaint. PHASE 1: implemented by dispatching a
	 * dedicated repaint event (renderer-registry.ts) that mounted
	 * <tool-message>/<tool-group> elements listen for and `requestUpdate()` on — the
	 * SAME mechanism the lazy-load path uses. A bare `renderApp()` is NOT sufficient: the
	 * memoized tool components have unchanged reactive props, so their renderer would not
	 * re-run. A renderer calls this AFTER an action resolves so its locally-held result
	 * (renderer-local state, §4a) is painted. Client-only — touches no server state,
	 * no-op in non-DOM contexts. Renderers that mount their own LitElement use native
	 * reactivity and ignore this.
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

	/**
	 * Call one of the CONTRIBUTING PACK'S OWN typed routes (the durable replacement for a
	 * raw gateway fetch). PHASE 2 (frozen, not implemented). `name` resolves ONLY within
	 * the calling pack's `/api/ext/<thisPack>/*` namespace — it is impossible to address
	 * an arbitrary gateway path. Authorized through the same per-session `allowedTools`
	 * guard as `invokeAction` (§5). This is how a pack's renderer/panel fetches its OWN
	 * dynamic server data (e.g. the PR-walkthrough viewer reading its changeset bundle).
	 */
	callRoute<TResult = unknown>(name: string, init?: HostRouteInit): Promise<TResult>;

	/** Transcript + message capabilities. PHASE 2 (frozen, not implemented). */
	readonly session: HostSessionApi;

	/** UI surface capabilities. PHASE 2 (frozen, not implemented). */
	readonly ui: HostUiApi;

	/** Ownership-scoped persistence. PHASE 2 (frozen, not implemented). */
	readonly store: HostStoreApi;
}

/**
 * Readonly capability map — the SINGLE SOURCE OF TRUTH for availability (`host.capabilities`).
 * Each named capability flag is `true` only when that capability is IMPLEMENTED on the
 * running host. Reserved Phase-2 namespaces are present-but-throwing on the HostApi for
 * type stability, so member-presence checks are unreliable; this map is authoritative.
 * Additive-only: a Phase-2 host flips a flag from `false` to `true` (no version bump). The
 * `has(name)` helper is a string-keyed convenience over the same flags. */
export interface HostCapabilities {
	/** Phase-1 — always true on any v1 host. */
	readonly invokeAction: boolean;
	/** Phase-1 client-only — true in a DOM/renderer context. */
	readonly requestRender: boolean;
	/** Phase-2 — pack-scoped typed route calls. False on a Phase-1 host. */
	readonly callRoute: boolean;
	/** Phase-2 — transcript/message/event surface. False on a Phase-1 host. */
	readonly session: boolean;
	/** Phase-2 — panel/navigation surface. False on a Phase-1 host. */
	readonly ui: boolean;
	/** Phase-2 — ownership-scoped persistence. False on a Phase-1 host. */
	readonly store: boolean;
	/** Convenience: feature-detect by name; returns the flag, or false for unknown names. */
	has(name: string): boolean;
}

/** PHASE 2 — frozen, not implemented. Typed request to a pack's OWN contributed route.
 *  No `path`/URL field exists by design: the route is addressed by its declared `name`
 *  within the pack's namespace, never by a gateway-relative path. */
export interface HostRouteInit {
	/** HTTP method for the route. Default "GET". */
	method?: "GET" | "POST" | "PUT" | "DELETE";
	/** JSON body (POST/PUT). Serialized by the host; never a raw string/stream. */
	body?: unknown;
	/** Typed query params appended to the route. */
	query?: Record<string, string | number | boolean>;
}

/** PHASE 2 — frozen, not implemented. Read/post the current session's transcript.
 *  All shapes returned/accepted here are Host-API-OWNED contract types (below), produced
 *  by the internal→contract adapter — never Bobbit's internal wire format. */
export interface HostSessionApi {
	/** Read the current session's transcript (paginated envelope of HostMessages). */
	readTranscript(opts?: ReadTranscriptOpts): Promise<TranscriptEnvelope>;
	/** Read a single tool call (input + output) by tool_use id from this session. */
	readToolCall(toolUseId: string): Promise<ToolCallRecord | null>;
	/** Post a user/system message into the current session (may resume the agent turn). */
	postMessage(msg: PostMessageInput): Promise<void>;
	/** Subscribe to live, TYPED session events. Returns an unsubscribe fn. The callback
	 *  payload is discriminated on the event name (see HostSessionEventMap). */
	subscribe<E extends HostSessionEventName>(
		event: E,
		cb: (payload: HostSessionEventMap[E]) => void,
	): () => void;
}

/** PHASE 2 — frozen, not implemented. Drive non-chat UI surfaces. Targets are STRUCTURED
 *  typed objects, never hash strings — so the contract never bakes in today's router. */
export interface HostUiApi {
	/** Open (or focus) a contributed panel, handing it typed params. */
	openPanel(target: PanelTarget): void;
	/** Navigate the SPA to a contributed route, by structured target. The host maps the
	 *  target onto whatever URL scheme the router uses; packs never construct URLs. */
	navigate(target: RouteTarget): void;
}

/** PHASE 2 — frozen, not implemented. Ownership-scoped server persistence.
 *  Keys are namespaced to the contributing pack server-side; one pack cannot read
 *  another pack's store. Maps onto the reserved `stores:` contribution. */
export interface HostStoreApi {
	get<T = unknown>(key: string): Promise<T | null>;
	put<T = unknown>(key: string, value: T): Promise<void>;
	list(prefix?: string): Promise<string[]>;
}

// ── Structured UI addressing (frozen; no hash strings) ──
export interface PanelTarget { panelId: string; params?: Record<string, unknown>; }
export interface RouteTarget { route: string; params?: Record<string, unknown>; }

// ── Host-API-OWNED data contracts (versioned by HOST_CONTRACT_VERSION) ──
// These are STABLE shapes the contract owns. Bobbit's internal session/message types are
// mapped onto them by the internal→contract adapter (Phase 2), decoupling packs from any
// internal refactor. They are deliberately NOT `unknown` mirrors of the internal wire.

/** A single transcript message in contract form. */
export interface HostMessage {
	id: string;
	role: "user" | "assistant" | "system";
	content: HostContentBlock[];
	/** Unix epoch milliseconds. */
	ts: number;
}

/** Discriminated union of message content blocks. Additive: new `type`s may be added in
 *  later contract versions; consumers must tolerate unknown types (render nothing). */
export type HostContentBlock =
	| { type: "text"; text: string }
	| { type: "tool_use"; toolUseId: string; tool: string; input: unknown }
	| { type: "tool_result"; toolUseId: string; output: unknown; isError: boolean };

/** A single tool call's input + output, in contract form. */
export interface ToolCallRecord {
	toolUseId: string;
	tool: string;
	input: unknown;
	output: unknown;
	isError: boolean;
}

export interface ReadTranscriptOpts { offset?: number; limit?: number; pattern?: string; }
export interface TranscriptEnvelope { total: number; returned: number; messages: HostMessage[]; }
export interface PostMessageInput { role: "user" | "system"; text: string; resumeTurn?: boolean; }

// ── Typed session events (frozen; payloads are discriminated, never bare `unknown`) ──
export interface HostSessionEventMap {
	/** A tool call produced (or updated) its result. */
	tool_result: { record: ToolCallRecord };
	/** The session's run status changed. */
	status: { status: "idle" | "running" | "error"; detail?: string };
	/** A new message was appended to the transcript. */
	message: { message: HostMessage };
}
export type HostSessionEventName = keyof HostSessionEventMap;
