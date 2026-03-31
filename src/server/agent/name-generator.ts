/**
 * Generates role-themed funny names for team agents using Claude Haiku.
 * Called when a new role is created; writes to data/team-names/<role>.json.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { refreshOAuthToken } from "../auth/oauth.js";
import { globalAuthPath } from "../bobbit-dir.js";
import { invalidateRoleNameCache } from "./team-names.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NAMES_DIR = join(__dirname, "..", "..", "..", "data", "team-names");
const MODEL = "claude-haiku-4-5-20251001";
const API_URL = "https://api.anthropic.com/v1/messages";

interface AuthCredentials {
	type: string;
	access: string;
	refresh?: string;
	expires?: number;
}

function loadAuth(): AuthCredentials | null {
	const authPath = globalAuthPath();
	if (!existsSync(authPath)) return null;
	try {
		const data = JSON.parse(readFileSync(authPath, "utf-8"));
		const cred = data.anthropic;
		if (!cred) return null;
		if (cred.type === "oauth" && cred.access) return cred;
		if (cred.type === "api-key" && cred.key) return { type: "api-key", access: cred.key };
		return null;
	} catch {
		return null;
	}
}

/**
 * Generate 50 funny, role-themed names and write them to data/team-names/<role>.json.
 * Fire-and-forget — failures are logged but don't block role creation.
 */
export async function generateRoleNames(roleName: string, roleLabel: string): Promise<void> {
	const outPath = join(NAMES_DIR, `${roleName}.json`);

	// Don't overwrite existing curated files
	if (existsSync(outPath)) {
		console.log(`[name-gen] Names file already exists for role "${roleName}", skipping`);
		return;
	}

	let auth = loadAuth();
	if (!auth) {
		console.error(`[name-gen] No auth available, cannot generate names for role "${roleName}"`);
		return;
	}

	// Refresh OAuth if expired
	if (auth.type === "oauth" && auth.expires && Date.now() > auth.expires) {
		const newToken = await refreshOAuthToken();
		if (newToken) {
			auth = { ...auth, access: newToken };
		} else {
			console.error("[name-gen] Token expired and refresh failed");
			return;
		}
	}

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"anthropic-version": "2023-06-01",
	};
	if (auth.type === "oauth") {
		headers["Authorization"] = `Bearer ${auth.access}`;
		headers["anthropic-beta"] = "claude-code-20250219,oauth-2025-04-20";
	} else {
		headers["x-api-key"] = auth.access;
	}

	const systemText = auth.type === "oauth"
		? `You are Claude Code, Anthropic's official CLI for Claude. You generate funny names for AI coding agents.`
		: `You generate funny names for AI coding agents.`;

	const prompt = `Generate exactly 500 funny names for an AI agent whose role is "${roleLabel}" (id: "${roleName}").

Rules:
1. Every name MUST feel like a real name — something you'd call a person, pet, or character. First+Last, a nickname, or a character name. If you wouldn't introduce someone by it, reject it.
2. Keep them SHORT — 2 words max. No exceptions.
3. The humor can come from: puns on real names (JSON Derulo, Lint Eastwood, Meryl Heap), light absurdity (Señor Bugs), or just a fun character name (Forky, The Dude). Not every name needs a tech pun.
4. NO jargon-only names, NO keyboard symbols (Ctrl+Z), NO acronyms, NO "Mc___face" patterns, NO compound words that aren't names (Semicolonoscopy).
5. Pop culture references are great when the original is well-known and the pun is obvious. Obscure references don't land.
6. Every name should make the reader smirk. If a name is just a random noun or a straight celebrity name with no twist, cut it.
7. The role connection can be subtle or absent — a great name beats a forced pun. A forced pun where you have to squint to see the connection is worse than no pun at all.
8. Mix: ~50% punny celebrity/character names with a tech twist, ~25% beloved fictional characters, ~25% short characterful nicknames (pet names, food names, fun single words with personality).
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
		let response = await fetch(API_URL, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		// On auth errors, try refreshing the token and retrying once
		if (!response.ok && (response.status === 401 || response.status === 403) && auth.type === "oauth") {
			console.warn(`[name-gen] Auth error ${response.status}, attempting token refresh…`);
			const newToken = await refreshOAuthToken();
			if (newToken) {
				headers["Authorization"] = `Bearer ${newToken}`;
				response = await fetch(API_URL, { method: "POST", headers, body: JSON.stringify(body) });
			}
		}

		if (!response.ok) {
			const errText = await response.text();
			console.error(`[name-gen] API error ${response.status}: ${errText}`);
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
		console.error("[name-gen] Failed:", err);
	}
}
