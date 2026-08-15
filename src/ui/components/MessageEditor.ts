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
import { gatewayRoute } from "../../shared/base-path.js";
import { listLauncherEntrypoints, runLauncherEntrypoint } from "../../app/pack-entrypoints.js";
import {
	createComposerSlashRegistry,
	resolveComposerSlashDispatch,
	type ComposerRuntime,
	type ComposerSlashMenuItem,
} from "../../app/composer-slash-dispatch.js";
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
export type IntentKind = "prompt" | "steer";
export type IntentTargetTurn = "continuation" | "next-turn";
export type IntentDeliveryState =
	| "local"
	| "queued"
	| "dispatching"
	| "received"
	| "uncertain"
	| "failed"
	| "cancelled";

export interface QueuedMessage {
	id: string;
	text: string;
	images?: Array<{ type: "image"; data: string; mimeType: string }>;
	attachments?: unknown[];
	isSteered: boolean;
	dispatched?: boolean;
	kind?: IntentKind;
	targetTurn?: IntentTargetTurn;
	deliveryState?: IntentDeliveryState;
	deliveryError?: string;
	retryable?: boolean;
	/** Legacy pre-acceptance marker; normalized to the local delivery state. */
	unsent?: boolean;
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

	/** Inline error shown when the user attempts a Ctrl/Cmd+Enter steer while
	 *  attachments are present. The steer protocol is text-only, so we block the
	 *  action rather than silently dropping attachments or falling back to a
	 *  normal prompt. */
	static readonly STEER_ATTACHMENT_ERROR =
		"Steers don't support attachments. Remove them, or press Enter to send a normal prompt.";

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
	@property() isCompacting = false;
	@property() isAborting = false;
	@property() currentModel?: Model<any>;
	@property() thinkingLevel: ThinkingLevel = "off";
	@property() showAttachmentButton = true;
	@property() showModelSelector = true;
	@property() showThinkingSelector = true;
	@property() onInput?: (value: string) => void;
	@property() onSend?: (input: string, attachments: Attachment[]) => void | Promise<void>;
	/** Synchronous prompt fence. When set, normal send retains the complete draft
	 *  and returns before message-send, slash dispatch, history, or onSend. */
	@property() blockedSendReason?: string;
	@property() onAbort?: () => void;
	@property() onModelSelect?: () => void;
	@property() onThinkingChange?: (level: ThinkingLevel) => void;
	@property() onFilesChange?: (files: Attachment[]) => void;
	@property() onSteer?: (msg: QueuedMessage) => void;
	/** Distinct from `onSteer` (the queued-pill Steer button contract). Invoked by
	 *  the Ctrl/Cmd+Enter composer shortcut to send the current text through the
	 *  STEER path instead of the normal prompt path. Text-only. */
	@property() onSteerSend?: (text: string) => boolean | Promise<boolean>;
	@property() onRemoveQueued?: (id: string) => void;
	@property() onEditQueued?: (msg: QueuedMessage) => void;
	@property() onRetryQueued?: (msg: QueuedMessage) => void;
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
	/** Explicit server-provided session runtime; undefined is a real loading state. */
	@property() runtime: ComposerRuntime | undefined;
	@property({ attribute: false }) onCompact?: () => void | Promise<void>;

	@state() processingFiles = false;
	@state() isDragging = false;
	/** Non-empty when the last send was rejected for exceeding the aggregate
	 *  payload limit (S31). Shown as an inline error; cleared on the next edit. */
	@state() private _sendSizeError = "";
	/** Non-empty when a Ctrl/Cmd+Enter steer was blocked because attachments are
	 *  present. Shown as an inline error; cleared on the next edit or when the
	 *  attachments change. */
	@state() private _steerError = "";
	@state() private _blockedSendError = "";
	/** Content-aware submit-lock guarding BOTH the steer ({@link handleSteerShortcut})
	 *  and normal-send ({@link handleSend}) lifecycles against concurrent DUPLICATE
	 *  submission. Holds the exact text of every submit currently mid-flight (via any
	 *  path — steer or normal), so submitting the SAME text concurrently is blocked
	 *  (repeated Ctrl/Cmd+Enter of one snapshot; steer-in-flight + plain-Enter of the
	 *  same text) while a DISTINCT edited submission is still allowed to proceed. Plain
	 *  field — NOT `@state`, it must not trigger a re-render. */
	private _inFlightSubmits = new Set<string>();
	@state() private isRecording = false;
	private fileInputRef = createRef<HTMLInputElement>();

	// Command history state
	private _history: string[] = [];
	private _historyIndex = -1; // -1 = not browsing history
	private _savedDraft = ""; // draft saved when entering history mode

	// Slash skill autocomplete state
	@state() private _slashSkills: SlashSkillInfo[] = mergeBuiltInSlashCommands([]);
	/** Server-only token reservations for non-menu skill winners. */
	private _slashCollisionClaims: Array<{ name: string }> = [];
	@state() private _slashFilteredSkills: ComposerSlashMenuItem[] = [];
	@state() private _slashMenuOpen = false;
	@state() private _slashSelectedIndex = 0;
	@state() private _slashTokenStart = 0;
	private _slashSkillsLoaded = false;
	private _slashSkillsCwd?: string;
	private _slashSkillsProjectId?: string;
	private _slashLoadGeneration = 0;

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

