/**
 * Trigger editor UI used inside the staff-assistant proposal panel.
 *
 * Extracted from `render.ts` so the ~10 kB of templates only ships when
 * the staff proposal panel is on screen. The functions are pure
 * read-write helpers against `state.staffPreviewTriggers`
 * (JSON-encoded array on `state`); they trigger `renderApp()` after
 * mutating.
 *
 * Used only by `staffPreviewPanel()` in `render.ts`, which lazy-loads
 * this module via the `_triggerMod` cache.
 */
import { html } from "lit";
import { state, renderApp } from "./state.js";

export interface TriggerDef {
	type: string;
	config: Record<string, any>;
	enabled: boolean;
	prompt?: string;
}

export function parseTriggers(json: string): TriggerDef[] {
	try {
		const arr = JSON.parse(json);
		return Array.isArray(arr) ? arr : [];
	} catch {
		return [];
	}
}

export function updateTrigger(index: number, updater: (t: TriggerDef) => void) {
	const triggers = parseTriggers(state.staffPreviewTriggers);
	if (triggers[index]) {
		updater(triggers[index]);
		state.staffPreviewTriggers = JSON.stringify(triggers);
		state.staffPreviewTriggersEdited = true;
		renderApp();
	}
}

export function removeTrigger(index: number) {
	const triggers = parseTriggers(state.staffPreviewTriggers);
	triggers.splice(index, 1);
	state.staffPreviewTriggers = JSON.stringify(triggers);
	state.staffPreviewTriggersEdited = true;
	renderApp();
}

export function renderTriggersEditor() {
	const triggers = parseTriggers(state.staffPreviewTriggers);
	if (triggers.length === 0) {
		return html`<div class="text-xs text-muted-foreground italic p-3 border border-dashed border-border rounded-md">No triggers configured. Add one above.</div>`;
	}
	return html`<div class="flex flex-col gap-2">${triggers.map((t, i) => renderTriggerCard(t, i))}</div>`;
}

export function hasInvalidGoalTriggersForPreview(): boolean {
	const triggers = parseTriggers(state.staffPreviewTriggers);
	return triggers.some((t) =>
		(t.type === "goal_created" || t.type === "goal_archived") &&
		(t.prompt || "").trim().length === 0,
	);
}

