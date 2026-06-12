/**
 * Model-gateway manager — handles discovery, models.json generation, and HTTP
 * proxying for an ordered list of named, typed OpenAI-compatible gateways.
 *
 * Each gateway is a {@link ModelGateway} identified by a user-chosen `name`,
 * which is the provider key used EVERYWHERE: the picker `provider`, the
 * `models.json` block key, and `set_model(name, id)`. Two types are supported:
 *
 *   - `aigw`              — enterprise AI-Gateway: Bedrock-routes Claude ids,
 *                           sends the `x-opencode-session` / User-Agent headers,
 *                           and is exclusive (shadows all built-ins + other
 *                           gateways). Pinned to the singleton name "aigw" so
 *                           the three literal `"aigw"` guards in
 *                           pi-ai-bedrock-headers-patch.ts / model-completion.ts
 *                           / shared/thinking-levels.ts stay correct unchanged.
 *   - `openai-compatible` — plain OpenAI gateway (ollama / llama-swap / vLLM …):
 *                           no Bedrock, no special headers, never exclusive.
 *
 * For each enabled gateway the server discovers models (GET /v1/models) and
 * writes one `providers.<name>` block into ~/.bobbit/agent/models.json so agent
 * subprocesses can bind it via `set_model`. Removed / disabled gateways are
 * pruned. The two dispatch tables ({@link DISCOVERY}, PROVIDER_WRITERS) are the
 * documented extension point for future native types (ollama, llama-server …).
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { globalAgentDir } from "../bobbit-dir.js";
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
	id: string;
	name: string;
	api: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost?: AigwModelCost;
	compat?: Record<string, unknown>;
}

export interface AigwConfig {
	url: string;
	models: AigwModel[];
}

/**
 * The discovery/request-shaping family a gateway belongs to. Only `aigw` and
 * `openai-compatible` are implemented now; new native types (e.g. `ollama`,
 * `llama-server`) slot in by extending this union plus the two dispatch tables
 * (see §10 of docs/design/multi-gateway-providers.md).
 */
export type GatewayType = "aigw" | "openai-compatible";

export interface ModelGateway {
	/** Stable identity (crypto.randomUUID()); never shown, used only as a UI row key. */
	id: string;
	/** Provider key used EVERYWHERE: picker `provider`, models.json block key, set_model(name, id). */
	name: string;
	/** Base URL as the user entered it (may or may not end with /v1). */
	url: string;
	type: GatewayType;
	enabled: boolean;
}

// ── Well-known model metadata ──────────────────────────────────────

