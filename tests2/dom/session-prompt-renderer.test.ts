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
	const container = document.body.appendChild(document.createElement("div"));
	const result = { role: "toolResult", toolCallId: "read-session-1", toolName: "read_session", isError: false,
		content: [{ type: "text", text: rawText }], details, timestamp: Date.now() };
	render(new ReadSessionRenderer().render(params, result as any, false).content, container);
	return container;
}

describe("ReadSessionRenderer discriminated responses", () => {
	const textChecks = (node: HTMLElement, present: string[], absent: string[] = []) => { for (const value of present) expect(node.textContent).toContain(value); for (const value of absent) expect(node.textContent).not.toContain(value); };
	const result = { resultIndex: 0, name: "bash", status: "ok", size: { chars: 10, lines: 2, bytes: 11 } };

	it("renders current and legacy lists without raw fallback", () => {
		const current = renderReadSession({ operation: "list", session_id: TARGET_ID }, { operation: "list", messages: [{ index: 4,
			role: "assistant", text: "", toolUses: [{ name: "bash", argumentSummary: "{\"command\":\"npm test\"}" }],
			toolResults: [{ ...result, preview: "PREVIEW_SECRET", rawBody: "BODY_SECRET" }] }] }, "JSON_SECRET");
		textChecks(current, ["bash({\"command\":\"npm test\"})", "body redacted", "status=ok", "10 chars", "2 lines", "11 bytes"], ["PREVIEW_SECRET", "BODY_SECRET", "JSON_SECRET"]);
		const legacy = renderReadSession({ session_id: TARGET_ID }, { messages: [{ index: 2, role: "assistant", text: "historical message",
			toolUses: [{ name: "read", inputPreview: "{\"path\":\"README.md\"}" }], toolResults: [{ name: "read", omitted: true, status: "ok", size: { type: "text", chars: 42, lines: 3 } }] }] });
		textChecks(legacy, ["historical message", "read({\"path\":\"README.md\"})", "omitted"]);
		expect(legacy.querySelector('[data-testid="read-session-open-full"]')).toBeTruthy();
	});

	it("renders one inspected message without empty fallback, siblings, or raw data", () => {
		const node = renderReadSession({ operation: "inspect", session_id: TARGET_ID, message_index: 7 }, { operation: "inspect",
			message: { index: 7, role: "assistant", text: "Selected semantic message", toolUses: [{ name: "grep", arguments: { pattern: "needle" } }], toolResults: [result] },
			messages: [{ text: "SIBLING_SECRET" }] }, "RAW_SECRET");
		textChecks(node, ["message #7", "Selected semantic message", 'grep({"pattern":"needle"})', "body redacted"], ["No messages in window", "SIBLING_SECRET", "RAW_SECRET"]);
		expect(node.querySelector('[data-testid="read-session-open-full"]')).toBeNull();
	});

	it("renders only the exact result excerpt and continuation", () => {
		const node = renderReadSession({ operation: "inspect", session_id: TARGET_ID, message_index: 9, result_index: 1 }, { operation: "inspect",
			result: { ...result, messageIndex: 9, resultIndex: 1, status: "error", excerpt: "EXACT", offset: 6, returned: 5, totalChars: 20,
				nextOffset: 11, truncated: true, rawBody: "BODY_SECRET" }, message: { text: "SIBLING_SECRET" } }, "JSON_SECRET");
		textChecks(node, ["result #1 from message #9", "EXACT", "status=error", "Characters 6–11 of 20", "Continue at offset 11"], ["No messages in window", "SIBLING_SECRET", "BODY_SECRET", "JSON_SECRET"]);
	});
});
