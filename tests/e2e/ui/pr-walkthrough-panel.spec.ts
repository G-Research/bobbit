import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { fixturePrWalkthroughChangeset, getFixturePrWalkthroughCards } from "../../../src/ui/components/pr-walkthrough/fixtures.js";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

const WALKTHROUGH_COMMAND = "/walkthrough-pr 123";
const WALKTHROUGH_URL = "https://github.com/SuuBro/bobbit/pull/637";
const WALKTHROUGH_URL_COMMAND = `/walkthrough-pr ${WALKTHROUGH_URL}`;
const PANEL_TAB_SELECTOR = ".goal-preview-panel .goal-tab-pill[data-panel-tab-kind='walkthrough']";

const tid = (id: string) => `[data-testid="${id}"]`;

type WalkthroughLaunchResponse = {
	jobId: string;
	childSessionId: string;
	changesetId: string;
	tabId?: string;
	status: string;
	job?: WalkthroughLaunchResponse;
};

const fixtureJobsByChildSession = new Map<string, Record<string, any>>();
const fixtureJobsById = new Map<string, Record<string, any>>();

function prNumberFromCommand(command: string): string {
	return /\/pull\/(\d+)/.exec(command)?.[1] ?? command.match(/(\d+)/)?.[1] ?? "123";
}

function prUrlForNumber(prNumber: string | number): string {
	return `https://github.com/SuuBro/bobbit/pull/${prNumber}`;
}

function resolvedWalkthroughPayload(prNumber: string | number, title = "Resolved Walkthrough PR", changesetId = `github:SuuBro/bobbit#${prNumber}:abc1234`, prUrl = prUrlForNumber(prNumber), prBody = "") {
	return {
		changesetId,
		changeset: {
			...fixturePrWalkthroughChangeset,
			baseSha: "base1234",
			headSha: "abc1234",
			provider: "github",
			externalUrl: prUrl,
			prUrl,
			prNumber,
			prTitle: title,
			prBody,
			title: `PR #${prNumber}: ${title}`,
		},
		cards: getFixturePrWalkthroughCards(),
		warnings: [{ code: "test-warning", severity: "info", message: "Resolver warning surfaced." }],
		export: { provider: "github", available: true },
	};
}

async function installFixtureWalkthroughPayloadRoute(page: Page, prNumber: string, title = `PR #${prNumber} Walkthrough`, prUrl = prUrlForNumber(prNumber), prBody = "") {
	fixtureJobsByChildSession.clear();
	fixtureJobsById.clear();
	const routeHandler = async (route: any) => {
		const request = route.request();
		const url = new URL(request.url());
		if (url.pathname === "/api/pr-walkthrough/launch" && request.method() === "POST") {
			const body = JSON.parse(request.postData() || "{}") as Record<string, any>;
			const effectivePrNumber = String(body.prNumber ?? /\/(\d+)$/.exec(String(body.prUrl || ""))?.[1] ?? prNumber);
			const effectivePrUrl = String(body.prUrl || (effectivePrNumber === prNumber ? prUrl : prUrlForNumber(effectivePrNumber)));
			const effectiveTitle = effectivePrNumber === prNumber ? title : `PR #${effectivePrNumber} Walkthrough`;
			const childSessionId = `prw-session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
			const jobId = `prw-${Date.now()}-${Math.random().toString(16).slice(2)}`;
			const changesetId = `github:SuuBro/bobbit#${effectivePrNumber}:abc1234`;
			const tabId = `walkthrough:${encodeURIComponent(changesetId)}`;
			const targetKey = `github:SuuBro/bobbit#${effectivePrNumber}`;
			const createResponse = await apiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({
					worktree: false,
					parentSessionId: String(body.sessionId || body.parentSessionId || ""),
					childKind: "pr-walkthrough",
					readOnly: true,
					walkthroughJobId: jobId,
					walkthroughChangesetId: changesetId,
					walkthroughTargetKey: targetKey,
				}),
			});
			expect(createResponse.ok, `fixture child session should be created: ${createResponse.status}`).toBe(true);
			const created = await createResponse.json() as { id: string };
			const actualChildSessionId = created.id || childSessionId;
			await apiFetch(`/api/sessions/${encodeURIComponent(actualChildSessionId)}`, { method: "PATCH", body: JSON.stringify({ title: effectiveTitle }) }).catch(() => undefined);
			const job = {
				schemaVersion: 1,
				prBody,
				jobId,
				parentSessionId: String(body.sessionId || body.parentSessionId || ""),
				childSessionId: actualChildSessionId,
				cwd: "",
				target: { provider: "github", owner: "SuuBro", repo: "bobbit", number: Number(effectivePrNumber), prUrl: effectivePrUrl, canonicalKey: targetKey },
				changesetId,
				tabId,
				status: "waiting_for_yaml",
				title: effectiveTitle,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			fixtureJobsByChildSession.set(actualChildSessionId, job);
			fixtureJobsById.set(jobId, job);
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...job, created: true, job }) });
			return;
		}
		const sessionMatch = url.pathname.match(/^\/api\/pr-walkthrough\/session\/(.+)$/);
		if (sessionMatch && request.method() === "GET") {
			const job = fixtureJobsByChildSession.get(decodeURIComponent(sessionMatch[1]));
			await route.fulfill({ status: job ? 200 : 404, contentType: "application/json", body: JSON.stringify(job ? { job } : { error: "fixture job not found" }) });
			return;
		}
		const jobMatch = url.pathname.match(/^\/api\/pr-walkthrough\/jobs\/(.+)$/);
		if (jobMatch && request.method() === "GET") {
			const job = fixtureJobsById.get(decodeURIComponent(jobMatch[1]));
			await route.fulfill({ status: job ? 200 : 404, contentType: "application/json", body: JSON.stringify(job ? { job } : { error: "fixture job not found" }) });
			return;
		}
		if (url.pathname === "/api/internal/pr-walkthrough/submit-yaml" && request.method() === "POST") {
			const body = JSON.parse(request.postData() || "{}") as Record<string, any>;
			const job = fixtureJobsById.get(String(body.jobId));
			if (!job || job.childSessionId !== body.sessionId) {
				await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "fixture job/session mismatch" }) });
				return;
			}
			if (!String(body.yaml || "").includes("review_chunks:")) {
				job.status = "validation_failed";
				job.lastValidationError = { message: "YAML schema invalid: root object is missing required walkthrough sections", issues: [{ path: "walkthrough.review_chunks", message: "Required field is missing" }] };
				job.updatedAt = new Date().toISOString();
				await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: false, status: "validation_failed", retryable: true, validation: job.lastValidationError, job }) });
				return;
			}
			job.status = "ready";
			job.submittedAt = new Date().toISOString();
			job.payloadUpdatedAt = job.submittedAt;
			job.updatedAt = job.submittedAt;
			delete job.lastValidationError;
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, status: "ready", changesetId: job.changesetId, message: "Walkthrough published", warnings: [], job }) });
			return;
		}
		if (request.method() === "GET" && url.pathname.startsWith("/api/pr-walkthrough/")) {
			const encodedChangesetId = url.pathname.split("/").pop() || `github%3ASuuBro%2Fbobbit%23${prNumber}%3Aabc1234`;
			const changesetId = decodeURIComponent(encodedChangesetId);
			const effectivePrNumber = /#(\d+)/.exec(changesetId)?.[1] ?? prNumber;
			const effectivePrUrl = effectivePrNumber === prNumber ? prUrl : prUrlForNumber(effectivePrNumber);
			const effectiveTitle = effectivePrNumber === prNumber ? title : `Resolved Walkthrough PR`;
			const effectivePrBody = effectivePrNumber === prNumber ? prBody : "";
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(resolvedWalkthroughPayload(effectivePrNumber, effectiveTitle, changesetId, effectivePrUrl, effectivePrBody)) });
			return;
		}
		await route.fallback();
	};
	await page.context().route("**/api/pr-walkthrough/**", routeHandler);
	await page.context().route("**/api/internal/pr-walkthrough/submit-yaml", routeHandler);
}

function validWalkthroughYaml(prNumber: string | number, title = "Resolved Walkthrough PR", prUrl = prUrlForNumber(prNumber)): string {
	return `schema_version: 1
pr:
  provider: github
  owner: SuuBro
  repo: bobbit
  number: ${prNumber}
  title: ${JSON.stringify(title)}
  url: ${JSON.stringify(prUrl)}
  base_sha: "abcdef1"
  head_sha: "1234567"
  original_description:
    body: "Demo PR body"
    source: gh_api
    fetched_at: "2026-05-30T00:00:00.000Z"
  stats:
    files_changed: 1
    additions: 2
    deletions: 1
walkthrough:
  context:
    why_created: Demo
    problem_solved: Solves demo
    why_worth_merging: Useful
    merge_concerns: None
    author_intent: Add demo
    reviewer_map: Read orientation first
  merge_assessment:
    recommendation: comment
    confidence: medium
    summary: Looks reasonable
    blocking_concerns: []
    non_blocking_concerns: []
  design_decisions: []
  review_chunks:
    - id: significant-diff
      phase: significant
      title: Resolved logical card
      reviewer_goal: Confirm the main implementation path
      explanation: This card came from submitted walkthrough YAML.
      files:
        - src/app/pr-walkthrough.ts
      relevant_hunks: []
      suggested_concerns: []
      positive_notes:
        - Clear structure
  omissions_and_followups: []
  audit:
    remaining_changed_areas: []
    low_signal_or_mechanical_changes: []
    generated_or_binary_files: []
    reviewer_checklist:
      - Confirm behavior
  display:
    phase_order: [orientation, design, significant, other, audit]
    chunk_order: [significant-diff]
`;
}

function walkthroughPanel(page: Page): Locator {
	return page.getByTestId("pr-walkthrough-panel");
}

function activeCard(page: Page): Locator {
	return walkthroughPanel(page).locator(`${tid("pr-walkthrough-card")}[data-active="true"]`).first();
}

async function activeSessionId(page: Page): Promise<string> {
	const sessionId = await page.evaluate(() => ((window as any).bobbitState ?? (window as any).__bobbitState)?.selectedSessionId ?? "");
	expect(sessionId, "expected an active launcher session").toBeTruthy();
	return sessionId;
}

async function expectNoLauncherWalkthroughPanel(page: Page, parentSessionId: string) {
	await page.locator(`[data-session-id="${parentSessionId}"]`).first().click();
	await expect.poll(() => page.evaluate(() => ((window as any).bobbitState ?? (window as any).__bobbitState)?.selectedSessionId ?? ""), {
		timeout: 10_000,
		message: "launcher session should be selectable after the walkthrough child is created",
	}).toBe(parentSessionId);
	await expect(page.locator(PANEL_TAB_SELECTOR), "launcher session must not own the PR walkthrough panel tab").toHaveCount(0);
	await expect(walkthroughPanel(page), "launcher session must not render the PR walkthrough panel").toHaveCount(0);
}

async function focusChildWalkthroughSession(page: Page, childSessionId: string) {
	const row = page.locator(`[data-session-id="${childSessionId}"]`).first();
	await expect(row, "child walkthrough session should be visible in the sidebar").toBeVisible({ timeout: 15_000 });
	await row.click();
	await expect.poll(() => page.evaluate(() => ((window as any).bobbitState ?? (window as any).__bobbitState)?.selectedSessionId ?? ""), {
		timeout: 10_000,
		message: "walkthrough child session should be focused",
	}).toBe(childSessionId);
	await expect.poll(() => page.evaluate((id) => {
		const s = (window as any).bobbitState ?? (window as any).__bobbitState;
		return !s?.connectingSessionId && s?.remoteAgent?.gatewaySessionId === id && s?.remoteAgent?.connected === true;
	}, childSessionId), {
		timeout: 15_000,
		message: "walkthrough child session should finish connecting before asserting its panel",
	}).toBe(true);
}

