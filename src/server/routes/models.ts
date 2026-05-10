/**
 * Model registry, custom providers, provider keys, AI Gateway, models test + proxy.
 * Extracted from server.ts (commit: split server.ts).
 */
import { getAvailableModels, discoverModelsForConfig, invalidateModelCache } from "../agent/model-registry.js";
import type { CustomProviderConfig } from "../agent/model-registry.js";
import { getAvailableImageModels } from "../agent/image-generation.js";
import { configureAigw, removeAigw, getAigwUrl, discoverAigwModels, proxyRequest } from "../agent/aigw-manager.js";
import { broadcastPreferencesChanged } from "./cross-project.js";
import type { Route } from "./types.js";

export const modelsRoutes: Route[] = [
	{
		method: "GET",
		pattern: "/api/models",
		handler: async ({ deps, json, jsonError }) => {
			try {
				const models = await getAvailableModels(deps.preferencesStore);
				json(models);
			} catch (err: any) {
				jsonError(500, err, { error: `Failed to load models: ${err.message}` });
			}
		},
	},
	{
		method: "GET",
		pattern: "/api/image-models",
		handler: ({ deps, json, jsonError }) => {
			try {
				json(getAvailableImageModels(deps.preferencesStore));
			} catch (err: any) {
				jsonError(500, err, { error: `Failed to load image models: ${err.message}` });
			}
		},
	},
	{
		method: "GET",
		pattern: "/api/custom-providers",
		handler: ({ deps, json }) => {
			const configs = (deps.preferencesStore.get("customProviders") as CustomProviderConfig[] | undefined) || [];
			json(configs);
		},
	},
	{
		method: "POST",
		pattern: "/api/custom-providers/test",
		handler: async ({ readBody, json, jsonError }) => {
			const body = await readBody();
			if (!body || !body.type || !body.baseUrl) {
				json({ error: "Missing required fields: type, baseUrl" }, 400);
				return;
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
				json({ models });
			} catch (err: any) {
				jsonError(500, err);
			}
		},
	},
	{
		method: "POST",
		pattern: "/api/custom-providers",
		handler: async ({ deps, readBody, json }) => {
			const body = await readBody();
			if (!body || !body.id || !body.type || !body.baseUrl) {
				json({ error: "Missing required fields: id, type, baseUrl" }, 400);
				return;
			}
			const configs = (deps.preferencesStore.get("customProviders") as CustomProviderConfig[] | undefined) || [];
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
			deps.preferencesStore.set("customProviders", configs);
			json({ ok: true, config });
		},
	},
	{
		method: "DELETE",
		pattern: /^\/api\/custom-providers\/(.+)$/,
		handler: ({ deps, params, json }) => {
			const providerId = decodeURIComponent(params[1]);
			if (!providerId) {
				json({ error: "Missing provider id" }, 400);
				return;
			}
			const configs = (deps.preferencesStore.get("customProviders") as CustomProviderConfig[] | undefined) || [];
			const filtered = configs.filter((c: CustomProviderConfig) => c.id !== providerId);
			deps.preferencesStore.set("customProviders", filtered);
			json({ ok: true });
		},
	},
	{
		method: "GET",
		pattern: "/api/provider-keys",
		handler: ({ deps, json }) => {
			const all = deps.preferencesStore.getAll();
			const providers = Object.keys(all)
				.filter(k => k.startsWith("providerKey.") && all[k])
				.map(k => k.slice("providerKey.".length));
			json({ providers });
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/provider-keys\/(.+)$/,
		handler: async ({ deps, params, readBody, json }) => {
			const provider = decodeURIComponent(params[1]);
			if (!provider) {
				json({ error: "Missing provider name" }, 400);
				return;
			}
			const body = await readBody();
			if (!body?.key || typeof body.key !== "string") {
				json({ error: "Missing 'key' field" }, 400);
				return;
			}
			deps.preferencesStore.set(`providerKey.${provider}`, body.key);
			json({ ok: true });
		},
	},
	{
		method: "DELETE",
		pattern: /^\/api\/provider-keys\/(.+)$/,
		handler: ({ deps, params, json }) => {
			const provider = decodeURIComponent(params[1]);
			if (!provider) {
				json({ error: "Missing provider name" }, 400);
				return;
			}
			deps.preferencesStore.remove(`providerKey.${provider}`);
			json({ ok: true });
		},
	},
	{
		method: "GET",
		pattern: "/api/aigw/status",
		handler: async ({ deps, json }) => {
			const aigwUrl = getAigwUrl(deps.preferencesStore);
			if (!aigwUrl) {
				json({ configured: false });
			} else {
				try {
					const models = await discoverAigwModels(aigwUrl);
					json({ configured: true, url: aigwUrl, models });
				} catch {
					json({ configured: true, url: aigwUrl, models: [] });
				}
			}
		},
	},
	{
		method: "POST",
		pattern: "/api/aigw/configure",
		handler: async ({ deps, readBody, json, jsonError }) => {
			const body = await readBody();
			if (!body?.url || typeof body.url !== "string") {
				json({ error: "Missing 'url' field" }, 400);
				return;
			}
			try {
				const models = await configureAigw(body.url, deps.preferencesStore);
				invalidateModelCache();
				broadcastPreferencesChanged(deps);
				json({ ok: true, models });
			} catch (err: any) {
				jsonError(502, err, { error: `Failed to configure AI Gateway: ${err.message}` });
			}
		},
	},
	{
		method: "DELETE",
		pattern: "/api/aigw/configure",
		handler: ({ deps, json }) => {
			removeAigw(deps.preferencesStore);
			invalidateModelCache();
			broadcastPreferencesChanged(deps);
			json({ ok: true });
		},
	},
	{
		method: "POST",
		pattern: "/api/aigw/test",
		handler: async ({ readBody, json, jsonError }) => {
			const body = await readBody();
			if (!body?.url || typeof body.url !== "string") {
				json({ error: "Missing 'url' field" }, 400);
				return;
			}
			try {
				const models = await discoverAigwModels(body.url);
				json({ ok: true, models });
			} catch (err: any) {
				jsonError(502, err);
			}
		},
	},
	{
		method: "POST",
		pattern: "/api/aigw/refresh",
		handler: async ({ deps, json, jsonError }) => {
			const aigwUrl = getAigwUrl(deps.preferencesStore);
			if (!aigwUrl) {
				json({ error: "No AI Gateway configured" }, 400);
				return;
			}
			try {
				const models = await configureAigw(aigwUrl, deps.preferencesStore);
				invalidateModelCache();
				broadcastPreferencesChanged(deps);
				json({ models });
			} catch (err: any) {
				jsonError(502, err);
			}
		},
	},
	{
		method: "POST",
		pattern: "/api/models/test",
		handler: async ({ deps, readBody, json, jsonError }) => {
			const body = await readBody();
			const pref = typeof body?.pref === "string" ? body.pref.trim() : "";
			if (!pref) {
				json({ ok: false, error: "Missing 'pref' field" }, 400);
				return;
			}
			const slash = pref.indexOf("/");
			if (slash <= 0) {
				json({ ok: false, error: "Malformed pref — expected 'provider/modelId'" }, 400);
				return;
			}
			const provider = pref.slice(0, slash);
			const modelId = pref.slice(slash + 1);
			try {
				const models = await getAvailableModels(deps.preferencesStore);
				const resolved = models.find((m) => m.provider === provider && m.id === modelId);
				if (!resolved) {
					json({
						ok: false,
						error: `Model "${pref}" is not in the current available-models list. It may be a stale preference.`,
					}, 404);
					return;
				}
				if (provider !== "aigw") {
					json({
						ok: false,
						modelResolved: resolved.id,
						error: "Test not supported for this provider yet — only AI Gateway models can be tested from here.",
					}, 422);
					return;
				}
				const aigwUrl = getAigwUrl(deps.preferencesStore);
				if (!aigwUrl) {
					json({ ok: false, error: "No AI Gateway configured." });
					return;
				}
				const baseUrl = aigwUrl.replace(/\/+$/, "");
				const chatUrl = baseUrl.endsWith("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;

				let sendId = modelId;
				try {
					const modelsUrl = baseUrl.endsWith("/v1") ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
					const r = await fetch(modelsUrl, { signal: AbortSignal.timeout(5000) });
					if (r.ok) {
						const data = await r.json() as { data?: Array<{ id: string }> };
						if (Array.isArray(data.data)) {
							const exact = data.data.find((m) => m.id === modelId);
							if (exact) sendId = exact.id;
							else {
								const match = data.data.find((m) => {
									const idx = m.id.indexOf("/");
									return idx >= 0 && m.id.slice(idx + 1) === modelId;
								});
								if (match) sendId = match.id;
							}
						}
					}
				} catch {
					/* keep sendId = modelId — gateway will reject if wrong */
				}
				const started = Date.now();
				try {
					const resp = await fetch(chatUrl, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							model: sendId,
							max_tokens: 5,
							messages: [
								{ role: "user", content: "Reply with OK" },
							],
						}),
						signal: AbortSignal.timeout(15000),
					});
					const latencyMs = Date.now() - started;
					if (!resp.ok) {
						const errText = (await resp.text().catch(() => "")).slice(0, 300);
						json({ ok: false, modelResolved: sendId, latencyMs, error: `Gateway ${resp.status}: ${errText || resp.statusText}` });
						return;
					}
					await resp.json().catch(() => ({}));
					json({ ok: true, modelResolved: sendId, latencyMs });
				} catch (err: any) {
					const latencyMs = Date.now() - started;
					json({ ok: false, modelResolved: sendId, latencyMs, error: err?.message || "Request failed" });
				}
			} catch (err: any) {
				jsonError(500, err, { ok: false, error: err?.message || "Test failed" });
			}
		},
	},
	{
		method: "*",
		pattern: /^\/api\/aigw\/v1\/(.*)$/,
		handler: ({ deps, req, res, url }) => {
			const aigwUrl = getAigwUrl(deps.preferencesStore);
			if (!aigwUrl) {
				// Not configured — return 404 to match legacy fall-through.
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Not found" }));
				return;
			}
			const subPath = url.pathname.replace("/api/aigw/v1/", "/v1/");
			const targetUrl = `${aigwUrl}${subPath}${url.search}`;
			proxyRequest(targetUrl, req, res);
		},
	},
];
