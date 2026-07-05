// src/server/routes/model-provider-routes.ts
//
// STR-01 cohort 15: Model/provider settings routes migrated out of
// handleApiRoute's legacy if/else chain into the core route registry. See
// docs/design/route-registry.md.
//
// Mechanical extraction — handler bodies below preserve the legacy behavior,
// with only handleApiRoute locals destructured from ctx.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed. Exact legacy
// blocks gated on path and method together. The legacy startsWith provider-key
// and custom-provider delete routes are registered as method-scoped prefix
// routes to preserve the original full-suffix capture behavior.

import path from "node:path";
import { configureAigw, discoverAigwModels, removeAigw } from "../agent/aigw-manager.js";
import { getClaudeCodeStatus, invalidateClaudeCodeStatusCache } from "../agent/claude-code-status.js";
import { normalizeConfigProjectId } from "../agent/config-cascade.js";
import { canonicalImageModelPref, defaultImageModelPref, generateImage, getAvailableImageModels } from "../agent/image-generation.js";
import { testModelPreference, testProviderApiKey } from "../agent/model-completion.js";
import {
	baseUrlsMatchForStoredKey,
	discoverModelsForConfig,
	getAvailableModels,
	getBuiltInProviderIds,
	invalidateModelCache,
	probeOpenAICompatModels,
	redactCustomProviderConfig,
	removeCustomProviderModelsJsonEntry,
	syncCustomProviderModelsJson,
	type CustomProviderConfig,
} from "../agent/model-registry.js";
import type { ProjectConfigStore } from "../agent/project-config-store.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

function resolveClaudeCodeStatusConfigStore(
	ctx: CoreRouteCtx,
): { ok: true; store?: ProjectConfigStore; projectId?: string } | { ok: false; status: number; error: string } {
	const { projectContextManager, projectRegistry, url } = ctx;
	const projectId = normalizeConfigProjectId(url.searchParams.get("projectId") || undefined);
	if (projectId) {
		const projectCtx = projectContextManager.getOrCreate(projectId);
		if (!projectCtx) return { ok: false, status: 404, error: "Project not found" };
		return { ok: true, store: projectCtx.projectConfigStore, projectId };
	}
	const cwd = url.searchParams.get("cwd") || undefined;
	if (cwd) {
		const resolvedCwd = path.resolve(cwd);
		const matches = projectRegistry.list()
			.filter(project => !project.hidden)
			.map(project => ({ project, root: path.resolve(project.rootPath) }))
			.filter(({ root }) => resolvedCwd === root || resolvedCwd.startsWith(root + path.sep))
			.sort((a, b) => b.root.length - a.root.length);
		if (matches[0]) {
			const projectCtx = projectContextManager.getOrCreate(matches[0].project.id);
			if (projectCtx) return { ok: true, store: projectCtx.projectConfigStore, projectId: projectCtx.project.id };
		}
	}
	return { ok: true };
}

// GET /api/claude-code/status — local Claude Code CLI readiness probe.
async function handleClaudeCodeStatusGet(ctx: CoreRouteCtx): Promise<void> {
	const { json, jsonError, preferencesStore } = ctx;
	const scoped = resolveClaudeCodeStatusConfigStore(ctx);
	if (!scoped.ok) { json({ error: scoped.error }, scoped.status); return; }
	try {
		json(await getClaudeCodeStatus(preferencesStore, scoped.store ?? null));
	} catch (err: any) {
		jsonError(500, err, { error: `Failed to probe Claude Code: ${err.message}` });
	}
	return;
}

// POST /api/claude-code/status/refresh — clear cached status and re-probe.
async function handleClaudeCodeStatusRefresh(ctx: CoreRouteCtx): Promise<void> {
	const { json, jsonError, preferencesStore } = ctx;
	const scoped = resolveClaudeCodeStatusConfigStore(ctx);
	if (!scoped.ok) { json({ error: scoped.error }, scoped.status); return; }
	try {
		invalidateClaudeCodeStatusCache();
		invalidateModelCache();
		json(await getClaudeCodeStatus(preferencesStore, scoped.store ?? null));
	} catch (err: any) {
		jsonError(500, err, { error: `Failed to probe Claude Code: ${err.message}` });
	}
	return;
}

