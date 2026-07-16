/**
 * AI Gateway (aigw) manager — handles model discovery, models.json generation,
 * and HTTP proxying for browser-side API access.
 *
 * When the user configures an aigw URL in preferences:
 * 1. Server fetches available models from the gateway's /v1/models endpoint
 * 2. Server writes/merges an "aigw" provider into ~/.bobbit/agent/models.json
 *    so agent subprocesses can use `set_model` with provider="aigw"
 * 3. Browser discovers models via server proxy (the aigw hostname may not
 *    resolve from the browser)
 *
 * When aigw is removed, the "aigw" provider is cleaned from models.json.
 */

import http from "node:http";
import https from "node:https";
import dnsCallback from "node:dns";
import dns from "node:dns/promises";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { bobbitStateDir, globalAgentDir } from "../bobbit-dir.js";
import { BOBBIT_AIGW_USER_AGENT, aigwUserAgentHeaders } from "./aigw-user-agent.js";
import type { PreferencesStore } from "./preferences-store.js";

// ── Types ──────────────────────────────────────────────────────────

export interface AigwModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface AigwModel {
	/**
	 * Bobbit-facing id. Used to key the model registry and match models.json
	 * entries for `set_model`. For authoritative (well-known) and option-1 routed
	 * models this equals the bare wire id; kept as a distinct field so future
	 * multiplexed-root callers can diverge if needed.
	 */
	id: string;
	name: string;
	api: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost?: AigwModelCost;
	thinkingLevelMap?: Record<string, string | null>;
	compat?: Record<string, unknown>;
	/**
	 * Per-model endpoint (a provider's `options.baseURL`, e.g. `…/openai/v1`).
	 * pi-ai uses this directly as the SDK `baseURL`, so responses/completions/
	 * bedrock traffic hits the correct per-provider subpath instead of the
	 * multiplexed `/v1` root. `undefined` ⇒ fall back to the provider baseUrl.
	 */
	baseUrl?: string;
	/**
	 * Bare id to send on the wire. Per-provider subpaths expose bare ids
	 * (e.g. `gpt-5.6-sol`, not `openai/gpt-5.6-sol`), so this is the value
	 * `writeAigwModelsJson` emits as the models.json `id`. Defaults to `id`.
	 */
	wireId?: string;
	/** Provider key from the opencode well-known config (e.g. "openai", "aws-mantle"). */
	upstreamProvider?: string;
}

export interface AigwConfig {
	url: string;
	models: AigwModel[];
}

// ── Well-known model metadata ──────────────────────────────────────

interface ModelMeta {
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	input: ("text" | "image")[];
	/**
	 * Optional per-model effort metadata, mirroring pi-ai's `thinkingLevelMap`.
	 * Only set for families where a bare/routed id would otherwise fall through
	 * to a generic rule and lose extended (`xhigh`/`max`) thinking support
	 * (e.g. AIGW-routed GPT 5.6 Luna/Sol/Terra).
	 */
	thinkingLevelMap?: Record<string, string | null>;
	compat?: Record<string, unknown>;
}

// modelRecencyRank() has moved to model-registry.ts

const DEFAULT_META: ModelMeta = {
	contextWindow: 128_000,
	maxTokens: 16_384,
	reasoning: false,
	input: ["text"],
};