export function renderTriggerCard(trigger: TriggerDef, index: number) {
	const typeLabel: Record<string, string> = {
		schedule: "⏰ Schedule",
		git: "🔀 Git",
		manual: "👆 Manual",
		goal_created: "\uD83C\uDFAF Goal created",
		goal_archived: "\uD83D\uDDC4 Goal archived",
	};
	const typeOptions = ["schedule", "git", "manual", "goal_created", "goal_archived"];
	const inputClass = "w-full h-8 px-2 text-xs rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring";
	const isGoalTrigger = trigger.type === "goal_created" || trigger.type === "goal_archived";
	const goalPromptMissing = isGoalTrigger && (trigger.prompt || "").trim().length === 0;

	const onTypeChange = (e: Event) => {
		const newType = (e.target as HTMLSelectElement).value;
		updateTrigger(index, (t) => {
			t.type = newType;
			if (newType === "schedule") t.config = { cron: "0 9 * * *" };
			else if (newType === "git") t.config = { event: "push", branch: "master" };
			else t.config = {};
		});
	};

	return html`
		<div class="rounded-md border border-border bg-secondary/20 p-3">
			<div style="display:flex; align-items:center; gap:8px; margin-bottom:8px">
				<select
					class="text-xs px-2 py-1 rounded border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
					.value=${trigger.type}
					@change=${onTypeChange}
				>
					${typeOptions.map((opt) => html`<option value=${opt} ?selected=${trigger.type === opt}>${typeLabel[opt] || opt}</option>`)}
				</select>
				<label style="display:flex; align-items:center; gap:4px; margin-left:auto; font-size:11px" class="text-muted-foreground cursor-pointer select-none">
					<input
						type="checkbox"
						class="accent-primary"
						.checked=${trigger.enabled !== false}
						@change=${(e: Event) => updateTrigger(index, (t) => { t.enabled = (e.target as HTMLInputElement).checked; })}
					/> Enabled
				</label>
				<button
					class="text-[10px] px-1.5 py-0.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
					title="Remove trigger"
					@click=${() => removeTrigger(index)}
				>✕</button>
			</div>

			${trigger.type === "schedule" ? html`
				<div style="margin-bottom:4px">
					<label class="text-[10px] text-muted-foreground" style="display:block; margin-bottom:2px">Cron expression (UTC)</label>
					<input
						type="text"
						class=${inputClass}
						placeholder="0 9 * * *"
						.value=${trigger.config?.cron || ""}
						@input=${(e: Event) => updateTrigger(index, (t) => { t.config.cron = (e.target as HTMLInputElement).value; })}
					/>
				</div>
				<div class="text-[10px] text-muted-foreground" style="margin-bottom:8px">${describeCron(trigger.config?.cron || "")}</div>
			` : ""}

			${trigger.type === "git" ? html`
				<div style="display:grid; grid-template-columns:100px 1fr; gap:8px; margin-bottom:8px">
					<div>
						<label class="text-[10px] text-muted-foreground" style="display:block; margin-bottom:2px">Event</label>
						<select
							class=${inputClass}
							.value=${trigger.config?.event || "push"}
							@change=${(e: Event) => updateTrigger(index, (t) => { t.config.event = (e.target as HTMLSelectElement).value; })}
						>
							<option value="push" ?selected=${trigger.config?.event === "push"}>push</option>
						</select>
					</div>
					<div>
						<label class="text-[10px] text-muted-foreground" style="display:block; margin-bottom:2px">Branch</label>
						<input
							type="text"
							class=${inputClass}
							placeholder="master"
							.value=${trigger.config?.branch || ""}
							@input=${(e: Event) => updateTrigger(index, (t) => { t.config.branch = (e.target as HTMLInputElement).value; })}
						/>
					</div>
				</div>
			` : ""}

			<div style="margin-top:${trigger.type === "manual" ? "0" : "0"}">
				<label class="text-[10px] ${goalPromptMissing ? "text-destructive" : "text-muted-foreground"}" style="display:block; margin-bottom:2px">${isGoalTrigger ? "Wake prompt (required)" : "Wake prompt (optional)"}</label>
				<textarea
					class="w-full p-2 text-xs rounded-md border ${goalPromptMissing ? "border-destructive" : "border-border"} bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
					rows="2"
					data-testid="trigger-prompt-${index}"
					placeholder="Message sent to the agent when this trigger fires"
					.value=${trigger.prompt || ""}
					@input=${(e: Event) => updateTrigger(index, (t) => { t.prompt = (e.target as HTMLTextAreaElement).value; })}
				></textarea>
				${goalPromptMissing ? html`<div class="text-[10px] text-destructive" style="margin-top:2px" data-testid="trigger-prompt-error-${index}">Goal triggers require a non-empty wake prompt.</div>` : ""}
			</div>
		</div>
	`;
}

/** Produce a human-readable description of a cron expression. */
export function describeCron(cron: string): string {
	const parts = cron.trim().split(/\s+/);
	if (parts.length !== 5) return cron ? `Custom: ${cron}` : "";
	const [min, hour, dom, mon, dow] = parts;

	const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

	let timeStr = "";
	if (min !== "*" && hour !== "*") {
		const h = parseInt(hour, 10);
		const m = parseInt(min, 10);
		if (!isNaN(h) && !isNaN(m)) {
			const ampm = h >= 12 ? "PM" : "AM";
			const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
			timeStr = `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
		}
	}

	// Every N hours
	if (hour.startsWith("*/")) {
		const n = hour.slice(2);
		const base = min === "0" ? "on the hour" : `at :${min.padStart(2, "0")}`;
		return `Every ${n} hour${n === "1" ? "" : "s"}, ${base}`;
	}

	// Every N minutes
	if (min.startsWith("*/")) {
		const n = min.slice(2);
		return `Every ${n} minute${n === "1" ? "" : "s"}`;
	}

	// Daily
	if (dom === "*" && mon === "*" && dow === "*" && timeStr) {
		return `Daily at ${timeStr}`;
	}

	// Weekdays only
	if (dom === "*" && mon === "*" && dow === "1-5" && timeStr) {
		return `Weekdays at ${timeStr}`;
	}

	// Specific day of week
	if (dom === "*" && mon === "*" && dow !== "*" && timeStr) {
		const dowNum = parseInt(dow, 10);
		const dayName = !isNaN(dowNum) && dowNum >= 0 && dowNum <= 6 ? dayNames[dowNum] : dow;
		return `Every ${dayName} at ${timeStr}`;
	}

	// Specific day of month
	if (dom !== "*" && mon === "*" && dow === "*" && timeStr) {
		const suffix = dom === "1" ? "st" : dom === "2" ? "nd" : dom === "3" ? "rd" : "th";
		return `${dom}${suffix} of each month at ${timeStr}`;
	}

	return cron ? `Custom: ${cron}` : "";
}
