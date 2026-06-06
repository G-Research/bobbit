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
import { createGitFixtureRepo as gitInit } from "../../test-utils/git-fixture.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

type BrowserPage = Parameters<typeof openApp>[0];

function uniqueProjectDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `bobbit-baseref-ui-${prefix}-`));
}

async function createProject(name: string, rootPath: string, components?: Array<{ name: string; repo: string }>): Promise<string> {
	const body: Record<string, unknown> = { name, rootPath };
	if (components) body.components = components;
	const resp = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify(body),
	});
	expect(resp.ok, `project create failed: ${resp.status}`).toBe(true);
	const proj = await resp.json();
	return proj.id;
}

async function openBaseRefSettings(page: BrowserPage, projectId: string) {
	await navigateToHash(page, `#/settings/${projectId}/general`);
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
			const projectId = await createProject(`baseref-ui-happy-${Date.now()}`, dir);
			projectIds.push(projectId);

			await openApp(page);
			const input = await openBaseRefSettings(page, projectId);
			await input.fill("origin/develop");
			await saveBaseRef(page, projectId, 200);

			// Reload — value should persist.
			await page.reload();
			await expect(
				page.locator("button").filter({ hasText: "Settings" }).first(),
			).toBeVisible({ timeout: 15_000 });
			const inputAfter = await openBaseRefSettings(page, projectId);
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
			const tagProjectId = await createProject(`baseref-ui-tag-${Date.now()}`, tagDir);
			projectIds.push(tagProjectId);

			const grammarDir = uniqueProjectDir("grammar");
			gitInit(grammarDir);
			const grammarProjectId = await createProject(`baseref-ui-grammar-${Date.now()}`, grammarDir);
			projectIds.push(grammarProjectId);

			const sandboxDir = uniqueProjectDir("sandbox");
			gitInit(sandboxDir);
			const sandboxProjectId = await createProject(`baseref-ui-sandbox-${Date.now()}`, sandboxDir);
			projectIds.push(sandboxProjectId);
			// Pre-set sandbox=docker via API so the UI only needs to drive base_ref.
			const putRes = await apiFetch(`/api/projects/${sandboxProjectId}/config`, {
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
			const multiProjectId = await createProject(
				`baseref-ui-multi-${Date.now()}`,
				root,
				[
					{ name: "api", repo: "api" },
					{ name: "web", repo: "web" },
					{ name: "shared", repo: "shared" },
				],
			);
			projectIds.push(multiProjectId);

			await openApp(page);

			let input = await openBaseRefSettings(page, tagProjectId);
			await input.fill("v1.2.3");
			await saveBaseRef(page, tagProjectId, 400);
			let errBox = page.locator("[data-testid='base-ref-error']");
			await expect(errBox).toBeVisible({ timeout: 5_000 });
			await expect(errBox).toContainText(
				"base_ref must be a branch ref, not a tag. Tags can't be used as git upstreams. Got: v1.2.3",
			);

			// Typing into the input clears the inline error immediately.
			await input.fill("master");
			await expect(errBox).toHaveCount(0);

			input = await openBaseRefSettings(page, grammarProjectId);
			await input.fill("feature foo");
			await saveBaseRef(page, grammarProjectId, 400);
			errBox = page.locator("[data-testid='base-ref-error']");
			await expect(errBox).toBeVisible({ timeout: 5_000 });
			await expect(errBox).toContainText("base_ref must be a valid branch name. Got: feature foo");

			input = await openBaseRefSettings(page, sandboxProjectId);
			await input.fill("master");
			await saveBaseRef(page, sandboxProjectId, 400);
			errBox = page.locator("[data-testid='base-ref-error']");
			await expect(errBox).toBeVisible({ timeout: 5_000 });
			await expect(errBox).toContainText(
				"base_ref must be a remote ref (origin/...) for sandboxed projects. The container has separate ref visibility from the host. Got: master",
			);

			input = await openBaseRefSettings(page, multiProjectId);
			await input.fill("origin/develop");
			await saveBaseRef(page, multiProjectId, 400);
			errBox = page.locator("[data-testid='base-ref-error']");
			await expect(errBox).toBeVisible({ timeout: 5_000 });
			await expect(errBox).toContainText("base_ref 'origin/develop' is not present in 2 of 3 component repos");
			const bullets = errBox.locator("li");
			await expect(bullets).toHaveCount(2);
			await expect(bullets.filter({ hasText: "web" })).toContainText("ref not found");
			await expect(bullets.filter({ hasText: "shared" })).toContainText("ref not found");
		} finally {
			await deleteProjects(projectIds);
		}
	});
});
