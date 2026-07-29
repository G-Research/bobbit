import assert from "node:assert/strict";

import { describe, it } from "vitest";

import { generateToolResultErrorBridgeExtension } from "../../src/server/agent/tool-result-error-bridge-extension.js";

const FINAL_RESULT_MAX_BYTES = 50 * 1024;
const TARGET_HANDLE = "rs1:m0:b0:AAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TARGET_CALL_ID = "call-final-pagination-boundary";

async function loadGeneratedExtension(): Promise<(pi: any) => void> {
	const source = generateToolResultErrorBridgeExtension();
	const mod = await import(`data:text/javascript,${encodeURIComponent(source)}`);
	return mod.default;
}

function makePi() {
	const handlers = new Map<string, Function>();
	const pi: any = {
		tool(spec: any, handler?: Function) {
			const name = typeof spec === "string" ? spec : spec.name;
			handlers.set(name, handler ?? spec.handler ?? spec.execute);
		},
	};
	return { pi, handlers };
}

function parseEnvelope(result: any): any {
	return JSON.parse(result.content[0].text);
}

function finalJsonlBytes(value: any): number {
	const message = {
		role: "toolResult",
		toolCallId: TARGET_CALL_ID,
		toolName: "read_session",
		content: value.content,
		details: value.details,
		isError: false,
		timestamp: Number.MAX_SAFE_INTEGER,
	};
	const line = {
		type: "message",
		id: "0".repeat(36),
		parentId: "0".repeat(36),
		timestamp: "+999999-12-31T23:59:59.999Z",
		message,
	};
	return Buffer.byteLength(`${JSON.stringify(line)}\n`, "utf8");
}

function targetedEnvelope(excerptText: string, sizeChars = 10_000): any {
	return {
		total: 1,
		returned: 1,
		offsetStart: 0,
		offsetEnd: 0,
		messages: [{
			index: 0,
			role: "toolResult",
			toolResults: [{
				ref: "r1",
				name: "diagnostic_probe",
				status: "ok",
				size: { type: "string", chars: sizeChars, lines: 1, bytes: sizeChars },
				omitted: false,
				handle: TARGET_HANDLE,
				excerpt: {
					start: 0,
					end: excerptText.length,
					text: excerptText,
					nextCursor: excerptText.length,
					complete: excerptText.length >= sizeChars,
				},
			}],
		}],
	};
}

function oversizedFilteredRow(index: number): any {
	const escapedText = "\\\"\n".repeat(4_096).slice(0, 4_096);
	return {
		index,
		role: "assistant",
		text: escapedText,
		toolCalls: Array.from({ length: 12 }, (_, callIndex) => ({
			ref: `t${callIndex + 1}`,
			name: "bash",
			argumentsPreview: escapedText.slice(0, 512),
			argumentsTruncated: true,
		})),
	};
}

