/**
 * Bounded Hindsight 0.8.x REST client.  This is the only HTTP boundary used by
 * the pack routes: a response is never parsed after its deadline, cancellation,
 * or byte budget has expired.
 */

export type HindsightErrorKind = "timeout" | "http" | "network" | "response";
export class HindsightError extends Error {
	readonly kind: HindsightErrorKind;
	readonly status?: number;
	constructor(kind: HindsightErrorKind, message: string, status?: number) {
		super(message); this.name = "HindsightError"; this.kind = kind; this.status = status;
		Object.setPrototypeOf(this, HindsightError.prototype);
	}
}

export type Tags = Record<string, string>;
export type TagsMatch = "any" | "all" | "any_strict" | "all_strict";
export interface RecallMemory { text: string; score?: number; id?: string }
export interface RecallOptions { maxTokens?: number; tags?: Tags; tagsMatch?: TagsMatch }
export interface RetainOptions { tags?: Tags; id?: string; sync?: boolean }
export interface BrowseOptions { query?: string; cursor?: string; limit?: number; tags?: Tags; tagsMatch?: TagsMatch }
export interface ScopedOptions { tags?: Tags; tagsMatch?: TagsMatch }
export interface InvalidateOptions extends ScopedOptions { reason?: string }
export interface BrowseResult { memories: Record<string, unknown>[]; cursor?: string }

export interface HindsightClient {
	health(): Promise<{ ok: boolean }>;
	ensureBank(bank: string): Promise<void>;
	recall(bank: string, query: string, opts?: RecallOptions): Promise<{ memories: RecallMemory[] }>;
	retain(bank: string, content: string, opts?: RetainOptions): Promise<void>;
	reflect(bank: string, prompt: string): Promise<{ text: string }>;
	/** The scoped form is required by typed routes; it maps to Hindsight's tag-aware reflect API. */
	reflectScoped(bank: string, prompt: string, opts: ScopedOptions): Promise<{ text: string }>;
	listBanks(): Promise<{ banks: string[] }>;
	/** GET /memories/list in the published Hindsight 0.8.6 OpenAPI. */
	browse(bank: string, opts?: BrowseOptions): Promise<BrowseResult>;
	detail(bank: string, id: string): Promise<Record<string, unknown> | null>;
	history(bank: string, id: string): Promise<{ history: Record<string, unknown>[] }>;
	invalidateMemory(bank: string, id: string, opts?: InvalidateOptions): Promise<void>;
}

export interface HindsightClientConfig {
	baseUrl: string;
	apiKey?: string;
	namespace?: string;
	timeoutMs?: number;
	/** Parent route/lifecycle cancellation. This is never serialized or persisted. */
	signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 1_500;
const MAX_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_RESULT_ITEMS = 100;
const DEFAULT_NAMESPACE = "default";

function flattenTags(tags?: Tags): string[] {
	return !tags ? [] : Object.keys(tags).sort().map(key => `${key}:${tags[key]}`);
}
function finitePositive(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), MAX_TIMEOUT_MS) : fallback;
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function boundedRecords(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.slice(0, MAX_RESULT_ITEMS).flatMap(item => asRecord(item) ? [item] : []) : [];
}
function cursorOffset(cursor?: string): number | undefined {
	if (!cursor || !/^(?:0|[1-9]\d{0,8})$/.test(cursor)) return undefined;
	const offset = Number(cursor); return Number.isSafeInteger(offset) ? offset : undefined;
}

interface Attempt { response: Response; controller: AbortController; finish(): void; timedOut(): boolean }

