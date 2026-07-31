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

export const GW_URL_KEY = "gateway.url";
export const GW_TOKEN_KEY = "gateway.token";
export const GW_AUTH_MODE_KEY = "gateway.auth-mode";
/** Atomic commit marker and cross-tab snapshot. Legacy keys remain reload-compatible. */
export const GW_CONNECTION_REVISION_KEY = "gateway.connection-revision";
/** Mode update bound to one connection generation, so it cannot revert a newer target. */
export const GW_AUTH_MODE_REVISION_KEY = "gateway.auth-mode-revision";
export const LOCALHOST_TOKEN = "localhost";

const INVALID_SAVED_GATEWAY_WARNING = "Invalid saved gateway URL; using this Bobbit deployment instead.";
const STORAGE_WARNING = "Connected, but the gateway connection could not be saved for the next reload.";
const NATIVE_TRANSPORT_WARNING = "Preview live updates and embedded previews require the Bobbit UI and gateway to use the same HTTPS hostname (loopback HTTP is also supported). Serve the UI from the gateway origin or through a same-host reverse proxy.";
const NATIVE_TRANSPORT_UNCONFIRMED_WARNING = "Preview live updates and embedded previews are unavailable because cookie-only gateway authentication could not be confirmed. Bobbit kept the real token for REST and WebSocket access; reconnect through the Vite proxy or a same-host reverse proxy to enable previews.";
const QR_COOKIE_REENTRY_MESSAGE = "This browser is connected with a private cookie, which cannot authenticate a phone. Re-enter the gateway token to create a secure handoff; it stays only in this tab and is not saved.";
const SERVICE_WORKER_RELOAD_GUARD_KEY = "bobbit-sw-mount-reload";
const BOBBIT_CACHE_PREFIX = "bobbit:";
const CROSS_TAB_CONNECTION_CHANGED_ERROR = "Gateway changed in another tab; reload before retrying this action.";

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

export interface GatewayConnectionCommitOptions {
	/** The sentinel represents an auth-disabled localhost gateway, not a cookie. */
	localhostTrusted?: boolean;
	/** A protected request without Bearer authority succeeded for this candidate. */
	cookieConfirmed?: boolean;
}

declare const gatewayConnectionSnapshotBrand: unique symbol;

/** Opaque compare-and-swap token for work deferred across an async boundary. */
export interface GatewayConnectionSnapshot {
	readonly connection: Readonly<ActiveGatewayConnection>;
	readonly [gatewayConnectionSnapshotBrand]: true;
}

export interface GatewayConnectionSnapshotResult {
	unchanged: boolean;
	connection: Readonly<ActiveGatewayConnection>;
}

export interface GatewayConnectionConditionalCommitResult extends GatewayConnectionCommitResult {
	committed: boolean;
	connection: Readonly<ActiveGatewayConnection>;
}

export interface GatewayNativeTransportSupport {
	supported: boolean;
	message?: string;
}

export type GatewayMobileHandoff =
	| { supported: true; url: PublicGatewayUrl }
	| { supported: false; message: string };

type GatewayAuthenticationMode = "none" | "bearer" | "cookie" | "localhost" | "unknown";

interface PersistedGatewayConnectionRecord {
	version: 1;
	generation: string;
	baseUrl: string;
	token: string;
	authenticationMode: GatewayAuthenticationMode;
}

interface PersistedGatewayAuthenticationModeRecord {
	version: 1;
	generation: string;
	authenticationMode: GatewayAuthenticationMode;
}

type PersistedGatewayConnectionRead =
	| { status: "valid"; record: PersistedGatewayConnectionRecord }
	| { status: "absent" | "invalid" | "unavailable" };

interface BobbitServiceWorkerLike {
	scriptURL: string;
}

interface BobbitServiceWorkerRegistrationLike {
	scope: string;
	active?: BobbitServiceWorkerLike | null;
	waiting?: BobbitServiceWorkerLike | null;
	installing?: BobbitServiceWorkerLike | null;
	unregister(): Promise<boolean>;
}

interface BobbitServiceWorkerContainerLike {
	controller?: BobbitServiceWorkerLike | null;
	getRegistrations(): Promise<BobbitServiceWorkerRegistrationLike[]>;
	register(scriptURL: string, options: { scope: string }): Promise<unknown>;
}

interface BobbitCacheStorageLike {
	keys(): Promise<string[]>;
	delete(name: string): Promise<boolean>;
}

export interface BobbitServiceWorkerMountEnvironment {
	serviceWorker?: BobbitServiceWorkerContainerLike;
	cacheStorage?: BobbitCacheStorageLike;
	sessionStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
	origin?: string;
	reload?: () => void;
}

export interface ServiceWorkerMountPreparationResult {
	deletedCaches: number;
	registered: boolean;
	reloadRequested: boolean;
	retiredRegistrations: number;
	/** False means a wrong/unknown controller may still observe mounted auth traffic. */
	safeToProceed: boolean;
}

