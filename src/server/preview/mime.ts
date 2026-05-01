/**
 * Minimal MIME-type lookup for preview asset endpoint.
 *
 * Avoids adding the `mime-types` dependency for a feature whose surface area
 * is "render an HTML report with sibling images / GIFs / fonts / styles".
 * Unknown extensions fall back to `application/octet-stream` — browsers will
 * sniff or download.
 */

const TABLE: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
};

/** Return the MIME type for an absolute or relative file path. */
export function mimeTypeFor(filePath: string): string {
	const dot = filePath.lastIndexOf(".");
	if (dot < 0) return "application/octet-stream";
	const ext = filePath.slice(dot).toLowerCase();
	return TABLE[ext] ?? "application/octet-stream";
}
