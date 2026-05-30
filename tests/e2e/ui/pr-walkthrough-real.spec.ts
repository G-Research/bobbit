import type { Locator, Page, Route } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

const PANEL_TAB_SELECTOR = ".goal-preview-panel .goal-tab-pill[data-panel-tab-kind='walkthrough']";
const REAL_PR_URL = "https://github.com/SuuBro/bobbit/pull/999";
const tid = (id: string) => `[data-testid="${id}"]`;

interface MockWalkthroughState {
	mode: "success" | "missing" | "warnings";
	resolveCalls: unknown[];
	previewCalls: unknown[];
	submitCalls: unknown[];
	resolveDelay?: Promise<void>;
	jobsByChildSession?: Map<string, Record<string, any>>;
	jobsById?: Map<string, Record<string, any>>;
}

const realChangeset = {
	baseSha: "1111111111111111111111111111111111111111",
	headSha: "2222222222222222222222222222222222222222",
	provider: "github",
	prUrl: REAL_PR_URL,
	externalUrl: REAL_PR_URL,
	prNumber: 999,
	prTitle: "Real-ish walkthrough cards",
	title: "PR #999: Real-ish walkthrough cards",
	filesChanged: 3,
	additions: 41,
	deletions: 12,
};

const diffBlock = {
	id: "src-app-pr-walkthrough-ts",
	filePath: "src/app/pr-walkthrough.ts",
	status: "modified",
	externalUrl: "https://github.com/SuuBro/bobbit/blob/2222222/src/app/pr-walkthrough.ts",
	hunks: [{
		id: "src-app-pr-walkthrough-ts:h0",
		header: "@@ -120,6 +120,12 @@ export async function resolvePrWalkthrough",
		lines: [
			{ id: "src-app-pr-walkthrough-ts:h0:l0", side: "context", oldLine: 120, newLine: 120, text: "\tconst request = normalizeWalkthroughInput(input);", kind: "context" },
			{ id: "src-app-pr-walkthrough-ts:h0:l1", side: "new", newLine: 121, text: "\tconst resolved = await gatewayFetch('/api/pr-walkthrough/resolve', request);", kind: "add" },
			{ id: "src-app-pr-walkthrough-ts:h0:l2", side: "new", newLine: 122, text: "\tupdateWalkthroughTab(tabId, resolved);", kind: "add" },
		],
	}],
};

const persistedBlock = {
	id: "src-server-store-ts",
	filePath: "src/server/pr-walkthrough/walkthrough-store.ts",
	oldPath: "src/server/pr-walkthrough/store.ts",
	status: "renamed",
	hunks: [{
		id: "src-server-store-ts:h0",
		header: "@@ -30,7 +30,11 @@ export async function saveWalkthroughState",
		lines: [
			{ id: "src-server-store-ts:h0:l0", side: "context", oldLine: 30, newLine: 30, text: "\tconst key = storageKey(changesetId);", kind: "context" },
			{ id: "src-server-store-ts:h0:l1", side: "old", oldLine: 31, text: "\tawait writeJson(key, state);", kind: "del" },
			{ id: "src-server-store-ts:h0:l2", side: "new", newLine: 31, text: "\tawait writeJson(key, { schemaVersion: 1, ...state });", kind: "add" },
		],
	}],
};

const realCards = [
	{
		id: "real-orientation",
		phaseId: "orientation",
		title: "Resolved changeset overview",
		summary: "These cards were generated from a mocked resolver response rather than the fixture fallback.",
		diffBlocks: [diffBlock],
		checklist: ["Confirm the resolver request uses the PR URL", "Keep GitHub data at the adapter boundary"],
	},
	{
		id: "real-design",
		phaseId: "design",
		title: "Persist walkthrough state across routes",
		summary: "The server payload includes multiple diff blocks and should survive side panel, fullscreen, reload, and standalone usage.",
		diffBlocks: [diffBlock, persistedBlock],
		suggestedComments: [{
			id: "suggest-persist-schema",
			cardId: "real-design",
			diffBlockId: "src-server-store-ts",
			lineId: "src-server-store-ts:h0:l2",
			body: "Good call versioning the persisted walkthrough payload before restoring comments.",
		}],
		cardSuggestions: ["Call out the schema migration behavior in the final review."],
	},
	{
		id: "real-audit",
		phaseId: "audit",
		title: "Audit and export",
		summary: "Audit card summarises the review draft and export preview.",
		diffBlocks: [persistedBlock],
	},
];

