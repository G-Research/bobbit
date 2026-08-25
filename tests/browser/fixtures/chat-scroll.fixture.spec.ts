import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/chat-scroll-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "chat-scroll-bundle.js");
const AGENT_INTERFACE_SRC = path.resolve("src/ui/components/AgentInterface.ts");

const SCROLL_SEL = "agent-interface .overflow-y-auto";
const JUMP_SEL = '[data-testid="jump-to-bottom"]';
const MSG_SEL = "[data-message-probe]";
const CHAT_MSG_SEL = "user-message, assistant-message, tool-message";
const TAIL_PX = 8;

const TALL_IMAGE_DATA_URI = (() => {
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000" viewBox="0 0 800 1000">` +
		`<rect width="100%" height="100%" fill="#fcc"/>` +
		`<text x="400" y="500" text-anchor="middle" font-size="48" fill="#600">tail-chat reflow probe</text>` +
		`</svg>`;
	return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
})();

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, AGENT_INTERFACE_SRC],
	});
});

async function loadFixture(page: Page): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__chatScrollReady === true, null, { timeout: 10_000 });
	await page.evaluate(() => (window as any).__mountChatScrollFixture());
	await page.waitForSelector(SCROLL_SEL, { timeout: 10_000 });
}

async function settleFrames(page: Page, frames = 2): Promise<void> {
	await page.evaluate((n) => new Promise<void>((resolve) => {
		const step = (remaining: number) => {
			if (remaining <= 0) resolve();
			else requestAnimationFrame(() => step(remaining - 1));
		};
		step(n);
	}), frames);
}

async function installSpacer(page: Page, opts: { probe?: boolean } = {}): Promise<void> {
	await page.evaluate(({ probe }) => {
		const content = document.querySelector("agent-interface .max-w-5xl") as HTMLElement | null;
		if (!content) throw new Error("messages content container not found");
		const spacer = document.createElement("div");
		spacer.id = "__tail_chat_pre_spacer";
		spacer.style.height = "5000px";
		content.insertBefore(spacer, content.firstChild);
		if (probe) {
			const msg = document.createElement("div");
			msg.setAttribute("data-message-probe", "tail");
			msg.style.display = "block";
			msg.style.height = "80px";
			msg.style.margin = "8px";
			msg.style.padding = "12px";
			msg.style.background = "#cef";
			msg.textContent = "tail-chat probe";
			content.appendChild(msg);
		}
		const el = document.querySelector("agent-interface .overflow-y-auto") as HTMLElement;
		el.scrollTop = el.scrollHeight;
		el.dispatchEvent(new Event("scroll"));
	}, opts);
	await settleFrames(page);
}

async function scrollMetrics(page: Page): Promise<{ distance: number; overflow: number; clientHeight: number; scrollTop: number; scrollHeight: number }> {
	return await page.evaluate((sel) => {
		const el = document.querySelector(sel) as HTMLElement;
		return {
			distance: el.scrollHeight - el.scrollTop - el.clientHeight,
			overflow: el.scrollHeight - el.clientHeight,
			clientHeight: el.clientHeight,
			scrollTop: el.scrollTop,
			scrollHeight: el.scrollHeight,
		};
	}, SCROLL_SEL);
}

async function latestPinProbe(page: Page, selector: string): Promise<
	| { ok: false; error: string }
	| {
		ok: boolean;
		distance: number;
		belowFold: number;
		scrollTop: number;
		scrollHeight: number;
		clientHeight: number;
		lastHeight: number;
	}
> {
	return await page.evaluate(({ scrollSel, msgSel, tailPx }) => {
		const el = document.querySelector(scrollSel) as HTMLElement | null;
		const msgs = Array.from(document.querySelectorAll(msgSel)) as HTMLElement[];
		if (!el || msgs.length === 0) return { ok: false, error: "missing scroll container or message" } as const;
		const last = msgs[msgs.length - 1];
		const er = el.getBoundingClientRect();
		const lr = last.getBoundingClientRect();
		const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
		const belowFold = lr.bottom - er.bottom;
		return {
			ok: distance <= tailPx && belowFold <= tailPx,
			distance,
			belowFold,
			scrollTop: el.scrollTop,
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
			lastHeight: lr.height,
		} as const;
	}, { scrollSel: SCROLL_SEL, msgSel: selector, tailPx: TAIL_PX });
}

