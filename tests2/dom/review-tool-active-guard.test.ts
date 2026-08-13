import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/review-tool-active-guard.spec.ts (v2-dom tier).
// The legacy esbuild file:// fixture instantiated two REAL RemoteAgents and
// drove the private `_checkReviewToolResult` directly with synthetic tool
// results. This port does the same under happy-dom — no bundle, no browser.
//
// Regression coverage: a live review result belongs to the emitting session.
// Background opens and closes update that session's durable review/workspace
// state without mutating foreground `state.review*` fields. Switching to the
// owner later hydrates the already-open group and active file. Lazy imports
// retain ownership even if selection changes, while replay stays content-only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const annotationStoreMocks = vi.hoisted(() => ({
	clearAnnotations: vi.fn(),
	clearAllAnnotations: vi.fn(),
	clearReviewSubmitted: vi.fn(),
	initAnnotationStore: vi.fn(),
	isReviewSubmitted: vi.fn(),
}));
const reviewSourceMocks = vi.hoisted(() => ({
	cleanupReviewGroup: vi.fn(),
	clearPersistedReviewDocuments: vi.fn(),
	loadReviewSources: vi.fn(),
	openMarkdownReview: vi.fn(),
	readPersistedReviewGroups: vi.fn(),
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
	cleanupReviewGroup: reviewSourceMocks.cleanupReviewGroup,
	clearPersistedReviewDocuments: reviewSourceMocks.clearPersistedReviewDocuments,
	// Keep both names at this mocked boundary while the single-document API is
	// migrated to an explicit review-group API. Assertions use the shared spy.
	openMarkdownReviewDocument: reviewSourceMocks.openMarkdownReview,
	openMarkdownReviewGroup: reviewSourceMocks.openMarkdownReview,
	readPersistedReviewGroups: reviewSourceMocks.readPersistedReviewGroups,
	removePersistedReviewDocument: reviewSourceMocks.removePersistedReviewDocument,
	restorePersistedReviewDocuments: reviewSourceMocks.restorePersistedReviewDocuments,
};

const persistedReviewOpens = new Map<string, any[]>();

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
	state.reviewGroupsBySession = {};
	state.reviewGroups = new Map();
	state.reviewActiveReviewId = "";
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
function deliverToolLifecycleEvent(
	a: RemoteAgent,
	type: "tool_execution_start" | "tool_execution_end",
	toolCallId: string,
	toolName: string,
): void {
	(a as any).handleAgentEvent({ type, toolCallId, toolName });
}

let reviewToolCallSequence = 0;
async function deliverReviewToolResult(
	a: RemoteAgent,
	action: string,
	payload: any,
	isLive = true,
	shape = "json-text",
	options: {
		toolCallId?: string;
		toolName?: string;
		start?: boolean;
		endBeforeResult?: boolean;
	} = {},
): Promise<string> {
	const toolCallId = options.toolCallId ?? `review-call-${++reviewToolCallSequence}`;
	const toolName = options.toolName ?? action;
	if (options.start !== false) deliverToolLifecycleEvent(a, "tool_execution_start", toolCallId, toolName);
	if (options.endBeforeResult) deliverToolLifecycleEvent(a, "tool_execution_end", toolCallId, toolName);

	const envelope = { action, ...payload };
	const json = JSON.stringify(envelope);
	const resultContent = shape === "structured"
		? [{ type: "text", text: "(tool ack)" }, envelope]
		: [{ type: "text", text: "(tool ack)" }, { type: "text", text: json }];
	const msg = shape === "nested-tool-result"
		? {
			role: "user",
			content: [{
				type: "tool_result",
				tool_use_id: toolCallId,
				content: resultContent,
			}],
		}
		: { role: "toolResult", toolCallId, toolName, content: resultContent };
	await (a as any)._checkReviewToolResult(msg, isLive);
	return toolCallId;
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

	reviewSourceMocks.cleanupReviewGroup.mockReset();
	reviewSourceMocks.clearPersistedReviewDocuments.mockReset();
	reviewSourceMocks.loadReviewSources.mockReset();
	reviewSourceMocks.loadReviewSources.mockResolvedValue(mockReviewSourcesModule);
	persistedReviewOpens.clear();
	reviewToolCallSequence = 0;
	reviewSourceMocks.openMarkdownReview.mockReset();
	reviewSourceMocks.openMarkdownReview.mockImplementation((options: any) => {
		const sessionId = String(options.sessionId || "");
		const files = (options.files || [{ title: options.title, markdown: options.markdown }]).map((file: any, index: number) => ({
			...file,
			fileId: file.fileId || `${options.reviewId || options.title}-file-${index + 1}`,
		}));
		const persisted = structuredClone({
			...options,
			files,
			activeFileId: options.activeFileId ?? files[0]?.fileId,
		});
		persistedReviewOpens.set(sessionId, [
			...(persistedReviewOpens.get(sessionId) || []),
			persisted,
		]);
		state.reviewGroupsBySession[sessionId] = persistedReviewOpens.get(sessionId)! as any;
		const document = { title: files[0].title, markdown: files[0].markdown };
		if (sessionId !== state.selectedSessionId) return document;
		state.reviewGroups = new Map([[persisted.reviewId || options.title, persisted as any]]);
		state.reviewActiveReviewId = persisted.reviewId || options.title;
		state.reviewDocuments = new Map(files.map((file: any) => [file.fileId, {
			title: file.title,
			markdown: file.markdown,
			reviewId: persisted.reviewId,
			fileId: file.fileId,
		}]));
		state.reviewActiveTab = persisted.activeFileId;
		state.reviewPanelOpen = true;
		return document;
	});
	reviewSourceMocks.readPersistedReviewGroups.mockReset();
	reviewSourceMocks.readPersistedReviewGroups.mockImplementation((sessionId: string) => persistedReviewOpens.get(sessionId) || []);
	reviewSourceMocks.cleanupReviewGroup.mockReset();
	reviewSourceMocks.cleanupReviewGroup.mockImplementation((sessionId: string, reviewId: string) => {
		const reviews = persistedReviewOpens.get(sessionId) || [];
		const removed = reviews.find((review) => review.reviewId === reviewId);
		persistedReviewOpens.set(sessionId, reviews.filter((review) => review.reviewId !== reviewId));
		return removed;
	});
	reviewSourceMocks.removePersistedReviewDocument.mockReset();
	reviewSourceMocks.removePersistedReviewDocument.mockImplementation((sessionId: string, identity: string) => {
		const reviews = persistedReviewOpens.get(sessionId) || [];
		persistedReviewOpens.set(sessionId, reviews.filter((review) =>
			review.reviewId !== identity && review.title !== identity));
	});
	reviewSourceMocks.restorePersistedReviewDocuments.mockReset();
	reviewSourceMocks.restorePersistedReviewDocuments.mockImplementation((sessionId: string) => {
		if (sessionId !== state.selectedSessionId) return;
		const reviews = persistedReviewOpens.get(sessionId) || [];
		state.reviewGroups = new Map(reviews.map((review) => [review.reviewId || review.title, review]));
		state.reviewActiveReviewId = reviews[0]?.reviewId || reviews[0]?.title || "";
		const active = reviews[0];
		state.reviewDocuments = new Map((active?.files || []).map((file: any) => [file.fileId, {
			title: file.title,
			markdown: file.markdown,
			reviewId: active.reviewId,
			fileId: file.fileId,
		}]));
		state.reviewActiveTab = active?.activeFileId || "";
		state.reviewPanelOpen = reviews.length > 0;
	});
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

describe("review tool session ownership", () => {
	it("REVIEW_BACKGROUND_OPEN_DURABILITY: live background review_open persists the full group for its owner without replacing foreground state", async () => {
		const active = makeAgent("active-session");
		const background = makeAgent("background-session");
		setActive(active);
		seedReviewState();
		const foregroundBefore = getReviewState();
		const files = [
			{ fileId: "background-file-1", title: "Overview", markdown: "# Background overview" },
			{ fileId: "background-file-2", title: "Details", markdown: "# Background details" },
		];

		await deliverReviewToolResult(background, "review_open", {
			reviewId: "background-review-1",
			title: "PR from background",
			files,
			replace: true,
		});

		expect(reviewSourceMocks.openMarkdownReview).toHaveBeenCalledWith(expect.objectContaining({
			reviewId: "background-review-1",
			title: "PR from background",
			files,
			replace: true,
			sessionId: "background-session",
		}));
		expect(persistedReviewOpens.get("background-session")).toHaveLength(1);
		expect(getReviewState()).toEqual(foregroundBefore);
		expect(state.selectedSessionId).toBe("active-session");
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
		expect(result.activeTab).toBe("PR-from-active-file-1");
		expect(result.docCount).toBe(1);
		expect(result.docTitles).toEqual(["PR-from-active-file-1"]);
	});

	it("REVIEW_BACKGROUND_OPEN_DURABILITY: lazy review_open remains durable for its owner after a session switch", async () => {
		const active = makeAgent("active-session");
		const next = makeAgent("next-session");
		setActive(active);
		clearReviewState();

		const pending = deliverReviewToolResult(active, "review_open", {
			reviewId: "late-review",
			title: "Late PR",
			files: [{ fileId: "late-file", title: "Late", markdown: "# Must persist for the prior session" }],
		});
		setActive(next);
		await pending;

		expect(reviewSourceMocks.openMarkdownReview).toHaveBeenCalledWith(expect.objectContaining({
			reviewId: "late-review",
			sessionId: "active-session",
		}));
		expect(persistedReviewOpens.get("active-session")).toHaveLength(1);
		expect(getReviewState()).toEqual({ open: false, activeTab: "", docCount: 0, docTitles: [] });
	});

	it("active session's inline review_open also handles structured nested tool-result payloads", async () => {
		const active = makeAgent("active-session");
		setActive(active);
		clearReviewState();

		await deliverReviewToolResult(active, "review_open", {
			title: "Structured inline markdown",
			markdown: "# Inline\n\nOpened from a structured result object.",
		}, true, "nested-tool-result");

		const result = getReviewState();
		expect(result.open).toBe(true);
		expect(result.activeTab).toBe("Structured inline markdown-file-1");
		expect(result.docCount).toBe(1);
		expect(result.docTitles).toEqual(["Structured inline markdown-file-1"]);
	});

	it("retains review provenance when the result arrives after tool_execution_end", async () => {
		const active = makeAgent("active-session");
		setActive(active);

		await deliverReviewToolResult(active, "review_open", {
			reviewId: "after-end-review",
			title: "After end",
			files: [{ fileId: "after-end-file", title: "File", markdown: "# After end" }],
		}, true, "structured", { endBeforeResult: true });

		expect(reviewSourceMocks.openMarkdownReview).toHaveBeenCalledWith(expect.objectContaining({
			reviewId: "after-end-review",
			sessionId: "active-session",
		}));
	});

	it("historical replay cannot recreate an absent review primary", async () => {
		const active = makeAgent("active-session");
		setActive(active);
		clearReviewState();

		await deliverReviewToolResult(active, "review_open", {
			reviewId: "closed-review",
			title: "Closed review",
			files: [{ fileId: "closed-file", title: "Closed", markdown: "# Closed" }],
		}, false);

		expect(reviewSourceMocks.openMarkdownReview).not.toHaveBeenCalled();
		expect(persistedReviewOpens.has("active-session")).toBe(false);
		expect(getReviewState()).toEqual({ open: false, activeTab: "", docCount: 0, docTitles: [] });
	});

	it("REVIEW_BACKGROUND_OPEN_DURABILITY: background review_close removes only the owner's persisted review", async () => {
		const active = makeAgent("active-session");
		const background = makeAgent("background-session");
		setActive(active);
		seedReviewState("Active PR");
		const before = getReviewState();
		persistedReviewOpens.set("background-session", [{
			reviewId: "background-review",
			title: "Background PR",
			files: [{ fileId: "background-file", title: "Notes", markdown: "# Notes" }],
		}]);

		await deliverReviewToolResult(background, "review_close", {
			reviewId: "background-review",
			title: "Background PR",
		});

		expect(reviewSourceMocks.cleanupReviewGroup).toHaveBeenCalledWith(
			"background-session",
			"background-review",
		);
		expect(persistedReviewOpens.get("background-session")).toEqual([]);
		expect(getReviewState()).toEqual(before);
	});

	it("REVIEW_BACKGROUND_OPEN_DURABILITY: lazy review_close remains scoped to its owner after a session switch", async () => {
		const closing = makeAgent("closing-session");
		const next = makeAgent("next-session");
		setActive(closing);
		persistedReviewOpens.set("closing-session", [{
			reviewId: "closing-review",
			title: "Closing PR",
			files: [{ fileId: "closing-file", title: "File", markdown: "# Closing" }],
		}]);

		const pending = deliverReviewToolResult(closing, "review_close", {
			reviewId: "closing-review",
			title: "Closing PR",
		});
		setActive(next);
		seedReviewState("Next foreground review");
		const nextBefore = getReviewState();
		await pending;

		expect(reviewSourceMocks.cleanupReviewGroup).toHaveBeenCalledWith(
			"closing-session",
			"closing-review",
		);
		expect(persistedReviewOpens.get("closing-session")).toEqual([]);
		expect(getReviewState()).toEqual(nextBefore);
	});

	it("REVIEW_BACKGROUND_OPEN_DURABILITY: switching to the owner hydrates the background review and selected file", async () => {
		const foreground = makeAgent("foreground-session");
		const background = makeAgent("background-session");
		setActive(foreground);
		seedReviewState();

		await deliverReviewToolResult(background, "review_open", {
			reviewId: "durable-review",
			title: "Durable background PR",
			files: [
				{ fileId: "selected-file", title: "Selected file", markdown: "# Selected" },
				{ fileId: "other-file", title: "Other file", markdown: "# Other" },
			],
		});
		expect(getReviewState().docTitles).toEqual(["Foreground review"]);

		setActive(background);
		await deliverSnapshot(background, []);

		expect(reviewSourceMocks.restorePersistedReviewDocuments).toHaveBeenCalledWith(
			"background-session",
			{ select: true },
		);
		expect(getReviewState()).toEqual({
			open: true,
			activeTab: "selected-file",
			docCount: 2,
			docTitles: ["selected-file", "other-file"],
		});
		expect(persistedReviewOpens.get("background-session")?.[0]).toEqual(expect.objectContaining({
			activeFileId: "selected-file",
		}));
	});
});

describe("review tool result provenance", () => {
	function seedOwnedReview(sessionId: string, reviewId = "protected-review") {
		const group = {
			reviewId,
			title: "Protected review",
			files: [{ fileId: `${reviewId}-file`, title: "Notes", markdown: "# Keep me" }],
		};
		persistedReviewOpens.set(sessionId, [group]);
		state.reviewGroupsBySession[sessionId] = [group] as any;
		return group;
	}

	function expectNoDestructiveReviewCalls(): void {
		expect(reviewSourceMocks.openMarkdownReview).not.toHaveBeenCalled();
		expect(reviewSourceMocks.cleanupReviewGroup).not.toHaveBeenCalled();
		expect(reviewSourceMocks.removePersistedReviewDocument).not.toHaveBeenCalled();
		expect(reviewSourceMocks.clearPersistedReviewDocuments).not.toHaveBeenCalled();
		expect(annotationStoreMocks.clearAnnotations).not.toHaveBeenCalled();
		expect(annotationStoreMocks.clearAllAnnotations).not.toHaveBeenCalled();
		expect(annotationStoreMocks.clearReviewSubmitted).not.toHaveBeenCalled();
	}

	it("rejects close JSON from unrelated read and bash tool results in selected and background sessions", async () => {
		const selected = makeAgent("selected-session");
		const background = makeAgent("background-session");
		setActive(selected);
		seedReviewState("Visible review");
		const foregroundBefore = getReviewState();
		const selectedGroup = seedOwnedReview("selected-session", "selected-protected");
		const backgroundGroup = seedOwnedReview("background-session", "background-protected");
		const closeJson = JSON.stringify({ action: "review_close" });

		for (const [agent, toolCallId, toolName] of [
			[selected, "read-call", "read"],
			[background, "bash-call", "bash"],
		] as const) {
			deliverToolLifecycleEvent(agent, "tool_execution_start", toolCallId, toolName);
			await (agent as any)._checkReviewToolResult({
				role: "toolResult",
				toolCallId,
				toolName,
				content: [{ type: "text", text: closeJson }],
			}, true);
		}

		expectNoDestructiveReviewCalls();
		expect(persistedReviewOpens.get("selected-session")).toEqual([selectedGroup]);
		expect(persistedReviewOpens.get("background-session")).toEqual([backgroundGroup]);
		expect(getReviewState()).toEqual(foregroundBefore);
	});

	it("rejects ordinary user/result text even when a review call is pending", async () => {
		const active = makeAgent("active-session");
		setActive(active);
		const group = seedOwnedReview("active-session");
		const toolCallId = "pending-review-close";
		deliverToolLifecycleEvent(active, "tool_execution_start", toolCallId, "review_close");
		const text = JSON.stringify({ action: "review_close" });

		await (active as any)._checkReviewToolResult({
			role: "user",
			content: [{ type: "text", text }],
		}, true);
		await (active as any)._checkReviewToolResult({
			role: "result",
			toolCallId,
			content: [{ type: "text", text }],
		}, true);

		expectNoDestructiveReviewCalls();
		expect(persistedReviewOpens.get("active-session")).toEqual([group]);
	});

	it("rejects missing and unrecognized correlation IDs", async () => {
		const active = makeAgent("active-session");
		setActive(active);
		const group = seedOwnedReview("active-session");
		deliverToolLifecycleEvent(active, "tool_execution_start", "known-review-close", "review_close");
		const content = [{ type: "text", text: JSON.stringify({ action: "review_close" }) }];

		await (active as any)._checkReviewToolResult({ role: "toolResult", content }, true);
		await (active as any)._checkReviewToolResult({
			role: "toolResult",
			toolCallId: "unknown-review-close",
			content,
		}, true);

		expectNoDestructiveReviewCalls();
		expect(persistedReviewOpens.get("active-session")).toEqual([group]);
	});

	it("rejects an action that does not match the recorded review tool name", async () => {
		const active = makeAgent("active-session");
		setActive(active);
		const group = seedOwnedReview("active-session");

		await deliverReviewToolResult(active, "review_close", {}, true, "json-text", {
			toolCallId: "mismatched-review-call",
			toolName: "review_open",
		});

		expectNoDestructiveReviewCalls();
		expect(persistedReviewOpens.get("active-session")).toEqual([group]);
	});

	it("consumes valid review provenance so duplicate result replay is non-mutating", async () => {
		const active = makeAgent("active-session");
		setActive(active);
		seedOwnedReview("active-session");
		const toolCallId = "single-use-review-close";

		await deliverReviewToolResult(active, "review_close", {
			reviewId: "protected-review",
		}, true, "structured", { toolCallId });
		expect(reviewSourceMocks.cleanupReviewGroup).toHaveBeenCalledOnce();

		// Restore the same group so a forged second authorization would be visible.
		seedOwnedReview("active-session");
		await deliverReviewToolResult(active, "review_close", {
			reviewId: "protected-review",
		}, true, "structured", { toolCallId, start: false });

		expect(reviewSourceMocks.cleanupReviewGroup).toHaveBeenCalledOnce();
		expect(persistedReviewOpens.get("active-session")).toHaveLength(1);
	});

	it("expires stale review call IDs before accepting their results", async () => {
		const active = makeAgent("active-session");
		setActive(active);
		const group = seedOwnedReview("active-session");
		const toolCallId = "stale-review-close";
		deliverToolLifecycleEvent(active, "tool_execution_start", toolCallId, "review_close");
		const pending = (active as any)._pendingReviewToolCalls.get(toolCallId);
		pending.recordedAt = Date.now() - 16 * 60_000;

		await deliverReviewToolResult(active, "review_close", {}, true, "json-text", {
			toolCallId,
			start: false,
		});

		expectNoDestructiveReviewCalls();
		expect(persistedReviewOpens.get("active-session")).toEqual([group]);
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
