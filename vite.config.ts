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

const meshIp = findNordLynxIp();
const host = process.env.VITE_HOST || meshIp || "localhost";

// Detect whether the gateway is running with TLS by checking for the cert
const piDir = path.join(os.homedir(), ".pi");
const hasTlsCert = fs.existsSync(path.join(piDir, "gateway-cert.pem"));
const noTls = process.env.GATEWAY_NO_TLS === "1";
const gwProto = noTls ? "http" : (hasTlsCert ? "https" : "http");
const GATEWAY = process.env.GATEWAY_URL || `${gwProto}://${host}:3001`;
const GATEWAY_WS = GATEWAY.replace(/^https/, "wss").replace(/^http/, "ws");

if (!meshIp && !process.env.VITE_HOST) {
	console.warn("Warning: NordLynx interface not found. Vite will bind to localhost.");
	console.warn("  Start NordVPN, or set VITE_HOST manually.\n");
}

// Load the self-signed cert for vite's own HTTPS server + proxy trust
const certPath = path.join(piDir, "gateway-cert.pem");
const keyPath = path.join(piDir, "gateway-key.pem");
const tlsAvailable = !noTls && fs.existsSync(certPath) && fs.existsSync(keyPath);

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
