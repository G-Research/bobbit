/**
 * CORS contract for every HTTP method dispatched by the `/api/` router.
 *
 * Keep this list in sync with route predicates. The integration test inventories
 * those predicates so a newly routed method cannot be omitted from preflight.
 */
export const API_CORS_ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

export const API_CORS_ALLOWED_HEADERS = [
	"Authorization",
	"Content-Type",
	"If-Match",
	"X-Bobbit-Session-Id",
	"X-Bobbit-Spawning-Session",
	"X-Bobbit-Session-Secret",
] as const;

// Keep policy changes responsive while avoiding a preflight for every mutation.
export const API_CORS_PREFLIGHT_MAX_AGE_SECONDS = 600;

/** Minimum response headers projected by an approved admission decision. */
export interface ApprovedCorsHeaders {
	allowOrigin: string;
	varyOrigin: boolean;
	allowCredentials: boolean;
	allowMethod?: string;
	allowHeaders?: readonly string[];
	maxAgeSeconds?: number;
}

interface CorsHeaderWriter {
	getHeader(name: string): number | string | string[] | undefined;
	setHeader(name: string, value: number | string | readonly string[]): unknown;
}

/**
 * Apply only the CORS capabilities approved by request admission. Rejected
 * requests never call this function, and private-network permission is never
 * emitted implicitly.
 */
export function applyApprovedCorsHeaders(response: CorsHeaderWriter, cors: ApprovedCorsHeaders): void {
	response.setHeader("Access-Control-Allow-Origin", cors.allowOrigin);
	if (cors.varyOrigin) appendVaryOrigin(response);
	if (cors.allowCredentials) response.setHeader("Access-Control-Allow-Credentials", "true");
	if (cors.allowMethod) response.setHeader("Access-Control-Allow-Methods", cors.allowMethod);
	if (cors.allowHeaders?.length) response.setHeader("Access-Control-Allow-Headers", cors.allowHeaders.join(", "));
	if (cors.maxAgeSeconds !== undefined) response.setHeader("Access-Control-Max-Age", cors.maxAgeSeconds);
}

function appendVaryOrigin(response: CorsHeaderWriter): void {
	const current = response.getHeader("Vary");
	const values = Array.isArray(current)
		? current.flatMap((value) => String(value).split(","))
		: current === undefined
			? []
			: String(current).split(",");
	if (values.some((value) => value.trim().toLowerCase() === "origin")) return;
	response.setHeader("Vary", [...values.map((value) => value.trim()).filter(Boolean), "Origin"].join(", "));
}
