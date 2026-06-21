import { test, expect } from "../gateway-harness.js";
import { apiFetch, createSession, defaultProject } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

const CLAUDE_CODE_MODEL = {
	id: "sonnet",
	name: "Claude Code Sonnet",
	provider: "claude-code",
	api: "claude-code-runtime",
	runtime: "claude-code",
	localRuntime: true,
	runtimeLabel: "Claude Code (local)",
	authenticated: true,
	sessionSelectable: true,
	contextWindow: 200_000,
	maxTokens: 8192,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

test.describe("Claude Code local-runtime UI", () => {
	test("model picker labels Claude Code as a local runtime", async ({ page }) => {
		await page.route("**/api/models**", async (route) => {
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([CLAUDE_CODE_MODEL]) });
		});
		const sessionId = await createSession();
		try {
			await openApp(page);
			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
			const footer = page.locator("[data-testid='footer-model-id']");
			await expect(footer).toBeVisible({ timeout: 15_000 });
			await footer.click();

			const row = page.locator('agent-model-selector [data-model-id="sonnet"]');
			await expect(row).toBeVisible({ timeout: 10_000 });
			await expect(row).toContainText("Claude Code Sonnet");
			await expect(row).toContainText("Local runtime");
			await expect(row).toContainText("Claude Code (local)");
			await expect(row).toContainText("Claude Code account");
		} finally {
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("selecting Claude Code in an existing Pi session prompts for and creates a new runtime session", async ({ page }) => {
		await page.route("**/api/models**", async (route) => {
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([CLAUDE_CODE_MODEL]) });
		});
		const sessionId = await createSession();
		let newSessionId = "";
		try {
			await openApp(page);
			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
			const footer = page.locator("[data-testid='footer-model-id']");
			await expect(footer).toBeVisible({ timeout: 15_000 });
			await footer.click();
			await page.locator('agent-model-selector [data-model-id="sonnet"]').click();

			await expect(page.getByText("Start a Claude Code session?")).toBeVisible({ timeout: 10_000 });
			const responsePromise = page.waitForResponse((resp) => resp.url().includes("/api/sessions") && resp.request().method() === "POST");
			await page.getByRole("button", { name: "Start new session" }).click();
			const response = await responsePromise;
			expect(response.status()).toBe(201);
			newSessionId = (await response.json()).id;

			await expect.poll(async () => page.evaluate(() => (window as any).__bobbitState?.selectedSessionId)).toBe(newSessionId);
			await expect(page.locator("[data-testid='footer-model-id']")).toHaveText("sonnet", { timeout: 15_000 });
			await expect(page.locator("[data-testid='footer-runtime-label']")).toHaveText("Claude Code (local)");
		} finally {
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
			if (newSessionId) await apiFetch(`/api/sessions/${newSessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("Claude Code session runtime metadata is visible and survives reload", async ({ page }) => {
		const project = await defaultProject();
		const resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: project.rootPath, projectId: project.id, model: "claude-code/sonnet", runtime: "claude-code" }),
		});
		expect(resp.status).toBe(201);
		const session = await resp.json();
		const sessionId = session.id;
		try {
			await openApp(page);
			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
			await expect(page.locator("[data-testid='footer-model-id']")).toHaveText("sonnet", { timeout: 15_000 });
			await expect(page.locator("[data-testid='footer-runtime-label']")).toHaveText("Claude Code (local)");
			await expect.poll(async () => page.evaluate(() => ({
				runtime: (window as any).__bobbitState?.chatPanel?.agentInterface?.sessionRuntime,
				alias: (window as any).__bobbitState?.chatPanel?.agentInterface?.claudeCodeModelAlias,
			}))).toEqual({ runtime: "claude-code", alias: "sonnet" });

			await page.reload();
			await expect(page.locator("[data-testid='footer-model-id']")).toHaveText("sonnet", { timeout: 15_000 });
			await expect(page.locator("[data-testid='footer-runtime-label']")).toHaveText("Claude Code (local)");
			await expect.poll(async () => page.evaluate(() => ({
				runtime: (window as any).__bobbitState?.chatPanel?.agentInterface?.sessionRuntime,
				alias: (window as any).__bobbitState?.chatPanel?.agentInterface?.claudeCodeModelAlias,
			}))).toEqual({ runtime: "claude-code", alias: "sonnet" });
		} finally {
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("settings status and controls for Claude Code are visible and save prefs", async ({ page }) => {
		const writes: any[] = [];
		await page.route("**/api/claude-code/status", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					available: true,
					authenticated: false,
					ready: false,
					checking: false,
					commandPath: "claude",
					version: "1.2.3",
					modelAliases: ["default", "sonnet", "opus"],
					permissionMode: "default",
					reason: "auth_required",
					message: "Claude Code is installed but not authenticated.",
				}),
			});
		});
		await page.route("**/api/preferences", async (route) => {
			if (route.request().method() === "GET") {
				await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
				return;
			}
			if (route.request().method() !== "PUT") return route.fallback();
			writes.push(JSON.parse(route.request().postData() || "{}"));
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
		});

		await openApp(page);
		await page.locator("button").filter({ hasText: "Settings" }).first().click();
		await page.locator("button").filter({ hasText: "Models" }).first().click();

		const section = page.locator("[data-testid='claude-code-section']");
		await expect(section).toBeVisible({ timeout: 10_000 });
		await expect(section.locator("[data-testid='claude-code-status-title']")).toHaveText("Claude Code login required");

		await section.locator("[data-testid='claude-code-executable']").fill("/opt/bin/claude");
		await section.locator("[data-testid='claude-code-executable']").blur();
		await section.locator("[data-testid='claude-code-default-model']").selectOption("opus");
		await section.locator("[data-testid='claude-code-permission-mode']").selectOption("acceptEdits");

		await expect.poll(() => writes.some((w) => w["claudeCode.executablePath"] === "/opt/bin/claude")).toBe(true);
		await expect.poll(() => writes.some((w) => w["claudeCode.defaultModel"] === "opus")).toBe(true);
		await expect.poll(() => writes.some((w) => w["claudeCode.permissionMode"] === "acceptEdits")).toBe(true);
	});
});
