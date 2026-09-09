import {
	API_CORS_ALLOWED_HEADERS,
	API_CORS_ALLOWED_METHODS,
	API_CORS_PREFLIGHT_MAX_AGE_SECONDS,
} from "./cors.js";

export type RequestTransport = "http" | "websocket";

export type RequestRouteContext =
	| "api"
	| "preflight"
	| "preview-document"
	| "preview-iframe"
	| "preview-resource"
	| "ui-document"
	| "ui-static"
	| "websocket";

export type RequestAdmissionReason =
	| "allowed"
	| "malformed-raw-headers"
	| "missing-host"
	| "duplicate-host"
	| "invalid-host"
	| "untrusted-host"
	| "duplicate-origin"
	| "invalid-origin"
	| "origin-mismatch"
	| "duplicate-fetch-metadata"
	| "invalid-fetch-metadata"
	| "partial-fetch-metadata"
	| "cross-site-browser-request"
	| "origin-required"
	| "unsafe-navigation-method"
	| "invalid-request-target"
	| "invalid-preflight"
	| "preflight-method-denied"
	| "preflight-header-denied"
	| "private-network-denied";

export interface ViteOriginPairInput {
	/** Browser-visible Vite origin. */
	origin: string;
	/** Gateway origin that Vite proxies to. */
	gatewayOrigin: string;
}

export interface RequestAdmissionPolicyInput {
	/** Configured listener host. Wildcard listener addresses are never trusted. */
	bindHost: string;
	/** Actual bound port, after port-zero selection or auto-increment. */
	actualPort: number;
	/** Whether direct listener requests use HTTPS. */
	isTls?: boolean;
	basePath?: string;
	/** Additional finite DNS or IP names served by the direct listener (for example a mesh address). */
	trustedHosts?: readonly string[];
	/** Finite names covered by the configured TLS certificate. */
	tlsHostnames?: readonly string[];
	/** Explicit externally visible origins, including reverse-proxy scheme and port. */
	publicOrigins?: readonly string[];
	/** The normalized origin published after binding, when present. */
	publishedOrigin?: string;
	/** Finite development mappings; arbitrary localhost ports are not inferred. */
	viteOriginPairs?: readonly ViteOriginPairInput[];
	cors?: {
		allowedMethods?: readonly string[];
		allowedHeaders?: readonly string[];
		maxAgeSeconds?: number;
	};
}

export interface RequestAdmissionMetadata {
	rawHeaders: readonly string[];
	method?: string;
	/** Raw origin-form request target. It is parsed against a fixed sentinel, never Host. */
	url?: string;
	isTls: boolean;
	transport?: RequestTransport;
}

export interface CorsProjection {
	allowOrigin: string;
	varyOrigin: true;
	allowCredentials: boolean;
	allowMethod?: string;
	allowHeaders?: readonly string[];
	maxAgeSeconds?: number;
}

export interface RequestAdmissionAllowed {
	allowed: true;
	reason: "allowed";
	context: RequestRouteContext;
	normalizedHost: string;
	/** Canonical browser Origin, when the request supplied one. */
	normalizedOrigin?: string;
	/**
	 * Canonical browser-facing gateway origin selected only from the compiled
	 * policy. This intentionally differs from normalizedOrigin for Vite proxying.
	 * It is omitted when the request does not identify one unambiguously.
	 */
	gatewayOrigin?: string;
	/** Whether this policy contains only loopback gateway authorities. */
	trustedLocal: boolean;
	cors?: CorsProjection;
}

export interface RequestAdmissionDenied {
	allowed: false;
	reason: Exclude<RequestAdmissionReason, "allowed">;
	context: RequestRouteContext;
	normalizedHost?: string;
	normalizedOrigin?: string;
}

export type RequestAdmissionDecision = RequestAdmissionAllowed | RequestAdmissionDenied;

interface ParsedOrigin {
	serialized: string;
	protocol: "http:" | "https:";
	hostname: string;
	port: number;
	authorityKey: string;
}

interface ParsedHost {
	hostname: string;
	explicitPort?: number;
	serialized: string;
}

interface CompiledVitePair {
	origin: ParsedOrigin;
	gateway: ParsedOrigin;
}

