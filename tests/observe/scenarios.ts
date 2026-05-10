/**
 * Human-like scenarios. Each scenario is a sequence of actions invoked
 * against a Page wrapped by an Observer. The Observer takes before/after
 * screenshots automatically — scenarios just call `act(name, fn)`.
 */
import type { Page } from "@playwright/test";
import type { Observer } from "./observer.ts";

export type ActFn = (name: string, fn: () => Promise<void>) => Promise<void>;

export interface ScenarioCtx {
	page: Page;
	observer: Observer;
	act: ActFn;
	gatewayUrl: string;
	token: string;
}

export interface Scenario {
	name: string;
	description: string;
	run: (ctx: ScenarioCtx) => Promise<void>;
}

async function openApp(page: Page, gatewayUrl: string, token: string): Promise<void> {
	await page.goto(`${gatewayUrl}/?token=${encodeURIComponent(token)}`);
	// Wait for sidebar to render.
	await page
		.locator("button")
		.filter({ hasText: /Settings/ })
		.first()
		.waitFor({ state: "visible", timeout: 30_000 });
}

async function newSession(page: Page): Promise<void> {
	await page.locator("button[title^='New session']").first().click();
	await page.locator("textarea").first().waitFor({ state: "visible", timeout: 30_000 });
}

async function sendPrompt(page: Page, text: string): Promise<void> {
	const ta = page.locator("textarea").first();
	await ta.fill(text);
	await ta.press("Enter");
}

/** Wait until session.status leaves streaming/pending OR until timeout. */
async function waitForIdle(page: Page, timeoutMs: number): Promise<"idle" | "timeout"> {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		const status = await page
			.evaluate(() => {
				const s = (window as any).bobbitState;
				return s?.status ?? s?.session?.status ?? null;
			})
			.catch(() => null);
		if (status && status !== "streaming" && status !== "pending" && status !== "preparing")
			return "idle";
		await page.waitForTimeout(500);
	}
	return "timeout";
}

const basic: Scenario = {
	name: "basic",
	description: "Open app, create session, send 3 prompts sequentially.",
	async run({ page, act, gatewayUrl, token }) {
		await act("open-app", () => openApp(page, gatewayUrl, token));
		await act("new-session", () => newSession(page));
		const prompts = [
			"Say hello, then run `pwd` using the bash tool.",
			"List the files in the current directory.",
			"Summarise what you just did in two short bullets.",
		];
		for (let i = 0; i < prompts.length; i++) {
			await act(`send-${i + 1}`, () => sendPrompt(page, prompts[i]));
			await act(`wait-idle-${i + 1}`, async () => {
				await waitForIdle(page, 180_000);
			});
		}
	},
};

const rapidFire: Scenario = {
	name: "rapid-fire",
	description: "Queue 4 prompts back-to-back; stresses message ordering.",
	async run({ page, act, gatewayUrl, token }) {
		await act("open-app", () => openApp(page, gatewayUrl, token));
		await act("new-session", () => newSession(page));
		const prompts = [
			"Print the literal string FIRST and stop.",
			"Print the literal string SECOND and stop.",
			"Print the literal string THIRD and stop.",
			"Print the literal string FOURTH and stop.",
		];
		for (let i = 0; i < prompts.length; i++) {
			await act(`queue-${i + 1}`, () => sendPrompt(page, prompts[i]));
			// short pause — humans type fast but not instant
			await page.waitForTimeout(800);
		}
		await act("drain", async () => {
			await waitForIdle(page, 240_000);
		});
	},
};

const interrupt: Scenario = {
	name: "interrupt",
	description: "Send a long task, abort mid-stream, then send another prompt.",
	async run({ page, act, gatewayUrl, token }) {
		await act("open-app", () => openApp(page, gatewayUrl, token));
		await act("new-session", () => newSession(page));
		await act("send-long", () =>
			sendPrompt(
				page,
				"Use the bash tool to run: sleep 30 && echo done. Wait for it to finish.",
			),
		);
		// Let it actually start.
		await page.waitForTimeout(5_000);
		await act("click-stop", async () => {
			const stop = page.locator('button[title="Stop streaming"]');
			if ((await stop.count()) > 0) await stop.first().click();
		});
		await act("wait-idle-after-stop", async () => {
			await waitForIdle(page, 30_000);
		});
		await act("send-followup", () => sendPrompt(page, "Confirm you stopped, in one line."));
		await act("wait-idle-final", async () => {
			await waitForIdle(page, 60_000);
		});
	},
};

export const SCENARIOS: Record<string, Scenario> = {
	basic,
	"rapid-fire": rapidFire,
	interrupt,
};
