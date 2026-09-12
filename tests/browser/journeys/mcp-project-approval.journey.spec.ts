import { test, expect, openApp, navigateToHash, createSession, deleteSession, registerProject, apiFetch } from "../../support/helpers/browser/journeys/journey-fixture.js";
import {
	createMcpProjectApprovalFixture,
	createMcpWorktreeApprovalFixture,
	LOCAL_SECRET,
	REMOTE_SECRET,
	LOCAL_SERVER_NAME,
	REMOTE_SERVER_NAME,
	WORKTREE_SERVER_NAME,
} from "../../support/browser/mcp-project-approval-fixture.js";

test.use({ enableMcp: true, gatewayStateGroup: "mcp-project-approval" });
test.describe.configure({ mode: "serial" });

test("project MCP startup approval is deliberate, safe, scoped, durable, and invalidated by configuration changes", async ({ page, gateway }) => {
	test.setTimeout(120_000);
	const fixture = createMcpProjectApprovalFixture();
	const pairingCode = gateway.createMcpOperatorPairingCode().code;
	const approvalRequests: string[] = [];
	page.on("request", (request) => {
		if (new URL(request.url()).pathname.includes("/api/mcp-servers/") && new URL(request.url()).pathname.endsWith("/approval")) {
			approvalRequests.push(request.url());
		}
	});
	const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
	const primaryName = `Approval Project ${stamp}`;
	const secondaryName = `Introduced Service ${stamp}`;
	let primaryProjectId = "";
	let secondaryProjectId = "";
	let sessionId = "";

	try {
		const primary = await registerProject({ name: primaryName, rootPath: fixture.primaryRoot, seedWorkflows: false });
		primaryProjectId = primary.id;
		const secondary = await registerProject({ name: secondaryName, rootPath: fixture.secondaryRoot, seedWorkflows: false });
		secondaryProjectId = secondary.id;
		sessionId = await createSession({ projectId: primaryProjectId, cwd: fixture.primaryRoot });

		await openApp(page);
		await navigateToHash(page, `#/session/${sessionId}`);

		const banner = page.locator('[data-testid="mcp-approval-banner"]');
		await expect(banner).toBeVisible({ timeout: 20_000 });
		await expect(banner.locator('[data-testid="mcp-approval-banner-count"]')).toHaveText("2");
		await expect(banner).toContainText(`2 MCP servers need review for ${primaryName}.`);

		const scopedMcpLoad = page.waitForResponse((response) => {
			const url = new URL(response.url());
			return url.pathname.endsWith("/api/mcp-servers") && url.searchParams.get("projectId") === primaryProjectId;
		});
		await banner.locator('[data-testid="mcp-review-servers"]').click();
		await scopedMcpLoad;
		await expect(page).toHaveURL(/#\/tools$/);

		const section = page.locator('[data-testid="mcp-section"]');
		await expect(section).toBeVisible({ timeout: 20_000 });
		await expect(section).toContainText("2 servers · 2 need review");
		await expect(section.getByText(/Approve all/i)).toHaveCount(0);

		const focusedReviewToggle = section.locator('[data-testid="mcp-server-toggle"]:focus');
		await expect(focusedReviewToggle).toHaveCount(1);
		await expect(focusedReviewToggle).toHaveAttribute("aria-expanded", "true");

		const pairingCallout = section.locator('[data-testid="mcp-pairing-callout"]');
		let pairingInput = pairingCallout.locator('[data-testid="mcp-pairing-code"]');
		await expect(pairingCallout).toContainText("Pair this browser to approve or reject project MCP servers.");
		await expect(pairingInput).toHaveAttribute("type", "password");
		await expect(pairingInput).toHaveAttribute("autocomplete", "off");
		await expect(pairingInput).toHaveAttribute("spellcheck", "false");

		await pairingInput.fill("used-or-wrong-code");
		await pairingCallout.locator('[data-testid="mcp-pair-browser"]').click();
		await expect(pairingCallout.locator('[data-testid="mcp-pairing-error"]')).toContainText("invalid, expired, or already used");
		await expect(pairingInput).toBeFocused();
		expect(approvalRequests).toHaveLength(0);

		pairingInput = pairingCallout.locator('[data-testid="mcp-pairing-code"]');
		const pairedResponse = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/api/mcp-operator/pair") && response.request().method() === "POST");
		await pairingInput.fill(pairingCode);
		await pairingCallout.locator('[data-testid="mcp-pair-browser"]').click();
		expect((await pairedResponse).status()).toBe(200);
		await expect(pairingCallout.locator('[data-testid="mcp-pairing-notice"]')).toContainText("no decision was made");
		await expect(pairingCallout.locator('[data-testid="mcp-pairing-code"]')).toHaveCount(0);
		expect(approvalRequests).toHaveLength(0);
		expect(page.url()).not.toContain(pairingCode);
		expect(await page.locator("body").innerText()).not.toContain(pairingCode);
		expect(await page.content()).not.toContain(pairingCode);

		let localRow = section.locator(`[data-testid="mcp-server-row"][data-server-name="${LOCAL_SERVER_NAME}"]`);
		await expect(localRow).toBeVisible();
		const localToggle = localRow.locator('[data-testid="mcp-server-toggle"]');
		if (await localToggle.getAttribute("aria-expanded") !== "true") await localToggle.press("Enter");
		await expect(localToggle).toHaveAttribute("aria-expanded", "true");
		await expect(localRow.locator('[data-testid="mcp-approval-status"]')).toHaveText("Pending approval");
		await expect(localRow.locator('[data-testid="mcp-server-status"]')).toHaveText("Not started");
		await expect(localRow).toContainText("0 operations");
		await expect(localRow.getByText("Tool calls:", { exact: true })).toBeVisible();

		const localReview = localRow.locator('[data-testid="mcp-review-panel"]');
		await expect(localReview).toContainText(primaryName);
		await expect(localReview).toContainText(".mcp.json");
		await expect(localReview).toContainText("stdio");
		await expect(localReview).toContainText(process.execPath);
		await expect(localReview).toContainText("--token [redacted]");
		await expect(localReview).toContainText("--header Authorization: [redacted]");
		await expect(localReview).toContainText("--header=[redacted]");
		await expect(localReview).toContainText("-H Cookie: [redacted]");
		await expect(localReview).toContainText("-H=[redacted]");
		await expect(localReview).toContainText("-H[redacted]");
		await expect(localReview).toContainText("--proxy-header X-Proxy-Token: [redacted]");
		await expect(localReview).toContainText("--proxy-header=[redacted]");
		await expect(localReview).toContainText("Proxy-Authorization: [redacted]");
		await expect(localReview).toContainText("prefix-[redacted]-suffix");
		await expect(localReview).toContainText("--variant v1");
		await expect(localReview).toContainText("Working directory");
		await expect(localReview).toContainText("JOURNEY_API_TOKEN=[redacted]");

		const remoteRow = section.locator(`[data-testid="mcp-server-row"][data-server-name="${REMOTE_SERVER_NAME}"]`);
		await expect(remoteRow).toBeVisible();
		const remoteToggle = remoteRow.locator('[data-testid="mcp-server-toggle"]');
		if (await remoteToggle.getAttribute("aria-expanded") !== "true") await remoteToggle.press("Enter");
		await expect(remoteToggle).toHaveAttribute("aria-expanded", "true");
		const remoteReview = remoteRow.locator('[data-testid="mcp-review-panel"]');
		await expect(remoteReview).toContainText(secondaryName);
		await expect(remoteReview).toContainText("http");
		await expect(remoteReview).toContainText("http://127.0.0.1:9/mcp");
		await expect(remoteReview).toContainText("Authorization: [redacted]");
		const safeHtml = await page.content();
		expect(safeHtml).not.toContain(LOCAL_SECRET);
		expect(safeHtml).not.toContain(REMOTE_SECRET);
		expect(safeHtml).not.toContain("access_token=");

		await localRow.locator('[data-testid="mcp-server-policy"]').selectOption("ask");
		await expect(localRow.locator('[data-testid="mcp-server-policy"]')).toHaveValue("ask");

		await remoteRow.locator('[data-testid="mcp-reject-server"]').click();
		await expect(remoteRow.locator('[data-testid="mcp-approval-status"]')).toHaveText("Rejected", { timeout: 15_000 });
		await expect(remoteRow.locator('[data-testid="mcp-server-status"]')).toHaveText("Not started");
		await expect(remoteRow.locator('[data-testid="mcp-approve-server"]')).toHaveText("Approve current configuration");

		// Change the file after it has been rendered. The stale fingerprint must be
		// rejected, and the row must refresh in place to the safe current metadata.
		fixture.writePrimary("v2");
		await localRow.locator('[data-testid="mcp-approve-server"]').click();
		await expect(localRow.locator('[data-testid="mcp-approval-error"]')).toHaveText(
			"Configuration changed while you were reviewing it. Review the current configuration before deciding.",
			{ timeout: 15_000 },
		);
		await expect(localRow.locator('[data-testid="mcp-server-toggle"]')).toHaveAttribute("aria-expanded", "true");
		await expect(localRow.locator('[data-testid="mcp-review-panel"]')).toContainText("--variant v2");
		await expect(localRow.locator('[data-testid="mcp-server-toggle"]')).toBeFocused();

		await localRow.locator('[data-testid="mcp-approve-server"]').click();
		await expect(localRow.locator('[data-testid="mcp-approval-status"]')).toHaveText("Approved", { timeout: 20_000 });
		await expect(localRow.locator('[data-testid="mcp-server-status"]')).toHaveText("connected");
		await expect(localRow).toContainText("2 operations");
		await expect(localRow.locator('[data-testid="mcp-server-policy"]')).toHaveValue("ask");
		await expect(banner).toHaveCount(0, { timeout: 15_000 });

		// The paired capability, decision, and independent invocation policy survive a hard reload.
		await page.reload();
		await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
		await expect.poll(() => page.evaluate(() => {
			const raw = localStorage.getItem("mcp.operator.credentials.v1");
			if (!raw) return false;
			try {
				const stored = JSON.parse(raw) as Record<string, unknown>;
				return typeof stored[window.location.origin] === "string";
			} catch {
				return false;
			}
		})).toBe(true);
		await page.getByRole("button", { name: primaryName, exact: true }).click();
		await expect(page.locator('[data-testid="mcp-pairing-callout"]')).toHaveCount(0);
		localRow = page.locator(`[data-testid="mcp-server-row"][data-server-name="${LOCAL_SERVER_NAME}"]`);
		await expect(localRow.locator('[data-testid="mcp-approval-status"]')).toHaveText("Approved", { timeout: 20_000 });
		await expect(localRow.locator('[data-testid="mcp-server-status"]')).toHaveText("connected");
		await expect(localRow.locator('[data-testid="mcp-server-policy"]')).toHaveValue("ask");
		await expect(page.locator('[data-testid="mcp-approval-banner"]')).toHaveCount(0);

		// A behavior change while the zero-count banner is absent on Tools must be
		// discovered without a reload or an active session WebSocket.
		fixture.writePrimary("v3");
		const changedResponse = await apiFetch(`/api/mcp-servers?projectId=${encodeURIComponent(primaryProjectId)}&ensure=true`);
		expect(changedResponse.status).toBe(200);
		const changedBanner = page.locator('[data-testid="mcp-approval-banner"]');
		await expect(changedBanner).toBeVisible({ timeout: 20_000 });
		await expect(changedBanner.locator('[data-testid="mcp-approval-banner-count"]')).toHaveText("1");
		await changedBanner.locator('[data-testid="mcp-review-servers"]').click();

		localRow = page.locator(`[data-testid="mcp-server-row"][data-server-name="${LOCAL_SERVER_NAME}"]`);
		const changedToggle = localRow.locator('[data-testid="mcp-server-toggle"]');
		await expect(localRow.locator('[data-testid="mcp-approval-status"]')).toHaveText("Configuration changed — review again");
		await expect(localRow.locator('[data-testid="mcp-server-status"]')).toHaveText("Not started");
		await expect(changedToggle).toHaveAttribute("aria-expanded", "true");
		await expect(changedToggle).toBeFocused();
		await expect(localRow.locator('[data-testid="mcp-review-panel"]')).toContainText("--variant v3");
		await expect(localRow.locator('[data-testid="mcp-approve-server"]')).toHaveText("Approve current configuration");

		await page.setViewportSize({ width: 767, height: 800 });
		await expect.poll(() => localRow.locator(".mcp-review-grid").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(/\s+/).length)).toBe(1);
		const approveBox = await localRow.locator('[data-testid="mcp-approve-server"]').boundingBox();
		expect(approveBox?.height).toBeGreaterThanOrEqual(44);

		await localRow.locator('[data-testid="mcp-approve-server"]').click();
		await expect(localRow.locator('[data-testid="mcp-approval-status"]')).toHaveText("Approved", { timeout: 20_000 });
		await expect(localRow.locator('[data-testid="mcp-server-status"]')).toHaveText("connected");
		await expect(changedBanner).toHaveCount(0, { timeout: 15_000 });

		// Rejection is reversible and never becomes a connection error.
		await localRow.locator('[data-testid="mcp-reject-server"]').click();
		await expect(page.getByText(`Reject ${LOCAL_SERVER_NAME}?`, { exact: true })).toBeVisible();
		await page.keyboard.press("Enter");
		await expect(localRow.locator('[data-testid="mcp-approval-status"]')).toHaveText("Rejected", { timeout: 15_000 });
		await expect(localRow.locator('[data-testid="mcp-server-status"]')).toHaveText("Not started");
		await expect(localRow.locator('[data-testid="mcp-approve-server"]')).toHaveText("Approve current configuration");
		await localRow.locator('[data-testid="mcp-approve-server"]').click();
		await expect(localRow.locator('[data-testid="mcp-approval-status"]')).toHaveText("Approved", { timeout: 20_000 });
		await expect(localRow.locator('[data-testid="mcp-server-status"]')).toHaveText("connected");
	} finally {
		if (sessionId) await deleteSession(sessionId).catch(() => {});
		if (secondaryProjectId) await apiFetch(`/api/projects/${encodeURIComponent(secondaryProjectId)}`, { method: "DELETE" }).catch(() => {});
		if (primaryProjectId) await apiFetch(`/api/projects/${encodeURIComponent(primaryProjectId)}`, { method: "DELETE" }).catch(() => {});
		fixture.cleanup();
	}
});

