/**
 * Journey: App Smoke + Session Sharing + Draft Persistence — v2 browser smoke
 * Covers: journey-app-smoke, journey-session-sharing, journey-draft-persistence
 * Consolidated from: basic-load-*, session-sharing-*, pr-preview-*, draft-loss-*, etc.
 */
import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus, apiFetch, sendMessage, createGoal, deleteGoal } from "../_helpers/journey-fixture.js";
import { createGoalAssistantViaUI } from "../fixtures/ui-helpers.js";

test.describe("Journey: App Smoke", () => {
	test("app loads and sidebar is visible", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});

	test("new-session button present on load", async ({ page }) => {
		await openApp(page);
		await expect(page.getByRole("button", { name: /new session/i }).first()).toBeVisible({ timeout: 15_000 });
	});

	test("app title is non-empty", async ({ page }) => {
		await openApp(page);
		await expect(page.locator("body")).toBeVisible({ timeout: 20_000 });
		const title = await page.title();
		expect(title).toBeTruthy();
	});

	// Ported from page-title.spec.ts (audit: app-smoke PARTIAL). The tab title
	// must carry the "<project> · Bobbit" suffix — not just be non-empty.
	test("document title carries the '· Bobbit' suffix", async ({ page }) => {
		await openApp(page);
		await expect(page.locator("body")).toBeVisible({ timeout: 20_000 });
		await expect(async () => {
			const title = await page.title();
			expect(title, "tab title should contain the interpunct separator").toContain("·");
			expect(title, "tab title should be suffixed with Bobbit").toContain("Bobbit");
		}).toPass({ intervals: [250, 500, 1000], timeout: 15_000 });
	});

	test("settings route navigable from root", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/system/general"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });
		await expect(page.locator("body")).toBeVisible({ timeout: 15_000 });
	});
});

test.describe("Journey: Session Sharing", () => {
	test("session route renders editor for sharing context", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("session hash appears in URL for sharing", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toContain(sessionId);
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("copy-link button is present in session header", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			// The copy-link action is either a direct header button or accessible via the actions trigger
			const copyLinkDirect = page.locator('[data-session-action-surface="header"][data-session-action-id="copy-link"]').first();
			const actionsTrigger = page.locator('[data-testid="session-actions-trigger"]').first();
			const found = await copyLinkDirect.isVisible({ timeout: 15_000 }).catch(() => false)
				|| await actionsTrigger.isVisible({ timeout: 15_000 }).catch(() => false);
			expect(found, "copy-link button or session-actions-trigger must be present in session header").toBe(true);
		} finally {
			await deleteSession(sessionId);
		}
	});

	test.skip("copy-link button copies URL to clipboard", async () => {
		// Skipped: clipboard assertions require https context or explicit permission grants
		// that are unreliable across headless environments.
		// The button presence is verified in the test above.
	});
});

// ═══════════════════════════════════════════════════════════════
// Draft Persistence (CT-02 contract)
//
// Covers: draft-loss.spec.ts behavioral scenarios.
// Guarantee: editor draft typed in a session is never silently lost
// across session switches or page reloads.
// ═══════════════════════════════════════════════════════════════

