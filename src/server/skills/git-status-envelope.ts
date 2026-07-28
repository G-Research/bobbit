export interface GitStatusResult {
	branch: string;
	primaryBranch: string;
	isOnPrimary: boolean;
	primaryRef: string;
	status: { file: string; status: string }[];
	hasUpstream: boolean;
	ahead: number;
	behind: number;
	aheadOfPrimary: number;
	behindPrimary: number;
	mergedIntoPrimary: boolean;
	insertionsVsPrimary: number;
	deletionsVsPrimary: number;
	clean: boolean;
	summary: string;
	unpushed: boolean;
	partial?: boolean;
	untrackedIncluded?: boolean;
}

export type GitStatusProbe =
	| { kind: "success"; result: GitStatusResult }
	| { kind: "not-repository"; diagnostic?: string }
	| { kind: "error"; error: Error; diagnostic: string };

export interface GitStatusTarget {
	repo: string;
	worktreePath: string;
}

export interface GitStatusEnvelope extends GitStatusResult {
	aggregate: GitStatusResult;
	repos: Record<string, GitStatusResult>;
}

export type GitStatusCollection =
	| { kind: "success"; envelope: GitStatusEnvelope }
	| { kind: "not-repository"; diagnostic?: string }
	| { kind: "error"; error: Error; diagnostic: string };

export interface CollectGitStatusOptions {
	rootPath: string;
	components?: readonly GitStatusTarget[];
	probe(path: string): Promise<GitStatusProbe>;
	/** Host-only existence check. Omit for container paths. */
	pathExists?: (path: string) => boolean;
	/** Best-effort pre-probe operation used by `?fetch=true`. */
	fetchTarget?: (path: string) => Promise<unknown>;
	/** Called after every requested fetch, including failed/skipped fetches. */
	invalidateTarget?: (path: string) => void;
}

function probeError(message: string, cause?: unknown): GitStatusProbe {
	const error = cause instanceof Error ? cause : new Error(message);
	return { kind: "error", error, diagnostic: message || error.message };
}

/** Root plus configured components, deduplicated by worktree path for side effects. */
export function collectGitStatusTargets(rootPath: string, components: readonly GitStatusTarget[] = []): string[] {
	const targets: string[] = [];
	const seen = new Set<string>();
	for (const worktreePath of [rootPath, ...components.map((component) => component.worktreePath)]) {
		if (typeof worktreePath !== "string" || seen.has(worktreePath)) continue;
		seen.add(worktreePath);
		targets.push(worktreePath);
	}
	return targets;
}

function sum(results: readonly GitStatusResult[], pick: (result: GitStatusResult) => number): number {
	return results.reduce((total, result) => total + (Number.isFinite(pick(result)) ? pick(result) : 0), 0);
}

/**
 * Synthesize the shared goal/session response policy from already-classified
 * probes. Configured components are authoritative whenever any succeeds; the
 * root is only a fallback. A sole `.` component retains the flat single-repo
 * response shape.
 */
export function aggregateGitStatusProbes(
	root: GitStatusProbe,
	components: readonly { target: GitStatusTarget; probe: GitStatusProbe }[] = [],
): GitStatusCollection {
	const successfulComponents = components.filter(
		(entry): entry is { target: GitStatusTarget; probe: Extract<GitStatusProbe, { kind: "success" }> } => entry.probe.kind === "success",
	);

	if (successfulComponents.length > 0) {
		const repos = Object.fromEntries(successfulComponents.map(({ target, probe }) => [target.repo, probe.result]));
		if (components.length === 1 && successfulComponents[0].target.repo === ".") {
			const result = successfulComponents[0].probe.result;
			return { kind: "success", envelope: { ...result, aggregate: result, repos } };
		}

		const results = successfulComponents.map(({ probe }) => probe.result);
		const base = results[0];
		const partial = components.some(({ probe }) => probe.kind !== "success")
			|| results.some((result) => result.partial === true);
		const aggregate: GitStatusResult = {
			branch: base.branch,
			primaryBranch: base.primaryBranch,
			primaryRef: base.primaryRef,
			isOnPrimary: base.isOnPrimary,
			hasUpstream: base.hasUpstream,
			mergedIntoPrimary: !partial && results.every((result) => result.mergedIntoPrimary),
			status: [],
			ahead: sum(results, (result) => result.ahead),
			behind: sum(results, (result) => result.behind),
			aheadOfPrimary: sum(results, (result) => result.aheadOfPrimary),
			behindPrimary: sum(results, (result) => result.behindPrimary),
			insertionsVsPrimary: sum(results, (result) => result.insertionsVsPrimary),
			deletionsVsPrimary: sum(results, (result) => result.deletionsVsPrimary),
			clean: results.every((result) => result.clean),
			unpushed: results.some((result) => result.unpushed),
			summary: `${results.length} ${results.length === 1 ? "repo" : "repos"}`,
			partial,
			untrackedIncluded: components.every(({ probe }) => probe.kind === "success")
				&& results.every((result) => result.untrackedIncluded === true),
		};
		return { kind: "success", envelope: { ...aggregate, aggregate, repos } };
	}

	if (root.kind === "success") {
		const result = components.length === 0
			? root.result
			: { ...root.result, partial: true, untrackedIncluded: false };
		return {
			kind: "success",
			envelope: { ...result, aggregate: result, repos: { ".": root.result } },
		};
	}

	const attempted = [root, ...components.map(({ probe }) => probe)];
	if (attempted.length > 0 && attempted.every((probe) => probe.kind === "not-repository")) {
		return {
			kind: "not-repository",
			diagnostic: attempted.find((probe) => probe.kind === "not-repository" && probe.diagnostic)?.diagnostic,
		};
	}

	const failure = attempted.find((probe): probe is Extract<GitStatusProbe, { kind: "error" }> => probe.kind === "error");
	return failure
		? { kind: "error", error: failure.error, diagnostic: failure.diagnostic }
		: { kind: "error", error: new Error("git status failed"), diagnostic: "git status failed" };
}

/** Collect, classify, and aggregate one root plus zero or more components. */
export async function collectGitStatusEnvelope(options: CollectGitStatusOptions): Promise<GitStatusCollection> {
	const components = options.components ?? [];
	const paths = collectGitStatusTargets(options.rootPath, components);

	if (options.fetchTarget) {
		await Promise.all(paths.map(async (worktreePath) => {
			try {
				if (!options.pathExists || options.pathExists(worktreePath)) {
					await options.fetchTarget!(worktreePath);
				}
			} catch {
				// Fetch is deliberately best-effort; status classification follows.
			} finally {
				options.invalidateTarget?.(worktreePath);
			}
		}));
	}

	const probes = new Map<string, Promise<GitStatusProbe>>();
	const probePath = (worktreePath: string): Promise<GitStatusProbe> => {
		const existing = probes.get(worktreePath);
		if (existing) return existing;
		const pending = (async () => {
			if (!worktreePath) return probeError("Configured Git worktree path is missing");
			try {
				if (options.pathExists && !options.pathExists(worktreePath)) {
					return probeError(`Git worktree path not found: ${worktreePath}`);
				}
				return await options.probe(worktreePath);
			} catch (cause) {
				const message = cause instanceof Error ? cause.message : String(cause);
				return probeError(message || "git status failed", cause);
			}
		})();
		probes.set(worktreePath, pending);
		return pending;
	};

	const [root, componentProbes] = await Promise.all([
		probePath(options.rootPath),
		Promise.all(components.map(async (target) => ({ target, probe: await probePath(target.worktreePath) }))),
	]);
	return aggregateGitStatusProbes(root, componentProbes);
}
