import type { Locator, Page } from "@playwright/test";
import {
	createSession,
	deleteSession,
	expect,
	navigateToHash,
	openApp,
	sendMessage,
	test,
	waitForAgentResponse,
	waitForSessionStatus,
} from "../../../tests2/browser/_helpers/journey-fixture.js";

const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 320, height: 720 };
const TARGET = 100_000;
const CAPACITY = 400_000;

type ContextScenario = {
	usage: number;
	target: number;
	capacity?: number;
	stale?: boolean;
};

function statsBar(page: Page): Locator {
	return page.getByTestId("session-stats-bar");
}

function contextTrigger(page: Page): Locator {
	return statsBar(page).getByTestId("context-meter-trigger");
}

function footerTrack(page: Page): Locator {
	return contextTrigger(page).getByTestId("context-meter-track");
}

function popover(page: Page): Locator {
	return page.locator(".context-popover");
}

async function renderContextScenario(page: Page, scenario: ContextScenario): Promise<void> {
	await page.evaluate(async ({ usage, target, capacity, stale }) => {
		const win = window as any;
		const appState = win.bobbitState ?? win.__bobbitState;
		const agent = appState?.remoteAgent;
		const agentInterface = appState?.chatPanel?.agentInterface;
		if (!agent?.state?.model || !agentInterface) {
			throw new Error("active session context UI is unavailable");
		}

		agent.state.model.contextWindow = target;
		if (capacity === undefined) delete agent.state.model.modelCapacity;
		else agent.state.model.modelCapacity = capacity;

		const assistant = [...agent.state.messages].reverse().find((message: any) =>
			message.role === "assistant"
				&& message.usage
				&& message.stopReason !== "aborted"
				&& message.stopReason !== "error",
		);
		if (!assistant) throw new Error("journey requires one completed assistant turn with usage");
		assistant.usage = {
			...assistant.usage,
			input: usage,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: usage,
			cost: { ...(assistant.usage.cost ?? {}), total: assistant.usage.cost?.total ?? 0 },
		};

		agent._usageStaleAfterCompaction = stale === true;
		agent._compactionStartPct = stale
			? Math.min(100, Math.round((usage / (capacity && capacity > target ? capacity : target)) * 100))
			: null;
		agentInterface.requestUpdate();
		await agentInterface.updateComplete;
	}, scenario);
}

async function segmentWidth(track: Locator, testId: string): Promise<number> {
	return track.getByTestId(testId).evaluate((element) => Number.parseFloat((element as HTMLElement).style.width) || 0);
}

async function expectFooterGeometry(page: Page): Promise<void> {
	const box = await footerTrack(page).boundingBox();
	expect(box).not.toBeNull();
	expect(box!.width).toBeCloseTo(48, 0);
	expect(box!.height).toBeCloseTo(6, 0);
}

async function closeContextPopover(page: Page): Promise<void> {
	if (await popover(page).isVisible().catch(() => false)) {
		await page.keyboard.press("Escape");
		await expect(popover(page)).toHaveCount(0);
	}
}

async function expectTrackUsesInputSurface(track: Locator, dark: boolean): Promise<void> {
	const colors = await track.evaluate((element, darkMode) => {
		document.documentElement.classList.toggle("dark", darkMode);
		const probe = document.createElement("span");
		probe.style.cssText = [
			"position:fixed",
			"visibility:hidden",
			"background:var(--input)",
			"color:var(--background)",
			"border-color:var(--popover)",
		].join(";");
		document.body.appendChild(probe);
		const result = {
			track: getComputedStyle(element).backgroundColor,
			input: getComputedStyle(probe).backgroundColor,
			background: getComputedStyle(probe).color,
			popover: getComputedStyle(probe).borderColor,
		};
		probe.remove();
		return result;
	}, dark);
	expect(colors.track, `${dark ? "dark" : "light"} track should resolve to var(--input)`).toBe(colors.input);
	expect(colors.track, `${dark ? "dark" : "light"} track should differ from the footer background`).not.toBe(colors.background);
	expect(colors.track, `${dark ? "dark" : "light"} track should differ from the popover surface`).not.toBe(colors.popover);
}

