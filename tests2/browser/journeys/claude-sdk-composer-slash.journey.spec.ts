/**
 * Journey: Claude SDK composer slash interception.
 *
 * The production ClaudeAgentSdkBridge runs unchanged; this journey replaces only
 * its official Query dependency so the exact text that reaches the SDK is
 * deterministic and inspectable.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, apiFetch, createSession, deleteSession, openApp, navigateToHash, registerProject, waitForSessionStatus } from "../_helpers/journey-fixture.js";

const SDK_PROVIDER = "claude-agent-sdk";
const SDK_MODEL = "sonnet";
const SDK_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const PACK = "pr-walkthrough";

const deliveredPrompts: string[] = [];

type SdkQueryArgs = { prompt: AsyncIterable<unknown>; options: Record<string, unknown> };

/** A pull-driven Query that records SDK user messages and promptly ends each turn. */
class FakeSdkQuery implements AsyncIterable<unknown> {
	private closed = false;
	private reader?: (value: IteratorResult<unknown>) => void;
	private queued: unknown[] = [];

	constructor(readonly args: SdkQueryArgs) {
		this.queued.push({ type: "system", subtype: "init", session_id: SDK_SESSION_ID });
		void this.recordPrompts();
	}

	private async recordPrompts(): Promise<void> {
		for await (const message of this.args.prompt) {
			const content = (message as any)?.message?.content;
			deliveredPrompts.push(typeof content === "string" ? content : JSON.stringify(content));
			// Let the production bridge return to ready before the next UI action.
			this.emit({ type: "result", subtype: "success", result: "OK" });
		}
	}

	async initializationResult(): Promise<Record<string, never>> { return {}; }
	async interrupt(): Promise<void> {}
	async setModel(): Promise<void> {}
	async setMaxThinkingTokens(): Promise<void> {}
	async close(): Promise<void> {
		this.closed = true;
		this.reader?.({ done: true, value: undefined });
		this.reader = undefined;
	}

	private emit(value: unknown): void {
		const reader = this.reader;
		if (reader) {
			this.reader = undefined;
			reader({ done: false, value });
		} else {
			this.queued.push(value);
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<unknown> {
		return {
			next: () => {
				if (this.closed) return Promise.resolve({ done: true, value: undefined });
				const next = this.queued.shift();
				if (next !== undefined) return Promise.resolve({ done: false, value: next });
				return new Promise<IteratorResult<unknown>>((resolve) => {
					this.reader = resolve;
				});
			},
		};
	}
}

test.use({
	claudeAgentSdkBridgeDepsFactory: {
		create: () => ({
			query: ((args: SdkQueryArgs) => new FakeSdkQuery(args)) as any,
			clock: {
				now: () => Date.now(),
				setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
				clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
				setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
				clearInterval: (handle: ReturnType<typeof setInterval>) => clearInterval(handle),
			},
		}),
	},
});

const editor = (page: Page) => page.locator("message-editor textarea").first();

async function chooseSdkDefault(): Promise<void> {
	const preferences = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({
			"default.sessionModel": `${SDK_PROVIDER}/${SDK_MODEL}`,
			"default.sessionThinkingLevel": "off",
		}),
	});
	expect(preferences.ok, await preferences.text()).toBeTruthy();
}

async function setPackEnabled(enabled: boolean): Promise<void> {
	const response = await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK, disabled: enabled ? { enabled: true } : {} }),
	});
	expect(response.ok, await response.text()).toBeTruthy();
}

async function expectSdkPrompt(index: number, expected: string | RegExp): Promise<void> {
	await expect.poll(() => deliveredPrompts[index], { timeout: 15_000 }).toBeDefined();
	if (typeof expected === "string") expect(deliveredPrompts[index]).toBe(expected);
	else expect(deliveredPrompts[index]).toMatch(expected);
}

