import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

type SnapshotState = {
	stale?: boolean;
	observedAt?: number;
	refreshedAt?: number;
	ageMs?: number;
	lastError?: string;
	source?: string;
};

type WidgetState = {
	branch?: string;
	behind?: number;
	loading?: boolean;
	prState?: string;
	prNumber?: number;
	prTitle?: string;
	stale: boolean;
	observedAt?: number;
	refreshedAt?: number;
	ageMs?: number;
	lastError?: string;
	source?: string;
	gitSnapshot?: SnapshotState;
	prSnapshot?: SnapshotState;
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
	git(peer, "commit", "-m", "remote-only change");
	git(peer, "push", "origin", "master");
}

async function removeFixture(fixture: RemoteFixture | undefined): Promise<void> {
	if (!fixture) return;
	await apiFetch(`/api/projects/${fixture.projectId}`, { method: "DELETE" }).catch(() => {});
	try {
		rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	} catch {
		// Windows can retain a short-lived Git handle after the injected fetch is
		// released. The browser coordinator owns and removes this entire temp root.
	}
}

function widgetState(widget: Locator): Promise<WidgetState> {
	return widget.evaluate((node: any) => {
		// Preserve the journey's historical PR-oriented summary while also exposing
		// both independent records for resource-specific failure assertions.
		const selected = node.remotePrSnapshot ?? node.remoteGitSnapshot ?? {};
		return {
			branch: node.branch,
			behind: node.behind,
			loading: node.loading,
			prState: node.prState,
			prNumber: node.prNumber,
			prTitle: node.prTitle,
			stale: selected.stale ?? node.remoteStale,
			observedAt: selected.observedAt ?? node.remoteObservedAt,
			refreshedAt: selected.refreshedAt ?? node.remoteRefreshedAt,
			ageMs: selected.ageMs ?? node.remoteAgeMs,
			lastError: selected.lastError ?? node.remoteLastError,
			source: selected.source ?? node.remoteSource,
			gitSnapshot: node.remoteGitSnapshot,
			prSnapshot: node.remotePrSnapshot,
		};
	});
}

async function clientJson(page: Page, path: string): Promise<{ status: number; body: any }> {
	return page.evaluate(async (url) => {
		const response = await fetch(url);
		return { status: response.status, body: response.status === 204 ? null : await response.json() };
	}, path);
}

async function setVisible(page: Page): Promise<void> {
	await page.evaluate(() => {
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
		document.dispatchEvent(new Event("visibilitychange"));
	});
}

/**
 * The Git fixture uses a real local bare remote. Only the identity probe is
 * projected as GitHub, allowing the credential-free fake `gh` fixture to drive
 * the PR coordinator while every Git fetch remains local and observable.
 */
