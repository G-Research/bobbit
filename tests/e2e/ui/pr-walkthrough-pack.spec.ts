/**
 * Browser E2E — Built-in first-party packs DOGFOOD (design
 * docs/design/built-in-first-party-packs.md §11.2) + the NEW PR-Walkthrough
 * LAUNCH UX (docs/design/pr-walkthrough-launch-ux.md §1–§5, §8). Proves the
 * PR-walkthrough feature is served END-TO-END by the FIRST-PARTY PACK with NO
 * manual install — it is resolved active-by-default by the built-in resolver band —
 * and that its launch surface is now a SPAWN launcher: clicking a launcher calls the
 * pack `run` route and, on `ok:true`, opens the panel in the returned reviewer CHILD
 * session (auto-switch). There is NO owner-session panel, NO `autorun`, and NO manual
 * Run/Load buttons anywhere. The panel renders ONLY inside a reviewer child session,
 * self-driving a read-only `status` poll until the reviewer submits.
 *
 * Harness constraint (§8 R2): the browser harness has no real GitHub PR and
 * `execFile("gh")` resolves the real binary, so a click-driven `run` resolves
 * `NO_PR` and mints no reviewer in-browser. Reviewer-spawn / lifecycle assertions
 * live in the API spec (tests/e2e/pr-walkthrough-host-agents.spec.ts) with an
 * explicit github target. Here we pin the BROWSER-only seams: the NO_PR inline error
 * via the GitStatusWidget (T-2), the bound-child pending state (T-3), and the
 * child-session pane's submit→cards + reload→recover (T-4) — the latter two by
 * SEEDING the pack store directly (the gateway shares the in-process pack-store
 * singleton), since the harness cannot spawn a real reviewer.
 *
 * Coverage:
 *   1. NO INSTALL — the pack is resolved by the built-in band: it appears in
 *      /api/ext/contributions (panel + entrypoints + routes) + the Installed list
 *      flagged `builtin:true`, and contributes the three reviewer tools to /api/tools.
 *   2. TOOL ACTIVATION — the Installed built-in card shows concrete reviewer tool
 *      toggles; disabling one removes only that runtime tool, and re-enabling restores it.
 *   3b. PATH-TRAVERSAL PROBE — a caller-supplied `repoDir` cannot exfiltrate another
 *      repo's diff (the bundle route ignores it and runs in the session worktree).
 *   4. DISABLE/RE-ENABLE — toggling the pack's entrypoints off in the Market
 *      "Built-in" group removes the launcher + the #/ext/pr-walkthrough deep-link
 *      (the deep-link shows the empty state); toggling back on restores the panel
 *      (NEUTRAL state — there is no binding for the owner session); state survives a
 *      reload.
 *   5. NON-REMOVABLE — the built-in source has no Remove control + DELETE → 403; the
 *      built-in pack has no Uninstall control + DELETE /installed → 403.
 *   T-2. NO_PR launch → inline git-widget error, no reviewer child, no view switch.
 *   T-3. Bound reviewer child pane auto-shows pending + spinner, no Run/Load buttons.
 *   T-4. Bound reviewer child pane self-recovers READY cards from binding/<child> on
 *      mount (no click), and a reload re-renders the SAME cards via child-self recover.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test, expect } from "../gateway-harness.js";
import type { Page, Response } from "@playwright/test";
import { apiFetch, waitForSessionStatus, base, readE2ETokenAsync } from "../e2e-setup.js";
import { openApp, createSessionViaUI, sendMessage, navigateToHash } from "./ui-helpers.js";

// Within-file serial: a single end-to-end lifecycle test in describe 1; the
// child-pane describe seeds its own state per test.
test.describe.configure({ mode: "serial" });

const PACK = "pr-walkthrough";
const PANEL_ID = "pr-walkthrough.panel";
// The git-widget SPAWN launcher. Its compound key is `pr-walkthrough\u0000pr-
// walkthrough.git-widget` (packId NUL entrypointId); the test locates the rendered
// button by its visible label "PR Walkthrough" rather than the NUL-bearing attr.
const GIT_WIDGET_LAUNCHER = "pr-walkthrough.git-widget";
// Entrypoint listNames (the basenames of entrypoints/*.yaml) → the activation
// toggle testids in the Market built-in group.
const ENTRYPOINT_LIST_NAMES = [
	"pr-walkthrough-git-widget",
	"pr-walkthrough-open",
	"pr-walkthrough-palette",
	"pr-walkthrough-route",
];
const PRW_TOOL_NAMES = [
	"readonly_bash",
	"read_pr_walkthrough_bundle",
	"submit_pr_walkthrough_yaml",
] as const;
const TOGGLED_TOOL = "readonly_bash";

const SYNC_FILE = "src/sync/worker.ts";
const PR_TITLE = "Add retry/backoff to the sync worker";

let repoDir: string | undefined;
let baseSha = "";
let headSha = "";

let outsideRepoDir: string | undefined;
let outsideBaseSha = "";
let outsideHeadSha = "";
const OUTSIDE_SECRET_FILE = "secret/other-repo-only.ts";
const OUTSIDE_SECRET_MARKER = "TOP_SECRET_OTHER_REPO";

function gitIn(dir: string, args: string[]): string {
	return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function gitConfig(dir: string): void {
	gitIn(dir, ["config", "user.email", "bobbit-ai@bobbit.ai"]);
	gitIn(dir, ["config", "user.name", "bobbit-ai"]);
	gitIn(dir, ["config", "commit.gpgsign", "false"]);
}

function setupSessionGitRepo(dir: string): void {
	repoDir = dir;
	if (!fs.existsSync(path.join(dir, ".git"))) gitIn(dir, ["init", "-q"]);
	gitConfig(dir);
	const file = path.join(dir, SYNC_FILE);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "export class SyncWorker {\n  async runOnce() {\n    return this.fetchBatch();\n  }\n}\n");
	gitIn(dir, ["add", "--", SYNC_FILE]);
	gitIn(dir, ["commit", "-q", "-m", "base"]);
	baseSha = gitIn(dir, ["rev-parse", "HEAD"]);
	fs.writeFileSync(file, "export class SyncWorker {\n  async runOnce() {\n    return this.withRetry(() => this.fetchBatch());\n  }\n}\n");
	gitIn(dir, ["add", "--", SYNC_FILE]);
	gitIn(dir, ["commit", "-q", "-m", "head: retry/backoff"]);
	headSha = gitIn(dir, ["rev-parse", "HEAD"]);
}

function setupOutsideRepo(): void {
	outsideRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "prw-other-repo-"));
	gitIn(outsideRepoDir, ["init", "-q"]);
	gitConfig(outsideRepoDir);
	const file = path.join(outsideRepoDir, OUTSIDE_SECRET_FILE);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `export const token = "${OUTSIDE_SECRET_MARKER}";\n`);
	gitIn(outsideRepoDir, ["add", "."]);
	gitIn(outsideRepoDir, ["commit", "-q", "-m", "other-base"]);
	outsideBaseSha = gitIn(outsideRepoDir, ["rev-parse", "HEAD"]);
	fs.writeFileSync(file, `export const token = "${OUTSIDE_SECRET_MARKER}";\nexport const extra = 1;\n`);
	gitIn(outsideRepoDir, ["add", "."]);
	gitIn(outsideRepoDir, ["commit", "-q", "-m", "other-head"]);
	outsideHeadSha = gitIn(outsideRepoDir, ["rev-parse", "HEAD"]);
}

const HUNK_HEADER = "@@ -2,3 +2,3 @@ export class SyncWorker {";

/** The RAW production walkthrough YAML the reviewer's submit_pr_walkthrough_yaml
 *  would emit (the rich `pr` + `walkthrough.{…}` schema). The pack's publish route
 *  validates + maps it (against the LIVE git diff) into PrWalkthroughCard[] via the
 *  SAME synthesis the deleted built-in ran. YAML is a superset of JSON, so the
 *  pack/route `yaml` parser reads this. The `pr.base_sha`/`pr.head_sha` carry the
 *  REAL session-worktree SHAs — call AFTER setupSessionGitRepo so the module-level
 *  SHAs are populated. Used only by T-4 (the seeded child-pane recover). */