export interface RequestAdmissionPolicy {
	readonly basePath: string;
	readonly trustedOrigins: readonly string[];
	readonly viteOriginPairs: readonly Readonly<ViteOriginPairInput>[];
	/**
	 * True only when the listener and every admitted browser/gateway origin in the
	 * complete compiled policy are loopback. Wildcard/non-loopback listeners and any
	 * non-loopback authority disable the local auth bypass for the whole policy.
	 */
	readonly allAuthoritiesLoopback: boolean;
	/** @internal Immutable-by-convention data consumed by admitRequest. */
	readonly _compiled: {
		readonly origins: readonly ParsedOrigin[];
		readonly vitePairs: readonly CompiledVitePair[];
		readonly corsMethods: readonly string[];
		readonly corsHeaders: Readonly<Record<string, string>>;
		readonly corsMaxAgeSeconds: number;
	};
}

export type RequestAdmissionConfigReason =
	| "invalid-bind-host"
	| "invalid-port"
	| "invalid-base-path"
	| "invalid-trusted-host"
	| "invalid-tls-name"
	| "invalid-public-origin"
	| "invalid-published-origin"
	| "invalid-vite-origin"
	| "untrusted-vite-gateway"
	| "invalid-cors-method"
	| "invalid-cors-header"
	| "invalid-cors-max-age";

