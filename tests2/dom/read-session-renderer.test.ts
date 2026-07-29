import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "lit";
import { ReadSessionRenderer } from "../../src/ui/tools/renderers/ReadSessionRenderer.js";

const SESSION_ID = "12345678-1234-4123-8123-123456789abc";

function toolResult(envelope: unknown, details: Record<string, unknown> = {}, leadingText?: string): any {
	return {
		role: "toolResult",
		toolCallId: "read-session-call",
		toolName: "read_session",
		isError: false,
		content: [
			...(leadingText === undefined ? [] : [{ type: "text", text: leadingText }]),
			{ type: "text", text: JSON.stringify(envelope) },
		],
		details,
		timestamp: Date.now(),
	};
}

function renderCard(result: any, params: Record<string, unknown> = { session_id: SESSION_ID }): HTMLElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const output = new ReadSessionRenderer().render(params as any, result, false);
	render(output.content, host);
	return host;
}

function directEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		total: 1,
		returned: 1,
		offsetStart: 0,
		offsetEnd: 0,
		messages: [{ index: 0, role: "user", ts: null, text: "direct page" }],
		...overrides,
	};
}

async function waitForFetchCalls(fetchMock: ReturnType<typeof vi.fn>, count: number): Promise<void> {
	await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(count));
	await Promise.resolve();
}

