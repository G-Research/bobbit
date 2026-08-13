/**
 * Truncates large message content in agent events before broadcasting
 * over WebSocket and storing in EventBuffer.
 *
 * This prevents catastrophic memory pressure when agents write large files
 * or produce large verification artifacts — each event would otherwise carry
 * the full accumulated payload through JSON serialization and replay buffers.
 *
 * The original event is never mutated — a shallow clone is returned when
 * truncation occurs. Events that don't need truncation are returned as-is
 * (zero overhead).
 */

/** Default threshold: 32KB. Normal code files pass through untouched. */
export const LARGE_CONTENT_THRESHOLD = 32 * 1024;

const PREVIEW_LENGTH = 512;

/**
 * Sentinel prefixes on preview_open snapshot tool_result text blocks.
 * Recognises v1/v2/v3 — only v1 ever needs truncation in practice (v2/v3
 * are constant ~250 bytes), but matching all three keeps the truncation
 * layer aligned with what the renderer accepts.
 *
 * Mirrors `PREVIEW_SNAPSHOT_MARKERS` in `defaults/tools/html/snapshot.ts`;
 * inlined here because `defaults/` lives outside the server `rootDir` and
 * `src/ui/tools/renderers/PreviewRenderer.ts` follows the same pattern.
 */
const PREVIEW_SNAPSHOT_MARKERS = [
	"__preview_snapshot_v1__\n",
	"__preview_snapshot_v2__\n",
	"__preview_snapshot_v3__\n",
] as const;

const VERIFICATION_RESULT_LARGE_FIELDS = ["summary", "report_html"] as const;

// Mirrors the executable review_open contract without importing defaults/
// across the server rootDir boundary. The projection is transport-only;
// extension and payload-store validation remain authoritative.
const MAX_PROJECTED_REVIEW_FILES = 64;
const MAX_PROJECTED_REVIEW_METADATA_BYTES = 24 * 1024;
const MAX_PROJECTED_REVIEW_TITLE_BYTES = 320;
const REVIEW_OPEN_FIELDS = new Set(["title", "replace", "markdown", "file", "files"]);
const REVIEW_FILE_FIELDS = new Set(["title", "markdown", "file"]);
const INVALID_REVIEW_TITLE_CHARACTERS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

interface ProjectedReviewMarkdown {
	_truncated: true;
	_originalLength: number;
	_originalBytes: number;
}

interface ProjectedReviewInvalid {
	_invalid: true;
	_reason: "invalid_review_input" | "review_metadata_too_large" | "too_many_review_files";
	_originalLength?: number;
	_originalBytes?: number;
	_originalCount?: number;
	_maximumCount?: number;
}

/** Return the matched marker prefix, or undefined if none matches. */
function matchMarker(text: string): string | undefined {
	for (const m of PREVIEW_SNAPSHOT_MARKERS) {
		if (text.startsWith(m)) return m;
	}
	return undefined;
}

export interface TruncatedContent {
	_truncated: true;
	_originalLength: number;
	preview: string;
}

function truncatedStringDescriptor(text: string): TruncatedContent {
	return {
		_truncated: true,
		_originalLength: text.length,
		preview: text.slice(0, PREVIEW_LENGTH),
	};
}

function isLargeString(value: any, threshold: number): value is string {
	return typeof value === "string" && value.length > threshold;
}

/**
 * If `block` is a text block whose `text` starts with the preview snapshot
 * marker and exceeds `threshold`, return a shallow-cloned truncated block.
 * Otherwise returns the original block (referential equality).
 *
 * The resulting block keeps its marker prefix (so downstream consumers can
 * still detect it) and embeds a `TruncatedContent` descriptor alongside the
 * preview text (first 512 chars of the full snapshot, excluding the marker).
 */
export function truncateSnapshotBlock(block: any, threshold: number = LARGE_CONTENT_THRESHOLD): any {
	if (!block || block.type !== "text" || typeof block.text !== "string") return block;
	const marker = matchMarker(block.text);
	if (!marker) return block;
	if (block._truncated) return block;
	if (block.text.length <= threshold) return block;
	const html = block.text.slice(marker.length);
	return {
		...block,
		text: marker,
		_truncated: true,
		_originalLength: block.text.length,
		preview: html.slice(0, PREVIEW_LENGTH),
	};
}

