// Migrated from tests/e2e/ui/pr-walkthrough-trust-prompt.spec.ts (v2 browser/e2e tier).
// Full-gateway browser E2E — carried over verbatim (relative harness/helper
// specifiers resolve identically from tests2/browser/e2e/).
/**
 * Browser E2E — PR Walkthrough LAUNCH trust prompt (design
 * docs/design/pr-walkthrough-gh-posting.md §4b). When a walkthrough launch resolves
 * a target on a NON-default remote host, the pack `run` route returns
 * `HOST_NOT_TRUSTED` WITHOUT spawning; the client
 * (`pack-entrypoints.ts::runSpawnLauncher` → `pr-walkthrough-trust.ts`) prompts the
 * user to trust the host, and on accept persists it to `githubTrustedHosts` via
 * `PUT /api/preferences` and re-invokes `run` with a `trustedHostAck` + the resolved
 * `prUrl`. On decline it aborts with a readable message and persists nothing.
 *
 * The harness has no real enterprise PR (and the pack `run` trust pre-check is a
 * sibling task), so this spec STUBS the `/api/ext/route/run` response via
 * page.route to drive the HOST_NOT_TRUSTED path deterministically — it exercises the
 * REAL client launcher → trust-prompt → PUT /api/preferences → retry chain and the
 * REAL preferences store (the PUT/readback are NOT stubbed). The launch is driven
 * through the shared session-actions menu (the same click path a user takes).
 *
 * Coverage:
 *   - accept → confirm dialog shown, host persisted to /api/preferences, `run`
 *     re-invoked ONCE carrying trustedHostAck + prUrl.
 *   - decline → NO retry, readable cancel message, host NOT persisted.
 *   - a default host (no HOST_NOT_TRUSTED from `run`) never prompts.
 */
import { test, expect } from "../gateway-harness.js";
import type { Page, Route } from "@playwright/test";
import { apiFetch, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, createSessionViaUI } from "./ui-helpers.js";

const RUN_ROUTE_RE = /\/api\/ext\/route\/run\b/;

interface RunPost { ackHost?: unknown; prUrl?: unknown; body: Record<string, unknown> }

/** Parse the pack-route POST envelope { sessionId, surfaceToken, init:{ body } }. */
function parseRunPost(postData: string | null): RunPost {
	let body: Record<string, unknown> = {};
	try {
		const env = JSON.parse(postData || "{}");
		body = (env?.init?.body ?? {}) as Record<string, unknown>;
	} catch { /* leave empty */ }
	return { ackHost: body.trustedHostAck, prUrl: body.prUrl, body };
}

async function readTrustedHosts(): Promise<string[]> {
	const res = await apiFetch("/api/preferences");
	if (!res.ok) return [];
	const prefs = await res.json();
	return Array.isArray(prefs.githubTrustedHosts)
		? prefs.githubTrustedHosts.filter((h: unknown): h is string => typeof h === "string")
		: [];
}

async function setTrustedHosts(hosts: string[]): Promise<void> {
	await apiFetch("/api/preferences", { method: "PUT", body: JSON.stringify({ githubTrustedHosts: hosts }) });
}

/** Open the chat-header session-actions menu and click the PR Walkthrough launcher. */
async function clickPrWalkthroughLauncher(page: Page): Promise<void> {
	const trigger = page.locator('[data-testid="session-actions-trigger"]').first();
	await expect(trigger).toBeVisible({ timeout: 10_000 });
	await trigger.click();
	await expect(page.locator("sidebar-actions-popover [role='menu']")).toBeVisible({ timeout: 5_000 });
	const launcher = page.locator('sidebar-actions-popover [role="menuitem"]', { hasText: "PR Walkthrough" }).first();
	await expect(launcher).toBeVisible({ timeout: 10_000 });
	await launcher.click();
}

/** The confirm modal rendered by dialogs.ts::confirmAction("Trust this domain?", …). */
function trustDialog(page: Page) {
	return page.locator("div", { hasText: "Trust this domain?" }).filter({ has: page.getByRole("button", { name: "Trust domain" }) }).last();
}

