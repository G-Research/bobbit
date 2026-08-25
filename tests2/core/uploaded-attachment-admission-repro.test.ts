import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { initAuthorSidecarDir, readAuthorSidecar } from "../../src/server/agent/author-sidecar.ts";
import { EventBuffer } from "../../src/server/agent/event-buffer.ts";
import { PromptQueue } from "../../src/server/agent/prompt-queue.ts";
import {
	emitSessionEvent,
	prepareVisibleAgentEvent,
	projectPromptAuthorMessagesForTitle,
	SessionManager,
} from "../../src/server/agent/session-manager.ts";
import {
	setUploadedAttachmentRootForTesting,
	setUploadedAttachmentSessionQuotaForTesting,
} from "../../src/server/agent/uploaded-attachment-store.ts";
import { initSkillSidecarDir, readSkillSidecarEntries } from "../../src/server/skills/skill-sidecar.ts";

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
			{ role: "user", content: firstModelText },
			{ role: "user", content: internal.text },
		]) as any[];
		expect(visible.map(visibleText)).toEqual([TYPED_TEXT, TYPED_TEXT]);
		expect(visible[0].attachments[0].fileName).toBe(ATTACHMENT.fileName);
		expect(visible[1].attachments[0].fileName).toBe(BINARY_ATTACHMENT.fileName);
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

			const firstPrepared = prepareVisibleAgentEvent(recoverySession, {
				type: "message_end",
				message: { id: "pi-recovery-occurrence", role: "user", content: recoveryModelText },
			});
			const firstLive = emitSessionEvent(recoverySession, firstPrepared).event as any;
			expect(visibleText(firstLive.message)).toBe(TYPED_TEXT);
			expect(firstLive.message.attachments?.[0].fileName).toBe(ATTACHMENT.fileName);

			recoverySession.status = "idle";
			recoverySession.lastTurnErrored = true;
			recoverySession.lastTurnErrorMessage = "fresh response failed";
			recoverySession.consecutiveErrorTurns = 1;
			recoverySession.turnHadToolCalls = false;
			await recoveryManager.retryLastPrompt(recoverySession.id);

			const retryPiText = recoveryPrompt.mock.calls[1][0] as string;
			expect(retryPiText).toContain(pointer);
			expect(retryPiText).toContain(EXTRACTED_MARKER);
			const retryPrepared = prepareVisibleAgentEvent(recoverySession, {
				type: "message_end",
				message: { id: "pi-explicit-retry-occurrence", role: "user", content: retryPiText },
			});
			const retryLive = emitSessionEvent(recoverySession, retryPrepared).event as any;
			expect(visibleText(retryLive.message)).toBe(TYPED_TEXT);
			expect(retryLive.message.attachments?.[0].fileName).toBe(ATTACHMENT.fileName);

			recoverySession.status = "idle";
			recoverySession.lastTurnErrored = true;
			recoverySession.lastTurnErrorMessage = "automatic retryable failure";
			recoverySession.turnHadToolCalls = false;
			await recoveryManager.retryLastPrompt(recoverySession.id, { auto: true });
			const autoRetryPiText = recoveryPrompt.mock.calls[2][0] as string;
			expect(autoRetryPiText).toContain(pointer);
			const autoPrepared = prepareVisibleAgentEvent(recoverySession, {
				type: "message_end",
				message: { id: "pi-auto-retry-occurrence", role: "user", content: autoRetryPiText },
			});
			const autoLive = emitSessionEvent(recoverySession, autoPrepared).event as any;
			expect(visibleText(autoLive.message)).toBe(TYPED_TEXT);
			expect(autoLive.message.attachments?.[0].fileName).toBe(ATTACHMENT.fileName);

			const raw = [
				{ id: "pi-recovery-occurrence", role: "user", content: recoveryModelText },
				{ id: "pi-explicit-retry-occurrence", role: "user", content: retryPiText },
				{ id: "pi-auto-retry-occurrence", role: "user", content: autoRetryPiText },
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
