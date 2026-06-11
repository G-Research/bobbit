import { GithubPrAdapterError, parseGithubRemoteUrl } from "./github-adapter.js";
import { execFileSafe } from "../exec-file-safe.js";
import type {
	PrWalkthroughJobError,
	PrWalkthroughJobRecord,
	PrWalkthroughTarget,
} from "./walkthrough-agent-store.js";

// ── Surviving pure target helpers ────────────────────────────────────────────
// The first-class `WalkthroughAgentManager` launcher (launch/launchNew/createSession
// spawn/submitYaml/readBundle/restore + the submit-proof secret + the kickoff/role
// prompts) was deleted in the host.agents reviewer migration (design §6 / Decision F
// Phase 3): the reviewer is now minted via `host.agents.spawn` from the pack `run`
// route, granted tools by the pack-shipped `pr-reviewer` role, and routed by the
// pack-store binding. Only these PURE helpers + types survive — they have no
// session/fs/proof side effects and are still referenced by `routes.ts` (the
// binding-routed bundle path) and the parity tests. The role prompt + kickoff text
// now live verbatim in `market-packs/pr-walkthrough/roles/pr-reviewer.yaml` and the
// pack `run` route respectively; `canonicalizeTarget` is mirrored in
// `market-packs/pr-walkthrough/lib/routes.mjs` for the confined worker.

type RpcLike = {
	prompt?: (text: string, images?: any) => Promise<unknown> | unknown;
	onEvent?: (handler: (event: unknown) => void) => (() => void);
};

type SessionLike = {
	id: string;
	title?: string;
	cwd?: string;
	worktreePath?: string;
	status?: string;
	archived?: boolean;
	projectId?: string;
	sandboxed?: boolean;
	rpcClient?: RpcLike;
	allowedTools?: string[];
};

type PersistedSessionLike = {
	id: string;
	cwd?: string;
	worktreePath?: string;
	status?: string;
	archived?: boolean;
	projectId?: string;
	sandboxed?: boolean;
	modelProvider?: string;
	modelId?: string;
};

/**
 * Structural view of SessionManager still consumed by `routes.ts` (the binding-routed
 * submit-yaml path stamps the generic terminal marker via `updateSessionMeta`).
 */
export type WalkthroughSessionManagerLike = {
	createSession: (
		cwd: string,
		agentArgs?: string[],
		goalId?: string,
		assistantType?: string,
		opts?: any,
	) => Promise<SessionLike>;
	getSession?: (sessionId: string) => SessionLike | undefined;
	getPersistedSession?: (sessionId: string) => PersistedSessionLike | undefined;
	updateSessionMeta?: (sessionId: string, updates: Record<string, unknown>) => boolean;
	setTitle?: (sessionId: string, title: string, opts?: Record<string, unknown>) => void;
	enqueuePrompt?: (sessionId: string, text: string, opts?: Record<string, unknown>) => Promise<unknown> | unknown;
	terminateSession?: (sessionId: string) => Promise<boolean> | boolean;
};

export type LaunchWalkthroughRequest = {
	sessionId?: string;
	parentSessionId?: string;
	prUrl?: string;
	prNumber?: string | number;
	owner?: string;
	repo?: string;
	baseSha?: string;
	headSha?: string;
	cwd?: string;
	projectId?: string;
};

/** The exact read-only tool grant for the PR walkthrough reviewer (now sourced via the
 *  pack-shipped `pr-reviewer` role; retained for parity assertions). */
export const WALKTHROUGH_ALLOWED_TOOLS = [
	"readonly_bash",
	"read_pr_walkthrough_bundle",
	"submit_pr_walkthrough_yaml",
];

export function canonicalizeTarget(input: LaunchWalkthroughRequest): PrWalkthroughTarget {
	const prUrl = stringValue(input.prUrl);
	const parsed = prUrl ? parseGithubPrUrl(prUrl) : undefined;
	const owner = stringValue(input.owner) ?? parsed?.owner;
	const repo = stringValue(input.repo) ?? parsed?.repo;
	const number = numberValue(input.prNumber) ?? parsed?.number;
	const baseSha = stringValue(input.baseSha);
	const headSha = stringValue(input.headSha);
	if (owner && repo && number !== undefined) {
		const host = normalizeGithubHost(parsed?.host);
		const url = prUrl ?? `https://${host}/${owner}/${repo}/pull/${number}`;
		// github.com keeps its historical key shape for back-compat with persisted
		// jobs/tabs; other hosts include the host in identity to avoid cross-host
		// dedup collisions for the same owner/repo/number.
		const canonicalKey = host === "github.com"
			? `github:${owner}/${repo}#${number}`
			: `github:${host}/${owner}/${repo}#${number}`;
		return { provider: "github", prUrl: url, owner, repo, number, baseSha, headSha, host, canonicalKey };
	}
	if (number !== undefined) {
		return { provider: "github", prUrl, number, baseSha, headSha, host: "github.com", canonicalKey: `github:unknown/unknown#${number}` };
	}
	if (baseSha && headSha) {
		return { provider: "local", baseSha, headSha, canonicalKey: `local:${baseSha}..${headSha}` };
	}
	throw routeError(400, "A GitHub PR URL/number or local baseSha/headSha is required", { code: "INVALID_TARGET" });
}

/**
 * Pure transform (no git) shared by the number-only launch path: applies the
 * inferred owner/repo/host to the target and host-qualifies the canonical key
 * for non-github.com hosts, mirroring canonicalizeTarget. Exported for testing.
 */