export class RequestAdmissionConfigError extends Error {
	constructor(readonly reason: RequestAdmissionConfigReason) {
		super(`Invalid request admission configuration (${reason})`);
		this.name = "RequestAdmissionConfigError";
	}
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"] as const;
const FETCH_HEADER_NAMES = ["sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user"] as const;
const CORE_FETCH_HEADER_NAMES = ["sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"] as const;
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SAFE_METHODS = new Set(["GET", "HEAD"]);
const VALID_FETCH_SITES = new Set(["same-origin", "same-site", "cross-site", "none"]);
const VALID_FETCH_MODES = new Set(["cors", "navigate", "nested-navigate", "no-cors", "same-origin", "websocket"]);
const VALID_FETCH_DESTINATIONS = new Set([
	"audio", "audioworklet", "document", "embed", "empty", "fencedframe", "font", "frame", "iframe", "image", "json",
	"manifest", "object", "paintworklet", "report", "script", "serviceworker", "sharedworker", "style", "track", "video",
	"webidentity", "worker", "xslt",
]);

export function compileRequestAdmissionPolicy(input: RequestAdmissionPolicyInput): RequestAdmissionPolicy {
	if (!Number.isInteger(input.actualPort) || input.actualPort < 1 || input.actualPort > 65_535) {
		throw new RequestAdmissionConfigError("invalid-port");
	}
	const basePath = normalizeBasePath(input.basePath);
	const bindHost = parseConfiguredHostname(input.bindHost);
	if (!bindHost) throw new RequestAdmissionConfigError("invalid-bind-host");

	const directProtocol = input.isTls ? "https:" : "http:";
	const origins: ParsedOrigin[] = [];
	const addOrigin = (origin: ParsedOrigin): void => {
		if (!origins.some((candidate) => candidate.serialized === origin.serialized)) origins.push(origin);
	};
	const addDirectHost = (raw: string, reason: RequestAdmissionConfigReason): void => {
		const hostname = parseConfiguredHostname(raw);
		if (!hostname) throw new RequestAdmissionConfigError(reason);
		if (isWildcardListener(hostname)) return;
		addOrigin(originFromParts(directProtocol, hostname, input.actualPort));
	};

	if (!isWildcardListener(bindHost)) addDirectHost(bindHost, "invalid-bind-host");
	for (const host of LOOPBACK_HOSTS) addDirectHost(host, "invalid-trusted-host");
	for (const host of input.trustedHosts ?? []) addDirectHost(host, "invalid-trusted-host");
	for (const name of input.tlsHostnames ?? []) {
		const hostname = parseConfiguredHostname(name);
		if (!hostname || isWildcardListener(hostname)) throw new RequestAdmissionConfigError("invalid-tls-name");
		addOrigin(originFromParts("https:", hostname, input.actualPort));
	}
	for (const raw of input.publicOrigins ?? []) addOrigin(parseConfiguredOrigin(raw, "invalid-public-origin"));
	if (input.publishedOrigin !== undefined) addOrigin(parseConfiguredOrigin(input.publishedOrigin, "invalid-published-origin"));

	const vitePairs: CompiledVitePair[] = [];
	for (const pair of input.viteOriginPairs ?? []) {
		const origin = parseConfiguredOrigin(pair.origin, "invalid-vite-origin");
		const gateway = parseConfiguredOrigin(pair.gatewayOrigin, "invalid-vite-origin");
		if (!origins.some((trusted) => trusted.serialized === gateway.serialized)) {
			throw new RequestAdmissionConfigError("untrusted-vite-gateway");
		}
		if (!vitePairs.some((candidate) => candidate.origin.serialized === origin.serialized && candidate.gateway.serialized === gateway.serialized)) {
			vitePairs.push({ origin, gateway });
		}
	}

	const corsMethods = Object.freeze([...compileMethods(input.cors?.allowedMethods ?? API_CORS_ALLOWED_METHODS)]);
	const corsHeaders = Object.freeze(Object.fromEntries(compileHeaders(input.cors?.allowedHeaders ?? API_CORS_ALLOWED_HEADERS)));
	const maxAge = input.cors?.maxAgeSeconds ?? API_CORS_PREFLIGHT_MAX_AGE_SECONDS;
	if (!Number.isInteger(maxAge) || maxAge < 0 || maxAge > 86_400) {
		throw new RequestAdmissionConfigError("invalid-cors-max-age");
	}

	const publicPairs = vitePairs.map((pair) => Object.freeze({
		origin: pair.origin.serialized,
		gatewayOrigin: pair.gateway.serialized,
	}));
	const allAuthoritiesLoopback = isLoopbackHostname(bindHost)
		&& origins.every((origin) => isLoopbackHostname(origin.hostname))
		&& vitePairs.every((pair) => isLoopbackHostname(pair.origin.hostname)
			&& isLoopbackHostname(pair.gateway.hostname));
	const compiled = Object.freeze({
		origins: Object.freeze(origins.map((origin) => Object.freeze(origin))),
		vitePairs: Object.freeze(vitePairs.map((pair) => Object.freeze({
			origin: Object.freeze(pair.origin),
			gateway: Object.freeze(pair.gateway),
		}))),
		corsMethods,
		corsHeaders,
		corsMaxAgeSeconds: maxAge,
	});
	return Object.freeze({
		basePath,
		trustedOrigins: Object.freeze(origins.map((origin) => origin.serialized)),
		viteOriginPairs: Object.freeze(publicPairs),
		allAuthoritiesLoopback,
		_compiled: compiled,
	});
}

export function admitRequest(policy: RequestAdmissionPolicy, metadata: RequestAdmissionMetadata): RequestAdmissionDecision {
	const preliminaryContext = classifyContext(policy.basePath, metadata, undefined);
	if (metadata.rawHeaders.length % 2 !== 0) return deny("malformed-raw-headers", preliminaryContext);

	const hostHeader = readRawHeader(metadata.rawHeaders, "host");
	if (hostHeader.kind === "missing") return deny("missing-host", preliminaryContext);
	if (hostHeader.kind === "duplicate") return deny("duplicate-host", preliminaryContext);
	const host = parseRequestHost(hostHeader.value);
	if (!host) return deny("invalid-host", preliminaryContext);
	const matchingOrigins = policy._compiled.origins.filter((origin) => hostMatchesOrigin(host, origin));
	if (matchingOrigins.length === 0) return deny("untrusted-host", preliminaryContext, host.serialized);
	if (parseRequestPathname(metadata.url) === undefined) return deny("invalid-request-target", preliminaryContext, host.serialized);

	const originHeader = readRawHeader(metadata.rawHeaders, "origin");
	if (originHeader.kind === "duplicate") return deny("duplicate-origin", preliminaryContext, host.serialized);
	let origin: ParsedOrigin | undefined;
	if (originHeader.kind === "value") {
		origin = parseSerializedOrigin(originHeader.value);
		if (!origin) return deny("invalid-origin", preliminaryContext, host.serialized);
	}

	const fetchValues: Partial<Record<(typeof FETCH_HEADER_NAMES)[number], string>> = {};
	for (const name of FETCH_HEADER_NAMES) {
		const value = readRawHeader(metadata.rawHeaders, name);
		if (value.kind === "duplicate") return deny("duplicate-fetch-metadata", preliminaryContext, host.serialized, origin?.serialized);
		if (value.kind === "value") fetchValues[name] = value.value;
	}
	const coreFetchCount = CORE_FETCH_HEADER_NAMES.filter(name => fetchValues[name] !== undefined).length;
	const hasFetchSite = fetchValues["sec-fetch-site"] !== undefined;
	const hasFetchMode = fetchValues["sec-fetch-mode"] !== undefined;
	const hasFetchDest = fetchValues["sec-fetch-dest"] !== undefined;
	const hasFetchUser = fetchValues["sec-fetch-user"] !== undefined;
	const isModeOnly = !hasFetchSite && hasFetchMode && !hasFetchDest && !hasFetchUser;
	const isBrowserShape = hasFetchSite && hasFetchMode;
	if ((coreFetchCount !== 0 || hasFetchUser) && !isModeOnly && !isBrowserShape) {
		return deny("partial-fetch-metadata", preliminaryContext, host.serialized, origin?.serialized);
	}
	let fetch: FetchMetadata | undefined;
	if (isModeOnly) {
		const mode = parseHeaderToken(fetchValues["sec-fetch-mode"]);
		if (!mode || !VALID_FETCH_MODES.has(mode)) {
			return deny("invalid-fetch-metadata", preliminaryContext, host.serialized, origin?.serialized);
		}
		// Node's fetch (undici) adds this lone header. Treat its exact originless
		// HTTP shape as non-browser traffic on every route; route authorization
		// (including preview authorization) remains the inner boundary. WebSocket
		// upgrades do not share undici's HTTP request shape.
		if (mode !== "cors" || origin || (metadata.transport ?? "http") === "websocket") {
			return deny("partial-fetch-metadata", preliminaryContext, host.serialized, origin?.serialized);
		}
	} else if (isBrowserShape) {
		fetch = parseFetchMetadata(fetchValues);
		if (!fetch) return deny("invalid-fetch-metadata", preliminaryContext, host.serialized, origin?.serialized);
	}
	const context = classifyContext(policy.basePath, metadata, fetch);

	const requestedMethodHeader = readRawHeader(metadata.rawHeaders, "access-control-request-method");
	const requestedHeadersHeader = readRawHeader(metadata.rawHeaders, "access-control-request-headers");
	const privateNetworkHeader = readRawHeader(metadata.rawHeaders, "access-control-request-private-network");
	if (requestedMethodHeader.kind === "duplicate" || requestedHeadersHeader.kind === "duplicate" || privateNetworkHeader.kind === "duplicate") {
		return deny("invalid-preflight", context, host.serialized, origin?.serialized);
	}
	const hasPreflightFields = requestedMethodHeader.kind !== "missing"
		|| requestedHeadersHeader.kind !== "missing"
		|| privateNetworkHeader.kind !== "missing";
	if (hasPreflightFields || context === "preflight") {
		return admitPreflight(policy, metadata, context, host, matchingOrigins, origin, fetch, requestedMethodHeader, requestedHeadersHeader, privateNetworkHeader);
	}

	const originKind = classifyOrigin(policy, matchingOrigins, origin);
	if (origin && originKind === "mismatch") return deny("origin-mismatch", context, host.serialized, origin.serialized);
	if (fetch && !isCoherentFetchContext(context, fetch)) {
		return deny("invalid-fetch-metadata", context, host.serialized, origin?.serialized);
	}
	if (fetch && fetch.site !== "same-origin") {
		if (!isSafeTopLevelNavigation(context, metadata.method, origin, fetch)) {
			return deny("cross-site-browser-request", context, host.serialized, origin?.serialized);
		}
	}
	if (fetch && !origin) {
		if (isSafeTopLevelNavigation(context, metadata.method, undefined, fetch)) {
			return allow(policy, context, host, matchingOrigins, undefined, metadata.isTls);
		}
		if (context === "websocket") {
			return deny("origin-required", context, host.serialized);
		}
		if (!isCoherentOriginlessSubresource(context, fetch)) {
			return deny("cross-site-browser-request", context, host.serialized);
		}
	}
	if ((context === "ui-document" || context === "preview-document") && fetch?.mode === "navigate" && !SAFE_METHODS.has(normalizeMethod(metadata.method))) {
		return deny("unsafe-navigation-method", context, host.serialized, origin?.serialized);
	}

	return allow(policy, context, host, matchingOrigins, origin, metadata.isTls, origin ? simpleCors(origin) : undefined);
}

interface FetchMetadata {
	site: string;
	mode: string;
	dest?: string;
	user?: "?1";
}

type RawHeaderResult = { kind: "missing" } | { kind: "duplicate" } | { kind: "value"; value: string };

function admitPreflight(
	policy: RequestAdmissionPolicy,
	metadata: RequestAdmissionMetadata,
	context: RequestRouteContext,
	host: ParsedHost,
	matchingOrigins: readonly ParsedOrigin[],
	origin: ParsedOrigin | undefined,
	fetch: FetchMetadata | undefined,
	methodHeader: RawHeaderResult,
	headersHeader: RawHeaderResult,
	privateNetworkHeader: RawHeaderResult,
): RequestAdmissionDecision {
	if (normalizeMethod(metadata.method) !== "OPTIONS" || methodHeader.kind !== "value" || !origin) {
		return deny("invalid-preflight", context, host.serialized, origin?.serialized);
	}
	if (privateNetworkHeader.kind === "value") {
		return deny(privateNetworkHeader.value.toLowerCase() === "true" ? "private-network-denied" : "invalid-preflight", context, host.serialized, origin.serialized);
	}
	if (classifyOrigin(policy, matchingOrigins, origin) === "mismatch") {
		return deny("origin-mismatch", context, host.serialized, origin.serialized);
	}
	if (fetch && !isCoherentFetchContext("preflight", fetch)) return deny("invalid-fetch-metadata", context, host.serialized, origin.serialized);
	if (fetch && fetch.site !== "same-origin") return deny("cross-site-browser-request", context, host.serialized, origin.serialized);
	if (!isExactToken(methodHeader.value)) return deny("invalid-preflight", context, host.serialized, origin.serialized);
	const requestedMethod = methodHeader.value.toUpperCase();
	if (!policy._compiled.corsMethods.includes(requestedMethod)) {
		return deny("preflight-method-denied", context, host.serialized, origin.serialized);
	}
	const requestedHeaders = headersHeader.kind === "value" ? parseRequestedHeaders(headersHeader.value) : [];
	if (!requestedHeaders) return deny("invalid-preflight", context, host.serialized, origin.serialized);
	const projectedHeaders: string[] = [];
	for (const header of requestedHeaders) {
		const configured = policy._compiled.corsHeaders[header.toLowerCase()];
		if (!configured) return deny("preflight-header-denied", context, host.serialized, origin.serialized);
		projectedHeaders.push(configured);
	}
	return allow(policy, "preflight", host, matchingOrigins, origin, metadata.isTls, {
		...simpleCors(origin),
		allowMethod: requestedMethod,
		allowHeaders: Object.freeze(projectedHeaders),
		maxAgeSeconds: policy._compiled.corsMaxAgeSeconds,
	});
}

function classifyOrigin(
	policy: RequestAdmissionPolicy,
	matchingOrigins: readonly ParsedOrigin[],
	origin: ParsedOrigin | undefined,
): "absent" | "same-origin" | "vite" | "mismatch" {
	if (!origin) return "absent";
	if (matchingOrigins.some((candidate) => candidate.serialized === origin.serialized)) return "same-origin";
	if (policy._compiled.vitePairs.some((pair) =>
		pair.origin.serialized === origin.serialized
		&& matchingOrigins.some((candidate) => candidate.serialized === pair.gateway.serialized)
	)) return "vite";
	return "mismatch";
}

function isSafeTopLevelNavigation(
	context: RequestRouteContext,
	method: string | undefined,
	origin: ParsedOrigin | undefined,
	fetch: FetchMetadata,
): boolean {
	return !origin
		&& (context === "ui-document" || context === "preview-document")
		&& SAFE_METHODS.has(normalizeMethod(method))
		&& fetch.mode === "navigate"
		&& (fetch.dest === "document" || (fetch.dest === "empty" && fetch.site !== "same-origin"));
}

function isCoherentOriginlessSubresource(context: RequestRouteContext, fetch: FetchMetadata): boolean {
	if (fetch.site !== "same-origin") return false;
	return context !== "websocket" && context !== "preflight" && isCoherentFetchContext(context, fetch);
}

function isCoherentFetchContext(context: RequestRouteContext, fetch: FetchMetadata): boolean {
	if (context === "websocket") return fetch.mode === "websocket" && (fetch.dest === undefined || fetch.dest === "empty");
	if (context === "preflight") return fetch.mode === "cors" && (fetch.dest === undefined || fetch.dest === "empty");
	if (context === "api") return (fetch.dest === undefined || fetch.dest === "empty") && (fetch.mode === "cors" || fetch.mode === "same-origin");
	if (context === "preview-iframe") return fetch.mode === "navigate" && fetch.dest === "iframe";
	if (context === "ui-document" || context === "preview-document") {
		return fetch.mode === "navigate"
			&& (fetch.dest === "document" || (fetch.dest === "empty" && fetch.site !== "same-origin"));
	}
	// Chromium can emit navigate/empty for same-origin iframe loads. Keep these
	// in the non-top-level resource context so they never inherit the cross-site
	// document-navigation exception.
	if (fetch.mode === "navigate") return fetch.dest === "empty";
	return fetch.mode !== "nested-navigate" && fetch.mode !== "websocket";
}

function simpleCors(origin: ParsedOrigin): CorsProjection {
	return Object.freeze({
		allowOrigin: origin.serialized,
		varyOrigin: true,
		// Gateway browser transports authenticate with bearer tokens. Do not
		// advertise ambient credential access across the configured Vite origin.
		allowCredentials: false,
	});
}

function allow(
	policy: RequestAdmissionPolicy,
	context: RequestRouteContext,
	host: ParsedHost,
	matchingOrigins: readonly ParsedOrigin[],
	origin: ParsedOrigin | undefined,
	isTls: boolean,
	cors?: CorsProjection,
): RequestAdmissionAllowed {
	const gatewayOrigin = selectGatewayOrigin(policy, matchingOrigins, origin, isTls);
	return {
		allowed: true,
		reason: "allowed",
		context,
		normalizedHost: host.serialized,
		...(origin ? { normalizedOrigin: origin.serialized } : {}),
		...(gatewayOrigin ? { gatewayOrigin } : {}),
		trustedLocal: policy.allAuthoritiesLoopback,
		...(cors ? { cors } : {}),
	};
}

function selectGatewayOrigin(
	policy: RequestAdmissionPolicy,
	matchingOrigins: readonly ParsedOrigin[],
	browserOrigin: ParsedOrigin | undefined,
	isTls: boolean,
): string | undefined {
	if (browserOrigin && matchingOrigins.some((candidate) => candidate.serialized === browserOrigin.serialized)) {
		return browserOrigin.serialized;
	}

	if (browserOrigin) {
		const pairedGateways = policy._compiled.vitePairs
			.filter((pair) => pair.origin.serialized === browserOrigin.serialized
				&& matchingOrigins.some((candidate) => candidate.serialized === pair.gateway.serialized))
			.map((pair) => pair.gateway.serialized);
		return uniqueValue(pairedGateways);
	}

	// An omitted Host port can match both HTTP and HTTPS defaults. The physical
	// socket scheme must not resolve that configured browser-origin ambiguity.
	const compiledOrigin = uniqueValue(matchingOrigins.map((candidate) => candidate.serialized));
	if (!compiledOrigin) return undefined;

	const physicalProtocol = isTls ? "https:" : "http:";
	return uniqueValue(matchingOrigins
		.filter((candidate) => candidate.protocol === physicalProtocol)
		.map((candidate) => candidate.serialized)) ?? compiledOrigin;
}

function uniqueValue(values: readonly string[]): string | undefined {
	const unique = new Set(values);
	return unique.size === 1 ? unique.values().next().value : undefined;
}

function deny(
	reason: Exclude<RequestAdmissionReason, "allowed">,
	context: RequestRouteContext,
	normalizedHost?: string,
	normalizedOrigin?: string,
): RequestAdmissionDenied {
	return {
		allowed: false,
		reason,
		context,
		...(normalizedHost ? { normalizedHost } : {}),
		...(normalizedOrigin ? { normalizedOrigin } : {}),
	};
}

function classifyContext(basePath: string, metadata: RequestAdmissionMetadata, fetch: FetchMetadata | undefined): RequestRouteContext {
	if ((metadata.transport ?? "http") === "websocket") return "websocket";
	const requestMethod = normalizeMethod(metadata.method);
	const hasPreflightMethod = countRawHeader(metadata.rawHeaders, "access-control-request-method") > 0;
	if (requestMethod === "OPTIONS" && hasPreflightMethod) return "preflight";
	const pathname = parseRequestPathname(metadata.url);
	if (pathname === undefined) return "ui-static";
	const path = stripBasePath(pathname, basePath);
	if (path === "/api" || path.startsWith("/api/")) return "api";
	const isTopLevelDocument = fetch?.dest === "document"
		|| (fetch?.mode === "navigate" && fetch.dest === "empty" && fetch.site !== "same-origin");
	if (path === "/preview" || path.startsWith("/preview/")) {
		if (isTopLevelDocument) return "preview-document";
		if (fetch?.dest === "iframe") return "preview-iframe";
		return "preview-resource";
	}
	if (isTopLevelDocument) return "ui-document";
	return "ui-static";
}

function parseRequestPathname(raw: string | undefined): string | undefined {
	const value = raw ?? "/";
	if (!value.startsWith("/") || value.startsWith("//") || value.includes("#") || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
	try {
		return new URL(value, "http://request-admission.invalid").pathname;
	} catch {
		return undefined;
	}
}

function stripBasePath(pathname: string, basePath: string): string {
	if (!basePath) return pathname;
	if (pathname === basePath) return "/";
	return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
}

function normalizeBasePath(raw: string | undefined): string {
	if (raw === undefined || raw === "" || raw === "/") return "";
	if (raw !== raw.trim() || !raw.startsWith("/") || raw.includes("?") || raw.includes("#") || raw.includes("\\") || raw.includes("//")) {
		throw new RequestAdmissionConfigError("invalid-base-path");
	}
	const normalized = raw.endsWith("/") ? raw.slice(0, -1) : raw;
	if (normalized.split("/").some((segment) => segment === "." || segment === "..")) {
		throw new RequestAdmissionConfigError("invalid-base-path");
	}
	return normalized;
}

function readRawHeader(rawHeaders: readonly string[], wantedName: string): RawHeaderResult {
	let value: string | undefined;
	let count = 0;
	for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
		if (rawHeaders[index]!.toLowerCase() !== wantedName) continue;
		count++;
		value = rawHeaders[index + 1];
	}
	if (count === 0) return { kind: "missing" };
	if (count !== 1 || value === undefined) return { kind: "duplicate" };
	return { kind: "value", value };
}

function countRawHeader(rawHeaders: readonly string[], wantedName: string): number {
	let count = 0;
	for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
		if (rawHeaders[index]!.toLowerCase() === wantedName) count++;
	}
	return count;
}

