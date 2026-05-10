/**
 * OAuth status / flow / start / complete.
 * Extracted from server.ts (commit: split server.ts).
 */
import { oauthComplete, oauthFlowStatus, oauthStart, oauthStatus } from "../auth/oauth.js";
import type { Route } from "./types.js";

export const oauthRoutes: Route[] = [
	{
		method: "GET",
		pattern: "/api/oauth/status",
		handler: ({ url, json, jsonError }) => {
			try {
				json(oauthStatus(url.searchParams.get("provider") ?? undefined));
			} catch (err) {
				jsonError(400, err);
			}
		},
	},
	{
		method: "GET",
		pattern: "/api/oauth/flow-status",
		handler: ({ url, json }) => {
			const flowId = url.searchParams.get("flowId");
			if (!flowId) {
				json({ error: "Missing flowId" }, 400);
				return;
			}
			const provider = url.searchParams.get("provider") || undefined;
			const status = oauthFlowStatus(flowId, provider);
			if (status.error === "flow not found") {
				json(status, 404);
				return;
			}
			json(status);
		},
	},
	{
		method: "POST",
		pattern: "/api/oauth/start",
		handler: async ({ readBody, json, jsonError }) => {
			try {
				const body = await readBody().catch(() => ({}));
				const result = await oauthStart(body?.provider);
				json(result);
			} catch (err) {
				jsonError(500, err);
			}
		},
	},
	{
		method: "POST",
		pattern: "/api/oauth/complete",
		handler: async ({ readBody, json, jsonError }) => {
			const body = await readBody();
			if (!body?.flowId || !body?.code) {
				json({ error: "Missing flowId or code" }, 400);
				return;
			}
			try {
				const result = await oauthComplete(body.flowId, body.code);
				json(result, result.success ? 200 : 400);
			} catch (err) {
				jsonError(500, err);
			}
		},
	},
];
