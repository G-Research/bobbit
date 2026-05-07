/**
 * Pure helper that resolves `spawnedBySessionId` for a child goal at
 * spawn time. Used by:
 *
 *   - `POST /api/goals/:id/spawn-child` in `src/server/server.ts`
 *     (HTTP path — has body and headers).
 *   - `verification-harness.runSubgoalStep` (in-process path — no body /
 *     headers, only the parent goal id and team manager).
 *
 * Single source of truth so a future cascade tweak lands in ONE place.
 *
 * Tier order (highest precedence first):
 *
 *   1. `body.spawnedBySessionId` — explicit caller claim.
 *   2. `x-bobbit-spawning-session` header — children-tools extension's
 *      authoritative claim (set by `defaults/tools/children/extension.ts`).
 *   3. `x-bobbit-session-id` header — defence-in-depth: every other
 *      tool extension already sends this (MCP, `read_session`), so a
 *      raw cURL invocation issued from inside an agent will still
 *      carry it. Treat as the spawning agent's session.
 *   4. `teamManager.getTeamState(parentGoalId)?.teamLeadSessionId` —
 *      parent goal's live team-lead. Mirrors the inline derivation
 *      that `runSubgoalStep` previously did.
 *   5. (fallback) — return `{ value: undefined, tier: 5 }` and let the
 *      caller decide how to log / handle. The helper itself is silent
 *      so it stays pure and unit-testable.
 *
 * Empty strings (after trim) at any tier fall through to the next tier.
 * Array-valued headers (`x-…: ["a", "b"]`) coerce to the first element.
 */

export interface ResolveSpawnedBySessionIdArgs {
	body?: unknown;
	headers?: Record<string, string | string[] | undefined> | undefined;
	parentGoalId: string;
	teamManager?: { getTeamState(id: string): { teamLeadSessionId?: string | null } | undefined } | undefined;
}

export interface ResolveSpawnedBySessionIdResult {
	value: string | undefined;
	tier: 1 | 2 | 3 | 4 | 5;
}

function readHeader(
	headers: Record<string, string | string[] | undefined> | undefined,
	name: string,
): string | undefined {
	if (!headers) return undefined;
	// Node lowercases incoming HTTP headers by default, but tests / forwarded
	// requests can pass mixed-case keys. Be defensive.
	const lower = name.toLowerCase();
	const direct = headers[lower];
	let raw: string | string[] | undefined = direct;
	if (raw === undefined) {
		for (const k of Object.keys(headers)) {
			if (k.toLowerCase() === lower) {
				raw = headers[k];
				break;
			}
		}
	}
	if (raw === undefined) return undefined;
	const first = Array.isArray(raw) ? raw[0] : raw;
	if (typeof first !== "string") return undefined;
	const trimmed = first.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function readBodyField(body: unknown): string | undefined {
	if (!body || typeof body !== "object") return undefined;
	const v = (body as { spawnedBySessionId?: unknown }).spawnedBySessionId;
	if (typeof v !== "string") return undefined;
	const trimmed = v.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveSpawnedBySessionId(
	args: ResolveSpawnedBySessionIdArgs,
): ResolveSpawnedBySessionIdResult {
	// Tier 1 — explicit body field.
	const t1 = readBodyField(args.body);
	if (t1) return { value: t1, tier: 1 };

	// Tier 2 — children-tools extension header.
	const t2 = readHeader(args.headers, "x-bobbit-spawning-session");
	if (t2) return { value: t2, tier: 2 };

	// Tier 3 — generic agent-session header (defence in depth).
	const t3 = readHeader(args.headers, "x-bobbit-session-id");
	if (t3) return { value: t3, tier: 3 };

	// Tier 4 — parent's live team-lead.
	const tlRaw = args.teamManager?.getTeamState?.(args.parentGoalId)?.teamLeadSessionId;
	if (typeof tlRaw === "string") {
		const trimmed = tlRaw.trim();
		if (trimmed.length > 0) return { value: trimmed, tier: 4 };
	}

	return { value: undefined, tier: 5 };
}