function submitYaml(): string {
	const doc = {
		schema_version: 1,
		pr: {
			provider: "github",
			owner: "SuuBro",
			repo: "bobbit",
			number: 4242,
			title: PR_TITLE,
			url: "https://github.com/SuuBro/bobbit/pull/4242",
			base_sha: baseSha,
			head_sha: headSha,
			original_description: { body: "## Why\nTransient network failures dropped sync jobs.", source: "gh_api", fetched_at: "2026-01-01T00:00:00Z" },
			stats: { files_changed: 1, additions: 1, deletions: 1 },
		},
		walkthrough: {
			context: {
				why_created: "Transient network failures aborted the whole sync pass.",
				problem_solved: "Adds bounded exponential backoff so failures self-heal.",
				why_worth_merging: "It makes the sync worker resilient with no API change.",
				merge_concerns: "Watch for thundering-herd retries without jitter.",
				author_intent: "Make sync robust to flaky networks.",
				reviewer_map: `core: ${SYNC_FILE} — the retry wrapper`,
			},
			merge_assessment: {
				recommendation: "comment",
				confidence: "medium",
				summary: "Sound change; consider jitter before merge.",
				blocking_concerns: [],
				non_blocking_concerns: ["Add jitter to avoid synchronized retries."],
			},
			design_decisions: [
				{
					id: "backoff-strategy",
					title: "Bounded exponential backoff",
					explanation: "Wrap the fetch in a capped retry loop.",
					chosen_approach: "Exponential delay capped at a ceiling.",
					alternatives_considered: [{ option: "Fixed delay", pros: ["simple"], cons: ["slow recovery"] }],
					tradeoffs: ["More latency on persistent failure."],
					suggested_reviewer_concerns: ["Confirm the cap is sensible."],
					relevant_hunks: [{ file: SYNC_FILE, hunk_header: HUNK_HEADER, why_relevant: "introduces the retry wrapper" }],
				},
			],
			review_chunks: [
				{
					id: "sync-worker",
					phase: "significant",
					title: "Retry/backoff in the sync worker",
					reviewer_goal: "Verify the retry wrapper is correct.",
					explanation: "Wrap the fetch in a retry loop with capped exponential delay.",
					files: [SYNC_FILE],
					relevant_hunks: [{ file: SYNC_FILE, hunk_header: HUNK_HEADER, line_range: "3", why_relevant: "the retry call" }],
					suggested_concerns: [
						{
							severity: "non_blocking",
							concern: "No jitter on retries.",
							suggested_comment: "Consider adding jitter to avoid thundering-herd retries.",
							anchors: [{ file: SYNC_FILE, hunk_header: HUNK_HEADER, line: 3 }],
						},
					],
					positive_notes: ["Clear, minimal change."],
				},
			],
			omissions_and_followups: [
				{ category: "tests", expected_artifact: "Unit test for the backoff schedule.", evidence_checked: "No new test file in the diff.", concern: "Backoff timing is untested.", suggested_comment: "Add a unit test for the delay schedule.", severity: "non_blocking" },
			],
			audit: {
				remaining_changed_areas: [SYNC_FILE],
				low_signal_or_mechanical_changes: [],
				generated_or_binary_files: [],
				reviewer_checklist: ["Confirm the retry cap.", "Confirm no behavioral regression."],
			},
			display: {
				phase_order: ["orientation", "design", "significant", "other", "audit"],
				chunk_order: ["sync-worker"],
			},
		},
	};
	return JSON.stringify(doc);
}

async function listToolNames(): Promise<Array<{ name: string }>> {
	const res = await apiFetch("/api/tools");
	expect(res.ok).toBe(true);
	return (await res.json()).tools as Array<{ name: string }>;
}

interface PackContributionsMeta {
	packId: string;
	packName: string;
	panels: { id: string; title?: string }[];
	entrypoints: Array<{ id: string; kind: string; routeId?: string; listName: string }>;
	routeNames: string[];
}

async function listContributions(): Promise<PackContributionsMeta[]> {
	const res = await apiFetch("/api/ext/contributions");
	expect(res.ok).toBe(true);
	return (await res.json()).packs as PackContributionsMeta[];
}

interface RecoverRouteResult {
	status: number;
	body: any;
	text: string;
}

function isRecoverRouteResponse(response: Response): boolean {
	return /\/api\/ext\/route\/recover\b/.test(response.url()) && response.request().method() === "POST";
}

async function readRecoverRouteResult(response: Response): Promise<RecoverRouteResult> {
	const text = await response.text().catch(() => "");
	let body: any = {};
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		body = {};
	}
	return { status: response.status(), body, text };
}

