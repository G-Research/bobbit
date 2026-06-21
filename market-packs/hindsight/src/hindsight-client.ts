/**
 * Hindsight REST client (EP G2 / external mode).
 *
 * A thin, faithful mapping over the Hindsight HTTP API
 * (`/v1/{namespace}/banks/{bank}/…`, default namespace `default`, port 8888).
 * Request/response bodies are mapped per the upstream `openapi.json`
 * (Hindsight 0.8.x) — see docs/design/hindsight-pack-external.md §3.
 *
 * Design rules (do not soften — they are pinned by tests/hindsight-client.test.ts):
 *   - Every method arms an AbortController with `cfg.timeoutMs` (default 4000ms);
 *     an abort surfaces as `HindsightError{ kind:"timeout" }` thrown WITHIN budget.
 *   - Non-2xx ⇒ `HindsightError{ kind:"http", status }`.
 *   - DNS/connection/socket failure ⇒ `HindsightError{ kind:"network" }`.
 *   - The `Authorization: Bearer <apiKey>` header is sent ONLY when `cfg.apiKey`
 *     is set.
 *   - With the SOLE exception of `health()` (a pure reachability probe that maps
 *     every failure to `{ ok:false }`), the client never swallows errors —
 *     dormancy and skip-on-failure are the PROVIDER's job, so the client surface
 *     stays a faithful mapping.
 *
 * This module is hand-authored TS compiled to confined-worker Node ESM
 * (`lib/hindsight-client.mjs`) via scripts/build-market-packs.mjs.
 */

export type HindsightErrorKind = "timeout" | "http" | "network";

/** Typed error surfaced by every data operation (see module header). */
export class HindsightError extends Error {
	readonly kind: HindsightErrorKind;
	/** Present for `kind:"http"` — the upstream HTTP status code. */
	readonly status?: number;

	constructor(kind: HindsightErrorKind, message: string, status?: number) {
		super(message);
		this.name = "HindsightError";
		this.kind = kind;
		this.status = status;
		// Restore prototype chain for `instanceof` after transpilation to ES5-ish.
		Object.setPrototypeOf(this, HindsightError.prototype);
	}
}

export type TagsMatch = "any" | "all" | "any_strict" | "all_strict";
export type RecallType = "observation" | "world" | "experience";
export type RecallBudget = "low" | "mid" | "high";
export type UpdateMode = "replace" | "append";

export interface EntityInput {
	text: string;
	type?: string;
}

export interface RecallMemory {
	text: string;
	score?: number;
	id?: string;
}

export interface RecallResult {
	memories: RecallMemory[];
}

export interface RecallInclude {
	entities?: null | Record<string, unknown>;
	chunks?: null | Record<string, unknown>;
	source_facts?: null | Record<string, unknown>;
}

export interface RecallOptions {
	maxTokens?: number;
	budget?: RecallBudget;
	tags?: Record<string, string>;
	tagsMatch?: TagsMatch;
	/** Hindsight `types` filter (fact types to recall): biases recall toward
	 *  consolidated `observation`s plus `world`/`experience`. Omitted ⇒ upstream
	 *  default (world + experience). */
	types?: RecallType[];
	/** Optional per-request include block. Omitted by default so `include.chunks`
	 *  stays disabled in Hindsight 0.8.3 unless a caller explicitly opts in. */
	include?: RecallInclude;
	/** ISO timestamp anchor for relative-time queries (maps to `query_timestamp`). */
	queryTimestamp?: string;
	trace?: boolean;
}

/** Bank-config mission updates (PATCH …/banks/{bank}/config body `{ updates }`). */
export interface BankConfigUpdates {
	retain_mission?: string;
	observations_mission?: string;
	reflect_mission?: string;
}

