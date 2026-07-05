// src/server/routes/oauth-account-routes.ts
//
// STR-01 cohort 11: OAuth account routes migrated out of handleApiRoute's
// legacy if/else chain into the core route registry. See
// docs/design/route-registry.md.
//
// Mechanical extraction — handler bodies below preserve the legacy behavior,
// with only handleApiRoute locals (url, req, json, jsonError, readBody)
// destructured from ctx.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed. Every legacy
// block here gated on path and method in the same `if` condition. A method
// mismatch skipped the block and fell through to the terminal 404; RouteTable's
// method-scoped matching preserves that by leaving other methods unregistered.

import { oauthComplete, oauthFlowStatus, oauthLogout, oauthStart, oauthStatus } from "../auth/oauth.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

// GET /api/oauth/status
async function handleOauthStatus(ctx: CoreRouteCtx): Promise<void> {
	const { url, json, jsonError } = ctx;
	try {
		json(oauthStatus(url.searchParams.get("provider") ?? undefined));
	} catch (err) {
		jsonError(400, err);
	}
	return;
}

// GET /api/oauth/flow-status?flowId=<id>[&provider=…] — callback-based OAuth progress
async function handleOauthFlowStatus(ctx: CoreRouteCtx): Promise<void> {
	const { url, json } = ctx;
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
	return;
}

// POST /api/oauth/start — begin OAuth flow, returns auth URL
async function handleOauthStart(ctx: CoreRouteCtx): Promise<void> {
	const { req, json, jsonError, readBody } = ctx;
	try {
		const body = await readBody(req).catch(() => ({}));
		const result = await oauthStart(body?.provider);
		json(result);
	} catch (err) {
		jsonError(500, err);
	}
	return;
}

// POST /api/oauth/complete — exchange code for tokens
async function handleOauthComplete(ctx: CoreRouteCtx): Promise<void> {
	const { req, json, jsonError, readBody } = ctx;
	const body = await readBody(req);
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
	return;
}

// POST /api/oauth/logout — clear/revoke a single provider's OAuth credential.
// Provider-partitioned: never touches other providers or API-key entries,
// and never echoes token material back to the client.
async function handleOauthLogout(ctx: CoreRouteCtx): Promise<void> {
	const { req, json, jsonError, readBody } = ctx;
	try {
		const body = await readBody(req).catch(() => ({}));
		const result = await oauthLogout(body?.provider);
		json(result);
	} catch (err) {
		jsonError(400, err);
	}
	return;
}

export function registerOauthAccountRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/oauth/status", handleOauthStatus);
	table.register("GET", "/api/oauth/flow-status", handleOauthFlowStatus);
	table.register("POST", "/api/oauth/start", handleOauthStart);
	table.register("POST", "/api/oauth/complete", handleOauthComplete);
	table.register("POST", "/api/oauth/logout", handleOauthLogout);
}
