/**
 * Browser smoke — jump-to-prompt controls mount in the real app and honor
 * mobile header geometry. The prompt-classification/action matrix lives in
 * `tests/ui-fixtures/chat-scroll.spec.ts` where DOM geometry is deterministic.
 */
import { test, expect } from "./fixtures.js";
import type { Page } from "@playwright/test";
import { waitForHealth, waitForSessionStatus, createSession } from "../e2e-setup.js";
import {
	SCROLL_SEL,
	disableScrollAnchoring,
	openTailSession,
	settleFrames,
} from "./tail-chat-helpers.js";

const UP_SEL = '[data-testid="jump-to-previous-prompt"]';
const BOTTOM_SEL = '[data-testid="jump-to-bottom"]';
const SPLIT_SEL = '[data-testid="jump-to-bottom-split"]';

interface ButtonState {
	upVisible: boolean;
	bottomVisible: boolean;
	splitPresent: boolean;
}

async function readButtonState(page: Page): Promise<ButtonState> {
	return await page.evaluate(
		({ upSel, bottomSel, splitSel }) => {
			const visible = (el: HTMLElement | null | undefined): boolean =>
				!!el && el.style.opacity === "1";
			const upEl = document.querySelector(upSel) as HTMLElement | null;
			const splitEl = document.querySelector(splitSel) as HTMLElement | null;
			const bottomEls = Array.from(document.querySelectorAll(bottomSel)) as HTMLElement[];
			const standalone = bottomEls.find((el) => !el.closest(splitSel));
			const inSplit = bottomEls.find((el) => el.closest(splitSel));
			return {
				upVisible: visible(upEl),
				bottomVisible: visible(standalone) || visible(inSplit),
				splitPresent: !!splitEl,
			};
		},
		{ upSel: UP_SEL, bottomSel: BOTTOM_SEL, splitSel: SPLIT_SEL },
	);
}

async function installSyntheticPromptGeometry(page: Page): Promise<void> {
	await page.evaluate((scrollSel) => {
		const root = document.querySelector("agent-interface message-list") as HTMLElement | null;
		const scroller = document.querySelector(scrollSel) as HTMLElement | null;
		const ai = document.querySelector("agent-interface") as (HTMLElement & { _refreshJumpButton?: () => void }) | null;
		if (!root || !scroller || !ai) throw new Error("chat DOM not ready");
		root.replaceChildren();
		for (let i = 0; i < 2; i++) {
			const filler = document.createElement("div");
			filler.style.height = `${i === 0 ? 180 : 760}px`;
			root.appendChild(filler);
			const prompt = document.createElement("user-message");
			prompt.setAttribute("data-smoke-prompt", String(i));
			prompt.textContent = `smoke prompt ${i + 1}`;
			prompt.style.display = "block";
			prompt.style.height = "56px";
			prompt.style.margin = "0 8px";
			prompt.style.padding = "12px";
			root.appendChild(prompt);
		}
		const tail = document.createElement("div");
		tail.style.height = "760px";
		root.appendChild(tail);
		scroller.scrollTop = scroller.scrollHeight;
		scroller.dispatchEvent(new Event("scroll"));
		ai._refreshJumpButton?.();
	}, SCROLL_SEL);
	await settleFrames(page, 2);
}

test.describe("jump-to-prompt controls (real app smokes)", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("empty transcript: controls are hidden", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		await openTailSession(page, sessionId);
		await disableScrollAnchoring(page);
		await settleFrames(page);

		const state = await readButtonState(page);
		expect(state.upVisible).toBe(false);
		expect(state.bottomVisible).toBe(false);
		expect(state.splitPresent).toBe(false);
	});

	test("mobile previous-prompt button and landing target clear fixed header", async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 667 });
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		await openTailSession(page, sessionId);
		await disableScrollAnchoring(page);
		await installSyntheticPromptGeometry(page);

		await expect
			.poll(async () => (await readButtonState(page)).upVisible, {
				timeout: 5_000,
				message: "up button visible after prompts scroll above mobile viewport",
			})
			.toBe(true);

		const buttonClearance = await page.evaluate((upSel) => {
			const header = document.getElementById("app-header") as HTMLElement | null;
			const button = document.querySelector(upSel) as HTMLElement | null;
			if (!header || !button) return null;
			const headerRect = header.getBoundingClientRect();
			const buttonRect = button.getBoundingClientRect();
			return {
				headerBottom: headerRect.bottom,
				buttonTop: buttonRect.top,
				centerX: buttonRect.left + buttonRect.width / 2,
				centerY: buttonRect.top + buttonRect.height / 2,
				styleTop: button.style.top,
			};
		}, UP_SEL);
		expect(buttonClearance).not.toBeNull();
		expect(buttonClearance!.styleTop).toContain("--mobile-header-height");
		expect(buttonClearance!.buttonTop).toBeGreaterThan(buttonClearance!.headerBottom + 8);

		await page.mouse.click(buttonClearance!.centerX, buttonClearance!.centerY);
		await expect
			.poll(async () => {
				return await page.evaluate(({ scrollSel }) => {
					const header = document.getElementById("app-header") as HTMLElement | null;
					const secondPrompt = document.querySelector('user-message[data-smoke-prompt="1"]') as HTMLElement | null;
					const scroller = document.querySelector(scrollSel) as HTMLElement | null;
					if (!header || !secondPrompt || !scroller) return -9999;
					return Math.round(secondPrompt.getBoundingClientRect().top - header.getBoundingClientRect().bottom);
				}, { scrollSel: SCROLL_SEL });
			}, {
				timeout: 5_000,
				message: "jump target should land below fixed mobile header",
			})
			.toBeGreaterThan(8);
	});
});
