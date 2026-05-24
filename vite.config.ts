import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

/** Find the NordLynx (NordVPN mesh) interface IPv4 address. */
function findNordLynxIp(): string | null {
	const interfaces = os.networkInterfaces();
	for (const [name, addrs] of Object.entries(interfaces)) {
		if (!addrs) continue;
		if (!name.toLowerCase().includes("nordlynx")) continue;
		for (const addr of addrs) {
			if (addr.family === "IPv4" && !addr.internal) {
				return addr.address;
			}
		}
	}
	return null;
}

/**
 * Determine the host Vite should bind to and proxy against.
 *
 * - VITE_HOST env var: explicit override
 * - BOBBIT_NORD=1: use NordLynx mesh IP (set by dev:nord script)
 * - Default: localhost
 */
const nordMode = process.env.BOBBIT_NORD === "1";
const host = process.env.VITE_HOST || (nordMode ? findNordLynxIp() || "localhost" : "localhost");
const proto = host === "localhost" ? "http" : "https";

/**
 * Read the gateway URL from .bobbit/state/gateway-url. Called on every
 * proxied request so port changes (e.g. 3001→3002) are picked up
 * without restarting Vite.
 */
function readGatewayUrl(): string {
	if (process.env.GATEWAY_URL) return process.env.GATEWAY_URL;
	const gwFile = path.join(process.cwd(), ".bobbit", "state", "gateway-url");
	try {
		if (fs.existsSync(gwFile)) return fs.readFileSync(gwFile, "utf-8").trim();
	} catch {}
	return `${proto}://${host}:3001`;  // fallback before first startup
}

// Load TLS cert for vite's own HTTPS server + proxy trust
const tlsDir = path.join(process.cwd(), ".bobbit", "state", "tls");
const certPath = path.join(tlsDir, "cert.pem");
const keyPath = path.join(tlsDir, "key.pem");
const tlsAvailable = proto === "https" && fs.existsSync(certPath) && fs.existsSync(keyPath);

/**
 * Vite plugin that proxies /api and /ws to the gateway, re-reading the
 * gateway URL from disk on every request.  This avoids the stale-target
 * problem that occurs when the gateway port changes after Vite starts.
 */
// HTTP/2 pseudo-headers and HTTP/1.1 connection headers that are
// invalid across protocol boundaries (RFC 9113 §8.2.2, §8.3).
const H2_PSEUDO = (k: string) => k.startsWith(":");
const H1_CONNECTION = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection"]);

/** Copy headers, stripping HTTP/2 pseudo-headers. */
function stripH2Request(raw: http.IncomingHttpHeaders, targetHost: string): Record<string, string | string[] | undefined> {
	const out: Record<string, string | string[] | undefined> = {};
	for (const [k, v] of Object.entries(raw)) {
		if (!H2_PSEUDO(k)) out[k] = v;
	}
	out.host = targetHost;
	return out;
}

/** Copy headers, stripping HTTP/1.1 connection headers forbidden in HTTP/2. */
function stripH1Response(raw: http.IncomingHttpHeaders): Record<string, string | string[] | undefined> {
	const out: Record<string, string | string[] | undefined> = {};
	for (const [k, v] of Object.entries(raw)) {
		if (!H1_CONNECTION.has(k.toLowerCase())) out[k] = v;
	}
	return out;
}

/**
 * Defense-in-depth: Block import.meta.glob calls that reference .bobbit
 * paths or use excessive ../ traversal (3+ levels). Prevents sandbox agents
 * from writing .mjs files that trick Vite into resolving arbitrary paths
 * at transform time, bypassing server.fs.deny.
 */
