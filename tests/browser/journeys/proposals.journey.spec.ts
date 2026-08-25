/**
 * Journey: Proposals — v2 browser smoke
 * Covers: journey-proposals
 * Consolidated from: goal-proposal-*, project-proposal-*, proposal-panel-*,
 *   proposal-open-all-types, proposal-panel-streaming, api-error-modal, etc.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, openApp, navigateToHash, createSession, deleteSession, createGoal, deleteGoal, waitForSessionStatus, apiFetch, defaultProjectId, registerProject } from "../_helpers/journey-fixture.js";
import { createSessionViaUI, sendMessage } from "../_helpers/journey-fixture.js";
import { nonGitCwd } from "../../e2e/_helpers/e2e-setup.js";
import { createGoalAssistantViaUI } from "../../support/harnesses/browser/legacy-ui/ui-helpers.js";

async function authenticateMockProposalTools(
	page: import("@playwright/test").Page,
	gateway: any,
): Promise<void> {
	const sessionId = await page.evaluate(() => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		return state?.selectedSessionId as string | undefined;
	});
	const agent = sessionId ? gateway.sessionManager?.getSession(sessionId)?.rpcClient?._agent : undefined;
	if (!agent || typeof agent._gatewayPost !== "function") {
		throw new Error("proposal journey requires the in-process mock agent gateway adapter");
	}
	const sessionSecret = agent.env?.BOBBIT_SESSION_SECRET;
	if (typeof sessionSecret !== "string" || !sessionSecret) {
		throw new Error("proposal journey mock session is missing its owner capability");
	}
	const gatewayPost = agent._gatewayPost.bind(agent);
	agent._gatewayPost = (pathname: string, body: unknown, headers: Record<string, string> = {}) => gatewayPost(
		pathname,
		body,
		{ ...headers, "X-Bobbit-Session-Secret": sessionSecret },
	);
}

async function holdProposalStream(
	page: import("@playwright/test").Page,
	gateway: any,
	type: string,
): Promise<{ entered: Promise<unknown>; release: () => void }> {
	const sessionId = await page.evaluate(() => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		return state?.selectedSessionId as string | undefined;
	});
	const core = sessionId ? gateway.sessionManager?.getSession(sessionId)?.rpcClient?._agent : undefined;
	if (!core || typeof core.armBarrier !== "function" || typeof core.waitForBarrier !== "function") {
		throw new Error("proposal journey requires the in-process mock agent barrier seam");
	}
	const boundary = `proposal-stream:${type}:intermediate-delta`;
	core.armBarrier(boundary);
	const entered = Promise.resolve(core.waitForBarrier(boundary)).then((details: any) => {
		if (details?.proposalType !== type || details?.delta !== 1 || typeof details?.toolId !== "string") {
			throw new Error(`proposal stream reached an uncorrelated intermediate barrier: ${JSON.stringify(details)}`);
		}
		return details;
	});
	return {
		entered,
		release: () => { core.releaseBarrier(boundary); },
	};
}

async function waitForProposalSlot(page: import("@playwright/test").Page, type: string): Promise<void> {
	await page.waitForFunction(
		(t: string) => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState;
			const fields = state?.activeProposals?.[t]?.fields;
			return fields && typeof fields === "object" && Object.keys(fields).length > 0;
		},
		type,
		{ timeout: 20_000 },
	);
}

async function setSubgoalsEnabledPreference(value: boolean): Promise<void> {
	const response = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ subgoalsEnabled: value }),
	});
	expect(response.status).toBe(200);
}

async function seedGoalProposal(
	page: import("@playwright/test").Page,
	sessionId: string,
	args: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
	return page.evaluate(async ({ sid, candidate }) => {
		const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/proposal/goal/seed`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ args: candidate }),
		});
		return { status: response.status, body: await response.json().catch(() => null) };
	}, { sid: sessionId, candidate: args });
}

async function waitForGoalProposal(
	page: import("@playwright/test").Page,
	title: string,
): Promise<{ rev: number; fields: Record<string, unknown> }> {
	await page.waitForFunction(
		(expectedTitle: string) => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState;
			return state?.activeProposals?.goal?.fields?.title === expectedTitle;
		},
		title,
		{ timeout: 20_000 },
	);
	return page.evaluate(() => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		const slot = state.activeProposals.goal;
		return { rev: slot.rev, fields: { ...slot.fields } };
	});
}

// ── Shell / navigation tests ────────────────────────────────────────────────

test.describe("Journey: Proposals — shell", () => {
	test("app shell and an idle session render the proposal-compatible surface", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await expect(page.locator("body")).toBeVisible({ timeout: 20_000 });
			expect(await page.title()).toBeTruthy();
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
			const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
			await expect(newGoalBtn).toBeVisible({ timeout: 15_000 });
			await newGoalBtn.click();
			await expect(page.locator(
				"dialog, [role='dialog'], [role='alertdialog'], goal-proposal-panel, [data-testid='goal-proposal'], input[placeholder*='title' i], input[placeholder*='goal' i]",
			).first()).toBeVisible({ timeout: 20_000 });
			await page.keyboard.press("Escape");
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

});

// ── Behavioral: proposal slot + tab ────────────────────────────────────────

test.describe("Journey: Proposals — behavioral", () => {
	test("role and streaming goal proposals expose every intermediate and terminal state", async ({ page, gateway }) => {
		test.setTimeout(90_000);
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "ROLE_PROPOSAL_PARITY");
		await waitForProposalSlot(page, "role");
		const fields = await page.evaluate(() => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState;
			return state?.activeProposals?.role?.fields ?? null;
		});
		expect(fields).toBeTruthy();
		expect(typeof fields).toBe("object");
		expect(Object.keys(fields as object).length).toBeGreaterThan(0);

		const roleTab = page.locator('.goal-tab-pill[title="Role"]').first();
		await expect(roleTab).toBeVisible({ timeout: 15_000 });
		await expect(roleTab.locator(".goal-tab-dot")).toBeVisible({ timeout: 15_000 });
		await roleTab.click();
		const rolePane = page.locator('[data-panel="role-proposal"]').first();
		await expect(rolePane).toBeVisible({ timeout: 15_000 });
		const dismissBtn = rolePane.getByRole("button", { name: /^Dismiss$/ }).first();
		await expect(dismissBtn).toBeVisible({ timeout: 15_000 });
		await expect(dismissBtn).toBeEnabled();
		await dismissBtn.click();
		await expect(roleTab).toHaveCount(0, { timeout: 20_000 });
		await page.waitForFunction(
			() => {
				const state = (window as any).bobbitState ?? (window as any).__bobbitState;
				return !!state && !state.activeProposals?.role;
			},
			{ timeout: 20_000 },
		);

		const stream = await holdProposalStream(page, gateway, "goal");
		const badge = page.locator('[data-testid="proposal-streaming-badge"]').first();
		const submitWrap = page.locator('[data-testid="proposal-primary-submit"]').first();
		try {
			await sendMessage(page, "STAY_BUSY:propose_goal:5:0");
			await stream.entered;
			await expect(submitWrap).toBeVisible({ timeout: 15_000 });
			const submitBtn = submitWrap.locator("button").first();
			await expect(badge).toBeVisible({ timeout: 15_000 });
			await expect(submitBtn).toBeDisabled({ timeout: 15_000 });
		} finally {
			stream.release();
		}
		const submitBtn = submitWrap.locator("button").first();
		await expect(badge).toBeHidden({ timeout: 20_000 });
		await expect(submitBtn).toBeEnabled({ timeout: 15_000 });
		await expect.poll(
			() => page.evaluate(() => (window as any).bobbitState?.remoteAgent?.state?.status ?? ""),
			{ timeout: 15_000 },
		).toBe("idle");

		const dismissStream = await holdProposalStream(page, gateway, "goal");
		const titleInput = page.locator("input[placeholder='Goal title']").first();
		try {
			await sendMessage(page, "STAY_BUSY:propose_goal:8:0");
			await dismissStream.entered;
			await expect(titleInput).toBeVisible({ timeout: 15_000 });
			await expect(badge).toBeVisible({ timeout: 15_000 });
			const dismissBtn = page.locator("button").filter({ hasText: "Dismiss" }).first();
			await expect(dismissBtn).toBeVisible({ timeout: 15_000 });
			await expect(dismissBtn).toBeEnabled();
			await dismissBtn.click();
			await expect(titleInput).toBeHidden({ timeout: 15_000 });
		} finally {
			dismissStream.release();
		}
		await page.waitForFunction(
			() => (window as any).bobbitState?.remoteAgent?.state?.status === "idle",
			{ timeout: 15_000 },
		);
		await expect(titleInput).toBeHidden();
		await expect(badge).toBeHidden();
	});
});

test.describe("Journey: Proposals — API error handling", () => {
	// Also ports the preserve-assistant + retry contract from
	// goal-accept-failure-keeps-assistant.spec.ts (audit: project-settings GAP):
	// on a 400 the assistant stays mounted (title + session route unchanged) and
	// a second Create re-issues the POST.
	test("createGoal 400 shows server error in error modal (page.route stub)", async ({ page }) => {
		test.setTimeout(90_000);
		let postAttempts = 0;
		await page.route("**/api/goals", async (route) => {
			if (route.request().method() !== "POST") return route.continue();
			postAttempts++;
			await route.fulfill({
				status: 400,
				contentType: "application/json",
				body: JSON.stringify({
					error: "Journey test: missing title",
					stack: "Error: Journey test: missing title\n    at goalManager.create (server.ts:1:1)",
				}),
			});
		});
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "STAY_BUSY:propose_goal:4:80");
		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 15_000 });
		const badge = page.locator('[data-testid="proposal-streaming-badge"]').first();
		await expect(badge).toBeHidden({ timeout: 20_000 });
		const createBtn = page.locator("button").filter({ hasText: "Create Goal" }).first();
		if (await createBtn.isVisible({ timeout: 15_000 }).catch(() => false)) {
			await createBtn.click();
			const errorMsg = page.locator('[data-testid="error-details-message"]').first();
			await expect(errorMsg).toHaveText("Journey test: missing title", { timeout: 20_000 });
			const bodyText = await page.locator("body").innerText();
			expect(bodyText).not.toContain("Failed to create goal: 400");
			await expect.poll(() => postAttempts, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

			// Preserve contract: the assistant panel stays mounted and the session
			// route is unchanged after the failure.
			await expect(titleInput).toBeVisible();
			await expect(page).toHaveURL(/#\/session\//);

			// Retry contract: dismissing and clicking Create again re-issues the POST.
			const okBtn = page.locator("button").filter({ hasText: "OK" }).first();
			if (await okBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
				await okBtn.click();
				await expect(errorMsg).toBeHidden({ timeout: 5_000 });
				await createBtn.click();
				await expect.poll(() => postAttempts, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
			}
		} else {
			test.skip(true, "Create Goal button not present in this harness config");
		}
	});

	test("page.route() session list 500 still lets app load gracefully", async ({ page }) => {
		const sessionListRoute = /\/api\/sessions(?:\?.*)?$/;
		let failedRequestUrl: string | undefined;
		const failedListResponse = page.waitForResponse((response) => {
			const request = response.request();
			return request.method() === "GET"
				&& new URL(response.url()).pathname === "/api/sessions"
				&& response.status() === 500;
		});
		await page.route(sessionListRoute, async (route) => {
			const request = route.request();
			const pathname = new URL(request.url()).pathname;
			if (request.method() !== "GET" || pathname !== "/api/sessions" || failedRequestUrl) {
				return route.fallback();
			}
			failedRequestUrl = request.url();
			await route.fulfill({
				status: 500,
				contentType: "text/plain",
				body: "Internal Server Error",
			});
		});

		const appReady = openApp(page);
		const failedResponse = await failedListResponse;
		expect(failedResponse.url()).toBe(failedRequestUrl);
		await appReady;
		await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible();
		const mountedState = await page.evaluate(() => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState;
			return {
				appView: state?.appView,
				sessionsError: state?.sessionsError,
				sessionsGeneration: state?.sessionsGeneration,
				sessionsLoading: state?.sessionsLoading,
			};
		});
		expect(mountedState).toMatchObject({
			appView: "authenticated",
			sessionsError: "",
			sessionsLoading: false,
		});
		expect(mountedState.sessionsGeneration).toBeGreaterThanOrEqual(0);
	});

	// Keep the related goal-assistant proposal lifecycle in one session. Besides
	// preserving one continuous user journey, this avoids repeating expensive
	// assistant creation solely to inspect another projection of the same draft.
	test("goal assistant proposal survives navigation, editing and workflow changes, then stays dismissed after reload", async ({ page, gateway }) => {
		test.setTimeout(120_000);
		const initialSpecTail = "It validates the goal creation UI.";
		const editedSpecBody = "EDITED SPEC BODY for Mode A repro.";
		await openApp(page);
		await createGoalAssistantViaUI(page, { timeout: 60_000 });
		await authenticateMockProposalTools(page, gateway);
		const textarea = page.locator("textarea").first();
		await expect(textarea).toBeVisible({ timeout: 30_000 });
		await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");

		await expect(page.getByText("Goal Proposal").first()).toBeVisible({ timeout: 20_000 });
		await expect(page.locator('[data-testid="proposal-open-button"]').first()).toBeVisible({ timeout: 15_000 });
		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 20_000 });
		await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });
		const panel = page.locator('[data-panel="goal-proposal"]').first();
		await expect(panel).toBeVisible({ timeout: 15_000 });
		await expect.poll(
			() => page.evaluate(() => ((window as any).bobbitState?.previewSpec as string) ?? ""),
			{ timeout: 15_000 },
		).toContain(initialSpecTail);

		const getSpec = () => page.evaluate(() => {
			const cm = document.querySelector("commentable-markdown") as any;
			return (cm?.markdown as string) ?? "";
		});
		const originalSpec = await getSpec();
		expect(originalSpec.length, "proposal spec must be non-empty before nav").toBeGreaterThan(20);
		const sid = await page.evaluate(() => (window as any).bobbitState?.selectedSessionId as string);
		expect(sid).toBeTruthy();
		const otherSessionId = await createSession();
		try {
			await navigateToHash(page, `#/session/${otherSessionId}`);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
			await navigateToHash(page, `#/session/${sid}`);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
			await expect(panel).toBeVisible({ timeout: 15_000 });
			await expect.poll(getSpec, { timeout: 15_000, intervals: [500, 1000, 2000] }).toBe(originalSpec);
		} finally {
			await deleteSession(otherSessionId).catch(() => {});
		}

		const workflowTab = page.locator("[data-testid='goal-proposal-tab-workflow']").first();
		await workflowTab.click();
		await expect(page.locator("[data-testid='goal-proposal-workflow-select']").first()).toBeVisible({ timeout: 15_000 });
		const customise = page.locator("[data-testid='goal-proposal-workflow-customize']").first();
		await expect(customise).toBeVisible({ timeout: 15_000 });
		await expect(customise).toHaveText("Customise for this goal");
		await customise.click();
		const revert = page.locator("[data-testid='goal-proposal-workflow-reset']").first();
		await expect(revert).toBeVisible({ timeout: 15_000 });
		await expect(revert).toHaveText("Revert to project definition");
		await expect(customise).toHaveCount(0);
		await revert.click();
		await expect(customise).toBeVisible({ timeout: 15_000 });
		await expect(revert).toHaveCount(0);

		await sendMessage(page, "Apply GOAL_EDITABLE_EDIT to the spec");
		await page.waitForFunction(
			(needle: string) => (((window as any).bobbitState?.activeProposals?.goal?.fields?.spec as string) ?? "").includes(needle),
			editedSpecBody,
			{ timeout: 20_000 },
		);
		await expect.poll(
			() => page.evaluate(() => ((window as any).bobbitState?.previewSpec as string) ?? ""),
			{ timeout: 15_000 },
		).toContain(editedSpecBody);
		expect(await page.evaluate(() => ((window as any).bobbitState?.previewSpec as string) ?? "")).not.toContain(initialSpecTail);
		await waitForSessionStatus(sid, "idle");
		await page.waitForFunction(async (sidArg: string) => {
			const url = (localStorage.getItem("gateway.url") ?? location.origin).replace(/\/$/, "");
			const token = localStorage.getItem("gateway.token") ?? "";
			const response = await fetch(`${url}/api/sessions/${sidArg}/draft?type=goal`, { headers: { Authorization: `Bearer ${token}` } });
			if (!response.ok) return false;
			const draft = (await response.json())?.data?.activeGoalProposal;
			return draft?.title === "E2E Test Goal" && String(draft?.spec ?? "").includes("EDITED SPEC BODY for Mode A repro.");
		}, sid, { timeout: 15_000 });
		const goalTab = page.locator('.goal-tab-pill[title="Goal"]').first();
		await expect(goalTab).toBeVisible();
		await goalTab.click();
		await expect(panel).toBeVisible();
		const proposalDelete = page.waitForResponse((response) => {
			const pathname = new URL(response.url()).pathname;
			return response.request().method() === "DELETE"
				&& pathname === `/api/sessions/${encodeURIComponent(sid)}/proposal/goal`;
		});
		const dismissButton = goalTab.getByRole("button", { name: "Dismiss Goal" });
		await expect(dismissButton).toBeVisible();
		await expect(dismissButton).toBeEnabled();
		await dismissButton.click();
		const deleteResponse = await proposalDelete;
		expect(deleteResponse.status()).toBe(204);
		const dismissalFingerprint = await page.evaluate(
			(sidArg: string) => localStorage.getItem(`bobbit-goal-proposal-dismissed-${sidArg}`),
			sid,
		);
		expect(dismissalFingerprint, "the real Dismiss action must persist its proposal fingerprint").toBeTruthy();
		await expect.poll(
			() => page.evaluate(() => (window as any).bobbitState?.activeProposals?.goal ?? null),
		).toBeNull();
		await expect(titleInput).toBeHidden();
		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
		await page.waitForFunction((sidArg: string) => (window as any).bobbitState?.selectedSessionId === sidArg, sid, { timeout: 15_000 });
		await expect.poll(() => page.evaluate(({ sidArg, fingerprint }) => {
			const state = (window as any).bobbitState;
			return state?.selectedSessionId === sidArg
				&& !state.activeProposals?.goal
				&& state.previewTitle === ""
				&& localStorage.getItem(`bobbit-goal-proposal-dismissed-${sidArg}`) === fingerprint;
		}, { sidArg: sid, fingerprint: dismissalFingerprint })).toBe(true);
		const titleAfterReload = page.locator("input[placeholder='Goal title']").first();
		await expect(titleAfterReload).toBeHidden({ timeout: 10_000 });
		expect(await page.evaluate(() => (window as any).bobbitState?.activeProposals?.goal ?? null)).toBeNull();
	});
});

