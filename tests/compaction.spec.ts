/**
 * Real-LLM e2e for context compaction. Runs under `tests/playwright-e2e.config.ts`
 * (port 3097, isolated BOBBIT_DIR=.e2e-real-bobbit). Invoked by:
 *
 *   npm run test:e2e:real
 *
 * Flow:
 *   1. Knock down the default model's contextWindow via models.json so the
 *      real-LLM session faces a tiny cap (cheap, reliable pressure).
 *   2. Create project + session via REST against the isolated gateway.
 *   3. Drive prompts via the UI to fill the context near the cap.
 *   4. Submit `/compact`.
 *   5. Assert the bobbit blob enters compact-shake / compacting state, then
 *      the rich compaction-summary card appears in the transcript.
 *   6. Persistence across session-nav and page-reload.
 *
 * No sleeps; every wait is selector-anchored. The card's "after" token count
 * is intentionally not asserted (model-dependent).
 *
 * See docs/design/compaction-e2e-rich-summary.md §3.1.
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const BOBBIT_DIR = join(PROJECT_ROOT, ".e2e-real-bobbit");
const AGENT_DIR = join(BOBBIT_DIR, "agent");
const MODELS_JSON = join(AGENT_DIR, "models.json");

async function readToken(): Promise<string> {
	const tp = join(BOBBIT_DIR, "state", "token");
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (existsSync(tp)) {
			const t = readFileSync(tp, "utf-8").trim();
			if (t.length > 0) return t;
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(`No token at ${tp} after 30s`);
}

/**
 * Force a small context window on every Anthropic model so the real-LLM
 * session reaches the cap after 1–2 prompts. The gateway writes its own
 * models.json on boot; we patch it post-boot and rely on the per-session
 * re-read. Same pattern as `tests/manual-integration/compaction-pressure.spec.ts`.
 */
async function knockDownContextWindow(targetWindow: number) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (existsSync(MODELS_JSON)) break;
		await new Promise((r) => setTimeout(r, 200));
	}
	if (!existsSync(MODELS_JSON)) {
		mkdirSync(AGENT_DIR, { recursive: true });
		writeFileSync(MODELS_JSON, JSON.stringify({ providers: {} }, null, 2));
	}
	const data = JSON.parse(readFileSync(MODELS_JSON, "utf-8"));
	data.providers = data.providers || {};
	for (const providerId of Object.keys(data.providers)) {
		const overrides = data.providers[providerId].modelOverrides
			|| (data.providers[providerId].modelOverrides = {});
		for (const modelId of Object.keys(overrides)) {
			overrides[modelId] = {
				...(overrides[modelId] || {}),
				contextWindow: targetWindow,
			};
		}
	}
	writeFileSync(MODELS_JSON, JSON.stringify(data, null, 2));
}

const BASE_API = "http://localhost:3097";

async function api(token: string, path: string, init: RequestInit = {}) {
	return fetch(`${BASE_API}${path}`, {
		...init,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
			...(init.headers as Record<string, string> || {}),
		},
	});
}

async function createProject(token: string): Promise<string> {
	const res = await api(token, "/api/projects", {
		method: "POST",
		body: JSON.stringify({ name: "compaction-e2e", rootPath: PROJECT_ROOT }),
	});
	if (res.status !== 201 && res.status !== 200 && res.status !== 409) {
		throw new Error(`createProject failed: ${res.status} ${await res.text()}`);
	}
	if (res.status === 409) {
		const list = await (await api(token, "/api/projects")).json();
		const p = (list?.projects || list || []).find((x: any) => x.rootPath === PROJECT_ROOT);
		if (!p) throw new Error("project conflict but no match in list");
		return p.id;
	}
	const body = await res.json();
	return body.id;
}

async function createSession(token: string, projectId: string): Promise<string> {
	const res = await api(token, "/api/sessions", {
		method: "POST",
		body: JSON.stringify({ projectId }),
	});
	if (res.status !== 201) {
		throw new Error(`createSession failed: ${res.status} ${await res.text()}`);
	}
	const body = await res.json();
	return body.id;
}

