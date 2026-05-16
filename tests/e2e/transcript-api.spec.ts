/**
 * E2E: GET /api/sessions/:id/transcript
 *
 * Backs the `read_session` tool. Tests the HTTP surface end-to-end:
 *   - happy path (slice, tail, pattern+window)
 *   - error mapping (session_not_found, transcript_unavailable, invalid_regex,
 *     invalid_params, permission_denied)
 *   - cross-project authorization via x-bobbit-session-id header
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, base } from "./e2e-setup.js";
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

	test("permission_denied for cross-project caller", async ({ gateway }) => {
		const sm = gateway.sessionManager as any;
		const pcm = sm.getProjectContextManager?.() ?? sm.projectContextManager;
		const reg = pcm?.registry ?? pcm?.projectRegistry ?? sm.projectRegistry;

		// Register a second project
		const otherRoot = path.join(gateway.bobbitDir, "other-proj");
		fs.mkdirSync(otherRoot, { recursive: true });
		// Use the shared helper so rootPath is canonicalized (handles the macOS
		// /var → /private/var tmpdir symlink) and acceptCanonical:true is set.
		const { registerProject } = await import("./e2e-setup.js");
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
		const jsonl = makeJsonl([{ role: "user", content: "secret" }]);
		const { id: targetId } = seedSession(gateway, {}, jsonl);
		const { id: callerId } = seedSession(gateway, { projectId: otherProjectId }, "");

		const resp = await fetch(`${base()}/api/sessions/${targetId}/transcript`, {
			headers: authHeaders({ "x-bobbit-session-id": callerId }),
		});
		expect(resp.status).toBe(403);
		expect((await resp.json()).error).toBe("permission_denied");
	});
});