function zeroAigwCost(): AigwModelCost {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function normalizeCostValue(value: number): number {
	if (!Number.isFinite(value) || value < 0) return 0;
	return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

export function normalizeAigwPricing(pricing: unknown): AigwModelCost {
	// Legacy /v1/models pricing is USD per token. It must be scaled to the
	// per-million units used by Bobbit; do not share scaling with well-known cost.
	if (!pricing || typeof pricing !== "object") return zeroAigwCost();

	const record = pricing as Record<string, unknown>;
	const prompt = record.prompt;
	const completion = record.completion;
	if (
		typeof prompt !== "number" ||
		typeof completion !== "number" ||
		!Number.isFinite(prompt) ||
		!Number.isFinite(completion) ||
		prompt < 0 ||
		completion < 0
	) {
		return zeroAigwCost();
	}

	return {
		input: normalizeCostValue(prompt * 1_000_000),
		output: normalizeCostValue(completion * 1_000_000),
		cacheRead: normalizeCostValue(prompt * 0.1 * 1_000_000),
		cacheWrite: normalizeCostValue(prompt * 1.25 * 1_000_000),
	};
}

/**
 * Normalize a well-known `cost` block to Bobbit's per-1M `AigwModelCost`.
 *
 * Unlike `/v1/models` pricing (which is USD *per token* under {prompt,completion}
 * and needs the *1M scale-up done by `normalizeAigwPricing`), opencode well-known
 * `cost` is already denominated in USD per 1M tokens under
 * {input,output,cache_read,cache_write} — so we map the fields straight across.
 * cache_read/cache_write are honoured when present (falling back to the same
 * heuristic ratios `normalizeAigwPricing` uses when the gateway omits them).
 */
export function normalizeWellKnownCost(cost: unknown): AigwModelCost {
	if (!cost || typeof cost !== "object") return zeroAigwCost();
	const c = cost as Record<string, unknown>;
	const num = (v: unknown): number | undefined =>
		typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
	const input = num(c.input) ?? 0;
	const output = num(c.output) ?? 0;
	return {
		input: normalizeCostValue(input),
		output: normalizeCostValue(output),
		cacheRead: normalizeCostValue(num(c.cache_read) ?? input * 0.1),
		cacheWrite: normalizeCostValue(num(c.cache_write) ?? input * 1.25),
	};
}

/**
 * Infer model metadata from the model ID.
 * Patterns are matched greedily — first match wins.
 */
/**
 * Compat flags for the openai-completions provider in pi-ai.
 * These control which OpenAI API features are used in requests.
 * Gateway proxies often don't support the full OpenAI API surface,
 * so we disable features that cause errors.
 */
const GATEWAY_COMPAT: Record<string, unknown> = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsUsageInStreaming: false,
	supportsReasoningEffort: false,
	supportsStrictMode: false,
	maxTokensField: "max_tokens",
};

/**
 * Table-driven matcher for `inferMeta`. Rules are evaluated in order and the
 * first match wins, so order from most-specific (e.g. `gpt-5.5-pro`) to
 * least-specific (e.g. `gpt-4`).
 *
 * Each rule's `meta` is returned with `compat: GATEWAY_COMPAT` spliced in by
 * `inferMeta` so individual rows don't have to repeat it.
 */
type InferRule = {
	test: RegExp | ((id: string) => boolean);
	// `meta.compat`, when present, is a *partial* override that `inferMeta` merges
	// on top of GATEWAY_COMPAT (so a rule only names the flags it flips and keeps
	// the conservative gateway defaults for the rest). Used by GPT 5.6 to opt into
	// `supportsReasoningEffort` so Pi's openai-completions actually sends the
	// selected reasoning_effort for the advertised `max` tier.
	meta: Omit<ModelMeta, "compat"> & { compat?: Record<string, unknown> };
};

const INFER_RULES: InferRule[] = [
	// ── Anthropic Claude (most-specific size first) ─────────────────
	{ test: /claude-opus/, meta: { contextWindow: 1_000_000, maxTokens: 32_768, reasoning: true, input: ["text", "image"] } },
	{ test: /claude-sonnet/, meta: { contextWindow: 1_000_000, maxTokens: 16_384, reasoning: true, input: ["text", "image"] } },
	{ test: /claude-haiku/, meta: { contextWindow: 200_000, maxTokens: 8_192, reasoning: false, input: ["text", "image"] } },
	{ test: /claude/, meta: { contextWindow: 200_000, maxTokens: 16_384, reasoning: false, input: ["text", "image"] } },

	// ── OpenAI GPT-5.x (pro first so it doesn't match base variants) ─
	// gpt-5.6 (Luna/Sol/Terra + routed variants) are reasoning models that
	// advertise both xhigh and the new pi-0.80.6 `max` tier. Carry an explicit
	// thinkingLevelMap so routed ids (e.g. `openai/gpt-5.6-luna`) that only match
	// this substring rule keep extended thinking instead of collapsing to the
	// generic `/gpt-5/` non-reasoning fallback. Placed before the 5.5 rules so
	// the digit is unambiguous (substring `gpt-5.6` never matches 5.5 rules).
	// The compat override opts into supportsReasoningEffort: without it the merged
	// gateway compat leaves it false and Pi's openai-completions silently drops the
	// selected effort even though the model advertises `xhigh`/`max`.
	{ test: /gpt-5\.6/, meta: { contextWindow: 272_000, maxTokens: 128_000, reasoning: true, input: ["text", "image"], thinkingLevelMap: { xhigh: "xhigh", max: "max" }, compat: { supportsReasoningEffort: true } } },
	{ test: /gpt-5\.5-pro/, meta: { contextWindow: 1_050_000, maxTokens: 128_000, reasoning: true, input: ["text", "image"] } },
	{ test: /gpt-5\.5/, meta: { contextWindow: 272_000, maxTokens: 128_000, reasoning: true, input: ["text", "image"] } },
	{ test: /gpt-5\.4-pro/, meta: { contextWindow: 1_050_000, maxTokens: 128_000, reasoning: true, input: ["text", "image"] } },
	// gpt-5.1-codex-max and gpt-5.2* / gpt-5.4* are reasoning models (and
	// xhigh-capable per src/shared/thinking-levels.ts). They must be classified
	// as reasoning so server-side clamping does not collapse xhigh to off for
	// aigw-routed users. Base gpt-5.4/5.5 currently advertise a 272k active
	// window in pi-ai; using the old speculative 1M here makes compaction look
	// far too early and can defer threshold compaction until provider overflow.
	{ test: /gpt-5\.4/, meta: { contextWindow: 272_000, maxTokens: 128_000, reasoning: true, input: ["text", "image"] } },
	{ test: /gpt-5\.2/, meta: { contextWindow: 400_000, maxTokens: 128_000, reasoning: true, input: ["text", "image"] } },
	{ test: /gpt-5\.1-codex-max/, meta: { contextWindow: 400_000, maxTokens: 128_000, reasoning: true, input: ["text", "image"] } },
	{ test: /gpt-5/, meta: { contextWindow: 400_000, maxTokens: 32_768, reasoning: false, input: ["text", "image"] } },

	// ── OpenAI o-series reasoning models (mini variants first) ──────
	{ test: (id) => id.includes("o4-mini") || id.includes("o3-mini") || id.includes("o1-mini"), meta: { contextWindow: 200_000, maxTokens: 65_536, reasoning: true, input: ["text"] } },
	{ test: (id) => id.includes("o4") || id.includes("o3") || id.includes("o1"), meta: { contextWindow: 200_000, maxTokens: 100_000, reasoning: true, input: ["text", "image"] } },

	// ── OpenAI GPT-4 (catch-all for 4o, 4.1, 4-turbo, …) ────────────
	{ test: /gpt-4/, meta: { contextWindow: 128_000, maxTokens: 16_384, reasoning: false, input: ["text", "image"] } },

	// ── Z.ai GLM ────────────────────────────────────────────────────
	// GLM 5.x models expose OpenRouter reasoning controls; older GLM families do not.
	{ test: /(?:^|\/)glm-5(?:\b|[-.])/, meta: { contextWindow: 128_000, maxTokens: 16_384, reasoning: true, input: ["text"] } },

	// ── Alibaba Qwen ────────────────────────────────────────────────
	{ test: /qwen/, meta: { contextWindow: 1_000_000, maxTokens: 32_768, reasoning: false, input: ["text"] } },
];

export function inferMeta(modelId: string): ModelMeta {
	const id = modelId.toLowerCase();
	for (const rule of INFER_RULES) {
		const matched = typeof rule.test === "function" ? rule.test(id) : rule.test.test(id);
		if (matched) {
			const { compat: override, ...rest } = rule.meta;
			// Merge any per-rule compat override on top of the conservative gateway
			// defaults so unnamed flags keep GATEWAY_COMPAT's values.
			return { ...rest, compat: override ? { ...GATEWAY_COMPAT, ...override } : GATEWAY_COMPAT };
		}
	}
	return { ...DEFAULT_META, compat: GATEWAY_COMPAT };
}

/**
 * Derive a short display name from a full gateway model ID.
 * e.g. "aws/us.anthropic.claude-sonnet-4-6" → "Claude Sonnet 4.6 (aws)"
 */
export function deriveName(modelId: string): string {
	const parts = modelId.split("/");
	const prefix = parts.length > 1 ? parts[0] : undefined;
	const raw = parts[parts.length - 1];

	// Try to prettify common patterns
	let name = raw
		.replace(/^us\.anthropic\./, "")
		.replace(/^anthropic\./, "")
		.replace(/-v\d+:?\d*$/, "")     // strip version suffixes like -v1:0
		.replace(/-(\d{8})$/, "")        // strip date suffixes like -20250929
		.split("-")
		.map(s => s.charAt(0).toUpperCase() + s.slice(1))
		.join(" ");

	if (prefix && prefix !== name.toLowerCase()) {
		name += ` (${prefix})`;
	}
	return name;
}

// ── models.json management ─────────────────────────────────────────

function getModelsJsonPath(): string {
	return path.join(globalAgentDir(), "models.json");
}

function readModelsJson(): Record<string, any> {
	const p = getModelsJsonPath();
	try {
		if (fs.existsSync(p)) {
			return JSON.parse(fs.readFileSync(p, "utf-8"));
		}
	} catch (err) {
		console.error("[aigw-manager] Failed to read models.json:", err);
	}
	return { providers: {} };
}

function writeModelsJson(data: Record<string, any>): void {
	const p = getModelsJsonPath();
	let tmp = "";
	try {
		const dir = path.dirname(p);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		tmp = `${p}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
		fs.renameSync(tmp, p);
		console.log(`[aigw-manager] Wrote models.json to ${p}`);
	} catch (err) {
		if (tmp) {
			try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
		}
		console.error("[aigw-manager] Failed to write models.json:", err);
		throw err;
	}
}

/**
 * Resolve legacy AIGW ids that used to include an upstream provider prefix
 * (`openai/gpt-5.6-sol`, `gresearch/glm-5.2-fp8`) to the current models.json
 * id (`gpt-5.6-sol`, `glm-5.2-fp8`). The agent runtime's `set_model` matches
 * models.json strictly; leaving the old slash-prefixed id falls through to a
 * custom model id and the gateway rejects the wire request.
 */
export function normalizeAigwModelId(modelId: string): string {
	if (!modelId.includes("/")) return modelId;
	const slash = modelId.indexOf("/");
	const upstream = modelId.slice(0, slash);
	const bareId = modelId.slice(slash + 1);
	if (!upstream || !bareId || bareId.includes("/")) return modelId;
	try {
		const models = readModelsJson()?.providers?.aigw?.models;
		if (!Array.isArray(models)) return modelId;
		const exact = models.find((m: any) => m?.id === modelId);
		if (exact) return modelId;
		const bareMatches = models.filter((m: any) => m?.id === bareId);
		// Old generated files can contain duplicate bare ids from different
		// upstreams. Even a provenance match is not enough to erase the prefix:
		// the resulting bare preference would bind whichever duplicate Pi sees
		// first. Wait for a successful regeneration to make the candidate unique.
		if (bareMatches.length !== 1) return modelId;
		return bareId;
	} catch { /* best-effort */ }
	return modelId;
}

export function normalizeAigwModelString(modelString: string): string {
	const slash = modelString.indexOf("/");
	if (slash <= 0 || slash >= modelString.length - 1) return modelString;
	const provider = modelString.slice(0, slash);
	if (provider !== "aigw") return modelString;
	const modelId = modelString.slice(slash + 1);
	const normalized = normalizeAigwModelId(modelId);
	return normalized === modelId ? modelString : `aigw/${normalized}`;
}

export function normalizeAigwModelPreferences(prefs: PreferencesStore): void {
	for (const key of ["default.sessionModel", "default.reviewModel", "default.namingModel"] as const) {
		const value = prefs.get(key);
		if (typeof value !== "string") continue;
		const normalized = normalizeAigwModelString(value);
		if (normalized !== value) {
			prefs.set(key, normalized);
			console.log(`[aigw-manager] Migrated ${key} from legacy AIGW model id "${value}" to "${normalized}"`);
		}
	}
}

function unescapeGeneratedString(raw: string): string {
	try {
		return JSON.parse(`"${raw}"`);
	} catch {
		return raw.replace(/\\(["'\\])/g, "$1");
	}
}

function findMatchingBrace(source: string, openBraceIndex: number): number {
	let depth = 0;
	let quote: string | null = null;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;

	for (let i = openBraceIndex; i < source.length; i++) {
		const ch = source[i];
		const next = source[i + 1];

		if (lineComment) {
			if (ch === "\n" || ch === "\r") lineComment = false;
			continue;
		}
		if (blockComment) {
			if (ch === "*" && next === "/") {
				blockComment = false;
				i++;
			}
			continue;
		}
		if (quote) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === quote) {
				quote = null;
			}
			continue;
		}

		if (ch === "/" && next === "/") {
			lineComment = true;
			i++;
			continue;
		}
		if (ch === "/" && next === "*") {
			blockComment = true;
			i++;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function topLevelDepthAt(source: string, targetIndex: number): number {
	let depth = 0;
	let quote: string | null = null;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;

	for (let i = 0; i < targetIndex; i++) {
		const ch = source[i];
		const next = source[i + 1];

		if (lineComment) {
			if (ch === "\n" || ch === "\r") lineComment = false;
			continue;
		}
		if (blockComment) {
			if (ch === "*" && next === "/") {
				blockComment = false;
				i++;
			}
			continue;
		}
		if (quote) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === quote) quote = null;
			continue;
		}

		if (ch === "/" && next === "/") {
			lineComment = true;
			i++;
			continue;
		}
		if (ch === "/" && next === "*") {
			blockComment = true;
			i++;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "{") depth++;
		else if (ch === "}") depth = Math.max(0, depth - 1);
	}
	return depth;
}

function topLevelStringProperty(objectBody: string, property: string): string | undefined {
	const quoted = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const propertyRegex = new RegExp(`(?:^|[,\\s])(?:"${quoted}"|${quoted})\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "g");
	let match: RegExpExecArray | null;
	while ((match = propertyRegex.exec(objectBody)) !== null) {
		if (topLevelDepthAt(objectBody, match.index) === 0) {
			return unescapeGeneratedString(match[1]);
		}
	}
	return undefined;
}

function addProviderModel(providerModels: Map<string, string[]>, provider: string, modelId: string): void {
	if (!provider || !modelId) return;
	const models = providerModels.get(provider) ?? [];
	if (!models.includes(modelId)) models.push(modelId);
	providerModels.set(provider, models);
}

/**
 * Parse model IDs from pi-ai's models.generated.js text, grouped by provider.
 * Supports both the older flat shape and the current provider-nested shape.
 */
export function parseModelsGeneratedText(text: string): Map<string, string[]> {
	const providerModels = new Map<string, string[]>();
	const entryRegex = /"((?:\\.|[^"\\])+)"\s*:\s*\{/g;
	let match: RegExpExecArray | null;

	while ((match = entryRegex.exec(text)) !== null) {
		const key = unescapeGeneratedString(match[1]);
		const openBraceIndex = entryRegex.lastIndex - 1;
		const closeBraceIndex = findMatchingBrace(text, openBraceIndex);
		if (closeBraceIndex < 0) continue;

		const objectBody = text.slice(openBraceIndex + 1, closeBraceIndex);
		const provider = topLevelStringProperty(objectBody, "provider");
		if (!provider) continue;

		addProviderModel(providerModels, provider, topLevelStringProperty(objectBody, "id") ?? key);
		entryRegex.lastIndex = closeBraceIndex + 1;
	}

	return providerModels;
}

