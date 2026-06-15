/**
 * Browser E2E — Settings → General → "Base Ref" field.
 *
 * Covers persistence happy path plus inline error rendering for each
 * validation row (tag, grammar, sandbox-local, multi-repo missing).
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

function gitInit(dir: string, opts?: { tags?: string[]; remoteRefs?: string[] }): void {
	mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "--quiet"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@bobbit.local"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
	execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
	execFileSync("git", ["checkout", "--quiet", "-b", "master"], { cwd: dir });
	writeFileSync(join(dir, "README.md"), "x\n");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "--quiet", "-m", "init"], { cwd: dir });
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim();
	for (const t of opts?.tags ?? []) {
		execFileSync("git", ["tag", t], { cwd: dir });
	}
	for (const r of opts?.remoteRefs ?? []) {
		const refPath = join(dir, ".git", "refs", "remotes", "origin", r);
		mkdirSync(join(refPath, ".."), { recursive: true });
		writeFileSync(refPath, head + "\n");
	}
}

function uniqueProjectDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `bobbit-baseref-ui-${prefix}-`));
}

async function createProject(name: string, rootPath: string, components?: Array<{ name: string; repo: string }>): Promise<{ id: string; name: string }> {
	const body: Record<string, unknown> = { name, rootPath };
	if (components) body.components = components;
	const resp = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify(body),
	});
	expect(resp.ok, `project create failed: ${resp.status}`).toBe(true);
	const proj = await resp.json();
	return { id: proj.id, name };
}

async function openBaseRefSettings(page: BrowserPage, project: { id: string; name: string }) {
	await navigateToHash(page, `#/settings/${project.id}/general`);
	// The base-ref input is shared by every project settings page. Wait for the
	// project-specific heading so fills/saves cannot race against the previous
	// settings render after only the hash has changed.
	await expect(page.locator("h3").filter({ hasText: project.name }).first()).toBeVisible({ timeout: 10_000 });
	const input = page.locator("[data-testid='base-ref-input']");
	await expect(input).toBeVisible({ timeout: 10_000 });
	return input;
}

async function saveBaseRef(page: BrowserPage, projectId: string, expectedStatus: number): Promise<void> {
	const savePromise = page.waitForResponse(
		resp => resp.url().includes(`/api/projects/${projectId}/config`) &&
			resp.request().method() === "PUT" &&
			resp.status() === expectedStatus,
	);
	await page.locator("button").filter({ hasText: /^Save$/ }).first().click();
	await savePromise;
	await expect(page.locator("button").filter({ hasText: /^Saving\.\.\.$/ })).toHaveCount(0, { timeout: 10_000 });
}

async function expectBaseRefError(page: BrowserPage, expectedText: string) {
	const errBox = page.locator("[data-testid='base-ref-error']");
	await expect.poll(async () => (await errBox.textContent())?.trim() ?? "", { timeout: 10_000 })
		.toContain(expectedText);
	return errBox;
}

async function deleteProjects(projectIds: string[]): Promise<void> {
	await Promise.all(projectIds.map(projectId =>
		apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {}),
	));
}

test.describe("Settings → Base Ref field", () => {
	test("persists across reload (happy path)", async ({ page }) => {
		const projectIds: string[] = [];
		try {
			const dir = uniqueProjectDir("happy");
			gitInit(dir, { remoteRefs: ["develop"] });
			const project = await createProject(`baseref-ui-happy-${Date.now()}`, dir);
			projectIds.push(project.id);

			await openApp(page);
			const input = await openBaseRefSettings(page, project);
			await input.fill("origin/develop");
			await saveBaseRef(page, project.id, 200);

			// Reload — value should persist.
			await page.reload();
			await expect(
				page.locator("button").filter({ hasText: "Settings" }).first(),
			).toBeVisible({ timeout: 15_000 });
			const inputAfter = await openBaseRefSettings(page, project);
			await expect(inputAfter).toHaveValue("origin/develop");
		} finally {
			await deleteProjects(projectIds);
		}
	});

	test("renders validation errors and clears stale inline errors", async ({ page }) => {
		const projectIds: string[] = [];
		try {
			const tagDir = uniqueProjectDir("tag");
			gitInit(tagDir, { tags: ["v1.2.3"] });
			const tagProject = await createProject(`baseref-ui-tag-${Date.now()}`, tagDir);
			projectIds.push(tagProject.id);

			const grammarDir = uniqueProjectDir("grammar");
			gitInit(grammarDir);
			const grammarProject = await createProject(`baseref-ui-grammar-${Date.now()}`, grammarDir);
			projectIds.push(grammarProject.id);

			const sandboxDir = uniqueProjectDir("sandbox");
			gitInit(sandboxDir);
			const sandboxProject = await createProject(`baseref-ui-sandbox-${Date.now()}`, sandboxDir);
			projectIds.push(sandboxProject.id);
			// Pre-set sandbox=docker via API so the UI only needs to drive base_ref.
			const putRes = await apiFetch(`/api/projects/${sandboxProject.id}/config`, {
				method: "PUT",
				body: JSON.stringify({ sandbox: "docker" }),
			});
			expect(putRes.ok).toBe(true);

			const root = uniqueProjectDir("multi");
			const repoA = join(root, "api");
			const repoB = join(root, "web");
			const repoC = join(root, "shared");
			gitInit(repoA, { remoteRefs: ["develop"] });
			gitInit(repoB); // missing origin/develop
			gitInit(repoC); // missing origin/develop
			const multiProject = await createProject(
				`baseref-ui-multi-${Date.now()}`,
				root,
				[
					{ name: "api", repo: "api" },
					{ name: "web", repo: "web" },
					{ name: "shared", repo: "shared" },
				],
			);
			projectIds.push(multiProject.id);

			await openApp(page);

			let input = await openBaseRefSettings(page, tagProject);
			await input.fill("v1.2.3");
			await saveBaseRef(page, tagProject.id, 400);
			let errBox = await expectBaseRefError(
				page,
				"base_ref must be a branch ref, not a tag. Tags can't be used as git upstreams. Got: v1.2.3",
			);

			// Typing into the input clears the inline error immediately.
			await input.fill("master");
			await expect(input).toHaveValue("master");
			await expect(errBox).toHaveCount(0, { timeout: 10_000 });

			input = await openBaseRefSettings(page, grammarProject);
			await input.fill("feature foo");
			await saveBaseRef(page, grammarProject.id, 400);
			errBox = await expectBaseRefError(page, "base_ref must be a valid branch name. Got: feature foo");

			input = await openBaseRefSettings(page, sandboxProject);
			await input.fill("master");
			await saveBaseRef(page, sandboxProject.id, 400);
			errBox = await expectBaseRefError(
				page,
				"base_ref must be a remote ref (origin/...) for sandboxed projects. The container has separate ref visibility from the host. Got: master",
			);

			input = await openBaseRefSettings(page, multiProject);
			await input.fill("origin/develop");
			await saveBaseRef(page, multiProject.id, 400);
			errBox = await expectBaseRefError(page, "base_ref 'origin/develop' is not present in 2 of 3 component repos");
			const bullets = errBox.locator("li");
			await expect(bullets).toHaveCount(2);
			await expect(bullets.filter({ hasText: "web" })).toContainText("ref not found");
			await expect(bullets.filter({ hasText: "shared" })).toContainText("ref not found");
		} finally {
			await deleteProjects(projectIds);
		}
	});
});
