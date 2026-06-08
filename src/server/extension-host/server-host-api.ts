// src/server/extension-host/server-host-api.ts
//
// The SERVER-side Host API handed to a tool's action handlers as `ctx.host`
// (design docs/design/extension-host.md §4c / §5). It is the server-host
// analogue of the client `HostApi` (src/shared/extension-host/host-api.ts):
// the single, capability-scoped object through which a handler touches Bobbit
// internals. Phase 1 implements ONLY an audited, scoped `gateway.fetch`; the
// frozen `session`/`store` namespaces throw a loud "reserved for Phase 2" so
// misuse is never silent.
//
// SECURITY (design §5.1): `gateway.fetch` is deliberately NO MORE privileged
// than the app's existing authenticated fetch — it reaches PRE-EXISTING gateway
// endpoints, each of which enforces its own authorization. It introduces no new
// capability. Handlers that genuinely need raw `fs`/`process`/`exec` import them
// directly; the documented convention is to go through `ctx.host`.

import { HOST_API_VERSION } from "../../shared/extension-host/host-api.js";

/** Phase-1 server gateway surface — a scoped, audited authenticated fetch. */
export interface ServerHostGatewayApi {
	/**
	 * Authenticated fetch against the gateway. `path` MUST be a gateway-relative
	 * path beginning with "/" (e.g. "/api/goals/123"); absolute URLs are rejected.
	 * The wrapper injects the admin bearer + the bound session-id header and
	 * audits the call. Callers must NOT pass their own Authorization header.
	 */
	fetch(path: string, init?: RequestInit): Promise<Response>;
}

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

/**
 * The server-side Host API. Phase 1 implements only `gateway`; `session`/`store`
 * are frozen interfaces whose members throw until Phase 2 wires them through the
 * same authorization path (purely additive — no signature churn).
 */
export interface ServerHostApi {
	/** Frozen API version. See HOST_API_VERSION. */
	readonly version: number;
	/** Gateway access, scoped + audited. PHASE 1: implemented. */
	readonly gateway: ServerHostGatewayApi;
	/** Ownership-scoped persistence. PHASE 2 (frozen, not implemented). */
	readonly store: ServerHostStoreApi;
	/** Transcript + message capabilities. PHASE 2 (frozen, not implemented). */
	readonly session: ServerHostSessionApi;
}

/** Structured audit record emitted for every `gateway.fetch`. */
export interface ServerHostAuditEvent {
	kind: "gateway.fetch";
	sessionId: string;
	method: string;
	path: string;
	status?: number;
	error?: string;
	durationMs: number;
}

export interface CreateServerHostApiOptions {
	/** The verified calling session id (bound for the host header + audit). */
	sessionId: string;
	/** Gateway base URL (e.g. "https://127.0.0.1:3001"); `path` is appended. */
	gatewayBaseUrl: string;
	/** Admin bearer token injected into every gateway.fetch. */
	authToken?: string;
	/** Optional audit sink. Defaults to a console.log line. */
	audit?: (event: ServerHostAuditEvent) => void;
	/** Injectable fetch (tests). Defaults to globalThis.fetch. */
	fetchImpl?: typeof fetch;
}

/** The trusted subset of a request socket used to derive the gateway base URL. */
export interface TrustedRequestSocket {
	/** The local address the request actually landed on (OS-supplied, not header-controlled). */
	localAddress?: string;
	/** The local port the request actually landed on (OS-supplied; == the bound port). */
	localPort?: number;
	/** True when the request arrived over TLS. */
	encrypted?: boolean;
}

/**
 * Derive the SERVER-side gateway base URL for `host.gateway.fetch` from a TRUSTED
 * value — the actual bound socket the request landed on — NEVER from a
 * user-controlled header (e.g. `Host:`). Deriving the base from `req.headers.host`
 * would let a forged `Host: attacker.example` redirect the admin-bearer-injecting
 * `gateway.fetch` to an attacker origin, leaking the token (design §5.1).
 *
 * `socket.localAddress`/`localPort` are supplied by the OS for the connection this
 * very request arrived on, so a fetch back to that origin always reaches the real
 * local gateway and the injected bearer never leaves the box. IPv6 addresses are
 * bracket-wrapped; loopback is the fallback when the address is unavailable.
 */
export function resolveTrustedGatewayBaseUrl(socket: TrustedRequestSocket | undefined): string {
	const proto = socket?.encrypted ? "https" : "http";
	const rawAddr = socket?.localAddress && socket.localAddress.length > 0 ? socket.localAddress : "127.0.0.1";
	// IPv6 literals must be bracketed in a URL authority.
	const host = rawAddr.includes(":") ? `[${rawAddr}]` : rawAddr;
	const port = socket?.localPort;
	return `${proto}://${host}${port ? `:${port}` : ""}`;
}

function defaultAudit(event: ServerHostAuditEvent): void {
	console.log(`[ext-host] ${event.kind} session=${event.sessionId} ${event.method} ${event.path} ` +
		`→ ${event.error ? `error: ${event.error}` : event.status} (${event.durationMs}ms)`);
}

function notImplemented(member: string): never {
	throw new Error(`host.${member} is reserved for Phase 2`);
}

/**
 * Build the Phase-1 server Host API bound to a single verified session.
 * The returned object is what the ActionDispatcher hands to a handler as
 * `ctx.host`.
 */
export function createServerHostApi(opts: CreateServerHostApiOptions): ServerHostApi {
	const audit = opts.audit ?? defaultAudit;
	const doFetch = opts.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);

	const gateway: ServerHostGatewayApi = {
		async fetch(path: string, init?: RequestInit): Promise<Response> {
			if (typeof path !== "string" || !path.startsWith("/")) {
				throw new Error("host.gateway.fetch: path must be a gateway-relative path starting with '/'");
			}
			if (!doFetch) {
				throw new Error("host.gateway.fetch: no fetch implementation available");
			}
			// Defense in depth: a handler must not supply its own Authorization.
			const headers = new Headers(init?.headers ?? {});
			if (opts.authToken) headers.set("Authorization", `Bearer ${opts.authToken}`);
			headers.set("x-bobbit-session-id", opts.sessionId);

			const method = (init?.method ?? "GET").toUpperCase();
			const start = Date.now();
			const base = opts.gatewayBaseUrl.replace(/\/+$/, "");
			try {
				const resp = await doFetch(`${base}${path}`, { ...init, headers });
				audit({ kind: "gateway.fetch", sessionId: opts.sessionId, method, path, status: resp.status, durationMs: Date.now() - start });
				return resp;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				audit({ kind: "gateway.fetch", sessionId: opts.sessionId, method, path, error: message, durationMs: Date.now() - start });
				throw err;
			}
		},
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

	return { version: HOST_API_VERSION, gateway, store, session };
}
