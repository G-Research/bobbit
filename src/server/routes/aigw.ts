import http from "node:http";
import type { AppContext } from "../app-context.js";
import { readBody, json } from "./utils.js";
import { configureAigw, removeAigw, getAigwUrl, discoverAigwModels, proxyRequest } from "../agent/aigw-manager.js";
import { getAvailableModels, discoverModelsForConfig } from "../agent/model-registry.js";
import type { CustomProviderConfig } from "../agent/model-registry.js";

export async function handle(ctx: AppContext, url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
	const { preferencesStore, broadcastToAll } = ctx;

	/** Return preferences with sensitive keys (providerKey.*) filtered out. */
	function getSafePreferences(): Record<string, unknown> {
		const all = preferencesStore.getAll();
		const filtered: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(all)) {
			if (!key.startsWith("providerKey.")) {
				filtered[key] = value;
			}
		}
		return filtered;
	}

	/** Broadcast preferences_changed with sensitive keys filtered out. */
	function broadcastPreferencesChanged(): void {
		broadcastToAll({ type: "preferences_changed", preferences: getSafePreferences() });
	}

	// ── Custom Providers ──

	// GET /api/custom-providers — list all custom provider configs
	if (url.pathname === "/api/custom-providers" && req.method === "GET") {
		const configs = (preferencesStore.get("customProviders") as CustomProviderConfig[] | undefined) || [];
		json(res, configs);
		return true;
	}

	// POST /api/custom-providers/test — discover models without persisting
	if (url.pathname === "/api/custom-providers/test" && req.method === "POST") {
		const body = await readBody(req);
		if (!body || !body.type || !body.baseUrl) {
			json(res, { error: "Missing required fields: type, baseUrl" }, 400);
			return true;
		}
		const config: CustomProviderConfig = {
			id: body.id || "test-" + Date.now(),
			name: body.name || body.type,
			type: body.type,
			baseUrl: body.baseUrl,
			...(body.apiKey ? { apiKey: body.apiKey } : {}),
		};
		try {
			const models = await discoverModelsForConfig(config);
			json(res, { models });
		} catch (err: any) {
			json(res, { error: err?.message || "Discovery failed" }, 500);
		}
		return true;
	}

	// POST /api/custom-providers — add or update a custom provider config
	if (url.pathname === "/api/custom-providers" && req.method === "POST") {
		const body = await readBody(req);
		if (!body || !body.id || !body.type || !body.baseUrl) {
			json(res, { error: "Missing required fields: id, type, baseUrl" }, 400);
			return true;
		}
		const configs = (preferencesStore.get("customProviders") as CustomProviderConfig[] | undefined) || [];
		const existing = configs.findIndex((c: CustomProviderConfig) => c.id === body.id);
		const config: CustomProviderConfig = {
			id: body.id,
			name: body.name || body.id,
			type: body.type,
			baseUrl: body.baseUrl,
			...(body.apiKey ? { apiKey: body.apiKey } : {}),
			...(body.models ? { models: body.models } : {}),
		};
		if (existing >= 0) {
			configs[existing] = config;
		} else {
			configs.push(config);
		}
		preferencesStore.set("customProviders", configs);
		json(res, { ok: true, config });
		return true;
	}

	// DELETE /api/custom-providers/:id — remove a custom provider config
	if (url.pathname.startsWith("/api/custom-providers/") && req.method === "DELETE") {
		const providerId = decodeURIComponent(url.pathname.slice("/api/custom-providers/".length));
		if (!providerId) {
			json(res, { error: "Missing provider id" }, 400);
			return true;
		}
		const configs = (preferencesStore.get("customProviders") as CustomProviderConfig[] | undefined) || [];
		const filtered = configs.filter((c: CustomProviderConfig) => c.id !== providerId);
		preferencesStore.set("customProviders", filtered);
		json(res, { ok: true });
		return true;
	}

	// ── Provider Keys ──

	// GET /api/provider-keys — list providers that have keys set (no key values)
	if (url.pathname === "/api/provider-keys" && req.method === "GET") {
		const all = preferencesStore.getAll();
		const providers = Object.keys(all)
			.filter(k => k.startsWith("providerKey.") && all[k])
			.map(k => k.slice("providerKey.".length));
		json(res, { providers });
		return true;
	}

	// POST /api/provider-keys/:provider — store a provider API key
	if (url.pathname.startsWith("/api/provider-keys/") && req.method === "POST") {
		const provider = decodeURIComponent(url.pathname.slice("/api/provider-keys/".length));
		if (!provider) {
			json(res, { error: "Missing provider name" }, 400);
			return true;
		}
		const body = await readBody(req);
		if (!body?.key || typeof body.key !== "string") {
			json(res, { error: "Missing 'key' field" }, 400);
			return true;
		}
		preferencesStore.set(`providerKey.${provider}`, body.key);
		json(res, { ok: true });
		return true;
	}

	// DELETE /api/provider-keys/:provider — remove a provider API key
	if (url.pathname.startsWith("/api/provider-keys/") && req.method === "DELETE") {
		const provider = decodeURIComponent(url.pathname.slice("/api/provider-keys/".length));
		if (!provider) {
			json(res, { error: "Missing provider name" }, 400);
			return true;
		}
		preferencesStore.remove(`providerKey.${provider}`);
		json(res, { ok: true });
		return true;
	}

	// ── AI Gateway ──

	// GET /api/aigw/status — check if aigw is configured
	if (url.pathname === "/api/aigw/status" && req.method === "GET") {
		const aigwUrl = getAigwUrl(preferencesStore);
		if (!aigwUrl) {
			json(res, { configured: false });
		} else {
			// Discover fresh models instead of reading from preferences cache
			try {
				const models = await discoverAigwModels(aigwUrl);
				json(res, { configured: true, url: aigwUrl, models });
			} catch {
				json(res, { configured: true, url: aigwUrl, models: [] });
			}
		}
		return true;
	}

	// POST /api/aigw/configure — set aigw URL, discover models, write models.json
	if (url.pathname === "/api/aigw/configure" && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.url || typeof body.url !== "string") {
			json(res, { error: "Missing 'url' field" }, 400);
			return true;
		}
		try {
			const models = await configureAigw(body.url, preferencesStore);
			broadcastPreferencesChanged();
			json(res, { ok: true, models });
		} catch (err: any) {
			json(res, { error: `Failed to configure AI Gateway: ${err.message}` }, 502);
		}
		return true;
	}

	// DELETE /api/aigw/configure — remove aigw config
	if (url.pathname === "/api/aigw/configure" && req.method === "DELETE") {
		removeAigw(preferencesStore);
		broadcastPreferencesChanged();
		json(res, { ok: true });
		return true;
	}

	// POST /api/aigw/test — test connection to a URL without saving
	if (url.pathname === "/api/aigw/test" && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.url || typeof body.url !== "string") {
			json(res, { error: "Missing 'url' field" }, 400);
			return true;
		}
		try {
			const models = await discoverAigwModels(body.url);
			json(res, { ok: true, models });
		} catch (err: any) {
			json(res, { error: err.message }, 502);
		}
		return true;
	}

	// POST /api/aigw/refresh — re-discover models from the configured gateway
	if (url.pathname === "/api/aigw/refresh" && req.method === "POST") {
		const aigwUrl = getAigwUrl(preferencesStore);
		if (!aigwUrl) {
			json(res, { error: "No AI Gateway configured" }, 400);
			return true;
		}
		try {
			const models = await configureAigw(aigwUrl, preferencesStore);
			broadcastPreferencesChanged();
			json(res, { models });
		} catch (err: any) {
			json(res, { error: err.message || "Refresh failed" }, 502);
		}
		return true;
	}

	// Proxy: /api/aigw/v1/* → forward to configured aigw URL
	if (url.pathname.startsWith("/api/aigw/v1/") && getAigwUrl(preferencesStore)) {
		const aigwUrl = getAigwUrl(preferencesStore)!;
		const subPath = url.pathname.replace("/api/aigw/v1/", "/v1/");
		const targetUrl = `${aigwUrl}${subPath}${url.search}`;
		proxyRequest(targetUrl, req, res);
		return true;
	}

	return false;
}