/**
 * Parse model IDs from pi-ai's models.generated.js, grouped by provider.
 */
function parseModelsGenerated(): Map<string, string[]> {
	try {
		const pkgUrl = import.meta.resolve("@earendil-works/pi-ai");
		const pkgDir = path.dirname(fileURLToPath(pkgUrl));
		const modelsPath = path.join(pkgDir, "models.generated.js");
		return parseModelsGeneratedText(fs.readFileSync(modelsPath, "utf-8"));
	} catch (err) {
		console.error("[aigw-manager] Failed to parse models.generated.js:", err);
		return new Map<string, string[]>();
	}
}

/**
 * Write contextWindow overrides to models.json for all Claude models where
 * inferMeta() returns a larger context window than the built-in 200k.
 *
 * This fixes the 200k compaction bug: pi-ai hardcodes contextWindow: 200000
 * for all Claude models, but Sonnet/Opus actually support 1M tokens.
 * The modelOverrides in models.json tell pi-coding-agent to use the correct value.
 *
 * Preserves existing user modelOverrides — only sets contextWindow if the user
 * hasn't already overridden it for that model.
 */
const CONTEXT_WINDOW_OVERRIDE_PROVIDERS = ["amazon-bedrock", "anthropic"] as const;

export function applyContextWindowOverrides(data: Record<string, any>, providerModels: Map<string, string[]>): number {
	if (!data.providers) data.providers = {};

	let overridesWritten = 0;

	for (const provider of CONTEXT_WINDOW_OVERRIDE_PROVIDERS) {
		const modelIds = providerModels.get(provider) || [];
		const claudeIds = modelIds.filter(id => id.toLowerCase().includes("claude"));

		if (claudeIds.length === 0) continue;

		if (!data.providers[provider]) data.providers[provider] = {};
		if (!data.providers[provider].modelOverrides) data.providers[provider].modelOverrides = {};

		const overrides = data.providers[provider].modelOverrides;

		for (const modelId of claudeIds) {
			const meta = inferMeta(modelId);
			if (meta.contextWindow > 200_000) {
				// Don't clobber existing user contextWindow override
				if (overrides[modelId]?.contextWindow !== undefined) continue;

				if (!overrides[modelId]) overrides[modelId] = {};
				overrides[modelId].contextWindow = meta.contextWindow;
				overridesWritten++;
			}
		}
	}

	return overridesWritten;
}

export function writeContextWindowOverrides(): void {
	const providerModels = parseModelsGenerated();
	const data = readModelsJson();
	const overridesWritten = applyContextWindowOverrides(data, providerModels);

	if (overridesWritten > 0) {
		writeModelsJson(data);
		console.log(`[aigw-manager] Wrote ${overridesWritten} contextWindow overrides to models.json`);
	} else {
		console.log("[aigw-manager] No contextWindow overrides needed");
	}
}

/**
 * Write aigw models into ~/.bobbit/agent/models.json, merging with existing
 * providers (preserving non-aigw entries).
 */
/**
 * Set env vars so agent subprocesses route Bedrock calls through the gateway.
 * Called both on fresh configuration and on startup when aigw is already configured.
 */
function setBedrockEnvVars(aigwUrl: string): void {
	const bedrockBaseUrl = aigwUrl.replace(/\/+$/, "").replace(/\/v1$/, "") + "/aws";
	process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = bedrockBaseUrl;
	process.env.AWS_BEDROCK_FORCE_HTTP1 = "1";
	delete process.env.AWS_BEDROCK_SKIP_AUTH;  // pi-ai would override creds with wrong dummy values
	process.env.AWS_ACCESS_KEY_ID = "anything";
	process.env.AWS_SECRET_ACCESS_KEY = "anything";
	if (!process.env.AWS_REGION) process.env.AWS_REGION = "us-east-1";
	console.log(`[aigw] Bedrock env configured: endpoint=${bedrockBaseUrl}`);
}

export function writeAigwModelsJson(aigwUrl: string, models: AigwModel[]): void {
	const data = readModelsJson();
	if (!data.providers) data.providers = {};

	// AI gateways typically expose both OpenAI-compatible and Bedrock endpoints.
	// Route Claude models through the Bedrock Converse API (same path as Claude
	// Code) for full feature parity — native tool use, images, streaming.
	// Non-Claude models use OpenAI completions with conservative compat.
	const normalizedUrl = aigwUrl.replace(/\/+$/, "");
	// Bedrock Converse traffic goes to <gateway>/aws/model/<id>/converse-stream;
	// the provider's normalized baseUrl ends in /v1 for the OpenAI-compatible path
	// and is wrong for Bedrock. pi-ai uses `model.baseUrl` directly as the
	// `BedrockRuntimeClient` endpoint, so emit a per-model override on Claude
	// entries pointing at the /aws sub-tree. Mirrors the env var written by
	// setBedrockEnvVars() but survives across subprocess/env-strip boundaries.
	const bedrockBaseUrl = normalizedUrl.replace(/\/v1$/, "") + "/aws";

	const openaiCompat: Record<string, unknown> = {
		supportsDeveloperRole: false,
		supportsStore: false,
		supportsUsageInStreaming: false,
		supportsReasoningEffort: false,
		supportsStrictMode: false,
		maxTokensField: "max_tokens",
	};

	const isClaudeModel = (id: string) => id.toLowerCase().includes("claude");

	// Strip provider prefix for Bedrock (e.g. "aws/us.anthropic.claude-..." → "us.anthropic.claude-...")
	const bedrockModelId = (id: string) => {
		const slash = id.indexOf("/");
		return slash >= 0 ? id.slice(slash + 1) : id;
	};

	data.providers.aigw = {
		baseUrl: normalizedUrl,
		apiKey: "none",
		api: "openai-completions",
		// Provider-level header. pi-coding-agent's `resolveConfigValue` runs the
		// `!cmd` form via `child_process.exec` (shell-interpreted) and drops the
		// header entirely when stdout is empty — so when BOBBIT_SESSION_ID is
		// unset, no `x-opencode-session` header is sent (no fallback constant).
		// The literal here JSON-encodes to:
		//   "!node -e \"process.stdout.write(process.env.BOBBIT_SESSION_ID || '')\""
		headers: {
			"User-Agent": BOBBIT_AIGW_USER_AGENT,
			"x-opencode-session": `!node -e "process.stdout.write(process.env.BOBBIT_SESSION_ID || '')"`,
		},
		models: models.map(m => {
			const cost = m.cost ?? zeroAigwCost();
			// AUTHORITATIVE path: a model carrying both `api` and `baseUrl` came from
			// well-known discovery (or the fallback option-1 OpenAI-responses fix).
			// Emit those verbatim with the BARE wire id the per-provider subpath
			// expects (pi-ai uses `model.baseUrl` as the SDK baseURL and `model.id`
			// as the wire model). This is how `@ai-sdk/openai` models reach
			// openai-responses on `…/openai/v1` instead of the chat/completions root.
			if (m.api && m.baseUrl) {
				return {
					id: m.wireId ?? m.id,
					...(m.upstreamProvider ? { upstreamProvider: m.upstreamProvider } : {}),
					name: m.name,
					contextWindow: m.contextWindow,
					maxTokens: m.maxTokens,
					reasoning: m.reasoning,
					input: m.input,
					cost,
					api: m.api,
					baseUrl: m.baseUrl,
					...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
					...(m.compat ? { compat: m.compat } : {}),
				};
			}
			// ── Fallback heuristic path (no authoritative api/baseUrl) ──
			if (isClaudeModel(m.id)) {
				return {
					id: bedrockModelId(m.id),
					...(m.upstreamProvider ? { upstreamProvider: m.upstreamProvider } : {}),
					name: m.name,
					contextWindow: m.contextWindow,
					maxTokens: m.maxTokens,
					reasoning: m.reasoning,
					input: m.input,
					cost,
					api: "bedrock-converse-stream",
					// Per-model Bedrock endpoint override — provider baseUrl is the
					// OpenAI-compatible /v1 root; Bedrock Converse lives under /aws.
					baseUrl: bedrockBaseUrl,
					// Only forward a thinkingLevelMap when the input model carries one —
					// never fabricate one for Claude/Bedrock entries.
					...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
					...(m.compat ? { compat: m.compat } : {}),
				};
			}
			return {
				id: m.id,
				...(m.upstreamProvider ? { upstreamProvider: m.upstreamProvider } : {}),
				name: m.name,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				reasoning: m.reasoning,
				input: m.input,
				cost,
				// Persist per-model effort metadata (e.g. AIGW-routed GPT 5.6
				// Luna/Sol/Terra `{ xhigh, max }`) so spawned Pi agents honor the
				// selected `max` thinking level instead of collapsing to the generic
				// family fallback. Omitted when the input model carries no map.
				...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
				// Merge the discovered per-model compat over the conservative gateway
				// defaults. This is what carries `supportsReasoningEffort: true` for the
				// GPT 5.6 family (inferMeta's compat override) so Pi's openai-completions
				// sends the selected reasoning_effort for the advertised `max` tier;
				// other non-Claude models keep the conservative `false` default.
				compat: { ...openaiCompat, ...(m.compat || {}) },
			};
		}),
	};

	writeModelsJson(data);
	setBedrockEnvVars(aigwUrl);
}

