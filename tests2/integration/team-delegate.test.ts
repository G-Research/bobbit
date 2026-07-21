/**
 * v2 integration — `team_delegate` blocking-lifecycle + model inheritance.
 *
 * Ported faithfully from tests/e2e/team-delegate.spec.ts (source of truth) onto
 * the Test Suite v2 fork-scoped gateway fixture + in-process mock bridge. The
 * scoping / authz surface of that spec is already covered by
 * tests2/core/orchestration-core.test.ts; this port preserves the sub-behaviours
 * the triage flagged as GENUINE-LOSS:
 *   • blocking one-shot delegate → spawn → wait → collected output → auto-dismiss,
 *   • parallel blocking delegate WAITS FOR ALL children,
 *   • a spawned child inherits the parent's CURRENT model (regression vs the old
 *     system-default drop) + per-call `model` override wins.
 *
 * Drives the real `/api/sessions/:id/orchestrate/*` routes (in-process
 * OrchestrationCore) end to end against the deterministic mock agent — a
 * delegate child auto-runs its instructions prompt and the mock responds "OK",
 * so blocking flows settle in milliseconds (never test:manual).
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, createSession, deleteSession, connectWs, defaultProject, type WsConnection } from "./_e2e/e2e-setup.js";
import { readAuthorSidecar } from "../../src/server/agent/author-sidecar.js";

const OPUS = { provider: "anthropic", modelId: "claude-opus-4-8" };
const DELEGATE_KICKOFF = "Execute the task described in your system prompt. Follow the instructions carefully.";

function messageText(message: any): string {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n");
}

async function getMessages(conn: WsConnection): Promise<any[]> {
	const cursor = conn.messageCount();
	conn.send({ type: "get_messages" });
	const frame = await conn.waitForFrom(cursor, (message) => message.type === "messages");
	return Array.isArray(frame.data) ? frame.data : frame.data?.messages ?? [];
}

/** Poll a predicate until it returns a truthy value, or throw on timeout. */
async function pollUntil<T>(
	predicate: () => T | Promise<T>,
	opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? 10_000;
	const intervalMs = opts.intervalMs ?? 50;
	const label = opts.label ?? "predicate";
	const start = Date.now();
	let lastErr: unknown;
	while (Date.now() - start < timeoutMs) {
		try { const v = await predicate(); if (v) return v; } catch (err) { lastErr = err; }
		await new Promise(r => setTimeout(r, intervalMs));
	}
	const errSuffix = lastErr ? ` (last error: ${(lastErr as Error)?.message ?? lastErr})` : "";
	throw new Error(`pollUntil("${label}") timed out after ${Date.now() - start}ms${errSuffix}`);
}

async function orchestrate(ownerId: string, verb: string, body?: unknown): Promise<{ status: number; json: any }> {
	const resp = await apiFetch(`/api/sessions/${ownerId}/orchestrate/${verb}`, {
		method: "POST",
		body: JSON.stringify(body ?? {}),
	});
	let json: any = undefined;
	try { json = await resp.json(); } catch { /* chunked / empty */ }
	return { status: resp.status, json };
}

async function listChildren(ownerId: string): Promise<any[]> {
	const resp = await apiFetch(`/api/sessions/${ownerId}/orchestrate/children`);
	expect(resp.status).toBe(200);
	return (await resp.json()).children ?? [];
}

/** Set a session's model via WS and wait until it persists. */
async function setSessionModel(sessionId: string, provider: string, modelId: string): Promise<void> {
	const conn = await connectWs(sessionId);
	try {
		conn.send({ type: "set_model", provider, modelId });
		await pollUntil(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			if (!resp.ok) return false;
			const data = await resp.json();
			return data.modelProvider === provider && data.modelId === modelId ? true : null;
		}, { timeoutMs: 5_000, intervalMs: 50, label: `model ${provider}/${modelId} persisted` });
	} finally {
		conn.close();
	}
}

test.describe("team_delegate — blocking one-shot (delegate parity)", () => {
	test("single blocking delegate spawns, waits, returns output, and auto-dismisses", async () => {
		const parent = await createSession();
		try {
			const { status, json } = await orchestrate(parent, "delegate", { instructions: "do a small task" });
			expect(status).toBe(200);
			expect(Array.isArray(json.delegates)).toBe(true);
			expect(json.delegates.length).toBe(1);
			expect(json.delegates[0].status).toBe("completed");
			// Mock agent's default reply is "OK" → that is the collected output.
			expect(json.delegates[0].output).toContain("OK");
			// Auto-dismiss: no tracked children remain after a blocking delegate.
			expect(await listChildren(parent)).toHaveLength(0);
		} finally {
			await deleteSession(parent);
		}
	});

	test("parallel blocking delegate waits for ALL children", async () => {
		const parent = await createSession();
		try {
			const { status, json } = await orchestrate(parent, "delegate", {
				parallel: [{ instructions: "task one" }, { instructions: "task two" }, { instructions: "task three" }],
			});
			expect(status).toBe(200);
			expect(json.delegates.length).toBe(3);
			expect(json.delegates.every((d: any) => d.status === "completed")).toBe(true);
			expect(await listChildren(parent)).toHaveLength(0);
		} finally {
			await deleteSession(parent);
		}
	});
});