export interface RetainOptions {
	tags?: Record<string, string>;
	/** When true the upstream extraction runs synchronously (`async:false`). */
	sync?: boolean;
	documentId?: string;
	updateMode?: UpdateMode;
	entities?: EntityInput[];
	/** Event timestamp, mapped to item-level `timestamp`. */
	timestamp?: string;
	/** Hindsight observation scopes; project scopes are nested, e.g. `[["project:p1"]]`. */
	observationScopes?: string | string[][];
	metadata?: Record<string, string>;
}

export interface ReflectOptions {
	/** Tag filter applied during reflection (maps to scope on the shared bank). */
	tags?: Record<string, string>;
	tagsMatch?: TagsMatch;
	responseSchema?: Record<string, unknown>;
	factTypes?: RecallType[];
	budget?: RecallBudget;
	maxTokens?: number;
	include?: RecallInclude;
	excludeMentalModels?: boolean;
	excludeMentalModelIds?: string[];
}

export interface ReflectResult {
	text: string;
	structuredOutput?: unknown;
}

export type MentalModelTrigger = Record<string, unknown>;

export interface MentalModel {
	id: string;
	name?: string;
	content?: string;
	tags?: string[];
	source_query?: string;
	max_tokens?: number;
	trigger?: MentalModelTrigger;
	last_refreshed_at?: string | null;
	reflect_response?: unknown;
	is_stale?: boolean;
	operation_id?: string;
}

export interface CreateMentalModelOptions {
	id?: string;
	name: string;
	sourceQuery: string;
	tags?: string[];
	maxTokens?: number;
	trigger?: MentalModelTrigger;
}

export interface CreateMentalModelResult {
	mentalModelId?: string;
	operationId?: string;
}

export interface EnsureMentalModelResult {
	model: MentalModel | null;
	created: boolean;
	operationId?: string;
}

export interface Directive {
	id: string;
	name?: string;
	content?: string;
	priority?: number;
	is_active?: boolean;
	tags?: string[];
}

export interface DirectiveInput {
	name: string;
	content: string;
	priority?: number;
	isActive?: boolean;
	tags?: string[];
}

export interface OperationRecord {
	id: string;
	status?: string;
	type?: string;
	created_at?: string;
	updated_at?: string;
	[key: string]: unknown;
}

export interface LlmHealthResponse {
	ok?: boolean;
	retain?: { ok?: boolean; [key: string]: unknown };
	consolidation?: { ok?: boolean; [key: string]: unknown };
	reflect?: { ok?: boolean; [key: string]: unknown };
	[key: string]: unknown;
}

export interface HindsightClient {
	health(): Promise<{ ok: boolean }>;
	/** Idempotent create-or-update — call before the first retain. PUT …/banks/{bank}. */
	ensureBank(bank: string): Promise<void>;
	recall(bank: string, query: string, opts?: RecallOptions): Promise<RecallResult>;
	/** POST …/memories. Resolves on a 2xx (extraction is async upstream). */
	retain(bank: string, content: string, opts?: RetainOptions): Promise<void>;
	reflect(bank: string, prompt: string, opts?: ReflectOptions): Promise<ReflectResult>;
	listBanks(): Promise<{ banks: string[] }>;
	/** Idempotent bank-config mission update. PATCH …/banks/{bank}/config. */
	updateBankConfig(bank: string, updates: BankConfigUpdates): Promise<void>;
	getMentalModel(bank: string, id: string): Promise<MentalModel | null>;
	listMentalModels(bank: string): Promise<{ items: MentalModel[] }>;
	createMentalModel(bank: string, opts: CreateMentalModelOptions): Promise<CreateMentalModelResult>;
	ensureMentalModel(bank: string, opts: CreateMentalModelOptions): Promise<EnsureMentalModelResult>;
	updateMentalModel(bank: string, id: string, patch: Partial<CreateMentalModelOptions> & Record<string, unknown>): Promise<MentalModel>;
	refreshMentalModel(bank: string, id: string): Promise<{ operationId?: string }>;
	clearMentalModel(bank: string, id: string): Promise<{ operationId?: string }>;
	getMentalModelHistory(bank: string, id: string): Promise<{ history: unknown[] }>;
	listDirectives(bank: string): Promise<{ items: Directive[] }>;
	createDirective(bank: string, directive: DirectiveInput): Promise<Directive>;
	updateDirective(bank: string, id: string, patch: Partial<DirectiveInput>): Promise<Directive>;
	deleteDirective(bank: string, id: string): Promise<void>;
	llmHealth(bank: string): Promise<LlmHealthResponse>;
	listOperations(bank: string): Promise<{ items: OperationRecord[] }>;
	retryOperation(bank: string, id: string): Promise<OperationRecord | { ok: boolean }>;
	deleteOperation(bank: string, id: string): Promise<void>;
	invalidateMemory(bank: string, id: string, reason: string): Promise<void>;
	getMemoryHistory(bank: string, id: string): Promise<{ history: unknown[] }>;
	deleteMemoryObservations(bank: string, id: string): Promise<void>;
}

