import type { Locator, Page, Route } from "@playwright/test";
import {
  createGoal,
  createSession,
  deleteGoal,
  deleteSession,
  expect,
  navigateToHash,
  openApp,
  test,
  waitForSessionStatus,
} from "../_helpers/journey-fixture.js";

type StatusFile = { file: string; status: string };
type RepoStatus = ReturnType<typeof repoStatus>;

function repoStatus(
  status: StatusFile[],
  overrides: Partial<{
    ahead: number;
    behind: number;
    aheadOfPrimary: number;
    behindPrimary: number;
    insertionsVsPrimary: number;
    deletionsVsPrimary: number;
  }> = {},
) {
  return {
    branch: "goal/polyrepo-widget",
    primaryBranch: "master",
    primaryRef: "origin/master",
    isOnPrimary: false,
    clean: status.length === 0,
    hasUpstream: true,
    ahead: 0,
    behind: 0,
    aheadOfPrimary: 0,
    behindPrimary: 0,
    insertionsVsPrimary: 0,
    deletionsVsPrimary: 0,
    mergedIntoPrimary: false,
    unpushed: false,
    partial: false,
    status,
    summary: status.length > 0 ? `${status.length} changed` : "",
    ...overrides,
  };
}

/** Successful component-only shape returned when the container root is not Git. */
function componentEnvelope(repos: Record<string, RepoStatus>) {
  const entries = Object.values(repos);
  if (entries.length === 0)
    throw new Error("component envelope needs at least one repository");
  const identity = entries[0];
  const status = entries.flatMap((repo) => repo.status);
  const aggregate = {
    ...identity,
    clean: entries.every((repo) => repo.clean),
    ahead: entries.reduce((sum, repo) => sum + repo.ahead, 0),
    behind: entries.reduce((sum, repo) => sum + repo.behind, 0),
    aheadOfPrimary: entries.reduce((sum, repo) => sum + repo.aheadOfPrimary, 0),
    behindPrimary: entries.reduce((sum, repo) => sum + repo.behindPrimary, 0),
    insertionsVsPrimary: entries.reduce(
      (sum, repo) => sum + repo.insertionsVsPrimary,
      0,
    ),
    deletionsVsPrimary: entries.reduce(
      (sum, repo) => sum + repo.deletionsVsPrimary,
      0,
    ),
    unpushed: entries.some((repo) => repo.unpushed),
    partial: entries.some((repo) => repo.partial),
    status,
    summary:
      status.length > 0 ? `${status.length} changed across components` : "",
  };
  return { ...aggregate, aggregate, repos };
}

async function installGitStatusRoute(
  page: Page,
  apiPath: string,
  body: ReturnType<typeof componentEnvelope>,
): Promise<string[]> {
  const requests: string[] = [];
  await page.route(
    new RegExp(`${apiPath}(?:\\?.*)?$`),
    async (route: Route) => {
      if (route.request().method() !== "GET") return route.fallback();
      requests.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    },
  );
  return requests;
}

async function expectNamedRepoSections(
  page: Page,
  widget: Locator,
  expectedNames: string[],
): Promise<void> {
  await expect(widget, "Git status widget should remain visible").toBeVisible({
    timeout: 20_000,
  });
  const pill = widget.locator("button[data-state='ready']").first();
  await expect(pill).toBeVisible({ timeout: 20_000 });
  await pill.click();

  const dropdown = page.locator("#git-status-dropdown");
  await expect(dropdown).toBeVisible({ timeout: 5_000 });
  const sections = dropdown.locator('[data-testid="multi-repo-entry"]');
  await expect(sections).toHaveCount(expectedNames.length);
  await expect(sections.locator('[data-testid="repo-name"]')).toHaveText(
    expectedNames,
  );
  for (const name of expectedNames) {
    await expect(dropdown.locator(`[data-repo-name="${name}"]`)).toBeVisible();
  }
}

