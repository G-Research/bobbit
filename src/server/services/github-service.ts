import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// ── PR status cache (avoids blocking event loop with gh CLI every poll) ──
const _prCache = new Map<string, { data: any; ts: number; ttl: number }>();
const PR_NULL_CACHE_TTL_MS = 30_000; // 30 seconds for null (no-PR) results
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

export async function fetchPrStatus(cwd: string, branch?: string): Promise<any | null> {
	const cacheKey = branch ? `${cwd}::${branch}` : cwd;
	try {
		const branchArg = branch ? ` ${branch}` : "";
		const { stdout } = await execAsync(`gh pr view${branchArg} --json state,url,number,title,mergeable,headRefName,reviewDecision`, {
			cwd,
			encoding: "utf-8",
			timeout: 10000,
		});
		const pr = JSON.parse(stdout);
		const viewerIsAdmin = await getViewerIsAdmin(cwd);
		const data = { number: pr.number, url: pr.url, title: pr.title, state: pr.state, mergeable: pr.mergeable, headRefName: pr.headRefName, reviewDecision: pr.reviewDecision || null, viewerIsAdmin };
		const ttl = pr.state === "OPEN" ? 10_000 : 900_000; // OPEN: 10s, CLOSED/MERGED: 15min
		_prCache.set(cacheKey, { data, ts: Date.now(), ttl });
		return data;
	} catch {
		_prCache.set(cacheKey, { data: null, ts: Date.now(), ttl: PR_NULL_CACHE_TTL_MS });
		return null;
	}
}

export async function getCachedPrStatus(cwd: string, branch?: string): Promise<any | null> {
	const cacheKey = branch ? `${cwd}::${branch}` : cwd;
	const cached = _prCache.get(cacheKey);
	if (cached && Date.now() - cached.ts < cached.ttl) return cached.data;

	const existing = _prInFlight.get(cacheKey);
	if (existing) return existing;

	const p = fetchPrStatus(cwd, branch);
	_prInFlight.set(cacheKey, p);
	try { return await p; } finally { _prInFlight.delete(cacheKey); }
}

// ── Async git helpers (avoid blocking event loop) ──
export async function execGit(cmd: string, cwd: string, timeout = 5000): Promise<string> {
	const { stdout } = await execAsync(cmd, { cwd, encoding: "utf-8", timeout });
	return stdout.trim();
}

export async function execGitSafe(cmd: string, cwd: string, fallback = ""): Promise<string> {
	try { return await execGit(cmd, cwd); } catch { return fallback; }
}

/** Bust the PR cache for a given cwd and optional branch */
export function bustPrCache(cwd: string, branch?: string): void {
	_prCache.delete(cwd);
	if (branch) _prCache.delete(`${cwd}::${branch}`);
}
