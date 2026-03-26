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
import { renderApp, state } from "./state.js";
import { getRouteFromHash, setHashRoute } from "./routing.js";
import { gatewayFetch } from "./api.js";
import { ModelSelector } from "../ui/dialogs/ModelSelector.js";

type SettingsTab = "general" | "shortcuts" | "palette" | "models" | "project";
// Shortcuts is the default tab so that Ctrl+, acts as a quick toggle for a
// keyboard-shortcut reference — press once to open, press again to dismiss.
let activeTab: SettingsTab = "shortcuts";

// Rebind state (same as shortcuts-dialog)
let rebindingId: string | null = null;
let rebindingIndex: number | null = null;
let pendingBinding: KeyBinding | null = null;
let conflictEntry: ShortcutEntry | null = null;
let browserReservedWarning = false;
let _listening = false;

let settingsCwd = "";
let settingsCwdLoaded = false;
let settingsCwdSaveStatus: "" | "saving" | "saved" | "error" = "";

// ── Project tab state ──
let projectConfig: Record<string, string> = {};
let projectDefaults: Record<string, string> = {};
let projectConfigLoaded = false;
let projectSaveStatus: "" | "saving" | "saved" | "error" = "";
let projectNewEntries: { key: string; value: string }[] = [];

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

function renderShortcutRow(entry: ShortcutEntry, index = 0) {
	const isActiveRebind = rebindingId === entry.id;
	const showConflict = isActiveRebind && conflictEntry !== null && pendingBinding !== null;
	const showBrowserWarning = isActiveRebind && browserReservedWarning && pendingBinding !== null;
	const isCustom =
		entry.currentBindings.length !== entry.defaultBindings.length ||
		!entry.currentBindings.every((cb, i) => bindingsEqual(cb, entry.defaultBindings[i]));

	return html`
		<div class="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-secondary/30 transition-colors group ${index % 2 === 0 ? "bg-secondary/50" : ""}">
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
							title="Press a key combo to add a binding"
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

// ── General tab (see module-level state and renderGeneralTab above) ──

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
		<div class="flex gap-6 items-start">
			<div class="flex-1 min-w-0 flex flex-col gap-4">
				${sortedCategories.map(
					([category, entries]) => html`
						<div>
							<div class="text-[10px] text-muted-foreground uppercase tracking-wider font-medium mb-1.5 px-1">
								${category}
							</div>
							<div class="flex flex-col gap-0.5">
								${entries.map((entry, i) => renderShortcutRow(entry, i))}
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
			<div class="shrink-0 w-48 rounded-md border border-border/60 bg-secondary/30 p-3 text-xs text-muted-foreground leading-relaxed">
				<span class="font-medium text-foreground/80">Tip:</span> When running Bobbit as a browser tab, some shortcut combinations are intercepted by the browser. Install Bobbit as a PWA app to regain complete control.
			</div>
		</div>
	`;
}

// ── Palette chooser ──

interface ColorPalette {
	id: string;
	name: string;
}

const PALETTES: ColorPalette[] = [
	{ id: "forest", name: "Forest" },
	{ id: "ocean",  name: "Ocean" },
	{ id: "dusk",   name: "Dusk" },
	{ id: "ember",  name: "Ember" },
	{ id: "rose",   name: "Rose" },
	{ id: "slate",  name: "Slate" },
	{ id: "sand",   name: "Sand" },
	{ id: "teal",   name: "Teal" },
	{ id: "copper", name: "Copper" },
	{ id: "mono",   name: "Mono" },
];

/** Read the active palette from the DOM (source of truth) or fall back to "forest". */
function getActivePaletteId(): string {
	return document.documentElement.dataset.palette || "forest";
}

async function selectPalette(id: string): Promise<void> {
	if (id === "forest") {
		delete document.documentElement.dataset.palette;
	} else {
		document.documentElement.dataset.palette = id;
	}
	try {
		await gatewayFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ palette: id }),
		});
	} catch {}
	renderApp();
}

function renderPalettePreview(palette: ColorPalette) {
	const isDark = document.documentElement.classList.contains("dark");

	// Each preview gets data-palette + optional dark class so the real
	// CSS variable rules ([data-palette="xxx"]) apply and cascade.
	return html`
		<div
			data-palette=${palette.id}
			class=${isDark ? "dark" : ""}
			style="display:flex; width:100%; height:68px; border-radius:6px; overflow:hidden; border:1px solid var(--border); font-family:system-ui,sans-serif;"
		>
			<!-- Sidebar -->
			<div style="width:44px; background:var(--sidebar); border-right:1px solid var(--sidebar-border); display:flex; flex-direction:column; gap:4px; padding:7px 5px;">
				<div style="display:flex; align-items:center; gap:3px;">
					<div style="width:10px; height:10px; border-radius:50%; background:var(--primary); flex-shrink:0;"></div>
					<div style="height:4px; flex:1; border-radius:2px; background:var(--sidebar-accent);"></div>
				</div>
				<div style="display:flex; align-items:center; gap:3px; opacity:0.7;">
					<div style="width:10px; height:10px; border-radius:50%; background:var(--muted-foreground); flex-shrink:0;"></div>
					<div style="height:4px; flex:1; border-radius:2px; background:var(--sidebar-accent);"></div>
				</div>
				<div style="display:flex; align-items:center; gap:3px; opacity:0.4;">
					<div style="width:10px; height:10px; border-radius:50%; background:var(--muted-foreground); flex-shrink:0;"></div>
					<div style="height:4px; flex:1; border-radius:2px; background:var(--sidebar-accent);"></div>
				</div>
			</div>
			<!-- Chat area -->
			<div style="flex:1; background:var(--background); padding:6px 8px; display:flex; flex-direction:column; gap:4px; justify-content:center;">
				<!-- User message (mirrors .user-message-container) -->
				<div style="display:flex; align-items:center; gap:3px; background:linear-gradient(135deg, var(--user-msg-bg), var(--user-msg-bg2)); border-radius:4px; padding:2px 6px 2px 3px; box-shadow:0 1px 3px var(--user-msg-shadow);">
					<span style="color:var(--user-msg-accent); font-size:7px; font-weight:bold; line-height:1;">❯</span>
					<span style="font-size:7px; color:var(--foreground); line-height:1.3; white-space:nowrap; overflow:hidden;">How do I fix this?</span>
				</div>
				<!-- Assistant response (foreground text) -->
				<div style="padding-left:2px; display:flex; flex-direction:column; gap:2px;">
					<div style="height:4px; width:92%; border-radius:2px; background:var(--muted-foreground); opacity:0.25;"></div>
					<div style="height:4px; width:68%; border-radius:2px; background:var(--muted-foreground); opacity:0.15;"></div>
				</div>
				<!-- Input bar (mirrors real input area) -->
				<div style="display:flex; align-items:center; gap:3px; margin-top:auto;">
					<div style="flex:1; height:9px; border-radius:4px; border:1px solid var(--input); background:var(--background);"></div>
					<div style="width:16px; height:9px; border-radius:4px; background:var(--primary); display:flex; align-items:center; justify-content:center;">
						<span style="color:var(--primary-foreground); font-size:6px; line-height:1;">↑</span>
					</div>
				</div>
			</div>
		</div>
	`;
}

function renderPaletteTab() {
	const currentPalette = getActivePaletteId();

	return html`
		<div class="flex flex-col gap-3">
			<p class="text-sm text-muted-foreground">
				Choose a color palette for the app theme.
			</p>
			<div class="grid gap-2" style="grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));">
				${PALETTES.map((palette) => {
					const isActive = currentPalette === palette.id;
					return html`
						<button
							class="flex flex-col gap-1.5 px-3 py-2.5 rounded-lg border transition-all cursor-pointer text-left w-full
								${isActive
									? "border-primary bg-primary/5 ring-1 ring-primary/30"
									: "border-border hover:border-primary/40 hover:bg-secondary/30"}"
							title="Select ${palette.name} palette"
							@click=${() => selectPalette(palette.id)}
						>
							${renderPalettePreview(palette)}
							<div class="flex items-center gap-1.5">
								<span class="text-sm font-medium ${isActive ? 'text-foreground' : 'text-muted-foreground'}">
									${palette.name}
								</span>
								${isActive ? html`<span class="text-xs text-primary">Active</span>` : ""}
							</div>
						</button>
					`;
				})}
			</div>
		</div>
	`;
}

// ── Models tab ──

let aigwUrl = "http://aigw-local.c3.zone/v1";
let aigwStatus: "idle" | "testing" | "saving" | "removing" = "idle";
let aigwError = "";
let aigwConfigured = false;
let aigwConfiguredUrl = "";
let aigwModels: Array<{ id: string; name: string; contextWindow: number; maxTokens: number; reasoning: boolean }> = [];
// Preferences
let prefSessionModel = "";   // "provider/modelId" e.g. "aigw/claude-sonnet-4-6" or "anthropic/claude-sonnet-4-6"
let prefReviewModel = "";    // same format
let prefNamingModel = "";    // same format
let _modelsLoaded = false;

function loadModelsState(): void {
	if (_modelsLoaded) return;
	_modelsLoaded = true;
	(async () => {
		try {
			const [statusRes, prefsRes] = await Promise.all([
				gatewayFetch("/api/aigw/status"),
				gatewayFetch("/api/preferences"),
			]);
			if (statusRes.ok) {
				const data = await statusRes.json();
				aigwConfigured = data.configured;
				if (data.configured) {
					aigwConfiguredUrl = data.url;
					aigwUrl = data.url;
					aigwModels = data.models || [];
				}
			}
			if (prefsRes.ok) {
				const prefs = await prefsRes.json();
				prefSessionModel = prefs["default.sessionModel"] || "";
				prefReviewModel = prefs["default.reviewModel"] || "";
				prefNamingModel = prefs["default.namingModel"] || "";
			}
		} catch {}
		renderApp();
	})();
}

async function savePref(key: string, value: string | null): Promise<void> {
	try {
		await gatewayFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ [key]: value }),
		});
	} catch {}
}

async function setSessionModel(value: string): Promise<void> {
	prefSessionModel = value;
	await savePref("default.sessionModel", value || null);
	renderApp();
}

async function setReviewModel(value: string): Promise<void> {
	prefReviewModel = value;
	await savePref("default.reviewModel", value || null);
	renderApp();
}

async function setNamingModel(value: string): Promise<void> {
	prefNamingModel = value;
	await savePref("default.namingModel", value || null);
	renderApp();
}

async function testAigwConnection(): Promise<void> {
	if (!aigwUrl.trim()) return;
	aigwStatus = "testing";
	aigwError = "";
	renderApp();
	try {
		const res = await gatewayFetch("/api/aigw/test", {
			method: "POST",
			body: JSON.stringify({ url: aigwUrl.trim() }),
		});
		const data = await res.json();
		if (!res.ok) {
			aigwError = data.error || `HTTP ${res.status}`;
		} else {
			aigwModels = data.models || [];
			aigwError = "";
		}
	} catch (err: any) {
		aigwError = err.message || "Connection failed";
	}
	aigwStatus = "idle";
	renderApp();
}

async function saveAigwConfig(): Promise<void> {
	if (!aigwUrl.trim()) return;
	aigwStatus = "saving";
	aigwError = "";
	renderApp();
	try {
		const res = await gatewayFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: aigwUrl.trim() }),
		});
		const data = await res.json();
		if (!res.ok) {
			aigwError = data.error || `HTTP ${res.status}`;
		} else {
			aigwConfigured = true;
			aigwConfiguredUrl = aigwUrl.trim();
			aigwModels = data.models || [];
			aigwError = "";
		}
	} catch (err: any) {
		aigwError = err.message || "Save failed";
	}
	aigwStatus = "idle";
	renderApp();
}

async function refreshAigwModels(): Promise<void> {
	aigwStatus = "testing";
	aigwError = "";
	renderApp();
	try {
		const res = await gatewayFetch("/api/aigw/refresh", { method: "POST" });
		const data = await res.json();
		if (!res.ok) {
			aigwError = data.error || `HTTP ${res.status}`;
		} else {
			aigwModels = data.models || [];
			aigwError = "";
		}
	} catch (err: any) {
		aigwError = err.message || "Refresh failed";
	}
	aigwStatus = "idle";
	renderApp();
}

async function removeAigwConfig(): Promise<void> {
	aigwStatus = "removing";
	aigwError = "";
	renderApp();
	try {
		await gatewayFetch("/api/aigw/configure", { method: "DELETE" });
		aigwConfigured = false;
		aigwConfiguredUrl = "";
		aigwUrl = "";
		aigwModels = [];
		aigwError = "";
	} catch (err: any) {
		aigwError = err.message || "Remove failed";
	}
	aigwStatus = "idle";
	renderApp();
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K`;
	return String(tokens);
}

