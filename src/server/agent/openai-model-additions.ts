import fs from "node:fs";
import path from "node:path";

import { getModels } from "@earendil-works/pi-ai";

import { globalAgentDir } from "../bobbit-dir.js";
import type { ApiModel } from "./model-registry.js";

type OpenAIAddition = Omit<ApiModel, "authenticated">;

/**
 * ── OpenAI / OpenAI-Codex model additions ─────────────────────────
 *
 * These entries are merged into the user's `models.json` only when pi-ai does
 * not already ship the same provider/model pair. Once pi-ai adds a model,
 * `writeOpenAIModelAdditions` removes Bobbit-owned duplicate custom entries so
 * stale speculative metadata cannot shadow the built-in registry.
 *
 * Cost values below are best-guess placeholders. The merge is conservative:
 * when an entry already exists in `models.json`, it only overwrites a specific
 * field if that field still equals the value Bobbit previously emitted as the
 * default (tracked in `PREV_DEFAULTS`). This preserves user-edited fields
 * across upgrades — if you tweaked the cost locally, future Bobbit versions
 * won't clobber it.
 *
 * Adding a new revision: when you change a field's default below, append the
 * *previous* default to `PREV_DEFAULTS` (keyed by `${provider}::${id}::${field}`)
 * so existing installs that still carry the previous default get migrated
 * automatically; installs whose users edited the field keep their edits.
 */

// TODO: speculative pricing — confirm with OpenAI dashboard before launch.
const COST_GPT_55 = { input: 5, output: 30, cacheRead: 0, cacheWrite: 0 } as const;
const COST_GPT_55_PRO = { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 } as const;

export const OPENAI_MODEL_ADDITIONS: OpenAIAddition[] = [
	{
		id: "gpt-5.5",
		name: "GPT-5.5",
		provider: "openai",
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh" },
		input: ["text", "image"],
		cost: COST_GPT_55,
	},
	{
		id: "gpt-5.5-pro",
		name: "GPT-5.5 pro",
		provider: "openai",
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		contextWindow: 1_050_000,
		maxTokens: 128_000,
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh" },
		input: ["text", "image"],
		cost: COST_GPT_55_PRO,
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5",
		provider: "openai-codex",
		api: "openai-codex-responses",
		baseUrl: "https://chatgpt.com/backend-api",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh" },
		input: ["text", "image"],
		cost: COST_GPT_55,
	},
	{
		id: "gpt-5.5-pro",
		name: "GPT-5.5 pro",
		provider: "openai-codex",
		api: "openai-codex-responses",
		baseUrl: "https://chatgpt.com/backend-api",
		contextWindow: 1_050_000,
		maxTokens: 128_000,
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh" },
		input: ["text", "image"],
		cost: COST_GPT_55_PRO,
	},
];

/**
 * Previously-emitted default values, keyed by `${provider}::${id}::${field}`.
 * Each entry is an array of *prior* defaults (most-recent first). When merging,
 * if the existing field equals any of these stored defaults, treat it as
 * Bobbit-owned and overwrite; otherwise the user has edited it — keep theirs.
 *
 * Initially empty. Append a row whenever you change a default in
 * `OPENAI_MODEL_ADDITIONS` so existing installs get migrated cleanly.
 */
const PREV_DEFAULTS: Record<string, unknown[]> = {};

export function getOpenAIModelAdditions(provider: string): OpenAIAddition[] {
	return OPENAI_MODEL_ADDITIONS.filter((model) => model.provider === provider);
}

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
		console.error("[openai-model-additions] Failed to read models.json:", err);
	}
	return { providers: {} };
}

