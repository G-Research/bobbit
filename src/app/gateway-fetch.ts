// Central browser boundary for gateway and runtime-mounted app URLs. Keep this
// module dependency-light: it is imported by UI utilities and node-safe helpers.

import {
	gatewayRoute,
	normalizeBasePath,
	previewGatewayRoute,
	stripBasePath,
	withBasePath,
	type GatewayRoute,
} from "../shared/base-path.js";
import { decodePreviewEntry, isValidPreviewEntry } from "../shared/preview-entry-codec.js";

export const GW_URL_KEY = "gateway.url";
export const GW_TOKEN_KEY = "gateway.token";
export const LOCALHOST_TOKEN = "localhost";

const INVALID_SAVED_GATEWAY_WARNING = "Invalid saved gateway URL; using this Bobbit deployment instead.";
const STORAGE_WARNING = "Connected, but the gateway connection could not be saved for the next reload.";
const NATIVE_TRANSPORT_WARNING = "Preview live updates and embedded previews require the Bobbit UI and gateway to use the same origin (scheme, hostname, and port). Serve the UI from the gateway origin or route the gateway through a same-origin reverse proxy.";

export type InvalidGatewayBaseUrlCode =
	| "EMPTY"
	| "INVALID_SYNTAX"
	| "NOT_ABSOLUTE"
	| "UNSUPPORTED_PROTOCOL"
	| "CREDENTIALS"
	| "QUERY"
	| "FRAGMENT"
	| "INVALID_PATH";

export class InvalidGatewayBaseUrlError extends Error {
	readonly code: InvalidGatewayBaseUrlCode;

	constructor(code: InvalidGatewayBaseUrlCode, message?: string) {
		super(message ?? `Invalid gateway base URL (${code.toLowerCase().replace(/_/g, " ")})`);
		this.name = "InvalidGatewayBaseUrlError";
		this.code = code;
	}
}

declare const publicGatewayUrlBrand: unique symbol;
export type PublicGatewayUrl = string & { readonly [publicGatewayUrlBrand]: true };

export interface ActiveGatewayConnection {
	baseUrl: string;
	token: string;
}

export interface GatewayConnectionCommitResult {
	persisted: boolean;
	warning?: string;
}

export interface GatewayNativeTransportSupport {
	supported: boolean;
	message?: string;
}

let activeConnection: ActiveGatewayConnection | null = null;
let recoveryWarning: string | null = null;

function browserWindow(): (Window & typeof globalThis) | undefined {
	return typeof window === "undefined" ? undefined : window;
}

function storageValue(key: string): string | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
	} catch {
		return null;
	}
}

function removeStoredConnection(): void {
	try { if (typeof localStorage !== "undefined") localStorage.removeItem(GW_URL_KEY); }
	catch { /* recovery still proceeds in memory */ }
	try { if (typeof localStorage !== "undefined") localStorage.removeItem(GW_TOKEN_KEY); }
	catch { /* recovery still proceeds in memory */ }
}

