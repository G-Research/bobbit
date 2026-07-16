import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

import { currentScope } from "../_e2e/runtime.js";

export function localApiFetch(
	gateway: { baseURL: string; token: string },
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	return new Promise((resolve, reject) => {
		const body = typeof init.body === "string" ? init.body : undefined;
		const target = new URL(path, gateway.baseURL);
		const req = request(target, {
			method: init.method ?? "GET",
			headers: {
				Authorization: `Bearer ${gateway.token}`,
				...(body !== undefined ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
				...(init.headers as Record<string, string> | undefined),
			},
		}, response => {
			const chunks: Buffer[] = [];
			response.on("data", chunk => chunks.push(Buffer.from(chunk)));
			response.on("end", () => resolve(new Response(Buffer.concat(chunks), {
				status: response.statusCode ?? 500,
				headers: response.headers as HeadersInit,
			})));
		});
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

interface SessionGateway {
	bobbitDir: string;
	sessionManager: any;
}

export function trackSession(id: string): string {
	currentScope()?.trackSession(id);
	return id;
}

export function trackGoal(id: string): string {
	currentScope()?.trackGoal(id);
	return id;
}

export function trackProject(id: string): string {
	currentScope()?.trackProject(id);
	return id;
}

export function createSessionTracker(): {
	add(id: string): string;
	cleanup(gateway: { sessionManager: any }): Promise<void>;
} {
	const ids: string[] = [];
	return {
		add(id) {
			trackSession(id);
			ids.push(id);
			return id;
		},
		async cleanup(gateway) {
			const sm = gateway.sessionManager;
			for (const id of ids.splice(0).reverse()) {
				const persisted = sm.getPersistedSession(id);
				if (!persisted) continue;
				if (!persisted.archived) await sm.terminateSession(id);
				if (sm.getPersistedSession(id)?.archived) await sm.purgeArchivedSession(id);
			}
		},
	};
}

export function seedArchivedSession(
	gateway: SessionGateway & { defaultProjectId: string },
	overrides: Record<string, unknown> = {},
	messages: Array<{ role: "user" | "assistant"; text: string }> = [
		{ role: "user", text: "fixture transcript" },
	],
): string {
	const id = randomUUID();
	const now = Date.now();
	const jsonlPath = join(gateway.bobbitDir, "state", "session-prompts", `${id}-archived-fixture.jsonl`);
	mkdirSync(dirname(jsonlPath), { recursive: true });
	const entries = messages.map(({ role, text }) => ({
		type: "message",
		message: { role, content: [{ type: "text", text }] },
	}));
	writeFileSync(jsonlPath, entries.length > 0 ? `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n` : "");
	gateway.sessionManager.getSessionStore(gateway.defaultProjectId).put({
		id,
		title: "Archived fixture session",
		cwd: gateway.bobbitDir,
		agentSessionFile: jsonlPath,
		createdAt: now,
		lastActivity: now,
		archived: true,
		archivedAt: now,
		projectId: gateway.defaultProjectId,
		...overrides,
	});
	trackSession(id);
	return id;
}

/**
 * Give an API-created session a deterministic Pi transcript without running a
 * prompt through the mock agent. This is intentionally a test-fixture shortcut:
 * the endpoint under test still consumes the real persisted session record and
 * real JSONL bytes.
 */
export function seedSessionTranscript(
	gateway: SessionGateway,
	sessionId: string,
	messages: Array<{ role: "user" | "assistant"; text: string }> = [
		{ role: "user", text: "fixture transcript" },
	],
): string {
	const sm = gateway.sessionManager;
	const persisted = sm.getPersistedSession(sessionId);
	if (!persisted?.projectId) throw new Error(`session ${sessionId} was not persisted`);

	const jsonlPath = join(gateway.bobbitDir, "state", "session-prompts", `${sessionId}-fixture.jsonl`);
	mkdirSync(dirname(jsonlPath), { recursive: true });
	const entries = messages.map(({ role, text }) => ({
		type: "message",
		message: { role, content: [{ type: "text", text }] },
	}));
	writeFileSync(jsonlPath, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);

	const live = sm.getSession(sessionId);
	if (live) live.agentSessionFile = jsonlPath;
	sm.getSessionStore(persisted.projectId).update(sessionId, { agentSessionFile: jsonlPath });
	return jsonlPath;
}

/** Await the session manager's event-driven idle signal instead of REST polling. */
export async function waitForSessionIdle(gateway: SessionGateway, sessionId: string): Promise<void> {
	if (gateway.sessionManager.getSession(sessionId)?.status === "idle") return;
	await gateway.sessionManager.waitForIdle(sessionId, 1_000);
}

/** Capture the next user message directly from the live bridge event stream. */
export function nextUserMessage(gateway: SessionGateway, sessionId: string): Promise<string> {
	const session = gateway.sessionManager.getSession(sessionId);
	if (!session) throw new Error(`live session ${sessionId} not found`);
	return new Promise(resolve => {
		const unsubscribe = session.rpcClient.onEvent((event: any) => {
			if (event.type !== "message_end" || event.message?.role !== "user") return;
			unsubscribe();
			const content = Array.isArray(event.message.content) ? event.message.content : [];
			resolve(content.map((part: any) => part?.text ?? "").join(""));
		});
	});
}
