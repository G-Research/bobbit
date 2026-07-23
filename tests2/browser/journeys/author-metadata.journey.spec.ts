import type { Page } from "@playwright/test";
import {
	apiFetch,
	createSession,
	deleteSession,
	expect,
	navigateToHash,
	openApp,
	sendMessage,
	test,
	waitForSessionStatus,
} from "../_helpers/journey-fixture.js";

interface CapturedAuthors {
	user: { kind: string; id: string; label: string };
	assistant: { kind: string; id: string; label: string };
}

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAQUBAScY42YAAAAASUVORK5CYII=";
const AGENT_LABEL = "Test Coordinator With A Deliberately Long Identity Label For Narrow Mobile Prompt Attribution";
const AGENT_LABEL_RAW = `  Test   Coordinator With A Deliberately Long Identity\nLabel For Narrow Mobile Prompt Attribution  `;
const AGENT_COLOR_INDEX = 8;
const AGENT_HUE_ROTATE = 40;

function promptBubble(page: Page, text: string) {
	return page.locator("user-message").filter({ hasText: text }).last();
}

function normalizedText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

async function waitForAuthoredExchange(page: Page, prompt: string): Promise<CapturedAuthors> {
	const handle = await page.waitForFunction((promptText) => {
		const appState = (window as any).bobbitState ?? (window as any).__bobbitState;
		const remoteState = appState?.remoteAgent?.state;
		const messages = remoteState?.messages ?? [];
		const textOf = (message: any): string => {
			if (typeof message?.content === "string") return message.content;
			if (!Array.isArray(message?.content)) return "";
			return message.content
				.filter((block: any) => block?.type === "text")
				.map((block: any) => block.text ?? "")
				.join("\n");
		};
		const userIndex = messages.findIndex((message: any) =>
			(message.role === "user" || message.role === "user-with-attachments")
			&& textOf(message) === promptText,
		);
		if (userIndex < 0) return null;
		const user = messages[userIndex];
		const assistant = messages.slice(userIndex + 1).find((message: any) => message.role === "assistant");
		if (remoteState.status !== "idle" || !user?.author || !assistant?.author) return null;
		return { user: user.author, assistant: assistant.author };
	}, prompt);
	return handle.jsonValue() as Promise<CapturedAuthors>;
}

function installTimestampedUserEcho(gateway: any, sessionId: string): () => void {
	const core = gateway.sessionManager.getSession(sessionId)?.rpcClient?._agent;
	if (!core || typeof core.emit !== "function") {
		throw new Error("author journey requires the in-process mock bridge user-echo seam");
	}
	const originalEmit = core.emit;
	core.emit = function emitWithTimestamp(event: any) {
		if (
			(event?.type === "message_update" || event?.type === "message_end")
			&& (event.message?.role === "user" || event.message?.role === "user-with-attachments")
			&& event.message.timestamp === undefined
		) {
			event.message.timestamp = Date.now();
		}
		return originalEmit.call(this, event);
	};
	return () => { core.emit = originalEmit; };
}

async function expectBadgeText(bubble: ReturnType<typeof promptBubble>, expected: string): Promise<void> {
	const badge = bubble.locator(".prompt-author-badge");
	await expect(badge).toBeVisible({ timeout: 15_000 });
	await expect.poll(async () => normalizedText(await badge.innerText())).toBe(expected);
	await expect(badge).toHaveAttribute("aria-label", `Prompt author: ${expected}`);
	await expect(badge).toHaveAttribute("title", expected);
}

