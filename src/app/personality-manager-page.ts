import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html, nothing, type TemplateResult } from "lit";
import { ArrowLeft, Pencil, Plus, Trash2 } from "lucide";
import { fetchPersonalities, createPersonality, updatePersonality, deletePersonality, type PersonalityData } from "./api.js";
import { renderApp } from "./state.js";
import { setHashRoute } from "./routing.js";

// ============================================================================
// STATE
// ============================================================================

type View = "list" | "edit" | "create";

let currentView: View = "list";
let personalities: PersonalityData[] = [];
let selectedPersonality: PersonalityData | null = null;
let loading = true;

// Edit form state
let editName = "";
let editLabel = "";
let editDescription = "";
let editPromptFragment = "";

let saving = false;
let deleting = false;

// ============================================================================
// DATA LOADING
// ============================================================================

export async function loadPersonalityPageData(): Promise<void> {
	currentView = "list";
	selectedPersonality = null;
	loading = true;
	saving = false;
	deleting = false;
	renderApp();
	personalities = await fetchPersonalities();
	loading = false;
	renderApp();
}

export function clearPersonalityPageState(): void {
	currentView = "list";
	selectedPersonality = null;
	loading = true;
	saving = false;
	deleting = false;
}

// ============================================================================
// NAVIGATION
// ============================================================================

function showList(): void {
	currentView = "list";
	selectedPersonality = null;
	setHashRoute("personalities");
}

function showEdit(personality: PersonalityData): void {
	currentView = "edit";
	selectedPersonality = personality;
	editName = personality.name;
	editLabel = personality.label;
	editDescription = personality.description;
	editPromptFragment = personality.promptFragment;
	saving = false;
	deleting = false;
	setHashRoute("personality-edit", personality.name);
}

function showCreate(): void {
	currentView = "create";
	selectedPersonality = null;
	editName = "";
	editLabel = "";
	editDescription = "";
	editPromptFragment = "";
	saving = false;
	deleting = false;
	renderApp();
}

/** Called by the main router when navigating to #/personalities/:name */
export function navigateToPersonalityEdit(personalityName: string): void {
	const personality = personalities.find((p) => p.name === personalityName);
	if (personality) {
		currentView = "edit";
		selectedPersonality = personality;
		editName = personality.name;
		editLabel = personality.label;
		editDescription = personality.description;
		editPromptFragment = personality.promptFragment;
		saving = false;
		deleting = false;
	} else {
		currentView = "list";
		selectedPersonality = null;
	}
	renderApp();
}

// ============================================================================
// ACTIONS
// ============================================================================

async function handleSave(): Promise<void> {
	saving = true;
	renderApp();

	if (currentView === "create") {
		const trimmedName = editName.trim();
		if (!trimmedName || !editLabel.trim()) {
			saving = false;
			renderApp();
			return;
		}
		const ok = await createPersonality({
			name: trimmedName,
			label: editLabel.trim(),
			description: editDescription.trim(),
			promptFragment: editPromptFragment,
		});
		if (ok) {
			personalities = await fetchPersonalities();
			showList();
			return;
		}
	} else if (selectedPersonality) {
		const ok = await updatePersonality(selectedPersonality.name, {
			label: editLabel.trim(),
			description: editDescription.trim(),
			promptFragment: editPromptFragment,
		});
		if (ok) {
			personalities = await fetchPersonalities();
			const updated = personalities.find((p) => p.name === selectedPersonality!.name);
			if (updated) showEdit(updated);
			else showList();
			return;
		}
	}
	saving = false;
	renderApp();
}

async function handleDelete(): Promise<void> {
	if (!selectedPersonality) return;
	const { confirmAction } = await import("./dialogs.js");
	const confirmed = await confirmAction(
		"Delete Personality",
		`Are you sure you want to delete "${selectedPersonality.label}"? This cannot be undone.`,
		"Delete",
		true,
	);
	if (!confirmed) return;

	deleting = true;
	renderApp();
	const ok = await deletePersonality(selectedPersonality.name);
	if (ok) {
		personalities = await fetchPersonalities();
		showList();
	} else {
		deleting = false;
		renderApp();
	}
}

