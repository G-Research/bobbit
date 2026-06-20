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
import { redactSensitive } from "../auth/redact.js";

// ── Constants ──────────────────────────────────────────────────────

/** Canonical OAuth/account provider id for Gemini via Google Code Assist. */
export const GOOGLE_GEMINI_CLI_PROVIDER = "google-gemini-cli";
/** pi-ai-style `api` discriminator marking a Code Assist (Bearer) model. */
export const GOOGLE_CODE_ASSIST_API = "google-code-assist";

/**
 * Providers whose models MUST NOT be bound to an agent session by ANY path
 * (browser picker, role override, `default.sessionModel` preference, API write, or
 * a restored/persisted config) because the pi-coding-agent runtime has no
 * provider/api capable of running them.
 *
 * `google-gemini-cli` USED to live here: the runtime had no `google-code-assist`
 * api, so binding one of its models hard-failed or silently fell back. That gap is
 * now closed by a generated pi-coding-agent extension that registers a first-class
 * `google-code-assist` provider with the conversion/streaming core in this file
 * (`convertContextToCodeAssist` / `codeAssistStream`). Google account models are
 * therefore session-runnable and the provider is no longer gated here.
 *
 * The set is kept (currently empty) plus the exported guards so the WS handler,
 * review-model override, and session-manager call sites need no change and so a
 * future not-yet-runnable provider can be re-gated in one place.
 *
 * Design: docs/design/google-session-models.md §4.5.
 */
const NON_SESSION_SELECTABLE_PROVIDERS = new Set<string>();

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

/**
 * Explicit Code Assist / GCP project override from the environment. Paid Code
 * Assist / Gemini-CLI subscriptions route under a chosen project; honoring these
 * env vars lets a user pin it without the loadCodeAssist/onboardUser dance. Mirror
 * the Gemini CLI's `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_PROJECT_ID` precedence.
 */
