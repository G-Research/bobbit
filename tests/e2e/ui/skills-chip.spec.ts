/**
 * Browser E2E tests for the skill-chip UI (Skill UX & Autonomous Activation).
 *
 * Covers (per AGENTS.md E2E coverage requirement):
 *   1. navigation       — open app + create session
 *   2. happy path       — typing /<skill> shows literal text + chip; click expands body
 *   3. autonomous       — `activate_skill` tool_use renders as a `<skill-chip>`
 *   4. persistence      — chips survive a page reload (replay from sidecar)
 *   5. cleanup/legacy   — old user message without `skillExpansions` renders plain
 *
 * NOTE: This test depends on the server-side producer that snapshots
 * `skillExpansions` into the broadcast user message and the
 * `activate_skill` tool result. It is intended to be run only after the
 * server-side branch for goal `skill-ux-a-9c9dea99` has been merged into
 * the goal branch. When run against an older server it will fail at the
 * "chip visible" step \u2014 that is the intended signal that the server
 * change has not landed yet.
 */
import { test, expect } from "../gateway-harness.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiFetch, nonGitCwd } from "../e2e-setup.js";
import { openApp, sendMessage } from "./ui-helpers.js";

const SKILL_NAME = "ui-chip-skill";
const SKILL_BODY_MARKER = "SKILL_CHIP_E2E_MARKER_BODY";

/** Create a SKILL.md fixture in the given cwd so the server can resolve `/<name>`. */
function writeFixtureSkill(cwd: string) {
	const dir = join(cwd, ".claude", "skills", SKILL_NAME);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\ndescription: UI chip E2E fixture skill\n---\n\n# ${SKILL_BODY_MARKER}\n\nThis is the snapshotted skill body. $ARGUMENTS\n`,
	);
}

/** Locator: the user-message bubble in the chat. */
function userBubble(page: import("@playwright/test").Page) {
	return page.locator("user-message").first();
}

/** Locator: a SkillChip element anywhere on the page. */
function skillChip(page: import("@playwright/test").Page) {
	return page.locator("skill-chip").first();
}

test.describe("skill-chip UI", () => {
	test("typing /<skill> shows literal text + clickable chip; expansion toggles", async ({ page }) => {
		const cwd = nonGitCwd();
		writeFixtureSkill(cwd);

		// Create a session bound to the cwd that has the skill fixture.
		const created = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd }),
		});
		const { id: sessionId } = await created.json();
		expect(sessionId).toBeTruthy();

		await openApp(page);
		// Navigate to the session via hash route.
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });

		// Send a slash invocation with arguments.
		await sendMessage(page, `/${SKILL_NAME} some-arg`);

		// (1) bubble shows the literal user text \u2014 NOT the expanded body.
		await expect(userBubble(page)).toBeVisible({ timeout: 15_000 });
		await expect(userBubble(page)).toContainText(`/${SKILL_NAME} some-arg`, { timeout: 15_000 });
		await expect(userBubble(page)).not.toContainText(SKILL_BODY_MARKER);

		// (2) chip is rendered as part of the user bubble.
		const chip = skillChip(page);
		await expect(chip).toBeVisible({ timeout: 15_000 });

		// Expansion is collapsed by default \u2014 body marker not visible.
		await expect(page.getByText(SKILL_BODY_MARKER).first()).toHaveCount(0);

		// Click the chip pill to expand.
		await chip.locator(".skill-chip-pill").first().click();
		await expect(page.getByText(SKILL_BODY_MARKER).first()).toBeVisible({ timeout: 5_000 });

		// (3) reload \u2014 chip + literal text persist (replay from sidecar).
		await page.reload();
		await expect(userBubble(page)).toBeVisible({ timeout: 20_000 });
		await expect(userBubble(page)).toContainText(`/${SKILL_NAME} some-arg`);
		await expect(skillChip(page)).toBeVisible({ timeout: 10_000 });
	});

	test("legacy user message without skillExpansions renders as plain text", async ({ page }) => {
		await openApp(page);
		// Create a fresh session and send a message that does NOT match a skill.
		await page.locator("button[title^='New session']").first().click();
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });

		await sendMessage(page, "this is a normal message with no slash command");

		await expect(userBubble(page)).toBeVisible({ timeout: 15_000 });
		await expect(userBubble(page)).toContainText("this is a normal message");
		// No chip should render for messages without expansions.
		await expect(page.locator("skill-chip")).toHaveCount(0);
	});

	test("activate_skill tool_use renders as a skill-chip in tool card", async ({ page }) => {
		// The mock agent's `activate_skill` branch is server-side; if the
		// server doesn't expose the tool yet (pre-merge), this test will
		// fail at the chip locator \u2014 that's the intended signal.
		const cwd = nonGitCwd();
		writeFixtureSkill(cwd);

		const created = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd }),
		});
		const { id: sessionId } = await created.json();

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });

		// The mock agent recognises a "please activate_skill <name>" trigger
		// (server-side branch). If it's not implemented, the test fails here.
		await sendMessage(page, `please activate_skill ${SKILL_NAME}`);

		const chip = skillChip(page);
		await expect(chip).toBeVisible({ timeout: 20_000 });
		// The chip's label is `/<name>`.
		await expect(chip).toContainText(`/${SKILL_NAME}`);

		// Click to expand.
		await chip.locator(".skill-chip-pill").first().click();
		await expect(page.getByText(SKILL_BODY_MARKER).first()).toBeVisible({ timeout: 5_000 });
	});
});
