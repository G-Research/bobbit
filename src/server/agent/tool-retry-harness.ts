/**
 * Generic tool-error retry harness.
 *
 * Lifts the `verification_result`-only schema-retry pattern from
 * `verification-harness.ts` (`buildJsonRetryPrompt` + `tool_execution_end`
 * listeners) into a reusable, instance-per-session helper that observes
 * every session and re-emits a targeted nudge when any tool call
 * returns a deterministic JSON / structured-input validation error.
 *
 * Coverage classes:
 *   - `isError === true` matching `detectJsonValidationError` (V8/Node
 *     SyntaxError family + "Validation failed for tool").
 *   - `isError === false` with an `ok({ error })` body whose text starts
 *     with `ask_user_choices: questions[` or `propose_*:` — these are
 *     successful tool invocations whose extension returned a structured
 *     validation error.
 *
 * Retries are dispatched via `rpcClient.prompt(nudge)` — the same path
 * verification reminders use. Never `_dispatchSteer`, never
 * `enqueuePrompt`. Per-`tool_use_id` cap (default 2). The harness never
 * writes a user-visible message.
 *
 * Verification harness coordination: the verification harness adds the
 * `tool_use_id` it's about to retry to `session._verificationOwnedToolUses`;
 * this harness skips any `tool_use_id` already in that set.
 *
 * See `docs/design/tool-retry-harness.md` for the full design.
 */

import { detectJsonValidationError } from "./verification-logic.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RetryClassifier = "schema" | "domain" | "ignore";

/**
 * Subset of `tool_execution_end` event fields the harness reads. The real
 * pi-coding-agent event carries more — we're deliberately narrow so unit
 * tests can synthesise events without dragging in the SDK.
 */
export interface ToolExecutionEndEvent {
	type: "tool_execution_end" | string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	result?: unknown;
}

export interface RpcClientLike {
	onEvent(cb: (event: any) => void): () => void;
	prompt(text: string): Promise<unknown>;
}

export interface SessionLike {
	id: string;
	rpcClient: RpcClientLike;
	/**
	 * Tool-use IDs whose retry is owned by `verification-harness.ts`.
	 * The generic harness defers to the verification path on these IDs.
	 */
	_verificationOwnedToolUses?: Set<string>;
}

export interface ToolRetryMetadataDelta {
	count: number;
	lastReason: string;
}

export interface ToolRetryHarnessOptions {
	session: SessionLike;
	maxRetries?: number;
	/**
	 * Optional callback invoked after each retry-nudge dispatch; lets the
	 * caller persist `{count, lastReason}` to session metadata.
	 */
	onMetadata?: (delta: ToolRetryMetadataDelta) => void;
	/**
	 * Optional debug hook. The default is the temporary
	 * `console.debug("[tool-retry] ...")` line described in the goal's
	 * instrumentation plan.
	 */
	debug?: (msg: string, info: Record<string, unknown>) => void;
}

const DEFAULT_MAX_RETRIES = 2;

// ---------------------------------------------------------------------------
// Classifier helpers
// ---------------------------------------------------------------------------

/** Best-effort extract of a readable string from an agent tool result. */
export function extractToolResultText(result: unknown): string {
	if (!result) return "";
	if (typeof result === "string") return result;
	try {
		const r = result as any;
		const content = r.content;
		if (Array.isArray(content)) {
			return content
				.map((c: any) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : ""))
				.join("\n");
		}
		if (typeof content === "string") return content;
		if (typeof r.error === "string") return r.error;
	} catch { /* ignore */ }
	try { return JSON.stringify(result); } catch { return String(result); }
}

/**
 * Inspect a successful (`isError===false`) tool result for a structured
 * `{ error: "..." }` validation message. Returns the error string or null.
 */
export function detectStructuredValidationError(text: string): string | null {
	if (!text) return null;
	const trimmed = text.trim();
	// Direct prefix matches — what the extensions emit verbatim.
	const PREFIXES = [
		"ask_user_choices: questions[",
		"propose_goal:",
		"propose_role:",
		"propose_project:",
		"propose_staff:",
		"propose_tool:",
	];
	for (const p of PREFIXES) {
		if (trimmed.startsWith(p)) return trimmed.slice(0, 400);
	}
	// JSON body containing only an `error` string.
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object" && typeof parsed.error === "string") {
				const msg = parsed.error.trim();
				for (const p of PREFIXES) {
					if (msg.startsWith(p)) return msg.slice(0, 400);
				}
			}
		} catch { /* not JSON */ }
	}
	return null;
}