/** Format a "provider/modelId" pref value for display. Shows just the model ID. */
function formatModelPref(value: string): string {
	if (!value) return "Auto (best available)";
	const slash = value.indexOf("/");
	return slash > 0 ? value.slice(slash + 1) : value;
}

function openModelPicker(currentValue: string, onChange: (v: string) => void) {
	// Build a pseudo-Model from the current pref so the selector can highlight it
	let currentModel = null;
	if (currentValue) {
		const slash = currentValue.indexOf("/");
		if (slash > 0) {
			currentModel = { provider: currentValue.slice(0, slash), id: currentValue.slice(slash + 1) } as any;
		}
	}
	ModelSelector.open(currentModel, (model) => {
		onChange(`${model.provider}/${model.id}`);
	});
}

function renderModelPicker(label: string, hint: string, value: string, onChange: (v: string) => void) {
	const display = formatModelPref(value);
	return html`
		<div class="flex flex-col gap-1.5">
			<label class="text-sm font-medium text-foreground">${label}</label>
			<div class="flex gap-2">
				<button
					class="flex-1 px-3 py-2 text-left rounded-md border border-input bg-background text-sm
						hover:bg-secondary transition-colors focus:outline-none focus:ring-2 focus:ring-ring
						${value ? "text-foreground" : "text-muted-foreground"}"
					title="Choose model"
					@click=${() => openModelPicker(value, onChange)}
				>${display}</button>
				${value ? html`
					<button
						class="px-2 py-2 rounded-md border border-input bg-background text-muted-foreground
							hover:bg-secondary hover:text-foreground transition-colors"
						title="Reset to auto"
						@click=${() => onChange("")}
					>${icon(X, "sm")}</button>
				` : ""}
			</div>
			<p class="text-xs text-muted-foreground">${hint}</p>
		</div>
	`;
}

