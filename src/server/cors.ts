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
