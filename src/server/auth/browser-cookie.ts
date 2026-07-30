/**
 * Pure browser-cookie issuance classifier.
 *
 * This module does not authenticate requests. Callers must resolve credentials,
 * verify signed cookies, and enforce route authorization before using this
 * classification to decide whether an authenticated response may set a cookie.
 * Fetch Metadata and Origin are routing/performance signals only.
 */

export type BrowserCookieHeaderValue = string | readonly string[] | undefined;
export type BrowserCookieHeaders = Readonly<Record<string, BrowserCookieHeaderValue>>;

export interface BrowserCookieRequestMetadata {
	method?: string;
	pathname: string;
	headers: BrowserCookieHeaders;
	/** Whether the gateway request arrived over TLS. Forwarded headers are not trusted. */
	isTls: boolean;
}

/**
 * Authentication already established by the caller, never by this classifier.
 * `signed-cookie` means a valid cookie won authentication. The Bearer/local
 * sources are used for bootstrap only when no valid signed cookie was accepted.
 */
export type BrowserCookieAuthentication =
	| { source: "admin-bearer" }
	| { source: "localhost-trusted" }
	| { source: "signed-cookie"; needsRenewal: boolean }
	| { source: "other" };

export interface BrowserCookieEligibilityContext {
	/** `direct` serves the built UI; `vite` permits the development proxy origin exception. */
	deployment: "direct" | "vite";
	/** Gateway bind host (`GatewayConfig.host`), used only by the Vite exception. */
	configuredHost: string;
	authentication: BrowserCookieAuthentication;
	/**
	 * True when any presented Authorization or query credential resolved to a
	 * sandbox token, even if a different credential won authentication.
	 */
	hasSandboxCredential?: boolean;
}

export type BrowserCookieEligibilityReason =
	| "eligible-bootstrap"
	| "eligible-renewal"
	| "session-bound-request"
	| "sandbox-credential-presented"
	| "internal-callback-route"
	| "invalid-fetch-site"
	| "invalid-fetch-mode"
	| "invalid-request-host"
	| "invalid-origin"
	| "origin-required"
	| "insecure-non-loopback-origin"
	| "origin-mismatch"
	| "cookie-renewal-not-needed"
	| "ineligible-authentication";

export interface BrowserCookieEligibility {
	mayBootstrap: boolean;
	mayRenew: boolean;
	reason: BrowserCookieEligibilityReason;
}

/**
 * Whether a browser session cookie needs the Secure attribute for this request.
 * The direct socket transport and Host header are authoritative: forwarded
 * headers are deliberately ignored. Invalid/missing Host values fail secure.
 */
export function browserCookieRequiresSecure(
	request: Pick<BrowserCookieRequestMetadata, "headers" | "isTls">,
): boolean {
	if (request.isTls) return true;
	const requestOrigin = parseRequestOrigin(request.headers, false);
	return !requestOrigin || !isLoopbackHostname(requestOrigin.hostname);
}

const INELIGIBLE_SESSION_HEADERS = [
	"x-bobbit-session-id",
	"x-bobbit-spawning-session",
	"x-bobbit-session-secret",
] as const;

interface HeaderResult {
	kind: "missing" | "invalid" | "value";
	value?: string;
}

interface ParsedOrigin {
	origin: string;
	protocol: "http:" | "https:";
	hostname: string;
}

const deny = (reason: Exclude<BrowserCookieEligibilityReason, "eligible-bootstrap" | "eligible-renewal">): BrowserCookieEligibility => ({
	mayBootstrap: false,
	mayRenew: false,
	reason,
});

/**
 * Classify cookie bootstrap/renewal eligibility for an already-authenticated request.
 * The two capabilities are mutually exclusive.
 */
