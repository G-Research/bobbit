import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../../tests2/dom/_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "lit";

const controller = vi.hoisted(() => ({
	state: undefined as any,
	getReviewOpenState: vi.fn(),
	openReviewReceipt: vi.fn(),
	registerReviewOpenReceipt: vi.fn(),
	reviewOpenReceiptFromToolResult: vi.fn(),
}));
vi.mock("../../src/app/review-open-controller.js", () => ({
	getReviewOpenState: controller.getReviewOpenState,
	openReviewReceipt: controller.openReviewReceipt,
	registerReviewOpenReceipt: controller.registerReviewOpenReceipt,
	reviewOpenReceiptFromToolResult: controller.reviewOpenReceiptFromToolResult,
}));

import { ReviewOpenRenderer } from "../../src/ui/tools/renderers/ReviewRenderer.js";

const SESSION_ID = "session-owner";
const TOOL_ID = "tool-owner";
const receipt = {
	action: "review_open",
	version: 2,
	toolCallId: TOOL_ID,
	payloadId: "payload-exact",
	reviewId: "review-exact",
	title: "Canonical title",
	contentHash: "a".repeat(64),
	totalBytes: 4,
	files: [{ fileId: "file-exact", title: "Exact file", bytes: 4 }],
	activeFileId: "file-exact",
	replace: true,
};

function result(overrides: Record<string, unknown> = {}): any {
	return {
		role: "toolResult",
		toolCallId: TOOL_ID,
		toolName: "review_open",
		isError: false,
		content: [{ type: "text", text: JSON.stringify(receipt) }],
		timestamp: Date.now(),
		...overrides,
	};
}

function mount(options: {
	result?: any;
	streaming?: boolean;
	params?: Record<string, unknown>;
	ctx?: Record<string, unknown>;
} = {}): HTMLElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const output = new ReviewOpenRenderer().render(
		(options.params ?? { title: "Display title", markdown: "never identity" }) as any,
		options.result,
		options.streaming,
		(options.ctx ?? { sessionId: SESSION_ID, toolUseId: TOOL_ID }) as any,
	);
	render(output.content, host);
	return host;
}

const button = (host: ParentNode) => host.querySelector<HTMLButtonElement>('[data-testid="review-open-button"]')!;

beforeEach(() => {
	controller.state = undefined;
	controller.getReviewOpenState.mockReset();
	controller.getReviewOpenState.mockImplementation(() => controller.state);
	controller.openReviewReceipt.mockReset();
	controller.openReviewReceipt.mockResolvedValue({ phase: "success", receipt, openedAt: 1 });
	controller.registerReviewOpenReceipt.mockReset();
	controller.reviewOpenReceiptFromToolResult.mockReset();
	controller.reviewOpenReceiptFromToolResult.mockImplementation((value, expectedToolId) =>
		value?.toolCallId === expectedToolId ? receipt : null);
});

afterEach(() => {
	document.body.innerHTML = "";
});