let activeConnection: ActiveGatewayConnection | null = null;
let activeAuthenticationMode: GatewayAuthenticationMode = "none";
let activeConnectionGeneration: string | null = null;
let recoveryWarning: string | null = null;
let serviceWorkerReloadRequested = false;
let crossTabListenerWindow: (Window & typeof globalThis) | undefined;
let crossTabReloadRequested = false;
let crossTabUnloadStarted = false;
let fallbackGenerationCounter = 0;
// Monotonic within this tab. Unlike the persisted generation, this also detects
// A→B→A changes while deferred work is waiting.
let activeConnectionVersion = 0;

function browserWindow(): (Window & typeof globalThis) | undefined {
	return typeof window === "undefined" ? undefined : window;
}

/** DNS names are case-insensitive and one terminal root-label dot is optional. */
function normalizeHostname(hostname: string): string {
	let normalized = hostname.toLowerCase();
	if (normalized.startsWith("[") && normalized.endsWith("]")) normalized = normalized.slice(1, -1);
	if (normalized.endsWith(".")) normalized = normalized.slice(0, -1);
	return normalized;
}

function isLoopbackHostname(hostname: string): boolean {
	const normalized = normalizeHostname(hostname);
	return normalized === "localhost"
		|| normalized.endsWith(".localhost")
		|| normalized === "127.0.0.1"
		|| normalized === "::1";
}

function cookieCompatibleGatewayBase(baseUrl: string): boolean {
	const current = browserWindow();
	if (!current) return false;
	try {
		const page = new URL(current.location.origin);
		const gateway = new URL(baseUrl);
		const sameSchemeAndHost = gateway.protocol === page.protocol
			&& normalizeHostname(gateway.hostname) === normalizeHostname(page.hostname);
		if (!sameSchemeAndHost) return false;
		// The server deliberately refuses browser-cookie issuance over insecure
		// non-loopback HTTP. Never replace the only usable bearer in that case.
		return gateway.protocol === "https:" || isLoopbackHostname(gateway.hostname);
	} catch {
		return false;
	}
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
	try { if (typeof localStorage !== "undefined") localStorage.removeItem(GW_AUTH_MODE_KEY); }
	catch { /* recovery still proceeds in memory */ }
	try { if (typeof localStorage !== "undefined") localStorage.removeItem(GW_CONNECTION_REVISION_KEY); }
	catch { /* recovery still proceeds in memory */ }
	try { if (typeof localStorage !== "undefined") localStorage.removeItem(GW_AUTH_MODE_REVISION_KEY); }
	catch { /* recovery still proceeds in memory */ }
}

function isGatewayAuthenticationMode(value: unknown): value is GatewayAuthenticationMode {
	return value === "none" || value === "bearer" || value === "cookie"
		|| value === "localhost" || value === "unknown";
}

function authenticationModeMatchesToken(token: string, mode: GatewayAuthenticationMode): boolean {
	return token === LOCALHOST_TOKEN
		? mode === "localhost" || mode === "cookie" || mode === "unknown"
		: token ? mode === "bearer" : mode === "none";
}

function parsePersistedConnectionRecord(raw: string): PersistedGatewayConnectionRecord | null {
	let candidate: unknown;
	try { candidate = JSON.parse(raw); } catch { return null; }
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
	const value = candidate as Partial<PersistedGatewayConnectionRecord>;
	if (value.version !== 1
		|| typeof value.generation !== "string"
		|| !/^[A-Za-z0-9._~-]{1,200}$/.test(value.generation)
		|| typeof value.baseUrl !== "string"
		|| typeof value.token !== "string"
		|| !isGatewayAuthenticationMode(value.authenticationMode)) return null;

	let normalized: string;
	try { normalized = normalizeGatewayBaseUrl(value.baseUrl); } catch { return null; }
	if (normalized !== value.baseUrl) return null;
	if (!authenticationModeMatchesToken(value.token, value.authenticationMode)) return null;
	return {
		version: 1,
		generation: value.generation,
		baseUrl: normalized,
		token: value.token,
		authenticationMode: value.authenticationMode,
	};
}

function parsePersistedAuthenticationModeRecord(raw: string): PersistedGatewayAuthenticationModeRecord | null {
	let candidate: unknown;
	try { candidate = JSON.parse(raw); } catch { return null; }
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
	const value = candidate as Partial<PersistedGatewayAuthenticationModeRecord>;
	if (value.version !== 1
		|| typeof value.generation !== "string"
		|| !/^[A-Za-z0-9._~-]{1,200}$/.test(value.generation)
		|| !isGatewayAuthenticationMode(value.authenticationMode)) return null;
	return { version: 1, generation: value.generation, authenticationMode: value.authenticationMode };
}

function readPersistedConnectionRecord(): PersistedGatewayConnectionRead {
	try {
		if (typeof localStorage === "undefined") return { status: "unavailable" };
		const raw = localStorage.getItem(GW_CONNECTION_REVISION_KEY);
		if (raw === null) return { status: "absent" };
		const record = parsePersistedConnectionRecord(raw);
		return record ? { status: "valid", record } : { status: "invalid" };
	} catch {
		return { status: "unavailable" };
	}
}

function persistedConnectionIdentity(read: PersistedGatewayConnectionRead): string {
	return read.status === "valid" ? `valid:${read.record.generation}` : read.status;
}

