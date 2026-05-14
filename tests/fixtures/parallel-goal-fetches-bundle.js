"use strict";
(() => {
  // src/app/goal-dashboard-fetches.ts
  async function runDashboardFetchBundle(fetchers, parallel) {
    if (parallel) {
      const [goal2, tasks2, commits2, gates2, gitStatus2, cost2, prStatus2, team2] = await Promise.all([
        fetchers.fetchGoal(),
        fetchers.fetchTasks(),
        fetchers.fetchCommits().catch(() => null),
        fetchers.fetchGates(),
        fetchers.fetchGitStatus().catch(() => null),
        fetchers.fetchCost().catch(() => null),
        fetchers.fetchPrStatus().catch(() => null),
        fetchers.fetchTeam().catch(() => null)
      ]);
      return { goal: goal2, tasks: tasks2, commits: commits2, gates: gates2, gitStatus: gitStatus2, cost: cost2, prStatus: prStatus2, team: team2 };
    }
    const [goal, tasks, commits, gates, gitStatus, cost, prStatus] = await Promise.all([
      fetchers.fetchGoal(),
      fetchers.fetchTasks(),
      fetchers.fetchCommits().catch(() => null),
      fetchers.fetchGates(),
      fetchers.fetchGitStatus().catch(() => null),
      fetchers.fetchCost().catch(() => null),
      fetchers.fetchPrStatus().catch(() => null)
    ]);
    const team = await fetchers.fetchTeam().catch(() => null);
    return { goal, tasks, commits, gates, gitStatus, cost, prStatus, team };
  }

  // tests/fixtures/parallel-goal-fetches-entry.ts
  window.__runDashboardFetchBundle = runDashboardFetchBundle;
  window.__ready = true;
})();
