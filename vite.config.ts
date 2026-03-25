import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vite";

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

// Read the actual gateway URL from disk (written by cli.ts after the server
// binds, so it reflects the real port even if 3001 was in use).
function readGatewayUrl(): string {
	const gwFile = path.join(process.cwd(), ".bobbit", "state", "gateway-url");
	try {
		if (fs.existsSync(gwFile)) return fs.readFileSync(gwFile, "utf-8").trim();
	} catch {}
	return `${proto}://${host}:3001`;  // fallback before first startup
}
const GATEWAY = process.env.GATEWAY_URL || readGatewayUrl();
const GATEWAY_WS = GATEWAY.replace(/^https/, "wss").replace(/^http/, "ws");

// Load TLS cert for vite's own HTTPS server + proxy trust
const tlsDir = path.join(process.cwd(), ".bobbit", "state", "tls");
const certPath = path.join(tlsDir, "cert.pem");
const keyPath = path.join(tlsDir, "key.pem");
const tlsAvailable = proto === "https" && fs.existsSync(certPath) && fs.existsSync(keyPath);

export default defineConfig({
	plugins: [tailwindcss()],
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
		proxy: {
			"/api": {
				target: GATEWAY,
				changeOrigin: true,
				// Trust self-signed cert when proxying to the gateway
				secure: false,
				on: {
					error(err, _req, res) {
						console.warn(`[api proxy] ${err.message} — gateway likely restarting`);
						if (res && "writeHead" in res && !res.headersSent) {
							(res as import("node:http").ServerResponse).writeHead(502, { "Content-Type": "text/plain" });
							(res as import("node:http").ServerResponse).end("Gateway restarting");
						}
					},
				},
			},
			"/ws": {
				target: GATEWAY_WS,
				ws: true,
				secure: false,
				// Gracefully handle backend restarts instead of crashing Vite
				on: {
					error(err) {
						console.warn(`[ws proxy] ${err.message} — gateway likely restarting`);
					},
				},
			},
		},
	},
});
