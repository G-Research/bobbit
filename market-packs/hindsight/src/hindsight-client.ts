/**
 * Hindsight REST client (EP G2 / external mode).
 *
 * A thin, faithful mapping over the Hindsight HTTP API
 * (`/v1/{namespace}/banks/{bank}/…`, default namespace `default`, port 8888).
 * Request/response bodies are mapped per the upstream `openapi.json`
 * (Hindsight 0.8.x) — see docs/design/hindsight-pack-external.md §3.
 *
 * Design rules (do not soften — they are pinned by tests/hindsight-client.test.ts):
 *   - Every method arms an AbortController with `cfg.timeoutMs` (default 1500ms);
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

export interface RecallMemory {
	text: string;
	score?: number;
	id?: string;
}

export interface RecallResult {
	memories: RecallMemory[];
}

export interface RecallOptions {
	maxTokens?: number;
	tags?: Record<string, string>;
	tagsMatch?: "any" | "all" | "any_strict" | "all_strict";
	/** Hindsight `types` filter (fact types to recall): biases recall toward
	 *  consolidated `observation`s plus `world`/`experience`. Omitted ⇒ upstream
	 *  default (world + experience). */
	types?: Array<"observation" | "world" | "experience">;
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
}

export interface ReflectOptions {
	/** Tag filter applied during reflection (maps to scope on the shared bank). */
	tags?: Record<string, string>;
	tagsMatch?: "any" | "all" | "any_strict" | "all_strict";
}

export interface HindsightClient {
	health(): Promise<{ ok: boolean }>;
	/** Idempotent create-or-update — call before the first retain. PUT …/banks/{bank}. */
	ensureBank(bank: string): Promise<void>;
	recall(bank: string, query: string, opts?: RecallOptions): Promise<RecallResult>;
	/** POST …/memories. Resolves on a 2xx (extraction is async upstream). */
	retain(bank: string, content: string, opts?: RetainOptions): Promise<void>;
	reflect(bank: string, prompt: string, opts?: ReflectOptions): Promise<{ text: string }>;
	listBanks(): Promise<{ banks: string[] }>;
	/** Idempotent bank-config mission update. PATCH …/banks/{bank}/config. */
	updateBankConfig(bank: string, updates: BankConfigUpdates): Promise<void>;
}

export interface HindsightClientConfig {
	baseUrl: string;
	apiKey?: string;
	/** Default `default`. */
	namespace?: string;
	/** Per-request abort budget in ms. Default 1500. */
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_NAMESPACE = "default";

/** Flatten `{ "project": "abc" }` → `["project:abc"]`, sorted for determinism. */
function flattenTags(tags?: Record<string, string>): string[] {
	if (!tags) return [];
	return Object.keys(tags)
		.sort()
		.map((k) => `${k}:${tags[k]}`);
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

	/** Fetch + 2xx assertion; returns the Response for the caller to parse. */
	async function request(method: string, url: string, body?: unknown): Promise<Response> {
		const res = await rawFetch(method, url, body);
		if (!res.ok) {
			throw new HindsightError("http", `Hindsight HTTP ${res.status} for ${method} ${url}`, res.status);
		}
		return res;
	}

	async function requestJson<T>(method: string, url: string, body?: unknown): Promise<T> {
		const res = await request(method, url, body);
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
			if (opts?.types && opts.types.length > 0) body.types = [...opts.types];
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
			// Hindsight `async` defaults to false (synchronous). `sync:true` ⇒ async:false.
			await request("POST", `${bankBase(bank)}/memories`, {
				items: [item],
				async: !opts?.sync,
			});
		},

		async reflect(bank: string, prompt: string, opts?: ReflectOptions): Promise<{ text: string }> {
			const tags = flattenTags(opts?.tags);
			const body: Record<string, unknown> = { query: prompt };
			if (tags.length > 0) {
				body.tags = tags;
				body.tags_match = opts?.tagsMatch ?? "any";
			}
			const data = await requestJson<{ text: string }>("POST", `${bankBase(bank)}/reflect`, body);
			return { text: data.text };
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
	};
}