export function collectAigwProviderDnsHosts(provider: any): string[] {
	let configuredOrigin = "";
	try { configuredOrigin = new URL(provider?.baseUrl).origin; }
	catch { return []; }
	const hosts = new Set<string>();
	for (const model of Array.isArray(provider?.models) ? provider.models : []) {
		if (typeof model?.baseUrl !== "string") continue;
		try {
			const target = new URL(model.baseUrl);
			const hostname = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
			if (target.protocol === "https:" && target.origin !== configuredOrigin && !net.isIP(hostname)) hosts.add(hostname);
		} catch { /* malformed entries are ignored by the runtime registry */ }
	}
	return [...hosts].sort();
}

/**
 * Generate the in-agent DNS guard for cross-origin AIGW provider hostnames.
 * Pi's SDKs retain the hostname for TLS, while this guard validates and returns
 * the exact DNS answers used by each socket connection. Content-addressing
 * keeps restored/sandboxed extension mounts stable across model refreshes.
 */
export function writeAigwDnsGuardExtension(): string | undefined {
	const provider = readModelsJson()?.providers?.aigw;
	const hosts = collectAigwProviderDnsHosts(provider);
	if (hosts.length === 0) return undefined;
	const code = `import dns from "node:dns";
import net from "node:net";
const guardedHosts = new Set(${JSON.stringify(hosts)});
const originalLookup = dns.lookup.bind(dns);
function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 240) return false;
  return true;
}
function isPublicIp(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version !== 6) return false;
  const lower = address.toLowerCase().split("%")[0];
  const dotted = lower.match(/^(?:0*:){5}(?:ffff:)?(\\d+\\.\\d+\\.\\d+\\.\\d+)$/);
  if (dotted) return isPublicIpv4(dotted[1]);
  const mapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const value = (Number.parseInt(mapped[1], 16) << 16) | Number.parseInt(mapped[2], 16);
    return isPublicIpv4([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join("."));
  }
  if (lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower)) return false;
  if (/^2001:db8(?:[:]|$)/.test(lower)) return false;
  return /^[23]/.test(lower);
}
(dns as any).lookup = (hostname: string, options: any, callback?: any) => {
  const cb = typeof options === "function" ? options : callback;
  const requested = typeof options === "function" || options == null ? {} : typeof options === "number" ? { family: options } : options;
  if (!guardedHosts.has(hostname.toLowerCase())) return typeof options === "function"
    ? (originalLookup as any)(hostname, options)
    : (originalLookup as any)(hostname, options, callback);
  (originalLookup as any)(hostname, { all: true, verbatim: true }, (error: Error | null, answers: Array<{ address: string; family: number }>) => {
    if (error) return cb(error);
    if (!Array.isArray(answers) || answers.length === 0 || answers.some((answer) => !isPublicIp(answer.address))) {
      const rejected: NodeJS.ErrnoException = new Error("AIGW provider DNS resolved to a non-public address");
      rejected.code = "EAI_AGAIN";
      return cb(rejected);
    }
    const eligible = requested.family ? answers.filter((answer) => answer.family === requested.family) : answers;
    if (eligible.length === 0) return cb(Object.assign(new Error("No validated AIGW provider address for requested family"), { code: "EAI_AGAIN" }));
    return requested.all ? cb(null, eligible) : cb(null, eligible[0].address, eligible[0].family);
  });
};
export default function aigwDnsGuard() {}
`;
	const hash = createHash("sha256").update(code).digest("hex").slice(0, 16);
	const dir = path.join(bobbitStateDir(), "aigw-dns-guard", hash);
	const file = path.join(dir, "guard.ts");
	try {
		fs.mkdirSync(dir, { recursive: true });
		if (!fs.existsSync(file) || fs.readFileSync(file, "utf-8") !== code) fs.writeFileSync(file, code, "utf-8");
		return file;
	} catch (error) {
		console.warn("[aigw] Failed to write DNS guard extension:", error);
		return undefined;
	}
}

/**
 * Remove the "aigw" provider from models.json.
 */
export function removeAigwModelsJson(): void {
	const data = readModelsJson();
	if (data.providers?.aigw) {
		delete data.providers.aigw;
		writeModelsJson(data);
	}
}

// ── Startup internet check ─────────────────────────────────────────

/**
 * Apply `PI_OFFLINE=1` to the gateway process env when no internet was
 * detected at startup. Spawned pi-coding-agent subprocesses inherit
 * `process.env` (see `rpc-bridge.ts`) and pi 0.74.0+ honours this var by
 * skipping the GitHub fd/rg download path in `ensureTool()` — returning
 * `undefined` cleanly instead of timing out (~10s) on each first call.
 *
 * Rules:
 *   • If the user has already set `PI_OFFLINE` (any non-empty value), it is
 *     preserved verbatim — never overridden.
 *   • Otherwise, when `hasInternet === false`, set `PI_OFFLINE=1` and log a
 *     single explanatory line.
 *   • When `hasInternet === true`, do NOT set `PI_OFFLINE`. Leave existing
 *     state alone — don't introduce an unset that would change behaviour
 *     for online users who currently rely on pi's download fallback.
 *
 * Exported for unit testing. Idempotent.
 */
export function applyPiOfflineEnv(hasInternet: boolean): void {
	const userValue = process.env.PI_OFFLINE;
	if (userValue !== undefined && userValue !== "") {
		// Respect any pre-existing user-supplied value.
		return;
	}
	if (hasInternet) return;
	process.env.PI_OFFLINE = "1";
	console.log(
		"[pi-offline] Internet unavailable; setting PI_OFFLINE=1 — pi will skip GitHub fd/rg downloads. Use bundled binaries or pre-install fd/rg on PATH.",
	);
}

/**
 * One-shot internet check at gateway startup. Tries HEAD requests to
 * well-known LLM API endpoints. Returns true if any responds.
 * Called once — not repeated after startup.
 */
let runtimeFlags = { skipAigwDiscovery: false, testNoExternal: false, e2e: false };

export function configureAigwRuntimeFlags(flags: Partial<typeof runtimeFlags>): void {
	runtimeFlags = { ...runtimeFlags, ...flags };
}

function externalNetworkBlockedForTests(): boolean {
	return runtimeFlags.testNoExternal || runtimeFlags.e2e;
}

