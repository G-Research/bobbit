import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Locator, Page } from "@playwright/test";
import {
	apiFetch,
	createGoal,
	createSession,
	deleteGoal,
	deleteSession,
	expect,
	navigateToHash,
	openApp,
	registerProject,
	test,
	waitForSessionStatus,
} from "../_helpers/journey-fixture.js";

interface RemoteFixture {
	root: string;
	repo: string;
	peer: string;
	projectId: string;
}

type SnapshotMeta = {
	observedAt: number;
	refreshedAt: number | null;
	stale: boolean;
	lastError?: { code: string };
};

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "pipe" });
}

async function createRemoteFixture(label: string): Promise<RemoteFixture> {
	const root = mkdtempSync(join(tmpdir(), `bobbit-remote-state-${label}-`));
	const origin = join(root, "origin.git");
	const repo = join(root, "repo");
	const peer = join(root, "peer");
	git(root, "init", "--bare", "--initial-branch=master", origin);
	git(root, "clone", origin, repo);
	git(repo, "config", "user.name", "Remote State Browser Test");
	git(repo, "config", "user.email", "remote-state-browser@example.test");
	writeFileSync(join(repo, "README.md"), "initial\n");
	git(repo, "add", "README.md");
	git(repo, "commit", "-m", "initial remote-state fixture");
	git(repo, "push", "-u", "origin", "master");
	git(root, "clone", origin, peer);
	// Keep the remote I/O entirely local while making the repository a GitHub
	// identity. The fake `gh` response below can therefore exercise the PR
	// fast-state path without credentials or a real GitHub request.
	git(repo, "remote", "set-url", "origin", "https://github.com/bobbit-fixture/remote-state.git");
	git(repo, "config", `url.${pathToFileURL(origin).href}.insteadOf`, "https://github.com/bobbit-fixture/remote-state.git");
	git(peer, "config", "user.name", "Remote State Peer");
	git(peer, "config", "user.email", "remote-state-peer@example.test");
	const project = await registerProject({
		name: `remote-state-${label}-${Date.now()}`,
		rootPath: repo,
	});
	return { root, repo, peer, projectId: project.id };
}

function advanceRemote(peer: string): void {
	writeFileSync(join(peer, "REMOTE_CHANGE.md"), `remote update ${Date.now()}\n`);
	git(peer, "add", "REMOTE_CHANGE.md");
	git(peer, "commit", "-m", "remote change");
	git(peer, "push", "origin", "master");
}

async function removeFixture(fixture: RemoteFixture | undefined): Promise<void> {
	if (!fixture) return;
	await apiFetch(`/api/projects/${fixture.projectId}`, { method: "DELETE" }).catch(() => {});
	rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3 });
}

function behind(widget: Locator): Promise<number> {
	return widget.evaluate((node: any) => node.behind);
}

function snapshotMeta(widget: Locator): Promise<SnapshotMeta | undefined> {
	return widget.evaluate((node: any) => node.remoteState);
}

async function expectCurrentSnapshot(widget: Locator): Promise<void> {
	await expect.poll(() => snapshotMeta(widget), {
		timeout: 20_000,
		message: "authoritative snapshot metadata should reach the widget",
	}).toMatchObject({
		observedAt: expect.any(Number),
		refreshedAt: expect.any(Number),
		stale: false,
	});
}

/**
 * A local bare remote makes the external Git call observable without relying
 * on GitHub. The two browser pages deliberately share the same checkout: the
 * coordinator must key that remote work by canonical repository identity, not
 * by the session or dashboard surface requesting it.
 */