function parseFetchMetadata(values: Partial<Record<(typeof FETCH_HEADER_NAMES)[number], string>>): FetchMetadata | undefined {
	const site = parseHeaderToken(values["sec-fetch-site"]);
	const mode = parseHeaderToken(values["sec-fetch-mode"]);
	const rawDest = values["sec-fetch-dest"];
	const dest = rawDest === undefined ? undefined : parseHeaderToken(rawDest);
	const rawUser = values["sec-fetch-user"];
	if (!site || !mode || !VALID_FETCH_SITES.has(site) || !VALID_FETCH_MODES.has(mode)
		|| (rawDest !== undefined && (!dest || !VALID_FETCH_DESTINATIONS.has(dest)))
		|| (rawUser !== undefined && rawUser !== "?1")) return undefined;
	return { site, mode, ...(dest ? { dest } : {}), ...(rawUser ? { user: rawUser } : {}) };
}

function parseHeaderToken(value: string | undefined): string | undefined {
	if (!value || value !== value.trim() || value.includes(",") || !TOKEN.test(value)) return undefined;
	return value.toLowerCase();
}

function compileMethods(values: readonly string[]): ReadonlySet<string> {
	const methods = new Set<string>();
	for (const value of values) {
		if (!isExactToken(value)) throw new RequestAdmissionConfigError("invalid-cors-method");
		methods.add(value.toUpperCase());
	}
	return methods;
}

