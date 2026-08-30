import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type GatewayInfo } from "./gateway-harness.js";
import {
	agentEndPredicate,
	apiFetch,
	connectWs,
	createSession,
	defaultProject,
	deleteSession,
	messageEndPredicate,
	secretsDir,
	type WsConnection,
	waitForHealth,
	waitForSessionStatus,
} from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

function messageText(message: any): string {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((block: any) => block?.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text)
		.join("");
}

function snapshotMessages(frame: any): any[] {
	return Array.isArray(frame?.data) ? frame.data : frame?.data?.messages ?? [];
}

async function requestSnapshot(conn: WsConnection): Promise<any[]> {
	const cursor = conn.messageCount();
	conn.send({ type: "get_messages" });
	const frame = await conn.waitForFrom(cursor, message => message.type === "messages", 20_000);
	return snapshotMessages(frame);
}

function promptFrom(messages: any[], text: string): any {
	return messages.find((message) =>
		(message?.role === "user" || message?.role === "user-with-attachments")
		&& messageText(message) === text,
	);
}

function parseRawTranscript(file: string): any[] {
	return readFileSync(file, "utf8")
		.split(/\r?\n/)
		.filter(line => line.trim().length > 0)
		.flatMap((line) => {
			try {
				const entry = JSON.parse(line);
				return entry?.type === "message" && entry.message ? [entry.message] : [];
			} catch {
				return [];
			}
		});
}

function rawPromptText(file: string, marker: string): string | undefined {
	return parseRawTranscript(file)
		.filter(message => message?.role === "user" || message?.role === "user-with-attachments")
		.map(messageText)
		.find(text => text.includes(marker));
}

function countOccurrences(text: string, value: string): number {
	if (!value) return 0;
	let count = 0;
	let cursor = 0;
	while ((cursor = text.indexOf(value, cursor)) !== -1) {
		count++;
		cursor += value.length;
	}
	return count;
}

function normalizeAgentId(sessionId: string): string {
	return sessionId
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "")
		.slice(0, 6);
}

function sidecarPath(sessionId: string): string {
	return join(secretsDir(), "author-sidecar", `${sessionId}.jsonl`);
}

function sidecarRecords(sessionId: string): any[] {
	const file = sidecarPath(sessionId);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split(/\r?\n/)
		.filter(line => line.trim().length > 0)
		.map(line => JSON.parse(line));
}

async function transcriptMessages(sessionId: string): Promise<any[]> {
	const response = await apiFetch(`/api/sessions/${sessionId}/transcript?offset=0&limit=200`);
	const text = await response.text();
	expect(response.status, text).toBe(200);
	return (JSON.parse(text) as { messages?: any[] }).messages ?? [];
}

function compactPrompt(messages: any[], marker: string): any {
	return messages.find(message => message?.role === "user" && typeof message.text === "string" && message.text.includes(marker));
}

async function waitForMessageSearchHit(projectId: string, sessionId: string, marker: string): Promise<any> {
	return pollUntil(async () => {
		const response = await apiFetch(
			`/api/search?q=${encodeURIComponent(marker)}&projectId=${encodeURIComponent(projectId)}&limit=50`,
		);
		if (!response.ok) return null;
		const body = await response.json() as { results?: any[] };
		return body.results?.find(result => result.type === "message" && result.sessionId === sessionId) ?? null;
	}, { timeoutMs: 20_000, intervalMs: 150, label: `message search hit for ${marker}` });
}

async function searchLastRebuildAt(projectId: string): Promise<number | null> {
	const response = await apiFetch(`/api/search/stats?projectId=${encodeURIComponent(projectId)}`);
	if (!response.ok) return null;
	const stats = await response.json() as { lastRebuildAt?: number | null };
	return typeof stats.lastRebuildAt === "number" ? stats.lastRebuildAt : null;
}

function stripHighlightMarkup(snippet: string): string {
	return snippet.replace(/<\/?b>/g, "");
}

function installStablePromptEcho(
	gateway: GatewayInfo,
	sessionId: string,
	marker: string,
	stableMessageId: string,
): () => void {
	const core = gateway.sessionManager?.getSession(sessionId)?.rpcClient?._agent;
	if (!core || typeof core.emit !== "function") {
		throw new Error("prefix restart E2E requires the in-process mock bridge event seam");
	}
	const originalEmit = core.emit;
	core.emit = function emitWithStableId(event: any) {
		if (
			(event?.type === "message_update" || event?.type === "message_end")
			&& (event.message?.role === "user" || event.message?.role === "user-with-attachments")
			&& messageText(event.message).includes(marker)
		) {
			event.message.id = stableMessageId;
		}
		return originalEmit.call(this, event);
	};
	return () => { core.emit = originalEmit; };
}

