// Migrated from tests/bg-wait-timer.spec.ts (v2-dom tier).
// Renders the REAL BgProcessRenderer for a `bash_bg wait` tool call into
// happy-dom (was an esbuild file:// bundle) and reads the <live-timer>'s
// resolved `.startTime`. Pins that the wait's elapsed-timer start anchor is
// the server-stamped assistant-message timestamp (ctx.toolCallStartTime) so a
// reload never resets it to "now"; only a missing anchor falls back to now.
import { afterEach, describe, expect, it } from "vitest";
import { render } from "lit";
import { BgProcessRenderer } from "../../src/ui/tools/renderers/BgProcessRenderer.js";
import "../../src/ui/components/LiveTimer.js";

const renderer = new BgProcessRenderer();

interface RenderOpts {
	startTime?: number;
	resultTimestamp?: number; // present ⇒ completed wait
	streaming?: boolean;
}

/** Render the wait card; returns the live-timer's `.startTime` property. */
function renderWait(opts: RenderOpts = {}): number | null {
	const host = document.createElement("div");
	document.body.appendChild(host);
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
	render(out.content, host);
	const timer = host.querySelector("live-timer") as (HTMLElement & { startTime?: number }) | null;
	return timer?.startTime ?? null;
}

afterEach(() => { document.body.innerHTML = ""; });

describe("bash_bg wait timer", () => {
	it("uses the server message timestamp as the start anchor, not now", () => {
		const startedAt = Date.now() - 90_000; // wait started 90s ago
		const resolved = renderWait({ startTime: startedAt, streaming: true });
		expect(resolved).toBe(startedAt);
	});

	it("does not reset on reload — a fresh render with the same anchor keeps it", () => {
		const startedAt = Date.now() - 45_000;
		// First render (initial load).
		renderWait({ startTime: startedAt, streaming: true });
		// Simulate a full reload: fresh render with the same persisted-from-
		// transcript anchor.
		document.body.innerHTML = "";
		const afterReload = renderWait({ startTime: startedAt, streaming: true });
		expect(afterReload).toBe(startedAt);
	});

	it("falls back to now only when no anchor is available", () => {
		const before = Date.now();
		const resolved = renderWait({ streaming: true }) as number;
		const after = Date.now();
		expect(resolved).toBeGreaterThanOrEqual(before - 1000);
		expect(resolved).toBeLessThanOrEqual(after + 1000);
	});
});