async function expectExplicitFetch(
  requests: string[],
  surface: string,
): Promise<void> {
  await expect
    .poll(
      () =>
        requests.some(
          (request) => new URL(request).searchParams.get("fetch") === "true",
        ),
      {
        timeout: 5_000,
        message: `${surface} Git widget should explicitly request fetch=true`,
      },
    )
    .toBe(true);
}

test.describe("Journey: Polyrepo Git status widgets", () => {
  test("session widget keeps multiple named component sections through reload", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const sessionId = await createSession();
    await waitForSessionStatus(sessionId, "idle");
    const repos = {
      "number-lib": repoStatus([{ file: "src/add.ts", status: "M" }], {
        ahead: 1,
        aheadOfPrimary: 1,
        insertionsVsPrimary: 8,
      }),
      "string-lib": repoStatus([]),
      "hello-cli": repoStatus([{ file: "src/index.ts", status: "A" }], {
        ahead: 2,
        aheadOfPrimary: 2,
        insertionsVsPrimary: 12,
      }),
    };
    const requests = await installGitStatusRoute(
      page,
      `/api/sessions/${sessionId}/git-status`,
      componentEnvelope(repos),
    );
    const names = Object.keys(repos);

    try {
      await openApp(page);
      await navigateToHash(page, `#/session/${sessionId}`);
      await expect(page.locator("message-editor textarea").first()).toBeVisible(
        { timeout: 20_000 },
      );

      const sessionWidget = page
        .locator("pi-chat-panel git-status-widget")
        .first();
      await expectNamedRepoSections(page, sessionWidget, names);
      await expectExplicitFetch(requests, "session");

      const requestCountBeforeReload = requests.length;
      await page.reload();
      await expect(page.locator("message-editor textarea").first()).toBeVisible(
        { timeout: 20_000 },
      );
      await expect
        .poll(() => requests.length, {
          timeout: 20_000,
          message: "session reload should refetch component Git status",
        })
        .toBeGreaterThan(requestCountBeforeReload);
      await expectNamedRepoSections(
        page,
        page.locator("pi-chat-panel git-status-widget").first(),
        names,
      );
    } finally {
      await deleteSession(sessionId);
    }
  });

  test("goal dashboard treats a sole named component as a repository section after reload", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const goal = await createGoal({
      title: `polyrepo-one-component-widget-${Date.now()}`,
      team: false,
      worktree: false,
    });
    const goalId = goal.id as string;
    const repos = {
      "number-lib": repoStatus([{ file: "src/multiply.ts", status: "M" }], {
        ahead: 1,
        aheadOfPrimary: 1,
        insertionsVsPrimary: 5,
        deletionsVsPrimary: 1,
      }),
    };
    const requests = await installGitStatusRoute(
      page,
      `/api/goals/${goalId}/git-status`,
      componentEnvelope(repos),
    );

    try {
      await openApp(page);
      await navigateToHash(page, `#/goal/${goalId}`);
      await expect(
        page
          .locator(".dashboard-container, .goal-dashboard, goal-dashboard")
          .first(),
      ).toBeVisible({ timeout: 20_000 });

      const dashboardWidget = page
        .locator(".dashboard-git-row git-status-widget")
        .first();
      await expectNamedRepoSections(page, dashboardWidget, ["number-lib"]);
      await expectExplicitFetch(requests, "goal dashboard");

      const requestCountBeforeReload = requests.length;
      await page.reload();
      await expect(
        page
          .locator(".dashboard-container, .goal-dashboard, goal-dashboard")
          .first(),
      ).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(() => requests.length, {
          timeout: 20_000,
          message: "goal reload should refetch component Git status",
        })
        .toBeGreaterThan(requestCountBeforeReload);
      await expectNamedRepoSections(
        page,
        page.locator(".dashboard-git-row git-status-widget").first(),
        ["number-lib"],
      );
    } finally {
      await deleteGoal(goalId, true);
    }
  });
});