async function publishWalkthroughJobUpdate(page: Page, childSessionId: string) {
	let job = fixtureJobsByChildSession.get(childSessionId);
	if (!job) {
		const response = await apiFetch(`/api/pr-walkthrough/session/${encodeURIComponent(childSessionId)}`);
		expect(response.ok, `walkthrough job restore should succeed for ${childSessionId}`).toBe(true);
		const body = await response.json() as Record<string, unknown>;
		job = (body.job && typeof body.job === "object" ? body.job : body) as Record<string, any>;
	}
	const prNumber = String(job.target?.number ?? /#(\d+)/.exec(String(job.changesetId || ""))?.[1] ?? "123");
	const prUrl = String(job.target?.prUrl || prUrlForNumber(prNumber));
	const readyPayload = job.status === "ready" ? resolvedWalkthroughPayload(prNumber, prNumber === "638" ? "Widget Launched Walkthrough" : "Resolved Walkthrough PR", String(job.changesetId), prUrl, String(job.prBody || "")) : undefined;
	const tab = {
		id: job.tabId || `walkthrough:${encodeURIComponent(String(job.changesetId || "fixture"))}`,
		kind: "walkthrough",
		title: job.title || `PR #${prNumber} Walkthrough`,
		label: `PR: #${prNumber}`,
		legacyTab: "walkthrough",
		source: { type: "walkthrough", sessionId: childSessionId, changesetId: job.changesetId, prUrl, prNumber, prTitle: readyPayload?.changeset.prTitle, title: job.title },
		state: {
			status: job.status === "starting" ? "waiting_for_yaml" : job.status,
			jobId: job.jobId,
			changesetId: job.changesetId,
			changeset: readyPayload?.changeset ?? { baseSha: job.target?.baseSha || "pending-base", headSha: job.target?.headSha || "pending-head", provider: "github", externalUrl: prUrl, prUrl, prNumber, title: job.title || `PR #${prNumber} Walkthrough` },
			cards: readyPayload?.cards,
			warnings: readyPayload?.warnings || job.warnings || [],
			validationError: job.lastValidationError,
			lastValidationError: job.lastValidationError,
			error: job.error?.message || (job.status === "validation_failed" ? job.lastValidationError?.message : undefined),
			errorCode: job.error?.code,
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

async function expectChildNestedUnderLauncher(page: Page, parentSessionId: string, childSessionId: string) {
	const parentRow = page.locator(`[data-session-id="${parentSessionId}"]`).first();
	const childRow = page.locator(`[data-session-id="${childSessionId}"]`).first();
	await expect(parentRow, "launcher session should remain visible").toBeVisible({ timeout: 15_000 });
	await expect(childRow, "walkthrough child session should be visible beneath the launcher").toBeVisible({ timeout: 15_000 });
	await expect(childRow, "child session title should identify the PR walkthrough").toContainText(/Walkthrough/i);
	await expect.poll(async () => {
		const [parentBox, childBox] = await Promise.all([parentRow.boundingBox(), childRow.boundingBox()]);
		return parentBox && childBox ? childBox.y > parentBox.y && childBox.x > parentBox.x : false;
	}, { timeout: 10_000, message: "walkthrough child row should be nested below and indented from the launcher" }).toBe(true);
}

async function expectWalkthroughWaiting(page: Page) {
	const tab = page.locator(PANEL_TAB_SELECTOR).first();
	await expect(tab, "child walkthrough should open a side-panel tab").toBeVisible({ timeout: 15_000 });
	await expect(tab, "walkthrough tab id should use the canonical walkthrough:<id> shape").toHaveAttribute("data-panel-tab-id", /^walkthrough:/);
	await expect(tab).toHaveClass(/goal-tab-pill--active/);
	const root = page.getByTestId("pr-walkthrough-panel-root");
	await expect(root, "child panel should start in the YAML waiting state").toHaveAttribute("data-walkthrough-status", "waiting_for_yaml", { timeout: 15_000 });
	const panel = walkthroughPanel(page);
	await expect(panel.getByTestId("pr-walkthrough-waiting"), "waiting child panel should explain that YAML submission populates cards").toBeVisible({ timeout: 10_000 });
	await expect(panel).toContainText(/submit_pr_walkthrough_yaml/);
	return { tab, panel };
}

async function expectWalkthroughOpened(page: Page) {
	const root = page.getByTestId("pr-walkthrough-panel-root");
	await expect(root, "valid YAML should publish the child walkthrough panel").toHaveAttribute("data-walkthrough-status", "ready", { timeout: 15_000 });
	// The in-app walkthrough panel never auto-enters fullscreen — it shares the
	// HTML preview panel's user-initiated resize semantics — so a ready panel
	// stays in the split layout. Defensively clear any leftover fullscreen state
	// from an earlier interaction so side-panel assertions run in split view.
	if (await page.locator(".preview-fullscreen-prompt").first().isVisible().catch(() => false)) {
		await page.evaluate(() => {
			const s = (window as any).bobbitState ?? (window as any).__bobbitState;
			if (s) s.previewPanelFullscreen = false;
			(window as any).__bobbitRenderApp?.();
		});
		await expect(page.locator(".goal-split-layout"), "ready walkthrough renders in the split layout for side-panel interactions").toBeVisible({ timeout: 10_000 });
	}
	const tab = page.locator(PANEL_TAB_SELECTOR).first();
	await expect(tab, "walkthrough should open a side-panel tab").toBeVisible({ timeout: 15_000 });
	await expect(tab, "walkthrough tab id should use the canonical walkthrough:<id> shape").toHaveAttribute("data-panel-tab-id", /^walkthrough:/);
	await expect(tab).toHaveClass(/goal-tab-pill--active/);

	const panel = walkthroughPanel(page);
	await expect(panel, "walkthrough panel should render as side-panel content, not chat cards").toBeVisible({ timeout: 10_000 });
	await expect(activeCard(page), "fixture-backed ready payload should render an active logical review card").toBeVisible({ timeout: 10_000 });
	return { tab, panel };
}

async function expectActiveWalkthroughSurface(page: Page) {
	const root = page.getByTestId("pr-walkthrough-panel-root");
	const panel = walkthroughPanel(page);
	const draft = panel.getByTestId("pr-walkthrough-draft");
	await expect(root, "ready walkthrough root should remain mounted in split or fullscreen mode").toHaveAttribute("data-walkthrough-status", "ready", { timeout: 10_000 });
	await expect(root, "ready walkthrough root should remain visible in split or fullscreen mode").toBeVisible({ timeout: 10_000 });
	await expect(panel, "ready walkthrough panel should remain visible in split or fullscreen mode").toBeVisible({ timeout: 10_000 });
	await expect(draft, "audit draft should remain visible in split or fullscreen mode").toBeVisible({ timeout: 10_000 });
}

async function setupWaitingWalkthrough(
	page: Page,
	viewport: { width: number; height: number } = { width: 1920, height: 1080 },
	command = WALKTHROUGH_COMMAND,
	prBody = "",
) {
	const prNumber = prNumberFromCommand(command);
	const prUrl = command.includes("http") ? command.replace(/^\/walkthrough-pr\s+/, "") : prUrlForNumber(prNumber);
	await installFixtureWalkthroughPayloadRoute(page, prNumber, `Resolved Walkthrough PR`, prUrl, prBody);
	await page.setViewportSize(viewport);
	await openApp(page);
	await createSessionViaUI(page);
	const parentSessionId = await activeSessionId(page);
	const launchResponse = page.waitForResponse((response) => response.url().includes("/api/pr-walkthrough/launch") && response.request().method() === "POST", { timeout: 20_000 });
	await sendMessage(page, command);
	const launch = await (await launchResponse).json() as WalkthroughLaunchResponse;
	const job = (launch.job && typeof launch.job === "object" ? launch.job : launch) as WalkthroughLaunchResponse;
	await expectChildNestedUnderLauncher(page, parentSessionId, job.childSessionId);
	await expectNoLauncherWalkthroughPanel(page, parentSessionId);
	await focusChildWalkthroughSession(page, job.childSessionId);
	await publishWalkthroughJobUpdate(page, job.childSessionId);
	const waiting = await expectWalkthroughWaiting(page);
	return { ...waiting, parentSessionId, childSessionId: job.childSessionId, jobId: job.jobId, changesetId: job.changesetId, prNumber, prUrl };
}

async function submitYamlViaPage(page: Page, body: Record<string, unknown>) {
	return page.evaluate(async (payload) => {
		const response = await fetch("/api/internal/pr-walkthrough/submit-yaml", {
			method: "POST",
			headers: { "Content-Type": "application/json", "Authorization": `Bearer ${localStorage.getItem("gateway.token") || "localhost"}` },
			body: JSON.stringify(payload),
		});
		return { ok: response.ok, status: response.status, text: await response.text().catch(() => "") };
	}, body);
}

async function submitValidWalkthroughYaml(page: Page, job: { childSessionId: string; jobId: string; prNumber: string; prUrl: string }) {
	const response = await submitYamlViaPage(page, {
		sessionId: job.childSessionId,
		jobId: job.jobId,
		yaml: validWalkthroughYaml(job.prNumber, "Resolved Walkthrough PR", job.prUrl),
	});
	expect(response.ok, `valid YAML submit should succeed: ${response.status} ${response.text}`).toBe(true);
	await focusChildWalkthroughSession(page, job.childSessionId);
	await publishWalkthroughJobUpdate(page, job.childSessionId);
	await expect(page.locator(".preview-fullscreen-prompt"), "live walkthrough child should stay in split view so chat remains promptable").toHaveCount(0);
	await expect(page.locator("textarea").first(), "live walkthrough child should keep the chat prompt visible after YAML submission").toBeVisible({ timeout: 10_000 });
	return expectWalkthroughOpened(page);
}

async function setupWalkthrough(
	page: Page,
	viewport: { width: number; height: number } = { width: 1920, height: 1080 },
	command = WALKTHROUGH_COMMAND,
	prBody = "",
) {
	const waiting = await setupWaitingWalkthrough(page, viewport, command, prBody);
	const ready = await submitValidWalkthroughYaml(page, waiting);
	return { ...ready, parentSessionId: waiting.parentSessionId, childSessionId: waiting.childSessionId, jobId: waiting.jobId };
}

async function expectActiveDiffMode(page: Page, mode: "split" | "inline") {
	const diff = activeCard(page).getByTestId("pr-walkthrough-diff-block").first();
	await expect(diff, `active diff should be in ${mode} mode`).toHaveAttribute("data-diff-mode", mode, { timeout: 10_000 });
}

async function expectOneHorizontalScrollerPerDiff(page: Page) {
	const diff = activeCard(page).getByTestId("pr-walkthrough-diff-block").first();
	await expect(diff).toBeVisible();
	await expect.poll(async () => diff.evaluate((root) => {
		const scrollContainers = Array.from(root.querySelectorAll('[data-testid="pr-walkthrough-diff-scroll"]')) as HTMLElement[];
		return scrollContainers.filter((el) => {
			const style = window.getComputedStyle(el);
			return /(auto|scroll|overlay)/.test(style.overflowX);
		}).length;
	}), {
		timeout: 5_000,
		message: "split diff should wrap both sides in one shared horizontal scroll container",
	}).toBe(1);
}

async function expectSplitDiffColumnsAligned(page: Page) {
	const diff = activeCard(page).getByTestId("pr-walkthrough-diff-block").first();
	await expect(diff).toBeVisible();
	await expect.poll(async () => diff.evaluate((root) => {
		const rows = Array.from(root.querySelectorAll(".split-row")) as HTMLElement[];
		const measurements = rows.map((row) => {
			const [left, right] = Array.from(row.querySelectorAll(":scope > .diff-line")) as HTMLElement[];
			if (!left || !right) return null;
			const leftBox = left.getBoundingClientRect();
			const rightBox = right.getBoundingClientRect();
			const leftTextBox = left.querySelector(".line-text")?.getBoundingClientRect();
			const rightTextBox = right.querySelector(".line-text")?.getBoundingClientRect();
			return { leftX: leftBox.x, rightX: rightBox.x, leftWidth: leftBox.width, rightWidth: rightBox.width, leftTextRight: leftTextBox?.right ?? leftBox.right, rightTextLeft: rightTextBox?.left ?? rightBox.left };
		}).filter(Boolean) as Array<{ leftX: number; rightX: number; leftWidth: number; rightWidth: number; leftTextRight: number; rightTextLeft: number }>;
		if (measurements.length < 2) return false;
		const first = measurements[0]!;
		return measurements.every((item) =>
			Math.abs(item.leftX - first.leftX) <= 1
			&& Math.abs(item.rightX - first.rightX) <= 1
			&& Math.abs(item.leftWidth - first.leftWidth) <= 1
			&& Math.abs(item.rightWidth - first.rightWidth) <= 1
			&& item.leftTextRight <= item.rightX + 1
			&& item.rightTextLeft >= item.rightX - 1,
		);
	}), {
		timeout: 5_000,
		message: "split diff old/new columns should stay vertically aligned across rows",
	}).toBe(true);
}

async function expectPrototypeHeader(panel: Locator, expected: { pr?: RegExp; title?: RegExp; href?: string | RegExp } = {}) {
	const header = panel.getByTestId("pr-walkthrough-header");
	await expect(header, "walkthrough should use the prominent prototype-style review header").toBeVisible({ timeout: 10_000 });
	await expect(header.getByTestId("pr-walkthrough-pr-title"), "header should expose the PR/title block").toBeVisible();
	if (expected.pr) await expect(header).toContainText(expected.pr);
	if (expected.title) await expect(header).toContainText(expected.title);

	const fileStat = header.getByTestId("pr-walkthrough-stat-files");
	const addStat = header.getByTestId("pr-walkthrough-stat-additions");
	await expect(fileStat, "header should show changed file count").toContainText(/\d+\s+files?/i);
	await expect(addStat, "header should show green additions stat").toContainText(/\+\s*[\d,]+/);
	await expect(header.getByTestId("pr-walkthrough-stat-deletions"), "header should show red deletions stat").toContainText(/-\s*[\d,]+/);
	await expect.poll(async () => {
		const [filesBox, additionsBox] = await Promise.all([fileStat.boundingBox(), addStat.boundingBox()]);
		return filesBox && additionsBox ? additionsBox.x > filesBox.x && Math.abs(additionsBox.y - filesBox.y) < 6 : false;
	}, { message: "line-change counts should sit to the right of the file count" }).toBe(true);
	const progress = header.getByTestId("pr-walkthrough-progress");
	await expect(progress, "header should show review progress").toContainText(/\d+\s*\/\s*\d+\s+reviewed/i);
	await expect.poll(async () => {
		const [trackBox, labelBox] = await Promise.all([progress.locator(".progress-track").boundingBox(), progress.locator(".progress-label").boundingBox()]);
		return trackBox && labelBox ? labelBox.y > trackBox.y : false;
	}, { message: "reviewed count should sit beneath the progress bar" }).toBe(true);
	const submit = header.getByRole("button", { name: /^submit$/i });
	await expect(submit, "header should reserve the final draft submit control").toBeVisible();
	await expect(submit.locator("svg"), "submit control should include an icon").toBeVisible();

	if (expected.href) {
		const link = header.getByTestId("pr-walkthrough-pr-link");
		await expect(link, "header should expose a compact external PR/GitHub link").toBeVisible();
		await expect(link).toHaveAttribute("href", expected.href);
		await expect(link).toHaveAttribute("target", "_blank");
		await expect(link.locator("svg"), "GitHub links should include the GitHub mark").toBeVisible();
		await expect(link, "GitHub links should always use compact action text").toContainText(/^Open on GitHub$/i);
		await expect.poll(async () => {
			const [titleBox, linkBox] = await Promise.all([header.locator(".title").boundingBox(), link.boundingBox()]);
			return titleBox && linkBox ? linkBox.y - (titleBox.y + titleBox.height) : -1;
		}, { message: "GitHub link row should have breathing room beneath the PR title" }).toBeGreaterThanOrEqual(3);
	}
}

async function expectPrototypeCardHierarchy(page: Page) {
	const card = activeCard(page);
	await expect(card.getByTestId("pr-walkthrough-card-phase-tag"), "card should show a compact phase tag above the title").toBeVisible();
	await expect(card.getByTestId("pr-walkthrough-card-title"), "card should show the logical change title prominently").toBeVisible();
	await expect(card.getByTestId("pr-walkthrough-card-summary"), "card should include the senior-reviewer narrative summary").toBeVisible();
	await expect(card, "card should not spend space on redundant ordinal metadata").not.toContainText(/Card \d+ of \d+ · logical change set/i);
	const chooser = card.getByTestId("pr-walkthrough-diff-mode-chooser");
	if (await chooser.count()) {
		await expect(chooser, "diff mode chooser should sit in the card header").toBeVisible();
		await expect(chooser.getByTestId("diff-mode-split"), "split mode should be icon-only with tooltip").toHaveAttribute("title", "Split diff");
		await expect(chooser.getByTestId("diff-mode-inline"), "inline mode should be icon-only with tooltip").toHaveAttribute("title", "Inline diff");
		await expect(chooser, "diff mode chooser should not render text labels").not.toContainText(/Split|Inline|Diff display/i);
		await expect.poll(async () => {
			const [phaseBox, chooserBox] = await Promise.all([card.getByTestId("pr-walkthrough-card-phase-tag").boundingBox(), chooser.boundingBox()]);
			return phaseBox && chooserBox ? chooserBox.x > phaseBox.x + phaseBox.width : false;
		}, { message: "diff mode chooser should sit to the far right of the phase pill row" }).toBe(true);
	}
	await expect(card.getByTestId("pr-walkthrough-card-comments"), "card should include card-level concern/comment affordances").toBeVisible();
	await expect(card.getByText(/write your own/i), "card-level comments should always allow a custom concern").toBeVisible();
}

async function expectCollapsedRailPipsAndDots(panel: Locator) {
	const collapsedRail = panel.getByTestId("pr-walkthrough-collapsed-rail");
	await expect(collapsedRail, "narrow panel should show the thin collapsed rail").toBeVisible({ timeout: 10_000 });
	const pips = collapsedRail.getByTestId("pr-walkthrough-phase-pip");
	await expect(pips.first(), "collapsed rail should show visible phase pips").toBeVisible();
	await expect(pips.first(), "phase pips should expose native tooltip text").toHaveAttribute("title", /orientation|phase/i);
	await expect.poll(() => pips.first().evaluate(el => getComputedStyle(el.parentElement as HTMLElement, "::before").content), { message: "first collapsed phase should not render a leading divider" }).toBe("none");
	const unreviewedPip = pips.nth(1);
	await expect(unreviewedPip, "collapsed rail phases should render as compact muted headers").toBeVisible();
	await expect.poll(() => unreviewedPip.evaluate(el => {
		const style = getComputedStyle(el as HTMLElement);
		const divider = getComputedStyle(el.parentElement as HTMLElement, "::before");
		return { borderWidth: style.borderTopWidth, background: style.backgroundColor, dividerHeight: divider.height };
	}), { message: "phase headers should use dividers instead of status-filled pips" }).toMatchObject({ borderWidth: "0px", background: /rgba\(0, 0, 0, 0\)|transparent/i, dividerHeight: /[1-9]/ });

	const dot = collapsedRail.getByTestId("pr-walkthrough-card-dot").nth(1);
	await expect(dot, "collapsed rail should expose clickable card-dot substeps").toBeVisible();
	await expect(dot, "card dots should have aria labels for narrow navigation").toHaveAttribute("aria-label", /card|orientation|design|significant|audit/i);
	await expect(dot, "card dots should expose tooltip text").toHaveAttribute("title", /\S+/);
	await expect.poll(() => dot.evaluate(el => {
		const style = getComputedStyle(el as HTMLElement);
		return { borderWidth: style.borderTopWidth, border: style.borderTopColor, background: style.backgroundColor, text: (el.textContent || "").trim() };
	}), { message: "unreviewed collapsed rail card dots should render as visible hollow circles" }).toMatchObject({ borderWidth: /[1-9]/, border: /^(?!rgba\(0, 0, 0, 0\))/i, background: /rgba\(0, 0, 0, 0\)|transparent/i, text: "" });
	return dot;
}

async function expectDiffExpandCollapseIfExposed(page: Page) {
	const diff = activeCard(page).getByTestId("pr-walkthrough-diff-block").first();
	await expect(diff).toBeVisible();
	const toggle = diff.getByTestId("pr-walkthrough-diff-toggle").first();
	if (await toggle.count() === 0) return;

	await expect(toggle, "diff blocks should expose an expand/collapse control when collapsible").toBeVisible();
	await expect(diff, "collapsible diff blocks should reflect their expanded state for tests and a11y").toHaveAttribute("data-expanded", /true|false/);
	const before = await diff.getAttribute("data-expanded");
	await toggle.click();
	await expect.poll(() => diff.getAttribute("data-expanded"), {
		timeout: 5_000,
		message: "clicking the diff header toggle should collapse/expand the diff block",
	}).not.toBe(before);
	await toggle.click();
}

async function activeCardId(page: Page): Promise<string> {
	await expect(activeCard(page)).toBeVisible();
	return (await activeCard(page).getAttribute("data-card-id")) || "";
}

async function selectCardById(page: Page, cardId: string) {
	const step = walkthroughPanel(page).locator(`${tid("pr-walkthrough-card-step")}[data-card-id="${cardId}"]`).first();
	await expect(step, `card step ${cardId} should be available`).toBeVisible({ timeout: 10_000 });
	await step.click();
	await expect.poll(() => activeCardId(page), {
		timeout: 5_000,
		message: `card ${cardId} should become active`,
	}).toBe(cardId);
}

function visibleCommentEditor(page: Page): Locator {
	return walkthroughPanel(page).locator(`${tid("pr-walkthrough-comment-editor")}:visible`).last();
}

async function waitForOpenCommentEditor(page: Page, message = "comment editor should be open") {
	const editor = visibleCommentEditor(page);
	await expect(editor, message).toBeVisible({ timeout: 5_000 });
	const input = editor.getByTestId("pr-walkthrough-comment-input");
	const save = editor.getByTestId("pr-walkthrough-comment-save");
	await expect(input, "open comment editor input should be visible").toBeVisible({ timeout: 5_000 });
	await expect(input, "open comment editor input should be enabled").toBeEnabled({ timeout: 5_000 });
	await expect(save, "open comment editor save button should be visible").toBeVisible({ timeout: 5_000 });
	await expect(save, "open comment editor save button should be enabled").toBeEnabled({ timeout: 5_000 });
	return { editor, input, save };
}

async function openLineCommentEditor(page: Page) {
	const line = activeCard(page).getByTestId("pr-walkthrough-diff-line").first();
	await expect(line, "diff lines should be commentable").toBeVisible({ timeout: 10_000 });
	await line.hover();
	const add = line.getByTestId("pr-walkthrough-line-comment-button").first();
	await expect(add, "hovering a diff line should reveal an inline + comment affordance").toBeVisible({ timeout: 5_000 });
	await expect.poll(async () => add.evaluate((el) => [
		el.textContent,
		el.getAttribute("aria-label"),
		el.getAttribute("title"),
	].filter(Boolean).join(" ").trim()), {
		timeout: 5_000,
		message: "line comment affordance should be visually/textually identifiable as +",
	}).toMatch(/\+/);
	await add.click();
	await waitForOpenCommentEditor(page);
}

async function saveOpenComment(page: Page, body: string) {
	const { editor, input, save } = await waitForOpenCommentEditor(page, "a visible comment editor should be ready before saving");
	await input.fill(body);
	await expect(input, "comment editor input should contain the draft before save").toHaveValue(body, { timeout: 5_000 });
	await expect(save, "comment editor save button should remain enabled after filling").toBeEnabled({ timeout: 5_000 });
	await save.click();
	await expect(editor, "saved comment editor should close").toBeHidden({ timeout: 5_000 });
	await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-comment").filter({ hasText: body })).toBeVisible({ timeout: 5_000 });
}

async function createLineComment(page: Page, body: string) {
	await openLineCommentEditor(page);
	await saveOpenComment(page, body);
}

async function createCommentOnDiffLine(page: Page, lineId: string, body: string) {
	const line = activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="${lineId}"]`).first();
	await expect(line, `diff line ${lineId} should be visible and commentable`).toBeVisible({ timeout: 10_000 });
	await line.hover();
	await line.getByTestId("pr-walkthrough-line-comment-button").click();
	const { editor } = await waitForOpenCommentEditor(page, `comment editor for diff line ${lineId} should open`);
	await expect(editor).toHaveAttribute("data-line-id", lineId, { timeout: 5_000 });
	await saveOpenComment(page, body);
}

async function editComment(page: Page, fromBody: string, toBody: string) {
	const comment = walkthroughPanel(page).getByTestId("pr-walkthrough-comment").filter({ hasText: fromBody }).first();
	await expect(comment).toBeVisible({ timeout: 5_000 });
	await comment.getByTestId("pr-walkthrough-comment-edit").click();
	await saveOpenComment(page, toBody);
	await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-comment").filter({ hasText: fromBody })).toBeHidden();
}

async function deleteComment(page: Page, body: string) {
	const comment = walkthroughPanel(page).getByTestId("pr-walkthrough-comment").filter({ hasText: body }).first();
	await expect(comment).toBeVisible({ timeout: 5_000 });
	await comment.getByTestId("pr-walkthrough-comment-delete").click();
	await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-comment").filter({ hasText: body })).toBeHidden({ timeout: 5_000 });
}

async function createCardComment(page: Page, body: string) {
	const addComment = activeCard(page).getByTestId("pr-walkthrough-add-card-comment");
	await expect(addComment, "active card should expose a card-level comment affordance before adding a comment").toBeVisible({ timeout: 10_000 });
	await expect(addComment, "card-level comment affordance should be enabled before adding a comment").toBeEnabled({ timeout: 5_000 });
	await addComment.click();
	await waitForOpenCommentEditor(page, "clicking the card-level comment affordance should open the comment editor");
	await saveOpenComment(page, body);
}

async function completeRemainingCardsWithLikes(page: Page) {
	const panel = walkthroughPanel(page);
	const visibleSteps = await panel.locator(`${tid("pr-walkthrough-card-dot")}, ${tid("pr-walkthrough-card-step")}`).count();
	const maxClicks = Math.max(visibleSteps + 2, 8);

	for (let i = 0; i < maxClicks; i++) {
		if (await panel.getByTestId("pr-walkthrough-audit").isVisible().catch(() => false)) return;
		const like = panel.getByTestId("pr-walkthrough-like").first();
		await expect(like, "Like should always be available to advance through cards").toBeVisible({ timeout: 5_000 });
		await like.click();
	}

	await expect(panel.getByTestId("pr-walkthrough-audit"), "walkthrough should enter Audit after all cards are decided").toBeVisible({ timeout: 10_000 });
}

test.describe("PR walkthrough panel", () => {
	test("launches from slash command with prototype header, labelled full-width rail, and split diff default", async ({ page }) => {
		const { panel, tab } = await setupWalkthrough(page, { width: 1920, height: 1080 });

		await expect(tab.locator(".goal-tab-pill-label"), "walkthrough tab should use the compact PR label").toHaveText("PR: #123");
		await expectPrototypeHeader(panel, { pr: /PR\s*#123/i, title: /walkthrough/i });
		await expectPrototypeCardHierarchy(page);
		const labelledRail = panel.getByTestId("pr-walkthrough-labelled-rail");
		await expect(labelledRail, "wide panel should show labelled phase/card navigation").toBeVisible();
		await expect(labelledRail, "sidebar should not duplicate the header PR headline").not.toContainText(/PR\s*#123/i);
		await expect(panel.getByTestId("pr-walkthrough-collapsed-rail"), "wide panel should not use the thin collapsed rail").toBeHidden();
		const orientationPhase = panel.getByTestId("pr-walkthrough-phase-button").filter({ hasText: "Orientation" });
		await expect(orientationPhase).toBeVisible();
		await expect(panel.getByTestId("pr-walkthrough-phase-button").filter({ hasText: "Key design choices" })).toBeVisible();
		await expect.poll(() => orientationPhase.evaluate(el => {
			const style = getComputedStyle(el as HTMLElement);
			const nameStyle = getComputedStyle(el.querySelector(".phase-name") as HTMLElement);
			const leadingRule = getComputedStyle(el.closest(".phase") as HTMLElement, "::before");
			return { background: style.backgroundColor, nameTransform: nameStyle.textTransform, nameWeight: nameStyle.fontWeight, leadingRuleContent: leadingRule.content };
		}), { message: "expanded phase navigation should mirror collapsed headers while using sidebar-goal title typography" }).toMatchObject({ background: /rgba\(0, 0, 0, 0\)|transparent/i, nameTransform: "uppercase", nameWeight: "500", leadingRuleContent: "none" });
		const secondPhase = panel.getByTestId("pr-walkthrough-phase-button").filter({ hasText: "Key design choices" });
		await expect.poll(() => secondPhase.evaluate(el => getComputedStyle(el.closest(".phase") as HTMLElement, "::before").height), { message: "expanded phases after the first should retain collapsed-style dividers" }).toMatch(/[1-9]/);
		const labelledCardStep = panel.getByTestId("pr-walkthrough-card-step").first();
		await expect.poll(() => labelledCardStep.evaluate(el => {
			const dot = el.querySelector(".card-dot") as HTMLElement;
			const title = el.querySelector(".card-title") as HTMLElement;
			const dotStyle = getComputedStyle(dot);
			const titleStyle = getComputedStyle(title);
			return { dotWidth: dotStyle.width, dotBackground: dotStyle.backgroundColor, titleWeight: titleStyle.fontWeight };
		}), { message: "expanded card rows should mirror collapsed status dots with sidebar-session typography" }).toMatchObject({ dotWidth: "14px", dotBackground: /rgba\(0, 0, 0, 0\)|transparent/i, titleWeight: "400" });
		await expect.poll(() => labelledRail.evaluate(root => {
			const phaseCards = root.querySelector(".phase-cards") as HTMLElement;
			const cardDot = (root.querySelector('[data-testid="pr-walkthrough-card-step"] .card-dot') as HTMLElement).getBoundingClientRect();
			const cardTitle = (root.querySelector('[data-testid="pr-walkthrough-card-step"] .card-title') as HTMLElement).getBoundingClientRect();
			return { paddingLeft: getComputedStyle(phaseCards).paddingLeft, titleAfterDot: cardTitle.x > cardDot.x };
		}), { message: "expanded card dots and titles should use the reduced sidebar indentation" }).toMatchObject({ paddingLeft: "8px", titleAfterDot: true });
		const railToggle = panel.getByTestId("pr-walkthrough-rail-toggle");
		await expect(railToggle, "expanded walkthrough sidebar should expose a bottom collapse button").toBeVisible();
		await expect(railToggle).toHaveAttribute("title", /Collapse walkthrough sidebar/);
		await expect(railToggle.locator("svg"), "walkthrough sidebar toggle should use the main sidebar panel icon").toBeVisible();
		await expect(railToggle, "walkthrough sidebar toggle should use the main sidebar button padding").toHaveCSS("padding", "8px");
		const railResize = panel.getByTestId("pr-walkthrough-rail-resize");
		await expect(railResize, "expanded walkthrough sidebar should expose a resize handle").toBeVisible();
		const railBeforeResize = await labelledRail.boundingBox();
		const resizeBox = await railResize.boundingBox();
		if (!railBeforeResize || !resizeBox) throw new Error("walkthrough rail resize geometry was unavailable");
		await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + 20);
		await page.mouse.down();
		await page.mouse.move(resizeBox.x + resizeBox.width / 2 + 64, resizeBox.y + 20);
		await page.mouse.up();
		await expect.poll(async () => {
			const box = await labelledRail.boundingBox();
			return box ? Math.round(box.width - railBeforeResize.width) : 0;
		}, { message: "dragging the walkthrough sidebar handle should resize the labelled rail" }).toBeGreaterThan(40);
		await railResize.dblclick();
		await expect.poll(async () => {
			const box = await labelledRail.boundingBox();
			return box ? Math.round(box.width) : 0;
		}, { message: "double-clicking the walkthrough sidebar resize handle should reset the rail width" }).toBe(240);
		await railToggle.click();
		const collapsedRail = panel.getByTestId("pr-walkthrough-collapsed-rail");
		await expect(collapsedRail, "walkthrough sidebar collapse button should switch to the compact rail").toBeVisible();
		await expect(collapsedRail.getByTestId("pr-walkthrough-rail-toggle")).toHaveAttribute("title", /Expand walkthrough sidebar/);
		await collapsedRail.getByTestId("pr-walkthrough-rail-toggle").click();
		await expect(panel.getByTestId("pr-walkthrough-labelled-rail"), "walkthrough sidebar expand button should restore the labelled rail").toBeVisible();
		await expect.poll(async () => {
			const [contentBox, innerBox] = await Promise.all([panel.locator(".content").boundingBox(), panel.locator(".inner").boundingBox()]);
			if (!contentBox || !innerBox) return false;
			const leftGutter = innerBox.x - contentBox.x;
			const rightGutter = contentBox.x + contentBox.width - (innerBox.x + innerBox.width);
			return leftGutter <= 30 && rightGutter <= 30;
		}, { message: "walkthrough content should use the available panel width without oversized gutters" }).toBe(true);
		await expect(activeCard(page).locator(".actions"), "interaction bar should keep breathing room above the action row without adding bottom margin").toHaveCSS("padding-top", "16px");
		await expect.poll(() => activeCard(page).locator(".actions").evaluate(el => getComputedStyle(el as HTMLElement, "::before").maskImage || getComputedStyle(el as HTMLElement, "::before").webkitMaskImage), { message: "action bar blur should fade in with a mask gradient" }).toContain("linear-gradient");
		await expect(activeCard(page).getByTestId("pr-walkthrough-like").locator(".decision-icon"), "like action should include a thumbs-up icon").toBeVisible();
		await expect(activeCard(page).getByTestId("pr-walkthrough-dislike").locator(".decision-icon"), "dislike action should include a thumbs-down icon").toBeVisible();
		await expect(activeCard(page).getByTestId("pr-walkthrough-like"), "like action label should stay stable even when comments exist").toContainText(/^Like$/);
		await expect(activeCard(page).getByTestId("pr-walkthrough-like"), "like button should start at the compact action height").toHaveCSS("min-height", "32px");
		await expect(activeCard(page).getByTestId("pr-walkthrough-like").locator(".next-icon"), "like action should use an icon instead of an arrow character").toBeVisible();
		await expect(activeCard(page).getByTestId("pr-walkthrough-dislike").locator(".next-icon"), "dislike action should also use a forward chevron icon").toBeVisible();
		await expect(activeCard(page).getByTestId("pr-walkthrough-prev").locator(".prev-icon"), "prev action should use an icon instead of an arrow character").toBeVisible();
		await expect(activeCard(page).getByTestId("pr-walkthrough-like"), "like action should never say Like anyway").not.toContainText(/Like anyway|→/i);
		await expect(activeCard(page).getByTestId("pr-walkthrough-prev"), "prev action should not render a literal arrow").not.toContainText(/←/);
		await expect.poll(async () => {
			const [thumbBox, nextBox] = await Promise.all([
				activeCard(page).getByTestId("pr-walkthrough-like").locator(".decision-icon").boundingBox(),
				activeCard(page).getByTestId("pr-walkthrough-like").locator(".next-icon").boundingBox(),
			]);
			return thumbBox && nextBox ? Math.abs((thumbBox.y + thumbBox.height / 2) - (nextBox.y + nextBox.height / 2)) <= 1 : false;
		}, { message: "like chevron should align vertically with the thumbs-up icon" }).toBe(true);
		await expectActiveDiffMode(page, "split");
		await expect(activeCard(page).locator(".line-text .tok-keyword").first(), "diff lines should include lightweight syntax highlighting").toBeVisible();
		await expect(activeCard(page).getByTestId("pr-walkthrough-diff-additions").first(), "diff headers should show line addition counts").toContainText(/\+\d+/);
		await expectOneHorizontalScrollerPerDiff(page);
		await expectSplitDiffColumnsAligned(page);
		await expectDiffExpandCollapseIfExposed(page);
	});

	test("orientation renders original PR description as collapsed safe source material", async ({ page }) => {
		const prBody = `# Demo PR body

This is the author's source description with **markdown**.

<script>window.__prBodyInjected = true</script>`;
		const { panel } = await setupWalkthrough(page, { width: 1920, height: 1080 }, "/walkthrough-pr 791", prBody);
		const original = activeCard(page).getByTestId("pr-walkthrough-original-description");

		await expect(original, "orientation should expose the original PR body as source material").toBeVisible();
		await expect(original.getByTestId("pr-walkthrough-original-description-toggle")).toContainText(/Original PR description/i);
		await expect(original).toContainText(/Source material from the PR body/i);
		await expect(original.getByTestId("pr-walkthrough-original-description-body"), "PR body should start collapsed").toBeHidden();

		await original.getByTestId("pr-walkthrough-original-description-toggle").click();
		const body = original.getByTestId("pr-walkthrough-original-description-body");
		await expect(body).toBeVisible();
		await expect(body).toContainText("# Demo PR body");
		await expect(body).toContainText("<script>window.__prBodyInjected = true</script>");
		await expect.poll(() => page.evaluate(() => (window as any).__prBodyInjected === true), {
			message: "original PR body must be rendered as escaped text, not executable HTML",
		}).toBe(false);

		await panel.getByTestId("pr-walkthrough-card-step").filter({ hasText: "Changeset-agnostic model" }).click();
		await expect(activeCard(page).getByTestId("pr-walkthrough-original-description"), "non-orientation cards should not duplicate the PR body").toHaveCount(0);
	});

	test("narrow rail collapses to pips and clickable card dots, defaults inline, and can switch back to split", async ({ page }) => {
		const { panel } = await setupWalkthrough(page, { width: 1100, height: 820 });

		await expect(panel.getByTestId("pr-walkthrough-labelled-rail"), "narrow panel should hide labelled rail").toBeHidden();
		await expectActiveDiffMode(page, "inline");
		await expect(activeCard(page).locator(".decision-note"), "narrow action bars should hide the note before wrapping controls").toBeHidden();
		await expect.poll(async () => {
			const buttons = activeCard(page).locator(".actions button");
			const boxes = await Promise.all([buttons.nth(0).boundingBox(), buttons.nth(1).boundingBox(), buttons.nth(2).boundingBox()]);
			const concrete = boxes.filter(Boolean) as Array<{ y: number; height: number }>;
			if (concrete.length !== boxes.length) return false;
			const centers = concrete.map(box => box.y + box.height / 2);
			return Math.max(...centers) - Math.min(...centers) <= 1;
		}, { message: "narrow action buttons should stay on a single row" }).toBe(true);

		const dot = await expectCollapsedRailPipsAndDots(panel);
		const before = await activeCardId(page);
		await dot.click();
		await expect.poll(() => activeCardId(page), {
			timeout: 5_000,
			message: "clicking a collapsed card dot should change the active card",
		}).not.toBe(before);

		await panel.getByTestId("diff-mode-split").click();
		await expectActiveDiffMode(page, "split");
		await expectOneHorizontalScrollerPerDiff(page);
		await expectSplitDiffColumnsAligned(page);
	});

	test("collapsed rail card dots encode liked and disliked review decisions", async ({ page }) => {
		const { panel } = await setupWalkthrough(page, { width: 1100, height: 820 });
		await panel.getByTestId("pr-walkthrough-like").first().click();
		const likedDot = panel.getByTestId("pr-walkthrough-card-dot").first();
		await expect(likedDot.locator("svg"), "liked cards should show a thumbs-up icon").toBeVisible();
		await expect(likedDot.locator("svg path").first()).toHaveAttribute("d", "M7 10v12");
		await expect(likedDot, "liked cards should use primary filled-circle styling").toHaveClass(/liked/);
		await expect.poll(() => likedDot.evaluate(el => getComputedStyle(el as HTMLElement).backgroundColor), { message: "liked sidebar dots should use a filled status circle" }).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/i);
		await likedDot.click();
		await expect.poll(() => likedDot.evaluate(el => getComputedStyle(el as HTMLElement).boxShadow), { message: "selected liked dots should keep the active glow" }).not.toBe("none");

		const secondDot = panel.getByTestId("pr-walkthrough-card-dot").nth(1);
		await secondDot.click();
		await createCardComment(page, `collapsed-dislike-${Date.now()}`);
		await panel.getByTestId("pr-walkthrough-dislike").first().click();
		const dislikedDot = panel.getByTestId("pr-walkthrough-card-dot").nth(1);
		await expect(dislikedDot.locator("svg"), "disliked cards should show a thumbs-down icon").toBeVisible();
		await expect(dislikedDot.locator("svg path").first()).toHaveAttribute("d", "M17 14V2");
		await expect(dislikedDot, "disliked cards should use danger filled-circle styling").toHaveClass(/disliked/);
		await expect.poll(() => dislikedDot.evaluate(el => getComputedStyle(el as HTMLElement).backgroundColor), { message: "disliked sidebar dots should use a filled status circle" }).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/i);
		await dislikedDot.click();
		await expect.poll(() => dislikedDot.evaluate(el => getComputedStyle(el as HTMLElement).boxShadow), { message: "selected disliked dots should keep the active glow" }).not.toBe("none");

		const pendingDot = panel.getByTestId("pr-walkthrough-card-dot").nth(2);
		await expect(pendingDot, "pending cards should stay hollow").toHaveText("");
		await expect(pendingDot).not.toHaveClass(/liked|disliked/);
	});

	test("diff hunks default to compact GitHub-like context and can expand on demand", async ({ page }) => {
		const { panel } = await setupWalkthrough(page, { width: 1100, height: 820 });
		await page.evaluate(async () => {
			const walkthrough = document.querySelector("pr-walkthrough-panel") as any;
			const focalIndex = 27;
			const lines = Array.from({ length: 55 }, (_, index) => ({
				id: `ctx-${index + 1}`,
				side: index === focalIndex ? "new" : "context",
				oldLine: index === focalIndex ? undefined : index + 1,
				newLine: index + 1,
				kind: index === focalIndex ? "add" : "context",
				text: index === focalIndex ? "added focal line" : index === 23 ? "function contextFixture() {" : `context ${index + 1}`,
			}));
			walkthrough.changeset = { baseSha: "base", headSha: "head", provider: "github", title: "Long context fixture", filesChanged: 1, additions: 1, deletions: 0 };
			walkthrough.cards = [{
				id: "long-context-card",
				phaseId: "significant",
				title: "Long context hunk",
				summary: "This card verifies compact diff context.",
				diffBlocks: [{ id: "long-context-block", filePath: "src/context.ts", hunks: [{ id: "long-context-hunk", header: "@@ -1,55 +1,55 @@ function fallbackSignature() {", lines }] }],
			}];
			walkthrough.status = "ready";
			await walkthrough.updateComplete;
		});
		await expect(activeCard(page).getByTestId("pr-walkthrough-card-title")).toContainText("Long context hunk");
		await expect(activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="ctx-1"]`), "far context should be hidden by default").toBeHidden();
		await expect(activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="ctx-25"]`), "near context should remain visible by default").toBeVisible();
		await expect(activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="ctx-31"]`), "near trailing context should remain visible by default").toBeVisible();
		const hunkHeaders = activeCard(page).getByTestId("pr-walkthrough-hunk-header");
		await expect(hunkHeaders, "context controls should bracket the visible diff context instead of stacking above it").toHaveCount(2);
		const hunkHeader = hunkHeaders.first();
		const trailingContextHeader = hunkHeaders.nth(1);
		const hunkSignature = hunkHeader.locator(".hunk-signature");
		await expect(hunkSignature, "context controls should show the signature that will be revealed next, not the fallback hunk header").toContainText("function contextFixture() {");
		await expect(hunkSignature, "hunk range counts should be hidden from the visible signature").not.toContainText("@@");
		await expect(hunkHeader, "hunk range counts should not appear in the blue-row tooltip").not.toHaveAttribute("title", /@@/);
		const toggles = activeCard(page).getByTestId("pr-walkthrough-context-toggle");
		await expect(toggles.first(), "context controls should be icon-only").toHaveText("");
		await expect(toggles.first()).toHaveAttribute("data-context-direction", "above");
		await expect(toggles.first()).toHaveAttribute("title", /Show 20 more lines above/i);
		await expect(toggles.nth(1)).toHaveAttribute("data-context-direction", "below");
		await expect(toggles.nth(1)).toHaveAttribute("title", /Show 20 more lines below/i);
		await expect(trailingContextHeader.locator(".hunk-signature"), "the trailing context control row should not show duplicate code/signature text").toHaveText("");
		await expect.poll(async () => {
			const [headerBox, toggleBox] = await Promise.all([hunkHeader.boundingBox(), toggles.first().boundingBox()]);
			return headerBox && toggleBox ? toggleBox.y >= headerBox.y && toggleBox.y + toggleBox.height <= headerBox.y + headerBox.height : false;
		}, { message: "context buttons should sit inside the hunk signature contrast bar" }).toBe(true);
		await expect.poll(async () => {
			const [aboveBox, firstLineBox, lastLineBox, belowBox] = await Promise.all([
				toggles.first().boundingBox(),
				activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="ctx-25"]`).boundingBox(),
				activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="ctx-31"]`).boundingBox(),
				toggles.nth(1).boundingBox(),
			]);
			return aboveBox && firstLineBox && lastLineBox && belowBox ? aboveBox.y < firstLineBox.y && belowBox.y > lastLineBox.y : false;
		}, { message: "above/below context controls should bracket the visible diff context" }).toBe(true);
		await expect.poll(async () => {
			const [headerBox, lineBox] = await Promise.all([
				hunkHeader.boundingBox(),
				activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="ctx-25"]`).boundingBox(),
			]);
			return headerBox && lineBox ? Math.abs(headerBox.height - lineBox.height) <= 1 : false;
		}, { message: "blue context rows should match normal diff row height" }).toBe(true);
		await expect.poll(async () => {
			const [cellBox, toggleBox] = await Promise.all([hunkHeader.locator(".hunk-context-cell").boundingBox(), toggles.first().boundingBox()]);
			return cellBox && toggleBox ? toggleBox.width >= cellBox.width - 8 && toggleBox.width < cellBox.width : false;
		}, { message: "context buttons should span the line-number/sign gutter with a small margin" }).toBe(true);
		await expect.poll(async () => {
			const [signatureBox, textBox] = await Promise.all([
				hunkSignature.boundingBox(),
				activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="ctx-25"] .line-text`).boundingBox(),
			]);
			return signatureBox && textBox ? Math.abs(signatureBox.x - textBox.x) <= 1 : false;
		}, { message: "hunk signature should align with diff code text, not line numbers" }).toBe(true);
		await toggles.first().click();
		await expect(activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="ctx-5"]`), "expanding above context should reveal the next 20 leading lines").toBeVisible();
		await expect(activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="ctx-1"]`), "remaining leading context should stay hidden until expanded again").toBeHidden();
		await activeCard(page).locator(`${tid("pr-walkthrough-context-toggle")}[data-context-direction="above"]`).click();
		await expect(activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="ctx-1"]`), "repeated expansion should reveal context back to the start of the file hunk").toBeVisible();
		await expect(activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="ctx-55"]`), "trailing context should remain hidden until expanded below").toBeHidden();
		await activeCard(page).locator(`${tid("pr-walkthrough-context-toggle")}[data-context-direction="below"]`).click();
		await expect(activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="ctx-51"]`), "expanding below context should reveal the next 20 trailing lines").toBeVisible();
		await activeCard(page).locator(`${tid("pr-walkthrough-context-toggle")}[data-context-direction="below"]`).click();
		await expect(activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="ctx-55"]`), "repeated expansion should reveal context through the end of the file hunk").toBeVisible();
		await expect(activeCard(page).getByTestId("pr-walkthrough-hunk-header"), "top/bottom file edges without controls should not render empty blue bars").toHaveCount(1);
	});

	test("diff hunk headers prefer the containing declaration scope over later visible symbols", async ({ page }) => {
		await setupWalkthrough(page, { width: 1100, height: 820 });
		await page.evaluate(async () => {
			const walkthrough = document.querySelector("pr-walkthrough-panel") as any;
			const focalIndex = 27;
			const lines = Array.from({ length: 55 }, (_, index) => ({
				id: `visible-sig-${index + 1}`,
				side: index === focalIndex ? "new" : "context",
				oldLine: index === focalIndex ? undefined : index + 1,
				newLine: index + 1,
				kind: index === focalIndex ? "add" : "context",
				text: index === focalIndex
					? "const DEFAULT_DIFF_CONTEXT_LINES = 3;"
					: index === 7
						? "const PHASES: Array<{ id: PrWalkthroughPhaseId; label: string }> = ["
						: index === 30
							? "interface SideBySidePair {"
							: `context ${index + 1}`,
			}));
			walkthrough.changeset = { baseSha: "base", headSha: "head", provider: "github", title: "Visible context fixture", filesChanged: 1, additions: 1, deletions: 0 };
			walkthrough.cards = [{
				id: "visible-signature-card",
				phaseId: "significant",
				title: "Visible signature hunk",
				summary: "This card verifies containing scope context.",
				diffBlocks: [{ id: "visible-signature-block", filePath: "src/context.ts", hunks: [{ id: "visible-signature-hunk", header: "@@ -1,55 +1,55 @@", lines }] }],
			}];
			walkthrough.status = "ready";
			await walkthrough.updateComplete;
		});

		const hunkHeader = activeCard(page).getByTestId("pr-walkthrough-hunk-header").first();
		await expect(hunkHeader.locator(".hunk-signature"), "containing declaration scope should label the blue row instead of the next visible interface").toContainText("const PHASES: Array<{ id: PrWalkthroughPhaseId; label: string }> = [");
		await expect(hunkHeader, "raw hunk ranges should still be absent from the tooltip").not.toHaveAttribute("title", /@@/);
	});

	test("diff hunk headers hide empty top-of-file context labels", async ({ page }) => {
		await setupWalkthrough(page, { width: 1100, height: 820 });
		await page.evaluate(async () => {
			const walkthrough = document.querySelector("pr-walkthrough-panel") as any;
			const focalIndex = 2;
			const lines = Array.from({ length: 35 }, (_, index) => ({
				id: `top-file-${index + 1}`,
				side: index === focalIndex ? "new" : "context",
				oldLine: index === focalIndex ? undefined : index + 1,
				newLine: index + 1,
				kind: index === focalIndex ? "add" : "context",
				text: index === focalIndex ? "const topLevelChange = true;" : `context ${index + 1}`,
			}));
			walkthrough.changeset = { baseSha: "base", headSha: "head", provider: "github", title: "Top of file fixture", filesChanged: 1, additions: 1, deletions: 0 };
			walkthrough.cards = [{
				id: "top-file-card",
				phaseId: "significant",
				title: "Top file hunk",
				summary: "This card verifies empty top-of-file context labels.",
				diffBlocks: [{ id: "top-file-block", filePath: "src/top.ts", hunks: [{ id: "top-file-hunk", header: "@@ -1,35 +1,35 @@", lines }] }],
			}];
			walkthrough.status = "ready";
			await walkthrough.updateComplete;
		});

		const firstLine = activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="top-file-1"]`);
		const firstHeader = activeCard(page).getByTestId("pr-walkthrough-hunk-header").first();
		await expect.poll(async () => {
			const [lineBox, headerBox] = await Promise.all([firstLine.boundingBox(), firstHeader.boundingBox()]);
			return lineBox && headerBox ? lineBox.y < headerBox.y : false;
		}, { message: "empty top-of-file context labels should be hidden instead of borrowing later symbols" }).toBe(true);
		await expect(firstHeader, "top-of-file hunk rows should not expose raw hunk ranges as tooltips").not.toHaveAttribute("title", /@@/);
	});

	test("renders right-side split comments for paired replacement rows", async ({ page }) => {
		const body = `right-side-split-comment-${Date.now()}`;
		await setupWalkthrough(page, { width: 1920, height: 1080 });
		await selectCardById(page, "significant-diff");
		await expectActiveDiffMode(page, "split");

		const rightLine = activeCard(page).locator(`${tid("pr-walkthrough-diff-line")}[data-line-id="dr-4"][data-line-side="new"]`).first();
		await expect(rightLine, "paired new-side replacement line should render in split mode").toBeVisible();
		await createCommentOnDiffLine(page, "dr-4", body);
		await expect(activeCard(page).getByTestId("pr-walkthrough-comment").filter({ hasText: body }), "right-side split line comment should render below the paired row").toBeVisible({ timeout: 5_000 });
		await expect(activeCard(page).locator(`${tid("pr-walkthrough-comment")}[data-line-id="dr-4"]`).filter({ hasText: body })).toBeVisible();
	});

	test("audit phase includes normal diff/comment behavior while keeping the final draft visible", async ({ page }) => {
		const auditLineComment = `audit-line-comment-${Date.now()}`;
		const auditCardComment = `audit-card-comment-${Date.now()}`;
		const { panel } = await setupWalkthrough(page, { width: 1920, height: 1080 });

		await completeRemainingCardsWithLikes(page);
		await expect(activeCard(page)).toHaveAttribute("data-phase-id", "audit");
		await expect(activeCard(page).getByTestId("pr-walkthrough-diff-block").first(), "audit should expose remaining-line diff blocks like other cards").toBeVisible({ timeout: 10_000 });
		await expect(activeCard(page).getByTestId("pr-walkthrough-card-comments"), "audit should keep card-level comment support").toBeVisible();
		await expect(panel.getByTestId("pr-walkthrough-audit"), "audit should preserve the final draft review surface").toBeVisible();
		await expect(panel.getByTestId("pr-walkthrough-draft")).toBeVisible();

		await createCommentOnDiffLine(page, "ar-3", auditLineComment);
		await createCardComment(page, auditCardComment);
		await expect(panel.getByTestId("pr-walkthrough-draft"), "audit line comments should feed the final draft").toContainText(auditLineComment);
		await expect(panel.getByTestId("pr-walkthrough-draft"), "audit card comments should feed the final draft").toContainText(auditCardComment);
	});

	test("supports line comments, dislike gating, revisions, audit draft, and reload persistence", async ({ page }) => {
		const timestamp = Date.now();
		const firstLineComment = `line-comment-${timestamp}`;
		const editedLineComment = `edited-line-comment-${timestamp + 1}`;
		const broadConcern = `broad-concern-${Date.now()}`;
		const revisedConcern = `revised-concern-${Date.now()}`;

		const { panel } = await setupWalkthrough(page, { width: 1920, height: 1080 });

		const dislike = panel.getByTestId("pr-walkthrough-dislike").first();
		await expect(dislike, "Dislike should be disabled until the active card has a comment").toBeDisabled();

		await createLineComment(page, firstLineComment);
		await editComment(page, firstLineComment, editedLineComment);
		await deleteComment(page, editedLineComment);
		await expect(dislike, "Dislike should become disabled again after deleting the only comment").toBeDisabled();

		await createCardComment(page, broadConcern);
		await expect(dislike, "Dislike should enable once a custom card or line comment exists").toBeEnabled();
		const firstCard = await activeCardId(page);
		await dislike.click();
		await expect.poll(() => activeCardId(page), {
			timeout: 5_000,
			message: "Dislike should record the concern and advance to the next card",
		}).not.toBe(firstCard);

		await panel.getByTestId("pr-walkthrough-prev").click();
		await expect.poll(() => activeCardId(page), {
			timeout: 5_000,
			message: "Prev should return to the disliked card so its concerns can be revised",
		}).toBe(firstCard);
		await deleteComment(page, broadConcern);
		await expect(dislike, "Deleting the last supporting comment should clear the disliked decision and disable Dislike").toBeDisabled();
		await expect(activeCard(page).locator(".decision-note"), "decision status text should not be used for selected actions").not.toContainText(/Current:/);
		await createCardComment(page, broadConcern);
		await expect(dislike).toBeEnabled();
		await dislike.click();
		await expect.poll(() => activeCardId(page), {
			timeout: 5_000,
			message: "Dislike should be available again after adding a replacement concern",
		}).not.toBe(firstCard);

		const secondCard = await activeCardId(page);
		await panel.getByTestId("pr-walkthrough-like").click();
		await expect.poll(() => activeCardId(page), {
			timeout: 5_000,
			message: "Like should advance to the next card",
		}).not.toBe(secondCard);

		await panel.getByTestId("pr-walkthrough-prev").click();
		await expect.poll(() => activeCardId(page), {
			timeout: 5_000,
			message: "Prev should backtrack to the liked card for revision",
		}).toBe(secondCard);
		await expect(panel.getByTestId("pr-walkthrough-like"), "selected decisions should be indicated by button styling").toHaveClass(/decision-selected/);
		await expect(panel.getByTestId("pr-walkthrough-like")).toHaveAttribute("aria-pressed", "true");
		await createCardComment(page, revisedConcern);
		await panel.getByTestId("pr-walkthrough-dislike").click();

		await completeRemainingCardsWithLikes(page);

		const audit = panel.getByTestId("pr-walkthrough-audit");
		const draft = panel.getByTestId("pr-walkthrough-draft");
		await expect(audit).toBeVisible();
		await expect(draft, "Audit draft should include broad concerns for disliked cards").toContainText(broadConcern);
		await expect(draft, "Audit draft should include revised concerns after using Prev").toContainText(revisedConcern);
		await expect(draft, "Audit draft should group accepted/liked context").toContainText(/approved|liked|accepted/i);
		await expect(draft, "Audit draft should group concerns for disliked cards").toContainText(/concern|disliked|changes requested/i);
		await expectActiveWalkthroughSurface(page);

		await page.reload();
		await expectWalkthroughOpened(page);
		await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-audit"), "active walkthrough audit state should restore after reload").toBeVisible({ timeout: 10_000 });
		await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-draft")).toContainText(broadConcern);
		await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-draft")).toContainText(revisedConcern);
	});

	test("fullscreen toolbar control enters fullscreen on live child walkthroughs (user-initiated)", async ({ page }) => {
		// The in-app walkthrough panel now shares the HTML preview panel's resize
		// semantics: clicking fullscreen on a live-child-hosted ready walkthrough
		// ENTERS fullscreen (it used to be force-reset back to split). The component
		// content stays mounted and the GitHub/diff-mode chrome is preserved.
		await setupWalkthrough(page, { width: 1600, height: 900 }, WALKTHROUGH_URL_COMMAND);

		const fullscreenState = () => page.evaluate(() => {
			const s = (window as any).bobbitState ?? (window as any).__bobbitState;
			return s?.previewPanelFullscreen === true;
		});
		// In the split (narrow) view the GitHub mark and inline diff mode are present.
		await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-pr-link").locator("svg"), "walkthrough GitHub button should include the GitHub mark").toBeVisible();
		await expectActiveDiffMode(page, "inline");
		await expect.poll(fullscreenState, { timeout: 10_000, message: "a ready walkthrough must not auto-enter fullscreen" }).toBe(false);

		const fullscreen = page.locator(`${tid("side-panel-fullscreen")}, ${tid("pr-walkthrough-fullscreen")}, button[title*="Fullscreen"]`).first();
		await expect(fullscreen, "active walkthrough tabs should expose the same fullscreen toolbar affordance as preview panes").toBeVisible({ timeout: 10_000 });
		await fullscreen.click();

		const fullscreenRoot = page.locator(`${tid("side-panel-fullscreen-root")}, ${tid("pr-walkthrough-fullscreen-root")}, .preview-fullscreen-prompt`).first();
		await expect.poll(fullscreenState, { timeout: 10_000, message: "clicking fullscreen on a live child walkthrough must enter fullscreen — identical to the preview panel" }).toBe(true);
		await expect(fullscreenRoot, "entering fullscreen must hide the chat and render the compact fullscreen prompt").toBeVisible({ timeout: 10_000 });
		await expect(walkthroughPanel(page), "walkthrough content should remain mounted in fullscreen").toBeVisible();
	});

	test("in-app ready walkthrough panel resize controls are user-driven", async ({ page }) => {
		// Reproduces the IN-APP side-panel resize bug. The walkthrough is hosted by
		// a LIVE child session (setupWalkthrough), which is exactly the case
		// `suppressFullscreenForLiveWalkthrough` (render.ts) force-resets to split on
		// every render — so the toolbar fullscreen button silently bounces back and
		// the panel can auto-fullscreen on its own. After the fix the in-app
		// walkthrough panel behaves identically to the HTML preview panel: it starts
		// in split view (no auto-fullscreen), the fullscreen/collapse toolbar buttons
		// and the resize keyboard shortcuts all operate on it, and the state persists
		// across reload. MUST FAIL on current HEAD at the fullscreen-enter assertion.
		await setupWalkthrough(page, { width: 1600, height: 900 });

		const fullscreenState = () => page.evaluate(() => {
			const s = (window as any).bobbitState ?? (window as any).__bobbitState;
			return s?.previewPanelFullscreen === true;
		});
		const fullscreenRoot = page.locator(".preview-fullscreen-prompt").first();
		const fullscreenButton = page.locator(`${tid("pr-walkthrough-fullscreen")}, button[title*="Fullscreen"]`).first();
		const collapseButton = () => page.locator(`.goal-preview-panel button[title*="Collapse preview"]`).first();
		const expandButton = () => page.locator(`button[title*="Expand preview"]`).first();

		// (1) No auto-fullscreen: a ready walkthrough must start in split view, with
		// the chat prompt visible. Fullscreen is strictly user-initiated.
		await expect.poll(fullscreenState, { timeout: 10_000, message: "ready walkthrough panel must not auto-enter fullscreen — fullscreen is user-initiated only" }).toBe(false);
		await expect(fullscreenRoot, "ready walkthrough must start in split view, not the chat-hiding fullscreen layout").toBeHidden({ timeout: 10_000 });
		await expect(page.locator("textarea").first(), "split view should keep the chat prompt visible").toBeVisible({ timeout: 10_000 });

		// (2) Fullscreen button works — THE core failing assertion on current HEAD.
		// suppressFullscreenForLiveWalkthrough force-resets previewPanelFullscreen to
		// false on the next render, so the chat-hiding fullscreen layout never sticks.
		await expect(fullscreenButton, "in-app walkthrough toolbar must expose a fullscreen control").toBeVisible({ timeout: 10_000 });
		await fullscreenButton.click();
		await expect.poll(fullscreenState, { timeout: 10_000, message: "clicking the in-app fullscreen control must enter fullscreen (chat hidden) — identical to the preview panel" }).toBe(true);
		await expect(fullscreenRoot, "entering fullscreen must hide the chat and render the compact fullscreen prompt").toBeVisible({ timeout: 10_000 });
		await expect(walkthroughPanel(page), "walkthrough content must remain mounted in fullscreen").toBeVisible({ timeout: 10_000 });

		// (4) Keyboard shortcut operates on the panel: toggle-preview (Ctrl+]) steps
		// fullscreen → split.
		await page.keyboard.press("Control+]");
		await expect.poll(fullscreenState, { timeout: 10_000, message: "the toggle-preview (Ctrl+]) shortcut must exit fullscreen on the in-app walkthrough panel" }).toBe(false);
		await expect(fullscreenRoot, "exiting fullscreen via keyboard must restore the split chat layout").toBeHidden({ timeout: 10_000 });
		await expect(walkthroughPanel(page), "exiting fullscreen should keep the walkthrough in split view").toBeVisible({ timeout: 10_000 });

		// (3) Collapse works: the collapse button hides the panel body and reveals an
		// expand control.
		await expect(collapseButton(), "in-app walkthrough toolbar must expose a collapse control").toBeVisible({ timeout: 10_000 });
		await collapseButton().click();
		await expect(expandButton(), "collapsing the in-app walkthrough must reveal an expand control").toBeVisible({ timeout: 10_000 });
		await expect(walkthroughPanel(page), "collapsed in-app walkthrough should hide the panel body").toBeHidden({ timeout: 10_000 });

		// (5) Persistence across reload: the collapsed state must survive a reload.
		await page.reload();
		await expect(expandButton(), "collapsed in-app walkthrough state must persist across reload").toBeVisible({ timeout: 20_000 });
		await expect(walkthroughPanel(page), "collapsed walkthrough panel body should stay hidden after reload").toBeHidden({ timeout: 10_000 });

		// Expanding restores the panel body.
		await expandButton().click();
		await expectWalkthroughOpened(page);
		await expect(walkthroughPanel(page), "expanding should restore the in-app walkthrough panel body").toBeVisible({ timeout: 10_000 });
	});

	test("open-in-new-tab toolbar control renders the same walkthrough in a standalone wide route", async ({ page, context }) => {
		const { tab } = await setupWalkthrough(page, { width: 1600, height: 900 });
		const tabId = await tab.getAttribute("data-panel-tab-id");

		const openStandalone = page.locator(`${tid("side-panel-open-in-new-tab")}, ${tid("pr-walkthrough-open-in-new-tab")}, a[title*="Open walkthrough"], button[title*="Open walkthrough"]`).first();
		await expect(openStandalone, "active walkthrough tabs should expose an open-in-new-tab toolbar affordance").toBeVisible({ timeout: 10_000 });
		const [standalone] = await Promise.all([
			context.waitForEvent("page"),
			openStandalone.click(),
		]);
		await standalone.setViewportSize({ width: 1700, height: 1000 });
		await standalone.waitForLoadState("domcontentloaded");
		await expect(standalone, "standalone URL should preserve walkthrough/tab identity").toHaveURL(/walkthrough|pr-walkthrough/);
		if (tabId) await expect(standalone.locator(`${tid("pr-walkthrough-panel-root")}[data-panel-tab-id="${tabId}"]`)).toBeVisible({ timeout: 15_000 });
		await expect(standalone.getByTestId("pr-walkthrough-standalone-topbar"), "standalone route should use PR Walkthrough chrome").toContainText("PR Walkthrough");
		await expect(standalone.getByTestId("pr-walkthrough-standalone-topbar"), "standalone route should not expose the old standalone label").not.toContainText("Standalone walkthrough");
		await expect(standalone.getByTestId("pr-walkthrough-standalone").locator(":scope > .border-b"), "standalone route should not add a duplicate title bar above the walkthrough header").toHaveCount(0);
		await expect(walkthroughPanel(standalone), "standalone tab should render the same walkthrough component").toBeVisible({ timeout: 15_000 });
		await expectActiveDiffMode(standalone, "split");
		await standalone.close();
	});

	test("standalone ready walkthrough has no panel-level resize chrome but keeps its internal rail toggle", async ({ page, context }) => {
		// A popped-out standalone walkthrough IS the whole browser window — there is
		// no adjacent chat pane to hide — so it must NOT render any panel-level
		// fullscreen / collapse / expand chrome (see
		// docs/design/walkthrough-panel-resize-fix.md). The walkthrough fills the
		// window. The component's OWN internal review-rail toggle still works.
		await setupWalkthrough(page, { width: 1600, height: 900 });

		const openStandalone = page.locator(`${tid("side-panel-open-in-new-tab")}, ${tid("pr-walkthrough-open-in-new-tab")}, a[title*="Open walkthrough"], button[title*="Open walkthrough"]`).first();
		await expect(openStandalone, "active walkthrough tabs should expose an open-in-new-tab toolbar affordance").toBeVisible({ timeout: 10_000 });
		const [standalone] = await Promise.all([
			context.waitForEvent("page"),
			openStandalone.click(),
		]);
		await standalone.setViewportSize({ width: 1700, height: 1000 });
		await standalone.waitForLoadState("domcontentloaded");
		await expect(standalone, "standalone URL should preserve walkthrough/tab identity").toHaveURL(/walkthrough|pr-walkthrough/);
		await expect(walkthroughPanel(standalone), "standalone route should render the ready walkthrough component").toBeVisible({ timeout: 15_000 });

		// (1) No panel-level fullscreen / collapse / expand chrome on the standalone
		// route. NB: the component's OWN internal rail toggle uses titles like
		// "Collapse/Expand walkthrough sidebar" — that one must stay (asserted below),
		// so these locators target only the panel-level "...preview" chrome.
		await expect(standalone.locator(`${tid("pr-walkthrough-fullscreen")}, ${tid("side-panel-fullscreen")}, button[title*="Fullscreen"]`), "standalone walkthrough must not render a panel-level fullscreen control").toHaveCount(0);
		await expect(standalone.locator(`button[title*="Collapse preview"]`), "standalone walkthrough must not render a panel-level collapse control").toHaveCount(0);
		await expect(standalone.locator(`${tid("preview-expand")}, button[title*="Expand preview"]`), "standalone walkthrough must not render a panel-level expand control").toHaveCount(0);

		// (2) The walkthrough fills the window — the panel never enters fullscreen on its own.
		const fullscreenState = () => standalone.evaluate(() => {
			const s = (window as any).bobbitState ?? (window as any).__bobbitState;
			return s?.previewPanelFullscreen === true;
		});
		await expect.poll(fullscreenState, { timeout: 10_000, message: "standalone walkthrough must not auto-enter the panel fullscreen state" }).toBe(false);

		// (3) The component's own internal rail toggle still works on the standalone route.
		const railToggle = walkthroughPanel(standalone).getByTestId("pr-walkthrough-rail-toggle").first();
		await expect(railToggle, "standalone route must keep the component's internal rail toggle").toBeVisible({ timeout: 10_000 });
		await railToggle.click();
		await expect(walkthroughPanel(standalone).getByTestId("pr-walkthrough-collapsed-rail"), "internal rail collapse should remain interactive on the standalone route").toBeVisible({ timeout: 10_000 });
		await expect(walkthroughPanel(standalone), "walkthrough content should remain mounted after toggling the internal rail").toBeVisible();

		await standalone.close();
	});

	test("slash command creates a child session, waits for YAML, then applies interactive ready cards", async ({ page, context }) => {
		const waiting = await setupWaitingWalkthrough(page, { width: 1920, height: 1080 }, "/walkthrough-pr 789");
		await expect(page.getByTestId("pr-walkthrough-panel-root"), "child should remain in waiting state until YAML submission succeeds").toHaveAttribute("data-walkthrough-status", "waiting_for_yaml");
		const { panel, tab } = await submitValidWalkthroughYaml(page, waiting);
		const tabId = await tab.getAttribute("data-panel-tab-id");
		await expect(tab).toHaveAttribute("data-panel-tab-id", /^walkthrough:/);
		await expect(walkthroughPanel(page).locator(".title"), "header should switch from launch placeholder to resolved PR metadata").toContainText("PR #789: Resolved Walkthrough PR");
		await expect(activeCard(page).getByTestId("pr-walkthrough-card-title"), "cards should come from the YAML-backed ready payload").toContainText("Separate walkthrough from chat");
		await expect(panel.getByTestId("pr-walkthrough-waiting")).toHaveCount(0);

		const firstCardId = await activeCard(page).getAttribute("data-card-id");
		const like = activeCard(page).getByTestId("pr-walkthrough-like");
		await like.click();
		await expect(walkthroughPanel(page).locator(`${tid("pr-walkthrough-card-step")}[data-card-id="${firstCardId}"]`), "ready card like button should record a decision after YAML submission").toHaveClass(/liked/);
		const diff = activeCard(page).getByTestId("pr-walkthrough-diff-block").first();
		await diff.getByTestId("pr-walkthrough-diff-toggle").click();
		await expect(diff, "diff block collapse should remain interactive after YAML submission").toHaveAttribute("data-expanded", "false");
		await walkthroughPanel(page).getByTestId("pr-walkthrough-rail-toggle").click();
		await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-collapsed-rail"), "rail collapse should remain interactive after YAML submission").toBeVisible();

		await page.evaluate(({ childSessionId, tabId }) => {
			const storageKey = "bobbit-panel-tabs-by-session";
			const bySession = JSON.parse(localStorage.getItem(storageKey) || "{}");
			const tabs = Array.isArray(bySession[childSessionId]) ? bySession[childSessionId] : [];
			bySession[childSessionId] = tabs.map((candidate: any) => candidate?.id === tabId
				? { ...candidate, state: { ...(candidate.state || {}), status: "waiting_for_yaml", cards: undefined } }
				: candidate);
			localStorage.setItem(storageKey, JSON.stringify(bySession));
		}, { childSessionId: waiting.childSessionId, tabId });

		const openStandalone = page.getByTestId("pr-walkthrough-open-in-new-tab").first();
		const [standalone] = await Promise.all([
			context.waitForEvent("page"),
			openStandalone.click(),
		]);
		await standalone.setViewportSize({ width: 1700, height: 1000 });
		await standalone.waitForLoadState("domcontentloaded");
		await expect(standalone.getByTestId("pr-walkthrough-panel-root"), "standalone route should hydrate submitted ready payload instead of stale waiting content").toHaveAttribute("data-walkthrough-status", "ready", { timeout: 15_000 });
		await expect(activeCard(standalone).getByTestId("pr-walkthrough-card-title"), "standalone route should render submitted cards").toContainText(/Separate walkthrough from chat|Changeset-agnostic model/);
		await standalone.close();
	});

	test("invalid YAML submission keeps child panel in validation retry state", async ({ page }) => {
		const waiting = await setupWaitingWalkthrough(page, { width: 1600, height: 900 }, "/walkthrough-pr 790");
		const response = await submitYamlViaPage(page, { sessionId: waiting.childSessionId, jobId: waiting.jobId, yaml: "schema_version: 1\n" });
		expect(response.ok).toBe(true);
		await focusChildWalkthroughSession(page, waiting.childSessionId);
		await publishWalkthroughJobUpdate(page, waiting.childSessionId);
		const root = page.getByTestId("pr-walkthrough-panel-root");
		await expect(root, "invalid YAML should not populate ready cards").toHaveAttribute("data-walkthrough-status", "validation_failed", { timeout: 10_000 });
		await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-validation-failed")).toBeVisible();
		await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-validation-errors")).toContainText(/required|schema|object/i);
		await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-card")).toHaveCount(0);
	});

	test("URL launches expose an external GitHub/PR link in the walkthrough header", async ({ page }) => {
		const { panel } = await setupWalkthrough(page, { width: 1920, height: 1080 }, WALKTHROUGH_URL_COMMAND);

		await expectPrototypeHeader(panel, {
			pr: /#637|PR\s*637/i,
			title: /bobbit|walkthrough|shrink initial bundle/i,
			href: WALKTHROUGH_URL,
		});
	});

	test("Git Status Widget walkthrough metadata opens a child session with PR title and GitHub link", async ({ page }) => {
		await installFixtureWalkthroughPayloadRoute(page, "638", "Widget Launched Walkthrough", "https://github.com/SuuBro/bobbit/pull/638");
		await page.setViewportSize({ width: 1920, height: 1080 });
		await openApp(page);
		await createSessionViaUI(page);
		const parentSessionId = await activeSessionId(page);
		const launchResponse = page.waitForResponse((response) => response.url().includes("/api/pr-walkthrough/launch") && response.request().method() === "POST", { timeout: 20_000 });

		await page.evaluate(() => {
			document.dispatchEvent(new CustomEvent("open-pr-walkthrough", {
				bubbles: true,
				composed: true,
				detail: {
					prNumber: 638,
					prUrl: "https://github.com/SuuBro/bobbit/pull/638",
					prTitle: "Widget Launched Walkthrough",
					baseSha: "fixture-base",
					headSha: "fixture-head",
					insertionsVsPrimary: 17,
					deletionsVsPrimary: 9,
					statusFiles: [{ file: "src/app/pr-walkthrough.ts", status: "M" }, { file: "src/ui/components/pr-walkthrough/fixtures.ts", status: "M" }],
				},
			}));
		});

		const launchResp = await launchResponse;
		const requestBody = JSON.parse(launchResp.request().postData() || "{}") as Record<string, unknown>;
		const launch = await launchResp.json() as WalkthroughLaunchResponse;
		const job = (launch.job && typeof launch.job === "object" ? launch.job : launch) as WalkthroughLaunchResponse;
		await expectChildNestedUnderLauncher(page, parentSessionId, job.childSessionId);
		await expectNoLauncherWalkthroughPanel(page, parentSessionId);
		await focusChildWalkthroughSession(page, job.childSessionId);
		await publishWalkthroughJobUpdate(page, job.childSessionId);
		await expectWalkthroughWaiting(page);
		const { panel } = await submitValidWalkthroughYaml(page, { childSessionId: job.childSessionId, jobId: job.jobId, prNumber: "638", prUrl: "https://github.com/SuuBro/bobbit/pull/638" });
		await expect(page.locator(PANEL_TAB_SELECTOR).first().locator(".goal-tab-pill-label"), "walkthrough tab should use a compact PR label").toHaveText("PR: #638");
		await expectPrototypeHeader(panel, {
			pr: /PR\s*#?638/i,
			title: /Widget Launched Walkthrough/i,
			href: "https://github.com/SuuBro/bobbit/pull/638",
		});
		await expect(page.getByTestId("pr-walkthrough-pr-link"), "GitHub PR link should only appear in the walkthrough header, not the tab strip").toHaveCount(1);
		await expect(panel.getByTestId("pr-walkthrough-stat-files"), "Git Status launches should thread available file counts into walkthrough stats").toContainText(/\d+ files?/);
		await expect(panel.getByTestId("pr-walkthrough-stat-additions"), "Git Status launches should thread additions into walkthrough stats").toContainText(/\+\d+/);
		await expect(panel.getByTestId("pr-walkthrough-stat-deletions"), "Git Status launches should thread deletions into walkthrough stats").toContainText(/-\d+/);
		expect(requestBody.prNumber).toBe("638");
		expect(requestBody.baseSha, "PR walkthroughs should use GitHub's PR diff by default, not locally supplied base refs").toBeUndefined();
		expect(requestBody.headSha, "PR walkthroughs should use GitHub's PR diff by default, not locally supplied head refs").toBeUndefined();
	});

	test("opening another PR creates a separate child walkthrough with fresh per-card UI state", async ({ page }) => {
		const leakedConcern = `should-not-leak-${Date.now()}`;
		const { panel, parentSessionId } = await setupWalkthrough(page, { width: 1920, height: 1080 });
		const firstCard = await activeCardId(page);

		await createCardComment(page, leakedConcern);
		await panel.getByTestId("pr-walkthrough-like").click();
		await expect.poll(() => activeCardId(page), {
			timeout: 5_000,
			message: "first walkthrough should move away from the initial card before opening another PR",
		}).not.toBe(firstCard);

		await page.locator(`[data-session-id="${parentSessionId}"]`).first().click();
		const secondLaunchResponse = page.waitForResponse((response) => response.url().includes("/api/pr-walkthrough/launch") && response.request().method() === "POST", { timeout: 20_000 });
		await sendMessage(page, "/walkthrough-pr 456");
		const secondLaunch = await (await secondLaunchResponse).json() as WalkthroughLaunchResponse;
		const secondJob = (secondLaunch.job && typeof secondLaunch.job === "object" ? secondLaunch.job : secondLaunch) as WalkthroughLaunchResponse;
		await focusChildWalkthroughSession(page, secondJob.childSessionId);
		await publishWalkthroughJobUpdate(page, secondJob.childSessionId);
		await expectWalkthroughWaiting(page);
		await submitValidWalkthroughYaml(page, { childSessionId: secondJob.childSessionId, jobId: secondJob.jobId, prNumber: "456", prUrl: prUrlForNumber("456") });
		const activeTab = page.locator(".goal-preview-panel .goal-tab-pill.goal-tab-pill--active[data-panel-tab-kind='walkthrough']").first();
		await expect(activeTab, "second walkthrough tab should become active").toHaveAttribute("data-panel-tab-id", /^walkthrough:/, { timeout: 10_000 });
		await expect(walkthroughPanel(page).locator(".title"), "second child should render its own changeset metadata").toContainText("PR #456");
		await expect.poll(() => activeCardId(page), {
			timeout: 5_000,
			message: "new walkthrough child without localStorage should start at the first card",
		}).toBe(firstCard);
		await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-comment").filter({ hasText: leakedConcern }), "comments from PR #123 must not leak into PR #456").toBeHidden();
		await expect(walkthroughPanel(page).getByTestId("pr-walkthrough-dislike").first(), "leaked comments must not enable Dislike on the new child").toBeDisabled();
	});

	test("accepts, edits, and deletes suggested line comments when fixture suggestions are present", async ({ page }) => {
		const editedSuggestion = `edited-suggested-comment-${Date.now()}`;
		const { panel } = await setupWalkthrough(page, { width: 1920, height: 1080 });

		const suggestion = panel.getByTestId("pr-walkthrough-suggested-comment").first();
		if (await suggestion.count() === 0) {
			test.skip(true, "fixture data does not include a suggested line comment");
		}

		await expect(suggestion, "fixture suggested comments should render as queued line comment chips/markers").toBeVisible();
		await suggestion.getByTestId("pr-walkthrough-suggested-comment-accept").click();

		const accepted = panel.getByTestId("pr-walkthrough-comment").filter({ hasText: /.+/ }).first();
		await expect(accepted, "accepted suggested comment should become a queued line comment").toBeVisible({ timeout: 5_000 });
		await accepted.getByTestId("pr-walkthrough-comment-edit").click();
		await saveOpenComment(page, editedSuggestion);
		await expect(panel.getByTestId("pr-walkthrough-comment").filter({ hasText: editedSuggestion })).toBeVisible();

		await deleteComment(page, editedSuggestion);
	});

	test("renders cards and stays interactive when a diff hunk header is undefined (hunkSignature regression)", async ({ page }) => {
		// Reproducing test for the panel-fragility defect: a single hunk whose `header`
		// is `undefined` made hunkSignature(header).match(...) throw, which unwound the
		// entire Lit render() and blanked the whole pane. After the fix the malformed
		// hunk degrades locally (empty signature / per-block fallback) and the rest of
		// the card + panel render and stay interactive. MUST FAIL pre-fix.
		const consoleErrors: string[] = [];
		const pageErrors: string[] = [];
		page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
		page.on("pageerror", (err) => pageErrors.push(err.message));

		await setupWalkthrough(page, { width: 1920, height: 1080 });

		// Clone the fixture cards in the TEST file (do NOT edit fixtures.ts) and blank
		// one hunk's header so it arrives at the panel as `header === undefined` — the
		// exact contract violation that crashed hunkSignature(header).match(...).
		const cards = getFixturePrWalkthroughCards();
		const headerlessCard = cards[0];
		headerlessCard.id = "headerless-hunk-card";
		headerlessCard.title = "Header-less hunk regression";
		const targetHunk = headerlessCard.diffBlocks[0].hunks[0] as { header?: string };
		delete targetHunk.header;

		await page.evaluate(async (injectedCards) => {
			const panel = document.querySelector("pr-walkthrough-panel") as any;
			panel.changeset = { baseSha: "base", headSha: "head", provider: "github", title: "Header-less fixture", filesChanged: 1, additions: 1, deletions: 0 };
			panel.cards = injectedCards;
			panel.status = "ready";
			// Pre-fix the synchronous Lit render throws inside this reactive update; swallow
			// the rejection so the test can still assert on the rendered DOM and on the
			// captured console/pageerror signal below.
			try { await panel.updateComplete; } catch { /* surfaced via pageerror */ }
		}, [headerlessCard]);

		const card = activeCard(page);
		await expect(card, "panel must still render a card when one hunk header is undefined").toBeVisible({ timeout: 10_000 });
		await expect(card.getByTestId("pr-walkthrough-card-title")).toContainText("Header-less hunk regression");
		await expect(card.getByTestId("pr-walkthrough-diff-block").first(), "the diff block for the header-less hunk should still render").toBeVisible({ timeout: 10_000 });

		// The pane must stay interactive — diff-mode toggles still respond.
		const chooser = card.getByTestId("pr-walkthrough-diff-mode-chooser");
		if (await chooser.count()) {
			await chooser.getByTestId("diff-mode-inline").click();
			await expectActiveDiffMode(page, "inline");
			await chooser.getByTestId("diff-mode-split").click();
			await expectActiveDiffMode(page, "split");
		}

		const hunkSignatureErrors = [...consoleErrors, ...pageErrors].filter((message) =>
			/Cannot read properties of undefined \(reading 'match'\)/.test(message) || /hunkSignature/.test(message));
		expect(hunkSignatureErrors, `panel must not throw the hunkSignature TypeError: ${hunkSignatureErrors.join("\n")}`).toEqual([]);
	});
});