const successPayload = {
	changesetId: "github:SuuBro/bobbit#999:2222222",
	changeset: realChangeset,
	cards: realCards,
	warnings: [],
	export: {
		provider: "github",
		available: true,
		canSubmit: true,
		reason: "GitHub token available in test mock",
	},
};

const warningPayload = {
	...successPayload,
	changesetId: "github:SuuBro/bobbit#1000:3333333",
	changeset: {
		...realChangeset,
		prNumber: 1000,
		prTitle: "Large private walkthrough",
		title: "PR #1000: Large private walkthrough",
		filesChanged: 48,
		additions: 1200,
		deletions: 300,
	},
	warnings: [
		{ code: "github-auth", severity: "warning", message: "GitHub token is required to load private review metadata." },
		{ code: "diff-truncated", severity: "warning", message: "Large diff truncated after 20 files; omitted generated snapshots.", filePath: "src/generated/snapshot.json" },
	],
};

function walkthroughPanel(page: Page): Locator {
	return page.getByTestId("pr-walkthrough-panel");
}

function activeCard(page: Page): Locator {
	return walkthroughPanel(page).locator(`${tid("pr-walkthrough-card")}[data-active="true"]`).first();
}

async function installMockWalkthroughApi(page: Page, state: MockWalkthroughState) {
	state.jobsByChildSession = new Map();
	state.jobsById = new Map();
	const routeHandler = async (route: Route) => {
		const request = route.request();
		const url = new URL(request.url());
		const method = request.method();
		let body: unknown;
		if (method !== "GET") {
			try {
				body = request.postDataJSON();
			} catch {
				body = undefined;
			}
		}

		if (url.pathname === "/api/pr-walkthrough/launch" && method === "POST") {
			state.resolveCalls.push(body);
			const requestBody = (body || {}) as Record<string, any>;
			const prNumber = String(requestBody.prNumber ?? /\/(\d+)$/.exec(String(requestBody.prUrl || ""))?.[1] ?? realChangeset.prNumber);
			const childTitle = state.mode === "missing" ? `PR #${prNumber} Walkthrough` : realChangeset.prTitle;
			const changesetId = state.mode === "warnings" ? warningPayload.changesetId : successPayload.changesetId;
			const jobId = `prw-real-${Date.now()}-${Math.random().toString(16).slice(2)}`;
			const targetKey = `github:SuuBro/bobbit#${prNumber}`;
			const createResponse = await apiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({
					worktree: false,
					parentSessionId: String(requestBody.sessionId || requestBody.parentSessionId || ""),
					childKind: "pr-walkthrough",
					readOnly: true,
					walkthroughJobId: jobId,
					walkthroughChangesetId: changesetId,
					walkthroughTargetKey: targetKey,
				}),
			});
			expect(createResponse.ok, `mock child session should be created: ${createResponse.status}`).toBe(true);
			const created = await createResponse.json() as { id: string };
			await apiFetch(`/api/sessions/${encodeURIComponent(created.id)}`, { method: "PATCH", body: JSON.stringify({ title: childTitle }) }).catch(() => undefined);
			const job = {
				schemaVersion: 1,
				jobId,
				parentSessionId: String(requestBody.sessionId || requestBody.parentSessionId || ""),
				childSessionId: created.id,
				cwd: "",
				target: { provider: "github", owner: "SuuBro", repo: "bobbit", number: Number(prNumber), prUrl: requestBody.prUrl || REAL_PR_URL, canonicalKey: targetKey },
				changesetId,
				tabId: `walkthrough:${encodeURIComponent(changesetId)}`,
				status: state.mode === "missing" ? "error" : "waiting_for_yaml",
				title: childTitle,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				error: state.mode === "missing" ? { code: "GITHUB_NOT_FOUND_OR_PRIVATE", message: `Pull request not found: #${prNumber}`, retryable: true } : undefined,
			};
			state.jobsByChildSession!.set(created.id, job);
			state.jobsById!.set(jobId, job);
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...job, created: true, job }) });
			return;
		}

		const sessionMatch = url.pathname.match(/^\/api\/pr-walkthrough\/session\/(.+)$/);
		if (sessionMatch && method === "GET") {
			const job = state.jobsByChildSession!.get(decodeURIComponent(sessionMatch[1]));
			await route.fulfill({ status: job ? 200 : 404, contentType: "application/json", body: JSON.stringify(job ? { job } : { error: "mock job not found" }) });
			return;
		}

		if (url.pathname === "/api/internal/pr-walkthrough/submit-yaml" && method === "POST") {
			const requestBody = (body || {}) as Record<string, any>;
			const job = state.jobsById!.get(String(requestBody.jobId));
			if (!job || job.childSessionId !== requestBody.sessionId) {
				await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "mock job/session mismatch" }) });
				return;
			}
			job.status = "ready";
			job.submittedAt = new Date().toISOString();
			job.updatedAt = job.submittedAt;
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, status: "ready", changesetId: job.changesetId, job }) });
			return;
		}

		if (url.pathname.endsWith("/export/preview") && method === "POST") {
			state.previewCalls.push(body);
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					changesetId: successPayload.changesetId,
					body: "Review preview for PR #999",
					comments: [
						{ path: "src/app/pr-walkthrough.ts", side: "RIGHT", line: 121, body: "Persisted line comment from browser test", valid: true },
						{ path: "dist/generated.bundle.js", side: "RIGHT", line: 1, body: "Generated files are not exported as line comments", valid: false, reason: "Generated or truncated file cannot be mapped to GitHub" },
					],
					warnings: [{ code: "unmappable-comment", message: "1 comment cannot be mapped to GitHub." }],
					canSubmit: true,
				}),
			});
			return;
		}

		if (url.pathname.endsWith("/export/submit") && method === "POST") {
			state.submitCalls.push(body);
			const confirmed = Boolean((body as { confirm?: boolean } | undefined)?.confirm);
			await route.fulfill({
				status: confirmed ? 200 : 400,
				contentType: "application/json",
				body: JSON.stringify(confirmed
					? { ok: true, submitted: true, reviewUrl: `${REAL_PR_URL}#pullrequestreview-1` }
					: { ok: false, error: "Explicit confirmation is required before submitting a GitHub review." }),
			});
			return;
		}

		if (url.pathname === "/api/pr-walkthrough/resolve" && method === "POST") {
			state.resolveCalls.push(body);
			if (state.resolveDelay) await state.resolveDelay;
			if (state.mode === "missing") {
				await route.fulfill({
					status: 404,
					contentType: "application/json",
					body: JSON.stringify({ code: "not_found", error: "Pull request not found: #404" }),
				});
				return;
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(state.mode === "warnings" ? warningPayload : successPayload),
			});
			return;
		}

		if (method === "GET") {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(state.mode === "warnings" ? warningPayload : successPayload),
			});
			return;
		}

		await route.fallback();
	};
	await page.context().route("**/api/pr-walkthrough/**", routeHandler);
	await page.context().route("**/api/internal/pr-walkthrough/submit-yaml", routeHandler);
}

