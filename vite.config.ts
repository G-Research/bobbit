import tailwindcss from "@tailwindcss/vite";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

/**
 * Mirror of the server's bobbit-dir.ts resolution so Vite finds the same
 * Headquarters state dir and OS-level secrets dir. Kept in sync manually;
 * pinned by tests/vite-config-paths.test.ts.
 */
function headquartersDir(): string {
	if (process.env.BOBBIT_DIR) return path.resolve(process.env.BOBBIT_DIR);
	if (process.env.BOBBIT_PI_DIR) return path.resolve(process.env.BOBBIT_PI_DIR);
	return path.join(process.cwd(), ".bobbit", "headquarters");
}
function headquartersStateDir(): string {
	return path.join(headquartersDir(), "state");
}

function normalizeDnsHostname(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const hostname = value.trim().toLowerCase().replace(/\.$/, "");
	if (!hostname || hostname.length > 253 || !hostname.includes(".")) return null;
	const labels = hostname.split(".");
	if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
	return hostname;
}

/**
 * Read only the public deSEC hostname from state. Vite validates HMR WebSocket
 * Host headers separately from normal HTTPS requests; without this allow-list
 * a DNS-mounted mobile client receives HTTP 400 and can remain on bundled
 * dev's "Bundling in progress" fallback forever.
 */
export function configuredPublicViteHosts(stateDir = headquartersStateDir()): string[] {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(stateDir, "desec.json"), "utf8")) as { domain?: unknown };
		const hostname = normalizeDnsHostname(raw.domain);
		return hostname ? [hostname] : [];
	} catch {
		return [];
	}
}

/** OS-level server secrets dir (TLS material lives under <secretsDir>/tls). */
function serverSecretsDir(): string {
	if (process.env.BOBBIT_SECRETS_DIR) return path.resolve(process.env.BOBBIT_SECRETS_DIR);
	const hash = crypto.createHash("sha256").update(headquartersDir()).digest("hex").slice(0, 16);
	if (process.platform === "win32") {
		const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
		return path.join(base, "bobbit", "secrets", hash);
	}
	if (process.platform === "darwin") {
		return path.join(os.homedir(), "Library", "Application Support", "bobbit", "secrets", hash);
	}
	const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
	return path.join(base, "bobbit", "secrets", hash);
}

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
const publicViteHosts = configuredPublicViteHosts();

/**
 * Read the gateway URL from .bobbit/state/gateway-url. Called on every
 * proxied request so port changes (e.g. 3001→3002) are picked up
 * without restarting Vite.
 */
function readGatewayUrl(): string {
	if (process.env.GATEWAY_URL) return process.env.GATEWAY_URL;
	const gwFile = path.join(headquartersStateDir(), "gateway-url");
	try {
		if (fs.existsSync(gwFile)) return fs.readFileSync(gwFile, "utf-8").trim();
	} catch {}
	return `${proto}://${host}:3001`;  // fallback before first startup
}

// Load TLS cert for vite's own HTTPS server + proxy trust. The HQ split
// relocated TLS material from <project>/.bobbit/state/tls to the OS-level
// serverSecretsDir(); fall back to the legacy path for pre-split installs.
function resolveTlsDir(): string {
	const secretsTls = path.join(serverSecretsDir(), "tls");
	if (fs.existsSync(path.join(secretsTls, "cert.pem"))) return secretsTls;
	return path.join(process.cwd(), ".bobbit", "state", "tls");
}
const tlsDir = resolveTlsDir();
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

/** Canonical mount carried by the persisted gateway target URL. */
export function gatewayProxyTargetBase(target: URL): string {
	if (target.pathname === "/") return "";
	return target.pathname.replace(/\/+$/, "");
}

/** Join a root-mounted Vite route to a possibly mounted gateway target once. */
export function gatewayProxyPath(target: URL, incomingUrl: string): string {
	const incoming = incomingUrl.startsWith("/") ? incomingUrl : `/${incomingUrl}`;
	return `${gatewayProxyTargetBase(target)}${incoming}`;
}

/** Strip the mounted target boundary without accepting sibling string prefixes. */
function stripGatewayProxyTargetBase(pathname: string, target: URL): string | null {
	const targetBase = gatewayProxyTargetBase(target);
	if (!targetBase) return pathname;
	if (pathname === targetBase) return "/";
	if (!pathname.startsWith(`${targetBase}/`)) return null;
	return pathname.slice(targetBase.length);
}

