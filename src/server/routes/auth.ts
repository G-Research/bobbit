import fs from "node:fs";
import http from "node:http";
import type { AppContext } from "../app-context.js";
import { oauthComplete, oauthStart, oauthStatus } from "../auth/oauth.js";
import { json, readBody } from "./utils.js";

export async function handle(
	ctx: AppContext,
	url: URL,
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<boolean> {
	// GET /api/ca-cert — download the Bobbit CA certificate for device trust
	if (url.pathname === "/api/ca-cert" && req.method === "GET") {
		const caCertPath = ctx.config.tls?.caCert;
		if (!caCertPath || !fs.existsSync(caCertPath)) {
			json(res, { error: "No CA certificate available. Server is using a self-signed certificate." }, 404);
			return true;
		}
		const certData = fs.readFileSync(caCertPath);
		res.writeHead(200, {
			"Content-Type": "application/x-pem-file",
			"Content-Disposition": "attachment; filename=\"bobbit-ca.crt\"",
			"Content-Length": certData.length,
		});
		res.end(certData);
		return true;
	}

	// GET /api/connection-info — LAN addresses for multi-device access
	if (url.pathname === "/api/connection-info" && req.method === "GET") {
		const interfaces = await import("node:os").then((os) => os.networkInterfaces());
		const addresses: { ip: string; name: string }[] = [];
		for (const [name, addrs] of Object.entries(interfaces)) {
			if (!addrs) continue;
			for (const addr of addrs) {
				if (addr.family === "IPv4" && !addr.internal) {
					addresses.push({ ip: addr.address, name });
				}
			}
		}
		json(res, { addresses, port: ctx.config.port });
		return true;
	}

	// GET /api/oauth/status
	if (url.pathname === "/api/oauth/status" && req.method === "GET") {
		json(res, oauthStatus());
		return true;
	}

	// POST /api/oauth/start — begin OAuth flow, returns auth URL
	if (url.pathname === "/api/oauth/start" && req.method === "POST") {
		try {
			const result = await oauthStart();
			json(res, result);
		} catch (err) {
			json(res, { error: String(err) }, 500);
		}
		return true;
	}

	// POST /api/oauth/complete — exchange code for tokens
	if (url.pathname === "/api/oauth/complete" && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.flowId || !body?.code) {
			json(res, { error: "Missing flowId or code" }, 400);
			return true;
		}
		try {
			const result = await oauthComplete(body.flowId, body.code);
			json(res, result, result.success ? 200 : 400);
		} catch (err) {
			json(res, { error: String(err) }, 500);
		}
		return true;
	}

	return false;
}
