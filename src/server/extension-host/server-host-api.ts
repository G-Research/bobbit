// src/server/extension-host/server-host-api.ts
//
// The SERVER-side Host API handed to a tool's action handlers as `ctx.host`
// (design docs/design/extension-host.md §4c / §5). It is the server-host
// analogue of the client `HostApi` (src/shared/extension-host/host-api.ts):
// the single, capability-scoped object through which a handler touches Bobbit
// internals.
//
// There is NO `gateway.fetch` and no raw passthrough — that escape hatch (and
// with it the Host-header trusted-base-URL token-leak surface) is removed in the
// durable v1 contract. Phase 1 exposes only the bound session/tool identity +
// `capabilities`; the frozen `callRoute`/`session`/`store` namespaces throw a
// loud "reserved for Phase 2" so misuse is never silent. Handlers that genuinely
// need raw `fs`/`process`/`exec` import them directly.

import { HOST_API_VERSION, HOST_CONTRACT_VERSION } from "../../shared/extension-host/host-api.js";

/** PHASE 2 — frozen, not implemented. Mirrors HostStoreApi server-side. */
export interface ServerHostStoreApi {
	get<T = unknown>(key: string): Promise<T | null>;
	put<T = unknown>(key: string, value: T): Promise<void>;
	list(prefix?: string): Promise<string[]>;
}

/** PHASE 2 — frozen, not implemented. Mirrors HostSessionApi server-side. */
export interface ServerHostSessionApi {
	readTranscript(opts?: unknown): Promise<unknown>;
	readToolCall(toolUseId: string): Promise<unknown>;
	postMessage(msg: unknown): Promise<void>;
}

/** Readonly capability map — the SINGLE SOURCE OF TRUTH for what is IMPLEMENTED on the
 *  server host. On a Phase-1 server host only the bound identity is available; the
 *  scoped Phase-2 capabilities are `false`. */
export interface ServerHostCapabilities {
	/** Phase-2 — pack-scoped typed route calls. False on a Phase-1 host. */
	readonly callRoute: boolean;
	/** Phase-2 — transcript/message/event surface. False on a Phase-1 host. */
	readonly session: boolean;
	/** Phase-2 — ownership-scoped persistence. False on a Phase-1 host. */
	readonly store: boolean;
	/** Convenience: feature-detect by name; returns the flag, or false for unknown names. */
	has(name: string): boolean;
}

/**
 * The server-side Host API. Phase 1 exposes the bound identity + `capabilities`;
 * `session`/`store` are frozen interfaces whose members throw until Phase 2 wires
 * them through the same authorization path (purely additive — no signature churn).
 */
export interface ServerHostApi {
	/** Frozen API version. See HOST_API_VERSION. */
	readonly version: number;
	/** Version of the Host-API-owned data contracts. See HOST_CONTRACT_VERSION. */
	readonly contractVersion: number;
	/** The SINGLE SOURCE OF TRUTH for which capabilities are implemented on this host. */
	readonly capabilities: ServerHostCapabilities;
	/** Ownership-scoped persistence. PHASE 2 (frozen, not implemented). */
	readonly store: ServerHostStoreApi;
	/** Transcript + message capabilities. PHASE 2 (frozen, not implemented). */
	readonly session: ServerHostSessionApi;
}

export interface CreateServerHostApiOptions {
	/** The verified calling session id (bound for the handler context). */
	sessionId: string;
	/** The verified tool_use id this action is acting on (bound identity). */
	toolUseId?: string;
	/** SERVER-DERIVED pack id (never caller-supplied) — the directory name under
	 *  `market-packs/` of the winning contribution. Empty for a non-pack (builtin).
	 *  Bound in closure; consumed by the scoped Phase-2 capabilities
	 *  (store/session/callRoute) when they land. See pack-identity.ts. */
	packId: string;
	/** SERVER-DERIVED contributing tool/group key (`${groupDir}/${tool}`). */
	contributionId: string;
}

function notImplemented(member: string): never {
	throw new Error(`host.${member} is reserved for Phase 2`);
}

/**
 * Build the Phase-1 server Host API bound to a single verified session.
 * The returned object is what the ActionDispatcher hands to a handler as
 * `ctx.host`. It carries no raw transport: the only sanctioned pack→server path
 * is the action endpoint itself (which already authorizes + audits the call).
 */
export function createServerHostApi(opts: CreateServerHostApiOptions): ServerHostApi {
	// The bound identity is held in closure: sessionId + toolUseId (Phase 1) plus
	// the SERVER-DERIVED packId + contributionId (Slice A). The scoped Phase-2
	// capabilities (store/session/callRoute) read these when they land; no flag
	// flips in Slice A (identity is plumbing).
	void opts.sessionId;
	void opts.toolUseId;
	void opts.packId;
	void opts.contributionId;

	const flags = { callRoute: false, session: false, store: false };
	const capabilities: ServerHostCapabilities = {
		...flags,
		has: (name: string) => (flags as Record<string, boolean>)[name] === true,
	};

	const store: ServerHostStoreApi = {
		get: () => notImplemented("store.get"),
		put: () => notImplemented("store.put"),
		list: () => notImplemented("store.list"),
	};

	const session: ServerHostSessionApi = {
		readTranscript: () => notImplemented("session.readTranscript"),
		readToolCall: () => notImplemented("session.readToolCall"),
		postMessage: () => notImplemented("session.postMessage"),
	};

	return { version: HOST_API_VERSION, contractVersion: HOST_CONTRACT_VERSION, capabilities, store, session };
}
