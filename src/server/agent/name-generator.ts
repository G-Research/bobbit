/**
 * Generates role-themed funny names for team agents using Claude Haiku.
 * Called when a new role is created; writes to data/team-names/<role>.json.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { refreshOAuthToken } from "../auth/oauth.js";
import { redactSensitive } from "../auth/redact.js";
import { globalAuthPath } from "../bobbit-dir.js";
import { createAnthropicDirectHeaders, type AnthropicDirectCredentials } from "./anthropic-direct-request.js";
import { invalidateRoleNameCache } from "./team-names.js";

const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

const __dirname = dirname(fileURLToPath(import.meta.url));
const NAMES_DIR = join(__dirname, "..", "..", "..", "data", "team-names");
const MODEL = "claude-haiku-4-5-20251001";
const API_URL = "https://api.anthropic.com/v1/messages";

type AuthCredentials = AnthropicDirectCredentials;

/**
 * API keys remain a direct stored-credential path. OAuth access is deliberately
 * not read here: refreshOAuthToken() owns its Pi-backed, locked resolution.
 */
function loadAuthKind(): AuthCredentials | null {
	const authPath = globalAuthPath();
	if (!existsSync(authPath)) return null;
	try {
		const data = JSON.parse(readFileSync(authPath, "utf-8"));
		const cred = data.anthropic;
		if (!cred) return null;
		if (cred.type === "oauth") return { type: "oauth", access: "" };
		if ((cred.type === "api-key" || cred.type === "api_key") && typeof cred.key === "string" && cred.key) {
			return { type: "api-key", access: cred.key };
		}
		return null;
	} catch {
		return null;
	}
}

/** Return an allow-listed upstream outcome; provider payloads can contain credentials. */
function anthropicErrorSummary(status: number, errorText?: string): string {
	if (status === 404 || /model[^\n]{0,40}not found|model_not_found/i.test(errorText ?? "")) return "model_not_found (404)";
	if (status === 401 || status === 403) return `authentication (${status})`;
	if (status === 429 || /rate[^\n]{0,20}limit|spend[^\n]{0,20}limit|quota/i.test(errorText ?? "")) return "rate_or_spend_limit (429)";
	if (status >= 500) return `upstream_unavailable (${status})`;
	return `request_failed (${status})`;
}

function requestFailureSummary(error: unknown): string {
	const message = error instanceof Error ? redactSensitive(error.message) : "";
	if (/timed?\s*out|aborted/i.test(message)) return "timeout_or_abort";
	return "request_failed";
}

/**
 * Generate 500 funny, role-themed names and write them to data/team-names/<role>.json.
 * Fire-and-forget — failures are logged but don't block role creation.
 */