export function envProjectOverride(): string | undefined {
	const v = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
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
		throw new Error(`Code Assist ${method} failed: HTTP ${res.status} ${redactSensitive(text).slice(0, 256)}`);
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
	// An explicit env override wins so paid Code Assist / GCA subscriptions route
	// under the user's chosen project, skipping loadCodeAssist/onboardUser entirely.
	const envProject = envProjectOverride();
	if (envProject) {
		cachedProjectId = envProject;
		return envProject;
	}
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

/**
 * Build the Gemini `generationConfig` shared by the single-turn and multi-turn
 * request builders. Pure / deterministic; returns `{}` when nothing applies.
 */
function buildGenerationConfig(maxTokens?: number, thinkingLevel?: string): Record<string, unknown> {
	const cfg: Record<string, unknown> = {};
	if (typeof maxTokens === "number" && maxTokens > 0) cfg.maxOutputTokens = maxTokens;
	if (thinkingLevel && thinkingLevel !== "off") {
		const budget = THINKING_BUDGET[thinkingLevel];
		if (typeof budget === "number") cfg.thinkingConfig = { thinkingBudget: budget };
	}
	return cfg;
}

/** Build the Code Assist `:generateContent` request body. Pure / deterministic. */
export function buildGenerateContentBody(args: CodeAssistGenerateArgs, project?: string): Record<string, unknown> {
	const request: Record<string, unknown> = {
		contents: [{ role: "user", parts: [{ text: args.userPrompt }] }],
	};
	if (args.systemPrompt && args.systemPrompt.trim()) {
		request.systemInstruction = { role: "user", parts: [{ text: args.systemPrompt }] };
	}
	const generationConfig = buildGenerationConfig(args.maxTokens, args.thinkingLevel);
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

// ── Multi-turn / tool conversion (pure, unit-tested) ────────────────
//
// These helpers generalize `buildGenerateContentBody` to a full agent turn —
// multi-turn history, tool declarations, assistant tool calls (with
// `thoughtSignature` passthrough for Gemini-3 thinking replay), tool results, and
// images. They are deliberately pi-ai-free so they can be shared verbatim by the
// gateway and inlined into the generated provider extension (see
// docs/design/google-session-models.md §4.1).

/** A model-emitted function call (assistant turn). */
export interface NormalizedToolCall {
	name: string;
	args?: Record<string, unknown>;
	/** Opaque Gemini thinking token; preserved verbatim across turns when present. */
	thoughtSignature?: string;
}

/** A tool result fed back to the model (next user turn, Gemini convention). */
export interface NormalizedToolResult {
	name: string;
	response?: unknown;
}

/** An inline image part (base64). */
export interface NormalizedImage {
	mimeType: string;
	data: string;
}

/** A normalized, provider-agnostic message in the agent's history. */
export interface NormalizedMessage {
	role: "user" | "assistant" | "tool";
	text?: string;
	toolCalls?: NormalizedToolCall[];
	toolResults?: NormalizedToolResult[];
	images?: NormalizedImage[];
}

/** A JSON-schema function declaration the model may call. */
export interface NormalizedToolDecl {
	name: string;
	description?: string;
	/** JSON-Schema for the call args; emitted as `parametersJsonSchema`. */
	parameters?: Record<string, unknown>;
}

export type ToolChoice = "auto" | "any" | "none";

export interface ConvertContextArgs {
	model: string;
	project?: string;
	systemPrompt?: string;
	messages: NormalizedMessage[];
	tools?: NormalizedToolDecl[];
	toolChoice?: ToolChoice;
	maxTokens?: number;
	thinkingLevel?: string;
}

/** Gemini `functionResponse.response` must be an object; wrap scalars/arrays. */
function normalizeFunctionResponse(response: unknown): Record<string, unknown> {
	if (response && typeof response === "object" && !Array.isArray(response)) return response as Record<string, unknown>;
	if (response === undefined || response === null) return {};
	return { result: response };
}

function toolChoiceMode(choice?: ToolChoice): string | undefined {
	switch (choice) {
		case "auto":
			return "AUTO";
		case "any":
			return "ANY";
		case "none":
			return "NONE";
		default:
			return undefined;
	}
}

/** Convert one normalized message to a Gemini `contents[]` entry, or null to skip. */
function toCodeAssistContent(msg: NormalizedMessage): Record<string, unknown> | null {
	if (!msg || typeof msg !== "object") return null;
	const parts: Record<string, unknown>[] = [];

	if (msg.role === "tool") {
		for (const r of msg.toolResults ?? []) {
			parts.push({ functionResponse: { name: r.name, response: normalizeFunctionResponse(r.response) } });
		}
		if (parts.length === 0 && typeof msg.text === "string" && msg.text) parts.push({ text: msg.text });
		return parts.length > 0 ? { role: "user", parts } : null;
	}

	if (msg.role === "assistant") {
		if (typeof msg.text === "string" && msg.text) parts.push({ text: msg.text });
		for (const c of msg.toolCalls ?? []) {
			const fc: Record<string, unknown> = { functionCall: { name: c.name, args: c.args ?? {} } };
			// Preserve the thinking signature verbatim — required for Gemini-3 replay.
			if (c.thoughtSignature) fc.thoughtSignature = c.thoughtSignature;
			parts.push(fc);
		}
		return parts.length > 0 ? { role: "model", parts } : null;
	}

	// user
	if (typeof msg.text === "string" && msg.text) parts.push({ text: msg.text });
	for (const img of msg.images ?? []) {
		if (img && typeof img.data === "string") parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
	}
	return parts.length > 0 ? { role: "user", parts } : null;
}

/**
 * Generalize `buildGenerateContentBody` to a full multi-turn / tool-enabled Code
 * Assist `:generateContent` / `:streamGenerateContent` request body. Pure.
 */
export function convertContextToCodeAssist(args: ConvertContextArgs, project?: string): Record<string, unknown> {
	const proj = project ?? args.project;
	const contents: Record<string, unknown>[] = [];
	for (const msg of args.messages ?? []) {
		const content = toCodeAssistContent(msg);
		if (content) contents.push(content);
	}

	const request: Record<string, unknown> = { contents };
	if (args.systemPrompt && args.systemPrompt.trim()) {
		request.systemInstruction = { role: "user", parts: [{ text: args.systemPrompt }] };
	}
	if (args.tools && args.tools.length > 0) {
		request.tools = [
			{
				functionDeclarations: args.tools.map((t) => {
					const decl: Record<string, unknown> = { name: t.name };
					if (t.description) decl.description = t.description;
					if (t.parameters && typeof t.parameters === "object") decl.parametersJsonSchema = t.parameters;
					return decl;
				}),
			},
		];
		const mode = toolChoiceMode(args.toolChoice);
		if (mode) request.toolConfig = { functionCallingConfig: { mode } };
	}
	const generationConfig = buildGenerationConfig(args.maxTokens, args.thinkingLevel);
	if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;

	const body: Record<string, unknown> = { model: args.model, request };
	if (proj) body.project = proj;
	return body;
}

// ── Streaming SSE parsing + usage / finish mapping (pure) ───────────

/** Normalized pi-style token usage extracted from Gemini `usageMetadata`. */
export interface CodeAssistUsage {
	input: number;
	output: number;
	thinking?: number;
	cached?: number;
	total?: number;
}

/** A normalized delta parsed from one Code Assist SSE chunk. */
export interface CodeAssistStreamDelta {
	textDelta?: string;
	thinkingDelta?: string;
	toolCall?: NormalizedToolCall;
	thoughtSignature?: string;
	/** A pi StopReason: `stop` | `length` | `toolUse` | `error`. */
	finishReason?: string;
	usage?: CodeAssistUsage;
}

/** Map a Gemini `finishReason` (+ tool-call presence) to a pi StopReason. */
export function mapFinishReason(reason: string | undefined, hasToolCall: boolean): string | undefined {
	if (hasToolCall) return "toolUse";
	if (!reason) return undefined;
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		case "FINISH_REASON_UNSPECIFIED":
			return undefined;
		default:
			// SAFETY, RECITATION, MALFORMED_FUNCTION_CALL, BLOCKLIST, … → error.
			return "error";
	}
}

/** Map Gemini `usageMetadata` to the normalized usage shape, or undefined. Pure. */
export function extractUsageMetadata(meta: any): CodeAssistUsage | undefined {
	if (!meta || typeof meta !== "object") return undefined;
	const num = (v: any) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
	const input = num(meta.promptTokenCount);
	const output = num(meta.candidatesTokenCount);
	const thinking = num(meta.thoughtsTokenCount);
	const cached = num(meta.cachedContentTokenCount);
	const total = num(meta.totalTokenCount);
	if (input === undefined && output === undefined && thinking === undefined && cached === undefined && total === undefined) {
		return undefined;
	}
	const usage: CodeAssistUsage = { input: input ?? 0, output: output ?? 0 };
	if (thinking !== undefined) usage.thinking = thinking;
	if (cached !== undefined) usage.cached = cached;
	if (total !== undefined) usage.total = total;
	return usage;
}

/**
 * Parse one decoded Code Assist SSE chunk (the standard `GenerateContent` response,
 * wrapped under `response`) into a normalized delta. Pure / deterministic.
 */
export function parseCodeAssistStreamChunk(payload: any): CodeAssistStreamDelta {
	const delta: CodeAssistStreamDelta = {};
	const candidates = payload?.response?.candidates ?? payload?.candidates ?? [];
	const cand = candidates?.[0];
	const parts = cand?.content?.parts ?? [];

	let text = "";
	let thinking = "";
	let hasToolCall = false;
	for (const p of parts) {
		if (!p || typeof p !== "object") continue;
		if (p.functionCall && typeof p.functionCall === "object") {
			delta.toolCall = {
				name: String(p.functionCall.name ?? ""),
				args: p.functionCall.args && typeof p.functionCall.args === "object" ? p.functionCall.args : {},
				...(typeof p.thoughtSignature === "string" ? { thoughtSignature: p.thoughtSignature } : {}),
			};
			hasToolCall = true;
			continue;
		}
		if (typeof p.text === "string") {
			if (p.thought === true) thinking += p.text;
			else text += p.text;
		}
		if (typeof p.thoughtSignature === "string" && !delta.thoughtSignature) delta.thoughtSignature = p.thoughtSignature;
	}
	if (text) delta.textDelta = text;
	if (thinking) delta.thinkingDelta = thinking;

	const usage = extractUsageMetadata(payload?.response?.usageMetadata ?? payload?.usageMetadata);
	if (usage) delta.usage = usage;

	const reason = mapFinishReason(typeof cand?.finishReason === "string" ? cand.finishReason : undefined, hasToolCall);
	if (reason) delta.finishReason = reason;
	return delta;
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

// ── Streaming (`:streamGenerateContent?alt=sse`) ────────────────────

/**
 * A descriptive Code Assist failure. `reauth` marks credential-expiry (HTTP
 * 401/403 or a missing account) so callers can surface a clear re-login message;
 * `aborted` marks an AbortSignal/timeout cancellation. The message is always
 * redacted of token material before it reaches a log or the UI.
 */
export class CodeAssistError extends Error {
	readonly status?: number;
	readonly reauth: boolean;
	readonly aborted: boolean;
	constructor(message: string, opts: { status?: number; reauth?: boolean; aborted?: boolean } = {}) {
		super(message);
		this.name = "CodeAssistError";
		this.status = opts.status;
		this.reauth = !!opts.reauth;
		this.aborted = !!opts.aborted;
	}
}

/** User-facing copy when a Google account session needs re-authentication. */
export const GOOGLE_CODE_ASSIST_REAUTH_MESSAGE =
	"Google account session expired or unauthorized. Re-authenticate via Settings \u2192 Account \u2192 Google (Gemini).";

/** True for HTTP statuses that mean the Google credential must be refreshed/re-issued. */
export function isReauthStatus(status: number): boolean {
	return status === 401 || status === 403;
}

/**
 * Streaming transport response. A superset of `FetchLike`'s buffered shape that
 * also exposes the SSE `body` as a web `ReadableStream` or an async iterable of
 * byte/string chunks (the test seam). `text()` is used only for non-2xx bodies.
 */
export interface StreamFetchResponse {
	ok: boolean;
	status: number;
	text: () => Promise<string>;
	body?: ReadableStreamLike | AsyncIterable<Uint8Array | string> | null;
}

interface ReadableStreamLike {
	getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array | string }>; releaseLock?: () => void };
}