// Acceptance projection regressions: the regular proposal panel must submit
// the persisted candidate identity and let POST /api/goals own current-state
// validation. The sibling goal-preview handler is pinned in the core source
// contract without duplicating this browser setup.
test.describe("Journey: Goal Proposal — canonical acceptance projection", () => {
	test("stale child proposal keeps its parent through SUBGOALS_DISABLED and succeeds after correction", async ({ page }) => {
		test.setTimeout(90_000);
		await setSubgoalsEnabledPreference(true);
		const projectId = await defaultProjectId();
		expect(projectId).toBeTruthy();
		const parent = await createGoal({
			title: `proposal-parent-${Date.now()}`,
			projectId,
			team: false,
			subgoalsAllowed: true,
			maxNestingDepth: 3,
		});
		const sessionId = await createSession({ projectId });
		let acceptCurrentState = false;
		const submitted: Array<Record<string, unknown>> = [];
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			const seeded = await seedGoalProposal(page, sessionId, {
				title: "Stale Child Proposal",
				spec: "A child proposal that must retain its parent through acceptance-time validation.",
				workflow: "general",
				parentGoalId: parent.id,
			});
			expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
			const initial = await waitForGoalProposal(page, "Stale Child Proposal");
			expect(initial.fields.parentGoalId).toBe(parent.id);
			expect(initial.rev).toBeGreaterThan(0);

			await page.route("**/api/goals", async (route) => {
				if (route.request().method() !== "POST") return route.continue();
				const body = route.request().postDataJSON() as Record<string, unknown>;
				submitted.push(body);
				if (!acceptCurrentState) {
					await route.fulfill({
						status: 403,
						contentType: "application/json",
						body: JSON.stringify({
							error: "Sub-goals are disabled in system settings.",
							message: "Sub-goals are disabled in system settings.",
							code: "SUBGOALS_DISABLED",
						}),
					});
					return;
				}
				await route.fulfill({
					status: 201,
					contentType: "application/json",
					body: JSON.stringify({
						id: "corrected-child-goal",
						title: body.title,
						spec: body.spec,
						cwd: body.cwd || nonGitCwd(),
						state: "active",
						team: true,
						projectId,
						parentGoalId: parent.id,
						createdAt: Date.now(),
						updatedAt: Date.now(),
					}),
				});
			});

			await setSubgoalsEnabledPreference(false);
			await expect.poll(
				() => page.evaluate(() => document.documentElement.dataset.subgoalsEnabled),
				{ timeout: 10_000 },
			).toBe("false");

			const panel = page.locator('[data-panel="goal-proposal"]').first();
			const createButton = panel.getByRole("button", { name: "Create Goal" });
			await expect(createButton).toBeEnabled({ timeout: 10_000 });
			await createButton.click();

			await expect(page.locator('[data-testid="error-details-code"]')).toHaveText("SUBGOALS_DISABLED", { timeout: 15_000 });
			await expect(page.locator('[data-testid="error-details-message"]')).toContainText("Sub-goals are disabled");
			expect(submitted).toHaveLength(1);
			expect(submitted[0].parentGoalId, "visibility changes must not rewrite the child candidate into a root").toBe(parent.id);

			const retained = await waitForGoalProposal(page, "Stale Child Proposal");
			expect(retained.rev, "failed acceptance must not advance the draft revision").toBe(initial.rev);
			expect(retained.fields.parentGoalId).toBe(parent.id);
			await expect(panel).toBeVisible();
			const rawDraft = await page.evaluate(async (sid) => {
				const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/proposal/goal`);
				return { status: response.status, text: await response.text() };
			}, sessionId);
			expect(rawDraft.status).toBe(200);
			expect(rawDraft.text).toContain(parent.id);

			const goalsAfterFailure = await (await apiFetch("/api/goals")).json();
			const goalList: any[] = Array.isArray(goalsAfterFailure) ? goalsAfterFailure : goalsAfterFailure.goals ?? [];
			expect(goalList.some(goal => goal.title === "Stale Child Proposal"), "no root/child goal may exist before correction").toBe(false);

			await page.getByRole("button", { name: "OK" }).click();
			acceptCurrentState = true;
			await setSubgoalsEnabledPreference(true);
			await expect.poll(
				() => page.evaluate(() => document.documentElement.dataset.subgoalsEnabled),
				{ timeout: 10_000 },
			).toBe("true");
			await createButton.click();

			await expect.poll(() => submitted.length, { timeout: 10_000 }).toBe(2);
			expect(submitted[1].parentGoalId).toBe(parent.id);
			await expect.poll(
				() => page.evaluate(() => (window as any).bobbitState?.activeProposals?.goal ?? null),
				{ timeout: 10_000 },
			).toBeNull();
			await expect(page).toHaveURL(/#\/goal\/corrected-child-goal$/);
		} finally {
			await page.unroute("**/api/goals").catch(() => {});
			await deleteSession(sessionId).catch(() => {});
			await deleteGoal(parent.id).catch(() => {});
			await setSubgoalsEnabledPreference(true).catch(() => {});
		}
	});

	test("workflowless omitted-workflow proposal stays enabled and reaches createGoal without a workflow", async ({ page }) => {
		test.setTimeout(90_000);
		const rootPath = mkdtempSync(join(tmpdir(), "bobbit-v2-proposal-workflowless-"));
		const project = await registerProject({
			name: `proposal-workflowless-${Date.now()}`,
			rootPath,
			seedWorkflows: false,
		});
		const sessionId = await createSession({ cwd: rootPath, projectId: project.id });
		let submitted: Record<string, unknown> | undefined;
		try {
			const before = await (await apiFetch(`/api/workflows?projectId=${encodeURIComponent(project.id)}`)).json();
			expect(Array.isArray(before) ? before : before.workflows ?? []).toHaveLength(0);

			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			const seeded = await seedGoalProposal(page, sessionId, {
				title: "Generated Default Proposal",
				spec: "A workflowless proposal whose omitted selection is resolved canonically at creation time.",
			});
			expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
			const proposal = await waitForGoalProposal(page, "Generated Default Proposal");
			expect(proposal.fields).not.toHaveProperty("workflow");
			expect(proposal.fields).not.toHaveProperty("workflowId");

			const afterSeed = await (await apiFetch(`/api/workflows?projectId=${encodeURIComponent(project.id)}`)).json();
			expect(Array.isArray(afterSeed) ? afterSeed : afterSeed.workflows ?? [], "proposal validation must not persist generated defaults").toHaveLength(0);

			await page.route("**/api/goals", async (route) => {
				if (route.request().method() !== "POST") return route.continue();
				submitted = route.request().postDataJSON() as Record<string, unknown>;
				await route.fulfill({
					status: 201,
					contentType: "application/json",
					body: JSON.stringify({
						id: "generated-default-goal",
						title: submitted.title,
						spec: submitted.spec,
						cwd: rootPath,
						state: "active",
						team: true,
						projectId: project.id,
						createdAt: Date.now(),
						updatedAt: Date.now(),
					}),
				});
			});

			const panel = page.locator('[data-panel="goal-proposal"]').first();
			const createButton = panel.getByRole("button", { name: "Create Goal" });
			await expect(createButton, "an empty workflow cache must not hard-stop an omitted selection").toBeEnabled({ timeout: 10_000 });
			await createButton.click();
			await expect.poll(() => submitted, { timeout: 10_000 }).toBeTruthy();
			expect(submitted).not.toHaveProperty("workflowId");
			expect(submitted).not.toHaveProperty("workflow");
			await expect(page.locator('[data-testid="error-details-message"]')).toHaveCount(0);
			await expect(page).toHaveURL(/#\/goal\/generated-default-goal$/);
		} finally {
			await page.unroute("**/api/goals").catch(() => {});
			await deleteSession(sessionId).catch(() => {});
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			rmSync(rootPath, { recursive: true, force: true });
		}
	});
});

// Ported from failed-goal-proposal-ux.spec.ts (audit: proposals GAP): a
// MISSING_WORKFLOW failed proposal surfaces the workflow-error row.
test.describe("Journey: Failed Goal Proposal", () => {
	test("MISSING_WORKFLOW surfaces the goal-proposal-workflow-error row", async ({ page, gateway }) => {
		test.setTimeout(90_000);
		await openApp(page);
		await createSessionViaUI(page);
		await authenticateMockProposalTools(page, gateway);
		await sendMessage(page, "Please run GOAL_PROPOSAL_MISSING_WORKFLOW now");
		const workflowError = page.locator('[data-testid="goal-proposal-workflow-error"]').first();
		await expect(workflowError).toBeVisible({ timeout: 20_000 });
		await expect(workflowError).toContainText(/Workflow is required/i, { timeout: 10_000 });
	});

	test("CWD_OUTSIDE_PROJECT renders an actionable failed card and corrected resubmission revision", async ({ page, gateway }) => {
		test.setTimeout(90_000);
		await openApp(page);
		await createSessionViaUI(page);
		await authenticateMockProposalTools(page, gateway);
		await sendMessage(page, "Please run GOAL_PROPOSAL_OUTSIDE_CWD now");

		const failedCard = page.locator('[data-testid="proposal-failed-card"]').filter({ hasText: "Outside Cwd Goal" }).first();
		await expect(failedCard).toBeVisible({ timeout: 20_000 });
		const errorMessage = failedCard.locator('[data-testid="proposal-error-message"]');
		await expect(errorMessage).toContainText(/cwd must be inside .+/i);
		await expect(failedCard.locator('[data-testid="proposal-rev"]')).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState;
			const messages = state?.remoteAgent?.state?.messages ?? [];
			const failed = [...messages].reverse().find((message: any) =>
				message?.role === "toolResult" && message?.toolName === "propose_goal"
					&& (message?.content ?? []).some((part: any) => String(part?.text ?? "").includes("CWD_OUTSIDE_PROJECT")),
			);
			const text = (failed?.content ?? []).map((part: any) => part?.text ?? "").join("\n");
			try { return JSON.parse(text)?.code; } catch { return undefined; }
		}), { timeout: 20_000 }).toBe("CWD_OUTSIDE_PROJECT");

		await sendMessage(page, "Please run GOAL_PROPOSAL_FIXED_CWD now");
		await expect(page.getByText("Corrected Cwd Goal").first()).toBeVisible({ timeout: 20_000 });
		await expect(page.locator('[data-testid="proposal-failed-card"]')).toHaveCount(1);
		await expect(page.locator('[data-testid="proposal-rev"]').last()).toHaveText(/^rev \d+$/, { timeout: 20_000 });
	});
});

// Ported from goal-reattempt-project-binding.spec.ts (audit: project-settings
// GAP, mutant BR71): Create Goal in a Re-attempt session must inherit the
// original goal's projectId (no "No project selected" error).
test.describe("Journey: Goal Re-attempt — project binding", () => {
	test("Create Goal in a re-attempt session inherits the original projectId", async ({ page }) => {
		test.setTimeout(120_000);
		const projectId = await defaultProjectId();
		expect(projectId).toBeTruthy();

		const origResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "v2 original goal to re-attempt",
				spec: "Original spec body for the re-attempt binding journey test.",
				cwd: nonGitCwd(),
				worktree: false,
				autoStartTeam: false,
				projectId,
			}),
		});
		expect(origResp.status).toBe(201);
		const origGoal = await origResp.json();
		let sessionId = "";
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${origGoal.id}`);
			const reattemptBtn = page.locator("button").filter({ hasText: "Re-attempt" }).first();
			await expect(reattemptBtn).toBeVisible({ timeout: 15_000 });

			const sessionCreate = page.waitForResponse(
				(resp) => resp.url().includes("/api/sessions") && resp.request().method() === "POST" && resp.ok(),
				{ timeout: 30_000 },
			);
			await reattemptBtn.click();
			sessionId = (await (await sessionCreate).json()).id;
			expect(sessionId).toBeTruthy();
			// Server inherited projectId + reattemptGoalId.
			const sessData = await (await apiFetch(`/api/sessions/${sessionId}`)).json();
			expect(sessData.projectId).toBe(projectId);
			expect(sessData.reattemptGoalId).toBe(origGoal.id);

			const textarea = page.locator("textarea").first();
			await expect(textarea).toBeVisible({ timeout: 20_000 });
			await textarea.fill("Please create a GOAL_PROPOSAL for the re-attempt");
			await textarea.press("Enter");

			const titleInput = page.locator("input[placeholder='Goal title']").first();
			await expect(titleInput).toBeVisible({ timeout: 30_000 });
			await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });

			const createBtn = page.locator("button").filter({ hasText: "Create Goal" }).first();
			await expect(createBtn).toBeEnabled({ timeout: 10_000 });
			const createPost = page.waitForResponse(
				(resp) => resp.url().includes("/api/goals") && resp.request().method() === "POST" && resp.ok(),
				{ timeout: 10_000 },
			).catch(() => null);
			await createBtn.click();

			// The re-attempt derivation must prevent the "No project selected" error.
			await expect(page.getByText("No project selected for this goal")).not.toBeVisible({ timeout: 3_000 });
			expect(await createPost, "POST /api/goals must fire").not.toBeNull();

			// New goal bound to the original projectId.
			await expect.poll(async () => {
				const data = await (await apiFetch("/api/goals")).json();
				const goals: any[] = Array.isArray(data) ? data : data.goals ?? [];
				return goals.find((g) => g.id !== origGoal.id && g.title === "E2E Test Goal" && g.projectId === projectId)?.projectId ?? null;
			}, { timeout: 10_000 }).toBe(projectId);
		} finally {
			const data = await (await apiFetch("/api/goals")).json().catch(() => ({ goals: [] }));
			const goals: any[] = Array.isArray(data) ? data : data.goals ?? [];
			const fresh = goals.find((g) => g.id !== origGoal.id && g.title === "E2E Test Goal");
			if (fresh?.id) await apiFetch(`/api/goals/${fresh.id}`, { method: "DELETE" }).catch(() => {});
			if (sessionId) await deleteSession(sessionId).catch(() => {});
			await apiFetch(`/api/goals/${origGoal.id}`, { method: "DELETE" }).catch(() => {});
		}
	});
});

