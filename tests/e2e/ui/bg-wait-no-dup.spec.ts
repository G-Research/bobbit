/**
 * E2E regression for the `bash_bg.wait` toolCall card dual-render bug.
 *
 * When an assistant `message_end` arrives without a string `msg.id`,
 * `RemoteAgent` previously demoted `streamingMessageId` to `undefined`,
 * which short-circuited the visible-messages filter in `AgentInterface.ts`
 * (`!streamingMessageId` evaluates true for every row) and could leave the
 * same tool-call card rendered in BOTH `<message-list>` and the streaming
 * container. Most visible during a parked `bash_bg.wait` because no further
 * events arrive to trigger reconciliation.
 *
 * Fix: `computeStreamingMessageId` falls back to `synth:tc:<firstToolCallId>`
 * so the in-flight row is hidden; the same synthetic id is stamped onto the
 * reducer entry so id-equality continues to work after reconciliation. The
 * unit test in `tests/dual-render-noid-message.test.ts` exercises the filter
 * + helper directly with all four id-shapes (string / undefined / null /
 * numeric); this E2E covers the full WS pipeline + browser DOM end-to-end.
 *
 * The mock agent's `BG_WAIT_NOID:<ms>` trigger emits exactly the bug
 * condition: a single `bash_bg` `wait` toolCall in an assistant
 * `message_end` with no `id` field, then parks for <ms> ms with no further
 * events. (`BG_WAIT:<ms>` is now the real-bg-process trigger — different
 * surface, see mock-agent-core.mjs header.)
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

test.describe("bash_bg.wait — no dual-render when message_end has no id", () => {
	test("exactly one bash_bg card renders during a parked wait", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);

		// Trigger the id-less assistant message_end + parked wait.
		await sendMessage(page, "BG_WAIT_NOID:2000 park the wait");

		// Wait for the toolCall card to render.
		await page.waitForFunction(
			() => {
				const ai = document.querySelector("agent-interface");
				if (!ai) return false;
				return Array.from(ai.querySelectorAll("span"))
					.some((s) => s.textContent?.trim() === "bash_bg");
			},
			null,
			{ timeout: 8_000 },
		);

		// Sample once after the toolCall card appears.
		const before = await page.evaluate(() => {
			const ai = document.querySelector("agent-interface");
			if (!ai) return -1;
			return Array.from(ai.querySelectorAll("span"))
				.filter((s) => s.textContent?.trim() === "bash_bg").length;
		});
		expect(before).toBe(1);

		// Re-sample after the live-timer ticks at least once. The buggy code
		// paths could surface the duplicate either immediately on `message_end`
		// or after a Lit re-render — sampling twice across a timer tick covers
		// both windows.
		await page.waitForFunction(
			() => {
				const t = document.querySelector("agent-interface live-timer");
				const txt = t?.textContent?.trim() ?? "";
				return /([1-9]\d*)s/.test(txt);
			},
			null,
			{ timeout: 4_000 },
		);
		const after = await page.evaluate(() => {
			const ai = document.querySelector("agent-interface");
			if (!ai) return -1;
			return Array.from(ai.querySelectorAll("span"))
				.filter((s) => s.textContent?.trim() === "bash_bg").length;
		});
		expect(after).toBe(1);

		// The reducer entry MUST carry the synthetic id so the filter's
		// id-equality check works after the streaming container clears. This
		// is the core invariant of the fix — Option A in the goal spec.
		const reducerCheck = await page.evaluate(() => {
			const ai = document.querySelector("agent-interface") as any;
			const sess = ai?.session;
			const msgs = sess?.state?.messages ?? [];
			const asst = msgs.find((m: any) =>
				m.role === "assistant" &&
				Array.isArray(m.content) &&
				m.content.some((c: any) => c.type === "toolCall" && c.name === "bash_bg"),
			);
			return {
				hasAssistant: !!asst,
				id: asst?.id,
				toolCallId: asst?.content?.find((c: any) => c.type === "toolCall")?.id,
			};
		});
		expect(reducerCheck.hasAssistant).toBe(true);
		// Either a real string id (real agent path) or a synthetic id derived
		// from the first toolCall id. The mock emits no `msg.id` so we must
		// land on the synthetic.
		expect(reducerCheck.id).toBe(`synth:tc:${reducerCheck.toolCallId}`);
	});
});