export type StreamFetchLike = (
	url: string,
	init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<StreamFetchResponse>;

export interface CodeAssistStreamArgs {
	model: string;
	systemPrompt?: string;
	messages: NormalizedMessage[];
	tools?: NormalizedToolDecl[];
	toolChoice?: ToolChoice;
	maxTokens?: number;
	thinkingLevel?: string;
	/** Abort the stream after this many ms (deterministic even if fetch ignores `signal`). */
	timeoutMs?: number;
	/** Caller cancellation; mapped to a terminal aborted error. */
	signal?: AbortSignal;
}

export interface CodeAssistStreamDeps {
	getToken?: () => Promise<string | null>;
	getProject?: (token: string) => Promise<string | undefined>;
	fetchFn?: StreamFetchLike;
}

function isAbortError(err: unknown): boolean {
	return err instanceof Error && (err.name === "AbortError" || /\babort/i.test(err.message));
}

/** Yield decoded string chunks from a web ReadableStream or an async iterable. */
async function* readBodyChunks(body: StreamFetchResponse["body"]): AsyncGenerator<string> {
	if (!body) return;
	const decoder = new TextDecoder();
	const asStream = body as Partial<ReadableStreamLike>;
	if (typeof asStream.getReader === "function") {
		const reader = asStream.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value == null) continue;
				yield typeof value === "string" ? value : decoder.decode(value, { stream: true });
			}
		} finally {
			try {
				reader.releaseLock?.();
			} catch {
				// ignore
			}
		}
		return;
	}
	if (typeof (body as any)[Symbol.asyncIterator] === "function") {
		for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
			if (chunk == null) continue;
			yield typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
		}
	}
}

