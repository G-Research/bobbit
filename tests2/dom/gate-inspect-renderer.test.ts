import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/gate-inspect-renderer.spec.ts (v2-dom tier).
// The legacy fixture reimplemented the renderer's decision logic in plain JS. This
// port renders the REAL GateInspectRenderer via lit into happy-dom and asserts the
// same user-visible DOM facts (header text, arg-summary, step statuses/chevrons,
// expand/collapse, signal rows, pluralization). getToolState/isSkippedToolResult
// are imported directly (they are exported helpers).
import { afterEach, describe, expect, it } from "vitest";
import { render } from "lit";
import { GateInspectRenderer } from "../../src/ui/tools/renderers/GateInspectRenderer.js";
import { getToolState, isSkippedToolResult } from "../../src/ui/tools/renderer-registry.js";
// Pre-import the markdown chunk the renderer lazy-loads (ensureMarkdownBlock) so the
// <markdown-block> @customElement decorator runs while happy-dom's customElements is
// live (see gate-signal-renderer.test.ts for the rationale).
import "../../src/ui/lazy/safe-markdown-block.js";

const toolResult = (data: any, isError = false) => ({ isError, content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }] }) as unknown as import("@earendil-works/pi-ai").ToolResultMessage;

function renderInspect(params: any, result?: any, isStreaming?: boolean): HTMLElement {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const out = new GateInspectRenderer().render(params, result, isStreaming);
	render(out.content, container);
	return container;
}

const argSummary = (c: HTMLElement) => c.querySelector('span[class*="leading-none"]') as HTMLElement | null;
const stepCards = (c: HTMLElement) => Array.from(c.querySelectorAll("div.border.border-border.rounded")) as HTMLElement[];

afterEach(() => { document.body.innerHTML = ""; });