test.describe("PR walkthrough — launch trust prompt", () => {
	let savedHosts: string[] = [];

	test.beforeEach(async () => {
		savedHosts = await readTrustedHosts();
	});
	test.afterEach(async () => {
		// Restore the pre-test managed list so a run never leaks a test host.
		await setTrustedHosts(savedHosts).catch(() => {});
	});

	async function freshSession(page: Page): Promise<string> {
		await openApp(page);
		const sid = await createSessionViaUI(page);
		await waitForSessionStatus(sid, "idle").catch(() => { /* best-effort */ });
		return sid;
	}

	test("accept → persists the host and re-invokes run with trustedHostAck + prUrl", async ({ page }) => {
		const HOST = "ghe.accept-test.example.com";
		const PR_URL = `https://${HOST}/octo/repo/pull/3`;
		await setTrustedHosts(savedHosts.filter((h) => h !== HOST));

		const sid = await freshSession(page);
		const runPosts: RunPost[] = [];
		await page.route(RUN_ROUTE_RE, async (route: Route) => {
			const parsed = parseRunPost(route.request().postData());
			runPosts.push(parsed);
			if (parsed.ackHost) {
				// The retry after trust — return ok so the launcher opens the panel.
				await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, childSessionId: sid }) });
			} else {
				await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: false, code: "HOST_NOT_TRUSTED", retryable: true, host: HOST, prUrl: PR_URL, error: `The remote host "${HOST}" is not in your trusted list.` }) });
			}
		});

		await clickPrWalkthroughLauncher(page);

		const dialog = trustDialog(page);
		await expect(dialog, "the trust prompt must appear for an untrusted host").toBeVisible({ timeout: 10_000 });
		await expect(dialog).toContainText(HOST);
		await dialog.getByRole("button", { name: "Trust domain" }).click();

		// The launch re-invokes run exactly once with the ack + resolved prUrl.
		await expect.poll(() => runPosts.length, { timeout: 10_000 }).toBe(2);
		expect(runPosts[0].ackHost, "the first run call must NOT carry an ack").toBeUndefined();
		expect(runPosts[1].ackHost, "the retry must carry trustedHostAck").toBe(HOST);
		expect(runPosts[1].prUrl, "the retry must echo the resolved prUrl").toBe(PR_URL);

		// The host is persisted to the managed trusted list.
		await expect.poll(async () => (await readTrustedHosts()).includes(HOST), { timeout: 10_000 }).toBe(true);
	});

	test("decline → no retry, readable cancel message, host not persisted", async ({ page }) => {
		const HOST = "ghe.decline-test.example.com";
		const PR_URL = `https://${HOST}/octo/repo/pull/9`;
		await setTrustedHosts(savedHosts.filter((h) => h !== HOST));

		await freshSession(page);
		const runPosts: RunPost[] = [];
		await page.route(RUN_ROUTE_RE, async (route: Route) => {
			runPosts.push(parseRunPost(route.request().postData()));
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: false, code: "HOST_NOT_TRUSTED", retryable: true, host: HOST, prUrl: PR_URL, error: `The remote host "${HOST}" is not in your trusted list.` }) });
		});

		await clickPrWalkthroughLauncher(page);

		const dialog = trustDialog(page);
		await expect(dialog).toBeVisible({ timeout: 10_000 });
		await dialog.getByRole("button", { name: "Cancel" }).click();

		// A readable cancel message surfaces via the launcher-feedback element.
		await expect(
			page.locator('[data-testid="launcher-feedback"], [role="status"]').filter({ hasText: /was not added to your trusted hosts/i }).first(),
		).toBeVisible({ timeout: 10_000 });

		// No retry ran, and nothing was persisted. The cancel feedback above is emitted
		// synchronously after runSpawnLauncher returns WITHOUT a retry, so once it is
		// visible no further run POST can fire — assert deterministically, no sleep.
		expect(runPosts.length, "decline must NOT re-invoke run").toBe(1);
		expect(await readTrustedHosts()).not.toContain(HOST);
	});

	test("a default-host launch (no HOST_NOT_TRUSTED) never prompts", async ({ page }) => {
		await freshSession(page);
		// Stub run as a plain NO_PR (what the harness resolves for github.com): no
		// HOST_NOT_TRUSTED code, so the trust prompt must never appear.
		await page.route(RUN_ROUTE_RE, async (route: Route) => {
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: false, code: "NO_PR", error: "No open GitHub PR for this branch." }) });
		});

		await clickPrWalkthroughLauncher(page);

		await expect(
			page.locator('[data-testid="launcher-feedback"], [role="status"]').filter({ hasText: /No open GitHub PR/i }).first(),
		).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText("Trust this domain?"), "a default host must never prompt").toHaveCount(0);
	});
});
