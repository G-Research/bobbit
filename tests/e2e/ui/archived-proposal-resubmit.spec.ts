/**
 * Browser E2E — Reopen Archived Proposals.
 *
 * Path A (in-place resubmit): archived sessions whose `proposal-drafts/<id>/`
 * directory is non-empty surface a "Resubmit <type> proposal" button alongside
 * the existing "Continue in new session" button.
 *
 * Path B (continue assistant): archived assistant sessions can now be
 * continued; the cloned draft is preserved across navigation and reload.
 *
 * Path B fallback: archived assistant with no drafts shows only the legacy
 * "Continue in new session" button.
 */
import { test, expect } from "../gateway-harness.js";
import {
	apiFetch,
	createSession,
	deleteSession,
	nonGitCwd,
	waitForSessionStatus,
	connectWs,
	agentEndPredicate,
} from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

async function primeTranscript(id: string, text: string): Promise<void> {
	const ws = await connectWs(id);
	try {
		ws.send({ type: "prompt", text });
		await ws.waitFor(agentEndPredicate(), 15_000);
	} finally {
		ws.close();
	}
}

async function seedGoalDraft(sid: string, fields: Record<string, unknown>): Promise<void> {
	const resp = await apiFetch(`/api/sessions/${sid}/proposal/goal/seed`, {
		method: "POST",
		body: JSON.stringify({ args: fields }),
	});
	expect(resp.status, `seed goal draft for ${sid}`).toBe(200);
}

async function seedRoleDraft(sid: string, fields: Record<string, unknown>): Promise<void> {
	const resp = await apiFetch(`/api/sessions/${sid}/proposal/role/seed`, {
		method: "POST",
		body: JSON.stringify({ args: fields }),
	});
	expect(resp.status, `seed role draft for ${sid}`).toBe(200);
}

async function createAssistantSession(assistantType: string): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: nonGitCwd(), assistantType }),
	});
	expect(resp.status, `create ${assistantType} assistant`).toBe(201);
	return (await resp.json()).id as string;
}

async function archive(id: string): Promise<void> {
	await apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
}

async function listProposals(sid: string): Promise<string[]> {
	const r = await apiFetch(`/api/sessions/${sid}/proposals`);
	if (!r.ok) return [];
	const data = await r.json();
	return Array.isArray(data?.proposals)
		? data.proposals.map((p: any) => p.proposalType)
		: [];
}

test.describe("Reopen Archived Proposals — UI", () => {
	test("Path A non-assistant: archived session with goal draft surfaces Resubmit button", async ({ page }) => {
		const sid = await createSession();
		await waitForSessionStatus(sid, "idle");
		await primeTranscript(sid, "hello");
		await waitForSessionStatus(sid, "idle");
		await seedGoalDraft(sid, {
			title: "Resubmit me",
			spec: "This is a polished spec ready for resubmit.\n",
			workflow: "feature",
		});
		await archive(sid);

		await openApp(page);
		await navigateToHash(page, `#/session/${sid}`);

		const footer = page.locator("[data-continue-archived-footer]");
		await expect(footer).toBeVisible({ timeout: 15_000 });

		const resubmit = footer.locator("[data-action='resubmit-proposal']");
		await expect(resubmit).toBeVisible({ timeout: 10_000 });
		await expect(resubmit).toHaveAttribute("data-proposal-type", "goal");

		const continueBtn = footer.locator("[data-action='continue-archived']");
		await expect(continueBtn).toBeVisible();
	});

	test("Path A assistant (role): footer shows Resubmit button for archived role-assistant", async ({ page }) => {
		const sid = await createAssistantSession("role");
		await waitForSessionStatus(sid, "idle");
		await primeTranscript(sid, "prime role assistant");
		await waitForSessionStatus(sid, "idle");
		await seedRoleDraft(sid, { name: "alpha", label: "Alpha Role", prompt: "do alpha" });
		await archive(sid);

		await openApp(page);
		await navigateToHash(page, `#/session/${sid}`);

		const footer = page.locator("[data-continue-archived-footer]");
		await expect(footer).toBeVisible({ timeout: 15_000 });

		const resubmit = footer.locator("[data-action='resubmit-proposal']");
		await expect(resubmit).toBeVisible({ timeout: 10_000 });
		await expect(resubmit).toHaveAttribute("data-proposal-type", "role");
	});

	test("Path B fallback: assistant with no draft shows only Continue button", async ({ page }) => {
		const sid = await createAssistantSession("goal");
		await waitForSessionStatus(sid, "idle");
		await primeTranscript(sid, "no draft, just chatter");
		await waitForSessionStatus(sid, "idle");
		// Sanity: no draft on disk.
		expect((await listProposals(sid)).length).toBe(0);
		await archive(sid);

		await openApp(page);
		await navigateToHash(page, `#/session/${sid}`);

		const footer = page.locator("[data-continue-archived-footer]");
		await expect(footer).toBeVisible({ timeout: 15_000 });

		await expect(footer.locator("[data-action='continue-archived']")).toBeVisible();
		await expect(footer.locator("[data-action='resubmit-proposal']")).toHaveCount(0);
	});

	test("Path B: continuing an archived assistant carries the proposal draft over", async ({ page }) => {
		const sid = await createAssistantSession("goal");
		await waitForSessionStatus(sid, "idle");
		await primeTranscript(sid, "draft session");
		await waitForSessionStatus(sid, "idle");
		await seedGoalDraft(sid, {
			title: "Carry-Over Title",
			spec: "Spec body to be carried over.\n",
			workflow: "feature",
		});
		await archive(sid);

		await openApp(page);
		await navigateToHash(page, `#/session/${sid}`);

		const footer = page.locator("[data-continue-archived-footer]");
		await expect(footer).toBeVisible({ timeout: 15_000 });
		// The chooser should mention the carry-over.
		await footer.locator("[data-action='continue-archived']").click();
		const chooser = page.locator("continue-session-chooser");
		await expect(chooser).toBeVisible({ timeout: 5_000 });
		await expect(chooser.locator("[data-proposal-carryover]")).toContainText("carried over");

		await chooser.locator("[data-action='continue']").click();

		// URL should change to the new session.
		await page.waitForFunction(
			(oldId) => {
				const h = window.location.hash || "";
				const m = h.match(/^#\/session\/([^/?]+)/);
				return !!m && m[1] !== oldId;
			},
			sid,
			{ timeout: 20_000 },
		);
		const newHash = await page.evaluate(() => window.location.hash);
		const m = newHash.match(/^#\/session\/([^/?]+)/);
		expect(m).toBeTruthy();
		const newId = m![1];
		expect(newId).not.toBe(sid);

		// The new session's proposal draft must mirror the source.
		const newProposals = await listProposals(newId);
		expect(newProposals).toContain("goal");

		// Survive a reload — restart-resume reads the cloned proposal-drafts.
		await page.reload();
		await openApp(page);
		await navigateToHash(page, `#/session/${newId}`);
		const stillThere = await listProposals(newId);
		expect(stillThere).toContain("goal");

		await deleteSession(newId);
	});
});