async function selectedSessionId(page: Page): Promise<string> {
	return page.evaluate(() => ((window as any).bobbitState ?? (window as any).__bobbitState)?.selectedSessionId ?? "");
}

async function focusChildWalkthroughSession(page: Page, childSessionId: string) {
	const row = page.locator(`[data-session-id="${childSessionId}"]`).first();
	await expect(row, "walkthrough child session should be visible in the sidebar").toBeVisible({ timeout: 15_000 });
	await row.click();
	await expect.poll(() => selectedSessionId(page), { timeout: 10_000 }).toBe(childSessionId);
}

async function publishWalkthroughJobUpdate(page: Page, state: MockWalkthroughState, childSessionId: string) {
	const job = state.jobsByChildSession?.get(childSessionId);
	expect(job, `expected mock job for child session ${childSessionId}`).toBeTruthy();
	const payload = job!.status === "ready" ? (state.mode === "warnings" ? warningPayload : successPayload) : undefined;
	const tab = {
		id: job!.tabId,
		kind: "walkthrough",
		title: job!.title,
		label: `PR: #${job!.target?.number ?? realChangeset.prNumber}`,
		legacyTab: "walkthrough",
		source: { type: "walkthrough", sessionId: childSessionId, changesetId: job!.changesetId, prUrl: job!.target?.prUrl, prNumber: job!.target?.number, prTitle: payload?.changeset.prTitle, title: job!.title },
		state: {
			status: job!.status,
			jobId: job!.jobId,
			changesetId: job!.changesetId,
			changeset: payload?.changeset ?? { ...realChangeset, prNumber: job!.target?.number, prUrl: job!.target?.prUrl, externalUrl: job!.target?.prUrl, title: job!.title },
			cards: payload?.cards,
			warnings: payload?.warnings || [],
			error: job!.error?.message,
			errorCode: job!.error?.code,
		},
	};
	await page.evaluate(({ detail, tab }) => {
		document.dispatchEvent(new CustomEvent("pr-walkthrough-job-updated", { detail: { job: detail } }));
		const s = (window as any).__bobbitState ?? (window as any).bobbitState;
		if (s) {
			s.panelTabsBySession ||= {};
			s.panelWorkspaceActiveBySession ||= {};
			s.panelTabsBySession[detail.childSessionId] = [tab];
			s.panelWorkspaceActiveBySession[detail.childSessionId] = tab.id;
			s.panelTabs = [tab];
			s.activePanelTabId = tab.id;
		}
		(window as any).__bobbitRenderApp?.();
	}, { detail: job, tab });
}

