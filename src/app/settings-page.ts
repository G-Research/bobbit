import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { html } from "lit";
import { ArrowLeft, Plus, RotateCcw, X } from "lucide";
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
import { renderApp } from "./state.js";
import { getRouteFromHash, setHashRoute } from "./routing.js";
import { getAppStorage } from "../ui/storage/app-storage.js";

type SettingsTab = "shortcuts" | "palette";
let activeTab: SettingsTab = "shortcuts";

// Rebind state (same as shortcuts-dialog)
let rebindingId: string | null = null;
let rebindingIndex: number | null = null;
let pendingBinding: KeyBinding | null = null;
let conflictEntry: ShortcutEntry | null = null;
let browserReservedWarning = false;
let _listening = false;

function resetRebindState(): void {
	rebindingId = null;
	rebindingIndex = null;
	pendingBinding = null;
	conflictEntry = null;
	browserReservedWarning = false;
}

let _previousHash: string | null = null;

export function toggleSettings(): void {
	if (getRouteFromHash().view === "settings") {
		const hash = _previousHash || "#/";
		_previousHash = null;
		if (window.location.hash !== hash) {
			history.replaceState({}, "", hash);
			window.dispatchEvent(new HashChangeEvent("hashchange"));
		}
	} else {
		_previousHash = window.location.hash || "#/";
		setHashRoute("settings");
	}
}

function handleRebindKeydown(e: KeyboardEvent): void {
	e.preventDefault();
	e.stopPropagation();
	if (["Control", "Meta", "Shift", "Alt"].includes(e.key)) return;
	if (e.key === "Escape") {
		resetRebindState();
		renderApp();
		return;
	}
	const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
	const newBinding: KeyBinding = {
		key: e.key,
		ctrlOrMeta: isMac ? e.metaKey : e.ctrlKey,
		shift: e.shiftKey,
		alt: e.altKey,
	};
	if (rebindingId) {
		const entry = getShortcuts().find((s) => s.id === rebindingId);
		if (entry) {
			const isDuplicate = entry.currentBindings.some((b) => bindingsEqual(b, newBinding));
			if (isDuplicate) {
				resetRebindState();
				renderApp();
				return;
			}
		}
	}
	const conflict = findConflict(newBinding, rebindingId ?? undefined);
	if (conflict) {
		pendingBinding = newBinding;
		conflictEntry = conflict;
		browserReservedWarning = false;
		renderApp();
		return;
	}
	if (isBrowserReserved(newBinding)) {
		pendingBinding = newBinding;
		conflictEntry = null;
		browserReservedWarning = true;
		renderApp();
		return;
	}
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
	renderApp();
}

async function unbindConflictAndApply(): Promise<void> {
	if (!conflictEntry || !pendingBinding || !rebindingId) return;
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
	renderApp();
}

async function handleResetAll(): Promise<void> {
	resetAllBindings();
	await saveBindings();
	renderApp();
}

async function handleRemoveBinding(id: string, index: number): Promise<void> {
	removeBinding(id, index);
	await saveBindings();
	renderApp();
}

function startRebind(id: string, index: number | null): void {
	rebindingId = id;
	rebindingIndex = index;
	pendingBinding = null;
	conflictEntry = null;
	browserReservedWarning = false;
	renderApp();
}

function updateKeydownListener(): void {
	const isRebinding = rebindingId !== null && !pendingBinding && !conflictEntry && !browserReservedWarning;
	if (isRebinding && !_listening) {
		window.addEventListener("keydown", handleRebindKeydown, true);
		_listening = true;
	} else if (!isRebinding && _listening) {
		window.removeEventListener("keydown", handleRebindKeydown, true);
		_listening = false;
	}
}

function renderShortcutRow(entry: ShortcutEntry) {
	const isActiveRebind = rebindingId === entry.id;
	const showConflict = isActiveRebind && conflictEntry !== null && pendingBinding !== null;
	const showBrowserWarning = isActiveRebind && browserReservedWarning && pendingBinding !== null;
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
						<span class="inline-flex items-center gap-0">
							<button
								class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-l text-xs font-mono transition-all
									${isThisRebinding
										? "bg-primary/20 text-primary border border-primary animate-pulse"
										: "bg-secondary text-secondary-foreground hover:bg-secondary/80 border border-transparent"}"
								@click=${() => startRebind(entry.id, idx)}
								title=${isThisRebinding ? "Press a key combo..." : `Click to rebind (${formatBinding(binding)})`}
							>
								${isThisRebinding ? "Press a key combo..." : formatBinding(binding)}
							</button><button
								class="inline-flex items-center px-0.5 py-0.5 rounded-r text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 border border-transparent transition-colors "
								@click=${() => handleRemoveBinding(entry.id, idx)}
								title="Remove binding"
							>${icon(X, "xs")}</button>
						</span>
					`;
				})}
				${isActiveRebind && rebindingIndex === null && !pendingBinding
					? html`<button
							class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-mono bg-primary/20 text-primary border border-primary animate-pulse"
							@click=${() => startRebind(entry.id, null)}
						>Press a key combo...</button>`
					: html`<button
							class="inline-flex items-center p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors "
							@click=${() => startRebind(entry.id, null)}
							title="Add binding"
						>${icon(Plus, "xs")}</button>`}
				${isCustom
					? html`<button
							class="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors "
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
							${Button({ size: "sm", onClick: unbindConflictAndApply, children: "Unbind & Assign" })}
							${Button({ variant: "ghost", size: "sm", onClick: () => { resetRebindState(); renderApp(); }, children: "Cancel" })}
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
							${Button({ size: "sm", onClick: acceptBrowserReservedAndApply, children: "Assign Anyway" })}
							${Button({ variant: "ghost", size: "sm", onClick: () => { resetRebindState(); renderApp(); }, children: "Cancel" })}
						</div>
					</div>
				`
			: ""}
	`;
}