function renderModelsTab() {
	loadModelsState();

	const busy = aigwStatus !== "idle";
	const hasModels = aigwModels.length > 0;

	return html`
		<div class="flex flex-col gap-6">

			<!-- Default model preferences -->
			<div class="flex flex-col gap-4">
				<h3 class="text-sm font-semibold text-foreground">Default Models</h3>
				${renderModelPicker(
					"Session Model",
					"Model used when creating new sessions. \"Auto\" picks the best available model by tier.",
					prefSessionModel,
					setSessionModel,
				)}
				${renderModelPicker(
					"Review Model",
					"Model used for automated LLM code reviews during gate verification.",
					prefReviewModel,
					setReviewModel,
				)}
				${renderModelPicker(
					"Naming Model",
					"Lightweight model used to auto-generate session titles. Best with a fast, cheap model like Haiku.",
					prefNamingModel,
					setNamingModel,
				)}
			</div>

			<!-- AI Gateway section -->
			<div class="flex flex-col gap-4 ${hasModels ? "pt-4 border-t border-border" : ""}">
				<h3 class="text-sm font-semibold text-foreground">AI Gateway</h3>
				<p class="text-sm text-muted-foreground">
					Connect to an AI Gateway for on-prem LLM access through a single
					OpenAI-compatible endpoint. When configured, only gateway models are shown.
				</p>

				<!-- URL input -->
				<div class="flex flex-col gap-2">
					<label class="text-sm font-medium text-foreground">Gateway URL</label>
					<div class="flex gap-2">
						<input
							type="text"
							class="flex-1 px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm
								focus:outline-none focus:ring-2 focus:ring-ring"
							placeholder="http://gateway-host/v1"
							.value=${aigwUrl}
							?disabled=${busy}
							@input=${(e: Event) => { aigwUrl = (e.target as HTMLInputElement).value; }}
						/>
						<button
							class="px-3 py-2 text-sm rounded-md border border-input bg-background text-foreground
								hover:bg-secondary transition-colors disabled:opacity-50"
							title="Test gateway connection"
							?disabled=${busy || !aigwUrl.trim()}
							@click=${testAigwConnection}
						>${aigwStatus === "testing" ? "Testing..." : "Test"}</button>
					</div>
				</div>

				<!-- Error -->
				${aigwError ? html`
					<div class="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
						${aigwError}
					</div>
				` : ""}

				<!-- Status badge -->
				${aigwConfigured ? html`
					<div class="flex items-center gap-2 px-3 py-2 rounded-md bg-green-500/10 border border-green-500/20">
						<span class="w-2 h-2 rounded-full bg-green-500"></span>
						<span class="text-sm text-foreground">Connected to <code class="text-xs">${aigwConfiguredUrl}</code></span>
					</div>
				` : ""}

				<!-- Action buttons -->
				<div class="flex gap-2">
					<button
						class="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground
							hover:bg-primary/90 transition-colors disabled:opacity-50"
						title="Save gateway configuration"
						?disabled=${busy || !aigwUrl.trim()}
						@click=${saveAigwConfig}
					>${aigwStatus === "saving" ? "Saving..." : aigwConfigured ? "Update" : "Enable Gateway"}</button>
					${aigwConfigured ? html`
						<button
							class="px-4 py-2 text-sm rounded-md border border-destructive text-destructive
								hover:bg-destructive/10 transition-colors disabled:opacity-50"
							title="Disconnect gateway"
							?disabled=${busy}
							@click=${removeAigwConfig}
						>${aigwStatus === "removing" ? "Removing..." : "Disconnect"}</button>
						<button
							class="px-4 py-2 text-sm rounded-md border border-input bg-background text-foreground
								hover:bg-secondary transition-colors disabled:opacity-50"
							title="Refresh available models"
							?disabled=${busy}
							@click=${refreshAigwModels}
						>Refresh Models</button>
					` : ""}
				</div>

				<!-- Available models list -->
				${hasModels ? html`
					<div class="flex flex-col gap-2 mt-1">
						<h4 class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
							Available Models (${aigwModels.length})
						</h4>
						<div class="border border-border rounded-md divide-y divide-border max-h-60 overflow-y-auto">
							${aigwModels.map((m: any) => html`
								<div class="px-3 py-1.5 flex items-center justify-between">
									<div class="flex flex-col gap-0 min-w-0">
										<span class="text-sm text-foreground truncate">${m.name}</span>
										<span class="text-[11px] text-muted-foreground font-mono">${m.id}</span>
									</div>
									<div class="flex items-center gap-2 text-xs text-muted-foreground shrink-0 ml-2">
										${m.reasoning ? html`<span class="px-1.5 py-0.5 rounded bg-secondary">Reasoning</span>` : ""}
										<span>${formatTokens(m.contextWindow)} ctx</span>
									</div>
								</div>
							`)}
						</div>
					</div>
				` : ""}
			</div>
		</div>
	`;
}

