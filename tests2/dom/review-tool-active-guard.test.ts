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

const annotationStoreMocks = vi.hoisted(() => ({
	clearAnnotations: vi.fn(),
	clearAllAnnotations: vi.fn(),
	clearReviewSubmitted: vi.fn(),
	initAnnotationStore: vi.fn(),
	isReviewSubmitted: vi.fn(),
}));
const reviewSourceMocks = vi.hoisted(() => ({
	clearPersistedReviewDocuments: vi.fn(),
	loadReviewSources: vi.fn(),
	openMarkdownReviewDocument: vi.fn(),
	removePersistedReviewDocument: vi.fn(),
	restorePersistedReviewDocuments: vi.fn(),
}));
const faviconMocks = vi.hoisted(() => ({ showFaviconBadge: vi.fn() }));

vi.mock("../../src/ui/components/review/AnnotationStore.js", async (importOriginal) => ({
	...await importOriginal<typeof import("../../src/ui/components/review/AnnotationStore.js")>(),
	...annotationStoreMocks,
}));
vi.mock("../../src/app/review-sources-lazy.js", () => ({
	loadReviewSources: reviewSourceMocks.loadReviewSources,
}));
vi.mock("../../src/app/favicon-badge.js", () => ({
	showFaviconBadge: faviconMocks.showFaviconBadge,
}));

import { RemoteAgent } from "../../src/app/remote-agent.js";
import { state } from "../../src/app/state.js";

const mockReviewSourcesModule = {
	clearPersistedReviewDocuments: reviewSourceMocks.clearPersistedReviewDocuments,
	openMarkdownReviewDocument: reviewSourceMocks.openMarkdownReviewDocument,
	removePersistedReviewDocument: reviewSourceMocks.removePersistedReviewDocument,
	restorePersistedReviewDocuments: reviewSourceMocks.restorePersistedReviewDocuments,
};

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => { resolve = res; });
	return { promise, resolve };
}

function mockStorage(): Storage {
	const values = new Map<string, string>();
	return {
		get length() { return values.size; },
		clear: vi.fn(() => values.clear()),
		getItem: vi.fn((key: string) => values.get(key) ?? null),
		key: vi.fn((index: number) => [...values.keys()][index] ?? null),
		removeItem: vi.fn((key: string) => { values.delete(key); }),
		setItem: vi.fn((key: string, value: string) => { values.set(key, String(value)); }),
	};
}

