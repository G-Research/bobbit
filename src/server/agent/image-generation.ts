import fs from "node:fs";

import { globalAuthPath } from "../bobbit-dir.js";
import type { PreferencesStore } from "./preferences-store.js";
import type { CustomProviderConfig } from "./model-registry.js";
import { resolveHostTokenValue } from "./host-tokens.js";

export type ImageProviderType = "openai-images" | "gemini-images" | "google-imagen";

export interface ApiImageModel {
	id: string;
	name: string;
	provider: string;
	api: ImageProviderType;
	baseUrl: string;
	authenticated: boolean;
	sizes?: string[];
	qualities?: string[];
	aspectRatios?: string[];
	formats?: string[];
}

export interface GeneratedImage {
	data: string;
	mimeType: string;
	revisedPrompt?: string;
}

export interface ImageGenerationRequest {
	prompt: string;
	model?: string;
	size?: string;
	quality?: string;
	background?: "transparent" | "opaque" | "auto";
	format?: "png" | "jpeg" | "webp";
	aspectRatio?: string;
	imageSize?: string;
	n?: number;
}

const OPENAI_IMAGE_MODELS: Omit<ApiImageModel, "authenticated">[] = [
	{
		id: "gpt-image-2",
		name: "GPT Image 2",
		provider: "openai",
		api: "openai-images",
		baseUrl: "https://api.openai.com/v1",
		sizes: ["auto", "1024x1024", "1536x1024", "1024x1536"],
		qualities: ["auto", "low", "medium", "high"],
		formats: ["png", "jpeg", "webp"],
	},
	{
		id: "gpt-image-1.5",
		name: "GPT Image 1.5",
		provider: "openai",
		api: "openai-images",
		baseUrl: "https://api.openai.com/v1",
		sizes: ["auto", "1024x1024", "1536x1024", "1024x1536"],
		qualities: ["auto", "low", "medium", "high"],
		formats: ["png", "jpeg", "webp"],
	},
	{
		id: "gpt-image-1",
		name: "GPT Image 1",
		provider: "openai",
		api: "openai-images",
		baseUrl: "https://api.openai.com/v1",
		sizes: ["auto", "1024x1024", "1536x1024", "1024x1536"],
		qualities: ["auto", "low", "medium", "high"],
		formats: ["png", "jpeg", "webp"],
	},
	{
		id: "gpt-image-1-mini",
		name: "GPT Image 1 mini",
		provider: "openai",
		api: "openai-images",
		baseUrl: "https://api.openai.com/v1",
		sizes: ["auto", "1024x1024", "1536x1024", "1024x1536"],
		qualities: ["auto", "low", "medium", "high"],
		formats: ["png", "jpeg", "webp"],
	},
	{
		id: "dall-e-3",
		name: "DALL-E 3",
		provider: "openai",
		api: "openai-images",
		baseUrl: "https://api.openai.com/v1",
		sizes: ["1024x1024", "1792x1024", "1024x1792"],
		qualities: ["standard", "hd"],
		formats: ["png"],
	},
	{
		id: "dall-e-2",
		name: "DALL-E 2",
		provider: "openai",
		api: "openai-images",
		baseUrl: "https://api.openai.com/v1",
		sizes: ["256x256", "512x512", "1024x1024"],
		formats: ["png"],
	},
];

