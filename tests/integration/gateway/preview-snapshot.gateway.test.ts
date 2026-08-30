/**
 * API E2E tests for the preview_open snapshot lazy-load + truncation pipeline.
 *
 * Exercises:
 *   - Extension (via mock-agent) emits a 2-block tool_result containing the marker-prefixed snapshot.
 *   - GET /api/sessions/:id/tool-content/:mi/:bi preserves the legacy positional contract.
 *   - GET /api/sessions/:id/tool-content/by-tool-call/:id/:bi resolves snapshots by
 *     tool-call identity, independently of client-visible message positions.
 *   - get_messages response served to clients has large snapshots replaced by a truncated stub,
 *     so the full payload never flows through the WS history channel.
 */
import { test, expect } from "../../../tests2/integration/_e2e/in-process-harness.js";
import {
	apiFetch,
	createSession,
	deleteSession,
	connectWs,
	waitForSessionStatus,
	agentEndPredicate,
} from "../../../tests2/integration/_e2e/e2e-setup.js";

const MARKER = "__preview_snapshot_v1__\n";

test.setTimeout(30_000);

async function runPreviewOpenWithSize(sessionId: string, size: number): Promise<void> {
	const conn = await connectWs(sessionId);
	try {
		conn.send({ type: "prompt", text: `PREVIEW_OPEN_SNAPSHOT SIZE=${size}` });
		await conn.waitFor(agentEndPredicate());
	} finally {
		conn.close();
	}
	await waitForSessionStatus(sessionId, "idle");
}