async function handleDeleteFromList(personality: PersonalityData): Promise<void> {
	const { confirmAction } = await import("./dialogs.js");
	const confirmed = await confirmAction(
		"Delete Personality",
		`Are you sure you want to delete "${personality.label}"? This cannot be undone.`,
		"Delete",
		true,
	);
	if (!confirmed) return;

	const ok = await deletePersonality(personality.name);
	if (ok) {
		personalities = await fetchPersonalities();
		renderApp();
	}
}

// ============================================================================
// RENDER: NAV BAR
// ============================================================================

function renderNavBar(): TemplateResult {
	if (currentView === "edit" && selectedPersonality) {
		const hasChanges =
			editLabel !== selectedPersonality.label ||
			editDescription !== selectedPersonality.description ||
			editPromptFragment !== selectedPersonality.promptFragment;

		return html`
			<div class="personalities-nav">
				<div class="personalities-nav-left">
					<button class="personalities-back" @click=${showList} title="Back to personalities">
						${icon(ArrowLeft, "sm")}
					</button>
					<div class="personalities-title-group">
						<span class="personalities-breadcrumb" @click=${showList}>Personalities</span>
						<span class="personalities-breadcrumb-sep">/</span>
						<h1 class="personalities-title">${selectedPersonality.label}</h1>
					</div>
				</div>
				<div class="personalities-nav-right">
					${Button({
						variant: "ghost" as any,
						size: "sm",
						onClick: handleDelete,
						disabled: deleting,
						className: "text-destructive hover:text-destructive hover:bg-destructive/10",
						children: html`<span class="inline-flex items-center gap-1">${icon(Trash2, "sm")} ${deleting ? "Deleting\u2026" : "Delete"}</span>`,
					})}
					${Button({
						variant: "default",
						size: "sm",
						onClick: handleSave,
						disabled: saving || !hasChanges,
						children: saving ? "Saving\u2026" : "Save",
					})}
				</div>
			</div>
		`;
	}

	if (currentView === "create") {
		const canSave = editName.trim() && editLabel.trim();
		return html`
			<div class="personalities-nav">
				<div class="personalities-nav-left">
					<button class="personalities-back" @click=${showList} title="Back to personalities">
						${icon(ArrowLeft, "sm")}
					</button>
					<div class="personalities-title-group">
						<span class="personalities-breadcrumb" @click=${showList}>Personalities</span>
						<span class="personalities-breadcrumb-sep">/</span>
						<h1 class="personalities-title">New Personality</h1>
					</div>
				</div>
				<div class="personalities-nav-right">
					${Button({
						variant: "default",
						size: "sm",
						onClick: handleSave,
						disabled: saving || !canSave,
						children: saving ? "Creating\u2026" : "Create",
					})}
				</div>
			</div>
		`;
	}

	// List view
	return html`
		<div class="personalities-nav">
			<div class="personalities-nav-left">
				<button class="personalities-back" @click=${() => setHashRoute("landing")} title="Back to sessions">
					${icon(ArrowLeft, "sm")}
				</button>
				<h1 class="personalities-title">Personalities</h1>
			</div>
			<div class="personalities-nav-right">
				${Button({
					variant: "default",
					size: "sm",
					onClick: showCreate,
					children: html`<span class="inline-flex items-center gap-1.5 font-semibold">${icon(Plus, "sm")} New Personality</span>`,
				})}
			</div>
		</div>
	`;
}

// ============================================================================
// RENDER: LIST VIEW
// ============================================================================

