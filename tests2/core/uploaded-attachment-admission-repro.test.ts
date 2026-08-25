import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { initAuthorSidecarDir } from "../../src/server/agent/author-sidecar.ts";
import { EventBuffer } from "../../src/server/agent/event-buffer.ts";
import { PromptQueue } from "../../src/server/agent/prompt-queue.ts";
import { SessionManager } from "../../src/server/agent/session-manager.ts";
import { initSkillSidecarDir } from "../../src/server/skills/skill-sidecar.ts";

const TYPED_TEXT = "Summarize the uploaded notes.";
const EXTRACTED_MARKER = "ATTACHMENT_EXTRACTED_MARKER_837496";
const ATTACHMENT_BYTES = Buffer.from(`${EXTRACTED_MARKER}\nsecond line`, "utf8");
const ATTACHMENT = {
	id: "browser-file-id-must-not-be-the-pointer",
	type: "document",
	fileName: "notes.txt",
	mimeType: "text/plain",
	size: ATTACHMENT_BYTES.byteLength,
	content: ATTACHMENT_BYTES.toString("base64"),
	extractedText: ATTACHMENT_BYTES.toString("utf8"),
};
const STABLE_POINTER = /\b(?:uploaded-)?attachment:(?:\/\/)?[A-Za-z0-9][A-Za-z0-9._~!$&'()*+,;=:@%/?#-]*/i;

let stateDir = "";
let manager: any;
let prompt: ReturnType<typeof vi.fn>;
let session: any;

function visibleText(message: any): string {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((block: any) => block?.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text)
		.join("");
}

beforeAll(() => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "uploaded-attachment-admission-repro-"));
	initAuthorSidecarDir(stateDir, {
		secretsDir: path.join(stateDir, "private-secrets"),
		hmacKey: Buffer.alloc(32, 0x41),
	});
	initSkillSidecarDir(stateDir);

	manager = new SessionManager({ skipTitleGeneration: true });
	clearInterval(manager._statusHeartbeatTimer);
	manager._statusHeartbeatTimer = null;
	prompt = vi.fn(async () => ({ success: true }));
	session = {
		id: "uploaded-attachment-admission-session",
		title: "Attachment admission",
		titleGenerated: true,
		cwd: process.cwd(),
		status: "idle",
		statusVersion: 0,
		createdAt: Date.now(),
		lastActivity: Date.now(),
		clients: new Set(),
		promptQueue: new PromptQueue(),
		eventBuffer: new EventBuffer(),
		rpcClient: {
			prompt,
			steer: vi.fn(async () => ({ success: true })),
			abort: vi.fn(async () => ({ success: true })),
			getState: vi.fn(async () => ({ success: true, data: {} })),
			onEvent: vi.fn(() => () => {}),
		},
	};
	manager.sessions.set(session.id, session);
});

afterAll(() => {
	manager?.sessions.clear();
	fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("uploaded attachment prompt admission", () => {
	it("adds extracted document text and a stable attachment pointer only to model-facing dispatch", async () => {
		await manager.enqueuePrompt(session.id, TYPED_TEXT, { attachments: [ATTACHMENT] });

		expect(prompt, "ATTACHMENT_MODEL_DISPATCH_MISSING: SessionManager did not dispatch the accepted prompt").toHaveBeenCalledTimes(1);
		const modelText = prompt.mock.calls[0][0] as string;
		expect(
			modelText,
			"ATTACHMENT_MODEL_EXCERPT_MISSING: SessionManager model-facing dispatch omitted the uploaded .txt extracted marker",
		).toContain(EXTRACTED_MARKER);
		expect(
			modelText.match(STABLE_POINTER)?.[0],
			"ATTACHMENT_STABLE_POINTER_MISSING: SessionManager model-facing dispatch omitted a stable attachment pointer",
		).toBeTruthy();

		const projected = manager.buildVisibleMessageSnapshot(session.id, [
			{ role: "user", content: [{ type: "text", text: modelText }] },
		]) as any[];
		expect(
			visibleText(projected[0]),
			"ATTACHMENT_VISIBLE_TEXT_LEAK: outward transcript projection must retain only the user's original typed text",
		).toBe(TYPED_TEXT);
	});
});