function blockDangerousGlobs(): Plugin {
	return {
		name: "block-dangerous-globs",
		apply: "serve",
		transform(code, id) {
			if (!code.includes("import.meta.glob")) return null;
			const globPattern = /import\.meta\.glob\s*\(\s*['"`]([^'"`]+)['"`]/g;
			let match;
			while ((match = globPattern.exec(code)) !== null) {
				const pattern = match[1];
				if (pattern.includes(".bobbit") || (pattern.match(/\.\.\//g) || []).length >= 3) {
					console.warn(`[security] Blocked dangerous import.meta.glob pattern in ${id}: ${pattern}`);
					return { code: "export default {};", map: null };
				}
			}
			return null;
		},
	};
}

/**
 * Defense-in-depth: Reject requests from non-localhost IPs when Vite is
 * bound to localhost, and block Docker bridge subnet IPs in all modes.
 * Prevents sandbox containers from reaching the Vite dev server even if
 * network isolation fails.
 */
function localhostGuard(): Plugin {
	return {
		name: "localhost-guard",
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const addr = req.socket.remoteAddress || "";
				// Normalize: strip IPv6-mapped prefix, handle various loopback representations
				const rawIp = addr.replace(/^::ffff:/, "");
				const isLocalhost = rawIp === "127.0.0.1" || rawIp === "::1" || addr === "::1" || rawIp === "localhost";
				if (host === "localhost" && !isLocalhost) {
					console.warn(`[security] Blocked non-localhost request from ${addr}`);
					res.writeHead(403);
					res.end("Forbidden");
					return;
				}
				// In non-localhost mode (NordVPN mesh), block Docker bridge subnets (172.16.0.0/12)
				if (host !== "localhost" && !isLocalhost) {
					const raw = addr.replace("::ffff:", "");
					if (raw.startsWith("172.")) {
						const parts = raw.split(".");
						const second = parseInt(parts[1], 10);
						if (second >= 16 && second <= 31) {
							console.warn(`[security] Blocked Docker bridge request from ${addr}`);
							res.writeHead(403);
							res.end("Forbidden");
							return;
						}
					}
				}
				next();
			});
		},
	};
}

/**
 * Stamp `__BOBBIT_BUILD_ID__` in `public/sw.js` with a per-build identifier
 * so the service worker's CACHE_NAME changes on every deploy. Without this,
 * an in-flight client keeps the previous build's caches forever and a hard
 * refresh can't escape stale hashed assets after a gateway restart.
 *
 * Dev: stamps the file on every request with a fresh timestamp so reloading
 *      always activates a new SW (matches Vite's HMR mental model).
 * Build: stamps once with a content hash + timestamp into the emitted asset.
 */
function bobbitSwVersion(): Plugin {
	const BUILD_ID_PLACEHOLDER = "__BOBBIT_BUILD_ID__";
	// Comment marker (kept as a no-op comment in the unstamped source so
	// the SW file stays valid JS for tests that load it directly). At
	// build time we replace the entire `/*...*/` token with a
	// comma-separated list of quoted hashed paths for the most-likely
	// next route chunks. The marker sits inside an array literal in
	// `public/sw.js`, so emitting just the inner JSON-array contents
	// keeps the syntax valid.
	const PRECACHE_PLACEHOLDER = "/*__BOBBIT_PRECACHE_CHUNKS__*/";
	// Source files (relative to project root) whose Vite manifest entries
	// should be precached.  Keep this list short — extra precache costs
	// cold-install bandwidth on every deploy.
	const PRECACHE_SOURCES = [
		"src/app/goal-dashboard.ts",
		"src/app/settings-page.ts",
	];
	const stamp = (src: string, buildId: string, precacheJson: string): string =>
		src.split(BUILD_ID_PLACEHOLDER).join(buildId).split(PRECACHE_PLACEHOLDER).join(precacheJson);

	/**
	 * Read `dist/ui/.vite/manifest.json` and resolve precache URLs for
	 * `PRECACHE_SOURCES`.  Includes each entry's `file`, plus its
	 * `imports[]` (transitive, deduped) — without the imports a
	 * precached chunk would still trigger a cold network for its deps
	 * on first navigation. `css[]` is included so the route renders
	 * styled offline.  Returns absolute URL paths (`/assets/...`).
	 */
	function resolvePrecacheUrls(distDir: string): string[] {
		const manifestPath = path.join(distDir, ".vite", "manifest.json");
		if (!fs.existsSync(manifestPath)) return [];
		type ManifestEntry = { file: string; imports?: string[]; css?: string[] };
		let manifest: Record<string, ManifestEntry>;
		try {
			manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
		} catch {
			return [];
		}
		const urls = new Set<string>();
		const visit = (key: string) => {
			const entry = manifest[key];
			if (!entry) return;
			urls.add(`/${entry.file}`);
			for (const css of entry.css ?? []) urls.add(`/${css}`);
			for (const imp of entry.imports ?? []) visit(imp);
		};
		for (const src of PRECACHE_SOURCES) visit(src);
		return [...urls].sort();
	}

	return {
		name: "bobbit-sw-version",
		// Dev: intercept GET /sw.js and rewrite the placeholder per request.
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				if (req.method !== "GET" || (req.url || "").split("?")[0] !== "/sw.js") return next();
				const swPath = path.join(process.cwd(), "public", "sw.js");
				let src: string;
				try { src = fs.readFileSync(swPath, "utf-8"); } catch { return next(); }
				// Dev has no manifest — leave the marker as an empty list.
				const body = stamp(src, `dev-${Date.now()}`, "");
				res.writeHead(200, {
					"Content-Type": "application/javascript; charset=utf-8",
					// Service workers should not be cached themselves — browsers
					// already byte-compare on update, but explicit no-cache keeps
					// proxies and CDNs from holding onto an old copy.
					"Cache-Control": "no-cache, no-store, must-revalidate",
				});
				res.end(body);
			});
		},
		// Build: Vite copies `public/sw.js` verbatim into outDir during
		// `writeBundle`. Run after that copy and rewrite the placeholder
		// in-place. `closeBundle` is the last hook so the on-disk file is
		// guaranteed to exist by the time we get here.
		closeBundle: {
			order: "post",
			handler() {
				const distDir = path.join(process.cwd(), "dist", "ui");
				const outFile = path.join(distDir, "sw.js");
				if (!fs.existsSync(outFile)) return;
				let src: string;
				try { src = fs.readFileSync(outFile, "utf-8"); } catch { return; }
				if (!src.includes(BUILD_ID_PLACEHOLDER) && !src.includes(PRECACHE_PLACEHOLDER)) return;
				const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
				const precacheUrls = resolvePrecacheUrls(distDir);
				// Emit just the inner contents of the array literal — the
				// surrounding `[ ... ]` already exists in `public/sw.js`.
				const inner = precacheUrls.map((u) => JSON.stringify(u)).join(", ");
				fs.writeFileSync(outFile, stamp(src, id, inner));
			},
		},
	};
}

function dynamicGatewayProxy(): Plugin {
	return {
		name: "dynamic-gateway-proxy",
		configureServer(server) {
			// --- HTTP proxy for /api/* ----------------------------------
			server.middlewares.use((req, res, next) => {
				// Proxy /api/*, /manifest.json (gateway serves a dynamic manifest
				// that bakes the auth token into start_url for PWA installs), and
				// /preview/* (per-session HTML preview mounts served by the gateway
				// — without this, Vite's SPA fallback returns index.html and the
				// iframe ends up rendering a nested Bobbit app).
				const u = req.url || "";
				const isManifest = u === "/manifest.json" || u.startsWith("/manifest.json?");
				const isPreview = u.startsWith("/preview/");
				if (!u.startsWith("/api") && !isManifest && !isPreview) return next();
				const target = new URL(readGatewayUrl());
				const opts: http.RequestOptions = {
					hostname: target.hostname,
					port: target.port,
					path: req.url,
					method: req.method,
					headers: stripH2Request(req.headers, target.host),
					rejectUnauthorized: false,
				};
				const mod = target.protocol === "https:" ? https : http;
				const proxyReq = mod.request(opts, (proxyRes: http.IncomingMessage) => {
					res.writeHead(proxyRes.statusCode ?? 502, stripH1Response(proxyRes.headers));
					proxyRes.pipe(res, { end: true });
				});
				proxyReq.on("error", (err: Error) => {
					console.warn(`[api proxy] ${err.message} — gateway likely restarting`);
					if (!res.headersSent) {
						res.writeHead(502, { "Content-Type": "text/plain" });
						res.end("Gateway restarting");
					}
				});
				req.pipe(proxyReq, { end: true });
			});

			// --- WebSocket proxy for /ws/* ------------------------------
			server.httpServer?.on("upgrade", (req, socket: import("node:net").Socket, head) => {
				if (!req.url?.startsWith("/ws")) return;
				const target = new URL(readGatewayUrl());
				const mod = target.protocol === "https:" ? https : http;
				const proxyReq = mod.request({
					hostname: target.hostname,
					port: target.port,
					path: req.url,
					method: req.method,
					headers: stripH2Request(req.headers, target.host),
					rejectUnauthorized: false,
				});
				proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
					// Forward the 101 Switching Protocols response to the client
					let rawResponse = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
					for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
						rawResponse += `${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}\r\n`;
					}
					rawResponse += "\r\n";
					socket.write(rawResponse);
					if (proxyHead.length) socket.write(proxyHead);
					proxySocket.pipe(socket);
					socket.pipe(proxySocket);
					proxySocket.on("error", () => socket.destroy());
					socket.on("error", () => proxySocket.destroy());
				});
				proxyReq.on("error", (err) => {
					console.warn(`[ws proxy] ${err.message} — gateway likely restarting`);
					socket.destroy();
				});
				if (head.length) proxyReq.write(head);
				proxyReq.end();
			});
		},
	};
}

export default defineConfig(({ mode }) => ({
	plugins: [tailwindcss(), blockDangerousGlobs(), localhostGuard(), bobbitSwVersion(), dynamicGatewayProxy()],
	// Expose a dev-mode boolean via globalThis so code that needs to gate
	// dev-only behaviour can read `(globalThis as any).__BOBBIT_DEV__` without
	// touching `import.meta.env` — important for test fixtures that bundle
	// via esbuild iife (which doesn't support `import.meta`).
	define: {
		"globalThis.__BOBBIT_DEV__": JSON.stringify(mode !== "production"),
	},
	build: {
		outDir: "dist/ui",
		// Emit modern JS — the supported browser matrix (iOS 17+, modern Chrome/Edge/Firefox)
		// handles esnext output natively, so we skip transpiler helpers (-1–3% main chunk).
		target: "esnext",
		// `modulepreload` polyfill is unused on supported browsers; saves ~2 kB.
		modulePreload: { polyfill: false },
		// Tighten the chunk-size warning so bundle regressions are flagged early.
		// `cssCodeSplit` defaults to true (per-chunk CSS) and is intentionally not overridden.
		chunkSizeWarningLimit: 600,
		// Emit `dist/ui/.vite/manifest.json` so the SW plugin can resolve hashed
		// paths for route-chunk precache (see `bobbitSwVersion`).
		manifest: true,
		rollupOptions: {
			output: {
				/**
				 * Pin large, slow-changing vendor deps into their own chunks so
				 * (a) the entry chunk stays small and (b) returning users keep
				 * cached vendor bundles across deploys when only app code
				 * changes. Order matters: more specific paths first.
				 *
				 * Anything not matched here falls through to Vite's default
				 * dependency-graph chunking (lazy provider chunks, dynamic
				 * imports for pi-ai/qrcode/jszip/highlight.js, etc.).
				 */
				manualChunks: (id) => {
					if (!id.includes("node_modules")) return;
					if (id.includes("/@sinclair/typebox/")) return "vendor-typebox";
					if (id.includes("/marked")) return "vendor-marked";
					if (id.includes("/@mariozechner/mini-lit/")) return "vendor-mini-lit";
					if (id.includes("/lucide")) return "vendor-lucide";
					if (id.includes("/sortablejs/")) return "vendor-sortable";
					if (id.includes("/@recogito/") || id.includes("/@annotorious/") || id.includes("/rbush")) return "vendor-annotator";
					if (id.includes("/lit-html/") || id.includes("/lit-element/") || id.includes("/@lit/") || /\/lit\//.test(id)) return "vendor-lit";
					return undefined;
				},
			},
		},
	},
	server: {
		host,
		watch: {
			// Keep Vite's watcher scoped to source files. Bobbit's runtime writes
			// heavily under these generated/state directories; watching them causes
			// idle chokidar churn and thousands of FSWatcher handles on Windows.
			ignored: [
				"**/.bobbit/**",
				"**/.bobbit-*/**",
				"**/.e2e-*/**",
				"**/.e2e-fullstack/**",
				"**/.playwright-mcp/**",
				"**/.bobbit-qa/**",
				"**/bobbit-wt/**",
				"**/*-wt/**",
				"**/dist/**",
				"**/coverage/**",
				"**/playwright-report/**",
				"**/test-results/**",
			],
		},
		fs: {
			deny: [".bobbit", "node_modules/.vite"],
		},
		// Serve vite dev server over HTTPS using the same self-signed cert
		...(tlsAvailable
			? {
				https: {
					cert: fs.readFileSync(certPath, "utf-8"),
					key: fs.readFileSync(keyPath, "utf-8"),
				},
			}
			: {}),
	},
}));
