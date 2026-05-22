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

async function expectLatestProbePinned(page: Page, label: string): Promise<void> {
	const probe = await page.evaluate(({ scrollSel, msgSel }) => {
		const el = document.querySelector(scrollSel) as HTMLElement | null;
		const msgs = Array.from(document.querySelectorAll(msgSel)) as HTMLElement[];
		if (!el || msgs.length === 0) return { error: "missing scroll container or probe message" } as const;
		const last = msgs[msgs.length - 1];
		const er = el.getBoundingClientRect();
		const lr = last.getBoundingClientRect();
		return {
			distance: el.scrollHeight - el.scrollTop - el.clientHeight,
			belowFold: lr.bottom - er.bottom,
			scrollTop: el.scrollTop,
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
			lastHeight: lr.height,
		} as const;
	}, { scrollSel: SCROLL_SEL, msgSel: MSG_SEL });
	if ("error" in probe) throw new Error(probe.error);
	expect(
		probe.distance,
		`${label}: scroll viewport not pinned; dist=${Math.round(probe.distance)} ` +
		`scrollTop=${Math.round(probe.scrollTop)} scrollHeight=${probe.scrollHeight}`,
	).toBeLessThanOrEqual(TAIL_PX);
	expect(
		probe.belowFold,
		`${label}: latest probe bottom ${Math.round(probe.belowFold)} px below viewport; ` +
		`lastHeight=${Math.round(probe.lastHeight)} clientHeight=${probe.clientHeight}`,
	).toBeLessThanOrEqual(TAIL_PX);
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

	test("Jump-to-bottom appears after trusted scroll-up, hides near bottom, clicks back to tail, and unmounts cleanly", async ({ page }) => {
		const consoleErrors: string[] = [];
		page.on("console", (msg) => {
			if (msg.type() === "error") consoleErrors.push(msg.text());
		});

		await installSpacer(page);
		const pre = await scrollMetrics(page);
		expect(pre.overflow).toBeGreaterThan(2000);
		expect(pre.distance).toBeLessThanOrEqual(TAIL_PX);
		await expect.poll(() => jumpOpacity(page), { timeout: 5_000 }).toEqual({ opacity: "0", pointerEvents: "none" });

		const box = await page.locator(SCROLL_SEL).boundingBox();
		if (!box) throw new Error("scroll container has no box");
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.wheel(0, -Math.floor(pre.clientHeight * 0.7));
		await page.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			const ch = el.clientHeight;
			el.scrollTop = el.scrollHeight - ch - Math.floor(ch * 0.6);
			el.dispatchEvent(new Event("scroll"));
		}, SCROLL_SEL);
		await expect.poll(() => jumpOpacity(page), { timeout: 5_000 }).toEqual({ opacity: "1", pointerEvents: "auto" });

		await page.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			const ch = el.clientHeight;
			el.scrollTop = el.scrollHeight - ch - Math.floor(ch * 0.4) + 1;
			el.dispatchEvent(new Event("scroll"));
		}, SCROLL_SEL);
		await expect.poll(() => jumpOpacity(page), { timeout: 5_000 }).toEqual({ opacity: "0", pointerEvents: "none" });

		await page.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			const ch = el.clientHeight;
			el.scrollTop = el.scrollHeight - ch - Math.floor(ch * 0.7);
			el.dispatchEvent(new Event("scroll"));
		}, SCROLL_SEL);
		await expect.poll(() => jumpOpacity(page), { timeout: 5_000 }).toEqual({ opacity: "1", pointerEvents: "auto" });
		await page.evaluate((sel) => (document.querySelector(sel) as HTMLElement | null)?.click(), JUMP_SEL);
		await page.waitForFunction((sel) => {
			const el = document.querySelector(sel) as HTMLElement | null;
			return !!el && el.scrollHeight - el.scrollTop - el.clientHeight <= 5;
		}, SCROLL_SEL, { timeout: 5_000 });

		await page.evaluate(() => document.querySelector("agent-interface")?.remove());
		await settleFrames(page);
		const real = consoleErrors.filter((e) => !/favicon|net::|404 \(Not Found\)|400 \(Bad Request\)|websocket|status of 400/i.test(e));
		expect(real, `unexpected console errors after unmount: ${real.join(" | ")}`).toHaveLength(0);
	});

	test("near-bottom relock and tool-result details reflow keep latest probe pinned", async ({ page }) => {
		await installSpacer(page, { probe: true });
		const pre = await scrollMetrics(page);
		expect(pre.overflow).toBeGreaterThan(2000);

		const box = await page.locator(SCROLL_SEL).boundingBox();
		if (!box) throw new Error("scroll container has no box");
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.wheel(0, -30);
		await page.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			el.scrollTop = el.scrollHeight - el.clientHeight - 30;
			el.dispatchEvent(new Event("scroll"));
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
});