/** Rebase a mounted root/absolute public URL to the root-mounted Vite origin. */
function rebaseGatewayPublicUrl(raw: string, target: URL): string {
	const isRootRelative = raw.startsWith("/") && !raw.startsWith("//");
	const isAbsolute = /^[A-Za-z][A-Za-z\d+.-]*:/.test(raw) || raw.startsWith("//");
	if (!isRootRelative && !isAbsolute) return raw;
	let resolved: URL;
	try {
		resolved = new URL(raw, target.origin);
	} catch {
		return raw;
	}
	if (resolved.origin !== target.origin) return raw;
	const rebasedPath = stripGatewayProxyTargetBase(resolved.pathname, target);
	if (rebasedPath === null) return raw;
	return `${rebasedPath}${resolved.search}${resolved.hash}`;
}

/** Rebase same-gateway redirects, including relative Location values. */
export function rebaseGatewayProxyLocation(raw: string, targetRequestUrl: URL, target: URL): string {
	let resolved: URL;
	try {
		resolved = new URL(raw, targetRequestUrl);
	} catch {
		return raw;
	}
	if (resolved.origin !== target.origin) return raw;
	const rebasedPath = stripGatewayProxyTargetBase(resolved.pathname, target);
	if (rebasedPath === null) return raw;
	return `${rebasedPath}${resolved.search}${resolved.hash}`;
}

/** Translate the gateway's mount-scoped browser cookie to Vite's root scope. */
export function rebaseGatewayProxyCookie(cookie: string, target: URL): string {
	const targetBase = gatewayProxyTargetBase(target);
	if (!targetBase) return cookie;
	const expectedPath = `${targetBase}/`;
	return cookie.replace(/(;\s*Path\s*=\s*)([^;]*)/gi, (match, prefix: string, value: string) =>
		value.trim() === expectedPath ? `${prefix}/` : match,
	);
}

/** Rebase the dynamic mounted manifest for the root-mounted development UI. */
export function rebaseGatewayProxyManifest(value: unknown, target: URL): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const manifest = value as Record<string, unknown>;
	const rebased: Record<string, unknown> = { ...manifest };
	for (const key of ["start_url", "scope"] as const) {
		if (typeof manifest[key] === "string") {
			rebased[key] = rebaseGatewayPublicUrl(manifest[key], target);
		}
	}
	if (Array.isArray(manifest.icons)) {
		rebased.icons = manifest.icons.map((icon) => {
			if (!icon || typeof icon !== "object" || Array.isArray(icon)) return icon;
			const record = icon as Record<string, unknown>;
			return typeof record.src === "string"
				? { ...record, src: rebaseGatewayPublicUrl(record.src, target) }
				: icon;
		});
	}
	return rebased;
}

