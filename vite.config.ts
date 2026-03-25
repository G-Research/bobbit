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

function dynamicGatewayProxy(): Plugin {
	return {
		name: "dynamic-gateway-proxy",
		configureServer(server) {
			// --- HTTP proxy for /api/* ----------------------------------
			server.middlewares.use((req, res, next) => {
				if (!req.url?.startsWith("/api")) return next();
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

export default defineConfig({
	plugins: [tailwindcss(), dynamicGatewayProxy()],
	build: {
		outDir: "dist/ui",
	},
	server: {
		host,
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
});