/** Parse an SSE byte/string chunk stream into the JSON payload of each `data:` event. */
async function* parseSseEvents(chunks: AsyncGenerator<string>): AsyncGenerator<string> {
	let buf = "";
	let dataLines: string[] = [];
	function* flush(): Generator<string> {
		if (dataLines.length === 0) return;
		const data = dataLines.join("\n");
		dataLines = [];
		if (data && data !== "[DONE]") yield data;
	}
	const handleLine = function* (raw: string): Generator<string> {
		let line = raw;
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (line === "") {
			yield* flush();
			return;
		}
		if (line.startsWith(":")) return; // comment
		if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
		// other SSE fields (event:, id:, retry:) are ignored
	};
	for await (const chunk of chunks) {
		buf += chunk;
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			yield* handleLine(line);
		}
	}
	if (buf) yield* handleLine(buf);
	yield* flush();
}

/**
 * Stream a multi-turn / tool-enabled completion against
 * `…/v1internal:streamGenerateContent?alt=sse`. The streaming sibling of
 * `codeAssistComplete`: resolves a fresh Bearer token + project, converts the
 * normalized context to a Code Assist body, then yields normalized deltas parsed
 * from the SSE body. Honors `signal`/`timeoutMs` and raises `CodeAssistError`
 * (with `reauth`/`aborted` set and token material redacted) on failure.
 */
