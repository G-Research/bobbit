/**
 * Keyboard shortcuts dialog — view and rebind shortcuts.
 */

import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { html, render } from "lit";
import { RotateCcw } from "lucide";
import {
	getShortcuts,
	formatBinding,
	findConflict,
	isBrowserReserved,
	updateBinding,
	addBinding,
	removeBinding,
	resetBinding,
	resetAllBindings,
	saveBindings,
	bindingsEqual,
	type KeyBinding,
	type ShortcutEntry,
} from "./shortcut-registry.js";

// ============================================================================
// STATE
// ============================================================================

let dialogContainer: HTMLDivElement | null = null;

// Rebind state
let rebindingId: string | null = null;
let rebindingIndex: number | null = null; // null = adding new binding
let pendingBinding: KeyBinding | null = null;
let conflictEntry: ShortcutEntry | null = null;
let browserReservedWarning = false;

function resetRebindState(): void {
	rebindingId = null;
	rebindingIndex = null;
	pendingBinding = null;
	conflictEntry = null;
	browserReservedWarning = false;
}

// ============================================================================
// PUBLIC API
// ============================================================================

export function showShortcutsDialog(): void {
	if (dialogContainer) return; // already open
	dialogContainer = document.createElement("div");
	document.body.appendChild(dialogContainer);
	resetRebindState();
	renderDialog();
}

export function hideShortcutsDialog(): void {
	if (!dialogContainer) return;
	resetRebindState();
	render(html``, dialogContainer);
	dialogContainer.remove();
	dialogContainer = null;
}

// ============================================================================
// REBIND KEYDOWN HANDLER
// ============================================================================

function handleRebindKeydown(e: KeyboardEvent): void {
	e.preventDefault();
	e.stopPropagation();

	// Ignore bare modifier presses
	if (["Control", "Meta", "Shift", "Alt"].includes(e.key)) return;

	// Escape cancels rebind
	if (e.key === "Escape") {
		resetRebindState();
		renderDialog();
		return;
	}

	const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
	const newBinding: KeyBinding = {
		key: e.key,
		ctrlOrMeta: isMac ? e.metaKey : e.ctrlKey,
		shift: e.shiftKey,
		alt: e.altKey,
	};

	// Check for duplicate on the same action
	if (rebindingId) {
		const entry = getShortcuts().find((s) => s.id === rebindingId);
		if (entry) {
			const isDuplicate = entry.currentBindings.some((b) => bindingsEqual(b, newBinding));
			if (isDuplicate) {
				// No-op — binding already exists on this action
				resetRebindState();
				renderDialog();
				return;
			}
		}
	}

	// Check for conflict with another action
	const conflict = findConflict(newBinding, rebindingId ?? undefined);
	if (conflict) {
		pendingBinding = newBinding;
		conflictEntry = conflict;
		browserReservedWarning = false;
		renderDialog();
		return;
	}

	// Check for browser-reserved combo
	if (isBrowserReserved(newBinding)) {
		pendingBinding = newBinding;
		conflictEntry = null;
		browserReservedWarning = true;
		renderDialog();
		return;
	}

	// Apply binding
	applyBinding(newBinding);
}

async function applyBinding(binding: KeyBinding): Promise<void> {
	if (!rebindingId) return;

	if (rebindingIndex !== null) {
		updateBinding(rebindingId, rebindingIndex, binding);
	} else {
		addBinding(rebindingId, binding);
	}

	resetRebindState();
	await saveBindings();
	renderDialog();
}

async function unbindConflictAndApply(): Promise<void> {
	if (!conflictEntry || !pendingBinding || !rebindingId) return;

	// Remove the conflicting binding from the other action
	const conflictBindingIndex = conflictEntry.currentBindings.findIndex((b) =>
		bindingsEqual(b, pendingBinding!),
	);
	if (conflictBindingIndex >= 0) {
		removeBinding(conflictEntry.id, conflictBindingIndex);
	}

	const binding = pendingBinding;
	pendingBinding = null;
	conflictEntry = null;
	browserReservedWarning = false;

	await applyBinding(binding);
}

async function acceptBrowserReservedAndApply(): Promise<void> {
	if (!pendingBinding) return;
	const binding = pendingBinding;
	pendingBinding = null;
	browserReservedWarning = false;
	await applyBinding(binding);
}

async function handleResetBinding(id: string): Promise<void> {
	resetBinding(id);
	await saveBindings();
	renderDialog();
}

async function handleResetAll(): Promise<void> {
	resetAllBindings();
	await saveBindings();
	renderDialog();
}

async function handleRemoveBinding(id: string, index: number): Promise<void> {
	removeBinding(id, index);
	await saveBindings();
	renderDialog();
}

// ============================================================================
// RENDER
// ============================================================================

