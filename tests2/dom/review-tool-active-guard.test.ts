import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/review-tool-active-guard.spec.ts (v2-dom tier).
// The legacy esbuild file:// fixture instantiated two REAL RemoteAgents and
// drove the private `_checkReviewToolResult` directly with synthetic tool
// results. This port does the same under happy-dom — no bundle, no browser.
//
// Regression coverage: when an agent in a background/cached session emits a
// review_open/review_close tool result, its `_checkReviewToolResult` must NOT
// mutate the globally-shared `state.review*` fields (which would land on
// whichever session the user is currently viewing). The fix gates every
// mutation on the agent session still matching `state.selectedSessionId`,
// including after lazy review-source imports resume.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteAgent } from "../../src/app/remote-agent.js";
import { state } from "../../src/app/state.js";

function makeAgent(sessionId: string): RemoteAgent {
	const a = new RemoteAgent();
	// _sessionId is private; assign for test purposes so the production code
	// path that consults it is exercised.
	(a as any)._sessionId = sessionId;
	return a;
}
function setActive(a: RemoteAgent): void {
	state.remoteAgent = a as any;
	state.selectedSessionId = (a as any)._sessionId;
}
function clearReviewState(): void {
	state.reviewDocuments = new Map();
	state.reviewActiveTab = "";
	state.reviewPanelOpen = false;
}
function getReviewState() {
	return {
		open: state.reviewPanelOpen,
		activeTab: state.reviewActiveTab,
		docCount: state.reviewDocuments.size,
		docTitles: [...state.reviewDocuments.keys()],
	};
}
async function deliverReviewToolResult(
	a: RemoteAgent,
	action: string,
	payload: any,
	isLive = true,
	shape = "json-text",
): Promise<void> {
	const envelope = { action, ...payload };
	const json = JSON.stringify(envelope);
	const content = shape === "structured"
		? [{ type: "text", text: "(tool ack)" }, envelope]
		: shape === "nested-tool-result"
			? [{ type: "tool_result", content: [{ type: "text", text: "(tool ack)" }, envelope] }]
			: [{ type: "text", text: "(tool ack)" }, { type: "text", text: json }];
	const msg = { role: "toolResult", content };
	await (a as any)._checkReviewToolResult(msg, isLive);
}

beforeEach(() => {
	// The workspace open/persist path fires fire-and-forget PUT/POSTs to the
	// gateway; stub fetch so those don't surface as unhandled network rejections.
	vi.stubGlobal("fetch", async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
	clearReviewState();
});
afterEach(() => {
	clearReviewState();
	vi.unstubAllGlobals();
});

describe("review tool active-session guard", () => {
	it("background session's review_open does NOT mutate global review state", async () => {
		const active = makeAgent("active-session");
		const background = makeAgent("background-session");
		setActive(active);
		clearReviewState();

		// Simulate the bug: background session's agent emits review_open.
		await deliverReviewToolResult(background, "review_open", {
			title: "PR-from-background",
			markdown: "# Should not appear",
		});

		const result = getReviewState();
		expect(result.open).toBe(false);
		expect(result.activeTab).toBe("");
		expect(result.docCount).toBe(0);
	});

	it("active session's review_open DOES open the review pane", async () => {
		const active = makeAgent("active-session");
		setActive(active);
		clearReviewState();

		await deliverReviewToolResult(active, "review_open", {
			title: "PR-from-active",
			markdown: "# Welcome",
		});

		const result = getReviewState();
		expect(result.open).toBe(true);
		expect(result.activeTab).toBe("PR-from-active");
		expect(result.docCount).toBe(1);
		expect(result.docTitles).toEqual(["PR-from-active"]);
	});

	it("review_open does NOT mutate state after a lazy-import session switch", async () => {
		const active = makeAgent("active-session");
		const next = makeAgent("next-session");
		setActive(active);
		clearReviewState();

		const pending = deliverReviewToolResult(active, "review_open", {
			title: "Late-PR",
			markdown: "# Must not appear after session switch",
		});
		setActive(next);
		await pending;

		const result = getReviewState();
		expect(result.open).toBe(false);
		expect(result.activeTab).toBe("");
		expect(result.docCount).toBe(0);
	});

	it("active session's inline review_open also handles structured tool-result payloads", async () => {
		const active = makeAgent("active-session");
		setActive(active);
		clearReviewState();

		await deliverReviewToolResult(active, "review_open", {
			title: "Structured inline markdown",
			markdown: "# Inline\n\nOpened from a structured result object.",
		}, true, "nested-tool-result");

		const result = getReviewState();
		expect(result.open).toBe(true);
		expect(result.activeTab).toBe("Structured inline markdown");
		expect(result.docCount).toBe(1);
		expect(result.docTitles).toEqual(["Structured inline markdown"]);
	});

	it("background session's review_close does NOT clear active session's documents", async () => {
		const active = makeAgent("active-session");
		const background = makeAgent("background-session");
		setActive(active);
		clearReviewState();

		// Active session opens a review.
		await deliverReviewToolResult(active, "review_open", {
			title: "Active-PR",
			markdown: "# Important",
		});
		const before = getReviewState();

		// Background session emits review_close — must NOT clear the active doc.
		await deliverReviewToolResult(background, "review_close", {});
		const after = getReviewState();

		expect(before.open).toBe(true);
		expect(before.docCount).toBe(1);
		expect(after.open).toBe(true);
		expect(after.docCount).toBe(1);
		expect(after.activeTab).toBe("Active-PR");
	});

	it("review_close does NOT mutate state after a lazy-import session switch", async () => {
		const active = makeAgent("active-session");
		const next = makeAgent("next-session");
		setActive(active);
		clearReviewState();

		await deliverReviewToolResult(active, "review_open", {
			title: "Active-PR",
			markdown: "# Important",
		});
		const before = getReviewState();

		const pending = deliverReviewToolResult(active, "review_close", { title: "Active-PR" });
		setActive(next);
		await pending;
		const after = getReviewState();

		expect(before.open).toBe(true);
		expect(before.docCount).toBe(1);
		expect(after.open).toBe(true);
		expect(after.docCount).toBe(1);
		expect(after.activeTab).toBe("Active-PR");
	});
});
