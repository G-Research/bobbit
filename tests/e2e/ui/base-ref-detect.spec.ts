/**
 * Browser E2E — Settings → General → "Base Ref" field, blank-value affordances.
 *
 * Change 2 of "Pin base_ref at add time": for a project whose stored `base_ref`
 * is blank, Settings shows the resolved fallback (what worktrees actually
 * branch off) as a placeholder/hint and offers a "Detect from remote" button
 * that fills the input with the live `origin/<branch>`. The user then Saves
 * through the normal flow and the value persists across reload.
 *
 * See docs/design/base-ref.md.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

type BrowserPage = Parameters<typeof openApp>[0];

/**
 * Create a working repo wired to a real bare `origin` remote whose HEAD points
 * at `master`, so `git ls-remote --symref origin HEAD` (the detect query) and
 * `git symbolic-ref refs/remotes/origin/HEAD` (the resolved fallback) both
 * return a concrete `origin/master`.
 */
function gitInitWithRemote(dir: string): void {
	const remoteDir = `${dir}-origin.git`;
	mkdirSync(remoteDir, { recursive: true });
	execFileSync("git", ["init", "--bare", "--quiet", remoteDir]);
	// Ensure the remote's HEAD symref resolves to master regardless of the
	// host git's init.defaultBranch.
	execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/master"], { cwd: remoteDir });

	mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "--quiet"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@bobbit.local"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
	execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
	execFileSync("git", ["checkout", "--quiet", "-b", "master"], { cwd: dir });
	writeFileSync(join(dir, "README.md"), "x\n");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "--quiet", "-m", "init"], { cwd: dir });
	execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: dir });
	execFileSync("git", ["push", "--quiet", "-u", "origin", "master"], { cwd: dir });
	// Populate the local refs/remotes/origin/HEAD that resolveRemotePrimary reads.
	execFileSync("git", ["remote", "set-head", "origin", "master"], { cwd: dir });
}

function uniqueProjectDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `bobbit-baseref-detect-${prefix}-`));
}

async function createProject(name: string, rootPath: string): Promise<string> {
	const resp = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name, rootPath }),
	});
	expect(resp.ok, `project create failed: ${resp.status}`).toBe(true);
	const proj = await resp.json();
	return proj.id;
}

/** Force a blank stored `base_ref` (Change 1 may pin it at create time). */
async function blankBaseRef(projectId: string): Promise<void> {
	const res = await apiFetch(`/api/projects/${projectId}/config`, {
		method: "PUT",
		body: JSON.stringify({ base_ref: "" }),
	});
	expect(res.ok, `blanking base_ref failed: ${res.status}`).toBe(true);
}

async function openBaseRefSettings(page: BrowserPage, projectId: string) {
	await navigateToHash(page, `#/settings/${projectId}/general`);
	const input = page.locator("[data-testid='base-ref-input']");
	await expect(input).toBeVisible({ timeout: 10_000 });
	return input;
}

async function deleteProjects(projectIds: string[]): Promise<void> {
	await Promise.all(projectIds.map(projectId =>
		apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {}),
	));
}

test.describe("Settings → Base Ref detect-from-remote", () => {
	test("blank base_ref shows resolved placeholder + detect fills and persists", async ({ page }) => {
		const projectIds: string[] = [];
		try {
			const dir = uniqueProjectDir("blank");
			gitInitWithRemote(dir);
			const projectId = await createProject(`baseref-detect-${Date.now()}`, dir);
			projectIds.push(projectId);
			await blankBaseRef(projectId);

			await openApp(page);
			const input = await openBaseRefSettings(page, projectId);

			// Field is blank; the resolved fallback drives the placeholder + hint.
			await expect(input).toHaveValue("");
			await expect(input).toHaveAttribute("placeholder", "origin/master", { timeout: 10_000 });

			const using = page.locator("[data-testid='base-ref-using']");
			await expect(using).toBeVisible();
			await expect(using).toContainText("origin/master");

			// Detect from remote → fills the input with the live origin/<branch>.
			const detectBtn = page.locator("[data-testid='base-ref-detect']");
			await expect(detectBtn).toBeEnabled();
			await detectBtn.click();
			await expect(input).toHaveValue("origin/master", { timeout: 10_000 });

			// Save via the normal flow.
			const savePromise = page.waitForResponse(
				resp => resp.url().includes(`/api/projects/${projectId}/config`) &&
					resp.request().method() === "PUT" &&
					resp.status() === 200,
			);
			await page.locator("button").filter({ hasText: /^Save$/ }).first().click();
			await savePromise;

			// Reload — the saved value persists.
			await page.reload();
			await expect(
				page.locator("button").filter({ hasText: "Settings" }).first(),
			).toBeVisible({ timeout: 15_000 });
			const inputAfter = await openBaseRefSettings(page, projectId);
			await expect(inputAfter).toHaveValue("origin/master");
		} finally {
			await deleteProjects(projectIds);
		}
	});
});
