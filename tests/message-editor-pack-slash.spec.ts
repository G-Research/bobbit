/**
 * PR walkthrough pack slash launch regression coverage (real <message-editor>).
 *
 * Typed full-line `/pr-walkthrough <arg>` sends must dispatch the registered
 * composer-slash spawn launcher instead of falling through to normal chat.
 * Autocomplete selection must only complete the slash token so required args can
 * be entered before launch.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const FIXTURE = path.resolve("tests/fixtures/message-editor-pack-slash.html");
const BUNDLE = path.resolve("tests/fixtures/message-editor-pack-slash-bundle.js");
const ENTRY = path.resolve("tests/fixtures/message-editor-pack-slash-entry.ts");
const EDITOR_SRC = path.resolve("src/ui/components/MessageEditor.ts");
const PACK_ENTRYPOINTS_SRC = path.resolve("src/app/pack-entrypoints.ts");
const PACK_PANELS_SRC = path.resolve("src/app/pack-panels.ts");

test.beforeAll(() => {
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: [ENTRY, EDITOR_SRC, PACK_ENTRYPOINTS_SRC, PACK_PANELS_SRC] });
});

const PAGE = `file://${FIXTURE}`;

async function ready(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
}

async function sendTypedComposerValue(page: any, text: string) {
	return await page.evaluate(async (value) => {
		const w = window as any;
		const el = w.__mountEditor(document.getElementById("container"));
		await el.updateComplete;
		await w.__setValue(el, value);
		await w.__pressEnter(el);
		return {
			sendCalls: w.__getSendCalls(),
			callRoute: w.__getCallRouteCalls(),
			messageSendEvents: w.__getMessageSendEvents(),
		};
	}, text);
}

test.describe("MessageEditor pack composer slash dispatch", () => {
	test("typed /pr-walkthrough <github-pr-url> launches the PR walkthrough route and does not call onSend", async ({ page }) => {
		await ready(page);
		const prUrl = "https://github.com/SuuBro/bobbit/pull/764";
		const out = await sendTypedComposerValue(page, `/pr-walkthrough ${prUrl}`);

		expect(out.sendCalls).toHaveLength(0);
		expect(out.callRoute).toHaveLength(1);
		expect(out.callRoute[0]).toMatchObject({
			route: "run",
			packId: "pr-walkthrough",
			contributionId: "pr-walkthrough",
			body: { prUrl },
		});
		expect(out.messageSendEvents).toHaveLength(1);
	});

	test("typed /pr-walkthrough <pr-number> launches the PR walkthrough route and does not call onSend", async ({ page }) => {
		await ready(page);
		const out = await sendTypedComposerValue(page, "/pr-walkthrough 764");

		expect(out.sendCalls).toHaveLength(0);
		expect(out.callRoute).toHaveLength(1);
		expect(out.callRoute[0]).toMatchObject({
			route: "run",
			packId: "pr-walkthrough",
			contributionId: "pr-walkthrough",
			body: { prNumber: 764 },
		});
		expect(out.messageSendEvents).toHaveLength(1);
	});

	test("selecting /pr-walkthrough from autocomplete completes the command without launching", async ({ page }) => {
		await ready(page);
		const out = await page.evaluate(async () => {
			const w = window as any;
			const el = w.__mountEditor(document.getElementById("container"));
			await el.updateComplete;
			await w.__typeText(el, "/pr-walkthro");
			if (!w.__isSlashMenuOpen(el)) throw new Error("slash menu did not open for /pr-walkthro");
			await w.__pressEnter(el);
			return {
				value: w.__getValue(el),
				sendCalls: w.__getSendCalls(),
				callRoute: w.__getCallRouteCalls(),
				messageSendEvents: w.__getMessageSendEvents(),
			};
		});

		expect(out.value).toBe("/pr-walkthrough ");
		expect(out.sendCalls).toHaveLength(0);
		expect(out.callRoute).toHaveLength(0);
		expect(out.messageSendEvents).toHaveLength(0);
	});

	test("selected /pr-walkthrough command launches after the user adds an argument and sends", async ({ page }) => {
		await ready(page);
		const out = await page.evaluate(async () => {
			const w = window as any;
			const el = w.__mountEditor(document.getElementById("container"));
			await el.updateComplete;
			await w.__typeText(el, "/pr-walkthro");
			if (!w.__isSlashMenuOpen(el)) throw new Error("slash menu did not open for /pr-walkthro");
			await w.__pressEnter(el);
			await w.__typeText(el, "764");
			await w.__pressEnter(el);
			return {
				sendCalls: w.__getSendCalls(),
				callRoute: w.__getCallRouteCalls(),
				messageSendEvents: w.__getMessageSendEvents(),
			};
		});

		expect(out.sendCalls).toHaveLength(0);
		expect(out.callRoute).toHaveLength(1);
		expect(out.callRoute[0]).toMatchObject({ route: "run", body: { prNumber: 764 } });
		expect(out.messageSendEvents).toHaveLength(1);
	});
});
