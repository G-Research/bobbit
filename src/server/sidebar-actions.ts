export type GoalGithubLinkResponse =
	| { available: true; url: string; kind: "pr" | "branch" }
	| { available: false; reason: "no-branch" | "no-github-remote" | "goal-not-found" | "no-worktree"; message?: string };

export function parseGithubRemoteUrl(remoteUrl: string): { host: string; owner: string; repo: string } | null {
	const raw = remoteUrl.trim();
	if (!raw) return null;

	const fromParts = (host: string, owner: string, repo: string): { host: string; owner: string; repo: string } | null => {
		const normalizedHost = host.trim().toLowerCase();
		if (!isGithubHost(normalizedHost)) return null;
		const normalizedOwner = owner.trim();
		const normalizedRepo = repo.trim().replace(/\.git$/i, "");
		if (!isSafeGithubPathSegment(normalizedOwner) || !isSafeGithubPathSegment(normalizedRepo)) return null;
		return { host: normalizedHost, owner: normalizedOwner, repo: normalizedRepo };
	};

	try {
		const parsed = new URL(raw);
		if (parsed.protocol === "https:" || parsed.protocol === "http:" || parsed.protocol === "ssh:") {
			const segments = parsed.pathname.split("/").filter(Boolean);
			if (segments.length >= 2) return fromParts(parsed.hostname, segments[0], segments[1]);
		}
	} catch {
		// SSH scp-style remotes are handled below.
	}

	const scpLike = raw.match(/^(?:[^@\s]+@)?([^:\s/]+):([^\s/]+)\/([^\s/]+)$/);
	if (scpLike) return fromParts(scpLike[1], scpLike[2], scpLike[3]);

	return null;
}

export function buildGithubBranchUrl(remoteUrl: string, branch: string): string | null {
	const parsed = parseGithubRemoteUrl(remoteUrl);
	if (!parsed || !branch.trim()) return null;
	return `https://${parsed.host}/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/tree/${encodeURIComponent(branch)}`;
}

type GoalLinkGoal = {
	id: string;
	projectId?: string;
	branch?: string;
	cwd: string;
	repoPath?: string;
	worktreePath?: string;
};

type PrLinkStatus = { url?: string };

export type GoalGithubLinkDependencies<TGoal extends GoalLinkGoal = GoalLinkGoal, TPr extends PrLinkStatus = PrLinkStatus> = {
	getGoal(goalId: string): TGoal | undefined;
	hasGitWorktree(goal: TGoal): boolean;
	noWorktreeMessage(goal: TGoal): string;
	getCachedPr(goalId: string): TPr | undefined;
	getFreshPr(cwd: string, branch: string): Promise<TPr | null | undefined>;
	setCachedPr(goalId: string, pr: TPr): void;
	pathExists(path: string): boolean;
	getOriginRemote(cwd: string): Promise<string>;
};

/** Route-independent GitHub-link decision core. All filesystem, cache, PR and
 * Git boundaries are injected so callers can scope them to one request. */
export async function resolveGoalGithubLink<TGoal extends GoalLinkGoal, TPr extends PrLinkStatus>(
	goalId: string,
	deps: GoalGithubLinkDependencies<TGoal, TPr>,
): Promise<GoalGithubLinkResponse> {
	const goal = deps.getGoal(goalId);
	if (!goal) return { available: false, reason: "goal-not-found" };
	if (!deps.hasGitWorktree(goal)) {
		return { available: false, reason: "no-worktree", message: deps.noWorktreeMessage(goal) };
	}

	const cached = deps.getCachedPr(goalId);
	if (cached?.url) return { available: true, kind: "pr", url: cached.url };

	if (goal.branch && deps.pathExists(goal.cwd)) {
		const fresh = await deps.getFreshPr(goal.cwd, goal.branch).catch(() => null);
		if (fresh?.url) {
			deps.setCachedPr(goalId, fresh);
			return { available: true, kind: "pr", url: fresh.url };
		}
	}

	if (!goal.branch) return { available: false, reason: "no-branch" };
	try {
		const branchUrl = buildGithubBranchUrl(await deps.getOriginRemote(goal.repoPath || goal.cwd), goal.branch);
		return branchUrl
			? { available: true, kind: "branch", url: branchUrl }
			: { available: false, reason: "no-github-remote" };
	} catch {
		return { available: false, reason: "no-github-remote" };
	}
}

type ForkSource = { cwd?: string; title?: string };

type PersistedForkSource = {
	cwd?: string;
	worktreePath?: string;
	title?: string;
	goalId?: string;
	assistantType?: string;
};

export type SidebarForkLaunchContext = {
	forkId: string;
	projectId: string;
	projectRoot: string;
	destJsonl: string;
	oldTranscriptCwds: string[];
	worktreeOpts?: { repoPath: string };
};

export type SidebarForkLaunchDependencies<TFork extends { id: string; cwd: string; status: string }> = {
	resolveNewWorktreeRepoPath(projectRoot: string): Promise<string | undefined>;
	buildCreateOptions(context: SidebarForkLaunchContext): Record<string, unknown>;
	createSession(input: {
		cwd: string;
		goalId?: string;
		assistantType?: string;
		options: Record<string, unknown>;
	}): Promise<TFork>;
	setTitle(sessionId: string, title: string): void;
};

/** Production fork launch core. Transcript cloning happens before this boundary;
 * this function owns worktree selection, stale-cwd propagation, creation and title. */
export async function launchSidebarSessionFork<TFork extends { id: string; cwd: string; status: string }>(input: {
	forkId: string;
	projectId: string;
	projectRoot: string;
	destJsonl: string;
	newWorktree: boolean;
	source: ForkSource;
	persisted: PersistedForkSource;
}, deps: SidebarForkLaunchDependencies<TFork>): Promise<{
	fork: TFork;
	title: string;
	projectId: string;
	goalId?: string;
}> {
	let sessionCwd: string;
	let worktreeOpts: { repoPath: string } | undefined;
	if (input.newWorktree) {
		sessionCwd = input.projectRoot;
		const repoPath = await deps.resolveNewWorktreeRepoPath(input.projectRoot);
		if (repoPath) worktreeOpts = { repoPath };
	} else {
		sessionCwd = input.persisted.worktreePath || input.persisted.cwd || input.projectRoot;
	}

	const oldTranscriptCwds = Array.from(new Set([
		input.persisted.cwd,
		input.persisted.worktreePath,
		input.source.cwd,
	].filter((value): value is string => typeof value === "string" && value.length > 0)));
	const context: SidebarForkLaunchContext = {
		forkId: input.forkId,
		projectId: input.projectId,
		projectRoot: input.projectRoot,
		destJsonl: input.destJsonl,
		oldTranscriptCwds,
		worktreeOpts,
	};
	const fork = await deps.createSession({
		cwd: sessionCwd,
		goalId: input.persisted.goalId,
		assistantType: input.persisted.assistantType,
		options: deps.buildCreateOptions(context),
	});
	const baseTitle = (input.persisted.title || input.source.title || "session").trim() || "session";
	const title = `Fork: ${baseTitle}`;
	deps.setTitle(fork.id, title);
	return { fork, title, projectId: input.projectId, goalId: input.persisted.goalId };
}

function isGithubHost(host: string): boolean {
	return host === "github.com" || host.endsWith(".github.com");
}

function isSafeGithubPathSegment(segment: string): boolean {
	return /^[A-Za-z0-9_.-]+$/.test(segment) && segment !== "." && segment !== "..";
}