interface ModelMeta {
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	input: ("text" | "image")[];
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

function normalizeAigwPricing(pricing: unknown): AigwModelCost {
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
	meta: Omit<ModelMeta, "compat">;
};

const INFER_RULES: InferRule[] = [
	// ── Anthropic Claude (most-specific size first) ─────────────────
	{ test: /claude-opus/, meta: { contextWindow: 1_000_000, maxTokens: 32_768, reasoning: true, input: ["text", "image"] } },
	{ test: /claude-sonnet/, meta: { contextWindow: 1_000_000, maxTokens: 16_384, reasoning: true, input: ["text", "image"] } },
	{ test: /claude-haiku/, meta: { contextWindow: 200_000, maxTokens: 8_192, reasoning: false, input: ["text", "image"] } },
	{ test: /claude/, meta: { contextWindow: 200_000, maxTokens: 16_384, reasoning: false, input: ["text", "image"] } },

	// ── OpenAI GPT-5.x (pro first so it doesn't match base variants) ─
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

	// ── Alibaba Qwen ────────────────────────────────────────────────
	{ test: /qwen/, meta: { contextWindow: 1_000_000, maxTokens: 32_768, reasoning: false, input: ["text"] } },
];

export function inferMeta(modelId: string): ModelMeta {
	const id = modelId.toLowerCase();
	for (const rule of INFER_RULES) {
		const matched = typeof rule.test === "function" ? rule.test(id) : rule.test.test(id);
		if (matched) {
			return { ...rule.meta, compat: GATEWAY_COMPAT };
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
	}
}

/**
 * Parse model IDs from pi-ai's models.generated.js, grouped by provider.
 * Reads the file as text and extracts id+provider pairs via regex.
 */
function parseModelsGenerated(): Map<string, string[]> {
	const providerModels = new Map<string, string[]>();
	try {
		const pkgUrl = import.meta.resolve("@earendil-works/pi-ai");
		const pkgDir = path.dirname(fileURLToPath(pkgUrl));
		const modelsPath = path.join(pkgDir, "models.generated.js");
		const text = fs.readFileSync(modelsPath, "utf-8");

		// The file has entries like:
		//   "some-model-id": {
		//       id: "some-model-id",
		//       ...
		//       provider: "amazon-bedrock",
		// We extract (id, provider) pairs.
		const entryRegex = /"([^"]+)":\s*\{[^}]*?provider:\s*"([^"]+)"/g;
		let match: RegExpExecArray | null;
		while ((match = entryRegex.exec(text)) !== null) {
			const modelId = match[1];
			const provider = match[2];
			if (!providerModels.has(provider)) providerModels.set(provider, []);
			providerModels.get(provider)!.push(modelId);
		}
	} catch (err) {
		console.error("[aigw-manager] Failed to parse models.generated.js:", err);
	}
	return providerModels;
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
export function writeContextWindowOverrides(): void {
	const providerModels = parseModelsGenerated();
	const targetProviders = ["amazon-bedrock", "anthropic"];

	const data = readModelsJson();
	if (!data.providers) data.providers = {};

	let overridesWritten = 0;

	for (const provider of targetProviders) {
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

	if (overridesWritten > 0) {
		writeModelsJson(data);
		console.log(`[aigw-manager] Wrote ${overridesWritten} contextWindow overrides to models.json`);
	} else {
		console.log("[aigw-manager] No contextWindow overrides needed");
	}
}

// ── Bedrock environment ────────────────────────────────────────────

/**
 * Set env vars so agent subprocesses route Bedrock calls through an `aigw`
 * gateway. Called from {@link syncGatewaysModelsJson} (and the startup check)
 * when an enabled `aigw`-type gateway is present.
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

/**
 * Clear the four AWS_* vars set by {@link setBedrockEnvVars}. Called when no
 * enabled `aigw`-type gateway exists so disabling the gateway restores a real
 * `amazon-bedrock` provider in the same process. `AWS_REGION` is intentionally
 * left alone (it may be a genuine user setting, and setBedrockEnvVars only sets
 * it when previously unset).
 */
function clearBedrockEnvVars(): void {
	if (process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME !== undefined) {
		console.log("[aigw] No enabled aigw-type gateway — clearing Bedrock env");
	}
	delete process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
	delete process.env.AWS_BEDROCK_FORCE_HTTP1;
	delete process.env.AWS_ACCESS_KEY_ID;
	delete process.env.AWS_SECRET_ACCESS_KEY;
}

/**
 * Set Bedrock env from the (first) enabled `aigw`-type gateway, or clear it when
 * none is present. The single point that owns Bedrock env so merged mode never
 * hijacks a real `amazon-bedrock` provider.
 */
function applyAigwBedrockEnv(aigwGateway: ModelGateway | undefined): void {
	if (aigwGateway) setBedrockEnvVars(aigwGateway.url);
	else clearBedrockEnvVars();
}

// ── Type predicates + URL helpers ──────────────────────────────────

/** Whether a model id should be Bedrock-routed (Claude family). */
export function isClaudeId(id: string): boolean {
	return id.toLowerCase().includes("claude");
}

/** Strip a leading `provider/` prefix, e.g. "aws/us.anthropic.x" → "us.anthropic.x". */
export function stripProviderPrefix(id: string): string {
	const i = id.indexOf("/");
	return i >= 0 ? id.slice(i + 1) : id;
}

/**
 * Whether a gateway type Bedrock-routes Claude ids. Only `aigw` does — this is
 * the property that makes Claude→Bedrock routing local to the `aigw` type and
 * removes the old global heuristic (an `openai-compatible` gateway exposing a
 * model literally named `claude-*` must NEVER be Bedrock-routed).
 */
export function bedrockRoutesForType(t: GatewayType): boolean {
	return t === "aigw";
}

/** Strip trailing slashes; append `/v1` unless already present. */
function normalizeOpenAiBaseUrl(url: string): string {
	const trimmed = url.replace(/\/+$/, "");
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

// ── Type-driven models.json writers ────────────────────────────────

type ProviderBlock = Record<string, unknown>;
type GatewayWriter = (gateway: ModelGateway, models: AigwModel[]) => ProviderBlock;

/**
 * Build the `aigw`-type provider block. Byte-for-byte the behavior of the old
 * single-URL writer, keyed by `gateway.name` and reading `gateway.url`:
 *   - provider-level `x-opencode-session` / User-Agent headers,
 *   - Claude ids → prefix stripped + `bedrock-converse-stream` + per-model
 *     `<url-without-/v1>/aws` baseUrl,
 *   - non-Claude ids → `openai-completions` with conservative compat flags.
 * Does NOT touch Bedrock env — {@link syncGatewaysModelsJson} owns that.
 */
export function buildAigwProviderBlock(gateway: ModelGateway, models: AigwModel[]): ProviderBlock {
	const normalizedUrl = gateway.url.replace(/\/+$/, "");
	// Bedrock Converse traffic goes to <gateway>/aws/model/<id>/converse-stream;
	// the provider's normalized baseUrl ends in /v1 for the OpenAI-compatible path
	// and is wrong for Bedrock. pi-ai uses `model.baseUrl` directly as the
	// `BedrockRuntimeClient` endpoint, so emit a per-model override on Claude
	// entries pointing at the /aws sub-tree.
	const bedrockBaseUrl = normalizedUrl.replace(/\/v1$/, "") + "/aws";

	const openaiCompat: Record<string, unknown> = {
		supportsDeveloperRole: false,
		supportsStore: false,
		supportsUsageInStreaming: false,
		supportsReasoningEffort: false,
		supportsStrictMode: false,
		maxTokensField: "max_tokens",
	};

	return {
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
			if (isClaudeId(m.id)) {
				return {
					id: stripProviderPrefix(m.id),
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
					...(m.compat ? { compat: m.compat } : {}),
				};
			}
			return {
				id: m.id,
				name: m.name,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				reasoning: m.reasoning,
				input: m.input,
				cost,
				compat: { ...openaiCompat, ...(m.compat || {}) },
			};
		}),
	};
}

/**
 * Build an `openai-compatible` provider block. Plain OpenAI for EVERY model —
 * including a model literally named `claude-*` (the key fix to the latent
 * multi-gateway bug). No headers, no Bedrock, baseUrl normalized to end `/v1`.
 */
export function buildOpenAiCompatibleProviderBlock(gateway: ModelGateway, models: AigwModel[]): ProviderBlock {
	return {
		baseUrl: normalizeOpenAiBaseUrl(gateway.url),
		apiKey: "none",
		api: "openai-completions",
		models: models.map(m => ({
			id: m.id,
			name: m.name,
			// Plain OpenAI for EVERY model — never bedrock-converse-stream, even for
			// a model literally named claude-*. Explicit per-model `api` so the
			// no-Bedrock guarantee is visible on each entry, not just inherited.
			api: "openai-completions",
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			reasoning: m.reasoning,
			input: m.input,
			cost: m.cost ?? zeroAigwCost(),
			compat: { ...GATEWAY_COMPAT, ...(m.compat || {}) },
		})),
	};
}

/**
 * Per-type provider-block writers. Extension point for future native types
 * (see §10 of docs/design/multi-gateway-providers.md): register a new writer
 * here keyed by the new {@link GatewayType}.
 */
const PROVIDER_WRITERS: Record<GatewayType, GatewayWriter> = {
	"aigw": buildAigwProviderBlock,
	"openai-compatible": buildOpenAiCompatibleProviderBlock,
};

/**
 * Per-type discovery. Both implemented types use the same `GET /v1/models`
 * shape for now; a future native type registers its own protocol fn here.
 */
const DISCOVERY: Record<GatewayType, (url: string) => Promise<AigwModel[]>> = {
	"aigw": discoverAigwModels,
	"openai-compatible": discoverAigwModels,
};

/** Discover a gateway's models via the dispatch table for its type. */
export function discoverGatewayModels(g: ModelGateway): Promise<AigwModel[]> {
	return DISCOVERY[g.type](g.url);
}

// ── Gateway list preferences ───────────────────────────────────────

const GATEWAYS_PREF_KEY = "modelGateways";
/** Internal bookkeeping pref — the gateway names we last wrote into models.json. */
const MANAGED_PROVIDERS_PREF_KEY = "_managedGatewayProviders";

const GATEWAY_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

/**
 * pi-ai built-in provider ids a gateway `name` must not collide with. Mirrors
 * `model-registry.ts::ENV_MAP` (kept inline to avoid a registry↔manager import
 * cycle). Note "aigw" is intentionally NOT here — it is the reserved singleton
 * name for the `aigw`-type gateway.
 */
const BUILTIN_PROVIDER_IDS = new Set([
	"anthropic",
	"openai",
	"google",
	"google-gemini-cli",
	"google-vertex",
	"xai",
	"amazon-bedrock",
	"groq",
	"mistral",
]);

/** Parse + sanitise one persisted row into a ModelGateway, or undefined if malformed. */
function parseGatewayRow(row: unknown): ModelGateway | undefined {
	if (!row || typeof row !== "object") return undefined;
	const o = row as Record<string, unknown>;
	if (typeof o.name !== "string" || typeof o.url !== "string") return undefined;
	const type = o.type === "aigw" || o.type === "openai-compatible" ? o.type : undefined;
	if (!type) return undefined;
	return {
		id: typeof o.id === "string" && o.id ? o.id : randomUUID(),
		name: o.name,
		url: o.url,
		type,
		enabled: typeof o.enabled === "boolean" ? o.enabled : true,
	};
}

/** Full gateway list (incl. disabled). Defensive: `[]` for any non-array / malformed value. */
export function listGateways(prefs: PreferencesStore): ModelGateway[] {
	const raw = prefs.get(GATEWAYS_PREF_KEY);
	if (!Array.isArray(raw)) return [];
	const out: ModelGateway[] = [];
	for (const row of raw) {
		const g = parseGatewayRow(row);
		if (g) out.push(g);
	}
	return out;
}

/** Only enabled gateways. */
export function getEnabledGateways(prefs: PreferencesStore): ModelGateway[] {
	return listGateways(prefs).filter(g => g.enabled);
}

/** Look up a gateway by its `name` (provider key), or undefined. */
export function getGatewayByName(prefs: PreferencesStore, name: string): ModelGateway | undefined {
	return listGateways(prefs).find(g => g.name === name);
}

/**
 * Exclusive mode is DERIVED, not a manual toggle: any enabled `aigw`-type
 * gateway makes the whole setup exclusive (built-ins + `openai-compatible`
 * gateways are suppressed; only `aigw`-type contributes).
 */
export function isExclusiveMode(gateways: ModelGateway[]): boolean {
	return gateways.some(g => g.enabled && g.type === "aigw");
}

/**
 * Validate and persist the gateway list (replaces the whole list). Fills any
 * missing `id` with a fresh UUID. Throws on any §1 violation:
 *   - name empty / not matching `^[a-zA-Z0-9._-]+$`,
 *   - name colliding with a built-in provider id,
 *   - duplicate names (case-sensitive),
 *   - an `aigw`-type gateway named ≠ "aigw", or more than one `aigw`-type row.
 */
export function saveGateways(prefs: PreferencesStore, gateways: ModelGateway[]): void {
	const seen = new Set<string>();
	let aigwCount = 0;
	const normalized: ModelGateway[] = [];

	for (const g of gateways) {
		const name = (g?.name ?? "").trim();
		if (!name) throw new Error("Gateway name must not be empty");
		if (!GATEWAY_NAME_PATTERN.test(name)) {
			throw new Error(`Invalid gateway name "${name}": must match ${GATEWAY_NAME_PATTERN.source}`);
		}
		if (BUILTIN_PROVIDER_IDS.has(name)) {
			throw new Error(`Gateway name "${name}" collides with a built-in provider id`);
		}
		if (seen.has(name)) throw new Error(`Duplicate gateway name "${name}"`);
		seen.add(name);

		if (g.type !== "aigw" && g.type !== "openai-compatible") {
			throw new Error(`Invalid gateway type "${String(g.type)}" for "${name}"`);
		}
		if (g.type === "aigw") {
			aigwCount++;
			if (name !== "aigw") {
				throw new Error(`An aigw-type gateway must be named "aigw" (got "${name}")`);
			}
			if (aigwCount > 1) throw new Error("At most one aigw-type gateway is allowed");
		}

		normalized.push({
			id: typeof g.id === "string" && g.id ? g.id : randomUUID(),
			name,
			url: (g.url ?? "").trim(),
			type: g.type,
			enabled: g.enabled !== false,
		});
	}

	prefs.set(GATEWAYS_PREF_KEY, normalized);
}

/**
 * Idempotent boot-time migration of the legacy single-URL prefs
 * (`aigw.url` [+ `aigw.exclusive`]) into the `modelGateways` list. Called once
 * at server boot before {@link startupAigwCheck}.
 *
 * Rules:
 *   1. `modelGateways` already present (even []) → no-op; defensively strip any
 *      leftover `aigw.url` / `aigw.exclusive`.
 *   2. Non-empty `aigw.url` → create one `{name:"aigw", type:"aigw"}` gateway,
 *      remove `aigw.url` + `aigw.exclusive` (exclusivity is now derived, §4).
 *   3. Nothing to migrate → leave prefs untouched (readers treat absent as []).
 *
 * The migrated gateway keeps `name:"aigw"`, so existing
 * `default.sessionModel = "aigw/<id>"` (etc.) continue to resolve unchanged.
 */
export function migrateGatewayPrefs(prefs: PreferencesStore): { migrated: boolean; gateways: ModelGateway[] } {
	const existing = prefs.get(GATEWAYS_PREF_KEY);
	if (existing !== undefined) {
		// Already on the new schema — no-op, but strip any stale legacy keys.
		prefs.remove("aigw.url");
		prefs.remove("aigw.exclusive");
		return { migrated: false, gateways: listGateways(prefs) };
	}

	const aigwUrl = prefs.get("aigw.url");
	if (typeof aigwUrl === "string" && aigwUrl.trim()) {
		const gateways: ModelGateway[] = [{
			id: randomUUID(),
			name: "aigw",
			url: aigwUrl.replace(/\/+$/, ""),
			type: "aigw",
			enabled: true,
		}];
		prefs.set(GATEWAYS_PREF_KEY, gateways);
		prefs.remove("aigw.url");
		prefs.remove("aigw.exclusive");
		console.log("[aigw] Migrated legacy aigw.url → modelGateways list");
		return { migrated: true, gateways };
	}

	return { migrated: false, gateways: [] };
}

// ── models.json sync orchestrator ──────────────────────────────────

function readManagedProviders(prefs: PreferencesStore): string[] {
	const v = prefs.get(MANAGED_PROVIDERS_PREF_KEY);
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Discover the enabled gateways and (re)write their `providers.<name>` blocks
 * into models.json, pruning everything we previously managed, never clobbering
 * unrelated providers (anthropic / amazon-bedrock / custom). Preserves the
 * last-good block for a gateway that is unreachable this run. Sets/clears the
 * Bedrock env based on the presence of an enabled `aigw`-type gateway.
 *
 * @returns discovered models keyed by gateway name (empty array on failure).
 */
export async function syncGatewaysModelsJson(prefs: PreferencesStore): Promise<Record<string, AigwModel[]>> {
	const gateways = listGateways(prefs);
	const enabled = gateways.filter(g => g.enabled);
	const enabledNames = new Set(enabled.map(g => g.name));

	const data = readModelsJson();
	if (!data.providers) data.providers = {};
	const existingBlocks: Record<string, any> = { ...data.providers };

	// Prune: the keys we own = previously-managed names ∪ {"aigw"} (legacy
	// single-URL block). Any owned key no longer enabled is removed — this
	// handles disabled, removed, and renamed gateways without the previous list.
	const owned = new Set<string>([...readManagedProviders(prefs), "aigw"]);
	for (const key of owned) {
		if (!enabledNames.has(key)) delete data.providers[key];
	}

	const discovered: Record<string, AigwModel[]> = {};
	for (const g of enabled) {
		try {
			const models = await DISCOVERY[g.type](g.url);
			data.providers[g.name] = PROVIDER_WRITERS[g.type](g, models);
			discovered[g.name] = models;
		} catch (err: any) {
			const msg = err?.message || String(err);
			if (existingBlocks[g.name] !== undefined) {
				// Keep the last-good block (preserves the "gateway unreachable on
				// startup ⇒ keep existing models.json" behavior).
				data.providers[g.name] = existingBlocks[g.name];
				console.warn(`[aigw] gateway unreachable on startup (${msg}), keeping existing models.json for "${g.name}"`);
			} else {
				console.warn(`[aigw] gateway "${g.name}" unreachable (${msg}), no existing models to keep`);
			}
			discovered[g.name] = [];
		}
	}

	// Bedrock env is owned here so merged mode never hijacks a real bedrock provider.
	applyAigwBedrockEnv(enabled.find(g => g.type === "aigw"));

	writeModelsJson(data);
	prefs.set(MANAGED_PROVIDERS_PREF_KEY, [...enabledNames]);
	return discovered;
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
export async function checkInternetAvailable(): Promise<boolean> {
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
 * Run once at gateway startup (list-aware):
 *   - Defensively run {@link migrateGatewayPrefs} (idempotent — boot also runs
 *     it earlier; this keeps standalone callers / tests robust).
 *   - If any gateway is enabled, set/clear Bedrock env, wire PI_OFFLINE, and
 *     (unless `BOBBIT_SKIP_AIGW_DISCOVERY`) re-run {@link syncGatewaysModelsJson}.
 *   - Else, when offline, probe well-known local URLs and, if a gateway is
 *     found, create a `{type:"aigw"}` gateway and sync.
 *
 * Returns true if any gateway is active after this call.
 */
export async function startupAigwCheck(prefs: PreferencesStore): Promise<boolean> {
	migrateGatewayPrefs(prefs);

	const enabled = getEnabledGateways(prefs);

	if (enabled.length > 0) {
		// Already configured — set/clear Bedrock env up-front (so it is correct
		// even when re-discovery is skipped) and refresh models.json.
		applyAigwBedrockEnv(enabled.find(g => g.type === "aigw"));
		console.log("[aigw] gateways configured:", enabled.map(g => `${g.name} (${g.type})`).join(", "));

		// Users with a local gateway are typically offline; probe the public
		// internet once and wire PI_OFFLINE accordingly.
		if (!process.env.BOBBIT_SKIP_AIGW_DISCOVERY) {
			try {
				const hasInternet = await checkInternetAvailable();
				applyPiOfflineEnv(hasInternet);
			} catch {
				applyPiOfflineEnv(false);
			}
		}

		if (process.env.BOBBIT_SKIP_AIGW_DISCOVERY) {
			console.log("[aigw] gateways configured, skipping startup re-discovery (BOBBIT_SKIP_AIGW_DISCOVERY)");
			return true;
		}

		await syncGatewaysModelsJson(prefs);
		console.log("[aigw] re-discovered gateway models on startup, refreshed models.json");
		return true;
	}

	// No gateways configured. Skip network probing + local auto-discovery when
	// tests/CI opt out.
	if (process.env.BOBBIT_SKIP_AIGW_DISCOVERY) return false;

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
				const normalizedUrl = url.replace(/\/+$/, "");
				console.log(`[aigw] Found gateway at ${normalizedUrl} with ${models.length} models — auto-configuring`);
				saveGateways(prefs, [{
					id: randomUUID(),
					name: "aigw",
					url: normalizedUrl,
					type: "aigw",
					enabled: true,
				}]);
				await syncGatewaysModelsJson(prefs);
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

/**
 * Simple HTTP GET that returns a parsed JSON body.
 * Works with both http:// and https:// URLs.
 */
function httpGet(url: string, timeoutMs = 10_000): Promise<any> {
	return new Promise((resolve, reject) => {
		const parsedUrl = new URL(url);
		const transport = parsedUrl.protocol === "https:" ? https : http;

		const req = transport.request(parsedUrl, { method: "GET", headers: aigwUserAgentHeaders(), timeout: timeoutMs }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => {
				const body = Buffer.concat(chunks).toString("utf-8");
				if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
					try { resolve(JSON.parse(body)); }
					catch { reject(new Error(`Invalid JSON from ${url}`)); }
				} else {
					reject(new Error(`HTTP ${res.statusCode} from ${url}: ${body.slice(0, 200)}`));
				}
			});
		});
		req.on("timeout", () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
		req.on("error", reject);
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

// ── Public API ─────────────────────────────────────────────────────

/**
 * Fetch the model list from a gateway endpoint and return structured model info.
 * Hits GET {baseUrl}/v1/models (or {baseUrl}/models if baseUrl already ends with /v1).
 * Returns raw ids (no prefix stripping) — the type-driven writers/registry decide
 * how to normalise them.
 */
export async function discoverAigwModels(baseUrl: string): Promise<AigwModel[]> {
	const url = baseUrl.replace(/\/+$/, "");
	const modelsUrl = url.endsWith("/v1") ? `${url}/models` : `${url}/v1/models`;

	const data = await httpGet(modelsUrl);
	if (!data?.data || !Array.isArray(data.data)) {
		throw new Error("Unexpected response format from /v1/models — expected { data: [...] }");
	}

	return data.data.map((m: any) => {
		const meta = inferMeta(m.id);
		// Honour fields if the gateway provides them
		const ctxFromGw = m.context_length || m.context_window;
		const maxTokFromGw = m.max_tokens || m.max_completion_tokens;
		return {
			id: m.id,
			name: deriveName(m.id),
			api: "openai-completions",
			reasoning: meta.reasoning,
			input: meta.input,
			contextWindow: Math.max(ctxFromGw || 0, meta.contextWindow),
			maxTokens: Math.max(maxTokFromGw || 0, meta.maxTokens),
			cost: normalizeAigwPricing(m.pricing),
			...(meta.compat ? { compat: meta.compat } : {}),
		};
	});
}