// GET /api/models — unified model list from all sources.
async function handleModelsGet(ctx: CoreRouteCtx): Promise<void> {
	const { json, jsonError, preferencesStore } = ctx;
	const scoped = resolveClaudeCodeStatusConfigStore(ctx);
	if (!scoped.ok) { json({ error: scoped.error }, scoped.status); return; }
	try {
		const models = await getAvailableModels(preferencesStore, scoped.store ?? null);
		json(models);
	} catch (err: any) {
		jsonError(500, err, { error: `Failed to load models: ${err.message}` });
	}
	return;
}

// GET /api/image-models — image generation model list.
async function handleImageModelsGet(ctx: CoreRouteCtx): Promise<void> {
	const { json, jsonError, preferencesStore } = ctx;
	try {
		json(getAvailableImageModels(preferencesStore));
	} catch (err: any) {
		jsonError(500, err, { error: `Failed to load image models: ${err.message}` });
	}
	return;
}

// POST /api/image-generation/generate — gateway-side image generation for the generate_image tool.
async function handleImageGenerationGenerate(ctx: CoreRouteCtx): Promise<void> {
	const { json, jsonError, preferencesStore, readBody, req, sandboxScope, sessionManager } = ctx;
	const body = await readBody(req);
	if (!body || typeof body !== "object" || typeof body.prompt !== "string") {
		json({ error: "Missing prompt" }, 400);
		return;
	}
	const MAX_PROMPT_CHARS = 8192;
	if (body.prompt.length > MAX_PROMPT_CHARS) {
		json({ error: "prompt exceeds 8192 chars" }, 400);
		return;
	}
	// Clamp `n` to integer in [1,4]; reject non-integers / out-of-range.
	let n: number | undefined;
	if (body.n !== undefined && body.n !== null) {
		if (typeof body.n !== "number" || !Number.isInteger(body.n) || body.n < 1 || body.n > 4) {
			json({ error: "n must be 1..4" }, 400);
			return;
		}
		n = body.n;
	}
	const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
	// Sandbox guard: callers under a sandbox-scoped token must identify a
	// session in their scope. Without sessionId we cannot prove ownership,
	// so refuse rather than silently broadcasting credentials.
	if (sandboxScope && (!sessionId || !sandboxScope.sessionIds.has(sessionId))) {
		json({ error: "session not in sandbox scope" }, 403);
		return;
	}
	const sessionPref = sessionId ? sessionManager.getImageModelForSession(sessionId) : undefined;
	const defaultPref = (preferencesStore.get("default.imageModel") as string | undefined) || defaultImageModelPref();
	const selectedModelRaw = sessionPref ? `${sessionPref.provider}/${sessionPref.id}` : defaultPref;
	// Selector / settings default is the single source of truth. body.model is ignored
	// on purpose — never reintroduce a tool- or prompt-driven model override.
	const model = canonicalImageModelPref(selectedModelRaw) || selectedModelRaw;
	try {
		const result = await generateImage(preferencesStore, {
			prompt: body.prompt,
			model,
			size: typeof body.size === "string" ? body.size : undefined,
			quality: typeof body.quality === "string" ? body.quality : undefined,
			background: typeof body.background === "string" ? body.background : undefined,
			format: typeof body.format === "string" ? body.format : undefined,
			aspectRatio: typeof body.aspectRatio === "string" ? body.aspectRatio : undefined,
			imageSize: typeof body.imageSize === "string" ? body.imageSize : undefined,
			n,
		});
		json({
			model: { provider: result.model.provider, id: result.model.id, name: result.model.name, api: result.model.api },
			images: result.images,
		});
	} catch (err: any) {
		jsonError(500, err);
	}
	return;
}

// GET /api/custom-providers — list all custom provider configs.
async function handleCustomProvidersGet(ctx: CoreRouteCtx): Promise<void> {
	const { json, preferencesStore } = ctx;
	const configs = (preferencesStore.get("customProviders") as CustomProviderConfig[] | undefined) || [];
	json(configs.map(redactCustomProviderConfig));
	return;
}