describe("final read_session pagination and projection boundary", () => {
	it("continues a filtered negative tail in filtered coordinates without overlap", async () => {
		const activate = await loadGeneratedExtension();
		const { pi, handlers } = makePi();
		activate(pi);
		const filteredSourceIndexes = [10, 20, 30, 40];
		pi.tool({ name: "read_session" }, async (_callId: string, params: any) => {
			const start = params.offset < 0
				? Math.max(0, filteredSourceIndexes.length + params.offset)
				: params.offset;
			const selected = filteredSourceIndexes.slice(start, start + params.limit);
			return {
				total: 100,
				matchCount: filteredSourceIndexes.length,
				returned: selected.length,
				offsetStart: selected[0] ?? -1,
				offsetEnd: selected.at(-1) ?? -1,
				messages: selected.map(oversizedFilteredRow),
			};
		});

		const first = parseEnvelope(await handlers.get("read_session")!(TARGET_CALL_ID, {
			session_id: "target",
			pattern: "needle",
			context: 0,
			offset: -2,
			limit: 2,
			verbose: true,
		}));
		assert.deepEqual(first.messages.map((message: any) => message.index), [30]);
		assert.equal(first.returned, 1);
		assert.equal(first.partial, true);
		assert.equal(first.truncatedBy, "transport_budget");
		assert.equal(first.nextOffset, 3,
			"the first omitted match is filtered position 3, not raw transcript position 99");
		assert.deepEqual(first.continuationRequest, { kind: "page", offset: 3 });

		const second = parseEnvelope(await handlers.get("read_session")!(TARGET_CALL_ID, {
			session_id: "target",
			pattern: "needle",
			context: 0,
			offset: first.nextOffset,
			limit: 2,
			verbose: true,
		}));
		assert.deepEqual(second.messages.map((message: any) => message.index), [40]);
		assert.equal(second.messages.some((message: any) => message.index === first.messages[0].index), false,
			"continuation must neither overlap the retained match nor skip the omitted match");
	});

	it("omits compact thinking and canonicalizes message aliases in all four modes", async () => {
		const activate = await loadGeneratedExtension();
		const resultPayload = JSON.stringify({ thinking: "domain-thinking", error: "domain-error" });
		const modes = [
			{ label: "compact", verbose: false, includeToolResults: false },
			{ label: "compact-with-results", verbose: false, includeToolResults: true },
			{ label: "verbose-redacted", verbose: true, includeToolResults: false },
			{ label: "verbose-with-results", verbose: true, includeToolResults: true },
		] as const;

		for (const mode of modes) {
			const { pi, handlers } = makePi();
			activate(pi);
			pi.tool({ name: "read_session" }, async () => ({
				total: 1,
				returned: 1,
				offsetStart: 0,
				offsetEnd: 0,
				messages: [{
					index: 0,
					role: "assistant",
					thinking: "T".repeat(600),
					thinkingSummary: "losing-thinking-alias",
					thinkingTruncated: false,
					error: "losing-error-alias",
					errorSummary: "E".repeat(600),
					errorTruncated: false,
					errorSummaryTruncated: false,
					toolResults: [{
						ref: "r1",
						name: "diagnostic_probe",
						status: "ok",
						size: {
							type: "string",
							chars: resultPayload.length,
							lines: 1,
							bytes: Buffer.byteLength(resultPayload),
						},
						omitted: false,
						handle: TARGET_HANDLE,
						excerpt: {
							start: 0,
							end: resultPayload.length,
							text: resultPayload,
							nextCursor: null,
							complete: true,
						},
					}],
				}],
			}));

			const projected = parseEnvelope(await handlers.get("read_session")!(TARGET_CALL_ID, {
				session_id: "target",
				limit: 1,
				verbose: mode.verbose,
				include_tool_results: mode.includeToolResults,
			}));
			const message = projected.messages[0];
			assert.equal(Object.hasOwn(message, "thinkingSummary"), false, mode.label);
			assert.equal(Object.hasOwn(message, "error"), false, mode.label);
			assert.equal(Object.hasOwn(message, "errorTruncated"), false, mode.label);
			assert.equal(message.errorSummary, "E".repeat(512), mode.label);
			assert.equal(message.errorSummaryTruncated, true, mode.label);
			if (mode.verbose) {
				assert.equal(message.thinking, "T".repeat(512), mode.label);
				assert.equal(message.thinkingTruncated, true, mode.label);
			} else {
				assert.equal(Object.hasOwn(message, "thinking"), false, mode.label);
				assert.equal(Object.hasOwn(message, "thinkingTruncated"), false, mode.label);
			}
			const excerpt = message.toolResults[0].excerpt;
			if (mode.includeToolResults) {
				assert.equal(excerpt.text, resultPayload,
					`${mode.label} must preserve legitimate payload keys rather than recursively scrubbing aliases`);
			} else {
				assert.equal(excerpt, undefined, mode.label);
			}
		}
	});

	it("uses excerpt cursors alone for an ordinary complete requested slice", async () => {
		const activate = await loadGeneratedExtension();
		const { pi, handlers } = makePi();
		activate(pi);
		pi.tool({ name: "read_session" }, async () => targetedEnvelope("ABCD"));

		const result = await handlers.get("read_session")!(TARGET_CALL_ID, {
			session_id: "target",
			result_handle: TARGET_HANDLE,
			result_cursor: 0,
			result_limit: 4,
		});
		const projected = parseEnvelope(result);
		assert.ok(finalJsonlBytes(result) <= FINAL_RESULT_MAX_BYTES);
		assert.equal(projected.partial, undefined);
		assert.equal(projected.truncatedBy, undefined);
		assert.equal(projected.continuationRequest, undefined);
		assert.deepEqual(projected.messages[0].toolResults[0].excerpt, {
			start: 0,
			end: 4,
			text: "ABCD",
			nextCursor: 4,
			complete: false,
		});
	});

	it("retains transport diagnostics when the final fitter shortens a targeted range", async () => {
		const activate = await loadGeneratedExtension();
		const { pi, handlers } = makePi();
		activate(pi);
		pi.tool({ name: "read_session" }, async () => targetedEnvelope("\0".repeat(8_192)));

		const result = await handlers.get("read_session")!(TARGET_CALL_ID, {
			session_id: "target",
			result_handle: TARGET_HANDLE,
			result_cursor: 0,
			result_limit: 8_192,
			verbose: true,
		});
		const projected = parseEnvelope(result);
		const excerpt = projected.messages[0].toolResults[0].excerpt;
		assert.ok(finalJsonlBytes(result) <= FINAL_RESULT_MAX_BYTES);
		assert.ok(excerpt.end > 0 && excerpt.end < 8_192,
			"the quote-heavy final wrapper must force a shorter targeted range");
		assert.equal(projected.partial, true);
		assert.equal(projected.truncatedBy, "transport_budget");
		assert.deepEqual(projected.continuationRequest, {
			kind: "result_slice",
			result_handle: TARGET_HANDLE,
			result_cursor: excerpt.end,
			result_limit: 8_192,
		});
	});
});