async function expectLatestSelectorPinned(page: Page, selector: string, label: string): Promise<void> {
	await expect.poll(async () => {
		const probe = await latestPinProbe(page, selector);
		if ("error" in probe) return probe.error;
		if (probe.ok) return "pinned";
		return `dist=${Math.round(probe.distance)} below=${Math.round(probe.belowFold)} ` +
			`scrollTop=${Math.round(probe.scrollTop)} scrollHeight=${probe.scrollHeight}`;
	}, {
		message: `${label}: latest message should settle pinned to the scroll viewport`,
		timeout: 5_000,
	}).toBe("pinned");

	const probe = await latestPinProbe(page, selector);
	if ("error" in probe) throw new Error(probe.error);
	expect(
		probe.distance,
		`${label}: scroll viewport not pinned; dist=${Math.round(probe.distance)} ` +
		`scrollTop=${Math.round(probe.scrollTop)} scrollHeight=${probe.scrollHeight}`,
	).toBeLessThanOrEqual(TAIL_PX);
	expect(
		probe.belowFold,
		`${label}: latest message bottom ${Math.round(probe.belowFold)} px below viewport; ` +
		`lastHeight=${Math.round(probe.lastHeight)} clientHeight=${probe.clientHeight}`,
	).toBeLessThanOrEqual(TAIL_PX);
}

async function expectLatestProbePinned(page: Page, label: string): Promise<void> {
	await expectLatestSelectorPinned(page, MSG_SEL, label);
}

async function expectLatestChatMessagePinned(page: Page, label: string): Promise<void> {
	await expectLatestSelectorPinned(page, CHAT_MSG_SEL, label);
}

async function releaseToHistory(page: Page, distanceRatio = 0.65): Promise<void> {
	await page.evaluate(({ scrollSel, ratio }) => {
		const el = document.querySelector(scrollSel) as HTMLElement;
		el.dispatchEvent(new WheelEvent("wheel", { deltaY: -800, bubbles: true }));
		el.scrollTop = el.scrollHeight - el.clientHeight - Math.floor(el.clientHeight * ratio);
		el.dispatchEvent(new Event("scroll", { bubbles: true }));
	}, { scrollSel: SCROLL_SEL, ratio: distanceRatio });
	await settleFrames(page, 2);
}

async function jumpOpacity(page: Page): Promise<{ opacity: string; pointerEvents: string }> {
	return await page.evaluate((sel) => {
		const btn = document.querySelector(sel) as HTMLElement | null;
		if (!btn) return { opacity: "missing", pointerEvents: "missing" };
		return { opacity: btn.style.opacity, pointerEvents: btn.style.pointerEvents };
	}, JUMP_SEL);
}