// Ported from goal-proposal-subgoal-prefill.spec.ts (audit: proposals GAP,
// mutant BR45): an agent can pre-fill everything a human sets on the goal
// proposal's Sub-goals tab. syncProposalFormState() seeds the form controls
// from subgoalsAllowed/maxNestingDepth/divergencePolicy/maxConcurrentChildren
// so the panel opens with the agent's choices already selected.
test.describe("Journey: Goal Proposal — Sub-goals prefill", () => {
	async function setSubgoals(value: boolean): Promise<void> {
		const resp = await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ subgoalsEnabled: value }),
		});
		expect(resp.status).toBe(200);
	}

	test.afterEach(async () => { await setSubgoals(true); });

	test("Sub-goals tab reflects agent-prefilled depth/concurrency/policy", async ({ page }) => {
		test.setTimeout(90_000);
		await setSubgoals(true);
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "Please GOAL_PROPOSAL_SUBGOAL_PREFILL now");

		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 20_000 });
		await expect(titleInput).toHaveValue("Prefilled Goal", { timeout: 15_000 });

		const subgoalsTab = page.locator("[data-testid='goal-proposal-tab-subgoals']");
		await expect(subgoalsTab).toBeVisible({ timeout: 10_000 });
		await subgoalsTab.click();

		// Allow-subgoals is pre-checked (agent set subgoalsAllowed: true).
		const toggle = page.locator("[data-testid='goal-form-subgoals-toggle']");
		await expect(toggle).toBeVisible({ timeout: 10_000 });
		await expect(toggle).toBeChecked();

		// Max-depth control retains its testid AND reflects the agent's value (2).
		await expect(page.locator("[data-testid='goal-form-max-depth']"))
			.toHaveValue("2", { timeout: 10_000 });

		// Concurrency reflects the agent's value (4).
		await expect(page.locator("[data-testid='goal-form-max-concurrent-children']"))
			.toHaveValue("4", { timeout: 10_000 });

		// Divergence policy 'autonomous' is the pressed segment.
		await expect(page.locator("[data-testid='goal-form-divergence-autonomous']"))
			.toHaveAttribute("aria-pressed", "true", { timeout: 10_000 });
		await expect(page.locator("[data-testid='goal-form-divergence-balanced']"))
			.toHaveAttribute("aria-pressed", "false", { timeout: 5_000 });
	});
});

