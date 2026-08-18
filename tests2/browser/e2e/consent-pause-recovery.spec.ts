import { test, expect } from "../gateway-harness.js";
import { apiFetch, defaultProject } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

// This journey uses the authenticated gateway for session and staff ownership,
// while its consent record is a bounded durable-projection fixture. The real
// timeout/restart state machine is composed in consent-pause-recovery.test.ts;
// here we pin only the browser's shared-card and inbox-reference contract.
test.describe.configure({ mode: "serial", retries: 0 });

const REQUEST_ID = "browser-paused-consent-request";
const QUESTION = "BROWSER_CONSENT_PROJECTION_QUESTION";

test.describe("consent pause recovery browser journey", () => {
	const staffIds: string[] = [];

	test.afterAll(async () => {
		for (const id of staffIds.splice(0)) await apiFetch(`/api/staff/${id}`, { method: "DELETE" }).catch(() => {});
	});

	async function createStaff(): Promise<{ id: string; sessionId: string }> {
		const project = await defaultProject();
		const response = await apiFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify({
				name: `Consent recovery browser ${Date.now()}`,
				systemPrompt: "Consent recovery browser fixture.",
				cwd: project.rootPath,
				projectId: project.id,
			}),
		});
		const body = await response.text();
		expect(response.status, body).toBe(201);
		const staff = JSON.parse(body) as { id: string };
		staffIds.push(staff.id);
		let sessionId = "";
		await expect.poll(async () => {
			const current = await apiFetch(`/api/staff/${staff.id}`);
			if (!current.ok) return "";
			sessionId = (await current.json() as { currentSessionId?: string }).currentSessionId ?? "";
			return sessionId;
		}, { timeout: 15_000, intervals: [200, 400, 800] }).not.toBe("");
		return { id: staff.id, sessionId };
	}

	test("reloads one Awaiting consent card, opens it from Review, answers once, and leaves advisory inbox-only", async ({ page }) => {
		const staff = await createStaff();
		let answered = false;
		let promptPosts = 0;
		const projection = (status: "paused-awaiting-consent" | "resolved") => ({
			id: REQUEST_ID,
			sessionId: staff.sessionId,
			status,
			decisionClass: "consent-required",
			request: {
				title: "Protected browser operation",
				question: QUESTION,
				options: [{ value: "allow", label: "Allow protected work" }, { value: "deny", label: "Keep blocked" }],
			},
			...(status === "resolved" ? { resolution: { value: { kind: "option", value: "allow" } } } : {}),
		});

		await page.route(url => url.pathname === `/api/sessions/${staff.sessionId}/decision-requests`, async route => {
			if (route.request().method() !== "GET") return route.continue();
			await route.fulfill({ json: { requests: answered ? [] : [projection("paused-awaiting-consent")] } });
		});
		await page.route(url => url.pathname === `/api/sessions/${staff.sessionId}/decision-requests/${REQUEST_ID}/answer`, async route => {
			if (route.request().method() !== "POST") return route.continue();
			answered = true;
			await route.fulfill({ json: { request: projection("resolved") } });
		});
		await page.route(url => url.pathname === `/api/staff/${staff.id}/inbox`, async route => {
			if (route.request().method() !== "GET") return route.continue();
			await route.fulfill({ json: { entries: [
				{
					id: "consent-reference", staffId: staff.id, title: "Awaiting consent", prompt: QUESTION,
					state: "pending", wake: false, createdAt: Date.now(),
					source: { type: "consent_pause", sourceKey: `consent-pause:browser:${REQUEST_ID}`, requestId: REQUEST_ID, questionId: "question-browser" },
				},
				{
					id: "advisory-reference", staffId: staff.id, title: "Advisory only", prompt: "No interruption",
					state: "pending", wake: false, createdAt: Date.now(),
					source: { type: "extension_advisory", packId: "fixture", hookId: "notice" },
				},
			] } });
		});
		page.on("request", request => {
			if (request.method() === "POST" && request.url().includes(`/api/sessions/${staff.sessionId}/prompt`)) promptPosts++;
		});

		await openApp(page);
		await page.evaluate(sessionId => { window.location.hash = `#/session/${sessionId}`; }, staff.sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
		let card = page.locator(`[data-decision-request-id="${REQUEST_ID}"]`);
		await expect(card).toContainText("Consent required", { timeout: 15_000 });
		await expect(card).toContainText("Awaiting consent");
		await expect(card).toContainText(QUESTION);
		await expect(card).not.toContainText(/Default applied|Failed|protected work complete/i);
		await expect(card.locator("ask-user-choices-widget")).toHaveCount(1);

		// The durable projection remains actionable after a browser reload; it does
		// not become a prompt, failure banner, or defaulted decision.
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
		card = page.locator(`[data-decision-request-id="${REQUEST_ID}"]`);
		await expect(card).toContainText("Awaiting consent", { timeout: 15_000 });
		await expect(card).not.toContainText(/Default applied|Failed/i);

		await expect(page.locator('[data-testid="staff-inbox-open"]')).toBeVisible({ timeout: 20_000 });
		await page.locator('[data-testid="staff-inbox-open"]').click();
		const inboxTab = page.locator('[data-testid="inbox-tab-unified"], [data-testid="inbox-tab-pill"]').first();
		await expect(inboxTab).toBeVisible({ timeout: 10_000 });
		await inboxTab.click();
		const consentEntry = page.locator('inbox-entry-row[data-state="pending"]').filter({ hasText: "Awaiting consent" });
		await expect(consentEntry).toContainText("consent");
		await expect(consentEntry.locator(".inbox-review-consent-btn")).toHaveText("Review");
		await expect(page.locator('inbox-entry-row').filter({ hasText: "Advisory only" })).toBeVisible();
		await consentEntry.locator(".inbox-review-consent-btn").click();
		card = page.locator(`[data-decision-request-id="${REQUEST_ID}"]`);
		await expect(card).toBeFocused({ timeout: 5_000 });
		await expect(page.locator(`[data-decision-request-id="${REQUEST_ID}"]`), "Review focuses the shared card rather than creating another question").toHaveCount(1);

		await card.locator(".ask-option").filter({ hasText: "Allow protected work" }).click();
		await expect.poll(() => answered, { timeout: 10_000 }).toBe(true);
		await expect(card.locator(".ask-submit")).toHaveCount(0);
		expect(promptPosts).toBe(0);
	});
});