test.describe("Journey: remote-state coordinator", () => {
	test("shares automatic refs across dashboard, sidebar, and a second session client, then broadcasts a closed-widget update", async ({ page, context, gateway }) => {
		test.setTimeout(60_000);
		let fixture: RemoteFixture | undefined;
		let goalId = "";
		let sessionId = "";
		let sessionPage: Page | undefined;
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		let fetches = 0;
		let prReads = 0;
		let failFetches = false;
		let failPrReads = false;

		try {
			fixture = await createRemoteFixture("fanout");
			goalId = (await createGoal({
				title: `remote-state fanout ${Date.now()}`,
				cwd: fixture.repo,
				projectId: fixture.projectId,
				worktree: false,
				team: false,
			})).id;
			// This journey owns remote coordination, not worktree provisioning. Seed
			// the goal's already-created checkout so dashboard and sidebar consumers
			// address the same canonical repository as the active session.
			gateway.sessionManager.getGoalStoreForProject(fixture.projectId).update(goalId, {
				branch: "master",
				cwd: fixture.repo,
				repoPath: fixture.repo,
				worktreePath: fixture.repo,
				setupStatus: "ready",
			});
			sessionId = await createSession({ cwd: fixture.repo, goalId, projectId: fixture.projectId });
			await waitForSessionStatus(sessionId, "idle");

			runner.execFile = async (file: string, args: readonly string[], options?: { cwd?: string }) => {
				if (file === "git" && args.join(" ") === "fetch --quiet origin" && options?.cwd === fixture!.repo) {
					fetches++;
					if (failFetches) throw Object.assign(new Error("fixture remote offline"), { code: "ENETUNREACH" });
				}
				if (file === "gh" && args[0] === "pr" && args[1] === "view" && options?.cwd === fixture!.repo) {
					prReads++;
					if (failPrReads) throw Object.assign(new Error("fixture PR remote offline"), { code: "ENETUNREACH" });
					return { stdout: JSON.stringify({ number: 77, url: "https://github.com/bobbit-fixture/remote-state/pull/77", title: "Fixture remote state", state: "OPEN", mergeable: "MERGEABLE", headRefName: "master" }), stderr: "" };
				}
				if (file === "gh" && args[0] === "api") {
					return { stdout: JSON.stringify({ data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } } }), stderr: "" };
				}
				return originalExecFile.call(runner, file, args, options);
			};

			await openApp(page);
			await navigateToHash(page, `#/goal/${goalId}`);
			const dashboardWidget = page.locator(".dashboard-git-row git-status-widget").first();
			await expect(dashboardWidget).toBeAttached({ timeout: 15_000 });
			await expect(page.locator(`[data-nav-id="goal:${goalId}"]`).first(), "the dashboard client also renders the goal in its sidebar").toBeVisible({ timeout: 15_000 });

			sessionPage = await context.newPage();
			await openApp(sessionPage);
			await navigateToHash(sessionPage, `#/session/${sessionId}`);
			const sessionWidget = sessionPage.locator("pi-chat-panel git-status-widget").first();
			await expect(sessionWidget).toBeAttached({ timeout: 15_000 });

			// Initial dashboard, sidebar, and session reads may all request a snapshot,
			// but they must join one canonical remote fetch.
			await expect.poll(() => fetches, {
				timeout: 20_000,
				message: "cross-surface automatic reads must share one canonical fetch",
			}).toBe(1);
			await expect.poll(() => behind(dashboardWidget), { timeout: 20_000 }).toBe(0);
			await expect.poll(() => behind(sessionWidget), { timeout: 20_000 }).toBe(0);
			await expectCurrentSnapshot(dashboardWidget);
			await expectCurrentSnapshot(sessionWidget);
			expect(prReads, "cross-surface GitHub PR reads must share one canonical fast-state lookup").toBe(1);

			// Returning to a visible tab asks the server for SWR state but cannot
			// multiply a fresh canonical read by the number of client surfaces.
			const fetchesBeforeVisibility = fetches;
			await Promise.all([
				page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))),
				sessionPage.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))),
			]);
			await expect.poll(() => fetches, { timeout: 5_000 }).toBe(fetchesBeforeVisibility);

			// PR failures retain the prior PR payload and its safe metadata reaches
			// the active session's Git widget through the coordinator broadcast.
			failPrReads = true;
			const failedPr = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`);
			expect(failedPr.status).toBe(200);
			expect(await failedPr.json()).toMatchObject({
				data: { number: 77 },
				stale: true,
				lastError: expect.any(String),
				observedAt: expect.any(Number),
				refreshedAt: expect.any(Number),
			});
			await expect.poll(() => sessionWidget.evaluate((node: any) => ({
				stale: node.remoteStale,
				lastError: node.remoteLastError,
				observedAt: node.remoteObservedAt,
				refreshedAt: node.remoteRefreshedAt,
			})), { timeout: 15_000 }).toMatchObject({
				stale: true,
				lastError: expect.any(String),
				observedAt: expect.anything(),
				refreshedAt: expect.anything(),
			});
			failPrReads = false;

			// Neither surface may need its Git dropdown opened to receive a remote
			// change. The next cadence refresh broadcasts one completed snapshot to
			// both open consumers while their dropdowns remain closed.
			advanceRemote(fixture.peer);
			await expect(page.locator("#git-status-dropdown")).toHaveCount(0);
			await expect(sessionPage.locator("#git-status-dropdown")).toHaveCount(0);
			await expect.poll(() => behind(dashboardWidget), {
				timeout: 35_000,
				message: "dashboard should receive the remote ref broadcast without opening Git status",
			}).toBe(1);
			await expect.poll(() => behind(sessionWidget), {
				timeout: 15_000,
				message: "session should receive the same remote ref broadcast",
			}).toBe(1);
			expect(fetches, "the remote mutation should add exactly one canonical refresh").toBe(2);
			await expectCurrentSnapshot(dashboardWidget);
			await expectCurrentSnapshot(sessionWidget);
			await expect(page.locator("#git-status-dropdown")).toHaveCount(0);
			await expect(sessionPage.locator("#git-status-dropdown")).toHaveCount(0);

			// A transient refresh failure preserves the last-good refs. The stale
			// metadata and explicit refresh affordance are visible on both surfaces;
			// concurrent user refreshes still share one forced canonical fetch.
			await dashboardWidget.locator("button[data-state='ready']").click({ force: true });
			await sessionWidget.locator("button[data-state='ready']").click({ force: true });
			const dashboardRefresh = page.locator("#git-status-dropdown [data-testid='remote-state-age'] button").getByRole("button", { name: "Refresh" });
			const sessionRefresh = sessionPage.locator("#git-status-dropdown [data-testid='remote-state-age'] button").getByRole("button", { name: "Refresh" });
			await expect(dashboardRefresh).toBeVisible({ timeout: 10_000 });
			await expect(sessionRefresh).toBeVisible({ timeout: 10_000 });
			const beforeFailure = fetches;
			failFetches = true;
			await Promise.all([dashboardRefresh.click(), sessionRefresh.click()]);
			await expect.poll(() => fetches, { timeout: 15_000 }).toBe(beforeFailure + 1);
			await expect.poll(() => snapshotMeta(dashboardWidget), { timeout: 15_000 }).toMatchObject({
				stale: true,
				lastError: { code: expect.any(String) },
			});
			await expect.poll(() => behind(dashboardWidget)).toBe(1);
			await expect.poll(() => behind(sessionWidget)).toBe(1);
			await expect(page.locator("#git-status-dropdown [data-testid='remote-state-age']")).toContainText("stale");
			await expect(sessionPage.locator("#git-status-dropdown [data-testid='remote-state-age']")).toContainText("stale");

			failFetches = false;
			const beforeRecovery = fetches;
			await Promise.all([dashboardRefresh.click(), sessionRefresh.click()]);
			await expect.poll(() => fetches, { timeout: 15_000 }).toBe(beforeRecovery + 1);
			await expectCurrentSnapshot(dashboardWidget);
			await expectCurrentSnapshot(sessionWidget);

			// Reloading consumers hydrates the same retained snapshot rather than
			// letting client count multiply equivalent remote work.
			const fetchesBeforeReload = fetches;
			await Promise.all([
				page.reload({ waitUntil: "domcontentloaded" }),
				sessionPage.reload({ waitUntil: "domcontentloaded" }),
			]);
			const reloadedDashboard = page.locator(".dashboard-git-row git-status-widget").first();
			const reloadedSession = sessionPage.locator("pi-chat-panel git-status-widget").first();
			await expect(reloadedDashboard).toBeAttached({ timeout: 20_000 });
			await expect(reloadedSession).toBeAttached({ timeout: 20_000 });
			await expect.poll(() => behind(reloadedDashboard), { timeout: 20_000 }).toBe(1);
			await expect.poll(() => behind(reloadedSession), { timeout: 20_000 }).toBe(1);
			expect(fetches, "reload joins the still-fresh canonical snapshot").toBe(fetchesBeforeReload);
		} finally {
			runner.execFile = originalExecFile;
			await page.goto("about:blank").catch(() => {});
			if (sessionPage) await sessionPage.close().catch(() => {});
			if (sessionId) await deleteSession(sessionId);
			if (goalId) await deleteGoal(goalId, true);
			await removeFixture(fixture);
		}
	});
});