function isLocalHttpUrl(raw: string): boolean {
	try {
		const host = new URL(raw).hostname.toLowerCase();
		return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
	} catch {
		return false;
	}
}

export async function checkInternetAvailable(): Promise<boolean> {
	if (externalNetworkBlockedForTests()) return false;
	const targets = [
		"https://api.anthropic.com",
		"https://api.openai.com",
	];

	try {
		await Promise.any(targets.map((t) => httpHead(t, 4_000)));
		return true;
	} catch {
		return false;
	}
}

/**
 * Run once at gateway startup:
 * - If aigw is already configured, nothing to do.
 * - If not configured but internet is unavailable, try to auto-discover
 *   a gateway at a well-known local URL and configure it.
 *
 * Returns true if aigw is active after this call.
 */
export async function startupAigwCheck(prefs: PreferencesStore): Promise<boolean> {
	// Already configured — ensure env vars are set and models.json is up to date
	const existingUrl = getAigwUrl(prefs);
	if (existingUrl) {
		console.log("[aigw] AI Gateway already configured:", existingUrl);
		setBedrockEnvVars(existingUrl);
		// Users with a local aigw are typically offline; probe the public
		// internet once and wire PI_OFFLINE accordingly. The probe is short
		// (≤4s) and runs in parallel with no other startup work below.
		if (!runtimeFlags.skipAigwDiscovery) {
			try {
				const hasInternet = await checkInternetAvailable();
				applyPiOfflineEnv(hasInternet);
			} catch {
				applyPiOfflineEnv(false);
			}
		}
		if (runtimeFlags.skipAigwDiscovery) {
			console.log("[aigw] aigw configured, skipping startup re-discovery (BOBBIT_SKIP_AIGW_DISCOVERY)");
			return true;
		}
		try {
			const models = await discoverAigwModels(existingUrl);
			writeAigwModelsJson(existingUrl, models);
			normalizeAigwModelPreferences(prefs);
			console.log(`[aigw] re-discovered ${models.length} models on startup, refreshed models.json`);
		} catch (err: any) {
			const msg = err?.message || String(err);
			console.warn(`[aigw] gateway unreachable on startup (${msg}), keeping existing models.json`);
		}
		return true;
	}

	// Skip network probing + local-gateway auto-discovery when tests/CI opt out.
	// Tests that exercise the /api/aigw/* endpoints configure the gateway
	// explicitly and don't rely on the startup probe.
	if (runtimeFlags.skipAigwDiscovery) return false;

	// Check internet
	const hasInternet = await checkInternetAvailable();
	applyPiOfflineEnv(hasInternet);
	if (hasInternet) {
		console.log("[aigw] Internet available — using standard providers");
		return false;
	}

	console.log("[aigw] No internet detected — probing for local AI Gateway...");

	// Build candidate list from environment, then fall back to localhost
	const candidates: string[] = [];
	const anthropicBase = process.env.ANTHROPIC_BASE_URL;
	if (anthropicBase) {
		const base = anthropicBase.replace(/\/+$/, "");
		candidates.push(base.endsWith("/v1") ? base : `${base}/v1`);
	}
	const openaiBase = process.env.OPENAI_BASE_URL;
	if (openaiBase) {
		candidates.push(openaiBase.replace(/\/+$/, ""));
	}
	candidates.push("http://localhost:1111/v1", "http://127.0.0.1:1111/v1");

	for (const url of candidates) {
		try {
			const models = await discoverAigwModels(url);
			if (models.length > 0) {
				console.log(`[aigw] Found gateway at ${url} with ${models.length} models — auto-configuring`);
				await configureAigw(url, prefs);
				return true;
			}
		} catch {
			// try next
		}
	}

	console.log("[aigw] No gateway found at well-known URLs");
	return false;
}

// ── HTTP helpers ───────────────────────────────────────────────────

/**
 * Simple HTTP HEAD — resolves on any response, rejects on network error / timeout.
 */
function httpHead(url: string, timeoutMs = 4_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const parsedUrl = new URL(url);
		const transport = parsedUrl.protocol === "https:" ? https : http;
		const req = transport.request(parsedUrl, { method: "HEAD", timeout: timeoutMs }, () => resolve());
		req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
		req.on("error", reject);
		req.end();
	});
}

const MAX_DISCOVERY_BODY_BYTES = 1024 * 1024;
const WELL_KNOWN_DEADLINE_MS = 8_000;

function normalizeHttpUrl(raw: string, label = "AI Gateway URL"): URL {
	let parsed: URL;
	try { parsed = new URL(raw); }
	catch { throw new Error(`${label} must be an absolute HTTP(S) URL`); }
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`${label} must use HTTP or HTTPS`);
	}
	if (parsed.username || parsed.password || parsed.hash) {
		throw new Error(`${label} must not contain credentials or a fragment`);
	}
	// Accessing port forces WHATWG URL validation of malformed/out-of-range ports.
	void parsed.port;
	return parsed;
}

function isPublicIpv4(address: string): boolean {
	const octets = address.split(".").map(Number);
	if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
	const [a, b, c] = octets;
	if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
	if (a === 100 && b >= 64 && b <= 127) return false;
	if (a === 169 && b === 254) return false;
	if (a === 172 && b >= 16 && b <= 31) return false;
	if (a === 192 && b === 168) return false;
	if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
	if (a === 192 && b === 88 && c === 99) return false;
	if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
	if (a === 203 && b === 0 && c === 113) return false;
	if (a >= 240) return false;
	return true;
}

