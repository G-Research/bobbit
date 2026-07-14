import { DialogContent, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
	loadVerificationTimeoutContext,
	updateCurrentGoalVerificationTimeout,
	updateFutureGoalsVerificationTimeout,
	type VerificationTimeoutContext,
	type VerificationTimeoutTarget,
} from "../../app/verification-timeout-remediation.js";

type ScopeStatus =
	| { state: "idle" }
	| { state: "pending" }
	| { state: "success"; message: string }
	| { state: "error"; message: string };

export interface ChangeVerificationTimeoutDialogOptions extends VerificationTimeoutTarget {
	configuredSeconds: number;
}

@customElement("change-verification-timeout-dialog")
export class ChangeVerificationTimeoutDialog extends DialogBase {
	@state() private context?: VerificationTimeoutContext;
	@state() private loading = true;
	@state() private loadError = "";
	@state() private timeoutValue = "";
	@state() private currentGoal = true;
	@state() private futureGoals = false;
	@state() private validationError = "";
	@state() private saving = false;
	@state() private goalStatus: ScopeStatus = { state: "idle" };
	@state() private futureStatus: ScopeStatus = { state: "idle" };

	protected override modalWidth = "min(520px, 92vw)";
	protected override modalHeight = "auto";

	override createRenderRoot() { return this; }

	static show(options: ChangeVerificationTimeoutDialogOptions): ChangeVerificationTimeoutDialog {
		const dialog = new ChangeVerificationTimeoutDialog();
		dialog.timeoutValue = String(options.configuredSeconds);
		dialog.open();
		void dialog.load(options);
		return dialog;
	}

	private async load(target: VerificationTimeoutTarget): Promise<void> {
		this.loading = true;
		this.loadError = "";
		try {
			this.context = await loadVerificationTimeoutContext(target);
		} catch (error) {
			this.loadError = error instanceof Error ? error.message : "Unable to load timeout settings";
		} finally {
			this.loading = false;
		}
	}

	private validateTimeout(): number | undefined {
		const raw = this.timeoutValue.trim();
		if (!/^\d+$/.test(raw)) {
			this.validationError = "Enter a positive whole number of seconds";
			return undefined;
		}
		const value = Number(raw);
		if (!Number.isSafeInteger(value) || value <= 0) {
			this.validationError = "Enter a positive whole number of seconds";
			return undefined;
		}
		if (!this.currentGoal && !this.futureGoals) {
			this.validationError = "Select at least one scope";
			return undefined;
		}
		this.validationError = "";
		return value;
	}

	private async save(): Promise<void> {
		if (!this.context || this.saving) return;
		const timeoutSeconds = this.validateTimeout();
		if (timeoutSeconds === undefined) return;

		this.saving = true;
		const work: Promise<void>[] = [];
		if (this.currentGoal && this.goalStatus.state !== "success") {
			this.goalStatus = { state: "pending" };
			work.push(updateCurrentGoalVerificationTimeout(this.context, timeoutSeconds).then(
				() => { this.goalStatus = { state: "success", message: "Updated this goal" }; },
				(error) => { this.goalStatus = { state: "error", message: this.errorMessage(error) }; },
			));
		}
		if (this.futureGoals && this.futureStatus.state !== "success") {
			this.futureStatus = { state: "pending" };
			work.push(updateFutureGoalsVerificationTimeout(this.context, timeoutSeconds).then(
				() => { this.futureStatus = { state: "success", message: "Updated future goals" }; },
				(error) => { this.futureStatus = { state: "error", message: this.errorMessage(error) }; },
			));
		}
		await Promise.all(work);
		this.saving = false;
	}

	private errorMessage(error: unknown): string {
		return error instanceof Error && error.message ? error.message : "Update failed";
	}

	private selectedScopesSucceeded(): boolean {
		return !!this.context
			&& (!this.currentGoal || this.goalStatus.state === "success")
			&& (!this.futureGoals || this.futureStatus.state === "success")
			&& (this.currentGoal || this.futureGoals);
	}

