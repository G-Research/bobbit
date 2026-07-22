import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import type { Model } from "@earendil-works/pi-ai";
import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import { live } from "lit/directives/live.js";
import { GripVertical, Loader2, Mic, MicOff, Paperclip, Pencil, Send, Square, Zap, X } from "lucide";
import type { Attachment } from "../utils/attachment-utils.js";
import { i18n } from "../utils/i18n.js";
import { getAppStorage } from "../storage/app-storage.js";
import { gatewayFetch } from "../../app/gateway-fetch.js";
import { listLauncherEntrypoints, runLauncherEntrypoint } from "../../app/pack-entrypoints.js";
import "./AttachmentTile.js";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { MessageAuthor } from "../../shared/message-author.js";
import type { PromptSource } from "../../shared/prompt-source.js";

/** Slash skill metadata from the server */
async function loadAttachmentLazy(source: string | File | Blob | ArrayBuffer, fileName?: string): Promise<Attachment> {
	const mod = await import("../utils/attachment-utils.js");
	return mod.loadAttachment(source, fileName);
}

interface SlashSkillInfo {
	name: string;
	description: string;
	argumentHint?: string;
	source: "project" | "personal" | "legacy" | "built-in" | "pack";
	/** Slice C1 — set when this slash entry is a pack `composer-slash` ENTRYPOINT.
	 *  Selecting it only inserts the completed command; send-time dispatch runs the
	 *  launcher once the user has supplied any required arguments. */
	entrypointId?: string;
}

// The PR-walkthrough launcher is now provided by the first-party pack's
// composer-slash entrypoint (not a built-in slash command).
const BUILT_IN_SLASH_COMMANDS: SlashSkillInfo[] = [];

function mergeBuiltInSlashCommands(skills: SlashSkillInfo[]): SlashSkillInfo[] {
	const names = new Set(skills.map((skill) => skill.name.toLowerCase()));
	return [...BUILT_IN_SLASH_COMMANDS.filter((skill) => !names.has(skill.name.toLowerCase())), ...skills];
}

/** Server-authoritative queued message (mirrors server QueuedMessage from protocol.ts) */
export interface QueuedMessage {
	id: string;
	text: string;
	images?: Array<{ type: "image"; data: string; mimeType: string }>;
	attachments?: unknown[];
	isSteered: boolean;
	dispatched?: boolean;
	source?: PromptSource;
	author?: MessageAuthor;
	createdAt: number;
}

@customElement("message-editor")
export class MessageEditor extends LitElement {
	/** Reject a send whose serialized prompt frame would exceed this (S31). Kept
	 *  safely below the gateway's WS_MAX_PAYLOAD_BYTES (256 MiB) so an oversized
	 *  multi-image send is reported with a clear error instead of tearing the
	 *  socket down (close-1009). Static so tests can lower it without 200 MB of
	 *  fixture data. */
	static MAX_SERIALIZED_SEND_BYTES = 200 * 1024 * 1024;

	/** Bytes of the serialized prompt frame RemoteAgent.prompt() will send, given
	 *  the current text + attachments. Mirrors that frame exactly: each image
	 *  rides ~3× base64 (images[].data + attachments[].content + attachments[].preview).
	 *  base64 is ASCII so JSON string length ≈ byte length. Pure — testable. */
	static serializedSendBytes(text: string, attachments: Attachment[]): number {
		const imageData = attachments
			.filter((a) => a.type === "image" && a.content)
			.map((a) => ({ type: "image", data: a.content, mimeType: a.mimeType }));
		const frame = {
			type: "prompt",
			text,
			...(imageData.length ? { images: imageData } : {}),
			...(attachments.length ? { attachments } : {}),
		};
		return JSON.stringify(frame).length;
	}

	private _value = "";
	private textareaRef = createRef<HTMLTextAreaElement>();

	@property()
	get value() {
		return this._value;
	}

	set value(val: string) {
		const oldValue = this._value;
		this._value = val;
		this.requestUpdate("value", oldValue);
	}



	@property() sessionId?: string;
	@property() isStreaming = false;
	@property() currentModel?: Model<any>;
	@property() thinkingLevel: ThinkingLevel = "off";
	@property() showAttachmentButton = true;
	@property() showModelSelector = true;
	@property() showThinkingSelector = true;
	@property() onInput?: (value: string) => void;
	@property() onSend?: (input: string, attachments: Attachment[]) => void;
	@property() onAbort?: () => void;
	@property() onModelSelect?: () => void;
	@property() onThinkingChange?: (level: ThinkingLevel) => void;
	@property() onFilesChange?: (files: Attachment[]) => void;
	@property() onSteer?: (msg: QueuedMessage) => void;
	@property() onRemoveQueued?: (id: string) => void;
	@property() onEditQueued?: (msg: QueuedMessage) => void;
	@property() onReorder?: (messageIds: string[]) => void;
	@property() attachments: Attachment[] = [];
	@property({ type: Array }) queuedMessages: QueuedMessage[] = [];
	@property() maxFiles = 10;
	@property() maxFileSize = 20 * 1024 * 1024; // 20MB
	@property() acceptedTypes =
		"image/*,application/pdf,.docx,.pptx,.txt,.md,.json,.xml,.html,.css,.js,.ts,.jsx,.tsx,.yml,.yaml";
	/** Working directory — used to discover slash skills */
	@property() cwd?: string;
	/** Project ID — used to scope slash skill discovery */
	@property() projectId?: string;

	@state() processingFiles = false;
	@state() isDragging = false;
	/** Non-empty when the last send was rejected for exceeding the aggregate
	 *  payload limit (S31). Shown as an inline error; cleared on the next edit. */
	@state() private _sendSizeError = "";
	@state() private isRecording = false;
	private fileInputRef = createRef<HTMLInputElement>();

	// Command history state
	private _history: string[] = [];
	private _historyIndex = -1; // -1 = not browsing history
	private _savedDraft = ""; // draft saved when entering history mode

