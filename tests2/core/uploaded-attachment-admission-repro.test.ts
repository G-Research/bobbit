import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { initAuthorSidecarDir } from "../../src/server/agent/author-sidecar.ts";
import { EventBuffer } from "../../src/server/agent/event-buffer.ts";
import { PromptQueue } from "../../src/server/agent/prompt-queue.ts";
import {
	projectPromptAuthorMessagesForTitle,
	SessionManager,
} from "../../src/server/agent/session-manager.ts";
import { setUploadedAttachmentRootForTesting } from "../../src/server/agent/uploaded-attachment-store.ts";
import { initSkillSidecarDir } from "../../src/server/skills/skill-sidecar.ts";

const SESSION_ID = "83749600-0000-4000-8000-000000000001";
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
const BINARY_BYTES = Buffer.from([0, 1, 2, 0xff]);
const BINARY_ATTACHMENT = {
	id: "browser-binary-id",
	type: "document",
	fileName: "payload.unknown-extension",
	mimeType: "application/octet-stream",
	size: BINARY_BYTES.byteLength,
	content: BINARY_BYTES.toString("base64"),
};
const STABLE_POINTER = /\bbobbit-attachment:v1:[A-Za-z0-9:_-]+/;

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
	setUploadedAttachmentRootForTesting(path.join(stateDir, "uploaded-attachments"));

	manager = new SessionManager({ skipTitleGeneration: true });
	clearInterval(manager._statusHeartbeatTimer);
	manager._statusHeartbeatTimer = null;
	prompt = vi.fn(async () => ({ success: true }));
	session = {
		id: SESSION_ID,
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
	setUploadedAttachmentRootForTesting(undefined);
	fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("uploaded attachment prompt admission", () => {
	it("dispatches bounded document context while every outward projection retains typed text", async () => {
		await manager.enqueuePrompt(session.id, TYPED_TEXT, {
			attachments: [ATTACHMENT],
			intentId: "text-occurrence",
		});

		expect(prompt, "ATTACHMENT_MODEL_DISPATCH_MISSING: accepted prompt was not dispatched").toHaveBeenCalledTimes(1);
		const modelText = prompt.mock.calls[0][0] as string;
		expect(modelText, "ATTACHMENT_MODEL_EXCERPT_MISSING").toContain(EXTRACTED_MARKER);
		const pointer = modelText.match(STABLE_POINTER)?.[0];
		expect(pointer, "ATTACHMENT_STABLE_POINTER_MISSING").toBeTruthy();
		expect(modelText).not.toContain(ATTACHMENT.content);

		const raw = [{ role: "user", content: [{ type: "text", text: modelText }] }];
		const projected = manager.buildVisibleMessageSnapshot(session.id, raw) as any[];
		expect(visibleText(projected[0]), "ATTACHMENT_VISIBLE_TEXT_LEAK").toBe(TYPED_TEXT);
		expect(projected[0]).toMatchObject({
			role: "user-with-attachments",
			attachments: [{ id: ATTACHMENT.id, fileName: ATTACHMENT.fileName }],
		});

		const titleProjection = projectPromptAuthorMessagesForTitle(session.id, raw) as any[];
		expect(visibleText(titleProjection[0]), "ATTACHMENT_TITLE_TEXT_LEAK").toBe(TYPED_TEXT);
	});

	it("keeps binary content pointer-only and isolates equal typed occurrences through queue projection", async () => {
		const delivery = await manager.enqueuePrompt(session.id, TYPED_TEXT, {
			attachments: [BINARY_ATTACHMENT],
			intentId: "binary-occurrence",
		});
		expect(delivery.status).toBe("queued");

		const [queued] = manager.projectDeliveryOutbox(session.id).filter((row: any) => row.id === "binary-occurrence");
		expect(queued.text).toMatch(STABLE_POINTER);
		expect(queued.text).toContain("Binary content is not embedded in the prompt");
		expect(queued.text).not.toContain(BINARY_ATTACHMENT.content);
		expect(queued.attachments).toEqual([{
			id: BINARY_ATTACHMENT.id,
			type: "document",
			fileName: BINARY_ATTACHMENT.fileName,
			mimeType: BINARY_ATTACHMENT.mimeType,
			size: BINARY_ATTACHMENT.size,
		}]);

		const firstModelText = prompt.mock.calls[0][0] as string;
		// The synthetic raw snapshot below represents Pi having persisted the first
		// prompt, so clear the fixture's unacknowledged direct-dispatch recovery row.
		session.inFlightSteerTexts = [];
		const visible = manager.buildVisibleMessageSnapshot(session.id, [
			{ role: "user", content: firstModelText },
			{ role: "user", content: queued.text },
		]) as any[];
		expect(visible.map(visibleText)).toEqual([TYPED_TEXT, TYPED_TEXT]);
		expect(visible[0].attachments[0].fileName).toBe(ATTACHMENT.fileName);
		expect(visible[1].attachments[0].fileName).toBe(BINARY_ATTACHMENT.fileName);
		expect(firstModelText.match(STABLE_POINTER)?.[0]).not.toBe(queued.text.match(STABLE_POINTER)?.[0]);
	});

	it("rejects malformed documents before queue or model dispatch", async () => {
		const queueLength = manager.projectDeliveryOutbox(session.id).length;
		await expect(manager.enqueuePrompt(session.id, "bad", {
			intentId: "malformed-occurrence",
			attachments: [{ ...ATTACHMENT, content: "not-base64" }],
		})).rejects.toMatchObject({ code: "UPLOADED_ATTACHMENT_INVALID" });
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(manager.projectDeliveryOutbox(session.id)).toHaveLength(queueLength);
	});
});
