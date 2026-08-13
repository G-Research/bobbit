/** E2E coverage for exact-session diagnostics and transcript reads. */
import { test, expect } from "./_e2e/in-process-harness.js";
import { readE2EToken, base, createSession } from "./_e2e/e2e-setup.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

let token: string;
test.beforeAll(() => { token = readE2EToken(); });

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extra };
}

function makeJsonl(messages: Array<{ role: string; content: any; ts?: string }>): string {
	return messages.map((m) => JSON.stringify({ type: "message", ts: m.ts, message: { role: m.role, content: m.content } })).join("\n") + "\n";
}

/** Seed persisted transcript metadata and its real JSONL file. */
function seedSession(gw: { sessionManager: any; bobbitDir: string }, overrides: Record<string, unknown> = {}, jsonl?: string): { id: string; agentSessionFile: string; projectId: string } {
	const sm = gw.sessionManager, pcm = sm.getProjectContextManager?.() ?? sm.projectContextManager;
	const reg = pcm?.registry ?? pcm?.projectRegistry ?? sm.projectRegistry;
	const defaultProjectId: string = (pcm?.getDefaultProjectId?.() as string | undefined) ?? (reg?.list?.()?.[0]?.id as string);
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
	test("exact session exposes safe live retry diagnostics", async ({ gateway }) => {
		const id = await createSession(), live = gateway.sessionManager.getSession(id)!;
		gateway.sessionManager.getSessionStore(live.projectId).update(id, { manualRetryRequired: true });
		live.manualRetryRequired = undefined; // Exercise the durable fallback used during recovery boundaries.
		live.transientRetryAttempts = 4; live.recoverDrainAttempts = 2;
		live.lastTurnErrorMessage = "RAW_ERROR_SENTINEL"; live.promptQueue.enqueue("RAW_QUEUE_SENTINEL");
		const resp = await fetch(`${base()}/api/sessions/${id}`, { headers: authHeaders() });
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body).toMatchObject({ manualRetryRequired: true, transientRetryAttempts: 4, recoverDrainAttempts: 2 });
		expect(JSON.stringify(body)).not.toMatch(/RAW_(?:ERROR|QUEUE)_SENTINEL/);
	});

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

	test("dispatches focused operations while preserving the no-operation route", async ({ gateway }) => {
		const bodies = ["FIRST_MUST_NOT_LEAK", "0123456789SECOND_ONLY_AND_MORE"], signature = "SIGNATURE_MUST_NOT_LEAK";
		const { id } = seedSession(gateway, {}, makeJsonl([
			{ role: "assistant", content: bodies.map((_, i) => ({ type: "tool_use", id: `c${i}`, name: "read", input: {} })) },
			{ role: "user", content: bodies.map((content, i) => ({ type: "tool_result", tool_use_id: `c${i}`, is_error: !!i,
				content: i ? [{ type: "text", text: content }, { type: "thinking", signature }] : content })) },
		]));
		const get = async (query: string) => { const response = await fetch(`${base()}/api/sessions/${id}/transcript?${query}`, { headers: authHeaders() }); expect(response.status).toBe(200); return response.json(); };
		const redacted = (value: any) => { for (const secret of [...bodies, signature]) expect(JSON.stringify(value)).not.toContain(secret); };
		const list = await get("operation=list&offset=0&limit=10");
		expect(list).toMatchObject({ operation: "list", total: 2, returned: 2 }); redacted(list);
		const message = await get("operation=inspect&message_index=1");
		expect(message).toMatchObject({ operation: "inspect", message: { index: 1 } }); expect(message.messages).toBeUndefined(); redacted(message);
		const exact = await get("operation=inspect&message_index=1&result_index=1&offset=10&limit=6");
		expect(exact.result).toMatchObject({ messageIndex: 1, resultIndex: 1, excerpt: "SECOND", offset: 10, returned: 6, totalChars: bodies[1].length, nextOffset: 16, truncated: true });
		expect(JSON.stringify(exact)).not.toContain(bodies[0]);
		const legacy = await get("offset=1&limit=1");
		expect(legacy.operation).toBeUndefined(); expect(JSON.stringify(legacy)).toContain(bodies[0]); expect(JSON.stringify(legacy)).toContain(signature);
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
