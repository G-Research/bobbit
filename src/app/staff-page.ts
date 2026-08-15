import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html, type TemplateResult } from "lit";
import { ArrowLeft, Play, Pause, Trash2, UserCheck } from "lucide";
import { fetchStaff, updateStaffAgent, deleteStaffAgent, refreshSessions, fetchRoles, gatewayFetch, type StaffAgent, type RoleData } from "./api.js";
import { state, renderApp } from "./state.js";
import { setHashRoute } from "./routing.js";
import { BOBBIT_HUE_ROTATIONS, ACCESSORY_IDS, sessionColorMap, setSessionColor, getAccessory } from "./session-colors.js";
import { ensureMarkdownBlock } from "../ui/lazy/markdown-block.js";
import { renderIdleBlobCanvas, renderStaticSidebarBobbitCanvas } from "../ui/bobbit-render.js";

// ============================================================================
// STATE
// ============================================================================

type View = "list" | "edit";

const BOBBIT_COLOR_NAMES = [
	"Rose", "Coral", "Orange", "Gold", "Lime", "Green", "Leaf",
	"Jade", "Emerald", "Mint", "Seafoam", "Teal", "Cyan", "Blue",
] as const;

let currentView: View = "list";
let staffList: StaffAgent[] = [];
let selectedStaff: StaffAgent | null = null;
let loading = true;
let saving = false;
let deleting = false;

// Edit form state
let editName = "";
let editDescription = "";
let editPrompt = "";
let editPromptEditMode = false;
let editRuntimeCwd = "";
let editTriggers: TriggerDef[] = [];
let editMemory = "";
let editContextPolicy: "preserve" | "compact" = "compact";
let editTab: "prompt" | "triggers" = "prompt";

// Session appearance state
let editColorIndex = -1;
let editAccessory = "none";
let colorUserTouched = false;
// True once the user manually picks an accessory this edit session. Gates the
// role-driven accessory pre-fill so a manual choice is never overridden.
let accessoryUserTouched = false;

// Role/accessory picker state
let editRoleId: string | null = null;
let roles: RoleData[] = [];
let roleDropdownOpen = false;
let accessoryDropdownOpen = false;
let colorDropdownOpen = false;

type PickerKind = "role" | "accessory" | "color";

const pickerSelectors: Record<PickerKind, { trigger: string; options: string }> = {
	role: { trigger: "[data-testid='staff-role-select']", options: "[data-picker='role'] [role='option']" },
	accessory: { trigger: "[data-testid='staff-accessory-select']", options: "[data-picker='accessory'] [role='option']" },
	color: { trigger: "[data-testid='staff-color-select']", options: "[data-picker='color'] [role='option']" },
};

function focusAfterRender(selector: string, index?: number): void {
	requestAnimationFrame(() => {
		const matches = Array.from(document.querySelectorAll<HTMLElement>(selector));
		const target = index === undefined ? matches[0] : matches[Math.max(0, Math.min(index, matches.length - 1))];
		target?.focus();
	});
}

function setOpenPicker(kind: PickerKind | null, focusIndex?: number): void {
	roleDropdownOpen = kind === "role";
	accessoryDropdownOpen = kind === "accessory";
	colorDropdownOpen = kind === "color";
	renderApp();
	if (kind) focusAfterRender(pickerSelectors[kind].options, focusIndex);
}

function closePicker(kind: PickerKind, restoreFocus = false): void {
	setOpenPicker(null);
	if (restoreFocus) focusAfterRender(pickerSelectors[kind].trigger);
}

function handlePickerTriggerKeydown(event: KeyboardEvent, kind: PickerKind, selectedIndex: number, optionCount: number): void {
	if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End" && event.key !== "Escape") return;
	event.preventDefault();
	if (event.key === "Escape") {
		closePicker(kind, true);
		return;
	}
	const index = event.key === "End"
		? optionCount - 1
		: event.key === "Home"
			? 0
			: Math.max(0, selectedIndex);
	setOpenPicker(kind, index);
}

function handlePickerOptionKeydown(event: KeyboardEvent, kind: PickerKind, index: number, optionCount: number): void {
	let nextIndex: number | undefined;
	if (event.key === "ArrowDown") nextIndex = (index + 1) % optionCount;
	else if (event.key === "ArrowUp") nextIndex = (index - 1 + optionCount) % optionCount;
	else if (event.key === "Home") nextIndex = 0;
	else if (event.key === "End") nextIndex = optionCount - 1;
	else if (event.key === "Escape") {
		event.preventDefault();
		closePicker(kind, true);
		return;
	} else if (event.key === "Tab") {
		requestAnimationFrame(() => setOpenPicker(null));
		return;
	} else {
		return;
	}
	event.preventDefault();
	focusAfterRender(pickerSelectors[kind].options, nextIndex);
}