test.describe("Journey: Draft Persistence", () => {
	/**
	 * CT-02-a: Draft typed in session A persists after switching to B and back.
	 * Covers: draft-loss.spec.ts "draft survives send→switch→reload" scenario.
	 */
	test("draft typed in session A persists after switching to B and back", async ({ page }) => {
		const sA = await createSession();
		const sB = await createSession();
		await waitForSessionStatus(sA, "idle");
		await waitForSessionStatus(sB, "idle");
		try {
			await openApp(page);

			// Navigate to A and type a unique draft
			await navigateToHash(page, `#/session/${sA}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			const draftText = `app-smoke-draft-${Date.now()}`;
			await page.locator("message-editor textarea").first().fill(draftText);

			// Wait until the server has saved the draft (100 ms debounce)
			await expect.poll(async () => {
				const resp = await apiFetch(`/api/sessions/${sA}/draft?type=prompt`);
				if (!resp.ok) return null;
				const body = await resp.json() as { data?: { text?: string } };
				return body?.data?.text ?? null;
			}, { timeout: 20_000, intervals: [500, 1000, 1000, 2000] }).toBe(draftText);

			// Switch to B
			await navigateToHash(page, `#/session/${sB}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			// Switch back to A — draft must be restored
			await navigateToHash(page, `#/session/${sA}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await expect(async () => {
				const val = await page.locator("message-editor textarea").first().inputValue();
				expect(val, "draft must survive session switch").toContain(draftText);
			}).toPass({ intervals: [500, 1000, 2000], timeout: 20_000 });
		} finally {
			await deleteSession(sA).catch(() => {});
			await deleteSession(sB).catch(() => {});
		}
	});

	/**
	 * CT-02-d: Draft typed survives page reload.
	 * Covers: draft-loss.spec.ts "draft survives … hard reload" and stories-drafts CT-02-d.
	 */
	test("draft typed in session survives page reload", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			const draftText = `draft-reload-smoke-${Date.now()}`;
			await page.locator("message-editor textarea").first().fill(draftText);

			// Confirm server has the draft before reload
			await expect.poll(async () => {
				const resp = await apiFetch(`/api/sessions/${sessionId}/draft?type=prompt`);
				if (!resp.ok) return null;
				const body = await resp.json() as { data?: { text?: string } };
				return body?.data?.text ?? null;
			}, { timeout: 20_000, intervals: [500, 1000, 1000, 2000] }).toBe(draftText);

			// Full page reload
			await page.reload();
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 20_000 });

			// Navigate back to the same session
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			// Editor must show the previously typed draft
			await expect(async () => {
				const val = await page.locator("message-editor textarea").first().inputValue();
				expect(val, "draft must survive page reload").toContain(draftText);
			}).toPass({ intervals: [500, 1000, 2000], timeout: 20_000 });
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});

	/**
	 * Server-backed persistence (draft-loss.spec.ts + audit REC): the same-tab
	 * reload test above can be satisfied by the synchronous sessionStorage mirror
	 * alone. To prove the draft is genuinely server-backed (survives loss of the
	 * client mirror — new tab / evicted storage), clear the sessionStorage draft
	 * mirror before reload so restoration MUST come from loadDraftFromServer.
	 */
	test("draft restores from the server after the client draft mirror is cleared", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			const draftText = `draft-server-backed-${Date.now()}`;
			await page.locator("message-editor textarea").first().fill(draftText);

			// Confirm the server has persisted the draft.
			await expect.poll(async () => {
				const resp = await apiFetch(`/api/sessions/${sessionId}/draft?type=prompt`);
				if (!resp.ok) return null;
				const body = await resp.json() as { data?: { text?: string } };
				return body?.data?.text ?? null;
			}, { timeout: 20_000, intervals: [500, 1000, 1000, 2000] }).toBe(draftText);

			// Evict the client-side draft mirror (text + gen) for this session so a
			// same-tab reload cannot restore synchronously from sessionStorage; the
			// only remaining source is the server (loadDraftFromServer).
			await page.evaluate((sid) => {
				sessionStorage.removeItem(`bobbit_draft_${sid}`);
				sessionStorage.removeItem(`bobbit_draft_gen_${sid}`);
				sessionStorage.removeItem(`draft-send-gen-${sid}`);
			}, sessionId);

			await page.reload();
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 20_000 });
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			// Restoration must come from the server despite the cleared mirror.
			await expect(async () => {
				const val = await page.locator("message-editor textarea").first().inputValue();
				expect(val, "draft must be restored from the server after mirror eviction").toContain(draftText);
			}).toPass({ intervals: [500, 1000, 2000], timeout: 20_000 });
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});

	/**
	 * CT-02 / isolation: Draft typed in session A must not appear in session B.
	 * Covers the draft isolation story (S-03) from stories-sessions.spec.ts.
	 */
	test("draft typed in session A does not bleed into session B", async ({ page }) => {
		const sA = await createSession();
		const sB = await createSession();
		await waitForSessionStatus(sA, "idle");
		await waitForSessionStatus(sB, "idle");
		try {
			await openApp(page);

			// Type a draft in A
			await navigateToHash(page, `#/session/${sA}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			const draftA = `draft-isolation-A-${Date.now()}`;
			await page.locator("message-editor textarea").first().fill(draftA);
			await expect.poll(async () => {
				const resp = await apiFetch(`/api/sessions/${sA}/draft?type=prompt`);
				if (!resp.ok) return null;
				const body = await resp.json() as { data?: { text?: string } };
				return body?.data?.text ?? null;
			}, { timeout: 20_000, intervals: [500, 1000, 1000, 2000] }).toBe(draftA);

			// Navigate to B — editor must not show A's draft
			await navigateToHash(page, `#/session/${sB}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await expect(async () => {
				const val = await page.locator("message-editor textarea").first().inputValue();
				expect(val, "session B must not contain session A's draft").not.toContain(draftA);
			}).toPass({ intervals: [500, 1000, 2000], timeout: 15_000 });
		} finally {
			await deleteSession(sA).catch(() => {});
			await deleteSession(sB).catch(() => {});
		}
	});
});

// Ported from goal-metadata.spec.ts (audit: app-smoke GAP / BR57): the goal
// proposal Metadata tab must expose an add-row control that appends an editable
// key/value row.
test.describe("Journey: Goal Proposal Metadata Tab", () => {
	test("Metadata tab add button appends an editable metadata row", async ({ page }) => {
		test.setTimeout(90_000);
		await openApp(page);
		await createGoalAssistantViaUI(page, { timeout: 60_000 });
		await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");
		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 20_000 });
		await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 20_000 });
		const tab = page.locator("[data-testid='goal-proposal-tab-metadata']");
		await expect(tab).toBeVisible({ timeout: 15_000 });
		await tab.click();
		const panel = page.locator("[data-testid='goal-proposal-panel-metadata']");
		await expect(panel).toBeVisible({ timeout: 10_000 });
		const before = await page.locator("[data-testid='goal-metadata-row']").count();
		await page.locator("[data-testid='goal-metadata-add']").click();
		await expect(page.locator("[data-testid='goal-metadata-row']")).toHaveCount(before + 1, { timeout: 10_000 });
		await expect(page.locator("[data-testid='goal-metadata-key']").last()).toBeVisible();
		await expect(page.locator("[data-testid='goal-metadata-value']").last()).toBeVisible();
	});
});

// Ported from sidebar-keyboard-nav.spec.ts (audit: app-smoke GAP / BR69):
// Ctrl+ArrowDown walks the sidebar's data-nav-id rows forward in DOM order.
test.describe("Journey: Sidebar Keyboard Nav", () => {
	test("Ctrl+ArrowDown advances keyboard-nav through rows in DOM order", async ({ page }) => {
		test.setTimeout(90_000);
		const goal = await createGoal({ title: `KbdNav${Date.now()}`, worktree: false });
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
			// The sidebar edge becoming visible does NOT guarantee the data-nav-id rows
			// are populated yet (they arrive via WS-driven state). Wait on the OBSERVABLE
			// row count so a CPU-starved render under N-way load never reads 0/1 rows.
			await expect.poll(() => page.locator("[data-nav-id]").count(), { timeout: 15_000 }).toBeGreaterThan(1);
			const domOrder: string[] = await page.evaluate(() =>
				Array.from(document.querySelectorAll("[data-nav-id]")).map((el) => el.getAttribute("data-nav-id") || ""));
			expect(domOrder.length, "sidebar must emit multiple data-nav-id rows").toBeGreaterThan(1);
			const pressDown = () => page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", {
				key: "ArrowDown", code: "ArrowDown", ctrlKey: true, metaKey: true, bubbles: true, cancelable: true,
			})));
			const activeId = () => page.evaluate(() => (window as any).__bobbitState?.keyboardNavActiveId ?? null);
			await pressDown();
			await expect.poll(activeId, { timeout: 5_000 }).not.toBeNull();
			const id1 = await activeId();
			await pressDown();
			await expect.poll(activeId, { timeout: 5_000 }).not.toBe(id1);
			const id2 = await activeId();
			// The two visited rows must be a forward step in DOM order (Ctrl+ArrowDown
			// moves DOWN, not up).
			const i1 = domOrder.indexOf(id1 as string);
			const i2 = domOrder.indexOf(id2 as string);
			expect(i1, "first nav id in DOM order").toBeGreaterThanOrEqual(0);
			expect(i2, "second nav id must be the next row forward (wrap allowed)").toBe((i1 + 1) % domOrder.length);
		} finally {
			await deleteSession(sessionId).catch(() => {});
			await deleteGoal(goal.id, true).catch(() => {});
		}
	});
});

// Ported from open-session-new-window.spec.ts (audit: app-smoke GAP / BR55): the
// session row's actions popover has an "Open in new window" item that calls
// window.open(deepLink, "_blank", "noopener").
test.describe("Journey: Open in New Window", () => {
	test("session actions menu opens the deep link in a new window", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await page.setViewportSize({ width: 1280, height: 900 });
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
			const row = page.locator(`[data-session-id="${sessionId}"]`).first();
			await expect(row).toBeVisible({ timeout: 10_000 });
			// Session deep links use the hash form (absoluteHashUrl): origin+pathname+search+#/session/<id>.
			const deepLink = await page.evaluate((id) => `${location.origin}${location.pathname}${location.search}#/session/${id}`, sessionId);
			// Capture window.open (stub applied right before the action so a render
			// pass cannot restore the native impl between hover and click).
			await page.evaluate(() => {
				(window as any).__opened = [];
				window.open = ((u?: string | URL, t?: string, f?: string) => {
					(window as any).__opened.push({
						url: u === undefined ? undefined : String(u),
						target: t === undefined ? undefined : String(t),
						features: f === undefined ? undefined : String(f),
					});
					return { opener: null } as any;
				}) as any;
			});
			const trigger = row.locator(`[data-testid="sidebar-actions-trigger"][data-sidebar-actions-kind="session"][data-sidebar-actions-id="${sessionId}"]`).first();
			await row.hover();
			await expect(trigger).toBeVisible({ timeout: 5_000 });
			await trigger.click();
			await expect(page.locator("sidebar-actions-popover [role='menu']")).toBeVisible({ timeout: 5_000 });
			const item = page.locator(`sidebar-actions-popover [role="menuitem"][data-sidebar-action-id="open-new-window"]`).first();
			await expect(item).toBeVisible({ timeout: 5_000 });
			await expect(item).toContainText("Open in new window");
			await item.click();
			await expect(page.locator("sidebar-actions-popover")).toHaveCount(0, { timeout: 5_000 });
			await expect.poll(() => page.evaluate(() => (window as any).__opened)).toEqual([
				{ url: deepLink, target: "_blank", features: "noopener" },
			]);
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});

// Ported from github-trusted-hosts.spec.ts (audit: app-smoke GAP): adding a
// trusted GitHub host renders its row in settings.
test.describe("Journey: GitHub Trusted Hosts", () => {
	test("adding a trusted GitHub host renders its row", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");
		const input = page.locator('[data-testid="github-trusted-host-input"]');
		await expect(input).toBeVisible({ timeout: 15_000 });
		const host = `ghe-${Date.now()}.example.com`;
		await input.fill(host);
		await page.locator('[data-testid="github-trusted-host-add"]').click();
		await expect(
			page.locator(`[data-testid="github-trusted-host-row"][data-host="${host}"]`),
		).toBeVisible({ timeout: 10_000 });
	});
});

// Ported from replace-bobbit-text.spec.ts (audit: app-smoke GAP): settings
// exposes the replace-bobbit-with-text toggle.
test.describe("Journey: Replace Bobbit Text", () => {
	test("settings exposes the replace-bobbit-with-text toggle", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");
		await expect(page.locator('[data-testid="general-replace-bobbit-with-text"]').first()).toBeVisible({ timeout: 15_000 });
	});
});