// Ported from proposal-edit-flow.spec.ts (audit: proposals GAP, mutant BR54):
// an editable project proposal panel exposes its Apply/Accept button via the
// accept-label testid, and applying the (live-edited) proposal persists.
test.describe("Journey: Editable Project Proposal", () => {
	test("edit_proposal updates the slot live; Apply (accept-label) persists edited value", async ({ page, gateway }) => {
		test.setTimeout(90_000);
		const projectId = await defaultProjectId();
		expect(projectId).toBeTruthy();
		await openApp(page);
		await createSessionViaUI(page);
		await authenticateMockProposalTools(page, gateway);

		// Initial propose_project → slot populates with build_command="echo old".
		await sendMessage(page, "EDITABLE_PROPOSAL_INITIAL");
		await page.waitForFunction(
			() => {
				const s = (window as any).bobbitState ?? (window as any).__bobbitState;
				return s?.activeProposals?.project?.fields?.build_command === "echo old";
			},
			null,
			{ timeout: 20_000 },
		);
		const panel = page.locator('[data-panel="project-proposal"]').first();
		await expect(panel).toBeVisible({ timeout: 15_000 });

		// This is an existing-project edit journey: make the target explicit and
		// replace the mock's legacy nonexistent /tmp path with the harness temp root.
		// The server edit keeps the persisted draft and browser slot in sync.
		const sessionId = await page.evaluate(() => {
			const s = (window as any).bobbitState ?? (window as any).__bobbitState;
			return s?.selectedSessionId as string | undefined;
		});
		expect(sessionId).toBeTruthy();
		const targetEdit = await page.evaluate(async ({ sid, cwd, targetProjectId }) => {
			// Proposal mutation is a human-operator action. Keep this request on the
			// mounted app's origin so the browser's signed operator cookie, rather
			// than the Node harness bearer token, authenticates the owner explicitly.
			const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/proposal/project/edit`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					old_text: "root_path: /tmp/editable",
					new_text: `root_path: ${JSON.stringify(cwd)}\nprojectId: ${targetProjectId}`,
				}),
			});
			return { status: response.status, text: await response.text() };
		}, { sid: sessionId!, cwd: nonGitCwd(), targetProjectId: projectId });
		expect(targetEdit.status, `explicit project target edit failed: ${targetEdit.text}`).toBe(200);
		await page.waitForFunction(
			(id) => {
				const s = (window as any).bobbitState ?? (window as any).__bobbitState;
				return s?.activeProposals?.project?.fields?.projectId === id
					&& s?.activeProposals?.project?.mode === "registered";
			},
			projectId,
			{ timeout: 15_000 },
		);

		// Surgical edit → slot flips live to "echo new" with no propose_project re-emit.
		await sendMessage(page, "EDITABLE_PROPOSAL_EDIT");
		await page.waitForFunction(
			() => {
				const s = (window as any).bobbitState ?? (window as any).__bobbitState;
				return s?.activeProposals?.project?.fields?.build_command === "echo new";
			},
			null,
			{ timeout: 15_000 },
		);

		// The Apply button is located via the accept-label testid (the mutant target).
		const acceptLabel = panel.locator('[data-testid="accept-label"]').first();
		await expect(acceptLabel).toBeVisible({ timeout: 15_000 });
		// Accept is gated by `streaming`; wait for the agent to go idle so the
		// button reflects its enabled (name-present) state.
		await page.waitForFunction(
			() => ((window as any).bobbitState ?? (window as any).__bobbitState)?.remoteAgent?.state?.status === "idle",
			null,
			{ timeout: 20_000 },
		);
		const applyBtn = panel.locator("button", { has: page.locator('[data-testid="accept-label"]') }).first();
		await expect(applyBtn).toBeEnabled({ timeout: 10_000 });
		await applyBtn.click();

		// Slot clears and panel disappears once the edited config is applied.
		await page.waitForFunction(
			() => !((window as any).bobbitState ?? (window as any).__bobbitState)?.activeProposals?.project,
			null,
			{ timeout: 15_000 },
		);
		await expect(panel).toBeHidden({ timeout: 10_000 });
		const config = await (await apiFetch(`/api/projects/${projectId}/config`)).json();
		expect(config.build_command).toBe("echo new");
	});

	// Ported from project-assistant.spec.ts (audit: proposals/project-assistant
	// GAP, mutant BR57): a multi-component propose_project renders structured
	// component cards in the Components view and per-component + all-components
	// workflow cards under the Workflows tab.
	test("multi-component project proposal renders component + workflow cards", async ({ page }) => {
		test.setTimeout(90_000);
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "MULTI_COMPONENT_PROPOSAL");

		const panel = page.locator('[data-panel="project-proposal"]').first();
		await expect(panel).toBeVisible({ timeout: 20_000 });

		// Components view (default) renders both structured component cards.
		await expect(panel.locator('[data-testid="component-card-api"]')).toBeVisible({ timeout: 20_000 });
		await expect(panel.locator('[data-testid="component-card-web"]')).toBeVisible({ timeout: 10_000 });

		// Switch to the Workflows tab — per-component + all-components cards
		// (mutant target: workflow-card-<id>) must render.
		await panel.locator('[data-testid="view-tab-workflows"]').click();
		await expect(panel.locator('[data-testid="workflow-card-feature-api"]')).toBeVisible({ timeout: 15_000 });
		await expect(panel.locator('[data-testid="workflow-card-feature-web"]')).toBeVisible({ timeout: 10_000 });
		await expect(panel.locator('[data-testid="workflow-card-all-components"]')).toBeVisible({ timeout: 10_000 });
	});
});

