import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../../tests2/dom/_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAppStorage } from "../../src/ui/storage/app-storage.js";
import { AgentInterface } from "../../src/ui/components/AgentInterface.js";
import { MessageEditor } from "../../src/ui/components/MessageEditor.js";

if (!customElements.get("message-editor")) customElements.define("message-editor", MessageEditor);

const CLEAR_DESCRIPTION = "Start fresh with no prior conversation context";

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

async function settle(element?: { updateComplete?: Promise<unknown> }): Promise<void> {
	await element?.updateComplete;
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountEditor(serverSkills: Array<Record<string, unknown>> = []): Promise<any> {
	vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.includes("/api/slash-skills")) {
			return new Response(JSON.stringify({ skills: serverSkills }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		return new Response("[]", { status: 200 });
	});
	const editor = document.createElement("message-editor") as any;
	editor.cwd = "/context-clear-command-test";
	editor.showModelSelector = false;
	editor.showThinkingSelector = false;
	editor.showAttachmentButton = false;
	document.body.appendChild(editor);
	await editor.updateComplete;
	await editor._loadSlashSkills();
	return editor;
}

function makeInterface(
	overrides: Record<string, unknown> = {},
): { ui: AgentInterface & any; editor: any; session: any } {
	const editor = {
		value: "/clear",
		attachments: [] as unknown[],
		showBlockedSendError: vi.fn(),
	};
	const session = {
		sessionId: "clear-command-session",
		state: {
			condition: null,
			model: { provider: "test", id: "model" },
			isStreaming: true,
			messages: [{ role: "user", content: "existing conversation" }],
		},
		clearContext: vi.fn(() => true),
		prompt: vi.fn(),
		appendMessage: vi.fn(),
		...overrides,
	};
	const ui = new AgentInterface() as AgentInterface & any;
	ui.session = session;
	Object.defineProperty(ui, "_messageEditor", { configurable: true, value: editor });
	Object.defineProperty(ui, "_streamingContainer", { configurable: true, value: undefined });
	return { ui, editor, session };
}

beforeEach(() => {
	document.body.innerHTML = "";
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("built-in /clear discovery", () => {
	it("is available without discovered skills and has the concise built-in description", async () => {
		const editor = await mountEditor();
		const clear = editor._slashSkills.filter((skill: any) => skill.name === "clear");

		expect(clear, "CONTEXT_CLEAR_DISCOVERY_MISSING: /clear must be discoverable without server skills").toHaveLength(1);
		expect(clear[0]).toMatchObject({
			name: "clear",
			description: CLEAR_DESCRIPTION,
			source: "built-in",
		});
	});

	it("reserves the name so a discovered case-variant cannot shadow the built-in", async () => {
		const editor = await mountEditor([
			{ name: "CLEAR", description: "malicious shadow", source: "project" },
			{ name: "status", description: "ordinary skill", source: "project" },
		]);
		const clear = editor._slashSkills.filter((skill: any) => skill.name.toLowerCase() === "clear");

		expect(clear, "CONTEXT_CLEAR_RESERVED_COMMAND_SHADOWED: discovered skills must not replace /clear").toHaveLength(1);
		expect(clear[0]).toMatchObject({ name: "clear", description: CLEAR_DESCRIPTION, source: "built-in" });
		expect(editor._slashSkills.some((skill: any) => skill.name === "status")).toBe(true);
	});
});

describe("AgentInterface /clear interception", () => {
	it("intercepts only a trimmed mixed-case standalone command without creating a user or model message", async () => {
		const { ui, editor, session } = makeInterface();
		const attachment = { id: "old-draft", type: "document", fileName: "draft.txt" };
		const input = " \t/ClEaR\n";
		editor.value = input;
		editor.attachments = [attachment];
		ui._attachments = [attachment];
		const deleteDraft = vi.spyOn(getAppStorage().promptDraftAttachments, "deleteAttachments").mockResolvedValue();
		const before = structuredClone(session.state.messages);
		const onBeforeSend = vi.fn();
		ui.onBeforeSend = onBeforeSend;

		await ui.sendMessage(input, [attachment] as any);

		expect(session.clearContext, "CONTEXT_CLEAR_NOT_INTERCEPTED: standalone /clear must use clearContext").toHaveBeenCalledOnce();
		expect(session.prompt).not.toHaveBeenCalled();
		expect(session.appendMessage).not.toHaveBeenCalled();
		expect(onBeforeSend).not.toHaveBeenCalled();
		expect(session.state.messages, "CONTEXT_CLEAR_COMMAND_BUBBLED: /clear must not enter visible/model history").toEqual(before);
		expect(editor.value).toBe("");
		expect(editor.attachments).toEqual([]);
		expect(ui._attachments).toEqual([]);
		expect(deleteDraft).toHaveBeenCalledWith("clear-command-session");
	});

	it("preserves the exact composer and attachment draft when transport rejects clear", async () => {
		const { ui, editor, session } = makeInterface({ clearContext: vi.fn(() => false) });
		const attachment = { id: "unsent", type: "document", fileName: "unsent.txt" };
		const editorAttachments = [attachment];
		const liftedAttachments = [attachment];
		editor.value = " /ClEaR ";
		editor.attachments = editorAttachments;
		ui._attachments = liftedAttachments;
		const deleteDraft = vi.spyOn(getAppStorage().promptDraftAttachments, "deleteAttachments").mockResolvedValue();
		const before = structuredClone(session.state.messages);

		await ui.sendMessage(editor.value, editorAttachments as any);

		expect(session.clearContext).toHaveBeenCalledOnce();
		expect(editor.showBlockedSendError).toHaveBeenCalledWith(
			"Context wasn't cleared. Your previous context is still active. Try /clear again.",
		);
		expect(editor.value).toBe(" /ClEaR ");
		expect(editor.attachments).toBe(editorAttachments);
		expect(ui._attachments).toBe(liftedAttachments);
		expect(deleteDraft).not.toHaveBeenCalled();
		expect(session.state.messages).toEqual(before);
		expect(session.prompt).not.toHaveBeenCalled();
	});

	it("preserves a newer composer and attachment draft created while clear admission is pending", async () => {
		const admission = deferred<boolean>();
		const { ui, editor, session } = makeInterface({ clearContext: vi.fn(() => admission.promise) });
		const submittedAttachment = { id: "submitted", type: "document", fileName: "old.txt" };
		const newerAttachment = { id: "newer", type: "document", fileName: "new.txt" };
		editor.value = "/clear";
		editor.attachments = [submittedAttachment];
		ui._attachments = [submittedAttachment];
		const deleteDraft = vi.spyOn(getAppStorage().promptDraftAttachments, "deleteAttachments").mockResolvedValue();

		const sending = ui.sendMessage("/clear", [submittedAttachment] as any);
		editor.value = "new prompt typed during admission";
		editor.attachments = [newerAttachment];
		ui._attachments = [newerAttachment];
		admission.resolve(true);
		await sending;

		expect(session.clearContext).toHaveBeenCalledOnce();
		expect(editor.value, "CONTEXT_CLEAR_NEW_DRAFT_ERASED: async admission must not clear newer text").toBe("new prompt typed during admission");
		expect(editor.attachments).toEqual([newerAttachment]);
		expect(ui._attachments).toEqual([newerAttachment]);
		expect(deleteDraft).not.toHaveBeenCalled();
	});

	it("treats /clear with arguments as ordinary model input", async () => {
		const { ui, editor, session } = makeInterface();
		editor.value = "/clear keep this";
		await ui.sendMessage("/clear keep this");

		expect(session.clearContext).not.toHaveBeenCalled();
		expect(session.prompt).toHaveBeenCalledExactlyOnceWith("/clear keep this");
	});

	it("runs the model-selection fence before clear and retains the complete draft", async () => {
		const { ui, editor, session } = makeInterface({
			state: {
				condition: { code: "MODEL_SELECTION_REQUIRED" },
				model: undefined,
				isStreaming: false,
				messages: [],
			},
		});
		const attachment = { id: "blocked", type: "document", fileName: "blocked.txt" };
		editor.value = "/CLEAR";
		editor.attachments = [attachment];
		ui._attachments = [attachment];
		const deleteDraft = vi.spyOn(getAppStorage().promptDraftAttachments, "deleteAttachments").mockResolvedValue();

		await ui.sendMessage("/CLEAR", [attachment] as any);
		await settle();

		expect(editor.showBlockedSendError).toHaveBeenCalledWith("Choose a replacement model before sending.");
		expect(session.clearContext).not.toHaveBeenCalled();
		expect(session.prompt).not.toHaveBeenCalled();
		expect(editor.value).toBe("/CLEAR");
		expect(editor.attachments).toEqual([attachment]);
		expect(ui._attachments).toEqual([attachment]);
		expect(deleteDraft).not.toHaveBeenCalled();
	});
});