function truncateTextBlock(block: any, threshold: number): any {
	const snapshot = truncateSnapshotBlock(block, threshold);
	if (snapshot !== block) return snapshot;
	if (!block || block.type !== "text" || typeof block.text !== "string") return block;
	if (block._truncated) return block;
	if (block.text.length <= threshold) return block;
	const preview = block.text.slice(0, PREVIEW_LENGTH);
	return {
		...block,
		text: preview,
		_truncated: true,
		_originalLength: block.text.length,
		preview,
	};
}

/** Helper: check if a content block is a tool call (either format) */
function isToolBlock(block: any): boolean {
	return block?.type === "toolCall" || block?.type === "tool_use";
}

function isVerificationResultTool(block: any): boolean {
	return block?.name === "verification_result";
}

function isReviewOpenTool(block: any): boolean {
	return block?.name === "review_open";
}

function projectedReviewMarkdown(markdown: string): ProjectedReviewMarkdown {
	return {
		_truncated: true,
		_originalLength: markdown.length,
		_originalBytes: Buffer.byteLength(markdown, "utf8"),
	};
}

function projectedReviewInvalid(
	reason: ProjectedReviewInvalid["_reason"],
	details: Omit<ProjectedReviewInvalid, "_invalid" | "_reason"> = {},
): ProjectedReviewInvalid {
	return { _invalid: true, _reason: reason, ...details };
}

function projectedReviewString(value: unknown, budget: { bytes: number }, title: boolean): string | ProjectedReviewInvalid {
	if (typeof value !== "string") return projectedReviewInvalid("invalid_review_input");
	const bytes = Buffer.byteLength(value, "utf8");
	if ((title && (bytes > MAX_PROJECTED_REVIEW_TITLE_BYTES || INVALID_REVIEW_TITLE_CHARACTERS.test(value)))
		|| budget.bytes + bytes > MAX_PROJECTED_REVIEW_METADATA_BYTES) {
		return projectedReviewInvalid("review_metadata_too_large", {
			_originalLength: value.length,
			_originalBytes: bytes,
		});
	}
	budget.bytes += bytes;
	return value;
}