async function markWalkthroughReady(page: Page, state: MockWalkthroughState, childSessionId: string) {
	const job = state.jobsByChildSession?.get(childSessionId);
	expect(job, `expected mock job for child session ${childSessionId}`).toBeTruthy();
	if (job!.status === "error") return;
	job!.status = "ready";
	job!.updatedAt = new Date().toISOString();
	await publishWalkthroughJobUpdate(page, state, childSessionId);
}

async function setupSession(page: Page) {
	await page.setViewportSize({ width: 1600, height: 940 });
	await openApp(page);
	await createSessionViaUI(page);
}

async function launchWalkthroughCommand(page: Page, state: MockWalkthroughState, command: string) {
	const launchResponse = page.waitForResponse((response) => response.url().includes("/api/pr-walkthrough/launch") && response.request().method() === "POST", { timeout: 20_000 });
	await sendMessage(page, command);
	const launch = await (await launchResponse).json() as { job?: Record<string, any>; childSessionId?: string };
	const job = (launch.job && typeof launch.job === "object" ? launch.job : launch) as Record<string, any>;
	await focusChildWalkthroughSession(page, String(job.childSessionId));
	await publishWalkthroughJobUpdate(page, state, String(job.childSessionId));
	await expect(page.locator(PANEL_TAB_SELECTOR).first(), "walkthrough child side-panel tab should open").toBeVisible({ timeout: 15_000 });
	if (state.mode !== "missing") {
		if (state.resolveDelay) void state.resolveDelay.then(() => markWalkthroughReady(page, state, String(job.childSessionId)));
		else await markWalkthroughReady(page, state, String(job.childSessionId));
	}
	return job;
}

async function openRealWalkthrough(page: Page, state: MockWalkthroughState, command = `/walkthrough-pr ${REAL_PR_URL}`) {
	await installMockWalkthroughApi(page, state);
	await setupSession(page);
	return launchWalkthroughCommand(page, state, command);
}