	// Slash skill autocomplete state
	@state() private _slashSkills: SlashSkillInfo[] = mergeBuiltInSlashCommands([]);
	@state() private _slashFilteredSkills: SlashSkillInfo[] = [];
	@state() private _slashMenuOpen = false;
	@state() private _slashSelectedIndex = 0;
	@state() private _slashTokenStart = 0;
	private _slashSkillsLoaded = false;
	private _slashSkillsCwd?: string;
	private _slashSkillsProjectId?: string;

	// @-mention file autocomplete state (parallel to the _slash* fields above).
	@state() private _atFiles: string[] = [];
	@state() private _atFilteredFiles: string[] = [];
	@state() private _atMenuOpen = false;
	@state() private _atSelectedIndex = 0;
	@state() private _atTokenStart = 0;
	/** The query (path fragment) typed after the most recent `@`. */
	private _atQuery = "";
	/** Cache invalidation keys — refetch when cwd/project changes. */
	private _atFilesCwd?: string;
	private _atFilesProjectId?: string;
	private _atLoadTimer: ReturnType<typeof setTimeout> | null = null;

	// Drag-to-reorder state
	private _draggedPillId: string | null = null;

	// Speech recognition
	private speechRecognition: SpeechRecognition | null = null;
	private speechSupported = typeof window !== "undefined" && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
	/** The textarea value before speech started — we append after this */
	private preSpeechText = "";
	private stopTimeout: ReturnType<typeof setTimeout> | null = null;


	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	// Note: history loading is handled in the updated() override near connectedCallback

	private async _loadHistory() {
		if (!this.sessionId) return;
		try {
			const store = getAppStorage().commandHistory;
			this._history = await store.getHistory(this.sessionId);
			this._historyIndex = -1;
		} catch {
			// Storage not available — history won't work but that's fine
			this._history = [];
		}
	}

	/**
	 * Add a sent message to command history.
	 * Called externally after a message is sent.
	 */
	async addToHistory(text: string): Promise<void> {
		if (!this.sessionId || !text.trim()) return;
		try {
			const store = getAppStorage().commandHistory;
			await store.addEntry(this.sessionId, text);
			this._history = await store.getHistory(this.sessionId);
		} catch {
			// Best effort — don't break sending
		}
		this._historyIndex = -1;
	}

	private async _loadSlashSkills() {
		if (!this.cwd) {
			this._slashSkills = mergeBuiltInSlashCommands([]);
			return;
		}
		if (this._slashSkillsLoaded && this._slashSkillsCwd === this.cwd && this._slashSkillsProjectId === this.projectId) return;
		try {
			let url = `/api/slash-skills?cwd=${encodeURIComponent(this.cwd)}`;
			if (this.projectId) url += `&projectId=${encodeURIComponent(this.projectId)}`;
			const res = await gatewayFetch(url);
			if (res.ok) {
				const data = await res.json();
				this._slashSkills = this._withPackEntrypoints(mergeBuiltInSlashCommands(data.skills || []));
			}
		} catch {
			// Best effort
			this._slashSkills = this._withPackEntrypoints(mergeBuiltInSlashCommands([]));
		}
		this._slashSkillsCwd = this.cwd;
		this._slashSkillsProjectId = this.projectId;
		this._slashSkillsLoaded = true;
	}

	private _updateSlashAutocomplete() {
		const textarea = this.textareaRef.value;
		if (!textarea) { this._slashMenuOpen = false; return; }
		const cursorPos = textarea.selectionStart;
		const textBeforeCursor = this.value.substring(0, cursorPos);
		// Find the last "/" before cursor that's at a word boundary (after whitespace, newline, or at position 0)
		const match = textBeforeCursor.match(/(^|[\s])\/([\w-]*)$/);
		if (match) {
			// Eagerly load skills if not yet loaded (handles race with cwd arrival)
			if (!this._slashSkillsLoaded && this.cwd) {
				this._loadSlashSkills().then(() => this._updateSlashAutocomplete());
			}
			this._slashTokenStart = cursorPos - match[2].length - 1; // position of "/"
			const query = match[2].toLowerCase();
			// Pack entrypoints reconcile asynchronously after session/project changes.
			// Re-merge them at filter time so the slash menu never shows stale launcher ids
			// (or misses newly-registered launchers) because the base skill list loaded early.
			const slashSkills = this._withPackEntrypoints(this._slashSkills.filter((s) => s.source !== "pack"));
			this._slashFilteredSkills = query
				? slashSkills.filter((s) => s.name.toLowerCase().includes(query))
				: slashSkills;
			this._slashMenuOpen = this._slashFilteredSkills.length > 0;
			this._slashSelectedIndex = 0;
		} else {
			this._slashMenuOpen = false;
		}
	}

	/** Slice C1 — append the registered pack `composer-slash` ENTRYPOINTS (from the
	 *  reconciled client pack-entrypoints registry) to the slash list as synthetic
	 *  entries. The trigger name is the entrypoint id; selecting one completes the
	 *  token and send-time dispatch runs the launcher. Best-effort + synchronous —
	 *  the registry is already populated by the project reconcile; a load failure is
	 *  non-fatal. */
	private _withPackEntrypoints(skills: SlashSkillInfo[]): SlashSkillInfo[] {
		try {
			const eps = listLauncherEntrypoints("composer-slash");
			if (eps.length === 0) return skills;
			const names = new Set(skills.map((s) => s.name.toLowerCase()));
			// `name` is the user-facing slash trigger (the pack-local entrypoint id);
			// `entrypointId` carries the COMPOUND launcher key (packId+entrypointId) so
			// dispatch addresses the exact launcher even when two packs share an id.
			const packEntries: SlashSkillInfo[] = eps
				.filter((e) => !names.has(e.id.toLowerCase()))
				.map((e) => ({ name: e.id, description: e.label, source: "pack" as const, entrypointId: e.key }));
			return [...skills, ...packEntries];
		} catch {
			return skills;
		}
	}

