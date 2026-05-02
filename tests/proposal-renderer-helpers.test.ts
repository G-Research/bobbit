/**
 * Unit tests for proposal-renderer pure helpers.
 *
 * These cover marker parsing only — full DOM rendering is exercised by the
 * E2E suite (tests/e2e/ui/proposal-revision-snapshots.spec.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Import via the renderer module — the helpers are exported.
import { parseRevFromResult, parseErrorCodeFromResult } from "../src/ui/tools/renderers/proposal-rev-marker.ts";

function mkResult(text: string) {
	return {
		role: "toolResult" as const,
		toolCallId: "t1",
		toolName: "propose_goal",
		isError: false,
		content: [{ type: "text", text }],
		timestamp: 0,
	} as any;
}

describe("parseRevFromResult", () => {
	it("returns undefined when result is undefined", () => {
		assert.equal(parseRevFromResult(undefined), undefined);
	});

	it("returns undefined when no marker present", () => {
		assert.equal(parseRevFromResult(mkResult("plain ack with no marker")), undefined);
	});

	it("parses single-line marker", () => {
		assert.equal(
			parseRevFromResult(mkResult("Proposal submitted.\n__proposal_rev_v1__:7")),
			7,
		);
	});

	it("parses marker embedded in JSON tool-result body", () => {
		const text = JSON.stringify({ ok: true, rev: 12 }, null, 2) + "\n__proposal_rev_v1__:12";
		assert.equal(parseRevFromResult(mkResult(text)), 12);
	});

	it("ignores rev=0 (degraded snapshot mode)", () => {
		assert.equal(
			parseRevFromResult(mkResult("ack\n__proposal_rev_v1__:0")),
			undefined,
		);
	});

	it("scans multiple content blocks", () => {
		const r = {
			role: "toolResult" as const,
			toolCallId: "t1",
			toolName: "propose_goal",
			isError: false,
			content: [
				{ type: "text", text: "first block" },
				{ type: "text", text: "__proposal_rev_v1__:42" },
			],
			timestamp: 0,
		} as any;
		assert.equal(parseRevFromResult(r), 42);
	});

	it("rejects non-numeric markers", () => {
		assert.equal(
			parseRevFromResult(mkResult("__proposal_rev_v1__:abc")),
			undefined,
		);
	});
});

describe("parseErrorCodeFromResult", () => {
	it("returns undefined when no JSON body", () => {
		assert.equal(parseErrorCodeFromResult(mkResult("plain text")), undefined);
	});

	it("extracts code from JSON body", () => {
		const body = JSON.stringify({ ok: false, code: "OLD_TEXT_NOT_FOUND", message: "x" });
		assert.equal(parseErrorCodeFromResult(mkResult(body)), "OLD_TEXT_NOT_FOUND");
	});

	it("returns undefined when JSON has no code", () => {
		const body = JSON.stringify({ ok: true, rev: 1 });
		assert.equal(parseErrorCodeFromResult(mkResult(body)), undefined);
	});
});
