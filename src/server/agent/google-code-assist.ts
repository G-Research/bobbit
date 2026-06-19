/**
 * Google Code Assist adapter.
 *
 * Routes `google-gemini-cli` (Google account / OAuth) completions to the official
 * Gemini Code Assist API (`cloudcode-pa.googleapis.com/v1internal`) using a Bearer
 * access token. This is a *different wire protocol* from pi-ai's API-key `google`
 * provider (`generativelanguage.googleapis.com`, `x-goog-api-key`), which is left
 * untouched and remains the always-working API-key fallback.
 *
 * Design: docs/design/google-oauth-model-auth.md §4.4(a) / §4.5.
 *
 * Token sourcing is defensive: the Google refresh helper is owned by the OAuth
 * backend task (`src/server/auth/oauth.ts`). If that symbol is not yet present in
 * this branch we fall back to the stored access token from
 * `auth.json["google-gemini-cli"]`. The expected exported symbol is one of
 * `refreshGoogleOAuthToken()` or `refreshOAuthTokenForProvider("google-gemini-cli")`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { globalAgentDir, globalAuthPath } from "../bobbit-dir.js";

// ── Constants ──────────────────────────────────────────────────────

/** Canonical OAuth/account provider id for Gemini via Google Code Assist. */
export const GOOGLE_GEMINI_CLI_PROVIDER = "google-gemini-cli";
/** pi-ai-style `api` discriminator marking a Code Assist (Bearer) model. */
export const GOOGLE_CODE_ASSIST_API = "google-code-assist";

/**
 * Providers whose models are emitted with `sessionSelectable: false` and so MUST
 * NOT be bound to an agent session by ANY path (browser picker, role override,
 * `default.sessionModel` preference, API write, or a restored/persisted config).
 * The pi-coding-agent runtime has no provider/api capable of running them, so a
 * `setModel(provider, …)` either silently falls back or hard-fails the session.
 *
 * This mirrors the per-model `sessionSelectable: false` contract emitted in
 * `google-code-assist-models.ts`; `getGoogleCodeAssistModels()` only ever emits
 * `google-gemini-cli` models, so a provider-level guard is sufficient and avoids
 * an async model-registry lookup on the synchronous spawn/bind path. The pinning
 * test in `google-code-assist.test.ts` cross-checks the two so they can't drift.
 */
const NON_SESSION_SELECTABLE_PROVIDERS = new Set<string>([GOOGLE_GEMINI_CLI_PROVIDER]);

/** True when models from `provider` may be bound to an agent session. */
export function isSessionSelectableProvider(provider: string): boolean {
	return !NON_SESSION_SELECTABLE_PROVIDERS.has(provider);
}

/**
 * True when a `"<provider>/<modelId>"` string may be bound to an agent session.
 * Malformed strings return `true` so existing malformed-pref handling (which
 * logs/ignores) is unchanged; this guard only screens out the known
 * not-session-runnable providers.
 */
export function isSessionSelectableModelString(modelString: string): boolean {
	const slash = modelString.indexOf("/");
	const provider = slash > 0 ? modelString.slice(0, slash) : modelString;
	return isSessionSelectableProvider(provider);
}

const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const CODE_ASSIST_API_VERSION = "v1internal";
const CLIENT_METADATA = { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } as const;

// ── Types ──────────────────────────────────────────────────────────

interface StoredGoogleCredential {
	type?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	email?: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
	ok: boolean;
	status: number;
	text: () => Promise<string>;
}>;

export interface CodeAssistGenerateArgs {
	model: string;
	systemPrompt?: string;
	userPrompt: string;
	maxTokens?: number;
	/** pi-ai thinking level mapped to a Gemini thinkingConfig hint. */
	thinkingLevel?: string;
	/**
	 * Abort the underlying Code Assist fetch(es) after this many ms. Threaded from
	 * `completeModelText({ timeoutMs })` so a stalled `generateContent` / onboarding
	 * request can't hang past the caller's deadline. `undefined`/`<=0` disables it.
	 */
	timeoutMs?: number;
}

export interface CodeAssistDeps {
	/** Returns a fresh Bearer access token, or null when no account is authenticated. */
	getToken?: () => Promise<string | null>;
	/** Resolves the Code Assist project id to bill/route the request under. */
	getProject?: (token: string) => Promise<string | undefined>;
	fetchFn?: FetchLike;
}

// ── Credential reading (auth.json["google-gemini-cli"]) ─────────────

