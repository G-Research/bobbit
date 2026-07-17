/**
 * <gate-verification-live> — Lit element that subscribes to gate-verification-event
 * CustomEvents on document and renders live step cards with timers.
 *
 * Uses the shared delegate-cards.ts components to match the delegate UX pattern.
 * Used by GateSignalRenderer (chat) and could be embedded in the dashboard.
 */
import { LitElement, html, nothing, type TemplateResult, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { ensureMarkdownBlock } from "../../lazy/markdown-block.js";
import "../../components/LiveTimer.js";
import "../../components/VerificationOutputModal.js";
import { ansiToHtml, hasAnsi } from "../../utils/ansi.js";
import { GATE_STATUS_CLIENT_EVENT, HUMAN_SIGNOFF_RESOLVED_EVENT_TYPE } from "../../../app/gate-status-events.js";
import { getVerificationEventKey } from "../../../app/verification-event-bus.js";
import "../../components/SignoffReviewLauncher.js";
import {
	type DelegateCardEntry,
	statusColor,
	statusIcon,
	renderDuration,
	renderSessionLink,
} from "./delegate-cards.js";

type VerificationStepStatus = "running" | "passed" | "failed" | "timeout" | "waiting" | "skipped" | "blocked";

type VerificationTimeoutInfo = {
	configuredSeconds: number;
	elapsedMs: number;
};

type InitialVerificationStep = {
	name: string;
	type: string;
	status?: string;
	passed?: boolean | null;
	skipped?: boolean;
	phase?: number;
	durationMs?: number;
	duration_ms?: number;
	output?: string;
	startedAt?: number;
	sessionId?: string;
	timeout?: VerificationTimeoutInfo;
	awaitingHuman?: boolean;
	humanLabel?: string;
	humanPrompt?: string;
};

interface VerificationStep {
	name: string;
	type: string;
	status: VerificationStepStatus;
	phase?: number;
	durationMs?: number;
	output?: string;
	startedAt: number;
	sessionId?: string;
	timeout?: VerificationTimeoutInfo;
	awaitingHuman?: true;
	humanLabel?: string;
	humanPrompt?: string;
}

function normalizeStepStatus(step: Partial<InitialVerificationStep>, fallback: VerificationStepStatus = "running"): VerificationStepStatus {
	if (typeof step.status === "string") {
		const key = step.status.toLowerCase().replace(/_/g, "-");
		if (key === "passed" || key === "success" || key === "completed") return "passed";
		if (key === "timeout") return "timeout";
		if (key === "failed" || key === "failure" || key === "error") return "failed";
		if (key === "skipped") return "skipped";
		if (key === "waiting" || key === "pending" || key === "queued" || key === "yet-to-run") return "waiting";
		if (key === "blocked" || key === "blocked-by-earlier-failure") return "blocked";
		if (key === "running" || key === "in-progress" || key === "starting") return "running";
	}
	if (step.skipped) return "skipped";
	if (step.passed === true) return "passed";
	if (step.passed === false) return fallback;
	if (step.passed === null) return "running";
	return fallback;
}

function mapVerificationStep(step: InitialVerificationStep, fallback: VerificationStepStatus = "running"): VerificationStep {
	const status = normalizeStepStatus(step, fallback);
	const durationMs = step.durationMs ?? step.duration_ms;
	const isAwaitingHuman = step.type === "human-signoff" && status === "running" && step.awaitingHuman === true;
	return {
		name: step.name,
		type: step.type,
		status,
		phase: step.phase,
		durationMs,
		output: step.output,
		startedAt: step.startedAt || (durationMs && durationMs > 0 ? Date.now() - durationMs : status === "running" ? Date.now() : 0),
		sessionId: step.sessionId,
		timeout: step.timeout,
		...(isAwaitingHuman ? {
			awaitingHuman: true as const,
			humanLabel: step.humanLabel,
			humanPrompt: step.humanPrompt,
		} : {}),
	};
}

function clearAwaitingHuman(step: VerificationStep): VerificationStep {
	const { awaitingHuman: _awaitingHuman, humanLabel: _humanLabel, humanPrompt: _humanPrompt, ...cleared } = step;
	return cleared;
}

function preserveAwaitingHuman(next: VerificationStep, previous: VerificationStep | undefined): VerificationStep {
	if (next.type !== "human-signoff" || next.status !== "running" || !previous || previous.name !== next.name || previous.awaitingHuman !== true) return next;
	return {
		...next,
		awaitingHuman: true,
		humanLabel: previous.humanLabel,
		humanPrompt: previous.humanPrompt,
	};
}

function hasExplicitStepStatus(step: InitialVerificationStep): boolean {
	return normalizeStepStatus({ status: step.status }, "running") !== "running" || step.status === "running" || step.status === "in-progress" || step.status === "in_progress" || step.status === "starting";
}

/** Map verification step status to delegate-cards status strings */
function toDelegateStatus(status: string): string {
	if (status === "passed") return "completed";
	if (status === "failed" || status === "timeout") return "error";
	if (status === "waiting") return "waiting";
	if (status === "skipped" || status === "blocked") return "skipped";
	return "running";
}

function stepStatusBadgeClass(status: VerificationStepStatus): string {
	if (status === "passed") return "bg-green-500/15 text-green-700 dark:text-green-300";
	if (status === "failed") return "bg-red-500/15 text-red-700 dark:text-red-300";
	if (status === "timeout") return "bg-warning/15 text-warning";
	if (status === "running") return "bg-blue-500/15 text-blue-700 dark:text-blue-300";
	return "bg-muted text-muted-foreground";
}

function statusSummary(steps: VerificationStep[]): string {
	const counts = new Map<VerificationStepStatus, number>();
	for (const step of steps) counts.set(step.status, (counts.get(step.status) || 0) + 1);
	const labels: Array<[VerificationStepStatus, string]> = [
		["passed", "passed"],
		["failed", "failed"],
		["timeout", "timed out"],
		["running", "running"],
		["waiting", "waiting"],
		["blocked", "blocked"],
		["skipped", "skipped"],
	];
	return labels
		.map(([status, label]) => {
			const count = counts.get(status) || 0;
			return count > 0 ? `${count} ${label}` : "";
		})
		.filter(Boolean)
		.join(", ");
}

function timeoutInfo(value: unknown): VerificationTimeoutInfo | undefined {
	if (!value || typeof value !== "object") return undefined;
	const marker = value as Partial<VerificationTimeoutInfo>;
	if (typeof marker.configuredSeconds !== "number" || !Number.isFinite(marker.configuredSeconds) || marker.configuredSeconds <= 0) return undefined;
	if (typeof marker.elapsedMs !== "number" || !Number.isFinite(marker.elapsedMs) || marker.elapsedMs < 0) return undefined;
	return marker as VerificationTimeoutInfo;
}

function formatTimeoutTiming(timeout: VerificationTimeoutInfo): string {
	return `${(timeout.elapsedMs / 1000).toFixed(1)}s elapsed · ${timeout.configuredSeconds}s limit`;
}

function shouldRenderDuration(step: VerificationStep): boolean {
	if (step.status === "waiting" || step.status === "blocked") return false;
	if (step.status === "skipped" && !(step.durationMs && step.durationMs > 0)) return false;
	if (step.status === "running") return !!step.startedAt || !!step.durationMs;
	return step.durationMs != null;
}

/** Build a DelegateCardEntry-compatible object for renderDuration() */
function toCardEntry(step: VerificationStep, index: number): DelegateCardEntry {
	const delegateStatus = toDelegateStatus(step.status);
	// For running steps, prefer the live startedAt clock and fall back to an API-provided elapsed duration.
	const durationMs = step.status === "running"
		? (step.startedAt ? Math.max(0, Date.now() - step.startedAt) : (step.durationMs ?? 0))
		: (step.durationMs ?? 0);
	return {
		id: `step-${index}`,
		name: step.name || "step",
		status: delegateStatus,
		durationMs,
		sessionId: step.sessionId,
	};
}

@customElement("gate-verification-live")
export class GateVerificationLive extends LitElement {
	@property() goalId = "";
	@property() gateId = "";
	@property() signalId = "";
	/** If set, used to show static final state when no events arrive (e.g. chat history). */
	@property() finalStatus: string | undefined;
	/** Step definitions or active snapshot from signal response — used before WS events arrive. */
	@property({ type: Array }) initialSteps: InitialVerificationStep[] = [];

	@state() private steps: VerificationStep[] = [];
	@state() private overallStatus: "idle" | "running" | "passed" | "failed" | "stale" = "idle";
	@state() private currentPhase = 0;
	@state() private expandedSteps = new Set<number>();
	@state() private modalStep: { index: number; name: string; output: string; type: string } | null = null;
	/** Accumulated streamed output per step index */
	private _stepOutputs = new Map<number, string>();

	private _reconcileTimer?: ReturnType<typeof setTimeout>;
	/** Repeating reconcile against the authoritative REST snapshot so a running
	 * spinner cannot outlive a verification that died without a completion event. */
	private _reconcileInterval?: ReturnType<typeof setInterval>;
	private static readonly _RECONCILE_INTERVAL_MS = 8_000;
	/** Throttled re-render after streaming output events (high-frequency). */
	private _outputFlushTimer?: ReturnType<typeof setTimeout>;
	private _abortCtrl?: AbortController;
	/** Per-instance dedupe window — collapses identical events delivered via
	 * the document-level fan-out (one per session WS in the goal). */
	private _seenEvents: Set<string> = new Set();
	private _seenEventsOrder: string[] = [];
	private static readonly _SEEN_CAP = 4096;

	override createRenderRoot() { return this; }

	override willUpdate(_changed: PropertyValues) {
		// Seed steps from initialSteps once, before the gate_verification_started WS event arrives.
		// Prefer explicit snapshot status semantics over legacy passed:false seed rows.
		if (this.overallStatus === "idle" && this.steps.length === 0 && this.initialSteps.length > 0) {
			const fallback = this.finalStatus === "passed" ? "passed" : this.finalStatus === "failed" ? "failed" : "running";
			this.steps = this.initialSteps.map(s => mapVerificationStep(s, fallback));
			this.overallStatus = this.finalStatus === "passed" || this.finalStatus === "failed" ? this.finalStatus : "running";
			for (let i = 0; i < this.steps.length; i++) {
				if (this.steps[i].output && !this._stepOutputs.has(i)) this._stepOutputs.set(i, this.steps[i].output!);
			}
		}
	}

	override connectedCallback() {
		ensureMarkdownBlock();
		super.connectedCallback();
		this._abortCtrl = new AbortController();
		const signal = this._abortCtrl.signal;
		document.addEventListener("gate-verification-event", (e) => this._onEvent(e), { signal });
		window.addEventListener(GATE_STATUS_CLIENT_EVENT, (e) => this._onClientGateEvent(e), { signal });
		// Reconcile when the tab regains visibility or connectivity returns — a
		// verification may have died (or completed) while the tab was hidden or
		// the WS was dropped, and no completion event will be replayed.
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "visible" && this._isReconcilable()) this._fetchAndReconcile();
		}, { signal });
		window.addEventListener("online", () => {
			if (this._isReconcilable()) this._fetchAndReconcile();
		}, { signal });
		this._reconcileTimer = setTimeout(() => {
			if (this._isReconcilable()) this._fetchAndReconcile();
		}, 300);
		this._startReconcileLoop();
	}

	/** Whether the renderer is in a non-terminal state that warrants reconciliation. */
	private _isReconcilable(): boolean {
		return this.overallStatus === "running" || this.overallStatus === "idle";
	}

	private _startReconcileLoop(): void {
		if (this._reconcileInterval) return;
		this._reconcileInterval = setInterval(() => {
			if (!this._isReconcilable()) { this._stopReconcileLoop(); return; }
			if (document.visibilityState !== "visible") return;
			this._fetchAndReconcile();
		}, GateVerificationLive._RECONCILE_INTERVAL_MS);
	}

	private _stopReconcileLoop(): void {
		if (this._reconcileInterval) {
			clearInterval(this._reconcileInterval);
			this._reconcileInterval = undefined;
		}
	}

	private _markEventSeen(key: string): boolean {
		if (!key) return true;
		if (this._seenEvents.has(key)) return false;
		this._seenEvents.add(key);
		this._seenEventsOrder.push(key);
		if (this._seenEventsOrder.length > GateVerificationLive._SEEN_CAP) {
			const evict = this._seenEventsOrder.shift();
			if (evict !== undefined) this._seenEvents.delete(evict);
		}
		return true;
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		this._abortCtrl?.abort();
		this._abortCtrl = undefined;
		this._seenEvents.clear();
		this._seenEventsOrder.length = 0;
		if (this._reconcileTimer) {
			clearTimeout(this._reconcileTimer);
			this._reconcileTimer = undefined;
		}
		this._stopReconcileLoop();
		if (this._outputFlushTimer) {
			clearTimeout(this._outputFlushTimer);
			this._outputFlushTimer = undefined;
		}
	}

	private async _fetchAndReconcile(): Promise<void> {
		if (!this.goalId || !this.gateId || !this.signalId) return;

		const token = localStorage.getItem("gateway.token") || "";
		const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

		try {
			const res = await fetch(`/api/goals/${this.goalId}/gates/${this.gateId}`, { headers });
			if (!res.ok) return;
			const gate = await res.json();

			// Find matching signal
			const signal = gate.signals?.find((s: any) => s.id === this.signalId);
			if (!signal?.verification) return;

			const vStatus = signal.verification.status;

			if (vStatus === "passed" || vStatus === "failed") {
				// Terminal gate state is authoritative: preserve final passed/failed behavior.
				const fallback = vStatus === "passed" ? "passed" : "failed";
				const steps: VerificationStep[] = (signal.verification.steps || []).map((s: InitialVerificationStep) => mapVerificationStep(s, fallback));
				this.steps = steps;
				this.overallStatus = vStatus;
				return;
			}

			// Still running — prefer active verifications for real-time step state.
			// If the active endpoint is unavailable, only reconcile from gate data when
			// it carries explicit status semantics; never reinterpret legacy passed:false
			// seed rows as failed while the verification is still running.
			if (vStatus === "running") {
				let activeSteps: VerificationStep[] | undefined;
				let activeFetchOk = false;
				let hasLiveActive = false;
				try {
					const activeRes = await fetch(`/api/goals/${this.goalId}/verifications/active`, { headers });
					if (activeRes.ok) {
						activeFetchOk = true;
						const activeData = await activeRes.json();
						const active = activeData.verifications?.find(
							(v: any) => v.signalId === this.signalId
						);
						if (active) hasLiveActive = true;
						if (Array.isArray(active?.steps)) {
							activeSteps = active.steps.map((s: InitialVerificationStep) => mapVerificationStep(s, "running"));
							this.currentPhase = active.currentPhase ?? 0;
						}
					}
				} catch {
					// Gate snapshot fallback below is still safe when explicit statuses exist.
				}

				// STALE transition: persisted state says running, but the authoritative
				// active-verifications endpoint answered and holds NO live entry for this
				// signal (harness died / server restarted / dropped completion event).
				// Do NOT infer stale when the active fetch failed — that could be a
				// transient network blip, not a dead verification.
				if (activeFetchOk && !hasLiveActive) {
					this.steps = (signal.verification.steps || []).map((s: InitialVerificationStep) => {
						const mapped = clearAwaitingHuman(mapVerificationStep(s, "failed"));
						// Any residual running/waiting step is no longer progressing.
						if (mapped.status === "running" || mapped.status === "waiting") mapped.status = "blocked";
						return mapped;
					});
					this.overallStatus = "stale";
					this._stopReconcileLoop();
					this.requestUpdate();
					return;
				}

				const signalSteps = (signal.verification.steps || []) as InitialVerificationStep[];
				if (activeSteps === undefined && signalSteps.some(hasExplicitStepStatus)) {
					activeSteps = signalSteps.map((s, index) => {
						const mapped = mapVerificationStep(s, "running");
						// Gate data is a safe status fallback, but only the active endpoint is
						// authoritative for sign-off markers. Preserve event state when that
						// endpoint failed instead of hiding a valid launcher on a network blip.
						return preserveAwaitingHuman(mapped, this.steps[index]);
					});
				}

				if (activeSteps !== undefined) {
					this.steps = activeSteps;
					this.overallStatus = "running";
					// Seed _stepOutputs from API so modal has initial content.
					for (let i = 0; i < this.steps.length; i++) {
						if (this.steps[i].output && !this._stepOutputs.has(i)) {
							this._stepOutputs.set(i, this.steps[i].output!);
						}
					}
				}
			}
		} catch {
			// Silently ignore fetch errors — this is a best-effort reconciliation
		}
	}

	private _clearAwaitingHuman(detail: any): void {
		const stepIndex = typeof detail?.stepIndex === "number" ? detail.stepIndex : -1;
		const stepName = typeof detail?.stepName === "string" ? detail.stepName : "";
		const updated = this.steps.map((step, index) => {
			if ((stepIndex >= 0 ? index !== stepIndex : step.name !== stepName) || !step.awaitingHuman) return step;
			return clearAwaitingHuman(step);
		});
		if (updated.some((step, index) => step !== this.steps[index])) this.steps = updated;
	}

	private _onClientGateEvent(e: Event): void {
		const detail = (e as CustomEvent).detail;
		if (!detail || detail.type !== HUMAN_SIGNOFF_RESOLVED_EVENT_TYPE) return;
		if (detail.goalId !== this.goalId || detail.gateId !== this.gateId || detail.signalId !== this.signalId) return;
		this._clearAwaitingHuman(detail);
	}

	private _onEvent(e: Event) {
		const detail = (e as CustomEvent).detail;
		if (!detail) return;
		if (detail.gateId !== this.gateId || detail.signalId !== this.signalId) return;
		// Also check goalId if available
		if (this.goalId && detail.goalId && detail.goalId !== this.goalId) return;

		// Per-instance dedupe — same payload may be redispatched once per
		// session WS in the goal team (see verification-event-bus.ts).
		const dedupeKey = getVerificationEventKey(detail);
		if (!this._markEventSeen(dedupeKey)) return;

		switch (detail.type) {
			case "gate_verification_started": {
				this._stepOutputs = new Map();
				this.modalStep = null;
				const stepDefs: Array<{ name: string; type: string; phase?: number }> = detail.steps || [];
				const now = detail.startedAt || Date.now();
				const minPhase = stepDefs.length > 0 ? Math.min(...stepDefs.map(s => s.phase ?? 0)) : 0;
				this.currentPhase = minPhase;
				this.steps = stepDefs.map(s => ({
					name: s.name,
					type: s.type,
					phase: s.phase ?? 0,
					status: ((s.phase ?? 0) === minPhase ? "running" : "waiting") as "running" | "waiting",
					startedAt: now,
				}));
				this.overallStatus = "running";
				this._startReconcileLoop();
				break;
			}
			case "gate_verification_phase_started": {
				const phase = detail.phase as number;
				const stepIndices = detail.stepIndices as number[];
				this.currentPhase = phase;
				const updated = [...this.steps];
				for (const idx of stepIndices) {
					if (idx >= 0 && idx < updated.length && updated[idx].status === "waiting") {
						updated[idx] = { ...updated[idx], status: "running", startedAt: Date.now() };
					}
				}
				this.steps = updated;
				break;
			}
			case "gate_verification_step_started": {
				const idx = detail.stepIndex as number;
				if (idx >= 0 && idx < this.steps.length) {
					const updated = [...this.steps];
					updated[idx] = {
						...updated[idx],
						status: "running",
						startedAt: detail.startedAt || updated[idx].startedAt || Date.now(),
						sessionId: detail.sessionId,
					};
					this.steps = updated;
				}
				this.requestUpdate();
				break;
			}
			case "gate_verification_awaiting_human": {
				const idx = detail.stepIndex as number;
				if (!Number.isInteger(idx) || idx < 0) break;
				let updated = [...this.steps];
				while (updated.length <= idx) {
					updated.push({ name: `Step ${updated.length + 1}`, type: "unknown", status: "waiting", startedAt: 0 });
				}
				const existing = updated[idx];
				updated[idx] = {
					...existing,
					name: typeof detail.stepName === "string" ? detail.stepName : existing.name,
					type: "human-signoff",
					status: "running",
					startedAt: existing.startedAt || Date.now(),
					awaitingHuman: true,
					humanLabel: typeof detail.label === "string"
						? detail.label
						: typeof detail.humanLabel === "string" ? detail.humanLabel : undefined,
					humanPrompt: typeof detail.prompt === "string"
						? detail.prompt
						: typeof detail.humanPrompt === "string" ? detail.humanPrompt : undefined,
				};
				this.steps = updated;
				this.overallStatus = "running";
				this._startReconcileLoop();
				break;
			}
			case "gate_verification_step_complete": {
				const idx = detail.stepIndex as number;
				if (idx >= 0 && idx < this.steps.length) {
					const updated = [...this.steps];
					updated[idx] = {
						...clearAwaitingHuman(updated[idx]),
						status: normalizeStepStatus({ status: detail.status }, "failed"),
						durationMs: detail.durationMs,
						output: detail.output,
						sessionId: detail.sessionId ?? updated[idx].sessionId,
						timeout: detail.timeout,
					};
					this.steps = updated;
				} else if (idx >= this.steps.length) {
					// Step arrived before started event — add dynamically
					while (this.steps.length <= idx) {
						this.steps = [...this.steps, { name: `Step ${this.steps.length + 1}`, type: "unknown", status: "running", startedAt: Date.now() }];
					}
					const updated = [...this.steps];
					updated[idx] = {
						...updated[idx],
						name: detail.stepName || updated[idx].name,
						status: normalizeStepStatus({ status: detail.status }, "failed"),
						durationMs: detail.durationMs,
						output: detail.output,
						timeout: detail.timeout,
					};
					this.steps = updated;
				}
				this.requestUpdate();
				break;
			}
			case "gate_verification_step_output": {
				const idx = detail.stepIndex as number;
				const prev = this._stepOutputs.get(idx) || "";
				let next = prev + (detail.text || "");
				if (next.length > 512 * 1024) next = next.slice(-512 * 1024);
				this._stepOutputs.set(idx, next);
				if (this.modalStep && this.modalStep.index === idx) {
					this.modalStep = { ...this.modalStep, output: next };
				}
				// Throttle re-renders: streaming output events can arrive at kHz.
				// A 200ms flush gives near-real-time updates without overwhelming Lit.
				if (!this._outputFlushTimer) {
					this._outputFlushTimer = setTimeout(() => {
						this._outputFlushTimer = undefined;
						this.requestUpdate();
					}, 200);
				}
				break;
			}
			case HUMAN_SIGNOFF_RESOLVED_EVENT_TYPE: {
				this._clearAwaitingHuman(detail);
				break;
			}
			case "gate_verification_complete": {
				this.steps = this.steps.map(clearAwaitingHuman);
				this.overallStatus = detail.status || "passed";
				this._stopReconcileLoop();
				this.requestUpdate();
				break;
			}
		}
	}

	private _toggleStep(idx: number) {
		const next = new Set(this.expandedSteps);
		if (next.has(idx)) next.delete(idx); else next.add(idx);
		this.expandedSteps = next;
	}

	override render() {
		// No events yet — show placeholder based on finalStatus or idle state
		if (this.overallStatus === "idle" && this.steps.length === 0) {
			if (this.finalStatus === "passed") {
				return html`<div class="mt-2 text-xs ${statusColor("completed")}">${statusIcon("completed")} Passed (no verification)</div>`;
			}
			if (this.finalStatus === "failed") {
				return html`<div class="mt-2 text-xs ${statusColor("error")}">${statusIcon("error")} Failed</div>`;
			}
			return html`<div class="mt-2 text-xs ${statusColor("running")}">Verification in progress…</div>`;
		}

		// Stale/terminated: the verification stopped without completing (harness
		// died / server restart / dropped WS). Render a terminated state with a
		// re-signal affordance instead of a perpetual spinner.
		if (this.overallStatus === "stale" && this.steps.length === 0) {
			return this._renderStaleBanner();
		}

		// Auto-pass: complete arrived with no steps
		if (this.steps.length === 0 && this.overallStatus !== "running") {
			const dStatus = toDelegateStatus(this.overallStatus as "passed" | "failed");
			return html`<div class="mt-2 text-xs ${statusColor(dStatus)}">${statusIcon(dStatus)} ${this.overallStatus === "passed" ? "Passed (no verification)" : "Failed"}</div>`;
		}

		const passedCount = this.steps.filter(s => s.status === "passed").length;
		const failedCount = this.steps.filter(s => s.status === "failed" || s.status === "timeout").length;
		const total = this.steps.length;
		const summary = statusSummary(this.steps);

		// Phase grouping
		const phases = new Set(this.steps.map(s => s.phase ?? 0));
		const hasMultiplePhases = phases.size > 1;
		const stepsByPhase = new Map<number, Array<{ step: VerificationStep; index: number }>>();
		this.steps.forEach((step, i) => {
			const p = step.phase ?? 0;
			if (!stepsByPhase.has(p)) stepsByPhase.set(p, []);
			stepsByPhase.get(p)!.push({ step, index: i });
		});
		const sortedPhases = [...stepsByPhase.keys()].sort((a, b) => a - b);

		// Running: show step count inline with parent title (negative margin pulls it up).
		// Completed: show full header with result summary.
		const completedCount = passedCount + failedCount;
		const isRunning = this.overallStatus === "running";

		return html`
			<div class="mt-2 space-y-1">
				${isRunning
					? html`<div class="flex items-center justify-end text-[10px] text-muted-foreground tabular-nums -mt-[1.35rem]">${summary || `${completedCount}/${total}`}</div>`
					: this._renderHeader(passedCount, failedCount, total, summary)
				}
				${sortedPhases.map(phase => {
					const phaseSteps = stepsByPhase.get(phase)!;
					const isActive = phase === this.currentPhase && this.overallStatus === "running";
					return html`
						${hasMultiplePhases ? html`
							<div class="text-[10px] font-medium ${isActive ? "text-blue-500" : "text-muted-foreground"} mt-2 mb-0.5 uppercase tracking-wide">
								Phase ${phase}${isActive ? " — active" : ""}
							</div>
						` : nothing}
						${phaseSteps.map(({ step, index }) => this._renderStepCard(step, index))}
					`;
				})}
			</div>
			${this.modalStep ? html`
				<verification-output-modal
					.goalId=${this.goalId}
					.gateId=${this.gateId}
					.signalId=${this.signalId}
					.stepIndex=${this.modalStep.index}
					.stepName=${this.modalStep.name}
					.stepType=${this.modalStep.type}
					.open=${true}
					.initialOutput=${this.modalStep.output}
					@close=${this._closeModal}
				></verification-output-modal>
			` : nothing}
		`;
	}

	/** Emit a bubbling request the dashboard/chat can wire to re-signal the gate. */
	private _requestResignal() {
		this.dispatchEvent(new CustomEvent("gate-resignal-request", {
			detail: { goalId: this.goalId, gateId: this.gateId, signalId: this.signalId },
			bubbles: true,
			composed: true,
		}));
	}

	private _renderStaleBanner(): TemplateResult {
		return html`
			<div class="mt-2 text-xs ${statusColor("skipped")} flex items-center gap-2 flex-wrap">
				<span>${statusIcon("skipped")} Verification for <code class="text-[10px]">${this.gateId}</code> stopped without completing (interrupted / no longer running).</span>
				<button
					class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground hover:bg-accent"
					@click=${() => this._requestResignal()}
					title="Re-signal this gate to run a fresh verification"
				>Re-signal gate</button>
			</div>`;
	}

	private _renderHeader(passed: number, failed: number, total: number, summary: string): TemplateResult {
		if (this.overallStatus === "stale") {
			return html`<div class="text-xs font-medium ${statusColor("skipped")} mb-1 flex items-center gap-2 flex-wrap">${statusIcon("skipped")} Verification <code class="text-[10px]">${this.gateId}</code> interrupted — stopped without completing.<button class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground hover:bg-accent" @click=${() => this._requestResignal()} title="Re-signal this gate to run a fresh verification">Re-signal gate</button></div>`;
		}
		if (this.overallStatus === "passed") {
			return html`<div class="text-xs font-medium ${statusColor("completed")} mb-1">${statusIcon("completed")} Verified <code class="text-[10px]">${this.gateId}</code> — <span class="text-green-500">${summary || `${passed}/${total} passed`}</span></div>`;
		}
		if (this.overallStatus === "failed") {
			return html`<div class="text-xs font-medium ${statusColor("error")} mb-1">${statusIcon("error")} Verified <code class="text-[10px]">${this.gateId}</code> — <span class="text-green-500">${passed} passed</span>, <span class="text-red-500">${failed} failed</span>${summary ? html` <span class="text-muted-foreground">(${summary})</span>` : nothing}</div>`;
		}
		// Running
		const completedCount = passed + failed;
		return html`<div class="text-xs font-medium ${statusColor("running")} mb-1">Verifying <code class="text-[10px]">${this.gateId}</code> — <span class="text-xs">${summary || `${completedCount}/${total} steps`}</span></div>`;
	}

	private _openModal(index: number, name: string) {
		const output = this._stepOutputs.get(index) || this.steps[index]?.output || "";
		const stepType = this.steps[index]?.type || "";
		this.modalStep = { index, name, output, type: stepType };
	}

	private _closeModal() {
		this.modalStep = null;
	}

	private _renderStepCard(step: VerificationStep, index: number): TemplateResult {
		const isExpanded = this.expandedSteps.has(index);
		// Streamed output accumulates in _stepOutputs while the step is running;
		// fall back to step.output once the step completes. Either can populate
		// the expandable body so users see live output during long-running
		// command steps (e2e test runs, etc.).
		const streamedOutput = this._stepOutputs.get(index) || "";
		const displayOutput = streamedOutput || step.output || "";
		const hasOutput = displayOutput.length > 0;
		const dStatus = toDelegateStatus(step.status);
		const entry = toCardEntry(step, index);
		const isRunningCommand = step.status === "running" && step.type === "command";
		const marker = step.status === "timeout" ? timeoutInfo(step.timeout) : undefined;
		const canChangeTimeout = !!marker && !!this.goalId && !!this.gateId && !!step.name;
		const canStartReview = this.overallStatus === "running"
			&& step.type === "human-signoff"
			&& step.awaitingHuman === true
			&& !!this.goalId
			&& !!this.gateId
			&& !!this.signalId
			&& !!step.name;
		const statusLabel = step.status === "timeout" ? "Timed out" : step.status;

		const typeBadgeCls = step.type === "command"
			? "bg-muted text-muted-foreground"
			: "bg-purple-500/20 text-purple-600 dark:text-purple-400";

		const clickable = hasOutput || isRunningCommand;

		return html`
			<div class="border border-border rounded text-sm">
				<div
					class="p-2 flex items-center gap-2 ${clickable ? "cursor-pointer hover:bg-accent/50" : ""}"
					@click=${clickable ? () => {
						if (isRunningCommand) {
							// Running command: open the full-screen live output modal
							this._openModal(index, step.name);
						} else if (hasOutput) {
							// Completed or streaming non-command step: toggle inline body
							this._toggleStep(index);
						}
					} : null}
				>
					${step.status === "timeout"
						? html`<span data-timeout-icon title="Timed out" class="text-warning">⏱</span>`
						: html`<span class="${statusColor(dStatus)}">${statusIcon(dStatus)}</span>`}
					<span class="font-mono text-xs flex-1 min-w-0 truncate">${step.name || "step"}</span>
					<span class="px-1.5 py-0.5 rounded text-[10px] font-medium ${stepStatusBadgeClass(step.status)}">${statusLabel}</span>
					<span class="px-1.5 py-0.5 rounded text-[10px] font-medium ${typeBadgeCls}">${step.type}</span>
					${marker
						? html`<span data-timeout-timing class="text-xs text-muted-foreground tabular-nums">${formatTimeoutTiming(marker)}</span>`
						: shouldRenderDuration(step) ? renderDuration(entry) : nothing}
					${canStartReview ? html`
						<signoff-review-launcher .target=${{
							goalId: this.goalId,
							gateId: this.gateId,
							signalId: this.signalId,
							stepName: step.name,
							stepLabel: step.humanLabel || step.name,
						}}></signoff-review-launcher>
					` : nothing}
					${canChangeTimeout ? html`
						<button
							type="button"
							data-testid="change-verification-timeout"
							class="shrink-0 rounded border border-warning/30 px-1.5 py-0.5 text-[10px] font-medium text-warning hover:bg-warning/10"
							@click=${async (event: Event) => {
								event.stopPropagation();
								const { ChangeVerificationTimeoutDialog } = await import("../../dialogs/ChangeVerificationTimeoutDialog.js");
								ChangeVerificationTimeoutDialog.show({
									goalId: this.goalId,
									gateId: this.gateId,
									stepName: step.name,
									configuredSeconds: marker.configuredSeconds,
								});
							}}
						>Change timeout</button>
					` : nothing}
					${step.sessionId ? renderSessionLink(step.sessionId) : nothing}
					${isRunningCommand ? html`<span class="text-muted-foreground text-[10px] shrink-0" title="View live output">▸</span>` : nothing}
					${hasOutput ? html`<span class="text-muted-foreground text-[10px] shrink-0">${isExpanded ? "▴" : "▾"}</span>` : nothing}
				</div>
				${isExpanded && hasOutput ? (
				step.type !== "command"
					? html`<div class="text-xs text-muted-foreground max-h-[300px] overflow-y-auto bg-muted/50 rounded-b p-2 border-t border-border"><markdown-block .content=${displayOutput}></markdown-block></div>`
					: html`<pre class="text-xs text-muted-foreground whitespace-pre-wrap max-h-[300px] overflow-y-auto bg-muted/50 rounded-b p-2 border-t border-border">${hasAnsi(displayOutput) ? unsafeHTML(ansiToHtml(displayOutput)) : displayOutput}</pre>`
			) : nothing}
			</div>
		`;
	}
}
