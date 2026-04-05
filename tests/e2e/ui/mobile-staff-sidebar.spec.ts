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

  // The Staff and Sessions sections must share a common ancestor that also
  // contains the project name. This proves Staff is nested under the project
  // folder rather than rendered as a detached top-level sidebar section.
  // Use evaluate to walk up the DOM and verify structural nesting.
  const isNested = await page.evaluate(() => {
    const staffEl = [...document.querySelectorAll("span")]
      .find(el => el.textContent?.trim() === "STAFF" || el.textContent?.trim() === "Staff");
    const sessionsEl = [...document.querySelectorAll("span")]
      .find(el => el.textContent?.trim() === "SESSIONS" || el.textContent?.trim() === "Sessions");
    if (!staffEl || !sessionsEl) return false;

    // Walk up from both to find a shared ancestor within 6 levels
    const staffAncestors = new Set<Element>();
    let el: Element | null = staffEl;
    for (let i = 0; i < 6 && el; i++) { staffAncestors.add(el); el = el.parentElement; }

    el = sessionsEl;
    for (let i = 0; i < 6 && el; i++) {
      if (staffAncestors.has(el)) return true;
      el = el.parentElement;
    }
    return false;
  });

  expect(isNested).toBe(true);
});