function newConnectionGeneration(): string {
	try {
		const randomUUID = globalThis.crypto?.randomUUID;
		if (typeof randomUUID === "function") return randomUUID.call(globalThis.crypto);
	} catch { /* a non-security fallback is sufficient for an ordering marker */ }
	fallbackGenerationCounter += 1;
	return `${Date.now().toString(36)}-${fallbackGenerationCounter.toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function persistedConnectionRecord(
	baseUrl: string,
	token: string,
	authenticationMode: GatewayAuthenticationMode,
): PersistedGatewayConnectionRecord {
	return {
		version: 1,
		generation: newConnectionGeneration(),
		baseUrl,
		token,
		authenticationMode,
	};
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

function persistedAuthenticationMode(
	connectionRecord: PersistedGatewayConnectionRecord,
): GatewayAuthenticationMode {
	try {
		if (typeof localStorage === "undefined") return connectionRecord.authenticationMode;
		const raw = localStorage.getItem(GW_AUTH_MODE_REVISION_KEY);
		if (!raw) return connectionRecord.authenticationMode;
		const modeRecord = parsePersistedAuthenticationModeRecord(raw);
		if (modeRecord?.generation !== connectionRecord.generation
			|| !authenticationModeMatchesToken(connectionRecord.token, modeRecord.authenticationMode)) {
			return connectionRecord.authenticationMode;
		}
		return modeRecord.authenticationMode;
	} catch {
		return connectionRecord.authenticationMode;
	}
}

function notifyGatewayConnectionChanged(baseUrl: string, source: "local" | "cross-tab"): void {
	try {
		browserWindow()?.dispatchEvent(new CustomEvent("bobbit:gateway-connection-changed", {
			// Never expose the current-tab-only bearer through a document-wide event.
			detail: { baseUrl, source },
		}));
	} catch { /* notification is best effort */ }
}

function requestCrossTabReload(): void {
	if (crossTabReloadRequested) return;
	crossTabReloadRequested = true;
	try {
		const current = browserWindow();
		if (current && typeof current.location.reload === "function") current.location.reload();
	} catch { /* the reconciled boundary still prevents use of the stale target */ }
}

function applyPersistedConnectionRecord(record: PersistedGatewayConnectionRecord, reloadOnTargetChange: boolean): void {
	if (record.generation === activeConnectionGeneration) return;
	const previous = activeConnection;
	const previousMode = activeAuthenticationMode;
	const authenticationMode = persistedAuthenticationMode(record);
	activeConnection = { baseUrl: record.baseUrl, token: record.token };
	activeAuthenticationMode = authenticationMode;
	activeConnectionGeneration = record.generation;
	activeConnectionVersion += 1;
	const targetChanged = previous !== null
		&& (previous.baseUrl !== record.baseUrl || previous.token !== record.token);
	if (previous && (targetChanged || previousMode !== authenticationMode)) {
		notifyGatewayConnectionChanged(record.baseUrl, "cross-tab");
	}
	if (targetChanged && reloadOnTargetChange) requestCrossTabReload();
}

function applyRemovedPersistedConnection(reloadOnTargetChange: boolean): void {
	if (activeConnectionGeneration === null) return;
	const fallback: ActiveGatewayConnection = { baseUrl: sameOriginGatewayBaseUrl(), token: "" };
	const targetChanged = !activeConnection
		|| activeConnection.baseUrl !== fallback.baseUrl
		|| activeConnection.token !== fallback.token;
	activeConnection = fallback;
	activeAuthenticationMode = "none";
	activeConnectionGeneration = null;
	activeConnectionVersion += 1;
	if (targetChanged) notifyGatewayConnectionChanged(fallback.baseUrl, "cross-tab");
	if (targetChanged && reloadOnTargetChange) requestCrossTabReload();
}

function reconcilePersistedConnection(reloadOnTargetChange: boolean, eventValue?: string | null): void {
	let persisted = readPersistedConnectionRecord();
	// If storage became unavailable after it emitted an event, the event's value
	// is still an atomic, exact snapshot. It never contains a same-host bearer.
	if (persisted.status === "unavailable" && eventValue !== undefined) {
		if (eventValue === null) persisted = { status: "absent" };
		else {
			const record = parsePersistedConnectionRecord(eventValue);
			persisted = record ? { status: "valid", record } : { status: "invalid" };
		}
	}
	if (persisted.status === "valid") {
		applyPersistedConnectionRecord(persisted.record, reloadOnTargetChange);
	} else if (persisted.status === "absent") {
		applyRemovedPersistedConnection(reloadOnTargetChange);
	} else if (persisted.status === "invalid") {
		// A malformed atomic record is never combined with any separately stored
		// token. Fall back without authority, exactly like malformed boot storage.
		removeStoredConnection();
		recoveryWarning = INVALID_SAVED_GATEWAY_WARNING;
		applyRemovedPersistedConnection(reloadOnTargetChange);
	}
}

function reconcilePersistedAuthenticationMode(eventValue?: string | null): void {
	if (!activeConnection || !activeConnectionGeneration) return;
	let raw: string | null;
	try {
		raw = typeof localStorage === "undefined" ? null : localStorage.getItem(GW_AUTH_MODE_REVISION_KEY);
	} catch {
		raw = eventValue ?? null;
	}
	if (!raw) return;
	const record = parsePersistedAuthenticationModeRecord(raw);
	if (!record || record.generation !== activeConnectionGeneration
		|| !authenticationModeMatchesToken(activeConnection.token, record.authenticationMode)
		|| record.authenticationMode === activeAuthenticationMode) return;
	activeAuthenticationMode = record.authenticationMode;
	notifyGatewayConnectionChanged(activeConnection.baseUrl, "cross-tab");
}

function ensureCrossTabConnectionListener(): void {
	const current = browserWindow();
	if (!current || crossTabListenerWindow === current || typeof current.addEventListener !== "function") return;
	crossTabListenerWindow = current;
	current.addEventListener("storage", (event: StorageEvent) => {
		if (event.key !== GW_CONNECTION_REVISION_KEY
			&& event.key !== GW_AUTH_MODE_REVISION_KEY
			&& event.key !== null) return;
		try {
			if (event.storageArea && typeof localStorage !== "undefined" && event.storageArea !== localStorage) return;
		} catch { /* the event value remains usable when storage access is blocked */ }
		if (event.key === GW_AUTH_MODE_REVISION_KEY) reconcilePersistedAuthenticationMode(event.newValue);
		else reconcilePersistedConnection(true, event.key === null ? null : event.newValue);
	});
	// Capture runs before feature-level unload flushers. Once a remote selection
	// forces navigation, gatewayUrl must block old-page data from reaching either
	// the old gateway or the newly selected one.
	current.addEventListener("beforeunload", () => {
		if (crossTabReloadRequested) crossTabUnloadStarted = true;
	}, { capture: true });
}

function hydrateActiveConnection(): ActiveGatewayConnection {
	ensureCrossTabConnectionListener();
	// Storage events are the only post-hydration reader. Every transport consumes
	// this already-reconciled pair without independently consulting persistence.
	if (activeConnection) return activeConnection;
	const persisted = readPersistedConnectionRecord();
	if (persisted.status === "valid") {
		applyPersistedConnectionRecord(persisted.record, false);
		return activeConnection!;
	}
	if (persisted.status === "invalid") {
		removeStoredConnection();
		recoveryWarning = INVALID_SAVED_GATEWAY_WARNING;
	}

	const storedUrl = storageValue(GW_URL_KEY);
	const storedToken = storageValue(GW_TOKEN_KEY) ?? "";
	const storedMode = storageValue(GW_AUTH_MODE_KEY);
	if (storedUrl) {
		try {
			activeConnection = { baseUrl: normalizeGatewayBaseUrl(storedUrl), token: storedToken };
			activeAuthenticationMode = storedToken === LOCALHOST_TOKEN
				? (storedMode === "localhost" || storedMode === "cookie" ? storedMode : "unknown")
				: storedToken ? "bearer" : "none";
			return activeConnection;
		} catch {
			// Clear the pair together before any request so a token from a malformed
			// record can never leak to the page-origin fallback.
			removeStoredConnection();
			recoveryWarning = INVALID_SAVED_GATEWAY_WARNING;
		}
	} else if (storedToken || storedMode) {
		removeStoredConnection();
	}
	activeConnection = { baseUrl: sameOriginGatewayBaseUrl(), token: "" };
	activeAuthenticationMode = "none";
	return activeConnection;
}

interface GatewayConnectionSnapshotState extends GatewayConnectionSnapshot {
	readonly version: number;
	readonly generation: string | null;
	readonly persistedIdentity: string;
}

function persistedSelectionDiffersFromActive(read: PersistedGatewayConnectionRead): boolean {
	if (read.status === "valid") return read.record.generation !== activeConnectionGeneration;
	if (read.status === "absent") return activeConnectionGeneration !== null;
	return read.status === "invalid";
}

function reconcilePersistedSelectionForSnapshot(
	read: PersistedGatewayConnectionRead,
): PersistedGatewayConnectionRead {
	if (!persistedSelectionDiffersFromActive(read)) return read;
	reconcilePersistedConnection(false);
	return readPersistedConnectionRecord();
}

/** Current centrally reconciled connection for every browser transport. */
export function activeGatewayConnection(): Readonly<ActiveGatewayConnection> {
	const connection = hydrateActiveConnection();
	return Object.freeze({ ...connection });
}

/**
 * Capture the selected connection and its atomic persisted generation before
 * deferred work. This is the only supported CAS token for a later conditional
 * connection commit.
 */
export function captureGatewayConnectionSnapshot(): GatewayConnectionSnapshot {
	hydrateActiveConnection();
	const persisted = reconcilePersistedSelectionForSnapshot(readPersistedConnectionRecord());
	return Object.freeze({
		connection: Object.freeze({ ...activeConnection! }),
		version: activeConnectionVersion,
		generation: activeConnectionGeneration,
		persistedIdentity: persistedConnectionIdentity(persisted),
	}) as GatewayConnectionSnapshotState;
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

function revisionAllowsMirrorRollback(storage: Storage, previousRevision: string | null): boolean {
	try {
		// The revision itself is never rolled back: setItem is atomic, so a thrown
		// write leaves it unchanged. This check only protects compatibility mirrors.
		return storage.getItem(GW_CONNECTION_REVISION_KEY) === previousRevision;
	} catch {
		return false;
	}
}

/**
 * Publish an authenticated connection in memory, then persist its reload-safe
 * representation. URL compatibility alone never proves that a browser retained
 * the replacement cookie: a real bearer is replaced by the sentinel only after
 * a protected cookie-only request succeeded. The current tab always retains the
 * real bearer in memory, including after successful confirmation.
 */
export function commitGatewayConnection(
	baseUrl: string,
	token: string,
	options: GatewayConnectionCommitOptions = {},
): GatewayConnectionCommitResult {
	const normalized = normalizeGatewayBaseUrl(baseUrl);
	const previousActiveMode = activeAuthenticationMode;
	const confirmedCookie = options.cookieConfirmed === true
		&& cookieCompatibleGatewayBase(normalized);
	const persistCookieSentinel = Boolean(token)
		&& token !== LOCALHOST_TOKEN
		&& confirmedCookie;
	const persistedToken = persistCookieSentinel ? LOCALHOST_TOKEN : token;
	const persistedMode: GatewayAuthenticationMode = persistCookieSentinel
		? options.localhostTrusted ? "localhost" : "cookie"
		: token === LOCALHOST_TOKEN
			? options.localhostTrusted
				? "localhost"
				: confirmedCookie
					? "cookie"
					: (previousActiveMode === "localhost" || previousActiveMode === "cookie" ? previousActiveMode : "unknown")
			: token ? "bearer" : "none";
	activeConnection = { baseUrl: normalized, token };
	activeAuthenticationMode = token && token !== LOCALHOST_TOKEN && !persistCookieSentinel
		? "bearer"
		: persistedMode;
	activeConnectionVersion += 1;

	ensureCrossTabConnectionListener();
	const record = persistedConnectionRecord(normalized, persistedToken, persistedMode);
	const serializedRecord = JSON.stringify(record);
	let storage: Storage;
	let previousUrl: string | null;
	let previousToken: string | null;
	let previousMode: string | null;
	let previousRevision: string | null;
	try {
		if (typeof localStorage === "undefined") return { persisted: false, warning: STORAGE_WARNING };
		storage = localStorage;
		previousUrl = storage.getItem(GW_URL_KEY);
		previousToken = storage.getItem(GW_TOKEN_KEY);
		previousMode = storage.getItem(GW_AUTH_MODE_KEY);
		previousRevision = storage.getItem(GW_CONNECTION_REVISION_KEY);
	} catch {
		return { persisted: false, warning: STORAGE_WARNING };
	}

	try {
		// Write reload-compatible mirrors first, then publish one exact record as
		// the atomic cross-tab commit marker. Other tabs ignore partial mirrors.
		storage.setItem(GW_TOKEN_KEY, persistedToken);
		storage.setItem(GW_AUTH_MODE_KEY, persistedMode);
		storage.setItem(GW_URL_KEY, normalized);
		storage.setItem(GW_CONNECTION_REVISION_KEY, serializedRecord);
	} catch {
		// Restore compatibility mirrors only while no other tab has committed.
		// Never rewrite the atomic revision: a concurrent successful commit wins.
		if (revisionAllowsMirrorRollback(storage, previousRevision)) {
			try { restoreStorageValue(storage, GW_URL_KEY, previousUrl); } catch { /* best effort */ }
			try { restoreStorageValue(storage, GW_TOKEN_KEY, previousToken); } catch { /* best effort */ }
			try { restoreStorageValue(storage, GW_AUTH_MODE_KEY, previousMode); } catch { /* best effort */ }
		}
		return { persisted: false, warning: STORAGE_WARNING };
	}

	activeConnectionGeneration = record.generation;
	notifyGatewayConnectionChanged(normalized, "local");
	return { persisted: true };
}

/**
 * Reconcile a deferred snapshot with both delivered StorageEvents and the latest
 * atomic storage record. Callers use the returned connection on every outcome,
 * including a failed or rejected deferred request.
 */
export function reconcileGatewayConnectionSnapshot(
	snapshot: GatewayConnectionSnapshot,
): GatewayConnectionSnapshotResult {
	const expected = snapshot as GatewayConnectionSnapshotState;
	const current = hydrateActiveConnection();
	if (activeConnectionVersion !== expected.version
		|| activeConnectionGeneration !== expected.generation
		|| current.baseUrl !== expected.connection.baseUrl
		|| current.token !== expected.connection.token) {
		return { unchanged: false, connection: Object.freeze({ ...current }) };
	}

	const persisted = readPersistedConnectionRecord();
	if (persistedConnectionIdentity(persisted) !== expected.persistedIdentity) {
		reconcilePersistedSelectionForSnapshot(persisted);
		return { unchanged: false, connection: Object.freeze({ ...hydrateActiveConnection() }) };
	}
	return { unchanged: true, connection: Object.freeze({ ...current }) };
}

/**
 * Commit only if neither this tab nor persisted cross-tab state changed since
 * the snapshot. The final synchronous persistence check catches a storage
 * update even when its StorageEvent has not been delivered yet.
 */
export function commitGatewayConnectionIfUnchanged(
	snapshot: GatewayConnectionSnapshot,
	baseUrl: string,
	token: string,
	options: GatewayConnectionCommitOptions = {},
): GatewayConnectionConditionalCommitResult {
	const reconciled = reconcileGatewayConnectionSnapshot(snapshot);
	if (!reconciled.unchanged) {
		return { committed: false, persisted: false, connection: reconciled.connection };
	}

	const commit = commitGatewayConnection(baseUrl, token, options);
	return {
		...commit,
		committed: true,
		connection: Object.freeze({ ...hydrateActiveConnection() }),
	};
}

/** Record the non-secret auth mode reported by an authenticated health check. */
export function recordGatewayLocalhostMode(localhostTrusted: boolean): void {
	const connection = hydrateActiveConnection();
	const persistedToken = storageValue(GW_TOKEN_KEY);
	const persistedUrl = storageValue(GW_URL_KEY);
	let persistenceMatchesActive = false;
	try {
		persistenceMatchesActive = Boolean(persistedUrl)
			&& normalizeGatewayBaseUrl(persistedUrl!) === connection.baseUrl;
	} catch { /* malformed persistence is recovered on the next hydration */ }
	activeAuthenticationMode = localhostTrusted
		? "localhost"
		: connection.token === LOCALHOST_TOKEN || (persistenceMatchesActive && persistedToken === LOCALHOST_TOKEN)
			? "cookie"
			: connection.token ? "bearer" : "none";
	if (!persistenceMatchesActive || persistedToken === null) return;

	try {
		if (typeof localStorage === "undefined") return;
		localStorage.setItem(GW_AUTH_MODE_KEY, activeAuthenticationMode);
		if (activeConnectionGeneration) {
			// Bind the mode to the selected generation. A late health response for A
			// can never overwrite or modify a newer connection B.
			const modeRecord: PersistedGatewayAuthenticationModeRecord = {
				version: 1,
				generation: activeConnectionGeneration,
				authenticationMode: activeAuthenticationMode,
			};
			localStorage.setItem(GW_AUTH_MODE_REVISION_KEY, JSON.stringify(modeRecord));
		}
	} catch { /* unknown mode fails closed by disabling cross-device handoff */ }
}

/** Build a phone handoff only when this tab still has a transferable authority. */
export function gatewayMobileHandoff(): GatewayMobileHandoff {
	const connection = hydrateActiveConnection();
	if (connection.token && connection.token !== LOCALHOST_TOKEN) {
		return {
			supported: true,
			url: gatewayUrl(gatewayRoute(`/?token=${encodeURIComponent(connection.token)}`), connection.baseUrl),
		};
	}
	if (connection.token === LOCALHOST_TOKEN && activeAuthenticationMode === "localhost") {
		return { supported: true, url: gatewayUrl(gatewayRoute("/"), connection.baseUrl) };
	}
	return { supported: false, message: QR_COOKIE_REENTRY_MESSAGE };
}

/** Resolve one internal route against the selected (or explicit) gateway base. */
export function gatewayUrl(route: GatewayRoute, explicitBase?: string): PublicGatewayUrl {
	if (crossTabUnloadStarted) throw new Error(CROSS_TAB_CONNECTION_CHANGED_ERROR);
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

/**
 * Prove that the browser can use the candidate without Bearer authority. The
 * ordinary protected cwd read is deliberately CORS-simple and side-effect free.
 * Redirects cannot count as proof (for example, an OAuth login page).
 */
export async function confirmGatewayCookieAuthentication(baseUrl: string): Promise<boolean> {
	let normalized: string;
	try {
		normalized = normalizeGatewayBaseUrl(baseUrl);
	} catch {
		return false;
	}
	if (!cookieCompatibleGatewayBase(normalized)) return false;
	try {
		const response = await fetch(gatewayUrl(gatewayRoute("/api/config/cwd"), normalized), {
			credentials: "include",
			redirect: "error",
		});
		return response.ok;
	} catch {
		return false;
	}
}

/** Compatibility and confirmed-auth boundary for native cookie-only transports. */
export function gatewayNativeTransportSupport(explicitBase?: string): GatewayNativeTransportSupport {
	let baseUrl: string;
	try {
		baseUrl = explicitBase === undefined ? gatewayBaseUrl() : normalizeGatewayBaseUrl(explicitBase);
	} catch {
		return { supported: false, message: NATIVE_TRANSPORT_WARNING };
	}
	if (!cookieCompatibleGatewayBase(baseUrl)) {
		return { supported: false, message: NATIVE_TRANSPORT_WARNING };
	}
	const connection = hydrateActiveConnection();
	if (connection.baseUrl !== baseUrl
		|| (activeAuthenticationMode !== "cookie" && activeAuthenticationMode !== "localhost")) {
		return { supported: false, message: NATIVE_TRANSPORT_UNCONFIRMED_WARNING };
	}
	return { supported: true };
}

/** Central credentialed HTTP transport. Route strings are validated at entry. */
export function gatewayFetch(route: GatewayRoute | string, init: RequestInit = {}): Promise<Response> {
	const connection = hydrateActiveConnection();
	const internalRoute = typeof route === "string" ? gatewayRoute(route) : route;
	const headers = new Headers(init.headers);
	const method = (init.method ?? "GET").toUpperCase();
	if (crossTabReloadRequested && method !== "GET" && method !== "HEAD") {
		return Promise.reject(new Error(CROSS_TAB_CONNECTION_CHANGED_ERROR));
	}
	// Keep bodyless reads CORS-simple. A same-host, different-port deployment can
	// then prove its exact signed cookie after a gateway restart before any later
	// JSON mutation needs an unauthenticated preflight.
	if (!headers.has("Content-Type") && (method !== "GET" && method !== "HEAD")) {
		headers.set("Content-Type", "application/json");
	}
	const authorization = gatewayAuthorizationHeaders(connection.token).Authorization;
	if (authorization) headers.set("Authorization", authorization);
	else headers.delete("Authorization");
	return fetch(gatewayUrl(internalRoute, connection.baseUrl), {
		...init,
		credentials: init.credentials ?? "include",
		headers,
	});
}

function isLegacyRootCacheName(name: string): boolean {
	// Keep this ownership proof in lockstep with public/sw.js. A broad `bobbit-`
	// prefix can belong to another shared-origin application.
	return /^bobbit-(?:v\d+|dev-\d+|[a-z0-9]+-[a-z0-9]{6})$/.test(name);
}

function cacheMount(cacheName: string): string | null {
	if (isLegacyRootCacheName(cacheName)) return "";
	if (!cacheName.startsWith(BOBBIT_CACHE_PREFIX)) return null;
	const encodedEnd = cacheName.indexOf(":", BOBBIT_CACHE_PREFIX.length);
	if (encodedEnd < 0) return null;
	try {
		const decoded = decodeURIComponent(cacheName.slice(BOBBIT_CACHE_PREFIX.length, encodedEnd));
		if (decoded === "/") return "";
		const normalized = normalizeBasePath(decoded);
		return normalized === decoded ? normalized : null;
	} catch {
		return null;
	}
}

function workerMount(scriptURL: string, origin: string): string | null {
	try {
		const script = new URL(scriptURL, origin);
		if (script.origin !== origin || !script.pathname.endsWith("/sw.js")) return null;
		const rawMount = script.pathname.slice(0, -"/sw.js".length);
		const normalized = normalizeBasePath(rawMount);
		return normalized === rawMount ? normalized : null;
	} catch {
		return null;
	}
}

function registrationMount(registration: BobbitServiceWorkerRegistrationLike, origin: string): string | null {
	const worker = registration.active ?? registration.waiting ?? registration.installing;
	if (!worker) return null;
	const mount = workerMount(worker.scriptURL, origin);
	if (mount === null) return null;
	try {
		const scope = new URL(registration.scope, origin);
		if (scope.origin !== origin || scope.pathname !== `${mount}/`) return null;
		return mount;
	} catch {
		return null;
	}
}

/**
 * Prepare this mount without mutating disjoint sibling applications. Only a
 * proven historical root Bobbit registration can be retired: its scope can
 * control every mounted page. If a wrong controller cannot be proven and
 * released, fail closed before any gateway credential or request is touched.
 */
export async function prepareRuntimeServiceWorkerMount(
	environment: BobbitServiceWorkerMountEnvironment = {},
): Promise<ServiceWorkerMountPreparationResult> {
	const result: ServiceWorkerMountPreparationResult = {
		deletedCaches: 0,
		registered: false,
		reloadRequested: false,
		retiredRegistrations: 0,
		safeToProceed: true,
	};
	const current = browserWindow();
	const rawOrigin = environment.origin ?? current?.location.origin;
	if (!rawOrigin) return result;
	let origin: string;
	try { origin = new URL(rawOrigin).origin; } catch { return { ...result, safeToProceed: false }; }

	const serviceWorker = environment.serviceWorker
		?? (typeof navigator !== "undefined" && "serviceWorker" in navigator
			? navigator.serviceWorker as unknown as BobbitServiceWorkerContainerLike
			: undefined);
	const cacheStorage = environment.cacheStorage
		?? (typeof caches !== "undefined" ? caches as unknown as BobbitCacheStorageLike : undefined);
	const reloadStorage = environment.sessionStorage
		?? (typeof sessionStorage !== "undefined" ? sessionStorage : undefined);
	const basePath = runtimeBasePath();

	let cacheNames: string[] = [];
	let registrations: BobbitServiceWorkerRegistrationLike[] = [];
	let cacheDiscoveryComplete = !cacheStorage;
	let registrationDiscoveryComplete = !serviceWorker;
	if (cacheStorage) {
		try { cacheNames = await cacheStorage.keys(); cacheDiscoveryComplete = true; }
		catch { cacheDiscoveryComplete = false; }
	}
	if (serviceWorker) {
		try { registrations = await serviceWorker.getRegistrations(); registrationDiscoveryComplete = true; }
		catch { registrationDiscoveryComplete = false; }
	}

	const rootCacheNames = cacheNames.filter((name) => cacheMount(name) === "");
	const rootRegistrations = registrations.filter((registration) => registrationMount(registration, origin) === "");
	const controller = serviceWorker?.controller ?? null;
	const controllerMount = controller ? workerMount(controller.scriptURL, origin) : null;
	const wrongController = Boolean(controller) && controllerMount !== basePath;

	const retireProvenRootState = async (): Promise<boolean> => {
		if (!basePath || !cacheDiscoveryComplete || !registrationDiscoveryComplete) return false;
		if (rootCacheNames.length === 0 || rootRegistrations.length === 0) return false;
		let retired = false;
		for (const registration of rootRegistrations) {
			try {
				if (await registration.unregister()) {
					result.retiredRegistrations += 1;
					retired = true;
				}
			} catch { /* retain it and fail closed when it is the controller */ }
		}
		if (!retired || !cacheStorage) return retired;
		for (const name of rootCacheNames) {
			try {
				if (await cacheStorage.delete(name)) result.deletedCaches += 1;
			} catch { /* registration retirement is the security boundary */ }
		}
		return true;
	};

	if (wrongController) {
		result.safeToProceed = false;
		// Only the historical root migration has enough independent ownership
		// evidence to remove. Empty/failed discovery and other mounts are never
		// guessed from a conventional script filename.
		const retired = controllerMount === "" ? await retireProvenRootState() : false;
		if (!retired) return result;

		const guardValue = `${basePath || "/"}|${controller!.scriptURL}`;
		let alreadyReloaded = false;
		try { alreadyReloaded = reloadStorage?.getItem(SERVICE_WORKER_RELOAD_GUARD_KEY) === guardValue; }
		catch { /* use the in-memory guard */ }
		if (!alreadyReloaded && !serviceWorkerReloadRequested) {
			serviceWorkerReloadRequested = true;
			try { reloadStorage?.setItem(SERVICE_WORKER_RELOAD_GUARD_KEY, guardValue); } catch { /* best effort */ }
			result.reloadRequested = true;
			try { (environment.reload ?? (() => current?.location.reload()))(); } catch { /* best effort */ }
		}
		return result;
	}

	// A proven, uncontrolled historical root registration can still claim this
	// mount on a later navigation. Retire only that overlapping state; sibling
	// mounts and their cache generations remain entirely untouched.
	await retireProvenRootState();
	serviceWorkerReloadRequested = false;
	try { reloadStorage?.removeItem(SERVICE_WORKER_RELOAD_GUARD_KEY); } catch { /* best effort */ }

	if (serviceWorker) {
		try {
			await serviceWorker.register(appUrl("/sw.js"), { scope: `${basePath}/` });
			result.registered = true;
		} catch { /* authenticated startup retries once after cookie bootstrap */ }
	}
	return result;
}

function previewRouteCandidate(raw: string): GatewayRoute | null {
	try { return previewGatewayRoute(raw); } catch { return null; }
}

function splitPathSuffix(raw: string): { pathname: string; suffix: string } {
	const boundary = raw.search(/[?#]/);
	return boundary < 0 ? { pathname: raw, suffix: "" } : { pathname: raw.slice(0, boundary), suffix: raw.slice(boundary) };
}

function stripKnownPreviewMount(pathname: string, suffix: string, basePath: string): GatewayRoute | null {
	const stripped = stripBasePath(pathname, basePath);
	return stripped === null ? null : previewRouteCandidate(`${stripped}${suffix}`);
}

/** Decode a current or historical preview URL to the internal `/preview/...` route. */
export function previewRouteFromStoredValue(value: unknown): GatewayRoute | null {
	if (typeof value !== "string" || !value || /[\\\u0000-\u001f\u007f]/u.test(value)) return null;
	const direct = previewRouteCandidate(value);
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
		const known = stripKnownPreviewMount(pathname, suffix, selected.pathname === "/" ? "" : selected.pathname);
		if (known) return known;
	} else if (value.startsWith("/")) {
		({ pathname, suffix } = splitPathSuffix(value));
		const selectedBasePath = selected && selected.pathname !== "/" ? selected.pathname : "";
		const knownBases = new Set([runtimeBasePath(), selectedBasePath]);
		for (const base of knownBases) {
			const known = stripKnownPreviewMount(pathname, suffix, base);
			if (known) return known;
		}
	} else {
		return null;
	}

	// Last-resort compatibility for records written under a no-longer-known
	// mount. Only the validated internal suffix survives; the historical origin
	// and prefix are never fetched or navigated.
	const marker = pathname.lastIndexOf("/preview/");
	return marker < 0 ? null : previewRouteCandidate(`${pathname.slice(marker)}${suffix}`);
}

/** Test-only reset for isolated browser-boundary cases. */
export function __resetGatewayConnectionForTests(): void {
	activeConnection = null;
	activeAuthenticationMode = "none";
	activeConnectionGeneration = null;
	recoveryWarning = null;
	serviceWorkerReloadRequested = false;
	crossTabReloadRequested = false;
	crossTabUnloadStarted = false;
	activeConnectionVersion = 0;
}