function renderPersonalityRow(personality: PersonalityData): TemplateResult {
	return html`
		<div class="personality-row" tabindex="0" role="button"
			@click=${() => showEdit(personality)}
			@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showEdit(personality); } }}>
			<div class="personality-row-info">
				<span class="personality-row-label">${personality.label}</span>
				<span class="personality-row-slug">${personality.name}</span>
				${personality.description ? html`<span class="personality-row-desc">${personality.description}</span>` : nothing}
			</div>
			<div class="personality-row-actions">
				<button class="personality-row-action-btn" @click=${(e: Event) => { e.stopPropagation(); showEdit(personality); }} title="Edit">
					${icon(Pencil, "sm")}
				</button>
				<button class="personality-row-action-btn delete" @click=${(e: Event) => { e.stopPropagation(); handleDeleteFromList(personality); }} title="Delete">
					${icon(Trash2, "sm")}
				</button>
			</div>
		</div>
	`;
}

function renderListView(): TemplateResult {
	if (loading) {
		return html`
			<div class="personalities-loading">
				<svg class="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
				</svg>
				<span>Loading personalities\u2026</span>
			</div>
		`;
	}

	if (personalities.length === 0) {
		return html`
			<div class="personalities-empty">
				<p class="personalities-empty-title">No personalities yet</p>
				<p class="personalities-empty-desc">Personalities shape how agents communicate — their tone, style, and behavioral constraints.</p>
				${Button({
					variant: "default",
					onClick: showCreate,
					children: html`<span class="inline-flex items-center gap-1.5">${icon(Plus, "sm")} Create your first personality</span>`,
				})}
			</div>
		`;
	}

	return html`
		<p class="text-sm text-muted-foreground mb-6" style="max-width: 600px; margin: 0 auto;">Personalities change how an agent behaves \u2014 its communication style, thoroughness, and approach. They\u2019re optional modifiers you can apply when spawning agents.</p>
		<div class="personalities-list">
			${personalities.map((p) => renderPersonalityRow(p))}
		</div>
	`;
}

// ============================================================================
// RENDER: EDIT / CREATE VIEW
// ============================================================================

function renderEditView(): TemplateResult {
	const isCreate = currentView === "create";

	return html`
		<div class="personalities-edit-container">
			<!-- Identity section -->
			<div class="personalities-edit-section">
				<h2 class="personalities-section-title">Identity</h2>
				<div class="personalities-edit-field">
					<label class="personalities-field-label">Name</label>
					${isCreate
						? Input({
							value: editName,
							placeholder: "personality-name",
							onInput: (e: Event) => { editName = (e.target as HTMLInputElement).value; renderApp(); },
						})
						: html`<div class="personalities-field-readonly">${editName}</div>`
					}
				</div>
				<div class="personalities-edit-field">
					<label class="personalities-field-label">Label</label>
					${Input({
						value: editLabel,
						placeholder: "e.g. Concise Communicator",
						onInput: (e: Event) => { editLabel = (e.target as HTMLInputElement).value; renderApp(); },
					})}
				</div>
			</div>

			<!-- Description -->
			<div class="personalities-edit-section">
				<h2 class="personalities-section-title">Description</h2>
				<div class="personalities-edit-field">
					${Input({
						value: editDescription,
						placeholder: "One-line tooltip description",
						onInput: (e: Event) => { editDescription = (e.target as HTMLInputElement).value; renderApp(); },
					})}
				</div>
			</div>

			<!-- Prompt Fragment -->
			<div class="personalities-edit-section">
				<h2 class="personalities-section-title">Prompt Fragment</h2>
				<textarea
					class="personalities-prompt-editor"
					.value=${editPromptFragment}
					placeholder="1-2 sentences injected into the agent's system prompt that define this personality."
					@input=${(e: Event) => { editPromptFragment = (e.target as HTMLTextAreaElement).value; renderApp(); }}
				></textarea>
			</div>
		</div>
	`;
}

// ============================================================================
// MAIN RENDER
// ============================================================================

export function renderPersonalityManagerPage(): TemplateResult {
	return html`
		<div class="personalities-container">
			${renderNavBar()}
			<div class="personalities-body">
				${currentView === "list" ? renderListView() : renderEditView()}
			</div>
		</div>
	`;
}