function renderDialog(): void {
	if (!dialogContainer) return;

	const allShortcuts = getShortcuts();

	// Group by category
	const categories = new Map<string, ShortcutEntry[]>();
	for (const entry of allShortcuts) {
		const list = categories.get(entry.category) || [];
		list.push(entry);
		categories.set(entry.category, list);
	}

	// Category display order
	const categoryOrder = ["Sessions", "Navigation", "Goals", "UI"];
	const sortedCategories = [...categories.entries()].sort((a, b) => {
		const ai = categoryOrder.indexOf(a[0]);
		const bi = categoryOrder.indexOf(b[0]);
		return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
	});

	const isRebinding = rebindingId !== null;

	render(
		Dialog({
			isOpen: true,
			onClose: () => {
				if (isRebinding && !pendingBinding && !conflictEntry && !browserReservedWarning) {
					resetRebindState();
					renderDialog();
					return;
				}
				hideShortcutsDialog();
			},
			width: "min(520px, 92vw)",
			height: "auto",
			className: "max-h-[80vh]",
			backdropClassName: "bg-black/50 backdrop-blur-sm",
			children: html`
				${DialogContent({
					className: "overflow-y-auto",
					children: html`
						${DialogHeader({ title: "Keyboard Shortcuts" })}
						<div class="mt-3 flex flex-col gap-4">
							${sortedCategories.map(
								([category, entries]) => html`
									<div>
										<div class="text-[10px] text-muted-foreground uppercase tracking-wider font-medium mb-1.5 px-1">
											${category}
										</div>
										<div class="flex flex-col gap-0.5">
											${entries.map((entry) => renderShortcutRow(entry))}
										</div>
									</div>
								`,
							)}
						</div>
					`,
				})}
				${DialogFooter({
					className: "px-6 pb-4",
					children: html`
						<div class="flex gap-2 justify-between w-full">
							<div>
								${Button({
									variant: "ghost",
									size: "sm",
									onClick: handleResetAll,
									children: html`${icon(RotateCcw, "xs")}<span class="ml-1">Reset All Defaults</span>`,
								})}
							</div>
							<div>
								${Button({ variant: "ghost", onClick: () => hideShortcutsDialog(), children: "Close" })}
							</div>
						</div>
					`,
				})}
			`,
		}),
		dialogContainer,
	);

	// Attach or detach rebind keydown listener
	if (isRebinding && !pendingBinding && !conflictEntry && !browserReservedWarning) {
		window.addEventListener("keydown", handleRebindKeydown, true);
	} else {
		window.removeEventListener("keydown", handleRebindKeydown, true);
	}
}

function renderShortcutRow(entry: ShortcutEntry) {
	const isActiveRebind = rebindingId === entry.id;
	const showConflict = isActiveRebind && conflictEntry !== null && pendingBinding !== null;
	const showBrowserWarning = isActiveRebind && browserReservedWarning && pendingBinding !== null;

	// Check if current bindings differ from defaults
	const isCustom =
		entry.currentBindings.length !== entry.defaultBindings.length ||
		!entry.currentBindings.every((cb, i) => bindingsEqual(cb, entry.defaultBindings[i]));

	return html`
		<div class="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-secondary/30 transition-colors group">
			<span class="flex-1 text-sm text-foreground">${entry.label}</span>
			<div class="flex items-center gap-1.5">
				${entry.currentBindings.map((binding, idx) => {
					const isThisRebinding = isActiveRebind && rebindingIndex === idx && !pendingBinding;
					return html`
						<button
							class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-mono transition-all
								${isThisRebinding
									? "bg-primary/20 text-primary border border-primary animate-pulse"
									: "bg-secondary text-secondary-foreground hover:bg-secondary/80 border border-transparent"}"
							@click=${() => startRebind(entry.id, idx)}
							title=${isThisRebinding ? "Press a key combo..." : `Click to rebind (${formatBinding(binding)})`}
						>
							${isThisRebinding ? "Press a key combo..." : formatBinding(binding)}
						</button>
					`;
				})}
				${entry.currentBindings.length === 0
					? html`<button
							class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-mono
								${isActiveRebind && rebindingIndex === null && !pendingBinding
									? "bg-primary/20 text-primary border border-primary animate-pulse"
									: "bg-secondary/50 text-muted-foreground hover:bg-secondary/80 border border-dashed border-border"}"
							@click=${() => startRebind(entry.id, null)}
						>
							${isActiveRebind && rebindingIndex === null && !pendingBinding
								? "Press a key combo..."
								: "Add binding"}
						</button>`
					: ""}
				${isCustom
					? html`<button
							class="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors opacity-0 group-hover:opacity-100"
							@click=${() => handleResetBinding(entry.id)}
							title="Reset to default"
						>${icon(RotateCcw, "xs")}</button>`
					: ""}
			</div>
		</div>
		${showConflict
			? html`
					<div class="mx-2 mb-1 px-3 py-2 rounded-md bg-destructive/10 border border-destructive/20 text-sm">
						<p class="text-destructive mb-2">
							<strong>${formatBinding(pendingBinding!)}</strong> is already bound to
							<strong>${conflictEntry!.label}</strong>.
						</p>
						<div class="flex gap-2">
							${Button({
								size: "sm",
								onClick: unbindConflictAndApply,
								children: "Unbind & Assign",
							})}
							${Button({
								variant: "ghost",
								size: "sm",
								onClick: () => {
									resetRebindState();
									renderDialog();
								},
								children: "Cancel",
							})}
						</div>
					</div>
				`
			: ""}
		${showBrowserWarning
			? html`
					<div class="mx-2 mb-1 px-3 py-2 rounded-md bg-yellow-500/10 border border-yellow-500/20 text-sm">
						<p class="text-yellow-600 dark:text-yellow-400 mb-2">
							<strong>${formatBinding(pendingBinding!)}</strong> may be intercepted by the browser.
						</p>
						<div class="flex gap-2">
							${Button({
								size: "sm",
								onClick: acceptBrowserReservedAndApply,
								children: "Assign Anyway",
							})}
							${Button({
								variant: "ghost",
								size: "sm",
								onClick: () => {
									resetRebindState();
									renderDialog();
								},
								children: "Cancel",
							})}
						</div>
					</div>
				`
			: ""}
	`;
}

function startRebind(id: string, index: number | null): void {
	rebindingId = id;
	rebindingIndex = index;
	pendingBinding = null;
	conflictEntry = null;
	browserReservedWarning = false;
	renderDialog();
}
