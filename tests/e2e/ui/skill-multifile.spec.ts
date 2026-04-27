/**
 * Browser E2E for multi-file skills (Claude Code skill parity).
 *
 * Verifies:
 *   1. Activating a multi-file skill via /<name> renders a chip in the
 *      user-message bubble.
 *   2. The chip's expanded body does NOT show the activation-header fence
 *      (the fence is for the model only — UI strips it).
 *   3. The model-facing `expanded` (server-side) DOES include the header
 *      with the skill root and the resource manifest (references/,
 *      scripts/, assets/) — verified via REST.
 *   4. Reload preserves the chip (sidecar replay).
 */
import { test, expect } from "../gateway-harness.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiFetch, nonGitCwd } from "../e2e-setup.js";
import { openApp, sendMessage } from "./ui-helpers.js";

const SKILL_NAME = "multi-file-skill";
const BODY_MARKER = "MULTI_FILE_BODY_MARKER";
const HEADER_MARKER = "skill-activation-header";

function writeFixtureSkill(cwd: string) {
	const dir = join(cwd, ".claude", "skills", SKILL_NAME);
	mkdirSync(join(dir, "references"), { recursive: true });
	mkdirSync(join(dir, "scripts"), { recursive: true });
	mkdirSync(join(dir, "assets"), { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\ndescription: Multi-file fixture skill\n---\n\n# ${BODY_MARKER}\n\nUse @references/REFERENCE.md when needed.\n`,
	);
	writeFileSync(join(dir, "references", "REFERENCE.md"), "REFERENCE-CONTENT", "utf-8");
	writeFileSync(join(dir, "scripts", "hello.sh"), "#!/bin/sh\necho hello\n", "utf-8");
	writeFileSync(join(dir, "assets", "template.txt"), "TEMPLATE", "utf-8");
}

function userBubble(page: import("@playwright/test").Page) {
	return page.locator("user-message").first();
}

function skillChip(page: import("@playwright/test").Page) {
	return page.locator("skill-chip").first();
}

test.describe("multi-file skill activation", () => {
	test("chip renders without activation-header fence; server includes header + resource manifest; reload preserves", async ({ page }) => {
		const cwd = nonGitCwd();
		writeFixtureSkill(cwd);

		const created = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd }),
		});
		const { id: sessionId } = await created.json();
		expect(sessionId).toBeTruthy();

		// (A) Server-side activate-skill REST returns the header WITH the resource manifest.
		const activated = await apiFetch(`/api/sessions/${sessionId}/activate-skill`, {
			method: "POST",
			body: JSON.stringify({ name: SKILL_NAME }),
		});
		expect(activated.status).toBe(200);
		const data = await activated.json() as { expanded: string; filePath: string };
		expect(data.expanded).toContain("<!-- skill-activation-header -->");
		expect(data.expanded).toContain("Skill root: ");
		expect(data.expanded).toMatch(/Available resources: assets\/template\.txt, references\/REFERENCE\.md, scripts\/hello\.sh/);
		expect(data.expanded).toContain(BODY_MARKER);
		// `@references/REFERENCE.md` must reach the agent verbatim — NOT inlined.
		expect(data.expanded).toContain("@references/REFERENCE.md");
		expect(data.expanded).not.toContain("REFERENCE-CONTENT");

		// (B) Open UI and send /<name>; chip should render.
		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });

		await sendMessage(page, `/${SKILL_NAME}`);

		// User bubble shows the literal /name text, not the body marker.
		await expect(userBubble(page)).toBeVisible({ timeout: 15_000 });
		await expect(userBubble(page)).toContainText(`/${SKILL_NAME}`);
		await expect(userBubble(page)).not.toContainText(BODY_MARKER);

		// Chip is rendered.
		const chip = skillChip(page);
		await expect(chip).toBeVisible({ timeout: 15_000 });

		// Click chip to expand the disclosure.
		await chip.locator(".skill-chip-pill").first().click();

		// (C) Disclosure body shows BODY_MARKER, but NOT the activation-header fence.
		const expansion = chip.locator(".skill-chip-expansion").first();
		await expect(expansion).toBeVisible({ timeout: 5_000 });
		await expect(expansion).toContainText(BODY_MARKER);
		const expansionText = (await expansion.textContent()) || "";
		expect(expansionText).not.toContain(HEADER_MARKER);
		expect(expansionText).not.toContain("Skill root:");

		// (D) Reload preserves chip.
		await page.reload();
		// Re-assert the session route after reload — some sidebar layouts can
		// land on a different default view depending on init order.
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
		await expect(userBubble(page)).toBeVisible({ timeout: 20_000 });
		await expect(userBubble(page)).toContainText(`/${SKILL_NAME}`);
		await expect(skillChip(page)).toBeVisible({ timeout: 10_000 });

		// (E) Follow-up turn: the agent uses the path from the activation
		// header to read `references/REFERENCE.md`. AC#5 — proves the header's
		// path manifest actually enables end-to-end file reads.
		//
		// Extract the skill root the model would have seen from the
		// REST-side `expanded` we captured in step (A). The mock agent's
		// `respondToPrompt("use the read ...")` branch extracts an absolute
		// path from the prompt text and emits a Read tool call — standing in
		// for a real agent that would resolve `references/REFERENCE.md`
		// against the absolute root from the activation header.
		const rootMatch = data.expanded.match(/Skill root:\s+(.+)/);
		expect(rootMatch).not.toBeNull();
		const skillRoot = rootMatch![1].trim();
		const refPath = `${skillRoot}/references/REFERENCE.md`;

		await sendMessage(page, `Use the Read tool to read the file ${refPath}`);

		// The agent emits a Read tool_use whose input.path matches the
		// reference file under the activation-header skill root, and the tool
		// result returns the file content.
		await expect(
			page.getByText("Done. Used Read tool.").first(),
		).toBeVisible({ timeout: 20_000 });
		await expect(
			page.getByText("READ_THIS_CONTENT_E2E").first(),
		).toBeVisible({ timeout: 5_000 });
		// Path round-trip: the rendered tool input contains the references/
		// path the agent resolved against the activation-header skill root.
		await expect(
			page.locator("code").filter({ hasText: "references/REFERENCE.md" }).first(),
		).toBeVisible({ timeout: 5_000 });
	});
});