// POST /api/custom-providers/test — discover models without persisting.
async function handleCustomProvidersTest(ctx: CoreRouteCtx): Promise<void> {
	const { json, jsonError, preferencesStore, readBody, req } = ctx;
	const body = await readBody(req);
	if (!body || !body.type || !body.baseUrl) {
		json({ error: "Missing required fields: type, baseUrl" }, 400);
		return;
	}
	let testApiKey: string | undefined = typeof body.apiKey === "string" && body.apiKey ? body.apiKey : undefined;
	if (!testApiKey && body.id) {
		const stored = (preferencesStore.get("customProviders") as CustomProviderConfig[] | undefined)?.find(
			(c: CustomProviderConfig) => c.id === body.id,
		);
		if (stored?.apiKey && baseUrlsMatchForStoredKey(stored.baseUrl, body.baseUrl)) {
			testApiKey = stored.apiKey;
		}
	}
	const config: CustomProviderConfig = {
		id: body.id || "test-" + Date.now(),
		name: body.name || body.type,
		type: body.type,
		baseUrl: body.baseUrl,
		...(testApiKey ? { apiKey: testApiKey } : {}),
	};
	try {
		// manual/openai-completions have no discovery source — discoverModelsForConfig
		// just echoes the (here, empty) static model list. Test Connection's whole
		// point is validating reachability + auth against the REAL remote endpoint
		// (e.g. NVIDIA NIM's /v1/models), so probe it directly. probeOpenAICompatModels
		// throws on failure (unlike best-effort production discovery) so auth errors,
		// timeouts, and unreachable hosts surface as distinct messages instead of a
		// silent "0 models" that looks identical to "connected, nothing configured".
		const isOpenAICompatManual = config.type === "manual" || config.type === "openai-completions";
		const models = isOpenAICompatManual
			? await probeOpenAICompatModels(config)
			: await discoverModelsForConfig(config);
		json({ models });
	} catch (err: any) {
		jsonError(502, err);
	}
	return;
}

// POST /api/custom-providers — add or update a custom provider config.
async function handleCustomProvidersPost(ctx: CoreRouteCtx): Promise<void> {
	const { json, preferencesStore, readBody, req } = ctx;
	const body = await readBody(req);
	if (!body || !body.id || !body.type || !body.baseUrl) {
		json({ error: "Missing required fields: id, type, baseUrl" }, 400);
		return;
	}
	const configs = (preferencesStore.get("customProviders") as CustomProviderConfig[] | undefined) || [];
	const existing = configs.findIndex((c: CustomProviderConfig) => c.id === body.id);
	// apiKey write semantics (pinned by tests/e2e/custom-provider-key-redaction.spec.ts):
	//   - non-empty string -> set/replace the stored key
	//   - explicit null    -> clear the stored key
	//   - omitted or ""    -> PRESERVE the previously stored key. The read
	//     path never returns the key, so the edit dialog resubmits without
	//     it — an unrelated edit (rename, baseUrl change) must not wipe or
	//     mask-overwrite the secret. Never reintroduce blind overwrite here.
	const priorApiKey = existing >= 0 ? configs[existing].apiKey : undefined;
	const nextApiKey: string | undefined =
		typeof body.apiKey === "string" && body.apiKey !== "" ? body.apiKey : body.apiKey === null ? undefined : priorApiKey;
	const config: CustomProviderConfig = {
		id: body.id,
		name: body.name || body.id,
		type: body.type,
		baseUrl: body.baseUrl,
		...(nextApiKey ? { apiKey: nextApiKey } : {}),
		...(body.models ? { models: body.models } : {}),
	};
	if (existing >= 0) {
		configs[existing] = config;
	} else {
		configs.push(config);
	}
	preferencesStore.set("customProviders", configs);
	// Mirror this config into ~/.bobbit/agent/models.json so the spawned
	// pi-coding-agent runtime (which has its own model registry, separate
	// from getAvailableModels()) can actually resolve set_model() for it —
	// otherwise the model shows up "authenticated" in the picker but every
	// session that selects it fails at spawn. Best-effort: a discovery
	// failure here shouldn't fail the save (the config is still persisted
	// and will be retried on next server startup / provider save).
	try {
		await syncCustomProviderModelsJson(preferencesStore);
	} catch (err) {
		console.error(`[custom-providers] Failed to sync "${config.name}" to models.json:`, err);
	}
	// Echo redacted — the raw key must never ride any response, including
	// the save acknowledgement.
	json({ ok: true, config: redactCustomProviderConfig(config) });
	return;
}

// DELETE /api/custom-providers/* — remove a custom provider config.
async function handleCustomProviderDelete(ctx: CoreRouteCtx): Promise<void> {
	const { json, preferencesStore, url } = ctx;
	const providerId = decodeURIComponent(url.pathname.slice("/api/custom-providers/".length));
	if (!providerId) {
		json({ error: "Missing provider id" }, 400);
		return;
	}
	const configs = (preferencesStore.get("customProviders") as CustomProviderConfig[] | undefined) || [];
	const removed = configs.find((c: CustomProviderConfig) => c.id === providerId);
	const filtered = configs.filter((c: CustomProviderConfig) => c.id !== providerId);
	preferencesStore.set("customProviders", filtered);
	if (removed) {
		try {
			await removeCustomProviderModelsJsonEntry(removed);
		} catch (err) {
			console.error(`[custom-providers] Failed to remove "${removed.name}" from models.json:`, err);
		}
	}
	json({ ok: true });
	return;
}

