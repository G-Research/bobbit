import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
	gatewayFetch: vi.fn(),
	applyWorkspace: vi.fn(),
	getArtifactReferences: vi.fn(),
	commitArtifactGroup: vi.fn(),
}));

vi.mock("../../src/app/gateway-fetch.js", () => ({ gatewayFetch: boundary.gatewayFetch }));
vi.mock("../../src/app/review-sources-lazy.js", () => ({
	loadReviewSources: vi.fn(async () => ({
		getArtifactReviewWorkspaceReferences: boundary.getArtifactReferences,
		commitArtifactReviewGroup: boundary.commitArtifactGroup,
	})),
}));
vi.mock("../../src/app/side-panel-workspace.js", () => ({
	applySidePanelWorkspaceFromServer: boundary.applyWorkspace,
	hydrateSidePanelWorkspace: vi.fn(),
}));

import { RemoteAgent } from "../../src/app/remote-agent.js";
import {
	getReviewOpenState,
	hydrateArtifactReviewsForWorkspace,
	openReviewReceipt,
	parseReviewOpenReceipt,
	registerReviewOpenReceipt,
	resetReviewOpenCoordinatorForTests,
	reviewOpenReceiptFromToolResult,
	reviewPayloadOpenRoute,
	reviewPayloadRoute,
	subscribeReviewOpenStates,
	type ReviewOpenReceipt,
} from "../../src/app/review-open-controller.js";

const HASH = "a".repeat(64);
const SESSION_ID = "session-owner";
const TOOL_ID = "tool-call-1";

function receipt(overrides: Partial<ReviewOpenReceipt> = {}): ReviewOpenReceipt {
	return {
		action: "review_open",
		version: 2,
		toolCallId: TOOL_ID,
		payloadId: "payload-1",
		reviewId: "review-1",
		title: "Large review",
		contentHash: HASH,
		totalBytes: 8,
		files: [
			{ fileId: "file-a", title: "First", bytes: 3 },
			{ fileId: "file-b", title: "Second", bytes: 5 },
		],
		activeFileId: "file-b",
		replace: true,
		open: { status: "opened" },
		...overrides,
	};
}

function payload(sessionId = SESSION_ID, title = "Large review", fileTitles = ["First", "Second"]) {
	return {
		action: "review_open",
		version: 2,
		sessionId,
		toolCallId: TOOL_ID,
		payloadId: "payload-1",
		hash: HASH,
		totalBytes: 8,
		reviewId: "review-1",
		title,
		files: [
			{ fileId: "file-a", title: fileTitles[0]!, markdown: "one", bytes: 3 },
			{ fileId: "file-b", title: fileTitles[1]!, markdown: "three", bytes: 5 },
		],
		activeFileId: "file-b",
		replace: true,
	};
}

function workspace(sessionId = SESSION_ID, title = "Large review") {
	return {
		version: 1,
		sessionId,
		revision: 4,
		activeTabId: "review:review-1",
		sizeMode: "split",
		updatedAt: Date.now(),
		tabs: [{
			id: "review:review-1",
			kind: "review",
			title: `Review: ${title}`,
			label: `Review: ${title}`,
			source: {
				type: "review",
				sessionId,
				reviewId: "review-1",
				title,
				toolCallId: TOOL_ID,
				payloadId: "payload-1",
				contentHash: HASH,
			},
			state: { activeFileId: "file-b" },
			updatedAt: Date.now(),
		}],
	};
}

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

beforeEach(() => {
	resetReviewOpenCoordinatorForTests();
	boundary.gatewayFetch.mockReset();
	boundary.applyWorkspace.mockReset();
	boundary.commitArtifactGroup.mockReset();
	boundary.getArtifactReferences.mockReset();
	boundary.getArtifactReferences.mockImplementation((sessionId: string) => [{
		sessionId,
		reviewId: "review-1",
		title: "Large review",
		toolCallId: TOOL_ID,
		payloadId: "payload-1",
		contentHash: HASH,
		activeFileId: "file-b",
	}]);
});

