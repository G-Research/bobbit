/**
 * E2E: GET /api/sessions/:id/transcript
 *
 * Backs the `read_session` tool. Tests the HTTP surface end-to-end:
 *   - happy path (slice, tail, pattern+window)
 *   - error mapping (session_not_found, transcript_unavailable, invalid_regex,
 *     invalid_params)
 *   - cross-project transcript access via x-bobbit-session-id header
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import { readE2EToken, base } from "./_e2e/e2e-setup.js";
import { vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

let token: string;
test.beforeAll(() => { token = readE2EToken(); });

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extra };
}

/** Build a sample JSONL with N message lines. */
function makeJsonl(messages: Array<{ role: string; content: any; ts?: string }>): string {
	return messages
		.map((m) => JSON.stringify({ type: "message", ts: m.ts, message: { role: m.role, content: m.content } }))
		.join("\n") + "\n";
}

function makePiJsonl(messages: Array<Record<string, unknown>>): string {
	return messages
		.map((message) => JSON.stringify({ type: "message", message }))
		.join("\n") + "\n";
}

/** Inject a fully-formed PersistedSession into a project's store with a real .jsonl on disk. */
function seedSession(
	gw: { sessionManager: any; bobbitDir: string },
	overrides: Record<string, unknown> = {},
	jsonl?: string,
): { id: string; agentSessionFile: string; projectId: string } {
	const sm = gw.sessionManager;
	const pcm = sm.getProjectContextManager?.() ?? sm.projectContextManager;
	const reg = pcm?.registry ?? pcm?.projectRegistry ?? sm.projectRegistry;
	const defaultProjectId: string =
		(pcm?.getDefaultProjectId?.() as string | undefined) ??
		(reg?.list?.()?.[0]?.id as string);
	expect(defaultProjectId).toBeTruthy();

	const id = crypto.randomUUID();
	const agentSessionFile = path.join(gw.bobbitDir, "state", `${id}.jsonl`);
	fs.writeFileSync(agentSessionFile, jsonl ?? "");

	const projectId = (overrides.projectId as string | undefined) ?? defaultProjectId;
	const ps = {
		id,
		title: "transcript-api test",
		cwd: gw.bobbitDir,
		agentSessionFile,
		createdAt: Date.now(),
		lastActivity: Date.now(),
		...overrides,
		projectId,
	};
	const store = sm.getSessionStore(projectId);
	store.put(ps);
	return { id, agentSessionFile, projectId };
}

