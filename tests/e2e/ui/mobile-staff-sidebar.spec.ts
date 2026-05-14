import { test, expect } from "../gateway-harness.js";
import { openApp } from "./ui-helpers.js";
import { apiFetch, defaultProjectId } from "../e2e-setup.js";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test.use({ viewport: { width: 375, height: 667 } });

/**
 * Post surface-staff-in-sessions: staff render as rows inside the project's
 * Sessions list (NOT in a separate "Staff" sub-section). This test asserts a
 * freshly-created staff agent appears with the staff name inside the project's
 * Sessions bucket on mobile.
 */
test("staff appears inside the project's Sessions list on mobile", async ({ page }) => {
  // Staff creation needs a git repo for worktree setup — create a temp one
  const gitDir = join(tmpdir(), `bobbit-e2e-staff-git-${Date.now()}`);
  mkdirSync(gitDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: gitDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init", "--allow-empty"], { cwd: gitDir, stdio: "pipe" });

  const pid = await defaultProjectId();
  expect(pid).toBeTruthy();

  // Create a staff agent so the staff row renders
  const staffName = `MobileBot${Date.now()}`;
  const res = await apiFetch("/api/staff", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: staffName, systemPrompt: "You are a test bot.", cwd: gitDir, projectId: pid }),
  });
  expect(res.ok).toBe(true);

  await openApp(page);

  // The staff row should appear under a Sessions header in the same project bucket.
  await expect(page.getByText(staffName, { exact: false }).first()).toBeVisible({ timeout: 15_000 });

  // Assert the staff row shares a common ancestor with the project's "Sessions"
  // sub-header within 8 levels — i.e. it is folded INTO Sessions, not split out.
  const sharedAncestor = await page.evaluate((name) => {
    const titleEls = [...document.querySelectorAll("span")]
      .filter((el) => (el.textContent || "").includes(name));
    if (titleEls.length === 0) return false;
    const sessionsEl = [...document.querySelectorAll("span")]
      .find((el) => {
        const t = el.textContent?.trim();
        return t === "SESSIONS" || t === "Sessions";
      });
    if (!sessionsEl) return false;
    const sessionAncestors = new Set<Element>();
    let el: Element | null = sessionsEl;
    for (let i = 0; i < 8 && el; i++) { sessionAncestors.add(el); el = el.parentElement; }
    for (const titleEl of titleEls) {
      let cur: Element | null = titleEl;
      for (let i = 0; i < 8 && cur; i++) {
        if (sessionAncestors.has(cur)) return true;
        cur = cur.parentElement;
      }
    }
    return false;
  }, staffName);

  expect(sharedAncestor).toBe(true);

  // Cleanup
  const list = (await (await apiFetch(`/api/staff?projectId=${encodeURIComponent(pid!)}`)).json()) as any;
  const created = (list.staff as any[]).find((s) => s.name === staffName);
  if (created) await apiFetch(`/api/staff/${created.id}`, { method: "DELETE" }).catch(() => {});
});