const GEMINI_IMAGE_MODELS: Omit<ApiImageModel, "authenticated">[] = [
	{
		id: "gemini-3.1-flash-image-preview",
		name: "Gemini 3.1 Flash Image",
		provider: "google",
		api: "gemini-images",
		baseUrl: "https://generativelanguage.googleapis.com",
		aspectRatios: ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"],
	},
	{
		id: "imagen-4.0-ultra-generate-001",
		name: "Imagen 4 Ultra",
		provider: "google",
		api: "google-imagen",
		baseUrl: "https://generativelanguage.googleapis.com",
		aspectRatios: ["1:1", "3:4", "4:3", "9:16", "16:9"],
	},
	{
		id: "gemini-3-pro-image-preview",
		name: "Gemini 3 Pro Image",
		provider: "google",
		api: "gemini-images",
		baseUrl: "https://generativelanguage.googleapis.com",
		aspectRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
	},
	{
		id: "imagen-4.0-generate-001",
		name: "Imagen 4 Standard",
		provider: "google",
		api: "google-imagen",
		baseUrl: "https://generativelanguage.googleapis.com",
		aspectRatios: ["1:1", "3:4", "4:3", "9:16", "16:9"],
	},
	{
		id: "imagen-4.0-fast-generate-001",
		name: "Imagen 4 Fast",
		provider: "google",
		api: "google-imagen",
		baseUrl: "https://generativelanguage.googleapis.com",
		aspectRatios: ["1:1", "3:4", "4:3", "9:16", "16:9"],
	},
	{
		id: "gemini-2.5-flash-image",
		name: "Gemini 2.5 Flash Image",
		provider: "google",
		api: "gemini-images",
		baseUrl: "https://generativelanguage.googleapis.com",
		aspectRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
	},
];

export function parseImageModelPref(pref: string | undefined | null): { provider: string; id: string } | undefined {
	if (!pref) return undefined;
	const slash = pref.indexOf("/");
	if (slash <= 0 || slash >= pref.length - 1) return undefined;
	return { provider: pref.slice(0, slash), id: pref.slice(slash + 1) };
}

export function defaultImageModelPref(): string {
	return "openai/gpt-image-2";
}

export function getAvailableImageModels(prefs: PreferencesStore): ApiImageModel[] {
	const openaiAuth = hasOpenAIKey(prefs);
	const googleAuth = hasGoogleKey(prefs);
	const builtins: ApiImageModel[] = [
		...OPENAI_IMAGE_MODELS.map((m) => ({ ...m, authenticated: openaiAuth })),
		...GEMINI_IMAGE_MODELS.map((m) => ({ ...m, authenticated: googleAuth })),
	];

	const custom = ((prefs.get("customProviders") as CustomProviderConfig[] | undefined) || [])
		.filter((config) => config.type === "openai-images" || config.type === "gemini-images" || config.type === "google-imagen")
		.flatMap((config) => {
			const models = config.models || [];
			return models.map((m) => ({
				id: m.id,
				name: m.name || m.id,
				provider: config.name || config.id,
				api: config.type as ImageProviderType,
				baseUrl: config.baseUrl,
				authenticated: Boolean(config.apiKey) || (config.type === "openai-images" ? openaiAuth : googleAuth),
			}));
		});

	return [...builtins, ...custom];
}

export function getImageModelByPref(prefs: PreferencesStore, pref?: string | null): ApiImageModel | undefined {
	const parsed = parseImageModelPref(canonicalImageModelPref(pref || defaultImageModelPref()));
	if (!parsed) return undefined;
	return getAvailableImageModels(prefs).find((m) => m.provider === parsed.provider && m.id === parsed.id);
}

export function canonicalImageModelPref(pref: string | undefined | null): string | undefined {
	const parsed = parseImageModelPref(pref);
	if (!parsed) return pref || undefined;
	if (parsed.provider !== "google") return pref || undefined;

	const normalizedId = normalizeModelText(parsed.id);
	if (["gemini31flashimage", "gemini31flashimagepreview", "gemini3flashimage"].includes(normalizedId)) {
		return "google/gemini-3.1-flash-image-preview";
	}
	if (["nanobanana2", "nanobananapro", "gemini3proimage", "gemini3proimagepreview"].includes(normalizedId)) {
		return "google/gemini-3-pro-image-preview";
	}
	if (["nanobanana", "gemini25flashimage", "gemini25flashimagepreview"].includes(normalizedId)) {
		return "google/gemini-2.5-flash-image";
	}
	if (["imagen4ultra", "imagenultra", "imagen40ultragenerate001"].includes(normalizedId)) {
		return "google/imagen-4.0-ultra-generate-001";
	}
	if (["imagen4", "imagen4standard", "imagenstandard", "imagen40generate001"].includes(normalizedId)) {
		return "google/imagen-4.0-generate-001";
	}
	if (["imagen4fast", "imagenfast", "imagen40fastgenerate001"].includes(normalizedId)) {
		return "google/imagen-4.0-fast-generate-001";
	}
	return pref || undefined;
}