test.describe("GET /api/sessions/:id/transcript", () => {
	test("happy path — head", async ({ gateway }) => {
		const jsonl = makeJsonl([
			{ role: "user", content: "alpha" },
			{ role: "assistant", content: [{ type: "text", text: "beta" }] },
			{ role: "user", content: "gamma" },
		]);
		const { id } = seedSession(gateway, {}, jsonl);
		const resp = await fetch(`${base()}/api/sessions/${id}/transcript?offset=0&limit=10`, { headers: authHeaders() });
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.total).toBe(3);
		expect(body.returned).toBe(3);
		expect(body.offsetStart).toBe(0);
		expect(body.offsetEnd).toBe(2);
		expect(body.messages[0].role).toBe("user");
		expect(body.messages[0].text).toBe("alpha");
	});

	test("negative offset returns tail", async ({ gateway }) => {
		const jsonl = makeJsonl([
			{ role: "user", content: "1" },
			{ role: "user", content: "2" },
			{ role: "user", content: "3" },
			{ role: "user", content: "4" },
			{ role: "user", content: "5" },
		]);
		const { id } = seedSession(gateway, {}, jsonl);
		const resp = await fetch(`${base()}/api/sessions/${id}/transcript?offset=-2&limit=2`, { headers: authHeaders() });
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.returned).toBe(2);
		expect(body.offsetStart).toBe(3);
		expect(body.offsetEnd).toBe(4);
	});

	test("out-of-range returns empty + total", async ({ gateway }) => {
		const jsonl = makeJsonl([{ role: "user", content: "x" }]);
		const { id } = seedSession(gateway, {}, jsonl);
		const resp = await fetch(`${base()}/api/sessions/${id}/transcript?offset=100&limit=5`, { headers: authHeaders() });
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.total).toBe(1);
		expect(body.returned).toBe(0);
		expect(body.offsetStart).toBe(-1);
		expect(body.messages).toEqual([]);
	});

	test("pattern + window composes correctly", async ({ gateway }) => {
		const jsonl = makeJsonl([
			{ role: "user", content: "no match" },
			{ role: "assistant", content: [{ type: "text", text: "first error" }] },
			{ role: "user", content: "still nothing" },
			{ role: "assistant", content: [{ type: "text", text: "second ERROR here" }] },
			{ role: "user", content: "third error in user" },
		]);
		const { id } = seedSession(gateway, {}, jsonl);
		const resp = await fetch(`${base()}/api/sessions/${id}/transcript?pattern=error&offset=-1&limit=1`, { headers: authHeaders() });
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.matchCount).toBe(3);
		expect(body.returned).toBe(1);
		expect(body.messages[0].index).toBe(4);
	});

	test("verbose returns raw content blocks", async ({ gateway }) => {
		const jsonl = makeJsonl([
			{ role: "assistant", content: [{ type: "text", text: "hello" }, { type: "tool_use", name: "bash", input: { cmd: "ls" } }] },
		]);
		const { id } = seedSession(gateway, {}, jsonl);
		const resp = await fetch(`${base()}/api/sessions/${id}/transcript?verbose=1`, { headers: authHeaders() });
		expect(resp.status).toBe(200);
		const body = await resp.json();
		const m = body.messages[0];
		expect(Array.isArray(m.content)).toBe(true);
		expect(m.content[0].type).toBe("text");
		expect(m.content[1].type).toBe("tool_use");
	});

	test("include_tool_results query controls redaction while omitted preserves API compatibility", async ({ gateway }) => {
		const secret = "E2E_UNIQUE_TOOL_RESULT_BODY";
		const jsonl = makeJsonl([
			{ role: "assistant", content: [{ type: "tool_use", id: "tu-e2e", name: "bash", input: { cmd: "echo secret" } }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "tu-e2e", content: secret }] },
		]);
		const { id } = seedSession(gateway, {}, jsonl);

		const defaultResp = await fetch(`${base()}/api/sessions/${id}/transcript?offset=1&limit=1`, { headers: authHeaders() });
		expect(defaultResp.status).toBe(200);
		const defaultBody = await defaultResp.json();
		expect(defaultBody.messages[0].toolResults[0].preview).toBe(secret);

		const redactedResp = await fetch(`${base()}/api/sessions/${id}/transcript?offset=1&limit=1&include_tool_results=false`, { headers: authHeaders() });
		expect(redactedResp.status).toBe(200);
		const redactedBody = await redactedResp.json();
		expect(JSON.stringify(redactedBody)).not.toContain(secret);
		expect(redactedBody.messages[0].toolResults[0].omitted).toBe(true);
		expect(redactedBody.messages[0].toolResults[0].name).toBe("bash");
		expect(redactedBody.messages[0].toolResults[0].size.lines).toBe(1);

		const optInResp = await fetch(`${base()}/api/sessions/${id}/transcript?offset=1&limit=1&includeToolResults=true`, { headers: authHeaders() });
		expect(optInResp.status).toBe(200);
		const optInBody = await optInResp.json();
		expect(optInBody.messages[0].toolResults[0].preview).toBe(secret);
	});

	test("session_not_found", async () => {
		const resp = await fetch(`${base()}/api/sessions/does-not-exist/transcript`, { headers: authHeaders() });
		expect(resp.status).toBe(404);
		expect((await resp.json()).error).toBe("session_not_found");
	});

	test("transcript_unavailable when file empty", async ({ gateway }) => {
		const { id } = seedSession(gateway, {}, "");
		const resp = await fetch(`${base()}/api/sessions/${id}/transcript`, { headers: authHeaders() });
		expect(resp.status).toBe(404);
		expect((await resp.json()).error).toBe("transcript_unavailable");
	});

	test("invalid_regex", async ({ gateway }) => {
		const jsonl = makeJsonl([{ role: "user", content: "x" }]);
		const { id } = seedSession(gateway, {}, jsonl);
		const resp = await fetch(`${base()}/api/sessions/${id}/transcript?pattern=%28`, { headers: authHeaders() });
		expect(resp.status).toBe(400);
		expect((await resp.json()).error).toBe("invalid_regex");
	});

	test("invalid_params (limit out of range)", async ({ gateway }) => {
		const jsonl = makeJsonl([{ role: "user", content: "x" }]);
		const { id } = seedSession(gateway, {}, jsonl);
		const resp = await fetch(`${base()}/api/sessions/${id}/transcript?limit=999`, { headers: authHeaders() });
		expect(resp.status).toBe(400);
		expect((await resp.json()).error).toBe("invalid_params");
	});

	test("valid caller identity selects bounded agent projection while direct and stale callers keep legacy REST", async ({ gateway }) => {
		const resultBody = "prefix\nPI_RESULT_SEARCH_SENTINEL\nsuffix";
		const providerMessageSentinel = "PROVIDER_MESSAGE_SIGNATURE_SENTINEL";
		const providerBlockSentinel = "PROVIDER_BLOCK_SIGNATURE_SENTINEL";
		const jsonl = makePiJsonl([
			{
				role: "assistant",
				thinkingSignature: { encrypted_content: providerMessageSentinel },
				content: [
					{
						type: "thinking",
						thinking: "brief useful reasoning",
						thinkingSignature: { encrypted_content: providerMessageSentinel },
					},
					{
						type: "toolCall",
						id: "pi-call-route",
						name: "read",
						arguments: { path: "src/server/server.ts", query: "route projection" },
						textSignature: { encryptedContent: providerBlockSentinel },
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: "pi-call-route",
				name: "read",
				toolName: "duplicate-read-alias",
				status: "ok",
				isError: true,
				thinkingSignature: { encrypted_content: providerMessageSentinel },
				content: [{ type: "text", text: resultBody }],
			},
		]);
		const { id: targetId } = seedSession(gateway, {}, jsonl);
		const { id: callerId } = seedSession(gateway, {}, "");

		const directHeaderSets: Array<Record<string, string>> = [
			{},
			{ "x-bobbit-session-id": crypto.randomUUID() },
		];
		for (const extraHeaders of directHeaderSets) {
			const response = await fetch(`${base()}/api/sessions/${targetId}/transcript?verbose=1`, {
				headers: authHeaders(extraHeaders),
			});
			expect(response.status).toBe(200);
			const serialized = JSON.stringify(await response.json());
			expect(serialized).toContain("PI_RESULT_SEARCH_SENTINEL");
			expect(serialized).toContain(providerMessageSentinel);
			expect(serialized).toContain(providerBlockSentinel);
		}

		const agentResponse = await fetch(`${base()}/api/sessions/${targetId}/transcript?verbose=1&limit=10`, {
			headers: authHeaders({ "x-bobbit-session-id": callerId }),
		});
		expect(agentResponse.status).toBe(200);
		const agentBody = await agentResponse.json();
		const serializedAgent = JSON.stringify(agentBody);
		expect(serializedAgent).not.toContain("PI_RESULT_SEARCH_SENTINEL");
		expect(serializedAgent).not.toContain(providerMessageSentinel);
		expect(serializedAgent).not.toContain(providerBlockSentinel);
		expect(agentBody.messages[0].toolCalls[0]).toMatchObject({ name: "read" });
		expect(agentBody.messages[0].toolCalls[0].argumentsPreview).toContain("src/server/server.ts");
		const result = agentBody.messages[1].toolResults[0];
		expect(result).toMatchObject({ name: "read", status: "ok", omitted: true });
		expect(result.toolName).toBeUndefined();
		expect(result.isError).toBeUndefined();
		expect(result.size).toMatchObject({ chars: resultBody.length, lines: 3, bytes: Buffer.byteLength(resultBody) });
	});

	test("agent projection searches omitted Pi results and continues bounded result slices", async ({ gateway }) => {
		const resultBody = "A😀é\r\nZ-PI_ROUTE_RESULT_SENTINEL-tail";
		const jsonl = makePiJsonl([
			{ role: "assistant", content: [{ type: "toolCall", id: "pi-slice", name: "bash", arguments: { command: "probe" } }] },
			{ role: "toolResult", toolCallId: "pi-slice", toolName: "bash", isError: false, content: [{ type: "text", text: resultBody }] },
		]);
		const { id: targetId } = seedSession(gateway, {}, jsonl);
		const { id: callerId } = seedSession(gateway, {}, "");
		const headers = authHeaders({ "x-bobbit-session-id": callerId });

		const searchUrl = new URL(`${base()}/api/sessions/${targetId}/transcript`);
		searchUrl.searchParams.set("pattern", "PI_ROUTE_RESULT_SENTINEL");
		searchUrl.searchParams.set("offset", "-1");
		searchUrl.searchParams.set("limit", "1");
		const searchResponse = await fetch(searchUrl, { headers });
		expect(searchResponse.status).toBe(200);
		const searchBody = await searchResponse.json();
		expect(searchBody.matchCount).toBe(1);
		expect(searchBody.messages[0].index).toBe(1);
		expect(JSON.stringify(searchBody)).not.toContain("PI_ROUTE_RESULT_SENTINEL");
		const handle = searchBody.messages[0].toolResults[0].handle as string;
		expect(handle).toMatch(/^rs1:m1:b0:/);

		const readSlice = async (cursor: number, limit: number) => {
			const sliceUrl = new URL(`${base()}/api/sessions/${targetId}/transcript`);
			sliceUrl.searchParams.set("result_handle", handle);
			sliceUrl.searchParams.set("result_cursor", String(cursor));
			sliceUrl.searchParams.set("result_limit", String(limit));
			const response = await fetch(sliceUrl, { headers });
			expect(response.status).toBe(200);
			return response.json();
		};
		const first = await readSlice(0, 5);
		const firstExcerpt = first.messages[0].toolResults[0].excerpt;
		expect(firstExcerpt).toMatchObject({ start: 0, end: 5, complete: false, nextCursor: 5 });
		const second = await readSlice(firstExcerpt.nextCursor, 8192);
		const secondExcerpt = second.messages[0].toolResults[0].excerpt;
		expect(firstExcerpt.text + secondExcerpt.text).toBe(resultBody);
		expect(secondExcerpt).toMatchObject({ start: 5, end: resultBody.length, complete: true, nextCursor: null });
	});

	test("agent heavy reads require an explicit integer limit before transcript I/O", async ({ gateway }) => {
		const { id: targetId, agentSessionFile } = seedSession(gateway, {}, makeJsonl([{ role: "user", content: "heavy guard" }]));
		const { id: callerId } = seedSession(gateway, {}, "");
		const headers = authHeaders({ "x-bobbit-session-id": callerId });
		const readSpy = vi.spyOn(fs, "readFileSync");
		try {
			const flagSets = [
				{ verbose: "true" },
				{ include_tool_results: "true" },
				{ includeToolResults: "true" },
				{ verbose: "true", include_tool_results: "true" },
			];
			const invalidLimits: Array<string | undefined> = [
				undefined, "null", "\"10\"", "ten", "1.5", "0", "-1", "NaN", "Infinity", "-Infinity", "11", "999",
			];
			for (const flags of flagSets) {
				for (const invalidLimit of invalidLimits) {
					const requestUrl = new URL(`${base()}/api/sessions/${targetId}/transcript`);
					for (const [name, value] of Object.entries(flags)) requestUrl.searchParams.set(name, value);
					if (invalidLimit !== undefined) requestUrl.searchParams.set("limit", invalidLimit);
					const response = await fetch(requestUrl, { headers });
					expect(response.status, `${JSON.stringify(flags)} limit=${String(invalidLimit)}`).toBe(400);
					const error = await response.json();
					expect(error.code).toBe("CONTEXT_HEAVY_LIMIT_REQUIRED");
				}
			}
			const targetReads = () => readSpy.mock.calls.filter(([file]) => path.resolve(String(file)) === path.resolve(agentSessionFile)).length;
			expect(targetReads()).toBe(0);

			for (const limit of [1, 10]) {
				const response = await fetch(`${base()}/api/sessions/${targetId}/transcript?verbose=true&include_tool_results=true&limit=${limit}`, { headers });
				expect(response.status).toBe(200);
			}
			expect(targetReads()).toBe(2);

			const direct = await fetch(`${base()}/api/sessions/${targetId}/transcript?verbose=true&include_tool_results=true`, { headers: authHeaders() });
			expect(direct.status).toBe(200);
			expect(targetReads()).toBe(3);
		} finally {
			readSpy.mockRestore();
		}
	});

	test("agent transcript response stays within the 50 KiB serialized budget", async ({ gateway }) => {
		const oversizedResult = "quote:\" slash:\\\n emoji:😀 β ".repeat(8_000);
		const jsonl = makePiJsonl([
			{ role: "assistant", content: [{ type: "toolCall", id: "pi-budget", name: "bash", arguments: { command: "large" } }] },
			{ role: "toolResult", toolCallId: "pi-budget", toolName: "bash", isError: false, content: [{ type: "text", text: oversizedResult }] },
		]);
		const { id: targetId } = seedSession(gateway, {}, jsonl);
		const { id: callerId } = seedSession(gateway, {}, "");
		const response = await fetch(`${base()}/api/sessions/${targetId}/transcript?offset=1&limit=1&include_tool_results=true`, {
			headers: authHeaders({ "x-bobbit-session-id": callerId }),
		});
		expect(response.status).toBe(200);
		const raw = await response.text();
		expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(50 * 1024);
		const body = JSON.parse(raw);
		expect(body.messages[0].toolResults[0]).toMatchObject({
			name: "bash",
			status: "ok",
			omitted: false,
		});
		expect(body.messages[0].toolResults[0].size.bytes).toBe(Buffer.byteLength(oversizedResult, "utf8"));
	});

	test("cross-project caller can read target transcript", async ({ gateway }) => {
		const sm = gateway.sessionManager as any;
		const pcm = sm.getProjectContextManager?.() ?? sm.projectContextManager;
		const reg = pcm?.registry ?? pcm?.projectRegistry ?? sm.projectRegistry;

		// Register a second project
		const otherRoot = path.join(gateway.bobbitDir, "other-proj");
		fs.mkdirSync(otherRoot, { recursive: true });
		// Use the shared helper so rootPath is canonicalized (handles the macOS
		// /var → /private/var tmpdir symlink) and acceptCanonical:true is set.
		const { registerProject } = await import("./_e2e/e2e-setup.js");
		const otherProj = await registerProject({
			name: "other",
			rootPath: otherRoot,
			upsert: true,
			seedWorkflows: false,
		});
		const otherProjectId = otherProj.id;
		expect(otherProjectId).toBeTruthy();
		expect(otherProjectId).not.toBe(reg?.list?.()?.[0]?.id);

		// Target session in default project, caller session in other project.
		const jsonl = makeJsonl([{ role: "user", content: "cross-project readable transcript" }]);
		const { id: targetId } = seedSession(gateway, {}, jsonl);
		const { id: callerId } = seedSession(gateway, { projectId: otherProjectId }, "");

		const resp = await fetch(`${base()}/api/sessions/${targetId}/transcript`, {
			headers: authHeaders({ "x-bobbit-session-id": callerId }),
		});
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.total).toBe(1);
		expect(body.returned).toBe(1);
		expect(body.messages[0].role).toBe("user");
		expect(body.messages[0].text).toBe("cross-project readable transcript");
	});
});
