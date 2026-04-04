import { test, expect } from "../gateway-harness.js";
import { openApp } from "./ui-helpers.js";
import { apiFetch } from "../e2e-setup.js";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test.use({ viewport: { width: 375, height: 667 } });

test("staff section is nested inside project folder on mobile", async ({ page }) => {
  // Staff creation needs a git repo for worktree setup — create a temp one
  const gitDir = join(tmpdir(), `bobbit-e2e-staff-git-${Date.now()}`);
  mkdirSync(gitDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: gitDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init", "--allow-empty"], { cwd: gitDir, stdio: "pipe" });

  // Create a staff agent so the staff section renders
  const res = await apiFetch("/api/staff", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Test Bot", systemPrompt: "You are a test bot.", cwd: gitDir }),
  });
  expect(res.ok).toBe(true);

  await openApp(page);

  // Wait for the Staff section to be visible
  const staffText = page.locator("span.uppercase").filter({ hasText: "Staff" });
  await expect(staffText.first()).toBeVisible({ timeout: 10000 });

  // The project folder's expanded content is wrapped in a div with padding-left style
  // On mobile, the bug causes the Staff section to be OUTSIDE this div
  // The correct behavior is Staff section INSIDE the project content div
  const projectContentDiv = page.locator('div[style*="padding-left"]').first();
  await expect(projectContentDiv).toBeVisible();

  // Assert: Staff section should be a descendant of the project content div
  const staffInsideProject = projectContentDiv.locator("span.uppercase").filter({ hasText: "Staff" });
  await expect(staffInsideProject).toBeVisible({ timeout: 5000 });
});