function rawPathnameAfterAuthority(raw: string): string {
	const schemeEnd = raw.indexOf("://") + 3;
	const remainder = raw.slice(schemeEnd);
	const boundary = remainder.search(/[/?#]/);
	const authority = boundary < 0 ? remainder : remainder.slice(0, boundary);
	if (!authority) throw new InvalidGatewayBaseUrlError("INVALID_SYNTAX", "Gateway URL must include an authority and hostname");
	if (boundary < 0) return "";
	const tail = remainder.slice(boundary);
	if (tail.startsWith("?")) throw new InvalidGatewayBaseUrlError("QUERY", "Gateway URL must not contain a query string");
	if (tail.startsWith("#")) throw new InvalidGatewayBaseUrlError("FRAGMENT", "Gateway URL must not contain a fragment");
	const queryIndex = tail.indexOf("?");
	const fragmentIndex = tail.indexOf("#");
	if (queryIndex >= 0 && (fragmentIndex < 0 || queryIndex < fragmentIndex)) {
		throw new InvalidGatewayBaseUrlError("QUERY", "Gateway URL must not contain a query string");
	}
	if (fragmentIndex >= 0) throw new InvalidGatewayBaseUrlError("FRAGMENT", "Gateway URL must not contain a fragment");
	return tail;
}

/** Canonical absolute HTTP(S) gateway base with no trailing slash. */
export function normalizeGatewayBaseUrl(raw: string): string {
	const value = typeof raw === "string" ? raw.trim() : "";
	if (!value) throw new InvalidGatewayBaseUrlError("EMPTY", "Gateway URL is required");
	if (/[\\\u0000-\u001f\u007f\s]/u.test(value)) {
		throw new InvalidGatewayBaseUrlError("INVALID_SYNTAX", "Gateway URL contains whitespace, a control character, or a backslash");
	}
	if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
		throw new InvalidGatewayBaseUrlError("NOT_ABSOLUTE", "Gateway URL must be an absolute http:// or https:// URL");
	}
	if (!/^https?:\/\//i.test(value)) {
		throw new InvalidGatewayBaseUrlError("UNSUPPORTED_PROTOCOL", "Gateway URL must use http:// or https://");
	}

	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new InvalidGatewayBaseUrlError("INVALID_SYNTAX", "Gateway URL is not valid");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new InvalidGatewayBaseUrlError("UNSUPPORTED_PROTOCOL", "Gateway URL must use http:// or https://");
	}
	if (!parsed.hostname) throw new InvalidGatewayBaseUrlError("INVALID_SYNTAX", "Gateway URL must include a hostname");
	if (parsed.username || parsed.password) {
		throw new InvalidGatewayBaseUrlError("CREDENTIALS", "Gateway URL must not include credentials");
	}
	if (parsed.search) throw new InvalidGatewayBaseUrlError("QUERY", "Gateway URL must not contain a query string");
	if (parsed.hash) throw new InvalidGatewayBaseUrlError("FRAGMENT", "Gateway URL must not contain a fragment");

	let basePath: string;
	try {
		// Validate the operator's lexical path before WHATWG URL parsing can erase
		// dot segments or otherwise repair unsafe input.
		basePath = normalizeBasePath(rawPathnameAfterAuthority(value));
	} catch (error) {
		if (error instanceof InvalidGatewayBaseUrlError) throw error;
		throw new InvalidGatewayBaseUrlError("INVALID_PATH", error instanceof Error ? error.message : "Gateway URL path is invalid");
	}
	return `${parsed.origin}${basePath}`;
}

/** Runtime UI mount stamped into the SPA shell (`""` in root/Vite mode). */
export function runtimeBasePath(): string {
	const stamped = (globalThis as typeof globalThis & { __BOBBIT_BASE_PATH__?: unknown }).__BOBBIT_BASE_PATH__
		?? (browserWindow() as (Window & { __BOBBIT_BASE_PATH__?: unknown }) | undefined)?.__BOBBIT_BASE_PATH__;
	if (typeof stamped !== "string") return "";
	try {
		return normalizeBasePath(stamped);
	} catch {
		return "";
	}
}

/** Same-origin UI/static/hash/path URL below the runtime mount. */
export function appUrl(path: string): string {
	return String(withBasePath(gatewayRoute(path), runtimeBasePath()));
}

/** Canonical same-origin gateway fallback for this deployed UI. */
export function sameOriginGatewayBaseUrl(): string {
	const current = browserWindow();
	if (!current) return "";
	return normalizeGatewayBaseUrl(`${current.location.origin}${runtimeBasePath()}`);
}

function hydrateActiveConnection(): ActiveGatewayConnection {
	if (activeConnection) return activeConnection;
	const storedUrl = storageValue(GW_URL_KEY);
	const storedToken = storageValue(GW_TOKEN_KEY) ?? "";
	if (storedUrl) {
		try {
			activeConnection = { baseUrl: normalizeGatewayBaseUrl(storedUrl), token: storedToken };
			return activeConnection;
		} catch {
			// Clear the pair together before any request so a token from a malformed
			// record can never leak to the page-origin fallback.
			removeStoredConnection();
			recoveryWarning = INVALID_SAVED_GATEWAY_WARNING;
		}
	} else if (storedToken) {
		removeStoredConnection();
	}
	activeConnection = { baseUrl: sameOriginGatewayBaseUrl(), token: "" };
	return activeConnection;
}

/** Current in-memory connection. Transports never independently reread storage. */
export function activeGatewayConnection(): Readonly<ActiveGatewayConnection> {
	const connection = hydrateActiveConnection();
	return Object.freeze({ ...connection });
}