// ---------------------------------------------------------------------------
// Nudge prompt
// ---------------------------------------------------------------------------

export function buildToolRetryNudge(toolName: string, quotedError: string): string {
	const name = toolName || "tool";
	return (
		`Your previous \`${name}\` call failed with a validation error:\n\n` +
		`    ${quotedError}\n\n` +
		`This is almost certainly a streaming / argument-validation glitch in the previous attempt, ` +
		`not a real problem with your analysis. Re-emit the \`${name}\` tool call now with corrected ` +
		`arguments that match the tool's schema. Do not re-run any analysis — just submit the fixed call.`
	);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export class ToolRetryHarness {
	private readonly session: SessionLike;
	private readonly maxRetries: number;
	private readonly onMetadata?: (delta: ToolRetryMetadataDelta) => void;
	private readonly debug: (msg: string, info: Record<string, unknown>) => void;

	private unsub: (() => void) | null = null;
	private retries = new Map<string, number>();
	/** Total nudges issued in this session. Used for the metadata `count` field. */
	private totalRetries = 0;

	constructor(opts: ToolRetryHarnessOptions) {
		this.session = opts.session;
		this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
		this.onMetadata = opts.onMetadata;
		this.debug = opts.debug ?? ((msg, info) => {
			// Temporary instrumentation per goal §Instrumentation plan.
			// Removed in a follow-up once the observe scenario is stable.
			// eslint-disable-next-line no-console
			console.debug(`[tool-retry] ${msg}`, info);
		});
	}

	start(): void {
		if (this.unsub) return;
		this.unsub = this.session.rpcClient.onEvent((event: any) => {
			if (!event || event.type !== "tool_execution_end") return;
			void this._handleEvent(event as ToolExecutionEndEvent).catch((err) => {
				// eslint-disable-next-line no-console
				console.error(`[tool-retry] handler failed for session ${this.session.id}:`, err);
			});
		});
	}

	stop(): void {
		try { this.unsub?.(); } catch { /* ignore */ }
		this.unsub = null;
		this.retries.clear();
	}

	/**
	 * Public for tests — classify a `tool_execution_end` event into one of
	 * `"schema" | "domain" | "ignore"`.
	 */
	classify(event: ToolExecutionEndEvent): RetryClassifier {
		if (!event || event.type !== "tool_execution_end") return "ignore";
		const text = extractToolResultText(event.result);
		if (event.isError === true) {
			if (text && detectJsonValidationError(text)) return "schema";
			return "domain";
		}
		// isError === false (or missing) — only schema if we recognise the
		// structured validation-error envelope.
		if (text && detectStructuredValidationError(text)) return "schema";
		return "ignore";
	}

	/** Public for tests. */
	buildNudge(toolName: string, quotedError: string): string {
		return buildToolRetryNudge(toolName, quotedError);
	}

	private async _handleEvent(event: ToolExecutionEndEvent): Promise<void> {
		const classifier = this.classify(event);
		this.debug("event=", {
			session: this.session.id,
			toolName: event.toolName,
			toolUseId: event.toolCallId,
			isError: event.isError,
			classifier,
		});

		const toolUseId = event.toolCallId;

		// Reset retry count on success / domain-error for the same tool_use_id
		// so a recovered call doesn't carry stale charges.
		if (toolUseId && classifier !== "schema") {
			this.retries.delete(toolUseId);
			return;
		}
		if (classifier !== "schema") return;
		if (!toolUseId) return; // Cannot key retry counts without an ID.

		// Defer to verification harness if it owns this tool_use_id.
		if (this.session._verificationOwnedToolUses?.has(toolUseId)) return;

		const used = this.retries.get(toolUseId) ?? 0;
		if (used >= this.maxRetries) return;
		this.retries.set(toolUseId, used + 1);

		const text = extractToolResultText(event.result);
		const quoted =
			(event.isError === true ? detectJsonValidationError(text) : detectStructuredValidationError(text))
			?? text.slice(0, 400);
		const toolName = event.toolName || "tool";
		const nudge = this.buildNudge(toolName, quoted);

		try {
			await this.session.rpcClient.prompt(nudge);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.warn(`[tool-retry] prompt() failed for session ${this.session.id}:`, err);
			return;
		}

		this.totalRetries += 1;
		const reason = `${toolName}: ${quoted.slice(0, 160)}`;
		try {
			this.onMetadata?.({ count: this.totalRetries, lastReason: reason });
		} catch (err) {
			// eslint-disable-next-line no-console
			console.warn(`[tool-retry] onMetadata callback threw for session ${this.session.id}:`, err);
		}
	}
}
