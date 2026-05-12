/**
 * Pure unit tests for compaction-types helpers — `parseOverflowTokenCount`,
 * `buildInProgressCompactionPayload`, `buildCompactionSummaryMessages`
 * stable-id invariant.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	COMPACTION_ACTIVE_ID,
	COMPACTION_ACTIVE_TOOLCALL_ID,
	buildCompactionSummaryMessages,
	buildInProgressCompactionPayload,
	parseOverflowTokenCount,
} from "../src/app/compaction-types.ts";

describe("compaction-types", () => {
	it("parseOverflowTokenCount: canonical Anthropic 400 string", () => {
		assert.strictEqual(
			parseOverflowTokenCount("prompt is too long: 202592 tokens > 200000 maximum"),
			202_592,
		);
	});

	it("parseOverflowTokenCount: handles wrapped / multi-line", () => {
		const wrapped = "AnthropicError: 400 Bad Request\n  prompt is too long: 156789 tokens > 200000 maximum";
		assert.strictEqual(parseOverflowTokenCount(wrapped), 156_789);
	});

	it("parseOverflowTokenCount: returns null for unrelated / empty input", () => {
		assert.strictEqual(parseOverflowTokenCount(""), null);
		assert.strictEqual(parseOverflowTokenCount(null), null);
		assert.strictEqual(parseOverflowTokenCount(undefined), null);
		assert.strictEqual(parseOverflowTokenCount("rate limited"), null);
	});

	it("buildInProgressCompactionPayload: shape is correct", () => {
		const p = buildInProgressCompactionPayload("overflow", 202_592);
		assert.strictEqual(p.trigger, "overflow");
		assert.strictEqual(p.state, "in-progress");
		assert.strictEqual(p.success, true);
		assert.strictEqual(p.tokensBefore, 202_592);
		assert.strictEqual(p.tokensAfter, null);
		assert.strictEqual(p.reductionPct, null);
		assert.match(p.timestamp, /^\d{4}-\d{2}-\d{2}T/);
	});

	it("buildCompactionSummaryMessages: stable id across all three states", () => {
		const base = {
			schemaVersion: 1 as const,
			trigger: "overflow" as const,
			success: true,
			timestamp: "2026-05-12T00:00:00Z",
			tokensBefore: 200_000,
			tokensAfter: null,
			reductionPct: null,
		};
		const { message: mInProg, toolResult: rInProg } = buildCompactionSummaryMessages({
			...base, state: "in-progress",
		});
		const { message: mDone, toolResult: rDone } = buildCompactionSummaryMessages({
			...base, state: "complete", tokensAfter: 100_000, reductionPct: 50,
		});
		const { message: mErr, toolResult: rErr } = buildCompactionSummaryMessages({
			...base, state: "error", success: false, error: "boom",
		});
		assert.strictEqual(mInProg.id, COMPACTION_ACTIVE_ID);
		assert.strictEqual(mDone.id, COMPACTION_ACTIVE_ID);
		assert.strictEqual(mErr.id, COMPACTION_ACTIVE_ID);
		const tcId = (m: any) => m.content[0].id;
		assert.strictEqual(tcId(mInProg), COMPACTION_ACTIVE_TOOLCALL_ID);
		assert.strictEqual(tcId(mDone), COMPACTION_ACTIVE_TOOLCALL_ID);
		assert.strictEqual(tcId(mErr), COMPACTION_ACTIVE_TOOLCALL_ID);
		// toolResult isError mirrors state
		assert.strictEqual(rInProg.isError, false);
		assert.strictEqual(rDone.isError, false);
		assert.strictEqual(rErr.isError, true);
	});
});
