/**
 * GitHub PR status caching (gh CLI).
 * Extracted from server.ts (commit: split server.ts).
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const PR_NULL_CACHE_TTL_MS = 30_000; // 30 seconds for null (no-PR) results

const _prCache = new Map<string, { data: any; ts: number; ttl: number }>();
const _prInFlight = new Map<string, Promise<any | null>>();

// Cache viewer permission per repo (rarely changes, long TTL)
const _repoPermCache = new Map<string, { perm: string; ts: number }>();
const REPO_PERM_CACHE_TTL_MS = 300_000; // 5 minutes

export async function getViewerIsAdmin(cwd: string): Promise<boolean> {
	const cached = _repoPermCache.get(cwd);
	if (cached && Date.now() - cached.ts < REPO_PERM_CACHE_TTL_MS) return cached.perm === "ADMIN";
	try {
		const { stdout } = await execAsync("gh repo view --json viewerPermission", {
			cwd, encoding: "utf-8", timeout: 10000,
		});
		const perm = JSON.parse(stdout).viewerPermission ?? "";
		_repoPermCache.set(cwd, { perm, ts: Date.now() });
		return perm === "ADMIN";
	} catch {
		_repoPermCache.set(cwd, { perm: "", ts: Date.now() });
		return false;
	}
}

async function _fetchPrStatus(cwd: string, branch?: string, fallbackCwd?: string): Promise<any | null> {
	const cacheKey = branch ? `${cwd}::${branch}` : cwd;
	const ghFields = "--json state,url,number,title,mergeable,headRefName,reviewDecision";
	const branchArg = branch ? ` ${branch}` : "";
	const cmd = `gh pr view${branchArg} ${ghFields}`;

	// Try cwd first, then fallback (e.g. main repo when worktree git link is broken)
	const cwdsToTry = [cwd, ...(fallbackCwd && fallbackCwd !== cwd ? [fallbackCwd] : [])];
	for (const dir of cwdsToTry) {
		try {
			const { stdout } = await execAsync(cmd, { cwd: dir, encoding: "utf-8", timeout: 10000 });
			const pr = JSON.parse(stdout);
			const viewerIsAdmin = await getViewerIsAdmin(dir);
			const data = { number: pr.number, url: pr.url, title: pr.title, state: pr.state, mergeable: pr.mergeable, headRefName: pr.headRefName, reviewDecision: pr.reviewDecision || null, viewerIsAdmin };
			const ttl = pr.state === "OPEN" ? 10_000 : 900_000; // OPEN: 10s, CLOSED/MERGED: 15min
			_prCache.set(cacheKey, { data, ts: Date.now(), ttl });
			return data;
		} catch {
			// Try next cwd
		}
	}
	_prCache.set(cacheKey, { data: null, ts: Date.now(), ttl: PR_NULL_CACHE_TTL_MS });
	return null;
}

/** Invalidate cached PR status entries for a cwd (and optionally a branch). */
export function clearPrStatusCache(cwd: string, branch?: string): void {
	_prCache.delete(cwd);
	if (branch) _prCache.delete(`${cwd}::${branch}`);
}

export async function getCachedPrStatus(cwd: string, branch?: string, fallbackCwd?: string): Promise<any | null> {
	const cacheKey = branch ? `${cwd}::${branch}` : cwd;
	const cached = _prCache.get(cacheKey);
	if (cached && Date.now() - cached.ts < cached.ttl) return cached.data;

	const existing = _prInFlight.get(cacheKey);
	if (existing) return existing;

	const p = _fetchPrStatus(cwd, branch, fallbackCwd);
	_prInFlight.set(cacheKey, p);
	try { return await p; } finally { _prInFlight.delete(cacheKey); }
}
