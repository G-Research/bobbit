import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/session-prompt-renderer.spec.ts (v2-dom tier).
// Renders the REAL SessionPromptRenderer via lit into a happy-dom container,
// replacing the esbuild-bundled file:// fixture.
import { afterEach, describe, expect, it } from "vitest";
import { render } from "lit";
import { SessionPromptRenderer } from "../../src/ui/tools/renderers/SessionPromptRenderer.js";
import { ReadSessionRenderer } from "../../src/ui/tools/renderers/ReadSessionRenderer.js";

const TARGET_ID = "12345678-90ab-cdef-1234-567890abcdef";

afterEach(() => { document.body.innerHTML = ""; });

function makeResult(data: any, isError = false) {
	return {
		role: "toolResult",
		toolCallId: "tool-session-prompt-1",
		toolName: "session_prompt",
		isError,
		content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
		details: typeof data === "string" ? undefined : data,
		timestamp: Date.now(),
	};
}

function renderSessionPrompt(params: any, result: any, isStreaming = false): HTMLElement {
	const container = document.createElement("div");
	container.id = "container";
	document.body.appendChild(container);
	const out = new SessionPromptRenderer().render(params, result as any, isStreaming);
	render(out.content, container);
	return container;
}

describe("SessionPromptRenderer", () => {
	it("default prompt mode renders message icon, target title, session link, and delivery outcome", () => {
		const container = renderSessionPrompt(
			{ session_id: TARGET_ID, message: "Please review the queued work." },
			makeResult({
				ok: true,
				mode: "prompt",
				status: "dispatched",
				target: { sessionId: TARGET_ID, title: "Release Bot" },
			}),
		);

		const text = container.textContent || "";
		expect(text).toContain("Prompted");
		expect(text).toContain("Release Bot");
		expect(text).toContain("dispatched");
		expect(text).toContain("Please review the queued work.");
		expect(container.querySelectorAll(`a[href="#/session/${TARGET_ID}"]`).length).toBe(1);
		const headerIconPath = container.querySelector("button svg path");
		expect(headerIconPath?.getAttribute("d")).toMatch(/M22 17/);
		expect(container.querySelector("button svg")).toBeTruthy();
		expect(text).not.toContain('"ok"');
	});

	it("steer mode renders a distinct steer icon/label and live dispatch outcome", () => {
		const container = renderSessionPrompt(
			{ session_id: TARGET_ID, mode: "steer", message: "Redirect now." },
			makeResult({
				ok: true,
				mode: "steer",
				dispatched: true,
				target: { sessionId: TARGET_ID, title: "Live Agent" },
			}),
		);

		const text = container.textContent || "";
		expect(text).toContain("Steered");
		expect(text).toContain("Live Agent");
		expect(text).toContain("live steer dispatched");
		expect(text).toContain("Redirect now.");
		const headerIconPath = container.querySelector("button svg path");
		expect(headerIconPath?.getAttribute("d")).toMatch(/l9\.9-10\.2/);
		expect(container.querySelector("button svg")).toBeTruthy();
	});

	it("multiline prompt body preserves line breaks and escapes message content", () => {
		const message = "First line\nSecond line\n  Indented <script>alert(1)</script>";
		const container = renderSessionPrompt(
			{ session_id: TARGET_ID, message },
			makeResult({
				ok: true,
				mode: "prompt",
				status: "queued",
				target: { sessionId: TARGET_ID, title: "Queue Target" },
			}),
		);

		const bodies = container.querySelectorAll(".whitespace-pre-wrap");
		expect(bodies.length).toBe(1);
		expect(bodies[0].textContent).toBe(message);
		expect(container.querySelectorAll("script").length).toBe(0);
		expect(bodies[0].textContent).toContain("<script>alert(1)</script>");
	});

	it("missing title falls back to a shortened session id while preserving the session link", () => {
		const untitledId = "0f3dfc9a-1111-4222-8333-abcdefabcdef";
		const container = renderSessionPrompt(
			{ session_id: untitledId, message: "No title here." },
			makeResult({
				ok: true,
				mode: "prompt",
				status: "queued",
				target: { sessionId: untitledId },
			}),
		);

		const renderedText = container.textContent || "";
		expect(renderedText).toContain("0f3dfc9a");
		expect(renderedText).not.toContain(untitledId);
		expect(container.querySelectorAll(`a[href="#/session/${untitledId}"]`).length).toBe(1);
	});

	it("error state shows server error text with destructive styling", () => {
		const errorText = "target session is not live: terminated";
		const container = renderSessionPrompt(
			{ session_id: TARGET_ID, mode: "steer", message: "Try steering anyway." },
			makeResult(errorText, true),
		);

		const text = container.textContent || "";
		expect(text).toContain("Steer failed");
		expect(text).toContain(errorText);
		const destructive = [...container.querySelectorAll(".text-destructive")].filter((el) =>
			(el.textContent || "").includes(errorText),
		);
		expect(destructive.length).toBe(1);
	});
});

function renderReadSession(params: any, details: any, rawText = JSON.stringify(details)): HTMLElement {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const result = {
		role: "toolResult",
		toolCallId: "read-session-1",
		toolName: "read_session",
		isError: false,
		content: [{ type: "text", text: rawText }],
		details,
		timestamp: Date.now(),
	};
	const output = new ReadSessionRenderer().render(params, result as any, false);
	render(output.content, container);
	return container;
}