export interface HindsightClientConfig {
	baseUrl: string;
	apiKey?: string;
	/** Default `default`. */
	namespace?: string;
	/** Per-request abort budget in ms. Default 4000. */
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_NAMESPACE = "default";

/** Flatten `{ "project": "abc" }` → `["project:abc"]`, sorted for determinism. */
function flattenTags(tags?: Record<string, string>): string[] {
	if (!tags) return [];
	return Object.keys(tags)
		.sort()
		.map((k) => `${k}:${tags[k]}`);
}

function mentalModelCreateBody(opts: CreateMentalModelOptions): Record<string, unknown> {
	const body: Record<string, unknown> = {
		name: opts.name,
		source_query: opts.sourceQuery,
	};
	if (opts.id) body.id = opts.id;
	if (opts.tags && opts.tags.length > 0) body.tags = [...opts.tags];
	if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
	if (opts.trigger !== undefined) body.trigger = opts.trigger;
	return body;
}

function mentalModelPatchBody(patch: Partial<CreateMentalModelOptions> & Record<string, unknown>): Record<string, unknown> {
	const body: Record<string, unknown> = { ...patch };
	if (patch.sourceQuery !== undefined) {
		body.source_query = patch.sourceQuery;
		delete body.sourceQuery;
	}
	if (patch.maxTokens !== undefined) {
		body.max_tokens = patch.maxTokens;
		delete body.maxTokens;
	}
	return body;
}

function directiveBody(input: Partial<DirectiveInput>): Record<string, unknown> {
	const body: Record<string, unknown> = { ...input };
	if (input.isActive !== undefined) {
		body.is_active = input.isActive;
		delete body.isActive;
	}
	return body;
}

export function createClient(cfg: HindsightClientConfig): HindsightClient {
	const baseUrl = cfg.baseUrl.replace(/\/+$/, "");
	const namespace = cfg.namespace && cfg.namespace.length > 0 ? cfg.namespace : DEFAULT_NAMESPACE;
	const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const nsSeg = encodeURIComponent(namespace);

	function bankBase(bank: string): string {
		return `${baseUrl}/v1/${nsSeg}/banks/${encodeURIComponent(bank)}`;
	}

	function buildHeaders(hasBody: boolean): Record<string, string> {
		const headers: Record<string, string> = {};
		if (hasBody) headers["Content-Type"] = "application/json";
		// Auth header ONLY when an api key is configured (pinned both branches).
		if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;
		return headers;
	}

	/** Single fetch wrapper: arms the timeout, maps transport failures to typed errors. */
	async function rawFetch(
		method: string,
		url: string,
		body?: unknown,
	): Promise<Response> {
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
		try {
			return await fetch(url, {
				method,
				headers: buildHeaders(body !== undefined),
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal: controller.signal,
			});
		} catch (err) {
			if (timedOut) {
				throw new HindsightError("timeout", `Hindsight request timed out after ${timeoutMs}ms`);
			}
			const message = err instanceof Error ? err.message : String(err);
			throw new HindsightError("network", `Hindsight network error: ${message}`);
		} finally {
			clearTimeout(timer);
		}
	}

	/** Best-effort extract the upstream error `detail` (or raw body) so the typed
	 *  HindsightError message carries it — e.g. recall's 400 "Query too long: <N>
	 *  tokens exceeds maximum of 500", which the provider/route soft-skips. Never
	 *  throws; returns "" when the body is empty/unreadable. */
	async function errorDetail(res: Response): Promise<string> {
		try {
			const text = await res.text();
			if (!text) return "";
			try {
				const parsed = JSON.parse(text) as { detail?: unknown };
				return typeof parsed?.detail === "string" ? parsed.detail : text;
			} catch {
				return text;
			}
		} catch {
			return "";
		}
	}

	/** Fetch + 2xx assertion; returns the Response for the caller to parse. */
	async function request(method: string, url: string, body?: unknown): Promise<Response> {
		const res = await rawFetch(method, url, body);
		if (!res.ok) {
			const detail = await errorDetail(res);
			const suffix = detail ? `: ${detail}` : "";
			throw new HindsightError("http", `Hindsight HTTP ${res.status} for ${method} ${url}${suffix}`, res.status);
		}
		return res;
	}

	async function requestJson<T>(method: string, url: string, body?: unknown): Promise<T> {
		const res = await request(method, url, body);
		return (await res.json()) as T;
	}

	async function requestMaybeJson<T>(method: string, url: string, body?: unknown): Promise<T | undefined> {
		const res = await request(method, url, body);
		const text = await res.text();
		return text ? (JSON.parse(text) as T) : undefined;
	}

	async function getJsonOrNull<T>(url: string): Promise<T | null> {
		const res = await rawFetch("GET", url);
		if (res.status === 404) return null;
		if (!res.ok) {
			const detail = await errorDetail(res);
			const suffix = detail ? `: ${detail}` : "";
			throw new HindsightError("http", `Hindsight HTTP ${res.status} for GET ${url}${suffix}`, res.status);
		}
		return (await res.json()) as T;
	}

	return {
		async health(): Promise<{ ok: boolean }> {
			// Pure reachability probe: every failure (http, timeout, network) maps to
			// `{ ok:false }` so the provider gets a clean boolean without try/catch.
			try {
				const res = await rawFetch("GET", `${baseUrl}/health`);
				return { ok: res.ok };
			} catch {
				return { ok: false };
			}
		},

		async ensureBank(bank: string): Promise<void> {
			// CreateBankRequest fields all auto-fill ⇒ minimal idempotent body.
			await request("PUT", bankBase(bank), {});
		},

		async recall(bank: string, query: string, opts?: RecallOptions): Promise<RecallResult> {
			const tags = flattenTags(opts?.tags);
			const body: Record<string, unknown> = { query };
			if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
			if (opts?.budget !== undefined) body.budget = opts.budget;
			if (opts?.types && opts.types.length > 0) body.types = [...opts.types];
			if (opts?.include !== undefined) body.include = opts.include;
			if (opts?.queryTimestamp !== undefined) body.query_timestamp = opts.queryTimestamp;
			if (opts?.trace !== undefined) body.trace = opts.trace;
			if (tags.length > 0) {
				body.tags = tags;
				body.tags_match = opts?.tagsMatch ?? "any";
			}
			const data = await requestJson<{ results?: Array<{ id?: string; text: string; score?: number }> }>(
				"POST",
				`${bankBase(bank)}/memories/recall`,
				body,
			);
			const memories: RecallMemory[] = (data.results ?? []).map((r) => ({
				text: r.text,
				id: r.id,
				score: r.score,
			}));
			return { memories };
		},

		async retain(bank: string, content: string, opts?: RetainOptions): Promise<void> {
			const tags = flattenTags(opts?.tags);
			const item: Record<string, unknown> = { content };
			if (tags.length > 0) item.tags = tags;
			if (opts?.documentId !== undefined) item.document_id = opts.documentId;
			if (opts?.updateMode !== undefined) item.update_mode = opts.updateMode;
			if (opts?.entities !== undefined) item.entities = opts.entities.map((e) => ({ ...e }));
			if (opts?.timestamp !== undefined) item.timestamp = opts.timestamp;
			if (opts?.observationScopes !== undefined) item.observation_scopes = opts.observationScopes;
			if (opts?.metadata !== undefined) item.metadata = { ...opts.metadata };
			// Hindsight `async` defaults to false (synchronous). `sync:true` ⇒ async:false.
			await request("POST", `${bankBase(bank)}/memories`, {
				items: [item],
				async: !opts?.sync,
			});
		},

		async reflect(bank: string, prompt: string, opts?: ReflectOptions): Promise<ReflectResult> {
			const tags = flattenTags(opts?.tags);
			const body: Record<string, unknown> = { query: prompt };
			if (opts?.budget !== undefined) body.budget = opts.budget;
			if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
			if (opts?.include !== undefined) body.include = opts.include;
			if (opts?.responseSchema !== undefined) body.response_schema = opts.responseSchema;
			if (opts?.factTypes && opts.factTypes.length > 0) body.fact_types = [...opts.factTypes];
			if (opts?.excludeMentalModels !== undefined) body.exclude_mental_models = opts.excludeMentalModels;
			if (opts?.excludeMentalModelIds && opts.excludeMentalModelIds.length > 0) body.exclude_mental_model_ids = [...opts.excludeMentalModelIds];
			if (tags.length > 0) {
				body.tags = tags;
				body.tags_match = opts?.tagsMatch ?? "any";
			}
			const data = await requestJson<{ text: string; structured_output?: unknown }>("POST", `${bankBase(bank)}/reflect`, body);
			return {
				text: data.text,
				...(data.structured_output !== undefined ? { structuredOutput: data.structured_output } : {}),
			};
		},

		async listBanks(): Promise<{ banks: string[] }> {
			const data = await requestJson<{ banks?: Array<{ bank_id: string }> }>(
				"GET",
				`${baseUrl}/v1/${nsSeg}/banks`,
			);
			return { banks: (data.banks ?? []).map((b) => b.bank_id) };
		},

		async updateBankConfig(bank: string, updates: BankConfigUpdates): Promise<void> {
			// BankConfigUpdate: { updates: { retain_mission, observations_mission, … } }.
			await request("PATCH", `${bankBase(bank)}/config`, { updates });
		},

		async getMentalModel(bank: string, id: string): Promise<MentalModel | null> {
			return getJsonOrNull<MentalModel>(`${bankBase(bank)}/mental-models/${encodeURIComponent(id)}`);
		},

		async listMentalModels(bank: string): Promise<{ items: MentalModel[] }> {
			const data = await requestJson<{ items?: MentalModel[]; mental_models?: MentalModel[] }>("GET", `${bankBase(bank)}/mental-models`);
			return { items: data.items ?? data.mental_models ?? [] };
		},

		async createMentalModel(bank: string, opts: CreateMentalModelOptions): Promise<CreateMentalModelResult> {
			const data = await requestJson<{ mental_model_id?: string; operation_id?: string }>(
				"POST",
				`${bankBase(bank)}/mental-models`,
				mentalModelCreateBody(opts),
			);
			return { mentalModelId: data.mental_model_id, operationId: data.operation_id };
		},

		async ensureMentalModel(bank: string, opts: CreateMentalModelOptions): Promise<EnsureMentalModelResult> {
			if (opts.id) {
				const existing = await this.getMentalModel(bank, opts.id);
				if (existing) return { model: existing, created: false };
			}
			try {
				const created = await this.createMentalModel(bank, opts);
				const id = opts.id ?? created.mentalModelId;
				const model = id ? await this.getMentalModel(bank, id) : null;
				return { model, created: true, operationId: created.operationId };
			} catch (err) {
				if (opts.id && err instanceof HindsightError && err.kind === "http" && err.status === 409) {
					return { model: await this.getMentalModel(bank, opts.id), created: false };
				}
				throw err;
			}
		},

		async updateMentalModel(bank: string, id: string, patch: Partial<CreateMentalModelOptions> & Record<string, unknown>): Promise<MentalModel> {
			return requestJson<MentalModel>("PATCH", `${bankBase(bank)}/mental-models/${encodeURIComponent(id)}`, mentalModelPatchBody(patch));
		},

		async refreshMentalModel(bank: string, id: string): Promise<{ operationId?: string }> {
			const data = await requestJson<{ operation_id?: string }>("POST", `${bankBase(bank)}/mental-models/${encodeURIComponent(id)}/refresh`, {});
			return { operationId: data.operation_id };
		},

		async clearMentalModel(bank: string, id: string): Promise<{ operationId?: string }> {
			const data = await requestJson<{ operation_id?: string }>("POST", `${bankBase(bank)}/mental-models/${encodeURIComponent(id)}/clear`, {});
			return { operationId: data.operation_id };
		},

		async getMentalModelHistory(bank: string, id: string): Promise<{ history: unknown[] }> {
			const data = await requestJson<{ history?: unknown[] }>("GET", `${bankBase(bank)}/mental-models/${encodeURIComponent(id)}/history`);
			return { history: data.history ?? [] };
		},

		async listDirectives(bank: string): Promise<{ items: Directive[] }> {
			const data = await requestJson<{ items?: Directive[]; directives?: Directive[] }>("GET", `${bankBase(bank)}/directives`);
			return { items: data.items ?? data.directives ?? [] };
		},

		async createDirective(bank: string, directive: DirectiveInput): Promise<Directive> {
			return requestJson<Directive>("POST", `${bankBase(bank)}/directives`, directiveBody(directive));
		},

		async updateDirective(bank: string, id: string, patch: Partial<DirectiveInput>): Promise<Directive> {
			return requestJson<Directive>("PATCH", `${bankBase(bank)}/directives/${encodeURIComponent(id)}`, directiveBody(patch));
		},

		async deleteDirective(bank: string, id: string): Promise<void> {
			await request("DELETE", `${bankBase(bank)}/directives/${encodeURIComponent(id)}`);
		},

		async llmHealth(bank: string): Promise<LlmHealthResponse> {
			return requestJson<LlmHealthResponse>("POST", `${bankBase(bank)}/health/llm`, {});
		},

		async listOperations(bank: string): Promise<{ items: OperationRecord[] }> {
			const data = await requestJson<{ items?: OperationRecord[]; operations?: OperationRecord[] }>("GET", `${bankBase(bank)}/operations`);
			return { items: data.items ?? data.operations ?? [] };
		},

		async retryOperation(bank: string, id: string): Promise<OperationRecord | { ok: boolean }> {
			return (await requestMaybeJson<OperationRecord>("POST", `${bankBase(bank)}/operations/${encodeURIComponent(id)}/retry`, {})) ?? { ok: true };
		},

		async deleteOperation(bank: string, id: string): Promise<void> {
			await request("DELETE", `${bankBase(bank)}/operations/${encodeURIComponent(id)}`);
		},

		async invalidateMemory(bank: string, id: string, reason: string): Promise<void> {
			await request("PATCH", `${bankBase(bank)}/memories/${encodeURIComponent(id)}`, { state: "invalidated", reason });
		},

		async getMemoryHistory(bank: string, id: string): Promise<{ history: unknown[] }> {
			const data = await requestJson<{ history?: unknown[] }>("GET", `${bankBase(bank)}/memories/${encodeURIComponent(id)}/history`);
			return { history: data.history ?? [] };
		},

		async deleteMemoryObservations(bank: string, id: string): Promise<void> {
			await request("DELETE", `${bankBase(bank)}/memories/${encodeURIComponent(id)}/observations`);
		},
	};
}