function createRecoverRouteProbe(page: Page) {
	const responses: Array<Promise<RecoverRouteResult>> = [];
	page.on("response", (response) => {
		if (isRecoverRouteResponse(response)) responses.push(readRecoverRouteResult(response));
	});
	return {
		mark: () => responses.length,
		async waitAfter(mark: number, timeout = 20_000): Promise<RecoverRouteResult> {
			if (responses.length > mark) return responses[mark];
			const response = await page.waitForResponse(isRecoverRouteResponse, { timeout });
			return readRecoverRouteResult(response);
		},
	};
}

async function listInstalled(): Promise<Array<{ packName: string; scope: string; builtin?: boolean }>> {
	const res = await apiFetch("/api/marketplace/installed");
	expect(res.ok).toBe(true);
	return (await res.json()).installed as Array<{ packName: string; scope: string; builtin?: boolean }>;
}

async function resetPrWalkthroughActivation(): Promise<void> {
	await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK, disabled: { roles: [], tools: [], skills: [], entrypoints: [] } }),
	});
}

async function expectRuntimePrwTools(enabled: readonly string[], disabled: readonly string[] = []): Promise<void> {
	const expected = new Map(PRW_TOOL_NAMES.map((name) => [name, enabled.includes(name)]));
	for (const name of disabled) expected.set(name, false);
	await expect.poll(async () => {
		const names = new Set((await listToolNames()).map((t) => t.name));
		return PRW_TOOL_NAMES.map((name) => `${name}:${names.has(name) ? "on" : "off"}`).join(",");
	}, { timeout: 10_000 }).toBe(PRW_TOOL_NAMES.map((name) => `${name}:${expected.get(name) ? "on" : "off"}`).join(","));
}

/** Mint a server-minted pack-bound surface token for the pack's PANEL (no carrier
 *  tool). Used only by the path-traversal probe below. */
async function mintSurfaceToken(sid: string): Promise<string> {
	const res = await apiFetch("/api/ext/surface-token", {
		method: "POST",
		headers: { "x-bobbit-session-id": sid },
		body: JSON.stringify({ sessionId: sid, packId: PACK, contributionKind: "panel", contributionId: PANEL_ID }),
	});
	const body = await res.text();
	expect(res.status, `surface-token mint failed: ${body}`).toBe(200);
	return JSON.parse(body).token as string;
}

async function callBundleRoute(sid: string, query: Record<string, string>): Promise<{ status: number; text: string }> {
	const surfaceToken = await mintSurfaceToken(sid);
	const res = await apiFetch("/api/ext/route/bundle", {
		method: "POST",
		headers: { "x-bobbit-session-id": sid },
		body: JSON.stringify({ sessionId: sid, surfaceToken, init: { query } }),
	});
	return { status: res.status, text: await res.text() };
}

function liveDeepLink(): string {
	// No jobId — the launchers dropped it; baseSha/headSha would drive a LIVE
	// recompute. Used here only to navigate the (now-disabled) deep-link.
	const params = new URLSearchParams({ baseSha, headSha });
	return `#/ext/${PACK}?${params.toString()}`;
}

test.beforeEach(async () => {
	// Server-scope activation persists between E2E runs; start every test from the
	// shipped all-enabled state so failures do not cascade.
	await resetPrWalkthroughActivation().catch(() => {});
});

test.afterEach(async () => {
	// Best-effort: re-enable all toggles so a failed run never leaves the shipped
	// feature partially disabled for the next test.
	await resetPrWalkthroughActivation().catch(() => {});
	repoDir = undefined;
	if (outsideRepoDir) {
		try { fs.rmSync(outsideRepoDir, { recursive: true, force: true }); } catch { /* ignore */ }
		outsideRepoDir = undefined;
	}
});

