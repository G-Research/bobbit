import fs from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { test, expect } from "../../../tests/support/harnesses/integration/gateway/in-process-harness.js";
import { MAX_REVIEW_PAYLOAD_REQUEST_BYTES } from "../../../src/server/review-payload-store.js";
import { apiFetch, createSession, deleteSession } from "../../../tests/support/harnesses/integration/gateway/e2e-setup.js";

function reviewBody(markdownByFile: string[], overrides: Record<string, unknown> = {}) {
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
			activeFileId: markdownByFile.length > 7 ? "review-file-7" : "review-file-0",
			replace: true,
			...overrides,
		},
	};
}

async function workspace(sessionId: string): Promise<any> {
	const response = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace`);
	expect(response.status).toBe(200);
	return response.json();
}

async function tombstones(sessionId: string): Promise<any> {
	const response = await apiFetch(`/api/sessions/${sessionId}/review/tombstones`);
	expect(response.status).toBe(200);
	return response.json();
}

function rawChunkedUpload(baseURL: string, token: string, sessionId: string, secret: string) {
	let responseStarted!: () => void;
	const started = new Promise<void>((resolve) => { responseStarted = resolve; });
	let resolveResponse!: (value: { status: number; body: string; complete: boolean }) => void;
	let rejectResponse!: (error: Error) => void;
	const response = new Promise<{ status: number; body: string; complete: boolean }>((resolve, reject) => {
		resolveResponse = resolve;
		rejectResponse = reject;
	});
	const request = http.request(new URL(`/api/sessions/${sessionId}/review-payloads`, baseURL), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"X-Bobbit-Session-Secret": secret,
			"Content-Type": "application/json",
			"Transfer-Encoding": "chunked",
		},
	});
	request.once("socket", responseStarted);
	request.once("response", (incoming) => {
		const chunks: Buffer[] = [];
		incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		incoming.once("end", () => resolveResponse({
			status: incoming.statusCode ?? 0,
			body: Buffer.concat(chunks).toString("utf8"),
			complete: incoming.complete,
		}));
	});
	request.once("error", (error) => {
		// A response-then-close may surface ECONNRESET after the complete 413.
		void response.catch(() => undefined);
		if (!request.destroyed) rejectResponse(error);
	});
	return { request, response, started };
}

async function writeChunk(request: http.ClientRequest, chunk: string | Buffer): Promise<void> {
	await new Promise<void>((resolve, reject) => request.write(chunk, (error) => error ? reject(error) : resolve()));
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
		expect(wrongReference.status).toBe(400);
		expect(await wrongReference.json()).toMatchObject({ ok: false, code: "REVIEW_PAYLOAD_INVALID", retryable: false });
		for (const query of [
			`toolCallId=${encodeURIComponent(receipt.toolCallId)}&reviewId=${encodeURIComponent(receipt.reviewId)}`,
			`toolCallId=${encodeURIComponent(receipt.toolCallId)}&hash=${receipt.hash}`,
			`reviewId=${encodeURIComponent(receipt.reviewId)}&hash=${receipt.hash}`,
		]) {
			const incomplete = await apiFetch(`/api/sessions/${sessionId}/review-payloads/${receipt.payloadId}?${query}`);
			expect(incomplete.status).toBe(400);
			expect(await incomplete.json()).toMatchObject({ ok: false, code: "REVIEW_PAYLOAD_INVALID" });
		}

		const tabId = `review:${encodeURIComponent(receipt.reviewId)}`;
		const selected = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/tabs/${encodeURIComponent(tabId)}`, {
			method: "PATCH",
			body: JSON.stringify({ state: { activeFileId: "review-file-12" } }),
		});
		expect(selected.status).toBe(200);

		const incompleteOpen = await apiFetch(`/api/sessions/${sessionId}/review-payloads/${receipt.payloadId}/open`, {
			method: "POST",
			body: JSON.stringify({ toolCallId: receipt.toolCallId, reviewId: receipt.reviewId, hash: receipt.hash }),
		});
		expect(incompleteOpen.status).toBe(400);
		expect(await incompleteOpen.json()).toMatchObject({ ok: false, code: "REVIEW_PAYLOAD_INVALID" });

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
		expect(workspace.tabs.find((tab: any) => tab.id === `review:${encodeURIComponent(receipt.reviewId)}`).state.activeFileId).toBe("review-file-12");
	});

	test("opens and rehydrates exact multibyte identity maxima while rejecting +1 atomically", async ({ gateway }) => {
		const sessionId = await createSession();
		cleanup.push(sessionId);
		const secret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(sessionId);
		const reviewId = "界".repeat(100);
		const toolCallId = `${"界".repeat(66)}é`;
		const fileId = `${"🙂".repeat(49)}界x`;
		const body = {
			toolCallId,
			review: {
				reviewId,
				title: "Identity limits",
				files: [{ fileId, title: "Exact.md", markdown: "exact body" }],
				activeFileId: fileId,
				replace: false,
			},
		};
		const upload = await apiFetch(`/api/sessions/${sessionId}/review-payloads`, {
			method: "POST",
			headers: { "X-Bobbit-Session-Secret": secret },
			body: JSON.stringify(body),
		});
		expect(upload.status).toBe(201);
		const receipt = await upload.json();
		expect(receipt).toMatchObject({ toolCallId, reviewId, activeFileId: fileId });
		const tabId = `review:${encodeURIComponent(reviewId)}`;
		let authoritative = await workspace(sessionId);
		expect(authoritative.tabs.find((tab: any) => tab.id === tabId)).toMatchObject({
			source: { reviewId, toolCallId },
			state: { activeFileId: fileId },
		});

		const fetched = await apiFetch(
			`/api/sessions/${sessionId}/review-payloads/${receipt.payloadId}?toolCallId=${encodeURIComponent(toolCallId)}&reviewId=${encodeURIComponent(reviewId)}&hash=${receipt.hash}`,
		);
		expect(fetched.status).toBe(200);
		expect(await fetched.json()).toMatchObject({ toolCallId, reviewId, activeFileId: fileId, files: [{ fileId }] });
		const reopened = await apiFetch(`/api/sessions/${sessionId}/review-payloads/${receipt.payloadId}/open`, {
			method: "POST",
			body: JSON.stringify({ toolCallId, payloadId: receipt.payloadId, reviewId, hash: receipt.hash }),
		});
		expect(reopened.status).toBe(200);

		for (const invalid of [
			{ ...body, toolCallId: `${toolCallId}x` },
			{ ...body, review: { ...body.review, reviewId: `${reviewId}x` } },
			{ ...body, review: { ...body.review, files: [{ ...body.review.files[0], fileId: `${fileId}x` }], activeFileId: `${fileId}x` } },
		]) {
			const rejected = await apiFetch(`/api/sessions/${sessionId}/review-payloads`, {
				method: "POST",
				headers: { "X-Bobbit-Session-Secret": secret },
				body: JSON.stringify(invalid),
			});
			expect(rejected.status).toBe(400);
			expect(await rejected.json()).toMatchObject({ code: "REVIEW_PAYLOAD_INVALID", retryable: false });
		}
		authoritative = await workspace(sessionId);
		expect(authoritative.tabs).toHaveLength(1);
		expect(authoritative.tabs[0].id).toBe(tabId);
	});

	test("denies same-project sandbox tokens access to victim review content and open", async ({ gateway }) => {
		const attackerId = await createSession();
		const victimId = await createSession();
		cleanup.push(attackerId, victimId);
		const victimSecret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(victimId);
		const uploaded = await apiFetch(`/api/sessions/${victimId}/review-payloads`, {
			method: "POST",
			headers: { "X-Bobbit-Session-Secret": victimSecret },
			body: JSON.stringify(reviewBody(["victim markdown"])),
		});
		expect(uploaded.status).toBe(201);
		const receipt = await uploaded.json();
		const projectId = String(gateway.sessionManager.getPersistedSession(victimId)?.projectId);
		const sandboxToken = gateway.sessionManager.sandboxTokenStore.register(projectId);
		gateway.sessionManager.sandboxTokenStore.addSession(projectId, attackerId);
		gateway.sessionManager.sandboxTokenStore.addSession(projectId, victimId);
		try {
			const reference = `toolCallId=${encodeURIComponent(receipt.toolCallId)}&reviewId=${encodeURIComponent(receipt.reviewId)}&hash=${receipt.hash}`;
			const read = await fetch(`${gateway.baseURL}/api/sessions/${victimId}/review-payloads/${receipt.payloadId}?${reference}`, {
				headers: { Authorization: `Bearer ${sandboxToken}` },
			});
			expect(read.status).toBe(403);
			expect(await read.text()).not.toContain("victim markdown");
			const open = await fetch(`${gateway.baseURL}/api/sessions/${victimId}/review-payloads/${receipt.payloadId}/open`, {
				method: "POST",
				headers: { Authorization: `Bearer ${sandboxToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ toolCallId: receipt.toolCallId, reviewId: receipt.reviewId, hash: receipt.hash }),
			});
			expect(open.status).toBe(403);
		} finally {
			gateway.sessionManager.sandboxTokenStore.removeSession(projectId, attackerId);
			gateway.sessionManager.sandboxTokenStore.removeSession(projectId, victimId);
		}
	});

	test("preserves an accepted whitespace and >160-byte title through automatic open, reopen, and reload fetch", async ({ gateway }) => {
		const sessionId = await createSession();
		cleanup.push(sessionId);
		const secret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(sessionId);
		const exactTitle = `  ${"é".repeat(150)}${"x".repeat(12)}  `;
		expect(Buffer.byteLength(exactTitle, "utf8")).toBe(316);
		expect(exactTitle.length).toBeGreaterThan(160);

		const uploaded = await apiFetch(`/api/sessions/${sessionId}/review-payloads`, {
			method: "POST",
			headers: { "X-Bobbit-Session-Secret": secret },
			body: JSON.stringify(reviewBody(["reload body"], { title: exactTitle })),
		});
		expect(uploaded.status).toBe(201);
		const receipt = await uploaded.json();
		expect(receipt.title).toBe(exactTitle);
		expect(receipt.automaticOpen).toMatchObject({ ok: true, status: "opened" });

		let authoritative = await workspace(sessionId);
		let tab = authoritative.tabs.find((candidate: any) => candidate.id === `review:${encodeURIComponent(receipt.reviewId)}`);
		expect(tab.source.title).toBe(exactTitle);
		expect(tab.title.length).toBeLessThanOrEqual(160);

		const fetched = await apiFetch(
			`/api/sessions/${sessionId}/review-payloads/${receipt.payloadId}?toolCallId=${encodeURIComponent(receipt.toolCallId)}&reviewId=${encodeURIComponent(receipt.reviewId)}&hash=${receipt.hash}`,
		);
		expect(fetched.status).toBe(200);
		expect((await fetched.json()).title).toBe(exactTitle);

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
		authoritative = await workspace(sessionId);
		tab = authoritative.tabs.find((candidate: any) => candidate.id === `review:${encodeURIComponent(receipt.reviewId)}`);
		expect(tab.source.title).toBe(exactTitle);
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

	test("returns a prompt structured 413 and closes a chunked cap+1 upload before end", async ({ gateway }) => {
		const sessionId = await createSession();
		cleanup.push(sessionId);
		const secret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(sessionId);
		const raw = rawChunkedUpload(gateway.baseURL, gateway.token, sessionId, secret);
		await raw.started;
		const chunk = Buffer.alloc(1024 * 1024, 0x78);
		let remaining = MAX_REVIEW_PAYLOAD_REQUEST_BYTES + 1;
		while (remaining > 0) {
			const size = Math.min(chunk.byteLength, remaining);
			await writeChunk(raw.request, size === chunk.byteLength ? chunk : chunk.subarray(0, size));
			remaining -= size;
		}
		// Deliberately do not call end(): overflow itself must settle the handler.
		const result = await Promise.race([
			raw.response,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("chunked overflow did not settle promptly")), 5_000)),
		]);
		expect(result.status).toBe(413);
		expect(JSON.parse(result.body)).toMatchObject({ code: "REVIEW_PAYLOAD_TOO_LARGE", retryable: false });
		expect(result.complete).toBe(true);
		await new Promise<void>((resolveClose) => raw.request.once("close", resolveClose));
		expect(raw.request.destroyed).toBe(true);
		expect(fs.existsSync(join(gateway.bobbitDir, "state", "review-payloads", sessionId))).toBe(false);
	});

	test("replace:true carries the current valid workspace selection through reconciliation", async ({ gateway }) => {
		const sessionId = await createSession();
		cleanup.push(sessionId);
		const secret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(sessionId);
		const upload = async (review: Record<string, unknown>) => {
			const response = await apiFetch(`/api/sessions/${sessionId}/review-payloads`, {
				method: "POST",
				headers: { "X-Bobbit-Session-Secret": secret },
				body: JSON.stringify(reviewBody(["unused"], review)),
			});
			expect(response.status).toBe(201);
			return response.json();
		};
		const first = await upload({
			title: "Selection replacement",
			files: [
				{ fileId: "old-a", title: "a.md", markdown: "a1" },
				{ fileId: "old-b", title: "b.md", markdown: "b1" },
				{ fileId: "old-c", title: "c.md", markdown: "c1" },
			],
			activeFileId: "old-a",
			replace: true,
		});
		const tabId = `review:${encodeURIComponent(first.reviewId)}`;
		const selected = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/tabs/${encodeURIComponent(tabId)}`, {
			method: "PATCH",
			body: JSON.stringify({ state: { activeFileId: "old-b" } }),
		});
		expect(selected.status).toBe(200);
		const replacement = await upload({
			reviewId: "incoming-replacement-id",
			title: "Selection replacement",
			files: [
				{ fileId: "new-c", title: "c.md", markdown: "c2" },
				{ fileId: "new-a", title: "a.md", markdown: "a2" },
				{ fileId: "new-b", title: "b.md", markdown: "b2" },
			],
			activeFileId: "new-c",
			replace: true,
		});
		expect(replacement.reviewId).toBe(first.reviewId);
		expect(replacement.activeFileId).toBe("old-b");
		const after = await workspace(sessionId);
		expect(after.tabs.find((tab: any) => tab.id === tabId)?.state.activeFileId).toBe("old-b");
	});

	test("serializes concurrent replace:true identity resolution and preserves replace:false controls", async ({ gateway }) => {
		const sessionId = await createSession();
		cleanup.push(sessionId);
		const secret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(sessionId);
		await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/open`, {
			method: "POST",
			body: JSON.stringify({
				tab: {
					id: "proposal:goal",
					kind: "proposal",
					title: "Goal Proposal",
					label: "Goal",
					source: { type: "proposal", sessionId, proposalType: "goal" },
					updatedAt: 1,
				},
			}),
		});
		const uploads = Array.from({ length: 8 }, (_, index) => apiFetch(`/api/sessions/${sessionId}/review-payloads`, {
			method: "POST",
			headers: { "X-Bobbit-Session-Secret": secret },
			body: JSON.stringify(reviewBody([`replace ${index}`], {
				reviewId: `replace-review-${index}`,
				title: "Concurrent replacement",
				files: [{ fileId: `replace-file-${index}`, title: "same.md", markdown: `replace ${index}` }],
				activeFileId: `replace-file-${index}`,
				replace: true,
			})),
		}));
		const responses = await Promise.all(uploads);
		expect(responses.every((response) => response.status === 201)).toBe(true);
		const receipts = await Promise.all(responses.map((response) => response.json()));
		expect(new Set(receipts.map((receipt) => receipt.reviewId)).size).toBe(1);
		expect(new Set(receipts.map((receipt) => receipt.files[0].fileId)).size).toBe(1);
		expect(receipts.every((receipt) => receipt.activeFileId === receipts[0].files[0].fileId)).toBe(true);
		const afterReplace = await workspace(sessionId);
		expect(afterReplace.tabs.map((tab: any) => tab.id)).toEqual([
			"proposal:goal",
			`review:${encodeURIComponent(receipts[0].reviewId)}`,
		]);

		const controls = await Promise.all(["control-a", "control-b"].map((reviewId) => apiFetch(`/api/sessions/${sessionId}/review-payloads`, {
			method: "POST",
			headers: { "X-Bobbit-Session-Secret": secret },
			body: JSON.stringify(reviewBody([reviewId], {
				reviewId,
				title: "Concurrent distinct",
				files: [{ fileId: `${reviewId}-file`, title: "same.md", markdown: reviewId }],
				activeFileId: `${reviewId}-file`,
				replace: false,
			})),
		})));
		expect(controls.every((response) => response.status === 201)).toBe(true);
		const afterControls = await workspace(sessionId);
		expect(afterControls.tabs.filter((tab: any) => tab.source?.title === "Concurrent distinct").map((tab: any) => tab.source.reviewId).sort())
			.toEqual(["control-a", "control-b"]);
		expect(afterControls.tabs[0].id).toBe("proposal:goal");
	});

	test("admits concurrent uploads within quota and rejects the first excess without temp artifacts", async ({ gateway }) => {
		const sessionId = await createSession();
		cleanup.push(sessionId);
		const secret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(sessionId);
		const responses = await Promise.all(Array.from({ length: 65 }, (_, index) => apiFetch(`/api/sessions/${sessionId}/review-payloads`, {
			method: "POST",
			headers: { "X-Bobbit-Session-Secret": secret },
			body: JSON.stringify(reviewBody([`quota ${index}`], {
				reviewId: `quota-review-${index}`,
				title: `Quota review ${index}`,
				files: [{ fileId: `quota-file-${index}`, title: "quota.md", markdown: `quota ${index}` }],
				activeFileId: `quota-file-${index}`,
				replace: false,
			})),
		})));
		expect(responses.filter((response) => response.status === 201)).toHaveLength(64);
		const rejected = responses.find((response) => response.status !== 201);
		expect(rejected?.status).toBe(507);
		expect(await rejected!.json()).toMatchObject({ code: "REVIEW_PAYLOAD_QUOTA_EXCEEDED", retryable: false });
		const entries = fs.readdirSync(join(gateway.bobbitDir, "state", "review-payloads", sessionId));
		expect(entries).toHaveLength(64);
		expect(entries.some((entry) => entry.startsWith(".tmp-"))).toBe(false);
	});

	test("a stalled upload cannot recreate artifacts after the permanent session purge fence", async ({ gateway }) => {
		const sessionId = await createSession();
		const secret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(sessionId);
		const serialized = JSON.stringify(reviewBody(["stalled upload"]));
		const raw = rawChunkedUpload(gateway.baseURL, gateway.token, sessionId, secret);
		await raw.started;
		await writeChunk(raw.request, serialized.slice(0, 20));
		const purged = await apiFetch(`/api/sessions/${sessionId}?purge=true`, { method: "DELETE" });
		expect(purged.status).toBe(200);
		await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
		raw.request.end(serialized.slice(20));
		const result = await raw.response;
		expect(result.status).toBe(404);
		expect(JSON.parse(result.body)).toMatchObject({ code: "REVIEW_PAYLOAD_SESSION_UNAVAILABLE" });
		const payloadOwnerDir = join(gateway.bobbitDir, "state", "review-payloads", sessionId);
		for (let attempt = 0; attempt < 100 && fs.existsSync(payloadOwnerDir); attempt++) {
			await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
		}
		expect(fs.existsSync(payloadOwnerDir)).toBe(false);
	});

	test("opens and retries without annotation writes while exact and sibling tombstones remain durable", async ({ gateway }) => {
		const sessionId = await createSession();
		cleanup.push(sessionId);
		const secret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(sessionId);
		const annotationPath = join(gateway.bobbitDir, "state", `review-annotations-${sessionId}.json`);
		await apiFetch(`/api/sessions/${sessionId}/review/tombstones/review-api-id`, {
			method: "PUT",
			body: JSON.stringify({ state: "closed", activeFileId: "review-file-0" }),
		});
		await apiFetch(`/api/sessions/${sessionId}/review/tombstones/sibling-review`, {
			method: "PUT",
			body: JSON.stringify({ state: "submitted", activeFileId: "sibling-file" }),
		});
		const annotationsBefore = fs.readFileSync(annotationPath, "utf8");

		const originalWrite = fs.writeFileSync;
		try {
			fs.writeFileSync = ((path: fs.PathOrFileDescriptor, ...args: any[]) => {
				if (String(path) === annotationPath) throw new Error("injected annotation write failure");
				return (originalWrite as any)(path, ...args);
			}) as typeof fs.writeFileSync;
			const uploaded = await apiFetch(`/api/sessions/${sessionId}/review-payloads`, {
				method: "POST",
				headers: { "X-Bobbit-Session-Secret": secret },
				body: JSON.stringify(reviewBody(["write-free open"])),
			});
			expect(uploaded.status).toBe(201);
			const receipt = await uploaded.json();
			expect(receipt.automaticOpen).toMatchObject({ ok: true, status: "opened" });
			expect((await workspace(sessionId)).tabs).toHaveLength(1);
			expect(fs.readFileSync(annotationPath, "utf8")).toBe(annotationsBefore);
			expect(await tombstones(sessionId)).toMatchObject({
				closedReviewIds: ["review-api-id"],
				submittedReviewIds: ["sibling-review"],
			});
			const retry = await apiFetch(`/api/sessions/${sessionId}/review-payloads/${receipt.payloadId}/open`, {
				method: "POST",
				body: JSON.stringify({ toolCallId: receipt.toolCallId, payloadId: receipt.payloadId, reviewId: receipt.reviewId, hash: receipt.hash }),
			});
			expect(retry.status).toBe(200);
			expect((await workspace(sessionId)).tabs).toHaveLength(1);
			expect(fs.readFileSync(annotationPath, "utf8")).toBe(annotationsBefore);
		} finally {
			fs.writeFileSync = originalWrite;
		}
	});

	test("workspace failure leaves tombstones byte-identical even when annotation writes are unavailable", async ({ gateway }) => {
		const sessionId = await createSession();
		cleanup.push(sessionId);
		const secret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(sessionId);
		const context = gateway.projectContextManager.all().find((candidate: any) => candidate.sessionStore.get(sessionId));
		expect(context).toBeTruthy();
		const store = context.sessionStore;
		const originalUpdate = store.update.bind(store);
		const annotationPath = join(gateway.bobbitDir, "state", `review-annotations-${sessionId}.json`);
		await apiFetch(`/api/sessions/${sessionId}/review/tombstones/review-api-id`, {
			method: "PUT",
			body: JSON.stringify({ state: "closed", activeFileId: "review-file-0" }),
		});
		await apiFetch(`/api/sessions/${sessionId}/review/tombstones/sibling-review`, {
			method: "PUT",
			body: JSON.stringify({ state: "submitted", activeFileId: "sibling-file" }),
		});
		const annotationsBefore = fs.readFileSync(annotationPath, "utf8");
		store.update = (id: string, patch: any) => {
			if (id === sessionId && patch?.sidePanelWorkspace) throw new Error("injected workspace failure");
			return originalUpdate(id, patch);
		};
		try {
			const workspaceFailed = await apiFetch(`/api/sessions/${sessionId}/review-payloads`, {
				method: "POST",
				headers: { "X-Bobbit-Session-Secret": secret },
				body: JSON.stringify(reviewBody(["workspace failure"])),
			});
			const firstReceipt = await workspaceFailed.json();
			expect(firstReceipt.automaticOpen).toMatchObject({ ok: false, retryable: true });
			expect(gateway.sessionManager.getPersistedSession(sessionId).sidePanelWorkspace?.tabs ?? []).toEqual([]);
			expect(fs.readFileSync(annotationPath, "utf8")).toBe(annotationsBefore);
			expect(await tombstones(sessionId)).toMatchObject({
				closedReviewIds: ["review-api-id"],
				submittedReviewIds: ["sibling-review"],
			});

			const originalWrite = fs.writeFileSync;
			let annotationWrites = 0;
			try {
				fs.writeFileSync = ((path: fs.PathOrFileDescriptor, ...args: any[]) => {
					if (String(path) === annotationPath) {
						annotationWrites += 1;
						throw new Error("injected annotation write failure");
					}
					return (originalWrite as any)(path, ...args);
				}) as typeof fs.writeFileSync;
				const openFailed = await apiFetch(`/api/sessions/${sessionId}/review-payloads/${firstReceipt.payloadId}/open`, {
					method: "POST",
					body: JSON.stringify({ toolCallId: firstReceipt.toolCallId, payloadId: firstReceipt.payloadId, reviewId: firstReceipt.reviewId, hash: firstReceipt.hash }),
				});
				expect(openFailed.status).toBe(500);
				expect(await openFailed.json()).toMatchObject({ code: "REVIEW_PAYLOAD_INTERNAL_ERROR", retryable: true });
				expect(annotationWrites).toBe(0);
				expect(gateway.sessionManager.getPersistedSession(sessionId).sidePanelWorkspace?.tabs ?? []).toEqual([]);
				expect(fs.readFileSync(annotationPath, "utf8")).toBe(annotationsBefore);
			} finally {
				fs.writeFileSync = originalWrite;
			}
			store.update = originalUpdate;
			const retry = await apiFetch(`/api/sessions/${sessionId}/review-payloads/${firstReceipt.payloadId}/open`, {
				method: "POST",
				body: JSON.stringify({ toolCallId: firstReceipt.toolCallId, payloadId: firstReceipt.payloadId, reviewId: firstReceipt.reviewId, hash: firstReceipt.hash }),
			});
			expect(retry.status).toBe(200);
			const durableWorkspace = await workspace(sessionId);
			expect(durableWorkspace.tabs).toHaveLength(1);
			expect(durableWorkspace.tabs[0]).toMatchObject({
				id: "review:review-api-id",
				state: { activeFileId: "review-file-0" },
			});
			expect(fs.readFileSync(annotationPath, "utf8")).toBe(annotationsBefore);
			expect(await tombstones(sessionId)).toMatchObject({
				closedReviewIds: ["review-api-id"],
				submittedReviewIds: ["sibling-review"],
			});
		} finally {
			store.update = originalUpdate;
		}
	});
});