interface TriggerDef {
	type: string;
	config: Record<string, any>;
	enabled: boolean;
	prompt?: string;
}

// ============================================================================
// DATA LOADING
// ============================================================================

export async function loadStaffPageData(): Promise<void> {
	currentView = "list";
	selectedStaff = null;
	loading = true;
	saving = false;
	deleting = false;
	renderApp();
	staffList = await fetchStaff();
	loading = false;
	renderApp();
	void ensureRolesLoaded();
}

/** Fetch roles for the picker (idempotent; re-renders when they arrive). */
async function ensureRolesLoaded(): Promise<void> {
	if (roles.length > 0) return;
	try {
		roles = await fetchRoles(state.activeProjectId ?? undefined);
		renderApp();
	} catch {
		/* roles are optional; leave list empty */
	}
}

// ============================================================================
// NAVIGATION
// ============================================================================

function showList(): void {
	currentView = "list";
	selectedStaff = null;
	setHashRoute("staff");
}

function showEdit(agent: StaffAgent): void {
	currentView = "edit";
	selectedStaff = agent;
	editName = agent.name;
	editDescription = agent.description;
	editPrompt = agent.systemPrompt;
	editPromptEditMode = false;
	editRuntimeCwd = "";
	editTriggers = parseTriggers(JSON.stringify(agent.triggers));
	editMemory = agent.memory || "";
	editContextPolicy = agent.contextPolicy === "preserve" ? "preserve" : "compact";
	editRoleId = agent.roleId || null;
	colorUserTouched = false;
	roleDropdownOpen = false;
	accessoryDropdownOpen = false;
	colorDropdownOpen = false;
	accessoryUserTouched = false;
	editTab = "prompt";
	saving = false;
	deleting = false;
	loadSessionAppearance(agent);
	void ensureRolesLoaded();
	setHashRoute("staff-edit", agent.id);
}

export function navigateToStaffEdit(staffId: string): void {
	const agent = staffList.find((s) => s.id === staffId);
	if (agent) {
		currentView = "edit";
		selectedStaff = agent;
		editName = agent.name;
		editDescription = agent.description;
		editPrompt = agent.systemPrompt;
		editPromptEditMode = false;
		editRuntimeCwd = "";
		editTriggers = parseTriggers(JSON.stringify(agent.triggers));
		editMemory = agent.memory || "";
		editContextPolicy = agent.contextPolicy === "preserve" ? "preserve" : "compact";
		editRoleId = agent.roleId || null;
		colorUserTouched = false;
		roleDropdownOpen = false;
		accessoryDropdownOpen = false;
		colorDropdownOpen = false;
		accessoryUserTouched = false;
		editTab = "prompt";
		saving = false;
		deleting = false;
		loadSessionAppearance(agent);
		void ensureRolesLoaded();
	} else {
		// Staff id unknown in current list — likely a stale search result.
		// Dispatch a page-local event so the search page can show a toast.
		try {
			window.dispatchEvent(new CustomEvent("search-result-stale", {
				detail: { kind: "staff", id: staffId },
			}));
		} catch { /* ignore */ }
	}
	renderApp();
}

async function loadSessionAppearance(agent: StaffAgent): Promise<void> {
	const sessionId = agent.currentSessionId;
	const cachedSession = sessionId
		? state.gatewaySessions.find((s) => s.id === sessionId)
		: undefined;
	editColorIndex = cachedSession ? (sessionColorMap.get(cachedSession.id) ?? -1) : -1;
	editAccessory = agent.accessory || "none";
	editRuntimeCwd = cachedSession?.cwd || (sessionId ? "Loading…" : "No active session");
	renderApp();

	if (!sessionId) return;
	try {
		const response = await gatewayFetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
		if (!response.ok) throw new Error(`Failed to load session: ${response.status}`);
		const currentSession = await response.json() as { id?: string; cwd?: string; colorIndex?: number };
		// Ignore a late response after navigation switched to another staff record.
		if (selectedStaff?.id !== agent.id || selectedStaff.currentSessionId !== sessionId) return;
		editRuntimeCwd = typeof currentSession.cwd === "string" && currentSession.cwd.length > 0
			? currentSession.cwd
			: "Runtime directory unavailable";
		if (!colorUserTouched && typeof currentSession.colorIndex === "number") editColorIndex = currentSession.colorIndex;
		renderApp();
	} catch {
		if (selectedStaff?.id !== agent.id || selectedStaff.currentSessionId !== sessionId) return;
		if (!cachedSession?.cwd) editRuntimeCwd = "Runtime directory unavailable";
		renderApp();
	}
}

