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
 * Vite plugin: dynamic gateway proxy. Re-reads .bobbit/state/gateway-url
 * on every request so Vite always proxies to the correct port even if the
 * gateway restarts on a different one.
 */
function dynamicGatewayProxy(): Plugin {
	return {
		name: "bobbit-gateway-proxy",
		configureServer(server) {
			// Handle /api/* and /ws/* before Vite's own middleware
			server.middlewares.use((req, res, next) => {
				const url = req.url || "";
				if (!url.startsWith("/api/") && !url.startsWith("/ws/")) {
					return next();
				}

				const gateway = readGatewayUrl();
				const target = new URL(gateway);
				const transport = target.protocol === "https:" ? https : http;

				// Filter out HTTP/2 pseudo-headers (e.g. :method, :path) —
				// invalid in HTTP/1.1 proxy requests
				const fwdHeaders: Record<string, string | string[] | undefined> = {};
				for (const [k, v] of Object.entries(req.headers)) {
					if (!k.startsWith(":")) fwdHeaders[k] = v;
				}
				fwdHeaders.host = target.host;

				const proxyReq = transport.request(
					{
						hostname: target.hostname,
						port: target.port,
						path: url,
						method: req.method,
						headers: fwdHeaders,
						rejectUnauthorized: false, // trust self-signed cert
					},
					(proxyRes) => {
						res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
						proxyRes.pipe(res);
					},
				);

				proxyReq.on("error", (err) => {
					console.warn(`[proxy] ${err.message} — gateway likely restarting`);
					if (!res.headersSent) {
						res.writeHead(502, { "Content-Type": "text/plain" });
					}
					res.end("Gateway restarting");
				});

				req.pipe(proxyReq);
			});

			// Handle WebSocket upgrades for /ws/*
			server.httpServer?.on("upgrade", (req, socket, head) => {
				const url = req.url || "";
				if (!url.startsWith("/ws/")) return; // let Vite handle HMR upgrades

				const gateway = readGatewayUrl();
				const target = new URL(gateway);
				const wsPort = target.port || (target.protocol === "https:" ? "443" : "80");
				const transport = target.protocol === "https:" ? https : http;

				// Filter HTTP/2 pseudo-headers
				const wsHeaders: Record<string, string | string[] | undefined> = {};
				for (const [k, v] of Object.entries(req.headers)) {
					if (!k.startsWith(":")) wsHeaders[k] = v;
				}
				wsHeaders.host = target.host;

				const proxyReq = transport.request({
					hostname: target.hostname,
					port: wsPort,
					path: url,
					method: "GET",
					headers: wsHeaders,
					rejectUnauthorized: false,
				});

				proxyReq.on("upgrade", (_proxyRes, proxySocket, proxyHead) => {
					socket.write(
						"HTTP/1.1 101 Switching Protocols\r\n" +
						Object.entries(_proxyRes.headers)
							.map(([k, v]) => `${k}: ${v}`)
							.join("\r\n") +
						"\r\n\r\n",
					);
					if (proxyHead.length > 0) socket.write(proxyHead);
					proxySocket.pipe(socket);
					socket.pipe(proxySocket);
				});

				proxyReq.on("error", (err) => {
					console.warn(`[ws proxy] ${err.message} — gateway likely restarting`);
					socket.destroy();
				});

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