// ── Project tab ──

function loadProjectConfig(): void {
	if (projectConfigLoaded) return;
	projectConfigLoaded = true;
	(async () => {
		try {
			const [configRes, defaultsRes] = await Promise.all([
				gatewayFetch("/api/project-config"),
				gatewayFetch("/api/project-config/defaults"),
			]);
			if (configRes.ok && defaultsRes.ok) {
				const merged: Record<string, string> = await configRes.json();
				projectDefaults = await defaultsRes.json();
				// Pre-populate all values including defaults so the user sees what workflows will use
				projectConfig = { ...merged };
				projectNewEntries = [];
			}
		} catch {}
		renderApp();
	})();
}

async function saveProjectConfig(): Promise<void> {
	projectSaveStatus = "saving";
	renderApp();
	try {
		const body: Record<string, string | null> = {};
		// For each key in projectConfig: send null if value matches the default (don't persist redundant entries),
		// otherwise send the value.
		for (const [key, value] of Object.entries(projectConfig)) {
			if (!value) {
				body[key] = null;
			} else if (key in projectDefaults && value === projectDefaults[key]) {
				body[key] = null; // matches default — no need to persist
			} else {
				body[key] = value;
			}
		}
		// Include new entries with non-empty key and value
		for (const entry of projectNewEntries) {
			if (entry.key && entry.value) {
				body[entry.key] = entry.value;
			}
		}
		const res = await gatewayFetch("/api/project-config", {
			method: "PUT",
			body: JSON.stringify(body),
		});
		if (res.ok) {
			// Merge new entries into projectConfig and clear the new-entries list
			for (const entry of projectNewEntries) {
				if (entry.key && entry.value) {
					projectConfig[entry.key] = entry.value;
				}
			}
			projectNewEntries = [];
			projectSaveStatus = "saved";
			setTimeout(() => { projectSaveStatus = ""; renderApp(); }, 2000);
		} else {
			projectSaveStatus = "error";
		}
	} catch {
		projectSaveStatus = "error";
	}
	renderApp();
}

