import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { initialState, reduce } from "../../../src/app/message-reducer.ts";
import { initAuthorSidecarDir, readAuthorSidecar } from "../../../src/server/agent/author-sidecar.ts";
import {
	MAX_PROMPT_ATTACHMENT_BYTES,
	validateUploadedPromptAttachments,
} from "../../../src/server/agent/attachment-display.ts";
import { EventBuffer } from "../../../src/server/agent/event-buffer.ts";
import { PromptQueue } from "../../../src/server/agent/prompt-queue.ts";
import {
	emitSessionEvent,
	prepareVisibleAgentEvent,
	projectPromptAuthorMessagesForTitle,
	restorePromptAuthorBindings,
	SessionManager,
} from "../../../src/server/agent/session-manager.ts";
import {
	setUploadedAttachmentRootForTesting,
	setUploadedAttachmentSessionQuotaForTesting,
} from "../../../src/server/agent/uploaded-attachment-store.ts";
import {
	appendSkillSidecarEntry,
	appendSkillSidecarTranscriptBinding,
	initSkillSidecarDir,
	readSkillSidecarEntries,
} from "../../../src/server/skills/skill-sidecar.ts";
import { LOCAL_USER_AUTHOR } from "../../../src/shared/message-author.ts";

const SESSION_ID = "83749600-0000-4000-8000-000000000001";
const TYPED_TEXT = "Summarize the uploaded notes.";
const EXTRACTED_MARKER = "ATTACHMENT_EXTRACTED_MARKER_837496";
let ATTACHMENT: {
	id: string;
	type: "document";
	fileName: string;
	mimeType: string;
	size: number;
	content: string;
	extractedText: string;
};
const BINARY_BYTES = Buffer.from([0, 1, 2, 0xff]);
const BINARY_ATTACHMENT = {
	id: "browser-binary-id",
	type: "document",
	fileName: "payload.unknown-extension",
	mimeType: "application/octet-stream",
	size: BINARY_BYTES.byteLength,
	content: BINARY_BYTES.toString("base64"),
	extractedText: "FORGED_BINARY_EXCERPT_MUST_NOT_REACH_MODEL",
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

beforeAll(async () => {
	const zip = new JSZip();
	zip.file(
		"ppt/slides/slide1.xml",
		`<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:t>${EXTRACTED_MARKER}</a:t><a:t>second line</a:t></p:sld>`,
	);
	const attachmentBytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
	ATTACHMENT = {
		id: "browser-file-id-must-not-be-the-pointer",
		type: "document",
		fileName: "notes.pptx",
		mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		size: attachmentBytes.byteLength,
		content: attachmentBytes.toString("base64"),
		extractedText: "FORGED_TEXT_EXCERPT_MUST_NOT_REACH_MODEL",
	};

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

describe("uploaded image validation", () => {
	const imageData = Buffer.from("image").toString("base64");
	const image = { type: "image", data: imageData, mimeType: "image/png" };
	const presentation = {
		id: "image-one",
		type: "image",
		fileName: "one.png",
		mimeType: "image/png",
		size: 5,
		content: imageData,
		preview: imageData,
	};

	it("accepts canonical image-only and server-mention inputs while pairing browser presentation once", () => {
		expect(validateUploadedPromptAttachments([image], undefined)).toEqual({ images: [image], documents: [] });
		expect(validateUploadedPromptAttachments([image], [presentation])).toEqual({
			images: [image],
			attachments: [{
				id: "image-one", type: "image", fileName: "one.png", mimeType: "image/png", size: 5,
			}],
			documents: [],
		});
	});

	it("rejects non-arrays, non-canonical bytes, unsafe MIME, and presentation mismatch", () => {
		expect(validateUploadedPromptAttachments({ 0: image }, undefined)).toBeUndefined();
		expect(validateUploadedPromptAttachments([image], "not-an-array")).toBeUndefined();
		expect(validateUploadedPromptAttachments([{ ...image, data: "AB==" }], undefined)).toBeUndefined();
		expect(validateUploadedPromptAttachments([{ ...image, mimeType: "image/png; charset=utf-8" }], undefined)).toBeUndefined();
		expect(validateUploadedPromptAttachments([image], [{ ...presentation, size: 4 }])).toBeUndefined();
		expect(validateUploadedPromptAttachments([image], [{ ...presentation, content: "AAAA" }])).toBeUndefined();
	});

	it("enforces actual decoded size and the combined distinct-file count", () => {
		const oversized = Buffer.alloc(MAX_PROMPT_ATTACHMENT_BYTES + 1, 0x41).toString("base64");
		expect(validateUploadedPromptAttachments([
			{ type: "image", data: oversized, mimeType: "image/png" },
		], undefined)).toBeUndefined();

		const images = Array.from({ length: 9 }, () => image);
		const documents = [0, 1].map((index) => ({
			id: `doc-${index}`,
			type: "document",
			fileName: `${index}.bin`,
			mimeType: "application/octet-stream",
			size: 1,
			content: "AA==",
		}));
		expect(validateUploadedPromptAttachments(images, documents)).toBeUndefined();
	});
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
		expect(modelText).not.toContain(ATTACHMENT.extractedText);
		const pointer = modelText.match(STABLE_POINTER)?.[0];
		expect(pointer, "ATTACHMENT_STABLE_POINTER_MISSING").toBeTruthy();
		expect(modelText).not.toContain(ATTACHMENT.content);
		expect(readSkillSidecarEntries(session.id).find((entry) => entry.intentId === "text-occurrence"))
			.toMatchObject({ originalText: TYPED_TEXT, modelText });

		const pendingEnvelopeCount = session.pendingSkillExpansions.length;
		const rawStart = {
			type: "message_start",
			message: { id: "pi-live-text-occurrence", role: "user", content: [{ type: "text", text: modelText }] },
		};
		const preparedStart = prepareVisibleAgentEvent(session, rawStart);
		const startEntry = emitSessionEvent(session, preparedStart);
		const visibleStart = startEntry.event as any;
		expect(visibleText(visibleStart.message), "ATTACHMENT_LIVE_START_TEXT_LEAK").toBe(TYPED_TEXT);
		expect(visibleStart.message).toMatchObject({
			role: "user-with-attachments",
			deliveryIntentId: "text-occurrence",
			attachments: [{ id: ATTACHMENT.id, fileName: ATTACHMENT.fileName }],
		});
		expect(JSON.stringify(visibleStart)).not.toContain(pointer);
		expect(JSON.stringify(visibleStart)).not.toContain(EXTRACTED_MARKER);
		expect(session.pendingSkillExpansions).toHaveLength(pendingEnvelopeCount);
		expect(rawStart.message.content[0].text, "outward projection must not mutate Pi's event").toBe(modelText);

		let clientState = reduce(initialState(), {
			type: "live-event",
			frame: visibleStart,
			seq: startEntry.seq,
		});
		expect(clientState.messages).toHaveLength(1);
		expect(visibleText(clientState.messages[0]), "ATTACHMENT_CLIENT_START_TEXT_LEAK").toBe(TYPED_TEXT);
		expect((clientState.messages[0] as any).attachments?.[0]?.fileName).toBe(ATTACHMENT.fileName);

		// Pi currently emits user starts/ends, but keep a keyed cumulative update
		// safe if a future adapter adds one after the occurrence-bound start.
		const preparedUpdate = prepareVisibleAgentEvent(session, {
			type: "message_update",
			message: { id: "pi-live-text-occurrence", role: "user", content: [{ type: "text", text: modelText }] },
		});
		const visibleUpdate = emitSessionEvent(session, preparedUpdate).event as any;
		expect(visibleText(visibleUpdate.message), "ATTACHMENT_LIVE_UPDATE_TEXT_LEAK").toBe(TYPED_TEXT);
		expect(visibleUpdate.message.attachments?.[0]?.fileName).toBe(ATTACHMENT.fileName);
		expect(session.pendingSkillExpansions).toHaveLength(pendingEnvelopeCount);

		const rawEnd = {
			type: "message_end",
			message: { id: "pi-live-text-occurrence", role: "user", content: [{ type: "text", text: modelText }] },
		};
		const preparedEnd = prepareVisibleAgentEvent(session, rawEnd);
		const endEntry = emitSessionEvent(session, preparedEnd);
		const visibleEnd = endEntry.event as any;
		expect(visibleText(visibleEnd.message)).toBe(TYPED_TEXT);
		expect(visibleEnd.message.attachments?.[0]?.fileName).toBe(ATTACHMENT.fileName);
		expect(session.pendingSkillExpansions).toHaveLength(pendingEnvelopeCount - 1);
		expect(rawEnd.message.content[0].text, "terminal projection must not mutate Pi's event").toBe(modelText);

		clientState = reduce(clientState, {
			type: "live-event",
			frame: visibleEnd,
			seq: endEntry.seq,
		});
		expect(clientState.messages).toHaveLength(1);
		expect(visibleText(clientState.messages[0])).toBe(TYPED_TEXT);
		expect((clientState.messages[0] as any).attachments?.[0]?.fileName).toBe(ATTACHMENT.fileName);

		const raw = [{ id: "pi-live-text-occurrence", role: "user", content: [{ type: "text", text: modelText }] }];
		const projected = manager.buildVisibleMessageSnapshot(session.id, raw) as any[];
		expect(visibleText(projected[0]), "ATTACHMENT_VISIBLE_TEXT_LEAK").toBe(TYPED_TEXT);
		expect(projected[0]).toMatchObject({
			role: "user-with-attachments",
			attachments: [{ id: ATTACHMENT.id, fileName: ATTACHMENT.fileName }],
		});

		const titleProjection = projectPromptAuthorMessagesForTitle(session.id, raw) as any[];
		expect(visibleText(titleProjection[0]), "ATTACHMENT_TITLE_TEXT_LEAK").toBe(TYPED_TEXT);
	});

	it("projects identical model text by occurrence without consuming starts", () => {
		const modelText = `${TYPED_TEXT}\n\n[Uploaded attachment]\nPointer: bobbit-attachment:v1:same:model`;
		const metadata = (id: string, fileName: string) => ({
			id,
			type: "document" as const,
			fileName,
			mimeType: "application/octet-stream",
			size: 4,
		});
		const occurrence = (id: string, epoch: number) => ({
			promptId: id,
			intentId: id,
			attemptId: `attempt:${id}`,
			dispatchEpoch: epoch,
			dispatchedAt: epoch,
			modelText,
			source: "user" as const,
			author: LOCAL_USER_AUTHOR,
		});
		const sameTextSession: any = {
			...session,
			id: "83749600-0000-4000-8000-000000000008",
			clients: new Set(),
			eventBuffer: new EventBuffer(),
			pendingSkillTranscriptBindings: undefined,
			promptAuthorMessageBindings: undefined,
			promptAuthorReplayBindings: undefined,
			promptAuthorAmbiguityFences: undefined,
			lastKeylessPromptAuthorEnd: undefined,
			pendingPromptAuthors: [occurrence("same-a", 1), occurrence("same-b", 2)],
			inFlightSteerTexts: [
				{ ...occurrence("same-a", 1), text: modelText, state: "dispatching" },
				{ ...occurrence("same-b", 2), text: modelText, state: "dispatching" },
			],
			// Deliberately reverse the envelopes: text FIFO would give occurrence A
			// the wrong attachment, while the trusted author binding selects by ID.
			pendingSkillExpansions: [
				{
					recordId: "display-same-b",
					promptId: "same-b",
					modelText,
					originalText: TYPED_TEXT,
					skillExpansions: [],
					attachments: [metadata("attachment-b", "second.bin")],
				},
				{
					recordId: "display-same-a",
					promptId: "same-a",
					modelText,
					originalText: TYPED_TEXT,
					skillExpansions: [],
					attachments: [metadata("attachment-a", "first.bin")],
				},
			],
		};

		const project = (type: "message_start" | "message_end", id: string) => {
			const prepared = prepareVisibleAgentEvent(sameTextSession, {
				type,
				message: { id: `pi-${id}`, role: "user", content: [{ type: "text", text: modelText }] },
			});
			return emitSessionEvent(sameTextSession, prepared);
		};

		const startA = project("message_start", "same-a");
		expect((startA.event as any).message.attachments[0].fileName).toBe("first.bin");
		expect(sameTextSession.pendingSkillExpansions).toHaveLength(2);
		sameTextSession.inFlightSteerTexts[0].state = "received";
		const startB = project("message_start", "same-b");
		expect((startB.event as any).message.attachments[0].fileName).toBe("second.bin");
		expect(sameTextSession.pendingSkillExpansions).toHaveLength(2);

		let clientState = initialState();
		for (const entry of [startA, startB]) {
			clientState = reduce(clientState, { type: "live-event", frame: entry.event, seq: entry.seq });
		}
		expect(clientState.messages.map((message: any) => message.deliveryIntentId)).toEqual(["same-a", "same-b"]);
		expect(clientState.messages.map((message: any) => message.attachments[0].fileName)).toEqual(["first.bin", "second.bin"]);
		expect(clientState.messages.map(visibleText)).toEqual([TYPED_TEXT, TYPED_TEXT]);

		const endA = project("message_end", "same-a");
		expect(sameTextSession.pendingSkillExpansions.map((entry: any) => entry.promptId)).toEqual(["same-b"]);
		const endB = project("message_end", "same-b");
		expect(sameTextSession.pendingSkillExpansions).toEqual([]);
		for (const entry of [endA, endB]) {
			clientState = reduce(clientState, { type: "live-event", frame: entry.event, seq: entry.seq });
		}
		expect(clientState.messages.map((message: any) => message.deliveryIntentId)).toEqual(["same-a", "same-b"]);
		expect(clientState.messages.map((message: any) => message.attachments[0].fileName)).toEqual(["first.bin", "second.bin"]);
	});

	it.each([
		{
			kind: "image",
			modelText: "Attachments:",
			attachmentA: { id: "rejected-image", type: "image" as const, fileName: "rejected.png", mimeType: "image/png", size: 14 },
			attachmentB: { id: "accepted-image", type: "image" as const, fileName: "accepted.png", mimeType: "image/png", size: 14 },
			content: (modelText: string) => [
				{ type: "text", text: modelText },
				{ type: "image", data: Buffer.from("accepted-image").toString("base64"), mimeType: "image/png" },
			],
		},
		{
			kind: "document",
			modelText: `${TYPED_TEXT}\n\n[Uploaded attachment]\nPointer: bobbit-attachment:v1:recovery:same`,
			attachmentA: { id: "rejected-document", type: "document" as const, fileName: "rejected.bin", mimeType: "application/octet-stream", size: 4 },
			attachmentB: { id: "accepted-document", type: "document" as const, fileName: "accepted.bin", mimeType: "application/octet-stream", size: 4 },
			content: (modelText: string) => [{ type: "text", text: modelText }],
		},
	])("restores only the non-cancelled same-text $kind occurrence before replay", ({ kind, modelText, attachmentA, attachmentB, content }) => {
		const recoveredId = `83749600-0000-4000-8000-recovery-${kind}`;
		const rejectedId = `recovery-${kind}-rejected`;
		const acceptedId = `recovery-${kind}-accepted`;
		for (const entry of [
			{
				schemaVersion: 1 as const,
				recordId: `skill:v1:${rejectedId}`,
				intentId: rejectedId,
				ts: 1,
				modelText,
				originalText: TYPED_TEXT,
				skillExpansions: [],
				attachments: [attachmentA],
			},
			{
				schemaVersion: 1 as const,
				recordId: `skill:v1:${acceptedId}`,
				intentId: acceptedId,
				ts: 2,
				modelText,
				originalText: TYPED_TEXT,
				skillExpansions: [],
				attachments: [attachmentB],
			},
		]) expect(appendSkillSidecarEntry(recoveredId, entry)).toBe(true);
		const authorEntries: any[] = [
			{
				schemaVersion: 1, type: "prompt-author", promptId: rejectedId, intentId: rejectedId,
				attemptId: `attempt:${rejectedId}`, dispatchEpoch: 1, dispatchedAt: 1,
				modelText, source: "user", author: LOCAL_USER_AUTHOR,
				settlement: {
					schemaVersion: 1, type: "prompt-author-settlement", promptId: rejectedId,
					intentId: rejectedId, attemptId: `attempt:${rejectedId}`, settledAt: 2, outcome: "cancelled",
				},
			},
			{
				schemaVersion: 1, type: "prompt-author", promptId: acceptedId, intentId: acceptedId,
				attemptId: `attempt:${acceptedId}`, dispatchEpoch: 3, dispatchedAt: 3,
				modelText, source: "user", author: LOCAL_USER_AUTHOR,
			},
		];
		const recovered: any = {
			id: recoveredId,
			clients: new Set(),
			eventBuffer: new EventBuffer(),
			promptQueue: new PromptQueue(),
		};

		restorePromptAuthorBindings(recovered, authorEntries);
		expect(recovered.pendingSkillExpansions).toEqual([
			expect.objectContaining({ intentId: acceptedId, promptId: acceptedId }),
		]);
		expect(JSON.stringify(recovered.pendingSkillExpansions)).not.toContain(attachmentA.fileName);

		const rawMessage = { id: `pi-${kind}-accepted`, role: "user", content: content(modelText) };
		const project = (type: "message_start" | "message_update" | "message_end") => {
			const prepared = prepareVisibleAgentEvent(recovered, { type, message: rawMessage });
			return emitSessionEvent(recovered, prepared).event as any;
		};
		for (const type of ["message_start", "message_update"] as const) {
			const visible = project(type);
			expect(visibleText(visible.message)).toBe(TYPED_TEXT);
			expect(visible.message.deliveryIntentId).toBe(acceptedId);
			expect(visible.message.attachments).toEqual([
				expect.objectContaining({ id: attachmentB.id, fileName: attachmentB.fileName }),
			]);
			expect(JSON.stringify(visible)).not.toContain(attachmentA.fileName);
			if (kind === "document") expect(JSON.stringify(visible)).not.toContain("bobbit-attachment:v1:recovery:same");
		}
		const terminal = project("message_end");
		expect(visibleText(terminal.message)).toBe(TYPED_TEXT);
		expect(terminal.message.attachments[0].fileName).toBe(attachmentB.fileName);
		expect(recovered.pendingSkillExpansions).toEqual([]);
	});

	it("keeps binary content pointer-only and isolates equal typed occurrences through queue projection", async () => {
		const delivery = await manager.enqueuePrompt(session.id, TYPED_TEXT, {
			attachments: [BINARY_ATTACHMENT],
			intentId: "binary-occurrence",
		});
		expect(delivery.status).toBe("queued");

		const [internal] = session.promptQueue.toArray().filter((row: any) => row.id === "binary-occurrence");
		expect(internal.text).toMatch(STABLE_POINTER);
		expect(internal.text).toContain("Binary content is not embedded in the prompt");
		expect(internal.text).not.toContain(BINARY_ATTACHMENT.content);
		expect(internal.text).not.toContain(BINARY_ATTACHMENT.extractedText);
		expect(internal.displayText).toBe(TYPED_TEXT);

		const [queued] = manager.projectDeliveryOutbox(session.id).filter((row: any) => row.id === "binary-occurrence");
		expect(queued.text).toBe(TYPED_TEXT);
		expect(queued).not.toHaveProperty("displayText");
		expect(queued.attachments).toEqual([{
			id: BINARY_ATTACHMENT.id,
			type: "document",
			fileName: BINARY_ATTACHMENT.fileName,
			mimeType: BINARY_ATTACHMENT.mimeType,
			size: BINARY_ATTACHMENT.size,
		}]);

		const persistedQueue = JSON.parse(JSON.stringify(session.promptQueue.toArray()));
		session.promptQueue = new PromptQueue(persistedQueue);
		expect(manager.projectDeliveryOutbox(session.id).find((row: any) => row.id === "binary-occurrence"))
			.toMatchObject({ text: TYPED_TEXT });

		const firstModelText = prompt.mock.calls[0][0] as string;
		// The synthetic raw snapshot below represents Pi having persisted the first
		// prompt, so clear the fixture's unacknowledged direct-dispatch recovery row.
		session.inFlightSteerTexts = [];
		const visible = manager.buildVisibleMessageSnapshot(session.id, [
			{ role: "user", deliveryIntentId: "text-occurrence", content: firstModelText },
			{ role: "user", content: internal.text },
		]) as any[];
		expect(visible.map(visibleText)).toEqual([TYPED_TEXT, internal.text]);
		expect(visible[0].attachments[0].fileName).toBe(ATTACHMENT.fileName);
		expect(visible[1].attachments).toBeUndefined();
		expect(firstModelText.match(STABLE_POINTER)?.[0]).not.toBe(internal.text.match(STABLE_POINTER)?.[0]);
	});

	it("uses occurrence display text for queued title generation while dispatch retains model context", async () => {
		const queuedManager: any = new SessionManager({ skipTitleGeneration: true });
		clearInterval(queuedManager._statusHeartbeatTimer);
		queuedManager._statusHeartbeatTimer = null;
		const queuedPrompt = vi.fn(async (_text: string) => ({ success: true }));
		const queuedSession: any = {
			...session,
			id: "83749600-0000-4000-8000-000000000002",
			title: "Queued attachment admission",
			titleGenerated: false,
			status: "streaming",
			clients: new Set(),
			promptQueue: new PromptQueue(),
			eventBuffer: new EventBuffer(),
			pendingSkillExpansions: undefined,
			pendingSkillTranscriptBindings: undefined,
			pendingPromptAuthors: undefined,
			promptAuthorMessageBindings: undefined,
			promptAuthorReplayBindings: undefined,
			promptAuthorAmbiguityFences: undefined,
			inFlightSteerTexts: undefined,
			lastPromptDisplay: undefined,
			rpcClient: { ...session.rpcClient, prompt: queuedPrompt },
		};
		queuedManager.sessions.set(queuedSession.id, queuedSession);
		const titleGeneration = vi.spyOn(queuedManager, "tryGenerateTitleFromPrompt").mockImplementation(() => {});
		try {
			const delivery = await queuedManager.enqueuePrompt(queuedSession.id, TYPED_TEXT, {
				attachments: [ATTACHMENT],
				intentId: "queued-title-occurrence",
			});
			expect(delivery.status).toBe("queued");

			const [internal] = queuedSession.promptQueue.toArray();
			expect(internal.text).toMatch(STABLE_POINTER);
			expect(internal.displayText).toBe(TYPED_TEXT);
			expect(queuedManager.projectDeliveryOutbox(queuedSession.id)).toEqual([
				expect.objectContaining({ id: internal.id, text: TYPED_TEXT }),
			]);
			expect(queuedManager.projectDeliveryOutbox(queuedSession.id)[0]).not.toHaveProperty("displayText");

			queuedSession.promptQueue = new PromptQueue(JSON.parse(JSON.stringify(queuedSession.promptQueue.toArray())));
			queuedSession.status = "idle";
			queuedSession._piAgentRunSettled = true;
			queuedManager.drainQueue(queuedSession);
			await vi.waitFor(() => expect(queuedPrompt).toHaveBeenCalledTimes(1));

			expect(titleGeneration).toHaveBeenCalledWith(queuedSession.id, TYPED_TEXT);
			const dispatchedText = queuedPrompt.mock.calls[0][0] as string;
			expect(dispatchedText).toMatch(STABLE_POINTER);
			expect(dispatchedText).toContain(EXTRACTED_MARKER);
			queuedSession.inFlightSteerTexts = JSON.parse(JSON.stringify(queuedSession.inFlightSteerTexts));
			expect(queuedManager.projectDeliveryOutbox(queuedSession.id)).toEqual([
				expect.objectContaining({ id: internal.id, text: TYPED_TEXT, deliveryState: "dispatching" }),
			]);
			expect(queuedManager.projectDeliveryOutbox(queuedSession.id)[0]).not.toHaveProperty("displayText");
		} finally {
			queuedManager.sessions.clear();
		}
	});

	it("keeps ordinary restored attachment rows outward-only while titles use typed text", async () => {
		const ordinaryManager: any = new SessionManager({ skipTitleGeneration: true });
		clearInterval(ordinaryManager._statusHeartbeatTimer);
		ordinaryManager._statusHeartbeatTimer = null;
		const modelText = `${TYPED_TEXT}\n\n[Uploaded attachment]\nPointer: bobbit-attachment:v1:ordinary:restored`;
		const ordinaryPrompt = vi.fn(async (_text: string) => ({ success: true }));
		const ordinarySession: any = {
			...session,
			id: "83749600-0000-4000-8000-000000000004",
			titleGenerated: false,
			status: "idle",
			clients: new Set(),
			promptQueue: new PromptQueue([{
				id: "ordinary-restored-attachment",
				text: modelText,
				displayText: TYPED_TEXT,
				attachments: [{ id: ATTACHMENT.id, type: "document", fileName: ATTACHMENT.fileName, mimeType: ATTACHMENT.mimeType, size: ATTACHMENT.size }],
				isSteered: false,
				createdAt: Date.now(),
			}]),
			eventBuffer: new EventBuffer(),
			inFlightSteerTexts: undefined,
			rpcClient: { ...session.rpcClient, prompt: ordinaryPrompt },
		};
		ordinaryManager.sessions.set(ordinarySession.id, ordinarySession);
		const titleGeneration = vi.spyOn(ordinaryManager, "tryGenerateTitleFromPrompt").mockImplementation(() => {});
		try {
			const [projected] = ordinaryManager.projectDeliveryOutbox(ordinarySession.id);
			expect(projected.text).toBe(TYPED_TEXT);
			expect(projected).not.toHaveProperty("displayText");

			ordinaryManager.drainQueue(ordinarySession);
			await vi.waitFor(() => expect(ordinaryPrompt).toHaveBeenCalledTimes(1));
			expect(titleGeneration).toHaveBeenCalledWith(ordinarySession.id, TYPED_TEXT);
			expect(ordinaryPrompt).toHaveBeenCalledWith(modelText, undefined);
		} finally {
			ordinaryManager.sessions.clear();
		}
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

	it("rejects malformed image admission with zero queue, sidecar, event, store, or RPC effects", async () => {
		const imageManager: any = new SessionManager({ skipTitleGeneration: true });
		clearInterval(imageManager._statusHeartbeatTimer);
		imageManager._statusHeartbeatTimer = null;
		const imagePrompt = vi.fn(async () => ({ success: true }));
		const imageSession: any = {
			...session,
			id: "83749600-0000-4000-8000-000000000007",
			status: "idle",
			clients: new Set(),
			promptQueue: new PromptQueue(),
			eventBuffer: new EventBuffer(),
			pendingSkillExpansions: undefined,
			pendingSkillTranscriptBindings: undefined,
			pendingPromptAuthors: undefined,
			promptAuthorMessageBindings: undefined,
			promptAuthorReplayBindings: undefined,
			promptAuthorAmbiguityFences: undefined,
			inFlightSteerTexts: undefined,
			lastPromptDisplay: undefined,
			rpcClient: { ...session.rpcClient, prompt: imagePrompt },
		};
		imageManager.sessions.set(imageSession.id, imageSession);
		const storeBefore = fs.readdirSync(path.join(stateDir, "uploaded-attachments"), { recursive: true });
		const validImage = { type: "image", data: "AAAA", mimeType: "image/png" };
		try {
			for (const opts of [
				{ images: { nope: true } },
				{ attachments: { nope: true } },
				{ images: [{ ...validImage, data: "AB==" }] },
				{ images: Array.from({ length: 11 }, () => validImage) },
			] as any[]) {
				await expect(imageManager.enqueuePrompt(imageSession.id, "reject", opts))
					.rejects.toMatchObject({ code: "UPLOADED_ATTACHMENT_INVALID", retryable: false });
				expect(imagePrompt).not.toHaveBeenCalled();
				expect(imageSession.promptQueue.toArray()).toEqual([]);
				expect(imageSession.pendingSkillExpansions).toBeUndefined();
				expect(imageSession.inFlightSteerTexts).toBeUndefined();
				expect(imageSession.eventBuffer.getAll()).toEqual([]);
				expect(readSkillSidecarEntries(imageSession.id)).toEqual([]);
				expect(readAuthorSidecar(imageSession.id)).toEqual([]);
				expect(fs.readdirSync(path.join(stateDir, "uploaded-attachments"), { recursive: true })).toEqual(storeBefore);
			}

			await expect(imageManager.enqueuePrompt(imageSession.id, "", { images: [validImage] }))
				.resolves.toEqual({ status: "dispatched" });
			expect(imagePrompt).toHaveBeenCalledWith("Attachments:", [validImage]);
		} finally {
			imageManager.sessions.clear();
		}
	});

	it("rejects session quota overflow before bridge, outbox, or sidecar admission", async () => {
		const quotaSessionId = "83749600-0000-4000-8000-000000000005";
		const quotaManager: any = new SessionManager({ skipTitleGeneration: true });
		clearInterval(quotaManager._statusHeartbeatTimer);
		quotaManager._statusHeartbeatTimer = null;
		const quotaPrompt = vi.fn(async () => ({ success: true }));
		const quotaSteer = vi.fn(async () => ({ success: true }));
		const quotaSession: any = {
			...session,
			id: quotaSessionId,
			title: "Attachment quota admission",
			status: "idle",
			clients: new Set(),
			promptQueue: new PromptQueue(),
			eventBuffer: new EventBuffer(),
			pendingSkillExpansions: undefined,
			pendingSkillTranscriptBindings: undefined,
			pendingPromptAuthors: undefined,
			promptAuthorMessageBindings: undefined,
			promptAuthorReplayBindings: undefined,
			promptAuthorAmbiguityFences: undefined,
			inFlightSteerTexts: undefined,
			lastPromptDisplay: undefined,
			rpcClient: { ...session.rpcClient, prompt: quotaPrompt, steer: quotaSteer },
		};
		quotaManager.sessions.set(quotaSessionId, quotaSession);
		const beforeStoreEntries = fs.readdirSync(path.join(stateDir, "uploaded-attachments"), { recursive: true });
		setUploadedAttachmentSessionQuotaForTesting(0);
		try {
			await expect(quotaManager.enqueuePrompt(quotaSessionId, "over quota", {
				intentId: "quota-overflow-occurrence",
				attachments: [ATTACHMENT],
			})).rejects.toMatchObject({
				statusCode: 413,
				code: "UPLOADED_ATTACHMENT_QUOTA_EXCEEDED",
				retryable: false,
			});
			expect(quotaPrompt).not.toHaveBeenCalled();
			expect(quotaSteer).not.toHaveBeenCalled();
			expect(quotaSession.promptQueue.toArray()).toEqual([]);
			expect(quotaManager.projectDeliveryOutbox(quotaSessionId)).toEqual([]);
			expect(quotaSession.pendingSkillExpansions).toBeUndefined();
			expect(quotaSession.inFlightSteerTexts).toBeUndefined();
			expect(readSkillSidecarEntries(quotaSessionId)).toEqual([]);
			expect(readAuthorSidecar(quotaSessionId)).toEqual([]);
			expect(fs.readdirSync(path.join(stateDir, "uploaded-attachments"), { recursive: true })).toEqual(beforeStoreEntries);
		} finally {
			setUploadedAttachmentSessionQuotaForTesting(undefined);
			quotaManager.sessions.clear();
		}
	});

	it("charges document previews before any admission side effect", async () => {
		const previewSessionId = "83749600-0000-4000-8000-000000000006";
		const previewManager: any = new SessionManager({ skipTitleGeneration: true });
		clearInterval(previewManager._statusHeartbeatTimer);
		previewManager._statusHeartbeatTimer = null;
		const previewPrompt = vi.fn(async () => ({ success: true }));
		const previewSteer = vi.fn(async () => ({ success: true }));
		const previewSession: any = {
			...session,
			id: previewSessionId,
			title: "Attachment preview quota admission",
			status: "idle",
			clients: new Set(),
			promptQueue: new PromptQueue(),
			eventBuffer: new EventBuffer(),
			pendingSkillExpansions: undefined,
			pendingSkillTranscriptBindings: undefined,
			pendingPromptAuthors: undefined,
			promptAuthorMessageBindings: undefined,
			promptAuthorReplayBindings: undefined,
			promptAuthorAmbiguityFences: undefined,
			inFlightSteerTexts: undefined,
			lastPromptDisplay: undefined,
			rpcClient: { ...session.rpcClient, prompt: previewPrompt, steer: previewSteer },
		};
		previewManager.sessions.set(previewSessionId, previewSession);
		const attachment = {
			...ATTACHMENT,
			preview: Buffer.from("durable document preview").toString("base64"),
		};
		const beforeStoreEntries = fs.readdirSync(path.join(stateDir, "uploaded-attachments"), { recursive: true });
		setUploadedAttachmentSessionQuotaForTesting(ATTACHMENT.size);
		try {
			await expect(previewManager.enqueuePrompt(previewSessionId, "preview over quota", {
				intentId: "preview-quota-overflow-occurrence",
				attachments: [attachment],
			})).rejects.toMatchObject({
				statusCode: 413,
				code: "UPLOADED_ATTACHMENT_QUOTA_EXCEEDED",
				retryable: false,
			});
			expect(previewPrompt).not.toHaveBeenCalled();
			expect(previewSteer).not.toHaveBeenCalled();
			expect(previewSession.promptQueue.toArray()).toEqual([]);
			expect(previewManager.projectDeliveryOutbox(previewSessionId)).toEqual([]);
			expect(previewSession.pendingSkillExpansions).toBeUndefined();
			expect(previewSession.inFlightSteerTexts).toBeUndefined();
			expect(previewSession.eventBuffer.getAll()).toEqual([]);
			expect(previewManager.buildVisibleMessageSnapshot(previewSessionId, [])).toEqual([]);
			expect(readSkillSidecarEntries(previewSessionId)).toEqual([]);
			expect(readAuthorSidecar(previewSessionId)).toEqual([]);
			expect(fs.readdirSync(path.join(stateDir, "uploaded-attachments"), { recursive: true })).toEqual(beforeStoreEntries);
		} finally {
			setUploadedAttachmentSessionQuotaForTesting(undefined);
			previewManager.sessions.clear();
		}
	});

	it("keeps recovery and explicit retry envelopes occurrence-safe with a stable pointer", async () => {
		const recoveryManager: any = new SessionManager({ skipTitleGeneration: true });
		clearInterval(recoveryManager._statusHeartbeatTimer);
		recoveryManager._statusHeartbeatTimer = null;
		const recoveryPrompt = vi.fn(async (_text: string) => ({ success: true }));
		const recoverySession: any = {
			...session,
			id: "83749600-0000-4000-8000-000000000003",
			status: "idle",
			clients: new Set(),
			promptQueue: new PromptQueue(),
			eventBuffer: new EventBuffer(),
			pendingSkillExpansions: undefined,
			pendingSkillTranscriptBindings: undefined,
			pendingPromptAuthors: undefined,
			promptAuthorMessageBindings: undefined,
			promptAuthorReplayBindings: undefined,
			promptAuthorAmbiguityFences: undefined,
			inFlightSteerTexts: undefined,
			lastPromptDisplay: undefined,
			lastTurnErrored: true,
			lastTurnErrorMessage: "provider interrupted the previous turn",
			consecutiveErrorTurns: 1,
			turnHadToolCalls: false,
			rpcClient: { ...session.rpcClient, prompt: recoveryPrompt },
		};
		recoveryManager.sessions.set(recoverySession.id, recoverySession);
		try {
			await recoveryManager.enqueuePrompt(recoverySession.id, TYPED_TEXT, {
				attachments: [ATTACHMENT],
				intentId: "recovery-attachment-occurrence",
			});
			const recoveryModelText = recoveryPrompt.mock.calls[0][0] as string;
			const pointer = recoveryModelText.match(STABLE_POINTER)?.[0];
			expect(recoveryModelText).toContain("[SYSTEM: previous turn failed with:");
			expect(recoveryModelText).toContain(EXTRACTED_MARKER);
			expect(pointer).toBeTruthy();

			const firstEnvelope = recoverySession.pendingSkillExpansions.find((entry: any) =>
				entry.intentId === "recovery-attachment-occurrence");
			expect(firstEnvelope?.recordId).toBeTruthy();
			const firstPrepared = prepareVisibleAgentEvent(recoverySession, {
				type: "message_end",
				message: { id: "pi-recovery-occurrence", role: "user", content: recoveryModelText },
			});
			const firstLive = emitSessionEvent(recoverySession, firstPrepared).event as any;
			expect(visibleText(firstLive.message)).toBe(TYPED_TEXT);
			expect(firstLive.message.attachments?.[0].fileName).toBe(ATTACHMENT.fileName);
			expect(appendSkillSidecarTranscriptBinding(
				recoverySession.id, firstEnvelope.recordId, "pi-recovery-occurrence",
			)).toBe(true);

			recoverySession.status = "idle";
			recoverySession.lastTurnErrored = true;
			recoverySession.lastTurnErrorMessage = "fresh response failed";
			recoverySession.consecutiveErrorTurns = 1;
			recoverySession.turnHadToolCalls = false;
			await recoveryManager.retryLastPrompt(recoverySession.id);

			const retryPiText = recoveryPrompt.mock.calls[1][0] as string;
			expect(retryPiText).toContain(pointer);
			expect(retryPiText).toContain(EXTRACTED_MARKER);
			const retryEnvelope = recoverySession.pendingSkillExpansions.at(-1);
			expect(retryEnvelope?.recordId).toBeTruthy();
			const retryPrepared = prepareVisibleAgentEvent(recoverySession, {
				type: "message_end",
				message: { id: "pi-explicit-retry-occurrence", role: "user", content: retryPiText },
			});
			const retryLive = emitSessionEvent(recoverySession, retryPrepared).event as any;
			expect(visibleText(retryLive.message)).toBe(TYPED_TEXT);
			expect(retryLive.message.attachments?.[0].fileName).toBe(ATTACHMENT.fileName);
			expect(appendSkillSidecarTranscriptBinding(
				recoverySession.id, retryEnvelope.recordId, "pi-explicit-retry-occurrence",
			)).toBe(true);

			recoverySession.status = "idle";
			recoverySession.lastTurnErrored = true;
			recoverySession.lastTurnErrorMessage = "automatic retryable failure";
			recoverySession.turnHadToolCalls = false;
			await recoveryManager.retryLastPrompt(recoverySession.id, { auto: true });
			const autoRetryPiText = recoveryPrompt.mock.calls[2][0] as string;
			expect(autoRetryPiText).toContain(pointer);
			const autoEnvelope = recoverySession.pendingSkillExpansions.at(-1);
			expect(autoEnvelope?.recordId).toBeTruthy();
			const autoPrepared = prepareVisibleAgentEvent(recoverySession, {
				type: "message_end",
				message: { id: "pi-auto-retry-occurrence", role: "user", content: autoRetryPiText },
			});
			const autoLive = emitSessionEvent(recoverySession, autoPrepared).event as any;
			expect(visibleText(autoLive.message)).toBe(TYPED_TEXT);
			expect(autoLive.message.attachments?.[0].fileName).toBe(ATTACHMENT.fileName);
			expect(appendSkillSidecarTranscriptBinding(
				recoverySession.id,
				autoEnvelope.recordId,
				"pi-auto-retry-occurrence",
			)).toBe(true);

			const raw = [
				{ id: "pi-recovery-occurrence", entryId: "pi-recovery-occurrence", role: "user", content: recoveryModelText },
				{ id: "pi-explicit-retry-occurrence", entryId: "pi-explicit-retry-occurrence", role: "user", content: retryPiText },
				{ id: "pi-auto-retry-occurrence", entryId: "pi-auto-retry-occurrence", role: "user", content: autoRetryPiText },
			];
			const restored = recoveryManager.buildVisibleMessageSnapshot(recoverySession.id, raw) as any[];
			expect(restored.map(visibleText)).toEqual([TYPED_TEXT, TYPED_TEXT, TYPED_TEXT]);
			expect(restored.map((message) => message.attachments?.[0]?.fileName)).toEqual([
				ATTACHMENT.fileName,
				ATTACHMENT.fileName,
				ATTACHMENT.fileName,
			]);
			const titled = projectPromptAuthorMessagesForTitle(recoverySession.id, raw) as any[];
			expect(titled.map(visibleText)).toEqual([TYPED_TEXT, TYPED_TEXT, TYPED_TEXT]);
		} finally {
			recoveryManager.sessions.clear();
		}
	});

	it("rejects a serialized prompt frame over the authoritative cap without side effects", async () => {
		const cappedManager: any = new SessionManager({
			skipTitleGeneration: true,
			uploadedAttachmentSerializedSendLimitBytes: 128,
		});
		clearInterval(cappedManager._statusHeartbeatTimer);
		cappedManager._statusHeartbeatTimer = null;
		const cappedPrompt = vi.fn(async () => ({ success: true }));
		const cappedSession: any = {
			...session,
			id: "83749600-0000-4000-8000-000000000002",
			status: "idle",
			clients: new Set(),
			promptQueue: new PromptQueue(),
			eventBuffer: new EventBuffer(),
			rpcClient: { ...session.rpcClient, prompt: cappedPrompt },
		};
		cappedManager.sessions.set(cappedSession.id, cappedSession);
		try {
			await expect(cappedManager.enqueuePrompt(cappedSession.id, "over cap", {
				intentId: "serialized-over-cap",
				attachments: [ATTACHMENT],
			})).rejects.toMatchObject({ code: "UPLOADED_ATTACHMENT_INVALID" });
			expect(cappedPrompt).not.toHaveBeenCalled();
			expect(cappedManager.projectDeliveryOutbox(cappedSession.id)).toEqual([]);
		} finally {
			cappedManager.sessions.clear();
		}
	});
});
