/**
 * <gate-verification-live> — Lit element that subscribes to gate-verification-event
 * CustomEvents on document and renders live step cards with timers.
 *
 * Used by GateSignalRenderer (chat) and could be embedded in the dashboard.
 */
import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "../../components/LiveTimer.js";

interface VerificationStep {
	name: string;
	type: string;
	status: "running" | "passed" | "failed";
	durationMs?: number;
	output?: string;
	startedAt: number;
}

@customElement("gate-verification-live")
export class GateVerificationLive extends LitElement {
	@property() goalId = "";
	@property() gateId = "";
	@property() signalId = "";
	/** If set, used to show static final state when no events arrive (e.g. chat history). */
	@property() finalStatus: string | undefined;

	@state() private steps: VerificationStep[] = [];
	@state() private overallStatus: "idle" | "running" | "passed" | "failed" = "idle";
	@state() private expandedSteps = new Set<number>();

	private _timerInterval: ReturnType<typeof setInterval> | null = null;
	private _boundOnEvent = this._onEvent.bind(this);

	override createRenderRoot() { return this; }

	override connectedCallback() {
		super.connectedCallback();
		document.addEventListener("gate-verification-event", this._boundOnEvent);
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		document.removeEventListener("gate-verification-event", this._boundOnEvent);
		this._stopTimer();
	}

	private _startTimer() {
		if (this._timerInterval) return;
		this._timerInterval = setInterval(() => this.requestUpdate(), 1000);
	}

	private _stopTimer() {
		if (this._timerInterval) {
			clearInterval(this._timerInterval);
			this._timerInterval = null;
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
				const stepDefs: Array<{ name: string; type: string }> = detail.steps || [];
				this.steps = stepDefs.map(s => ({
					name: s.name,
					type: s.type,
					status: "running" as const,
					startedAt: Date.now(),
				}));
				this.overallStatus = "running";
				this._startTimer();
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
				this._stopTimer();
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

	private _formatElapsed(startedAt: number): string {
		const s = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
		return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
	}

	private _formatDuration(ms: number): string {
		if (ms < 1000) return `${Math.round(ms)}ms`;
		if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
		const m = Math.floor(ms / 60000);
		const s = Math.round((ms % 60000) / 1000);
		return `${m}m ${s}s`;
	}

	override render() {
		// No events yet — show placeholder based on finalStatus or idle state
		if (this.overallStatus === "idle" && this.steps.length === 0) {
			if (this.finalStatus === "passed") {
				return html`<div class="mt-2 text-xs text-green-600 dark:text-green-400">✓ Passed (no verification steps)</div>`;
			}
			if (this.finalStatus === "failed") {
				return html`<div class="mt-2 text-xs text-red-600 dark:text-red-400">✗ Failed</div>`;
			}
			return html`<div class="mt-2 text-xs text-muted-foreground animate-pulse">Verification in progress…</div>`;
		}

		// Auto-pass: complete arrived with no steps
		if (this.steps.length === 0 && this.overallStatus !== "running") {
			const color = this.overallStatus === "passed" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400";
			const icon = this.overallStatus === "passed" ? "✓" : "✗";
			return html`<div class="mt-2 text-xs ${color}">${icon} ${this.overallStatus === "passed" ? "Passed (no verification steps)" : "Failed"}</div>`;
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
			return html`<div class="text-xs font-medium text-green-600 dark:text-green-400 mb-1">✓ Verified <code class="text-[10px]">${this.gateId}</code> — passed</div>`;
		}
		if (this.overallStatus === "failed") {
			return html`<div class="text-xs font-medium text-red-600 dark:text-red-400 mb-1">✗ Verified <code class="text-[10px]">${this.gateId}</code> — failed</div>`;
		}
		return html`<div class="text-xs font-medium text-muted-foreground mb-1">Verifying <code class="text-[10px]">${this.gateId}</code> — ${passed}/${total} steps passed${failed > 0 ? html`, <span class="text-red-600 dark:text-red-400">${failed} failed</span>` : nothing}</div>`;
	}

	private _renderStepCard(step: VerificationStep, index: number): TemplateResult {
		const isExpanded = this.expandedSteps.has(index);
		const hasOutput = !!step.output;

		// Status icon and color
		let iconStr: string;
		let iconCls: string;
		if (step.status === "running") {
			iconStr = "●";
			iconCls = "text-blue-500 animate-pulse";
		} else if (step.status === "passed") {
			iconStr = "✓";
			iconCls = "text-green-600 dark:text-green-400";
		} else {
			iconStr = "✗";
			iconCls = "text-red-600 dark:text-red-400";
		}

		// Type badge
		const typeBadgeCls = step.type === "command"
			? "bg-muted text-muted-foreground"
			: "bg-purple-500/20 text-purple-600 dark:text-purple-400";

		// Duration or live timer
		const durationPart = step.status === "running"
			? html`<span class="text-xs text-muted-foreground">${this._formatElapsed(step.startedAt)}</span>`
			: step.durationMs != null
				? html`<span class="text-xs text-muted-foreground">${this._formatDuration(step.durationMs)}</span>`
				: nothing;

		return html`
			<div class="border border-border rounded text-sm">
				<div
					class="p-2 flex items-center gap-2 ${hasOutput ? "cursor-pointer hover:bg-accent/50" : ""}"
					@click=${hasOutput ? () => this._toggleStep(index) : null}
				>
					<span class="${iconCls} font-bold shrink-0">${iconStr}</span>
					<span class="truncate flex-1 text-xs">${step.name || "step"}</span>
					<span class="px-1.5 py-0.5 rounded text-[10px] font-medium ${typeBadgeCls}">${step.type}</span>
					${durationPart}
					${hasOutput ? html`<span class="text-muted-foreground text-[10px] shrink-0">${isExpanded ? "▴" : "▾"}</span>` : nothing}
				</div>
				${isExpanded && step.output ? html`
					<pre class="text-xs text-muted-foreground whitespace-pre-wrap max-h-[300px] overflow-y-auto bg-muted/50 rounded-b p-2 border-t border-border">${step.output}</pre>
				` : nothing}
			</div>
		`;
	}
}
