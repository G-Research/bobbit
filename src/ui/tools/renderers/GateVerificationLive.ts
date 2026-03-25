/**
 * <gate-verification-live> — Lit element that subscribes to gate-verification-event
 * CustomEvents on document and renders live step cards with timers.
 *
 * Uses the shared delegate-cards.ts components to match the delegate UX pattern.
 * Used by GateSignalRenderer (chat) and could be embedded in the dashboard.
 */
import { LitElement, html, nothing, type TemplateResult, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "../../components/LiveTimer.js";
import {
	type DelegateCardEntry,
	statusColor,
	statusIcon,
	formatDuration,
	renderDuration,
} from "./delegate-cards.js";

interface VerificationStep {
	name: string;
	type: string;
	status: "running" | "passed" | "failed";
	durationMs?: number;
	output?: string;
	startedAt: number;
}

/** Map verification step status to delegate-cards status strings */
function toDelegateStatus(status: "running" | "passed" | "failed"): string {
	if (status === "passed") return "completed";
	if (status === "failed") return "error";
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
	@state() private expandedSteps = new Set<number>();

	private _boundOnEvent = this._onEvent.bind(this);

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
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		document.removeEventListener("gate-verification-event", this._boundOnEvent);
	}

	private _onEvent(e: Event) {
		const detail = (e as CustomEvent).detail;
		if (!detail) return;
		if (detail.gateId !== this.gateId || detail.signalId !== this.signalId) return;
		// Also check goalId if available
		if (this.goalId && detail.goalId && detail.goalId !== this.goalId) return;

		switch (detail.type) {
			case "gate_verification_started": {
				const stepDefs: Array<{ name: string; type: string }> = detail.steps || [];
				this.steps = stepDefs.map(s => ({
					name: s.name,
					type: s.type,
					status: "running" as const,
					startedAt: Date.now(),
				}));
				this.overallStatus = "running";
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

		return html`
			<div class="mt-2 space-y-1">
				${this._renderHeader(passedCount, failedCount, total)}
				${this.steps.map((step, i) => this._renderStepCard(step, i))}
			</div>
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

	private _renderStepCard(step: VerificationStep, index: number): TemplateResult {
		const isExpanded = this.expandedSteps.has(index);
		const hasOutput = !!step.output;
		const dStatus = toDelegateStatus(step.status);
		const entry = toCardEntry(step, index);

		// Type badge (verification-specific, not in delegate-cards)
		const typeBadgeCls = step.type === "command"
			? "bg-muted text-muted-foreground"
			: "bg-purple-500/20 text-purple-600 dark:text-purple-400";

		return html`
			<div class="border border-border rounded text-sm">
				<div
					class="p-2 flex items-center gap-2 ${hasOutput ? "cursor-pointer hover:bg-accent/50" : ""}"
					@click=${hasOutput ? () => this._toggleStep(index) : null}
				>
					<span class="${statusColor(dStatus)}">${statusIcon(dStatus)}</span>
					<span class="font-mono text-xs flex-1 min-w-0 truncate">${step.name || "step"}</span>
					<span class="px-1.5 py-0.5 rounded text-[10px] font-medium ${typeBadgeCls}">${step.type}</span>
					${renderDuration(entry)}
					${hasOutput ? html`<span class="text-muted-foreground text-[10px] shrink-0">${isExpanded ? "▴" : "▾"}</span>` : nothing}
				</div>
				${isExpanded && step.output ? html`
					<pre class="text-xs text-muted-foreground whitespace-pre-wrap max-h-[300px] overflow-y-auto bg-muted/50 rounded-b p-2 border-t border-border">${step.output}</pre>
				` : nothing}
			</div>
		`;
	}
}
