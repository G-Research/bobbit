import { render } from "lit";
import { BgProcessRenderer } from "../../src/ui/tools/renderers/BgProcessRenderer.js";
import "../../src/ui/components/LiveTimer.js";

/**
 * Test harness for the `bash_bg wait` live-elapsed timer.
 *
 * Renders the REAL BgProcessRenderer for a `wait` tool call and exposes the
 * `<live-timer>`'s resolved `startTime`. The fix under test: the start anchor
 * is the server-stamped assistant-message timestamp threaded as
 * `ctx.toolCallStartTime`, so a reload (a fresh render with the same ctx)
 * reads the same value back instead of resetting to "now".
 */

const renderer = new BgProcessRenderer();

function host(): HTMLElement {
	const el = document.getElementById("render-host");
	if (!el) throw new Error("missing #render-host");
	return el;
}

interface RenderOpts {
	startTime?: number;
	resultTimestamp?: number; // present ⇒ completed wait
	streaming?: boolean;
}

/** Render the wait card; returns the live-timer's `.startTime` property. */
function renderWait(opts: RenderOpts = {}): number | null {
	const params = { action: "wait", id: "bg-1", timeout: 300 };
	const result = opts.resultTimestamp
		? {
			role: "toolResult",
			isError: false,
			content: [{ type: "text", text: "Process bg-1 (job) exited with code 0." }],
			toolCallId: "tc-1",
			toolName: "bash_bg",
			timestamp: opts.resultTimestamp,
		}
		: undefined;
	const out = renderer.render(
		params as any,
		result as any,
		opts.streaming ?? false,
		{ toolUseId: "tc-1", toolCallStartTime: opts.startTime } as any,
	);
	render(out.content, host());
	const timer = host().querySelector("live-timer") as (HTMLElement & { startTime?: number }) | null;
	return timer?.startTime ?? null;
}

Object.assign(window, {
	renderWait,
	__bgWaitTimerReady: true,
});
