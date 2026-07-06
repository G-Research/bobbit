/**
 * Session transcript/sidecar plumbing - SessionManager decomposition cohort 10.
 *
 * SessionManager keeps same-named wrappers for callers and source-shape tests,
 * while persisted transcript reads, snapshot hydration, compaction refresh, and
 * session-file recovery live here.
 */
import fs from "node:fs";
import path from "node:path";
import type { WebSocket } from "ws";
import type { ServerMessage } from "../ws/protocol.js";
import type { SandboxManager } from "./sandbox-manager.js";
import type { SessionInfo } from "./session-manager.js";
import { sessionFileRead, sessionFsContextForAgentFile } from "./session-fs.js";
import { buildSessionSidecar, writeSessionSidecar } from "./session-sidecar.js";
import type { PersistedSession, SessionStore } from "./session-store.js";
import { resolveSessionRuntime } from "./session-runtime.js";
import { resolveReadablePersistedAgentSessionFile, trustPersistedAgentSessionFile } from "./transcript-sanitizer.js";
import { mergeCompactionSidecarIntoMessages } from "./compaction-sidecar.js";
import { normalizeToolResultErrorSnapshot } from "./tool-result-error-normalizer.js";
import { truncateLargeToolContentInMessages } from "./truncate-large-content.js";
import { spliceInFlightMessage, spliceInFlightSteers } from "./splice-inflight-message.js";
import { trustedAgentSessionsRoots } from "./agent-session-path.js";

export interface SessionTranscriptsDeps {
	resolveStoreForId(id: string): SessionStore | null;
	resolveStoreForSession(id: string): SessionStore;
	getSession(id: string): SessionInfo | undefined;
	getSandboxManager(): SandboxManager | null;
	broadcastSessionCost(session: SessionInfo): void;
	withSessionCostInState(sessionId: string, data: unknown): unknown;
	broadcast(clients: Set<WebSocket>, msg: ServerMessage): void;
}

function isWindowsAbsolutePath(filePath: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(filePath);
}

function isContainerAgentSessionPath(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	return normalized === "/home/node/.bobbit/agent/sessions"
		|| normalized.startsWith("/home/node/.bobbit/agent/sessions/")
		|| normalized === "/bobbit-state/sessions"
		|| normalized.startsWith("/bobbit-state/sessions/");
}

function isHostAbsoluteAgentSessionPath(filePath: string | undefined): boolean {
	if (!filePath || isContainerAgentSessionPath(filePath)) return false;
	return path.isAbsolute(filePath) || isWindowsAbsolutePath(filePath);
}

function safePersistedHostAgentSessionFile(filePath: string | undefined): string | null {
	if (!filePath) return null;
	if (!isHostAbsoluteAgentSessionPath(filePath)) return filePath;
	trustPersistedAgentSessionFile(filePath);
	return resolveReadablePersistedAgentSessionFile(filePath);
}

function stringifyPersistedToolResultContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((item: any) => {
			if (typeof item === "string") return item;
			if (item?.type === "text" && typeof item.text === "string") return item.text;
			try { return JSON.stringify(item); } catch { return String(item); }
		}).join("\n");
	}
	if (content == null) return "";
	try { return JSON.stringify(content); } catch { return String(content); }
}

function withPersistedClaudeCodeMessageTimestamp(message: any, envelopeTs: unknown): any {
	if (!message || typeof message !== "object" || message.timestamp !== undefined) return message;
	let timestamp: number | undefined;
	if (typeof envelopeTs === "number" && Number.isFinite(envelopeTs)) timestamp = envelopeTs < 10_000_000_000 ? envelopeTs * 1000 : envelopeTs;
	else if (typeof envelopeTs === "string") {
		const parsed = Date.parse(envelopeTs);
		if (Number.isFinite(parsed)) timestamp = parsed;
	}
	return timestamp === undefined ? message : { ...message, timestamp };
}

