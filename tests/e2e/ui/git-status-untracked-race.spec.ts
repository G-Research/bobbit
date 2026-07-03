import { test, expect, type Page, type Route } from "../gateway-harness.js";
import { createGoal, createSession, deleteGoal, deleteSession, registerProject, apiFetch } from "../e2e-setup.js";
import { navigateToGoalDashboard, navigateToHash, openApp } from "./ui-helpers.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function gitStatus(status: Array<{ file: string; status: string }>) {
	return {
		branch: "master",
		primaryBranch: "master",
		primaryRef: "origin/master",
		isOnPrimary: true,
		clean: status.length === 0,
		status,
		ahead: 0,
		behind: 0,
		aheadOfPrimary: 0,
		behindPrimary: 0,
		insertionsVsPrimary: 0,
		deletionsVsPrimary: 0,
		mergedIntoPrimary: false,
		hasUpstream: false,
		unpushed: false,
		summary: status.length ? `${status.length} changed` : "",
	};
}

async function nextPaint(page: Page): Promise<void> {
	await page.evaluate(() => new Promise<void>((resolve) => {
		requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
	}));
}

async function openSession(page: Page, sessionId: string): Promise<void> {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
}

type GitProject = { id: string; rootPath: string };
const createdProjects = new Set<string>();
const createdDirs = new Set<string>();

function createGitRoot(label: string): string {
	const dir = mkdtempSync(join(tmpdir(), `bobbit-git-status-${label}-`));
	createdDirs.add(dir);
	writeFileSync(join(dir, "README.md"), "# git status E2E repo\n");
	execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
	execFileSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
	execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
	return dir;
}

async function createGitProject(label: string): Promise<GitProject> {
	const rootPath = createGitRoot(label);
	const project = await registerProject({ name: `git-status-${label}-${Date.now()}`, rootPath });
	createdProjects.add(project.id);
	return { id: project.id, rootPath };
}

test.describe("git status dropdown untracked refresh", () => {
	test.afterEach(async () => {
		for (const id of Array.from(createdProjects).reverse()) {
			await apiFetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
		}
		createdProjects.clear();
		for (const dir of Array.from(createdDirs).reverse()) rmSync(dir, { recursive: true, force: true });
		createdDirs.clear();
	});

	test("session dropdown keeps untracked files after a late summary-only refresh while open", async ({ page }) => {
		test.setTimeout(60_000);
		const project = await createGitProject("session");
		const sessionId = await createSession({ cwd: project.rootPath, projectId: project.id });
		let sawFetchUntracked = false;
		let forceLateSummary = false;
		let resolveLateSummary: (() => void) | undefined;
		const lateSummarySeen = new Promise<void>((resolve) => { resolveLateSummary = resolve; });
		const statusRe = new RegExp(`/api/sessions/${sessionId}/git-status(?:\\?.*)?$`);

		await page.route(statusRe, async (route: Route) => {
			if (route.request().method() !== "GET") return route.fallback();
			const url = new URL(route.request().url());
			const wantsUntracked = url.searchParams.get("untracked") === "1";
			if (wantsUntracked && url.searchParams.get("fetch") === "true") sawFetchUntracked = true;
			const body = wantsUntracked
				? gitStatus([
					{ file: "src/tracked-race.ts", status: "M" },
					{ file: "untracked-race.txt", status: "?" },
				])
				: gitStatus([{ file: forceLateSummary ? "src/late-summary-only.ts" : "src/tracked-race.ts", status: "M" }]);
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(body),
			});
			if (!wantsUntracked && forceLateSummary) resolveLateSummary?.();
		});

		try {
			await openApp(page);
			await openSession(page, sessionId);

			const pill = page.locator("git-status-widget button").first();
			await expect(pill).toBeVisible({ timeout: 15_000 });
			await pill.click();
			const dropdown = page.locator("#git-status-dropdown");
			await expect(dropdown).toBeVisible({ timeout: 5_000 });
			await expect(dropdown).toContainText("untracked-race.txt", { timeout: 5_000 });

			await expect.poll(() => sawFetchUntracked, {
				timeout: 2_000,
				message: "session git widget did not request ?fetch=true&untracked=1 on open",
			}).toBe(true);

			forceLateSummary = true;
			await page.locator("git-status-widget").first().evaluate((el) => {
				el.dispatchEvent(new CustomEvent("git-fetch", { bubbles: true, composed: true }));
			});
			await lateSummarySeen;
			await nextPaint(page);

			await expect(
				dropdown,
				"late summary hid untracked-race.txt from the open git status dropdown",
			).toContainText("untracked-race.txt", { timeout: 1_000 });
		} finally {
			await deleteSession(sessionId).catch(() => { /* best-effort cleanup */ });
		}
	});

	test("dashboard dropdown open requests untracked-aware git status", async ({ page }) => {
		test.setTimeout(60_000);
		const project = await createGitProject("dashboard");
		const goal = await createGoal({
			title: "Dashboard git untracked open",
			cwd: project.rootPath,
			projectId: project.id,
			worktree: false,
			team: false,
			autoStartTeam: false,
		});
		let sawFetchUntracked = false;
		const statusRe = new RegExp(`/api/goals/${goal.id}/git-status(?:\\?.*)?$`);

		await page.route(statusRe, async (route: Route) => {
			if (route.request().method() !== "GET") return route.fallback();
			const url = new URL(route.request().url());
			const wantsUntracked = url.searchParams.get("untracked") === "1";
			if (wantsUntracked && url.searchParams.get("fetch") === "true") sawFetchUntracked = true;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(wantsUntracked
					? gitStatus([
						{ file: "src/dashboard-tracked.ts", status: "M" },
						{ file: "dashboard-untracked-race.txt", status: "?" },
					])
					: gitStatus([{ file: "src/dashboard-tracked.ts", status: "M" }])),
			});
		});

		try {
			await openApp(page);
			await navigateToGoalDashboard(page, goal.id);
			const pill = page.locator(".dashboard-git-row git-status-widget button").first();
			await expect(pill).toBeVisible({ timeout: 15_000 });
			await pill.click();
			await expect(page.locator("#git-status-dropdown")).toBeVisible({ timeout: 5_000 });

			await expect.poll(() => sawFetchUntracked, {
				timeout: 2_000,
				message: "dashboard git widget did not request ?fetch=true&untracked=1 on open",
			}).toBe(true);
		} finally {
			await deleteGoal(goal.id).catch(() => { /* best-effort cleanup */ });
		}
	});
});
