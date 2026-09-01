/**
 * Journey: Current-session goal promotion
 * Covers the proposal selector, owner-scoped acceptance, continuity across page
 * reload, the unavailable reason, and the unchanged new-worktree control path.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GatewayInfo } from "../../support/harnesses/browser/gateway-harness.js";
import {
	test,
	expect,
	apiFetch,
	deleteSession,
	openApp,
	navigateToHash,
	registerProject,
	waitForSessionStatus,
} from "../../support/helpers/browser/journeys/journey-fixture.js";

async function responseJson(response: Response): Promise<any> {
	const text = await response.text();
	expect(response.ok, text).toBe(true);
	return text ? JSON.parse(text) : {};
}

type GitSessionFixture = {
	root: string;
	id: string;
	projectId: string;
};

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "pipe" });
}

async function createGitSession(worktree: boolean): Promise<GitSessionFixture> {
	const runRoot = process.env.BOBBIT_E2E_TMP_ROOT;
	if (!runRoot) throw new Error("BOBBIT_E2E_TMP_ROOT must identify the browser run root");
	const root = mkdtempSync(join(runRoot, "session-goal-promotion-"));
	const repo = join(root, "repo");
	let projectId = "";
	try {
		git(root, "init", "--initial-branch=main", repo);
		git(repo, "config", "user.name", "Session Goal Promotion Journey");
		git(repo, "config", "user.email", "session-goal-promotion@example.invalid");
		writeFileSync(join(repo, "README.md"), "session goal promotion fixture\n");
		git(repo, "add", "README.md");
		git(repo, "commit", "-m", "initial fixture");
		projectId = (await registerProject({
			name: `session-goal-promotion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			rootPath: repo,
			components: [{ name: "app", repo: ".", config: { qa_start_command: "echo ready" } }],
		})).id;
		const response = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: repo, projectId, worktree }),
		});
		const created = await responseJson(response);
		await waitForSessionStatus(created.id, "idle", 30_000);
		return { root, id: created.id, projectId };
	} catch (error) {
		if (projectId) await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		throw error;
	}
}

async function removeGitSession(fixture: GitSessionFixture): Promise<void> {
	await deleteSession(fixture.id).catch(() => {});
	await apiFetch(`/api/projects/${fixture.projectId}`, { method: "DELETE" }).catch(() => {});
	try {
		rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	} catch {
		// Git can retain a short-lived handle after session or goal cleanup on Windows.
	}
}

async function sessionRecord(id: string): Promise<any> {
	return responseJson(await apiFetch(`/api/sessions/${id}?include=archived`));
}

function sessionCapabilityHeaders(gateway: GatewayInfo, sessionId: string): Record<string, string> {
	const secret = gateway.sessionManager?.sessionSecretStore?.getOrCreateSecret(sessionId);
	expect(secret, `session ${sessionId} needs its server-minted proposal capability`).toEqual(expect.any(String));
	return { "X-Bobbit-Session-Secret": secret };
}

async function seedGoalProposal(
	gateway: GatewayInfo,
	sessionId: string,
	projectId: string,
	title: string,
	selection?: { workflowId?: string; options?: string },
): Promise<void> {
	const workflowsBody = await responseJson(await apiFetch(`/api/workflows?projectId=${encodeURIComponent(projectId)}`));
	const workflows = Array.isArray(workflowsBody) ? workflowsBody : workflowsBody.workflows;
	expect(workflows?.length, "journey project needs a workflow").toBeGreaterThan(0);
	const workflow = selection?.workflowId
		? workflows.find((candidate: any) => candidate.id === selection.workflowId)
		: workflows[0];
	expect(workflow, `journey project needs workflow ${selection?.workflowId}`).toBeTruthy();
	await responseJson(await apiFetch(`/api/sessions/${sessionId}/proposal/goal/seed`, {
		method: "POST",
		headers: sessionCapabilityHeaders(gateway, sessionId),
		body: JSON.stringify({
			args: {
				title,
				spec: "Promote the exact proposal owner without replacing its checkout or transcript.",
				workflow: workflow.id,
				...(selection?.options ? { options: selection.options } : {}),
				projectId,
			},
		}),
	}));
}

async function liveGoals(): Promise<any[]> {
	const body = await responseJson(await apiFetch("/api/goals"));
	return Array.isArray(body) ? body : body.goals ?? [];
}

async function waitForGoalSetup(goalId: string): Promise<any> {
	let goal: any;
	await expect.poll(async () => {
		goal = await responseJson(await apiFetch(`/api/goals/${goalId}`));
		return goal.setupStatus;
	}, { timeout: 40_000, intervals: [100, 250, 500] }).toBe("ready");
	return goal;
}

async function teamRecord(goalId: string): Promise<any> {
	return responseJson(await apiFetch(`/api/goals/${goalId}/team`));
}

async function waitForTeamStarted(goalId: string): Promise<any> {
	let team: any;
	await expect.poll(async () => {
		const response = await apiFetch(`/api/goals/${goalId}/team`);
		const body = await response.text();
		let candidate: any;
		try {
			candidate = body ? JSON.parse(body) : {};
		} catch {
			candidate = {};
		}
		if (response.status === 200
			&& typeof candidate.teamLeadSessionId === "string"
			&& candidate.teamLeadSessionId.length > 0) {
			team = candidate;
			return "ready";
		}
		return `status=${response.status} body=${body || "<empty>"}`;
	}, {
		timeout: 30_000,
		intervals: [100, 250, 500],
		message: `team ${goalId} should start with a team lead`,
	}).toBe("ready");
	return team;
}

function transcriptSnapshot(gateway: GatewayInfo, sessionId: string): { path: string; bytes: string } {
	const transcriptPath = gateway.sessionManager?.getPersistedSession(sessionId)?.agentSessionFile;
	expect(transcriptPath, `session ${sessionId} should retain its transcript path`).toEqual(expect.any(String));
	return { path: transcriptPath, bytes: readFileSync(transcriptPath, "utf8") };
}

function promotionKickoff(title: string): string {
	return `You have been promoted to the team lead for the goal "${title}".  Proceed to complete the goal, following the instructions in your system prompt carefully.`;
}

function transcriptTextOccurrences(bytes: string, text: string): number {
	const escapedText = JSON.stringify(text).slice(1, -1);
	return bytes.split(escapedText).length - 1;
}

async function restartGateway(gateway: GatewayInfo): Promise<void> {
	await gateway.crash();
	await gateway.restart();
	await expect.poll(async () => {
		try {
			return (await apiFetch("/health")).ok;
		} catch {
			return false;
		}
	}, { timeout: 20_000, intervals: [250], message: "gateway should be healthy after restart" }).toBe(true);
}

async function waitForPromotionOwnership(
	gateway: GatewayInfo,
	sessionId: string,
	projectId: string,
	goalId: string,
): Promise<{ persisted: any; live: any; team: any }> {
	let persisted: any;
	let live: any;
	let team: any;
	await expect.poll(() => {
		persisted = gateway.sessionManager?.getPersistedSession(sessionId);
		live = gateway.sessionManager?.getSession(sessionId);
		team = gateway.teamManager?.getTeamState(goalId);
		return {
			persisted: {
				projectId: persisted?.projectId,
				goalId: persisted?.goalId,
				teamGoalId: persisted?.teamGoalId,
			},
			live: {
				projectId: live?.projectId,
				goalId: live?.goalId,
				teamGoalId: live?.teamGoalId,
			},
			team: {
				goalId: team?.goalId,
				teamLeadSessionId: team?.teamLeadSessionId,
			},
		};
	}, { message: "promotion acceptance must converge the durable session, live runtime, and team owner" }).toEqual({
		persisted: { projectId, goalId, teamGoalId: goalId },
		live: { projectId, goalId, teamGoalId: goalId },
		team: { goalId, teamLeadSessionId: sessionId },
	});
	return { persisted, live, team };
}

async function openSeededProposal(page: import("@playwright/test").Page, sessionId: string): Promise<void> {
	await openApp(page);
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("[data-testid='goal-form-worktree-mode']")).toBeVisible({ timeout: 20_000 });
}

test.describe("Journey: Current-session goal promotion", () => {
	test("selects Current session, promotes the original lead, survives restart, and cleans up in order", async ({ page, gateway }) => {
		test.setTimeout(180_000);
		const source = await createGitSession(true);
		let goalId: string | undefined;
		try {
			const before = await sessionRecord(source.id);
			expect(before.branch).toBeTruthy();
			expect(before.worktreePath).toBeTruthy();
			const canonicalWorktreePath = realpathSync.native(before.worktreePath);
			const transcriptBefore = transcriptSnapshot(gateway, source.id);
			const goalTitle = `Promote browser session ${Date.now()}`;
			const kickoff = promotionKickoff(goalTitle);
			await seedGoalProposal(
				gateway,
				source.id,
				source.projectId,
				goalTitle,
				{ workflowId: "feature", options: "QA testing" },
			);
			await openSeededProposal(page, source.id);

			const qaLabel = page.locator(".goal-preview-panel label", { hasText: "Enable QA Testing" }).first();
			const qaCheckbox = qaLabel.locator("input[type='checkbox'].toggle-switch");
			await expect(qaCheckbox).toBeChecked({ timeout: 20_000 });
			await expect(qaCheckbox).toBeEnabled();

			const newMode = page.locator("[data-testid='goal-form-worktree-new']");
			const currentMode = page.locator("[data-testid='goal-form-worktree-current-session']");
			const worktreeSelector = page.locator("[data-testid='goal-form-worktree-mode']");
			const worktreeSummary = page.locator("[data-testid='goal-form-worktree-summary']");
			await expect(newMode).toBeChecked();
			await expect(currentMode).toBeEnabled({ timeout: 20_000 });
			await worktreeSummary.click();
			const newOption = page.locator("[data-testid='goal-form-worktree-option-new']");
			const currentOption = page.locator("[data-testid='goal-form-worktree-option-current-session']");
			await expect(newOption).toBeVisible();
			await expect(newOption).toContainText("Create a dedicated branch and isolated checkout");
			await expect(currentOption).toContainText(before.branch);
			await expect(currentOption).toContainText(before.worktreePath);
			await worktreeSummary.press("ArrowDown");
			await expect(newOption).toBeFocused();
			await newOption.press("ArrowDown");
			await expect(currentOption).toBeFocused();
			await currentOption.press("Enter");
			await expect(worktreeSelector).not.toHaveAttribute("open", "");
			await expect(worktreeSummary).toBeFocused();
			await expect(currentMode).toBeChecked();
			await expect(worktreeSummary).toContainText("Current session");
			await expect(page.locator("[data-testid='goal-form-worktree-branch']")).toHaveText(before.branch);
			await expect(page.locator("[data-testid='goal-form-worktree-path']")).toHaveText(before.worktreePath);

			await page.reload();
			await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
			await expect(page.locator("[data-testid='goal-form-worktree-current-session']")).toBeChecked({ timeout: 20_000 });
			await expect(page.locator("[data-testid='goal-form-worktree-path']")).toHaveText(before.worktreePath);
			await expect(qaCheckbox).toBeChecked({ timeout: 20_000 });
			await qaCheckbox.click();
			await expect(qaCheckbox).not.toBeChecked();

			const acceptPath = `/api/sessions/${encodeURIComponent(source.id)}/proposal/goal/accept`;
			const acceptUrl = new URL(`${gateway.baseURL}${acceptPath}`);
			const acceptResponsePromise = page.waitForResponse((response) => {
				const candidate = new URL(response.url());
				return response.request().method() === "POST"
					&& candidate.origin === acceptUrl.origin
					&& candidate.pathname === acceptUrl.pathname
					&& candidate.search === "";
			});
			await page.locator("[data-testid='proposal-primary-submit'] button").click();
			const acceptResponse = await acceptResponsePromise;
			expect(acceptResponse.status(), await acceptResponse.text()).toBe(201);
			const acceptedBody = await acceptResponse.json() as any;
			const goal = acceptedBody?.goal ?? acceptedBody;
			expect(goal?.id, "promotion acceptance must return the adopted goal id").toEqual(expect.any(String));
			goalId = goal.id;
			const ownership = await waitForPromotionOwnership(gateway, source.id, source.projectId, goal.id);
			const after = await sessionRecord(source.id);
			const team = await teamRecord(goal.id);
			expect(ownership.persisted.id).toBe(source.id);
			expect(ownership.live.id).toBe(source.id);
			expect(ownership.team.agents ?? []).toHaveLength(0);
			expect(after.id).toBe(source.id);
			expect(after.branch).toBe(before.branch);
			expect(after.worktreePath).toBe(before.worktreePath);
			expect(after.goalId).toBe(goal.id);
			expect(after.teamGoalId).toBe(goal.id);
			expect(team.teamLeadSessionId).toBe(source.id);
			expect(team.agents ?? []).toHaveLength(0);
			expect(goal.worktreeOwnerSessionId).toBe(source.id);
			expect(goal.state).toBe("in-progress");
			expect(goal.title).toBe(goalTitle);
			expect(goal.enabledOptionalSteps ?? []).toEqual([]);
			await expect.poll(
				() => transcriptTextOccurrences(transcriptSnapshot(gateway, source.id).bytes, kickoff),
				{ timeout: 20_000, intervals: [50, 100, 250], message: "fresh promotion must append one exact kickoff" },
			).toBe(1);
			const transcriptAfterPromotion = transcriptSnapshot(gateway, source.id);
			expect(transcriptAfterPromotion.path).toBe(transcriptBefore.path);
			expect(transcriptAfterPromotion.bytes.startsWith(transcriptBefore.bytes), "promotion must retain the complete prior transcript as a prefix").toBe(true);

			await restartGateway(gateway);
			await waitForSessionStatus(source.id, "idle", 40_000);
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
			await navigateToHash(page, `#/session/${source.id}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });

			const restored = await sessionRecord(source.id);
			const restoredGoal = await responseJson(await apiFetch(`/api/goals/${goal.id}`));
			const restoredTeam = await teamRecord(goal.id);
			expect(restored.id).toBe(source.id);
			expect(restored.goalId).toBe(goal.id);
			expect(restored.teamGoalId).toBe(goal.id);
			expect(restored.branch).toBe(before.branch);
			expect(restored.worktreePath).toBe(before.worktreePath);
			expect(restoredGoal.worktreeOwnerSessionId).toBe(source.id);
			expect(restoredGoal.state).toBe("in-progress");
			expect(restoredGoal.branch).toBe(before.branch);
			expect(restoredGoal.worktreePath).toBe(before.worktreePath);
			expect(restoredTeam.teamLeadSessionId).toBe(source.id);
			expect(restoredTeam.agents ?? []).toHaveLength(0);
			const transcriptAfterRestart = transcriptSnapshot(gateway, source.id);
			expect(transcriptAfterRestart.path).toBe(transcriptBefore.path);
			expect(transcriptAfterRestart.bytes.startsWith(transcriptBefore.bytes), "restart must preserve the complete pre-promotion transcript prefix").toBe(true);
			expect(transcriptTextOccurrences(transcriptAfterRestart.bytes, kickoff), "restart recovery must not duplicate the promotion kickoff").toBe(1);

			for (const suffix of ["", "?purge=true"]) {
				const blocked = await apiFetch(`/api/sessions/${source.id}${suffix}`, { method: "DELETE" });
				expect(blocked.status, `direct promoted-session cleanup ${suffix || "archive"} must be blocked`).toBe(409);
				const blockedBody = await blocked.json() as { code?: string };
				expect(blockedBody.code).toBe("PROMOTED_SESSION_LIFECYCLE_CONFLICT");
			}

			const guarded = await sessionRecord(source.id);
			const guardedGoal = await responseJson(await apiFetch(`/api/goals/${goal.id}`));
			const guardedTeam = await teamRecord(goal.id);
			expect(guarded).toMatchObject({
				id: source.id,
				goalId: goal.id,
				teamGoalId: goal.id,
				branch: before.branch,
				worktreePath: before.worktreePath,
			});
			expect(guardedGoal.archived).not.toBe(true);
			expect(guardedTeam.teamLeadSessionId).toBe(source.id);
			expect(existsSync(before.worktreePath)).toBe(true);
			const transcriptAfterGuardedCleanup = transcriptSnapshot(gateway, source.id);
			expect(transcriptAfterGuardedCleanup.path).toBe(transcriptAfterRestart.path);
			expect(transcriptAfterGuardedCleanup.bytes.startsWith(transcriptBefore.bytes), "guarded cleanup must preserve the prior transcript prefix").toBe(true);
			expect(transcriptTextOccurrences(transcriptAfterGuardedCleanup.bytes, kickoff), "guarded cleanup must not duplicate the promotion kickoff").toBe(1);

			const archived = await apiFetch(`/api/goals/${goal.id}?cascade=true`, { method: "DELETE" });
			expect(archived.status, await archived.clone().text()).toBe(200);
			await expect.poll(async () => (await responseJson(await apiFetch(`/api/goals/${goal.id}`))).archived, {
				timeout: 20_000,
				message: "goal archival must be durable before promoted lead teardown",
			}).toBe(true);
			await expect.poll(async () => (await apiFetch(`/api/goals/${goal.id}/team`)).status, {
				timeout: 20_000,
				message: "ordered archive must remove the active team reservation",
			}).toBe(404);
			await expect.poll(async () => (await sessionRecord(source.id)).status, {
				timeout: 20_000,
				message: "ordered archive must archive the original promoted lead",
			}).toBe("archived");
			expect((await liveGoals()).some(candidate => candidate.id === goal.id)).toBe(false);
			expect(existsSync(before.worktreePath), "archive alone must preserve the session-owned worktree").toBe(true);

			const purged = await apiFetch(`/api/sessions/${source.id}?purge=true`, { method: "DELETE" });
			expect(purged.status, await purged.clone().text()).toBe(200);
			// The purge route awaits its lifecycle owner through worktree cleanup and
			// durable store removal. Its response is the completion barrier: polling
			// after 200 would hide a leaked checkout as a timing race.
			expect({
				persistedSession: gateway.sessionManager?.getPersistedSession(source.id),
				sessionStatus: (await apiFetch(`/api/sessions/${source.id}?include=archived`)).status,
				canonicalWorktreeExists: existsSync(canonicalWorktreePath),
			}, "final source purge must remove both authoritative session state and the canonical adopted worktree").toEqual({
				persistedSession: undefined,
				sessionStatus: 404,
				canonicalWorktreeExists: false,
			});
			expect((await apiFetch(`/api/goals/${goal.id}/team`)).status).toBe(404);
			expect((await responseJson(await apiFetch(`/api/goals/${goal.id}`))).archived).toBe(true);
		} finally {
			if (goalId) await apiFetch(`/api/goals/${goalId}?cascade=true`, { method: "DELETE" }).catch(() => {});
			await removeGitSession(source);
		}
	});

	test("shows the authoritative reason when Current session is unavailable", async ({ page, gateway }) => {
		const source = await createGitSession(false);
		try {
			await seedGoalProposal(gateway, source.id, source.projectId, `Unavailable promotion ${Date.now()}`);
			await openSeededProposal(page, source.id);
			const current = page.locator("[data-testid='goal-form-worktree-current-session']");
			await expect(current).toBeDisabled({ timeout: 20_000 });
			const worktreeSelector = page.locator("[data-testid='goal-form-worktree-mode']");
			const worktreeSummary = page.locator("[data-testid='goal-form-worktree-summary']");
			await worktreeSummary.click();
			await expect(page.locator("[data-testid='goal-form-worktree-option-current-session']")).toBeVisible();
			await expect(page.locator("[data-testid='goal-form-worktree-option-current-session']")).toBeDisabled();
			await worktreeSummary.press("Escape");
			await expect(worktreeSelector).not.toHaveAttribute("open", "");
			await expect(worktreeSummary).toBeFocused();
			await expect(page.locator("[data-testid='goal-form-worktree-current-unavailable']")).toContainText(/.+/);
			await expect(page.locator("[data-testid='goal-form-worktree-new']")).toBeChecked();
			await expect(page.locator("[data-testid='proposal-primary-submit'] button")).toBeEnabled();
		} finally {
			await removeGitSession(source);
		}
	});

	test("keeps New worktree goal creation distinct from the proposal owner", async ({ page, gateway }) => {
		test.setTimeout(120_000);
		const source = await createGitSession(true);
		let goalId: string | undefined;
		try {
			const before = await sessionRecord(source.id);
			await seedGoalProposal(gateway, source.id, source.projectId, `New worktree control ${Date.now()}`);
			await openSeededProposal(page, source.id);
			await expect(page.locator("[data-testid='goal-form-worktree-new']")).toBeChecked();
			await page.locator("[data-testid='proposal-primary-submit'] button").click();
			await expect.poll(async () => {
				const goals = await liveGoals();
				const goal = goals.find((candidate) => candidate.title?.startsWith("New worktree control"));
				if (goal) goalId = goal.id;
				return goal?.id || "";
			}, { timeout: 40_000, intervals: [100, 250, 500] }).not.toBe("");
			const goal = await waitForGoalSetup(goalId!);
			const team = await waitForTeamStarted(goal.id);
			expect(goal.worktreePath).toBeTruthy();
			expect(goal.worktreePath).not.toBe(before.worktreePath);
			expect(goal.branch).not.toBe(before.branch);
			expect(team.teamLeadSessionId).toBeTruthy();
			expect(team.teamLeadSessionId).not.toBe(source.id);
			const ownerAfter = await sessionRecord(source.id);
			expect(ownerAfter.goalId).toBeFalsy();
		} finally {
			if (goalId) await apiFetch(`/api/goals/${goalId}?cascade=true`, { method: "DELETE" }).catch(() => {});
			await removeGitSession(source);
		}
	});
});