async function expectVisibleProjections(
	sessionId: string,
	conn: WsConnection,
	agentBaseText: string,
	agentMarker: string,
	agentPrefix: string,
	systemBaseText: string,
	systemMarker: string,
): Promise<void> {
	const snapshot = await requestSnapshot(conn);
	const agentPrompt = promptFrom(snapshot, agentBaseText);
	const systemPrompt = promptFrom(snapshot, systemBaseText);
	expect(agentPrompt, "WS snapshot contains the projected agent prompt").toBeTruthy();
	expect(systemPrompt, "WS snapshot contains the projected prefix-shaped system prompt").toBeTruthy();
	expect(messageText(agentPrompt)).toBe(agentBaseText);
	expect(messageText(agentPrompt)).not.toContain(agentPrefix);
	expect(agentPrompt.author).toMatchObject({ kind: "agent" });
	expect(messageText(systemPrompt)).toBe(systemBaseText);
	expect(countOccurrences(messageText(systemPrompt), "[System]: ")).toBe(1);
	expect(systemPrompt.author).toEqual({ kind: "system", id: "system:bobbit", label: "Bobbit" });

	const transcript = await transcriptMessages(sessionId);
	const transcriptAgent = compactPrompt(transcript, agentMarker);
	const transcriptSystem = compactPrompt(transcript, systemMarker);
	expect(transcriptAgent, "compact transcript contains the agent prompt").toBeTruthy();
	expect(transcriptAgent.text).toBe(agentBaseText);
	expect(transcriptAgent.text).not.toContain(agentPrefix);
	expect(transcriptAgent.author).toMatchObject({ kind: "agent" });
	expect(transcriptSystem, "compact transcript contains the prefix-shaped system prompt").toBeTruthy();
	expect(transcriptSystem.text).toBe(systemBaseText);
	expect(countOccurrences(transcriptSystem.text, "[System]: ")).toBe(1);
	expect(transcriptSystem.author).toEqual({ kind: "system", id: "system:bobbit", label: "Bobbit" });
}

async function expectSearchProjections(
	projectId: string,
	sessionId: string,
	agentMarker: string,
	agentPrefix: string,
	systemMarker: string,
): Promise<void> {
	const agentHit = await waitForMessageSearchHit(projectId, sessionId, agentMarker);
	const agentSnippet = stripHighlightMarkup(agentHit.snippet ?? "");
	expect(agentSnippet).toContain(agentMarker);
	expect(agentSnippet).not.toContain(agentPrefix);

	const systemHit = await waitForMessageSearchHit(projectId, sessionId, systemMarker);
	const systemSnippet = stripHighlightMarkup(systemHit.snippet ?? "");
	expect(systemSnippet).toContain(systemMarker);
	expect(countOccurrences(systemSnippet, "[System]: ")).toBe(1);
}

async function restartGateway(gateway: GatewayInfo): Promise<void> {
	await gateway.restart();
	await waitForHealth(20_000);
}