describe("ReviewOpenRenderer recovery action", () => {
	it("renders streaming as a visible, disabled native action without parsing or opening", () => {
		const host = mount({ streaming: true });
		const action = button(host);
		expect(action.tagName).toBe("BUTTON");
		expect(action.type).toBe("button");
		expect(action.disabled).toBe(true);
		expect(action.textContent).toContain("Open review");
		expect(action.getAttribute("aria-describedby")).toBe(`review-open-feedback-${SESSION_ID}-${TOOL_ID}`);
		expect(host.querySelector('[data-testid="review-open-status"]')?.textContent).toContain("Available when the review is ready.");
		expect(controller.reviewOpenReceiptFromToolResult).not.toHaveBeenCalled();
		expect(controller.openReviewReceipt).not.toHaveBeenCalled();
	});

	it("keeps completed rendering passive and enables an exact receipt-backed open", () => {
		const toolResult = result();
		const host = mount({
			result: toolResult,
			params: { title: "Forged display title", markdown: "# forged" },
		});
		const action = button(host);
		expect(action.disabled).toBe(false);
		expect(action.textContent).toContain("Open review");
		expect(action.getAttribute("aria-label")).toBe("Open review: Canonical title");
		expect(action.className).toContain("focus-visible:ring-[3px]");
		expect(controller.reviewOpenReceiptFromToolResult).toHaveBeenCalledWith(toolResult, TOOL_ID);
		expect(controller.getReviewOpenState).toHaveBeenCalledWith(SESSION_ID, TOOL_ID, "payload-exact");
		expect(controller.registerReviewOpenReceipt).not.toHaveBeenCalled();
		expect(controller.openReviewReceipt).not.toHaveBeenCalled();
	});

	it("routes opening through the controller and renders pending after the subscribed rerender", async () => {
		let host = mount({ result: result() });
		const action = button(host);
		action.click();

		// The renderer is declarative: the click does not imperatively mutate its
		// stale DOM. The coordinator publishes state and the subscribed tool card
		// rerenders with the accessible pending presentation.
		expect(action.disabled).toBe(false);
		expect(action.getAttribute("aria-busy")).toBe("false");
		await vi.waitFor(() => expect(controller.openReviewReceipt).toHaveBeenCalledOnce());
		expect(controller.registerReviewOpenReceipt).toHaveBeenCalledWith(SESSION_ID, TOOL_ID, receipt);
		expect(controller.openReviewReceipt).toHaveBeenCalledWith({
			sessionId: SESSION_ID,
			toolUseId: TOOL_ID,
			receipt,
			intent: "manual",
		});

		controller.state = { phase: "pending", receipt };
		host.remove();
		host = mount({ result: result() });
		const pendingAction = button(host);
		expect(pendingAction.disabled).toBe(true);
		expect(pendingAction.getAttribute("aria-busy")).toBe("true");
		expect(pendingAction.textContent).toContain("Opening…");
	});

	it("renders pending, confirmed success, retryable failure, and terminal failure accessibly", () => {
		controller.state = { phase: "pending", receipt };
		let host = mount({ result: result() });
		let action = button(host);
		expect(action.disabled).toBe(true);
		expect(action.getAttribute("aria-busy")).toBe("true");
		expect(action.textContent).toContain("Opening…");
		expect(host.querySelector('[data-testid="review-open-status"]')?.textContent).toContain("Opening review…");

		controller.state = { phase: "success", receipt, openedAt: 1 };
		host = mount({ result: result() });
		action = button(host);
		expect(action.disabled).toBe(false);
		expect(action.textContent).toContain("Re-open review");
		expect(host.querySelector('[data-testid="review-open-status"]')?.textContent).toContain("Review opened.");

		controller.state = {
			phase: "error",
			receipt,
			code: "REVIEW_WORKSPACE_CONFLICT",
			retryable: true,
			message: "untrusted raw server text",
		};
		host = mount({ result: result() });
		action = button(host);
		expect(action.disabled).toBe(false);
		expect(action.textContent).toContain("Retry open");
		const alert = host.querySelector('[data-testid="review-open-error"]');
		expect(alert?.getAttribute("role")).toBe("alert");
		expect(alert?.textContent).toContain("The review panel changed before it could open. Retry.");
		expect(alert?.textContent).toContain("REVIEW_WORKSPACE_CONFLICT");
		expect(alert?.textContent).not.toContain("untrusted raw server text");

		controller.state = {
			phase: "unavailable",
			receipt,
			code: "REVIEW_PAYLOAD_UNAVAILABLE",
			retryable: false,
			message: "C:\\secret\\review.md",
		};
		host = mount({ result: result() });
		action = button(host);
		expect(action.disabled).toBe(true);
		expect(action.textContent).toContain("Open unavailable");
		expect(host.querySelector('[data-testid="review-open-status"]')?.textContent).toContain("Saved review content is no longer available.");
		expect(host.textContent).not.toContain("secret");
	});

	it("renders malicious quota failures as fixed terminal copy with no recovery callback", async () => {
		const maliciousQuota = result({
			isError: true,
			content: [{
				type: "text",
				text: JSON.stringify({
					code: "REVIEW_PAYLOAD_QUOTA_EXCEEDED",
					message: "C:\\private\\reviews\\payload.md bearer-secret",
					stack: "Error: quota at /srv/private/reviews.ts:42",
					retryable: true,
				}),
			}],
		});
		const host = mount({ result: maliciousQuota });
		const action = button(host);
		const status = host.querySelector('[data-testid="review-open-status"]');

		expect(action.disabled).toBe(true);
		expect(action.textContent).toContain("Open unavailable");
		expect(status?.getAttribute("role")).toBe("status");
		expect(status?.textContent).toContain("Review content storage is full for this session. Start a new session or remove saved reviews.");
		expect(status?.textContent).toContain("REVIEW_PAYLOAD_QUOTA_EXCEEDED");
		expect(host.textContent).not.toContain("private");
		expect(host.textContent).not.toContain("bearer-secret");
		expect(host.textContent).not.toContain("reviews.ts");
		expect(host.textContent).not.toContain("retryable");

		const parseCallsAfterRender = controller.reviewOpenReceiptFromToolResult.mock.calls.length;
		action.click();
		action.focus();
		action.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await Promise.resolve();
		expect(controller.reviewOpenReceiptFromToolResult).toHaveBeenCalledTimes(parseCallsAfterRender);
		expect(controller.registerReviewOpenReceipt).not.toHaveBeenCalled();
		expect(controller.openReviewReceipt).not.toHaveBeenCalled();
	});

	it("sanitizes over-limit tool errors and disables malformed or ownerless controls", () => {
		const overLimit = result({
			isError: true,
			content: [{
				type: "text",
				text: JSON.stringify({ code: "REVIEW_PAYLOAD_TOO_LARGE", message: "C:\\secret\\payload" }),
			}],
		});
		let host = mount({ result: overLimit });
		expect(button(host).textContent).toContain("Open unavailable");
		expect(host.querySelector('[data-testid="review-open-status"]')?.textContent).toContain("Review exceeds the 10 MiB limit.");
		expect(host.textContent).not.toContain("secret");

		controller.reviewOpenReceiptFromToolResult.mockReturnValueOnce(null);
		host = mount({ result: result() });
		expect(button(host).disabled).toBe(true);
		expect(host.textContent).toContain("Saved review data is incomplete.");

		host = mount({ result: result(), ctx: { toolUseId: TOOL_ID } });
		expect(button(host).disabled).toBe(true);
		expect(controller.openReviewReceipt).not.toHaveBeenCalled();
	});
});
