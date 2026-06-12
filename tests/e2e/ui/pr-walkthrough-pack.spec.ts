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
 *      flagged `builtin:true`, and contributes NOTHING to /api/tools (no-tools pack).
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

async function listInstalled(): Promise<Array<{ packName: string; scope: string; builtin?: boolean }>> {
	const res = await apiFetch("/api/marketplace/installed");
	expect(res.ok).toBe(true);
	return (await res.json()).installed as Array<{ packName: string; scope: string; builtin?: boolean }>;
}

/** Mint a server-minted pack-bound surface token for the pack's PANEL (no carrier
 *  tool — no-tools pack). Used only by the path-traversal probe below. */
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

test.afterEach(async () => {
	// Best-effort: re-enable all entrypoints so a failed run never leaves the
	// shipped feature disabled for the next test (server-scope activation persists).
	await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK, disabled: { entrypoints: [] } }),
	}).catch(() => {});
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
		const tools = await listToolNames();
		expect(tools.find((t) => t.name === "pr_walkthrough"), "a no-tools pack contributes NOTHING to /api/tools").toBeFalsy();
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
		const gitWidgetToggle = builtinGroup.locator('[data-testid="market-toggle-entrypoint-pr-walkthrough-git-widget"]');
		await expect(gitWidgetToggle, "the built-in pack's entrypoint toggles must render").toBeVisible({ timeout: 15_000 });
		for (const listName of ENTRYPOINT_LIST_NAMES) {
			const toggle = builtinGroup.locator(`[data-testid="market-toggle-entrypoint-${listName}"]`);
			if (await toggle.isChecked()) {
				const put = page.waitForResponse((r) => r.url().includes("/api/marketplace/pack-activation") && r.request().method() === "PUT");
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

		// Disabled state survives a reload: the server-scope activation override is
		// persisted, so after a full reload the Market toggle is still OFF and the
		// entrypoints stay absent from /api/ext/contributions.
		await page.goto(`${base()}/?token=${encodeURIComponent(token)}#/market`);
		const group2 = page.locator('[data-testid="market-builtin-group"]');
		await expect(group2).toBeVisible({ timeout: 20_000 });
		const gitToggleAfterReload = group2.locator('[data-testid="market-toggle-entrypoint-pr-walkthrough-git-widget"]');
		await expect(gitToggleAfterReload).toBeVisible({ timeout: 15_000 });
		await expect(gitToggleAfterReload, "disable must survive reload (toggle stays off)").not.toBeChecked();
		await expect.poll(async () => {
			const meta = (await listContributions()).find((p) => p.packId === PACK);
			return meta?.entrypoints?.length ?? 0;
		}, { timeout: 10_000 }).toBe(0);

		// ── Re-enable → the launcher + deep-link are restored. ──
		for (const listName of ENTRYPOINT_LIST_NAMES) {
			const toggle = group2.locator(`[data-testid="market-toggle-entrypoint-${listName}"]`);
			await expect(toggle).toBeVisible({ timeout: 10_000 });
			if (!(await toggle.isChecked())) {
				const put = page.waitForResponse((r) => r.url().includes("/api/marketplace/pack-activation") && r.request().method() === "PUT");
				await toggle.click();
				await put;
			}
		}
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

	// ── T-4: the walkthrough pane lives WITH the reviewer-child session. On mount the
	//    bound child pane self-resolves the READY cards from its OWN binding/<child>
	//    via the child-self `recover` branch — NO click, NO Run/Load button — and a
	//    reload re-renders the SAME persisted cards (child self-recover again). ──
	test("T-4 — bound child pane self-recovers READY cards on mount and re-renders after reload", async ({ page, gateway }) => {
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
		const recoverAndAssertCards = async (): Promise<string | undefined> => {
			const recoverResp = page.waitForResponse(
				(r) => /\/api\/ext\/route\/recover\b/.test(r.url()) && r.request().method() === "POST",
				{ timeout: 20_000 },
			);
			await page.evaluate((h) => { window.location.hash = h; }, `#/ext/${PACK}`);
			await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 }).toBe(`#/ext/${PACK}`);
			await expect(page.locator('[data-testid="prw-panel-root"]').first()).toBeVisible({ timeout: 20_000 });
			// The recover POST fires automatically — NO button click.
			const resp = await recoverResp;
			expect(resp.status(), `recover callRoute failed: ${await resp.text().catch(() => "")}`).toBe(200);
			const recovered = await resp.json().catch(() => ({}));
			expect(recovered.found, "the child pane must self-resolve binding/<child> → submitted YAML").toBe(true);
			expect(recovered.jobId).toBe(childJobId);
			// There is NO manual Load button — the pane auto-renders.
			await expect(page.locator('[data-testid="prw-load"]')).toHaveCount(0);
			// The READY cards render in THIS (child) session's pane.
			await expect(page.locator('[data-testid="prw-navrail"]').first()).toBeVisible({ timeout: 10_000 });
			await expect(page.locator('[data-testid="prw-title"]').first()).toContainText(PR_TITLE, { timeout: 10_000 });
			await expect(page.locator('[data-testid="prw-nav-card"][data-prw-nav="orientation-summary"]').first()).toBeVisible();
			return (await page.locator('[data-testid="prw-persisted-at"]').first().textContent())?.trim();
		};

		const persistedAt1 = await recoverAndAssertCards();
		expect(persistedAt1, "stored cards must carry a persistedAt").toBeTruthy();

		// RELOAD persistence: a full reload clears the in-memory byJob; the child pane
		// re-renders the SAME cards via the recover route (child self-resolve again).
		const token = await readE2ETokenAsync();
		await page.goto(`${base()}/?token=${encodeURIComponent(token)}#/session/${sid}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers()).catch(() => {});
		const persistedAt2 = await recoverAndAssertCards();
		expect(persistedAt2, "reload must rehydrate the SAME persisted store record via recover").toBe(persistedAt1);
	});
});