function compileHeaders(values: readonly string[]): ReadonlyMap<string, string> {
	const headers = new Map<string, string>();
	for (const value of values) {
		if (!isExactToken(value)) throw new RequestAdmissionConfigError("invalid-cors-header");
		headers.set(value.toLowerCase(), value);
	}
	return headers;
}

function parseRequestedHeaders(value: string): string[] | undefined {
	if (value !== value.trim() || value.length === 0) return undefined;
	const headers = value.split(",").map((part) => part.trim());
	if (headers.some((header) => !TOKEN.test(header))) return undefined;
	if (new Set(headers.map((header) => header.toLowerCase())).size !== headers.length) return undefined;
	return headers;
}

function isExactToken(value: string): boolean {
	return value === value.trim() && TOKEN.test(value) && !value.includes(",");
}

function normalizeMethod(method: string | undefined): string {
	return (method ?? "GET").toUpperCase();
}

function parseRequestHost(raw: string): ParsedHost | undefined {
	if (!isCleanScalar(raw)) return undefined;
	let hostnameRaw: string;
	let portRaw: string | undefined;
	if (raw.startsWith("[")) {
		const closing = raw.indexOf("]");
		if (closing < 0) return undefined;
		hostnameRaw = raw.slice(1, closing);
		const remainder = raw.slice(closing + 1);
		if (remainder) {
			if (!remainder.startsWith(":")) return undefined;
			portRaw = remainder.slice(1);
		}
	} else {
		const firstColon = raw.indexOf(":");
		if (firstColon !== raw.lastIndexOf(":")) return undefined;
		if (firstColon >= 0) {
			hostnameRaw = raw.slice(0, firstColon);
			portRaw = raw.slice(firstColon + 1);
		} else {
			hostnameRaw = raw;
		}
	}
	const hostname = parseHostname(hostnameRaw);
	if (!hostname || (hostname.includes(":") !== raw.startsWith("["))) return undefined;
	const explicitPort = portRaw === undefined ? undefined : parsePort(portRaw);
	if (portRaw !== undefined && explicitPort === undefined) return undefined;
	return {
		hostname,
		explicitPort,
		serialized: serializeAuthority(hostname, explicitPort),
	};
}

