import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, createSession, deleteSession } from "./_e2e/e2e-setup.js";

function reviewBody(markdownByFile: string[]) {
	return {
		toolCallId: "review-tool-call-api",
		review: {
			reviewId: "review-api-id",
			title: "Large API review",
			files: markdownByFile.map((markdown, index) => ({
				fileId: `review-file-${index}`,
				title: `File ${index + 1}`,
				markdown,
			})),
			activeFileId: "review-file-7",
			replace: true,
		},
	};
}

test.describe("review payload API hardening", () => {
	const cleanup: string[] = [];

	test.afterEach(async () => {
		while (cleanup.length) await deleteSession(cleanup.pop()!);
	});

	test("stores, fetches, and reopens a session-bound 20-file payload above 32 KiB", async ({ gateway }) => {
		const sessionId = await createSession();
		cleanup.push(sessionId);
		const secret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(sessionId);
		const files = Array.from({ length: 20 }, (_, index) => `# File ${index + 1}\n${"x".repeat(24_300)}`);
		const response = await apiFetch(`/api/sessions/${sessionId}/review-payloads`, {
			method: "POST",
			headers: { "X-Bobbit-Session-Secret": secret },
			body: JSON.stringify(reviewBody(files)),
		});
		expect(response.status).toBe(201);
		const receipt = await response.json();
		expect(receipt).toMatchObject({
			action: "review_open",
			version: 2,
			toolCallId: "review-tool-call-api",
			reviewId: "review-api-id",
			activeFileId: "review-file-7",
			totalBytes: files.reduce((sum, markdown) => sum + Buffer.byteLength(markdown), 0),
			automaticOpen: { ok: true, status: "opened" },
		});
		expect(Buffer.byteLength(JSON.stringify(receipt), "utf8")).toBeLessThan(32 * 1024);
		expect(JSON.stringify(receipt)).not.toContain(files[0].slice(0, 100));

		const fetchedResponse = await apiFetch(
			`/api/sessions/${sessionId}/review-payloads/${receipt.payloadId}?toolCallId=${encodeURIComponent(receipt.toolCallId)}&reviewId=${encodeURIComponent(receipt.reviewId)}&hash=${receipt.hash}`,
		);
		expect(fetchedResponse.status).toBe(200);
		const fetched = await fetchedResponse.json();
		expect(fetched.files.map((file: any) => file.fileId)).toEqual(receipt.files.map((file: any) => file.fileId));
		expect(fetched.files.map((file: any) => file.markdown)).toEqual(files);

		const wrongReference = await apiFetch(
			`/api/sessions/${sessionId}/review-payloads/${receipt.payloadId}?toolCallId=wrong`,
		);
		expect(wrongReference.status).toBe(409);
		expect(await wrongReference.json()).toMatchObject({ ok: false, code: "REVIEW_PAYLOAD_REFERENCE_MISMATCH", retryable: false });

		const reopened = await apiFetch(`/api/sessions/${sessionId}/review-payloads/${receipt.payloadId}/open`, {
			method: "POST",
			body: JSON.stringify({
				toolCallId: receipt.toolCallId,
				payloadId: receipt.payloadId,
				reviewId: receipt.reviewId,
				hash: receipt.hash,
			}),
		});
		expect(reopened.status).toBe(200);
		expect(await reopened.json()).toMatchObject({ ok: true, status: "opened", reviewId: receipt.reviewId });

		const workspace = await (await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace`)).json();
		expect(workspace.tabs.map((tab: any) => tab.id)).toContain(`review:${encodeURIComponent(receipt.reviewId)}`);
		expect(workspace.tabs.find((tab: any) => tab.id === `review:${encodeURIComponent(receipt.reviewId)}`).state.activeFileId).toBe("review-file-7");
	});

	test("requires the owning session secret for upload and rejects 10 MiB plus one byte", async ({ gateway }) => {
		const sessionId = await createSession();
		cleanup.push(sessionId);
		const body = reviewBody(["x"]);
		const forbidden = await apiFetch(`/api/sessions/${sessionId}/review-payloads`, {
			method: "POST",
			body: JSON.stringify(body),
		});
		expect(forbidden.status).toBe(403);
		expect(await forbidden.json()).toMatchObject({ code: "REVIEW_PAYLOAD_UPLOAD_FORBIDDEN" });

		const secret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(sessionId);
		const oversized = reviewBody(["x".repeat(10 * 1024 * 1024 + 1)]);
		const rejected = await apiFetch(`/api/sessions/${sessionId}/review-payloads`, {
			method: "POST",
			headers: { "X-Bobbit-Session-Secret": secret },
			body: JSON.stringify(oversized),
		});
		expect(rejected.status).toBe(413);
		expect(await rejected.json()).toMatchObject({ code: "REVIEW_PAYLOAD_TOO_LARGE" });
	});
});