function isPublicIp(address: string): boolean {
	const version = net.isIP(address);
	if (version === 4) return isPublicIpv4(address);
	if (version !== 6) return false;
	const lower = address.toLowerCase().split("%")[0];
	const dottedMapped = lower.match(/^(?:0*:){5}(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
	if (dottedMapped) return isPublicIpv4(dottedMapped[1]);
	const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
	if (hexMapped) {
		const value = (Number.parseInt(hexMapped[1], 16) << 16) | Number.parseInt(hexMapped[2], 16);
		return isPublicIpv4([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join("."));
	}
	if (lower === "::" || lower === "::1") return false;
	if (/^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower)) return false;
	if (/^2001:db8(?:[:]|$)/.test(lower)) return false;
	// Public global-unicast IPv6 is 2000::/3. Reject unspecified, link-local,
	// documentation, multicast, and other special/reserved ranges by default.
	return /^[23]/.test(lower);
}

function structurallyValidateTarget(raw: string, configuredOrigin: string): URL | null {
	try {
		const parsed = normalizeHttpUrl(raw, "Discovery target");
		if (parsed.origin === configuredOrigin) return parsed;
		if (parsed.protocol !== "https:") return null;
		if (net.isIP(parsed.hostname) && !isPublicIp(parsed.hostname)) return null;
		return parsed;
	} catch {
		return null;
	}
}

type DnsLookup = typeof dnsCallback.lookup;

/**
 * Wrap DNS lookup so every connection to an approved cross-origin provider
 * resolves once, validates every answer, and returns those exact answers to the
 * socket. This closes the validation/connect rebinding gap while retaining the
 * original hostname for HTTPS SNI and certificate verification.
 */
export function createAigwGuardedLookup(guardedHosts: ReadonlySet<string>, originalLookup: DnsLookup): DnsLookup {
	return ((hostname: string, options: any, callback?: any) => {
		const cb = typeof options === "function" ? options : callback;
		const requested = typeof options === "function" || options == null
			? {}
			: typeof options === "number" ? { family: options } : options;
		if (!guardedHosts.has(hostname.toLowerCase())) {
			return typeof options === "function"
				? (originalLookup as any)(hostname, options)
				: (originalLookup as any)(hostname, options, callback);
		}
		(originalLookup as any)(hostname, { all: true, verbatim: true }, (error: Error | null, answers: Array<{ address: string; family: number }>) => {
			if (error) return cb(error);
			if (!Array.isArray(answers) || answers.length === 0 || answers.some((answer) => !isPublicIp(answer.address))) {
				const rejected = new Error("AIGW provider DNS resolved to a non-public address");
				(rejected as NodeJS.ErrnoException).code = "EAI_AGAIN";
				return cb(rejected);
			}
			const eligible = requested.family ? answers.filter((answer) => answer.family === requested.family) : answers;
			if (eligible.length === 0) {
				const missing = new Error("AIGW provider DNS returned no address for the requested family");
				(missing as NodeJS.ErrnoException).code = "EAI_AGAIN";
				return cb(missing);
			}
			if (requested.all) return cb(null, eligible);
			return cb(null, eligible[0].address, eligible[0].family);
		});
	}) as DnsLookup;
}

const guardedProviderHosts = new Set<string>();
let gatewayDnsGuardInstalled = false;

function registerProviderDnsGuard(target: URL, configuredOrigin: string): void {
	const hostname = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (target.origin === configuredOrigin || net.isIP(hostname)) return;
	guardedProviderHosts.add(hostname);
	if (gatewayDnsGuardInstalled) return;
	gatewayDnsGuardInstalled = true;
	const originalLookup = dnsCallback.lookup.bind(dnsCallback) as DnsLookup;
	dnsCallback.lookup = createAigwGuardedLookup(guardedProviderHosts, originalLookup);
}

function validateProviderBaseTarget(raw: string, configuredOrigin: string): URL | null {
	const target = structurallyValidateTarget(raw, configuredOrigin);
	if (!target) return null;
	// Cross-origin DNS names stay as hostnames for TLS. Both the gateway process
	// and every spawned Pi process install a lookup guard which validates and pins
	// the answers used by each actual connection; a one-time discovery lookup is
	// deliberately not treated as authorization for a later request.
	registerProviderDnsGuard(target, configuredOrigin);
	return target;
}

interface ValidatedTarget {
	url: URL;
	lookup?: (...args: any[]) => void;
}

async function validateAndPinTarget(raw: string, configuredOrigin: string): Promise<ValidatedTarget | null> {
	const url = structurallyValidateTarget(raw, configuredOrigin);
	if (!url) return null;
	if (url.origin === configuredOrigin || net.isIP(url.hostname)) return { url };
	let addresses: Array<{ address: string; family: number }>;
	try {
		addresses = (await dns.lookup(url.hostname, { all: true, verbatim: true }))
			.map((entry) => ({ address: entry.address, family: entry.family }));
	} catch {
		return null;
	}
	if (addresses.length === 0 || addresses.some((entry) => !isPublicIp(entry.address))) return null;
	// Pin connection lookup to the already-validated answers. HTTPS still uses
	// the original URL hostname, preserving SNI and certificate verification.
	const lookup = (_hostname: string, options: any, callback: any) => {
		const eligible = options?.family ? addresses.filter((entry) => entry.family === options.family) : addresses;
		if (eligible.length === 0) {
			callback(new Error("No validated address for requested family"));
			return;
		}
		if (options?.all) callback(null, eligible);
		else callback(null, eligible[0].address, eligible[0].family);
	};
	return { url, lookup };
}

function sanitizeRemoteHeaders(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const forbidden = new Set([
		"connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer",
		"host", "content-length", "user-agent", "proxy-authenticate", "proxy-authorization",
	]);
	const headers: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		const lower = key.toLowerCase();
		if (forbidden.has(lower) || lower.startsWith("proxy-") || typeof raw !== "string") continue;
		if (/[^!#$%&'*+.^_`|~0-9A-Za-z-]/.test(key) || /[\r\n]/.test(raw)) continue;
		headers[key] = raw;
	}
	return headers;
}

async function httpGetJson(
	target: string,
	configuredOrigin: string,
	deadline: number,
	extraHeaders?: Record<string, string>,
): Promise<any> {
	const validated = await validateAndPinTarget(target, configuredOrigin);
	if (!validated) throw new Error("Discovery target was rejected");
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new Error("Discovery deadline exceeded");
	return new Promise((resolve, reject) => {
		let settled = false;
		let absoluteTimer: ReturnType<typeof setTimeout> | undefined;
		const finish = () => {
			if (absoluteTimer) clearTimeout(absoluteTimer);
			absoluteTimer = undefined;
			settled = true;
		};
		const fail = (error: Error) => {
			if (settled) return;
			finish();
			reject(error);
		};
		const transport = validated.url.protocol === "https:" ? https : http;
		const req = transport.request(validated.url, {
			method: "GET",
			headers: aigwUserAgentHeaders(extraHeaders),
			timeout: remaining,
			...(validated.lookup ? { lookup: validated.lookup } : {}),
		}, (res) => {
			if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400) {
				res.resume();
				fail(new Error("Discovery redirects are not allowed"));
				return;
			}
			if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
				res.resume();
				fail(new Error(`Discovery request failed with HTTP ${res.statusCode ?? 0}`));
				return;
			}
			const chunks: Buffer[] = [];
			let bytes = 0;
			res.on("data", (chunk: Buffer) => {
				bytes += chunk.length;
				if (bytes > MAX_DISCOVERY_BODY_BYTES) {
					res.destroy();
					req.destroy();
					fail(new Error("Discovery response exceeded 1 MiB"));
					return;
				}
				chunks.push(chunk);
			});
			res.on("end", () => {
				if (settled) return;
				try {
					const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
					finish();
					resolve(parsed);
				} catch {
					fail(new Error("Discovery response was not valid JSON"));
				}
			});
			res.on("error", (error) => fail(error));
		});
		absoluteTimer = setTimeout(() => {
			req.destroy();
			fail(new Error("Discovery deadline exceeded"));
		}, remaining);
		req.on("timeout", () => { req.destroy(); fail(new Error("Discovery deadline exceeded")); });
		req.on("error", (error) => fail(error));
		req.end();
	});
}

/**
 * Proxy an HTTP request: reads the incoming request body, forwards to the
 * target URL, and pipes the response back.
 */
export function proxyRequest(
	targetUrl: string,
	incomingReq: http.IncomingMessage,
	outgoingRes: http.ServerResponse,
): void {
	const parsed = new URL(targetUrl);
	const transport = parsed.protocol === "https:" ? https : http;

	const chunks: Buffer[] = [];
	incomingReq.on("data", (c: Buffer) => chunks.push(c));
	incomingReq.on("end", () => {
		const body = Buffer.concat(chunks);
		const headers = aigwUserAgentHeaders({
			"Content-Type": "application/json",
			...(body.length > 0 ? { "Content-Length": String(body.length) } : {}),
		});

		const RESPONSE_TIMEOUT_MS = 120_000;
		let responseTimer: ReturnType<typeof setTimeout> | undefined;
		let completed = false;

		const cleanup = () => {
			if (responseTimer) {
				clearTimeout(responseTimer);
				responseTimer = undefined;
			}
			completed = true;
		};

		const proxyReq = transport.request(parsed, {
			method: incomingReq.method || "GET",
			headers,
			timeout: RESPONSE_TIMEOUT_MS,
		}, (proxyRes) => {
			outgoingRes.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
			proxyRes.pipe(outgoingRes);
			proxyRes.on("end", cleanup);
			proxyRes.on("error", cleanup);
		});

		responseTimer = setTimeout(() => {
			if (!completed) {
				console.error(`[aigw-proxy] Response timeout after ${RESPONSE_TIMEOUT_MS}ms proxying to ${targetUrl}`);
				proxyReq.destroy();
				if (!outgoingRes.headersSent) {
					outgoingRes.writeHead(504, { "Content-Type": "application/json" });
				}
				outgoingRes.end(JSON.stringify({ error: "Gateway timeout: response not completed within 120s" }));
				completed = true;
			}
		}, RESPONSE_TIMEOUT_MS);

		proxyReq.on("error", (err) => {
			cleanup();
			console.error(`[aigw-proxy] Error proxying to ${targetUrl}:`, err.message);
			if (!outgoingRes.headersSent) {
				outgoingRes.writeHead(502, { "Content-Type": "application/json" });
			}
			outgoingRes.end(JSON.stringify({ error: `Gateway proxy error: ${err.message}` }));
		});
		if (body.length > 0) proxyReq.write(body);
		proxyReq.end();
	});
}

// ── Well-known (opencode) discovery & translation ──────────────────
//
// opencode learns its routing from `{gateway}/.well-known/opencode`, an
// AUTHORITATIVE config (not a bare model list): per provider it names the npm
// adapter, a dedicated `options.baseURL` subpath, a `whitelist`, and full
// per-model metadata. We consume it as the source of truth so we stop guessing
// endpoints via `inferMeta`.
//
// WHY `openai` → responses: on this gateway the `openai` provider uses
// `@ai-sdk/openai`, whose SDK appends `/responses` to `options.baseURL`
// (`…/openai/v1` → `…/openai/v1/responses`). The Responses API is the only place
// reasoning + function tools coexist; the multiplexed `/v1/chat/completions`
// root rejects `reasoning_effort` + tools for models like `gpt-5.6-sol` (400).
// Routing `@ai-sdk/openai` providers to pi-ai's `openai-responses` therefore
// fixes the tools-with-reasoning failure.
//
// WHY per-provider baseURLs matter: each provider subpath (`…/openai/v1`,
// `…/aws`, `…/gresearch/v1`) exposes BARE model ids (`gpt-5.6-sol`) and the
// correct endpoint semantics. The multiplexed `/v1` root Bobbit historically
// targeted requires the `openai/` prefix and only speaks chat/completions.

interface WkModel {
	name?: string;
	variants?: Record<string, unknown>;
	cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
	limit?: { context?: number; output?: number };
	reasoning?: boolean;
	tool_call?: boolean;
	modalities?: { input?: string[] };
}
interface WkProvider {
	npm?: string;
	options?: { baseURL?: string };
	whitelist?: string[];
	models?: Record<string, WkModel>;
}
interface RemoteConfig {
	url?: string;
	headers?: Record<string, string>;
}
export interface WellKnownConfig {
	model?: string;
	disabled_providers?: string[];
	provider?: Record<string, WkProvider>;
	remote_config?: RemoteConfig;
}

// Provider npm adapter → pi-ai `api`. Unknown adapters fall back to
// `openai-completions` (the conservative chat/completions default).
const PROVIDER_NPM_TO_API: Record<string, string> = {
	"@ai-sdk/openai": "openai-responses",
	"@ai-sdk/amazon-bedrock": "bedrock-converse-stream",
	"@ai-sdk/openai-compatible": "openai-completions",
};

const RECOGNIZED_EFFORT_KEYS = ["minimal", "none", "low", "medium", "high", "xhigh", "max"];

/**
 * Build a pi-ai `thinkingLevelMap` from a well-known model's `variants` keys.
 * Each advertised effort tier maps to itself (identity); `off:"none"` is added
 * for reasoning models so the responses/completions adapters emit
 * `reasoning_effort:"none"` in the no-effort case (the tool-compatible path the
 * gateway wants). Returns undefined when no recognized tiers are advertised.
 */
function buildThinkingLevelMap(variants: Record<string, unknown> | undefined, reasoning: boolean): Record<string, string | null> | undefined {
	if (!variants) return undefined;
	const map: Record<string, string | null> = {};
	for (const key of Object.keys(variants)) {
		if (RECOGNIZED_EFFORT_KEYS.includes(key)) map[key] = key;
	}
	if (Object.keys(map).length === 0) return undefined;
	if (reasoning) map.off = "none";
	return map;
}

/**
 * Pure translator: well-known config → Bobbit `AigwModel[]`. Applies
 * `disabled_providers` + per-provider `whitelist` as HARD filters and never
 * runs `inferMeta` guessing. Unit-tested against a captured fixture.
 */
export function translateWellKnown(config: WellKnownConfig, gatewayBaseUrl: string): AigwModel[] {
	const disabled = new Set(Array.isArray(config.disabled_providers) ? config.disabled_providers : []);
	let configuredOrigin: string;
	try { configuredOrigin = normalizeHttpUrl(gatewayBaseUrl).origin; }
	catch { return []; }
	const defaultRaw = typeof config.model === "string" ? config.model : "";
	const defaultColon = defaultRaw.indexOf(":");
	const defaultProvider = defaultColon > 0 ? defaultRaw.slice(0, defaultColon) : undefined;
	const defaultModelId = defaultColon > 0 ? defaultRaw.slice(defaultColon + 1) : undefined;
	const candidates = new Map<string, AigwModel[]>();

	for (const [providerName, provider] of Object.entries(config.provider ?? {})) {
		if (!provider || typeof provider !== "object" || disabled.has(providerName)) continue;
		const api = PROVIDER_NPM_TO_API[provider.npm ?? ""] ?? "openai-completions";
		const validatedBase = typeof provider.options?.baseURL === "string"
			? validateProviderBaseTarget(provider.options.baseURL, configuredOrigin)
			: null;
		// A provider without a safe explicit base is unusable, but the provider
		// object remains authoritative: the caller must not fall back to /v1/models.
		if (!validatedBase) continue;
		const baseUrl = validatedBase.href.replace(/\/$/, "");
		const whitelist = Array.isArray(provider.whitelist) ? new Set(provider.whitelist) : undefined;

		for (const [bareId, wk] of Object.entries(provider.models ?? {})) {
			if (!bareId || !wk || typeof wk !== "object" || (whitelist && !whitelist.has(bareId))) continue;
			const reasoning = wk.reasoning === true;
			const input = (Array.isArray(wk.modalities?.input) ? wk.modalities!.input! : ["text"])
				.filter((m): m is "text" | "image" => m === "text" || m === "image");
			const thinkingLevelMap = buildThinkingLevelMap(wk.variants, reasoning);
			const compat = api === "bedrock-converse-stream"
				? undefined
				: { ...GATEWAY_COMPAT, supportsReasoningEffort: true };
			const positive = (value: unknown, fallback: number) =>
				typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
			const model: AigwModel = {
				id: bareId,
				wireId: bareId,
				upstreamProvider: providerName,
				name: typeof wk.name === "string" && wk.name ? wk.name : deriveName(bareId),
				api,
				baseUrl,
				reasoning,
				input: input.length > 0 ? input : ["text"],
				contextWindow: positive(wk.limit?.context, DEFAULT_META.contextWindow),
				maxTokens: positive(wk.limit?.output, DEFAULT_META.maxTokens),
				cost: normalizeWellKnownCost(wk.cost),
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
				...(compat ? { compat } : {}),
			};
			const entries = candidates.get(bareId) ?? [];
			entries.push(model);
			candidates.set(bareId, entries);
		}
	}

	const out: AigwModel[] = [];
	for (const [bareId, models] of candidates) {
		const preferred = bareId === defaultModelId
			? models.find((model) => model.upstreamProvider === defaultProvider)
			: undefined;
		out.push(preferred ?? models[0]);
	}
	return out;
}

/**
 * Best-effort read of a bearer token for the well-known request. Priority:
 *   1. AIGW_OPENCODE_TOKEN env
 *   2. opencode auth.json `type:"wellknown"` entry keyed by the gateway URL/host
 *   3. (none) — a dummy currently works, but the real token is preferred for
 *      quota/attribution.
 * Fully guarded; never throws.
 */
export function readOpencodeWellKnownToken(gatewayUrl: string): string | undefined {
	const envToken = process.env.AIGW_OPENCODE_TOKEN;
	if (envToken && envToken.trim()) return envToken.trim();
	try {
		const candidates = [
			path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
			path.join(os.homedir(), ".config", "opencode", "auth.json"),
		];
		let host = "";
		try { host = new URL(gatewayUrl).host; } catch { /* ignore */ }
		for (const file of candidates) {
			if (!fs.existsSync(file)) continue;
			const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, any>;
			for (const [key, entry] of Object.entries(parsed)) {
				if (!entry || typeof entry !== "object") continue;
				if (entry.type !== "wellknown") continue;
				let keyHost = key;
				try { keyHost = new URL(key).host; } catch { /* key may be a bare host */ }
				if (key === gatewayUrl || keyHost === host || key === host) {
					const token = entry.key ?? entry.token;
					if (typeof token === "string" && token.trim()) return token.trim();
				}
			}
		}
	} catch { /* best-effort */ }
	return undefined;
}

/**
 * Fetch `{origin}/.well-known/opencode`. Returns the resolved config, or null on
 * 404 / non-JSON / network error / blocked-in-tests so callers fall back to the
 * `/v1/models` + `inferMeta` heuristic.
 *
 * - The well-known doc lives at the ORIGIN ROOT, not under `/v1` — the gateway
 *   URL may be `http://host/v1`, so we resolve `/.well-known/opencode` against
 *   the origin (an absolute path drops the `/v1` prefix).
 * - Supports opencode's `remote_config` indirection: when the payload only
 *   carries `{ remote_config: { url, headers } }` we fetch that secondary URL.
 *   This gateway inlines `config`, but the opencode contract requires it.
 * - A top-level `config` wrapper is unwrapped; otherwise the object itself is
 *   treated as the config.
 */
export async function fetchWellKnownConfig(baseUrl: string, timeoutMs = WELL_KNOWN_DEADLINE_MS): Promise<WellKnownConfig | null> {
	let gateway: URL;
	try { gateway = normalizeHttpUrl(baseUrl); }
	catch { return null; }
	if (externalNetworkBlockedForTests() && !isLocalHttpUrl(gateway.href)) return null;
	if (runtimeFlags.skipAigwDiscovery) return null;
	const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1), WELL_KNOWN_DEADLINE_MS);
	const wellKnownUrl = new URL("/.well-known/opencode", gateway.origin).href;
	const token = readOpencodeWellKnownToken(gateway.href);
	const authHeader: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
	try {
		const payload = await httpGetJson(wellKnownUrl, gateway.origin, deadline, authHeader);
		return await resolveWellKnownPayload(payload, gateway.origin, authHeader, deadline, 0);
	} catch {
		return null;
	}
}

