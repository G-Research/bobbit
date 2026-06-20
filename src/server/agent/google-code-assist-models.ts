/**
 * Account-backed Gemini model list for the `google-gemini-cli` (Code Assist / OAuth)
 * provider. Metadata is derived from pi-ai's built-in `google` catalog so context
 * windows / costs stay in sync, but the models are re-emitted under provider
 * `google-gemini-cli` with `api: "google-code-assist"` so the runtime routes them to
 * the Code Assist Bearer adapter instead of the API-key Gemini Developer API.
 *
 * Models are only emitted when a Google account credential is present (see
 * `hasGoogleCodeAssistCredential`), so the selector is not cluttered with
 * non-functional account models for users who never log in with Google.
 *
 * These models ARE runnable in agent sessions: the generated Code Assist provider
 * extension registers a `google-code-assist` api inside the pi-coding-agent runtime
 * and streams to `cloudcode-pa.googleapis.com`, fetching a fresh Bearer token +
 * project id from the gateway per request. They are therefore emitted as
 * session-selectable. The API-key `google` (Gemini Developer API) provider is a
 * distinct wire protocol and is unaffected.
 *
 * Caution: Google account (Code Assist / Gemini CLI) usage is subject to the
 * account's Code Assist quota/tier and is not the official AI Studio API path.
 *
 * Design: docs/design/google-session-models.md; docs/design/google-oauth-model-auth.md §4.5.
 */

import { getModels } from "@earendil-works/pi-ai";

import type { ApiModel } from "./model-registry.js";
import {
	GOOGLE_CODE_ASSIST_API,
	GOOGLE_GEMINI_CLI_PROVIDER,
	hasGoogleCodeAssistCredential,
} from "./google-code-assist.js";

/**
 * Curated allowlist of Gemini ids the Code Assist (cloudcode-pa) endpoint actually
 * serves over the OAuth/account path. This is intentionally an explicit allowlist
 * rather than a `gemini-*` heuristic: pi-ai's `google` catalog carries Developer
 * API (AI Studio) models that Code Assist 404s on ("Requested entity not found"),
 * e.g. `gemini-2.0-*`, `gemini-3.5-flash`, and the `*-latest` aliases. Emitting
 * those made them selectable and produced live HTTP 404 session failures.
 *
 * Membership was confirmed against live Code Assist probes (see
 * docs/google-oauth-models.md). Only emit an id when it is BOTH on this allowlist
 * AND present in pi-ai's `google` catalog, so we never emit a stale id and metadata
 * (context window / cost) stays in sync.
 */
const CODE_ASSIST_ALLOWLIST: ReadonlySet<string> = new Set([
	"gemini-2.5-flash",
	"gemini-2.5-flash-lite",
	"gemini-2.5-pro",
	"gemini-3-pro-preview",
	"gemini-3.1-pro-preview",
	"gemini-3-flash-preview",
	"gemini-3.1-flash-lite",
	"gemini-3.1-flash-lite-preview",
]);

function isCodeAssistEligible(id: string): boolean {
	return CODE_ASSIST_ALLOWLIST.has(id.toLowerCase());
}

export function getGoogleCodeAssistModels(): ApiModel[] {
	if (!hasGoogleCodeAssistCredential()) return [];

	let base: Array<Record<string, any>> = [];
	try {
		base = getModels("google" as any) as unknown as Array<Record<string, any>>;
	} catch {
		return [];
	}

	const models: ApiModel[] = [];
	for (const m of base) {
		if (!isCodeAssistEligible(String(m.id))) continue;
		models.push({
			id: m.id,
			name: `${m.name || m.id} (Google account)`,
			provider: GOOGLE_GEMINI_CLI_PROVIDER,
			api: GOOGLE_CODE_ASSIST_API,
			baseUrl: "https://cloudcode-pa.googleapis.com",
			contextWindow: m.contextWindow || 1_048_576,
			maxTokens: m.maxTokens || 65_536,
			reasoning: !!m.reasoning,
			...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap as Record<string, string | null> } : {}),
			input: (m.input || ["text"]) as ("text" | "image")[],
			cost: m.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			// `authenticated` is set by the registry via detectProviderAuth.
			authenticated: false,
			// Account-backed Code Assist models run in sessions via the generated
			// provider extension, so they are session-selectable (no gate).
		});
	}
	return models;
}
