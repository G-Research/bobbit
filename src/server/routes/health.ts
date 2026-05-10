/**
 * Health, setup-status, shutdown, connection-info, ca-cert, internal/test/replay.
 * Extracted from server.ts (commit: split server.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bobbitStateDir, bobbitConfigDir } from "../bobbit-dir.js";
import { isSetupComplete } from "../setup-status.js";
import { getAigwUrl } from "../agent/aigw-manager.js";
import { paceAndSend, PACE_TIMEOUT_MS } from "../replay-pacing.js";
import type { Route } from "./types.js";

export const healthRoutes: Route[] = [
	{
		method: "GET",
		pattern: "/api/health",
		handler: ({ deps, json }) => {
			const { config, sessionManager, preferencesStore } = deps;
			const isLocalhost = !config.forceAuth && (config.host === "localhost" || config.host === "127.0.0.1" || config.host === "::1");
			json({
				status: "ok",
				sessions: sessionManager.listSessions().length,
				localhost: isLocalhost,
				aigw: !!getAigwUrl(preferencesStore),
				setupComplete: isSetupComplete(),
				orphanedTranscripts: sessionManager.orphanedTranscriptsCount,
			});
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/internal\/test\/replay-buffered-events\/([^/]+)$/,
		handler: async ({ deps, params, json, jsonError }) => {
			if (process.env.BOBBIT_E2E !== "1") { jsonError(403, new Error("BOBBIT_E2E not enabled")); return; }
			const sessionId = params[1];
			const session = deps.sessionManager.getSession(sessionId);
			if (!session) { jsonError(404, new Error("session not found")); return; }
			const entries = session.eventBuffer.getAll() as any[];
			let replayed = 0;
			const deadline = Date.now() + PACE_TIMEOUT_MS;
			for (const entry of entries) {
				const isWrapped = entry && typeof entry === "object" && "event" in entry && ("seq" in entry || "ts" in entry);
				const framePayload = isWrapped
					? { type: "event" as const, data: entry.event, seq: entry.seq, ts: entry.ts }
					: { type: "event" as const, data: entry };
				const data = JSON.stringify(framePayload);
				for (const client of session.clients) {
					await paceAndSend(client as any, data, deadline);
				}
				replayed++;
			}
			json({ replayed, bufferSize: session.eventBuffer.size });
		},
	},
	{
		method: "GET",
		pattern: "/api/setup-status",
		handler: ({ json }) => {
			json({ complete: isSetupComplete() });
		},
	},
	{
		method: "POST",
		pattern: "/api/setup-status/dismiss",
		handler: ({ json }) => {
			const stateDir = bobbitStateDir();
			fs.mkdirSync(stateDir, { recursive: true });
			fs.writeFileSync(path.join(stateDir, "setup-complete"), "dismissed\n");
			json({ ok: true });
		},
	},
	{
		method: "GET",
		pattern: "/api/system-prompt-context",
		handler: ({ json }) => {
			const systemPromptPath = path.join(bobbitConfigDir(), "system-prompt.md");
			if (!fs.existsSync(systemPromptPath)) { json({ context: "" }); return; }
			try {
				const content = fs.readFileSync(systemPromptPath, "utf-8");
				const marker = "# Project Context";
				const idx = content.lastIndexOf(marker);
				if (idx === -1) { json({ context: "" }); return; }
				const context = content.slice(idx + marker.length).trim();
				json({ context });
			} catch { json({ context: "" }); }
		},
	},
	{
		method: "PUT",
		pattern: "/api/system-prompt-context",
		handler: async ({ readBody, json, jsonError }) => {
			const body = await readBody();
			if (!body || typeof body.context !== "string") { jsonError(400, new Error("Missing context")); return; }
			const systemPromptPath = path.join(bobbitConfigDir(), "system-prompt.md");
			try {
				let existing = "";
				if (fs.existsSync(systemPromptPath)) {
					existing = fs.readFileSync(systemPromptPath, "utf-8");
				}
				const marker = "# Project Context";
				const idx = existing.lastIndexOf(marker);
				const base = idx !== -1 ? existing.slice(0, idx).trimEnd() : existing.trimEnd();
				const newContent = base + "\n\n" + marker + "\n\n" + body.context.trim() + "\n";
				fs.mkdirSync(path.dirname(systemPromptPath), { recursive: true });
				fs.writeFileSync(systemPromptPath, newContent);
				json({ ok: true });
			} catch (err: any) {
				jsonError(500, err);
			}
		},
	},
	{
		method: "POST",
		pattern: "/api/system-prompt/customise",
		handler: ({ json, jsonError }) => {
			const userPath = path.join(bobbitConfigDir(), "system-prompt.md");
			const defaultPath = path.join(
				path.dirname(fileURLToPath(import.meta.url)),
				"..",
				"defaults",
				"system-prompt.md",
			);
			let created = false;
			try {
				if (!fs.existsSync(userPath)) {
					if (!fs.existsSync(defaultPath)) {
						jsonError(500, new Error("Default system-prompt.md not found in install"));
						return;
					}
					fs.mkdirSync(path.dirname(userPath), { recursive: true });
					fs.copyFileSync(defaultPath, userPath);
					created = true;
				}
				const content = fs.readFileSync(userPath, "utf-8");
				json({ path: userPath, created, content });
			} catch (err: any) {
				jsonError(500, err);
			}
		},
	},
	{
		method: "POST",
		pattern: "/api/shutdown",
		handler: ({ json }) => {
			json({ status: "shutting down" });
			setTimeout(() => process.exit(0), 500);
		},
	},
	{
		method: "GET",
		pattern: "/api/ca-cert",
		handler: ({ deps, res, jsonError }) => {
			const caCertPath = deps.config.tls?.caCert;
			if (!caCertPath || !fs.existsSync(caCertPath)) {
				jsonError(404, new Error("No CA certificate available. Server is using a self-signed certificate."));
				return;
			}
			const certData = fs.readFileSync(caCertPath);
			res.writeHead(200, {
				// iOS Safari needs this MIME type to offer the profile-install flow.
				"Content-Type": "application/x-x509-ca-cert",
				"Content-Disposition": "attachment; filename=\"bobbit-ca.crt\"",
				"Content-Length": certData.length,
			});
			res.end(certData);
		},
	},
];