	private _showLauncherFeedback(message: string, kind: "pending" | "error" | "resolved"): void {
		// Dispatch-only: the persistent launcher-feedback element in render.ts owns
		// the UI. Do NOT also call showHeaderToast here (the transient 2500ms toast
		// would double-fire and auto-clear a state meant to persist until resolved).
		window.dispatchEvent(new CustomEvent("bobbit-launcher-feedback", { detail: { kind, message } }));
	}

	private _showLauncherError(message: string): void {
		this._showLauncherFeedback(message, "error");
	}

	private _showLauncherPending(message = "Starting…"): void {
		this._showLauncherFeedback(message, "pending");
	}

	private _showLauncherResolved(): void {
		this._showLauncherFeedback("", "resolved");
	}

	private _selectSlashSkill(skill: SlashSkillInfo) {
		const textarea = this.textareaRef.value;
		if (!textarea) return;
		const before = this.value.substring(0, this._slashTokenStart);
		const after = this.value.substring(textarea.selectionStart);
		this.value = before + `/${skill.name} ` + after;
		this._slashMenuOpen = false;
		this.onInput?.(this.value);
		// Update textarea and move cursor after the inserted skill name. Pack
		// composer-slash launchers are dispatched only when the completed command is
		// sent, so selecting autocomplete still lets the user type required args.
		textarea.value = this.value;
		const newPos = before.length + skill.name.length + 2; // "/" + name + " "
		textarea.focus();
		textarea.setSelectionRange(newPos, newPos);
	}

	private _packSlashLaunchFromText(text: string): { entrypointId: string; label: string; body: Record<string, unknown> } | undefined {
		const trimmed = text.trim();
		const match = trimmed.match(/^\/([A-Za-z0-9_.-]+)(?:\s+([\s\S]+))?$/);
		if (!match) return undefined;

		const name = match[1];
		const launcher = listLauncherEntrypoints("composer-slash").find((l) => l.id === name);
		if (!launcher) return undefined;

		const arg = (match[2] ?? "").trim();
		if (!arg) return { entrypointId: launcher.key, label: launcher.label, body: {} };

		// PR walkthrough's run route already accepts these argument fields.
		if (launcher.packId === "pr-walkthrough" || launcher.id === "pr-walkthrough") {
			if (/^\d+$/.test(arg)) return { entrypointId: launcher.key, label: launcher.label, body: { prNumber: Number(arg) } };
			return { entrypointId: launcher.key, label: launcher.label, body: { prUrl: arg } };
		}

		return { entrypointId: launcher.key, label: launcher.label, body: { input: arg } };
	}

	/** Fetch the file list for the current `@` query from the server (debounced).
	 *  Mirrors `_loadSlashSkills` but is query-scoped because the file tree can be
	 *  large/remote, so the server does the filtering + ranking. */
	private async _loadFileMentions(query: string) {
		if (!this.cwd) {
			this._atFiles = [];
			this._atFilteredFiles = [];
			return;
		}
		// Invalidate the local cache key so a later cwd/project change refetches.
		this._atFilesCwd = this.cwd;
		this._atFilesProjectId = this.projectId;
		try {
			let url = `/api/file-mentions?cwd=${encodeURIComponent(this.cwd)}`;
			if (this.projectId) url += `&projectId=${encodeURIComponent(this.projectId)}`;
			// Let the server resolve the session's real host worktree (autocomplete
			// must be scoped to the session cwd, not the project root).
			if (this.sessionId) url += `&sessionId=${encodeURIComponent(this.sessionId)}`;
			if (query) url += `&q=${encodeURIComponent(query)}`;
			url += `&limit=50`;
			const res = await gatewayFetch(url);
			if (res.ok) {
				const data = await res.json();
				this._atFiles = Array.isArray(data.files)
					? (data.files as Array<{ path: string }>).map((f) => f.path).filter((p) => typeof p === "string")
					: [];
				// The user may have selected a mention while this fetch was in flight.
				// Only a currently active @ token may reopen the menu.
				if (!this._currentAtMatch()) {
					this._atMenuOpen = false;
					return;
				}
				// Re-apply the current (possibly newer) token filter so the menu
				// reflects what the user has typed since this fetch was scheduled.
				this._applyAtFilter();
			}
		} catch {
			// Best effort — leave the last results in place.
		}
	}

	private _scheduleLoadFileMentions(query: string) {
		if (this._atLoadTimer) clearTimeout(this._atLoadTimer);
		this._atLoadTimer = setTimeout(() => {
			this._atLoadTimer = null;
			this._loadFileMentions(query);
		}, 120);
	}

	private _currentAtMatch(): RegExpMatchArray | null {
		const textarea = this.textareaRef.value;
		if (!textarea) return null;
		const cursorPos = textarea.selectionStart;
		const textBeforeCursor = this.value.substring(0, cursorPos);
		// Trigger on an `@` at a word boundary (start, whitespace, or newline)
		// followed by a path fragment with no whitespace or further `@`.
		return textBeforeCursor.match(/(^|[\s])@([^\s@]*)$/);
	}

	/** Filter the cached file list by the current `@` query for an instant menu. */
	private _applyAtFilter() {
		const q = this._atQuery.toLowerCase();
		const files = q ? this._atFiles.filter((p) => p.toLowerCase().includes(q)) : this._atFiles;
		this._atFilteredFiles = files;
		this._atMenuOpen = files.length > 0;
		// Reset to the top-ranked match on every recompute (mirrors the slash
		// menu) so a changed query never leaves a stale highlight that Enter/Tab
		// would select.
		this._atSelectedIndex = 0;
	}

	private _updateAtAutocomplete() {
		const textarea = this.textareaRef.value;
		if (!textarea) { this._atMenuOpen = false; return; }
		const cursorPos = textarea.selectionStart;
		const match = this._currentAtMatch();
		if (match) {
			this._atTokenStart = cursorPos - match[2].length - 1; // position of "@"
			this._atQuery = match[2];
			// Instant filter from cache, then refresh from the server (debounced).
			this._applyAtFilter();
			this._scheduleLoadFileMentions(this._atQuery);
		} else {
			this._atMenuOpen = false;
		}
	}

