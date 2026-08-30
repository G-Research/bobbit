import fs from "node:fs";
import path from "node:path";

import { localApiFetch } from "../../../tests2/integration/helpers/session-fixtures.js";

export const FIXTURE_TIME = "2026-08-11T12:00:00.000Z";

export type TranscriptEntry = Record<string, unknown> & {
	type: string;
	id?: string;
	parentId?: string | null;
};

export type SeededTranscript = {
	file: string;
	content: string;
	header: TranscriptEntry;
	entries: TranscriptEntry[];
};

export function messageEntry(
	id: string,
	parentId: string | null,
	role: string,
	text: string,
	timestamp = FIXTURE_TIME,
): TranscriptEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role, content: [{ type: "text", text }] },
	};
}

export function seedTranscript(
	gateway: any,
	sessionId: string,
	entries: TranscriptEntry[],
	options: { lineEnding?: "\n" | "\r\n"; trailingNewline?: boolean } = {},
): SeededTranscript {
	const persisted = gateway.sessionManager.getPersistedSession(sessionId);
	const live = gateway.sessionManager.getSession(sessionId);
	if (!persisted?.projectId || !live) throw new Error(`session ${sessionId} must be live and persisted`);

	const header: TranscriptEntry = {
		type: "session",
		version: 3,
		id: `pi-${sessionId}`,
		timestamp: FIXTURE_TIME,
		cwd: live.cwd,
		provider: "fixture-provider",
	};
	const eol = options.lineEnding ?? "\n";
	const content = [header, ...entries].map(entry => JSON.stringify(entry)).join(eol)
		+ (options.trailingNewline === false ? "" : eol);
	const file = path.join(gateway.bobbitDir, "state", "session-prompts", `${sessionId}-history-fork.jsonl`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf8");
	live.agentSessionFile = file;
	gateway.sessionManager.getSessionStore(persisted.projectId).update(sessionId, { agentSessionFile: file });
	return { file, content, header, entries };
}

export function ordinaryHistory(): TranscriptEntry[] {
	return [
		messageEntry("root-user", null, "user", "retained prompt"),
		messageEntry("root-assistant", "root-user", "assistant", "retained answer"),
		messageEntry("selected-user", "root-assistant", "user", "selected prompt"),
		messageEntry("later-assistant", "selected-user", "assistant", "discarded answer"),
	];
}

export function setPersistedTranscriptPath(gateway: any, sessionId: string, file: string): void {
	const persisted = gateway.sessionManager.getPersistedSession(sessionId);
	const live = gateway.sessionManager.getSession(sessionId);
	if (!persisted?.projectId || !live) throw new Error(`session ${sessionId} must be live and persisted`);
	live.agentSessionFile = file;
	gateway.sessionManager.getSessionStore(persisted.projectId).update(sessionId, { agentSessionFile: file });
}

export async function historyFork(
	gateway: any,
	sourceId: string,
	entryId: unknown,
	newWorktree: unknown = false,
): Promise<Response> {
	return localApiFetch(gateway, `/api/sessions/${sourceId}/fork`, {
		method: "POST",
		body: JSON.stringify({ entryId, newWorktree }),
	});
}

export async function responseJson(response: Response): Promise<any> {
	return response.clone().json().catch(async () => ({ error: await response.clone().text() }));
}

export function filesystemIdentity(value: string): string {
	const canonical = fs.realpathSync.native(value);
	return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function transcriptFilesForSession(root: string, sessionId: string): string[] {
	if (!root || !fs.existsSync(root)) return [];
	const matches: string[] = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const candidate = path.join(root, entry.name);
		if (entry.isDirectory()) matches.push(...transcriptFilesForSession(candidate, sessionId));
		else if (entry.isFile() && entry.name.endsWith(`_${sessionId}.jsonl`)) matches.push(candidate);
	}
	return matches;
}