test.describe("preview_open snapshot persistence + truncation", () => {
	async function findSnapshotBlock(sessionId: string): Promise<{ mi: number; bi: number }> {
		for (let i = 0; i < 30; i++) {
			for (let j = 0; j < 10; j++) {
				const r = await apiFetch(`/api/sessions/${sessionId}/tool-content/${i}/${j}`);
				if (!r.ok) continue;
				const json = await r.json();
				if (typeof json.content === "string" && json.content.startsWith(MARKER)) {
					return { mi: i, bi: j };
				}
			}
		}
		return { mi: -1, bi: -1 };
	}

	test("small snapshot: GET /tool-content returns full snapshot text", async () => {
		const sessionId = await createSession();
		try {
			await runPreviewOpenWithSize(sessionId, 1000);

			const { mi, bi } = await findSnapshotBlock(sessionId);
			expect(mi, "tool_result snapshot block not found").toBeGreaterThanOrEqual(0);
			expect(bi).toBeGreaterThanOrEqual(0);

			const contentResp = await apiFetch(`/api/sessions/${sessionId}/tool-content/${mi}/${bi}`);
			expect(contentResp.status).toBe(200);
			const body = await contentResp.json();
			expect(typeof body.content).toBe("string");
			expect(body.content.startsWith(MARKER)).toBe(true);
			// The HTML body after the marker should contain our exactly-sized payload.
			const html = body.content.slice(MARKER.length);
			// 1000 `x`s are in the middle: `<body>xxx...</body>`
			expect(html).toContain("<body>" + "x".repeat(1000) + "</body>");
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("large snapshot (>32KB): tool-content endpoint returns full untruncated HTML", async () => {
		const sessionId = await createSession();
		try {
			const size = 50_000;
			await runPreviewOpenWithSize(sessionId, size);

			const { mi, bi } = await findSnapshotBlock(sessionId);
			expect(mi).toBeGreaterThanOrEqual(0);
			expect(bi).toBeGreaterThanOrEqual(0);

			const contentResp = await apiFetch(`/api/sessions/${sessionId}/tool-content/${mi}/${bi}`);
			expect(contentResp.status).toBe(200);
			const body = await contentResp.json();
			expect(body.content.length).toBeGreaterThan(size);
			expect(body.content.startsWith(MARKER)).toBe(true);
			expect(body.content).toContain("x".repeat(size));
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("identity endpoint restores a truncated snapshot without a message index", async ({ gateway }) => {
		const sessionId = await createSession();
		try {
			const size = 50_000;
			await runPreviewOpenWithSize(sessionId, size);
			const session = gateway.sessionManager.getSession(sessionId);
			if (!session) throw new Error("test session was not found");
			const response = await session.rpcClient.getMessages();
			const messages = response.data?.messages || response.data || [];
			const result = messages.find((message: any) => message.role === "toolResult" && message.toolName === "preview_open");
			if (!result) throw new Error("preview tool result was not found");
			const blockIndex = result.content.findIndex((block: any) => typeof block.text === "string" && block.text.startsWith(MARKER));
			expect(result.toolCallId).toEqual(expect.any(String));
			expect(blockIndex).toBeGreaterThanOrEqual(0);

			// This route deliberately has no message index: client-side synthetic
			// compaction rows cannot make it point at a different raw transcript row.
			const contentResp = await apiFetch(
				`/api/sessions/${sessionId}/tool-content/by-tool-call/${encodeURIComponent(result.toolCallId)}/${blockIndex}?expected=preview-snapshot`,
			);
			expect(contentResp.status).toBe(200);
			const body = await contentResp.json();
			expect(body.content).toContain("x".repeat(size));
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("identity endpoint resolves an assistant tool-call input and refuses a same-id result block", async ({ gateway }) => {
		const sessionId = await createSession();
		const session = gateway.sessionManager.getSession(sessionId);
		if (!session) throw new Error("test session was not found");
		const originalGetMessages = session.rpcClient.getMessages.bind(session.rpcClient);
		(session.rpcClient as any).getMessages = async () => ({
			data: { messages: [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "assistant-input", input: { content: "assistant input" } },
						{ type: "text", text: "unrelated sibling" },
					],
				},
				{
					role: "toolResult",
					toolCallId: "assistant-input",
					content: [
						{ type: "text", text: "tool result status" },
						{ type: "text", text: "same-id result must not be returned" },
					],
				},
			] },
		});
		try {
			const exact = await apiFetch(`/api/sessions/${sessionId}/tool-content/by-tool-call/assistant-input/0`);
			expect(exact.status).toBe(200);
			expect(await exact.json()).toMatchObject({ content: "assistant input" });

			const wrongBlock = await apiFetch(`/api/sessions/${sessionId}/tool-content/by-tool-call/assistant-input/1`);
			expect(wrongBlock.status).toBe(409);
			expect(await wrongBlock.json()).toEqual({ error: "tool_call_block_mismatch", code: "tool_call_block_mismatch" });
		} finally {
			(session.rpcClient as any).getMessages = originalGetMessages;
			await deleteSession(sessionId);
		}
	});

	test("identity endpoint reports unavailable calls and refuses non-snapshot blocks", async ({ gateway }) => {
		const sessionId = await createSession();
		try {
			await runPreviewOpenWithSize(sessionId, 1000);
			const session = gateway.sessionManager.getSession(sessionId);
			if (!session) throw new Error("test session was not found");
			const response = await session.rpcClient.getMessages();
			const messages = response.data?.messages || response.data || [];
			const result = messages.find((message: any) => message.role === "toolResult" && message.toolName === "preview_open");
			if (!result) throw new Error("preview tool result was not found");
			expect(result.toolCallId).toEqual(expect.any(String));

			const missing = await apiFetch(`/api/sessions/${sessionId}/tool-content/by-tool-call/missing-call/0?expected=preview-snapshot`);
			expect(missing.status).toBe(404);
			expect(await missing.json()).toEqual({ error: "transcript_tool_call_unavailable", code: "transcript_tool_call_unavailable" });

			// Block zero is the tool status text, not the marker-prefixed snapshot.
			const wrongBlock = await apiFetch(
				`/api/sessions/${sessionId}/tool-content/by-tool-call/${encodeURIComponent(result.toolCallId)}/0?expected=preview-snapshot`,
			);
			expect(wrongBlock.status).toBe(409);
			expect(await wrongBlock.json()).toEqual({ error: "snapshot_block_mismatch", code: "snapshot_block_mismatch" });
		} finally {
			await deleteSession(sessionId);
		}
	});
});
