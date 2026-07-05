import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/ui-fixtures/compaction-widget.spec.ts (v2-dom tier).
// Renders the REAL CompactionSummaryRenderer via lit into a single happy-dom
// container (was an esbuild file:// bundle). Re-rendering into the SAME container
// gives lit's diff the single-card identity the legacy spec pinned
// (docs/design/compaction-e2e-rich-summary.md §7.4). Same state-transition facts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "lit";
import { CompactionSummaryRenderer } from "../../../src/ui/tools/renderers/CompactionSummaryRenderer.js";
import {
	buildCompactionSummaryMessages,
	buildInProgressCompactionPayload,
	type CompactionSummaryPayload,
	type CompactionTrigger,
} from "../../../src/app/compaction-types.js";

let container: HTMLElement;

function renderPayload(payload: CompactionSummaryPayload) {
	// Mirror how the renderer-registry invokes the renderer: pass the payload via
	// the `result.details` slot so the renderer's `payload = result?.details ?? params`
	// primary resolution path is exercised.
	const { toolResult } = buildCompactionSummaryMessages(payload);
	const out = new CompactionSummaryRenderer().render(payload, toolResult as any, false);
	render(out.content, container);
}

function applyInProgress(trigger: CompactionTrigger, tokensBefore: number | null = null) {
	renderPayload(buildInProgressCompactionPayload(trigger, tokensBefore));
}

function applyComplete(extra: Partial<CompactionSummaryPayload> = {}) {
	renderPayload({
		schemaVersion: 1, trigger: "overflow", state: "complete", success: true,
		timestamp: "2026-05-12T00:00:01Z", tokensBefore: 202_592, tokensAfter: 180_000, reductionPct: 11.2,
		...extra,
	});
}

function applyError(extra: Partial<CompactionSummaryPayload> = {}) {
	renderPayload({
		schemaVersion: 1, trigger: "overflow", state: "error", success: false,
		timestamp: "2026-05-12T00:00:01Z", tokensBefore: 202_592, tokensAfter: null, reductionPct: null,
		error: "prompt is too long: 202592 tokens > 200000 maximum",
		...extra,
	});
}

const cards = () => container.querySelectorAll("[data-testid='compaction-summary-card']");
const card = () => cards()[0] as HTMLElement;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
});
afterEach(() => { document.body.innerHTML = ""; });

describe("CompactionSummaryRenderer", () => {
	it("in-progress → complete: single card, same identity", () => {
		applyInProgress("overflow", 202_592);
		expect(cards().length).toBe(1);
		expect(card().getAttribute("data-state")).toBe("in-progress");
		expect(card().textContent).toContain("Compacting context…");

		// Transition to complete — a SINGLE header row, no before/after badges.
		applyComplete({ tokensBefore: 202_592, tokensAfter: 180_000, reductionPct: 11.2 });
		expect(card().getAttribute("data-state")).toBe("complete");
		expect(cards().length).toBe(1);
		expect(card().textContent).toContain("Context compacted");
		expect(card().querySelectorAll("[data-test='tokens-before']").length).toBe(0);
		expect(card().querySelectorAll("[data-test='tokens-after']").length).toBe(0);
		expect(card().querySelectorAll("[data-test='reduction-pct']").length).toBe(0);
	});

	it("in-progress → error: hard compaction failure surfaces raw upstream error", () => {
		applyInProgress("manual", null);
		expect(card().getAttribute("data-state")).toBe("in-progress");

		applyError({ trigger: "manual", error: "Compaction RPC timed out after 120s" });
		expect(card().getAttribute("data-state")).toBe("error");
		expect(card().querySelector("[data-test='error']")?.textContent).toContain("timed out");
		expect(cards().length).toBe(1);
	});
});