export function createClient(cfg: HindsightClientConfig): HindsightClient {
	const baseUrl = cfg.baseUrl.replace(/\/+$/, "");
	const namespace = cfg.namespace?.trim() || DEFAULT_NAMESPACE;
	const timeoutMs = finitePositive(cfg.timeoutMs, DEFAULT_TIMEOUT_MS);
	const nsSeg = encodeURIComponent(namespace);
	const bankBase = (bank: string) => `${baseUrl}/v1/${nsSeg}/banks/${encodeURIComponent(bank)}`;
	const headers = (body: unknown): Record<string, string> => ({
		...(body === undefined ? {} : { "Content-Type": "application/json" }),
		...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
	});

	async function rawFetch(method: string, url: string, body?: unknown): Promise<Attempt> {
		const controller = new AbortController();
		let timedOut = false;
		const onParentAbort = () => controller.abort(cfg.signal?.reason);
		if (cfg.signal?.aborted) onParentAbort(); else cfg.signal?.addEventListener("abort", onParentAbort, { once: true });
		const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
		const finish = () => { clearTimeout(timer); cfg.signal?.removeEventListener("abort", onParentAbort); };
		try {
			const response = await fetch(url, { method, headers: headers(body), ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal });
			return { response, controller, finish, timedOut: () => timedOut };
		} catch (error) {
			finish();
			if (timedOut) throw new HindsightError("timeout", `Hindsight request timed out after ${timeoutMs}ms`);
			throw new HindsightError("network", `Hindsight network error: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async function responseText(attempt: Attempt): Promise<string> {
		const { response, controller } = attempt;
		const declared = Number(response.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
			controller.abort(); throw new HindsightError("response", "Hindsight response exceeds byte limit");
		}
		try {
			if (!response.body) return "";
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = []; let bytes = 0;
			try {
				for (;;) {
					const next = await reader.read();
					if (next.done) break;
					bytes += next.value.byteLength;
					if (bytes > MAX_RESPONSE_BYTES) {
						controller.abort(); await reader.cancel().catch(() => {});
						throw new HindsightError("response", "Hindsight response exceeds byte limit");
					}
					chunks.push(next.value);
				}
			} finally { reader.releaseLock(); }
			const joined = new Uint8Array(bytes); let offset = 0;
			for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
			return new TextDecoder().decode(joined);
		} catch (error) {
			if (error instanceof HindsightError) throw error;
			if (attempt.timedOut()) throw new HindsightError("timeout", `Hindsight request timed out after ${timeoutMs}ms`);
			throw new HindsightError("network", `Hindsight response interrupted: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async function json<T>(method: string, url: string, body?: unknown): Promise<T> {
		const attempt = await rawFetch(method, url, body);
		try {
			if (!attempt.response.ok) throw new HindsightError("http", `Hindsight HTTP ${attempt.response.status} for ${method} ${url}`, attempt.response.status);
			const text = await responseText(attempt);
			try { return JSON.parse(text) as T; }
			catch { throw new HindsightError("response", "Hindsight returned invalid JSON"); }
		} finally { attempt.controller.abort(); attempt.finish(); }
	}
	async function ok(method: string, url: string, body?: unknown): Promise<void> {
		const attempt = await rawFetch(method, url, body);
		try {
			if (!attempt.response.ok) throw new HindsightError("http", `Hindsight HTTP ${attempt.response.status} for ${method} ${url}`, attempt.response.status);
		} finally { attempt.controller.abort(); attempt.finish(); }
	}
	function tagBody(base: Record<string, unknown>, opts?: ScopedOptions): Record<string, unknown> {
		const tags = flattenTags(opts?.tags);
		return tags.length ? { ...base, tags, tags_match: opts?.tagsMatch ?? "any" } : base;
	}

	return {
		async health() { try { const attempt = await rawFetch("GET", `${baseUrl}/health`); try { return { ok: attempt.response.ok }; } finally { attempt.controller.abort(); attempt.finish(); } } catch { return { ok: false }; } },
		async ensureBank(bank) { await ok("PUT", bankBase(bank), {}); },
		async recall(bank, query, opts) {
			const body = tagBody({ query, ...(opts?.maxTokens === undefined ? {} : { max_tokens: opts.maxTokens }) }, opts);
			const data = await json<{ results?: unknown }>("POST", `${bankBase(bank)}/memories/recall`, body);
			const memories = boundedRecords(data.results).flatMap(item => typeof item.text === "string" ? [{ text: item.text, ...(typeof item.id === "string" ? { id: item.id } : {}), ...(typeof item.score === "number" ? { score: item.score } : {}) }] : []);
			return { memories };
		},
		async retain(bank, content, opts) { await ok("POST", `${bankBase(bank)}/memories`, { items: [{ content, ...(opts?.id ? { id: opts.id } : {}), ...(flattenTags(opts?.tags).length ? { tags: flattenTags(opts?.tags) } : {}) }], async: !opts?.sync }); },
		async reflect(bank, prompt) { return json<{ text: string }>("POST", `${bankBase(bank)}/reflect`, { query: prompt }); },
		async reflectScoped(bank, prompt, opts) { return json<{ text: string }>("POST", `${bankBase(bank)}/reflect`, tagBody({ query: prompt }, opts)); },
		async listBanks() { const data = await json<{ banks?: unknown }>("GET", `${baseUrl}/v1/${nsSeg}/banks`); return { banks: boundedRecords(data.banks).flatMap(bank => typeof bank.bank_id === "string" ? [bank.bank_id] : []) }; },
		async browse(bank, opts) {
			const params = new URLSearchParams();
			if (opts?.query) params.set("q", opts.query);
			const offset = cursorOffset(opts?.cursor); if (offset !== undefined) params.set("offset", String(offset));
			const limit = Math.min(MAX_RESULT_ITEMS, Math.max(1, Math.floor(opts?.limit ?? 25))); params.set("limit", String(limit));
			const tags = flattenTags(opts?.tags); for (const tag of tags) params.append("tags", tag);
			if (tags.length) params.set("tags_match", opts?.tagsMatch ?? "any");
			const data = await json<{ items?: unknown; total?: unknown; offset?: unknown }>("GET", `${bankBase(bank)}/memories/list?${params}`);
			const memories = boundedRecords(data.items);
			const currentOffset = typeof data.offset === "number" && Number.isSafeInteger(data.offset) ? data.offset : offset ?? 0;
			return { memories, ...(typeof data.total === "number" && currentOffset + memories.length < data.total ? { cursor: String(currentOffset + memories.length) } : {}) };
		},
		async detail(bank, id) {
			const attempt = await rawFetch("GET", `${bankBase(bank)}/memories/${encodeURIComponent(id)}`);
			try {
				if (attempt.response.status === 404) return null;
				if (!attempt.response.ok) throw new HindsightError("http", `Hindsight HTTP ${attempt.response.status} for GET memory`, attempt.response.status);
				return asRecord(JSON.parse(await responseText(attempt))) ?? null;
			} catch (error) {
				if (error instanceof HindsightError) throw error;
				throw new HindsightError("response", "Hindsight returned invalid JSON");
			} finally { attempt.controller.abort(); attempt.finish(); }
		},
		async history(bank, id) { const data = await json<{ history?: unknown }>("GET", `${bankBase(bank)}/memories/${encodeURIComponent(id)}/history`); return { history: boundedRecords(data.history) }; },
		async invalidateMemory(bank, id, opts) { await ok("PATCH", `${bankBase(bank)}/memories/${encodeURIComponent(id)}`, { state: "invalidated", ...(opts?.reason ? { reason: opts.reason } : {}) }); },
	};
}