// GET /api/pi-ai/providers — list built-in pi-ai provider ids without exposing the browser to pi-ai's Node-only index.
async function handlePiAiProvidersGet(ctx: CoreRouteCtx): Promise<void> {
	ctx.json({ providers: getBuiltInProviderIds() });
	return;
}

// POST /api/pi-ai/provider-key-test — test a provider key without persisting it.
async function handlePiAiProviderKeyTest(ctx: CoreRouteCtx): Promise<void> {
	const { json, readBody, req } = ctx;
	const body = await readBody(req);
	const provider = typeof body?.provider === "string" ? body.provider.trim() : "";
	const modelId = typeof body?.modelId === "string" ? body.modelId.trim() : "";
	const key = typeof body?.key === "string" ? body.key.trim() : "";
	const result = await testProviderApiKey(provider, modelId, key);
	json(result, result.status || (result.ok ? 200 : 502));
	return;
}

// GET /api/provider-keys — list providers that have keys set (no key values).
async function handleProviderKeysGet(ctx: CoreRouteCtx): Promise<void> {
	const { json, preferencesStore } = ctx;
	const all = preferencesStore.getAll();
	const providers = Object.keys(all)
		.filter(k => k.startsWith("providerKey.") && all[k])
		.map(k => k.slice("providerKey.".length));
	json({ providers });
	return;
}

// POST /api/provider-keys/* — store a provider API key.
async function handleProviderKeyPost(ctx: CoreRouteCtx): Promise<void> {
	const { json, preferencesStore, readBody, req, url } = ctx;
	const provider = decodeURIComponent(url.pathname.slice("/api/provider-keys/".length));
	if (!provider) {
		json({ error: "Missing provider name" }, 400);
		return;
	}
	const body = await readBody(req);
	if (!body?.key || typeof body.key !== "string") {
		json({ error: "Missing 'key' field" }, 400);
		return;
	}
	preferencesStore.set(`providerKey.${provider}`, body.key);
	json({ ok: true });
	return;
}

// DELETE /api/provider-keys/* — remove a provider API key.
async function handleProviderKeyDelete(ctx: CoreRouteCtx): Promise<void> {
	const { json, preferencesStore, url } = ctx;
	const provider = decodeURIComponent(url.pathname.slice("/api/provider-keys/".length));
	if (!provider) {
		json({ error: "Missing provider name" }, 400);
		return;
	}
	preferencesStore.remove(`providerKey.${provider}`);
	json({ ok: true });
	return;
}

// GET /api/aigw/status — check if aigw is configured.
async function handleAigwStatusGet(ctx: CoreRouteCtx): Promise<void> {
	const { getAigwUrl, json, preferencesStore } = ctx;
	const aigwUrl = getAigwUrl(preferencesStore);
	if (!aigwUrl) {
		json({ configured: false });
	} else {
		// Discover fresh models instead of reading from preferences cache
		try {
			const models = await discoverAigwModels(aigwUrl);
			json({ configured: true, url: aigwUrl, models });
		} catch {
			json({ configured: true, url: aigwUrl, models: [] });
		}
	}
	return;
}

// POST /api/aigw/configure — set aigw URL, discover models, write models.json.
async function handleAigwConfigurePost(ctx: CoreRouteCtx): Promise<void> {
	const { broadcastPreferencesChanged, json, jsonError, preferencesStore, readBody, req } = ctx;
	const body = await readBody(req);
	if (!body?.url || typeof body.url !== "string") {
		json({ error: "Missing 'url' field" }, 400);
		return;
	}
	try {
		const models = await configureAigw(body.url, preferencesStore);
		invalidateModelCache();
		broadcastPreferencesChanged();
		json({ ok: true, models });
	} catch (err: any) {
		jsonError(502, err, { error: `Failed to configure AI Gateway: ${err.message}` });
	}
	return;
}

// DELETE /api/aigw/configure — remove aigw config.
async function handleAigwConfigureDelete(ctx: CoreRouteCtx): Promise<void> {
	const { broadcastPreferencesChanged, json, preferencesStore } = ctx;
	await removeAigw(preferencesStore);
	invalidateModelCache();
	broadcastPreferencesChanged();
	json({ ok: true });
	return;
}

