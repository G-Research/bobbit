import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/streaming-message-container-set-message.spec.ts (v2-dom tier).
// Renders the REAL <streaming-message-container> lit component under happy-dom
// (was an esbuild file:// bundle). Real timers + real requestAnimationFrame drive
// the setMessage batching path. Pins:
//   • the sticky `_immediateUpdate` flag must not drop the first batched delta
//     after an immediate-clear,
//   • the defensive clear when isStreaming flips true→false with a stale message,
//   • that a SECOND batched delta always lands.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../src/ui/components/StreamingMessageContainer.js";

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const microtask = () => new Promise<void>((r) => setTimeout(r, 0));

// Render the blob as its text label instead of the <canvas> pixel-eye sprite —
// happy-dom has no canvas 2d context, and the sprite's animation loop is
// irrelevant to these setMessage()/defensive-clear assertions (which only read
// _message). This keeps the REAL component mounted without the canvas throw.
beforeEach(() => { document.documentElement.dataset.replaceBobbitWithText = "true"; });
afterEach(() => {
	delete document.documentElement.dataset.replaceBobbitWithText;
	document.body.innerHTML = "";
});

describe("StreamingMessageContainer.setMessage — sticky _immediateUpdate flag", () => {
	it("batched setMessage after immediate-clear must NOT be silently dropped by the rAF callback", async () => {
		const el: any = document.createElement("streaming-message-container");
		document.body.appendChild(el);
		// Wait one frame so the element is upgraded and connectedCallback ran.
		await nextFrame();

		// Step 1: immediate clear — sets `_immediateUpdate = true` then clears it
		// synchronously (the fix), returning without scheduling a rAF.
		el.setMessage(null, true);

		// Step 2: a batched streaming delta. Schedules a rAF. On master the rAF
		// saw a sticky `_immediateUpdate === true` and dropped the delta.
		const msg = { role: "assistant", content: [{ type: "text", text: "hello-delta" }], id: "msg-after-clear" };
		el.setMessage(msg, false);

		await nextFrame();
		await microtask();

		expect(el._message?.role ?? null, "batched delta must land in _message").toBe("assistant");
		expect(el._message?.id ?? null).toBe("msg-after-clear");
		expect(Array.isArray(el._message?.content) ? el._message.content[0]?.text ?? null : null).toBe("hello-delta");
	});

	it("defensive clear: when isStreaming flips true → false with a stale _message, the container clears itself", async () => {
		const el: any = document.createElement("streaming-message-container");
		el.isStreaming = true;
		document.body.appendChild(el);
		await nextFrame();
		await el.updateComplete;

		// Simulate a `message_update` mid-stream populating the container.
		el.setMessage({ role: "assistant", id: "msg-mid-stream", content: [{ type: "thinking", thinking: "hmm let me think" }] }, true);
		await el.updateComplete;
		expect(el._message?.id ?? null, "setup precondition: container holds the partial").toBe("msg-mid-stream");

		// Status flips to idle WITHOUT AgentInterface calling setMessage(null, true).
		// The container's updated() lifecycle must defensively clear the stale message.
		el.isStreaming = false;
		await el.updateComplete;

		expect(el._message, "isStreaming → false must trigger a defensive clear").toBeNull();

		// Drain the pending exit timer (≤900ms) while the element is still
		// connected so it can't fire as a straggler after teardown.
		await new Promise((r) => setTimeout(r, 1000));
	});

	it("a SECOND batched setMessage after the dropped one DOES land (proves only the first delta is lost)", async () => {
		const el: any = document.createElement("streaming-message-container");
		document.body.appendChild(el);
		await nextFrame();

		el.setMessage(null, true);
		el.setMessage({ role: "assistant", content: [{ type: "text", text: "first" }], id: "first" }, false);
		await nextFrame();

		// The flag has been cleared by the prior rAF callback, so this one MUST land.
		el.setMessage({ role: "assistant", content: [{ type: "text", text: "second" }], id: "second" }, false);
		await nextFrame();
		await microtask();

		expect(el._message?.id ?? null).toBe("second");
		expect(Array.isArray(el._message?.content) ? el._message.content[0]?.text ?? null : null).toBe("second");
	});
});