function hasOwn(value: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function isReviewProjectionRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProjectedReviewInvalid(value: unknown): value is ProjectedReviewInvalid {
	return isReviewProjectionRecord(value)
		&& value._invalid === true
		&& (value._reason === "invalid_review_input"
			|| value._reason === "review_metadata_too_large"
			|| value._reason === "too_many_review_files");
}

function isProjectedReviewMarkdown(value: unknown): value is ProjectedReviewMarkdown {
	return isReviewProjectionRecord(value)
		&& value._truncated === true
		&& typeof value._originalLength === "number"
		&& typeof value._originalBytes === "number";
}

function stripUnexpectedReviewFields(source: Record<string, unknown>, allowed: Set<string>): Record<string, unknown> {
	let hasUnexpected = false;
	for (const key in source) {
		if (hasOwn(source, key) && !allowed.has(key)) {
			hasUnexpected = true;
			break;
		}
	}
	if (!hasUnexpected) return source;

	const projected: Record<string, unknown> = {};
	for (const key of allowed) {
		if (hasOwn(source, key)) projected[key] = source[key];
	}
	projected._invalid = true;
	projected._reason = "invalid_review_input";
	return projected;
}

function projectReviewMarkdown(next: Record<string, unknown>): Record<string, unknown> {
	let projected = next;
	if (typeof next.markdown === "string") {
		projected = { ...projected, markdown: projectedReviewMarkdown(next.markdown) };
	}
	if (Array.isArray(next.files)) {
		let filesChanged = false;
		const files = next.files.map((file) => {
			if (!isReviewProjectionRecord(file) || typeof file.markdown !== "string") return file;
			filesChanged = true;
			return { ...file, markdown: projectedReviewMarkdown(file.markdown) };
		});
		if (filesChanged) projected = { ...projected, files };
	}
	return projected;
}

function reviewMetadataBytes(payload: Record<string, unknown>): number {
	return Buffer.byteLength(JSON.stringify(payload, (key, value) => key === "markdown" ? undefined : value), "utf8");
}

/**
 * Review arguments are visible before executable validation. Project both
 * cumulative Markdown and the closed, UTF-8-bounded metadata schema so a
 * malformed call cannot put multi-megabyte titles, paths, or arrays onto live
 * or history transport. Valid metadata retains exact values and file order.
 */
function projectLargeReviewMarkdown(payload: any, threshold: number): any {
	if (!isReviewProjectionRecord(payload)) return payload;
	const budget = { bytes: 0 };
	let next = stripUnexpectedReviewFields(payload, REVIEW_OPEN_FIELDS);

	for (const field of ["title", "file"] as const) {
		if (!hasOwn(next, field) || isProjectedReviewInvalid(next[field])) continue;
		const value = projectedReviewString(next[field], budget, field === "title");
		if (value !== next[field]) next = { ...next, [field]: value };
	}
	if (hasOwn(next, "replace") && typeof next.replace !== "boolean" && !isProjectedReviewInvalid(next.replace)) {
		next = { ...next, replace: projectedReviewInvalid("invalid_review_input") };
	}
	if (hasOwn(next, "markdown") && typeof next.markdown !== "string"
		&& !isProjectedReviewInvalid(next.markdown) && !isProjectedReviewMarkdown(next.markdown)) {
		next = { ...next, markdown: projectedReviewInvalid("invalid_review_input") };
	}

	const originalFiles = Array.isArray(payload.files) ? payload.files : undefined;
	if (hasOwn(next, "files")) {
		if (!Array.isArray(next.files)) {
			if (!isProjectedReviewInvalid(next.files)) {
				next = { ...next, files: projectedReviewInvalid("invalid_review_input") };
			}
		} else if (next.files.length > MAX_PROJECTED_REVIEW_FILES) {
			next = {
				...next,
				files: projectedReviewInvalid("too_many_review_files", {
					_originalCount: next.files.length,
					_maximumCount: MAX_PROJECTED_REVIEW_FILES,
				}),
			};
		} else {
			let filesChanged = false;
			const files = next.files.map((rawFile) => {
				if (isProjectedReviewInvalid(rawFile)) return rawFile;
				if (!isReviewProjectionRecord(rawFile)) {
					filesChanged = true;
					return projectedReviewInvalid("invalid_review_input");
				}
				let file = stripUnexpectedReviewFields(rawFile, REVIEW_FILE_FIELDS);
				for (const field of ["title", "file"] as const) {
					if (!hasOwn(file, field) || isProjectedReviewInvalid(file[field])) continue;
					const value = projectedReviewString(file[field], budget, field === "title");
					if (value !== file[field]) file = { ...file, [field]: value };
				}
				if (hasOwn(file, "markdown") && typeof file.markdown !== "string"
					&& !isProjectedReviewInvalid(file.markdown) && !isProjectedReviewMarkdown(file.markdown)) {
					file = { ...file, markdown: projectedReviewInvalid("invalid_review_input") };
				}
				if (file !== rawFile) filesChanged = true;
				return file;
			});
			if (filesChanged) next = { ...next, files };
		}
	}

	// Include JSON structure and escaping in the canonical metadata envelope.
	// When it is exceeded, collapse the source list rather than forwarding a
	// partial sequence that could be mistaken for executable input.
	if (reviewMetadataBytes(next) > MAX_PROJECTED_REVIEW_METADATA_BYTES) {
		if (hasOwn(next, "files")) {
			next = {
				...next,
				files: projectedReviewInvalid("review_metadata_too_large", {
					...(originalFiles ? { _originalCount: originalFiles.length } : {}),
					_maximumCount: MAX_PROJECTED_REVIEW_FILES,
				}),
			};
		} else if (hasOwn(next, "file")) {
			next = { ...next, file: projectedReviewInvalid("review_metadata_too_large") };
		}
	}

	let totalMarkdownBytes = typeof payload.markdown === "string" ? Buffer.byteLength(payload.markdown, "utf8") : 0;
	if (originalFiles && originalFiles.length <= MAX_PROJECTED_REVIEW_FILES) {
		for (const file of originalFiles) {
			if (isReviewProjectionRecord(file) && typeof file.markdown === "string") {
				totalMarkdownBytes += Buffer.byteLength(file.markdown, "utf8");
			}
		}
	}
	if (totalMarkdownBytes > threshold) next = projectReviewMarkdown(next);

	// Metadata plus an individually-short Markdown body can still exceed the
	// default generic boundary. Keep this review-specific envelope bounded
	// without changing the generic threshold or its custom-test semantics.
	if (Buffer.byteLength(JSON.stringify(next), "utf8") > LARGE_CONTENT_THRESHOLD) {
		next = projectReviewMarkdown(next);
	}
	if (Buffer.byteLength(JSON.stringify(next), "utf8") > LARGE_CONTENT_THRESHOLD && Array.isArray(next.files)) {
		next = {
			...next,
			files: projectedReviewInvalid("review_metadata_too_large", {
				_originalCount: next.files.length,
				_maximumCount: MAX_PROJECTED_REVIEW_FILES,
			}),
		};
	}
	return next;
}

function truncateToolPayload(payload: any, block: any, threshold: number): any {
	if (!payload || typeof payload !== "object") return payload;
	let next = isReviewOpenTool(block) ? projectLargeReviewMarkdown(payload, threshold) : payload;

	if (isLargeString(payload.content, threshold)) {
		if (next === payload) next = { ...payload };
		next.content = truncatedStringDescriptor(payload.content);
	}

	if (isVerificationResultTool(block)) {
		for (const field of VERIFICATION_RESULT_LARGE_FIELDS) {
			if (isLargeString(payload[field], threshold)) {
				if (next === payload) next = { ...payload };
				next[field] = truncatedStringDescriptor(payload[field]);
			}
		}
	}

	return next;
}

function truncateToolBlock(block: any, threshold: number): any {
	if (!isToolBlock(block)) return block;

	const nextArguments = truncateToolPayload(block.arguments, block, threshold);
	const nextInput = truncateToolPayload(block.input, block, threshold);
	if (nextArguments === block.arguments && nextInput === block.input) return block;

	const nextBlock = { ...block };
	if (nextArguments !== block.arguments) nextBlock.arguments = nextArguments;
	if (nextInput !== block.input) nextBlock.input = nextInput;
	return nextBlock;
}

function truncateMessageContentBlock(block: any, threshold: number): any {
	const textBlock = truncateTextBlock(block, threshold);
	if (textBlock !== block) return textBlock;
	return truncateToolBlock(block, threshold);
}

function truncateMessageContent(message: any, threshold: number): any {
	const content = message?.content;
	if (!Array.isArray(content)) return message;

	let changed = false;
	const projectedContent = content.map((block: any) => {
		const projected = truncateMessageContentBlock(block, threshold);
		if (projected !== block) changed = true;
		return projected;
	});
	return changed ? { ...message, content: projectedContent } : message;
}

/**
 * Child SDK history normally has Pi-shaped content blocks, but tolerate a
 * legacy string row without allowing it to bypass the transport boundary.
 * Keep the row shape renderable while recording the same truncation metadata
 * used for text blocks.
 */
function truncateMessage(message: any, threshold: number): any {
	if (!message || typeof message !== "object" || Array.isArray(message)) return message;
	if (typeof message.content === "string") {
		if (message._truncated || message.content.length <= threshold) return message;
		const preview = message.content.slice(0, PREVIEW_LENGTH);
		return { ...message, content: preview, _truncated: true, _originalLength: message.content.length, preview };
	}
	if (!Array.isArray(message.content)) return message;
	let changed = false;
	const content = message.content.map((block: any) => {
		const truncated = truncateMessageContentBlock(block, threshold);
		if (truncated !== block) changed = true;
		return truncated;
	});
	return changed ? { ...message, content } : message;
}

function truncateToolEvent(event: any, threshold: number): any {
	if (!event || typeof event !== "object" || Array.isArray(event)) return event;
	const tool = { name: event.toolName };
	const args = truncateToolPayload(event.args, tool, threshold);
	let result = event.result;
	if (result && typeof result === "object" && !Array.isArray(result)) {
		const content = result.content;
		let truncatedContent = content;
		if (Array.isArray(content)) {
			let changed = false;
			truncatedContent = content.map((block: any) => {
				const truncated = truncateMessageContentBlock(block, threshold);
				if (truncated !== block) changed = true;
				return truncated;
			});
			if (!changed) truncatedContent = content;
		} else if (isLargeString(content, threshold)) {
			truncatedContent = truncatedStringDescriptor(content);
		}
		if (truncatedContent !== content) result = { ...result, content: truncatedContent };
	}
	return args === event.args && result === event.result ? event : {
		...event,
		...(args !== event.args ? { args } : {}),
		...(result !== event.result ? { result } : {}),
	};
}

/**
 * Bound the payload-bearing fields of a semantic SDK child-work frame before
 * it enters EventBuffer or a WebSocket replay. Identity, parent, usage, and
 * cost metadata are copied unchanged; only renderable content is replaced.
 */
export function truncateClaudeSdkSubagentWork(event: any, threshold: number = LARGE_CONTENT_THRESHOLD): any {
	if (event?.type !== "claude_sdk_subagent_work") return event;
	const message = truncateMessage(event.message, threshold);
	const toolEvent = truncateToolEvent(event.toolEvent, threshold);
	return message === event.message && toolEvent === event.toolEvent ? event : {
		...event,
		...(message !== event.message ? { message } : {}),
		...(toolEvent !== event.toolEvent ? { toolEvent } : {}),
	};
}

/**
 * Apply the same immutable boundary to nested SDK work retained in a visible
 * snapshot. Root messages stay the responsibility of the ordinary snapshot
 * truncation pipeline; this handles only the child-only sidecar envelope.
 */
export function truncateClaudeSdkSubagentWorkInSnapshot(snapshot: any, threshold: number = LARGE_CONTENT_THRESHOLD): any {
	if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !Array.isArray(snapshot.subagentWork)) return snapshot;
	let changed = false;
	const subagentWork = snapshot.subagentWork.map((work: any) => {
		if (!work || typeof work !== "object" || Array.isArray(work) || !Array.isArray(work.messages)) return work;
		let workChanged = false;
		const messages = work.messages.map((message: any) => {
			const truncated = truncateMessage(message, threshold);
			if (truncated !== message) workChanged = true;
			return truncated;
		});
		if (!workChanged) return work;
		changed = true;
		return { ...work, messages };
	});
	return changed ? { ...snapshot, subagentWork } : snapshot;
}