test.describe("Journey: Claude SDK composer slash interception", () => {
	test("intercepts Bobbit controls and launchers before the SDK, then reconciles the menu across reload and project switch", async ({ page }) => {
		test.setTimeout(60_000);
		deliveredPrompts.length = 0;
		const root = mkdtempSync(join(tmpdir(), "bobbit-sdk-composer-slash-"));
		const skillRoot = join(root, "with-skill");
		const emptyRoot = join(root, "without-skill");
		let skillProjectId = "";
		let emptyProjectId = "";
		let skillSessionId = "";
		let emptySessionId = "";
		const originalPreferences = await (await apiFetch("/api/preferences")).json() as Record<string, unknown>;
		try {
			mkdirSync(join(skillRoot, ".bobbit", "skills", "goal"), { recursive: true });
			mkdirSync(emptyRoot, { recursive: true });
			writeFileSync(join(skillRoot, ".bobbit", "skills", "goal", "SKILL.md"), [
				"---",
				"name: goal",
				"description: Browser-owned Bobbit goal skill",
				"---",
				"GOAL SKILL BODY: expand before the Claude SDK receives this prompt.",
				"",
			].join("\n"));

			const skillProject = await registerProject({ name: `sdk-composer-skill-${Date.now()}`, rootPath: skillRoot });
			const emptyProject = await registerProject({ name: `sdk-composer-empty-${Date.now()}`, rootPath: emptyRoot });
			skillProjectId = skillProject.id as string;
			emptyProjectId = emptyProject.id as string;
			await chooseSdkDefault();
			await setPackEnabled(true);

			skillSessionId = await createSession({ cwd: skillRoot, projectId: skillProjectId });
			emptySessionId = await createSession({ cwd: emptyRoot, projectId: emptyProjectId });
			await waitForSessionStatus(skillSessionId, "idle");
			await waitForSessionStatus(emptySessionId, "idle");

			await openApp(page);
			await navigateToHash(page, `#/session/${skillSessionId}`);
			await expect(editor(page)).toBeVisible({ timeout: 20_000 });

			// Claude sessions show Bobbit skills and active pack launchers, but reserve
			// /compact without exposing it to Claude's bundled command inventory.
			await editor(page).fill("/");
			await expect(page.getByTestId("slash-command-goal")).toBeVisible({ timeout: 15_000 });
			await expect(page.getByTestId("slash-command-pr-walkthrough")).toBeVisible({ timeout: 15_000 });
			await expect(page.getByTestId("slash-command-compact")).toHaveCount(0);

			// Autocomplete only completes the Bobbit skill; server expansion, not the
			// raw /goal token, is what the production SDK bridge receives.
			await editor(page).fill("/go");
			await page.getByTestId("slash-command-goal").click();
			await expect(editor(page)).toHaveValue("/goal ");
			await editor(page).fill("/goal ship safely");
			await editor(page).press("Escape");
			await editor(page).press("Enter");
			await expectSdkPrompt(0, /GOAL SKILL BODY[\s\S]*ship safely/);
			expect(deliveredPrompts[0]).not.toBe("/goal ship safely");

			// A Claude-native/unknown slash is not invented by Bobbit and stays an
			// ordinary SDK prompt.
			await editor(page).fill("/review raw runtime command");
			await editor(page).press("Escape");
			await editor(page).press("Enter");
			await expectSdkPrompt(1, "/review raw runtime command");

			// The exact SDK /compact reservation neither clears nor delivers the draft.
			await editor(page).fill("/compact");
			await editor(page).press("Enter");
			await expect(page.getByRole("alert")).toContainText("Manual compaction isn’t available for Claude Agent SDK sessions.");
			await expect(editor(page)).toHaveValue("/compact");
			await expect(editor(page)).toBeFocused();
			expect(deliveredPrompts).toHaveLength(2);

			// Ctrl+Enter ordinarily takes the raw STEER path. The hidden reservation
			// must still consume exact /compact locally before it reaches the SDK.
			await editor(page).fill("/compact");
			await editor(page).press("Control+Enter");
			await expect(page.getByRole("alert")).toContainText("Manual compaction isn’t available for Claude Agent SDK sessions.");
			await expect(editor(page)).toHaveValue("/compact");
			await expect(editor(page)).toBeFocused();
			expect(deliveredPrompts).toHaveLength(2);

			// A Bobbit-owned skill cannot be raw-steered to the SDK. Ctrl+Enter
			// preserves the draft and tells the user to submit it through the normal
			// server expansion path instead.
			await editor(page).fill("/goal steer safely");
			await editor(page).press("Control+Enter");
			await expect(page.getByRole("alert")).toContainText("Slash commands can’t be sent as steers. Press Enter to send a normal prompt.");
			await expect(editor(page)).toHaveValue("/goal steer safely");
			await expect(editor(page)).toBeFocused();
			expect(deliveredPrompts).toHaveLength(2);

			// A reconciled pack launcher consumes the composer command via its pack
			// route rather than adding an SDK prompt.
			await editor(page).fill("/pr-walkthrough");
			await editor(page).press("Escape");
			const packRoute = page.waitForRequest((request) => request.url().includes("/api/ext/route/run") && request.method() === "POST");
			await editor(page).press("Enter");
			await packRoute;
			expect(deliveredPrompts).toHaveLength(2);

			// Reload repeats current-session discovery; menu inventory is never draft
			// state and remains scoped to the active project.
			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToHash(page, `#/session/${skillSessionId}`);
			await expect(editor(page)).toBeVisible({ timeout: 20_000 });
			await editor(page).fill("/go");
			await expect(page.getByTestId("slash-command-goal")).toBeVisible({ timeout: 15_000 });

			await navigateToHash(page, `#/session/${emptySessionId}`);
			await expect(editor(page)).toBeVisible({ timeout: 20_000 });
			await editor(page).fill("/go");
			await expect(page.getByTestId("slash-command-goal")).toHaveCount(0);
			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToHash(page, `#/session/${emptySessionId}`);
			await expect(editor(page)).toBeVisible({ timeout: 20_000 });
			await editor(page).fill("/go");
			await expect(page.getByTestId("slash-command-goal")).toHaveCount(0);
		} finally {
			if (skillSessionId) await deleteSession(skillSessionId).catch(() => undefined);
			if (emptySessionId) await deleteSession(emptySessionId).catch(() => undefined);
			if (skillProjectId) await apiFetch(`/api/projects/${skillProjectId}`, { method: "DELETE" }).catch(() => undefined);
			if (emptyProjectId) await apiFetch(`/api/projects/${emptyProjectId}`, { method: "DELETE" }).catch(() => undefined);
			await setPackEnabled(false).catch(() => undefined);
			await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({
					"default.sessionModel": originalPreferences["default.sessionModel"] ?? null,
					"default.sessionThinkingLevel": originalPreferences["default.sessionThinkingLevel"] ?? null,
				}),
			}).catch(() => undefined);
			rmSync(root, { recursive: true, force: true });
		}
	});
});