test("worktree MCP review scope survives navigation, decisions, reload, and request races", async ({ page, gateway }) => {
	test.setTimeout(120_000);
	const fixture = createMcpWorktreeApprovalFixture();
	const pairingCode = gateway.createMcpOperatorPairingCode().code;
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
		sessionId = await createSession({ projectId, cwd: fixture.worktreeRoot });

		await openApp(page);
		await navigateToHash(page, `#/session/${sessionId}`);
		const banner = page.locator('[data-testid="mcp-approval-banner"]');
		await expect(banner).toBeVisible({ timeout: 20_000 });
		await expect(banner.locator('[data-testid="mcp-approval-banner-count"]')).toHaveText("1");

		const worktreeLoad = page.waitForResponse((response) => {
			const url = new URL(response.url());
			return url.pathname.endsWith("/api/mcp-servers")
				&& url.searchParams.get("projectId") === projectId
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

		const pairing = page.locator('[data-testid="mcp-pairing-callout"]');
		await pairing.locator('[data-testid="mcp-pairing-code"]').fill(pairingCode);
		await pairing.locator('[data-testid="mcp-pair-browser"]').click();
		await expect(pairing.locator('[data-testid="mcp-pairing-notice"]')).toBeVisible();
		await row.locator('[data-testid="mcp-approve-server"]').click();
		await expect(row.locator('[data-testid="mcp-approval-status"]')).toHaveText("Approved", { timeout: 20_000 });
		expect(approvalRequests).toHaveLength(1);
		const approvalUrl = new URL(approvalRequests[0]);
		expect(approvalUrl.searchParams.get("projectId")).toBe(projectId);
		expect(approvalUrl.searchParams.get("cwd")).toBe(fixture.worktreeRoot);

		// The opaque owner id in the route recovers the authoritative cwd after reload.
		await page.reload();
		await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
		await expect(page).toHaveURL(new RegExp(`#\\/tools\\?reviewSession=${sessionId}$`));
		row = page.locator(`[data-testid="mcp-server-row"][data-server-name="${WORKTREE_SERVER_NAME}"]`);
		await expect(row.locator('[data-testid="mcp-approval-status"]')).toHaveText("Approved", { timeout: 20_000 });
		await expect(row.locator('[data-testid="mcp-server-status"]')).toHaveText("connected");

		fixture.writeWorktree("v2");
		const changed = await apiFetch(`/api/mcp-servers?projectId=${encodeURIComponent(projectId)}&cwd=${encodeURIComponent(fixture.worktreeRoot)}&ensure=true`);
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

		// A late worktree response cannot overwrite the root project scope chosen
		// while it is in flight. The behaviorally different root definition stays unapproved.
		fixture.writeWorktree("v3");
		const racedChange = await apiFetch(`/api/mcp-servers?projectId=${encodeURIComponent(projectId)}&cwd=${encodeURIComponent(fixture.worktreeRoot)}&ensure=true`);
		expect(racedChange.status).toBe(200);
		await navigateToHash(page, `#/session/${sessionId}`);
		await expect(banner).toBeVisible({ timeout: 20_000 });
		let delayWorktree = true;
		await page.route("**/api/mcp-servers?**", async (route) => {
			const url = new URL(route.request().url());
			if (delayWorktree && url.searchParams.get("cwd") === fixture.worktreeRoot) {
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