export function classifyBrowserCookieEligibility(
	request: BrowserCookieRequestMetadata,
	context: BrowserCookieEligibilityContext,
): BrowserCookieEligibility {
	if (INELIGIBLE_SESSION_HEADERS.some((name) => hasHeader(request.headers, name))) {
		return deny("session-bound-request");
	}
	if (context.hasSandboxCredential) return deny("sandbox-credential-presented");
	if (isInternalCallbackRoute(request.pathname, request.method)) {
		return deny("internal-callback-route");
	}

	const fetchSite = readSingleHeader(request.headers, "sec-fetch-site");
	const normalizedFetchSite = fetchSite.kind === "value" ? normalizeToken(fetchSite.value) : undefined;
	if (normalizedFetchSite !== "same-origin" && normalizedFetchSite !== "same-site") {
		return deny("invalid-fetch-site");
	}

	const fetchMode = readSingleHeader(request.headers, "sec-fetch-mode");
	const normalizedMode = fetchMode.kind === "value" ? normalizeToken(fetchMode.value) : undefined;
	if (normalizedMode !== "cors" && normalizedMode !== "same-origin") {
		return deny("invalid-fetch-mode");
	}

	const requestOrigin = parseRequestOrigin(request.headers, request.isTls);
	if (!requestOrigin) return deny("invalid-request-host");
	if (requestOrigin.protocol === "http:" && !isLoopbackHostname(requestOrigin.hostname)) {
		return deny("insecure-non-loopback-origin");
	}

	const originHeader = readSingleHeader(request.headers, "origin");
	if (originHeader.kind === "invalid") return deny("invalid-origin");
	if (originHeader.kind === "missing") {
		// Same-origin navigational GETs may omit Origin. A `same-site` request and
		// every mutating request need the serialized browser origin so hostname and
		// scheme compatibility can be proven rather than inferred.
		if (normalizedFetchSite === "same-site" || normalizeMethod(request.method) !== "GET") {
			return deny("origin-required");
		}
	} else {
		const browserOrigin = parseOriginHeader(originHeader.value!);
		if (!browserOrigin) return deny("invalid-origin");
		if (browserOrigin.protocol === "http:" && !isLoopbackHostname(browserOrigin.hostname)) {
			return deny("insecure-non-loopback-origin");
		}
		if (normalizedFetchSite === "same-site" && browserOrigin.origin === requestOrigin.origin) {
			// An exact origin is serialized by browsers as `same-origin`, not `same-site`.
			return deny("invalid-fetch-site");
		}
		if (!isAcceptedOrigin(browserOrigin, requestOrigin, context)) return deny("origin-mismatch");
	}

	switch (context.authentication.source) {
		case "admin-bearer":
		case "localhost-trusted":
			return { mayBootstrap: true, mayRenew: false, reason: "eligible-bootstrap" };
		case "signed-cookie":
			return context.authentication.needsRenewal
				? { mayBootstrap: false, mayRenew: true, reason: "eligible-renewal" }
				: deny("cookie-renewal-not-needed");
		default:
			return deny("ineligible-authentication");
	}
}

function isInternalCallbackRoute(pathname: string, method: string | undefined): boolean {
	if (pathname === "/api/internal" || pathname.startsWith("/api/internal/")) return true;

	const normalizedMethod = normalizeMethod(method);
	if (normalizedMethod === "POST" && /^\/api\/sessions\/[^/]+\/provider-hooks\/(?:before-prompt|before-compact)$/.test(pathname)) {
		return true;
	}
	if (normalizedMethod === "GET" && /^\/api\/sessions\/[^/]+\/(?:google-code-assist\/token|preview-events)$/.test(pathname)) {
		return true;
	}
	return normalizedMethod === "POST" && /^\/api\/sessions\/[^/]+\/tool-grant-request$/.test(pathname);
}

function normalizeMethod(method: string | undefined): string {
	return (method ?? "").trim().toUpperCase();
}

function normalizeToken(value: string | undefined): string {
	return (value ?? "").trim().toLowerCase();
}

function hasHeader(headers: BrowserCookieHeaders, wantedName: string): boolean {
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() === wantedName && value !== undefined) return true;
	}
	return false;
}

function readSingleHeader(headers: BrowserCookieHeaders, wantedName: string): HeaderResult {
	let found: BrowserCookieHeaderValue;
	let count = 0;
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() !== wantedName || value === undefined) continue;
		count++;
		found = value;
	}
	if (count === 0) return { kind: "missing" };
	if (count !== 1 || typeof found !== "string") return { kind: "invalid" };
	return { kind: "value", value: found };
}