test.describe("AgentInterface chat scroll fixture", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
	});

	test("Jump-to-bottom appears after explicit scroll-up, hides near bottom, clicks back to tail, and unmounts cleanly", async ({ page }) => {
		const consoleErrors: string[] = [];
		page.on("console", (msg) => {
			if (msg.type() === "error") consoleErrors.push(msg.text());
		});

		await installSpacer(page);
		const pre = await scrollMetrics(page);
		expect(pre.overflow).toBeGreaterThan(2000);
		expect(pre.distance).toBeLessThanOrEqual(TAIL_PX);
		await expect.poll(() => jumpOpacity(page), { timeout: 5_000 }).toEqual({ opacity: "0", pointerEvents: "none" });

		await releaseToHistory(page, 0.6);
		await expect.poll(() => jumpOpacity(page), { timeout: 5_000 }).toEqual({ opacity: "1", pointerEvents: "auto" });
		await page.locator(JUMP_SEL).click({ force: true });
		await page.waitForFunction((sel) => {
			const el = document.querySelector(sel) as HTMLElement | null;
			return !!el && el.scrollHeight - el.scrollTop - el.clientHeight <= 5;
		}, SCROLL_SEL, { timeout: 5_000 });

		await page.evaluate(() => document.querySelector("agent-interface")?.remove());
		await settleFrames(page);
		const real = consoleErrors.filter((e) => !/favicon|net::|404 \(Not Found\)|400 \(Bad Request\)|websocket|status of 400/i.test(e));
		expect(real, `unexpected console errors after unmount: ${real.join(" | ")}`).toHaveLength(0);
	});

	test("state_update replay/remount paths render logical-clock transcripts pinned to the latest message", async ({ page }) => {
		await page.evaluate(() => (window as any).__chatScrollFixture.replaceTranscript("replay-a", 36));
		await page.getByText("Assistant replay-a 36").waitFor({ timeout: 10_000 });
		await settleFrames(page, 4);
		await expectLatestChatMessagePinned(page, "initial replay");

		const firstTail = await page.evaluate(() =>
			Array.from(document.querySelectorAll("user-message, assistant-message")).at(-1)?.textContent?.trim() ?? "",
		);
		expect(firstTail).toContain("Assistant replay-a 36");

		await page.evaluate(() => (window as any).__mountChatScrollFixture({ prefix: "replay-b", turns: 24 }));
		await page.getByText("Assistant replay-b 24").waitFor({ timeout: 10_000 });
		await settleFrames(page, 4);
		await expectLatestChatMessagePinned(page, "remount replay");

		const remountTail = await page.evaluate(() =>
			Array.from(document.querySelectorAll("user-message, assistant-message")).at(-1)?.textContent?.trim() ?? "",
		);
		expect(remountTail).toContain("Assistant replay-b 24");
	});

	test("explicit user intent releases tail lock; jump-to-bottom recovery tracks deterministic streaming growth", async ({ page }) => {
		await page.evaluate(() => (window as any).__chatScrollFixture.replaceTranscript("release", 34));
		await page.getByText("Assistant release 34").waitFor({ timeout: 10_000 });
		await settleFrames(page, 4);
		await expectLatestChatMessagePinned(page, "pre-release");

		await releaseToHistory(page, 0.7);
		await expect.poll(() => jumpOpacity(page), { timeout: 5_000 }).toEqual({ opacity: "1", pointerEvents: "auto" });
		const released = await scrollMetrics(page);
		expect(released.distance, "wheel-up should move viewport far enough from the bottom").toBeGreaterThan(released.clientHeight * 0.5);

		await page.evaluate(() => (window as any).__chatScrollFixture.updateStreaming("release", 80));
		await settleFrames(page, 4);
		const duringStream = await scrollMetrics(page);
		expect(
			duringStream.distance,
			"streaming growth after user release must not pull the viewport back to tail",
		).toBeGreaterThan(duringStream.clientHeight * 0.5);

		await page.locator(JUMP_SEL).click({ force: true });
		await page.waitForFunction((sel) => {
			const el = document.querySelector(sel) as HTMLElement | null;
			return !!el && el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
		}, SCROLL_SEL, { timeout: 5_000 });
		await settleFrames(page, 2);
		await expectLatestChatMessagePinned(page, "after jump recovery");

		await page.evaluate(() => (window as any).__chatScrollFixture.updateStreaming("release", 140));
		await settleFrames(page, 4);
		await expectLatestChatMessagePinned(page, "post-recovery streaming growth");
		await page.evaluate(() => (window as any).__chatScrollFixture.finishStreaming("release"));
		await settleFrames(page, 4);
		await expectLatestChatMessagePinned(page, "finished stream");
		await expect.poll(() => jumpOpacity(page), { timeout: 5_000 }).toEqual({ opacity: "0", pointerEvents: "none" });
	});

	test("near-bottom relock and tool-result details reflow keep latest probe pinned", async ({ page }) => {
		await installSpacer(page, { probe: true });
		const pre = await scrollMetrics(page);
		expect(pre.overflow).toBeGreaterThan(2000);

		await page.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			el.dispatchEvent(new WheelEvent("wheel", { deltaY: -30, bubbles: true }));
			el.scrollTop = el.scrollHeight - el.clientHeight - 30;
			el.dispatchEvent(new Event("scroll", { bubbles: true }));
		}, SCROLL_SEL);
		await settleFrames(page);
		const afterWheel = await scrollMetrics(page);
		expect(afterWheel.distance, `30 px wheel-up should stay inside relock band`).toBeLessThan(120);

		await page.evaluate(() => {
			const probe = document.querySelector("[data-message-probe='tail']") as HTMLElement;
			probe.style.height = "280px";
		});
		await page.waitForFunction((sel) => {
			const el = document.querySelector(sel) as HTMLElement | null;
			return !!el && el.scrollHeight - el.scrollTop - el.clientHeight <= 12;
		}, SCROLL_SEL, { timeout: 5_000 });
		await expectLatestProbePinned(page, "near-bottom growth relock");

		await page.evaluate((sel) => {
			const content = document.querySelector("agent-interface .max-w-5xl") as HTMLElement;
			const card = document.createElement("div");
			card.setAttribute("data-message-probe", "details");
			card.style.display = "block";
			card.style.margin = "8px";
			card.style.padding = "12px";
			card.style.background = "#ecfeff";
			const details = document.createElement("details");
			const summary = document.createElement("summary");
			summary.id = "__details_summary";
			summary.textContent = "bash output (click to expand)";
			const inner = document.createElement("div");
			inner.style.height = "400px";
			inner.textContent = "expanded body — 400 px";
			details.append(summary, inner);
			card.append("Header line of tool result", details);
			content.appendChild(card);
			const el = document.querySelector(sel) as HTMLElement;
			el.scrollTop = el.scrollHeight;
			el.dispatchEvent(new Event("scroll"));
		}, SCROLL_SEL);
		await settleFrames(page);
		await page.locator("#__details_summary").click();
		await settleFrames(page, 4);
		await expectLatestProbePinned(page, "details expansion reflow");
	});

	test.fixme(
		"programmatic scroll-up + rAF re-pin loop keeps Jump hidden at tail",
		async () => {
			// Preserves the skipped reproducer formerly in tests/e2e/ui/tail-chat-jump-button-false-positive.spec.ts.
			// Re-enable as an active fixture assertion when the remaining scroll-loop contract is fixed.
		},
	);

	test("image decode reflow re-pins through the production capture-phase load handler", async ({ page }) => {
		await installSpacer(page);
		const pre = await scrollMetrics(page);

		await page.evaluate((sel) => {
			const content = document.querySelector("agent-interface .max-w-5xl") as HTMLElement;
			const card = document.createElement("div");
			card.setAttribute("data-message-probe", "image");
			card.style.display = "block";
			card.style.margin = "8px";
			card.style.padding = "12px";
			card.style.background = "#eef2ff";
			card.textContent = "Image decode reflow probe";
			const img = document.createElement("img");
			img.id = "__tail_chat_image";
			img.alt = "tail-chat reflow probe";
			img.style.display = "block";
			img.style.width = "800px";
			img.style.maxWidth = "100%";
			card.appendChild(img);
			content.appendChild(card);
			const el = document.querySelector(sel) as HTMLElement;
			el.scrollTop = el.scrollHeight;
			el.dispatchEvent(new Event("scroll"));
		}, SCROLL_SEL);
		await settleFrames(page);

		await page.evaluate((src) => {
			const img = document.getElementById("__tail_chat_image") as HTMLImageElement;
			img.src = src;
		}, TALL_IMAGE_DATA_URI);
		await page.waitForFunction(() => {
			const img = document.getElementById("__tail_chat_image") as HTMLImageElement | null;
			return !!img && img.complete && img.naturalHeight >= 800;
		}, null, { timeout: 10_000 });
		await settleFrames(page, 4);
		await expectLatestProbePinned(page, "image decode reflow");

		const final = await scrollMetrics(page);
		expect(final.scrollHeight, "image-bearing message should grow the scroll container").toBeGreaterThan(pre.scrollHeight + 800);
	});

	test("prompt jump buttons are pure DOM geometry and clicks target nearest prompt", async ({ page }) => {
		await page.evaluate(() => (window as any).__chatScrollFixture.setPromptTranscript({ prompts: 3, scrollTop: "bottom" }));
		let cls = await page.evaluate(() => (window as any).__chatScrollFixture.classifyPrompts());
		let state = await page.evaluate(() => (window as any).__chatScrollFixture.readJumpState());
		expect(cls.userCount).toBe(3);
		expect(cls.above).toBeGreaterThan(0);
		expect(cls.below).toBe(0);
		expect(state.upVisible).toBe(true);
		expect(state.splitPresent).toBe(false);
		expect(state.bottomVisible).toBe(false);

		await page.evaluate(() => (window as any).__chatScrollFixture.setScrollerTop(0));
		cls = await page.evaluate(() => (window as any).__chatScrollFixture.classifyPrompts());
		state = await page.evaluate(() => (window as any).__chatScrollFixture.readJumpState());
		expect(cls.above).toBe(0);
		expect(cls.below).toBeGreaterThan(0);
		expect(state.upVisible).toBe(false);
		expect(state.splitPresent).toBe(true);
		expect(state.bottomVisible).toBe(true);

		await page.locator('[data-testid="jump-to-next-prompt"]').click();
		await expect.poll(() => page.evaluate(() => {
			const offset = (window as any).__chatScrollFixture.promptOffset(1);
			return offset >= 0 && offset <= 40;
		}), {
			timeout: 5_000,
			message: "next prompt click should land prompt[1] near the top margin",
		}).toBe(true);
		cls = await page.evaluate(() => (window as any).__chatScrollFixture.classifyPrompts());
		state = await page.evaluate(() => (window as any).__chatScrollFixture.readJumpState());
		expect(cls.above).toBeGreaterThan(0);
		expect(state.upVisible).toBe(true);
		expect(state.bottomVisible).toBe(true);
		expect(state.splitPresent).toBe(cls.below > 0);

		await page.locator('[data-testid="jump-to-previous-prompt"]').click();
		await expect.poll(() => page.evaluate(() => {
			const offset = (window as any).__chatScrollFixture.promptOffset(0);
			return offset >= 0 && offset <= 40;
		}), {
			timeout: 5_000,
			message: "previous prompt click should land prompt[0] near the top margin",
		}).toBe(true);
		state = await page.evaluate(() => (window as any).__chatScrollFixture.readJumpState());
		expect(state.upVisible).toBe(false);
		expect(state.splitPresent).toBe(true);
	});

	test("mobile prompt jump geometry clears the fixed app header", async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 667 });
		await loadFixture(page);
		await page.evaluate(() => {
			(window as any).__chatScrollFixture.installMobileHeader(64);
			return (window as any).__chatScrollFixture.setPromptTranscript({ prompts: 2, fillerBefore: 160, fillerAfter: 760, scrollTop: "bottom" });
		});
		const state = await page.evaluate(() => (window as any).__chatScrollFixture.readJumpState());
		expect(state.upVisible).toBe(true);
		expect(state.upTop).toContain("--mobile-header-height");

		await page.locator('[data-testid="jump-to-previous-prompt"]').click();
		await expect.poll(async () => page.evaluate(() => {
			const header = document.getElementById("app-header") as HTMLElement;
			const prompt = document.querySelector('user-message[data-fixture-prompt="1"]') as HTMLElement;
			return Math.round(prompt.getBoundingClientRect().top - header.getBoundingClientRect().bottom);
		}), {
			timeout: 5_000,
			message: "jump target should land below fixed mobile header",
		}).toBeGreaterThan(8);
	});

	test("pill overflow fixture covers narrow wrap, wide nowrap, label, and promotion", async ({ page }) => {
		await page.setViewportSize({ width: 540, height: 800 });
		await loadFixture(page);
		await page.evaluate(() => (window as any).__chatScrollFixture.seedPills(15));
		let metrics = await page.evaluate(() => (window as any).__chatScrollFixture.pillMetrics());
		expect(metrics.contentFlexWrap).toBe("wrap");
		expect(metrics.hidden).toBeGreaterThan(0);
		expect(metrics.stripHeight).toBeLessThanOrEqual(2 * 22 + 6 + 8);
		expect(metrics.moreButtonHeight).toBeLessThanOrEqual(28);
		await expect(page.locator("[data-more-btn] button").first()).toHaveCSS("white-space", "nowrap");
		const visibleBefore = metrics.visible;
		const visibleIds = await page.locator("[data-pill-content] > div > bg-process-pill[data-id]").evaluateAll((els) =>
			els.map((el) => el.getAttribute("data-id") || "").filter(Boolean),
		);
		await page.locator("[data-more-btn] button").first().click();
		metrics = await page.evaluate(() => (window as any).__chatScrollFixture.pillMetrics());
		expect(metrics.popoverAlignItems).toBe("flex-start");
		await page.locator("[data-more-btn] button").first().click();
		await page.evaluate((ids) => (window as any).__chatScrollFixture.dismissPills(ids), visibleIds);
		metrics = await page.evaluate(() => (window as any).__chatScrollFixture.pillMetrics());
		expect(metrics.visible).toBeGreaterThanOrEqual(visibleBefore);

		await page.setViewportSize({ width: 1400, height: 800 });
		await loadFixture(page);
		await page.evaluate(() => (window as any).__chatScrollFixture.seedPills(12));
		metrics = await page.evaluate(() => (window as any).__chatScrollFixture.pillMetrics());
		expect(metrics.contentFlexWrap).toBe("nowrap");
		expect(metrics.hidden).toBeGreaterThan(0);
		expect(metrics.stripHeight).toBeLessThanOrEqual(22 + 6);
	});

});