// POST /api/aigw/test — test connection to a URL without saving.
async function handleAigwTestPost(ctx: CoreRouteCtx): Promise<void> {
	const { json, jsonError, readBody, req } = ctx;
	const body = await readBody(req);
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
	return;
}

// POST /api/aigw/refresh — re-discover models from the configured gateway.
async function handleAigwRefreshPost(ctx: CoreRouteCtx): Promise<void> {
	const { broadcastPreferencesChanged, getAigwUrl, json, jsonError, preferencesStore } = ctx;
	const aigwUrl = getAigwUrl(preferencesStore);
	if (!aigwUrl) {
		json({ error: "No AI Gateway configured" }, 400);
		return;
	}
	try {
		const models = await configureAigw(aigwUrl, preferencesStore);
		invalidateModelCache();
		broadcastPreferencesChanged();
		json({ models });
	} catch (err: any) {
		jsonError(502, err);
	}
	return;
}

// POST /api/models/test — verify that a default-model preference resolves and responds.
async function handleModelsTestPost(ctx: CoreRouteCtx): Promise<void> {
	const { getAigwUrl, json, jsonError, preferencesStore, readBody, req } = ctx;
	const body = await readBody(req);
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
		const models = await getAvailableModels(preferencesStore);
		const resolved = models.find((m) => m.provider === provider && m.id === modelId);
		if (!resolved) {
			json({
				ok: false,
				error: `Model "${pref}" is not in the current available-models list. It may be a stale preference.`,
			}, 404);
			return;
		}
		if (provider !== "aigw") {
			const result = await testModelPreference(preferencesStore, pref);
			json(result, result.status || (result.ok ? 200 : 502));
			return;
		}
		const aigwUrl = getAigwUrl(preferencesStore);
		if (!aigwUrl) {
			json({ ok: false, error: "No AI Gateway configured." });
			return;
		}
		const baseUrl = aigwUrl.replace(/\/+$/, "");
		const chatUrl = baseUrl.endsWith("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;

		// The aigw registry strips the provider prefix (e.g. "aws/") from Claude
		// model IDs; reconstruct the full ID by querying the gateway's /v1/models.
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
			// Best-effort parse; we don't require specific text content—just a successful round-trip.
			await resp.json().catch(() => ({}));
			json({ ok: true, modelResolved: sendId, latencyMs });
		} catch (err: any) {
			const latencyMs = Date.now() - started;
			json({ ok: false, modelResolved: sendId, latencyMs, error: err?.message || "Request failed" });
		}
	} catch (err: any) {
		jsonError(500, err, { ok: false, error: err?.message || "Test failed" });
	}
	return;
}

export function registerModelProviderRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/claude-code/status", handleClaudeCodeStatusGet);
	table.register("POST", "/api/claude-code/status/refresh", handleClaudeCodeStatusRefresh);
	table.register("GET", "/api/models", handleModelsGet);
	table.register("POST", "/api/models/test", handleModelsTestPost);
	table.register("GET", "/api/image-models", handleImageModelsGet);
	table.register("POST", "/api/image-generation/generate", handleImageGenerationGenerate);
	table.register("GET", "/api/custom-providers", handleCustomProvidersGet);
	table.register("POST", "/api/custom-providers/test", handleCustomProvidersTest);
	table.register("POST", "/api/custom-providers", handleCustomProvidersPost);
	table.register("DELETE", "/api/custom-providers/*", handleCustomProviderDelete);
	table.register("GET", "/api/pi-ai/providers", handlePiAiProvidersGet);
	table.register("POST", "/api/pi-ai/provider-key-test", handlePiAiProviderKeyTest);
	table.register("GET", "/api/provider-keys", handleProviderKeysGet);
	table.register("POST", "/api/provider-keys/*", handleProviderKeyPost);
	table.register("DELETE", "/api/provider-keys/*", handleProviderKeyDelete);
	table.register("GET", "/api/aigw/status", handleAigwStatusGet);
	table.register("POST", "/api/aigw/configure", handleAigwConfigurePost);
	table.register("DELETE", "/api/aigw/configure", handleAigwConfigureDelete);
	table.register("POST", "/api/aigw/test", handleAigwTestPost);
	table.register("POST", "/api/aigw/refresh", handleAigwRefreshPost);
}