// ============================================================================
// ACTIONS
// ============================================================================

function hasInvalidGoalTriggers(triggers: TriggerDef[]): boolean {
	return triggers.some((t) =>
		(t.type === "goal_created" || t.type === "goal_archived") &&
		(t.prompt || "").trim().length === 0,
	);
}

async function handleSave(): Promise<void> {
	if (!selectedStaff || saving) return;
	// Belt-and-braces: the Save button is disabled when this is true, but
	// short-circuit here too so programmatic clicks can't bypass validation.
	if (hasInvalidGoalTriggers(editTriggers)) return;
	saving = true;
	renderApp();
	const ok = await updateStaffAgent(selectedStaff.id, {
		name: editName,
		description: editDescription,
		systemPrompt: editPrompt,
		triggers: editTriggers,
		memory: editMemory,
		contextPolicy: editContextPolicy,
		accessory: editAccessory,
		roleId: editRoleId,
	});
	// Save session appearance (color only; staff accessory is persisted on the staff record).
	if (selectedStaff.currentSessionId) {
		const sid = selectedStaff.currentSessionId;
		const origColor = sessionColorMap.get(sid) ?? -1;
		if (editColorIndex !== origColor && editColorIndex >= 0) {
			setSessionColor(sid, editColorIndex);
		}
	}
	if (ok) {
		const [updatedStaff] = await Promise.all([
			fetchStaff(),
			refreshSessions(),
		]);
		staffList = updatedStaff;
		const updated = staffList.find((s) => s.id === selectedStaff!.id);
		if (updated) {
			selectedStaff = updated;
			editAccessory = updated.accessory || "none";
		}
	}
	saving = false;
	renderApp();
}

async function handleDelete(): Promise<void> {
	if (!selectedStaff || deleting) return;
	if (!confirm(`Delete staff agent "${selectedStaff.name}"?`)) return;
	deleting = true;
	renderApp();
	const ok = await deleteStaffAgent(selectedStaff.id);
	if (ok) {
		staffList = await fetchStaff();
		showList();
	}
	deleting = false;
	renderApp();
}

function selectRole(value: string): void {
	editRoleId = value || null;
	roleDropdownOpen = false;
	// Pre-fill the accessory from the selected role, but only as a default —
	// never override an accessory the user has manually chosen this session.
	if (editRoleId && !accessoryUserTouched) {
		const role = roles.find((r) => r.name === editRoleId);
		if (role) editAccessory = role.accessory || "none";
	}
	closePicker("role", true);
}

function selectAccessory(value: string): void {
	editAccessory = value;
	accessoryUserTouched = true;
	closePicker("accessory", true);
}

function selectColor(index: number): void {
	editColorIndex = index;
	colorUserTouched = true;
	closePicker("color", true);
}

async function handleTogglePause(): Promise<void> {
	if (!selectedStaff) return;
	const newState = selectedStaff.state === "paused" ? "active" : "paused";
	const ok = await updateStaffAgent(selectedStaff.id, { state: newState });
	if (ok) {
		staffList = await fetchStaff();
		const updated = staffList.find((s) => s.id === selectedStaff!.id);
		if (updated) selectedStaff = updated;
	}
	renderApp();
}

// ============================================================================
// TRIGGER EDITOR
// ============================================================================

function parseTriggers(json: string): TriggerDef[] {
	try {
		const arr = JSON.parse(json);
		return Array.isArray(arr) ? arr : [];
	} catch {
		return [];
	}
}

function updateTrigger(index: number, updater: (t: TriggerDef) => void) {
	if (editTriggers[index]) {
		updater(editTriggers[index]);
		renderApp();
	}
}

function removeTrigger(index: number) {
	editTriggers.splice(index, 1);
	renderApp();
}

function addTrigger() {
	editTriggers.push({ type: "schedule", config: { cron: "0 9 * * *" }, enabled: true, prompt: "" });
	renderApp();
}

