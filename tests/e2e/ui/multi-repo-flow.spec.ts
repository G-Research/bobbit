/**
 * Multi-repo UI flow (Phase 4b) — acceptance criterion 20.
 *
 * Registers a multi-repo project (two real git fixtures + one data-only repo)
 * via the API, drives the Settings → Components UI, and verifies component
 * rendering/editing/deletion browser flows. API/data-path coverage lives in
 * tests/e2e/multi-repo-flow-api.spec.ts.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, readE2EToken, base } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function gitInit(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "--quiet"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@bobbit.local"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "README.md"), "fixture\n");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: dir });
	// Ensure an `origin` exists so worktree push targets resolve. Fake it via
	// a bare clone alongside.
	const bare = `${dir}-bare`;
	execFileSync("git", ["clone", "--bare", "--quiet", dir, bare], { stdio: "pipe" });
	execFileSync("git", ["remote", "add", "origin", bare], { cwd: dir });
}

async function registerMultiRepoProject(): Promise<{ id: string; rootPath: string; cleanup: () => void }> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-mr-ui-"));
	gitInit(path.join(root, "api"));
	gitInit(path.join(root, "web"));
	fs.mkdirSync(path.join(root, "shared"), { recursive: true });  // data-only repo

	const res = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({
			name: `mr-ui-${Date.now()}`,
			rootPath: root,
			components: [
				{ name: "api", repo: "api", commands: { build: "echo build-api", test: "echo test-api" } },
				{ name: "web", repo: "web", commands: { build: "echo build-web" } },
				{ name: "shared", repo: "shared" },  // data-only
			],
			workflows: {
				simple: {
					id: "simple",
					name: "Simple",
					gates: [
						{
							id: "implementation",
							name: "Build",
							verify: [
								{ name: "Build api", type: "command", component: "api", command: "build" },
								{ name: "Test api", type: "command", component: "api", command: "test" },
								{ name: "Build web", type: "command", component: "web", command: "build" },
							],
						},
					],
				},
			},
		}),
	});
	expect(res.status).toBe(201);
	const project = await res.json();
	return {
		id: project.id,
		rootPath: root,
		cleanup: () => {
			try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
			try { fs.rmSync(path.join(root, "api-bare"), { recursive: true, force: true }); } catch { /* ignore */ }
			try { fs.rmSync(path.join(root, "web-bare"), { recursive: true, force: true }); } catch { /* ignore */ }
		},
	};
}

async function navigateToSettings(page: import("@playwright/test").Page, projectId: string, tab: string): Promise<void> {
	const baseUrl = base();
	const token = readE2EToken();
	await page.goto(`${baseUrl}/?token=${encodeURIComponent(token)}#/settings/${projectId}/${tab}`);
	await expect(page.locator('[data-testid="components-tab"], [data-testid="components-error"]')).toBeVisible({ timeout: 10_000 }).catch(() => {});
}

test.describe("multi-repo flow (UI)", () => {
	test("Settings → Components lists, edits, persists, and deletes components", async ({ page }, testInfo) => {
		test.setTimeout(60_000);
		const project = await registerMultiRepoProject();
		testInfo.attach("project-root", { body: project.rootPath, contentType: "text/plain" }).catch(() => {});

		try {
			await openApp(page);
			await navigateToSettings(page, project.id, "components");

			const cards = page.locator('[data-testid="component-card"]');
			await expect(cards).toHaveCount(3, { timeout: 10_000 });
			await expect(page.locator('[data-component-name="api"]')).toBeVisible();
			await expect(page.locator('[data-component-name="web"]')).toBeVisible();
			await expect(page.locator('[data-component-name="shared"]')).toBeVisible();
			await expect(page.locator('[data-component-name="shared"] [data-testid="data-only-hint"]')).toBeVisible();

			// Edit api/build value, save, then reload to verify persistence.
			const apiCard = page.locator('[data-component-name="api"]');
			const buildRow = apiCard.locator('[data-testid="command-row"]').first();
			await buildRow.locator('[data-testid="command-value"]').fill("echo edited");
			await page.locator('[data-testid="save-components"]').click();
			await expect(page.locator('[data-testid="save-status"]')).toHaveText("Saved.", { timeout: 10_000 });

			await page.reload();
			await expect(page.locator('[data-component-name="api"]')).toBeVisible({ timeout: 10_000 });
			const reloadedValue = await page
				.locator('[data-component-name="api"] [data-testid="command-row"]')
				.first()
				.locator('[data-testid="command-value"]')
				.inputValue();
			expect(reloadedValue).toBe("echo edited");

			// Delete the data-only component, save, and verify the structured API data.
			page.once("dialog", d => d.accept());
			await page.locator('[data-component-name="shared"] [data-testid="delete-component"]').click();
			await expect(page.locator('[data-testid="component-card"]')).toHaveCount(2);
			await page.locator('[data-testid="save-components"]').click();
			await expect(page.locator('[data-testid="save-status"]')).toHaveText("Saved.", { timeout: 10_000 });

			const res = await apiFetch(`/api/projects/${project.id}/structured`);
			const data = await res.json();
			expect(data.components.map((c: any) => c.name)).toEqual(["api", "web"]);
		} finally {
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			project.cleanup();
		}
	});
});