function renderProjectTab() {
	loadProjectConfig();

	// Collect all keys: defaults first, then custom user keys
	const defaultKeys = Object.keys(projectDefaults);
	const customKeys = Object.keys(projectConfig).filter((k) => !(k in projectDefaults));

	return html`
		<div class="flex flex-col gap-3">
			<!-- Default entries -->
			${defaultKeys.map((key) => html`
				<div class="flex items-end gap-2">
					<div class="flex flex-col gap-1 flex-1 min-w-0">
						<label class="text-xs text-muted-foreground">Key</label>
						<input
							type="text"
							class="px-3 py-2 rounded-md border border-input bg-muted/50 text-muted-foreground text-sm
								focus:outline-none cursor-not-allowed"
							.value=${key}
							disabled
						/>
					</div>
					<div class="flex flex-col gap-1 flex-[2] min-w-0">
						<label class="text-xs text-muted-foreground">Value</label>
						<input
							type="text"
							class="px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm
								focus:outline-none focus:ring-2 focus:ring-ring"
							placeholder=${projectDefaults[key] || ""}
							.value=${projectConfig[key] || ""}
							@input=${(e: Event) => {
								const v = (e.target as HTMLInputElement).value;
								projectConfig[key] = v || projectDefaults[key] || "";
								projectSaveStatus = "";
								renderApp();
							}}
						/>
					</div>
					<div class="w-9 shrink-0"></div>
				</div>
			`)}

			<!-- Custom user entries -->
			${customKeys.map((key) => html`
				<div class="flex items-end gap-2">
					<div class="flex flex-col gap-1 flex-1 min-w-0">
						<label class="text-xs text-muted-foreground">Key</label>
						<input
							type="text"
							class="px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm
								focus:outline-none focus:ring-2 focus:ring-ring"
							.value=${key}
							@input=${(e: Event) => {
								const newKey = (e.target as HTMLInputElement).value;
								const val = projectConfig[key];
								delete projectConfig[key];
								if (newKey) projectConfig[newKey] = val;
								projectSaveStatus = "";
								renderApp();
							}}
						/>
					</div>
					<div class="flex flex-col gap-1 flex-[2] min-w-0">
						<label class="text-xs text-muted-foreground">Value</label>
						<input
							type="text"
							class="px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm
								focus:outline-none focus:ring-2 focus:ring-ring"
							.value=${projectConfig[key] || ""}
							@input=${(e: Event) => {
								projectConfig[key] = (e.target as HTMLInputElement).value;
								projectSaveStatus = "";
								renderApp();
							}}
						/>
					</div>
					<button
						class="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
						title="Remove"
						@click=${() => { delete projectConfig[key]; projectSaveStatus = ""; renderApp(); }}
					>${icon(X, "xs")}</button>
				</div>
			`)}

			<!-- New entries being added -->
			${projectNewEntries.map((entry, i) => html`
				<div class="flex items-end gap-2">
					<div class="flex flex-col gap-1 flex-1 min-w-0">
						<label class="text-xs text-muted-foreground">Key</label>
						<input
							type="text"
							class="px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm
								focus:outline-none focus:ring-2 focus:ring-ring"
							placeholder="setting_name"
							.value=${entry.key}
							@input=${(e: Event) => {
								projectNewEntries[i].key = (e.target as HTMLInputElement).value;
								projectSaveStatus = "";
								renderApp();
							}}
						/>
					</div>
					<div class="flex flex-col gap-1 flex-[2] min-w-0">
						<label class="text-xs text-muted-foreground">Value</label>
						<input
							type="text"
							class="px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm
								focus:outline-none focus:ring-2 focus:ring-ring"
							placeholder="value"
							.value=${entry.value}
							@input=${(e: Event) => {
								projectNewEntries[i].value = (e.target as HTMLInputElement).value;
								projectSaveStatus = "";
								renderApp();
							}}
						/>
					</div>
					<button
						class="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
						title="Remove"
						@click=${() => { projectNewEntries.splice(i, 1); projectSaveStatus = ""; renderApp(); }}
					>${icon(X, "xs")}</button>
				</div>
			`)}

			<!-- Add Setting button -->
			<button
				class="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground
					hover:bg-muted rounded-md transition-colors self-start"
				@click=${() => { projectNewEntries.push({ key: "", value: "" }); renderApp(); }}
			>${icon(Plus, "xs")} Add Setting</button>

			<!-- Save button -->
			<div class="flex items-center gap-3 pt-2">
				<button
					class="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground
						hover:bg-primary/90 transition-colors disabled:opacity-50"
					?disabled=${projectSaveStatus === "saving"}
					@click=${saveProjectConfig}
				>${projectSaveStatus === "saving" ? "Saving..." : "Save"}</button>
				${projectSaveStatus === "saved" ? html`<span class="text-xs text-green-600">Saved successfully.</span>` : ""}
				${projectSaveStatus === "error" ? html`<span class="text-xs text-destructive">Failed to save.</span>` : ""}
			</div>
		</div>
	`;
}