export function imageModelMentionedInText(prefs: PreferencesStore, pref: string | undefined | null, text: string | undefined | null): boolean {
	const parsed = parseImageModelPref(canonicalImageModelPref(pref));
	if (!parsed || !text) return false;
	const haystack = normalizeModelText(text);
	if (!haystack) return false;

	const model = getImageModelByPref(prefs, `${parsed.provider}/${parsed.id}`);
	const aliases = [
		`${parsed.provider}/${parsed.id}`,
		parsed.provider,
		parsed.id,
		model?.name,
		...wellKnownModelAliases(parsed.provider, parsed.id),
	];
	return aliases.some((alias) => {
		const normalized = normalizeModelText(alias);
		return normalized.length > 0 && haystack.includes(normalized);
	});
}

export async function generateImage(prefs: PreferencesStore, request: ImageGenerationRequest): Promise<{ model: ApiImageModel; images: GeneratedImage[] }> {
	if (!request.prompt || typeof request.prompt !== "string") {
		throw new Error("prompt is required");
	}
	const model = getImageModelByPref(prefs, request.model) || getImageModelByPref(prefs, defaultImageModelPref());
	if (!model) throw new Error("No image generation model is configured");
	if (model.api === "openai-images") {
		const images = await generateOpenAIImage(prefs, model, request);
		return { model, images };
	}
	if (model.api === "gemini-images") {
		const images = await generateGeminiImage(prefs, model, request);
		return { model, images };
	}
	if (model.api === "google-imagen") {
		const images = await generateImagenImage(prefs, model, request);
		return { model, images };
	}
	throw new Error(`Unsupported image provider: ${model.api}`);
}