/**
 * Truncate large content inside a list of persisted messages (as returned by
 * the agent's `get_messages` RPC). Used when sending history to clients on
 * session open / reconnect / tab wake — previously, the full untruncated
 * history was serialized into a single WebSocket frame, which caused very slow
 * (and sometimes failing) history loads for sessions with large payloads.
 *
 * Returns the original array when nothing needs truncation.
 */
export function truncateLargeToolContentInMessages(messages: any, threshold: number = LARGE_CONTENT_THRESHOLD): any {
	if (!Array.isArray(messages)) return messages;
	let changed = false;
	const out = messages.map((msg: any) => {
		const content = msg?.content;
		if (!Array.isArray(content)) return msg;
		let msgChanged = false;
		const newContent = content.map((block: any) => {
			const truncated = truncateMessageContentBlock(block, threshold);
			if (truncated !== block) {
				msgChanged = true;
				return truncated;
			}
			return block;
		});
		if (!msgChanged) return msg;
		changed = true;
		return { ...msg, content: newContent };
	});
	return changed ? out : messages;
}

/**
 * If the event is a `message_update` or `message_end` containing large text,
 * tool content, or verification_result artifact fields, return a shallow clone
 * with those values replaced by bounded previews and metadata.
 *
 * Supports both formats:
 *  - Anthropic API: `{ type: "tool_use", input: { content: "..." } }`
 *  - pi-coding-agent RPC: `{ type: "toolCall", arguments: { content: "..." } }`
 *
 * Returns the original event unchanged when no truncation is needed.
 */