export function numberOnlyTargetFromInferred(
	target: PrWalkthroughTarget,
	inferred: { owner: string; repo: string; host?: string },
): PrWalkthroughTarget {
	const number = target.number;
	if (number === undefined) return target;
	const host = normalizeGithubHost(inferred.host);
	const prUrl = target.prUrl ?? `https://${host}/${inferred.owner}/${inferred.repo}/pull/${number}`;
	// Mirror canonicalizeTarget: github.com keeps the historical unqualified key,
	// other hosts include the host so number-only enterprise launches do not collide.
	const canonicalKey = host === "github.com"
		? `github:${inferred.owner}/${inferred.repo}#${number}`
		: `github:${host}/${inferred.owner}/${inferred.repo}#${number}`;
	return {
		...target,
		owner: inferred.owner,
		repo: inferred.repo,
		prUrl,
		host,
		canonicalKey,
	};
}

/** Best-effort GitHub origin inference (read-only git). Retained alongside the pure
 *  target helpers for completeness / potential reuse; no launch side effects. */
export async function inferGithubRepository(cwd: string): Promise<{ owner: string; repo: string; host: string } | undefined> {
	try {
		const { stdout } = await execFileSafe("git", ["remote", "get-url", "origin"], { cwd, timeout: 5_000, encoding: "utf8" });
		return parseGithubRemoteUrl(stdout) ?? undefined;
	} catch {
		return undefined;
	}
}

// Centralized prefix rule for github changeset ids: github.com (and
// www.github.com) keep the historical un-prefixed shape for back-compat with
// already-persisted jobs/tabs; every other host is qualified by the normalized
// host so two trusted enterprise hosts sharing owner/repo/number do not collide
// on the same tabId / stored-payload path / export lookup.
function githubChangesetHostPrefix(host: string | undefined): string {
	const normalized = normalizeGithubHost(host);
	return normalized === "github.com" ? "" : `${normalized}/`;
}

function changesetIdForTarget(target: PrWalkthroughTarget): string {
	if (target.provider === "github") {
		const repo = target.owner && target.repo ? `${target.owner}/${target.repo}` : "unknown/unknown";
		const prefix = githubChangesetHostPrefix(target.host);
		return `github:${prefix}${repo}#${target.number ?? "unknown"}`;
	}
	return `${shortSha(target.baseSha ?? "unknown")}..${shortSha(target.headSha ?? "unknown")}`;
}

export const changesetIdForTargetForTesting = changesetIdForTarget;

export function classifyDiffResolutionError(error: unknown): PrWalkthroughJobError {
	if (isRecord(error) && isRecord(error.extra) && typeof error.extra.code === "string") {
		return { code: error.extra.code, message: error instanceof Error ? error.message : String(error), retryable: error.extra.retryable !== false };
	}
	if (error instanceof GithubPrAdapterError) {
		if (error.code === "untrusted_github_host") {
			return { code: "untrusted_github_host", message: error.message, retryable: false, host: error.host };
		}
		if (error.status === 401 || error.code === "github_auth_failed") {
			return { code: "GITHUB_AUTH_REQUIRED", message: "GitHub rejected the configured credentials. Check GITHUB_TOKEN/GH_TOKEN or run gh auth status, then retry the walkthrough.", retryable: true };
		}
		if (error.status === 403 && error.code === "github_rate_limited") {
			return { code: "GITHUB_RATE_LIMITED", message: "GitHub API rate limit exceeded. Configure GITHUB_TOKEN/GH_TOKEN, run gh auth login, or retry after the rate-limit reset time.", retryable: true };
		}
		if (error.status === 403) {
			return { code: "GITHUB_FORBIDDEN", message: "GitHub denied access to this pull request or repository. Check token permissions and repository access, then retry.", retryable: true };
		}
		if (error.status === 404 || error.code === "github_pr_not_found") {
			return { code: "GITHUB_NOT_FOUND_OR_PRIVATE", message: "GitHub could not find this pull request. It may be private, deleted, or inaccessible with the current credentials.", retryable: true };
		}
	}
	const message = error instanceof Error ? error.message : String(error);
	if (/rate limit|api rate/i.test(message)) return { code: "GITHUB_RATE_LIMITED", message, retryable: true };
	if (/forbidden|permission|denied/i.test(message)) return { code: "GITHUB_FORBIDDEN", message, retryable: true };
	if (/not found|private|404/i.test(message)) return { code: "GITHUB_NOT_FOUND_OR_PRIVATE", message, retryable: true };
	if (/auth|credential|token|401/i.test(message)) return { code: "GITHUB_AUTH_REQUIRED", message, retryable: true };
	return { code: "DIFF_RESOLUTION_FAILED", message: `Could not resolve PR diff for YAML mapping: ${message}`, retryable: true };
}

// Re-export the bundle-target job record type for routes.ts (the binding-routed
// bundle helper constructs a job-like shape from the pack-store binding).
export type { PrWalkthroughJobRecord };

function routeError(status: number, message: string, extra?: Record<string, unknown>): Error & { status?: number; extra?: Record<string, unknown> } {
	const error = new Error(message) as Error & { status?: number; extra?: Record<string, unknown> };
	error.status = status;
	error.extra = extra;
	return error;
}

function parseGithubPrUrl(input: string): { owner: string; repo: string; number: number; host: string } | undefined {
	try {
		const url = new URL(input);
		const host = url.hostname.replace(/\.$/, "").toLowerCase();
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts.length >= 4 && parts[2] === "pull") {
			const number = Number(parts[3]);
			if (Number.isInteger(number) && number > 0) return { owner: parts[0], repo: parts[1], number, host };
		}
	} catch { /* not a URL */ }
	return undefined;
}

function normalizeGithubHost(host: string | undefined): string {
	const normalized = (host ?? "github.com").replace(/\.$/, "").toLowerCase();
	return normalized === "www.github.com" ? "github.com" : normalized;
}

function numberValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function shortSha(value: string): string {
	return value.length > 7 ? value.slice(0, 7) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