describe("ReadSessionRenderer discriminated responses", () => {
	it("renders list argument summaries and deliberately redacted result diagnostics", () => {
		const container = renderReadSession(
			{ operation: "list", session_id: TARGET_ID },
			{
				operation: "list", session_id: TARGET_ID, total: 1, returned: 1,
				messages: [{
					index: 4, role: "assistant", ts: null, text: "",
					toolUses: [{ name: "bash", argumentSummary: "{\"command\":\"npm test\"}" }],
					toolResults: [{
						resultIndex: 0, name: "bash", status: "ok",
						size: { chars: 10, lines: 2, bytes: 11 },
						preview: "LIST_PREVIEW_MUST_NOT_RENDER",
						rawBody: "LIST_BODY_MUST_NOT_RENDER",
					}],
				}],
			},
			"GENERIC_JSON_MUST_NOT_RENDER",
		);

		const text = container.textContent || "";
		expect(text).toContain("bash({\"command\":\"npm test\"})");
		expect(text).toContain("body redacted");
		expect(text).toContain("status=ok");
		expect(text).toContain("10 chars");
		expect(text).toContain("2 lines");
		expect(text).toContain("11 bytes");
		expect(text).not.toContain("LIST_PREVIEW_MUST_NOT_RENDER");
		expect(text).not.toContain("LIST_BODY_MUST_NOT_RENDER");
		expect(text).not.toContain("GENERIC_JSON_MUST_NOT_RENDER");
	});

	it("keeps historical list cards and the legacy transcript action", () => {
		const container = renderReadSession(
			{ session_id: TARGET_ID },
			{
				session_id: TARGET_ID, total: 1, returned: 1,
				messages: [{
					index: 2, role: "assistant", ts: null, text: "historical message",
					toolUses: [{ name: "read", inputPreview: "{\"path\":\"README.md\"}" }],
					toolResults: [{ name: "read", omitted: true, status: "ok", size: { type: "text", chars: 42, lines: 3 } }],
				}],
			},
		);

		const text = container.textContent || "";
		expect(text).toContain("historical message");
		expect(text).toContain("read({\"path\":\"README.md\"})");
		expect(text).toContain("omitted");
		expect(container.querySelector('[data-testid="read-session-open-full"]')).toBeTruthy();
	});

	it("renders one inspected sanitized message without list fallback or siblings", () => {
		const container = renderReadSession(
			{ operation: "inspect", session_id: TARGET_ID, message_index: 7 },
			{
				operation: "inspect", session_id: TARGET_ID,
				message: {
					index: 7, role: "assistant", ts: null, text: "Selected semantic message",
					toolUses: [{ name: "grep", arguments: { pattern: "needle", path: "src" } }],
					toolResults: [{ resultIndex: 0, name: "grep", status: "unknown", size: { chars: 25, lines: 1, bytes: 25 } }],
				},
				messages: [{ index: 8, role: "assistant", ts: null, text: "SIBLING_MESSAGE_MUST_NOT_RENDER" }],
			},
			"RAW_MESSAGE_ENVELOPE_MUST_NOT_RENDER",
		);

		const text = container.textContent || "";
		expect(text).toContain("message #7");
		expect(text).toContain("Selected semantic message");
		expect(text).toContain('grep({"pattern":"needle","path":"src"})');
		expect(text).toContain("body redacted");
		expect(text).not.toContain("No messages in window");
		expect(text).not.toContain("SIBLING_MESSAGE_MUST_NOT_RENDER");
		expect(text).not.toContain("RAW_MESSAGE_ENVELOPE_MUST_NOT_RENDER");
		expect(container.querySelector('[data-testid="read-session-open-full"]')).toBeNull();
	});

	it("renders only the exact result excerpt and continuation", () => {
		const container = renderReadSession(
			{ operation: "inspect", session_id: TARGET_ID, message_index: 9, result_index: 1 },
			{
				operation: "inspect", session_id: TARGET_ID,
				result: {
					messageIndex: 9, resultIndex: 1, name: "bash", status: "error",
					size: { chars: 20, lines: 3, bytes: 22 }, excerpt: "EXACT",
					offset: 6, returned: 5, totalChars: 20, nextOffset: 11, truncated: true,
					rawBody: "UNSELECTED_RESULT_BODY",
				},
				message: { index: 9, role: "toolResult", ts: null, text: "SIBLING_MESSAGE_BODY" },
			},
			"GENERIC_RESULT_JSON_MUST_NOT_RENDER",
		);

		const text = container.textContent || "";
		expect(text).toContain("result #1 from message #9");
		expect(text).toContain("EXACT");
		expect(text).toContain("status=error");
		expect(text).toContain("Characters 6–11 of 20");
		expect(text).toContain("Continue at offset 11");
		expect(text).not.toContain("No messages in window");
		expect(text).not.toContain("SIBLING_MESSAGE_BODY");
		expect(text).not.toContain("UNSELECTED_RESULT_BODY");
		expect(text).not.toContain("GENERIC_RESULT_JSON_MUST_NOT_RENDER");
	});
});