function normalizePersistedClaudeCodeAskMessages(messages: unknown[]): unknown[] {
	const askToolIds = new Set<string>();
	for (const message of messages as any[]) {
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			const id = typeof block?.toolCallId === "string" ? block.toolCallId : (typeof block?.id === "string" ? block.id : undefined);
			if (block?.type === "toolCall" && block.name === "ask_user_choices" && id) askToolIds.add(id);
		}
	}
	return messages.map((message: any) => {
		if (message?.role !== "toolResult") return message;
		if (message.toolName !== "ask_user_choices" || !askToolIds.has(message.toolCallId)) return message;
		const text = stringifyPersistedToolResultContent(message.content).trim();
		if (text !== "Answer questions?") return message;
		const rest = { ...message };
		delete rest.error;
		return {
			...rest,
			isError: false,
			content: [{ type: "text", text: JSON.stringify({ status: "posted", tool_use_id: message.toolCallId }) }],
		};
	});
}

export class SessionTranscripts {
	constructor(private readonly deps: SessionTranscriptsDeps) {}

	private get sandboxManager(): SandboxManager | null {
		return this.deps.getSandboxManager();
	}

	private resolveStoreForId(id: string): SessionStore | null {
		return this.deps.resolveStoreForId(id);
	}

	private resolveStoreForSession(id: string): SessionStore {
		return this.deps.resolveStoreForSession(id);
	}

