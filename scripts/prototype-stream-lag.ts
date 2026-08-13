import { performance } from "node:perf_hooks";
import { EventBuffer } from "../src/server/agent/event-buffer.ts";
import { compactAssistantStreamDelta } from "../src/shared/assistant-stream-delta.ts";

const updates = Number.parseInt(process.env.PROTOTYPE_UPDATES ?? "1000", 10);
const finalTextBytes = Number.parseInt(process.env.PROTOTYPE_FINAL_BYTES ?? String(32 * 1024), 10);
const sessions = Number.parseInt(process.env.PROTOTYPE_SESSIONS ?? "35", 10);
const chunk = "x".repeat(Math.max(1, Math.ceil(finalTextBytes / updates)));
const replayBudget = EventBuffer.DEFAULT_MAX_BYTES;

function wireBytes(event: unknown, seq: number): number {
	return Buffer.byteLength(JSON.stringify({ type: "event", data: event, seq, ts: 1_735_000_000_000 }), "utf8");
}

function update(text: string, delta: string) {
	const message = {
		role: "assistant",
		id: "prototype-message",
		provider: "openai-codex",
		model: "prototype",
		content: [{ type: "text", text }],
		timestamp: 1_735_000_000_000,
	};
	return {
		type: "message_update",
		message,
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta,
			partial: structuredClone(message),
		},
	};
}

interface VariantResult {
	name: string;
	wireBytes: number;
	retainedBytes: number;
	retainedEntries: number;
	wallMs: number;
	finalFrameBytes: number;
}

function runVariant(name: string, compact: boolean, maxBytes: number, retainCumulative = false): VariantResult {
	const buffer = new EventBuffer(1000, maxBytes);
	let text = "";
	let previousMessage: unknown;
	let totalWireBytes = 0;
	let finalFrameBytes = 0;
	const started = performance.now();
	for (let index = 0; index < updates; index++) {
		const delta = index === updates - 1
			? "x".repeat(Math.max(0, finalTextBytes - text.length))
			: chunk.slice(0, Math.min(chunk.length, Math.max(0, finalTextBytes - text.length)));
		text += delta;
		const cumulative = update(text, delta);
		const event = compact ? compactAssistantStreamDelta(cumulative, previousMessage) : cumulative;
		// The MVP compacts capable live-client frames but deliberately retains the
		// authoritative cumulative event so replay never depends on a delta chain.
		const entry = buffer.push(retainCumulative ? cumulative : event);
		const bytes = wireBytes(event, entry.seq);
		totalWireBytes += bytes;
		finalFrameBytes = bytes;
		// The gateway already has the authoritative cumulative source message. Client
		// reconstruction correctness is measured separately by the round-trip tests.
		if (compact) previousMessage = cumulative.message;
	}
	return {
		name,
		wireBytes: totalWireBytes,
		retainedBytes: buffer.retainedBytes,
		retainedEntries: buffer.size,
		wallMs: performance.now() - started,
		finalFrameBytes,
	};
}

const baseline = runVariant("cumulative-count-only", false, Number.MAX_SAFE_INTEGER);
const bounded = runVariant("cumulative-byte-bounded", false, replayBudget);
const mvp = runVariant("compact-live-cumulative-replay", true, replayBudget, true);
const compact = runVariant("compact-delta-byte-bounded", true, replayBudget);
const percent = (candidate: number, base: number) => Number((100 * (1 - candidate / base)).toFixed(2));
const mib = (bytes: number) => Number((bytes / 1024 / 1024).toFixed(3));
const gib = (bytes: number) => Number((bytes / 1024 / 1024 / 1024).toFixed(3));

const report = {
	kind: "stream-lag-prototype",
	generatedAt: new Date().toISOString(),
	shape: { sessions, updatesPerSession: updates, finalTextBytes, replayBudgetBytes: replayBudget },
	perSession: [baseline, bounded, mvp, compact].map((row) => ({
		...row,
		wireMiB: mib(row.wireBytes),
		retainedMiB: mib(row.retainedBytes),
	})),
	extrapolated: {
		baselineWireGiB: gib(baseline.wireBytes * sessions),
		mvpWireGiB: gib(mvp.wireBytes * sessions),
		compactWireGiB: gib(compact.wireBytes * sessions),
		baselineRetainedGiB: gib(baseline.retainedBytes * sessions),
		boundedRetainedGiB: gib(bounded.retainedBytes * sessions),
		mvpRetainedGiB: gib(mvp.retainedBytes * sessions),
		compactRetainedGiB: gib(compact.retainedBytes * sessions),
	},
	reduction: {
		byteBoundRetainedPct: percent(bounded.retainedBytes, baseline.retainedBytes),
		mvpWirePct: percent(mvp.wireBytes, baseline.wireBytes),
		mvpRetainedPct: percent(mvp.retainedBytes, baseline.retainedBytes),
		mvpWallPct: percent(mvp.wallMs, baseline.wallMs),
		compactWirePct: percent(compact.wireBytes, baseline.wireBytes),
		byteBoundPlusCompactRetainedPct: percent(compact.retainedBytes, baseline.retainedBytes),
		compactVsByteBoundRetainedPct: percent(compact.retainedBytes, bounded.retainedBytes),
		compactWallPct: percent(compact.wallMs, baseline.wallMs),
	},
	backpressure: {
		baselineFramesAtFinalSizeBefore1MiB: Math.floor((1024 * 1024) / baseline.finalFrameBytes),
		baselineFramesAtFinalSizeBefore4MiB: Math.floor((4 * 1024 * 1024) / baseline.finalFrameBytes),
		compactFramesAtFinalSizeBefore1MiB: Math.floor((1024 * 1024) / compact.finalFrameBytes),
		compactFramesAtFinalSizeBefore4MiB: Math.floor((4 * 1024 * 1024) / compact.finalFrameBytes),
	},
};

console.log(JSON.stringify(report, null, 2));
