/**
 * Session steer/queue/lifecycle plumbing — cohort 5 mechanical slice of the
 * SessionManager decomposition. The SessionManager methods remain same-named
 * delegating wrappers so runtime monkey-patches and internal call sites keep
 * using the legacy surface while the implementation lives in this module.
 */
import fs from "node:fs";
import path from "node:path";
import type { AutoRetryCancelledEvent, AutoRetryPendingEvent, QueuedMessage } from "../ws/protocol.js";
import type { SkillExpansion } from "../skills/resolve-skill-expansions.js";
import type { FileMention } from "../skills/resolve-file-mentions.js";
import { appendSkillSidecarEntry } from "../skills/skill-sidecar.js";
import { appendCompactionSidecarEntry, makeCompactionId, parseCompactionStartMs } from "./compaction-sidecar.js";
import { bobbitStateDir } from "../bobbit-dir.js";
import { ATTACHMENT_ONLY_TEXT, synthesizeAttachmentText, type RpcBridgeOptions } from "./rpc-bridge.js";
import { resolveSessionRuntime } from "./session-runtime.js";
import { nextBackoffDelay } from "./session-setup.js";
import { broadcastStatus } from "./session-status.js";
import {
	emitSessionEvent,
	extractClaudeCodeSessionId,
	extractUserMessageText,
	isProviderAuthFailure,
	providerFromAuthFailure,
	providerLabel,
	redactDispatchFailureReason,
	type PromptSource,
	type SessionInfo,
} from "./session-manager.js";
import type { PersistedSession } from "./session-store.js";
import { isTransientReviewError, isProviderBackoffError, isRetryableGenericAgentError, isNonRetryableAgentError } from "./verification-logic.js";
import { fallbackProviderAllowlistFromPrefs, mergeHostAgentProviderEnv } from "./host-tokens.js";
import type { Decision } from "./decision-types.js";
import { THINKING_ROUTER_CLASSIFIER_ID, isThinkingRouterApplyMode } from "./thinking-router-classifier.js";
import type { ThinkingLevel } from "../../shared/thinking-levels.js";

const MAX_CONSECUTIVE_ERROR_TURNS = 3;
const MAX_RECOVER_DRAIN_RETRIES = 2;

function buildErrorRecoveryPrefix(errMsg: string, userText: string): string {
	const snippet = (errMsg || "unknown error").slice(0, 200);
	return `[SYSTEM: previous turn failed with: ${snippet}. Your previous turn was interrupted. Pick up where you left off — re-check state first and avoid redoing completed work.]\n\n${userText}`;
}

function isBlankContentBlockError(errMsg: string | undefined): boolean {
	if (!errMsg) return false;
	return /text field in the ContentBlock/i.test(errMsg) && /is blank/i.test(errMsg);
}

export class SessionSteering {
	[key: string]: any;