	private extractAssistantText(messages: unknown[]): string {
		const texts: string[] = [];
		for (const msg of messages as Array<{ role?: string; content?: unknown }>) {
			if (msg?.role !== "assistant") continue;
			const content = msg.content;
			if (typeof content === "string") {
				texts.push(content);
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block?.type === "text" && block.text) texts.push(block.text);
				}
			}
		}
		return texts.join("\n\n");
	}

	private async getPersistedSessionMessages(sessionId: string, opts?: { claudeCodeOnly?: boolean; archivedOnly?: boolean }): Promise<unknown[]> {
		const ps = this.resolveStoreForId(sessionId)?.get(sessionId);
		if (!ps?.agentSessionFile) return [];
		if (opts?.archivedOnly && !ps.archived) return [];
		const isClaudeCode = resolveSessionRuntime({ runtime: ps.runtime, modelProvider: ps.modelProvider }) === "claude-code";
		if (opts?.claudeCodeOnly && !isClaudeCode) return [];
		try {
			const safeFile = safePersistedHostAgentSessionFile(ps.agentSessionFile);
			if (!safeFile) return [];
			trustPersistedAgentSessionFile(safeFile);
			const ctx = sessionFsContextForAgentFile(ps, safeFile);
			const content = await sessionFileRead(ctx, safeFile, this.sandboxManager);
			if (!content) return [];
			const messages: unknown[] = [];
			for (const line of content.split(/\r?\n/)) {
				if (!line.trim()) continue;
				try {
					const entry = JSON.parse(line);
					if (entry.type === "message" && entry.message) messages.push(isClaudeCode ? withPersistedClaudeCodeMessageTimestamp(entry.message, entry.ts) : entry.message);
				} catch { /* skip malformed line */ }
			}
			return isClaudeCode ? normalizePersistedClaudeCodeAskMessages(messages) : messages;
		} catch {
			return [];
		}
	}

	async hydrateClaudeCodeSnapshotMessages(sessionId: string, liveData: unknown): Promise<unknown> {
		const persisted = await this.getPersistedSessionMessages(sessionId, { claudeCodeOnly: true });
		if (persisted.length === 0) return liveData;
		const liveMessages = Array.isArray(liveData)
			? liveData
			: (liveData && typeof liveData === "object" && Array.isArray((liveData as any).messages) ? (liveData as any).messages : []);
		if (persisted.length <= liveMessages.length) return liveData;
		const messages = truncateLargeToolContentInMessages(persisted) as unknown[];
		if (Array.isArray(liveData)) return messages;
		if (liveData && typeof liveData === "object") return { ...(liveData as Record<string, unknown>), messages };
		return { messages };
	}

	async getMessagesSnapshotBase(session: SessionInfo): Promise<{ success: boolean; data?: unknown; error?: string }> {
		const seq = session.eventBuffer.lastSeq;
		const cached = session.messagesSnapshotCache;
		if (cached && cached.seq === seq) return cached.promise;
		const promise = (async (): Promise<{ success: boolean; data?: unknown; error?: string }> => {
			const msgsResp = await session.rpcClient.getMessages();
			if (!msgsResp?.success) return msgsResp;
			const hydrated = await this.hydrateClaudeCodeSnapshotMessages(session.id, msgsResp.data);
			const raw = normalizeToolResultErrorSnapshot(hydrated as any);
			return { ...msgsResp, data: raw };
		})();
		session.messagesSnapshotCache = { seq, promise };
		promise.then(
			(r) => { if (!r?.success && session.messagesSnapshotCache?.promise === promise) session.messagesSnapshotCache = undefined; },
			() => { if (session.messagesSnapshotCache?.promise === promise) session.messagesSnapshotCache = undefined; },
		);
		return promise;
	}

	private async getPersistedSessionOutput(sessionId: string): Promise<string> {
		const messages = await this.getPersistedSessionMessages(sessionId);
		return this.extractAssistantText(messages);
	}

	async getSessionOutput(sessionId: string): Promise<string> {
		const session = this.deps.getSession(sessionId);
		if (!session || session.dormant === true) {
			return this.getPersistedSessionOutput(sessionId);
		}

		const msgsResp = await session.rpcClient.getMessages();
		if (!msgsResp.success) return this.getPersistedSessionOutput(sessionId);

		const messages = msgsResp.data?.messages || msgsResp.data;
		if (!Array.isArray(messages)) return "";

		return this.extractAssistantText(messages);
	}

	async refreshAfterCompaction(session: SessionInfo): Promise<void> {
		try {
			this.deps.broadcastSessionCost(session);

			const msgs = await session.rpcClient.getMessages();
			if (msgs.success) {
				const raw: any = normalizeToolResultErrorSnapshot(msgs.data);
				let data: any = raw;
				if (Array.isArray(raw)) {
					const spliced = spliceInFlightSteers(
						spliceInFlightMessage(raw, session.latestMessageUpdate),
						session.inFlightSteerTexts,
					);
					const withCompaction = mergeCompactionSidecarIntoMessages(session.id, spliced);
					data = truncateLargeToolContentInMessages(withCompaction);
				} else if (raw && Array.isArray(raw.messages)) {
					const spliced = spliceInFlightSteers(
						spliceInFlightMessage(raw.messages, session.latestMessageUpdate),
						session.inFlightSteerTexts,
					);
					const withCompaction = mergeCompactionSidecarIntoMessages(session.id, spliced);
					const truncated = truncateLargeToolContentInMessages(withCompaction);
					data = spliced === raw.messages && truncated === raw.messages && withCompaction === raw.messages
						? raw
						: { ...raw, messages: truncated };
				}
				this.deps.broadcast(session.clients, { type: "messages", data });
			}
			const st = await session.rpcClient.getState();
			if (st.success) {
				this.deps.broadcast(session.clients, { type: "state", data: this.deps.withSessionCostInState(session.id, st.data) });
			}
		} catch (err) {
			console.error(`[session-manager] Failed to refresh after compaction for ${session.id}:`, err);
		}
	}

	async persistSessionMetadata(session: SessionInfo): Promise<void> {
		const maxRetries = 3;
		const delays = [500, 1000, 2000];

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				const stateResp = await session.rpcClient.getState();
				if (!stateResp.success || !stateResp.data?.sessionFile) {
					if (attempt < maxRetries) {
						console.warn(`[session-manager] getState() returned no sessionFile for ${session.id}, retrying...`);
						await new Promise(resolve => setTimeout(resolve, delays[attempt]));
						continue;
					}
					console.error(
						`[session-manager] CRITICAL: Could not get agent session file for ${session.id} after ${maxRetries + 1} attempts. ` +
						`This session will NOT survive a server restart.`,
					);
					return;
				}

				const agentSessionFile = stateResp.data.sessionFile;
				this.resolveStoreForSession(session.id).update(session.id, { agentSessionFile });

				try {
					const ps = this.resolveStoreForSession(session.id).get(session.id);
					if (ps) {
						const agentSessionId = (stateResp.data?.sessionId as string | undefined)
							|| path.basename(agentSessionFile).replace(/\.jsonl$/, "");
						const sidecar = buildSessionSidecar(
							ps,
							agentSessionId,
							undefined,
						);
						writeSessionSidecar(agentSessionFile, sidecar);
					}
				} catch (err) {
					console.warn(`[session-manager] Failed to write session sidecar for ${session.id}: ${err}`);
				}
				return;
			} catch (err) {
				if (attempt < maxRetries) {
					console.warn(`[session-manager] persistSessionMetadata failed for ${session.id} (attempt ${attempt + 1}), retrying: ${err}`);
					await new Promise(resolve => setTimeout(resolve, delays[attempt]));
				} else {
					console.error(
						`[session-manager] CRITICAL: persistSessionMetadata failed for ${session.id} after ${maxRetries + 1} attempts: ${err}\n` +
						`  This session will NOT survive a server restart.`,
					);
				}
			}
		}
	}

	async getArchivedMessages(id: string): Promise<unknown[]> {
		const messages = await this.getPersistedSessionMessages(id, { archivedOnly: true });
		return normalizeToolResultErrorSnapshot(truncateLargeToolContentInMessages(messages)) as unknown[];
	}

	recoverSessionFile(ps: PersistedSession): string | null {
		try {
			if (ps.agentSessionFile && isHostAbsoluteAgentSessionPath(ps.agentSessionFile) && fs.existsSync(ps.agentSessionFile)) {
				const safePath = safePersistedHostAgentSessionFile(ps.agentSessionFile);
				if (safePath) {
					trustPersistedAgentSessionFile(safePath);
					return safePath.replace(/\\/g, "/");
				}
			}

			const cwdSlug = "--" + ps.cwd.replace(/[^a-zA-Z0-9]/g, "-") + "--";
			const TOLERANCE_MS = 60_000;

			const sessionRoots = trustedAgentSessionsRoots();

			for (const sessionsDir of sessionRoots) {
				const cwdDir = path.join(sessionsDir, cwdSlug);
				if (!fs.existsSync(cwdDir)) continue;
				const exactFile = fs.readdirSync(cwdDir).find(f => f.endsWith(`_${ps.id}.jsonl`));
				if (exactFile) {
					const recovered = path.join(cwdDir, exactFile).replace(/\\/g, "/");
					trustPersistedAgentSessionFile(recovered);
					return recovered;
				}
			}

			for (const sessionsDir of sessionRoots) {
				const cwdDir = path.join(sessionsDir, cwdSlug);
				if (!fs.existsSync(cwdDir)) continue;

				const files = fs.readdirSync(cwdDir).filter(f => f.endsWith(".jsonl"));
				if (files.length === 0) continue;

				let bestFile: string | null = null;
				let bestDelta = Infinity;

				for (const file of files) {
					const tsMatch = file.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/);
					if (!tsMatch) continue;
					const isoStr = tsMatch[1]
						.replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1-$2-$3T$4:$5:$6.$7Z");
					const fileTime = new Date(isoStr).getTime();
					if (isNaN(fileTime)) continue;

					const delta = Math.abs(fileTime - ps.createdAt);
					if (delta < TOLERANCE_MS && delta < bestDelta) {
						bestDelta = delta;
						bestFile = file;
					}
				}

				if (bestFile) {
					const recovered = path.join(cwdDir, bestFile).replace(/\\/g, "/");
					trustPersistedAgentSessionFile(recovered);
					return recovered;
				}
			}
		} catch {
			// Recovery is best-effort; don't break restore flow.
		}
		return null;
	}
}