	private renderScopeStatus(status: ScopeStatus, testId: string): TemplateResult | typeof nothing {
		if (status.state === "idle") return nothing;
		if (status.state === "pending") {
			return html`<div data-testid=${testId} role="status" class="mt-1 text-xs text-muted-foreground">Updating…</div>`;
		}
		if (status.state === "success") {
			return html`<div data-testid=${testId} role="status" class="mt-1 text-xs text-positive">✓ ${status.message}</div>`;
		}
		return html`<div data-testid=${testId} role="alert" class="mt-1 text-xs text-destructive">${status.message}</div>`;
	}

	protected override renderContent(): TemplateResult {
		const complete = this.selectedScopesSucceeded();
		return html`
			<div role="dialog" aria-modal="true" aria-label="Change verification timeout">
				${DialogContent({
					className: "flex flex-col",
					children: html`
				${DialogHeader({
					title: "Change verification timeout",
					description: "Choose how long this verification step may run before timing out.",
				})}
				${this.loading ? html`
					<div class="py-6 text-sm text-muted-foreground" role="status">Loading timeout settings…</div>
				` : this.loadError ? html`
					<div class="mt-4 rounded border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">${this.loadError}</div>
				` : html`
					<div class="mt-5 space-y-5">
						<label class="block text-sm font-medium text-foreground" for="verification-timeout-seconds">
							Timeout in seconds
							<input
								id="verification-timeout-seconds"
								data-testid="verification-timeout-seconds"
								type="number"
								min="1"
								step="1"
								inputmode="numeric"
								class="mt-1.5 w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground disabled:opacity-60"
								.value=${this.timeoutValue}
								?disabled=${this.saving || complete}
								@input=${(event: Event) => {
									this.timeoutValue = (event.currentTarget as HTMLInputElement).value;
									this.validationError = "";
								}}
							/>
						</label>

						<fieldset class="space-y-3" ?disabled=${this.saving || complete}>
							<legend class="mb-2 text-sm font-medium text-foreground">Apply to</legend>
							<label class="block rounded border border-border p-3 text-sm text-foreground">
								<span class="flex items-center gap-2">
									<input
										data-testid="verification-timeout-current-goal"
										type="checkbox"
										.checked=${this.currentGoal}
										@change=${(event: Event) => {
											this.currentGoal = (event.currentTarget as HTMLInputElement).checked;
											this.validationError = "";
										}}
									/>
									<span>This goal</span>
								</span>
								${this.renderScopeStatus(this.goalStatus, "verification-timeout-goal-status")}
							</label>
							<label class="block rounded border border-border p-3 text-sm text-foreground">
								<span class="flex items-center gap-2">
									<input
										data-testid="verification-timeout-future-goals"
										type="checkbox"
										.checked=${this.futureGoals}
										@change=${(event: Event) => {
											this.futureGoals = (event.currentTarget as HTMLInputElement).checked;
											this.validationError = "";
										}}
									/>
									<span>Future goals in ${this.context?.projectName || "project"}</span>
								</span>
								${this.renderScopeStatus(this.futureStatus, "verification-timeout-future-status")}
							</label>
						</fieldset>

						${this.validationError ? html`<div data-testid="verification-timeout-error" role="alert" class="text-sm text-destructive">${this.validationError}</div>` : nothing}
					</div>
				`}
				<div class="mt-6 flex justify-end gap-2 border-t border-border pt-4">
					${!complete ? html`
						<button
							type="button"
							class="rounded border border-border px-3 py-1.5 text-sm text-foreground hover:bg-accent disabled:opacity-60"
							?disabled=${this.saving}
							@click=${() => this.close()}
						>Cancel</button>
					` : nothing}
					${complete ? html`
						<button
							type="button"
							data-testid="verification-timeout-done"
							class="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
							@click=${() => this.close()}
						>Done</button>
					` : html`
						<button
							type="button"
							data-testid="verification-timeout-save"
							class="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-60"
							?disabled=${this.loading || !!this.loadError || this.saving}
							@click=${() => this.save()}
						>${this.saving ? "Saving…" : (this.goalStatus.state === "error" || this.futureStatus.state === "error") ? "Retry" : "Save"}</button>
					`}
				</div>
					`,
				})}
			</div>
		`;
	}
}
