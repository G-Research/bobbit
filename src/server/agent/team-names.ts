/**
 * Fun name generator for team agents.
 *
 * Each role has its own name pool in data/team-names/<role>.json.
 * Falls back to the generic pool in data/team-names.json for roles
 * without a dedicated file.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "..", "data");

// Generic fallback pool (loaded once)
let GENERIC_POOL: string[];
try {
	GENERIC_POOL = JSON.parse(readFileSync(join(DATA_DIR, "team-names.json"), "utf-8"));
} catch {
	GENERIC_POOL = [
		"Ctrl+Z", "The Intern", "Bug Lebowski", "Darth Linter", "Null Pointer",
		"Greg from QA", "El Debuggador", "Syntax Sinatra", "404 Not Found",
		"Oops McFixit", "Fizzbuzz", "Glitch", "Spaghetti", "Wombat", "Biscuit",
		"Turbo Pascal", "Zero Cool", "Crash Override", "Scrambles", "Beans",
	];
}

// Per-role pools (loaded on demand, cached)
const rolePools = new Map<string, string[]>();

function getPoolForRole(role: string): string[] {
	if (rolePools.has(role)) return rolePools.get(role)!;

	const filePath = join(DATA_DIR, "team-names", `${role}.json`);
	if (existsSync(filePath)) {
		try {
			const roleNames = JSON.parse(readFileSync(filePath, "utf-8"));
			if (Array.isArray(roleNames) && roleNames.length > 0) {
				// Merge role-specific names with generic pool, deduplicating
				const merged = [...new Set([...roleNames, ...GENERIC_POOL])];
				rolePools.set(role, merged);
				return merged;
			}
		} catch {
			// Fall through to generic
		}
	}

	// Cache the miss so we don't re-check the filesystem
	rolePools.set(role, GENERIC_POOL);
	return GENERIC_POOL;
}

// Track recently used names per role to avoid repeats
const recentlyUsedPerRole = new Map<string, Set<string>>();

/**
 * Pick a random fun name for a team agent.
 * Uses the role-specific name pool if available, otherwise falls back to generic.
 */
export async function generateTeamName(role?: string): Promise<string> {
	const effectiveRole = role ?? "__generic__";
	const pool = role ? getPoolForRole(role) : GENERIC_POOL;
	return pickName(pool, effectiveRole);
}

/**
 * Synchronous variant of `generateTeamName` for sync contexts that can't
 * await (e.g. constructor-time boot recovery in `TeamManager`). Same
 * underlying pool + recent-name cache; the async version above is preferred
 * elsewhere.
 */
export function generateTeamNameSync(role?: string): string {
	const effectiveRole = role ?? "__generic__";
	const pool = role ? getPoolForRole(role) : GENERIC_POOL;
	return pickName(pool, effectiveRole);
}

/**
 * Invalidate the cached pool for a role so it's reloaded from disk next time.
 * Called after generating a new names file for a newly-created role.
 */
export function invalidateRoleNameCache(role: string): void {
	rolePools.delete(role);
}

function pickName(pool: string[], cacheKey: string): string {
	let recent = recentlyUsedPerRole.get(cacheKey);
	if (!recent) {
		recent = new Set();
		recentlyUsedPerRole.set(cacheKey, recent);
	}

	const maxRecent = Math.min(Math.floor(pool.length / 2), 30);
	if (recent.size >= maxRecent) {
		recent.clear();
	}

	// Try to find a name not recently used
	for (let i = 0; i < 20; i++) {
		const name = pool[Math.floor(Math.random() * pool.length)];
		if (!recent.has(name)) {
			recent.add(name);
			return name;
		}
	}

	return pool[Math.floor(Math.random() * pool.length)];
}