function writeModelsJson(data: Record<string, any>): void {
	const p = getModelsJsonPath();
	const dir = path.dirname(p);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	const tmp = `${p}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
		fs.renameSync(tmp, p);
	} catch (err) {
		try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
		throw err;
	}
	if (process.env.BOBBIT_DEBUG) {
		console.log(`[openai-model-additions] Wrote models.json to ${p}`);
	}
}

function valuesEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a == null || b == null) return false;
	if (typeof a !== typeof b) return false;
	if (typeof a === "object") {
		try {
			return JSON.stringify(a) === JSON.stringify(b);
		} catch {
			return false;
		}
	}
	return false;
}

function getBuiltInModel(provider: string, id: string): Record<string, unknown> | undefined {
	try {
		return (getModels(provider as any) as unknown as Array<Record<string, unknown>>).find((m) => m.id === id);
	} catch {
		return undefined;
	}
}

function isBobbitOwned(provider: string, id: string, field: string, currentValue: unknown, currentDefault: unknown): boolean {
	if (valuesEqual(currentValue, currentDefault)) return true;
	const key = `${provider}::${id}::${field}`;
	const prior = PREV_DEFAULTS[key];
	if (!prior) return false;
	return prior.some((v) => valuesEqual(currentValue, v));
}

// Derive the field list from the type rather than hand-listing literals — prevents
// drift between OpenAIAddition's shape and what the merger considers "owned". The
// sample object lives only in the type system; `keyof OpenAIAddition` produces a
// union of property names which `Object.keys` of a typed sample materialises.
const ADDITION_FIELD_SAMPLE: Record<keyof Omit<OpenAIAddition, "id" | "provider">, true> = {
	name: true,
	api: true,
	baseUrl: true,
	reasoning: true,
	thinkingLevelMap: true,
	input: true,
	cost: true,
	contextWindow: true,
	maxTokens: true,
	headers: true,
	compat: true,
};
const ADDITION_FIELDS: Array<keyof OpenAIAddition> = Object.keys(ADDITION_FIELD_SAMPLE) as Array<keyof OpenAIAddition>;

function hasUserEditedField(provider: string, model: OpenAIAddition, existing: Record<string, unknown>): boolean {
	const knownKeys = new Set<string>(["id", ...ADDITION_FIELDS.map(String)]);
	if (Object.keys(existing).some((key) => !knownKeys.has(key))) return true;
	return ADDITION_FIELDS.some((field) => {
		const current = existing[field];
		if (current === undefined) return false;
		const defaultValue = (model as Record<string, unknown>)[field];
		return !isBobbitOwned(provider, model.id, field, current, defaultValue);
	});
}

function syncOrRemoveBuiltInDuplicate(
	provider: string,
	model: OpenAIAddition,
	builtIn: Record<string, unknown>,
	models: Array<Record<string, unknown>>,
	existing: Record<string, unknown>,
): boolean {
	const index = models.indexOf(existing);
	if (index === -1) return false;

	// Pure Bobbit additions should disappear once pi-ai ships the model. Leaving
	// them in `models.json` shadows the built-in entry because pi-coding-agent's
	// custom-model merge is provider+id-last-wins.
	if (!hasUserEditedField(provider, model, existing)) {
		models.splice(index, 1);
		return true;
	}

	// If the user edited one field (for example pricing), keep the custom entry
	// but migrate any still-Bobbit-owned fields to the now-authoritative built-in
	// values so stale context windows do not survive indefinitely.
	let changed = false;
	for (const field of ADDITION_FIELDS) {
		const builtInValue = builtIn[field];
		if (builtInValue === undefined) continue;
		const current = existing[field];
		const defaultValue = (model as Record<string, unknown>)[field];
		if (current === undefined || isBobbitOwned(provider, model.id, field, current, defaultValue)) {
			if (!valuesEqual(current, builtInValue)) {
				existing[field] = builtInValue;
				changed = true;
			}
		}
	}
	return changed;
}

function pruneEmptyProviderBlocks(data: Record<string, any>): boolean {
	let changed = false;
	for (const [provider, config] of Object.entries(data.providers ?? {})) {
		if (
			config &&
			typeof config === "object" &&
			!Array.isArray(config) &&
			Object.keys(config).length === 1 &&
			Array.isArray((config as any).models) &&
			(config as any).models.length === 0
		) {
			delete data.providers[provider];
			changed = true;
		}
	}
	return changed;
}

export function writeOpenAIModelAdditions(): void {
	const data = readModelsJson();
	if (!data.providers) data.providers = {};

	let changed = false;
	for (const model of OPENAI_MODEL_ADDITIONS) {
		const provider = model.provider;
		const builtIn = getBuiltInModel(provider, model.id);
		if (builtIn && !data.providers[provider]) continue;

		if (!data.providers[provider]) data.providers[provider] = {};
		if (!Array.isArray(data.providers[provider].models)) data.providers[provider].models = [];

		const models = data.providers[provider].models as Array<Record<string, unknown>>;
		const existing = models.find((m) => m.id === model.id) as Record<string, unknown> | undefined;

		if (builtIn) {
			if (existing && syncOrRemoveBuiltInDuplicate(provider, model, builtIn, models, existing)) changed = true;
			continue;
		}

		if (!existing) {
			// Entry missing entirely — write the full default payload.
			models.push({
				id: model.id,
				name: model.name,
				api: model.api,
				baseUrl: model.baseUrl,
				reasoning: model.reasoning,
				thinkingLevelMap: model.thinkingLevelMap,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			});
			changed = true;
			continue;
		}

		// Entry exists — write each field only if (a) missing, or (b) the existing
		// value still matches a previously-emitted default (i.e. user hasn't edited it).
		for (const field of ADDITION_FIELDS) {
			const desired = (model as Record<string, unknown>)[field];
			const current = existing[field];
			if (current === undefined) {
				existing[field] = desired;
				changed = true;
				continue;
			}
			if (valuesEqual(current, desired)) continue;
			if (isBobbitOwned(provider, model.id, field, current, desired)) {
				existing[field] = desired;
				changed = true;
			}
			// Otherwise: user has edited this field — preserve their value.
		}
	}

	if (pruneEmptyProviderBlocks(data)) changed = true;
	if (changed) writeModelsJson(data);
}