function readGoogleCredential(): StoredGoogleCredential | null {
	const authPath = globalAuthPath();
	if (!existsSync(authPath)) return null;
	try {
		const data = JSON.parse(readFileSync(authPath, "utf-8"));
		const cred = data?.[GOOGLE_GEMINI_CLI_PROVIDER];
		if (cred && typeof cred === "object") return cred as StoredGoogleCredential;
	} catch {
		// ignore malformed auth.json
	}
	return null;
}

/** True when a Google account (Code Assist) OAuth credential is present, even if expired. */
export function hasGoogleCodeAssistCredential(): boolean {
	const cred = readGoogleCredential();
	return !!(cred && (cred.access || cred.refresh));
}

/**
 * Attempt a token refresh via the OAuth backend helper. Defensive: the helper is
 * owned by the OAuth task and may not exist yet on this branch. Returns null when
 * no helper is available or the refresh fails.
 */
async function tryRefreshGoogleToken(): Promise<string | null> {
	try {
		const oauth: Record<string, unknown> = await import("../auth/oauth.js");
		const direct = oauth["refreshGoogleOAuthToken"];
		if (typeof direct === "function") {
			const token = await (direct as () => Promise<string | null>)();
			return token ?? null;
		}
		const byProvider = oauth["refreshOAuthTokenForProvider"];
		if (typeof byProvider === "function") {
			const token = await (byProvider as (p: string) => Promise<string | null>)(GOOGLE_GEMINI_CLI_PROVIDER);
			return token ?? null;
		}
	} catch {
		// Helper missing or threw — fall back to the stored access token.
	}
	return null;
}

/**
 * Return a usable Bearer access token for the Google account, refreshing when the
 * stored token is missing/expired and a refresh helper is available.
 */
export async function getGoogleAccessToken(): Promise<string | null> {
	const cred = readGoogleCredential();
	const fresh = !!cred?.access && (!cred.expires || Date.now() < cred.expires);
	if (fresh) return cred!.access!;

	const refreshed = await tryRefreshGoogleToken();
	if (refreshed) return refreshed;

	// Last resort: hand back a possibly-stale token so the API can report the real
	// auth error rather than us silently returning null.
	return cred?.access ?? null;
}

// ── Code Assist project resolution ─────────────────────────────────

let cachedProjectId: string | undefined;

function projectCachePath(): string {
	return path.join(globalAgentDir(), "google-code-assist.json");
}

function readPersistedProject(): string | undefined {
	try {
		const p = projectCachePath();
		if (!existsSync(p)) return undefined;
		const data = JSON.parse(readFileSync(p, "utf-8"));
		const id = data?.projectId;
		return typeof id === "string" && id.trim() ? id : undefined;
	} catch {
		return undefined;
	}
}

function persistProject(projectId: string): void {
	try {
		const dir = globalAgentDir();
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(projectCachePath(), JSON.stringify({ projectId }, null, 2), "utf-8");
	} catch {
		// best-effort cache; not fatal
	}
}

/** Reset the in-memory project cache (test seam). */
export function resetCodeAssistProjectCache(): void {
	cachedProjectId = undefined;
}

function codeAssistUrl(method: string): string {
	return `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${method}`;
}

