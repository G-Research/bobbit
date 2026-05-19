/**
 * E2E - Proposal Revision Snapshots.
 *
 * docs/design/proposal-revision-snapshots.md
 *
 * 1. Navigate - trigger propose_project + edit_proposal; verify two cards in
 *    the transcript and that the slot reflects the latest revision.
 * 2. Happy path - click "Open proposal" on the FIRST card; the panel
 *    rebuilds with rev-1 fields and the rev counter increments
 *    monotonically (rev 3 = restore of rev 1).
 * 3. Persistence - reload; the slot rehydrates and earlier-card clicks
 *    still work.
 * 4. Cleanup - terminate the session; on-disk drafts (incl. history) are
 *    wiped.
 */
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, bobbitDir } from "../e2e-setup.js";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

async function getDefaultProjectId(): Promise<string> {
	const resp = await apiFetch("/api/projects");
	const data = await resp.json();
	const projects = Array.isArray(data) ? data : (data.projects || []);
	expect(projects.length).toBeGreaterThan(0);
	return projects[0].id;
}

async function activeSessionId(page: import("@playwright/test").Page): Promise<string> {
	// Wait for the selected session id to land in state. This used to read
	// `bobbitState.activeSessionId` (which never existed — it's a function,
	// not a property) and fell back to `gatewaySessions[0]?.id`. After Task A
	// (route-level code splitting) the initial sessions list fetch races with
	// createSessionViaUI()'s textarea-visible signal, so gatewaySessions is
	// briefly empty even though the hash route already points at the new
	// session. selectedSessionId is set synchronously by the route handler
	// and is the source of truth used by every other parity spec. See
	// proposal-types-uX-parity.spec.ts:135 for the canonical pattern.
	const sid = await page.waitForFunction(
		() => (window as any).bobbitState?.selectedSessionId ?? null,
		null,
		{ timeout: 10_000 },
	).then((handle) => handle.jsonValue() as Promise<string | null>);
	expect(sid).toBeTruthy();
	return sid as string;
}

test.describe("Proposal revision snapshots", () => {
	test("propose + edit + open-old card restores via snapshot, rev counter monotonic", async ({ page }) => {
		const projectId = await getDefaultProjectId();
		await apiFetch(`/api/projects/${projectId}/config`, {
			method: "PUT",
			body: JSON.stringify({ build_command: "baseline-build" }),
		});

		await openApp(page);
		await createSessionViaUI(page);

		// Capture the session id BEFORE the workflow proceeds. The on-disk
		// proposal-drafts dir is keyed by this id; reload should not change it.
		const sid = await activeSessionId(page);

		// 1. Navigate - propose then edit.
		await sendMessage(page, "EDITABLE_PROPOSAL_INITIAL");
		await page.waitForFunction(
			() => (window as any).bobbitState?.activeProposals?.project?.fields?.build_command === "echo old",
			null,
			{ timeout: 20_000 },
		);

		await sendMessage(page, "EDITABLE_PROPOSAL_EDIT");
		await page.waitForFunction(
			() => (window as any).bobbitState?.activeProposals?.project?.fields?.build_command === "echo new",
			null,
			{ timeout: 15_000 },
		);

		// Slot rev should now be 2 (server-stamped).
		const revAfterEdit = await page.evaluate(
			() => (window as any).bobbitState?.activeProposals?.project?.rev,
		);
		expect(revAfterEdit).toBe(2);

		// Two "Open proposal" buttons should exist (one per card).
		const openButtons = page.locator('[data-testid="proposal-open-button"]');
		await expect(openButtons).toHaveCount(2, { timeout: 15_000 });

		// 2. Happy path - click the FIRST card's button (rev 1).
		await openButtons.first().click();

		// Slot flips back to "echo old", rev becomes 3 (restore writes new snapshot).
		await page.waitForFunction(
			() => {
				const slot = (window as any).bobbitState?.activeProposals?.project;
				return slot?.fields?.build_command === "echo old" && slot?.rev === 3;
			},
			null,
			{ timeout: 15_000 },
		);

		// 3. Persistence - reload; slot rehydrates with the latest rev (3).
		await page.reload();
		await page.waitForFunction(
			() => {
				const slot = (window as any).bobbitState?.activeProposals?.project;
				return slot?.fields?.build_command === "echo old" && slot?.rev === 3;
			},
			null,
			{ timeout: 20_000 },
		);

		// On-disk: history dir contains revs 1-3.
		const stateDir = path.join(bobbitDir(), "state");
		const histDir = path.join(stateDir, "proposal-drafts", sid, "project.history");
		await expect.poll(() => fs.existsSync(histDir), { timeout: 10_000 }).toBe(true);
		await expect.poll(
			() => fs.readdirSync(histDir)
				.filter((e) => /^\d+\.yaml$/.test(e))
				.map((e) => Number.parseInt(e, 10))
				.sort((a, b) => a - b),
			{ timeout: 10_000 },
		).toEqual([1, 2, 3]);

		// 4. Cleanup - terminate (archive) the session.
		// Per the reopen-archived-proposals design, the per-session draft dir
		// now SURVIVES archive (so the user can resubmit / continue later) and
		// is only removed on full purge (the 7-day mark). Smoke-check that the
		// dir is still present right after archive.
		await apiFetch(`/api/sessions/${sid}`, { method: "DELETE" }).catch(() => {});
		const sessionDir = path.join(stateDir, "proposal-drafts", sid);
		expect(fs.existsSync(sessionDir)).toBe(true);
	});
});
