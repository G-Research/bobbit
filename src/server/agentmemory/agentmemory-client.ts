/**
 * REST client for the AgentMemory server. Methods return typed
 * success/error results instead of throwing into the agent flow.
 *
 * - All URLs are built under `<baseUrl>/agentmemory/*`.
 * - Bearer auth is read from a callback (so secrets stay in SecretsStore).
 * - Short timeouts via AbortSignal.timeout(); malformed JSON is caught.
 * - Non-loopback HTTP + bearer is blocked unless `allowInsecure=true`.
 *
 * See docs/design/agentmemory-integration.md.
 */

export interface AgentMemoryClientOptions {
	/** Base URL, e.g. http://127.0.0.1:3111 — no trailing /agentmemory. */
	getBaseUrl: () => string;
	/** Returns the bearer token or undefined when none is configured. */
	getBearer: () => string | undefined;
	/** When true, permit bearer over plain HTTP to non-loopback hosts. */
	getAllowInsecure?: () => boolean;
	/** Override the global fetch (tests). */
	fetchImpl?: typeof fetch;
	/** Default per-request timeout. */
	defaultTimeoutMs?: number;
}

export type ApiResult<T> =
	| { ok: true; data: T; status: number }
	| { ok: false; status: number; error: string; code?: string };

export interface SmartSearchArgs {
	query: string;
	limit?: number;
	scope?: "project" | "global" | "project+global";
	projectKey?: string;
	tokenBudget?: number;
}

export interface ContextArgs {
	sessionId: string;
	projectKey?: string;
	tokenBudget?: number;
}

export interface RememberArgs {
	content: string;
	type?: string;
	scope?: "project" | "global";
	projectKey?: string;
	concepts?: string[];
	files?: string[];
}

export interface ObserveArgs {
	sessionId: string;
	hookType: string;
	projectKey?: string;
	cwd?: string;
	data: Record<string, unknown>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isLoopback(url: URL): boolean {
	return LOOPBACK_HOSTS.has(url.hostname);
}

export class AgentMemoryClient {
	private readonly getBaseUrl: () => string;
	private readonly getBearer: () => string | undefined;
	private readonly getAllowInsecure: () => boolean;
	private readonly fetchImpl: typeof fetch;
	private readonly defaultTimeoutMs: number;

	constructor(opts: AgentMemoryClientOptions) {
		this.getBaseUrl = opts.getBaseUrl;
		this.getBearer = opts.getBearer;
		this.getAllowInsecure = opts.getAllowInsecure ?? (() => false);
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 4000;
	}

	/** Resolve and validate the base URL for an outgoing request. */
	private resolveUrl(pathname: string): { url: URL; err?: string } {
		const baseRaw = (this.getBaseUrl() || "").trim();
		if (!baseRaw) return { url: new URL("http://127.0.0.1:0/"), err: "AgentMemory URL is not configured" };
		let base: URL;
		try { base = new URL(baseRaw); } catch { return { url: new URL("http://127.0.0.1:0/"), err: `Invalid AgentMemory URL: ${baseRaw}` }; }
		if (base.protocol !== "http:" && base.protocol !== "https:") {
			return { url: base, err: `Unsupported AgentMemory protocol: ${base.protocol}` };
		}
		// Strip trailing slash; append /agentmemory + pathname.
		const path = pathname.startsWith("/") ? pathname : "/" + pathname;
		const url = new URL(`/agentmemory${path}`, base);
		if (this.getBearer() && base.protocol === "http:" && !isLoopback(base) && !this.getAllowInsecure()) {
			return { url, err: "Refusing to send bearer token over plain HTTP to a non-loopback host. Enable HTTPS or set allowInsecure." };
		}
		return { url };
	}

	private async send<T>(
		method: "GET" | "POST",
		pathname: string,
		body: unknown | undefined,
		timeoutMs: number,
	): Promise<ApiResult<T>> {
		const { url, err } = this.resolveUrl(pathname);
		if (err) return { ok: false, status: 0, error: err, code: "CONFIG" };
		const headers: Record<string, string> = { accept: "application/json" };
		const bearer = this.getBearer();
		if (bearer) headers["authorization"] = `Bearer ${bearer}`;
		if (body !== undefined) headers["content-type"] = "application/json";
		let res: Response;
		try {
			res = await this.fetchImpl(url, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (e: unknown) {
			const msg = (e as Error)?.message ?? String(e);
			const code = /aborted|timeout/i.test(msg) ? "TIMEOUT" : "NETWORK";
			return { ok: false, status: 0, error: msg, code };
		}
		const status = res.status;
		const text = await res.text().catch(() => "");
		let data: unknown = undefined;
		if (text) {
			try { data = JSON.parse(text); } catch { data = undefined; }
		}
		if (!res.ok) {
			const error = (data && typeof data === "object" && (data as { error?: unknown }).error)
				? String((data as { error: unknown }).error)
				: `HTTP ${status}`;
			return { ok: false, status, error, code: status === 401 ? "UNAUTHORIZED" : undefined };
		}
		return { ok: true, status, data: (data ?? {}) as T };
	}

	/** GET /agentmemory/health */
	health(timeoutMs?: number): Promise<ApiResult<{ status?: string; version?: string } & Record<string, unknown>>> {
		return this.send("GET", "/health", undefined, timeoutMs ?? Math.min(2500, this.defaultTimeoutMs));
	}

	/** POST /agentmemory/smart-search */
	smartSearch(args: SmartSearchArgs, timeoutMs?: number): Promise<ApiResult<{ results?: unknown[]; project?: unknown[]; global?: unknown[] } & Record<string, unknown>>> {
		return this.send("POST", "/smart-search", args, timeoutMs ?? this.defaultTimeoutMs);
	}

	/** POST /agentmemory/context */
	context(args: ContextArgs, timeoutMs?: number): Promise<ApiResult<Record<string, unknown>>> {
		return this.send("POST", "/context", args, timeoutMs ?? this.defaultTimeoutMs);
	}

	/** POST /agentmemory/remember — caller must redact before calling. */
	remember(args: RememberArgs, timeoutMs?: number): Promise<ApiResult<Record<string, unknown>>> {
		return this.send("POST", "/remember", args, timeoutMs ?? this.defaultTimeoutMs);
	}

	/** POST /agentmemory/observe — caller must redact before calling. */
	observe(args: ObserveArgs, timeoutMs?: number): Promise<ApiResult<Record<string, unknown>>> {
		return this.send("POST", "/observe", args, timeoutMs ?? this.defaultTimeoutMs);
	}
}