	private _composerSlashRegistry() {
		return createComposerSlashRegistry({
			skills: this._slashSkills,
			collisionClaims: this._slashCollisionClaims,
			launchers: listLauncherEntrypoints("composer-slash"),
			runtime: this.runtime,
		});
	}

	private async _loadSlashSkills() {
		if (!this.cwd) {
			this._slashSkills = mergeBuiltInSlashCommands([]);
			this._slashCollisionClaims = [];
			this._slashSkillsLoaded = true;
			return;
		}
		if (this._slashSkillsLoaded && this._slashSkillsCwd === this.cwd && this._slashSkillsProjectId === this.projectId) return;
		const cwd = this.cwd;
		const projectId = this.projectId;
		const generation = ++this._slashLoadGeneration;
		try {
			let url = `/api/slash-skills?cwd=${encodeURIComponent(cwd)}`;
			if (projectId) url += `&projectId=${encodeURIComponent(projectId)}`;
			const res = await gatewayFetch(gatewayRoute(url));
			if (res.ok) {
				const data = await res.json();
				if (generation === this._slashLoadGeneration && this.cwd === cwd && this.projectId === projectId) {
					this._slashSkills = mergeBuiltInSlashCommands(Array.isArray(data.skills) ? data.skills : []);
					this._slashCollisionClaims = Array.isArray(data.collisionClaims) ? data.collisionClaims : [];
				}
			}
		} catch {
			if (generation === this._slashLoadGeneration && this.cwd === cwd && this.projectId === projectId) {
				this._slashSkills = mergeBuiltInSlashCommands([]);
				this._slashCollisionClaims = [];
			}
		}
		if (generation !== this._slashLoadGeneration || this.cwd !== cwd || this.projectId !== projectId) return;
		this._slashSkillsCwd = cwd;
		this._slashSkillsProjectId = projectId;
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
			const menuItems = this._composerSlashRegistry().menuItems;
			this._slashFilteredSkills = query
				? menuItems.filter((skill) => skill.name.toLowerCase().includes(query))
				: [...menuItems];
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

	private _selectSlashSkill(skill: ComposerSlashMenuItem) {
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
			const res = await gatewayFetch(gatewayRoute(url));
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

	/** CSS text-layout clone of the textarea, used for caret geometry. */
	private _createMirror(textarea: HTMLTextAreaElement): HTMLDivElement {
		const style = getComputedStyle(textarea);
		const mirror = document.createElement("div");
		// Every property that can move a line break or a line box must be copied
		// explicitly — the `font` shorthand does not reliably carry line-height.
		mirror.style.cssText = [
			"position:absolute",
			"top:-10000px",
			"left:0",
			"visibility:hidden",
			"white-space:pre-wrap",
			"word-wrap:break-word",
			"overflow-wrap:break-word",
			"margin:0",
			`width:${textarea.clientWidth}px`,
			`font-family:${style.fontFamily}`,
			`font-size:${style.fontSize}`,
			`font-weight:${style.fontWeight}`,
			`font-style:${style.fontStyle}`,
			`line-height:${style.lineHeight}`,
			`letter-spacing:${style.letterSpacing}`,
			`word-spacing:${style.wordSpacing}`,
			`tab-size:${style.tabSize}`,
			`text-indent:${style.textIndent}`,
			`text-transform:${style.textTransform}`,
			`padding:${style.padding}`,
			`border:${style.border}`,
			`box-sizing:${style.boxSizing}`,
		].join(";");
		return mirror;
	}

	/** Height of one visual row in the mirror. Uses the computed `line-height`
	 *  when it resolves to a length; `normal` is resolved by probing two rows of a
	 *  detached clone. Never derived by differencing integer `offsetHeight`s. */
	private _mirrorRowHeight(mirror: HTMLDivElement): number | null {
		const lineHeight = Number.parseFloat(getComputedStyle(mirror).lineHeight);
		if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight;

		// `line-height: normal` — measure the gap between two consecutive rows with
		// two single-character probes (same measurement basis as everything below).
		const probe = mirror.cloneNode(false) as HTMLDivElement;
		const text = document.createTextNode("X\nX");
		probe.appendChild(text);
		document.body.appendChild(probe);
		try {
			const first = this._charRectTop(text, 0);
			const second = this._charRectTop(text, 2);
			if (first === null || second === null) return null;
			const delta = second - first;
			return delta > 0 ? delta : null;
		} finally {
			probe.remove();
		}
	}

	/** Lay `value` out in a throwaway mirror of `textarea` and hand the callback the
	 *  single, UNSPLIT text node plus the resolved row height, so wrap points are
	 *  exactly the browser's own. Returns `null` (unmeasurable) when the row height
	 *  cannot be resolved — e.g. in a DOM implementation without a layout engine. */
	private _withMirror<T>(
		textarea: HTMLTextAreaElement,
		value: string,
		fn: (ctx: { text: Text; rowHeight: number; contentTop: number | null }) => T,
	): T | null {
		const mirror = this._createMirror(textarea);
		const text = document.createTextNode(value);
		mirror.appendChild(text);
		document.body.appendChild(mirror);
		try {
			const rowHeight = this._mirrorRowHeight(mirror);
			if (rowHeight === null || !(rowHeight > 0)) return null;
			return fn({ text, rowHeight, contentTop: this._contentTop(mirror) });
		} finally {
			mirror.remove();
		}
	}

	/** Index of the FIRST soft-wrap boundary inside the newline-free string `line`
	 *  (the offset of the first character of its second visual row), `null` when the
	 *  whole string fits on one visual row, or `"unknown"` when it cannot be
	 *  measured.
	 *
	 *  ONLY A BOUNDED PREFIX IS LAID OUT. Greedy line breaking decides row 0's break
	 *  from the characters up to the first overflow alone, so as soon as a prefix
	 *  wraps, that prefix's first break IS the full string's first break (later text
	 *  cannot move an earlier overflow); and a prefix can only fail to wrap where the
	 *  full string also has no break before the window's end — hence the growth loop.
	 *  This is what keeps a huge draft off the keydown critical path: the window stops
	 *  at roughly one row's worth of characters instead of laying out the whole value
	 *  (measured: ~1 ms vs ~135 ms for a 500 KB single-line draft, and Chromium
	 *  needs ~800 ms just to lay out a 200 K-row one).
	 *
	 *  The boundary itself is found by BINARY SEARCH over single-character rect tops,
	 *  which are monotonically non-decreasing in index — no per-row rect collection. */
	private _firstWrapBoundary(textarea: HTMLTextAreaElement, line: string): number | null | "unknown" {
		if (line.length < 2) return null;
		const START_WINDOW = 512;
		const GROWTH = 8;
		let windowLen = Math.min(line.length, START_WINDOW);
		for (;;) {
			const result = this._withMirror(textarea, line.substring(0, windowLen), ({ text, rowHeight, contentTop }) => {
				const tol = rowHeight / 2;
				const firstTop = this._charRowTop(text, 0, rowHeight, contentTop);
				const lastTop = this._charRowTop(text, windowLen - 1, rowHeight, contentTop);
				if (firstTop === null || lastTop === null) return "unknown" as const;
				if (lastTop - firstTop < tol) return "no-break" as const;
				// Smallest index whose line box is below the first row.
				let lo = 1;
				let hi = windowLen - 1;
				while (lo < hi) {
					const mid = (lo + hi) >> 1;
					const top = this._charRowTop(text, mid, rowHeight, contentTop);
					if (top === null) return "unknown" as const;
					if (top - firstTop >= tol) hi = mid;
					else lo = mid + 1;
				}
				return lo;
			});
			if (result === null || result === "unknown") return "unknown";
			if (typeof result === "number") return result;
			if (windowLen >= line.length) return null;
			windowLen = Math.min(line.length, windowLen * GROWTH);
		}
	}

	/** `top` of the line box of the SINGLE character at `index`, or `null` when the
	 *  character generates no rect.
	 *
	 *  This is the only rect primitive used by the caret geometry, and it is what
	 *  makes the measurement O(1) in the number of visual rows: collecting rects for
	 *  the whole value (and de-duplicating them) was O(rows^2) and froze the main
	 *  thread inside the keydown handler on large drafts (≈6 s at 500 KB).
	 *
	 *  Read-only: a `Range` never mutates the node, so the browser's own wrap points
	 *  are what gets measured. Verified in Chromium: every character kind —
	 *  ordinary glyph, space, tab, NBSP, zero-width space, surrogate half, first
	 *  char, last char AND `\n` — yields exactly one rect. A newline's rect sits on
	 *  the row that newline TERMINATES (so a caret immediately before a `\n` shares
	 *  that row, and a caret immediately after it is one row lower). */
	private _charRectTop(text: Text, index: number): number | null {
		if (index < 0 || index >= text.data.length) return null;
		const range = document.createRange();
		range.setStart(text, index);
		range.setEnd(text, index + 1);
		const rects = range.getClientRects();
		if (rects.length === 0) return null;
		const top = rects[0].top;
		return Number.isFinite(top) ? top : null;
	}

	/** `top` of the line box the character at `index` sits on, with a fallback for
	 *  engines where that character generates no rect: walk BACK to the nearest
	 *  character that does have one and add one `rowHeight` per newline crossed
	 *  (each crossed newline ends a row). Only string scanning is done here — no
	 *  per-row rect work — so this stays O(1) in the number of rows. Never returns a
	 *  different row than the character actually occupies; returns `null` rather
	 *  than guess. */
	private _charRowTop(text: Text, index: number, rowHeight: number, contentTop: number | null): number | null {
		const direct = this._charRectTop(text, index);
		if (direct !== null) return direct;
		const data = text.data;
		let rowsCrossed = 0;
		for (let j = index - 1; j >= 0; j--) {
			const top = this._charRectTop(text, j);
			if (top !== null) return top + rowsCrossed * rowHeight;
			if (data[j] === "\n") rowsCrossed++;
		}
		// Nothing before `index` renders at all — the first row starts at the mirror's
		// content-box top, and every row is then derived arithmetically from it.
		return contentTop === null ? null : contentTop + rowsCrossed * rowHeight;
	}

	/** Visual-row geometry of the caret, measured in ONE layout pass so every `top`
	 *  is directly comparable. Shared by BOTH predicates so the newline arithmetic
	 *  can never drift between them.
	 *
	 *  The mirror holds the value as a SINGLE, UNSPLIT text node and every quantity
	 *  is a single-character rect probe, so wrap points are exactly the browser's own
	 *  and the cost is independent of the number of rows. Inserting a marker at the
	 *  caret instead is NOT viable: it splits the text node and can move a
	 *  `break-word` soft-wrap point, which laid the marker out on the previous row
	 *  and reintroduced the original user-visible bug for wrapped content.
	 *
	 *  TWO CARET-ROW CANDIDATES, AND WHY. A textarea caret at an exact soft-wrap
	 *  boundary is genuinely ambiguous: offset `pos` is both the end of row N and
	 *  column 0 of row N+1 (real `Home` at the boundary puts the caret there with
	 *  downstream affinity), and that affinity is NOT observable from the DOM. So we
	 *  do not guess it — we measure both readings:
	 *    `beforeTop` — the row of the caret read as "just after the character at
	 *                  pos - 1"; a newline there means the caret starts a new row, so
	 *                  one `rowHeight` is added (CSS materialises no line box for the
	 *                  row a TRAILING newline opens, yet a textarea shows it).
	 *    `afterTop`  — the row of the caret read as "just before the character at
	 *                  pos", i.e. that character's own line box.
	 *  The predicates then require BOTH candidates to agree on being the first (or
	 *  last) row. At every unambiguous position the two candidates are on the same
	 *  row, so all established behaviour is preserved; at an ambiguous boundary they
	 *  disagree and both predicates return false, so the key MOVES THE CARET instead
	 *  of mutating history. That direction is deliberate: caret movement is
	 *  non-destructive and self-correcting (the next press, from an unambiguous
	 *  position, performs the history action), whereas a wrong history recall
	 *  destroys the user's draft. It also makes boundaries deterministic and
	 *  testable rather than affinity-dependent.
	 *
	 *  Returns `null` when the measurement is unusable (no layout engine, degenerate
	 *  rects, unresolvable row height); callers then fall back to permissive `true`,
	 *  preserving the pre-fix behaviour.
	 *
	 *  COST: O(1) rect probes, but Chromium must still lay the WHOLE value out, so the
	 *  predicates only reach this path when no cheaper structural fact settles the
	 *  answer — see `_isCursorOnVisualTopRow` / `_isCursorOnVisualBottomRow`. */
	private _measureCaretRowGeometry(): {
		beforeTop: number;
		afterTop: number;
		firstTop: number;
		lastTop: number;
		rowHeight: number;
	} | null {
		const textarea = this.textareaRef.value;
		if (!textarea) return null;
		const value = textarea.value;
		const pos = Math.max(0, Math.min(textarea.selectionStart, value.length));

		return this._withMirror(textarea, value, ({ text, rowHeight, contentTop }) => {
			// First row: the line box of character 0. (A newline there still has a rect,
			// on the row it terminates — i.e. row 0.)
			const firstTop = value.length > 0 ? this._charRowTop(text, 0, rowHeight, contentTop) : contentTop;
			if (firstTop === null || !Number.isFinite(firstTop)) return null;

			// Row of the caret read as "just after the character at `end - 1`".
			const rowAfterChar = (end: number): number | null => {
				if (end <= 0) return firstTop;
				const prev = this._charRowTop(text, end - 1, rowHeight, contentTop);
				if (prev === null) return null;
				// A newline ends its row, so the caret after it opens the next one.
				return value[end - 1] === "\n" ? prev + rowHeight : prev;
			};

			const lastTop = rowAfterChar(value.length);
			const beforeTop = rowAfterChar(pos);
			// Row of the caret read as "just before the character at `pos`". A newline
			// there needs no arithmetic: its rect already sits on the row it terminates,
			// which is the row the caret occupies.
			const afterTop = pos >= value.length ? lastTop : this._charRowTop(text, pos, rowHeight, contentTop);
			if (lastTop === null || beforeTop === null || afterTop === null) return null;
			if (!Number.isFinite(lastTop) || !Number.isFinite(beforeTop) || !Number.isFinite(afterTop)) return null;
			return { beforeTop, afterTop, firstTop, lastTop, rowHeight };
		});
	}

	/** Viewport `top` of an element's content box, or `null` if unmeasurable. */
	private _contentTop(el: HTMLElement): number | null {
		const rect = el.getBoundingClientRect();
		const style = getComputedStyle(el);
		const border = Number.parseFloat(style.borderTopWidth) || 0;
		const padding = Number.parseFloat(style.paddingTop) || 0;
		const top = rect.top + border + padding;
		return Number.isFinite(top) ? top : null;
	}

	/** True when BOTH readings of the caret's row (see `_measureCaretRowGeometry`)
	 *  are the FIRST visual row — i.e. ArrowUp may recall history instead of moving
	 *  the caret. At an ambiguous soft-wrap boundary the two readings disagree, so
	 *  this is false and the caret moves (the non-destructive direction).
	 *
	 *  Decided structurally, WITHOUT laying the value out, wherever that is exact:
	 *  the caret is on the first visual row iff no hard newline precedes it and it is
	 *  inside the first wrap segment of the first line. Only the first line's leading
	 *  window is ever measured, which keeps a large draft off the keydown critical
	 *  path (the previous whole-value measurement took ~1 s at 200 KB and ~6 s at
	 *  500 KB, synchronously inside this handler). */
	private _isCursorOnVisualTopRow(): boolean {
		const textarea = this.textareaRef.value;
		if (!textarea) return true;
		if (textarea.selectionStart === 0) return true;
		const value = textarea.value;
		const pos = Math.max(0, Math.min(textarea.selectionStart, value.length));

		// A hard break before the caret puts it below the first visual row. Also covers
		// the original bug: at column 0 of any later line, `pos - 1` IS that newline.
		if (value.lastIndexOf("\n", pos - 1) !== -1) return false;

		const firstLineEnd = value.indexOf("\n");
		const firstLine = firstLineEnd === -1 ? value : value.substring(0, firstLineEnd);
		const boundary = this._firstWrapBoundary(textarea, firstLine);
		if (boundary === "unknown") return true; // unmeasurable — permissive, as before
		if (boundary === null) return true; // the first line never wraps
		// `pos === boundary` is the ambiguous case: the two readings straddle the wrap,
		// so it is deliberately NOT the top row.
		return pos < boundary;
	}

	/** True when BOTH readings of the caret's row are the LAST visual row. Mirror of
	 *  `_isCursorOnVisualTopRow`: at an ambiguous boundary ArrowDown moves the caret
	 *  instead of advancing/leaving history.
	 *
	 *  Cheap paths first, each of them EXACT:
	 *   1. a hard newline at/after the caret ⇒ a later visual row exists ⇒ false;
	 *   2. if the text after the caret wraps even when laid out from column 0 with the
	 *      FULL width, then it certainly wraps on the caret's partially-filled row, so
	 *      a later row exists ⇒ false. (One-directional: less room can only break
	 *      earlier, never later.)
	 *  Only when the whole tail fits on one row from column 0 — i.e. the caret is
	 *  within about a row of the end — does the exact answer depend on how much room
	 *  is left on the caret's own row, which needs the full-value geometry. */
	private _isCursorOnVisualBottomRow(): boolean {
		const textarea = this.textareaRef.value;
		if (!textarea) return true;
		const value = textarea.value;
		if (textarea.selectionStart >= value.length) return true;
		const pos = Math.max(0, textarea.selectionStart);

		if (value.indexOf("\n", pos) !== -1) return false;

		const tailBreak = this._firstWrapBoundary(textarea, value.substring(pos));
		if (tailBreak === "unknown") return true; // unmeasurable — permissive, as before
		if (tailBreak !== null) return false;

		const geo = this._measureCaretRowGeometry();
		if (!geo) return true;
		const tol = geo.rowHeight / 2;
		return Math.abs(geo.beforeTop - geo.lastTop) < tol && Math.abs(geo.afterTop - geo.lastTop) < tol;
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

	private _intentKind(msg: QueuedMessage): IntentKind {
		return msg.kind ?? (msg.isSteered ? "steer" : "prompt");
	}

	private _intentTarget(msg: QueuedMessage): IntentTargetTurn {
		return msg.targetTurn ?? (this._intentKind(msg) === "steer" ? "continuation" : "next-turn");
	}

	private _intentState(msg: QueuedMessage): IntentDeliveryState {
		if (msg.deliveryState) return msg.deliveryState;
		if (msg.unsent) return "local";
		return msg.dispatched ? "dispatching" : "queued";
	}

	private _intentStatus(msg: QueuedMessage): string {
		const state = this._intentState(msg);
		switch (state) {
			case "local": return "Waiting for connection";
			case "dispatching": return "Sending…";
			case "received": return "Adding to chat…";
			case "uncertain": return "Awaiting delivery confirmation";
			case "failed": return "Not delivered";
			case "cancelled": return "Cancelled";
			case "queued":
			default:
				if (this.isAborting) return "Stopping current turn — message remains queued";
				if (this.isCompacting) return this._intentTarget(msg) === "continuation"
					? "Compacting — steer queued for current turn"
					: "Compacting — queued for next turn";
				return this._intentTarget(msg) === "continuation"
					? "Steer queued for current turn"
					: "Queued for next turn";
		}
	}

	private handleTextareaInput = (e: Event) => {
		const textarea = e.target as HTMLTextAreaElement;
		this.value = textarea.value;
		if (this._sendSizeError) this._sendSizeError = ""; // clear the S31 error once the user edits
		if (this._steerError) this._steerError = ""; // clear the steer-attachment error once the user edits
		if (this._blockedSendError) this._blockedSendError = "";
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

		// Ctrl/Cmd+Enter steer shortcut. Placed AFTER the slash/@-menu blocks (so an
		// open autocomplete keeps Enter ownership) and BEFORE the plain Enter branch
		// (Ctrl/Cmd+Enter also satisfies `!e.shiftKey`). IME is already guarded above.
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
			e.preventDefault();
			void this.handleSteerShortcut();
			return;
		}

		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (!this.processingFiles && (this.value.trim() || this.attachments.length > 0)) {
				this.handleSend();
			}
		} else if (e.key === "Escape" && (this.isStreaming || this.isCompacting) && !this.isAborting) {
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
			this._steerError = "";
			this.onFilesChange?.(this.attachments);
			this.processingFiles = false;
		}
	};

	private _composerDispatchAlert(kind: "unsupported-compact" | "unavailable-compact" | "compact" | "skill" | "launcher"): string {
		switch (kind) {
			case "unsupported-compact":
				return "Manual compaction isn’t available for Claude Agent SDK sessions.";
			case "unavailable-compact":
				return "Manual compaction is unavailable until the session runtime is ready.";
			default:
				return "Slash commands can’t be sent as steers. Press Enter to send a normal prompt.";
		}
	}

	public showBlockedSendError(reason: string): void {
		this._blockedSendError = reason;
	}

	private handleSend = async () => {
		const text = this.value;
		if (this.blockedSendReason) {
			this.showBlockedSendError(this.blockedSendReason);
			return;
		}
		// Content-aware lock: block only an identical concurrent submission (same text
		// mid-flight via any path); a distinct edited submission is still allowed.
		if (this._inFlightSubmits.has(text)) return;
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
		this._steerError = ""; // a normal send dismisses any stale steer-attachment alert (D2)
		const dispatch = resolveComposerSlashDispatch(text, { runtime: this.runtime, registry: this._composerSlashRegistry() });
		if (dispatch?.kind === "unsupported-compact" || dispatch?.kind === "unavailable-compact") {
			this._steerError = this._composerDispatchAlert(dispatch.kind);
			return;
		}
		if (dispatch?.kind === "compact") {
			if (this.attachments.length > 0) {
				this._steerError = "Remove attachments before compacting.";
				return;
			}
			this._slashMenuOpen = false;
			this._inFlightSubmits.add(text);
			try {
				this.dispatchEvent(new CustomEvent("message-send", { bubbles: true, composed: true }));
				this._historyIndex = -1;
				this._savedDraft = "";
				void this.addToHistory(text);
				await this.onCompact?.();
			} finally {
				this._inFlightSubmits.delete(text);
			}
			return;
		}
		if (dispatch?.kind === "launcher" && this.attachments.length === 0) {
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
			this._showLauncherPending(`Starting ${dispatch.label}…`);
			runLauncherEntrypoint(dispatch.entrypointKey, (r) => {
				if (r.ok) this._showLauncherResolved();
				else this._showLauncherError(r.error || `Could not start ${dispatch.label}.`);
			}, { body: dispatch.body });
			return;
		}
	// Dispatch a composed event that escapes shadow DOM — used by
		// session-manager for draft cleanup without monkey-patching. Take the shared
		// content-aware submit-lock so an identical steer/send can't run concurrently.
		this._inFlightSubmits.add(text);
		try {
			this.dispatchEvent(new CustomEvent("message-send", { bubbles: true, composed: true }));
			// Reset history browsing state after send
			this._historyIndex = -1;
			this._savedDraft = "";
			// Add to history (fire and forget)
			void this.addToHistory(text);
			await this.onSend?.(text, this.attachments);
		} finally {
			this._inFlightSubmits.delete(text);
		}
	};

	/** Ctrl/Cmd+Enter: send the current text through the STEER path. Text-only:
	 *  attachments are blocked with an inline error rather than silently dropped or
	 *  downgraded to a normal prompt.
	 *
	 *  Transactional/readiness-first: NO irreversible lifecycle work (draft
	 *  tombstone, history, editor clear) happens until `onSteerSend` confirms the
	 *  send with a `true` result. On confirmation, the draft is cleared/tombstoned
	 *  ONLY if the composer still holds exactly what we sent — a mid-flight edit or a
	 *  newly added attachment during the await is preserved, never discarded. */
	private handleSteerShortcut = async () => {
		if (this.blockedSendReason) {
			this.showBlockedSendError(this.blockedSendReason);
			return;
		}
		if (this.processingFiles) return; // same readiness guard as send
		const text = this.value;
		if (!text.trim()) return; // non-empty text required
		// Steers bypass server prompt expansion and local launcher dispatch. Refuse
		// every exact Bobbit-owned command before attachment/lock/send handling so
		// none can reach a runtime as raw text.
		const dispatch = resolveComposerSlashDispatch(text, { runtime: this.runtime, registry: this._composerSlashRegistry() });
		if (dispatch) {
			this._steerError = this._composerDispatchAlert(dispatch.kind);
			return;
		}
		if (this.attachments.length > 0) {
			// Block: retain text, attachments, draft, and focus untouched.
			this._steerError = MessageEditor.STEER_ATTACHMENT_ERROR;
			return;
		}
		// Content-aware submit-lock: while the async readiness/send await is pending the
		// composer stays enabled, so a second Ctrl/Cmd+Enter (or key auto-repeat) — or a
		// normal send via handleSend — could re-enter with the SAME unchanged snapshot and
		// submit the identical text twice. Bail only if this exact text is already in
		// flight; a distinct edited steer is still allowed through.
		if (this._inFlightSubmits.has(text)) return;
		// Capture the session this steer originated on. Its async preflight may resolve
		// AFTER a session switch; the success cleanup below is guarded to only touch the
		// composer while we're still on this originating session.
		const originSessionId = this.sessionId;
		this._steerError = "";
		this._sendSizeError = "";
		this._inFlightSubmits.add(text);
		try {
			// Await readiness + send BEFORE any irreversible lifecycle work. A failed or
			// cancelled preflight leaves the draft, text, and history fully intact.
			const sent = await this.onSteerSend?.(text);
			if (sent !== true) return;
			// Confirmed sent: record the sent text in command history.
			this._historyIndex = -1;
			this._savedDraft = "";
			void this.addToHistory(text);
			// Clear + tombstone the draft ONLY if the composer still holds exactly what we
			// sent. A mid-flight text edit or a newly added attachment must be preserved.
			// `!processingFiles`: a file load started during the readiness await sets
			// processingFiles=true but hasn't populated `attachments` yet, so the length
			// check alone would pass and wipe the text draft out from under the pending
			// attachment. Preserve the composer text while a file is mid-processing.
		// `this.sessionId === originSessionId`: a steer whose preflight resolves after a
		// session switch must NOT clear/tombstone the now-current (different) session's
		// composer. (Fully tombstoning the ORIGIN session's draft on switch-away is a
		// documented follow-up requiring session-manager changes — out of scope here.)
			if (this.sessionId === originSessionId && this.value === text && this.attachments.length === 0 && !this.processingFiles) {
				this.dispatchEvent(new CustomEvent("message-send", { bubbles: true, composed: true }));
				this.value = "";
				this.onInput?.(this.value);
				const ta = this.textareaRef.value;
				if (ta) {
					ta.value = "";
					ta.focus();
				}
			}
		} finally {
			this._inFlightSubmits.delete(text);
		}
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
		this._steerError = "";
		this.onFilesChange?.(this.attachments);
		this.processingFiles = false;
		input.value = ""; // Reset input
	}

	private removeFile(fileId: string) {
		this.attachments = this.attachments.filter((f) => f.id !== fileId);
		this._steerError = ""; // removing an attachment dismisses the steer-attachment error
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
		this._steerError = "";
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
		if (changed.has("blockedSendReason") && !this.blockedSendReason) {
			this._blockedSendError = "";
		}

		if (changed.has("sessionId") || changed.has("cwd") || changed.has("projectId") || changed.has("runtime")) {
			// Session/project/runtime changes must not momentarily offer a stale scoped
			// skill or runtime-specific control while their fresh catalog reconciles.
			this._slashLoadGeneration++;
			this._slashSkillsLoaded = false;
			this._slashSkills = mergeBuiltInSlashCommands([]);
			this._slashCollisionClaims = [];
			this._slashFilteredSkills = [];
			this._slashMenuOpen = false;
			if (this.cwd) void this._loadSlashSkills();
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
		const hasActiveTurn = this.isStreaming || this.isCompacting || this.isAborting;
		const stopLabel = this.isAborting ? "Stopping current turn" : "Stop current turn";
		const abortButton = hasActiveTurn
			? Button({
					variant: "ghost",
					size: "icon",
					onClick: this.isAborting ? undefined : this.onAbort,
					disabled: this.isAborting,
					title: stopLabel,
					children: html`${icon(this.isAborting ? Loader2 : Square, "sm", this.isAborting ? "animate-spin" : "")}<span class="sr-only">${stopLabel}</span>`,
					className: "stop-current-turn h-8 w-8 shrink-0",
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

				<!-- Server-projected message outbox. A row remains here until the
				     correlated user message is surfaced in the transcript. -->
				${this.queuedMessages.length > 0 ? html`
					<div
						class="message-outbox px-3 pt-2 pb-1 flex flex-col gap-1.5"
						data-testid="message-outbox"
						role="list"
						aria-label="Message outbox"
						aria-live="polite"
					>
						${(this._dragPreviewOrder
							? this._dragPreviewOrder.map(id => this.queuedMessages.find(m => m.id === id)).filter(Boolean) as QueuedMessage[]
							: this.queuedMessages
						).map((msg) => {
							const kind = this._intentKind(msg);
							const targetTurn = this._intentTarget(msg);
							const deliveryState = this._intentState(msg);
							const status = this._intentStatus(msg);
							const canReorder = !msg.isSteered && deliveryState === "queued";
							const isFailed = deliveryState === "failed";
							const isCancelled = deliveryState === "cancelled";
							const isUncertain = deliveryState === "uncertain";
							const canRetry = (isFailed || isCancelled) && msg.retryable !== false;
							return html`
							<div
								class="queue-pill intent-row flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg ${kind === "steer" ? "bg-amber-500/10 border border-amber-500/30" : "bg-muted/50 border border-border/50"} text-xs text-muted-foreground${this._draggedPillId === msg.id ? " opacity-50" : ""}"
								style="${this._draggedPillId === msg.id ? "opacity: 0.5" : ""}"
								data-testid="intent-row"
								data-pill-id=${msg.id}
								data-intent-id=${msg.id}
								data-intent-kind=${kind}
								data-target-turn=${targetTurn}
								data-delivery-state=${deliveryState}
								data-steered=${msg.isSteered ? "true" : "false"}
								role="listitem"
								draggable=${canReorder ? "true" : "false"}
								@dragstart=${(e: DragEvent) => this._handlePillDragStart(e, msg)}
								@dragover=${(e: DragEvent) => this._handlePillDragOver(e, msg.id)}
								@drop=${(e: DragEvent) => this._handlePillDrop(e, msg.id)}
								@dragend=${this._handlePillDragEnd}
							>
								${canReorder ? html`<span class="drag-handle shrink-0 cursor-grab text-muted-foreground/50 hover:text-muted-foreground transition-colors" aria-hidden="true">${icon(GripVertical, "xs")}</span>` : nothing}
								<span class="pill-text min-w-0 flex-1 truncate font-mono" title=${msg.text}>${msg.text}</span>
								<span
									class="intent-status shrink-0 text-[0.65rem] font-medium ${isFailed || isCancelled ? "text-destructive" : kind === "steer" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}"
									data-testid="intent-status"
									role=${isFailed ? "alert" : "status"}
									title=${msg.deliveryError || status}
								>${status}</span>
								${isUncertain ? html`
									<button type="button" draggable="false" @click=${() => this.onRemoveQueued?.(msg.id)} class="remove-btn shrink-0 px-1.5 py-0.5 rounded text-[0.65rem] font-medium hover:bg-destructive/10 hover:text-destructive cursor-pointer" aria-label="Dismiss unconfirmed delivery">Dismiss</button>
								` : isFailed || isCancelled ? html`
									${canRetry ? html`<button type="button" draggable="false" @click=${() => this.onRetryQueued?.(msg)} class="retry-btn shrink-0 px-1.5 py-0.5 rounded text-[0.65rem] font-medium hover:bg-primary/10 hover:text-primary cursor-pointer" aria-label="Retry">Retry</button>` : nothing}
									${isFailed ? html`<button type="button" draggable="false" @click=${() => this.onEditQueued?.(msg)} class="edit-btn shrink-0 px-1.5 py-0.5 rounded text-[0.65rem] font-medium hover:bg-primary/10 hover:text-primary cursor-pointer" aria-label="Edit">Edit</button>` : nothing}
									<button type="button" draggable="false" @click=${() => this.onRemoveQueued?.(msg.id)} class="remove-btn shrink-0 px-1.5 py-0.5 rounded text-[0.65rem] font-medium hover:bg-destructive/10 hover:text-destructive cursor-pointer" aria-label="Dismiss">Dismiss</button>
								` : deliveryState === "queued" && kind === "prompt" ? html`
									<button type="button" draggable="false" @click=${() => this.onSteer?.(msg)} class="steer-btn shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.65rem] font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400 hover:bg-amber-500/25 transition-colors cursor-pointer" title="Send now — interrupts the current turn">${icon(Zap, "xs")} Steer</button>
									<button type="button" draggable="false" @click=${() => this.onEditQueued?.(msg)} class="edit-btn shrink-0 p-1 rounded text-muted-foreground/50 hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer" title="Edit message" aria-label="Edit">${icon(Pencil, "xs")}</button>
									<button type="button" draggable="false" @click=${() => this.onRemoveQueued?.(msg.id)} class="remove-btn shrink-0 p-1 rounded text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer" title="Dismiss message" aria-label="Dismiss">${icon(X, "xs")}</button>
								` : nothing}
							</div>`;
						})}
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
				${(this._blockedSendError || this._sendSizeError || this._steerError)
					? html`<div
							data-testid=${this._blockedSendError
								? "composer-model-selection-error"
								: this._steerError ? "composer-steer-error" : "composer-size-error"}
							class="mx-2 mb-1 px-2 py-1 text-xs rounded bg-destructive/10 text-destructive"
							role="alert"
						>${this._blockedSendError || this._steerError || this._sendSizeError}</div>`
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