	private _selectFileMention(filePath: string) {
		const textarea = this.textareaRef.value;
		if (!textarea) return;
		if (this._atLoadTimer) {
			clearTimeout(this._atLoadTimer);
			this._atLoadTimer = null;
		}
		const before = this.value.substring(0, this._atTokenStart);
		const after = this.value.substring(textarea.selectionStart);
		this.value = before + `@${filePath} ` + after;
		this._atMenuOpen = false;
		this._atQuery = "";
		this.onInput?.(this.value);
		// Update textarea and move cursor after the inserted path + trailing space.
		if (textarea) {
			textarea.value = this.value;
			const newPos = before.length + filePath.length + 2; // "@" + path + " "
			textarea.focus();
			textarea.setSelectionRange(newPos, newPos);
		}
	}

	private _isCursorOnVisualTopRow(): boolean {
		const textarea = this.textareaRef.value;
		if (!textarea) return true;
		const pos = textarea.selectionStart;
		if (pos === 0) return true;

		const style = getComputedStyle(textarea);
		const mirror = document.createElement("div");
		mirror.style.cssText = `position:absolute;visibility:hidden;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;width:${textarea.clientWidth}px;font:${style.font};padding:${style.padding};border:${style.border};box-sizing:${style.boxSizing};letter-spacing:${style.letterSpacing};`;
		mirror.textContent = textarea.value.substring(0, pos);
		document.body.appendChild(mirror);
		const cursorHeight = mirror.offsetHeight;
		mirror.textContent = "X";
		const singleRowHeight = mirror.offsetHeight;
		document.body.removeChild(mirror);

		return cursorHeight <= singleRowHeight;
	}

	private _isCursorOnVisualBottomRow(): boolean {
		const textarea = this.textareaRef.value;
		if (!textarea) return true;
		const pos = textarea.selectionStart;
		if (pos >= textarea.value.length) return true;

		const style = getComputedStyle(textarea);
		const mirror = document.createElement("div");
		mirror.style.cssText = `position:absolute;visibility:hidden;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;width:${textarea.clientWidth}px;font:${style.font};padding:${style.padding};border:${style.border};box-sizing:${style.boxSizing};letter-spacing:${style.letterSpacing};`;
		mirror.textContent = textarea.value;
		document.body.appendChild(mirror);
		const fullHeight = mirror.offsetHeight;
		mirror.textContent = textarea.value.substring(0, pos);
		const cursorHeight = mirror.offsetHeight;
		mirror.textContent = "X";
		const singleRowHeight = mirror.offsetHeight;
		document.body.removeChild(mirror);

		return (fullHeight - cursorHeight) <= singleRowHeight;
	}

	/** Horizontal pixel offset of the autocomplete menu for a token starting at
	 *  `tokenStart` — measures the rendered width of the text from the start of
	 *  the visual line up to the token. Shared by the slash and `@` menus. */
	private _getMenuLeft(tokenStart: number): number {
		const textarea = this.textareaRef.value;
		if (!textarea) return 0;
		const style = getComputedStyle(textarea);
		const mirror = document.createElement("span");
		mirror.style.cssText = `position:absolute;visibility:hidden;white-space:pre-wrap;font:${style.font};letter-spacing:${style.letterSpacing};`;
		mirror.textContent = this.value.substring(
			this.value.lastIndexOf("\n", tokenStart - 1) + 1,
			tokenStart,
		);
		document.body.appendChild(mirror);
		const leftOffset = mirror.offsetWidth;
		document.body.removeChild(mirror);
		return leftOffset;
	}

	private _getSlashMenuLeft(): number {
		return this._getMenuLeft(this._slashTokenStart);
	}

	/** Live preview order of pill IDs while dragging. Null when not dragging. */
	private _dragPreviewOrder: string[] | null = null;

