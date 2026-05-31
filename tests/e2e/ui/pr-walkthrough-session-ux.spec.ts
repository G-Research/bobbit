import type { Page, Route } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, deleteGoal, startTeam, teardownTeam, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, createSessionViaUI, sendMessage, navigateToHash } from "./ui-helpers.js";

type LaunchJob = {
	jobId: string;
	childSessionId: string;
	parentSessionId: string;
	changesetId: string;
	tabId: string;
	status: string;
	title: string;
	target: { number: number; prUrl: string; canonicalKey: string };
};

const jobsByChildSession = new Map<string, LaunchJob>();
const jobsById = new Map<string, LaunchJob>();

function prUrl(prNumber: string | number): string {
	return `https://github.com/SuuBro/bobbit/pull/${prNumber}`;
}

async function installWalkthroughLaunchFixture(page: Page) {
	jobsByChildSession.clear();
	jobsById.clear();

	const handler = async (route: Route) => {
		const request = route.request();
		const url = new URL(request.url());
		const method = request.method();

		if (url.pathname === "/api/pr-walkthrough/launch" && method === "POST") {
			const body = JSON.parse(request.postData() || "{}") as Record<string, unknown>;
			const parentSessionId = String(body.sessionId || body.parentSessionId || "");
			const prNumber = String(body.prNumber ?? /\/(\d+)$/.exec(String(body.prUrl || ""))?.[1] ?? "777");
			const changesetId = `github:SuuBro/bobbit#${prNumber}:abc1234`;
			const jobId = `prw-session-ux-${Date.now()}-${Math.random().toString(16).slice(2)}`;
			const title = `PR #${prNumber} Walkthrough`;

			const createResponse = await apiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({
					worktree: false,
					parentSessionId,
					childKind: "pr-walkthrough",
					readOnly: true,
					walkthroughJobId: jobId,
					walkthroughChangesetId: changesetId,
					walkthroughTargetKey: `github:SuuBro/bobbit#${prNumber}`,
				}),
			});
			expect(createResponse.ok, `fixture child session should be created: ${createResponse.status}`).toBe(true);
			const created = await createResponse.json() as { id: string };
			await apiFetch(`/api/sessions/${encodeURIComponent(created.id)}`, {
				method: "PATCH",
				body: JSON.stringify({ title }),
			}).catch(() => undefined);

			const job: LaunchJob = {
				jobId,
				parentSessionId,
				childSessionId: created.id,
				changesetId,
				tabId: `walkthrough:${encodeURIComponent(changesetId)}`,
				status: "waiting_for_yaml",
				title,
				target: { number: Number(prNumber), prUrl: prUrl(prNumber), canonicalKey: `github:SuuBro/bobbit#${prNumber}` },
			};
			jobsByChildSession.set(created.id, job);
			jobsById.set(jobId, job);
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...job, created: true, job }) });
			return;
		}

		const sessionMatch = url.pathname.match(/^\/api\/pr-walkthrough\/session\/(.+)$/);
		if (sessionMatch && method === "GET") {
			const job = jobsByChildSession.get(decodeURIComponent(sessionMatch[1]));
			await route.fulfill({ status: job ? 200 : 404, contentType: "application/json", body: JSON.stringify(job ? { job } : { error: "fixture job not found" }) });
			return;
		}

		const jobMatch = url.pathname.match(/^\/api\/pr-walkthrough\/jobs\/(.+)$/);
		if (jobMatch && method === "GET") {
			const job = jobsById.get(decodeURIComponent(jobMatch[1]));
			await route.fulfill({ status: job ? 200 : 404, contentType: "application/json", body: JSON.stringify(job ? { job } : { error: "fixture job not found" }) });
			return;
		}

		if (url.pathname === "/api/internal/pr-walkthrough/submit-yaml" && method === "POST") {
			const body = JSON.parse(request.postData() || "{}") as Record<string, unknown>;
			const job = jobsById.get(String(body.jobId));
			if (!job || job.childSessionId !== body.sessionId) {
				await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "fixture job/session mismatch" }) });
				return;
			}
			job.status = "ready";
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, status: "ready", changesetId: job.changesetId, job }) });
			return;
		}

		if (method === "GET" && url.pathname.startsWith("/api/pr-walkthrough/")) {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					changesetId: "github:SuuBro/bobbit#777:abc1234",
					changeset: { provider: "github", prUrl: prUrl(777), externalUrl: prUrl(777), prNumber: 777, prTitle: "Fixture PR", title: "PR #777: Fixture PR", baseSha: "base", headSha: "head" },
					cards: [],
					warnings: [],
					export: { provider: "github", available: true },
				}),
			});
			return;
		}

		await route.fallback();
	};

	await page.route("**/api/pr-walkthrough/**", handler);
	await page.route("**/api/internal/pr-walkthrough/submit-yaml", handler);
}