function parseSerializedOrigin(raw: string): ParsedOrigin | undefined {
	if (raw.length === 0 || raw !== raw.trim() || /[\u0000-\u0020\u007f,\\]/.test(raw) || !/^https?:\/\/[^/?#\\]+$/i.test(raw)) return undefined;
	try {
		const parsed = new URL(raw);
		if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return undefined;
		const hostname = parseHostname(stripIpv6Brackets(parsed.hostname));
		if (!hostname) return undefined;
		const port = parsed.port ? parsePort(parsed.port) : defaultPort(parsed.protocol);
		if (!port) return undefined;
		return originFromParts(parsed.protocol, hostname, port);
	} catch {
		return undefined;
	}
}

function parseConfiguredOrigin(raw: string, reason: RequestAdmissionConfigReason): ParsedOrigin {
	if (raw !== raw.trim() || /[\u0000-\u001f\u007f,\\]/.test(raw)) throw new RequestAdmissionConfigError(reason);
	try {
		const parsed = new URL(raw);
		if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || !parsed.hostname || (parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash) {
			throw new RequestAdmissionConfigError(reason);
		}
		const hostname = parseHostname(stripIpv6Brackets(parsed.hostname));
		const port = parsed.port ? parsePort(parsed.port) : defaultPort(parsed.protocol);
		if (!hostname || !port || isWildcardListener(hostname)) throw new RequestAdmissionConfigError(reason);
		return originFromParts(parsed.protocol, hostname, port);
	} catch (error) {
		if (error instanceof RequestAdmissionConfigError) throw error;
		throw new RequestAdmissionConfigError(reason);
	}
}

function originFromParts(protocol: "http:" | "https:", hostname: string, port: number): ParsedOrigin {
	const defaulted = port === defaultPort(protocol);
	const authority = serializeAuthority(hostname, defaulted ? undefined : port);
	return {
		serialized: `${protocol.slice(0, -1)}://${authority}`,
		protocol,
		hostname,
		port,
		authorityKey: `${hostname}|${port}`,
	};
}

function hostMatchesOrigin(host: ParsedHost, origin: ParsedOrigin): boolean {
	return host.hostname === origin.hostname
		&& (host.explicitPort === undefined ? origin.port === defaultPort(origin.protocol) : host.explicitPort === origin.port);
}

function parseConfiguredHostname(raw: string): string | undefined {
	if (typeof raw !== "string" || raw !== raw.trim() || !raw || /[\s,/?#\\@]/.test(raw)) return undefined;
	const unwrapped = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
	if ((raw.startsWith("[") || raw.endsWith("]")) && unwrapped === raw) return undefined;
	return parseHostname(unwrapped);
}

function parseHostname(raw: string): string | undefined {
	if (!raw || raw !== raw.trim() || raw.includes("%")) return undefined;
	if (raw.includes(":")) return parseIpv6(raw);
	let value = raw.toLowerCase();
	if (value.endsWith(".")) value = value.slice(0, -1);
	if (!value || value.endsWith(".") || value.length > 253) return undefined;
	if (/^[0-9.]+$/.test(value)) return parseIpv4(value);
	const labels = value.split(".");
	if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return undefined;
	return value;
}

function parseIpv4(raw: string): string | undefined {
	const parts = raw.split(".");
	if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return undefined;
	return parts.map((part) => String(Number(part))).join(".");
}

function parseIpv6(raw: string): string | undefined {
	if (!/^[0-9a-f:.]+$/i.test(raw)) return undefined;
	try {
		const hostname = stripIpv6Brackets(new URL(`http://[${raw}]`).hostname).toLowerCase();
		return hostname.includes(":") ? hostname : undefined;
	} catch {
		return undefined;
	}
}

function stripIpv6Brackets(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function parsePort(raw: string): number | undefined {
	if (!/^\d{1,5}$/.test(raw)) return undefined;
	const port = Number(raw);
	return port >= 1 && port <= 65_535 ? port : undefined;
}

function serializeAuthority(hostname: string, port?: number): string {
	const host = hostname.includes(":") ? `[${hostname}]` : hostname;
	return port === undefined ? host : `${host}:${port}`;
}

function defaultPort(protocol: string): number {
	return protocol === "https:" ? 443 : 80;
}

function isWildcardListener(hostname: string): boolean {
	return hostname === "0.0.0.0" || hostname === "::";
}

function isLoopbackHostname(hostname: string): boolean {
	return (LOOPBACK_HOSTS as readonly string[]).includes(hostname);
}

function isCleanScalar(raw: string): boolean {
	return raw.length > 0
		&& raw === raw.trim()
		&& !/[\u0000-\u0020\u007f,/?#\\@]/.test(raw);
}