describe("review open receipt coordination", () => {
	it("validates a payload-free v2 receipt with exact tool, file order, bytes, and active identity", () => {
		const parsed = parseReviewOpenReceipt({ ...receipt(), hash: HASH, contentHash: undefined }, TOOL_ID);
		expect(parsed).toEqual(expect.objectContaining({
			toolCallId: TOOL_ID,
			payloadId: "payload-1",
			reviewId: "review-1",
			contentHash: HASH,
			activeFileId: "file-b",
		}));
		expect(parsed?.files.map((file) => file.fileId)).toEqual(["file-a", "file-b"]);
		expect(parseReviewOpenReceipt(receipt(), "different-tool")).toBeNull();
		expect(parseReviewOpenReceipt({
			...receipt(),
			files: [{ fileId: "file-a", title: "First", bytes: 8, markdown: "forged" }],
			activeFileId: "file-a",
		})).toBeNull();
		expect(parseReviewOpenReceipt({ ...receipt(), totalBytes: 10 * 1024 * 1024 + 1 })).toBeNull();
	});

	it("extracts one exactly correlated receipt without treating passive render as an open", () => {
		const result = {
			role: "toolResult",
			toolCallId: TOOL_ID,
			content: [{ type: "text", text: "ack" }, { type: "text", text: JSON.stringify(receipt()) }],
		};
		const parsed = reviewOpenReceiptFromToolResult(result, TOOL_ID);
		expect(parsed?.payloadId).toBe("payload-1");
		expect(reviewOpenReceiptFromToolResult(result, "another-call")).toBeNull();
		expect(reviewOpenReceiptFromToolResult({ ...result, content: [...result.content, receipt()] }, TOOL_ID)).toBeNull();

		const state = registerReviewOpenReceipt(SESSION_ID, TOOL_ID, parsed);
		expect(state.phase).toBe("available");
		expect(boundary.gatewayFetch).not.toHaveBeenCalled();
		expect(boundary.applyWorkspace).not.toHaveBeenCalled();
	});

	it("deduplicates a pending automatic/manual open and publishes success under exact correlation", async () => {
		let releasePayload!: () => void;
		const payloadReady = new Promise<void>((resolve) => { releasePayload = resolve; });
		boundary.gatewayFetch
			.mockImplementationOnce(async () => {
				await payloadReady;
				return response(payload());
			})
			.mockResolvedValueOnce(response({ ok: true, workspace: workspace() }));
		const phases: string[] = [];
		subscribeReviewOpenStates((next) => phases.push(next.phase));
		const parsed = parseReviewOpenReceipt(receipt(), TOOL_ID)!;

		const automatic = openReviewReceipt({ sessionId: SESSION_ID, toolUseId: TOOL_ID, receipt: parsed, intent: "automatic" });
		const manual = openReviewReceipt({ sessionId: SESSION_ID, toolUseId: TOOL_ID, receipt: parsed, intent: "manual" });
		expect(getReviewOpenState(SESSION_ID, TOOL_ID, "payload-1")?.phase).toBe("pending");
		releasePayload();
		const [first, second] = await Promise.all([automatic, manual]);

		expect(first.phase).toBe("success");
		expect(second).toBe(first);
		expect(boundary.gatewayFetch).toHaveBeenCalledTimes(2);
		expect(boundary.gatewayFetch.mock.calls[0][0]).toBe(reviewPayloadRoute(SESSION_ID, "payload-1", TOOL_ID, "review-1", HASH));
		expect(boundary.gatewayFetch.mock.calls[1][0]).toBe(reviewPayloadOpenRoute(SESSION_ID, "payload-1", TOOL_ID));
		expect(boundary.commitArtifactGroup).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: SESSION_ID, toolCallId: TOOL_ID, payloadId: "payload-1" }),
			expect.objectContaining({ reviewId: "review-1", activeFileId: "file-b" }),
		);
		expect(boundary.applyWorkspace).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: SESSION_ID,
			activeTabId: "review:review-1",
		}), { source: "rest" });
		expect(phases).toEqual(["pending", "success"]);
	});

	it("opens accepted whitespace and >160-character titles without changing exact identity", async () => {
		const exactTitle = `  ${"é".repeat(150)}${"x".repeat(12)}  `;
		const exactFileTitle = ` ${"界".repeat(90)}${"y".repeat(30)} `;
		const exactReceipt = receipt({
			title: exactTitle,
			files: [
				{ fileId: "file-a", title: exactFileTitle, bytes: 3 },
				{ fileId: "file-b", title: "  ", bytes: 5 },
			],
		});
		boundary.getArtifactReferences.mockImplementation((sessionId: string) => [{
			sessionId,
			reviewId: "review-1",
			title: exactTitle,
			toolCallId: TOOL_ID,
			payloadId: "payload-1",
			contentHash: HASH,
			activeFileId: "file-b",
		}]);
		boundary.gatewayFetch
			.mockResolvedValueOnce(response(payload(SESSION_ID, exactTitle, [exactFileTitle, "  "])))
			.mockResolvedValueOnce(response({ ok: true, workspace: workspace(SESSION_ID, exactTitle) }));

		const parsed = parseReviewOpenReceipt(exactReceipt, TOOL_ID);
		expect(parsed?.title).toBe(exactTitle);
		expect(parsed?.files.map((file) => file.title)).toEqual([exactFileTitle, "  "]);
		const outcome = await openReviewReceipt({
			sessionId: SESSION_ID,
			toolUseId: TOOL_ID,
			receipt: parsed!,
			intent: "automatic",
		});

		expect(outcome.phase).toBe("success");
		expect(boundary.commitArtifactGroup).toHaveBeenCalledWith(
			expect.objectContaining({ title: exactTitle }),
			expect.objectContaining({ title: exactTitle, files: [
				expect.objectContaining({ title: exactFileTitle }),
				expect.objectContaining({ title: "  " }),
			] }),
		);

		boundary.gatewayFetch.mockClear();
		boundary.commitArtifactGroup.mockClear();
		boundary.gatewayFetch.mockResolvedValueOnce(response(payload(SESSION_ID, exactTitle, [exactFileTitle, "  "])));
		await hydrateArtifactReviewsForWorkspace(SESSION_ID);
		expect(boundary.gatewayFetch).toHaveBeenCalledOnce();
		expect(boundary.commitArtifactGroup).toHaveBeenCalledWith(
			expect.objectContaining({ title: exactTitle }),
			expect.objectContaining({ title: exactTitle }),
		);
	});

	it("maps server failures to safe retry state and keeps the same receipt reusable", async () => {
		boundary.gatewayFetch
			.mockResolvedValueOnce(response(payload()))
			.mockResolvedValueOnce(response({ code: "REVIEW_WORKSPACE_CONFLICT", message: "C:\\secret\\raw stack" }, 409))
			.mockResolvedValueOnce(response(payload()))
			.mockResolvedValueOnce(response({ ok: true, workspace: workspace() }));
		const parsed = parseReviewOpenReceipt(receipt(), TOOL_ID)!;
		const request = { sessionId: SESSION_ID, toolUseId: TOOL_ID, receipt: parsed, intent: "manual" as const };

		const failed = await openReviewReceipt(request);
		expect(failed).toEqual(expect.objectContaining({
			phase: "error",
			code: "REVIEW_WORKSPACE_CONFLICT",
			retryable: true,
			message: "The review workspace changed. Retry opening it.",
		}));
		expect(JSON.stringify(failed)).not.toContain("secret");
		expect(boundary.applyWorkspace).not.toHaveBeenCalled();

		const retried = await openReviewReceipt(request);
		expect(retried.phase).toBe("success");
		expect(boundary.applyWorkspace).toHaveBeenCalledOnce();
	});

	it("fails closed before client mutation when canonical or workspace identity differs", async () => {
		const wrongWorkspace = workspace();
		(wrongWorkspace.tabs[0].source as any).payloadId = "sibling-payload";
		boundary.gatewayFetch
			.mockResolvedValueOnce(response(payload()))
			.mockResolvedValueOnce(response({ ok: true, workspace: wrongWorkspace }));
		const outcome = await openReviewReceipt({
			sessionId: SESSION_ID,
			toolUseId: TOOL_ID,
			receipt: parseReviewOpenReceipt(receipt(), TOOL_ID)!,
			intent: "automatic",
		});
		expect(outcome).toEqual(expect.objectContaining({
			phase: "error",
			code: "REVIEW_CLIENT_OPEN_FAILED",
			retryable: true,
		}));
		expect(boundary.commitArtifactGroup).not.toHaveBeenCalled();
		expect(boundary.applyWorkspace).not.toHaveBeenCalled();
	});

	it("keeps a background owner on its own route and workspace", async () => {
		const owner = "background-session";
		boundary.gatewayFetch
			.mockResolvedValueOnce(response(payload(owner)))
			.mockResolvedValueOnce(response({ ok: true, workspace: workspace(owner) }));
		const outcome = await openReviewReceipt({
			sessionId: owner,
			toolUseId: TOOL_ID,
			receipt: parseReviewOpenReceipt(receipt(), TOOL_ID)!,
			intent: "automatic",
		});
		expect(outcome.phase).toBe("success");
		expect(boundary.gatewayFetch.mock.calls[0][0]).toContain("/background-session/review-payloads/");
		expect(boundary.applyWorkspace).toHaveBeenCalledWith(expect.objectContaining({ sessionId: owner }), { source: "rest" });
	});

	it("hydrates reload content only from an authoritative reference and never POSTs", async () => {
		boundary.gatewayFetch.mockResolvedValueOnce(response(payload()));
		await hydrateArtifactReviewsForWorkspace(SESSION_ID);
		expect(boundary.gatewayFetch).toHaveBeenCalledOnce();
		expect(boundary.gatewayFetch.mock.calls[0][1]).toBeUndefined();
		expect(boundary.applyWorkspace).not.toHaveBeenCalled();
		expect(boundary.commitArtifactGroup).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: SESSION_ID, reviewId: "review-1", activeFileId: "file-b" }),
			expect.objectContaining({ payloadId: "payload-1", reviewId: "review-1" }),
		);

		boundary.gatewayFetch.mockClear();
		boundary.commitArtifactGroup.mockClear();
		boundary.getArtifactReferences.mockReturnValue([]);
		await hydrateArtifactReviewsForWorkspace(SESSION_ID);
		expect(boundary.gatewayFetch).not.toHaveBeenCalled();
		expect(boundary.commitArtifactGroup).not.toHaveBeenCalled();
	});

	it("accepts v2 automatic opens only with fresh live RemoteAgent provenance", async () => {
		boundary.gatewayFetch
			.mockResolvedValueOnce(response(payload()))
			.mockResolvedValueOnce(response({ ok: true, workspace: workspace() }));
		const agent = new RemoteAgent();
		(agent as any)._sessionId = SESSION_ID;
		(agent as any).handleAgentEvent({ type: "tool_execution_start", toolCallId: TOOL_ID, toolName: "review_open" });
		const result = {
			role: "toolResult",
			toolCallId: TOOL_ID,
			toolName: "review_open",
			content: [{ type: "text", text: JSON.stringify(receipt()) }],
		};

		await (agent as any)._checkReviewToolResult(result, true);
		expect(getReviewOpenState(SESSION_ID, TOOL_ID, "payload-1")?.phase).toBe("success");
		expect(boundary.applyWorkspace).toHaveBeenCalledOnce();

		boundary.gatewayFetch.mockClear();
		boundary.applyWorkspace.mockClear();
		await (agent as any)._checkReviewToolResult(result, false);
		expect(boundary.gatewayFetch).not.toHaveBeenCalled();
		expect(boundary.applyWorkspace).not.toHaveBeenCalled();
	});

	it("rejects a forged inner receipt even beside a live correlated tool result", async () => {
		const agent = new RemoteAgent();
		(agent as any)._sessionId = SESSION_ID;
		(agent as any).handleAgentEvent({ type: "tool_execution_start", toolCallId: TOOL_ID, toolName: "review_open" });
		await (agent as any)._checkReviewToolResult({
			role: "toolResult",
			toolCallId: TOOL_ID,
			toolName: "review_open",
			content: [{ type: "text", text: JSON.stringify(receipt({ toolCallId: "forged-tool" })) }],
		}, true);
		expect(boundary.gatewayFetch).not.toHaveBeenCalled();
		expect(boundary.applyWorkspace).not.toHaveBeenCalled();
	});
});