async function saveLineComment(page: Page, body: string) {
	const line = activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="src-app-pr-walkthrough-ts:h0:l1"]`).first();
	await expect(line).toBeVisible({ timeout: 10_000 });
	await line.hover();
	await line.getByTestId("pr-walkthrough-line-comment-button").click();
	const editor = page.getByTestId("pr-walkthrough-comment-editor");
	await expect(editor).toBeVisible();
	await editor.getByTestId("pr-walkthrough-comment-input").fill(body);
	await editor.getByTestId("pr-walkthrough-comment-save").click();
	await expect(editor).toBeHidden({ timeout: 5_000 });
	await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-comment").filter({ hasText: body })).toBeVisible();
}

async function saveCardComment(page: Page, body: string) {
	await activeCard(page).getByTestId("pr-walkthrough-add-card-comment").click();
	const editor = page.getByTestId("pr-walkthrough-comment-editor");
	await editor.getByTestId("pr-walkthrough-comment-input").fill(body);
	await editor.getByTestId("pr-walkthrough-comment-save").click();
	await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-comment").filter({ hasText: body })).toBeVisible();
}


test.describe("real PR walkthrough browser UX", () => {
	test("loads mocked resolved cards and preserves comments through reload, fullscreen, and standalone", async ({ page, context }) => {
		let releaseResolve!: () => void;
		const state: MockWalkthroughState = {
			mode: "success",
			resolveCalls: [],
			previewCalls: [],
			submitCalls: [],
			resolveDelay: new Promise<void>((resolve) => { releaseResolve = resolve; }),
		};

		await openRealWalkthrough(page, state);
		await expect(page.getByTestId("pr-walkthrough-waiting"), "real walkthrough agent launches should wait for YAML instead of rendering fixture cards").toBeVisible({ timeout: 10_000 });
		releaseResolve();

		await expect(activeCard(page).getByTestId("pr-walkthrough-card-title"), "submitted cards should replace the waiting state").toContainText("Resolved changeset overview", { timeout: 10_000 });
		await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-pr-title")).toContainText("Real-ish walkthrough cards");
		await expect(activeCard(page)).toContainText("src/app/pr-walkthrough.ts");
		await expect(activeCard(page).getByTestId("pr-walkthrough-diff-status"), "diff headers should not show file-status lozenges").toHaveCount(0);
		await expect(activeCard(page).getByTestId("pr-walkthrough-diff-additions").first(), "diff headers should show line addition counts").toContainText(/\+\d+/);
		const fileLink = activeCard(page).getByTestId("pr-walkthrough-external-file-link").first();
		await expect(fileLink).toHaveAttribute("href", "https://github.com/SuuBro/bobbit/blob/2222222/src/app/pr-walkthrough.ts");
		await expect(fileLink).toHaveAttribute("title", "Open file");
		await expect(fileLink.locator("svg"), "open-file action should be icon-only").toBeVisible();
		await expect(fileLink).not.toContainText(/Open file/i);
		await expect(activeCard(page)).toContainText("gatewayFetch('/api/pr-walkthrough/resolve'");
		await expect.poll(() => state.resolveCalls.length, { timeout: 5_000 }).toBe(1);
		expect(JSON.stringify(state.resolveCalls[0])).toContain(REAL_PR_URL);

		const commentBody = `persisted-real-comment-${Date.now()}`;
		await saveLineComment(page, commentBody);

		const fullscreenRoot = page.locator(`${tid("side-panel-fullscreen-root")}, ${tid("pr-walkthrough-fullscreen-root")}, .preview-fullscreen-prompt`).first();
		if (!await fullscreenRoot.isVisible().catch(() => false)) {
			const fullscreen = page.locator(`${tid("side-panel-fullscreen")}, ${tid("pr-walkthrough-fullscreen")}, button[title*="Fullscreen"]`).first();
			await expect(fullscreen).toBeVisible();
			await fullscreen.click();
		}
		await expect(fullscreenRoot).toBeVisible({ timeout: 10_000 });
		await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-comment").filter({ hasText: commentBody })).toBeVisible();
		const collapseFullscreen = page.locator(`${tid("side-panel-collapse-fullscreen")}, button[title*="Collapse preview"], button[title*="Collapse walkthrough"]`).first();
		if (await collapseFullscreen.isVisible().catch(() => false)) await collapseFullscreen.click();

		await page.reload();
		await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-card-title"), "resolved card identity should survive full reload").toContainText("Resolved changeset overview", { timeout: 15_000 });
		await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-comment").filter({ hasText: commentBody }), "draft line comments should survive reload against real cards").toBeVisible();

		const openStandalone = page.locator(`${tid("side-panel-open-in-new-tab")}, ${tid("pr-walkthrough-open-in-new-tab")}, a[title*="Open walkthrough"], button[title*="Open walkthrough"]`).first();
		const [standalone] = await Promise.all([
			context.waitForEvent("page"),
			openStandalone.click(),
		]);
		await standalone.setViewportSize({ width: 1700, height: 1000 });
		await standalone.waitForLoadState("domcontentloaded");
		await expect(standalone).toHaveURL(/walkthrough/);
		await expect(walkthroughPanel(standalone).getByTestId("pr-walkthrough-card-title"), "standalone route should render the same resolved cards").toContainText("Resolved changeset overview", { timeout: 15_000 });
		await expect(walkthroughPanel(standalone).getByTestId("pr-walkthrough-comment").filter({ hasText: commentBody }), "standalone route should restore the same in-progress draft").toBeVisible();
		await standalone.close();
	});

	test("previews GitHub export and submits only after the explicit confirmation click", async ({ page }) => {
		const state: MockWalkthroughState = { mode: "success", resolveCalls: [], previewCalls: [], submitCalls: [] };
		await openRealWalkthrough(page, state);
		await expect(activeCard(page).getByTestId("pr-walkthrough-card-title")).toContainText("Resolved changeset overview", { timeout: 10_000 });

		await saveLineComment(page, "Persisted line comment from browser test");
		await walkthroughPanel(page).getByTestId("pr-walkthrough-dislike").first().click();
		await expect(activeCard(page).getByTestId("pr-walkthrough-card-title")).toContainText("Persist walkthrough state");
		await expect(activeCard(page).getByTestId("pr-walkthrough-diff-status"), "diff headers should not show file-status lozenges").toHaveCount(0);
		await saveCardComment(page, "Card-level export concern from browser test");
		await walkthroughPanel(page).getByTestId("pr-walkthrough-like").first().click();
		await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-audit")).toBeVisible({ timeout: 10_000 });

		await walkthroughPanel(page).getByTestId("pr-walkthrough-submit-review").click();
		const preview = page.getByTestId("pr-walkthrough-export-preview");
		await expect(preview, "first submit click should open a safe preview rather than mutate GitHub").toBeVisible({ timeout: 10_000 });
		await expect(preview).toContainText("src/app/pr-walkthrough.ts");
		await expect(preview).toContainText("Persisted line comment from browser test");
		await expect(preview).toContainText(/Generated or truncated file cannot be mapped/i);
		await expect.poll(() => state.previewCalls.length, { timeout: 5_000 }).toBe(1);
		expect(state.submitCalls, "opening the preview must not call the submit endpoint").toHaveLength(0);

		await preview.getByTestId("pr-walkthrough-export-submit").click();
		await expect.poll(() => state.submitCalls.length, { timeout: 5_000 }).toBe(1);
		expect((state.submitCalls[0] as { confirm?: boolean }).confirm).toBe(true);
		await expect(page.getByTestId("pr-walkthrough-export-result")).toContainText(/submitted|success/i, { timeout: 10_000 });
	});

	test("renders visible resolver errors and warning banners for missing, auth, and large diff states", async ({ page }) => {
		const state: MockWalkthroughState = { mode: "missing", resolveCalls: [], previewCalls: [], submitCalls: [] };
		const missingJob = await openRealWalkthrough(page, state, "/walkthrough-pr 404");
		await expect(walkthroughPanel(page), "error walkthrough should keep the header/panel mounted").toBeVisible({ timeout: 10_000 });
		await expect(page.getByTestId("pr-walkthrough-error")).toContainText(/Pull request not found|#404/i, { timeout: 10_000 });
		await expect(page.getByRole("button", { name: /retry/i })).toBeVisible();

		state.mode = "warnings";
		await page.locator(`[data-session-id="${missingJob.parentSessionId}"]`).first().click();
		await launchWalkthroughCommand(page, state, "/walkthrough-pr 1000");
		await expect(activeCard(page).getByTestId("pr-walkthrough-card-title")).toContainText("Resolved changeset overview", { timeout: 10_000 });
		const warnings = page.getByTestId("pr-walkthrough-warning");
		await expect(warnings.filter({ hasText: /GitHub token is required/i })).toBeVisible({ timeout: 10_000 });
		await expect(warnings.filter({ hasText: /Large diff truncated/i })).toBeVisible();
		await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-stat-files")).toContainText("48 files");
	});
});
