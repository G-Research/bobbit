import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Select, type SelectOption } from "@mariozechner/mini-lit/dist/Select.js";
import type { Model } from "@mariozechner/pi-ai";
import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import { live } from "lit/directives/live.js";
import { Brain, Loader2, Mic, MicOff, Paperclip, Send, Sparkles, Square, Zap, X } from "lucide";
import { type Attachment, loadAttachment } from "../utils/attachment-utils.js";
import { i18n } from "../utils/i18n.js";
import { getAppStorage } from "../storage/app-storage.js";
import "./AttachmentTile.js";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

/** Server-authoritative queued message (mirrors server QueuedMessage from protocol.ts) */
export interface QueuedMessage {
	id: string;
	text: string;
	images?: Array<{ type: "image"; data: string; mimeType: string }>;
	attachments?: unknown[];
	isSteered: boolean;
	dispatched?: boolean;
	createdAt: number;
}

@customElement("message-editor")
export class MessageEditor extends LitElement {
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
	@property() onThinkingChange?: (level: "off" | "minimal" | "low" | "medium" | "high") => void;
	@property() onFilesChange?: (files: Attachment[]) => void;
	@property() onSteer?: (msg: QueuedMessage) => void;
	@property() onRemoveQueued?: (id: string) => void;
	@property() attachments: Attachment[] = [];
	@property({ type: Array }) queuedMessages: QueuedMessage[] = [];
	@property() maxFiles = 10;
	@property() maxFileSize = 20 * 1024 * 1024; // 20MB
	@property() acceptedTypes =
		"image/*,application/pdf,.docx,.pptx,.xlsx,.xls,.txt,.md,.json,.xml,.html,.css,.js,.ts,.jsx,.tsx,.yml,.yaml";

	@state() processingFiles = false;
	@state() isDragging = false;
	@state() private isRecording = false;
	private fileInputRef = createRef<HTMLInputElement>();

	// Command history state
	private _history: string[] = [];
	private _historyIndex = -1; // -1 = not browsing history
	private _savedDraft = ""; // draft saved when entering history mode
	private _historyLoaded = false;

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
			this._historyLoaded = true;
		} catch {
			// Storage not available — history won't work but that's fine
			this._history = [];
			this._historyLoaded = true;
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

	private _isCursorOnFirstLine(): boolean {
		const textarea = this.textareaRef.value;
		if (!textarea) return true;
		const pos = textarea.selectionStart;
		// On first line if no newline before cursor position
		return textarea.value.lastIndexOf("\n", pos - 1) === -1;
	}

	private handleTextareaInput = (e: Event) => {
		const textarea = e.target as HTMLTextAreaElement;
		this.value = textarea.value;
		this.onInput?.(this.value);
	};

	private handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (!this.processingFiles && (this.value.trim() || this.attachments.length > 0)) {
				this.handleSend();
			}
		} else if (e.key === "Escape" && this.isStreaming) {
			e.preventDefault();
			this.onAbort?.();
		} else if (e.key === "ArrowUp" && this._history.length > 0 && this._isCursorOnFirstLine()) {
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
		} else if (e.key === "ArrowDown" && this._historyIndex !== -1) {
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

					const attachment = await loadAttachment(file);
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

				const attachment = await loadAttachment(file);
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

				const attachment = await loadAttachment(file);
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
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		document.removeEventListener("keydown", this.handleGlobalKeyDown);
		document.removeEventListener("keyup", this.handleGlobalKeyUp);
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
	}

	override render() {
		// Check if current model supports thinking/reasoning
		const model = this.currentModel;
		const supportsThinking = model?.reasoning === true; // Models with reasoning:true support thinking

		const attachButton = this.showAttachmentButton
			? this.processingFiles
				? html`<div class="h-8 w-8 flex items-center justify-center shrink-0">${icon(Loader2, "sm", "animate-spin text-muted-foreground")}</div>`
				: Button({
						variant: "ghost",
						size: "icon",
						className: "h-8 w-8 shrink-0",
						onClick: this.handleAttachmentClick,
						children: icon(Paperclip, "sm"),
					})
			: "";

		const micButton = this.speechSupported
			? Button({
					variant: "ghost",
					size: "icon",
					className: `h-8 w-8 shrink-0 ${this.isRecording ? "text-red-500 animate-pulse" : ""}`,
					onClick: this.toggleSpeechRecognition,
					children: icon(this.isRecording ? MicOff : Mic, "sm"),
				})
			: "";

		const hasContent = this.value.trim() || this.attachments.length > 0;
		const abortButton = this.isStreaming
			? Button({
					variant: "ghost",
					size: "icon",
					onClick: this.onAbort,
					children: icon(Square, "sm"),
					className: "h-8 w-8 shrink-0",
				})
			: "";
		const sendButton = Button({
			variant: "ghost",
			size: "icon",
			onClick: this.handleSend,
			disabled: !hasContent || this.processingFiles,
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
						${this.queuedMessages.map((msg) => html`
							<div class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg ${msg.isSteered ? "bg-amber-500/10 border border-amber-500/30" : "bg-muted/50 border border-border/50"} text-xs text-muted-foreground">
								<span class="flex-1 truncate font-mono">${msg.text}</span>
								${msg.isSteered
									? html`<span class="shrink-0 flex items-center gap-1 px-1.5 py-0.5 text-[0.65rem] font-medium text-amber-600 dark:text-amber-400">${icon(Zap, "xs")} Sent</span>`
									: html`
										<button
											@click=${() => this.onSteer?.(msg)}
											class="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.65rem] font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400 hover:bg-amber-500/25 transition-colors cursor-pointer"
											title="Send now — interrupts the current turn"
										>${icon(Zap, "xs")} Steer</button>
										<button
											@click=${() => this.onRemoveQueued?.(msg.id)}
											class="shrink-0 p-0.5 rounded text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"
											title="Remove from queue"
										>${icon(X, "xs")}</button>
									`}
							</div>
						`)}
					</div>
				` : ""}

				<!-- Compact input row: [attach] [textarea] [mic] [send] -->
				<div class="flex items-center gap-1 px-2 py-2">
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
