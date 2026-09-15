import type { Route } from "@playwright/test";
import { test, expect, openApp, navigateToHash, createSession, deleteSession, registerProject, apiFetch } from "../../support/helpers/browser/journeys/journey-fixture.js";
import { createMcpWorktreeApprovalFixture, WORKTREE_SERVER_NAME } from "../../support/browser/mcp-project-approval-fixture.js";

test.use({ enableMcp: true, gatewayStateGroup: "mcp-worktree-approval" });

test("worktree MCP review scope survives navigation, decisions, reload, and request races", async ({ page, gateway }) => {
	test.setTimeout(120_000);
	const fixture = createMcpWorktreeApprovalFixture();
	const projectName = `Worktree Approval ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
	let projectId = "";
	let sessionId = "";
	const approvalRequests: string[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.pathname.endsWith(`/api/mcp-servers/${WORKTREE_SERVER_NAME}/approval`)) approvalRequests.push(request.url());
	});

	try {
		const project = await registerProject({ name: projectName, rootPath: fixture.projectRoot, seedWorkflows: false });
		projectId = project.id;
		// Create through the ordinary API, then model the server-owned worktree
		// coordinates that real session provisioning persists outside projectRoot.
		sessionId = await createSession({ projectId, cwd: fixture.projectRoot });
		const sessionManager = gateway.sessionManager as any;
		const liveSession = sessionManager.getSession(sessionId);
		const persistedSession = sessionManager.getPersistedSession(sessionId);
		expect(liveSession).toBeTruthy();
		expect(persistedSession?.projectId).toBe(projectId);
		const worktreeCoordinates = {
			cwd: fixture.worktreeRoot,
			worktreePath: fixture.worktreeRoot,
			repoPath: fixture.projectRoot,
			branch: "session/approval-browser",
		};
		Object.assign(liveSession, worktreeCoordinates);
		sessionManager.getSessionStore(projectId).update(sessionId, worktreeCoordinates);
		sessionManager.mcpSessionScopes.delete(sessionId);
		const worktreeScope = `projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(sessionId)}&cwd=${encodeURIComponent(fixture.worktreeRoot)}`;

		await openApp(page);
		await navigateToHash(page, `#/session/${sessionId}`);
		const banner = page.locator('[data-testid="mcp-approval-banner"]');
		await expect(banner).toBeVisible({ timeout: 20_000 });
		await expect(banner.locator('[data-testid="mcp-approval-banner-count"]')).toHaveText("1");

		const worktreeLoad = page.waitForResponse((response) => {
			const url = new URL(response.url());
			return url.pathname.endsWith("/api/mcp-servers")
				&& url.searchParams.get("projectId") === projectId
				&& url.searchParams.get("sessionId") === sessionId
				&& url.searchParams.get("goalId") === null
				&& url.searchParams.get("cwd") === fixture.worktreeRoot;
		});
		await banner.locator('[data-testid="mcp-review-servers"]').click();
		await worktreeLoad;
		await expect(page).toHaveURL(new RegExp(`#\\/tools\\?reviewSession=${sessionId}$`));

		let row = page.locator(`[data-testid="mcp-server-row"][data-server-name="${WORKTREE_SERVER_NAME}"]`);
		await expect(row.locator('[data-testid="mcp-approval-status"]')).toHaveText("Pending approval", { timeout: 20_000 });
		if (await row.locator('[data-testid="mcp-server-toggle"]').getAttribute("aria-expanded") !== "true") {
			await row.locator('[data-testid="mcp-server-toggle"]').click();
		}
		await expect(row.locator('[data-testid="mcp-review-panel"]')).toContainText("--variant worktree-v1");

		await expect(page.locator('[data-testid="mcp-pairing-callout"]')).toHaveCount(0);
		await row.locator('[data-testid="mcp-approve-server"]').click();
		await expect(row.locator('[data-testid="mcp-approval-status"]')).toHaveText("Approved", { timeout: 20_000 });
		expect(approvalRequests).toHaveLength(1);
		const approvalUrl = new URL(approvalRequests[0]);
		expect(approvalUrl.searchParams.get("projectId")).toBe(projectId);
		expect(approvalUrl.searchParams.get("sessionId")).toBe(sessionId);
		expect(approvalUrl.searchParams.get("goalId")).toBeNull();
		expect(approvalUrl.searchParams.get("cwd")).toBe(fixture.worktreeRoot);

		// The opaque owner id in the route recovers the authoritative cwd after reload.
		const reloadScope = page.waitForResponse((response) => {
			const url = new URL(response.url());
			return url.pathname.endsWith("/api/mcp-servers")
				&& url.searchParams.get("projectId") === projectId
				&& url.searchParams.get("sessionId") === sessionId
				&& url.searchParams.get("goalId") === null
				&& url.searchParams.get("cwd") === fixture.worktreeRoot;
		});
		await page.reload();
		await reloadScope;
		await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
		await expect(page).toHaveURL(new RegExp(`#\\/tools\\?reviewSession=${sessionId}$`));
		row = page.locator(`[data-testid="mcp-server-row"][data-server-name="${WORKTREE_SERVER_NAME}"]`);
		await expect(row.locator('[data-testid="mcp-approval-status"]')).toHaveText("Approved", { timeout: 20_000 });
		await expect(row.locator('[data-testid="mcp-server-status"]')).toHaveText("connected");

		fixture.writeWorktree("v2");
		const changed = await apiFetch(`/api/mcp-servers?${worktreeScope}&ensure=true`);
		expect(changed.status).toBe(200);
		await page.reload();
		row = page.locator(`[data-testid="mcp-server-row"][data-server-name="${WORKTREE_SERVER_NAME}"]`);
		await expect(row.locator('[data-testid="mcp-approval-status"]')).toHaveText("Configuration changed — review again", { timeout: 20_000 });
		if (await row.locator('[data-testid="mcp-server-toggle"]').getAttribute("aria-expanded") !== "true") {
			await row.locator('[data-testid="mcp-server-toggle"]').click();
		}
		await expect(row.locator('[data-testid="mcp-review-panel"]')).toContainText("--variant worktree-v2");
		await row.locator('[data-testid="mcp-approve-server"]').click();
		await expect(row.locator('[data-testid="mcp-approval-status"]')).toHaveText("Approved", { timeout: 20_000 });

		// A decision request already sent to the server may finish after the user
		// switches from a worktree review to plain project Tools. Its old-view UI
		// tail must not refresh worktree data over the new root view.
		fixture.writeWorktree("v3");
		const actionChange = await apiFetch(`/api/mcp-servers?${worktreeScope}&ensure=true`);
		expect(actionChange.status).toBe(200);
		await page.reload();
		row = page.locator(`[data-testid="mcp-server-row"][data-server-name="${WORKTREE_SERVER_NAME}"]`);
		await expect(row.locator('[data-testid="mcp-approval-status"]')).toHaveText("Configuration changed — review again", { timeout: 20_000 });
		if (await row.locator('[data-testid="mcp-server-toggle"]').getAttribute("aria-expanded") !== "true") {
			await row.locator('[data-testid="mcp-server-toggle"]').click();
		}
		await expect(row.locator('[data-testid="mcp-review-panel"]')).toContainText("--variant worktree-v3");

		let releaseApproval = () => {};
		let markApprovalStarted = () => {};
		const approvalGate = new Promise<void>((resolve) => { releaseApproval = resolve; });
		const approvalStarted = new Promise<void>((resolve) => { markApprovalStarted = resolve; });
		const delayedApprovalHandler = async (route: Route): Promise<void> => {
			const request = route.request();
			const url = new URL(request.url());
			if (request.method() === "POST" && url.searchParams.get("cwd") === fixture.worktreeRoot) {
				expect(url.searchParams.get("projectId")).toBe(projectId);
				expect(url.searchParams.get("sessionId")).toBe(sessionId);
				expect(url.searchParams.get("goalId")).toBeNull();
				markApprovalStarted();
				await approvalGate;
			}
			await route.continue();
		};
		await page.route("**/api/mcp-servers/**/approval?**", delayedApprovalHandler);
		const delayedApprovalResponse = page.waitForResponse((response) => {
			const url = new URL(response.url());
			return response.request().method() === "POST"
				&& url.pathname.endsWith(`/api/mcp-servers/${WORKTREE_SERVER_NAME}/approval`)
				&& url.searchParams.get("cwd") === fixture.worktreeRoot;
		});
		await row.locator('[data-testid="mcp-approve-server"]').click();
		await approvalStarted;
		await page.getByRole("button", { name: projectName, exact: true }).click();
		await expect(page).toHaveURL(/#\/tools$/);
		row = page.locator(`[data-testid="mcp-server-row"][data-server-name="${WORKTREE_SERVER_NAME}"]`);
		await expect(row.locator('[data-testid="mcp-approval-status"]')).toHaveText("Configuration changed — review again", { timeout: 20_000 });
		if (await row.locator('[data-testid="mcp-server-toggle"]').getAttribute("aria-expanded") !== "true") {
			await row.locator('[data-testid="mcp-server-toggle"]').click();
		}
		await expect(row.locator('[data-testid="mcp-review-panel"]')).toContainText("--variant root");
		await expect(row.locator('[data-testid="mcp-approve-server"]')).toBeEnabled();
		releaseApproval();
		expect((await delayedApprovalResponse).status()).toBe(200);
		await page.waitForTimeout(500);
		await expect(page).toHaveURL(/#\/tools$/);
		await expect(row.locator('[data-testid="mcp-approval-status"]')).toHaveText("Configuration changed — review again");
		await expect(row.locator('[data-testid="mcp-review-panel"]')).toContainText("--variant root");
		await expect(page.getByText("--variant worktree-v3", { exact: false })).toHaveCount(0);
		await expect(row.locator('[data-testid="mcp-approve-server"]')).toBeEnabled();
		await page.unroute("**/api/mcp-servers/**/approval?**", delayedApprovalHandler);

		// A late worktree response cannot overwrite the root project scope chosen
		// while it is in flight. The behaviorally different root definition stays unapproved.
		fixture.writeWorktree("v4");
		const racedChange = await apiFetch(`/api/mcp-servers?${worktreeScope}&ensure=true`);
		expect(racedChange.status).toBe(200);
		await navigateToHash(page, `#/session/${sessionId}`);
		await expect(banner).toBeVisible({ timeout: 20_000 });
		let delayWorktree = true;
		await page.route("**/api/mcp-servers?**", async (route) => {
			const url = new URL(route.request().url());
			if (delayWorktree && url.searchParams.get("cwd") === fixture.worktreeRoot) {
				expect(url.searchParams.get("projectId")).toBe(projectId);
				expect(url.searchParams.get("sessionId")).toBe(sessionId);
				expect(url.searchParams.get("goalId")).toBeNull();
				delayWorktree = false;
				await new Promise((resolve) => setTimeout(resolve, 750));
			}
			await route.continue();
		});
		const lateWorktreeResponse = page.waitForResponse((response) => {
			const url = new URL(response.url());
			return url.pathname.endsWith("/api/mcp-servers") && url.searchParams.get("cwd") === fixture.worktreeRoot;
		});
		await banner.locator('[data-testid="mcp-review-servers"]').click();
		await expect(page).toHaveURL(/#\/tools\?reviewSession=/);
		await page.getByRole("button", { name: projectName, exact: true }).click();
		await expect(page).toHaveURL(/#\/tools$/);
		row = page.locator(`[data-testid="mcp-server-row"][data-server-name="${WORKTREE_SERVER_NAME}"]`);
		await expect(row.locator('[data-testid="mcp-approval-status"]')).toHaveText("Configuration changed — review again", { timeout: 20_000 });
		if (await row.locator('[data-testid="mcp-server-toggle"]').getAttribute("aria-expanded") !== "true") {
			await row.locator('[data-testid="mcp-server-toggle"]').click();
		}
		await expect(row.locator('[data-testid="mcp-review-panel"]')).toContainText("--variant root");
		await lateWorktreeResponse;
		await expect(row.locator('[data-testid="mcp-review-panel"]')).toContainText("--variant root");
	} finally {
		if (sessionId) await deleteSession(sessionId).catch(() => {});
		if (projectId) await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
		fixture.cleanup();
	}
});