	async enqueuePrompt(sessionId: string, text: string, opts?: {
		images?: Array<{ type: "image"; data: string; mimeType: string }>;
		attachments?: unknown[];
		isSteered?: boolean;
		/** Original text was already expanded into this when sent to the model. */
		modelText?: string;
		/** Resolved slash-skill expansions, in original-text order. UI-only metadata. */
		skillExpansions?: SkillExpansion[];
		/** Resolved `@path` file mentions (all kinds), in original-text order. UI-only metadata. */
		fileMentions?: FileMention[];
		/** Provenance of this prompt. Defaults to "user". Read by TeamManager
		 *  on agent_start to decide whether to reset idle-nudge backoff counters. */
		source?: PromptSource;
		/** Dispatch against a possibly-cold (freshly-restored) agent: the direct
		 *  dispatch waits for readiness and uses a generous prompt timeout via
		 *  RpcBridge.promptWhenReady, so the boot-resume nudge actually lands
		 *  instead of timing out on the default 30s. */
		coldStart?: boolean;
	}): Promise<{ status: "dispatched" | "queued" }> {
		let session = this.sessions.get(sessionId);
		if (!session) return { status: "queued" };

		// REVIVE-WINDOW JOIN (CS-R2 follow-up). A prompt that arrives while the
		// session is dormant/terminated/fenced — or while an `addClient` dormant
		// revive (or any other restore) is already in flight — must NOT be queued on
		// the stale `SessionInfo`. The coalesced restore replaces that object with a
		// fresh one (new PromptQueue(ps.messageQueue), new EventBuffer), so a row
		// queued here would be dropped and never dispatched (doc-04 F2e split-brain /
		// F7 stranded-prompt shape). Instead, JOIN the coalesced restore (it starts
		// one or joins the in-flight one), then re-read the canonical revived session
		// and dispatch against it via the normal path below.
		const restoreInFlight = this._restoreCoordinators.has(sessionId);
		const inReviveWindow = restoreInFlight
			|| session.status === "terminated"
			|| session.dormant === true
			|| session.lifecycleFenced === true;
		if (inReviveWindow) {
			const ps = this.resolveStoreForId(sessionId)?.get(sessionId);
			if (ps && ps.agentSessionFile) {
				// Coalesces: joins an in-flight restore or starts the single restore.
				await this._restoreSessionCoalesced(ps);
				const revived = this.sessions.get(sessionId);
				if (!revived) return { status: "queued" };
				session = revived;
			} else if (restoreInFlight) {
				// No restorable record of our own, but a restore is already running for
				// this session — join it rather than acting on the stale object.
				await this._restoreCoordinators.get(sessionId)?.promise;
				const revived = this.sessions.get(sessionId);
				if (!revived) return { status: "queued" };
				session = revived;
			}
			// Otherwise (terminated/dormant with no restorable transcript): fall
			// through to the existing non-idle path, which queues on the current
			// object — unchanged behavior for genuinely unrevivable sessions.
		}

		session.lastPromptSource = opts?.source ?? "user";

		// CLF-W1b/W3 — F14 thinking-level router. Consulted once per
		// `enqueuePrompt` call (the single pre-dispatch funnel design doc §3
		// names — direct/queued/extension/steer paths all converge here), on the
		// user's verbatim `text` (never `dispatchText`, since the keyword rules
		// describe user intent, not model-facing/expanded content). The returned
		// Decision is ALWAYS recorded into the transparency trace by
		// `dispatchDecision` itself (`ContextTraceStore.appendDecision`).
		// Fail-open/non-fatal: absence of a hub, an unregistered (point,kind)
		// pair (e.g. a bare test `LifecycleHub` that never wired the router), or
		// any classifier error must never block a prompt from dispatching — see
		// design doc §6.1 (advisory kinds default fail-open).
		// Guarded HERE (not inside the helper): when there is no hub at all —
		// true for the overwhelming majority of today's tests and any deployment
		// that never wires one — this must introduce ZERO extra microtask ticks
		// before the pre-existing synchronous fast path (idle+empty direct
		// dispatch) reaches `rpcClient.prompt()`. `await`ing a promise always
		// yields at least once even if the awaited async function resolves
		// synchronously, so the guard has to live outside the `await`, not just
		// inside it.
		let thinkingRouterDecision: Decision<ThinkingLevel> | undefined;
		if (this.lifecycleHub) {
			// CLF-W3 apply mode: whether we WILL apply a `select` is decided here,
			// from the mode flag + precedence (role/user-pinned) ONLY — never from
			// the classifier's actual choice, which doesn't exist yet. Passed into
			// the consult so the recorded outcome's `applied` field matches what
			// we're about to do below. Observe mode (absent/"observe") always
			// resolves `canApplyThinking` to `false`, keeping this byte-identical
			// to CLF-W1b when the flag isn't set.
			const canApplyThinking = isThinkingRouterApplyMode() && this.canApplyThinkingRouterDecision(session);
			thinkingRouterDecision = await this.consultThinkingRouterHub(session, text, canApplyThinking);
			if (canApplyThinking && thinkingRouterDecision?.kind === "select") {
				try {
					// Clamp against the session's CURRENT bound model before applying —
					// same defense-in-depth every other live setThinkingLevel call site
					// uses (ws/handler.ts's set_thinking_level, tryApplyDefaultThinkingLevel)
					// so a classifier "xhigh" select degrades gracefully on a model that
					// doesn't support it instead of sending an unsupported level to the
					// runtime. Falls back to the raw choice when no model is known yet.
					const baseline = session.thinkingRouterAppliedBaseline ?? this.resolveCurrentThinkingRouterBaseline(session);
					const levelToApply = this.clampThinkingLevelForSession(session, thinkingRouterDecision.choice);
					await session.rpcClient.setThinkingLevel(levelToApply);
					session.thinkingRouterAppliedBaseline = baseline;
					console.log(`[session-manager] CLF-W3 thinking-router APPLIED "${levelToApply}" for session ${session.id} (turn-scoped, not persisted)`);
				} catch (err) {
					console.warn(`[session-manager] CLF-W3 thinking-router apply failed for ${session.id} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
				}
			} else if (session.thinkingRouterAppliedBaseline && isThinkingRouterApplyMode()) {
				if (canApplyThinking) {
					await this.restoreThinkingRouterAppliedBaseline(session);
				} else {
					this.clearThinkingRouterAppliedBaseline(session);
				}
			}
		}
		// Stamped onto the QueuedMessage row at BOTH enqueue call sites below
		// (the queued-path fix) — data-only, read by no code yet.
		const thinkingDecisionStamp: QueuedMessage["thinkingDecision"] = thinkingRouterDecision
			? { decision: thinkingRouterDecision, classifierId: THINKING_ROUTER_CLASSIFIER_ID, ts: Date.now() }
			: undefined;

		// modelText is what the model sees; text is the user's verbatim input.
		// When no expansions, both are equal and dispatch is byte-equal to today.
		// Synthesize a non-blank body for attachment-only prompts (image-only OR
		// non-image-attachment-only) so the model never receives a blank
		// ContentBlock. Applied here at the single dispatch boundary so EVERY
		// downstream path inherits valid text: direct dispatch, the persisted
		// queue row (drainQueue), the error-recovery prefix, and retry (via
		// dispatchDirectPrompt → session.lastPromptText). Non-blank text and
		// no-attachment prompts pass through unchanged. See
		// synthesizeAttachmentText for the exact rule.
		const dispatchText = synthesizeAttachmentText(opts?.modelText ?? text, opts?.images, opts?.attachments);
		const hasSkillExpansions = !!(opts?.skillExpansions && opts.skillExpansions.length > 0);
		const hasFileMentions = !!(opts?.fileMentions && opts.fileMentions.length > 0);
		if (hasSkillExpansions || hasFileMentions) {
			appendSkillSidecarEntry(session.id, {
				ts: Date.now(),
				modelText: dispatchText,
				originalText: text,
				skillExpansions: opts?.skillExpansions ?? [],
				...(hasFileMentions ? { fileMentions: opts!.fileMentions! } : {}),
			});
			// Stash the envelope so when the agent echoes the user message
			// back via `message_end`, we can splice the original text +
			// chip metadata onto the broadcast event before clients see it.
			if (!session.pendingSkillExpansions) session.pendingSkillExpansions = [];
			session.pendingSkillExpansions.push({
				modelText: dispatchText,
				originalText: text,
				skillExpansions: opts?.skillExpansions ?? [],
				...(hasFileMentions ? { fileMentions: opts!.fileMentions! } : {}),
			});
		}

		// ERROR STATE GATING: if last turn errored, either implicitly unstick
		// (up to MAX_CONSECUTIVE_ERROR_TURNS) or park the message in the queue.
		if (session.lastTurnErrored) {
			const consec = session.consecutiveErrorTurns ?? 0;

			// Always cancel any pending auto-retry timer when a new user prompt
			// arrives — regardless of whether we're about to park (cap reached)
			// or implicitly unstick. A parked prompt at the cap must not leave a
			// retry banner/timer running, since the user has signalled fresh intent
			// and the next action will be an explicit Retry click or fix upstream.
			this.cancelPendingAutoRetry(session, "new-prompt");

			if (consec >= MAX_CONSECUTIVE_ERROR_TURNS) {
				// Cap reached — park. Human must click Retry (or fix upstream) to drain.
				console.log(
					`[session-manager] Session ${session.id} has ${consec} consecutive errored turns; parking incoming prompt. Human action required (click Retry or fix upstream issue).`
				);
				session.promptQueue.enqueue(dispatchText, {
					images: opts?.images,
					attachments: opts?.attachments,
					isSteered: opts?.isSteered,
					thinkingDecision: thinkingDecisionStamp,
				});
				this.broadcastQueue(session);
				return { status: "queued" };
			}

			// Implicit unstick — new intent supersedes the failed turn.
			const errSnippet = (session.lastTurnErrorMessage || "").slice(0, 200);
			// Capture BEFORE clearing — decides whether the prior turn poisoned
			// the live history with a blank ContentBlock (image/attachment-only).
			const poisonedByBlankText = isBlankContentBlockError(session.lastTurnErrorMessage);
			console.log(
				`[session-manager] Session ${session.id} implicit unstick from enqueuePrompt (consecutiveErrorTurns=${consec}). Error: ${errSnippet}`
			);

			// A fresh prompt supersedes any recovered dispatch-time copy of the
			// failed prompt. Drop it before dispatching the new intent so a later
			// agent_end drain cannot replay stale work after the follow-up succeeds.
			this.consumeRecoveredPromptDispatchRows(session);

			// Clear error state. Do NOT reset consecutiveErrorTurns — that only
			// resets on a SUCCESSFUL message_end or an explicit retryLastPrompt.
			session.lastTurnErrored = false;
			session.lastTurnErrorMessage = undefined;
			session.turnHadToolCalls = false;
			session.transientRetryAttempts = 0;

			// Title generation uses the user-visible original text (better UX).
			this.tryGenerateTitleFromPrompt(sessionId, text);

			// Blank-text poison: the live process's in-memory history still holds
			// the committed blank ContentBlock, so dispatching this follow-up to
			// the SAME process would replay it and re-fail. Respawn so the agent
			// rehydrates from the sanitized transcript, then dispatch the
			// follow-up against clean history (no recovery prefix needed — the
			// poisoned turn is gone). Falls through to the normal prefixed path
			// when there's no persisted transcript to rehydrate from.
			if (poisonedByBlankText) {
				const recovered = await this._recoverBlankTextPoison(session);
				if (recovered) {
					// We know the prior turn carried attachment/image content (it
					// poisoned on a blank ContentBlock). If this follow-up's own
					// dispatch text is blank (e.g. a legacy attachment-only retry
					// where attachments aren't tracked on SessionInfo), fall back to
					// the synthetic phrase so we never re-send blank/invalid content.
					const recoverText = dispatchText.trim() === "" ? ATTACHMENT_ONLY_TEXT : dispatchText;
					await this.dispatchDirectPrompt(recovered, recoverText, opts?.images, opts?.attachments, !!opts?.isSteered, !!opts?.coldStart);
					return { status: "dispatched" };
				}
			}

			// Dispatch the prefixed new message immediately, ahead of any parked
			// items. After agent_end the normal drainQueue path picks up parked
			// items in FIFO order, unprefixed (since lastTurnErrorMessage is now
			// cleared).
			// Inject the recovery prefix into the model-facing dispatch text.
			const prefixedDispatch = buildErrorRecoveryPrefix(errSnippet, dispatchText);
			await this.dispatchDirectPrompt(session, prefixedDispatch, opts?.images, opts?.attachments, !!opts?.isSteered, !!opts?.coldStart);
			return { status: "dispatched" };
		}

		// If agent is idle and queue is empty, dispatch directly. Mark streaming
		// before awaiting rpcClient.prompt(): Pi 0.77 OpenAI/Codex preflight can be
		// slow, and clients/API polling must see the turn as in-flight immediately.
		if (session.status === "idle" && session.promptQueue.isEmpty) {
			this.tryGenerateTitleFromPrompt(sessionId, text);
			await this.dispatchDirectPrompt(session, dispatchText, opts?.images, opts?.attachments, !!opts?.isSteered, !!opts?.coldStart);
			return { status: "dispatched" };
		}

		// Agent is busy or queue has items — enqueue. Persisted queue holds
		// the dispatch (model-facing) text so drainQueue passes the same
		// expanded text to the agent later. The chip metadata is already
		// in the sidecar/broadcast; the queued row is purely for delivery.
		session.promptQueue.enqueue(dispatchText, {
			images: opts?.images,
			attachments: opts?.attachments,
			isSteered: opts?.isSteered,
			thinkingDecision: thinkingDecisionStamp,
		});
		this.broadcastQueue(session);

		// If agent is idle, start draining the queue (bug fix: idle + non-empty queue)
		if (session.status === "idle") {
			this.drainQueue(session);
		}
		return { status: "queued" };
	}

	/**
	 * Deliver a live steer to a streaming session.
	 *
	 * Before calling rpcClient.steer(), aborts any in-flight `bash_bg wait`
	 * HTTP handlers for this session so the agent is not stuck inside a
	 * tool call while the steer is queued on the SDK side. The bg processes
	 * themselves are left running untouched.
	 *
	 * Returns the underlying rpcClient.steer() promise so callers can await
	 * or attach their own error handler.
	 */
	deliverLiveSteer(sessionId: string, message: string, opts?: { source?: PromptSource }): Promise<unknown> {
		const session = this.sessions.get(sessionId);
		if (!session) return Promise.reject(new Error(`Session ${sessionId} not found`));
		session.lastPromptSource = opts?.source ?? "user";

		// ERROR STATE GATING: same cap as enqueuePrompt. Idle-but-errored means
		// there is no live turn to inject into, so we either dispatch a regular
		// prefixed prompt (unstick) or park the steer in the queue (cap).
		if (session.lastTurnErrored) {
			const consec = session.consecutiveErrorTurns ?? 0;
			if (consec >= MAX_CONSECUTIVE_ERROR_TURNS) {
				console.log(
					`[session-manager] Session ${sessionId} has ${consec} consecutive errored turns; parking live-steer. Human action required.`
				);
				// Persist to promptQueue so it survives Stop/Retry. drainQueue will
				// pick it up after user Retry.
				const queued = session.promptQueue.enqueue(message, { isSteered: true });
				this.broadcastQueue(session);
				return Promise.resolve({ queued: true, parked: true, id: queued.id });
			}

			const errSnippet = (session.lastTurnErrorMessage || "").slice(0, 200);
			console.log(
				`[session-manager] Session ${sessionId} implicit unstick from deliverLiveSteer (consecutiveErrorTurns=${consec}). Error: ${errSnippet}`
			);
			// enqueuePrompt handles its own state-clear + pending-timer cancel +
			// prefix application; we just route through it with the raw message.
			return this.enqueuePrompt(sessionId, message, { isSteered: true, source: opts?.source });
		}

		// Happy path: enqueue then dispatch via the single _dispatchSteer site.
		// _dispatchSteer removes the row from promptQueue *before* awaiting the
		// RPC and persists an in-flight ledger for restart durability until echo.
		const queued = session.promptQueue.enqueue(message, { isSteered: true });
		this.broadcastQueue(session);
		return this._dispatchSteer(session, [queued]);
	}

	/**
	 * Promote a queued message to steered priority.
	 * If the agent is streaming, dispatch the current steered front group through
	 * the same live-steer path as a fresh steer so user intent is observed on the
	 * current turn instead of waiting for a later tool boundary or agent_end.
	 */
	steerQueued(sessionId: string, messageId: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;
		const ok = session.promptQueue.steer(messageId);
		if (!ok) return false;

		if (session.status === "streaming") {
			const steered = session.promptQueue.dequeueAllSteered();
			void this._dispatchSteer(session, steered).catch(() => {});
			return true;
		}

		this.broadcastQueue(session);
		if (session.status === "idle") this.drainQueue(session);
		return true;
	}

	/**
	 * Single dispatch site for steered prompts. Removes rows from promptQueue
	 * *before* awaiting rpcClient.steer() and persists an in-flight ledger so
	 * restart can recover the dispatch→echo window. On RPC failure, rows are
	 * re-enqueued at the front in original order (steered group still sorts
	 * first via PromptQueue.reorder()).
	 *
	 * Tool-boundary callers may pre-pop rows with dequeueAllSteered() — in
	 * that case remove() is a no-op (returns false), broadcastQueue stays
	 * idempotent.
	 */
	async _dispatchSteer(session: SessionInfo, rows: QueuedMessage[]): Promise<void> {
		if (rows.length === 0) return;
		const bg = (this as any).bgProcessManager;
		if (bg) bg.abortAllWaits(session.id);
		const batchText = rows.map(r => r.text).join("\n");

		// Record on the shadow ledger BEFORE persisting queue removal. The store
		// update below writes both the now-empty promptQueue slice and this ledger
		// entry together, so a restart after dispatch but before the transcript
		// echo can restore/re-enqueue the steer exactly once.
		//
		// On RPC failure we splice this exact entry back out and re-enqueue
		// the rows at front of promptQueue, so the next drain redispatches.
		if (!session.inFlightSteerTexts) session.inFlightSteerTexts = [];
		session.inFlightSteerTexts.push(batchText);
		for (const r of rows) session.promptQueue.remove(r.id);
		this.broadcastQueue(session, { includeInFlightSteers: true });
		try {
			const steerResp = await session.rpcClient.steer(batchText);
			if ((steerResp as any)?.success === false) {
				throw new Error((steerResp as any)?.error || "steer rejected");
			}
		} catch (err) {
			// Splice this entry from the ledger only if this catch path still owns
			// it. Abort/restart reconciliation can drain the same ledger while the
			// steer RPC is pending; in that case the row has already been recovered
			// exactly once and must not be enqueued again here.
			const lidx = session.inFlightSteerTexts.lastIndexOf(batchText);
			if (lidx !== -1) {
				session.inFlightSteerTexts.splice(lidx, 1);
				for (const r of [...rows].reverse()) {
					session.promptQueue.enqueueAtFront(r.text, { isSteered: true });
				}
				this.broadcastQueue(session, { includeInFlightSteers: true });
				// A steer rejection can race with abort settlement: agent_end may have
				// already broadcast idle and run its one drain before this catch puts the
				// row back. Redrain immediately in that settled-idle case so the recovered
				// steer is not parked until the next user prompt.
				if (session.status === "idle" && !session.lastTurnErrored) this.drainQueue(session);
			} else {
				this.persistInFlightSteerLedger(session);
				console.warn(`[session-manager] _dispatchSteer failed for ${session.id} after in-flight ledger was already reconciled; not re-enqueueing duplicate steer`);
			}
			console.error(`[session-manager] _dispatchSteer failed for ${session.id}:`, err);
			throw err;
		}
	}

	/**
	 * Splice an entry from the shadow ledger when its echo arrives.
	 * Matches the SDK's text-match removal at agent-session.js:265-280:
	 * find the first index whose text equals the user-message body, splice it.
	 * Silent no-op for non-matching messages (regular prompts, follow-ups,
	 * skill-expansion echoes whose body has been rewritten).
	 */
	_consumeSteerEcho(session: SessionInfo, event: any): void {
		const ledger = session.inFlightSteerTexts;
		if (!ledger || ledger.length === 0) return;
		if (event.type !== "message_end") return;
		if (event.message?.role !== "user") return;
		const text = extractUserMessageText(event.message);
		if (!text) return;
		const idx = ledger.indexOf(text);
		if (idx !== -1) {
			ledger.splice(idx, 1);
			this.persistInFlightSteerLedger(session);
		}
	}

	/**
	 * Drain the shadow ledger and re-enqueue any unresolved steers at the
	 * front of promptQueue as steered rows. Called after restore and from
	 * abort-reconciliation paths where a steer the SDK accepted may never echo
	 * because the turn was torn down. The next drainQueue picks the rows up as
	 * a steered batch via `_dispatchSteer`, redispatching exactly once.
	 */
	_reconcileInFlightSteers(session: SessionInfo): void {
		const ledger = session.inFlightSteerTexts;
		if (!ledger || ledger.length === 0) return;
		for (const text of [...ledger].reverse()) {
			session.promptQueue.enqueueAtFront(text, { isSteered: true });
		}
		ledger.length = 0;
		this.broadcastQueue(session, { includeInFlightSteers: true });
	}

	_reconcileAfterAbort(session: SessionInfo): void {
		this._reconcileInFlightSteers(session);
	}

	/** Reorder queued messages to match the given ID list. */
	reorderQueue(sessionId: string, messageIds: string[]): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		session.promptQueue.reorderByIds(messageIds);
		this.broadcastQueue(session);
	}

	/** Remove a queued message. */
	removeQueued(sessionId: string, messageId: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;
		const ok = session.promptQueue.remove(messageId);
		if (ok) this.broadcastQueue(session);
		return ok;
	}

	markPromptDispatchStreaming(session: SessionInfo): void {
		session.streamingStartedAt = session.streamingStartedAt ?? Date.now();
		this.resolveStoreForSession(session.id).update(session.id, { wasStreaming: true, streamingStartedAt: session.streamingStartedAt });
		broadcastStatus(session, "streaming", { streamingStartedAt: session.streamingStartedAt });
	}

	applyDirectProviderEnv(bridgeOptions: RpcBridgeOptions, sandboxed: boolean | undefined, provider?: string): void {
		if (sandboxed) return;
		bridgeOptions.env = mergeHostAgentProviderEnv(bridgeOptions.env, this.preferencesStore, {
			provider,
			model: bridgeOptions.initialModel,
			providers: fallbackProviderAllowlistFromPrefs(this.preferencesStore),
		});
	}

	safeDispatchError(session: SessionInfo, reason: string): Error {
		const persistedProvider = this.resolveStoreForSession(session.id).get(session.id)?.modelProvider;
		return new Error(redactDispatchFailureReason(reason, isProviderAuthFailure(reason), persistedProvider));
	}

	surfaceProviderAuthFailure(session: SessionInfo, reason: string, source: string): void {
		const persistedProvider = this.resolveStoreForSession(session.id).get(session.id)?.modelProvider;
		const provider = providerFromAuthFailure(reason, persistedProvider);
		const label = providerLabel(provider);
		session.streamingStartedAt = undefined;
		session.recoverDrainAttempts = 0;
		this.resolveStoreForSession(session.id).update(session.id, {
			wasStreaming: false,
			streamingStartedAt: undefined,
		});
		broadcastStatus(session, "idle");
		this.resolveIdleWaiters(session.id);
		emitSessionEvent(session, {
			type: "provider_auth_required",
			provider,
			source,
			reason: "missing-api-key",
			diagnostic: `${label} credentials are missing or invalid.`,
			message: `${label} API key is missing. Add or fix the API key in Settings, switch provider, then retry or abort/respawn the agent.`,
			actions: [
				{ type: "open_settings", label: "Fix API key in Settings" },
				{ type: "retry", label: "Retry after fixing credentials" },
				{ type: "switch_provider", label: "Switch provider" },
				{ type: "abort_respawn", label: "Abort/respawn agent" },
			],
		});
	}

	maybeAutoRetryPromptDeliveryFailure(session: SessionInfo, reason: string, source: string): boolean {
		if (!reason || isNonRetryableAgentError(reason)) return false;
		const isRetryable = isProviderBackoffError(reason) || isTransientReviewError(reason) || isRetryableGenericAgentError(reason);
		if (!isRetryable) return false;

		// The agent rejected the prompt before it could emit an assistant
		// message_end, so synthesize the same error state that message_end would
		// have established. The failed prompt never reached agent_start, so no
		// tools ran in that turn; clear any stale flag from a previous turn so
		// retryLastPrompt(auto:true) re-sends the recovered prompt instead of a
		// mid-work continuation. The recovered queue row remains the single
		// durable copy of the prompt; retryLastPrompt(auto:true) consumes it
		// before dispatching so a later agent_end cannot replay it a second time.
		session.lastTurnErrored = true;
		session.lastTurnErrorMessage = reason;
		session.turnHadToolCalls = false;
		session.consecutiveErrorTurns = (session.consecutiveErrorTurns ?? 0) + 1;
		const scheduled = this.maybeAutoRetryTransient(session);
		if (scheduled) {
			console.log(`[session-manager] ${source} dispatch for ${session.id} failed with retryable delivery error; auto-retry scheduled. Error: ${reason.slice(0, 200)}`);
		} else {
			console.warn(`[session-manager] ${source} dispatch for ${session.id} exhausted retryable delivery auto-retries; leaving recovered row queued for manual Retry. Error: ${reason.slice(0, 200)}`);
		}
		return true;
	}

	recoverPromptDispatch(session: SessionInfo, rows: Array<{
		text: string;
		images?: Array<{ type: "image"; data: string; mimeType: string }>;
		attachments?: unknown[];
		isSteered?: boolean;
	}>, reason: string, source: string): void {
		if (!this._sessionWriterIsCurrent(session)) return;
		const providerAuthFailure = isProviderAuthFailure(reason);
		const persistedProvider = this.resolveStoreForSession(session.id).get(session.id)?.modelProvider;
		const safeReason = redactDispatchFailureReason(reason, providerAuthFailure, persistedProvider);
		const processExited = /(?:agent process exited|process_exit)/i.test(reason);
		if (session.status === "terminated" || (session.status === "aborting" && processExited)) {
			console.warn(`[session-manager] ${source} dispatch failed for ${session.id} (${safeReason}); not recovering ${rows.length} row(s) because session is ${session.status}`);
			return;
		}

		console.warn(`[session-manager] ${source} dispatch failed for ${session.id} (${safeReason}); re-enqueueing ${rows.length} row(s) at front`);
		// Re-enqueue at front in original order so the next drain re-dispatches
		// the same batch. Reverse iteration because enqueueAtFront unshifts.
		const recoveredIds: string[] = [];
		for (const r of [...rows].reverse()) {
			const recovered = session.promptQueue.enqueueAtFront(r.text, {
				images: r.images,
				attachments: r.attachments,
				isSteered: r.isSteered,
			});
			recoveredIds.push(recovered.id);
		}
		if (recoveredIds.length > 0) {
			session.recoveredPromptDispatchQueueIds = [
				...(session.recoveredPromptDispatchQueueIds ?? []),
				...recoveredIds,
			];
		}
		if (providerAuthFailure) {
			this.surfaceProviderAuthFailure(session, reason, source);
			this.broadcastQueue(session);
			return;
		}
		broadcastStatus(session, "idle");
		this.broadcastQueue(session);
		if (this.maybeAutoRetryPromptDeliveryFailure(session, safeReason, source)) {
			return;
		}
		// Schedule a follow-up drain on the next tick so the rows we just
		// re-enqueued get another chance once the bridge has finished its
		// abort/finishRun bookkeeping. setTimeout(0) lets pending microtasks
		// (including the SDK's finally{finishRun()}) run first.
		//
		// Bound the immediate retries: when the agent is genuinely mid-turn the
		// redrain keeps losing to the "Agent is already processing" busy guard
		// and would reschedule itself forever (a tick-0 spin that floods the
		// logs). After MAX_RECOVER_DRAIN_RETRIES we stop — the rows stay queued
		// and the next agent_end's drainQueue (with a freshly reset counter)
		// delivers them once the turn actually ends.
		const attempts = (session.recoverDrainAttempts ?? 0) + 1;
		if (attempts > MAX_RECOVER_DRAIN_RETRIES) {
			session.recoverDrainAttempts = 0;
			console.warn(`[session-manager] ${source} dispatch for ${session.id} still failing after ${MAX_RECOVER_DRAIN_RETRIES} immediate retries (${safeReason}); deferring ${rows.length} row(s) to the next agent_end drain`);
			return;
		}
		session.recoverDrainAttempts = attempts;
		const generation = session.lifecycleGeneration ?? 0;
		setTimeout(() => {
			if ((session.lifecycleGeneration ?? 0) !== generation) return;
			this.drainQueue(session);
		}, 0);
	}

	async dispatchDirectPrompt(
		session: SessionInfo,
		text: string,
		images?: Array<{ type: "image"; data: string; mimeType: string }>,
		attachments?: unknown[],
		isSteered?: boolean,
		coldStart?: boolean,
	): Promise<void> {
		session.lastPromptText = text;
		session.lastPromptImages = images;
		this.markPromptDispatchStreaming(session);

		const dispatchedRowsForRecovery = [{ text, images, attachments, isSteered }];
		let recovered = false;
		try {
			// Cold (freshly-restored) agent: wait for readiness, then prompt with a
			// generous timeout so a boot-resume nudge lands instead of timing out
			// on the default 30s. Everything else (recovery, rethrow) is identical.
			const resp = coldStart
				? await session.rpcClient.promptWhenReady(text, images)
				: await session.rpcClient.prompt(text, images);
			if (resp && (resp as any).success === false) {
				const reason = (resp as any).error || "unknown";
				this.recoverPromptDispatch(session, dispatchedRowsForRecovery, reason, "direct prompt");
				recovered = true;
				throw this.safeDispatchError(session, reason);
			}
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			if (!recovered) {
				this.recoverPromptDispatch(session, dispatchedRowsForRecovery, reason, "direct prompt");
			}
			if (isProviderAuthFailure(reason)) {
				throw this.safeDispatchError(session, reason);
			}
			throw err;
		}
	}

	/**
	 * Called when the agent becomes idle (agent_end) or when a new message is
	 * enqueued while idle. Dequeue and dispatch the next message if any exist.
	 *
	 * Always dispatches via `prompt` RPC (not `steer`) because the agent is
	 * idle at this point — `steer` is only meaningful mid-turn.
	 *
	 * Sets status to "streaming" optimistically to prevent a race where another
	 * enqueuePrompt call sees idle+empty and dispatches a second concurrent prompt.
	 */
	drainQueue(session: SessionInfo): void {
		if (!this._sessionWriterIsCurrent(session)) return;
		if (session.promptQueue.isEmpty) return;

		// Batch all steered messages at the front into a single prompt
		const steered = session.promptQueue.dequeueAllSteered();
		let next: QueuedMessage | undefined;

		if (steered.length > 0) {
			const batchText = steered.map(m => m.text).join('\n');
			next = { ...steered[0], text: batchText };
		} else {
			// Skip already-dispatched messages (steered mid-turn), then pop the next
			next = session.promptQueue.dequeue();
		}

		this.broadcastQueue(session);
		if (!next) return;

		// Title generation for the first real prompt
		this.tryGenerateTitleFromPrompt(session.id, next.text);

		// Track for retry
		session.lastPromptText = next.text;
		session.lastPromptImages = next.images;

		// Optimistic status update to prevent double-dispatch race
		this.markPromptDispatchStreaming(session);
		const dispatchObservedTurnVersion = session.agentObservedTurnVersion ?? 0;

		// Snapshot the rows we're about to dispatch so we can re-enqueue them
		// if the agent rejects the prompt (e.g. "Agent is already processing."
		// when drainQueue races the SDK's finishRun() during a graceful abort).
		const dispatchedRowsForRecovery = steered.length > 0
			? steered.map(r => ({ text: r.text, images: r.images, attachments: r.attachments, isSteered: true }))
			: [{ text: next.text, images: next.images, attachments: next.attachments, isSteered: !!next.isSteered }];

		const recoverDispatchedRows = (reason: string) => {
			// Suppress recovery only after an inbound agent event proves the dequeued
			// turn was accepted/observed. Local status changes such as Stop →
			// "aborting" can happen before prompt() is accepted; those rows must be
			// recovered or the queued prompt is lost.
			const persistedProvider = this.resolveStoreForSession(session.id).get(session.id)?.modelProvider;
			const safeReason = redactDispatchFailureReason(reason, isProviderAuthFailure(reason), persistedProvider);
			const observedTurnVersion = session.agentObservedTurnVersion ?? 0;
			if (observedTurnVersion !== dispatchObservedTurnVersion) {
				console.warn(`[session-manager] drainQueue dispatch for ${session.id} reported ${safeReason} after agent observed the turn (observedTurnVersion ${dispatchObservedTurnVersion} → ${observedTurnVersion}); not recovering ${dispatchedRowsForRecovery.length} row(s)`);
				return;
			}
			this.recoverPromptDispatch(session, dispatchedRowsForRecovery, reason, "drainQueue");
		};

		const dispatchPromise = session.rpcClient.prompt(next.text, next.images);
		dispatchPromise
			.then((resp: any) => {
				// The bridge resolves with `{success:false, error}` when the agent
				// rejects the command (the most common case is the abort/drainQueue
				// race below). Treat that the same as a thrown rejection — recover
				// the dequeued rows so a future drain can redispatch them.
				if (resp && resp.success === false) {
					recoverDispatchedRows(resp.error || "unknown");
				} else {
					// Dispatch landed — clear the busy-guard retry budget so a
					// future recovery starts fresh.
					session.recoverDrainAttempts = 0;
				}
			})
			.catch((err: any) => {
				const reason = err?.message || String(err);
				const persistedProvider = this.resolveStoreForSession(session.id).get(session.id)?.modelProvider;
				const safeReason = redactDispatchFailureReason(reason, isProviderAuthFailure(reason), persistedProvider);
				console.error(`[session-manager] Failed to dispatch queued prompt for ${session.id}: ${safeReason}`);
				recoverDispatchedRows(reason);
			});
	}

	persistClaudeCodeMessageToTranscript(session: SessionInfo, event: any): void {
		if (event?.type !== "message_end" || !event.message) return;
		const store = this.resolveStoreForSession(session.id);
		const ps = store.get(session.id);
		if (resolveSessionRuntime({ runtime: ps?.runtime, modelProvider: ps?.modelProvider }) !== "claude-code") return;
		let agentSessionFile = ps?.agentSessionFile;
		if (!agentSessionFile) {
			agentSessionFile = path.join(bobbitStateDir(), "claude-code-transcripts", `${session.id}.jsonl`);
			store.update(session.id, { agentSessionFile });
		}
		try {
			fs.mkdirSync(path.dirname(agentSessionFile), { recursive: true });
			fs.appendFileSync(agentSessionFile, JSON.stringify({
				type: "message",
				id: event.message.id,
				ts: new Date().toISOString(),
				message: event.message,
			}) + "\n");
		} catch (err) {
			console.warn(`[session-manager] Failed to persist Claude Code transcript for ${session.id}:`, err);
		}
	}

	/**
	 * Handle agent events that track error state and control queue draining.
	 * Called from every event listener before broadcasting.
	 * - Tracks message_end with stopReason "error" so we can suppress queue draining.
	 * - On agent_end, skips drainQueue if the turn ended with an error.
	 */
	handleAgentLifecycle(session: SessionInfo, event: any): void {
		const claudeCodeSessionId = extractClaudeCodeSessionId(event);
		if (claudeCodeSessionId) {
			this.resolveStoreForSession(session.id).update(session.id, { runtime: "claude-code", claudeCodeSessionId });
		}
		this.persistClaudeCodeMessageToTranscript(session, event);

		// H3 fix: track the latest in-flight `message_update` so snapshot reads
		// (`getMessages`) can splice it into the response. Cleared on terminal
		// lifecycle events below. The agent flushes to `.jsonl` only on
		// `message_end`, so without this a snapshot taken mid-stream drops the
		// row entirely — the H3-D convergent-loss case.
		if (event.type === "message_update" && event.message) {
			session.latestMessageUpdate = { id: event.message.id, message: event.message };
		} else if (
			event.type === "message_end" ||
			event.type === "agent_end" ||
			event.type === "process_exit"
		) {
			session.latestMessageUpdate = undefined;
		}

		// Track tool execution during this turn
		if (event.type === "tool_execution_start") {
			session.turnHadToolCalls = true;

			// Enforce allowedTools — log when a disallowed tool slips past the guard
			// extension. This is a last-resort observability signal; actual blocking
			// happens in the tool_call guard (see tool-guard-extension.ts). If we see
			// this log line the guard is misconfigured or missing for this session.
			if (session.allowedTools && session.allowedTools.length > 0 && event.toolName) {
				const toolLower = event.toolName.toLowerCase();
				if (!session.allowedTools.some((t: string) => t.toLowerCase() === toolLower)) {
					console.error(
						`[session-manager] Session ${session.id} executed disallowed tool "${event.toolName}" — guard extension did not block it.`
					);
				}
			}
		}

		// Inbound agent events that carry turn progress prove a just-dispatched
		// prompt was accepted. Keep this separate from statusVersion: local Stop /
		// abort status broadcasts must not suppress recovery for a prompt that was
		// dequeued but rejected before acceptance.
		if (
			event.type === "agent_start" ||
			event.type === "tool_execution_start" ||
			(event.type === "message_end" && (
				event.message?.role === "user" ||
				event.message?.role === "user-with-attachments" ||
				event.message?.role === "assistant"
			))
		) {
			session.agentObservedTurnVersion = (session.agentObservedTurnVersion ?? 0) + 1;
		}

		// Splice this echoed user message off the shadow ledger if it was a
		// dispatched steer. Mirrors the SDK's _steeringMessages text-match
		// removal (agent-session.js:265–280); harmless no-op for non-steer
		// user messages (regular prompts, follow-ups, ask responses).
		this._consumeSteerEcho(session, event);

		// Tool boundary: defensively flush any steered rows that remain queued
		// (for example, recovered/pre-existing rows). Fresh live steers and
		// steer_queued promotions dispatch immediately through _dispatchSteer.
		if (event.type === "tool_execution_end") {
			// If we're already aborting, do NOT dispatch steers via rpcClient.steer.
			// The agent loop is being torn down — the SDK would queue the steer
			// onto _steeringMessages but never consume it, AND the post-abort
			// drainQueue path would re-enqueue and redispatch via rpcClient.prompt,
			// causing the steer to fire twice. Leave the steered rows in the queue
			// so the post-abort drainQueue is the single dispatch site.
			if (session.status === "aborting") return;
			const steered = session.promptQueue.dequeueAllSteered();
			if (steered.length > 0) void this._dispatchSteer(session, steered).catch(() => {});
		}

		if (event.type === "message_end" && (event.message?.role === "user" || event.message?.role === "user-with-attachments")) {
			session.latestTurnUserText = extractUserMessageText(event.message);
		}

		if (event.type === "message_end" && event.message?.role === "assistant") {
			session.latestTurnAssistantText = extractUserMessageText(event.message);
			const errored = event.message.stopReason === "error";
			const rawErrorMessage = errored ? (event.message.errorMessage || "") : undefined;
			const providerAuthFailure = isProviderAuthFailure(rawErrorMessage);
			const persistedProvider = this.resolveStoreForSession(session.id).get(session.id)?.modelProvider;
			session.lastTurnErrored = errored;
			session.lastTurnErrorMessage = errored
				? redactDispatchFailureReason(rawErrorMessage || "", providerAuthFailure, persistedProvider)
				: undefined;
			if (providerAuthFailure && rawErrorMessage) {
				event.message = { ...event.message, errorMessage: session.lastTurnErrorMessage };
			}
			if (errored) {
				session.consecutiveErrorTurns = (session.consecutiveErrorTurns ?? 0) + 1;
				if (providerAuthFailure) {
					this.surfaceProviderAuthFailure(session, rawErrorMessage || "Provider API key is missing", "agent turn");
				}
			} else {
				// Any non-error terminal assistant message resets the cap budget.
				// Only stopReason:"error" advances the counter.
				session.consecutiveErrorTurns = 0;
			}
		}

		if (event.type === "agent_start") {
			// The session has begun its turn — clear the boot re-prompt marker so
			// the set doesn't leak across the process lifetime (restoreSession is
			// also re-invoked on in-place respawn).
			this._bootRepromptedSessions.delete(session.id);
			session.latestTurnUserText = undefined;
			session.latestTurnAssistantText = undefined;
			session.lastTurnErrored = false;
			session.lastTurnErrorMessage = undefined;
			session.turnHadToolCalls = false;
			session.streamingStartedAt = Date.now();
			this.resolveStoreForSession(session.id).update(session.id, { wasStreaming: true, streamingStartedAt: session.streamingStartedAt });
			broadcastStatus(session, "streaming", { streamingStartedAt: session.streamingStartedAt });
			// Clear the inbox nudger's per-staff guard so a fresh batch can be
			// delivered next time the staff goes idle with pending entries.
			// Hook fires for every session that starts a turn; the nudger
			// itself filters down to staff sessions via its own staff lookup.
			if (this._inboxNudger && session.staffId) {
				try {
					this._inboxNudger.onAgentStart(session.id);
				} catch (err) {
					console.warn(`[session-manager] inboxNudger.onAgentStart failed for ${session.id}:`, err);
				}
			}
		} else if (event.type === "agent_end") {
			// Revoke one-time granted tools after the turn completes
			if (session.oneTimeGrantedTools && session.oneTimeGrantedTools.length > 0) {
				const toRevoke = new Set(session.oneTimeGrantedTools.map(t => t.toLowerCase()));
				session.allowedTools = (session.allowedTools || []).filter(
					t => !toRevoke.has(t.toLowerCase())
				);
				session.oneTimeGrantedTools = [];
			}

			// Safety net: if steers arrived after the last tool call or during a
			// non-tool turn (no tool_execution_end fired), dispatch them now.
			if (session.status !== "aborting") {
				const steered = session.promptQueue.dequeueAllSteered();
				if (steered.length > 0) void this._dispatchSteer(session, steered).catch(() => {});
			}

			const wasAborting = session.status === "aborting";
			if (wasAborting) {
				// Reconcile in-flight steers that the SDK accepted but never
				// echoed because the turn was aborted. Re-enqueueing at front
				// as steered means drainQueue → _dispatchSteer redispatches
				// the batch on the next turn. Plus a defensive rebroadcast in
				// case the queue was mutated mid-abort.
				this._reconcileAfterAbort(session);
				this.broadcastQueue(session);

				// User-initiated abort: clear lastTurnErrored so the queue
				// drains. The error stopReason on the aborted assistant
				// message_end is a side-effect of the user pressing Stop, NOT
				// a model malfunction. Queued steered messages represent fresh
				// user intent that should dispatch immediately — leaving the
				// flag set would park them until the next enqueuePrompt's
				// implicit unstick, which is exactly the bug repro'd by
				// tests/e2e/ui/steer-during-bash-tool.spec.ts (MOCK_ABORT_AS_ERROR).
				// Reset the consecutive-error counter too — a Stop click is a
				// successful user-controlled exit, not a streak of failures.
				session.lastTurnErrored = false;
				session.lastTurnErrorMessage = undefined;
				session.consecutiveErrorTurns = 0;
			}

			session.streamingStartedAt = undefined;
			session.completedTurnCount = (session.completedTurnCount ?? 0) + 1;
			// Extension Platform G1.4: notify lifecycle providers a turn completed.
			// Fire-and-forget — NEVER await into the agent_end event path, and
			// swallow/log all errors so a slow or throwing provider can't stall
			// the lifecycle. Per-provider timeouts are enforced inside the hub.
			if (this.lifecycleHub) {
				const turnIndex = session.completedTurnCount;
				void this.lifecycleHub.dispatch("afterTurn", {
					sessionId: session.id,
					projectId: session.projectId,
					scope: session.projectId ? "project" : "global",
					cwd: session.cwd,
					// Effective goal: members/delegates/reviewers carry teamGoalId, not
					// goalId — resolve both so disabled-provider filtering applies.
					goalId: session.goalId ?? session.teamGoalId,
					roleName: session.role,
					prompt: session.latestTurnUserText,
					userText: session.latestTurnUserText,
					assistantText: session.latestTurnAssistantText,
					turn: { index: turnIndex },
				}).catch((err: unknown) => {
					console.warn(`[session-manager] afterTurn dispatch failed for ${session.id}:`, err);
				});
			}
			this.resolveStoreForSession(session.id).update(session.id, { wasStreaming: false, streamingStartedAt: undefined });
			broadcastStatus(session, "idle");
			this.resolveIdleWaiters(session.id);
			// Don't drain the queue if the turn ended with a model error —
			// queued/steered messages should wait for a retry.
			if (!session.lastTurnErrored) {
				session.transientRetryAttempts = 0;
				// Fresh budget for the one-microtask drainQueue→finishRun race on
				// this turn boundary (see MAX_RECOVER_DRAIN_RETRIES).
				session.recoverDrainAttempts = 0;
				this.drainQueue(session);
			} else {
				// Auto-retry transient model/streaming glitches (e.g. malformed
				// tool-call JSON from the model's streamed input_json_delta).
				// Matches the set of patterns the verification harness already
				// treats as transient. Bounded by maxAttempts so a reliably
				// broken model surfaces the error instead of looping.
				this.maybeAutoRetryTransient(session);
			}

			// Trigger deferred setup after the first agent turn completes.
			// This runs model selection, thinking level, and metadata persistence
			// without blocking the user's first prompt.
			if (!session.setupComplete) {
				session.setupComplete = true;
				this._finishSessionSetup(session).catch((err: unknown) => {
					console.error(`[session-manager] Deferred setup error for session ${session.id}:`, err);
				});
			}
		} else if (event.type === "auto_compaction_start" || event.type === "compaction_start") {
			session.isCompacting = true;
			// Stash start state for the sidecar append on _end. The bobbit
			// manual path owns its own append in ws/handler.ts and signals via
			// `_sidecarOwnedByHandler` so we don't double-write here. Pi-coding-
			// agent itself ALSO emits a compaction_start for the manual path —
			// match the handler's stash, don't replace it.
			const reason = (event as any).reason;
			if (reason !== "manual" && !(session as any)._pendingCompactionStart) {
				// Generate the compactionId ONCE at start so the sidecar entry id,
				// the broadcast end-event, and the client's live `compact_active`
				// card all share the same id. The live card uses it to mount the
				// pre-compaction-history affordance in-session (no reload needed).
				const startedAtMs = Date.now();
				(session as any)._pendingCompactionStart = {
					startedAtMs,
					trigger: reason === "overflow" ? "overflow" as const : "auto" as const,
					compactionId: makeCompactionId(startedAtMs),
				};
			}
		} else if (event.type === "auto_compaction_end" || event.type === "compaction_end") {
			session.isCompacting = false;
			const pending = (session as any)._pendingCompactionStart as
				| { startedAtMs: number; trigger: "auto" | "overflow"; compactionId: string }
				| undefined;
			const reason = (event as any).reason;
			// Manual path is handled in ws/handler.ts. Auto/overflow path writes
			// the sidecar here from the upstream CompactionResult.
			if (reason !== "manual" && pending) {
				const endedAtMs = Date.now();
				const result = (event as any).result as
					| { tokensBefore?: number; firstKeptEntryId?: string }
					| undefined;
				const aborted = !!(event as any).aborted;
				const errorMessage = (event as any).errorMessage as string | undefined;
				const success = !!result && !aborted && !errorMessage;
				try {
					// Append the sidecar SYNCHRONOUSLY before refreshAfterCompaction
					// so the post-compaction snapshot (and the live card's affordance
					// fetch) see the orphan boundary immediately. Reuse the start-time
					// compactionId so it matches the id we broadcast on the end event.
					appendCompactionSidecarEntry(session.id, {
						schemaVersion: 1,
						id: pending.compactionId,
						trigger: pending.trigger,
						tokensBefore: result?.tokensBefore ?? null,
						tokensAfter: null,
						durationMs: endedAtMs - pending.startedAtMs,
						startedAt: new Date(pending.startedAtMs).toISOString(),
						endedAt: new Date(endedAtMs).toISOString(),
						success,
						error: success ? undefined : (errorMessage || (aborted ? "aborted" : "compaction failed")),
						firstKeptEntryId: result?.firstKeptEntryId ?? null,
					});
				} catch (err) {
					console.warn(`[session-manager] Failed to append compaction sidecar for ${session.id}:`, err);
				}
				// Stamp the broadcast end-event with the shared compactionId so the
				// client stamps its live `compact_active` card with it (the card the
				// user is looking at then mounts the affordance immediately). The
				// event object is forwarded to clients verbatim by emitSessionEvent
				// after this handler returns. Only when the compaction succeeded —
				// a failed compaction has no orphan boundary to recover.
				if (success) (event as any).compactionId = pending.compactionId;
			}
			// Manual path: ws/handler.ts stashes the shared compactionId on the
			// session synchronously before the RPC. The agent emits this manual
			// `compaction_end` BEFORE the RPC promise resolves in ws/handler.ts,
			// and we call refreshAfterCompaction() below. If we waited for the
			// ws-handler's post-RPC append, that snapshot would lack the persisted
			// sidecar anchor and the live card would stay positive-ordered (sorts
			// after the preserved tail). So write the SUCCESS sidecar row HERE,
			// synchronously, before refreshAfterCompaction — using the stashed
			// compactionId and this event's result payload. ws/handler.ts still
			// owns the FAILURE append (when the RPC rejects without ever emitting a
			// successful compaction_end), and skips its own success append via the
			// `_manualSidecarWritten` marker so we don't double-write.
			if (reason === "manual") {
				const manualId = (session as any)._manualCompactionId as string | undefined;
				const manualAborted = !!(event as any).aborted;
				const manualError = (event as any).errorMessage as string | undefined;
				const manualResult = (event as any).result as
					| { tokensBefore?: number; firstKeptEntryId?: string }
					| undefined;
				const manualSuccess = !!manualId && !manualAborted && !manualError && !!manualResult;
				if (manualId && !manualAborted) (event as any).compactionId = manualId;
				if (manualId && manualSuccess) {
					const endedAtMs = Date.now();
					const startedAtMs = parseCompactionStartMs(manualId) ?? endedAtMs;
					try {
						const wrote = appendCompactionSidecarEntry(session.id, {
							schemaVersion: 1,
							id: manualId,
							trigger: "manual",
							tokensBefore: manualResult?.tokensBefore ?? null,
							tokensAfter: null,
							durationMs: Math.max(0, endedAtMs - startedAtMs),
							startedAt: new Date(startedAtMs).toISOString(),
							endedAt: new Date(endedAtMs).toISOString(),
							success: true,
							firstKeptEntryId: manualResult?.firstKeptEntryId ?? null,
						});
						// Tell ws/handler.ts not to append a duplicate success row — but
						// ONLY if our append actually succeeded. On failure leave the
						// marker unset so the ws/handler.ts fallback can append the row
						// when the RPC resolves (otherwise the sidecar boundary is lost).
						if (wrote) (session as any)._manualSidecarWritten = manualId;
					} catch (err) {
						console.warn(`[session-manager] Failed to append manual compaction sidecar for ${session.id}:`, err);
					}
				}
				(session as any)._manualCompactionId = undefined;
			}
			(session as any)._pendingCompactionStart = undefined;
			if (!(event as any).aborted) this.refreshAfterCompaction(session);
		} else if (event.type === "process_exit") {
			session.streamingStartedAt = undefined;
			this.resolveStoreForSession(session.id).update(session.id, {
				wasStreaming: false,
				streamingStartedAt: undefined,
			});
			const reason = event.signal ? `signal ${event.signal}` : `code ${event.code}`;
			this.rejectIdleWaiters(session.id, new Error(`Agent process exited unexpectedly (${reason}) for session ${session.id}`));
			void this.closeExtensionChannelsForSession(session.id, "session-process-exit");
			broadcastStatus(session, "terminated");
		}

		// Index completed messages for search (user + assistant). The
		// content policy inside SearchService runs extractForIndexing and
		// emits one row per text / tool_use / tool_result block.
		if (event.type === "message_end" && event.message) {
			try {
				const goalTitle = session.goalId ? this.resolveGoal(session.goalId)?.title : undefined;
				this.resolveSearchIndex(session).indexMessage({
					sessionId: session.id,
					sessionTitle: session.title,
					message: event.message,
					timestamp: Date.now(),
					projectId: session.projectId || undefined,
					goalId: session.goalId,
					goalTitle,
				});
			} catch {
				// Non-critical — don't break message flow
			}
		}

		// Detect PR creation in bash tool results
		if (event.type === "message_end" && event.message && this._onPrCreationDetected) {
			const content = event.message.content;
			if (Array.isArray(content)) {
				let prDetected = false;
				const PR_CMD_RE = /gh\s+pr\s+(create|ready)/;
				const PR_URL_RE = /github\.com\/[^/]+\/[^/]+\/pull\/\d+/;
				for (const block of content) {
					if (block.type === "tool_use" && /^[Bb]ash$/.test(block.name) && block.input?.command) {
						if (PR_CMD_RE.test(block.input.command)) { prDetected = true; break; }
					}
					if (block.type === "tool_result") {
						const text = typeof block.content === "string" ? block.content
							: Array.isArray(block.content) ? block.content.map((c: any) => typeof c === "string" ? c : c.text || "").join("") : "";
						if (PR_URL_RE.test(text)) { prDetected = true; break; }
					}
					if (block.type === "text" && typeof block.text === "string" && PR_URL_RE.test(block.text)) {
						prDetected = true; break;
					}
				}
				if (prDetected) {
					this._onPrCreationDetected(session);
				}
			}
		}
	}

	/**
	 * Auto-retry a turn that ended with a transient model/streaming error.
	 *
	 * Two policies, selected by error class:
	 *
	 * - Provider overload / rate-limit (`isProviderBackoffError`, e.g.
	 *   Anthropic `overloaded_error`, `rate_limit_error`, HTTP 429/529):
	 *   effectively unbounded retries with exponential backoff capped at
	 *   5 minutes and ±20% jitter. Overload events can legitimately last
	 *   10+ minutes; surfacing the error to the user is worse than waiting.
	 *
	 * - Other transient glitches (malformed tool-call JSON, ECONNRESET, etc.):
	 *   bounded 3 attempts at 1s/2s/4s, after which the error surfaces and
	 *   the user can manually retry.
	 *
	 * - Retryable generic agent/runtime errors (sanitized unexpected/internal
	 *   system errors): bounded 3 attempts at 1s/5s/60s, then manual retry.
	 */
	maybeAutoRetryTransient(session: SessionInfo): boolean {
		const BOUNDED_MAX_ATTEMPTS = 3;
		const PROVIDER_BACKOFF_MAX_MS = 300_000; // 5 minutes
		const GENERIC_RETRY_DELAYS_MS = [1000, 5000, 60_000] as const;
		const errMsg = session.lastTurnErrorMessage || "";
		if (!errMsg) return false;
		if (isNonRetryableAgentError(errMsg)) return false;

		const isBackoff = isProviderBackoffError(errMsg);
		const isTransient = isTransientReviewError(errMsg);
		const isGenericRetryable = !isTransient && isRetryableGenericAgentError(errMsg);
		if (!isBackoff && !isTransient && !isGenericRetryable) return false;

		const attempt = (session.transientRetryAttempts ?? 0) + 1;

		if (!isBackoff && attempt > BOUNDED_MAX_ATTEMPTS) {
			const label = isGenericRetryable ? "generic" : "transient";
			console.warn(
				`[session-manager] Session ${session.id} exhausted ${BOUNDED_MAX_ATTEMPTS} ${label} auto-retries; surfacing error to user. Last error: ${errMsg.slice(0, 200)}`
			);
			session.transientRetryAttempts = 0;
			// Dispatch-time failures can exhaust before an agent_start arrives to
			// clear the last visible countdown. Emit the standard cancellation
			// frame even though the timer already fired so the UI does not keep a
			// stale "retrying" banner while manual Retry is required.
			this.cancelPendingAutoRetry(session, "new-prompt", { emitWithoutTimer: true });
			return false;
		}
		session.transientRetryAttempts = attempt;

		const delayMs = isBackoff
			? nextBackoffDelay(attempt, { baseMs: 1000, maxMs: PROVIDER_BACKOFF_MAX_MS, jitterRatio: 0.2 })
			: isGenericRetryable
				? GENERIC_RETRY_DELAYS_MS[attempt - 1]!
				: 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s (preserve exact legacy schedule)

		if (isBackoff) {
			console.log(
				`[session-manager] Session ${session.id} hit provider overload/rate-limit (attempt ${attempt}); auto-retrying in ${Math.round(delayMs / 1000)}s. Error: ${errMsg.slice(0, 200)}`
			);
		} else if (isGenericRetryable) {
			console.log(
				`[session-manager] Session ${session.id} turn failed with a retryable generic error (attempt ${attempt}/${BOUNDED_MAX_ATTEMPTS}), auto-retrying in ${delayMs / 1000}s. Error: ${errMsg.slice(0, 200)}`
			);
		} else {
			console.log(
				`[session-manager] Session ${session.id} turn failed transiently (attempt ${attempt}/${BOUNDED_MAX_ATTEMPTS}), auto-retrying in ${delayMs / 1000}s. Error: ${errMsg.slice(0, 200)}`
			);
		}

		// Visible UI notification while the retry timer is pending. The session
		// status remains "idle" (set by the agent_end handler) but we broadcast
		// a synthetic event so the UI can show "Retrying in Xs due to provider
		// overload…" instead of looking frozen.
		const pendingEvent: AutoRetryPendingEvent = {
			type: "auto_retry_pending",
			reason: isBackoff ? "provider-overload" : "transient-error",
			retryDelayMs: Math.round(delayMs),
			attempt,
			scheduledAt: Date.now(),
			error: errMsg.slice(0, 200),
		};
		// WP4/RC3: route through emitSessionEvent so the frame gets a seq, enters
		// the EventBuffer, and replays on resume — a reconnect during backoff no
		// longer orphans a stale "Retrying…" banner (S5/S21).
		emitSessionEvent(session, pendingEvent);

		if (session.pendingAutoRetryTimer) clearTimeout(session.pendingAutoRetryTimer);
		const generation = session.lifecycleGeneration ?? 0;
		session.pendingAutoRetryTimer = setTimeout(() => {
			session.pendingAutoRetryTimer = undefined;
			// Session may have been terminated or replaced in the meantime.
			if ((session.lifecycleGeneration ?? 0) !== generation) return;
			if (!this._sessionWriterIsCurrent(session)) return;
			if (session.status !== "idle") return; // user sent something, or already retrying
			// Auto path: preserve `transientRetryAttempts` so successive overload
			// failures continue growing the backoff toward the 5-minute cap.
			this.retryLastPrompt(session.id, { auto: true }).catch((err) => {
				console.error(`[session-manager] Auto-retry failed for session ${session.id}:`, err);
			});
		}, delayMs);
		return true;
	}

	/**
	 * Cancel any pending auto-retry timer for this session and broadcast a
	 * synthetic `auto_retry_cancelled` event so UI banners can clear. Safe to
	 * call when no timer is pending — no-op in that case.
	 */
	cancelPendingAutoRetry(
		session: SessionInfo,
		reason: "explicit-retry" | "new-prompt" | "terminated" | "shutdown",
		opts?: { emitWithoutTimer?: boolean },
	): void {
		const hadTimer = !!session.pendingAutoRetryTimer;
		if (session.pendingAutoRetryTimer) clearTimeout(session.pendingAutoRetryTimer);
		session.pendingAutoRetryTimer = undefined;
		if (!hadTimer && !opts?.emitWithoutTimer) return;
		if (reason !== "shutdown") {
			const cancelledEvent: AutoRetryCancelledEvent = {
				type: "auto_retry_cancelled",
				reason,
				cancelledAt: Date.now(),
			};
			// WP4/RC3: seq + buffer + replay (see auto_retry_pending above).
			emitSessionEvent(session, cancelledEvent);
		}
	}

	/**
	 * Recover a session whose previous turn errored on the blank-ContentBlock
	 * validation error (image/attachment-only prompt poison). The live process's
	 * in-memory history still holds the committed blank block, so re-prompting it
	 * would re-fail; respawn it in place so it rehydrates from the sanitized
	 * `.jsonl` (the switch_session boundary runs sanitizeAgentTranscriptFile).
	 *
	 * Returns the restored session when a respawn happened, or `undefined` when
	 * no respawn was performed — there is no persisted transcript file to
	 * rehydrate from (e.g. the unit harness), so the caller should fall back to
	 * its normal (synthesized-text) dispatch against the existing process.
	 *
	 * Shared by both recovery entry points: explicit `retryLastPrompt` and the
	 * implicit-unstick follow-up prompt path in `enqueuePrompt`.
	 */
	async _recoverBlankTextPoison(session: SessionInfo): Promise<SessionInfo | undefined> {
		let ps: PersistedSession | undefined;
		try { ps = this.resolveStoreForSession(session.id).get(session.id); }
		catch { ps = undefined; }
		if (!ps?.agentSessionFile) return undefined;
		const restored = await this._respawnAgentInPlace(session, ps);
		return restored ?? this.sessions.get(session.id);
	}

	consumeRecoveredPromptDispatchRows(session: SessionInfo): boolean {
		const ids = session.recoveredPromptDispatchQueueIds;
		if (!ids?.length) return false;
		let removedAny = false;
		for (const id of ids) {
			removedAny = session.promptQueue.remove(id) || removedAny;
		}
		session.recoveredPromptDispatchQueueIds = undefined;
		if (removedAny) this.broadcastQueue(session);
		return removedAny;
	}

	consumeQueuedRetryRow(session: SessionInfo, candidateTexts: Array<string | undefined>, images?: Array<{ type: "image"; data: string; mimeType: string }>): boolean {
		const textSet = new Set(candidateTexts.filter((text): text is string => typeof text === "string"));
		if (textSet.size === 0) return false;
		const imageSignature = JSON.stringify(images ?? []);
		const row = session.promptQueue.toArray().find((queued) => {
			if (!textSet.has(queued.text)) return false;
			return JSON.stringify(queued.images ?? []) === imageSignature;
		});
		if (!row) return false;
		const removed = session.promptQueue.remove(row.id);
		if (removed) this.broadcastQueue(session);
		return removed;
	}

	/**
	 * Retry after a model/API error. Behaviour depends on context:
	 * - Fresh response error (no tool calls): re-sends the original user prompt
	 * - Mid-work error (tool calls already executed): sends a system continuation
	 */
	async retryLastPrompt(sessionId: string, opts?: { auto?: boolean }): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error("Session not found");

		const isAuto = opts?.auto === true;
		const hadToolCalls = session.turnHadToolCalls;
		// Capture before clearing — used to route a live blank-text-poisoned
		// session through respawn so it rehydrates from the sanitized transcript.
		const poisonedByBlankText = isBlankContentBlockError(session.lastTurnErrorMessage);
		const savedPromptText = session.lastPromptText;
		const savedPromptImages = session.lastPromptImages;
		session.lastTurnErrored = false;
		session.turnHadToolCalls = false;
		// Explicit retry resets the cap — human intervention gets a fresh budget.
		// Auto retry must NOT reset, or the backoff would never grow toward the cap.
		if (!isAuto) {
			session.consecutiveErrorTurns = 0;
			// Explicit user retry also resets the transient-retry budget so the
			// next failure starts again at the 1s base. The auto-retry timer
			// path preserves this counter so the delay grows toward the cap.
			session.transientRetryAttempts = 0;
		}
		// In the auto path the timer has already cleared itself; this is a no-op.
		// In the explicit path it tears down any in-flight pending banner.
		this.cancelPendingAutoRetry(session, "explicit-retry");

		// Live blank-text-poisoned recovery: re-prompting the same process would
		// replay the committed blank ContentBlock and re-fail. Respawn the agent
		// so it rehydrates from the sanitized `.jsonl` (un-poisoned at the
		// switch_session boundary), then re-dispatch the synthesized prompt with
		// its image preserved. Returns undefined (no respawn) when there's no
		// persisted transcript file (e.g. unit harness) — the normal branch below
		// already synthesizes text.
		if (poisonedByBlankText) {
			const target = await this._recoverBlankTextPoison(session);
			if (target) {
				// We know this turn was a blank-content poison, so attachment/image
				// content was present. For a legacy non-image attachment-only
				// failure savedPromptText==="" and savedPromptImages===undefined, so
				// synthesizeAttachmentText returns "" — fall back to the synthetic
				// phrase unconditionally rather than re-send blank/invalid content.
				let retryText = synthesizeAttachmentText(savedPromptText ?? "", savedPromptImages);
				if (retryText.trim() === "") retryText = ATTACHMENT_ONLY_TEXT;
				target.lastPromptText = retryText;
				target.lastPromptImages = savedPromptImages;
				await this.dispatchDirectPrompt(target, retryText, savedPromptImages);
				return;
			}
		}

		if (hadToolCalls) {
			// Agent was mid-work — send a system continuation prompt
			await this.dispatchDirectPrompt(session,
				"[SYSTEM: The model API returned an error while you were mid-turn. " +
				"Your previous work has been preserved. Please continue where you left off. " +
				"Do NOT start over — review your recent messages and resume from the exact point of interruption.]"
			);
		} else if (session.lastPromptText || session.lastPromptImages?.length) {
			// Fresh response error — re-send the original prompt. Run the text
			// through synthesizeAttachmentText so an already-stuck session whose
			// last prompt was image/attachment-only (lastPromptText blank or
			// whitespace) re-dispatches with a valid non-blank body AND preserves
			// the image, instead of replaying blank text or falling through to the
			// generic fallback branch (which drops the image).
			const retryText = synthesizeAttachmentText(session.lastPromptText ?? "", session.lastPromptImages);
			// Dispatch failures before agent_start re-enqueue the failed row for
			// recovery. Explicit/auto retry is the recovery dispatch, so consume
			// that row first; otherwise the next successful agent_end drain would
			// send it a second time. Prefer tracked recovery row IDs; fall back to
			// text matching for sessions created before the ID ledger existed.
			if (!this.consumeRecoveredPromptDispatchRows(session)) {
				this.consumeQueuedRetryRow(session, [retryText, session.lastPromptText], session.lastPromptImages);
			}
			await this.dispatchDirectPrompt(session, retryText, session.lastPromptImages);
		} else {
			// Fallback (e.g. session predates error tracking)
			this.consumeRecoveredPromptDispatchRows(session);
			await this.dispatchDirectPrompt(session,
				"[SYSTEM: The model API returned an error on your last response. " +
				"Please review your conversation history and retry what you were doing.]"
			);
		}
	}

}