function renderShortcutsTab() {
	const allShortcuts = getShortcuts();
	const categories = new Map<string, ShortcutEntry[]>();
	for (const entry of allShortcuts) {
		const list = categories.get(entry.category) || [];
		list.push(entry);
		categories.set(entry.category, list);
	}
	const categoryOrder = ["Sessions", "Navigation", "Goals", "UI"];
	const sortedCategories = [...categories.entries()].sort((a, b) => {
		const ai = categoryOrder.indexOf(a[0]);
		const bi = categoryOrder.indexOf(b[0]);
		return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
	});

	return html`
		<div class="flex flex-col gap-4">
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
			<div class="pt-2 border-t border-border">
				${Button({
					variant: "ghost",
					size: "sm",
					onClick: handleResetAll,
					children: html`${icon(RotateCcw, "xs")}<span class="ml-1">Reset All Defaults</span>`,
				})}
			</div>
		</div>
	`;
}

// ── Palette chooser ──

interface ColorPalette {
	id: string;
	name: string;
	swatches: [string, string, string, string, string];
}

const PALETTES: ColorPalette[] = [
	{ id: "forest", name: "Forest", swatches: ["#508C50", "#6478A0", "#B99130", "#9169C3", "#C34B4B"] },
	{ id: "ocean",  name: "Ocean",  swatches: ["#32968C", "#3C78BE", "#E07850", "#8C8C9A", "#C34B4B"] },
	{ id: "dusk",   name: "Dusk",   swatches: ["#D2788C", "#5A5AAF", "#D4A017", "#8B5FCF", "#C85050"] },
	{ id: "mono",   name: "Mono",   swatches: ["#9CA3AF", "#6B7280", "#D1D5DB", "#A1A1AA", "#EF4444"] },
];

const SWATCH_LABELS = ["User", "System", "Task", "Team", "Error"];

let activePaletteId = "forest";
let paletteLoaded = false;

async function loadPalette(): Promise<void> {
	if (paletteLoaded) return;
	paletteLoaded = true;
	try {
		const storage = getAppStorage();
		const saved = await storage.settings.get<string>("palette");
		if (saved) activePaletteId = saved;
	} catch {}
}

async function selectPalette(id: string): Promise<void> {
	activePaletteId = id;
	if (id === "forest") {
		delete document.documentElement.dataset.palette;
	} else {
		document.documentElement.dataset.palette = id;
	}
	try {
		const storage = getAppStorage();
		await storage.settings.set("palette", id);
	} catch {}
	renderApp();
}

function renderPaletteTab() {
	loadPalette();

	return html`
		<div class="flex flex-col gap-3">
			<p class="text-sm text-muted-foreground">
				Choose a color palette for notifications and user messages.
			</p>
			<div class="flex flex-col gap-2">
				${PALETTES.map((palette) => {
					const isActive = activePaletteId === palette.id;
					return html`
						<button
							class="flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all cursor-pointer text-left w-full
								${isActive
									? "border-primary bg-primary/5 ring-1 ring-primary/30"
									: "border-border hover:border-primary/40 hover:bg-secondary/30"}"
							@click=${() => selectPalette(palette.id)}
						>
							<div class="flex gap-1.5">
								${palette.swatches.map((color, i) => html`
									<div
										class="w-6 h-6 rounded-full border border-black/10"
										style="background: ${color}"
										title="${SWATCH_LABELS[i]}"
									></div>
								`)}
							</div>
							<span class="text-sm font-medium ${isActive ? 'text-foreground' : 'text-muted-foreground'}">
								${palette.name}
							</span>
							${isActive ? html`<span class="ml-auto text-xs text-primary">Active</span>` : ""}
						</button>
					`;
				})}
			</div>
		</div>
	`;
}

export function renderSettingsPage() {
	// Manage keydown listener lifecycle
	updateKeydownListener();

	const tabs: { id: SettingsTab; label: string }[] = [
		{ id: "shortcuts", label: "Shortcuts" },
		{ id: "palette", label: "Color Palette" },
	];

	return html`
		<div class="flex-1 flex flex-col min-h-0 overflow-hidden">
			<!-- Header -->
			<div class="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-border">
				<button
					class="p-1.5 rounded-md hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
					@click=${() => { resetRebindState(); cleanupListener(); toggleSettings(); }}
					title="Back"
				>${icon(ArrowLeft, "sm")}</button>
				<h1 class="text-lg font-semibold">Settings</h1>
			</div>
			<!-- Tab bar -->
			<div class="shrink-0 flex items-center gap-1 px-4 py-2 border-b border-border bg-secondary/20">
				${tabs.map((tab) => html`
					<button
						class="px-3 py-1.5 text-sm rounded-md transition-colors
							${activeTab === tab.id
								? "bg-background text-foreground shadow-sm border border-border"
								: "text-muted-foreground hover:text-foreground hover:bg-secondary/50"}"
						@click=${() => { activeTab = tab.id; renderApp(); }}
					>${tab.label}</button>
				`)}
			</div>
			<!-- Tab content -->
			<div class="flex-1 overflow-y-auto p-4">
				<div class="max-w-xl">
					${activeTab === "shortcuts" ? renderShortcutsTab() : ""}
					${activeTab === "palette" ? renderPaletteTab() : ""}
				</div>
			</div>
		</div>
	`;
}

function cleanupListener(): void {
	if (_listening) {
		window.removeEventListener("keydown", handleRebindKeydown, true);
		_listening = false;
	}
}
