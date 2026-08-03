import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	projectId: string;
}

type SnapshotMeta = {
	observedAt?: number | string;
	stale: boolean;
};

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "pipe" });
}

async function createRemoteFixture(label: string): Promise<RemoteFixture> {
	const root = mkdtempSync(join(tmpdir(), `bobbit-remote-state-${label}-`));
	const origin = join(root, "origin.git");
	const repo = join(root, "repo");
	git(root, "init", "--bare", "--initial-branch=master", origin);
	git(root, "clone", origin, repo);
	git(repo, "config", "user.name", "Remote State Browser Test");
	git(repo, "config", "user.email", "remote-state-browser@example.test");
	writeFileSync(join(repo, "README.md"), "initial\n");
	git(repo, "add", "README.md");
	git(repo, "commit", "-m", "initial remote-state fixture");
	git(repo, "push", "-u", "origin", "master");
	const project = await registerProject({
		name: `remote-state-${label}-${Date.now()}`,
		rootPath: repo,
	});
	return { root, repo, projectId: project.id };
}

async function removeFixture(fixture: RemoteFixture | undefined): Promise<void> {
	if (!fixture) return;
	await apiFetch(`/api/projects/${fixture.projectId}`, { method: "DELETE" }).catch(() => {});
	rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3 });
}

function behind(widget: Locator): Promise<number> {
	return widget.evaluate((node: any) => node.behind);
}

function snapshotMeta(widget: Locator): Promise<SnapshotMeta> {
	return widget.evaluate((node: any) => ({
		observedAt: node.remoteObservedAt,
		stale: node.remoteStale,
	}));
}

async function expectPendingSnapshot(widget: Locator): Promise<void> {
	await expect.poll(() => snapshotMeta(widget), {
		timeout: 10_000,
		message: "the widget should immediately render a stale-while-revalidate snapshot",
	}).toMatchObject({
		observedAt: expect.any(Number),
		stale: true,
	});
}

/**
 * A local bare remote makes the external Git call observable without relying
 * on GitHub. The two browser pages deliberately share the same checkout: the
 * coordinator must key that remote work by canonical repository identity, not
 * by the session or dashboard surface requesting it.
 */
test.describe("Journey: remote-state coordinator", () => {
	test("coalesces dashboard and session stale-while-revalidate reads", async ({ page, context, gateway }) => {
		test.setTimeout(60_000);
		let fixture: RemoteFixture | undefined;
		let goalId = "";
		let sessionId = "";
		let sessionPage: Page | undefined;
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		let fetches = 0;
		let releaseInitialFetch: (() => void) | undefined;
		const initialFetch = new Promise<void>((resolve) => { releaseInitialFetch = resolve; });

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
				if (file === "git" && args.join(" ") === "fetch --quiet" && options?.cwd === fixture!.repo) {
					fetches++;
					await initialFetch;
					return { stdout: "", stderr: "" };
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

			// Keep the first local fetch in flight so dashboard, sidebar, and session
			// reads are all demonstrably coalesced before the coordinator completes it.
			await expect.poll(() => fetches, {
				timeout: 10_000,
				message: "cross-surface automatic reads must share one canonical fetch",
			}).toBe(1);
			await expect.poll(() => behind(dashboardWidget), { timeout: 10_000 }).toBe(0);
			await expect.poll(() => behind(sessionWidget), { timeout: 10_000 }).toBe(0);
			await expectPendingSnapshot(dashboardWidget);
			await expectPendingSnapshot(sessionWidget);

			// Visibility return is stale-while-revalidate: both clients join the same
			// in-flight operation rather than issuing a second remote command.
			await Promise.all([
				page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))),
				sessionPage.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))),
			]);
			await expect.poll(() => fetches, { timeout: 5_000 }).toBe(1);

			// Completion reaches both surfaces. Opening the dashboard dropdown then
			// requests visible/SWR data plus local untracked files, but a fresh record
			// must not force another external fetch.
			releaseInitialFetch?.();
			await expect.poll(() => snapshotMeta(dashboardWidget), { timeout: 10_000 }).toMatchObject({ stale: false });
			await expect.poll(() => snapshotMeta(sessionWidget), { timeout: 10_000 }).toMatchObject({ stale: false });
			await dashboardWidget.locator("button").first().click();
			await expect(page.locator("#git-status-dropdown")).toBeVisible();
			await page.waitForTimeout(250);
			await expect.poll(() => fetches, { timeout: 5_000 }).toBe(1);

			// The footer is deliberately explicit and resource-aware. Exercise the
			// real dashboard handlers: repository metadata forces one Git refresh;
			// failed PR metadata targets the PR route instead of silently fetching Git.
			await dashboardWidget.evaluate(async (node: any) => {
				node.remoteStale = true;
				node.remoteLastError = "unavailable";
				node.remoteSource = "repository";
				node.requestUpdate();
				await node.updateComplete;
			});
			await page.locator('#git-status-dropdown [data-testid="remote-state-status"] button', { hasText: "Refresh" }).click();
			await expect.poll(() => fetches, { timeout: 10_000 }).toBe(2);

			await dashboardWidget.evaluate(async (node: any) => {
				node.remoteStale = true;
				node.remoteLastError = "unavailable";
				node.remoteSource = "pr";
				node.requestUpdate();
				await node.updateComplete;
			});
			const explicitPrRequest = page.waitForRequest((request) =>
				request.url().includes(`/api/goals/${goalId}/pr-status`)
				&& request.url().includes("intent=explicit"),
			);
			await page.locator('#git-status-dropdown [data-testid="remote-state-status"] button', { hasText: "Refresh" }).click();
			await explicitPrRequest;
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