test.describe.serial("message author prefix restart projection", () => {
	test("trusted agent/system prefixes remain raw-only across EventBuffer replay, projection re-entry, search rebuild, and gateway restart", async ({ gateway }) => {
		test.setTimeout(120_000);
		const project = await defaultProject();
		// Fresh E2E state schedules a delayed empty-index rebuild. Let that settle
		// before the mock's live-only messages begin so this projection test cannot
		// race a rebuild that read the mock transcript before get_state flushed it.
		await pollUntil(
			() => searchLastRebuildAt(project.id),
			{ timeoutMs: 20_000, intervalMs: 150, label: "initial search rebuild completion" },
		);
		const callerId = await createSession({ projectId: project.id });
		const targetId = await createSession({ projectId: project.id });
		const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const agentMarker = `AUTHOR_PREFIX_AGENT_RESTART_${nonce}`;
		const systemMarker = `AUTHOR_PREFIX_SYSTEM_RESTART_${nonce}`;
		const agentBaseText = `Agent accountable base text ${agentMarker}`;
		const systemBaseText = `[System]: hello ${systemMarker}`;
		const callerLabel = "Restart Relay";
		const agentPrefix = `[${callerLabel} (${normalizeAgentId(callerId)})]: `;
		const systemPrefix = "[System]: ";
		const stableSystemMessageId = `message-author-system-${nonce}`;
		let conn: WsConnection | undefined;
		let resumeConn: WsConnection | undefined;
		let serverOnline = true;
		let restoreStableEcho: (() => void) | undefined;

		try {
			await waitForSessionStatus(callerId, "idle", 20_000);
			await waitForSessionStatus(targetId, "idle", 20_000);
			const rename = await apiFetch(`/api/sessions/${callerId}`, {
				method: "PATCH",
				body: JSON.stringify({ title: callerLabel }),
			});
			expect(rename.status, await rename.clone().text()).toBe(200);

			const caller = gateway.sessionManager?.getSession(callerId);
			expect(caller, "authenticated caller session is live").toBeTruthy();
			caller.allowedTools = Array.from(new Set([...(caller.allowedTools ?? []), "session_prompt"]));
			const callerSecret = gateway.sessionManager?.sessionSecretStore?.getOrCreateSecret(callerId);
			expect(callerSecret, "caller has a server-minted session secret").toBeTruthy();

			conn = await connectWs(targetId);
			const agentCursor = conn.messageCount();
			const delivery = await apiFetch(`/api/sessions/${targetId}/prompt`, {
				method: "POST",
				headers: { "X-Bobbit-Session-Secret": callerSecret },
				body: JSON.stringify({ message: agentBaseText, mode: "prompt" }),
			});
			const deliveryText = await delivery.text();
			expect(delivery.status, deliveryText).toBe(200);
			const liveAgent = await conn.waitForFrom(agentCursor, message =>
				messageEndPredicate("user")(message)
				&& messageText(message.data.message) === agentBaseText,
			20_000);
			expect(liveAgent.data.message.author).toEqual({
				kind: "agent",
				id: `session:${callerId}`,
				label: callerLabel,
			});
			await waitForSessionStatus(targetId, "idle", 20_000);

			restoreStableEcho = installStablePromptEcho(gateway, targetId, systemMarker, stableSystemMessageId);
			const systemCursor = conn.messageCount();
			const systemResult = await gateway.sessionManager?.enqueuePrompt(targetId, systemBaseText, {
				source: "task-notification",
			});
			expect(systemResult?.status).toBe("dispatched");
			const liveSystem = await conn.waitForFrom(systemCursor, message =>
				messageEndPredicate("user")(message)
				&& messageText(message.data.message) === systemBaseText,
			20_000);
			expect(liveSystem.data.message.id).toBe(stableSystemMessageId);
			expect(liveSystem.data.message.author).toEqual({ kind: "system", id: "system:bobbit", label: "Bobbit" });
			await conn.waitForFrom(systemCursor, agentEndPredicate(), 20_000);
			await waitForSessionStatus(targetId, "idle", 20_000);
			restoreStableEcho();
			restoreStableEcho = undefined;
			// The in-process mock flushes its current conversation to the Pi JSONL on
			// get_state. Force that normal persistence boundary after both turns so
			// the raw-byte assertions never race a later lifecycle snapshot.
			await gateway.sessionManager?.getSession(targetId)?.rpcClient.getState();

			const persisted = gateway.sessionManager?.getPersistedSession(targetId);
			const transcriptFile = persisted?.agentSessionFile as string | undefined;
			expect(transcriptFile, "target has a persisted Pi transcript").toBeTruthy();
			await expect.poll(() => transcriptFile && existsSync(transcriptFile)
				? [rawPromptText(transcriptFile, agentMarker), rawPromptText(transcriptFile, systemMarker)]
				: [], { timeout: 20_000 }).toEqual([
				`${agentPrefix}${agentBaseText}`,
				`${systemPrefix}${systemBaseText}`,
			]);
			expect(countOccurrences(rawPromptText(transcriptFile!, agentMarker)!, agentPrefix)).toBe(1);
			expect(countOccurrences(rawPromptText(transcriptFile!, systemMarker)!, systemPrefix)).toBe(2);

			const records = sidecarRecords(targetId);
			const agentDispatch = records.find(record => record.type === "prompt-author" && record.modelPrefix === agentPrefix);
			const systemDispatch = records.find(record => record.type === "prompt-author" && record.modelPrefix === systemPrefix);
			expect(agentDispatch).toMatchObject({
				schemaVersion: 2,
				author: { kind: "agent", id: `session:${callerId}`, label: callerLabel },
				modelPrefix: agentPrefix,
				modelTextDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
			});
			expect(systemDispatch).toMatchObject({
				schemaVersion: 2,
				author: { kind: "system", id: "system:bobbit", label: "Bobbit" },
				modelPrefix: systemPrefix,
				modelTextDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
			});
			const rawSidecar = readFileSync(sidecarPath(targetId), "utf8");
			expect(rawSidecar).not.toContain(agentMarker);
			expect(rawSidecar).not.toContain(systemMarker);
			expect(rawSidecar).not.toContain(agentBaseText);
			expect(rawSidecar).not.toContain(systemBaseText);

			await expectVisibleProjections(
				targetId,
				conn,
				agentBaseText,
				agentMarker,
				agentPrefix,
				systemBaseText,
				systemMarker,
			);
			await expectSearchProjections(project.id, targetId, agentMarker, agentPrefix, systemMarker);

			const targetSession = gateway.sessionManager?.getSession(targetId);
			const systemEntry = targetSession?.eventBuffer.getAll().find((entry: any) =>
				entry.event?.type === "message_end"
				&& entry.event.message?.id === stableSystemMessageId,
			);
			expect(systemEntry, "EventBuffer retains the once-projected stable system row").toBeTruthy();
			expect(messageText(systemEntry.event.message)).toBe(systemBaseText);
			expect(countOccurrences(messageText(systemEntry.event.message), systemPrefix)).toBe(1);

			resumeConn = await connectWs(targetId);
			const resumeCursor = resumeConn.messageCount();
			resumeConn.send({ type: "resume", fromSeq: Math.max(0, systemEntry.seq - 1) });
			const resumed = await resumeConn.waitForFrom(resumeCursor, message =>
				message.type === "event"
				&& message.seq === systemEntry.seq
				&& message.data?.message?.id === stableSystemMessageId,
			20_000);
			expect(messageText(resumed.data.message)).toBe(systemBaseText);
			expect(countOccurrences(messageText(resumed.data.message), systemPrefix)).toBe(1);

			const { prepareVisibleAgentEvent } = await import("../../dist/server/agent/session-manager.js");
			const clonedProjectedEvent = JSON.parse(JSON.stringify(systemEntry.event));
			const projectedAgain = prepareVisibleAgentEvent(targetSession, clonedProjectedEvent) as any;
			expect(projectedAgain.message.author).toEqual({ kind: "system", id: "system:bobbit", label: "Bobbit" });
			expect(messageText(projectedAgain.message)).toBe(systemBaseText);
			expect(countOccurrences(messageText(projectedAgain.message), systemPrefix)).toBe(1);

			conn.close();
			conn = undefined;
			resumeConn.close();
			resumeConn = undefined;
			await gateway.crash();
			serverOnline = false;
			await restartGateway(gateway);
			serverOnline = true;
			await waitForSessionStatus(targetId, "idle", 30_000);

			const restarted = await connectWs(targetId);
			conn = restarted;
			await expectVisibleProjections(
				targetId,
				restarted,
				agentBaseText,
				agentMarker,
				agentPrefix,
				systemBaseText,
				systemMarker,
			);

			const restartedTranscript = gateway.sessionManager?.getPersistedSession(targetId)?.agentSessionFile as string;
			expect(rawPromptText(restartedTranscript, agentMarker)).toBe(`${agentPrefix}${agentBaseText}`);
			expect(rawPromptText(restartedTranscript, systemMarker)).toBe(`${systemPrefix}${systemBaseText}`);
			expect(countOccurrences(rawPromptText(restartedTranscript, agentMarker)!, agentPrefix)).toBe(1);
			expect(countOccurrences(rawPromptText(restartedTranscript, systemMarker)!, systemPrefix)).toBe(2);

			const previousRebuildAt = await searchLastRebuildAt(project.id);
			const rebuildStartedAt = Date.now();
			const rebuild = await apiFetch("/api/search/rebuild", {
				method: "POST",
				body: JSON.stringify({ projectId: project.id }),
			});
			expect(rebuild.status, await rebuild.clone().text()).toBe(202);
			await pollUntil(async () => {
				const rebuiltAt = await searchLastRebuildAt(project.id);
				return rebuiltAt !== null
					&& rebuiltAt >= rebuildStartedAt
					&& (previousRebuildAt === null || rebuiltAt > previousRebuildAt)
					? rebuiltAt
					: null;
			}, { timeoutMs: 30_000, intervalMs: 150, label: "post-restart search rebuild completion" });
			await expectSearchProjections(project.id, targetId, agentMarker, agentPrefix, systemMarker);
		} finally {
			restoreStableEcho?.();
			conn?.close();
			resumeConn?.close();
			if (!serverOnline) {
				await restartGateway(gateway).catch(() => undefined);
			}
			await deleteSession(targetId).catch(() => undefined);
			await deleteSession(callerId).catch(() => undefined);
		}
	});
});