export function truncateLargeToolContent(event: any, threshold: number = LARGE_CONTENT_THRESHOLD): any {
	const eventType = event?.type;
	if (eventType !== "message_update" && eventType !== "message_end") return event;

	// Project every cumulative assistant snapshot and completed tool-call checkpoint
	// at this single live transport boundary. Pi owns the original event, so clone
	// only changed ancestors before EventBuffer retention and stream compaction.
	const message = truncateMessageContent(event.message, threshold);
	const assistantMessageEvent = event.assistantMessageEvent;
	const partial = truncateMessageContent(assistantMessageEvent?.partial, threshold);
	const toolCall = truncateToolBlock(assistantMessageEvent?.toolCall, threshold);
	const assistantMessageEventChanged = partial !== assistantMessageEvent?.partial
		|| toolCall !== assistantMessageEvent?.toolCall;
	if (message === event.message && !assistantMessageEventChanged) return event;

	return {
		...event,
		...(message === event.message ? {} : { message }),
		...(assistantMessageEventChanged
			? {
				assistantMessageEvent: {
					...assistantMessageEvent,
					...(partial === assistantMessageEvent?.partial ? {} : { partial }),
					...(toolCall === assistantMessageEvent?.toolCall ? {} : { toolCall }),
				},
			}
			: {}),
	};
}