function renderTriggersEditor() {
	if (editTriggers.length === 0) {
		return html`<div class="text-xs text-muted-foreground italic p-3 border border-dashed border-border rounded-md">No triggers configured. Add one above.</div>`;
	}
	return html`<div class="flex flex-col gap-2">${editTriggers.map((t, i) => renderTriggerCard(t, i))}</div>`;
}

function renderTriggerCard(trigger: TriggerDef, index: number) {
	const typeLabel: Record<string, string> = {
		schedule: "\u23F0 Schedule",
		git: "\uD83D\uDD00 Git",
		manual: "\uD83D\uDC46 Manual",
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
					data-testid="trigger-type-select"
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
				>${"\u2715"}</button>
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

			<div>
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

function describeCron(cron: string): string {
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
	if (hour.startsWith("*/")) {
		const n = hour.slice(2);
		const base = min === "0" ? "on the hour" : `at :${min.padStart(2, "0")}`;
		return `Every ${n} hour${n === "1" ? "" : "s"}, ${base}`;
	}
	if (min.startsWith("*/")) {
		const n = min.slice(2);
		return `Every ${n} minute${n === "1" ? "" : "s"}`;
	}
	if (dom === "*" && mon === "*" && dow === "*" && timeStr) return `Daily at ${timeStr}`;
	if (dom === "*" && mon === "*" && dow === "1-5" && timeStr) return `Weekdays at ${timeStr}`;
	if (dom === "*" && mon === "*" && dow !== "*" && timeStr) {
		const dowNum = parseInt(dow, 10);
		const dayName = !isNaN(dowNum) && dowNum >= 0 && dowNum <= 6 ? dayNames[dowNum] : dow;
		return `Every ${dayName} at ${timeStr}`;
	}
	if (dom !== "*" && mon === "*" && dow === "*" && timeStr) {
		const suffix = dom === "1" ? "st" : dom === "2" ? "nd" : dom === "3" ? "rd" : "th";
		return `${dom}${suffix} of each month at ${timeStr}`;
	}
	return cron ? `Custom: ${cron}` : "";
}

// ============================================================================
// HELPERS
// ============================================================================

function relativeTime(ts?: number): string {
	if (!ts) return "Never";
	const diff = Date.now() - ts;
	if (diff < 60_000) return "Just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return `${Math.floor(diff / 86_400_000)}d ago`;
}

function stateBadge(s: string): TemplateResult {
	const colors: Record<string, string> = {
		active: "bg-green-500/15 text-green-700 dark:text-green-400",
		paused: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
		retired: "bg-muted text-muted-foreground",
	};
	return html`<span class="px-2 py-0.5 text-xs rounded-full ${colors[s] || colors.retired}">${s}</span>`;
}

function triggerSummary(triggers: any[]): string {
	if (!triggers || triggers.length === 0) return "No triggers";
	return triggers.map((t: any) => {
		if (t.type === "schedule") return `Cron: ${t.config?.cron || "?"}`;
		if (t.type === "git") return `Git: ${t.config?.event || "push"}`;
		return t.type;
	}).join(", ");
}

function blobAccessoryClass(accessory: string): string {
	return accessory !== "none"
		? `bobbit-${accessory === "crown" ? "crowned" : accessory}`
		: "";
}

function normalizedColorIndex(hueIndex: number): number {
	return hueIndex >= 0 ? hueIndex : BOBBIT_HUE_ROTATIONS.indexOf(0);
}

/** One fixed sprite slot shared by every identity dropdown. */
function renderPickerSprite(accessory: string, hueIndex: number): TemplateResult {
	return html`
		<span class="inline-flex items-center justify-center w-5 h-5 shrink-0" data-testid="staff-picker-sprite">
			<span class="inline-flex relative" style="left:2px;top:1px;">
				${renderStaticSidebarBobbitCanvas({
					hueRotate: BOBBIT_HUE_ROTATIONS[normalizedColorIndex(hueIndex)],
					accessory: getAccessory(accessory),
				})}
			</span>
		</span>
	`;
}

/** Render the staff identity at its full, unscaled in-chat size. */
function renderEditAvatar(): TemplateResult {
	return renderIdleBlobCanvas({
		accId: editAccessory,
		accClass: blobAccessoryClass(editAccessory),
		size: 76,
		hueIndex: normalizedColorIndex(editColorIndex),
		clip: false,
	});
}

function renderPromptTab(): TemplateResult {
	return html`
		<div class="flex flex-col gap-4" data-testid="staff-prompt-tab-panel" role="tabpanel">
			<div>
				<div class="flex items-center justify-between mb-1.5">
					<label class="text-xs text-muted-foreground font-medium">System Prompt</label>
					<button
						class="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
						title="Toggle prompt edit mode"
						@click=${() => { editPromptEditMode = !editPromptEditMode; renderApp(); }}
					>
						${editPromptEditMode ? "Preview" : "Edit"}
					</button>
				</div>
				${editPromptEditMode
					? html`<textarea
							class="p-3 text-sm font-mono rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
							style="min-height:150px; max-height:400px; width:100%"
							.value=${editPrompt}
							@input=${(e: Event) => { editPrompt = (e.target as HTMLTextAreaElement).value; }}
						></textarea>`
					: html`<div class="p-3 rounded-md border border-border bg-secondary/30 overflow-y-auto text-sm" style="min-height:150px; max-height:400px">
							<markdown-block .content=${editPrompt || "_No prompt content yet_"}></markdown-block>
						</div>`
				}
			</div>
			<div>
				<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Pinned Context (optional)</label>
				<p class="text-[10px] text-muted-foreground mb-1">Injected when the agent session starts or restarts. Survives conversation compaction.</p>
				<textarea
					class="w-full p-2 text-sm font-mono rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
					rows="4"
					.value=${editMemory}
					@input=${(e: Event) => { editMemory = (e.target as HTMLTextAreaElement).value; }}
				></textarea>
			</div>
			<div class="context-policy-group" data-testid="context-policy">
				<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Context Policy</label>
				<p class="text-[10px] text-muted-foreground mb-1">What happens before a wake digest is sent when the inbox has pending entries.</p>
				<div class="flex gap-3">
					<label class="flex items-center gap-1.5 text-sm cursor-pointer">
						<input
							type="radio"
							name="contextPolicy"
							value="compact"
							.checked=${editContextPolicy === "compact"}
							@change=${() => { editContextPolicy = "compact"; renderApp(); }}
						/>
						<span>Compact <span class="text-[10px] text-muted-foreground">(default)</span></span>
					</label>
					<label class="flex items-center gap-1.5 text-sm cursor-pointer">
						<input
							type="radio"
							name="contextPolicy"
							value="preserve"
							.checked=${editContextPolicy === "preserve"}
							@change=${() => { editContextPolicy = "preserve"; renderApp(); }}
						/>
						<span>Preserve</span>
					</label>
				</div>
			</div>
		</div>
	`;
}

function renderTriggersTab(): TemplateResult {
	return html`
		<div data-testid="staff-triggers-tab-panel" role="tabpanel">
			<div class="flex items-center justify-between mb-1.5">
				<label class="text-xs text-muted-foreground font-medium">Triggers</label>
				<button
					class="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
					title="Add trigger"
					@click=${addTrigger}
				>+ Add trigger</button>
			</div>
			${renderTriggersEditor()}
		</div>
	`;
}

// ============================================================================
// LIST VIEW
// ============================================================================

function renderListView(): TemplateResult {
	if (loading) {
		return html`<div class="text-center py-12 text-muted-foreground text-sm">Loading...</div>`;
	}

	return html`
		<div class="flex-1 flex flex-col overflow-hidden">
			<div class="flex items-center justify-between p-4 border-b border-border shrink-0">
				<div class="flex items-center gap-2">
					${Button({
						variant: "ghost",
						size: "sm",
						onClick: () => setHashRoute("landing"),
						children: html`${icon(ArrowLeft, "sm")}`,
					})}
					<h1 class="text-lg font-semibold">Staff Agents</h1>
				</div>
			</div>
			<div class="flex-1 overflow-y-auto">
				${staffList.length === 0
					? html`
						<div class="text-center py-12">
							<div class="text-muted-foreground mb-3 flex justify-center empty-state-icon">${icon(UserCheck, "lg")}</div>
							<p class="text-sm text-muted-foreground mb-4">No staff agents yet</p>
							<p class="text-xs text-muted-foreground max-w-sm mx-auto">
								Create a staff agent from the sidebar using the + button next to "Staff",
								or use the Staff Assistant.
							</p>
						</div>
					`
					: html`
						<table class="w-full text-sm">
							<thead>
								<tr class="border-b border-border text-xs text-muted-foreground uppercase tracking-wider">
									<th class="text-left px-4 py-2 font-medium">Name</th>
									<th class="text-left px-4 py-2 font-medium">State</th>
									<th class="text-left px-4 py-2 font-medium">Triggers</th>
									<th class="text-left px-4 py-2 font-medium">Last Active</th>
								</tr>
							</thead>
							<tbody>
								${staffList.map((agent) => html`
									<tr class="border-b border-border/50 hover:bg-secondary/30 cursor-pointer transition-colors"
										@click=${() => showEdit(agent)}>
										<td class="px-4 py-3">
											<div class="font-medium">${agent.name}</div>
											<div class="text-xs text-muted-foreground truncate max-w-[300px]">${agent.description}</div>
										</td>
										<td class="px-4 py-3">${stateBadge(agent.state)}</td>
										<td class="px-4 py-3 text-muted-foreground text-xs">${triggerSummary(agent.triggers)}</td>
										<td class="px-4 py-3 text-muted-foreground text-xs">${relativeTime(agent.lastWakeAt)}</td>
									</tr>
								`)}
							</tbody>
						</table>
					`
				}
			</div>
		</div>
	`;
}

// ============================================================================
// EDIT VIEW
// ============================================================================

function renderEditView(): TemplateResult {
	if (!selectedStaff) return html`<div class="p-4">Staff agent not found</div>`;

	const displayColorIndex = editColorIndex >= 0 ? editColorIndex : BOBBIT_HUE_ROTATIONS.indexOf(0);
	const roleOptionIndex = editRoleId ? Math.max(0, roles.findIndex((role) => role.name === editRoleId) + 1) : 0;
	const accessoryOptionIndex = Math.max(0, ACCESSORY_IDS.indexOf(editAccessory));

	return html`
		<div class="flex-1 flex flex-col overflow-hidden">
			<div class="flex flex-wrap items-center justify-between gap-2 p-4 border-b border-border shrink-0">
				<div class="flex min-w-0 items-center gap-2">
					${Button({
						variant: "ghost",
						size: "sm",
						onClick: showList,
						children: html`${icon(ArrowLeft, "sm")}`,
					})}
					<h1 class="text-lg font-semibold">${selectedStaff.name}</h1>
					${stateBadge(selectedStaff.state)}
				</div>
				<div class="flex flex-wrap items-center justify-end gap-2" data-testid="staff-edit-header-actions">
					${Button({
						variant: "ghost",
						size: "sm",
						onClick: handleTogglePause,
						children: html`<span class="inline-flex items-center gap-1">${icon(selectedStaff.state === "paused" ? Play : Pause, "sm")} ${selectedStaff.state === "paused" ? "Resume" : "Pause"}</span>`,
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						onClick: handleDelete,
						disabled: deleting,
						children: html`<span class="inline-flex items-center gap-1 text-destructive">${icon(Trash2, "sm")} Delete</span>`,
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						onClick: showList,
						children: "Cancel",
					})}
					${Button({
						variant: "default",
						size: "sm",
						onClick: handleSave,
						disabled: saving || hasInvalidGoalTriggers(editTriggers),
						children: saving ? "Saving..." : "Save Changes",
					})}
				</div>
			</div>
			<div class="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
				<div class="flex items-center gap-3">
					<div class="w-[124px] h-[124px] shrink-0 flex items-center justify-center" data-testid="staff-edit-avatar">
						<div class="relative" style="left:44px" data-testid="staff-edit-avatar-sprite">${renderEditAvatar()}</div>
					</div>
					<div class="min-w-0 flex-1 flex flex-col gap-2">
						<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3" data-testid="staff-edit-name-field">
							<label class="text-right text-xs text-muted-foreground font-medium">Name</label>
							${Input({
								type: "text",
								value: editName,
								placeholder: "Staff agent name",
								onInput: (e: Event) => { editName = (e.target as HTMLInputElement).value; renderApp(); },
							})}
						</div>
						<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3" data-testid="staff-edit-cwd-field">
							<label class="text-right text-xs text-muted-foreground font-medium">Working Directory</label>
							<input
								type="text"
								class="w-full h-9 px-3 text-sm rounded-md border border-border bg-muted text-muted-foreground"
								.value=${editRuntimeCwd}
								readonly
								aria-readonly="true"
								title="Current agent runtime directory"
							/>
						</div>
						<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3" data-testid="staff-edit-sandbox-field">
							<label class="text-right text-xs text-muted-foreground font-medium">Sandbox</label>
							<div class="h-9 px-3 flex items-center text-sm text-foreground">${selectedStaff.sandboxed ? "Enabled" : "Disabled"}</div>
						</div>
					</div>
				</div>
				<div data-testid="staff-edit-description-field">
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Description</label>
					<textarea
						class="w-full p-2 text-sm rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
						rows="2"
						placeholder="What does this staff agent do?"
						.value=${editDescription}
						@input=${(e: Event) => { editDescription = (e.target as HTMLTextAreaElement).value; renderApp(); }}
					></textarea>
				</div>
				<div class="grid grid-cols-1 sm:grid-cols-3 gap-3" data-testid="staff-identity-selects">
					<div>
						<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Role</label>
						<div class="relative" data-testid="staff-role-picker" data-picker="role">
							<button
								data-testid="staff-role-select"
								class="w-full h-9 text-left px-2 text-sm rounded-md border border-border bg-background hover:bg-secondary/50 transition-colors flex items-center gap-1.5"
								aria-label="Select role"
								aria-haspopup="listbox"
								aria-controls="staff-role-options"
								aria-expanded=${roleDropdownOpen ? "true" : "false"}
								@keydown=${(event: KeyboardEvent) => handlePickerTriggerKeydown(event, "role", roleOptionIndex, roles.length + 1)}
								@click=${() => roleDropdownOpen ? closePicker("role") : setOpenPicker("role", roleOptionIndex)}
							>
								${renderPickerSprite(roles.find((role) => role.name === editRoleId)?.accessory || "none", displayColorIndex)}
								<span class="flex-1 truncate ${editRoleId ? "text-foreground" : "text-muted-foreground"}">${roles.find((role) => role.name === editRoleId)?.label || "No role"}</span>
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-muted-foreground transition-transform ${roleDropdownOpen ? "rotate-180" : ""}"><path d="m6 9 6 6 6-6"/></svg>
							</button>
							${roleDropdownOpen ? html`
								<div id="staff-role-options" class="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover text-popover-foreground shadow-lg py-1 max-h-[240px] overflow-y-auto" role="listbox" aria-label="Role options">
									<button
										class="w-full text-left px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground transition-colors flex items-center gap-2 ${!editRoleId ? "bg-accent/50" : ""}"
										role="option"
										aria-selected=${!editRoleId ? "true" : "false"}
										tabindex=${roleOptionIndex === 0 ? "0" : "-1"}
										@keydown=${(event: KeyboardEvent) => handlePickerOptionKeydown(event, "role", 0, roles.length + 1)}
										@click=${() => selectRole("")}
									>
										${renderPickerSprite("none", displayColorIndex)}
										<span>No role</span>
									</button>
									${roles.map((role, index) => html`
										<button
											class="w-full text-left px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground transition-colors flex items-center gap-2 ${editRoleId === role.name ? "bg-accent/50" : ""}"
											role="option"
											aria-selected=${editRoleId === role.name ? "true" : "false"}
											tabindex=${roleOptionIndex === index + 1 ? "0" : "-1"}
											data-value=${role.name}
											@keydown=${(event: KeyboardEvent) => handlePickerOptionKeydown(event, "role", index + 1, roles.length + 1)}
											@click=${() => selectRole(role.name)}
										>
											${renderPickerSprite(role.accessory || "none", displayColorIndex)}
											<span class="truncate">${role.label || role.name}</span>
										</button>
									`)}
								</div>
							` : ""}
						</div>
					</div>
					<div>
						<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Accessory</label>
						<div class="relative" data-testid="staff-accessory-picker" data-picker="accessory">
							<button
								data-testid="staff-accessory-select"
								data-value=${editAccessory}
								class="w-full h-9 text-left px-2 text-sm rounded-md border border-border bg-background hover:bg-secondary/50 transition-colors flex items-center gap-1.5"
								aria-label="Select accessory"
								aria-haspopup="listbox"
								aria-controls="staff-accessory-options"
								aria-expanded=${accessoryDropdownOpen ? "true" : "false"}
								@keydown=${(event: KeyboardEvent) => handlePickerTriggerKeydown(event, "accessory", accessoryOptionIndex, ACCESSORY_IDS.length)}
								@click=${() => accessoryDropdownOpen ? closePicker("accessory") : setOpenPicker("accessory", accessoryOptionIndex)}
							>
								${renderPickerSprite(editAccessory, displayColorIndex)}
								<span class="flex-1 truncate">${getAccessory(editAccessory).label}</span>
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-muted-foreground transition-transform ${accessoryDropdownOpen ? "rotate-180" : ""}"><path d="m6 9 6 6 6-6"/></svg>
							</button>
							${accessoryDropdownOpen ? html`
								<div id="staff-accessory-options" class="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover text-popover-foreground shadow-lg py-1 max-h-[240px] overflow-y-auto" role="listbox" aria-label="Accessory options">
									${ACCESSORY_IDS.map((accId: string, index: number) => html`
										<button
											class="w-full text-left px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground transition-colors flex items-center gap-2 ${editAccessory === accId ? "bg-accent/50" : ""}"
											role="option"
											aria-selected=${editAccessory === accId ? "true" : "false"}
											tabindex=${accessoryOptionIndex === index ? "0" : "-1"}
											data-value=${accId}
											title=${getAccessory(accId).label}
											@keydown=${(event: KeyboardEvent) => handlePickerOptionKeydown(event, "accessory", index, ACCESSORY_IDS.length)}
											@click=${() => selectAccessory(accId)}
										>
											${renderPickerSprite(accId, displayColorIndex)}
											<span class="truncate">${getAccessory(accId).label}</span>
										</button>
									`)}
								</div>
							` : ""}
						</div>
					</div>
					<div>
						<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Colour</label>
						<div class="relative" data-testid="staff-color-picker" data-picker="color">
							<button
								data-testid="staff-color-select"
								data-value=${String(displayColorIndex)}
								class="w-full h-9 text-left px-2 text-sm rounded-md border border-border bg-background hover:bg-secondary/50 transition-colors flex items-center gap-1.5"
								aria-label="Select colour"
								aria-haspopup="listbox"
								aria-controls="staff-color-options"
								aria-expanded=${colorDropdownOpen ? "true" : "false"}
								@keydown=${(event: KeyboardEvent) => handlePickerTriggerKeydown(event, "color", displayColorIndex, BOBBIT_HUE_ROTATIONS.length)}
								@click=${() => colorDropdownOpen ? closePicker("color") : setOpenPicker("color", displayColorIndex)}
							>
								${renderPickerSprite(editAccessory, displayColorIndex)}
								<span class="flex-1 truncate">${BOBBIT_COLOR_NAMES[displayColorIndex]}</span>
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-muted-foreground transition-transform ${colorDropdownOpen ? "rotate-180" : ""}"><path d="m6 9 6 6 6-6"/></svg>
							</button>
							${colorDropdownOpen ? html`
								<div id="staff-color-options" class="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover text-popover-foreground shadow-lg py-1 max-h-[240px] overflow-y-auto" role="listbox" aria-label="Colour options">
									${BOBBIT_HUE_ROTATIONS.map((_rotation: number, index: number) => html`
										<button
											class="w-full text-left px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground transition-colors flex items-center gap-2 ${displayColorIndex === index ? "bg-accent/50" : ""}"
											role="option"
											aria-selected=${displayColorIndex === index ? "true" : "false"}
											tabindex=${displayColorIndex === index ? "0" : "-1"}
											data-value=${String(index)}
											@keydown=${(event: KeyboardEvent) => handlePickerOptionKeydown(event, "color", index, BOBBIT_HUE_ROTATIONS.length)}
											@click=${() => selectColor(index)}
										>
											${renderPickerSprite(editAccessory, index)}
											<span class="truncate">${BOBBIT_COLOR_NAMES[index]}</span>
										</button>
									`)}
								</div>
							` : ""}
						</div>
					</div>
				</div>
				<div class="flex items-center gap-1 border-b border-border" role="group" aria-label="Staff configuration" data-testid="staff-edit-tabs">
					<button
						class="px-3 py-2 text-sm font-medium border-b-2 transition-colors ${editTab === "prompt" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}"
						aria-pressed=${editTab === "prompt" ? "true" : "false"}
						@click=${() => { editTab = "prompt"; renderApp(); }}
					>Prompt</button>
					<button
						class="px-3 py-2 text-sm font-medium border-b-2 transition-colors ${editTab === "triggers" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}"
						aria-pressed=${editTab === "triggers" ? "true" : "false"}
						@click=${() => { editTab = "triggers"; renderApp(); }}
					>Triggers</button>
				</div>
				${editTab === "prompt" ? renderPromptTab() : renderTriggersTab()}

			</div>
		</div>
	`;
}

// ============================================================================
// RENDER
// ============================================================================

export function renderStaffPage(): TemplateResult {
	ensureMarkdownBlock();
	if (currentView === "edit") return renderEditView();
	return renderListView();
}