function parseRequestOrigin(headers: BrowserCookieHeaders, isTls: boolean): ParsedOrigin | undefined {
	const hostHeader = readSingleHeader(headers, "host");
	if (hostHeader.kind !== "value") return undefined;
	const authority = hostHeader.value!;
	if (
		authority !== authority.trim()
		|| authority.length === 0
		|| authority.endsWith(":")
		|| /[\s,/?#\\@]/.test(authority)
	) return undefined;

	return parseOrigin(`${isTls ? "https" : "http"}://${authority}`);
}

function parseOriginHeader(raw: string): ParsedOrigin | undefined {
	// Origin is one serialized origin, never a URL with credentials or a resource path.
	if (raw !== raw.trim() || !/^https?:\/\/[^\s,/?#\\]+$/i.test(raw)) return undefined;
	return parseOrigin(raw);
}

/** Return the canonical value for one valid serialized HTTP(S) Origin header. */
export function canonicalHttpOrigin(raw: string | readonly string[] | undefined): string | undefined {
	if (typeof raw !== "string") return undefined;
	return parseOriginHeader(raw)?.origin;
}

/** Canonical actual gateway origin derived only from the socket TLS bit and Host. */
export function canonicalRequestOrigin(
	request: Pick<BrowserCookieRequestMetadata, "headers" | "isTls">,
): string | undefined {
	return parseRequestOrigin(request.headers, request.isTls)?.origin;
}

/**
 * Canonical browser authority for a cookie-authenticated API/WS request. A
 * serialized Origin wins; originless same-origin requests fall back to the
 * actual gateway origin. Malformed Origin/Host values fail closed.
 */
export function browserCookieRequestOrigin(
	request: Pick<BrowserCookieRequestMetadata, "headers" | "isTls">,
): string | undefined {
	const requestOrigin = canonicalRequestOrigin(request);
	if (!requestOrigin) return undefined;
	const originHeader = readSingleHeader(request.headers, "origin");
	if (originHeader.kind === "invalid") return undefined;
	if (originHeader.kind === "value") return parseOriginHeader(originHeader.value!)?.origin;
	return requestOrigin;
}

function parseOrigin(raw: string): ParsedOrigin | undefined {
	try {
		const parsed = new URL(raw);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
		if (parsed.username || parsed.password || !parsed.hostname || parsed.pathname !== "/" || parsed.search || parsed.hash) {
			return undefined;
		}
		return {
			origin: parsed.origin,
			protocol: parsed.protocol,
			hostname: normalizeHostname(parsed.hostname),
		};
	} catch {
		return undefined;
	}
}

function isSameSchemeHost(a: ParsedOrigin, b: ParsedOrigin): boolean {
	return a.protocol === b.protocol && a.hostname === b.hostname;
}

function isAcceptedOrigin(
	browserOrigin: ParsedOrigin,
	requestOrigin: ParsedOrigin,
	context: BrowserCookieEligibilityContext,
): boolean {
	if (browserOrigin.origin === requestOrigin.origin) return true;
	if (context.deployment === "direct") {
		// A production UI may intentionally select a gateway on another port of
		// the same scheme/normalized host. Only a real admin bearer may establish
		// that binding; subsequent renewal is safe only because the caller first
		// completed centralized verification of the cookie's exact origin claim.
		const hasBindingAuthority = context.authentication.source === "admin-bearer"
			|| context.authentication.source === "signed-cookie";
		return hasBindingAuthority && isSameSchemeHost(browserOrigin, requestOrigin);
	}

	const configuredHostname = normalizeConfiguredHostname(context.configuredHost);
	const bothUseConfiguredHost = configuredHostname !== undefined
		&& browserOrigin.hostname === configuredHostname
		&& requestOrigin.hostname === configuredHostname;
	const bothLoopback = isLoopbackHostname(browserOrigin.hostname)
		&& isLoopbackHostname(requestOrigin.hostname);
	return browserOrigin.protocol === requestOrigin.protocol && (bothUseConfiguredHost || bothLoopback);
}

/**
 * Legacy unbound v1 cookies remain valid only for the gateway's exact origin.
 * Cross-port compatibility is provided exclusively by v1.2's signed origin
 * claim. Requests without Origin retain same-origin/non-browser compatibility.
 */
export function isBrowserCookieAuthenticationCompatible(
	request: Pick<BrowserCookieRequestMetadata, "headers" | "isTls">,
	_context: Pick<BrowserCookieEligibilityContext, "deployment" | "configuredHost">,
): boolean {
	const originHeader = readSingleHeader(request.headers, "origin");
	if (originHeader.kind === "missing") return canonicalRequestOrigin(request) !== undefined;
	if (originHeader.kind === "invalid") return false;
	const browserOrigin = parseOriginHeader(originHeader.value!);
	const requestOrigin = parseRequestOrigin(request.headers, request.isTls);
	// This helper is now the legacy-v1 compatibility boundary. Bound v1.2
	// cookies prove their exact cross-port UI origin cryptographically instead.
	return Boolean(browserOrigin && requestOrigin && browserOrigin.origin === requestOrigin.origin);
}

function normalizeConfiguredHostname(host: string): string | undefined {
	const value = host.trim();
	if (!value || /[\s,/?#\\@]/.test(value)) return undefined;
	if (value.startsWith("[") && value.endsWith("]")) return normalizeHostname(value.slice(1, -1));
	// GatewayConfig.host stores IPv6 literals without brackets.
	if (value.includes(":")) return normalizeHostname(value);
	try {
		return normalizeHostname(new URL(`http://${value}`).hostname);
	} catch {
		return undefined;
	}
}

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
