/**
 * Runtime URL-prefix helpers shared by the gateway and browser bundle.
 *
 * Keep this module dependency-free. A base path is deployment configuration;
 * internal gateway routes deliberately remain root-absolute and mount-relative.
 */

export class InvalidBasePathError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidBasePathError";
	}
}

declare const gatewayRouteBrand: unique symbol;
declare const publicGatewayPathBrand: unique symbol;

/** An internal, mount-relative gateway route such as `/api/health`. */
export type GatewayRoute = string & { readonly [gatewayRouteBrand]: true };
/** An origin-relative gateway path which already includes the deployment mount. */
export type PublicGatewayPath = string & { readonly [publicGatewayPathBrand]: true };

const BASE_SEGMENT_RE = /^[A-Za-z0-9._~-]+$/;
const PREVIEW_SESSION_RE = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const PREVIEW_ARTIFACT_RE = /^[A-Za-z0-9_-]{6,64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const WHITESPACE_RE = /\s/;

function invalid(raw: string, reason: string): never {
	throw new InvalidBasePathError(`Invalid base path ${JSON.stringify(raw)}: ${reason}`);
}

/** `""` for root, otherwise `/segment[/segment...]` with no trailing slash. */
export function normalizeBasePath(raw: string | null | undefined): string {
	if (raw === undefined || raw === null) return "";
	const original = String(raw);
	let value = original.trim();
	if (value === "" || value === "/") return "";

	// Reject ambiguous URL syntax before applying the two documented convenience
	// normalizations (one leading slash and removal of trailing slashes).
	if (CONTROL_RE.test(value)) invalid(original, "control characters are not allowed");
	if (WHITESPACE_RE.test(value)) invalid(original, "embedded whitespace is not allowed");
	if (value.includes("\\")) invalid(original, "backslashes are not allowed");
	if (value.includes("%")) invalid(original, "percent escapes are not allowed");
	if (value.includes("?") || value.includes("#")) invalid(original, "query strings and fragments are not allowed");
	if (value.startsWith("//")) invalid(original, "URL authorities are not allowed");
	if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) invalid(original, "URL schemes are not allowed");

	if (!value.startsWith("/")) value = `/${value}`;
	value = value.replace(/\/+$/, "");
	if (value === "") return "";

	const segments = value.slice(1).split("/");
	for (const segment of segments) {
		if (!segment) invalid(original, "duplicate path separators are not allowed");
		if (segment === "." || segment === "..") invalid(original, "dot segments are not allowed");
		if (!BASE_SEGMENT_RE.test(segment)) invalid(original, "path segments must contain only URL-unreserved characters");
	}
	return value;
}

/** Validate and brand an internal root-absolute route. Query/hash text is retained. */
export function gatewayRoute(raw: string): GatewayRoute {
	if (typeof raw !== "string" || raw.length === 0 || !raw.startsWith("/") || raw.startsWith("//")) {
		throw new InvalidBasePathError("Gateway routes must be root-absolute and must not be protocol-relative");
	}
	if (CONTROL_RE.test(raw) || raw.includes("\\")) {
		throw new InvalidBasePathError("Gateway routes must not contain control characters or backslashes");
	}
	return raw as GatewayRoute;
}

/**
 * Validate preview data received across JSON/SSE/storage boundaries and brand
 * its mount-relative route. Public/mounted URLs are deliberately rejected.
 */
export function previewGatewayRoute(raw: unknown): GatewayRoute {
	if (typeof raw !== "string") {
		throw new InvalidBasePathError("Invalid preview route: expected a string");
	}
	const match = /^\/preview\/([^/?#]+)\/(.+)$/u.exec(raw);
	if (!match || !PREVIEW_SESSION_RE.test(match[1])) {
		throw new InvalidBasePathError(`Invalid preview route ${JSON.stringify(raw)}`);
	}

	const tail = match[2];
	const pathEnd = tail.search(/[?#]/);
	const rawPath = pathEnd < 0 ? tail : tail.slice(0, pathEnd);
	if (!rawPath || rawPath.includes("\\") || rawPath.includes("//")) {
		throw new InvalidBasePathError(`Invalid preview path ${JSON.stringify(raw)}`);
	}
	const segments = rawPath.split("/");
	for (const segment of segments) {
		if (!segment) throw new InvalidBasePathError(`Invalid preview path ${JSON.stringify(raw)}`);
		let decoded: string;
		try {
			decoded = decodeURIComponent(segment);
		} catch {
			throw new InvalidBasePathError(`Invalid preview path ${JSON.stringify(raw)}`);
		}
		if (!decoded || decoded === "." || decoded === ".." || /[\\/\u0000-\u001f\u007f]/u.test(decoded)) {
			throw new InvalidBasePathError(`Invalid preview path ${JSON.stringify(raw)}`);
		}
	}
	if (segments[0] === "_artifact" && (segments.length < 3 || !PREVIEW_ARTIFACT_RE.test(segments[1]))) {
		throw new InvalidBasePathError(`Invalid preview artifact route ${JSON.stringify(raw)}`);
	}
	return gatewayRoute(raw);
}

/** Identity in root mode; `null` means the pathname is outside the exact mount. */
export function stripBasePath(pathname: string, basePath: string): string | null {
	const base = normalizeBasePath(basePath);
	if (base === "") return pathname;
	if (pathname === base) return "/";
	if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length);
	return null;
}

/** Join one opaque internal route to the deployment mount exactly once. */
export function withBasePath(route: GatewayRoute, basePath: string): PublicGatewayPath {
	const base = normalizeBasePath(basePath);
	return `${base}${route}` as PublicGatewayPath;
}
