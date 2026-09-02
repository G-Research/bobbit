/**
 * Retained full-stack project-settings smokes.
 *
 * Settings control matrices live in settings-admin-fixture, DOM tests, and
 * project-config gateway tests. These two scenarios retain source-session
 * notification routing and Add Project assistant provisioning, which require
 * the real app and gateway.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Page } from "@playwright/test";
import {
	test,
	expect,
	openApp,
	apiFetch,
	registerProject,
	navigateToHash,
	createSession,
	deleteSession,
	waitForSessionStatus,
} from "../../support/helpers/browser/journeys/journey-fixture.js";
import { awaitableRm } from "../../e2e/test-utils/cleanup.js";

let projectCounter = 0;
function uniqueProjectDir(): string {
	const dir = join(tmpdir(), `bobbit-v2-proj-${process.env.E2E_PORT ?? "0"}-${Date.now()}-${++projectCounter}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function deleteProject(id: string): Promise<void> {
	await apiFetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
}

const PROJECT_SOUND_KEY = "play_agent_finish_sound";
type ProjectSoundState = "inherit" | "on" | "off";

async function installFinishSoundInstrumentation(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const target = window as any;
		target.__finishSoundAudioContexts = 0;
		target.__finishSoundBadgeCalls = 0;
		class InstrumentedAudioContext {
			readonly currentTime = 0;
			readonly destination = {};
			constructor() { target.__finishSoundAudioContexts++; }
			createOscillator() {
				return { type: "sine", frequency: { value: 0 }, connect: (node: unknown) => node, start() {}, stop() {} };
			}
			createGain() {
				return {
					gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
					connect: (node: unknown) => node,
				};
			}
			close() { return Promise.resolve(); }
		}
		Object.defineProperty(window, "AudioContext", { configurable: true, value: InstrumentedAudioContext });
		Object.defineProperty(window, "webkitAudioContext", { configurable: true, value: InstrumentedAudioContext });
		Object.defineProperty(navigator, "setAppBadge", {
			configurable: true,
			value: async () => { target.__finishSoundBadgeCalls++; },
		});
		Object.defineProperty(navigator, "clearAppBadge", { configurable: true, value: async () => {} });
	});
}

async function completedTurnCount(sessionId: string): Promise<number> {
	const response = await apiFetch(`/api/sessions/${sessionId}`);
	if (!response.ok) throw new Error(`session ${sessionId} returned ${response.status}`);
	return Number((await response.json()).completedTurnCount ?? 0);
}

async function finishSourceSessionTurn(page: Page, sessionId: string, prompt: string) {
	await page.evaluate(() => {
		document.dispatchEvent(new Event("visibilitychange"));
		(window as any).__finishSoundAudioContexts = 0;
		(window as any).__finishSoundBadgeCalls = 0;
	});
	const turnsBefore = await completedTurnCount(sessionId);
	const editor = page.locator("message-editor textarea").first();
	await expect(editor).toBeVisible({ timeout: 15_000 });
	await editor.fill(prompt);
	await editor.press("Enter");
	await expect.poll(() => completedTurnCount(sessionId), { timeout: 30_000 }).toBeGreaterThan(turnsBefore);
	await expect.poll(
		() => page.evaluate(() => Number((window as any).__finishSoundBadgeCalls ?? 0)),
		{ timeout: 15_000 },
	).toBeGreaterThan(0);
	return page.evaluate(() => ({
		audioContexts: Number((window as any).__finishSoundAudioContexts ?? 0),
		badgeCalls: Number((window as any).__finishSoundBadgeCalls ?? 0),
	}));
}

async function selectProjectSound(page: Page, projectId: string, value: ProjectSoundState): Promise<void> {
	const select = page.getByTestId("project-play-finish-sound");
	await expect(select).toBeEnabled({ timeout: 15_000 });
	const responsePromise = page.waitForResponse(response =>
		response.request().method() === "PUT" && response.url().includes(`/api/projects/${projectId}/config`),
	);
	await select.selectOption(value);
	const response = await responsePromise;
	expect(response.ok()).toBe(true);
	expect(response.request().postDataJSON()).toEqual({
		[PROJECT_SOUND_KEY]: value === "inherit" ? null : value === "on" ? "true" : "false",
	});
}

test.describe("Journey: Project Settings — retained full-stack smokes", () => {
	test("project sound override controls source-session audio across reload while Bell stays global", async ({ page }) => {
		test.setTimeout(120_000);
		const rootPath = uniqueProjectDir();
		let projectId = "";
		let sessionId = "";
		const preferencesResponse = await apiFetch("/api/preferences");
		const originalPreferences = await preferencesResponse.json();
		const originalGlobal = Object.prototype.hasOwnProperty.call(originalPreferences, "playAgentFinishSound")
			? originalPreferences.playAgentFinishSound as boolean
			: undefined;
		try {
			await apiFetch("/api/preferences", { method: "PUT", body: JSON.stringify({ playAgentFinishSound: true }) });
			projectId = (await registerProject({
				name: `v2-project-sound-${Date.now()}`,
				rootPath,
				seedWorkflows: false,
			})).id;
			sessionId = await createSession({ projectId, cwd: rootPath });
			await waitForSessionStatus(sessionId, "idle", 30_000);
			await installFinishSoundInstrumentation(page);
			await openApp(page);
			await navigateToHash(page, `#/settings/${projectId}/general`);

			await expect(page.getByTestId("project-play-finish-sound")).toHaveValue("inherit");
			await selectProjectSound(page, projectId, "off");
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.getByTestId("project-play-finish-sound")).toHaveValue("off", { timeout: 20_000 });

			await navigateToHash(page, `#/session/${sessionId}`);
			const muted = await finishSourceSessionTurn(page, sessionId, "PROJECT_SOUND_OFF");
			expect(muted.audioContexts).toBe(0);
			expect(muted.badgeCalls).toBeGreaterThan(0);

			await navigateToHash(page, `#/settings/${projectId}/general`);
			const bell = page.locator('bell-toggle button[title="Mute agent finish beeps"]').first();
			const globalSave = page.waitForResponse(response =>
				response.request().method() === "PUT" && response.url().endsWith("/api/preferences"),
			);
			await bell.click();
			expect((await globalSave).request().postDataJSON()).toEqual({ playAgentFinishSound: false });
			await selectProjectSound(page, projectId, "on");

			await navigateToHash(page, `#/session/${sessionId}`);
			const forcedOn = await finishSourceSessionTurn(page, sessionId, "PROJECT_SOUND_ON");
			expect(forcedOn.audioContexts).toBeGreaterThan(0);

			await navigateToHash(page, `#/settings/${projectId}/general`);
			await selectProjectSound(page, projectId, "inherit");
			const raw = await (await apiFetch(`/api/projects/${projectId}/config`)).json();
			expect(raw).not.toHaveProperty(PROJECT_SOUND_KEY);
		} finally {
			if (sessionId) await deleteSession(sessionId).catch(() => {});
			if (projectId) await deleteProject(projectId);
			await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ playAgentFinishSound: originalGlobal ?? null }),
			}).catch(() => {});
			const cleanup = await awaitableRm(rootPath);
			expect(cleanup.removed, `project sound fixture cleanup failed after ${cleanup.attempts} attempts`).toBe(true);
		}
	});

	test("Add Project routes a non-configured directory into a provisional assistant", async ({ page }) => {
		test.setTimeout(120_000);
		const dir = uniqueProjectDir();
		let projectId = "";
		let sessionId = "";
		writeFileSync(join(dir, "package.json"), `{"name":"v2-provisional-${Date.now()}"}`);
		try {
			await openApp(page);
			await page.getByRole("button", { name: /Add Project/ }).first().click();
			const pathInput = page.locator('input[placeholder="/path/to/project"]');
			await pathInput.fill(dir);
			await page.getByRole("button", { name: "Continue", exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 15_000 }).toMatch(/^#\/session\//);
			sessionId = (await page.evaluate(() => window.location.hash)).replace(/^#\/session\//, "");
			const sessionResponse = await apiFetch(`/api/sessions/${sessionId}`);
			projectId = String((await sessionResponse.json()).projectId ?? "");
			expect(projectId).not.toBe("");
			await expect(page.locator(".sidebar-edge").getByText("(setting up)").first()).toBeVisible({ timeout: 20_000 });
		} finally {
			if (sessionId) await deleteSession(sessionId).catch(() => {});
			if (!projectId) {
				const response = await apiFetch("/api/projects");
				const body = await response.json();
				projectId = String((body.projects || body || []).find((project: any) => project.rootPath === dir)?.id ?? "");
			}
			if (projectId) await deleteProject(projectId);
			const cleanup = await awaitableRm(dir);
			expect(cleanup.removed, `provisional project fixture cleanup failed after ${cleanup.attempts} attempts`).toBe(true);
		}
	});
});