/** Rewrite only Bobbit's marked preview base element, rejecting ambiguity. */
export function rebaseGatewayProxyPreviewHtml(html: string, target: URL): string {
	const markedBasePattern = /<base\b[^>]*\sdata-bobbit-preview-base(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*>/gi;
	const matches = html.match(markedBasePattern) ?? [];
	if (matches.length === 0) return html;
	if (matches.length !== 1) {
		throw new Error("gateway preview response contained duplicate marked base elements");
	}
	const markedBase = matches[0];
	const hrefPattern = /\bhref\s*=\s*(["'])(.*?)\1/i;
	const href = hrefPattern.exec(markedBase);
	if (!href) throw new Error("gateway preview response contained a marked base without href");
	const rebasedHref = rebaseGatewayPublicUrl(href[2], target);
	const rewrittenBase = markedBase.replace(hrefPattern, `href=${href[1]}${rebasedHref}${href[1]}`);
	return html.replace(markedBase, () => rewrittenBase);
}

function translateGatewayProxyHeaders(
	raw: http.IncomingHttpHeaders,
	targetRequestUrl: URL,
	target: URL,
): Record<string, string | string[] | undefined> {
	const headers = stripH1Response(raw);
	const location = headers.location;
	if (typeof location === "string") {
		headers.location = rebaseGatewayProxyLocation(location, targetRequestUrl, target);
	} else if (Array.isArray(location)) {
		headers.location = location.map((value) => rebaseGatewayProxyLocation(value, targetRequestUrl, target));
	}
	const setCookie = headers["set-cookie"];
	if (typeof setCookie === "string") {
		headers["set-cookie"] = rebaseGatewayProxyCookie(setCookie, target);
	} else if (Array.isArray(setCookie)) {
		headers["set-cookie"] = setCookie.map((value) => rebaseGatewayProxyCookie(value, target));
	}
	return headers;
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
 * Tailwind 4.3.3 assumes Vite always supplies `server` to hotUpdate, while
 * bundled dev intentionally supplies only type/file/modules. Mirror Tailwind's
 * merged (but unreleased) fix until the next package release lands.
 * https://github.com/tailwindlabs/tailwindcss/pull/20379
 */
function tailwindcssWithBundledDevGuard(): Plugin[] {
	const plugins = tailwindcss();
	const generator = plugins.find((plugin) => plugin.name === "@tailwindcss/vite:generate:serve");
	const hotUpdate = generator?.hotUpdate;
	if (generator && typeof hotUpdate === "function") {
		generator.hotUpdate = function guardedTailwindHotUpdate(options) {
			if (!options.server) return;
			return hotUpdate.call(this, options);
		};
	}
	return plugins;
}

const PACK_DEV_REBUILT_PATH = "/__bobbit_dev/pack-rebuilt";
const PACK_DEV_REBUILT_MAX_BODY = 8 * 1024;
const PACK_DEV_RELOAD_HEADER = "x-bobbit-pack-reload";
const SAFE_PACK_ID = /^[a-z0-9][a-z0-9-]*$/;

type NetworkInterfaces = ReturnType<typeof os.networkInterfaces>;

function normalizedPeerAddress(address: string): string {
	const withoutScope = address.trim().toLowerCase().replace(/%.+$/, "");
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(withoutScope);
	return mapped?.[1] ?? withoutScope;
}

function sameIpAddress(left: string, right: string): boolean {
	const family = net.isIP(left);
	if (family === 0 || net.isIP(right) !== family) return false;
	const type = family === 4 ? "ipv4" : "ipv6";
	try {
		const addresses = new net.BlockList();
		addresses.addAddress(left, type);
		return addresses.check(right, type);
	} catch {
		return false;
	}
}

/** True only for a loopback peer or an address assigned to this machine. */
export function isLocalVitePeer(remoteAddress: string | undefined, interfaces: NetworkInterfaces = os.networkInterfaces()): boolean {
	if (!remoteAddress) return false;
	const peer = normalizedPeerAddress(remoteAddress);
	if ((net.isIP(peer) === 4 && peer.startsWith("127.")) || sameIpAddress(peer, "::1")) return true;
	if (net.isIP(peer) === 0) return false;

	for (const addresses of Object.values(interfaces)) {
		for (const address of addresses ?? []) {
			if (sameIpAddress(peer, normalizedPeerAddress(address.address))) return true;
		}
	}
	return false;
}

function validPackReloadPayload(value: unknown): value is { pack: string; reloadToken: number } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return Object.keys(record).length === 2
		&& typeof record.pack === "string"
		&& SAFE_PACK_ID.test(record.pack)
		&& typeof record.reloadToken === "number"
		&& Number.isSafeInteger(record.reloadToken)
		&& record.reloadToken > 0;
}

/**
 * Development-only bridge from the authored-pack watcher to Vite's existing
 * HMR channel. The gateway and production build expose no corresponding API.
 */
export function packDevHotReload(): Plugin {
	return {
		name: "bobbit-pack-dev-hot-reload",
		apply: "serve",
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				let pathname: string;
				try {
					pathname = new URL(req.url || "/", "http://vite.invalid").pathname;
				} catch {
					return next();
				}
				if (pathname !== PACK_DEV_REBUILT_PATH) return next();
				if (req.method !== "POST") {
					res.writeHead(405, { Allow: "POST", "Content-Type": "text/plain; charset=utf-8" });
					res.end("Method Not Allowed");
					return;
				}
				if (!isLocalVitePeer(req.socket.remoteAddress)) {
					res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
					res.end("Forbidden");
					return;
				}
				// A required non-simple header prevents a hostile browser origin from
				// issuing an opaque loopback write. This route deliberately emits no
				// CORS allow headers, so browsers cannot preflight the header.
				if (req.headers[PACK_DEV_RELOAD_HEADER] !== "1") {
					res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
					res.end("Forbidden");
					return;
				}

				const declaredLength = req.headers["content-length"];
				if (declaredLength !== undefined) {
					const rawLength = Array.isArray(declaredLength) ? declaredLength[0] : declaredLength;
					const isNumericLength = typeof rawLength === "string" && /^\d+$/.test(rawLength);
					if (!isNumericLength || Number(rawLength) > PACK_DEV_REBUILT_MAX_BODY) {
						res.writeHead(isNumericLength ? 413 : 400, { "Content-Type": "text/plain; charset=utf-8" });
						res.end(isNumericLength ? "Payload Too Large" : "Bad Request");
						req.resume();
						return;
					}
				}

				let size = 0;
				let complete = false;
				const chunks: Buffer[] = [];
				const reject = (status: number, message: string) => {
					if (complete) return;
					complete = true;
					res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
					res.end(message);
				};
				req.on("data", (chunk: Buffer | string) => {
					if (complete) return;
					const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
					size += bytes.byteLength;
					if (size > PACK_DEV_REBUILT_MAX_BODY) {
						reject(413, "Payload Too Large");
						return;
					}
					chunks.push(bytes);
				});
				req.on("error", () => reject(400, "Bad Request"));
				req.on("aborted", () => reject(400, "Bad Request"));
				req.on("end", () => {
					if (complete) return;
					let payload: unknown;
					try {
						payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					} catch {
						reject(400, "Bad Request");
						return;
					}
					if (!validPackReloadPayload(payload)) {
						reject(400, "Bad Request");
						return;
					}
					complete = true;
					server.ws.send({
						type: "custom",
						event: "bobbit:pack-rebuilt",
						data: payload,
					});
					res.writeHead(204);
					res.end();
				});
			});
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
			// --- HTTP proxy for root-mounted dev routes -------------------
			server.middlewares.use((req, res, next) => {
				const incomingUrl = req.url || "/";
				let incomingPathname: string;
				try {
					incomingPathname = new URL(incomingUrl, "http://vite.invalid").pathname;
				} catch {
					return next();
				}
				const isApi = incomingPathname === "/api" || incomingPathname.startsWith("/api/");
				const isManifest = incomingPathname === "/manifest.json";
				const isPreview = incomingPathname === "/preview" || incomingPathname.startsWith("/preview/");
				if (!isApi && !isManifest && !isPreview) return next();

				const target = new URL(readGatewayUrl());
				const targetPath = gatewayProxyPath(target, incomingUrl);
				const targetRequestUrl = new URL(targetPath, target.origin);
				const requestHeaders = stripH2Request(req.headers, target.host);
				// Manifest and preview HTML are selectively rebased below. Ask for an
				// identity body so the proxy never rewrites compressed bytes.
				if (isManifest || isPreview) requestHeaders["accept-encoding"] = "identity";
				// https.RequestOptions (superset of http.RequestOptions) so the TLS-only
				// rejectUnauthorized is accepted; http.request ignores it for plain HTTP.
				const opts: https.RequestOptions = {
					hostname: target.hostname,
					port: target.port,
					path: targetPath,
					method: req.method,
					headers: requestHeaders,
					rejectUnauthorized: false,
				};
				const mod = target.protocol === "https:" ? https : http;
				const proxyReq = mod.request(opts, (proxyRes: http.IncomingMessage) => {
					const headers = translateGatewayProxyHeaders(proxyRes.headers, targetRequestUrl, target);
					const contentTypeValue = proxyRes.headers["content-type"];
					const contentType = Array.isArray(contentTypeValue) ? contentTypeValue[0] : contentTypeValue || "";
					const contentEncodingValue = proxyRes.headers["content-encoding"];
					const contentEncoding = Array.isArray(contentEncodingValue)
						? contentEncodingValue[0]
						: contentEncodingValue;
					const canRewriteBody = !contentEncoding || contentEncoding === "identity";
					const shouldBuffer = req.method !== "HEAD"
						&& canRewriteBody
						&& (isManifest || (isPreview && /\btext\/html\b/i.test(contentType)));

					if (!shouldBuffer) {
						res.writeHead(proxyRes.statusCode ?? 502, headers);
						proxyRes.pipe(res, { end: true });
						return;
					}

					const chunks: Buffer[] = [];
					proxyRes.on("data", (chunk: Buffer | string) => {
						chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
					});
					proxyRes.on("error", () => {
						if (!res.headersSent) {
							res.writeHead(502, { "Content-Type": "text/plain" });
							res.end("Gateway response interrupted");
						}
					});
					proxyRes.on("end", () => {
						if (res.headersSent) return;
						let body = Buffer.concat(chunks);
						try {
							if (isManifest) {
								try {
									const parsed = JSON.parse(body.toString("utf-8"));
									body = Buffer.from(JSON.stringify(rebaseGatewayProxyManifest(parsed, target)));
								} catch (error) {
									if (error instanceof SyntaxError) {
										// Non-JSON gateway errors are forwarded unchanged.
									} else {
										throw error;
									}
								}
							} else {
								body = Buffer.from(rebaseGatewayProxyPreviewHtml(body.toString("utf-8"), target));
							}
						} catch (error) {
							console.warn(`[api proxy] ${error instanceof Error ? error.message : String(error)}`);
							res.writeHead(502, { "Content-Type": "text/plain" });
							res.end("Invalid gateway response");
							return;
						}
						headers["content-length"] = String(body.byteLength);
						delete headers["content-encoding"];
						res.writeHead(proxyRes.statusCode ?? 502, headers);
						res.end(body);
					});
				});
				proxyReq.on("error", (err: Error) => {
					// ECONNREFUSED is the expected state while the gateway restarts — only
					// surface it under BOBBIT_DEBUG. Other errors always warn.
					if (!/ECONNREFUSED/.test(err.message) || process.env.BOBBIT_DEBUG)
						console.warn(`[api proxy] ${err.message} — gateway likely restarting`);
					if (!res.headersSent) {
						res.writeHead(502, { "Content-Type": "text/plain" });
						res.end("Gateway restarting");
					}
				});
				req.pipe(proxyReq, { end: true });
			});

			// --- WebSocket proxy for root-mounted /ws/* ------------------
			server.httpServer?.on("upgrade", (req, socket: import("node:net").Socket, head) => {
				const incomingUrl = req.url || "/";
				let incomingPathname: string;
				try {
					incomingPathname = new URL(incomingUrl, "http://vite.invalid").pathname;
				} catch {
					return;
				}
				if (incomingPathname !== "/ws" && !incomingPathname.startsWith("/ws/")) return;
				const target = new URL(readGatewayUrl());
				const mod = target.protocol === "https:" ? https : http;
				const proxyReq = mod.request({
					hostname: target.hostname,
					port: target.port,
					path: gatewayProxyPath(target, incomingUrl),
					method: req.method,
					headers: stripH2Request(req.headers, target.host),
					rejectUnauthorized: false,
				});
				proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
					// Forward the 101 Switching Protocols response to the client.
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
					if (!/ECONNREFUSED/.test(err.message) || process.env.BOBBIT_DEBUG)
						console.warn(`[ws proxy] ${err.message} — gateway likely restarting`);
					socket.destroy();
				});
				if (head.length) proxyReq.write(head);
				proxyReq.end();
			});
		},
	};
}

