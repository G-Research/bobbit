/**
 * Image generation route.
 * Extracted from server.ts (commit: split server.ts).
 */
import {
	canonicalImageModelPref,
	defaultImageModelPref,
	generateImage,
	imageModelMentionedInText,
} from "../agent/image-generation.js";
import type { Route } from "./types.js";

export const imageGenerationRoutes: Route[] = [
	{
		method: "POST",
		pattern: "/api/image-generation/generate",
		handler: async ({ deps, sandboxScope, readBody, json, jsonError }) => {
			const { sessionManager, preferencesStore } = deps;
			const body = await readBody();
			if (!body || typeof body !== "object" || typeof body.prompt !== "string") {
				jsonError(400, new Error("Missing prompt"));
				return;
			}
			const MAX_PROMPT_CHARS = 8192;
			if (body.prompt.length > MAX_PROMPT_CHARS) {
				jsonError(400, new Error("prompt exceeds 8192 chars"));
				return;
			}
			let n: number | undefined;
			if (body.n !== undefined && body.n !== null) {
				if (typeof body.n !== "number" || !Number.isInteger(body.n) || body.n < 1 || body.n > 4) {
					jsonError(400, new Error("n must be 1..4"));
					return;
				}
				n = body.n;
			}
			const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
			if (sandboxScope && (!sessionId || !sandboxScope.sessionIds.has(sessionId))) {
				jsonError(403, new Error("session not in sandbox scope"));
				return;
			}
			const sessionPref = sessionId ? sessionManager.getImageModelForSession(sessionId) : undefined;
			const defaultPref = (preferencesStore.get("default.imageModel") as string | undefined) || defaultImageModelPref();
			const selectedModelRaw = sessionPref ? `${sessionPref.provider}/${sessionPref.id}` : defaultPref;
			const selectedModel = canonicalImageModelPref(selectedModelRaw) || selectedModelRaw;
			const requestedModel = typeof body.model === "string" && body.model ? canonicalImageModelPref(body.model) : undefined;
			const lastUserPrompt = sessionId ? sessionManager.getLastPromptText(sessionId) : undefined;
			const model = requestedModel
				&& (
					!sessionId
					|| requestedModel === selectedModel
					|| imageModelMentionedInText(preferencesStore, requestedModel, lastUserPrompt)
				)
				? requestedModel
				: selectedModel;
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
		},
	},
];