test.describe("Journey: Context target and model capacity", () => {
	test("keeps the capacity-scaled meter honest through zones, fallbacks, compaction, responsive layout, and reload", async ({ page }) => {
		test.setTimeout(120_000);
		const sessionId = await createSession();
		try {
			await page.setViewportSize(DESKTOP);
			await Promise.all([openApp(page), waitForSessionStatus(sessionId, "idle")]);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			await sendMessage(page, "Context capacity browser journey");
			await waitForAgentResponse(page);
			await waitForSessionStatus(sessionId, "idle");

			// Below 75% of target: scale and displayed percentage use hard capacity.
			await renderContextScenario(page, { usage: 50_000, target: TARGET, capacity: CAPACITY });
			const trigger = contextTrigger(page);
			await expect(trigger).toBeVisible();
			await expect(trigger).toHaveAttribute("aria-label", "Context: 50k / 400k tokens (13% of model capacity); soft limit 100k tokens");
			await expect(trigger).toHaveAttribute("aria-expanded", "false");
			await expectFooterGeometry(page);
			await expect(footerTrack(page).getByTestId("context-meter-target-marker")).toHaveAttribute("style", /left:\s*25%/);
			expect(await segmentWidth(footerTrack(page), "context-meter-primary")).toBeCloseTo(12.5, 3);
			expect(await segmentWidth(footerTrack(page), "context-meter-warning")).toBe(0);
			expect(await segmentWidth(footerTrack(page), "context-meter-negative")).toBe(0);

			// The native button opens the retained compact popover from the keyboard.
			await trigger.focus();
			await page.keyboard.press("Enter");
			await expect(popover(page)).toBeVisible();
			await expect(trigger).toHaveAttribute("aria-expanded", "true");
			await expect(popover(page)).toContainText("Soft limit");
			await expect(popover(page)).toContainText("100k tokens");
			await expect(popover(page)).toContainText("Model capacity");
			await expect(popover(page)).toContainText("400k tokens");
			await expect(popover(page)).toContainText("50k / 400k tokens");
			await expect(popover(page).getByTestId("context-meter-scale")).toContainText("Soft limit 100k");
			await expect(popover(page).getByTestId("context-meter-scale")).toContainText("Capacity 400k");
			await expectTrackUsesInputSurface(footerTrack(page), false);
			await expectTrackUsesInputSurface(popover(page).getByTestId("context-meter-track"), false);
			await expectTrackUsesInputSurface(footerTrack(page), true);
			await expectTrackUsesInputSurface(popover(page).getByTestId("context-meter-track"), true);
			await closeContextPopover(page);

			// Within the final 25% of target, exactly at target, beyond target, and near capacity.
			await renderContextScenario(page, { usage: 90_000, target: TARGET, capacity: CAPACITY });
			expect(await segmentWidth(footerTrack(page), "context-meter-warning")).toBeGreaterThan(0);
			expect(await segmentWidth(footerTrack(page), "context-meter-negative")).toBe(0);

			await renderContextScenario(page, { usage: TARGET, target: TARGET, capacity: CAPACITY });
			await expect(contextTrigger(page)).toContainText("25%");
			expect(await segmentWidth(footerTrack(page), "context-meter-negative")).toBe(0);

			await renderContextScenario(page, { usage: 110_000, target: TARGET, capacity: CAPACITY });
			expect(await segmentWidth(footerTrack(page), "context-meter-negative")).toBeGreaterThan(0);

			await renderContextScenario(page, { usage: 390_000, target: TARGET, capacity: CAPACITY });
			await expect(contextTrigger(page)).toContainText("98%");
			expect(await segmentWidth(footerTrack(page), "context-meter-negative")).toBeCloseTo(72.5, 3);
			await expect(contextTrigger(page)).toHaveAttribute("aria-label", "Context: 390k / 400k tokens (98% of model capacity); soft limit 100k tokens");

			// Equal and absent capacity honestly collapse to the existing single-limit treatment.
			await renderContextScenario(page, { usage: 50_000, target: TARGET, capacity: TARGET });
			await expect(footerTrack(page).getByTestId("context-meter-target-marker")).toHaveCount(0);
			await contextTrigger(page).click();
			await expect(popover(page)).toContainText("Context window");
			await expect(popover(page)).not.toContainText("Soft limit");
			await expect(popover(page)).not.toContainText("Model capacity");
			await expect(popover(page).getByTestId("context-meter-scale")).toHaveCount(0);
			await closeContextPopover(page);

			await renderContextScenario(page, { usage: 50_000, target: TARGET });
			await expect(contextTrigger(page)).toContainText("50%");
			await expect(footerTrack(page).getByTestId("context-meter-target-marker")).toHaveCount(0);

			// Stale post-compaction state hides old usage while retaining known limits and marker.
			await renderContextScenario(page, { usage: 110_000, target: TARGET, capacity: CAPACITY, stale: true });
			await expect(footerTrack(page)).toHaveAttribute("aria-busy", "true");
			await expect(contextTrigger(page)).toContainText("-%");
			await expect(contextTrigger(page)).toHaveAttribute("aria-label", /Context usage refreshing after compaction/);
			await expect(footerTrack(page)).toHaveClass(/context-bar-shimmer/);
			await expect(footerTrack(page).getByTestId("context-meter-target-marker")).toHaveCount(1);
			await contextTrigger(page).click();
			await expect(popover(page)).toContainText("Updating after compaction");
			await expect(popover(page)).not.toContainText("Last Turn");
			await closeContextPopover(page);

			await renderContextScenario(page, { usage: 50_000, target: TARGET, capacity: CAPACITY });
			await expect(footerTrack(page)).toHaveAttribute("aria-busy", "false");
			await expect(contextTrigger(page)).toContainText("13%");

			// Existing 320px breakpoint keeps the fixed-size footer meter and popover on-screen.
			await page.setViewportSize(MOBILE);
			await expect(contextTrigger(page)).toBeVisible();
			await expectFooterGeometry(page);
			await contextTrigger(page).click();
			await expect(popover(page)).toBeVisible();
			const narrowGeometry = await popover(page).evaluate((element) => {
				const rect = element.getBoundingClientRect();
				return {
					left: rect.left,
					right: rect.right,
					viewport: window.innerWidth,
					documentWidth: document.documentElement.scrollWidth,
				};
			});
			expect(narrowGeometry.left).toBeGreaterThanOrEqual(0);
			expect(narrowGeometry.right).toBeLessThanOrEqual(narrowGeometry.viewport);
			expect(narrowGeometry.documentWidth).toBeLessThanOrEqual(narrowGeometry.viewport);
			await closeContextPopover(page);

			// Reload replaces the injected dual metadata with the mock model's authoritative
			// target-only state; it must remain readable without fabricating capacity.
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			await expect(contextTrigger(page)).toBeVisible({ timeout: 20_000 });
			await expectFooterGeometry(page);
			await expect(footerTrack(page).getByTestId("context-meter-target-marker")).toHaveCount(0);
			await contextTrigger(page).click();
			await expect(popover(page)).toContainText("Context window");
			await expect(popover(page)).not.toContainText("Model capacity");
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
