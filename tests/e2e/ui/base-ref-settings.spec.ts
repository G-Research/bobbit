/**
 * Browser E2E — Settings → General → "Base Ref" field.
 *
 * Covers persistence happy path, inline error rendering for each
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

test.describe("Settings → Base Ref field", () => {
	test("persists across reload (happy path)", async ({ page }) => {
		const dir = uniqueProjectDir("happy");
		gitInit(dir, { remoteRefs: ["develop"] });
		const projectId = await createProject(`baseref-ui-happy-${Date.now()}`, dir);
		try {
			await openApp(page);
			await navigateToHash(page, `#/settings/${projectId}/general`);

			const input = page.locator("[data-testid='base-ref-input']");
			await expect(input).toBeVisible({ timeout: 10_000 });

			await input.fill("origin/develop");

			const savePromise = page.waitForResponse(
				resp => resp.url().includes(`/api/projects/${projectId}/config`) &&
					resp.request().method() === "PUT" &&
					resp.status() === 200,
			);
			await page.locator("button").filter({ hasText: /^Save$/ }).first().click();
			await savePromise;

			// Reload — value should persist.
			await page.reload();
			await expect(
				page.locator("button").filter({ hasText: "Settings" }).first(),
			).toBeVisible({ timeout: 15_000 });
			await navigateToHash(page, `#/settings/${projectId}/general`);
			const inputAfter = page.locator("[data-testid='base-ref-input']");
			await expect(inputAfter).toBeVisible({ timeout: 10_000 });
			await expect(inputAfter).toHaveValue("origin/develop");
		} finally {
			await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("inline tag error renders verbatim", async ({ page }) => {
		const dir = uniqueProjectDir("tag");
		gitInit(dir, { tags: ["v1.2.3"] });
		const projectId = await createProject(`baseref-ui-tag-${Date.now()}`, dir);
		try {
			await openApp(page);
			await navigateToHash(page, `#/settings/${projectId}/general`);

			const input = page.locator("[data-testid='base-ref-input']");
			await expect(input).toBeVisible({ timeout: 10_000 });
			await input.fill("v1.2.3");

			const savePromise = page.waitForResponse(
				resp => resp.url().includes(`/api/projects/${projectId}/config`) &&
					resp.request().method() === "PUT" &&
					resp.status() === 400,
			);
			await page.locator("button").filter({ hasText: /^Save$/ }).first().click();
			await savePromise;

			const errBox = page.locator("[data-testid='base-ref-error']");
			await expect(errBox).toBeVisible({ timeout: 5_000 });
			await expect(errBox).toContainText(
				"base_ref must be a branch ref, not a tag. Tags can't be used as git upstreams. Got: v1.2.3",
			);
		} finally {
			await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("inline grammar error renders", async ({ page }) => {
		const dir = uniqueProjectDir("grammar");
		gitInit(dir);
		const projectId = await createProject(`baseref-ui-grammar-${Date.now()}`, dir);
		try {
			await openApp(page);
			await navigateToHash(page, `#/settings/${projectId}/general`);

			const input = page.locator("[data-testid='base-ref-input']");
			await expect(input).toBeVisible({ timeout: 10_000 });
			await input.fill("feature foo");

			const savePromise = page.waitForResponse(
				resp => resp.url().includes(`/api/projects/${projectId}/config`) &&
					resp.request().method() === "PUT" &&
					resp.status() === 400,
			);
			await page.locator("button").filter({ hasText: /^Save$/ }).first().click();
			await savePromise;

			const errBox = page.locator("[data-testid='base-ref-error']");
			await expect(errBox).toBeVisible({ timeout: 5_000 });
			await expect(errBox).toContainText("base_ref must be a valid branch name. Got: feature foo");
		} finally {
			await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("sandbox + local ref shows sandbox-specific error", async ({ page }) => {
		const dir = uniqueProjectDir("sandbox");
		gitInit(dir);
		const projectId = await createProject(`baseref-ui-sandbox-${Date.now()}`, dir);
		// Pre-set sandbox=docker via API so the UI only needs to drive base_ref.
		const putRes = await apiFetch(`/api/projects/${projectId}/config`, {
			method: "PUT",
			body: JSON.stringify({ sandbox: "docker" }),
		});
		expect(putRes.ok).toBe(true);
		try {
			await openApp(page);
			await navigateToHash(page, `#/settings/${projectId}/general`);

			const input = page.locator("[data-testid='base-ref-input']");
			await expect(input).toBeVisible({ timeout: 10_000 });
			await input.fill("master");

			const savePromise = page.waitForResponse(
				resp => resp.url().includes(`/api/projects/${projectId}/config`) &&
					resp.request().method() === "PUT" &&
					resp.status() === 400,
			);
			await page.locator("button").filter({ hasText: /^Save$/ }).first().click();
			await savePromise;

			const errBox = page.locator("[data-testid='base-ref-error']");
			await expect(errBox).toBeVisible({ timeout: 5_000 });
			await expect(errBox).toContainText(
				"base_ref must be a remote ref (origin/...) for sandboxed projects. The container has separate ref visibility from the host. Got: master",
			);
		} finally {
			await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("multi-repo: per-component bullets render when ref is missing", async ({ page }) => {
		const root = uniqueProjectDir("multi");
		const repoA = join(root, "api");
		const repoB = join(root, "web");
		gitInit(repoA, { remoteRefs: ["develop"] });
		gitInit(repoB); // missing origin/develop
		const projectId = await createProject(
			`baseref-ui-multi-${Date.now()}`,
			root,
			[
				{ name: "api", repo: "api" },
				{ name: "web", repo: "web" },
			],
		);
		try {
			await openApp(page);
			await navigateToHash(page, `#/settings/${projectId}/general`);

			const input = page.locator("[data-testid='base-ref-input']");
			await expect(input).toBeVisible({ timeout: 10_000 });
			await input.fill("origin/develop");

			const savePromise = page.waitForResponse(
				resp => resp.url().includes(`/api/projects/${projectId}/config`) &&
					resp.request().method() === "PUT" &&
					resp.status() === 400,
			);
			await page.locator("button").filter({ hasText: /^Save$/ }).first().click();
			await savePromise;

			const errBox = page.locator("[data-testid='base-ref-error']");
			await expect(errBox).toBeVisible({ timeout: 5_000 });
			await expect(errBox).toContainText("base_ref 'origin/develop' is not present in 1 of 2 component repos");
			// At least one per-component bullet renders for `web`.
			await expect(errBox.locator("li")).toHaveCount(1);
			await expect(errBox.locator("li")).toContainText("web");
			await expect(errBox.locator("li")).toContainText("ref not found");
		} finally {
			await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("editing the input clears any prior inline error", async ({ page }) => {
		const dir = uniqueProjectDir("clear");
		gitInit(dir, { tags: ["v9.9.9"] });
		const projectId = await createProject(`baseref-ui-clear-${Date.now()}`, dir);
		try {
			await openApp(page);
			await navigateToHash(page, `#/settings/${projectId}/general`);

			const input = page.locator("[data-testid='base-ref-input']");
			await expect(input).toBeVisible({ timeout: 10_000 });
			await input.fill("v9.9.9");

			const savePromise = page.waitForResponse(
				resp => resp.url().includes(`/api/projects/${projectId}/config`) &&
					resp.request().method() === "PUT" &&
					resp.status() === 400,
			);
			await page.locator("button").filter({ hasText: /^Save$/ }).first().click();
			await savePromise;

			const errBox = page.locator("[data-testid='base-ref-error']");
			await expect(errBox).toBeVisible({ timeout: 5_000 });

			// Typing into the input clears the inline error immediately.
			await input.fill("master");
			await expect(errBox).toHaveCount(0);
		} finally {
			await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
		}
	});
});