async function resolveWellKnownPayload(
	payload: unknown,
	configuredOrigin: string,
	inheritedAuth: Record<string, string>,
	deadline: number,
	depth: number,
): Promise<WellKnownConfig | null> {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
	const record = payload as Record<string, unknown>;
	const inline = record.config && typeof record.config === "object" && !Array.isArray(record.config)
		? record.config as Record<string, unknown>
		: record;
	const hasProvider = Object.prototype.hasOwnProperty.call(inline, "provider");
	if (hasProvider) {
		return inline.provider && typeof inline.provider === "object" && !Array.isArray(inline.provider)
			? inline as WellKnownConfig
			: null;
	}
	const rc = inline.remote_config;
	if (!rc || typeof rc !== "object" || Array.isArray(rc) || depth >= 1) return null;
	const remote = rc as Record<string, unknown>;
	if (typeof remote.url !== "string") return null;
	const target = structurallyValidateTarget(remote.url, configuredOrigin);
	if (!target) return null;
	const declared = sanitizeRemoteHeaders(remote.headers);
	// Inherited gateway credentials never cross origins. Explicitly declared
	// remote headers may be sent cross-origin after filtering; same-origin
	// Authorization is allowed to replace the inherited bearer token.
	const headers = target.origin === configuredOrigin
		? { ...inheritedAuth, ...declared }
		: declared;
	try {
		const remotePayload = await httpGetJson(target.href, configuredOrigin, deadline, headers);
		return resolveWellKnownPayload(remotePayload, configuredOrigin, inheritedAuth, deadline, depth + 1);
	} catch {
		return null;
	}
}

