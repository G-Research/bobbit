// Shared helper for the Research Pack fixture tool. Verifies _shared/ is copied.
export function normalizeUrl(url: string): string {
	return url.trim().replace(/\/+$/, "");
}