export function gatewayBaseUrl(): string {
	return hydrateActiveConnection().baseUrl;
}

/** Returns the one-shot malformed-storage recovery warning, if any. */
export function takeGatewayRecoveryWarning(): string | null {
	const warning = recoveryWarning;
	recoveryWarning = null;
	return warning;
}

function restoreStorageValue(storage: Storage, key: string, value: string | null): void {
	if (value === null) storage.removeItem(key);
	else storage.setItem(key, value);
}

/**
 * Publish an authenticated connection in memory, then persist the URL/token pair.
 * A storage failure rolls persisted values back while retaining the working pair
 * for every transport in the current tab.
 */
export function commitGatewayConnection(baseUrl: string, token: string): GatewayConnectionCommitResult {
	const normalized = normalizeGatewayBaseUrl(baseUrl);
	activeConnection = { baseUrl: normalized, token };

	let storage: Storage;
	let previousUrl: string | null;
	let previousToken: string | null;
	try {
		if (typeof localStorage === "undefined") return { persisted: false, warning: STORAGE_WARNING };
		storage = localStorage;
		previousUrl = storage.getItem(GW_URL_KEY);
		previousToken = storage.getItem(GW_TOKEN_KEY);
	} catch {
		return { persisted: false, warning: STORAGE_WARNING };
	}
	try {
		storage.setItem(GW_URL_KEY, normalized);
		storage.setItem(GW_TOKEN_KEY, token);
	} catch {
		try { restoreStorageValue(storage, GW_URL_KEY, previousUrl); } catch { /* best effort */ }
		try { restoreStorageValue(storage, GW_TOKEN_KEY, previousToken); } catch { /* best effort */ }
		return { persisted: false, warning: STORAGE_WARNING };
	}

	try {
		browserWindow()?.dispatchEvent(new CustomEvent("bobbit:gateway-connection-changed", {
			detail: { baseUrl: normalized, token },
		}));
	} catch { /* notification is best effort */ }
	return { persisted: true };
}

/** Resolve one internal route against the selected (or explicit) gateway base. */
export function gatewayUrl(route: GatewayRoute, explicitBase?: string): PublicGatewayUrl {
	const base = explicitBase === undefined ? gatewayBaseUrl() : normalizeGatewayBaseUrl(explicitBase);
	return `${base}${route}` as PublicGatewayUrl;
}

/** HTTP(S) -> WS(S), preserving the selected gateway pathname. */
export function gatewayWsUrl(route: GatewayRoute, explicitBase?: string): string {
	const resolved = new URL(gatewayUrl(route, explicitBase));
	resolved.protocol = resolved.protocol === "https:" ? "wss:" : "ws:";
	return resolved.href;
}

/** Omit absent/empty/localhost sentinel credentials; retain real Bobbit tokens. */
export function gatewayAuthorizationHeaders(token?: string | null): Record<string, string> {
	if (!token || token === LOCALHOST_TOKEN) return {};
	return { Authorization: `Bearer ${token}` };
}

/** Compatibility boundary for cookie-only EventSource/iframe/popout transports. */
export function gatewayNativeTransportSupport(explicitBase?: string): GatewayNativeTransportSupport {
	const current = browserWindow();
	if (!current) return { supported: false, message: NATIVE_TRANSPORT_WARNING };
	let gateway: URL;
	try {
		gateway = new URL(explicitBase === undefined ? gatewayBaseUrl() : normalizeGatewayBaseUrl(explicitBase));
	} catch {
		return { supported: false, message: NATIVE_TRANSPORT_WARNING };
	}
	const supported = gateway.origin === current.location.origin;
	return supported ? { supported: true } : { supported: false, message: NATIVE_TRANSPORT_WARNING };
}

/** Central HTTP transport. Route strings are validated at entry. */
export function gatewayFetch(route: GatewayRoute | string, init: RequestInit = {}): Promise<Response> {
	const connection = hydrateActiveConnection();
	const internalRoute = typeof route === "string" ? gatewayRoute(route) : route;
	const headers = new Headers(init.headers);
	if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
	const authorization = gatewayAuthorizationHeaders(connection.token).Authorization;
	if (authorization) headers.set("Authorization", authorization);
	else headers.delete("Authorization");
	// Leave credentials at Fetch's same-origin default unless the caller opted
	// into another mode. Explicit remote gateways use their bearer without
	// requiring credentialed CORS, while reverse-proxied same-origin cookies work.
	return fetch(gatewayUrl(internalRoute, connection.baseUrl), {
		...init,
		headers,
	});
}