async function deleteSession(token: string, id: string) {
	try { await api(token, `/api/sessions/${id}`, { method: "DELETE" }); } catch { /* ignore */ }
}

async function pollIdle(token: string, id: string, ms = 60_000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const res = await api(token, `/api/sessions/${id}`);
		if (res.ok) {
			const s = await res.json();
			if (s.status === "idle") return s;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`Session ${id} not idle in ${ms}ms`);
}

async function sendPrompt(page: Page, text: string) {
	const textarea = page.locator("textarea").first();
	await textarea.waitFor({ state: "visible", timeout: 15_000 });
	await textarea.fill(text);
	await textarea.press("Enter");
}

test.describe.configure({ mode: "serial" });

mkdirSync(BOBBIT_DIR, { recursive: true });

test("compaction — real LLM @real", async ({ page }) => {
	test.setTimeout(360_000);
	const token = await readToken();
	// 16k window — small enough that 2 prompts of ~2k filler each push past
	// the soft cap on most models, but generous enough that the prompts
	// themselves are accepted.
	await knockDownContextWindow(16_000);
	const projectId = await createProject(token);
	const sessionId = await createSession(token, projectId);
	const otherSessionId = await createSession(token, projectId);
	await pollIdle(token, sessionId);
	await pollIdle(token, otherSessionId);

	const consoleErrors: string[] = [];
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(m.text());
	});

	try {
		await page.goto(`/?token=${token}#/session/${sessionId}`);
		await page.waitForSelector("textarea", { timeout: 30_000 });

		// Two large prompts to push context up. Real model — keep payload bounded.
		const FILLER = "Please remember the following inert filler block exactly: "
			+ "x".repeat(2000);
		await sendPrompt(page, FILLER + "\n\nWhat does Bobbit do?");
		await pollIdle(token, sessionId, 120_000);
		await sendPrompt(page, FILLER + "\n\nSummarise your previous answer in one sentence.");
		await pollIdle(token, sessionId, 120_000);

		// Trigger /compact.
		await sendPrompt(page, "/compact");

		// Blob enters compact-shake then compacting. StreamingMessageContainer
		// (src/ui/components/StreamingMessageContainer.ts:83–84) sets these
		// classes; either is acceptable evidence of the compaction animation.
		await expect(
			page.locator(".bobbit-blob--compact-shake, .bobbit-blob--compacting"),
		).toBeVisible({ timeout: 30_000 });

		// Rich card renders.
		const card = page.locator("[data-testid='compaction-summary-card']").first();
		await expect(card).toBeVisible({ timeout: 120_000 });
		await expect(card.getByText("Context compacted")).toBeVisible();
		await expect(card.locator("[data-test='trigger']")).toHaveText(/manual|auto/);

		// No error indicators in the transcript. Bobbit surfaces errors via
		// <error-details> with data-testid='error-details-message' (see
		// src/ui/components/ErrorDetails.ts:26). A successful compaction must
		// not produce any such row.
		await expect(
			page.locator("[data-testid='error-details-message']"),
		).toHaveCount(0);
		expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);

		// Persistence across session navigation.
		await page.goto(`/?token=${token}#/session/${otherSessionId}`);
		await page.waitForSelector("textarea", { timeout: 30_000 });
		await page.goto(`/?token=${token}#/session/${sessionId}`);
		await expect(card).toBeVisible({ timeout: 30_000 });

		// Persistence across reload. Reload-path materialises a rich synthetic
		// from the server's plain-text marker; `tokens-before` must be present.
		await page.reload();
		await expect(card).toBeVisible({ timeout: 30_000 });
		await expect(card.locator("[data-test='tokens-before']")).toContainText(/tok/);
	} finally {
		await deleteSession(token, sessionId);
		await deleteSession(token, otherSessionId);
	}
});