function loadGeneralSettings() {
	if (settingsCwdLoaded) return;
	settingsCwd = state.defaultCwd;
	settingsCwdLoaded = true;
}

async function saveDefaultCwd(): Promise<void> {
	settingsCwdSaveStatus = "saving";
	renderApp();
	try {
		const res = await gatewayFetch("/api/config/cwd", {
			method: "PUT",
			body: JSON.stringify({ cwd: settingsCwd }),
		});
		if (res.ok) {
			const data = await res.json();
			state.defaultCwd = data.cwd;
			settingsCwdSaveStatus = "saved";
			setTimeout(() => { settingsCwdSaveStatus = ""; renderApp(); }, 2000);
		} else {
			settingsCwdSaveStatus = "error";
		}
	} catch {
		settingsCwdSaveStatus = "error";
	}
	renderApp();
}

function renderGeneralTab() {
	loadGeneralSettings();
	return html`
		<div class="flex flex-col gap-4">
			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium text-foreground">Default Working Directory</label>
				<p class="text-xs text-muted-foreground">
					The default directory used when creating new sessions and goals without an explicit path.
				</p>
				<div class="flex gap-2">
					<input
						type="text"
						class="flex-1 px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm
							focus:outline-none focus:ring-2 focus:ring-ring"
						.value=${settingsCwd}
						placeholder="e.g. C:\\Users\\you\\projects"
						@input=${(e: Event) => { settingsCwd = (e.target as HTMLInputElement).value; settingsCwdSaveStatus = ""; renderApp(); }}
					/>
					<button
						class="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground
							hover:bg-primary/90 transition-colors disabled:opacity-50"
						?disabled=${settingsCwdSaveStatus === "saving"}
						@click=${saveDefaultCwd}
					>${settingsCwdSaveStatus === "saving" ? "Saving..." : "Save"}</button>
				</div>
				${settingsCwdSaveStatus === "saved" ? html`<p class="text-xs text-green-600">Saved successfully.</p>` : ""}
				${settingsCwdSaveStatus === "error" ? html`<p class="text-xs text-destructive">Failed to save.</p>` : ""}
			</div>
		</div>
	`;
}