export async function* codeAssistStream(
	args: CodeAssistStreamArgs,
	deps: CodeAssistStreamDeps = {},
): AsyncGenerator<CodeAssistStreamDelta> {
	const fetchFn = deps.fetchFn ?? (defaultFetch() as unknown as StreamFetchLike);
	const getToken = deps.getToken ?? getGoogleAccessToken;
	const token = await getToken();
	if (!token) {
		throw new CodeAssistError(`No Google account credential available. ${GOOGLE_CODE_ASSIST_REAUTH_MESSAGE}`, {
			status: 401,
			reauth: true,
		});
	}

	const getProject = deps.getProject ?? ((t: string) => ensureCodeAssistProject(t, undefined, args.timeoutMs));
	const project = await getProject(token);
	const body = convertContextToCodeAssist(
		{
			model: args.model,
			systemPrompt: args.systemPrompt,
			messages: args.messages,
			tools: args.tools,
			toolChoice: args.toolChoice,
			maxTokens: args.maxTokens,
			thinkingLevel: args.thinkingLevel,
		},
		project,
	);

	// Abort + timeout: race the body iteration against a timer that also aborts the
	// request, deterministic even if the fetch impl ignores `signal` (test stub).
	const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const onExternalAbort = () => controller?.abort();
	if (args.signal) {
		if (args.signal.aborted) controller?.abort();
		else args.signal.addEventListener("abort", onExternalAbort, { once: true });
	}
	if (typeof args.timeoutMs === "number" && args.timeoutMs > 0) {
		timer = setTimeout(() => {
			timedOut = true;
			controller?.abort();
		}, args.timeoutMs);
	}

	const init = {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: controller?.signal,
	};

	try {
		// Short-circuit an already-fired abort (signal aborted during token/project
		// resolution) so we don't depend on the transport observing `signal` late.
		if (controller?.signal.aborted) throw new Error("aborted");
		const res = await fetchFn(`${codeAssistUrl("streamGenerateContent")}?alt=sse`, init);
		if (!res.ok) {
			const text = await res.text();
			throw new CodeAssistError(
				`Code Assist streamGenerateContent failed: HTTP ${res.status} ${redactSensitive(text).slice(0, 256)}`,
				{ status: res.status, reauth: isReauthStatus(res.status) },
			);
		}
		for await (const data of parseSseEvents(readBodyChunks(res.body))) {
			let json: any;
			try {
				json = JSON.parse(data);
			} catch {
				continue; // skip malformed/partial JSON lines
			}
			// Code Assist can emit an inline error object in the SSE body.
			const errObj = json?.error ?? json?.response?.error;
			if (errObj) {
				const status = typeof errObj.code === "number" ? errObj.code : undefined;
				const msg = redactSensitive(String(errObj.message ?? "Code Assist stream error")).slice(0, 256);
				throw new CodeAssistError(`Code Assist stream error: ${msg}`, {
					status,
					reauth: typeof status === "number" ? isReauthStatus(status) : false,
				});
			}
			yield parseCodeAssistStreamChunk(json);
		}
	} catch (err) {
		if (controller?.signal.aborted || isAbortError(err)) {
			throw new CodeAssistError(
				timedOut ? `Code Assist streamGenerateContent timed out after ${args.timeoutMs}ms` : "Code Assist stream aborted",
				{ aborted: true },
			);
		}
		throw err;
	} finally {
		if (timer) clearTimeout(timer);
		if (args.signal) args.signal.removeEventListener("abort", onExternalAbort);
	}
}