async function activeSessionId(page: Page): Promise<string> {
	return page.evaluate(() => ((window as any).bobbitState ?? (window as any).__bobbitState)?.selectedSessionId ?? "");
}

async function launchWalkthroughFromActiveSession(page: Page, prNumber: string): Promise<LaunchJob> {
	const launchResponse = page.waitForResponse((response) => response.url().includes("/api/pr-walkthrough/launch") && response.request().method() === "POST", { timeout: 20_000 });
	await sendMessage(page, `/walkthrough-pr ${prNumber}`);
	const launch = await (await launchResponse).json() as LaunchJob & { job?: LaunchJob };
	const job = (launch.job && typeof launch.job === "object" ? launch.job : launch) as LaunchJob;
	await expect.poll(() => activeSessionId(page), {
		timeout: 15_000,
		message: "walkthrough launch should focus the live child session without archiving the chat UI",
	}).toBe(job.childSessionId);
	return job;
}

async function expectChildNestedUnderParent(page: Page, parentSessionId: string, childSessionId: string, label: string) {
	const parentRow = page.locator(`[data-session-id="${parentSessionId}"], [data-nav-id="session:${parentSessionId}"]`).first();
	const childRow = page.locator(`[data-session-id="${childSessionId}"]`).first();
	await expect(parentRow, `${label}: parent row should be visible`).toBeVisible({ timeout: 15_000 });
	await expect(childRow, `${label}: walkthrough child should be visible under its launching parent`).toBeVisible({ timeout: 15_000 });
	await expect(childRow, `${label}: child row should be labelled as a walkthrough`).toContainText(/Walkthrough/i);
	await expect.poll(async () => {
		const [parentBox, childBox] = await Promise.all([parentRow.boundingBox(), childRow.boundingBox()]);
		return parentBox && childBox ? childBox.y > parentBox.y && childBox.x > parentBox.x : false;
	}, { timeout: 10_000, message: `${label}: child row should be below and indented from parent row` }).toBe(true);
}

async function expectLivePromptAcceptsFollowup(page: Page, text: string) {
	const prompt = page.locator("textarea").first();
	await expect(prompt, "live walkthrough child should show a follow-up prompt editor").toBeVisible({ timeout: 10_000 });
	await expect(prompt, "live walkthrough child prompt editor should be enabled").toBeEnabled();
	await prompt.fill(text);
	await expect(prompt, "live walkthrough child prompt editor should accept typed follow-up text").toHaveValue(text);
	await prompt.press("Enter");
	await expect.poll(async () => page.evaluate((expected) => {
		const session: any = (window as any).bobbitState?.chatPanel?.agentInterface?.session;
		const messages = session?.state?.messages || [];
		return messages.some((message: any) => {
			const content = Array.isArray(message?.content) ? message.content : [];
			return content.some((part: any) => part?.type === "text" && part.text === expected);
		});
	}, text), { timeout: 10_000 }).toBe(true);
}

async function submitValidYaml(page: Page, job: LaunchJob) {
	const response = await page.evaluate(async ({ sessionId, jobId }) => {
		const resp = await fetch("/api/internal/pr-walkthrough/submit-yaml", {
			method: "POST",
			headers: { "Content-Type": "application/json", "Authorization": `Bearer ${localStorage.getItem("gateway.token") || "localhost"}` },
			body: JSON.stringify({ sessionId, jobId, yaml: "schema_version: 1\nwalkthrough:\n  review_chunks: []\n" }),
		});
		return { ok: resp.ok, status: resp.status, text: await resp.text().catch(() => "") };
	}, { sessionId: job.childSessionId, jobId: job.jobId });
	expect(response.ok, `valid YAML submit should succeed: ${response.status} ${response.text}`).toBe(true);
	await page.evaluate((childSessionId) => {
		document.dispatchEvent(new CustomEvent("pr-walkthrough-job-updated", { detail: { job: { childSessionId, status: "ready" } } }));
		(window as any).__bobbitRenderApp?.();
	}, job.childSessionId);
}