async function filterValidatedProviderUrls(config: WellKnownConfig, configuredOrigin: string): Promise<WellKnownConfig> {
	const entries: Array<[string, WkProvider]> = [];
	for (const [name, provider] of Object.entries(config.provider ?? {})) {
		if (!provider || typeof provider.options?.baseURL !== "string") continue;
		const target = validateProviderBaseTarget(provider.options.baseURL, configuredOrigin);
		if (!target) continue;
		// Discovery admission resolves public DNS now, while the installed runtime
		// lookup guard independently re-resolves, validates, and pins the answers
		// used for every later connection.
		if (target.origin !== configuredOrigin && !net.isIP(target.hostname)) {
			if (!await validateAndPinTarget(target.href, configuredOrigin)) continue;
		}
		entries.push([name, provider]);
	}
	return { ...config, provider: Object.fromEntries(entries) };
}

/**
 * Seed session/review/naming model prefs from the well-known top-level
 * `config.model` (form `provider:modelId`, e.g. `aws:us.anthropic.claude-opus-4-6`)
 * into Bobbit's `aigw/<id>` form — but ONLY when the pref is unset (never clobber
 * a user choice) and ONLY when a discovered model matches. Best-effort.
 */
export function seedDefaultModelsFromWellKnown(config: WellKnownConfig, models: AigwModel[], prefs: PreferencesStore): void {
	const raw = config.model;
	if (!raw || typeof raw !== "string") return;
	const colon = raw.indexOf(":");
	if (colon <= 0 || colon >= raw.length - 1) return;
	const provider = raw.slice(0, colon);
	const modelId = raw.slice(colon + 1);
	const match = models.find((model) =>
		model.upstreamProvider === provider && (model.wireId ?? model.id) === modelId,
	);
	if (!match) return;
	const pref = `aigw/${match.wireId ?? match.id}`;
	for (const key of ["default.sessionModel", "default.reviewModel", "default.namingModel"]) {
		const existing = prefs.get(key);
		if (existing === undefined || existing === null || existing === "") prefs.set(key, pref);
	}
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Discover aigw models. WELL-KNOWN-FIRST: consult `{origin}/.well-known/opencode`
 * (authoritative per-provider routing) and, when present, translate it directly.
 * Otherwise fall back to the legacy `/v1/models` + `inferMeta` heuristic — plus
 * a minimal fix that routes OpenAI-family reasoning models to `openai-responses`
 * so tools+reasoning don't 400 on the chat/completions root.
 */
interface AigwDiscoveryResult {
	models: AigwModel[];
	wellKnown: WellKnownConfig | null;
}

async function discoverAigwResult(baseUrl: string): Promise<AigwDiscoveryResult> {
	const gateway = normalizeHttpUrl(baseUrl);
	const url = gateway.href.replace(/\/$/, "");
	if (externalNetworkBlockedForTests() && !isLocalHttpUrl(url)) {
		throw new Error("External AI Gateway discovery is disabled in tests");
	}

	const fetchedWellKnown = await fetchWellKnownConfig(url);
	if (fetchedWellKnown && fetchedWellKnown.provider) {
		const wellKnown = await filterValidatedProviderUrls(fetchedWellKnown, gateway.origin);
		return { models: translateWellKnown(wellKnown, url), wellKnown };
	}

	const modelsUrl = url.endsWith("/v1") ? `${url}/models` : `${url}/v1/models`;
	const data = await httpGetJson(modelsUrl, gateway.origin, Date.now() + 10_000);
	if (!data?.data || !Array.isArray(data.data)) {
		throw new Error("Unexpected response format from /v1/models — expected { data: [...] }");
	}
	const openaiResponsesBaseUrl = `${gateway.origin}/openai/v1`;
	const isOpenAiFamily = (id: string) => {
		const low = id.toLowerCase();
		if (low.includes("claude")) return false;
		return /(?:^|\/)gpt-/.test(low) || /(?:^|\/)o[1-9]/.test(low);
	};
	const stripPrefix = (id: string) => { const i = id.indexOf("/"); return i >= 0 ? id.slice(i + 1) : id; };
	const models: AigwModel[] = [];
	const emittedIds = new Set<string>();
	for (const item of data.data) {
		if (!item || typeof item.id !== "string" || !item.id) {
			throw new Error("Unexpected response format from /v1/models — each model requires a string id");
		}
		const meta = inferMeta(item.id);
		const slash = item.id.indexOf("/");
		const upstreamProvider = slash > 0 ? item.id.slice(0, slash) : undefined;
		const ctxFromGw = item.context_length || item.context_window;
		const maxTokFromGw = item.max_tokens || item.max_completion_tokens;
		let model: AigwModel = {
			id: item.id,
			...(upstreamProvider ? { upstreamProvider } : {}),
			name: deriveName(item.id),
			api: "openai-completions",
			// Legacy /v1/models discovery implies the matching completions root is
			// /v1, even when the user configured the bare gateway origin.
			baseUrl: url.endsWith("/v1") ? url : `${url}/v1`,
			reasoning: meta.reasoning,
			input: meta.input,
			contextWindow: Math.max(Number.isFinite(ctxFromGw) ? ctxFromGw : 0, meta.contextWindow),
			maxTokens: Math.max(Number.isFinite(maxTokFromGw) ? maxTokFromGw : 0, meta.maxTokens),
			cost: normalizeAigwPricing(item.pricing),
			...(meta.thinkingLevelMap ? { thinkingLevelMap: meta.thinkingLevelMap } : {}),
			...(meta.compat ? { compat: meta.compat } : {}),
		};
		if (item.id.toLowerCase().includes("claude")) {
			const wireId = stripPrefix(item.id);
			model = {
				...model,
				id: wireId,
				wireId,
				api: "bedrock-converse-stream",
				baseUrl: `${gateway.origin}/aws`,
				compat: undefined,
			};
		} else if (meta.reasoning && isOpenAiFamily(item.id)) {
			const wireId = stripPrefix(item.id);
			model = {
				...model,
				id: wireId,
				wireId,
				api: "openai-responses",
				baseUrl: openaiResponsesBaseUrl,
				compat: { ...(meta.compat ?? {}), supportsReasoningEffort: true },
			};
		}
		const emittedId = model.id;
		if (!emittedIds.has(emittedId)) {
			emittedIds.add(emittedId);
			models.push(model);
		}
	}
	return { models, wellKnown: null };
}

export async function discoverAigwModels(baseUrl: string): Promise<AigwModel[]> {
	return (await discoverAigwResult(baseUrl)).models;
}

/**
 * Full configure flow: discover models, persist preference, write models.json.
 * Returns the discovered models.
 */
export async function configureAigw(baseUrl: string, prefs: PreferencesStore): Promise<AigwModel[]> {
	const gateway = normalizeHttpUrl(baseUrl);
	const normalizedUrl = gateway.href.replace(/\/$/, "");
	const result = await discoverAigwResult(normalizedUrl);
	// Legacy fallback Claude entries are normalized during discovery. Do not
	// remap authoritative well-known models merely because their ID contains
	// "claude"; their adapter-selected API/baseUrl remains authoritative.
	const models = result.models;

	// Persist generated routing atomically before preference migration. A failed
	// discovery never reaches this point, preserving the previous models.json.
	writeAigwModelsJson(normalizedUrl, models);
	prefs.set("aigw.url", normalizedUrl);
	if (result.wellKnown?.model) seedDefaultModelsFromWellKnown(result.wellKnown, models, prefs);
	normalizeAigwModelPreferences(prefs);
	return models;
}

/**
 * Remove aigw configuration.
 */
export function removeAigw(prefs: PreferencesStore): void {
	prefs.remove("aigw.url");
	prefs.remove("aigw.models");
	removeAigwModelsJson();
}

/**
 * Get the currently configured aigw URL (if any).
 */
export function getAigwUrl(prefs: PreferencesStore): string | undefined {
	return prefs.get("aigw.url") as string | undefined;
}

// getAigwModels() has been removed — model-registry discovers fresh each time
