// ============================================================================
// GOAL DASHBOARD FETCH BUNDLE — Phase 2 Opt-D
//
// The goal dashboard fires eight independent network calls on load:
// goal, tasks, commits, gates, git-status, cost, pr-status, team-state.
//
// Pre-Opt-D, seven of those ran in a single `Promise.all` and the eighth
// (`getTeamState`) was awaited sequentially afterwards — a 1-RTT wart that
// dominated the `nav.goal.cold` span (see docs/perf/sidebar-nav-baseline.md
// §5.5 / §5.6). This helper unifies the bundle:
//
//   • when `parallel = true` (perf flag `parallelGoalFetches`),  all eight
//     fetches fire concurrently;
//   • when `parallel = false`, the legacy seven-parallel-then-team ordering
//     is preserved byte-for-byte.
//
// Pure / dependency-free so it can be unit-tested in isolation without
// pulling in goal-dashboard's lit / UI imports. Each fetcher's failures are
// captured per-call so one network blip never aborts the bundle.
// ============================================================================

export interface DashboardFetchers<TGoal, TTasks, TCommits, TGates, TGitStatus, TCost, TPrStatus, TTeam> {
	fetchGoal: () => Promise<TGoal>;
	fetchTasks: () => Promise<TTasks>;
	fetchCommits: () => Promise<TCommits | null>;
	fetchGates: () => Promise<TGates>;
	fetchGitStatus: () => Promise<TGitStatus | null>;
	fetchCost: () => Promise<TCost | null>;
	fetchPrStatus: () => Promise<TPrStatus | null>;
	fetchTeam: () => Promise<TTeam | null>;
}

export interface DashboardFetchResults<TGoal, TTasks, TCommits, TGates, TGitStatus, TCost, TPrStatus, TTeam> {
	goal: TGoal;
	tasks: TTasks;
	commits: TCommits | null;
	gates: TGates;
	gitStatus: TGitStatus | null;
	cost: TCost | null;
	prStatus: TPrStatus | null;
	team: TTeam | null;
}

/**
 * Run the dashboard's eight independent fetches. Failures of the optional
 * fetches (commits / gitStatus / cost / prStatus / team) are caught here and
 * surface as `null`. The required fetches (goal / tasks / gates) propagate
 * their rejection — the caller is expected to wrap in try/catch and surface
 * an error UI.
 *
 * @param parallel  when true, all eight fetches fire concurrently in a single
 *                  `Promise.all`. When false, the legacy ordering is preserved:
 *                  the seven non-team fetches run in `Promise.all`, then
 *                  `fetchTeam` is awaited sequentially. Behaviour gate is the
 *                  `parallelGoalFetches` perf flag.
 */
export async function runDashboardFetchBundle<TGoal, TTasks, TCommits, TGates, TGitStatus, TCost, TPrStatus, TTeam>(
	fetchers: DashboardFetchers<TGoal, TTasks, TCommits, TGates, TGitStatus, TCost, TPrStatus, TTeam>,
	parallel: boolean,
): Promise<DashboardFetchResults<TGoal, TTasks, TCommits, TGates, TGitStatus, TCost, TPrStatus, TTeam>> {
	if (parallel) {
		const [goal, tasks, commits, gates, gitStatus, cost, prStatus, team] = await Promise.all([
			fetchers.fetchGoal(),
			fetchers.fetchTasks(),
			fetchers.fetchCommits().catch(() => null),
			fetchers.fetchGates(),
			fetchers.fetchGitStatus().catch(() => null),
			fetchers.fetchCost().catch(() => null),
			fetchers.fetchPrStatus().catch(() => null),
			fetchers.fetchTeam().catch(() => null),
		]);
		return { goal, tasks, commits, gates, gitStatus, cost, prStatus, team };
	}

	const [goal, tasks, commits, gates, gitStatus, cost, prStatus] = await Promise.all([
		fetchers.fetchGoal(),
		fetchers.fetchTasks(),
		fetchers.fetchCommits().catch(() => null),
		fetchers.fetchGates(),
		fetchers.fetchGitStatus().catch(() => null),
		fetchers.fetchCost().catch(() => null),
		fetchers.fetchPrStatus().catch(() => null),
	]);
	const team = await fetchers.fetchTeam().catch(() => null);
	return { goal, tasks, commits, gates, gitStatus, cost, prStatus, team };
}