afterEach(() => {
	document.body.innerHTML = "";
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("ReadSessionRenderer canonical envelopes", () => {
	it("parses content JSON, resolves author refs, and renders bounded canonical calls and results", () => {
		const rawDetailsSentinel = "RAW_DETAILS_RESULT_MUST_NOT_RENDER";
		const envelope = {
			total: 18,
			returned: 3,
			offsetStart: 6,
			offsetEnd: 8,
			nextOffset: 9,
			partial: true,
			truncatedBy: "transport_budget",
			continuationRequest: { kind: "page", offset: 9 },
			authors: {
				a1: { kind: "agent", id: "agent-long-id-is-not-repeated", label: "<Cy & Team>" },
			},
			messages: [
				{
					index: 6,
					role: "assistant",
					ts: "2025-01-01T12:00:00.000Z",
					text: "",
					authorRef: "a1",
					toolCalls: [{
						ref: "t1",
						name: "read_session",
						argumentsPreview: "{\"limit\":2}",
						argumentsTruncated: true,
					}],
					toolResults: [{
						ref: "t1",
						name: "read_session",
						status: "ok",
						size: { type: "array", chars: 1501, lines: 42, bytes: 1707, blocks: 3 },
						omitted: true,
						handle: "rs1:m6:b0:bounded-handle",
					}],
				},
				{
					index: 7,
					role: "toolResult",
					ts: null,
					text: "",
					toolResults: [{
						ref: "r1",
						name: "bash",
						status: "error",
						size: { type: "string", chars: 11, lines: 1, bytes: 15 },
						omitted: false,
						handle: "rs1:m7:b0:excerpt-handle",
						excerpt: { start: 0, end: 11, text: "<b>safe</b>", nextCursor: 11, complete: false },
					}],
				},
				{
					index: 8,
					role: "assistant",
					projectionOmitted: true,
					toolCallCount: 5,
					toolResultCount: 4,
				},
			],
		};
		const host = renderCard(toolResult(envelope, {
			session_id: SESSION_ID,
			total: 999,
			returned: 999,
			messages: [{ text: rawDetailsSentinel }],
		}, "not json"));

		const text = host.textContent || "";
		expect(text).toContain("3 of 18");
		expect(text).toContain("partial");
		expect(text).toContain("continue at offset 9");
		expect(text).toContain("<Cy & Team>");
		expect(text).toContain("read_session({\"limit\":2}…)");
		expect(text).toContain("arguments truncated");
		expect(text).toContain("[ok]");
		expect(text).toContain("array · 1501 chars · 42 lines · 1707 bytes · 3 blocks");
		expect(text).toContain("output omitted");
		const bashResult = Array.from(host.querySelectorAll('[data-testid="read-session-tool-result"]'))
			.find(element => element.textContent?.includes("bash"));
		expect(bashResult?.textContent).toContain("[error]");
		expect(text).toContain("excerpt 0–11 · more available");
		expect(text).toContain("<b>safe</b>");
		expect(text).toContain("Message projection omitted · 5 calls · 4 results");
		expect(text).not.toContain(rawDetailsSentinel);
		expect(text).not.toContain("agent-long-id-is-not-repeated");
		expect(host.querySelector("b")).toBeNull();
		expect(host.querySelector("cy")).toBeNull();
		expect(host.querySelectorAll('[data-testid="read-session-tool-call"]')).toHaveLength(1);
		expect(host.querySelectorAll('[data-testid="read-session-tool-result"]')).toHaveLength(2);
		expect(host.querySelector('[data-result-handle="rs1:m6:b0:bounded-handle"]')).toBeTruthy();
		expect(host.querySelector('[data-testid="read-session-open-full"]')).toBeTruthy();
	});

	it("keeps legacy toolUses, previews, and direct author objects compatible inside content envelopes", () => {
		const envelope = {
			total: 1,
			returned: 1,
			offsetStart: 4,
			offsetEnd: 4,
			messages: [{
				index: 4,
				role: "assistant",
				ts: null,
				text: "legacy compact row",
				author: { kind: "agent", id: "legacy-agent", label: "Legacy Coder" },
				toolUses: [{ name: "grep", inputPreview: "needle src/" }],
				toolResults: [{ name: "grep", status: "ok", preview: "one safe match", size: { type: "string", chars: 14, lines: 1, bytes: 14 } }],
			}],
		};
		const host = renderCard(toolResult(envelope, { session_id: SESSION_ID }));

		expect(host.textContent).toContain("Legacy Coder");
		expect(host.textContent).toContain("grep(needle src/)");
		const resultRow = host.querySelector('[data-testid="read-session-tool-result"]');
		expect(resultRow?.textContent).toContain("grep");
		expect(resultRow?.textContent).toContain("[ok]");
		expect(resultRow?.textContent).toContain("string · 14 chars · 1 lines · 14 bytes");
		expect(host.textContent).toContain("one safe match");
	});

	it("uses only scalar detail fallbacks when content does not contain a valid envelope", () => {
		const rawDetailsSentinel = "NEVER_RENDER_DETAILS_MESSAGES";
		const result = {
			...toolResult({ malformed: true }, {
				session_id: SESSION_ID,
				total: 99,
				returned: 1,
				messages: [{ index: 2, role: "toolResult", text: rawDetailsSentinel }],
			}),
			content: [{ type: "text", text: "not valid transcript JSON" }],
		};
		const host = renderCard(result);

		expect(host.textContent).toContain("1 of 99");
		expect(host.textContent).toContain("No messages in window.");
		expect(host.textContent).not.toContain(rawDetailsSentinel);
	});
});

describe("ReadSessionRenderer direct REST modal", () => {
	it("uses exact call params for controls when bounded details contain a colliding session prefix", async () => {
		const sharedPrefix = "p".repeat(64);
		const exactSessionId = `${sharedPrefix}-exact-target`;
		const collidingSessionId = `${sharedPrefix}-different-target`;
		expect(exactSessionId.length).toBeGreaterThan(64);
		expect(exactSessionId.slice(0, 64)).toBe(collidingSessionId.slice(0, 64));

		const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({ ok: true, json: async () => directEnvelope() }));
		vi.stubGlobal("fetch", fetchMock);
		const card = renderCard(toolResult({
			total: 0,
			returned: 0,
			offsetStart: -1,
			offsetEnd: -1,
			messages: [],
		}, {
			session_id: sharedPrefix,
			sessionIdTruncated: true,
		}), { session_id: exactSessionId });

		const link = card.querySelector('a[title="View delegate session"]');
		expect(link?.getAttribute("href")).toBe(`#/session/${exactSessionId}`);
		expect(link?.getAttribute("href")).not.toBe(`#/session/${sharedPrefix}`);
		expect(link?.getAttribute("href")).not.toBe(`#/session/${collidingSessionId}`);

		(card.querySelector('[data-testid="read-session-open-full"]') as HTMLButtonElement).click();
		await waitForFetchCalls(fetchMock, 1);
		const requestedUrl = new URL(String(fetchMock.mock.calls[0][0]), "http://localhost");
		expect(decodeURIComponent(requestedUrl.pathname)).toBe(`/api/sessions/${exactSessionId}/transcript`);
	});

	it("retains complete details and falls back to exact params when details are absent", () => {
		const emptyEnvelope = {
			total: 0,
			returned: 0,
			offsetStart: -1,
			offsetEnd: -1,
			messages: [],
		};
		const completeDetailsId = "complete-details-session";
		const completeCard = renderCard(toolResult(emptyEnvelope, {
			session_id: completeDetailsId,
			sessionIdTruncated: false,
		}), { session_id: "original-call-session" });
		const completeLink = completeCard.querySelector('a[title="View delegate session"]');
		expect(completeLink?.getAttribute("href")).toBe(`#/session/${completeDetailsId}`);

		const paramsOnlyId = "params-only-session";
		const paramsOnlyCard = renderCard(toolResult(emptyEnvelope), { session_id: paramsOnlyId });
		const paramsOnlyLink = paramsOnlyCard.querySelector('a[title="View delegate session"]');
		expect(paramsOnlyLink?.getAttribute("href")).toBe(`#/session/${paramsOnlyId}`);
	});

	it("paginates by returned and nextOffset, preserves attribution, and escapes direct rows", async () => {
		const pages = [
			directEnvelope({
				total: 4,
				returned: 1,
				messages: [{
					index: 0,
					role: "user",
					ts: null,
					text: "<script>window.__rawExecuted = true</script>",
					author: { kind: "agent", id: "modal-agent", label: "<Modal Author>" },
					toolUses: [{ name: "read", inputPreview: "safe.txt" }],
					toolResults: [{ name: "read", status: "ok", preview: "<result>safe</result>" }],
				}],
			}),
			directEnvelope({
				total: 4,
				returned: 1,
				nextOffset: 3,
				offsetStart: 1,
				offsetEnd: 1,
				messages: [{ index: 1, role: "assistant", ts: null, text: "second page" }],
			}),
			directEnvelope({
				total: 4,
				returned: 1,
				offsetStart: 3,
				offsetEnd: 3,
				messages: [{ index: 3, role: "assistant", ts: null, text: "final page" }],
			}),
		];
		const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({ ok: true, json: async () => pages.shift() }));
		vi.stubGlobal("fetch", fetchMock);
		const card = renderCard(toolResult({
			total: 0,
			returned: 0,
			offsetStart: -1,
			offsetEnd: -1,
			messages: [],
		}, { session_id: SESSION_ID }));

		(card.querySelector('[data-testid="read-session-open-full"]') as HTMLButtonElement).click();
		await waitForFetchCalls(fetchMock, 1);
		const modal = document.querySelector('[data-testid="read-session-transcript-modal"]') as HTMLElement;
		expect(modal).toBeTruthy();
		expect(modal.textContent).toContain("<Modal Author>");
		expect(modal.textContent).toContain("<script>window.__rawExecuted = true</script>");
		expect(modal.textContent).toContain("<result>safe</result>");
		expect(modal.querySelector("script")).toBeNull();
		expect(modal.querySelector("result")).toBeNull();
		expect((window as any).__rawExecuted).toBeUndefined();

		const body = modal.querySelector(".overflow-y-auto") as HTMLElement;
		body.dispatchEvent(new Event("scroll"));
		await waitForFetchCalls(fetchMock, 2);
		body.dispatchEvent(new Event("scroll"));
		await waitForFetchCalls(fetchMock, 3);

		const requestedOffsets = fetchMock.mock.calls.map(([input]) => new URL(String(input), "http://localhost").searchParams.get("offset"));
		expect(requestedOffsets).toEqual(["0", "1", "3"]);
		expect(modal.textContent).toContain("End of transcript (4 messages)");
		expect(modal.textContent).toContain("final page");
		expect(modal.querySelectorAll('[data-testid="read-session-modal-message"]')).toHaveLength(3);
	});
});