describe("GateInspectRenderer", () => {
	// ── Loading / Error / Skipped ────────────────────────────────────
	it("loading state shows inprogress when streaming", () => {
		expect(getToolState(undefined, true)).toBe("inprogress");
		const c = renderInspect({ gate_id: "design-doc" }, undefined, true);
		expect(c.textContent).toContain("Inspecting gate");
		expect(c.textContent).toContain("design-doc");
	});

	it("error result shows error branch", () => {
		const result = toolResult("Gate not found", true);
		expect(getToolState(result)).toBe("error");
		expect(isSkippedToolResult(result)).toBe(false);
		const c = renderInspect({ gate_id: "impl" }, result);
		expect(c.textContent).toContain("Failed to inspect gate");
		expect(c.textContent).toContain("Gate not found");
	});

	it("skipped result shows skipped branch", () => {
		const result = toolResult("Skipped due to queued user message", true);
		expect(isSkippedToolResult(result)).toBe(true);
		const c = renderInspect({ gate_id: "impl" }, result);
		expect(c.textContent).toContain("Aborted inspect of gate");
	});

	// ── Arg summary formatting (via the rendered top-right badge) ─────
	it("top-right argument summary formats inspect modes", () => {
		const longPattern = "really-long-error-pattern|failed-with-a-very-specific-message|timeout";

		let c = renderInspect({ mode: "grep", pattern: "error|failed", context: 2, max_results: 10 }, toolResult({ section: "content" }));
		expect(argSummary(c)!.getAttribute("title")).toBe('grep "error|failed" · ctx 2 · max 10');

		c = renderInspect({ mode: "grep", pattern: longPattern }, toolResult({ section: "content" }));
		expect(argSummary(c)!.textContent).toBe('grep "really-long-error-pattern|failed-with-a…"');
		expect(argSummary(c)!.getAttribute("title")).toBe('grep "really-long-error-pattern|failed-with-a-very-specific-message|timeout"');

		c = renderInspect({ mode: "slice", from: 120, to: 180 }, toolResult({ section: "content" }));
		expect(argSummary(c)!.getAttribute("title")).toBe("slice 120–180");

		c = renderInspect({ mode: "tail", lines: 80 }, toolResult({ section: "content", selection: { mode: "tail", range: { from: 41, to: 120 } } }));
		expect(argSummary(c)!.getAttribute("title")).toBe("tail 41–120");

		c = renderInspect({ section: "verification", step: "E2E tests", mode: "tail", lines: 120 }, toolResult({ section: "verification", steps: [] }));
		expect(argSummary(c)!.getAttribute("title")).toBe("step E2E tests · tail 120 lines");
	});

	// ── section="content" ────────────────────────────────────────────
	it("content section with text renders a markdown-block with the content", () => {
		const c = renderInspect({ gate_id: "design-doc" }, toolResult({ section: "content", signalIndex: 0, signalId: "sig-abc", text: "# Design\nHello" }));
		expect(c.textContent).toContain("Signal #0");
		expect(c.textContent).toContain("sig-abc");
		const md = c.querySelector("markdown-block") as any;
		expect(md).toBeTruthy();
		expect(md.content).toBe("# Design\nHello");
	});

	it("content section with null text shows No content and no markdown-block", () => {
		const c = renderInspect({ gate_id: "design-doc" }, toolResult({ section: "content", signalIndex: 1, text: null }));
		expect(c.textContent).toContain("Signal #1");
		expect(c.textContent).toContain("No content");
		expect(c.querySelector("markdown-block")).toBeNull();
	});

	// ── section="verification" ───────────────────────────────────────
	it("verification section derives step statuses and expand defaults", () => {
		const c = renderInspect({ gate_id: "impl" }, toolResult({
			section: "verification", signalIndex: 0, signalId: "sig-1",
			steps: [
				{ name: "typecheck", type: "command", passed: true, duration_ms: 5000, output: "OK" },
				{ name: "test", type: "command", passed: false, duration_ms: 12000, output: "FAIL: 2 errors" },
				{ name: "review", type: "agent", skipped: true },
			],
		}));
		const cards = stepCards(c);
		expect(cards).toHaveLength(3);

		// passed → collapsed (hidden output, ▾ chevron)
		expect(cards[0].textContent).toContain("passed");
		expect((cards[0].querySelector("[data-step-output]") as HTMLElement).classList.contains("hidden")).toBe(true);
		expect(cards[0].querySelector("[data-step-chevron]")!.textContent).toBe("▾");

		// failed → expanded (visible output, ▴ chevron)
		expect(cards[1].textContent).toContain("failed");
		expect((cards[1].querySelector("[data-step-output]") as HTMLElement).classList.contains("hidden")).toBe(false);
		expect(cards[1].querySelector("[data-step-chevron]")!.textContent).toBe("▴");

		// skipped, no output → no output element / chevron
		expect(cards[2].textContent).toContain("skipped");
		expect(cards[2].querySelector("[data-step-output]")).toBeNull();
		expect(cards[2].querySelector("[data-step-chevron]")).toBeNull();
	});

	it("verification section prefers explicit active status over passed=false placeholders", () => {
		const c = renderInspect({ gate_id: "impl" }, toolResult({
			section: "verification", signalIndex: 0, signalId: "sig-active",
			summary: "1 passed, 1 running, 1 waiting, 1 blocked",
			steps: [
				{ name: "typecheck", type: "command", status: "passed", passed: true, duration_ms: 5000, output: "OK" },
				{ name: "test", type: "command", status: "running", passed: false, duration_ms: 12000, output: "running tail" },
				{ name: "review", type: "llm-review", status: "waiting", passed: false, duration_ms: 0, output: "" },
				{ name: "qa", type: "agent-qa", status: "blocked-by-earlier-failure", passed: false, duration_ms: 0 },
			],
		}));
		expect(c.textContent).toContain("1 passed, 1 running, 1 waiting, 1 blocked");
		const cards = stepCards(c);
		// status labels (badge text) in order
		const badge = (card: HTMLElement) => card.querySelector('span[class*="/15"], span[class*="bg-muted"]');
		expect(cards[0].textContent).toContain("passed");
		expect(cards[1].textContent).toContain("running");
		expect(cards[2].textContent).toContain("waiting");
		expect(cards[3].textContent).toContain("blocked");
		void badge;
		// showsDuration: running step (12s) shows; waiting/blocked (0ms) do not.
		expect(cards[1].querySelector(".tabular-nums")).toBeTruthy();
		expect(cards[2].querySelector(".tabular-nums")).toBeNull();
		expect(cards[3].querySelector(".tabular-nums")).toBeNull();
	});

	// ── Verification step expand/collapse (DOM-direct) ───────────────
	it("failed steps start expanded, passed steps start collapsed", () => {
		const c = renderInspect({ gate_id: "impl" }, toolResult({
			section: "verification",
			steps: [
				{ name: "typecheck", type: "command", passed: true, output: "all good" },
				{ name: "test", type: "command", passed: false, output: "FAIL: 2 errors" },
				{ name: "lint", type: "command", passed: true, output: "0 warnings" },
			],
		}));
		const cards = stepCards(c);
		expect((cards[0].querySelector("[data-step-output]") as HTMLElement).classList.contains("hidden")).toBe(true);
		expect(cards[0].querySelector("[data-step-chevron]")!.textContent).toBe("▾");
		expect((cards[1].querySelector("[data-step-output]") as HTMLElement).classList.contains("hidden")).toBe(false);
		expect(cards[1].querySelector("[data-step-chevron]")!.textContent).toBe("▴");
		expect((cards[2].querySelector("[data-step-output]") as HTMLElement).classList.contains("hidden")).toBe(true);
		expect(cards[2].querySelector("[data-step-chevron]")!.textContent).toBe("▾");
	});

	it("clicking a collapsed step expands it via DOM toggle", () => {
		const c = renderInspect({ gate_id: "impl" }, toolResult({
			section: "verification",
			steps: [{ name: "typecheck", type: "command", passed: true, output: "all good" }],
		}));
		const card = stepCards(c)[0];
		const output = card.querySelector("[data-step-output]") as HTMLElement;
		expect(output.classList.contains("hidden")).toBe(true);
		(card.querySelector(".cursor-pointer") as HTMLElement).click();
		expect(output.classList.contains("hidden")).toBe(false);
		expect(card.querySelector("[data-step-chevron]")!.textContent).toBe("▴");
	});

	it("clicking an expanded step collapses it", () => {
		const c = renderInspect({ gate_id: "impl" }, toolResult({
			section: "verification",
			steps: [{ name: "test", type: "command", passed: false, output: "FAIL" }],
		}));
		const card = stepCards(c)[0];
		const output = card.querySelector("[data-step-output]") as HTMLElement;
		expect(output.classList.contains("hidden")).toBe(false);
		(card.querySelector(".cursor-pointer") as HTMLElement).click();
		expect(output.classList.contains("hidden")).toBe(true);
		expect(card.querySelector("[data-step-chevron]")!.textContent).toBe("▾");
	});

	// ── section="signals" ────────────────────────────────────────────
	it("signals section uses verdict badge and formatted timestamp", () => {
		const c = renderInspect({ gate_id: "impl" }, toolResult({
			section: "signals",
			signals: [
				{ index: 0, verdict: "passed", timestamp: "2026-04-13T10:00:00Z", hasContent: true, sessionId: "abc12345-6789" },
				{ index: 1, verdict: "failed", timestamp: "2026-04-13T11:00:00Z", hasContent: false, sessionId: "def98765-4321" },
			],
		}));
		const rows = Array.from(c.querySelectorAll("div.flex.items-center.gap-2")).filter(r => r.textContent?.includes("#")) as HTMLElement[];
		// Verdict badges read the `verdict` field (not `status`); a wrong field would
		// render an empty badge. Timestamps read `timestamp` (not `signalledAt`);
		// a wrong field would render "Invalid Date".
		expect(c.textContent).toContain("passed");
		expect(c.textContent).toContain("failed");
		expect(rows[0].textContent).toContain("2026");
		expect(rows[1].textContent).toContain("2026");
	});

	it("signals row includes hasContent marker and truncated sessionId", () => {
		const c = renderInspect({ gate_id: "impl" }, toolResult({
			section: "signals",
			signals: [{ index: 0, verdict: "passed", timestamp: "2026-04-13T10:00:00Z", hasContent: true, sessionId: "abc12345-6789-full-id" }],
		}));
		expect(c.textContent).toContain("abc12345");
		expect(c.textContent).not.toContain("abc12345-6789-full-id");
		expect(c.textContent).toContain("📄");
	});

	// ── Pluralization / collapsibility ───────────────────────────────
	it("1 signal is singular and not collapsible", () => {
		const c = renderInspect({ gate_id: "impl" }, toolResult({
			section: "signals",
			signals: [{ index: 0, verdict: "passed", timestamp: "2026-04-13T10:00:00Z" }],
		}));
		expect(c.textContent).toContain("1 signal");
		expect(c.textContent).not.toContain("1 signals");
		expect(c.querySelector(".max-h-0")).toBeNull();
	});

	it("0 signals is plural", () => {
		const c = renderInspect({ gate_id: "impl" }, toolResult({ section: "signals", signals: [] }));
		expect(c.textContent).toContain("0 signals");
	});

	it("6 signals uses the collapsible header with correct pluralization", () => {
		const signals = Array.from({ length: 6 }, (_, i) => ({ index: i, verdict: "passed", timestamp: "2026-04-13T10:00:00Z" }));
		const c = renderInspect({ gate_id: "impl" }, toolResult({ section: "signals", signals }));
		expect(c.textContent).toContain("6 signals");
		expect(c.querySelector(".max-h-0")).toBeTruthy();
	});
});
