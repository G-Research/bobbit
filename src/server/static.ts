/**
 * Static file serving + PWA manifest loading.
 * Extracted from server.ts (commit: split server.ts).
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export const MIME_TYPES: Record<string, string> = {
	".html": "text/html",
	".js": "application/javascript",
	".css": "text/css",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".wasm": "application/wasm",
};

/**
 * Load the PWA manifest JSON. In prod the UI is embedded under `staticDir`;
 * in dev mode (--no-ui) the Vite public/ folder is used instead.
 */
export function loadManifest(staticDir: string | undefined): { start_url?: string;[k: string]: unknown } {
	const candidates: string[] = [];
	if (staticDir) candidates.push(path.join(path.resolve(staticDir), "manifest.json"));
	candidates.push(path.resolve(process.cwd(), "public", "manifest.json"));
	for (const p of candidates) {
		if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
	}
	throw new Error("manifest.json not found");
}

export function serveStatic(pathname: string, staticDir: string, res: http.ServerResponse) {
	const resolvedStaticDir = path.resolve(staticDir);
	let filePath = path.resolve(staticDir, pathname === "/" ? "index.html" : pathname.slice(1));

	// Prevent directory traversal
	if (!filePath.startsWith(resolvedStaticDir)) {
		res.writeHead(403);
		res.end();
		return;
	}

	try {
		if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
			// SPA fallback — serve index.html for unmatched routes
			filePath = path.join(resolvedStaticDir, "index.html");
			if (!fs.existsSync(filePath)) {
				res.writeHead(404);
				res.end("Not found");
				return;
			}
		}

		const ext = path.extname(filePath).toLowerCase();
		const contentType = MIME_TYPES[ext] || "application/octet-stream";
		const content = fs.readFileSync(filePath);

		const headers: Record<string, string> = { "Content-Type": contentType };
		// Service-worker file: never cache. Browsers byte-compare SWs for
		// updates, but an intermediate proxy/CDN serving a stale copy would
		// silently keep users on the old build's CACHE_NAME. Same goes for
		// the SPA shell (index.html) — it references hashed bundle names
		// that change every build.
		const basename = path.basename(filePath);
		if (basename === "sw.js" || basename === "index.html") {
			headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
		}

		res.writeHead(200, headers);
		res.end(content);
	} catch {
		res.writeHead(500);
		res.end("Internal server error");
	}
}