test.describe("Built-in first-party pack — pr-walkthrough served by the built-in band", () => {
	test("no-install dogfood: built-in resolution → path-traversal probe → disable/re-enable → non-removable", async ({ page, gateway }) => {
		setupOutsideRepo();

		// ── Step 1: NO INSTALL. The built-in band resolves the pack active-by-default. ──
		await expectRuntimePrwTools(PRW_TOOL_NAMES);
		const packMeta = (await listContributions()).find((p) => p.packId === PACK);
		expect(packMeta, "the built-in pr-walkthrough pack must be resolved with NO install").toBeTruthy();
		expect(packMeta?.panels?.some((p) => p.id === PANEL_ID)).toBe(true);
		expect(packMeta?.routeNames).toEqual(expect.arrayContaining(["bundle", "publish"]));
		expect(packMeta?.entrypoints?.some((e) => e.id === GIT_WIDGET_LAUNCHER)).toBe(true);
		const builtinRow = (await listInstalled()).find((p) => p.packName === PACK && p.builtin);
		expect(builtinRow, "the built-in pack must appear in the Installed list flagged builtin").toBeTruthy();
		expect(builtinRow?.scope).toBe("server");

		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "hello");
		const sid = await page.evaluate(() => (window as any).__bobbitState?.selectedSessionId as string | null);
		expect(sid, "a session must be selected").toBeTruthy();
		await waitForSessionStatus(sid!, "idle").catch(() => { /* best-effort */ });

		// Initialise the SESSION WORKTREE as a git repo (the bundle route diffs against
		// the worker's server-derived process.cwd(), never a caller path).
		const ps = gateway.sessionManager?.getPersistedSession(sid!) as { cwd?: string; worktreePath?: string } | undefined;
		const sessionWorktree = ps?.worktreePath ?? ps?.cwd;
		expect(sessionWorktree, "the session must have a resolvable working dir").toBeTruthy();
		setupSessionGitRepo(sessionWorktree!);

		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers());

		// ── Step 3b: PATH-TRAVERSAL PROBE — a caller-supplied repoDir cannot exfiltrate
		// another repo's diff (the route ignores it; the outside SHAs fail closed). ──
		const attack = await callBundleRoute(sid!, { baseSha: outsideBaseSha, headSha: outsideHeadSha, repoDir: outsideRepoDir! });
		expect(attack.text, "the other repo's secret must NEVER leak through repoDir").not.toContain(OUTSIDE_SECRET_MARKER);
		expect(attack.text).not.toContain(OUTSIDE_SECRET_FILE);
		expect(attack.status, `repoDir traversal must NOT return other-repo data (got ${attack.status})`).not.toBe(200);

		const token = await readE2ETokenAsync();

		// ── Step 4: DISABLE via the Market built-in group → launcher + deep-link gone. ──
		await navigateToHash(page, "#/market");
		const builtinGroup = page.locator('[data-testid="market-builtin-group"]');
		await expect(builtinGroup, "the Market Installed tab must show a Built-in group").toBeVisible({ timeout: 15_000 });
		const prwCard = builtinGroup.locator('[data-testid="market-installed-pack"][data-builtin="true"][data-pack-name="pr-walkthrough"]').first();
		await expect(prwCard, "the built-in PR walkthrough card must render").toBeVisible({ timeout: 15_000 });

		// The activation catalogue expands the pack's tool group to concrete tool names.
		for (const toolName of PRW_TOOL_NAMES) {
			const toggle = prwCard.locator(`[data-testid="market-toggle-tool-${toolName}"]`);
			await expect(toggle, `tool toggle ${toolName} must render`).toBeVisible({ timeout: 15_000 });
			await expect(toggle, `tool toggle ${toolName} starts enabled`).toBeChecked();
			await expect(toggle.locator("xpath=ancestor::label").getByText(toolName, { exact: true }), `tool label ${toolName} must render`).toBeVisible();
		}

		// Disabling one concrete tool removes exactly that runtime tool; siblings and
		// pack-bound panel/routes/entrypoints remain active. Re-enable restores it.
		const toolToggle = prwCard.locator(`[data-testid="market-toggle-tool-${TOGGLED_TOOL}"]`);
		let put = page.waitForResponse((r) => r.url().includes("/api/marketplace/pack-activation") && r.request().method() === "PUT");
		await toolToggle.click();
		await put;
		await expect(toolToggle, `${TOGGLED_TOOL} toggle turns off`).not.toBeChecked();
		await expectRuntimePrwTools(PRW_TOOL_NAMES.filter((name) => name !== TOGGLED_TOOL), [TOGGLED_TOOL]);
		for (const sibling of PRW_TOOL_NAMES.filter((name) => name !== TOGGLED_TOOL)) {
			await expect(prwCard.locator(`[data-testid="market-toggle-tool-${sibling}"]`), `sibling tool ${sibling} stays enabled`).toBeChecked();
		}
		const metaAfterToolDisable = (await listContributions()).find((p) => p.packId === PACK);
		expect(metaAfterToolDisable?.panels?.some((p) => p.id === PANEL_ID), "tool disable must not remove the pack panel").toBe(true);
		expect(metaAfterToolDisable?.routeNames, "tool disable must not remove pack routes").toEqual(expect.arrayContaining(["bundle", "publish"]));
		expect(metaAfterToolDisable?.entrypoints?.some((e) => e.id === GIT_WIDGET_LAUNCHER), "tool disable must not remove entrypoints").toBe(true);

		put = page.waitForResponse((r) => r.url().includes("/api/marketplace/pack-activation") && r.request().method() === "PUT");
		await toolToggle.click();
		await put;
		await expect(toolToggle, `${TOGGLED_TOOL} toggle turns back on`).toBeChecked();
		await expectRuntimePrwTools(PRW_TOOL_NAMES);

		const gitWidgetToggle = prwCard.locator('[data-testid="market-toggle-entrypoint-pr-walkthrough-git-widget"]');
		await expect(gitWidgetToggle, "the built-in pack's entrypoint toggles must render").toBeVisible({ timeout: 15_000 });
		for (const kind of ["Git widget", "Slash", "Command palette", "Route"]) {
			await expect(prwCard.getByText(kind, { exact: true }), `entrypoint kind ${kind} must be visible`).toBeVisible();
		}
		for (const listName of ENTRYPOINT_LIST_NAMES) {
			const toggle = prwCard.locator(`[data-testid="market-toggle-entrypoint-${listName}"]`);
			if (await toggle.isChecked()) {
				put = page.waitForResponse((r) => r.url().includes("/api/marketplace/pack-activation") && r.request().method() === "PUT");
				await toggle.click();
				await put;
			}
		}

		// The deep-link no longer resolves to a registered route → "feature
		// unavailable" empty state (no panel, no crash, no blank — §7.3).
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers()).catch(() => {});
		await page.evaluate((h) => { window.location.hash = h; }, liveDeepLink());
		await expect.poll(async () => {
			await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers()).catch(() => {});
			return page.locator('[data-testid="prw-panel-root"]').count();
		}, { timeout: 15_000 }).toBe(0);
		// The disabled deep-link surfaces the dismissible empty state instead of nothing.
		const unavailable = page.locator('[data-testid="ext-route-unavailable"]');
		await expect(unavailable).toBeVisible({ timeout: 10_000 });
		await expect(unavailable).toContainText("unavailable");
		await page.locator('[data-testid="ext-route-unavailable-dismiss"]').click();
		await expect(unavailable).toHaveCount(0);
		// The entrypoints are dropped from the contribution registry.
		await expect.poll(async () => {
			const meta = (await listContributions()).find((p) => p.packId === PACK);
			return meta?.entrypoints?.length ?? 0;
		}, { timeout: 10_000 }).toBe(0);
		const metaAfterEntrypointDisable = (await listContributions()).find((p) => p.packId === PACK);
		expect(metaAfterEntrypointDisable?.panels?.some((p) => p.id === PANEL_ID), "entrypoint disable must not remove the pack panel").toBe(true);
		expect(metaAfterEntrypointDisable?.routeNames, "entrypoint disable must not remove pack routes").toEqual(expect.arrayContaining(["bundle", "publish"]));
		await expectRuntimePrwTools(PRW_TOOL_NAMES);

		// Disabled state survives a reload: the server-scope activation override is
		// persisted, so after a full reload the Market toggle is still OFF and the
		// entrypoints stay absent from /api/ext/contributions.
		await page.goto(`${base()}/?token=${encodeURIComponent(token)}#/market`);
		const group2 = page.locator('[data-testid="market-builtin-group"]');
		await expect(group2).toBeVisible({ timeout: 20_000 });
		const prwCard2 = group2.locator('[data-testid="market-installed-pack"][data-builtin="true"][data-pack-name="pr-walkthrough"]').first();
		await expect(prwCard2).toBeVisible({ timeout: 15_000 });
		const gitToggleAfterReload = prwCard2.locator('[data-testid="market-toggle-entrypoint-pr-walkthrough-git-widget"]');
		await expect(gitToggleAfterReload).toBeVisible({ timeout: 15_000 });
		await expect(gitToggleAfterReload, "disable must survive reload (toggle stays off)").not.toBeChecked();
		for (const toolName of PRW_TOOL_NAMES) {
			await expect(prwCard2.locator(`[data-testid="market-toggle-tool-${toolName}"]`), `tool ${toolName} remains enabled after entrypoint reload`).toBeChecked();
		}
		await expect.poll(async () => {
			const meta = (await listContributions()).find((p) => p.packId === PACK);
			return meta?.entrypoints?.length ?? 0;
		}, { timeout: 10_000 }).toBe(0);

		// ── Re-enable → the launcher + deep-link are restored. ──
		for (const listName of ENTRYPOINT_LIST_NAMES) {
			const toggle = prwCard2.locator(`[data-testid="market-toggle-entrypoint-${listName}"]`);
			await expect(toggle).toBeVisible({ timeout: 10_000 });
			if (!(await toggle.isChecked())) {
				const put = page.waitForResponse((r) => r.url().includes("/api/marketplace/pack-activation") && r.request().method() === "PUT");
				await toggle.click();
				await put;
			}
		}
		await expectRuntimePrwTools(PRW_TOOL_NAMES);
		await expect.poll(async () => {
			const meta = (await listContributions()).find((p) => p.packId === PACK);
			return meta?.entrypoints?.some((e) => e.id === GIT_WIDGET_LAUNCHER) ? "ok" : "no";
		}, { timeout: 10_000 }).toBe("ok");
		// The deep-link resolves again from a CLEAN context (re-open the session, then
		// navigate the bare deep-link → the panel mounts via the re-registered route).
		// With NO binding for the owner session the panel renders the NEUTRAL state —
		// prw-panel-root is visible; we do NOT assert cards.
		await page.goto(`${base()}/?token=${encodeURIComponent(token)}#/session/${sid}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers()).catch(() => {});
		await page.evaluate((h) => { window.location.hash = h; }, `#/ext/${PACK}`);
		await expect(page.locator('[data-testid="prw-panel-root"]').first()).toBeVisible({ timeout: 15_000 });
		await expect(page.locator('[data-testid="prw-neutral"]').first()).toBeVisible({ timeout: 10_000 });

		// ── Step 5: NON-REMOVABLE — built-in source + pack cannot be removed/uninstalled. ──
		// Built-in pack card has no Uninstall control.
		await navigateToHash(page, "#/market");
		const builtinCard = page.locator('[data-testid="market-installed-pack"][data-builtin="true"]').filter({ hasText: PACK }).first();
		await expect(builtinCard).toBeVisible({ timeout: 15_000 });
		await expect(builtinCard.locator('[data-testid="market-uninstall-pack"]')).toHaveCount(0);
		// Built-in source row has no Remove control.
		await page.locator('[data-testid="market-tab-sources"]').click();
		const builtinSource = page.locator('[data-testid="market-source-row"][data-builtin="true"]').first();
		await expect(builtinSource).toBeVisible({ timeout: 15_000 });
		await expect(builtinSource.locator('[data-testid="market-remove-source"]')).toHaveCount(0);
		// The server rejects both mutations.
		const delSource = await apiFetch("/api/marketplace/sources/builtin", { method: "DELETE" });
		expect(delSource.status, "the built-in source must not be removable").toBe(403);
		const delPack = await apiFetch("/api/marketplace/installed", {
			method: "DELETE",
			body: JSON.stringify({ scope: "server", packName: PACK }),
		});
		expect(delPack.status, "the built-in pack must not be uninstallable").toBe(403);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// NEW launch UX — the browser-only acceptance rows (design §8: T-2/T-3/T-4)
// ────────────────────────────────────────────────────────────────────────────
// The launch surface is now a SPAWN launcher: a click calls the pack `run` route
// and, on ok:true, opens the panel in the returned reviewer child session. The
// harness has no real `gh` PR, so a click-driven `run` resolves NO_PR and mints no
// reviewer — pinned here as the inline-error path (T-2). The child-session pane's
// pending state (T-3) and submit→cards + reload→recover (T-4) are pinned by SEEDING
// the binding/<self> (+ submitted/<jobId>) the run flow would have written, then
// driving the panel as the bound (child) session. Reviewer-spawn + lifecycle
// assertions live in the API spec (tests/e2e/pr-walkthrough-host-agents.spec.ts).
test.describe("PR walkthrough — launch UX (NO_PR error + child-session pane)", () => {
	/** Open the app, create + select a session, reconcile pack renderers. Returns sid. */
	async function freshSessionWithPanel(page: import("@playwright/test").Page): Promise<string> {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "hello");
		const sid = await page.evaluate(() => (window as any).__bobbitState?.selectedSessionId as string | null);
		expect(sid, "a session must be selected").toBeTruthy();
		await waitForSessionStatus(sid!, "idle").catch(() => { /* best-effort */ });
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers());
		return sid!;
	}

	// ── T-1: the composer slash command is `/pr-walkthrough` (not the internal
	//    launcher filename/id suffix). Autocomplete completes the token only; the
	//    completed slash command invokes the same run route on send. ──
	test("T-1 — slash launcher is /pr-walkthrough and invokes run", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers());

		const textarea = page.locator("textarea").first();
		await textarea.fill("/pr-walkthrough");
		const command = page.getByTestId("slash-command-pr-walkthrough");
		await expect(command, "slash autocomplete must expose /pr-walkthrough").toBeVisible({ timeout: 10_000 });
		await expect(page.getByTestId("slash-command-pr-walkthrough.open"), "the old .open-suffixed command must not render").toHaveCount(0);

		await textarea.press("Enter");
		await expect(textarea, "selecting autocomplete should complete the command so args can be typed").toHaveValue("/pr-walkthrough ");

		const runResp = page.waitForResponse(
			(r) => /\/api\/ext\/route\/run\b/.test(r.url()) && r.request().method() === "POST",
			{ timeout: 20_000 },
		);
		await textarea.press("Enter");
		const resp = await runResp;
		expect(resp.status(), `run route failed: ${await resp.text().catch(() => "")}`).toBe(200);
		await expect(textarea, "sending the completed slash command should consume the composer value").toHaveValue("");
		await expect(page.getByTestId("header-toast")).toContainText(/No open GitHub PR/i, { timeout: 10_000 });
	});

	// ── T-2: a NO_PR launch surfaces an INLINE error in the GitStatusWidget dropdown,
	//    spawns NO reviewer child, and does NOT switch the view. ──
	test("T-2 — NO_PR launch shows an inline git-widget error, spawns no reviewer, no view switch", async ({ page, gateway }) => {
		await openApp(page);
		await createSessionViaUI(page);
		// The session is selected on creation; resolve its id BEFORE the first message
		// so the worktree can be made a git repo before the idle git-status refresh.
		let sid: string | null = null;
		await expect.poll(async () => {
			sid = await page.evaluate(() => (window as any).__bobbitState?.selectedSessionId as string | null);
			return sid;
		}, { timeout: 15_000 }).toBeTruthy();
		expect(sid).toBeTruthy();

		// The git-widget pill renders only when the session worktree is a git repo;
		// make it one so the launcher is reachable. (A bare-body `run` resolves NO_PR
		// regardless — the repo is here only to surface the pill.)
		const ps = gateway.sessionManager?.getPersistedSession(sid!) as { cwd?: string; worktreePath?: string } | undefined;
		const sessionWorktree = ps?.worktreePath ?? ps?.cwd;
		expect(sessionWorktree, "the session must have a resolvable working dir").toBeTruthy();
		setupSessionGitRepo(sessionWorktree!);

		// A message → working→idle transition re-runs the (unconditional) git-status
		// refresh, which now sees the repo and renders the pill.
		await sendMessage(page, "hello");
		await waitForSessionStatus(sid!, "idle").catch(() => { /* best-effort */ });
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers());

		const runPosts: string[] = [];
		page.on("request", (r) => {
			if (r.method() === "POST" && /\/api\/ext\/route\/run\b/.test(r.url())) runPosts.push(r.url());
		});

		// Open the git-widget dropdown (portaled under document.body).
		const pill = page.locator(".git-status-pill").first();
		await expect(pill, "the git-status pill must render once the worktree is a repo").toBeVisible({ timeout: 20_000 });
		await pill.click();

		// The launcher button's data-entrypoint-id is a NUL-bearing compound key, so
		// locate it by its visible label instead of a CSS attribute selector.
		const launcher = page.locator('[data-testid="git-widget-launcher"]', { hasText: "PR Walkthrough" }).first();
		await expect(launcher, "the PR Walkthrough launcher must render in the dropdown").toBeVisible({ timeout: 10_000 });

		const runResp = page.waitForResponse(
			(r) => /\/api\/ext\/route\/run\b/.test(r.url()) && r.request().method() === "POST",
			{ timeout: 20_000 },
		);
		await launcher.click();
		const resp = await runResp;
		expect(resp.status(), `run route failed: ${await resp.text().catch(() => "")}`).toBe(200);

		// The structured NO_PR error renders inline beneath the launcher button.
		const err = page.locator('[data-testid="git-widget-launcher-error"]').first();
		await expect(err).toBeVisible({ timeout: 10_000 });
		await expect(err).toContainText(/No open GitHub PR/i);
		// The dropdown stays OPEN (the launcher button is still visible).
		await expect(launcher).toBeVisible();
		// `run` fired exactly once.
		expect(runPosts, "the launcher must call `run` exactly once").toHaveLength(1);

		// No reviewer child was minted (NO_PR returns before any spawn).
		const reviewerSpawned = (gateway.sessionManager?.getAllSessionsRaw?.() ?? []).some((s: any) => {
			const cps = gateway.sessionManager?.getPersistedSession?.(s.id);
			return cps?.parentSessionId === sid && cps?.childKind === "host-agents";
		});
		expect(reviewerSpawned, "a NO_PR launch must not mint a reviewer child").toBe(false);

		// The view did NOT switch — the same session is still selected.
		const sidAfter = await page.evaluate(() => (window as any).__bobbitState?.selectedSessionId as string | null);
		expect(sidAfter, "a NO_PR launch must not switch the view").toBe(sid);
	});

	// ── T-3: a BOUND reviewer child pane auto-shows the pending state on mount —
	//    "PR Walkthrough: In Progress" + spinner — with NO Run/Load buttons. ──
	test("T-3 — bound child pane auto-shows pending + spinner, no Run/Load buttons", async ({ page }) => {
		const sid = await freshSessionWithPanel(page);

		// Seed ONLY a child binding (jobId set, NO submitted/<jobId>): the pane is a
		// bound reviewer child still producing the walkthrough. No git repo needed —
		// the pending state does not recompute; the status poll returns running.
		const { getPackStore } = await import("../../../dist/server/extension-host/pack-store.js");
		const pendingJobId = "prw-t3-pending";
		await getPackStore().put(PACK, `binding/${sid}`, {
			jobId: pendingJobId,
			parentSessionId: "prw-t3-owner-session",
			status: "running",
			target: {
				provider: "github", owner: "SuuBro", repo: "bobbit", number: 4242, host: "github.com",
				canonicalKey: "github:SuuBro/bobbit#4242",
			},
		});

		await page.evaluate((h) => { window.location.hash = h; }, `#/ext/${PACK}`);
		await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 }).toBe(`#/ext/${PACK}`);
		await expect(page.locator('[data-testid="prw-panel-root"]').first()).toBeVisible({ timeout: 20_000 });

		// Pending: exact copy "PR Walkthrough: In Progress" + the spinner.
		const pending = page.locator('[data-testid="prw-pending"]').first();
		await expect(pending).toBeVisible({ timeout: 15_000 });
		await expect(pending).toContainText("PR Walkthrough: In Progress");
		await expect(page.locator('[data-testid="prw-spinner"]').first()).toBeVisible();
		// The manual Run/Load buttons are GONE.
		await expect(page.locator('[data-testid="prw-run"]')).toHaveCount(0);
		await expect(page.locator('[data-testid="prw-load"]')).toHaveCount(0);
		// The pane stays pending (the status poll keeps returning running).
		await expect(pending).toBeVisible();
	});

	async function seedReadyWalkthrough(page: import("@playwright/test").Page, gateway: any, jobId: string): Promise<string> {
		const sid = await freshSessionWithPanel(page);
		const ps = gateway.sessionManager?.getPersistedSession(sid) as { cwd?: string; worktreePath?: string } | undefined;
		const sessionWorktree = ps?.worktreePath ?? ps?.cwd;
		expect(sessionWorktree, "the bound session must have a resolvable working dir").toBeTruthy();
		setupSessionGitRepo(sessionWorktree!);

		const { getPackStore } = await import("../../../dist/server/extension-host/pack-store.js");
		await getPackStore().put(PACK, `submitted/${jobId}`, { yaml: submitYaml(), baseSha, headSha, submittedAt: Date.now() });
		await getPackStore().put(PACK, `binding/${sid}`, {
			jobId,
			parentSessionId: `${jobId}-owner-session`,
			baseSha, headSha,
			status: "submitted",
			target: {
				provider: "github", owner: "SuuBro", repo: "bobbit", number: 4242, host: "github.com",
				prUrl: "https://github.com/SuuBro/bobbit/pull/4242", baseSha, headSha,
				canonicalKey: "github:SuuBro/bobbit#4242",
			},
		});
		return sid;
	}

	async function openRecoveredReadyWalkthrough(
		page: Page,
		jobId: string,
		recoverProbe = createRecoverRouteProbe(page),
		recoverMark = recoverProbe.mark(),
	): Promise<string | undefined> {
		await page.evaluate((h) => { window.location.hash = h; }, `#/ext/${PACK}`);
		await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 }).toBe(`#/ext/${PACK}`);
		await expect(page.locator('[data-testid="prw-panel-root"]').first()).toBeVisible({ timeout: 20_000 });
		const recovered = await recoverProbe.waitAfter(recoverMark);
		expect(recovered.status, `recover callRoute failed: ${recovered.text}`).toBe(200);
		expect(recovered.body.found, "the child pane must self-resolve binding/<child> → submitted YAML").toBe(true);
		expect(recovered.body.jobId).toBe(jobId);
		await expect(page.locator('[data-testid="prw-load"]')).toHaveCount(0);
		await expect(page.locator('[data-testid="prw-navrail"], [aria-label="PR walkthrough phase rail"]').first()).toBeVisible({ timeout: 10_000 });
		await expect(page.locator('[data-testid="prw-title"]').first()).toContainText(PR_TITLE, { timeout: 10_000 });
		await expect(page.locator('[data-testid="prw-nav-card"][data-prw-nav="orientation-summary"], [data-testid="pr-walkthrough-orientation-rail"]').first()).toBeVisible();
		return (await page.locator('[data-testid="prw-persisted-at"]').first().textContent())?.trim();
	}

	async function assertLabelledRailRowsDoNotOverlap(page: import("@playwright/test").Page, label: string): Promise<void> {
		const violations = await page.evaluate(() => {
			const rail = document.querySelector('[data-testid="pr-walkthrough-labelled-rail"]');
			const isVisible = (element: Element | null): element is HTMLElement => {
				if (!(element instanceof HTMLElement)) return false;
				const style = getComputedStyle(element);
				const rect = element.getBoundingClientRect();
				return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
			};
			const problems: string[] = [];
			if (!rail || !isVisible(rail)) return ["labelled rail is not visible"];
			for (const row of Array.from(rail.querySelectorAll('[data-testid="pr-walkthrough-phase-button"]'))) {
				if (!isVisible(row)) continue;
				const name = row.querySelector(".phase-name");
				const count = row.querySelector(".phase-count");
				if (!isVisible(name) || !isVisible(count)) continue;
				const rowBox = row.getBoundingClientRect();
				const nameBox = name.getBoundingClientRect();
				const countBox = count.getBoundingClientRect();
				const title = (name.textContent || "phase").trim();
				if (nameBox.right > countBox.left - 2) problems.push(`${title}: phase name overlaps count (${nameBox.right.toFixed(1)} > ${countBox.left.toFixed(1)} - 2)`);
				if (nameBox.left < rowBox.left - 0.5) problems.push(`${title}: phase name starts outside row`);
				if (countBox.right > rowBox.right + 0.5) problems.push(`${title}: phase count ends outside row`);
			}
			for (const row of Array.from(rail.querySelectorAll(".card-button"))) {
				if (!isVisible(row)) continue;
				const dot = row.querySelector(".card-dot");
				const label = row.querySelector(".card-label");
				if (!isVisible(dot) || !isVisible(label)) continue;
				const rowBox = row.getBoundingClientRect();
				const dotBox = dot.getBoundingClientRect();
				const labelBox = label.getBoundingClientRect();
				const title = (label.textContent || "card").trim();
				if (dotBox.right > labelBox.left + 0.5) problems.push(`${title}: card dot overlaps label (${dotBox.right.toFixed(1)} > ${labelBox.left.toFixed(1)})`);
				if (labelBox.right > rowBox.right + 0.5) problems.push(`${title}: card label ends outside row`);
			}
			return problems;
		});
		expect.soft(violations, `${label}: phase/card rail rows must not overlap fixed dots or counts`).toEqual([]);
	}

	// ── T-4: the walkthrough pane lives WITH the reviewer-child session. On mount the
	//    bound child pane self-resolves the READY cards from its OWN binding/<child>
	//    via the child-self `recover` branch — NO click, NO Run/Load button — and a
	//    reload re-renders the SAME persisted cards (child self-recover again). ──
	test("T-4 — bound child pane self-recovers READY cards on mount and re-renders after reload", async ({ page, gateway }) => {
		const recoverProbe = createRecoverRouteProbe(page);
		const sid = await freshSessionWithPanel(page);
		// The bound session's worktree must be a real git repo so publish/bundle
		// recompute the LIVE diff. This sets the module-level baseSha/headSha that
		// submitYaml()'s pr.base_sha/head_sha carry.
		const ps = gateway.sessionManager?.getPersistedSession(sid) as { cwd?: string; worktreePath?: string } | undefined;
		const sessionWorktree = ps?.worktreePath ?? ps?.cwd;
		expect(sessionWorktree, "the bound session must have a resolvable working dir").toBeTruthy();
		setupSessionGitRepo(sessionWorktree!);

		// Seed the pack store so THIS session is a bound reviewer child whose pane
		// recovers from its OWN binding/<child>. Seed binding/<sid> (the CHILD key) +
		// submitted/<jobId> (NO owner pointer): a successful recover proves the child
		// self-recover branch (binding/<me> → submitted) fired.
		const { getPackStore } = await import("../../../dist/server/extension-host/pack-store.js");
		const childJobId = "prw-t4-child-recover";
		await getPackStore().put(PACK, `submitted/${childJobId}`, { yaml: submitYaml(), baseSha, headSha, submittedAt: Date.now() });
		await getPackStore().put(PACK, `binding/${sid}`, {
			jobId: childJobId,
			parentSessionId: "prw-t4-owner-session",
			baseSha, headSha,
			status: "submitted",
			target: {
				provider: "github", owner: "SuuBro", repo: "bobbit", number: 4242, host: "github.com",
				prUrl: "https://github.com/SuuBro/bobbit/pull/4242", baseSha, headSha,
				canonicalKey: "github:SuuBro/bobbit#4242",
			},
		});

		// The child pane AUTO-mounts: on mount it self-resolves binding/<self> →
		// `recover` → re-publishes → renders cards. NO click, NO prw-load button.
		const recoverAndAssertCards = (recoverMark = recoverProbe.mark()): Promise<string | undefined> =>
			openRecoveredReadyWalkthrough(page, childJobId, recoverProbe, recoverMark);

		const persistedAt1 = await recoverAndAssertCards();
		expect(persistedAt1, "stored cards must carry a persistedAt").toBeTruthy();

		// RELOAD persistence: a full reload clears the in-memory byJob; the child pane
		// re-renders the SAME cards via the recover route (child self-resolve again).
		const token = await readE2ETokenAsync();
		const reloadRecoverMark = recoverProbe.mark();
		await page.goto(`${base()}/?token=${encodeURIComponent(token)}#/session/${sid}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers()).catch(() => {});
		const persistedAt2 = await recoverAndAssertCards(reloadRecoverMark);
		expect(persistedAt2, "reload must rehydrate the SAME persisted store record via recover").toBe(persistedAt1);
	});

	// ── T-5: regression coverage for the PR walkthrough rail polish. Orientation
	//    beats are the only orientation navigation surface; phase counters use the
	//    same compact gate-counter vocabulary; title rows reserve fixed dot/count
	//    real estate at both default and constrained widths. ──
	test("T-5 — sidebar de-duplicates orientation and keeps rail counters compact/non-overlapping", async ({ page, gateway }) => {
		await page.setViewportSize({ width: 1600, height: 900 });
		const sid = await seedReadyWalkthrough(page, gateway, "prw-t5-sidebar-regression");
		await apiFetch(`/api/sessions/${sid}/side-panel-workspace/resize`, {
			method: "POST",
			body: JSON.stringify({ sizeMode: "fullscreen" }),
		});
		await openRecoveredReadyWalkthrough(page, "prw-t5-sidebar-regression");

		const labelledRail = page.getByTestId("pr-walkthrough-labelled-rail");
		if (!(await labelledRail.isVisible())) {
			await page.getByTestId("pr-walkthrough-collapsed-rail").getByTestId("pr-walkthrough-rail-toggle").click();
		}
		await expect(labelledRail, "labelled rail must render in expanded mode").toBeVisible();
		await expect(labelledRail.getByTestId("pr-walkthrough-orientation-rail"), "orientation beats must render in the labelled rail").toBeVisible();

		const labelledDuplicateOrientationCards = labelledRail.locator('.card-button[data-prw-nav="orientation-summary"]:visible');
		expect.soft(
			await labelledDuplicateOrientationCards.count(),
			"labelled rail must not duplicate orientation card buttons outside the orientation beat rail",
		).toBe(0);
		expect.soft(
			await labelledRail.getByTestId("pr-walkthrough-phase-button").filter({ has: page.locator(".phase-name").filter({ hasText: /^Orientation$/ }) }).count(),
			"labelled rail must not render a duplicate Orientation phase row when orientation beats are present",
		).toBe(0);

		const phaseCounts = labelledRail.locator('[data-testid="pr-walkthrough-phase-button"]:visible .phase-count');
		expect(await phaseCounts.count(), "the labelled rail must expose phase progress counts").toBeGreaterThan(0);
		const countTexts = (await phaseCounts.allTextContents()).map((text) => text.trim());
		for (const text of countTexts) {
			expect.soft(text, `phase progress count must use gate-counter format (n/total), got ${text}`).toMatch(/^\(\d+\/\d+\)$/);
		}
		const firstCountStyle = await phaseCounts.first().evaluate((node) => {
			const style = getComputedStyle(node as HTMLElement);
			return {
				whiteSpace: style.whiteSpace,
				fontWeight: Number.parseInt(style.fontWeight, 10),
				fontSize: Number.parseFloat(style.fontSize),
				letterSpacing: style.letterSpacing,
			};
		});
		expect.soft(firstCountStyle.whiteSpace, "phase progress count must not wrap").toBe("nowrap");
		expect.soft(firstCountStyle.fontWeight, "phase progress count must be semibold/bold like gate counters").toBeGreaterThanOrEqual(600);
		expect.soft(firstCountStyle.fontSize, "phase progress count must stay compact like gate counters").toBeLessThanOrEqual(12);
		expect.soft(firstCountStyle.letterSpacing, "phase progress count should use tight gate-counter letter spacing").not.toBe("normal");

		await assertLabelledRailRowsDoNotOverlap(page, "default rail width");

		const resizeHandle = page.getByTestId("pr-walkthrough-rail-resize");
		await expect(resizeHandle, "expanded desktop rail must expose the resize handle").toBeVisible();
		const resizeBox = await resizeHandle.boundingBox();
		expect(resizeBox, "resize handle must have a measurable box").toBeTruthy();
		await page.mouse.move(resizeBox!.x + resizeBox!.width / 2, resizeBox!.y + resizeBox!.height / 2);
		await page.mouse.down();
		await page.mouse.move(resizeBox!.x - 110, resizeBox!.y + resizeBox!.height / 2, { steps: 8 });
		await page.mouse.up();
		await assertLabelledRailRowsDoNotOverlap(page, "constrained rail width");

		await page.getByTestId("pr-walkthrough-rail-toggle").click();
		const collapsedRail = page.getByTestId("pr-walkthrough-collapsed-rail");
		await expect(collapsedRail, "collapsed rail must render after toggling").toBeVisible();
		await expect(collapsedRail.getByTestId("pr-walkthrough-orientation-rail"), "orientation beats must remain represented in collapsed mode").toBeVisible();
		expect.soft(
			await collapsedRail.locator('.card-button[data-prw-nav="orientation-summary"]:visible').count(),
			"collapsed rail must not duplicate orientation card buttons outside the orientation beat controls",
		).toBe(0);
		expect.soft(
			await collapsedRail.locator('[data-testid="pr-walkthrough-phase-button"][aria-label="Orientation"]:visible').count(),
			"collapsed rail must not render a duplicate Orientation phase pip when orientation beats are present",
		).toBe(0);
	});
});