async function spriteDetails(root: import("@playwright/test").Locator) {
	return root.evaluate((node) => {
		const candidates = [node, ...Array.from(node.querySelectorAll("span"))] as HTMLElement[];
		const sprite = candidates.find((candidate) =>
			candidate.style.position === "relative"
			&& candidate.style.overflow === "hidden"
			&& candidate.querySelector(":scope > img"),
		);
		if (!sprite) return null;
		const images = Array.from(sprite.querySelectorAll(":scope > img")) as HTMLImageElement[];
		const hue = /hue-rotate\((-?\d+)deg\)/.exec(sprite.getAttribute("style") ?? "")?.[1];
		const rootRect = node.getBoundingClientRect();
		const spriteRect = sprite.getBoundingClientRect();
		return {
			hue: hue === undefined ? undefined : Number(hue),
			imageCount: images.length,
			accessorySrc: images.at(-1)?.src,
			animationNames: [sprite, ...Array.from(sprite.querySelectorAll("*"))]
				.map((element) => getComputedStyle(element).animationName),
			hasBlinkLayer: !!sprite.querySelector(".bobbit-sidebar-unread-blink"),
			hasSaturation: /saturate\(/.test(sprite.getAttribute("style") ?? ""),
			rootHeight: rootRect.height,
			verticalCenterDelta: (spriteRect.top + spriteRect.height / 2) - (rootRect.top + rootRect.height / 2),
		};
	});
}

async function expectOpenCenterEyes(decorativeAvatar: import("@playwright/test").Locator): Promise<void> {
	const pixels = await decorativeAvatar.locator("img").first().evaluate(async (image: HTMLImageElement) => {
		if (!image.complete) await image.decode();
		const canvas = document.createElement("canvas");
		canvas.width = image.naturalWidth;
		canvas.height = image.naturalHeight;
		const context = canvas.getContext("2d", { willReadFrequently: true })!;
		context.drawImage(image, 0, 0);
		const pixelWidth = image.naturalWidth / 10;
		const pixelHeight = image.naturalHeight / 9;
		const sample = (spriteX: number, spriteY: number) => Array.from(context.getImageData(
			Math.floor((spriteX + 0.5) * pixelWidth),
			Math.floor((spriteY + 0.5) * pixelHeight),
			1,
			1,
		).data);
		return {
			leftTop: sample(3, 4),
			leftBottom: sample(3, 5),
			rightTop: sample(6, 4),
			rightBottom: sample(6, 5),
			rightGazeLeft: sample(4, 4),
			rightGazeRight: sample(7, 4),
		};
	});
	for (const eye of [pixels.leftTop, pixels.leftBottom, pixels.rightTop, pixels.rightBottom]) {
		expect(eye).toEqual([0, 0, 0, 255]);
	}
	for (const bodyPixel of [pixels.rightGazeLeft, pixels.rightGazeRight]) {
		expect(bodyPixel[3]).toBe(255);
		expect(bodyPixel.slice(0, 3)).not.toEqual([0, 0, 0]);
	}
}

async function expectStaticSpriteMatchesSidebar(
	page: Page,
	sourceSessionId: string,
	agentBubble: ReturnType<typeof promptBubble>,
	expectedAccessorySrc?: string,
): Promise<string> {
	const badge = agentBubble.locator(".prompt-author-badge");
	const decorativeAvatar = badge.locator('[aria-hidden="true"]').first();
	await expect(decorativeAvatar).toBeVisible();

	const avatar = await spriteDetails(decorativeAvatar);
	expect(avatar, "agent badge contains the canonical Bobbit sprite").not.toBeNull();
	expect(avatar!.hue).toBe(AGENT_HUE_ROTATE);
	expect(avatar!.imageCount).toBeGreaterThanOrEqual(2);
	expect(avatar!.animationNames.every((name) => name === "none")).toBe(true);
	expect(avatar!.hasBlinkLayer).toBe(false);
	expect(avatar!.hasSaturation).toBe(false);
	expect(avatar!.rootHeight).toBeCloseTo(20, 1);
	expect(Math.abs(avatar!.verticalCenterDelta)).toBeLessThanOrEqual(1);
	await expectOpenCenterEyes(decorativeAvatar);

	if (expectedAccessorySrc) {
		expect(avatar!.accessorySrc).toBe(expectedAccessorySrc);
	} else {
		const sidebarRow = page.locator(`[data-session-id="${sourceSessionId}"]`).first();
		await expect(sidebarRow).toBeVisible({ timeout: 15_000 });
		const sidebar = await spriteDetails(sidebarRow);
		expect(sidebar, "source session sidebar row contains its Bobbit sprite").not.toBeNull();
		expect(sidebar!.hue).toBe(AGENT_HUE_ROTATE);
		expect(avatar!.accessorySrc).toBe(sidebar!.accessorySrc);
	}
	return avatar!.accessorySrc!;
}

async function expectAuthorBadgeGeometry(page: Page): Promise<void> {
	const geometry = await page.evaluate(() => ({
		viewportWidth: window.innerWidth,
		documentWidth: document.documentElement.scrollWidth,
		rows: Array.from(document.querySelectorAll("user-message .prompt-row--labelled")).map((row) => {
			const rowRect = row.getBoundingClientRect();
			const badgeRect = row.querySelector(".prompt-author-badge")!.getBoundingClientRect();
			const bubble = row.querySelector(".user-message-container--labelled")!;
			const bubbleRect = bubble.getBoundingClientRect();
			return {
				left: rowRect.left,
				right: rowRect.right,
				width: rowRect.width,
				badgeTop: badgeRect.top,
				badgeHeight: badgeRect.height,
				rowTop: rowRect.top,
				badgeBottom: badgeRect.bottom,
				bubbleTop: bubbleRect.top,
				chevronTop: getComputedStyle(bubble, "::before").top,
			};
		}),
	}));
	expect(geometry.rows.length).toBeGreaterThanOrEqual(3);
	expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
	for (const row of geometry.rows) {
		expect(row.left).toBeGreaterThanOrEqual(-0.5);
		expect(row.right).toBeLessThanOrEqual(geometry.viewportWidth + 0.5);
		expect(row.width).toBeGreaterThan(0);
		expect(row.badgeTop).toBeGreaterThanOrEqual(row.rowTop);
		expect(row.badgeBottom).toBeGreaterThan(row.bubbleTop);
		expect(row.badgeHeight).toBeCloseTo(24, 1);
		expect(row.chevronTop).toBe("19px");
	}
}

test.describe("Journey: Author metadata", () => {
	test("all-human prompt authors survive reload while labels stay suppressed", async ({ page }) => {
		const sessionId = await createSession();
		const prompt = "AUTHOR_METADATA_RELOAD_SMOKE";
		await waitForSessionStatus(sessionId, "idle");

		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await sendMessage(page, prompt);

			const liveAuthors = await waitForAuthoredExchange(page, prompt);
			expect(liveAuthors.user.kind).toBe("user");
			expect(liveAuthors.user.id).toBe("user:local");
			expect(liveAuthors.assistant.kind).toBe("agent");
			expect(liveAuthors.assistant.id).toBeTruthy();

			const userBubble = promptBubble(page, prompt);
			const assistantBubble = page.locator("assistant-message").last();
			await expect(userBubble).toBeVisible();
			await expect(assistantBubble).toBeVisible();
			await expect(page.locator(".prompt-author-badge")).toHaveCount(0);

			await page.reload({ waitUntil: "domcontentloaded" });
			const reloadedAuthors = await waitForAuthoredExchange(page, prompt);
			expect(reloadedAuthors).toEqual(liveAuthors);
			await expect(promptBubble(page, prompt)).toBeVisible();
			await expect(page.locator(".prompt-author-badge")).toHaveCount(0);
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("mixed trusted prompt sources enable exact labels and a static sidebar-matched sprite across reload and mobile", async ({ page, gateway }) => {
		test.setTimeout(120_000);
		const sourceSessionId = await createSession();
		const targetSessionId = await createSession();
		const humanPrompt = "/qa-check ECHO_IMAGE_BLOCK inspect @fixture.txt on mobile";
		const agentPrompt = "AUTHOR_AGENT_MIXED_SOURCE_VISIBLE_BASE";
		const systemPrompt = "AUTHOR_SYSTEM_MIXED_SOURCE_VISIBLE_BASE";
		const modelPrefix = `[${AGENT_LABEL} (${sourceSessionId.slice(0, 6)})]: `;
		let restoreEcho: (() => void) | undefined;
		let previousShowTimestamps = true;

		await waitForSessionStatus(sourceSessionId, "idle");
		await waitForSessionStatus(targetSessionId, "idle");
		try {
			const preferences = await apiFetch("/api/preferences");
			if (preferences.ok) {
				const current = await preferences.json();
				previousShowTimestamps = current.showTimestamps !== false;
			}
			await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ showTimestamps: true }),
			});
			const appearancePatch = await apiFetch(`/api/sessions/${sourceSessionId}`, {
				method: "PATCH",
				body: JSON.stringify({
					title: AGENT_LABEL,
					colorIndex: AGENT_COLOR_INDEX,
					accessory: "crown",
				}),
			});
			expect(appearancePatch.status, await appearancePatch.clone().text()).toBe(200);

			await openApp(page);
			await navigateToHash(page, `#/session/${targetSessionId}`);
			restoreEcho = installTimestampedUserEcho(gateway, targetSessionId);

			const skillEnd = "/qa-check".length;
			const mentionStart = humanPrompt.indexOf("@fixture.txt");
			const humanResult = await gateway.sessionManager.enqueuePrompt(targetSessionId, humanPrompt, {
				modelText: "ECHO_IMAGE_BLOCK expanded QA instructions and inlined fixture content",
				images: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
				skillExpansions: [{
					name: "qa-check",
					args: "",
					source: "project",
					filePath: "/fixture/qa-check/SKILL.md",
					range: [0, skillEnd],
					expanded: "Expanded QA instructions",
				}],
				fileMentions: [{
					path: "fixture.txt",
					range: [mentionStart, mentionStart + "@fixture.txt".length],
					kind: "text",
					content: "fixture body",
					bytes: 12,
				}],
			});
			expect(humanResult.status).toBe("dispatched");
			await waitForSessionStatus(targetSessionId, "idle", 20_000);
			await waitForAuthoredExchange(page, humanPrompt);

			const humanBubble = page.locator("user-message")
				.filter({ has: page.getByRole("button", { name: "/qa-check", exact: true }) })
				.last();
			await expect(humanBubble).toBeVisible();
			await expect(humanBubble.locator("skill-chip .skill-chip-pill")).toBeVisible();
			await expect(humanBubble.locator(".file-mention-chip-pill")).toHaveText("@fixture.txt");
			await expect(humanBubble.locator("attachment-tile")).toBeVisible();
			await expect(page.locator(".prompt-author-badge")).toHaveCount(0);

			const agentResult = await gateway.sessionManager.enqueuePrompt(targetSessionId, agentPrompt, {
				source: "agent",
				author: { kind: "agent", id: `session:${sourceSessionId}`, label: AGENT_LABEL_RAW },
			});
			expect(agentResult.status).toBe("dispatched");
			await waitForSessionStatus(targetSessionId, "idle", 20_000);
			await waitForAuthoredExchange(page, agentPrompt);

			const agentBubble = promptBubble(page, agentPrompt);
			await expectBadgeText(humanBubble, "User");
			await expectBadgeText(agentBubble, `${AGENT_LABEL} | Agent`);

			const systemResult = await gateway.sessionManager.enqueuePrompt(targetSessionId, systemPrompt, {
				source: "task-notification",
			});
			expect(systemResult.status).toBe("dispatched");
			await waitForSessionStatus(targetSessionId, "idle", 20_000);
			await waitForAuthoredExchange(page, systemPrompt);

			const systemBubble = promptBubble(page, systemPrompt);
			await expectBadgeText(systemBubble, "System");
			await expect(humanBubble.locator(".prompt-author-initial")).toHaveAttribute("data-initial", "U");
			await expect(systemBubble.locator(".prompt-author-initial")).toHaveAttribute("data-initial", "S");
			await expect(systemBubble.locator(".prompt-author-avatar")).toHaveCount(0);
			await expect(page.locator("assistant-message .prompt-author-badge")).toHaveCount(0);
			expect(normalizedText(await humanBubble.locator(".prompt-author-badge").innerText())).not.toContain("Human");
			expect(normalizedText(await systemBubble.locator(".prompt-author-badge").innerText())).not.toContain("Bobbit");
			await expect(agentBubble).not.toContainText(modelPrefix);
			expect(await page.locator("body").innerText()).not.toContain(modelPrefix);

			const accessorySrc = await expectStaticSpriteMatchesSidebar(page, sourceSessionId, agentBubble);

			await page.setViewportSize({ width: 390, height: 844 });
			await expect(agentBubble.locator(".message-timestamp")).toBeVisible();
			expect((await agentBubble.locator(".message-timestamp").innerText()).trim()).not.toBe("");
			const nameStyle = await agentBubble.locator(".prompt-author-name").evaluate((element) => {
				const style = getComputedStyle(element);
				return { overflow: style.overflow, textOverflow: style.textOverflow, whiteSpace: style.whiteSpace };
			});
			expect(nameStyle).toEqual({ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
			await expectAuthorBadgeGeometry(page);

			const skillButton = humanBubble.locator("skill-chip .skill-chip-pill");
			await skillButton.click();
			await expect(humanBubble.getByText("Expanded QA instructions", { exact: true })).toBeVisible();
			await expect(humanBubble.locator("attachment-tile")).toBeVisible();
			await expect(humanBubble.locator(".file-mention-chip-pill")).toBeVisible();

			await page.reload({ waitUntil: "domcontentloaded" });
			await waitForAuthoredExchange(page, systemPrompt);
			const reloadedHuman = promptBubble(page, humanPrompt);
			const reloadedAgent = promptBubble(page, agentPrompt);
			const reloadedSystem = promptBubble(page, systemPrompt);
			await expectBadgeText(reloadedHuman, "User");
			await expectBadgeText(reloadedAgent, `${AGENT_LABEL} | Agent`);
			await expectBadgeText(reloadedSystem, "System");
			await expect(reloadedHuman.locator("skill-chip .skill-chip-pill")).toBeVisible();
			await expect(reloadedHuman.locator(".file-mention-chip-pill")).toBeVisible();
			await expect(reloadedHuman.locator("attachment-tile")).toBeVisible();
			await expectStaticSpriteMatchesSidebar(page, sourceSessionId, reloadedAgent, accessorySrc);
			await expectAuthorBadgeGeometry(page);
			expect(await page.locator("body").innerText()).not.toContain(modelPrefix);

			const originLink = reloadedAgent.locator("a.prompt-author-badge");
			await expect(originLink).toHaveAttribute("href", `#/session/${sourceSessionId}`);
			await originLink.click();
			await expect(page).toHaveURL(new RegExp(`#/session/${sourceSessionId}$`));
		} finally {
			restoreEcho?.();
			await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ showTimestamps: previousShowTimestamps }),
			}).catch(() => undefined);
			await deleteSession(targetSessionId).catch(() => undefined);
			await deleteSession(sourceSessionId).catch(() => undefined);
		}
	});
});