	private _handlePillDragStart = (e: DragEvent, msg: QueuedMessage) => {
		this._draggedPillId = msg.id;
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = "move";
			e.dataTransfer.setData("text/plain", msg.id);
		}
	};

	private _handlePillDragOver = (e: DragEvent, overPillId: string) => {
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
		if (!this._draggedPillId || this._draggedPillId === overPillId) return;

		// Compute preview order: move dragged pill to the hovered position
		const ids = this.queuedMessages.map((m) => m.id);
		const dragIdx = ids.indexOf(this._draggedPillId);
		const overIdx = ids.indexOf(overPillId);
		if (dragIdx === -1 || overIdx === -1) return;

		ids.splice(dragIdx, 1);
		ids.splice(overIdx, 0, this._draggedPillId);

		// Only re-render if the order actually changed
		if (!this._dragPreviewOrder || this._dragPreviewOrder.join(",") !== ids.join(",")) {
			this._dragPreviewOrder = ids;
			this.requestUpdate();
		}
	};

	private _handlePillDrop = (e: DragEvent, _dropTargetId: string) => {
		e.preventDefault();
		if (!this._draggedPillId) return;

		// Use the live preview order as the final order
		const finalOrder = this._dragPreviewOrder
			?? this.queuedMessages.map((m) => m.id);

		this.onReorder?.(finalOrder);
		this._draggedPillId = null;
		this._dragPreviewOrder = null;
	};

	private _handlePillDragEnd = (_e: DragEvent) => {
		this._draggedPillId = null;
		this._dragPreviewOrder = null;
		this.requestUpdate();
	};

	private handleTextareaInput = (e: Event) => {
		const textarea = e.target as HTMLTextAreaElement;
		this.value = textarea.value;
		if (this._sendSizeError) this._sendSizeError = ""; // clear the S31 error once the user edits
		this.onInput?.(this.value);
		this._updateSlashAutocomplete();
		this._updateAtAutocomplete();
	};

	private handleKeyDown = (e: KeyboardEvent) => {
		// IME composition guard (S3): while composing CJK/dead-key text, the Enter
		// that COMMITS the candidate must not send the message. WebKit reports
		// `isComposing===true` with key "Enter"; Chromium/Firefox report keyCode 229
		// ("Process"). Bail before any Enter/Tab/slash handling so the composition
		// commit is left to the IME. Zero effect for non-IME users.
		if (e.isComposing || e.keyCode === 229) return;

		// Slash autocomplete keyboard handling
		if (this._slashMenuOpen) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				this._slashSelectedIndex = Math.min(this._slashSelectedIndex + 1, this._slashFilteredSkills.length - 1);
				return;
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				this._slashSelectedIndex = Math.max(this._slashSelectedIndex - 1, 0);
				return;
			} else if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				if (this._slashFilteredSkills[this._slashSelectedIndex]) {
					this._selectSlashSkill(this._slashFilteredSkills[this._slashSelectedIndex]);
				}
				return;
			} else if (e.key === "Escape") {
				e.preventDefault();
				this._slashMenuOpen = false;
				return;
			}
		}

		// @-mention file autocomplete keyboard handling. Mutually exclusive with
		// the slash menu — a trailing token can only be `/...` or `@...`, never both.
		if (this._atMenuOpen) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				this._atSelectedIndex = Math.min(this._atSelectedIndex + 1, this._atFilteredFiles.length - 1);
				return;
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				this._atSelectedIndex = Math.max(this._atSelectedIndex - 1, 0);
				return;
			} else if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				if (this._atFilteredFiles[this._atSelectedIndex]) {
					this._selectFileMention(this._atFilteredFiles[this._atSelectedIndex]);
				}
				return;
			} else if (e.key === "Escape") {
				e.preventDefault();
				this._atMenuOpen = false;
				return;
			}
		}

		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (!this.processingFiles && (this.value.trim() || this.attachments.length > 0)) {
				this.handleSend();
			}
		} else if (e.key === "Escape" && this.isStreaming) {
			e.preventDefault();
			this.onAbort?.();
		} else if (e.key === "ArrowUp" && !e.ctrlKey && !e.metaKey && !e.altKey && this._history.length > 0 && this._isCursorOnVisualTopRow()) {
			// Enter history browsing or go further back
			if (this._historyIndex === -1) {
				// First press — save current draft and show newest history entry
				this._savedDraft = this.value;
				this._historyIndex = this._history.length - 1;
			} else if (this._historyIndex > 0) {
				this._historyIndex--;
			} else {
				return; // Already at oldest entry, let default behavior through
			}
			e.preventDefault();
			this._applyHistoryEntry();
		} else if (e.key === "ArrowDown" && !e.ctrlKey && !e.metaKey && !e.altKey && this._historyIndex !== -1 && this._isCursorOnVisualBottomRow()) {
			e.preventDefault();
			if (this._historyIndex < this._history.length - 1) {
				this._historyIndex++;
				this._applyHistoryEntry();
			} else {
				// Past newest entry — restore draft
				this._historyIndex = -1;
				this.value = this._savedDraft;
				this.onInput?.(this.value);
			}
		}
	};

	private _applyHistoryEntry() {
		if (this._historyIndex >= 0 && this._historyIndex < this._history.length) {
			this.value = this._history[this._historyIndex];
			this.onInput?.(this.value);
		}
	}

	private handlePaste = async (e: ClipboardEvent) => {
		const items = e.clipboardData?.items;
		if (!items) return;

		const imageFiles: File[] = [];

		// Check for image items in clipboard
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (item.type.startsWith("image/")) {
				const file = item.getAsFile();
				if (file) {
					imageFiles.push(file);
				}
			}
		}

		// If we found images, process them
		if (imageFiles.length > 0) {
			e.preventDefault(); // Prevent default paste behavior

			if (imageFiles.length + this.attachments.length > this.maxFiles) {
				alert(`Maximum ${this.maxFiles} files allowed`);
				return;
			}

			this.processingFiles = true;
			const newAttachments: Attachment[] = [];

			for (const file of imageFiles) {
				try {
					if (file.size > this.maxFileSize) {
						alert(`Image exceeds maximum size of ${Math.round(this.maxFileSize / 1024 / 1024)}MB`);
						continue;
					}

					const attachment = await loadAttachmentLazy(file);
					newAttachments.push(attachment);
				} catch (error) {
					console.error("Error processing pasted image:", error);
					alert(`Failed to process pasted image: ${String(error)}`);
				}
			}

			this.attachments = [...this.attachments, ...newAttachments];
			this.onFilesChange?.(this.attachments);
			this.processingFiles = false;
		}
	};

	private handleSend = () => {
		const text = this.value;
		// S31: reject an oversized send BEFORE anything irreversible (the
		// 'message-send' event below tombstones the saved draft, and onSend clears
		// the composer). Over the limit → inline error, retain everything.
		if (this.attachments.length > 0) {
			const limit = MessageEditor.MAX_SERIALIZED_SEND_BYTES;
			const serializedBytes = MessageEditor.serializedSendBytes(text, this.attachments);
			if (serializedBytes > limit) {
				const mb = Math.ceil(serializedBytes / 1024 / 1024);
				const capMb = Math.floor(limit / 1024 / 1024);
				this._sendSizeError = `Attachments too large to send (${mb} MB > ${capMb} MB). Remove some and try again.`;
				return;
			}
		}
		this._sendSizeError = "";
		const packSlashLaunch = this.attachments.length === 0 ? this._packSlashLaunchFromText(text) : undefined;
		if (packSlashLaunch) {
			this._slashMenuOpen = false;
			this.dispatchEvent(new CustomEvent("message-send", { bubbles: true, composed: true }));
			this.value = "";
			this.onInput?.(this.value);
			const textarea = this.textareaRef.value;
			if (textarea) {
				textarea.value = this.value;
				textarea.focus();
			}
			this._historyIndex = -1;
			this._savedDraft = "";
			void this.addToHistory(text);

			this._showLauncherPending(`Starting ${packSlashLaunch.label}…`);
			runLauncherEntrypoint(packSlashLaunch.entrypointId, (r) => {
				if (r.ok) this._showLauncherResolved();
				else this._showLauncherError(r.error || `Could not start ${packSlashLaunch.label}.`);
			}, { body: packSlashLaunch.body });
			return;
		}
		// Dispatch a composed event that escapes shadow DOM — used by
		// session-manager for draft cleanup without monkey-patching.
		this.dispatchEvent(new CustomEvent("message-send", { bubbles: true, composed: true }));
		this.onSend?.(text, this.attachments);
		// Reset history browsing state after send
		this._historyIndex = -1;
		this._savedDraft = "";
		// Add to history (fire and forget)
		this.addToHistory(text);
	};

	private handleAttachmentClick = () => {
		this.fileInputRef.value?.click();
	};

	private async handleFilesSelected(e: Event) {
		const input = e.target as HTMLInputElement;
		const files = Array.from(input.files || []);
		if (files.length === 0) return;

		if (files.length + this.attachments.length > this.maxFiles) {
			alert(`Maximum ${this.maxFiles} files allowed`);
			input.value = "";
			return;
		}

		this.processingFiles = true;
		const newAttachments: Attachment[] = [];

		for (const file of files) {
			try {
				if (file.size > this.maxFileSize) {
					alert(`${file.name} exceeds maximum size of ${Math.round(this.maxFileSize / 1024 / 1024)}MB`);
					continue;
				}

				const attachment = await loadAttachmentLazy(file);
				newAttachments.push(attachment);
			} catch (error) {
				console.error(`Error processing ${file.name}:`, error);
				alert(`Failed to process ${file.name}: ${String(error)}`);
			}
		}

		this.attachments = [...this.attachments, ...newAttachments];
		this.onFilesChange?.(this.attachments);
		this.processingFiles = false;
		input.value = ""; // Reset input
	}

	private removeFile(fileId: string) {
		this.attachments = this.attachments.filter((f) => f.id !== fileId);
		this.onFilesChange?.(this.attachments);
	}

	private handleDragOver = (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		// Don't show "Drop files here" overlay when dragging queue pills
		if (this._draggedPillId) return;
		if (!this.isDragging) {
			this.isDragging = true;
		}
	};

	private handleDragLeave = (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		// Only set isDragging to false if we're leaving the entire component
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const x = e.clientX;
		const y = e.clientY;
		if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
			this.isDragging = false;
		}
	};

	private handleDrop = async (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		this.isDragging = false;

		const files = Array.from(e.dataTransfer?.files || []);
		if (files.length === 0) return;

		if (files.length + this.attachments.length > this.maxFiles) {
			alert(`Maximum ${this.maxFiles} files allowed`);
			return;
		}

		this.processingFiles = true;
		const newAttachments: Attachment[] = [];

		for (const file of files) {
			try {
				if (file.size > this.maxFileSize) {
					alert(`${file.name} exceeds maximum size of ${Math.round(this.maxFileSize / 1024 / 1024)}MB`);
					continue;
				}

				const attachment = await loadAttachmentLazy(file);
				newAttachments.push(attachment);
			} catch (error) {
				console.error(`Error processing ${file.name}:`, error);
				alert(`Failed to process ${file.name}: ${String(error)}`);
			}
		}

		this.attachments = [...this.attachments, ...newAttachments];
		this.onFilesChange?.(this.attachments);
		this.processingFiles = false;
	};

	// -- Speech recognition --

	private toggleSpeechRecognition = () => {
		if (this.isRecording) {
			this.stopSpeechRecognition();
		} else {
			this.startSpeechRecognition();
		}
	};

	private startSpeechRecognition() {
		if (!this.speechSupported) return;

		const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
		const recognition = new SpeechRecognitionCtor();
		recognition.continuous = true;
		recognition.interimResults = true;
		recognition.lang = navigator.language || "en-US";

		// Snapshot the current textarea content so we append after it
		this.preSpeechText = this.value;

		recognition.onresult = (event: SpeechRecognitionEvent) => {
			// Only display finalized results — interim results are volatile
			// and cause flickering on desktop. Mobile finalizes word-by-word
			// so this still feels responsive there.
			//
			// Mobile browsers return cumulative transcripts (each later final
			// contains all earlier text). Desktop returns segments. Detect by
			// checking if the last non-empty final starts with the previous one.
			const nonEmptyFinals: string[] = [];
			for (let i = 0; i < event.results.length; i++) {
				const result = event.results[i];
				if (result.isFinal) {
					const t = result[0].transcript;
					if (t) nonEmptyFinals.push(t);
				}
			}

			if (nonEmptyFinals.length === 0) return;

			const isCumulative =
				nonEmptyFinals.length >= 2 &&
				nonEmptyFinals[nonEmptyFinals.length - 1].startsWith(
					nonEmptyFinals[nonEmptyFinals.length - 2]
				);

			let fullText: string;
			if (isCumulative) {
				// Mobile: last final already has everything
				fullText = nonEmptyFinals[nonEmptyFinals.length - 1];
			} else {
				// Desktop: concatenate all segments
				fullText = nonEmptyFinals.join("");
			}

			const separator = this.preSpeechText && !this.preSpeechText.endsWith(" ") ? " " : "";
			this.value = this.preSpeechText + separator + fullText;
			this.onInput?.(this.value);

			const textarea = this.textareaRef.value;
			if (textarea) {
				textarea.value = this.value;
			}
		};

		recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
			console.warn("Speech recognition error:", event.error);
			if (event.error !== "no-speech") {
				this.stopSpeechRecognition();
			}
		};

		recognition.onend = () => {
			// Mobile browsers aggressively end recognition after a pause.
			// If the user hasn't explicitly stopped, restart automatically.
			if (this.isRecording && this.speechRecognition === recognition) {
				// Update preSpeechText to current value so we append from here
				this.preSpeechText = this.value;
				try {
					recognition.start();
				} catch {
					// start() can throw if called too quickly
					this.isRecording = false;
					this.speechRecognition = null;
				}
			} else {
				this.isRecording = false;
				this.speechRecognition = null;
			}
		};

		this.speechRecognition = recognition;
		this.isRecording = true;
		recognition.start();
	}

	private stopSpeechRecognition() {
		if (this.stopTimeout) {
			clearTimeout(this.stopTimeout);
			this.stopTimeout = null;
		}
		if (this.speechRecognition) {
			// Delay stop() to let the recognizer finalize the tail end of speech
			const recognition = this.speechRecognition;
			this.stopTimeout = setTimeout(() => {
				recognition.stop();
				this.stopTimeout = null;
			}, 500);
			this.speechRecognition = null;
		}
		this.isRecording = false;
	}

	private handleGlobalKeyDown = (e: KeyboardEvent) => {
		// ASUS ProArt Copilot key sends Win+Shift+F23, which Windows intercepts.
		// Use PowerToys to remap that shortcut to F13, then we catch it here.
		if (e.key === "F13" && !e.repeat) {
			e.preventDefault();
			this.startSpeechRecognition();
		}
	};

	private handleGlobalKeyUp = (e: KeyboardEvent) => {
		if (e.key === "F13") {
			e.preventDefault();
			this.stopSpeechRecognition();
		}
	};

	override connectedCallback() {
		super.connectedCallback();
		document.addEventListener("keydown", this.handleGlobalKeyDown);
		document.addEventListener("keyup", this.handleGlobalKeyUp);
		// Restore draft from sessionStorage if available. This runs synchronously
		// when the element is created/reattached, BEFORE any Lit render cycle
		// can reset _value to "". session-manager saves the draft text here
		// after loading from the server.
		if (this.sessionId) {
			const key = `bobbit_draft_${this.sessionId}`;
			const draft = sessionStorage.getItem(key);
			if (draft) {
				this._value = draft;
			}
		}
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		document.removeEventListener("keydown", this.handleGlobalKeyDown);
		document.removeEventListener("keyup", this.handleGlobalKeyUp);
		if (this._atLoadTimer) { clearTimeout(this._atLoadTimer); this._atLoadTimer = null; }
		this.stopSpeechRecognition();
	}

	override firstUpdated() {
		const textarea = this.textareaRef.value;
		if (textarea) {
			textarea.focus();
		}
	}

	protected override updated(changed: Map<string, unknown>) {
		super.updated(changed);
		if (changed.has("sessionId")) {
			if (this.sessionId) {
				this._loadHistory();
			}
		}

		if ((changed.has("cwd") || changed.has("projectId")) && this.cwd) {
			this._slashSkillsLoaded = false;
			this._loadSlashSkills();
		}

		if (changed.has("cwd") || changed.has("projectId")) {
			// Invalidate the @-mention file cache so the next `@` refetches.
			if (this._atFilesCwd !== this.cwd || this._atFilesProjectId !== this.projectId) {
				this._atFiles = [];
				this._atFilteredFiles = [];
				this._atMenuOpen = false;
			}
		}
	}

	override render() {
		const attachButton = this.showAttachmentButton
			? this.processingFiles
				? html`<div class="h-8 w-8 flex items-center justify-center shrink-0">${icon(Loader2, "sm", "animate-spin text-muted-foreground")}</div>`
				: Button({
						variant: "ghost",
						size: "icon",
						className: "h-8 w-8 shrink-0",
						onClick: this.handleAttachmentClick,
						title: "Attach files",
						children: icon(Paperclip, "sm"),
					})
			: "";

		const micButton = this.speechSupported
			? Button({
					variant: "ghost",
					size: "icon",
					className: `h-8 w-8 shrink-0 ${this.isRecording ? "text-red-500 animate-pulse" : ""}`,
					onClick: this.toggleSpeechRecognition,
					title: this.isRecording ? "Stop recording" : "Start recording",
					children: icon(this.isRecording ? MicOff : Mic, "sm"),
				})
			: "";

		const hasContent = this.value.trim() || this.attachments.length > 0;
		const abortButton = this.isStreaming
			? Button({
					variant: "ghost",
					size: "icon",
					onClick: this.onAbort,
					title: "Stop streaming",
					children: icon(Square, "sm"),
					className: "h-8 w-8 shrink-0",
				})
			: "";
		const sendButton = Button({
			variant: "ghost",
			size: "icon",
			onClick: this.handleSend,
			disabled: !hasContent || this.processingFiles,
			title: "Send message",
			children: icon(Send, "sm"),
			className: "h-8 w-8 shrink-0",
		});

		return html`
			<div
				class="bg-card rounded-xl border shadow-sm relative ${this.isDragging ? "border-primary border-2 bg-primary/5" : "border-border"}"
				@dragover=${this.handleDragOver}
				@dragleave=${this.handleDragLeave}
				@drop=${this.handleDrop}
			>
				<!-- Drag overlay -->
				${
					this.isDragging
						? html`
					<div class="absolute inset-0 bg-primary/10 rounded-xl pointer-events-none z-10 flex items-center justify-center">
						<div class="text-primary font-medium">${i18n("Drop files here")}</div>
					</div>
				`
						: ""
				}

				<!-- Attachments -->
				${
					this.attachments.length > 0
						? html`
							<div class="px-4 pt-3 pb-1 flex flex-wrap gap-2">
								${this.attachments.map(
									(attachment) => html`
										<attachment-tile
											.attachment=${attachment}
											.showDelete=${true}
											.onDelete=${() => this.removeFile(attachment.id)}
										></attachment-tile>
									`,
								)}
							</div>
						`
						: ""
				}

				<!-- Queued messages -->
				${this.queuedMessages.length > 0 ? html`
					<div class="px-3 pt-2 pb-1 flex flex-col gap-1.5">
						${(this._dragPreviewOrder
							? this._dragPreviewOrder.map(id => this.queuedMessages.find(m => m.id === id)).filter(Boolean) as QueuedMessage[]
							: this.queuedMessages
						).map((msg) => html`
							<div class="queue-pill flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg ${msg.isSteered ? "bg-amber-500/10 border border-amber-500/30" : "bg-muted/50 border border-border/50"} text-xs text-muted-foreground${this._draggedPillId === msg.id ? " opacity-50" : ""}" style="${this._draggedPillId === msg.id ? "opacity: 0.5" : ""}"
								data-pill-id="${msg.id}"
								data-steered="${msg.isSteered}"
								draggable="${!msg.isSteered}"
								@dragstart=${(e: DragEvent) => this._handlePillDragStart(e, msg)}
								@dragover=${(e: DragEvent) => this._handlePillDragOver(e, msg.id)}
								@drop=${(e: DragEvent) => this._handlePillDrop(e, msg.id)}
								@dragend=${this._handlePillDragEnd}
							>
								${!msg.isSteered ? html`<span class="drag-handle shrink-0 cursor-grab text-muted-foreground/50 hover:text-muted-foreground transition-colors">${icon(GripVertical, "xs")}</span>` : nothing}
								<span class="pill-text flex-1 truncate font-mono">${msg.text}</span>
								${msg.isSteered
									? html`<span class="sent-indicator shrink-0 flex items-center gap-1 px-1.5 py-0.5 text-[0.65rem] font-medium text-amber-600 dark:text-amber-400">${icon(Zap, "xs")} Sent</span>`
									: html`
										<button
											draggable="false"
											@click=${() => this.onSteer?.(msg)}
											class="steer-btn shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.65rem] font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400 hover:bg-amber-500/25 transition-colors cursor-pointer"
											title="Send now — interrupts the current turn"
										>${icon(Zap, "xs")} Steer</button>
										<button
											draggable="false"
											@click=${() => this.onEditQueued?.(msg)}
											class="edit-btn shrink-0 p-1 rounded text-muted-foreground/50 hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer"
											title="Edit message"
										>${icon(Pencil, "xs")}</button>
										<button
											draggable="false"
											@click=${() => this.onRemoveQueued?.(msg.id)}
											class="remove-btn shrink-0 p-1 rounded text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"
											title="Remove from queue"
										>${icon(X, "xs")}</button>
									`}
							</div>
						`)}
					</div>
				` : ""}

				<!-- Slash skill autocomplete -->
				${this._slashMenuOpen ? html`
					<div class="slash-menu border-b border-border max-h-48 overflow-y-auto" style="margin-left: ${this._getSlashMenuLeft()}px">
						${this._slashFilteredSkills.map((skill, i) => html`
							<button
								class="w-full text-left px-3 py-2 flex items-start gap-2 cursor-pointer transition-colors ${i === this._slashSelectedIndex ? "bg-accent text-accent-foreground" : "hover:bg-muted/50"}"
								data-testid=${`slash-command-${skill.name}`}
								@mousedown=${(e: Event) => { e.preventDefault(); this._selectSlashSkill(skill); }}
								@mouseenter=${() => { this._slashSelectedIndex = i; }}
							>
								<span class="font-mono text-sm text-primary shrink-0">/${skill.name}</span>
								${skill.argumentHint ? html`<span class="text-xs text-muted-foreground/60 shrink-0">${skill.argumentHint}</span>` : nothing}
								<span class="text-xs text-muted-foreground truncate">${skill.description}</span>
							</button>
						`)}
					</div>
				` : nothing}

				<!-- @-mention file autocomplete (reuses slash-menu styling) -->
				${this._atMenuOpen ? html`
					<div class="slash-menu at-menu border-b border-border max-h-48 overflow-y-auto" style="margin-left: ${this._getMenuLeft(this._atTokenStart)}px">
						${this._atFilteredFiles.map((filePath, i) => {
							const slash = filePath.lastIndexOf("/");
							const dir = slash >= 0 ? filePath.slice(0, slash + 1) : "";
							const base = slash >= 0 ? filePath.slice(slash + 1) : filePath;
							return html`
							<button
								class="w-full text-left px-3 py-2 flex items-center gap-2 cursor-pointer transition-colors ${i === this._atSelectedIndex ? "bg-accent text-accent-foreground" : "hover:bg-muted/50"}"
								data-testid=${`file-mention-${filePath}`}
								@mousedown=${(e: Event) => { e.preventDefault(); this._selectFileMention(filePath); }}
								@mouseenter=${() => { this._atSelectedIndex = i; }}
							>
								<span class="font-mono text-sm truncate"><span class="text-muted-foreground">@${dir}</span><span class="text-primary">${base}</span></span>
							</button>
						`;
						})}
					</div>
				` : nothing}

				<!-- Compact input row: [attach] [textarea] [mic] [send]
				     NOTE: transform: translateZ(0) is load-bearing on iOS Safari. Without its
				     own GPU compositing layer the textarea caret is invisible in this position
				     (bottom of viewport, nested flex). Do not remove without re-testing on iOS. -->
				${this._sendSizeError
					? html`<div
							data-testid="composer-size-error"
							class="mx-2 mb-1 px-2 py-1 text-xs rounded bg-destructive/10 text-destructive"
							role="alert"
						>${this._sendSizeError}</div>`
					: nothing}
				<div class="flex items-center gap-1 px-2 py-2" style="transform: translateZ(0);">
					${attachButton}
					<textarea
						class="flex-1 bg-transparent text-foreground placeholder-muted-foreground outline-none resize-none overflow-y-auto py-1 px-1"
						placeholder=${i18n("Type a message...")}
						rows="1"
						autocomplete="off"
						style="max-height: 200px; field-sizing: content; min-height: 1lh; height: auto;"
						.value=${live(this.value)}
						@input=${this.handleTextareaInput}
						@keydown=${this.handleKeyDown}
						@paste=${this.handlePaste}
						${ref(this.textareaRef)}
					></textarea>
					${micButton}${abortButton}${sendButton}
				</div>

				<!-- Hidden file input -->
				<input
					type="file"
					${ref(this.fileInputRef)}
					@change=${this.handleFilesSelected}
					accept=${this.acceptedTypes}
					multiple
					style="display: none;"
				/>

			</div>
		`;
	}
}