async function generateOpenAIImage(prefs: PreferencesStore, model: ApiImageModel, request: ImageGenerationRequest): Promise<GeneratedImage[]> {
	const apiKey = getOpenAIImageApiKey(prefs);
	if (!apiKey) {
		const codexToken = getOpenAICodexOAuthCredential();
		if (codexToken) {
			return generateOpenAICodexImage(codexToken, model, request);
		}
		throw new Error("Missing OpenAI API key for image generation");
	}
	const isGptImage = model.id.startsWith("gpt-image");
	const format = request.format || "png";
	const body: Record<string, unknown> = {
		model: model.id,
		prompt: request.prompt,
		n: Math.min(Math.max(request.n || 1, 1), 4),
	};
	if (request.size) body.size = request.size;
	if (request.quality) body.quality = request.quality;
	if (isGptImage) {
		if (request.background) body.background = request.background;
		if (format) body.output_format = format;
	} else {
		body.response_format = "b64_json";
	}

	const resp = await fetch(`${trimSlash(model.baseUrl)}/images/generations`, {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const data: any = await resp.json().catch(() => ({}));
	if (!resp.ok) {
		throw new Error(data?.error?.message || data?.error || `OpenAI image request failed: ${resp.status}`);
	}
	const rows = Array.isArray(data?.data) ? data.data : [];
	const images: GeneratedImage[] = [];
	for (const row of rows) {
		if (row?.b64_json) {
			images.push({ data: row.b64_json, mimeType: `image/${format}`, revisedPrompt: row.revised_prompt });
		} else if (row?.url) {
			images.push(await imageFromUrl(row.url, row.revised_prompt));
		}
	}
	if (images.length === 0) throw new Error("Image provider returned no image data");
	return images;
}

async function generateOpenAICodexImage(token: string, imageModel: ApiImageModel, request: ImageGenerationRequest): Promise<GeneratedImage[]> {
	const accountId = getCodexAccountId(token);
	const format = request.format || "png";
	const imageTool: Record<string, unknown> = {
		type: "image_generation",
		model: imageModel.id,
	};
	if (request.size) imageTool.size = request.size;
	if (request.quality) imageTool.quality = request.quality;
	if (request.background) imageTool.background = request.background;
	if (format) imageTool.output_format = format;

	const body = {
		model: getCodexImageDriverModel(),
		store: false,
		stream: true,
		instructions: "Generate the requested image using the image_generation tool. Return exactly one image unless the request explicitly asks for more.",
		input: [{
			role: "user",
			content: [{ type: "input_text", text: request.prompt }],
		}],
		tools: [imageTool],
		tool_choice: "auto",
	};

	const resp = await fetch("https://chatgpt.com/backend-api/codex/responses", {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${token}`,
			"chatgpt-account-id": accountId,
			"originator": "pi",
			"OpenAI-Beta": "responses=experimental",
			"accept": "text/event-stream",
			"content-type": "application/json",
			"User-Agent": "pi (bobbit image generation)",
		},
		body: JSON.stringify(body),
	});
	const text = await resp.text();
	if (!resp.ok) {
		throw new Error(parseCodexError(text) || `OpenAI Codex image request failed: ${resp.status}`);
	}
	const images = parseCodexImageEvents(text, format);
	if (images.length === 0) {
		throw new Error(parseCodexError(text) || "OpenAI Codex image provider returned no image data");
	}
	return images.slice(0, Math.min(Math.max(request.n || 1, 1), 4));
}

async function generateGeminiImage(prefs: PreferencesStore, model: ApiImageModel, request: ImageGenerationRequest): Promise<GeneratedImage[]> {
	const apiKey = getImageProviderKey(prefs, model);
	if (!apiKey) throw new Error(`Missing API key for ${model.provider}`);
	const generationConfig: Record<string, unknown> = {
		responseModalities: ["TEXT", "IMAGE"],
	};
	if (request.aspectRatio || request.imageSize) {
		generationConfig.imageConfig = {
			...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
			...(request.imageSize ? { imageSize: request.imageSize } : {}),
		};
	}
	const body: Record<string, unknown> = {
		contents: [{ parts: [{ text: request.prompt }] }],
		generationConfig,
	};

	const base = model.baseUrl.includes("/models/")
		? trimSlash(model.baseUrl)
		: `${trimSlash(model.baseUrl)}/v1beta/models/${encodeURIComponent(model.id)}:generateContent`;
	const resp = await fetch(base, {
		method: "POST",
		headers: {
			"x-goog-api-key": apiKey,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const data: any = await resp.json().catch(() => ({}));
	if (!resp.ok) {
		throw new Error(data?.error?.message || data?.error || `Gemini image request failed: ${resp.status}`);
	}
	const parts = data?.candidates?.[0]?.content?.parts || data?.parts || [];
	const images = parts
		.map((part: any) => part.inlineData || part.inline_data)
		.filter((inline: any) => inline?.data)
		.map((inline: any) => ({ data: inline.data, mimeType: inline.mimeType || inline.mime_type || "image/png" }));
	if (images.length === 0) throw new Error("Image provider returned no image data");
	return images;
}

async function generateImagenImage(prefs: PreferencesStore, model: ApiImageModel, request: ImageGenerationRequest): Promise<GeneratedImage[]> {
	const apiKey = getImageProviderKey(prefs, model);
	if (!apiKey) throw new Error(`Missing API key for ${model.provider}`);
	const parameters: Record<string, unknown> = {
		sampleCount: Math.min(Math.max(request.n || 1, 1), 4),
	};
	if (request.aspectRatio) parameters.aspectRatio = request.aspectRatio;
	if (request.imageSize) parameters.imageSize = request.imageSize;
	const body: Record<string, unknown> = {
		instances: [{ prompt: request.prompt }],
		parameters,
	};
	const base = model.baseUrl.includes("/models/")
		? trimSlash(model.baseUrl)
		: `${trimSlash(model.baseUrl)}/v1beta/models/${encodeURIComponent(model.id)}:predict`;
	const resp = await fetch(base, {
		method: "POST",
		headers: {
			"x-goog-api-key": apiKey,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const data: any = await resp.json().catch(() => ({}));
	if (!resp.ok) {
		throw new Error(data?.error?.message || data?.error || `Imagen request failed: ${resp.status}`);
	}
	const rows = Array.isArray(data?.predictions) ? data.predictions : [];
	const images = rows
		.map((row: any) => row?.bytesBase64Encoded || row?.image?.bytesBase64Encoded || row?.encodedImage)
		.filter((encoded: any) => typeof encoded === "string" && encoded)
		.map((encoded: string) => ({ data: encoded, mimeType: "image/png" }));
	if (images.length === 0) throw new Error("Image provider returned no image data");
	return images;
}

function getImageProviderKey(prefs: PreferencesStore, model: ApiImageModel): string | undefined {
	if (model.provider === "openai") return getOpenAIImageApiKey(prefs) || getOpenAICodexOAuthCredential();
	if (model.provider === "google") {
		return getGoogleImageCredential(prefs);
	}
	const configs = (prefs.get("customProviders") as CustomProviderConfig[] | undefined) || [];
	const config = configs.find((c) => (c.name || c.id) === model.provider && c.id === model.provider)
		|| configs.find((c) => (c.name || c.id) === model.provider);
	if (config?.apiKey) return config.apiKey;
	return model.api === "openai-images"
		? getOpenAIImageApiKey(prefs)
		: getGoogleImageCredential(prefs);
}

function hasOpenAIKey(prefs: PreferencesStore): boolean {
	return Boolean(getOpenAIImageApiKey(prefs) || getOpenAICodexOAuthCredential());
}

function hasGoogleKey(prefs: PreferencesStore): boolean {
	return Boolean(getGoogleImageCredential(prefs));
}

function getOpenAIImageApiKey(prefs: PreferencesStore): string | undefined {
	return firstNonEmpty(
		prefs.get("providerKey.openai") as string | undefined,
		prefs.get("providerKey.openai-codex") as string | undefined,
		process.env.OPENAI_API_KEY,
		readAuthApiKey("openai"),
		readAuthApiKey("openai-codex"),
	);
}

function getOpenAICodexOAuthCredential(): string | undefined {
	const openai = readAuthProvider("openai");
	const codex = readAuthProvider("openai-codex");
	return firstNonEmpty(
		openai?.type === "oauth" ? openai.access : undefined,
		codex?.type === "oauth" ? codex.access : undefined,
	);
}

function getGoogleImageCredential(prefs: PreferencesStore): string | undefined {
	return firstNonEmpty(
		prefs.get("providerKey.google") as string | undefined,
		prefs.get("providerKey.google-gemini-cli") as string | undefined,
		process.env.GEMINI_API_KEY,
		process.env.GOOGLE_API_KEY,
		resolveHostTokenValue("GEMINI_API_KEY", prefs),
		readAuthApiKey("google"),
		readAuthApiKey("google-gemini-cli"),
	);
}

function readAuthApiKey(provider: string): string | undefined {
	try {
		const providerData = readAuthProvider(provider);
		if (!providerData || typeof providerData !== "object") return undefined;
		return firstNonEmpty(
			providerData.type === "api_key" ? providerData.key : undefined,
			providerData.key,
		);
	} catch {
		return undefined;
	}
}

function readAuthProvider(provider: string): any | undefined {
	try {
		const authPath = globalAuthPath();
		if (!fs.existsSync(authPath)) return undefined;
		const data = JSON.parse(fs.readFileSync(authPath, "utf-8"));
		return data?.[provider];
	} catch {
		return undefined;
	}
}

function getCodexAccountId(token: string): string {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"));
		const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		if (typeof accountId === "string" && accountId) return accountId;
	} catch { /* fall through */ }
	throw new Error("OpenAI Codex image generation failed: could not resolve ChatGPT account id from the saved OpenAI sign-in");
}

function getCodexImageDriverModel(): string {
	return process.env.BOBBIT_OPENAI_CODEX_IMAGE_DRIVER_MODEL || "gpt-5.5";
}

function parseCodexImageEvents(sseText: string, format: string): GeneratedImage[] {
	const images: GeneratedImage[] = [];
	for (const line of sseText.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const raw = line.slice(5).trim();
		if (!raw || raw === "[DONE]") continue;
		try {
			const event = JSON.parse(raw);
			const item = event.item;
			if (item?.type === "image_generation_call") {
				const result = item.result || item.image || item.output;
				if (typeof result === "string" && result) {
					images[0] = { data: stripDataUrlPrefix(result), mimeType: `image/${format}` };
				}
			}
			const partial = event.partial_image_b64 || event.partial_image || event.image;
			if (images.length === 0 && event.type === "response.image_generation_call.partial_image" && typeof partial === "string" && partial) {
				images[0] = { data: stripDataUrlPrefix(partial), mimeType: `image/${format}` };
			}
		} catch { /* ignore malformed SSE chunks */ }
	}
	return images;
}

function parseCodexError(sseText: string): string | undefined {
	for (const line of sseText.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const raw = line.slice(5).trim();
		if (!raw || raw === "[DONE]") continue;
		try {
			const event = JSON.parse(raw);
			const message = event.message || event.error?.message || event.response?.error?.message;
			if ((event.type === "error" || event.type === "response.failed") && message) return message;
		} catch { /* ignore malformed SSE chunks */ }
	}
	return undefined;
}

function stripDataUrlPrefix(value: string): string {
	const comma = value.indexOf(",");
	return value.startsWith("data:") && comma >= 0 ? value.slice(comma + 1) : value;
}

function firstNonEmpty(...values: Array<unknown>): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function normalizeModelText(value: unknown): string {
	return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]+/g, "") : "";
}

function wellKnownModelAliases(provider: string, id: string): string[] {
	if (provider === "openai" && id === "gpt-image-2") {
		return ["gpt image 2", "chatgpt image 2", "chatgpt images 2", "chatgpt images 2.0", "openai image 2"];
	}
	if (provider === "openai" && id.startsWith("gpt-image")) {
		return ["gpt image", "chatgpt image", "chatgpt images"];
	}
	if (provider === "openai" && id.startsWith("dall-e")) {
		return ["dall e", "dalle"];
	}
	if (provider === "google" && id === "gemini-3.1-flash-image-preview") {
		return ["gemini 3.1 flash image", "gemini 3 flash image", "gemini image", "gemini"];
	}
	if (provider === "google" && id === "gemini-3-pro-image-preview") {
		return ["nano banana pro", "nano banana 2", "gemini 3 pro image", "gemini pro image", "gemini"];
	}
	if (provider === "google" && id === "gemini-2.5-flash-image") {
		return ["nano banana", "gemini 2.5 flash image", "gemini image", "gemini"];
	}
	if (provider === "google" && id === "imagen-4.0-ultra-generate-001") {
		return ["imagen 4 ultra", "imagen ultra"];
	}
	if (provider === "google" && id === "imagen-4.0-generate-001") {
		return ["imagen 4 standard", "imagen 4", "imagen standard"];
	}
	if (provider === "google" && id === "imagen-4.0-fast-generate-001") {
		return ["imagen 4 fast", "imagen fast"];
	}
	return [];
}

async function imageFromUrl(url: string, revisedPrompt?: string): Promise<GeneratedImage> {
	const resp = await fetch(url);
	if (!resp.ok) throw new Error(`Failed to download generated image: ${resp.status}`);
	const arrayBuffer = await resp.arrayBuffer();
	const mimeType = resp.headers.get("content-type")?.split(";")[0] || "image/png";
	return { data: Buffer.from(arrayBuffer).toString("base64"), mimeType, revisedPrompt };
}

function trimSlash(s: string): string {
	return s.replace(/\/+$/, "");
}