test.describe("team_delegate — accountable kickoff author", () => {
	test("renamed staff owner persists its current author and reloads it without changing prompt bytes or role", async ({ gateway }) => {
		const project = await defaultProject();
		const oldName = `Delegate Staff Old ${Date.now()}`;
		const newName = `Delegate Staff New ${Date.now()}`;
		const created = await apiFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify({
				name: oldName,
				systemPrompt: "Own a delegate author regression.",
				cwd: project.rootPath,
				projectId: project.id,
				worktree: false,
			}),
		});
		expect(created.status, await created.clone().text()).toBe(201);
		const staff = await created.json();
		const parent = staff.currentSessionId as string;
		let childId: string | undefined;
		try {
			const renamed = await apiFetch(`/api/staff/${staff.id}`, {
				method: "PUT",
				body: JSON.stringify({ name: newName }),
			});
			expect(renamed.status, await renamed.clone().text()).toBe(200);
			expect(gateway.sessionManager.getSession(parent)?.title).toBe(oldName);

			const { status, json } = await orchestrate(parent, "spawn", {
				instructions: "delegate author lifecycle",
			});
			expect(status).toBe(201);
			childId = json.childSessionId as string;
			expect(childId).toBeTruthy();

			await pollUntil(() => gateway.sessionManager.getSession(childId!)?.status === "idle", {
				timeoutMs: 5_000,
				intervalMs: 25,
				label: "delegate kickoff settled",
			});

			const binding = readAuthorSidecar(childId!).find((entry) => entry.modelText === DELEGATE_KICKOFF);
			expect(binding).toMatchObject({
				modelText: DELEGATE_KICKOFF,
				source: "agent",
				author: { kind: "agent", id: `staff:${staff.id}`, label: newName },
				settlement: { outcome: "echoed" },
			});

			// Attach only after the turn has settled: get_messages must reconstruct
			// this persisted transcript row from the Bobbit sidecar, not a live ledger.
			const reloaded = await connectWs(childId!);
			try {
				const messages = await getMessages(reloaded);
				const kickoff = messages.find((message) => message.role === "user" && messageText(message) === DELEGATE_KICKOFF);
				expect(kickoff).toMatchObject({
					role: "user",
					author: binding!.author,
				});
				expect(messageText(kickoff)).toBe(DELEGATE_KICKOFF);
				expect(messages.some((message) => message.role === "assistant")).toBe(true);
			} finally {
				reloaded.close();
			}
		} finally {
			if (childId) await orchestrate(parent, "dismiss", { childSessionId: childId }).catch(() => undefined);
			await apiFetch(`/api/staff/${staff.id}`, { method: "DELETE" }).catch(() => undefined);
		}
	});
});

test.describe("team_delegate — model inheritance", () => {
	test("a spawned child inherits the parent's CURRENT model (not the system default)", async ({ gateway }) => {
		const parent = await createSession();
		try {
			await setSessionModel(parent, OPUS.provider, OPUS.modelId);
			const { status, json } = await orchestrate(parent, "spawn", { instructions: "inherit-model child" });
			expect(status).toBe(201);
			const childId = json.childSessionId as string;
			expect(childId).toBeTruthy();
			// The child session is pinned to the owner's CURRENT model end-to-end
			// (REST route → OrchestrationCore.spawn → createDelegateSession →
			// session-setup), NOT dropped to the system default.
			const childModel = await pollUntil(async () => {
				const s = gateway.sessionManager.getSession(childId);
				return s?.spawnPinnedModel ?? null;
			}, { timeoutMs: 5_000, intervalMs: 25, label: "child spawnPinnedModel" });
			expect(childModel).toBe(`${OPUS.provider}/${OPUS.modelId}`);
			await orchestrate(parent, "dismiss", { childSessionId: childId });
		} finally {
			await deleteSession(parent);
		}
	});

	test("per-call model override wins over inheritance", async ({ gateway }) => {
		const parent = await createSession();
		try {
			await setSessionModel(parent, OPUS.provider, OPUS.modelId);
			const { status, json } = await orchestrate(parent, "spawn", {
				instructions: "override-model child",
				model: "openai/gpt-override",
			});
			expect(status).toBe(201);
			const childId = json.childSessionId as string;
			const childModel = await pollUntil(async () => {
				const s = gateway.sessionManager.getSession(childId);
				return s?.spawnPinnedModel ?? null;
			}, { timeoutMs: 5_000, intervalMs: 25, label: "child override model" });
			expect(childModel).toBe("openai/gpt-override");
			await orchestrate(parent, "dismiss", { childSessionId: childId });
		} finally {
			await deleteSession(parent);
		}
	});
});