function makeAgent(sessionId: string): RemoteAgent {
	const a = new RemoteAgent();
	// _sessionId is private; assign for test purposes so the production code
	// path that consults it is exercised. Stub transport so no real WebSocket is
	// ever constructed or touched.
	(a as any)._sessionId = sessionId;
	(a as any).send = vi.fn();
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
function seedReviewState(title = "Foreground review"): void {
	state.reviewDocuments = new Map([[title, {
		title,
		markdown: `# ${title}`,
	} as any]]);
	state.reviewActiveTab = title;
	state.reviewPanelOpen = true;
}
function getReviewState() {
	return {
		open: state.reviewPanelOpen,
		activeTab: state.reviewActiveTab,
		docCount: state.reviewDocuments.size,
		docTitles: [...state.reviewDocuments.keys()],
	};
}
function reviewToolResult(action: "review_open" | "review_close", payload: Record<string, unknown> = {}) {
	return {
		role: "toolResult",
		content: [{ type: "text", text: JSON.stringify({ action, ...payload }) }],
	};
}
async function deliverSnapshot(a: RemoteAgent, messages: any[]): Promise<void> {
	await (a as any).handleServerMessage({ type: "messages", data: messages });
}
function toolProposalMessage(blockId: string) {
	return {
		id: `assistant-${blockId}`,
		role: "assistant",
		content: [{
			type: "tool_use",
			id: blockId,
			name: "propose_tool",
			input: { tool: "sample_tool", action: "create", content: "name: sample_tool" },
		}],
	};
}
function deliverAgentEvent(a: RemoteAgent, type: string, message?: any): void {
	(a as any).handleAgentEvent({ type, ...(message ? { message } : {}) });
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
	// All external boundaries are deterministic in-memory mocks: no network,
	// persisted browser storage, lazy source loading, animation timers, or audio.
	vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })));
	vi.stubGlobal("localStorage", mockStorage());
	vi.stubGlobal("sessionStorage", mockStorage());
	vi.stubGlobal("requestAnimationFrame", vi.fn(() => 0));

	annotationStoreMocks.clearAnnotations.mockReset();
	annotationStoreMocks.clearAllAnnotations.mockReset();
	annotationStoreMocks.clearReviewSubmitted.mockReset();
	annotationStoreMocks.initAnnotationStore.mockReset();
	annotationStoreMocks.initAnnotationStore.mockResolvedValue(undefined);
	annotationStoreMocks.isReviewSubmitted.mockReset();
	annotationStoreMocks.isReviewSubmitted.mockReturnValue(false);

	reviewSourceMocks.clearPersistedReviewDocuments.mockReset();
	reviewSourceMocks.loadReviewSources.mockReset();
	reviewSourceMocks.loadReviewSources.mockResolvedValue(mockReviewSourcesModule);
	reviewSourceMocks.openMarkdownReviewDocument.mockReset();
	reviewSourceMocks.openMarkdownReviewDocument.mockImplementation((options: any) => {
		const document = { title: options.title, markdown: options.markdown };
		state.reviewDocuments = new Map(state.reviewDocuments);
		state.reviewDocuments.set(options.title, document as any);
		state.reviewActiveTab = options.title;
		state.reviewPanelOpen = true;
		return document;
	});
	reviewSourceMocks.removePersistedReviewDocument.mockReset();
	reviewSourceMocks.restorePersistedReviewDocuments.mockReset();
	faviconMocks.showFaviconBadge.mockReset();

	clearReviewState();
	state.proposalStreamingByTag = {};
	state.remoteAgent = null;
	state.selectedSessionId = null;
	document.documentElement.dataset.playAgentFinishSound = "false";
});
afterEach(() => {
	clearReviewState();
	state.proposalStreamingByTag = {};
	state.remoteAgent = null;
	state.selectedSessionId = null;
	delete document.documentElement.dataset.playAgentFinishSound;
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

describe("cached RemoteAgent reconnect isolation", () => {
	it("an inactive messages snapshot cannot clear or restore over foreground review state", async () => {
		const foreground = makeAgent("foreground-session");
		const cached = makeAgent("cached-session");
		setActive(foreground);
		seedReviewState();
		const before = getReviewState();

		reviewSourceMocks.restorePersistedReviewDocuments.mockImplementation(() => {
			seedReviewState("Cached review");
		});
		await deliverSnapshot(cached, [reviewToolResult("review_open", {
			title: "Cached snapshot review",
			markdown: "# Must stay in the background",
		})]);

		expect(getReviewState()).toEqual(before);
		expect(reviewSourceMocks.restorePersistedReviewDocuments).not.toHaveBeenCalled();
	});

	it("a snapshot cannot clear the new foreground after annotation hydration awaits", async () => {
		const reconnecting = makeAgent("reconnecting-session");
		const foreground = makeAgent("new-foreground-session");
		setActive(reconnecting);
		seedReviewState("Reconnecting review");
		const annotationGate = deferred<void>();
		annotationStoreMocks.initAnnotationStore.mockReturnValueOnce(annotationGate.promise);

		const pendingSnapshot = deliverSnapshot(reconnecting, []);
		expect(annotationStoreMocks.initAnnotationStore).toHaveBeenCalledWith("reconnecting-session");
		setActive(foreground);
		seedReviewState();
		const foregroundState = getReviewState();
		annotationGate.resolve(undefined);
		await pendingSnapshot;

		expect(getReviewState()).toEqual(foregroundState);
		expect(reviewSourceMocks.loadReviewSources).not.toHaveBeenCalled();
	});

	it("a snapshot cannot restore over the new foreground after lazy sources await", async () => {
		const reconnecting = makeAgent("reconnecting-session");
		const foreground = makeAgent("new-foreground-session");
		setActive(reconnecting);
		seedReviewState("Reconnecting review");
		const sourceGate = deferred<typeof mockReviewSourcesModule>();
		reviewSourceMocks.loadReviewSources.mockReturnValueOnce(sourceGate.promise);
		reviewSourceMocks.restorePersistedReviewDocuments.mockImplementation(() => {
			seedReviewState("Late reconnect restore");
		});

		const pendingSnapshot = deliverSnapshot(reconnecting, []);
		// Resume the already-resolved annotation mock. The production handler is
		// now paused exactly at the controlled lazy-source boundary.
		await Promise.resolve();
		expect(reviewSourceMocks.loadReviewSources).toHaveBeenCalledOnce();
		setActive(foreground);
		seedReviewState();
		const foregroundState = getReviewState();
		sourceGate.resolve(mockReviewSourcesModule);
		await pendingSnapshot;

		expect(getReviewState()).toEqual(foregroundState);
		expect(reviewSourceMocks.restorePersistedReviewDocuments).not.toHaveBeenCalled();
	});

	it("an active messages snapshot still rebuilds foreground review state", async () => {
		const active = makeAgent("active-session");
		setActive(active);
		seedReviewState("Stale foreground review");

		await deliverSnapshot(active, []);

		expect(getReviewState()).toEqual({
			open: false,
			activeTab: "",
			docCount: 0,
			docTitles: [],
		});
		expect(annotationStoreMocks.initAnnotationStore).toHaveBeenCalledWith("active-session");
		expect(reviewSourceMocks.restorePersistedReviewDocuments).toHaveBeenCalledWith("active-session", { select: true });
	});
});

describe("cached RemoteAgent proposal isolation", () => {
	it("inactive tool proposal streaming and completion cannot set or clear foreground flags", () => {
		const foreground = makeAgent("foreground-session");
		const cached = makeAgent("cached-session");
		setActive(foreground);
		cached.onToolProposal = vi.fn();

		state.proposalStreamingByTag = { tool_proposal: false };
		deliverAgentEvent(cached, "message_update", toolProposalMessage("cached-stream"));
		expect(state.proposalStreamingByTag.tool_proposal).toBe(false);

		state.proposalStreamingByTag.tool_proposal = true;
		deliverAgentEvent(cached, "message_end", toolProposalMessage("cached-complete"));
		expect(state.proposalStreamingByTag.tool_proposal).toBe(true);
	});

	it("active tool proposal streaming and completion still own the foreground flag", () => {
		const active = makeAgent("active-session");
		setActive(active);
		const streamingStates: boolean[] = [];
		active.onToolProposal = (_proposal, streaming) => { streamingStates.push(streaming); };
		state.proposalStreamingByTag = { tool_proposal: false };
		const proposal = toolProposalMessage("active-tool-proposal");

		deliverAgentEvent(active, "message_update", proposal);
		expect(state.proposalStreamingByTag.tool_proposal).toBe(true);
		deliverAgentEvent(active, "message_end", proposal);

		expect(state.proposalStreamingByTag.tool_proposal).toBe(false);
		expect(streamingStates).toEqual([true, false]);
	});

	it("an inactive agent_end cannot bulk-clear foreground proposal flags", () => {
		const foreground = makeAgent("foreground-session");
		const cached = makeAgent("cached-session");
		setActive(foreground);
		state.proposalStreamingByTag = { goal_proposal: true, tool_proposal: true };

		deliverAgentEvent(cached, "agent_end");

		expect(state.proposalStreamingByTag).toEqual({
			goal_proposal: true,
			tool_proposal: true,
		});
	});

	it("an active agent_end still bulk-clears foreground proposal flags", () => {
		const active = makeAgent("active-session");
		setActive(active);
		state.proposalStreamingByTag = { goal_proposal: true, tool_proposal: true };

		deliverAgentEvent(active, "agent_end");

		expect(state.proposalStreamingByTag).toEqual({
			goal_proposal: false,
			tool_proposal: false,
		});
	});
});