function previewRouteCandidate(raw: string): GatewayRoute | null {
	try { return previewGatewayRoute(raw); } catch { return null; }
}

/**
 * Validate the raw single-filename `entry` carried by compact v3 markers.
 * Mount and artifact writers store filenames verbatim, never as URI segments:
 * preserve that value unchanged here and encode it exactly once only when
 * reconstructing the internal preview route below.
 */
export function previewEntryFromStoredValue(value: unknown): string | null {
	const entry = decodePreviewEntry(value);
	return isValidPreviewEntry(entry) ? entry : null;
}

function compactPreviewRouteCandidate(raw: string, entry: string | undefined): GatewayRoute | null {
	if (!entry || !/^\/preview\/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\/$/iu.test(raw)) return null;
	return previewRouteCandidate(`${raw}${encodeURIComponent(entry)}`);
}

function previewRouteCandidateWithEntry(raw: string, entry: string | undefined): GatewayRoute | null {
	return previewRouteCandidate(raw) || compactPreviewRouteCandidate(raw, entry);
}

function splitPathSuffix(raw: string): { pathname: string; suffix: string } {
	const boundary = raw.search(/[?#]/);
	return boundary < 0 ? { pathname: raw, suffix: "" } : { pathname: raw.slice(0, boundary), suffix: raw.slice(boundary) };
}

function stripKnownPreviewMount(pathname: string, suffix: string, basePath: string, entry: string | undefined): GatewayRoute | null {
	const stripped = stripBasePath(pathname, basePath);
	return stripped === null ? null : previewRouteCandidateWithEntry(`${stripped}${suffix}`, entry);
}

/**
 * Decode a current or historical preview URL to the internal `/preview/...` route.
 * Compact v3 markers may store only `/preview/<session>/`; when a safe entry is
 * supplied, reconstruct that route and run it through the same strict validator.
 */
export function previewRouteFromStoredValue(value: unknown, entryValue?: unknown): GatewayRoute | null {
	if (typeof value !== "string" || !value || /[\\\u0000-\u001f\u007f]/u.test(value)) return null;
	const entry = (entryValue === undefined ? undefined : previewEntryFromStoredValue(entryValue)) ?? undefined;
	if (entryValue !== undefined && !entry) return null;
	const direct = previewRouteCandidateWithEntry(value, entry);
	if (direct) return direct;

	const connection = hydrateActiveConnection();
	let selected: URL | null = null;
	try { selected = new URL(connection.baseUrl); } catch { /* node-safe direct-route decoding */ }
	let pathname = "";
	let suffix = "";
	if (/^https?:\/\//i.test(value)) {
		let absolute: URL;
		try { absolute = new URL(value); } catch { return null; }
		if (!selected || absolute.origin !== selected.origin) return null;
		pathname = absolute.pathname;
		suffix = `${absolute.search}${absolute.hash}`;
		const known = stripKnownPreviewMount(pathname, suffix, selected.pathname === "/" ? "" : selected.pathname, entry);
		if (known) return known;
	} else if (value.startsWith("/")) {
		({ pathname, suffix } = splitPathSuffix(value));
		const selectedBasePath = selected && selected.pathname !== "/" ? selected.pathname : "";
		const knownBases = new Set([runtimeBasePath(), selectedBasePath]);
		for (const base of knownBases) {
			const known = stripKnownPreviewMount(pathname, suffix, base, entry);
			if (known) return known;
		}
	} else {
		return null;
	}

	// Last-resort compatibility for records written under a no-longer-known
	// mount. Only the validated internal suffix survives; the historical origin
	// and prefix are never fetched or navigated.
	const marker = pathname.lastIndexOf("/preview/");
	return marker < 0 ? null : previewRouteCandidateWithEntry(`${pathname.slice(marker)}${suffix}`, entry);
}

/** Test-only reset for isolated browser-boundary cases. */
export function __resetGatewayConnectionForTests(): void {
	activeConnection = null;
	recoveryWarning = null;
}