export default defineConfig(({ command, mode }) => ({
	plugins: [
		tailwindcssWithBundledDevGuard(),
		blockDangerousGlobs(),
		localhostGuard(),
		packDevHotReload(),
		bobbitSwVersion(),
		dynamicGatewayProxy(),
	],
	// Expose a dev-mode boolean via globalThis so code that needs to gate
	// dev-only behaviour can read `(globalThis as any).__BOBBIT_DEV__` without
	// touching `import.meta.env` — important for test fixtures that bundle
	// via esbuild iife (which doesn't support `import.meta`).
	define: {
		"globalThis.__BOBBIT_DEV__": JSON.stringify(mode !== "production"),
	},
	// Bundle the browser graph during development. Bobbit's large eager graph
	// takes tens of seconds to traverse as one request per source module; Vite's
	// bundled mode keeps HMR while serving a small set of in-memory chunks.
	// Production retains its mount-aware runtime URL rewriting instead. The
	// source-runtime E2E owns an explicit opt-out because it verifies the actual
	// source module graph rather than the normal bundled development runtime.
	experimental: command === "build"
		? {
			renderBuiltUrl(filename, { hostType }) {
				// JavaScript synthesizes lazy/module-preload URLs after the server has
				// rewritten index.html, so resolve those against the stamped runtime mount.
				if (hostType === "js") {
					return {
						runtime: `(globalThis.__BOBBIT_BASE_PATH__ || "") + "/" + ${JSON.stringify(filename)}`,
					};
				}
				// CSS assets live beside their emitted stylesheet. HTML references stay
				// root-absolute until the gateway rewrites the served SPA shell.
				return { relative: hostType === "css" };
			},
		}
		: process.env.BOBBIT_VITE_SOURCE_GRAPH === "1"
			? undefined
			: { bundledDev: true },
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
				 * Pin large, slow-changing vendor deps and stable app seams into
				 * their own chunks so (a) the entry chunk stays small and (b)
				 * returning users keep cached vendor bundles across deploys when
				 * only app code changes. Order matters: more specific paths first.
				 *
				 * Anything not matched here falls through to Vite's default
				 * dependency-graph chunking (lazy provider chunks, dynamic
				 * imports for pi-ai/qrcode/jszip/highlight.js, etc.).
				 */
				manualChunks: (id) => {
					const normalizedId = id.replace(/\\/g, "/");
					if (normalizedId.endsWith("/src/app/message-reducer.ts")) return "app-message-reducer";
					if (normalizedId.endsWith("/src/app/panel-workspace.ts")) return "app-panel-workspace";
					if (normalizedId.endsWith("/src/app/routing.ts")) return "app-routing";
					// Additional stable app seams peeled out of the entry chunk to keep
					// its raw size under the 600 KB budget (see tests/bundle-size.test.ts).
					// These stay in the eager import graph (entry chunk imports them);
					// modulePreload covers the extra requests. Packaging change only.
					if (normalizedId.endsWith("/src/app/session-manager.ts")) return "app-session-manager";
					if (normalizedId.endsWith("/src/app/remote-agent.ts")) return "app-remote-agent";
					if (normalizedId.endsWith("/src/app/preview-panel.ts")) return "app-preview-panel";
					if (
						normalizedId.endsWith("/src/ui/components/review/ReviewPane.ts") ||
						normalizedId.endsWith("/src/ui/components/review/AnnotationStore.ts")
					) return "app-review";
					if (
						normalizedId.endsWith("/src/ui/inbox/InboxPanel.ts") ||
						normalizedId.endsWith("/src/ui/inbox/AddToInboxDialog.ts") ||
						normalizedId.endsWith("/src/ui/inbox/InboxEntry.ts")
					) return "app-inbox";
					// Leaf UI modules (pure data / custom elements with no back-edge into the
					// app shell): peeled into eager chunks so they don't pad the app-shell SCC
					// currently emitted as `app-review`. Cycle-free by construction (none of
					// these import `src/app/*`), so no circular-chunk warning; modulePreload
					// keeps first paint eager while staying under Vite's 600 kB warning limit.
					if (
						normalizedId.endsWith("/src/ui/bobbit-sprite-data.ts") ||
						normalizedId.endsWith("/src/ui/bobbit-render.ts") ||
						normalizedId.endsWith("/src/ui/components/BobbitLoadingAnimation.ts")
					) return "app-bobbit-render";
					if (normalizedId.endsWith("/src/ui/utils/i18n.ts")) return "app-i18n";
					if (
						normalizedId.endsWith("/src/ui/tools/renderer-registry.ts") ||
						normalizedId.endsWith("/src/ui/components/StreamingMessageContainer.ts") ||
						normalizedId.endsWith("/src/ui/components/LiveTimer.ts") ||
						normalizedId.endsWith("/src/ui/components/ToolPermissionCard.ts") ||
						normalizedId.endsWith("/src/ui/components/FileMentionChip.ts") ||
						normalizedId.endsWith("/src/ui/components/DeferredBlock.ts")
					) return "app-message-ui-leaves";
					if (
						normalizedId.endsWith("/src/ui/utils/attachment-utils.ts") ||
						normalizedId.endsWith("/src/ui/prompts/prompts.ts")
					) return "app-ui-leaves";
					if (!normalizedId.includes("node_modules")) return;
					if (normalizedId.includes("/@sinclair/typebox/")) return "vendor-typebox";
					if (normalizedId.includes("/marked")) return "vendor-marked";
					if (normalizedId.includes("/@mariozechner/mini-lit/")) return "vendor-mini-lit";
					if (normalizedId.includes("/lucide")) return "vendor-lucide";
					if (normalizedId.includes("/sortablejs/")) return "vendor-sortable";
					if (normalizedId.includes("/@recogito/") || normalizedId.includes("/@annotorious/") || normalizedId.includes("/rbush")) return "vendor-annotator";
					if (normalizedId.includes("/lit-html/") || normalizedId.includes("/lit-element/") || normalizedId.includes("/@lit/") || /\/lit\//.test(normalizedId)) return "vendor-lit";
					return undefined;
				},
			},
		},
	},
	server: {
		host,
		// IP literals and localhost are allowed by Vite automatically. DNS-mounted
		// mobile clients need the configured public hostname explicitly allowed so
		// the HMR WebSocket upgrade is not rejected with HTTP 400.
		allowedHosts: publicViteHosts,
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