export function renderSettingsPage() {
	// Manage keydown listener lifecycle
	updateKeydownListener();

	// Shortcuts first so the default tab doubles as a quick shortcut reference (Ctrl+,)
	const tabs: { id: SettingsTab; label: string }[] = [
		{ id: "shortcuts", label: "Shortcuts" },
		{ id: "general" as SettingsTab, label: "General" },
		{ id: "project", label: "Project" },
		{ id: "models", label: "Models" },
		{ id: "palette", label: "Color Palette" },
	];

	return html`
		<div class="flex-1 flex flex-col min-h-0 overflow-hidden">
			<!-- Header -->
			<div class="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-border">
				<button
					class="p-1.5 rounded-md hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
					@click=${() => { resetRebindState(); cleanupListener(); settingsCwdLoaded = false; toggleSettings(); }}
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
						title="${tab.label}"
						@click=${() => { activeTab = tab.id; renderApp(); }}
					>${tab.label}</button>
				`)}
			</div>
			<!-- Tab content -->
			<div class="flex-1 overflow-y-auto">
			 <div class="max-w-5xl mx-auto p-2 sm:p-4">
				<div class="${activeTab === "palette" || activeTab === "shortcuts" ? "max-w-3xl" : "max-w-xl"}">
					${activeTab === "general" ? renderGeneralTab() : ""}
					${activeTab === "project" ? renderProjectTab() : ""}
					${activeTab === "models" ? renderModelsTab() : ""}
					${activeTab === "shortcuts" ? renderShortcutsTab() : ""}
					${activeTab === "palette" ? renderPaletteTab() : ""}
				</div>
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
