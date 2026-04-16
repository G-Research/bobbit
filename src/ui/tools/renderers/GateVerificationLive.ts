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
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import "../../components/LiveTimer.js";
import "../../components/VerificationOutputModal.js";
import { ansiToHtml, hasAnsi } from "../../utils/ansi.js";
import {
	type DelegateCardEntry,
	statusColor,
	statusIcon,
	renderDuration,
	renderSessionLink,
} from "./delegate-cards.js";

interface VerificationStep {
	name: string;
	type: string;
	status: "running" | "passed" | "failed" | "waiting" | "skipped";
	phase?: number;
	durationMs?: number;
	output?: string;
	startedAt: number;
	sessionId?: string;
}

/** Map verification step status to delegate-cards status strings */
function toDelegateStatus(status: string): string {
	if (status === "passed") return "completed";
	if (status === "failed") return "error";
	if (status === "waiting") return "waiting";
	if (status === "skipped") return "skipped";
	return "running";
}

/** Build a DelegateCardEntry-compatible object for renderDuration() */
function toCardEntry(step: VerificationStep, index: number): DelegateCardEntry {
	const delegateStatus = toDelegateStatus(step.status);
	// For running steps, compute durationMs from startedAt so <live-timer> works
	const durationMs = step.status === "running"
		? Date.now() - step.startedAt
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
	/** Step definitions from signal response — used to seed placeholder cards before WS events arrive. */
	@property({ type: Array }) initialSteps: Array<{ name: string; type: string }> = [];

	@state() private steps: VerificationStep[] = [];
	@state() private overallStatus: "idle" | "running" | "passed" | "failed" = "idle";
	@state() private currentPhase = 0;
	@state() private expandedSteps = new Set<number>();
	@state() private modalStep: { index: number; name: string; output: string; type: string } | null = null;
	/** Accumulated streamed output per step index */
	private _stepOutputs = new Map<number, string>();

	private _boundOnEvent = this._onEvent.bind(this);
	private _reconcileTimer?: ReturnType<typeof setTimeout>;
	/** Throttled re-render after streaming output events (high-frequency). */
	private _outputFlushTimer?: ReturnType<typeof setTimeout>;

	override createRenderRoot() { return this; }

	override willUpdate(_changed: PropertyValues) {
		// Seed steps from initialSteps once, before the gate_verification_started WS event arrives
		if (this.overallStatus === "idle" && this.steps.length === 0 && this.initialSteps.length > 0) {
			this.steps = this.initialSteps.map(s => ({
				name: s.name,
				type: s.type,
				status: "running" as const,
				startedAt: Date.now(),
			}));
			this.overallStatus = "running";
		}
	}

	override connectedCallback() {
		super.connectedCallback();
		document.addEventListener("gate-verification-event", this._boundOnEvent);
		this._reconcileTimer = setTimeout(() => {
			if (this.overallStatus === "running" || this.overallStatus === "idle") {
				this._fetchAndReconcile();
			}
		}, 300);
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		document.removeEventListener("gate-verification-event", this._boundOnEvent);
		if (this._reconcileTimer) {
			clearTimeout(this._reconcileTimer);
			this._reconcileTimer = undefined;
		}
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
				// Map GateSignalStep[] to VerificationStep[]
				const steps: VerificationStep[] = (signal.verification.steps || []).map((s: any) => ({
					name: s.name,
					type: s.type,
					status: s.skipped ? "skipped" as const : s.passed === true ? "passed" as const : s.passed === false ? "failed" as const : "running" as const,
					durationMs: s.duration_ms ?? 0,
					output: s.output,
					startedAt: s.duration_ms ? Date.now() - s.duration_ms : 0,
				}));
				this.steps = steps;
				this.overallStatus = vStatus;
				return;
			}

			// Still running — try active verifications for real-time step state
			if (vStatus === "running") {
				const activeRes = await fetch(`/api/goals/${this.goalId}/verifications/active`, { headers });
				if (!activeRes.ok) return;
				const activeData = await activeRes.json();
				const active = activeData.verifications?.find(
					(v: any) => v.signalId === this.signalId
				);
				if (active?.steps?.length) {
					this.steps = active.steps.map((s: any) => ({
						name: s.name,
						type: s.type,
						status: s.status,
						phase: s.phase,
						durationMs: s.durationMs,
						output: s.output,
						startedAt: s.startedAt || Date.now(),
						sessionId: s.sessionId,
					}));
					this.currentPhase = active.currentPhase ?? 0;
					this.overallStatus = "running";
					// Seed _stepOutputs from API so modal has initial content
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

	private _onEvent(e: Event) {
		const detail = (e as CustomEvent).detail;
		if (!detail) return;
		if (detail.gateId !== this.gateId || detail.signalId !== this.signalId) return;
		// Also check goalId if available
		if (this.goalId && detail.goalId && detail.goalId !== this.goalId) return;

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
						startedAt: detail.startedAt || updated[idx].startedAt,
						sessionId: detail.sessionId,
					};
					this.steps = updated;
				}
				this.requestUpdate();
				break;
			}
			case "gate_verification_step_complete": {
				const idx = detail.stepIndex as number;
				if (idx >= 0 && idx < this.steps.length) {
					const updated = [...this.steps];
					updated[idx] = {
						...updated[idx],
						status: detail.status,
						durationMs: detail.durationMs,
						output: detail.output,
						sessionId: detail.sessionId ?? updated[idx].sessionId,
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
						status: detail.status,
						durationMs: detail.durationMs,
						output: detail.output,
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
			case "gate_verification_complete": {
				this.overallStatus = detail.status || "passed";
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

		// Auto-pass: complete arrived with no steps
		if (this.steps.length === 0 && this.overallStatus !== "running") {
			const dStatus = toDelegateStatus(this.overallStatus as "passed" | "failed");
			return html`<div class="mt-2 text-xs ${statusColor(dStatus)}">${statusIcon(dStatus)} ${this.overallStatus === "passed" ? "Passed (no verification)" : "Failed"}</div>`;
		}

		const passedCount = this.steps.filter(s => s.status === "passed").length;
		const failedCount = this.steps.filter(s => s.status === "failed").length;
		const total = this.steps.length;

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
					? html`<div class="flex items-center justify-end text-[10px] text-muted-foreground tabular-nums -mt-[1.35rem]">${completedCount}/${total}${failedCount > 0 ? html` <span class="text-red-500 ml-1">(${failedCount} failed)</span>` : nothing}</div>`
					: this._renderHeader(passedCount, failedCount, total)
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

	private _renderHeader(passed: number, failed: number, total: number): TemplateResult {
		if (this.overallStatus === "passed") {
			return html`<div class="text-xs font-medium ${statusColor("completed")} mb-1">${statusIcon("completed")} Verified <code class="text-[10px]">${this.gateId}</code> — <span class="text-green-500">${passed}/${total} passed</span></div>`;
		}
		if (this.overallStatus === "failed") {
			return html`<div class="text-xs font-medium ${statusColor("error")} mb-1">${statusIcon("error")} Verified <code class="text-[10px]">${this.gateId}</code> — <span class="text-green-500">${passed} passed</span>, <span class="text-red-500">${failed} failed</span></div>`;
		}
		// Running
		const completedCount = passed + failed;
		return html`<div class="text-xs font-medium ${statusColor("running")} mb-1">Verifying <code class="text-[10px]">${this.gateId}</code> — <span class="text-xs">${completedCount}/${total} steps</span>${failed > 0 ? html` <span class="text-red-500">(${failed} failed)</span>` : nothing}</div>`;
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
					<span class="${statusColor(dStatus)}">${statusIcon(dStatus)}</span>
					<span class="font-mono text-xs flex-1 min-w-0 truncate">${step.name || "step"}</span>
					<span class="px-1.5 py-0.5 rounded text-[10px] font-medium ${typeBadgeCls}">${step.type}</span>
					${dStatus !== "waiting" ? renderDuration(entry) : nothing}
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