export async function generateRoleNames(roleName: string, roleLabel: string, fetchImpl: typeof fetch = defaultFetch): Promise<void> {
	const outPath = join(NAMES_DIR, `${roleName}.json`);

	// Don't overwrite existing curated files
	if (existsSync(outPath)) {
		console.log(`[name-gen] Names file already exists for role "${roleName}", skipping`);
		return;
	}

	const configuredAuth = loadAuthKind();
	if (!configuredAuth) {
		console.error(`[name-gen] No auth available, cannot generate names for role "${roleName}"`);
		return;
	}

	// Pi's runtime owns OAuth storage, expiry buffering, and rotation. Resolve on
	// every OAuth request rather than trusting an independently-read access token.
	let auth = configuredAuth;
	if (auth.type === "oauth") {
		const access = await refreshOAuthToken();
		if (!access) {
			console.error("[name-gen] OAuth credential resolution failed");
			return;
		}
		auth = { type: "oauth", access };
	}

	const headers = createAnthropicDirectHeaders(auth);

	const systemText = auth.type === "oauth"
		? "You are Claude Code, Anthropic's official CLI for Claude. You generate funny names for AI coding agents."
		: "You generate funny names for AI coding agents.";

	const prompt = `Generate exactly 500 funny names for an AI agent whose role is "${roleLabel}" (id: "${roleName}").

Rules:
1. Every name MUST feel like a real name — something you'd call a person, pet, or character. First+Last, a nickname, or a character name. If you wouldn't introduce someone by it, reject it.
2. Keep them SHORT — 2 words max. No exceptions.
3. The humor can come from: puns on real names (JSON Derulo, Lint Eastwood, Meryl Heap), light absurdity (Señor Bugs), or just a fun character name (Forky, The Dude). Not every name needs a tech pun.
4. NO jargon-only names, NO keyboard symbols (Ctrl+Z), NO acronyms, NO "Mc___face" patterns, NO compound words that aren't names (Semicolonoscopy).
5. Pop culture references are great when the original is well-known and the pun is obvious. Obscure references don't land.
6. Every name should make the reader smirk. If a name is just a random noun or a straight celebrity name with no twist, cut it.
7. The role connection can be subtle or absent — a great name beats a forced pun. A forced pun where you have to squint to see the connection is worse than no pun at all.
8. Mix: ~50% punny celebrity/character names with a tech twist, ~25% beloved fictional characters, ~25% short characterful nicknames (pet names, food names, fun single words with character).
9. No verbatim movie/show titles — the reference should be transformed, not copied.

GOOD examples: "JSON Derulo", "Lint Eastwood", "Meryl Heap", "Boba Fetch", "Veto Corleone", "Null Jackman", "Señor Bugs", "Forky", "Pickle", "Phoebe Buffering"
BAD examples: "Semicolonoscopy", "LGTM-NOT", "Ctrl+Zendaya", "Testy McTestface", "Cache Money", "Dwayne The Docs Johnson"

Output a JSON array of 500 strings. Output ONLY the JSON array, no explanation, no markdown fences.`;

	const body = {
		model: MODEL,
		max_tokens: 16384,
		system: auth.type === "oauth"
			? [{ type: "text", text: systemText }]
			: systemText,
		messages: [{ role: "user", content: prompt }],
	};

	console.log(`[name-gen] Generating names for role "${roleName}" via ${MODEL}…`);

	try {
		const response = await fetchImpl(API_URL, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		// Pi resolves expiry and refreshes before this request. A Messages 401/403
		// is a definitive authentication/authorization result, not a signal to
		// repeat the same Pi-backed credential resolution.

		if (!response.ok) {
			// The body is classified but never emitted because upstream payloads can
			// reflect request secrets or contain arbitrary sensitive text.
			const errorText = await response.text();
			console.error(`[name-gen] Anthropic completion failed: ${anthropicErrorSummary(response.status, errorText)}`);
			return;
		}

		const data = (await response.json()) as {
			content: Array<{ type: string; text?: string }>;
		};

		const text = data.content
			?.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("")
			.trim();

		if (!text) {
			console.error("[name-gen] Empty response");
			return;
		}

		// Parse the JSON array — strip markdown fences if present
		const cleaned = text.replace(/^```json?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
		const names = JSON.parse(cleaned);

		if (!Array.isArray(names) || names.length === 0) {
			console.error("[name-gen] Response was not a valid array");
			return;
		}

		// Filter to only valid short strings
		const valid = names
			.filter((n: unknown): n is string => typeof n === "string" && n.length > 0 && n.length <= 30)
			.slice(0, 500);

		if (valid.length < 50) {
			console.error(`[name-gen] Only ${valid.length} valid names generated, skipping`);
			return;
		}

		mkdirSync(NAMES_DIR, { recursive: true });
		writeFileSync(outPath, JSON.stringify(valid, null, 2) + "\n", "utf-8");
		invalidateRoleNameCache(roleName);

		console.log(`[name-gen] Wrote ${valid.length} names to ${outPath}`);
	} catch (err) {
		console.error(`[name-gen] Failed: ${requestFailureSummary(err)}`);
	}
}
