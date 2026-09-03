import { expect, test, type Page } from "@playwright/test";
import {
	awaitTailGrowthPhase,
	settleFrames,
	startTailPhaseTracker,
	stopTailPhaseTracker,
} from "../../support/helpers/browser/e2e/tail-chat-helpers.js";

const MARKER = "PRE-WAIT-CHUNK-1#30";
const SECOND_MARKER = "POST-WAIT-CHUNK-1#30";
const TRACKER = "__tailMarkerLifecycle";

async function installFixture(page: Page, markers = [MARKER]): Promise<void> {
	await page.setContent(`
		<style>
			.overflow-y-auto { height: 120px; overflow-y: auto; }
			assistant-message { display: block; height: 80px; }
		</style>
		<agent-interface>
			<div class="overflow-y-auto"><div class="max-w-5xl"><div style="height:240px"></div></div></div>
		</agent-interface>
	`);
	await page.evaluate(() => {
		(window as any).bobbitState = {
			remoteAgent: {
				state: {},
				handleServerMessage() {},
			},
		};
	});
	await startTailPhaseTracker(page, TRACKER, markers);
}

async function emitMarkerEvent(
	page: Page,
	type: "message_update" | "message_end",
	id: string,
	marker = MARKER,
): Promise<void> {
	await page.evaluate(({ marker, eventType, eventId }) => {
		(window as any).bobbitState.remoteAgent.handleServerMessage({
			type: "event",
			data: {
				type: eventType,
				message: {
					id: eventId,
					role: "assistant",
					content: [{ type: "text", text: marker }],
				},
			},
		});
	}, { marker, eventType: type, eventId: id });
}

async function addProjection(
	page: Page,
	phase: "streaming" | "settled",
	id: string,
	marker = MARKER,
	height = 80,
): Promise<void> {
	await page.evaluate(({ marker, projectionPhase, eventId, projectionHeight }) => {
		const content = document.querySelector(".max-w-5xl")!;
		let parent: Element = content;
		if (projectionPhase === "streaming") {
			parent = content.querySelector("streaming-message-container") ?? document.createElement("streaming-message-container");
			if (!parent.parentElement) content.append(parent);
		}
		const node = document.createElement("assistant-message");
		node.setAttribute("data-projection", projectionPhase);
		node.style.height = `${projectionHeight}px`;
		(node as any).message = {
			id: eventId,
			role: "assistant",
			content: [{ type: "text", text: marker }],
		};
		node.textContent = marker;
		parent.append(node);
		const scroll = document.querySelector(".overflow-y-auto") as HTMLElement;
		scroll.scrollTop = scroll.scrollHeight;
	}, { marker, projectionPhase: phase, eventId: id, projectionHeight: height });
	await settleFrames(page, 3);
}

async function removeProjection(page: Page, phase: "streaming" | "settled"): Promise<void> {
	await page.evaluate((projectionPhase) => {
		document.querySelector(`assistant-message[data-projection="${projectionPhase}"]`)?.remove();
	}, phase);
	await settleFrames(page, 3);
}

async function trackerFailure(page: Page): Promise<string> {
	try {
		await stopTailPhaseTracker(page, TRACKER);
		return "";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

test.describe("tail phase marker projection lifecycle", () => {
	test.beforeEach(async ({ page }) => {
		await installFixture(page);
	});

	test("accepts cumulative frames and one streaming-to-settled projection for the authenticated ID", async ({ page }) => {
		await emitMarkerEvent(page, "message_update", "message-1");
		await addProjection(page, "streaming", "message-1");
		await emitMarkerEvent(page, "message_update", "message-1");
		await emitMarkerEvent(page, "message_end", "message-1");
		await removeProjection(page, "streaming");
		await addProjection(page, "settled", "message-1");

		const evidence = await stopTailPhaseTracker(page, TRACKER);
		expect(evidence).toHaveLength(1);
		expect(evidence[0].growth).toBeGreaterThan(0);
	});

	test("waits past a streaming-to-settled shrink for the next strictly ordered height", async ({ page }) => {
		await trackerFailure(page);
		await installFixture(page, [MARKER, SECOND_MARKER]);

		await emitMarkerEvent(page, "message_update", "message-1");
		await addProjection(page, "streaming", "message-1", MARKER, 100);
		const first = await awaitTailGrowthPhase(page, TRACKER, MARKER);
		expect(first.scrollHeight).toBe(340);

		await emitMarkerEvent(page, "message_end", "message-1");
		await removeProjection(page, "streaming");
		await addProjection(page, "settled", "message-1", MARKER, 70);

		await emitMarkerEvent(page, "message_update", "message-2", SECOND_MARKER);
		await addProjection(page, "streaming", "message-2", SECOND_MARKER, 20);
		await page.evaluate(() => {
			const second = document.querySelector('assistant-message[data-projection="streaming"]') as HTMLElement;
			second.style.height = "40px";
			const scroll = document.querySelector(".overflow-y-auto") as HTMLElement;
			scroll.scrollTop = scroll.scrollHeight;
		});
		await settleFrames(page, 3);

		const evidence = await stopTailPhaseTracker(page, TRACKER);
		expect(evidence.map((phase) => phase.scrollHeight)).toEqual([340, 350]);
		expect(evidence.every((phase) => (phase.growth ?? 0) > 0)).toBe(true);
	});

	test("rejects the marker from a different authenticated event ID", async ({ page }) => {
		await emitMarkerEvent(page, "message_update", "message-1");
		await emitMarkerEvent(page, "message_update", "message-2");

		expect(await trackerFailure(page)).toContain(`duplicate exact marker ${MARKER}`);
	});

	test("rejects a second settled DOM projection after the authenticated lifecycle", async ({ page }) => {
		await emitMarkerEvent(page, "message_update", "message-1");
		await addProjection(page, "streaming", "message-1");
		await emitMarkerEvent(page, "message_end", "message-1");
		await removeProjection(page, "streaming");
		await addProjection(page, "settled", "message-1");
		await removeProjection(page, "settled");
		await addProjection(page, "settled", "message-1");

		expect(await trackerFailure(page)).toContain(`duplicate exact marker ${MARKER}`);
	});

	test("rejects a duplicate that appears only in the DOM", async ({ page }) => {
		await addProjection(page, "settled", "message-1");
		await removeProjection(page, "settled");
		await addProjection(page, "settled", "message-1");

		expect(await trackerFailure(page)).toContain(`duplicate exact marker ${MARKER}`);
	});
});