test.describe("Journey: remote-state coordinator", () => {
	test("keeps two clients and every active surface on one canonical Git and PR snapshot", async ({ page, context, gateway }) => {
		test.setTimeout(130_000);
		let fixture: RemoteFixture | undefined;
		let goalId = "";
		let sessionId = "";
		let sessionPage: Page | undefined;
		const runner = (gateway.sessionManager as any).commandRunner;
		const clock = (gateway.sessionManager as any).clock;
		const originalExecFile = runner.execFile;
		const originalNow = clock.now;
		let now = originalNow.call(clock);
		let gitFetches = 0;
		let prReads = 0;
		let failGitFetches = false;
		let failPrReads = false;
		let prTitle = "Coordinator fixture PR";
		let reviewDecision = "REVIEW_REQUIRED";
		let releaseGitFetch: (() => void) | undefined;
		let heldGitFetch: Promise<void> | undefined;
		let releasePrRead: (() => void) | undefined;
		let heldPrRead: Promise<void> | undefined;
		const gitStatusRequests: string[] = [];
		context.on("request", (request) => {
			const url = request.url();
			if (url.includes("/git-status")) gitStatusRequests.push(url);
		});

		const holdNextGitFetch = (): Promise<void> => {
			heldGitFetch = new Promise<void>((resolve) => { releaseGitFetch = resolve; });
			return heldGitFetch;
		};
		const holdNextPrRead = (): Promise<void> => {
			heldPrRead = new Promise<void>((resolve) => { releasePrRead = resolve; });
			return heldPrRead;
		};

		try {
			fixture = await createRemoteFixture("browser-proof");
			goalId = (await createGoal({
				title: `remote-state browser proof ${Date.now()}`,
				cwd: fixture.repo,
				projectId: fixture.projectId,
				worktree: false,
				team: false,
			})).id;
			gateway.sessionManager.getGoalStoreForProject(fixture.projectId).update(goalId, {
				branch: "master",
				cwd: fixture.repo,
				repoPath: fixture.repo,
				worktreePath: fixture.repo,
				setupStatus: "ready",
				team: false,
				autoStartTeam: false,
				workflowId: null,
				workflow: null,
			});
			sessionId = await createSession({ cwd: fixture.repo, goalId, projectId: fixture.projectId });
			await waitForSessionStatus(sessionId, "idle");

			clock.now = () => now;
			holdNextGitFetch();
			holdNextPrRead();
			runner.execFile = async (file: string, args: readonly string[], options?: { cwd?: string }) => {
				const command = basename(file).replace(/\.exe$/i, "").toLowerCase();
				const argv = args.join(" ");
				if (command === "git" && argv === "remote get-url origin" && options?.cwd === fixture!.repo) {
					return { stdout: "https://github.com/bobbit-fixtures/remote-state.git\n", stderr: "" };
				}
				if (command === "git" && argv === "fetch --quiet" && options?.cwd === fixture!.repo) {
					gitFetches++;
					if (heldGitFetch) await heldGitFetch;
					if (failGitFetches) {
						throw Object.assign(new Error("fixture-git-offline-private-detail"), {
							code: "ENETUNREACH",
							stderr: "url=https://secret@example.test/private-ref",
						});
					}
				}
				if (command === "gh" && args[0] === "pr" && args[1] === "view" && options?.cwd === fixture!.repo) {
					prReads++;
					if (heldPrRead) await heldPrRead;
					if (failPrReads) {
						throw Object.assign(new Error("fixture-offline-private-detail"), {
							code: "ENETUNREACH",
							stderr: "url=https://secret@example.test/private-ref",
						});
					}
					return {
						stdout: JSON.stringify({
							number: 42,
							url: "https://github.com/bobbit-fixtures/remote-state/pull/42",
							title: prTitle,
							state: "OPEN",
							mergeable: "MERGEABLE",
							headRefName: "master",
							baseRefName: "master",
							reviewDecision,
						}),
						stderr: "",
					};
				}
				if (command === "gh" && args[0] === "api") {
					return {
						stdout: JSON.stringify({
							data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } },
						}),
						stderr: "",
					};
				}
				return originalExecFile.call(runner, file, args, options);
			};

			await openApp(page);
			await navigateToHash(page, `#/goal/${goalId}`);
			const dashboardWidget = page.locator(".dashboard-git-row git-status-widget").first();
			await expect(dashboardWidget).toBeAttached({ timeout: 15_000 });

			sessionPage = await context.newPage();
			let coldSessionGitReads = 0;
			await sessionPage.route(`**/api/sessions/${sessionId}/git-status*`, async (route) => {
				if (coldSessionGitReads++ > 0) {
					await route.continue();
					return;
				}
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ observedAt: now, stale: true, source: "repository", ageMs: 0 }),
				});
			});
			await openApp(sessionPage);
			await navigateToHash(sessionPage, `#/session/${sessionId}`);
			const sessionWidget = sessionPage.locator("pi-chat-panel git-status-widget").first();
			await expect(sessionWidget).toBeAttached({ timeout: 15_000 });

			await expect.poll(() => gitFetches, { timeout: 10_000 }).toBe(1);
			await expect.poll(() => prReads, { timeout: 10_000 }).toBe(1);
			// The targeted session read observes a cold Git envelope while the
			// dashboard owns the in-flight canonical refresh. The client must not
			// classify that metadata-only envelope as an empty/hidden repository.
			expect(coldSessionGitReads).toBeGreaterThan(0);
			await expect.poll(() => widgetState(sessionWidget)).toMatchObject({
				branch: "",
				loading: true,
				gitSnapshot: { stale: true, source: "repository" },
			});

			heldGitFetch = undefined;
			releaseGitFetch?.();
			await expect.poll(() => widgetState(dashboardWidget), { timeout: 10_000 }).toMatchObject({ branch: "master", loading: false });
			await expect.poll(() => widgetState(sessionWidget), { timeout: 10_000 }).toMatchObject({ branch: "master", loading: false });

			heldPrRead = undefined;
			releasePrRead?.();
			await expect.poll(() => widgetState(dashboardWidget), { timeout: 10_000 }).toMatchObject({
				branch: "master",
				behind: 0,
				prState: "OPEN",
				prNumber: 42,
				prTitle,
				stale: false,
				lastError: undefined,
				source: "pr",
			});
			await expect.poll(() => widgetState(sessionWidget), { timeout: 10_000 }).toMatchObject({
				branch: "master",
				behind: 0,
				prState: "OPEN",
				prNumber: 42,
				prTitle,
				stale: false,
				lastError: undefined,
				source: "pr",
			});
			const dashboardGoalRow = page.locator(`[data-nav-id="goal:${goalId}"]`).first();
			const sessionGoalRow = sessionPage.locator(`[data-nav-id="goal:${goalId}"]`).first();
			await expect(dashboardGoalRow.locator('a[title^="PR #42 open"]')).toBeVisible();
			await expect(sessionGoalRow.locator('a[title^="PR #42 open"]')).toBeVisible();

			// The server clock is deterministic: active demand becomes eligible at 20s,
			// while sidebar-only demand stays on its independent 60s cadence.
			now += 19_999;
			await Promise.all([
				clientJson(page, `/api/goals/${goalId}/pr-status?optional=1&intent=visible`),
				clientJson(sessionPage, `/api/goals/${goalId}/pr-status?optional=1&intent=sidebar`),
			]);
			expect(prReads).toBe(1);
			now += 1;
			await Promise.all([
				clientJson(page, `/api/goals/${goalId}/pr-status?optional=1&intent=visible`),
				clientJson(sessionPage, `/api/sessions/${sessionId}/pr-status?optional=1&intent=visible`),
				clientJson(page, `/api/goals/${goalId}/pr-status?optional=1&intent=sidebar`),
			]);
			await expect.poll(() => prReads, { timeout: 5_000 }).toBe(2);

			now += 59_999;
			await Promise.all([
				clientJson(page, `/api/goals/${goalId}/pr-status?optional=1&intent=sidebar`),
				clientJson(sessionPage, `/api/goals/${goalId}/pr-status?optional=1&intent=sidebar`),
			]);
			expect(prReads).toBe(2);
			now += 1;
			await Promise.all([
				clientJson(page, `/api/goals/${goalId}/pr-status?optional=1&intent=sidebar`),
				clientJson(sessionPage, `/api/goals/${goalId}/pr-status?optional=1&intent=sidebar`),
			]);
			await expect.poll(() => prReads, { timeout: 5_000 }).toBe(3);

			// The session's next automatic tick survives the initial cold envelope.
			// It starts one eligible canonical fetch and updates both closed widgets;
			// no visibility event or dropdown interaction is needed.
			advanceRemote(fixture.peer);
			await expect(page.locator("#git-status-dropdown")).toHaveCount(0);
			await expect(sessionPage.locator("#git-status-dropdown")).toHaveCount(0);
			const automaticReadsBeforeTick = gitStatusRequests.filter((url) => url.includes("intent=automatic")).length;
			await expect.poll(
				() => gitStatusRequests.filter((url) => url.includes("intent=automatic")).length,
				{ timeout: 35_000 },
			).toBeGreaterThan(automaticReadsBeforeTick);
			await expect.poll(() => gitFetches, { timeout: 10_000 }).toBe(2);
			await expect.poll(() => widgetState(dashboardWidget), { timeout: 10_000 }).toMatchObject({ behind: 1 });
			await expect.poll(() => widgetState(sessionWidget), { timeout: 10_000 }).toMatchObject({ behind: 1 });
			await expect(page.locator("#git-status-dropdown")).toHaveCount(0);
			await expect(sessionPage.locator("#git-status-dropdown")).toHaveCount(0);

			// A repository-only failure must not be hidden by the healthy PR record.
			// Both clients retain refs and target one canonical explicit Git recovery.
			now += 30_000;
			failGitFetches = true;
			const fetchesBeforeGitFailure = gitFetches;
			await Promise.all([
				clientJson(page, `/api/goals/${goalId}/git-status?intent=visible`),
				clientJson(sessionPage, `/api/sessions/${sessionId}/git-status?intent=visible`),
			]);
			await expect.poll(() => gitFetches, { timeout: 10_000 }).toBe(fetchesBeforeGitFailure + 1);
			for (const widget of [dashboardWidget, sessionWidget]) {
				await expect.poll(() => widgetState(widget), { timeout: 10_000 }).toMatchObject({
					behind: 1,
					gitSnapshot: { stale: true, ageMs: 30_000, lastError: "offline", source: "repository" },
					prSnapshot: { stale: false, source: "pr" },
				});
			}
			await dashboardWidget.locator("button").first().click();
			await sessionWidget.locator("button").first().click();
			const dashboardGitFailure = page.locator('#git-status-dropdown [data-testid="remote-state-status"][data-remote-resource="git"]');
			const sessionGitFailure = sessionPage.locator('#git-status-dropdown [data-testid="remote-state-status"][data-remote-resource="git"]');
			await expect(dashboardGitFailure).toContainText("Remote offline; showing last known state (30s ago) via repository.");
			await expect(sessionGitFailure).toContainText("Remote offline; showing last known state (30s ago) via repository.");

			failGitFetches = false;
			holdNextGitFetch();
			const fetchesBeforeGitRecovery = gitFetches;
			await Promise.all([
				dashboardGitFailure.getByRole("button", { name: "Refresh" }).click(),
				sessionGitFailure.getByRole("button", { name: "Refresh" }).click(),
			]);
			await expect.poll(() => gitFetches, { timeout: 10_000 }).toBe(fetchesBeforeGitRecovery + 1);
			await page.waitForTimeout(300);
			expect(gitFetches).toBe(fetchesBeforeGitRecovery + 1);
			heldGitFetch = undefined;
			releaseGitFetch?.();
			for (const widget of [dashboardWidget, sessionWidget]) {
				await expect.poll(() => widgetState(widget), { timeout: 10_000 }).toMatchObject({
					behind: 1,
					gitSnapshot: { stale: false, ageMs: 0, source: "repository" },
					prSnapshot: { stale: false, source: "pr" },
				});
			}
			await dashboardWidget.locator("button").first().click();
			await sessionWidget.locator("button").first().click();
			await expect(page.locator("#git-status-dropdown")).toHaveCount(0);
			await expect(sessionPage.locator("#git-status-dropdown")).toHaveCount(0);

			// A real fixture failure after last-good retains the PR everywhere, exposes
			// only the safe error category/age, and offers an explicit refresh.
			now += 20_000;
			failPrReads = true;
			await Promise.all([setVisible(page), setVisible(sessionPage)]);
			await expect.poll(() => prReads, { timeout: 10_000 }).toBe(4);
			await expect.poll(() => widgetState(dashboardWidget), { timeout: 10_000 }).toMatchObject({
				prState: "OPEN",
				prNumber: 42,
				prTitle,
				stale: true,
				ageMs: 50_000,
				lastError: "offline",
				source: "pr",
			});
			await expect.poll(() => widgetState(sessionWidget), { timeout: 10_000 }).toMatchObject({
				prState: "OPEN",
				prNumber: 42,
				stale: true,
				ageMs: 50_000,
				lastError: "offline",
				source: "pr",
			});
			await expect(dashboardGoalRow.locator('a[title*="remote offline; showing last known state"]')).toBeVisible();
			const safeFailure = await clientJson(page, `/api/goals/${goalId}/pr-status?optional=1&intent=visible`);
			expect(safeFailure.status).toBe(200);
			expect(safeFailure.body).toMatchObject({ stale: true, lastError: "offline", ageMs: 50_000, source: "pr" });
			expect(JSON.stringify(safeFailure.body)).not.toContain("fixture-offline-private-detail");
			expect(JSON.stringify(safeFailure.body)).not.toContain("secret@example.test");

			await dashboardWidget.locator("button").first().click();
			await sessionWidget.locator("button").first().click();
			const dashboardRemoteStatus = page.locator('#git-status-dropdown [data-testid="remote-state-status"]');
			const sessionRemoteStatus = sessionPage.locator('#git-status-dropdown [data-testid="remote-state-status"]');
			await expect(dashboardRemoteStatus).toContainText("Remote offline; showing last known state (50s ago) via pr.");
			await expect(sessionRemoteStatus).toContainText("Remote offline; showing last known state (50s ago) via pr.");

			// Both visible Refresh buttons force the same canonical PR concurrently.
			// Holding the injected PR read proves the second client joins in-flight work.
			failPrReads = false;
			prTitle = "Recovered coordinator PR";
			reviewDecision = "APPROVED";
			holdNextPrRead();
			await Promise.all([
				dashboardRemoteStatus.getByRole("button", { name: "Refresh" }).click(),
				sessionRemoteStatus.getByRole("button", { name: "Refresh" }).click(),
			]);
			await expect.poll(() => prReads, { timeout: 10_000 }).toBe(5);
			await page.waitForTimeout(300);
			expect(prReads).toBe(5);
			heldPrRead = undefined;
			releasePrRead?.();
			await expect.poll(() => widgetState(dashboardWidget), { timeout: 10_000 }).toMatchObject({
				prTitle,
				stale: false,
				ageMs: 0,
				lastError: undefined,
				source: "pr",
			});
			await expect.poll(() => widgetState(sessionWidget), { timeout: 10_000 }).toMatchObject({
				prTitle,
				stale: false,
				ageMs: 0,
				lastError: undefined,
				source: "pr",
			});
			await expect(dashboardGoalRow.locator('a[title*="approved"]')).toBeVisible();
			await expect(sessionGoalRow.locator('a[title*="approved"]')).toBeVisible();

			// Reload hydrates the same last-good snapshot into both clients without
			// adding an external read while the canonical record is fresh.
			const readsBeforeReload = prReads;
			const fetchesBeforeReload = gitFetches;
			await Promise.all([page.reload(), sessionPage.reload()]);
			const reloadedDashboardWidget = page.locator(".dashboard-git-row git-status-widget").first();
			const reloadedSessionWidget = sessionPage.locator("pi-chat-panel git-status-widget").first();
			await expect(reloadedDashboardWidget).toBeAttached({ timeout: 15_000 });
			await expect(reloadedSessionWidget).toBeAttached({ timeout: 15_000 });
			await expect.poll(() => widgetState(reloadedDashboardWidget), { timeout: 10_000 }).toMatchObject({
				behind: 1,
				prState: "OPEN",
				prNumber: 42,
				prTitle,
				stale: false,
				lastError: undefined,
			});
			await expect.poll(() => widgetState(reloadedSessionWidget), { timeout: 10_000 }).toMatchObject({
				behind: 1,
				prState: "OPEN",
				prNumber: 42,
				prTitle,
				stale: false,
				lastError: undefined,
			});
			expect(prReads).toBe(readsBeforeReload);
			expect(gitFetches).toBe(fetchesBeforeReload);
			await expect(page.locator(`[data-nav-id="goal:${goalId}"] a[title*="approved"]`).first()).toBeVisible();
			await expect(sessionPage.locator(`[data-nav-id="goal:${goalId}"] a[title*="approved"]`).first()).toBeVisible();
		} finally {
			heldGitFetch = undefined;
			releaseGitFetch?.();
			heldPrRead = undefined;
			releasePrRead?.();
			clock.now = originalNow;
			runner.execFile = originalExecFile;
			await page.goto("about:blank").catch(() => {});
			if (sessionPage) await sessionPage.close().catch(() => {});
			if (sessionId) await deleteSession(sessionId);
			if (goalId) await deleteGoal(goalId, true);
			await removeFixture(fixture);
		}
	});
});