async function codeAssistPost(method: string, token: string, body: unknown, fetchFn: FetchLike, timeoutMs?: number): Promise<any> {
	const init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal } = {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	};

	let res: { ok: boolean; status: number; text: () => Promise<string> };
	if (typeof timeoutMs === "number" && timeoutMs > 0) {
		// Race the fetch against a timeout that also aborts the request. Racing (not
		// just relying on the AbortSignal) guarantees a deterministic timeout even
		// when the provided fetch implementation ignores `signal` (e.g. a test stub).
		const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
		if (controller) init.signal = controller.signal;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller?.abort();
				reject(new Error(`Code Assist ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
		});
		try {
			res = await Promise.race([fetchFn(codeAssistUrl(method), init), timeout]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	} else {
		res = await fetchFn(codeAssistUrl(method), init);
	}
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`Code Assist ${method} failed: HTTP ${res.status} ${text.slice(0, 256)}`);
	}
	try {
		return text ? JSON.parse(text) : {};
	} catch {
		throw new Error(`Code Assist ${method} returned invalid JSON`);
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Resolve the Code Assist project: prefer the in-memory/persisted cache, else
 * `loadCodeAssist` (returns the project when already onboarded) and finally
 * `onboardUser` (a long-running operation) for the free tier.
 */
export async function ensureCodeAssistProject(token: string, fetchFn: FetchLike = defaultFetch(), timeoutMs?: number): Promise<string | undefined> {
	if (cachedProjectId) return cachedProjectId;
	const persisted = readPersistedProject();
	if (persisted) {
		cachedProjectId = persisted;
		return persisted;
	}

	const load = await codeAssistPost("loadCodeAssist", token, { metadata: CLIENT_METADATA }, fetchFn, timeoutMs);
	let project: string | undefined = load?.cloudaicompanionProject;
	if (!project) {
		const tierId: string =
			(Array.isArray(load?.allowedTiers) ? load.allowedTiers.find((t: any) => t?.isDefault)?.id : undefined) ?? "free-tier";
		let op = await codeAssistPost(
			"onboardUser",
			token,
			{ tierId, cloudaicompanionProject: project, metadata: CLIENT_METADATA },
			fetchFn,
			timeoutMs,
		);
		for (let i = 0; i < 8 && op && op.done !== true; i++) {
			await sleep(1500);
			op = await codeAssistPost(
				"onboardUser",
				token,
				{ tierId, cloudaicompanionProject: project, metadata: CLIENT_METADATA },
				fetchFn,
				timeoutMs,
			);
		}
		const resolved = op?.response?.cloudaicompanionProject;
		project = typeof resolved === "string" ? resolved : resolved?.id;
	}

	if (project) {
		cachedProjectId = project;
		persistProject(project);
	}
	return project;
}

// ── Request/response conversion (pure, unit-tested) ─────────────────

const THINKING_BUDGET: Record<string, number> = { minimal: 0, low: 4096, medium: 8192, high: 24576, xhigh: 32768 };

/** Build the Code Assist `:generateContent` request body. Pure / deterministic. */
export function buildGenerateContentBody(args: CodeAssistGenerateArgs, project?: string): Record<string, unknown> {
	const generationConfig: Record<string, unknown> = {};
	if (typeof args.maxTokens === "number" && args.maxTokens > 0) generationConfig.maxOutputTokens = args.maxTokens;
	if (args.thinkingLevel && args.thinkingLevel !== "off") {
		const budget = THINKING_BUDGET[args.thinkingLevel];
		if (typeof budget === "number") generationConfig.thinkingConfig = { thinkingBudget: budget };
	}

	const request: Record<string, unknown> = {
		contents: [{ role: "user", parts: [{ text: args.userPrompt }] }],
	};
	if (args.systemPrompt && args.systemPrompt.trim()) {
		request.systemInstruction = { role: "user", parts: [{ text: args.systemPrompt }] };
	}
	if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;

	const body: Record<string, unknown> = { model: args.model, request };
	if (project) body.project = project;
	return body;
}

/** Extract assistant text from a Code Assist `:generateContent` response. Pure. */
export function extractCodeAssistText(payload: any): string {
	// Code Assist wraps the standard GenerateContent response under `response`.
	const candidates = payload?.response?.candidates ?? payload?.candidates ?? [];
	const parts = candidates?.[0]?.content?.parts ?? [];
	return parts
		.map((p: any) => (typeof p?.text === "string" ? p.text : ""))
		.join("")
		.trim();
}

function defaultFetch(): FetchLike {
	const f = (globalThis as any).fetch;
	if (typeof f !== "function") {
		throw new Error("global fetch is unavailable in this runtime");
	}
	return f as FetchLike;
}

/**
 * Run a single-turn completion against the Code Assist API for a `google-gemini-cli`
 * model. Throws a descriptive error when no Google account is authenticated.
 */
export async function codeAssistComplete(args: CodeAssistGenerateArgs, deps: CodeAssistDeps = {}): Promise<string> {
	const fetchFn = deps.fetchFn ?? defaultFetch();
	const getToken = deps.getToken ?? getGoogleAccessToken;
	const token = await getToken();
	if (!token) {
		throw new Error(
			"No Google account credential available. Log in via Settings → Account → Google (Gemini), " +
				"or use a Google AI Studio API key (provider 'google') in Settings → Models.",
		);
	}

	const getProject = deps.getProject ?? ((t: string) => ensureCodeAssistProject(t, fetchFn, args.timeoutMs));
	const project = await getProject(token);

	const body = buildGenerateContentBody(args, project);
	const payload = await codeAssistPost("generateContent", token, body, fetchFn, args.timeoutMs);
	return extractCodeAssistText(payload);
}
