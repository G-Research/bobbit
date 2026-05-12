// Test entry — bundles CompactionSummaryRenderer for a file:// fixture.
import { render } from "lit";
import { CompactionSummaryRenderer } from "../../src/ui/tools/renderers/CompactionSummaryRenderer.js";
import {
	buildCompactionSummaryMessages,
	buildInProgressCompactionPayload,
	type CompactionSummaryPayload,
	type CompactionTrigger,
} from "../../src/app/compaction-types.js";

const container = document.getElementById("container")!;

function renderPayload(payload: CompactionSummaryPayload) {
	// Mirror how the renderer-registry invokes the renderer: pass the
	// payload via the `result.details` slot so the renderer's primary
	// `payload = result?.details ?? params` resolution path is exercised.
	const { toolResult } = buildCompactionSummaryMessages(payload);
	const r = new CompactionSummaryRenderer();
	const out = r.render(payload, toolResult as any, false);
	render(out.content, container);
}

(window as any).applyInProgress = (trigger: CompactionTrigger, tokensBefore: number | null = null) => {
	renderPayload(buildInProgressCompactionPayload(trigger, tokensBefore));
};

(window as any).applyComplete = (extra: Partial<CompactionSummaryPayload> = {}) => {
	const payload: CompactionSummaryPayload = {
		schemaVersion: 1,
		trigger: "overflow",
		state: "complete",
		success: true,
		timestamp: "2026-05-12T00:00:01Z",
		tokensBefore: 202_592,
		tokensAfter: 180_000,
		reductionPct: 11.2,
		...extra,
	};
	renderPayload(payload);
};

(window as any).applyError = (extra: Partial<CompactionSummaryPayload> = {}) => {
	const payload: CompactionSummaryPayload = {
		schemaVersion: 1,
		trigger: "overflow",
		state: "error",
		success: false,
		timestamp: "2026-05-12T00:00:01Z",
		tokensBefore: 202_592,
		tokensAfter: null,
		reductionPct: null,
		error: "prompt is too long: 202592 tokens > 200000 maximum",
		...extra,
	};
	renderPayload(payload);
};

(window as any).__ready = true;