async function ensureTeamLeadRole() {
	const roleResponse = await apiFetch("/api/roles", {
		method: "POST",
		body: JSON.stringify({
			name: "team-lead",
			label: "Team Lead",
			promptTemplate: "You are a test team lead. Reply with OK.",
			toolPolicies: {},
		}),
	});
	expect([200, 201, 409], `team-lead role fixture should be creatable: ${roleResponse.status}`).toContain(roleResponse.status);
}

test.describe("Session-hosted PR walkthrough UX regressions", () => {
	test("normal session launch nests the live walkthrough child, survives reload, and keeps follow-up chat promptable", async ({ page }) => {
		await installWalkthroughLaunchFixture(page);
		await page.setViewportSize({ width: 1600, height: 900 });
		await openApp(page);
		await createSessionViaUI(page);
		const parentSessionId = await activeSessionId(page);

		const job = await launchWalkthroughFromActiveSession(page, "777");
		await expectChildNestedUnderParent(page, parentSessionId, job.childSessionId, "normal session launch");
		await expectLivePromptAcceptsFollowup(page, "Before YAML follow-up from browser E2E");

		await submitValidYaml(page, job);
		await expectLivePromptAcceptsFollowup(page, "After YAML follow-up from browser E2E");

		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
		await expect.poll(() => activeSessionId(page), { timeout: 15_000 }).toBe(job.childSessionId);
		await expectChildNestedUnderParent(page, parentSessionId, job.childSessionId, "normal session launch after reload");
		await expectLivePromptAcceptsFollowup(page, "Reloaded walkthrough follow-up from browser E2E");
	});

	test("goal team lead launch nests the walkthrough child under the team lead and restores after reload", async ({ page }) => {
		await installWalkthroughLaunchFixture(page);
		await ensureTeamLeadRole();
		const goal = await createGoal({ title: `Walkthrough team lead ${Date.now()}`, team: true, worktree: false });
		try {
			const teamLeadId = await startTeam(goal.id);
			await waitForSessionStatus(teamLeadId, "idle");

			await page.setViewportSize({ width: 1600, height: 900 });
			await openApp(page);
			await navigateToHash(page, `#/session/${teamLeadId}`);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });

			const job = await launchWalkthroughFromActiveSession(page, "778");
			await expectChildNestedUnderParent(page, teamLeadId, job.childSessionId, "team lead launch");
			await expectLivePromptAcceptsFollowup(page, "Team lead child follow-up from browser E2E");

			await page.reload();
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
			await expect.poll(() => activeSessionId(page), { timeout: 15_000 }).toBe(job.childSessionId);
			await expectChildNestedUnderParent(page, teamLeadId, job.childSessionId, "team lead launch after reload");
		} finally {
			await teardownTeam(goal.id).catch(() => undefined);
			await deleteGoal(goal.id).catch(() => undefined);
		}
	});

	test("terminated walkthrough child remains archived read-only", async ({ page }) => {
		await installWalkthroughLaunchFixture(page);
		await page.setViewportSize({ width: 1600, height: 900 });
		await openApp(page);
		await createSessionViaUI(page);

		const job = await launchWalkthroughFromActiveSession(page, "779");
		const deleteResponse = await apiFetch(`/api/sessions/${encodeURIComponent(job.childSessionId)}`, { method: "DELETE" });
		expect(deleteResponse.ok, `walkthrough child should terminate cleanly: ${deleteResponse.status}`).toBe(true);

		await navigateToHash(page, "#/");
		await navigateToHash(page, `#/session/${job.childSessionId}`);
		await expect(page.locator(".bobbit-blob--archived").first(), "terminated walkthrough child should render as archived").toBeVisible({ timeout: 10_000 });
		await expect(page.locator("textarea"), "terminated walkthrough child must not expose a prompt editor").toHaveCount(0);
	});
});
